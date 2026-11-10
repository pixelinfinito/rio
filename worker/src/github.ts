import type { Env } from "./types";
import { invariant } from "./validation";

// GitHub App access (docs/github-app.md). The endpoint signs a short App JWT
// with the private key and exchanges it for an installation token scoped to
// one repository and to the permissions of the job at hand. Tokens live in
// memory only: they are never stored, logged or put in a report, and each
// holder revokes its token when its job phase ends.

export const API = "https://api.github.com";
/** Longest wait for one GitHub API call. */
export const REQUEST_TIMEOUT_MS = 30 * 1000;
/** Rio's lease on an installation token; GitHub's own lifetime is one hour. */
export const TOKEN_LEASE_MS = 10 * 60 * 1000;

export type Access = "read" | "write";
export type Permissions = Record<string, Access>;
export const PREPARE_PERMISSIONS: Permissions = {
  contents: "read",
  pull_requests: "read",
};
export const PUBLISH_PERMISSIONS: Permissions = {
  pull_requests: "write",
  checks: "write",
};
// GitHub refuses resolveReviewThread to an installation token without
// contents: write, so only the thread (un)resolve call holds it, on a token of
// its own that is revoked as soon as the mutation returns.
export const RESOLVE_PERMISSIONS: Permissions = {
  pull_requests: "write",
  contents: "write",
};
export const COMMAND_PERMISSIONS: Permissions = {
  pull_requests: "write",
  metadata: "read",
};

export interface AppSecrets {
  appId: string;
  privateKey: string;
  webhookSecrets: string[];
}
/** The app's secrets, or null when PR mode is not configured. */
export function appSecrets(env: Env): AppSecrets | null {
  if (
    !env.GITHUB_APP_ID ||
    !env.GITHUB_APP_PRIVATE_KEY ||
    !env.GITHUB_WEBHOOK_SECRET
  )
    return null;
  return {
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    // During `rio doctor --rotate` the next secret is accepted as well.
    webhookSecrets: [
      env.GITHUB_WEBHOOK_SECRET,
      ...(env.GITHUB_WEBHOOK_SECRET_NEXT
        ? [env.GITHUB_WEBHOOK_SECRET_NEXT]
        : []),
    ],
  };
}
export function apiBase(env: Env): string {
  return (env.GITHUB_API_URL ?? API).replace(/\/$/, "");
}

const encoder = new TextEncoder();
function base64url(bytes: Uint8Array | string): string {
  const data = typeof bytes === "string" ? encoder.encode(bytes) : bytes;
  let text = "";
  for (const b of data) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function der(tag: number, body: Uint8Array): Uint8Array {
  const n = body.length;
  const length =
    n < 0x80
      ? [n]
      : n < 0x100
        ? [0x81, n]
        : n < 0x10000
          ? [0x82, n >> 8, n & 0xff]
          : [0x83, n >> 16, (n >> 8) & 0xff, n & 0xff];
  return new Uint8Array([tag, ...length, ...body]);
}
/** Wraps a PKCS#1 RSAPrivateKey (GitHub's PEM format) in a PKCS#8 envelope. */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  // AlgorithmIdentifier { rsaEncryption, NULL }
  const algorithm = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
    0x01, 0x05, 0x00,
  ]);
  const key = der(0x04, pkcs1);
  return der(0x30, new Uint8Array([...version, ...algorithm, ...key]));
}
function pemBytes(pem: string): { pkcs8: Uint8Array } {
  const match =
    /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END (RSA )?PRIVATE KEY-----/.exec(
      pem.replace(/\\n/g, "\n"),
    );
  invariant(match, "GitHub App private key is not a PEM private key");
  const raw = Uint8Array.from(atob(match[2].replace(/\s+/g, "")), (c) =>
    c.charCodeAt(0),
  );
  return { pkcs8: match[1] ? pkcs1ToPkcs8(raw) : raw };
}
/** A GitHub App JWT (RS256), valid for at most ten minutes. */
export async function appJwt(env: Env, now = Date.now()): Promise<string> {
  const secrets = appSecrets(env);
  invariant(secrets, "GitHub App is not configured");
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemBytes(secrets.privateKey).pkcs8,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const seconds = Math.floor(now / 1000);
  // Issued a minute early for clock drift; GitHub rejects exp beyond ten minutes.
  const body = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(
    JSON.stringify({
      iat: seconds - 60,
      exp: seconds + 540,
      iss: secrets.appId,
    }),
  )}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    encoder.encode(body),
  );
  return `${body}.${base64url(new Uint8Array(signature))}`;
}

/** A GitHub API error; its message never includes a response body. */
export class GitHubError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly detail: string,
  ) {
    super(
      `GitHub ${path} returned HTTP ${status}${detail ? `: ${detail}` : ""}`,
    );
  }
}
const SAFE_DETAIL = /^[\x20-\x7e]{1,200}$/;
async function call(
  env: Env,
  credential: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const response = await fetch(`${apiBase(env)}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${credential}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "rio-review",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    // Bounded, so a publisher never writes long after its lease was checked.
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    // GitHub's own short `message` is kept; bodies are never echoed.
    const message =
      typeof data?.message === "string" && SAFE_DETAIL.test(data.message)
        ? data.message
        : "";
    throw new GitHubError(response.status, path.split("?")[0], message);
  }
  return { status: response.status, data };
}

export type RepositoryName = string; // owner/repo
const NAME = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
export function validRepository(name: unknown): name is RepositoryName {
  return typeof name === "string" && NAME.test(name) && !name.includes("..");
}

/**
 * An installation token for one repository and the given permissions, held
 * in memory. Every request after the ten-minute lease fails; `revoke` ends it
 * early and is called by every holder when its job phase ends.
 */
export class InstallationToken {
  private revoked = false;
  private constructor(
    private readonly env: Env,
    private readonly value: string,
    readonly repository: RepositoryName,
    readonly permissions: Permissions,
    readonly leaseUntil: number,
  ) {}
  static async mint(
    env: Env,
    installation: number,
    repository: RepositoryName,
    permissions: Permissions,
    now = Date.now(),
  ): Promise<InstallationToken> {
    invariant(Number.isSafeInteger(installation), "invalid installation");
    invariant(validRepository(repository), "invalid repository");
    const { data } = await call(
      env,
      await appJwt(env, now),
      "POST",
      `/app/installations/${installation}/access_tokens`,
      { repositories: [repository.split("/")[1]], permissions },
    );
    invariant(
      typeof data?.token === "string" && data.token.length >= 20,
      "GitHub returned no installation token",
    );
    // The token may grant less than requested, never more; GitHub adds
    // metadata: read to every installation token whether requested or not.
    for (const [name, access] of Object.entries(data.permissions ?? {}))
      invariant(
        permissions[name] === access ||
          (permissions[name] === "write" && access === "read") ||
          (name === "metadata" && access === "read"),
        `GitHub granted unrequested permission ${name}`,
      );
    const repositories: any[] = data.repositories ?? [];
    invariant(
      repositories.length <= 1 &&
        repositories.every(
          (r) =>
            String(r?.full_name ?? "").toLowerCase() ===
            repository.toLowerCase(),
        ),
      "GitHub granted a token for another repository",
    );
    const expires = Date.parse(data.expires_at ?? "");
    return new InstallationToken(
      env,
      data.token,
      repository,
      permissions,
      Math.min(now + TOKEN_LEASE_MS, Number.isFinite(expires) ? expires : now),
    );
  }
  /** The token for a job payload that is never stored (the runner claim). */
  secret(): string {
    this.check();
    return this.value;
  }
  private check() {
    invariant(!this.revoked, "installation token revoked");
    invariant(Date.now() < this.leaseUntil, "installation token lease expired");
  }
  async request(method: string, path: string, body?: unknown): Promise<any> {
    this.check();
    return (await call(this.env, this.value, method, path, body)).data;
  }
  /** Every page of a list endpoint (100 per page, at most 30 pages). */
  async list(path: string, key?: string): Promise<any[]> {
    const items: any[] = [];
    for (let page = 1; page <= 30; page++) {
      const separator = path.includes("?") ? "&" : "?";
      const data = await this.request(
        "GET",
        `${path}${separator}per_page=100&page=${page}`,
      );
      const batch: any[] = key ? (data?.[key] ?? []) : (data ?? []);
      invariant(Array.isArray(batch), "GitHub returned an invalid list");
      items.push(...batch);
      if (batch.length < 100) break;
    }
    return items;
  }
  /** A binary download (tarballs); GitHub redirects to a short-lived URL. */
  async download(path: string): Promise<Response> {
    this.check();
    const response = await fetch(`${apiBase(this.env)}${path}`, {
      headers: {
        authorization: `Bearer ${this.value}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "rio-review",
      },
      redirect: "follow",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new GitHubError(response.status, path, "");
    }
    return response;
  }
  async graphql(query: string, variables: Record<string, unknown>) {
    const data = await this.request("POST", "/graphql", { query, variables });
    const error = data?.errors?.[0];
    invariant(
      !data?.errors?.length,
      `GitHub GraphQL request failed: ${String(error?.type ?? "")} ${String(error?.message ?? "")}`
        .trim()
        .slice(0, 200),
    );
    return data?.data;
  }
  async revoke(): Promise<void> {
    if (this.revoked) return;
    this.revoked = true;
    try {
      await call(this.env, this.value, "DELETE", "/installation/token");
    } catch {
      // An expired or already revoked token needs nothing more.
    }
  }
}

/** Runs `use` with a fresh token and always revokes it afterwards. */
export async function withToken<T>(
  env: Env,
  installation: number,
  repository: RepositoryName,
  permissions: Permissions,
  use: (token: InstallationToken) => Promise<T>,
): Promise<T> {
  const token = await InstallationToken.mint(
    env,
    installation,
    repository,
    permissions,
  );
  try {
    return await use(token);
  } finally {
    await token.revoke();
  }
}

/** App-level calls signed with the App JWT (no installation token). */
export async function appRequest(
  env: Env,
  method: string,
  path: string,
  body?: unknown,
): Promise<any> {
  return (await call(env, await appJwt(env), method, path, body)).data;
}

export type ActorClass = "maintainer" | "collaborator" | "other";
/** Classifies from the permission API's role, never from payload text. */
export function classify(permission: any): ActorClass {
  // Custom roles fall back to their base permission.
  const named = String(permission?.role_name ?? "");
  const role = ["admin", "maintain", "write", "triage", "read"].includes(named)
    ? named
    : String(permission?.permission ?? "");
  if (role === "admin" || role === "maintain") return "maintainer";
  if (role === "write" || role === "triage") return "collaborator";
  return "other";
}

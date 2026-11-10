import { env } from "cloudflare:test";
import { vi } from "vitest";

// A recorded GitHub double. Responses follow the shapes of GitHub's REST and
// GraphQL documentation (only the fields Rio reads, plus a few neighbours);
// they are fixtures, not captures of a live account. The double verifies the
// App JWT signature, scopes every installation token to the repository and
// permissions it was minted with, and records each request.

export const API = "https://api.github.test";
export const APP_SLUG = "rio-review-test";
export const BOT = `${APP_SLUG}[bot]`;
const HEX = "0123456789abcdef";
export const sha = (seed: string) =>
  Array.from(
    { length: 40 },
    (_, i) => HEX[(seed.charCodeAt(i % seed.length) + i) % 16],
  ).join("");

export interface Recorded {
  method: string;
  path: string;
  body: any;
  auth: string;
}
interface Token {
  installation: number;
  repository: string;
  permissions: Record<string, string>;
  revoked: boolean;
}
export interface Comment {
  id: number;
  // "owner/repo#number"; comments listed for another PR are not returned.
  pr?: string;
  body: string;
  path?: string;
  line?: number;
  commit_id?: string;
  user: { login: string; type: string };
  html_url: string;
}

function decode(part: string) {
  return JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
}
async function verifyJwt(jwt: string): Promise<boolean> {
  const [h, p, s] = jwt.split(".");
  if (!s) return false;
  const pem = (env as any).TEST_GITHUB_PUBLIC_KEY as string;
  const der = Uint8Array.from(
    atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")),
    (c) => c.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey(
    "spki",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signature = Uint8Array.from(
    atob(s.replace(/-/g, "+").replace(/_/g, "/")),
    (c) => c.charCodeAt(0),
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature,
    new TextEncoder().encode(`${h}.${p}`),
  );
  const claims = decode(p);
  const now = Math.floor(Date.now() / 1000);
  return (
    ok &&
    decode(h).alg === "RS256" &&
    claims.iss === "4242" &&
    claims.exp - claims.iat <= 600 &&
    claims.exp > now
  );
}

const PERMISSION_OF: [RegExp, string, string][] = [
  [
    /^GET \/repos\/[^/]+\/[^/]+\/check-runs\/\d+\/annotations$/,
    "checks",
    "read",
  ],
  [
    /^GET \/repos\/[^/]+\/[^/]+\/pulls\/\d+(\/(files|commits|comments))?$/,
    "pull_requests",
    "read",
  ],
  [/^GET \/repos\/[^/]+\/[^/]+\/compare\//, "contents", "read"],
  [/^GET \/repos\/[^/]+\/[^/]+\/tarball\//, "contents", "read"],
  [
    /^GET \/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/,
    "pull_requests",
    "read",
  ],
  [
    /^POST \/repos\/[^/]+\/[^/]+\/pulls\/\d+\/comments$/,
    "pull_requests",
    "write",
  ],
  [
    /^PATCH \/repos\/[^/]+\/[^/]+\/pulls\/comments\/\d+$/,
    "pull_requests",
    "write",
  ],
  [
    /^POST \/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/,
    "pull_requests",
    "write",
  ],
  [
    /^PATCH \/repos\/[^/]+\/[^/]+\/issues\/comments\/\d+$/,
    "pull_requests",
    "write",
  ],
  [
    /^POST \/repos\/[^/]+\/[^/]+\/issues\/comments\/\d+\/reactions$/,
    "pull_requests",
    "write",
  ],
  [
    /^GET \/repos\/[^/]+\/[^/]+\/commits\/[0-9a-f]+\/check-runs$/,
    "checks",
    "read",
  ],
  [/^(POST|PATCH) \/repos\/[^/]+\/[^/]+\/check-runs/, "checks", "write"],
  [
    /^GET \/repos\/[^/]+\/[^/]+\/collaborators\/[^/]+\/permission$/,
    "metadata",
    "read",
  ],
  [/^POST \/graphql$/, "pull_requests", "write"],
];

export class GitHubDouble {
  requests: Recorded[] = [];
  tokens = new Map<string, Token>();
  pulls = new Map<string, any>();
  files = new Map<string, any[]>();
  commits = new Map<string, any[]>();
  comments: Comment[] = [];
  issueComments: Comment[] = [];
  threads = new Map<number, { id: string; resolved: boolean }>();
  checkRuns: any[] = [];
  reactions: { comment: number; content: string }[] = [];
  roles = new Map<string, string>();
  tarballs = new Map<string, Uint8Array>();
  hookSecret: string | null = null;
  // A path pattern answered with an error status (anchor rejections, outages).
  failures: {
    method: string;
    pattern: RegExp;
    status: number;
    message: string;
    times?: number;
  }[] = [];
  private next = 1000;
  private spy: any;
  fallback?: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;

  pull(
    repository: string,
    number: number,
    options: {
      fork?: boolean;
      draft?: boolean;
      bot?: boolean;
      head?: string;
      base?: string;
      state?: string;
    } = {},
  ) {
    const [owner] = repository.split("/");
    const head = options.head ?? sha(`head-${number}`);
    const base = options.base ?? sha(`base-${number}`);
    const value = {
      number,
      state: options.state ?? "open",
      draft: options.draft ?? false,
      user: options.bot
        ? { login: "dependabot[bot]", type: "Bot" }
        : { login: "octocat", type: "User" },
      head: {
        sha: head,
        ref: "feature",
        repo: {
          full_name: options.fork
            ? `contributor/${repository.split("/")[1]}`
            : repository,
        },
      },
      base: {
        sha: base,
        ref: "main",
        repo: {
          full_name: repository,
          clone_url: `https://github.com/${repository}.git`,
          owner: { login: owner },
        },
      },
      html_url: `https://github.com/${repository}/pull/${number}`,
    };
    this.pulls.set(`${repository}#${number}`, value);
    return value;
  }

  install(
    fallback?: (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Promise<Response>,
  ) {
    this.fallback = fallback;
    const original = globalThis.fetch;
    this.spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.startsWith(API)) return this.handle(url, init);
        if (this.fallback) return this.fallback(input, init);
        return original(input as any, init);
      });
    return this;
  }
  restore() {
    this.spy?.mockRestore();
  }
  get calls() {
    return this.requests.map((r) => `${r.method} ${r.path}`);
  }

  private json(data: any, status = 200) {
    return new Response(data === null ? null : JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json" },
    });
  }
  private error(status: number, message: string) {
    return this.json(
      { message, documentation_url: "https://docs.github.com/rest" },
      status,
    );
  }

  async handle(url: string, init?: RequestInit): Promise<Response> {
    const parsed = new URL(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = parsed.pathname;
    const headers = new Headers(init?.headers);
    const auth = headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    let body: any = undefined;
    if (typeof init?.body === "string") body = JSON.parse(init.body);
    this.requests.push({
      method,
      path: `${path}${parsed.search}`
        .replace(/[?&](per_page|page)=\d+/g, "")
        .replace(/\?$/, ""),
      body,
      auth,
    });
    for (const f of this.failures)
      if (
        f.method === method &&
        f.pattern.test(path) &&
        (f.times === undefined || f.times-- > 0)
      )
        return this.error(f.status, f.message);
    // App-level endpoints take the App JWT.
    if (path === "/app" || path.startsWith("/app/")) {
      if (!(await verifyJwt(auth)))
        return this.error(401, "A JSON web token could not be decoded");
      if (method === "GET" && path === "/app")
        return this.json({
          id: 4242,
          slug: APP_SLUG,
          name: "Rio review (test)",
        });
      if (method === "PATCH" && path === "/app/hook/config") {
        this.hookSecret = body.secret;
        return this.json({
          content_type: "json",
          url: "https://rio.example.test/v1/hooks/github",
          insecure_ssl: "0",
        });
      }
      const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
      if (method === "POST" && mint) {
        const installation = Number(mint[1]);
        const token = `ghs_${crypto.randomUUID().replace(/-/g, "")}${this.next++}`;
        const [repository] = body.repositories;
        const owner =
          [...this.pulls.keys()]
            .find((k) => k.split("#")[0].split("/")[1] === repository)
            ?.split("#")[0] ?? `acme/${repository}`;
        this.tokens.set(token, {
          installation,
          repository: owner,
          permissions: body.permissions,
          revoked: false,
        });
        return this.json(
          {
            token,
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
            // Like GitHub, every token also carries metadata: read.
            permissions: { ...body.permissions, metadata: "read" },
            repository_selection: "selected",
            repositories: [{ full_name: owner, name: repository }],
          },
          201,
        );
      }
      return this.error(404, "Not Found");
    }
    const token = this.tokens.get(auth);
    if (!token || token.revoked) return this.error(401, "Bad credentials");
    if (method === "DELETE" && path === "/installation/token") {
      token.revoked = true;
      return new Response(null, { status: 204 });
    }
    const route = `${method} ${path}`;
    const needed = PERMISSION_OF.find(([pattern]) => pattern.test(route));
    if (!needed) return this.error(404, `Not Found: ${route}`);
    const [, permission, access] = needed;
    const granted = token.permissions[permission];
    if (!granted || (access === "write" && granted !== "write"))
      return this.error(403, "Resource not accessible by integration");
    const repo = /^\/repos\/([^/]+\/[^/]+)/.exec(path)?.[1];
    if (repo && repo.toLowerCase() !== token.repository.toLowerCase())
      return this.error(404, "Not Found");
    return this.route(method, path, parsed, body, token);
  }

  private route(
    method: string,
    path: string,
    url: URL,
    body: any,
    token: Token,
  ): Response {
    const m = (re: RegExp) => re.exec(path);
    let r: RegExpExecArray | null;
    if (method === "POST" && path === "/graphql")
      return this.graphql(body, token);
    if (
      (r = m(/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/)) &&
      method === "GET"
    ) {
      const pr = this.pulls.get(`${r[1]}#${r[2]}`);
      return pr ? this.json(pr) : this.error(404, "Not Found");
    }
    if (
      (r = m(
        /^\/repos\/([^/]+\/[^/]+)\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/,
      ))
    )
      return this.json({ status: "ahead", merge_base_commit: { sha: r[2] } });
    if ((r = m(/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/commits$/)))
      return this.json(
        this.page(this.commits.get(`${r[1]}#${r[2]}`) ?? [], url),
      );
    if ((r = m(/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/files$/)))
      return this.json(this.page(this.files.get(`${r[1]}#${r[2]}`) ?? [], url));
    if ((r = m(/^\/repos\/([^/]+\/[^/]+)\/tarball\/([0-9a-f]{40})$/))) {
      const bytes = this.tarballs.get(r[2]);
      return bytes
        ? new Response(bytes, {
            headers: { "content-type": "application/x-gzip" },
          })
        : this.error(404, "Not Found");
    }
    if ((r = m(/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/comments$/))) {
      if (method === "GET")
        return this.json(
          this.page(
            this.comments.filter((c) => !c.pr || c.pr === `${r![1]}#${r![2]}`),
            url,
          ),
        );
      const head = this.pulls.get(`${r[1]}#${r[2]}`)?.head?.sha;
      const lines = (this.files.get(`${r[1]}#${r[2]}`) ?? []).find(
        (f) => f.filename === body.path,
      );
      if (
        body.commit_id !== head ||
        !lines ||
        !(lines.__lines as Set<number>).has(body.line) ||
        body.side !== "RIGHT"
      )
        return this.error(
          422,
          "Validation Failed: pull_request_review_thread.line must be part of the diff",
        );
      const comment: Comment = {
        id: this.next++,
        pr: `${r[1]}#${r[2]}`,
        body: body.body,
        path: body.path,
        line: body.line,
        commit_id: body.commit_id,
        user: { login: BOT, type: "Bot" },
        html_url: `https://github.com/${r[1]}/pull/${r[2]}#discussion_r${this.next}`,
      };
      this.comments.push(comment);
      this.threads.set(comment.id, {
        id: `PRRT_${comment.id}`,
        resolved: false,
      });
      return this.json(comment, 201);
    }
    if (
      (r = m(/^\/repos\/([^/]+\/[^/]+)\/pulls\/comments\/(\d+)$/)) &&
      method === "PATCH"
    ) {
      const comment = this.comments.find((c) => c.id === Number(r![2]));
      if (!comment) return this.error(404, "Not Found");
      if (comment.user.login !== BOT)
        return this.error(403, "Must have admin rights to Repository.");
      comment.body = body.body;
      return this.json(comment);
    }
    if ((r = m(/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/))) {
      if (method === "GET")
        return this.json(this.page(this.issueComments, url));
      const comment: Comment = {
        id: this.next++,
        body: body.body,
        user: { login: BOT, type: "Bot" },
        html_url: `https://github.com/${r[1]}/pull/${r[2]}#issuecomment-${this.next}`,
      };
      this.issueComments.push(comment);
      return this.json(comment, 201);
    }
    if (
      (r = m(/^\/repos\/([^/]+\/[^/]+)\/issues\/comments\/(\d+)$/)) &&
      method === "PATCH"
    ) {
      const comment = this.issueComments.find((c) => c.id === Number(r![2]));
      if (!comment) return this.error(404, "Not Found");
      if (comment.user.login !== BOT)
        return this.error(403, "Must have admin rights to Repository.");
      comment.body = body.body;
      return this.json(comment);
    }
    if (
      (r = m(/^\/repos\/([^/]+\/[^/]+)\/issues\/comments\/(\d+)\/reactions$/))
    ) {
      this.reactions.push({ comment: Number(r[2]), content: body.content });
      return this.json({ id: this.next++, content: body.content }, 201);
    }
    if (
      (r = m(/^\/repos\/([^/]+\/[^/]+)\/commits\/([0-9a-f]+)\/check-runs$/))
    ) {
      const name = url.searchParams.get("check_name");
      const runs = this.checkRuns.filter(
        (c) => c.head_sha === r![2] && (!name || c.name === name),
      );
      return this.json({ total_count: runs.length, check_runs: runs });
    }
    if (
      (r = m(/^\/repos\/([^/]+\/[^/]+)\/check-runs\/(\d+)\/annotations$/)) &&
      method === "GET"
    ) {
      const run = this.checkRuns.find((c) => c.id === Number(r![2]));
      return run
        ? this.json(run.output.annotations ?? [])
        : this.error(404, "Not Found");
    }
    if ((r = m(/^\/repos\/([^/]+\/[^/]+)\/check-runs$/)) && method === "POST") {
      const run = {
        id: this.next++,
        ...body,
        app: { slug: APP_SLUG },
        html_url: `https://github.com/${r[1]}/runs/${this.next}`,
      };
      this.checkRuns.push(run);
      return this.json(run, 201);
    }
    if (
      (r = m(/^\/repos\/([^/]+\/[^/]+)\/check-runs\/(\d+)$/)) &&
      method === "PATCH"
    ) {
      const run = this.checkRuns.find((c) => c.id === Number(r![2]));
      if (!run) return this.error(404, "Not Found");
      if (body.output)
        body.output.annotations = [
          ...(run.output.annotations ?? []),
          ...(body.output.annotations ?? []),
        ];
      Object.assign(run, body);
      return this.json(run);
    }
    if (
      (r = m(/^\/repos\/([^/]+\/[^/]+)\/collaborators\/([^/]+)\/permission$/))
    ) {
      const role = this.roles.get(decodeURIComponent(r[2])) ?? "read";
      const permission =
        role === "maintain" ? "write" : role === "triage" ? "read" : role;
      return this.json({
        permission,
        role_name: role,
        user: { login: decodeURIComponent(r[2]) },
      });
    }
    void token;
    return this.error(404, "Not Found");
  }

  private page(items: any[], url: URL) {
    const size = Number(url.searchParams.get("per_page") ?? 30),
      page = Number(url.searchParams.get("page") ?? 1);
    return items.slice((page - 1) * size, page * size);
  }

  private graphql(body: any, token: Token): Response {
    const query: string = body.query;
    // Like GitHub, (un)resolving a thread needs contents: write as well.
    if (
      query.includes("resolveReviewThread") &&
      token.permissions.contents !== "write"
    )
      return this.json({
        data: { resolveReviewThread: null },
        errors: [
          {
            type: "FORBIDDEN",
            message: "Resource not accessible by integration",
          },
        ],
      });
    if (query.includes("reviewThreads"))
      return this.json({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [...this.threads]
                  .filter(([comment]) => {
                    const pr = this.comments.find((c) => c.id === comment)?.pr;
                    return (
                      !pr ||
                      pr ===
                        `${body.variables.owner}/${body.variables.name}#${body.variables.number}`
                    );
                  })
                  .map(([comment, t]) => ({
                    id: t.id,
                    isResolved: t.resolved,
                    comments: { nodes: [{ databaseId: comment }] },
                  })),
              },
            },
          },
        },
      });
    const resolve =
      query.includes("resolveReviewThread") && !query.includes("unresolve");
    for (const t of this.threads.values())
      if (t.id === body.variables.id) {
        t.resolved = resolve;
        return this.json({
          data: { thread: { id: t.id, isResolved: resolve } },
        });
      }
    return this.json({
      data: null,
      errors: [{ message: "Could not resolve to a node" }],
    });
  }

  /** Registers a PR's changed files; `lines` are the right-side lines in the diff. */
  setFiles(
    repository: string,
    number: number,
    files: { filename: string; status?: string; lines: number[] }[],
  ) {
    this.files.set(
      `${repository}#${number}`,
      files.map((f) => {
        const lines = [...f.lines].sort((a, b) => a - b);
        return Object.assign(
          {
            filename: f.filename,
            status: f.status ?? "modified",
            patch: contiguous(lines),
          },
          { __lines: new Set(lines) },
        );
      }),
    );
  }
}

/** A unified diff patch whose added lines are exactly `lines` (one hunk per run). */
function contiguous(lines: number[]): string {
  const runs: number[][] = [];
  for (const l of lines) {
    const last = runs.at(-1);
    if (last && l === last.at(-1)! + 1) last.push(l);
    else runs.push([l]);
  }
  return runs
    .map(
      (run) =>
        `@@ -${run[0]},0 +${run[0]},${run.length} @@\n${run.map((l) => `+line ${l}`).join("\n")}`,
    )
    .join("\n");
}

/** Signs a webhook delivery like GitHub does. */
export async function signed(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  return `sha256=${Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

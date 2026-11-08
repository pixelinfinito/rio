import type { Env, QueueMessage } from "./types";
import { equal } from "./auth";
import { appSecrets, validRepository } from "./github";

// `POST /v1/hooks/github` (git-host-integration). The handler verifies,
// records and enqueues; it never calls GitHub, a model or a runner, so it
// answers within GitHub's delivery timeout. Payload text is data: only the
// structured fields below are read, and comment bodies are passed on verbatim
// to the command parser, which recognizes two commands and nothing else.

/** Reviews started by the app belong to the endpoint owner. */
export const APP_TENANT = "owner";
const REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;
const PR_ACTIONS = ["opened", "synchronize", "reopened", "ready_for_review"];

async function hmac(secret: string, body: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, body);
  return Array.from(new Uint8Array(signature), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
}
/** `X-Hub-Signature-256` over the raw body, for any configured secret. */
export async function verifySignature(
  secrets: string[],
  body: Uint8Array,
  header: string | null,
): Promise<boolean> {
  if (!header || !/^sha256=[0-9a-f]{64}$/.test(header)) return false;
  let ok = false;
  for (const secret of secrets)
    ok = equal(header, `sha256=${await hmac(secret, body)}`) || ok;
  return ok;
}

export interface InstallationRow {
  id: number;
  tenant: string;
  account: string;
  repositories_json: string;
  suspended: number;
}
/** Whether an installation covers `owner/repo` ("*" is every repository of its account). */
export function covers(row: InstallationRow, repository: string): boolean {
  if (row.suspended) return false;
  const [owner] = repository.split("/");
  const names: string[] = JSON.parse(row.repositories_json);
  return names.some(
    (name) =>
      name.toLowerCase() === repository.toLowerCase() ||
      (name === "*" && row.account.toLowerCase() === owner.toLowerCase()),
  );
}
export async function installation(
  env: Env,
  id: number,
): Promise<InstallationRow | null> {
  return env.DB.prepare("SELECT * FROM installations WHERE id=?")
    .bind(id)
    .first<InstallationRow>();
}
/** The installation that covers a repository, if any. */
export async function installationFor(
  env: Env,
  tenant: string,
  repository: string,
): Promise<InstallationRow | null> {
  const rows = await env.DB.prepare(
    "SELECT * FROM installations WHERE tenant=? AND suspended=0 ORDER BY id",
  )
    .bind(tenant)
    .all<InstallationRow>();
  return rows.results.find((row) => covers(row, repository)) ?? null;
}

function repositories(payload: any): string[] {
  if (payload?.installation?.repository_selection === "all") return ["*"];
  return (payload?.repositories ?? [])
    .map((r: any) => r?.full_name)
    .filter(validRepository);
}

type Outcome =
  | { status: 204 }
  | { status: 403 | 400; error: string }
  | {
      status: 202;
      installation?: number;
      message?: QueueMessage;
      apply?: (env: Env) => Promise<void>;
    };

/** Classifies a verified delivery; nothing is written here. */
function classify(event: string, payload: any): Outcome {
  const id = payload?.installation?.id;
  if (!Number.isSafeInteger(id)) return { status: 204 };
  if (event === "installation") {
    const action = payload.action;
    const account = payload.installation?.account?.login;
    if (action === "created" || action === "unsuspend") {
      if (typeof account !== "string" || !account) return { status: 204 };
      const repos = repositories(payload);
      return {
        status: 202,
        apply: async (env) => {
          await env.DB.prepare(
            "INSERT INTO installations(id,tenant,account,repositories_json,suspended,created_at,updated_at) VALUES(?,?,?,?,0,?,?) ON CONFLICT(id) DO UPDATE SET account=excluded.account,repositories_json=CASE WHEN ?=1 THEN excluded.repositories_json ELSE installations.repositories_json END,suspended=0,updated_at=excluded.updated_at",
          )
            .bind(
              id,
              APP_TENANT,
              account,
              JSON.stringify(repos),
              Date.now(),
              Date.now(),
              action === "created" ? 1 : 0,
            )
            .run();
        },
      };
    }
    if (action === "deleted")
      return {
        status: 202,
        apply: async (env) => {
          await env.DB.prepare("DELETE FROM installations WHERE id=?")
            .bind(id)
            .run();
        },
      };
    if (action === "suspend")
      return {
        status: 202,
        installation: id,
        apply: async (env) => {
          await env.DB.prepare(
            "UPDATE installations SET suspended=1,updated_at=? WHERE id=?",
          )
            .bind(Date.now(), id)
            .run();
        },
      };
    return { status: 204 };
  }
  if (event === "installation_repositories") {
    if (!["added", "removed"].includes(payload.action)) return { status: 204 };
    const added = (payload.repositories_added ?? [])
      .map((r: any) => r?.full_name)
      .filter(validRepository);
    const removed = new Set(
      (payload.repositories_removed ?? [])
        .map((r: any) => String(r?.full_name ?? "").toLowerCase())
        .filter(Boolean),
    );
    const all = payload.installation?.repository_selection === "all";
    return {
      status: 202,
      installation: id,
      apply: async (env) => {
        const row = await installation(env, id);
        if (!row) return;
        const current: string[] = JSON.parse(row.repositories_json);
        const next = all
          ? ["*"]
          : [
              ...new Set([
                ...current.filter(
                  (n) => n !== "*" && !removed.has(n.toLowerCase()),
                ),
                ...added,
              ]),
            ].sort();
        await env.DB.prepare(
          "UPDATE installations SET repositories_json=?,updated_at=? WHERE id=?",
        )
          .bind(JSON.stringify(next), Date.now(), id)
          .run();
      },
    };
  }
  const repository = payload?.repository?.full_name;
  if (!validRepository(repository)) return { status: 204 };
  if (event === "pull_request") {
    const pr = payload.pull_request;
    if (
      !PR_ACTIONS.includes(payload.action) ||
      !Number.isSafeInteger(pr?.number) ||
      pr.number < 1 ||
      pr.draft === true ||
      pr.state !== "open"
    )
      return { status: 204 };
    return {
      status: 202,
      installation: id,
      message: {
        type: "review-request",
        tenant: APP_TENANT,
        installation_id: id,
        repository,
        number: pr.number,
        trigger: "webhook",
      },
    };
  }
  if (event === "issue_comment") {
    const comment = payload.comment,
      issue = payload.issue,
      body = comment?.body;
    if (
      payload.action !== "created" ||
      !issue?.pull_request ||
      !Number.isSafeInteger(issue?.number) ||
      !Number.isSafeInteger(comment?.id) ||
      typeof body !== "string" ||
      !body.trimStart().startsWith("/rio") ||
      typeof comment?.user?.login !== "string" ||
      // The app's own comments and other bots never run commands.
      comment.user.type !== "User" ||
      comment.user.login.endsWith("[bot]")
    )
      return { status: 204 };
    return {
      status: 202,
      installation: id,
      message: {
        type: "command",
        tenant: APP_TENANT,
        installation_id: id,
        repository,
        number: issue.number,
        comment_id: comment.id,
        body: body.slice(0, 2000),
        actor: comment.user.login,
      },
    };
  }
  return { status: 204 };
}

export async function handleGitHubWebhook(
  env: Env,
  headers: Headers,
  body: Uint8Array,
): Promise<Response> {
  const secrets = appSecrets(env);
  if (!secrets)
    return Response.json(
      { error: "no GitHub App is configured on this endpoint" },
      { status: 404 },
    );
  if (
    !(await verifySignature(
      secrets.webhookSecrets,
      body,
      headers.get("x-hub-signature-256"),
    ))
  )
    return Response.json({ error: "invalid signature" }, { status: 401 });
  const event = headers.get("x-github-event") ?? "";
  const delivery = headers.get("x-github-delivery") ?? "";
  if (!/^[A-Za-z0-9-]{1,64}$/.test(delivery) || !/^[a-z_]{1,64}$/.test(event))
    return Response.json(
      { error: "invalid delivery headers" },
      { status: 400 },
    );
  let payload: any;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return Response.json({ error: "invalid payload" }, { status: 400 });
  }
  const outcome = classify(event, payload);
  if (outcome.status === 204) return new Response(null, { status: 204 });
  if (outcome.status !== 202)
    return Response.json({ error: outcome.error }, { status: outcome.status });
  if (outcome.installation !== undefined) {
    const row = await installation(env, outcome.installation);
    if (!row)
      return Response.json({ error: "unknown installation" }, { status: 403 });
    // A suspended installation, or a repository it no longer covers, is ignored.
    if (outcome.message && !covers(row, (outcome.message as any).repository))
      return new Response(null, { status: 204 });
  }
  // A delivery id is acted on once in 24 hours; a repeat is acknowledged.
  const now = Date.now();
  const [, inserted] = await env.DB.batch([
    env.DB.prepare("DELETE FROM deliveries WHERE received_at<?").bind(
      now - REPLAY_WINDOW_MS,
    ),
    env.DB.prepare(
      "INSERT INTO deliveries(id,event,installation_id,received_at) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING RETURNING id",
    ).bind(delivery, event, payload.installation.id, now),
  ]);
  if (!inserted.results.length)
    return Response.json({ duplicate: true }, { status: 202 });
  try {
    await outcome.apply?.(env);
    if (outcome.message) await env.JOBS.send(outcome.message);
  } catch (error) {
    // Forget the id so GitHub's redelivery of this event is acted on.
    await env.DB.prepare("DELETE FROM deliveries WHERE id=?")
      .bind(delivery)
      .run();
    throw error;
  }
  return Response.json({ accepted: true }, { status: 202 });
}

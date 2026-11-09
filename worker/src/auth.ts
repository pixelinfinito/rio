import type { Env } from "./types";
import { hash, invariant } from "./validation";
const encoder = new TextEncoder();
export async function sign(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(value),
  );
  return Array.from(new Uint8Array(signature), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
}
export function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let n = 0;
  for (let i = 0; i < a.length; i++) n |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return n === 0;
}
export async function authenticate(
  request: Request,
  env: Env,
  scope: string | string[],
): Promise<string> {
  const scopes = Array.isArray(scope) ? scope : [scope];
  const token =
    request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  invariant(token.length >= 24, "unauthorized");
  if (env.RIO_API_TOKEN && equal(hash(token), hash(env.RIO_API_TOKEN)))
    return "owner";
  const row = await env.DB.prepare(
    "SELECT tenant,scope FROM api_tokens WHERE hash=? AND expires_at>?",
  )
    .bind(hash(token), Date.now())
    .first<{ tenant: string; scope: string }>();
  invariant(
    row &&
      (row.scope === "*" ||
        row.scope.split(",").some((s) => scopes.includes(s))),
    "unauthorized",
  );
  return row.tenant;
}
export async function jobToken(
  env: Env,
  review: string,
  job: string,
  attempt: number,
  expires: number,
): Promise<string> {
  invariant(
    env.RUNNER_SECRET?.length >= 32,
    "runner signing secret is not configured",
  );
  const claims = `${review}:${job}:${attempt}:${expires}`;
  return `${expires}.${await sign(env.RUNNER_SECRET, claims)}`;
}
export async function verifyJobToken(
  request: Request,
  env: Env,
  review: string,
  job: string,
  attempt: number,
) {
  const token =
    request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (token.startsWith("qa-job.")) {
    invariant(
      /^qa-job\.[a-f0-9]{64}$/.test(token),
      "unauthorized runner capability",
    );
    const run = await env.DB.prepare(
      "SELECT 1 FROM qa_runs WHERE review_id=? AND job_id=? AND attempt=? AND control_hash=? AND control_expires_at>?",
    )
      .bind(review, job, attempt, hash(token), Date.now())
      .first();
    invariant(run, "unauthorized runner capability");
    return token;
  }
  const expires = Number(token.split(".")[0]);
  invariant(
    Number.isSafeInteger(expires) && expires > Date.now(),
    "expired runner capability",
  );
  invariant(
    equal(token, await jobToken(env, review, job, attempt, expires)),
    "unauthorized runner capability",
  );
  invariant(
    !(await env.DB.prepare("SELECT 1 FROM qa_runs WHERE job_id=? AND attempt=?")
      .bind(job, attempt)
      .first()),
    "unauthorized QA runner capability",
  );
  return token;
}

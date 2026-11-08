import type {
  Env,
  Execution,
  ExecutionResult,
  PrepareSpec,
  Version,
  Profile,
} from "./types";
import { Store } from "./storage";
import { canonical, hash, invariant } from "./validation";
import { needs } from "./archive";
import { redact } from "./redaction";
export async function createJob(
  env: Env,
  review: string,
  job: string,
  kind: Execution["kind"],
  command: string[],
  version: Version,
  snapshotId: string,
  attempt = 1,
  context?: { profile: Profile },
): Promise<void> {
  const store = new Store(env);
  invariant(!(await store.cancelled(review)), "cancelled");
  const execution: Execution = {
    protocol: 1,
    review_id: review,
    job_id: job,
    attempt,
    kind,
    command,
    version,
    snapshot_id: snapshotId,
    needs: needs(kind, version),
    limits: {
      wall_ms: Math.min(120000, await store.remainingMs(review)),
      memory_mb: env.RUNNER_BACKEND === "sandbox" ? 8192 : 2048,
      cpu: 2,
      output_bytes: 1024 * 1024,
      ...(kind === "run" ? {} : { artifact_bytes: ARTIFACT_LIMIT }),
    },
    network: false,
    context,
  };
  const key = `reviews/${review}/jobs/${job}/${attempt}/payload.json`;
  await store.put(key, execution);
  await env.DB.prepare(
    "INSERT INTO jobs(id,review_id,attempt,status,payload_key,created_at) VALUES(?,?,?,'pending',?,?) ON CONFLICT(id) DO NOTHING",
  )
    .bind(job, review, attempt, key, Date.now())
    .run();
  await env.JOBS.send({ review_id: review, job_id: job, attempt });
}
/** Wall limit of a prepare job: clone (self-hosted only), snapshot and graph. */
export const PREPARE_WALL_MS = 600000;
/**
 * The hosted preparation of a PR review. The self-hosted runner clones from
 * `prepare` (its installation token is minted at claim time and never
 * stored); the Sandbox prepares from a snapshot the Worker already fetched.
 */
export async function createPrepareJob(
  env: Env,
  review: string,
  source: { prepare: PrepareSpec; snapshot_id?: string },
): Promise<string> {
  const job = hash(`${review}-prepare`).slice(0, 32);
  const sandbox = source.snapshot_id !== undefined;
  const execution: Execution = {
    protocol: 1,
    review_id: review,
    job_id: job,
    attempt: 1,
    kind: "prepare",
    command: ["rio-internal", "prepare"],
    version: "head",
    snapshot_id: source.snapshot_id ?? "",
    needs: sandbox ? ["base", "head"] : [],
    limits: {
      wall_ms: PREPARE_WALL_MS,
      memory_mb: env.RUNNER_BACKEND === "sandbox" ? 8192 : 2048,
      cpu: 2,
      output_bytes: 1024 * 1024,
      artifact_bytes: ARTIFACT_LIMIT,
    },
    network: sandbox ? false : "clone",
    // The PR's commits; never a secret.
    prepare: source.prepare,
  };
  const key = `reviews/${review}/jobs/${job}/1/payload.json`;
  await new Store(env).put(key, execution);
  await env.DB.prepare(
    "INSERT INTO jobs(id,review_id,attempt,status,payload_key,created_at) VALUES(?,?,1,'pending',?,?) ON CONFLICT(id) DO NOTHING",
  )
    .bind(job, review, key, Date.now())
    .run();
  try {
    await env.JOBS.send({ review_id: review, job_id: job, attempt: 1 });
  } catch (error) {
    // An undispatched job is no job: the request's retry schedules it again.
    await env.DB.prepare(
      "DELETE FROM jobs WHERE id=? AND review_id=? AND status='pending'",
    )
      .bind(job, review)
      .run();
    throw error;
  }
  return job;
}
// The trusted runner's analysis artifact is bounded apart from command output.
export const ARTIFACT_LIMIT = 12 * 1024 * 1024;
export function validateResult(
  value: any,
  payload: Execution,
): asserts value is ExecutionResult {
  invariant(
    value &&
      value.job_id === payload.job_id &&
      value.attempt === payload.attempt &&
      value.version === payload.version &&
      Number.isInteger(value.exit_code) &&
      typeof value.stdout === "string" &&
      typeof value.stderr === "string" &&
      typeof value.timed_out === "boolean" &&
      typeof value.truncated === "boolean",
    "invalid runner result",
  );
  invariant(
    new TextEncoder().encode(value.stdout + value.stderr).length <=
      payload.limits.output_bytes + 4096,
    "runner output limit exceeded",
  );
  if (value.artifact !== undefined)
    invariant(
      payload.kind !== "run" &&
        new TextEncoder().encode(JSON.stringify(value.artifact)).length <=
          (payload.limits.artifact_bytes ?? 0) + 4096,
      "runner artifact limit exceeded",
    );
}
/**
 * Records a job the runner backend could not execute at all (for example the
 * sandbox container failed to start), so the review fails with the reason
 * instead of waiting for the workflow step timeout.
 */
export async function failJob(
  env: Env,
  review: string,
  job: string,
  attempt: number,
  reason: string,
) {
  const store = new Store(env),
    row = await env.DB.prepare(
      "SELECT payload_key FROM jobs WHERE id=? AND review_id=? AND attempt=?",
    )
      .bind(job, review, attempt)
      .first<{ payload_key: string }>();
  invariant(row, "unknown job attempt");
  const payload = await store.get<Execution>(row.payload_key);
  await finishJob(env, review, job, attempt, {
    outcome: "runner_failed",
    job_id: job,
    attempt,
    version: payload.version,
    exit_code: 1,
    stdout: "",
    stderr: `runner backend: ${reason}`.slice(0, 1000),
    timed_out: false,
    truncated: false,
  });
}
export async function finishJob(
  env: Env,
  review: string,
  job: string,
  attempt: number,
  result: ExecutionResult,
) {
  const store = new Store(env),
    row = await env.DB.prepare(
      "SELECT * FROM jobs WHERE id=? AND review_id=? AND attempt=?",
    )
      .bind(job, review, attempt)
      .first<any>();
  invariant(row, "unknown job attempt");
  const payload = await store.get<Execution>(row.payload_key);
  validateResult(result, payload);
  result.command = payload.command;
  result.kind = payload.kind;
  // Concurrent completions never overwrite the artifact selected by the D1 compare-and-set.
  const key = `reviews/${review}/jobs/${job}/${attempt}/${hash(canonical(result))}.json`;
  if (row.status !== "completed") {
    await store.put(key, result);
    await env.DB.prepare(
      "UPDATE jobs SET status='completed',result_key=? WHERE id=? AND attempt=? AND status IN ('pending','leased')",
    )
      .bind(key, job, attempt)
      .run();
  }
  const published = await env.DB.prepare(
    "SELECT result_key FROM jobs WHERE id=? AND review_id=? AND attempt=?",
  )
    .bind(job, review, attempt)
    .first<{ result_key: string }>();
  invariant(published?.result_key === key, "conflicting runner completion");
  // A prepare job hands its review over (Sandbox) or reports why it could not.
  if (payload.kind === "prepare")
    return finishPrepare(env, review, result, payload.snapshot_id);
  // Keep completed artifacts for audit after cancellation, without resuming model work.
  if (await store.cancelled(review)) return;
  // Re-sending after a transport failure is safe; event type includes the immutable attempt.
  const instance = await env.REVIEWS.get(review);
  await instance.sendEvent({ type: `job-${job}-${attempt}`, payload: { key } });
}

async function finishPrepare(
  env: Env,
  review: string,
  result: ExecutionResult,
  snapshot: string,
) {
  const { pullOf, submitPrepared, failPrepare } = await import("./pulls");
  const row = await pullOf(env, review);
  if (!row || row.state !== "preparing") return;
  if (
    result.exit_code === 0 &&
    !result.timed_out &&
    result.artifact?.submission
  )
    // The container prepared from the job's snapshot; its id comes from the
    // trusted job, never from the artifact.
    await submitPrepared(env, row, {
      ...result.artifact.submission,
      snapshot_id: snapshot,
    });
  // The self-hosted runner submits through its prepare credential before it completes.
  else if (result.exit_code === 0 && !result.timed_out && result.stdout.trim())
    return;
  else {
    const line =
      redact(result.stderr)
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l) ?? (result.timed_out ? "timed out" : "no submission");
    await failPrepare(env, review, `preparation failed: ${line.slice(0, 200)}`);
  }
}

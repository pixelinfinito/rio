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
import { finishQaRun } from "./qa-jobs";
/** Command wall of an agent's run command and a council member's call. */
export const RUN_WALL_MS = 120000;
/**
 * Command wall of an analysis job (checks, graph, static). With the transfer
 * allowance it stays inside one queue consumer invocation (15 minutes).
 */
export const ANALYSIS_WALL_MS = 480000;
/** The largest command wall a runner accepts for a job kind. */
export function wallLimit(kind: Execution["kind"]): number {
  if (kind === "prepare") return PREPARE_WALL_MS;
  return ["checks", "graph", "static"].includes(kind)
    ? ANALYSIS_WALL_MS
    : RUN_WALL_MS;
}
/**
 * Dispatches a runner job; returns its command wall. Analysis jobs get at most
 * 40% of the review's remaining time, so the agents keep the rest.
 */
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
  /** A caller's own wall bound, below the review's remaining time. */
  wallCapMs?: number,
): Promise<number> {
  const store = new Store(env);
  invariant(!(await store.cancelled(review)), "cancelled");
  const remaining = await store.remainingMs(review);
  const sandbox = env.RUNNER_BACKEND === "sandbox";
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
      wall_ms: Math.max(
        1000,
        Math.min(
          wallLimit(kind),
          wallLimit(kind) === ANALYSIS_WALL_MS
            ? Math.floor(remaining * 0.4)
            : remaining,
          wallCapMs ?? Infinity,
        ),
      ),
      // The Sandbox runs on standard-4 (4 vCPUs, 12 GiB).
      memory_mb: sandbox ? SANDBOX_MEMORY_MB : 2048,
      cpu: sandbox ? SANDBOX_CPUS : 2,
      output_bytes: 1024 * 1024,
      ...(kind === "run" ? {} : { artifact_bytes: ARTIFACT_LIMIT }),
    },
    network: false,
    context,
  };
  const key = `reviews/${review}/jobs/${job}/${attempt}/payload.json`;
  await store.put(key, execution);
  await env.DB.prepare(
    "INSERT INTO jobs(id,review_id,attempt,status,payload_key,created_at,kind) VALUES(?,?,?,'pending',?,?,?) ON CONFLICT(id) DO NOTHING",
  )
    .bind(job, review, attempt, key, Date.now(), kind)
    .run();
  await env.JOBS.send({ review_id: review, job_id: job, attempt });
  return execution.limits.wall_ms;
}
export const SANDBOX_MEMORY_MB = 12288;
export const SANDBOX_CPUS = 4;
/**
 * A self-hosted council member's request as a runner job. Only a self-hosted
 * runner that advertises a model endpoint claims it; the request never
 * reaches the model gateway.
 */
export async function createModelJob(
  env: Env,
  review: string,
  job: string,
  model: NonNullable<Execution["model"]>,
  wallMs: number,
): Promise<void> {
  const store = new Store(env);
  invariant(!(await store.cancelled(review)), "cancelled");
  const execution: Execution = {
    protocol: 1,
    review_id: review,
    job_id: job,
    attempt: 1,
    kind: "model",
    command: ["rio-internal", "model"],
    version: "head",
    snapshot_id: "",
    needs: [],
    limits: {
      wall_ms: Math.max(1000, Math.min(120000, wallMs)),
      memory_mb: 0,
      cpu: 0,
      output_bytes: 1024 * 1024,
      artifact_bytes: 1024 * 1024,
    },
    network: false,
    model,
  };
  const key = `reviews/${review}/jobs/${job}/1/payload.json`;
  await store.put(key, execution);
  await env.DB.prepare(
    "INSERT INTO jobs(id,review_id,attempt,status,payload_key,created_at,kind) VALUES(?,?,1,'pending',?,?,'model') ON CONFLICT(id) DO NOTHING",
  )
    .bind(job, review, key, Date.now())
    .run();
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
  const inserted = await env.DB.prepare(
    "INSERT INTO jobs(id,review_id,attempt,status,payload_key,created_at,kind) VALUES(?,?,1,'pending',?,?,'prepare') ON CONFLICT(id) DO NOTHING",
  )
    .bind(job, review, key, Date.now())
    .run();
  // Only the attempt that created the job dispatches it.
  if (!inserted.meta.changes) return job;
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
  if (payload.kind === "model")
    invariant(
      value.artifact === undefined ||
        (typeof value.artifact?.content === "string" &&
          // Null when the endpoint reported no usage: the reservation stays.
          [value.artifact.input_tokens, value.artifact.output_tokens].every(
            (n: unknown) => n === null || Number.isInteger(n),
          )),
      "invalid model result",
    );
  invariant(
    (value.phase === undefined ||
      value.phase === "transfer" ||
      value.phase === "command") &&
      (value.timing === undefined ||
        (value.timing !== null &&
          typeof value.timing === "object" &&
          !Array.isArray(value.timing) &&
          Object.keys(value.timing).length <= 8 &&
          Object.values(value.timing).every(
            (n) => typeof n === "number" && Number.isFinite(n) && n >= 0,
          ))),
    "invalid runner result",
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
 * The jobs of a review nobody is working on: not taken by a runner, or taken
 * under a lease that ran out. Binds the current time.
 */
export const IDLE =
  "(status='pending' OR (status='leased' AND COALESCE(lease_until,0)<?))";
/**
 * Withdraws the idle jobs of a review that ended, so no runner starts one and
 * no late result is taken. A job a runner still holds ends with its result
 * (kept for the audit), or here once its lease runs out.
 */
export const withdrawIdle = (env: Env, review: string, now = Date.now()) =>
  env.DB.prepare(
    `UPDATE jobs SET status='failed' WHERE review_id=? AND ${IDLE}`,
  )
    .bind(review, now)
    .run();
/** Withdraws one job attempt nobody is waiting for; a late result is not kept. */
export const withdraw = (env: Env, job: string, attempt: number) =>
  env.DB.prepare(
    "UPDATE jobs SET status='failed' WHERE id=? AND attempt=? AND status IN ('pending','leased')",
  )
    .bind(job, attempt)
    .run();
/**
 * Stops the Sandbox containers still running jobs of a review that ended or
 * was cancelled: containers are few, and one would otherwise run until its
 * command's wall for a result nobody waits for. A job whose container
 * answered the stop is withdrawn here, so it does not read as running until
 * its lease ends; one that did not keeps its lease and its own deadline.
 * Model jobs have no container, and a QA run is revoked with its own record.
 */
export async function stopRunners(env: Env, review: string) {
  if (env.RUNNER_BACKEND !== "sandbox") return;
  const rows = await env.DB.prepare(
    "SELECT id,attempt FROM jobs WHERE review_id=? AND status='leased' AND kind IN ('checks','graph','static','run','prepare') LIMIT 20",
  )
    .bind(review)
    .all<{ id: string; attempt: number }>();
  for (const job of rows.results)
    try {
      const response = await env.SANDBOX.get(
        env.SANDBOX.idFromName(`${review}-${job.id}-${job.attempt}`),
      ).fetch("https://sandbox/stop", { method: "POST" });
      if (response.ok) await withdraw(env, job.id, job.attempt);
    } catch {
      // Best effort: the container's own deadline still ends it.
    }
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
  controlToken?: string,
) {
  const store = new Store(env),
    row = await env.DB.prepare(
      "SELECT * FROM jobs WHERE id=? AND review_id=? AND attempt=?",
    )
      .bind(job, review, attempt)
      .first<any>();
  invariant(row, "unknown job attempt");
  // A withdrawn job (its wait timed out) keeps no late result.
  if (row.status === "failed") return;
  const payload = await store.get<Execution>(row.payload_key);
  validateResult(result, payload);
  // The runner may have been replaced while its result body or R2 write was
  // in flight. Fence publication, not only the HTTP authentication step.
  const fence =
    payload.kind === "qa" && controlToken !== undefined
      ? " AND EXISTS(SELECT 1 FROM qa_runs q WHERE q.job_id=jobs.id AND q.attempt=jobs.attempt AND q.control_hash=? AND q.control_expires_at>?)"
      : "";
  const fenceArgs = () => (fence ? [hash(controlToken!), Date.now()] : []);
  result.command = payload.command;
  result.kind = payload.kind;
  // Concurrent completions never overwrite the artifact selected by the D1 compare-and-set.
  const key = `reviews/${review}/jobs/${job}/${attempt}/${hash(canonical(result))}.json`;
  // Whether the review was cancelled before this completion was recorded:
  // the cancel route then saw the job open and ended its wait itself.
  let notified = false;
  if (row.status !== "completed") {
    await store.put(key, result);
    const [, review_] = await env.DB.batch<{ cancelled: number }>([
      env.DB.prepare(
        "UPDATE jobs SET status='completed',result_key=?,completed_at=? WHERE id=? AND attempt=? AND status IN ('pending','leased')" +
          fence,
      ).bind(key, Date.now(), job, attempt, ...fenceArgs()),
      env.DB.prepare("SELECT cancelled FROM reviews WHERE id=?").bind(review),
    ]);
    notified = !!review_.results[0]?.cancelled;
  }
  const published = await env.DB.prepare(
    "SELECT result_key FROM jobs WHERE id=? AND review_id=? AND attempt=?" +
      fence,
  )
    .bind(job, review, attempt, ...fenceArgs())
    .first<{ result_key: string }>();
  invariant(published?.result_key === key, "conflicting runner completion");
  await finishQaRun(
    env,
    payload,
    key,
    result.exit_code !== 0 ||
      result.timed_out ||
      (payload.qa?.replay
        ? !["recurred", "not_recurred"].includes(result.artifact?.outcome)
        : result.artifact?.outcome !== "complete"),
  );
  // A prepare job hands its review over (Sandbox) or reports why it could not.
  if (payload.kind === "prepare")
    return finishPrepare(env, review, result, payload.snapshot_id);
  // Keep completed artifacts for audit after cancellation or the review's
  // end, without resuming model work: only an open review waits for a job.
  const state = await env.DB.prepare("SELECT status FROM reviews WHERE id=?")
    .bind(review)
    .first<{ status: string }>();
  const type = `job-${job}-${attempt}`;
  if (state?.status === "cancelled") {
    // The cancel route ends the waits of the jobs open when it runs. One
    // that completed just before it was no longer open, so its wait is
    // ended here, with no result either.
    if (notified) return;
    try {
      const instance = await env.REVIEWS.get(review);
      await instance.sendEvent({ type, payload: { cancelled: true } });
    } catch {
      // No instance, or one that ended: there is no wait to end.
    }
    return;
  }
  if (await store.cancelled(review)) return;
  if (state?.status !== "queued" && state?.status !== "running") return;
  // Re-sending after a transport failure is safe; event type includes the immutable attempt.
  const instance = await env.REVIEWS.get(review);
  await instance.sendEvent({ type, payload: { key } });
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

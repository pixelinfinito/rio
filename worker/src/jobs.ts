import type {
  Env,
  Execution,
  ExecutionResult,
  Version,
  Profile,
} from "./types";
import { Store } from "./storage";
import { canonical, hash, invariant } from "./validation";
import { needs } from "./archive";
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
  // Keep completed artifacts for audit after cancellation, without resuming model work.
  if (await store.cancelled(review)) return;
  // Re-sending after a transport failure is safe; event type includes the immutable attempt.
  const instance = await env.REVIEWS.get(review);
  await instance.sendEvent({ type: `job-${job}-${attempt}`, payload: { key } });
}

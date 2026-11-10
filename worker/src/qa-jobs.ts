import type {
  Env,
  Execution,
  Profile,
  QaExecution,
  Submission,
  Version,
} from "./types";
import { canonical, hash, invariant } from "./validation";
import { Store } from "./storage";
import { route } from "./gateway";

export const QA_HEARTBEAT_MS = 60000;
export const QA_LEASE_MS = 180000;
const COMPLETION_GRACE_MS = 120000;
const hex = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const random = () =>
  crypto.randomUUID().replaceAll("-", "") +
  crypto.randomUUID().replaceAll("-", "");
const duration = (value: string) => {
  const match = /^([1-9][0-9]*)(ms|s|m|h)$/.exec(value);
  const milliseconds =
    match &&
    Number(match[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[match[2]]!;
  invariant(
    Number.isSafeInteger(milliseconds) && milliseconds! > 0,
    "invalid QA wall budget",
  );
  return milliseconds as number;
};
export function qaBudget(
  profile: Profile,
  mode: "fast" | "deep",
): QaExecution["budget"] {
  const settings = (
    mode === "deep"
      ? (profile.budget.deep ?? profile.budget.fast)
      : profile.budget.fast
  ).qa;
  const budget = {
    wall_ms: duration(settings?.wall ?? (mode === "deep" ? "90m" : "30m")),
    cell_wall_ms: duration(
      settings?.cell_wall ?? (mode === "deep" ? "15m" : "8m"),
    ),
    tokens: settings?.tokens ?? (mode === "deep" ? 300000 : 150000),
    evidence_bytes:
      settings?.evidence_bytes ?? (mode === "deep" ? 1024 : 512) * 1024 ** 2,
    replay_wall_ms: duration(
      settings?.replay_wall ?? (mode === "deep" ? "10m" : "5m"),
    ),
  };
  invariant(
    Object.values(budget).every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ),
    "invalid QA budget",
  );
  return budget;
}
export interface QaCellDescriptor {
  id: string;
  chain: string[];
  viewport: string;
  color_scheme: "light" | "dark";
}
export interface QaConfiguration {
  evidence_retention_days?: number;
  cells: QaCellDescriptor[];
  seed_fingerprints: string[];
  seed_max_size: number;
}
export interface QaRun {
  id: string;
  review_id: string;
  job_id: string;
  attempt: number;
  step_id: string;
  version: Version;
  state: string;
  tenant: string;
  backend: string;
  model: string;
  deadline: number;
  cell_tokens: number;
  cell_wall_ms: number;
  evidence_limit: number;
  evidence_used: number;
  evidence_pruned: number;
  created_at: number;
  seed_max_size: number;
  configuration: string | null;
  // The review's prompt-cache hint classes as a JSON array (design D16).
  prompt_cache: string | null;
  generation: string;
  token_hash: string | null;
  control_hash: string | null;
  control_expires_at: number;
}
export async function createQaJob(
  env: Env,
  input: {
    review: string;
    job: string;
    step: string;
    attempt?: number;
    version?: Version;
    submission: Submission;
    options: Record<string, any>;
    model?: string;
    harnessAuth?: string;
    replay?: QaExecution["replay"];
    // The review's prompt configuration and the run provider's partition.
    prompt?: { cache: string[]; layout: string[]; partition?: string };
  },
): Promise<{ deferred: "no_runtime" | "fork" } | { job: Execution }> {
  const { submission, options } = input;
  if (submission.fork) return { deferred: "fork" };
  if (env.RUNNER_BACKEND === "sandbox" && options.sandbox !== "allow")
    return { deferred: "no_runtime" };
  invariant(
    !input.harnessAuth || input.harnessAuth === "gateway",
    "hosted QA requires gateway authentication",
  );
  invariant(
    !options.harness || ["codex", "pi"].includes(options.harness),
    "invalid QA harness",
  );
  const assertDispatch = (job: Execution) => {
    invariant(
      job.kind === "qa" &&
        job.qa?.step_id === input.step &&
        job.version === (input.version ?? "head") &&
        job.snapshot_id === submission.snapshot_id &&
        job.qa.model === (input.model ?? submission.profile.models.default) &&
        canonical(job.qa.options) === canonical(options),
      "conflicting QA dispatch",
    );
    invariant(
      canonical(job.qa.replay ?? null) === canonical(input.replay ?? null),
      "conflicting QA replay dispatch",
    );
    return job;
  };
  const existing = await env.DB.prepare(
    "SELECT payload_key,review_id,attempt FROM jobs WHERE id=?",
  )
    .bind(input.job)
    .first<{ payload_key: string; review_id: string; attempt: number }>();
  if (existing) {
    invariant(
      existing.review_id === input.review &&
        existing.attempt === (input.attempt ?? 1),
      "conflicting QA job identity",
    );
    const job = await new Store(env).get<Execution>(existing.payload_key);
    assertDispatch(job);
    await env.JOBS.send({
      review_id: input.review,
      job_id: input.job,
      attempt: existing.attempt,
    });
    return { job };
  }
  const model = input.model ?? submission.profile.models.default;
  if (!input.replay) route(env, model); // Replay is deterministic and makes no model calls.
  const budget = qaBudget(submission.profile, submission.mode),
    store = new Store(env),
    now = Date.now();
  const remaining = await store.remainingMs(input.review);
  invariant(remaining > 0, "cancelled");
  const prior = await env.DB.prepare(
    "SELECT MIN(deadline) AS deadline FROM qa_runs WHERE review_id=? AND step_id=?",
  )
    .bind(input.review, input.step)
    .first<{ deadline: number | null }>();
  // Head, baseline and retries share the step's wall allocation.
  const deadline = Math.min(
    now + remaining,
    prior?.deadline ??
      now + (input.replay ? budget.replay_wall_ms : budget.wall_ms),
  );
  invariant(deadline > now, "QA wall budget exhausted");
  const attempt = input.attempt ?? 1,
    version = input.version ?? "head",
    id = hash(`${input.review}:${input.job}:${attempt}`).slice(0, 32);
  const qa: QaExecution = {
    run_id: id,
    ...(input.replay ? { replay: input.replay } : {}),
    step_id: input.step,
    harness: options.harness ?? "codex",
    harness_auth: "gateway",
    model,
    options,
    mode: submission.mode,
    changed: submission.changed,
    graphs: submission.graphs,
    owner_guidance: submission.owner_guidance,
    ...(input.prompt
      ? {
          prompt: {
            layout: input.prompt.layout,
            ...(input.prompt.partition ? { partition: input.prompt.partition } : {}),
          },
        }
      : {}),
    budget: {
      ...budget,
      wall_ms: deadline - now,
      ...(input.replay ? { tokens: 1, cell_wall_ms: deadline - now } : {}),
    },
    policy:
      env.RUNNER_BACKEND === "sandbox"
        ? { egress: "provider_pinned (sandbox)", app_isolation: "none" }
        : { egress: "host_firewall_pinned", app_isolation: "container" },
  };
  const job: Execution = {
    protocol: 1,
    review_id: input.review,
    job_id: input.job,
    attempt,
    version,
    kind: "qa",
    command: ["rio-internal", "qa"],
    snapshot_id: submission.snapshot_id,
    needs: ["base", "head"],
    context: { profile: submission.profile },
    qa,
    limits: {
      wall_ms: deadline - now,
      memory_mb: env.RUNNER_BACKEND === "sandbox" ? 8192 : 2048,
      cpu: 2,
      output_bytes: 1024 * 1024,
      artifact_bytes: 12 * 1024 * 1024,
    },
    network: "qa",
  };
  const key = `reviews/${input.review}/jobs/${input.job}/${attempt}/${hash(canonical(job))}/payload.json`;
  await store.put(key, job);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO jobs(id,review_id,attempt,status,payload_key,created_at) VALUES(?,?,?,'pending',?,?) ON CONFLICT DO NOTHING",
    ).bind(input.job, input.review, attempt, key, now),
    env.DB.prepare(
      "INSERT INTO qa_runs(id,review_id,job_id,attempt,step_id,version,state,backend,model,deadline,cell_tokens,cell_wall_ms,evidence_limit,prompt_cache,created_at,updated_at) VALUES(?,?,?,?,?,?,'pending',?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
    ).bind(
      id,
      input.review,
      input.job,
      attempt,
      input.step,
      version,
      env.RUNNER_BACKEND,
      model,
      deadline,
      qa.budget.tokens,
      qa.budget.cell_wall_ms,
      budget.evidence_bytes,
      input.prompt?.cache.length ? JSON.stringify(input.prompt.cache) : null,
      now,
      now,
    ),
  ]);
  await env.JOBS.send({ review_id: input.review, job_id: input.job, attempt });
  const published = await env.DB.prepare(
    "SELECT payload_key FROM jobs WHERE id=? AND review_id=? AND attempt=?",
  )
    .bind(input.job, input.review, attempt)
    .first<{ payload_key: string }>();
  invariant(published, "QA job dispatch failed");
  return {
    job: assertDispatch(await store.get<Execution>(published.payload_key)),
  };
}

/** Claim-time secrets are returned only to the trusted runner. Reclaim rotates
 * both capabilities, fences the previous process and preserves cell ledgers. */
export async function claimQaRun(env: Env, job: Execution) {
  invariant(job.kind === "qa" && job.qa, "invalid QA job");
  const capability = "qa-run." + random(),
    token = "qa-job." + random(),
    generation = crypto.randomUUID(),
    now = Date.now();
  const run = await env.DB.prepare(
    "UPDATE qa_runs SET state='running',generation=?,token_hash=?,control_hash=?,control_expires_at=deadline+?,updated_at=? WHERE id=? AND job_id=? AND attempt=? AND state IN ('pending','running') AND deadline>? AND EXISTS(SELECT 1 FROM reviews r WHERE r.id=qa_runs.review_id AND r.cancelled=0 AND r.deadline>?) RETURNING *",
  )
    .bind(
      generation,
      hash(capability),
      hash(token),
      COMPLETION_GRACE_MS,
      now,
      job.qa.run_id,
      job.job_id,
      job.attempt,
      now,
      now,
    )
    .first<QaRun>();
  invariant(run, "QA job is no longer runnable");
  await env.DB.prepare(
    "DELETE FROM qa_seed_leases WHERE run_id=? AND (generation IS NULL OR generation!=?)",
  )
    .bind(run.id, generation)
    .run();
  const { abandonEvidence } = await import("./qa-evidence");
  await abandonEvidence(env, run.id, generation);
  const owner = await env.DB.prepare("SELECT tenant FROM reviews WHERE id=?")
    .bind(run.review_id)
    .first<{ tenant: string }>();
  invariant(owner, "QA review not found");
  return {
    token,
    qa: {
      tenant: owner.tenant,
      capability,
      run_id: run.id,
      generation,
      deadline: run.deadline,
      heartbeat_ms: QA_HEARTBEAT_MS,
      model_path: "/v1/qa/model",
      seed_path: "/v1/qa/seeds",
      evidence_path: `/v1/qa/runs/${run.id}/evidence`,
    },
  };
}
export async function authenticateQaRun(
  request: Request,
  env: Env,
): Promise<QaRun> {
  const bearer =
    request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  invariant(
    /^qa-run\.[a-f0-9]{64}$/.test(bearer),
    "unauthorized QA capability",
  );
  const now = Date.now();
  const run = await env.DB.prepare(
    "SELECT q.*,r.tenant FROM qa_runs q JOIN reviews r ON r.id=q.review_id JOIN jobs j ON j.id=q.job_id AND j.attempt=q.attempt WHERE q.token_hash=? AND q.state='running' AND q.deadline>? AND r.cancelled=0 AND r.deadline>? AND j.status='leased' AND j.lease_until>?",
  )
    .bind(hash(bearer), now, now, now)
    .first<QaRun>();
  invariant(run, "unauthorized QA capability");
  const header = request.headers.get("x-rio-run-id");
  invariant(!header || header === run.id, "unauthorized QA run scope");
  return run;
}
export async function qaControl(
  env: Env,
  review: string,
  job: string,
  attempt: number,
  token: string,
) {
  const run = await env.DB.prepare(
    "SELECT q.*,r.tenant FROM qa_runs q JOIN reviews r ON r.id=q.review_id WHERE q.review_id=? AND q.job_id=? AND q.attempt=? AND q.control_hash=? AND q.control_expires_at>?",
  )
    .bind(review, job, attempt, hash(token), Date.now())
    .first<QaRun>();
  invariant(run, "unauthorized runner capability");
  return run;
}
export async function configureQaRun(
  env: Env,
  run: QaRun,
  value: QaConfiguration,
) {
  invariant(
    value &&
      Object.keys(value).every((key) =>
        [
          "cells",
          "seed_fingerprints",
          "seed_max_size",
          "evidence_retention_days",
        ].includes(key),
      ) &&
      Array.isArray(value.cells) &&
      value.cells.length > 0 &&
      Array.isArray(value.seed_fingerprints) &&
      value.seed_fingerprints.length <= 2 &&
      value.seed_fingerprints.every(hex) &&
      new Set(value.seed_fingerprints).size ===
        value.seed_fingerprints.length &&
      Number.isSafeInteger(value.seed_max_size) &&
      value.seed_max_size > 0,
    "invalid QA run configuration",
  );
  invariant(
    value.evidence_retention_days === undefined ||
      (Number.isSafeInteger(value.evidence_retention_days) &&
        value.evidence_retention_days > 0 &&
        Number.isSafeInteger(
          run.created_at + value.evidence_retention_days * 86400000,
        )),
    "invalid QA evidence retention",
  );
  const ids = new Set<string>();
  for (const cell of value.cells) {
    invariant(
      cell &&
        Object.keys(cell).every((key) =>
          ["id", "chain", "viewport", "color_scheme"].includes(key),
        ) &&
        hex(cell.id) &&
        !ids.has(cell.id) &&
        Array.isArray(cell.chain) &&
        cell.chain.length > 0 &&
        cell.chain.every(
          (name) => typeof name === "string" && /^[a-z][a-z0-9-]*$/.test(name),
        ) &&
        typeof cell.viewport === "string" &&
        /^[a-z][a-z0-9-]*$/.test(cell.viewport) &&
        ["light", "dark"].includes(cell.color_scheme),
      "invalid QA cell",
    );
    ids.add(cell.id);
    invariant(
      cell.id ===
        hash(
          canonical({
            chain: cell.chain,
            viewport: cell.viewport,
            color_scheme: cell.color_scheme,
            version: run.version,
          }),
        ),
      "invalid QA cell identity",
    );
  }
  const configuration = canonical(value),
    now = Date.now();
  invariant(
    new TextEncoder().encode(configuration).length <= 1024 * 1024,
    "QA configuration too large",
  );
  const result = await env.DB.batch([
    env.DB.prepare(
      "UPDATE qa_runs SET configuration=?,seed_max_size=?,updated_at=? WHERE id=? AND generation=? AND state='running' AND deadline>? AND (configuration IS NULL OR configuration=?) AND EXISTS(SELECT 1 FROM jobs j WHERE j.id=qa_runs.job_id AND j.attempt=qa_runs.attempt AND j.status='leased' AND j.lease_until>?) AND EXISTS(SELECT 1 FROM reviews r WHERE r.id=qa_runs.review_id AND r.cancelled=0 AND r.deadline>?) RETURNING id",
    ).bind(
      configuration,
      value.seed_max_size,
      now,
      run.id,
      run.generation,
      now,
      configuration,
      now,
      now,
    ),
    env.DB.prepare(
      "INSERT INTO qa_cells(run_id,id,descriptor) SELECT ?,json_extract(value,'$.id'),value FROM json_each(?,'$.cells') WHERE EXISTS(SELECT 1 FROM qa_runs q JOIN reviews r ON r.id=q.review_id JOIN jobs j ON j.id=q.job_id AND j.attempt=q.attempt WHERE q.id=? AND q.generation=? AND q.configuration=? AND q.state='running' AND q.deadline>? AND r.cancelled=0 AND r.deadline>? AND j.status='leased' AND j.lease_until>?) ON CONFLICT DO NOTHING",
    ).bind(
      run.id,
      configuration,
      run.id,
      run.generation,
      configuration,
      now,
      now,
      now,
    ),
  ]);
  invariant(
    result[0].results.length,
    "QA configuration is immutable or the run has stopped",
  );
  return { configured: true };
}
export async function heartbeatQaRun(env: Env, run: QaRun) {
  const now = Date.now(),
    expires = Math.min(now + QA_LEASE_MS, run.deadline);
  const updated = await env.DB.prepare(
    "UPDATE jobs SET lease_until=? WHERE id=? AND review_id=? AND attempt=? AND status='leased' AND lease_until>? AND EXISTS(SELECT 1 FROM qa_runs q JOIN reviews r ON r.id=q.review_id WHERE q.id=? AND q.generation=? AND q.state='running' AND q.deadline>? AND r.cancelled=0 AND r.deadline>?) RETURNING id",
  )
    .bind(
      expires,
      run.job_id,
      run.review_id,
      run.attempt,
      now,
      run.id,
      run.generation,
      now,
      now,
    )
    .all();
  if (updated.results.length)
    return {
      cancelled: false,
      lease_until: expires,
      deadline: run.deadline,
      heartbeat_ms: QA_HEARTBEAT_MS,
    };
  await revokeQaRun(env, run.id, run.generation);
  return {
    cancelled: true,
    reason: run.deadline <= now ? "budget" : "interrupted",
    deadline: run.deadline,
  };
}
export async function revokeQaRun(env: Env, id: string, generation?: string) {
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE qa_runs SET token_hash=NULL,state=CASE WHEN state IN ('pending','running') THEN 'cancelled' ELSE state END,updated_at=? WHERE id=? AND (? IS NULL OR generation=?)",
    ).bind(Date.now(), id, generation ?? null, generation ?? null),
    env.DB.prepare(
      "DELETE FROM qa_seed_leases WHERE run_id=? AND (? IS NULL OR generation=?)",
    ).bind(id, generation ?? null, generation ?? null),
  ]);
}
export async function finishQaRun(
  env: Env,
  job: Execution,
  key: string,
  partial: boolean,
) {
  if (job.kind !== "qa" || !job.qa) return;
  const state =
    partial || (await new Store(env).cancelled(job.review_id))
      ? "partial"
      : "complete";
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE qa_runs SET state=?,token_hash=NULL,result_key=?,updated_at=? WHERE id=? AND job_id=? AND attempt=?",
    ).bind(state, key, Date.now(), job.qa.run_id, job.job_id, job.attempt),
    env.DB.prepare("DELETE FROM qa_seed_leases WHERE run_id=?").bind(
      job.qa.run_id,
    ),
  ]);
}

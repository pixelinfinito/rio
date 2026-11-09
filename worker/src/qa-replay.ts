/** Durable, model-free replay dispatch. All evidence is read through the same
 * tenant/review/run authorization as the original verifier evidence pack. */
import type { WorkflowStep } from "cloudflare:workers";
import type { Env, ExecutionResult, Submission, Version } from "./types";
import type {
  QaCandidate,
  ReplayResult,
  BrowserArtifact,
  LoadedArtifact,
} from "./qa-verifier";
import { createQaJob } from "./qa-jobs";
import { readQaEvidence } from "./qa-evidence";
import { Store } from "./storage";
import { hash, canonical, invariant } from "./validation";

export async function dispatchQaReplay(o: {
  env: Env;
  step: WorkflowStep;
  review: string;
  tenant: string;
  qaStep: string;
  submission: Submission;
  options: Record<string, any>;
  candidate: QaCandidate;
  version: Version;
  sourceRun: string;
  original: any;
}): Promise<ReplayResult> {
  const { candidate, version } = o,
    target = candidate.finding.qa;
  const scope = {
    version,
    journey: target.journey,
    step: target.step,
    cell: candidate.cell,
  };
  const store = new Store(o.env),
    identity = candidate.finding.id;
  const jobId = hash(`${o.review}-${o.qaStep}-qa-replay-${identity}`).slice(
    0,
    32,
  );
  try {
    const artifacts: BrowserArtifact[] =
      (o.original.head_evidence ?? o.original.evidence)?.artifacts ?? [];
    const log = artifacts.find(
      (row) =>
        row.kind === "replay" &&
        row.journey === target.journey &&
        canonical(row.cell) === canonical(candidate.cell),
    );
    invariant(log, "recorded replay unavailable");
    const data = await readQaEvidence(
      o.env,
      o.tenant,
      o.review,
      o.sourceRun,
      log,
    );
    invariant(data?.text, "recorded replay unavailable");
    const events = data.text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const replay = {
      hypothesis: identity,
      source_run: o.sourceRun,
      ...((o.original.seed_fingerprint ?? o.original.seed?.fingerprint)
        ? {
            seed_fingerprint:
              o.original.seed_fingerprint ?? o.original.seed?.fingerprint,
          }
        : {}),
      until: { journey: target.journey, step: target.step },
      events,
      artifacts: artifacts.filter(
        (row) => canonical(row.cell) === canonical(candidate.cell),
      ),
    };
    invariant(
      new TextEncoder().encode(canonical(replay)).length <= 12 * 1024 ** 2,
      "replay input too large",
    );
    const dispatched = await o.step.do(`dispatch-${jobId}`, () =>
      createQaJob(o.env, {
        review: o.review,
        job: jobId,
        step: `${o.qaStep}-replay-${identity}`,
        version,
        submission: o.submission,
        options: o.options,
        replay,
      }),
    );
    invariant("job" in dispatched, "QA replay runtime unavailable");
    const completed = await o.step.waitForEvent<{ key: string }>(
      `wait-${jobId}`,
      {
        type: `job-${jobId}-1`,
        timeout: `${Math.ceil(dispatched.job.limits.wall_ms / 1000) + 120} seconds`,
      },
    );
    const execution = await store.get<ExecutionResult>(completed.payload.key);
    invariant(
      execution.job_id === jobId &&
        execution.attempt === 1 &&
        execution.version === version &&
        execution.exit_code === 0 &&
        execution.artifact,
      "QA replay failed",
    );
    const result = execution.artifact;
    invariant(
      ["recurred", "not_recurred", "prerequisites_failed"].includes(
        result.outcome,
      ) &&
        canonical(result.cell) === canonical(candidate.cell) &&
        canonical(result.until) === canonical(replay.until),
      "invalid QA replay result",
    );
    const retained: BrowserArtifact[] = result.evidence?.artifacts ?? [];
    const selected = retained.filter(
      (row) =>
        row.sanitized &&
        row.journey === target.journey &&
        canonical(row.cell) === canonical(candidate.cell) &&
        (row.step === target.step || row.kind === "trace"),
    );
    const loaded: Record<string, LoadedArtifact> = {};
    for (const artifact of selected) {
      const value = await readQaEvidence(
        o.env,
        o.tenant,
        o.review,
        dispatched.job.qa!.run_id,
        artifact,
      );
      if (value) loaded[artifact.id] = value;
    }
    const record: ReplayResult = {
      outcome: result.outcome,
      reason: result.reason,
      scope,
      evidence: selected.filter((row) => loaded[row.id]).map((row) => row.id),
      artifacts: selected,
      run_id: dispatched.job.qa!.run_id,
      wall_time_ms: result.wall_time_ms,
      bytes: result.evidence?.bytes ?? 0,
      comparison: result.comparison,
    };
    await store.put(`reviews/${o.review}/qa/replays/${identity}.json`, {
      ...record,
      manifest: result.evidence,
    });
    return { ...record, loaded };
  } catch {
    const record: ReplayResult = {
      outcome: "prerequisites_failed",
      reason: "replay_unavailable",
      scope,
      evidence: [],
    };
    await store.put(`reviews/${o.review}/qa/replays/${identity}.json`, record);
    return record;
  }
}

import type {
  ArtifactRef,
  Evidence,
  ExecutionResult,
  Graph,
  Guidance,
  Hypothesis,
  Snapshot,
  Verification,
  Vote,
  VoteAnswer,
} from "./types";
import { hash, normalizeTrigger } from "./validation";
const rank: Record<Evidence, number> = {
  refuted: 0,
  plausible: 1,
  static_proven: 2,
  reproduced: 3,
};
export function blindMatch(
  blind: Hypothesis[],
  original: Hypothesis,
): "same" | "related" | "none" {
  if (
    blind.some(
      (b) =>
        b.rule_id === original.rule_id &&
        hash(normalizeTrigger(b.trigger)) ===
          hash(normalizeTrigger(original.trigger)),
    )
  )
    return "same";
  return blind.some(
    (b) =>
      b.location.path === original.location.path &&
      b.location.symbol_path === original.location.symbol_path,
  )
    ? "related"
    : "none";
}
export interface EvidenceContext {
  snapshot: Snapshot;
  head: Graph;
  executions: Record<string, ExecutionResult>;
  guidance: Guidance[];
}
function validCode(ref: ArtifactRef, context: EvidenceContext): boolean {
  if (
    ref.version !== "head" ||
    !ref.path ||
    !ref.node_ids?.length ||
    !context.snapshot.head[ref.path] ||
    context.snapshot.head[ref.path].mode === 0o120000
  )
    return false;
  const ids = new Set(ref.node_ids);
  const nodes = ref.node_ids.map((id) =>
    context.head.nodes.find((n) => n.id === id && n.path === ref.path),
  );
  if (nodes.some((n) => !n)) return false;
  // A multi-node citation must describe a connected path, not an arbitrary bag of nodes.
  const seen = new Set<string>([ref.node_ids[0]]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of context.head.edges)
      if (
        ids.has(e.from) &&
        ids.has(e.to) &&
        (seen.has(e.from) || seen.has(e.to))
      )
        for (const id of [e.from, e.to])
          if (!seen.has(id)) {
            seen.add(id);
            changed = true;
          }
  }
  return seen.size === ids.size;
}
function validRun(
  ref: ArtifactRef,
  context: EvidenceContext,
  passing: boolean,
): boolean {
  const job = ref.job_id && context.executions[ref.job_id];
  return (
    !!job &&
    job.kind === "run" &&
    // Only commands that actually ran count; runner failures carry no evidence.
    job.outcome === "exited" &&
    !job.timed_out &&
    !job.truncated &&
    job.version === ref.version &&
    (passing
      ? ref.version === "head" && job.exit_code === 0
      : ref.version === "head" && job.exit_code !== 0)
  );
}
export function evidenceLevel(
  answer: VoteAnswer,
  h: Hypothesis,
  context: EvidenceContext,
): Evidence {
  if (h.rule_id.startsWith("guidance/") && !h.guidance) return "plausible";
  if (h.guidance) {
    const g = context.guidance.find((g) => g.path === h.guidance!.path);
    if (
      !g ||
      h.guidance.line < 1 ||
      h.guidance.line > g.lines.length ||
      (g.scope_dir && !h.location.path.startsWith(`${g.scope_dir}/`))
    )
      return "plausible";
  }
  const proof = answer.evidence.filter((r) => r.demonstrates === "regression");
  const protection = answer.evidence.filter(
    (r) => r.demonstrates === "protection",
  );
  if (answer.evidence_level === "refuted")
    return protection.some((r) =>
      r.kind === "execution"
        ? validRun(r, context, true)
        : validCode(r, context),
    )
      ? "refuted"
      : "plausible";
  if (
    answer.evidence_level === "reproduced" &&
    proof.some((r) => r.kind === "execution" && validRun(r, context, false))
  )
    return "reproduced";
  if (
    rank[answer.evidence_level] >= 2 &&
    proof.some((r) => r.kind === "code" && validCode(r, context))
  )
    return "static_proven";
  return "plausible";
}
export function aggregate(
  votes: Vote[],
  voters: number,
  quorum: number,
): { evidence_level: Evidence; verification: Verification } {
  const distinct = new Map<number, Vote>();
  for (const vote of votes)
    if (vote.voter >= 0 && vote.voter < voters && !distinct.has(vote.voter))
      distinct.set(vote.voter, vote);
  const levels = [...distinct.values()]
    .filter((v) => v.status === "completed")
    .map((v) => v.validated_level)
    .filter((l): l is Evidence => l !== undefined);
  const refuted = levels.filter((l) => l === "refuted").length;
  let positive: Evidence | undefined,
    agreeing = 0;
  for (const level of [
    "reproduced",
    "static_proven",
    "plausible",
  ] as Evidence[]) {
    const support = levels.filter(
      (l) => l !== "refuted" && rank[l] >= rank[level],
    ).length;
    if (support >= quorum) {
      positive = level;
      agreeing = support;
      break;
    }
  }
  const both = refuted >= quorum && positive !== undefined,
    neither = refuted < quorum && !positive;
  const split =
    both || neither || (refuted > 0 && levels.some((l) => l !== "refuted"));
  const evidence_level: Evidence =
    both || neither ? "plausible" : refuted >= quorum ? "refuted" : positive!;
  if (evidence_level === "refuted") agreeing = refuted;
  if (both || neither) agreeing = levels.filter((l) => l !== "refuted").length;
  return {
    evidence_level,
    verification: {
      voters,
      agreeing,
      blind_match: Array.from(
        { length: voters },
        (_, i) => distinct.get(i)?.blind_match ?? "none",
      ),
      split,
    },
  };
}

import type {
  ArtifactRef,
  Evidence,
  ExecutionResult,
  Graph,
  GraphNode,
  Guidance,
  Hypothesis,
  Location,
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
  // Modes of the head files cited by the evidence being checked (a full
  // snapshot also satisfies this); checks stay synchronous.
  snapshot: { head: Record<string, { mode: number }> };
  head: Graph;
  /** Base graph, for contract hypotheses whose refutation cites a consumer updated in head. */
  base?: Graph;
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
  const nodes = ref.node_ids.map((id) =>
    context.head.nodes.find((n) => n.id === id && n.path === ref.path),
  );
  if (nodes.some((n) => !n)) return false;
  return connected(ref.node_ids, context.head);
}
/** A multi-node citation must describe a connected path, not an arbitrary bag of nodes. */
function connected(nodeIds: string[], graph: Graph): boolean {
  const ids = new Set(nodeIds);
  const seen = new Set<string>([nodeIds[0]]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of graph.edges)
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
const overlaps = (n: GraphNode, l: Location) =>
  n.path === l.path && n.line_start <= l.line_end && n.line_end >= l.line_start;
/** Consumers a contract hypothesis cites: every location after the producer. */
function consumers(h: Hypothesis): Location[] {
  return (h.locations ?? []).slice(1);
}
/**
 * Contract static proof: a connected head graph path, across files, that
 * contains a cited consumer and reaches the changed contract's file.
 */
function validContractPath(
  ref: ArtifactRef,
  h: Hypothesis,
  context: EvidenceContext,
): boolean {
  if (
    ref.kind !== "code" ||
    ref.version !== "head" ||
    !ref.path ||
    !ref.node_ids?.length ||
    !context.snapshot.head[ref.path] ||
    context.snapshot.head[ref.path].mode === 0o120000
  )
    return false;
  const nodes = ref.node_ids.map((id) =>
    context.head.nodes.find((n) => n.id === id),
  );
  if (nodes.some((n) => !n) || !nodes.some((n) => n!.path === ref.path))
    return false;
  if (!connected(ref.node_ids, context.head)) return false;
  return (
    nodes.some((n) => consumers(h).some((l) => overlaps(n!, l))) &&
    nodes.some((n) => n!.path === h.location.path)
  );
}
/** A contract protection must sit on the path: in the contract's file or a cited consumer. */
function onContractPath(
  ref: ArtifactRef,
  h: Hypothesis,
  context: EvidenceContext,
): boolean {
  if (!validCode(ref, context)) return false;
  return ref.node_ids!.some((id) => {
    const node = context.head.nodes.find((n) => n.id === id)!;
    return (
      node.path === h.location.path ||
      consumers(h).some((l) => overlaps(node, l))
    );
  });
}
/**
 * Contract refutation by a consumer update: a cited head node at a consumer
 * whose content differs from the same symbol in base (or is new in head).
 */
function updatedConsumer(
  ref: ArtifactRef,
  h: Hypothesis,
  context: EvidenceContext,
): boolean {
  if (
    ref.kind !== "code" ||
    ref.version !== "head" ||
    !ref.path ||
    !ref.node_ids?.length ||
    !context.snapshot.head[ref.path] ||
    !context.base
  )
    return false;
  return ref.node_ids.some((id) => {
    const node = context.head.nodes.find(
      (n) => n.id === id && n.path === ref.path,
    ) as (GraphNode & { content_hash?: string }) | undefined;
    if (!node || !consumers(h).some((l) => overlaps(node, l))) return false;
    const before = context.base!.nodes.find(
      (n) => n.path === node.path && n.symbol_path === node.symbol_path,
    ) as (GraphNode & { content_hash?: string }) | undefined;
    return (
      !before ||
      (!!node.content_hash &&
        !!before.content_hash &&
        node.content_hash !== before.content_hash)
    );
  });
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
  const contract = h.rule_id.startsWith("contracts/");
  if (answer.evidence_level === "refuted")
    return protection.some((r) =>
      r.kind === "execution"
        ? validRun(r, context, true)
        : contract
          ? updatedConsumer(r, h, context) || onContractPath(r, h, context)
          : validCode(r, context),
    )
      ? "refuted"
      : "plausible";
  if (
    answer.evidence_level === "reproduced" &&
    proof.some((r) => r.kind === "execution" && validRun(r, context, false))
  )
    return "reproduced";
  // A contract break is proven statically only by a head graph path from a
  // cited consumer to the changed contract.
  if (
    rank[answer.evidence_level] >= 2 &&
    proof.some((r) =>
      contract
        ? validContractPath(r, h, context)
        : r.kind === "code" && validCode(r, context),
    )
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

import type { Evidence } from "./types";
import type {
  Answer,
  Assessment,
  Basis,
  ExperimentRequest,
  Member,
  Role,
} from "./council";
import type { CodeArtifact, NodeArtifact, Pack } from "./council-pack";

/**
 * The council's deterministic aggregator (design D7): no model call, evidence
 * tiers in order, and agreement never counts. Weights order the note's
 * presentation and experiment selection only.
 */

/** One run of an experiment on one version. */
export interface ExperimentRun {
  exit_code: number;
  outcome?: "exited" | "spawn_failed" | "runner_failed";
  timed_out: boolean;
  truncated: boolean;
}
export interface Experiment {
  id: string;
  request: ExperimentRequest;
  runs: { base?: ExperimentRun; head?: ExperimentRun };
}
export interface Position {
  role: Role;
  weight: number;
  assessment: Assessment;
}
export interface Decision {
  decision: "reproduced" | "refuted" | "plausible";
  tier: "experiment" | "protection" | "judgment";
  /** Experiment ids that reproduced the finding. */
  artifacts?: string[];
  /** The artifact a refutation cites. */
  protection?: string;
  note: string;
  /** The finding's evidence level after the decision; never below plausible unless refuted. */
  evidence_level: Evidence;
}

/** Only commands that ran to completion count, as for verifier reproductions. */
const valid = (run?: ExperimentRun) =>
  !!run && run.outcome === "exited" && !run.timed_out && !run.truncated;
/** Requests are the same experiment only when their argv is identical. */
export const normalize = (command: string[]) => JSON.stringify(command);

/** Experiment ids whose command failed on head and passed on base. */
export function reproducing(experiments: Experiment[]): string[] {
  const byCommand = new Map<string, Experiment[]>();
  for (const e of experiments) {
    const key = normalize(e.request.command);
    byCommand.set(key, [...(byCommand.get(key) ?? []), e]);
  }
  const ids: string[] = [];
  for (const group of byCommand.values()) {
    const failedOnHead = group.filter(
      (e) => valid(e.runs.head) && e.runs.head!.exit_code !== 0,
    );
    const passedOnBase = group.filter(
      (e) => valid(e.runs.base) && e.runs.base!.exit_code === 0,
    );
    if (failedOnHead.length && passedOnBase.length)
      ids.push(...new Set([...failedOnHead, ...passedOnBase].map((e) => e.id)));
  }
  return ids.sort();
}

/**
 * Whether a cited artifact is head code the graph places on the path from the
 * trigger to the location: the location's own symbol or one of its callers'
 * chain in the pack's head slice.
 */
/** Strongly connected groups of the call graph and which of them are entries. */
interface Structure {
  callers: Map<string, string[]>;
  group: Map<string, number>;
  /** Groups that nothing outside them calls: callable from outside the slice. */
  entries: Set<number>;
}
const structures = new WeakMap<Pack, Structure>();
function structure(pack: Pack): Structure {
  const known = structures.get(pack);
  if (known) return known;
  const edges = pack.graph.head.calls;
  const callers = new Map<string, string[]>(),
    callees = new Map<string, string[]>();
  const ids = new Set<string>();
  for (const [from, to] of edges) {
    ids.add(from).add(to);
    callers.set(to, [...(callers.get(to) ?? []), from]);
    callees.set(from, [...(callees.get(from) ?? []), to]);
  }
  for (const a of pack.artifacts)
    if (a.kind === "node" && a.version === "head") ids.add(a.id);
  // Tarjan's algorithm, iterative: one pass over the slice.
  const index = new Map<string, number>(),
    low = new Map<string, number>(),
    group = new Map<string, number>();
  const stack: string[] = [],
    onStack = new Set<string>();
  let counter = 0,
    groups = 0;
  for (const root of ids) {
    if (index.has(root)) continue;
    const work: [string, number][] = [[root, 0]];
    while (work.length) {
      const frame = work[work.length - 1];
      const [v, i] = frame;
      if (i === 0) {
        index.set(v, counter);
        low.set(v, counter++);
        stack.push(v);
        onStack.add(v);
      }
      const next = callees.get(v) ?? [];
      if (i < next.length) {
        frame[1]++;
        const w = next[i];
        if (!index.has(w)) work.push([w, 0]);
        else if (onStack.has(w))
          low.set(v, Math.min(low.get(v)!, index.get(w)!));
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1][0];
        low.set(parent, Math.min(low.get(parent)!, low.get(v)!));
      }
      if (low.get(v) === index.get(v)) {
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          group.set(w, groups);
        } while (w !== v);
        groups++;
      }
    }
  }
  const entries = new Set<number>(Array.from({ length: groups }, (_, g) => g));
  for (const [from, to] of edges)
    if (group.get(from) !== group.get(to)) entries.delete(group.get(to)!);
  const result = { callers, group, entries };
  structures.set(pack, result);
  return result;
}

/**
 * Whether a cited artifact is head code on every path from the trigger to
 * the finding. The location's own symbol always is. A caller is only when no
 * entry of the slice (a group of functions nothing outside it calls, which
 * includes a location callable directly) reaches any site of the finding
 * without passing it. Entries are judged on the whole slice, the guard
 * included. An incomplete slice, or a site missing from it, never refutes.
 */
export function onPath(pack: Pack, ref: string): boolean {
  const artifact = pack.artifacts.find((a) => a.id === ref);
  if (!artifact || !("version" in artifact) || artifact.version !== "head")
    return false;
  const nodes =
    artifact.kind === "node"
      ? [artifact.id]
      : artifact.kind === "code"
        ? (artifact as CodeArtifact).node_ids
        : [];
  const locations = new Set(
    pack.artifacts
      .filter(
        (a): a is NodeArtifact =>
          a.kind === "node" &&
          a.version === "head" &&
          a.relation === "location",
      )
      .map((a) => a.id),
  );
  // Every site must be in the slice before any protection can cover them all.
  if (!locations.size || pack.graph.head.missing_sites) return false;
  const complete = !pack.graph.head.truncated;
  const { callers, group, entries } = structure(pack);
  // Only call edges count: a function that merely references the location
  // does not sit on any path that executes it.
  const covers = (guard: string, location: string): boolean => {
    if (guard === location) return true;
    // An incomplete slice may hide an unguarded caller.
    if (!complete) return false;
    const reached = new Set([location]);
    const queue = [location];
    let guarded = false;
    while (queue.length) {
      const id = queue.shift()!;
      if (entries.has(group.get(id)!)) return false;
      for (const from of callers.get(id) ?? []) {
        if (from === guard) guarded = true;
        else if (!reached.has(from)) {
          reached.add(from);
          queue.push(from);
        }
      }
    }
    return guarded;
  };
  return [...new Set(nodes)].some((guard) =>
    [...locations].every((location) => covers(guard, location)),
  );
}

const share = (part: number, total: number) =>
  total <= 0 || part <= 0
    ? null
    : part / total >= 0.75
      ? "most of the weight"
      : part / total >= 0.5
        ? "about half of the weight"
        : "a minority of the weight";
const answers: Answer[] = ["yes", "no", "unknown"];

function describe(
  positions: Position[],
  field: "real" | "introduced_by_change",
  label: string,
): string {
  const total = positions.reduce((n, p) => n + p.weight, 0);
  const parts = answers
    .map((answer) => {
      const holders = positions.filter((p) => p.assessment[field] === answer);
      const weight = holders.reduce((n, p) => n + p.weight, 0);
      const bases = [
        ...new Set(
          holders
            .sort((a, b) => b.weight - a.weight || a.role.localeCompare(b.role))
            .map((p) => p.assessment.basis),
        ),
      ];
      const amount = share(weight, total);
      return amount
        ? `${amount} answers ${answer} (${bases.join(", ")}; ${holders
            .map((p) => p.role)
            .join(", ")})`
        : null;
    })
    .filter(Boolean);
  return `${label}: ${parts.join("; ") || "no member answered"}.`;
}

/** The council note: positions by basis and dissent, in words, never percentages. */
export function note(positions: Position[], experiments: Experiment[]): string {
  const lines: string[] = [];
  if (!positions.length) lines.push("No member answered.");
  else if (positions.every((p) => p.assessment.basis === "none"))
    lines.push("No member cited evidence: every answer had basis none.");
  if (positions.length) {
    lines.push(describe(positions, "real", "Real"));
    lines.push(
      describe(positions, "introduced_by_change", "Introduced by the change"),
    );
  }
  const run = experiments.filter((e) => e.runs.base || e.runs.head);
  lines.push(
    run.length
      ? `Experiments: ${run
          .map((e) => {
            const outcome = (["base", "head"] as const)
              .filter((v) => e.runs[v])
              .map((v) =>
                valid(e.runs[v])
                  ? `${e.runs[v]!.exit_code === 0 ? "passed" : "failed"} on ${v}`
                  : `did not complete on ${v}`,
              )
              .join(", ");
            return `${e.id} ${outcome}`;
          })
          .join("; ")}.`
      : "No experiment ran.",
  );
  return lines.join(" ");
}

/**
 * Decide in order: an experiment that fails on head and passes on base
 * reproduces the finding; a protection found on the path, cited by members
 * holding at least half of the answering weight, refutes it; anything
 * else stays plausible with a note. The evidence level never drops below the
 * verifier's unless refuted, and the category is never touched here.
 */
export function aggregate(
  positions: Position[],
  experiments: Experiment[],
  pack: Pack,
  verifierLevel: Evidence,
): Decision {
  const text = note(positions, experiments);
  const reproduced = reproducing(experiments);
  if (reproduced.length)
    return {
      decision: "reproduced",
      tier: "experiment",
      artifacts: reproduced,
      note: text,
      evidence_level: "reproduced",
    };
  // The path check cannot show that the cited code stops the defect (the
  // location's own symbol is always on the path), so a protection refutes only
  // when the members citing one and answering `real: no` hold at least half
  // of the answering weight. Each cited reference is checked once, and the
  // first on the path decides.
  const protecting = positions.filter(
    (p) =>
      p.assessment.basis === "protection_found" && p.assessment.real === "no",
  );
  const weight = (list: Position[]) => list.reduce((n, p) => n + p.weight, 0);
  const backed =
    protecting.length > 0 && 2 * weight(protecting) >= weight(positions);
  const cited = backed
    ? protecting
        .sort((a, b) => b.weight - a.weight || a.role.localeCompare(b.role))
        .flatMap((p) => p.assessment.evidence_refs)
    : [];
  const found = [...new Set(cited)].find((ref) => onPath(pack, ref));
  const protections = found ? [found] : [];
  if (protections.length)
    return {
      decision: "refuted",
      tier: "protection",
      protection: protections[0],
      note: text,
      evidence_level: "refuted",
    };
  return {
    decision: "plausible",
    tier: "judgment",
    note: text,
    evidence_level: verifierLevel,
  };
}

/** Learned weights per member and category with their sample sizes. */
export type Weights = Record<
  string,
  // `weight` is null below the sample floor: the manifest weight applies.
  Record<string, { weight: number | null; samples: number }>
>;
/** Fewer cases than this keep the manifest's initial weight. */
export const WEIGHT_FLOOR = 30;
export function weightOf(
  member: Pick<Member, "name" | "weight">,
  category: string,
  learned: Weights,
): { weight: number; samples: number; learned: boolean } {
  const entry = learned[member.name]?.[category];
  return entry && entry.weight !== null && entry.samples >= WEIGHT_FLOOR
    ? { weight: entry.weight, samples: entry.samples, learned: true }
    : { weight: member.weight, samples: entry?.samples ?? 0, learned: false };
}
export type { Basis };

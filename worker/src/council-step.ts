import type { Verified } from "./consolidate";
import type {
  CouncilRound,
  CouncilReview,
  ExecutionResult,
  Graph,
  Guidance,
  ModelResponse,
  Profile,
  Vote,
} from "./types";
import { evaluate, type Plan } from "./triage";
import { parseModelOutput } from "./gateway";
import {
  ROLES,
  validateAssessment,
  type AbstentionCause,
  type Assessment,
  type Composition,
  type CouncilSettings,
  type ExperimentRequest,
  type Member,
  type Role,
} from "./council";
import {
  affectedPaths,
  artifactIds,
  buildPack,
  memberRequest,
  type MemberRequest,
  render,
  type Pack,
} from "./council-pack";
import {
  aggregate,
  normalize,
  weightOf,
  type Experiment,
  type ExperimentRun,
  type Position,
  type Weights,
} from "./council-aggregate";
import { hash } from "./validation";
import { layerHashes } from "./prompt";
import { parseWall } from "./budget";
import prompts from "./member-prompts.json";

/**
 * The `rio/council` step (design D1-D8): selects findings by the step's rules,
 * builds one evidence pack per finding, runs one or two structured rounds and
 * at most `max_experiments` experiments, and decides with the deterministic
 * aggregator. No member or vendor can fail or block the review.
 */

const SEVERITY = { error: 3, warning: 2, info: 1 } as const;
/** The finding-v1 fields of an experiment request. */
const requested = (r: ExperimentRequest) => ({
  command: r.command,
  version: r.version,
  expect: r.expect,
});
const EVIDENCE = { refuted: 0, plausible: 1, static_proven: 2, reproduced: 3 };

export interface Selection {
  selected: { verified: Verified; rule: string }[];
  /** Findings that matched a rule but fell beyond `max_findings`. */
  not_councilled: string[];
}
/**
 * A finding is selected when any of the council step's rules matches it; the
 * cap keeps the strongest by severity × evidence, with stable ordering.
 */
export function select(
  verified: Verified[],
  rules: { when: string }[],
  plan: Plan,
  changed: string[],
  nightly: boolean,
  max: number,
): Selection {
  const matched: { verified: Verified; rule: string }[] = [];
  for (const v of verified) {
    const category = v.category ?? v.hypothesis.category;
    if (
      v.evidence_level === "refuted" ||
      category === "style" ||
      category === "diagnostic"
    )
      continue;
    const rule = rules.find((r) =>
      evaluate(r.when, plan, changed, {
        nightly,
        finding: {
          evidence_level: v.evidence_level,
          severity: v.hypothesis.severity,
          split: v.verification.split,
        },
      }),
    );
    if (rule) matched.push({ verified: v, rule: rule.when });
  }
  const rank = (v: Verified) =>
    SEVERITY[v.hypothesis.severity] * EVIDENCE[v.evidence_level];
  matched.sort(
    (a, b) =>
      rank(b.verified) - rank(a.verified) ||
      a.verified.hypothesis.id.localeCompare(b.verified.hypothesis.id),
  );
  return {
    selected: matched.slice(0, max),
    not_councilled: matched.slice(max).map((m) => m.verified.hypothesis.id),
  };
}

/** One member call's audit entry: hashes and sizes, never content. */
export interface AuditEntry {
  finding: string;
  member: Role;
  round: 1 | 2;
  vendor: string | null;
  model: string;
  pack_hash: string;
  pack_bytes: number;
  rendering_hash: string;
  rendering_bytes: number;
  /** Hash and size of each prompt layer that was sent, never its text. */
  layers?: { layer: string; sha256: string; bytes: number }[];
  at: number;
  abstained: boolean;
  cause?: AbstentionCause | "budget";
  /** Tool calls or content requests in the output, ignored and noted. */
  ignored_request?: boolean;
  /** Round 2: a position change ignored for want of a valid citation. */
  ignored_change?: "no_citation" | "invalid_citation";
  assessment_key?: string;
}
/**
 * A member call's durable outcome. Lateness is decided when the call runs, so
 * a replayed review reaches the same result from the recorded outcome.
 */
export type CallOutcome =
  | {
      response: ModelResponse;
      at: number;
      /** Runner time of a self-hosted call. */
      seconds?: number;
    }
  | {
      error: "timeout" | "vendor_error" | "budget";
      at: number;
      /** Spent tokens of a late answer: counted, never shown. */
      usage?: { input_tokens: number; output_tokens: number };
      /** Runner time a failed or late self-hosted call still spent. */
      seconds?: number;
    };
export interface CouncilDeps {
  /** A durable absolute deadline `ms` from the first time `name` is asked for. */
  deadline(name: string, ms: number): Promise<number>;
  /**
   * One member call through the model gateway (or a self-hosted runner),
   * answering `timeout` when it ends after `deadline`; never throws.
   */
  complete(
    member: Member,
    name: string,
    request: MemberRequest,
    deadline: number,
  ): Promise<CallOutcome>;
  /** Run an experiment command as a runner job under verifier isolation. */
  run(
    name: string,
    command: string[],
    version: "base" | "head",
  ): Promise<ExecutionResult & { seconds?: number }>;
  put(key: string, value: unknown): Promise<string>;
}
export interface CouncilInput {
  review: string;
  /** Prompt settings: a member's partition, `council-order`, the cache key. */
  prompt?: {
    partition: (member: Member) => string | undefined;
    order: boolean;
    key?: (finding: string, role: Role) => string;
  };
  verified: Verified[];
  votes: (hypothesis: string) => Promise<Vote[]>;
  executions: Record<string, ExecutionResult>;
  graphs: { base: Graph; head: Graph };
  hops: number;
  files: (
    paths: string[],
  ) => Promise<Record<string, { base: string | null; head: string | null }>>;
  intent: string;
  guidance: Guidance[];
  /** Base path of each renamed file, by head path. */
  renames?: Record<string, string>;
  plan: Plan;
  changed: string[];
  nightly: boolean;
  fork: boolean;
  rules: { when: string }[];
  settings: CouncilSettings;
  /** Every configured member, in profile order; `total` in the markers. */
  members: Member[];
  composition: Composition;
  weights: Weights;
  /**
   * Where audit entries are collected; the caller records them even when the
   * step fails part-way, so no transfer goes unrecorded.
   */
  audit?: AuditEntry[];
}
export interface FindingCost {
  id: string;
  status: "complete" | "partial" | "skipped";
  answered: number;
  total: number;
  cost: {
    members: number;
    rounds: number;
    experiments: number;
    tokens: Record<string, number>;
    runner_seconds: number;
  };
}
export interface CouncilOutcome {
  /** Selected findings with their council block and decided evidence level. */
  verified: Verified[];
  metrics: {
    councilled: number;
    not_councilled: number;
    findings: FindingCost[];
    total: FindingCost["cost"];
  };
  audit: AuditEntry[];
  selection: { id: string; rule: string }[];
  /** Selected findings refuted by the council, kept for the council section. */
  refuted: string[];
}

const letters = "ABCDEFGHIJ";
/** Members' anonymized letters for one finding, in an order that hides roles. */
export function lettersFor(finding: string, roles: Role[]): Map<Role, string> {
  return new Map(
    [...roles]
      .sort((a, b) =>
        hash(`${finding}\0${a}`).localeCompare(hash(`${finding}\0${b}`)),
      )
      .map((role, i) => [role, letters[i]]),
  );
}

type Answered = { member: Member; assessment: Assessment };

/** Round-1 requests deduplicated by version and normalized command, chosen by weight. */
export function chooseExperiments(
  answered: { role: Role; weight: number; request?: ExperimentRequest }[],
  max: number,
): { chosen: ExperimentRequest[]; capped: ExperimentRequest[] } {
  const unique = new Map<
    string,
    { request: ExperimentRequest; weight: number; order: number }
  >();
  answered.forEach(({ request, weight }, order) => {
    if (!request) return;
    const key = `${request.version}\0${normalize(request.command)}`;
    const existing = unique.get(key);
    if (!existing) unique.set(key, { request, weight, order });
    else existing.weight = Math.max(existing.weight, weight);
  });
  const ranked = [...unique.values()].sort(
    (a, b) => b.weight - a.weight || a.order - b.order,
  );
  return {
    chosen: ranked.slice(0, max).map((r) => r.request),
    capped: ranked.slice(max).map((r) => r.request),
  };
}

/**
 * Apply a round-2 answer to a member's round-1 position: a change stands only
 * with a citation of an existing artifact or another member's letter.
 */
export function settle(
  first: Assessment,
  second: Assessment | null,
  known: Set<string>,
  ownLetter: string,
): { final: Assessment; ignored?: "no_citation" | "invalid_citation" } {
  if (!second) return { final: first };
  const changed =
    second.real !== first.real ||
    second.introduced_by_change !== first.introduced_by_change ||
    second.basis !== first.basis;
  // An unchanged position stands with the member's round-2 evidence, which
  // may correct a reference; a change needs a citation.
  if (!second.cites)
    return changed
      ? { final: first, ignored: "no_citation" }
      : { final: second };
  const valid =
    second.cites.kind === "artifact"
      ? known.has(second.cites.ref)
      : letters.includes(second.cites.ref) &&
        second.cites.ref.length === 1 &&
        second.cites.ref !== ownLetter &&
        known.has(`letter:${second.cites.ref}`);
  return valid
    ? { final: second }
    : { final: first, ignored: "invalid_citation" };
}

/** Strip tool-call shaped keys from a member's output; report whether any were present. */
function unwrap(content: string): { value: unknown; ignored: boolean } {
  let value: any;
  try {
    value = parseModelOutput(content);
  } catch {
    return { value: null, ignored: false };
  }
  if (value && typeof value === "object" && "result" in value)
    value = value.result;
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { value, ignored: false };
  const ignored = ["tools", "tool_calls", "requests", "read_file"].some(
    (k) => k in value,
  );
  if (ignored) {
    value = { ...value };
    for (const k of ["tools", "tool_calls", "requests", "read_file"])
      delete value[k];
  }
  return { value, ignored };
}

export async function runCouncil(
  input: CouncilInput,
  deps: CouncilDeps,
): Promise<CouncilOutcome> {
  const { settings, composition } = input;
  const selection = select(
    input.verified,
    input.rules,
    input.plan,
    input.changed,
    input.nightly,
    settings.max_findings,
  );
  const total = input.members.length;
  const budgetMs = parseWall(settings.timeout);
  const outcome: CouncilOutcome = {
    verified: [],
    metrics: {
      councilled: 0,
      not_councilled: selection.not_councilled.length,
      findings: [],
      total: {
        members: 0,
        rounds: 0,
        experiments: 0,
        tokens: {},
        runner_seconds: 0,
      },
    },
    audit: input.audit ?? [],
    selection: selection.selected.map((s) => ({
      id: s.verified.hypothesis.id,
      rule: s.rule,
    })),
    refuted: [],
  };
  for (const { verified } of selection.selected) {
    const h = verified.hypothesis;
    const category = verified.category ?? h.category;
    const weight = (m: Member) => weightOf(m, category, input.weights).weight;
    const tokens: Record<string, number> = {};
    const memberState = new Map<Role, { abstained: boolean; cause?: string }>();
    for (const m of input.members)
      memberState.set(m.role, { abstained: true, cause: "excluded" });
    for (const e of composition.excluded)
      memberState.set(e.role, {
        abstained: true,
        cause: e.denied_by === "runner" ? "unavailable" : "excluded",
      });
    for (const role of composition.author_family.dropped ?? [])
      memberState.set(role, { abstained: true, cause: "excluded" });
    // Built only when members will receive it: no pack without a transfer.
    let pack!: Pack;
    let packHash = "";
    let packBytes = 0;
    const participants = composition.participants;
    let rounds = 0;
    // Runner time of self-hosted calls, beside the experiments' own.
    let modelSeconds = 0;
    const answered: Answered[] = [];
    const call = async (
      member: Member,
      round: 1 | 2,
      content: MemberRequest,
      deadline: number,
    ): Promise<Assessment | null> => {
      // The audit hashes exactly what is sent: the rendering, and in round 2
      // the other assessments and the experiment results with it.
      const sent = `${content.system}\n${content.content}`;
      const entry: AuditEntry = {
        finding: h.id,
        member: member.role,
        round,
        vendor: member.self_hosted ? null : member.vendor,
        model: member.route ?? `${member.provider}/${member.model}`,
        pack_hash: packHash,
        pack_bytes: packBytes,
        rendering_hash: hash(sent),
        rendering_bytes: new TextEncoder().encode(sent).length,
        ...(content.parts
          ? {
              layers: layerHashes(content.parts.system, [
                { content: content.parts.content },
              ]),
            }
          : {}),
        at: 0,
        abstained: true,
      };
      outcome.audit.push(entry);
      const result = await deps.complete(
        member,
        `council-${h.id.slice(0, 16)}-${member.role}-r${round}`,
        { ...content, key: input.prompt?.key?.(h.id, member.role) },
        deadline,
      );
      entry.at = result.at;
      if ("seconds" in result && result.seconds) modelSeconds += result.seconds;
      const vendor = member.self_hosted ? "self-hosted" : member.vendor;
      if ("error" in result) {
        if (result.usage)
          tokens[vendor] =
            (tokens[vendor] ?? 0) +
            result.usage.input_tokens +
            result.usage.output_tokens;
        // A late answer is an abstention and is never shown to other members.
        entry.cause = result.error;
        return null;
      }
      const { response } = result;
      tokens[vendor] =
        (tokens[vendor] ?? 0) + response.input_tokens + response.output_tokens;
      const { value, ignored } = unwrap(response.content);
      if (ignored) entry.ignored_request = true;
      const validated = validateAssessment(
        value && typeof value === "object"
          ? { ...(value as object), member: member.role }
          : value,
        round,
      );
      entry.assessment_key = await deps.put(
        `reviews/${input.review}/council/${h.id}/${member.role}-r${round}.json`,
        validated,
      );
      if ("abstained" in validated) {
        entry.cause = validated.abstained;
        return null;
      }
      entry.abstained = false;
      return validated.assessment;
    };
    const finish = (review: CouncilReview, level = verified.evidence_level) => {
      const status = review.skipped
        ? "skipped"
        : review.partial
          ? "partial"
          : "complete";
      const runnerSeconds =
        modelSeconds + experiments.reduce((n, e) => n + (e.seconds ?? 0), 0);
      const cost = {
        members: participants.length,
        rounds,
        experiments: experiments.filter((e) => e.run).length,
        tokens,
        runner_seconds: Math.ceil(runnerSeconds),
      };
      outcome.metrics.findings.push({
        id: h.id,
        status,
        answered: review.answered,
        total,
        cost,
      });
      const t = outcome.metrics.total;
      t.members += cost.members;
      t.rounds += cost.rounds;
      t.experiments += cost.experiments;
      t.runner_seconds += cost.runner_seconds;
      for (const [vendor, n] of Object.entries(tokens))
        t.tokens[vendor] = (t.tokens[vendor] ?? 0) + n;
      outcome.metrics.councilled++;
      if (level === "refuted") outcome.refuted.push(h.id);
      outcome.verified.push({
        ...verified,
        evidence_level: level,
        council: review,
      });
    };
    const experiments: (CouncilReview["experiments"][number] & {
      id?: string;
      seconds?: number;
      runs?: Experiment["runs"];
      outputs?: Record<string, { exit_code: number; contains_found?: boolean }>;
      contains?: string;
    })[] = [];
    // Families and per-round answers are presentation detail: the decision
    // never reads them.
    const families = new Map(input.members.map((m) => [m.role, m.family]));
    const roundsOf = new Map<Role, CouncilRound[]>();
    const answeredIn = (role: Role, round: CouncilRound) =>
      roundsOf.set(role, [...(roundsOf.get(role) ?? []), round]);
    const membersOf = () =>
      ROLES.filter((role) => memberState.has(role)).map((role) => {
        const { abstained, cause } = memberState.get(role)!;
        const family = families.get(role);
        const rounds = roundsOf.get(role);
        return {
          role,
          abstained,
          ...(abstained && cause ? { cause } : {}),
          ...(family ? { family } : {}),
          ...(rounds?.length ? { rounds } : {}),
        };
      });
    const common = {
      // Learned weights are looked up and estimated under this category.
      // Selection excludes style and diagnostic findings.
      weight_category: category as "defect" | "risk" | "security",
      ...(input.fork ? { static_only: true } : {}),
      author_family: composition.author_family,
      ...(composition.excluded.length
        ? { excluded: composition.excluded }
        : {}),
    };
    if (participants.length < settings.min_members) {
      // Fewer members could take part than the minimum: no call is made.
      finish({
        members: membersOf(),
        experiments: [],
        partial: false,
        skipped: true,
        answered: 0,
        total,
        ...common,
      });
      continue;
    }
    ({
      pack,
      hash: packHash,
      bytes: packBytes,
    } = buildPack({
      verified,
      finding: h.id,
      votes: await input.votes(h.id),
      executions: input.executions,
      graphs: input.graphs,
      hops: input.hops,
      files: await input.files(affectedPaths(h, verified.locations)),
      renames: input.renames,
      intent: input.intent,
      guidance: input.guidance,
    }));
    // The pack itself is an artifact under evidence retention.
    await deps.put(
      `reviews/${input.review}/council/${h.id}/pack-${packHash}.json`,
      pack,
    );
    // Round 1: every participant in parallel within the step's wall budget.
    rounds = 1;
    const deadline = await deps.deadline(
      `council-${h.id.slice(0, 16)}-r1`,
      budgetMs,
    );
    const renderings = new Map(
      participants.map((m) => [
        m.role,
        render(pack, m.context_pack, input.fork),
      ]),
    );
    const first = await Promise.all(
      participants.map(async (m) => {
        const rendering = renderings.get(m.role)!.text;
        const prompt = (prompts as Record<string, string>)[m.role];
        return {
          member: m,
          assessment: await call(
            m,
            1,
            memberRequest(m.role, prompt, rendering, 1, undefined, undefined, {
              partition: input.prompt?.partition(m),
              order: input.prompt?.order,
            }),
            deadline,
          ),
        };
      }),
    );
    for (const { member, assessment } of first) {
      const cause = assessment
        ? undefined
        : outcome.audit.find(
            (a) =>
              a.finding === h.id && a.member === member.role && a.round === 1,
          )?.cause;
      memberState.set(member.role, { abstained: !assessment, cause });
      answeredIn(
        member.role,
        assessment
          ? { round: 1, real: assessment.real }
          : { round: 1, cause: cause ?? "invalid" },
      );
      if (assessment) answered.push({ member, assessment });
    }
    if (answered.length < settings.min_members) {
      finish({
        members: membersOf(),
        experiments: [],
        partial: false,
        skipped: true,
        answered: answered.length,
        total,
        ...common,
      });
      continue;
    }
    // Experiments: one request per member, deduplicated, chosen by weight.
    const requests = answered.map((a) => ({
      role: a.member.role,
      weight: weight(a.member),
      request: a.assessment.experiment_request,
    }));
    const { chosen, capped } = input.fork
      ? { chosen: [], capped: [] }
      : chooseExperiments(requests, settings.max_experiments);
    if (input.fork)
      for (const r of requests)
        if (r.request)
          experiments.push({
            ...requested(r.request),
            run: false,
            reason: "fork",
          });
    for (const [i, request] of chosen.entries()) {
      const id = `exp-${i + 1}`;
      const versions =
        request.version === "both"
          ? (["base", "head"] as const)
          : [request.version];
      const runs: Experiment["runs"] = {};
      const outputs: Record<
        string,
        { exit_code: number; contains_found?: boolean }
      > = {};
      let seconds = 0;
      let artifact: string | undefined;
      let unavailable = false;
      for (const version of versions) {
        let result: Awaited<ReturnType<CouncilDeps["run"]>>;
        try {
          result = await deps.run(
            `council-${h.id.slice(0, 16)}-${id}-${version}`,
            request.command,
            version,
          );
        } catch {
          // A lost runner or an exhausted wall budget costs the experiment,
          // never the review.
          unavailable = true;
          break;
        }
        // A failed run's time is still spent.
        seconds += result.seconds ?? 0;
        if (result.outcome === "runner_failed") {
          unavailable = true;
          break;
        }
        // Members see the exit code and whether an expected text appeared,
        // never the output itself: a command could print files the pack
        // leaves out. The output stays in storage under its reference.
        outputs[version] = {
          exit_code: result.exit_code,
          ...(request.expect === "output_contains" && request.contains
            ? {
                contains_found: `${result.stdout}\n${result.stderr}`.includes(
                  request.contains,
                ),
              }
            : {}),
        };
        artifact = await deps.put(
          `reviews/${input.review}/council/${h.id}/${id}-${version}.json`,
          result,
        );
        // Reproduction is decided by exit codes only, whatever the expectation.
        runs[version] = {
          exit_code: result.exit_code,
          outcome: result.outcome,
          timed_out: result.timed_out,
          truncated: result.truncated,
        } satisfies ExperimentRun;
      }
      if (unavailable) {
        // What did run is still runner time spent.
        experiments.push({
          ...requested(request),
          run: false,
          reason: "runner_unavailable",
          seconds,
        });
        continue;
      }
      experiments.push({
        id,
        command: request.command,
        version: request.version,
        expect: request.expect,
        ...(request.contains ? { contains: request.contains } : {}),
        run: true,
        outcome: Object.fromEntries(
          Object.entries(runs).map(([v, r]) => [
            v,
            r!.exit_code === 0 && r!.outcome === "exited" && !r!.timed_out
              ? "passed"
              : "failed",
          ]),
        ),
        ...(artifact ? { artifact: id } : {}),
        seconds,
        runs,
        outputs,
      });
    }
    for (const request of capped)
      experiments.push({ ...requested(request), run: false, reason: "cap" });
    // Round 2: anonymized round-1 assessments and experiment results.
    const finals = new Map<Role, Assessment>(
      answered.map((a) => [a.member.role, a.assessment]),
    );
    if (settings.max_rounds >= 2) {
      rounds = 2;
      const letter = lettersFor(
        h.id,
        answered.map((a) => a.member.role),
      );
      // The timeout bounds a finding's two rounds together; experiment run
      // time is bounded by the runner's own limits and is not counted.
      const started = deadline - budgetMs;
      const used = Math.min(
        budgetMs,
        Math.max(
          0,
          ...outcome.audit
            .filter((a) => a.finding === h.id && a.round === 1)
            .map((a) => a.at - started),
        ),
      );
      const roundTwo = await deps.deadline(
        `council-${h.id.slice(0, 16)}-r2`,
        budgetMs - used,
      );
      const ran = experiments.filter((e) => e.run && e.id);
      const known = artifactIds(pack, ran as { id: string }[]);
      for (const l of letter.values()) known.add(`letter:${l}`);
      const results = ran.map((e) => ({
        id: e.id,
        command: e.command,
        version: e.version,
        expect: e.expect,
        ...(e.contains ? { contains: e.contains } : {}),
        outcome: e.outcome,
        runs: e.outputs,
      }));
      const second = await Promise.all(
        answered.map(async ({ member, assessment }) => {
          const own = letter.get(member.role)!;
          const others = answered
            .filter((o) => o.member.role !== member.role)
            .map((o) => {
              const {
                member: _,
                experiment_request: __,
                ...rest
              } = o.assessment;
              return { letter: letter.get(o.member.role)!, assessment: rest };
            })
            .sort((a, b) => a.letter.localeCompare(b.letter));
          const rendering = renderings.get(member.role)!.text;
          const request = memberRequest(
            member.role,
            (prompts as Record<string, string>)[member.role],
            rendering,
            2,
            { others, experiments: results },
            assessment,
            {
              partition: input.prompt?.partition(member),
              order: input.prompt?.order,
            },
          );
          const answer = await call(member, 2, request, roundTwo);
          const settled = settle(assessment, answer, known, own);
          answeredIn(
            member.role,
            answer
              ? {
                  round: 2,
                  real: settled.final.real,
                  ...(settled.final !== assessment &&
                  settled.final.real !== assessment.real
                    ? { changed: true }
                    : {}),
                }
              : {
                  round: 2,
                  cause:
                    outcome.audit.findLast(
                      (a) =>
                        a.finding === h.id &&
                        a.member === member.role &&
                        a.round === 2,
                    )?.cause ?? "invalid",
                },
          );
          if (settled.ignored) {
            const entry = outcome.audit.findLast(
              (a) =>
                a.finding === h.id && a.member === member.role && a.round === 2,
            );
            if (entry) entry.ignored_change = settled.ignored;
          }
          return { role: member.role, final: settled.final };
        }),
      );
      for (const { role, final } of second) finals.set(role, final);
    }
    const positions: Position[] = answered.map(({ member }) => ({
      role: member.role,
      weight: weight(member),
      assessment: finals.get(member.role)!,
    }));
    const decision = aggregate(
      positions,
      experiments
        .filter((e) => e.run && e.id && e.runs)
        .map((e) => ({
          id: e.id!,
          request: { command: e.command, version: e.version, expect: e.expect },
          runs: e.runs!,
        })),
      pack,
      verified.evidence_level,
    );
    finish(
      {
        decision: decision.decision,
        tier: decision.tier,
        members: membersOf(),
        experiments: experiments.map(
          ({
            id: _,
            seconds: __,
            runs: ___,
            outputs: ____,
            contains: _____,
            ...e
          }) => e,
        ),
        note: decision.note,
        ...(decision.protection ? { protection: decision.protection } : {}),
        partial: answered.length < total,
        answered: answered.length,
        total,
        ...common,
      },
      decision.evidence_level,
    );
  }
  return outcome;
}

/** The finding ids a council outcome changed, for event logs: hashes only. */
export function auditSummary(audit: AuditEntry[]): string {
  return audit
    .map(
      (a) =>
        `${a.finding.slice(0, 12)} ${a.member} r${a.round} ${a.vendor ?? "self-hosted"} ${a.pack_hash.slice(0, 12)} ${a.abstained ? `abstained:${a.cause}` : "answered"}`,
    )
    .join("\n");
}
export type { Pack, Profile };

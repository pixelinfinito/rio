import type { ValidateFunction, ErrorObject } from "ajv";
import * as validators from "./validators.generated.js";
import stepSchemas from "./step-schemas.json";
import { blake3 } from "@noble/hashes/blake3.js";
import type {
  Graph,
  Hypothesis,
  LineageRef,
  Location,
  Submission,
  VoteAnswer,
} from "./types";
const profileValidator = validators.profile;
const reportValidator = validators.report;
const findingValidator = validators.finding;
const hypothesisValidator = validators.hypothesis,
  answerValidator = validators.answer;
const ajv = {
  errorsText: (errors?: ErrorObject[] | null) =>
    errors?.map((e) => `${e.instancePath} ${e.message}`).join(", ") ?? "",
};
const moduleValidators = new Map(
  Object.entries(stepSchemas).map(([name], i) => [
    name,
    (validators as Record<string, ValidateFunction<any>>)[`module${i}`],
  ]),
);
export function validateVerification(value: any): void {
  invariant(
    value &&
      Number.isInteger(value.voters) &&
      value.voters > 0 &&
      Number.isInteger(value.agreeing) &&
      value.agreeing >= 0 &&
      value.agreeing <= value.voters &&
      Array.isArray(value.blind_match) &&
      value.blind_match.length === value.voters &&
      value.blind_match.every((m: string) =>
        ["same", "related", "none"].includes(m),
      ) &&
      typeof value.split === "boolean",
    "invalid verification counts",
  );
}
export function validateReport(value: any): void {
  invariant(
    reportValidator(value),
    `invalid report: ${ajv.errorsText(reportValidator.errors)}`,
  );
  for (const f of [
    ...value.findings,
    ...value.risks,
    ...(value.security ?? []),
    ...value.checks.flatMap((c: any) => c.findings ?? []),
  ])
    if (f.verification) validateVerification(f.verification);
}
export function validateFinding(value: any): void {
  invariant(
    findingValidator(value),
    `invalid finding: ${ajv.errorsText(findingValidator.errors)}`,
  );
  if (value.verification) validateVerification(value.verification);
}
export const RESPONSE_REASONS = [
  "fixed",
  "wrong",
  "intentional",
  "irrelevant",
  "style",
] as const;
const LINEAGE_KEYS = ["repository", "kind", "ref", "reset"];
// Lineage keys are client-chosen strings; they are bounded and free of control characters.
export function validateLineageRef(
  value: any,
  allowReset = true,
): asserts value is LineageRef {
  invariant(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).every(
        (k) => LINEAGE_KEYS.includes(k) && (allowReset || k !== "reset"),
      ),
    "invalid lineage",
  );
  for (const key of ["repository", "ref"])
    invariant(
      typeof value[key] === "string" &&
        value[key].length > 0 &&
        value[key].length <= 1024 &&
        !/[\u0000-\u001f\u007f]/.test(value[key]),
      `invalid lineage ${key}`,
    );
  invariant(["pr", "branch"].includes(value.kind), "invalid lineage kind");
  invariant(
    value.kind !== "pr" || /^[1-9][0-9]{0,18}$/.test(value.ref),
    "invalid lineage ref: a pr lineage uses the PR number",
  );
  invariant(
    value.reset === undefined || typeof value.reset === "boolean",
    "invalid lineage reset",
  );
}
export function invariant(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
export function hash(value: string): string {
  return Array.from(blake3(new TextEncoder().encode(value)), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
}
export function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function safePath(path: unknown): asserts path is string {
  invariant(
    typeof path === "string" &&
      path.length > 0 &&
      path.length < 4096 &&
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.includes("\0") &&
      !/^[A-Za-z]:/.test(path) &&
      path.split("/").every((x) => x !== ".." && x !== "." && x !== ""),
    "invalid repository path",
  );
}
/**
 * `lines` maps each regular (non-link) file a node may cite to its line count.
 */
export function validateGraph(graph: Graph, lines: Map<string, number>) {
  invariant(
    graph &&
      Array.isArray(graph.nodes) &&
      graph.nodes.length <= 100000 &&
      Array.isArray(graph.edges) &&
      graph.edges.length <= 500000,
    "invalid graph",
  );
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    safePath(node.path);
    invariant(
      !ids.has(node.id) &&
        typeof node.symbol_path === "string" &&
        lines.has(node.path) &&
        Number.isInteger(node.line_start) &&
        node.line_start > 0 &&
        node.line_end >= node.line_start &&
        node.line_end <= lines.get(node.path)!,
      "invalid graph node",
    );
    ids.add(node.id);
  }
  invariant(
    graph.edges.every((e) => ids.has(e.from) && ids.has(e.to)),
    "invalid graph edge",
  );
}
export function validateSubmission(value: any): asserts value is Submission {
  invariant(value?.protocol === 1, "unsupported protocol");
  // Resolved-only metadata is outside the source profile schema.
  const { chain, modules, engine_version, posture_policy, ...source } =
    value.profile ?? {};
  invariant(
    profileValidator(source),
    `invalid profile: ${ajv.errorsText(profileValidator.errors)}`,
  );
  validateReport(value.report);
  const ids = new Set<string>();
  for (const step of value.profile.steps) {
    invariant(
      !ids.has(step.id) &&
        Array.isArray(step.needs) &&
        step.with &&
        typeof step.with === "object",
      "invalid resolved step",
    );
    ids.add(step.id);
    const validator = moduleValidators.get(step.uses);
    invariant(
      validator && validator(step.with),
      `invalid step options: ${step.id}`,
    );
  }
  const done = new Set<string>();
  while (done.size < ids.size) {
    const ready = value.profile.steps.filter(
      (s: any) =>
        !done.has(s.id) && s.needs.every((id: string) => done.has(id)),
    );
    invariant(ready.length, "invalid profile DAG");
    for (const s of ready) done.add(s.id);
  }
  const depends = (from: string, target: string): boolean =>
    from === target ||
    value.profile.steps
      .find((s: any) => s.id === from)
      .needs.some((n: string) => depends(n, target));
  for (const step of value.profile.steps)
    if (
      (step.uses.startsWith("rio/agents@") ||
        step.uses.startsWith("rio/security@")) &&
      step.with.enabled !== false
    )
      invariant(
        value.profile.steps.some(
          (v: any) =>
            v.uses.startsWith("rio/verify@") && depends(v.id, step.id),
        ),
        "verifier is mandatory for hypothesis producers",
      );
  invariant(
    Array.isArray(value.changed) &&
      value.changed.length <= 100000 &&
      typeof value.intent === "string" &&
      value.intent.length <= 65536 &&
      typeof value.fork === "boolean" &&
      ["fast", "deep"].includes(value.mode),
    "invalid review",
  );
  invariant(
    Array.isArray(value.owner_guidance) && value.owner_guidance.length <= 10000,
    "invalid guidance",
  );
  invariant(
    value.profile.verify?.voters >= 1 &&
      value.profile.verify.quorum >= 1 &&
      value.profile.verify.quorum <= value.profile.verify.voters,
    "invalid quorum",
  );
  const alias =
    value.profile.verify.model ??
    (value.profile.models.verifier ? "verifier" : "default");
  invariant(
    !value.profile.verify.model || value.profile.models[alias],
    "unknown verifier alias",
  );
  invariant(
    value.profile.verify.voters !== 1 ||
      value.profile.models[alias] !== value.profile.models.default,
    "single verifier must use a different model",
  );
  for (const file of value.changed) {
    safePath(file.path);
    if (file.old_path) safePath(file.old_path);
  }
  invariant(
    typeof value.snapshot_id === "string" &&
      /^[a-f0-9]{64}$/.test(value.snapshot_id),
    "invalid snapshot id",
  );
  if (value.lineage !== undefined) validateLineageRef(value.lineage);
  invariant(
    value.repository === undefined ||
      (typeof value.repository === "string" &&
        value.repository.length > 0 &&
        value.repository.length <= 512 &&
        !/[\u0000-\u001f]/.test(value.repository)),
    "invalid repository",
  );
}
export function validateHypotheses(value: any): Hypothesis[] {
  invariant(
    Array.isArray(value) && value.length <= 100,
    "expected hypothesis array",
  );
  return value.map((h) => {
    invariant(
      hypothesisValidator(h),
      `malformed hypothesis: ${ajv.errorsText(hypothesisValidator.errors)}`,
    );
    invariant(
      h &&
        typeof h.rule_id === "string" &&
        /^[a-z0-9_/-]{1,150}$/i.test(h.rule_id) &&
        typeof h.trigger === "string" &&
        typeof h.message === "string" &&
        typeof h.location?.symbol_path === "string",
      "malformed hypothesis",
    );
    invariant(
      ["defect", "risk", "security", "style", "diagnostic"].includes(
        h.category,
      ) && ["error", "warning", "info"].includes(h.severity),
      "invalid hypothesis category or severity",
    );
    safePath(h.location.path);
    invariant(
      Number.isInteger(h.location.line_start) &&
        h.location.line_start > 0 &&
        Number.isInteger(h.location.line_end) &&
        h.location.line_end >= h.location.line_start,
      "invalid location",
    );
    invariant(!("confidence" in h), "confidence is not evidence");
    const location = {
      ...h.location,
      occurrence_state: h.location.occurrence_state ?? "new",
    };
    // Cited locations keep the primary first and never repeat a location.
    let locations: Location[] | undefined;
    if (h.locations) {
      locations = [location];
      for (const l of h.locations) {
        safePath(l.path);
        invariant(l.line_end >= l.line_start, "invalid location");
        if (
          !locations.some(
            (x) =>
              x.path === l.path &&
              x.line_start === l.line_start &&
              x.line_end === l.line_end,
          )
        )
          locations.push({
            ...l,
            occurrence_state: l.occurrence_state ?? "new",
          });
      }
    }
    return {
      ...h,
      id: hash(
        `${h.rule_id}\0${h.location.path}\0${h.location.symbol_path}\0${normalizeTrigger(h.trigger)}`,
      ),
      state: h.state ?? "new",
      source: { agent: h.source?.agent ?? "correctness" },
      location,
      ...(locations ? { locations } : {}),
    };
  });
}
/**
 * Bounds the list-valued agent keys to the hypothesis schema's limits, so one
 * hypothesis citing many consumers is trimmed instead of failing the agent's
 * whole output. Anything else is left for schema validation.
 */
export function clampAgentOutput(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((h) => {
    if (!h || typeof h !== "object" || Array.isArray(h)) return h;
    const out: any = { ...h };
    if (Array.isArray(out.locations))
      out.locations = out.locations.slice(0, 20);
    if (Array.isArray(out.limitations))
      out.limitations = out.limitations
        .slice(0, 20)
        .map((l: unknown) => (typeof l === "string" ? l.slice(0, 1000) : l));
    return out;
  });
}
export const CONTRACT_KINDS = [
  "signature",
  "route",
  "schema",
  "migration",
  "format",
  "cli",
  "env",
  "config",
] as const;
export const CONTRACT_BREAKS = [
  "removed",
  "changed",
  "added_required",
  "semantics",
] as const;
const CONTRACT_RULE = new RegExp(
  `^contracts/(?:${CONTRACT_KINDS.join("|")})/(?:${CONTRACT_BREAKS.join("|")})$`,
);
export const NO_CONSUMER =
  "No consumer was found in the repository; only consumers outside the repository could be affected.";
export interface Rejection {
  agent: string;
  id: string;
  rule_id: string;
  reason: string;
}
/**
 * Agent-specific rules applied to each validated hypothesis. A violation
 * discards that hypothesis with an audit entry; the others are kept.
 */
export function screenHypotheses(
  agent: string,
  hypotheses: Hypothesis[],
  options: { catalogItems?: Set<string> } = {},
): { accepted: Hypothesis[]; rejected: Rejection[] } {
  const accepted: Hypothesis[] = [],
    rejected: Rejection[] = [];
  const reject = (h: Hypothesis, reason: string) =>
    rejected.push({ agent, id: h.id, rule_id: h.rule_id, reason });
  for (const h of hypotheses) {
    if (agent === "contracts") {
      if (!CONTRACT_RULE.test(h.rule_id)) {
        reject(h, "rule id outside contracts/<kind>/<break>");
        continue;
      }
      if (h.category === "style" || h.category === "security") {
        reject(h, `category ${h.category} is not a contract hypothesis`);
        continue;
      }
      // Producer plus at least one consumer, or a risk that says none exists.
      const cited = h.locations?.length ?? 1;
      if (cited < 2 && h.category === "defect") {
        reject(h, "a contract defect needs the producer and a consumer");
        continue;
      }
      if (cited < 2 && h.category === "risk") {
        const text = `${h.message} ${h.impact ?? ""}`.toLowerCase();
        if (!/no consumer/.test(text))
          h.impact = h.impact ? `${h.impact} ${NO_CONSUMER}` : NO_CONSUMER;
      }
    }
    if (agent === "security") {
      if (h.category !== "security" && h.category !== "diagnostic") {
        reject(
          h,
          `security hypotheses have category security, not ${h.category}`,
        );
        continue;
      }
      if (h.category === "security" && !h.catalog_item) {
        reject(h, "security hypothesis without catalog_item");
        continue;
      }
      if (
        h.category === "security" &&
        options.catalogItems &&
        !options.catalogItems.has(h.catalog_item!)
      ) {
        reject(
          h,
          `catalog item ${h.catalog_item} is not applicable to this change`,
        );
        continue;
      }
      if (h.category === "security" && !h.trace_change) {
        reject(h, "security hypothesis without trace_change");
        continue;
      }
    }
    accepted.push(h);
  }
  return { accepted, rejected };
}
export function normalizeTrigger(trigger: string): string {
  return trigger.trim().replace(/\s+/g, " ");
}
export function validateAnswer(value: any): VoteAnswer {
  invariant(
    answerValidator(value),
    `malformed vote: ${ajv.errorsText(answerValidator.errors)}`,
  );
  invariant(
    value &&
      ["refuted", "plausible", "static_proven", "reproduced"].includes(
        value.evidence_level,
      ) &&
      Array.isArray(value.evidence) &&
      value.evidence.length <= 100 &&
      !("confidence" in value),
    "malformed vote",
  );
  for (const ref of value.evidence)
    invariant(
      ["execution", "code"].includes(ref.kind) &&
        ["base", "head"].includes(ref.version) &&
        ["regression", "protection"].includes(ref.demonstrates),
      "malformed evidence",
    );
  if (value.category)
    invariant(
      ["defect", "risk", "security", "style", "diagnostic"].includes(
        value.category,
      ),
      "invalid vote category",
    );
  return value;
}

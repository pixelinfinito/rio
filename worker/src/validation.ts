import type { ValidateFunction, ErrorObject } from "ajv";
import * as validators from "./validators.generated.js";
import stepSchemas from "./step-schemas.json";
import { blake3 } from "@noble/hashes/blake3.js";
import type {
  Graph,
  Hypothesis,
  Snapshot,
  Submission,
  VoteAnswer,
} from "./types";
const profileValidator = validators.profile;
const reportValidator = validators.report;
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
export function validateSnapshot(value: any): asserts value is Snapshot {
  invariant(
    value && typeof value === "object" && value.base && value.head,
    "base and head required",
  );
  let bytes = 0,
    count = 0;
  for (const tree of [value.base, value.head]) {
    invariant(typeof tree === "object" && !Array.isArray(tree), "invalid tree");
    for (const [path, file] of Object.entries<any>(tree)) {
      safePath(path);
      invariant(
        file &&
          typeof file.content === "string" &&
          [0o100644, 0o100755, 0o120000].includes(file.mode),
        "invalid file",
      );
      bytes += new TextEncoder().encode(file.content).length;
      count++;
    }
  }
  invariant(
    bytes <= 32 * 1024 * 1024 && count <= 100000,
    "snapshot limit exceeded",
  );
}
export function validateGraph(graph: Graph, tree: Snapshot["head"]) {
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
        tree[node.path] &&
        tree[node.path].mode !== 0o120000 &&
        Number.isInteger(node.line_start) &&
        node.line_start > 0 &&
        node.line_end >= node.line_start &&
        node.line_end <= tree[node.path].content.split("\n").length,
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
    return {
      ...h,
      id: hash(
        `${h.rule_id}\0${h.location.path}\0${h.location.symbol_path}\0${normalizeTrigger(h.trigger)}`,
      ),
      state: h.state ?? "new",
      source: { agent: h.source?.agent ?? "correctness" },
      location: {
        ...h.location,
        occurrence_state: h.location.occurrence_state ?? "new",
      },
    };
  });
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

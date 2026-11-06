import type { Hypothesis, Profile, Snapshot, Submission } from "../src/types";
export const snapshot: Snapshot = {
  base: {
    "src/a.ts": { mode: 0o100644, content: "function a(){ return 0; }\n" },
    "lib/b.ts": { mode: 0o100644, content: "export const b = 1;\n" },
    "AGENTS.md": { mode: 0o100644, content: "Keep the command working.\n" },
  },
  head: {
    "src/a.ts": {
      mode: 0o100644,
      content: "function a(){ throw new Error(); }\n",
    },
    "lib/b.ts": { mode: 0o100644, content: "export const b = 2;\n" },
    "AGENTS.md": { mode: 0o100644, content: "Keep the command working.\n" },
  },
};
export const profile: Profile = {
  version: 1,
  name: "test",
  models: { default: "openai/test", verifier: "anthropic/test" },
  steps: [],
  budget: { fast: { wall_time: "4m", tokens: 100000, agents_max: 3 } },
  verify: { voters: 3, quorum: 2 },
  posture: "balanced",
  min_evidence: "static_proven",
  max_defects: 5,
  suppress: [],
  always_human: [],
  fail_on: {
    evidence: "static_proven",
    categories: ["defect"],
    states: ["new", "worsened"],
  },
  posture_policy: {
    defect_severity_floor: "warning",
    render_plausible_risks: true,
    plausible_risk_limit: 5,
  },
};
export const hypothesis: Hypothesis = {
  id: "h",
  rule_id: "correctness/throw",
  category: "defect",
  severity: "error",
  location: {
    path: "src/a.ts",
    line_start: 1,
    line_end: 1,
    symbol_path: "a",
    occurrence_state: "new",
  },
  message: "The call now throws",
  trigger: "a()",
  impact: "Callers fail",
  state: "new",
  source: { agent: "correctness" },
};
export const graphs = {
  base: {
    nodes: [
      {
        id: "b",
        path: "src/a.ts",
        symbol_path: "a",
        line_start: 1,
        line_end: 1,
      },
    ],
    edges: [],
  },
  head: {
    nodes: [
      {
        id: "h",
        path: "src/a.ts",
        symbol_path: "a",
        line_start: 1,
        line_end: 1,
      },
    ],
    edges: [],
  },
};
export function submission(): Submission {
  return {
    protocol: 1,
    snapshot_id: "a".repeat(64),
    profile: structuredClone(profile),
    report: {
      schema: "rio-report-v1",
      status: "complete",
      review: { rio_version: "0.2.0" },
      risk_tier: null,
      checks: [],
      impact: { symbols: [], unresolved: 0, truncated: false },
      findings: [],
      risks: [],
      incomplete: [],
      deferred: [],
      excluded: [],
      summary: { pre_existing: 0, fixed: 0, suppressed: 0 },
      footer: { notes: [], suppressions: [], tool_versions: {} },
      metrics: { wall_time_ms: 0, checks: [], tool_versions: {} },
    },
    changed: [{ path: "src/a.ts", lines_changed: 1 }],
    graphs,
    owner_guidance: [],
    intent: "Preserve a behavior",
    fork: false,
    mode: "fast",
  };
}

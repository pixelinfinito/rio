import { describe, expect, it } from "vitest";
import { validateAssessment } from "../src/council";
import { evaluate, type Plan } from "../src/triage";
import { validateFinding, validateReport } from "../src/validation";
import finding from "../../crates/rio-core/tests/fixtures/finding.json";
import complete from "../../crates/rio-core/tests/fixtures/complete.json";

// The examples from the council-members spec.
const roundOne = {
  member: "tester",
  round: 1,
  real: "yes",
  introduced_by_change: "unknown",
  impact: "A missing token lets an anonymous caller read another account.",
  basis: "static_path",
  evidence_refs: ["graph-1"],
};
const roundTwo = {
  ...roundOne,
  round: 2,
  real: "no",
  changed_from: { real: "yes" },
  changed_to: { real: "no" },
  cites: { kind: "assessment", ref: "B", reason_code: "missing_protection" },
};

describe("council-assessment-v1", () => {
  it("accepts the round-1 and round-2 examples", () => {
    expect(validateAssessment(roundOne, 1)).toEqual({ assessment: roundOne });
    expect(validateAssessment(roundTwo, 2)).toEqual({ assessment: roundTwo });
    const withRequest = {
      ...roundOne,
      experiment_request: {
        command: ["npm", "test", "--", "auth"],
        version: "head",
        expect: "fails",
      },
    };
    expect(validateAssessment(withRequest, 1)).toEqual({
      assessment: withRequest,
    });
  });

  it("abstains on empty evidence refs with its own cause", () => {
    expect(validateAssessment({ ...roundOne, evidence_refs: [] }, 1)).toEqual({
      abstained: "no_evidence_refs",
    });
  });

  it("rejects a round above 2, an unknown reason code and extra prose", () => {
    expect(validateAssessment({ ...roundOne, round: 3 }, 1)).toMatchObject({
      abstained: "invalid",
    });
    expect(validateAssessment({ ...roundTwo, round: 3 }, 2)).toMatchObject({
      abstained: "invalid",
    });
    expect(
      validateAssessment(
        { ...roundTwo, cites: { ...roundTwo.cites, reason_code: "vibes" } },
        2,
      ),
    ).toMatchObject({ abstained: "invalid" });
    expect(
      validateAssessment({ ...roundOne, reasoning: "because" }, 1),
    ).toMatchObject({ abstained: "invalid" });
    expect(
      validateAssessment({ ...roundOne, member: "judge" }, 1),
    ).toMatchObject({ abstained: "invalid" });
  });

  it("rejects change fields in round 1 and partial change fields in round 2", () => {
    expect(validateAssessment({ ...roundTwo, round: 1 }, 1)).toMatchObject({
      abstained: "invalid",
    });
    const { cites: _, ...uncited } = roundTwo;
    expect(validateAssessment(uncited, 2)).toMatchObject({
      abstained: "invalid",
    });
  });

  it("drops a round-2 or malformed request and keeps the assessment", () => {
    const request = {
      command: ["make", "test"],
      version: "both",
      expect: "fails",
    };
    expect(
      validateAssessment({ ...roundTwo, experiment_request: request }, 2),
    ).toEqual({ assessment: roundTwo, dropped_request: "round_2" });
    expect(
      validateAssessment(
        {
          ...roundOne,
          experiment_request: { command: ["make"], version: "head" },
        },
        1,
      ),
    ).toEqual({ assessment: roundOne, dropped_request: "invalid" });
    expect(
      validateAssessment(
        {
          ...roundOne,
          experiment_request: { ...request, expect: "output_contains" },
        },
        1,
      ),
    ).toEqual({ assessment: roundOne, dropped_request: "invalid" });
  });
});

describe("council rule predicates", () => {
  const plan = {
    risk: { tier: "high", reasons: [], source: "triage" },
    require_human: false,
    mode: "fast",
    agents: [],
    agent_reasons: {},
    suggested_focus: [],
    signals: { adds_dependency: false, lines_changed: 1, languages: [] },
  } as Plan;
  const finding = {
    evidence_level: "plausible",
    severity: "error" as const,
    split: false,
  };

  it("evaluates the five default triggers", () => {
    const rule = (when: string, context = {}) =>
      evaluate(when, plan, [], { finding, ...context });
    expect(rule("evidence == plausible and severity >= error")).toBe(true);
    expect(
      rule("severity >= error", {
        finding: { ...finding, severity: "warning" },
      }),
    ).toBe(false);
    expect(rule("severity >= warning")).toBe(true);
    expect(rule("verify.split")).toBe(false);
    expect(rule("verify.split", { finding: { ...finding, split: true } })).toBe(
      true,
    );
    expect(rule("risk_tier == high")).toBe(true);
    expect(rule("risk_tier == low")).toBe(false);
    expect(rule("mode == deep")).toBe(false);
    expect(rule("mode == fast")).toBe(true);
    expect(rule("nightly")).toBe(false);
    expect(rule("nightly", { nightly: true })).toBe(true);
  });

  it("refuses finding-level predicates without a finding", () => {
    expect(() => evaluate("evidence == plausible", plan, [])).toThrow(
      "evidence is a predicate allowed only in the council step's rules",
    );
    expect(evaluate("risk_tier == high or nightly", plan, [])).toBe(true);
  });
});

describe("finding-v1 and report-v1 council keys", () => {
  const council = {
    decision: "plausible",
    tier: "judgment",
    members: [
      { role: "skeptic", abstained: false },
      { role: "tester", abstained: true, cause: "timeout" },
    ],
    experiments: [],
    note: "Two members cited a static path; the skeptic found no protection.",
    partial: false,
    answered: 5,
    total: 5,
  };
  it("accepts findings with and without the block", () => {
    expect(() => validateFinding(structuredClone(finding))).not.toThrow();
    expect(() =>
      validateFinding({ ...structuredClone(finding), council }),
    ).not.toThrow();
  });
  it("accepts a budget abstention", () => {
    expect(() =>
      validateFinding({
        ...structuredClone(finding),
        council: {
          ...council,
          members: [{ role: "skeptic", abstained: true, cause: "budget" }],
        },
      }),
    ).not.toThrow();
  });
  it("rejects a numeric confidence anywhere in the block", () => {
    expect(() =>
      validateFinding({
        ...structuredClone(finding),
        council: { ...council, confidence: 0.9 },
      }),
    ).toThrow("invalid finding");
  });
  it("accepts the report council metrics and omits nothing required", () => {
    const cost = {
      members: 5,
      rounds: 2,
      experiments: 1,
      tokens: { openai: 100 },
      runner_seconds: 3,
    };
    const report: any = structuredClone(complete);
    report.council = {
      councilled: 1,
      not_councilled: 0,
      findings: [
        { id: "a".repeat(64), status: "complete", answered: 5, total: 5, cost },
      ],
      total: cost,
    };
    expect(() => validateReport(report)).not.toThrow();
    delete report.council.total;
    expect(() => validateReport(report)).toThrow("invalid report");
  });
});

describe("submitted council members", () => {
  it("rejects two members with the same role", async () => {
    const { submission } = await import("./fixtures");
    const { validateSubmission } = await import("../src/validation");
    const s: any = submission();
    s.profile.council_members = [{ role: "skeptic" }, { role: "skeptic" }];
    expect(() => validateSubmission(s)).toThrow(
      "council members must have distinct roles",
    );
  });
});

describe("submitted rules", () => {
  it("rejects a non-council rule without an action and a council rule with one", async () => {
    const { submission } = await import("./fixtures");
    const { validateSubmission } = await import("../src/validation");
    const triage: any = submission();
    triage.profile.steps = [
      {
        id: "triage",
        uses: "rio/triage@0.1.0",
        needs: [],
        with: {},
        rules: [{ when: "mode == fast" }],
      },
    ];
    expect(() => validateSubmission(triage)).toThrow(
      "a rule needs an action in then",
    );
    const council: any = submission();
    council.profile.steps = [
      { id: "verify", uses: "rio/verify@0.1.0", needs: [], with: {} },
      {
        id: "council",
        uses: "rio/council@0.1.0",
        needs: ["verify"],
        with: {},
        rules: [{ when: "nightly", then: "require_human()" }],
      },
    ];
    expect(() => validateSubmission(council)).toThrow(
      "council rules carry no action",
    );
  });
});

describe("council results in SARIF and PR comments", () => {
  it("carries the council block and metrics", async () => {
    const { renderSarif } = await import("../src/sarif");
    const { findingBody } = await import("../src/publish");
    const block = {
      decision: "plausible",
      tier: "judgment",
      partial: true,
      answered: 4,
      total: 5,
      members: [],
      experiments: [],
      note: "Two members cited a static path.",
    };
    const councilled: any = { ...structuredClone(finding), council: block };
    const body = findingBody(councilled, { status: "open" });
    expect(body).toContain(
      "<b>Council</b> — plausible · 4 of 5 members answered · partial",
    );
    expect(body).toContain("Decided by evidence tier (judgment)");
    expect(body).toContain("Council note: Two members cited a static path.");
    const report: any = structuredClone(complete);
    report.findings = [councilled];
    report.council = {
      councilled: 1,
      not_councilled: 0,
      findings: [],
      total: {
        members: 4,
        rounds: 2,
        experiments: 0,
        tokens: {},
        runner_seconds: 0,
      },
    };
    const log: any = renderSarif(report, {
      start_time_utc: "2026-11-09T00:00:00Z",
      end_time_utc: "2026-11-09T00:00:01Z",
      exit_code: null,
    });
    expect(log.runs[0].results[0].properties.council.decision).toBe(
      "plausible",
    );
    expect(log.runs[0].properties["rio.council"].councilled).toBe(1);
  });
});

describe("round-2 position objects", () => {
  it("accept a basis change and reject a bare string, as seen in the live council", () => {
    const basis = {
      ...roundTwo,
      basis: "reproduction",
      real: "yes",
      changed_from: { basis: "static_path" },
      changed_to: { basis: "reproduction" },
      cites: { kind: "artifact", ref: "exp-1", reason_code: "new_artifact" },
    };
    expect(validateAssessment(basis, 2)).toEqual({ assessment: basis });
    expect(
      validateAssessment(
        { ...basis, changed_from: "unknown", changed_to: "yes" },
        2,
      ),
    ).toMatchObject({ abstained: "invalid" });
  });
});

import { expect, it } from "vitest";
import { compareQaResults, qaRecords, qaReport } from "../src/qa-results";
import { validateReport } from "../src/validation";
import { submission } from "./fixtures";

const cell = { viewport: "mobile", color_scheme: "light" };
const recommendation = {
  id: "candidate",
  rule_id: "ux/task-efficiency",
  persona: "shopper",
  goal: "Buy an item",
  journey: "checkout",
  steps: [1],
  cells: [cell],
  route_pattern: "/checkout",
  friction_target: { kind: "duplicate-entry", target: "address" },
  observed_friction: "The shopper enters the address twice.",
  evidence: ["screenshot"],
  basis: {
    heuristic: { source: "Nielsen", version: "1994", reference: "Efficiency" },
  },
  proposed_improvement: "Offer to reuse the address.",
  expected_benefit: "May reduce typing; untested.",
  trade_offs: ["Addresses can differ."],
  priority: "medium",
  confidence: "high",
  verification_status: "unverified",
  rationale: "Verification pending.",
};
const result = () => ({
  outcome: "complete",
  harness: "pi",
  policy: { app_isolation: "container" },
  plan: { selected: { checkout: ["guidance: REVIEW.md"] }, cell_count: 1 },
  journey_outcomes: [
    {
      journey: "checkout",
      cell,
      outcome: "passed",
      steps: [{ step: 1, outcome: "passed" }],
      evidence: ["screenshot"],
      dropped: {},
    },
  ],
  hypotheses: [],
  qa_recommendations: [recommendation],
  ux_assessment: [
    {
      rule_id: "ux/error-recovery",
      journey: "checkout",
      cell,
      status: "not_assessed",
      reason: "budget",
      evidence: [],
    },
  ],
  guidance: [
    { path: "REVIEW.md", hash: "a".repeat(64), start_line: 1, end_line: 2 },
  ],
  seed: { status: "restored", fingerprint: "a".repeat(64), duration_ms: 12 },
  evidence: {
    bytes: 100,
    artifacts: [
      {
        id: "screenshot",
        key: "qa/tenant/run/image.png",
        expires_at: 1800000000000,
      },
    ],
  },
  tokens: 50,
  wall_time_ms: 1000,
});

it("keeps passing journeys, unverified recommendations and missing UX coverage independent", () => {
  const input = submission(),
    raw = result();
  const qa = qaReport(raw, { max_recommendations: 5 });
  validateReport({ ...input.report, qa });
  expect(qa.journeys[0].outcome).toBe("passed");
  expect(qa.recommendations[0].verification_status).toBe("unverified");
  expect(qa.assessment[0].status).toBe("not_assessed");
  expect(qa.selection[0].reasons).toEqual(["guidance: REVIEW.md"]);
  expect(qa.harness).toBe("pi");
  expect(qa.audit).toMatchObject({
    notes: [],
    harness_auth: "unknown",
    quota_bytes: null,
  });
  expect(qa.evidence.expires_at).toBe(new Date(1800000000000).toISOString());
  expect(qaRecords(raw)["manifest.json"]).toEqual(raw.evidence);
});

it("caps recommendations without dropping audit records or disguising a mobile failure", () => {
  const raw: any = result();
  raw.journey_outcomes.push({
    journey: "checkout",
    cell: { ...cell, viewport: "desktop" },
    outcome: "passed",
    steps: [{ step: 4 }],
    evidence: [],
  });
  raw.journey_outcomes[0].outcome = "failed";
  raw.journey_outcomes[0].failed_step = 2;
  const qa = qaReport(raw, { max_recommendations: 0 }, "local");
  expect(qa.journeys[0].outcome).toBe("failed");
  expect(qa.journeys[0].cells[0].step_reached).toBe(2);
  expect(qa.recommendations).toHaveLength(0);
  expect(qa.recommendations_held_back).toBe(1);
  expect(qaRecords(raw)["recommendations.json"]).toHaveLength(1);
  validateReport({ ...submission().report, qa });
});

it("counts controller drop maps and retains the active step on interruption", () => {
  const raw: any = result();
  raw.journey_outcomes[0].dropped = {
    generic_advice: 2,
    invalid_recommendation_source: 3,
    unknown_observation_rule: 4,
  };
  raw.journey_outcomes[0].outcome = "cancelled";
  raw.evidence.artifacts[0] = {
    id: "screenshot",
    kind: "screenshot",
    sanitized: true,
    journey: "checkout",
    cell,
    step: 2,
  };
  const qa = qaReport(raw, {});
  expect(qa.recommendations_dropped).toBe(5);
  expect(qa.journeys[0].cells[0].step_reached).toBe(2);
});

it("matches baseline occurrences only where the same probe completed", async () => {
  const fixture = (
    await import("../../crates/rio-core/tests/qa-fixtures/report.json")
  ).default;
  const finding: any = structuredClone(fixture.findings[0]);
  const head: any = { ...result(), findings: [finding] };
  const base: any = { ...result(), findings: [], probe_assessments: [] };
  let compared = compareQaResults(head, base);
  expect(compared.findings[0].state).toBe("unclassified");
  base.probe_assessments = finding.locations.map((location: any) => ({
    rule_id: finding.rule_id,
    journey: finding.qa.journey,
    step: finding.qa.step,
    cell: location.cell,
  }));
  compared = compareQaResults(head, base);
  expect(compared.findings[0].state).toBe("new");
  expect(compared.findings[0].location.cell).toBeUndefined();
  validateReport({
    ...fixture,
    findings: compared.findings,
    qa: qaReport(compared, {}),
  });
  const mobile = structuredClone(finding);
  mobile.locations = mobile.locations.filter(
    (row: any) => row.cell.viewport === "mobile",
  );
  base.findings = [mobile];
  compared = compareQaResults(head, base);
  expect(compared.findings[0].state).toBe("worsened");
  base.outcome = "partial";
  base.probe_assessments = [];
  compared = compareQaResults(head, base);
  expect(compared.outcome).toBe("partial");
  expect(compared.findings[0].state).toBe("unclassified");
  expect(qaRecords(compared)["baseline.json"]).toEqual(base);
});

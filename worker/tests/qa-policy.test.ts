import { expect, it } from "vitest";
import { applyQaPolicy, suppressQaFindings } from "../src/qa-policy";
import { policyMatches } from "../src/consolidate";
import fixture from "../../crates/rio-core/tests/qa-fixtures/report.json";
import { applyHistory } from "../src/history";

function report(): any {
  const value: any = structuredClone(fixture);
  value.qa.observations_unverified = [];
  value.findings[0].state = "new";
  value.findings[0].severity = "warning";
  return value;
}

it("keeps a separate QA cap and evaluates the entire unsuppressed pool", () => {
  const value = report(),
    template = value.findings[0];
  value.findings = Array.from({ length: 12 }, (_, index) => ({
    ...structuredClone(template),
    id: index.toString(16).padStart(64, "0"),
  }));
  value.findings.push(
    ...Array.from({ length: 3 }, (_, index) => ({
      ...structuredClone(template),
      id: `general-${index}`,
      category: "defect",
    })),
  );
  applyQaPolicy(value, { max_defects: 10 });
  expect(value.findings.filter((f: any) => f.category === "ux")).toHaveLength(
    10,
  );
  expect(
    value.findings.filter((f: any) => f.category === "defect"),
  ).toHaveLength(3);
  expect(value.agent_audit.qa.policy_matches).toHaveLength(12);
  expect(value.agent_audit.qa.held_back).toHaveLength(2);
  expect(value.agent_audit.policy_failed).toBe(true);
});

it("info, unclassified findings and supported recommendations do not match defaults", () => {
  for (const [severity, state] of [
    ["info", "new"],
    ["warning", "unclassified"],
  ]) {
    const value = report();
    value.findings[0].severity = severity;
    value.findings[0].state = state;
    value.qa.recommendations[0].verification_status = "supported";
    applyQaPolicy(value, {});
    expect(value.agent_audit.qa.policy_failed).toBe(false);
    expect(value.agent_audit.qa_incomplete).toBe(false);
  }
  const adopted = report();
  adopted.findings[0].qa.kind = "style";
  applyQaPolicy(adopted, {});
  expect(adopted.agent_audit.qa.policy_failed).toBe(true);
  adopted.findings[0].severity = "info";
  expect(policyMatches(adopted.findings[0], { rules: ["*"] })).toBe(false);
});

it("suppression precedes history and QA incomplete policy is independent", () => {
  const value = report(),
    id = value.findings[0].id;
  suppressQaFindings(value, [{ finding: id }]);
  applyHistory(value, [], new Map());
  applyQaPolicy(value, {});
  expect(value.findings).toHaveLength(0);
  expect(value.agent_audit.policy_failed).toBe(false);
  expect(value.summary.suppressed).toBe(fixture.summary.suppressed + 1);
  applyQaPolicy(value, {}, true);
  expect(value.agent_audit.qa_incomplete).toBe(true);
  applyQaPolicy(value, { fail_on: { incomplete: false } }, true);
  expect(value.agent_audit.qa_incomplete).toBe(false);
});

it("does not fail local runs solely because endpoint verification is deferred", () => {
  for (const storage of ["local", "hosted"]) {
    const value = report();
    value.findings = [];
    value.qa.evidence.storage = storage;
    value.qa.observations_unverified = [{ rule_id: "ui/no-feedback" }];
    applyQaPolicy(value, {});
    expect(value.agent_audit.qa_incomplete).toBe(storage === "hosted");
  }
});

import { describe, expect, it } from "vitest";
import { findingOf, validFix } from "../src/consolidate";
import { validateFinding, validateHypotheses } from "../src/validation";
import { verified } from "./council-fixtures";

const fix = {
  line_start: 3,
  line_end: 3,
  replacement: "  if (doc.owner !== user.id) throw new Error();",
};

describe("machine-applicable fix", () => {
  it("is accepted on hypotheses and carried into the finding", () => {
    const [h] = validateHypotheses([{ ...verified.hypothesis, fix }]);
    const finding = findingOf({ ...verified, hypothesis: h });
    expect(finding.fix).toEqual(fix);
    expect(() => validateFinding(finding)).not.toThrow();
  });

  it("keeps the finding and its prose when the range is inverted", () => {
    const inverted = { line_start: 50, line_end: 42, replacement: "" };
    const [h] = validateHypotheses([
      {
        ...verified.hypothesis,
        suggested_fix: "Check the owner.",
        fix: inverted,
      },
    ]);
    const finding = findingOf({ ...verified, hypothesis: h });
    expect(finding.fix).toBeUndefined();
    expect(finding.suggested_fix).toBe("Check the owner.");
    expect(finding.rule_id).toBe(verified.hypothesis.rule_id);
  });

  it("is optional and strict", () => {
    expect(findingOf(verified).fix).toBeUndefined();
    expect(() =>
      validateHypotheses([
        { ...verified.hypothesis, fix: { ...fix, path: "other.ts" } },
      ]),
    ).toThrow(/malformed hypothesis/);
    expect(validFix({ line_start: 0, line_end: 1, replacement: "" })).toBe(
      false,
    );
    expect(validFix(fix)).toBe(true);
  });
});

describe("security trace", () => {
  const security = {
    ...verified.hypothesis,
    rule_id: "security/access-control/owner-check",
    category: "security" as const,
    catalog_item: "A01",
    trace_change: "removed" as const,
    locations: [
      { ...verified.hypothesis.location, line_start: 52, line_end: 52 },
      { ...verified.hypothesis.location, line_start: 3, line_end: 3 },
      { ...verified.hypothesis.location, line_start: 57, line_end: 57 },
    ],
  };
  it("keeps the cited path from source to sink and marks a removed step", () => {
    const finding = findingOf({
      ...verified,
      category: "security",
      hypothesis: security,
    });
    const path = verified.hypothesis.location.path;
    expect(finding.trace).toEqual({
      catalog_item: "A01",
      change: "removed",
      steps: [
        { role: "source", path, line_start: 52 },
        { role: "step", path, line_start: 3, missing: true },
        { role: "sink", path, line_start: 57 },
      ],
    });
    expect(() =>
      validateFinding({ ...finding, id: "f".repeat(64) }),
    ).not.toThrow();
  });
  it("is absent outside the security category", () => {
    expect(findingOf(verified).trace).toBeUndefined();
    expect(
      findingOf({
        ...verified,
        hypothesis: { ...security, category: "defect" },
      }).trace,
    ).toBeUndefined();
  });
});

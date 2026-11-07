import { describe, expect, it } from "vitest";
import complete from "../../crates/rio-core/tests/fixtures/complete.json";
import finding from "../../crates/rio-core/tests/fixtures/finding.json";
import { validateFinding, validateReport } from "../src/validation";

// The v0.3 keys are optional: documents with and without them validate, and the
// history block only accepts the standardized response reasons.
const history = {
  first_seen: "rev-1",
  last_seen: "rev-2",
  seen_count: 2,
  previous_status: "dismissed",
  previous_response: {
    reason: "wrong",
    actor: "octocat",
    at: "2026-11-05T10:00:00Z",
  },
  dismissed_in: "github.com/o/r#41",
};
const objects = {
  publication: {
    policy: "auto",
    posted: 4,
    edited: 1,
    resolved: 0,
    failed: 0,
    unanchored: 1,
    check_run_url: "https://github.com/o/r/runs/1",
    summary_comment_url: null,
  },
  cache: { lookups: 4, hits: 2, hit_rate: 0.5, tokens_saved_estimate: 1200 },
  suppression_proposals: [
    {
      id: "p1",
      entry: { rule: "lint/eslint/no-console" },
      evidence_count: 3,
      since: "2026-10-01T00:00:00Z",
    },
  ],
  security_coverage: {
    catalog: "owasp-top10-2025",
    assessed: [{ item: "A05:2025", title: "Injection", findings: [] }],
    unassessed: [
      { item: "A01:2025", title: "Broken Access Control", reason: "budget" },
    ],
    not_applicable: [],
  },
};
const clone = <T>(value: T): T => structuredClone(value);

describe("v0.3 contract keys", () => {
  it("accepts findings and reports with and without the new keys", () => {
    expect(() => validateFinding(clone(finding))).not.toThrow();
    expect(() => validateReport(clone(complete))).not.toThrow();
    const extended: any = {
      ...clone(finding),
      source: { agent: "security", cached: true },
      history,
    };
    expect(() => validateFinding(extended)).not.toThrow();
    const report: any = { ...clone(complete), ...clone(objects) };
    report.findings = [extended];
    expect(() => validateReport(report)).not.toThrow();
  });

  it("rejects a history block with an unknown reason and malformed objects", () => {
    for (const reason of ["known", "false_positive"]) {
      const bad: any = {
        ...clone(finding),
        history: {
          ...history,
          previous_response: { ...history.previous_response, reason },
        },
      };
      expect(() => validateFinding(bad)).toThrow(/invalid finding/);
      const report: any = clone(complete);
      report.findings = [bad];
      expect(() => validateReport(report)).toThrow(/invalid report/);
    }
    const tool: any = {
      ...clone(finding),
      source: { tool: "tsc", version: "5", cached: true },
    };
    expect(() => validateFinding(tool)).toThrow();
    for (const [key, patch] of [
      ["publication", { policy: "always" }],
      ["cache", { hit_rate: 2 }],
      ["security_coverage", { catalog: "internal" }],
    ] as const) {
      const report: any = clone(complete);
      report[key] = { ...clone((objects as any)[key]), ...patch };
      expect(() => validateReport(report)).toThrow(/invalid report/);
    }
  });
});

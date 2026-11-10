import { expect, it } from "vitest";
import {
  applyLineage,
  planReverification,
  type ApplyOptions,
  type LineageContext,
} from "../src/lineage";
import type { Finding } from "../src/types";
import fixture from "../../crates/rio-core/tests/qa-fixtures/report.json";

function setup(journey = false) {
  const finding = structuredClone(fixture.findings[0]) as Finding;
  const path = journey ? ".rio/qa/journeys/checkout.yaml" : "src/checkout.ts";
  finding.qa!.attribution = journey ? "journey" : "source";
  finding.location = { ...finding.location, path, line_start: 1, line_end: 1 };
  finding.locations = finding.locations.map((row) => ({
    ...row,
    path,
    line_start: 1,
    line_end: 1,
  }));
  const file = (content: string) => ({ mode: 0o100644, content });
  const context = {
    id: "lineage",
    tenant: "owner",
    repository: "repo",
    kind: "pr",
    ref: "1",
    generation: 1,
    round: 2,
    cap: 3,
    diff_only_after: 1,
    diff_only: false,
    snapshot_id: "head",
    previous_head: "prior",
    previous_head_key: null,
    previous_review: "review",
    intent: null,
    author_response_ratio: null,
    rounds_to_pass: null,
    posted: { [finding.id]: { first_posted_in: "prior", round: 1 } },
    prior: [
      {
        id: finding.id,
        status: "open",
        source_kind: "agent",
        category: "ux",
        snapshot_id: "prior",
        snapshot_key: "prior",
        round: 1,
        first_posted_in: "prior",
        author_response: null,
        resolution: null,
        finding,
        check: null,
      },
    ],
  } as LineageContext;
  const options: ApplyOptions = {
    head: { [path]: file(journey ? "same journey" : "fixed code") },
    trees: new Map([
      ["prior", { [path]: file(journey ? "same journey" : "broken code") }],
    ]),
    graph: { nodes: [], edges: [] },
    agents_reassessed: true,
    changed: [{ path, lines_changed: 1 }],
    qa_changes: new Map([["prior", new Set(["src/checkout.ts"])]]),
    qa_journeys: { checkout: { covers: { paths: ["src/**"] } } },
  };
  const report: any = {
    status: "complete",
    findings: [],
    risks: [],
    checks: [],
    footer: { notes: [] },
    agent_audit: {},
    qa: {
      journeys: [
        {
          name: "checkout",
          cells: finding.locations.map((row) => ({
            ...row.cell,
            outcome: "passed",
            step_reached: finding.qa!.step,
          })),
        },
      ],
    },
  };
  return { finding, context, options, report, path };
}
it("resolves a source-attributed QA finding only after all its cells reach the step and code changes", () => {
  const { finding, context, options, report } = setup();
  const outcome = applyLineage(report, context, options);
  expect(outcome.updates).toEqual([
    { id: finding.id, status: "fixed", resolution: { fixed_in: "head" } },
  ]);
});
it.each(["cancelled", "earlier-step", "missing-cell", "partial-review"])(
  "keeps a QA finding open without complete same-cell reassessment (%s)",
  (mode) => {
    const { context, options, report } = setup();
    if (mode === "cancelled")
      report.qa.journeys[0].cells[0].outcome = "cancelled";
    if (mode === "earlier-step")
      report.qa.journeys[0].cells[0].step_reached = 0;
    if (mode === "missing-cell") report.qa.journeys[0].cells.pop();
    if (mode === "partial-review") report.status = "partial";
    expect(applyLineage(report, context, options).updates[0]).toMatchObject({
      status: "open",
      resolution: { note: "not re-assessed" },
    });
  },
);
it("does not resolve a passing QA journey when attributed code is unchanged since the prior observation", () => {
  const { context, options, report } = setup();
  options.head = options.trees.get("prior")!;
  expect(applyLineage(report, context, options).updates[0]).toMatchObject({
    status: "open",
    resolution: { note: "did not reproduce" },
  });
});
it("uses covered source changes since the prior snapshot for journey attribution, not the accumulated PR diff", () => {
  const { context, options, report } = setup(true);
  expect(applyLineage(report, context, options).updates[0].status).toBe(
    "fixed",
  );
  options.qa_changes = new Map([["prior", new Set()]]);
  expect(applyLineage(report, context, options).updates[0]).toMatchObject({
    status: "open",
    resolution: { note: "did not reproduce" },
  });
  options.qa_changes = undefined;
  expect(
    applyLineage(report, context, options).updates[0].resolution.note,
  ).toBe("not re-assessed");
});
it("does not confuse tool checks, held-back QA identities or general diff-only reverification with QA reassessment", () => {
  const { finding, context, options, report } = setup();
  context.prior[0].source_kind = "tool";
  report.qa = undefined;
  report.checks = [
    { kind: "lint", root: ".", version: "head", outcome: "passed" },
  ];
  expect(
    applyLineage(report, context, options).updates[0].resolution.note,
  ).toBe("not re-assessed");
  report.agent_audit.qa = { held_back: [{ id: finding.id }] };
  expect(applyLineage(report, context, options).updates).toEqual([]);
  context.prior[0].source_kind = "agent";
  expect(
    planReverification(
      [],
      context,
      options.trees,
      options.head,
      options.graph,
      new Set([finding.location.path]),
    ),
  ).toEqual({ verify: [], carried: [], skipped: [] });
});
it("keeps QA dismissal and first-post identity across later rounds", () => {
  const { finding, context, options, report } = setup();
  context.prior[0].author_response = {
    reason: "intentional",
    actor: "owner",
    at: "2026-11-09T00:00:00Z",
  } as any;
  report.findings = [finding];
  const result = applyLineage(report, context, options);
  expect(report.findings[0]).toMatchObject({
    status: "dismissed",
    first_posted_in: "prior",
    author_response: { reason: "intentional" },
  });
  expect(result.posted_map[finding.id]).toEqual({
    first_posted_in: "prior",
    round: 1,
  });
  expect(report.lineage.held_back).toBe(1);
});
it("does not treat a baseline-fixed observation as a newly produced QA identity", () => {
  const { finding, context, options, report } = setup();
  report.findings = [{ ...finding, state: "fixed" }];
  const result = applyLineage(report, context, options);
  expect(result.rows).toEqual([]);
  expect(result.updates[0].status).toBe("fixed");
});

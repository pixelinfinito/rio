import { describe, it, expect } from "vitest";
import {
  ingestRecommendation,
  recommendationId,
  recommendationPrompts,
  selectRecommendations,
  verifyRecommendation,
  assessmentCoverage,
  type Recommendation,
  type RecommendationContext,
  type RecommendationVote,
} from "../src/qa-recommendations";
const cell = { viewport: "mobile", color_scheme: "light" as const };
const criterion = {
  id: "ux/task-efficiency",
  source: {
    title: "Nielsen heuristics",
    version: "2024",
    url: "https://www.nngroup.com/articles/ten-usability-heuristics/",
  },
  applicability: "Repeated entry",
  required_evidence: ["step capture"],
};
const context: RecommendationContext = {
  artifacts: new Map(
    ["one", "two"].map((id, i) => [
      id,
      {
        id,
        journey: "checkout",
        step: i + 1,
        cell,
        sanitized: true,
        kind: "dom" as const,
      },
    ]),
  ),
  guidance: [
    {
      path: "REVIEW.md",
      scope_dir: "",
      content_hash: "a".repeat(64),
      lines: ["Reuse the address."],
    },
    {
      path: "admin/REVIEW.md",
      scope_dir: "admin",
      content_hash: "b".repeat(64),
      lines: ["Unrelated admin requirement."],
    },
  ],
  sourcePaths: ["checkout/page.tsx"],
  criteria: new Map([[criterion.id, criterion]]),
};
function candidate(): Recommendation {
  return {
    id: "model-supplied-id",
    rule_id: criterion.id,
    persona: "shopper",
    goal: "Buy an item without unnecessary re-entry",
    journey: "checkout",
    steps: [1, 2],
    cells: [cell],
    route_pattern: "/checkout",
    friction_target: { kind: "duplicate-entry", target: "billing-address" },
    observed_friction: "The same address is entered in two forms.",
    evidence: ["one", "two"],
    basis: {
      guidance: [
        { path: "REVIEW.md", hash: "a".repeat(64), start_line: 1, end_line: 1 },
      ],
    },
    proposed_improvement: "Reuse the delivery address with an edit option.",
    expected_benefit: "Expected reduction in repeated entry; not user tested.",
    trade_offs: ["Some shoppers need a different billing address."],
    priority: "medium",
    confidence: "high",
    verification_status: "supported",
    rationale: "model claim",
  };
}
const vote = (
  voter: number,
  verdict: "support" | "reject",
): RecommendationVote => ({
  voter,
  status: "completed",
  answer: {
    verdict,
    evidence: ["one", "two"],
    rationale: "Recorded fields show repeated entry.",
  },
});
describe("UX recommendations stay separate from product failures", () => {
  it("ingests only grounded candidates and does not trust model verification or lifecycle", () => {
    const raw = candidate();
    raw.dismissal = { reason: "intentional", actor: "model", at: "now" };
    const accepted = ingestRecommendation(raw, context).candidate!;
    expect(accepted.verification_status).toBe("unverified");
    expect(accepted.dismissal).toBeUndefined();
    expect(accepted.id).toBe(recommendationId(raw));
    expect(
      ingestRecommendation({ ...raw, evidence: [] }, context).dropped,
    ).toBe("invalid_candidate");
    expect(
      ingestRecommendation({ ...raw, evidence: ["invented"] }, context).dropped,
    ).toBe("missing_or_invalid_evidence");
    raw.basis.guidance![0].path = "admin/REVIEW.md";
    raw.basis.guidance![0].hash = "b".repeat(64);
    expect(ingestRecommendation(raw, context).dropped).toBe(
      "invalid_guidance_citation",
    );
  });
  it("does not confuse verified friction with proven benefit", () => {
    const result = verifyRecommendation(
      candidate(),
      [vote(0, "support"), vote(1, "support"), { voter: 2, status: "failed" }],
      3,
      2,
      context,
    );
    expect(result.candidate.verification_status).toBe("supported");
    expect(result.candidate.rationale).toContain(
      "expected benefit remains untested",
    );
    expect(result.candidate.expected_benefit).toBe(
      candidate().expected_benefit,
    );
    expect(result.audit.map((v) => v.counted)).toEqual([true, true, false]);
  });
  it("handles rejected, split, failed, malformed and duplicate votes", () => {
    expect(
      verifyRecommendation(
        candidate(),
        [vote(0, "reject"), vote(1, "reject")],
        3,
        2,
        context,
      ).candidate.verification_status,
    ).toBe("rejected");
    const split = verifyRecommendation(
      candidate(),
      [vote(0, "support"), vote(1, "reject")],
      2,
      1,
      context,
    );
    expect(split.candidate.verification_status).toBe("inconclusive");
    expect(split.split).toBe(true);
    const malformed = {
      voter: 1,
      status: "completed",
      answer: { verdict: "support", rationale: "No evidence supplied" },
    } as RecommendationVote;
    expect(
      verifyRecommendation(
        candidate(),
        [vote(0, "support"), vote(0, "support"), malformed],
        3,
        2,
        context,
      ).candidate.verification_status,
    ).toBe("inconclusive");
    const fabricated = vote(1, "support");
    fabricated.answer!.evidence = ["missing"];
    expect(
      verifyRecommendation(
        candidate(),
        [vote(0, "support"), fabricated],
        3,
        2,
        context,
      ).candidate.verification_status,
    ).toBe("inconclusive");
  });
  it("identity ignores prose and cells and normalizes query strings", () => {
    const first = candidate(),
      second = candidate();
    second.route_pattern = "https://app.test/checkout/?session=discard";
    second.observed_friction = "Reworded";
    second.cells = [{ viewport: "desktop", color_scheme: "dark" }];
    expect(recommendationId(first)).toBe(recommendationId(second));
    second.friction_target.target = "email";
    expect(recommendationId(first)).not.toBe(recommendationId(second));
  });
  it("links duplicate advice only with a support quorum and shared evidence from a verified finding in the same step and cell", () => {
    const finding: any = {
      id: "verified",
      category: "ux",
      evidence_level: "reproduced",
      qa: { journey: "checkout", step: 2, route: "/checkout" },
      locations: [{ cell, evidence: ["two"] }],
    };
    const linkedContext = {
      ...context,
      findings: new Map([[finding.id, finding]]),
    };
    const votes = [vote(0, "support"), vote(1, "support"), vote(2, "support")];
    votes[0].answer!.related_finding_id = "verified";
    expect(
      verifyRecommendation(candidate(), votes, 3, 2, linkedContext).candidate
        .related_finding_id,
    ).toBeUndefined();
    votes[1].answer!.related_finding_id = "verified";
    const result = verifyRecommendation(
      candidate(),
      votes,
      3,
      2,
      linkedContext,
    );
    expect(result.candidate.related_finding_id).toBe("verified");
    expect(selectRecommendations([result.candidate]).recommendations).toEqual(
      [],
    );
    expect(selectRecommendations([result.candidate]).related).toHaveLength(1);
    for (const invalid of [
      { ...finding, evidence_level: "plausible" },
      { ...finding, qa: { ...finding.qa, step: 7 } },
      { ...finding, qa: { ...finding.qa, journey: "login" } },
      {
        ...finding,
        locations: [
          { cell: { ...cell, viewport: "desktop" }, evidence: ["two"] },
        ],
      },
      { ...finding, locations: [{ cell, evidence: ["unrelated"] }] },
    ])
      expect(
        verifyRecommendation(candidate(), votes, 3, 2, {
          ...context,
          findings: new Map([["verified", invalid]]),
        }).candidate.related_finding_id,
      ).toBeUndefined();
  });
  it("ranks supported first, merges cells, honors dismissals and has an independent cap", () => {
    const supported = candidate(),
      duplicate = candidate(),
      unverified = candidate();
    duplicate.cells = [{ viewport: "desktop", color_scheme: "dark" }];
    unverified.friction_target.target = "email";
    unverified.verification_status = "unverified";
    unverified.priority = "high";
    const result = selectRecommendations([unverified, supported, duplicate], {
      max: 1,
    });
    expect(result.recommendations[0].verification_status).toBe("supported");
    expect(result.recommendations[0].cells).toHaveLength(2);
    expect(result.held_back).toBe(1);
    expect(
      selectRecommendations([supported], {
        dismissed: new Set([recommendationId(supported)]),
      }).recommendations,
    ).toEqual([]);
    const related = selectRecommendations([supported], {
      findings: new Map([[recommendationId(supported), "finding-1"]]),
    });
    expect(related.recommendations).toEqual([]);
    expect(related.related[0].related_finding_id).toBe("finding-1");
    const rejected = { ...supported, verification_status: "rejected" as const };
    expect(
      selectRecommendations([supported, rejected]).recommendations[0]
        .verification_status,
    ).toBe("inconclusive");
  });
  it("both verifier prompts contain scoped guidance; blind prompt excludes candidate", () => {
    const original = candidate();
    original.observed_friction = "UNIQUE_CANDIDATE_TEXT";
    const prompts = recommendationPrompts({
      journey: { name: "checkout" },
      stepEvidence: ["one", "two"],
      sourcePaths: context.sourcePaths,
      guidance: context.guidance,
      criteria: [criterion],
      candidate: original,
      toolCalls: [
        { type: "assistant", text: "NARRATIVE_SHOULD_BE_EXCLUDED" },
        {
          tool: "browser_click",
          arguments: { ref: "button-1" },
          narrative: "NARRATIVE_SHOULD_BE_EXCLUDED",
        },
      ],
    });
    for (const prompt of Object.values(prompts)) {
      expect(prompt).toContain("Reuse the address");
      expect(prompt).not.toContain("Unrelated admin");
    }
    expect(prompts.evidence).not.toContain("NARRATIVE_SHOULD_BE_EXCLUDED");
    expect(prompts.evidence).toContain("browser_click");
    expect(prompts.blind).not.toContain("UNIQUE_CANDIDATE_TEXT");
    expect(prompts.evidence).toContain("UNIQUE_CANDIDATE_TEXT");
  });
  it("reports unassessed criteria under budget limits, even for a passed journey", () => {
    const coverage = assessmentCoverage(
      "checkout",
      [cell],
      ["ux/task-efficiency", "ux/error-recovery"],
      [
        {
          journey: "checkout",
          cell,
          rule_id: "ux/task-efficiency",
          status: "assessed",
          evidence: ["one"],
        },
      ],
      "budget",
      context.artifacts,
    );
    expect(coverage.map((c) => c.status)).toEqual(["assessed", "not_assessed"]);
    expect(coverage[1].reason).toBe("budget");
    expect(coverage.every((c) => !("outcome" in c))).toBe(true);
  });
});

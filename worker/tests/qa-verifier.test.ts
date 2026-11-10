import { expect, it } from "vitest";
import {
  qaBlindMatch,
  qaBlindPrompt,
  qaEvidenceLevel,
  qaEvidencePack,
  onceQaReplay,
  verifyQaCandidate,
  verifyQaRecommendation,
  type QaPack,
  type QaCandidate,
  type QaAnswer,
} from "../src/qa-verifier";
import { verifyQaReview, qaReplayRegistry } from "../src/qa-review";
import { compareQaResults } from "../src/qa-results";
import { readerOf } from "../src/snapshot";
import { Tools } from "../src/tools";
import { ProviderGateway } from "../src/gateway";
import type { Env } from "../src/types";
import { profile, snapshot, graphs } from "./fixtures";
import fixture from "../../crates/rio-core/tests/qa-fixtures/report.json";
const cell = { viewport: "mobile", color_scheme: "light" as const };
const criterion = {
  id: "ui/no-feedback",
  source: {
    title: "Nielsen",
    version: "2024",
    url: "https://example.test/heuristic",
  },
  applicability: "Checkout",
  required_evidence: ["before/after"],
};
const guidance = [
  {
    path: "checkout/REVIEW.md",
    scope_dir: "checkout",
    content_hash: "a".repeat(64),
    lines: ["Keep entered data after a declined payment."],
  },
];
const candidate: QaCandidate = {
  finding: {
    ...structuredClone(fixture.findings[0]),
    id: "b".repeat(64),
    rule_id: "ui/no-feedback",
    message: "CANDIDATE SECRET TEXT",
    state: "new",
    source: { agent: "qa" },
    qa: {
      ...fixture.findings[0].qa,
      journey: "checkout",
      step: 2,
      route: "/checkout",
      attribution: "journey",
    },
  } as any,
  cell,
  expected: { confirmation: true },
  observed: { confirmation: false },
};
const metadata = [
  { id: "before", kind: "screenshot", step: 1 },
  { id: "after", kind: "screenshot", step: 2 },
  { id: "dom", kind: "dom", step: 2 },
  { id: "trace", kind: "trace" },
  { id: "replay", kind: "replay" },
  { id: "probe", kind: "probe", step: 2 },
].map((row) => ({ ...row, journey: "checkout", cell, sanitized: true }));
const pack = (): QaPack => ({
  journey: {
    name: "checkout",
    persona: "shopper",
    steps: [{ do: "Enter address" }, { do: "Pay", expect: "Confirmation" }],
  },
  guidance,
  criteria: [criterion],
  artifacts: new Map(metadata.map((row) => [row.id, row])),
  loaded: new Map(
    metadata.map((row) => [
      row.id,
      row.kind === "screenshot"
        ? {
            image: {
              data: "cG5n",
              media_type: "image/png" as const,
              token_bound: 4000,
            },
          }
        : {
            text:
              row.id === "dom"
                ? '{"text":"No confirmation"}'
                : row.id === "probe"
                  ? JSON.stringify({ rule_id: criterion.id, matched: true })
                  : "",
          },
    ]),
  ),
  toolCalls: [],
  probes: [
    {
      id: "probe",
      rule_id: criterion.id,
      qa: { journey: "checkout", step: 2 },
      locations: [{ cell, evidence: ["after", "dom"] }],
    },
  ],
  beforeUnavailable: false,
});
const context = {
  snapshot: { head: {} },
  head: graphs.head,
  base: graphs.base,
  executions: {},
  guidance,
};
const answer = (
  level = "reproduced",
  ids = ["trace", "after", "dom"],
): QaAnswer => ({
  evidence_level: level as any,
  evidence: [
    {
      kind: "browser",
      ids,
      demonstrates: level === "refuted" ? "protection" : "regression",
    },
  ],
  rationale: "The captured step shows the stated behavior.",
});
const ledger = () => ({
  remaining: async () => 10000000,
  reserve: async () => "reservation",
  settle: async () => {},
});
function options() {
  const p = structuredClone(profile);
  p.verify = { voters: 3, quorum: 2 };
  return {
    profile: p,
    candidate,
    pack: pack(),
    context,
    snapshot: readerOf(snapshot),
    ledger: ledger(),
    agentTokens: 500000,
    verifyTokens: 100000,
    tools: () => new Tools(snapshot, graphs, undefined),
    save: async () => {},
  };
}
const blind = {
  rule_id: "ui/no-feedback",
  journey: "checkout",
  step: 2,
  route: "/checkout?session=redacted",
};
const gateway = (disclosed: any = answer(), prompts: any[] = []) => ({
  complete: async (request: any) => {
    const { signal, ...record } = request;
    prompts.push(structuredClone(record));
    return {
      content: JSON.stringify({
        result: request.messages.length === 1 ? [blind] : disclosed,
      }),
      input_tokens: 10,
      output_tokens: 10,
      cost_usd: null,
    };
  },
});
it("matches blind QA observations on rule/journey/step/route without source symbols", () => {
  expect(qaBlindMatch([blind], candidate)).toBe("same");
  expect(
    qaBlindMatch([{ ...blind, rule_id: "ux/system-feedback" }], candidate),
  ).toBe("related");
  expect(qaBlindMatch([{ ...blind, step: 1 }], candidate)).toBe("none");
});
it("keeps candidate prose and transcript narrative out of the blind pack", async () => {
  const p = pack();
  const replay = [
    {
      version: 1,
      sequence: 0,
      journey: "checkout",
      step: 2,
      cell,
      action: "click",
      arguments: { selector: "button" },
      narrative: "DO NOT COPY ME",
    },
    {
      version: 1,
      sequence: 1,
      journey: "checkout",
      step: 2,
      cell,
      action: "observe",
      arguments: { expected: "CANDIDATE SECRET TEXT" },
    },
    { type: "text", text: "DO NOT COPY ME" },
  ];
  const result = {
    journey_outcomes: [
      {
        journey: "checkout",
        cell,
        verification_context: {
          journey: p.journey,
          guidance,
          criteria: p.criteria,
        },
      },
    ],
    evidence: { artifacts: metadata },
  };
  const loaded = await qaEvidencePack({
    result,
    journey: "checkout",
    steps: [2],
    cell,
    load: async (artifact) =>
      artifact.kind === "replay"
        ? { text: replay.map((row) => JSON.stringify(row)).join("\n") }
        : p.loaded.get(artifact.id)!,
  });
  expect(loaded.toolCalls).toEqual([
    {
      sequence: 0,
      journey: "checkout",
      step: 2,
      action: "click",
      arguments: { selector: "button" },
    },
  ]);
  expect(qaBlindPrompt(loaded)).toContain(guidance[0].lines[0]);
  expect(qaBlindPrompt(loaded)).toContain("before");
  expect(qaBlindPrompt(loaded)).not.toContain("CANDIDATE SECRET TEXT");
  expect(JSON.stringify(loaded.toolCalls)).not.toContain("DO NOT COPY ME");
});
it("requires trace plus matching step screenshot and DOM; other cells cannot lend proof", () => {
  expect(qaEvidenceLevel(answer(), candidate, pack(), context)).toBe(
    "reproduced",
  );
  expect(
    qaEvidenceLevel(
      answer("reproduced", ["before", "trace", "after", "dom"]),
      candidate,
      pack(),
      context,
    ),
  ).toBe("reproduced");
  expect(
    qaEvidenceLevel(
      answer("reproduced", ["before", "trace", "dom"]),
      candidate,
      pack(),
      context,
    ),
  ).toBeUndefined();
  expect(
    qaEvidenceLevel(
      answer("reproduced", ["after", "dom"]),
      candidate,
      pack(),
      context,
    ),
  ).toBeUndefined();
  const wrong = pack();
  wrong.artifacts.set("dom", {
    ...wrong.artifacts.get("dom")!,
    cell: { ...cell, viewport: "desktop" },
  });
  expect(qaEvidenceLevel(answer(), candidate, wrong, context)).toBeUndefined();
  expect(
    qaEvidenceLevel(answer("refuted", ["dom"]), candidate, pack(), context),
  ).toBe("refuted");
  expect(
    qaEvidenceLevel(answer("refuted", ["before"]), candidate, pack(), context),
  ).toBeUndefined();
  const proof: QaAnswer = {
    ...answer("static_proven"),
    evidence: [{ kind: "probe", ids: ["probe"], demonstrates: "regression" }],
  };
  expect(qaEvidenceLevel(proof, candidate, pack(), context)).toBe(
    "static_proven",
  );
});
it("never includes baseline artifacts in a head evidence pack even when manifests are combined", async () => {
  const p = pack();
  const base = metadata.map((row) => ({ ...row, id: `base-${row.id}` }));
  const requested: string[] = [];
  const loaded = await qaEvidencePack({
    result: {
      journey_outcomes: [
        {
          journey: "checkout",
          cell,
          verification_context: {
            journey: p.journey,
            guidance,
            criteria: p.criteria,
          },
        },
      ],
      evidence: { artifacts: [...metadata, ...base] },
      baseline: { evidence: { artifacts: base } },
    },
    journey: "checkout",
    steps: [2],
    cell,
    load: async (artifact) => {
      requested.push(artifact.id);
      return { text: "evidence" };
    },
  });
  expect(requested.some((id) => id.startsWith("base-"))).toBe(false);
  expect([...loaded.artifacts.keys()]).toContain("dom");
});
it("replay non-recurrence and failed prerequisites contribute to neither side", async () => {
  for (const outcome of ["not_recurred", "prerequisites_failed"] as const)
    for (const level of ["refuted", "reproduced"] as const) {
      const vote: QaAnswer = {
        ...answer(level),
        evidence: [
          {
            kind: "replay",
            ids: ["replayed"],
            demonstrates: level === "refuted" ? "protection" : "regression",
          },
        ],
      };
      expect(
        qaEvidenceLevel(vote, candidate, pack(), context, {
          outcome,
          evidence: ["replayed"],
        }),
      ).toBeUndefined();
    }
  const proof: QaAnswer = {
    ...answer(),
    evidence: [
      {
        kind: "replay",
        ids: ["trace", "after", "dom"],
        demonstrates: "regression",
      },
    ],
  };
  expect(
    qaEvidenceLevel(proof, candidate, pack(), context, {
      outcome: "recurred",
      evidence: ["trace", "after", "dom"],
      artifacts: metadata,
      scope: { version: "head", journey: "checkout", step: 2, cell },
    }),
  ).toBe("reproduced");
  let count = 0;
  const run = onceQaReplay(async () => {
    count++;
    return { outcome: "not_recurred", evidence: [] };
  });
  const results = await Promise.all([run(), run(), run()]);
  expect(count).toBe(1);
  expect(results[0]).toEqual(results[2]);
});
it("uses independent multimodal blind/disclosed turns and the same immutable guidance", async () => {
  const prompts: any[] = [],
    saves: any[] = [];
  const result = await verifyQaCandidate({
    ...options(),
    save: async (vote) => {
      saves.push(structuredClone(vote));
    },
    gateway: gateway(answer(), prompts),
  });
  expect(result.finding?.evidence_level, JSON.stringify(result.votes)).toBe(
    "reproduced",
  );
  expect(result.finding?.category).toBe("ux");
  expect(result.finding?.evidence).toContain("trace");
  expect(result.finding?.locations[0].evidence).toContain("trace");
  expect(result.finding?.verification?.blind_match).toEqual([
    "same",
    "same",
    "same",
  ]);
  expect(prompts).toHaveLength(6);
  expect(saves).toHaveLength(6);
  for (const prompt of prompts) {
    expect(prompt.messages[0].content).toContain(guidance[0].content_hash);
    expect(prompt.messages[0].content).not.toContain("CANDIDATE SECRET TEXT");
    expect(prompt.messages[0].images).toHaveLength(2);
    // The same immutable guidance is present once in each request's retained
    // history, including the disclosed turn; do not pay for a duplicate copy.
    expect(
      prompt.messages
        .map((m: any) => m.content)
        .join("\n")
        .split(guidance[0].content_hash),
    ).toHaveLength(2);
  }
});
it("attaches the journey-opening screenshot only when step 1 needs its before evidence", async () => {
  const p = pack();
  const opening = { ...metadata[0], id: "opening", step: undefined };
  const load = async (artifact: any) =>
    p.loaded.get(artifact.id === "opening" ? "before" : artifact.id)!;
  const result = {
    journey_outcomes: [{ journey: "checkout", cell, verification_context: p }],
    evidence: { artifacts: [opening, ...metadata] },
  };
  const later = await qaEvidencePack({
    result,
    journey: "checkout",
    steps: [2],
    cell,
    load,
  });
  expect(later.artifacts.has("opening")).toBe(false);
  expect(later.artifacts.has("before")).toBe(true);
  expect(later.beforeUnavailable).toBe(false);
  const first = await qaEvidencePack({
    result,
    journey: "checkout",
    steps: [1],
    cell,
    load,
  });
  expect(first.artifacts.has("opening")).toBe(true);
  expect(first.beforeUnavailable).toBe(false);
});
it("finishes a mobile evidence verification with a paged tool read inside the approved deep voter budget", async () => {
  const p = pack();
  // Sizes from live checkout: two 1170x2532 screenshots, ~9.5KB of
  // criterion definitions and a long browser text artifact. No real model call.
  p.criteria = [{ ...criterion, examples: ["x".repeat(9500)] }];
  for (const data of p.loaded.values())
    if (data.image) data.image.token_bound = 17336;
  p.loaded.set("dom", { text: "a".repeat(6000) + "final captured state" });
  Object.assign(p.artifacts.get("dom")!, {
    key: "private-storage-key",
    link: "https://signed.invalid",
  });
  const prompts: any[] = [];
  const result = await verifyQaCandidate({
    ...options(),
    pack: p,
    verifyTokens: 120000,
    gateway: {
      complete: async (request) => {
        prompts.push(structuredClone(request.messages));
        const last = request.messages.at(-1)!.content;
        const response =
          request.messages.length === 1
            ? { result: [blind] }
            : !last.startsWith('{"tool_results":')
              ? { tools: [{ name: "read_qa_artifact", args: { id: "dom" } }] }
              : { result: answer() };
        return {
          content: JSON.stringify(response),
          input_tokens: 20000,
          output_tokens: 250,
          cost_usd: null,
        };
      },
    },
  });
  expect(result.votes.map((vote) => vote.status)).toEqual([
    "completed",
    "completed",
    "completed",
  ]);
  expect(result.finding?.evidence_level).toBe("reproduced");
  const toolReply = prompts
    .find((messages) => messages.at(-1).content.startsWith('{"tool_results":'))
    .at(-1).content;
  const page = JSON.parse(toolReply).tool_results[0].result;
  expect(page.text).toHaveLength(6000);
  expect(page.next_offset).toBe(6000);
  expect(page.total_chars).toBe(6020);
  expect(JSON.stringify(prompts)).not.toContain("private-storage-key");
  expect(JSON.stringify(prompts)).not.toContain("signed.invalid");
});
it("pages all captured text without permitting invalid ranges or out-of-scope artifacts", async () => {
  const p = pack();
  p.loaded.set("dom", { text: "a".repeat(6000) + "tail" });
  const replies: any[] = [];
  const result = await verifyQaCandidate({
    ...options(),
    pack: p,
    gateway: {
      complete: async (request) => {
        const last = request.messages.at(-1)!.content;
        if (last.startsWith('{"tool_results":'))
          replies.push(JSON.parse(last).tool_results);
        return {
          content: JSON.stringify(
            request.messages.length === 1
              ? { result: [blind] }
              : last.startsWith('{"tool_results":')
                ? { result: answer() }
                : {
                    tools: [
                      {
                        name: "read_qa_artifact",
                        args: { id: "dom", offset: 6000 },
                      },
                      {
                        name: "read_qa_artifact",
                        args: { id: "dom", offset: -1 },
                      },
                      {
                        name: "read_qa_artifact",
                        args: { id: "dom", limit: 6001 },
                      },
                      { name: "read_qa_artifact", args: { id: "outside" } },
                    ],
                  },
          ),
          input_tokens: 10,
          output_tokens: 10,
          cost_usd: null,
        };
      },
    },
  });
  expect(result.incomplete).toBe(false);
  for (const reply of replies) {
    expect(reply[0].result).toMatchObject({
      text: "tail",
      offset: 6000,
      next_offset: null,
      truncated: false,
    });
    expect(reply.slice(1).every((row: any) => row.error)).toBe(true);
  }
});
it("does not promote observations when voters fail or cite nonexistent proof", async () => {
  const result = await verifyQaCandidate({
    ...options(),
    gateway: gateway(answer("reproduced", ["invented"])),
  });
  expect(result.finding).toBeUndefined();
  expect(result.incomplete).toBe(true);
  expect(
    result.votes.every(
      (vote) => vote.validation_note && vote.status === "completed",
    ),
  ).toBe(true);
});
it("requests schema repair for a live provider's browser_reproduced label without coercing it to evidence", async () => {
  const usage: any[] = [];
  const base = options();
  let repaired = 0;
  const result = await verifyQaCandidate({
    ...base,
    ledger: {
      ...base.ledger,
      settle: async (_reservation, row) => {
        usage.push(row);
      },
    },
    gateway: {
      complete: async (request) => {
        const disclosed = request.messages.find((m) =>
          m.content.includes("Verify the structured hypothesis"),
        );
        if (disclosed)
          expect(disclosed.content).toContain(
            "refuted, plausible, static_proven, or reproduced",
          );
        const repair = request.messages.some(
          (m) =>
            m.role === "assistant" &&
            m.content.includes('"browser_reproduced"'),
        );
        if (repair) repaired++;
        return {
          content: JSON.stringify({
            result: !disclosed
              ? [blind]
              : answer(repair ? "reproduced" : "browser_reproduced"),
          }),
          input_tokens: 100,
          output_tokens: 50,
          cost_usd: null,
        };
      },
    },
  });
  expect(repaired).toBe(3);
  expect(usage).toHaveLength(9);
  expect(result.finding?.evidence_level).toBe("reproduced");
  const invalid = await verifyQaCandidate({
    ...options(),
    gateway: gateway(answer("browser_reproduced")),
  });
  expect(invalid.finding).toBeUndefined();
  expect(invalid.votes.every((vote) => vote.status === "malformed")).toBe(true);
});
it("runs a separate recommendation quorum without proving the expected benefit", async () => {
  const p = pack();
  const rec = {
    ...structuredClone(fixture.qa.recommendations[0]),
    rule_id: criterion.id,
    journey: "checkout",
    steps: [2],
    cells: [cell],
    evidence: ["dom"],
    basis: {
      heuristic: {
        source: criterion.source.title,
        version: criterion.source.version,
        reference: criterion.source.url,
      },
    },
  } as any;
  const result = await verifyQaRecommendation({
    ...options(),
    candidate: rec,
    pack: p,
    context: {
      artifacts: p.artifacts as any,
      guidance,
      sourcePaths: ["checkout/page.tsx"],
      criteria: new Map([[criterion.id, criterion]]),
    },
    gateway: gateway({
      verdict: "support",
      evidence: ["dom"],
      rationale: "Duplicate entry is shown; an edit option addresses it.",
    }),
  });
  expect(
    result.candidate.verification_status,
    JSON.stringify(result.audit),
  ).toBe("supported");
  expect(result.candidate.rationale).toContain(
    "expected benefit remains untested",
  );
  expect(result.audit).toHaveLength(3);
});
it("integrates verified observations without applying the general cap", async () => {
  const p = pack(),
    o = options(),
    records = new Map();
  const result = await verifyQaReview({
    ...o,
    profile: { ...o.profile, max_defects: 0 },
    result: {
      observation_candidates: [candidate, candidate],
      hypotheses: [
        {
          ...candidate.finding.qa,
          rule_id: candidate.finding.rule_id,
          expected: candidate.expected,
          observed: candidate.observed,
          cell,
        },
      ],
      journey_outcomes: [
        {
          journey: "checkout",
          cell,
          verification_context: {
            journey: p.journey,
            guidance,
            criteria: p.criteria,
          },
        },
      ],
      evidence: { artifacts: metadata },
    },
    load: async (artifact) => p.loaded.get(artifact.id)!,
    save: async (key, value) => {
      records.set(key, value);
    },
    gateway: gateway(),
  });
  expect(result.findings, JSON.stringify([...records])).toHaveLength(1);
  expect(result.observations).toHaveLength(0);
  expect(result.incomplete).toBe(false);
  expect(records.has("verification.json")).toBe(true);
});

it("merges recommendation cells before voting so durable calls cannot reuse another cell's verdict", async () => {
  const p = pack(),
    desktop = { ...cell, viewport: "desktop" },
    requests: any[] = [];
  const raw: any = {
    ...structuredClone(fixture.qa.recommendations[0]),
    rule_id: criterion.id,
    journey: "checkout",
    steps: [2],
    cells: [cell],
    evidence: ["dom"],
    basis: {
      heuristic: {
        source: criterion.source.title,
        version: criterion.source.version,
        reference: criterion.source.url,
      },
    },
  };
  const allArtifacts = [
    ...metadata,
    ...metadata.map((row) => ({
      ...row,
      id: row.id + "-desktop",
      cell: desktop,
    })),
  ];
  const result = await verifyQaReview({
    ...options(),
    result: {
      qa_recommendations: [
        raw,
        { ...raw, cells: [desktop], evidence: ["dom-desktop"] },
      ],
      journey_outcomes: [cell, desktop].map((cell) => ({
        journey: "checkout",
        cell,
        verification_context: {
          journey: p.journey,
          guidance,
          criteria: p.criteria,
        },
      })),
      evidence: { artifacts: allArtifacts },
    },
    load: async (artifact) =>
      p.loaded.get(artifact.id.replace(/-desktop$/, ""))!,
    save: async () => {},
    gateway: gateway(
      {
        verdict: "support",
        evidence: ["dom", "dom-desktop"],
        rationale:
          "Repeated entry is observed in both cells; benefit of reuse remains untested.",
      },
      requests,
    ),
  });
  expect(requests).toHaveLength(6);
  expect(result.recommendations).toHaveLength(1);
  expect(result.recommendations[0].cells).toHaveLength(2);
  expect(result.recommendations[0].verification_status).toBe("supported");
});

it.each([
  ["reproduced", "refuted", "new"],
  ["reproduced", "reproduced", "pre-existing"],
  ["refuted", "reproduced", "fixed"],
  ["reproduced", "unfinished", "unclassified"],
  ["reproduced", "split", "unclassified"],
])(
  "classifies judged baseline observations from independent same-cell evidence (%s / %s)",
  async (headVerdict, baseVerdict, expected) => {
    const p = pack(),
      records = new Map(),
      loaded: string[] = [],
      calls: string[] = [];
    let baseVotes = 0;
    const raw = (version: string) => ({
      outcome: "complete",
      findings: [],
      observation_candidates:
        (version === "head" && expected === "fixed") ||
        (version === "base" && expected === "new")
          ? []
          : [candidate],
      journey_outcomes: [
        {
          journey: "checkout",
          cell,
          outcome:
            version === "base" && baseVerdict === "unfinished"
              ? "cancelled"
              : "passed",
          verification_context: {
            journey: p.journey,
            guidance,
            criteria: p.criteria,
          },
        },
      ],
      evidence: {
        artifacts: metadata.map((row) => ({
          ...row,
          id: `${version}-${row.id}`,
        })),
      },
    });
    const result = await verifyQaReview({
      ...options(),
      result: compareQaResults(raw("head"), raw("base")),
      load: async (artifact, version) => {
        loaded.push(`${version}:${artifact.id}`);
        return p.loaded.get(artifact.id.replace(/^(head|base)-/, ""))!;
      },
      save: async (key, value) => {
        records.set(key, value);
      },
      call: async (key, action) => {
        calls.push(key);
        return action();
      },
      gateway: {
        complete: async (request: any) => {
          const version = request.messages[0].content.startsWith(
            "Assess the base",
          )
            ? "base"
            : "head";
          let verdict = version === "base" ? baseVerdict : headVerdict;
          if (verdict === "split")
            verdict =
              request.messages.length === 1 || baseVotes++ > 0
                ? "reproduced"
                : "refuted";
          return {
            content: JSON.stringify({
              result:
                request.messages.length === 1
                  ? verdict === "refuted"
                    ? []
                    : [blind]
                  : answer(verdict, [
                      `${version}-trace`,
                      `${version}-after`,
                      `${version}-dom`,
                    ]),
            }),
            input_tokens: 10,
            output_tokens: 10,
            cost_usd: null,
          };
        },
      },
    });
    expect(result.findings, JSON.stringify([...records])).toHaveLength(1);
    expect(result.findings[0].state).toBe(expected);
    expect(result.findings[0].locations).toHaveLength(1);
    expect(result.findings[0].locations[0].occurrence_state).toBe(expected);
    expect(
      loaded.every(
        (entry) =>
          entry.startsWith("base:base-") || entry.startsWith("head:head-"),
      ),
    ).toBe(true);
    expect(new Set(calls).size).toBe(calls.length);
    if (baseVerdict !== "unfinished")
      expect(calls.some((key) => key.startsWith("qa-base-"))).toBe(true);
  },
);

it("keeps identical head/base artifact identities bound to their own run receipts", async () => {
  const p = pack(),
    head = {
      journey_outcomes: [
        {
          journey: "checkout",
          cell,
          verification_context: {
            journey: p.journey,
            guidance,
            criteria: p.criteria,
          },
        },
      ],
      evidence: {
        artifacts: metadata.map((row) => ({ ...row, key: `head/${row.id}` })),
      },
    };
  const base = {
    evidence: {
      artifacts: metadata.map((row) => ({ ...row, key: `base/${row.id}` })),
    },
  };
  const loaded: string[] = [];
  const result = await qaEvidencePack({
    result: compareQaResults(head, base),
    journey: "checkout",
    steps: [2],
    cell,
    load: async (artifact: any) => {
      loaded.push(artifact.key);
      return p.loaded.get(artifact.id)!;
    },
  });
  expect(result.artifacts.size).toBe(metadata.length);
  expect(loaded.every((key) => key.startsWith("head/"))).toBe(true);
});

it("validates baseline code proof against the base graph rather than head nodes", async () => {
  const code = (node: string) => ({
    evidence_level: "refuted",
    evidence: [
      {
        kind: "code",
        path: "src/a.ts",
        node_ids: [node],
        demonstrates: "protection",
      },
    ],
    rationale: "The selected snapshot protects the trigger.",
  });
  const wrong = await verifyQaCandidate({
    ...options(),
    version: "base",
    gateway: gateway(code("h")),
  });
  expect(wrong.finding).toBeUndefined();
  const base = await verifyQaCandidate({
    ...options(),
    version: "base",
    gateway: gateway(code("b")),
  });
  expect(base.finding?.evidence_level).toBe("refuted");
});

it("reuses one replay per hypothesis across cells and snapshots without transferring proof", async () => {
  let calls = 0;
  const replay = qaReplayRegistry(async () => {
    calls++;
    return {
      outcome: "recurred",
      evidence: ["trace", "after", "dom"],
      artifacts: metadata,
    };
  });
  const desktop = { ...candidate, cell: { ...cell, viewport: "desktop" } };
  const [first, second, baseline] = await Promise.all([
    replay(candidate, "head"),
    replay(desktop, "head"),
    replay(candidate, "base"),
  ]);
  expect(calls).toBe(1);
  expect(second).toEqual(first);
  expect(baseline).toEqual(first);
  const proof = {
    ...answer(),
    evidence: [
      {
        kind: "replay" as const,
        ids: ["trace", "after", "dom"],
        demonstrates: "regression" as const,
      },
    ],
  };
  expect(qaEvidenceLevel(proof, candidate, pack(), context, first)).toBe(
    "reproduced",
  );
  expect(
    qaEvidenceLevel(proof, desktop, pack(), context, second),
  ).toBeUndefined();
  expect(
    qaEvidenceLevel(proof, candidate, pack(), context, baseline, "base"),
  ).toBeUndefined();
  expect(
    qaEvidenceLevel(
      { ...proof, evidence_level: "refuted" },
      candidate,
      pack(),
      context,
      first,
    ),
  ).toBeUndefined();
});

it("puts the partition immediately before the blind pack's first data block", () => {
  const partition = "c".repeat(32);
  const plain = qaBlindPrompt(pack()),
    partitioned = qaBlindPrompt(pack(), partition);
  const element = `\n<review_partition id="${partition}"/>`;
  expect(partitioned.replace(element, "")).toBe(plain);
  expect(partitioned).toContain(`${element}\n<repository_data label="journey">`);
  expect(plain.indexOf("<repository_data")).toBe(
    partitioned.indexOf("<repository_data") - element.length,
  );
});

it("keeps a QA voter's screenshots inside the cached blind prefix on Anthropic routes", async () => {
  const bodies: any[] = [];
  const partition = "d".repeat(32);
  const provider = new ProviderGateway(
    { ANTHROPIC_API_KEY: "k" } as Env,
    (async (_url: unknown, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      return Response.json({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              result: body.messages.length === 1 ? [blind] : answer(),
            }),
          },
        ],
        usage: { input_tokens: 10, output_tokens: 10 },
      });
    }) as typeof fetch,
  );
  const o = options();
  o.profile.verify = { voters: 1, quorum: 1 };
  o.profile.models = { ...o.profile.models, verifier: "anthropic/claude-test" };
  await verifyQaCandidate({
    ...o,
    gateway: provider,
    prompt: { partition, cache: { classes: ["anthropic"] } },
  });
  expect(bodies.length).toBeGreaterThanOrEqual(2);
  const [first, second] = bodies;
  const blindMessage = first.messages[0].content;
  const images = blindMessage.filter((b: any) => b.type === "image");
  expect(images).toHaveLength(2);
  // The marker sits on the last screenshot; the text before it carries none.
  expect(blindMessage.at(-1)).toMatchObject({
    type: "image",
    cache_control: { type: "ephemeral" },
  });
  expect(blindMessage.filter((b: any) => b.cache_control)).toHaveLength(1);
  expect(JSON.stringify(blindMessage)).toContain(`<review_partition id=\\"${partition}\\"/>`);
  // The second request rereads the blind message, marker included, unchanged.
  expect(second.messages[0]).toEqual(first.messages[0]);
  expect(second.system).toEqual(first.system);
  expect(bodies.flatMap((b) => [JSON.stringify(b)]).join("")).not.toContain(
    "prompt_cache_key",
  );
});

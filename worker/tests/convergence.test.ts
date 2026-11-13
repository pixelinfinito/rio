import {
  env,
  applyD1Migrations,
  introspectWorkflowInstance,
} from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { Store } from "../src/storage";
import { finishJob } from "../src/jobs";
import {
  hash,
  validateFinding,
  validateHypotheses,
  validateReport,
} from "../src/validation";
import { classId, consolidate, triggerHash } from "../src/consolidate";
import type { Verified } from "../src/consolidate";
import { HISTORY_BYTES } from "../src/gateway";
import { allMigrations, hypothesis, profile, submission } from "./fixtures";
import lineageRound4 from "../../crates/rio-core/tests/fixtures/lineage-round4.json";
import type {
  ChangedFile,
  Env,
  File,
  Graph,
  Hypothesis,
  LineageRef,
  Submission,
} from "../src/types";
import { readJobInput, treeOf, uploadSnapshot } from "./snapshots";
import { jobInput } from "../src/archive";

const runtime = env as Env;
/** A pinned report as recorded with the active layout features (feature-on runs). */
const withLayout = (report: any) => {
  const features = (runtime.PROMPT_LAYOUT ?? "").split(",").filter(Boolean).sort();
  return {
    ...report,
    agent_audit: {
      ...report.agent_audit,
      prompt_cache: { ...report.agent_audit.prompt_cache, layout_features: features },
    },
  };
};
const headers = {
  authorization: "Bearer test-owner-token-at-least-32-characters",
  "content-type": "application/json",
};
beforeAll(async () => {
  await applyD1Migrations(runtime.DB, allMigrations);
});

type Files = Record<string, string>;
function tree(files: Files): Record<string, File> {
  return Object.fromEntries(
    Object.entries(files).map(([path, content]) => [
      path,
      { mode: 0o100644, content },
    ]),
  );
}
// One graph node per single-line `function name(){...}` declaration.
function graphOf(files: Files): Graph {
  const nodes = Object.entries(files).flatMap(([path, content]) =>
    content.split("\n").flatMap((line, i) => {
      const name = /^function (\w+)/.exec(line)?.[1];
      return name
        ? [
            {
              id: `${path}#${name}`,
              path,
              symbol_path: name,
              line_start: i + 1,
              line_end: i + 1,
            },
          ]
        : [];
    }),
  );
  return { nodes, edges: [] };
}
function changes(base: Files, head: Files): ChangedFile[] {
  return [...new Set([...Object.keys(base), ...Object.keys(head)])]
    .filter((p) => base[p] !== head[p])
    .sort()
    .map((path) => ({ path, lines_changed: 1 }));
}
function hyp(
  path: string,
  symbol: string,
  line: number,
  rule = "correctness/throw",
  trigger = `${symbol}()`,
): Hypothesis {
  return {
    ...structuredClone(hypothesis),
    rule_id: rule,
    location: {
      path,
      line_start: line,
      line_end: line,
      symbol_path: symbol,
      occurrence_state: "new",
    },
    message: `The call to ${symbol} now throws`,
    trigger,
  };
}
const idOf = (h: Hypothesis) => validateHypotheses([h])[0].id;
function block(content: string, label: string): any {
  const start = content.indexOf(`<repository_data label="${label}">\n`);
  if (start < 0) return undefined;
  const from = content.indexOf("\n", start) + 1;
  return JSON.parse(
    content.slice(from, content.indexOf("\n</repository_data>", from)),
  );
}
// Lineage reports validate against report-v1 as emitted, and every finding
// against finding-v1.
function validLineageReport(report: any) {
  const lists = [report.findings, report.risks, report.security ?? []].flat();
  for (const f of lists) validateFinding(f);
  validateReport(report);
}

interface Round {
  base: Files;
  head: Files;
  lineage?: LineageRef;
  agents?: (prompt: string) => Hypothesis[];
  votes?: "prove" | "malformed" | ((h: any) => "prove" | "refute");
  steps?: Submission["profile"]["steps"];
  mutate?: (s: Submission) => void;
  // Called once the workflow is running, for runner-backed steps.
  during?: (id: string, instance: any) => Promise<void>;
}
// The scripted agents answer differently for identical hunks across rounds;
// the agent result cache (tested in cache.test.ts) would replay them.
const agentSteps = [
  { id: "agents", uses: "rio/agents@0.1.0", needs: [], with: { cache: false } },
  { id: "verify", uses: "rio/verify@0.1.0", needs: ["agents"], with: {} },
];
async function review(round: Round) {
  const prompts: string[] = [];
  const transport = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const body = JSON.parse(init!.body as string);
      const text = body.messages.map((m: any) => m.content).join("\n");
      const generated = text.includes("Review the change independently");
      const disclosed = text.includes("Verify this hypothesis.");
      let result: any = [];
      if (generated) {
        prompts.push(text);
        result = round.agents?.(text) ?? [];
      } else if (disclosed) {
        const h = block(
          body.messages.at(-1).content.includes("Verify this hypothesis.")
            ? body.messages.at(-1).content
            : text,
          "hypothesis",
        );
        const verdict =
          typeof round.votes === "function"
            ? round.votes(h)
            : (round.votes ?? "prove");
        const cited = {
          kind: "code",
          version: "head",
          path: h.location.path,
          node_ids: [`${h.location.path}#${h.location.symbol_path}`],
        };
        result =
          verdict === "malformed"
            ? "malformed"
            : verdict === "refute"
              ? {
                  evidence_level: "refuted",
                  evidence: [{ ...cited, demonstrates: "protection" }],
                }
              : {
                  evidence_level: "static_proven",
                  evidence: [{ ...cited, demonstrates: "regression" }],
                };
      }
      const content =
        result === "malformed"
          ? "malformed answer"
          : JSON.stringify({ result });
      return Response.json(
        String(input).includes("anthropic")
          ? {
              content: [{ type: "text", text: content }],
              usage: { input_tokens: 80, output_tokens: 50 },
            }
          : {
              choices: [{ message: { content } }],
              usage: { prompt_tokens: 80, completion_tokens: 50 },
            },
      );
    });
  try {
    const snapshot = { base: tree(round.base), head: tree(round.head) };
    const uploaded = await uploadSnapshot(
      (path, method, body) =>
        app.request(`https://rio${path}`, { method, headers, body }, runtime),
      snapshot,
    );
    const snapshotId = ((await uploaded.json()) as any).id as string;
    const s = submission();
    s.snapshot_id = snapshotId;
    s.graphs = { base: graphOf(round.base), head: graphOf(round.head) };
    s.changed = changes(round.base, round.head);
    s.profile.steps = round.steps ?? structuredClone(agentSteps);
    if (round.lineage) s.lineage = round.lineage;
    round.mutate?.(s);
    const response = await app.request(
      "https://rio/v1/reviews",
      { method: "POST", headers, body: JSON.stringify(s) },
      runtime,
    );
    expect(await response.clone().text()).not.toContain("invalid");
    expect(response.status).toBe(202);
    const { id } = (await response.json()) as any;
    await using instance = await introspectWorkflowInstance(
      runtime.REVIEWS,
      id,
    );
    await round.during?.(id, instance);
    await instance.waitForStatus("complete");
    const row = await runtime.DB.prepare(
      "SELECT status,report_key FROM reviews WHERE id=?",
    )
      .bind(id)
      .first<any>();
    const report = await new Store(runtime).get<any>(row.report_key);
    return { id, snapshotId, report, prompts, status: row.status };
  } finally {
    transport.mockRestore();
  }
}
async function rows(where: string, ...values: unknown[]) {
  return (
    await runtime.DB.prepare(
      `SELECT * FROM findings WHERE ${where} ORDER BY identity`,
    )
      .bind(...values)
      .all<any>()
  ).results;
}
async function lineageState(ref: LineageRef) {
  const response = await app.request(
    `https://rio/v1/lineages?${new URLSearchParams({ repository: ref.repository, kind: ref.kind, ref: ref.ref })}`,
    { headers },
    runtime,
  );
  return { status: response.status, body: (await response.json()) as any };
}
const fullReview = (s: Submission) => {
  s.profile.rounds = { cap: 3, diff_only_after: 10 };
};

describe("class-level findings", () => {
  function instances(n: number): Verified[] {
    return Array.from({ length: n }, (_, i) => {
      const h = validateHypotheses([
        hyp(
          `src/f${i}.ts`,
          `f${i}`,
          i + 1,
          "correctness/unchecked-error",
          "err ignored",
        ),
      ])[0];
      return {
        hypothesis: { ...h, message: "unchecked error from fetch" },
        evidence_level: "static_proven",
        verification: {
          voters: 3,
          agreeing: 3,
          blind_match: ["none", "none", "none"],
          split: false,
        },
        evidence: [`code:head:src/f${i}.ts:n${i}`],
      };
    });
  }
  it("keeps three instances as separate findings at the default threshold", () => {
    const result = consolidate(instances(3), structuredClone(profile));
    expect(result.defects).toHaveLength(3);
    expect(new Set(result.defects.map((f) => f.id)).size).toBe(3);
    expect(result.audit.classes).toEqual({});
  });
  it("merges five instances into one class finding with every location", () => {
    const verified = instances(5);
    const result = consolidate(verified, structuredClone(profile));
    expect(result.defects).toHaveLength(1);
    const f = result.defects[0];
    const expected = classId(
      "correctness/unchecked-error",
      triggerHash("err ignored"),
    );
    expect(expected).toBe(
      hash(`correctness/unchecked-error|class|${hash("err ignored")}`),
    );
    expect(f.id).toBe(expected);
    expect(f.locations.map((l) => l.path)).toEqual(
      [0, 1, 2, 3, 4].map((i) => `src/f${i}.ts`),
    );
    // Each instance keeps its own identity inside the class finding.
    expect(new Set(f.locations.map((l) => l.id)).size).toBe(5);
    expect(f.locations.every((l) => l.id && l.id !== f.id)).toBe(true);
    expect(f.message).toBe(
      "5 occurrences of unchecked error from fetch; fix the pattern, for example at src/f0.ts:1",
    );
    expect(f.evidence).toHaveLength(5);
    expect(result.audit.classes[f.id]).toEqual(
      verified.map((v) => v.hypothesis.id),
    );
    expect(() => validateFinding(f)).not.toThrow();
    // A suppression of the class suppresses every instance.
    const suppressing = structuredClone(profile);
    suppressing.suppress = [{ finding: expected }];
    const suppressed = consolidate(instances(5), suppressing);
    expect(suppressed.defects).toEqual([]);
    expect(suppressed.audit.suppressed).toBe(5);
    // The threshold is a consolidation option.
    expect(
      consolidate(instances(3), structuredClone(profile), {
        classThreshold: 2,
      }).defects,
    ).toHaveLength(1);
  });
});

describe("verification", () => {
  it("verifies hypotheses three at a time, each batch before the next", async () => {
    const names = ["a", "b", "c", "d", "e"];
    const files = (body: string) =>
      Object.fromEntries(
        names.map((n) => [`src/${n}.ts`, `function ${n}(){ ${body} }\n`]),
      );
    const raised = names.map((n) =>
      hyp(`src/${n}.ts`, n, 1, `correctness/throw-${n}`),
    );
    const r = await review({
      base: files("return 0;"),
      head: files("throw new Error();"),
      agents: () => raised,
      // Tokens for the voters of three hypotheses at once.
      mutate: (s) => {
        s.profile.budget.fast.tokens = 9 * HISTORY_BYTES + 60_000;
      },
    });
    expect(r.report.findings.map((f: any) => f.id).sort()).toEqual(
      raised.map(idOf).sort(),
    );
    // Every model call of the voters, in the order the calls were made.
    const calls = (
      await runtime.DB.prepare(
        "SELECT actor,phase FROM usage WHERE review_id=? AND phase LIKE 'verify-%' ORDER BY rowid",
      )
        .bind(r.id)
        .all<{ actor: string; phase: string }>()
    ).results.map((u) => ({
      name: names[raised.findIndex((h) => u.actor.startsWith(idOf(h)))],
      blind: u.phase === "verify-blind",
    }));
    expect(calls).toHaveLength(30);
    const first = (name: string, blind: boolean) =>
        calls.findIndex((c) => c.name === name && c.blind === blind),
      last = (name: string) => calls.findLastIndex((c) => c.name === name);
    // The first three are verified together: the third is asked its blind
    // question before the first is told its hypothesis.
    expect(first("c", true)).toBeLessThan(first("a", false));
    // The fourth starts only when all three have ended.
    expect(Math.max(last("a"), last("b"), last("c"))).toBeLessThan(
      first("d", true),
    );
    expect(first("e", true)).toBeLessThan(first("d", false));
  });
});

describe("finding-v1 lifecycle keys", () => {
  const base = {
    id: "a".repeat(64),
    rule_id: "correctness/throw",
    category: "defect",
    evidence_level: "static_proven",
    severity: "error",
    state: "new",
    location: {
      path: "src/a.ts",
      line_start: 1,
      line_end: 1,
      symbol_path: "a",
      occurrence_state: "new",
    },
    message: "The call now throws",
    trigger: "a()",
    evidence: [],
    source: { agent: "correctness" },
    locations: [
      {
        path: "src/a.ts",
        line_start: 1,
        line_end: 1,
        symbol_path: "a",
        occurrence_state: "new",
      },
    ],
  };
  it("accepts findings with and without lineage keys", () => {
    expect(() => validateFinding(base)).not.toThrow();
    expect(() =>
      validateFinding({
        ...base,
        round: 2,
        first_posted_in: "b".repeat(64),
        status: "dismissed",
        resolution: { note: "did not reproduce" },
        author_response: {
          reason: "intentional",
          actor: "octocat",
          at: "2026-11-05T10:00:00Z",
        },
      }),
    ).not.toThrow();
  });
  it("rejects state dismissed and the draft reason known", () => {
    expect(() => validateFinding({ ...base, state: "dismissed" })).toThrow();
    expect(() =>
      validateFinding({
        ...base,
        author_response: {
          reason: "known",
          actor: "octocat",
          at: "2026-11-05T10:00:00Z",
        },
      }),
    ).toThrow();
    expect(() => validateFinding({ ...base, status: "closed" })).toThrow();
  });
});

describe("review lineages", () => {
  it("assigns rounds across force-pushes and empty rounds, records rounds_to_pass, resets, and leaves plain reviews without a round", async () => {
    const ref: LineageRef = {
      repository: "github.com/acme/app",
      kind: "branch",
      ref: "feature/rounds",
    };
    const base = {
      "src/a.ts": "function a(){ return 0; }\n",
      "src/b.ts": "function b(){ return 0; }\n",
    };
    const h1 = hyp("src/a.ts", "a", 1),
      h2 = hyp("src/b.ts", "b", 1);
    const r1 = await review({
      base,
      head: { ...base, "src/a.ts": "function a(){ throw new Error(); }\n" },
      lineage: ref,
      agents: () => [h1],
      mutate: fullReview,
    });
    expect(r1.report.lineage).toMatchObject({
      generation: 1,
      round: 1,
      cap: 3,
      capped: false,
      diff_only: false,
      previous_head: null,
      held_back: 0,
      rounds_to_pass: null,
    });
    expect(r1.report.findings).toHaveLength(1);
    expect(r1.report.findings[0]).toMatchObject({
      id: idOf(h1),
      round: 1,
      first_posted_in: r1.snapshotId,
      status: "open",
    });
    validLineageReport(r1.report);
    // 2.3: one findings row per finding of the finished lineage review.
    expect(await rows("review_id=?", r1.id)).toHaveLength(1);
    // Force-push: a rebased history (different base) with nothing to report.
    const rebased = { ...base, "src/c.ts": "function c(){ return 0; }\n" };
    const r2 = await review({
      base: rebased,
      head: {
        ...rebased,
        "src/a.ts": "function a(){ throw new Error(); }\n",
      },
      lineage: ref,
      agents: () => [],
      mutate: fullReview,
    });
    expect(r2.report.lineage).toMatchObject({
      round: 2,
      previous_head: r1.snapshotId,
    });
    expect(r2.report.findings).toEqual([]);
    const r3 = await review({
      base,
      head: {
        "src/a.ts": "function a(){ throw new Error(); }\n",
        "src/b.ts": "function b(){ throw new Error(); }\n",
      },
      lineage: ref,
      agents: () => [h2],
      mutate: fullReview,
    });
    // The empty second review did not consume a round.
    expect(r3.report.lineage.round).toBe(2);
    expect(r3.report.lineage.rounds_to_pass).toBeNull();
    expect(r3.report.findings.map((f: any) => f.round)).toEqual([2]);
    const r4 = await review({
      base,
      head: {
        "src/a.ts": "function a(){ return 1; }\n",
        "src/b.ts": "function b(){ return 1; }\n",
      },
      lineage: ref,
      agents: () => [],
      mutate: fullReview,
    });
    expect(r4.report.lineage).toMatchObject({ round: 3, rounds_to_pass: 3 });
    const state = await lineageState(ref);
    expect(state.status).toBe(200);
    expect(state.body).toEqual({
      ...ref,
      generation: 1,
      round: 3,
      previous_head: r4.snapshotId,
      posted: [idOf(h1), idOf(h2)].sort(),
      rounds_to_pass: 3,
    });
    // A reset starts a new generation at round 1 that publishes normally.
    const r5 = await review({
      base,
      head: { ...base, "src/a.ts": "function a(){ throw new Error(); }\n" },
      lineage: { ...ref, reset: true },
      agents: () => [h1],
      mutate: fullReview,
    });
    expect(r5.report.lineage).toMatchObject({
      generation: 2,
      round: 1,
      held_back: 0,
      previous_head: null,
    });
    expect(r5.report.findings[0].first_posted_in).toBe(r5.snapshotId);
    // A review without a lineage reference has no round and writes no rows.
    const r6 = await review({
      base,
      head: { ...base, "src/a.ts": "function a(){ throw new Error(); }\n" },
      agents: () => [h1],
    });
    expect(r6.report.lineage).toBeUndefined();
    expect(r6.report.findings).toHaveLength(1);
    for (const key of ["round", "first_posted_in", "status", "author_response"])
      expect(r6.report.findings[0]).not.toHaveProperty(key);
    expect(await rows("review_id=?", r6.id)).toEqual([]);
    expect(() => validateReport(r6.report)).not.toThrow();
  }, 120000);

  it("does not re-run agents when the head is unchanged since the previous round", async () => {
    const ref: LineageRef = {
      repository: "github.com/acme/unchanged",
      kind: "branch",
      ref: "main",
    };
    const base = { "src/a.ts": "function a(){ return 0; }\n" };
    const head = { "src/a.ts": "function a(){ throw new Error(); }\n" };
    const h1 = hyp("src/a.ts", "a", 1);
    const r1 = await review({ base, head, lineage: ref, agents: () => [h1] });
    expect(r1.report.findings.map((f: any) => f.id)).toEqual([idOf(h1)]);
    const r2 = await review({
      base,
      head,
      lineage: ref,
      agents: () => {
        throw new Error("agents must not run on an unchanged head");
      },
    });
    expect(r2.status).toBe("complete");
    expect(r2.prompts).toHaveLength(0);
    expect(r2.report.footer.notes).toContain(
      "No change since the previously reviewed head; agents were not re-run and earlier findings carry forward.",
    );
    // The open finding carries forward without new votes and is held back.
    expect(r2.report.findings.map((f: any) => [f.id, f.status])).toEqual([
      [idOf(h1), "open"],
    ]);
    expect(r2.report.lineage).toMatchObject({
      round: 2,
      diff_only: true,
      held_back: 1,
    });
    const votes = await runtime.DB.prepare(
      "SELECT COUNT(*) AS n FROM votes WHERE review_id=?",
    )
      .bind(r2.id)
      .first<any>();
    expect(votes.n).toBe(0);
  });
  it("gives round-2 agents only the incremental diff, re-verifies only moved findings and holds back reproductions", async () => {
    const ref: LineageRef = {
      repository: "github.com/acme/app",
      kind: "pr",
      ref: "42",
    };
    const base = {
      "src/a.ts": "function a(){ return 0; }\n",
      "src/b.ts": "function b(){ return 1; }\n",
      "src/c.ts": "function c(){ return 2; }\n",
    };
    const head1 = {
      "src/a.ts": "function a(){ throw new Error(); }\n",
      "src/b.ts": "function b(){ return 2; }\n",
      "src/c.ts": "function c(){ throw new Error(); }\n",
    };
    const h1 = hyp("src/a.ts", "a", 1),
      h2 = hyp("src/c.ts", "c", 1);
    const r1 = await review({
      base,
      head: head1,
      lineage: ref,
      agents: () => [h1, h2],
    });
    expect(r1.report.findings.map((f: any) => f.id).sort()).toEqual(
      [idOf(h1), idOf(h2)].sort(),
    );
    const head2 = {
      ...head1,
      "src/a.ts":
        "// moved down\n// by two lines\nfunction a(){ throw new Error(); }\n",
    };
    const checksReport = {
      ...submission().report,
      checks: ["src/a.ts", "src/b.ts", "src/c.ts"].map((path) => ({
        kind: "typecheck",
        language: "typescript",
        root: path.split("/").slice(0, -1).join("/"),
        version: "head",
        scheduled_as: "changed",
        outcome: "passed",
        wall_time_ms: 1,
        findings: [],
      })),
    };
    let payload: any;
    const r2 = await review({
      base,
      head: head2,
      lineage: ref,
      // The agent reproduces round 1's finding at shifted lines.
      agents: () => [hyp("src/a.ts", "a", 3)],
      steps: [
        { id: "checks", uses: "rio/checks@0.1.0", needs: [], with: {} },
        {
          id: "agents",
          uses: "rio/agents@0.1.0",
          needs: ["checks"],
          with: {},
        },
        { id: "verify", uses: "rio/verify@0.1.0", needs: ["agents"], with: {} },
      ],
      during: async (id, instance) => {
        const job = hash(`${id}-checks`).slice(0, 32);
        await instance.waitForStepResult({ name: `dispatch-${job}` });
        const row = await runtime.DB.prepare(
          "SELECT payload_key FROM jobs WHERE id=?",
        )
          .bind(job)
          .first<any>();
        payload = await new Store(runtime).get<any>(row.payload_key);
        await finishJob(runtime, id, job, 1, {
          job_id: job,
          attempt: 1,
          version: "head",
          exit_code: 0,
          stdout: "",
          stderr: "",
          timed_out: false,
          truncated: false,
          artifact: {
            report: checksReport,
            graphs: { base: graphOf(base), head: graphOf(head2) },
          },
        });
      },
    });
    expect(r2.status).toBe("complete");
    // Checks still run against the original base, not the previous head.
    expect(payload.snapshot).toBeUndefined();
    const input = await readJobInput(await jobInput(runtime, payload));
    expect(treeOf(input.files, "base")).toEqual(tree(base));
    expect(treeOf(input.files, "head")).toEqual(tree(head2));
    expect(r2.report.checks.map((c: any) => c.version)).toEqual([
      "head",
      "head",
      "head",
    ]);
    // Agents receive only the previous-head -> new-head diff plus prior findings.
    expect(r2.prompts).toHaveLength(1);
    const excerpts = block(r2.prompts[0], "change diff");
    expect(excerpts.map((e: any) => e.path)).toEqual(["src/a.ts"]);
    expect(excerpts[0].diff).toBe(
      "@@ -1,0 +1,2 @@\n1 +// moved down\n2 +// by two lines\n3  function a(){ throw new Error(); }",
    );
    expect(block(r2.prompts[0], "suggested_focus")).toEqual(["src/a.ts"]);
    expect(
      block(r2.prompts[0], "previous round findings")
        .map((f: any) => [f.id, f.status])
        .sort(),
    ).toEqual(
      [
        [idOf(h1), "open"],
        [idOf(h2), "open"],
      ].sort(),
    );
    expect(block(r1.prompts[0], "previous round findings")).toBeUndefined();
    // Voters run only for the moved finding; the unchanged one keeps its verification.
    const votes = await runtime.DB.prepare(
      "SELECT hypothesis_id FROM votes WHERE review_id=?",
    )
      .bind(r2.id)
      .all<any>();
    expect(votes.results.map((v) => v.hypothesis_id)).toEqual([
      idOf(h1),
      idOf(h1),
      idOf(h1),
    ]);
    expect(r2.report.agent_audit.diff_only).toEqual({
      reverified: [idOf(h1)],
      carried: [idOf(h2)],
      not_reverified: [],
    });
    // Both identities were posted in round 1: held back, still listed and counted.
    expect(r2.report.lineage).toMatchObject({
      round: 2,
      diff_only: true,
      previous_head: r1.snapshotId,
      held_back: 2,
    });
    expect(r2.report.agent_audit.already_posted).toEqual(
      [idOf(h1), idOf(h2)].sort(),
    );
    const moved = r2.report.findings.find((f: any) => f.id === idOf(h1));
    expect(moved).toMatchObject({
      round: 2,
      first_posted_in: r1.snapshotId,
      status: "open",
      location: { line_start: 3 },
    });
    validLineageReport(r2.report);
  }, 120000);

  it.each([false, true])(
    "keeps the full report but summarizes agent findings above the cap (max_lines exceeded: %s)",
    async (oversized) => {
      const ref: LineageRef = {
        repository: "github.com/acme/app",
        kind: "branch",
        ref: `feature/cap-${oversized}`,
      };
      const base = {
        "src/a.ts": "function a(){ return 0; }\n",
        "lib/b.ts": "function b(){ return 0; }\n",
      };
      const head = {
        "src/a.ts": "function a(){ throw new Error(); }\n",
        "lib/b.ts": "function b(){ throw new Error(); }\n",
      };
      const h1 = hyp("src/a.ts", "a", 1),
        h3 = hyp("lib/b.ts", "b", 1, "correctness/null");
      const r1 = await review({
        base,
        head,
        lineage: ref,
        agents: () => [h1],
        mutate: fullReview,
      });
      expect(r1.report.lineage.round).toBe(1);
      // Rounds 2 and 3 posted findings (recorded directly to reach round 4).
      const lineage = await runtime.DB.prepare(
        "SELECT lineage_id,generation FROM lineage_reviews WHERE review_id=?",
      )
        .bind(r1.id)
        .first<any>();
      for (const n of [2, 3])
        await runtime.DB.prepare(
          "INSERT INTO lineage_reviews(review_id,tenant,lineage_id,generation,snapshot_id,round,reviewed,posted,created_at) VALUES(?,?,?,?,?,?,0,1,?)",
        )
          .bind(
            crypto.randomUUID(),
            "owner",
            lineage.lineage_id,
            lineage.generation,
            r1.snapshotId,
            n,
            Date.now(),
          )
          .run();
      const typeError = {
        id: hash(`type-error-${oversized}`),
        rule_id: "typescript/TS2322",
        category: "defect",
        evidence_level: "static_proven",
        severity: "error",
        state: "new",
        location: {
          path: "lib/b.ts",
          line_start: 1,
          line_end: 1,
          symbol_path: "b",
          occurrence_state: "new",
        },
        message: "Type 'string' is not assignable to type 'number'.",
        trigger: "b()",
        evidence: [],
        source: { tool: "tsc", version: "5.9.3" },
        locations: [
          {
            path: "lib/b.ts",
            line_start: 1,
            line_end: 1,
            symbol_path: "b",
            occurrence_state: "new",
          },
        ],
      };
      const r4 = await review({
        base,
        head,
        lineage: ref,
        agents: () => [h1, h3],
        mutate: (s) => {
          fullReview(s);
          s.profile.max_lines = oversized ? 1 : 100000;
          s.changed = s.changed.map((f) => ({ ...f, lines_changed: 5 }));
          s.report.findings = [typeError];
          s.report.checks = [
            {
              kind: "typecheck",
              language: "typescript",
              root: ".",
              version: "head",
              scheduled_as: "changed",
              outcome: "findings",
              wall_time_ms: 1,
              findings: [typeError],
            },
          ];
        },
      });
      const report = r4.report;
      expect(report.lineage).toMatchObject({
        round: 4,
        cap: 3,
        capped: true,
        held_back: 1,
      });
      // The full report lists the two agent findings and the type error.
      expect(report.findings.map((f: any) => f.id).sort()).toEqual(
        [typeError.id, idOf(h1), idOf(h3)].sort(),
      );
      const byId = new Map(report.findings.map((f: any) => [f.id, f]));
      // Deterministic findings are always published; new agent findings are not.
      expect(byId.get(typeError.id)).toMatchObject({
        first_posted_in: r4.snapshotId,
        status: "open",
        round: 4,
      });
      expect(byId.get(idOf(h3))).toMatchObject({ round: 4 });
      expect(byId.get(idOf(h3))).not.toHaveProperty("first_posted_in");
      expect(byId.get(idOf(h1))).toMatchObject({
        first_posted_in: r1.snapshotId,
      });
      expect(report.lineage.reconsider.unresolved).toBe(2);
      expect(report.lineage.reconsider.top).toEqual(
        [h1, h3]
          .map((h) => ({
            id: idOf(h),
            title: h.message,
            path: h.location.path,
            line_start: 1,
          }))
          .sort((a, b) => a.path.localeCompare(b.path)),
      );
      if (oversized)
        expect(report.lineage.reconsider.split).toEqual([
          "lib (1 file, 5 lines)",
          "src (1 file, 5 lines)",
        ]);
      else expect(report.lineage.reconsider).not.toHaveProperty("split");
      validLineageReport(report);
      const state = await lineageState(ref);
      expect(state.body.posted).toEqual([idOf(h1), typeError.id].sort());
    },
    120000,
  );
});

describe("auto-resolution", () => {
  const base = {
    "src/a.ts": "function a(){ return 0; }\n",
    "src/b.ts": "function b(){ return 0; }\n",
  };
  const head = { ...base, "src/a.ts": "function a(){ throw new Error(); }\n" };
  const h1 = hyp("src/a.ts", "a", 1);
  const ref = (name: string): LineageRef => ({
    repository: "github.com/acme/resolve",
    kind: "branch",
    ref: name,
  });
  async function finding(lineage: LineageRef, id: string) {
    return (
      await rows(
        "identity=? AND lineage_id=(SELECT id FROM lineages WHERE ref=? AND repository=?)",
        id,
        lineage.ref,
        lineage.repository,
      )
    )[0];
  }
  it("marks a finding fixed when a complete review changed its code and no longer produces it", async () => {
    const lineage = ref("fixed");
    await review({
      base,
      head,
      lineage,
      agents: () => [h1],
      mutate: fullReview,
    });
    const r2 = await review({
      base,
      head: { ...base, "src/a.ts": "function a(){ return 1; }\n" },
      lineage,
      agents: () => [],
      mutate: fullReview,
    });
    const row = await finding(lineage, idOf(h1));
    expect(row.status).toBe("fixed");
    expect(JSON.parse(row.resolution_json)).toEqual({
      fixed_in: r2.snapshotId,
    });
    expect(r2.report.agent_audit.lineage_updates).toEqual([
      {
        id: idOf(h1),
        status: "fixed",
        resolution: { fixed_in: r2.snapshotId },
      },
    ]);
  }, 120000);
  it("keeps a finding open when the later review has incomplete votes", async () => {
    const lineage = ref("incomplete");
    await review({
      base,
      head,
      lineage,
      agents: () => [h1],
      mutate: fullReview,
    });
    const r2 = await review({
      base,
      head: { ...base, "src/a.ts": "function a(){ return 1; }\n" },
      lineage,
      agents: () => [hyp("src/a.ts", "a", 1, "correctness/other")],
      votes: "malformed",
      mutate: fullReview,
    });
    expect(r2.report.status).toBe("incomplete");
    const row = await finding(lineage, idOf(h1));
    expect(row.status).toBe("open");
    expect(JSON.parse(row.resolution_json)).toEqual({
      note: "not re-assessed",
    });
  }, 120000);
  it("keeps a type error open when its covering check fails, and fixes it once the check succeeds", async () => {
    const lineage = ref("failed-check");
    const typeError = {
      id: hash("resolve-type-error"),
      rule_id: "typescript/TS2322",
      category: "defect",
      evidence_level: "static_proven",
      severity: "error",
      state: "new",
      location: {
        path: "src/a.ts",
        line_start: 1,
        line_end: 1,
        symbol_path: "a",
        occurrence_state: "new",
      },
      message: "Type 'string' is not assignable to type 'number'.",
      trigger: "a()",
      evidence: [],
      source: { tool: "tsc", version: "5.9.3" },
      locations: [
        {
          path: "src/a.ts",
          line_start: 1,
          line_end: 1,
          symbol_path: "a",
          occurrence_state: "new",
        },
      ],
    };
    const check = (outcome: string, findings: any[]) => ({
      kind: "typecheck",
      language: "typescript",
      root: ".",
      version: "head",
      scheduled_as: "changed",
      outcome,
      wall_time_ms: 1,
      findings,
      ...(outcome === "failed" ? { reason: "tool_crashed" } : {}),
    });
    const deterministic = (outcome: string, findings: any[]) => ({
      steps: [],
      mutate: (s: Submission) => {
        s.report.findings = findings;
        s.report.checks = [check(outcome, findings)];
      },
    });
    const r1 = await review({
      base,
      head,
      lineage,
      ...deterministic("findings", [typeError]),
    });
    expect(r1.report.findings[0]).toMatchObject({
      round: 1,
      status: "open",
      first_posted_in: r1.snapshotId,
    });
    const edited = {
      ...base,
      "src/a.ts": "function a(){ return 'x'; }\n",
    };
    await review({
      base,
      head: edited,
      lineage,
      ...deterministic("failed", []),
    });
    let row = await finding(lineage, typeError.id);
    expect(row.status).toBe("open");
    expect(JSON.parse(row.resolution_json)).toEqual({
      note: "not re-assessed",
    });
    const r3 = await review({
      base,
      head: edited,
      lineage,
      ...deterministic("passed", []),
    });
    row = await finding(lineage, typeError.id);
    expect(row.status).toBe("fixed");
    expect(JSON.parse(row.resolution_json)).toEqual({
      fixed_in: r3.snapshotId,
    });
  }, 120000);
  it("keeps a finding open as not reproduced when its code is unchanged", async () => {
    const lineage = ref("unchanged");
    await review({
      base,
      head,
      lineage,
      agents: () => [h1],
      mutate: fullReview,
    });
    const r2 = await review({
      base,
      head: { ...head, "src/b.ts": "function b(){ return 1; }\n" },
      lineage,
      agents: () => [],
      mutate: fullReview,
    });
    expect(r2.report.status).toBe("complete");
    const row = await finding(lineage, idOf(h1));
    expect(row.status).toBe("open");
    expect(JSON.parse(row.resolution_json)).toEqual({
      note: "did not reproduce",
    });
    expect(r2.report.lineage.rounds_to_pass).toBeNull();
  }, 120000);
});

// Pinned review output is free of per-run values: response timestamps become a
// fixed valid date-time, review and run ids and the deployed Rio version become
// placeholders. Snapshot ids are content hashes of fixed trees, and recorded
// usage is constant, so both stay.
function normalize(report: any): any {
  const walk = (value: any): any =>
    Array.isArray(value)
      ? value.map(walk)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value).map(([k, v]) => [
              k,
              k === "at" && typeof v === "string"
                ? "1970-01-01T00:00:00.000Z"
                : walk(v),
            ]),
          )
        : value;
  const result = walk(report);
  for (const [key, placeholder] of [
    ["id", "<review-id>"],
    ["run_id", "<run-id>"],
    ["rio_version", "<rio-version>"],
  ])
    if (result.review && key in result.review) result.review[key] = placeholder;
  return result;
}

describe("end-to-end lineage", () => {
  it("converges through four recorded rounds: held back, auto-fixed, dismissed and capped", async () => {
    const ref: LineageRef = {
      repository: "github.com/acme/e2e",
      kind: "branch",
      ref: "feature/e2e",
    };
    const base = {
      "src/a.ts": "function a(){ return 0; }\n",
      "src/b.ts": "function b(){ return 0; }\n",
      "src/c.ts": "function c(){ return 0; }\n",
    };
    const throws = (name: string) =>
      `function ${name}(){ throw new Error(); }\n`;
    const head1 = {
      "src/a.ts": throws("a"),
      "src/b.ts": throws("b"),
      "src/c.ts": "function c(){ return 'zero'; }\n",
    };
    const head2 = {
      ...head1,
      "src/a.ts": `// moved\n// down\n${throws("a")}`,
      "src/b.ts": "function b(){ if (ready) throw new Error(); }\n",
    };
    const head3 = { ...head2, "src/d.ts": throws("d") };
    const head4 = { ...head3, "src/e.ts": throws("e") };
    const ha = hyp("src/a.ts", "a", 1),
      hb = hyp("src/b.ts", "b", 1),
      hd = hyp("src/d.ts", "d", 1),
      he = hyp("src/e.ts", "e", 1);
    const location = {
      path: "src/c.ts",
      line_start: 1,
      line_end: 1,
      symbol_path: "c",
      occurrence_state: "new",
    };
    const typeError = {
      id: hash("e2e-type-error"),
      rule_id: "typescript/TS2322",
      category: "defect",
      evidence_level: "static_proven",
      severity: "error",
      state: "new",
      location,
      message: "Type 'string' is not assignable to type 'number'.",
      trigger: "c()",
      evidence: [],
      source: { tool: "tsc", version: "5.9.3" },
      locations: [location],
    };
    const lineageRound = (s: Submission) => {
      s.profile.rounds = { cap: 3, diff_only_after: 1 };
      s.profile.max_lines = 100000;
      s.report.findings = [structuredClone(typeError)];
      s.report.checks = [
        {
          kind: "typecheck",
          language: "typescript",
          root: ".",
          version: "head",
          scheduled_as: "changed",
          outcome: "findings",
          wall_time_ms: 1,
          findings: [structuredClone(typeError)],
        },
      ];
    };
    const byId = (report: any) =>
      new Map<string, any>(report.findings.map((f: any) => [f.id, f]));

    // Round 1 posts two agent defects and one type error.
    const r1 = await review({
      base,
      head: head1,
      lineage: ref,
      agents: () => [ha, hb],
      mutate: lineageRound,
    });
    expect(r1.report.status).toBe("complete");
    expect(r1.report.lineage).toMatchObject({
      round: 1,
      diff_only: false,
      held_back: 0,
      capped: false,
      rounds_to_pass: null,
      author_response_ratio: null,
    });
    for (const f of r1.report.findings)
      expect(f).toMatchObject({
        round: 1,
        status: "open",
        first_posted_in: r1.snapshotId,
      });
    expect([...byId(r1.report).keys()].sort()).toEqual(
      [idOf(ha), idOf(hb), typeError.id].sort(),
    );
    validLineageReport(r1.report);

    // Round 2 is diff-only: a moved reproduction is held back, the refuted
    // finding whose code changed is fixed.
    const r2 = await review({
      base,
      head: head2,
      lineage: ref,
      agents: () => [hyp("src/a.ts", "a", 3)],
      votes: (h) => (h.location.path === "src/b.ts" ? "refute" : "prove"),
      mutate: lineageRound,
    });
    expect(r2.report.status).toBe("complete");
    expect(r2.report.lineage).toMatchObject({
      round: 2,
      diff_only: true,
      previous_head: r1.snapshotId,
      held_back: 2,
      rounds_to_pass: null,
      author_response_ratio: null,
    });
    expect(r2.report.agent_audit.diff_only).toEqual({
      reverified: [idOf(ha), idOf(hb)],
      carried: [],
      not_reverified: [],
    });
    expect(byId(r2.report).get(idOf(ha))).toMatchObject({
      round: 2,
      status: "open",
      first_posted_in: r1.snapshotId,
      location: { line_start: 3 },
    });
    expect(byId(r2.report).has(idOf(hb))).toBe(false);
    expect(r2.report.agent_audit.lineage_updates).toEqual([
      {
        id: idOf(hb),
        status: "fixed",
        resolution: { fixed_in: r2.snapshotId },
      },
    ]);
    validLineageReport(r2.report);
    const fixed = (await rows("identity=?", idOf(hb))).find(
      (r) => r.repository === ref.repository,
    );
    expect(fixed.status).toBe("fixed");

    // The type error is answered as intentional.
    const answered = await app.request(
      `https://rio/v1/findings/${typeError.id}/feedback`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          reason: "intentional",
          note: "documented behavior",
          actor: "dev@example.com",
          lineage: { repository: ref.repository, kind: ref.kind, ref: ref.ref },
        }),
      },
      runtime,
    );
    expect(answered.status).toBe(200);
    const response = ((await answered.json()) as any).author_response;
    expect(response).toMatchObject({
      reason: "intentional",
      actor: "dev@example.com",
      note: "documented behavior",
    });

    // Round 3 posts a new finding; the answered type error stays dismissed.
    const r3 = await review({
      base,
      head: head3,
      lineage: ref,
      agents: () => [hd],
      mutate: lineageRound,
    });
    expect(r3.report.lineage).toMatchObject({
      round: 3,
      diff_only: true,
      previous_head: r2.snapshotId,
      held_back: 2,
      capped: false,
      rounds_to_pass: null,
      author_response_ratio: 0,
    });
    const third = byId(r3.report);
    expect(third.get(typeError.id)).toMatchObject({
      state: "new",
      status: "dismissed",
      author_response: response,
      first_posted_in: r1.snapshotId,
    });
    expect(third.get(idOf(hd))).toMatchObject({
      round: 3,
      status: "open",
      first_posted_in: r3.snapshotId,
    });
    expect(third.get(idOf(ha))).toMatchObject({ status: "open" });
    expect(r3.report.agent_audit.diff_only.carried).toEqual([idOf(ha)]);
    validLineageReport(r3.report);

    // Round 4 exceeds the cap: everything is listed, agent findings are summarized.
    const r4 = await review({
      base,
      head: head4,
      lineage: ref,
      agents: () => [he],
      mutate: lineageRound,
    });
    const report = r4.report;
    expect(report.lineage).toMatchObject({
      round: 4,
      cap: 3,
      capped: true,
      diff_only: true,
      held_back: 3,
      rounds_to_pass: null,
      author_response_ratio: 0,
    });
    const fourth = byId(report);
    expect([...fourth.keys()].sort()).toEqual(
      [idOf(ha), idOf(hd), idOf(he), typeError.id].sort(),
    );
    expect(fourth.get(typeError.id)).toMatchObject({ status: "dismissed" });
    expect(fourth.get(idOf(he))).toMatchObject({ round: 4 });
    expect(fourth.get(idOf(he))).not.toHaveProperty("first_posted_in");
    expect(report.lineage.reconsider).toEqual({
      unresolved: 3,
      top: [ha, hd, he].map((h) => ({
        id: idOf(h),
        title: h.message,
        path: h.location.path,
        line_start: h === ha ? 3 : 1,
      })),
    });
    validLineageReport(report);
    // Finding history and the cache object are v0.3 additions with their own
    // tests; the pinned document is the v0.2 convergence contract. A
    // dismissal from this lineage is never remembered by the registry: the
    // dismissed type error stays in the report, with its history.
    const all = [...report.findings, ...report.risks];
    expect(all.find((f: any) => f.id === typeError.id).history).toMatchObject({
      previous_status: "dismissed",
      previous_response: { reason: "intentional" },
    });
    expect(all.find((f: any) => f.id === idOf(ha)).history).toMatchObject({
      previous_status: "open",
      seen_count: 3,
    });
    expect(report.remembered).toBeUndefined();
    expect(report.cache).toEqual({
      lookups: 0,
      hits: 0,
      hit_rate: null,
      tokens_saved_estimate: 0,
    });
    const pinned = normalize(report);
    delete pinned.cache;
    // So is the count of the review's own storage requests.
    expect(pinned.agent_audit.requests).toMatchObject({
      limit: 10000,
      refused: 0,
      stopped: 0,
    });
    delete pinned.agent_audit.requests;
    for (const list of [
      pinned.findings,
      pinned.risks,
      ...pinned.checks.map((c: any) => c.findings),
    ])
      for (const f of list ?? []) delete f.history;
    expect(pinned).toEqual(withLayout(lineageRound4));
    expect(() => validateReport(lineageRound4)).not.toThrow();
  }, 240000);
});

import {
  env,
  applyD1Migrations,
  introspectWorkflowInstance,
} from "cloudflare:test";
import { beforeAll, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { Store } from "../src/storage";
import { finishJob } from "../src/jobs";
import { allMigrations, submission } from "./fixtures";
import { uploadSnapshot } from "./snapshots";
import type { Env, Hypothesis, Snapshot } from "../src/types";

/**
 * rio-v0-3-council task 7.1: a recorded review through the deployed-equivalent
 * Worker with the council enabled as in `rio/security`. Four plausible findings:
 * one reproduced by an experiment, one refuted by a protection, one plausible
 * with a note, one partial council; one vendor is excluded by the repository
 * allowlist. Providers are recorded; runner jobs are completed by the test.
 */
const runtime = env as Env;
const headers = {
  authorization: "Bearer test-owner-token-at-least-32-characters",
  "content-type": "application/json",
};
beforeAll(async () => {
  await applyD1Migrations(runtime.DB, allMigrations);
});

const lines = [
  "function a1(){ return run(); }",
  "function a2(){ return read(); }",
  "function a3(){ return write(); }",
  "function a4(){ return send(); }",
];
const snapshot: Snapshot = {
  base: {
    "src/a.ts": {
      mode: 0o100644,
      content:
        lines.map((l) => l.replace("return", "return 0 ||")).join("\n") + "\n",
    },
    "src/caller.ts": {
      mode: 0o100644,
      content: "export function guard(){ if (!owner()) return; a2(); }\n",
    },
  },
  head: {
    "src/a.ts": { mode: 0o100644, content: lines.join("\n") + "\n" },
    "src/caller.ts": {
      mode: 0o100644,
      content: "export function guard(){ if (!owner()) return; a2(); }\n",
    },
  },
};
const node = (id: string, path: string, symbol: string, line: number) => ({
  id,
  path,
  symbol_path: symbol,
  line_start: line,
  line_end: line,
});
const graph = (prefix: string) => ({
  nodes: [
    ...[1, 2, 3, 4].map((i) => node(`${prefix}${i}`, "src/a.ts", `a${i}`, i)),
    node(`${prefix}g`, "src/caller.ts", "guard", 1),
  ],
  edges: [{ from: `${prefix}g`, to: `${prefix}2`, kind: "calls" }],
});
const MARKERS = ["M1 reproduce", "M2 protected", "M3 judgment", "M4 partial"];
const hypotheses: Partial<Hypothesis>[] = MARKERS.map((marker, i) => ({
  rule_id: `correctness/c${i + 1}`,
  category: "defect",
  severity: "error",
  location: {
    path: "src/a.ts",
    line_start: i + 1,
    line_end: i + 1,
    symbol_path: `a${i + 1}`,
    occurrence_state: "new",
  },
  message: `${marker}: the call may misbehave`,
  trigger: `a${i + 1}()`,
  impact: "Callers fail",
  state: "new",
  source: { agent: "correctness" },
}));
const member = (
  role: string,
  context_pack: string,
  provider: string,
  model: string,
  family: string,
) => ({
  name: `rio/council-${role}`,
  version: "0.1.0",
  role,
  context_pack,
  provider,
  model,
  vendor: provider,
  family,
  weight: role === "exploit-author" ? 1.2 : 1,
  self_hosted: false,
});
const ROLE =
  /You are the (skeptic|exploit author|code owner|maintainer|tester) on Rio's review council/;

it("councils four findings with an experiment, a protection, a note and a partial council", async () => {
  const council: {
    role: string;
    round: number;
    marker: string;
    url: string;
  }[] = [];
  let model = 0;
  const transport = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const body = JSON.parse(init!.body as string);
      const url = String(input);
      const anthropic = url.includes("anthropic");
      const system: string = anthropic ? body.system : body.messages[0].content;
      const user: string = body.messages.at(-1).content;
      const reply = (result: unknown) => {
        model++;
        const content = JSON.stringify(result);
        return Response.json(
          anthropic
            ? {
                content: [{ type: "text", text: content }],
                usage: {
                  input_tokens: 60,
                  cache_read_input_tokens: 40,
                  output_tokens: 20,
                },
              }
            : {
                choices: [{ message: { content } }],
                usage: { prompt_tokens: 100, completion_tokens: 20 },
              },
        );
      };
      const role = ROLE.exec(system)?.[1].replace(" ", "-");
      if (role) {
        const round = user.startsWith("Round 2.") ? 2 : 1;
        const marker = MARKERS.find((m) => user.includes(m))!.slice(0, 2);
        council.push({ role, round, marker, url });
        if (marker === "M4" && role === "maintainer")
          return new Response("overloaded", { status: 500 });
        const answer: any = {
          member: role,
          round,
          real: "yes",
          introduced_by_change: "yes",
          impact: "The change breaks the call.",
          basis: "static_path",
          evidence_refs: ["file-1"],
        };
        if (marker === "M1" && role === "exploit-author" && round === 1)
          answer.experiment_request = {
            command: ["npm", "test"],
            version: "both",
            expect: "fails",
          };
        // A protection refutes only with at least half of the weight behind it.
        if (
          marker === "M2" &&
          ["skeptic", "code-owner", "maintainer"].includes(role)
        )
          Object.assign(answer, {
            real: "no",
            basis: "protection_found",
            evidence_refs: ["head-2"],
          });
        if (marker === "M3" && role === "skeptic")
          Object.assign(answer, { real: "no", basis: "contract" });
        return reply(answer);
      }
      if (user.includes("Review the change independently"))
        return reply({ result: hypotheses });
      if (
        body.messages.some((m: any) =>
          m.content.includes("Verify this hypothesis."),
        )
      )
        return reply({ result: { evidence_level: "plausible", evidence: [] } });
      return reply({ result: [] });
    });
  try {
    // The Workflow reads its bindings from vitest.config.ts, which carries the
    // provider keys and this review's council allowlist (COUNCIL_VENDORS).
    const bindings = runtime;
    const uploaded = await uploadSnapshot(
      (path, method, body) =>
        app.request(`https://rio${path}`, { method, headers, body }, bindings),
      snapshot,
    );
    const s = submission();
    s.snapshot_id = ((await uploaded.json()) as any).id;
    s.changed = [{ path: "src/a.ts", lines_changed: 4 }];
    s.graphs = { base: graph("b"), head: graph("h") } as any;
    s.profile.budget = {
      fast: {
        wall_time: "4m",
        tokens: 3_000_000,
        agents_max: 1,
        verify_tokens: 20_000,
      },
    };
    s.profile.steps = [
      { id: "triage", uses: "rio/triage@0.1.0", needs: [], with: {} },
      {
        id: "agents",
        uses: "rio/agents@0.1.0",
        needs: ["triage"],
        with: { cache: false },
      },
      { id: "verify", uses: "rio/verify@0.1.0", needs: ["agents"], with: {} },
      {
        id: "council",
        uses: "rio/council@0.1.0",
        needs: ["verify"],
        with: { enabled: true },
        rules: [
          { when: "evidence == plausible and severity >= error" },
          { when: "verify.split" },
          { when: "risk_tier == high" },
          { when: "mode == deep" },
          { when: "nightly" },
        ],
      },
      { id: "report", uses: "rio/report@0.1.0", needs: ["council"], with: {} },
    ];
    s.profile.council = {
      members: [
        "skeptic",
        "exploit-author",
        "code-owner",
        "maintainer",
        "tester",
      ].map((r) => ({
        uses: `rio/council-${r}`,
      })),
      max_findings: 5,
      max_experiments: 2,
      max_rounds: 2,
      min_members: 3,
      timeout: "90s",
      vendors_allowed: ["anthropic", "openai", "openrouter", "mistral"],
    };
    s.profile.council_members = [
      member("skeptic", "diff-only", "anthropic", "test-claude", "claude"),
      member("exploit-author", "execution", "openai", "test-gpt", "gpt"),
      {
        ...member(
          "code-owner",
          "graph-heavy",
          "openrouter",
          "google/gemini",
          "gemini",
        ),
      },
      member("maintainer", "graph-heavy", "openai", "test-gpt", "gpt"),
      member("tester", "execution", "mistral", "mistral-large", "mistral"),
    ];
    const response = await app.request(
      "https://rio/v1/reviews",
      { method: "POST", headers, body: JSON.stringify(s) },
      bindings,
    );
    expect(response.status).toBe(202);
    const { id } = (await response.json()) as any;
    await using instance = await introspectWorkflowInstance(
      runtime.REVIEWS,
      id,
    );
    // The experiment's two runner jobs: passes on base, fails on head.
    for (let finished = 0, tries = 0; finished < 2 && tries < 600; tries++) {
      const pending = await runtime.DB.prepare(
        "SELECT id,payload_key FROM jobs WHERE review_id=? AND status='pending' AND kind='run'",
      )
        .bind(id)
        .all<{ id: string; payload_key: string }>();
      for (const job of pending.results) {
        const payload = await new Store(runtime).get<any>(job.payload_key);
        expect(payload.command).toEqual(["npm", "test"]);
        expect(payload.network).toBe(false);
        const head = payload.version === "head";
        await finishJob(bindings, id, job.id, 1, {
          outcome: "exited",
          job_id: job.id,
          attempt: 1,
          version: payload.version,
          exit_code: head ? 1 : 0,
          stdout: head ? "1 failing" : "all passed",
          stderr: "",
          timed_out: false,
          truncated: false,
        });
        finished++;
      }
      if (finished < 2) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await instance.waitForStatus("complete");
    const row = await runtime.DB.prepare(
      "SELECT status,report_key FROM reviews WHERE id=?",
    )
      .bind(id)
      .first<any>();
    expect(row.status).toBe("complete");
    const report = await new Store(runtime).get<any>(row.report_key);
    const byMarker = (marker: string) =>
      [
        ...report.findings,
        ...report.risks,
        ...(report.council?.refuted ?? []),
      ].find((f: any) => f.message.startsWith(marker));
    // M1: reproduced by the experiment; still the verifier's category.
    const m1 = byMarker("M1");
    expect(m1.evidence_level).toBe("reproduced");
    expect(m1.category).toBe("defect");
    expect(m1.council).toMatchObject({
      decision: "reproduced",
      tier: "experiment",
      partial: true,
      answered: 4,
      total: 5,
    });
    expect(m1.council.experiments).toEqual([
      {
        command: ["npm", "test"],
        version: "both",
        expect: "fails",
        run: true,
        outcome: { base: "passed", head: "failed" },
        artifact: "exp-1",
      },
    ]);
    // M2: refuted by the guard the graph places on the path; not an open finding.
    expect(
      [...report.findings, ...report.risks].some((f: any) =>
        f.message.startsWith("M2"),
      ),
    ).toBe(false);
    const m2 = byMarker("M2");
    expect(m2.council).toMatchObject({
      decision: "refuted",
      tier: "protection",
      protection: "head-2",
    });
    // M3: plausible with a note in words; stays a risk.
    const m3 = report.risks.find((f: any) => f.message.startsWith("M3"));
    expect(m3.council).toMatchObject({
      decision: "plausible",
      tier: "judgment",
    });
    expect(m3.council.note).toContain(
      "a minority of the weight answers no (contract; skeptic)",
    );
    expect(m3.council.note).not.toMatch(/%/);
    // M4: a vendor error leaves three answers: partial (3/5).
    const m4 = byMarker("M4");
    expect(m4.council).toMatchObject({ partial: true, answered: 3, total: 5 });
    expect(
      m4.council.members.find((m: any) => m.role === "maintainer"),
    ).toEqual({
      role: "maintainer",
      abstained: true,
      cause: "vendor_error",
    });
    // The excluded vendor never received a pack.
    for (const f of [m1, m2, m3, m4]) {
      expect(f.council.excluded).toEqual([
        { role: "tester", vendor: "mistral", denied_by: "repository" },
      ]);
      expect(f.council.author_family).toEqual({ status: "not_applicable" });
    }
    expect(council.some((c) => c.role === "tester")).toBe(false);
    // Footer cost: members × rounds × experiments, tokens per vendor, runner seconds.
    expect(report.council).toMatchObject({ councilled: 4, not_councilled: 0 });
    expect(report.council.findings).toHaveLength(4);
    expect(report.council.total).toMatchObject({
      members: 16,
      rounds: 8,
      experiments: 1,
    });
    expect(Object.keys(report.council.total.tokens).sort()).toEqual([
      "anthropic",
      "openai",
      "openrouter",
    ]);
    expect(Number.isInteger(report.council.total.runner_seconds)).toBe(true);
    expect(report.agent_audit.council.selected).toHaveLength(4);
    expect(report.agent_audit.council.selected[0].rule).toBe(
      "evidence == plausible and severity >= error",
    );
    // Audit: one entry per member call, hashes and sizes only.
    const calls = 4 * 4 + 4 * 4 - 1;
    const audit = await new Store(runtime).get<any>(
      `reviews/${id}/council/audit.json`,
    );
    expect(audit.entries).toHaveLength(calls);
    expect(JSON.stringify(audit)).not.toContain("function a");
    // Each entry carries layer hashes and sizes beside rendering_hash, including
    // the tenant partition, and no prompt text.
    for (const entry of audit.entries) {
      expect(entry.layers.map((l: any) => l.layer)).toEqual([
        "system",
        "partition",
        "context",
        // With `council-order` the round header follows the rendering in
        // every round; without it only round 2 adds blocks after the header.
        ...(entry.round === 2 || runtime.PROMPT_LAYOUT?.includes("council-order")
          ? ["assignment"]
          : []),
      ]);
      expect(entry.rendering_hash).toBeTruthy();
    }
    expect(JSON.stringify(audit)).not.toContain("review_partition");
    const rows = await runtime.DB.prepare(
      "SELECT member,round,vendor,model,pack_hash,abstained,cause FROM council_assessments WHERE review_id=?",
    )
      .bind(id)
      .all<any>();
    expect(rows.results).toHaveLength(calls);
    expect(new Set(rows.results.map((r) => r.vendor))).toEqual(
      new Set(["anthropic", "openai", "openrouter"]),
    );
    const api = (await (
      await app.request(
        `https://rio/v1/reviews/${id}/audit`,
        { headers },
        bindings,
      )
    ).json()) as any;
    expect(api.council).toHaveLength(calls);
    // Each council call reserved its prompt and output from the review budget.
    const usage = await runtime.DB.prepare(
      "SELECT reserved,input_tokens,output_tokens,status,model,cache_read_tokens,usage_convention,cost_source FROM usage WHERE review_id=? AND phase='council'",
    )
      .bind(id)
      .all<any>();
    expect(usage.results.length).toBe(calls);
    for (const u of usage.results.filter((u) => u.status === "completed")) {
      expect(u.reserved).toBeGreaterThanOrEqual(
        u.input_tokens + u.output_tokens,
      );
      // Vendor settlement carries the normalized usage: Anthropic's total input
      // includes its cache reads, and every row names its convention and cost source.
      expect(u.input_tokens).toBe(100);
      expect(u.usage_convention).not.toBeNull();
      expect(u.cost_source).not.toBeNull();
      if (u.model.startsWith("anthropic/"))
        expect(u.cache_read_tokens).toBe(40);
    }
    // Every member of one finding received the same pack.
    const packs = new Set(
      rows.results.filter((r) => r.round === 1).map((r) => r.pack_hash),
    );
    expect(packs.size).toBe(4);
  } finally {
    transport.mockRestore();
  }
}, 120000);

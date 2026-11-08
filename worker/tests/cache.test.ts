import {
  env,
  applyD1Migrations,
  introspectWorkflowInstance,
} from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Store } from "../src/storage";
import { hash } from "../src/validation";
import agentPrompts from "../src/agent-prompts.json";
import { agents } from "../src/manifests";
import {
  EVIDENCE_RETENTION_MS,
  contextHash,
  diffHunks,
  expire,
  hunkHash,
  lookup,
  slice,
  type ContextInputs,
  type Keyed,
} from "../src/cache";
import versions from "./prompt-versions.json";
import { allMigrations, submission } from "./fixtures";
import { storeSnapshot } from "./snapshots";
import type { Env, Graph, Snapshot, Submission } from "../src/types";

const runtime = env as Env;
beforeAll(async () => {
  await applyD1Migrations(runtime.DB, allMigrations);
});

describe("hunks and keys", () => {
  it("finds edit runs without context and normalizes trailing whitespace", () => {
    const before = "a\nb\nc\nd\ne\nf\n",
      after = "a\nB\nc\nd\ne\nf\ng  \n";
    const hunks = diffHunks("x.ts", "x.ts", before, after);
    expect(hunks.map((h) => [h.base, h.head, h.text])).toEqual([
      [{ start: 2, count: 1 }, { start: 2, count: 1 }, "-b\n+B"],
      [{ start: 7, count: 0 }, { start: 7, count: 1 }, "+g"],
    ]);
    expect(diffHunks("x.ts", "x.ts", null, "a\n")[0].text).toBe("+a");
    expect(diffHunks("x.ts", "x.ts", "a\n", null)[0].text).toBe("-a");
    expect(diffHunks("x.ts", "x.ts", "same\n", "same\n")).toEqual([]);
    // The hunk hash depends on path and edit, not on where the edit sits.
    const moved = diffHunks("x.ts", "x.ts", "z\n" + before, "z\n" + after)[0];
    expect(hunkHash(moved)).toBe(hunkHash(hunks[0]));
    expect(hunkHash({ ...moved, path: "y.ts" })).not.toBe(hunkHash(hunks[0]));
  });

  it("slices a completed run per hunk, every hunk getting an entry", () => {
    const keys = [
      ...diffHunks("a.ts", "a.ts", "1\n2\n3\n4\n5\n6\n", "1\nX\n3\n4\n5\nY\n"),
      ...diffHunks("b.ts", "b.ts", "1\n", "2\n"),
    ].map((hunk) => ({ hunk, hunk_hash: "", context_hash: "" }));
    const at = (path: string, line: number) =>
      ({
        id: `${path}:${line}`,
        location: { path, line_start: line, line_end: line },
      }) as any;
    const sliced = slice(keys, [at("a.ts", 2), at("a.ts", 5), at("c.ts", 1)]);
    expect(sliced.map((list) => list.map((h) => h.id))).toEqual([
      ["a.ts:2", "c.ts:1"],
      ["a.ts:5"],
      [],
    ]);
  });

  it("changes the context hash with every key input and nothing else", async () => {
    const graph: Graph = {
      nodes: [
        { id: "a", path: "a.ts", symbol_path: "a", line_start: 1, line_end: 2 },
        { id: "h", path: "h.ts", symbol_path: "h", line_start: 1, line_end: 1 },
        { id: "z", path: "z.ts", symbol_path: "z", line_start: 1, line_end: 1 },
      ],
      edges: [{ from: "a", to: "h" }],
    };
    const files: Record<string, string> = {
      "a.ts": "function a() {\n  return h();\n}\n",
      "h.ts": "export const h = () => 1;\n",
      "z.ts": "export const z = 1;\n",
    };
    const [hunk] = diffHunks(
      "a.ts",
      "a.ts",
      "function a() {\n  return 0;\n}\n",
      files["a.ts"],
    );
    const inputs = (
      over: Partial<ContextInputs> = {},
      edit: Record<string, string> = {},
    ): ContextInputs => ({
      agent: "correctness",
      manifest_version: 1,
      prompt: "prompt",
      model: "openai/test",
      options: {},
      engine: "0.3.0",
      graphs: { base: graph, head: graph },
      guidance: [
        { path: "AGENTS.md", scope_dir: "", content_hash: "g1", lines: [] },
      ],
      read: async (_v, path) => ({ ...files, ...edit })[path] ?? null,
      base_graph: true,
      ...over,
    });
    const reference = await contextHash(hunk, inputs());
    expect(await contextHash(hunk, inputs())).toBe(reference);
    // An unrelated file is not part of the context.
    expect(
      await contextHash(hunk, inputs({}, { "z.ts": "export const z = 2;\n" })),
    ).toBe(reference);
    for (const changed of [
      inputs({ prompt: "prompt, edited" }),
      inputs({ manifest_version: 2 }),
      inputs({ model: "openai/other" }),
      inputs({ options: { tools: ["read_file"] } }),
      inputs({ agent: "contracts" }),
      inputs({ engine: "0.3.1" }),
      inputs({
        guidance: [
          { path: "AGENTS.md", scope_dir: "", content_hash: "g2", lines: [] },
        ],
      }),
      // A one-hop neighbour changed.
      inputs({}, { "h.ts": "export const h = () => 2;\n" }),
    ])
      expect(await contextHash(hunk, changed)).not.toBe(reference);
    // Guidance outside the hunk's directory is not in scope.
    expect(
      await contextHash(
        hunk,
        inputs({
          guidance: [
            { path: "AGENTS.md", scope_dir: "", content_hash: "g1", lines: [] },
            {
              path: "docs/AGENTS.md",
              scope_dir: "docs",
              content_hash: "g9",
              lines: [],
            },
          ],
        }),
      ),
    ).toBe(reference);
  });

  it("requires a manifest version bump when an agent prompt changes", () => {
    // worker/tests/prompt-versions.json records each prompt's hash per manifest
    // version. Edit a prompt: bump the agent's manifest version and add the new
    // version's hash, keeping the old entries.
    for (const [name, manifest] of Object.entries(agents)) {
      const recorded = (versions as Record<string, Record<string, string>>)[
        name
      ];
      const prompt = (agentPrompts as Record<string, string>)[name] ?? "";
      expect(recorded, `${name} has no prompt-versions entry`).toBeDefined();
      expect(
        recorded[String(manifest.version)],
        `modules/agents/${name}/prompt.md changed without a manifest version bump`,
      ).toBe(hash(prompt));
      const hashes = Object.values(recorded);
      expect(
        new Set(hashes).size,
        `${name}: two versions share one prompt`,
      ).toBe(hashes.length);
    }
  });
});

interface Run {
  files: { base: Record<string, string>; head: Record<string, string> };
  graph?: Graph;
  agent: (prompt: string) => unknown[];
  tenant?: string;
  mutate?: (s: Submission) => void;
}
let reviews = 0;
async function review(run: Run) {
  const calls: string[] = [];
  const prompts: string[] = [];
  const transport = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const body = JSON.parse(init!.body as string);
      const first: string = body.messages.find(
        (m: any) => m.role === "user",
      ).content;
      const last: string = body.messages.at(-1).content;
      let result: unknown = [];
      if (/Review the change independently for correctness\./.test(first)) {
        calls.push("agent");
        prompts.push(first);
        result = run.agent(first);
      } else if (last.startsWith("Verify this hypothesis.")) {
        calls.push("verify");
        result = { evidence_level: "plausible", evidence: [] };
      } else calls.push("blind");
      const content = JSON.stringify({ result });
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
    const store = new Store(runtime),
      id = `cache-review-${++reviews}-${crypto.randomUUID()}`,
      s = submission();
    const tree = (files: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(files).map(([p, c]) => [
          p,
          { mode: 0o100644, content: c },
        ]),
      );
    const snapshot: Snapshot = {
      base: tree(run.files.base),
      head: tree(run.files.head),
    };
    s.changed = Object.keys(run.files.head)
      .filter((p) => run.files.base[p] !== run.files.head[p])
      .map((path) => ({ path, lines_changed: 1 }));
    s.graphs = {
      base: run.graph ?? { nodes: [], edges: [] },
      head: run.graph ?? { nodes: [], edges: [] },
    };
    s.profile.steps = [
      {
        id: "agents",
        uses: "rio/agents@0.1.0",
        needs: [],
        with: {},
        agents: [{ correctness: {} }],
      },
      { id: "verify", uses: "rio/verify@0.1.0", needs: ["agents"], with: {} },
    ];
    s.profile.budget.fast.verify_tokens = 40000;
    run.mutate?.(s);
    const stored = await storeSnapshot(runtime, snapshot);
    const key = await store.put(`reviews/${id}/submission.json`, {
      ...s,
      snapshot_id: stored.id,
    });
    await runtime.DB.prepare(
      "INSERT INTO reviews(id,tenant,submission_key,status,created_at,token_limit,deadline) VALUES(?,?,?,'queued',?,?,?)",
    )
      .bind(
        id,
        run.tenant ?? "owner",
        key,
        Date.now(),
        100000,
        Date.now() + 240000,
      )
      .run();
    await using instance = await introspectWorkflowInstance(
      runtime.REVIEWS,
      id,
    );
    await runtime.REVIEWS.create({
      id,
      params: { review_id: id, snapshot_key: stored.key },
    });
    await instance.waitForStatus("complete");
    const row = await runtime.DB.prepare(
      "SELECT report_key FROM reviews WHERE id=?",
    )
      .bind(id)
      .first<any>();
    const usage = await runtime.DB.prepare(
      "SELECT COALESCE(SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)),0) AS tokens FROM usage WHERE review_id=? AND phase='generation'",
    )
      .bind(id)
      .first<{ tokens: number }>();
    return {
      id,
      report: await store.get<any>(row.report_key),
      calls,
      prompts,
      generation: usage!.tokens,
    };
  } finally {
    transport.mockRestore();
  }
}
const entries = (tenant = "owner") =>
  runtime.DB.prepare("SELECT COUNT(*) AS n FROM agent_cache WHERE tenant=?")
    .bind(tenant)
    .first<{ n: number }>()
    .then((r) => r!.n);
const hyp = (
  path: string,
  line: number,
  symbol: string,
  rule = "correctness/throw",
) => ({
  rule_id: rule,
  category: "defect",
  severity: "error",
  location: { path, line_start: line, line_end: line, symbol_path: symbol },
  message: `${symbol} now throws`,
  trigger: `${symbol}()`,
  state: "new",
});
const reported = (report: any) => [...report.findings, ...report.risks];

describe("agent result cache", () => {
  // Every test uses its own content so hunks never collide across tests.
  const change = (tag: string) => ({
    base: {
      [`src/${tag}/a.ts`]: `function a() {\n  return 0; // ${tag}\n}\n`,
      [`src/${tag}/b.ts`]: `function b() {\n  return 0; // ${tag}\n}\n`,
      [`src/${tag}/c.ts`]: `function c() {\n  return 0; // ${tag}\n}\n`,
    },
    head: {
      [`src/${tag}/a.ts`]: `function a() {\n  throw new Error(); // ${tag}\n}\n`,
      [`src/${tag}/b.ts`]: `function b() {\n  return null; // ${tag}\n}\n`,
      [`src/${tag}/c.ts`]: `function c() {\n  return 0; // ${tag}\n}\n`,
    },
  });

  it("misses, populates per hunk, then replays without a model call while verifying fresh", async () => {
    const files = change("hit");
    const before = await entries();
    const first = await review({
      files,
      agent: () => [hyp("src/hit/a.ts", 2, "a")],
    });
    expect(first.calls.filter((c) => c === "agent")).toHaveLength(1);
    expect(first.report.cache).toEqual({
      lookups: 2,
      hits: 0,
      hit_rate: 0,
      tokens_saved_estimate: 0,
    });
    // Two hunks, two entries: one with the hypothesis, one empty.
    expect((await entries()) - before).toBe(2);
    expect(reported(first.report)[0].source).toEqual({ agent: "correctness" });
    // The same change again (another pull request of the tenant).
    const second = await review({
      files,
      agent: () => {
        throw new Error("no model call expected");
      },
    });
    expect(second.calls).not.toContain("agent");
    expect(second.calls).toContain("verify");
    expect(second.generation).toBe(0);
    expect(second.report.cache.lookups).toBe(2);
    expect(second.report.cache.hits).toBe(2);
    expect(second.report.cache.hit_rate).toBe(1);
    expect(second.report.cache.tokens_saved_estimate).toBeGreaterThan(0);
    const replayed = reported(second.report)[0];
    expect(replayed.source).toEqual({ agent: "correctness", cached: true });
    expect(replayed.id).toBe(reported(first.report)[0].id);
    expect(replayed.verification.voters).toBe(3);
  }, 240000);

  it("reviews only the missed hunks when some hit", async () => {
    const files = change("partial");
    await review({ files, agent: () => [hyp("src/partial/a.ts", 2, "a")] });
    const more = {
      base: { ...files.base },
      head: {
        ...files.head,
        "src/partial/c.ts": "function c() {\n  return -1; // partial\n}\n",
      },
    };
    const run = await review({
      files: more,
      agent: () => [hyp("src/partial/c.ts", 2, "c", "correctness/sign")],
    });
    expect(run.calls.filter((c) => c === "agent")).toHaveLength(1);
    expect(run.report.cache).toMatchObject({
      lookups: 3,
      hits: 2,
      hit_rate: 2 / 3,
    });
    // The agent's focus is the missed file only.
    expect(run.prompts[0]).toContain('"src/partial/c.ts"');
    expect(run.prompts[0]).not.toContain('"path":"src/partial/a.ts"');
    expect(
      reported(run.report)
        .map((f: any) => [f.rule_id, f.source.cached ?? false])
        .sort(),
    ).toEqual([
      ["correctness/sign", false],
      ["correctness/throw", true],
    ]);
  }, 240000);

  it("misses when a neighbour, the model or the tenant differs", async () => {
    const tag = "context";
    const graph = (helper: string): Graph => ({
      nodes: [
        {
          id: "a",
          path: `src/${tag}/a.ts`,
          symbol_path: "a",
          line_start: 1,
          line_end: 3,
        },
        {
          id: "h",
          path: `lib/${tag}.ts`,
          symbol_path: "h",
          line_start: 1,
          line_end: helper.split("\n").length - 1,
        },
      ],
      edges: [{ from: "a", to: "h" }],
    });
    const files = (helper: string) => ({
      base: {
        [`src/${tag}/a.ts`]: "function a() {\n  return h(0);\n}\n",
        [`lib/${tag}.ts`]: helper,
      },
      head: {
        [`src/${tag}/a.ts`]: "function a() {\n  return h(1);\n}\n",
        [`lib/${tag}.ts`]: helper,
      },
    });
    const v1 = "export function h(x) {\n  return x;\n}\n",
      v2 = "export function h(x) {\n  return x * 2;\n}\n";
    const agent = () => [hyp(`src/${tag}/a.ts`, 2, "a")];
    await review({ files: files(v1), graph: graph(v1), agent });
    const same = await review({ files: files(v1), graph: graph(v1), agent });
    expect(same.report.cache.hits).toBe(1);
    const neighbour = await review({
      files: files(v2),
      graph: graph(v2),
      agent,
    });
    expect(neighbour.report.cache).toMatchObject({ lookups: 1, hits: 0 });
    expect(neighbour.calls).toContain("agent");
    const model = await review({
      files: files(v1),
      graph: graph(v1),
      agent,
      mutate: (s) => {
        s.profile.models.default = "openai/another";
      },
    });
    expect(model.report.cache).toMatchObject({ lookups: 1, hits: 0 });
    const other = await review({
      files: files(v1),
      graph: graph(v1),
      agent,
      tenant: "tenant-cache-b",
    });
    expect(other.report.cache).toMatchObject({ lookups: 1, hits: 0 });
    expect(other.calls).toContain("agent");
    expect(await entries("tenant-cache-b")).toBe(1);
  }, 240000);

  it("makes no lookup and writes nothing for fork reviews or with cache: false", async () => {
    const files = change("off");
    const before = await entries();
    for (const mutate of [
      (s: Submission) => {
        s.fork = true;
      },
      (s: Submission) => {
        s.profile.steps[0].with = { cache: false };
      },
    ]) {
      const run = await review({
        files,
        agent: () => [hyp("src/off/a.ts", 2, "a")],
        mutate,
      });
      expect(run.calls).toContain("agent");
      expect(run.report.cache).toEqual({
        lookups: 0,
        hits: 0,
        hit_rate: null,
        tokens_saved_estimate: 0,
      });
    }
    expect(await entries()).toBe(before);
  }, 240000);

  it("does not populate from a run cut by its token budget", async () => {
    const files = change("budget");
    const before = await entries();
    const run = await review({
      files,
      agent: () => [hyp("src/budget/a.ts", 2, "a")],
      mutate: (s) => {
        s.profile.budget.fast.tokens = 60;
      },
    });
    expect(run.report.status).toBe("partial");
    expect(run.report.footer.notes.join("\n")).toMatch(
      /correctness agent failed/,
    );
    expect(run.report.cache).toMatchObject({ lookups: 2, hits: 0 });
    expect(await entries()).toBe(before);
  }, 240000);
});

describe("cache retention", () => {
  it("expires entries older than the evidence retention on lookup and by sweep", async () => {
    const now = Date.now();
    const keyed = (n: number): Keyed => ({
      hunk: {
        path: "r.ts",
        old_path: "r.ts",
        base: { start: 1, count: 1 },
        head: { start: 1, count: 1 },
        text: "",
      },
      hunk_hash: `h${n}`,
      context_hash: `c${n}`,
    });
    for (const [n, age] of [
      [1, EVIDENCE_RETENTION_MS + 1000],
      [2, EVIDENCE_RETENTION_MS + 2000],
      [3, 1000],
    ] as const) {
      const key = `cache/retention/h${n}/c${n}.json`;
      await runtime.ARTIFACTS.put(
        key,
        JSON.stringify({ agent: "correctness", hypotheses: [], tokens: 5 }),
      );
      await runtime.DB.prepare(
        "INSERT INTO agent_cache(tenant,hunk_hash,context_hash,object_key,created_at) VALUES('retention',?,?,?,?)",
      )
        .bind(`h${n}`, `c${n}`, key, now - age)
        .run();
    }
    const hits = await lookup(runtime, "retention", [keyed(1), keyed(3)], now);
    expect(Object.keys(hits)).toEqual(["1"]);
    expect(
      await runtime.ARTIFACTS.get("cache/retention/h1/c1.json"),
    ).toBeNull();
    expect(await expire(runtime, "retention", now)).toBe(1);
    expect(
      await runtime.ARTIFACTS.get("cache/retention/h2/c2.json"),
    ).toBeNull();
    expect(await entries("retention")).toBe(1);
  });
});

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
  ContextMemo,
  context,
  contextHash,
  diffHunks,
  expire,
  hunkHash,
  lookup,
  PACK_BYTES,
  PACK_ENTRIES,
  slice,
  store as storeCache,
  storeEntries,
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

  it("stores only missed hunks, never a hit hunk's hypotheses, and nothing it could not replay", () => {
    const keys: Keyed[] = [
      ...diffHunks("a.ts", "a.ts", "1\n2\n3\n4\n5\n6\n", "1\nX\n3\n4\n5\nY\n"),
      ...diffHunks("b.ts", "b.ts", "1\n", "2\n"),
    ].map((hunk) => ({
      hunk,
      hunk_hash: "",
      context_hash: "",
      covered: [{ path: hunk.path }],
    }));
    const at = (path: string, line: number, ...cited: [string, number][]) =>
      ({
        id: `${path}:${line}`,
        location: { path, line_start: line, line_end: line },
        locations: cited.map(([p, l]) => ({
          path: p,
          line_start: l,
          line_end: l,
        })),
      }) as any;
    const ids = (m: Map<number, any[]>) =>
      [...m].map(([i, list]) => [i, list.map((h) => h.id)]);
    // Every hunk missed: one entry each, the empty one included.
    expect(ids(slice(keys, [0, 1, 2], [at("a.ts", 2), at("a.ts", 5)]))).toEqual(
      [
        [0, ["a.ts:2"]],
        [1, ["a.ts:5"]],
        [2, []],
      ],
    );
    // Hunk 0 hit: its file was reviewed again, but the hypothesis in it is not
    // stored under the missed hunk 1 of the same file.
    expect(ids(slice(keys, [1, 2], [at("a.ts", 2), at("a.ts", 6)]))).toEqual([
      [1, ["a.ts:6"]],
      [2, []],
    ]);
    // A hypothesis in no changed file: the run cannot be replayed per hunk.
    expect(slice(keys, [0, 1, 2], [at("a.ts", 2), at("c.ts", 1)]).size).toBe(0);
    // A cited location outside the regions the context fixes drops that hunk.
    expect(ids(slice(keys, [0, 1, 2], [at("a.ts", 2, ["c.ts", 4])]))).toEqual([
      [1, []],
      [2, []],
    ]);
  });

  it("keys symbol positions, so a moved symbol misses", async () => {
    const at = (start: number): Graph => ({
      nodes: [
        {
          id: "a",
          path: "a.ts",
          symbol_path: "a",
          line_start: start,
          line_end: start + 2,
        },
      ],
      edges: [],
    });
    const before = "function a() {\n  return 0;\n}\n",
      after = "function a() {\n  return 1;\n}\n";
    const inputs = (graph: Graph, text: string): ContextInputs => ({
      agent: "correctness",
      manifest_version: 1,
      prompt: "",
      model: "m",
      options: {},
      engine: "e",
      graphs: { base: graph, head: graph },
      guidance: [],
      read: async () => text,
      base_graph: true,
    });
    const [hunk] = diffHunks("a.ts", "a.ts", before, after);
    const [moved] = diffHunks("a.ts", "a.ts", "\n" + before, "\n" + after);
    expect(hunkHash(moved)).toBe(hunkHash(hunk));
    const here = await context(hunk, inputs(at(1), after));
    const there = await context(moved, inputs(at(2), "\n" + after));
    expect(there.context_hash).not.toBe(here.context_hash);
    expect(here.covered).toEqual([
      { path: "a.ts", line_start: 1, line_end: 3 },
      { path: "a.ts", line_start: 1, line_end: 3 },
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

  it("keys a change identically with a shared memo, reading each file once per use", async () => {
    const graph: Graph = {
      nodes: [
        { id: "a", path: "a.ts", symbol_path: "a", line_start: 1, line_end: 3 },
        { id: "b", path: "a.ts", symbol_path: "b", line_start: 5, line_end: 7 },
        { id: "h", path: "h.ts", symbol_path: "h", line_start: 1, line_end: 1 },
      ],
      edges: [
        { from: "a", to: "h" },
        { from: "b", to: "h" },
      ],
    };
    const before =
        "function a() {\n  return 0;\n}\n\nfunction b() {\n  return 0;\n}\n// end\n",
      after =
        "function a() {\n  return 1;\n}\n\nfunction b() {\n  return 1;\n}\n// END\n";
    const files: Record<string, string> = {
      "a.ts": after,
      "h.ts": "export const h = () => 1;\n",
    };
    const reads: string[] = [];
    const inputs = (memo?: ContextMemo): ContextInputs => ({
      agent: "correctness",
      manifest_version: 1,
      prompt: "prompt",
      model: "openai/test",
      options: {},
      engine: "0.3.0",
      graphs: { base: graph, head: graph },
      guidance: [],
      read: async (version, path) => {
        reads.push(`${version}:${path}`);
        return files[path] ?? null;
      },
      base_graph: true,
      memo,
    });
    const hunks = diffHunks("a.ts", "a.ts", before, after);
    // Two symbol hunks and one file-keyed hunk (no symbol encloses line 9).
    expect(hunks).toHaveLength(3);
    const plain = [];
    for (const h of hunks) plain.push(await context(h, inputs()));
    reads.length = 0;
    const memo = new ContextMemo();
    const memoized = [];
    for (const h of hunks) memoized.push(await context(h, inputs(memo)));
    expect(memoized).toEqual(plain);
    // Each file is read once for its symbols, and once more where a hunk is
    // keyed by the whole file; the second symbol hunk reads nothing.
    expect(reads.sort()).toEqual([
      "base:a.ts",
      "base:a.ts",
      "base:h.ts",
      "head:a.ts",
      "head:a.ts",
      "head:h.ts",
    ]);
  });

  it("keys one hop of neighbours whatever the edge order", async () => {
    // a calls h, h calls z: z is two hops from a hunk in a.
    const nodes = [
      { id: "a", path: "a.ts", symbol_path: "a", line_start: 1, line_end: 3 },
      { id: "h", path: "h.ts", symbol_path: "h", line_start: 1, line_end: 1 },
      { id: "z", path: "z.ts", symbol_path: "z", line_start: 1, line_end: 1 },
    ];
    const files: Record<string, string> = {
      "a.ts": "function a() {\n  return h();\n}\n",
      "h.ts": "export const h = () => z();\n",
      "z.ts": "export const z = () => 1;\n",
    };
    const [hunk] = diffHunks(
      "a.ts",
      "a.ts",
      "function a() {\n  return 0;\n}\n",
      files["a.ts"],
    );
    const key = async (
      edges: Graph["edges"],
      edit: Record<string, string> = {},
    ) => {
      const graph: Graph = { nodes, edges };
      return context(hunk, {
        agent: "correctness",
        manifest_version: 1,
        prompt: "",
        model: "m",
        options: {},
        engine: "e",
        graphs: { base: graph, head: graph },
        guidance: [],
        read: async (_v, path) => ({ ...files, ...edit })[path] ?? null,
        base_graph: true,
      });
    };
    const ordered = [
      { from: "a", to: "h" },
      { from: "h", to: "z" },
    ];
    const reference = await key(ordered);
    expect(reference.covered.map((r) => r.path).sort()).toEqual([
      "a.ts",
      "a.ts",
      "h.ts",
      "h.ts",
    ]);
    expect(await key([...ordered].reverse())).toEqual(reference);
    expect(
      (await key(ordered, { "z.ts": "export const z = () => 2;\n" }))
        .context_hash,
    ).toBe(reference.context_hash);
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
  // Step mocks, set before the workflow starts.
  modify?: Parameters<
    Awaited<ReturnType<typeof introspectWorkflowInstance>>["modify"]
  >[0];
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
    if (run.modify) await instance.modify(run.modify);
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

describe("agent result cache within one file", () => {
  it("does not store a hit hunk's fresh hypotheses under the missed hunk of the same file", async () => {
    const file = "src/mixed/m.ts";
    const text = (f: string, g: string) =>
      `function f() {\n  return ${f}; // mixed\n}\nfunction g() {\n  return ${g};\n}\n`;
    const graph: Graph = {
      nodes: [
        { id: "f", path: file, symbol_path: "f", line_start: 1, line_end: 3 },
        { id: "g", path: file, symbol_path: "g", line_start: 4, line_end: 6 },
      ],
      edges: [],
    };
    const base = { [file]: text("0", "0") };
    await review({
      files: { base, head: { [file]: text("1", "1") } },
      graph,
      agent: () => [
        hyp(file, 2, "f", "correctness/f1"),
        hyp(file, 5, "g", "correctness/g1"),
      ],
    });
    const second = await review({
      files: { base, head: { [file]: text("1", "2") } },
      graph,
      agent: () => [
        hyp(file, 2, "f", "correctness/fresh"),
        hyp(file, 5, "g", "correctness/g2"),
      ],
    });
    expect(second.report.cache).toMatchObject({ lookups: 2, hits: 1 });
    const rules = (report: any) =>
      reported(report)
        .map((f: any) => `${f.rule_id}${f.source.cached ? " (cached)" : ""}`)
        .sort();
    expect(rules(second.report)).toEqual([
      "correctness/f1 (cached)",
      "correctness/fresh",
      "correctness/g2",
    ]);
    const third = await review({
      files: { base, head: { [file]: text("1", "2") } },
      graph,
      agent: () => {
        throw new Error("no model call expected");
      },
    });
    expect(third.calls).not.toContain("agent");
    expect(rules(third.report)).toEqual([
      "correctness/f1 (cached)",
      "correctness/g2 (cached)",
    ]);
  }, 240000);
});

const keyedHunk = (tag: string, n: number): Keyed => ({
  hunk: {
    path: `${tag}/${n}.ts`,
    old_path: `${tag}/${n}.ts`,
    base: { start: 1, count: 1 },
    head: { start: 1, count: 1 },
    text: "",
  },
  hunk_hash: `${tag}-h${n}`,
  context_hash: `${tag}-c${n}`,
});
/** The environment with its storage and database requests counted. */
function counted() {
  const requests = { put: 0, get: 0, delete: 0, database: 0 };
  const bucket = runtime.ARTIFACTS,
    database = runtime.DB;
  const counting = {
    ...runtime,
    ARTIFACTS: {
      put: (...a: Parameters<R2Bucket["put"]>) => (
        requests.put++,
        bucket.put(...a)
      ),
      get: (key: string) => (requests.get++, bucket.get(key)),
      delete: (keys: string | string[]) => (
        requests.delete++,
        bucket.delete(keys)
      ),
    },
    DB: {
      // Every statement counts, batched or not: an upper bound.
      prepare: (sql: string) => (requests.database++, database.prepare(sql)),
      batch: (statements: D1PreparedStatement[]) => database.batch(statements),
    },
  } as unknown as Env;
  return { env: counting, requests };
}
/** The environment with the rows its database statements read summed. */
function metered() {
  const read = { rows: 0 };
  const database = runtime.DB;
  const inners = new WeakMap<object, D1PreparedStatement>();
  const statement = (inner: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = {
      bind: (...values: unknown[]) => statement(inner.bind(...values)),
      all: async () => {
        const result = await inner.all();
        read.rows += result.meta.rows_read;
        return result;
      },
      run: async () => {
        const result = await inner.run();
        read.rows += result.meta.rows_read;
        return result;
      },
    } as unknown as D1PreparedStatement;
    inners.set(wrapped, inner);
    return wrapped;
  };
  const env = {
    ...runtime,
    DB: {
      prepare: (sql: string) => statement(database.prepare(sql)),
      batch: async (statements: D1PreparedStatement[]) => {
        const results = await database.batch(
          statements.map((s) => inners.get(s)!),
        );
        for (const result of results) read.rows += result.meta.rows_read;
        return results;
      },
    },
  } as unknown as Env;
  return { env, read };
}
const packs = async (tenant: string) =>
  (await runtime.ARTIFACTS.list({ prefix: `cache/${tenant}/packs/` })).objects
    .map((o) => o.key)
    .sort();

describe("cache packs", () => {
  it("stores a step's entries with a handful of requests and reads each pack once", async () => {
    const tenant = "packs-bounded";
    // A store step's worth of entries: Elasticsearch@e38d20c stored 2,630
    // entries in one step, an object each, and ended at the request limit.
    const count = 4 * PACK_ENTRIES;
    const keys = Array.from({ length: count }, (_, n) => keyedHunk("big", n));
    const all = keys.map((_, n): [number, never[]] => [n, []]);
    const writing = counted();
    expect(
      await storeEntries(writing.env, tenant, "correctness", keys, all, 7),
    ).toBe(count);
    expect(writing.requests.put).toBe(4);
    expect(writing.requests.delete).toBe(0);
    expect(
      writing.requests.put + writing.requests.database,
    ).toBeLessThanOrEqual(16);
    expect(await entries(tenant)).toBe(count);
    const stored = await packs(tenant);
    expect(stored).toHaveLength(4);
    // A retried step rewrites the same objects.
    await storeEntries(runtime, tenant, "correctness", keys, all, 7);
    expect(await packs(tenant)).toEqual(stored);
    expect(await entries(tenant)).toBe(count);
    // A lookup step's chunk of keys reads the packs holding them, once each.
    const reading = counted();
    const chunk = keys.slice(200, 450);
    const hits = await lookup(reading.env, tenant, chunk);
    expect(Object.keys(hits)).toHaveLength(chunk.length);
    expect(hits[0]).toMatchObject({
      agent: "correctness",
      hunk: { path: "big/200.ts" },
      hypotheses: [],
      tokens: 7,
    });
    expect(reading.requests.get).toBe(2);
    expect(reading.requests.put + reading.requests.delete).toBe(0);
  });

  it("bounds a pack by the bytes its object takes, not by its characters", async () => {
    const tenant = "packs-bytes";
    // Text outside ASCII is two or three bytes a character: counted in
    // characters, these eight entries were one object of 3.8 MiB.
    const keys = Array.from({ length: 8 }, (_, n) => keyedHunk("wide", n));
    const wide = (n: number) => ({
      ...hyp(`wide/${n}.ts`, 1, "a"),
      message: "é".repeat(170 * 1024) + "語".repeat(50 * 1024),
    });
    const all = keys.map((_, n): [number, any[]] => [n, [wide(n)]]);
    expect(
      await storeEntries(runtime, tenant, "correctness", keys, all, 7),
    ).toBe(8);
    const sizes = (
      await runtime.ARTIFACTS.list({ prefix: `cache/${tenant}/packs/` })
    ).objects.map((o) => o.size);
    // Four entries of 490 KiB to a pack; the fifth would cross the bound.
    expect(sizes).toHaveLength(2);
    for (const size of sizes) {
      expect(size).toBeGreaterThan(1.5 * 1024 * 1024);
      expect(size).toBeLessThanOrEqual(PACK_BYTES);
    }
    expect(await entries(tenant)).toBe(8);
    const hits = await lookup(runtime, tenant, keys);
    expect(Object.keys(hits)).toHaveLength(8);
    expect(hits[7].hypotheses[0].message).toBe(wide(7).message);
    // An entry larger than a pack is stored alone, and its neighbours are
    // not held back by it.
    const huge = "packs-huge";
    const three = [0, 1, 2].map((n) => keyedHunk("huge", n));
    const over = {
      ...hyp("huge/1.ts", 1, "b"),
      message: "語".repeat(PACK_BYTES / 3 + 1024),
    };
    expect(
      await storeEntries(
        runtime,
        huge,
        "correctness",
        three,
        [
          [0, []],
          [1, [over]],
          [2, []],
        ],
        7,
      ),
    ).toBe(3);
    expect(await packs(huge)).toHaveLength(3);
    const found = await lookup(runtime, huge, three);
    expect(found[1].hypotheses[0].message).toBe(over.message);
    expect(found[2].hypotheses).toEqual([]);
  });

  it("stores and looks up by key, however many entries the tenant has", async () => {
    const tenant = "packs-scale";
    // The live table held 22,208 entries when one store step read 5.6 million
    // rows for a pack of 256, and two such steps overloaded the database for
    // every review. The tenant's other entries here: one pack and one object each.
    const others = 4000;
    await runtime.DB.prepare(
      "WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<?) INSERT INTO agent_cache(tenant,hunk_hash,context_hash,object_key,created_at) SELECT ?,'other-h'||i,'other-c'||i,'cache/packs-scale/other-'||i||'.json',? FROM n",
    )
      .bind(others - 1, tenant, Date.now())
      .run();
    const count = 2 * PACK_ENTRIES;
    const keys = Array.from({ length: count }, (_, n) => keyedHunk("scale", n));
    const all = keys.map((_, n): [number, never[]] => [n, []]);
    // An entry of the change stored before, under an object of its own.
    const earlier = `cache/${tenant}/scale-h3/scale-c3.json`;
    await runtime.ARTIFACTS.put(earlier, "{}");
    await runtime.DB.prepare(
      "INSERT INTO agent_cache(tenant,hunk_hash,context_hash,object_key,created_at) VALUES(?,?,?,?,?)",
    )
      .bind(tenant, "scale-h3", "scale-c3", earlier, Date.now())
      .run();
    const writing = metered();
    await storeEntries(writing.env, tenant, "correctness", keys, all, 7);
    expect(await entries(tenant)).toBe(others + count);
    expect(await runtime.ARTIFACTS.get(earlier)).toBeNull();
    // A few rows per entry stored, not the tenant's entries per pack.
    expect(writing.read.rows).toBeLessThan(8 * count);
    const reading = metered();
    const hits = await lookup(reading.env, tenant, keys);
    expect(Object.keys(hits)).toHaveLength(count);
    expect(reading.read.rows).toBeLessThan(8 * count);
  });

  it("keeps a pack while an entry of it remains and replaces an entry's old object", async () => {
    const tenant = "packs-retention";
    const now = Date.now(),
      old = now - EVIDENCE_RETENTION_MS - 1000;
    const keys = [0, 1, 2].map((n) => keyedHunk("keep", n));
    // One pack of three entries, written before the retention.
    await storeCache(runtime, tenant, "correctness", keys, [0, 1, 2], [], 9, old);
    const [pack] = await packs(tenant);
    expect(await packs(tenant)).toHaveLength(1);
    // The same change later, the first entry only (the others' contexts
    // changed): the new pack holds it and the old pack keeps the other two.
    await storeCache(runtime, tenant, "correctness", keys, [0], [], 3, now);
    expect(await packs(tenant)).toHaveLength(2);
    expect(await runtime.ARTIFACTS.get(pack)).not.toBeNull();
    // An entry stored before packs has an object of its own; a new entry for
    // the same hunk takes its row, and the object goes.
    const legacy = `cache/${tenant}/keep-h7/keep-c7.json`;
    await runtime.ARTIFACTS.put(
      legacy,
      JSON.stringify({ agent: "correctness", hypotheses: [], tokens: 5 }),
    );
    await runtime.DB.prepare(
      "INSERT INTO agent_cache(tenant,hunk_hash,context_hash,object_key,created_at) VALUES(?,?,?,?,?)",
    )
      .bind(tenant, "keep-h7", "keep-c7", legacy, now)
      .run();
    const seven = keyedHunk("keep", 7);
    expect((await lookup(runtime, tenant, [seven], now))[0].tokens).toBe(5);
    await storeCache(runtime, tenant, "correctness", [seven], [0], [], 4, now);
    expect(await runtime.ARTIFACTS.get(legacy)).toBeNull();
    expect((await lookup(runtime, tenant, [seven], now))[0].tokens).toBe(4);
    // The lookup of an expired entry removes its row; the pack stays for the
    // entry still indexed, and goes with it.
    const hits = await lookup(runtime, tenant, keys.slice(0, 2), now);
    expect(Object.keys(hits)).toEqual(["0"]);
    expect(await entries(tenant)).toBe(3);
    expect(await runtime.ARTIFACTS.get(pack)).not.toBeNull();
    expect(await expire(runtime, tenant, now)).toBe(1);
    expect(await runtime.ARTIFACTS.get(pack)).toBeNull();
    expect(await packs(tenant)).toHaveLength(2);
    expect(await entries(tenant)).toBe(2);
  });
});

describe("agent result cache store", () => {
  const change = (tag: string, files: number) => {
    const names = Array.from({ length: files }, (_, n) => `src/${tag}/f${n}.ts`);
    return {
      base: Object.fromEntries(
        names.map((p, n) => [p, `function f${n}() {\n  return 0; // ${tag}\n}\n`]),
      ),
      head: Object.fromEntries(
        names.map((p, n) => [p, `function f${n}() {\n  return 1; // ${tag}\n}\n`]),
      ),
    };
  };

  it("populates and replays a change of more hunks than one pack or lookup step holds", async () => {
    const tenant = "tenant-cache-packs";
    const files = change("wide", PACK_ENTRIES + 44);
    // The first message of so wide a change is more than a third of the
    // fixture's tokens: the one agent takes them all.
    const mutate = (s: Submission) => {
      s.profile.budget.fast.agents_max = 1;
    };
    const first = await review({
      files,
      tenant,
      mutate,
      agent: () => [hyp("src/wide/f7.ts", 2, "f7")],
    });
    expect(first.report.footer.notes.join("\n")).not.toMatch(/result cache/);
    expect(first.report.cache).toMatchObject({
      lookups: PACK_ENTRIES + 44,
      hits: 0,
    });
    expect(await entries(tenant)).toBe(PACK_ENTRIES + 44);
    expect(await packs(tenant)).toHaveLength(2);
    const second = await review({
      files,
      tenant,
      mutate,
      agent: () => {
        throw new Error("no model call expected");
      },
    });
    expect(second.calls).not.toContain("agent");
    expect(second.report.cache).toMatchObject({
      lookups: PACK_ENTRIES + 44,
      hits: PACK_ENTRIES + 44,
    });
    expect(reported(second.report)[0].source).toEqual({
      agent: "correctness",
      cached: true,
    });
    expect(await packs(tenant)).toHaveLength(2);
  }, 240000);

  it("keeps the review when the store cannot finish, and says the cache was not updated", async () => {
    const tenant = "tenant-cache-store-fails";
    const files = change("unstored", 3);
    const run = await review({
      files,
      tenant,
      agent: () => [hyp("src/unstored/f1.ts", 2, "f1")],
      // The limit repeats on every attempt, as it did live.
      modify: async (m) => {
        await m.disableRetryDelays();
        await m.mockStepError(
          { name: "cache-store-agents-correctness-0" },
          new Error("Too many API requests by single Worker invocation."),
        );
      },
    });
    expect(run.report.status).not.toBe("failed");
    expect(reported(run.report)).toHaveLength(1);
    expect(run.report.footer.notes.join("\n")).toMatch(
      /Agent result cache not updated for correctness: .*Too many API requests/,
    );
    expect(await entries(tenant)).toBe(0);
    // The next review of the change runs the agent: nothing was half-stored.
    const again = await review({
      files,
      tenant,
      agent: () => [hyp("src/unstored/f1.ts", 2, "f1")],
    });
    expect(again.calls).toContain("agent");
    expect(again.report.cache).toMatchObject({ lookups: 3, hits: 0 });
    expect(await entries(tenant)).toBe(3);
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

import { describe, it, expect } from "vitest";
import {
  OUTPUT_LIMIT,
  PROMPT_GRAPH_BYTES,
  Tools,
  promptGraph,
} from "../src/tools";
import type { Graph } from "../src/types";
import { graphs as legacy } from "./fixtures";
import ioredis from "./fixtures/graph/ioredis-2096.json";

const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;
const HASH = /[0-9a-f]{64}/;

// Node ids are content hashes. These are chosen so that the users a reviewer
// needs least sort first: an excerpt picked in id order keeps only those.
const node = (
  id: string,
  path: string,
  symbol: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  kind: "function",
  path,
  symbol_path: symbol,
  name: symbol.split(".").at(-1),
  line_start: 10,
  line_end: 20,
  version: "head",
  seed: false,
  hop: 1,
  ...extra,
});
const edge = (from: string, to: string, kind: string, confidence: string) => ({
  from,
  to,
  kind,
  source: "tree-sitter",
  confidence,
  version: "head",
});
function ranked(): Graph {
  const nodes = [
    node("f0-seed-a", "src/a.ts", "a.changed", { seed: true, hop: 0 }),
    node("f1-seed-b", "src/b.ts", "b.changed", { seed: true, hop: 0 }),
    node("00-in-diff", "src/a.ts", "a.helper"),
    node("01-test", "test/a.test.ts", "a.test.case", { kind: "test" }),
    node("02-unresolved", "lib/guess.ts", "guess.maybe"),
    node("03-by-name", "lib/named.ts", "named.same"),
    node("04-second", "lib/caller.ts", "caller.second", { line_start: 40 }),
    node("fe-caller-a", "lib/caller.ts", "caller.first"),
    node("ff-caller-b", "lib/other.ts", "other.uses"),
  ];
  for (let i = 0; i < 12; i++)
    nodes.push(
      node(
        `1${i.toString(16)}-test`,
        `test/t${i + 10}.test.ts`,
        `t${i + 10}.case`,
        {
          kind: "test",
        },
      ),
    );
  const edges = [
    edge("00-in-diff", "f0-seed-a", "calls", "resolved"),
    edge("01-test", "f0-seed-a", "tests", "resolved"),
    edge("02-unresolved", "f0-seed-a", "calls", "unresolved"),
    edge("03-by-name", "f0-seed-a", "calls", "probable"),
    edge("04-second", "f0-seed-a", "calls", "resolved"),
    edge("fe-caller-a", "f0-seed-a", "calls", "resolved"),
    edge("ff-caller-b", "f1-seed-b", "references", "resolved"),
    ...nodes
      .filter((n) => /^1.-test$/.test(n.id))
      .map((n) => edge(n.id, "f0-seed-a", "tests", "resolved")),
  ];
  return { nodes, edges } as Graph;
}
const empty: Graph = { nodes: [], edges: [] };
const users = (excerpt: ReturnType<typeof promptGraph>, symbol: string) =>
  excerpt.changed_symbols
    .find((s) => s.symbol === symbol)
    ?.used_by.map((u) => u.symbol);

describe("prompt graph excerpt", () => {
  it("lists each changed symbol with the code that uses it, most telling first", () => {
    const excerpt = promptGraph({ base: empty, head: ranked() }, 1 << 20);
    expect(excerpt.truncated).toBe(false);
    expect(excerpt.symbols_without_users).toBe(0);
    expect(excerpt.changed_symbols.map((s) => s.symbol)).toEqual([
      "a.changed",
      "b.changed",
    ]);
    // Callers outside the diff that the graph located, one per file first; then
    // name matches, unresolved imports, tests, and last the changed file itself.
    expect(users(excerpt, "a.changed")).toEqual([
      "caller.first",
      "caller.second",
      "named.same",
      "guess.maybe",
      "a.test.case",
      ...Array.from({ length: 12 }, (_, i) => `t${i + 10}.case`),
      "a.helper",
    ]);
    expect(excerpt.changed_symbols[0]).toMatchObject({
      path: "src/a.ts",
      symbol: "a.changed",
      kind: "function",
      head: "10-20",
    });
    expect(excerpt.changed_symbols[0]).not.toHaveProperty("base");
    expect(excerpt.changed_symbols[0].used_by.slice(0, 3)).toEqual([
      {
        path: "lib/caller.ts",
        symbol: "caller.first",
        lines: "10-20",
        relation: "calls",
        match: "resolved",
      },
      {
        path: "lib/caller.ts",
        symbol: "caller.second",
        lines: "40-20",
        relation: "calls",
        match: "resolved",
      },
      {
        path: "lib/named.ts",
        symbol: "named.same",
        lines: "10-20",
        relation: "calls",
        match: "name",
      },
    ]);
  });
  it("does not select by node id: located callers outside the diff survive a tight budget", () => {
    const graph = ranked();
    const whole = promptGraph({ base: empty, head: graph }, 1 << 20);
    // Room for about three of the nineteen users.
    const budget = 700;
    const excerpt = promptGraph({ base: empty, head: graph }, budget);
    expect(bytes(excerpt)).toBeLessThanOrEqual(budget);
    expect(bytes(whole)).toBeGreaterThan(budget * 3);
    expect(excerpt.truncated).toBe(true);
    // In id order the budget would go to 00-in-diff, 01-test, 02-unresolved …
    // and both callers below (ids fe…, ff…) would be cut.
    expect(users(excerpt, "a.changed")?.[0]).toBe("caller.first");
    // One widely used symbol does not use up the room of the next one.
    expect(users(excerpt, "b.changed")).toEqual(["other.uses"]);
    const listed = excerpt.changed_symbols.flatMap((s) =>
      s.used_by.map((u) => u.path),
    );
    expect(listed).not.toContain("src/a.ts");
    expect(listed.some((path) => path.startsWith("test/"))).toBe(false);
    const a = excerpt.changed_symbols.find((s) => s.symbol === "a.changed")!;
    expect(a.more_users).toBe(18 - a.used_by.length);
    // The order of the stored arrays does not matter either.
    const reversed = {
      nodes: [...graph.nodes].reverse(),
      edges: [...graph.edges].reverse(),
    };
    expect(promptGraph({ base: empty, head: reversed }, budget)).toEqual(
      excerpt,
    );
    expect(JSON.stringify(excerpt)).not.toMatch(/"(node_id|id|from|to)"/);
  });
  it("stays within any byte budget and counts what it left out", () => {
    const graph = ranked();
    for (const budget of [1, 100, 300, 500, 900, 1500]) {
      const excerpt = promptGraph({ base: empty, head: graph }, budget);
      if (budget >= 100) expect(bytes(excerpt)).toBeLessThanOrEqual(budget);
      const shown = excerpt.changed_symbols.length;
      expect(shown + (excerpt.symbols_not_listed ?? 0)).toBe(2);
      expect(excerpt.truncated).toBe(true);
    }
    expect(
      promptGraph({ base: empty, head: graph }, 1).changed_symbols,
    ).toEqual([]);
    expect(
      promptGraph({ base: empty, head: { ...graph, truncated: true } }, 1 << 20)
        .truncated,
    ).toBe(true);
  });
  it("merges base and head by symbol and says which side a user is on", () => {
    const base: Graph = {
      nodes: [
        node("b-seed", "src/a.ts", "a.changed", { seed: true, hop: 0 }),
        node("b-gone", "src/gone.ts", "gone.removed", { seed: true, hop: 0 }),
        node("b-old", "lib/old.ts", "old.caller"),
        node("b-keep", "lib/keep.ts", "keep.caller", { line_end: 30 }),
        node("b-last", "lib/last.ts", "last.caller"),
      ],
      edges: [
        edge("b-old", "b-seed", "calls", "resolved"),
        edge("b-keep", "b-seed", "calls", "resolved"),
        edge("b-last", "b-gone", "calls", "resolved"),
      ],
    } as Graph;
    const head: Graph = {
      nodes: [
        // Not marked at head: the change removed lines, so only base marks it.
        node("h-seed", "src/a.ts", "a.changed", { line_end: 25 }),
        node("h-keep", "lib/keep.ts", "keep.caller"),
        node("h-new", "lib/new.ts", "new.caller"),
      ],
      edges: [
        edge("h-keep", "h-seed", "calls", "resolved"),
        edge("h-new", "h-seed", "calls", "resolved"),
      ],
    } as Graph;
    const excerpt = promptGraph({ base, head });
    expect(excerpt).toEqual({
      changed_symbols: [
        {
          path: "src/a.ts",
          symbol: "a.changed",
          kind: "function",
          base: "10-20",
          head: "10-25",
          used_by: [
            {
              path: "lib/keep.ts",
              symbol: "keep.caller",
              lines: "10-20",
              relation: "calls",
              match: "resolved",
            },
            {
              path: "lib/new.ts",
              symbol: "new.caller",
              lines: "10-20",
              relation: "calls",
              match: "resolved",
              only_in: "head",
            },
            {
              path: "lib/old.ts",
              symbol: "old.caller",
              lines: "10-20",
              relation: "calls",
              match: "resolved",
              only_in: "base",
            },
          ],
        },
        {
          // Removed at head; whoever called it at base is where a break shows.
          path: "src/gone.ts",
          symbol: "gone.removed",
          kind: "function",
          base: "10-20",
          used_by: [
            {
              path: "lib/last.ts",
              symbol: "last.caller",
              lines: "10-20",
              relation: "calls",
              match: "resolved",
            },
          ],
        },
      ],
      symbols_without_users: 0,
      truncated: false,
    });
  });
  it("counts changed symbols nothing uses and reads graphs without slice metadata", () => {
    const graph = ranked();
    graph.nodes.push(
      node("aa-unused", "src/c.ts", "c.unused", { seed: true, hop: 0 }),
    );
    const excerpt = promptGraph({ base: empty, head: graph });
    expect(excerpt.symbols_without_users).toBe(1);
    expect(excerpt.changed_symbols.map((s) => s.symbol)).not.toContain(
      "c.unused",
    );
    // Older submissions mark no seeds: every node is then a changed symbol.
    expect(promptGraph(legacy)).toEqual({
      changed_symbols: [],
      symbols_without_users: 1,
      truncated: false,
    });
    const unmarked: Graph = {
      nodes: [
        { id: "x", path: "a.ts", symbol_path: "x", line_start: 1, line_end: 2 },
        { id: "y", path: "b.ts", symbol_path: "y", line_start: 3, line_end: 4 },
      ],
      edges: [{ from: "y", to: "x", kind: "calls" }],
    };
    expect(
      promptGraph({ base: empty, head: unmarked }).changed_symbols,
    ).toEqual([
      {
        path: "a.ts",
        symbol: "x",
        head: "1-2",
        used_by: [
          { path: "b.ts", symbol: "y", lines: "3-4", relation: "calls" },
        ],
      },
    ]);
  });
});

// Graphs as the Rust builder stores them, for a pull request whose defect shows
// only in a file outside the diff (lib/Pipeline.ts) that uses a changed symbol.
describe("prompt graph excerpt of a stored graph", () => {
  const stored = ioredis as unknown as { base: Graph; head: Graph };
  const changed = new Set(ioredis.changed_files);
  const usersOf = (excerpt: ReturnType<typeof promptGraph>) =>
    excerpt.changed_symbols.flatMap((s) => s.used_by.map((u) => u.path));
  it("has the evidence file as a direct user of a changed symbol", () => {
    const seeds = new Set(
      stored.head.nodes.filter((n) => n.seed).map((n) => n.id),
    );
    const inFile = new Set(
      stored.head.nodes
        .filter((n) => n.path === ioredis.evidence_file)
        .map((n) => n.id),
    );
    expect(changed.has(ioredis.evidence_file)).toBe(false);
    expect(
      stored.head.edges.some((e) => inFile.has(e.from) && seeds.has(e.to)),
    ).toBe(true);
    expect(Object.keys(stored.head.nodes[0])).toEqual([
      "id",
      "kind",
      "path",
      "symbol_path",
      "name",
      "line_start",
      "line_end",
      "version",
      "seed",
      "hop",
      "content_hash",
    ]);
    expect(Object.keys(stored.head.edges[0])).toEqual([
      "from",
      "to",
      "kind",
      "source",
      "confidence",
      "version",
    ]);
  });
  it.each([PROMPT_GRAPH_BYTES, 8192, 4096])(
    "names the evidence file within %i bytes",
    (budget) => {
      const excerpt = promptGraph(stored, budget);
      expect(bytes(excerpt)).toBeLessThanOrEqual(budget);
      const user = excerpt.changed_symbols
        .filter((s) => s.path === "lib/cluster/index.ts")
        .flatMap((s) => s.used_by)
        .find((u) => u.path === ioredis.evidence_file);
      expect(user).toMatchObject({
        symbol: "Pipeline.Pipeline.constructor",
        relation: "references",
        match: "resolved",
      });
      expect(user!.lines).toMatch(/^\d+-\d+$/);
      // Readable without the graph: no node ids, no edge list.
      expect(JSON.stringify(excerpt)).not.toMatch(HASH);
      expect(excerpt.changed_symbols.every((s) => changed.has(s.path))).toBe(
        true,
      );
    },
  );
  it("spends the budget on code outside the diff before tests and the diff itself", () => {
    const tight = usersOf(promptGraph(stored, 4096));
    expect(tight.length).toBeGreaterThan(8);
    expect(tight.filter((path) => changed.has(path))).toEqual([]);
    expect(tight.filter((path) => path.startsWith("test/"))).toEqual([]);
    const whole = usersOf(promptGraph(stored, 1 << 20));
    expect(whole.some((path) => changed.has(path))).toBe(true);
    expect(whole.some((path) => path.startsWith("test/"))).toBe(true);
  });
});

describe("graph_query", () => {
  const stored = ioredis as unknown as { base: Graph; head: Graph };
  const tools = (hops = 2, maxNodes = 2000) =>
    new Tools({ base: {}, head: {} }, stored, undefined, hops, maxNodes);
  const error = (args: unknown, t = tools()) =>
    t.dispatch("graph_query", args).then(
      () => "no error",
      (e: Error) => e.message,
    );
  it("answers by path and symbol with the direct users, in head by default", async () => {
    const result = await tools().dispatch("graph_query", {
      path: "lib/cluster/index.ts",
      symbol: "Cluster.constructor",
    });
    expect(result.version).toBe("head");
    expect(result.symbols).toHaveLength(1);
    const [symbol] = result.symbols;
    expect(symbol).toMatchObject({
      path: "lib/cluster/index.ts",
      symbol: "index.Cluster.constructor",
      kind: "method",
    });
    expect(symbol.node_id).toMatch(HASH);
    expect(symbol.lines).toMatch(/^\d+-\d+$/);
    const user = symbol.used_by.find(
      (u: any) => u.path === ioredis.evidence_file,
    );
    expect(user).toMatchObject({
      symbol: "Pipeline.Pipeline.constructor",
      relation: "references",
      match: "resolved",
    });
    expect(user.node_id).toMatch(HASH);
    // One hop by default: no users of users.
    expect(symbol.used_by.every((u: any) => u.used_by === undefined)).toBe(
      true,
    );
    expect(Array.isArray(symbol.uses)).toBe(true);
    // The full dotted name and the bare name address the same symbol.
    for (const name of ["index.Cluster.constructor", "constructor"])
      expect(
        (
          await tools().dispatch("graph_query", {
            path: "lib/cluster/index.ts",
            symbol: name,
            version: "head",
          })
        ).symbols.map((s: any) => s.node_id),
      ).toContain(symbol.node_id);
  });
  it("lists every symbol of a file when no symbol is named, and only them at 0 hops", async () => {
    const all = await tools().dispatch("graph_query", {
      path: "lib/cluster/ConnectionPool.ts",
    });
    expect(all.symbols.length).toBeGreaterThan(3);
    expect(
      all.symbols.every((s: any) => s.path === "lib/cluster/ConnectionPool.ts"),
    ).toBe(true);
    expect(all.symbols.some((s: any) => s.used_by.length > 0)).toBe(true);
    const bare = await tools().dispatch("graph_query", {
      path: "lib/cluster/ConnectionPool.ts",
      hops: 0,
    });
    expect(bare.symbols.map((s: any) => s.node_id).sort()).toEqual(
      all.symbols.map((s: any) => s.node_id).sort(),
    );
    expect(bare.symbols.every((s: any) => !("used_by" in s))).toBe(true);
  });
  it("follows users of users at 2 hops", async () => {
    const result = await tools().dispatch("graph_query", {
      path: "lib/cluster/ClusterOptions.ts",
      hops: 2,
    });
    const nested = result.symbols
      .flatMap((s: any) => s.used_by)
      .flatMap((u: any) => u.used_by ?? []);
    expect(nested.length).toBeGreaterThan(0);
    expect(nested.every((u: any) => HASH.test(u.node_id))).toBe(true);
  });
  it("accepts a node id and returns ids and edges for evidence", async () => {
    const { symbols } = await tools().dispatch("graph_query", {
      path: "lib/cluster/index.ts",
      symbol: "Cluster.constructor",
    });
    const id = symbols[0].node_id;
    // The version is found from the id when it is not sent.
    const result = await tools().dispatch("graph_query", { node_id: id });
    expect(result.version).toBe("head");
    expect(result.nodes[0]).toMatchObject({
      id,
      path: "lib/cluster/index.ts",
      symbol_path: "index.Cluster.constructor",
      seed: true,
    });
    const ids = new Set(result.nodes.map((n: any) => n.id));
    expect(ids.size).toBeGreaterThan(1);
    expect(result.edges.length).toBeGreaterThan(0);
    expect(
      result.edges.every((e: any) => ids.has(e.from) && ids.has(e.to)),
    ).toBe(true);
    expect(result.edges.some((e: any) => e.from === id || e.to === id)).toBe(
      true,
    );
    const alone = await tools().dispatch("graph_query", {
      node_id: id,
      version: "head",
      hops: 0,
    });
    expect(alone.nodes.map((n: any) => n.id)).toEqual([id]);
    expect(alone.edges).toEqual([]);
    expect(alone.truncated).toBe(true);
    const base = stored.base.nodes.find(
      (n) => !stored.head.nodes.some((h) => h.id === n.id),
    )!;
    expect(
      (await tools().dispatch("graph_query", { node_id: base.id })).version,
    ).toBe("base");
    expect(await error({ node_id: base.id, version: "head" })).toBe(
      'node_id is not in the head graph; it is a base node, send version "base"',
    );
    expect(await error({ node_id: "nope" })).toBe(
      'node_id is not in the head graph; query by "path" and "symbol" instead',
    );
  });
  it("keeps every answer under the output limit and the host bounds", async () => {
    for (const args of [
      { path: "lib/cluster/index.ts", hops: 2 },
      { path: "lib/cluster/ConnectionPool.ts", hops: 2 },
      { node_id: stored.head.nodes.find((n) => n.seed)!.id, hops: 2 },
    ]) {
      const result = await tools().dispatch("graph_query", args);
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(OUTPUT_LIMIT);
    }
    const few = await tools(2, 5).dispatch("graph_query", {
      path: "lib/cluster/index.ts",
    });
    const listed = few.symbols.flatMap((s: any) => [
      ...s.used_by,
      ...(s.uses ?? []),
    ]);
    expect(listed).toHaveLength(5);
    expect(few.truncated).toBe(true);
    const capped = await tools().dispatch("graph_query", {
      node_id: stored.head.nodes.find((n) => n.seed)!.id,
      hops: 2,
      max_nodes: 3,
    });
    expect(capped.nodes).toHaveLength(3);
    expect(capped.truncated).toBe(true);
    const bounds =
      "graph bounds exceeded: hops must be a whole number from 0 to 2 and max_nodes from 1 to 2000";
    expect(await error({ path: "lib/cluster/index.ts", hops: 3 })).toBe(bounds);
    expect(await error({ path: "lib/cluster/index.ts", hops: 1.5 })).toBe(
      bounds,
    );
    expect(await error({ path: "lib/cluster/index.ts", max_nodes: 2001 })).toBe(
      bounds,
    );
    // A host that allows no hops still answers where a symbol is.
    const none = await tools(0).dispatch("graph_query", {
      path: "lib/cluster/index.ts",
      symbol: "Cluster.constructor",
    });
    expect(none.symbols).toHaveLength(1);
    expect(none.symbols[0]).not.toHaveProperty("used_by");
  });
  it("says what to send when a query matches nothing or is malformed", async () => {
    const unknown = await tools().dispatch("graph_query", {
      path: "lib/cluster/index.ts",
      symbol: "nothingLikeThis",
    });
    expect(unknown.symbols).toEqual([]);
    expect(unknown.note).toContain(
      'no symbol "nothingLikeThis" at this path in the head graph; its symbols there are ',
    );
    expect(unknown.note).toContain("index.Cluster.constructor");
    expect(
      (await tools().dispatch("graph_query", { path: "lib/nowhere.ts" })).note,
    ).toBe(
      "the head graph has no symbol at this path; the graph covers the changed symbols and the code within 2 hops of them, use search for anything else",
    );
    const need =
      'graph_query needs "path" (a file path, with an optional "symbol" name in that file) or "node_id", not both; it answers with the code that uses that symbol';
    expect(await error({})).toBe(need);
    expect(await error({ symbol: "Cluster" })).toBe(need);
    expect(await error({ path: "lib/cluster/index.ts", node_id: "x" })).toBe(
      need,
    );
    expect(await error({ node_id: "x", symbol: "Cluster" })).toBe(need);
    expect(await error({ path: "../etc/passwd" })).toBe(
      'graph_query "path" must be a file path relative to the repository root, such as "src/main.ts"',
    );
    expect(await error({ path: "lib/cluster/index.ts", symbol: 7 })).toBe(
      'graph_query "symbol" must be a symbol name such as "parse" or "Parser.parse"',
    );
    expect(await error({ path: "lib/cluster/index.ts", version: "main" })).toBe(
      'graph_query needs "version": "base" or "head"',
    );
    expect(
      await error({ path: "lib/cluster/index.ts", direction: "callers" }),
    ).toBe(
      'graph_query does not take "direction"; its arguments are path, symbol, node_id, version, hops, max_nodes',
    );
  });
});

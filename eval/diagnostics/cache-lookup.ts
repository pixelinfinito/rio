// Times the Worker's cache-lookup step body (without D1/R2 I/O) on pinned inputs and
// checks that the memoized path yields identical keys. Inputs are described in
// docs/design/aacr-runtime-limits.md. Build and run from the repository root:
//   worker/node_modules/.bin/esbuild eval/diagnostics/cache-lookup.ts --bundle \
//     --platform=neutral --format=esm --main-fields=module,main \
//     --external:node:fs --outfile=/tmp/cache-lookup.mjs
//   node /tmp/cache-lookup.mjs <dir with base/ and head/> <changed.txt> <graph job.json>
import { readFileSync, existsSync } from "node:fs";
import { changeHunks, context, ContextMemo, hunkHash } from "../../worker/src/cache";
import { decodeText } from "../../worker/src/snapshot";

const [trees, changedList, graphJob] = process.argv.slice(2);
const changed = readFileSync(changedList, "utf8")
  .trim()
  .split("\n")
  .map((line) => {
    const [status, a, b] = line.split("\t");
    return status.startsWith("R")
      ? { path: b, old_path: a, status: "renamed" }
      : { path: a, status };
  }) as any[];
const graphs = JSON.parse(readFileSync(graphJob, "utf8")).artifact.graphs;

// Mirrors StoredSnapshot on an LRU hit: bytes are cached, text is decoded per call.
const bytes = new Map<string, Uint8Array | null>();
let reads = 0,
  decoded = 0,
  misses = 0,
  missBytes = 0,
  used = 0;
const LRU_LIMIT = 16 * 1024 * 1024;
const lru = new Map<string, number>();
const read = async (version: "base" | "head", path: string) => {
  reads++;
  const key = `${version}:${path}`;
  if (!bytes.has(key)) {
    const file = `${trees}/${version}/${path}`;
    bytes.set(key, existsSync(file) ? new Uint8Array(readFileSync(file)) : null);
  }
  const b = bytes.get(key)!;
  if (b === null) return null;
  // StoredSnapshot's 16 MiB content LRU, keyed by content (base/head share packs).
  const other = bytes.get(`${version === "base" ? "head" : "base"}:${path}`);
  const content =
    other && other.length === b.length && Buffer.compare(other, b) === 0
      ? `same:${path}`
      : key;
  if (lru.has(content)) {
    lru.delete(content);
    lru.set(content, b.length);
  } else {
    misses++;
    missBytes += b.length;
    if (b.length <= LRU_LIMIT) {
      lru.set(content, b.length);
      used += b.length;
      for (const [k, size] of lru) {
        if (used <= LRU_LIMIT) break;
        lru.delete(k);
        used -= size;
      }
    }
  }
  decoded += b.length;
  return decodeText(b);
};

const inputs = {
  agent: "correctness",
  layout: [],
  manifest_version: 1,
  prompt: "x".repeat(8000),
  model: "openai/custom-node-anthropic/claude-sonnet-5-5",
  options: { model: "default" },
  engine: "0.3.5",
  graphs,
  guidance: [],
  read,
  base_graph: true,
};

let t = performance.now();
const hunks = await changeHunks(changed, read);
const tHunks = performance.now() - t;
console.log(`hunks=${hunks.length} changeHunks_ms=${tHunks.toFixed(0)}`);

// Neighbourhood sizes as context() computes them (single mutating pass).
const sizes: number[] = [], oneHop: number[] = [];
for (const h of hunks)
  for (const version of ["base", "head"] as const) {
    const g = graphs[version];
    const path = version === "base" ? h.old_path : h.path;
    const side = h[version];
    const start = side.count ? side.start : Math.max(1, side.start - 1),
      end = side.count ? side.start + side.count - 1 : side.start;
    const enclosing = g.nodes.filter(
      (n: any) => n.path === path && n.line_start <= end && n.line_end >= start,
    );
    if (!enclosing.length) continue;
    const ids = new Set(enclosing.map((n: any) => n.id));
    const seeds = new Set(ids);
    for (const e of g.edges) {
      if (ids.has(e.from)) ids.add(e.to);
      else if (ids.has(e.to)) ids.add(e.from);
    }
    sizes.push(ids.size);
    // A true one-hop neighbourhood, as the context-hash doc comment states.
    const one = new Set(seeds);
    for (const e of g.edges) {
      if (seeds.has(e.from)) one.add(e.to);
      if (seeds.has(e.to)) one.add(e.from);
    }
    oneHop.push(one.size);
  }
for (const [name, list] of [["single-pass (current)", sizes], ["true one-hop", oneHop]] as const) {
  list.sort((a, b) => a - b);
  const q = (p: number) => list[Math.floor((list.length - 1) * p)];
  console.log(
    `${name}: sides=${list.length} neighbourhood p50=${q(0.5)} p90=${q(0.9)} max=${q(1)} sum=${list.reduce((a, b) => a + b, 0)}`,
  );
}

reads = 0;
decoded = 0;
t = performance.now();
let n = 0;
for (const hunk of hunks) {
  hunkHash(hunk);
  await context(hunk, inputs as any);
  if (++n % 50 === 0)
    console.log(`  ${n}/${hunks.length} ${(performance.now() - t).toFixed(0)} ms`);
}
const tContext = performance.now() - t;
console.log(
  `context_ms=${tContext.toFixed(0)} reads=${reads} decoded_MB=${(decoded / 1e6).toFixed(0)} per_hunk_ms=${(tContext / hunks.length).toFixed(1)}`,
);
console.log(
  `lru16MiB misses_total=${misses} miss_MB=${(missBytes / 1e6).toFixed(0)} (each miss is one R2 ranged GET)`,
);

// The memoized path must produce byte-identical keys.
const before: string[] = [];
for (const hunk of hunks) before.push((await context(hunk, inputs as any)).context_hash);
reads = decoded = misses = missBytes = 0;
t = performance.now();
const memo = new ContextMemo();
const after: string[] = [];
for (const hunk of hunks) {
  hunkHash(hunk);
  after.push((await context(hunk, { ...inputs, memo } as any)).context_hash);
}
const tMemo = performance.now() - t;
console.log(
  `memo context_ms=${tMemo.toFixed(0)} reads=${reads} decoded_MB=${(decoded / 1e6).toFixed(0)} lru_misses=${misses} identical_keys=${before.every((k, i) => k === after[i])}`,
);

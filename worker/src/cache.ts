import type { ChangedFile, Env, Graph, Guidance, Hypothesis } from "./types";
import { canonical, hash } from "./validation";

// Agent result cache (openspec rio-v0-3-core, agent-result-cache). Entries
// hold one agent's hypotheses for one changed hunk under
// `cache/<tenant>/<hunk_hash>/<context_hash>.json`; the `agent_cache` index
// row carries the creation time for retention. Verification never reads it.

/** The repository's evidence retention (TRD default; not yet configurable). */
export const EVIDENCE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export interface Hunk {
  path: string;
  old_path: string;
  // 1-based first line and line count on each side; a count of 0 is a pure
  // insertion or deletion after `start - 1`.
  base: { start: number; count: number };
  head: { start: number; count: number };
  text: string;
}

const lines = (text: string | null) =>
  text === null ? [] : text.replace(/\n$/, "").split("\n");

/** Line edit runs between two texts, without context lines. */
export function diffHunks(
  path: string,
  old_path: string,
  before: string | null,
  after: string | null,
): Hunk[] {
  const a = lines(before),
    b = lines(after);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix])
    prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++;
  const x = a.slice(prefix, a.length - suffix),
    y = b.slice(prefix, b.length - suffix);
  // Matched pairs by LCS on the differing middle; large middles are one hunk.
  const pairs: [number, number][] = [];
  if (x.length && y.length && x.length * y.length <= 4_000_000) {
    const table = Array.from(
      { length: x.length + 1 },
      () => new Uint32Array(y.length + 1),
    );
    for (let i = x.length - 1; i >= 0; i--)
      for (let j = y.length - 1; j >= 0; j--)
        table[i][j] =
          x[i] === y[j]
            ? table[i + 1][j + 1] + 1
            : Math.max(table[i + 1][j], table[i][j + 1]);
    for (let i = 0, j = 0; i < x.length && j < y.length;)
      if (x[i] === y[j]) pairs.push([i++, j++]);
      else if (table[i + 1][j] >= table[i][j + 1]) i++;
      else j++;
  }
  pairs.push([x.length, y.length]);
  const hunks: Hunk[] = [];
  let i = 0,
    j = 0;
  for (const [pi, pj] of pairs) {
    if (pi > i || pj > j) {
      const removed = x.slice(i, pi),
        added = y.slice(j, pj);
      hunks.push({
        path,
        old_path,
        base: { start: prefix + i + 1, count: removed.length },
        head: { start: prefix + j + 1, count: added.length },
        text: [
          ...removed.map((l) => `-${l.trimEnd()}`),
          ...added.map((l) => `+${l.trimEnd()}`),
        ].join("\n"),
      });
    }
    i = pi + 1;
    j = pj + 1;
  }
  return hunks;
}

export function hunkHash(h: Hunk): string {
  return hash(`${h.path}\0${h.text}`);
}

const overlaps = (
  node: { line_start: number; line_end: number },
  side: { start: number; count: number },
) => {
  const start = side.count ? side.start : Math.max(1, side.start - 1),
    end = side.count ? side.start + side.count - 1 : side.start;
  return node.line_start <= end && node.line_end >= start;
};

/**
 * The generation prompt layout's version (design D5): bumped for the tenant
 * partition line. With the enabled layout features it is part of the context
 * hash, so entries made under another layout are not replayed. The partition
 * value is not hashed: entries are already per tenant.
 */
export const PROMPT_LAYOUT_VERSION = 2;
export interface ContextInputs {
  agent: string;
  // Enabled layout features (`PROMPT_LAYOUT`), sorted.
  layout?: string[];
  manifest_version: number | string;
  prompt: string;
  model: string;
  options: unknown;
  // The Worker version: the generic agent preamble lives in Worker code.
  engine: string;
  graphs: { base: Graph; head: Graph };
  guidance: Guidance[];
  read: (version: "base" | "head", path: string) => Promise<string | null>;
  // Diff-only rounds compare against an earlier head the base graph does not
  // describe; their base side is keyed by whole-file content.
  base_graph: boolean;
  // Shared by every hunk of one lookup, so each file and symbol is read and
  // hashed once per change rather than once per hunk.
  memo?: ContextMemo;
}
/**
 * The context key's own version: 2 keys the true one-hop neighbourhood with
 * SHA-256 digests. Entries of another version are never replayed.
 */
export const CONTEXT_KEY_VERSION = 2;
const encoder = new TextEncoder();
/** Hex SHA-256 through the runtime's native digest. */
async function digest(text: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(text)),
  );
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}
type Node = Graph["nodes"][number];
/** Nodes by path, neighbours and content digests of one change's graphs. */
export class ContextMemo {
  private byPath = new Map<Graph, Map<string, Node[]>>();
  private adjacent = new Map<Graph, Map<string, Set<string>>>();
  private files = new Map<string, string>();
  private parts = new Map<string, string>();
  nodes(graph: Graph, path: string): Node[] {
    let index = this.byPath.get(graph);
    if (!index) {
      index = new Map();
      for (const n of graph.nodes) {
        const list = index.get(n.path);
        if (list) list.push(n);
        else index.set(n.path, [n]);
      }
      this.byPath.set(graph, index);
    }
    return index.get(path) ?? [];
  }
  /** The nodes and their direct neighbours, in graph order. */
  neighbourhood(graph: Graph, nodes: Node[]): Node[] {
    let index = this.adjacent.get(graph);
    if (!index) {
      index = new Map();
      const link = (a: string, b: string) => {
        const set = index!.get(a);
        if (set) set.add(b);
        else index!.set(a, new Set([b]));
      };
      for (const e of graph.edges) {
        link(e.from, e.to);
        link(e.to, e.from);
      }
      this.adjacent.set(graph, index);
    }
    const ids = new Set(nodes.map((n) => n.id));
    for (const n of nodes) for (const id of index.get(n.id) ?? []) ids.add(id);
    return graph.nodes.filter((n) => ids.has(n.id));
  }
  async file(
    version: "base" | "head",
    path: string,
    read: ContextInputs["read"],
  ): Promise<string> {
    const key = `${version}\0${path}`;
    if (!this.files.has(key)) {
      const text = await read(version, path);
      this.files.set(key, text === null ? "-" : await digest(text));
    }
    return this.files.get(key)!;
  }
  /** The key part of a symbol; a file's symbols are digested together on first use. */
  async part(
    version: "base" | "head",
    graph: Graph,
    node: Node,
    read: ContextInputs["read"],
  ): Promise<string> {
    const key = `${version}\0${node.id}`;
    if (!this.parts.has(key)) {
      const text = lines(await read(version, node.path));
      // Positions are part of the key: a moved symbol must not replay
      // hypotheses at its old lines.
      for (const n of this.nodes(graph, node.path))
        this.parts.set(
          `${version}\0${n.id}`,
          `${version}:${n.path}:${n.symbol_path}:${n.line_start}-${n.line_end}:${await digest(text.slice(n.line_start - 1, n.line_end).join("\n"))}`,
        );
    }
    return this.parts.get(key)!;
  }
}
/**
 * The context hash: agent, manifest version, prompt, model, options, the
 * content of the symbols enclosing the hunk and their one-hop neighbours in
 * both versions (the whole file where no symbol encloses it), and the owner
 * guidance in scope.
 */
export async function contextHash(
  h: Hunk,
  inputs: ContextInputs,
): Promise<string> {
  return (await context(h, inputs)).context_hash;
}
/**
 * A region whose content and position the context hash fixes: a symbol, or a
 * whole file where no symbol encloses the hunk. A replayed hypothesis is valid
 * only if every location it cites lies in such a region.
 */
export interface Region {
  path: string;
  // Absent for a whole file.
  line_start?: number;
  line_end?: number;
}
export async function context(
  h: Hunk,
  inputs: ContextInputs,
): Promise<{ context_hash: string; covered: Region[] }> {
  const parts: string[] = [];
  const covered: Region[] = [];
  const memo = inputs.memo ?? new ContextMemo();
  for (const version of ["base", "head"] as const) {
    const path = version === "base" ? h.old_path : h.path;
    const graph = inputs.graphs[version];
    const enclosing =
      version === "base" && !inputs.base_graph
        ? []
        : memo.nodes(graph, path).filter((n) => overlaps(n, h[version]));
    if (!enclosing.length) {
      parts.push(
        `${version}:${path}:file:${await memo.file(version, path, inputs.read)}`,
      );
      covered.push({ path });
      continue;
    }
    for (const n of memo.neighbourhood(graph, enclosing)) {
      parts.push(await memo.part(version, graph, n, inputs.read));
      covered.push({
        path: n.path,
        line_start: n.line_start,
        line_end: n.line_end,
      });
    }
  }
  const guidance = inputs.guidance
    .filter(
      (g) =>
        !g.scope_dir ||
        h.path === g.scope_dir ||
        h.path.startsWith(`${g.scope_dir}/`),
    )
    .map((g) => `${g.path}:${g.content_hash}`);
  return {
    context_hash: await digest(
      canonical({
        key: CONTEXT_KEY_VERSION,
        agent: inputs.agent,
        layout: {
          version: PROMPT_LAYOUT_VERSION,
          features: inputs.layout ?? [],
        },
        manifest_version: inputs.manifest_version,
        prompt: hash(inputs.prompt),
        model: inputs.model,
        options: inputs.options ?? {},
        engine: inputs.engine,
        symbols: parts.sort(),
        guidance: guidance.sort(),
      }),
    ),
    covered,
  };
}
const inside = (l: Hypothesis["location"], regions: Region[]) =>
  regions.some(
    (r) =>
      r.path === l.path &&
      (r.line_start === undefined ||
        (l.line_start >= r.line_start && l.line_end <= r.line_end!)),
  );

export interface Keyed {
  hunk: Hunk;
  hunk_hash: string;
  context_hash: string;
  covered?: Region[];
}
export interface CacheEntry {
  agent: string;
  hunk: { path: string; head: Hunk["head"] };
  hypotheses: Hypothesis[];
  // The agent run's tokens divided over its hunks.
  tokens: number;
  created_at: number;
}
export const objectKey = (tenant: string, k: Keyed) =>
  `cache/${tenant}/${k.hunk_hash}/${k.context_hash}.json`;

/** Hits by hunk index. Expired entries are removed and miss. */
export async function lookup(
  env: Env,
  tenant: string,
  keys: Keyed[],
  now = Date.now(),
): Promise<Record<number, CacheEntry>> {
  // Rows by hunk hash, a bounded batch per query (D1 binds at most 100).
  const rows = new Map<string, { object_key: string; created_at: number }>();
  const hunks = [...new Set(keys.map((k) => k.hunk_hash))];
  for (let i = 0; i < hunks.length; i += LOOKUP_BATCH) {
    const batch = hunks.slice(i, i + LOOKUP_BATCH);
    const found = await env.DB.prepare(
      `SELECT hunk_hash,context_hash,object_key,created_at FROM agent_cache WHERE tenant=? AND hunk_hash IN (${batch.map(() => "?").join(",")})`,
    )
      .bind(tenant, ...batch)
      .all<{
        hunk_hash: string;
        context_hash: string;
        object_key: string;
        created_at: number;
      }>();
    for (const r of found.results)
      rows.set(`${r.hunk_hash}\0${r.context_hash}`, r);
  }
  const hits: Record<number, CacheEntry> = {};
  const expired: (Keyed & { object_key: string })[] = [];
  const touched: Keyed[] = [];
  for (const [index, k] of keys.entries()) {
    const row = rows.get(`${k.hunk_hash}\0${k.context_hash}`);
    if (!row) continue;
    if (row.created_at < now - EVIDENCE_RETENTION_MS) {
      expired.push({ ...k, object_key: row.object_key });
      continue;
    }
    const object = await env.ARTIFACTS.get(row.object_key);
    if (!object) continue;
    hits[index] = await object.json<CacheEntry>();
    touched.push(k);
  }
  await remove(env, tenant, expired);
  for (let i = 0; i < touched.length; i += LOOKUP_BATCH)
    await env.DB.batch(
      touched
        .slice(i, i + LOOKUP_BATCH)
        .map((k) =>
          env.DB.prepare(
            "UPDATE agent_cache SET last_hit=? WHERE tenant=? AND hunk_hash=? AND context_hash=?",
          ).bind(now, tenant, k.hunk_hash, k.context_hash),
        ),
    );
  return hits;
}
/** Hunk hashes per lookup query and statements per D1 batch. */
const LOOKUP_BATCH = 90;

async function remove(
  env: Env,
  tenant: string,
  rows: { hunk_hash: string; context_hash: string; object_key: string }[],
) {
  for (const r of rows) {
    await env.ARTIFACTS.delete(r.object_key);
    await env.DB.prepare(
      "DELETE FROM agent_cache WHERE tenant=? AND hunk_hash=? AND context_hash=?",
    )
      .bind(tenant, r.hunk_hash, r.context_hash)
      .run();
  }
}

/** Removes up to `limit` of the tenant's entries older than the retention. */
export async function expire(
  env: Env,
  tenant: string,
  now = Date.now(),
  limit = 100,
) {
  const rows = await env.DB.prepare(
    "SELECT hunk_hash,context_hash,object_key FROM agent_cache WHERE tenant=? AND created_at<? ORDER BY created_at LIMIT ?",
  )
    .bind(tenant, now - EVIDENCE_RETENTION_MS, limit)
    .all<{ hunk_hash: string; context_hash: string; object_key: string }>();
  await remove(env, tenant, rows.results);
  return rows.results.length;
}

/**
 * Assigns each hypothesis, by primary location, to the hunk containing it or
 * else the nearest hunk of the same file; `-1` when no hunk is in its file.
 */
export function attribute(keys: Keyed[], h: Hypothesis): number {
  const { path, line_start, line_end } = h.location;
  let best = -1,
    distance = Infinity;
  for (const [i, k] of keys.entries()) {
    if (k.hunk.path !== path) continue;
    const start = k.hunk.head.start,
      end = start + Math.max(k.hunk.head.count, 1) - 1;
    const d =
      line_end < start
        ? start - line_end
        : line_start > end
          ? line_start - end
          : 0;
    if (d < distance) {
      best = i;
      distance = d;
    }
  }
  return best;
}
/**
 * The entries a completed run may write: for each missed hunk (index into
 * `keys`, which holds every hunk of the change, hits included) the hypotheses
 * attributed to it. Hypotheses attributed to a hit hunk are not stored. A hunk
 * whose hypotheses cite a location outside the regions its context fixes gets
 * no entry, and a hypothesis in no changed file means the run cannot be
 * replayed per hunk at all, so nothing is written.
 */
export function slice(
  keys: Keyed[],
  missed: number[],
  hypotheses: Hypothesis[],
): Map<number, Hypothesis[]> {
  const out = new Map(missed.map((i) => [i, [] as Hypothesis[]]));
  const unsafe = new Set<number>();
  for (const h of hypotheses) {
    const i = attribute(keys, h);
    if (i < 0) return new Map();
    const list = out.get(i);
    if (!list) continue;
    list.push(h);
    const regions = keys[i].covered;
    if (
      regions &&
      ![h.location, ...(h.locations ?? [])].every((l) => inside(l, regions))
    )
      unsafe.add(i);
  }
  for (const i of unsafe) out.delete(i);
  return out;
}

export async function store(
  env: Env,
  tenant: string,
  agent: string,
  keys: Keyed[],
  missed: number[],
  hypotheses: Hypothesis[],
  tokens: number,
  now = Date.now(),
) {
  const sliced = slice(keys, missed, hypotheses);
  const share = missed.length ? Math.floor(tokens / missed.length) : 0;
  // Each batch's rows follow its objects, so a row never names a missing
  // object and a failure leaves at most one batch of objects unindexed.
  const entries = [...sliced];
  for (let i = 0; i < entries.length; i += LOOKUP_BATCH) {
    const written: { k: Keyed; key: string }[] = [];
    for (const [index, list] of entries.slice(i, i + LOOKUP_BATCH)) {
      const k = keys[index];
      const key = objectKey(tenant, k);
      const entry: CacheEntry = {
        agent,
        hunk: { path: k.hunk.path, head: k.hunk.head },
        hypotheses: list.map((h) => ({ ...h, source: { agent } })),
        tokens: share,
        created_at: now,
      };
      await env.ARTIFACTS.put(key, JSON.stringify(entry), {
        httpMetadata: { contentType: "application/json" },
      });
      written.push({ k, key });
    }
    await env.DB.batch(
      written.map(({ k, key }) =>
        env.DB.prepare(
          "INSERT INTO agent_cache(tenant,hunk_hash,context_hash,object_key,created_at,last_hit) VALUES(?,?,?,?,?,NULL) ON CONFLICT(tenant,hunk_hash,context_hash) DO UPDATE SET object_key=excluded.object_key,created_at=excluded.created_at,last_hit=NULL",
        ).bind(tenant, k.hunk_hash, k.context_hash, key, now),
      ),
    );
  }
  return sliced.size;
}

/** Every changed hunk of the reviewed change, in path order. */
export async function changeHunks(
  changed: ChangedFile[],
  read: (version: "base" | "head", path: string) => Promise<string | null>,
): Promise<Hunk[]> {
  const hunks: Hunk[] = [];
  for (const f of [...changed].sort((a, b) => a.path.localeCompare(b.path))) {
    const old_path = f.old_path ?? f.path;
    hunks.push(
      ...diffHunks(
        f.path,
        old_path,
        await read("base", old_path),
        await read("head", f.path),
      ),
    );
  }
  return hunks;
}

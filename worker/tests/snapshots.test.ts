import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import type { Env, File, Snapshot } from "../src/types";
import { hash } from "../src/validation";
import { jobToken } from "../src/auth";
import { createJob, validateResult } from "../src/jobs";
import { Store } from "../src/storage";
import { jobInput } from "../src/archive";
import { SandboxRunner, stopped } from "../src/sandbox";
import { OUTPUT_LIMIT, Tools } from "../src/tools";
import {
  BATCH_BYTES,
  StoredSnapshot,
  changeTexts,
  entriesOf,
  fileOf,
  indexKey,
  lineCounts,
  scan,
  textOf,
  textsOf,
  type Entry,
  type Scanned,
} from "../src/snapshot";
import { MemorySnapshot } from "../src/snapshot";
import { Requests, SEARCH_REFUSED, metered } from "../src/requests";
import { seal, storeChunk, storePack } from "../src/upload";
import { allMigrations, graphs, snapshot } from "./fixtures";
import {
  chunked,
  hex,
  manifestOf,
  packBody,
  readJobInput,
  storeInterleaved,
  storeSnapshot,
  treeOf,
  uploadSnapshot,
} from "./snapshots";
const testEnv = env as Env;
const runtime = {
  ...testEnv,
  JOBS: { send: async () => {} },
} as unknown as Env;
const owner = {
  authorization: "Bearer test-owner-token-at-least-32-characters",
  "rio-protocol": "1",
};
const other = "another-tenant-token-at-least-32-chars";
const MiB = 1024 * 1024;
function request(
  path: string,
  method = "GET",
  body?: BodyInit,
  headers: Record<string, string> = owner,
) {
  return app.request(
    `https://rio.test${path}`,
    { method, headers, body },
    runtime,
  );
}
const json = (value: unknown) => JSON.stringify(value);
async function contentsOf(tenant: string): Promise<string[]> {
  return (
    await testEnv.DB.prepare(
      "SELECT hash FROM contents WHERE tenant=? ORDER BY hash",
    )
      .bind(tenant)
      .all<{ hash: string }>()
  ).results.map((r) => r.hash);
}
async function error(response: Response): Promise<string> {
  return ((await response.json()) as any).error;
}
/** Deterministic non-repeating filler, so every generated file is distinct. */
function filler(seed: number, size: number): Uint8Array {
  const line = new TextEncoder().encode(
    `// filler ${seed.toString().padStart(6, "0")} lorem ipsum dolor sit amet\n`,
  );
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += line.length)
    bytes.set(line.subarray(0, Math.min(line.length, size - i)), i);
  return bytes;
}
beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, allMigrations);
  await testEnv.DB.prepare(
    "INSERT INTO api_tokens(hash,tenant,scope,expires_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
  )
    .bind(hash(other), "other", "*", Date.now() + 3600000)
    .run();
});
beforeEach(async () => {
  await testEnv.DB.batch(
    ["contents", "snapshots", "jobs", "reviews"].map((t) =>
      testEnv.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
});

describe("content upload", () => {
  it("uploads each distinct content once and only new contents on a later review", async () => {
    const send = (path: string, method: string, body?: BodyInit) =>
      request(path, method, body);
    expect((await uploadSnapshot(send, snapshot)).status).toBe(201);
    const { contents } = manifestOf(snapshot);
    // AGENTS.md is identical in base and head: stored once.
    expect(await contentsOf("owner")).toEqual([...contents.keys()].sort());
    const next = structuredClone(snapshot);
    next.head["src/new.ts"] = { mode: 0o100644, content: "export {};\n" };
    const later = manifestOf(next);
    const missing = await request(
      "/v1/contents/missing",
      "POST",
      json({ hashes: [...later.contents.keys()] }),
    );
    expect(((await missing.json()) as any).missing).toEqual([
      hex(new TextEncoder().encode("export {};\n")),
    ]);
    // Identical snapshots re-seal as a no-op.
    expect((await uploadSnapshot(send, snapshot)).status).toBe(200);
  });
  it("rejects a tampered pack without storing any of its contents", async () => {
    const good = new TextEncoder().encode("good"),
      bad = new TextEncoder().encode("bad");
    const body = packBody([
      [hex(good), good],
      [hex(new TextEncoder().encode("bae")), bad],
    ]);
    const response = await request("/v1/packs", "PUT", body);
    expect(response.status).toBe(400);
    expect(await error(response)).toBe("pack content hash mismatch");
    expect(await contentsOf("owner")).toEqual([]);
    // Declared sizes must cover the body exactly.
    const short = packBody([[hex(good), good]]).subarray(0, -1);
    expect((await request("/v1/packs", "PUT", short)).status).toBe(400);
  });
  it("rejects a request body over 8 MiB", async () => {
    const big = new Uint8Array(8 * MiB + 1);
    const response = await request("/v1/packs", "PUT", big);
    expect(response.status).toBe(400);
    expect(await error(response)).toBe("request too large");
  });
  it("keeps tenants apart even for identical hashes", async () => {
    const { id, manifest, contents } = manifestOf(snapshot);
    await storeSnapshot(testEnv, snapshot, "owner");
    const asOther = { ...owner, authorization: `Bearer ${other}` };
    const missing = await request(
      "/v1/contents/missing",
      "POST",
      json({ hashes: [...contents.keys()] }),
      asOther,
    );
    expect(((await missing.json()) as any).missing).toEqual([
      ...contents.keys(),
    ]);
    await request(`/v1/manifests/${id}/chunks/0`, "PUT", manifest, asOther);
    const sealed = await request(
      `/v1/manifests/${id}/seal`,
      "POST",
      json({ chunks: 1 }),
      asOther,
    );
    expect(sealed.status).toBe(400);
    expect(await error(sealed)).toBe("manifest references missing content");
  });
  it("assembles a 20 MiB content from parts and verifies its hash", async () => {
    const bytes = filler(1, 20 * MiB),
      digest = hex(bytes);
    const start = await request(
      `/v1/contents/${digest}/uploads`,
      "POST",
      json({ size: bytes.length }),
    );
    expect(start.status).toBe(201);
    const { upload } = (await start.json()) as any;
    const parts = [];
    for (let part = 1; part <= 3; part++) {
      const response = await request(
        `/v1/contents/${digest}/uploads/${part}?upload=${encodeURIComponent(upload)}`,
        "PUT",
        bytes.subarray((part - 1) * 8 * MiB, part * 8 * MiB),
      );
      expect(response.status).toBe(200);
      parts.push(await response.json());
    }
    const done = await request(
      `/v1/contents/${digest}/uploads/complete?upload=${encodeURIComponent(upload)}`,
      "POST",
      json({ size: bytes.length, parts }),
    );
    expect(done.status).toBe(201);
    // A retried completion (response lost) succeeds without re-assembling.
    expect(
      (
        await request(
          `/v1/contents/${digest}/uploads/complete?upload=${encodeURIComponent(upload)}`,
          "POST",
          json({ size: bytes.length, parts }),
        )
      ).status,
    ).toBe(201);
    expect(await contentsOf("owner")).toEqual([digest]);
    expect(
      (
        await request(
          `/v1/contents/${digest}/uploads`,
          "POST",
          json({ size: bytes.length }),
        )
      ).status,
    ).toBe(200);
    // A content that does not match its declared hash is discarded.
    const wrong = "f".repeat(64);
    const again = (await (
      await request(`/v1/contents/${wrong}/uploads`, "POST", json({ size: 9 }))
    ).json()) as any;
    const part = (await (
      await request(
        `/v1/contents/${wrong}/uploads/1?upload=${encodeURIComponent(again.upload)}`,
        "PUT",
        new TextEncoder().encode("not wrong"),
      )
    ).json()) as any;
    const rejected = await request(
      `/v1/contents/${wrong}/uploads/complete?upload=${encodeURIComponent(again.upload)}`,
      "POST",
      json({ size: 9, parts: [part] }),
    );
    expect(rejected.status).toBe(400);
    expect(await contentsOf("owner")).toEqual([digest]);
  });
});

describe("manifests", () => {
  async function sealLines(
    lines: string[],
    options: { contents?: boolean } = {},
  ) {
    const text = new TextEncoder().encode(lines.join(""));
    const id = hex(text);
    const chunks = chunked(lines, 8 * MiB);
    for (const [n, chunk] of chunks.entries())
      await storeChunk(testEnv, "owner", id, n, chunk);
    void options;
    return request(
      `/v1/manifests/${id}/seal`,
      "POST",
      json({ chunks: chunks.length }),
    );
  }
  const line = (version: string, path: string, size = 1, mode = 33188) =>
    json({ version, path, hash: "a".repeat(64), mode, size }) + "\n";
  it("seals a valid manifest once and re-seals as a no-op", async () => {
    const { id, manifest } = manifestOf(snapshot);
    await storeSnapshot(testEnv, snapshot);
    await storeChunk(testEnv, "owner", id, 0, manifest);
    expect((await seal(testEnv, "owner", id, { chunks: 1 })).created).toBe(
      false,
    );
    expect(
      (
        await testEnv.DB.prepare(
          "SELECT object_key FROM snapshots",
        ).first<any>()
      ).object_key,
    ).toBe(indexKey("owner", id));
  });
  it("rejects a wrong id, missing content, unsafe paths, bad order and every limit", async () => {
    const { manifest, lines } = manifestOf(snapshot);
    const wrong = "b".repeat(64);
    await storePack(
      testEnv,
      "owner",
      packBody([...manifestOf(snapshot).contents]),
    );
    await storeChunk(testEnv, "owner", wrong, 0, manifest);
    const mismatch = await request(
      `/v1/manifests/${wrong}/seal`,
      "POST",
      json({ chunks: 1 }),
    );
    expect(await error(mismatch)).toBe("manifest id mismatch");
    expect(await error(await sealLines([line("head", "src/x.ts")]))).toBe(
      "manifest references missing content",
    );
    expect(await error(await sealLines([line("head", "../escape")]))).toBe(
      "invalid repository path",
    );
    expect(
      await error(await sealLines([line("head", "b"), line("head", "a")])),
    ).toBe("manifest is not sorted or has duplicates");
    expect(await error(await sealLines([lines[1], lines[1]]))).toBe(
      "manifest is not sorted or has duplicates",
    );
    // Non-canonical lines (key order, spacing) change the id and are refused.
    expect(
      await error(
        await sealLines([
          json({
            path: "a",
            version: "head",
            hash: "a".repeat(64),
            mode: 33188,
            size: 1,
          }) + "\n",
        ]),
      ),
    ).toBe("invalid manifest line");
    expect(
      await error(await sealLines([line("head", "big.bin", 64 * MiB + 1)])),
    ).toMatch(/^snapshot limit exceeded: file size .* for big\.bin/);
    const distinct = Array.from(
      { length: 17 },
      (_, i) =>
        json({
          version: "head",
          path: `f${String(i).padStart(2, "0")}`,
          hash: String(i).padStart(2, "0").repeat(32),
          mode: 33188,
          size: 64 * MiB,
        }) + "\n",
    );
    expect(await error(await sealLines(distinct))).toMatch(
      /^snapshot limit exceeded: more than 1073741824 bytes of distinct content/,
    );
    // Every path references a stored (empty) content, so only the limit fails.
    const empty = new Uint8Array();
    await storePack(testEnv, "owner", packBody([[hex(empty), empty]]));
    const many = Array.from(
      { length: 300001 },
      (_, i) =>
        json({
          version: "base",
          path: `p/${String(i).padStart(6, "0")}`,
          hash: hex(empty),
          mode: 33188,
          size: 0,
        }) + "\n",
    );
    expect(await error(await sealLines(many))).toMatch(
      /^snapshot limit exceeded: more than 300000 paths in base/,
    );
  }, 120000);
  it("seals an empty snapshot with no chunks", async () => {
    const id = hex(new Uint8Array());
    const response = await request(
      `/v1/manifests/${id}/seal`,
      "POST",
      json({ chunks: 0 }),
    );
    expect(response.status).toBe(201);
    const reader = await StoredSnapshot.open(testEnv, indexKey("owner", id));
    expect(await reader.head.stat("a")).toBeNull();
  });
  it("no longer accepts inline snapshots", async () => {
    expect(
      (await request("/v1/snapshots", "POST", json(snapshot))).status,
    ).toBe(404);
  });
});

// The full benchmark run ended three reviews at the platform's limit of
// storage requests: elasticsearch's 32,155 paths lie in 54 packs, a batch of
// neighbours in path order touched most of them, and one search of the tree
// cost 390 pack reads.
const spread: Record<string, string> = {};
for (let i = 0; i < 9000; i++) {
  const path = `mod${String(i % 60).padStart(2, "0")}/f${String(i).padStart(4, "0")}.ts`;
  spread[path] = `// ${path}\nexport const v${i} = ${i};\n`;
}
const SPREAD_PACKS = 12;
/** The environment with storage bodies arriving `size` bytes at a time. */
function trickled(source: Env, size: number): Env {
  const get = async (key: string, options?: R2GetOptions) => {
    const object = await source.ARTIFACTS.get(key, options);
    if (!object) return null;
    const bytes = new Uint8Array(await object.arrayBuffer());
    const text = () => new TextDecoder().decode(bytes);
    return {
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (let at = 0; at < bytes.length; at += size)
            controller.enqueue(bytes.subarray(at, at + size));
          controller.close();
        },
      }),
      arrayBuffer: async () => bytes.buffer,
      text: async () => text(),
      json: async () => JSON.parse(text()),
    };
  };
  const bucket = new Proxy(source.ARTIFACTS, {
    get: (target, key) =>
      key === "get" ? get : Reflect.get(target, key, target).bind(target),
  });
  return new Proxy(source, {
    get: (target, key) =>
      key === "ARTIFACTS" ? bucket : Reflect.get(target, key, target),
  });
}
describe("snapshot reader", () => {
  const many: Snapshot = { base: {}, head: {} };
  for (let i = 0; i < 700; i++)
    many.head[`dir/f${String(i).padStart(3, "0")}.txt`] = {
      mode: 0o100644,
      content: `file ${i}\n`,
    };
  many.head["bin/blob"] = {
    mode: 0o100644,
    content: "AP8A",
    encoding: "base64",
  };
  many.head["tool.sh"] = { mode: 0o100755, content: "#!/bin/sh\n" };
  many.head["link"] = { mode: 0o120000, content: "dir" };
  many.base["only-base.txt"] = { mode: 0o100644, content: "base\n" };
  it("reads entries across chunks and pages, binary and link entries, and missing paths", async () => {
    const stored = await storeSnapshot(testEnv, many, "owner", {
      pack: 2048,
      chunk: 16 * 1024,
    });
    expect(stored.chunks).toBeGreaterThan(2);
    const reader = await StoredSnapshot.open(testEnv, stored.key);
    for (const i of [0, 255, 256, 511, 699]) {
      const path = `dir/f${String(i).padStart(3, "0")}.txt`;
      const entry = (await reader.head.stat(path))!;
      expect(fileOf(entry, await reader.head.read(entry))).toEqual(
        many.head[path],
      );
    }
    const blob = (await reader.head.stat("bin/blob"))!;
    expect(fileOf(blob, await reader.head.read(blob))).toEqual(
      many.head["bin/blob"],
    );
    expect((await reader.head.stat("tool.sh"))!.mode).toBe(0o100755);
    expect((await reader.head.stat("link"))!.mode).toBe(0o120000);
    expect(await reader.head.stat("missing.txt")).toBeNull();
    expect(await reader.head.stat("only-base.txt")).toBeNull();
    expect(await reader.base.stat("only-base.txt")).not.toBeNull();
    const listed: string[] = [];
    for await (const e of reader.head.list()) listed.push(e.path);
    expect(listed).toEqual(Object.keys(many.head).sort());
    expect(await reader.links("head")).toEqual({ link: btoa("dir") });
  });
  it("scans in path order reading each small pack once", async () => {
    const stored = await storeSnapshot(testEnv, many, "owner", { pack: 2048 });
    expect(stored.packs).toBeGreaterThan(2);
    const reader = await StoredSnapshot.open(testEnv, stored.key);
    const visited: string[] = [];
    await scan(
      reader.head,
      (e) => e.mode !== 0o120000,
      async (e, bytes) => {
        visited.push(e.path);
        expect(fileOf(e, bytes!)).toEqual(many.head[e.path]);
      },
    );
    expect(visited).toEqual(
      Object.keys(many.head)
        .filter((p) => p !== "link")
        .sort(),
    );
    expect(new Set(reader.reads).size).toBe(reader.reads.length);
  });
  // The FreeCAD reviews ran out of Worker memory while voters searched a
  // 395 MiB tree: a batch was 32 MiB, a filter keeping two files of a pack read
  // the pack between them, and every concurrent scan held its own batch.
  const wide: Snapshot = { base: {}, head: {} };
  wide.head["a/first.ts"] = { mode: 0o100644, content: "export const a = 1;\n" };
  for (let i = 0; i < 12; i++)
    wide.head[`m/f${String(i).padStart(2, "0")}.txt`] = {
      mode: 0o100644,
      content: new TextDecoder().decode(filler(i, MiB)),
    };
  wide.head["z/last.ts"] = { mode: 0o100644, content: "export const z = 2;\n" };
  it("reads the kept files of a sparse scan and not the packs between them", async () => {
    const stored = await storeSnapshot(testEnv, wide, "owner");
    const reader = await StoredSnapshot.open(testEnv, stored.key);
    const visited: string[] = [];
    await scan(
      reader.head,
      (e) => e.path.endsWith(".ts"),
      async (e, bytes) => {
        visited.push(e.path);
        expect(fileOf(e, bytes!)).toEqual(wide.head[e.path]);
      },
    );
    expect(visited).toEqual(["a/first.ts", "z/last.ts"]);
    expect(reader.fetched.bytes).toBeLessThan(1024);
  });
  it("yields batches of a few MiB and holds one at a time across concurrent scans", async () => {
    const stored = await storeSnapshot(testEnv, wide, "owner");
    const reader = await StoredSnapshot.open(testEnv, stored.key);
    let live = 0,
      most = 0,
      largest = 0;
    const walk = async () => {
      const seen: string[] = [];
      for await (const batch of reader.head.batches(() => true)) {
        most = Math.max(most, ++live);
        largest = Math.max(
          largest,
          batch.reduce((n, [, bytes]) => n + (bytes?.length ?? 0), 0),
        );
        for (const [entry] of batch) seen.push(entry.path);
        // Other scans get their turn while this one works on its batch.
        await new Promise((resolve) => setTimeout(resolve, 5));
        live--;
      }
      return seen;
    };
    const walks = await Promise.all([walk(), walk(), walk(), walk()]);
    for (const seen of walks) expect(seen).toEqual(Object.keys(wide.head).sort());
    expect(most).toBe(1);
    expect(largest).toBeLessThanOrEqual(BATCH_BYTES + MiB);
  });
  it("releases its batch when a scan stops early or fails", async () => {
    const stored = await storeSnapshot(testEnv, wide, "owner");
    const reader = await StoredSnapshot.open(testEnv, stored.key);
    for await (const batch of reader.head.batches(() => true)) {
      expect(batch.length).toBeGreaterThan(0);
      break;
    }
    await expect(
      scan(
        reader.head,
        () => true,
        async () => {
          throw new Error("consumer failed");
        },
      ),
    ).rejects.toThrow("consumer failed");
    const started = Date.now();
    const seen: string[] = [];
    await scan(
      reader.head,
      (e) => e.path.endsWith(".ts"),
      async (e) => void seen.push(e.path),
    );
    expect(seen).toEqual(["a/first.ts", "z/last.ts"]);
    expect(Date.now() - started).toBeLessThan(10000);
  });
  const walked = async (batches: AsyncIterable<Scanned[]>) => {
    const seen = new Map<string, string>();
    for await (const batch of batches)
      for (const [entry, bytes] of batch)
        seen.set(entry.path, new TextDecoder().decode(bytes!));
    return seen;
  };
  it("sweeps a tree spread over many packs with a few reads of each pack", async () => {
    const stored = await storeInterleaved(testEnv, spread, SPREAD_PACKS, "spread");
    const inOrder = await StoredSnapshot.open(testEnv, stored.key);
    const ordered = await walked(inOrder.head.batches(() => true));
    const requests = new Requests();
    const reader = await StoredSnapshot.open(
      metered(testEnv, requests),
      stored.key,
    );
    const opened = requests.used;
    const swept = await walked(reader.head.sweep(() => true));
    // The same files with the same bytes, whatever the order.
    expect(swept.size).toBe(9000);
    expect([...swept].sort()).toEqual([...ordered].sort());
    expect(Object.fromEntries(swept)).toEqual(spread);
    // Two windows, each reading a pack once; path order reads every pack for
    // every batch of 1,024 neighbours.
    expect(reader.reads.length).toBeLessThanOrEqual(2 * SPREAD_PACKS);
    expect(inOrder.reads.length).toBeGreaterThanOrEqual(9 * SPREAD_PACKS);
    // All of it, the manifest included, is counted against the review.
    expect(requests.used - opened).toBeGreaterThanOrEqual(reader.reads.length);
    expect(requests.used - opened).toBeLessThan(3 * SPREAD_PACKS);
  });
  it("sweeps only what is kept and asks again before each read", async () => {
    const stored = await storeSnapshot(testEnv, wide, "owner");
    expect(stored.packs).toBe(2);
    const sparse = await StoredSnapshot.open(testEnv, stored.key);
    expect(
      [...(await walked(sparse.head.sweep((e) => e.path.endsWith(".ts")))).keys()],
    ).toEqual(["a/first.ts", "z/last.ts"]);
    expect(sparse.fetched.bytes).toBeLessThan(1024);
    // A consumer that has enough narrows what it keeps: the pack it no longer
    // needs is not read.
    const reader = await StoredSnapshot.open(testEnv, stored.key);
    let enough = false;
    const seen: string[] = [];
    for await (const batch of reader.head.sweep(() => !enough)) {
      for (const [entry] of batch) seen.push(entry.path);
      enough = true;
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.length).toBeLessThan(Object.keys(wide.head).length);
    expect(reader.reads.length).toBe(1);
    expect(reader.fetched.bytes).toBeLessThan(8 * MiB);
  });
  it("holds one sweep batch at a time and releases it when a sweep stops early", async () => {
    const stored = await storeSnapshot(testEnv, wide, "owner");
    const reader = await StoredSnapshot.open(testEnv, stored.key);
    let live = 0,
      most = 0,
      largest = 0;
    const walk = async () => {
      const seen: string[] = [];
      for await (const batch of reader.head.sweep(() => true)) {
        most = Math.max(most, ++live);
        largest = Math.max(
          largest,
          batch.reduce((n, [, bytes]) => n + (bytes?.length ?? 0), 0),
        );
        for (const [entry] of batch) seen.push(entry.path);
        await new Promise((resolve) => setTimeout(resolve, 5));
        live--;
      }
      return seen.sort();
    };
    for (const seen of await Promise.all([walk(), walk(), walk()]))
      expect(seen).toEqual(Object.keys(wide.head).sort());
    expect(most).toBe(1);
    expect(largest).toBeLessThanOrEqual(2 * BATCH_BYTES);
    for await (const batch of reader.head.sweep(() => true)) {
      expect(batch.length).toBeGreaterThan(0);
      break;
    }
    const started = Date.now();
    expect((await walk()).length).toBe(Object.keys(wide.head).length);
    expect(Date.now() - started).toBeLessThan(10000);
  });
  it("finds the entries of many paths with one pass over the manifest", async () => {
    const stored = await storeSnapshot(testEnv, many, "owner", {
      pack: 2048,
      chunk: 16 * 1024,
    });
    const paths = [
      ...Object.keys(many.head).filter((p, i) => i % 3 === 0 && p !== "link"),
      "link",
      "missing.txt",
      "zzz/after-the-last.txt",
    ];
    const one = await StoredSnapshot.open(testEnv, stored.key);
    const expected = new Map<string, Entry>();
    for (const path of paths) {
      const entry = await one.head.stat(path);
      if (entry) expected.set(path, entry);
    }
    // Requests each costs: the manifest's chunks once, or a page per path.
    for (const [asked, cost] of [
      [paths, stored.chunks],
      [paths.slice(0, 20), 1],
      [[], 0],
      [["missing.txt"], 1],
    ] as [string[], number][]) {
      const requests = new Requests();
      const reader = await StoredSnapshot.open(
        metered(testEnv, requests),
        stored.key,
      );
      const opened = requests.used;
      const found = await entriesOf(reader.head, asked);
      expect([...found.keys()].sort()).toEqual(
        asked.filter((p) => expected.has(p)).sort(),
      );
      for (const [path, entry] of found) expect(entry).toEqual(expected.get(path));
      expect(requests.used - opened, `${asked.length} paths`).toBeLessThanOrEqual(
        cost,
      );
    }
    // And their texts: a few reads per pack, every request counted.
    const requests = new Requests();
    const reader = await StoredSnapshot.open(
      metered(testEnv, requests),
      stored.key,
    );
    const texts = await textsOf(reader.head, paths);
    for (const path of paths)
      expect(texts.get(path)).toBe(await textOf(one.head, path));
    expect(requests.used).toBeLessThanOrEqual(
      1 + stored.chunks + reader.reads.length,
    );
    expect(reader.reads.length).toBeLessThanOrEqual(stored.packs);
  });
  it("reads many texts in batches with the results of one read per path", async () => {
    const stored = await storeSnapshot(testEnv, many, "owner", { pack: 2048 });
    const reader = await StoredSnapshot.open(testEnv, stored.key);
    const paths = [
      ...Object.keys(many.head).filter((_, i) => i % 3 === 0),
      "bin/blob",
      "link",
      "missing.txt",
    ];
    const texts = await textsOf(reader.head, paths);
    // One read per pack run, not one per file.
    expect(reader.reads.length).toBeLessThan(paths.length / 2);
    expect([...texts.keys()].sort()).toEqual([...new Set(paths)].sort());
    for (const path of paths)
      expect(texts.get(path)).toBe(await textOf(reader.head, path));
    expect(texts.get("dir/f000.txt")).toBe("file 0\n");
    expect(texts.get("bin/blob")).toBeNull();
    expect(texts.get("link")).toBeNull();
    expect(texts.get("missing.txt")).toBeNull();
  });
  // The full run's submission of a tree of 120,008 files timed out at the
  // client: counting the lines of the 1,200 files its graphs named took
  // hundreds of storage reads of about 200 ms each, once for each version.
  const expected = (tree: Record<string, File>, paths: Iterable<string>) =>
    new Map(
      [...paths]
        .filter((path) => tree[path] && tree[path].mode !== 0o120000)
        .map((path) => [
          path,
          MemorySnapshot.bytes(tree[path]).filter((byte) => byte === 10)
            .length + 1,
        ]),
    );
  const sorted = (counts: Map<string, number>) => [...counts].sort();
  it("counts the lines of both versions' files in one pass, each pack read once", async () => {
    const change: Snapshot = { base: {}, head: {} };
    for (let i = 0; i < 600; i++) {
      const path = `pkg${i % 20}/f${String(i).padStart(3, "0")}.go`;
      const content =
        Array.from({ length: i % 37 }, (_, n) => `line ${n} of ${i}`).join(
          "\n",
        ) + (i % 3 ? "\n" : "");
      change.base[path] = { mode: 0o100644, content };
      // A change touches a few files; the rest is the same content twice.
      change.head[path] =
        i % 10 === 0
          ? { mode: 0o100644, content: `${content}changed ${i}\nand more` }
          : change.base[path];
    }
    change.base["only-base.go"] = { mode: 0o100644, content: "package base\n" };
    change.head["empty.go"] = { mode: 0o100644, content: "" };
    change.head["link"] = { mode: 0o120000, content: "pkg0" };
    change.head["bin/blob"] = {
      mode: 0o100644,
      content: btoa("\u00ff\n\u0000\n\u00fe"),
      encoding: "base64",
    };
    const stored = await storeSnapshot(testEnv, change, "owner", {
      pack: 4096,
      chunk: 16 * 1024,
    });
    expect(stored.packs).toBeGreaterThan(20);
    const wanted = {
      base: new Set([
        ...Object.keys(change.base).filter((_, i) => i % 2 === 0),
        "only-base.go",
      ]),
      head: new Set([
        ...Object.keys(change.head).filter((_, i) => i % 2 === 0),
        ...["empty.go", "link", "bin/blob", "missing.go"],
      ]),
    };
    // Bodies arrive a few bytes at a time: a piece ends anywhere in a file.
    for (const size of [7, 1 << 20]) {
      const requests = new Requests();
      const reader = await StoredSnapshot.open(
        metered(trickled(testEnv, size), requests),
        stored.key,
      );
      const opened = requests.used;
      const counts = await lineCounts(reader, wanted);
      for (const version of ["base", "head"] as const)
        expect(sorted(counts[version])).toEqual(
          sorted(expected(change[version], wanted[version])),
        );
      expect(counts.head.get("empty.go")).toBe(1);
      expect(counts.head.get("bin/blob")).toBe(3);
      expect(counts.head.has("link")).toBe(false);
      // No pack is read twice, whichever versions name its files, and the
      // manifest is passed once for each version.
      expect(new Set(reader.reads).size).toBe(reader.reads.length);
      expect(reader.reads.length).toBeLessThanOrEqual(stored.packs);
      expect(requests.used - opened).toBeLessThanOrEqual(
        2 * stored.chunks + stored.packs,
      );
    }
  });
  it("counts lines over a tree spread over many packs with one read of each", async () => {
    const stored = await storeInterleaved(testEnv, spread, SPREAD_PACKS, "counted");
    const requests = new Requests();
    const reader = await StoredSnapshot.open(
      metered(testEnv, requests),
      stored.key,
    );
    const opened = requests.used;
    const paths = Object.keys(spread).filter((_, i) => i % 7 === 0);
    const counts = await lineCounts(reader, {
      base: new Set(),
      head: new Set(paths),
    });
    expect(counts.base.size).toBe(0);
    expect(sorted(counts.head)).toEqual(paths.map((path) => [path, 3]).sort());
    // A sweep of the same files reads each pack once per window of paths.
    expect(reader.reads.length).toBeLessThanOrEqual(SPREAD_PACKS);
    expect(requests.used - opened).toBeLessThanOrEqual(1 + SPREAD_PACKS);
  });
  it("refuses a content that storage returns short", async () => {
    const stored = await storeSnapshot(testEnv, many, "owner", { pack: 2048 });
    const reader = await StoredSnapshot.open(testEnv, stored.key);
    const entry = (await reader.head.stat("dir/f000.txt"))!;
    const seen: number[] = [];
    await expect(
      reader.pour(
        { base: [], head: [{ ...entry, size: 1 << 20 }] },
        (_, __, piece) => void seen.push(piece.length),
      ),
    ).rejects.toThrow("snapshot content missing");
    expect(seen.reduce((n, length) => n + length, 0)).toBeLessThan(1 << 20);
  });
  it("starts no further read once storage refuses one", async () => {
    const stored = await storeInterleaved(testEnv, spread, SPREAD_PACKS, "refused");
    // Storage fails the first content read it is asked for.
    let failing = false,
      asked = 0;
    const get = async (key: string, options?: R2GetOptions) => {
      if (failing && options?.range && ++asked === 1)
        throw new Error("storage is down");
      return testEnv.ARTIFACTS.get(key, options);
    };
    const bucket = new Proxy(testEnv.ARTIFACTS, {
      get: (target, key) =>
        key === "get" ? get : Reflect.get(target, key, target).bind(target),
    });
    const reader = await StoredSnapshot.open(
      new Proxy(testEnv, {
        get: (target, key) =>
          key === "ARTIFACTS" ? bucket : Reflect.get(target, key, target),
      }),
      stored.key,
    );
    const entries = [
      ...(await entriesOf(reader.head, Object.keys(spread))).values(),
    ];
    // More runs than are read at a time.
    expect(new Set(entries.map((e) => e.pack)).size).toBe(SPREAD_PACKS);
    failing = true;
    reader.reads.length = 0;
    await expect(
      reader.pour({ base: [], head: entries }, () => {}),
    ).rejects.toThrow("storage is down");
    // The reads in flight end with their run; none of them takes another.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(reader.reads.length).toBeLessThanOrEqual(6);
    expect(asked).toBe(reader.reads.length);
  });
  it("reads or leaves out together the records of a change that share a path", async () => {
    const text = (size: number, of: string) => of.repeat(size);
    const file = (content: string): File => ({ mode: 0o100644, content });
    // `a.ts` became `b.ts`, and a new, small `a.ts` took its name.
    const memory = new MemorySnapshot({
      base: { "a.ts": file(text(600, "a")), "c.ts": file(text(10, "c")) },
      head: {
        "b.ts": file(text(600, "a")),
        "a.ts": file(text(50, "n")),
        "c.ts": file(text(20, "c")),
      },
    });
    const changed = [
      { path: "b.ts", old_path: "a.ts" },
      { path: "a.ts" },
      { path: "c.ts" },
    ];
    // The rename is over the budget. The replacement fits, but reading the
    // old `a.ts` for it would show the rename as a file deleted.
    expect(await changeTexts(memory, changed, 1000)).toEqual({
      base: { "a.ts": null, "c.ts": text(10, "c") },
      head: { "a.ts": null, "b.ts": null, "c.ts": text(20, "c") },
      omitted: { files: 2, bytes: 1200 + 650 },
    });
    // Within the budget every record is read.
    expect(await changeTexts(memory, changed, 2000)).toEqual({
      base: { "a.ts": text(600, "a"), "c.ts": text(10, "c") },
      head: {
        "a.ts": text(50, "n"),
        "b.ts": text(600, "a"),
        "c.ts": text(20, "c"),
      },
      omitted: { files: 0, bytes: 0 },
    });
  });
});

describe("searches of a stored snapshot", () => {
  // What search returned when it read the tree in path order and stopped at
  // the output limit: the first matching lines by path, then by line.
  const reference = (
    files: Record<string, string>,
    pattern: string,
    within = "",
  ) => {
    const results: { path: string; line: number; text: string }[] = [];
    let size = 0;
    for (const path of Object.keys(files).sort())
      if (path.startsWith(within))
        for (const [i, text] of files[path].split("\n").entries())
          if (text.includes(pattern)) {
            const item = { path, line: i + 1, text };
            size += JSON.stringify(item).length;
            if (size > OUTPUT_LIMIT) return { results, truncated: true };
            results.push(item);
          }
    return { results, truncated: false };
  };
  const files: Record<string, string> = {
    ...spread,
    "aaa/first.ts": "const marker = 'first';\n",
    // Alone it fills an answer.
    "big/long.ts": Array.from(
      { length: 3000 },
      (_, i) => `const marker${i} = ${i};\n`,
    ).join(""),
    "zzz/last.ts": "const marker = 'last';\n",
  };
  const open = async (requests?: Requests) => {
    const stored = await storeInterleaved(testEnv, files, SPREAD_PACKS, "found");
    const reader = await StoredSnapshot.open(
      requests ? metered(testEnv, requests) : testEnv,
      stored.key,
    );
    return { reader, tools: new Tools(reader, graphs, undefined) };
  };
  const CASES: [string, { pattern: string; scope?: string }, string?][] = [
    ["one line of one file", { pattern: "v4321 " }],
    // More matching files than an answer holds, in every pack and window.
    ["a line of every file", { pattern: "export const" }],
    ["a scope", { pattern: "export", scope: "mod07/**" }, "mod07/"],
    ["a file that fills the answer", { pattern: "marker" }],
    ["the last paths", { pattern: "'last'" }],
    ["nothing", { pattern: "absent-from-every-file" }],
  ];
  it("answers as a search in path order did, from a tree read in storage order", async () => {
    const { tools } = await open();
    for (const [name, args, within] of CASES) {
      const found = await tools.dispatch("search", args);
      const expected = reference(files, args.pattern, within);
      expect(found.results, name).toEqual(expected.results);
      expect(found.truncated, name).toBe(expected.truncated);
      expect(found.version).toBe("head");
      expect(found.scope).toBe(args.scope);
    }
    expect(reference(files, "export const").truncated).toBe(true);
    expect(reference(files, "marker").results[0].path).toBe("aaa/first.ts");
    expect(reference(files, "marker").truncated).toBe(true);
    // The notes and refusals of a search stay as they were.
    expect(
      (await tools.dispatch("search", { pattern: "v\\d+ =" })).note,
    ).toContain("literal text");
    await expect(
      tools.dispatch("search", { pattern: "export", scope: "nowhere/**" }),
    ).rejects.toThrow("matches no file in the head snapshot");
    expect(
      (await tools.dispatch("search", { pattern: "export", version: "base" }))
        .results,
    ).toEqual([]);
  });
  it("answers the searches asked together with one pass, and a repeated search from memory", async () => {
    const requests = new Requests();
    const { reader, tools } = await open(requests);
    const opened = requests.used;
    const together = await Promise.allSettled([
      ...CASES.map(([, args]) => tools.dispatch("search", args)),
      tools.dispatch("search", { pattern: "export", scope: "nowhere/**" }),
    ]);
    for (const [i, [name, args, within]] of CASES.entries()) {
      const found = together[i];
      expect(found.status, name).toBe("fulfilled");
      const expected = reference(files, args.pattern, within);
      expect((found as any).value.results, name).toEqual(expected.results);
      expect((found as any).value.truncated, name).toBe(expected.truncated);
    }
    // A search that fails does so alone.
    expect(together.at(-1)).toMatchObject({ status: "rejected" });
    expect(requests.counts).toMatchObject({
      scans: 1,
      searches: CASES.length + 1,
      remembered: 0,
      refused: 0,
    });
    // One pass: a few reads of each pack, where every search alone read each
    // pack for every batch of neighbours.
    const pass = requests.used - opened;
    expect(reader.reads.length).toBeLessThanOrEqual(2 * SPREAD_PACKS + 2);
    expect(pass).toBeLessThan(3 * SPREAD_PACKS);
    // Asked again, by any agent of the review: no storage request.
    const again = await new Tools(reader, graphs, undefined).dispatch(
      "search",
      CASES[1][1],
    );
    expect(again).toEqual((together[1] as any).value);
    expect(requests.used - opened).toBe(pass);
    expect(requests.counts).toMatchObject({ scans: 1, remembered: 1 });
    // An answer is the asker's own: changing it changes no one else's.
    again.results.length = 0;
    expect(
      (await tools.dispatch("search", CASES[1][1])).results.length,
    ).toBeGreaterThan(100);
    // A failure is not remembered, and neither is another version's answer.
    await expect(
      tools.dispatch("search", { pattern: "export", scope: "nowhere/**" }),
    ).rejects.toThrow("matches no file");
    await tools.dispatch("search", { ...CASES[0][1], version: "base" });
    expect(requests.counts).toMatchObject({ scans: 3, remembered: 2 });
  });
  it("answers a search asked during a pass with the next pass", async () => {
    const requests = new Requests();
    const { tools } = await open(requests);
    const first = tools.dispatch("search", CASES[0][1]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const later = [CASES[2], CASES[4]].map(([, args]) =>
      tools.dispatch("search", args),
    );
    expect((await first).results).toEqual(
      reference(files, CASES[0][1].pattern).results,
    );
    expect((await later[0]).results).toEqual(
      reference(files, "export", "mod07/").results,
    );
    expect((await later[1]).results).toEqual(
      reference(files, "'last'").results,
    );
    expect(requests.counts).toMatchObject({ scans: 2, searches: 3 });
  });
  it("refuses to read the tree once the review has spent its share of requests on searching", async () => {
    const requests = new Requests(1000);
    const { reader, tools } = await open(requests);
    const known = await tools.dispatch("search", CASES[0][1]);
    requests.count(600 - requests.used);
    expect(requests.searchable).toBe(false);
    const used = requests.used,
      reads = reader.reads.length;
    const refused = await Promise.allSettled([
      tools.dispatch("search", CASES[1][1]),
      tools.dispatch("search", CASES[2][1]),
    ]);
    for (const r of refused)
      expect(r).toMatchObject({
        status: "rejected",
        reason: { message: SEARCH_REFUSED },
      });
    // Told so, counted, and no storage request made.
    expect(requests.counts).toMatchObject({ scans: 1, refused: 2 });
    expect(requests.used).toBe(used);
    expect(reader.reads.length).toBe(reads);
    // What is known is still answered, and known paths are still read.
    expect(await tools.dispatch("search", CASES[0][1])).toEqual(known);
    expect(
      await tools.dispatch("read_file", {
        path: "aaa/first.ts",
        version: "head",
      }),
    ).toBe("1: const marker = 'first';\n2: ");
  });
  it("does not remember a refusal", async () => {
    const requests = new Requests();
    const { tools } = await open(requests);
    const full = vi.spyOn(requests, "searchable", "get").mockReturnValue(false);
    await expect(tools.dispatch("search", CASES[4][1])).rejects.toThrow(
      SEARCH_REFUSED,
    );
    full.mockRestore();
    expect((await tools.dispatch("search", CASES[4][1])).results).toEqual(
      reference(files, "'last'").results,
    );
    expect(requests.counts).toMatchObject({ scans: 1, refused: 1 });
  });
});

describe("tools on a large snapshot", () => {
  it("returns the same read_file and search results on a 150 MiB snapshot as on a small one", async () => {
    const target: File = {
      mode: 0o100644,
      content: "export function needle() {\n  return 'haystack-needle';\n}\n",
    };
    const small: Snapshot = { base: {}, head: { "src/needle.ts": target } };
    // Build the large snapshot pack by pack so the test never holds it whole.
    // Upload verification is tested above; here packs are written directly with
    // synthetic content ids, because hashing 170 MiB in JavaScript is slow.
    const lines: string[] = [];
    let serial = 0;
    const put = async (files: [string, Uint8Array][]) => {
      const pack = `packs/test-${serial}`,
        rows: any[] = [];
      let offset = 0;
      for (const [path, bytes] of files) {
        const hash = (serial++).toString(16).padStart(64, "0");
        rows.push({ h: hash, o: offset, s: bytes.length });
        lines.push(
          json({
            version: "head",
            path,
            hash,
            mode: 33188,
            size: bytes.length,
          }) + "\n",
        );
        offset += bytes.length;
      }
      const body = new Uint8Array(offset);
      offset = 0;
      for (const [, bytes] of files) {
        body.set(bytes, offset);
        offset += bytes.length;
      }
      await testEnv.ARTIFACTS.put(`snapshots/owner/${pack}`, body);
      await testEnv.DB.prepare(
        "INSERT INTO contents(tenant,hash,pack,offset,size,created_at) SELECT 'owner',json_extract(value,'$.h'),?,json_extract(value,'$.o'),json_extract(value,'$.s'),0 FROM json_each(?)",
      )
        .bind(pack, JSON.stringify(rows))
        .run();
    };
    for (let pack = 0; pack < 21; pack++)
      await put(
        Array.from({ length: 7 }, (_, i): [string, Uint8Array] => [
          `gen/f${String(pack * 7 + i).padStart(3, "0")}.txt`,
          filler(pack * 7 + i, MiB),
        ]),
      );
    await put([["src/needle.ts", new TextEncoder().encode(target.content)]]);
    // A 20 MiB file is stored alone and streamed, never read whole.
    const huge = filler(999, 20 * MiB);
    const width = huge.indexOf(10) + 1;
    huge.set(
      new TextEncoder().encode("haystack-needle in a huge file\n"),
      10 * MiB - ((10 * MiB) % width),
    );
    await put([["zz/huge.txt", huge]]);
    lines.sort();
    const manifest = new TextEncoder().encode(lines.join(""));
    const id = hex(manifest);
    await storeChunk(testEnv, "owner", id, 0, manifest);
    await seal(testEnv, "owner", id, { chunks: 1 });
    const reader = await StoredSnapshot.open(testEnv, indexKey("owner", id));
    expect(reader.index.trees.head.bytes).toBeGreaterThan(150 * MiB);
    const large = new Tools(reader, graphs, undefined),
      tiny = new Tools(small, graphs, undefined);
    const read = { path: "src/needle.ts", version: "head" };
    expect(await large.dispatch("read_file", read)).toEqual(
      await tiny.dispatch("read_file", read),
    );
    const scoped = {
      version: "head",
      pattern: "haystack-needle",
      scope: "src/**",
    };
    expect(await large.dispatch("search", scoped)).toEqual(
      await tiny.dispatch("search", scoped),
    );
    const everywhere = await large.dispatch("search", {
      version: "head",
      pattern: "haystack-needle",
    });
    expect(everywhere.results.map((r: any) => r.path)).toEqual([
      "src/needle.ts",
      "zz/huge.txt",
    ]);
    const at = everywhere.results[1].line;
    expect(
      await large.dispatch("read_file", {
        path: "zz/huge.txt",
        version: "head",
        line_start: at,
        line_end: at,
      }),
    ).toBe(`${at}: haystack-needle in a huge file`);
    // A frequent pattern stops at the output limit.
    const common = await large.dispatch("search", {
      version: "head",
      pattern: "lorem",
    });
    expect(common.truncated).toBe(true);
    expect(
      common.results.reduce(
        (n: number, r: any) => n + JSON.stringify(r).length,
        0,
      ),
    ).toBeLessThanOrEqual(24000);
    // Searches asked together share the pass, and the one stream of the huge
    // file that two of them want.
    const shared = await StoredSnapshot.open(testEnv, indexKey("owner", id));
    const together = await Promise.all(
      ["haystack-needle", "in a huge file", "lorem"].map((pattern) =>
        new Tools(shared, graphs, undefined).dispatch("search", {
          version: "head",
          pattern,
        }),
      ),
    );
    expect(together[0]).toEqual(everywhere);
    expect(together[1].results).toEqual([everywhere.results[1]]);
    expect(together[2]).toEqual(common);
    expect(shared.reads.length).toBeLessThanOrEqual(reader.reads.length);
  }, 300000);
});

describe("runner archives", () => {
  const files: Snapshot = {
    base: {
      "src/a.ts": { mode: 0o100644, content: "base\n" },
      "run.sh": { mode: 0o100755, content: "#!/bin/sh\necho base\n" },
    },
    head: {
      "src/a.ts": { mode: 0o100644, content: "head\n" },
      "run.sh": { mode: 0o100755, content: "#!/bin/sh\necho head\n" },
      [`deep/${"ü".repeat(60)}/${"x".repeat(80)}.txt`]: {
        mode: 0o100644,
        content: "long non-ASCII name\n",
      },
      "img.bin": { mode: 0o100644, content: "AAEC/w==", encoding: "base64" },
      link: { mode: 0o120000, content: "src" },
    },
  };
  async function review(tenant = "owner") {
    const stored = await storeSnapshot(testEnv, files, tenant);
    const id = crypto.randomUUID();
    await testEnv.DB.prepare(
      "INSERT INTO reviews(id,tenant,submission_key,status,created_at,token_limit,deadline) VALUES(?,?,?,'running',?,?,?)",
    )
      .bind(id, tenant, "unused", Date.now(), 100000, Date.now() + 600000)
      .run();
    return { id, snapshot: stored.id };
  }
  async function payload(review: string, job: string) {
    const row = await testEnv.DB.prepare(
      "SELECT payload_key FROM jobs WHERE id=? AND review_id=?",
    )
      .bind(job, review)
      .first<{ payload_key: string }>();
    return new Store(runtime).get<any>(row!.payload_key);
  }
  it("streams both trees byte for byte and mode for mode, without contents in the payload", async () => {
    const { id, snapshot: snapshotId } = await review();
    await createJob(
      runtime,
      id,
      "checks",
      "checks",
      ["rio-internal"],
      "head",
      snapshotId,
      1,
      {
        profile: {} as any,
      },
    );
    const job = await payload(id, "checks");
    expect(job.needs).toEqual(["base", "head"]);
    expect(Object.keys(job).sort()).toEqual(
      [
        "attempt",
        "command",
        "context",
        "job_id",
        "kind",
        "limits",
        "needs",
        "network",
        "protocol",
        "review_id",
        "snapshot_id",
        "version",
      ].sort(),
    );
    expect(JSON.stringify(job)).not.toContain("echo head");
    const input = await readJobInput(await jobInput(runtime, job));
    expect(input.header).toEqual({
      ...job,
      links: { base: {}, head: { link: btoa("src") } },
    });
    for (const version of ["base", "head"] as const) {
      const expected = Object.entries(files[version]).filter(
        ([, f]) => f.mode !== 0o120000,
      );
      expect(Object.keys(treeOf(input.files, version)).sort()).toEqual(
        expected.map(([p]) => p).sort(),
      );
      for (const [path, file] of expected) {
        const member = input.files[`${version}/${path}`];
        expect(fileOf({ mode: file.mode } as any, member.bytes)).toEqual(file);
        expect(member.mode).toBe(file.mode === 0o100755 ? 0o755 : 0o644);
      }
    }
    // Fixed-width tar name fields stay printable ASCII; strict readers (Python's
    // tarfile) decode them even when a PAX header carries the real name.
    const raw = new Uint8Array(
      await new Response(await jobInput(runtime, job)).arrayBuffer(),
    );
    let offset = raw.indexOf(10) + 1;
    while (offset + 512 <= raw.length && raw[offset] !== 0) {
      const field = raw.subarray(offset, offset + 100);
      expect(field.every((b) => b === 0 || (b >= 0x20 && b < 0x7f))).toBe(true);
      const size = parseInt(
        new TextDecoder().decode(raw.subarray(offset + 124, offset + 135)),
        8,
      );
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    // A run job receives only its own tree.
    await createJob(runtime, id, "run", "run", ["true"], "base", snapshotId);
    const run = await readJobInput(
      await jobInput(runtime, await payload(id, "run")),
    );
    expect(Object.keys(run.files).every((n) => n.startsWith("base/"))).toBe(
      true,
    );
  });
  it("sends what both trees share once, in a few chunks, and reports what it read", async () => {
    // A repository of many files and a change of a few, as a review has.
    const common: Snapshot["head"] = {};
    for (let i = 0; i < 700; i++)
      common[`pkg/m${i % 40}/${"n".repeat(40)}${i}.ts`] = {
        mode: 0o100644,
        content: `export const v${i} = ${i};\n`.repeat(20),
      };
    common[`deep/${"ü".repeat(60)}/${"x".repeat(80)}.txt`] = {
      mode: 0o100644,
      content: "long non-ASCII name\n",
    };
    common["empty"] = { mode: 0o100644, content: "" };
    // A file of several chunks, which a batch read gives as one array.
    common["data/table.csv"] = {
      mode: 0o100644,
      content: "0123456789abcde\n".repeat(160 * 1024),
    };
    const tree: Snapshot = {
      base: {
        ...common,
        "changed.ts": { mode: 0o100644, content: "old\n" },
        "removed.ts": { mode: 0o100644, content: "removed\n" },
        "mode.sh": { mode: 0o100644, content: "#!/bin/sh\n" },
        "was-link": { mode: 0o120000, content: "pkg" },
        "now-link": { mode: 0o100644, content: "a file\n" },
        // First and last in path order, with no counterpart.
        "!first": { mode: 0o100644, content: "first\n" },
        "~last": { mode: 0o100644, content: "last\n" },
      },
      head: {
        ...common,
        "changed.ts": { mode: 0o100644, content: "new\n" },
        "added.ts": { mode: 0o100644, content: "added\n" },
        "mode.sh": { mode: 0o100755, content: "#!/bin/sh\n" },
        "was-link": { mode: 0o100644, content: "a file\n" },
        "now-link": { mode: 0o120000, content: "pkg" },
      },
    };
    const stored = await storeSnapshot(testEnv, tree, "owner");
    const id = crypto.randomUUID();
    await testEnv.DB.prepare(
      "INSERT INTO reviews(id,tenant,submission_key,status,created_at,token_limit,deadline) VALUES(?,'owner','unused','running',?,?,?)",
    )
      .bind(id, Date.now(), 100000, Date.now() + 600000)
      .run();
    await createJob(
      runtime,
      id,
      "graph",
      "graph",
      ["rio-internal"],
      "head",
      stored.id,
      1,
      { profile: {} as any },
    );
    const job = await payload(id, "graph");
    const chunksOf = async (stream: ReadableStream<Uint8Array>) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream) chunks.push(chunk);
      return chunks;
    };
    const measured = { bytes: 0, storage_ms: 0 };
    const chunks = await chunksOf(
      await jobInput(runtime, job, { shared: true, measured }),
    );
    const bytes = chunks.reduce((n, c) => n + c.length, 0);
    expect(measured.bytes).toBe(bytes);
    const input = await readJobInput(new Blob(chunks).stream());
    const regular = (version: "base" | "head") =>
      Object.entries(tree[version]).filter(([, f]) => f.mode !== 0o120000);
    // The head tree whole; of the base only what differs.
    expect(Object.keys(treeOf(input.files, "head")).sort()).toEqual(
      regular("head")
        .map(([p]) => p)
        .sort(),
    );
    expect(Object.keys(treeOf(input.files, "base")).sort()).toEqual(
      ["!first", "changed.ts", "mode.sh", "now-link", "removed.ts", "~last"].sort(),
    );
    expect(Object.keys(input.shared)).toEqual(["base"]);
    expect([...input.shared.base].sort()).toEqual(Object.keys(common).sort());
    // What the executor builds (a shared path is copied from the head tree)
    // is the base tree, byte for byte and mode for mode.
    const built = { ...input.files };
    for (const path of input.shared.base)
      built[`base/${path}`] = input.files[`head/${path}`];
    for (const version of ["base", "head"] as const) {
      expect(Object.keys(treeOf(built, version)).sort()).toEqual(
        regular(version)
          .map(([p]) => p)
          .sort(),
      );
      for (const [path, file] of regular(version)) {
        const member = built[`${version}/${path}`];
        expect(fileOf({ mode: file.mode } as any, member.bytes)).toEqual(file);
        expect(member.mode).toBe(file.mode === 0o100755 ? 0o755 : 0o644);
      }
    }
    // A runner whose executor may be older gets both trees whole.
    const whole = await chunksOf(await jobInput(runtime, job));
    const plain = await readJobInput(new Blob(whole).stream());
    expect(plain.shared).toEqual({});
    expect(Object.keys(treeOf(plain.files, "base")).length).toBe(
      regular("base").length,
    );
    const wholeBytes = whole.reduce((n, c) => n + c.length, 0);
    expect(bytes).toBeLessThan(wholeBytes * 0.6);
    // Three parts per file (header, content, padding) reach the container as
    // chunks of about a MiB, not as thousands of writes.
    expect(wholeBytes).toBeGreaterThan(1024 * 1024);
    // The file of several chunks is sent a chunk at a time, once when the
    // trees share it and twice when they do not; each time it ends the chunk
    // before it and ends short itself.
    for (const [sent, copies] of [
      [chunks, 1],
      [whole, 2],
    ] as const) {
      expect(sent.length).toBeLessThanOrEqual(
        Math.ceil(sent.reduce((n, c) => n + c.length, 0) / (768 * 1024)) +
          1 +
          2 * copies,
      );
      expect(Math.max(...sent.map((c) => c.length))).toBeLessThanOrEqual(
        1024 * 1024,
      );
    }
  });
  it("bounds analysis artifacts apart from command output", async () => {
    const { id, snapshot: snapshotId } = await review();
    await createJob(
      runtime,
      id,
      "graph",
      "graph",
      ["rio-internal"],
      "head",
      snapshotId,
      1,
      {
        profile: {} as any,
      },
    );
    await createJob(runtime, id, "run", "run", ["true"], "head", snapshotId);
    const graph = await payload(id, "graph"),
      run = await payload(id, "run");
    expect(graph.limits.artifact_bytes).toBe(12 * MiB);
    expect(run.limits.artifact_bytes).toBeUndefined();
    const result = (job: any, artifact: unknown) => ({
      job_id: job.job_id,
      attempt: 1,
      version: "head",
      exit_code: 0,
      stdout: "",
      stderr: "",
      timed_out: false,
      truncated: false,
      artifact,
    });
    // A 4 MiB graph is far beyond the 1 MiB output bound, but within its own.
    expect(() =>
      validateResult(result(graph, { graphs: "x".repeat(4 * MiB) }), graph),
    ).not.toThrow();
    expect(() =>
      validateResult(result(graph, { graphs: "x".repeat(13 * MiB) }), graph),
    ).toThrow("runner artifact limit exceeded");
    expect(() => validateResult(result(run, { forged: true }), run)).toThrow(
      "runner artifact limit exceeded",
    );
    // Phase and timing are bounded numbers, or the result is refused.
    const timed = (timing: unknown, phase?: unknown) => ({
      ...result(run, undefined),
      timing,
      phase,
    });
    expect(() =>
      validateResult(
        timed({ transfer_ms: 1200, extract_ms: 900, command_ms: 5 }, "command"),
        run,
      ),
    ).not.toThrow();
    for (const bad of [
      timed({ transfer_ms: "long" }),
      timed({ transfer_ms: -1 }),
      timed([1, 2]),
      timed(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [i, 1]))),
      timed({}, "elsewhere"),
    ])
      expect(() => validateResult(bad, run)).toThrow("invalid runner result");
  });
  it("answers a stop at once, whatever the stopped container's streams do", async () => {
    const { id, snapshot: snapshotId } = await review();
    const hung = new Promise<never>(() => {});
    // Two containers that never answer again once destroyed: one whose
    // command never starts, one whose output never ends.
    for (const [name, exec] of [
      ["starting", () => hung],
      [
        "running",
        async () => ({ stdin: new WritableStream(), output: () => hung }),
      ],
    ] as const) {
      await createJob(runtime, id, name, "run", ["true"], "head", snapshotId);
      const job = await payload(id, name);
      let begin!: () => void;
      const begun = new Promise<void>((resolve) => (begin = resolve));
      const container = {
        running: false,
        destroyed: 0,
        start: () => {
          container.running = true;
          begin();
        },
        destroy: async () => {
          container.destroyed++;
          container.running = false;
        },
        exec,
      };
      const runner = new SandboxRunner({ container } as any, runtime);
      const execution = runner.run(job);
      await begun;
      expect(container.running).toBe(true);
      expect(await runner.stop()).toEqual({ stopped: true });
      expect(await execution).toEqual(stopped(job));
      expect(container.running).toBe(false);
      // A job that arrives after the stop does not start a container.
      expect(await runner.run(job)).toEqual(stopped(job));
      expect(container.running).toBe(false);
    }
  });
  it("answers a stop while the job's input is still being read, and starts nothing after it", async () => {
    const { id, snapshot: snapshotId } = await review();
    await createJob(runtime, id, "slow", "run", ["true"], "head", snapshotId);
    const job = await payload(id, "slow");
    const container = {
      running: false,
      started: 0,
      destroyed: 0,
      start: () => {
        container.started++;
        container.running = true;
      },
      destroy: async () => {
        container.destroyed++;
        container.running = false;
      },
      exec: async () => ({
        stdin: new WritableStream(),
        output: () => new Promise<never>(() => {}),
      }),
    };
    // Storage that answers a named statement only when released.
    const held = (sql: RegExp) => {
      let reached!: () => void, release!: () => void;
      const at = new Promise<void>((resolve) => (reached = resolve));
      const gate = new Promise<void>((resolve) => (release = resolve));
      const DB = new Proxy(runtime.DB, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (key !== "prepare")
            return typeof value === "function" ? value.bind(target) : value;
          return (text: string) => {
            const statement = target.prepare(text);
            if (!sql.test(text)) return statement;
            return {
              bind: (...values: unknown[]) => ({
                first: async () => {
                  reached();
                  await gate;
                  return statement.bind(...values).first();
                },
              }),
            };
          };
        },
      });
      return { env: { ...runtime, DB } as Env, at, release };
    };
    // Stopped while the snapshot is looked up, before any container: the
    // answer does not wait for storage, and no container starts afterwards.
    const sizing = held(/FROM snapshots s JOIN reviews/);
    let runner = new SandboxRunner({ container } as any, sizing.env);
    let execution = runner.run(job);
    await sizing.at;
    expect(await runner.stop()).toEqual({ stopped: true });
    expect(await execution).toEqual(stopped(job));
    sizing.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.started).toBe(0);
    // Stopped while the last container of the object is being destroyed.
    let destroying!: () => void, destroyed!: () => void;
    const going = new Promise<void>((resolve) => (destroying = resolve));
    const gone = new Promise<void>((resolve) => (destroyed = resolve));
    const busy = {
      ...container,
      running: true,
      start: () => {
        container.started++;
      },
      destroy: async () => {
        destroying();
        await gone;
        busy.running = false;
      },
    };
    runner = new SandboxRunner({ container: busy } as any, runtime);
    execution = runner.run(job);
    await going;
    const stop = runner.stop();
    destroyed();
    expect(await stop).toEqual({ stopped: true });
    expect(await execution).toEqual(stopped(job));
    expect(container.started).toBe(0);
    // A delivery repeated while the job is at work joins it: one container,
    // and the one stop ends both.
    let begin!: () => void;
    const begun = new Promise<void>((resolve) => (begin = resolve));
    const one = {
      ...container,
      start: () => {
        container.started++;
        one.running = true;
        begin();
      },
      destroy: async () => {
        one.running = false;
      },
    };
    runner = new SandboxRunner({ container: one } as any, runtime);
    const [first, second] = [runner.run(job), runner.run(job)];
    await begun;
    expect(container.started).toBe(1);
    await runner.stop();
    expect(await Promise.all([first, second])).toEqual([
      stopped(job),
      stopped(job),
    ]);
    expect(container.started).toBe(1);
    // A stop that was answered withdrew the job. An object that forgot the
    // stop (it left memory in between) still starts nothing for that job.
    await runtime.DB.prepare(
      "UPDATE jobs SET status='failed' WHERE id='slow' AND review_id=?",
    )
      .bind(id)
      .run();
    runner = new SandboxRunner({ container: one } as any, runtime);
    expect(await runner.run(job)).toEqual(stopped(job));
    expect(container.started).toBe(1);
    // Nor when that withdrawal could not be written and the job still reads
    // as leased: the review's cancellation is on record.
    await runtime.DB.batch([
      runtime.DB.prepare(
        "UPDATE jobs SET status='leased' WHERE id='slow' AND review_id=?",
      ).bind(id),
      runtime.DB.prepare("UPDATE reviews SET cancelled=1 WHERE id=?").bind(id),
    ]);
    runner = new SandboxRunner({ container: one } as any, runtime);
    expect(await runner.run(job)).toEqual(stopped(job));
    expect(container.started).toBe(1);
    // The same for a review that ended.
    await runtime.DB.prepare(
      "UPDATE reviews SET cancelled=0,status='partial' WHERE id=?",
    )
      .bind(id)
      .run();
    runner = new SandboxRunner({ container: one } as any, runtime);
    expect(await runner.run(job)).toEqual(stopped(job));
    expect(container.started).toBe(1);
  });
  it("serves the archive only with that job's capability", async () => {
    const { id, snapshot: snapshotId } = await review();
    await createJob(runtime, id, "one", "run", ["true"], "head", snapshotId);
    await createJob(runtime, id, "two", "run", ["true"], "head", snapshotId);
    const path = `/v1/runner/${id}/one/1/archive`;
    const valid = await jobToken(runtime, id, "one", 1, Date.now() + 60000);
    const response = await request(path, "GET", undefined, {
      authorization: `Bearer ${valid}`,
    });
    expect(response.status).toBe(200);
    const input = await readJobInput(response.body!);
    expect(input.header.job_id).toBe("one");
    expect(treeOf(input.files, "head")["src/a.ts"]).toEqual(
      files.head["src/a.ts"],
    );
    expect((await request(path, "GET", undefined, {})).status).toBe(401);
    const another = await jobToken(runtime, id, "two", 1, Date.now() + 60000);
    expect(
      (
        await request(path, "GET", undefined, {
          authorization: `Bearer ${another}`,
        })
      ).status,
    ).toBe(401);
  });
});

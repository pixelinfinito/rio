import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Env, Version } from "./types";
import { invariant, safePath } from "./validation";
import {
  LIMITS,
  MODES,
  SYMLINK,
  compareKey,
  indexKey,
  locatedKey,
  type Located,
  type ManifestIndex,
} from "./snapshot";
const HEX = /^[a-f0-9]{64}$/;
const PART = 8 * 1024 * 1024;
// Entries per located page: one ranged read resolves any path in the page.
const PAGE = 256;
const MAX_CHUNKS = 512;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const digest = (bytes: Uint8Array) => bytesToHex(blake3(bytes));
function prefix(tenant: string) {
  return `snapshots/${tenant}/`;
}
/** Stored location of each requested hash for the tenant (D1 binds one JSON array). */
async function located(
  env: Env,
  tenant: string,
  hashes: string[],
): Promise<Map<string, { pack: string; offset: number; size: number }>> {
  const found = new Map<
    string,
    { pack: string; offset: number; size: number }
  >();
  for (let i = 0; i < hashes.length; i += 2000) {
    const rows = await env.DB.prepare(
      "SELECT hash,pack,offset,size FROM contents WHERE tenant=? AND hash IN (SELECT value FROM json_each(?))",
    )
      .bind(tenant, JSON.stringify(hashes.slice(i, i + 2000)))
      .all<{ hash: string; pack: string; offset: number; size: number }>();
    for (const r of rows.results) found.set(r.hash, r);
  }
  return found;
}
export async function missing(
  env: Env,
  tenant: string,
  value: any,
): Promise<string[]> {
  const hashes = value?.hashes;
  invariant(
    Array.isArray(hashes) &&
      hashes.length > 0 &&
      hashes.length <= 10000 &&
      hashes.every((h) => typeof h === "string" && HEX.test(h)) &&
      new Set(hashes).size === hashes.length,
    "invalid content hashes",
  );
  const found = await located(env, tenant, hashes);
  return hashes.filter((h: string) => !found.has(h));
}
function record(
  env: Env,
  tenant: string,
  pack: string,
  entries: { h: string; o: number; s: number }[],
) {
  // Re-uploads keep the first stored location; contents are immutable.
  return env.DB.prepare(
    "INSERT INTO contents(tenant,hash,pack,offset,size,created_at) SELECT ?,json_extract(value,'$.h'),?,json_extract(value,'$.o'),json_extract(value,'$.s'),? FROM json_each(?) WHERE true ON CONFLICT(tenant,hash) DO NOTHING",
  ).bind(tenant, pack, Date.now(), JSON.stringify(entries));
}
/** Body: u32 big-endian index length, index JSON [{hash,size}], contents in order. */
export async function storePack(
  env: Env,
  tenant: string,
  body: Uint8Array,
): Promise<{ pack: string; contents: number }> {
  invariant(body.length >= 4, "invalid pack");
  const length = new DataView(body.buffer, body.byteOffset, 4).getUint32(0);
  invariant(4 + length <= body.length, "invalid pack index");
  let index: any;
  try {
    index = JSON.parse(decoder.decode(body.subarray(4, 4 + length)));
  } catch {
    throw new Error("invalid pack index");
  }
  invariant(
    Array.isArray(index) &&
      index.length > 0 &&
      index.length <= 2000 &&
      index.every(
        (e) =>
          e &&
          typeof e.hash === "string" &&
          HEX.test(e.hash) &&
          Number.isSafeInteger(e.size) &&
          e.size >= 0 &&
          e.size <= LIMITS.file,
      ) &&
      new Set(index.map((e: any) => e.hash)).size === index.length,
    "invalid pack index",
  );
  const contents = body.subarray(4 + length);
  invariant(
    index.reduce((n: number, e: any) => n + e.size, 0) === contents.length,
    "pack size mismatch",
  );
  // Verify everything before writing anything.
  let offset = 0;
  const entries = index.map((e: any) => {
    invariant(
      digest(contents.subarray(offset, offset + e.size)) === e.hash,
      "pack content hash mismatch",
    );
    const entry = { h: e.hash, o: offset, s: e.size };
    offset += e.size;
    return entry;
  });
  const id = digest(contents),
    pack = `packs/${id}`;
  await env.ARTIFACTS.put(prefix(tenant) + pack, contents);
  await record(env, tenant, pack, entries).run();
  return { pack: id, contents: entries.length };
}
function uploadToken(value: string | undefined): {
  key: string;
  upload: string;
} {
  invariant(value, "upload required");
  let parsed: any;
  try {
    parsed = JSON.parse(atob(value.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    throw new Error("invalid upload");
  }
  invariant(
    typeof parsed?.k === "string" &&
      /^[a-f0-9-]{36}$/.test(parsed.k) &&
      typeof parsed?.u === "string",
    "invalid upload",
  );
  return { key: parsed.k, upload: parsed.u };
}
function largeKey(tenant: string, hash: string, key: string) {
  return `${prefix(tenant)}large/${hash}/${key}`;
}
export async function startUpload(
  env: Env,
  tenant: string,
  hash: string,
  value: any,
): Promise<{ upload?: string; present?: true }> {
  invariant(HEX.test(hash), "invalid content hash");
  invariant(
    Number.isSafeInteger(value?.size) &&
      value.size > 0 &&
      value.size <= LIMITS.file,
    "invalid content size",
  );
  if ((await located(env, tenant, [hash])).has(hash)) return { present: true };
  const key = crypto.randomUUID(),
    upload = await env.ARTIFACTS.createMultipartUpload(
      largeKey(tenant, hash, key),
    );
  return {
    upload: btoa(JSON.stringify({ k: key, u: upload.uploadId }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_"),
  };
}
export async function uploadPart(
  env: Env,
  tenant: string,
  hash: string,
  part: number,
  token: string | undefined,
  body: Uint8Array,
): Promise<{ part: number; etag: string }> {
  invariant(HEX.test(hash), "invalid content hash");
  invariant(
    Number.isInteger(part) && part >= 1 && part <= LIMITS.file / PART,
    "invalid part",
  );
  invariant(body.length > 0 && body.length <= PART, "invalid part size");
  const { key, upload } = uploadToken(token);
  const uploaded = await env.ARTIFACTS.resumeMultipartUpload(
    largeKey(tenant, hash, key),
    upload,
  ).uploadPart(part, body);
  return { part, etag: uploaded.etag };
}
export async function completeUpload(
  env: Env,
  tenant: string,
  hash: string,
  token: string | undefined,
  value: any,
): Promise<{ hash: string; size: number }> {
  invariant(HEX.test(hash), "invalid content hash");
  const { key, upload } = uploadToken(token);
  const size = value?.size,
    parts = value?.parts;
  invariant(
    Number.isSafeInteger(size) &&
      size > 0 &&
      size <= LIMITS.file &&
      Array.isArray(parts) &&
      parts.length === Math.ceil(size / PART) &&
      parts.every(
        (p: any, i: number) => p?.part === i + 1 && typeof p.etag === "string",
      ),
    "invalid upload completion",
  );
  // A retried completion after a lost response finds the content stored.
  const stored = (await located(env, tenant, [hash])).get(hash);
  if (stored) return { hash, size: stored.size };
  const objectKey = largeKey(tenant, hash, key);
  await env.ARTIFACTS.resumeMultipartUpload(objectKey, upload).complete(
    parts.map((p: any) => ({ partNumber: p.part, etag: p.etag })),
  );
  const object = await env.ARTIFACTS.get(objectKey);
  invariant(object, "upload missing");
  const hasher = blake3.create();
  const reader = object.body.getReader();
  let length = 0;
  while (true) {
    const { value: chunk, done } = await reader.read();
    if (done) break;
    length += chunk.length;
    hasher.update(chunk);
  }
  if (length !== size || bytesToHex(hasher.digest()) !== hash) {
    await env.ARTIFACTS.delete(objectKey);
    throw new Error("uploaded content hash mismatch");
  }
  await record(env, tenant, `large/${hash}/${key}`, [
    { h: hash, o: 0, s: size },
  ]).run();
  return { hash, size };
}
export async function storeChunk(
  env: Env,
  tenant: string,
  id: string,
  chunk: number,
  body: Uint8Array,
) {
  invariant(HEX.test(id), "invalid snapshot id");
  invariant(
    Number.isInteger(chunk) && chunk >= 0 && chunk < MAX_CHUNKS,
    "invalid manifest chunk",
  );
  await env.ARTIFACTS.put(
    `${prefix(tenant)}manifests/${id}/chunks/${chunk}`,
    body,
  );
}
const KEYS = ["version", "path", "hash", "mode", "size"];
/**
 * Seals a manifest: recomputes its id, checks canonical form, order, paths, modes,
 * limits and that every content is stored for this tenant, then writes located
 * chunks and a page index. Sealing an existing id is a no-op.
 */
export async function seal(
  env: Env,
  tenant: string,
  id: string,
  value: any,
): Promise<{ id: string; created: boolean }> {
  invariant(HEX.test(id), "invalid snapshot id");
  const sealed = await env.DB.prepare(
    "SELECT id FROM snapshots WHERE id=? AND tenant=?",
  )
    .bind(id, tenant)
    .first();
  if (sealed) return { id, created: false };
  const chunks = value?.chunks;
  invariant(
    Number.isInteger(chunks) && chunks >= 0 && chunks <= MAX_CHUNKS,
    "invalid manifest chunk count",
  );
  const hasher = blake3.create();
  const index: ManifestIndex = {
    id,
    pages: [],
    trees: { base: { paths: 0, bytes: 0 }, head: { paths: 0, bytes: 0 } },
    distinct_bytes: 0,
    links: { base: [], head: [] },
  };
  // 52-bit hash prefixes bound memory at the path limit; a collision only
  // undercounts distinct bytes for the limit check.
  const distinct = new Set<number>();
  let previous: [string, string] | null = null;
  for (let n = 0; n < chunks; n++) {
    const object = await env.ARTIFACTS.get(
      `${prefix(tenant)}manifests/${id}/chunks/${n}`,
    );
    invariant(object, `manifest chunk ${n} missing`);
    const bytes = new Uint8Array(await object.arrayBuffer());
    hasher.update(bytes);
    let text: string;
    try {
      text = decoder.decode(bytes);
    } catch {
      throw new Error("manifest is not UTF-8");
    }
    invariant(
      text.endsWith("\n") || (text === "" && chunks === 1),
      "manifest chunk must end with a complete line",
    );
    const lines = text ? text.slice(0, -1).split("\n") : [];
    const entries = lines.map((line) => {
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        throw new Error("invalid manifest line");
      }
      invariant(
        entry &&
          typeof entry === "object" &&
          JSON.stringify(entry) === line &&
          Object.keys(entry).join(",") === KEYS.join(",") &&
          (entry.version === "base" || entry.version === "head") &&
          typeof entry.hash === "string" &&
          HEX.test(entry.hash) &&
          MODES.includes(entry.mode) &&
          Number.isSafeInteger(entry.size) &&
          entry.size >= 0,
        "invalid manifest line",
      );
      safePath(entry.path);
      invariant(
        entry.size <= LIMITS.file,
        `snapshot limit exceeded: file size ${entry.size} bytes for ${entry.path} (limit ${LIMITS.file})`,
      );
      const key: [string, string] = [entry.version, entry.path];
      invariant(
        !previous || compareKey(previous, key) < 0,
        "manifest is not sorted or has duplicates",
      );
      previous = key;
      const tree = index.trees[entry.version as Version];
      tree.paths++;
      tree.bytes += entry.size;
      invariant(
        tree.paths <= LIMITS.paths,
        `snapshot limit exceeded: more than ${LIMITS.paths} paths in ${entry.version}`,
      );
      const short = parseInt(entry.hash.slice(0, 13), 16);
      if (!distinct.has(short)) {
        distinct.add(short);
        index.distinct_bytes += entry.size;
        invariant(
          index.distinct_bytes <= LIMITS.distinct,
          `snapshot limit exceeded: more than ${LIMITS.distinct} bytes of distinct content`,
        );
      }
      if (entry.mode === SYMLINK)
        index.links[entry.version as Version].push([entry.path, entry.hash]);
      return entry;
    });
    const stored = await located(env, tenant, [
      ...new Set(entries.map((e) => e.hash)),
    ]);
    let out = "",
      size = 0;
    entries.forEach((entry, i) => {
      const at = stored.get(entry.hash);
      invariant(at, "manifest references missing content");
      invariant(at.size === entry.size, "manifest content size mismatch");
      const line =
        JSON.stringify([
          entry.version,
          entry.path,
          entry.hash,
          entry.mode,
          entry.size,
          at.pack,
          at.offset,
        ] satisfies Located) + "\n";
      // A page never spans versions, so a lookup reads only its own tree.
      if (i % PAGE === 0 || entries[i - 1].version !== entry.version)
        index.pages.push([entry.version, entry.path, n, size, size]);
      out += line;
      size += new TextEncoder().encode(line).length;
      index.pages[index.pages.length - 1][4] = size;
    });
    await env.ARTIFACTS.put(locatedKey(tenant, id, n), out);
  }
  invariant(bytesToHex(hasher.digest()) === id, "manifest id mismatch");
  const key = indexKey(tenant, id);
  await env.ARTIFACTS.put(key, JSON.stringify(index), {
    httpMetadata: { contentType: "application/json" },
  });
  await env.DB.prepare(
    "INSERT INTO snapshots(id,tenant,object_key) VALUES(?,?,?) ON CONFLICT DO NOTHING",
  )
    .bind(id, tenant, key)
    .run();
  return { id, created: true };
}

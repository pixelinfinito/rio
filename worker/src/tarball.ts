import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Env, PrepareSpec, Version } from "./types";
import type { InstallationToken } from "./github";
import { invariant, safePath } from "./validation";
import { LIMITS, SYMLINK, compareUtf8 } from "./snapshot";
import {
  largeKey,
  missing,
  record,
  seal,
  storeChunk,
  storePack,
} from "./upload";

// Sandbox preparation (git-host-integration, "Preparation backend
// eligibility"): the Sandbox container has no network, so the Worker fetches
// the base and head trees of a non-fork PR as GitHub tarballs with the
// installation token and stores them as an ordinary content-addressed
// snapshot. The container then prepares the submission from that snapshot.

const BLOCK = 512;
const PACK_BYTES = 7 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export interface TarEntry {
  path: string;
  mode: number;
  content: Uint8Array;
}
function field(block: Uint8Array, offset: number, length: number): string {
  const bytes = block.subarray(offset, offset + length);
  const end = bytes.indexOf(0);
  return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end));
}
function octal(block: Uint8Array, offset: number, length: number): number {
  const text = field(block, offset, length).trim();
  invariant(/^[0-7]*$/.test(text), "invalid tar number");
  return text ? parseInt(text, 8) : 0;
}
function pax(bytes: Uint8Array): Record<string, string> {
  const records: Record<string, string> = {};
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    invariant(space > offset, "invalid pax header");
    const length = Number(decoder.decode(bytes.subarray(offset, space)));
    invariant(Number.isSafeInteger(length) && length > 0, "invalid pax header");
    const record = decoder.decode(
      bytes.subarray(space + 1, offset + length - 1),
    );
    const equals = record.indexOf("=");
    invariant(equals > 0, "invalid pax record");
    records[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return records;
}

/** Buffered reads from a byte stream. */
class Reader {
  private chunks: Uint8Array[] = [];
  private size = 0;
  private done = false;
  constructor(
    private readonly source: ReadableStreamDefaultReader<Uint8Array>,
  ) {}
  async read(n: number): Promise<Uint8Array | null> {
    while (this.size < n && !this.done) {
      const { value, done } = await this.source.read();
      if (done) this.done = true;
      else if (value.length) {
        this.chunks.push(value);
        this.size += value.length;
      }
    }
    if (this.size < n) return null;
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const chunk = this.chunks[0];
      const take = Math.min(chunk.length, n - filled);
      out.set(chunk.subarray(0, take), filled);
      filled += take;
      if (take === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(take);
    }
    this.size -= n;
    return out;
  }
}

/**
 * Regular files and symbolic links of a `git archive` tarball, with the
 * archive's top-level directory removed. Paths are validated like uploaded
 * snapshot paths; anything else (devices, hard links) is rejected.
 */
export async function* tarEntries(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<TarEntry> {
  const reader = new Reader(stream.getReader());
  let extended: Record<string, string> = {};
  let longName: string | null = null;
  while (true) {
    const header = await reader.read(BLOCK);
    invariant(header, "truncated tarball");
    if (header.every((b) => b === 0)) return;
    const size = octal(header, 124, 12);
    invariant(size <= LIMITS.file, "tarball member exceeds the file limit");
    const type = String.fromCharCode(header[156] || 0x30);
    const body = size ? await reader.read(size) : new Uint8Array();
    invariant(body, "truncated tarball");
    const padding = (BLOCK - (size % BLOCK)) % BLOCK;
    if (padding) invariant(await reader.read(padding), "truncated tarball");
    if (type === "x") {
      extended = pax(body);
      continue;
    }
    if (type === "g") continue;
    if (type === "L") {
      longName = decoder.decode(body).replace(/\0+$/, "");
      continue;
    }
    const prefix = field(header, 345, 155);
    const name =
      extended.path ??
      longName ??
      (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    const link = extended.linkpath ?? field(header, 157, 100);
    extended = {};
    longName = null;
    if (type === "5") continue;
    const path = name.split("/").slice(1).join("/");
    if (!path) continue;
    safePath(path);
    if (type === "2") {
      yield { path, mode: SYMLINK, content: new TextEncoder().encode(link) };
      continue;
    }
    invariant(type === "0", `unsupported tarball member type ${type}`);
    const mode = octal(header, 100, 8) & 0o111 ? 0o100755 : 0o100644;
    yield { path, mode, content: body };
  }
}

interface Line {
  version: Version;
  path: string;
  hash: string;
  mode: number;
  size: number;
}
/** Stores contents in packs (large contents alone), skipping stored ones. */
class Packer {
  private pending: { hash: string; content: Uint8Array }[] = [];
  private bytes = 0;
  private seen = new Set<string>();
  distinct = 0;
  constructor(
    private readonly env: Env,
    private readonly tenant: string,
  ) {}
  async add(hash: string, content: Uint8Array) {
    if (this.seen.has(hash)) return;
    this.seen.add(hash);
    this.distinct += content.length;
    invariant(
      this.distinct <= LIMITS.distinct,
      "snapshot exceeds the distinct content limit",
    );
    if (content.length > PACK_BYTES) {
      if ((await missing(this.env, this.tenant, { hashes: [hash] })).length) {
        const key = crypto.randomUUID();
        await this.env.ARTIFACTS.put(largeKey(this.tenant, hash, key), content);
        await record(this.env, this.tenant, `large/${hash}/${key}`, [
          { h: hash, o: 0, s: content.length },
        ]).run();
      }
      return;
    }
    if (this.bytes + content.length > PACK_BYTES || this.pending.length >= 2000)
      await this.flush();
    this.pending.push({ hash, content });
    this.bytes += content.length;
  }
  async flush() {
    if (!this.pending.length) return;
    const absent = new Set(
      await missing(this.env, this.tenant, {
        hashes: this.pending.map((p) => p.hash),
      }),
    );
    const entries = this.pending.filter((p) => absent.has(p.hash));
    this.pending = [];
    this.bytes = 0;
    if (!entries.length) return;
    const index = new TextEncoder().encode(
      JSON.stringify(
        entries.map((e) => ({ hash: e.hash, size: e.content.length })),
      ),
    );
    const size = entries.reduce((n, e) => n + e.content.length, 0);
    const body = new Uint8Array(4 + index.length + size);
    new DataView(body.buffer).setUint32(0, index.length);
    body.set(index, 4);
    let offset = 4 + index.length;
    for (const e of entries) {
      body.set(e.content, offset);
      offset += e.content.length;
    }
    await storePack(this.env, this.tenant, body);
  }
}

/** Downloads base and head and seals them as one snapshot; returns its id. */
export async function ingestTarballs(
  env: Env,
  tenant: string,
  token: InstallationToken,
  spec: Pick<PrepareSpec, "repository" | "base_sha" | "head_sha">,
): Promise<string> {
  const packer = new Packer(env, tenant);
  const lines: Line[] = [];
  for (const [version, sha] of [
    ["base", spec.base_sha],
    ["head", spec.head_sha],
  ] as const) {
    const response = await token.download(
      `/repos/${spec.repository}/tarball/${sha}`,
    );
    invariant(response.body, "empty tarball");
    const paths = new Set<string>();
    for await (const entry of tarEntries(
      response.body.pipeThrough(new DecompressionStream("gzip")),
    )) {
      invariant(!paths.has(entry.path), "duplicate tarball path");
      paths.add(entry.path);
      invariant(paths.size <= LIMITS.paths, "snapshot exceeds the path limit");
      const hash = bytesToHex(blake3(entry.content));
      await packer.add(hash, entry.content);
      lines.push({
        version,
        path: entry.path,
        hash,
        mode: entry.mode,
        size: entry.content.length,
      });
    }
  }
  await packer.flush();
  lines.sort(
    (a, b) =>
      (a.version === b.version ? 0 : a.version === "base" ? -1 : 1) ||
      compareUtf8(a.path, b.path),
  );
  const encoder = new TextEncoder();
  const encoded = lines.map((l) =>
    encoder.encode(
      `${JSON.stringify({ version: l.version, path: l.path, hash: l.hash, mode: l.mode, size: l.size })}\n`,
    ),
  );
  const total = encoded.reduce((n, l) => n + l.length, 0);
  const manifest = new Uint8Array(total);
  let offset = 0;
  for (const line of encoded) {
    manifest.set(line, offset);
    offset += line.length;
  }
  const id = bytesToHex(blake3(manifest));
  let chunk = 0,
    start = 0,
    end = 0;
  for (const line of encoded) {
    if (end + line.length - start > LIMITS.request && end > start) {
      await storeChunk(env, tenant, id, chunk++, manifest.slice(start, end));
      start = end;
    }
    end += line.length;
  }
  if (end > start || chunk === 0)
    await storeChunk(env, tenant, id, chunk++, manifest.slice(start, end));
  return (await seal(env, tenant, id, { chunks: chunk })).id;
}

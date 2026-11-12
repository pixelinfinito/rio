import type { Env, Execution, Version } from "./types";
import { invariant } from "./validation";
import {
  BATCH_BYTES,
  BATCH_ENTRIES,
  type Entry,
  LARGE,
  SYMLINK,
  StoredSnapshot,
  type TreeReader,
  compareUtf8,
} from "./snapshot";
const encoder = new TextEncoder();
const BLOCK = 512;
function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}
function header(name: Uint8Array, size: number, mode: number, type: string) {
  const block = new Uint8Array(BLOCK);
  const put = (offset: number, text: string | Uint8Array) =>
    block.set(typeof text === "string" ? encoder.encode(text) : text, offset);
  put(0, name.subarray(0, 100));
  put(100, octal(mode, 8));
  put(108, octal(0, 8));
  put(116, octal(0, 8));
  put(124, octal(size, 12));
  put(136, octal(0, 12));
  put(148, "        ");
  put(156, type);
  put(257, "ustar\0");
  put(263, "00");
  let sum = 0;
  for (const byte of block) sum += byte;
  put(148, sum.toString(8).padStart(6, "0") + "\0 ");
  return block;
}
const padding = (size: number) =>
  new Uint8Array((BLOCK - (size % BLOCK)) % BLOCK);
/** PAX record "<length> path=<name>\n", where length counts itself. */
function paxPath(name: Uint8Array): Uint8Array {
  const body = new Uint8Array([...encoder.encode(" path="), ...name, 10]);
  let length = body.length + 1;
  while (String(length).length + body.length !== length) length++;
  return new Uint8Array([...encoder.encode(String(length)), ...body]);
}
/** Tar member blocks before a file's content. */
export function memberHeader(path: string, size: number, mode: number) {
  const name = encoder.encode(path);
  const parts: Uint8Array[] = [];
  if (name.length <= 100 && !/[^\x20-\x7e]/.test(path)) {
    parts.push(header(name, size, mode, "0"));
    return parts;
  }
  // The PAX record carries the real name. The fixed field gets a printable ASCII
  // stand-in: readers decode it strictly even though the PAX name replaces it.
  const pax = paxPath(name);
  parts.push(header(encoder.encode("././@PaxHeader"), pax.length, 0o644, "x"));
  parts.push(pax, padding(pax.length));
  const fallback = encoder.encode(
    path.replace(/[^\x20-\x7e]/g, "_").slice(0, 100),
  );
  parts.push(header(fallback, size, mode, "0"));
  return parts;
}
/** Run commands need their own tree. QA also reads both trees to select journeys
 * affected by removed guidance and route mappings; only one enters its app pod. */
export function needs(kind: Execution["kind"], version: Version): Version[] {
  if (kind === "model") return [];
  return kind === "run" ? [version] : ["base", "head"];
}
/** Longest time the job archive may take to reach the container. */
export const TRANSFER_CAP_MS = 240000;
/**
 * Time allowed for streaming and extracting a job's archive, apart from its
 * command wall: a minute plus 4 MiB/s of the needed trees' bytes, capped so a
 * job still ends inside one queue consumer invocation (15 minutes).
 */
export function transferMs(
  trees: Record<Version, { bytes: number }>,
  versions: Version[],
): number {
  const bytes = versions.reduce((sum, v) => sum + (trees[v]?.bytes ?? 0), 0);
  return Math.min(TRANSFER_CAP_MS, 60000 + Math.ceil(bytes / 4194304) * 1000);
}
export async function snapshotFor(
  env: Env,
  job: Execution,
): Promise<StoredSnapshot> {
  // The snapshot is resolved through the review's tenant, never from the job alone.
  const row = await env.DB.prepare(
    "SELECT s.object_key FROM snapshots s JOIN reviews r ON r.tenant=s.tenant WHERE r.id=? AND s.id=?",
  )
    .bind(job.review_id, job.snapshot_id)
    .first<{ object_key: string }>();
  invariant(row, "snapshot not found");
  return StoredSnapshot.open(env, row.object_key);
}
/** Bytes of one chunk of the executor's input. */
const CHUNK = 1024 * 1024;
/** Path bytes of one `same/<version>` member. */
const SAME_BYTES = 256 * 1024;
/**
 * Joins an archive's parts (a header, a content and padding per file, most
 * of them a few hundred bytes) into chunks of about `CHUNK`: every chunk is
 * a write to the container, and a tree of thousands of files was that many
 * writes three times over. A part of a quarter chunk or more is not copied:
 * it passes as it is, a chunk of it at a time when it is larger than one.
 */
async function* joined(
  parts: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  let buffer = new Uint8Array(CHUNK),
    used = 0;
  // A yielded chunk belongs to the reader: the next one gets its own buffer.
  const flush = () => {
    const chunk = buffer.subarray(0, used);
    buffer = new Uint8Array(CHUNK);
    used = 0;
    return chunk;
  };
  for await (const part of parts) {
    if (part.length >= CHUNK / 4) {
      if (used) yield flush();
      for (let at = 0; at < part.length; at += CHUNK)
        yield part.subarray(at, at + CHUNK);
      continue;
    }
    if (used + part.length > CHUNK) yield flush();
    buffer.set(part, used);
    used += part.length;
  }
  if (used) yield flush();
}
/** Tar members of the entries, with the bytes a batch read gave for them. */
async function* members(
  version: Version,
  tree: TreeReader,
  batch: Iterable<[Entry, Uint8Array | null]>,
): AsyncGenerator<Uint8Array> {
  for (const [entry, bytes] of batch) {
    const mode = entry.mode === 0o100755 ? 0o755 : 0o644;
    yield* memberHeader(`${version}/${entry.path}`, entry.size, mode);
    if (bytes) yield bytes;
    else {
      // Large contents stream straight from storage.
      const reader = (await tree.stream(entry)).getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        yield value;
      }
    }
    yield padding(entry.size);
  }
}
/**
 * The base tree after the head's, without what the two share: a file whose
 * content and mode equal the head's file of that path is named in a
 * `same/base` member (a JSON array of paths) and the executor copies it from
 * the head tree it just wrote. A change touches a few files of a repository,
 * so the archive of both trees is about one tree's bytes instead of two.
 */
async function* baseAfterHead(
  snapshot: StoredSnapshot,
): AsyncGenerator<Uint8Array> {
  const head = snapshot.head.list()[Symbol.asyncIterator]();
  let other = await head.next();
  let same: string[] = [],
    sameBytes = 0,
    batch: Entry[] = [],
    size = 0;
  const shared = function* () {
    const body = encoder.encode(JSON.stringify(same));
    yield header(encoder.encode("same/base"), body.length, 0o644, "0");
    yield body;
    yield padding(body.length);
    same = [];
    sameBytes = 0;
  };
  const differing = async function* () {
    const entries = batch;
    batch = [];
    size = 0;
    const bytes = await snapshot.base.many(entries);
    yield* members(
      "base",
      snapshot.base,
      entries.map((entry, i): [Entry, Uint8Array | null] => [entry, bytes[i]]),
    );
  };
  try {
    // Both lists are in path order: one pass, and neither is held.
    for await (const entry of snapshot.base.list()) {
      if (entry.mode === SYMLINK) continue;
      while (!other.done && compareUtf8(other.value.path, entry.path) < 0)
        other = await head.next();
      const twin =
        !other.done && other.value.path === entry.path ? other.value : null;
      if (twin && twin.hash === entry.hash && twin.mode === entry.mode) {
        same.push(entry.path);
        sameBytes += entry.path.length + 3;
        if (sameBytes >= SAME_BYTES) yield* shared();
      } else {
        batch.push(entry);
        size += entry.size > LARGE ? 0 : entry.size;
        if (batch.length >= BATCH_ENTRIES || size >= BATCH_BYTES)
          yield* differing();
      }
    }
    if (batch.length) yield* differing();
    if (same.length) yield* shared();
  } finally {
    await head.return?.(undefined);
  }
}
/** What a job's archive stream measured while it was read. */
export interface Transfer {
  /** Archive bytes produced. */
  bytes: number;
  /** Time spent producing them (reading storage), apart from writing them. */
  storage_ms: number;
}
/**
 * The executor's standard input: one JSON header line (the job plus its symbolic
 * links) and a tar archive of the needed trees, in chunks of about a MiB. It is
 * produced on demand, so no tree is ever buffered whole. With `shared` (an
 * executor of this version: the Sandbox image deploys with the Worker), a
 * job that needs both trees gets the head's, then the base's without the
 * files the two share.
 */
export async function jobInput(
  env: Env,
  job: Execution,
  options: { shared?: boolean; measured?: Transfer } = {},
): Promise<ReadableStream<Uint8Array>> {
  const snapshot = await snapshotFor(env, job);
  const links: Partial<Record<Version, Record<string, string>>> = {};
  for (const version of job.needs)
    links[version] = await snapshot.links(version);
  const head = encoder.encode(JSON.stringify({ ...job, links }) + "\n");
  const shared =
    options.shared && job.needs.includes("base") && job.needs.includes("head");
  const order: Version[] = shared ? ["head", "base"] : job.needs;
  async function* chunks(): AsyncGenerator<Uint8Array> {
    yield head;
    for (const version of order) {
      if (shared && version === "base") {
        yield* baseAfterHead(snapshot);
        continue;
      }
      const tree = snapshot[version];
      for await (const batch of tree.batches((e) => e.mode !== SYMLINK))
        yield* members(version, tree, batch);
    }
    yield new Uint8Array(BLOCK * 2);
  }
  const iterator = joined(chunks());
  const measured = options.measured;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const started = Date.now();
      const { value, done } = await iterator.next();
      if (measured) measured.storage_ms += Date.now() - started;
      if (done) controller.close();
      else {
        if (measured) measured.bytes += value.length;
        controller.enqueue(value);
      }
    },
    async cancel() {
      await iterator.return(undefined);
    },
  });
}

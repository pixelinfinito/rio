import type { Env, File, Snapshot, Version } from "./types";
import { invariant } from "./validation";
// Shared snapshot limits; the CLI checks the same values before uploading.
export const LIMITS = {
  paths: 300000,
  file: 64 * 1024 * 1024,
  distinct: 1024 * 1024 * 1024,
  request: 8 * 1024 * 1024,
};
export const SYMLINK = 0o120000;
export const MODES = [0o100644, 0o100755, SYMLINK];
// Contents above this size are stored alone and read as streams, never whole.
export const LARGE = 8 * 1024 * 1024;
export interface Entry {
  path: string;
  hash: string;
  mode: number;
  size: number;
  // Object key relative to the tenant prefix, and byte offset inside it.
  pack: string;
  offset: number;
}
/** UTF-8 byte order, which equals code point order (not UTF-16 unit order). */
export function compareUtf8(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.codePointAt(i)!,
      y = b.codePointAt(i)!;
    if (x !== y) return x < y ? -1 : 1;
    if (x > 0xffff) i++;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}
export function compareKey(
  a: readonly [string, string],
  b: readonly [string, string],
): number {
  return a[0] === b[0] ? compareUtf8(a[1], b[1]) : a[0] < b[0] ? -1 : 1;
}
const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
/** Text as the CLI's former UTF-8 check saw it, or null for binary content. */
export function decodeText(bytes: Uint8Array): string | null {
  try {
    return strict.decode(bytes);
  } catch {
    return null;
  }
}
function base64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
/** The former in-memory file shape, for code that needs a few files at once. */
export function fileOf(entry: Entry, bytes: Uint8Array): File {
  const text = entry.mode === SYMLINK ? null : decodeText(bytes);
  if (text !== null) return { mode: entry.mode, content: text };
  const link = entry.mode === SYMLINK ? decodeText(bytes) : null;
  return link !== null
    ? { mode: entry.mode, content: link }
    : { mode: entry.mode, content: base64(bytes), encoding: "base64" };
}
export async function* splitLines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const reader = stream.getReader();
  let rest = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      const text = done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      const parts = (rest + text).split("\n");
      rest = parts.pop()!;
      for (const line of parts) yield line;
      if (done) break;
    }
    yield rest;
  } finally {
    reader.releaseLock();
  }
}
/** One version's tree, read on demand. */
export interface TreeReader {
  stat(path: string): Promise<Entry | null>;
  /** Content bytes; large contents should be read with `stream`. */
  read(entry: Entry): Promise<Uint8Array>;
  stream(entry: Entry): Promise<ReadableStream<Uint8Array>>;
  /** Every entry in path order. */
  list(): AsyncIterable<Entry>;
  /**
   * Kept entries in path order with their bytes, in batches that read each pack
   * once. Large contents come without bytes; read them with `stream`.
   */
  batches(keep: (entry: Entry) => boolean): AsyncIterable<Scanned[]>;
}
export type Scanned = [Entry, Uint8Array | null];
/** Visits kept entries in path order until `visit` returns false. */
export async function scan(
  tree: TreeReader,
  keep: (entry: Entry) => boolean,
  visit: (entry: Entry, bytes: Uint8Array | null) => Promise<boolean | void>,
): Promise<void> {
  for await (const batch of tree.batches(keep))
    for (const [entry, bytes] of batch)
      if ((await visit(entry, bytes)) === false) return;
}
export interface SnapshotReader {
  base: TreeReader;
  head: TreeReader;
}
/** Files for the given paths only (missing paths are omitted). */
export async function materialize(
  tree: TreeReader,
  paths: Iterable<string>,
): Promise<Record<string, File>> {
  const wanted = new Set(paths);
  const files: Record<string, File> = {};
  const entries: Entry[] = [];
  for (const path of wanted) {
    const entry = await tree.stat(path);
    if (entry) entries.push(entry);
  }
  for (const entry of entries)
    files[entry.path] = fileOf(entry, await tree.read(entry));
  return files;
}
/** Text of a file, or null when it is missing, binary or a link. */
export async function textOf(
  tree: TreeReader,
  path: string,
): Promise<string | null> {
  const entry = await tree.stat(path);
  if (!entry || entry.mode === SYMLINK) return null;
  return decodeText(await tree.read(entry));
}

/** Bounded least-recently-used cache measured in bytes. */
class Lru<V> {
  private items = new Map<string, { value: V; size: number }>();
  private used = 0;
  constructor(readonly limit: number) {}
  get(key: string): V | undefined {
    const item = this.items.get(key);
    if (!item) return undefined;
    this.items.delete(key);
    this.items.set(key, item);
    return item.value;
  }
  set(key: string, value: V, size: number) {
    if (size > this.limit) return;
    const old = this.items.get(key);
    if (old) {
      this.used -= old.size;
      this.items.delete(key);
    }
    this.items.set(key, { value, size });
    this.used += size;
    for (const [k, item] of this.items) {
      if (this.used <= this.limit) break;
      this.items.delete(k);
      this.used -= item.size;
    }
  }
}

// Located manifest line: [version, path, hash, mode, size, pack, offset].
export type Located = [Version, string, string, number, number, string, number];
export interface ManifestIndex {
  id: string;
  // [version, first path, chunk, start byte, end byte] of each page, in order.
  pages: [Version, string, number, number, number][];
  trees: Record<Version, { paths: number; bytes: number }>;
  distinct_bytes: number;
  links: Record<Version, [string, string][]>;
}
export function entryOf(line: Located): Entry {
  return {
    path: line[1],
    hash: line[2],
    mode: line[3],
    size: line[4],
    pack: line[5],
    offset: line[6],
  };
}
export function indexKey(tenant: string, id: string): string {
  return `snapshots/${tenant}/manifests/${id}/index.json`;
}
export function locatedKey(tenant: string, id: string, chunk: number): string {
  return `snapshots/${tenant}/manifests/${id}/located/${chunk}`;
}
/** A sealed snapshot in R2: a small page index over located manifest chunks. */
export class StoredSnapshot implements SnapshotReader {
  readonly base: TreeReader;
  readonly head: TreeReader;
  private pages = new Lru<Map<string, Entry>>(4 * 1024 * 1024);
  private contents = new Lru<Uint8Array>(16 * 1024 * 1024);
  private constructor(
    readonly env: Env,
    readonly prefix: string,
    readonly index: ManifestIndex,
    // Counts R2 reads of packs, for tests and budgeting.
    readonly reads: string[] = [],
  ) {
    this.base = this.tree("base");
    this.head = this.tree("head");
  }
  static async open(env: Env, key: string): Promise<StoredSnapshot> {
    const match =
      /^(snapshots\/[^/]+\/)manifests\/[a-f0-9]{64}\/index\.json$/.exec(key);
    invariant(match, "invalid snapshot key");
    const object = await env.ARTIFACTS.get(key);
    invariant(object, "snapshot not found");
    return new StoredSnapshot(
      env,
      match[1],
      await object.json<ManifestIndex>(),
    );
  }
  private async object(
    key: string,
    range?: { offset: number; length: number },
  ): Promise<R2ObjectBody> {
    const object = await this.env.ARTIFACTS.get(this.prefix + key, {
      ...(range ? { range } : {}),
    });
    invariant(object, "snapshot content missing");
    return object;
  }
  private async page(position: number): Promise<Map<string, Entry>> {
    const [version, , chunk, start, end] = this.index.pages[position];
    const key = `${version}:${position}`;
    const cached = this.pages.get(key);
    if (cached) return cached;
    const text = await (
      await this.object(this.located(chunk), {
        offset: start,
        length: end - start,
      })
    ).text();
    const entries = new Map<string, Entry>();
    for (const line of text.split("\n"))
      if (line) {
        const value = JSON.parse(line) as Located;
        entries.set(value[1], entryOf(value));
      }
    this.pages.set(key, entries, end - start);
    return entries;
  }
  private located(chunk: number) {
    return `manifests/${this.index.id}/located/${chunk}`;
  }
  private find(version: Version, path: string): number {
    const pages = this.index.pages;
    let low = 0,
      high = pages.length - 1,
      found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (compareKey([pages[mid][0], pages[mid][1]], [version, path]) <= 0) {
        found = mid;
        low = mid + 1;
      } else high = mid - 1;
    }
    return found >= 0 && pages[found][0] === version ? found : -1;
  }
  private async read(entry: Entry): Promise<Uint8Array> {
    if (entry.size === 0) return new Uint8Array();
    const key = `${entry.pack}@${entry.offset}`;
    const cached = this.contents.get(key);
    if (cached) return cached;
    this.reads.push(entry.pack);
    const bytes = new Uint8Array(
      await (
        await this.object(entry.pack, {
          offset: entry.offset,
          length: entry.size,
        })
      ).arrayBuffer(),
    );
    this.contents.set(key, bytes, bytes.length);
    return bytes;
  }
  private async stream(entry: Entry): Promise<ReadableStream<Uint8Array>> {
    if (entry.size === 0) return new Blob([]).stream();
    this.reads.push(entry.pack);
    return (
      await this.object(entry.pack, {
        offset: entry.offset,
        length: entry.size,
      })
    ).body;
  }
  private async *list(version: Version): AsyncGenerator<Entry> {
    const pages = this.index.pages;
    for (let i = 0; i < pages.length;) {
      if (pages[i][0] !== version) {
        i++;
        continue;
      }
      // One ranged read covers consecutive pages of the same located chunk.
      let j = i;
      while (
        j + 1 < pages.length &&
        pages[j + 1][0] === version &&
        pages[j + 1][2] === pages[i][2]
      )
        j++;
      const object = await this.object(this.located(pages[i][2]), {
        offset: pages[i][3],
        length: pages[j][4] - pages[i][3],
      });
      for await (const line of splitLines(object.body))
        if (line) yield entryOf(JSON.parse(line) as Located);
      i = j + 1;
    }
  }
  private async *batches(
    version: Version,
    keep: (entry: Entry) => boolean,
  ): AsyncGenerator<Scanned[]> {
    let batch: Entry[] = [],
      size = 0;
    const flush = async (): Promise<Scanned[]> => {
      const bytes = await this.packed(batch);
      const out = batch.map((entry): Scanned => [
        entry,
        entry.size > LARGE ? null : (bytes.get(entry) ?? new Uint8Array()),
      ]);
      batch = [];
      size = 0;
      return out;
    };
    for await (const entry of this.list(version)) {
      if (!keep(entry)) continue;
      batch.push(entry);
      size += entry.size > LARGE ? 0 : entry.size;
      if (batch.length >= 4096 || size >= 32 * 1024 * 1024) yield await flush();
    }
    if (batch.length) yield await flush();
  }
  /** Reads each pack once: one ranged read spanning the batch's entries in it. */
  private async packed(batch: Entry[]): Promise<Map<Entry, Uint8Array>> {
    const groups = new Map<string, Entry[]>();
    for (const entry of batch)
      if (entry.size > 0 && entry.size <= LARGE)
        groups.set(entry.pack, [...(groups.get(entry.pack) ?? []), entry]);
    const result = new Map<Entry, Uint8Array>();
    for (const [pack, entries] of groups) {
      const start = Math.min(...entries.map((e) => e.offset)),
        end = Math.max(...entries.map((e) => e.offset + e.size));
      this.reads.push(pack);
      const bytes = new Uint8Array(
        await (
          await this.object(pack, { offset: start, length: end - start })
        ).arrayBuffer(),
      );
      for (const entry of entries)
        result.set(
          entry,
          bytes.subarray(
            entry.offset - start,
            entry.offset - start + entry.size,
          ),
        );
    }
    return result;
  }
  private tree(version: Version): TreeReader {
    return {
      stat: async (path) => {
        const page = this.find(version, path);
        return page < 0 ? null : ((await this.page(page)).get(path) ?? null);
      },
      read: (entry) => this.read(entry),
      stream: (entry) => this.stream(entry),
      list: () => this.list(version),
      batches: (keep) => this.batches(version, keep),
    };
  }
  async links(version: Version): Promise<Record<string, string>> {
    const links: Record<string, string> = {};
    for (const [path] of this.index.links[version] ?? []) {
      const entry = await this[version].stat(path);
      invariant(entry, "snapshot link missing");
      links[path] = base64(await this.read(entry));
    }
    return links;
  }
}

const encoder = new TextEncoder();
/** An in-memory snapshot behind the reader interface (tests and small trees). */
export class MemorySnapshot implements SnapshotReader {
  readonly base: TreeReader;
  readonly head: TreeReader;
  constructor(readonly snapshot: Snapshot) {
    this.base = MemorySnapshot.tree(snapshot.base);
    this.head = MemorySnapshot.tree(snapshot.head);
  }
  static bytes(file: File): Uint8Array {
    return file.encoding === "base64"
      ? Uint8Array.from(atob(file.content), (c) => c.charCodeAt(0))
      : encoder.encode(file.content);
  }
  static tree(files: Record<string, File>): TreeReader {
    const entry = (path: string): Entry | null =>
      Object.hasOwn(files, path)
        ? {
            path,
            hash: "",
            mode: files[path].mode,
            size: MemorySnapshot.bytes(files[path]).length,
            pack: "",
            offset: 0,
          }
        : null;
    const sorted = () =>
      Object.keys(files)
        .sort(compareUtf8)
        .map((path) => entry(path)!);
    return {
      stat: async (path) => entry(path),
      read: async (e) => MemorySnapshot.bytes(files[e.path]),
      stream: async (e) =>
        new Blob([MemorySnapshot.bytes(files[e.path])]).stream(),
      list: async function* () {
        yield* sorted();
      },
      batches: async function* (keep) {
        for (const e of sorted())
          if (keep(e))
            yield [
              [e, e.size > LARGE ? null : MemorySnapshot.bytes(files[e.path])],
            ] as Scanned[];
      },
    };
  }
}
export function readerOf(source: Snapshot | SnapshotReader): SnapshotReader {
  return typeof (source.base as TreeReader).stat === "function"
    ? (source as SnapshotReader)
    : new MemorySnapshot(source as Snapshot);
}
/** Line counts of the regular files among `paths`, as `split("\n").length` counts them. */
export async function lineCounts(
  tree: TreeReader,
  paths: Set<string>,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const count = (bytes: Uint8Array, n = 0) => {
    for (const byte of bytes) if (byte === 10) n++;
    return n;
  };
  for await (const batch of tree.batches(
    (e) => paths.has(e.path) && e.mode !== SYMLINK,
  ))
    for (const [entry, bytes] of batch) {
      let n = 0;
      if (bytes) n = count(bytes);
      else {
        const reader = (await tree.stream(entry)).getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          n = count(value, n);
        }
      }
      counts.set(entry.path, n + 1);
    }
  return counts;
}

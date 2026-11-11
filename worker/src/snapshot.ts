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
// One scan batch: the contents a consumer holds at a time. The Worker isolate
// has 128 MiB for every review it serves, so a batch is a few MiB, not the tree.
export const BATCH_BYTES = 4 * 1024 * 1024;
export const BATCH_ENTRIES = 1024;
// Text of a change that one step holds, both versions together.
export const CHANGE_BYTES = 32 * 1024 * 1024;
// A step waits this long for another to finish with its change's text.
const HOLD_WAIT_MS = 120000;
// Text a `prefetched` reader holds per version.
const WINDOW_BYTES = 8 * 1024 * 1024;
// Two wanted contents of a pack closer than this are read together: a storage
// request costs about as long as this many bytes take to arrive. One read
// stops growing at `RUN`, whatever the gaps.
const GAP = 256 * 1024;
const RUN = 2 * BATCH_BYTES;
// Ranged reads of one batch in flight.
const READS = 3;
// A scan waits this long for another scan's batch before reading its own.
const SCAN_WAIT_MS = 60000;
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
   * Kept entries in path order with their bytes, in batches of a few MiB read
   * with a few requests per pack. Large contents come without bytes; read them
   * with `stream`. A batch is the caller's until it asks for the next one.
   */
  batches(keep: (entry: Entry) => boolean): AsyncIterable<Scanned[]>;
  /**
   * The contents of the entries, in their order, with a few reads per pack;
   * null for a large content. The caller bounds the entries it asks for.
   */
  many(entries: Entry[]): Promise<(Uint8Array | null)[]>;
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
/**
 * `textOf` for many paths, a few reads per pack instead of one per file: a
 * change of thousands of files costs tens of storage requests. Paths that are
 * missing, binary or links map to null. The caller bounds what it asks for.
 */
export async function textsOf(
  tree: TreeReader,
  paths: Iterable<string>,
): Promise<Map<string, string | null>> {
  const texts = new Map<string, string | null>();
  for (const path of paths) texts.set(path, null);
  const entries: Entry[] = [];
  // In path order a manifest page is read once.
  for (const path of [...texts.keys()].sort(compareUtf8)) {
    const entry = await tree.stat(path);
    if (entry && entry.mode !== SYMLINK) entries.push(entry);
  }
  for (let start = 0; start < entries.length;) {
    let end = start,
      size = 0;
    while (
      end < entries.length &&
      end - start < BATCH_ENTRIES &&
      (end === start || size + entries[end].size <= BATCH_BYTES)
    )
      size += entries[end++].size;
    const group = entries.slice(start, end);
    const bytes = await tree.many(group);
    for (const [i, entry] of group.entries())
      texts.set(
        entry.path,
        decodeText(bytes[i] ?? (await tree.read(entry))),
      );
    start = end;
  }
  return texts;
}
export interface ChangeTexts {
  base: Record<string, string | null>;
  head: Record<string, string | null>;
  // Changed files left unread, in both versions, because the change's text
  // exceeds the budget.
  omitted: { files: number; bytes: number };
}
/**
 * Both versions of a change's files as text, within a byte budget: the steps
 * that hold a whole change (triage, the contract inventory) run in a 128 MiB
 * isolate, and a change of 45 MiB of text ended one. Smaller files are read
 * first, so the budget leaves out the fewest; a file is read in both versions
 * or in neither, so an unread file never looks added or deleted. What is left
 * out is counted, for the report to say so.
 */
export async function changeTexts(
  snapshot: SnapshotReader,
  changed: { path: string; old_path?: string }[],
  budget = CHANGE_BYTES,
): Promise<ChangeTexts> {
  const result: ChangeTexts = {
    base: {},
    head: {},
    omitted: { files: 0, bytes: 0 },
  };
  const sized = async (version: Version, paths: string[]) => {
    const sizes = new Map<string, number>();
    // In path order a manifest page is read once.
    for (const path of [...new Set(paths)].sort(compareUtf8)) {
      result[version][path] = null;
      const entry = await snapshot[version].stat(path);
      if (entry && entry.mode !== SYMLINK) sizes.set(path, entry.size);
    }
    return sizes;
  };
  const sizes = {
    base: await sized(
      "base",
      changed.map((f) => f.old_path ?? f.path),
    ),
    head: await sized(
      "head",
      changed.map((f) => f.path),
    ),
  };
  const files = changed
    .map((f) => {
      const base = sizes.base.get(f.old_path ?? f.path) ?? 0,
        head = sizes.head.get(f.path) ?? 0;
      return { f, size: base + head, large: Math.max(base, head) > LARGE };
    })
    .sort((a, b) => a.size - b.size || compareUtf8(a.f.path, b.f.path));
  const kept = { base: new Set<string>(), head: new Set<string>() };
  let size = 0;
  for (const { f, size: bytes, large } of files)
    if (!large && size + bytes <= budget) {
      size += bytes;
      kept.base.add(f.old_path ?? f.path);
      kept.head.add(f.path);
    } else {
      result.omitted.files++;
      result.omitted.bytes += bytes;
    }
  for (const version of ["base", "head"] as const)
    for (const [path, text] of await textsOf(snapshot[version], kept[version]))
      result[version][path] = text;
  return result;
}
let holder: Promise<void> = Promise.resolve();
/**
 * Runs `work` as the isolate's one holder of a change's text. Concurrent
 * reviews share an isolate and its memory, so two whole changes are never held
 * at once; the wait is bounded, and a holder that stalls delays the next
 * instead of ending it.
 */
export async function holding<T>(work: () => Promise<T>): Promise<T> {
  const before = holder;
  let release!: () => void;
  holder = new Promise<void>((resolve) => (release = resolve));
  let timer: ReturnType<typeof setTimeout> | null = null;
  await Promise.race([
    before,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, HOLD_WAIT_MS);
    }),
  ]);
  clearTimeout(timer);
  try {
    return await work();
  } finally {
    release();
  }
}
/**
 * A text reader over both trees for paths read in the given order: it fetches
 * a window of them at a time, in batches, and holds one window per version.
 * Any other path is read when asked for.
 */
export function prefetched(
  snapshot: SnapshotReader,
  paths: { base: Iterable<string>; head: Iterable<string> },
  window = WINDOW_BYTES,
): (version: Version, path: string) => Promise<string | null> {
  const state = (list: Iterable<string>) => {
    const order = [...new Set(list)];
    return {
      order,
      index: new Map(order.map((path, i) => [path, i])),
      held: new Map<string, string | null>(),
    };
  };
  const states = { base: state(paths.base), head: state(paths.head) };
  return async (version, path) => {
    const s = states[version],
      tree = snapshot[version];
    const held = s.held.get(path);
    if (held !== undefined) return held;
    const start = s.index.get(path);
    if (start === undefined) return textOf(tree, path);
    const wanted: string[] = [];
    let size = 0;
    for (let i = start; i < s.order.length; i++) {
      const entry = await tree.stat(s.order[i]);
      const bytes = entry && entry.mode !== SYMLINK ? entry.size : 0;
      if (i > start && size + bytes > window) break;
      size += bytes;
      wanted.push(s.order[i]);
    }
    s.held = await textsOf(tree, wanted);
    return s.held.get(path) ?? null;
  };
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
  // The scan holding a batch; see `hold`.
  private turn: Promise<void> = Promise.resolve();
  private constructor(
    readonly env: Env,
    readonly prefix: string,
    readonly index: ManifestIndex,
    // Counts R2 reads of packs, for tests and budgeting.
    readonly reads: string[] = [],
    // Pack bytes those scans fetched.
    readonly fetched = { bytes: 0 },
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
  /**
   * One scan batch at a time per snapshot: a review's voters search the tree
   * concurrently, and each holding its own batch multiplied the memory. The
   * wait is bounded, so a stalled scan delays the others instead of ending them.
   */
  private async hold(): Promise<() => void> {
    const before = this.turn;
    let release!: () => void;
    this.turn = new Promise<void>((resolve) => (release = resolve));
    let timer: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
      before,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SCAN_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    return release;
  }
  private async *batches(
    version: Version,
    keep: (entry: Entry) => boolean,
  ): AsyncGenerator<Scanned[]> {
    let batch: Entry[] = [],
      size = 0;
    let release: (() => void) | undefined;
    const flush = async (): Promise<Scanned[]> => {
      release = await this.hold();
      const bytes = await this.packed(batch);
      const out = batch.map((entry): Scanned => [
        entry,
        entry.size > LARGE ? null : (bytes.get(entry) ?? new Uint8Array()),
      ]);
      batch = [];
      size = 0;
      return out;
    };
    // The consumer is done with a batch when it asks for the next one.
    const done = () => {
      release?.();
      release = undefined;
    };
    try {
      for await (const entry of this.list(version)) {
        if (!keep(entry)) continue;
        batch.push(entry);
        size += entry.size > LARGE ? 0 : entry.size;
        if (batch.length >= BATCH_ENTRIES || size >= BATCH_BYTES) {
          yield await flush();
          done();
        }
      }
      if (batch.length) yield await flush();
    } finally {
      done();
    }
  }
  /**
   * The batch's contents by entry. Each pack is read in runs of entries at most
   * `GAP` apart and `RUN` long, a few at a time, so a filter that keeps the
   * first and last file of a pack reads those two and not the pack between them. A run that
   * is mostly gaps is copied out of its buffer: a view would retain the gaps
   * for as long as the batch lives.
   */
  private async packed(batch: Entry[]): Promise<Map<Entry, Uint8Array>> {
    const groups = new Map<string, Entry[]>();
    for (const entry of batch)
      if (entry.size > 0 && entry.size <= LARGE) {
        const group = groups.get(entry.pack);
        if (group) group.push(entry);
        else groups.set(entry.pack, [entry]);
      }
    const runs: { pack: string; start: number; end: number; entries: Entry[] }[] =
      [];
    for (const [pack, entries] of groups) {
      entries.sort((a, b) => a.offset - b.offset);
      let run: (typeof runs)[number] | undefined;
      for (const entry of entries) {
        const end = entry.offset + entry.size;
        if (
          run &&
          entry.offset - run.end <= GAP &&
          Math.max(run.end, end) - run.start <= RUN
        ) {
          run.end = Math.max(run.end, end);
          run.entries.push(entry);
        } else
          runs.push((run = { pack, start: entry.offset, end, entries: [entry] }));
      }
    }
    const result = new Map<Entry, Uint8Array>();
    let next = 0;
    const read = async () => {
      while (next < runs.length) {
        const run = runs[next++];
        this.reads.push(run.pack);
        this.fetched.bytes += run.end - run.start;
        const bytes = new Uint8Array(
          await (
            await this.object(run.pack, {
              offset: run.start,
              length: run.end - run.start,
            })
          ).arrayBuffer(),
        );
        // Identical contents share an offset and count once.
        let kept = 0,
          covered = run.start;
        for (const entry of run.entries) {
          const end = entry.offset + entry.size;
          if (end > covered) kept += end - Math.max(covered, entry.offset);
          covered = Math.max(covered, end);
        }
        const copy = kept * 4 < bytes.length * 3;
        for (const entry of run.entries) {
          const view = bytes.subarray(
            entry.offset - run.start,
            entry.offset - run.start + entry.size,
          );
          result.set(entry, copy ? view.slice() : view);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(READS, runs.length) }, read),
    );
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
      many: async (entries) => {
        const bytes = await this.packed(entries);
        return entries.map((entry) =>
          entry.size > LARGE ? null : (bytes.get(entry) ?? new Uint8Array()),
        );
      },
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
      many: async (entries) =>
        entries.map((e) =>
          e.size > LARGE ? null : MemorySnapshot.bytes(files[e.path]),
        ),
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

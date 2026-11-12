import type { Env, File, Snapshot, Version } from "./types";
import { invariant } from "./validation";
import { requestsOf, type Requests } from "./requests";
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
// A sweep plans its reads over this many entries at a time and holds their
// metadata meanwhile. In path order a tree changes pack with nearly every
// directory, so reads planned over 1,024 entries cost a 320 MiB tree 390
// requests; planned over 16,384 they cost 75.
const SWEEP_ENTRIES = 16384;
// Its first window is short: a consumer that has enough after the first paths
// (a search for a common word) then stops after a few reads.
const SWEEP_FIRST = 2048;
// A sweep reads everything it passes, so it joins contents further apart.
const SWEEP_GAP = 1024 * 1024;
// Streamed reads of a `pour` in flight. A storage read takes about 200 ms
// before its first byte, however short it is, so what a pour costs is its
// reads divided by this; six is what one invocation may have open, and the
// request that pours waits for nothing else meanwhile.
const POURS = 6;
// From this many paths on, entries are found in one pass over the manifest (a
// request per located chunk) instead of a page read per neighbourhood.
const LISTED_PATHS = 32;
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
   * Kept entries with their bytes, for a consumer that reads most of the tree
   * and needs no order: each pack is read in a few long runs, so a whole tree
   * costs tens of storage requests where `batches` costs hundreds. The tree is
   * taken a window of entries at a time; windows follow path order, the
   * entries inside one follow storage order. `keep` is asked again just before
   * an entry is read, so a consumer that has enough can narrow it and the
   * reads it no longer needs are not made.
   */
  sweep(keep: (entry: Entry) => boolean): AsyncIterable<Scanned[]>;
  /**
   * The contents of the entries, in their order, with a few reads per pack;
   * null for a large content. The caller bounds the entries it asks for.
   */
  many(entries: Entry[]): Promise<(Uint8Array | null)[]>;
}
export type Scanned = [Entry, Uint8Array | null];
// One ranged read of a pack and the entries it covers, in offset order.
interface Run {
  pack: string;
  start: number;
  end: number;
  entries: Entry[];
}
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
  /** The request budget its reads count against, when it has one. */
  requests?: Requests;
}
/** The entries of the paths that exist, by path. */
export async function entriesOf(
  tree: TreeReader,
  paths: Iterable<string>,
): Promise<Map<string, Entry>> {
  const wanted = [...new Set(paths)].sort(compareUtf8);
  const found = new Map<string, Entry>();
  if (wanted.length < LISTED_PATHS) {
    // In path order a manifest page is read once.
    for (const path of wanted) {
      const entry = await tree.stat(path);
      if (entry) found.set(path, entry);
    }
    return found;
  }
  const set = new Set(wanted),
    last = wanted[wanted.length - 1];
  for await (const entry of tree.list()) {
    if (set.has(entry.path)) found.set(entry.path, entry);
    if (found.size === set.size || compareUtf8(entry.path, last) >= 0) break;
  }
  return found;
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
 * change of thousands of files costs tens of storage requests, the manifest
 * included. Paths that are missing, binary or links map to null. The caller
 * bounds what it asks for.
 */
export async function textsOf(
  tree: TreeReader,
  paths: Iterable<string>,
): Promise<Map<string, string | null>> {
  const texts = new Map<string, string | null>();
  for (const path of paths) texts.set(path, null);
  // In storage order a group's files are neighbours in their packs, so a
  // group is a few long reads; in path order every group touched every pack.
  const entries = [...(await entriesOf(tree, texts.keys())).values()]
    .filter((entry) => entry.mode !== SYMLINK)
    .sort((a, b) =>
      a.pack === b.pack ? a.offset - b.offset : a.pack < b.pack ? -1 : 1,
    );
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
 * or in neither, so an unread file never looks added or deleted. Records that
 * share a path (a rename and the file that took its old name) are read or
 * left out together, for the same reason. What is left out is counted, for
 * the report to say so.
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
    const entries = await entriesOf(snapshot[version], paths);
    for (const path of [...new Set(paths)].sort(compareUtf8)) {
      result[version][path] = null;
      const entry = entries.get(path);
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
  const kept = { base: new Set<string>(), head: new Set<string>() },
    left = { base: new Set<string>(), head: new Set<string>() };
  const omit = ({ f, size }: (typeof files)[number]) => {
    left.base.add(f.old_path ?? f.path);
    left.head.add(f.path);
    result.omitted.files++;
    result.omitted.bytes += size;
  };
  let held: typeof files = [],
    size = 0;
  for (const file of files)
    if (!file.large && size + file.size <= budget) {
      size += file.size;
      held.push(file);
    } else omit(file);
  // A path one record left unread is unread for every record: read for
  // another, it would show the first as a deletion or an addition.
  for (let settled = false; !settled;) {
    settled = true;
    held = held.filter((file) => {
      if (
        !left.base.has(file.f.old_path ?? file.f.path) &&
        !left.head.has(file.f.path)
      )
        return true;
      omit(file);
      settled = false;
      return false;
    });
  }
  for (const { f } of held) {
    kept.base.add(f.old_path ?? f.path);
    kept.head.add(f.path);
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
  /** The budget of the environment this snapshot reads through, if it has one. */
  get requests(): Requests | undefined {
    return requestsOf(this.env);
  }
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
      let ended = false;
      try {
        for await (const line of splitLines(object.body))
          if (line) yield entryOf(JSON.parse(line) as Located);
        ended = true;
      } finally {
        // A consumer that has what it wanted leaves the rest unread; an open
        // body would keep one of the invocation's few connections.
        if (!ended) await object.body.cancel().catch(() => {});
      }
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
  private async *sweep(
    version: Version,
    keep: (entry: Entry) => boolean,
  ): AsyncGenerator<Scanned[]> {
    let release: (() => void) | undefined;
    // The consumer is done with a batch when it asks for the next one.
    const done = () => {
      release?.();
      release = undefined;
    };
    // A manifest names an entry's pack in full on every line; a window keeps
    // one string per pack.
    const packs = new Map<string, string>();
    const read = async (part: { runs: Run[]; rest: Entry[] }) => {
      const runs: Run[] = [];
      for (const run of part.runs) {
        const entries = run.entries.filter(keep);
        if (entries.length)
          runs.push({
            pack: run.pack,
            start: entries[0].offset,
            end: entries.reduce((n, e) => Math.max(n, e.offset + e.size), 0),
            entries,
          });
      }
      const out: Scanned[] = part.rest
        .filter(keep)
        .map((entry) => [entry, entry.size > LARGE ? null : new Uint8Array()]);
      if (runs.length) {
        release = await this.hold();
        const bytes = await this.load(runs);
        for (const run of runs)
          for (const entry of run.entries) out.push([entry, bytes.get(entry)!]);
      }
      return out;
    };
    // A window's runs in batches of a few MiB, then what needs no pack read.
    const parts = (window: Entry[]) => {
      const out: { runs: Run[]; rest: Entry[] }[] = [];
      let part: Run[] = [],
        size = 0;
      for (const run of this.runs(window, SWEEP_GAP)) {
        // A part is held at once: at most one run's length.
        if (part.length && size + run.end - run.start > RUN) {
          out.push({ runs: part, rest: [] });
          part = [];
          size = 0;
        }
        part.push(run);
        size += run.end - run.start;
      }
      const rest = window.filter((e) => e.size === 0 || e.size > LARGE);
      if (part.length || rest.length) out.push({ runs: part, rest });
      return out;
    };
    let window: Entry[] = [],
      length = SWEEP_FIRST;
    try {
      for await (const entry of this.list(version)) {
        if (!keep(entry)) continue;
        const pack = packs.get(entry.pack);
        if (pack === undefined) packs.set(entry.pack, entry.pack);
        else entry.pack = pack;
        window.push(entry);
        if (window.length < length) continue;
        for (const part of parts(window)) {
          const batch = await read(part);
          if (batch.length) yield batch;
          done();
        }
        window = [];
        length = SWEEP_ENTRIES;
      }
      for (const part of parts(window)) {
        const batch = await read(part);
        if (batch.length) yield batch;
        done();
      }
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
  private packed(batch: Entry[]): Promise<Map<Entry, Uint8Array>> {
    return this.load(this.runs(batch, GAP));
  }
  // Runs that are held are bounded and leave large contents out; streamed
  // runs are neither.
  private runs(batch: Entry[], gap: number, length = RUN): Run[] {
    const groups = new Map<string, Entry[]>();
    for (const entry of batch)
      if (entry.size > 0 && entry.size <= Math.max(LARGE, length)) {
        const group = groups.get(entry.pack);
        if (group) group.push(entry);
        else groups.set(entry.pack, [entry]);
      }
    const runs: Run[] = [];
    for (const [pack, entries] of groups) {
      entries.sort((a, b) => a.offset - b.offset);
      let run: Run | undefined;
      for (const entry of entries) {
        const end = entry.offset + entry.size;
        if (
          run &&
          entry.offset - run.end <= gap &&
          Math.max(run.end, end) - run.start <= length
        ) {
          run.end = Math.max(run.end, end);
          run.entries.push(entry);
        } else
          runs.push((run = { pack, start: entry.offset, end, entries: [entry] }));
      }
    }
    return runs;
  }
  private async load(runs: Run[]): Promise<Map<Entry, Uint8Array>> {
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
  /**
   * Feeds the contents of entries of both versions to `visit` in pieces and
   * keeps none of them, for a consumer that wants a fact about many files
   * (their line counts) and not the files. Each pack is read in a few
   * streamed runs, several at a time, and a content the versions share is
   * read once. Pieces of one entry come in order; entries come in storage's
   * order, and an empty content gets no piece.
   */
  async pour(
    entries: Record<Version, Entry[]>,
    visit: (version: Version, entry: Entry, piece: Uint8Array) => void,
  ): Promise<void> {
    // Both versions lie in the same packs; an unchanged file is the same
    // bytes of the same pack in both.
    const versions = new Map<Entry, Version>();
    for (const version of ["base", "head"] as const)
      for (const entry of entries[version]) versions.set(entry, version);
    const runs = this.runs([...versions.keys()], SWEEP_GAP, Infinity);
    let next = 0;
    const read = async () => {
      while (next < runs.length) {
        const run = runs[next++];
        this.reads.push(run.pack);
        this.fetched.bytes += run.end - run.start;
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
          reader = (
            await this.object(run.pack, {
              offset: run.start,
              length: run.end - run.start,
            })
          ).body.getReader();
          // `at` is the pack offset of the piece; entries before `first`
          // have ended.
          let at = run.start,
            first = 0;
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            const end = at + value.length;
            for (
              let i = first;
              i < run.entries.length && run.entries[i].offset < end;
              i++
            ) {
              const entry = run.entries[i],
                last = entry.offset + entry.size;
              if (last > at)
                visit(
                  versions.get(entry)!,
                  entry,
                  value.subarray(
                    Math.max(entry.offset, at) - at,
                    Math.min(last, end) - at,
                  ),
                );
            }
            while (
              first < run.entries.length &&
              run.entries[first].offset + run.entries[first].size <= end
            )
              first++;
            at = end;
          }
          invariant(at === run.end, "snapshot content missing");
        } catch (error) {
          // The other reads end with their current run, whether storage
          // refused this one or its content came short.
          next = runs.length;
          await reader?.cancel().catch(() => {});
          throw error;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(POURS, runs.length) }, read),
    );
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
      sweep: (keep) => this.sweep(version, keep),
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
    const batches = async function* (keep: (entry: Entry) => boolean) {
      for (const e of sorted())
        if (keep(e))
          yield [
            [e, e.size > LARGE ? null : MemorySnapshot.bytes(files[e.path])],
          ] as Scanned[];
    };
    return {
      stat: async (path) => entry(path),
      read: async (e) => MemorySnapshot.bytes(files[e.path]),
      stream: async (e) =>
        new Blob([MemorySnapshot.bytes(files[e.path])]).stream(),
      list: async function* () {
        yield* sorted();
      },
      batches,
      sweep: batches,
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
/**
 * Line counts of the regular files among each version's `paths`, as
 * `split("\n").length` counts them. Both versions are counted in one pass:
 * what a submission waits for is the number of storage reads, and a change
 * leaves most of the files its graphs name the same in both.
 */
export async function lineCounts(
  snapshot: StoredSnapshot,
  paths: Record<Version, Set<string>>,
): Promise<Record<Version, Map<string, number>>> {
  const counts = {
    base: new Map<string, number>(),
    head: new Map<string, number>(),
  };
  const entries: Record<Version, Entry[]> = { base: [], head: [] };
  // A manifest names an entry's pack in full on every line; one string per
  // pack is kept.
  const packs = new Map<string, string>();
  await Promise.all(
    (["base", "head"] as const).map(async (version) => {
      const wanted = paths[version];
      let left = wanted.size;
      if (!left) return;
      // One pass over the manifest, ended at the last path wanted.
      for await (const entry of snapshot[version].list()) {
        if (!wanted.has(entry.path)) continue;
        if (entry.mode !== SYMLINK) {
          const pack = packs.get(entry.pack);
          if (pack === undefined) packs.set(entry.pack, entry.pack);
          else entry.pack = pack;
          entries[version].push(entry);
          counts[version].set(entry.path, 1);
        }
        if (!--left) break;
      }
    }),
  );
  await snapshot.pour(entries, (version, entry, piece) => {
    let n = counts[version].get(entry.path)!;
    for (let at = piece.indexOf(10); at !== -1; at = piece.indexOf(10, at + 1))
      n++;
    counts[version].set(entry.path, n);
  });
  return counts;
}

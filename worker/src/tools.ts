import picomatch from "picomatch";
import { agents } from "./manifests";
import { scrub, redact } from "./redaction";
import type {
  ExecutionResult,
  Graph,
  GraphEdge,
  GraphNode,
  Guidance,
  Snapshot,
  Version,
} from "./types";
import { invariant, safePath } from "./validation";
import {
  LARGE,
  SYMLINK,
  decodeText,
  readerOf,
  splitLines,
  type Entry,
  type SnapshotReader,
} from "./snapshot";
export const OUTPUT_LIMIT = 24000;
/** The readable entry for a path; never follows links, even intermediate ones. */
async function readable(
  snapshot: Snapshot | SnapshotReader,
  path: string,
  version: Version,
): Promise<Entry> {
  safePath(path);
  invariant(version === "base" || version === "head", "invalid version");
  const reader = readerOf(snapshot);
  const tree = reader[version];
  const parts = path.split("/");
  let entry: Entry | null = null;
  for (let i = 1; i <= parts.length; i++) {
    entry = await tree.stat(parts.slice(0, i).join("/"));
    invariant(entry?.mode !== SYMLINK, "symlink access denied");
  }
  if (!entry) {
    // An added or deleted file is the usual cause; say where the path does exist.
    const other = version === "head" ? "base" : "head";
    throw new Error(
      `${JSON.stringify(path)} is not a file in the ${version} snapshot${
        (await reader[other].stat(path))
          ? `; it exists in the ${other} snapshot`
          : "; check the path, or find it with search"
      }`,
    );
  }
  return entry;
}
/** Tool arguments as an object; a model may send none. */
function argsOf(args: unknown): Record<string, any> {
  return args !== null && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, any>)
    : {};
}
const given = (value: unknown) => value !== undefined && value !== null;
/** Refuses arguments a tool does not take, so that none is silently ignored. */
function onlyArgs(tool: string, args: Record<string, any>, names: string[]) {
  const unknown = Object.keys(args).filter((key) => !names.includes(key));
  invariant(
    unknown.length === 0,
    `${tool} does not take ${unknown
      .slice(0, 5)
      .map((key) => JSON.stringify(key.slice(0, 40)))
      .join(", ")}; its arguments are ${names.join(", ")}`,
  );
}
function versionOf(tool: string, value: unknown, fallback?: Version): Version {
  if (!given(value) && fallback) return fallback;
  invariant(
    value === "base" || value === "head",
    `${tool} needs "version": "base" or "head"`,
  );
  return value;
}
/**
 * The files a search scope covers. A scope is a glob over repository paths, read
 * the way ripgrep reads one: a file or directory path also covers what is under
 * it, and a pattern without a slash (`*.ts`) matches at any depth. It only ever
 * selects among snapshot entries; it is never a filesystem path.
 */
function scopeMatcher(scope: string): (path: string) => boolean {
  const plain = scope.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
  if (plain === "" || plain === ".") return () => true;
  const glob = picomatch(
    plain.includes("/")
      ? [plain, `${plain}/**`]
      : [`**/${plain}`, `**/${plain}/**`],
    { dot: true },
  );
  // A path is also matched as written, since names such as `app/[id]` are globs too.
  return (path) => path === plain || path.startsWith(`${plain}/`) || glob(path);
}
const REGEX_SYNTAX = /\\[.()\[\]wsdbSWDB]|\.[*+]|\[\^|\(\?[:=!]|[^|\s]\|[^|\s]/;
export async function readFile(
  snapshot: Snapshot | SnapshotReader,
  path: string,
  version: Version,
): Promise<string> {
  const entry = await readable(snapshot, path, version);
  const text = decodeText(await readerOf(snapshot)[version].read(entry));
  invariant(text !== null, "binary file cannot be read as text");
  return text;
}
/** Lines of a large file, streamed; null when it is not text. */
async function largeLines(
  tree: SnapshotReader[Version],
  entry: Entry,
  keep: (line: string, index: number) => boolean | "stop",
): Promise<string[] | null> {
  const lines: string[] = [];
  let index = 0;
  try {
    for await (const line of splitLines(await tree.stream(entry))) {
      const verdict = keep(line, index++);
      if (verdict === "stop") break;
      if (verdict) lines.push(line);
    }
  } catch {
    return null;
  }
  return lines;
}
export function runAllowed(
  agent: string,
  fork: boolean,
  override?: boolean,
): boolean {
  return !fork && (override ?? agents[agent]?.run === true);
}
export function scopedGuidance(
  guidance: Guidance[],
  focus: string[],
): Guidance[] {
  return guidance
    .filter((g) =>
      focus.some((p) => !g.scope_dir || p.startsWith(`${g.scope_dir}/`)),
    )
    .sort((a, b) => a.path.localeCompare(b.path));
}
const injection =
  /(?:ignore\s+(?:all\s+)?(?:previous|prior)|system\s*(?:prompt|message|:)|developer\s*(?:message|:)|(?:enable|disable)\s+(?:tools?|suppressions?|publication)|(?:reveal|print|exfiltrate)\s+(?:secrets?|tokens?|credentials)|<\/?(?:system|assistant|developer))/i;
export function filteredLines(
  lines: string[],
): { line: number; text: string }[] {
  return lines.map((text, i) => ({
    line: i + 1,
    text: injection.test(text) ? "[injection-pattern line removed]" : text,
  }));
}
export function dataBlock(label: string, data: unknown): string {
  return `<repository_data label=${JSON.stringify(label)}>\n${JSON.stringify(scrub(data)).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")}\n</repository_data>`;
}
/** Bytes of graph excerpt in an agent prompt; the complete graph stays behind graph_query. */
export const PROMPT_GRAPH_BYTES = 16 * 1024;
type Edge = GraphEdge & { confidence?: string };
type Sided = Partial<Record<Version, GraphNode>>;
interface GraphIndex {
  byId: Map<string, GraphNode>;
  into: Map<string, Edge[]>;
  out: Map<string, Edge[]>;
}
const indexes = new WeakMap<Graph, GraphIndex>();
function indexOf(graph: Graph): GraphIndex {
  let index = indexes.get(graph);
  if (!index) {
    index = {
      byId: new Map(graph.nodes.map((n) => [n.id, n] as const)),
      into: new Map(),
      out: new Map(),
    };
    const add = (map: Map<string, Edge[]>, id: string, edge: Edge) => {
      const list = map.get(id);
      if (list) list.push(edge);
      else map.set(id, [edge]);
    };
    for (const edge of graph.edges) {
      add(index.into, edge.to, edge);
      add(index.out, edge.from, edge);
    }
    indexes.set(graph, index);
  }
  return index;
}
/** A symbol's identity across versions; node ids differ between base and head. */
const symbolKey = (n: GraphNode) => `${n.path}\0${n.symbol_path}`;
const lineRange = (n: GraphNode) => `${n.line_start}-${n.line_end}`;
const bytesOf = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;
const CONFIDENCE: Record<string, number> = {
  resolved: 0,
  probable: 1,
  unresolved: 2,
};
const RELATION: Record<string, number> = {
  calls: 0,
  references: 1,
  imports: 2,
  tests: 3,
};
type Direction = "used_by" | "uses";
/** One symbol related to a subject: the best edge between them in the given graphs. */
interface Relation {
  key: string;
  nodes: Sided;
  relation?: string;
  confidence?: string;
  rank: number;
  tier: number;
  /** Position among the relations of the same tier and match in one file. */
  nth: number;
}
/**
 * How much a related symbol tells a reviewer, lower first: code outside the
 * subject's files before code inside them (which the reviewer already has),
 * production code before tests, located references before name-only guesses.
 */
function tierOf(r: Relation, inside: Set<string>): number {
  const node = r.nodes.head ?? r.nodes.base!;
  if (inside.has(node.path)) return 3;
  if (r.relation === "tests" || node.kind === "test") return 2;
  return r.confidence === "unresolved" ? 1 : 0;
}
/** The symbols using (or used by) a subject, best first, merged over the graphs by symbol. */
function related(
  graphs: [Version, Graph][],
  subject: Sided,
  direction: Direction,
  inside: Set<string>,
  skip?: Set<string>,
): Relation[] {
  const found = new Map<string, Relation>();
  for (const [version, graph] of graphs) {
    const node = subject[version];
    if (!node) continue;
    const index = indexOf(graph);
    const edges =
      (direction === "used_by" ? index.into : index.out).get(node.id) ?? [];
    for (const edge of edges) {
      if (edge.kind === "defines") continue;
      const other = index.byId.get(
        direction === "used_by" ? edge.from : edge.to,
      );
      if (!other || other.id === node.id) continue;
      const key = symbolKey(other);
      if (key === symbolKey(node) || skip?.has(key)) continue;
      let r = found.get(key);
      if (!r)
        found.set(
          key,
          (r = { key, nodes: {}, rank: Infinity, tier: 0, nth: 0 }),
        );
      r.nodes[version] ??= other;
      const rank =
        (CONFIDENCE[edge.confidence ?? "probable"] ?? 1) * 10 +
        (RELATION[edge.kind ?? ""] ?? 2);
      if (rank < r.rank) {
        r.rank = rank;
        r.relation = edge.kind;
        r.confidence = edge.confidence;
      }
    }
  }
  const list = [...found.values()];
  for (const r of list) r.tier = tierOf(r, inside);
  const place = (r: Relation) => r.nodes.head ?? r.nodes.base!;
  const text = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const match = (r: Relation) => Math.floor(r.rank / 10);
  const plain = (a: Relation, b: Relation) =>
    a.tier - b.tier ||
    a.rank - b.rank ||
    text(place(a).path, place(b).path) ||
    place(a).line_start - place(b).line_start ||
    text(a.key, b.key);
  list.sort(plain);
  // One relation per file first: a file's second user tells a reviewer less
  // than another file's first.
  const perFile = new Map<string, number>();
  for (const r of list) {
    const file = `${r.tier}\0${match(r)}\0${place(r).path}`;
    r.nth = perFile.get(file) ?? 0;
    perFile.set(file, r.nth + 1);
  }
  return list.sort(
    (a, b) =>
      a.tier - b.tier || match(a) - match(b) || a.nth - b.nth || plain(a, b),
  );
}
/** A related symbol as an agent reads it: where it is, and how it is related. */
export interface GraphUse {
  node_id?: string;
  path: string;
  symbol?: string;
  lines: string;
  relation?: string;
  /**
   * How the graph tied the two together: `resolved` through imports or within
   * one file, by `name` alone, or through an import it left `unresolved`. Not
   * named `confidence`: hypotheses and votes must not carry such a key.
   */
  match?: string;
  /** The one version whose graph holds this relation, when the subject is in both. */
  only_in?: Version;
  used_by?: GraphUse[];
}
export interface GraphSymbol {
  node_id?: string;
  path: string;
  symbol?: string;
  kind?: string;
  /** Line range in the queried version (graph_query). */
  lines?: string;
  /** Line ranges per version (prompt excerpt); a missing one means the symbol is absent there. */
  base?: string;
  head?: string;
  used_by: GraphUse[];
  more_users?: number;
  uses?: GraphUse[];
  more_uses?: number;
}
interface Unit {
  subject: number;
  direction: Direction;
  relation: Relation;
  order: [number, number, number, number];
  parent?: Unit;
  children: Unit[];
}
const byOrder = (a: Unit, b: Unit) =>
  a.order[0] - b.order[0] ||
  a.order[1] - b.order[1] ||
  a.order[2] - b.order[2] ||
  a.order[3] - b.order[3];
/**
 * Renders what uses each subject (and, when asked, what each uses) within a
 * byte budget. The budget is spent by usefulness, not by position in the graph:
 * tier by tier (see `tierOf`), and within a tier one relation per subject in
 * turn, so one widely used symbol cannot crowd out the callers of the others.
 * Users of users follow when `hops` is 2 and room is left.
 */
function relate(o: {
  graphs: [Version, Graph][];
  subjects: Sided[];
  directions: Direction[];
  hops: number;
  maxBytes: number;
  /** Most relations listed, whatever the bytes. */
  maxEntries?: number;
  /** Node ids, which verifier evidence cites; prompts leave them out. */
  ids: boolean;
  /** List subjects that have no relation at all. */
  bare: boolean;
}): { symbols: GraphSymbol[]; unlisted: number; bare: number; cut: boolean } {
  const merged = o.graphs.length > 1;
  const inside = new Set(
    o.subjects.flatMap((s) => Object.values(s).map((n) => n.path)),
  );
  const describe = (nodes: Sided) => {
    const node = nodes.head ?? nodes.base!;
    return {
      ...(o.ids ? { node_id: node.id } : {}),
      path: node.path,
      ...(node.symbol_path ? { symbol: node.symbol_path } : {}),
    };
  };
  const useOf = (unit: Unit): GraphUse => {
    const r = unit.relation,
      node = r.nodes.head ?? r.nodes.base!,
      subject = unit.parent
        ? unit.parent.relation.nodes
        : o.subjects[unit.subject];
    const versions = Object.keys(r.nodes) as Version[];
    return {
      ...describe(r.nodes),
      lines: lineRange(node),
      ...(r.relation ? { relation: r.relation } : {}),
      ...(r.confidence
        ? { match: r.confidence === "probable" ? "name" : r.confidence }
        : {}),
      ...(merged && subject.base && subject.head && versions.length === 1
        ? { only_in: versions[0] }
        : {}),
    };
  };
  const symbolOf = (nodes: Sided): GraphSymbol => {
    const node = nodes.head ?? nodes.base!;
    return {
      ...describe(nodes),
      ...(node.kind ? { kind: node.kind } : {}),
      ...(merged
        ? {
            ...(nodes.base ? { base: lineRange(nodes.base) } : {}),
            ...(nodes.head ? { head: lineRange(nodes.head) } : {}),
          }
        : { lines: lineRange(node) }),
      used_by: [],
      ...(o.directions.includes("uses") ? { uses: [] } : {}),
    };
  };
  // Every direct relation of every subject, ordered for the budget.
  const totals = o.subjects.map(() => ({ used_by: 0, uses: 0 }));
  const direct = o.subjects.map(() => new Set<string>());
  let units: Unit[] = [];
  o.subjects.forEach((subject, index) => {
    for (const direction of o.directions) {
      const list = related(o.graphs, subject, direction, inside);
      totals[index][direction] = list.length;
      const turn = [0, 0, 0, 0];
      for (const relation of list) {
        if (direction === "used_by") direct[index].add(relation.key);
        units.push({
          subject: index,
          direction,
          relation,
          order: [
            relation.tier,
            turn[relation.tier]++,
            index,
            direction === "used_by" ? 0 : 1,
          ],
          children: [],
        });
      }
    }
  });
  units.sort(byOrder);
  // Sizes are counted as the entries are chosen; the rendering is measured again below.
  const COUNTS = 48,
    ENVELOPE = 160;
  let size = ENVELOPE,
    entries = 0,
    cut = false;
  const listed = new Set<number>();
  const chosen: Unit[] = [];
  const take = (candidates: Unit[]) => {
    for (const unit of candidates) {
      if (o.maxEntries !== undefined && entries >= o.maxEntries) {
        cut = true;
        break;
      }
      const cost =
        bytesOf(useOf(unit)) +
        1 +
        (unit.parent && !unit.parent.children.length ? 13 : 0) +
        (listed.has(unit.subject)
          ? 0
          : bytesOf(symbolOf(o.subjects[unit.subject])) + 1 + COUNTS);
      if (size + cost > o.maxBytes) {
        cut = true;
        break;
      }
      size += cost;
      entries++;
      listed.add(unit.subject);
      if (unit.parent) unit.parent.children.push(unit);
      else chosen.push(unit);
    }
  };
  take(units);
  if (o.hops > 1 && !cut) {
    // Users of the users already listed (tests aside), outside the subjects' files.
    const further: Unit[] = [];
    chosen.forEach((parent, at) => {
      if (parent.direction !== "used_by" || parent.relation.tier === 2) return;
      const skip = new Set([
        ...direct[parent.subject],
        ...Object.values(o.subjects[parent.subject]).map(symbolKey),
      ]);
      related(o.graphs, parent.relation.nodes, "used_by", inside, skip)
        .filter((r) => r.tier <= 1)
        .forEach((relation, turn) =>
          further.push({
            subject: parent.subject,
            direction: "used_by",
            relation,
            order: [relation.tier, turn, at, 0],
            parent,
            children: [],
          }),
        );
    });
    take(further.sort(byOrder));
  }
  const bare: number[] = [];
  o.subjects.forEach((subject, index) => {
    if (totals[index].used_by + totals[index].uses > 0) return;
    if (!o.bare) return;
    const cost = bytesOf(symbolOf(subject)) + 1;
    if (size + cost > o.maxBytes) cut = true;
    else {
      size += cost;
      bare.push(index);
    }
  });
  const render = () => {
    const symbols = new Map<number, GraphSymbol>();
    const shown = new Map<number, { used_by: number; uses: number }>();
    const symbol = (index: number) => {
      let s = symbols.get(index);
      if (!s) {
        symbols.set(index, (s = symbolOf(o.subjects[index])));
        shown.set(index, { used_by: 0, uses: 0 });
      }
      return s;
    };
    for (const unit of chosen) {
      const use = useOf(unit);
      if (unit.children.length) use.used_by = unit.children.map(useOf);
      symbol(unit.subject)[unit.direction]!.push(use);
      shown.get(unit.subject)![unit.direction]++;
    }
    for (const index of bare) symbol(index);
    for (const [index, s] of symbols) {
      const more = {
        users: totals[index].used_by - shown.get(index)!.used_by,
        uses: totals[index].uses - shown.get(index)!.uses,
      };
      if (more.users > 0) s.more_users = more.users;
      if (more.uses > 0) s.more_uses = more.uses;
    }
    // Subjects come out in file order, like the diff they belong to.
    return [...symbols.entries()].sort(([a], [b]) => a - b).map(([, s]) => s);
  };
  let symbols = render();
  // The count above is an estimate of the rendering; the bound itself is not.
  while (
    bytesOf(symbols) + ENVELOPE > o.maxBytes &&
    (chosen.length || bare.length)
  ) {
    cut = true;
    const last = chosen.at(-1);
    if (bare.length) bare.pop();
    else if (last?.children.length) last.children.pop();
    else chosen.pop();
    symbols = render();
  }
  const withRelations = o.subjects.filter(
    (_, index) => totals[index].used_by + totals[index].uses > 0,
  ).length;
  const listedWithRelations = new Set(chosen.map((u) => u.subject)).size;
  return {
    symbols,
    unlisted: withRelations - listedWithRelations,
    bare: o.subjects.length - withRelations,
    cut,
  };
}
export interface GraphExcerpt {
  /** Changed symbols that something else uses, with the code that uses them. */
  changed_symbols: GraphSymbol[];
  /** Changed symbols for which the graph found no user; they are not listed. */
  symbols_without_users: number;
  /** Changed symbols with users that did not fit. */
  symbols_not_listed?: number;
  truncated: boolean;
}
/**
 * The part of the impact graph an agent prompt carries: for each changed symbol,
 * the code that uses it, as path, symbol and line range. Both versions are
 * merged by symbol, so a symbol removed at head still shows who used it.
 *
 * Reviewers reach code outside the diff through this list. It carries no node
 * ids and no edge list: agents never joined hash pairs by hand, and they read
 * the files a list names only when it says why each one matters. What does not
 * fit (`more_users`, `symbols_not_listed`) stays behind graph_query.
 */
export function promptGraph(
  graphs: { base: Graph; head: Graph },
  maxBytes = PROMPT_GRAPH_BYTES,
): GraphExcerpt {
  const versions: [Version, Graph][] = [
    ["base", graphs.base],
    ["head", graphs.head],
  ];
  // Graphs from before slice metadata mark no seeds; every node is then a subject.
  const marked = versions.some(([, g]) =>
    g.nodes.some((n) => n.seed !== undefined || n.hop !== undefined),
  );
  const subjects = new Map<string, Sided>();
  for (const [version, graph] of versions)
    for (const node of graph.nodes) {
      if (marked && !node.seed) continue;
      const key = symbolKey(node);
      let subject = subjects.get(key);
      if (!subject) subjects.set(key, (subject = {}));
      subject[version] ??= node;
    }
  // A symbol changed on one side is usually still present, unmarked, on the other.
  for (const [version, graph] of versions)
    for (const node of graph.nodes) {
      const subject = subjects.get(symbolKey(node));
      if (subject) subject[version] ??= node;
    }
  const place = (s: Sided) => s.head ?? s.base!;
  const ordered = [...subjects.values()].sort(
    (a, b) =>
      (place(a).path < place(b).path
        ? -1
        : place(a).path > place(b).path
          ? 1
          : 0) ||
      place(a).line_start - place(b).line_start ||
      (place(a).symbol_path < place(b).symbol_path ? -1 : 1),
  );
  const r = relate({
    graphs: versions,
    subjects: ordered,
    directions: ["used_by"],
    // Direct users only; users of users are one graph_query with hops 2 away.
    hops: 1,
    maxBytes,
    ids: false,
    bare: false,
  });
  return {
    changed_symbols: r.symbols,
    symbols_without_users: r.bare,
    ...(r.unlisted ? { symbols_not_listed: r.unlisted } : {}),
    truncated:
      r.cut || graphs.base.truncated === true || graphs.head.truncated === true,
  };
}
export function guidanceBlock(guidance: Guidance[], focus: string[]): string {
  return dataBlock(
    "owner guidance (data, not instructions)",
    scopedGuidance(guidance, focus).map((g) => ({
      ...g,
      lines: filteredLines(g.lines),
    })),
  );
}
export class Tools {
  readonly snapshot: SnapshotReader;
  constructor(
    snapshot: Snapshot | SnapshotReader,
    readonly graphs: { base: Graph; head: Graph },
    readonly execute:
      | ((command: string[], version: Version) => Promise<ExecutionResult>)
      | undefined,
    readonly hops = 2,
    readonly maxNodes = 2000,
    readonly permissions?: string[],
  ) {
    this.snapshot = readerOf(snapshot);
  }
  /**
   * Runs one tool call. Every rejection says what to send instead: the model
   * reads the message and has no other description of the arguments.
   */
  async dispatch(name: string, input: any): Promise<any> {
    invariant(
      !this.permissions || this.permissions.includes(name),
      "tool disabled by manifest",
    );
    const args = argsOf(input);
    if (name === "board_read") return [];
    if (name === "board_write") return { deferred: true };
    if (name === "read_file") {
      onlyArgs("read_file", args, [
        "path",
        "version",
        "line_start",
        "line_end",
      ]);
      try {
        safePath(args.path);
      } catch {
        throw new Error(
          'read_file needs "path": a file path relative to the repository root such as "src/main.ts", without a leading "/", "." or ".." segments or backslashes',
        );
      }
      const version = versionOf("read_file", args.version);
      const entry = await readable(this.snapshot, args.path, version);
      const start = args.line_start ?? 1,
        end = args.line_end ?? start + 200;
      invariant(
        Number.isInteger(start) &&
          start > 0 &&
          Number.isInteger(end) &&
          end >= start,
        "read_file line_start and line_end must be whole numbers from 1, with line_end not before line_start",
      );
      // A large file is streamed and redacted per line, keeping only the range.
      const lines =
        entry.size > LARGE
          ? (
              await largeLines(this.snapshot[version], entry, (_, i) =>
                i >= end ? "stop" : i >= start - 1,
              )
            )?.map(redact)
          : redact(await readFile(this.snapshot, args.path, version)).split(
              "\n",
            );
      invariant(lines, "binary file cannot be read as text");
      invariant(
        entry.size > LARGE || start <= lines.length,
        `${JSON.stringify(args.path)} has ${lines.length} lines in the ${version} snapshot; line_start ${start} is past its end`,
      );
      return (entry.size > LARGE ? lines : lines.slice(start - 1, end))
        .map((line, i) => `${start + i}: ${line}`)
        .join("\n")
        .slice(0, OUTPUT_LIMIT);
    }
    if (name === "search") {
      onlyArgs("search", args, ["pattern", "version", "scope", "glob"]);
      invariant(
        typeof args.pattern === "string" &&
          args.pattern.length > 0 &&
          args.pattern.length <= 500,
        'search needs "pattern": the text to find, 1 to 500 characters, matched as written (it is not a regular expression)',
      );
      // Reviews mostly search the changed code, so head is the version when none is named; the result states it.
      const version = versionOf("search", args.version, "head");
      // Models name the scope `glob` as often as `scope`; both mean the same argument.
      invariant(
        !given(args.scope) || !given(args.glob) || args.scope === args.glob,
        'search takes "scope" or "glob" (the same argument), not two different values',
      );
      const scoped = given(args.scope) || given(args.glob);
      // Literal search avoids untrusted regex backtracking. Scope is a glob, never a filesystem root.
      const scope = args.scope ?? args.glob ?? "**";
      invariant(
        typeof scope === "string" &&
          scope.length > 0 &&
          scope.length <= 500 &&
          !scope.includes("..") &&
          !scope.startsWith("/"),
        'search "scope" must be a glob or a path relative to the repository root, such as "src/**", "src/auth" or "*.ts", without ".." or a leading "/"',
      );
      const match = scopeMatcher(scope),
        results: any[] = [];
      const tree = this.snapshot[version];
      const answer = (truncated: boolean) => ({
        results,
        truncated,
        version,
        ...(scoped ? { scope } : {}),
        ...(!results.length && REGEX_SYNTAX.test(args.pattern)
          ? {
              note: "pattern is matched as literal text; regular expression syntax is not interpreted",
            }
          : {}),
      });
      let size = 0,
        files = 0,
        truncated = false;
      // Streams the tree in path order and stops at the output limit.
      for await (const batch of tree.batches(
        (e) => e.mode !== SYMLINK && match(e.path),
      )) {
        for (const [entry, bytes] of batch) {
          files++;
          let lines: string[] | null;
          const found: { line: number; text: string }[] = [];
          if (bytes) {
            lines = decodeText(bytes)?.split("\n") ?? null;
            lines?.forEach((text, i) => {
              if (text.includes(args.pattern))
                found.push({ line: i + 1, text });
            });
          } else
            lines = await largeLines(tree, entry, (text, i) => {
              if (text.includes(args.pattern))
                found.push({ line: i + 1, text });
              // Each item exceeds 24 characters, so this already passes the limit.
              return found.length > 1000 ? "stop" : false;
            });
          // Binary files are skipped, as before.
          if (lines === null) continue;
          for (const f of found) {
            const item = {
              path: entry.path,
              line: f.line,
              text: redact(f.text).slice(0, 1000),
            };
            size += JSON.stringify(item).length;
            if (size > OUTPUT_LIMIT) {
              truncated = true;
              break;
            }
            results.push(item);
          }
          if (truncated) return answer(true);
        }
      }
      // An empty result must mean "no match", never "the scope selected nothing".
      invariant(
        files > 0 || !scoped,
        `search scope ${JSON.stringify(scope)} matches no file in the ${version} snapshot; scope is a glob or a path relative to the repository root, such as "src/**", "src/auth" or "*.ts"`,
      );
      return answer(false);
    }
    if (name === "graph_query") {
      onlyArgs("graph_query", args, [
        "path",
        "symbol",
        "node_id",
        "version",
        "hops",
        "max_nodes",
      ]);
      const byPath = given(args.path),
        byId = given(args.node_id);
      invariant(
        byPath !== byId && (!byId || !given(args.symbol)),
        'graph_query needs "path" (a file path, with an optional "symbol" name in that file) or "node_id", not both; it answers with the code that uses that symbol',
      );
      // One hop is the direct users; the host bound stays the ceiling.
      const hops = args.hops ?? Math.min(1, this.hops),
        maxNodes = args.max_nodes ?? this.maxNodes;
      invariant(
        Number.isInteger(hops) &&
          hops >= 0 &&
          hops <= this.hops &&
          Number.isInteger(maxNodes) &&
          maxNodes > 0 &&
          maxNodes <= this.maxNodes,
        `graph bounds exceeded: hops must be a whole number from 0 to ${this.hops} and max_nodes from 1 to ${this.maxNodes}`,
      );
      if (byId) {
        invariant(
          typeof args.node_id === "string" && args.node_id.length <= 200,
          'graph_query "node_id" must be a node id string from an earlier graph result',
        );
        // A node id belongs to one version's graph; without a version it is looked up in head first.
        const version = given(args.version)
          ? versionOf("graph_query", args.version)
          : indexOf(this.graphs.head).byId.has(args.node_id) ||
              !indexOf(this.graphs.base).byId.has(args.node_id)
            ? "head"
            : "base";
        const index = indexOf(this.graphs[version]);
        const other = version === "head" ? "base" : "head";
        invariant(
          index.byId.has(args.node_id),
          `node_id is not in the ${version} graph${
            indexOf(this.graphs[other]).byId.has(args.node_id)
              ? `; it is a ${other} node, send version ${JSON.stringify(other)}`
              : '; query by "path" and "symbol" instead'
          }`,
        );
        // Breadth first, so that the nodes kept under a bound are the nearest ones.
        const order: GraphNode[] = [],
          seen = new Set<string>([args.node_id]);
        let frontier: string[] = [args.node_id],
          beyond = false;
        for (let hop = 0; hop <= hops && frontier.length; hop++) {
          const next: string[] = [];
          for (const id of frontier) {
            if (order.length >= maxNodes) {
              beyond = true;
              break;
            }
            order.push(index.byId.get(id)!);
            for (const edge of [
              ...(index.into.get(id) ?? []),
              ...(index.out.get(id) ?? []),
            ]) {
              const neighbour = edge.from === id ? edge.to : edge.from;
              if (seen.has(neighbour) || !index.byId.has(neighbour)) continue;
              seen.add(neighbour);
              next.push(neighbour);
            }
          }
          frontier = next;
        }
        beyond ||= frontier.length > 0;
        // Each node comes with its edges to the nodes already kept, up to the output limit.
        const nodes: GraphNode[] = [],
          edges: Edge[] = [],
          kept = new Set<string>();
        // Room for the fields around the two lists.
        let size = 256,
          limited = false;
        for (const node of order) {
          const item: GraphNode = {
            id: node.id,
            ...(node.kind === undefined ? {} : { kind: node.kind }),
            path: node.path,
            symbol_path: node.symbol_path,
            line_start: node.line_start,
            line_end: node.line_end,
            ...(node.seed ? { seed: true } : {}),
            ...(node.hop === undefined ? {} : { hop: node.hop }),
          };
          kept.add(node.id);
          const links = [
            ...new Set([
              ...(index.into.get(node.id) ?? []),
              ...(index.out.get(node.id) ?? []),
            ]),
          ]
            .filter((e) => kept.has(e.from) && kept.has(e.to))
            .map((e): Edge => ({
              from: e.from,
              to: e.to,
              ...(e.kind === undefined ? {} : { kind: e.kind }),
              ...(e.confidence === undefined
                ? {}
                : { confidence: e.confidence }),
            }));
          const cost =
            JSON.stringify(item).length +
            1 +
            links.reduce((n, e) => n + JSON.stringify(e).length + 1, 0);
          if (size + cost > OUTPUT_LIMIT) {
            kept.delete(node.id);
            limited = true;
            break;
          }
          size += cost;
          nodes.push(item);
          edges.push(...links);
        }
        return {
          version,
          nodes,
          edges,
          truncated: beyond || limited,
          ...(limited
            ? {
                note: `output limit reached after ${nodes.length} of ${order.length} nodes; query with hops 0 or 1, or by "path" and "symbol"`,
              }
            : {}),
        };
      }
      try {
        safePath(args.path);
      } catch {
        throw new Error(
          'graph_query "path" must be a file path relative to the repository root, such as "src/main.ts"',
        );
      }
      invariant(
        !given(args.symbol) ||
          (typeof args.symbol === "string" &&
            args.symbol.length > 0 &&
            args.symbol.length <= 500),
        'graph_query "symbol" must be a symbol name such as "parse" or "Parser.parse"',
      );
      const version = versionOf("graph_query", args.version, "head");
      const named = (node: GraphNode, symbol: string) =>
        node.symbol_path === symbol ||
        (node as { name?: string }).name === symbol ||
        [".", "::", "#"].some((separator) =>
          node.symbol_path.endsWith(`${separator}${symbol}`),
        );
      const inFile = (v: Version) =>
        this.graphs[v].nodes.filter((n) => n.path === args.path);
      const file = inFile(version);
      const subjects = (
        given(args.symbol) ? file.filter((n) => named(n, args.symbol)) : file
      ).sort((a, b) => a.line_start - b.line_start);
      if (!subjects.length) {
        const other = version === "head" ? "base" : "head";
        const symbols = [
          ...new Set(file.map((n) => n.symbol_path).filter(Boolean)),
        ];
        return {
          version,
          symbols: [],
          truncated: false,
          note: file.length
            ? `no symbol ${JSON.stringify(args.symbol)} at this path in the ${version} graph; its symbols there are ${
                symbols.slice(0, 40).join(", ") || "(the file itself)"
              }${symbols.length > 40 ? ", …" : ""}`
            : `the ${version} graph has no symbol at this path${
                inFile(other).length
                  ? `, the ${other} graph has; send version ${JSON.stringify(other)}`
                  : ""
              }; the graph covers the changed symbols and the code within ${this.hops} hops of them, use search for anything else`,
        };
      }
      const r = relate({
        graphs: [[version, this.graphs[version]]],
        subjects: subjects.map((node) => ({ [version]: node })),
        directions: hops ? ["used_by", "uses"] : [],
        hops,
        maxBytes: OUTPUT_LIMIT,
        maxEntries: maxNodes,
        ids: true,
        bare: true,
      });
      return {
        version,
        // No hop: where the symbols are, without what is around them.
        symbols: hops ? r.symbols : r.symbols.map(({ used_by, ...s }) => s),
        ...(r.unlisted ? { symbols_not_listed: r.unlisted } : {}),
        truncated: r.cut || this.graphs[version].truncated === true,
      };
    }
    if (name === "run") {
      invariant(this.execute, "execution disabled");
      invariant(
        Array.isArray(args.command) &&
          args.command.length > 0 &&
          args.command.length <= 128 &&
          args.command.every(
            (x: any) => typeof x === "string" && x.length <= 16000,
          ) &&
          ["base", "head"].includes(args.version),
        'run needs "command": an argv array of strings such as ["npm","test"], and "version": "base" or "head"',
      );
      return this.execute(args.command, args.version);
    }
    throw new Error(
      `unknown tool ${JSON.stringify(String(name).slice(0, 40))}; the tools are read_file, search, graph_query, run, board_read, board_write`,
    );
  }
}

import type {
  ChangedFile,
  Graph,
  GraphEdge,
  GraphNode,
  Version,
} from "./types";
import { textOf, type SnapshotReader } from "./snapshot";

/**
 * Deterministic inventory of the public contracts a change touches, computed
 * from the changed files and the graph slices before the contracts agent runs.
 * It is data for the agent and the security step, never a finding by itself.
 */
export type ContractKind = "export" | "endpoint" | "table" | "event" | "config";
/** The `contracts/<kind>/…` rule namespace an entry most likely belongs to. */
export type ContractRule =
  | "signature"
  | "route"
  | "schema"
  | "migration"
  | "format"
  | "cli"
  | "env"
  | "config";
export interface Declaration {
  line: number;
  text: string;
}
export interface Consumer {
  path: string;
  symbol_path: string;
  line: number;
  hop: number;
  via: "graph" | "text";
}
export interface ContractEntry {
  kind: ContractKind;
  rule: ContractRule;
  name: string;
  path: string;
  change: "removed" | "changed" | "added";
  base?: Declaration;
  head?: Declaration;
  consumers: { base: Consumer[]; head: Consumer[] };
  /** References the graph could not resolve; listed as limitations. */
  unresolved: Consumer[];
}
/** Changed file contents by version; `null` when absent or binary. */
export interface ChangedContents {
  base: Record<string, string | null>;
  head: Record<string, string | null>;
}

const LANGUAGE: Record<string, "typescript" | "python" | "rust"> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "typescript",
  jsx: "typescript",
  mjs: "typescript",
  cjs: "typescript",
  py: "python",
  rs: "rust",
};
export function languageOf(path: string) {
  return LANGUAGE[path.split(".").at(-1) ?? ""];
}

function signature(lines: string[], index: number): string {
  // A declaration may wrap; keep it until its body, value or terminator starts.
  let text = "";
  for (let i = index; i < Math.min(lines.length, index + 8); i++) {
    text += ` ${lines[i].trim()}`;
    if (/[{;]\s*$|=>|:\s*$|=\s*[^=>]/.test(lines[i])) break;
  }
  return text
    .replace(/\s*\{\s*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/** Exported names with their declarations, per the adapter visibility rules. */
export function exportsOf(
  path: string,
  content: string,
  reachable = true,
): Map<string, Declaration> {
  const lines = content.split("\n"),
    found = new Map<string, Declaration>();
  const add = (name: string, i: number) => {
    if (!found.has(name))
      found.set(name, { line: i + 1, text: signature(lines, i) });
  };
  const language = languageOf(path);
  if (language === "typescript")
    lines.forEach((line, i) => {
      const declared =
        /^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|class|interface|type|const|let|var|enum|namespace)\s+([A-Za-z_$][\w$]*)/.exec(
          line,
        );
      if (declared) return add(declared[1], i);
      if (/^export\s+default\b/.test(line)) return add("default", i);
      const list = /^export\s*(?:type\s*)?\{([^}]*)\}/.exec(line);
      if (list)
        for (const part of list[1].split(",")) {
          const name = part
            .trim()
            .split(/\s+as\s+/)
            .at(-1)
            ?.trim();
          if (name) add(name, i);
        }
    });
  else if (language === "python") {
    const all = new Set<string>();
    const listed = /^__all__\s*(?::[^=]*)?=\s*[[(]([^\])]*)[\])]/m.exec(
      content,
    );
    for (const m of listed?.[1].matchAll(/['"]([A-Za-z_]\w*)['"]/g) ?? [])
      all.add(m[1]);
    lines.forEach((line, i) => {
      const declared =
        /^(?:async\s+def|def|class)\s+([A-Za-z_]\w*)|^([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)/.exec(
          line,
        );
      const name = declared?.[1] ?? declared?.[2];
      if (
        name &&
        name !== "__all__" &&
        (!name.startsWith("_") || all.has(name))
      )
        add(name, i);
    });
  } else if (language === "rust" && reachable)
    lines.forEach((line, i) => {
      // Only unrestricted `pub`; `pub(crate)` and `pub(super)` are not public API.
      const declared =
        /^\s*pub\s+(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?(?:fn|struct|enum|trait|type|const|static|mod|union|macro)\s+([A-Za-z_]\w*)/.exec(
          line,
        );
      if (declared) add(declared[1], i);
    });
  return found;
}

/**
 * Whether a Rust file's `pub` items are reachable from its crate root: the root
 * itself, or every enclosing module declared `pub mod` by its parent.
 */
export async function rustReachable(
  path: string,
  read: (path: string) => Promise<string | null>,
): Promise<boolean> {
  const parts = path.split("/");
  const src = parts.lastIndexOf("src");
  if (src < 0) return false;
  const modules = parts.slice(src + 1);
  const last = modules.length - 1;
  modules[last] = modules[last].replace(/\.rs$/, "");
  if (modules.length === 1 && ["lib", "main"].includes(modules[0])) return true;
  if (modules[last] === "mod") modules.pop();
  const prefix = parts.slice(0, src + 1).join("/");
  for (let depth = 0; depth < modules.length; depth++) {
    const parents =
      depth === 0
        ? [`${prefix}/lib.rs`, `${prefix}/main.rs`]
        : [
            `${prefix}/${modules.slice(0, depth).join("/")}.rs`,
            `${prefix}/${modules.slice(0, depth).join("/")}/mod.rs`,
          ];
    let declared = false;
    for (const parent of parents) {
      const text = await read(parent);
      if (
        text &&
        new RegExp(`^\\s*pub\\s+mod\\s+${modules[depth]}\\s*[;{]`, "m").test(
          text,
        )
      )
        declared = true;
    }
    if (!declared) return false;
  }
  return true;
}

interface Pattern {
  kind: Exclude<ContractKind, "export">;
  rule: ContractRule;
  languages?: string[];
  files?: RegExp;
  regex: RegExp;
  name: (m: RegExpExecArray) => string;
}
const METHOD = (m: string) => m.toUpperCase().replace("ROUTE", "ANY");
const PATTERNS: Pattern[] = [
  {
    kind: "endpoint",
    rule: "route",
    languages: ["typescript"],
    regex:
      /\b(?:app|router|server|api|routes?|hono|fastify)\.(get|post|put|patch|delete|options|head|all)\(\s*(['"`])([^'"`]+)\2/g,
    name: (m) => `${METHOD(m[1])} ${m[3]}`,
  },
  {
    kind: "endpoint",
    rule: "route",
    languages: ["python"],
    regex:
      /@\w+(?:\.\w+)*\.(route|get|post|put|patch|delete|api_route|websocket)\(\s*['"]([^'"]+)['"]/g,
    name: (m) => `${METHOD(m[1])} ${m[2]}`,
  },
  {
    kind: "endpoint",
    rule: "route",
    languages: ["python"],
    regex: /\b(?:re_)?path\(\s*r?['"]([^'"]*)['"]\s*,/g,
    name: (m) => `ANY /${m[1].replace(/^\^?\/?/, "")}`,
  },
  {
    kind: "endpoint",
    rule: "route",
    languages: ["rust"],
    regex: /#\[(get|post|put|patch|delete|head|options)\(\s*"([^"]+)"/g,
    name: (m) => `${METHOD(m[1])} ${m[2]}`,
  },
  {
    kind: "endpoint",
    rule: "route",
    languages: ["rust"],
    regex:
      /\.route\(\s*"([^"]+)"\s*,\s*(?:\w+::)*(get|post|put|patch|delete|any)\s*\(/g,
    name: (m) => `${METHOD(m[2])} ${m[1]}`,
  },
  {
    kind: "table",
    rule: "schema",
    regex:
      /\b(?:CREATE\s+(?:VIRTUAL\s+)?TABLE(?:\s+IF\s+NOT\s+EXISTS)?|ALTER\s+TABLE|DROP\s+TABLE(?:\s+IF\s+EXISTS)?)\s+[`"[]?([A-Za-z_][\w.]*)/gi,
    name: (m) => m[1].toLowerCase(),
  },
  {
    kind: "table",
    rule: "schema",
    languages: ["python"],
    regex: /__tablename__\s*=\s*['"]([\w.]+)['"]/g,
    name: (m) => m[1].toLowerCase(),
  },
  {
    kind: "event",
    rule: "format",
    regex:
      /\b(?:emit|publish|dispatch|send_event|produce|trigger)\(\s*['"`]([\w.:/-]+)['"`]/g,
    name: (m) => m[1],
  },
  {
    kind: "config",
    rule: "env",
    languages: ["typescript"],
    regex:
      /process\.env(?:\.([A-Z_][A-Z0-9_]*)|\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\])/g,
    name: (m) => m[1] ?? m[2],
  },
  {
    kind: "config",
    rule: "env",
    languages: ["python"],
    regex:
      /os\.(?:environ(?:\.get)?\s*[[(]|getenv\()\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
    name: (m) => m[1],
  },
  {
    kind: "config",
    rule: "env",
    languages: ["rust"],
    regex: /env::var(?:_os)?\(\s*"([A-Z_][A-Z0-9_]*)"/g,
    name: (m) => m[1],
  },
  {
    kind: "config",
    rule: "cli",
    languages: ["python"],
    regex: /add_argument\(\s*['"](--?[\w-]+)['"]/g,
    name: (m) => m[1],
  },
  {
    kind: "config",
    rule: "cli",
    languages: ["typescript"],
    regex: /\.option\(\s*['"](-[^'"\s,]*(?:,\s*)?--[\w-]+|--[\w-]+)/g,
    name: (m) => m[1].replace(/^.*(--[\w-]+)$/, "$1"),
  },
  {
    kind: "config",
    rule: "cli",
    languages: ["rust"],
    regex: /#\[arg\([^)]*\blong\s*=\s*"([\w-]+)"/g,
    name: (m) => `--${m[1]}`,
  },
];
const CONFIG_FILE =
  /(?:^|\/)(?:[^/]*\.(?:toml|ya?ml|ini|cfg)|\.env(?:\.[\w-]+)?|[^/]*config[^/]*\.json|config\/[^/]+\.json|package\.json|settings\.json)$/;
const LOCKFILE =
  /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|uv\.lock|poetry\.lock)$/;
const MIGRATION =
  /(?:^|\/)(?:migrations?|migrate|alembic|schema)(?:\/|$)|\.sql$/;

/** Top-level and one-level-nested keys of a configuration file. */
export function configKeys(
  path: string,
  content: string,
): Map<string, Declaration> {
  const keys = new Map<string, Declaration>();
  if (path.endsWith(".json")) {
    try {
      const value = JSON.parse(content);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const lines = content.split("\n");
        const line = (key: string) =>
          Math.max(1, lines.findIndex((l) => l.includes(`"${key}"`)) + 1);
        for (const [key, inner] of Object.entries(value)) {
          keys.set(key, { line: line(key), text: key });
          if (inner && typeof inner === "object" && !Array.isArray(inner))
            for (const child of Object.keys(inner))
              keys.set(`${key}.${child}`, {
                line: line(child),
                text: `${key}.${child}`,
              });
        }
      }
    } catch {
      // Unparseable JSON has no keys to compare.
    }
    return keys;
  }
  let section = "",
    parent = "";
  content.split("\n").forEach((line, i) => {
    const header = /^\s*\[\[?([^\]]+)\]\]?\s*$/.exec(line);
    if (header) {
      section = header[1].trim();
      return;
    }
    const entry = /^(\s*)([A-Za-z_][\w.-]*)\s*[:=]/.exec(line);
    if (!entry || line.trimStart().startsWith("#")) return;
    const nested = entry[1].length > 0 && !path.endsWith(".toml");
    if (!nested) parent = entry[2];
    const key = section
      ? `${section}.${entry[2]}`
      : nested
        ? `${parent}.${entry[2]}`
        : entry[2];
    if (!keys.has(key) && (!nested || entry[1].length <= 4))
      keys.set(key, { line: i + 1, text: line.trim().slice(0, 200) });
  });
  return keys;
}

interface Occurrence extends Declaration {
  kind: Exclude<ContractKind, "export">;
  rule: ContractRule;
}
function occurrences(path: string, content: string): Map<string, Occurrence> {
  const found = new Map<string, Occurrence>(),
    language = languageOf(path);
  const lines = content.split("\n");
  const lineAt = (offset: number) =>
    content.slice(0, offset).split("\n").length;
  for (const p of PATTERNS) {
    if (p.languages && !(language && p.languages.includes(language))) {
      // SQL lives in .sql files as well as in source strings.
      if (!(p.kind === "table" && path.endsWith(".sql"))) continue;
    }
    for (const m of content.matchAll(p.regex)) {
      const name = p.name(m as RegExpExecArray);
      const key = `${p.kind}\0${name}`;
      const line = lineAt(m.index ?? 0);
      if (found.has(key)) continue;
      const rule: ContractRule =
        p.kind === "table" && MIGRATION.test(path) ? "migration" : p.rule;
      found.set(key, {
        kind: p.kind,
        rule,
        line,
        text: lines[line - 1].trim().slice(0, 300),
      });
    }
  }
  return found;
}

/** Graph consumers of a symbol within `hops`, and the unresolved references. */
export function graphConsumers(
  graph: Graph,
  path: string,
  name: string,
  hops: number,
): { consumers: Consumer[]; unresolved: Consumer[]; found: boolean } {
  const targets = graph.nodes.filter(
    (n) =>
      n.path === path &&
      ((n as any).name === name || n.symbol_path.split(".").at(-1) === name),
  );
  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const consumers: Consumer[] = [],
    unresolved: Consumer[] = [];
  const seen = new Set(targets.map((n) => n.id));
  let frontier = [...seen];
  const at = (node: GraphNode, hop: number, via: Consumer["via"]) => ({
    path: node.path,
    symbol_path: node.symbol_path,
    line: node.line_start,
    hop,
    via,
  });
  for (let hop = 1; hop <= Math.max(1, hops) && frontier.length; hop++) {
    const next: string[] = [];
    for (const edge of graph.edges as (GraphEdge & {
      confidence?: string;
    })[]) {
      if (!frontier.includes(edge.to) || edge.kind === "defines") continue;
      const node = byId.get(edge.from);
      if (!node) continue;
      if (edge.confidence === "unresolved") {
        if (
          !unresolved.some(
            (u) => u.path === node.path && u.line === node.line_start,
          )
        )
          unresolved.push(at(node, hop, "graph"));
        continue;
      }
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      next.push(node.id);
      consumers.push(at(node, hop, "graph"));
    }
    frontier = next;
  }
  return { consumers, unresolved, found: targets.length > 0 };
}

export interface InventoryInput {
  changed: ChangedFile[];
  contents: ChangedContents;
  graphs: { base: Graph; head: Graph };
  hops: number;
  /** Reads any file of a version, for Rust module reachability. */
  read: (version: Version, path: string) => Promise<string | null>;
  /** Streams every text file of a version once, for textual consumers. */
  scan?: (version: Version) => AsyncIterable<[string, string]>;
}
const MAX_ENTRIES = 100,
  MAX_CONSUMERS = 10;

export async function inventory(
  input: InventoryInput,
): Promise<ContractEntry[]> {
  const entries: ContractEntry[] = [];
  for (const file of input.changed) {
    const basePath = file.old_path ?? file.path;
    const base = input.contents.base[basePath] ?? null,
      head = input.contents.head[file.path] ?? null;
    const reachable = async (version: Version, path: string) =>
      languageOf(path) !== "rust" ||
      (await rustReachable(path, (p) => input.read(version, p)));
    const before = base
      ? exportsOf(basePath, base, await reachable("base", basePath))
      : new Map();
    const after = head
      ? exportsOf(file.path, head, await reachable("head", file.path))
      : new Map();
    for (const name of new Set([...before.keys(), ...after.keys()])) {
      const b = before.get(name),
        h = after.get(name);
      if (b && h && b.text === h.text) continue;
      entries.push({
        kind: "export",
        rule: "signature",
        name,
        path: h ? file.path : basePath,
        change: !h ? "removed" : !b ? "added" : "changed",
        ...(b ? { base: b } : {}),
        ...(h ? { head: h } : {}),
        consumers: { base: [], head: [] },
        unresolved: [],
      });
    }
    const oldOccurrences = base ? occurrences(basePath, base) : new Map(),
      newOccurrences = head ? occurrences(file.path, head) : new Map();
    for (const key of new Set([
      ...oldOccurrences.keys(),
      ...newOccurrences.keys(),
    ])) {
      const b = oldOccurrences.get(key),
        h = newOccurrences.get(key);
      if (b && h && b.text === h.text) continue;
      const o = (h ?? b)!;
      // A migration file adds statements; every statement in it is a schema change.
      const change = !h
        ? "removed"
        : !b
          ? o.rule === "migration"
            ? "changed"
            : "added"
          : "changed";
      entries.push({
        kind: o.kind,
        rule: o.rule,
        name: key.split("\0")[1],
        path: h ? file.path : basePath,
        change,
        ...(b ? { base: { line: b.line, text: b.text } } : {}),
        ...(h ? { head: { line: h.line, text: h.text } } : {}),
        consumers: { base: [], head: [] },
        unresolved: [],
      });
    }
    if (CONFIG_FILE.test(file.path) && !LOCKFILE.test(file.path)) {
      const oldKeys = base ? configKeys(basePath, base) : new Map(),
        newKeys = head ? configKeys(file.path, head) : new Map();
      for (const key of new Set([...oldKeys.keys(), ...newKeys.keys()])) {
        const b = oldKeys.get(key),
          h = newKeys.get(key);
        // A changed value is configuration, not a contract break; keys are the contract.
        if (b && h) continue;
        entries.push({
          kind: "config",
          rule: "config",
          name: key,
          path: h ? file.path : basePath,
          change: h ? "added" : "removed",
          ...(b ? { base: b } : {}),
          ...(h ? { head: h } : {}),
          consumers: { base: [], head: [] },
          unresolved: [],
        });
      }
    }
  }
  entries.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.kind.localeCompare(b.kind) ||
      a.name.localeCompare(b.name),
  );
  const kept = entries.slice(0, MAX_ENTRIES);
  // Graph consumers for exports; textual consumers when the graph has none.
  const textual: ContractEntry[] = [];
  for (const entry of kept) {
    if (entry.kind === "export") {
      for (const version of ["base", "head"] as const) {
        const producer =
          version === "head"
            ? entry.path
            : (input.changed.find((f) => f.path === entry.path)?.old_path ??
              entry.path);
        if (!entry[version]) continue;
        const result = graphConsumers(
          input.graphs[version],
          producer,
          entry.name,
          input.hops,
        );
        entry.consumers[version] = result.consumers.slice(0, MAX_CONSUMERS);
        for (const u of result.unresolved)
          if (
            !entry.unresolved.some(
              (x) => x.path === u.path && x.line === u.line,
            )
          )
            entry.unresolved.push(u);
      }
      if (!entry.consumers.base.length && !entry.consumers.head.length)
        textual.push(entry);
    } else textual.push(entry);
  }
  if (input.scan && textual.length) {
    for (const version of ["base", "head"] as const) {
      const wanted = textual.filter((e) => e[version] || e.change !== "added");
      if (!wanted.length) continue;
      const needles = wanted.map((e) => ({
        entry: e,
        needle:
          e.kind === "endpoint"
            ? e.name
                .split(" ")
                .slice(1)
                .join(" ")
                .replace(/[:{<].*$/, "")
            : e.name.replace(/^--/, ""),
      }));
      for await (const [path, content] of input.scan(version)) {
        const lines = content.split("\n");
        for (const { entry, needle } of needles) {
          if (path === entry.path || needle.length < 3) continue;
          if (entry.consumers[version].length >= MAX_CONSUMERS) continue;
          // An export is consumed where an import or a same-language reference names it.
          const word =
            entry.kind === "export"
              ? new RegExp(
                  `(?<![\\w$])${needle.replace(/[$]/g, "\\$")}(?![\\w$])`,
                )
              : null;
          const sameLanguage = languageOf(path) === languageOf(entry.path);
          const index = lines.findIndex((l) =>
            word
              ? word.test(l) &&
                (sameLanguage || /\b(?:import|from|use|require)\b/.test(l))
              : l.includes(needle),
          );
          if (index >= 0)
            entry.consumers[version].push({
              path,
              symbol_path: "",
              line: index + 1,
              hop: 1,
              via: "text",
            });
        }
      }
    }
  }
  return kept;
}

/** Node kinds a change touches, for catalog applicability. */
export function touchedKinds(
  entries: ContractEntry[],
  changed: ChangedFile[],
  contents: ChangedContents,
): Set<string> {
  const kinds = new Set<string>(entries.map((e) => e.kind));
  for (const file of changed)
    for (const [version, path] of [
      ["base", file.old_path ?? file.path],
      ["head", file.path],
    ] as const) {
      const content = contents[version][path];
      if (CONFIG_FILE.test(path) || LOCKFILE.test(path)) kinds.add("config");
      if (MIGRATION.test(path) && path.endsWith(".sql")) kinds.add("table");
      if (!content) continue;
      for (const o of occurrences(path, content).values())
        // An env read alone does not make a change a configuration change.
        if (o.rule !== "env") kinds.add(o.kind);
    }
  return kinds;
}

/** Frameworks detected from dependency manifests and changed file types. */
const FRAMEWORKS: [RegExp, string[]][] = [
  [
    /^(?:react|react-dom|vue|svelte|@angular\/core|next|nuxt|solid-js|preact|@sveltejs\/kit)$/,
    ["browser"],
  ],
  [
    /^(?:express|fastify|koa|hono|@nestjs\/core|django|flask|fastapi|starlette|litestar|aiohttp|axum|actix-web|rocket|warp|poem|tide)$/,
    ["server"],
  ],
  [
    /^(?:graphql|@apollo\/server|apollo-server|graphene|strawberry-graphql|ariadne|async-graphql|juniper|type-graphql)$/,
    ["graphql"],
  ],
  [
    /^(?:ws|socket\.io|websockets|tokio-tungstenite|tungstenite|channels|@fastify\/websocket)$/,
    ["websocket"],
  ],
  [
    /^(?:simple-peer|mediasoup|livekit-server-sdk|aiortc|webrtc|str0m|pion)$/,
    ["webrtc"],
  ],
  [
    /^(?:passport|next-auth|@auth\/core|openid-client|oidc-provider|authlib|python-social-auth|social-auth-app-django|oauthlib|oauth2|openidconnect|django-allauth)$/,
    ["oauth"],
  ],
];
export function dependencyNames(path: string, content: string): string[] {
  if (path.endsWith("package.json")) {
    try {
      const value = JSON.parse(content);
      return [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ].flatMap((key) => Object.keys(value?.[key] ?? {}));
    } catch {
      return [];
    }
  }
  const names: string[] = [];
  let section = "";
  for (const line of content.split("\n")) {
    const header = /^\s*\[([^\]]+)\]/.exec(line);
    if (header) {
      section = header[1];
      continue;
    }
    if (path.endsWith(".toml") && !/dependenc/.test(section)) {
      const listed = /^\s*["']([A-Za-z0-9_.-]+)/.exec(line);
      if (listed && /project/.test(section))
        names.push(listed[1].toLowerCase());
      continue;
    }
    const name = /^\s*["']?([A-Za-z0-9_.@/-]+)["']?\s*(?:=|[<>~!]=?|\[|$)/.exec(
      line,
    );
    if (name) names.push(name[1].toLowerCase());
  }
  return names;
}
export const MANIFESTS = [
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
];
export function frameworks(
  manifests: [string, string][],
  changed: ChangedFile[],
): string[] {
  const found = new Set<string>();
  for (const [path, content] of manifests)
    for (const name of dependencyNames(path, content))
      for (const [pattern, labels] of FRAMEWORKS)
        if (pattern.test(name)) labels.forEach((l) => found.add(l));
  if (changed.some((f) => /\.(?:tsx|jsx|vue|svelte|html?)$/.test(f.path)))
    found.add("browser");
  if (changed.some((f) => /\.(?:graphqls?|gql)$/.test(f.path)))
    found.add("graphql");
  return [...found].sort();
}
/** Manifest paths that govern the changed files: the root and every ancestor directory. */
export function manifestPaths(changed: ChangedFile[]): string[] {
  const dirs = new Set<string>([""]);
  for (const f of changed) {
    const parts = f.path.split("/");
    for (let i = 1; i < parts.length; i++)
      dirs.add(parts.slice(0, i).join("/"));
  }
  return [...dirs]
    .sort()
    .slice(0, 50)
    .flatMap((d) => MANIFESTS.map((m) => (d ? `${d}/${m}` : m)));
}

/** Taint sources and sinks named by catalog trace hints, as text patterns. */
export const TRACE_PATTERNS: Record<string, RegExp> = {
  http_request:
    /\breq(?:uest)?\.(?:body|query|params|headers|cookies|args|form|json|data|GET|POST|files)\b|\bc\.req\b|\bctx\.(?:request|params|query)\b|\b(?:Query|Json|Form|Path)<|\bRequest\b/,
  cli_args:
    /process\.argv|sys\.argv|argparse|clap::|env::args|#\[arg|\bParser\b/,
  environment: /process\.env|os\.environ|os\.getenv|env::var|dotenv/,
  file_content: /readFile|read_to_string|\bopen\(|File::open|createReadStream/,
  message:
    /\.on\(\s*['"]message|\bconsume\(|\bsubscribe\(|onmessage|kafka|amqp|\bqueue\b/i,
  database_read:
    /\bSELECT\s|\.find(?:One|Many|ById|First|Unique)?\(|objects\.(?:get|filter)\(|fetch_(?:one|all|optional)\(/,
  session: /\bsession\b|\bcookies?\b|req\.user|current_user|request\.user/i,
  external_response:
    /\bfetch\(|axios|requests\.(?:get|post)|httpx|reqwest|response\.json\(/,
  sql_query:
    /\b(?:query|execute|executemany|raw|prepare)\s*\(|\bSELECT\s.+\bFROM\b|\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b|\bDELETE\s+FROM\b|sqlx::query/i,
  shell_command:
    /child_process|\bexec(?:Sync|File)?\(|\bspawn(?:Sync)?\(|subprocess\.|os\.system|Command::new|\bpopen\(/,
  filesystem_path:
    /readFile|writeFile|createReadStream|createWriteStream|sendFile|\bunlink|fs::|File::(?:open|create)|PathBuf|os\.path|pathlib|send_file/,
  html_output:
    /innerHTML|outerHTML|dangerouslySetInnerHTML|document\.write|v-html|\|\s*safe\b|mark_safe|Markup\(|res\.send\(|HttpResponse\(|Html\(/,
  redirect:
    /\bredirect\(|res\.redirect|Redirect::|location\.(?:href|assign|replace)|HttpResponseRedirect/,
  deserialization:
    /pickle\.loads?|yaml\.(?:load|unsafe_load)\(|unserialize|marshal\.loads|serde_json::from|bincode::deserialize|\beval\(|new Function\(/,
  crypto_operation:
    /\bcrypto\.|createHash|createHmac|createCipher|subtle\.|hashlib|\bhmac\b|bcrypt|argon2|scrypt|\bring::|\bsha[12]\b|\bsha256\b|\bmd5\b|\bAES\b|\bRSA\b|randomBytes|secrets\.token|getrandom|rand::/i,
  authorization_check:
    /authori[sz]|permission|\bis_?admin\b|\brole\b|\bcan\(|\bpolicy\b|\bguard\b|login_required|require_auth|forbidden|\b403\b/i,
  authentication_check:
    /authenticat|\blogin\b|password|passwd|verify_password|credential|\bsign_?in\b/i,
  log_output:
    /console\.(?:log|info|warn|error|debug)|logger\.|logging\.|\blog::|tracing::|\bprintln!|\beprintln!/,
  outbound_request:
    /\bfetch\(|axios|http\.request|https?\.get\(|requests\.(?:get|post|put|delete)|httpx|urllib|reqwest|hyper::Client|ureq::/,
  template_render:
    /render_template|\.render\(|Template\(|handlebars|mustache|jinja|\bejs\b|tera::/i,
  unsafe_memory: /\bunsafe\b|transmute|from_raw_parts|\bctypes\b|allocUnsafe/,
  error_response:
    /\.stack\b|traceback|format_exc|status\(5\d\d\)|status_code\s*=\s*5\d\d|InternalServerError|\bpanic!|\.unwrap\(\)/,
  session_state: /\bsession\b|set_?cookie|cookie\(|res\.cookie|req\.session/i,
  secret_value:
    /secret|api[_-]?key|password|private[_-]?key|\btoken\b|credential/i,
  token_handling:
    /\bjwt\b|jsonwebtoken|\bbearer\b|access_token|refresh_token|id_token|\bjose\b/i,
  dependency_manifest: /^$/,
  file_upload:
    /multer|multipart|\bupload|FileStorage|UploadFile|formidable|busboy/i,
};
const DEPENDENCY_MANIFEST =
  /(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.(?:toml|lock)|pyproject\.toml|requirements[^/]*\.txt|uv\.lock|poetry\.lock)$/;

export interface TaintHit {
  name: string;
  path: string;
  version: Version;
  line: number;
  text: string;
}
/** Lines of the changed files where the named sources and sinks occur, both versions. */
export function taintMap(
  names: Iterable<string>,
  changed: ChangedFile[],
  contents: ChangedContents,
  perName = 12,
): TaintHit[] {
  const hits: TaintHit[] = [];
  for (const name of [...new Set(names)].sort()) {
    const pattern = TRACE_PATTERNS[name];
    if (!pattern) throw new Error(`unknown trace name ${name}`);
    let count = 0;
    for (const file of changed)
      for (const [version, path] of [
        ["base", file.old_path ?? file.path],
        ["head", file.path],
      ] as const) {
        if (name === "dependency_manifest") {
          if (
            DEPENDENCY_MANIFEST.test(path) &&
            contents[version][path] != null &&
            count < perName
          ) {
            hits.push({ name, path, version, line: 1, text: path });
            count++;
          }
          continue;
        }
        const content = contents[version][path];
        if (!content || !languageOf(path)) continue;
        content.split("\n").forEach((text, i) => {
          if (count < perName && pattern.test(text)) {
            hits.push({
              name,
              path,
              version,
              line: i + 1,
              text: text.trim().slice(0, 200),
            });
            count++;
          }
        });
      }
  }
  return hits;
}

/** Changed-file contents for the inventory, read once per version. */
export async function changedContents(
  changed: ChangedFile[],
  snapshot: SnapshotReader,
): Promise<ChangedContents> {
  const contents: ChangedContents = { base: {}, head: {} };
  for (const file of changed)
    for (const [version, path] of [
      ["base", file.old_path ?? file.path],
      ["head", file.path],
    ] as const)
      contents[version][path] = await textOf(snapshot[version], path);
  return contents;
}

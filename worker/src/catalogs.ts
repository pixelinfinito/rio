import embedded from "./catalogs.json";
import { matches } from "./triage";
import {
  TRACE_PATTERNS,
  languageOf,
  taintMap,
  type ChangedContents,
  type TaintHit,
} from "./contracts";
import type { ChangedFile, Graph, Version } from "./types";
import { invariant } from "./validation";

/** Security catalogs shipped as `catalog` modules under modules/catalogs/. */
export const CATALOGS = ["owasp-top10-2025", "asvs-5.0"] as const;
export type CatalogName = (typeof CATALOGS)[number];
type Predicate = Partial<{
  language: string[];
  framework: string[];
  node_kind: string[];
  sensitive_path: true;
  sink: string[];
  always: true;
}>;
export interface CatalogItem {
  id: string;
  title: string;
  summary: string;
  url: string;
  applies_when: { all?: Predicate[]; any?: Predicate[] };
  trace: { sources: string[]; sinks: string[] };
}
export interface Catalog {
  name: string;
  version: string;
  attribution: { source: string; url: string; license: string; notice: string };
  items: CatalogItem[];
}
export const PREDICATES = [
  "language",
  "framework",
  "node_kind",
  "sensitive_path",
  "sink",
  "always",
] as const;

export function catalog(name: string): Catalog {
  invariant(
    (CATALOGS as readonly string[]).includes(name),
    `unknown security catalog ${name}`,
  );
  return (embedded as Record<string, Catalog>)[name];
}

/** What the change touches, as the predicates see it. */
export interface ChangeContext {
  languages: string[];
  frameworks: string[];
  node_kinds: string[];
  sensitive: boolean;
  sinks: string[];
}
function holds(predicate: Predicate, context: ChangeContext): boolean {
  const [name, value] = Object.entries(predicate)[0] ?? [];
  invariant(
    Object.keys(predicate).length === 1 &&
      (PREDICATES as readonly string[]).includes(name),
    `unknown catalog predicate ${name}`,
  );
  const any = (have: string[]) =>
    (value as string[]).some((v) => have.includes(v));
  switch (name) {
    case "language":
      return any(context.languages);
    case "framework":
      return any(context.frameworks);
    case "node_kind":
      return any(context.node_kinds);
    case "sink":
      return any(context.sinks);
    case "sensitive_path":
      return context.sensitive;
    default:
      return true;
  }
}
export function applies(item: CatalogItem, context: ChangeContext): boolean {
  const { all, any } = item.applies_when;
  return (
    (all ?? []).every((p) => holds(p, context)) &&
    (!any || any.some((p) => holds(p, context)))
  );
}
export function applicability(name: string, context: ChangeContext) {
  const items = catalog(name).items;
  return {
    applicable: items.filter((i) => applies(i, context)),
    not_applicable: items.filter((i) => !applies(i, context)),
  };
}

const SINKS = new Set(
  Object.values(embedded as Record<string, Catalog>).flatMap((c) =>
    c.items.flatMap((i) => i.trace.sinks),
  ),
);
export function changeContext(options: {
  changed: ChangedFile[];
  contents: ChangedContents;
  frameworks: string[];
  node_kinds: Iterable<string>;
  sensitive_paths: string[];
}): ChangeContext {
  const paths = options.changed.flatMap((f) =>
    f.old_path ? [f.path, f.old_path] : [f.path],
  );
  return {
    languages: [
      ...new Set(
        paths.map(languageOf).filter((l): l is NonNullable<typeof l> => !!l),
      ),
    ].sort(),
    frameworks: options.frameworks,
    node_kinds: [...new Set(options.node_kinds)].sort(),
    sensitive: options.sensitive_paths.some((glob) =>
      paths.some((path) => matches(glob, path)),
    ),
    sinks: [
      ...new Set(
        taintMap(SINKS, options.changed, options.contents, 1).map(
          (h) => h.name,
        ),
      ),
    ].sort(),
  };
}

/**
 * Inputs for tracing input → validation → authorization → transformation →
 * sensitive operation: where the applicable items' sources and sinks occur in
 * the changed files, and the changed symbols' neighbours in both versions.
 */
export function traceInputs(
  items: CatalogItem[],
  changed: ChangedFile[],
  contents: ChangedContents,
  graphs: { base: Graph; head: Graph },
): {
  taint: TaintHit[];
  neighbours: {
    version: Version;
    symbol: string;
    callers: string[];
    callees: string[];
  }[];
} {
  const names = items.flatMap((i) => [...i.trace.sources, ...i.trace.sinks]);
  const neighbours = [];
  for (const version of ["base", "head"] as const) {
    const graph = graphs[version];
    const label = new Map(
      graph.nodes.map((n) => [
        n.id,
        `${n.path}:${n.line_start} ${n.symbol_path}`,
      ]),
    );
    const changedPaths = new Set(
      changed.map((f) =>
        version === "base" ? (f.old_path ?? f.path) : f.path,
      ),
    );
    for (const node of graph.nodes) {
      if (
        !changedPaths.has(node.path) ||
        node.seed === false ||
        !node.symbol_path
      )
        continue;
      const callers = graph.edges
        .filter((e) => e.to === node.id && e.kind !== "defines")
        .map((e) => label.get(e.from))
        .filter((x): x is string => !!x);
      const callees = graph.edges
        .filter((e) => e.from === node.id && e.kind !== "defines")
        .map((e) => label.get(e.to))
        .filter((x): x is string => !!x);
      if (callers.length || callees.length)
        neighbours.push({
          version,
          symbol: label.get(node.id)!,
          callers: callers.slice(0, 10),
          callees: callees.slice(0, 10),
        });
    }
  }
  return {
    taint: taintMap(names, changed, contents),
    neighbours: neighbours.slice(0, 60),
  };
}

/** Every trace name a catalog may use has a pattern. */
export function unknownTraceNames(): string[] {
  return Object.values(embedded as Record<string, Catalog>)
    .flatMap((c) =>
      c.items.flatMap((i) => [...i.trace.sources, ...i.trace.sinks]),
    )
    .filter((name) => !TRACE_PATTERNS[name]);
}

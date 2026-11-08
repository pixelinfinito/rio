import { describe, expect, it } from "vitest";
import {
  CATALOGS,
  PREDICATES,
  applicability,
  applies,
  catalog,
  changeContext,
  traceInputs,
  unknownTraceNames,
} from "../src/catalogs";
import {
  inventory,
  touchedKinds,
  type ChangedContents,
} from "../src/contracts";
import type { ChangedFile } from "../src/types";

/** Context for a change between two in-memory trees, as the security step builds it. */
async function context(
  base: Record<string, string>,
  head: Record<string, string>,
  options: { frameworks?: string[]; sensitive_paths?: string[] } = {},
) {
  const changed: ChangedFile[] = Object.keys({ ...base, ...head })
    .filter((p) => base[p] !== head[p])
    .map((path) => ({ path }));
  const contents: ChangedContents = { base: {}, head: {} };
  for (const f of changed) {
    contents.base[f.path] = base[f.path] ?? null;
    contents.head[f.path] = head[f.path] ?? null;
  }
  const empty = { nodes: [], edges: [] };
  const entries = await inventory({
    changed,
    contents,
    graphs: { base: empty, head: empty },
    hops: 2,
    read: async () => null,
  });
  return {
    changed,
    contents,
    context: changeContext({
      changed,
      contents,
      frameworks: options.frameworks ?? [],
      node_kinds: touchedKinds(entries, changed, contents),
      sensitive_paths: options.sensitive_paths ?? [],
    }),
  };
}

describe("catalog modules", () => {
  it.each(CATALOGS)(
    "%s loads with unique ids, known predicates and trace names",
    (name) => {
      const c = catalog(name);
      expect(c.name).toBe(`rio/${name}`);
      expect(c.attribution.license).toBe("CC BY-SA 4.0");
      const ids = c.items.map((i) => i.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const item of c.items) {
        expect(item.summary.length).toBeGreaterThan(40);
        for (const predicate of [
          ...(item.applies_when.all ?? []),
          ...(item.applies_when.any ?? []),
        ])
          expect(PREDICATES).toContain(Object.keys(predicate)[0]);
      }
      expect(unknownTraceNames()).toEqual([]);
    },
  );

  it("rejects an unknown catalog and an unknown predicate", () => {
    expect(() => catalog("internal")).toThrow(/unknown security catalog/);
    const item = {
      ...catalog("asvs-5.0").items[0],
      applies_when: { any: [{ runtime: ["node"] } as any] },
    };
    expect(() =>
      applies(item, {
        languages: [],
        frameworks: [],
        node_kinds: [],
        sensitive: false,
        sinks: [],
      }),
    ).toThrow(/unknown catalog predicate/);
  });
});

describe("applicability", () => {
  const browserOnly = ["V3.6", "V3.7", "V14.3"];
  it("filters browser-only and endpoint items out of a Rust CLI change", async () => {
    const { context: ctx } = await context(
      {
        "src/main.rs": `fn main() {\n    let args = Args::parse();\n    run(&args.path);\n}\n`,
      },
      {
        "src/main.rs": `fn main() {\n    let args = Args::parse();\n    run(&args.path, args.force);\n}\n`,
      },
      { frameworks: [] },
    );
    expect(ctx.languages).toEqual(["rust"]);
    expect(ctx.node_kinds).not.toContain("endpoint");
    const asvs = applicability("asvs-5.0", ctx);
    const out = asvs.not_applicable.map((i) => i.id);
    for (const id of [...browserOnly, "V4.1", "V4.2", "V5.4", "V3.4"])
      expect(out).toContain(id);
    // Injection and defensive coding still apply to any code change.
    expect(asvs.applicable.map((i) => i.id)).toEqual(
      expect.arrayContaining(["V1.2", "V15.3", "V16.5"]),
    );
    const owasp = applicability("owasp-top10-2025", ctx);
    expect(owasp.applicable.map((i) => i.id)).toContain("A05:2025");
    expect(owasp.not_applicable.map((i) => i.id)).toContain("A01:2025");
  });

  it("keeps injection items for an endpoint change and gives the agent its taint inputs", async () => {
    const base = {
      "app/views.py": `@app.get("/items")\ndef items(request):\n    q = request.args.get("q")\n    return db.execute("SELECT * FROM items WHERE name = ?", (q,))\n`,
    };
    const head = {
      "app/views.py": `@app.get("/items")\ndef items(request):\n    q = request.args.get("q")\n    return db.execute(f"SELECT * FROM items WHERE name = '{q}'")\n`,
    };
    const {
      context: ctx,
      changed,
      contents,
    } = await context(base, head, {
      frameworks: ["server"],
    });
    expect(ctx.node_kinds).toContain("endpoint");
    expect(ctx.sinks).toContain("sql_query");
    const owasp = applicability("owasp-top10-2025", ctx);
    expect(owasp.applicable.map((i) => i.id)).toEqual(
      expect.arrayContaining(["A01:2025", "A05:2025"]),
    );
    const asvs = applicability("asvs-5.0", ctx);
    expect(asvs.applicable.map((i) => i.id)).toEqual(
      expect.arrayContaining(["V1.2", "V2.2", "V4.1", "V8.3"]),
    );
    for (const id of browserOnly)
      expect(asvs.not_applicable.map((i) => i.id)).toContain(id);
    const inputs = traceInputs(
      owasp.applicable.filter((i) => i.id === "A05:2025"),
      changed,
      contents,
      { base: { nodes: [], edges: [] }, head: { nodes: [], edges: [] } },
    );
    expect(inputs.taint).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "http_request",
          version: "head",
          line: 3,
        }),
        expect.objectContaining({
          name: "sql_query",
          version: "head",
          line: 4,
        }),
        expect.objectContaining({
          name: "sql_query",
          version: "base",
          line: 4,
        }),
      ]),
    );
  });

  it("applies sensitive-path and framework predicates", async () => {
    const files = (v: string) => ({
      "src/auth/login.ts": `export function login(user) { return check(user, ${v}); }\n`,
    });
    const plain = await context(files("1"), files("2"));
    const sensitive = await context(files("1"), files("2"), {
      sensitive_paths: ["src/auth/**"],
      frameworks: ["browser", "oauth"],
    });
    const ids = (ctx: any) =>
      applicability("asvs-5.0", ctx).applicable.map((i) => i.id);
    expect(ids(plain.context)).not.toContain("V6.4");
    expect(ids(sensitive.context)).toEqual(
      expect.arrayContaining(["V6.4", "V3.6", "V10.1"]),
    );
  });
});

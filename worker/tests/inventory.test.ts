import { describe, expect, it } from "vitest";
import {
  inventory,
  touchedKinds,
  type ChangedContents,
  type ContractEntry,
} from "../src/contracts";
import type { Graph, Version } from "../src/types";

type Tree = Record<string, string>;
const empty: Graph = { nodes: [], edges: [] };
/** Inventory over two in-memory trees; changed files are those that differ. */
async function run(
  base: Tree,
  head: Tree,
  graphs: { base: Graph; head: Graph } = { base: empty, head: empty },
  renames: Record<string, string> = {},
) {
  const paths = [...new Set([...Object.keys(base), ...Object.keys(head)])]
    .filter(
      (p) =>
        base[renames[p] ?? p] !== head[p] &&
        !Object.values(renames).includes(p),
    )
    .sort();
  const changed = paths.map((path) =>
    renames[path] ? { path, old_path: renames[path] } : { path },
  );
  const contents: ChangedContents = { base: {}, head: {} };
  for (const f of changed) {
    contents.base[f.old_path ?? f.path] = base[f.old_path ?? f.path] ?? null;
    contents.head[f.path] = head[f.path] ?? null;
  }
  const trees = { base, head };
  const entries = await inventory({
    changed,
    contents,
    graphs,
    hops: 2,
    read: async (version: Version, path: string) =>
      trees[version][path] ?? null,
    scan: async function* (version: Version) {
      for (const [path, content] of Object.entries(trees[version]).sort())
        yield [path, content] as [string, string];
    },
  });
  return { entries, changed, contents };
}
const find = (entries: ContractEntry[], kind: string, name: string) =>
  entries.find((e) => e.kind === kind && e.name === name);
const node = (id: string, path: string, symbol_path: string, line: number) => ({
  id,
  path,
  symbol_path,
  name: symbol_path.split(".").at(-1),
  line_start: line,
  line_end: line + 2,
});

describe("contract inventory: TypeScript", () => {
  const api = `export function fetchUser(id: string): Promise<User> {\n  return get(id);\n}\nexport const VERSION = 1;\nfunction local() {}\n`;
  it("lists a removed export with both consumers at their base locations", async () => {
    const graphs = {
      base: {
        nodes: [
          node("p", "src/api.ts", "api.fetchUser", 1),
          node("a", "src/a.ts", "a.load", 3),
          node("b", "src/b.ts", "b.show", 7),
        ],
        edges: [
          { from: "a", to: "p", kind: "calls", confidence: "resolved" },
          { from: "b", to: "p", kind: "imports", confidence: "resolved" },
        ],
      },
      head: empty,
    };
    const { entries } = await run(
      { "src/api.ts": api },
      {
        "src/api.ts": api.replace(/export function fetchUser[\s\S]*?\n}\n/, ""),
      },
      graphs,
    );
    const entry = find(entries, "export", "fetchUser")!;
    expect(entry).toMatchObject({
      kind: "export",
      rule: "signature",
      change: "removed",
      path: "src/api.ts",
      base: { line: 1 },
    });
    expect(entry.consumers.base).toEqual([
      {
        path: "src/a.ts",
        symbol_path: "a.load",
        line: 3,
        hop: 1,
        via: "graph",
      },
      {
        path: "src/b.ts",
        symbol_path: "b.show",
        line: 7,
        hop: 1,
        via: "graph",
      },
    ]);
    // Unchanged exports and module-private functions are not contracts of this change.
    expect(find(entries, "export", "VERSION")).toBeUndefined();
    expect(find(entries, "export", "local")).toBeUndefined();
  });

  it("lists a changed signature, routes, events, env reads and config keys", async () => {
    const { entries } = await run(
      {
        "src/api.ts": api,
        "src/server.ts": `app.get("/v1/sessions", list);\napp.delete("/v1/sessions/:id", remove);\nbus.emit("user.created", user);\n`,
        "src/client.ts": `await fetch("/v1/sessions/" + id, { method: "DELETE" });\n`,
        "config/app.json": `{"port": 8080, "auth": {"issuer": "x", "audience": "y"}}\n`,
      },
      {
        "src/api.ts": api.replace("id: string)", "id: string, tenant: string)"),
        "src/server.ts": `app.get("/v1/sessions", list);\nbus.emit("user.registered", user);\nconst url = process.env.SESSION_URL;\n`,
        "src/client.ts": `await fetch("/v1/sessions/" + id, { method: "DELETE" });\n`,
        "config/app.json": `{"port": 8080, "auth": {"issuer": "x"}}\n`,
      },
    );
    expect(find(entries, "export", "fetchUser")).toMatchObject({
      change: "changed",
      base: { text: expect.stringContaining("id: string)") },
      head: { text: expect.stringContaining("tenant: string") },
    });
    const route = find(entries, "endpoint", "DELETE /v1/sessions/:id")!;
    expect(route).toMatchObject({ rule: "route", change: "removed" });
    expect(route.consumers.base).toEqual([
      { path: "src/client.ts", symbol_path: "", line: 1, hop: 1, via: "text" },
    ]);
    expect(find(entries, "endpoint", "GET /v1/sessions")).toBeUndefined();
    expect(find(entries, "event", "user.created")).toMatchObject({
      rule: "format",
      change: "removed",
    });
    expect(find(entries, "event", "user.registered")?.change).toBe("added");
    expect(find(entries, "config", "SESSION_URL")).toMatchObject({
      rule: "env",
      change: "added",
    });
    expect(find(entries, "config", "auth.audience")).toMatchObject({
      rule: "config",
      change: "removed",
      path: "config/app.json",
    });
    expect(find(entries, "config", "port")).toBeUndefined();
  });

  it("lists a migration as a table change", async () => {
    const { entries } = await run(
      { "migrations/0001.sql": "CREATE TABLE users (id TEXT);\n" },
      {
        "migrations/0001.sql": "CREATE TABLE users (id TEXT);\n",
        "migrations/0002.sql":
          "ALTER TABLE users ADD COLUMN email TEXT NOT NULL;\n",
      },
    );
    expect(find(entries, "table", "users")).toMatchObject({
      rule: "migration",
      change: "changed",
      path: "migrations/0002.sql",
    });
  });

  it("names a consumer the graph could not resolve", async () => {
    const graphs = {
      base: empty,
      head: {
        nodes: [
          node("p", "src/plugins.ts", "plugins.register", 1),
          node("d", "src/loader.ts", "loader.load", 4),
        ],
        edges: [
          { from: "d", to: "p", kind: "references", confidence: "unresolved" },
        ],
      },
    };
    const { entries } = await run(
      { "src/plugins.ts": "export function register(name: string) {}\n" },
      {
        "src/plugins.ts":
          "export function register(name: string, options: Options) {}\n",
      },
      graphs,
    );
    const entry = find(entries, "export", "register")!;
    expect(entry.unresolved).toEqual([
      {
        path: "src/loader.ts",
        symbol_path: "loader.load",
        line: 4,
        hop: 1,
        via: "graph",
      },
    ]);
    expect(entry.consumers.head).toEqual([]);
  });
});

describe("contract inventory: Python", () => {
  it("skips private helpers unless listed in __all__", async () => {
    const before = `__all__ = ["_exported", "run"]\n\ndef _helper(x):\n    return x\n\ndef _exported(x):\n    return x\n\ndef run(path):\n    pass\n`;
    const after = before
      .replace("def _helper(x)", "def _renamed_helper(x)")
      .replace("def _exported(x)", "def _exported(x, y)")
      .replace("def run(path)", "def run(path, *, strict)");
    const { entries } = await run(
      { "pkg/core.py": before },
      { "pkg/core.py": after },
    );
    expect(
      entries.filter((e) => e.kind === "export").map((e) => [e.name, e.change]),
    ).toEqual([
      ["_exported", "changed"],
      ["run", "changed"],
    ]);
  });

  it("lists routes, env reads, CLI flags and ORM tables", async () => {
    const { entries } = await run(
      {
        "app/views.py": `@app.get("/items/{id}")\ndef item(id):\n    pass\n\nclass Item(Base):\n    __tablename__ = "items"\n`,
        "app/cli.py": `parser.add_argument("--dry-run")\nparser.add_argument("--limit")\n`,
      },
      {
        "app/views.py": `@app.get("/items/{item_id}")\ndef item(item_id):\n    pass\n\nclass Item(Base):\n    __tablename__ = "inventory_items"\n`,
        "app/cli.py": `parser.add_argument("--limit")\nurl = os.environ["DATABASE_URL"]\n`,
      },
    );
    expect(find(entries, "endpoint", "GET /items/{id}")?.change).toBe(
      "removed",
    );
    expect(find(entries, "endpoint", "GET /items/{item_id}")?.change).toBe(
      "added",
    );
    expect(find(entries, "table", "items")).toMatchObject({
      rule: "schema",
      change: "removed",
    });
    expect(find(entries, "config", "--dry-run")).toMatchObject({
      rule: "cli",
      change: "removed",
    });
    expect(find(entries, "config", "--limit")).toBeUndefined();
    expect(find(entries, "config", "DATABASE_URL")).toMatchObject({
      rule: "env",
      change: "added",
    });
  });
});

describe("contract inventory: Rust", () => {
  const lib = `pub mod api;\nmod internal;\n\npub fn parse(input: &str) -> Result<Ast> {\n    todo!()\n}\npub(crate) fn helper() {}\n`;
  it("lists only unrestricted pub items reachable from the crate root", async () => {
    const { entries } = await run(
      {
        "src/lib.rs": lib,
        "src/api.rs": "pub fn serve(port: u16) {}\n",
        "src/internal.rs": "pub fn hidden(a: u8) {}\n",
      },
      {
        "src/lib.rs": lib
          .replace("input: &str)", "input: &str, strict: bool)")
          .replace("helper()", "helper(x: u8)"),
        "src/api.rs": "pub fn serve(addr: SocketAddr) {}\n",
        "src/internal.rs": "pub fn hidden(a: u16) {}\n",
      },
    );
    expect(
      entries.filter((e) => e.kind === "export").map((e) => [e.path, e.name]),
    ).toEqual([
      ["src/api.rs", "serve"],
      ["src/lib.rs", "parse"],
    ]);
  });

  it("lists routes, env reads and clap flags", async () => {
    const { entries } = await run(
      {
        "src/main.rs": `#[get("/health")]\nasync fn health() {}\nlet port = env::var("PORT");\n#[arg(long = "dry-run")]\ndry_run: bool,\n`,
      },
      {
        "src/main.rs": `let app = Router::new().route("/healthz", get(health));\nlet port = env::var("RIO_PORT");\n`,
      },
    );
    expect(find(entries, "endpoint", "GET /health")?.change).toBe("removed");
    expect(find(entries, "endpoint", "GET /healthz")?.change).toBe("added");
    expect(find(entries, "config", "PORT")).toMatchObject({
      rule: "env",
      change: "removed",
    });
    expect(find(entries, "config", "--dry-run")).toMatchObject({
      rule: "cli",
      change: "removed",
    });
  });

  it("does not mark a database module without routes as an endpoint change", async () => {
    const base = {
      "src/db/users.rs": `pub(crate) fn find(conn: &Conn, name: &str) {\n    conn.query("SELECT * FROM users WHERE name = ?", [name]);\n}\n`,
    };
    const head = {
      "src/db/users.rs": base["src/db/users.rs"].replace(
        '= ?", [name]',
        '= \'" + name + "\'"',
      ),
    };
    const { entries, changed, contents } = await run(base, head);
    const kinds = touchedKinds(entries, changed, contents);
    expect(kinds.has("endpoint")).toBe(false);
  });
});

describe("triage public_contracts signal", () => {
  const plan = async (base: string, head: string, path: string) => {
    const { triage } = await import("../src/triage");
    const { submission } = await import("./fixtures");
    const s = submission();
    s.changed = [{ path, lines_changed: 2 }];
    s.profile.steps = [
      { id: "triage", uses: "rio/triage@0.1.0", needs: [], with: {} },
    ];
    return triage(s, {
      base: { [path]: { mode: 0o100644, content: base } },
      head: { [path]: { mode: 0o100644, content: head } },
    });
  };
  it.each([
    [
      "a removed Python CLI flag",
      "slime/arguments.py",
      `def add(parser):\n    parser.add_argument("--router-ip")\n    parser.add_argument("--router-port")\n`,
      `def add(parser):\n    parser.add_argument("--router-port")\n`,
    ],
    [
      "a changed Python export",
      "pkg/api.py",
      "def fetch(url):\n    pass\n",
      "def fetch(url, *, timeout):\n    pass\n",
    ],
    [
      "a removed route",
      "src/server.ts",
      `app.get("/a", a);\napp.delete("/b", b);\n`,
      `app.get("/a", a);\n`,
    ],
  ])("selects the contracts agent for %s", async (_, path, base, head) => {
    const p = await plan(base, head, path);
    expect(p.agents).toContain("contracts");
    expect(p.agent_reasons.contracts).toBe("public_contract_change");
  });

  it.each([
    [
      "a function body",
      "pkg/api.py",
      "def fetch(url):\n    return 1\n",
      "def fetch(url):\n    return 2\n",
    ],
    [
      "an exported value",
      "src/version.ts",
      "export const VERSION = 1;\n",
      "export const VERSION = 2;\n",
    ],
    [
      "an env read",
      "src/env.ts",
      "const a = 1;\n",
      "const a = process.env.API_URL;\n",
    ],
  ])("does not fire for %s", async (_, path, base, head) => {
    const p = await plan(base, head, path);
    expect(p.agents).not.toContain("contracts");
    expect(p.risk.reasons).not.toContain("public_contract_change");
  });
});

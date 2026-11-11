import { describe, it, expect } from "vitest";
import { OUTPUT_LIMIT, Tools } from "../src/tools";
import type { Snapshot } from "../src/types";
import { graphs } from "./fixtures";

const file = (content: string) => ({ mode: 0o100644, content });
const snapshot: Snapshot = {
  base: {
    "src/auth/session.ts": file("export function renew() {}\n"),
    "old/gone.ts": file("renew();\n"),
  },
  head: {
    "README.md": file("call refresh to renew a session\n"),
    "app/[id]/page.tsx": file("refresh();\n"),
    "lib/core/auth/util.ts": file("refresh();\n"),
    "link.ts": { mode: 0o120000, content: "src/auth/session.ts" },
    "main.ts": file("refresh();\n"),
    "src/api/login.ts": file(
      "import { refresh } from '../auth/session';\nrefresh();\n",
    ),
    "src/auth/session.ts": file(
      "export function refresh() {}\nconst secret = 1;\n",
    ),
  },
};
const tools = () => new Tools(snapshot, graphs, undefined);
const paths = async (args: unknown) => [
  ...new Set(
    (await tools().dispatch("search", args)).results.map((r: any) => r.path),
  ),
];
const error = async (name: string, args: unknown) =>
  tools()
    .dispatch(name, args)
    .then(
      () => "no error",
      (e: Error) => e.message,
    );
const everywhere = [
  "README.md",
  "app/[id]/page.tsx",
  "lib/core/auth/util.ts",
  "main.ts",
  "src/api/login.ts",
  "src/auth/session.ts",
];

describe("search arguments", () => {
  // The four forms review agents sent in the review-quality baseline (1,074 calls).
  it("runs {pattern, version} over the whole snapshot", async () => {
    const result = await tools().dispatch("search", {
      pattern: "refresh",
      version: "head",
    });
    expect(result.version).toBe("head");
    expect(result.truncated).toBe(false);
    expect(result).not.toHaveProperty("scope");
    expect([...new Set(result.results.map((r: any) => r.path))]).toEqual(
      everywhere,
    );
    expect(await paths({ pattern: "renew()", version: "base" })).toEqual([
      "old/gone.ts",
      "src/auth/session.ts",
    ]);
  });
  it("honours glob in {pattern, version, glob} instead of searching everything", async () => {
    const result = await tools().dispatch("search", {
      pattern: "refresh",
      version: "head",
      glob: "src/**",
    });
    expect(result.scope).toBe("src/**");
    expect([...new Set(result.results.map((r: any) => r.path))]).toEqual([
      "src/api/login.ts",
      "src/auth/session.ts",
    ]);
  });
  it("searches head for {pattern} and says so", async () => {
    const result = await tools().dispatch("search", { pattern: "refresh" });
    expect(result.version).toBe("head");
    expect(result.results).toHaveLength(7);
    // A null version is a missing one.
    expect(
      (await tools().dispatch("search", { pattern: "refresh", version: null }))
        .version,
    ).toBe("head");
  });
  it("searches head within the glob for {pattern, glob}", async () => {
    const result = await tools().dispatch("search", {
      pattern: "refresh",
      glob: "src/api/login.ts",
    });
    expect(result).toMatchObject({
      version: "head",
      scope: "src/api/login.ts",
    });
    expect(result.results.map((r: any) => [r.path, r.line])).toEqual([
      ["src/api/login.ts", 1],
      ["src/api/login.ts", 2],
    ]);
  });
  it("treats scope and glob as one argument", async () => {
    const scope = await tools().dispatch("search", {
      pattern: "refresh",
      scope: "src/auth/**",
    });
    const glob = await tools().dispatch("search", {
      pattern: "refresh",
      glob: "src/auth/**",
    });
    expect(scope).toEqual(glob);
    expect(
      await paths({ pattern: "refresh", scope: "src/**", glob: "src/**" }),
    ).toHaveLength(2);
    expect(
      await error("search", {
        pattern: "refresh",
        scope: "src/**",
        glob: "lib/**",
      }),
    ).toBe(
      'search takes "scope" or "glob" (the same argument), not two different values',
    );
  });
  // The glob shapes agents sent: path with wildcard, plain path, `**/` prefix,
  // extension without a slash, braces and bare names.
  it.each([
    ["src/**", ["src/api/login.ts", "src/auth/session.ts"]],
    ["src/api/*", ["src/api/login.ts"]],
    ["src/auth/session.ts", ["src/auth/session.ts"]],
    ["src/auth", ["src/auth/session.ts"]],
    ["src/auth/", ["src/auth/session.ts"]],
    ["./src/auth", ["src/auth/session.ts"]],
    ["src", ["src/api/login.ts", "src/auth/session.ts"]],
    [
      "**/*.ts",
      [
        "lib/core/auth/util.ts",
        "main.ts",
        "src/api/login.ts",
        "src/auth/session.ts",
      ],
    ],
    ["**/auth/**", ["lib/core/auth/util.ts", "src/auth/session.ts"]],
    [
      "*.ts",
      [
        "lib/core/auth/util.ts",
        "main.ts",
        "src/api/login.ts",
        "src/auth/session.ts",
      ],
    ],
    ["*.md", ["README.md"]],
    ["*.{md,tsx}", ["README.md", "app/[id]/page.tsx"]],
    ["src/{api,auth}/**", ["src/api/login.ts", "src/auth/session.ts"]],
    ["auth", ["lib/core/auth/util.ts", "src/auth/session.ts"]],
    ["util.ts", ["lib/core/auth/util.ts"]],
    ["app/[id]/page.tsx", ["app/[id]/page.tsx"]],
    ["app/[id]", ["app/[id]/page.tsx"]],
    ["**", everywhere],
    [".", everywhere],
  ])("scope %s", async (scope, expected) => {
    expect(await paths({ pattern: "refresh", version: "head", scope })).toEqual(
      expected,
    );
    expect(await paths({ pattern: "refresh", glob: scope })).toEqual(expected);
  });
  it("says what to send for every rejected call", async () => {
    const pattern =
      'search needs "pattern": the text to find, 1 to 500 characters, matched as written (it is not a regular expression)';
    for (const args of [
      undefined,
      null,
      "refresh",
      {},
      { version: "head" },
      { pattern: "" },
      { pattern: 7 },
      { pattern: "x".repeat(501) },
    ])
      expect(await error("search", args)).toBe(pattern);
    for (const version of ["HEAD", "both", 1, "main"])
      expect(await error("search", { pattern: "refresh", version })).toBe(
        'search needs "version": "base" or "head"',
      );
    const scope =
      'search "scope" must be a glob or a path relative to the repository root, such as "src/**", "src/auth" or "*.ts", without ".." or a leading "/"';
    for (const bad of [
      "../other",
      "src/../../etc",
      "/etc/**",
      "",
      3,
      ["src"],
      "x".repeat(501),
    ]) {
      expect(await error("search", { pattern: "refresh", scope: bad })).toBe(
        scope,
      );
      expect(await error("search", { pattern: "refresh", glob: bad })).toBe(
        scope,
      );
    }
    // A misspelt scope is refused, never dropped in favour of the whole snapshot.
    expect(
      await error("search", {
        pattern: "refresh",
        path: "src",
        include: "*.ts",
      }),
    ).toBe(
      'search does not take "path", "include"; its arguments are pattern, version, scope, glob',
    );
    // A scope that selects nothing is not reported as "no match".
    expect(
      await error("search", { pattern: "refresh", glob: "source/**" }),
    ).toBe(
      'search scope "source/**" matches no file in the head snapshot; scope is a glob or a path relative to the repository root, such as "src/**", "src/auth" or "*.ts"',
    );
    expect(
      await error("search", {
        pattern: "renew",
        version: "head",
        scope: "old/**",
      }),
    ).toContain("matches no file in the head snapshot");
    expect(
      await paths({ pattern: "renew", version: "base", scope: "old/**" }),
    ).toEqual(["old/gone.ts"]);
  });
  it("stays literal, skips links, redacts and stops at the output limit", async () => {
    // A regular expression matches nothing, and the result says why.
    const regex = await tools().dispatch("search", { pattern: "ref.*sh\\(" });
    expect(regex.results).toEqual([]);
    expect(regex.note).toContain("literal");
    expect(
      (await tools().dispatch("search", { pattern: "absent-text" })).note,
    ).toBeUndefined();
    expect(await paths({ pattern: "[id]" })).toEqual([]);
    // The link's own text names its target, yet a link is never searched or selected.
    expect(await paths({ pattern: "src/auth/session.ts" })).toEqual([]);
    expect(
      await error("search", { pattern: "session", scope: "link.ts" }),
    ).toContain("matches no file");
    const noisy: Snapshot = {
      base: {},
      head: {
        "big.txt": file("needle and some padding text\n".repeat(4000)),
        "env.txt": file("needle AKIAIOSFODNN7EXAMPLE\n"),
      },
    };
    const big = await new Tools(noisy, graphs, undefined).dispatch("search", {
      pattern: "needle",
    });
    expect(big.truncated).toBe(true);
    expect(big.version).toBe("head");
    expect(JSON.stringify(big.results).length).toBeLessThanOrEqual(
      OUTPUT_LIMIT + 2 * big.results.length,
    );
    const secret = await new Tools(noisy, graphs, undefined).dispatch(
      "search",
      {
        pattern: "needle",
        scope: "env.txt",
      },
    );
    expect(JSON.stringify(secret)).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});
describe("read_file arguments", () => {
  it("reads with path and version, with or without a line range", async () => {
    expect(
      await tools().dispatch("read_file", {
        path: "src/api/login.ts",
        version: "head",
      }),
    ).toBe("1: import { refresh } from '../auth/session';\n2: refresh();\n3: ");
    expect(
      await tools().dispatch("read_file", {
        path: "src/api/login.ts",
        version: "head",
        line_start: 2,
        line_end: 2,
      }),
    ).toBe("2: refresh();");
  });
  it("names the missing or wrong argument", async () => {
    // 37 baseline calls omitted the version; the reply now says what to add.
    for (const args of [
      { path: "src/api/login.ts" },
      { path: "src/api/login.ts", line_start: 1, line_end: 20 },
      { path: "src/api/login.ts", version: "HEAD" },
    ])
      expect(await error("read_file", args)).toBe(
        'read_file needs "version": "base" or "head"',
      );
    const path =
      'read_file needs "path": a file path relative to the repository root such as "src/main.ts", without a leading "/", "." or ".." segments or backslashes';
    for (const args of [
      undefined,
      {},
      { version: "head" },
      { path: "", version: "head" },
      { path: "../etc/passwd", version: "head" },
      { path: "/etc/passwd", version: "head" },
      { path: "src/../../x", version: "head" },
      { path: "./src/api/login.ts", version: "head" },
      { path: "C:\\secret", version: "head" },
    ])
      expect(await error("read_file", args)).toBe(path);
    expect(
      await error("read_file", {
        path: "main.ts",
        version: "head",
        offset: 3,
        limit: 5,
      }),
    ).toBe(
      'read_file does not take "offset", "limit"; its arguments are path, version, line_start, line_end',
    );
    for (const range of [
      { line_start: 0 },
      { line_start: 3, line_end: 2 },
      { line_start: "2" },
      { line_end: 1.5 },
    ])
      expect(
        await error("read_file", {
          path: "main.ts",
          version: "head",
          ...range,
        }),
      ).toBe(
        "read_file line_start and line_end must be whole numbers from 1, with line_end not before line_start",
      );
    expect(
      await error("read_file", {
        path: "main.ts",
        version: "head",
        line_start: 40,
      }),
    ).toBe(
      '"main.ts" has 2 lines in the head snapshot; line_start 40 is past its end',
    );
  });
  it("says where a file that is absent from the version does exist", async () => {
    expect(
      await error("read_file", { path: "old/gone.ts", version: "head" }),
    ).toBe(
      '"old/gone.ts" is not a file in the head snapshot; it exists in the base snapshot',
    );
    expect(await error("read_file", { path: "main.ts", version: "base" })).toBe(
      '"main.ts" is not a file in the base snapshot; it exists in the head snapshot',
    );
    expect(
      await error("read_file", { path: "src/auth", version: "head" }),
    ).toBe(
      '"src/auth" is not a file in the head snapshot; check the path, or find it with search',
    );
  });
  it("still refuses links", async () => {
    expect(await error("read_file", { path: "link.ts", version: "head" })).toBe(
      "symlink access denied",
    );
  });
});
describe("other tools", () => {
  it("names the tools and the run arguments", async () => {
    expect(await error("grep", { pattern: "x" })).toBe(
      'unknown tool "grep"; the tools are read_file, search, graph_query, run, board_read, board_write',
    );
    const run = new Tools(snapshot, graphs, async () => ({}) as any);
    await expect(
      run.dispatch("run", { command: "npm test", version: "head" }),
    ).rejects.toThrow(
      'run needs "command": an argv array of strings such as ["npm","test"], and "version": "base" or "head"',
    );
    await expect(
      new Tools(snapshot, graphs, undefined, 2, 2000, ["read_file"]).dispatch(
        "search",
        {
          pattern: "x",
        },
      ),
    ).rejects.toThrow("tool disabled by manifest");
  });
});

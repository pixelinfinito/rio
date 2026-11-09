import { describe, expect, it } from "vitest";
import { buildPack, memberRequest, render } from "../src/council-pack";
import prompts from "../src/member-prompts.json";
import { packInput } from "./council-fixtures";

const blocks = (text: string) =>
  [...text.matchAll(/<repository_data label="([^"]+)">/g)].map((m) => m[1]);

describe("evidence pack", () => {
  it("is content-addressed and identical for every member", () => {
    const a = buildPack(packInput),
      b = buildPack(structuredClone(packInput));
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(a.bytes).toBeGreaterThan(0);
  });
  it("carries the hypothesis without the agent's reasoning and only affected files", () => {
    const { pack } = buildPack(packInput);
    const text = JSON.stringify(pack);
    expect(text).not.toContain("AGENT REASONING");
    expect(text).not.toContain("AGENT LIMITATION");
    expect(text).not.toContain("restore the owner comparison");
    expect(text).not.toContain("UNRELATED");
    expect(
      pack.artifacts.filter((a) => a.kind === "file").map((a) => a.path),
    ).toEqual(["src/auth.ts"]);
    // The slice stays within hops; unrelated components are not in it.
    const paths = pack.artifacts
      .filter((a) => a.kind === "node")
      .map((a) => a.path);
    expect(paths).not.toContain("src/unrelated.ts");
    expect(paths).toContain("src/routes.ts");
    expect(pack.guidance.map((g) => g.path)).toEqual(["src/AGENTS.md"]);
    // Blind matches are counted, never attributed to voters.
    expect(pack.verification.blind_match).toEqual({
      same: 2,
      related: 0,
      none: 1,
    });
    expect(text).not.toMatch(/"voter"/);
    expect(pack.artifacts.map((a) => a.id)).toEqual(
      expect.arrayContaining(["file-1", "head-1", "base-1", "code-1", "run-1"]),
    );
    expect(pack.test_command).toEqual(["vitest", "run"]);
  });
  it("renders by context pack, adding only the specified blocks", () => {
    const { pack } = buildPack(packInput);
    const diff = render(pack, "diff-only", false),
      graph = render(pack, "graph-heavy", false),
      execution = render(pack, "execution", false);
    const base = blocks(diff.text);
    expect(blocks(graph.text)).toEqual([...base, "callers and callees"]);
    expect(blocks(execution.text)).toEqual([
      ...base,
      "callers and callees",
      "runnable artifacts",
    ]);
    // The graph-heavy member sees callers, the diff-only member does not.
    expect(graph.text).toContain("src/routes.ts");
    expect(diff.text).not.toContain("src/routes.ts");
    // Runnable artifacts carry commands and outcomes, never output text.
    expect(execution.text).toContain('"command":["npm","test","--","auth"]');
    for (const text of [diff.text, graph.text, execution.text])
      expect(text).not.toContain("1 failing");
    // Every rendering is a prefix extension of the diff-only one.
    expect(graph.text.startsWith(diff.text)).toBe(true);
    expect(execution.text.startsWith(graph.text)).toBe(true);
  });
  it("falls back to graph-heavy for execution members on fork pull requests", () => {
    const { pack } = buildPack(packInput);
    const fork = render(pack, "execution", true);
    expect(fork.effective).toBe("graph-heavy");
    expect(fork.text).not.toContain("runnable artifacts");
    expect(fork.text).not.toContain("vitest");
  });
  it("gives every member's prompt the pack only inside data blocks", () => {
    const { pack } = buildPack(packInput);
    for (const [role, prompt] of Object.entries(prompts)) {
      const { text } = render(pack, "execution", false);
      const request = memberRequest(role as any, prompt, text, 1);
      const outside = request.content.replace(
        /<repository_data label="[^"]+">\n[^\n]*\n<\/repository_data>/g,
        "",
      );
      for (const fragment of [
        "check() no longer",
        "owner check",
        "Owners only",
        "Simplify the document",
      ])
        expect(outside + request.system).not.toContain(fragment);
      expect(request.content).toContain("check() no longer");
      expect(prompt).toContain("`repository_data` blocks");
    }
  });
});

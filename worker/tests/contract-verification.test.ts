import { describe, expect, it } from "vitest";
import { evidenceLevel, type EvidenceContext } from "../src/quorum";
import type { ArtifactRef, Hypothesis } from "../src/types";

// Contract hypotheses are settled through graph paths in both versions
// (contracts-agent spec, "Static verification"; task 8.4).
const node = (
  id: string,
  path: string,
  symbol_path: string,
  line_start: number,
  line_end: number,
  content_hash: string,
) => ({ id, path, symbol_path, line_start, line_end, content_hash });
const head = {
  nodes: [
    node("p", "src/api.ts", "api.createUser", 1, 3, "p2"),
    node("c", "src/client.ts", "client.signup", 1, 5, "c1"),
    node("u", "src/admin.ts", "admin.invite", 1, 4, "u2"),
    node("x", "src/unrelated.ts", "unrelated.run", 1, 2, "x1"),
  ],
  edges: [
    { from: "c", to: "p", kind: "calls" },
    { from: "u", to: "p", kind: "calls" },
  ],
};
const base = {
  nodes: [
    node("p0", "src/api.ts", "api.createUser", 1, 3, "p1"),
    node("c0", "src/client.ts", "client.signup", 1, 5, "c1"),
    node("u0", "src/admin.ts", "admin.invite", 1, 4, "u1"),
  ],
  edges: [],
};
const mode = { mode: 0o100644 };
const context: EvidenceContext = {
  snapshot: {
    head: {
      "src/api.ts": mode,
      "src/client.ts": mode,
      "src/admin.ts": mode,
      "src/unrelated.ts": mode,
    },
  },
  head,
  base,
  executions: {},
  guidance: [],
};
const loc = (path: string, line: number, symbol_path: string) => ({
  path,
  line_start: line,
  line_end: line,
  symbol_path,
  occurrence_state: "new",
});
function hypothesis(consumers: ReturnType<typeof loc>[]): Hypothesis {
  const producer = loc("src/api.ts", 1, "api.createUser");
  return {
    id: "h",
    rule_id: "contracts/signature/added_required",
    category: "defect",
    severity: "error",
    location: producer,
    locations: [producer, ...consumers],
    message:
      "createUser now requires email; signup still calls it without one.",
    trigger: "signup(name)",
    state: "new",
    source: { agent: "contracts" },
  };
}
const claim = (
  evidence_level: "static_proven" | "refuted",
  refs: Partial<ArtifactRef>[],
) => ({
  evidence_level,
  evidence: refs.map((r) => ({
    kind: "code" as const,
    version: "head" as const,
    demonstrates:
      evidence_level === "refuted"
        ? ("protection" as const)
        : ("regression" as const),
    ...r,
  })),
});

describe("contract static proof", () => {
  const h = hypothesis([loc("src/client.ts", 2, "client.signup")]);
  it("accepts a connected head path from a cited consumer to the changed contract", () => {
    expect(
      evidenceLevel(
        claim("static_proven", [
          { path: "src/client.ts", node_ids: ["c", "p"] },
        ]),
        h,
        context,
      ),
    ).toBe("static_proven");
  });

  it.each([
    ["the consumer alone", ["c"]],
    ["the contract alone", ["p"]],
    ["an uncited caller of the contract", ["u", "p"]],
    ["a disconnected bag of nodes", ["c", "x"]],
    ["a node missing from the head graph", ["c", "p", "gone"]],
  ])("keeps a citation of %s plausible", (_, node_ids) => {
    expect(
      evidenceLevel(
        claim("static_proven", [{ path: "src/client.ts", node_ids }]),
        h,
        context,
      ),
    ).toBe("plausible");
  });

  it("cannot prove a contract hypothesis that cites no consumer", () => {
    const risk = { ...hypothesis([]), category: "risk" as const };
    expect(
      evidenceLevel(
        claim("static_proven", [{ path: "src/api.ts", node_ids: ["p"] }]),
        risk,
        context,
      ),
    ).toBe("plausible");
  });

  it("leaves other rules on the single-file citation rule", () => {
    const other = { ...h, rule_id: "correctness/null-guard" };
    expect(
      evidenceLevel(
        claim("static_proven", [
          { path: "src/client.ts", node_ids: ["c", "p"] },
        ]),
        other,
        context,
      ),
    ).toBe("plausible");
    expect(
      evidenceLevel(
        claim("static_proven", [{ path: "src/client.ts", node_ids: ["c"] }]),
        other,
        context,
      ),
    ).toBe("static_proven");
  });
});

describe("contract refutation", () => {
  it("refutes when head updated a cited consumer", () => {
    // admin.invite changed between base and head (hash u1 -> u2).
    const h = hypothesis([loc("src/admin.ts", 2, "admin.invite")]);
    expect(
      evidenceLevel(
        claim("refuted", [{ path: "src/admin.ts", node_ids: ["u"] }]),
        h,
        context,
      ),
    ).toBe("refuted");
  });

  it("does not refute with an off-path protection or an uncited consumer update", () => {
    const h = hypothesis([loc("src/client.ts", 2, "client.signup")]);
    // A valid citation of code that is neither the contract nor a cited consumer.
    expect(
      evidenceLevel(
        claim("refuted", [{ path: "src/unrelated.ts", node_ids: ["x"] }]),
        h,
        context,
      ),
    ).toBe("plausible");
    // admin.invite changed, but the hypothesis does not cite it.
    expect(
      evidenceLevel(
        claim("refuted", [{ path: "src/admin.ts", node_ids: ["u"] }]),
        h,
        context,
      ),
    ).toBe("plausible");
    // Without the base graph a consumer update cannot be established; the
    // citation is still a protection inside a cited consumer.
    const admin = hypothesis([loc("src/admin.ts", 2, "admin.invite")]);
    expect(
      evidenceLevel(
        claim("refuted", [{ path: "src/unrelated.ts", node_ids: ["x"] }]),
        admin,
        { ...context, base: undefined },
      ),
    ).toBe("plausible");
  });

  it("refutes with a protection on the path: in the contract or a cited consumer", () => {
    const h = hypothesis([loc("src/client.ts", 2, "client.signup")]);
    for (const [path, node_ids] of [
      ["src/api.ts", ["p"]],
      ["src/client.ts", ["c"]],
    ] as const)
      expect(
        evidenceLevel(
          claim("refuted", [{ path, node_ids: [...node_ids] }]),
          h,
          context,
        ),
      ).toBe("refuted");
    // Other rules keep accepting any valid protection citation.
    expect(
      evidenceLevel(
        claim("refuted", [{ path: "src/unrelated.ts", node_ids: ["x"] }]),
        { ...h, rule_id: "correctness/null-guard" },
        context,
      ),
    ).toBe("refuted");
  });
});

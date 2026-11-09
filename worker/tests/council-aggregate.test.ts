import { describe, expect, it } from "vitest";
import {
  aggregate,
  weightOf,
  type Experiment,
  type Position,
} from "../src/council-aggregate";
import { buildPack, render } from "../src/council-pack";
import { consolidate } from "../src/consolidate";
import type { Assessment, Role } from "../src/council";
import { packInput, verified } from "./council-fixtures";

const { pack } = buildPack(packInput);
const position = (
  role: Role,
  over: Partial<Assessment> = {},
  weight = 1,
): Position => ({
  role,
  weight,
  assessment: {
    member: role,
    round: 1,
    real: "yes",
    introduced_by_change: "yes",
    impact: "Reproduced beyond doubt, trust me.",
    basis: "none",
    evidence_refs: ["hypothesis"],
    ...over,
  },
});
const run = (exit_code: number) => ({
  exit_code,
  outcome: "exited" as const,
  timed_out: false,
  truncated: false,
});
const experiment = (
  id: string,
  version: "base" | "head" | "both",
  runs: Experiment["runs"],
): Experiment => ({
  id,
  request: { command: ["npm", "test"], version, expect: "fails" },
  runs,
});
const roles: Role[] = [
  "skeptic",
  "exploit-author",
  "code-owner",
  "maintainer",
  "tester",
];
const head = (relation: string) =>
  pack.artifacts.find(
    (a) => a.kind === "node" && a.version === "head" && a.relation === relation,
  )!.id;

describe("deterministic aggregator", () => {
  it("reproduces on an experiment failing on head and passing on base", () => {
    const decision = aggregate(
      roles.map((r) =>
        position(r, {
          real: "no",
          basis: "protection_found",
          evidence_refs: [head("caller")],
        }),
      ),
      [experiment("exp-1", "both", { base: run(0), head: run(1) })],
      pack,
      "plausible",
    );
    expect(decision).toMatchObject({
      decision: "reproduced",
      tier: "experiment",
      artifacts: ["exp-1"],
      evidence_level: "reproduced",
    });
  });
  it("pairs a head-only failure with the same command passing on base", () => {
    const decision = aggregate(
      [],
      [
        experiment("exp-1", "head", { head: run(1) }),
        experiment("exp-2", "base", { base: run(0) }),
      ],
      pack,
      "plausible",
    );
    expect(decision.artifacts).toEqual(["exp-1", "exp-2"]);
  });
  it("ignores runs that did not complete", () => {
    const decision = aggregate(
      [],
      [
        experiment("exp-1", "both", {
          base: run(0),
          head: { ...run(1), timed_out: true },
        }),
      ],
      pack,
      "plausible",
    );
    expect(decision.decision).toBe("plausible");
  });
  it("refutes on a protection the graph places on the path, regardless of votes", () => {
    const decision = aggregate(
      [
        ...roles
          .slice(1)
          .map((r) =>
            position(r, { basis: "static_path", evidence_refs: ["file-1"] }),
          ),
        position("skeptic", {
          real: "no",
          basis: "protection_found",
          evidence_refs: [head("caller")],
        }),
      ],
      [],
      pack,
      "plausible",
    );
    expect(decision).toMatchObject({
      decision: "refuted",
      tier: "protection",
      protection: head("caller"),
      evidence_level: "refuted",
    });
  });
  it("does not refute on a protection off the path or in base", () => {
    for (const ref of [
      head("callee"),
      "base-1",
      "file-1",
      "no-such-artifact",
    ]) {
      const decision = aggregate(
        [
          position("skeptic", {
            real: "no",
            basis: "protection_found",
            evidence_refs: [ref],
          }),
        ],
        [],
        pack,
        "plausible",
      );
      expect(decision.decision, ref).toBe("plausible");
    }
  });
  it("keeps five yes answers with basis none plausible, saying no member cited evidence", () => {
    const decision = aggregate(
      roles.map((r) => position(r)),
      [],
      pack,
      "plausible",
    );
    expect(decision).toMatchObject({
      decision: "plausible",
      tier: "judgment",
      evidence_level: "plausible",
    });
    expect(decision.note).toContain("No member cited evidence");
    expect(decision.note).not.toMatch(/%|\d+\.\d+/);
    // Impact text is never parsed: it claimed reproduction.
    expect(decision.note).not.toContain("Reproduced beyond doubt");
  });
  it("never lowers the verifier's level on a judgment decision", () => {
    expect(aggregate([], [], pack, "static_proven").evidence_level).toBe(
      "static_proven",
    );
  });
  it("describes weighted positions and dissent in words", () => {
    const decision = aggregate(
      [
        position(
          "exploit-author",
          { basis: "static_path", evidence_refs: ["file-1"] },
          3,
        ),
        position(
          "tester",
          { basis: "reproduction", evidence_refs: ["run-1"] },
          1,
        ),
        position(
          "skeptic",
          { real: "no", basis: "contract", evidence_refs: ["file-1"] },
          1,
        ),
      ],
      [],
      pack,
      "plausible",
    );
    expect(decision.note).toContain(
      "Real: most of the weight answers yes (static_path, reproduction; exploit-author, tester)",
    );
    expect(decision.note).toContain(
      "a minority of the weight answers no (contract; skeptic)",
    );
    expect(decision.note).toContain("No experiment ran.");
  });
  it("lets weights order the note but never change the decision tier", () => {
    const positions = (skeptic: number) => [
      position("skeptic", { real: "no", basis: "none" }, skeptic),
      position(
        "tester",
        { basis: "static_path", evidence_refs: ["file-1"] },
        1,
      ),
    ];
    const heavy = aggregate(positions(100), [], pack, "plausible"),
      light = aggregate(positions(0.01), [], pack, "plausible");
    expect(heavy.tier).toBe(light.tier);
    expect(heavy.decision).toBe(light.decision);
    expect(heavy.note).not.toBe(light.note);
  });
});

describe("learned weights", () => {
  const member = { name: "rio/council-skeptic", weight: 1 };
  it("fall back to the manifest weight under 30 cases and show the sample size", () => {
    expect(
      weightOf(member, "security", {
        "rio/council-skeptic": { security: { weight: 3, samples: 12 } },
      }),
    ).toEqual({ weight: 1, samples: 12, learned: false });
    expect(
      weightOf(member, "security", {
        "rio/council-skeptic": { security: { weight: 3, samples: 30 } },
      }),
    ).toEqual({ weight: 3, samples: 30, learned: true });
    expect(weightOf(member, "defect", {})).toEqual({
      weight: 1,
      samples: 0,
      learned: false,
    });
  });
});

describe("council decisions in consolidation", () => {
  const council = {
    members: [],
    experiments: [],
    partial: false,
    answered: 5,
    total: 5,
  };
  const base: any = {
    ...verified,
    hypothesis: { ...verified.hypothesis, category: "risk", rule_id: "risk/x" },
  };
  const profile: any = {
    steps: [],
    suppress: [],
    posture: "balanced",
    min_evidence: "plausible",
    max_defects: 5,
    fail_on: {},
    posture_policy: { defect_severity_floor: "info" },
  };
  it("keeps a reproduced risk a risk", () => {
    const result = consolidate(
      [
        {
          ...base,
          evidence_level: "reproduced",
          council: {
            ...council,
            decision: "reproduced",
            tier: "experiment",
            note: "n",
          },
        },
      ],
      profile,
    );
    expect(result.defects).toEqual([]);
    expect(result.risks).toHaveLength(1);
    expect(result.risks[0]).toMatchObject({
      category: "risk",
      evidence_level: "reproduced",
    });
    expect(result.risks[0].council.decision).toBe("reproduced");
  });
  it("closes a refuted finding", () => {
    const result = consolidate(
      [
        {
          ...base,
          evidence_level: "refuted",
          council: {
            ...council,
            decision: "refuted",
            tier: "protection",
            note: "n",
            protection: "head-2",
          },
        },
      ],
      profile,
    );
    expect(result.risks).toEqual([]);
    expect(result.audit.refuted).toBe(1);
  });
});

describe("review fixes: path and command identity", () => {
  it("does not refute with a guard on only one of two callers", () => {
    const branching = structuredClone(pack);
    const location = head("location");
    const guarded = head("caller");
    branching.artifacts.push({
      id: "head-99",
      kind: "node",
      version: "head",
      path: "src/public.ts",
      symbol_path: "publicRoute",
      line_start: 1,
      line_end: 3,
      hop: 1,
      relation: "caller",
    });
    branching.graph.head.edges.push(["head-99", location]);
    branching.graph.head.calls.push(["head-99", location]);
    const decision = aggregate(
      [
        position("skeptic", {
          real: "no",
          basis: "protection_found",
          evidence_refs: [guarded],
        }),
      ],
      [],
      branching,
      "plausible",
    );
    expect(decision.decision).toBe("plausible");
    // The location's own symbol is always on the path.
    expect(
      aggregate(
        [
          position("skeptic", {
            real: "no",
            basis: "protection_found",
            evidence_refs: [location],
          }),
        ],
        [],
        branching,
        "plausible",
      ).decision,
    ).toBe("refuted");
  });
  it("never pairs commands whose arguments differ", () => {
    const decision = aggregate(
      [],
      [
        {
          id: "exp-1",
          request: { command: ["x"], version: "base", expect: "fails" },
          runs: { base: run(0) },
        },
        {
          id: "exp-2",
          request: { command: [" x "], version: "head", expect: "fails" },
          runs: { head: run(1) },
        },
      ],
      pack,
      "plausible",
    );
    expect(decision.decision).toBe("plausible");
  });
});

describe("second review: the finding's own symbol", () => {
  it("never treats an enclosing class as the location", () => {
    const input = structuredClone(packInput);
    const at = { path: "src/auth.ts", line_start: 3, line_end: 4 };
    input.verified.hypothesis.location = {
      ...input.verified.hypothesis.location,
      ...at,
      symbol_path: "Controller.check",
    };
    input.graphs.head = {
      nodes: [
        {
          id: "cls",
          path: "src/auth.ts",
          symbol_path: "Controller",
          line_start: 1,
          line_end: 9,
        },
        {
          id: "chk",
          path: "src/auth.ts",
          symbol_path: "Controller.check",
          line_start: 3,
          line_end: 4,
        },
        {
          id: "pub",
          path: "src/routes.ts",
          symbol_path: "publicRoute",
          line_start: 1,
          line_end: 2,
        },
      ],
      edges: [{ from: "pub", to: "chk", kind: "calls" }],
    } as any;
    const { pack: classPack } = buildPack(input);
    const locations = classPack.artifacts.filter(
      (a) =>
        a.kind === "node" && a.version === "head" && a.relation === "location",
    );
    expect(locations.map((a) => (a as any).symbol_path)).toEqual([
      "Controller.check",
    ]);
    const cls = classPack.artifacts.find(
      (a) => a.kind === "node" && (a as any).symbol_path === "Controller",
    );
    if (cls) {
      const decision = aggregate(
        [
          position("skeptic", {
            real: "no",
            basis: "protection_found",
            evidence_refs: [cls.id],
          }),
        ],
        [],
        classPack,
        "plausible",
      );
      expect(decision.decision).toBe("plausible");
    }
  });
});

describe("independent review fixes", () => {
  it("does not refute when a recursive caller reaches the location without the guard", () => {
    const cyclic = structuredClone(pack);
    const location = head("location");
    cyclic.artifacts.push({
      id: "head-98",
      kind: "node",
      version: "head",
      path: "src/public.ts",
      symbol_path: "publicEntry",
      line_start: 1,
      line_end: 3,
      hop: 1,
      relation: "caller",
    });
    cyclic.graph.head.edges.push(["head-98", location], ["head-98", "head-98"]);
    cyclic.graph.head.calls.push(["head-98", location], ["head-98", "head-98"]);
    const decision = aggregate(
      [
        position("skeptic", {
          real: "no",
          basis: "protection_found",
          evidence_refs: [head("caller")],
        }),
      ],
      [],
      cyclic,
      "plausible",
    );
    expect(decision.decision).toBe("plausible");
  });
  it("hashes the redacted pack it stores", async () => {
    const { canonical, hash } = await import("../src/validation");
    const { scrub } = await import("../src/redaction");
    const input = structuredClone(packInput);
    input.files["src/auth.ts"].head =
      'const token = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";\n';
    const built = buildPack(input);
    expect(JSON.stringify(built.pack)).not.toContain(
      "abcdefghijklmnopqrstuvwxyz",
    );
    expect(built.hash).toBe(hash(canonical(scrub(built.pack))));
  });
  it("keeps councilled findings out of class merging", () => {
    const council = {
      members: [],
      experiments: [],
      partial: false,
      answered: 5,
      total: 5,
      decision: "plausible" as const,
      tier: "judgment" as const,
      note: "n",
    };
    const many = [1, 2, 3, 4].map((i) => ({
      ...verified,
      hypothesis: {
        ...verified.hypothesis,
        id: String(i).repeat(64),
        location: {
          ...verified.hypothesis.location,
          symbol_path: `s${i}`,
          line_start: i,
          line_end: i,
        },
      },
      council,
    }));
    const profile: any = {
      steps: [],
      suppress: [],
      posture: "thorough",
      min_evidence: "plausible",
      max_defects: 5,
      fail_on: {},
      posture_policy: { defect_severity_floor: "info" },
    };
    const result = consolidate(many as any, profile, { classThreshold: 3 });
    const all = [...result.defects, ...result.risks, ...result.security];
    expect(all).toHaveLength(4);
    expect(all.every((f) => f.council)).toBe(true);
  });
});

describe("round 4: call edges only", () => {
  it("never refutes with a guard in a function that only references the location", () => {
    const input = structuredClone(packInput);
    input.graphs.head.edges = input.graphs.head.edges.map((e: any) =>
      e.from === "n2" ? { ...e, kind: "references" } : e,
    );
    const { pack: referenced } = buildPack(input);
    const referrer = referenced.artifacts.find(
      (a) =>
        a.kind === "node" &&
        a.version === "head" &&
        (a as any).symbol_path === "get",
    )!;
    const decision = aggregate(
      [
        position("skeptic", {
          real: "no",
          basis: "protection_found",
          evidence_refs: [referrer.id],
        }),
      ],
      [],
      referenced,
      "plausible",
    );
    expect(decision.decision).toBe("plausible");
  });
});

describe("round 5: bounded files and caps", () => {
  it("redacts a key before bounding the file", () => {
    const input = structuredClone(packInput);
    const key =
      "-----BEGIN RSA PRIVATE KEY-----\n" +
      "A".repeat(64) +
      "\n-----END RSA PRIVATE KEY-----";
    input.files["src/auth.ts"].head =
      "x".repeat(65_500) + "\n" + key + "\n" + "y\n".repeat(10);
    const { pack: built } = buildPack(input);
    expect(JSON.stringify(built)).not.toContain("A".repeat(64));
  });
  it("keeps the finding's lines when a file is larger than the bound", () => {
    const input = structuredClone(packInput);
    const lines = Array.from(
      { length: 3000 },
      (_, i) => `const line${i} = ${i}; // padding padding padding`,
    );
    const base = lines.join("\n");
    lines[2499] = "const line2499 = CHANGED;";
    input.files["src/auth.ts"] = { base, head: lines.join("\n") };
    input.verified.hypothesis.location = {
      ...input.verified.hypothesis.location,
      line_start: 2500,
      line_end: 2500,
    };
    const { pack: built } = buildPack(input);
    const file = built.artifacts.find((a) => a.kind === "file") as any;
    expect(file.truncated).toBe(true);
    expect(file.head).toContain("CHANGED");
    const rendering = render(built, "diff-only", false).text;
    expect(rendering).toContain("CHANGED");
    expect(rendering).toContain('"start":2500');
  });
  it("never loses a councilled finding to a presentation cap", () => {
    const council = {
      members: [],
      experiments: [],
      partial: false,
      answered: 5,
      total: 5,
      decision: "plausible" as const,
      tier: "judgment" as const,
      note: "n",
    };
    const two = [1, 2].map((i) => ({
      ...verified,
      hypothesis: {
        ...verified.hypothesis,
        category: "risk" as const,
        rule_id: `risk/r${i}`,
        id: String(i).repeat(64),
      },
      ...(i === 2 ? { council } : {}),
    }));
    const profile: any = {
      steps: [],
      suppress: [],
      posture: "balanced",
      min_evidence: "plausible",
      max_defects: 1,
      fail_on: {},
      posture_policy: { defect_severity_floor: "info" },
    };
    const result = consolidate(two as any, profile);
    // Held back by the cap, it is listed with its council result instead.
    expect(
      [...result.risks, ...result.council_held].some((f) => f.council),
    ).toBe(true);
  });
});

describe("round 6: councilled findings are always reported", () => {
  it("lists a councilled finding below the severity floor apart, and refuted ids", () => {
    const council = {
      members: [],
      experiments: [],
      partial: false,
      answered: 5,
      total: 5,
      decision: "plausible" as const,
      tier: "judgment" as const,
      note: "n",
    };
    const low = {
      ...verified,
      evidence_level: "static_proven" as const,
      hypothesis: {
        ...verified.hypothesis,
        category: "defect" as const,
        severity: "info" as const,
        rule_id: "d/low",
      },
      council,
    };
    const gone = {
      ...verified,
      evidence_level: "refuted" as const,
      hypothesis: { ...verified.hypothesis, id: "9".repeat(64) },
    };
    const profile: any = {
      steps: [],
      suppress: [],
      posture: "balanced",
      min_evidence: "static_proven",
      max_defects: 5,
      fail_on: {},
      posture_policy: { defect_severity_floor: "warning" },
    };
    const result = consolidate([low as any, gone as any], profile);
    // Below the floor: not a finding (fail_on never sees it), but reported.
    expect(result.defects).toEqual([]);
    expect(result.council_held.map((f) => f.rule_id)).toEqual(["d/low"]);
    expect(result.audit.refuted_ids).toEqual(["9".repeat(64)]);
  });
});

describe("round 7: path check cost", () => {
  it("decides a 200-node chain with five citations quickly", () => {
    const chain = structuredClone(pack);
    const location = head("location");
    const ids = Array.from({ length: 200 }, (_, i) => `head-c${i}`);
    for (const [i, id] of ids.entries()) {
      chain.artifacts.push({
        id,
        kind: "node",
        version: "head",
        path: `src/c${i}.ts`,
        symbol_path: `c${i}`,
        line_start: 1,
        line_end: 2,
        hop: 1,
        relation: "neighbour",
      });
      const to = i === 0 ? location : ids[i - 1];
      chain.graph.head.edges.push([id, to]);
      chain.graph.head.calls.push([id, to]);
    }
    const started = Date.now();
    const decision = aggregate(
      ["skeptic", "exploit-author", "code-owner", "maintainer", "tester"].map(
        (r) =>
          position(r as Role, {
            real: "no",
            basis: "protection_found",
            evidence_refs: [ids[199]],
          }),
      ),
      [],
      chain,
      "plausible",
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(decision.decision).toBe("plausible");
  });
});

describe("round 8: incomplete slices", () => {
  it("does not refute from a slice that dropped nodes, except at the location itself", () => {
    const input = structuredClone(packInput);
    const extra = Array.from({ length: 250 }, (_, i) => ({
      id: `x${i}`,
      path: `src/x${i}.ts`,
      symbol_path: `x${i}`,
      line_start: 1,
      line_end: 1,
    }));
    input.graphs.head = {
      nodes: [...input.graphs.head.nodes, ...extra],
      edges: [
        ...input.graphs.head.edges,
        ...extra.map((n) => ({ from: "n1", to: n.id, kind: "calls" })),
      ],
    } as any;
    const { pack: big } = buildPack(input);
    expect(big.graph.head.truncated).toBe(true);
    const caller = big.artifacts.find(
      (a) =>
        a.kind === "node" && a.version === "head" && a.relation === "caller",
    )!;
    const location = big.artifacts.find(
      (a) =>
        a.kind === "node" && a.version === "head" && a.relation === "location",
    )!;
    const decide = (ref: string) =>
      aggregate(
        [
          position("skeptic", {
            real: "no",
            basis: "protection_found",
            evidence_refs: [ref],
          }),
        ],
        [],
        big,
        "plausible",
      ).decision;
    expect(decide(caller.id)).toBe("plausible");
    expect(decide(location.id)).toBe("refuted");
  });
});

describe("round 9", () => {
  it("never refutes a class finding from a guard covering one occurrence", () => {
    const input = structuredClone(packInput);
    const other = {
      path: "src/other.ts",
      line_start: 1,
      line_end: 2,
      symbol_path: "other",
      occurrence_state: "new",
      id: "b".repeat(64),
    };
    input.verified.locations = [
      { ...input.verified.hypothesis.location, id: "a".repeat(64) },
      other,
    ];
    input.files["src/other.ts"] = {
      base: "function other(){}\n",
      head: "function other(){ x }\n",
    };
    input.graphs.head = {
      nodes: [
        ...input.graphs.head.nodes,
        {
          id: "o1",
          path: "src/other.ts",
          symbol_path: "other",
          line_start: 1,
          line_end: 2,
        },
      ],
      edges: input.graphs.head.edges,
    } as any;
    const { pack: cls } = buildPack(input);
    expect(
      cls.artifacts
        .filter((a) => a.kind === "file")
        .map((a) => (a as any).path),
    ).toContain("src/other.ts");
    const guard = cls.artifacts.find(
      (a) =>
        a.kind === "node" &&
        a.version === "head" &&
        (a as any).symbol_path === "get",
    )!;
    expect(
      aggregate(
        [
          position("skeptic", {
            real: "no",
            basis: "protection_found",
            evidence_refs: [guard.id],
          }),
        ],
        [],
        cls,
        "plausible",
      ).decision,
    ).toBe("plausible");
  });
  it("reads a renamed file's base graph at its old path", () => {
    const input = structuredClone(packInput);
    input.verified.hypothesis.location = {
      ...input.verified.hypothesis.location,
      path: "src/renamed.ts",
    };
    input.files = { "src/renamed.ts": input.files["src/auth.ts"] };
    input.graphs.head = {
      ...input.graphs.head,
      nodes: input.graphs.head.nodes.map((n: any) =>
        n.path === "src/auth.ts" ? { ...n, path: "src/renamed.ts" } : n,
      ),
    } as any;
    input.renames = { "src/renamed.ts": "src/auth.ts" };
    const { pack: renamed } = buildPack(input);
    expect(renamed.graph.base.nodes.length).toBeGreaterThan(0);
  });
  it("keeps a skipped council under the floors and treats a null weight as unlearned", () => {
    const skipped = {
      ...verified,
      evidence_level: "static_proven" as const,
      hypothesis: {
        ...verified.hypothesis,
        category: "defect" as const,
        severity: "info" as const,
        rule_id: "d/skip",
      },
      council: {
        members: [],
        experiments: [],
        partial: false,
        skipped: true,
        answered: 0,
        total: 5,
      },
    };
    const profile: any = {
      steps: [],
      suppress: [],
      posture: "balanced",
      min_evidence: "reproduced",
      max_defects: 5,
      fail_on: {},
      posture_policy: { defect_severity_floor: "warning" },
    };
    expect(consolidate([skipped as any], profile).defects).toEqual([]);
    expect(
      weightOf({ name: "rio/council-skeptic", weight: 1 }, "security", {
        "rio/council-skeptic": { security: { weight: null, samples: 12 } },
      }),
    ).toEqual({ weight: 1, samples: 12, learned: false });
  });
});

describe("round 10: entries and missing sites", () => {
  it("never protects a location that is itself an entry of a recursive cycle", () => {
    const cyclic = structuredClone(pack);
    const location = head("location");
    cyclic.artifacts.push({
      id: "head-90",
      kind: "node",
      version: "head",
      path: "src/g.ts",
      symbol_path: "guard",
      line_start: 1,
      line_end: 2,
      hop: 1,
      relation: "caller",
    });
    cyclic.graph.head.calls = [
      ["head-90", location],
      [location, "head-90"],
    ];
    cyclic.graph.head.edges = [...cyclic.graph.head.calls];
    const decision = aggregate(
      [
        position("skeptic", {
          real: "no",
          basis: "protection_found",
          evidence_refs: ["head-90"],
        }),
      ],
      [],
      cyclic,
      "plausible",
    );
    expect(decision.decision).toBe("plausible");
  });
  it("never refutes a class finding with an occurrence missing from the graph", () => {
    const input = structuredClone(packInput);
    input.verified.locations = [
      { ...input.verified.hypothesis.location, id: "a".repeat(64) },
      {
        path: "src/nowhere.ts",
        line_start: 1,
        line_end: 1,
        symbol_path: "gone",
        occurrence_state: "new",
        id: "b".repeat(64),
      },
    ];
    const { pack: partial } = buildPack(input);
    expect(partial.graph.head.missing_sites).toBe(true);
    const location = partial.artifacts.find(
      (a) =>
        a.kind === "node" && a.version === "head" && a.relation === "location",
    )!;
    expect(
      aggregate(
        [
          position("skeptic", {
            real: "no",
            basis: "protection_found",
            evidence_refs: [location.id],
          }),
        ],
        [],
        partial,
        "plausible",
      ).decision,
    ).toBe("plausible");
  });
  it("decides 200 distinct citations on a dense 200-node slice quickly", () => {
    const dense = structuredClone(pack);
    const location = head("location");
    const ids = Array.from({ length: 200 }, (_, i) => `head-d${i}`);
    for (const id of ids)
      dense.artifacts.push({
        id,
        kind: "node",
        version: "head",
        path: `src/${id}.ts`,
        symbol_path: id,
        line_start: 1,
        line_end: 1,
        hop: 1,
        relation: "neighbour",
      });
    dense.graph.head.calls = [];
    for (const a of ids)
      for (const b of ids) if (a !== b) dense.graph.head.calls.push([a, b]);
    for (const a of ids) dense.graph.head.calls.push([a, location]);
    const started = Date.now();
    aggregate(
      [
        position("skeptic", {
          real: "no",
          basis: "protection_found",
          evidence_refs: ids.slice(0, 50),
        }),
        position("tester", {
          real: "no",
          basis: "protection_found",
          evidence_refs: ids.slice(50, 100),
        }),
        position("maintainer", {
          real: "no",
          basis: "protection_found",
          evidence_refs: ids.slice(100, 150),
        }),
        position("code-owner", {
          real: "no",
          basis: "protection_found",
          evidence_refs: ids.slice(150),
        }),
      ],
      [],
      dense,
      "plausible",
    );
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe("round 11: class suppression", () => {
  it("suppresses a councilled finding by the class it would form", async () => {
    const { classId, triggerHash } = await import("../src/consolidate");
    const council = {
      members: [],
      experiments: [],
      partial: false,
      answered: 5,
      total: 5,
      decision: "plausible" as const,
      tier: "judgment" as const,
      note: "n",
    };
    const many = [1, 2, 3, 4].map((i) => ({
      ...verified,
      hypothesis: {
        ...verified.hypothesis,
        id: String(i).repeat(64),
        location: { ...verified.hypothesis.location, symbol_path: `s${i}` },
      },
      council,
    }));
    const h = verified.hypothesis;
    const profile: any = {
      steps: [],
      suppress: [{ finding: classId(h.rule_id, triggerHash(h.trigger)) }],
      posture: "thorough",
      min_evidence: "plausible",
      max_defects: 5,
      fail_on: {},
      posture_policy: { defect_severity_floor: "info" },
    };
    const result = consolidate(many as any, profile, { classThreshold: 3 });
    expect([...result.defects, ...result.risks, ...result.security]).toEqual(
      [],
    );
    expect(result.audit.suppressed).toBe(4);
    expect(result.audit.policy_failed).toBe(false);
  });
});

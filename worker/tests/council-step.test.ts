import fixtureFinding from "../../crates/rio-core/tests/fixtures/finding.json";
import { validateFinding } from "../src/validation";
import { findingOf } from "../src/consolidate";
import { describe, expect, it } from "vitest";
import {
  chooseExperiments,
  lettersFor,
  runCouncil,
  select,
  settle,
  type CouncilDeps,
  type CouncilInput,
} from "../src/council-step";
import {
  compose,
  type Assessment,
  type Member,
  type Role,
} from "../src/council";
import type { Plan } from "../src/triage";
import type { ExecutionResult } from "../src/types";
import {
  executions,
  graphs,
  packInput,
  verified,
  votes,
} from "./council-fixtures";

const ROLES: Role[] = [
  "skeptic",
  "exploit-author",
  "code-owner",
  "maintainer",
  "tester",
];
const PACKS = {
  skeptic: "diff-only",
  "exploit-author": "execution",
  "code-owner": "graph-heavy",
  maintainer: "graph-heavy",
  tester: "execution",
} as const;
const FAMILIES = ["claude", "gpt", "gemini", "claude", "gpt"];
const VENDORS: Record<string, string> = {
  claude: "anthropic",
  gpt: "openai",
  gemini: "google",
};
const members: Member[] = ROLES.map((role, i) => ({
  name: `rio/council-${role}`,
  version: "0.1.0",
  role,
  context_pack: PACKS[role],
  provider: VENDORS[FAMILIES[i]],
  model: `${FAMILIES[i]}-model`,
  vendor: VENDORS[FAMILIES[i]],
  family: FAMILIES[i],
  weight: role === "tester" ? 2 : 1,
  self_hosted: false,
}));
const plan = {
  risk: { tier: "low", reasons: [], source: "triage" },
  require_human: false,
  mode: "fast",
  agents: [],
  agent_reasons: {},
  suggested_focus: [],
  signals: { adds_dependency: false, lines_changed: 1, languages: [] },
} as Plan;
const settings = {
  members: members.map((m) => ({ uses: m.name })),
  max_findings: 5,
  max_experiments: 2,
  max_rounds: 2,
  min_members: 3,
  timeout: "90s",
  vendors_allowed: ["anthropic", "openai", "google"],
};
const entries = Object.entries(VENDORS).map(([family, vendor]) => ({
  vendor,
  family,
  model: `${vendor}/${family}-model`,
}));
const RULES = [
  { when: "evidence == plausible and severity >= error" },
  { when: "verify.split" },
  { when: "risk_tier == high" },
  { when: "mode == deep" },
  { when: "nightly" },
];
const answer = (role: Role, round: 1 | 2, over: Partial<Assessment> = {}) => ({
  member: role,
  round,
  real: "yes",
  introduced_by_change: "yes",
  impact: "The owner check is gone.",
  basis: "static_path",
  evidence_refs: ["file-1"],
  ...over,
});
type Script = Partial<Record<`${Role}-r${1 | 2}`, unknown | Error | "late">>;

function harness(script: Script, over: Partial<CouncilInput> = {}) {
  let clock = 1_000_000;
  const calls: {
    role: Role;
    round: number;
    content: string;
    system: string;
  }[] = [];
  const runs: { command: string[]; version: string }[] = [];
  const stored = new Map<string, unknown>();
  const deadlines: { name: string; ms: number }[] = [];
  const advance = (ms: number) => {
    clock += ms;
  };
  const deps: CouncilDeps = {
    async deadline(name, ms) {
      deadlines.push({ name, ms });
      return clock + ms;
    },
    async complete(member, name, request, deadline) {
      const round = Number(name.slice(-1)) as 1 | 2;
      calls.push({ role: member.role, round, ...request });
      const scripted = script[`${member.role}-r${round}`];
      if (scripted instanceof Error)
        return {
          error: /timeout/.test(scripted.message) ? "timeout" : "vendor_error",
          at: clock,
        };
      if (scripted === "late") {
        // Answers after every other member, past the step's wall budget.
        await new Promise((resolve) => setTimeout(resolve, 20));
        clock += 100_000;
      }
      if (clock > deadline) return { error: "timeout", at: clock };
      const value =
        scripted === undefined || scripted === "late"
          ? answer(member.role, round)
          : scripted;
      return {
        response: {
          content: JSON.stringify(value),
          input_tokens: 100,
          output_tokens: 10,
          cost_usd: null,
        },
        at: clock,
      };
    },
    async run(_name, command, version) {
      runs.push({ command, version });
      const failing = version === "head" && command.includes("auth");
      return {
        outcome: "exited",
        kind: "run",
        command,
        job_id: "x",
        attempt: 1,
        exit_code: failing ? 1 : 0,
        stdout: failing ? "EXPERIMENT OUTPUT failing" : "EXPERIMENT OUTPUT ok",
        stderr: "",
        timed_out: false,
        truncated: false,
        version,
        seconds: 2.5,
      } as ExecutionResult & { seconds: number };
    },
    async put(key, value) {
      stored.set(key, value);
      return key;
    },
  };
  const input: CouncilInput = {
    review: "r1",
    verified: [verified],
    votes: async () => votes,
    executions,
    graphs,
    hops: 1,
    files: async () => packInput.files,
    intent: packInput.intent,
    guidance: packInput.guidance,
    plan,
    changed: ["src/auth.ts"],
    nightly: false,
    fork: false,
    rules: RULES,
    settings,
    members,
    composition: compose(members, settings, entries, null, false),
    weights: {},
    ...over,
  };
  return {
    deps,
    input,
    calls,
    runs,
    stored,
    deadlines,
    advance,
    run: () => runCouncil(input, deps),
  };
}

describe("trigger selection", () => {
  const v = (id: string, over: any = {}) => ({
    ...verified,
    ...over,
    hypothesis: { ...verified.hypothesis, id, ...(over.hypothesis ?? {}) },
    verification: {
      ...verified.verification,
      split: false,
      ...(over.verification ?? {}),
    },
  });
  const quiet = v("q", {
    evidence_level: "static_proven",
    hypothesis: { severity: "warning" },
  });
  it("selects on each of the five triggers and records the rule", () => {
    const cases: [any, Partial<Plan>, boolean, string][] = [
      [v("a"), {}, false, RULES[0].when],
      [
        v("b", {
          hypothesis: { severity: "warning" },
          verification: { split: true },
        }),
        {},
        false,
        "verify.split",
      ],
      [
        quiet,
        { risk: { tier: "high", reasons: [], source: "triage" } },
        false,
        "risk_tier == high",
      ],
      [quiet, { mode: "deep" }, false, "mode == deep"],
      [quiet, {}, true, "nightly"],
    ];
    for (const [candidate, over, nightly, rule] of cases) {
      const result = select(
        [candidate],
        RULES,
        { ...plan, ...over } as Plan,
        [],
        nightly,
        5,
      );
      expect(
        result.selected.map((s) => s.rule),
        rule,
      ).toEqual([rule]);
    }
    expect(select([quiet], RULES, plan, [], false, 5).selected).toEqual([]);
  });
  it("caps by severity and evidence with stable ordering and counts the rest", () => {
    const many = ["g", "f", "e", "d", "c", "b", "a"].map((id, i) =>
      v(id, {
        hypothesis: { severity: i < 2 ? "warning" : "error" },
        verification: { split: true },
      }),
    );
    const result = select(many, RULES, plan, [], false, 5);
    expect(result.selected.map((s) => s.verified.hypothesis.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
    expect(result.not_councilled).toEqual(["f", "g"]);
  });
  it("makes no council call when nothing matches", async () => {
    const quietOnly = harness({}, { verified: [quiet] });
    const outcome = await quietOnly.run();
    expect(quietOnly.calls).toEqual([]);
    expect(outcome.metrics.councilled).toBe(0);
    expect(outcome.verified).toEqual([]);
  });
});

describe("round 1 and degradation", () => {
  it("runs a full council with the same pack hash for every member", async () => {
    const h = harness({});
    const outcome = await h.run();
    expect(h.calls.filter((c) => c.round === 1)).toHaveLength(5);
    const firstRound = outcome.audit.filter((a) => a.round === 1);
    expect(new Set(firstRound.map((a) => a.pack_hash)).size).toBe(1);
    const council = outcome.verified[0].council!;
    expect(council).toMatchObject({ partial: false, answered: 5, total: 5 });
    expect(council.author_family).toEqual({ status: "not_applicable" });
    expect(outcome.metrics.findings[0].status).toBe("complete");
  });
  it("proceeds partial when two vendors time out", async () => {
    const h = harness({
      "code-owner-r1": "late",
      "maintainer-r1": new Error("The operation was aborted due to timeout"),
    });
    const outcome = await h.run();
    const council = outcome.verified[0].council!;
    expect(council).toMatchObject({ partial: true, answered: 3, total: 5 });
    expect(
      council.members.filter((m) => m.abstained).map((m) => m.cause),
    ).toEqual(["timeout", "timeout"]);
    // Late answers are never shown to other members in round 2.
    const second = h.calls.filter((c) => c.round === 2);
    expect(second.map((c) => c.role).sort()).toEqual([
      "exploit-author",
      "skeptic",
      "tester",
    ]);
    expect(outcome.metrics.findings[0].status).toBe("partial");
  });
  it("skips with fewer than min_members answers and keeps the verifier result", async () => {
    const failure = new Error("upstream 503");
    const h = harness({
      "skeptic-r1": failure,
      "exploit-author-r1": failure,
      "code-owner-r1": failure,
      "maintainer-r1": { ...answer("maintainer", 1), evidence_refs: [] },
    });
    const outcome = await h.run();
    const result = outcome.verified[0];
    expect(result.evidence_level).toBe(verified.evidence_level);
    expect(result.council).toMatchObject({
      skipped: true,
      answered: 1,
      total: 5,
    });
    expect(result.council!.decision).toBeUndefined();
    expect(result.council!.members.map((m) => m.cause ?? "answered")).toEqual([
      "vendor_error",
      "vendor_error",
      "vendor_error",
      "no_evidence_refs",
      "answered",
    ]);
    expect(h.calls.some((c) => c.round === 2)).toBe(false);
    expect(h.runs).toEqual([]);
    expect(outcome.metrics.findings[0].status).toBe("skipped");
  });
  it("counts invalid output and extra prose as abstentions and ignores tool requests", async () => {
    const h = harness({
      "skeptic-r1": "not json",
      "tester-r1": { ...answer("tester", 1), reasoning: "free prose" },
      "code-owner-r1": {
        ...answer("code-owner", 1),
        tools: [{ name: "read_file", args: { path: "secrets.env" } }],
      },
    });
    const outcome = await h.run();
    const first = outcome.audit.filter((a) => a.round === 1);
    expect(first.find((a) => a.member === "skeptic")!.cause).toBe("invalid");
    expect(first.find((a) => a.member === "tester")!.cause).toBe("invalid");
    const owner = first.find((a) => a.member === "code-owner")!;
    expect(owner).toMatchObject({ abstained: false, ignored_request: true });
  });
});

describe("experiments", () => {
  const request = (
    command: string[],
    version: "base" | "head" | "both" = "both",
  ) => ({
    command,
    version,
    expect: "fails" as const,
  });
  it("deduplicates by normalized command and version and chooses by weight", () => {
    const { chosen, capped } = chooseExperiments(
      [
        { role: "skeptic", weight: 1, request: request(["npm", "test"]) },
        { role: "maintainer", weight: 1, request: request(["npm", "test"]) },
        {
          role: "code-owner",
          weight: 1,
          request: request(["npm", "test"], "head"),
        },
        { role: "tester", weight: 3, request: request(["npm", "run", "e2e"]) },
        {
          role: "exploit-author",
          weight: 2,
          request: request(["npm", "test"]),
        },
      ],
      2,
    );
    expect(chosen).toEqual([
      request(["npm", "run", "e2e"]),
      request(["npm", "test"]),
    ]);
    expect(capped).toEqual([request(["npm", "test"], "head")]);
  });
  it("runs chosen experiments, shares them in round 2 and reproduces", async () => {
    const auth = request(["npm", "test", "--", "auth"]);
    const h = harness({
      "tester-r1": { ...answer("tester", 1), experiment_request: auth },
      "skeptic-r1": { ...answer("skeptic", 1), experiment_request: auth },
    });
    const outcome = await h.run();
    expect(h.runs).toEqual([
      { command: auth.command, version: "base" },
      { command: auth.command, version: "head" },
    ]);
    const council = outcome.verified[0].council!;
    expect(council).toMatchObject({
      decision: "reproduced",
      tier: "experiment",
    });
    expect(council.experiments).toEqual([
      {
        ...auth,
        run: true,
        outcome: { base: "passed", head: "failed" },
        artifact: "exp-1",
      },
    ]);
    expect(outcome.verified[0].evidence_level).toBe("reproduced");
    // Every round-2 request carries the experiment result.
    for (const call of h.calls.filter((c) => c.round === 2))
      expect(call.content).toContain('"id":"exp-1"');
    expect(outcome.metrics.findings[0].cost).toMatchObject({
      members: 5,
      rounds: 2,
      experiments: 1,
      runner_seconds: 5,
    });
  });
  it("records each member's family and per-round answer for presentation", async () => {
    const auth = request(["npm", "test", "--", "auth"]);
    const h = harness({
      "tester-r1": { ...answer("tester", 1), experiment_request: auth },
      "skeptic-r1": answer("skeptic", 1, { real: "no" }),
      "skeptic-r2": answer("skeptic", 2, {
        real: "yes",
        changed_from: { real: "no" },
        changed_to: { real: "yes" },
        cites: { kind: "artifact", ref: "exp-1", reason_code: "new_artifact" },
      }),
      "maintainer-r1": new Error("The operation was aborted due to timeout"),
    });
    const outcome = await h.run();
    const byRole = new Map(
      outcome.verified[0].council!.members.map((m) => [m.role, m]),
    );
    expect(byRole.get("skeptic")).toEqual({
      role: "skeptic",
      abstained: false,
      family: "claude",
      rounds: [
        { round: 1, real: "no" },
        { round: 2, real: "yes", changed: true },
      ],
    });
    expect(byRole.get("maintainer")).toEqual({
      role: "maintainer",
      abstained: true,
      cause: "timeout",
      family: "claude",
      rounds: [{ round: 1, cause: "timeout" }],
    });
    expect(byRole.get("exploit-author")!.rounds).toEqual([
      { round: 1, real: "yes" },
      { round: 2, real: "yes" },
    ]);
    expect(() =>
      validateFinding({
        ...findingOf(outcome.verified[0]),
        id: "f".repeat(64),
      }),
    ).not.toThrow();
  });
  it("runs nothing on a fork and records every request as not run", async () => {
    const h = harness(
      {
        "tester-r1": {
          ...answer("tester", 1),
          experiment_request: request(["make"]),
        },
      },
      { fork: true },
    );
    const outcome = await h.run();
    expect(h.runs).toEqual([]);
    const council = outcome.verified[0].council!;
    expect(council.static_only).toBe(true);
    expect(council.experiments).toEqual([
      { ...request(["make"]), run: false, reason: "fork" },
    ]);
    // Execution members get the graph-heavy rendering on forks.
    const tester = h.calls.find((c) => c.role === "tester" && c.round === 1)!;
    expect(tester.content).not.toContain("runnable artifacts");
  });
});

describe("round 2", () => {
  const first = answer("tester", 1) as Assessment;
  const known = new Set(["file-1", "exp-1", "letter:A", "letter:B"]);
  it("accepts a change citing another member's letter", () => {
    const second = {
      ...first,
      round: 2,
      real: "no",
      changed_from: { real: "yes" },
      changed_to: { real: "no" },
      cites: {
        kind: "assessment",
        ref: "B",
        reason_code: "missing_protection",
      },
    } as Assessment;
    expect(settle(first, second, known, "A")).toEqual({ final: second });
  });
  it("keeps round 1 on an invalid or missing citation, or a self-citation", () => {
    const change = { ...first, round: 2, real: "no" } as Assessment;
    expect(settle(first, change, known, "A")).toEqual({
      final: first,
      ignored: "no_citation",
    });
    const cited = (ref: string, kind = "artifact") =>
      ({
        ...change,
        changed_from: { real: "yes" },
        changed_to: { real: "no" },
        cites: { kind, ref, reason_code: "new_artifact" },
      }) as Assessment;
    expect(settle(first, cited("exp-9"), known, "A")).toEqual({
      final: first,
      ignored: "invalid_citation",
    });
    expect(settle(first, cited("A", "assessment"), known, "A").ignored).toBe(
      "invalid_citation",
    );
    expect(settle(first, cited("exp-1"), known, "A").final.real).toBe("no");
    expect(settle(first, null, known, "A")).toEqual({ final: first });
  });
  it("hides roles behind letters and records ignored changes", async () => {
    const h = harness({
      "skeptic-r2": { ...answer("skeptic", 2), real: "no", basis: "none" },
    });
    const outcome = await h.run();
    const skeptic = h.calls.find((c) => c.role === "skeptic" && c.round === 2)!;
    const others = /<repository_data label="other assessments">\n(.*)\n/.exec(
      skeptic.content,
    )![1];
    for (const role of ROLES) expect(others).not.toContain(`"${role}"`);
    expect(
      outcome.audit.find((a) => a.member === "skeptic" && a.round === 2)!
        .ignored_change,
    ).toBe("no_citation");
    expect(new Set(lettersFor("x", ROLES).values()).size).toBe(5);
  });
  it("runs one round when max_rounds is 1", async () => {
    const h = harness({}, { settings: { ...settings, max_rounds: 1 } });
    await h.run();
    expect(h.calls.every((c) => c.round === 1)).toBe(true);
  });
});

describe("audit", () => {
  it("lists every pack sent with hashes, sizes and vendors, never content", async () => {
    const h = harness({});
    const outcome = await h.run();
    // Five members over two rounds.
    expect(outcome.audit).toHaveLength(10);
    for (const entry of outcome.audit) {
      expect(entry.pack_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.rendering_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.pack_bytes).toBeGreaterThan(0);
      expect(entry.vendor).toMatch(/^(anthropic|openai|google)$/);
    }
    const text = JSON.stringify(outcome.audit);
    for (const fragment of ["check()", "doc.owner", "Simplify", "return doc"])
      expect(text).not.toContain(fragment);
  });
});

describe("review fixes", () => {
  const auth = {
    command: ["npm", "test", "--", "auth"],
    version: "both" as const,
    expect: "fails" as const,
  };
  it("records a lost experiment runner and still decides", async () => {
    const h = harness({
      "tester-r1": { ...answer("tester", 1), experiment_request: auth },
    });
    h.deps.run = async () => {
      throw new Error("waitForEvent timed out");
    };
    const outcome = await h.run();
    const council = outcome.verified[0].council!;
    expect(council.experiments).toEqual([
      { ...auth, run: false, reason: "runner_unavailable" },
    ]);
    expect(council.decision).toBe("plausible");
  });
  it("gives round 2 only what round 1 left of the timeout", async () => {
    const h = harness({});
    const complete = h.deps.complete;
    h.deps.complete = async (member, name, request, deadline) => {
      // Round 1 answers after 60 of the 90 seconds.
      if (name.endsWith("r1") && member.role === "skeptic") h.advance(60_000);
      return complete(member, name, request, deadline);
    };
    await h.run();
    expect(h.deadlines.map((d) => d.ms)).toEqual([90_000, 30_000]);
  });
  it("keeps skipped output_contains experiments valid against finding-v1", async () => {
    const contains = {
      command: ["make"],
      version: "head" as const,
      expect: "output_contains" as const,
      contains: "boom",
    };
    const h = harness(
      { "tester-r1": { ...answer("tester", 1), experiment_request: contains } },
      { fork: true },
    );
    const outcome = await h.run();
    expect(outcome.verified[0].council!.experiments).toEqual([
      {
        command: ["make"],
        version: "head",
        expect: "output_contains",
        run: false,
        reason: "fork",
      },
    ]);
    expect(() =>
      validateFinding({
        ...structuredClone(fixtureFinding),
        council: findingOf(outcome.verified[0]).council,
      }),
    ).not.toThrow();
  });
  it("shows round 2 exit codes but never experiment output, and hashes what was sent", async () => {
    const h = harness({
      "tester-r1": { ...answer("tester", 1), experiment_request: auth },
    });
    const outcome = await h.run();
    // A command could print files the pack leaves out: no output text is sent.
    for (const call of h.calls.filter((c) => c.round === 2)) {
      expect(call.content).not.toContain("EXPERIMENT OUTPUT");
      expect(call.content).toContain('"exit_code":1');
    }
    const tester = outcome.audit.filter((a) => a.member === "tester");
    expect(tester[0].rendering_hash).not.toBe(tester[1].rendering_hash);
    expect(tester[1].rendering_bytes).toBeGreaterThan(
      tester[0].rendering_bytes,
    );
  });
});

describe("second review", () => {
  it("builds and stores no pack when too few members can take part", async () => {
    const h = harness(
      {},
      {
        composition: compose(members, { vendors_allowed: [] }, [], null, false),
      },
    );
    let read = 0;
    h.input.files = async () => {
      read++;
      return {};
    };
    const outcome = await h.run();
    expect(outcome.verified[0].council!.skipped).toBe(true);
    expect(read).toBe(0);
    expect([...h.stored.keys()].some((k) => k.includes("/pack-"))).toBe(false);
  });
  it("reports a returned runner failure as an unavailable runner", async () => {
    const auth = {
      command: ["npm", "test"],
      version: "head" as const,
      expect: "fails" as const,
    };
    const h = harness({
      "tester-r1": { ...answer("tester", 1), experiment_request: auth },
    });
    const run = h.deps.run;
    h.deps.run = async (name, command, version) => ({
      ...(await run(name, command, version)),
      outcome: "runner_failed",
    });
    const outcome = await h.run();
    expect(outcome.verified[0].council!.experiments).toEqual([
      { ...auth, run: false, reason: "runner_unavailable" },
    ]);
  });
  it("counts the tokens of a late answer", async () => {
    const h = harness({});
    h.deps.complete = async (member, name) =>
      member.role === "skeptic" && name.endsWith("r1")
        ? {
            error: "timeout",
            at: 0,
            usage: { input_tokens: 500, output_tokens: 7 },
          }
        : {
            response: {
              content: JSON.stringify(
                answer(member.role, Number(name.slice(-1)) as 1 | 2),
              ),
              input_tokens: 1,
              output_tokens: 1,
              cost_usd: null,
            },
            at: 0,
          };
    const outcome = await h.run();
    expect(
      outcome.metrics.findings[0].cost.tokens.anthropic,
    ).toBeGreaterThanOrEqual(507);
  });
});

describe("independent review fixes: step", () => {
  it("keeps audit entries of calls made before a failure", async () => {
    const audit: any[] = [];
    const h = harness({}, { audit });
    const put = h.deps.put;
    h.deps.put = async (key, value) => {
      if (key.includes("-r1.json")) throw new Error("R2 unavailable");
      return put(key, value);
    };
    await expect(h.run()).rejects.toThrow("R2 unavailable");
    expect(audit.length).toBeGreaterThan(0);
    expect(audit[0].pack_hash).toMatch(/^[a-f0-9]{64}$/);
  });
  it("charges the runner time of an experiment that failed part-way", async () => {
    const both = {
      command: ["npm", "test"],
      version: "both" as const,
      expect: "fails" as const,
    };
    const h = harness({
      "tester-r1": { ...answer("tester", 1), experiment_request: both },
    });
    const run = h.deps.run;
    h.deps.run = async (name, command, version) => {
      const result = await run(name, command, version);
      return version === "head"
        ? { ...result, outcome: "runner_failed" }
        : { ...result, seconds: 30 };
    };
    const outcome = await h.run();
    expect(outcome.verified[0].council!.experiments[0]).toMatchObject({
      run: false,
      reason: "runner_unavailable",
    });
    // 30 s on base and the failed head run's 2.5 s.
    expect(outcome.metrics.findings[0].cost.runner_seconds).toBe(33);
  });
  it("records the category weights were looked up under", async () => {
    const outcome = await harness({}).run();
    expect(outcome.verified[0].council!.weight_category).toBe("security");
  });
});

describe("round 5: runner time", () => {
  it("counts the runner time of self-hosted calls", async () => {
    const h = harness({});
    const complete = h.deps.complete;
    h.deps.complete = async (member, name, request, deadline) => {
      const result = await complete(member, name, request, deadline);
      return "response" in result ? { ...result, seconds: 4 } : result;
    };
    const outcome = await h.run();
    // Ten calls of four seconds each.
    expect(outcome.metrics.findings[0].cost.runner_seconds).toBe(40);
  });
});

describe("round 7: unchanged positions keep their evidence", () => {
  it("uses the round-2 references of an unchanged position", () => {
    const first = answer("skeptic", 1, {
      real: "no",
      basis: "protection_found",
      evidence_refs: ["base-1"],
    }) as Assessment;
    const second = {
      ...first,
      round: 2,
      evidence_refs: ["head-2"],
    } as Assessment;
    expect(settle(first, second, new Set(), "A")).toEqual({ final: second });
  });
});

import {
  env,
  applyD1Migrations,
  introspectWorkflowInstance,
} from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Store } from "../src/storage";
import { NO_CONSUMER } from "../src/validation";
import { allMigrations, submission } from "./fixtures";
import { storeSnapshot } from "./snapshots";
import type { Env, Graph, Snapshot, Submission } from "../src/types";
const runtime = env as Env;
beforeAll(async () => {
  await applyD1Migrations(runtime.DB, allMigrations);
});

type Files = Record<string, string>;
const tree = (files: Files) =>
  Object.fromEntries(
    Object.entries(files).map(([p, content]) => [
      p,
      { mode: 0o100644, content },
    ]),
  );
function block(content: string, label: string): any {
  const start = content.indexOf(`<repository_data label="${label}">\n`);
  if (start < 0) return undefined;
  const from = content.indexOf("\n", start) + 1;
  return JSON.parse(
    content.slice(from, content.indexOf("\n</repository_data>", from)),
  );
}
interface Run {
  base: Files;
  head: Files;
  changed: string[];
  graphs?: { base: Graph; head: Graph };
  steps: Submission["profile"]["steps"];
  /** Generation result per agent; anything else returns an empty array. */
  agents: Record<string, unknown>;
  /** Raw provider content per agent, replacing the wrapped result. */
  raw?: Record<string, string>;
  /** Generation results per agent in call order, the last one repeating. */
  turns?: Record<string, unknown[]>;
  /** Disclosed verification answer for a hypothesis. */
  vote?: (h: any) => unknown;
  mutate?: (s: Submission) => void;
}
async function review(run: Run) {
  const prompts: Record<string, string> = {};
  const latest: Record<string, string> = {};
  const calls: string[] = [];
  const transport = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const body = JSON.parse(init!.body as string);
      const users = body.messages.filter((m: any) => m.role === "user");
      const first: string = users[0].content,
        last: string = users.at(-1).content;
      const agent = /Review the change independently for (\w+)\./.exec(
        first,
      )?.[1];
      let result: unknown = [];
      let raw: string | undefined;
      if (agent) {
        prompts[agent] = first;
        latest[agent] = last;
        const turns = run.turns?.[agent],
          turn = calls.filter((c) => c === agent).length;
        calls.push(agent);
        result = turns
          ? turns[Math.min(turn, turns.length - 1)]
          : (run.agents[agent] ?? []);
        raw = run.raw?.[agent];
      } else if (last.startsWith("Verify this hypothesis.")) {
        calls.push("verify");
        result = run.vote?.(block(last, "hypothesis")) ?? {
          evidence_level: "plausible",
          evidence: [],
        };
      } else calls.push("blind");
      const content = raw ?? JSON.stringify({ result });
      return Response.json(
        String(input).includes("anthropic")
          ? {
              content: [{ type: "text", text: content }],
              usage: { input_tokens: 80, output_tokens: 50 },
            }
          : {
              choices: [{ message: { content } }],
              usage: { prompt_tokens: 80, completion_tokens: 50 },
            },
      );
    });
  try {
    const store = new Store(runtime),
      id = crypto.randomUUID(),
      s = submission();
    const snapshot: Snapshot = { base: tree(run.base), head: tree(run.head) };
    s.changed = run.changed.map((path) => ({ path, lines_changed: 2 }));
    s.graphs = run.graphs ?? {
      base: { nodes: [], edges: [] },
      head: { nodes: [], edges: [] },
    };
    s.profile.steps = run.steps;
    // Voters read the hypothesis, both versions and the graph; give them room.
    s.profile.budget.fast.verify_tokens = 40000;
    run.mutate?.(s);
    const stored = await storeSnapshot(runtime, snapshot);
    const key = await store.put(`reviews/${id}/submission.json`, {
      ...s,
      snapshot_id: stored.id,
    });
    await runtime.DB.prepare(
      "INSERT INTO reviews(id,tenant,submission_key,status,created_at,token_limit,deadline) VALUES(?,?,?,'queued',?,?,?)",
    )
      .bind(id, "owner", key, Date.now(), 100000, Date.now() + 240000)
      .run();
    await using instance = await introspectWorkflowInstance(
      runtime.REVIEWS,
      id,
    );
    await runtime.REVIEWS.create({
      id,
      params: { review_id: id, snapshot_key: stored.key },
    });
    await instance.waitForStatus("complete");
    const row = await runtime.DB.prepare(
      "SELECT report_key FROM reviews WHERE id=?",
    )
      .bind(id)
      .first<any>();
    return {
      report: await store.get<any>(row.report_key),
      prompts,
      latest,
      calls,
    };
  } finally {
    transport.mockRestore();
  }
}
const agentSteps = (agents: any[] = []) => [
  { id: "triage", uses: "rio/triage@0.1.0", needs: [], with: {} },
  {
    id: "agents",
    uses: "rio/agents@0.1.0",
    needs: ["triage"],
    with: {},
    agents,
  },
  { id: "verify", uses: "rio/verify@0.1.0", needs: ["agents"], with: {} },
];
const at = (path: string, line: number, symbol_path = "") => ({
  path,
  line_start: line,
  line_end: line,
  symbol_path,
});

describe("contracts agent", () => {
  const base = {
    "src/routes.ts": `app.get("/v1/users", list);\napp.delete("/v1/sessions/:id", remove);\n`,
    "src/client.ts": `export async function logout(id: string) {\n  await fetch("/v1/sessions/" + id, { method: "DELETE" });\n}\n`,
    "src/api.ts": `export function createUser(name: string) {\n  return name;\n}\n`,
  };
  const head = {
    ...base,
    "src/routes.ts": `app.get("/v1/users", list);\n`,
    "src/api.ts": `export function createUser(name: string, email: string) {\n  return name + email;\n}\n`,
  };
  const graph = {
    nodes: [
      {
        id: "c",
        path: "src/client.ts",
        symbol_path: "client.logout",
        line_start: 1,
        line_end: 3,
      },
      {
        id: "u",
        path: "src/api.ts",
        symbol_path: "api.createUser",
        line_start: 1,
        line_end: 3,
      },
      // The router module the client's session call resolves to.
      {
        id: "r",
        path: "src/routes.ts",
        symbol_path: "routes",
        line_start: 1,
        line_end: 1,
      },
    ],
    edges: [{ from: "c", to: "r", kind: "references" }],
  };
  const removedRoute = {
    rule_id: "contracts/route/removed",
    category: "defect",
    severity: "error",
    location: at("src/routes.ts", 2, "routes"),
    locations: [
      at("src/routes.ts", 2, "routes"),
      at("src/client.ts", 2, "client.logout"),
    ],
    message: "DELETE /v1/sessions/:id was removed but logout() still calls it.",
    trigger: "logout(id) after the deployment",
  };
  const addedRequired = {
    rule_id: "contracts/signature/added_required",
    category: "risk",
    severity: "warning",
    location: at("src/api.ts", 1, "api.createUser"),
    message: "createUser now requires email.",
    trigger: "createUser(name) from an external caller",
  };
  const singleDefect = {
    ...addedRequired,
    rule_id: "contracts/signature/changed",
    category: "defect",
    trigger: "createUser(name)",
  };
  const unknownRule = { ...removedRoute, rule_id: "contracts/api/broken" };

  it("is selected by public_contracts, reports a removed route with its consumer and a consumer-less risk, and rejects malformed hypotheses", async () => {
    const { report, prompts } = await review({
      base,
      head,
      changed: ["src/api.ts", "src/routes.ts"],
      graphs: { base: graph, head: graph },
      steps: agentSteps(),
      agents: {
        contracts: [removedRoute, addedRequired, singleDefect, unknownRule],
      },
      vote: (h) =>
        h.rule_id === "contracts/route/removed"
          ? {
              evidence_level: "static_proven",
              evidence: [
                {
                  kind: "code",
                  version: "head",
                  path: "src/client.ts",
                  node_ids: ["c", "r"],
                  demonstrates: "regression",
                },
              ],
            }
          : { evidence_level: "plausible", evidence: [] },
    });
    expect(report.agent_audit.agents).toEqual({
      correctness: "default",
      contracts: "public_contract_change",
    });
    // The inventory is data inside its block, with the consumer of the removed route.
    const inventory = block(prompts.contracts, "contract inventory");
    const route = inventory.find(
      (e: any) => e.name === "DELETE /v1/sessions/:id",
    );
    expect(route).toMatchObject({ kind: "endpoint", change: "removed" });
    expect(route.consumers.base[0].path).toBe("src/client.ts");
    expect(inventory.find((e: any) => e.name === "createUser").change).toBe(
      "changed",
    );
    expect(prompts.contracts).toContain("contracts/<kind>/<break>");
    expect(prompts.correctness).not.toContain("contract inventory");

    const defect = report.findings.find(
      (f: any) => f.rule_id === "contracts/route/removed",
    );
    expect(defect).toMatchObject({
      category: "defect",
      evidence_level: "static_proven",
    });
    expect(defect.locations.map((l: any) => l.path)).toEqual([
      "src/routes.ts",
      "src/client.ts",
    ]);
    const risk = report.risks.find(
      (f: any) => f.rule_id === "contracts/signature/added_required",
    );
    expect(risk.category).toBe("risk");
    expect(risk.impact).toContain(NO_CONSUMER);
    expect(
      report.agent_audit.rejected.map((r: any) => [r.rule_id, r.reason]),
    ).toEqual([
      [
        "contracts/signature/changed",
        "a contract defect needs the producer and a consumer",
      ],
      ["contracts/api/broken", "rule id outside contracts/<kind>/<break>"],
    ]);
    expect(
      report.findings.concat(report.risks).map((f: any) => f.rule_id),
    ).not.toContain("contracts/api/broken");
  }, 60000);

  it("accepts a generation result wrapped as {hypotheses: [...]}", async () => {
    const { report } = await review({
      base,
      head,
      changed: ["src/api.ts"],
      steps: agentSteps([{ correctness: { model: "default" } }]),
      // Identical changes across these tests must not share the agent result cache.
      mutate: (s) => {
        s.profile.steps[1].with = { cache: false };
      },
      agents: {
        correctness: {
          hypotheses: [
            {
              rule_id: "correctness/unchecked-input",
              category: "risk",
              severity: "warning",
              location: at("src/api.ts", 1, "api.createUser"),
              message: "createUser trusts its email argument.",
              trigger: "createUser(name, email) with an empty email",
              limitations: ["read only, no test run"],
            },
          ],
        },
      },
    });
    expect(report.status).not.toBe("partial");
    expect(
      [...report.findings, ...report.risks].map((f: any) => f.rule_id),
    ).toEqual(["correctness/unchecked-input"]);
  }, 60000);

  it("ends only the agent whose result is not a hypothesis array", async () => {
    const { report, calls } = await review({
      base,
      head,
      changed: ["src/api.ts"],
      steps: agentSteps([{ correctness: { model: "default" } }]),
      // Identical changes across these tests must not share the agent result cache.
      mutate: (s) => {
        s.profile.steps[1].with = { cache: false };
      },
      agents: { correctness: { not: "an array" } },
    });
    expect(calls).toContain("correctness");
    expect(report.status).toBe("partial");
    expect(
      report.footer.notes.some((n: string) =>
        /^correctness agent failed: expected hypothesis array/.test(n),
      ),
    ).toBe(true);
    expect(report.findings.concat(report.risks)).toEqual([]);
  }, 60000);

  it("rejects a malformed hypothesis on its own and keeps the agent's well-formed ones", async () => {
    const { report } = await review({
      base,
      head,
      changed: ["src/api.ts"],
      steps: agentSteps([{ correctness: { model: "default" } }]),
      // Identical changes across these tests must not share the agent result cache.
      mutate: (s) => {
        s.profile.steps[1].with = { cache: false };
      },
      agents: {
        correctness: [
          {
            rule_id: "correctness/unchecked-input",
            category: "risk",
            severity: "warning",
            location: at("src/api.ts", 1, "api.createUser"),
            message: "createUser trusts its email argument.",
            trigger: "createUser(name, email) with an empty email",
          },
          {
            rule_id: "correctness/bad-trace",
            category: "risk",
            severity: "warning",
            location: at("src/api.ts", 1, "api.createUser"),
            message: "Carries an agent key with a value outside its enum.",
            trigger: "any call",
            trace_change: "not-a-valid-value",
          },
        ],
      },
    });
    expect(report.status).not.toBe("partial");
    expect(
      [...report.findings, ...report.risks].map((f: any) => f.rule_id),
    ).toEqual(["correctness/unchecked-input"]);
    const rejected = report.agent_audit.rejected;
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      agent: "correctness",
      rule_id: "correctness/bad-trace",
    });
    expect(rejected[0].reason).toMatch(/^malformed hypothesis: .*trace_change/);
  }, 60000);

  it("does not run on body-only changes and records why", async () => {
    const { report, calls } = await review({
      base: { "src/a.ts": "function a() { return 0; }\n" },
      head: { "src/a.ts": "function a() { return 1; }\n" },
      changed: ["src/a.ts"],
      steps: agentSteps(),
      agents: { contracts: [removedRoute] },
    });
    expect(calls).not.toContain("contracts");
    expect(report.agent_audit.agents).toEqual({ correctness: "default" });
    expect(report.agent_audit.agents_skipped.contracts).toContain(
      "public_contracts signal did not fire",
    );
  }, 60000);

  it("skips a public-contract signal whose inventory is empty unless the profile names the agent", async () => {
    const files = (v: number) => ({
      "proto/user.proto": `message User { string name = ${v}; }\n`,
    });
    const { report, calls } = await review({
      base: files(1),
      head: files(2),
      changed: ["proto/user.proto"],
      steps: agentSteps(),
      agents: {},
    });
    expect(calls).not.toContain("contracts");
    expect(report.agent_audit.agents_skipped.contracts).toContain(
      "contract inventory is empty",
    );
    expect(report.footer.notes.join(" ")).toContain(
      "Contracts agent did not run",
    );
    const named = await review({
      base: files(1),
      head: files(2),
      changed: ["proto/user.proto"],
      steps: agentSteps([{ contracts: { model: "default" } }]),
      agents: {},
    });
    expect(named.calls).toContain("contracts");
  }, 60000);
});

describe("contract verification", () => {
  // contracts-agent spec, "Consumer updated in head": the verifier cites the
  // updated caller and the hypothesis is refuted.
  const base = {
    "src/api.ts": `export function createUser(name: string) {\n  return name;\n}\n`,
    "src/signup.ts": `import { createUser } from "./api";\nexport function signup(name: string) {\n  return createUser(name);\n}\n`,
  };
  const head = {
    "src/api.ts": `export function createUser(name: string, email: string) {\n  return name + email;\n}\n`,
    "src/signup.ts": `import { createUser } from "./api";\nexport function signup(name: string, email: string) {\n  return createUser(name, email);\n}\n`,
  };
  const graph = (signupHash: string) => ({
    nodes: [
      {
        id: "p",
        path: "src/api.ts",
        symbol_path: "api.createUser",
        line_start: 1,
        line_end: 3,
        content_hash: "p" + signupHash,
      },
      {
        id: "s",
        path: "src/signup.ts",
        symbol_path: "signup.signup",
        line_start: 2,
        line_end: 4,
        content_hash: signupHash,
      },
    ],
    edges: [{ from: "s", to: "p", kind: "calls" }],
  });
  const claim = {
    rule_id: "contracts/signature/added_required",
    category: "defect",
    severity: "error",
    location: at("src/api.ts", 1, "api.createUser"),
    locations: [
      at("src/api.ts", 1, "api.createUser"),
      at("src/signup.ts", 3, "signup.signup"),
    ],
    message:
      "createUser now requires email but signup still calls it with the name only.",
    trigger: "signup(name)",
  };

  it("refutes a claimed break when head also updated the consumer", async () => {
    const { report, calls } = await review({
      base,
      head,
      changed: ["src/api.ts", "src/signup.ts"],
      graphs: { base: graph("old"), head: graph("new") },
      steps: agentSteps(),
      agents: { contracts: [claim] },
      vote: () => ({
        evidence_level: "refuted",
        evidence: [
          {
            kind: "code",
            version: "head",
            path: "src/signup.ts",
            node_ids: ["s"],
            demonstrates: "protection",
          },
        ],
      }),
    });
    expect(calls.filter((c) => c === "verify")).toHaveLength(3);
    expect(
      report.findings.concat(report.risks).map((f: any) => f.rule_id),
    ).not.toContain("contracts/signature/added_required");
    expect(report.agent_audit.refuted).toBe(1);
  }, 60000);

  it("keeps the claim plausible when the cited protection is off the consumer's path", async () => {
    const offPath = (hash: string) => {
      const g = graph(hash);
      g.nodes.push({
        id: "o",
        path: "src/other.ts",
        symbol_path: "other.check",
        line_start: 1,
        line_end: 1,
        content_hash: "o",
      });
      return g;
    };
    const { report } = await review({
      base: { ...base, "src/other.ts": "export const check = 1;\n" },
      head: { ...head, "src/other.ts": "export const check = 1;\n" },
      changed: ["src/api.ts", "src/signup.ts"],
      graphs: { base: offPath("same"), head: offPath("same") },
      steps: agentSteps(),
      agents: { contracts: [claim] },
      vote: () => ({
        evidence_level: "refuted",
        evidence: [
          {
            kind: "code",
            version: "head",
            path: "src/other.ts",
            node_ids: ["o"],
            demonstrates: "protection",
          },
        ],
      }),
    });
    expect(report.agent_audit.refuted).toBe(0);
    const kept = report.risks.find(
      (f: any) => f.rule_id === "contracts/signature/added_required",
    );
    expect(kept.evidence_level).toBe("plausible");
  }, 60000);
});

describe("security agent", () => {
  const base = {
    "src/api/users.ts": `export async function getUser(req, res) {\n  const name = String(req.query.name).slice(0, 64);\n  const rows = await db.query("SELECT * FROM users WHERE name = ?", [name]);\n  res.json(rows);\n}\napp.get("/users", getUser);\n`,
  };
  const head = {
    "src/api/users.ts": `export async function getUser(req, res) {\n  const name = req.query.name;\n  const rows = await db.query("SELECT * FROM users WHERE name = '" + name + "'");\n  res.json(rows);\n}\napp.get("/users", getUser);\n`,
  };
  const injection = {
    rule_id: "security/sql-injection",
    category: "security",
    severity: "error",
    catalog_item: "A05:2025",
    trace_change: "removed",
    location: at("src/api/users.ts", 3, "users.getUser"),
    locations: [
      at("src/api/users.ts", 2, "users.getUser"),
      at("src/api/users.ts", 3, "users.getUser"),
    ],
    message: "The name query parameter reaches a concatenated SQL string.",
    trigger: "GET /users?name=' OR '1'='1",
  };
  const steps = (enabled: boolean, rules: any[] = []) => [
    { id: "triage", uses: "rio/triage@0.1.0", needs: [], with: {} },
    {
      id: "security",
      uses: "rio/security@0.2.0",
      needs: ["triage"],
      with: { enabled },
      rules,
    },
    { id: "verify", uses: "rio/verify@0.1.0", needs: ["security"], with: {} },
  ];
  const applicable = [
    "A01:2025",
    "A02:2025",
    "A05:2025",
    "A06:2025",
    "A08:2025",
    "A09:2025",
    "A10:2025",
  ];

  it.each(["explicit", "triage"])(
    "runs when enabled by %s, verifies catalog hypotheses and reports catalog coverage",
    async (selection) => {
      const { report, prompts, calls } = await review({
        base,
        head,
        changed: ["src/api/users.ts"],
        steps:
          selection === "explicit"
            ? steps(true)
            : steps(false, [
                { when: "touches('src/api/**')", then: "enable(security)" },
              ]),
        agents: {
          security: {
            hypotheses: [
              injection,
              {
                ...injection,
                catalog_item: undefined,
                rule_id: "security/no-item",
                trigger: "x",
              },
            ],
            assessed: ["A01:2025", "A05:2025", "A10:2025"],
            unassessed: [{ item: "A06:2025", reason: "tools_unavailable" }],
          },
        },
      });
      expect(calls).toContain("security");
      expect(calls).toContain("verify");
      const catalog = block(prompts.security, "catalog");
      expect(catalog.name).toBe("owasp-top10-2025");
      expect(catalog.items.map((i: any) => i.id)).toEqual(applicable);
      expect(
        block(prompts.security, "taint map").taint.some(
          (t: any) => t.name === "sql_query" && t.version === "head",
        ),
      ).toBe(true);
      expect(report.status).toBe("complete");
      expect(report.footer.notes.join(" ")).not.toMatch(
        /unavailable|not performed/,
      );
      expect(report.security).toHaveLength(1);
      const finding = report.security[0];
      expect(finding).toMatchObject({
        category: "security",
        evidence_level: "plausible",
        source: { agent: "security" },
      });
      expect(finding.impact).toContain(
        "Catalog item A05:2025: the change removed a step of its trace.",
      );
      expect(report.security_coverage).toEqual({
        catalog: "owasp-top10-2025",
        assessed: [
          { item: "A01:2025", title: "Broken Access Control", findings: [] },
          { item: "A05:2025", title: "Injection", findings: [finding.id] },
          {
            item: "A10:2025",
            title: "Mishandling of Exceptional Conditions",
            findings: [],
          },
        ],
        unassessed: [
          {
            item: "A02:2025",
            title: "Security Misconfiguration",
            reason: "no_evidence",
          },
          {
            item: "A06:2025",
            title: "Insecure Design",
            reason: "tools_unavailable",
          },
          {
            item: "A08:2025",
            title: "Software or Data Integrity Failures",
            reason: "no_evidence",
          },
          {
            item: "A09:2025",
            title: "Security Logging and Alerting Failures",
            reason: "no_evidence",
          },
        ],
        not_applicable: [
          { item: "A03:2025", title: "Software Supply Chain Failures" },
          { item: "A04:2025", title: "Cryptographic Failures" },
          { item: "A07:2025", title: "Authentication Failures" },
        ],
      });
      expect(report.agent_audit.rejected).toEqual([
        expect.objectContaining({
          agent: "security",
          rule_id: "security/no-item",
          reason: "security hypothesis without catalog_item",
        }),
      ]);
    },
    60000,
  );

  it("ends only the failing agent: a security conversation that never speaks the protocol leaves the other agent's work in a partial report", async () => {
    const { report, calls } = await review({
      base,
      head,
      changed: ["src/api/users.ts"],
      steps: [
        { id: "triage", uses: "rio/triage@0.1.0", needs: [], with: {} },
        {
          id: "agents",
          uses: "rio/agents@0.1.0",
          needs: ["triage"],
          with: {},
          agents: [{ correctness: { model: "default" } }],
        },
        {
          id: "security",
          uses: "rio/security@0.2.0",
          needs: ["triage"],
          with: { enabled: true, catalog: "asvs-5.0" },
        },
        {
          id: "verify",
          uses: "rio/verify@0.1.0",
          needs: ["agents", "security"],
          with: {},
        },
      ],
      agents: {
        correctness: [
          {
            rule_id: "correctness/unchecked-input",
            category: "risk",
            severity: "warning",
            location: at("src/api/users.ts", 1, "users.handler"),
            message: "The handler reads the parameter without a check.",
            trigger: "a request without the parameter",
          },
        ],
      },
      // Every security reply is an empty tool list, which no repair fixes.
      raw: { security: '{"tools":[]}' },
    });
    expect(calls.filter((c) => c === "security").length).toBe(3);
    expect(report.status).toBe("partial");
    expect(
      report.footer.notes.some((n: string) =>
        /^security agent failed: malformed tool output/.test(n),
      ),
    ).toBe(true);
    // The correctness agent's hypothesis was still verified and reported.
    expect(
      [...report.findings, ...report.risks].some(
        (f: any) => f.rule_id === "correctness/unchecked-input",
      ),
    ).toBe(true);
    const coverage = report.security_coverage;
    expect(coverage.assessed).toEqual([]);
    expect(
      coverage.unassessed.length > 0 &&
        coverage.unassessed.every((u: any) => u.reason === "tools_unavailable"),
    ).toBe(true);
  }, 60000);

  it("asks the security agent again for a result without its assessment lists and takes the corrected one", async () => {
    const { report, calls, latest } = await review({
      base,
      head,
      changed: ["src/api/users.ts"],
      steps: steps(true),
      agents: {},
      turns: {
        security: [
          { hypotheses: [], assessed: applicable },
          {
            hypotheses: [],
            assessed: applicable.filter((i) => i !== "A01:2025"),
            unassessed: [{ item: "A01:2025", reason: "budget" }],
          },
        ],
      },
    });
    expect(calls.filter((c) => c === "security").length).toBe(2);
    // The second request names the three lists.
    expect(latest.security).toContain(
      '{"hypotheses":[...],"assessed":[...],"unassessed":[...]}',
    );
    expect(report.status).toBe("complete");
    expect(
      report.footer.notes.filter((n: string) => n.includes("agent failed")),
    ).toEqual([]);
    // Coverage is the corrected result's, not the refused one's.
    expect(report.security_coverage.assessed).toHaveLength(6);
    expect(report.security_coverage.unassessed).toEqual([
      { item: "A01:2025", title: "Broken Access Control", reason: "budget" },
    ]);
  }, 60000);

  it("treats a security result without its assessment lists as a failed agent, never as nothing found", async () => {
    const { report, calls } = await review({
      base,
      head,
      changed: ["src/api/users.ts"],
      steps: [
        { id: "triage", uses: "rio/triage@0.1.0", needs: [], with: {} },
        {
          id: "security",
          uses: "rio/security@0.2.0",
          needs: ["triage"],
          with: { enabled: true, catalog: "asvs-5.0" },
        },
        { id: "verify", uses: "rio/verify@0.1.0", needs: ["security"], with: {} },
      ],
      agents: { security: { hypotheses: [] } },
    });
    // Asked again twice, the limit of consecutive repairs, before it fails.
    expect(calls.filter((c) => c === "security").length).toBe(3);
    expect(report.status).toBe("partial");
    expect(
      report.footer.notes.some((n: string) =>
        /^security agent failed: security result must be an object with hypotheses, assessed and unassessed/.test(n),
      ),
    ).toBe(true);
    const coverage = report.security_coverage;
    expect(coverage.assessed).toEqual([]);
    expect(coverage.unassessed.length).toBeGreaterThan(0);
    expect(coverage.unassessed.every((u: any) => u.reason === "tools_unavailable")).toBe(true);
  }, 60000);

  it("lists assessed and unassessed items when no hypothesis is produced", async () => {
    const { report } = await review({
      base,
      head,
      changed: ["src/api/users.ts"],
      steps: steps(true),
      agents: {
        security: {
          hypotheses: [],
          assessed: applicable.filter(
            (i) => i !== "A01:2025" && i !== "A09:2025",
          ),
          unassessed: [
            { item: "A01:2025", reason: "budget" },
            { item: "A09:2025", reason: "no_evidence" },
          ],
        },
      },
    });
    expect(report.security).toBeUndefined();
    expect(report.security_coverage.assessed).toHaveLength(5);
    expect(report.security_coverage.unassessed).toEqual([
      { item: "A01:2025", title: "Broken Access Control", reason: "budget" },
      {
        item: "A09:2025",
        title: "Security Logging and Alerting Failures",
        reason: "no_evidence",
      },
    ]);
  }, 60000);

  it("uses the profile's catalog and marks every applicable item unassessed when the budget ends", async () => {
    const { report, calls } = await review({
      base,
      head,
      changed: ["src/api/users.ts"],
      steps: [
        { id: "triage", uses: "rio/triage@0.1.0", needs: [], with: {} },
        {
          id: "security",
          uses: "rio/security@0.2.0",
          needs: ["triage"],
          with: { enabled: true, catalog: "asvs-5.0" },
        },
        {
          id: "verify",
          uses: "rio/verify@0.1.0",
          needs: ["security"],
          with: {},
        },
      ],
      agents: {},
      mutate: (s) => {
        s.profile.budget.fast.tokens = 3000;
        s.profile.budget.fast.agents_max = 1;
      },
    });
    expect(calls).not.toContain("security");
    expect(report.status).toBe("complete");
    const coverage = report.security_coverage;
    expect(coverage.catalog).toBe("asvs-5.0");
    expect(coverage.assessed).toEqual([]);
    expect(coverage.unassessed.length).toBeGreaterThan(5);
    expect(coverage.unassessed.every((u: any) => u.reason === "budget")).toBe(
      true,
    );
    // Browser-only items do not apply to a server-side TypeScript change.
    expect(coverage.not_applicable.map((i: any) => i.item)).toContain("V3.6");
    expect(coverage.unassessed.map((i: any) => i.item)).toContain("V1.2");
  }, 60000);
});

import {
  env,
  applyD1Migrations,
  introspectWorkflowInstance,
} from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { Store } from "../src/storage";
import { hash, normalizeTrigger, validateSubmission } from "../src/validation";
import { applyHistory, codeHash, type RegistryRecord } from "../src/history";
import { allMigrations, submission } from "./fixtures";
import { storeSnapshot } from "./snapshots";
import type { Env, Graph, Snapshot, Submission } from "../src/types";

const runtime = env as Env;
beforeAll(async () => {
  await applyD1Migrations(runtime.DB, allMigrations);
});
const owner = {
  authorization: "Bearer test-owner-token-at-least-32-characters",
  "content-type": "application/json",
  "rio-protocol": "1",
};

type Files = Record<string, string>;
const tree = (files: Files) =>
  Object.fromEntries(
    Object.entries(files).map(([p, content]) => [
      p,
      { mode: 0o100644, content },
    ]),
  );
const graphOf = (files: Files): Graph => ({
  nodes: Object.entries(files).map(([path, content]) => ({
    id: `${path}#${path.split("/").at(-1)!.split(".")[0]}`,
    path,
    symbol_path: path.split("/").at(-1)!.split(".")[0],
    line_start: 1,
    line_end: content.replace(/\n$/, "").split("\n").length,
  })),
  edges: [],
});
const hyp = (rule: string, path: string, symbol: string, line = 1) => ({
  rule_id: rule,
  category: "defect",
  severity: "error",
  location: { path, line_start: line, line_end: line, symbol_path: symbol },
  message: `${rule} at ${path}`,
  trigger: `call ${symbol}`,
  state: "new",
});
const idOf = (h: ReturnType<typeof hyp>) =>
  hash(
    `${h.rule_id}\0${h.location.path}\0${h.location.symbol_path}\0${normalizeTrigger(h.trigger)}`,
  );

interface Run {
  base: Files;
  head: Files;
  agents: unknown[];
  repository?: string;
  mutate?: (s: Submission) => void;
}
/** One endpoint review with a scripted correctness agent; votes are plausible. */
async function review(run: Run) {
  const transport = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const body = JSON.parse(init!.body as string);
      const first: string = body.messages.find(
        (m: any) => m.role === "user",
      ).content;
      const last: string = body.messages.at(-1).content;
      const result = /Review the change independently for correctness\./.test(
        first,
      )
        ? run.agents
        : last.startsWith("Verify this hypothesis.")
          ? { evidence_level: "plausible", evidence: [] }
          : [];
      const content = JSON.stringify({ result });
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
    s.changed = Object.keys(run.head)
      .filter((p) => run.base[p] !== run.head[p])
      .map((path) => ({ path, lines_changed: 1 }));
    s.graphs = { base: graphOf(run.base), head: graphOf(run.head) };
    s.profile.steps = [
      {
        id: "agents",
        uses: "rio/agents@0.1.0",
        needs: [],
        with: { cache: false },
        agents: [{ correctness: {} }],
      },
      { id: "verify", uses: "rio/verify@0.1.0", needs: ["agents"], with: {} },
    ];
    s.profile.budget.fast.verify_tokens = 40000;
    if (run.repository !== undefined) s.repository = run.repository;
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
    return { id, report: await store.get<any>(row.report_key) };
  } finally {
    transport.mockRestore();
  }
}
const record = (repository: string, identity: string) =>
  runtime.DB.prepare(
    "SELECT * FROM finding_history WHERE tenant='owner' AND repository=? AND identity=?",
  )
    .bind(repository, identity)
    .first<any>();
const reported = (report: any) => [
  ...report.findings,
  ...report.risks,
  ...(report.security ?? []),
];

describe("code hash", () => {
  const graph: Graph = {
    nodes: [
      { id: "f", path: "a.ts", symbol_path: "f", line_start: 1, line_end: 4 },
      { id: "g", path: "a.ts", symbol_path: "g", line_start: 5, line_end: 6 },
    ],
    edges: [],
  };
  const at = (line: number) => ({
    path: "a.ts",
    line_start: line,
    line_end: line,
  });
  const text =
    "function f() {\n  const x = 1;\n  return x;\n}\nfunction g() {}\n";
  it("hashes the enclosing symbol, ignores whitespace and changes with its body", () => {
    const h = codeHash(at(2), graph, text);
    expect(codeHash(at(3), graph, text)).toBe(h);
    expect(
      codeHash(
        at(2),
        graph,
        text.replace("  const x = 1;", "\tconst   x = 1;  "),
      ),
    ).toBe(h);
    expect(codeHash(at(2), graph, text.replace("x = 1", "x = 2"))).not.toBe(h);
    // Another symbol's edit does not change it.
    expect(
      codeHash(at(2), graph, text.replace("g() {}", "g() { return 1; }")),
    ).toBe(h);
    // Without an enclosing symbol the location's own lines are hashed.
    expect(
      codeHash({ path: "b.ts", line_start: 1, line_end: 1 }, graph, "x\ny\n"),
    ).toBe(
      codeHash({ path: "b.ts", line_start: 1, line_end: 1 }, graph, "x\nz\n"),
    );
    expect(codeHash(at(1), graph, null)).toBeNull();
  });
});

describe("remembered dismissals and history", () => {
  const finding = (id: string, rule = "r") => ({
    id,
    rule_id: rule,
    category: "defect",
    severity: "error",
    evidence_level: "static_proven",
    state: "new",
    location: {
      path: "a.ts",
      line_start: 1,
      line_end: 1,
      symbol_path: "f",
      occurrence_state: "new",
    },
    message: "m",
    trigger: "t",
    evidence: [],
    locations: [],
    source: { agent: "correctness" },
  });
  const rec = (
    identity: string,
    status: "open" | "fixed" | "dismissed",
    reason?: string,
    code_hash: string | null = "h1",
  ): RegistryRecord => ({
    identity,
    rule_id: "r",
    first_seen_review: "rev-1",
    last_seen_review: "rev-2",
    seen_count: 2,
    status,
    author_response_json: reason
      ? JSON.stringify({ reason, actor: "dev", at: "2026-11-01T00:00:00.000Z" })
      : null,
    dismissed_in:
      status === "dismissed"
        ? "github.com/acme/api#41"
        : status === "fixed"
          ? "rev-3"
          : null,
    location_json: "{}",
    code_hash,
    updated_at: 0,
  });
  it("applies each rule of the registry after suppressions", () => {
    const report: any = {
      findings: [
        "new",
        "style",
        "intentional",
        "irrelevant",
        "wrong",
        "fixed",
        "changed",
        "own",
      ].map((id) => finding(id)),
      risks: [],
      security: [finding("sec")],
      checks: [{ findings: [finding("style")] }],
      agent_audit: { policy_failed: true, policy_matches: ["sec"] },
    };
    const records = [
      rec("style", "dismissed", "style"),
      rec("intentional", "dismissed", "intentional"),
      rec("irrelevant", "dismissed", "irrelevant"),
      rec("wrong", "dismissed", "wrong"),
      rec("fixed", "fixed"),
      rec("changed", "dismissed", "irrelevant", "old"),
      rec("own", "dismissed", "style"),
      rec("sec", "dismissed", "intentional"),
    ];
    const hashes = new Map(
      [...report.findings, ...report.security].map((f) => [f.id, "h1"]),
    );
    const outcome = applyHistory(report, records, hashes, new Set(["own"]));
    expect(outcome.remembered.sort()).toEqual([
      "intentional",
      "irrelevant",
      "sec",
      "style",
    ]);
    expect(outcome.regressions).toEqual(["fixed"]);
    const ids = report.findings.map((f: any) => f.id);
    expect(ids).toEqual(["new", "wrong", "fixed", "changed", "own"]);
    // First occurrence: no history block.
    expect(report.findings[0].history).toBeUndefined();
    // Wrong is never remembered and its recurrence names the earlier answer.
    expect(report.findings[1].history).toMatchObject({
      previous_status: "dismissed",
      previous_response: { reason: "wrong" },
      dismissed_in: "github.com/acme/api#41",
      seen_count: 2,
    });
    expect(report.findings[2].history).toEqual({
      first_seen: "rev-1",
      last_seen: "rev-2",
      seen_count: 2,
      previous_status: "fixed",
      fixed_in: "rev-3",
    });
    expect(report.findings[3].history.previous_response.reason).toBe(
      "irrelevant",
    );
    expect(report.findings[4].history.previous_response.reason).toBe("style");
    // Remembered findings move with their history; the security list empties.
    expect(
      report.remembered.map((f: any) => [
        f.id,
        f.history.previous_response.reason,
      ]),
    ).toEqual([
      ["style", "style"],
      ["intentional", "intentional"],
      ["irrelevant", "irrelevant"],
      ["sec", "intentional"],
    ]);
    expect(report.security).toBeUndefined();
    expect(report.checks[0].findings).toEqual([]);
    // Fail policies never see remembered findings.
    expect(report.agent_audit).toEqual({
      policy_failed: false,
      policy_matches: [],
    });
    // Without a current hash nothing is remembered.
    const unknown: any = { findings: [finding("style")], risks: [] };
    applyHistory(unknown, [rec("style", "dismissed", "style")], new Map());
    expect(unknown.findings).toHaveLength(1);
    expect(unknown.remembered).toBeUndefined();
  });
});

describe("finding registry", () => {
  const repository = "github.com/acme/history";
  const base = {
    "src/a.ts": "function a() {\n  return 0;\n}\n",
    "src/b.ts": "function b() {\n  return 0;\n}\n",
  };
  const head = {
    "src/a.ts": "function a() {\n  throw new Error();\n}\n",
    "src/b.ts": "function b() {\n  return null;\n}\n",
  };
  const fa = hyp("correctness/throw", "src/a.ts", "a", 2),
    fb = hyp("correctness/null", "src/b.ts", "b", 2);

  it("records first sightings and repeats from reviews without a lineage, remembers style on unchanged code and re-reports changed code", async () => {
    const r1 = await review({ base, head, agents: [fa, fb], repository });
    expect(
      reported(r1.report)
        .map((f) => f.id)
        .sort(),
    ).toEqual([idOf(fa), idOf(fb)].sort());
    expect(reported(r1.report).every((f) => !f.history)).toBe(true);
    expect(await record(repository, idOf(fa))).toMatchObject({
      first_seen_review: r1.id,
      last_seen_review: r1.id,
      seen_count: 1,
      status: "open",
      rule_id: "correctness/throw",
    });
    const r2 = await review({ base, head, agents: [fa, fb], repository });
    const again = reported(r2.report).find((f) => f.id === idOf(fa));
    expect(again.history).toEqual({
      first_seen: r1.id,
      last_seen: r1.id,
      seen_count: 1,
      previous_status: "open",
    });
    expect(await record(repository, idOf(fa))).toMatchObject({
      first_seen_review: r1.id,
      last_seen_review: r2.id,
      seen_count: 2,
    });
    // A finding outside any lineage is answered through the registry.
    for (const [id, reason] of [
      [idOf(fa), "style"],
      [idOf(fb), "wrong"],
    ]) {
      const response = await app.request(
        `https://rio/v1/findings/${id}/feedback`,
        {
          method: "POST",
          headers: owner,
          body: JSON.stringify({ reason, actor: "dev@example.com" }),
        },
        runtime,
      );
      expect(response.status).toBe(200);
    }
    expect(await record(repository, idOf(fa))).toMatchObject({
      status: "dismissed",
      dismissed_in: r2.id,
    });
    // Unchanged code: style is remembered, wrong is reported with history;
    // a profile suppression is counted apart from the remembered finding.
    const suppressed = hyp("correctness/noise", "src/b.ts", "b", 1);
    const r3 = await review({
      base,
      head,
      agents: [fa, fb, suppressed],
      repository,
      mutate: (s) => {
        s.profile.suppress = [{ rule: "correctness/noise" }];
      },
    });
    expect(reported(r3.report).map((f) => f.id)).toEqual([idOf(fb)]);
    expect(reported(r3.report)[0].history).toMatchObject({
      previous_status: "dismissed",
      previous_response: { reason: "wrong", actor: "dev@example.com" },
      seen_count: 2,
    });
    expect(r3.report.remembered).toHaveLength(1);
    expect(r3.report.remembered[0]).toMatchObject({
      id: idOf(fa),
      history: {
        previous_status: "dismissed",
        previous_response: { reason: "style" },
        dismissed_in: r2.id,
      },
    });
    expect(r3.report.summary.suppressed).toBe(1);
    expect(await record(repository, idOf(fa))).toMatchObject({
      seen_count: 3,
      status: "dismissed",
      last_seen_review: r3.id,
    });
    // The enclosing symbol changed: reported again with the earlier answer.
    const edited = {
      ...head,
      "src/a.ts":
        "function a() {\n  if (debug) log();\n  throw new Error();\n}\n",
    };
    const r4 = await review({
      base,
      head: edited,
      agents: [
        { ...fa, location: { ...fa.location, line_start: 3, line_end: 3 } },
      ],
      repository,
    });
    const changed = reported(r4.report).find((f) => f.id === idOf(fa));
    expect(changed.history).toMatchObject({
      previous_status: "dismissed",
      previous_response: { reason: "style" },
      seen_count: 3,
    });
    expect(r4.report.remembered).toBeUndefined();
    // A fixed identity that comes back is a regression of that fix.
    await runtime.DB.prepare(
      "UPDATE finding_history SET status='fixed',author_response_json=NULL,dismissed_in='rev-fix' WHERE tenant='owner' AND repository=? AND identity=?",
    )
      .bind(repository, idOf(fb))
      .run();
    const r5 = await review({ base, head, agents: [fb], repository });
    expect(reported(r5.report)[0].history).toMatchObject({
      previous_status: "fixed",
      fixed_in: "rev-fix",
    });
    expect(await record(repository, idOf(fb))).toMatchObject({
      status: "open",
      dismissed_in: null,
    });
  }, 240000);

  it("skips the registry, with a note, when the submission names no repository", async () => {
    const r = await review({ base, head, agents: [fa] });
    expect(r.report.footer.notes).toContain(
      "Finding history was not consulted: the submission names no repository.",
    );
    expect(reported(r.report)[0].history).toBeUndefined();
  }, 120000);

  it("accepts only a bounded repository key in submissions", () => {
    const s: any = { ...submission(), snapshot_id: "a".repeat(64) };
    expect(() =>
      validateSubmission({ ...s, repository: "github.com/o/r" }),
    ).not.toThrow();
    for (const repository of ["", 7, "x".repeat(513), "a\nb"])
      expect(() => validateSubmission({ ...s, repository })).toThrow(
        "invalid repository",
      );
  });
});

describe("GET /v1/findings", () => {
  const repository = "github.com/acme/listing";
  const insert = (
    identity: string,
    status: string,
    rule: string,
    updated: number,
    tenant = "owner",
  ) =>
    runtime.DB.prepare(
      "INSERT INTO finding_history(tenant,repository,identity,rule_id,first_seen_review,last_seen_review,seen_count,status,author_response_json,dismissed_in,location_json,code_hash,updated_at) VALUES(?,?,?,?,'rev-1','rev-2',2,?,?,?,?,'h',?)",
    )
      .bind(
        tenant,
        repository,
        identity,
        rule,
        status,
        status === "dismissed"
          ? JSON.stringify({
              reason: "style",
              actor: "dev",
              at: "2026-11-01T00:00:00.000Z",
            })
          : null,
        status === "dismissed" ? "github.com/acme/listing#7" : null,
        JSON.stringify({
          path: "src/a.ts",
          line_start: 3,
          line_end: 3,
          symbol_path: "a",
          occurrence_state: "new",
        }),
        updated,
      )
      .run();
  const get = async (
    query: string,
    headers: Record<string, string> = owner,
  ) => {
    const response = await app.request(
      `https://rio/v1/findings?${query}`,
      { headers },
      runtime,
    );
    return { status: response.status, body: (await response.json()) as any };
  };
  it("filters by repository, status, rule and since, and isolates tenants", async () => {
    const t = Date.parse("2026-11-05T00:00:00Z");
    await insert("1".repeat(64), "open", "lint/eslint/no-unused-vars", t);
    await insert(
      "2".repeat(64),
      "dismissed",
      "lint/eslint/no-unused-vars",
      t + 1000,
    );
    await insert("3".repeat(64), "dismissed", "typecheck/tsc/TS2322", t + 2000);
    await insert(
      "4".repeat(64),
      "open",
      "lint/eslint/no-unused-vars",
      t - 86400000,
    );
    const all = await get(`repository=${encodeURIComponent(repository)}`);
    expect(all.status).toBe(200);
    expect(all.body.findings).toHaveLength(4);
    const filtered = await get(
      `repository=${encodeURIComponent(repository)}&status=dismissed&rule=${encodeURIComponent("lint/eslint/no-unused-vars")}`,
    );
    expect(filtered.body.findings).toEqual([
      {
        identity: "2".repeat(64),
        repository,
        rule_id: "lint/eslint/no-unused-vars",
        status: "dismissed",
        first_seen: "rev-1",
        last_seen: "rev-2",
        seen_count: 2,
        location: {
          path: "src/a.ts",
          line_start: 3,
          line_end: 3,
          symbol_path: "a",
          occurrence_state: "new",
        },
        author_response: {
          reason: "style",
          actor: "dev",
          at: "2026-11-01T00:00:00.000Z",
        },
        dismissed_in: "github.com/acme/listing#7",
        updated_at: new Date(t + 1000).toISOString(),
      },
    ]);
    const recent = await get(
      `repository=${encodeURIComponent(repository)}&since=2026-11-05T00:00:00Z`,
    );
    expect(recent.body.findings.map((f: any) => f.identity[0]).sort()).toEqual([
      "1",
      "2",
      "3",
    ]);
    expect((await get("status=closed")).status).toBe(400);
    expect((await get("since=yesterday")).status).toBe(400);
    // Tenant B never sees tenant A's records: the repository is unknown to B.
    const token = "a-registry-reader-of-tenant-b-32";
    await runtime.DB.prepare(
      "INSERT INTO api_tokens(hash,tenant,scope,expires_at) VALUES(?,?,?,?)",
    )
      .bind(hash(token), "tenant-b", "reviews:read", Date.now() + 60000)
      .run();
    const other = { ...owner, authorization: `Bearer ${token}` };
    const cross = await get(
      `repository=${encodeURIComponent(repository)}`,
      other,
    );
    expect(cross.status).toBe(404);
    expect(cross.body.findings).toBeUndefined();
    expect((await get("", other)).body).toEqual({ findings: [] });
    await insert("5".repeat(64), "open", "x", t, "tenant-b");
    const own = await get(
      `repository=${encodeURIComponent(repository)}`,
      other,
    );
    expect(own.body.findings.map((f: any) => f.identity)).toEqual([
      "5".repeat(64),
    ]);
  });
});

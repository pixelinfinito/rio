import {
  env,
  applyD1Migrations,
  introspectWorkflowInstance,
} from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { Store } from "../src/storage";
import { hash } from "../src/validation";
import {
  DECLINE_PAUSE,
  candidates,
  proposalId,
  updateProposals,
} from "../src/proposals";
import { allMigrations, submission } from "./fixtures";
import { storeSnapshot } from "./snapshots";
import type { Env } from "../src/types";

const runtime = env as Env;
beforeAll(async () => {
  await applyD1Migrations(runtime.DB, allMigrations);
});
const owner = {
  authorization: "Bearer test-owner-token-at-least-32-characters",
  "content-type": "application/json",
  "rio-protocol": "1",
};
const DAY = 86400000;
let serial = 0;
/** A registry record and one response on it, `days` ago. */
async function respond(
  repository: string,
  rule: string,
  path: string,
  reason: string,
  days = 1,
  tenant = "owner",
) {
  const identity = hash(`${repository}${rule}${path}${serial++}`);
  await runtime.DB.batch([
    runtime.DB.prepare(
      "INSERT INTO finding_history(tenant,repository,identity,rule_id,first_seen_review,last_seen_review,seen_count,status,location_json,updated_at) VALUES(?,?,?,?,'rev','rev',1,'dismissed',?,?)",
    ).bind(
      tenant,
      repository,
      identity,
      rule,
      JSON.stringify({
        path,
        line_start: 1,
        line_end: 1,
        symbol_path: "s",
        occurrence_state: "new",
      }),
      Date.now(),
    ),
    runtime.DB.prepare(
      "INSERT INTO feedback(id,tenant,finding_id,reason,actor,note,created_at) VALUES(?,?,?,?,?,NULL,?)",
    ).bind(
      crypto.randomUUID(),
      tenant,
      identity,
      reason,
      `dev${serial}`,
      Date.now() - days * DAY,
    ),
  ]);
  return identity;
}
const rows = (repository: string) =>
  runtime.DB.prepare(
    "SELECT * FROM suppressions WHERE tenant='owner' AND repository=? ORDER BY entry_json",
  )
    .bind(repository)
    .all<any>()
    .then((r) => r.results);

describe("proposal computation", () => {
  it("proposes at the threshold, not one below, and never from wrong, fixed or intentional", async () => {
    const repo = "github.com/acme/threshold";
    await respond(repo, "lint/eslint/max-len", "src/a.ts", "style");
    await respond(repo, "lint/eslint/max-len", "src/b.ts", "irrelevant");
    for (const reason of [
      "wrong",
      "wrong",
      "wrong",
      "wrong",
      "wrong",
      "fixed",
      "intentional",
    ])
      await respond(repo, "lint/eslint/max-len", "lib/c.ts", reason);
    expect(await updateProposals(runtime, "owner", repo, 3)).toEqual([]);
    expect(await rows(repo)).toEqual([]);
    // Responses older than 90 days do not count.
    await respond(repo, "lint/eslint/max-len", "src/d.ts", "style", 91);
    expect(await updateProposals(runtime, "owner", repo, 3)).toEqual([]);
    const third = await respond(
      repo,
      "lint/eslint/max-len",
      "src/e.ts",
      "style",
    );
    const open = await updateProposals(runtime, "owner", repo, 3);
    const id = proposalId("owner", repo, { rule: "lint/eslint/max-len" });
    expect(open).toEqual([
      {
        id,
        entry: { rule: "lint/eslint/max-len" },
        evidence_count: 3,
        since: expect.any(String),
      },
    ]);
    const [row] = await rows(repo);
    expect(row).toMatchObject({
      origin: "proposed",
      status: "proposed",
      evidence_count: 3,
    });
    const evidence = JSON.parse(row.evidence_json);
    expect(evidence.map((e: any) => e.reason).sort()).toEqual([
      "irrelevant",
      "style",
      "style",
    ]);
    expect(evidence.find((e: any) => e.finding === third)).toMatchObject({
      reason: "style",
      actor: expect.stringMatching(/^dev/),
      at: expect.any(String),
    });
    // A lower profile threshold proposes earlier.
    const low = "github.com/acme/low";
    await respond(low, "lint/eslint/no-console", "src/a.ts", "style");
    await respond(low, "lint/eslint/no-console", "src/b.ts", "style");
    expect(await updateProposals(runtime, "owner", low, 2)).toHaveLength(1);
  });

  it("proposes a directory for mixed rules and keeps tenants apart", async () => {
    const repo = "github.com/acme/generated";
    for (const rule of ["lint/a", "lint/b", "typecheck/tsc/TS1"])
      await respond(repo, rule, "docs/generated/api.ts", "irrelevant");
    // Another tenant's responses never count here.
    for (const rule of ["lint/a", "lint/a", "lint/a"])
      await respond(repo, rule, "docs/generated/x.ts", "style", 1, "other");
    const open = await updateProposals(runtime, "owner", repo, 3);
    expect(open.map((p) => p.entry)).toEqual([{ path: "docs/generated/**" }]);
    // Only the latest response per finding counts.
    const answers = [
      {
        finding_id: "f",
        reason: "style",
        actor: "a",
        created_at: 1,
        rule_id: "r",
        location_json: '{"path":"x/y.ts"}',
      },
      {
        finding_id: "f",
        reason: "wrong",
        actor: "a",
        created_at: 2,
        rule_id: "r",
        location_json: '{"path":"x/y.ts"}',
      },
    ];
    expect(candidates(answers, 1)).toEqual([]);
  });

  it("does not re-propose a declined entry for 180 days and never an applied one", async () => {
    const repo = "github.com/acme/declined";
    for (let i = 0; i < 3; i++)
      await respond(repo, "lint/eslint/no-console", `src/${i}.ts`, "style");
    const [proposal] = await updateProposals(runtime, "owner", repo, 3);
    const decline = await app.request(
      `https://rio/v1/suppressions/${proposal.id}`,
      {
        method: "POST",
        headers: owner,
        body: JSON.stringify({ status: "declined", note: "we want these" }),
      },
      runtime,
    );
    expect(decline.status).toBe(200);
    expect(await decline.json()).toMatchObject({
      status: "declined",
      note: "we want these",
    });
    // Two more responses within 180 days: still declined, nothing proposed.
    for (let i = 3; i < 5; i++)
      await respond(repo, "lint/eslint/no-console", `src/${i}.ts`, "style");
    expect(await updateProposals(runtime, "owner", repo, 3)).toEqual([]);
    expect((await rows(repo))[0]).toMatchObject({
      status: "declined",
      note: "we want these",
    });
    // After the pause it may be proposed again.
    expect(
      await updateProposals(
        runtime,
        "owner",
        repo,
        3,
        Date.now() + DECLINE_PAUSE + DAY,
      ),
    ).toEqual([]); // the responses are older than 90 days by then
    await runtime.DB.prepare(
      "UPDATE suppressions SET decided_at=? WHERE repository=?",
    )
      .bind(Date.now() - DECLINE_PAUSE - DAY, repo)
      .run();
    const again = await updateProposals(runtime, "owner", repo, 3);
    expect(again).toHaveLength(1);
    expect((await rows(repo))[0]).toMatchObject({
      status: "proposed",
      note: null,
      decided_at: null,
    });
    // Applied: decided once, never proposed again; a second decision is refused.
    const apply = (status: string) =>
      app.request(
        `https://rio/v1/suppressions/${again[0].id}`,
        { method: "POST", headers: owner, body: JSON.stringify({ status }) },
        runtime,
      );
    expect((await apply("applied")).status).toBe(200);
    expect((await apply("declined")).status).toBe(409);
    expect(await updateProposals(runtime, "owner", repo, 3)).toEqual([]);
    expect((await apply("maybe")).status).toBe(400);
  });
});

describe("GET /v1/suppressions", () => {
  it("lists the caller's proposals by repository and status only", async () => {
    const repo = "github.com/acme/listed";
    for (let i = 0; i < 3; i++)
      await respond(repo, "lint/x", `src/${i}.ts`, "style");
    for (let i = 0; i < 3; i++)
      await respond(repo, "lint/y", `lib/${i}.ts`, "irrelevant");
    const [x, y] = await updateProposals(runtime, "owner", repo, 3);
    await app.request(
      `https://rio/v1/suppressions/${y.id}`,
      {
        method: "POST",
        headers: owner,
        body: JSON.stringify({ status: "declined" }),
      },
      runtime,
    );
    const list = async (query: string, headers = owner) =>
      (await (
        await app.request(
          `https://rio/v1/suppressions?${query}`,
          { headers },
          runtime,
        )
      ).json()) as any;
    const all = await list(`repository=${encodeURIComponent(repo)}`);
    expect(
      all.suppressions.map((p: any) => [p.id, p.status, p.evidence_count]),
    ).toEqual([
      [x.id, "proposed", 3],
      [y.id, "declined", 3],
    ]);
    expect(all.suppressions[0]).toMatchObject({
      repository: repo,
      entry: { rule: "lint/x" },
      evidence: expect.arrayContaining([
        expect.objectContaining({ reason: "style" }),
      ]),
    });
    const proposed = await list(
      `repository=${encodeURIComponent(repo)}&status=proposed`,
    );
    expect(proposed.suppressions.map((p: any) => p.id)).toEqual([x.id]);
    const token = "a-proposal-reader-of-tenant-c-32";
    await runtime.DB.prepare(
      "INSERT INTO api_tokens(hash,tenant,scope,expires_at) VALUES(?,?,?,?)",
    )
      .bind(
        hash(token),
        "tenant-c",
        "reviews:read,reviews:write",
        Date.now() + 60000,
      )
      .run();
    const other = { ...owner, authorization: `Bearer ${token}` };
    expect(await list(`repository=${encodeURIComponent(repo)}`, other)).toEqual(
      { suppressions: [] },
    );
    const foreign = await app.request(
      `https://rio/v1/suppressions/${x.id}`,
      {
        method: "POST",
        headers: other,
        body: JSON.stringify({ status: "applied" }),
      },
      runtime,
    );
    expect(foreign.status).toBe(404);
  });
});

describe("proposals in reviews", () => {
  it("lists open proposals in the report and suppresses nothing by themselves", async () => {
    const repo = "github.com/acme/footer";
    const rule = "correctness/throw";
    for (let i = 0; i < 4; i++)
      await respond(repo, rule, `src/old${i}.ts`, "style");
    const transport = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const body = JSON.parse(init!.body as string);
        const first: string = body.messages.find(
          (m: any) => m.role === "user",
        ).content;
        const last: string = body.messages.at(-1).content;
        const result = first.includes(
          "Review the change independently for correctness.",
        )
          ? [
              {
                rule_id: rule,
                category: "defect",
                severity: "error",
                location: {
                  path: "src/a.ts",
                  line_start: 1,
                  line_end: 1,
                  symbol_path: "a",
                },
                message: "The call now throws",
                trigger: "a()",
                state: "new",
              },
            ]
          : last.startsWith("Verify this hypothesis.")
            ? { evidence_level: "plausible", evidence: [] }
            : [];
        const content = JSON.stringify({ result });
        return Response.json(
          String(input).includes("anthropic")
            ? {
                content: [{ type: "text", text: content }],
                usage: { input_tokens: 8, output_tokens: 5 },
              }
            : {
                choices: [{ message: { content } }],
                usage: { prompt_tokens: 8, completion_tokens: 5 },
              },
        );
      });
    try {
      const store = new Store(runtime),
        id = crypto.randomUUID(),
        s = submission();
      s.repository = repo;
      s.changed = [{ path: "src/a.ts", lines_changed: 1 }];
      s.graphs = {
        base: { nodes: [], edges: [] },
        head: { nodes: [], edges: [] },
      };
      s.profile.steps = [
        {
          id: "agents",
          uses: "rio/agents@0.1.0",
          needs: [],
          with: {},
          agents: [{ correctness: {} }],
        },
        { id: "verify", uses: "rio/verify@0.1.0", needs: ["agents"], with: {} },
        {
          id: "report",
          uses: "rio/report@0.1.0",
          needs: ["verify"],
          with: { proposal_threshold: 4 },
        },
      ];
      const stored = await storeSnapshot(runtime, {
        base: {
          "src/a.ts": {
            mode: 0o100644,
            content: "function a(){ return 0; }\n",
          },
        },
        head: {
          "src/a.ts": {
            mode: 0o100644,
            content: "function a(){ throw new Error(); }\n",
          },
        },
      });
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
      const report = await store.get<any>(row.report_key);
      expect(report.suppression_proposals).toEqual([
        {
          id: proposalId("owner", repo, { rule }),
          entry: { rule },
          evidence_count: 4,
          since: expect.any(String),
        },
      ]);
      // The proposal is not a suppression: the matching finding is reported.
      expect(
        [...report.findings, ...report.risks].map((f: any) => f.rule_id),
      ).toEqual([rule]);
      expect(report.summary.suppressed).toBe(0);
    } finally {
      transport.mockRestore();
    }
  }, 120000);
});

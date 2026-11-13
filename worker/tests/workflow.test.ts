import {
  env,
  applyD1Migrations,
  introspectWorkflowInstance,
} from "cloudflare:test";
import { beforeAll, it, expect, vi } from "vitest";
import { app } from "../src/index";
import { Store } from "../src/storage";
import { Progress } from "../src/progress";
import { finishJob } from "../src/jobs";
import { CANCEL_GRACE_MS, reconcile, sweepReviews } from "../src/reconcile";
import { CANCELLED_NOTE, changedCode, renderDiff } from "../src/workflow";
import { LARGE, MemorySnapshot } from "../src/snapshot";
import { Requests, SEARCH_REFUSED } from "../src/requests";
import { hash, validateHypotheses, validateReport } from "../src/validation";
import { allMigrations, hypothesis, snapshot, submission } from "./fixtures";
import { storeSnapshot, uploadSnapshot } from "./snapshots";
import type { BlindMatch, Env } from "../src/types";
const runtime = env as Env;
const headers = {
  authorization: "Bearer test-owner-token-at-least-32-characters",
  "content-type": "application/json",
};
beforeAll(async () => {
  await applyD1Migrations(runtime.DB, allMigrations);
});
it.each([false, true])(
  "runs the real durable DAG with recorded providers and independent blind voters (fork=%s)",
  async (fork) => {
    const requests: any[] = [];
    const transport = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const body = JSON.parse(init!.body as string);
        requests.push(body);
        const anthropic = String(input).includes("anthropic");
        const disclosed = body.messages.some((m: any) =>
          m.content.includes("Verify this hypothesis."),
        );
        const generated = body.messages.some((m: any) =>
          m.content.includes("Review the change independently"),
        );
        const result = generated
          ? [hypothesis]
          : disclosed
            ? {
                evidence_level: "static_proven",
                evidence: [
                  {
                    kind: "code",
                    version: "head",
                    path: "src/a.ts",
                    node_ids: ["h"],
                    demonstrates: "regression",
                  },
                ],
              }
            : [];
        const content = JSON.stringify({ result });
        return Response.json(
          anthropic
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
      const bindings = {
        ...runtime,
        OPENAI_API_KEY: "recorded-key",
        ANTHROPIC_API_KEY: "recorded-key",
      };
      // Workflow gets its environment bindings, so test keys are configured in Vitest.
      const uploaded = await uploadSnapshot(
        (path, method, body) =>
          app.request(
            `https://rio${path}`,
            { method, headers, body },
            bindings,
          ),
        snapshot,
      );
      const s = submission();
      s.fork = fork;
      s.snapshot_id = ((await uploaded.json()) as any).id;
      s.profile.steps = [
        { id: "prepare", uses: "rio/prepare@0.1.0", needs: [], with: {} },
        {
          id: "triage",
          uses: "rio/triage@0.1.0",
          needs: ["prepare"],
          with: {},
        },
        { id: "agents", uses: "rio/agents@0.1.0", needs: ["triage"], with: {} },
        {
          id: "security",
          uses: "rio/security@0.2.0",
          needs: ["triage"],
          with: { enabled: false },
        },
        {
          id: "verify",
          uses: "rio/verify@0.1.0",
          needs: ["agents", "security"],
          with: {},
        },
        { id: "report", uses: "rio/report@0.1.0", needs: ["verify"], with: {} },
      ];
      const response = await app.request(
        "https://rio/v1/reviews",
        { method: "POST", headers, body: JSON.stringify(s) },
        bindings,
      );
      expect(response.status).toBe(202);
      const { id } = (await response.json()) as any;
      await using instance = await introspectWorkflowInstance(
        runtime.REVIEWS,
        id,
      );
      await instance.waitForStatus("complete");
      const status = await runtime.DB.prepare(
        "SELECT status,report_key FROM reviews WHERE id=?",
      )
        .bind(id)
        .first<any>();
      expect(status.status).toBe("complete");
      const report = await new Store(runtime).get<any>(status.report_key);
      expect(report.findings).toHaveLength(1);
      expect(report.findings[0].evidence_level).toBe("static_proven");
      expect(report.findings[0].verification.blind_match).toEqual([
        "none",
        "none",
        "none",
      ]);
      expect(report.agent_audit.verification_usage.input_tokens).toBe(480);
      // What the review asked of storage and the models, against the limit
      // the platform sets one workflow instance.
      expect(report.agent_audit.requests).toMatchObject({
        limit: 10000,
        scans: 0,
        refused: 0,
        stopped: 0,
      });
      expect(report.agent_audit.requests.used).toBeGreaterThan(requests.length);
      expect(report.agent_audit.requests.used).toBeLessThan(300);
      // The prompt-cache audit: every phase counted; no provider reported cache
      // fields, so the totals and the ratio stay null rather than zero.
      const cache = report.agent_audit.prompt_cache;
      expect(cache.phases["verify-blind"].calls).toBe(3);
      expect(cache.phases["verify-blind"].cache_read_input_tokens).toBeNull();
      expect(cache.phases["verify-blind"].read_ratio).toBeNull();
      expect(() => validateReport(report)).not.toThrow();
      // The tenant partition reaches every request before repository data, one
      // value per provider, and its secret appears in no stored artifact.
      const partitioned = requests.map((r) =>
        /<review_partition id="([0-9a-f]{32})"\/>/.exec(
          JSON.stringify(r.messages.map((m: any) => m.content)).replaceAll('\\"', '"'),
        ),
      );
      expect(partitioned.every(Boolean)).toBe(true);
      const tenantSecret = (
        await runtime.DB.prepare(
          "SELECT secret FROM prompt_partitions WHERE tenant=(SELECT tenant FROM reviews WHERE id=?)",
        )
          .bind(id)
          .first<{ secret: string }>()
      )!.secret;
      const stored = await runtime.ARTIFACTS.list({ prefix: `reviews/${id}/` });
      expect(stored.objects.length).toBeGreaterThan(0);
      for (const object of stored.objects) {
        const text = await (await runtime.ARTIFACTS.get(object.key))!.text();
        expect(text, object.key).not.toContain(tenantSecret);
        // Model-call records carry layer hashes and sizes, not prompt text.
        if (object.key.includes("/models/")) {
          expect(JSON.parse(text).layers.length, object.key).toBeGreaterThan(1);
          expect(text, object.key).not.toContain("repository_data");
        }
      }
      expect(requests).toHaveLength(7);
      // Progress for the live screen: each agent starts and finishes, then
      // verification counts the hypotheses it checked.
      const events = (
        await runtime.DB.prepare(
          "SELECT event,data FROM events WHERE review_id=? ORDER BY seq",
        )
          .bind(id)
          .all<{ event: string; data: string }>()
      ).results.filter((e) => /^(agent|verify):/.test(e.event));
      expect(events.map((e) => [e.event, JSON.parse(e.data)])).toEqual([
        ["agent:started", { agent: "correctness" }],
        ["agent:finished", { agent: "correctness", hypotheses: 1 }],
        ["verify:progress", { done: 1, total: 1 }],
      ]);
      const votes = await runtime.DB.prepare(
        "SELECT status FROM votes WHERE review_id=?",
      )
        .bind(id)
        .all<any>();
      expect(votes.results).toHaveLength(3);
      expect(votes.results.every((v) => v.status === "completed")).toBe(true);
      expect(report.footer.notes.some((n: string) => n.includes("board"))).toBe(
        true,
      );
      expect(report.security).toBeUndefined();
      expect(
        report.footer.notes.some((n: string) =>
          n.includes("Fork PR: static-only"),
        ),
      ).toBe(fork);
      expect(
        (
          await runtime.DB.prepare(
            "SELECT COUNT(*) AS count FROM jobs WHERE review_id=?",
          )
            .bind(id)
            .first<any>()
        ).count,
      ).toBe(0);
    } finally {
      transport.mockRestore();
    }
  },
  60000,
);
it("marks failed remote votes incomplete and keeps the configured quorum", async () => {
  const transport = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_, init) => {
      const body = JSON.parse(init!.body as string);
      const generated = body.messages.some((m: any) =>
        m.content.includes("Review the change independently"),
      );
      const content = generated
        ? JSON.stringify({ result: [hypothesis] })
        : "malformed answer";
      return Response.json({
        content: [{ type: "text", text: content }],
        choices: [{ message: { content } }],
        usage: {
          input_tokens: 80,
          output_tokens: 50,
          prompt_tokens: 80,
          completion_tokens: 50,
        },
      });
    });
  try {
    const uploaded = await uploadSnapshot(
      (path, method, body) =>
        app.request(`https://rio${path}`, { method, headers, body }, runtime),
      snapshot,
    );
    const s = submission();
    s.snapshot_id = ((await uploaded.json()) as any).id;
    s.profile.steps = [
      { id: "agents", uses: "rio/agents@0.1.0", needs: [], with: {} },
      { id: "verify", uses: "rio/verify@0.1.0", needs: ["agents"], with: {} },
    ];
    // Every repair turn resends the item schema: leave room for all of them,
    // so the votes end malformed rather than out of budget.
    s.profile.budget.fast.verify_tokens = 30000;
    const response = await app.request(
      "https://rio/v1/reviews",
      { method: "POST", headers, body: JSON.stringify(s) },
      runtime,
    );
    expect(response.status).toBe(202);
    const { id } = (await response.json()) as any;
    await using instance = await introspectWorkflowInstance(
      runtime.REVIEWS,
      id,
    );
    await instance.waitForStatus("complete");
    const state = await runtime.DB.prepare(
      "SELECT report_key FROM reviews WHERE id=?",
    )
      .bind(id)
      .first<any>();
    const report = await new Store(runtime).get<any>(state.report_key);
    expect(report.status).toBe("incomplete");
    expect(report.agent_audit.incomplete_votes).toBe(3);
    expect(report.findings).toEqual([]);
    expect(
      report.footer.notes.some((n: string) =>
        n.includes("3 verifier votes did not complete"),
      ),
    ).toBe(true);
    const votes = await runtime.DB.prepare(
      "SELECT status FROM votes WHERE review_id=?",
    )
      .bind(id)
      .all<any>();
    expect(votes.results.map((v) => v.status)).toEqual([
      "malformed",
      "malformed",
      "malformed",
    ]);
  } finally {
    transport.mockRestore();
  }
}, 60000);

// The full benchmark run lost three reviews to the platform's limit of storage
// requests: the instance ended where it stood, with no report. A review now
// counts its requests and gives up searches, then model turns, before that.
const budgeted = async (
  // Its own model: the earlier tests' cached agent results are not its.
  model: string,
  reply: (body: any) => unknown,
  steps: any[],
) => {
  const bodies: any[] = [];
  const transport = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_, init) => {
      const body = JSON.parse(init!.body as string);
      bodies.push(body);
      const content = JSON.stringify(reply(body));
      return Response.json({
        content: [{ type: "text", text: content }],
        choices: [{ message: { content } }],
        usage: {
          input_tokens: 80,
          output_tokens: 50,
          prompt_tokens: 80,
          completion_tokens: 50,
        },
      });
    });
  try {
    const uploaded = await uploadSnapshot(
      (path, method, body) =>
        app.request(`https://rio${path}`, { method, headers, body }, runtime),
      snapshot,
    );
    const s = submission();
    s.snapshot_id = ((await uploaded.json()) as any).id;
    s.profile.models.default = `openai/${model}`;
    s.profile.steps = steps;
    const response = await app.request(
      "https://rio/v1/reviews",
      { method: "POST", headers, body: JSON.stringify(s) },
      runtime,
    );
    expect(response.status).toBe(202);
    const { id } = (await response.json()) as any;
    await using instance = await introspectWorkflowInstance(
      runtime.REVIEWS,
      id,
    );
    // The workflow ends the review itself; the platform does not end it.
    await instance.waitForStatus("complete");
    const row = await runtime.DB.prepare(
      "SELECT status,report_key FROM reviews WHERE id=?",
    )
      .bind(id)
      .first<any>();
    const report = await new Store(runtime).get<any>(row.report_key);
    expect(() => validateReport(report)).not.toThrow();
    const votes = await runtime.DB.prepare(
      "SELECT status FROM votes WHERE review_id=?",
    )
      .bind(id)
      .all<{ status: string }>();
    return {
      row,
      report,
      bodies,
      votes: votes.results.map((v) => v.status),
    };
  } finally {
    transport.mockRestore();
  }
};
const generation = (body: any) =>
  body.messages.some((m: any) =>
    m.content.includes("Review the change independently"),
  );
const spentNote = (turns: string) =>
  `Request budget: ${turns} not started, because the review had used its share of the 10000 requests the platform allows one review; the agents, verifier votes and council answers they belonged to did not complete.`;
const AGENTS_AND_VERIFY = [
  { id: "agents", uses: "rio/agents@0.1.0", needs: [], with: {} },
  { id: "verify", uses: "rio/verify@0.1.0", needs: ["agents"], with: {} },
];
it("ends an agent with a disclosed failure when the review's request budget is spent, without calling its model", async () => {
  const spent = vi
    .spyOn(Requests.prototype, "exhausted", "get")
    .mockReturnValue(true);
  try {
    const { row, report, bodies } = await budgeted(
      "budget-spent",
      () => ({ result: [hypothesis] }),
      AGENTS_AND_VERIFY,
    );
    expect(bodies).toEqual([]);
    expect([row.status, report.status]).toEqual(["partial", "partial"]);
    expect(report.findings).toEqual([]);
    expect(report.footer.notes).toContain(
      "correctness agent failed: review request budget exhausted; its findings are missing from this review.",
    );
    expect(report.footer.notes).toContain(spentNote("1 model turn was"));
    expect(report.agent_audit.requests).toMatchObject({
      limit: 10000,
      stopped: 1,
    });
  } finally {
    spent.mockRestore();
  }
}, 60000);
it("leaves the votes a spent request budget did not cover incomplete, and keeps what the agents raised", async () => {
  let generated = false;
  const spent = vi
    .spyOn(Requests.prototype, "exhausted", "get")
    .mockImplementation(() => generated);
  try {
    const { row, report, bodies, votes } = await budgeted(
      "budget-votes",
      (body) => {
        generated ||= generation(body);
        return { result: [hypothesis] };
      },
      AGENTS_AND_VERIFY,
    );
    // The generation call, and no voter's.
    expect(bodies.filter(generation)).toHaveLength(1);
    expect(bodies).toHaveLength(1);
    expect([row.status, report.status]).toEqual(["complete", "incomplete"]);
    expect(votes).toEqual(["exhausted", "exhausted", "exhausted"]);
    expect(report.agent_audit.incomplete_votes).toBe(3);
    expect(report.findings).toEqual([]);
    expect(report.footer.notes).toEqual(
      expect.arrayContaining([
        "3 verifier votes did not complete; inspect the vote audit. Missing votes do not reduce quorum.",
        spentNote("3 model turns were"),
      ]),
    );
    expect(report.agent_audit.requests.stopped).toBe(3);
  } finally {
    spent.mockRestore();
  }
}, 60000);
it("answers a search the request budget no longer covers with a refusal, and reports the review incomplete", async () => {
  const full = vi
    .spyOn(Requests.prototype, "searchable", "get")
    .mockReturnValue(false);
  try {
    let asked = false;
    const { row, report, bodies } = await budgeted(
      "budget-search",
      (body) => {
        if (asked || !generation(body)) return { result: [] };
        asked = true;
        return {
          tools: [
            { name: "search", args: { pattern: "refresh" } },
            { name: "read_file", args: { path: "src/a.ts", version: "head" } },
          ],
        };
      },
      AGENTS_AND_VERIFY,
    );
    // The model is told why, and what it can still do; the other tools work.
    const answered = bodies
      .map((b) => b.messages.at(-1).content as string)
      .filter((content) => content.includes("tool_results"));
    expect(answered).toHaveLength(1);
    const results = JSON.parse(answered[0]).tool_results;
    expect(results[0]).toEqual({ name: "search", error: SEARCH_REFUSED });
    expect(results[1].result).toContain("1: function a()");
    expect([row.status, report.status]).toEqual(["complete", "incomplete"]);
    expect(report.agent_audit.requests).toMatchObject({
      limit: 10000,
      scans: 0,
      searches: 0,
      refused: 1,
    });
    expect(report.footer.notes).toContain(
      "Request budget: 1 tree search was not run, because the review had used its share of the 10000 requests the platform allows one review on searching; what a search would have found is missing from this review.",
    );
    expect(report.agent_audit.requests.stopped).toBe(0);
  } finally {
    full.mockRestore();
  }
}, 60000);

it("resumes an isolated runner job using an attempt-specific event", async () => {
  const store = new Store(runtime),
    id = crypto.randomUUID(),
    s = submission();
  s.profile.steps = [
    { id: "checks", uses: "rio/checks@0.1.0", needs: [], with: {} },
    { id: "report", uses: "rio/report@0.1.0", needs: ["checks"], with: {} },
  ];
  const stored = await storeSnapshot(runtime, snapshot),
    snapshotKey = stored.key,
    key = await store.put(`reviews/${id}/submission.json`, {
      ...s,
      snapshot_id: stored.id,
    });
  await runtime.DB.prepare(
    "INSERT INTO reviews(id,tenant,submission_key,status,created_at,token_limit,deadline) VALUES(?,?,?,'queued',?,?,?)",
  )
    .bind(id, "owner", key, Date.now(), 100000, Date.now() + 60000)
    .run();
  await using instance = await introspectWorkflowInstance(runtime.REVIEWS, id);
  await runtime.REVIEWS.create({
    id,
    params: { review_id: id, snapshot_key: snapshotKey },
  });
  const job = hash(`${id}-checks`).slice(0, 32);
  await instance.waitForStepResult({ name: `dispatch-${job}` });
  // The backend lost the first attempt; the workflow dispatches a second one.
  await finishJob(runtime, id, job, 1, {
    outcome: "runner_failed",
    job_id: job,
    attempt: 1,
    version: "head",
    exit_code: 1,
    stdout: "",
    stderr: "runner backend: Network connection lost",
    timed_out: false,
    truncated: false,
  });
  const retry = hash(`${id}-checks-2`).slice(0, 32);
  await instance.waitForStepResult({ name: `dispatch-${retry}` });
  await finishJob(runtime, id, retry, 2, {
    job_id: retry,
    attempt: 2,
    version: "head",
    exit_code: 0,
    stdout: "",
    stderr: "",
    timed_out: false,
    truncated: false,
    artifact: { report: s.report, graphs: s.graphs },
  });
  await instance.waitForStatus("complete");
  expect(
    (
      await runtime.DB.prepare("SELECT status FROM reviews WHERE id=?")
        .bind(id)
        .first<any>()
    ).status,
  ).toBe("complete");
  // Runner graphs are summarized in the audit, never copied.
  const audit = (await (
    await app.request(
      `https://rio/v1/reviews/${id}/audit`,
      { headers },
      runtime,
    )
  ).json()) as any;
  const report = await store.get<any>(
    (
      await runtime.DB.prepare("SELECT report_key FROM reviews WHERE id=?")
        .bind(id)
        .first<any>()
    ).report_key,
  );
  expect(report.status).toBe("complete");
  expect(
    report.footer.notes.some((n: string) =>
      /^checks: runner attempt 1 failed \(runner backend: Network connection lost\); retried$/.test(
        n,
      ),
    ),
  ).toBe(true);
  // Both attempts are kept as completed jobs; only the second carries the artifact.
  expect(audit.executions).toHaveLength(2);
  const analysis = audit.executions.find((e: any) => e.artifact);
  expect(analysis.attempt).toBe(2);
  expect(analysis.artifact.graphs.head).toEqual({
    nodes: 1,
    edges: 0,
    truncated: false,
    omitted: true,
  });
  expect(analysis.artifact.report.schema).toBe("rio-report-v1");
}, 60000);

// A review waiting for a runner job, and the job.
async function waiting(deadline = 240000) {
  const store = new Store(runtime),
    id = crypto.randomUUID(),
    s = submission();
  s.profile.steps = [
    { id: "checks", uses: "rio/checks@0.1.0", needs: [], with: {} },
    { id: "report", uses: "rio/report@0.1.0", needs: ["checks"], with: {} },
  ];
  const stored = await storeSnapshot(runtime, snapshot),
    key = await store.put(`reviews/${id}/submission.json`, {
      ...s,
      snapshot_id: stored.id,
    });
  await runtime.DB.prepare(
    "INSERT INTO reviews(id,tenant,submission_key,status,created_at,token_limit,deadline) VALUES(?,?,?,'queued',?,?,?)",
  )
    .bind(id, "owner", key, Date.now(), 100000, Date.now() + deadline)
    .run();
  const instance = await introspectWorkflowInstance(runtime.REVIEWS, id);
  await runtime.REVIEWS.create({
    id,
    params: { review_id: id, snapshot_key: stored.key },
  });
  const job = hash(`${id}-checks`).slice(0, 32);
  await instance.waitForStepResult({ name: `dispatch-${job}` });
  const row = () =>
    runtime.DB.prepare(
      "SELECT r.status,r.cancelled,r.error,r.report_key,j.status AS job,j.result_key FROM reviews r JOIN jobs j ON j.review_id=r.id WHERE r.id=? AND j.id=?",
    )
      .bind(id, job)
      .first<any>();
  const result = {
    job_id: job,
    attempt: 1,
    version: "head" as const,
    exit_code: 0,
    stdout: "",
    stderr: "",
    timed_out: false,
    truncated: false,
    artifact: { report: s.report, graphs: s.graphs },
  };
  return { id, instance, job, row, result, store, key };
}

it("ends a cancelled review's wait for a runner job at once, and a late result revives nothing", async () => {
  const w = await waiting();
  await using instance = w.instance;
  // A runner has the job when the review is cancelled.
  await runtime.DB.prepare(
    "UPDATE jobs SET status='leased',lease_until=? WHERE id=?",
  )
    .bind(Date.now() + 600000, w.job)
    .run();
  const cancelled = await app.request(
    `https://rio/v1/reviews/${w.id}/cancel`,
    { method: "POST", headers: { ...headers, "rio-protocol": "1" }, body: "{}" },
    runtime,
  );
  expect(cancelled.status).toBe(200);
  // The wait was for up to the job's deadlines; the workflow ends now, and
  // the review is partial with its report.
  await instance.waitForStatus("complete");
  const ended = await w.row();
  expect(ended).toMatchObject({ status: "partial", cancelled: 1, job: "leased" });
  const report = await w.store.get<any>(ended.report_key);
  expect(report.status).toBe("partial");
  expect(report.footer.notes).toContain(CANCELLED_NOTE);
  expect(() => validateReport(report)).not.toThrow();
  // The runner's result arrives later: kept for the audit, the review as it was.
  await finishJob(runtime, w.id, w.job, 1, w.result);
  const after = await w.row();
  expect(after).toMatchObject({
    status: "partial",
    cancelled: 1,
    job: "completed",
    report_key: ended.report_key,
  });
  expect(after.result_key).toBeTruthy();
  expect((await instance.getOutput()) as any).toEqual({
    report_key: ended.report_key,
  });
}, 60000);

it("reports the phase and the time of an analysis job that hit its deadline", async () => {
  const w = await waiting();
  await using instance = w.instance;
  await runtime.DB.prepare(
    "UPDATE jobs SET status='leased',lease_until=? WHERE id=?",
  )
    .bind(Date.now() + 600000, w.job)
    .run();
  const { artifact: _, ...result } = w.result;
  await finishJob(runtime, w.id, w.job, 1, {
    ...result,
    exit_code: 124,
    stderr: "runner wall deadline exceeded during transfer",
    timed_out: true,
    phase: "transfer",
    timing: { transfer_ms: 240000, archive_bytes: 5 << 26, storage_ms: 41000 },
  });
  await instance.waitForStatus("complete");
  const ended = await w.row();
  const report = await w.store.get<any>(ended.report_key);
  // The review goes on without the checks, and says which part ran out.
  expect(ended.status).toBe("complete");
  expect(report.status).toBe("incomplete");
  expect(report.footer.notes).toContain(
    "checks: runner analysis failed (timed out during transfer (transfer 240 s)); deterministic checks did not run",
  );
  expect(report.incomplete.every((c: any) => c.reason === "timeout")).toBe(true);
  expect(report.incomplete.length).toBeGreaterThan(0);
}, 60000);

it("stops the workflow of a cancelled review that does not end in time, and never lets it finish the review later", async () => {
  const w = await waiting();
  await using instance = w.instance;
  // Cancelled, and the workflow does not notice: it is inside a long step
  // (live, a store step that retried against a platform limit for minutes).
  await runtime.DB.prepare(
    "UPDATE reviews SET cancelled=1,status='cancelled',cancelled_at=? WHERE id=?",
  )
    .bind(Date.now() - 1000, w.id)
    .run();
  const review = async () =>
    (await runtime.DB.prepare(
      "SELECT id,status,deadline,submission_key,cancelled_at FROM reviews WHERE id=?",
    )
      .bind(w.id)
      .first<any>())!;
  // Within the grace the workflow may still end the review itself.
  expect(await reconcile(runtime, await review())).toBeNull();
  expect((await w.row()).status).toBe("cancelled");
  expect(
    await reconcile(runtime, await review(), Date.now() + CANCEL_GRACE_MS),
  ).toBe("partial");
  await instance.waitForStatus("terminated");
  const ended = await w.row();
  expect(ended).toMatchObject({
    status: "partial",
    cancelled: 1,
    error: "cancelled",
    job: "failed",
    report_key: `reviews/${w.id}/report-reconciled.json`,
  });
  const report = await w.store.get<any>(ended.report_key);
  expect(report.footer.notes.at(-1)).toBe("Rio ended this review: cancelled.");
  // The withdrawn job's late result is dropped; nothing changes.
  await finishJob(runtime, w.id, w.job, 1, w.result);
  expect(await w.row()).toEqual(ended);
  // Swept again, it is left alone.
  await sweepReviews(runtime, Date.now() + CANCEL_GRACE_MS);
  expect(await w.row()).toEqual(ended);
}, 60000);

it("keeps the end the endpoint gave a review when its workflow finishes afterwards", async () => {
  const w = await waiting();
  await using instance = w.instance;
  // The endpoint ended the overdue review but could not stop the instance.
  const reconciled = `reviews/${w.id}/report-reconciled.json`;
  await runtime.DB.prepare(
    "UPDATE reviews SET status='partial',report_key=?,error='review exceeded its wall budget' WHERE id=?",
  )
    .bind(reconciled, w.id)
    .run();
  const events = async () =>
    (
      await runtime.DB.prepare(
        "SELECT event FROM events WHERE review_id=? AND event LIKE 'review:%'",
      )
        .bind(w.id)
        .all<{ event: string }>()
    ).results.map((r) => r.event);
  const before = await events();
  // Its job's result still arrives, and the workflow runs to its end.
  await runtime.DB.prepare("UPDATE jobs SET status='leased' WHERE id=?")
    .bind(w.job)
    .run();
  const sent = await runtime.REVIEWS.get(w.id);
  const key = await w.store.put(`reviews/${w.id}/late-result.json`, w.result);
  await sent.sendEvent({ type: `job-${w.job}-1`, payload: { key } });
  await instance.waitForStatus("complete");
  expect(await w.row()).toMatchObject({
    status: "partial",
    error: "review exceeded its wall budget",
    report_key: reconciled,
  });
  expect(await events()).toEqual(before);
}, 60000);

it("gives a cancellation that arrives after the report was written the same end in the report", async () => {
  const id = crypto.randomUUID(),
    store = new Store(runtime),
    s = submission();
  s.profile.models.default = "openai/cancelled-after-report";
  s.profile.steps = [
    { id: "agents", uses: "rio/agents@0.1.0", needs: [], with: {} },
  ];
  const transport = vi.spyOn(globalThis, "fetch").mockImplementation(
    async () => {
      const content = JSON.stringify({ result: [] });
      return Response.json({
        content: [{ type: "text", text: content }],
        choices: [{ message: { content } }],
        usage: {
          input_tokens: 80,
          output_tokens: 50,
          prompt_tokens: 80,
          completion_tokens: 50,
        },
      });
    },
  );
  // The request to cancel lands just after the report is stored, complete.
  // The store then fails the write that says so once: the step's next
  // attempt must still find the report to write.
  const put = Store.prototype.put;
  const written: string[] = [];
  let refused = 0;
  const puts = vi
    .spyOn(Store.prototype, "put")
    .mockImplementation(async function (this: Store, key, value) {
      if (
        key === `reviews/${id}/report.json` &&
        (value as any).status === "partial" &&
        !refused++
      )
        throw new Error(
          "put: We encountered an internal error. Please try again. (10001)",
        );
      const stored = await put.call(this, key, value);
      if (key === `reviews/${id}/report.json`) {
        written.push((value as any).status);
        if (written.length === 1)
          await runtime.DB.prepare("UPDATE reviews SET cancelled=1 WHERE id=?")
            .bind(id)
            .run();
      }
      return stored;
    });
  try {
    const stored = await storeSnapshot(runtime, snapshot),
      key = await store.put(`reviews/${id}/submission.json`, {
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
    await instance.modify(async (m) => {
      await m.disableRetryDelays();
    });
    await runtime.REVIEWS.create({
      id,
      params: { review_id: id, snapshot_key: stored.key },
    });
    await instance.waitForStatus("complete");
    const row = await runtime.DB.prepare(
      "SELECT status,cancelled,report_key FROM reviews WHERE id=?",
    )
      .bind(id)
      .first<any>();
    expect(row).toMatchObject({ status: "partial", cancelled: 1 });
    expect(refused).toBe(2);
    // Written once as it stood, and once more to say what the review's row does.
    expect(written[0]).not.toBe("partial");
    expect(written.at(-1)).toBe("partial");
    const report = await store.get<any>(row.report_key);
    expect(report.status).toBe("partial");
    expect(
      report.footer.notes.filter((note: string) => note === CANCELLED_NOTE),
    ).toHaveLength(1);
    expect(() => validateReport(report)).not.toThrow();
    // The event a client follows carries the same report.
    const ended = await runtime.DB.prepare(
      "SELECT event,data FROM events WHERE review_id=? AND event LIKE 'review:%' ORDER BY rowid DESC LIMIT 1",
    )
      .bind(id)
      .first<{ event: string; data: string }>();
    expect(ended?.event).toBe("review:partial");
    expect(JSON.parse(ended!.data).report.status).toBe("partial");
  } finally {
    puts.mockRestore();
    transport.mockRestore();
  }
}, 60000);

it("names a changed file too large to hold in an agent's prompt, without reading it", async () => {
  const memory = new MemorySnapshot({
    base: { "src/a.ts": { mode: 0o100644, content: "export const a = 1;\n" } },
    head: {
      "src/a.ts": { mode: 0o100644, content: "export const a = 2;\n" },
      "data/big.json": { mode: 0o100644, content: "{}" },
      "logo.png": { mode: 0o100644, content: "/w==", encoding: "base64" },
    },
  });
  // The manifest says how large a file is; nothing over the bound is fetched.
  const read: string[] = [];
  const tree = (version: "base" | "head") => ({
    ...memory[version],
    stat: async (path: string) => {
      const entry = await memory[version].stat(path);
      return entry && path === "data/big.json"
        ? { ...entry, size: LARGE + 1 }
        : entry;
    },
    read: async (entry: any) => {
      read.push(`${version}:${entry.path}`);
      if (entry.size > LARGE) throw new Error("a large file was read whole");
      return memory[version].read(entry);
    },
  });
  const previews = await changedCode(
    [
      { path: "data/big.json", lines_changed: 1 },
      { path: "src/a.ts", lines_changed: 1 },
      { path: "logo.png", lines_changed: 0 },
    ],
    { base: tree("base"), head: tree("head") },
  );
  expect(previews).toEqual([
    { path: "data/big.json", omitted: true, bytes: LARGE + 1 },
    {
      path: "src/a.ts",
      diff: "@@ -1,1 +1,1 @@\n  -export const a = 1;\n1 +export const a = 2;",
    },
    { path: "logo.png", binary: true },
  ]);
  expect(read).toEqual(["base:src/a.ts", "head:src/a.ts", "head:logo.png"]);
});

it("renders a change as hunks with context and head line numbers", () => {
  const base = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  const head = [...base];
  head[4] = "line five";
  head.splice(6, 1);
  head.splice(20, 0, "inserted");
  expect(renderDiff(`${base.join("\n")}\n`, `${head.join("\n")}\n`)).toBe(
    [
      "@@ -5,1 +5,1 @@",
      " 2  line 2",
      " 3  line 3",
      " 4  line 4",
      "   -line 5",
      " 5 +line five",
      " 6  line 6",
      // The next hunk starts inside this one's context: no new header.
      "   -line 7",
      " 7  line 8",
      " 8  line 9",
      " 9  line 10",
      "@@ -22,0 +21,1 @@",
      "18  line 19",
      "19  line 20",
      "20  line 21",
      "21 +inserted",
      "22  line 22",
      "23  line 23",
      "24  line 24",
    ].join("\n"),
  );
  expect(renderDiff(null, "a\nb\n")).toBe("@@ -1,0 +1,2 @@\n1 +a\n2 +b");
  expect(renderDiff("a\nb\n", null)).toBe("@@ -1,2 +1,0 @@\n  -a\n  -b");
  expect(renderDiff("x".repeat(500), "y")).toBe(
    `@@ -1,1 +1,1 @@\n  -${"x".repeat(400)}…\n1 +y`,
  );
});

it("shares the prompt's diff budget: short diffs whole, long ones cut alike, the rest named", async () => {
  const file = (lines: number, tag: string) => ({
    mode: 0o100644,
    content: Array.from({ length: lines }, (_, i) => `${tag} ${i}`).join("\n"),
  });
  const snapshot = new MemorySnapshot({
    base: { "gone.ts": file(2, "gone"), "old/name.ts": file(3, "same") },
    head: {
      "a/long.ts": file(400, "first"),
      "b/short.ts": file(2, "short"),
      "c/long.ts": file(400, "second"),
      "new/name.ts": file(3, "same"),
    },
  });
  const changed = [
    { path: "a/long.ts" },
    { path: "b/short.ts" },
    { path: "c/long.ts" },
    { path: "gone.ts" },
    { path: "new/name.ts", old_path: "old/name.ts" },
  ];
  const files = await changedCode(changed, snapshot, 3000);
  expect(files.map((f) => [f.path, f.change, !!f.truncated])).toEqual([
    ["a/long.ts", "added", true],
    ["b/short.ts", "added", false],
    ["c/long.ts", "added", true],
    ["gone.ts", "deleted", false],
    ["new/name.ts", undefined, false],
  ]);
  expect(files[1].diff).toBe("@@ -1,0 +1,2 @@\n1 +short 0\n2 +short 1");
  expect(files[4]).toEqual({
    path: "new/name.ts",
    old_path: "old/name.ts",
    diff: "",
  });
  // Both long diffs are cut at a line end, to within a line of each other.
  const [first, second] = [files[0].diff, files[2].diff];
  expect(first.endsWith("\n")).toBe(false);
  expect(first.split("\n").at(-1)).toMatch(/^ *\d+ \+first \d+$/);
  expect(Math.abs(first.length - second.length)).toBeLessThan(20);
  expect(files.reduce((n, f) => n + f.diff.length, 0)).toBeLessThanOrEqual(3000);
  // A share too short to say anything names the file instead, and leaves its
  // share to the files after it.
  const tight = await changedCode(changed, snapshot, 700);
  expect(tight[0]).toEqual({ path: "a/long.ts", unshown: true });
  expect(tight[2].truncated).toBe(true);
  expect(tight[2].diff.length).toBeGreaterThan(500);
  expect(tight.filter((f) => f.unshown).length).toBe(1);
});

it("retains reproduced evidence when every blind pass misses, with runner artifacts and risk-selected budget", async () => {
  const transport = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_, init) => {
      const body = JSON.parse(init!.body as string),
        messages = body.messages;
      const generated = messages.some((m: any) =>
        m.content.includes("Review the change independently"),
      );
      const disclosed = messages.some((m: any) =>
        m.content.includes("Verify this hypothesis."),
      );
      const toolTurn = messages.at(-1).content;
      let answer: any = { result: [] };
      if (generated) answer = { result: [hypothesis] };
      else if (disclosed && toolTurn.includes('"tool_results"')) {
        const result = JSON.parse(toolTurn).tool_results[0].result;
        answer = {
          result: {
            evidence_level: "reproduced",
            evidence: [
              {
                kind: "execution",
                version: "head",
                job_id: result.job_id,
                demonstrates: "regression",
              },
            ],
          },
        };
      } else if (disclosed)
        answer = {
          tools: [
            {
              name: "run",
              args: {
                version: "head",
                command: ["node", "-e", "throw new Error('regression')"],
              },
            },
          ],
        };
      return Response.json({
        content: [{ type: "text", text: JSON.stringify(answer) }],
        choices: [{ message: { content: JSON.stringify(answer) } }],
        usage: {
          input_tokens: 80,
          output_tokens: 50,
          prompt_tokens: 80,
          completion_tokens: 50,
        },
      });
    });
  try {
    const store = new Store(runtime),
      id = crypto.randomUUID(),
      s = submission();
    s.profile.budget.deep = {
      tokens: 300000,
      agents_max: 5,
      wall_time: "10m",
      verify_tokens: 30000,
    };
    s.profile.steps = [
      {
        id: "triage",
        uses: "rio/triage@0.1.0",
        needs: [],
        with: { sensitive_paths: ["src/**"] },
        rules: [{ when: "risk >= high", then: "budget(deep)" }],
      },
      { id: "agents", uses: "rio/agents@0.1.0", needs: ["triage"], with: {} },
      { id: "verify", uses: "rio/verify@0.1.0", needs: ["agents"], with: {} },
    ];
    const stored = await storeSnapshot(runtime, snapshot),
      snapshotKey = stored.key,
      key = await store.put(`reviews/${id}/submission.json`, {
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
      params: { review_id: id, snapshot_key: snapshotKey },
    });
    const h = validateHypotheses([hypothesis])[0];
    await Promise.all(
      [0, 1, 2].map(async (voter) => {
        const job = hash(`${id}-verify-${h.id}-${voter}-0`).slice(0, 32);
        await instance.waitForStepResult({ name: `dispatch-${job}` });
        await finishJob(runtime, id, job, 1, {
          outcome: "exited",
          job_id: job,
          attempt: 1,
          version: "head",
          exit_code: 1,
          stdout: "regression",
          stderr: "",
          timed_out: false,
          truncated: false,
        });
      }),
    );
    await instance.waitForStatus("complete");
    const row = await runtime.DB.prepare("SELECT * FROM reviews WHERE id=?")
      .bind(id)
      .first<any>();
    const report = await store.get<any>(row.report_key);
    expect(row.token_limit).toBe(300000);
    expect(row.deadline - row.created_at).toBe(600000);
    expect(report.risk_tier.tier).toBe("high");
    expect(report.findings[0].evidence_level).toBe("reproduced");
    expect(report.findings[0].verification.blind_match).toEqual([
      "none",
      "none",
      "none",
    ]);
    expect(
      report.findings[0].evidence.every((s: string) =>
        s.startsWith("execution:head:"),
      ),
    ).toBe(true);
    const response = await app.request(
      `https://rio/v1/reviews/${id}/audit`,
      { headers },
      runtime,
    );
    const audit = (await response.json()) as any;
    expect(audit.executions).toHaveLength(3);
    expect(audit.votes.every((v: any) => v.hypothesis_id === h.id)).toBe(true);
  } finally {
    transport.mockRestore();
  }
}, 60000);

// Security agent and catalog behavior (v0.3) is covered in agents.test.ts.
it.each(["cancelled", "invalid-triage"])(
  "produces a partial report for %s before model execution",
  async (reason) => {
    const store = new Store(runtime),
      id = crypto.randomUUID(),
      s = submission();
    s.fork = true;
    s.profile.steps = [
      {
        id: "triage",
        uses: "rio/triage@0.1.0",
        needs: [],
        with: {},
        rules:
          reason === "invalid-triage"
            ? [{ when: "unknown()", then: "budget(deep)" }]
            : [],
      },
    ];
    const stored = await storeSnapshot(runtime, snapshot),
      snapshotKey = stored.key,
      key = await store.put(`reviews/${id}/submission.json`, {
        ...s,
        snapshot_id: stored.id,
      });
    await runtime.DB.prepare(
      "INSERT INTO reviews(id,tenant,submission_key,status,created_at,token_limit,deadline,cancelled) VALUES(?,?,?,'queued',?,?,?,?)",
    )
      .bind(
        id,
        "owner",
        key,
        Date.now(),
        100000,
        Date.now() + 240000,
        reason === "cancelled" ? 1 : 0,
      )
      .run();
    await using instance = await introspectWorkflowInstance(
      runtime.REVIEWS,
      id,
    );
    await runtime.REVIEWS.create({
      id,
      params: { review_id: id, snapshot_key: snapshotKey },
    });
    await instance.waitForStatus("complete");
    const row = await runtime.DB.prepare(
      "SELECT status,report_key FROM reviews WHERE id=?",
    )
      .bind(id)
      .first<any>();
    expect(row.status).toBe("partial");
    expect((await store.get<any>(row.report_key)).status).toBe("partial");
  },
  60000,
);

it.each([
  ["while the first of two hypotheses is verified", 1, true],
  ["after the agents, before any verification", 0, true],
  ["during verification, the last step", 1, false],
])(
  "keeps what a stopped review had raised and verified: stopped %s",
  async (_, settled, later) => {
    const store = new Store(runtime),
      id = crypto.randomUUID(),
      s = submission();
    const second = {
      ...hypothesis,
      rule_id: "correctness/second",
      message: "The retry now throws too",
      trigger: "a(2)",
    };
    let disclosures = 0;
    const transport = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_, init) => {
        const body = JSON.parse(init!.body as string);
        const generated = body.messages.some((m: any) =>
          m.content.includes("Review the change independently"),
        );
        const disclosed = body.messages.some((m: any) =>
          m.content.includes("Verify this hypothesis."),
        );
        // The review is cancelled while the agent answers, or while the last
        // voter on the first hypothesis does; either answer still arrives.
        if (generated ? !settled : disclosed && ++disclosures === 3)
          await runtime.DB.prepare("UPDATE reviews SET cancelled=1 WHERE id=?")
            .bind(id)
            .run();
        const result = generated
          ? [hypothesis, second]
          : disclosed
            ? {
                evidence_level: "static_proven",
                evidence: [
                  {
                    kind: "code",
                    version: "head",
                    path: "src/a.ts",
                    node_ids: ["h"],
                    demonstrates: "regression",
                  },
                ],
              }
            : [];
        const content = JSON.stringify({ result });
        return Response.json({
          content: [{ type: "text", text: content }],
          choices: [{ message: { content } }],
          usage: {
            input_tokens: 80,
            output_tokens: 50,
            prompt_tokens: 80,
            completion_tokens: 50,
          },
        });
      });
    try {
      s.profile.steps = [
        {
          id: "agents",
          uses: "rio/agents@0.1.0",
          needs: [],
          // No cached result from another test: the agent is asked each time.
          with: { cache: false },
        },
        { id: "verify", uses: "rio/verify@0.1.0", needs: ["agents"], with: {} },
      ];
      // With a step left to run the review ends on the failure path; without
      // one it ends on the complete path, as partial.
      if (later)
        s.profile.steps.push({
          id: "report",
          uses: "rio/report@0.1.0",
          needs: ["verify"],
          with: {},
        });
      const stored = await storeSnapshot(runtime, snapshot),
        key = await store.put(`reviews/${id}/submission.json`, {
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
        "SELECT status,error,report_key FROM reviews WHERE id=?",
      )
        .bind(id)
        .first<any>();
      expect(row.status).toBe("partial");
      // Named for what ended it: nothing in the runtime failed.
      expect(row.error).toBe(later ? "cancelled" : null);
      const report = await store.get<any>(row.report_key);
      expect(report.status).toBe("partial");
      expect(() => validateReport(report)).not.toThrow();
      const [first, other] = validateHypotheses([hypothesis, second]);
      // Only a hypothesis whose verification ran to its end is a finding.
      expect(report.findings.map((f: any) => f.id)).toEqual(
        settled ? [first.id] : [],
      );
      if (settled) {
        expect(report.findings[0].evidence_level).toBe("static_proven");
        expect(report.findings[0].verification.agreeing).toBe(3);
      }
      expect(report.risks).toEqual([]);
      const unverified = settled ? [other] : [first, other];
      expect(report.agent_audit.unverified).toEqual(
        unverified.map((h) => ({
          id: h.id,
          agent: "correctness",
          rule_id: h.rule_id,
          category: "defect",
          severity: "error",
          location: h.location,
          message: h.message,
        })),
      );
      expect(report.agent_audit.incomplete_votes).toBe(later ? undefined : 3);
      expect(report.footer.notes.includes(CANCELLED_NOTE)).toBe(later);
      expect(report.footer.notes).toContain(
        `The review stopped before it finished: ${settled} of 2 raised hypotheses had completed verification and are consolidated here; ${2 - settled} had not and are listed in agent_audit.unverified, not as findings.`,
      );
      // The votes the stop cut short are kept in the audit as cancelled.
      const votes = await runtime.DB.prepare(
        "SELECT hypothesis_id,status FROM votes WHERE review_id=? ORDER BY hypothesis_id,voter",
      )
        .bind(id)
        .all<any>();
      expect(
        votes.results
          .filter((v) => v.hypothesis_id === other.id)
          .map((v) => v.status),
      ).toEqual(settled ? ["cancelled", "cancelled", "cancelled"] : []);
    } finally {
      transport.mockRestore();
    }
  },
  60000,
);

it("reports stored progress when a run is replayed after its review stopped", async () => {
  // A replay past the deadline stops at its first step with nothing in memory.
  const store = new Store(runtime),
    id = crypto.randomUUID(),
    s = submission();
  s.profile.steps = [
    { id: "agents", uses: "rio/agents@0.1.0", needs: [], with: {} },
    { id: "verify", uses: "rio/verify@0.1.0", needs: ["agents"], with: {} },
  ];
  const [first, other, unsettled] = validateHypotheses([
    hypothesis,
    { ...hypothesis, rule_id: "correctness/second", trigger: "a(2)" },
    { ...hypothesis, rule_id: "correctness/third", trigger: "a(3)" },
  ]);
  const progress = new Progress(store, id);
  await progress.raised("agents-correctness", [first, other]);
  await progress.raised("agents-contracts", [unsettled]);
  const verification = {
    voters: 3,
    blind_match: ["none", "none", "none"] as BlindMatch[],
    split: false,
  };
  await progress.settled({
    verified: {
      hypothesis: first,
      evidence_level: "static_proven",
      verification: { ...verification, agreeing: 3 },
      evidence: ["code:head:src/a.ts:h"],
    },
    incomplete: 0,
  });
  // Two of three votes ran out of budget: unproven, so reported as a risk.
  await progress.settled({
    verified: {
      hypothesis: other,
      evidence_level: "plausible",
      verification: { ...verification, agreeing: 1, split: true },
      evidence: [],
    },
    incomplete: 2,
  });
  const stored = await storeSnapshot(runtime, snapshot),
    key = await store.put(`reviews/${id}/submission.json`, {
      ...s,
      snapshot_id: stored.id,
    });
  await runtime.DB.prepare(
    "INSERT INTO reviews(id,tenant,submission_key,status,created_at,token_limit,deadline) VALUES(?,?,?,'queued',?,?,?)",
  )
    .bind(id, "owner", key, Date.now() - 900000, 100000, Date.now() - 1)
    .run();
  await using instance = await introspectWorkflowInstance(runtime.REVIEWS, id);
  await runtime.REVIEWS.create({
    id,
    params: { review_id: id, snapshot_key: stored.key },
  });
  await instance.waitForStatus("complete");
  const row = await runtime.DB.prepare(
    "SELECT status,report_key FROM reviews WHERE id=?",
  )
    .bind(id)
    .first<any>();
  expect(row.status).toBe("partial");
  const report = await store.get<any>(row.report_key);
  expect(report.status).toBe("partial");
  expect(() => validateReport(report)).not.toThrow();
  expect(report.findings.map((f: any) => f.id)).toEqual([first.id]);
  expect(report.risks.map((f: any) => f.id)).toEqual([other.id]);
  expect(report.risks[0].evidence_level).toBe("plausible");
  expect(report.agent_audit.unverified.map((h: any) => h.id)).toEqual([
    unsettled.id,
  ]);
  expect(report.agent_audit.incomplete_votes).toBe(2);
  expect(report.footer.notes).toEqual([
    CANCELLED_NOTE,
    "The review stopped before it finished: 2 of 3 raised hypotheses had completed verification and are consolidated here; 1 had not and are listed in agent_audit.unverified, not as findings.",
    "2 verifier votes did not complete; inspect the vote audit. Missing votes do not reduce quorum.",
  ]);
}, 60000);

it.each([false, true])(
  "dispatches QA and retains neutral recommendations (baseline=%s)",
  async (baseline) => {
    const store = new Store(runtime),
      id = crypto.randomUUID(),
      s = submission();
    s.profile.steps = [
      {
        id: "qa",
        uses: "rio/qa@0.1.0",
        needs: [],
        with: { enabled: true, baseline },
      },
      { id: "verify", uses: "rio/verify@0.1.0", needs: ["qa"], with: {} },
      {
        id: "report",
        uses: "rio/report@0.1.0",
        needs: ["qa", "verify"],
        with: {},
      },
    ];
    if (!baseline) {
      s.profile.qa_standalone = true;
      s.profile.steps.unshift(
        { id: "checks", uses: "rio/checks@0.1.0", needs: [], with: {} },
        { id: "agents", uses: "rio/agents@0.1.0", needs: ["checks"], with: {} },
      );
      s.profile.steps
        .find((step) => step.id === "verify")!
        .needs.push("agents");
    }
    const stored = await storeSnapshot(runtime, snapshot);
    s.snapshot_id = stored.id;
    const submissionKey = await store.put(`reviews/${id}/submission.json`, s);
    await runtime.DB.prepare(
      "INSERT INTO reviews(id,tenant,submission_key,status,created_at,token_limit,deadline) VALUES(?,?,?,'queued',?,?,?)",
    )
      .bind(id, "owner", submissionKey, Date.now(), 100000, Date.now() + 240000)
      .run();
    await using instance = await introspectWorkflowInstance(
      runtime.REVIEWS,
      id,
    );
    await runtime.REVIEWS.create({
      id,
      params: { review_id: id, snapshot_key: stored.key },
    });
    const job = hash(`${id}-qa-qa-head`).slice(0, 32);
    await instance.waitForStepResult({ name: `dispatch-${job}` });
    const cell = { viewport: "mobile", color_scheme: "light" };
    const recommendation = {
      id: "candidate",
      rule_id: "ux/task-efficiency",
      persona: "shopper",
      goal: "Complete checkout",
      journey: "checkout",
      steps: [1],
      cells: [cell],
      route_pattern: "/checkout",
      friction_target: { kind: "duplicate-entry", target: "address" },
      observed_friction: "The form asks for the same address twice.",
      evidence: ["screenshot"],
      basis: {
        heuristic: {
          source: "Nielsen",
          version: "1994",
          reference: "Efficiency",
        },
      },
      proposed_improvement: "Offer address reuse.",
      expected_benefit: "May reduce typing; untested.",
      trade_offs: ["Addresses may differ."],
      priority: "medium",
      confidence: "high",
      verification_status: "unverified",
      rationale: "Verification pending.",
    };
    await finishJob(runtime, id, job, 1, {
      outcome: "exited",
      job_id: job,
      attempt: 1,
      version: "head",
      exit_code: 0,
      stdout: "",
      stderr: "",
      timed_out: false,
      truncated: false,
      artifact: {
        outcome: "complete",
        harness: "codex",
        harness_auth: "gateway",
        policy: { app_isolation: "container" },
        plan: {
          selected: { checkout: ["guidance: REVIEW.md"] },
          cell_count: 1,
        },
        journey_outcomes: [
          {
            journey: "checkout",
            cell,
            outcome: "passed",
            steps: [{ step: 1 }],
            evidence: ["screenshot"],
          },
        ],
        qa_recommendations: [recommendation],
        ux_assessment: [
          {
            rule_id: "ux/error-recovery",
            journey: "checkout",
            cell,
            status: "not_assessed",
            reason: "budget",
            evidence: [],
          },
        ],
        hypotheses: [],
        findings: [],
        evidence: { bytes: 100, artifacts: [] },
        seed: { status: "restored", duration_ms: 1 },
        tokens: 10,
        wall_time_ms: 100,
      },
    });
    if (baseline) {
      const baseJob = hash(`${id}-qa-qa-base`).slice(0, 32);
      await instance.waitForStepResult({ name: `dispatch-${baseJob}` });
      const runs = (
        await runtime.DB.prepare(
          "SELECT version,deadline FROM qa_runs WHERE review_id=? ORDER BY version",
        )
          .bind(id)
          .all<any>()
      ).results;
      expect(runs).toHaveLength(2);
      expect(runs[0].deadline).toBe(runs[1].deadline);
      expect(runs.map((row) => row.version)).toEqual(["base", "head"]);
      await finishJob(runtime, id, baseJob, 1, {
        outcome: "exited",
        job_id: baseJob,
        attempt: 1,
        version: "base",
        exit_code: 0,
        stdout: "",
        stderr: "",
        timed_out: false,
        truncated: false,
        artifact: {
          outcome: "complete",
          journey_outcomes: [],
          findings: [],
          evidence: { bytes: 20, artifacts: [] },
          tokens: 5,
          wall_time_ms: 50,
        },
      });
    }
    await instance.waitForStatus("complete");
    const row = await runtime.DB.prepare(
      "SELECT report_key FROM reviews WHERE id=?",
    )
      .bind(id)
      .first<any>();
    const report = await store.get<any>(row.report_key);
    expect(report.qa.journeys[0].outcome).toBe("passed");
    expect(report.qa.recommendations[0].verification_status).toBe("unverified");
    // Every cell the run reported is one qa:cell event for the live matrix.
    const cells = (
      await runtime.DB.prepare(
        "SELECT data FROM events WHERE review_id=? AND event='qa:cell' ORDER BY seq",
      )
        .bind(id)
        .all<{ data: string }>()
    ).results.map((r) => JSON.parse(r.data));
    expect(cells).toEqual(
      report.qa.journeys.flatMap((j: any) =>
        j.cells.map((c: any) => ({
          journey: j.name,
          viewport: c.viewport,
          color_scheme: c.color_scheme,
          step: c.step_reached ?? 0,
          outcome: c.outcome,
        })),
      ),
    );
    expect(cells.length).toBeGreaterThan(0);
    expect(report.qa.assessment[0].reason).toBe("budget");
    expect(report.findings).toHaveLength(0);
    expect(report.agent_audit.qa.policy_failed).toBe(false);
    expect(report.agent_audit.qa_incomplete).toBe(false);
    expect(await store.get(`reviews/${id}/qa/policy.json`)).toEqual(
      report.agent_audit.qa,
    );
    expect(report.status).toBe("complete");
    expect(report.qa.cost.wall_time_ms).toBe(baseline ? 150 : 100);
    if (!baseline) {
      expect(report.footer.notes).toContain("checks skipped: standalone");
      expect(report.footer.notes).toContain("agents skipped: standalone");
      expect(report.checks).toHaveLength(0);
    }
    if (baseline)
      expect(
        (await store.get<any>(`reviews/${id}/qa/baseline.json`)).outcome,
      ).toBe("complete");

    const recommendationAudit = await store.get<any[]>(
      `reviews/${id}/qa/recommendations.json`,
    );
    expect(recommendationAudit[0].candidate.id).toBe(
      (await import("../src/qa-recommendations")).recommendationId(
        recommendation as any,
      ),
    );
    expect(recommendationAudit[0].candidate.verification_status).toBe(
      "unverified",
    );
    expect(
      (
        await runtime.DB.prepare(
          "SELECT state,token_hash FROM qa_runs WHERE review_id=?",
        )
          .bind(id)
          .first<any>()
      ).token_hash,
    ).toBeNull();
  },
  60000,
);

it("verifies stored QA browser artifacts and publishes only a separate supported recommendation in the report", async () => {
  const fixture = (
    await import("../../crates/rio-core/tests/qa-fixtures/report.json")
  ).default;
  const { canonical } = await import("../src/validation");
  const { recommendationId } = await import("../src/qa-recommendations");
  const store = new Store(runtime),
    id = crypto.randomUUID(),
    s = submission();
  s.profile.budget.fast.tokens = 1000000;
  s.profile.budget.fast.verify_tokens = 100000;
  s.profile.steps = [
    { id: "qa", uses: "rio/qa@0.1.0", needs: [], with: { enabled: true } },
    { id: "verify", uses: "rio/verify@0.1.0", needs: ["qa"], with: {} },
    {
      id: "report",
      uses: "rio/report@0.1.0",
      needs: ["qa", "verify"],
      with: {},
    },
  ];
  const stored = await storeSnapshot(runtime, snapshot);
  s.snapshot_id = stored.id;
  const key = await store.put(`reviews/${id}/submission.json`, s);
  await runtime.DB.prepare(
    "INSERT INTO reviews(id,tenant,submission_key,status,created_at,token_limit,deadline) VALUES(?,?,?,'queued',?,?,?)",
  )
    .bind(id, "owner", key, Date.now(), 1000000, Date.now() + 240000)
    .run();
  const prompts: any[] = [];
  const transport = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_input, init) => {
      const request = JSON.parse(init!.body as string);
      prompts.push(request);
      const text = request.messages.at(-1).content;
      const result =
        typeof text === "string" && text.includes("structured hypothesis")
          ? {
              evidence_level: "reproduced",
              evidence: [
                {
                  kind: "browser",
                  ids: ["shot", "dom", "trace"],
                  demonstrates: "regression",
                },
              ],
              rationale: "Original step shows the missing confirmation.",
            }
          : typeof text === "string" &&
              text.includes("recommendation candidate")
            ? {
                verdict: "support",
                evidence: ["dom"],
                rationale:
                  "Two address entry fields show the reported friction; reuse addresses it.",
              }
            : [];
      return Response.json({
        content: [{ type: "text", text: JSON.stringify({ result }) }],
        usage: { input_tokens: 100, output_tokens: 100 },
      });
    });
  try {
    await using instance = await introspectWorkflowInstance(
      runtime.REVIEWS,
      id,
    );
    await runtime.REVIEWS.create({
      id,
      params: { review_id: id, snapshot_key: stored.key },
    });
    const job = hash(`${id}-qa-qa-head`).slice(0, 32);
    await instance.waitForStepResult({ name: `dispatch-${job}` });
    const run = await runtime.DB.prepare(
      "SELECT id FROM qa_runs WHERE review_id=? AND version='head'",
    )
      .bind(id)
      .first<any>();
    const cell = { viewport: "mobile", color_scheme: "light" };
    const png = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
      ),
      (c) => c.charCodeAt(0),
    );
    const artifacts: any[] = [];
    for (const [artifactId, kind, data] of [
      ["shot", "screenshot", png],
      [
        "dom",
        "dom",
        new TextEncoder().encode(
          '{"text":"No confirmation; enter address twice"}',
        ),
      ],
      ["trace", "trace", new Uint8Array([1])],
    ] as const) {
      const { blake3 } = await import("@noble/hashes/blake3.js"),
        { bytesToHex } = await import("@noble/hashes/utils.js");
      const descriptor = {
        id: artifactId,
        kind,
        journey: "checkout",
        ...(kind === "trace" ? {} : { step: 1 }),
        cell,
        bytes: data.length,
        content_hash: bytesToHex(blake3(data)),
        sanitized: true,
      };
      const objectKey = `qa-test/${id}/${artifactId}`;
      await runtime.ARTIFACTS.put(objectKey, data);
      await runtime.DB.prepare(
        "INSERT INTO qa_evidence(run_id,id,tenant,review_id,generation,object_key,descriptor,bytes,state,expires_at,created_at) VALUES(?,?, 'owner',?, 'test',?,?,?,'stored',?,?)",
      )
        .bind(
          run.id,
          artifactId,
          id,
          objectKey,
          canonical(descriptor),
          data.length,
          Date.now() + 3600000,
          Date.now(),
        )
        .run();
      artifacts.push(descriptor);
    }
    const finding: any = {
      ...structuredClone(fixture.findings[0]),
      id: "d".repeat(64),
      rule_id: "ui/no-feedback",
      state: "new",
      severity: "warning",
      source: { agent: "qa" },
      evidence: ["shot", "dom"],
      qa: {
        ...fixture.findings[0].qa,
        journey: "checkout",
        step: 1,
        route: "/checkout",
        attribution: "journey",
      },
    };
    finding.locations = [
      {
        ...finding.location,
        cell,
        evidence: ["shot", "dom"],
        occurrence_state: "new",
      },
    ];
    const criterion = {
      id: "ux/task-efficiency",
      source: {
        title: "Nielsen",
        version: "1994",
        url: "https://example.test/efficiency",
      },
      applicability: "Repeated entry",
      required_evidence: ["DOM"],
    };
    const recommendation: any = {
      ...structuredClone(fixture.qa.recommendations[0]),
      journey: "checkout",
      rule_id: criterion.id,
      steps: [1],
      cells: [cell],
      evidence: ["dom"],
      basis: {
        heuristic: {
          source: "Nielsen",
          version: "1994",
          reference: criterion.source.url,
        },
      },
    };
    recommendation.id = recommendationId(recommendation);
    const observation = {
      rule_id: finding.rule_id,
      kind: finding.qa.kind,
      journey: "checkout",
      step: 1,
      cell,
      route: "/checkout",
      expected: { confirmation: true },
      observed: { confirmation: false },
      evidence: ["shot", "dom"],
    };
    await finishJob(runtime, id, job, 1, {
      outcome: "exited",
      job_id: job,
      attempt: 1,
      version: "head",
      exit_code: 0,
      stdout: "",
      stderr: "",
      timed_out: false,
      truncated: false,
      artifact: {
        outcome: "complete",
        harness: "codex",
        harness_auth: "gateway",
        policy: { app_isolation: "container" },
        plan: { selected: { checkout: ["full"] }, cell_count: 1 },
        journey_outcomes: [
          {
            journey: "checkout",
            cell,
            outcome: "failed",
            failed_step: 1,
            steps: [{ step: 1 }],
            evidence: ["shot"],
            verification_context: {
              journey: {
                name: "checkout",
                persona: "shopper",
                goal: "Buy",
                steps: [{ do: "Pay", expect: "Confirmation" }],
              },
              guidance: [
                {
                  path: "REVIEW.md",
                  scope_dir: "",
                  content_hash: "a".repeat(64),
                  lines: ["Show confirmation after checkout."],
                },
              ],
              criteria: [criterion],
            },
          },
        ],
        hypotheses: [observation],
        observation_candidates: [
          {
            finding,
            expected: observation.expected,
            observed: observation.observed,
            cell,
          },
        ],
        findings: [],
        qa_recommendations: [recommendation],
        ux_assessment: [],
        evidence: { bytes: 100, artifacts },
      },
    });
    await instance.waitForStatus("complete");
    const row = await runtime.DB.prepare(
      "SELECT report_key FROM reviews WHERE id=?",
    )
      .bind(id)
      .first<any>();
    const report = await store.get<any>(row.report_key);
    expect(report.status).toBe("complete");
    expect(report.findings[0].evidence_level).toBe("reproduced");
    expect(report.findings[0].category).toBe("ux");
    expect(report.qa.observations_unverified).toEqual([]);
    expect(report.qa.recommendations[0].verification_status).toBe("supported");
    expect(report.qa.recommendations[0].rationale).toContain(
      "expected benefit remains untested",
    );
    expect(report.agent_audit.qa.policy_matches).toEqual([finding.id]);
    expect(prompts).toHaveLength(12);
    expect(
      prompts.some(
        (request) =>
          Array.isArray(request.messages[0].content) &&
          request.messages[0].content.some(
            (block: any) => block.type === "image",
          ),
      ),
    ).toBe(true);
    expect(
      (await store.get<any[]>(`reviews/${id}/qa/verification.json`))[0].votes,
    ).toHaveLength(3);
  } finally {
    transport.mockRestore();
  }
}, 60000);

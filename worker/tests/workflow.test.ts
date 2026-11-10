import {
  env,
  applyD1Migrations,
  introspectWorkflowInstance,
} from "cloudflare:test";
import { beforeAll, it, expect, vi } from "vitest";
import { app } from "../src/index";
import { Store } from "../src/storage";
import { finishJob } from "../src/jobs";
import { hash, validateHypotheses, validateReport } from "../src/validation";
import { allMigrations, hypothesis, snapshot, submission } from "./fixtures";
import { storeSnapshot, uploadSnapshot } from "./snapshots";
import type { Env } from "../src/types";
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

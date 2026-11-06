import {
  env,
  applyD1Migrations,
  introspectWorkflowInstance,
} from "cloudflare:test";
import { beforeAll, it, expect, vi } from "vitest";
import { app } from "../src/index";
import { Store } from "../src/storage";
import { finishJob } from "../src/jobs";
import { hash, validateHypotheses } from "../src/validation";
import { allMigrations, hypothesis, snapshot, submission } from "./fixtures";
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
      const uploaded = await app.request(
        "https://rio/v1/snapshots",
        { method: "POST", headers, body: JSON.stringify(snapshot) },
        bindings,
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
    const uploaded = await app.request(
      "https://rio/v1/snapshots",
      { method: "POST", headers, body: JSON.stringify(snapshot) },
      runtime,
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
  const snapshotKey = await store.put(`snapshots/test/${id}.json`, snapshot),
    key = await store.put(`reviews/${id}/submission.json`, s);
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
  await finishJob(runtime, id, job, 1, {
    job_id: job,
    attempt: 1,
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
    const snapshotKey = await store.put(`snapshots/test/${id}.json`, snapshot),
      key = await store.put(`reviews/${id}/submission.json`, s);
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

it.each(["explicit", "triage"])(
  "reports security enabled by %s as unavailable without making a security model call",
  async (selection) => {
    const transport = vi.spyOn(globalThis, "fetch");
    try {
      const store = new Store(runtime),
        id = crypto.randomUUID(),
        s = submission();
      s.profile.steps = [
        {
          id: "triage",
          uses: "rio/triage@0.1.0",
          needs: [],
          with: { sensitive_paths: ["src/**"] },
        },
        {
          id: "security",
          uses: "rio/security@0.2.0",
          needs: ["triage"],
          with: { enabled: selection === "explicit" },
          rules:
            selection === "triage"
              ? [{ when: "risk >= high", then: "enable(security)" }]
              : [],
        },
        {
          id: "verify",
          uses: "rio/verify@0.1.0",
          needs: ["security"],
          with: {},
        },
      ];
      const snapshotKey = await store.put(
          `snapshots/test/${id}.json`,
          snapshot,
        ),
        key = await store.put(`reviews/${id}/submission.json`, s);
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
      await instance.waitForStatus("complete");
      const row = await runtime.DB.prepare(
        "SELECT report_key FROM reviews WHERE id=?",
      )
        .bind(id)
        .first<any>();
      const report = await store.get<any>(row.report_key);
      expect(report.footer.notes.join(" ")).toContain(
        "security review was not performed",
      );
      expect(report.status).toBe("partial");
      expect(transport).not.toHaveBeenCalled();
      expect(report.security).toBeUndefined();
    } finally {
      transport.mockRestore();
    }
  },
  60000,
);

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
    const snapshotKey = await store.put(`snapshots/test/${id}.json`, snapshot),
      key = await store.put(`reviews/${id}/submission.json`, s);
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

import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, it, expect } from "vitest";
import worker, { app } from "../src/index";
import { D1Ledger, Store } from "../src/storage";
import { hash, canonical } from "../src/validation";
import { jobToken, sign } from "../src/auth";
import { createJob, createModelJob, finishJob } from "../src/jobs";
import { RUNNER_SEEN_MS, runnerModelEndpoint } from "../src/council-audit";
import { allMigrations, profile, snapshot, submission } from "./fixtures";
import type { Env } from "../src/types";
import contracts from "../../docs/verifier-contracts.md?raw";
import { lineageId } from "../src/lineage";
import { manifestOf, uploadSnapshot } from "./snapshots";
const snapshotId = manifestOf(snapshot).id;
const testEnv = env as Env;
const owner = {
  authorization: "Bearer test-owner-token-at-least-32-characters",
  "content-type": "application/json",
  "rio-protocol": "1",
};
const fakeWorkflow = {
  created: [] as string[],
  events: [] as any[],
  async create({ id }: any) {
    this.created.push(id);
    return { id };
  },
  async get(id: string) {
    return {
      sendEvent: async (event: any) => {
        this.events.push({ id, ...event });
      },
    };
  },
};
const jobs: any[] = [];
const runtime = {
  ...testEnv,
  REVIEWS: fakeWorkflow,
  JOBS: { send: async (job: any) => jobs.push(job) },
} as unknown as Env;
async function request(
  path: string,
  method = "GET",
  value?: any,
  headers: Record<string, string> = owner,
) {
  return app.request(
    `https://rio.test${path}`,
    {
      method,
      headers,
      body:
        value === undefined
          ? undefined
          : typeof value === "string" || value instanceof Uint8Array
            ? value
            : JSON.stringify(value),
    },
    runtime,
  );
}
function upload(value = snapshot, headers: Record<string, string> = owner) {
  return uploadSnapshot(
    (path, method, body) => request(path, method, body as any, headers),
    value,
  );
}
async function createReview() {
  const uploaded = await upload();
  expect(uploaded.status).toBe(201);
  const { id } = (await uploaded.json()) as any;
  const s = submission();
  s.snapshot_id = id;
  const response = await request("/v1/reviews", "POST", s);
  expect(await response.clone().text()).not.toContain("invalid");
  expect(response.status).toBe(202);
  return ((await response.json()) as any).id as string;
}
beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, allMigrations);
});
beforeEach(async () => {
  await testEnv.DB.batch(
    [
      "feedback",
      "findings",
      "lineage_reviews",
      "lineages",
      "votes",
      "hypotheses",
      "usage",
      "events",
      "jobs",
      "reviews",
      "snapshots",
      "api_tokens",
    ].map((t) => testEnv.DB.prepare(`DELETE FROM ${t}`)),
  );
  fakeWorkflow.created = [];
  fakeWorkflow.events = [];
  jobs.length = 0;
});
describe("Worker API and storage", () => {
  it.each([
    [{ PROMPT_LAYOUT: "agent-order,fast" }, "fast"],
    [{ PROMPT_CACHE: "anthropic,gemini" }, "gemini"],
  ])(
    "rejects a submission while a prompt switch is unknown (%j), naming the value",
    async (switches, value) => {
      const uploaded = await upload();
      const s = submission();
      s.snapshot_id = ((await uploaded.json()) as any).id;
      const response = await app.request(
        "https://rio.test/v1/reviews",
        { method: "POST", headers: owner, body: JSON.stringify(s) },
        { ...runtime, ...switches },
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toContain(value);
      expect(
        (await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM reviews").first<any>())
          .n,
      ).toBe(0);
    },
  );
  it("rejects a submission whose reachable model aliases cannot be routed, naming the alias", async () => {
    const uploaded = await upload();
    const { id } = (await uploaded.json()) as any;
    const steps = (declaration: Record<string, any>[] = []) => [
      {
        id: "agents",
        uses: "rio/agents@0.1.0",
        needs: [],
        with: {},
        agents: declaration,
      },
      { id: "verify", uses: "rio/verify@0.1.0", needs: ["agents"], with: {} },
    ];
    const post = async (
      models: Record<string, string>,
      env = runtime,
      declaration: Record<string, any>[] = [],
    ) => {
      const s = submission();
      s.snapshot_id = id;
      s.profile.models = models;
      s.profile.steps = steps(declaration);
      return app.request(
        "https://rio.test/v1/reviews",
        { method: "POST", headers: owner, body: JSON.stringify(s) },
        env,
      );
    };
    const rejected = await post({
      default: "custom-node-openai/gpt",
      verifier: "anthropic/test",
    });
    expect(rejected.status).toBe(400);
    expect(((await rejected.json()) as any).error).toBe(
      "model alias default (custom-node-openai/gpt): model custom-node-openai/… requires AI Gateway (AI_GATEWAY_URL is not configured)",
    );
    // An agent-named alias that a step declaration overrides is never called,
    // as in the Workflow; it does not block the submission.
    const overridden = await post(
      {
        default: "openai/test",
        verifier: "anthropic/test",
        correctness: "custom-unused/x",
      },
      runtime,
      [{ correctness: { model: "default" } }],
    );
    expect(overridden.status).toBe(202);
    // Without the declaration, triage could select correctness with that alias.
    const reachable = await post({
      default: "openai/test",
      verifier: "anthropic/test",
      correctness: "custom-unused/x",
    });
    expect(reachable.status).toBe(400);
    expect(((await reachable.json()) as any).error).toMatch(
      /^model alias correctness /,
    );
    // With the gateway and the provider configured, custom models are accepted.
    const configured = {
      ...runtime,
      AI_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/acct/rio",
      AI_GATEWAY_TOKEN: "gateway-token-value",
      AI_GATEWAY_PROVIDERS: JSON.stringify({
        "node-openai": { protocol: "openai" },
      }),
    } as Env;
    const accepted = await post(
      {
        default: "custom-node-openai/gpt",
        verifier: "compat/custom-node-openai/other",
      },
      configured,
    );
    expect(accepted.status).toBe(202);
    expect(JSON.stringify(await accepted.json())).not.toContain(
      "gateway-token-value",
    );
  });
  it("negotiates version and rejects unauthorized or cross-tenant access", async () => {
    expect((await request("/health")).status).toBe(200);
    expect(
      (await upload(snapshot, { "content-type": "application/json" })).status,
    ).toBe(401);
    const id = await createReview();
    expect(fakeWorkflow.created).toEqual([id]);
    const token = "a-different-tenant-token-32-characters";
    await testEnv.DB.prepare(
      "INSERT INTO api_tokens(hash,tenant,scope,expires_at) VALUES(?,?,?,?)",
    )
      .bind(hash(token), "other", "reviews:read", Date.now() + 60000)
      .run();
    expect(
      (
        await request(`/v1/reviews/${id}`, "GET", undefined, {
          authorization: `Bearer ${token}`,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          `/v1/reviews/${id}/cancel`,
          "POST",
          {},
          { authorization: `Bearer ${token}` },
        )
      ).status,
    ).toBe(401);
    expect(
      (await upload(snapshot, { ...owner, "rio-protocol": "2" })).status,
    ).toBe(400);
  });
  it("rejects invalid paths, graphs, guidance and review contracts", async () => {
    const unsafe = structuredClone(snapshot);
    unsafe.head["../escape"] = { mode: 0o100644, content: "x" };
    expect((await upload(unsafe)).status).toBe(400);
    const uploaded = await upload();
    const s = submission();
    s.snapshot_id = ((await uploaded.json()) as any).id;
    s.graphs.head.nodes[0].line_end = 999;
    expect((await request("/v1/reviews", "POST", s)).status).toBe(400);
    s.graphs.head.nodes[0].line_end = 1;
    s.owner_guidance = [
      {
        path: "AGENTS.md",
        scope_dir: "",
        content_hash: "fake",
        lines: ["mutable injected guidance"],
      },
    ];
    expect((await request("/v1/reviews", "POST", s)).status).toBe(400);
  });
  it("atomically reserves a shared review budget under concurrent fan-out", async () => {
    const id = await createReview();
    await testEnv.DB.prepare("UPDATE reviews SET token_limit=100 WHERE id=?")
      .bind(id)
      .run();
    const ledger = new D1Ledger(runtime, id);
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => ledger.reserve("voter", "verify", 40)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(await ledger.remaining()).toBe(20);
    const first = (
      results.find(
        (r) => r.status === "fulfilled",
      ) as PromiseFulfilledResult<string>
    ).value;
    const usage = {
      phase: "verify",
      actor: "voter",
      model: "openai/test",
      input_tokens: 10,
      output_tokens: 10,
      cost_usd: 0.001,
    };
    await ledger.settle(first, usage);
    await ledger.settle(first, usage);
    expect(await ledger.remaining()).toBe(40);
  });
  it("leases model jobs only to a runner that advertises a model endpoint", async () => {
    const id = await createReview();
    await createModelJob(
      runtime,
      id,
      "model1",
      {
        model: "llama-4",
        system: "You are the skeptic.",
        content: '<repository_data label="hypothesis">PACK</repository_data>',
        max_tokens: 1024,
      },
      60000,
    );
    // Only a running review's model jobs are served.
    await testEnv.DB.prepare("UPDATE reviews SET status='running' WHERE id=?")
      .bind(id)
      .run();
    // Model jobs are claimed, never queued for the Sandbox.
    expect(jobs.some((j) => j.job_id === "model1")).toBe(false);
    const runner = {
      authorization: "Bearer test-runner-secret-at-least-32-characters",
    };
    const selfHosted = { ...runtime, RUNNER_BACKEND: "self-hosted" } as Env;
    const plain = await request("/v1/runner/claim", "POST", {}, runner);
    expect(((await plain.json()) as any).job).toBeNull();
    expect(await runnerModelEndpoint(selfHosted)).toBe(false);
    const capable = await request(
      "/v1/runner/claim",
      "POST",
      { capabilities: { model_endpoint: true } },
      runner,
    );
    const claimed = (await capable.json()) as any;
    expect(claimed.job).toMatchObject({
      kind: "model",
      needs: [],
      snapshot_id: "",
    });
    expect(claimed.job.model.content).toContain("PACK");
    expect(await runnerModelEndpoint(selfHosted)).toBe(true);
    // The Sandbox backend never serves self-hosted members.
    expect(
      await runnerModelEndpoint({
        ...runtime,
        RUNNER_BACKEND: "sandbox",
      } as Env),
    ).toBe(false);
    const path = `/v1/runner/${id}/model1/1/complete`;
    const complete = async (artifact: unknown) => {
      const body = JSON.stringify({
        outcome: "exited",
        job_id: "model1",
        attempt: 1,
        version: "head",
        exit_code: 0,
        stdout: "",
        stderr: "",
        timed_out: false,
        truncated: false,
        artifact,
      });
      return request(path, "POST", body, {
        authorization: `Bearer ${claimed.token}`,
        "rio-signature": await sign(claimed.token, body),
      });
    };
    expect((await complete({ content: 42 })).status).toBe(400);
    expect(
      (await complete({ content: "{}", input_tokens: 9, output_tokens: 1 }))
        .status,
    ).toBe(200);
    // A plain runner claiming later does not hide the capable one; the
    // capability lapses only when no capable runner has claimed recently.
    await request("/v1/runner/claim", "POST", {}, runner);
    expect(await runnerModelEndpoint(selfHosted)).toBe(true);
    expect(
      await runnerModelEndpoint(selfHosted, Date.now() + RUNNER_SEEN_MS + 1000),
    ).toBe(false);
  });
  it("never serves a model job once its review has finished", async () => {
    const id = await createReview();
    await createModelJob(
      runtime,
      id,
      "model-late",
      { model: "llama-4", system: "s", content: "PACK", max_tokens: 16 },
      60000,
    );
    await testEnv.DB.prepare("UPDATE reviews SET status='complete' WHERE id=?")
      .bind(id)
      .run();
    const claim = await request(
      "/v1/runner/claim",
      "POST",
      { capabilities: { model_endpoint: true } },
      { authorization: "Bearer test-runner-secret-at-least-32-characters" },
    );
    expect(((await claim.json()) as any).job).toBeNull();
  });
  it("signs completion capabilities for one review, job and attempt, with idempotent replay", async () => {
    const id = await createReview(),
      job = "job1";
    await createJob(runtime, id, job, "run", ["false"], "head", snapshotId);
    expect(jobs).toHaveLength(1);
    const claim = await request(
      "/v1/runner/claim",
      "POST",
      {},
      { authorization: "Bearer test-runner-secret-at-least-32-characters" },
    );
    expect(claim.status).toBe(200);
    const claimed = (await claim.json()) as any;
    expect(claimed.job.job_id).toBe(job);
    // Signed bytes are verified verbatim: unsorted keys and an integral float that
    // JavaScript would re-serialize as `1` must still match the runner's signature.
    const result = `{"version":"head","job_id":${JSON.stringify(job)},"attempt":1,"exit_code":1.0,"stdout":"failed","stderr":"","timed_out":false,"truncated":false}`;
    const path = `/v1/runner/${id}/${job}/1/complete`,
      token = claimed.token,
      signature = await sign(token, result);
    expect(signature).not.toBe(
      await sign(token, canonical(JSON.parse(result))),
    );
    expect(
      (
        await request(path, "POST", result, {
          authorization: `Bearer ${token}`,
          "rio-signature": "bad",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(path.replace("/1/", "/2/"), "POST", result, {
          authorization: `Bearer ${token}`,
          "rio-signature": signature,
        })
      ).status,
    ).toBe(401);
    for (let n = 0; n < 2; n++)
      expect(
        (
          await request(path, "POST", result, {
            authorization: `Bearer ${token}`,
            "rio-signature": signature,
          })
        ).status,
      ).toBe(200);
    const row = await testEnv.DB.prepare(
      "SELECT status,result_key FROM jobs WHERE id=?",
    )
      .bind(job)
      .first<any>();
    expect(row.status).toBe("completed");
    expect((await new Store(runtime).get<any>(row.result_key)).stdout).toBe(
      "failed",
    );
    expect(fakeWorkflow.events[0].type).toBe("job-job1-1");
  });
  it("rejects expired capabilities and preserves cancellation state", async () => {
    const id = await createReview();
    await createJob(runtime, id, "job1", "run", ["true"], "head", snapshotId);
    const token = await jobToken(runtime, id, "job1", 1, Date.now() - 1);
    expect(
      (
        await request(
          `/v1/runner/${id}/job1/1/complete`,
          "POST",
          {},
          { authorization: `Bearer ${token}` },
        )
      ).status,
    ).toBe(401);
    expect((await request(`/v1/reviews/${id}/cancel`, "POST", {})).status).toBe(
      200,
    );
    expect(await new Store(runtime).cancelled(id)).toBe(true);
  });
  it("records a runner backend failure on the last queue delivery instead of waiting for the step timeout", async () => {
    const id = crypto.randomUUID();
    await runtime.DB.prepare(
      "INSERT INTO reviews(id,tenant,submission_key,status,created_at,token_limit,deadline) VALUES(?,?,?,'queued',?,?,?)",
    )
      .bind(
        id,
        "owner",
        `reviews/${id}/submission.json`,
        Date.now(),
        100000,
        Date.now() + 60000,
      )
      .run();
    await createJob(
      runtime,
      id,
      "job-fail",
      "checks",
      ["rio-internal", "rio/checks"],
      "head",
      snapshotId,
      1,
      { profile },
    );
    const sandboxEnv = {
      ...runtime,
      RUNNER_BACKEND: "sandbox",
      SANDBOX: {
        idFromName: (name: string) => name,
        get: () => ({
          fetch: async () => {
            throw new Error("Cloudflare Container is unavailable");
          },
        }),
      },
    } as unknown as Env;
    const outcomes: string[] = [];
    const message = (attempts: number) => ({
      body: { review_id: id, job_id: "job-fail", attempt: 1 },
      attempts,
      ack: () => outcomes.push(`ack:${attempts}`),
      retry: () => outcomes.push(`retry:${attempts}`),
    });
    await worker.queue(
      { messages: [message(1), message(2)] } as any,
      sandboxEnv,
    );
    expect(outcomes).toEqual(["retry:1", "retry:2"]);
    expect(
      (
        await runtime.DB.prepare("SELECT status FROM jobs WHERE id=?")
          .bind("job-fail")
          .first<any>()
      ).status,
    ).toBe("leased");
    await worker.queue({ messages: [message(3)] } as any, sandboxEnv);
    expect(outcomes.at(-1)).toBe("ack:3");
    const row = await runtime.DB.prepare(
      "SELECT status,result_key FROM jobs WHERE id=?",
    )
      .bind("job-fail")
      .first<any>();
    expect(row.status).toBe("completed");
    const result = await new Store(runtime).get<any>(row.result_key);
    expect(result.outcome).toBe("runner_failed");
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toBe(
      "runner backend: Cloudflare Container is unavailable",
    );
    expect(fakeWorkflow.events.at(-1)).toMatchObject({
      id,
      type: "job-job-fail-1",
    });
  });

  it("publishes one immutable winner for racing completions and retains cancelled job evidence", async () => {
    const id = await createReview(),
      store = new Store(runtime);
    await createJob(runtime, id, "race", "run", ["false"], "head", snapshotId);
    const result = {
      job_id: "race",
      attempt: 1,
      version: "head" as const,
      exit_code: 1,
      stdout: "first",
      stderr: "",
      timed_out: false,
      truncated: false,
    };
    const results = await Promise.allSettled([
      finishJob(runtime, id, "race", 1, { ...result }),
      finishJob(runtime, id, "race", 1, { ...result, stdout: "second" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const row = await runtime.DB.prepare(
      "SELECT result_key FROM jobs WHERE id='race'",
    ).first<any>();
    const winner = await store.get<any>(row.result_key);
    expect(["first", "second"]).toContain(winner.stdout);
    expect(
      fakeWorkflow.events.every((e) => e.payload.key === row.result_key),
    ).toBe(true);
    await finishJob(runtime, id, "race", 1, {
      ...result,
      stdout: winner.stdout,
    });
    await createJob(
      runtime,
      id,
      "cancelled-job",
      "run",
      ["true"],
      "head",
      snapshotId,
    );
    // A runner has this job; no runner has taken the other.
    await runtime.DB.prepare(
      "UPDATE jobs SET status='leased',lease_until=? WHERE id='cancelled-job'",
    )
      .bind(Date.now() + 600000)
      .run();
    await createJob(
      runtime,
      id,
      "unstarted-job",
      "run",
      ["true"],
      "head",
      snapshotId,
    );
    const before = fakeWorkflow.events.length;
    await request(`/v1/reviews/${id}/cancel`, "POST", {});
    // The workflow's waits for both jobs are ended, with no result.
    expect(
      fakeWorkflow.events
        .slice(before)
        .map((e) => [e.type, e.payload])
        .sort(),
    ).toEqual([
      ["job-cancelled-job-1", { cancelled: true }],
      ["job-unstarted-job-1", { cancelled: true }],
    ]);
    const events = fakeWorkflow.events.length;
    await finishJob(runtime, id, "cancelled-job", 1, {
      ...result,
      job_id: "cancelled-job",
      exit_code: 0,
    });
    expect(fakeWorkflow.events).toHaveLength(events);
    const status = async (job: string) =>
      (
        await runtime.DB.prepare("SELECT status FROM jobs WHERE id=?")
          .bind(job)
          .first<any>()
      ).status;
    expect(await status("cancelled-job")).toBe("completed");
    // The job nobody started is withdrawn: it cannot be leased or completed.
    expect(await status("unstarted-job")).toBe("failed");
    await finishJob(runtime, id, "unstarted-job", 1, {
      ...result,
      job_id: "unstarted-job",
      exit_code: 0,
    });
    expect(await status("unstarted-job")).toBe("failed");
    // A second cancel sends nothing more: no job is open.
    await request(`/v1/reviews/${id}/cancel`, "POST", {});
    expect(fakeWorkflow.events).toHaveLength(events);
  });
  it("changes selected budget from creation time without resetting spent or reserved tokens", async () => {
    const id = await createReview(),
      store = new Store(runtime),
      p = structuredClone(profile);
    p.budget.deep = { tokens: 300000, wall_time: "10m", agents_max: 5 };
    await runtime.DB.prepare(
      "UPDATE reviews SET tokens_used=100,tokens_reserved=40 WHERE id=?",
    )
      .bind(id)
      .run();
    await store.selectBudget(id, p, "deep");
    const row = await runtime.DB.prepare("SELECT * FROM reviews WHERE id=?")
      .bind(id)
      .first<any>();
    expect(row.token_limit).toBe(300000);
    expect(row.deadline - row.created_at).toBe(600000);
    expect(await new D1Ledger(runtime, id).remaining()).toBe(299860);
    expect(await store.remainingMs(id)).toBeGreaterThan(590000);
  });
  it("returns ordered resumable events, report and a tenant-scoped vote audit", async () => {
    const id = await createReview(),
      store = new Store(runtime);
    await store.event(id, "step:started", { step: "verify" });
    await store.event(id, "step:finished", { step: "verify" });
    const stream = await request(`/v1/reviews/${id}/events`);
    expect(stream.headers.get("content-type")).toBe("text/event-stream");
    const text = await stream.text();
    expect(text).toContain("event: step:started");
    const seq = /id: (\d+)/.exec(text)![1];
    expect(
      await (await request(`/v1/reviews/${id}/events?after=${seq}`)).text(),
    ).not.toContain("event: step:started");
    const report = submission().report;
    const key = await store.put(`reviews/${id}/report.json`, report);
    await testEnv.DB.prepare(
      "UPDATE reviews SET report_key=?,status=? WHERE id=?",
    )
      .bind(key, "complete", id)
      .run();
    expect(await (await request(`/v1/reviews/${id}/report`)).json()).toEqual(
      report,
    );
    expect(await (await request(`/v1/reviews/${id}/audit`)).json()).toEqual({
      hypotheses: [],
      votes: [],
      usage: [],
      executions: [],
    });
  });
  it("exposes cache usage per call and reads historical rows as not reported", async () => {
    const id = await createReview();
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        "INSERT INTO usage(id,review_id,actor,phase,reserved,status,input_tokens,output_tokens,cost_usd,model) VALUES('u1',?,'a','generation',9,'completed',5,1,NULL,'openai/m')",
      ).bind(id),
      testEnv.DB.prepare(
        "INSERT INTO usage(id,review_id,actor,phase,reserved,status,input_tokens,output_tokens,cost_usd,model,cache_read_tokens,cache_write_tokens,usage_convention,cost_source) VALUES('u2',?,'a','generation',99999,'completed',10050,300,NULL,'anthropic/m',10000,0,'verified','unknown')",
      ).bind(id),
    ]);
    const audit: any = await (await request(`/v1/reviews/${id}/audit`)).json();
    expect(audit.usage).toEqual([
      {
        actor: "a",
        phase: "generation",
        status: "completed",
        input_tokens: 5,
        cache_read_tokens: null,
        cache_write_tokens: null,
        usage_convention: null,
        output_tokens: 1,
        cost_usd: null,
        cost_source: null,
        model: "openai/m",
      },
      {
        actor: "a",
        phase: "generation",
        status: "completed",
        input_tokens: 10050,
        cache_read_tokens: 10000,
        cache_write_tokens: 0,
        usage_convention: "verified",
        output_tokens: 300,
        cost_usd: null,
        cost_source: "unknown",
        model: "anthropic/m",
      },
    ]);
  });
});

describe("lineages and finding feedback", () => {
  const documented = JSON.parse(
    /```json\n([\s\S]*?)```/.exec(
      contracts.slice(contracts.indexOf("## Review lineages and rounds")),
    )![1],
  );
  async function uploaded() {
    return ((await (await upload()).json()) as any).id as string;
  }
  it("accepts the documented lineage submission and exposes lineage state", async () => {
    const s: any = { ...submission(), ...documented };
    s.snapshot_id = await uploaded();
    const query = new URLSearchParams({
      repository: documented.lineage.repository,
      kind: documented.lineage.kind,
      ref: documented.lineage.ref,
    });
    expect((await request(`/v1/lineages?${query}`)).status).toBe(404);
    const response = await request("/v1/reviews", "POST", s);
    expect(response.status).toBe(202);
    const { id } = (await response.json()) as any;
    const attached = await testEnv.DB.prepare(
      "SELECT generation FROM lineage_reviews WHERE review_id=?",
    )
      .bind(id)
      .first<any>();
    expect(attached.generation).toBe(1);
    const state = await request(`/v1/lineages?${query}`);
    expect(state.status).toBe(200);
    expect(await state.json()).toEqual({
      repository: documented.lineage.repository,
      kind: "branch",
      ref: "feature/x",
      generation: 1,
      round: 0,
      previous_head: null,
      posted: [],
      rounds_to_pass: null,
    });
    // Lineage state is tenant-scoped.
    const token = "a-different-tenant-token-32-characters";
    await testEnv.DB.prepare(
      "INSERT INTO api_tokens(hash,tenant,scope,expires_at) VALUES(?,?,?,?)",
    )
      .bind(hash(token), "other", "reviews:read", Date.now() + 60000)
      .run();
    expect(
      (
        await request(`/v1/lineages?${query}`, "GET", undefined, {
          authorization: `Bearer ${token}`,
        })
      ).status,
    ).toBe(404);
    // A plain submission joins no lineage.
    const plain = submission();
    plain.snapshot_id = s.snapshot_id;
    const other = (await (
      await request("/v1/reviews", "POST", plain)
    ).json()) as any;
    expect(
      await testEnv.DB.prepare(
        "SELECT * FROM lineage_reviews WHERE review_id=?",
      )
        .bind(other.id)
        .first(),
    ).toBeNull();
  });
  it.each([
    [{ repository: "r", kind: "tag", ref: "x" }],
    [{ repository: "r", kind: "pr", ref: "feature" }],
    [{ repository: "", kind: "branch", ref: "x" }],
    [{ repository: "r", kind: "branch", ref: "x", reset: "yes" }],
    [{ repository: "r", kind: "branch", ref: "x", parent: "abc" }],
  ])("rejects an invalid lineage reference %j", async (lineage) => {
    const s: any = submission();
    s.snapshot_id = await uploaded();
    s.lineage = lineage;
    const response = await request("/v1/reviews", "POST", s);
    expect(response.status).toBe(400);
    expect(((await response.json()) as any).error).toMatch(/lineage/);
  });
  async function postedFinding(
    tenant = "owner",
    id = hash(`finding-${crypto.randomUUID()}`),
    ref = `feature/${id.slice(0, 8)}`,
  ) {
    const lineage = lineageId(tenant, {
        repository: "github.com/acme/app",
        kind: "branch",
        ref,
      }),
      finding = {
        id,
        rule_id: "correctness/throw",
        category: "defect",
        state: "new",
        location: { path: "src/a.ts", line_start: 1, line_end: 1 },
      };
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        "INSERT INTO lineages(id,tenant,repository,kind,ref,generation,round,posted_json,updated_at) VALUES(?,?,?,?,?,1,1,?,?)",
      ).bind(
        lineage,
        tenant,
        "github.com/acme/app",
        "branch",
        ref,
        JSON.stringify({ [id]: { first_posted_in: "s1", round: 1 } }),
        Date.now(),
      ),
      testEnv.DB.prepare(
        "INSERT INTO findings(tenant,lineage_id,generation,identity,review_id,snapshot_id,repository,rule_id,category,source_kind,state,status,round,first_posted_in,location_json,finding_json,created_at,updated_at) VALUES(?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).bind(
        tenant,
        lineage,
        id,
        "review",
        "s1",
        "github.com/acme/app",
        finding.rule_id,
        "defect",
        "agent",
        "new",
        "open",
        1,
        "s1",
        JSON.stringify({ location: finding.location }),
        JSON.stringify({ finding, check: null }),
        Date.now(),
        Date.now(),
      ),
    ]);
    return id;
  }
  it.each(["fixed", "wrong", "intentional", "irrelevant", "style"])(
    "records %s as the author response without touching the profile",
    async (reason) => {
      const reviewId = await createReview();
      const stored = await testEnv.DB.prepare(
        "SELECT submission_key FROM reviews WHERE id=?",
      )
        .bind(reviewId)
        .first<any>();
      const before = await new Store(runtime).get<any>(stored.submission_key);
      const id = await postedFinding();
      const response = await request(`/v1/findings/${id}/feedback`, "POST", {
        reason,
        note: "documented behavior",
        actor: "dev@example.com",
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as any;
      expect(body).toMatchObject({
        id,
        status: "dismissed",
        author_response: {
          reason,
          actor: "dev@example.com",
          note: "documented behavior",
        },
      });
      expect(new Date(body.author_response.at).toISOString()).toBe(
        body.author_response.at,
      );
      const row = await testEnv.DB.prepare(
        "SELECT status,state,author_response_json FROM findings WHERE identity=?",
      )
        .bind(id)
        .first<any>();
      expect(row.status).toBe("dismissed");
      expect(row.state).toBe("new");
      expect(JSON.parse(row.author_response_json)).toEqual(
        body.author_response,
      );
      expect(
        (
          await testEnv.DB.prepare(
            "SELECT reason,actor,note FROM feedback WHERE finding_id=?",
          )
            .bind(id)
            .all()
        ).results,
      ).toEqual([
        { reason, actor: "dev@example.com", note: "documented behavior" },
      ]);
      // Posture, budgets, rules and suppressions are untouched.
      expect(await new Store(runtime).get<any>(stored.submission_key)).toEqual(
        before,
      );
      expect(before.profile.suppress).toEqual([]);
    },
  );
  it("resolves an eight-character prefix like /rio dismiss does", async () => {
    const id = await postedFinding();
    const response = await request(
      `/v1/findings/${id.slice(0, 8)}/feedback`,
      "POST",
      { reason: "style" },
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as any).id).toBe(id);
    expect(
      (
        await testEnv.DB.prepare("SELECT status FROM findings WHERE identity=?")
          .bind(id)
          .first<any>()
      ).status,
    ).toBe("dismissed");
    // The full identity still works.
    const full = await postedFinding();
    expect(
      (
        await request(`/v1/findings/${full}/feedback`, "POST", {
          reason: "wrong",
        })
      ).status,
    ).toBe(200);
  });
  it("rejects short prefixes and lists the candidates of an ambiguous one", async () => {
    const shared = hash(`shared-${crypto.randomUUID()}`).slice(0, 8);
    const first = await postedFinding(
      "owner",
      shared + "a".repeat(56),
      "feature/one",
    );
    const second = await postedFinding(
      "owner",
      shared + "b".repeat(56),
      "feature/two",
    );
    const short = await request(
      `/v1/findings/${shared.slice(0, 4)}/feedback`,
      "POST",
      {
        reason: "style",
      },
    );
    expect(short.status).toBe(400);
    expect(((await short.json()) as any).error).toMatch(
      /at least 8 characters/,
    );
    const ambiguous = await request(`/v1/findings/${shared}/feedback`, "POST", {
      reason: "style",
    });
    expect(ambiguous.status).toBe(409);
    expect(((await ambiguous.json()) as any).candidates).toEqual([
      first,
      second,
    ]);
    const rows = await testEnv.DB.prepare(
      "SELECT status FROM findings WHERE identity IN (?,?)",
    )
      .bind(first, second)
      .all<any>();
    expect(rows.results.map((row) => row.status)).toEqual(["open", "open"]);
    // A longer prefix, or a lineage, disambiguates.
    expect(
      (
        await request(`/v1/findings/${shared}b/feedback`, "POST", {
          reason: "style",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(`/v1/findings/${shared}/feedback`, "POST", {
          reason: "style",
          lineage: {
            repository: "github.com/acme/app",
            kind: "branch",
            ref: "feature/one",
          },
        })
      ).status,
    ).toBe(200);
  });
  it("rejects unknown reasons and hides other tenants' findings", async () => {
    const id = await postedFinding();
    const rejected = await request(`/v1/findings/${id}/feedback`, "POST", {
      reason: "false_positive",
    });
    expect(rejected.status).toBe(400);
    expect(((await rejected.json()) as any).error).toContain(
      "fixed, wrong, intentional, irrelevant, style",
    );
    const row = await testEnv.DB.prepare(
      "SELECT status,author_response_json FROM findings WHERE identity=?",
    )
      .bind(id)
      .first<any>();
    expect(row).toEqual({ status: "open", author_response_json: null });
    expect(
      (
        await request(`/v1/findings/${hash("unknown")}/feedback`, "POST", {
          reason: "wrong",
        })
      ).status,
    ).toBe(404);
    const foreign = await postedFinding("other");
    const token = "a-different-tenant-writer-32-characters";
    await testEnv.DB.prepare(
      "INSERT INTO api_tokens(hash,tenant,scope,expires_at) VALUES(?,?,?,?)",
    )
      .bind(hash(token), "intruder", "reviews:write", Date.now() + 60000)
      .run();
    expect(
      (
        await request(
          `/v1/findings/${foreign}/feedback`,
          "POST",
          { reason: "wrong" },
          { authorization: `Bearer ${token}` },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await testEnv.DB.prepare("SELECT status FROM findings WHERE identity=?")
          .bind(foreign)
          .first<any>()
      ).status,
    ).toBe("open");
    // Answering with an explicit lineage targets that lineage only.
    expect(
      (
        await request(`/v1/findings/${id}/feedback`, "POST", {
          reason: "wrong",
          lineage: {
            repository: "github.com/acme/app",
            kind: "branch",
            ref: "elsewhere",
          },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(`/v1/findings/${id}/feedback`, "POST", {
          reason: "wrong",
          lineage: {
            repository: "github.com/acme/app",
            kind: "branch",
            ref: `feature/${id.slice(0, 8)}`,
          },
        })
      ).status,
    ).toBe(200);
  });
});

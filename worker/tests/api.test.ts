import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, it, expect } from "vitest";
import { app } from "../src/index";
import { D1Ledger, Store } from "../src/storage";
import { hash, canonical } from "../src/validation";
import { jobToken, sign } from "../src/auth";
import { createJob, finishJob } from "../src/jobs";
import { profile, snapshot, submission } from "./fixtures";
import migration from "../migrations/0001_core.sql?raw";
import type { Env } from "../src/types";
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
          : typeof value === "string"
            ? value
            : JSON.stringify(value),
    },
    runtime,
  );
}
async function createReview() {
  const uploaded = await request("/v1/snapshots", "POST", snapshot);
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
  await applyD1Migrations(testEnv.DB, [
    {
      name: "core",
      queries: migration
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean),
    },
  ]);
});
beforeEach(async () => {
  await testEnv.DB.batch(
    [
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
  it("negotiates version and rejects unauthorized or cross-tenant access", async () => {
    expect((await request("/health")).status).toBe(200);
    expect(
      (
        await request("/v1/snapshots", "POST", snapshot, {
          "content-type": "application/json",
        })
      ).status,
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
      (
        await request("/v1/snapshots", "POST", snapshot, {
          ...owner,
          "rio-protocol": "2",
        })
      ).status,
    ).toBe(400);
  });
  it("rejects invalid paths, graphs, guidance and review contracts", async () => {
    const unsafe = structuredClone(snapshot);
    unsafe.head["../escape"] = { mode: 0o100644, content: "x" };
    expect((await request("/v1/snapshots", "POST", unsafe)).status).toBe(400);
    const uploaded = await request("/v1/snapshots", "POST", snapshot);
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
  it("signs completion capabilities for one review, job and attempt, with idempotent replay", async () => {
    const id = await createReview(),
      job = "job1";
    await createJob(runtime, id, job, "run", ["false"], "head", snapshot);
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
    await createJob(runtime, id, "job1", "run", ["true"], "head", snapshot);
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
  it("publishes one immutable winner for racing completions and retains cancelled job evidence", async () => {
    const id = await createReview(),
      store = new Store(runtime);
    await createJob(runtime, id, "race", "run", ["false"], "head", snapshot);
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
      snapshot,
    );
    await request(`/v1/reviews/${id}/cancel`, "POST", {});
    const events = fakeWorkflow.events.length;
    await finishJob(runtime, id, "cancelled-job", 1, {
      ...result,
      job_id: "cancelled-job",
      exit_code: 0,
    });
    expect(fakeWorkflow.events).toHaveLength(events);
    expect(
      (
        await runtime.DB.prepare(
          "SELECT status FROM jobs WHERE id='cancelled-job'",
        ).first<any>()
      ).status,
    ).toBe("completed");
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
});

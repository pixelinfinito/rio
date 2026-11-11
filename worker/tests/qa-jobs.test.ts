import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { app } from "../src/index";
import { createQaJob, qaBudget } from "../src/qa-jobs";
import { authenticate, sign } from "../src/auth";
import { hash, canonical } from "../src/validation";
import { Store } from "../src/storage";
import type { Env } from "../src/types";
import { SandboxQa } from "../src/qa-sandbox";
import { sandboxGateway } from "../src/qa-sandbox-gateway";
import { storeSnapshot } from "./snapshots";
import { allMigrations, submission, snapshot } from "./fixtures";

const events: any[] = [],
  queued: any[] = [];
const runtime = {
  ...env,
  JOBS: {
    send: async (value: any) => {
      queued.push(value);
    },
  },
  REVIEWS: {
    get: async () => ({
      sendEvent: async (event: any) => {
        events.push(event);
      },
    }),
  },
} as unknown as Env;
const owner = "test-owner-token-at-least-32-characters",
  secret = "test-runner-secret-at-least-32-characters";
const fingerprint = "a".repeat(64);
const cell = (viewport = "mobile") => {
  const descriptor = {
    chain: ["add-to-cart", "checkout"],
    viewport,
    color_scheme: "light",
    version: "head",
  };
  return {
    id: hash(canonical(descriptor)),
    chain: descriptor.chain,
    viewport,
    color_scheme: descriptor.color_scheme,
  };
};
const configuration = () => ({
  cells: [cell()],
  seed_fingerprints: [fingerprint],
  seed_max_size: 1024,
});
function request(
  path: string,
  token: string,
  value?: any,
  method = "POST",
  headers = {},
) {
  return app.request(
    "https://rio.test" + path,
    {
      method,
      headers: { authorization: "Bearer " + token, ...headers },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    },
    runtime,
  );
}
async function setup(id = "review") {
  const input = submission();
  input.snapshot_id = "b".repeat(64);
  input.mode = "fast";
  input.profile.budget.fast.qa = {
    wall: "30m",
    cell_wall: "8m",
    tokens: 1000,
    evidence_bytes: 100000,
  };
  await runtime.DB.prepare(
    "INSERT INTO reviews(id,tenant,submission_key,status,created_at,token_limit,deadline) VALUES(?,'owner','unused','running',?,10000,?)",
  )
    .bind(id, Date.now(), Date.now() + 60 * 60_000)
    .run();
  return {
    review: id,
    job: id + "-qa",
    step: "qa",
    submission: input,
    options: { enabled: true },
  };
}
async function claimed(id = "review") {
  const input = await setup(id);
  await createQaJob(runtime, input);
  const response = await request("/v1/runner/claim", secret);
  expect(response.status).toBe(200);
  const claim = await response.json<any>();
  return { input, claim, path: `/v1/runner/${input.review}/${input.job}/1` };
}
beforeAll(async () => {
  await applyD1Migrations(runtime.DB, allMigrations);
});
beforeEach(async () => {
  events.length = 0;
  queued.length = 0;
  await runtime.DB.batch(
    [
      "qa_seed_leases",
      "qa_model_usage",
      "qa_cells",
      "qa_runs",
      "jobs",
      "events",
      "reviews",
    ].map((table) => runtime.DB.prepare(`DELETE FROM ${table}`)),
  );
});

it("defers Sandbox without opt-in, labels opt-in, rejects hosted subscriptions and never dispatches forks", async () => {
  const input = await setup();
  expect(
    await createQaJob({ ...runtime, RUNNER_BACKEND: "sandbox" }, input),
  ).toEqual({ deferred: "no_runtime" });
  expect(queued).toHaveLength(0);
  await expect(
    createQaJob(runtime, { ...input, harnessAuth: "subscription" }),
  ).rejects.toThrow("gateway");
  expect(
    await createQaJob(runtime, {
      ...input,
      submission: { ...input.submission, fork: true },
    }),
  ).toEqual({ deferred: "fork" });
  const result = await createQaJob(
    { ...runtime, RUNNER_BACKEND: "sandbox" },
    { ...input, options: { enabled: true, sandbox: "allow" } },
  );
  expect("job" in result && result.job.qa?.policy).toEqual({
    egress: "provider_pinned (sandbox)",
    app_isolation: "none",
  });
  expect("job" in result && result.job.qa?.harness_auth).toBe("gateway");
});

it("dispatches the QA protocol, keeps capabilities out of stored payloads and preserves idempotent dispatch", async () => {
  const { input, claim } = await claimed();
  expect(claim.job).toMatchObject({
    kind: "qa",
    network: "qa",
    needs: ["base", "head"],
    qa: {
      harness: "codex",
      harness_auth: "gateway",
      budget: { tokens: 1000, cell_wall_ms: 480000 },
    },
  });
  expect(claim.job.limits.wall_ms).toBeGreaterThan(120000);
  expect(claim.token).toMatch(/^qa-job\.[a-f0-9]{64}$/);
  expect(claim.qa.capability).toMatch(/^qa-run\.[a-f0-9]{64}$/);
  const row = await runtime.DB.prepare(
    "SELECT payload_key FROM jobs WHERE id=?",
  )
    .bind(input.job)
    .first<{ payload_key: string }>();
  const saved = await new Store(runtime).get<any>(row!.payload_key);
  expect(JSON.stringify(saved)).not.toMatch(/qa-run\.|qa-job\.|recorded-key/);
  const repeated = await createQaJob(runtime, input);
  expect("job" in repeated && repeated.job).toEqual(saved);
  await expect(
    createQaJob(runtime, { ...input, version: "base" }),
  ).rejects.toThrow("conflicting QA dispatch");
  await expect(
    authenticate(
      new Request("https://rio.test", {
        headers: { authorization: "Bearer " + claim.qa.capability },
      }),
      runtime,
      "reviews:write",
    ),
  ).rejects.toThrow("unauthorized");
});

it("configures immutable cell identities and restricts seeds to the run fingerprint, quota and leases", async () => {
  const { claim, path } = await claimed();
  expect(
    (await request("/v1/qa/seeds/leases", claim.qa.capability, { fingerprint }))
      .status,
  ).toBe(401);
  expect(
    (await request(path + "/qa-configure", claim.token, configuration()))
      .status,
  ).toBe(200);
  expect(
    (await request(path + "/qa-configure", claim.token, configuration()))
      .status,
  ).toBe(200);
  expect(
    (
      await request(path + "/qa-configure", claim.token, {
        ...configuration(),
        cells: [cell("desktop")],
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await request("/v1/qa/seeds/leases", claim.qa.capability, {
        fingerprint,
        max_size: 2048,
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await request("/v1/qa/seeds/leases", claim.qa.capability, {
        fingerprint: "c".repeat(64),
        max_size: 1024,
      })
    ).status,
  ).toBe(401);
  const lease = await (
    await request("/v1/qa/seeds/leases", claim.qa.capability, {
      fingerprint,
      max_size: 1024,
    })
  ).json<any>();
  expect(lease.id).toBeTypeOf("string");
  expect(
    (await request("/v1/qa/seeds/prune", claim.qa.capability, { keep: 0 }))
      .status,
  ).toBe(401);
  const other = await claimed("another");
  expect(
    (
      await request(
        other.path + "/qa-configure",
        other.claim.token,
        configuration(),
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await request(
        `/v1/qa/seeds/leases/${lease.id}`,
        other.claim.qa.capability,
        {},
        "PATCH",
      )
    ).status,
  ).toBe(401);
  expect(
    (
      await request(
        `/v1/qa/seeds/leases/${lease.id}`,
        other.claim.qa.capability,
        undefined,
        "DELETE",
      )
    ).status,
  ).toBe(401);
  expect(
    (
      await request(
        `/v1/qa/seeds/leases/${lease.id}`,
        claim.qa.capability,
        {},
        "PATCH",
      )
    ).status,
  ).toBe(200);
});

it("renews every sixty seconds, fences a reclaimed runner and keeps the cell token ledger", async () => {
  const { claim, path, input } = await claimed();
  await request(path + "/qa-configure", claim.token, configuration());
  await runtime.DB.prepare("UPDATE qa_cells SET tokens_used=35 WHERE run_id=?")
    .bind(claim.qa.run_id)
    .run();
  await runtime.DB.prepare("UPDATE jobs SET lease_until=? WHERE id=?")
    .bind(Date.now() + 1000, input.job)
    .run();
  const renewed = await (
    await request(path + "/heartbeat", claim.token)
  ).json<any>();
  expect(renewed).toMatchObject({ cancelled: false, heartbeat_ms: 60000 });
  expect(renewed.lease_until).toBeGreaterThan(Date.now() + 170000);
  await runtime.DB.prepare("UPDATE jobs SET lease_until=0 WHERE id=?")
    .bind(input.job)
    .run();
  const reclaimed = await (
    await request("/v1/runner/claim", secret)
  ).json<any>();
  expect(reclaimed.qa.run_id).toBe(claim.qa.run_id);
  expect(reclaimed.token).not.toBe(claim.token);
  expect((await request(path + "/heartbeat", claim.token)).status).toBe(401);
  expect(
    (
      await request("/v1/qa/seeds/leases", claim.qa.capability, {
        fingerprint,
        max_size: 1024,
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await request("/v1/qa/seeds/leases", reclaimed.qa.capability, {
        fingerprint,
        max_size: 1024,
      })
    ).status,
  ).toBe(201);
  expect(
    await runtime.DB.prepare("SELECT tokens_used FROM qa_cells WHERE run_id=?")
      .bind(claim.qa.run_id)
      .first(),
  ).toEqual({ tokens_used: 35 });
});

it("revokes controller access on cancellation while accepting the runner's partial result for audit", async () => {
  const { claim, path, input } = await claimed();
  await request(path + "/qa-configure", claim.token, configuration());
  const lease = await (
    await request("/v1/qa/seeds/leases", claim.qa.capability, {
      fingerprint,
      max_size: 1024,
    })
  ).json<any>();
  expect(
    (await request(`/v1/reviews/${input.review}/cancel`, owner)).status,
  ).toBe(200);
  expect(
    (
      await request(
        `/v1/qa/seeds/leases/${lease.id}`,
        claim.qa.capability,
        {},
        "PATCH",
      )
    ).status,
  ).toBe(401);
  expect(
    await (await request(path + "/heartbeat", claim.token)).json(),
  ).toMatchObject({ cancelled: true });
  const result = {
    job_id: input.job,
    attempt: 1,
    version: "head",
    exit_code: 0,
    stdout: "",
    stderr: "",
    timed_out: false,
    truncated: false,
    artifact: {
      outcome: "partial",
      journey_outcomes: [
        { journey: "checkout", outcome: "cancelled", reason: "interrupted" },
      ],
    },
  };
  const raw = JSON.stringify(result);
  const response = await app.request(
    "https://rio.test" + path + "/complete",
    {
      method: "POST",
      headers: {
        authorization: "Bearer " + claim.token,
        "rio-signature": await sign(claim.token, raw),
      },
      body: raw,
    },
    runtime,
  );
  expect(response.status).toBe(200);
  const run = await runtime.DB.prepare(
    "SELECT state,token_hash,result_key FROM qa_runs WHERE id=?",
  )
    .bind(claim.qa.run_id)
    .first<any>();
  expect(run).toMatchObject({ state: "partial", token_hash: null });
  expect(
    (await new Store(runtime).get<any>(run.result_key)).artifact
      .journey_outcomes,
  ).toHaveLength(1);
  expect(events).toEqual([]);
  expect(
    (await request(path + "/archive", claim.token, undefined, "GET")).status,
  ).toBe(401);
  await runtime.DB.prepare("DELETE FROM qa_cells WHERE run_id=?")
    .bind(claim.qa.run_id)
    .run();
  expect(
    (await request(path + "/qa-configure", claim.token, configuration()))
      .status,
  ).toBe(400);
  expect(
    (
      await runtime.DB.prepare("SELECT * FROM qa_cells WHERE run_id=?")
        .bind(claim.qa.run_id)
        .all()
    ).results,
  ).toEqual([]);
});

it("shares the run wall between head and baseline and applies mode-specific defaults", async () => {
  const input = await setup();
  await createQaJob(runtime, input);
  const first = await runtime.DB.prepare(
    "SELECT deadline FROM qa_runs WHERE job_id=?",
  )
    .bind(input.job)
    .first<any>();
  await createQaJob(runtime, {
    ...input,
    job: "review-qa-base",
    version: "base",
  });
  expect(
    await runtime.DB.prepare(
      "SELECT deadline FROM qa_runs WHERE job_id='review-qa-base'",
    ).first(),
  ).toEqual(first);
  const profile = submission().profile;
  expect(qaBudget(profile, "deep")).toMatchObject({
    wall_ms: 5400000,
    cell_wall_ms: 900000,
    tokens: 300000,
  });
});

it("fences in-flight seed publication against cancellation, deadlines and reclaimed runners", async () => {
  const { HostedSeeds } = await import("../src/qa-seeds");
  const bytes = new TextEncoder().encode("pristine database"),
    digest = hash("pristine database");
  for (const stop of ["cancelled", "deadline", "generation", "lease"]) {
    const { claim, path } = await claimed("seed-" + stop);
    await request(path + "/qa-configure", claim.token, configuration());
    const scope = {
      run_id: claim.qa.run_id,
      generation: claim.qa.generation,
      fingerprints: [fingerprint],
      max_size: 1024,
    };
    const store = new HostedSeeds(runtime, "owner", scope);
    const lease = await store.acquire({ fingerprint, max_size: 1024 });
    await store.renew(lease.id, { part: digest });
    await store.putPart(digest, bytes, lease.id);
    const bucket = new Proxy(runtime.ARTIFACTS, {
      get(target, property) {
        if (property === "put")
          return async (key: string, ...rest: any[]) => {
            const result = await (target.put as any)(key, ...rest);
            if (key.endsWith("manifest.json")) {
              if (stop === "cancelled")
                await runtime.DB.prepare(
                  "UPDATE reviews SET cancelled=1 WHERE id=?",
                )
                  .bind("seed-" + stop)
                  .run();
              if (stop === "deadline")
                await runtime.DB.prepare(
                  "UPDATE qa_runs SET deadline=0 WHERE id=?",
                )
                  .bind(claim.qa.run_id)
                  .run();
              if (stop === "generation")
                await runtime.DB.prepare(
                  "UPDATE qa_runs SET generation='replacement' WHERE id=?",
                )
                  .bind(claim.qa.run_id)
                  .run();
              if (stop === "lease")
                await runtime.DB.prepare(
                  "UPDATE jobs SET lease_until=0 WHERE id=?",
                )
                  .bind("seed-" + stop + "-qa")
                  .run();
            }
            return result;
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(
      new HostedSeeds(
        { ...runtime, ARTIFACTS: bucket },
        "owner",
        scope,
      ).publish(
        {
          version: 1,
          fingerprint: { fingerprint, datastores: { shop: "sqlite" } },
          created_at_ms: Date.now(),
          archives: [
            {
              name: "shop",
              kind: "sqlite",
              hash: digest,
              bytes: bytes.length,
              parts: [{ hash: digest, bytes: bytes.length }],
            },
          ],
        },
        lease.id,
      ),
    ).rejects.toMatchObject({ reason: "seed_lease_expired" });
    await expect(store.renew(lease.id)).rejects.toMatchObject({
      reason: "seed_lease_expired",
    });
    await expect(
      store.acquire({ fingerprint, max_size: 1024 }),
    ).rejects.toMatchObject({ reason: "seed_lease_expired" });
    expect(
      (await runtime.DB.prepare("SELECT * FROM qa_seed_heads").all()).results,
    ).toEqual([]);
  }
});

it("rejects a stale completion even when reclaim occurs after HTTP authentication", async () => {
  const { claim, path, input } = await claimed();
  let replacement: any;
  const bucket = new Proxy(runtime.ARTIFACTS, {
    get(target, property) {
      if (property === "put")
        return async (key: string, ...rest: any[]) => {
          const value = await (target.put as any)(key, ...rest);
          await runtime.DB.prepare("UPDATE jobs SET lease_until=0 WHERE id=?")
            .bind(input.job)
            .run();
          replacement = await (
            await request("/v1/runner/claim", secret)
          ).json<any>();
          return value;
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const result = {
    job_id: input.job,
    attempt: 1,
    version: "head",
    exit_code: 0,
    stdout: "",
    stderr: "",
    timed_out: false,
    truncated: false,
    artifact: { outcome: "complete" },
  };
  const raw = JSON.stringify(result);
  const signed = async (token: string, runtimeEnv: Env) =>
    app.request(
      "https://rio.test" + path + "/complete",
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "rio-signature": await sign(token, raw),
        },
        body: raw,
      },
      runtimeEnv,
    );
  expect(
    (await signed(claim.token, { ...runtime, ARTIFACTS: bucket })).status,
  ).toBe(400);
  expect(replacement.token).not.toBe(claim.token);
  expect(
    await runtime.DB.prepare("SELECT status,result_key FROM jobs WHERE id=?")
      .bind(input.job)
      .first(),
  ).toEqual({ status: "leased", result_key: null });
  expect((await signed(replacement.token, runtime)).status).toBe(200);
});

it("gives deterministic replay its own bounded wall allowance after the main QA step expires", async () => {
  const input = await setup("replay-budget");
  input.submission.profile.budget.fast.qa!.replay_wall = "1m";
  const original = await createQaJob(runtime, input);
  expect("job" in original).toBe(true);
  await runtime.DB.prepare("UPDATE qa_runs SET deadline=? WHERE review_id=?")
    .bind(Date.now() - 1, input.review)
    .run();
  const replay = {
    hypothesis: "c".repeat(64),
    source_run: (original as any).job.qa.run_id,
    until: { journey: "checkout", step: 2 },
    events: [],
    artifacts: [],
  };
  const request = {
    ...input,
    job: "replay-budget-attempt",
    step: "qa-replay-hypothesis",
    replay,
  };
  const dispatched = await createQaJob(runtime, request);
  expect("job" in dispatched).toBe(true);
  if (!("job" in dispatched)) return;
  expect(dispatched.job.limits.wall_ms).toBeLessThanOrEqual(60000);
  expect(dispatched.job.qa?.budget.tokens).toBe(1);
  expect(dispatched.job.qa?.replay).toEqual(replay);
  await expect(
    createQaJob(runtime, {
      ...request,
      replay: { ...replay, until: { journey: "checkout", step: 3 } },
    }),
  ).rejects.toThrow("conflicting QA replay dispatch");
});

it("resolves the deep replay and evidence defaults when the QA block is omitted", () => {
  const input = submission();
  delete input.profile.budget.fast.qa;
  if (input.profile.budget.deep) delete input.profile.budget.deep.qa;
  expect(qaBudget(input.profile, "deep")).toEqual({
    wall_ms: 90 * 60000,
    cell_wall_ms: 15 * 60000,
    tokens: 300000,
    evidence_bytes: 1024 ** 3,
    replay_wall_ms: 10 * 60000,
  });
});

async function sandboxFixture(direct = false) {
  const input = await setup("sandbox-review");
  input.submission.snapshot_id = (await storeSnapshot(runtime, snapshot)).id;
  const dispatched = await createQaJob(
    { ...runtime, RUNNER_BACKEND: "sandbox" },
    {
      ...input,
      options: { enabled: true, sandbox: "allow" },
    },
  );
  if (!("job" in dispatched)) throw new Error("unexpected deferral");
  await runtime.DB.prepare(
    "UPDATE jobs SET status='leased',lease_until=? WHERE id=?",
  )
    .bind(Date.now() + 180000, input.job)
    .run();
  const values = new Map<string, any>(),
    commands: string[][] = [],
    starts: any[] = [],
    intercepts: any[] = [];
  let alarm = 0,
    done = false,
    destroyed = false;
  const artifact: any = {
    outcome: "complete",
    journey_outcomes: [
      {
        journey: "checkout",
        outcome: "passed",
        cell: { viewport: "mobile", color_scheme: "light" },
        evidence: [],
      },
    ],
    evidence: { artifacts: [] },
  };
  const container = {
    running: false,
    start: (options: any) => {
      starts.push(options);
      container.running = true;
    },
    destroy: async () => {
      destroyed = true;
      container.running = false;
    },
    setInactivityTimeout: async () => {},
    inspect: async () => ({
      image: "registry.test/rio@sha256:" + "a".repeat(64),
    }),
    interceptOutboundHttp: async (...args: any[]) => {
      intercepts.push(args);
    },
    exec: async (command: string[]) => {
      commands.push(command);
      let finishInput: () => void;
      const uploaded = new Promise<void>((resolve) => {
        finishInput = resolve;
      });
      const planning = command.includes("plan");
      const stdin = new WritableStream({
        write() {},
        close() {
          finishInput();
        },
      });
      return {
        stdin,
        async output() {
          if (planning) await uploaded;
          const value = planning
            ? direct
              ? {
                  ready: false,
                  result: {
                    outcome: "partial",
                    deferred: "no_runtime",
                    reason: "unsupported_packaging",
                    journey_outcomes: [],
                  },
                }
              : { ready: true, configuration: configuration() }
            : command.includes("status")
              ? { done }
              : command.includes("finish")
                ? artifact
                : {};
          return {
            exitCode: 0,
            stdout: new TextEncoder().encode(JSON.stringify(value)).buffer,
            stderr: new ArrayBuffer(0),
          };
        },
      };
    },
  };
  const ctx = {
    container,
    exports: { QaSandboxGateway: (value: any) => value },
    storage: {
      get: async (key: string) =>
        values.has(key) ? structuredClone(values.get(key)) : undefined,
      put: async (key: string, value: any) => {
        values.set(key, structuredClone(value));
      },
      setAlarm: async (value: number) => {
        alarm = value;
      },
      deleteAlarm: async () => {
        alarm = 0;
      },
    },
  } as unknown as DurableObjectState;
  const instance = new SandboxQa(ctx, runtime);
  return {
    input,
    job: dispatched.job,
    instance,
    commands,
    starts,
    intercepts,
    values,
    artifact,
    done: () => {
      done = true;
    },
    destroyed: () => destroyed,
    alarm: () => alarm,
  };
}

it("runs opted-in Sandbox QA offline through one scoped interceptor, renews its lease and finishes from an alarm", async () => {
  const f = await sandboxFixture();
  await f.instance.start(f.job);
  expect(f.starts).toHaveLength(1);
  expect(f.starts[0].enableInternet).toBe(false);
  expect(f.intercepts[0][0]).toBe("198.18.0.1");
  expect(f.intercepts[0][1].props.run).toBe(f.job.qa!.run_id);
  expect(f.alarm()).toBeGreaterThan(Date.now());
  expect(f.commands.some((command) => command.includes("launch"))).toBe(true);
  await f.instance.start(f.job);
  expect(f.starts).toHaveLength(1);
  await f.instance.alarm();
  expect(f.destroyed()).toBe(false);
  f.done();
  await f.instance.alarm();
  expect(f.destroyed()).toBe(true);
  expect(f.alarm()).toBe(0);
  const row = await runtime.DB.prepare(
    "SELECT result_key,status FROM jobs WHERE id=?",
  )
    .bind(f.input.job)
    .first<any>();
  const result = await new Store(runtime).get<any>(row.result_key);
  expect(row.status).toBe("completed");
  expect(result.artifact.policy).toEqual({
    app_isolation: "none",
    egress: "provider_pinned (sandbox)",
  });
  expect(result.artifact.journey_outcomes).toHaveLength(1);
});

it("defers Sandbox image packaging without launching an app or harness", async () => {
  const f = await sandboxFixture(true);
  await f.instance.start(f.job);
  expect(f.commands.some((command) => command.includes("launch"))).toBe(false);
  expect(f.destroyed()).toBe(true);
  const row = await runtime.DB.prepare("SELECT result_key FROM jobs WHERE id=?")
    .bind(f.input.job)
    .first<any>();
  const result = await new Store(runtime).get<any>(row.result_key);
  expect(result.artifact).toMatchObject({
    deferred: "no_runtime",
    reason: "unsupported_packaging",
  });
});

it("Sandbox cancellation revokes capabilities and retains the final partial checkpoint", async () => {
  const f = await sandboxFixture();
  await f.instance.start(f.job);
  const state = f.values.get("qa");
  await runtime.DB.prepare("UPDATE reviews SET cancelled=1 WHERE id=?")
    .bind(f.input.review)
    .run();
  await f.instance.alarm();
  expect(f.commands.some((command) => command.includes("cancel"))).toBe(true);
  expect(f.destroyed()).toBe(false);
  f.done();
  await f.instance.alarm();
  const row = await runtime.DB.prepare("SELECT result_key FROM jobs WHERE id=?")
    .bind(f.input.job)
    .first<any>();
  const result = await new Store(runtime).get<any>(row.result_key);
  expect(result.artifact.outcome).toBe("partial");
  expect(result.artifact.journey_outcomes).toHaveLength(1);
  expect(
    (
      await request("/v1/qa/seeds/leases", state.claim.qa.capability, {
        fingerprint,
      })
    ).status,
  ).toBe(401);
});

it("Sandbox gateway denies general Worker routes, other runs and stale generations", async () => {
  const { claim, path } = await claimed();
  const configured = await request(
    path + "/qa-configure",
    claim.token,
    configuration(),
  );
  expect(configured.status, await configured.text()).toBe(200);
  const scope = { run: claim.qa.run_id, generation: claim.qa.generation };
  const call = (path: string, pin = scope) =>
    sandboxGateway(
      new Request("http://198.18.0.1" + path, {
        method: "POST",
        headers: {
          authorization: "Bearer " + claim.qa.capability,
          "content-type": "application/json",
        },
        body: JSON.stringify({ fingerprint, max_size: 1024 }),
      }),
      runtime,
      pin,
    );
  expect((await call("/v1/runner/claim")).status).toBe(403);
  expect((await call("/v1/reviews")).status).toBe(403);
  expect((await call("/v1/qa/runs/another/evidence")).status).toBe(403);
  expect(
    (await call("/v1/qa/seeds/leases", { ...scope, generation: "stale" }))
      .status,
  ).toBe(403);
  const allowed = await call("/v1/qa/seeds/leases");
  expect(allowed.status, await allowed.text()).toBe(201);
});

it("carries the journey layout and partition in the job and the hint classes on the run", async () => {
  const input = await setup();
  const partition = "e".repeat(32);
  const result = await createQaJob(runtime, {
    ...input,
    prompt: { cache: ["anthropic"], layout: ["qa-order"], partition },
  });
  expect("job" in result && result.job.qa?.prompt).toEqual({
    layout: ["qa-order"],
    partition,
  });
  const run = await runtime.DB.prepare("SELECT prompt_cache FROM qa_runs").first<any>();
  expect(run.prompt_cache).toBe('["anthropic"]');
  // Without settings the job and run are as before.
  const plain = await setup("plain");
  const other = await createQaJob(runtime, plain);
  expect("job" in other && other.job.qa?.prompt).toBeUndefined();
  const row = await runtime.DB.prepare(
    "SELECT prompt_cache FROM qa_runs WHERE review_id='plain'",
  ).first<any>();
  expect(row.prompt_cache).toBeNull();
});

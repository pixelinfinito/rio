import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { createQaJob } from "../src/qa-jobs";
import { qaModel } from "../src/qa-model";
import { qaUsage } from "../src/qa-results";
import { promptCacheKey } from "../src/prompt-config";
import { canonical, hash } from "../src/validation";
import type { Env } from "../src/types";
import { allMigrations, submission } from "./fixtures";

const runtime = {
  ...env,
  JOBS: { send: async () => {} },
  MODEL_PRICES: '{"openai/test":{"input":0.5,"output":2}}',
} as unknown as Env;
const secret = "test-runner-secret-at-least-32-characters";
const descriptor = {
  chain: ["checkout"],
  viewport: "mobile",
  color_scheme: "light",
  version: "head",
};
const cell = {
  id: hash(canonical(descriptor)),
  chain: descriptor.chain,
  viewport: descriptor.viewport,
  color_scheme: descriptor.color_scheme,
};
function api(path: string, token: string, value?: any) {
  return app.request(
    "https://rio.test" + path,
    {
      method: "POST",
      headers: { authorization: "Bearer " + token },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    },
    runtime,
  );
}
async function setup(tokens = 1000, model = "openai/test") {
  const input = submission();
  input.snapshot_id = "b".repeat(64);
  input.mode = "fast";
  input.profile.models.default = model;
  input.profile.budget.fast.qa = { tokens };
  await runtime.DB.prepare(
    "INSERT INTO reviews(id,tenant,submission_key,status,created_at,token_limit,deadline) VALUES('review','owner','unused','running',?,10000,?)",
  )
    .bind(Date.now(), Date.now() + 3600000)
    .run();
  await createQaJob(runtime, {
    review: "review",
    job: "job",
    step: "qa",
    submission: input,
    options: {},
  });
  const claim = await (await api("/v1/runner/claim", secret)).json<any>();
  expect(
    (
      await api("/v1/runner/review/job/1/qa-configure", claim.token, {
        cells: [cell],
        seed_fingerprints: [],
        seed_max_size: 1000,
      })
    ).status,
  ).toBe(200);
  return claim;
}
const body = (extra = {}) => ({
  model: "openai/test",
  input: "Inspect checkout",
  max_output_tokens: 100,
  ...extra,
});
const request = (claim: any, extra = {}, headers = {}) =>
  new Request("https://rio.test/v1/qa/model/v1/responses", {
    method: "POST",
    headers: {
      authorization: "Bearer " + claim.qa.capability,
      "x-rio-run-id": claim.qa.run_id,
      "x-rio-cell-id": cell.id,
      ...headers,
    },
    body: JSON.stringify(body(extra)),
  });
const providerReply = (
  usage: any = { prompt_tokens: 20, completion_tokens: 30 },
) =>
  Response.json({
    choices: [
      { message: { content: "Continue checkout" }, finish_reason: "stop" },
    ],
    ...(usage === null ? {} : { usage }),
  });
const usage = () =>
  runtime.DB.prepare(
    "SELECT state,reserved,charged_tokens,estimated,input_tokens,output_tokens,cost_usd FROM qa_model_usage",
  ).all<any>();
const ledger = () =>
  runtime.DB.prepare(
    "SELECT tokens_used,tokens_reserved,exhausted FROM qa_cells",
  ).first<any>();
beforeAll(async () => {
  await applyD1Migrations(runtime.DB, allMigrations);
});
beforeEach(async () => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("unexpected provider request"),
  );
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
afterEach(() => {
  vi.restoreAllMocks();
});

it("serves the mounted route with pinned credentials and settles actual usage before returning SSE", async () => {
  const claim = await setup();
  vi.mocked(globalThis.fetch).mockImplementationOnce(async (url, init) => {
    // Exercise workerd's RequestInit validation too: a plain fetch stub hid
    // the fact that the edge runtime rejects redirect:"error".
    const native = new Request(url, init);
    expect(native.redirect).toBe("manual");
    expect(String(url)).toBe("https://api.openai.com/v1/chat/completions");
    expect(new Headers(init!.headers).get("authorization")).toBe(
      "Bearer recorded-key",
    );
    expect(JSON.parse(init!.body as string)).toMatchObject({
      model: "test",
      stream: false,
      max_completion_tokens: 100,
    });
    return providerReply();
  });
  const response = await app.fetch(request(claim, { stream: true }), runtime);
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).toContain("response.completed");
  expect(text).not.toContain("recorded-key");
  expect(await ledger()).toEqual({
    tokens_used: 50,
    tokens_reserved: 0,
    exhausted: 0,
  });
  expect((await usage()).results[0]).toMatchObject({
    state: "completed",
    charged_tokens: 50,
    estimated: 0,
    input_tokens: 20,
    output_tokens: 30,
    cost_usd: 0.00007,
  });
});

it("rejects foreign cells, models, run identities, provider tools and remote images before provider access", async () => {
  const claim = await setup();
  for (const [extra, headers] of [
    [{ model: "openai/other" }, {}],
    [{ tools: [{ type: "web_search" }] }, {}],
    [
      {
        input: [
          {
            role: "user",
            content: [
              { type: "input_image", image_url: "https://secrets.test/image" },
            ],
          },
        ],
      },
      {},
    ],
    [{ previous_response_id: "stored" }, {}],
    [{}, { "x-rio-cell-id": "a".repeat(64) }],
    [{}, { "x-rio-run-id": "another" }],
  ]) {
    expect(
      (await app.fetch(request(claim, extra, headers), runtime)).status,
    ).toBeGreaterThanOrEqual(400);
  }
  expect((await usage()).results).toEqual([]);
  expect(
    (
      await app.fetch(
        request(
          claim,
          {},
          { authorization: "Bearer test-owner-token-at-least-32-characters" },
        ),
        runtime,
      )
    ).status,
  ).toBe(401);
});

it("atomically reserves concurrent calls and preserves charges through reclaim", async () => {
  const claim = await setup(1000);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const first = qaModel(
    request(claim, { max_output_tokens: 1000 }),
    runtime,
    async () => {
      started();
      await gate;
      return providerReply(null);
    },
  );
  await ready;
  await expect(
    qaModel(request(claim), runtime, async () => {
      throw new Error("must not call");
    }),
  ).rejects.toThrow("qa_token_budget_exhausted");
  release();
  expect((await first).status).toBe(200);
  expect(await ledger()).toEqual({
    tokens_used: 1000,
    tokens_reserved: 0,
    exhausted: 1,
  });
  await runtime.DB.prepare("UPDATE jobs SET lease_until=0").run();
  const next = await (await api("/v1/runner/claim", secret)).json<any>();
  expect((await app.fetch(request(claim), runtime)).status).toBe(401);
  expect((await app.fetch(request(next), runtime)).status).toBe(429);
});

it("charges missing usage, failed requests and provider overages conservatively", async () => {
  const claim = await setup(5000);
  await qaModel(request(claim), runtime, async () => providerReply(null));
  await expect(
    qaModel(request(claim), runtime, async () => {
      throw new Error("private provider details");
    }),
  ).rejects.toThrow();
  const entries = (await usage()).results;
  expect(entries).toHaveLength(2);
  for (const entry of entries)
    expect(entry).toMatchObject({
      state: "failed",
      estimated: 1,
      charged_tokens: entry.reserved,
      input_tokens: null,
      output_tokens: null,
    });
  await expect(
    qaModel(request(claim), runtime, async () =>
      providerReply({ prompt_tokens: 8000, completion_tokens: 1 }),
    ),
  ).rejects.toThrow("qa_token_budget_exhausted");
  expect((await ledger()).exhausted).toBe(1);
  expect((await ledger()).tokens_used).toBeGreaterThanOrEqual(8001);
});

it("stops an in-flight request when the review is cancelled and keeps the reservation charged", async () => {
  const claim = await setup();
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const pending = qaModel(request(claim), runtime, async (_url, init) => {
    ready();
    return await new Promise<Response>((_resolve, reject) =>
      init!.signal!.addEventListener(
        "abort",
        () => reject(new Error("aborted")),
        { once: true },
      ),
    );
  });
  const rejected = expect(pending).rejects.toThrow("aborted");
  await started;
  await runtime.DB.prepare("UPDATE reviews SET cancelled=1").run();
  await rejected;
  const entry = (await usage()).results[0];
  expect(entry).toMatchObject({
    state: "failed",
    charged_tokens: entry.reserved,
    estimated: 1,
  });
});

it("adapts the pinned Anthropic route without passing provider credentials to the controller", async () => {
  const claim = await setup(1000, "anthropic/test");
  const response = await qaModel(
    request(claim, { model: "anthropic/test" }),
    runtime,
    async (url, init) => {
      expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
      expect(new Headers(init!.headers).get("x-api-key")).toBe("recorded-key");
      expect(JSON.parse(init!.body as string)).toMatchObject({
        model: "test",
        max_tokens: 100,
      });
      return Response.json({
        content: [{ type: "text", text: "Ready" }],
        usage: { input_tokens: 10, output_tokens: 5 },
        stop_reason: "end_turn",
      });
    },
  );
  expect((await response.json<any>()).usage.total_tokens).toBe(15);
});

it("charges the cell total input with cache reads and records cache usage and cost source", async () => {
  const claim = await setup(100000, "anthropic/test");
  const priced = {
    ...runtime,
    MODEL_PRICES: JSON.stringify({
      "anthropic/test": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
    }),
  } as Env;
  const response = await qaModel(
    request(claim, { model: "anthropic/test" }),
    priced,
    async () =>
      Response.json({
        content: [{ type: "text", text: "Ready" }],
        usage: { input_tokens: 10, cache_read_input_tokens: 200, output_tokens: 30 },
        stop_reason: "end_turn",
      }),
  );
  const result = await response.json<any>();
  expect(result.usage).toMatchObject({
    input_tokens: 210,
    output_tokens: 30,
    total_tokens: 240,
    input_tokens_details: { cached_tokens: 200 },
  });
  expect((await ledger()).tokens_used).toBe(240);
  const row = await runtime.DB.prepare(
    "SELECT charged_tokens,input_tokens,cache_read_tokens,cache_write_tokens,usage_convention,cost_source,cost_usd FROM qa_model_usage",
  ).first<any>();
  expect(row).toMatchObject({
    charged_tokens: 240,
    input_tokens: 210,
    cache_read_tokens: 200,
    cache_write_tokens: null,
    usage_convention: "verified",
    cost_source: "estimate",
  });
  expect(row.cost_usd).toBeCloseTo((10 * 3 + 200 * 0.3 + 30 * 15) / 1e6);
});

it("records OpenAI cached tokens and leaves a cached call without a cache price unpriced", async () => {
  const claim = await setup(100000);
  await qaModel(request(claim), runtime, async () =>
    providerReply({
      prompt_tokens: 300,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 256 },
    }),
  );
  const row = await runtime.DB.prepare(
    "SELECT input_tokens,cache_read_tokens,usage_convention,cost_source,cost_usd FROM qa_model_usage",
  ).first<any>();
  // `openai/test` is priced without a cache-read rate.
  expect(row).toMatchObject({
    input_tokens: 300,
    cache_read_tokens: 256,
    usage_convention: "verified",
    cost_source: "unknown",
    cost_usd: null,
  });
});

it("fails a verified reply with invalid cache usage and keeps the reservation charged", async () => {
  const claim = await setup(100000);
  await expect(
    qaModel(request(claim), runtime, async () =>
      providerReply({
        prompt_tokens: 100,
        completion_tokens: 10,
        prompt_tokens_details: { cached_tokens: -1 },
      }),
    ),
  ).rejects.toThrow("provider reported invalid cache usage");
  const row = await runtime.DB.prepare(
    "SELECT state,charged_tokens,reserved,usage_convention FROM qa_model_usage",
  ).first<any>();
  expect(row.state).toBe("failed");
  expect(row.charged_tokens).toBe(row.reserved);
  expect(row.usage_convention).toBeNull();
});

it("renders the run's prompt-cache hints and replaces the harness key", async () => {
  const sent: any[] = [];
  const capture = (reply: () => Response) => async (_url: unknown, init: any) => {
    sent.push(JSON.parse(init.body));
    return reply();
  };
  const anthropic = () =>
    Response.json({
      content: [{ type: "text", text: "Ready" }],
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: "end_turn",
    });
  for (const [model, reply] of [
    ["anthropic/test", anthropic],
    ["openai/test", () => providerReply()],
  ] as const) {
    for (const classes of [null, '["anthropic","openai"]']) {
      await runtime.DB.batch(
        ["qa_model_usage", "qa_cells", "qa_runs", "jobs", "reviews"].map(
          (table) => runtime.DB.prepare(`DELETE FROM ${table}`),
        ),
      );
      const claim = await setup(100000, model);
      await runtime.DB.prepare("UPDATE qa_runs SET prompt_cache=?")
        .bind(classes)
        .run();
      await qaModel(
        request(claim, {
          model,
          instructions: "Harness instructions.",
          prompt_cache_key: "harness-key",
        }),
        runtime,
        capture(reply),
      );
    }
  }
  const [plainAnthropic, hintedAnthropic, plainOpenai, hintedOpenai] = sent;
  expect(JSON.stringify(plainAnthropic)).not.toContain("cache_control");
  expect(hintedAnthropic.system.at(-1).cache_control).toEqual({ type: "ephemeral" });
  expect(hintedAnthropic.messages.at(-1).content.at(-1).cache_control).toEqual({
    type: "ephemeral",
  });
  expect(plainOpenai.prompt_cache_key).toBeUndefined();
  const run = await runtime.DB.prepare("SELECT id FROM qa_runs").first<any>();
  expect(hintedOpenai.prompt_cache_key).toBe(
    promptCacheKey("owner", run.id, `qa\0${cell.id}`),
  );
  expect(JSON.stringify(sent)).not.toContain("harness-key");
});

it("reports authoritative QA cost with verifier usage and preserves missing pricing", async () => {
  const claim = await setup();
  vi.mocked(globalThis.fetch).mockResolvedValue(providerReply());
  await qaModel(request(claim), runtime);
  const initial = await qaUsage(runtime, "review");
  expect(initial.tokens).toBe(50);
  expect(initial.usd).toBeCloseTo(0.00007);
  await runtime.DB.prepare(
    "INSERT INTO usage(id,review_id,actor,phase,reserved,status,input_tokens,output_tokens,cost_usd,model) VALUES('qa-cost-voter','review','voter','verify-qa-blind',100,'completed',20,10,0.001,'test')",
  ).run();
  const verified = await qaUsage(runtime, "review");
  expect(verified.tokens).toBe(80);
  expect(verified.usd).toBeCloseTo(0.00107);
  await runtime.DB.prepare("UPDATE qa_model_usage SET cost_usd=NULL").run();
  expect(await qaUsage(runtime, "review")).toEqual({ tokens: 80, usd: null });
  await runtime.DB.prepare(
    "UPDATE qa_model_usage SET state='failed',estimated=1",
  ).run();
  expect(await qaUsage(runtime, "review")).toEqual({ tokens: null, usd: null });
  await runtime.DB.prepare("DELETE FROM usage WHERE id='qa-cost-voter'").run();
});

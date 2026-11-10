import { env as runtime, applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { ProviderGateway, converse, type Ledger } from "../src/gateway";
import { D1Ledger } from "../src/storage";
import { costOf, selfHostedCache, type NormalizedUsage } from "../src/usage";
import type { Env, Usage } from "../src/types";
import { allMigrations } from "./fixtures";
import fixtures from "./fixtures/usage/usage.json";

const ENV = {
  ANTHROPIC_API_KEY: "key",
  OPENAI_API_KEY: "key",
  OPENROUTER_API_KEY: "key",
} as Env;
/** A gateway whose transport answers each call with `usage` and counts calls. */
function replying(usage: unknown, env: Partial<Env> = {}, extra = {}) {
  let calls = 0;
  const gateway = new ProviderGateway({ ...ENV, ...env } as Env, (async (
    url: RequestInfo | URL,
  ) => {
    calls++;
    const anthropic = String(url).includes("/messages");
    return Response.json(
      anthropic
        ? { content: [{ type: "text", text: "{}" }], usage, ...extra }
        : { choices: [{ message: { content: "{}" } }], usage, ...extra },
    );
  }) as typeof fetch);
  return { gateway, calls: () => calls };
}
const request = (model: string) => ({
  model,
  system: "system",
  messages: [{ role: "user" as const, content: "data" }],
  max_tokens: 100,
});

describe("normalized usage", () => {
  it("labels every recorded fixture with its documentation source", () => {
    for (const c of fixtures.cases)
      expect(
        (fixtures.sources as Record<string, string>)[c.source],
      ).toMatch(/^https:\/\//);
  });
  it.each(fixtures.cases.map((c) => [c.name, c] as const))(
    "%s",
    async (_, c) => {
      const { gateway, calls } = replying(c.usage);
      const call = gateway.complete(request(c.model));
      if ("error" in c && c.error) {
        await expect(call).rejects.toThrow(c.error);
        // A billed reply with invalid cache fields is never sent again.
        expect(calls()).toBe(1);
        return;
      }
      const response = await call;
      expect(calls()).toBe(1);
      const expected = (c as any).expected;
      expect({
        input_tokens: response.input_tokens,
        cache_read_input_tokens: response.cache_read_input_tokens,
        cache_write_input_tokens: response.cache_write_input_tokens,
        output_tokens: response.output_tokens,
        usage_convention: response.usage_convention,
      }).toEqual(expected);
    },
  );
  it("still retries a reply without usage once with the identical body", async () => {
    const bodies: string[] = [];
    const gateway = new ProviderGateway(ENV, (async (_: unknown, init: any) => {
      bodies.push(init.body);
      return Response.json(
        bodies.length === 1
          ? { choices: [{ message: { content: "{}" } }] }
          : {
              choices: [{ message: { content: "{}" } }],
              usage: { prompt_tokens: 3, completion_tokens: 1 },
            },
      );
    }) as typeof fetch);
    await gateway.complete(request("openai/gpt-test"));
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
  });
  it.each([
    ["openrouter/anthropic/claude-test", {}],
    ["compat/custom-node/m", {
      AI_GATEWAY_URL: "https://gateway.example/v1/a/g",
      AI_GATEWAY_TOKEN: "t",
    }],
  ] as const)(
    "charges prompt_tokens on unverified route %s even when writes exceed it",
    async (model, env) => {
      for (const cache of ["off", undefined]) {
        const { gateway } = replying(
          {
            prompt_tokens: 1000,
            completion_tokens: 40,
            prompt_tokens_details: { cached_tokens: 800, cache_write_tokens: 600 },
          },
          { ...env, PROMPT_CACHE: cache } as Partial<Env>,
        );
        const response = await gateway.complete(request(model));
        expect(response.input_tokens).toBe(1000);
        expect(response.usage_convention).toBe("unverified");
        expect(response.cache_read_input_tokens).toBe(800);
      }
    },
  );
  it("treats an OPENAI_BASE_URL route as unverified", async () => {
    const { gateway } = replying(
      { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 50 } },
      { OPENAI_BASE_URL: "http://localhost:8080/v1" },
    );
    const response = await gateway.complete(request("openai/local"));
    expect(response.usage_convention).toBe("unverified");
    expect(response.input_tokens).toBe(10);
  });
});

describe("cost source", () => {
  const usage = (u: Partial<NormalizedUsage>): NormalizedUsage => ({
    input_tokens: 0,
    cache_read_input_tokens: null,
    cache_write_input_tokens: null,
    output_tokens: 0,
    usage_convention: "verified",
    ...u,
  });
  it("prefers OpenRouter's reported cost and never adjusts it", async () => {
    const { gateway } = replying(
      { prompt_tokens: 9000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 8000 }, cost: 0.0123 },
      {
        MODEL_PRICES: JSON.stringify({
          "openrouter/deepseek/d": { input: 4, output: 20, cache_read: 0.2 },
        }),
      },
    );
    const response = await gateway.complete(request("openrouter/deepseek/d"));
    expect(response.cost_usd).toBe(0.0123);
    expect(response.cost_source).toBe("provider");
  });
  it("estimates with every cache rate", () => {
    const cost = costOf(
      usage({
        input_tokens: 101000,
        cache_read_input_tokens: 100000,
        cache_write_input_tokens: 0,
        output_tokens: 500,
      }),
      { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
    );
    expect(cost.cost_source).toBe("estimate");
    expect(cost.cost_usd).toBeCloseTo(0.034, 10);
  });
  it("is unknown when a used cache rate is missing", () => {
    expect(
      costOf(usage({ input_tokens: 100100, cache_read_input_tokens: 100000 }), {
        input: 4,
        output: 20,
      }),
    ).toEqual({ cost_usd: null, cost_source: "unknown" });
    expect(
      costOf(usage({ input_tokens: 9020, cache_write_input_tokens: 9000 }), {
        input: 4,
        output: 20,
        cache_read: 0.4,
      }),
    ).toEqual({ cost_usd: null, cost_source: "unknown" });
  });
  it("uses input and output rates when the call used no cache", () => {
    expect(
      costOf(
        usage({
          input_tokens: 1000,
          cache_read_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 500,
        }),
        { input: 4, output: 20 },
      ),
    ).toEqual({ cost_usd: (1000 * 4 + 500 * 20) / 1e6, cost_source: "estimate" });
  });
  it("is unknown for an unpriced route and for untrusted cache counts", () => {
    expect(costOf(usage({ input_tokens: 10 }), undefined)).toEqual({
      cost_usd: null,
      cost_source: "unknown",
    });
    expect(
      costOf(
        usage({
          input_tokens: 1000,
          cache_read_input_tokens: 800,
          usage_convention: "unverified",
        }),
        { input: 4, output: 20, cache_read: 0.4 },
      ),
    ).toEqual({ cost_usd: null, cost_source: "unknown" });
  });
  it("is unknown for invalid cache fields, which hide whether the cache was used", () => {
    const invalid = usage({
      input_tokens: 1000,
      cache_read_input_tokens: null,
      cache_write_input_tokens: null,
      usage_convention: "invalid",
    });
    expect(
      costOf(invalid, { input: 4, output: 20, cache_read: 0.4, cache_write: 5 }),
    ).toEqual({ cost_usd: null, cost_source: "unknown" });
    // A provider-reported charge still wins.
    expect(costOf(invalid, { input: 4, output: 20 }, 0.01)).toEqual({
      cost_usd: 0.01,
      cost_source: "provider",
    });
  });
  it("keeps unknown cost unknown on an unpriced custom route", async () => {
    const { gateway } = replying(
      { prompt_tokens: 10, completion_tokens: 2, cost: 0.5 },
      {
        AI_GATEWAY_URL: "https://gateway.example/v1/a/g",
        AI_GATEWAY_TOKEN: "t",
        AI_GATEWAY_PROVIDERS: JSON.stringify({ oai: { protocol: "openai" } }),
      },
    );
    const response = await gateway.complete(request("custom-oai/m"));
    expect(response.cost_usd).toBeNull();
    expect(response.cost_source).toBe("unknown");
  });
  it("leaves a priced model with unpriced cache reads unknown", async () => {
    const { gateway } = replying(
      { input_tokens: 50, cache_read_input_tokens: 9000, output_tokens: 5 },
      {
        MODEL_PRICES: JSON.stringify({
          "anthropic/claude-test": { input: 3, output: 15 },
        }),
      },
    );
    const response = await gateway.complete(request("anthropic/claude-test"));
    expect(response.cost_usd).toBeNull();
    expect(response.cost_source).toBe("unknown");
  });
});

describe("usage reaches the ledger", () => {
  class Recording implements Ledger {
    settled: Usage[] = [];
    reserved = 0;
    async remaining() {
      return 1000000;
    }
    async reserve(_a: string, _p: string, n: number) {
      this.reserved += n;
      return "r";
    }
    async settle(_: string, u: Usage) {
      this.settled.push(u);
    }
  }
  it("settles cache counts, convention and cost source from converse", async () => {
    const ledger = new Recording();
    const { gateway } = replying(
      { input_tokens: 50, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0, output_tokens: 5 },
      {},
    );
    await converse({
      gateway,
      ledger,
      actor: "a",
      phase: "generation",
      model: "anthropic/claude-test",
      allowance: { remaining: 100000 },
      messages: [{ role: "user", content: "data" }],
      dispatch: async () => ({}),
    }).catch(() => {});
    expect(ledger.settled[0]).toMatchObject({
      input_tokens: 9050,
      cache_read_input_tokens: 9000,
      cache_write_input_tokens: 0,
      usage_convention: "verified",
      cost_source: "unknown",
    });
  });
  it("keeps the whole reservation of a call with invalid cache usage", async () => {
    const ledger = new Recording();
    const { gateway, calls } = replying({
      prompt_tokens: 100,
      completion_tokens: 40,
      prompt_tokens_details: { cached_tokens: 500 },
    });
    await expect(
      converse({
        gateway,
        ledger,
        actor: "a",
        phase: "generation",
        model: "openai/gpt-test",
        allowance: { remaining: 100000 },
        messages: [{ role: "user", content: "data" }],
        dispatch: async () => ({}),
      }),
    ).rejects.toThrow("invalid cache usage");
    expect(calls()).toBe(1);
    expect(ledger.reserved).toBeGreaterThan(0);
    expect(ledger.settled).toEqual([]);
  });
  it("records self-hosted cached counts without ever failing the member", () => {
    expect(selfHostedCache(5000, 4096)).toEqual({
      cache_read_input_tokens: 4096,
      cache_write_input_tokens: null,
      usage_convention: "unverified",
    });
    expect(selfHostedCache(5000, undefined).cache_read_input_tokens).toBeNull();
    for (const invalid of [6000, -1, 12.5, "4096", 2 ** 60])
      expect(selfHostedCache(5000, invalid)).toEqual({
        cache_read_input_tokens: null,
        cache_write_input_tokens: null,
        usage_convention: "invalid",
      });
  });
});

describe("D1 ledger", () => {
  beforeAll(async () => {
    await applyD1Migrations(runtime.DB, allMigrations);
  });
  it("charges a warm turn its total input and persists cache fields", async () => {
    await runtime.DB.prepare(
      "INSERT INTO reviews(id,tenant,submission_key,status,created_at,token_limit,deadline) VALUES(?,?,?,'queued',?,?,?)",
    )
      .bind("ledger-review", "owner", "k", Date.now(), 200000, Date.now() + 600000)
      .run();
    const ledger = new D1Ledger(runtime as unknown as Env, "ledger-review");
    const reservation = await ledger.reserve("a", "verify-disclosed", 50000);
    await ledger.settle(reservation, {
      phase: "verify-disclosed",
      actor: "a",
      model: "anthropic/claude-test",
      input_tokens: 31000,
      output_tokens: 500,
      cost_usd: null,
      cache_read_input_tokens: 30000,
      cache_write_input_tokens: 0,
      usage_convention: "verified",
      cost_source: "unknown",
    });
    const review = await runtime.DB.prepare(
      "SELECT tokens_used,tokens_reserved FROM reviews WHERE id=?",
    )
      .bind("ledger-review")
      .first();
    expect(review).toEqual({ tokens_used: 31500, tokens_reserved: 0 });
    const row = await runtime.DB.prepare(
      "SELECT input_tokens,cache_read_tokens,cache_write_tokens,usage_convention,cost_source FROM usage WHERE id=?",
    )
      .bind(reservation)
      .first();
    expect(row).toEqual({
      input_tokens: 31000,
      cache_read_tokens: 30000,
      cache_write_tokens: 0,
      usage_convention: "verified",
      cost_source: "unknown",
    });
  });
});

describe("prompt-cache report metrics", () => {
  const row = (r: Partial<import("../src/usage").UsageRow>) => ({
    phase: "generation",
    status: "completed",
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    usage_convention: null,
    cost_source: "unknown",
    ...r,
  });
  it("computes the ratio over verified reporting calls only", async () => {
    const { promptCacheReport } = await import("../src/usage");
    const report = promptCacheReport(
      [
        row({ input_tokens: 6000, cache_read_tokens: 5400, cache_write_tokens: 0, usage_convention: "verified" }),
        row({ input_tokens: 4000, cache_read_tokens: 3600, cache_write_tokens: 0, usage_convention: "verified" }),
        row({ input_tokens: 5000, usage_convention: "verified" }),
        row({ input_tokens: 5000, usage_convention: "verified" }),
        row({ status: "reserved", input_tokens: null }),
      ],
      { hint_classes: ["anthropic"], layout_features: [] },
    );
    const p = report.phases.generation;
    expect(report.hint_classes).toEqual(["anthropic"]);
    expect(p.calls).toBe(4);
    expect(p.calls_reporting_cache).toBe(2);
    expect(p.cache_read_input_tokens).toBe(9000);
    expect(p.read_ratio).toBe(0.9);
    expect(p.input_tokens).toBe(20000);
  });
  it("leaves totals and the ratio null when nothing was reported, and counts unverified calls apart", async () => {
    const { promptCacheReport } = await import("../src/usage");
    const report = promptCacheReport(
      [
        row({ input_tokens: 10 }),
        row({ input_tokens: 10, cache_read_tokens: 8, usage_convention: "unverified" }),
        row({ input_tokens: 10, usage_convention: "invalid" }),
      ],
      { hint_classes: [], layout_features: [] },
    );
    const p = report.phases.generation;
    expect(p.unverified_calls).toBe(2);
    expect(p.calls_reporting_cache).toBe(0);
    expect(p.read_ratio).toBeNull();
    expect(p.cache_write_input_tokens).toBeNull();
  });
});

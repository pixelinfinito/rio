import { describe, it, expect, vi } from "vitest";
import {
  ProviderGateway,
  converse,
  joinUrl,
  reachableAliases,
  route,
  elideOldToolResults,
  parseModelOutput,
  type Ledger,
} from "../src/gateway";
import { scrub } from "../src/redaction";
import type { Env } from "../src/types";
const request = {
  model: "openai/test",
  system: "safe system",
  messages: [{ role: "user" as const, content: "data" }],
  max_tokens: 100,
};
it("accepts a single provider JSON fence without treating narrative tool claims as executions", () => {
  expect(
    parseModelOutput(
      'Analysis: <function_calls>not executed</function_calls>\n```json\n{"result":[]}\n```',
    ),
  ).toEqual({ result: [] });
  expect(() => parseModelOutput("```json\n{}\n```\n```json\n{}\n```")).toThrow(
    "malformed",
  );
  expect(() => parseModelOutput("tool prose without JSON")).toThrow(
    "malformed",
  );
});
it("executes identical duplicated provider tool JSON once and rejects differing documents", async () => {
  const tool = JSON.stringify({
    tools: [
      { name: "read_file", args: { version: "head", path: 'a\"}\\.ts' } },
    ],
  });
  expect(parseModelOutput(`${tool} \n\n${tool}`)).toEqual(JSON.parse(tool));
  for (const invalid of [
    `${tool} {"result":[]}`,
    `${tool} ${tool} trailing`,
    `${tool} ${tool.slice(0, -1)}`,
  ])
    expect(() => parseModelOutput(invalid)).toThrow("malformed");
  const dispatch = vi.fn(async () => ({ content: "source" }));
  let calls = 0;
  const ledger: Ledger = {
    remaining: async () => 100000,
    reserve: async () => "id",
    settle: async () => {},
  };
  const result = await converse({
    gateway: {
      complete: async (request) => {
        if (calls > 0) expect(request.messages[1].content).toBe(tool);
        return {
          content: calls++ === 0 ? `${tool}\n${tool}` : '{"result":[]}',
          input_tokens: 80,
          output_tokens: 50,
          cost_usd: null,
        };
      },
    },
    ledger,
    actor: "voter",
    phase: "verify-disclosed",
    model: "openrouter/openai/gpt-6.1-sol",
    allowance: { remaining: 16000 },
    messages: [{ role: "user", content: "verify" }],
    dispatch,
  });
  expect(result).toEqual([]);
  expect(dispatch).toHaveBeenCalledTimes(1);
});
it("asks once more for the protocol after native tool syntax and gives up after the repair limit", async () => {
  const xml =
    '<invoke name="read_file">\n<parameter name="args">{"path":"a.ts","version":"head"}</parameter>\n</invoke>';
  const ledger: Ledger = {
    remaining: async () => 100000,
    reserve: async () => "id",
    settle: async () => {},
  };
  const dispatch = vi.fn(async () => ({ content: "source" }));
  const seen: string[][] = [];
  const base = {
    ledger,
    actor: "agent",
    phase: "generation",
    model: "openrouter/anthropic/test",
    dispatch,
  };
  const result = await converse({
    ...base,
    gateway: {
      complete: async (request) => {
        seen.push(request.messages.map((m) => `${m.role}:${m.content.slice(0, 24)}`));
        return {
          content: seen.length === 1 ? xml : '{"result":[]}',
          input_tokens: 80,
          output_tokens: 50,
          cost_usd: null,
        };
      },
    },
    allowance: { remaining: 16000 },
    messages: [{ role: "user", content: "review" }],
  });
  expect(result).toEqual([]);
  expect(dispatch).not.toHaveBeenCalled();
  // The raw reply and the host's correction precede the retry.
  expect(seen[1]).toEqual([
    "user:review",
    `assistant:${xml.slice(0, 24)}`,
    "user:Your previous reply was ",
  ]);
  // A model that relapses after each correction is repaired again, up to the cap.
  const tool = '{"tools":[{"name":"read_file","args":{"path":"a.ts","version":"head"}}]}';
  let relapses = 0;
  const relapsing = await converse({
    ...base,
    gateway: {
      complete: async () => {
        relapses++;
        return {
          content: relapses % 2 ? xml : relapses >= 8 ? '{"result":[]}' : tool,
          input_tokens: 80,
          output_tokens: 50,
          cost_usd: null,
        };
      },
    },
    allowance: { remaining: 160000 },
    messages: [{ role: "user", content: "review" }],
  });
  expect(relapsing).toEqual([]);
  expect(relapses).toBe(8);
  expect(dispatch).toHaveBeenCalledTimes(3);
  let calls = 0;
  await expect(
    converse({
      ...base,
      gateway: {
        complete: async () => {
          calls++;
          return { content: xml, input_tokens: 80, output_tokens: 50, cost_usd: null };
        },
      },
      allowance: { remaining: 16000 },
      messages: [{ role: "user", content: "review" }],
    }),
  ).rejects.toThrow("malformed model output");
  expect(calls).toBe(3);
});
it("repairs an empty tool list and answers calls past the batch limit instead of ending the agent", async () => {
  const ledger: Ledger = {
    remaining: async () => 100000,
    reserve: async () => "id",
    settle: async () => {},
  };
  const dispatch = vi.fn(async () => ({ content: "source" }));
  const base = {
    ledger,
    actor: "agent",
    phase: "generation",
    model: "openrouter/anthropic/test",
    dispatch,
  };
  const tools = Array.from({ length: 10 }, (_, i) => ({
    name: "read_file",
    args: { path: `f${i}.ts`, version: "head" },
  }));
  const sent: any[] = [];
  // null, a bare array, a tool without a name and an empty list are all repaired.
  const single = JSON.stringify({ tools: tools.slice(0, 1) });
  const replies = ["null", "[]", single, '{"tools":[null]}', '{"tools":[]}', JSON.stringify({ tools }), '{"result":[]}'];
  const result = await converse({
    ...base,
    gateway: {
      complete: async (request) => {
        sent.push(request.messages.at(-1));
        return {
          content: replies[sent.length - 1]!,
          input_tokens: 80,
          output_tokens: 50,
          cost_usd: null,
        };
      },
    },
    allowance: { remaining: 160000 },
    messages: [{ role: "user", content: "review" }],
  });
  expect(result).toEqual([]);
  // The malformed replies were repaired, not dispatched: one valid call between
  // them resets the consecutive-repair count, then the batch ran its first eight.
  expect(dispatch).toHaveBeenCalledTimes(9);
  for (const i of [1, 2, 4, 5])
    expect(sent[i].content).toMatch(/^Your previous reply was not the protocol/);
  expect(JSON.parse(sent[3].content).tool_results).toHaveLength(1);
  const results = JSON.parse(sent[6].content).tool_results;
  expect(results).toHaveLength(10);
  expect(results.slice(0, 8).every((r: any) => r.result)).toBe(true);
  expect(results[8].error).toMatch(/limited to 8 calls per turn/);
  expect(results[9].error).toMatch(/resend it/);
});
it("offers up to 16k output tokens per turn within the allowance", async () => {
  const ledger: Ledger = {
    remaining: async () => 1000000,
    reserve: async () => "id",
    settle: async () => {},
  };
  const seen: number[] = [];
  const base = {
    ledger,
    actor: "agent",
    phase: "generation",
    model: "openrouter/anthropic/test",
    dispatch: async () => ({}),
    gateway: {
      complete: async (request: any) => {
        seen.push(request.max_tokens);
        return { content: '{"result":[]}', input_tokens: 80, output_tokens: 50, cost_usd: null };
      },
    },
  };
  await converse({ ...base, allowance: { remaining: 400000 }, messages: [{ role: "user", content: "review" }] });
  await converse({ ...base, allowance: { remaining: 3000 }, messages: [{ role: "user", content: "review" }] });
  expect(seen[0]).toBe(16384);
  expect(seen[1]).toBeLessThan(3000);
  expect(seen[1]).toBeGreaterThan(0);
});
it("elides tool results older than the most recent ones once the history exceeds its budget", () => {
  const big = JSON.stringify({ tool_results: [{ name: "read_file", result: "x".repeat(50000) }] });
  const messages = [
    { role: "user" as const, content: "review" },
    { role: "assistant" as const, content: '{"tools":[{"name":"read_file","args":{}}]}' },
    { role: "user" as const, content: big },
    { role: "assistant" as const, content: '{"tools":[{"name":"read_file","args":{}}]}' },
    { role: "user" as const, content: big },
    { role: "assistant" as const, content: '{"tools":[{"name":"read_file","args":{}}]}' },
    { role: "user" as const, content: big },
    { role: "assistant" as const, content: '{"tools":[{"name":"read_file","args":{}}]}' },
    { role: "user" as const, content: big },
  ];
  const untouched = structuredClone(messages);
  expect(elideOldToolResults(untouched, 1 << 20)).toBe(0);
  expect(untouched).toEqual(messages);
  // Four results of 50 KB exceed 150 KB: the oldest goes, then the next, and the
  // recent two stay whole even though the history is still over budget.
  expect(elideOldToolResults(messages, 150 * 1024)).toBe(1);
  expect(messages[2].content).toContain('"tool_results_elided":true');
  expect(messages[4].content).toBe(big);
  expect(elideOldToolResults(messages, 1)).toBe(1);
  expect(messages[4].content).toContain('"tool_results_elided":true');
  expect(messages[6].content).toBe(big);
  expect(messages[8].content).toBe(big);
  expect(elideOldToolResults(messages, 1)).toBe(0);
  // The prompt and the model's own tool requests are never touched.
  expect(messages[0].content).toBe("review");
  expect(messages[1].content).toContain('"tools"');
});
it("retries one transient provider failure and never a client error", async () => {
  const attempts: number[] = [];
  const flaky = async () => {
    attempts.push(attempts.length);
    return attempts.length === 1
      ? Response.json({ choices: [{ message: {} }] })
      : Response.json({
          choices: [{ message: { content: '{"result":[]}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        });
  };
  const env = { OPENAI_API_KEY: "key" } as Env;
  const response = await new ProviderGateway(env, flaky as typeof fetch).complete(request);
  expect(response.input_tokens).toBe(10);
  expect(attempts).toHaveLength(2);
  let calls = 0;
  const rejecting = async () => {
    calls++;
    return new Response("bad request", { status: 400 });
  };
  await expect(
    new ProviderGateway(env, rejecting as typeof fetch).complete(request),
  ).rejects.toThrow("provider failed (400)");
  expect(calls).toBe(1);
  let overloaded = 0;
  const alwaysOverloaded = async () => {
    overloaded++;
    return new Response("overloaded", { status: 529 });
  };
  await expect(
    new ProviderGateway(env, alwaysOverloaded as typeof fetch).complete(request),
  ).rejects.toThrow("provider failed (529)");
  expect(overloaded).toBe(2);
}, 15000);
it("calls the runtime fetch function with its global receiver", async () => {
  const transport = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async function (this: unknown) {
      expect(this).toBe(globalThis);
      return Response.json({
        choices: [{ message: { content: "{}" } }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      });
    });
  try {
    const response = await new ProviderGateway({
      OPENAI_API_KEY: "key",
    } as Env).complete(request);
    expect(response.input_tokens).toBe(10);
  } finally {
    transport.mockRestore();
  }
});
it.each(["openai", "anthropic", "openrouter"])(
  "adapts %s responses and reports priced usage",
  async (provider) => {
    let sent: any;
    const transport = async (url: any, init: any) => {
      sent = { url: String(url), ...init, body: JSON.parse(init.body) };
      return Response.json(
        provider === "anthropic"
          ? {
              content: [{ type: "text", text: '{"result":[]}' }],
              usage: { input_tokens: 10, output_tokens: 20 },
            }
          : {
              choices: [{ message: { content: '{"result":[]}' } }],
              usage: { prompt_tokens: 10, completion_tokens: 20 },
            },
      );
    };
    const env = {
      OPENAI_API_KEY: "key",
      ANTHROPIC_API_KEY: "key",
      OPENROUTER_API_KEY: "key",
      MODEL_PRICES: JSON.stringify({
        [`${provider}/test`]: { input: 1, output: 2 },
      }),
    } as Env;
    const result = await new ProviderGateway(
      env,
      transport as typeof fetch,
    ).complete({ ...request, model: `${provider}/test` });
    expect(result.cost_usd).toBe(0.00005);
    expect(sent.body.max_tokens).toBe(100);
    expect(sent.url).toContain(
      provider === "anthropic" ? "/messages" : "/chat/completions",
    );
    if (provider === "anthropic") expect(sent.headers["x-api-key"]).toBe("key");
    else expect(sent.headers.authorization).toBe("Bearer key");
  },
);
it("proxies through AI Gateway without changing Rio usage accounting and rejects missing usage", async () => {
  const env = {
    OPENAI_API_KEY: "key",
    AI_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/account/gateway",
    AI_GATEWAY_TOKEN: "gateway-key",
  } as Env;
  let url = "";
  const provider = new ProviderGateway(env, (async (u, init) => {
    url = String(u);
    const headers = new Headers(init?.headers);
    expect(headers.get("cf-aig-authorization")).toBe("Bearer gateway-key");
    expect(headers.get("authorization")).toBe("Bearer key");
    expect(headers.get("cf-aig-skip-cache")).toBe("true");
    expect(headers.get("cf-aig-collect-log")).toBe("false");
    return Response.json({ choices: [{ message: { content: "{}" } }] });
  }) as typeof fetch);
  await expect(provider.complete(request)).rejects.toThrow("usage");
  expect(url).toBe(
    "https://gateway.ai.cloudflare.com/v1/account/gateway/openai/chat/completions",
  );
});
it("requires a gateway credential before sending provider credentials", async () => {
  let called = false;
  const gateway = new ProviderGateway(
    {
      OPENAI_API_KEY: "key",
      AI_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/account/gateway",
    } as Env,
    (async () => {
      called = true;
      return Response.json({});
    }) as typeof fetch,
  );
  await expect(gateway.complete(request)).rejects.toThrow("Gateway token");
  expect(called).toBe(false);
});
it("records OpenRouter's reported charge when no local price is configured", async () => {
  const gateway = new ProviderGateway(
    { OPENROUTER_API_KEY: "key" } as Env,
    (async () =>
      Response.json({
        choices: [{ message: { content: "{}" } }],
        usage: { prompt_tokens: 10, completion_tokens: 20, cost: 0.00012 },
      })) as typeof fetch,
  );
  expect(
    (await gateway.complete({ ...request, model: "openrouter/openai/test" }))
      .cost_usd,
  ).toBe(0.00012);
});
it("reserves both turns against one allowance, records exhaustion and does not refund unknown failures", async () => {
  let reserved = 0,
    settled = 0;
  const ledger: Ledger = {
    async remaining() {
      return 100000;
    },
    async reserve(_a, _p, n) {
      reserved += n;
      return "id";
    },
    async settle() {
      settled++;
    },
  };
  const options = {
    gateway: {
      async complete() {
        throw new Error("provider failed");
      },
    },
    ledger,
    actor: "voter",
    phase: "verify-blind",
    model: "openai/test",
    allowance: { remaining: 10000 },
    messages: [{ role: "user" as const, content: "data" }],
    dispatch: async () => {},
  };
  await expect(converse(options)).rejects.toThrow("provider failed");
  expect(reserved).toBeGreaterThan(0);
  expect(settled).toBe(0);
  const small = { ...options, allowance: { remaining: 1 } };
  await expect(converse(small)).rejects.toThrow("budget exhausted");
});
it("redacts persisted artifacts with the shared catalog before formatting", () => {
  const result = scrub({
    stdout: "AWS AKIA1234567890ABCDEF",
    vote: { message: "postgres://name:password@host/db" },
  });
  expect(result.stdout).not.toContain("1234567890ABCDEF");
  expect(result.vote.message).toContain("[REDACTED]");
});
it("charges both verification turns to the same allowance and respects the review deadline", async () => {
  let calls = 0;
  const ledger: Ledger = {
    remaining: async () => 100000,
    reserve: async () => "id",
    settle: async () => {},
  };
  const allowance = { remaining: 9000 };
  const options = {
    gateway: {
      complete: async () => {
        calls++;
        return {
          content: '{"result":[]}',
          input_tokens: 4000,
          output_tokens: 1000,
          cost_usd: null,
        };
      },
    },
    ledger,
    actor: "voter",
    model: "openai/test",
    allowance,
    messages: [{ role: "user" as const, content: "x".repeat(4000) }],
    dispatch: async () => {},
  };
  await converse({ ...options, phase: "verify-blind" });
  expect(allowance.remaining).toBe(4000);
  await expect(
    converse({ ...options, phase: "verify-disclosed" }),
  ).rejects.toThrow("budget exhausted");
  expect(calls).toBe(1);
  await expect(
    converse({
      ...options,
      allowance: { remaining: 20000 },
      ledger: { ...ledger, remainingMs: async () => 0 },
      phase: "verify-blind",
    }),
  ).rejects.toThrow("wall budget exhausted");
  expect(calls).toBe(1);
});
describe("model routes", () => {
  const GW = "https://gateway.ai.cloudflare.com/v1/acct/rio";
  const gateway = {
    AI_GATEWAY_URL: `${GW}/`,
    AI_GATEWAY_TOKEN: "gateway-token",
    AI_GATEWAY_PROVIDERS: JSON.stringify({
      "node-openai": { protocol: "openai" },
      "node-anthropic": { protocol: "anthropic" },
    }),
    OPENAI_API_KEY: "openai-key",
    ANTHROPIC_API_KEY: "anthropic-key",
    OPENROUTER_API_KEY: "openrouter-key",
  } as Env;
  const plain = (r: ReturnType<typeof route>) => ({
    url: String(r.url),
    protocol: r.protocol,
    model: r.model,
    auth: r.headers.authorization ?? r.headers["x-api-key"] ?? null,
    gateway: r.headers["cf-aig-authorization"] ?? null,
  });
  it("joins URLs with one slash and never duplicates the version segment", () => {
    expect(joinUrl("https://a/v1/", "/chat/completions")).toBe(
      "https://a/v1/chat/completions",
    );
    expect(joinUrl("https://a/x", "openai", "", "chat/completions")).toBe(
      "https://a/x/openai/chat/completions",
    );
  });
  it.each([
    [
      "openai/gpt",
      `${GW}/openai/chat/completions`,
      "openai",
      "gpt",
      "Bearer openai-key",
    ],
    [
      "anthropic/claude",
      `${GW}/anthropic/v1/messages`,
      "anthropic",
      "claude",
      "anthropic-key",
    ],
    [
      "openrouter/anthropic/claude",
      `${GW}/openrouter/chat/completions`,
      "openai",
      "anthropic/claude",
      "Bearer openrouter-key",
    ],
    // Custom providers: the native endpoint in the provider's protocol; the
    // gateway adds the upstream credential, so no provider key is sent.
    [
      "custom-node-openai/gpt-6.1-sol",
      `${GW}/custom-node-openai/chat/completions`,
      "openai",
      "gpt-6.1-sol",
      null,
    ],
    [
      "custom-node-anthropic/claude-sonnet-5-5",
      `${GW}/custom-node-anthropic/messages`,
      "anthropic",
      "claude-sonnet-5-5",
      null,
    ],
    // The unified endpoint and dynamic routes.
    [
      "compat/custom-node-anthropic/claude-sonnet-5-5",
      `${GW}/compat/chat/completions`,
      "openai",
      "custom-node-anthropic/claude-sonnet-5-5",
      null,
    ],
    [
      "dynamic/support",
      `${GW}/compat/chat/completions`,
      "openai",
      "dynamic/support",
      null,
    ],
    // Profiles written for OPENAI_BASE_URL=<gateway>/compat keep working.
    [
      "openai/custom-node-anthropic/claude-sonnet-5-5",
      `${GW}/compat/chat/completions`,
      "openai",
      "custom-node-anthropic/claude-sonnet-5-5",
      null,
    ],
    [
      "openai/dynamic/support",
      `${GW}/compat/chat/completions`,
      "openai",
      "dynamic/support",
      null,
    ],
  ])("routes %s through the gateway", (model, url, protocol, sent, auth) => {
    expect(plain(route(gateway, model))).toEqual({
      url,
      protocol,
      model: sent,
      auth,
      gateway: "Bearer gateway-token",
    });
  });
  it("keeps direct provider APIs and an OPENAI_BASE_URL without a gateway", () => {
    const direct = {
      OPENAI_API_KEY: "k",
      ANTHROPIC_API_KEY: "a",
      OPENROUTER_API_KEY: "o",
    } as Env;
    expect(String(route(direct, "openai/gpt").url)).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
    expect(String(route(direct, "anthropic/c").url)).toBe(
      "https://api.anthropic.com/v1/messages",
    );
    expect(String(route(direct, "openrouter/x/y").url)).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
    // The manual setup: OPENAI_BASE_URL at the gateway's /compat, its token as key.
    const manual = route(
      {
        OPENAI_API_KEY: "gateway-token",
        OPENAI_BASE_URL: `${GW}/compat/`,
        AI_GATEWAY_URL: "",
      } as Env,
      "openai/custom-node-anthropic/claude-sonnet-5-5",
    );
    expect(plain(manual)).toEqual({
      url: `${GW}/compat/chat/completions`,
      protocol: "openai",
      model: "custom-node-anthropic/claude-sonnet-5-5",
      auth: "Bearer gateway-token",
      gateway: null,
    });
  });
  it("rejects routes it cannot serve before sending anything", () => {
    const fail = (env: Partial<Env>, model: string, message: string | RegExp) =>
      expect(() => route(env as Env, model)).toThrow(message);
    fail({}, "custom-node-openai/gpt", "requires AI Gateway");
    fail(
      { ...gateway, AI_GATEWAY_TOKEN: undefined },
      "custom-node-openai/gpt",
      "Gateway token",
    );
    fail(
      gateway,
      "custom-unknown/gpt",
      "custom provider unknown is not configured",
    );
    fail(
      { ...gateway, AI_GATEWAY_PROVIDERS: "{" },
      "custom-node-openai/gpt",
      "not valid JSON",
    );
    fail(
      { ...gateway, AI_GATEWAY_PROVIDERS: '{"x":{"protocol":"grpc"}}' },
      "custom-x/gpt",
      "protocol",
    );
    fail(gateway, "compat/gpt", "provider/model");
    fail({}, "dynamic/support", "requires AI Gateway");
    fail(gateway, "mistral/large", "unsupported model provider");
    fail(gateway, "openai/", "provider/model");
    fail(
      { OPENAI_API_KEY: "k", OPENAI_BASE_URL: "http://example.com/v1" },
      "openai/gpt",
      "TLS",
    );
    // Error messages never carry credentials.
    for (const model of ["custom-unknown/gpt", "mistral/large"])
      try {
        route(gateway, model);
      } catch (error) {
        expect(String(error)).not.toMatch(
          /gateway-token|openai-key|anthropic-key/,
        );
      }
  });
  it("sends each protocol's body and keeps unknown cost unknown", async () => {
    const sent: any[] = [];
    const transport = (async (url: any, init: any) => {
      sent.push({
        url: String(url),
        headers: init.headers,
        body: JSON.parse(init.body),
      });
      return Response.json(
        String(url).endsWith("/messages")
          ? {
              content: [{ type: "text", text: "{}" }],
              usage: { input_tokens: 10, output_tokens: 20 },
            }
          : {
              choices: [{ message: { content: "{}" } }],
              usage: { prompt_tokens: 10, completion_tokens: 20, cost: 0.5 },
            },
      );
    }) as typeof fetch;
    const provider = new ProviderGateway(gateway, transport);
    const anthropic = await provider.complete({
      ...request,
      model: "custom-node-anthropic/claude-sonnet-5-5",
    });
    expect(sent[0].body).toEqual({
      model: "claude-sonnet-5-5",
      system: "safe system",
      messages: request.messages,
      max_tokens: 100,
    });
    expect(sent[0].headers["anthropic-version"]).toBe("2023-06-01");
    expect(sent[0].headers["x-api-key"]).toBeUndefined();
    // A custom route's usage cost field is not trusted; without a price it is unknown.
    const openai = await provider.complete({
      ...request,
      model: "compat/custom-node-openai/gpt-6.1-sol",
    });
    expect(sent[1].body.model).toBe("custom-node-openai/gpt-6.1-sol");
    expect(sent[1].body.response_format).toEqual({ type: "json_object" });
    expect(sent[1].body.provider).toBeUndefined();
    for (const r of [anthropic, openai]) expect(r.cost_usd).toBeNull();
    const priced = await new ProviderGateway(
      {
        ...gateway,
        MODEL_PRICES: JSON.stringify({
          "custom-node-openai/gpt-6.1-sol": { input: 1, output: 2 },
        }),
      },
      transport,
    ).complete({ ...request, model: "custom-node-openai/gpt-6.1-sol" });
    expect(priced.cost_usd).toBe(0.00005);
  });
});

it("resolves reachable model aliases with the Workflow's and verifier's precedence", () => {
  const profile = (models: Record<string, string>, steps: any[], verify: any = {}) =>
    ({ models, steps, verify: { voters: 3, quorum: 2, ...verify } }) as any;
  const agentsStep = (agents: any[] = [], uses = "rio/agents@0.1.0") => ({ id: "a", uses, needs: [], with: {}, agents });
  const verify = { id: "v", uses: "rio/verify@0.1.0", needs: [], with: {} };
  const set = (p: any) => [...reachableAliases(p)].sort();
  // No model step: nothing is called.
  expect(set(profile({ default: "x/y" }, []))).toEqual([]);
  expect(set(profile({ default: "x/y", verifier: "x/z" }, [agentsStep(), verify]))).toEqual(["default", "verifier"]);
  // Agent-named aliases are reachable unless every agents step overrides them.
  const models = { default: "x/y", correctness: "x/c", security: "x/s", fast: "x/f" };
  expect(set(profile(models, [agentsStep()]))).toEqual(["correctness", "default"]);
  expect(set(profile(models, [agentsStep([{ correctness: { model: "fast" } }])]))).toEqual(["default", "fast"]);
  expect(set(profile(models, [agentsStep([{ correctness: { model: "missing" } }])]))).toEqual(["default"]);
  expect(set(profile(models, [agentsStep([], "rio/security@0.2.0")]))).toEqual(["security"]);
  expect(set(profile(models, [verify], { model: "fast" }))).toEqual(["fast"]);
});

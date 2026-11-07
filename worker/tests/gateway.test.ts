import { it, expect, vi } from "vitest";
import {
  ProviderGateway,
  converse,
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

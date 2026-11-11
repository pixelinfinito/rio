/**
 * Wire scenarios: one generation conversation (two tool turns and a repair),
 * one voter (blind and disclosed turns) and one council round, sent through
 * `ProviderGateway` with a capturing transport on every route class. The
 * captured bodies are the wire fixtures under `tests/fixtures/wire/`; the same
 * module runs in vitest (comparison) and in `scripts/capture-wire.mjs` (writing).
 */
import { ProviderGateway, converse, type Ledger } from "../../src/gateway";
import { verifyHypothesis } from "../../src/verifier";
import { memberRequest } from "../../src/council-pack";
import { Tools } from "../../src/tools";
import type { Env, Gateway, ModelRequest, Profile } from "../../src/types";
import { graphs, hypothesis, profile, snapshot } from "../fixtures";
import inputs from "../fixtures/wire/inputs.json";
import { generationPrompt } from "../../src/prompt";
import {
  partitionValue,
  promptCacheKey,
  providerIdentity,
} from "../../src/prompt-config";
import { preGenerationPrompt } from "./pre-template";

const GATEWAY = {
  AI_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/acct/rio",
  AI_GATEWAY_TOKEN: "gateway-token",
};
const PROVIDERS = JSON.stringify({
  node: { protocol: "anthropic" },
  oai: { protocol: "openai" },
});
/** Route classes: a name, the profile model and the Worker settings. */
export const ROUTES: { name: string; model: string; env: Partial<Env> }[] = [
  { name: "anthropic-direct", model: "anthropic/claude-test", env: { ANTHROPIC_API_KEY: "test-key" } },
  { name: "anthropic-gateway", model: "anthropic/claude-test", env: { ANTHROPIC_API_KEY: "test-key", ...GATEWAY } },
  { name: "openai-direct", model: "openai/gpt-test", env: { OPENAI_API_KEY: "test-key" } },
  { name: "openai-gateway", model: "openai/gpt-test", env: { OPENAI_API_KEY: "test-key", ...GATEWAY } },
  { name: "openai-base-url", model: "openai/local-model", env: { OPENAI_API_KEY: "test-key", OPENAI_BASE_URL: "http://localhost:8080/v1" } },
  { name: "openrouter-deepseek", model: "openrouter/deepseek/deepseek-test", env: { OPENROUTER_API_KEY: "test-key" } },
  { name: "openrouter-anthropic", model: "openrouter/anthropic/claude-test", env: { OPENROUTER_API_KEY: "test-key" } },
  { name: "compat", model: "compat/custom-node/m", env: { ...GATEWAY, AI_GATEWAY_PROVIDERS: PROVIDERS } },
  { name: "dynamic", model: "dynamic/support", env: { ...GATEWAY } },
  { name: "openai-dynamic", model: "openai/dynamic/support", env: { OPENAI_API_KEY: "test-key", ...GATEWAY } },
  { name: "custom-anthropic", model: "custom-node/claude-test", env: { ...GATEWAY, AI_GATEWAY_PROVIDERS: PROVIDERS } },
  { name: "custom-openai", model: "custom-oai/gpt-test", env: { ...GATEWAY, AI_GATEWAY_PROVIDERS: PROVIDERS } },
];

/** A fixed test secret; the partition value per route follows from it. */
export const TEST_SECRET = "00".repeat(32);
export interface Captured {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}
/**
 * Settings a scenario passes to the code under test: the tenant partition, the
 * enabled hint classes and layout features. `frozen` sends the pinned
 * baseline's generation text instead of the builder's.
 */
export interface ScenarioOptions {
  partition?: boolean;
  cache?: string[];
  layout?: string[];
  frozen?: boolean;
}
const partitionOf = (r: (typeof ROUTES)[number], o: ScenarioOptions) =>
  o.partition
    ? partitionValue(TEST_SECRET, providerIdentity(r.env as Env, r.model))
    : undefined;
const cacheOf = (o: ScenarioOptions, root: string) =>
  o.cache
    ? { classes: o.cache, key: promptCacheKey("tenant", "review", root) }
    : undefined;

/** A transport that records each request and answers the next scripted reply. */
function transport(protocol: "anthropic" | "openai", replies: string[], captured: Captured[]) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({
      url: String(input),
      headers: { ...(init?.headers as Record<string, string>) },
      body: JSON.parse(String(init?.body)),
    });
    const content = replies.shift() ?? '{"result":[]}';
    const body =
      protocol === "anthropic"
        ? { content: [{ type: "text", text: content }], usage: { input_tokens: 10, output_tokens: 5 } }
        : { choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
    return new Response(JSON.stringify(body), { status: 200 });
  };
}
const ledger = (): Ledger => ({
  remaining: async () => 1000000,
  reserve: async () => "reservation",
  settle: async () => {},
});
function gatewayFor(env: Partial<Env>, model: string, replies: string[], captured: Captured[]) {
  const protocol =
    model.startsWith("anthropic/") || model.startsWith("custom-node/") ? "anthropic" : "openai";
  return new ProviderGateway({ ...env } as Env, transport(protocol, [...replies], captured) as typeof fetch);
}

export async function generation(r: (typeof ROUTES)[number], _options: ScenarioOptions = {}) {
  const captured: Captured[] = [];
  const gateway = gatewayFor(r.env, r.model, inputs.generation.replies, captured);
  await converse({
    gateway,
    ledger: ledger(),
    actor: "agents-correctness",
    phase: "generation",
    model: r.model,
    allowance: { remaining: 900000 },
    messages: [
      {
        role: "user",
        content: _options.frozen
          ? preGenerationPrompt(inputs.generation.blocks)
          : generationPrompt({
              ...inputs.generation.blocks,
              partition: partitionOf(r, _options),
              order: _options.layout?.includes("agent-order"),
            }),
      },
    ],
    dispatch: async () => inputs.generation.tool_result,
    cache: cacheOf(_options, "generation"),
    compaction: _options.layout?.includes("compaction"),
  });
  return captured;
}

export async function voter(r: (typeof ROUTES)[number], _options: ScenarioOptions = {}) {
  const captured: Captured[] = [];
  const gateway: Gateway = gatewayFor(r.env, r.model, inputs.voter.replies, captured);
  const single: Profile = {
    ...profile,
    models: { default: r.model },
    verify: { voters: 1, quorum: 1 },
  };
  await verifyHypothesis({
    profile: single,
    hypothesis,
    intent: inputs.voter.intent,
    guidance: [],
    snapshot,
    context: { snapshot, head: graphs.head, executions: {}, guidance: [] },
    gateway,
    ledger: ledger(),
    tools: () => new Tools(snapshot, graphs, undefined),
    save: async () => {},
    prompt: {
      partition: partitionOf(r, _options),
      single: _options.layout?.includes("verifier-system"),
      cache: cacheOf(_options, `verify:${hypothesis.id}`),
    },
  });
  return captured;
}

export async function council(r: (typeof ROUTES)[number], _options: ScenarioOptions = {}) {
  const captured: Captured[] = [];
  const gateway = gatewayFor(r.env, r.model, [inputs.council.reply], captured);
  const c = inputs.council;
  const request = memberRequest(c.role as any, c.prompt, c.rendering, 1, undefined, undefined, {
    partition: partitionOf(r, _options),
    order: _options.layout?.includes("council-order"),
  });
  const body: ModelRequest = {
    model: r.model,
    system: request.parts!.system,
    messages: [{ role: "user", content: request.parts!.content }],
    max_tokens: 4096,
    cache: cacheOf(_options, `council:${hypothesis.id}:${c.role}`),
  };
  await gateway.complete(body);
  return captured;
}

/** Every scenario on every route: `{route: {generation, voter, council}}`. */
export async function captureAll(options: ScenarioOptions = {}) {
  const out: Record<string, Record<string, Captured[]>> = {};
  for (const r of ROUTES)
    out[r.name] = {
      generation: await generation(r, options),
      voter: await voter(r, options),
      council: await council(r, options),
    };
  return out;
}

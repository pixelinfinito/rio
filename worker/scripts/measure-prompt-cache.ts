/**
 * The opt-in live prompt-cache measurement (docs/evaluation/prompt-caching.md).
 * It sends real, billed requests through `ProviderGateway`, so it runs only when
 * `RIO_LIVE_PROMPT_CACHE=1`, a spend cap and the route's key are all present;
 * otherwise it returns before any network call. Never run in CI.
 */
import { ProviderGateway, converse, systemPrompt, type Ledger } from "../src/gateway";
import { blindPrompt, generationPrompt, join } from "../src/prompt";
import { promptCacheKey } from "../src/prompt-config";
import type { Env, ModelRequest, ModelResponse } from "../src/types";

export interface Measurement {
  measurement: string;
  route: string;
  variant: string;
  repetition: number;
  request: number;
  ms: number;
  input_tokens: number;
  cache_read_input_tokens: number | null;
  cache_write_input_tokens: number | null;
  output_tokens: number;
  usage_convention: string | null;
  cost_usd: number | null;
  cost_source: string | null;
  // OpenRouter's serving upstream, for the stickiness measurement.
  upstream?: string | null;
}
export interface Plan {
  // Route classes to measure, as profile models, e.g. `anthropic/claude-sonnet-5-5`.
  routes: string[];
  repetitions: number;
  spendCapUsd: number;
}
const KEYS: Record<string, keyof Env> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};
/** Why the procedure must not run, or null when every gate is open. */
export function refusal(env: Record<string, string | undefined>, plan: Plan): string | null {
  if (env.RIO_LIVE_PROMPT_CACHE !== "1")
    return "RIO_LIVE_PROMPT_CACHE=1 is not set; nothing was sent";
  if (!(plan.spendCapUsd > 0)) return "a positive spend cap is required";
  if (!plan.routes.length) return "no route to measure";
  for (const route of plan.routes) {
    const head = route.split("/", 1)[0];
    const key = KEYS[head];
    if (!key && !env.AI_GATEWAY_URL)
      return `route ${route} needs AI_GATEWAY_URL`;
    if (key && !env[key]) return `route ${route} needs ${key}`;
  }
  return null;
}
/** A large, stable review context, salted so a run starts cold. */
function context(salt: string, kb = 24) {
  const line = (i: number) =>
    `export function handler${i}(input: Request): Response { return route(input, ${i}); }`;
  return `<repository_data label="changed code excerpts">${JSON.stringify(
    Array.from({ length: kb * 12 }, (_, i) => line(i)),
  )}</repository_data>\n<!-- measurement ${salt} -->`;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function measure(
  env: Record<string, string | undefined>,
  plan: Plan,
  transport: typeof fetch = (i, init) => globalThis.fetch(i, init),
  log: (line: string) => void = console.log,
): Promise<{ status: "refused"; reason: string } | { status: "done"; records: Measurement[] }> {
  const reason = refusal(env, plan);
  if (reason) return { status: "refused", reason };
  const records: Measurement[] = [];
  let spent = 0;
  // The OpenRouter upstream of the last response, read from its body.
  let upstream: string | null = null;
  const observed: typeof fetch = async (input, init) => {
    const response = await transport(input, init);
    try {
      upstream = ((await response.clone().json()) as any)?.provider ?? null;
    } catch {
      upstream = null;
    }
    return response;
  };
  const gateway = new ProviderGateway(env as unknown as Env, observed);
  const ledger: Ledger = {
    remaining: async () => 10_000_000,
    reserve: async () => "measurement",
    settle: async () => {},
  };
  const record = (
    base: Omit<Measurement, keyof ModelResponse | "ms" | "request" | "upstream">,
    request: number,
    ms: number,
    r: ModelResponse,
  ) => {
    // The cap needs a known cost; an unknown one stops the run.
    if (r.cost_usd === null)
      throw new Error(`cost of ${base.route} is unknown; configure MODEL_PRICES to enforce the spend cap`);
    spent += r.cost_usd;
    records.push({
      ...base,
      request,
      ms,
      input_tokens: r.input_tokens,
      cache_read_input_tokens: r.cache_read_input_tokens ?? null,
      cache_write_input_tokens: r.cache_write_input_tokens ?? null,
      output_tokens: r.output_tokens,
      usage_convention: r.usage_convention ?? null,
      cost_usd: r.cost_usd,
      cost_source: r.cost_source ?? null,
      upstream,
    });
    if (spent > plan.spendCapUsd)
      throw new Error(`spend cap of ${plan.spendCapUsd} USD reached`);
  };
  const timed = async (request: ModelRequest) => {
    const start = Date.now();
    const response = await gateway.complete(request);
    return { response, ms: Date.now() - start };
  };
  const classes = ["anthropic", "openai", "openrouter"];
  for (let repetition = 0; repetition < plan.repetitions; repetition++)
    for (const route of plan.routes) {
      const salt = `${Date.now()}-${repetition}-${route}`;
      const base = (measurement: string, variant: string) => ({
        measurement,
        route,
        variant,
        repetition,
      });
      const cache = (root: string, key = true) => ({
        classes,
        ...(key ? { key: promptCacheKey("measurement", salt, root) } : {}),
      });
      const user = (text: string): ModelRequest["messages"] => [
        {
          role: "user",
          content: [
            { layer: "context", text, cache: true },
            { layer: "assignment", text: '\nReply with {"result":[]}.' },
          ],
        },
      ];
      log(`measuring ${route}, repetition ${repetition + 1}`);
      // (a) cold, then warm 30 s later, with a salt in layer 1.
      const system = [{ layer: "system" as const, text: `${join(systemPrompt("generation"))} [${salt}]`, cache: true as const }];
      for (const [i, variant] of ["cold", "warm"].entries()) {
        if (i) await sleep(30_000);
        const { response, ms } = await timed({
          model: route,
          system,
          messages: user(context(salt)),
          max_tokens: 256,
          cache: cache("a"),
        });
        record(base("a-cold-warm", variant), i, ms, response);
      }
      // (b) a 3-turn tool conversation, (e) with a compaction checkpoint.
      for (const [measurement, compaction, size] of [
        ["b-tool-conversation", false, 4000],
        ["e-compaction", true, 70000],
      ] as const) {
        const replies: string[] = [];
        let turn = 0;
        await converse({
          gateway: {
            complete: async (request) => {
              const { response, ms } = await timed(request);
              record(base(measurement, "converse"), turn++, ms, response);
              replies.push(response.content);
              // Steer the conversation: tools twice, then a result.
              return {
                ...response,
                content:
                  turn < 3
                    ? '{"tools":[{"name":"read_file","args":{"version":"head","path":"a.ts"}}]}'
                    : '{"result":[]}',
              };
            },
          },
          ledger,
          actor: measurement,
          phase: "generation",
          model: route,
          allowance: { remaining: 10_000_000 },
          messages: user(context(`${salt}-${measurement}`)),
          dispatch: async () => "x".repeat(size),
          cache: cache(measurement),
          compaction,
        });
      }
      // (c) blind then disclosed, one system prompt (`verifier-system`).
      {
        const messages: ModelRequest["messages"] = [
          { role: "user", content: blindPrompt(context(`${salt}-c`), "measurement") },
        ];
        const blindSystem = systemPrompt("verify-blind");
        const blind = await timed({ model: route, system: blindSystem, messages, max_tokens: 256, cache: { ...cache("c"), tail: true } });
        record(base("c-blind-disclosed", "blind"), 0, blind.ms, blind.response);
        messages.push({ role: "assistant", content: '{"result":[]}' }, { role: "user", content: "Verify this hypothesis. Return {result:{evidence_level:\"plausible\",evidence:[]}}." });
        const disclosed = await timed({ model: route, system: systemPrompt("verify-disclosed", true), messages, max_tokens: 256, cache: { ...cache("c"), tail: true } });
        record(base("c-blind-disclosed", "disclosed"), 1, disclosed.ms, disclosed.response);
      }
      // (d) three voters: concurrent and cold, versus staggered after the first.
      {
        const voter = () => ({
          model: route,
          system: systemPrompt("verify-blind"),
          messages: [{ role: "user" as const, content: blindPrompt(context(`${salt}-d`), "measurement") }],
          max_tokens: 256,
          cache: cache("d"),
        });
        const concurrent = await Promise.all([0, 1, 2].map(() => timed(voter())));
        concurrent.forEach((r, i) => record(base("d-voters", "concurrent"), i, r.ms, r.response));
        const salted = { ...voter(), messages: [{ role: "user" as const, content: blindPrompt(context(`${salt}-d2`), "measurement") }] };
        const first = await timed(salted);
        record(base("d-voters", "staggered"), 0, first.ms, first.response);
        const rest = await Promise.all([1, 2].map(() => timed(salted)));
        rest.forEach((r, i) => record(base("d-voters", "staggered"), i + 1, r.ms, r.response));
      }
      // (f) two agents of one review: shared context, then the assignment.
      for (const [i, agent] of ["correctness", "tests"].entries()) {
        const parts = generationPrompt({
          agent,
          instructions: "",
          round: "",
          intent: "",
          focus: "",
          graph: "",
          changed: context(`${salt}-f`),
          checks: "",
          data: "",
          guidance: "",
          partition: "measurement",
          order: true,
        });
        const { response, ms } = await timed({ model: route, system: systemPrompt("generation"), messages: [{ role: "user", content: parts }], max_tokens: 256, cache: cache("generation") });
        record(base("f-two-agents", agent), i, ms, response);
      }
      // (h) OpenAI: the same warm request with and without `prompt_cache_key`.
      if (route.startsWith("openai/"))
        for (const keyed of [true, false])
          for (const i of [0, 1]) {
            const { response, ms } = await timed({
              model: route,
              system,
              messages: user(context(`${salt}-h-${keyed}`)),
              max_tokens: 256,
              cache: cache("h", keyed),
            });
            record(base("h-openai-key", keyed ? "key" : "no-key"), i, ms, response);
          }
    }
  // (g) is read from `upstream` on OpenRouter records; (i) from review audits
  // with `councilGaps`.
  return { status: "done", records };
}
/**
 * (i) Seconds between each council member's round-1 and round-2 answers, from a
 * review's `council/audit.json`, against the 5-minute cache lifetime.
 */
export function councilGaps(audit: {
  entries: { finding: string; member: string; round: number; at: number }[];
}) {
  const first = new Map<string, number>();
  for (const e of audit.entries)
    if (e.round === 1) first.set(`${e.finding}:${e.member}`, e.at);
  return audit.entries
    .filter((e) => e.round === 2 && first.has(`${e.finding}:${e.member}`))
    .map((e) => {
      const seconds = (e.at - first.get(`${e.finding}:${e.member}`)!) / 1000;
      return { finding: e.finding, member: e.member, seconds, within_ttl: seconds < 300 };
    });
}

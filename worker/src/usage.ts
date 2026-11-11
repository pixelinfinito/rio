import type { CostSource, Env, UsageConvention } from "./types";

import {
  INVALID_CACHE_USAGE,
  normalizeUsage as normalize,
} from "../../crates/rio-qa/controller/src/usage.mjs";

export { INVALID_CACHE_USAGE };
/** A provider's usage reduced to total input, cache reads and writes, and output. */
export interface NormalizedUsage {
  // Total input: cache reads and writes included.
  input_tokens: number;
  cache_read_input_tokens: number | null;
  cache_write_input_tokens: number | null;
  output_tokens: number;
  usage_convention: UsageConvention;
}

/**
 * Whether a route's cache counts are known to lie inside its reported input:
 * only the Anthropic Messages protocol and OpenAI's own API, where official
 * documentation and recorded fixtures agree. Every other OpenAI-protocol route
 * (OpenRouter, the unified endpoint, dynamic routes, custom providers, an
 * `OPENAI_BASE_URL`) is unverified and keeps today's charge.
 */
export function usageConvention(
  env: Env,
  identifier: string,
  protocol: "openai" | "anthropic",
  provider: string,
): Exclude<UsageConvention, "invalid"> {
  if (protocol === "anthropic") return "verified";
  const openai =
    provider === "openai" &&
    identifier.startsWith("openai/") &&
    (env.AI_GATEWAY_URL?.trim() ? true : !env.OPENAI_BASE_URL?.trim());
  return openai ? "verified" : "unverified";
}
/**
 * Normalizes reported usage with the normalizer the QA transport shares
 * (`usage.mjs`): invalid cache fields throw on a verified route and are recorded
 * as null with convention `invalid` elsewhere.
 */
export function normalizeUsage(
  protocol: "openai" | "anthropic",
  usage: any,
  convention: Exclude<UsageConvention, "invalid">,
): NormalizedUsage {
  return normalize(protocol, usage, convention);
}
/** An explicit model price in USD per million tokens (`MODEL_PRICES`). */
export interface ModelPrice {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
}
/**
 * The cost of one call: the provider's reported charge (OpenRouter
 * `usage.cost`), else an estimate from an explicit price, else unknown. Cache
 * reads and writes are priced only by their own rates: when a call used the
 * cache and the price lacks the rate, or the route's cache counts are not
 * trusted, the cost is unknown rather than priced as plain input. Invalid cache
 * fields leave cache use unknown, so their cost is unknown too.
 */
export function costOf(
  usage: NormalizedUsage,
  price: ModelPrice | undefined,
  reported?: unknown,
): { cost_usd: number | null; cost_source: CostSource } {
  if (typeof reported === "number" && Number.isFinite(reported) && reported >= 0)
    return { cost_usd: reported, cost_source: "provider" };
  if (!price) return { cost_usd: null, cost_source: "unknown" };
  const read = usage.cache_read_input_tokens ?? 0,
    write = usage.cache_write_input_tokens ?? 0;
  const cached = read > 0 || write > 0;
  if (
    usage.usage_convention === "invalid" ||
    (cached && usage.usage_convention !== "verified") ||
    (read > 0 && price.cache_read === undefined) ||
    (write > 0 && price.cache_write === undefined)
  )
    return { cost_usd: null, cost_source: "unknown" };
  const uncached = usage.input_tokens - read - write;
  return {
    cost_usd:
      (uncached * price.input +
        read * (price.cache_read ?? 0) +
        write * (price.cache_write ?? 0) +
        usage.output_tokens * price.output) /
      1000000,
    cost_source: "estimate",
  };
}
/**
 * A self-hosted member's cached-token count, passed through by the runner as
 * the endpoint's raw JSON value. Self-hosted endpoints are unverified: a valid
 * count (a safe integer from 0 to the reported input) is recorded, anything
 * else is recorded as null with convention `invalid`; the call never fails on it.
 */
export function selfHostedCache(input: number, cached: unknown) {
  if (cached === undefined || cached === null)
    return {
      cache_read_input_tokens: null,
      cache_write_input_tokens: null,
      usage_convention: "unverified" as const,
    };
  const valid =
    typeof cached === "number" &&
    Number.isSafeInteger(cached) &&
    cached >= 0 &&
    cached <= input;
  return {
    cache_read_input_tokens: valid ? (cached as number) : null,
    cache_write_input_tokens: null,
    usage_convention: valid ? ("unverified" as const) : ("invalid" as const),
  };
}
/** One `usage` row as the report reads it. */
export interface UsageRow {
  phase: string;
  status: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  usage_convention: string | null;
  cost_source: string | null;
}
/**
 * `agent_audit.prompt_cache`: per phase, what providers reported. A ratio is
 * computed only over verified calls that reported cache fields; cache totals are
 * null when no call reported them. No savings figure is derived.
 */
export function promptCacheReport(
  rows: UsageRow[],
  settings: { hint_classes: string[]; layout_features: string[] },
) {
  const phases: Record<string, any> = {};
  for (const row of rows.filter((r) => r.status === "completed")) {
    const p = (phases[row.phase] ??= {
      calls: 0,
      calls_reporting_cache: 0,
      unverified_calls: 0,
      input_tokens: 0,
      cache_read_input_tokens: null,
      cache_write_input_tokens: null,
      output_tokens: 0,
      cost_usd_by_source: {},
      read_ratio: null,
      reporting_input: 0,
      reporting_read: 0,
    });
    p.calls++;
    p.input_tokens += row.input_tokens ?? 0;
    p.output_tokens += row.output_tokens ?? 0;
    const source = row.cost_source ?? "unknown";
    p.cost_usd_by_source[source] =
      row.cost_usd === null || p.cost_usd_by_source[source] === null
        ? null
        : (p.cost_usd_by_source[source] ?? 0) + row.cost_usd;
    const reported =
      row.cache_read_tokens !== null || row.cache_write_tokens !== null;
    if (row.cache_read_tokens !== null)
      p.cache_read_input_tokens =
        (p.cache_read_input_tokens ?? 0) + row.cache_read_tokens;
    if (row.cache_write_tokens !== null)
      p.cache_write_input_tokens =
        (p.cache_write_input_tokens ?? 0) + row.cache_write_tokens;
    if (row.usage_convention === "verified" && reported) {
      p.calls_reporting_cache++;
      p.reporting_input += row.input_tokens ?? 0;
      p.reporting_read += row.cache_read_tokens ?? 0;
    } else if (
      row.usage_convention === "unverified" ||
      row.usage_convention === "invalid"
    )
      p.unverified_calls++;
  }
  for (const p of Object.values(phases)) {
    p.read_ratio =
      p.calls_reporting_cache && p.reporting_input
        ? p.reporting_read / p.reporting_input
        : null;
    delete p.reporting_input;
    delete p.reporting_read;
  }
  return { ...settings, phases };
}

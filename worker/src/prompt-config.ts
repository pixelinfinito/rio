/**
 * The review's prompt configuration (design D15): which prompt-cache hint
 * classes and layout features are enabled. Both Worker variables are parsed by
 * one function, at submission and once per review in a memoized Workflow step,
 * so a replay rebuilds identical requests and an unknown value never starts a
 * review or reaches a provider.
 */
import type { Env } from "./types";
import { invariant } from "./validation";
import { sha256Hex } from "./prompt";
import { sha256 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js";

export const HINT_CLASSES = ["anthropic", "openai", "openrouter"] as const;
export const LAYOUT_FEATURES = [
  "agent-order",
  "verifier-system",
  "compaction",
  "council-order",
  "qa-order",
] as const;
export type HintClass = (typeof HINT_CLASSES)[number];
export type LayoutFeature = (typeof LAYOUT_FEATURES)[number];
export interface PromptSettings {
  // Enabled hint classes, sorted; empty means `off`.
  cache: HintClass[];
  // Enabled layout features, sorted.
  layout: LayoutFeature[];
}
const list = (value: string | undefined) =>
  [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ].sort();
/**
 * The values used while a variable is unset. A default may enable a class or
 * feature only with a passed record in `docs/evaluation/prompt-caching-gates.json`
 * (enforced by `gates.test.ts`).
 */
export const PROMPT_DEFAULTS = { cache: "", layout: "" };
/** Parses `PROMPT_CACHE` and `PROMPT_LAYOUT`; unset means the defaults, `off` means no hints. */
export function promptSettings(
  env: Pick<Env, "PROMPT_CACHE" | "PROMPT_LAYOUT">,
): PromptSettings {
  const cache = list(env.PROMPT_CACHE ?? PROMPT_DEFAULTS.cache);
  const off = cache.length === 1 && cache[0] === "off";
  for (const value of off ? [] : cache)
    invariant(
      (HINT_CLASSES as readonly string[]).includes(value),
      `PROMPT_CACHE: unknown hint class ${value} (use off or a comma list of ${HINT_CLASSES.join(", ")})`,
    );
  const layout = list(env.PROMPT_LAYOUT ?? PROMPT_DEFAULTS.layout);
  for (const value of layout)
    invariant(
      (LAYOUT_FEATURES as readonly string[]).includes(value),
      `PROMPT_LAYOUT: unknown layout feature ${value} (use a comma list of ${LAYOUT_FEATURES.join(", ")})`,
    );
  return {
    cache: off ? [] : (cache as HintClass[]),
    layout: layout as LayoutFeature[],
  };
}
export const enabled = (settings: PromptSettings, feature: LayoutFeature) =>
  settings.layout.includes(feature);

/**
 * The OpenAI `prompt_cache_key` for one conversation root (design D9): scoped to
 * the tenant, the review and the root, with no readable identifier.
 */
export function promptCacheKey(tenant: string, review: string, root: string) {
  return sha256Hex(`rio-pck\0${tenant}\0${review}\0${root}`).slice(0, 32);
}

/**
 * The tenant's partition secret (design D14): 32 random bytes in D1, created
 * once by `INSERT OR IGNORE` and read back, so concurrent first reviews of a
 * tenant agree on one value. It is never updated, sent, logged or reported.
 */
export async function ensurePartition(env: Env, tenant: string) {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO prompt_partitions(tenant,secret) VALUES(?,?)",
  )
    .bind(tenant, bytesToHex(randomBytes(32)))
    .run();
}
export async function partitionSecret(env: Env, tenant: string) {
  const row = await env.DB.prepare(
    "SELECT secret FROM prompt_partitions WHERE tenant=?",
  )
    .bind(tenant)
    .first<{ secret: string }>();
  invariant(row, "prompt partition is missing");
  return row.secret;
}
/**
 * The provider identity a partition value is derived for: one value per tenant
 * and provider, unrelated across providers.
 */
export function providerIdentity(env: Env, identifier: string): string {
  const head = identifier.split("/", 1)[0];
  const rest = identifier.slice(head.length + 1);
  if (
    head === "openai" &&
    env.AI_GATEWAY_URL?.trim() &&
    (rest.startsWith("custom-") || rest.startsWith("dynamic/"))
  )
    return rest.startsWith("dynamic/") ? "dynamic" : "compat";
  return head;
}
/** `P = hex(HMAC-SHA256(secret, provider))[0..32]`. */
export function partitionValue(secret: string, provider: string) {
  return bytesToHex(
    hmac(sha256, hexToBytes(secret), new TextEncoder().encode(provider)),
  ).slice(0, 32);
}
/** The review's partition values by provider, and every value for redaction. */
export class Partitions {
  readonly values = new Map<string, string>();
  constructor(
    readonly env: Env,
    readonly secret: string,
  ) {}
  for(identifier: string) {
    const provider = providerIdentity(this.env, identifier);
    if (!this.values.has(provider))
      this.values.set(provider, partitionValue(this.secret, provider));
    return this.values.get(provider)!;
  }
  /** Values of every provider a review could reach; replies are redacted of all. */
  all(identifiers: string[]) {
    return [...new Set(identifiers.map((m) => this.for(m)))];
  }
}
/**
 * The body of the review's memoized `prompt-config` step: validates the switches
 * (failing before any reservation or provider request) and ensures the tenant's
 * partition secret exists. Its output, the step state, holds only the settings.
 */
export async function configureReview(
  env: Env,
  tenant: string,
): Promise<PromptSettings> {
  const settings = promptSettings(env);
  await ensurePartition(env, tenant);
  return settings;
}

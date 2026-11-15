import { env as runtime, applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  BLIND_INSTRUCTIONS,
  blindPrompt,
  generationPrompt,
  join,
  layerHashes,
  redactPartitions,
  type GenerationInputs,
} from "../src/prompt";
import {
  Partitions,
  configureReview,
  ensurePartition,
  partitionSecret,
  partitionValue,
  promptCacheKey,
  promptSettings,
  providerIdentity,
} from "../src/prompt-config";
import { ProviderGateway, systemPrompt } from "../src/gateway";
import { memberRequest } from "../src/council-pack";
import { contextHash } from "../src/cache";
import type { Env } from "../src/types";
import { allMigrations, graphs } from "./fixtures";
import { preGenerationPrompt } from "./wire/pre-template";

const blocks = (agent: string, instructions = ""): GenerationInputs => ({
  agent,
  instructions,
  round: "",
  intent: '<repository_data label="intent">["x"]</repository_data>',
  focus: '<repository_data label="suggested_focus">["a.ts"]</repository_data>',
  graph: '<repository_data label="graph excerpt">{}</repository_data>',
  changed: '<repository_data label="change diff">[]</repository_data>',
  checks: '<repository_data label="deterministic checks">[]</repository_data>',
  data: "",
  guidance: '<repository_data label="owner guidance">[]</repository_data>',
});
const SECRET = "11".repeat(32);

describe("prompt builder", () => {
  it("is pure: identical inputs give identical parts", () => {
    expect(generationPrompt(blocks("tests"))).toEqual(
      generationPrompt(blocks("tests")),
    );
    expect(blindPrompt("ctx", "p")).toEqual(blindPrompt("ctx", "p"));
  });
  it.each([
    ["without agent instructions", blocks("correctness")],
    [
      "with agent instructions, data and a lineage round",
      {
        ...blocks("contracts", "Check each consumer."),
        round: "\nThis is round 2 of a review lineage.",
        data: '\n<repository_data label="contract inventory">[]</repository_data>',
      },
    ],
  ])("joins to the pinned baseline's generation text %s", (_, b) => {
    expect(join(generationPrompt(b))).toBe(preGenerationPrompt(b));
  });
  it("keeps the blind message text and the council request text", () => {
    expect(join(blindPrompt("CONTEXT"))).toBe(`${BLIND_INSTRUCTIONS}CONTEXT`);
    const request = memberRequest("skeptic", "P", "RENDERING", 1);
    expect(request.system).toBe(join(request.parts!.system));
    expect(request.content).toBe(
      'Round 1. Your role is skeptic. Assess the finding in the hypothesis data block. Cite artifacts by their "id" values.\nRENDERING',
    );
  });
  it("inserts the partition before repository data, and nowhere else", () => {
    const text = join(generationPrompt({ ...blocks("tests"), partition: "p".repeat(32) }));
    expect(text).toBe(
      preGenerationPrompt(blocks("tests")).replace(
        "Return {result:hypotheses[]}.",
        `Return {result:hypotheses[]}.\n<review_partition id="${"p".repeat(32)}"/>`,
      ),
    );
    expect(join(blindPrompt("CONTEXT", "v"))).toBe(
      `${BLIND_INSTRUCTIONS}<review_partition id="v"/>\nCONTEXT`,
    );
  });
  it("records layer hashes and sizes, never text", () => {
    const layers = layerHashes(systemPrompt("generation"), [
      { content: generationPrompt({ ...blocks("tests"), partition: "v" }) },
      { content: '{"tool_results":[]}' },
    ]);
    expect(layers.map((l) => l.layer)).toEqual([
      "system",
      "partition",
      "context",
      "assignment",
      "conversation",
    ]);
    for (const l of layers) {
      expect(l.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(l.bytes).toBeGreaterThan(0);
    }
    expect(JSON.stringify(layers)).not.toContain("repository_data");
  });
});

describe("prompt switches", () => {
  it.each([
    [{}, { cache: [], layout: [] }],
    [{ PROMPT_CACHE: "", PROMPT_LAYOUT: "" }, { cache: [], layout: [] }],
    [{ PROMPT_CACHE: "off" }, { cache: [], layout: [] }],
    [{ PROMPT_CACHE: "openai" }, { cache: ["openai"], layout: [] }],
    [
      { PROMPT_CACHE: " openrouter,anthropic ,anthropic" },
      { cache: ["anthropic", "openrouter"], layout: [] },
    ],
    [
      { PROMPT_LAYOUT: "verifier-system" },
      { cache: [], layout: ["verifier-system"] },
    ],
    [
      { PROMPT_LAYOUT: "qa-order,agent-order,compaction,council-order,verifier-system" },
      {
        cache: [],
        layout: ["agent-order", "compaction", "council-order", "qa-order", "verifier-system"],
      },
    ],
  ])("parses %j", (env, expected) => {
    expect(promptSettings(env)).toEqual(expected);
  });
  it.each([
    [{ PROMPT_CACHE: "anthropic,gemini" }, "gemini"],
    [{ PROMPT_CACHE: "off,openai" }, "off"],
    [{ PROMPT_LAYOUT: "agent-order,fast" }, "fast"],
  ])("rejects %j naming the value", (env, value) => {
    expect(() => promptSettings(env)).toThrow(value);
  });
  it("scopes the OpenAI cache key to tenant, review and root without readable ids", () => {
    const key = promptCacheKey("acme", "review-1", "verify:h1");
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(key).not.toBe(promptCacheKey("other", "review-1", "verify:h1"));
    expect(key).not.toBe(promptCacheKey("acme", "review-1", "verify:h2"));
    expect(key).toBe(promptCacheKey("acme", "review-1", "verify:h1"));
  });
});

describe("tenant partition", () => {
  beforeAll(async () => {
    await applyD1Migrations(runtime.DB, allMigrations);
  });
  it("keeps the shared layers identical across tenants and diverges at the partition", () => {
    const a = generationPrompt({ ...blocks("tests"), partition: partitionValue(SECRET, "openai"), order: true });
    const b = generationPrompt({ ...blocks("tests"), partition: partitionValue("22".repeat(32), "openai"), order: true });
    expect(a[0]).toEqual(b[0]);
    expect(a[0].layer).toBe("instructions");
    expect(a[1].layer).toBe("partition");
    expect(a[1].text).not.toBe(b[1].text);
    expect(a.slice(2)).toEqual(b.slice(2));
  });
  it("derives one value per provider that reveals neither the tenant nor the secret", () => {
    const env = { AI_GATEWAY_URL: "https://g.example/v1/a/g" } as Env;
    const p = new Partitions(env, SECRET);
    const value = p.for("openai/gpt-test");
    expect(value).toMatch(/^[0-9a-f]{32}$/);
    expect(p.for("openai/other-model")).toBe(value);
    expect(p.for("anthropic/claude")).not.toBe(value);
    expect(SECRET).not.toContain(value);
    expect(providerIdentity(env, "openai/dynamic/route")).toBe("dynamic");
    expect(providerIdentity(env, "openai/custom-x/m")).toBe("compat");
    expect(providerIdentity({} as Env, "openai/custom-x/m")).toBe("openai");
  });
  it("fails the configuration step on a switch changed after submission, before anything is written", async () => {
    const env = { ...(runtime as unknown as Env), PROMPT_LAYOUT: "fast" };
    await expect(configureReview(env, "late-change")).rejects.toThrow("fast");
    expect(
      await runtime.DB.prepare("SELECT 1 FROM prompt_partitions WHERE tenant=?")
        .bind("late-change")
        .first(),
    ).toBeNull();
    const settings = await configureReview(
      { ...(runtime as unknown as Env), PROMPT_CACHE: "openai", PROMPT_LAYOUT: "" },
      "late-change",
    );
    // The step output (Workflow state) holds the settings and nothing secret.
    expect(settings).toEqual({ cache: ["openai"], layout: [] });
  });
  it("creates one secret per tenant when first reviews race", async () => {
    const env = runtime as unknown as Env;
    await Promise.all([ensurePartition(env, "racing"), ensurePartition(env, "racing")]);
    await ensurePartition(env, "racing");
    const rows = await runtime.DB.prepare(
      "SELECT secret FROM prompt_partitions WHERE tenant=?",
    )
      .bind("racing")
      .all<{ secret: string }>();
    expect(rows.results).toHaveLength(1);
    expect(await partitionSecret(env, "racing")).toBe(rows.results[0].secret);
    expect(rows.results[0].secret).toMatch(/^[0-9a-f]{64}$/);
    await ensurePartition(env, "other-tenant");
    expect(await partitionSecret(env, "other-tenant")).not.toBe(
      rows.results[0].secret,
    );
  });
  it("replaces an echoed partition value before the reply leaves the gateway", async () => {
    const value = partitionValue(SECRET, "openai");
    const gateway = new ProviderGateway({ OPENAI_API_KEY: "k" } as Env, (async () =>
      Response.json({
        choices: [{ message: { content: `{"result":[{"message":"id ${value} seen"}]}` } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      })) as typeof fetch);
    const response = await gateway.complete({
      model: "openai/gpt-test",
      system: "s",
      messages: [{ role: "user", content: "m" }],
      max_tokens: 10,
      redact: [value],
    });
    expect(response.content).toBe('{"result":[{"message":"id [partition] seen"}]}');
  });
  it("replaces a partition value written with JSON escapes, which parsing would decode", () => {
    const value = partitionValue(SECRET, "openai");
    const escaped = [...value]
      .map((c, i) =>
        i % 2 ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()}`,
      )
      .join("");
    const content = redactPartitions(`{"message":"id ${escaped} seen"}`, [value]);
    expect(JSON.parse(content).message).toBe("id [partition] seen");
  });
  it("leaves the result-cache hash independent of the partition but not of the layout", async () => {
    const hunk = {
      path: "src/a.ts",
      old_path: "src/a.ts",
      base: { start: 1, count: 1 },
      head: { start: 1, count: 1 },
      text: "",
    };
    const inputs = {
      agent: "tests",
      manifest_version: 1,
      prompt: "",
      model: "openai/gpt-test",
      options: {},
      engine: "0",
      graphs,
      guidance: [],
      read: async () => "x",
      base_graph: true,
    };
    const plain = await contextHash(hunk, inputs);
    expect(await contextHash(hunk, { ...inputs, layout: [] })).toBe(plain);
    expect(await contextHash(hunk, { ...inputs, layout: ["agent-order"] })).not.toBe(plain);
  });
});

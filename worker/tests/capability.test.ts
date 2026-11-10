import { describe, expect, it } from "vitest";
import {
  ProviderGateway,
  cacheCapability,
  gatewayProviders,
  renderPrompt,
} from "../src/gateway";
import { join, type PromptPart } from "../src/prompt";
import type { Env } from "../src/types";

const GATEWAY = {
  AI_GATEWAY_URL: "https://gateway.example/v1/a/g",
  AI_GATEWAY_TOKEN: "t",
};
const env = (extra: Partial<Env> = {}) =>
  ({
    ANTHROPIC_API_KEY: "k",
    OPENAI_API_KEY: "k",
    OPENROUTER_API_KEY: "k",
    ...GATEWAY,
    AI_GATEWAY_PROVIDERS: JSON.stringify({
      node: { protocol: "openai" },
      claude: { protocol: "anthropic", prompt_cache: "breakpoints" },
      plain: { protocol: "anthropic" },
    }),
    ...extra,
  }) as Env;
const ALL = ["anthropic", "openai", "openrouter"];

describe("prompt-cache capability per route", () => {
  it("derives the capability table from static rules", () => {
    const routes = [
      "anthropic/claude-sonnet-5-5",
      "openai/gpt-5.6",
      "openrouter/anthropic/claude-sonnet-5-5",
      "openrouter/google/gemini-3-pro",
      "openrouter/deepseek/deepseek-v4",
      "compat/custom-node/m",
      "dynamic/support",
      "custom-plain/m",
      "custom-claude/claude-sonnet-5-5",
      "custom-node/m",
      "openai/dynamic/support",
    ];
    expect(routes.map((r) => cacheCapability(env(), r, ALL))).toEqual([
      "breakpoints",
      "key",
      "parts",
      "parts",
      "none",
      "none",
      "none",
      "none",
      "breakpoints",
      "none",
      "none",
    ]);
  });
  it("uses none for every route whose class is off", () => {
    for (const r of ["anthropic/c", "openai/g", "openrouter/anthropic/c", "custom-claude/c"])
      expect(cacheCapability(env(), r, [])).toBe("none");
    expect(cacheCapability(env(), "anthropic/c", ["openai"])).toBe("none");
  });
  it("sends no key to an OPENAI_BASE_URL server", () => {
    expect(
      cacheCapability(
        { OPENAI_API_KEY: "k", OPENAI_BASE_URL: "http://localhost:8080/v1" } as Env,
        "openai/local-model",
        ["openai"],
      ),
    ).toBe("none");
    expect(cacheCapability({ OPENAI_API_KEY: "k" } as Env, "openai/gpt", ["openai"])).toBe("key");
  });
  it("accepts a breakpoint declaration only on an Anthropic-protocol provider", () => {
    expect(() =>
      gatewayProviders({
        AI_GATEWAY_PROVIDERS: JSON.stringify({
          node: { protocol: "openai", prompt_cache: "breakpoints" },
        }),
      } as Env),
    ).toThrow("prompt_cache");
    expect(() =>
      gatewayProviders({
        AI_GATEWAY_PROVIDERS: JSON.stringify({
          node: { protocol: "anthropic", prompt_cache: "always" },
        }),
      } as Env),
    ).toThrow("prompt_cache");
  });
  it("sends breakpoints to a declared custom Anthropic provider", async () => {
    let body: any;
    const gateway = new ProviderGateway(env(), (async (url: unknown, init: any) => {
      expect(String(url)).toBe("https://gateway.example/v1/a/g/custom-claude/messages");
      body = JSON.parse(init.body);
      return Response.json({
        content: [{ type: "text", text: "{}" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }) as typeof fetch);
    await gateway.complete({
      model: "custom-claude/claude-sonnet-5-5",
      system: "S",
      messages: [{ role: "user", content: [{ layer: "context", text: "C", cache: true }] }],
      max_tokens: 10,
      cache: { classes: ["anthropic"] },
    });
    expect(body.system).toEqual([
      { type: "text", text: "S", cache_control: { type: "ephemeral" } },
    ]);
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "C", cache_control: { type: "ephemeral" } },
    ]);
  });
});

describe("breakpoint rendering", () => {
  const part = (text: string, cache?: true): PromptPart => ({
    layer: "context",
    text,
    ...(cache ? { cache } : {}),
  });
  it("never sends more than four markers and drops the oldest message markers first", () => {
    const messages = Array.from({ length: 5 }, (_, i) => ({
      role: "user" as const,
      content: [part(`m${i}a`, true), part(`m${i}b`)],
    }));
    const rendered = renderPrompt(
      { system: "S", messages, cache: { classes: ALL, tail: true } },
      "breakpoints",
    );
    const marked = rendered.messages.flatMap((m: any) =>
      Array.isArray(m.content)
        ? m.content.filter((b: any) => b.cache_control).map((b: any) => b.text)
        : [],
    );
    expect(1 + marked.length).toBe(4);
    // The newest markers (including the tail) survive.
    expect(marked.at(-1)).toBe("m4b");
    expect(marked).not.toContain("m0a");
  });
  it("joins to exactly the plain-string text and never sends an empty block", () => {
    const content = [part("A"), part("", true), part("B", true), part("C")];
    const rendered = renderPrompt(
      { system: [{ layer: "system", text: "S", cache: true }], messages: [{ role: "user", content }] },
      "breakpoints",
    );
    const blocks = rendered.messages[0].content as any[];
    expect(blocks.map((b) => b.text).join("")).toBe(join(content));
    expect(blocks.every((b) => b.text.length > 0)).toBe(true);
    expect(renderPrompt({ system: "S", messages: [{ role: "user", content }] }, "none"))
      .toEqual({ system: "S", messages: [{ role: "user", content: "ABC" }] });
  });
});

describe("rendering with screenshots", () => {
  const image = { data: "cG5n", media_type: "image/png" as const, token_bound: 10 };
  const request = {
    system: "S",
    messages: [
      { role: "user" as const, content: "Blind context.", images: [image, image] },
      { role: "assistant" as const, content: "{}" },
      { role: "user" as const, content: "Disclosure." },
    ],
    cache: { classes: ALL, first: true, tail: true },
  };
  it("moves the first message's marker onto its last screenshot on Anthropic", () => {
    const blind = renderPrompt(request, "breakpoints", true).messages[0].content as any[];
    expect(blind.map((b) => b.type)).toEqual(["text", "image", "image"]);
    expect(blind.map((b) => !!b.cache_control)).toEqual([false, false, true]);
  });
  it("renders images after the text with no marker on OpenAI routes", () => {
    for (const capability of ["key", "none"] as const) {
      const blind = renderPrompt(request, capability, false).messages[0].content as any[];
      expect(blind).toEqual([
        { type: "text", text: "Blind context." },
        { type: "image_url", image_url: { url: "data:image/png;base64,cG5n", detail: "high" } },
        { type: "image_url", image_url: { url: "data:image/png;base64,cG5n", detail: "high" } },
      ]);
    }
    const parts = renderPrompt(request, "parts", false).messages[0].content as any[];
    expect(parts.filter((b) => b.type === "image_url").every((b) => !b.cache_control)).toBe(true);
    expect(parts[0].text).toBe("Blind context.");
  });
});

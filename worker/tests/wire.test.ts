import { describe, expect, it } from "vitest";
import { ROUTES, captureAll } from "./wire/scenarios";

// Pre-change request bodies (task 0.1), captured with the pinned baseline's
// generation template (`node scripts/capture-wire.mjs pre '{"frozen":true}'`).
// Each later directory records one deliberate change and is compared with the
// fixture before it, so a prompt change and a wire change are tested apart.
const pre = import.meta.glob("./fixtures/wire/pre/*.json", {
  eager: true,
  import: "default",
}) as Record<string, unknown>;
const partition = import.meta.glob("./fixtures/wire/partition/*.json", {
  eager: true,
  import: "default",
}) as Record<string, unknown>;
const features = {
  "verifier-system": import.meta.glob("./fixtures/wire/verifier-system/*.json", { eager: true, import: "default" }),
  "agent-order": import.meta.glob("./fixtures/wire/agent-order/*.json", { eager: true, import: "default" }),
  "council-order": import.meta.glob("./fixtures/wire/council-order/*.json", { eager: true, import: "default" }),
} as Record<string, Record<string, unknown>>;
/** The scenario each layout feature may change; the others stay as in `partition/`. */
const SCOPE: Record<string, string> = {
  "verifier-system": "voter",
  "agent-order": "generation",
  "council-order": "council",
};
const hints = import.meta.glob("./fixtures/wire/hints/*.json", {
  eager: true,
  import: "default",
}) as Record<string, unknown>;
const fixture = (dir: Record<string, unknown>, name: string) =>
  Object.entries(dir).find(([path]) => path.endsWith(`/${name}.json`))?.[1];
const same = (actual: unknown, expected: unknown, message: string) =>
  expect(JSON.stringify(actual, null, 2), message).toBe(
    JSON.stringify(expected, null, 2),
  );
const ELEMENT = /\n<review_partition id="[0-9a-f]{32}"\/>(?=\n)|<review_partition id="[0-9a-f]{32}"\/>\n/g;
/** Every string of a fixture with the partition element removed. */
function withoutPartition(value: unknown): unknown {
  if (typeof value === "string") return value.replace(ELEMENT, "");
  if (Array.isArray(value)) return value.map(withoutPartition);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, withoutPartition(v)]),
    );
  return value;
}

describe("wire fixtures", () => {
  it("covers every route class", () => {
    expect(Object.keys(pre)).toHaveLength(ROUTES.length);
    expect(Object.keys(partition)).toHaveLength(ROUTES.length);
  });
  it("regenerates the pre-change bodies byte for byte from the frozen template", async () => {
    const captured = await captureAll({ frozen: true });
    for (const r of ROUTES)
      same(captured[r.name], fixture(pre, r.name), `${r.name} differs from pre`);
  });
  it("builds the pre-change bodies with every feature off and no partition", async () => {
    const captured = await captureAll();
    for (const r of ROUTES)
      same(captured[r.name], fixture(pre, r.name), `${r.name} differs from pre`);
  });
  it("adds exactly the partition line to the pre-change bodies", async () => {
    const captured = await captureAll({ partition: true });
    const values = new Map<string, string>();
    for (const r of ROUTES) {
      same(captured[r.name], fixture(partition, r.name), `${r.name} snapshot`);
      same(
        withoutPartition(captured[r.name]),
        fixture(pre, r.name),
        `${r.name}: more than the partition line changed`,
      );
      const text = JSON.stringify(captured[r.name]);
      const found = new Set(
        [...text.matchAll(/review_partition id=\\"([0-9a-f]{32})\\"/g)].map(
          (m) => m[1],
        ),
      );
      // Generation, blind and council requests each carry one value per route.
      expect(found.size, r.name).toBe(1);
      expect(
        text.match(/review_partition/g)!.length,
        r.name,
      ).toBeGreaterThanOrEqual(3);
      values.set(r.name, [...found][0]);
    }
    // One provider, one value; different providers, different values.
    expect(values.get("anthropic-direct")).toBe(values.get("anthropic-gateway"));
    expect(values.get("openai-direct")).toBe(values.get("openai-gateway"));
    expect(values.get("anthropic-direct")).not.toBe(values.get("openai-direct"));
    expect(values.get("custom-anthropic")).not.toBe(values.get("custom-openai"));
  });
  it.each(Object.keys(SCOPE))(
    "records %s as a change of its own scenario only",
    async (feature) => {
      const captured = await captureAll({ partition: true, layout: [feature] });
      for (const r of ROUTES) {
        const snapshot = fixture(features[feature], r.name) as any;
        same(captured[r.name], snapshot, `${feature} ${r.name} snapshot`);
        const before = fixture(partition, r.name) as any;
        for (const scenario of ["generation", "voter", "council"]) {
          if (scenario === SCOPE[feature]) {
            // The feature changes this scenario's text, not how many
            // requests it makes.
            expect(snapshot[scenario].length).toBe(before[scenario].length);
            expect(JSON.stringify(snapshot[scenario])).not.toBe(
              JSON.stringify(before[scenario]),
            );
          } else
            same(snapshot[scenario], before[scenario], `${feature} changed ${scenario}`);
        }
      }
    },
  );
  describe("with every hint class enabled", () => {
    const ALL = ["anthropic", "openai", "openrouter"];
    let captured: Record<string, any>;
    const bodies = (name: string) =>
      Object.values(captured[name]).flat().map((c: any) => c.body);
    /** System text and the ordered role and text of each message. */
    const logical = (body: any) => {
      const text = (c: any) =>
        typeof c === "string" ? c : c.map((b: any) => b.text).join("");
      const anthropic = body.system !== undefined;
      return {
        system: text(anthropic ? body.system : body.messages[0].content),
        messages: (anthropic ? body.messages : body.messages.slice(1)).map(
          (m: any) => ({ role: m.role, text: text(m.content) }),
        ),
      };
    };
    const markers = (body: any) =>
      (JSON.stringify(body).match(/"cache_control"/g) ?? []).length;
    it("matches its recorded snapshot", async () => {
      captured = await captureAll({ partition: true, cache: ALL });
      for (const r of ROUTES)
        same(captured[r.name], fixture(hints, r.name), `${r.name} hints snapshot`);
    });
    it.each([
      "openai-base-url",
      "openrouter-deepseek",
      "compat",
      "dynamic",
      "openai-dynamic",
      "custom-anthropic",
      "custom-openai",
    ])("sends today's plain-string body on %s", (name) => {
      same(captured[name], fixture(partition, name), `${name} gained a cache field`);
    });
    it.each(["anthropic-direct", "anthropic-gateway"])(
      "marks at most four breakpoints on %s without changing the text",
      (name) => {
        const before = Object.values(fixture(partition, name) as any)
          .flat()
          .map((c: any) => c.body);
        bodies(name).forEach((body, i) => {
          expect(logical(body)).toEqual(logical(before[i]));
          expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
          // A single-shot council call marks only its system prompt (D7).
          expect(markers(body)).toBeGreaterThanOrEqual(1);
          expect(markers(body)).toBeLessThanOrEqual(4);
          expect(JSON.stringify(body)).not.toMatch(/"ttl"|prompt_cache_key/);
          expect(body.cache_control).toBeUndefined();
        });
      },
    );
    it.each(["openai-direct", "openai-gateway"])(
      "adds only a scoped prompt_cache_key on %s",
      (name) => {
        const before = Object.values(fixture(partition, name) as any).flat() as any[];
        const sent = Object.values(captured[name]).flat() as any[];
        sent.forEach((c, i) => {
          const { prompt_cache_key, ...rest } = c.body;
          expect(prompt_cache_key).toMatch(/^[0-9a-f]{32}$/);
          same(rest, before[i].body, `${name} changed more than the key`);
          expect(c.body).not.toHaveProperty("prompt_cache_retention");
          expect(c.body).not.toHaveProperty("prompt_cache_options");
        });
        // One key per conversation root: generation, the hypothesis's voters, the member.
        const keys = (scenario: string) =>
          new Set(captured[name][scenario].map((c: any) => c.body.prompt_cache_key));
        expect(keys("generation").size).toBe(1);
        expect(keys("voter").size).toBe(1);
        expect([...keys("voter")][0]).not.toBe([...keys("generation")][0]);
        expect([...keys("council")][0]).not.toBe([...keys("generation")][0]);
      },
    );
    it("marks the conversation tail of every Anthropic multi-turn request", () => {
      for (const body of [
        ...captured["anthropic-direct"].generation,
        ...captured["anthropic-direct"].voter,
      ].map((c: any) => c.body)) {
        const last = body.messages.at(-1).content;
        expect(last.at(-1).cache_control).toEqual({ type: "ephemeral" });
      }
    });
    it("marks content parts on OpenRouter Anthropic models only", () => {
      const before = Object.values(fixture(partition, "openrouter-anthropic") as any)
        .flat()
        .map((c: any) => c.body);
      bodies("openrouter-anthropic").forEach((body, i) => {
        expect(logical(body)).toEqual(logical(before[i]));
        expect(Array.isArray(body.messages[0].content)).toBe(true);
        expect(body.messages[0].content.at(-1).cache_control).toEqual({ type: "ephemeral" });
        expect(body.provider).toEqual({ require_parameters: true });
        expect(body).not.toHaveProperty("prompt_cache_key");
        expect(body).not.toHaveProperty("session_id");
        expect(markers(body)).toBeLessThanOrEqual(4);
      });
    });
    it("keeps the response-cache bypass on every gateway request", () => {
      for (const r of ROUTES)
        for (const c of Object.values(captured[r.name]).flat() as any[])
          if (c.url.startsWith("https://gateway.ai.cloudflare.com")) {
            expect(c.headers["cf-aig-skip-cache"]).toBe("true");
            expect(c.headers["cf-aig-collect-log"]).toBe("false");
            expect(c.headers).not.toHaveProperty("cf-aig-cache-key");
            expect(c.headers).not.toHaveProperty("cf-aig-cache-ttl");
          }
    });
  });
});

describe("layout switch matrix", () => {
  // Every combination of layout features: a scenario's bodies are those of its
  // own feature's snapshot when that feature is on, else the all-off ones, so
  // features compose without touching each other's requests. `compaction`
  // changes only conversations above 160 KB and `qa-order` only QA prompts.
  const ALL = ["agent-order", "compaction", "council-order", "qa-order", "verifier-system"];
  const combinations = Array.from({ length: 1 << ALL.length }, (_, mask) =>
    ALL.filter((_, i) => mask & (1 << i)),
  );
  it("covers all 32 combinations", () => expect(combinations).toHaveLength(32));
  it.each(combinations.map((c) => [c.join(",") || "(none)", c] as const))(
    "%s",
    async (_, layout) => {
      const captured = await captureAll({ partition: true, layout: [...layout] });
      for (const r of ROUTES)
        for (const scenario of ["generation", "voter", "council"]) {
          const owner = Object.keys(SCOPE).find(
            (f) => SCOPE[f] === scenario && layout.includes(f),
          );
          const expected = (fixture(owner ? features[owner] : partition, r.name) as any)[
            scenario
          ];
          same(captured[r.name][scenario], expected, `${r.name} ${scenario}`);
        }
    },
  );
});

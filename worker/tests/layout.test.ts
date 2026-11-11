import { describe, expect, it } from "vitest";
import {
  ProviderGateway,
  RECENT_TOOL_RESULTS,
  converse,
  elideOldToolResults,
  tokenBound,
  type Ledger,
} from "../src/gateway";
import { verifyHypothesis } from "../src/verifier";
import { generationPrompt, join, type GenerationInputs } from "../src/prompt";
import { Tools } from "../src/tools";
import type { Env, Gateway, ModelRequest, Profile, Vote } from "../src/types";
import { graphs, hypothesis, profile, snapshot } from "./fixtures";

const ledger = (): Ledger => ({
  remaining: async () => 10_000_000,
  reserve: async () => "r",
  settle: async () => {},
});
/** System text and the ordered role and text of each message. */
function logical(body: any) {
  const text = (c: any) =>
    typeof c === "string" ? c : c.map((b: any) => b.text).join("");
  const messages = body.system !== undefined ? body.messages : body.messages.slice(1);
  const system = body.system !== undefined ? body.system : body.messages[0].content;
  return [
    { role: "system", text: text(system) },
    ...messages.map((m: any) => ({ role: m.role, text: text(m.content) })),
  ];
}
const startsWith = (later: unknown[], earlier: unknown[]) =>
  expect(later.slice(0, earlier.length)).toEqual(earlier);

describe("verifier-system", () => {
  const single: Profile = { ...profile, verify: { voters: 1, quorum: 1 } };
  async function voter(
    on: boolean,
    save = async (_: Vote) => {},
    verifyTokens?: number,
  ) {
    const requests: ModelRequest[] = [];
    const gateway: Gateway = {
      async complete(request) {
        requests.push(structuredClone({ ...request, signal: undefined }));
        const disclosed = request.messages.length > 2 ||
          request.messages.some((m) => join(m.content).includes("Verify this hypothesis."));
        return {
          content: JSON.stringify({
            result: disclosed ? { evidence_level: "plausible", evidence: [] } : [],
          }),
          input_tokens: 10,
          output_tokens: 5,
          cost_usd: null,
        };
      },
    };
    const result = await verifyHypothesis({
      profile: single,
      hypothesis,
      intent: "Fix behavior",
      guidance: [],
      snapshot,
      context: { snapshot, head: graphs.head, executions: {}, guidance: [] },
      gateway,
      ledger: ledger(),
      tools: () => new Tools(snapshot, graphs, undefined),
      verifyTokens,
      save,
      prompt: { partition: "p".repeat(32), single: on },
    });
    return { requests, result };
  }
  // Message text only: the shared system prompt states the hypothesis item
  // schema (its property names), never a hypothesis.
  const textOf = (r: ModelRequest) =>
    r.messages.map((m) => join(m.content)).join("\n");
  it("keeps one system prompt and appends the disclosure to the blind conversation", async () => {
    const { requests } = await voter(true);
    expect(requests).toHaveLength(2);
    const [blind, disclosed] = requests;
    expect(join(disclosed.system)).toBe(join(blind.system));
    startsWith(
      disclosed.messages.map((m) => join(m.content)),
      blind.messages.map((m) => join(m.content)),
    );
    expect(disclosed.messages).toHaveLength(blind.messages.length + 2);
    const last = join(disclosed.messages.at(-1)!.content);
    expect(last).toContain("Verification result schema:");
    expect(last).toContain(hypothesis.rule_id);
    // Nothing of the hypothesis or the vote schema reaches a blind request.
    expect(join(blind.system)).not.toContain("Verification result schema:");
    for (const secret of [
      "Verification result schema:",
      hypothesis.message,
      hypothesis.rule_id,
      '"trigger"',
      hypothesis.impact,
    ])
      expect(textOf(blind)).not.toContain(secret);
  });
  it("keeps the per-phase system prompts while off", async () => {
    const { requests } = await voter(false);
    const [blind, disclosed] = requests;
    expect(join(blind.system)).toContain("item schema:");
    expect(join(disclosed.system)).toContain("Verification result schema:");
    expect(join(disclosed.messages.at(-1)!.content)).not.toContain(
      "Verification result schema:",
    );
    startsWith(
      disclosed.messages.map((m) => join(m.content)),
      blind.messages.map((m) => join(m.content)),
    );
    expect(textOf(blind)).not.toContain(hypothesis.message);
  });
  it("falls back to the separate disclosed prompt when the shared one would not fit", async () => {
    const bound = (r: ModelRequest) => tokenBound(r.system, r.messages);
    const [blind, shared] = (await voter(true)).requests;
    const separate = (await voter(false)).requests[1];
    expect(bound(shared) - bound(separate)).toBeGreaterThan(1000);
    // After the blind turn's 15 tokens, room for the blind turn and the
    // separate disclosed form, not the shared one.
    const room = Math.max(bound(blind), bound(separate)) + 100;
    expect(room).toBeLessThan(bound(shared));
    const { requests, result } = await voter(true, undefined, room + 15);
    expect(result.votes[0].status).toBe("completed");
    // The separate form exactly, with a smaller output allowance.
    expect({ ...requests[1], max_tokens: 0 }).toEqual({ ...separate, max_tokens: 0 });
  });
  it("never builds a disclosure when saving the blind vote fails", async () => {
    let saves = 0;
    const { requests } = await voter(true, async () => {
      if (saves++ === 0) throw new Error("save failed");
    });
    expect(requests).toHaveLength(1);
    expect(textOf(requests[0])).not.toContain(hypothesis.rule_id);
  });
});

describe("agent-order", () => {
  const base: GenerationInputs = {
    agent: "correctness",
    instructions: "",
    round: "",
    intent: '<repository_data label="intent">["x"]</repository_data>',
    focus: '<repository_data label="suggested_focus">["src/a.ts"]</repository_data>',
    graph: '<repository_data label="graph excerpt">{}</repository_data>',
    changed: '<repository_data label="changed code excerpts">[1]</repository_data>',
    checks: '<repository_data label="deterministic checks">[]</repository_data>',
    data: "",
    guidance: '<repository_data label="owner guidance">["keep"]</repository_data>',
    partition: "p".repeat(32),
    order: true,
  };
  const assignmentStart = (parts: ReturnType<typeof generationPrompt>) =>
    join(parts.slice(0, parts.findIndex((p) => p.layer === "assignment")));
  it("shares everything up to the assignment between agents of one scope", () => {
    const correctness = generationPrompt(base);
    const tests = generationPrompt({ ...base, agent: "tests", instructions: "Check tests." });
    expect(assignmentStart(correctness)).toBe(assignmentStart(tests));
    expect(join(correctness)).not.toBe(join(tests));
    expect(correctness.map((p) => p.layer)).toEqual([
      "instructions",
      "partition",
      "context",
      "assignment",
    ]);
    // The review context is the cached layer.
    expect(correctness.find((p) => p.cache)?.layer).toBe("context");
  });
  it("puts specialist data only in the assignment", () => {
    const data = '\n<repository_data label="catalog">[]</repository_data>\n<repository_data label="taint map">[]</repository_data>';
    const security = generationPrompt({ ...base, agent: "security", data });
    expect(security.find((p) => p.layer === "assignment")!.text).toContain("taint map");
    expect(assignmentStart(security)).not.toContain("taint map");
    expect(join(generationPrompt(base))).not.toContain("taint map");
  });
  it("diverges at the first differing review-context block for a narrowed scope", () => {
    const full = join(generationPrompt(base));
    const narrowed = join(
      generationPrompt({
        ...base,
        changed: '<repository_data label="changed code excerpts">[2]</repository_data>',
      }),
    );
    let i = 0;
    while (full[i] === narrowed[i]) i++;
    expect(full.slice(0, i)).toContain('label="graph excerpt"');
    expect(full.slice(0, i)).not.toContain("[1]");
  });
  it("keeps guidance a data block, never system text", () => {
    const parts = generationPrompt(base);
    expect(parts.every((p) => p.layer !== "system")).toBe(true);
    expect(join(parts)).toContain('<repository_data label="owner guidance">');
  });
});

describe("compaction", () => {
  const big = (n: number) =>
    JSON.stringify({ tool_results: [{ name: "read_file", result: "x".repeat(n) }] });
  const conversation = (sizes: number[]) => {
    const messages: ModelRequest["messages"] = [{ role: "user", content: "review" }];
    for (const size of sizes)
      messages.push(
        { role: "assistant", content: '{"tools":[{"name":"read_file","args":{}}]}' },
        { role: "user", content: big(size) },
      );
    return messages;
  };
  const HIGH = 160 * 1024,
    LOW = 96 * 1024;
  it("does nothing below the high-water mark", () => {
    const messages = conversation([50000, 50000, 50000]);
    const before = structuredClone(messages);
    expect(elideOldToolResults(messages, HIGH, LOW)).toBe(0);
    expect(messages).toEqual(before);
  });
  it("elides oldest first down to the low-water mark in one checkpoint, then not again", () => {
    const messages = conversation([40000, 40000, 40000, 40000, 40000]);
    const before = structuredClone(messages);
    expect(elideOldToolResults(messages, HIGH, LOW)).toBe(3);
    // The prefix is identical up to the first elided message.
    expect(messages.slice(0, 2)).toEqual(before.slice(0, 2));
    expect(join(messages[2].content)).toContain("tool_results_elided");
    expect(messages.slice(-2 * RECENT_TOOL_RESULTS + 1).filter((m) => m.role === "user"))
      .toEqual(before.slice(-2 * RECENT_TOOL_RESULTS + 1).filter((m) => m.role === "user"));
    // A 20 KB result on the next turn stays under the high-water mark: no churn.
    messages.push(
      { role: "assistant", content: '{"tools":[{"name":"read_file","args":{}}]}' },
      { role: "user", content: big(20000) },
    );
    const after = structuredClone(messages);
    expect(elideOldToolResults(messages, HIGH, LOW)).toBe(0);
    expect(messages).toEqual(after);
  });
  it("keeps today's elision while off: just under 160 KB", () => {
    const messages = conversation([40000, 40000, 40000, 40000, 40000]);
    expect(elideOldToolResults(messages)).toBe(1);
  });
  it("records the checkpoint with the next model call", async () => {
    const replies = [
      ...Array.from({ length: 5 }, () => '{"tools":[{"name":"read_file","args":{}}]}'),
      '{"result":[]}',
    ];
    const records: any[] = [];
    await converse({
      gateway: {
        complete: async () => ({
          content: replies.shift()!,
          input_tokens: 1,
          output_tokens: 1,
          cost_usd: null,
        }),
      },
      ledger: ledger(),
      actor: "a",
      phase: "generation",
      model: "openai/m",
      allowance: { remaining: 10_000_000 },
      messages: [{ role: "user", content: "review" }],
      dispatch: async () => "x".repeat(40000),
      compaction: true,
      call: async (_, action) => {
        const response = await action();
        records.push(response);
        return response;
      },
    });
    const checkpoints = records.filter((r) => r.compaction);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].compaction.elided).toBeGreaterThan(0);
  });
});

describe("append-only conversations on every capability", () => {
  const ROUTES: [string, Partial<Env>, string[]][] = [
    ["anthropic/claude-test", { ANTHROPIC_API_KEY: "k" }, ["anthropic"]],
    ["openai/gpt-test", { OPENAI_API_KEY: "k" }, ["openai"]],
    ["openrouter/anthropic/claude-test", { OPENROUTER_API_KEY: "k" }, ["openrouter"]],
    ["openrouter/deepseek/d", { OPENROUTER_API_KEY: "k" }, []],
  ];
  it.each(ROUTES)("%s", async (model, env, classes) => {
    const bodies: any[] = [];
    const replies = [
      // A batch over the tool limit, a malformed reply, then a transient failure.
      JSON.stringify({
        tools: Array.from({ length: 10 }, () => ({ name: "read_file", args: {} })),
      }),
      "<invoke>not the protocol</invoke>",
      "RETRY",
      '{"tools":[{"name":"search","args":{}}]}',
      '{"result":[]}',
    ];
    const anthropic = model.startsWith("anthropic/");
    const gateway = new ProviderGateway(env as Env, (async (_: unknown, init: any) => {
      bodies.push(JSON.parse(init.body));
      const reply = replies.shift()!;
      if (reply === "RETRY") return new Response("busy", { status: 529 });
      return Response.json(
        anthropic
          ? { content: [{ type: "text", text: reply }], usage: { input_tokens: 1, output_tokens: 1 } }
          : { choices: [{ message: { content: reply } }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      );
    }) as typeof fetch);
    await converse({
      gateway,
      ledger: ledger(),
      actor: "a",
      phase: "generation",
      model,
      allowance: { remaining: 10_000_000 },
      messages: [
        {
          role: "user",
          content: generationPrompt({
            agent: "tests",
            instructions: "",
            round: "",
            intent: "I",
            focus: "F",
            graph: "G",
            changed: "C",
            checks: "K",
            data: "",
            guidance: "D",
            partition: "p".repeat(32),
            order: true,
          }),
        },
      ],
      dispatch: async () => "file",
      cache: { classes, key: "k".repeat(32) },
    });
    // The 529 attempt and its retry are byte-identical.
    const retried = bodies.findIndex((_, i) => i > 0 && JSON.stringify(bodies[i]) === JSON.stringify(bodies[i - 1]));
    expect(retried).toBeGreaterThan(0);
    const turns = bodies.filter((_, i) => i !== retried);
    for (let i = 1; i < turns.length; i++)
      startsWith(logical(turns[i]), logical(turns[i - 1]));
    // Tool results stay scrubbed `{"tool_results": …}` JSON messages.
    const last = logical(turns.at(-1));
    expect(last.filter((m) => m.text.startsWith('{"tool_results":')).length).toBe(2);
    expect(last.some((m) => m.text.includes("tool batch limited to 8"))).toBe(true);
  }, 30000);
});

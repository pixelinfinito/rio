import { describe, it, expect, vi } from "vitest";
import {
  ProviderGateway,
  Refused,
  PAUSE_SLICE_MS,
  RATE_LIMIT_PAUSES_MS,
  RETRY_PAUSES_MS,
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
it("executes identical duplicated provider tool JSON once and rejects a result before it", async () => {
  const tool = JSON.stringify({
    tools: [
      { name: "read_file", args: { version: "head", path: 'a\"}\\.ts' } },
    ],
  });
  expect(parseModelOutput(`${tool} \n\n${tool}`)).toEqual(JSON.parse(tool));
  for (const invalid of [
    `{"result":[]} ${tool}`,
    `${tool} ${tool} trailing words that are no stray characters at all`,
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
it("records a turn's snapshot tool calls so a replay does not run them again", async () => {
  // A workflow replays its code after every interruption. The FreeCAD reviews
  // ran every earlier search of every voter again on each replay, in the
  // isolate that then ran out of memory.
  const replies = [
    {
      tools: [
        { name: "search", args: { pattern: "needle" } },
        { name: "run", args: { command: ["true"], version: "head" } },
        { name: "read_file", args: { path: "a.ts", version: "head" } },
      ],
    },
    {
      tools: Array.from({ length: 10 }, (_, i) => ({
        name: "read_file",
        args: { path: `f${i}.ts`, version: "head" },
      })),
    },
    { tools: [{ name: "read_file", args: { path: "missing.ts" } }] },
    { result: [] },
  ];
  const ledger: Ledger = {
    remaining: async () => 100000,
    reserve: async () => "id",
    settle: async () => {},
  };
  // Durable step results, as a workflow keeps them across replays.
  const steps = new Map<string, unknown>();
  const durable = async <T>(id: string, action: () => Promise<T>) => {
    if (!steps.has(id)) steps.set(id, await action());
    return steps.get(id) as T;
  };
  const conversation = async (recorded: boolean) => {
    const ran: string[] = [];
    let turn = 0;
    const messages = [{ role: "user" as const, content: "review" }];
    const result = await converse({
      gateway: {
        complete: async () => ({
          content: JSON.stringify(replies[turn++]),
          input_tokens: 80,
          output_tokens: 50,
          cost_usd: null,
        }),
      },
      ledger,
      actor: "voter",
      phase: "verify-blind",
      model: "openrouter/openai/gpt-6.1-sol",
      allowance: { remaining: 16000 },
      messages,
      dispatch: async (name, args) => {
        ran.push(name);
        if (args.path === "missing.ts") throw new Error("file not found");
        return { name, args };
      },
      ...(recorded
        ? {
            call: (id, action) => durable(`model-${id}`, action),
            record: (id, action) => durable(`tools-${id}`, action),
          }
        : {}),
    });
    return { result, ran, messages };
  };
  const plain = await conversation(false);
  const first = await conversation(true);
  expect(first.messages).toEqual(plain.messages);
  // The same calls; a turn's snapshot calls now run before its runner job.
  expect([...first.ran].sort()).toEqual([...plain.ran].sort());
  expect(first.ran.slice(0, 3)).toEqual(["search", "read_file", "run"]);
  expect(first.ran.length).toBe(2 + 1 + 8 + 1);
  // One step a turn, named for the turn; the batch limit and tool errors are
  // answered as before.
  expect([...steps.keys()].filter((k) => k.startsWith("tools-"))).toEqual([
    "tools-voter-verify-blind-0",
    "tools-voter-verify-blind-1",
    "tools-voter-verify-blind-2",
  ]);
  expect(first.messages[4].content).toContain("tool batch limited to 8 calls");
  expect(first.messages[6].content).toContain("file not found");
  const replay = await conversation(true);
  expect(replay.result).toEqual([]);
  expect(replay.messages).toEqual(plain.messages);
  // Only the runner job is asked for again; its own steps answer it.
  expect(replay.ran).toEqual(["run"]);
});
it("starts a turn's searches together inside its recorded step and answers in the order asked", async () => {
  // One pass over the tree answers the searches asked together; one after the
  // other, each of them read the whole tree.
  const replies = [
    {
      tools: [
        { name: "search", args: { pattern: "a" } },
        { name: "read_file", args: { path: "a.ts", version: "head" } },
        { name: "search", args: { pattern: "b" } },
        { name: "search", args: { pattern: "refused" } },
      ],
    },
    { result: [] },
  ];
  const conversation = async (recorded: boolean) => {
    const events: string[] = [];
    let turn = 0;
    const messages = [{ role: "user" as const, content: "review" }];
    await converse({
      gateway: {
        complete: async () => ({
          content: JSON.stringify(replies[turn++]),
          input_tokens: 80,
          output_tokens: 50,
          cost_usd: null,
        }),
      },
      ledger: {
        remaining: async () => 100000,
        reserve: async () => "id",
        settle: async () => {},
      },
      actor: "agent",
      phase: "generation",
      model: "openrouter/openai/gpt-6.1-sol",
      allowance: { remaining: 16000 },
      messages,
      dispatch: async (name, args) => {
        const call = args.pattern ?? args.path;
        events.push(`start ${call}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        events.push(`end ${call}`);
        if (call === "refused") throw new Error("search was not run");
        return { found: call };
      },
      ...(recorded
        ? { call: (_, action) => action(), record: (_, action) => action() }
        : {}),
    });
    return { events, messages };
  };
  const recorded = await conversation(true);
  expect(recorded.events.slice(0, 3)).toEqual([
    "start a",
    "start b",
    "start refused",
  ]);
  // The other calls still run one at a time.
  expect(recorded.events.indexOf("start a.ts")).toBeGreaterThan(
    recorded.events.indexOf("end a"),
  );
  const results = JSON.parse(recorded.messages[2].content).tool_results;
  expect(results).toEqual([
    { name: "search", result: { found: "a" } },
    { name: "read_file", result: { found: "a.ts" } },
    { name: "search", result: { found: "b" } },
    { name: "search", error: "search was not run" },
  ]);
  // Without a step to record them, calls run in the order asked, as before.
  const plain = await conversation(false);
  expect(plain.messages).toEqual(recorded.messages);
  expect(plain.events.slice(0, 4)).toEqual([
    "start a",
    "end a",
    "start a.ts",
    "end a.ts",
  ]);
});
it("asks once more for the protocol after a reply that is not a request and gives up after the repair limit", async () => {
  const xml =
    'I will read the file first.\n<invoke name="read_file">\n<parameter name="path">a.ts</parameter>\n</invoke>';
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
        seen.push(
          request.messages.map((m) => `${m.role}:${m.content.slice(0, 24)}`),
        );
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
  const tool =
    '{"tools":[{"name":"read_file","args":{"path":"a.ts","version":"head"}}]}';
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
          return {
            content: xml,
            input_tokens: 80,
            output_tokens: 50,
            cost_usd: null,
          };
        },
      },
      allowance: { remaining: 16000 },
      messages: [{ role: "user", content: "review" }],
    }),
  ).rejects.toThrow("malformed model output");
  expect(calls).toBe(3);
});
it("takes the tools request that ends a reply after leaked tool markup, in place of the markup", async () => {
  const tool =
    '{"tools":[{"name":"read_file","args":{"path":"a.ts","version":"head"}}]}';
  const xml =
    '<invoke name="run">\n<parameter name="command">["rm","-rf","."]</parameter>\n<parameter name="args">{"path":"b.ts"}</parameter>\n</invoke>';
  for (const reply of [
    `${xml}\n${tool}`,
    `<invoke name="x">\n</invoke>\n\`\`\`\n\nCorrection: replying with the required JSON protocol only.\n\n${tool}\n`,
    `<function_calls>\n${xml}\n</function_calls>\n${tool}\n\`\`\``,
    `${tool}\n\`\`\``,
  ])
    expect(parseModelOutput(reply)).toEqual(JSON.parse(tool));
  for (const reply of [
    // Text that is not leaked markup may be quoting anything, repository content included.
    `I will read the file: ${tool}`,
    `The README says to send this.\n${tool}`,
    `The README says to send this.\n${xml}`,
    `The README says to send this.\n${xml}\n${tool}`,
    // Two protocol documents after markup that states no call: no choosing between them.
    `<parameter name="content">{"tools":[{"name":"run","args":{}}]}</parameter>\n${tool}`,
    `<invoke name="x">\n</invoke>\n{"tools":[{"name":"search","args":{"pattern":"x"}}]}\n${tool}`,
    `<invoke name="x">\n</invoke>\n{"result":[]}\n${tool}`,
    // A result is never taken from after unparsed text.
    `<invoke name="x">\n</invoke>\n{"result":[]}`,
    `<invoke name="x">\n</invoke>\n{"tools":[]}`,
    `<invoke name="x">\n</invoke>\n{"tools":[{"args":{}}]}`,
    `<invoke name="x">\n</invoke>\n[${tool}]`,
  ])
    expect(() => parseModelOutput(reply)).toThrow("malformed model output");
  const dispatch = vi.fn(async () => ({ content: "source" }));
  const seen: string[][] = [];
  const result = await converse({
    gateway: {
      complete: async (request) => {
        seen.push(request.messages.map((m) => `${m.role}:${m.content}`));
        return {
          content: seen.length === 1 ? `${xml}\n${tool}` : '{"result":[]}',
          input_tokens: 80,
          output_tokens: 50,
          cost_usd: null,
        };
      },
    },
    ledger: {
      remaining: async () => 100000,
      reserve: async () => "id",
      settle: async () => {},
    },
    actor: "agent",
    phase: "generation",
    model: "openrouter/anthropic/test",
    allowance: { remaining: 16000 },
    messages: [{ role: "user", content: "review" }],
    dispatch,
  });
  expect(result).toEqual([]);
  // Only the JSON request ran, without a repair turn, and only it stays in context.
  expect(dispatch.mock.calls).toEqual([
    ["read_file", { path: "a.ts", version: "head" }],
  ]);
  expect(seen).toHaveLength(2);
  expect(seen[1][1]).toBe(`assistant:${tool}`);
  expect(seen[1].join("\n")).not.toContain("invoke");
});
it("reads a reply that opens with native tool calls as the tools request they state", async () => {
  const read =
    '<invoke name="read_file">\n<parameter name="path">src/a.ts</parameter>\n<parameter name="version">head</parameter>\n<parameter name="line_start">100</parameter>\n<parameter name="line_end"> 140 </parameter>\n</invoke>';
  const search =
    '<invoke name="search">\n<parameter name="pattern">fn <T>(a: &[u8]) -> "x"</parameter>\n<parameter name="scope">src/**/*.rs</parameter>\n</invoke>';
  const tools = [
    {
      name: "read_file",
      args: {
        path: "src/a.ts",
        version: "head",
        line_start: 100,
        line_end: 140,
      },
    },
    {
      name: "search",
      args: { pattern: 'fn <T>(a: &[u8]) -> "x"', scope: "src/**/*.rs" },
    },
  ];
  for (const reply of [
    `${read}\n${search}`,
    `\n${read}\n${search}\n`,
    `<function_calls>\n${read}\n${search}\n</function_calls>`,
    // The batch repeated up to the output limit runs once; a call cut off is not run.
    `${read}\n${search}\n\n\n\n${read}\n${search}\n\n\n\n${read}\n<invoke name="search">\n<parameter name="pattern">fn <T`,
    `${read}\n${search}\n<invoke name="search">\n<parameter name="pattern">other</parameter>\nand then prose`,
    `${read}\n${search}\n<invo`,
    // What follows the calls is dropped: stray tags, prose, results the model made up.
    `${read}\n${search}\n</invoke>\n</invoke>\n</invoke>`,
    `${read}\n${search}\n<br>\n\n\n<invoke name="search">\n<parameter name="pattern">later</parameter>\n</invoke>`,
    `${read}\n${search}\n</tools>\n\nWait, my response must be a single JSON object.`,
    `${read}\n${search}\n\n{"tool_results":[{"name":"read_file","result":"made up"}]}\n{"result":[{"rule_id":"made/up"}]}`,
    // A stop sequence takes the last closing tag with it.
    `${read}\n${search.slice(0, -"</invoke>".length)}`,
  ])
    expect(parseModelOutput(reply)).toEqual({ tools });
  // Values keep their text unless the tool takes a number or an argv array.
  expect(
    parseModelOutput(
      '<invoke name="run">\n<parameter name="command">["cargo", "test", "-p", "x"]</parameter>\n<parameter name="version">head</parameter>\n</invoke>\n<invoke name="graph_query">\n<parameter name="path">a.rs</parameter>\n<parameter name="symbol">123</parameter>\n<parameter name="hops">2</parameter>\n<parameter name="max_nodes">many</parameter>\n</invoke>\n<invoke name="read_file">\n<parameter name="path">b.rs</parameter>\n<parameter name="line_end">415, </parameter>\n</invoke>\n<invoke name="run">\n<parameter name="command">[not json</parameter>\n</invoke>',
    ),
  ).toEqual({
    tools: [
      {
        name: "run",
        args: { command: ["cargo", "test", "-p", "x"], version: "head" },
      },
      {
        name: "graph_query",
        args: { path: "a.rs", symbol: "123", hops: 2, max_nodes: "many" },
      },
      { name: "read_file", args: { path: "b.rs", line_end: "415, " } },
      { name: "run", args: { command: "[not json" } },
    ],
  });
  // The protocol's own `args` object in one parameter is that object.
  expect(
    parseModelOutput(
      '<invoke name="read_file">\n<parameter name="args">{"path":"a.ts","version":"head"}</parameter>\n</invoke>',
    ),
  ).toEqual({
    tools: [{ name: "read_file", args: { path: "a.ts", version: "head" } }],
  });
  for (const reply of [
    // Markup that states no call, or a reply that only quotes markup.
    '<invoke name="tool_placeholder">\n</invoke>',
    "<invoke>not the protocol</invoke>",
    '<invoke name="search">\n<parameter name="pattern">cut off',
    '<invoke name="search">\n<parameter name="pattern">x</parameter>\nprose inside the call</invoke>',
    `The file says:\n${read}`,
    `<parameter name="path">a.ts</parameter>\n${read}`,
  ])
    expect(() => parseModelOutput(reply)).toThrow("malformed model output");
  const dispatch = vi.fn(async () => ({ content: "source" }));
  const seen: string[][] = [];
  const stops: unknown[] = [];
  const result = await converse({
    gateway: {
      complete: async (request) => {
        seen.push(request.messages.map((m) => `${m.role}:${m.content}`));
        stops.push(request.stop);
        return {
          content:
            seen.length === 1
              ? `${read}\n${search}\n\n{"result":[{"rule_id":"made/up"}]}`
              : '{"result":[]}',
          input_tokens: 80,
          output_tokens: 50,
          cost_usd: null,
        };
      },
    },
    ledger: {
      remaining: async () => 100000,
      reserve: async () => "id",
      settle: async () => {},
    },
    actor: "agent",
    phase: "generation",
    model: "openrouter/anthropic/test",
    allowance: { remaining: 16000 },
    messages: [{ role: "user", content: "review" }],
    dispatch,
  });
  // The calls ran as stated, without a repair turn; the result written after
  // them was not taken, and the conversation keeps the request as the protocol
  // document, not the markup.
  expect(result).toEqual([]);
  expect(dispatch.mock.calls).toEqual(tools.map((t) => [t.name, t.args]));
  expect(seen).toHaveLength(2);
  expect(seen[1][1]).toBe(`assistant:${JSON.stringify({ tools })}`);
  expect(seen[1].join("\n")).not.toContain("invoke");
  expect(seen[1].join("\n")).not.toContain("made/up");
  // Every turn asks the route to end a reply after its first batch of native calls.
  expect(stops).toEqual([
    ["</invoke>\n\n", "</invoke>\n</invoke>"],
    ["</invoke>\n\n", "</invoke>\n</invoke>"],
  ]);
});
it("sends stop sequences only to Claude models, in the route's protocol", async () => {
  const sent: any[] = [];
  const transport = async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    sent.push(body);
    return Response.json(
      String(url).endsWith("/messages")
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
  const provider = new ProviderGateway(
    {
      OPENAI_API_KEY: "key",
      ANTHROPIC_API_KEY: "key",
      OPENROUTER_API_KEY: "key",
    } as Env,
    transport as typeof fetch,
  );
  const stop = ["</invoke>\n\n"];
  for (const model of [
    "anthropic/claude-test",
    "openrouter/anthropic/claude-test",
    "openai/gpt-test",
    "openrouter/deepseek/d",
  ])
    await provider.complete({ ...request, model, stop });
  await provider.complete({ ...request, model: "anthropic/claude-test" });
  await provider.complete({
    ...request,
    model: "anthropic/claude-test",
    stop: [],
  });
  expect(sent.map((body) => [body.stop_sequences, body.stop])).toEqual([
    [stop, undefined],
    [undefined, stop],
    [undefined, undefined],
    [undefined, undefined],
    [undefined, undefined],
    [undefined, undefined],
  ]);
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
  const replies = [
    "null",
    "[]",
    single,
    '{"tools":[null]}',
    '{"tools":[]}',
    JSON.stringify({ tools }),
    '{"result":[]}',
  ];
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
    expect(sent[i].content).toMatch(
      /^Your previous reply was not the protocol/,
    );
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
        return {
          content: '{"result":[]}',
          input_tokens: 80,
          output_tokens: 50,
          cost_usd: null,
        };
      },
    },
  };
  await converse({
    ...base,
    allowance: { remaining: 400000 },
    messages: [{ role: "user", content: "review" }],
  });
  await converse({
    ...base,
    allowance: { remaining: 20000 },
    messages: [{ role: "user", content: "review" }],
  });
  expect(seen[0]).toBe(16384);
  expect(seen[1]).toBeLessThan(16384);
  expect(seen[1]).toBeGreaterThan(0);
});
it("elides tool results older than the most recent ones once the history exceeds its budget", () => {
  const big = JSON.stringify({
    tool_results: [{ name: "read_file", result: "x".repeat(50000) }],
  });
  const messages = [
    { role: "user" as const, content: "review" },
    {
      role: "assistant" as const,
      content: '{"tools":[{"name":"read_file","args":{}}]}',
    },
    { role: "user" as const, content: big },
    {
      role: "assistant" as const,
      content: '{"tools":[{"name":"read_file","args":{}}]}',
    },
    { role: "user" as const, content: big },
    {
      role: "assistant" as const,
      content: '{"tools":[{"name":"read_file","args":{}}]}',
    },
    { role: "user" as const, content: big },
    {
      role: "assistant" as const,
      content: '{"tools":[{"name":"read_file","args":{}}]}',
    },
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
  const response = await new ProviderGateway(
    env,
    flaky as typeof fetch,
  ).complete(request);
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
    new ProviderGateway(env, alwaysOverloaded as typeof fetch).complete(
      request,
    ),
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
  // The request bound counts the system prompt and its item schema too.
  const allowance = { remaining: 9500 };
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
  expect(allowance.remaining).toBe(4500);
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
  const profile = (
    models: Record<string, string>,
    steps: any[],
    verify: any = {},
  ) => ({ models, steps, verify: { voters: 3, quorum: 2, ...verify } }) as any;
  const agentsStep = (agents: any[] = [], uses = "rio/agents@0.1.0") => ({
    id: "a",
    uses,
    needs: [],
    with: {},
    agents,
  });
  const verify = { id: "v", uses: "rio/verify@0.1.0", needs: [], with: {} };
  const set = (p: any) => [...reachableAliases(p)].sort();
  // No model step: nothing is called.
  expect(set(profile({ default: "x/y" }, []))).toEqual([]);
  expect(
    set(profile({ default: "x/y", verifier: "x/z" }, [agentsStep(), verify])),
  ).toEqual(["default", "verifier"]);
  // Agent-named aliases are reachable unless every agents step overrides them.
  const models = {
    default: "x/y",
    correctness: "x/c",
    security: "x/s",
    fast: "x/f",
  };
  expect(set(profile(models, [agentsStep()]))).toEqual([
    "correctness",
    "default",
  ]);
  expect(
    set(profile(models, [agentsStep([{ correctness: { model: "fast" } }])])),
  ).toEqual(["default", "fast"]);
  expect(
    set(profile(models, [agentsStep([{ correctness: { model: "missing" } }])])),
  ).toEqual(["default"]);
  expect(set(profile(models, [agentsStep([], "rio/security@0.2.0")]))).toEqual([
    "security",
  ]);
  // Every defined alias of a declaration's `models` is called; with none
  // defined the agent falls back as without the list.
  expect(
    set(
      profile(models, [
        agentsStep([
          { correctness: { models: ["default", "fast", "missing"] } },
        ]),
      ]),
    ),
  ).toEqual(["default", "fast"]);
  expect(
    set(
      profile(models, [agentsStep([{ correctness: { models: ["missing"] } }])]),
    ),
  ).toEqual(["correctness", "default"]);
  expect(set(profile(models, [verify], { model: "fast" }))).toEqual(["fast"]);
});

it.each(["openai", "anthropic"])(
  "sends QA screenshots as %s image content, without internal budget fields",
  async (provider) => {
    let body: any;
    const gateway = new ProviderGateway(
      { OPENAI_API_KEY: "key", ANTHROPIC_API_KEY: "key" } as Env,
      (async (_url, init) => {
        body = JSON.parse(init!.body as string);
        return Response.json(
          provider === "anthropic"
            ? {
                content: [{ type: "text", text: '{"result":[]}' }],
                usage: { input_tokens: 10, output_tokens: 5 },
              }
            : {
                choices: [{ message: { content: '{"result":[]}' } }],
                usage: { prompt_tokens: 10, completion_tokens: 5 },
              },
        );
      }) as typeof fetch,
    );
    await gateway.complete({
      ...request,
      model: `${provider}/test`,
      messages: [
        {
          role: "user",
          content: "captured evidence",
          images: [
            { data: "cG5n", media_type: "image/png", token_bound: 4000 },
          ],
        },
      ],
    });
    const content = body.messages.at(-1).content;
    expect(content[0]).toEqual({ type: "text", text: "captured evidence" });
    expect(content[1]).toEqual(
      provider === "anthropic"
        ? {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "cG5n" },
          }
        : {
            type: "image_url",
            image_url: { url: "data:image/png;base64,cG5n", detail: "high" },
          },
    );
    expect(JSON.stringify(body)).not.toContain("token_bound");
  },
);
it("asks for a model under a Daybreak tier when the identifier names one", async () => {
  const env = {
    AI_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/acct/rio/",
    AI_GATEWAY_TOKEN: "gateway-token",
    AI_GATEWAY_PROVIDERS: JSON.stringify({
      "node-openai": { protocol: "openai" },
      "node-anthropic": { protocol: "anthropic" },
    }),
  } as Env;
  const blue = route(env, "openai/custom-node-openai/gpt-6-sol@daybreak-blue");
  expect([blue.model, blue.cyber]).toEqual([
    "custom-node-openai/gpt-6-sol",
    "daybreak_blue",
  ]);
  expect(route(env, "custom-node-openai/gpt-6-sol@daybreak-red").cyber).toBe(
    "daybreak_red",
  );
  expect(route(env, "custom-node-openai/gpt-6-sol").cyber).toBeUndefined();
  expect(() =>
    route(env, "custom-node-anthropic/claude-opus-5-5@daybreak-blue"),
  ).toThrow("OpenAI-protocol");
  const sent: any[] = [];
  const transport = async (_url: unknown, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return Response.json({
      choices: [{ message: { content: '{"result":[]}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
  };
  const provider = new ProviderGateway(env, transport as typeof fetch);
  await provider.complete({
    ...request,
    model: "custom-node-openai/gpt-6-sol@daybreak-blue",
  });
  await provider.complete({ ...request, model: "custom-node-openai/gpt-6-sol" });
  expect(sent.map((body) => [body.model, body.access_programs])).toEqual([
    ["gpt-6-sol", { cyber: "daybreak_blue" }],
    ["gpt-6-sol", undefined],
  ]);
});
it("tells a conversation its remaining turns and ends at its own limit", async () => {
  const ledger: Ledger = {
    remaining: async () => 1000000,
    reserve: async () => "id",
    settle: async () => {},
  };
  const run = async (answerAt: number) => {
    const messages = [{ role: "user" as const, content: "audit" }];
    let turn = 0;
    const result = converse({
      gateway: {
        complete: async () => ({
          content:
            turn++ === answerAt
              ? '{"result":["done"]}'
              : '{"tools":[{"name":"read_file","args":{"path":"a.ts"}}],"notes":"kept"}',
          input_tokens: 80,
          output_tokens: 50,
          cost_usd: null,
        }),
      },
      ledger,
      actor: "security",
      phase: "generation",
      model: "openrouter/openai/gpt-6.1-sol",
      allowance: { remaining: 1000000 },
      messages,
      dispatch: async () => ({ content: "source" }),
      maxTurns: 3,
      turnNotice: true,
    });
    return { result, messages };
  };
  const answered = await run(2);
  expect(await answered.result).toEqual(["done"]);
  const told = answered.messages
    .filter((m) => m.role === "user")
    .slice(1)
    .map((m) => String(m.content));
  expect(told[0]).toMatch(/^\{"tool_results":.*\nHost: 2 turns left; keep the last one for the result\.$/s);
  expect(told[1]).toContain("Host: this is your last turn.");
  // The model's notes stay in its own reply, which compaction never removes.
  expect(String(answered.messages[1].content)).toContain('"notes":"kept"');
  await expect((await run(9)).result).rejects.toThrow("turn limit exhausted");
});
it("accepts one JSON document followed by a few stray characters, and prose only after a tools request", () => {
  const tools = '{"tools":[{"name":"read_file","args":{"path":"a.ts"}}],"notes":"n"}';
  for (const tail of ["i\n", "_\u4e45\u4e45\u7231\n", " \u05d9\u05d9\u10d2\n"])
    expect(parseModelOutput(tools + tail)).toEqual(JSON.parse(tools));
  // A tools request may be followed by any prose; a result may not.
  for (const prose of [` and then "quoted" text {braces}`, ` ${"x".repeat(41)}`])
    expect(parseModelOutput(tools + prose)).toEqual(JSON.parse(tools));
  const result = '{"result":["done"]}';
  for (const invalid of [
    `${result} and then "quoted" text`,
    `${result} ${"x".repeat(41)}`,
    `prose ${result} i`,
  ])
    expect(() => parseModelOutput(invalid)).toThrow("malformed");
});
it("runs a tools request that the same reply follows with a premature result", () => {
  const tools = '{"tools":[{"name":"read_file","args":{"path":"a.ts"}}],"notes":"n"}';
  const result = '{"result":{"hypotheses":[],"assessed":[],"unassessed":[]}}';
  expect(parseModelOutput(tools + result)).toEqual(JSON.parse(tools));
  expect(parseModelOutput(`${tools}\n${result}\n`)).toEqual(JSON.parse(tools));
  // A result first is refused.
  expect(() => parseModelOutput(result + tools)).toThrow("malformed");
});
it("runs the first of several tools requests written in one reply", () => {
  const tools = '{"tools":[{"name":"read_file","args":{"path":"a.ts"}}],"notes":"n"}';
  const later = '{"tools":[{"name":"search","args":{"pattern":"x"}}],"notes":"m"}';
  const result = '{"result":{"hypotheses":[],"assessed":[],"unassessed":[]}}';
  // The later requests were written without the results of the first.
  for (const reply of [tools + later, `${tools}\n${later}\n${later}`, tools + later + result])
    expect(parseModelOutput(reply)).toEqual(JSON.parse(tools));
  expect(() => parseModelOutput(result + tools + later)).toThrow("malformed");
});
it("tells the model why a result was refused, and says how many tool turns ran", async () => {
  const ledger: Ledger = {
    remaining: async () => 1000000,
    reserve: async () => "id",
    settle: async () => {},
  };
  const replies = [
    '{"result":{"unassessed":["V1.1"]}}',
    '{"tools":[{"name":"read_file","args":{"path":"a.ts"}}]}',
    '{"result":{"unassessed":["V1.1"]}}',
  ];
  const messages = [{ role: "user" as const, content: "audit" }];
  const seen: number[] = [];
  const result = await converse({
    gateway: {
      complete: async () => ({
        content: replies.shift()!,
        input_tokens: 80,
        output_tokens: 50,
        cost_usd: null,
      }),
    },
    ledger,
    actor: "security",
    phase: "generation",
    model: "openrouter/openai/gpt-6.1-sol",
    allowance: { remaining: 1000000 },
    messages,
    dispatch: async () => ({ content: "source" }),
    validateResult: (value, state) => {
      seen.push(state.toolTurns);
      if (!state.toolTurns) throw new Refused("unread", "Read the code first.");
      return value;
    },
  });
  expect(result).toEqual({ unassessed: ["V1.1"] });
  expect(seen).toEqual([0, 1]);
  // The refusal's own words reach the model, not the general repair request.
  expect(messages[2]).toEqual({ role: "user", content: "Read the code first." });
});
it("sends the reasoning effort a model identifier asks for", async () => {
  const env = {
    AI_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/acct/rio/",
    AI_GATEWAY_TOKEN: "gateway-token",
    AI_GATEWAY_PROVIDERS: JSON.stringify({
      "node-openai": { protocol: "openai" },
      "node-anthropic": { protocol: "anthropic" },
    }),
  } as Env;
  const both = route(env, "openai/custom-node-openai/gpt-6-sol@daybreak-blue@effort-high");
  expect([both.model, both.cyber, both.effort]).toEqual([
    "custom-node-openai/gpt-6-sol",
    "daybreak_blue",
    "high",
  ]);
  expect(route(env, "custom-node-openai/gpt-6-sol").effort).toBeUndefined();
  expect(() =>
    route(env, "custom-node-anthropic/claude-opus-5-5@effort-high"),
  ).toThrow("OpenAI-protocol");
  const sent: any[] = [];
  const transport = async (_url: unknown, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return Response.json({
      choices: [{ message: { content: '{"result":[]}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
  };
  const provider = new ProviderGateway(env, transport as typeof fetch);
  await provider.complete({ ...request, model: "custom-node-openai/gpt-6-sol@effort-xhigh" });
  await provider.complete({ ...request, model: "custom-node-openai/gpt-6-sol" });
  expect(sent.map((body) => [body.model, body.reasoning_effort])).toEqual([
    ["gpt-6-sol", "xhigh"],
    ["gpt-6-sol", undefined],
  ]);
});
it("runs a repeated tools request once, with a premature result or stray characters after it", () => {
  const tools = '{"tools":[{"name":"read_file","args":{"path":"a.ts"}}],"notes":"n"}';
  const result = '{"result":{"hypotheses":[],"assessed":[],"unassessed":[]}}';
  expect(parseModelOutput(tools + tools + result)).toEqual(JSON.parse(tools));
  expect(parseModelOutput(`${tools}${tools} יי\n`)).toEqual(
    JSON.parse(tools),
  );
  expect(() => parseModelOutput(result + result + tools)).toThrow("malformed");
});
it("sends a turn once more when its call timed out or was refused, and only when asked", async () => {
  const ledger: Ledger = {
    remaining: async () => 1000000,
    reserve: async () => "id",
    settle: async () => {},
  };
  const run = (failure: string, retryCall: boolean) => {
    const ids: string[] = [];
    let calls = 0;
    const result = converse({
      gateway: {
        complete: async () => {
          if (calls++ === 0) throw new Error(failure);
          return {
            content: '{"result":["done"]}',
            input_tokens: 80,
            output_tokens: 50,
            cost_usd: null,
          };
        },
      },
      ledger,
      actor: "security",
      phase: "generation",
      model: "openrouter/openai/gpt-6.1-sol",
      allowance: { remaining: 1000000 },
      messages: [{ role: "user" as const, content: "audit" }],
      dispatch: async () => ({ content: "source" }),
      call: async (id, action) => {
        ids.push(id);
        return action();
      },
      retryCall,
    });
    return { result, ids };
  };
  const timed = run("The operation was aborted due to timeout", true);
  await expect(timed.result).resolves.toEqual(["done"]);
  expect(timed.ids).toEqual([
    "security-generation-0",
    "security-generation-0-again",
  ]);
  await expect(
    run("provider failed (400 invalid_prompt)", true).result,
  ).resolves.toEqual(["done"]);
  await expect(run("token budget exhausted", true).result).rejects.toThrow(
    "token budget exhausted",
  );
  await expect(
    run("The operation was aborted due to timeout", false).result,
  ).rejects.toThrow("timeout");
});
it("sends a turn up to three more times, after growing pauses, while the provider fails it with a 5xx", async () => {
  vi.useFakeTimers();
  try {
    const run = (
      failures: number,
      error = "provider failed (503)",
      cancelled = async () => false,
    ) => {
      const ids: string[] = [];
      const settled: number[] = [];
      let calls = 0;
      const result = converse({
        gateway: {
          complete: async () => {
            if (calls++ < failures) throw new Error(error);
            return {
              content: '{"result":["done"]}',
              input_tokens: 80,
              output_tokens: 50,
              cost_usd: null,
            };
          },
        },
        ledger: {
          remaining: async () => 1000000,
          reserve: async () => "id",
          settle: async (_, usage) => {
            settled.push(usage.input_tokens + usage.output_tokens);
          },
        },
        actor: "security",
        phase: "generation",
        model: "openrouter/openai/gpt-6.1-sol",
        allowance: { remaining: 1000000 },
        messages: [{ role: "user" as const, content: "audit" }],
        dispatch: async () => ({ content: "source" }),
        call: async (id, action) => {
          ids.push(id);
          return action();
        },
        cancelled,
        retryCall: true,
      });
      result.catch(() => {});
      return { result, ids, settled };
    };
    const all = RETRY_PAUSES_MS.reduce((a, b) => a + b, 0);
    const twice = run(2);
    await vi.advanceTimersByTimeAsync(RETRY_PAUSES_MS[0]);
    await expect(twice.result).resolves.toEqual(["done"]);
    expect(twice.ids.at(-1)).toBe("security-generation-0-third");
    const four = run(4);
    await vi.advanceTimersByTimeAsync(all);
    await expect(four.result).resolves.toEqual(["done"]);
    expect(four.ids).toEqual([
      "security-generation-0",
      "security-generation-0-again",
      "security-generation-0-third",
      "security-generation-0-fourth",
      "security-generation-0-fifth",
    ]);
    // Each failed attempt's reservation is released; the answer is charged.
    expect(four.settled).toEqual([0, 0, 0, 0, 130]);
    const always = run(9);
    await vi.advanceTimersByTimeAsync(all);
    await expect(always.result).rejects.toThrow("provider failed (503)");
    expect(always.ids).toHaveLength(5);
    // A failure that is not the provider's ends the retries.
    const refused = run(9, "provider failed (400)");
    await vi.advanceTimersByTimeAsync(all);
    await expect(refused.result).rejects.toThrow("provider failed (400)");
    expect(refused.ids).toHaveLength(2);
    // A refused request may have been charged: it keeps its reservation.
    expect(refused.settled).toEqual([]);
    // A review cancelled during a pause sends nothing more.
    let stopped = false;
    const cancelled = run(9, "provider failed (503)", async () => stopped);
    await vi.advanceTimersByTimeAsync(1);
    stopped = true;
    await vi.advanceTimersByTimeAsync(all);
    await expect(cancelled.result).rejects.toThrow("cancelled");
    expect(cancelled.ids).toHaveLength(2);
  } finally {
    vi.useRealTimers();
  }
});
it("names the provider's Retry-After in a rate limit and waits for it instead of retrying at once", async () => {
  vi.useFakeTimers();
  try {
    const env = {
      AI_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/acct/rio/",
      AI_GATEWAY_TOKEN: "gateway-token",
      AI_GATEWAY_PROVIDERS: JSON.stringify({ "node-openai": { protocol: "openai" } }),
    } as Env;
    const refuse = async (headers: Record<string, string>) => {
      let sent = 0;
      const failed = new ProviderGateway(env, async () => {
        sent++;
        return new Response("rate limited: secret", { status: 429, headers });
      })
        .complete({ ...request, model: "openai/custom-node-openai/gpt-6-sol" })
        .catch((error) => error);
      await vi.advanceTimersByTimeAsync(5000);
      return { message: (await failed).message, sent };
    };
    // A wait longer than the gateway's own retry is left to the caller.
    expect(await refuse({ "retry-after": "30" })).toEqual({
      message: "provider failed (429) retry after 30 s",
      sent: 1,
    });
    expect(
      await refuse({ "retry-after": new Date(Date.now() + 90000).toUTCString() }),
    ).toMatchObject({ message: expect.stringMatching(/^provider failed \(429\) retry after (89|90) s$/), sent: 1 });
    expect(await refuse({ "retry-after-ms": "1500" })).toEqual({
      message: "provider failed (429) retry after 2 s",
      sent: 2,
    });
    expect(await refuse({})).toEqual({ message: "provider failed (429)", sent: 2 });
  } finally {
    vi.useRealTimers();
  }
});
describe("a provider's rate limit", () => {
  const answer = {
    content: '{"result":["done"]}',
    input_tokens: 80,
    output_tokens: 50,
    cost_usd: null,
  };
  /** One conversation of a review whose ledger the conversations share. */
  const talk = (
    ledger: Ledger,
    complete: () => Promise<typeof answer>,
    actor = "v",
    cancelled?: () => Promise<boolean>,
  ) => {
    const ids: string[] = [];
    const result = converse({
      gateway: { complete },
      ledger,
      actor,
      phase: "verify-blind",
      model: "openai/test",
      allowance: { remaining: 1000000 },
      messages: [{ role: "user" as const, content: "verify" }],
      dispatch: async () => ({ content: "source" }),
      call: async (id, action) => {
        ids.push(id);
        return action();
      },
      cancelled,
    });
    result.catch(() => {});
    return { result, ids };
  };
  const review = (remainingMs = 3600000) => {
    const settled: number[] = [];
    const ledger: Ledger = {
      remaining: async () => 100000000,
      remainingMs: async () => remainingMs,
      reserve: async () => "id",
      settle: async (_, usage) => {
        settled.push(usage.input_tokens + usage.output_tokens);
      },
    };
    return { ledger, settled };
  };
  it("sends a refused turn again after the provider's Retry-After, and releases each refused call's reservation", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const { ledger, settled } = review();
      let calls = 0;
      const one = talk(ledger, async () => {
        if (calls++ < 2) throw new Error("provider failed (429) retry after 40 s");
        return answer;
      });
      // The provider asked for 40 s, longer than the first pause.
      await vi.advanceTimersByTimeAsync(39000);
      expect(one.ids).toEqual(["v-verify-blind-0"]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(one.ids).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(40000);
      await expect(one.result).resolves.toEqual(["done"]);
      expect(one.ids).toEqual([
        "v-verify-blind-0",
        "v-verify-blind-0-limited-1",
        "v-verify-blind-0-limited-2",
      ]);
      expect(settled).toEqual([0, 0, 130]);
      // Without a Retry-After the pauses grow, each by up to itself again.
      vi.spyOn(Math, "random").mockReturnValue(0.5);
      const plain = review();
      let refused = 0;
      const two = talk(plain.ledger, async () => {
        if (refused++ < 2) throw new Error("provider failed (429)");
        return answer;
      });
      await vi.advanceTimersByTimeAsync(RATE_LIMIT_PAUSES_MS[0] * 1.5 - 1);
      expect(two.ids).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(two.ids).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(RATE_LIMIT_PAUSES_MS[1] * 1.5);
      await expect(two.result).resolves.toEqual(["done"]);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
  it("delays a review's burst of refused calls, holding its other calls back and spreading their return", async () => {
    vi.useFakeTimers();
    try {
      const { ledger } = review();
      // The provider refuses every call for the first 50 s.
      const start = Date.now();
      const sentAt: number[] = [];
      const complete = async () => {
        sentAt.push(Date.now() - start);
        if (Date.now() - start < 50000) throw new Error("provider failed (429)");
        return answer;
      };
      const burst = Array.from({ length: 36 }, (_, n) => talk(ledger, complete, `v${n}`));
      await vi.advanceTimersByTimeAsync(1000);
      // A call started while the review is refused holds back before sending.
      const late = talk(ledger, complete, "late");
      await vi.advanceTimersByTimeAsync(RATE_LIMIT_PAUSES_MS[0] - 1001);
      expect(late.ids).toEqual([]);
      await vi.advanceTimersByTimeAsync(RATE_LIMIT_PAUSES_MS.reduce((a, b) => a + b, 0) * 2);
      for (const { result } of [...burst, late])
        await expect(result).resolves.toEqual(["done"]);
      // Retries were spread over time, not sent together.
      const retries = sentAt.filter((t) => t > 0);
      expect(new Set(retries.map((t) => Math.floor(t / 1000))).size).toBeGreaterThan(10);
      // No conversation sent more than its first call and its four retries.
      for (const { ids } of burst) expect(ids.length).toBeLessThanOrEqual(5);
    } finally {
      vi.useRealTimers();
    }
  });
  it("fails a refused turn once the refusals outlast its pauses, the deadline or the review", async () => {
    vi.useFakeTimers();
    try {
      const refuse = async () => {
        throw new Error("provider failed (429)");
      };
      const all = RATE_LIMIT_PAUSES_MS.reduce((a, b) => a + b, 0);
      const { ledger } = review();
      const sustained = talk(ledger, refuse);
      await vi.advanceTimersByTimeAsync(all * 2);
      await expect(sustained.result).rejects.toThrow("provider failed (429)");
      expect(sustained.ids).toHaveLength(1 + RATE_LIMIT_PAUSES_MS.length);
      // A turn of the same review, refused long after the refusals began,
      // is not paced again: the review's other votes fail at once.
      const after = talk(ledger, refuse, "after");
      await vi.advanceTimersByTimeAsync(all * 2);
      await expect(after.result).rejects.toThrow("provider failed (429)");
      expect(after.ids).toHaveLength(1);
      // A call the provider answers in between starts the pacing afresh.
      const fresh = review();
      let calls = 0;
      const recovered = talk(fresh.ledger, async () => {
        if (calls++ % 2 === 0) throw new Error("provider failed (429)");
        return answer;
      });
      await vi.advanceTimersByTimeAsync(all * 2);
      await expect(recovered.result).resolves.toEqual(["done"]);
      // A pause past the review's deadline is not taken.
      const closing = talk(review(10000).ledger, refuse);
      await vi.advanceTimersByTimeAsync(1);
      await expect(closing.result).rejects.toThrow("provider failed (429)");
      expect(closing.ids).toHaveLength(1);
      // A review cancelled during a pause stops within a slice of it.
      let stopped = false;
      let checks = 0;
      const shared = review().ledger;
      const cancelled = async () => {
        checks++;
        return stopped;
      };
      const pausing = [talk(shared, refuse, "a", cancelled), talk(shared, refuse, "b", cancelled)];
      await vi.advanceTimersByTimeAsync(1);
      stopped = true;
      const before = checks;
      await vi.advanceTimersByTimeAsync(PAUSE_SLICE_MS);
      for (const { result, ids } of pausing) {
        await expect(result).rejects.toThrow("cancelled");
        expect(ids).toHaveLength(1);
      }
      // The waiting conversations of a review share one check per slice.
      expect(checks - before).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
it("names the provider's error code for a refused request and nothing else of the body", async () => {
  const env = {
    AI_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/acct/rio/",
    AI_GATEWAY_TOKEN: "gateway-token",
    AI_GATEWAY_PROVIDERS: JSON.stringify({
      "node-openai": { protocol: "openai" },
    }),
  } as Env;
  const failing = (body: unknown) =>
    new ProviderGateway(env, async () => Response.json(body, { status: 400 }))
      .complete({
        ...request,
        model: "openai/custom-node-openai/gpt-6-sol",
      });
  await expect(
    failing({ error: { code: "context_length_exceeded", message: "secret prompt text" } }),
  ).rejects.toThrow(/^provider failed \(400 context_length_exceeded\)$/);
  await expect(
    failing({ error: { code: "has spaces and secrets", type: "invalid_request_error" } }),
  ).rejects.toThrow(/^provider failed \(400 invalid_request_error\)$/);
  await expect(failing({ error: { message: "only prose" } })).rejects.toThrow(
    /^provider failed \(400\)$/,
  );
});
it("marks a provider failure after a reply that may have been billed, and keeps that call's reservation", async () => {
  vi.useFakeTimers();
  try {
    const env = {
      AI_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/acct/rio/",
      AI_GATEWAY_TOKEN: "gateway-token",
      AI_GATEWAY_PROVIDERS: JSON.stringify({ "node-openai": { protocol: "openai" } }),
    } as Env;
    // The first reply has usage but no content; the retry is refused with a 503.
    let replies = 0;
    const gateway = new ProviderGateway(env, async () =>
      replies++ === 0
        ? Response.json({ choices: [{ message: {} }], usage: { prompt_tokens: 9, completion_tokens: 9 } })
        : new Response(null, { status: 503 }),
    );
    const failed = gateway
      .complete({ ...request, model: "openai/custom-node-openai/gpt-6-sol" })
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(5000);
    const error = await failed;
    expect(error.message).toBe("provider failed (503)");
    expect(error.charged).toBe(true);
    // converse keeps such a call's reservation, and still retries it.
    const settled: number[] = [];
    let calls = 0;
    const result = converse({
      gateway: {
        complete: async () => {
          if (calls++ === 0) throw error;
          return { content: '{"result":["done"]}', input_tokens: 80, output_tokens: 50, cost_usd: null };
        },
      },
      ledger: {
        remaining: async () => 1000000,
        reserve: async () => "id",
        settle: async (_, usage) => {
          settled.push(usage.input_tokens + usage.output_tokens);
        },
      },
      actor: "security",
      phase: "generation",
      model: "openrouter/openai/gpt-6.1-sol",
      allowance: { remaining: 1000000 },
      messages: [{ role: "user" as const, content: "audit" }],
      dispatch: async () => ({ content: "source" }),
      retryCall: true,
    });
    await expect(result).resolves.toEqual(["done"]);
    expect(settled).toEqual([130]);
  } finally {
    vi.useRealTimers();
  }
});
it("reserves no tokens for a call the review's deadline has already passed", async () => {
  const reserved: number[] = [];
  await expect(
    converse({
      gateway: { complete: async () => { throw new Error("not sent"); } },
      ledger: {
        remaining: async () => 1000000,
        remainingMs: async () => 0,
        reserve: async (_, __, tokens) => {
          reserved.push(tokens);
          return "id";
        },
        settle: async () => {},
      },
      actor: "security",
      phase: "generation",
      model: "openrouter/openai/gpt-6.1-sol",
      allowance: { remaining: 1000000 },
      messages: [{ role: "user" as const, content: "audit" }],
      dispatch: async () => ({ content: "source" }),
    }),
  ).rejects.toThrow("review wall budget exhausted");
  expect(reserved).toEqual([]);
});
it("sends a deliberate one-time request after two corrections, and counts only answered tool turns", async () => {
  const replies = [
    '{"tools":[{"name":"read_file","args":{"path":"missing.ts"}}]}',
    '{"tools":[{"name":"read_file","args":{"path":"a.ts"}}]}',
    "not json",
    "still not json",
    '{"result":["first"]}',
    '{"result":["final"]}',
  ];
  const seen: number[] = [];
  let turn = 0;
  const result = await converse({
    gateway: {
      complete: async () => ({ content: replies[turn++], input_tokens: 80, output_tokens: 50, cost_usd: null }),
    },
    ledger: { remaining: async () => 1000000, reserve: async () => "id", settle: async () => {} },
    actor: "security",
    phase: "generation",
    model: "openrouter/openai/gpt-6.1-sol",
    allowance: { remaining: 1000000 },
    messages: [{ role: "user" as const, content: "audit" }],
    // The first read fails: that turn read nothing.
    dispatch: async (_, args) => {
      if (args.path === "missing.ts") throw new Error("no such file");
      return { content: "source" };
    },
    maxTurns: 10,
    validateResult: (value, state) => {
      seen.push(state.toolTurns);
      if (value[0] === "first") {
        const challenge = new Refused("challenged", "Host: look again.");
        challenge.once = true;
        throw challenge;
      }
      return value;
    },
  });
  expect(result).toEqual(["final"]);
  expect(seen).toEqual([1, 1]);
});

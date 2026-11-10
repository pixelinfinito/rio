import { describe, expect, it } from "vitest";
import gates from "../../docs/evaluation/prompt-caching-gates.json";
import { generationPrompt, join, type GenerationInputs } from "../src/prompt";
import {
  promptSettings,
  type PromptSettings,
} from "../src/prompt-config";

interface Gates {
  records: { gate: string; verdict: string }[];
  pending: { gate: string; note: string }[];
}
/** Gates a set of defaults needs without a passed record (design D15). */
function ungated(settings: PromptSettings, file: Gates, partition: boolean) {
  const passed = new Set(
    file.records.filter((r) => r.verdict === "passed").map((r) => r.gate),
  );
  // Only the partition may be pending, as an explicit release blocker.
  const pending = new Set(
    file.pending.filter((p) => p.gate === "partition").map((p) => p.gate),
  );
  return [
    ...settings.cache,
    ...settings.layout,
    ...(partition ? ["partition"] : []),
  ].filter((gate) => !passed.has(gate) && !pending.has(gate));
}
const inputs: GenerationInputs = {
  agent: "correctness",
  instructions: "",
  round: "",
  intent: "",
  focus: "",
  graph: "",
  changed: "",
  checks: "",
  data: "",
  guidance: "",
  partition: "p".repeat(32),
};
const partitioned = join(generationPrompt(inputs)).includes("<review_partition");
const file = gates as Gates;

describe("prompt-cache gate records", () => {
  it("enables no default without a passed gate", () => {
    expect(ungated(promptSettings({}), file, partitioned)).toEqual([]);
  });
  it("fails a synthetic default flip without a record", () => {
    const flipped = promptSettings({
      PROMPT_CACHE: "openai",
      PROMPT_LAYOUT: "agent-order",
    });
    expect(ungated(flipped, file, false)).toEqual(["openai", "agent-order"]);
    expect(
      ungated(flipped, { records: [{ gate: "openai", verdict: "passed" }], pending: [] }, false),
    ).toEqual(["agent-order"]);
    expect(
      ungated(flipped, { records: [{ gate: "openai", verdict: "failed" }], pending: [] }, false),
    ).toContain("openai");
  });
  it("requires a passed or explicitly pending partition gate", () => {
    expect(partitioned).toBe(true);
    expect(ungated({ cache: [], layout: [] }, { records: [], pending: [] }, true)).toEqual([
      "partition",
    ]);
    // A pending entry cannot stand in for a feature or hint class.
    expect(
      ungated(
        { cache: [], layout: ["compaction"] },
        { records: [], pending: [{ gate: "compaction", note: "" }] },
        false,
      ),
    ).toEqual(["compaction"]);
  });
  it("keeps the record file consistent", () => {
    const passed = file.records.filter((r) => r.verdict === "passed").map((r) => r.gate);
    for (const p of file.pending) {
      expect(p.gate).toBe("partition");
      // Once the gate passes, the pending entry goes.
      expect(passed).not.toContain(p.gate);
    }
    for (const r of file.records) expect(["passed", "failed"]).toContain(r.verdict);
  });
});

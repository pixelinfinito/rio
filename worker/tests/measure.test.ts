import { describe, expect, it, vi } from "vitest";
import { councilGaps, measure } from "../scripts/measure-prompt-cache";

const plan = { routes: ["anthropic/claude-test"], repetitions: 1, spendCapUsd: 1 };
describe("live prompt-cache measurement", () => {
  it.each([
    [{}, plan, "RIO_LIVE_PROMPT_CACHE"],
    [{ RIO_LIVE_PROMPT_CACHE: "1" }, plan, "ANTHROPIC_API_KEY"],
    [{ RIO_LIVE_PROMPT_CACHE: "1", ANTHROPIC_API_KEY: "k" }, { ...plan, spendCapUsd: 0 }, "spend cap"],
    [{ RIO_LIVE_PROMPT_CACHE: "1", ANTHROPIC_API_KEY: "k" }, { ...plan, routes: ["dynamic/r"] }, "AI_GATEWAY_URL"],
  ])("makes no request while a gate is closed (%j)", async (env, p, reason) => {
    const transport = vi.fn();
    const result = await measure(env, p, transport as any, () => {});
    expect(result).toEqual({ status: "refused", reason: expect.stringContaining(reason) });
    expect(transport).not.toHaveBeenCalled();
  });
  it("measures council round gaps against the 5-minute lifetime", () => {
    expect(
      councilGaps({
        entries: [
          { finding: "f", member: "skeptic", round: 1, at: 0 },
          { finding: "f", member: "skeptic", round: 2, at: 120_000 },
          { finding: "f", member: "tester", round: 1, at: 0 },
          { finding: "f", member: "tester", round: 2, at: 360_000 },
        ],
      }),
    ).toEqual([
      { finding: "f", member: "skeptic", seconds: 120, within_ttl: true },
      { finding: "f", member: "tester", seconds: 360, within_ttl: false },
    ]);
  });
});

import { describe, expect, it } from "vitest";
import { parseWall, reviewWall } from "../src/budget";
import { profile } from "./fixtures";

describe("QA deadline composition", () => {
  const qa = () => ({
    ...structuredClone(profile),
    steps: [
      {
        id: "qa",
        uses: "rio/qa@0.1.0",
        needs: ["graph"],
        with: { enabled: true },
      },
    ],
  });
  it("adds QA and verifier reserve to the ordinary review wall", () => {
    expect(reviewWall(qa(), "fast")).toBe(39 * 60_000);
    const deep = qa();
    deep.budget.deep = { wall_time: "10m" };
    expect(reviewWall(deep, "deep")).toBe(105 * 60_000);
  });
  it("uses configured QA budgets without changing non-QA deadlines", () => {
    const configured = qa();
    configured.budget.fast.qa = { wall: "12m" };
    expect(reviewWall(configured, "fast")).toBe(21 * 60_000);
    configured.steps[0].with.enabled = false;
    expect(reviewWall(configured, "fast")).toBe(4 * 60_000);
    expect(reviewWall(profile, "fast")).toBe(4 * 60_000);
  });
  it("preserves the base wall cap and rejects malformed QA walls", () => {
    expect(() => parseWall("90m")).toThrow();
    for (const wall of [
      "0m",
      "-1m",
      "tomorrow",
      "999999999999999999999999999h",
    ]) {
      const configured = qa();
      configured.budget.fast.qa = { wall };
      expect(() => reviewWall(configured, "fast")).toThrow();
    }
  });
});

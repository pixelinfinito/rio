import { describe, expect, it } from "vitest";
import {
  combineCoverage,
  combineRaised,
  reviewModels,
  sameIssue,
} from "../src/combine";
import type { Hypothesis, SecurityCoverage } from "../src/types";

const hypothesis = (
  id: string,
  line: [number, number],
  message: string,
  more: Partial<Hypothesis> = {},
): Hypothesis => ({
  id,
  rule_id: `correctness/${id}`,
  category: "defect",
  severity: "error",
  location: {
    path: "src/pay.ts",
    line_start: line[0],
    line_end: line[1],
    symbol_path: "pay.total",
    occurrence_state: "new",
  },
  message,
  trigger: "",
  state: "new",
  source: { agent: "correctness" },
  ...more,
});

describe("reviewModels", () => {
  const models = {
    default: "anthropic/a",
    second: "openai/b",
    twin: "anthropic/a",
    tests: "openai/t",
  };
  it("lists the defined aliases of `models` in order, each model once", () => {
    expect(
      reviewModels(
        "correctness",
        { models: ["second", "missing", "default", "twin"] },
        models,
      ),
    ).toEqual([
      { alias: "second", model: "openai/b" },
      { alias: "default", model: "anthropic/a" },
    ]);
  });
  it("falls back to one review when no listed alias is defined", () => {
    expect(
      reviewModels(
        "correctness",
        { models: ["missing"], model: "second" },
        models,
      ),
    ).toEqual([{ alias: "second", model: "openai/b" }]);
  });
  it("uses the declared model, then the agent's own alias, then default", () => {
    expect(reviewModels("tests", { model: "second" }, models)).toEqual([
      { alias: "second", model: "openai/b" },
    ]);
    expect(reviewModels("tests", {}, models)).toEqual([
      { alias: "tests", model: "openai/t" },
    ]);
    expect(reviewModels("tests", { model: "missing" }, models)).toEqual([
      { alias: "default", model: "anthropic/a" },
    ]);
    expect(reviewModels("correctness", {}, {})).toEqual([]);
  });
});

describe("sameIssue", () => {
  const a = hypothesis(
    "a",
    [10, 12],
    "`total` divides `sum` by `items.length`, which is zero for an empty list.",
  );
  it("joins two statements of one issue on overlapping lines", () => {
    expect(
      sameIssue(
        a,
        hypothesis(
          "b",
          [12, 12],
          "An empty `items` list makes `sum / items.length` evaluate to NaN.",
        ),
      ),
    ).toBe(true);
  });
  it("keeps apart another issue on the same lines, the same words on other lines or in another file, and another catalog item", () => {
    expect(
      sameIssue(
        a,
        hypothesis(
          "b",
          [11, 11],
          "The loop reads `price` from an entry that can be undefined.",
        ),
      ),
    ).toBe(false);
    expect(sameIssue(a, hypothesis("b", [13, 14], a.message))).toBe(false);
    const elsewhere = hypothesis("b", [10, 12], a.message);
    elsewhere.location.path = "src/cart.ts";
    expect(sameIssue(a, elsewhere)).toBe(false);
    expect(
      sameIssue(
        { ...a, catalog_item: "A05:2025" },
        hypothesis("b", [10, 12], a.message, { catalog_item: "A01:2025" }),
      ),
    ).toBe(false);
  });
});

describe("combineRaised", () => {
  const first = hypothesis("a", [10, 12], "`sum` is divided by `items.length`");
  const again = hypothesis(
    "b",
    [12, 12],
    "division of `sum` by `items.length`",
  );
  const other = hypothesis("c", [3, 3], "`count` may be undefined");
  it("keeps the first model's statement of a shared issue and names every model that raised it", () => {
    const into: Hypothesis[] = [],
      under = new Map<string, string[]>();
    const added = combineRaised(
      into,
      [
        { alias: "default", hypotheses: [first] },
        { alias: "second", hypotheses: [again, other, first] },
      ],
      under,
    );
    expect(into).toEqual([first, other]);
    expect(added).toEqual([first, other]);
    expect(Object.fromEntries(under)).toEqual({
      a: ["default", "second"],
      c: ["second"],
    });
  });
  it("never joins two hypotheses of one model", () => {
    const into: Hypothesis[] = [];
    combineRaised(into, [{ alias: "default", hypotheses: [first, again] }]);
    expect(into).toEqual([first, again]);
  });
  it("skips a hypothesis an earlier agent already raised", () => {
    const into = [first];
    expect(
      combineRaised(into, [{ alias: "default", hypotheses: [first, other] }]),
    ).toEqual([other]);
    expect(into).toEqual([first, other]);
  });
});

describe("combineCoverage", () => {
  const applicable = ["A01", "A02", "A03"].map((id) => ({ id, title: id }));
  const coverage = (
    assessed: string[],
    unassessed: [string, "budget" | "no_evidence"][],
  ): SecurityCoverage => ({
    catalog: "owasp-top10-2025",
    assessed: assessed.map((item) => ({ item, title: item, findings: [] })),
    unassessed: unassessed.map(([item, reason]) => ({
      item,
      title: item,
      reason,
    })),
    not_applicable: [],
  });
  it("counts an item assessed when either review assessed it, and gives the first review's reason otherwise", () => {
    const one = coverage(
      ["A01"],
      [
        ["A02", "budget"],
        ["A03", "budget"],
      ],
    );
    const two = coverage(
      ["A02"],
      [
        ["A01", "no_evidence"],
        ["A03", "no_evidence"],
      ],
    );
    expect(combineCoverage(applicable, [one, two])).toEqual(
      coverage(["A01", "A02"], [["A03", "budget"]]),
    );
    expect(combineCoverage(applicable, [one])).toBe(one);
  });
});

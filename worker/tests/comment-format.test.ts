import { describe, expect, it } from "vitest";
import type { Finding } from "../src/types";
import { findingBody, suggestionRange } from "../src/comment/finding";
import { summaryBody, qaSummary } from "../src/comment/summary";
import { COMMENT_LIMIT, fitBody } from "../src/comment/limits";
import { fence } from "../src/comment/text";
import inlineFinding from "../../docs/design/tui-pr-comments/pr-comments/markdown/01-inline-finding.md?raw";
import inlineSecurity from "../../docs/design/tui-pr-comments/pr-comments/markdown/02-inline-security-council.md?raw";
import inlineQa from "../../docs/design/tui-pr-comments/pr-comments/markdown/03-inline-qa-finding.md?raw";
import stateFixed from "../../docs/design/tui-pr-comments/pr-comments/markdown/04-state-fixed.md?raw";
import stateDismissed from "../../docs/design/tui-pr-comments/pr-comments/markdown/05-state-dismissed.md?raw";
import stateRegression from "../../docs/design/tui-pr-comments/pr-comments/markdown/06-state-regression.md?raw";
import summaryDesign from "../../docs/design/tui-pr-comments/pr-comments/markdown/07-summary.md?raw";

// The handoff's Markdown (docs/design/tui-pr-comments/pr-comments/markdown)
// is the layout contract. Its sample text is illustrative, so bodies are
// compared by their top-level block structure: heading levels and glyphs,
// metadata lines, paragraphs, tables, fences, folds and markers, in order.

const ID = (n: string) => n.repeat(64).slice(0, 64);
const FAIL_ON = {
  evidence: "static_proven",
  categories: ["defect", "security", "ux"],
};

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: ID("8c1e4a9b"),
    rule_id: "ts/null-deref",
    category: "defect",
    severity: "error",
    evidence_level: "static_proven",
    state: "new",
    location: {
      path: "src/parser/header.ts",
      line_start: 42,
      line_end: 42,
      symbol_path: "parseHeader",
      occurrence_state: "new",
    },
    message:
      "`parseHeader` calls `.split` on a missing content type. Line 42 calls `.split` on it and the worker throws.",
    trigger: "a request without a `Content-Type` header",
    impact: "The request returns **500**.",
    suggested_fix: "Fall back to the default content type.",
    fix: {
      line_start: 42,
      line_end: 42,
      replacement:
        "  const [type, params] = (ctype ?? DEFAULT_CTYPE).split(';')",
    },
    evidence: [
      "src/parser/header.ts:42:26 - error TS18048: 'ctype' is possibly 'undefined'.",
    ],
    source: { tool: "tsc", version: "5.6" } as any,
    locations: [
      {
        path: "src/parser/header.ts",
        line_start: 42,
        line_end: 42,
        symbol_path: "parseHeader",
        occurrence_state: "new",
      },
      {
        path: "src/parser/body.ts",
        line_start: 31,
        line_end: 31,
        symbol_path: "parseBody",
        occurrence_state: "new",
      },
      {
        path: "src/parser/query.ts",
        line_start: 12,
        line_end: 12,
        symbol_path: "parseQuery",
        occurrence_state: "new",
      },
    ],
    ...over,
  } as Finding;
}
const hunk = new Set([38, 39, 40, 41, 42, 43, 44, 45, 46]);

/** Top-level blocks of a comment body. */
function skeleton(markdown: string): string[] {
  const out: string[] = [];
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const fenceOpen = /^(`{3,})(\w*)/.exec(line);
    if (fenceOpen) {
      while (++i < lines.length && !lines[i].startsWith(fenceOpen[1]));
      out.push(fenceOpen[2] === "suggestion" ? "suggestion" : "fence");
      continue;
    }
    if (line.startsWith("<details")) {
      let depth = 1;
      while (++i < lines.length && depth) {
        if (lines[i].startsWith("<details")) depth++;
        if (lines[i].startsWith("</details>")) depth--;
      }
      i--;
      out.push(line.startsWith("<details open") ? "details-open" : "details");
      continue;
    }
    let token: string;
    if (/^#{1,6} /.test(line)) {
      const [hashes, glyph] = line.split(" ");
      token = `${hashes} ${glyph}`;
    } else if (line.startsWith("<!-- rio:"))
      token = /^<!-- rio:\w+/.exec(line)![0];
    else if (line.startsWith("<sub>")) token = "sub";
    else if (line.startsWith("> [!")) token = line.slice(0, 12);
    else if (line.startsWith(">")) token = "quote";
    else if (line.startsWith("|")) token = "table";
    else if (line.startsWith("~~")) token = "struck";
    else if (line.startsWith("- ")) token = "list";
    else
      token =
        `p ${[...line][0] === "✅" || [...line][0] === "💤" ? [...line][0] : ""}`.trim();
    if (out[out.length - 1] !== token) out.push(token);
  }
  return out;
}

describe("one glyph, one meaning", () => {
  it("never puts ✅ on an open finding, at any evidence level or category", () => {
    for (const evidence_level of [
      "reproduced",
      "static_proven",
      "plausible",
    ] as const)
      for (const category of ["defect", "risk", "security"] as const) {
        const body = findingBody(
          finding({ evidence_level, category }),
          { status: "open" },
          undefined,
          42,
          { failOn: FAIL_ON, lines: hunk },
        );
        expect(body).not.toContain("✅");
      }
  });
  it("words the proof by evidence level and names the prover", () => {
    const body = (f: Partial<Finding>) =>
      findingBody(finding(f), { status: "open" }).split("\n")[1];
    expect(body({})).toContain("📐 proven by `tsc`");
    expect(body({ evidence_level: "reproduced" })).toContain(
      "🧪 reproduced by experiment",
    );
    expect(body({ evidence_level: "plausible", severity: "warning" })).toMatch(
      /❔ plausible/,
    );
    expect(body({ evidence_level: "plausible" })).not.toMatch(/🧪|📐/);
  });
});

describe("inline finding layout", () => {
  it("matches the handoff's inline finding", () => {
    const body = findingBody(finding(), { status: "open" }, undefined, 42, {
      failOn: FAIL_ON,
      lines: hunk,
    });
    expect(skeleton(body)).toEqual(skeleton(inlineFinding));
    expect(
      body.startsWith(
        "#### 🔴 `parseHeader` calls `.split` on a missing content type.",
      ),
    ).toBe(true);
    expect(body).toContain(
      "<sub>Error · defect · 📐 proven by `tsc` · **matches `fail_on`**</sub>",
    );
    expect(body).not.toMatch(
      /\*\*(When it happens|Impact|💡 Suggested fix)\*\*/,
    );
    expect(body).toContain("Same pattern in 2 more places");
    expect(body).toContain(
      "<sub>`8c1e4a9b` · `ts/null-deref` · Not right? Reply `/rio dismiss 8c1e4a9b wrong` or `fixed` · `intentional` · `irrelevant` · `style`</sub>",
    );
    expect(body.endsWith(`<!-- rio:finding:${ID("8c1e4a9b")} -->`)).toBe(true);
  });

  it("matches the handoff's security finding with its trace, experiment and council", () => {
    const security = finding({
      id: ID("a7f3c210"),
      rule_id: "sec/owner-check",
      category: "security",
      evidence_level: "reproduced",
      message:
        "Guest session can read any order. `getOrder` validates the id but never compares the order's owner with the session.",
      trigger: "",
      impact: undefined,
      evidence: [],
      source: { agent: "security" },
      location: {
        ...finding().location,
        path: "api/orders.ts",
        line_start: 57,
        line_end: 57,
      },
      fix: {
        line_start: 57,
        line_end: 58,
        replacement:
          "  const order = await db.orders.get(id)\n  if (order?.ownerId !== session.user?.id) return res.sendStatus(404)",
      },
      trace: {
        catalog_item: "A01",
        change: "removed",
        steps: [
          { role: "source", path: "api/orders.ts", line_start: 52 },
          {
            role: "step",
            path: "api/orders.ts",
            line_start: 54,
            missing: true,
          },
          { role: "sink", path: "api/orders.ts", line_start: 57 },
        ],
      },
      council: {
        decision: "reproduced",
        tier: "experiment",
        partial: true,
        answered: 4,
        total: 5,
        experiments: [
          {
            command: ["curl", "-s", "/api/orders/1042"],
            version: "both",
            expect: "fails",
            run: true,
            outcome: { base: "passed", head: "failed" },
          },
        ],
        members: [
          {
            role: "skeptic",
            abstained: false,
            family: "claude",
            rounds: [
              { round: 1, real: "no" },
              { round: 2, real: "yes", changed: true },
            ],
          },
          {
            role: "exploit-author",
            abstained: false,
            family: "gpt",
            rounds: [
              { round: 1, real: "yes" },
              { round: 2, real: "yes" },
            ],
          },
          {
            role: "tester",
            abstained: true,
            cause: "timeout",
            family: "qwen",
            rounds: [{ round: 1, cause: "timeout" }],
          },
        ],
      },
    });
    const body = findingBody(security, { status: "open" }, undefined, 57, {
      failOn: FAIL_ON,
      lines: new Set([52, 53, 54, 55, 56, 57, 58]),
    });
    // The handoff also folds catalog coverage into each security comment;
    // that coverage is per review, so it is in the summary's "What ran" fold.
    const design = skeleton(inlineSecurity).filter(
      (token, i, all) => !(token === "details" && i === all.length - 3),
    );
    expect(skeleton(body)).toEqual(design);
    expect(body).toContain(
      "<sub>Error · security · `A01` · 🧪 reproduced by experiment · **matches `fail_on`**</sub>",
    );
    expect(body).toContain(
      "| 2 | ❌ **check removed by this change** | `api/orders.ts:54` (base) |",
    );
    expect(body).toContain(
      "$ curl -s /api/orders/1042\nhead  → failed\nbase  → passed",
    );
    expect(body).toContain("| skeptic | claude | not real | real ¹ |");
    expect(body).toContain("| tester | qwen | timed out | — |");
    expect(body).toContain(
      "Decided by evidence tier (experiment). Votes are not counted.",
    );
    expect(body).not.toContain("✅");
  });

  it("matches the handoff's QA finding with screenshots, cells and evidence", () => {
    const later = Date.UTC(2100, 0, 1);
    const qa = {
      journeys: [
        {
          name: "checkout",
          cells: [
            { viewport: "mobile", color_scheme: "light", outcome: "passed" },
            {
              viewport: "mobile",
              color_scheme: "dark",
              outcome: "failed",
              step_reached: 4,
            },
            { viewport: "desktop", color_scheme: "light", outcome: "passed" },
            { viewport: "desktop", color_scheme: "dark", outcome: "passed" },
          ],
        },
      ],
      evidence: {
        artifacts: [
          {
            id: "base-4",
            kind: "screenshot",
            version: "base",
            link: "https://e.example/base.png",
            expires_at: later,
          },
          {
            id: "head-4",
            kind: "screenshot",
            version: "head",
            link: "https://e.example/head.png",
            expires_at: later,
          },
          {
            id: "dom-4",
            kind: "dom",
            link: "https://e.example/dom.html",
            expires_at: later,
          },
        ],
      },
    };
    const qaFinding = finding({
      id: ID("41d0e7b2"),
      rule_id: "mobile/fixed-overlap",
      category: "ux",
      evidence_level: "static_proven",
      message:
        "Pay is hidden under the cookie bar on mobile in dark mode. Line 212 sets `line-height: 2.4`.",
      trigger: "",
      impact: "The tap at (195, 790) lands on the bar.",
      evidence: ["base-4", "head-4", "dom-4"],
      source: { agent: "qa" },
      location: {
        ...finding().location,
        path: "src/style.css",
        line_start: 212,
        line_end: 212,
      },
      locations: [
        {
          ...finding().location,
          path: "src/style.css",
          line_start: 212,
          line_end: 212,
          cell: { viewport: "mobile", color_scheme: "dark" },
        },
      ],
      fix: {
        line_start: 212,
        line_end: 212,
        replacement: "  line-height: 1.5;",
      },
      qa: {
        journey: "checkout",
        step: 4,
        route: "/pay",
        kind: "functional",
        attribution: "source",
        element_paths: [],
      },
    });
    const body = findingBody(qaFinding, { status: "open" }, qa, 212, {
      failOn: FAIL_ON,
      lines: new Set([210, 211, 212]),
    });
    expect(skeleton(body)).toEqual(skeleton(inlineQa));
    expect(body).toContain(
      "journey `checkout` step 4 · 📐 proven by `mobile/fixed-overlap`",
    );
    expect(body).toContain("| dark | ❌ **step 4** | ✅ passed |");
    expect(body).toContain("| light | ✅ passed | ✅ passed |");
    expect(body).toMatch(/<sub>Evidence: .*\[dom\]/);
    expect(body).toContain("2100-01-01");
  });
});

describe("suggestion blocks", () => {
  const body = (f: Finding, anchor: number, lines: Set<number>) =>
    findingBody(f, { status: "open" }, undefined, anchor, { lines });
  it("suggests an in-hunk fix and replaces exactly its lines", () => {
    const text = body(finding(), 42, hunk);
    expect(text).toContain(
      "```suggestion\n  const [type, params] = (ctype ?? DEFAULT_CTYPE).split(';')\n```",
    );
    expect(text).not.toContain("Suggested fix:");
    expect(suggestionRange(finding(), 42, hunk)).toEqual({
      line_start: 42,
      line_end: 42,
    });
  });
  it("falls back to prose when the range leaves the hunk", () => {
    const outside = finding({
      fix: { line_start: 42, line_end: 50, replacement: "x" },
    });
    const text = body(outside, 42, hunk);
    expect(text).not.toContain("```suggestion");
    expect(text).toContain(
      "Suggested fix: Fall back to the default content type.",
    );
    expect(body(finding(), 42, new Set([41]))).not.toContain("```suggestion");
    // An anchor outside the range would apply the suggestion elsewhere.
    expect(suggestionRange(finding(), 41, hunk)).toBeUndefined();
  });
  it("spans a multi-line range that the comment must cover", () => {
    const multi = finding({
      fix: { line_start: 42, line_end: 44, replacement: "a\nb\nc" },
    });
    expect(suggestionRange(multi, 42, hunk)).toEqual({
      line_start: 42,
      line_end: 44,
    });
    expect(body(multi, 42, hunk)).toContain("```suggestion\na\nb\nc\n```");
  });
  it("fences a replacement that contains backticks", () => {
    const ticks = finding({
      fix: { line_start: 42, line_end: 42, replacement: "const s = ```x```" },
    });
    const text = body(ticks, 42, hunk);
    expect(fence("const s = ```x```")).toBe("````");
    expect(text).toContain("````suggestion\nconst s = ```x```\n````");
  });
});

describe("lifecycle edits", () => {
  const f = finding();
  const marker = `<!-- rio:finding:${f.id} -->`;
  it("matches the handoff's fixed state and keeps the marker", () => {
    const body = findingBody(f, { status: "fixed", fixed_in: "a7c41e2bd9" });
    expect(skeleton(body)).toEqual(skeleton(stateFixed));
    expect(
      body.startsWith("✅ **Fixed in `a7c41e2`** · verified on the new head"),
    ).toBe(true);
    expect(body).toContain(
      "~~`parseHeader` calls `.split` on a missing content type.~~",
    );
    expect(body.endsWith(marker)).toBe(true);
  });
  it("matches the handoff's dismissed state, per reason", () => {
    const body = findingBody(f, {
      status: "dismissed",
      response: { reason: "intentional", actor: "ana", at: "" },
    });
    expect(skeleton(body)).toEqual(skeleton(stateDismissed));
    // `@ana`, with a zero-width space after `@` so she is not notified.
    expect(
      body.startsWith("💤 **Dismissed as `intentional`** by @\u200bana"),
    ).toBe(true);
    expect(body).toContain(
      "rio won't report this again while the code is unchanged.",
    );
    const wrong = findingBody(f, {
      status: "dismissed",
      response: { reason: "wrong", actor: "ana", at: "" },
    });
    expect(wrong).toContain("counts toward this rule's calibration");
    expect(wrong).toContain("only if it reproduces after the code changes");
    expect(wrong.endsWith(marker)).toBe(true);
    // The open, dismissed and fixed bodies share one marker, so edits replace.
    expect(findingBody(f, { status: "open" }).endsWith(marker)).toBe(true);
  });
  it("matches the handoff's regression", () => {
    const back = finding({
      message: "`getCached` dereferences a missing entry.",
      trigger: "",
      impact: undefined,
      evidence: [],
      locations: [finding().location],
      fix: {
        line_start: 42,
        line_end: 43,
        replacement: "  if (!hit) return undefined\n  return hit.value.data",
      },
      history: {
        first_seen: "acme/app#128",
        last_seen: "acme/app#131",
        seen_count: 2,
        previous_status: "fixed",
        fixed_in: "acme/app#131",
      },
    });
    const body = findingBody(back, { status: "open" }, undefined, 42, {
      failOn: FAIL_ON,
      lines: hunk,
    });
    expect(skeleton(body)).toEqual(skeleton(stateRegression));
    expect(
      body.startsWith(
        "#### ↩️ Back again: `getCached` dereferences a missing entry.",
      ),
    ).toBe(true);
    expect(body).toContain("| this PR | **brings it back** |");
  });
});

describe("summary", () => {
  const report = (findings: Finding[], over: any = {}) => ({
    status: "complete",
    review: {
      head: "a7c41e2bd9",
      profile: "rio/security",
      pull_request: { number: 142 },
    },
    risk_tier: {
      tier: "high",
      reasons: ["touches authorization", "changes a public route"],
    },
    lineage: { round: 2, cap: 3, held_back: 2 },
    metrics: { wall_time_ms: 242_000 },
    checks: [
      { kind: "typecheck", root: ".", outcome: { outcome: "findings" } },
    ],
    findings,
    risks: [],
    remembered: [{}, {}],
    ...over,
  });
  const qa = {
    isolation: "pod",
    journeys: [
      "checkout",
      "add-to-cart",
      "payment-recovery",
      "profile-address",
    ].map((name, i) => ({
      name,
      cells: ["mobile", "desktop"].flatMap((viewport) =>
        ["light", "dark"].map((color_scheme) => ({
          viewport,
          color_scheme,
          outcome:
            i === 0 && viewport === "mobile" && color_scheme === "dark"
              ? "failed"
              : "passed",
          step_reached: 4,
        })),
      ),
    })),
    recommendations: [],
  };
  const four = [
    finding({
      id: ID("a7f3c210"),
      evidence_level: "reproduced",
      category: "security",
    }),
    finding({ id: ID("41d0e7b2") }),
    finding({ id: ID("8c1e4a9b") }),
    finding({
      id: ID("0d6a0d6a"),
      severity: "warning",
      evidence_level: "plausible",
    }),
  ];
  const input = (r: any) => ({
    report: r,
    lineage: ID("5e"),
    unanchored: [],
    rejected: [],
    wrong: [],
    link: "https://rio.example.test/v1/reviews/r/report",
    failOn: FAIL_ON,
    urls: new Map(
      four.map((f) => [f.id, `https://github.test/t/${f.id.slice(0, 4)}`]),
    ),
    fixed: 2,
  });
  it("matches the handoff's summary and states the verdict its scoreboard counts", () => {
    const body = summaryBody(input(report(four, { qa })));
    expect(skeleton(body)).toEqual(skeleton(summaryDesign));
    expect(body.startsWith("## 🌊 rio · 3 to fix before merge\n")).toBe(true);
    expect(body).toContain(
      "| **3** | **1** | **2** <sub>this round</sub> | **2** <sub>dismissals</sub> | **15** <sub>/ 16 passed</sub> |",
    );
    expect(body).toContain(
      "> **3 findings match this repository's `fail_on` policy.**",
    );
    expect(body).toContain(
      "<sub>`a7c41e2` · round 2 of 3 · `rio/security` · 4 m 02 s · risk **high**: touches authorization; changes a public route</sub>",
    );
    expect(body).toMatch(/\| `checkout` \| ✅ \| ❌ step 4 \| ✅ \| ✅ \|/);
    expect(body.endsWith(`<!-- rio:summary:${ID("5e")} -->`)).toBe(true);
  });
  it("says nothing to fix when no finding matches the policy", () => {
    const body = summaryBody(input(report([four[3]])));
    expect(body.startsWith("## 🌊 rio · Nothing to fix\n")).toBe(true);
    expect(body).toContain("| **0** | **1** |");
    expect(body).toContain("> [!NOTE]");
  });
  it("lists an unanchored finding with its location and no thread link", () => {
    const body = summaryBody({
      ...input(report([four[3]])),
      urls: new Map(),
      unanchored: [four[3]],
    });
    expect(body).toContain(
      "| 1 | `parseHeader` calls `.split` on a missing content type. | `src/parser/header.ts:42` |",
    );
  });
});

describe("comment size limits", () => {
  it("shows ten journeys and says how many more", () => {
    const journeys = Array.from({ length: 14 }, (_, i) => ({
      name: `journey-${i}`,
      cells: [{ viewport: "mobile", color_scheme: "light", outcome: "passed" }],
    }));
    const text = qaSummary({ journeys, recommendations: [] }).join("\n");
    expect(text.match(/^\| `journey-/gm)).toHaveLength(10);
    expect(text).toContain("…and 4 more journeys in the full report");
  });
  it("shows 25 finding rows and counts the rest", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      finding({ id: ID(i.toString(16).padStart(2, "0")) }),
    );
    const body = summaryBody({
      report: { status: "complete", review: {}, findings: many, risks: [] },
      lineage: ID("5e"),
      unanchored: [],
      rejected: [],
      wrong: [],
      link: "",
      failOn: FAIL_ON,
      urls: new Map(),
    });
    expect(body.match(/^\| \d+ \| /gm)).toHaveLength(25);
    expect(body).toContain("…and 15 more in the full report");
  });
  it("truncates folded sections first and never exceeds GitHub's limit", () => {
    const huge = "x".repeat(70_000);
    const lines = [
      "#### 🔴 title",
      "<sub>meta</sub>",
      "",
      "visible",
      "",
      "<details><summary>big</summary>",
      "",
      huge,
      "</details>",
      "",
      "<sub>footer</sub>",
    ];
    const body = fitBody(lines, "<!-- rio:finding:x -->");
    expect(body.length).toBeLessThanOrEqual(COMMENT_LIMIT);
    expect(body).toContain("visible");
    expect(body).toContain("<details><summary>big</summary>");
    expect(body).not.toContain(huge);
    expect(body.endsWith("<sub>footer</sub>\n<!-- rio:finding:x -->")).toBe(
      true,
    );
    const visible = fitBody(
      ["#### t", huge, "<sub>footer</sub>"],
      "<!-- m -->",
    );
    expect(visible.length).toBeLessThanOrEqual(COMMENT_LIMIT);
    expect(visible.endsWith("<sub>footer</sub>\n<!-- m -->")).toBe(true);
    // A finding body built to exceed the limit still fits.
    const long = findingBody(
      finding({
        evidence: Array.from({ length: 10 }, () => "e".repeat(16_000)),
      }),
      { status: "open" },
    );
    expect(long.length).toBeLessThanOrEqual(COMMENT_LIMIT);
  });
});

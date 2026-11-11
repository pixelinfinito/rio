import type { AuthorResponse, Finding } from "../types";
import { policyMatches, validFix } from "../consolidate";
import {
  CATEGORY_WORD,
  GLYPH,
  SEVERITY_WORD,
  proof,
  prover,
  severityGlyph,
} from "./glyphs";
import { qaEvidenceBody } from "./evidence";
import { fitBody } from "./limits";
import {
  cell,
  fence,
  headline,
  paragraph,
  plain,
  sentences,
  where,
} from "./text";

// The inline finding comment (pr-comment-format). Its order is fixed: title,
// one metadata line, one paragraph of why, the fix, folded detail, the reply
// footer, and the hidden identity marker last.

export const findingMarker = (id: string) => `<!-- rio:finding:${id} -->`;
/** Characters of an identity people see and `/rio dismiss` accepts. */
export const DISPLAY_ID_LEN = 8;
const REASONS = ["fixed", "intentional", "irrelevant", "style"];

export interface FindingState {
  status: "open" | "fixed" | "dismissed";
  fixed_in?: string;
  response?: AuthorResponse;
}
export interface BodyOptions {
  /** The repository's `fail_on`, for the `matches fail_on` marker. */
  failOn?: any;
  /** Right-side lines of the anchored file; a fix inside them becomes a suggestion. */
  lines?: Set<number>;
}

/**
 * The lines a GitHub suggestion may replace: the finding's `fix` when every
 * line of it is a right-side line of the diff and it contains the anchor.
 * A multi-line range must be posted as a multi-line comment ending at
 * `line_end`, or the suggestion would replace the wrong lines.
 */
export function suggestionRange(
  f: Finding,
  anchor: number | undefined,
  lines: Set<number> | undefined,
): { line_start: number; line_end: number } | undefined {
  const fix = f.fix;
  if (!fix || !validFix(fix) || anchor === undefined || !lines) return;
  if (anchor < fix.line_start || anchor > fix.line_end) return;
  for (let line = fix.line_start; line <= fix.line_end; line++)
    if (!lines.has(line)) return;
  return { line_start: fix.line_start, line_end: fix.line_end };
}

const lowerFirst = (text: string) =>
  /^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text;

/** The why: the message after its headline, then the trigger, then the impact. */
function why(f: Finding): string {
  const trigger = f.trigger?.trim();
  return paragraph([
    plain(sentences(f.message)[1], 4000),
    trigger &&
      (/^(when|if|on|after|before|while|whenever)\b/i.test(trigger)
        ? `It happens ${lowerFirst(plain(trigger, 2000))}`
        : `Trigger: ${plain(trigger, 2000)}`),
    f.impact && plain(f.impact, 2000),
  ]);
}

function metadata(f: Finding, failOn: any): string {
  const parts = [
    SEVERITY_WORD[f.severity] ?? plain(f.severity, 20),
    CATEGORY_WORD[f.category] ?? plain(f.category, 20),
  ];
  if (f.trace) parts.push(`\`${plain(f.trace.catalog_item, 100)}\``);
  if (f.qa)
    parts.push(`journey \`${plain(f.qa.journey, 100)}\` step ${f.qa.step}`);
  parts.push(proof(f));
  if (f.state === "worsened") parts.push("worse than the base");
  if (failOn && policyMatches(f, failOn)) parts.push("**matches `fail_on`**");
  return `<sub>${parts.join(" · ")}</sub>`;
}

const ROLE_STEP: Record<string, string> = {
  source: "input",
  step: "check",
  sink: "sensitive operation",
};
function traceTable(f: Finding): string[] {
  const trace = f.trace;
  if (!trace?.steps.length) return [];
  return [
    "| | Step | Where |",
    "| --- | --- | --- |",
    ...trace.steps.map((step, i) => {
      const label =
        step.role !== "step"
          ? ROLE_STEP[step.role]
          : trace.change === "weakened"
            ? "weakened check"
            : trace.change === "introduced"
              ? "new path"
              : "check";
      const at = `\`${plain(step.path, 300)}:${step.line_start}\``;
      return step.missing
        ? `| ${i + 1} | ${GLYPH.failed} **${label} removed by this change** | ${at} (base) |`
        : `| ${i + 1} | ${label} | ${at} |`;
    }),
  ];
}

/** Experiments the council ran, with their outcome on each version. */
function experimentBlock(f: Finding): string[] {
  const ran = (f.council?.experiments ?? []).filter((e) => e.run && e.outcome);
  if (!ran.length) return [];
  const text = ran
    .map((e) =>
      [
        `$ ${e.command.map((part) => plain(part, 200)).join(" ")}`,
        ...(["head", "base"] as const)
          .filter((version) => e.outcome?.[version])
          .map((version) => `${version.padEnd(4)}  → ${e.outcome![version]}`),
      ].join("\n"),
    )
    .join("\n\n");
  const marks = fence(text);
  return [`${marks}text`, text, marks];
}

const ANSWER: Record<string, string> = {
  yes: "real",
  no: "not real",
  unknown: "unsure",
};
const CAUSE: Record<string, string> = {
  timeout: "timed out",
  vendor_error: "vendor error",
  budget: "over budget",
  excluded: "excluded",
  unavailable: "unavailable",
  invalid: "invalid answer",
  no_evidence_refs: "no evidence cited",
};
/** The council fold: members, families and per-round answers; never votes. */
function councilFold(f: Finding): string[] {
  const c = f.council;
  if (!c) return [];
  if (c.skipped || !c.decision)
    return [
      `<details><summary><b>Council</b> — skipped · ${c.answered} of ${c.total} members answered</summary>`,
      "",
      "Too few members could answer, so the verifier result stands.",
      "</details>",
    ];
  let changed = false;
  const round = (m: (typeof c.members)[number], n: 1 | 2) => {
    const r = m.rounds?.find((r) => r.round === n);
    if (!r)
      return n === 1 && m.abstained
        ? (CAUSE[m.cause ?? ""] ?? "abstained")
        : "—";
    if (r.cause) return CAUSE[r.cause] ?? "abstained";
    changed ||= !!r.changed;
    return `${ANSWER[r.real ?? "unknown"]}${r.changed ? " ¹" : ""}`;
  };
  const rows = c.members.map(
    (m) =>
      `| ${plain(m.role, 60)} | ${m.family ? plain(m.family, 60) : "—"} | ${round(m, 1)} | ${round(m, 2)} |`,
  );
  return [
    `<details open><summary><b>Council</b> — ${c.decision} · ${c.answered} of ${c.total} members answered${c.partial ? " · partial" : ""}</summary>`,
    "",
    "| Member | Family | Round 1 | Round 2 |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    `<sub>${changed ? "¹ changed position citing evidence. " : ""}Decided by evidence tier (${c.tier ?? "judgment"}). Votes are not counted.</sub>`,
    ...(c.note ? ["", `Council note: ${plain(c.note, 1000)}`] : []),
    ...(c.protection
      ? ["", `Protection cited: ${plain(c.protection, 300)}`]
      : []),
    "</details>",
  ];
}

/** "How rio knows": the prover and what it left behind. */
function provenanceFold(f: Finding): string[] {
  const source = f.source as { tool?: string };
  const lines: string[] = [];
  if (f.verification?.voters)
    lines.push(
      `Blind verifiers: ${f.verification.agreeing} of ${f.verification.voters} agree${f.verification.split ? " (split)" : ""}; blind match ${f.verification.blind_match.join(", ")}.`,
    );
  const refs = (f.qa ? [] : f.evidence).slice(0, 10);
  if (refs.length) {
    const text = refs.map((ref) => plain(ref, 300)).join("\n");
    const marks = fence(text);
    lines.push(...(lines.length ? [""] : []), marks, text, marks);
  }
  if (!lines.length) return [];
  return [
    `<details><summary><b>How rio knows</b> — ${plain(prover(f), 120)}${source.tool ? ", on the head commit" : ""}</summary>`,
    "",
    ...lines,
    "</details>",
  ];
}

/** Other places the finding cites; the commented line is not repeated. */
function otherLocations(f: Finding): string[] {
  if (f.trace || f.qa) return [];
  const seen = new Set([`${f.location.path}:${f.location.line_start}`]);
  const others = f.locations.filter((l) => {
    const key = `${l.path}:${l.line_start}`;
    return !seen.has(key) && seen.add(key);
  });
  if (!others.length) return [];
  return [
    `<details><summary>Same pattern in ${others.length} more place${others.length === 1 ? "" : "s"}</summary>`,
    "",
    ...others.slice(0, 10).map((l) => `- ${where({ location: l })}`),
    ...(others.length > 10 ? [`- …and ${others.length - 10} more`] : []),
    "</details>",
  ];
}

const VIEWPORT: Record<string, string> = { mobile: "📱", desktop: "🖥️" };
/** Viewport × color scheme: which cells of the journey failed. */
function cellTable(f: Finding, qa: any): string[] {
  if (!f.qa) return [];
  const failed = new Set(
    f.locations
      .filter((l) => l.cell)
      .map((l) => `${l.cell!.viewport}/${l.cell!.color_scheme}`),
  );
  const journey = (qa?.journeys ?? []).find(
    (j: any) => j.name === f.qa!.journey,
  );
  // The journey's recorded cells plus every cell the finding failed in.
  const cells: { viewport: string; color_scheme: string; outcome?: string }[] =
    [...(journey?.cells ?? [])];
  for (const l of f.locations)
    if (
      l.cell &&
      !cells.some(
        (c) =>
          c.viewport === l.cell!.viewport &&
          c.color_scheme === l.cell!.color_scheme,
      )
    )
      cells.push(l.cell);
  const viewports = [...new Set(cells.map((c) => c.viewport))];
  const schemes = [...new Set(cells.map((c) => c.color_scheme))];
  if (!viewports.length) return [];
  const value = (viewport: string, scheme: string) => {
    const key = `${viewport}/${scheme}`;
    const c = cells.find(
      (c) => c.viewport === viewport && c.color_scheme === scheme,
    );
    if (failed.has(key)) return `${GLYPH.failed} **step ${f.qa!.step}**`;
    if (!c) return "–";
    if (c.outcome === "failed") return `${GLYPH.failed} failed`;
    if (c.outcome && c.outcome !== "passed") return plain(c.outcome, 30);
    return `${GLYPH.done} passed`;
  };
  return [
    `| | ${viewports.map((v) => `${VIEWPORT[v] ?? ""} ${plain(v, 30)}`.trim()).join(" | ")} |`,
    `| --- | ${viewports.map(() => "---").join(" | ")} |`,
    ...schemes.map(
      (scheme) =>
        `| ${plain(scheme, 30)} | ${viewports.map((v) => value(v, scheme)).join(" | ")} |`,
    ),
  ];
}

/** Base and head screenshots side by side when both have signed links. */
function screenshots(f: Finding, qa: any): string[] {
  const rows = (qa?.evidence?.artifacts ?? []).filter(
    (row: any) =>
      f.evidence.includes(row.id) &&
      row.kind === "screenshot" &&
      (row.version === "base" || row.version === "head"),
  );
  const [base] = qaEvidenceBody(
    qa,
    rows.filter((r: any) => r.version === "base").map((r: any) => r.id),
    true,
  );
  const [head] = qaEvidenceBody(
    qa,
    rows.filter((r: any) => r.version === "head").map((r: any) => r.id),
    true,
  );
  if (!base || !head || !base.startsWith("!") || !head.startsWith("!"))
    return [];
  return [
    "| base | this PR |",
    "| --- | --- |",
    `| ${base} | ${head} |`,
    `| step ${f.qa!.step} on the base | step ${f.qa!.step} on this PR |`,
  ];
}

function evidenceLine(f: Finding, qa: any): string[] {
  if (!f.qa) return [];
  const links = qaEvidenceBody(qa, f.evidence, false);
  if (!links.length) return [];
  const expiry = links.pop()!;
  return [`<sub>Evidence: ${links.join(" · ")} — ${expiry}</sub>`];
}

function footer(f: Finding): string {
  const id = f.id.slice(0, DISPLAY_ID_LEN);
  return `<sub>\`${id}\` · \`${plain(f.rule_id, 150)}\` · Not right? Reply \`/rio dismiss ${id} wrong\` or ${REASONS.map((r) => `\`${r}\``).join(" · ")}</sub>`;
}

/** Blocks joined with one blank line between them. */
function blocks(...parts: string[][]): string[] {
  return parts
    .filter((part) => part.length)
    .flatMap((part, i) => (i ? ["", ...part] : part));
}

/** The open body without its footer and marker, as the closed states fold it. */
function openBody(
  f: Finding,
  qa: any,
  anchor: number | undefined,
  options: BodyOptions,
): string[] {
  const regression =
    !!f.history?.fixed_in && f.history.previous_status === "fixed";
  const title = regression
    ? `#### ${GLYPH.regression} Back again: ${headline(f.message)}`
    : `#### ${severityGlyph(f.severity)} ${headline(f.message)}`;
  const range = suggestionRange(f, anchor, options.lines);
  let fix: string[] = [];
  if (range && f.fix) {
    const marks = fence(f.fix.replacement);
    fix = [`${marks}suggestion`, f.fix.replacement, marks];
  } else if (f.suggested_fix)
    fix = [`Suggested fix: ${plain(f.suggested_fix, 2000)}`];
  const attributed =
    f.qa && anchor !== undefined && anchor !== f.location.line_start
      ? [`Attributed to ${where(f)}; shown at the file's first diff hunk.`]
      : [];
  const reason = why(f);
  return blocks(
    [title, metadata(f, options.failOn)],
    screenshots(f, qa),
    cellTable(f, qa),
    reason ? [reason] : [],
    attributed,
    traceTable(f),
    regression ? historyTable(f) : [],
    experimentBlock(f),
    fix,
    provenanceFold(f),
    councilFold(f),
    otherLocations(f),
    evidenceLine(f, qa),
  );
}

function historyTable(f: Finding): string[] {
  const h = f.history!;
  return [
    "| Review | History |",
    "| --- | --- |",
    `| \`${plain(h.first_seen, 100)}\` | first reported |`,
    `| \`${plain(h.fixed_in!, 100)}\` | fixed |`,
    "| this PR | **brings it back** |",
  ];
}

/** What rio remembers for each answer (finding-history). */
function remembered(reason: string | undefined): string {
  switch (reason) {
    case "wrong":
      return "The answer counts toward this rule's calibration. rio reports the finding again only if it reproduces after the code changes.";
    case "fixed":
      return "rio checks the fix on the next review of this pull request.";
    default:
      return "rio won't report this again while the code is unchanged. The answer counts toward this rule's calibration; it never changes policy.";
  }
}

export function findingBody(
  f: Finding,
  state: FindingState,
  qa?: any,
  anchor?: number,
  options: BodyOptions = {},
): string {
  const open = openBody(f, qa, anchor, options);
  const marker = findingMarker(f.id);
  if (state.status === "open") return fitBody([...open, "", footer(f)], marker);
  const original = [
    "<details><summary>Original finding</summary>",
    "",
    ...open,
    "</details>",
  ];
  const head =
    state.status === "fixed"
      ? [
          state.fixed_in
            ? `${GLYPH.done} **Fixed in \`${plain(state.fixed_in, 100).slice(0, 7)}\`** · verified on the new head`
            : `${GLYPH.done} **Fixed in a later push**`,
          "",
          `~~${headline(f.message)}~~`,
        ]
      : [
          `${GLYPH.dismissed} **Dismissed as \`${plain(state.response?.reason ?? "dismissed", 30)}\`**${state.response?.actor ? ` by ${plain(state.response.actor, 100)}` : ""}`,
          "",
          remembered(state.response?.reason),
          ...(state.response?.note
            ? [
                "",
                `> ${plain(state.response.note, 1000).replace(/\n/g, "\n> ")}`,
              ]
            : []),
        ];
  return fitBody([...head, "", ...original], marker);
}

/** One summary or check-run row's title. */
export function rowTitle(f: Finding, max = 120): string {
  return cell(headline(f.message, max));
}

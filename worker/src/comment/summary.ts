import type { Finding } from "../types";
import { policyMatches } from "../consolidate";
import { GLYPH, severityGlyph, shortProof } from "./glyphs";
import { qaEvidenceBody } from "./evidence";
import { DISPLAY_ID_LEN, rowTitle } from "./finding";
import { MAX_FINDING_ROWS, MAX_JOURNEYS, fitBody } from "./limits";
import { cell, duration, headline, plain, where } from "./text";

// The summary comment (pr-comment-format): one per lineage, edited every
// round. Its title is the verdict and matches the scoreboard; findings are
// grouped by what to do; everything else is folded.

export const summaryMarker = (lineage: string) =>
  `<!-- rio:summary:${lineage} -->`;

/** Every published list of a report, once per identity. */
export const lists = (report: any): Finding[] => {
  const seen = new Set<string>();
  return [
    ...report.findings,
    ...report.risks,
    ...(report.security ?? []),
  ].filter(
    (f: Finding) =>
      !seen.has(f.id) &&
      seen.add(f.id) &&
      (!f.qa || !["fixed", "pre-existing"].includes(f.state)),
  );
};
const open = (report: any) =>
  lists(report).filter((f) => f.status !== "dismissed");

/** The verdict: what must be fixed before merge, and what is worth a look. */
export function verdict(report: any, failOn: any) {
  const all = open(report);
  const toFix = all.filter((f) => policyMatches(f, failOn ?? {}));
  const look = all.filter((f) => !toFix.includes(f));
  return { toFix, look };
}

/** Where the full report lives: the endpoint URL when it is public, else the CLI. */
export function reportLine(link: string, number?: number): string {
  const cli = number ? `\`rio review --pr ${number}\`` : "the Rio CLI";
  return /^https?:\/\//.test(link)
    ? `Full report [${link.replace(/^https?:\/\//, "").slice(0, 120)}](${link}) (needs a Rio API token) or ${cli}`
    : `Full report ${cli}`;
}

/** The provenance line: what was reviewed, how, and the risk tier. */
export function provenance(report: any): string {
  const tier = report.risk_tier;
  const head = String(report.review?.head ?? "").replace(/^snapshot:/, "");
  const parts = [
    head && `\`${plain(head, 64).slice(0, 7)}\``,
    report.lineage?.round &&
      `round ${report.lineage.round}${report.lineage.cap ? ` of ${report.lineage.cap}` : ""}`,
    report.review?.profile && `\`${plain(report.review.profile, 100)}\``,
    report.metrics?.wall_time_ms && duration(report.metrics.wall_time_ms),
    `risk **${plain(tier?.tier ?? "unknown", 20)}**${tier?.reasons?.length ? `: ${tier.reasons.map((r: string) => plain(r, 200)).join("; ")}` : ""}`,
  ].filter(Boolean);
  return `<sub>${parts.join(" · ")}</sub>`;
}

/** The alert under the title; the check run always stays neutral. */
export function alert(report: any, failOn: any): string[] {
  const { toFix } = verdict(report, failOn);
  const lines = toFix.length
    ? [
        "> [!CAUTION]",
        `> **${toFix.length} finding${toFix.length === 1 ? "" : "s"} match${toFix.length === 1 ? "es" : ""} this repository's \`fail_on\` policy.**`,
        "> rio's check run stays neutral. Your branch protection decides whether this blocks the merge.",
      ]
    : [
        "> [!NOTE]",
        lists(report).length
          ? "> No finding matches this repository's `fail_on` policy. rio's check run stays neutral."
          : "> No findings in this change. rio's check run stays neutral.",
      ];
  if (report.status !== "complete")
    lines.push(
      "",
      "> [!WARNING]",
      `> The review is **${plain(report.status, 30)}**: some checks could not run, so earlier findings are not marked fixed. See the full report for what was skipped.`,
    );
  return lines;
}

function qaCells(qa: any): { passed: number; total: number } {
  let passed = 0,
    total = 0;
  for (const journey of qa?.journeys ?? [])
    for (const c of journey.cells ?? []) {
      if (["skipped", "not_run"].includes(c.outcome)) continue;
      total++;
      if (c.outcome === "passed") passed++;
    }
  return { passed, total };
}

/** One row of counts whose first two equal the verdict. */
export function scoreboard(report: any, failOn: any, fixed = 0): string[] {
  const { toFix, look } = verdict(report, failOn);
  const heads = [`${GLYPH.error} To fix`, `${GLYPH.warning} Worth a look`];
  const values = [`**${toFix.length}**`, `**${look.length}**`];
  if (fixed) {
    heads.push(`${GLYPH.done} Fixed`);
    values.push(`**${fixed}** <sub>this round</sub>`);
  }
  const remembered = report.remembered?.length ?? 0;
  if (remembered) {
    heads.push(`${GLYPH.dismissed} Remembered`);
    values.push(`**${remembered}** <sub>dismissals</sub>`);
  }
  if (report.qa) {
    const { passed, total } = qaCells(report.qa);
    heads.push(`${GLYPH.qa} QA cells`);
    values.push(`**${passed}** <sub>/ ${total} passed</sub>`);
  }
  return [
    `| ${heads.join(" | ")} |`,
    `| ${heads.map(() => "---").join(" | ")} |`,
    `| ${values.join(" | ")} |`,
  ];
}

/** "To fix" and "Worth a look", linked to their threads, at most 25 rows. */
export function findingTables(
  report: any,
  failOn: any,
  urls: Map<string, string>,
  numbered = true,
): string[] {
  const { toFix, look } = verdict(report, failOn);
  const lines: string[] = [];
  let n = 0;
  const shown = toFix.length + look.length;
  const table = (title: string, rows: Finding[]) => {
    const room = Math.max(0, MAX_FINDING_ROWS - n);
    if (!rows.length) return;
    lines.push(
      ...(lines.length ? [""] : []),
      `### ${title}`,
      "",
      "| | Finding | Where | Proof |",
      "| --- | --- | --- | --- |",
    );
    for (const f of rows.slice(0, room)) {
      n++;
      const url = urls.get(f.id);
      const title = rowTitle(f);
      lines.push(
        `| ${numbered ? n : severityGlyph(f.severity)} | ${url ? `[${title}](${url})` : title} | ${where(f)} | ${shortProof(f)} |`,
      );
    }
  };
  table(`${GLYPH.error} To fix before merge`, toFix);
  table(`${GLYPH.warning} Worth a look`, look);
  if (shown > n)
    lines.push(`| | …and ${shown - n} more in the full report | | |`);
  return lines;
}

const VIEWPORT: Record<string, string> = { mobile: "📱", desktop: "🖥️" };
/** Why each journey ran, as the provenance line's tail. */
function selected(qa: any): string {
  const rows = (qa.selection ?? []).slice(0, MAX_JOURNEYS);
  if (!rows.length) return "";
  return ` · selected ${rows
    .map(
      (s: any) =>
        `\`${plain(s.journey, 100)}\` (${(s.reasons ?? []).map((r: string) => plain(r, 100)).join(", ")})`,
    )
    .join(", ")}`;
}
/** Journeys × cells, at most ten journeys. */
export function qaSummary(qa: any): string[] {
  if (!qa) return [];
  const journeys = qa.journeys ?? [];
  const columns: [string, string][] = [];
  for (const journey of journeys)
    for (const c of journey.cells ?? [])
      if (!columns.some(([v, s]) => v === c.viewport && s === c.color_scheme))
        columns.push([c.viewport, c.color_scheme]);
  const order = (v: string) => (v === "mobile" ? 0 : v === "desktop" ? 1 : 2);
  const scheme = (s: string) => (s === "light" ? 0 : s === "dark" ? 1 : 2);
  columns.sort(
    (a, b) =>
      order(a[0]) - order(b[0]) ||
      scheme(a[1]) - scheme(b[1]) ||
      a[1].localeCompare(b[1]),
  );
  const lines = [
    "",
    `### ${GLYPH.qa} QA · ${journeys.length} journey${journeys.length === 1 ? "" : "s"} × ${columns.length} cell${columns.length === 1 ? "" : "s"}`,
  ];
  if (journeys.length && columns.length) {
    lines.push(
      "",
      `| Journey | ${columns.map(([v, s]) => `${VIEWPORT[v] ?? plain(v, 20)} ${plain(s, 20)}`).join(" | ")} |`,
      `| --- | ${columns.map(() => "---").join(" | ")} |`,
    );
    for (const journey of journeys.slice(0, MAX_JOURNEYS))
      lines.push(
        `| \`${plain(journey.name, 100)}\` | ${columns
          .map(([v, s]) => {
            const c = (journey.cells ?? []).find(
              (c: any) => c.viewport === v && c.color_scheme === s,
            );
            if (!c) return "–";
            if (c.outcome === "passed") return GLYPH.done;
            if (c.outcome === "failed") {
              const text = `${GLYPH.failed} step ${c.step_reached ?? 0}`;
              const [shot] = qaEvidenceBody(qa, c.evidence ?? [], false);
              const url = shot && /^\[screenshot\]\(<(.+)>\)$/.exec(shot)?.[1];
              return url ? `[${text}](<${url}>)` : text;
            }
            return plain(c.outcome ?? "–", 20);
          })
          .join(" | ")} |`,
      );
    if (journeys.length > MAX_JOURNEYS)
      lines.push(
        `| …and ${journeys.length - MAX_JOURNEYS} more journeys in the full report | ${columns.map(() => "").join(" | ")} |`,
      );
  }
  for (const note of qa.audit?.notes ?? [])
    if (/held back|possibly stale/i.test(note)) lines.push("", plain(note));
  const recommendations = (qa.recommendations ?? []).filter(
    (row: any) =>
      row.verification_status === "supported" &&
      !row.dismissal &&
      !row.related_finding_id,
  );
  const coverage = new Map<string, number>();
  for (const row of qa.assessment ?? [])
    coverage.set(row.status, (coverage.get(row.status) ?? 0) + 1);
  const assessment = `UX assessment (${plain(qa.rubric_version ?? "unknown rubric")}): ${[...coverage].map(([status, count]) => `${plain(status)}: ${count}`).join(", ") || "none recorded"}. Recommendations held back: ${qa.recommendations_held_back ?? 0}.`;
  lines.push(
    "",
    `<details><summary>${GLYPH.advice} <b>${recommendations.length} UX suggestion${recommendations.length === 1 ? "" : "s"}</b> — advice only, never blocks the merge</summary>`,
    "",
  );
  for (const row of recommendations) {
    lines.push(
      `**${plain(row.observed_friction)}** · priority ${plain(row.priority)} · confidence ${plain(row.confidence)}`,
      `Proposed improvement: ${plain(row.proposed_improvement)}`,
      `Expected benefit (untested): ${plain(row.expected_benefit)}`,
      `Trade-offs: ${(row.trade_offs ?? []).map((value: string) => plain(value)).join("; ")}`,
      ...qaEvidenceBody(qa, row.evidence),
    );
    if (row.basis?.guidance)
      lines.push(
        `Guidance: ${plain(row.basis.guidance.path)}:${row.basis.guidance.start_line}-${row.basis.guidance.end_line}`,
      );
    lines.push("");
  }
  lines.push(assessment, "</details>");
  return lines;
}

function whatRan(report: any): string[] {
  const checks = report.checks ?? [];
  const agents = new Set(
    lists(report)
      .map((f) => (f.source as { agent?: string }).agent)
      .filter(Boolean),
  );
  const verified = lists(report).some((f) => f.verification?.voters);
  const councilled = lists(report).filter((f) => f.council).length;
  const parts = [
    `${checks.length} check${checks.length === 1 ? "" : "s"}`,
    `${agents.size} agent${agents.size === 1 ? "" : "s"}`,
    ...(verified ? ["blind verifier"] : []),
    ...(councilled
      ? [`council on ${councilled} finding${councilled === 1 ? "" : "s"}`]
      : []),
  ];
  return [
    `<details><summary><b>What ran:</b> ${parts.join(" · ")}</summary>`,
    "",
    ...(checks.length
      ? checks
          .slice(0, 40)
          .map(
            (c: any) =>
              `- \`${plain(String(c.kind), 40)}\` on \`${plain(String(c.root), 200)}\`: ${plain(String(c.outcome?.outcome ?? c.outcome ?? ""), 40)}`,
          )
      : ["No deterministic checks ran."]),
    ...(agents.size
      ? [
          "",
          `Agents with findings: ${[...agents].map((a) => `\`${plain(a!, 60)}\``).join(", ")}`,
        ]
      : []),
    ...(report.qa
      ? [
          "",
          `QA isolation **${plain(report.qa.isolation ?? "unknown", 40)}** · evidence expires ${plain(report.qa.evidence?.expires_at ?? "at the configured retention deadline", 60)}${selected(report.qa)}`,
        ]
      : []),
    "</details>",
  ];
}

function sinceLast(report: any, fixed: number, wrong: Finding[]): string[] {
  const round = report.lineage?.round;
  const held = report.lineage?.held_back ?? 0;
  const remembered = report.remembered?.length ?? 0;
  if (!(round > 1) && !held && !remembered && !wrong.length) return [];
  const parts = [
    `${fixed} fixed`,
    ...(held ? [`${held} already posted, not repeated`] : []),
    ...(remembered ? [`${remembered} remembered`] : []),
  ];
  return [
    `<details><summary><b>${round > 1 ? `Since round ${round - 1}` : "Earlier answers"}:</b> ${parts.join(" · ")}</summary>`,
    "",
    ...(held
      ? [
          `${held} finding(s) from earlier rounds are already posted and are not repeated.`,
        ]
      : []),
    ...(remembered
      ? [`${remembered} earlier dismissal(s) applied on unchanged code.`]
      : []),
    ...(wrong.length
      ? [
          `${wrong.length} recurring finding(s) earlier dismissed as \`wrong\` are in the report and were not posted.`,
        ]
      : []),
    ...(!held && !remembered && !wrong.length ? ["Nothing else changed."] : []),
    "</details>",
  ];
}

export interface SummaryInput {
  report: any;
  lineage: string;
  unanchored: Finding[];
  rejected: { f: Finding; error: string }[];
  wrong: Finding[];
  link: string;
  failOn: any;
  urls: Map<string, string>;
  /** Earlier findings this round marked fixed. */
  fixed?: number;
}

export function summaryBody(input: SummaryInput): string {
  const { report, failOn } = input;
  const { toFix } = verdict(report, failOn);
  const lines = [
    `## ${GLYPH.rio} rio · ${toFix.length ? `${toFix.length} to fix before merge` : "Nothing to fix"}`,
    provenance(report),
    "",
    ...alert(report, failOn),
    "",
    ...scoreboard(report, failOn, input.fixed ?? 0),
  ];
  const tables = findingTables(report, failOn, input.urls);
  if (tables.length) lines.push("", ...tables);
  const reconsider = report.lineage?.reconsider;
  if (reconsider)
    lines.push(
      "",
      `### Round ${report.lineage.round} exceeds the cap of ${report.lineage.cap}`,
      "",
      `${reconsider.unresolved} agent finding(s) remain unresolved, so new ones are listed here instead of inline. Please reconsider the approach${reconsider.split ? " or split the change" : ""}.`,
      "",
      ...reconsider.top.map(
        (t: any) =>
          `- ${plain(t.title, 200)} (\`${plain(t.path, 300)}:${t.line_start}\`)`,
      ),
      ...(reconsider.split
        ? [
            "",
            "Suggested parts:",
            ...reconsider.split.map((p: string) => `- ${plain(p, 300)}`),
          ]
        : []),
    );
  if (input.unanchored.length)
    lines.push(
      "",
      "<sub>Not on a line of this diff, so listed here only: " +
        input.unanchored
          .slice(0, MAX_FINDING_ROWS)
          .map((f) => `${where(f)} \`${f.id.slice(0, DISPLAY_ID_LEN)}\``)
          .join(" · ") +
        "</sub>",
    );
  if (input.rejected.length)
    lines.push(
      "",
      "### Not posted inline (retried next round)",
      "",
      ...input.rejected.map(
        (r) =>
          `- ${where(r.f)} \`${plain(r.f.rule_id, 150)}\` · ${plain(r.error, 200)} (\`${r.f.id.slice(0, DISPLAY_ID_LEN)}\`)`,
      ),
    );
  lines.push(...qaSummary(report.qa));
  for (const finding of input.unanchored.filter((f) => f.qa))
    lines.push(
      "",
      `<details><summary>${severityGlyph(finding.severity)} QA finding \`${finding.id.slice(0, DISPLAY_ID_LEN)}\`: ${cell(headline(finding.message, 200))}</summary>`,
      "",
      `Journey \`${plain(finding.qa!.journey)}\` step ${finding.qa!.step} · cells ${finding.locations.map((location) => `${location.cell?.viewport}/${location.cell?.color_scheme}`).join(", ")}`,
      "",
      ...qaEvidenceBody(report.qa, finding.evidence, true),
      "</details>",
    );
  const since = sinceLast(report, input.fixed ?? 0, input.wrong);
  if (since.length) lines.push("", ...since);
  lines.push(
    "",
    ...whatRan(report),
    "",
    `<sub>Re-run \`/rio review\` · Answer a finding \`/rio dismiss <id> <reason>\` · ${reportLine(input.link, report.review?.pull_request?.number)}</sub>`,
  );
  return fitBody(lines, summaryMarker(input.lineage));
}

import { redact } from "./redaction";

// SARIF 2.1.0 rendering per docs/sarif-mapping.md. rio-core renders the same
// mapping (crates/rio-core/src/sarif.rs); both are tested against
// tests/fixtures/sarif/, so changes here must be mirrored there.

export interface SarifInputs {
  start_time_utc: string;
  end_time_utc: string;
  // Only the CLI knows its exit code; the endpoint passes null.
  exit_code: number | null;
  include_pre_existing?: boolean;
}

const RISK_PREFIX = "Risk for human judgment: ";

function scrub(value: any): any {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, scrub(v)]),
    );
  return value;
}

function region(location: any) {
  return {
    startLine: location.line_start,
    endLine: location.line_end,
    ...(location.column == null ? {} : { startColumn: location.column }),
  };
}

function result(entry: any, risk: boolean, ruleIndex: number) {
  const note = risk || entry.evidence_level === "plausible";
  const level = note
    ? "note"
    : entry.severity === "error"
      ? "error"
      : entry.severity === "warning"
        ? "warning"
        : "note";
  let text = `${note ? RISK_PREFIX : ""}${entry.message ?? ""}`;
  if (entry.trigger) text += `\nTrigger: ${entry.trigger}`;
  const locations: any[] = entry.locations?.length
    ? entry.locations
    : [entry.location];
  const properties: Record<string, unknown> = {
    evidence_level: entry.evidence_level,
    category: risk ? "risk" : entry.category,
    state: entry.state,
    severity: entry.severity,
  };
  for (const key of [
    "status",
    "verification",
    "round",
    "author_response",
    "history",
    "council",
  ])
    if (entry[key] != null) properties[key] = entry[key];
  const baseline = (
    {
      new: "new",
      worsened: "new",
      "pre-existing": "unchanged",
      fixed: "absent",
    } as Record<string, string>
  )[entry.state];
  return {
    ruleId: entry.rule_id,
    ruleIndex,
    level,
    message: { text },
    locations: locations.map((l) => ({
      physicalLocation: {
        artifactLocation: { uri: l.path, uriBaseId: "SRCROOT" },
        region: region(l),
      },
    })),
    partialFingerprints: { "rioFindingId/v1": entry.id },
    ...(baseline ? { baselineState: baseline } : {}),
    properties,
  };
}

/** The check outcome as the footer and the CLI show it: `skipped (tool_missing)`. */
function outcomeLabel(check: any): string {
  return check.reason ? `${check.outcome} (${check.reason})` : check.outcome;
}

/** Renders a report-v1 document as one SARIF 2.1.0 log. */
export function renderSarif(report: any, inputs: SarifInputs) {
  const rules: any[] = [];
  const results: any[] = [];
  const error = report.status === "error";
  if (!error)
    for (const [list, risk] of [
      ["findings", false],
      ["risks", true],
      ["security", false],
    ] as const)
      for (const entry of report[list] ?? []) {
        if (entry.state === "pre-existing" && !inputs.include_pre_existing)
          continue;
        let index = rules.findIndex((r) => r.id === entry.rule_id);
        if (index < 0) {
          rules.push({
            id: entry.rule_id,
            shortDescription: { text: entry.message },
            properties: { category: risk ? "risk" : entry.category },
          });
          index = rules.length - 1;
        }
        results.push(result(entry, risk, index));
      }
  const invocation: Record<string, unknown> = {
    executionSuccessful: !error,
    ...(inputs.exit_code == null ? {} : { exitCode: inputs.exit_code }),
    startTimeUtc: inputs.start_time_utc,
    endTimeUtc: inputs.end_time_utc,
  };
  if (report.incomplete?.length)
    invocation.toolExecutionNotifications = report.incomplete.map(
      (check: any) => ({
        level: "warning",
        descriptor: { id: check.kind },
        message: {
          text: `${check.kind} ${check.root} ${check.version}: ${outcomeLabel(check)}${check.hint ? ` — ${check.hint}` : ""}`,
        },
      }),
    );
  if (error && report.error)
    invocation.properties = {
      error: { code: report.error.code, message: report.error.message },
    };
  return scrub({
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "rio",
            version: report.review?.rio_version,
            informationUri: "https://github.com/pixelinfinito/rio",
            rules,
          },
        },
        originalUriBaseIds: {
          SRCROOT: { description: { text: "Repository root" } },
        },
        results,
        invocations: [invocation],
        properties: {
          "rio.status": report.status,
          "rio.risk_tier": report.risk_tier ?? null,
          "rio.review_id": report.review?.id ?? null,
          ...(report.lineage ? { "rio.lineage": report.lineage } : {}),
          ...(report.council ? { "rio.council": report.council } : {}),
        },
      },
    ],
  });
}

/** RFC 3339 UTC with second precision, as the CLI writes it. */
export function utc(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

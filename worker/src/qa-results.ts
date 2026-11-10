/** Convert retained controller artifacts into the report contract. A successful
 * journey is independent of UX coverage, advice and unverified observations. */
import {
  selectRecommendations,
  type Recommendation,
} from "./qa-recommendations";
import { invariant } from "./validation";
import type { Env } from "./types";

/** Use the authoritative ledgers, including baseline and QA verifier turns.
 * Missing pricing or unresolved usage never becomes a zero-cost assertion. */
export async function qaUsage(env: Env, review: string) {
  const { results } = await env.DB.prepare(
    `
    SELECT charged_tokens AS tokens, cost_usd, state='completed' AND estimated=0 AS known
    FROM qa_model_usage WHERE run_id IN (SELECT id FROM qa_runs WHERE review_id=?)
    UNION ALL
    SELECT input_tokens+output_tokens AS tokens, cost_usd, status='completed' AS known
    FROM usage WHERE review_id=? AND phase LIKE 'verify-qa-%'
  `,
  )
    .bind(review, review)
    .all<{ tokens: number | null; cost_usd: number | null; known: number }>();
  return {
    tokens: results.every((row) => row.known && row.tokens !== null)
      ? results.reduce((sum, row) => sum + row.tokens!, 0)
      : null,
    usd: results.every((row) => row.known && row.cost_usd !== null)
      ? results.reduce((sum, row) => sum + row.cost_usd!, 0)
      : null,
  };
}

const fields = (value: any, keys: string[]) =>
  Object.fromEntries(
    keys
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, value[key]]),
  );
const states = ["failed", "cancelled", "not_run", "skipped", "passed"];
export function qaReport(
  result: any,
  options: Record<string, any>,
  storage: "hosted" | "local" = "hosted",
) {
  invariant(
    result && Array.isArray(result.journey_outcomes),
    "invalid QA controller result",
  );
  const groups = new Map<string, any[]>();
  for (const outcome of result.journey_outcomes) {
    invariant(
      typeof outcome.journey === "string" &&
        states.includes(outcome.outcome) &&
        outcome.cell,
      "invalid QA journey outcome",
    );
    const rows = groups.get(outcome.journey) ?? [];
    rows.push({
      ...outcome.cell,
      outcome: outcome.outcome,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
      step_reached:
        outcome.failed_step ??
        Math.max(
          0,
          ...(outcome.steps ?? []).map((step: any) => step.step),
          ...(result.evidence?.artifacts ?? [])
            .filter(
              (artifact: any) =>
                artifact.sanitized &&
                artifact.journey === outcome.journey &&
                artifact.cell?.viewport === outcome.cell.viewport &&
                artifact.cell?.color_scheme === outcome.cell.color_scheme &&
                outcome.evidence?.includes(artifact.id) &&
                Number.isSafeInteger(artifact.step),
            )
            .map((artifact: any) => artifact.step),
        ),
      evidence: outcome.evidence ?? [],
    });
    groups.set(outcome.journey, rows);
  }
  const recommendations = selectRecommendations(
    (result.qa_recommendations ?? []) as Recommendation[],
    { max: options.max_recommendations ?? 5 },
  );
  const expires = (result.evidence?.artifacts ?? [])
    .map((artifact: any) => Number(artifact.expires_at))
    .filter((value: number) => Number.isFinite(value) && value > 0);
  return {
    mode: options.mode ?? "changed",
    harness: result.harness ?? options.harness ?? "codex",
    isolation: result.policy?.app_isolation === "none" ? "none" : "pod",
    audit: {
      notes: result.audit_notes ?? [],
      harness_auth: result.harness_auth ?? "unknown",
      egress: result.policy?.egress ?? "not_run",
      quota_bytes: result.evidence?.quota_bytes ?? null,
      quota_reached: result.evidence?.quota_reached ?? false,
    },
    selection: Object.entries(result.plan?.selected ?? {}).map(
      ([journey, reasons]) => ({ journey, reasons }),
    ),
    journeys: [...groups].map(([name, cells]) => ({
      name,
      outcome: states.find((state) =>
        cells.some((cell) => cell.outcome === state),
      ),
      cells,
    })),
    observations_unverified: (result.hypotheses ?? []).map((row: any) =>
      fields(row, [
        "rule_id",
        "kind",
        "journey",
        "step",
        "cell",
        "route",
        "expected",
        "observed",
        "evidence",
        "suggested_fix",
      ]),
    ),
    recommendations: recommendations.recommendations,
    assessment: result.ux_assessment ?? [],
    guidance: result.guidance ?? [],
    rubric_version: "rio/ui-v1@0.1.0",
    recommendations_held_back: recommendations.held_back,
    recommendations_dropped: result.journey_outcomes.reduce(
      (sum: number, row: any) =>
        sum +
        (Array.isArray(row.dropped)
          ? row.dropped.filter((drop: any) =>
              /recommendation|advice/.test(drop.reason ?? ""),
            ).length
          : Object.entries(row.dropped ?? {}).reduce(
              (count, [reason, value]) =>
                count +
                (/recommendation|advice/.test(reason) &&
                Number.isSafeInteger(value) &&
                Number(value) > 0
                  ? Number(value)
                  : 0),
              0,
            )),
      0,
    ),
    seed: result.seed ?? { status: "not_run", duration_ms: 0 },
    evidence: {
      storage,
      expires_at: expires.length
        ? new Date(Math.min(...expires)).toISOString()
        : null,
      bytes: result.evidence?.bytes ?? 0,
      artifacts: (result.evidence?.artifacts ?? []).map((artifact: any) =>
        fields(artifact, ["id", "kind", "expires_at"]),
      ),
    },
    cost: {
      wall_time_ms: result.wall_time_ms ?? 0,
      tokens: Number.isSafeInteger(result.tokens) ? result.tokens : null,
      usd: null,
    },
  };
}

/** Kept separate from the report so evidence keys, raw candidates and decisions
 * survive report caps or a cancelled downstream verifier. */
export function qaRecords(result: any) {
  return {
    "plan.json": result.plan ?? {},
    "outcomes.json": result.journey_outcomes,
    "manifest.json": result.evidence ?? {},
    "recommendations.json": result.qa_recommendations ?? [],
    "assessment.json": result.ux_assessment ?? [],
    "observations.json": result.hypotheses ?? [],
    "observation-candidates.json": result.observation_candidates ?? [],
    "audit.json": result.audit_notes ?? [],
    ...(result.baseline ? { "baseline.json": result.baseline } : {}),
  };
}

/** Mirror the host's cell-aware classification. A completed journey does not
 * imply a particular rule was assessed: only trusted probe records count. */
export function compareQaResults(head: any, base: any) {
  const cellKey = (cell: any) =>
    JSON.stringify([cell.viewport, cell.color_scheme]);
  const assessmentKey = (row: any, cell = row.cell) =>
    JSON.stringify([row.rule_id, row.journey, row.step, cellKey(cell)]);
  const assessed = (result: any) =>
    new Set(
      (result.probe_assessments ?? []).map((row: any) => assessmentKey(row)),
    );
  const baseAssessed = assessed(base),
    headAssessed = assessed(head);
  const groups = new Map<string, { head: any[]; base: any[] }>();
  for (const [version, result] of [
    ["head", head],
    ["base", base],
  ] as const) {
    for (const finding of result.findings ?? []) {
      invariant(
        finding.category === "ux" && finding.qa && finding.locations?.length,
        "invalid QA baseline finding",
      );
      const group = groups.get(finding.id) ?? { head: [], base: [] };
      group[version].push(finding);
      groups.set(finding.id, group);
    }
  }
  const findings = [...groups.values()]
    .map((group) => {
      const finding = structuredClone(group.head[0] ?? group.base[0]);
      const cells = (rows: any[]) => {
        const result = new Map<string, any>();
        for (const row of rows)
          for (const occurrence of row.locations) {
            invariant(
              occurrence.cell && occurrence.evidence?.length,
              "invalid QA occurrence",
            );
            const key = cellKey(occurrence.cell),
              previous = result.get(key);
            if (previous)
              previous.evidence = [
                ...new Set([...previous.evidence, ...occurrence.evidence]),
              ].sort();
            else result.set(key, structuredClone(occurrence));
          }
        return result;
      };
      const before = cells(group.base),
        after = cells(group.head);
      const key = (cell: any) =>
        assessmentKey({ ...finding.qa, rule_id: finding.rule_id }, cell);
      finding.locations = [...after].map(([id, occurrence]) => ({
        ...occurrence,
        occurrence_state: before.has(id)
          ? "pre-existing"
          : baseAssessed.has(key(occurrence.cell))
            ? "new"
            : "unclassified",
      }));
      for (const [id, occurrence] of before)
        if (!after.has(id))
          finding.locations.push({
            ...occurrence,
            occurrence_state: headAssessed.has(key(occurrence.cell))
              ? "fixed"
              : "unclassified",
          });
      const states = new Set(
        finding.locations.map((row: any) => row.occurrence_state),
      );
      finding.state = states.has("unclassified")
        ? "unclassified"
        : states.has("new") && states.has("pre-existing")
          ? "worsened"
          : states.has("new")
            ? "new"
            : states.has("pre-existing")
              ? "pre-existing"
              : "fixed";
      finding.evidence = [
        ...new Set(finding.locations.flatMap((row: any) => row.evidence)),
      ].sort();
      finding.location = structuredClone(
        finding.locations.find((row: any) =>
          ["new", "unclassified"].includes(row.occurrence_state),
        ) ?? finding.locations[0],
      );
      finding.qa.attribution =
        [...group.head, ...group.base].find((row) =>
          row.locations.some(
            (location: any) =>
              location.path === finding.location.path &&
              cellKey(location.cell) === cellKey(finding.location.cell),
          ),
        )?.qa.attribution ?? "journey";
      delete finding.location.cell;
      delete finding.location.evidence;
      delete finding.location.id;
      finding.qa.element_paths = [
        ...new Set(
          [...group.head, ...group.base].flatMap((row) => row.qa.element_paths),
        ),
      ].sort();
      return finding;
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    ...head,
    head_evidence: head.head_evidence ?? head.evidence,
    findings,
    baseline: base,
    audit_notes: [
      ...(head.audit_notes ?? []),
      ...(base.audit_notes ?? []).map((note: string) => `Baseline: ${note}`),
    ],
    outcome:
      head.outcome === "complete" && base.outcome === "complete"
        ? "complete"
        : "partial",
    evidence: {
      ...head.evidence,
      quota_reached: !!(
        head.evidence?.quota_reached || base.evidence?.quota_reached
      ),
      bytes: (head.evidence?.bytes ?? 0) + (base.evidence?.bytes ?? 0),
      artifacts: [
        ...(head.evidence?.artifacts ?? []),
        ...(base.evidence?.artifacts ?? []),
      ],
    },
    wall_time_ms: (head.wall_time_ms ?? 0) + (base.wall_time_ms ?? 0),
    tokens:
      Number.isSafeInteger(head.tokens) && Number.isSafeInteger(base.tokens)
        ? head.tokens + base.tokens
        : null,
  };
}

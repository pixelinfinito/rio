import type { Env } from "./types";
import { canonical, hash } from "./validation";

// Suppression proposals (openspec rio-v0-3-core, suppression-proposals).
// Computed from feedback when a review finishes; never applied by the
// endpoint. Only `rio suppressions apply` writes the entry, into the
// repository's profile, after a human confirms it.

const DAY = 24 * 60 * 60 * 1000;
export const PROPOSAL_WINDOW = 90 * DAY;
export const DECLINE_PAUSE = 180 * DAY;
/** Reasons that count; wrong is calibration, fixed is success, intentional is per instance. */
export const PROPOSING_REASONS = ["irrelevant", "style"];

export type Entry = { rule: string } | { path: string };
export interface Evidence {
  finding: string;
  reason: string;
  actor: string | null;
  at: string;
}
interface Response {
  finding_id: string;
  reason: string;
  actor: string | null;
  created_at: number;
  rule_id: string;
  location_json: string;
}
interface Row {
  id: string;
  repository: string;
  status: "proposed" | "applied" | "declined";
  entry_json: string;
  evidence_json: string;
  evidence_count: number;
  note: string | null;
  created_at: number;
  decided_at: number | null;
}

export function proposalId(
  tenant: string,
  repository: string,
  entry: Entry,
): string {
  return `sp-${hash(`${tenant}\0${repository}\0${canonical(entry)}`).slice(0, 12)}`;
}

/**
 * Candidate entries from the latest response per finding: a rule dismissed
 * `irrelevant` or `style` at least `threshold` times, and a directory with
 * that many such responses over differing rule ids.
 */
export function candidates(responses: Response[], threshold: number) {
  const latest = new Map<string, Response>();
  for (const r of [...responses].sort((a, b) => a.created_at - b.created_at))
    latest.set(r.finding_id, r);
  const counted = [...latest.values()].filter((r) =>
    PROPOSING_REASONS.includes(r.reason),
  );
  const evidence = (r: Response): Evidence => ({
    finding: r.finding_id,
    reason: r.reason,
    actor: r.actor,
    at: new Date(r.created_at).toISOString(),
  });
  const byRule = new Map<string, Response[]>();
  const byDirectory = new Map<string, Response[]>();
  for (const r of counted) {
    byRule.set(r.rule_id, [...(byRule.get(r.rule_id) ?? []), r]);
    const path: string = JSON.parse(r.location_json).path ?? "";
    const directory = path.includes("/")
      ? path.split("/").slice(0, -1).join("/")
      : "";
    if (directory)
      byDirectory.set(directory, [...(byDirectory.get(directory) ?? []), r]);
  }
  const result: { entry: Entry; evidence: Evidence[] }[] = [];
  for (const [rule, list] of [...byRule].sort(([a], [b]) => a.localeCompare(b)))
    if (list.length >= threshold)
      result.push({ entry: { rule }, evidence: list.map(evidence) });
  for (const [directory, list] of [...byDirectory].sort(([a], [b]) =>
    a.localeCompare(b),
  ))
    if (
      list.length >= threshold &&
      new Set(list.map((r) => r.rule_id)).size > 1
    )
      result.push({
        entry: { path: `${directory}/**` },
        evidence: list.map(evidence),
      });
  return result;
}

/**
 * Records proposals for a repository and returns its open ones for the
 * report. A declined entry is not proposed again for 180 days; an applied
 * entry is never proposed again.
 */
export async function updateProposals(
  env: Env,
  tenant: string,
  repository: string,
  threshold: number,
  now = Date.now(),
) {
  // Responses recorded before migration 0005 carry no repository and are
  // attributed by identity alone.
  const responses = await env.DB.prepare(
    "SELECT f.finding_id,f.reason,f.actor,f.created_at,h.rule_id,h.location_json FROM feedback f JOIN finding_history h ON h.tenant=f.tenant AND h.identity=f.finding_id AND (f.repository IS NULL OR f.repository=h.repository) WHERE f.tenant=? AND h.repository=? AND f.created_at>=?",
  )
    .bind(tenant, repository, now - PROPOSAL_WINDOW)
    .all<Response>();
  const existing = new Map(
    (
      await env.DB.prepare(
        "SELECT * FROM suppressions WHERE tenant=? AND repository=?",
      )
        .bind(tenant, repository)
        .all<Row>()
    ).results.map((r) => [r.entry_json, r]),
  );
  const statements: D1PreparedStatement[] = [];
  for (const { entry, evidence } of candidates(responses.results, threshold)) {
    const key = canonical(entry),
      row = existing.get(key);
    if (row?.status === "applied") continue;
    if (
      row?.status === "declined" &&
      (row.decided_at ?? 0) > now - DECLINE_PAUSE
    )
      continue;
    if (row)
      statements.push(
        env.DB.prepare(
          "UPDATE suppressions SET status='proposed',evidence_json=?,evidence_count=?,note=CASE WHEN status='declined' THEN NULL ELSE note END,created_at=CASE WHEN status='declined' THEN ? ELSE created_at END,decided_at=CASE WHEN status='declined' THEN NULL ELSE decided_at END WHERE id=? AND tenant=?",
        ).bind(JSON.stringify(evidence), evidence.length, now, row.id, tenant),
      );
    else
      statements.push(
        env.DB.prepare(
          "INSERT INTO suppressions(id,tenant,repository,origin,status,entry_json,evidence_json,evidence_count,created_at) VALUES(?,?,?,'proposed','proposed',?,?,?,?) ON CONFLICT DO NOTHING",
        ).bind(
          proposalId(tenant, repository, entry),
          tenant,
          repository,
          key,
          JSON.stringify(evidence),
          evidence.length,
          now,
        ),
      );
  }
  if (statements.length) await env.DB.batch(statements);
  const open = await env.DB.prepare(
    "SELECT id,entry_json,evidence_count,created_at FROM suppressions WHERE tenant=? AND repository=? AND status='proposed' ORDER BY created_at,id",
  )
    .bind(tenant, repository)
    .all<Row>();
  return open.results.map((r) => ({
    id: r.id,
    entry: JSON.parse(r.entry_json) as Entry,
    evidence_count: r.evidence_count,
    since: new Date(r.created_at).toISOString(),
  }));
}

/** `GET /v1/suppressions` record form. */
export function publicProposal(row: Row) {
  return {
    id: row.id,
    repository: row.repository,
    entry: JSON.parse(row.entry_json),
    status: row.status,
    evidence_count: row.evidence_count,
    evidence: JSON.parse(row.evidence_json),
    ...(row.note ? { note: row.note } : {}),
    created_at: new Date(row.created_at).toISOString(),
    ...(row.decided_at
      ? { decided_at: new Date(row.decided_at).toISOString() }
      : {}),
  };
}

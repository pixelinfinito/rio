import type {
  AuthorResponse,
  Env,
  Finding,
  FindingHistory,
  Graph,
  LifecycleStatus,
  Location,
} from "./types";
import { hash } from "./validation";

// The repository finding registry (openspec rio-v0-3-core, finding-history).
// One `finding_history` row per tenant, repository and identity, updated from
// every finished review. Its `dismissed_in` column holds where the recorded
// status was set: the dismissing pull request or review for `dismissed`, the
// fixing review for `fixed`.

/** Responses that remember a dismissal on unchanged code. `wrong` never does. */
export const REMEMBERED_REASONS = ["intentional", "irrelevant", "style"];

export interface RegistryRecord {
  identity: string;
  rule_id: string;
  first_seen_review: string;
  last_seen_review: string;
  seen_count: number;
  status: LifecycleStatus;
  author_response_json: string | null;
  dismissed_in: string | null;
  location_json: string;
  code_hash: string | null;
  updated_at: number;
}

/**
 * Hash of the normalized text of the symbol enclosing a location: the
 * smallest head graph node containing it, else the location's own lines.
 * Whitespace and blank lines do not change it.
 */
export function codeHash(
  location: Pick<Location, "path" | "line_start" | "line_end">,
  graph: Graph,
  text: string | null,
): string | null {
  if (text === null) return null;
  const node = graph.nodes
    .filter(
      (n) =>
        n.path === location.path &&
        n.line_start <= location.line_start &&
        n.line_end >= location.line_end,
    )
    .sort(
      (a, b) =>
        a.line_end - a.line_start - (b.line_end - b.line_start) ||
        a.line_start - b.line_start,
    )[0];
  const [start, end] = node
    ? [node.line_start, node.line_end]
    : [location.line_start, location.line_end];
  const normalized = text
    .split("\n")
    .slice(start - 1, end)
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join("\n");
  return hash(`${location.path}\0${normalized}`);
}

/** Where a lineage's dismissals are said to come from: `repo#41` for PRs. */
export function origin(
  lineage: { repository: string; kind: string; ref: string } | null,
  review: string,
): string {
  return lineage?.kind === "pr"
    ? `${lineage.repository}#${lineage.ref}`
    : review;
}

export async function loadRecords(
  env: Env,
  tenant: string,
  repository: string,
  identities: string[],
): Promise<RegistryRecord[]> {
  const records: RegistryRecord[] = [];
  const ids = [...new Set(identities)];
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const rows = await env.DB.prepare(
      `SELECT * FROM finding_history WHERE tenant=? AND repository=? AND identity IN (${chunk.map(() => "?").join(",")})`,
    )
      .bind(tenant, repository, ...chunk)
      .all<RegistryRecord>();
    records.push(...rows.results);
  }
  return records;
}

export function historyOf(record: RegistryRecord): FindingHistory {
  const response = record.author_response_json
    ? (JSON.parse(record.author_response_json) as AuthorResponse)
    : undefined;
  return {
    first_seen: record.first_seen_review,
    last_seen: record.last_seen_review,
    seen_count: record.seen_count,
    previous_status: record.status,
    ...(response ? { previous_response: response } : {}),
    ...(record.status === "dismissed" && record.dismissed_in
      ? { dismissed_in: record.dismissed_in }
      : {}),
    ...(record.status === "fixed" && record.dismissed_in
      ? { fixed_in: record.dismissed_in }
      : {}),
  };
}

export interface HistoryOutcome {
  remembered: string[];
  regressions: string[];
}
/**
 * Applies the registry to a consolidated report, after profile suppressions:
 * findings dismissed `intentional`, `irrelevant` or `style` on an unchanged
 * enclosing symbol move to `report.remembered`; every other recurrence keeps
 * its place and carries `history`. Identities answered in the review's own
 * lineage are left to the lineage rules.
 */
export function applyHistory(
  report: any,
  records: RegistryRecord[],
  hashes: Map<string, string | null>,
  answeredInLineage: Set<string> = new Set(),
): HistoryOutcome {
  const byId = new Map(records.map((r) => [r.identity, r]));
  const outcome: HistoryOutcome = { remembered: [], regressions: [] };
  const remembered: Finding[] = [];
  for (const key of ["findings", "risks", "security"] as const) {
    const list: Finding[] | undefined = report[key];
    if (!list) continue;
    report[key] = list.flatMap((f) => {
      const record = byId.get(f.id);
      if (!record) return [f];
      const history = historyOf(record);
      const current = hashes.get(f.id);
      if (
        record.status === "dismissed" &&
        REMEMBERED_REASONS.includes(history.previous_response?.reason ?? "") &&
        record.code_hash !== null &&
        current != null &&
        current === record.code_hash &&
        !answeredInLineage.has(f.id)
      ) {
        if (!outcome.remembered.includes(f.id)) {
          outcome.remembered.push(f.id);
          remembered.push({ ...f, history });
        }
        return [];
      }
      if (record.status === "fixed") outcome.regressions.push(f.id);
      return [{ ...f, history }];
    });
  }
  // An emptied security list stays absent, as consolidation leaves it.
  if (Array.isArray(report.security) && !report.security.length)
    delete report.security;
  if (!outcome.remembered.length) return outcome;
  const gone = new Set(outcome.remembered);
  report.remembered = [...(report.remembered ?? []), ...remembered];
  for (const check of report.checks ?? [])
    if (Array.isArray(check.findings))
      check.findings = check.findings.filter((f: Finding) => !gone.has(f.id));
  for (const check of report.incomplete ?? [])
    if (Array.isArray(check.findings))
      check.findings = check.findings.filter((f: Finding) => !gone.has(f.id));
  // Fail policies never see remembered findings.
  const audit = report.agent_audit;
  if (audit && Array.isArray(audit.policy_matches)) {
    audit.policy_matches = audit.policy_matches.filter(
      (id: string) => !gone.has(id),
    );
    audit.policy_failed = audit.policy_matches.length > 0;
  }
  return outcome;
}
export interface Sighting {
  finding: Finding;
  code_hash: string | null;
}
/**
 * Registry writes for a finished review: every produced or remembered
 * identity is seen once more. A dismissal is kept with its code hash; a
 * lineage dismissal or a new sighting records the current hash; a fixed
 * identity that reappears is open again.
 */
export function registryStatements(
  env: Env,
  tenant: string,
  repository: string,
  review: string,
  dismissedIn: string,
  sightings: Sighting[],
  records: RegistryRecord[],
  fixed: { id: string; code_hash: string | null }[],
  now = Date.now(),
): D1PreparedStatement[] {
  const byId = new Map(records.map((r) => [r.identity, r]));
  const statements: D1PreparedStatement[] = [];
  const seen = new Set<string>();
  for (const { finding: f, code_hash } of sightings) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    const record = byId.get(f.id);
    let status: LifecycleStatus = "open",
      response: string | null = null,
      where: string | null = null,
      codeHash = code_hash;
    if (f.status === "dismissed" && f.author_response) {
      // A lineage dismissal; the registry already holds it when the feedback
      // endpoint recorded it, with the hash of the head it was given on.
      status = "dismissed";
      response = JSON.stringify(f.author_response);
      const known =
        record?.status === "dismissed" &&
        record.author_response_json === response;
      where = known ? record.dismissed_in : dismissedIn;
      if (known) codeHash = record.code_hash;
    } else if (record?.status === "dismissed") {
      status = "dismissed";
      response = record.author_response_json;
      where = record.dismissed_in;
      codeHash = record.code_hash;
    }
    statements.push(
      env.DB.prepare(
        "INSERT INTO finding_history(tenant,repository,identity,rule_id,first_seen_review,last_seen_review,seen_count,status,author_response_json,dismissed_in,location_json,code_hash,updated_at) VALUES(?,?,?,?,?,?,1,?,?,?,?,?,?) ON CONFLICT(tenant,repository,identity) DO UPDATE SET rule_id=excluded.rule_id,seen_count=CASE WHEN finding_history.last_seen_review=excluded.last_seen_review THEN finding_history.seen_count ELSE finding_history.seen_count+1 END,last_seen_review=excluded.last_seen_review,status=excluded.status,author_response_json=excluded.author_response_json,dismissed_in=excluded.dismissed_in,location_json=excluded.location_json,code_hash=excluded.code_hash,updated_at=excluded.updated_at",
      ).bind(
        tenant,
        repository,
        f.id,
        f.rule_id,
        review,
        review,
        status,
        response,
        where,
        JSON.stringify(f.location),
        codeHash,
        now,
      ),
    );
  }
  for (const { id, code_hash } of fixed)
    if (!seen.has(id))
      statements.push(
        env.DB.prepare(
          "UPDATE finding_history SET status='fixed',author_response_json=NULL,dismissed_in=?,code_hash=COALESCE(?,code_hash),updated_at=? WHERE tenant=? AND repository=? AND identity=? AND status='open'",
        ).bind(review, code_hash, now, tenant, repository, id),
      );
  return statements;
}

/** `GET /v1/findings` record form. */
export function publicRecord(row: RegistryRecord & { repository: string }) {
  const history = historyOf(row);
  return {
    identity: row.identity,
    repository: row.repository,
    rule_id: row.rule_id,
    status: row.status,
    first_seen: row.first_seen_review,
    last_seen: row.last_seen_review,
    seen_count: row.seen_count,
    location: JSON.parse(row.location_json),
    ...(history.previous_response
      ? { author_response: history.previous_response }
      : {}),
    ...(history.dismissed_in ? { dismissed_in: history.dismissed_in } : {}),
    ...(history.fixed_in ? { fixed_in: history.fixed_in } : {}),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

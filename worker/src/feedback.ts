import type { AuthorResponse, Env, Finding, ResponseReason } from "./types";
import { lineageId } from "./lineage";

/** Characters of an identity shown to people and the shortest prefix accepted. */
export const DISPLAY_ID_LEN = 8;

export type PrefixMatch =
  | { kind: "found"; identity: string; finding?: Finding }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "short" }
  | { kind: "none" };

/**
 * Resolves a finding id given by a person: the full identity or a prefix of
 * at least eight characters matching exactly one finding. With a lineage only
 * its current generation's posted findings count (`/rio dismiss`); without
 * one, the tenant's posted findings and its registry (`rio feedback` and
 * `POST /v1/findings/{id}/feedback`). Shared so every entry point resolves
 * the same id the same way.
 */
export async function resolvePrefix(
  env: Env,
  tenant: string,
  prefix: string,
  lineage?: string,
): Promise<PrefixMatch> {
  prefix = prefix.toLowerCase();
  if (prefix.length < DISPLAY_ID_LEN) return { kind: "short" };
  if (!/^[a-f0-9]{8,64}$/.test(prefix)) return { kind: "none" };
  const rows = lineage
    ? await env.DB.prepare(
        "SELECT DISTINCT f.identity,f.finding_json FROM findings f JOIN lineages l ON l.id=f.lineage_id AND l.generation=f.generation WHERE f.tenant=? AND f.lineage_id=? AND f.first_posted_in IS NOT NULL AND substr(f.identity,1,?)=? LIMIT 11",
      )
        .bind(tenant, lineage, prefix.length, prefix)
        .all<{ identity: string; finding_json: string | null }>()
    : await env.DB.prepare(
        "SELECT identity,NULL AS finding_json FROM findings WHERE tenant=? AND first_posted_in IS NOT NULL AND substr(identity,1,?)=? UNION SELECT identity,NULL AS finding_json FROM finding_history WHERE tenant=? AND substr(identity,1,?)=? LIMIT 11",
      )
        .bind(tenant, prefix.length, prefix, tenant, prefix.length, prefix)
        .all<{ identity: string; finding_json: string | null }>();
  const identities = [...new Set(rows.results.map((row) => row.identity))];
  if (identities.length === 0) return { kind: "none" };
  if (identities.length > 1)
    return { kind: "ambiguous", candidates: identities.sort() };
  const json = rows.results[0].finding_json;
  return {
    kind: "found",
    identity: identities[0],
    ...(json ? { finding: JSON.parse(json).finding } : {}),
  };
}

/**
 * Writes an author response to a posted lineage finding, or to the
 * repository registry's latest record of the identity, and the feedback
 * record. Shared by `POST /v1/findings/{id}/feedback`, `rio feedback` and
 * `/rio dismiss`, so every entry point writes the same `author_response`.
 * Posture, budgets, rules and suppressions are never touched.
 */
export async function recordFeedback(
  env: Env,
  tenant: string,
  id: string,
  value: {
    reason: ResponseReason;
    note?: string;
    actor?: string;
    lineage?: { repository: string; kind: "pr" | "branch"; ref: string };
  },
): Promise<AuthorResponse | null> {
  const row = await (
    value.lineage
      ? env.DB.prepare(
          "SELECT f.lineage_id,f.generation,f.review_id,f.repository,l.kind,l.ref FROM findings f JOIN lineages l ON l.id=f.lineage_id WHERE f.tenant=? AND f.identity=? AND f.lineage_id=? AND f.first_posted_in IS NOT NULL ORDER BY f.generation DESC LIMIT 1",
        ).bind(tenant, id, lineageId(tenant, value.lineage))
      : env.DB.prepare(
          "SELECT f.lineage_id,f.generation,f.review_id,f.repository,l.kind,l.ref FROM findings f JOIN lineages l ON l.id=f.lineage_id WHERE f.tenant=? AND f.identity=? AND f.first_posted_in IS NOT NULL ORDER BY f.updated_at DESC,f.generation DESC LIMIT 1",
        ).bind(tenant, id)
  ).first<{
    lineage_id: string;
    generation: number;
    review_id: string;
    repository: string;
    kind: string;
    ref: string;
  }>();
  // Outside lineages the registry's last sighting is the finding answered.
  const registry = row
    ? null
    : value.lineage
      ? null
      : await env.DB.prepare(
          "SELECT repository,last_seen_review FROM finding_history WHERE tenant=? AND identity=? ORDER BY updated_at DESC LIMIT 1",
        )
          .bind(tenant, id)
          .first<{ repository: string; last_seen_review: string }>();
  if (!row && !registry) return null;
  const response = {
    reason: value.reason,
    actor: value.actor ?? tenant,
    at: new Date().toISOString(),
    ...(value.note ? { note: value.note } : {}),
  };
  const repository = row?.repository ?? registry!.repository;
  const dismissedIn = row
    ? row.kind === "pr"
      ? `${row.repository}#${row.ref}`
      : row.review_id
    : registry!.last_seen_review;
  await env.DB.batch([
    ...(row
      ? [
          env.DB.prepare(
            "UPDATE findings SET status='dismissed',author_response_json=?,updated_at=? WHERE tenant=? AND lineage_id=? AND generation=? AND identity=?",
          ).bind(
            JSON.stringify(response),
            Date.now(),
            tenant,
            row.lineage_id,
            row.generation,
            id,
          ),
        ]
      : []),
    // The answer is given on the code last seen: its hash becomes the
    // dismissal's, and status_at tells running reviews not to overwrite it.
    env.DB.prepare(
      "UPDATE finding_history SET status='dismissed',author_response_json=?,dismissed_in=?,code_hash=COALESCE(seen_code_hash,code_hash),status_at=?,updated_at=? WHERE tenant=? AND repository=? AND identity=?",
    ).bind(
      JSON.stringify(response),
      dismissedIn,
      Date.now(),
      Date.now(),
      tenant,
      repository,
      id,
    ),
    env.DB.prepare(
      "INSERT INTO feedback(id,tenant,repository,finding_id,reason,actor,note,created_at) VALUES(?,?,?,?,?,?,?,?)",
    ).bind(
      crypto.randomUUID(),
      tenant,
      repository,
      id,
      response.reason,
      response.actor,
      value.note ?? null,
      Date.now(),
    ),
  ]);
  return response;
}

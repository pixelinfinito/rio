import type { Env } from "./types";
import type { Store } from "./storage";
import type { AuditEntry } from "./council-step";
import { auditSummary } from "./council-step";
import { EVIDENCE_RETENTION_MS } from "./cache";

/**
 * Council governance (design D9): the audit record of which content went to
 * which vendor, by hash and size only, and retention of council artifacts.
 */

/** Write `reviews/<id>/council/audit.json` and one `council_assessments` row per call. */
export async function recordCouncil(
  env: Env,
  store: Store,
  review: string,
  tenant: string,
  audit: AuditEntry[],
  jobs: string[] = [],
): Promise<string> {
  // `jobs`: the council's runner jobs (experiments, self-hosted calls), whose
  // payloads and results are council content under the same retention.
  const key = await store.put(`reviews/${review}/council/audit.json`, {
    review,
    entries: audit,
    jobs: [...new Set(jobs)].sort(),
  });
  for (let i = 0; i < audit.length; i += 25)
    await env.DB.batch(
      audit
        .slice(i, i + 25)
        .map((a) =>
          env.DB.prepare(
            "INSERT INTO council_assessments(review_id,tenant,finding_id,member,round,assessment_key,abstained,cause,vendor,model,pack_hash,pack_bytes,rendering_hash,rendering_bytes,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(review_id,finding_id,member,round) DO NOTHING",
          ).bind(
            review,
            tenant,
            a.finding,
            a.member,
            a.round,
            a.assessment_key ?? null,
            a.abstained ? 1 : 0,
            a.abstained ? (a.cause ?? null) : null,
            a.vendor,
            a.model,
            a.pack_hash,
            a.pack_bytes,
            a.rendering_hash,
            a.rendering_bytes,
            a.at,
          ),
        ),
    );
  // Logs carry hashes, never pack content.
  if (audit.length)
    console.log(`council audit ${review}\n${auditSummary(audit)}`);
  return key;
}

/**
 * Delete up to `limit` reviews' council packs, assessments and experiment
 * outputs past the evidence retention; audit records and rows stay. A review
 * whose every call failed still has its packs, so expiry is tracked per row.
 */
export async function expireCouncil(
  env: Env,
  tenant: string,
  now = Date.now(),
  limit = 20,
): Promise<number> {
  const rows = await env.DB.prepare(
    "SELECT DISTINCT review_id FROM council_assessments WHERE tenant=? AND created_at<? AND expired=0 LIMIT ?",
  )
    .bind(tenant, now - EVIDENCE_RETENTION_MS, limit)
    .all<{ review_id: string }>();
  const remove = async (prefix: string, keep?: string) => {
    let cursor: string | undefined;
    do {
      const page = await env.ARTIFACTS.list({ prefix, cursor });
      const keys = page.objects.map((o) => o.key).filter((k) => k !== keep);
      if (keys.length) await env.ARTIFACTS.delete(keys);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  };
  for (const { review_id } of rows.results) {
    const prefix = `reviews/${review_id}/council/`;
    const audit = await env.ARTIFACTS.get(`${prefix}audit.json`);
    const jobs: string[] = audit
      ? (((await audit.json()) as { jobs?: string[] }).jobs ?? [])
      : [];
    for (const job of jobs)
      if (/^[0-9a-f]{32}$/.test(job))
        await remove(`reviews/${review_id}/jobs/${job}/`);
    await remove(prefix, `${prefix}audit.json`);
    await env.DB.prepare(
      "UPDATE council_assessments SET assessment_key=NULL,expired=1 WHERE review_id=? AND tenant=?",
    )
      .bind(review_id, tenant)
      .run();
  }
  return rows.results.length;
}

/** A runner that claimed within this window still counts as registered. */
export const RUNNER_SEEN_MS = 5 * 60 * 1000;
/** Whether a registered self-hosted runner advertises a model endpoint. */
export async function runnerModelEndpoint(
  env: Env,
  now = Date.now(),
): Promise<boolean> {
  if (env.RUNNER_BACKEND !== "self-hosted") return false;
  // Any capable runner seen recently counts; other runners never hide it.
  const row = await env.DB.prepare(
    "SELECT 1 AS seen FROM runner_capabilities WHERE name='self-hosted' AND model_seen_at>?",
  )
    .bind(now - RUNNER_SEEN_MS)
    .first<{ seen: number }>();
  return row?.seen === 1;
}

import type { Env, Submission } from "./types";
import { Store } from "./storage";
import { settleAnnouncement } from "./announce";

/** Time past a review's deadline before the endpoint ends it itself. */
export const DEADLINE_GRACE_MS = 120000;

interface ReviewRow {
  id: string;
  status: string;
  deadline: number;
  submission_key: string;
}

/**
 * Ends a queued or running review whose workflow can no longer finish it: the
 * instance errored or was terminated (for example a limit hit outside a
 * step), or the review is past its deadline. The review becomes partial with
 * the submitted report, its open jobs are withdrawn, and an overdue instance
 * is terminated. Returns the new status, or null when the review is left as is.
 */
export async function reconcile(
  env: Env,
  row: ReviewRow,
  now = Date.now(),
): Promise<string | null> {
  if (row.status !== "queued" && row.status !== "running") return null;
  let reason: string | null = null;
  try {
    const instance = await env.REVIEWS.get(row.id);
    const state = await instance.status();
    if (state.status === "errored" || state.status === "terminated")
      reason = `runtime stopped: ${state.error?.name ?? state.status}`;
    else if (now > row.deadline + DEADLINE_GRACE_MS) {
      reason = "review exceeded its wall budget";
      await instance.terminate().catch(() => {});
    }
  } catch {
    // No instance (never created or expired): only the deadline decides.
    if (now > row.deadline + DEADLINE_GRACE_MS)
      reason = "review exceeded its wall budget";
  }
  if (!reason) return null;
  const store = new Store(env);
  const submission = await store.get<Submission>(row.submission_key);
  const report = structuredClone(submission.report);
  report.status = "partial";
  report.footer.notes.push(`Rio ended this review: ${reason}.`);
  const key = await store.put(`reviews/${row.id}/report.json`, report);
  const updated = await env.DB.prepare(
    "UPDATE reviews SET status='partial',report_key=?,error=? WHERE id=? AND status IN ('queued','running') RETURNING id",
  )
    .bind(key, reason, row.id)
    .first();
  // Another reconciler or the workflow itself finished it first.
  if (!updated) return null;
  await env.DB.prepare(
    "UPDATE jobs SET status='failed' WHERE review_id=? AND status IN ('pending','leased')",
  )
    .bind(row.id)
    .run();
  await store.event(row.id, "review:partial", { report });
  await settleAnnouncement(
    env,
    row.id,
    "Review did not complete",
    "Rio's runtime stopped before the review finished, so nothing was published for this head. Push again or comment `/rio review` to retry.",
  );
  return "partial";
}

/** The cron sweep: reviews that may need ending, a bounded batch per tick. */
export async function sweepReviews(env: Env, now = Date.now()) {
  const rows = await env.DB.prepare(
    "SELECT id,status,deadline,submission_key FROM reviews WHERE status IN ('queued','running') AND created_at<? ORDER BY deadline LIMIT 25",
  )
    .bind(now - 60000)
    .all<ReviewRow>();
  for (const row of rows.results)
    await reconcile(env, row, now).catch((error: unknown) =>
      console.log(
        `rio: reconcile ${row.id} failed: ${error instanceof Error ? error.name : "error"}`,
      ),
    );
}

import type { Env, Submission } from "./types";
import { Store } from "./storage";
import { settleAnnouncement } from "./announce";
import { IDLE, stopRunners, withdrawIdle } from "./jobs";
import { redact } from "./redaction";

/** Time past a review's deadline before the endpoint ends it itself. */
export const DEADLINE_GRACE_MS = 120000;
/**
 * Time a cancelled review's workflow has to end the review itself, with what
 * it had found, before the endpoint stops it: longer than the one model step
 * (four minutes) that may be under way when the review is cancelled.
 */
export const CANCEL_GRACE_MS = 300000;

/**
 * Why an instance stopped, in the platform's words when it gave any: its
 * limits (memory, CPU time, requests) are told apart by the message alone,
 * every one of them an `Error` by name.
 */
function stopOf(state: {
  status: string;
  error?: { name?: string; message?: string } | null;
}): string {
  const message = state.error?.message?.replace(/\s+/g, " ").trim();
  if (!message) return state.error?.name ?? state.status;
  // A limit's message ends with a pointer to its documentation; the note
  // that carries the reason ends the sentence itself.
  return redact(message.replace(/\.? To configure this limit.*$/, ""))
    .slice(0, 200)
    .replace(/\.$/, "");
}

interface ReviewRow {
  id: string;
  status: string;
  deadline: number;
  submission_key: string;
  cancelled_at?: number | null;
}

/**
 * Ends a queued, running or cancelled review whose workflow can no longer
 * finish it, or did not in time: the instance errored or was terminated (for
 * example a limit hit outside a step), the review is past its deadline, or it
 * was cancelled and its workflow is still at work (inside a long step, or
 * retrying one). The review becomes partial with the submitted report, its
 * open jobs are withdrawn, and a live instance is terminated, so no cancelled
 * or overdue review keeps a workflow. Returns the new status, or null when the
 * review is left as is.
 */
export async function reconcile(
  env: Env,
  row: ReviewRow,
  now = Date.now(),
): Promise<string | null> {
  const cancelled = row.status === "cancelled";
  if (row.status !== "queued" && row.status !== "running" && !cancelled)
    return null;
  const overdue = cancelled
    ? now > (row.cancelled_at ?? 0) + CANCEL_GRACE_MS
    : now > row.deadline + DEADLINE_GRACE_MS;
  const late = cancelled ? "cancelled" : "review exceeded its wall budget";
  let reason: string | null = null;
  try {
    const instance = await env.REVIEWS.get(row.id);
    const state = await instance.status();
    if (state.status === "errored" || state.status === "terminated")
      reason = cancelled ? late : `runtime stopped: ${stopOf(state)}`;
    else if (overdue) {
      reason = late;
      await instance.terminate().catch(() => {});
    }
  } catch {
    // No instance (never created or expired): only the time decides.
    if (overdue) reason = late;
  }
  if (!reason) return null;
  const store = new Store(env);
  const submission = await store.get<Submission>(row.submission_key);
  const report = structuredClone(submission.report);
  report.status = "partial";
  report.footer.notes.push(`Rio ended this review: ${reason}.`);
  // Its own key: if the workflow finishes first, its report stays untouched.
  const key = await store.put(
    `reviews/${row.id}/report-reconciled.json`,
    report,
  );
  const updated = await env.DB.prepare(
    "UPDATE reviews SET status='partial',report_key=?,error=? WHERE id=? AND status IN ('queued','running','cancelled') RETURNING id",
  )
    .bind(key, reason, row.id)
    .first();
  // Another reconciler or the workflow itself finished it first.
  if (!updated) return null;
  await stopRunners(env, row.id);
  await withdrawIdle(env, row.id, now);
  await store.event(row.id, "review:partial", { report });
  await settleAnnouncement(
    env,
    row.id,
    "Review did not complete",
    cancelled
      ? "The review was cancelled before it finished, so nothing was published for this head. Push again or comment `/rio review` to retry."
      : "Rio's runtime stopped before the review finished, so nothing was published for this head. Push again or comment `/rio review` to retry.",
  );
  return "partial";
}

/** The cron sweep: reviews that may need ending, a bounded batch per tick. */
export async function sweepReviews(env: Env, now = Date.now()) {
  const columns = "SELECT id,status,deadline,submission_key,cancelled_at";
  const active = await env.DB.prepare(
    `${columns} FROM reviews WHERE status IN ('queued','running') AND created_at<? ORDER BY deadline LIMIT 25`,
  )
    .bind(now - 60000)
    .all<ReviewRow>();
  // Their own batch: any number of open reviews with earlier deadlines
  // leaves the cancelled ones their turn.
  const cancelled = await env.DB.prepare(
    `${columns} FROM reviews WHERE status='cancelled' AND COALESCE(cancelled_at,0)<? AND submission_key<>'' ORDER BY cancelled_at LIMIT 25`,
  )
    .bind(now - CANCEL_GRACE_MS)
    .all<ReviewRow>();
  for (const row of [...active.results, ...cancelled.results])
    await reconcile(env, row, now).catch((error: unknown) =>
      console.log(
        `rio: reconcile ${row.id} failed: ${error instanceof Error ? error.name : "error"}`,
      ),
    );
  // A finished review has no work left: a job still idle under one (its
  // workflow was terminated while it waited, or its runner was lost) is
  // withdrawn, so no runner starts it and a late result is ignored.
  await env.DB.prepare(
    `UPDATE jobs SET status='failed' WHERE ${IDLE} AND review_id IN (SELECT id FROM reviews WHERE status IN ('complete','partial','error'))`,
  )
    .bind(now)
    .run();
}

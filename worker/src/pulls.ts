import type {
  Env,
  PullRequestMeta,
  ReviewRequestMessage,
  Trigger,
} from "./types";
import {
  InstallationToken,
  PREPARE_PERMISSIONS,
  validRepository,
  type RepositoryName,
} from "./github";
import { installation, covers } from "./webhooks";
import { hash, invariant } from "./validation";
import { createReview } from "./reviews";
import { createPrepareJob, stopRunners, withdrawIdle } from "./jobs";
import { revokeQaRun } from "./qa-jobs";
import { ingestTarballs } from "./tarball";
import { Store } from "./storage";
import { announceReview, knownPolicy, settleAnnouncement } from "./announce";
import { PREPARE_MS, preparation } from "./prepare-budget";

// Pull request reviews (git-host-integration): the review-request consumer,
// fork detection and metadata, eligibility, and the hand-off from hosted
// preparation to an ordinary review in the PR's lineage.

export const FORK_REQUIRES_SELF_HOSTED = "fork_requires_self_hosted_runner";
/** How long one attempt may hold a request while it prepares (tarballs included). */
export const CLAIM_MS = 10 * 60 * 1000;

/** The lineage repository key of a GitHub repository, as the CLI derives it from `origin`. */
export function repositoryKey(repository: RepositoryName): string {
  return `github.com/${repository}`;
}
/** `owner/repo` from a repository key (`github.com/owner/repo`) or a bare name. */
export function repositoryName(key: string): RepositoryName | null {
  const name = key.replace(/^(?:https?:\/\/)?github\.com\//i, "");
  return validRepository(name) ? name : null;
}

// Agent attribution from structured co-author trailers; never used as policy.
const AGENTS = [
  "Claude",
  "Copilot",
  "Codex",
  "Cursor",
  "Devin",
  "Gemini",
  "Aider",
  "OpenHands",
  "Jules",
];
export function trailerAgent(messages: string[]): string | null {
  for (const message of messages)
    for (const line of message.split("\n")) {
      const match = /^co-authored-by:\s*([^<\n]+?)\s*</i.exec(line.trim());
      const agent = match && AGENTS.find((a) => match[1].includes(a));
      if (agent) return agent;
    }
  return null;
}

export interface PullRow {
  review_id: string;
  tenant: string;
  installation_id: number;
  repository: string;
  number: number;
  request_key: string;
  trigger: Trigger;
  base_sha: string | null;
  head_sha: string | null;
  fork: number;
  author_login: string | null;
  author_type: "user" | "bot" | null;
  agent_json: string | null;
  publish_policy?: "never" | "ask" | "auto" | null;
  announced_check?: number | null;
  consent: number;
  escalated: number;
  reset: number;
  state: string;
  reason: string | null;
}
export async function pullOf(
  env: Env,
  review: string,
): Promise<PullRow | null> {
  return env.DB.prepare("SELECT * FROM pull_requests WHERE review_id=?")
    .bind(review)
    .first<PullRow>();
}
export function metadata(row: PullRow): PullRequestMeta {
  return {
    repository: row.repository,
    number: row.number,
    base_sha: row.base_sha!,
    head_sha: row.head_sha!,
    author: { login: row.author_login!, type: row.author_type! },
    fork: row.fork === 1,
    ...(row.agent_json ? { agent: JSON.parse(row.agent_json) } : {}),
    trigger: row.trigger,
  };
}

/** Creates the review row of a CLI request (`POST /v1/pulls`); the consumer fills it in. */
export async function requestReview(
  env: Env,
  tenant: string,
  installationId: number,
  repository: RepositoryName,
  number: number,
  consent: boolean,
): Promise<string> {
  const id = crypto.randomUUID(),
    now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO reviews(id,tenant,submission_key,status,created_at,token_limit,deadline) VALUES(?,?,'','preparing',?,0,?)",
    ).bind(id, tenant, now, now + PREPARE_MS),
    env.DB.prepare(
      "INSERT INTO pull_requests(review_id,tenant,installation_id,repository,number,request_key,trigger,consent,state,created_at) VALUES(?,?,?,?,?,?,'cli',?,'requested',?)",
    ).bind(
      id,
      tenant,
      installationId,
      repository,
      number,
      `cli:${id}`,
      consent ? 1 : 0,
      now,
    ),
  ]);
  await env.JOBS.send({
    type: "review-request",
    tenant,
    installation_id: installationId,
    repository,
    number,
    trigger: "cli",
    review_id: id,
  });
  return id;
}

/**
 * After the queue gives up on a request without a review id (webhook or
 * command), its review is failed instead of waiting in `preparing`.
 */
export async function failUnscheduled(
  env: Env,
  message: ReviewRequestMessage,
): Promise<void> {
  const rows = await env.DB.prepare(
    "SELECT p.review_id FROM pull_requests p WHERE p.tenant=? AND p.repository=? AND p.number=? AND p.trigger=? AND p.state IN ('requested','preparing') AND (? IS NULL OR p.request_key=?) AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.review_id=p.review_id)",
  )
    .bind(
      message.tenant,
      message.repository,
      message.number,
      message.trigger,
      message.comment_id === undefined ? null : `command:${message.comment_id}`,
      message.comment_id === undefined ? null : `command:${message.comment_id}`,
    )
    .all<{ review_id: string }>();
  for (const row of rows.results)
    await fail(
      env,
      row.review_id,
      "failed",
      "pull request review request failed",
    );
}
export async function failPrepare(env: Env, review: string, reason: string) {
  await fail(env, review, "failed", reason);
}
async function fail(env: Env, review: string, state: string, reason: string) {
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE pull_requests SET state=?,reason=? WHERE review_id=?",
    ).bind(state, reason, review),
    env.DB.prepare(
      "UPDATE reviews SET status='error',error=? WHERE id=? AND status='preparing'",
    ).bind(reason, review),
  ]);
  await new Store(env).event(review, "review:error", { error: reason });
  await settleAnnouncement(env, review, "Review did not run", reason);
}
/** What the check run of a review cancelled while it was prepared says. */
const CANCELLED_UNPREPARED =
  "The review was cancelled before it started. Push again or comment `/rio review` to retry.";
/**
 * Why a webhook review ended when a newer head of its pull request was pushed
 * while it was still prepared or running: the review's `error`, and its pull
 * request's `reason`. A review ended so is also cancelled (`cancelled=1`),
 * whatever stage it had reached.
 */
export const SUPERSEDED = "superseded by a newer head";
/** Whether a review ended because a newer head of its pull request superseded it. */
export async function supersededReview(
  env: Env,
  review: string,
): Promise<boolean> {
  const row = await env.DB.prepare("SELECT error FROM reviews WHERE id=?")
    .bind(review)
    .first<{ error: string | null }>();
  return row?.error === SUPERSEDED;
}
/**
 * Ends a review cancelled while it was being prepared, and its prepare job:
 * no workflow exists yet to end it, and the sweep ends only reviews that were
 * handed over. False when the review is not being prepared (any more), unless
 * it ended here before: a cancel repeated after one that failed half way
 * finishes what that one left. `reason` is `cancelled` for a cancel by
 * request and {@link SUPERSEDED} for a review a newer head superseded.
 */
export async function cancelPreparing(
  env: Env,
  review: string,
  reason: "cancelled" | typeof SUPERSEDED = "cancelled",
): Promise<boolean> {
  const ended = await env.DB.prepare(
    "UPDATE reviews SET cancelled=1,cancelled_at=COALESCE(cancelled_at,?),status='error',error=CASE WHEN status='error' THEN error ELSE ? END WHERE id=? AND submission_key='' AND (status='preparing' OR (status='error' AND error IN ('cancelled',?) AND cancelled=1)) RETURNING id,error",
  )
    .bind(Date.now(), reason, review, SUPERSEDED)
    .first<{ id: string; error: string }>();
  if (!ended) return false;
  const error = ended.error;
  // Each of what follows is tried whatever became of the one before: an
  // event that cannot be written must not leave the prepare job's container
  // running.
  const faults: unknown[] = [];
  for (const work of [
    () =>
      env.DB.prepare(
        "UPDATE pull_requests SET state='failed',reason=? WHERE review_id=? AND state IN ('requested','preparing')",
      )
        .bind(error, review)
        .run(),
    () => stopRunners(env, review),
    () => withdrawIdle(env, review),
    async () => {
      const told = await env.DB.prepare(
        "SELECT 1 FROM events WHERE review_id=? AND event='review:error' LIMIT 1",
      )
        .bind(review)
        .first();
      if (!told) await new Store(env).event(review, "review:error", { error });
    },
  ])
    await work().catch((error) => faults.push(error));
  // A superseded review's check run says so (`settleAnnouncement`).
  await settleAnnouncement(
    env,
    review,
    "Review did not run",
    CANCELLED_UNPREPARED,
  );
  if (faults.length) throw faults[0];
  return true;
}

/**
 * Cancels a review at whatever stage it is (`POST /v1/reviews/:id/cancel`,
 * and a webhook review a newer head supersedes). A review still being
 * prepared has no workflow to end it: it ends here, and its prepare job with
 * it. Otherwise the review is flagged: the model gateway makes no new call for
 * it, the workflow sees the flag between steps and ends the review as partial
 * without publishing, and the sweep stops one that has not within the grace.
 * The jobs open at that moment are read with it: one that completes later
 * finds the review cancelled, one that completed earlier ends its own wait
 * (`finishJob`). A review that already ended is left as it is.
 */
export async function cancelReview(
  env: Env,
  review: string,
  reason: "cancelled" | typeof SUPERSEDED = "cancelled",
): Promise<void> {
  if (await cancelPreparing(env, review, reason)) return;
  // A review superseded keeps saying so if it is also cancelled by request.
  const [stopped, open] = (await env.DB.batch([
    env.DB.prepare(
      "UPDATE reviews SET cancelled=1,status='cancelled',cancelled_at=COALESCE(cancelled_at,?),error=CASE WHEN ?=? THEN ? ELSE error END WHERE id=? AND status NOT IN ('complete','partial','error') RETURNING id",
    ).bind(Date.now(), reason, SUPERSEDED, SUPERSEDED, review),
    env.DB.prepare(
      "SELECT id,attempt FROM jobs WHERE review_id=? AND status IN ('pending','leased')",
    ).bind(review),
  ])) as [D1Result<{ id: string }>, D1Result<{ id: string; attempt: number }>];
  if (stopped.results.length) {
    // A job no runner has taken never runs. One a runner has is stopped
    // (Sandbox) or keeps its result for the audit, and the workflow stops
    // waiting for it now.
    await stopRunners(env, review);
    await withdrawIdle(env, review);
    if (open.results.length) {
      // No instance, or one that ended, has no wait to end. Each job on its
      // own: an event that fails leaves the other waits their end.
      const instance = await env.REVIEWS.get(review).catch(() => null);
      if (instance)
        for (const job of open.results)
          await instance
            .sendEvent({
              type: `job-${job.id}-${job.attempt}`,
              payload: { cancelled: true },
            })
            .catch(() => {});
    }
  }
  const qa = await env.DB.prepare(
    "SELECT q.id FROM qa_runs q JOIN reviews r ON r.id=q.review_id WHERE q.review_id=? AND r.cancelled=1",
  )
    .bind(review)
    .all<{ id: string }>();
  for (const run of qa.results) await revokeQaRun(env, run.id);
}

/**
 * A webhook review of `head` supersedes the webhook reviews of other heads of
 * the same pull request that are still prepared or running: it is the newest
 * head, and a review of an older one would spend its tokens and publish on a
 * commit no one will merge. Reviews a user asked for (`cli`, `command`) are
 * never superseded, nor do they supersede.
 *
 * "Older" is told by when each request read the pull request from GitHub:
 * a row created before this attempt began reading (`observed`) is older; one
 * created after it read a head at least as new. So two pushes close together
 * end with the review of the later head whichever delivery is processed
 * first: if a review of another head was requested after this attempt began
 * reading, this review is the stale one and ends itself instead. Two requests
 * stamped in the same millisecond cannot be ordered, and neither supersedes
 * the other. A candidate
 * another attempt is preparing right now (claimed, no job yet) is left to that
 * attempt, which runs this same check once it has read its head. A review that
 * has already ended (complete, or ended by its workflow) is left as it is: the
 * cancel and its end are one conditional update each, so exactly one wins.
 *
 * Returns false when this review was itself superseded.
 */
export async function supersedeOlderHeads(
  env: Env,
  review: string,
  pull: { tenant: string; repository: string; number: number },
  head: string,
  observed: number,
): Promise<boolean> {
  // The head a webhook review was requested for is in its request key
  // (`webhook:<sha>`); a retry may since have recorded a newer one.
  const others =
    "FROM pull_requests p JOIN reviews r ON r.id=p.review_id WHERE p.tenant=? AND p.repository=? AND p.number=? AND p.trigger='webhook' AND p.review_id!=? AND COALESCE(p.head_sha,substr(p.request_key,9))!=?";
  const newer = await env.DB.prepare(
    `SELECT p.review_id ${others} AND r.status!='error' AND p.created_at>? LIMIT 1`,
  )
    .bind(pull.tenant, pull.repository, pull.number, review, head, observed)
    .first();
  if (newer) {
    await cancelReview(env, review, SUPERSEDED);
    return false;
  }
  const older = await env.DB.prepare(
    `SELECT p.review_id ${others} AND r.status IN ('preparing','queued','running') AND r.cancelled=0 AND p.created_at<? AND NOT (COALESCE(p.claimed_until,0)>? AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.review_id=p.review_id))`,
  )
    .bind(
      pull.tenant,
      pull.repository,
      pull.number,
      review,
      head,
      observed,
      Date.now(),
    )
    .all<{ review_id: string }>();
  // Each on its own: one that cannot be cancelled now is left to the sweep
  // or a later push, and does not keep this review from starting.
  for (const old of older.results)
    await cancelReview(env, old.review_id, SUPERSEDED).catch((error) =>
      console.log(
        `rio: review ${old.review_id} could not be superseded: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`,
      ),
    );
  return true;
}

/**
 * The review-request consumer. The pull request is read from GitHub with a
 * token scoped to the repository, so its head, fork flag and author come from
 * the host's metadata. Two requests for the same head create one review.
 */
export async function handleReviewRequest(
  env: Env,
  message: ReviewRequestMessage,
): Promise<void> {
  const row = await installation(env, message.installation_id);
  if (!row || !covers(row, message.repository)) {
    if (message.review_id)
      await fail(env, message.review_id, "failed", "no_installation");
    return;
  }
  const token = await InstallationToken.mint(
    env,
    message.installation_id,
    message.repository,
    PREPARE_PERMISSIONS,
  );
  try {
    const base = `/repos/${message.repository}`;
    // When this attempt began reading the pull request: a webhook review
    // requested before it reviews an older head (`supersedeOlderHeads`).
    const observed = Date.now();
    const pr = await token.request("GET", `${base}/pulls/${message.number}`);
    invariant(
      pr?.number === message.number,
      "GitHub returned another pull request",
    );
    if (pr.state !== "open" || (message.trigger === "webhook" && pr.draft)) {
      if (message.review_id)
        await fail(env, message.review_id, "failed", "pull_request_not_open");
      return;
    }
    const head = String(pr.head?.sha ?? ""),
      tip = String(pr.base?.sha ?? "");
    invariant(
      /^[0-9a-f]{40}$/.test(head) && /^[0-9a-f]{40}$/.test(tip),
      "invalid pull request SHAs",
    );
    // The review covers what the PR changes: head against its merge base.
    const compare = await token.request(
      "GET",
      `${base}/compare/${tip}...${head}`,
    );
    const mergeBase = String(compare?.merge_base_commit?.sha ?? tip);
    invariant(/^[0-9a-f]{40}$/.test(mergeBase), "invalid merge base");
    const fork =
      !pr.head?.repo ||
      String(pr.head.repo.full_name).toLowerCase() !==
        String(pr.base?.repo?.full_name).toLowerCase();
    const bot = pr.user?.type === "Bot";
    const login = String(pr.user?.login ?? "ghost").slice(0, 100);
    let agent: PullRequestMeta["agent"] | undefined = bot
      ? { name: login, source: "bot_author" }
      : undefined;
    if (!agent) {
      const commits = await token.request(
        "GET",
        `${base}/pulls/${message.number}/commits?per_page=100`,
      );
      const name = trailerAgent(
        (Array.isArray(commits) ? commits : []).map((c: any) =>
          String(c?.commit?.message ?? ""),
        ),
      );
      if (name) agent = { name, source: "commit_trailer" };
    }
    const now = observed;
    const key =
      message.trigger === "webhook"
        ? `webhook:${head}`
        : message.trigger === "command"
          ? `command:${message.comment_id}`
          : `cli:${message.review_id}`;
    let review = message.review_id;
    if (!review) {
      // Created only if no review exists for this request key (one per head for webhooks).
      const id = crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO reviews(id,tenant,submission_key,status,created_at,token_limit,deadline) SELECT ?,?,'','preparing',?,0,? WHERE NOT EXISTS (SELECT 1 FROM pull_requests WHERE tenant=? AND repository=? AND number=? AND request_key=?)",
        ).bind(
          id,
          message.tenant,
          now,
          now + PREPARE_MS,
          message.tenant,
          message.repository,
          message.number,
          key,
        ),
        env.DB.prepare(
          "INSERT INTO pull_requests(review_id,tenant,installation_id,repository,number,request_key,trigger,escalated,reset,state,created_at) SELECT ?,?,?,?,?,?,?,?,?,'requested',? WHERE EXISTS (SELECT 1 FROM reviews WHERE id=?) ON CONFLICT DO NOTHING",
        ).bind(
          id,
          message.tenant,
          message.installation_id,
          message.repository,
          message.number,
          key,
          message.trigger,
          message.trigger === "command" ? 1 : 0,
          message.trigger === "command" ? 1 : 0,
          now,
          id,
        ),
      ]);
      const owner = await env.DB.prepare(
        "SELECT review_id,state FROM pull_requests WHERE tenant=? AND repository=? AND number=? AND request_key=?",
      )
        .bind(message.tenant, message.repository, message.number, key)
        .first<{ review_id: string; state: string }>();
      if (!owner) return;
      if (owner.review_id === id) review = id;
      else {
        // Another delivery owns this request. A retry of this very request,
        // whose earlier attempt failed before scheduling a job, resumes it.
        const scheduled = await env.DB.prepare(
          "SELECT 1 AS scheduled FROM jobs WHERE review_id=? LIMIT 1",
        )
          .bind(owner.review_id)
          .first();
        if (scheduled || !["requested", "preparing"].includes(owner.state))
          return;
        review = owner.review_id;
      }
    }
    // One claimant prepares a request at a time, so overlapping deliveries
    // and retries never schedule twice; a claim whose holder died expires.
    const claim = crypto.randomUUID();
    const claimed = await env.DB.prepare(
      "UPDATE pull_requests SET claim=?,claimed_until=? WHERE review_id=? AND state IN ('requested','preparing') AND (claimed_until IS NULL OR claimed_until<?) AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.review_id=pull_requests.review_id) RETURNING review_id",
    )
      .bind(claim, Date.now() + CLAIM_MS, review, Date.now())
      .first();
    if (!claimed) return;
    try {
      // The repository's profile at the merge base may give preparation more
      // time than the default the review was created with (counted from the
      // request), and may keep paths out of the snapshot.
      const prepared = await preparation(token, message.repository, mergeBase);
      await env.DB.prepare(
        "UPDATE reviews SET deadline=created_at+? WHERE id=? AND status='preparing' AND submission_key=''",
      )
        .bind(prepared.time, review)
        .run();
      await env.DB.prepare(
        "UPDATE pull_requests SET base_sha=?,head_sha=?,fork=?,author_login=?,author_type=?,agent_json=?,state='preparing' WHERE review_id=? AND state IN ('requested','preparing') AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.review_id=pull_requests.review_id)",
      )
        .bind(
          mergeBase,
          head,
          fork ? 1 : 0,
          login,
          bot ? "bot" : "user",
          agent ? JSON.stringify(agent) : null,
          review,
        )
        .run();
      // A retry reviews the head it just read; until its job exists the record
      // follows. Webhook reviews of this PR's older heads still prepared or
      // running are superseded, and this one if a newer head was requested
      // while it read its own.
      if (
        message.trigger === "webhook" &&
        !(await supersedeOlderHeads(env, review, message, head, observed))
      )
        return;
      await new Store(env).event(review, "review:preparing", {
        repository: message.repository,
        number: message.number,
        head_sha: head,
        fork,
      });
      // Fork PRs need the self-hosted runner: the Sandbox prepares non-fork PRs only.
      if (fork && env.RUNNER_BACKEND === "sandbox") {
        await fail(env, review, "not_prepared", FORK_REQUIRES_SELF_HOSTED);
        return;
      }
      // Announced now when this repository's policy is already known;
      // otherwise the review announces itself once it resolves its profile.
      const known = await knownPolicy(env, message.tenant, message.repository);
      if (known) {
        await announceReview(env, review, known);
        // Ended while it was being announced (cancelled, say): what ended it
        // found no check run yet, and nothing later would complete this one.
        const state = await env.DB.prepare(
          "SELECT status,error FROM reviews WHERE id=?",
        )
          .bind(review)
          .first<{ status: string; error: string | null }>();
        if (state && state.status !== "preparing") {
          await settleAnnouncement(
            env,
            review,
            "Review did not run",
            state.error === "cancelled"
              ? CANCELLED_UNPREPARED
              : (state.error ?? "The review ended before it started."),
          );
          return;
        }
      }
      const spec = {
        repository: message.repository,
        clone_url: String(
          pr.base?.repo?.clone_url ??
            `https://github.com/${message.repository}.git`,
        ),
        number: message.number,
        base_sha: mergeBase,
        head_sha: head,
        installation_id: message.installation_id,
      };
      if (env.RUNNER_BACKEND === "sandbox") {
        // The Sandbox has no network: the Worker fetches both trees with this
        // token and the container prepares from the stored snapshot.
        const snapshot = await ingestTarballs(
          env,
          message.tenant,
          token,
          spec,
          prepared.omit,
        );
        await createPrepareJob(env, review, {
          snapshot_id: snapshot,
          prepare: spec,
        });
      } else await createPrepareJob(env, review, { prepare: spec });
    } finally {
      await env.DB.prepare(
        "UPDATE pull_requests SET claim=NULL,claimed_until=NULL WHERE review_id=? AND claim=?",
      )
        .bind(review, claim)
        .run();
    }
  } finally {
    await token.revoke();
  }
}

/** A review the prepare job hands over; policy keys come from the record, never from the runner. */
export async function submitPrepared(
  env: Env,
  row: PullRow,
  value: any,
): Promise<string> {
  invariant(
    value && typeof value === "object" && !Array.isArray(value),
    "invalid submission",
  );
  const meta = metadata(row);
  value.fork = row.fork === 1;
  value.repository = repositoryKey(row.repository);
  value.lineage = {
    repository: repositoryKey(row.repository),
    kind: "pr",
    ref: String(row.number),
    ...(row.reset ? { reset: true } : {}),
  };
  invariant(
    value.report?.review && typeof value.report.review === "object",
    "invalid report header",
  );
  value.report.review.pull_request = meta;
  try {
    const id = await createReview(env, row.tenant, value, row.review_id);
    await env.DB.prepare(
      "UPDATE pull_requests SET state='submitted',prepare_token_hash=NULL WHERE review_id=?",
    )
      .bind(row.review_id)
      .run();
    return id;
  } catch (error) {
    const reason =
      `preparation submission rejected: ${error instanceof Error ? error.message : "invalid"}`.slice(
        0,
        300,
      );
    await fail(env, row.review_id, "failed", reason);
    throw error;
  }
}

/**
 * The single-use credential a self-hosted prepare job uploads and submits
 * with: an API token for this tenant's snapshot routes, stored only as a hash
 * and bound to the review. A new claim replaces the previous one.
 */
export async function prepareCredential(
  env: Env,
  review: string,
  tenant: string,
): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = `rio_prepare_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
  const digest = hash(token);
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM api_tokens WHERE hash IN (SELECT prepare_token_hash FROM pull_requests WHERE review_id=? AND prepare_token_hash IS NOT NULL)",
    ).bind(review),
    // It lasts as long as the review's preparation may.
    env.DB.prepare(
      "INSERT INTO api_tokens(hash,tenant,scope,expires_at) SELECT ?,?,'prepare',MAX(deadline,?) FROM reviews WHERE id=?",
    ).bind(digest, tenant, Date.now() + PREPARE_MS, review),
    env.DB.prepare(
      "UPDATE pull_requests SET prepare_token_hash=? WHERE review_id=?",
    ).bind(digest, review),
  ]);
  return token;
}
/** The PR review a prepare credential belongs to; the credential is consumed. */
export async function preparedBy(
  env: Env,
  bearer: string,
): Promise<PullRow | null> {
  if (!bearer.startsWith("rio_prepare_")) return null;
  const digest = hash(bearer),
    now = Date.now();
  // One conditional update consumes the credential: exactly one caller wins,
  // and only while it is unexpired and its review is live.
  const row = await env.DB.prepare(
    "UPDATE pull_requests SET prepare_token_hash=NULL WHERE prepare_token_hash=? AND state='preparing' AND EXISTS (SELECT 1 FROM api_tokens t WHERE t.hash=? AND t.scope='prepare' AND t.expires_at>?) AND EXISTS (SELECT 1 FROM reviews r WHERE r.id=pull_requests.review_id AND r.cancelled=0 AND r.deadline>?) RETURNING *",
  )
    .bind(digest, digest, now, now)
    .first<PullRow>();
  await env.DB.prepare(
    "DELETE FROM api_tokens WHERE hash=? AND scope='prepare'",
  )
    .bind(digest)
    .run();
  return row;
}

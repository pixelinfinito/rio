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
import { createPrepareJob } from "./jobs";
import { ingestTarballs } from "./tarball";
import { Store } from "./storage";

// Pull request reviews (git-host-integration): the review-request consumer,
// fork detection and metadata, eligibility, and the hand-off from hosted
// preparation to an ordinary review in the PR's lineage.

/** Time a PR review may spend in preparation before its runner claim expires. */
export const PREPARE_MS = 15 * 60 * 1000;
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
    const now = Date.now();
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
      // follows. Older webhook reviews of this PR that never got a job are stale.
      if (message.trigger === "webhook") {
        const stale = await env.DB.prepare(
          "SELECT p.review_id FROM pull_requests p WHERE p.tenant=? AND p.repository=? AND p.number=? AND p.trigger='webhook' AND p.review_id!=? AND p.state IN ('requested','preparing') AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.review_id=p.review_id)",
        )
          .bind(message.tenant, message.repository, message.number, review)
          .all<{ review_id: string }>();
        for (const old of stale.results)
          await fail(
            env,
            old.review_id,
            "failed",
            "superseded by a newer head",
          );
      }
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
        const snapshot = await ingestTarballs(env, message.tenant, token, spec);
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
    env.DB.prepare(
      "INSERT INTO api_tokens(hash,tenant,scope,expires_at) VALUES(?,?,'prepare',?)",
    ).bind(digest, tenant, Date.now() + PREPARE_MS),
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

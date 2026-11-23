import type { Env } from "./types";
import { PUBLISH_PERMISSIONS, appRequest, withToken } from "./github";
import { installation, covers } from "./webhooks";
import { SUPERSEDED, pullOf, repositoryKey, type PullRow } from "./pulls";
import { lineageId } from "./lineage";
import {
  GitHubHost,
  SUMMARY_MARKER,
  acquireLease,
  decide,
  escalatedPull,
  releaseLease,
  summaryMarker,
  type Policy,
} from "./publish";

// The in-progress signal (pr-publishing): as soon as a PR review's publish
// policy is known, its head gets an in-progress `rio/review` check run and,
// under `auto`, the summary comment says a review is running. The final
// publication completes that check run; a review that ends without publishing
// completes it here, so no check run is left in progress.

const PROGRESS = /<!-- rio:progress -->[\s\S]*?<!-- \/rio:progress -->\n*/g;

function banner(head: string): string {
  return [
    "<!-- rio:progress -->",
    "> [!NOTE]",
    `> ⏳ **Rio is reviewing \`${head.slice(0, 12)}\`.** Findings will appear inline and in this comment when the review finishes, usually within a few minutes.`,
    "<!-- /rio:progress -->",
    "",
  ].join("\n");
}
/** The summary comment with the progress banner below its heading. */
export function withProgress(body: string, head: string): string {
  const clean = withoutProgress(body);
  const heading = /^## [^\n]*\n\n?/.exec(clean)?.[0] ?? "";
  return `${heading}${banner(head)}\n${clean.slice(heading.length)}`;
}
/**
 * The summary comment without its progress banner; given a head, without the
 * banner of that head only: a review that ends leaves the banner of a newer
 * head's review that announced itself meanwhile.
 */
export function withoutProgress(body: string, head?: string): string {
  return body.replace(PROGRESS, (banner) =>
    !head || banner.includes(`\`${head.slice(0, 12)}\``) ? "" : banner,
  );
}
function placeholder(lineage: string, head: string): string {
  return [
    "## 🌊 Rio review",
    "",
    banner(head),
    "---",
    "<sub>🌊 Rio · the `rio/review` check is always neutral and never blocks a merge</sub>",
    summaryMarker(lineage),
  ].join("\n");
}
function lineageOf(row: PullRow): string {
  return lineageId(row.tenant, {
    repository: repositoryKey(row.repository),
    kind: "pr",
    ref: String(row.number),
  });
}
async function host(
  env: Env,
  row: PullRow,
  use: (github: GitHubHost) => Promise<void>,
) {
  const slug = String((await appRequest(env, "GET", "/app"))?.slug ?? "");
  await withToken(
    env,
    row.installation_id,
    row.repository,
    PUBLISH_PERMISSIONS,
    (token) =>
      use(
        new GitHubHost(token, row.repository, row.number, `${slug}[bot]`, slug),
      ),
  );
}

/** The publish policy the last review of this repository resolved, if any. */
export async function knownPolicy(
  env: Env,
  tenant: string,
  repository: string,
): Promise<Policy | null> {
  const row = await env.DB.prepare(
    "SELECT publish_policy FROM pull_requests WHERE tenant=? AND repository=? AND publish_policy IS NOT NULL ORDER BY created_at DESC LIMIT 1",
  )
    .bind(tenant, repository)
    .first<{ publish_policy: Policy }>();
  return row?.publish_policy ?? null;
}

/**
 * Posts the in-progress check run (and, under `auto`, the summary banner)
 * once per review. Never throws: the signal is best effort and must not fail
 * the review.
 */
export async function announceReview(
  env: Env,
  review: string,
  policy: Policy,
): Promise<void> {
  try {
    const row = await pullOf(env, review);
    if (!row?.head_sha) return;
    const install = await installation(env, row.installation_id);
    if (!install || !covers(install, row.repository)) return;
    const decision = decide(policy, row, await escalatedPull(env, row));
    if (!decision.check) return;
    const head = row.head_sha;
    await host(env, row, async (github) => {
      // Announced earlier under the repository's last policy: the check run
      // exists, and only the banner may still be missing.
      if (!row.announced_check) {
        const run = await github.startCheckRun(head);
        await env.DB.prepare(
          "UPDATE pull_requests SET announced_check=? WHERE review_id=?",
        )
          .bind(run.id, review)
          .run();
      }
      if (!decision.full) return;
      const lineage = lineageOf(row);
      const lease = await acquireLease(env, row.tenant, lineage);
      if (!lease) return;
      try {
        const existing = (await github.issueComments()).find(
          (c) => SUMMARY_MARKER.exec(c.body)?.[1] === lineage,
        );
        if (existing) {
          const body = withProgress(existing.body, head);
          if (body !== existing.body)
            await github.editIssueComment(existing.id, body);
        } else await github.postIssueComment(placeholder(lineage, head));
      } finally {
        await releaseLease(lease);
      }
    });
  } catch (error) {
    console.log(
      `rio: review ${review} could not be announced: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`,
    );
  }
}

/** Marks the announced check run as handed to the final publication. */
export async function announcementPublished(env: Env, review: string) {
  await env.DB.prepare(
    "UPDATE pull_requests SET announced_check=NULL WHERE review_id=?",
  )
    .bind(review)
    .run();
}

/** The title of the check run of a review a newer head superseded. */
export const SUPERSEDED_TITLE = "Review superseded by a newer push";
/** What the check run of a review a newer head superseded says. */
export function supersededSummary(head: string): string {
  return `A newer commit was pushed to this pull request while Rio was reviewing \`${head.slice(0, 12)}\`, so Rio stopped this review and publishes nothing more for this commit. The newest commit is reviewed instead.`;
}
/**
 * Completes an announced check run when the review ends without publishing
 * it (failure, a policy that posts nothing, a superseded round), and removes
 * the summary banner. Never throws.
 */
export async function settleAnnouncement(
  env: Env,
  review: string,
  title: string,
  summary: string,
): Promise<void> {
  try {
    const row = await pullOf(env, review);
    if (!row?.head_sha || !row.announced_check) return;
    const check = row.announced_check;
    // Whichever way a superseded review ends, its check run says why.
    const ended = await env.DB.prepare("SELECT error FROM reviews WHERE id=?")
      .bind(review)
      .first<{ error: string | null }>();
    if (ended?.error === SUPERSEDED) {
      title = SUPERSEDED_TITLE;
      summary = supersededSummary(row.head_sha);
    }
    const head = row.head_sha;
    await host(env, row, async (github) => {
      await github.checkRun(
        head,
        {
          title,
          summary: `${summary}\n\nRio's check run is always neutral: it never approves and never blocks a merge.`,
        },
        check,
      );
      const lineage = lineageOf(row);
      const lease = await acquireLease(env, row.tenant, lineage);
      if (!lease) return;
      try {
        const existing = (await github.issueComments()).find(
          (c) => SUMMARY_MARKER.exec(c.body)?.[1] === lineage,
        );
        // Only this head's banner: a newer head's review may have announced
        // itself meanwhile.
        const body = existing && withoutProgress(existing.body, head);
        if (existing && body !== existing.body)
          await github.editIssueComment(existing.id, body!);
      } finally {
        await releaseLease(lease);
      }
    });
    await announcementPublished(env, review);
  } catch (error) {
    console.log(
      `rio: review ${review} announcement could not be settled: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`,
    );
  }
}

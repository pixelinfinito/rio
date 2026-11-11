import type { AuthorResponse, Env, Finding } from "./types";
import {
  GitHubError,
  InstallationToken,
  PREPARE_PERMISSIONS,
  PUBLISH_PERMISSIONS,
  RESOLVE_PERMISSIONS,
  appRequest,
  withToken,
} from "./github";
import { installation, covers } from "./webhooks";
import { pullOf, type PullRow } from "./pulls";
import { policyMatches } from "./consolidate";
import { hash } from "./validation";
import { Store } from "./storage";
import { refreshQaReportLinks } from "./qa-evidence";
import { announcementPublished, settleAnnouncement } from "./announce";
import {
  findingBody,
  findingMarker,
  suggestionRange,
  DISPLAY_ID_LEN,
  type FindingState,
} from "./comment/finding";
import {
  alert,
  findingTables,
  lists,
  provenance,
  reportLine,
  scoreboard,
  summaryBody,
  summaryMarker,
  verdict,
} from "./comment/summary";
import { plain } from "./comment/text";
export {
  findingBody,
  findingMarker,
  type FindingState,
} from "./comment/finding";
export { qaSummary, summaryMarker } from "./comment/summary";
export { qaEvidenceBody } from "./comment/evidence";
export { headline, plain } from "./comment/text";

// The publisher (pr-publishing). One host interface, one GitHub
// implementation. Every comment carries a hidden marker so a later round, or a
// retry after a lost record, edits instead of posting again; a finding identity
// is posted at most once per lineage, and a dismissed finding is never posted.

export type Policy = "never" | "ask" | "auto";
export type Unpublished =
  | "policy_never"
  | "ask_without_consent"
  | "fork_not_escalated"
  | "no_installation";
export interface Publication {
  policy: Policy;
  posted: number;
  edited: number;
  resolved: number;
  failed: number;
  unanchored: number;
  check_run_url: string | null;
  summary_comment_url: string | null;
  reason?: Unpublished;
  failures?: {
    id: string;
    kind: "finding" | "summary" | "check_run";
    error: string;
  }[];
}
const FINDING_MARKER = /<!-- rio:finding:([a-f0-9]{64}) -->\s*$/;
export const SUMMARY_MARKER = /<!-- rio:summary:([a-f0-9]{64}) -->\s*$/;

/** Host operations the publisher needs; GitHub is the only implementation. */
export interface Host {
  files(): Promise<Map<string, { removed: boolean; lines: Set<number> }>>;
  reviewComments(): Promise<HostComment[]>;
  issueComments(): Promise<HostComment[]>;
  postReviewComment(input: {
    body: string;
    commit: string;
    path: string;
    line: number;
    /** First line of a multi-line comment (a multi-line suggestion). */
    start_line?: number;
  }): Promise<HostComment>;
  editReviewComment(id: number, body: string): Promise<HostComment>;
  postIssueComment(body: string): Promise<HostComment>;
  editIssueComment(id: number, body: string): Promise<HostComment>;
  threads(): Promise<Map<number, { id: string; resolved: boolean }>>;
  resolveThread(id: string, resolved: boolean): Promise<void>;
  checkRun(
    head: string,
    output: CheckOutput,
    existing?: number,
  ): Promise<{ id: number; url: string }>;
  react(comment: number, content: "+1" | "-1" | "confused"): Promise<void>;
}
export interface HostComment {
  id: number;
  body: string;
  url: string;
}
export interface CheckOutput {
  title: string;
  summary: string;
  name?: "rio/review" | "rio/qa";
  conclusion?: "neutral" | "failure";
  annotations?: {
    path: string;
    start_line: number;
    end_line: number;
    annotation_level: "failure" | "warning" | "notice";
    title: string;
    message: string;
  }[];
}

/** Right-side line numbers present in a unified diff patch (added and context lines). */
export function rightLines(patch: string | undefined): Set<number> {
  const lines = new Set<number>();
  let right = 0;
  for (const line of (patch ?? "").split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      right = Number(hunk[1]);
      continue;
    }
    if (!right) continue;
    if (line.startsWith("+") || line.startsWith(" ")) lines.add(right++);
    else if (line === "") continue;
  }
  return lines;
}

export class GitHubHost implements Host {
  private threadMap?: Map<number, { id: string; resolved: boolean }>;
  constructor(
    private readonly token: InstallationToken,
    private readonly repository: string,
    private readonly number: number,
    private readonly bot: string,
    private readonly slug: string,
    /** Mints the resolve token; without it the host token is used. */
    private readonly installation?: { env: Env; id: number },
  ) {}
  private get base() {
    return `/repos/${this.repository}`;
  }
  private own(list: any[]): HostComment[] {
    // Only the app's own comments are reconciled; others cannot be edited anyway.
    return list
      .filter((c) => c?.user?.login === this.bot && typeof c.body === "string")
      .map((c) => ({ id: c.id, body: c.body, url: c.html_url ?? "" }));
  }
  async files() {
    const files = new Map<string, { removed: boolean; lines: Set<number> }>();
    for (const f of await this.token.list(
      `${this.base}/pulls/${this.number}/files`,
    ))
      files.set(String(f.filename), {
        removed: f.status === "removed",
        lines: rightLines(f.patch),
      });
    return files;
  }
  async reviewComments() {
    return this.own(
      await this.token.list(`${this.base}/pulls/${this.number}/comments`),
    );
  }
  async issueComments() {
    return this.own(
      await this.token.list(`${this.base}/issues/${this.number}/comments`),
    );
  }
  private comment(c: any): HostComment {
    return { id: c.id, body: c.body, url: c.html_url ?? "" };
  }
  async postReviewComment(input: {
    body: string;
    commit: string;
    path: string;
    line: number;
    start_line?: number;
  }) {
    return this.comment(
      await this.token.request(
        "POST",
        `${this.base}/pulls/${this.number}/comments`,
        {
          body: input.body,
          commit_id: input.commit,
          path: input.path,
          line: input.line,
          side: "RIGHT",
          ...(input.start_line !== undefined && input.start_line < input.line
            ? { start_line: input.start_line, start_side: "RIGHT" }
            : {}),
        },
      ),
    );
  }
  async editReviewComment(id: number, body: string) {
    return this.comment(
      await this.token.request("PATCH", `${this.base}/pulls/comments/${id}`, {
        body,
      }),
    );
  }
  async postIssueComment(body: string) {
    return this.comment(
      await this.token.request(
        "POST",
        `${this.base}/issues/${this.number}/comments`,
        { body },
      ),
    );
  }
  async editIssueComment(id: number, body: string) {
    return this.comment(
      await this.token.request("PATCH", `${this.base}/issues/comments/${id}`, {
        body,
      }),
    );
  }
  async threads() {
    if (this.threadMap) return this.threadMap;
    const map = new Map<number, { id: string; resolved: boolean }>();
    const [owner, name] = this.repository.split("/");
    let after: string | null = null;
    for (let page = 0; page < 20; page++) {
      const data: any = await this.token.graphql(
        "query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{id isResolved comments(first:1){nodes{databaseId}}}}}}}",
        { owner, name, number: this.number, after },
      );
      const threads = data?.repository?.pullRequest?.reviewThreads;
      for (const t of threads?.nodes ?? []) {
        const first = t?.comments?.nodes?.[0]?.databaseId;
        if (Number.isSafeInteger(first))
          map.set(first, { id: t.id, resolved: !!t.isResolved });
      }
      if (!threads?.pageInfo?.hasNextPage) break;
      after = threads.pageInfo.endCursor;
    }
    this.threadMap = map;
    return map;
  }
  async resolveThread(id: string, resolved: boolean) {
    const mutate = (token: InstallationToken) =>
      token.graphql(
        resolved
          ? "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}"
          : "mutation($id:ID!){unresolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}",
        { id },
      );
    if (!this.installation) return void (await mutate(this.token));
    await withToken(
      this.installation.env,
      this.installation.id,
      this.repository,
      RESOLVE_PERMISSIONS,
      mutate,
    );
  }
  async checkRun(head: string, output: CheckOutput, existing?: number) {
    let id = existing;
    const name = output.name ?? "rio/review";
    if (!id) {
      const runs = await this.token.request(
        "GET",
        `${this.base}/commits/${head}/check-runs?check_name=${encodeURIComponent(name)}&filter=latest`,
      );
      id = (runs?.check_runs ?? []).find(
        (r: any) => r?.app?.slug === this.slug,
      )?.id;
    }
    // QA can fail its own explicit policy. The general review check stays neutral.
    let annotations = output.annotations ?? [];
    if (id && annotations.length) {
      const prior = await this.token.list(
        `${this.base}/check-runs/${id}/annotations`,
      );
      const key = (row: any) =>
        JSON.stringify([
          row.path,
          row.start_line,
          row.end_line,
          row.annotation_level,
          row.title,
          row.message,
        ]);
      const seen = new Set(prior.map(key));
      annotations = annotations.filter((row) => !seen.has(key(row)));
    }
    const body = {
      name,
      status: "completed",
      conclusion:
        name === "rio/qa" ? (output.conclusion ?? "neutral") : "neutral",
      completed_at: new Date().toISOString(),
      output: {
        title: output.title.slice(0, 255),
        summary: output.summary.slice(0, 60000),
        ...(annotations.length
          ? { annotations: annotations.slice(0, 50) }
          : {}),
      },
    };
    const run = id
      ? await this.token.request("PATCH", `${this.base}/check-runs/${id}`, body)
      : await this.token.request("POST", `${this.base}/check-runs`, {
          ...body,
          head_sha: head,
        });
    for (let offset = 50; offset < annotations.length; offset += 50)
      await this.token.request("PATCH", `${this.base}/check-runs/${run.id}`, {
        output: {
          title: body.output.title,
          summary: body.output.summary,
          annotations: annotations.slice(offset, offset + 50),
        },
      });
    return { id: run.id, url: run.html_url ?? "" };
  }
  /** The in-progress check run a review starts with; `checkRun` completes it. */
  async startCheckRun(head: string) {
    const run = await this.token.request("POST", `${this.base}/check-runs`, {
      name: "rio/review",
      head_sha: head,
      status: "in_progress",
      started_at: new Date().toISOString(),
      output: {
        title: `Reviewing ${head.slice(0, 7)}…`,
        summary:
          "Rio is reviewing this pull request. Findings appear inline and in the summary comment when the review finishes, usually within a few minutes.\n\nRio's check run is always neutral: it never approves and never blocks a merge.",
      },
    });
    return { id: run.id as number, url: run.html_url ?? "" };
  }
  async react(comment: number, content: "+1" | "-1" | "confused") {
    await this.token.request(
      "POST",
      `${this.base}/issues/comments/${comment}/reactions`,
      { content },
    );
  }
}

export interface PublishInput {
  review: string;
  report: any;
  // From the resolved profile only; never from payload text.
  policy: Policy;
  fail_on: any;
  lineage: { id: string; snapshot_id: string } | null;
  // Lifecycle updates of earlier findings this review did not produce.
  updates: { id: string; status: string; resolution: any }[];
  prior: { id: string; finding: Finding }[];
  publicUrl?: string;
}

export function decide(
  policy: Policy,
  row: PullRow,
  escalated: boolean,
): { full: boolean; check: boolean; reason?: Unpublished } {
  if (policy === "never")
    return { full: false, check: false, reason: "policy_never" };
  if (row.fork && !escalated)
    return { full: false, check: false, reason: "fork_not_escalated" };
  if (policy === "auto" || (row.trigger === "cli" && row.consent))
    return { full: true, check: true };
  // `ask`: a CLI review waits for consent; webhook and command reviews post the check run only.
  return {
    full: false,
    check: row.trigger !== "cli",
    reason: "ask_without_consent",
  };
}

function anchorable(f: Finding): boolean {
  if (f.qa) return f.qa.attribution === "source";
  // Class findings belong in the summary; any other finding is anchored at its
  // primary location, and the comment lists the other places it cites.
  return !f.locations.some((l) => l.id);
}

export function findingAnchor(
  f: Finding,
  files: Map<string, { removed: boolean; lines: Set<number> }>,
): number | undefined {
  const file = files.get(f.location.path);
  if (!anchorable(f) || !file || file.removed) return undefined;
  if (file.lines.has(f.location.line_start)) return f.location.line_start;
  if (f.qa?.attribution === "source" && file.lines.size)
    return [...file.lines].reduce((first, line) => Math.min(first, line));
  return undefined;
}

export function qaCheckOutput(
  report: any,
  files: Map<string, { removed: boolean; lines: Set<number> }>,
): CheckOutput {
  const counts = new Map<string, number>();
  for (const journey of report.qa.journeys ?? [])
    counts.set(journey.outcome, (counts.get(journey.outcome) ?? 0) + 1);
  const summary = ["passed", "failed", "skipped", "not_run", "cancelled"]
    .map((state) => `${state}: ${counts.get(state) ?? 0}`)
    .join(" · ");
  const failed = report.agent_audit?.qa?.policy_failed === true;
  const annotations: NonNullable<CheckOutput["annotations"]> = [];
  for (const finding of report.findings ?? []) {
    if (
      !finding.qa ||
      finding.evidence_level === "refuted" ||
      ["fixed", "pre-existing"].includes(finding.state) ||
      ["fixed", "dismissed"].includes(finding.status)
    )
      continue;
    const line = findingAnchor(finding, files);
    if (line === undefined) continue;
    annotations.push({
      path: finding.location.path,
      start_line: line,
      end_line: line,
      annotation_level:
        finding.severity === "error"
          ? "failure"
          : finding.severity === "warning"
            ? "warning"
            : "notice",
      title: plain(
        `${finding.rule_id} (${finding.id.slice(0, DISPLAY_ID_LEN)})`,
        255,
      ),
      message: plain(
        `${finding.message}\nJourney: ${finding.qa.journey}; step ${finding.qa.step}; cells: ${finding.locations.map((row: any) => `${row.cell?.viewport}/${row.cell?.color_scheme}`).join(", ")}${line !== finding.location.line_start ? `\nAttributed to ${finding.location.path}:${finding.location.line_start}` : ""}`,
        60000,
      ),
    });
  }
  return {
    name: "rio/qa",
    conclusion: failed ? "failure" : "neutral",
    title: `QA ${failed ? "failed its policy" : "completed"} · ${summary}`,
    summary: `Journeys — ${summary}\n\nIsolation: **${plain(report.qa.isolation)}**. QA never approves a review.`,
    annotations,
  };
}

export function checkOutput(
  report: any,
  failOn: any,
  options: { askNote?: number; link: string },
): { title: string; summary: string } {
  const all = lists(report);
  const matching = verdict(report, failOn).toFix.length;
  const tier = report.risk_tier?.tier ?? "unknown";
  const counts = `${report.findings.length} finding(s), ${report.risks.length} risk(s)${report.security?.length ? `, ${report.security.length} security` : ""}`;
  const status =
    report.status === "complete" ? "" : ` · review ${report.status}`;
  const title = !all.length
    ? `No findings produced · risk tier ${tier}${status}`
    : matching
      ? `Review failed its policy: ${matching} match fail_on · ${counts} · risk tier ${tier}${status}`
      : `${counts}; none match fail_on · risk tier ${tier}${status}`;
  const tables = findingTables(report, failOn, new Map());
  const summary = [
    provenance(report),
    "",
    ...alert(report, failOn),
    "",
    ...scoreboard(report, failOn),
    ...(options.askNote
      ? [
          "",
          `Comments were not posted: this repository's profile sets \`publish: ask\`. Set \`publish: auto\`, or run \`rio review --pr ${options.askNote} --publish\`.`,
        ]
      : []),
    ...(tables.length ? ["", ...tables] : []),
    "",
    reportLine(
      options.link,
      options.askNote ?? report.review?.pull_request?.number,
    ),
    "",
    "Rio's check run is always neutral: it never approves and never blocks a merge.",
  ].join("\n");
  return { title, summary };
}

/** How long one publication may hold its lineage, and how long another waits. */
const LEASE_MS = 5 * 60 * 1000;
const LEASE_WAIT_MS = 60 * 1000;
/** A publisher whose lease expired or was taken stops before its next write. */
export class LeaseLost extends Error {
  constructor() {
    super("publication lease lost; retried on the next round");
  }
}
export interface Lease {
  env: Env;
  tenant: string;
  lineage: string;
  holder: string;
}
/**
 * Serializes publication and `/rio dismiss` effects per lineage:
 * reconciliation, external writes and records never interleave.
 */
export async function acquireLease(
  env: Env,
  tenant: string,
  lineage: string,
  wait = LEASE_WAIT_MS,
): Promise<Lease | null> {
  const holder = crypto.randomUUID();
  const deadline = Date.now() + wait;
  while (true) {
    const now = Date.now();
    const row = await env.DB.prepare(
      "INSERT INTO publication_leases(tenant,lineage_id,holder,until) VALUES(?,?,?,?) ON CONFLICT(tenant,lineage_id) DO UPDATE SET holder=excluded.holder,until=excluded.until WHERE publication_leases.until<? RETURNING holder",
    )
      .bind(tenant, lineage, holder, now + LEASE_MS, now)
      .first<{ holder: string }>();
    if (row?.holder === holder) return { env, tenant, lineage, holder };
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
/** Extends a held lease before an external write; throws when it was lost. */
export async function renewLease(lease: Lease): Promise<void> {
  const now = Date.now();
  const result = await lease.env.DB.prepare(
    "UPDATE publication_leases SET until=? WHERE tenant=? AND lineage_id=? AND holder=? AND until>?",
  )
    .bind(now + LEASE_MS, lease.tenant, lease.lineage, lease.holder, now)
    .run();
  if (!result.meta.changes) throw new LeaseLost();
}
/** Releases the lease; the row keeps the lineage's last published round. */
export async function releaseLease(lease: Lease): Promise<void> {
  await lease.env.DB.prepare(
    "UPDATE publication_leases SET holder='',until=0 WHERE tenant=? AND lineage_id=? AND holder=?",
  )
    .bind(lease.tenant, lease.lineage, lease.holder)
    .run();
}
/** Every write to the host first renews the lease. */
function guarded(host: Host, lease: Lease): Host {
  const renewed =
    <A extends unknown[], R>(write: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      await renewLease(lease);
      return write(...args);
    };
  return {
    files: () => host.files(),
    reviewComments: () => host.reviewComments(),
    issueComments: () => host.issueComments(),
    threads: () => host.threads(),
    postReviewComment: renewed((input) => host.postReviewComment(input)),
    editReviewComment: renewed((id: number, body: string) =>
      host.editReviewComment(id, body),
    ),
    postIssueComment: renewed((body: string) => host.postIssueComment(body)),
    editIssueComment: renewed((id: number, body: string) =>
      host.editIssueComment(id, body),
    ),
    resolveThread: renewed((id: string, resolved: boolean) =>
      host.resolveThread(id, resolved),
    ),
    checkRun: renewed((head: string, output: CheckOutput, existing?: number) =>
      host.checkRun(head, output, existing),
    ),
    react: renewed((comment: number, content: "+1" | "-1" | "confused") =>
      host.react(comment, content),
    ),
  };
}
/** The lineage's recorded answer to an identity, if any (current generation). */
async function answerOf(
  env: Env,
  tenant: string,
  lineage: string,
  identity: string,
): Promise<AuthorResponse | null> {
  const row = await env.DB.prepare(
    "SELECT f.author_response_json FROM findings f JOIN lineages l ON l.id=f.lineage_id AND l.generation=f.generation WHERE f.tenant=? AND f.lineage_id=? AND f.identity=? AND f.author_response_json IS NOT NULL",
  )
    .bind(tenant, lineage, identity)
    .first<{ author_response_json: string }>();
  return row ? JSON.parse(row.author_response_json) : null;
}

function failureText(error: unknown): string {
  if (error instanceof GitHubError) return error.message.slice(0, 300);
  return (error instanceof Error ? error.message : "publication failed").slice(
    0,
    300,
  );
}

/**
 * Publishes a finished PR review under the profile's policy. Returns null for
 * reviews outside PR mode (no publication step ran). A host outage never fails
 * the review: it is recorded as a failed publication, retried next round.
 */
/** Whether a maintainer escalated this pull request with `/rio review`. */
export async function escalatedPull(env: Env, row: PullRow): Promise<boolean> {
  return !!(await env.DB.prepare(
    "SELECT 1 AS e FROM pull_requests WHERE tenant=? AND repository=? AND number=? AND escalated=1 LIMIT 1",
  )
    .bind(row.tenant, row.repository, row.number)
    .first());
}
export async function publishReview(
  env: Env,
  input: PublishInput,
  host?: (
    token: InstallationToken,
    row: PullRow,
    bot: string,
    slug: string,
  ) => Host,
): Promise<Publication | null> {
  let result: Publication | null;
  try {
    result = await publishWith(env, input, host);
  } catch (error) {
    result = {
      policy: ["never", "ask", "auto"].includes(input.policy)
        ? input.policy
        : "never",
      posted: 0,
      edited: 0,
      resolved: 0,
      failed: 1,
      unanchored: 0,
      check_run_url: null,
      summary_comment_url: null,
      failures: [
        { id: "publication", kind: "summary", error: failureText(error) },
      ],
    };
  }
  // The in-progress check run is either completed by this publication or
  // completed here with the reason nothing was published.
  if (result?.check_run_url) await announcementPublished(env, input.review);
  else
    await settleAnnouncement(
      env,
      input.review,
      "Review finished; nothing was published",
      result?.reason === "policy_never"
        ? "This repository's profile sets `publish: never`, so Rio posts nothing on this pull request."
        : result?.failures?.length
          ? `The review finished, but publishing failed: ${plain(result.failures[0].error, 300)}. The next push retries it.`
          : "The review finished without a publication for this head.",
    );
  return result;
}
/**
 * Publishes a finished PR review under the profile's policy. Returns null for
 * reviews outside PR mode (no publication step ran).
 */
async function publishWith(
  env: Env,
  input: PublishInput,
  host?: (
    token: InstallationToken,
    row: PullRow,
    bot: string,
    slug: string,
  ) => Host,
): Promise<Publication | null> {
  const row = await pullOf(env, input.review);
  if (!row || !input.lineage) return null;
  const policy: Policy = ["never", "ask", "auto"].includes(input.policy)
    ? input.policy
    : "never";
  const empty = (reason?: Unpublished): Publication => ({
    policy,
    posted: 0,
    edited: 0,
    resolved: 0,
    failed: 0,
    unanchored: 0,
    check_run_url: null,
    summary_comment_url: null,
    ...(reason ? { reason } : {}),
  });
  const install = await installation(env, row.installation_id);
  if (!install || !covers(install, row.repository))
    return empty("no_installation");
  const decision = decide(policy, row, await escalatedPull(env, row));
  if (!decision.check) return empty(decision.reason);
  const publication = empty(decision.reason);
  const link = `${(input.publicUrl ?? env.PUBLIC_URL ?? "").replace(/\/$/, "")}/v1/reviews/${input.review}/report`;
  const busy = (error: string): Publication => ({
    ...publication,
    failed: 1,
    failures: [{ id: "publication", kind: "summary", error }],
  });
  const lease = await acquireLease(env, row.tenant, input.lineage.id);
  if (!lease)
    return busy(
      "another publication of this pull request is in progress; retried on the next round",
    );
  try {
    // Rounds publish in order: an older round never writes over a newer one.
    const mine = await env.DB.prepare(
      "SELECT seq FROM lineage_reviews WHERE review_id=?",
    )
      .bind(input.review)
      .first<{ seq: number }>();
    const last = await env.DB.prepare(
      "SELECT published_seq FROM publication_leases WHERE tenant=? AND lineage_id=?",
    )
      .bind(row.tenant, input.lineage.id)
      .first<{ published_seq: number }>();
    if (mine && last && last.published_seq > mine.seq)
      return busy(
        "a later round of this pull request was already published; this round is not published over it",
      );
    const result = await publishLeased(
      env,
      input,
      row,
      decision,
      publication,
      link,
      lease,
      host,
    );
    if (mine)
      await env.DB.prepare(
        "UPDATE publication_leases SET published_seq=MAX(published_seq,?) WHERE tenant=? AND lineage_id=? AND holder=?",
      )
        .bind(mine.seq, row.tenant, input.lineage.id, lease.holder)
        .run();
    return result;
  } finally {
    await releaseLease(lease);
  }
}

async function publishLeased(
  env: Env,
  input: PublishInput,
  row: PullRow,
  decision: { full: boolean; check: boolean; reason?: Unpublished },
  publication: Publication,
  link: string,
  lease: Lease,
  host?: (
    token: InstallationToken,
    row: PullRow,
    bot: string,
    slug: string,
  ) => Host,
): Promise<Publication> {
  const lineage = input.lineage!.id;
  const failures: NonNullable<Publication["failures"]> = [];
  const app = await appRequest(env, "GET", "/app");
  const slug = String(app?.slug ?? "");
  const token = await InstallationToken.mint(
    env,
    row.installation_id,
    row.repository,
    PUBLISH_PERMISSIONS,
  );
  const records = new Map<string, any>();
  // Inline comment links, for the summary's findings table.
  const urls = new Map<string, string>();
  const save = async (
    kind: "finding" | "summary" | "check_run",
    identity: string,
    state: "posted" | "edited" | "resolved" | "failed",
    values: {
      external?: number | null;
      thread?: string | null;
      error?: string | null;
      body?: string;
      url?: string | null;
    },
  ) => {
    if (kind === "finding" && values.url) urls.set(identity, values.url);
    await env.DB.prepare(
      "INSERT INTO publications(tenant,lineage_id,identity,review_id,kind,state,external_id,thread_id,error,attempts,updated_at,body_hash,url) VALUES(?,?,?,?,?,?,?,?,?,1,?,?,?) ON CONFLICT(tenant,lineage_id,kind,identity) DO UPDATE SET review_id=excluded.review_id,state=excluded.state,external_id=COALESCE(excluded.external_id,publications.external_id),thread_id=COALESCE(excluded.thread_id,publications.thread_id),error=excluded.error,attempts=publications.attempts+1,updated_at=excluded.updated_at,body_hash=COALESCE(excluded.body_hash,publications.body_hash),url=COALESCE(excluded.url,publications.url)",
    )
      .bind(
        row.tenant,
        lineage,
        identity,
        input.review,
        kind,
        state,
        values.external === undefined || values.external === null
          ? null
          : String(values.external),
        values.thread ?? null,
        values.error ?? null,
        Date.now(),
        values.body === undefined ? null : hash(values.body),
        values.url ?? null,
      )
      .run();
  };
  try {
    for (const r of (
      await env.DB.prepare(
        "SELECT * FROM publications WHERE tenant=? AND lineage_id=?",
      )
        .bind(row.tenant, lineage)
        .all<any>()
    ).results) {
      records.set(`${r.kind}:${r.identity}`, r);
      if (r.kind === "finding" && r.url) urls.set(r.identity, r.url);
    }
    const github = guarded(
      host
        ? host(token, row, `${slug}[bot]`, slug)
        : new GitHubHost(
            token,
            row.repository,
            row.number,
            `${slug}[bot]`,
            slug,
            { env, id: row.installation_id },
          ),
      lease,
    );
    if (decision.full) {
      await refreshQaReportLinks(
        env,
        row.tenant,
        input.review,
        input.report,
        input.publicUrl ?? env.PUBLIC_URL ?? "https://rio.invalid",
      );
      const files = await github.files();
      // Marker reconciliation: a lost record never causes a duplicate.
      const comments = new Map<string, HostComment>();
      for (const c of await github.reviewComments()) {
        const id = FINDING_MARKER.exec(c.body)?.[1];
        if (id && !comments.has(id)) comments.set(id, c);
      }
      const unanchored: Finding[] = [],
        rejected: { f: Finding; error: string }[] = [],
        wrong: Finding[] = [];
      /**
       * Brings a posted comment to `body` and its thread to `wantResolved`
       * (null leaves it). A thread counts as Rio's only when Rio resolved it.
       */
      const settle = async (
        id: string,
        comment: HostComment,
        body: string,
        wantResolved: boolean | null,
      ) => {
        const rioResolved = records.get(`finding:${id}`)?.state === "resolved";
        let current = comment;
        let state: "posted" | "edited" | "resolved" = "posted";
        if (comment.body !== body) {
          current = await github.editReviewComment(comment.id, body);
          publication.edited++;
          state = "edited";
        }
        let thread: string | null = null;
        if (wantResolved !== null) {
          const t = (await github.threads()).get(comment.id);
          if (t) {
            thread = t.id;
            if (t.resolved !== wantResolved) {
              await github.resolveThread(t.id, wantResolved);
              if (wantResolved) {
                publication.resolved++;
                state = "resolved";
              }
            } else if (wantResolved && rioResolved) state = "resolved";
          }
        }
        await save("finding", id, state, {
          external: comment.id,
          thread,
          body,
          url: current.url,
        });
      };
      const failed = async (id: string, error: unknown, comment?: number) => {
        if (error instanceof LeaseLost) throw error;
        const message = failureText(error);
        publication.failed++;
        failures.push({ id, kind: "finding", error: message });
        await save("finding", id, "failed", {
          error: message,
          external: comment ?? null,
        });
        return message;
      };
      // Answers recorded in the lineage win over the report's: a dismissal
      // given after the report was written is never ignored or undone.
      const answered = new Map<string, AuthorResponse>();
      for (const r of (
        await env.DB.prepare(
          "SELECT f.identity,f.author_response_json FROM findings f JOIN lineages l ON l.id=f.lineage_id AND l.generation=f.generation WHERE f.tenant=? AND f.lineage_id=? AND f.author_response_json IS NOT NULL",
        )
          .bind(row.tenant, lineage)
          .all<{ identity: string; author_response_json: string }>()
      ).results)
        answered.set(r.identity, JSON.parse(r.author_response_json));
      const handled = new Set<string>();
      for (const report of lists(input.report)) {
        handled.add(report.id);
        const response = answered.get(report.id);
        const f: Finding = response
          ? { ...report, status: "dismissed", author_response: response }
          : report;
        const state: FindingState =
          f.status === "dismissed"
            ? { status: "dismissed", response: f.author_response }
            : { status: "open" };
        const anchor = findingAnchor(f, files);
        const existing = comments.get(f.id);
        // A suggestion replaces the lines its comment spans: an edit keeps one
        // only when the posted comment already carried it.
        const lines =
          !existing || existing.body.includes("suggestion\n")
            ? files.get(f.location.path)?.lines
            : undefined;
        const range = suggestionRange(f, anchor, lines);
        const body = findingBody(f, state, input.report.qa, anchor, {
          failOn: input.fail_on,
          lines,
        });
        try {
          if (existing) {
            // A reopened finding's thread is unresolved only when Rio resolved
            // it; a thread a person resolved stays resolved.
            const resolvedByRio =
              records.get(`finding:${f.id}`)?.state === "resolved";
            await settle(
              f.id,
              existing,
              body,
              state.status === "dismissed"
                ? true
                : resolvedByRio
                  ? false
                  : null,
            );
            continue;
          }
          const record = records.get(`finding:${f.id}`);
          // Posted once per lineage: a recorded post, even one whose later edit
          // failed or whose comment is gone, is never posted again.
          if (record && (record.state !== "failed" || record.external_id))
            continue;
          // Capped agent findings are summarized; dismissed ones are never posted.
          if (!f.first_posted_in || f.status === "dismissed") continue;
          if (f.history?.previous_response?.reason === "wrong") {
            wrong.push(f);
            continue;
          }
          if (anchor === undefined) {
            unanchored.push(f);
            publication.unanchored++;
            continue;
          }
          // A dismissal recorded while this publication ran is honored too;
          // `/rio dismiss` edits comments only under the same lease.
          if (await answerOf(env, row.tenant, lineage, f.id)) continue;
          const posted = await github.postReviewComment({
            body,
            commit: row.head_sha!,
            path: f.location.path,
            ...(range && range.line_end > range.line_start
              ? { line: range.line_end, start_line: range.line_start }
              : { line: anchor }),
          });
          publication.posted++;
          await save("finding", f.id, "posted", {
            external: posted.id,
            body,
            url: posted.url,
          });
        } catch (error) {
          rejected.push({ f, error: await failed(f.id, error) });
        }
      }
      // Earlier findings fixed by this round: edit and resolve their threads,
      // unless the lineage has since recorded an answer.
      const prior = new Map(input.prior.map((p) => [p.id, p.finding]));
      const closing = (id: string, f: Finding, fixedIn?: string) => {
        const response = answered.get(id);
        return findingBody(
          f,
          response
            ? { status: "dismissed", response }
            : { status: "fixed", fixed_in: fixedIn },
        );
      };
      for (const u of input.updates) {
        const comment = comments.get(u.id),
          f = prior.get(u.id);
        if (!comment || !f || u.status !== "fixed") continue;
        handled.add(u.id);
        try {
          await settle(
            u.id,
            comment,
            closing(u.id, f, row.head_sha ?? undefined),
            true,
          );
        } catch (error) {
          await failed(u.id, error, comment.id);
        }
      }
      // Closing edits that failed in an earlier round are retried.
      for (const r of (
        await env.DB.prepare(
          "SELECT f.identity,f.status,f.finding_json FROM findings f JOIN lineages l ON l.id=f.lineage_id AND l.generation=f.generation JOIN publications p ON p.tenant=f.tenant AND p.lineage_id=f.lineage_id AND p.kind='finding' AND p.identity=f.identity WHERE f.tenant=? AND f.lineage_id=? AND p.state='failed' AND p.external_id IS NOT NULL AND f.status IN ('fixed','dismissed')",
        )
          .bind(row.tenant, lineage)
          .all<{ identity: string; status: string; finding_json: string }>()
      ).results) {
        const comment = comments.get(r.identity);
        if (handled.has(r.identity) || !comment) continue;
        try {
          await settle(
            r.identity,
            comment,
            closing(r.identity, JSON.parse(r.finding_json).finding),
            true,
          );
        } catch (error) {
          await failed(r.identity, error, comment.id);
        }
      }
      const body = summaryBody({
        report: input.report,
        lineage,
        unanchored,
        rejected,
        wrong,
        link,
        failOn: input.fail_on,
        urls,
        fixed: input.updates.filter((u) => u.status === "fixed").length,
      });
      try {
        const existing = (await github.issueComments()).find(
          (c) => SUMMARY_MARKER.exec(c.body)?.[1] === lineage,
        );
        const summary = existing
          ? existing.body === body
            ? existing
            : await github.editIssueComment(existing.id, body)
          : await github.postIssueComment(body);
        publication.summary_comment_url = summary.url || null;
        await save("summary", "summary", existing ? "edited" : "posted", {
          external: summary.id,
          body,
          url: summary.url,
        });
      } catch (error) {
        if (error instanceof LeaseLost) throw error;
        publication.failed++;
        failures.push({
          id: "summary",
          kind: "summary",
          error: failureText(error),
        });
        await save("summary", "summary", "failed", {
          error: failureText(error),
        });
      }
    }
    try {
      const record = records.get(`check_run:${row.head_sha}`);
      const run = await github.checkRun(
        row.head_sha!,
        checkOutput(input.report, input.fail_on, {
          askNote: decision.full ? undefined : row.number,
          link,
        }),
        record?.external_id
          ? Number(record.external_id)
          : (row.announced_check ?? undefined),
      );
      publication.check_run_url = run.url || null;
      await save("check_run", row.head_sha!, record ? "edited" : "posted", {
        external: run.id,
        url: run.url,
      });
    } catch (error) {
      if (error instanceof LeaseLost) throw error;
      publication.failed++;
      failures.push({
        id: row.head_sha!,
        kind: "check_run",
        error: failureText(error),
      });
      await save("check_run", row.head_sha!, "failed", {
        error: failureText(error),
      });
    }
    if (input.report.qa) {
      const identity = `${row.head_sha}:qa`;
      try {
        const output = qaCheckOutput(input.report, await github.files());
        const record = records.get(`check_run:${identity}`);
        const run = await github.checkRun(
          row.head_sha!,
          output,
          record?.external_id ? Number(record.external_id) : undefined,
        );
        await save("check_run", identity, record ? "edited" : "posted", {
          external: run.id,
          url: run.url,
        });
      } catch (error) {
        if (error instanceof LeaseLost) throw error;
        publication.failed++;
        failures.push({
          id: identity,
          kind: "check_run",
          error: failureText(error),
        });
        await save("check_run", identity, "failed", {
          error: failureText(error),
        });
      }
    }
  } finally {
    await token.revoke();
  }
  if (failures.length) publication.failures = failures;
  return publication;
}

/**
 * Shows a `/rio dismiss` on the finding's comment and resolves its thread,
 * under the lineage's publication lease so it cannot interleave with a
 * publisher; without the lease the next publication applies the answer.
 */
export async function reflectDismissal(
  env: Env,
  token: InstallationToken,
  row: {
    tenant: string;
    lineage: string;
    repository: string;
    number: number;
    installation: number;
  },
  finding: Finding,
  response: AuthorResponse,
): Promise<void> {
  const lease = await acquireLease(env, row.tenant, row.lineage);
  if (!lease) return;
  try {
    const app = await appRequest(env, "GET", "/app");
    const slug = String(app?.slug ?? "");
    const github = guarded(
      new GitHubHost(token, row.repository, row.number, `${slug}[bot]`, slug, {
        env,
        id: row.installation,
      }),
      lease,
    );
    const comment = (await github.reviewComments()).find(
      (c) => FINDING_MARKER.exec(c.body)?.[1] === finding.id,
    );
    if (!comment) return;
    await github.editReviewComment(
      comment.id,
      findingBody(finding, { status: "dismissed", response }),
    );
    const thread = (await github.threads()).get(comment.id);
    if (thread && !thread.resolved) {
      await github.resolveThread(thread.id, true);
      // Rio resolved it, so a later reopening may unresolve it.
      await env.DB.prepare(
        "UPDATE publications SET state='resolved',thread_id=?,updated_at=? WHERE tenant=? AND lineage_id=? AND kind='finding' AND identity=?",
      )
        .bind(thread.id, Date.now(), row.tenant, row.lineage, finding.id)
        .run();
    }
  } finally {
    await releaseLease(lease);
  }
}

/** Publishes a finished review again after CLI consent (`POST /v1/reviews/{id}/publish`). */
/** A finished PR review's report and the inputs its publication needs. */
async function finishedInput(env: Env, review: string) {
  const row = await env.DB.prepare(
    "SELECT r.report_key,r.submission_key,lr.lineage_id,lr.snapshot_id FROM reviews r LEFT JOIN lineage_reviews lr ON lr.review_id=r.id WHERE r.id=?",
  )
    .bind(review)
    .first<{
      report_key: string | null;
      submission_key: string;
      lineage_id: string | null;
      snapshot_id: string | null;
    }>();
  if (!row?.report_key || !row.lineage_id || !row.snapshot_id) return null;
  const store = new Store(env);
  const [report, submission] = await Promise.all([
    store.get<any>(row.report_key),
    store.get<any>(row.submission_key),
  ]);
  const updates: PublishInput["updates"] =
    report.agent_audit?.lineage_updates ?? [];
  const prior = (
    await env.DB.prepare(
      "SELECT identity,finding_json FROM findings WHERE lineage_id=? AND identity IN (SELECT value FROM json_each(?))",
    )
      .bind(row.lineage_id, JSON.stringify(updates.map((u) => u.id)))
      .all<{ identity: string; finding_json: string }>()
  ).results.map((r) => ({
    id: r.identity,
    finding: JSON.parse(r.finding_json).finding,
  }));
  const found = {
    report_key: row.report_key,
    lineage_id: row.lineage_id,
    snapshot_id: row.snapshot_id,
  };
  return { row: found, store, report, submission, updates, prior };
}

export async function publishFinished(env: Env, review: string): Promise<void> {
  const loaded = await finishedInput(env, review);
  if (!loaded) return;
  const { row, store, report, submission, updates, prior } = loaded;
  // An older round never republishes over a newer one's comments.
  const later = await env.DB.prepare(
    "SELECT 1 AS later FROM lineage_reviews WHERE lineage_id=? AND reviewed=1 AND seq>(SELECT seq FROM lineage_reviews WHERE review_id=?) LIMIT 1",
  )
    .bind(row.lineage_id, review)
    .first();
  if (later) {
    report.publication = {
      ...(report.publication ?? {}),
      policy: report.publication?.policy ?? "ask",
      posted: 0,
      edited: 0,
      resolved: 0,
      failed: 1,
      unanchored: 0,
      check_run_url: report.publication?.check_run_url ?? null,
      summary_comment_url: null,
      reason: undefined,
      failures: [
        {
          id: "publication",
          kind: "summary",
          error:
            "a later round of this pull request superseded this review; publish that round instead",
        },
      ],
    };
    delete report.publication.reason;
    await store.put(row.report_key, report);
    await store.event(review, "review:published", {
      publication: report.publication,
    });
    return;
  }
  const publication = await publishReview(env, {
    review,
    report,
    policy: submission.profile?.publish,
    fail_on: submission.profile?.fail_on,
    lineage: { id: row.lineage_id, snapshot_id: row.snapshot_id },
    updates,
    prior,
  });
  if (!publication) return;
  report.publication = publication;
  await store.put(row.report_key, report);
  await store.event(review, "review:published", { publication });
}

export interface Preview {
  policy: Policy;
  /** Why nothing, or only the check run, would be posted. */
  reason?: Unpublished;
  comments: {
    id: string;
    path: string;
    line: number;
    start_line?: number;
    body: string;
  }[];
  /** Findings that would be listed in the summary only. */
  unanchored: string[];
  summary: string | null;
  check: CheckOutput | null;
}

/**
 * What publishing a finished PR review would post, rendered by the same
 * functions the publisher uses. Reads the pull request's diff with a
 * read-only token and never writes to the host (terminal-ui "Publish only on
 * consent").
 */
export async function previewReview(
  env: Env,
  input: PublishInput,
  files?: Map<string, { removed: boolean; lines: Set<number> }>,
): Promise<Preview | null> {
  const row = await pullOf(env, input.review);
  if (!row || !input.lineage) return null;
  const policy: Policy = ["never", "ask", "auto"].includes(input.policy)
    ? input.policy
    : "never";
  const nothing = (reason?: Unpublished): Preview => ({
    policy,
    ...(reason ? { reason } : {}),
    comments: [],
    unanchored: [],
    summary: null,
    check: null,
  });
  const install = await installation(env, row.installation_id);
  if (!install || !covers(install, row.repository))
    return nothing("no_installation");
  // The preview shows what consent would publish: a CLI review under `ask`.
  const decision = decide(
    policy,
    { ...row, trigger: "cli", consent: 1 },
    await escalatedPull(env, row),
  );
  if (!decision.check) return nothing(decision.reason);
  const link = `${(input.publicUrl ?? env.PUBLIC_URL ?? "").replace(/\/$/, "")}/v1/reviews/${input.review}/report`;
  const check = checkOutput(input.report, input.fail_on, { link });
  if (!decision.full) return { ...nothing(decision.reason), check };
  if (!files) {
    const token = await InstallationToken.mint(
      env,
      row.installation_id,
      row.repository,
      PREPARE_PERMISSIONS,
    );
    try {
      files = await new GitHubHost(
        token,
        row.repository,
        row.number,
        "",
        "",
      ).files();
    } finally {
      await token.revoke();
    }
  }
  const comments: Preview["comments"] = [];
  const unanchored: Finding[] = [];
  const wrong: Finding[] = [];
  for (const f of lists(input.report)) {
    if (!f.first_posted_in || f.status === "dismissed") continue;
    if (f.history?.previous_response?.reason === "wrong") {
      wrong.push(f);
      continue;
    }
    const anchor = findingAnchor(f, files);
    if (anchor === undefined) {
      unanchored.push(f);
      continue;
    }
    const lines = files.get(f.location.path)?.lines;
    const range = suggestionRange(f, anchor, lines);
    comments.push({
      id: f.id,
      path: f.location.path,
      ...(range && range.line_end > range.line_start
        ? { line: range.line_end, start_line: range.line_start }
        : { line: anchor }),
      body: findingBody(f, { status: "open" }, input.report.qa, anchor, {
        failOn: input.fail_on,
        lines,
      }),
    });
  }
  return {
    policy,
    comments,
    unanchored: unanchored.map((f) => f.id),
    summary: summaryBody({
      report: input.report,
      lineage: input.lineage.id,
      unanchored,
      rejected: [],
      wrong,
      link,
      failOn: input.fail_on,
      urls: new Map(),
      fixed: input.updates.filter((u) => u.status === "fixed").length,
    }),
    check,
  };
}

/** The preview of a finished review, for `POST /v1/reviews/{id}/publish?dry_run=1`. */
export async function previewFinished(
  env: Env,
  review: string,
): Promise<Preview | null> {
  const loaded = await finishedInput(env, review);
  if (!loaded) return null;
  const { row, report, submission, updates, prior } = loaded;
  return previewReview(env, {
    review,
    report,
    policy: submission.profile?.publish,
    fail_on: submission.profile?.fail_on,
    lineage: { id: row.lineage_id, snapshot_id: row.snapshot_id },
    updates,
    prior,
  });
}

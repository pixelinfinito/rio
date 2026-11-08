import type { AuthorResponse, Env, Finding } from "./types";
import {
  GitHubError,
  InstallationToken,
  PUBLISH_PERMISSIONS,
  appRequest,
} from "./github";
import { installation, covers } from "./webhooks";
import { pullOf, type PullRow } from "./pulls";
import { policyMatches } from "./consolidate";
import { hash } from "./validation";
import { Store } from "./storage";

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
export const findingMarker = (id: string) => `<!-- rio:finding:${id} -->`;
export const summaryMarker = (lineage: string) =>
  `<!-- rio:summary:${lineage} -->`;
const FINDING_MARKER = /<!-- rio:finding:([a-f0-9]{64}) -->\s*$/;
const SUMMARY_MARKER = /<!-- rio:summary:([a-f0-9]{64}) -->\s*$/;

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
  }): Promise<HostComment>;
  editReviewComment(id: number, body: string): Promise<HostComment>;
  postIssueComment(body: string): Promise<HostComment>;
  editIssueComment(id: number, body: string): Promise<HostComment>;
  threads(): Promise<Map<number, { id: string; resolved: boolean }>>;
  resolveThread(id: string, resolved: boolean): Promise<void>;
  checkRun(
    head: string,
    output: { title: string; summary: string },
    existing?: number,
  ): Promise<{ id: number; url: string }>;
  react(comment: number, content: "+1" | "-1" | "confused"): Promise<void>;
}
export interface HostComment {
  id: number;
  body: string;
  url: string;
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
    await this.token.graphql(
      resolved
        ? "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}"
        : "mutation($id:ID!){unresolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}",
      { id },
    );
  }
  async checkRun(
    head: string,
    output: { title: string; summary: string },
    existing?: number,
  ) {
    let id = existing;
    if (!id) {
      const runs = await this.token.request(
        "GET",
        `${this.base}/commits/${head}/check-runs?check_name=${encodeURIComponent("rio/review")}&filter=latest`,
      );
      id = (runs?.check_runs ?? []).find(
        (r: any) => r?.app?.slug === this.slug,
      )?.id;
    }
    // Always neutral: the check run never approves and never blocks.
    const body = {
      name: "rio/review",
      status: "completed",
      conclusion: "neutral",
      completed_at: new Date().toISOString(),
      output: {
        title: output.title.slice(0, 255),
        summary: output.summary.slice(0, 60000),
      },
    };
    const run = id
      ? await this.token.request("PATCH", `${this.base}/check-runs/${id}`, body)
      : await this.token.request("POST", `${this.base}/check-runs`, {
          ...body,
          head_sha: head,
        });
    return { id: run.id, url: run.html_url ?? "" };
  }
  async react(comment: number, content: "+1" | "-1" | "confused") {
    await this.token.request(
      "POST",
      `${this.base}/issues/comments/${comment}/reactions`,
      { content },
    );
  }
}

/** Repository text placed in a comment: no markers, no mentions, bounded. */
export function plain(text: string, max = 2000): string {
  return text
    .replace(/<!--/g, "&lt;!--")
    .replace(/-->/g, "--&gt;")
    .replace(/@(?=[A-Za-z0-9])/g, "@​")
    .slice(0, max);
}
function where(f: { location: { path: string; line_start: number } }) {
  return `\`${plain(f.location.path, 300)}:${f.location.line_start}\``;
}
export interface FindingState {
  status: "open" | "fixed" | "dismissed";
  fixed_in?: string;
  response?: AuthorResponse;
}
export function findingBody(f: Finding, state: FindingState): string {
  const lines = [
    `**Rio ${f.category}** · ${f.severity} · \`${plain(f.rule_id, 150)}\` · evidence \`${f.evidence_level}\``,
  ];
  if (state.status === "fixed")
    lines.push(
      `**Status: fixed in ${state.fixed_in ? `\`${state.fixed_in.slice(0, 12)}\`` : "a later push"}**`,
    );
  else if (state.status === "dismissed")
    lines.push(
      `**Status: dismissed: ${state.response?.reason ?? "dismissed"}**${state.response?.actor ? ` (by ${plain(state.response.actor, 100)})` : ""}`,
    );
  lines.push("", plain(f.message));
  if (f.trigger) lines.push("", `Trigger: ${plain(f.trigger, 500)}`);
  if (f.impact) lines.push("", `Impact: ${plain(f.impact, 500)}`);
  if (f.suggested_fix)
    lines.push("", `Suggested fix: ${plain(f.suggested_fix, 1000)}`);
  if (f.locations.length > 1)
    lines.push(
      "",
      `Locations: ${f.locations
        .slice(0, 10)
        .map((l) => where({ location: l }))
        .join(", ")}`,
    );
  lines.push(
    "",
    `<sub>Finding \`${f.id.slice(0, 12)}\` · answer with \`/rio dismiss ${f.id.slice(0, 12)} <fixed|wrong|intentional|irrelevant|style>\`</sub>`,
    findingMarker(f.id),
  );
  return lines.join("\n");
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

function decide(
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

const lists = (report: any): Finding[] => {
  const seen = new Set<string>();
  return [
    ...report.findings,
    ...report.risks,
    ...(report.security ?? []),
  ].filter((f: Finding) => !seen.has(f.id) && seen.add(f.id));
};
function anchorable(f: Finding): boolean {
  // Class findings and multi-file findings belong in the summary.
  return (
    !f.locations.some((l) => l.id) &&
    new Set(f.locations.map((l) => l.path)).size <= 1
  );
}

export function checkOutput(
  report: any,
  failOn: any,
  options: { askNote?: number; link: string },
): { title: string; summary: string } {
  const all = lists(report);
  const matching = all.filter((f) => policyMatches(f, failOn ?? {})).length;
  const tier = report.risk_tier?.tier ?? "unknown";
  const counts = `${report.findings.length} finding(s), ${report.risks.length} risk(s)${report.security?.length ? `, ${report.security.length} security` : ""}`;
  const status =
    report.status === "complete" ? "" : ` · review ${report.status}`;
  const title = !all.length
    ? `No findings produced · risk tier ${tier}${status}`
    : matching
      ? `Review failed its policy: ${matching} match fail_on · ${counts} · risk tier ${tier}${status}`
      : `${counts}; none match fail_on · risk tier ${tier}${status}`;
  const summary = [
    `Status: **${report.status}** · risk tier **${tier}**${report.risk_tier?.reasons?.length ? ` (${report.risk_tier.reasons.map((r: string) => plain(r, 200)).join("; ")})` : ""}`,
    `Findings: ${report.findings.length} · Risks: ${report.risks.length} · Security: ${report.security?.length ?? 0} · Held back (already posted): ${report.lineage?.held_back ?? 0} · Remembered: ${report.remembered?.length ?? 0}`,
    ...(options.askNote
      ? [
          "",
          `Comments were not posted: this repository's profile sets \`publish: ask\`. Set \`publish: auto\`, or run \`rio review --pr ${options.askNote} --publish\`.`,
        ]
      : []),
    "",
    `Full report: ${options.link}`,
    "",
    "Rio's check run is always neutral: it never approves and never blocks a merge.",
  ].join("\n");
  return { title, summary };
}

function summaryBody(
  report: any,
  lineage: string,
  unanchored: Finding[],
  rejected: { f: Finding; error: string }[],
  wrong: Finding[],
  link: string,
): string {
  const tier = report.risk_tier;
  const lines = [
    `## Rio review · ${report.status}`,
    "",
    `Risk tier: **${tier?.tier ?? "unknown"}**${tier?.reasons?.length ? ` (${tier.reasons.map((r: string) => plain(r, 200)).join("; ")})` : ""}`,
    `Findings: ${report.findings.length} · Risks: ${report.risks.length} · Security: ${report.security?.length ?? 0} · Held back (already posted): ${report.lineage?.held_back ?? 0} · Remembered: ${report.remembered?.length ?? 0}`,
  ];
  const reconsider = report.lineage?.reconsider;
  if (reconsider) {
    lines.push(
      "",
      `### Round ${report.lineage.round} exceeds the cap of ${report.lineage.cap}`,
      `${reconsider.unresolved} agent finding(s) remain unresolved. Please reconsider the approach${reconsider.split ? " or split the change" : ""}.`,
      ...reconsider.top.map(
        (t: any) =>
          `- ${plain(t.title, 200)} (\`${plain(t.path, 300)}:${t.line_start}\`)`,
      ),
      ...(reconsider.split
        ? [
            "",
            "Suggested parts:",
            ...reconsider.split.map((p: string) => `- ${plain(p, 300)}`),
          ]
        : []),
    );
  }
  if (unanchored.length)
    lines.push(
      "",
      "### Findings outside the diff",
      ...unanchored.map(
        (f) =>
          `- ${where(f)} \`${plain(f.rule_id, 150)}\` · ${plain(f.message.split("\n")[0], 300)} (\`${f.id.slice(0, 12)}\`)`,
      ),
    );
  if (rejected.length)
    lines.push(
      "",
      "### Not posted inline (retried next round)",
      ...rejected.map(
        (r) =>
          `- ${where(r.f)} \`${plain(r.f.rule_id, 150)}\` · ${plain(r.error, 200)} (\`${r.f.id.slice(0, 12)}\`)`,
      ),
    );
  if (wrong.length)
    lines.push(
      "",
      `${wrong.length} recurring finding(s) earlier dismissed as \`wrong\` are in the report and were not posted.`,
    );
  lines.push("", `Full report: ${link}`, summaryMarker(lineage));
  return lines.join("\n");
}

/** How long one publication may hold its lineage, and how long another waits. */
const LEASE_MS = 5 * 60 * 1000;
const LEASE_WAIT_MS = 60 * 1000;
/**
 * Serializes publication per lineage: reconciliation, external writes and
 * records of one publisher never interleave with another's.
 */
async function acquireLease(
  env: Env,
  tenant: string,
  lineage: string,
  holder: string,
  wait = LEASE_WAIT_MS,
): Promise<boolean> {
  const deadline = Date.now() + wait;
  while (true) {
    const now = Date.now();
    const row = await env.DB.prepare(
      "INSERT INTO publication_leases(tenant,lineage_id,holder,until) VALUES(?,?,?,?) ON CONFLICT(tenant,lineage_id) DO UPDATE SET holder=excluded.holder,until=excluded.until WHERE publication_leases.until<? RETURNING holder",
    )
      .bind(tenant, lineage, holder, now + LEASE_MS, now)
      .first<{ holder: string }>();
    if (row?.holder === holder) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
async function releaseLease(
  env: Env,
  tenant: string,
  lineage: string,
  holder: string,
) {
  await env.DB.prepare(
    "DELETE FROM publication_leases WHERE tenant=? AND lineage_id=? AND holder=?",
  )
    .bind(tenant, lineage, holder)
    .run();
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
  try {
    return await publishWith(env, input, host);
  } catch (error) {
    return {
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
  const escalated = !!(await env.DB.prepare(
    "SELECT 1 AS e FROM pull_requests WHERE tenant=? AND repository=? AND number=? AND escalated=1 LIMIT 1",
  )
    .bind(row.tenant, row.repository, row.number)
    .first());
  const decision = decide(policy, row, escalated);
  if (!decision.check) return empty(decision.reason);
  const publication = empty(decision.reason);
  const failures: NonNullable<Publication["failures"]> = [];
  const link = `${(input.publicUrl ?? env.PUBLIC_URL ?? "").replace(/\/$/, "")}/v1/reviews/${input.review}/report`;
  const holder = crypto.randomUUID();
  if (!(await acquireLease(env, row.tenant, input.lineage.id, holder)))
    return {
      ...publication,
      failed: 1,
      failures: [
        {
          id: "publication",
          kind: "summary",
          error:
            "another publication of this pull request is in progress; retried on the next round",
        },
      ],
    };
  try {
    return await (async () => {
      const app = await appRequest(env, "GET", "/app");
      const slug = String(app?.slug ?? "");
      const token = await InstallationToken.mint(
        env,
        row.installation_id,
        row.repository,
        PUBLISH_PERMISSIONS,
      );
      const records = new Map<string, any>();
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
        await env.DB.prepare(
          "INSERT INTO publications(tenant,lineage_id,identity,review_id,kind,state,external_id,thread_id,error,attempts,updated_at,body_hash,url) VALUES(?,?,?,?,?,?,?,?,?,1,?,?,?) ON CONFLICT(tenant,lineage_id,kind,identity) DO UPDATE SET review_id=excluded.review_id,state=excluded.state,external_id=COALESCE(excluded.external_id,publications.external_id),thread_id=COALESCE(excluded.thread_id,publications.thread_id),error=excluded.error,attempts=publications.attempts+1,updated_at=excluded.updated_at,body_hash=COALESCE(excluded.body_hash,publications.body_hash),url=COALESCE(excluded.url,publications.url)",
        )
          .bind(
            row.tenant,
            input.lineage!.id,
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
            .bind(row.tenant, input.lineage!.id)
            .all<any>()
        ).results)
          records.set(`${r.kind}:${r.identity}`, r);
        const github = host
          ? host(token, row, `${slug}[bot]`, slug)
          : new GitHubHost(
              token,
              row.repository,
              row.number,
              `${slug}[bot]`,
              slug,
            );
        if (decision.full) {
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
          const settle = async (
            id: string,
            comment: HostComment,
            body: string,
            wantResolved: boolean | null,
          ) => {
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
                  if (wantResolved) publication.resolved++;
                }
                if (wantResolved) state = "resolved";
              }
            }
            await save("finding", id, state, {
              external: comment.id,
              thread,
              body,
              url: current.url,
            });
          };
          // Answers recorded in the lineage win over the report's: a dismissal
          // given after the report was written is never ignored or undone.
          const answered = new Map<string, AuthorResponse>();
          for (const r of (
            await env.DB.prepare(
              "SELECT f.identity,f.author_response_json FROM findings f JOIN lineages l ON l.id=f.lineage_id AND l.generation=f.generation WHERE f.tenant=? AND f.lineage_id=? AND f.author_response_json IS NOT NULL",
            )
              .bind(row.tenant, input.lineage!.id)
              .all<{ identity: string; author_response_json: string }>()
          ).results)
            answered.set(r.identity, JSON.parse(r.author_response_json));
          for (const report of lists(input.report)) {
            const response = answered.get(report.id);
            const f: Finding = response
              ? { ...report, status: "dismissed", author_response: response }
              : report;
            const state: FindingState =
              f.status === "dismissed"
                ? { status: "dismissed", response: f.author_response }
                : { status: "open" };
            const body = findingBody(f, state);
            const existing = comments.get(f.id);
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
              // Posted once per lineage: a recorded post whose comment is gone is not re-posted.
              if (record && record.state !== "failed") continue;
              // Capped agent findings are summarized; dismissed ones are never posted.
              if (!f.first_posted_in || f.status === "dismissed") continue;
              if (f.history?.previous_response?.reason === "wrong") {
                wrong.push(f);
                continue;
              }
              const file = files.get(f.location.path);
              if (
                !anchorable(f) ||
                !file ||
                file.removed ||
                !file.lines.has(f.location.line_start)
              ) {
                unanchored.push(f);
                publication.unanchored++;
                continue;
              }
              const posted = await github.postReviewComment({
                body,
                commit: row.head_sha!,
                path: f.location.path,
                line: f.location.line_start,
              });
              publication.posted++;
              await save("finding", f.id, "posted", {
                external: posted.id,
                body,
                url: posted.url,
              });
            } catch (error) {
              const message = failureText(error);
              publication.failed++;
              failures.push({ id: f.id, kind: "finding", error: message });
              rejected.push({ f, error: message });
              await save("finding", f.id, "failed", { error: message });
            }
          }
          // Earlier findings fixed by this round: edit and resolve their threads.
          const prior = new Map(input.prior.map((p) => [p.id, p.finding]));
          for (const u of input.updates) {
            const comment = comments.get(u.id),
              f = prior.get(u.id);
            if (!comment || !f || u.status !== "fixed") continue;
            try {
              await settle(
                u.id,
                comment,
                findingBody(f, {
                  status: "fixed",
                  fixed_in: row.head_sha ?? undefined,
                }),
                true,
              );
            } catch (error) {
              publication.failed++;
              failures.push({
                id: u.id,
                kind: "finding",
                error: failureText(error),
              });
            }
          }
          const body = summaryBody(
            input.report,
            input.lineage!.id,
            unanchored,
            rejected,
            wrong,
            link,
          );
          try {
            const existing = (await github.issueComments()).find(
              (c) => SUMMARY_MARKER.exec(c.body)?.[1] === input.lineage!.id,
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
            record?.external_id ? Number(record.external_id) : undefined,
          );
          publication.check_run_url = run.url || null;
          await save("check_run", row.head_sha!, record ? "edited" : "posted", {
            external: run.id,
            url: run.url,
          });
        } catch (error) {
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
      } finally {
        await token.revoke();
      }
      if (failures.length) publication.failures = failures;
      return publication;
    })();
  } finally {
    await releaseLease(env, row.tenant, input.lineage.id, holder);
  }
}

/** Shows a `/rio dismiss` on the finding's comment and resolves its thread. */
export async function reflectDismissal(
  env: Env,
  token: InstallationToken,
  row: { repository: string; number: number },
  finding: Finding,
  response: AuthorResponse,
): Promise<void> {
  const app = await appRequest(env, "GET", "/app");
  const slug = String(app?.slug ?? "");
  const github = new GitHubHost(
    token,
    row.repository,
    row.number,
    `${slug}[bot]`,
    slug,
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
  if (thread && !thread.resolved) await github.resolveThread(thread.id, true);
}

/** Publishes a finished review again after CLI consent (`POST /v1/reviews/{id}/publish`). */
export async function publishFinished(env: Env, review: string): Promise<void> {
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
  if (!row?.report_key || !row.lineage_id || !row.snapshot_id) return;
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

import { env, applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/index";
import type { Env, Finding } from "../src/types";
import {
  findingBody,
  publishReview,
  rightLines,
  findingAnchor,
  qaEvidenceBody,
  qaSummary,
  qaCheckOutput,
  type Policy,
} from "../src/publish";
import { handleCommand, parseCommand } from "../src/commands";
import { hash } from "../src/validation";
import { lineageId } from "../src/lineage";
import { allMigrations, profile } from "./fixtures";
import { BOT, GitHubDouble, sha } from "./github-double";
import qaFixture from "../../crates/rio-core/tests/qa-fixtures/report.json";

const runtime = env as Env;
beforeAll(async () => {
  await applyD1Migrations(runtime.DB, allMigrations);
  await runtime.DB.prepare(
    "INSERT INTO installations(id,tenant,account,repositories_json,suspended,created_at,updated_at) VALUES(81,'owner','acme','[\"acme/pub\"]',0,0,0)",
  ).run();
});

let pr = 100;
/** The PR's lineage row and one review in it, with its position. */
async function lineage(s: { lineage: string; number: number }) {
  await runtime.DB.prepare(
    "INSERT INTO lineages(id,tenant,repository,kind,ref,generation,round,posted_json,updated_at) VALUES(?,'owner','github.com/acme/pub','pr',?,1,1,'{}',0) ON CONFLICT(id) DO NOTHING",
  )
    .bind(s.lineage, String(s.number))
    .run();
}
async function inLineage(s: {
  review: string;
  lineage: string;
  number: number;
}) {
  await lineage(s);
  await runtime.DB.prepare(
    "INSERT INTO lineage_reviews(review_id,tenant,lineage_id,generation,snapshot_id,created_at) VALUES(?,'owner',?,1,'s',0)",
  )
    .bind(s.review, s.lineage)
    .run();
}
/** A lineage finding row, as the Workflow persists it. */
async function recorded(
  s: { lineage: string },
  f: Finding,
  status: "open" | "fixed" | "dismissed",
  response?: object,
) {
  await runtime.DB.prepare(
    "INSERT INTO findings(tenant,lineage_id,generation,identity,review_id,snapshot_id,repository,rule_id,category,source_kind,state,status,round,first_posted_in,author_response_json,location_json,finding_json,created_at,updated_at) VALUES('owner',?,1,?,'r','s','github.com/acme/pub','correctness/throw','defect','agent','new',?,1,'s',?,'{}',?,0,0) ON CONFLICT(tenant,lineage_id,generation,identity) DO UPDATE SET status=excluded.status,author_response_json=excluded.author_response_json",
  )
    .bind(
      s.lineage,
      f.id,
      status,
      response ? JSON.stringify(response) : null,
      JSON.stringify({ finding: f }),
    )
    .run();
}
let current: GitHubDouble | undefined;
interface Setup {
  review: string;
  number: number;
  lineage: string;
  head: string;
}
async function pull(
  options: {
    trigger?: "webhook" | "cli" | "command";
    consent?: boolean;
    fork?: boolean;
    escalated?: boolean;
    number?: number;
    head?: string;
  } = {},
): Promise<Setup> {
  const number = options.number ?? ++pr;
  const review = crypto.randomUUID();
  const head = options.head ?? sha(`h${number}${review}`);
  await runtime.DB.batch([
    runtime.DB.prepare(
      "INSERT INTO reviews(id,tenant,submission_key,status,created_at,token_limit,deadline) VALUES(?,'owner','x','complete',?,0,0)",
    ).bind(review, Date.now()),
    runtime.DB.prepare(
      "INSERT INTO pull_requests(review_id,tenant,installation_id,repository,number,request_key,trigger,base_sha,head_sha,fork,author_login,author_type,consent,escalated,state,created_at) VALUES(?,'owner',81,'acme/pub',?,?,?,?,?,?,'octocat','user',?,?,'submitted',?)",
    ).bind(
      review,
      number,
      `${options.trigger ?? "webhook"}:${review}`,
      options.trigger ?? "webhook",
      sha(`b${number}`),
      head,
      options.fork ? 1 : 0,
      options.consent ? 1 : 0,
      options.escalated ? 1 : 0,
      Date.now(),
    ),
  ]);
  current?.pull("acme/pub", number, { head, fork: options.fork });
  return {
    review,
    number,
    head,
    lineage: lineageId("owner", {
      repository: "github.com/acme/pub",
      kind: "pr",
      ref: String(number),
    }),
  };
}
function finding(
  name: string,
  line: number,
  extra: Partial<Finding> = {},
): Finding {
  return {
    id: hash(name),
    rule_id: "correctness/throw",
    category: "defect",
    severity: "error",
    location: {
      path: "src/a.ts",
      line_start: line,
      line_end: line,
      symbol_path: name,
      occurrence_state: "new",
    },
    locations: [
      {
        path: "src/a.ts",
        line_start: line,
        line_end: line,
        symbol_path: name,
        occurrence_state: "new",
      },
    ],
    message: `${name} now throws`,
    trigger: `${name}()`,
    state: "new",
    source: { agent: "correctness" },
    evidence_level: "static_proven",
    evidence: [],
    first_posted_in: "snapshot-1",
    status: "open",
    round: 1,
    ...extra,
  } as Finding;
}
function report(findings: Finding[], extra: any = {}) {
  return {
    schema: "rio-report-v1",
    status: "complete",
    review: { rio_version: "0.3.0" },
    risk_tier: {
      tier: "high",
      reasons: ["sensitive path src/auth"],
      source: "triage",
    },
    checks: [],
    findings: findings.filter((f) => f.category === "defect"),
    risks: findings.filter((f) => f.category === "risk"),
    lineage: { round: 1, cap: 3, held_back: 0 },
    ...extra,
  };
}
async function publish(
  s: Setup,
  r: any,
  policy: Policy = "auto",
  more: any = {},
) {
  return publishReview(runtime, {
    review: s.review,
    report: r,
    policy,
    fail_on: profile.fail_on,
    lineage: { id: s.lineage, snapshot_id: "snapshot-1" },
    updates: [],
    prior: [],
    ...more,
  });
}

describe("publisher", () => {
  let github: GitHubDouble;
  beforeEach(() => {
    github = current = new GitHubDouble().install();
  });
  afterEach(() => {
    // The check run never approves and never blocks.
    for (const run of github.checkRuns) expect(run.conclusion).toBe("neutral");
    github.restore();
  });

  it("parses right-side diff lines", () => {
    expect([
      ...rightLines("@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d\n@@ -10 +11,1 @@\n+e"),
    ]).toEqual([1, 2, 3, 11]);
  });

  it("posts anchorable findings inline, the rest in one summary, and a neutral check run", async () => {
    const s = await pull();
    github.setFiles("acme/pub", s.number, [
      { filename: "src/a.ts", lines: [3, 4, 5] },
    ]);
    const inline = finding("inline", 3);
    const old = finding("old-line", 40);
    const risk = finding("risk", 4, {
      category: "risk",
      evidence_level: "plausible",
    } as any);
    const cls = finding("class", 5, {
      locations: [
        {
          path: "src/a.ts",
          line_start: 5,
          line_end: 5,
          symbol_path: "x",
          occurrence_state: "new",
          id: hash("x"),
        },
        {
          path: "src/b.ts",
          line_start: 9,
          line_end: 9,
          symbol_path: "y",
          occurrence_state: "new",
          id: hash("y"),
        },
      ],
    });
    const result = await publish(s, report([inline, old, risk, cls]));
    expect(result).toMatchObject({
      policy: "auto",
      posted: 2,
      edited: 0,
      resolved: 0,
      failed: 0,
      unanchored: 2,
    });
    expect(github.comments.map((c) => [c.path, c.line, c.commit_id])).toEqual([
      ["src/a.ts", 3, s.head],
      ["src/a.ts", 4, s.head],
    ]);
    for (const c of github.comments)
      expect(c.body).toMatch(/<!-- rio:finding:[a-f0-9]{64} -->$/);
    expect(
      github.comments[0].body.endsWith(`<!-- rio:finding:${inline.id} -->`),
    ).toBe(true);
    expect(github.issueComments).toHaveLength(1);
    const summary = github.issueComments[0].body;
    expect(summary).toContain("Risk tier: **high** (sensitive path src/auth)");
    expect(summary).toContain("`src/a.ts:40`");
    expect(summary).toContain(cls.id.slice(0, 12));
    expect(summary).toContain(
      `https://rio.example.test/v1/reviews/${s.review}/report`,
    );
    expect(summary.endsWith(`<!-- rio:summary:${s.lineage} -->`)).toBe(true);
    expect(result!.summary_comment_url).toBe(github.issueComments[0].html_url);
    expect(github.checkRuns).toHaveLength(1);
    expect(github.checkRuns[0]).toMatchObject({
      name: "rio/review",
      head_sha: s.head,
      status: "completed",
      conclusion: "neutral",
    });
    expect(github.checkRuns[0].output.title).toBe(
      "Review failed its policy: 3 match fail_on · 3 finding(s), 1 risk(s) · risk tier high",
    );
    expect(result!.check_run_url).toBe(github.checkRuns[0].html_url);
    // Each token was revoked after the step.
    expect([...github.tokens.values()].every((t) => t.revoked)).toBe(true);
  });

  it("edits on the next round, resolves fixed and dismissed threads, and never duplicates", async () => {
    const s = await pull();
    github.setFiles("acme/pub", s.number, [
      { filename: "src/a.ts", lines: [1, 2, 3] },
    ]);
    const a = finding("a", 1),
      b = finding("b", 2),
      c = finding("c", 3);
    await publish(s, report([a, b, c]));
    expect(github.comments).toHaveLength(3);
    // Round 2: a held back with a new message, b fixed, c dismissed by a collaborator.
    const round2 = await pull({ number: s.number, head: s.head });
    const response = {
      reason: "irrelevant",
      actor: "maria",
      at: new Date().toISOString(),
    } as const;
    const result = await publish(
      round2,
      report(
        [
          { ...a, message: "a now throws on empty input" },
          { ...c, status: "dismissed", author_response: response },
        ],
        { lineage: { round: 2, cap: 3, held_back: 2 } },
      ),
      "auto",
      {
        updates: [
          { id: b.id, status: "fixed", resolution: { fixed_in: "snapshot-2" } },
        ],
        prior: [{ id: b.id, finding: b }],
      },
    );
    expect(result).toMatchObject({
      posted: 0,
      edited: 3,
      resolved: 2,
      failed: 0,
    });
    expect(github.comments).toHaveLength(3);
    const byId = (f: Finding) =>
      github.comments.find((x) =>
        x.body.endsWith(`<!-- rio:finding:${f.id} -->`),
      )!;
    expect(byId(a).body).toContain("a now throws on empty input");
    expect(byId(b).body).toContain(
      `**Status: fixed in \`${s.head.slice(0, 12)}\`**`,
    );
    expect(byId(c).body).toContain(
      "**Status: dismissed: irrelevant** (by maria)",
    );
    expect(github.threads.get(byId(b).id)!.resolved).toBe(true);
    expect(github.threads.get(byId(c).id)!.resolved).toBe(true);
    expect(github.threads.get(byId(a).id)!.resolved).toBe(false);
    // One summary per lineage, edited; the same head's check run is updated, not recreated.
    expect(github.issueComments).toHaveLength(1);
    expect(
      github.calls.filter((x) =>
        x.startsWith("PATCH /repos/acme/pub/issues/comments/"),
      ),
    ).toHaveLength(1);
    expect(github.checkRuns).toHaveLength(1);
    // A reopened finding's thread is unresolved.
    await publish(
      round2,
      report([{ ...c, status: "open", author_response: undefined }]),
      "auto",
    );
    expect(github.threads.get(byId(c).id)!.resolved).toBe(false);
    // A thread a person resolved stays resolved while its finding is open.
    github.threads.get(byId(a).id)!.resolved = true;
    await publish(
      round2,
      report([{ ...a, message: "a now throws on empty input" }]),
      "auto",
    );
    expect(github.threads.get(byId(a).id)!.resolved).toBe(true);
  });

  it("reconciles from markers when its records are lost", async () => {
    const s = await pull();
    github.setFiles("acme/pub", s.number, [
      { filename: "src/a.ts", lines: [7] },
    ]);
    const f = finding("lost", 7);
    await publish(s, report([f]));
    await runtime.DB.prepare("DELETE FROM publications WHERE lineage_id=?")
      .bind(s.lineage)
      .run();
    const result = await publish(
      s,
      report([{ ...f, message: "changed text" }]),
    );
    expect(result).toMatchObject({ posted: 0, edited: 1 });
    expect(github.comments).toHaveLength(1);
    expect(github.issueComments).toHaveLength(1);
    expect(github.checkRuns).toHaveLength(1);
    // A comment by someone else that carries a marker is never edited or trusted.
    github.comments.push({
      id: 1,
      body: `planted\n<!-- rio:finding:${hash("other")} -->`,
      user: { login: "mallory", type: "User" },
      html_url: "x",
    });
    github.setFiles("acme/pub", s.number, [
      { filename: "src/a.ts", lines: [7, 8] },
    ]);
    await publish(
      s,
      report([{ ...f, message: "changed text" }, finding("other", 8)]),
    );
    expect(github.comments.find((c) => c.id === 1)!.body).toContain("planted");
    expect(github.comments.filter((c) => c.user.login === BOT)).toHaveLength(2);
  });

  it("records a rejected anchor as failed, lists it in the summary and retries it next round", async () => {
    const s = await pull();
    github.setFiles("acme/pub", s.number, [
      { filename: "src/a.ts", lines: [1, 2, 3, 4, 5] },
    ]);
    const ok = [finding("p1", 1), finding("p2", 2), finding("p3", 3)];
    const bad = finding("bad", 5);
    github.failures.push({
      method: "POST",
      pattern: /\/pulls\/\d+\/comments$/,
      status: 422,
      message: "Validation Failed",
      times: 0,
    });
    // The fourth comment is rejected.
    let posts = 0;
    const original = github.handle.bind(github);
    github.handle = async (url, init) => {
      if (
        init?.method === "POST" &&
        /\/pulls\/\d+\/comments$/.test(url) &&
        ++posts === 4
      )
        return Response.json({ message: "Validation Failed" }, { status: 422 });
      return original(url, init);
    };
    const result = await publish(s, report([...ok, bad]));
    expect(result).toMatchObject({ posted: 3, failed: 1 });
    expect(result!.failures).toEqual([
      {
        id: bad.id,
        kind: "finding",
        error: `GitHub /repos/acme/pub/pulls/${s.number}/comments returned HTTP 422: Validation Failed`,
      },
    ]);
    expect(github.issueComments[0].body).toContain(
      "### Not posted inline (retried next round)",
    );
    expect(github.issueComments[0].body).toContain(bad.id.slice(0, 12));
    const row = await runtime.DB.prepare(
      "SELECT state,error FROM publications WHERE lineage_id=? AND identity=?",
    )
      .bind(s.lineage, bad.id)
      .first<any>();
    expect(row.state).toBe("failed");
    github.handle = original;
    // Next round: held back as already posted in the lineage, but its post failed, so it is retried.
    const retry = await publish(
      s,
      report([...ok, { ...bad, first_posted_in: "snapshot-0" }]),
    );
    expect(retry).toMatchObject({ posted: 1, failed: 0 });
    expect(github.comments).toHaveLength(4);
  });

  it("never posts a dismissed finding or one dismissed as wrong elsewhere, and summarizes capped rounds", async () => {
    const s = await pull();
    github.setFiles("acme/pub", s.number, [
      { filename: "src/a.ts", lines: [1, 2, 3] },
    ]);
    const dismissed = finding("d", 1, {
      status: "dismissed",
      author_response: {
        reason: "wrong",
        actor: "x",
        at: "2026-11-01T00:00:00Z",
      },
    });
    const recurring = finding("w", 2, {
      history: {
        first_seen: "r1",
        last_seen: "r1",
        seen_count: 2,
        previous_status: "dismissed",
        previous_response: {
          reason: "wrong",
          actor: "x",
          at: "2026-11-01T00:00:00Z",
        },
      },
    } as any);
    const capped = finding("capped", 3, { first_posted_in: undefined });
    const result = await publish(
      s,
      report([dismissed, recurring, capped], {
        lineage: {
          round: 4,
          cap: 3,
          held_back: 0,
          reconsider: {
            unresolved: 1,
            top: [
              {
                id: capped.id,
                title: "capped now throws",
                path: "src/a.ts",
                line_start: 3,
              },
            ],
          },
        },
      }),
    );
    expect(result).toMatchObject({ posted: 0, unanchored: 0 });
    expect(github.comments).toEqual([]);
    const summary = github.issueComments[0].body;
    expect(summary).toContain("### Round 4 exceeds the cap of 3");
    expect(summary).toContain("capped now throws (`src/a.ts:3`)");
    expect(summary).toContain(
      "1 recurring finding(s) earlier dismissed as `wrong`",
    );
  });

  it("applies the six policy and trigger combinations", async () => {
    const outcomes: Record<string, any> = {};
    for (const policy of ["never", "ask", "auto"] as Policy[])
      for (const trigger of ["webhook", "cli"] as const) {
        const before = {
          comments: github.comments.length,
          summaries: github.issueComments.length,
          runs: github.checkRuns.length,
        };
        const s = await pull({ trigger });
        github.setFiles("acme/pub", s.number, [
          { filename: "src/a.ts", lines: [1] },
        ]);
        const result = await publish(
          s,
          report([finding(`${policy}-${trigger}`, 1)]),
          policy,
        );
        outcomes[`${policy}/${trigger}`] = {
          reason: result!.reason ?? null,
          comments: github.comments.length - before.comments,
          summaries: github.issueComments.length - before.summaries,
          runs: github.checkRuns.length - before.runs,
        };
      }
    expect(outcomes).toEqual({
      "never/webhook": {
        reason: "policy_never",
        comments: 0,
        summaries: 0,
        runs: 0,
      },
      "never/cli": {
        reason: "policy_never",
        comments: 0,
        summaries: 0,
        runs: 0,
      },
      "ask/webhook": {
        reason: "ask_without_consent",
        comments: 0,
        summaries: 0,
        runs: 1,
      },
      "ask/cli": {
        reason: "ask_without_consent",
        comments: 0,
        summaries: 0,
        runs: 0,
      },
      "auto/webhook": { reason: null, comments: 1, summaries: 1, runs: 1 },
      "auto/cli": { reason: null, comments: 1, summaries: 1, runs: 1 },
    });
    // The check run under ask names both ways to publish.
    const askRun = github.checkRuns.find((r) =>
      r.output.summary.includes("publish: ask"),
    )!;
    expect(askRun.output.summary).toMatch(
      /`publish: auto`.*`rio review --pr \d+ --publish`/,
    );
    // CLI consent under ask publishes everything.
    const consented = await pull({ trigger: "cli", consent: true });
    github.setFiles("acme/pub", consented.number, [
      { filename: "src/a.ts", lines: [1] },
    ]);
    const consentedResult = await publish(
      consented,
      report([finding("consent", 1)]),
      "ask",
    );
    expect(consentedResult).toMatchObject({ posted: 1 });
    expect(consentedResult).not.toHaveProperty("reason");
    // A clean review's check run says so.
    const clean = await pull();
    github.setFiles("acme/pub", clean.number, []);
    await publish(clean, report([]), "auto");
    expect(github.checkRuns.at(-1)!.output.title).toBe(
      "No findings produced · risk tier high",
    );
  });

  it("holds a fork PR until a maintainer escalates it", async () => {
    const fork = await pull({ fork: true });
    github.setFiles("acme/pub", fork.number, [
      { filename: "src/a.ts", lines: [1] },
    ]);
    const held = await publish(fork, report([finding("fork", 1)]));
    expect(held).toEqual({
      policy: "auto",
      posted: 0,
      edited: 0,
      resolved: 0,
      failed: 0,
      unanchored: 0,
      check_run_url: null,
      summary_comment_url: null,
      reason: "fork_not_escalated",
    });
    expect(github.requests).toEqual([]);
    const escalated = await pull({
      fork: true,
      number: fork.number,
      trigger: "command",
      escalated: true,
    });
    expect(
      await publish(escalated, report([finding("fork", 1)])),
    ).toMatchObject({ posted: 1 });
    // Later rounds of an escalated lineage keep publishing.
    const later = await pull({ fork: true, number: fork.number });
    expect(await publish(later, report([finding("fork-2", 1)]))).toMatchObject({
      posted: 1,
    });
  });

  it("reports no installation once the app is removed", async () => {
    const s = await pull();
    await runtime.DB.prepare(
      "UPDATE installations SET suspended=1 WHERE id=81",
    ).run();
    try {
      expect(await publish(s, report([finding("x", 1)]))).toMatchObject({
        reason: "no_installation",
        posted: 0,
      });
    } finally {
      await runtime.DB.prepare(
        "UPDATE installations SET suspended=0 WHERE id=81",
      ).run();
    }
    // Reviews outside PR mode have no publication step.
    expect(
      await publishReview(runtime, {
        review: crypto.randomUUID(),
        report: report([]),
        policy: "auto",
        fail_on: {},
        lineage: null,
        updates: [],
        prior: [],
      }),
    ).toBeNull();
  });

  it("records a GitHub outage as a failed publication instead of failing the review", async () => {
    const s = await pull();
    github.failures.push({
      method: "POST",
      pattern: /\/access_tokens$/,
      status: 503,
      message: "Service Unavailable",
    });
    const result = await publish(s, report([finding("outage", 1)]));
    expect(result).toMatchObject({ policy: "auto", posted: 0, failed: 1 });
    expect(result!.failures).toEqual([
      {
        id: "publication",
        kind: "summary",
        error:
          "GitHub /app/installations/81/access_tokens returned HTTP 503: Service Unavailable",
      },
    ]);
  });

  it("serializes concurrent publishers of one lineage", async () => {
    const s = await pull();
    github.setFiles("acme/pub", s.number, [
      { filename: "src/a.ts", lines: [1, 2] },
    ]);
    const r = report([finding("race-1", 1), finding("race-2", 2)]);
    const results = await Promise.all([
      publish(s, r),
      publish(s, r),
      publish(s, r),
    ]);
    expect(results.map((x) => x!.posted).sort()).toEqual([0, 0, 2]);
    expect(results.every((x) => x!.failed === 0)).toBe(true);
    expect(github.comments).toHaveLength(2);
    expect(github.issueComments).toHaveLength(1);
    expect(github.checkRuns).toHaveLength(1);
  });

  it("applies a dismissal recorded after the report was written", async () => {
    const s = await pull();
    github.setFiles("acme/pub", s.number, [
      { filename: "src/a.ts", lines: [1, 2] },
    ]);
    const posted = finding("late-posted", 1),
      fresh = finding("late-fresh", 2);
    await runtime.DB.prepare(
      "INSERT INTO lineages(id,tenant,repository,kind,ref,generation,round,posted_json,updated_at) VALUES(?,'owner','github.com/acme/pub','pr',?,1,1,'{}',0)",
    )
      .bind(s.lineage, String(s.number))
      .run();
    // An earlier round posted the first finding.
    await publish(s, report([posted]));
    expect(github.comments).toHaveLength(1);
    // Both are then dismissed through the feedback path, after this report.
    const response = {
      reason: "wrong",
      actor: "cole",
      at: "2026-11-08T00:00:00Z",
    };
    for (const f of [posted, fresh])
      await runtime.DB.prepare(
        "INSERT INTO findings(tenant,lineage_id,generation,identity,review_id,snapshot_id,repository,rule_id,category,source_kind,state,status,round,first_posted_in,author_response_json,location_json,finding_json,created_at,updated_at) VALUES('owner',?,1,?,'r','s','github.com/acme/pub','correctness/throw','defect','agent','new','dismissed',1,'s',?,'{}',?,0,0)",
      )
        .bind(
          s.lineage,
          f.id,
          JSON.stringify(response),
          JSON.stringify({ finding: f }),
        )
        .run();
    const result = await publish(s, report([posted, fresh]));
    expect(result).toMatchObject({ posted: 0, edited: 1, resolved: 1 });
    expect(github.comments).toHaveLength(1);
    expect(github.comments[0].body).toContain(
      "**Status: dismissed: wrong** (by cole)",
    );
    expect(github.threads.get(github.comments[0].id)!.resolved).toBe(true);
  });

  it("honors a dismissal recorded while it publishes", async () => {
    const s = await pull();
    await lineage(s);
    github.setFiles("acme/pub", s.number, [
      { filename: "src/a.ts", lines: [1, 2] },
    ]);
    const first = finding("mid-1", 1),
      second = finding("mid-2", 2);
    const original = github.handle.bind(github);
    let dismissed = false;
    github.handle = async (url, init) => {
      const response = await original(url, init);
      if (
        !dismissed &&
        init?.method === "POST" &&
        /\/pulls\/\d+\/comments$/.test(url)
      ) {
        dismissed = true;
        await recorded(s, second, "dismissed", {
          reason: "wrong",
          actor: "cole",
          at: "2026-11-08T00:00:00Z",
        });
      }
      return response;
    };
    expect(await publish(s, report([first, second]))).toMatchObject({
      posted: 1,
      failed: 0,
    });
    expect(github.comments.map((c) => c.body.slice(-85))).toEqual([
      `<!-- rio:finding:${first.id} -->`,
    ]);
  });

  it("never publishes an older round over a newer one", async () => {
    const older = await pull();
    const newer = await pull({ number: older.number, head: older.head });
    await inLineage(older);
    await inLineage(newer);
    github.setFiles("acme/pub", older.number, [
      { filename: "src/a.ts", lines: [1] },
    ]);
    const f = finding("order", 1);
    await publish(newer, report([{ ...f, message: "newer text" }]));
    const result = await publish(
      older,
      report([{ ...f, message: "older text" }]),
    );
    expect(result).toMatchObject({ posted: 0, edited: 0, failed: 1 });
    expect(result!.failures![0].error).toContain(
      "a later round of this pull request was already published",
    );
    expect(github.comments[0].body).toContain("newer text");
  });

  it("stops writing once its lease is lost", async () => {
    const s = await pull();
    github.setFiles("acme/pub", s.number, [
      { filename: "src/a.ts", lines: [1, 2] },
    ]);
    const original = github.handle.bind(github);
    github.handle = async (url, init) => {
      const response = await original(url, init);
      // The first post outlives the lease; another publisher could now hold it.
      if (init?.method === "POST" && /\/pulls\/\d+\/comments$/.test(url))
        await runtime.DB.prepare(
          "UPDATE publication_leases SET until=0 WHERE lineage_id=?",
        )
          .bind(s.lineage)
          .run();
      return response;
    };
    const result = await publish(
      s,
      report([finding("lease-1", 1), finding("lease-2", 2)]),
    );
    expect(result).toMatchObject({ failed: 1 });
    expect(result!.failures![0].error).toContain("publication lease lost");
    expect(github.comments).toHaveLength(1);
    expect(github.issueComments).toHaveLength(0);
  });

  it("never posts an identity again after a failed edit lost its comment", async () => {
    const s = await pull();
    github.setFiles("acme/pub", s.number, [
      { filename: "src/a.ts", lines: [1] },
    ]);
    const f = finding("edit-fails", 1);
    await publish(s, report([f]));
    github.failures.push({
      method: "PATCH",
      pattern: /\/pulls\/comments\/\d+$/,
      status: 502,
      message: "Bad Gateway",
      times: 1,
    });
    expect(
      await publish(s, report([{ ...f, message: "changed" }])),
    ).toMatchObject({ failed: 1 });
    github.comments.length = 0;
    expect(
      await publish(s, report([{ ...f, message: "changed again" }])),
    ).toMatchObject({ posted: 0, failed: 0 });
    expect(github.comments).toHaveLength(0);
  });

  it("keeps a later dismissal on a finding this round fixed, and only Rio's resolutions are Rio's", async () => {
    const s = await pull();
    await lineage(s);
    github.setFiles("acme/pub", s.number, [
      { filename: "src/a.ts", lines: [1, 2] },
    ]);
    const dismissedLater = finding("fix-dismissed", 1),
      humanResolved = finding("fix-human", 2);
    await publish(s, report([dismissedLater, humanResolved]));
    const comment = (f: Finding) =>
      github.comments.find((c) =>
        c.body.endsWith(`<!-- rio:finding:${f.id} -->`),
      )!;
    await recorded(s, dismissedLater, "dismissed", {
      reason: "wrong",
      actor: "cole",
      at: "2026-11-08T00:00:00Z",
    });
    github.threads.get(comment(humanResolved).id)!.resolved = true;
    await publish(s, report([]), "auto", {
      updates: [dismissedLater, humanResolved].map((f) => ({
        id: f.id,
        status: "fixed",
        resolution: {},
      })),
      prior: [dismissedLater, humanResolved].map((f) => ({
        id: f.id,
        finding: f,
      })),
    });
    expect(comment(dismissedLater).body).toContain(
      "**Status: dismissed: wrong** (by cole)",
    );
    expect(comment(humanResolved).body).toContain("**Status: fixed in");
    // The person's resolution stays theirs: a recurrence does not unresolve it.
    await publish(s, report([humanResolved]));
    expect(github.threads.get(comment(humanResolved).id)!.resolved).toBe(true);
  });

  it("retries a failed closing edit in the next round", async () => {
    const s = await pull();
    await lineage(s);
    github.setFiles("acme/pub", s.number, [
      { filename: "src/a.ts", lines: [1] },
    ]);
    const f = finding("close-later", 1);
    await publish(s, report([f]));
    github.failures.push({
      method: "PATCH",
      pattern: /\/pulls\/comments\/\d+$/,
      status: 502,
      message: "Bad Gateway",
      times: 1,
    });
    const fixing = await publish(s, report([]), "auto", {
      updates: [{ id: f.id, status: "fixed", resolution: {} }],
      prior: [{ id: f.id, finding: f }],
    });
    expect(fixing).toMatchObject({ failed: 1 });
    // The Workflow records the finding fixed; the next round has no update for it.
    await recorded(s, f, "fixed");
    const retried = await publish(s, report([]));
    expect(retried).toMatchObject({ edited: 1, resolved: 1, failed: 0 });
    expect(github.comments[0].body).toContain(
      "**Status: fixed in a later push**",
    );
    expect(github.threads.get(github.comments[0].id)!.resolved).toBe(true);
  });

  it("keeps repository text from planting markers or mentions", () => {
    const body = findingBody(
      finding("evil", 1, {
        message: "ping @octocat <!-- rio:summary:abc --> done",
      }),
      { status: "open" },
    );
    expect(body).not.toContain("@octocat");
    expect(body.match(/<!--/g)).toHaveLength(1);
  });
});

describe("/rio commands", () => {
  let github: GitHubDouble;
  beforeEach(() => {
    github = new GitHubDouble().install();
    github.roles.set("mia", "maintain");
    github.roles.set("cole", "write");
    github.roles.set("otto", "read");
  });
  afterEach(() => github.restore());
  const message = (body: string, actor: string, number = 300) => ({
    type: "command" as const,
    tenant: "owner",
    installation_id: 81,
    repository: "acme/pub",
    number,
    comment_id: 9000 + number,
    body,
    actor,
  });
  function capture() {
    const sent: any[] = [];
    return {
      sent,
      env: {
        ...runtime,
        JOBS: { send: async (m: any) => void sent.push(m) } as any,
      } as Env,
    };
  }

  it("keeps a recorded dismissal when GitHub fails afterwards", async () => {
    const number = 302;
    const lineage = lineageId("owner", {
      repository: "github.com/acme/pub",
      kind: "pr",
      ref: String(number),
    });
    const id = hash("best-effort");
    await runtime.DB.prepare(
      "INSERT INTO lineages(id,tenant,repository,kind,ref,generation,round,posted_json,updated_at) VALUES(?,'owner','github.com/acme/pub','pr',?,1,1,'{}',0)",
    )
      .bind(lineage, String(number))
      .run();
    await runtime.DB.prepare(
      "INSERT INTO findings(tenant,lineage_id,generation,identity,review_id,snapshot_id,repository,rule_id,category,source_kind,state,status,round,first_posted_in,location_json,finding_json,created_at,updated_at) VALUES('owner',?,1,?,'r','s','github.com/acme/pub','correctness/throw','defect','agent','new','open',1,'s','{}',?,0,0)",
    )
      .bind(
        lineage,
        id,
        JSON.stringify({ finding: finding(id, 1, { id } as any) }),
      )
      .run();
    github.failures.push({
      method: "POST",
      pattern: /\/reactions$/,
      status: 502,
      message: "Bad Gateway",
    });
    const { env: e } = capture();
    const result = await handleCommand(
      e,
      message(`/rio dismiss ${id.slice(0, 12)} style`, "cole", number),
    );
    expect(result).toEqual({ applied: true, actor: "collaborator" });
    expect(
      await runtime.DB.prepare(
        "SELECT COUNT(*) AS n FROM feedback WHERE finding_id=?",
      )
        .bind(id)
        .first(),
    ).toEqual({ n: 1 });
    github.failures.length = 0;
  });

  it("parses only the two commands", () => {
    expect(parseCommand("/rio review")).toEqual({ kind: "review" });
    expect(parseCommand("/rio dismiss 8C1E2F4A style looks fine")).toEqual({
      kind: "dismiss",
      id: "8c1e2f4a",
      reason: "style",
      note: "looks fine",
    });
    expect(parseCommand("/rio dismiss 8c1e style")).toEqual({
      kind: "invalid",
    });
    expect(parseCommand("/rio dismiss 8c1e2f4a bogus")).toEqual({
      kind: "invalid",
    });
    expect(parseCommand("/rio review now please")).toEqual({ kind: "invalid" });
    expect(parseCommand("/rio publish everything")).toEqual({
      kind: "invalid",
    });
  });

  it("lets only maintainers request a review, from the permission API", async () => {
    for (const [actor, expected] of [
      ["mia", "+1"],
      ["cole", "-1"],
      ["otto", "-1"],
    ] as const) {
      const { env: e, sent } = capture();
      // The payload's author association plays no part.
      const result = await handleCommand(e, message("/rio review", actor));
      expect(github.reactions.at(-1)).toEqual({
        comment: 9300,
        content: expected,
      });
      expect(sent).toHaveLength(actor === "mia" ? 1 : 0);
      expect(result.applied).toBe(actor === "mia");
    }
    const { env: e, sent } = capture();
    await handleCommand(e, message("/rio review", "mia"));
    expect(sent[0]).toEqual({
      type: "review-request",
      tenant: "owner",
      installation_id: 81,
      repository: "acme/pub",
      number: 300,
      trigger: "command",
      comment_id: 9300,
    });
    expect(github.calls).toContain(
      "GET /repos/acme/pub/collaborators/mia/permission",
    );
    // Only reactions answer commands: no comment is created.
    expect(
      github.calls.some((c) =>
        c.startsWith("POST /repos/acme/pub/issues/300/comments"),
      ),
    ).toBe(false);
  });

  it("dismisses one posted finding by prefix with the feedback endpoint's author_response", async () => {
    const number = 301;
    const lineage = lineageId("owner", {
      repository: "github.com/acme/pub",
      kind: "pr",
      ref: String(number),
    });
    const ids = [hash("dismiss-me"), hash("other-one")];
    // Two identities that share a prefix make that prefix ambiguous.
    const twin = ids[0].slice(0, 8) + hash("twin").slice(8);
    await runtime.DB.prepare(
      "INSERT INTO lineages(id,tenant,repository,kind,ref,generation,round,posted_json,updated_at) VALUES(?,'owner','github.com/acme/pub','pr',?,1,1,'{}',0)",
    )
      .bind(lineage, String(number))
      .run();
    for (const id of [...ids, twin]) {
      const f = finding(id, 1, { id } as any);
      await runtime.DB.prepare(
        "INSERT INTO findings(tenant,lineage_id,generation,identity,review_id,snapshot_id,repository,rule_id,category,source_kind,state,status,round,first_posted_in,location_json,finding_json,created_at,updated_at) VALUES('owner',?,1,?,'r','s','github.com/acme/pub','correctness/throw','defect','agent','new','open',1,'s','{}',?,0,0)",
      )
        .bind(lineage, id, JSON.stringify({ finding: f }))
        .run();
    }
    github.setFiles("acme/pub", number, [{ filename: "src/a.ts", lines: [1] }]);
    github.pull("acme/pub", number);
    // The finding's comment exists from an earlier publication.
    github.comments.push({
      id: 555,
      body: findingBody(finding(ids[0], 1, { id: ids[0] } as any), {
        status: "open",
      }),
      user: { login: BOT, type: "Bot" },
      html_url: "c",
    });
    github.threads.set(555, { id: "PRRT_555", resolved: false });
    const { env: e } = capture();
    // Ambiguous, too short, unknown reason, and a non-collaborator: nothing changes.
    for (const [body, actor] of [
      [`/rio dismiss ${ids[0].slice(0, 8)} style`, "cole"],
      [`/rio dismiss ${ids[0].slice(0, 6)} style`, "cole"],
      [`/rio dismiss ${ids[0].slice(0, 12)} bogus`, "cole"],
      [`/rio dismiss ${ids[0].slice(0, 12)} style`, "otto"],
    ])
      expect(
        (await handleCommand(e, message(body, actor, number))).applied,
      ).toBe(false);
    expect(github.reactions.map((r) => r.content)).toEqual([
      "-1",
      "-1",
      "-1",
      "-1",
    ]);
    expect(
      await runtime.DB.prepare(
        "SELECT COUNT(*) AS n FROM feedback WHERE finding_id IN (?,?)",
      )
        .bind(ids[0], twin)
        .first(),
    ).toEqual({ n: 0 });
    // A collaborator's valid prefix applies.
    const applied = await handleCommand(
      e,
      message(
        `/rio dismiss ${ids[0].slice(0, 12)} style generated file`,
        "cole",
        number,
      ),
    );
    expect(applied).toEqual({ applied: true, actor: "collaborator" });
    expect(github.reactions.at(-1)!.content).toBe("+1");
    const row = await runtime.DB.prepare(
      "SELECT status,author_response_json FROM findings WHERE identity=?",
    )
      .bind(ids[0])
      .first<any>();
    const response = JSON.parse(row.author_response_json);
    expect(row.status).toBe("dismissed");
    expect(response).toEqual({
      reason: "style",
      actor: "cole",
      at: expect.any(String),
      note: "generated file",
    });
    const feedback = await runtime.DB.prepare(
      "SELECT reason,actor,note,repository FROM feedback WHERE finding_id=?",
    )
      .bind(ids[0])
      .first();
    expect(feedback).toEqual({
      reason: "style",
      actor: "cole",
      note: "generated file",
      repository: "github.com/acme/pub",
    });
    // The feedback endpoint writes the same shape for the other finding.
    const api = await app.request(
      `https://rio/v1/findings/${ids[1]}/feedback`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-owner-token-at-least-32-characters",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          reason: "style",
          actor: "cole",
          note: "generated file",
        }),
      },
      runtime,
    );
    const viaApi: any = await api.json();
    expect(Object.keys(viaApi.author_response).sort()).toEqual(
      Object.keys(response).sort(),
    );
    expect({ ...viaApi.author_response, at: "" }).toEqual({
      ...response,
      at: "",
    });
    // The comment shows the dismissal and its thread is resolved.
    expect(github.comments.find((c) => c.id === 555)!.body).toContain(
      "**Status: dismissed: style** (by cole)",
    );
    expect(github.threads.get(555)!.resolved).toBe(true);
    expect([...github.tokens.values()].every((t) => t.revoked)).toBe(true);
  });
});

describe("QA publication", () => {
  let github: GitHubDouble;
  beforeEach(() => {
    github = current = new GitHubDouble().install();
  });
  afterEach(() => {
    github.restore();
  });
  const qaFinding = (
    name: string,
    line: number,
    attribution = "source",
    path = "src/a.ts",
  ) => {
    const f = finding(name, line, {
      category: "ux",
      qa: { ...qaFixture.findings[0].qa, attribution } as any,
    });
    f.location.path = path;
    f.locations = [
      {
        ...f.location,
        cell: { viewport: "mobile", color_scheme: "light" },
        evidence: [],
      },
      {
        ...f.location,
        cell: { viewport: "desktop", color_scheme: "dark" },
        evidence: [],
      },
    ];
    return f;
  };
  it("anchors source findings at the attributed line or first hunk and puts journey/unchanged findings in one summary", async () => {
    const s = await pull(),
      files = new Map([
        ["src/a.ts", { removed: false, lines: new Set([3, 80]) }],
      ]);
    github.setFiles("acme/pub", s.number, [
      { filename: "src/a.ts", lines: [3, 80] },
    ]);
    const findings = [
      qaFinding("direct", 3),
      qaFinding("fallback", 12),
      qaFinding("unchanged", 4, "source", "src/unchanged.ts"),
      qaFinding("journey", 3, "journey"),
    ];
    expect(findings.map((f) => findingAnchor(f, files))).toEqual([
      3,
      3,
      undefined,
      undefined,
    ]);
    const r = report([], { findings, qa: structuredClone(qaFixture.qa) });
    const result = await publish(s, r);
    expect(result).toMatchObject({ posted: 2, unanchored: 2, failed: 0 });
    expect(github.comments.map((c) => c.line)).toEqual([3, 3]);
    expect(github.comments[1].body).toContain("Attributed to `src/a.ts:12`");
    expect(github.comments[1].body).toContain("mobile/light, desktop/dark");
    expect(github.issueComments).toHaveLength(1);
    expect(github.issueComments[0].body).toContain("QA results");
    expect(github.issueComments[0].body).toContain(findings[3].id.slice(0, 12));
    const first = github.issueComments[0].id;
    r.qa.journeys[0].cells[0].outcome = "passed";
    await publish(s, r);
    expect(github.comments).toHaveLength(2);
    expect(github.issueComments).toHaveLength(1);
    expect(github.issueComments[0].id).toBe(first);
    expect(github.issueComments[0].body).toContain("mobile/light: passed");
    expect(
      github.checkRuns.filter((run) => run.name === "rio/qa"),
    ).toHaveLength(1);
    const check = github.checkRuns.find((run) => run.name === "rio/qa");
    expect(check.conclusion).toBe("neutral");
    expect(check.output.annotations).toHaveLength(2);
    expect(
      check.output.annotations.every((row: any) => row.path === "src/a.ts"),
    ).toBe(true);
  });
  it("publishes only supported recommendations and preserves guidance, coverage and held-back counts", () => {
    const qa = structuredClone(qaFixture.qa) as any;
    const supported = qa.recommendations[0];
    supported.verification_status = "supported";
    qa.recommendations.push(
      ...["unverified", "inconclusive", "rejected"].map(
        (verification_status) => ({
          ...supported,
          verification_status,
          observed_friction: `private ${verification_status}`,
        }),
      ),
    );
    qa.recommendations_held_back = 2;
    qa.audit = {
      notes: ["QA journeys possibly stale: checkout. Run rio qa sync."],
    };
    const body = qaSummary(qa).join("\n");
    expect(body).toContain("UX recommendations");
    expect(body).toContain("Expected benefit (untested)");
    expect(body).toContain("Trade-offs:");
    expect(body).toContain("Recommendations held back: 2");
    expect(body).toContain("journeys possibly stale");
    expect(body).not.toContain("private unverified");
    expect(body).not.toContain("private inconclusive");
    expect(body).not.toContain("private rejected");
    expect(body).not.toContain("rio:finding:");
    expect(body).toMatchSnapshot();
  });
  it("only fails the QA check when its QA policy matched and never annotates recommendations", async () => {
    const s = await pull();
    const qa = structuredClone(qaFixture.qa);
    const r = report([], { qa, agent_audit: { qa: { policy_failed: false } } });
    const neutral = qaCheckOutput(r, new Map());
    expect(neutral.conclusion).toBe("neutral");
    expect(neutral.summary).toContain("failed: 1");
    expect(neutral.annotations).toEqual([]);
    r.agent_audit.qa.policy_failed = true;
    await publish(s, r);
    expect(
      github.checkRuns.find((run) => run.name === "rio/qa").conclusion,
    ).toBe("failure");
    expect(
      github.checkRuns.find((run) => run.name === "rio/review").conclusion,
    ).toBe("neutral");
    expect(github.comments).toHaveLength(0);
  });
  it("embeds only unexpired screenshots and links trace/DOM evidence without transcript prose", () => {
    const future = 4102444800000;
    const qa = {
      evidence: {
        artifacts: ["screenshot", "dom", "trace", "transcript"]
          .map((kind) => ({
            id: kind,
            kind,
            link: `https://rio.example/evidence/${kind}?signature=abc`,
            expires_at: future,
          }))
          .concat([
            {
              id: "old",
              kind: "screenshot",
              link: "https://rio.example/old",
              expires_at: 1,
            },
          ]),
      },
    };
    const body = qaEvidenceBody(
      qa,
      ["screenshot", "dom", "trace", "transcript", "old"],
      true,
    ).join("\n");
    expect(body).toContain(
      "![screenshot](<https://rio.example/evidence/screenshot?signature=abc>)",
    );
    expect(body).toContain("[trace]");
    expect(body).toContain("[dom]");
    expect(body).toContain("2100-01-01");
    expect(body).toContain("image proxy may outlive");
    expect(body).not.toContain("transcript");
    expect(body).not.toContain("/old");
  });
});

import {
  env,
  applyD1Migrations,
  introspectWorkflowInstance,
} from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import worker, { app } from "../src/index";
import type { Env, File, Hypothesis, QueueMessage } from "../src/types";
import { Store } from "../src/storage";
import { validateHypotheses, validateReport } from "../src/validation";
import { allMigrations, hypothesis, submission } from "./fixtures";
import { manifestOf, uploadSnapshot } from "./snapshots";
import { BOT, GitHubDouble, sha, signed } from "./github-double";
import prLineageReport from "../../tests/fixtures/sarif/pr-lineage/report.json";
import prLineageSarif from "../../tests/fixtures/sarif/pr-lineage/expected.sarif?raw";

// Recorded end-to-end PR lineage (task 10.2) through the deployed Worker's own
// entry points: signed webhooks, the queue consumer, the runner claim and
// prepare credential, the review Workflow with a recorded model gateway, the
// publisher against the GitHub double, `/rio` commands, and the SARIF route.

const runtime = env as Env;
/** A pinned report as recorded with the active layout features (feature-on runs). */
const withLayout = (report: any) => {
  const features = (runtime.PROMPT_LAYOUT ?? "").split(",").filter(Boolean).sort();
  return {
    ...report,
    agent_audit: {
      ...report.agent_audit,
      prompt_cache: { ...report.agent_audit.prompt_cache, layout_features: features },
    },
  };
};
const SECRET = "test-webhook-secret-at-least-32-characters";
const REPO = "acme/shop";
const owner = {
  authorization: "Bearer test-owner-token-at-least-32-characters",
};
const queued: QueueMessage[] = [];
const e: Env = {
  ...runtime,
  JOBS: { send: async (m: QueueMessage) => void queued.push(m) } as any,
};
let github: GitHubDouble;
// Agent answers per round, keyed by symbol name present in the reviewed head.
let agentSymbols: string[] = [];

type Files = Record<string, string>;
const tree = (files: Files): Record<string, File> =>
  Object.fromEntries(
    Object.entries(files).map(([p, content]) => [
      p,
      { mode: 0o100644, content },
    ]),
  );
function graphOf(files: Files) {
  const nodes = Object.entries(files).flatMap(([path, content]) =>
    content.split("\n").flatMap((line, i) => {
      const name = /^function (\w+)/.exec(line)?.[1];
      return name
        ? [
            {
              id: `${path}#${name}`,
              path,
              symbol_path: name,
              line_start: i + 1,
              line_end: i + 1,
            },
          ]
        : [];
    }),
  );
  return { nodes, edges: [] };
}
function hyp(symbol: string, line: number): Hypothesis {
  return {
    ...structuredClone(hypothesis),
    location: {
      path: "src/cart.ts",
      line_start: line,
      line_end: line,
      symbol_path: symbol,
      occurrence_state: "new",
    },
    message: `The call to ${symbol} now throws`,
    trigger: `${symbol}()`,
  };
}
const idOf = (h: Hypothesis) => validateHypotheses([h])[0].id;
function block(content: string, label: string): any {
  const start = content.indexOf(`<repository_data label="${label}">\n`);
  if (start < 0) return undefined;
  const from = content.indexOf("\n", start) + 1;
  return JSON.parse(
    content.slice(from, content.indexOf("\n</repository_data>", from)),
  );
}
/** The recorded model gateway: agents report the scripted symbols; voters prove them. */
async function gateway(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const body = JSON.parse(String(init!.body));
  const text = body.messages.map((m: any) => m.content).join("\n");
  let result: any = [];
  if (text.includes("Review the change independently")) {
    const head = block(text, "changed code excerpts") ?? [];
    const content: string = JSON.stringify(head);
    result = agentSymbols
      .filter((s) => content.includes(`function ${s}()`))
      .map((s) => {
        const line =
          (head[0]?.head?.content ?? "")
            .split("\n")
            .findIndex((l: string) => l.startsWith(`function ${s}(`)) + 1;
        return hyp(s, line);
      });
  } else if (text.includes("Verify this hypothesis.")) {
    const h =
      block(body.messages.at(-1).content, "hypothesis") ??
      block(text, "hypothesis");
    // Voters prove what the agents still report and refute the rest, such as
    // an earlier finding a diff-only round re-verifies after its code changed.
    const holds = agentSymbols.includes(h.location.symbol_path);
    result = {
      evidence_level: holds ? "static_proven" : "refuted",
      evidence: [
        {
          kind: "code",
          version: "head",
          path: h.location.path,
          node_ids: [`${h.location.path}#${h.location.symbol_path}`],
          demonstrates: holds ? "regression" : "protection",
        },
      ],
    };
  }
  const content = JSON.stringify({ result });
  return Response.json(
    String(input).includes("anthropic")
      ? {
          content: [{ type: "text", text: content }],
          usage: { input_tokens: 80, output_tokens: 50 },
        }
      : {
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 80, completion_tokens: 50 },
        },
  );
}

async function deliver(event: string, payload: any) {
  const body = JSON.stringify(payload);
  return app.request(
    "https://rio/v1/hooks/github",
    {
      method: "POST",
      headers: {
        "x-github-event": event,
        "x-github-delivery": crypto.randomUUID(),
        "x-hub-signature-256": await signed(SECRET, body),
      },
      body,
    },
    e,
  );
}
/** Runs the queue consumer over everything queued so far, as Cloudflare would. */
async function drain() {
  while (queued.length) {
    const body = queued.shift()!;
    await worker.queue(
      { messages: [{ body, attempts: 1, ack() {}, retry() {} }] } as any,
      e,
    );
  }
}
/** The self-hosted runner: claim, then upload and submit with the prepare credential. */
async function runPrepare(base: Files, head: Files) {
  const claim: any = await (
    await app.request(
      "https://rio/v1/runner/claim",
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-runner-secret-at-least-32-characters",
        },
      },
      e,
    )
  ).json();
  expect(claim.job.kind).toBe("prepare");
  const credential = claim.prepare.credential;
  const headers = {
    authorization: `Bearer ${credential}`,
    "content-type": "application/json",
  };
  const snapshot = { base: tree(base), head: tree(head) };
  const sealed = await uploadSnapshot(
    (path, method, body) =>
      app.request(`https://rio${path}`, { method, headers, body }, e),
    snapshot,
  );
  // A head reviewed before is already sealed.
  expect([200, 201]).toContain(sealed.status);
  // What `rio prepare` submits; the endpoint sets fork, lineage and PR metadata itself.
  const s: any = submission();
  s.snapshot_id = manifestOf(snapshot).id;
  s.graphs = { base: graphOf(base), head: graphOf(head) };
  s.changed = Object.keys(head)
    .filter((p) => base[p] !== head[p])
    .map((path) => ({ path, lines_changed: 1 }));
  s.profile.publish = "auto";
  // Rounds after the first are diff-only, as `rio/base` sets.
  s.profile.rounds = { cap: 3, diff_only_after: 1 };
  s.profile.steps = [
    {
      id: "agents",
      uses: "rio/agents@0.1.0",
      needs: [],
      with: { cache: false },
    },
    { id: "verify", uses: "rio/verify@0.1.0", needs: ["agents"], with: {} },
  ];
  s.report.review = {
    id: "prepared-header",
    mode: "branch",
    rio_version: "0.3.0",
  };
  s.intent = "Review the change of the pull request";
  const submitted = await app.request(
    "https://rio/v1/reviews",
    { method: "POST", headers, body: JSON.stringify(s) },
    e,
  );
  expect(submitted.status).toBe(202);
  const { id } = (await submitted.json()) as any;
  await using instance = await introspectWorkflowInstance(runtime.REVIEWS, id);
  await instance.waitForStatus("complete");
  const row = await runtime.DB.prepare(
    "SELECT report_key FROM reviews WHERE id=?",
  )
    .bind(id)
    .first<any>();
  const report = await new Store(runtime).get<any>(row.report_key);
  validateReport(report);
  return { id, report, claim };
}
const prEvent = (action: string, number: number) => ({
  action,
  installation: { id: 501 },
  repository: { full_name: REPO },
  pull_request: { number, state: "open", draft: false },
});
const commentEvent = (
  number: number,
  id: number,
  body: string,
  login: string,
) => ({
  action: "created",
  installation: { id: 501 },
  repository: { full_name: REPO },
  issue: { number, pull_request: {} },
  comment: {
    id,
    body,
    user: { login, type: "User" },
    author_association: "OWNER",
  },
});

const BASE: Files = {
  "src/cart.ts":
    "function total(){ return 1; }\nfunction tax(){ return 2; }\nfunction ship(){ return 3; }\n",
};
const HEAD1: Files = {
  "src/cart.ts":
    "function total(){ throw 1; }\nfunction tax(){ throw 2; }\nfunction ship(){ return 3; }\n",
};
const HEAD2: Files = {
  "src/cart.ts":
    "function total(){ throw 1; }\nfunction tax(){ return 2 * 1; }\nfunction ship(){ return 3; }\n",
};
const HEAD3: Files = {
  "src/cart.ts":
    "function total(){ throw 1; }\nfunction tax(){ return 2 * 1; }\nfunction ship(){ return 4; }\n",
};

beforeAll(async () => {
  await applyD1Migrations(runtime.DB, allMigrations);
  github = new GitHubDouble().install(gateway);
  github.roles.set("maintainer-mia", "admin");
  github.roles.set("collab-cole", "write");
});
afterAll(() => github.restore());

describe("PR mode end to end", () => {
  const rounds: any[] = [];
  const total = idOf(hyp("total", 1)),
    tax = idOf(hyp("tax", 2));

  it("installs the app and reviews and publishes an opened PR under auto", async () => {
    expect(
      (
        await deliver("installation", {
          action: "created",
          installation: {
            id: 501,
            account: { login: "acme" },
            repository_selection: "selected",
          },
          repositories: [{ full_name: REPO }],
        })
      ).status,
    ).toBe(202);
    github.pull(REPO, 7, { head: sha("head-1"), base: sha("base") });
    github.setFiles(REPO, 7, [{ filename: "src/cart.ts", lines: [1, 2] }]);
    agentSymbols = ["total", "tax"];
    expect((await deliver("pull_request", prEvent("opened", 7))).status).toBe(
      202,
    );
    await drain();
    const round = await runPrepare(BASE, HEAD1);
    rounds.push(round);
    const { report } = round;
    expect(report.review.pull_request).toEqual({
      repository: REPO,
      number: 7,
      base_sha: sha("base"),
      head_sha: sha("head-1"),
      author: { login: "octocat", type: "user" },
      fork: false,
      trigger: "webhook",
    });
    expect(report.lineage).toMatchObject({
      kind: "pr",
      ref: "7",
      round: 1,
      repository: "github.com/acme/shop",
    });
    // The CLI takes its exit policy from the endpoint's profile.
    expect(report.agent_audit.fail_on).toEqual(submission().profile.fail_on);
    expect(report.findings.map((f: any) => f.id).sort()).toEqual(
      [total, tax].sort(),
    );
    expect(report.publication).toEqual({
      policy: "auto",
      posted: 2,
      edited: 0,
      resolved: 0,
      failed: 0,
      unanchored: 0,
      check_run_url: github.checkRuns[0].html_url,
      summary_comment_url: github.issueComments[0].html_url,
    });
    expect(github.comments.map((c) => [c.line, c.body.slice(-85)])).toEqual(
      [
        [1, `<!-- rio:finding:${total} -->`],
        [2, `<!-- rio:finding:${tax} -->`],
      ].sort((a: any, b: any) => a[0] - b[0]),
    );
    expect(github.checkRuns[0]).toMatchObject({
      head_sha: sha("head-1"),
      conclusion: "neutral",
    });
    expect(github.checkRuns[0].output.title).toBe(
      "Review failed its policy: 2 match fail_on · 2 finding(s), 0 risk(s) · risk tier low",
    );
  });

  it("edits and resolves on synchronize, without new comments", async () => {
    github.pull(REPO, 7, { head: sha("head-2"), base: sha("base") });
    github.setFiles(REPO, 7, [{ filename: "src/cart.ts", lines: [1, 2] }]);
    agentSymbols = ["total"];
    await deliver("pull_request", prEvent("synchronize", 7));
    await drain();
    const { report } = await runPrepare(BASE, HEAD2);
    rounds.push({ report });
    expect(report.lineage).toMatchObject({
      round: 2,
      held_back: 1,
      diff_only: true,
    });
    expect(report.agent_audit.lineage_updates).toEqual([
      {
        id: tax,
        status: "fixed",
        resolution: { fixed_in: expect.any(String) },
      },
    ]);
    expect(report.publication).toMatchObject({
      posted: 0,
      edited: 1,
      resolved: 1,
      failed: 0,
    });
    expect(github.comments).toHaveLength(2);
    const taxComment = github.comments.find((c) =>
      c.body.endsWith(`<!-- rio:finding:${tax} -->`),
    )!;
    expect(taxComment.body).toContain(
      `✅ **Fixed in \`${sha("head-2").slice(0, 7)}\`**`,
    );
    expect(github.threads.get(taxComment.id)!.resolved).toBe(true);
    expect(github.issueComments).toHaveLength(1);
    // A new head gets its own neutral check run.
    expect(github.checkRuns.map((r) => [r.head_sha, r.conclusion])).toEqual([
      [sha("head-1"), "neutral"],
      [sha("head-2"), "neutral"],
    ]);
  });

  it("records a collaborator's /rio dismiss and keeps it through the next round", async () => {
    await deliver(
      "issue_comment",
      commentEvent(
        7,
        7001,
        `/rio dismiss ${total.slice(0, 10)} intentional documented`,
        "collab-cole",
      ),
    );
    await drain();
    expect(github.reactions).toEqual([{ comment: 7001, content: "+1" }]);
    const totalComment = github.comments.find((c) =>
      c.body.endsWith(`<!-- rio:finding:${total} -->`),
    )!;
    expect(totalComment.body).toContain(
      "💤 **Dismissed as `intentional`** by @\u200bcollab-cole",
    );
    expect(github.threads.get(totalComment.id)!.resolved).toBe(true);
    github.pull(REPO, 7, { head: sha("head-3"), base: sha("base") });
    agentSymbols = ["total"];
    await deliver("pull_request", prEvent("synchronize", 7));
    await drain();
    const { report } = await runPrepare(BASE, HEAD3);
    rounds.push({ report });
    const f = report.findings.find((x: any) => x.id === total);
    expect(f).toMatchObject({
      status: "dismissed",
      author_response: {
        reason: "intentional",
        actor: "collab-cole",
        note: "documented",
      },
    });
    // Never posted twice; the dismissed comment keeps its state.
    expect(report.publication).toMatchObject({ posted: 0, failed: 0 });
    expect(github.comments).toHaveLength(2);
    expect(github.threads.get(totalComment.id)!.resolved).toBe(true);
    expect(github.comments.every((c) => c.user.login === BOT)).toBe(true);
  });

  it("holds a fork PR until a maintainer's /rio review, then publishes static-only", async () => {
    github.pull(REPO, 8, {
      head: sha("fork-head"),
      base: sha("base"),
      fork: true,
    });
    github.setFiles(REPO, 8, [{ filename: "src/cart.ts", lines: [1, 2] }]);
    // \`total\` is remembered as dismissed on this code; \`tax\` returns as a regression.
    agentSymbols = ["total", "tax"];
    await deliver("pull_request", prEvent("opened", 8));
    await drain();
    const before = {
      comments: github.comments.length,
      runs: github.checkRuns.length,
    };
    const held = await runPrepare(BASE, HEAD1);
    expect(held.report.publication).toMatchObject({
      posted: 0,
      reason: "fork_not_escalated",
      check_run_url: null,
    });
    expect(held.report.footer.notes).toContain(
      "Fork PR: static-only; all agent and verifier execution tools are disabled.",
    );
    expect(github.comments.length).toBe(before.comments);
    expect(github.checkRuns.length).toBe(before.runs);
    // A collaborator cannot escalate; a maintainer can.
    await deliver(
      "issue_comment",
      commentEvent(8, 8001, "/rio review", "collab-cole"),
    );
    await drain();
    expect(github.reactions.at(-1)).toEqual({ comment: 8001, content: "-1" });
    await deliver(
      "issue_comment",
      commentEvent(8, 8002, "/rio review", "maintainer-mia"),
    );
    await drain();
    expect(github.reactions.at(-1)).toEqual({ comment: 8002, content: "+1" });
    const escalated = await runPrepare(BASE, HEAD1);
    expect(escalated.report.review.pull_request).toMatchObject({
      fork: true,
      trigger: "command",
    });
    expect(escalated.report.lineage).toMatchObject({ round: 1, generation: 2 });
    expect(escalated.report.publication).toMatchObject({
      posted: 1,
      failed: 0,
    });
    expect(escalated.report.footer.notes).toContain(
      "Fork PR: static-only; all agent and verifier execution tools are disabled.",
    );
    expect(github.comments.length).toBe(before.comments + 1);
  });

  it("serves the same SARIF as the CLI renders from the report", async () => {
    const { id, report } = rounds[0];
    const json: any = await (
      await app.request(
        `https://rio/v1/reviews/${id}/report`,
        { headers: owner },
        e,
      )
    ).json();
    const sarif: any = await (
      await app.request(
        `https://rio/v1/reviews/${id}/report?format=sarif`,
        { headers: owner },
        e,
      )
    ).json();
    // Review ids and times vary per run; the fixture fixes them.
    const normalize = (text: string) =>
      text.replaceAll(id, "00000000-0000-4000-8000-000000000001");
    const fixedReport = JSON.parse(normalize(JSON.stringify(json)));
    expect(json).toEqual(report);
    expect(fixedReport).toEqual(withLayout(prLineageReport));
    sarif.runs[0].invocations[0].startTimeUtc = "2026-11-08T12:00:00Z";
    sarif.runs[0].invocations[0].endTimeUtc = "2026-11-08T12:03:00Z";
    expect(JSON.parse(normalize(JSON.stringify(sarif)))).toEqual(
      JSON.parse(prLineageSarif),
    );
  });
});

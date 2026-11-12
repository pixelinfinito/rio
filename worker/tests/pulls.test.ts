import {
  env,
  applyD1Migrations,
  introspectWorkflowInstance,
} from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/index";
import type { Env, Execution, Snapshot } from "../src/types";
import {
  failUnscheduled,
  handleReviewRequest,
  trailerAgent,
} from "../src/pulls";
import { finishJob } from "../src/jobs";
import { Store } from "../src/storage";
import { memberHeader } from "../src/archive";
import { allMigrations, submission } from "./fixtures";
import { manifestOf, uploadSnapshot } from "./snapshots";
import { GitHubDouble, sha } from "./github-double";

const runtime = env as Env;
const owner = {
  authorization: "Bearer test-owner-token-at-least-32-characters",
  "content-type": "application/json",
};
beforeAll(async () => {
  await applyD1Migrations(runtime.DB, allMigrations);
});
async function install(id: number, repositories = ["acme/api"]) {
  await runtime.DB.prepare(
    "INSERT INTO installations(id,tenant,account,repositories_json,suspended,created_at,updated_at) VALUES(?,'owner','acme',?,0,0,0) ON CONFLICT(id) DO NOTHING",
  )
    .bind(id, JSON.stringify(repositories))
    .run();
}
function capture(overrides: Partial<Env> = {}) {
  const sent: any[] = [];
  return {
    sent,
    env: {
      ...runtime,
      JOBS: { send: async (m: any) => void sent.push(m) } as any,
      ...overrides,
    } as Env,
  };
}
const request = (repository: string, number: number, extra: object = {}) => ({
  type: "review-request" as const,
  tenant: "owner",
  installation_id: 71,
  repository,
  number,
  trigger: "webhook" as const,
  ...extra,
});
async function pullRows(repository: string, number: number) {
  return (
    await runtime.DB.prepare(
      "SELECT p.*,r.status AS review_status,r.error FROM pull_requests p JOIN reviews r ON r.id=p.review_id WHERE p.repository=? AND p.number=? ORDER BY p.created_at",
    )
      .bind(repository, number)
      .all<any>()
  ).results;
}
async function payloadOf(review: string): Promise<Execution> {
  const row = await runtime.DB.prepare(
    "SELECT payload_key FROM jobs WHERE review_id=?",
  )
    .bind(review)
    .first<{ payload_key: string }>();
  return new Store(runtime).get<Execution>(row!.payload_key);
}
/** Every stored artifact and D1 row, as text, to search for secrets. */
async function everything(): Promise<string> {
  const parts: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await runtime.ARTIFACTS.list({ cursor });
    for (const object of page.objects) {
      const value = await runtime.ARTIFACTS.get(object.key);
      parts.push(object.key, (await value?.text()) ?? "");
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const tables = await runtime.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
  ).all<{ name: string }>();
  for (const { name } of tables.results)
    parts.push(
      JSON.stringify(
        (await runtime.DB.prepare(`SELECT * FROM "${name}"`).all()).results,
      ),
    );
  return parts.join("\n");
}

describe("review-request consumer", () => {
  let github: GitHubDouble;
  beforeEach(async () => {
    github = new GitHubDouble().install();
    await install(71, ["acme/api", "acme/web", "acme/tool"]);
  });
  afterEach(() => github.restore());

  it("records metadata from GitHub and creates one review for two deliveries of a head", async () => {
    const pr = github.pull("acme/api", 3);
    github.commits.set("acme/api#3", [
      {
        sha: pr.head.sha,
        commit: {
          message: "Fix\n\nCo-authored-by: Claude <noreply@anthropic.com>",
        },
      },
    ]);
    const { env: e, sent } = capture();
    await handleReviewRequest(e, request("acme/api", 3));
    await handleReviewRequest(e, request("acme/api", 3));
    const rows = await pullRows("acme/api", 3);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      trigger: "webhook",
      head_sha: pr.head.sha,
      base_sha: pr.base.sha,
      fork: 0,
      author_login: "octocat",
      author_type: "user",
      state: "preparing",
      review_status: "preparing",
    });
    expect(JSON.parse(rows[0].agent_json)).toEqual({
      name: "Claude",
      source: "commit_trailer",
    });
    // One prepare job, queued once; the token minted for reading the PR is revoked.
    expect(sent).toEqual([
      { review_id: rows[0].review_id, job_id: expect.any(String), attempt: 1 },
    ]);
    const job = await payloadOf(rows[0].review_id);
    expect(job).toMatchObject({
      kind: "prepare",
      network: "clone",
      snapshot_id: "",
      prepare: {
        repository: "acme/api",
        clone_url: "https://github.com/acme/api.git",
        number: 3,
        base_sha: pr.base.sha,
        head_sha: pr.head.sha,
        installation_id: 71,
      },
    });
    expect([...github.tokens.values()].every((t) => t.revoked)).toBe(true);
    // A new head is a new review in the same PR.
    github.pull("acme/api", 3, { head: sha("second-head") });
    await handleReviewRequest(e, request("acme/api", 3));
    expect(await pullRows("acme/api", 3)).toHaveLength(2);
  });

  it("detects a bot author and a fork from GitHub's structured metadata", async () => {
    github.pull("acme/web", 4, { fork: true, bot: true });
    const { env: e } = capture();
    await handleReviewRequest(e, request("acme/web", 4));
    const [row] = await pullRows("acme/web", 4);
    expect(row).toMatchObject({
      fork: 1,
      author_login: "dependabot[bot]",
      author_type: "bot",
    });
    expect(JSON.parse(row.agent_json)).toEqual({
      name: "dependabot[bot]",
      source: "bot_author",
    });
    expect(
      trailerAgent(["Co-authored-by: Jane <jane@example.com>"]),
    ).toBeNull();
  });

  it("does not prepare a fork on a Sandbox-only endpoint", async () => {
    github.pull("acme/web", 6, { fork: true });
    const { env: e, sent } = capture({ RUNNER_BACKEND: "sandbox" });
    await handleReviewRequest(e, request("acme/web", 6));
    const [row] = await pullRows("acme/web", 6);
    expect(row).toMatchObject({
      state: "not_prepared",
      reason: "fork_requires_self_hosted_runner",
      review_status: "error",
      error: "fork_requires_self_hosted_runner",
    });
    expect(sent).toEqual([]);
    expect(github.calls.some((c) => c.includes("/tarball/"))).toBe(false);
  });

  it("ignores a draft from a webhook and an uncovered repository", async () => {
    github.pull("acme/api", 8, { draft: true });
    const { env: e, sent } = capture();
    await handleReviewRequest(e, request("acme/api", 8));
    github.pull("other/api", 9);
    await handleReviewRequest(e, request("other/api", 9));
    expect(await pullRows("acme/api", 8)).toEqual([]);
    expect(sent).toEqual([]);
  });
});

async function gzipTar(
  prefix: string,
  files: Record<string, string>,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  // git archive starts with a pax global header carrying the commit id.
  const comment = new TextEncoder().encode(`52 comment=${sha(prefix)}\n`);
  const global = memberHeader("pax_global_header", comment.length, 0o644)[0];
  global[156] = "g".charCodeAt(0);
  // Recompute the checksum after changing the type flag.
  global.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of global) sum += b;
  global.set(
    new TextEncoder().encode(sum.toString(8).padStart(6, "0") + "\0 "),
    148,
  );
  parts.push(
    global,
    comment,
    new Uint8Array((512 - (comment.length % 512)) % 512),
  );
  for (const [path, content] of Object.entries(files)) {
    const bytes = new TextEncoder().encode(content);
    parts.push(
      ...memberHeader(
        `${prefix}/${path}`,
        bytes.length,
        path.endsWith(".sh") ? 0o755 : 0o644,
      ),
    );
    parts.push(bytes, new Uint8Array((512 - (bytes.length % 512)) % 512));
  }
  parts.push(new Uint8Array(1024));
  const tar = new Blob(parts)
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(tar).arrayBuffer());
}

describe("Sandbox preparation", () => {
  let github: GitHubDouble;
  beforeEach(async () => {
    github = new GitHubDouble().install();
    await install(72, ["acme/svc"]);
  });
  afterEach(() => github.restore());

  it("resumes a retried request that failed before its job and fails it once the queue gives up", async () => {
    const pr = github.pull("acme/svc", 5);
    const files = { "src/a.ts": "export const a = 2;\n" };
    github.tarballs.set(pr.base.sha, await gzipTar("acme-svc-base", files));
    github.tarballs.set(pr.head.sha, await gzipTar("acme-svc-head", files));
    const { env: e, sent } = capture({ RUNNER_BACKEND: "sandbox" });
    const message = { ...request("acme/svc", 5), installation_id: 72 };
    github.failures.push({
      method: "GET",
      pattern: /\/tarball\//,
      status: 502,
      message: "Bad Gateway",
      times: 1,
    });
    await expect(handleReviewRequest(e, message)).rejects.toThrow(/HTTP 502/);
    const [first] = await pullRows("acme/svc", 5);
    expect(first.state).toBe("preparing");
    // The queue's retry resumes the same review instead of leaving it stuck.
    await handleReviewRequest(e, message);
    const rows = await pullRows("acme/svc", 5);
    expect(rows.map((r) => r.review_id)).toEqual([first.review_id]);
    expect(sent).toEqual([
      { review_id: first.review_id, job_id: expect.any(String), attempt: 1 },
    ]);
    // A later delivery for the scheduled head does nothing.
    await handleReviewRequest(e, message);
    expect(sent).toHaveLength(1);
    // When every attempt fails, the review is failed rather than left preparing.
    const next = github.pull("acme/svc", 6);
    github.failures.push({
      method: "GET",
      pattern: /\/tarball\//,
      status: 502,
      message: "Bad Gateway",
    });
    const stuck = { ...request("acme/svc", 6), installation_id: 72 };
    await expect(handleReviewRequest(e, stuck)).rejects.toThrow(/HTTP 502/);
    await failUnscheduled(e, stuck);
    expect((await pullRows("acme/svc", 6))[0]).toMatchObject({
      state: "failed",
      review_status: "error",
      error: "pull request review request failed",
    });
    void next;
    github.failures.length = 0;
  });

  it("fetches both trees into a snapshot and prepares from it without network", async () => {
    const pr = github.pull("acme/svc", 2);
    const base = {
      "src/a.ts": "export const a = 1;\n",
      "run.sh": "#!/bin/sh\n",
    };
    const head = {
      "src/a.ts": "export const a = 2;\n",
      "run.sh": "#!/bin/sh\n",
      "src/b.ts": "export {};\n",
    };
    github.tarballs.set(
      pr.base.sha,
      await gzipTar(`acme-svc-${pr.base.sha.slice(0, 7)}`, base),
    );
    github.tarballs.set(
      pr.head.sha,
      await gzipTar(`acme-svc-${pr.head.sha.slice(0, 7)}`, head),
    );
    const { env: e, sent } = capture({ RUNNER_BACKEND: "sandbox" });
    await handleReviewRequest(e, {
      ...request("acme/svc", 2),
      installation_id: 72,
    });
    const tree = (files: Record<string, string>): Snapshot["base"] =>
      Object.fromEntries(
        Object.entries(files).map(([p, content]) => [
          p,
          { content, mode: p.endsWith(".sh") ? 0o100755 : 0o100644 },
        ]),
      );
    const expected = manifestOf({ base: tree(base), head: tree(head) }).id;
    const [row] = await pullRows("acme/svc", 2);
    const job = await payloadOf(row.review_id);
    expect(job).toMatchObject({
      kind: "prepare",
      network: false,
      snapshot_id: expected,
      needs: ["base", "head"],
    });
    expect(job.prepare).toMatchObject({
      base_sha: pr.base.sha,
      head_sha: pr.head.sha,
    });
    expect(sent).toHaveLength(1);
    expect([...github.tokens.values()].every((t) => t.revoked)).toBe(true);
    // The container's artifact becomes the review; policy keys come from the record.
    // The container's artifact carries no snapshot id; the job's is used.
    const s: any = submission();
    delete s.snapshot_id;
    s.changed = [{ path: "src/a.ts", lines_changed: 1 }];
    s.graphs = {
      base: { nodes: [], edges: [] },
      head: { nodes: [], edges: [] },
    };
    s.fork = true;
    s.lineage = {
      repository: "github.com/evil/repo",
      kind: "branch",
      ref: "x",
    };
    await finishJob(e, row.review_id, job.job_id, 1, {
      outcome: "exited",
      job_id: job.job_id,
      attempt: 1,
      version: "head",
      exit_code: 0,
      stdout: "",
      stderr: "",
      timed_out: false,
      truncated: false,
      artifact: { submission: s },
    });
    await using instance = await introspectWorkflowInstance(
      runtime.REVIEWS,
      row.review_id,
    );
    await instance.waitForStatus("complete");
    const review = await runtime.DB.prepare("SELECT * FROM reviews WHERE id=?")
      .bind(row.review_id)
      .first<any>();
    const stored = await new Store(runtime).get<any>(review.submission_key);
    expect(stored.fork).toBe(false);
    expect(stored.snapshot_id).toBe(expected);
    expect(stored.lineage).toEqual({
      repository: "github.com/acme/svc",
      kind: "pr",
      ref: "2",
    });
    expect(stored.report.review.pull_request).toMatchObject({
      repository: "acme/svc",
      number: 2,
      head_sha: pr.head.sha,
      trigger: "webhook",
    });
    expect((await pullRows("acme/svc", 2))[0].state).toBe("submitted");
  });
});

describe("self-hosted preparation", () => {
  let github: GitHubDouble;
  beforeEach(async () => {
    github = new GitHubDouble().install();
    await install(73, ["acme/fork"]);
    await runtime.DB.prepare(
      "UPDATE jobs SET status='completed' WHERE status IN ('pending','leased')",
    ).run();
  });
  afterEach(() => github.restore());

  it("gives the runner its secrets at claim only and submits a fork PR as fork: true", async () => {
    const pr = github.pull("acme/fork", 12, { fork: true });
    const { env: e } = capture();
    await handleReviewRequest(e, {
      ...request("acme/fork", 12),
      installation_id: 73,
    });
    const [row] = await pullRows("acme/fork", 12);
    const claim = await app.request(
      "https://rio/v1/runner/claim",
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-runner-secret-at-least-32-characters",
        },
      },
      runtime,
    );
    const claimed: any = await claim.json();
    expect(claimed.job).toMatchObject({
      review_id: row.review_id,
      kind: "prepare",
      network: "clone",
    });
    const token: string = claimed.prepare.github_token;
    const credential: string = claimed.prepare.credential;
    expect(token).toMatch(/^ghs_/);
    expect(credential).toMatch(/^rio_prepare_[0-9a-f]{64}$/);
    // The clone token reads contents of this repository only.
    const minted = github.requests
      .filter((r) => r.path.endsWith("/access_tokens"))
      .at(-1)!;
    expect(minted.body).toEqual({
      repositories: ["fork"],
      permissions: { contents: "read" },
    });
    // The credential uploads and submits once; it cannot read reviews.
    const as = (bearer: string) => ({
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    });
    const snapshot = {
      base: {
        "src/a.ts": { mode: 0o100644, content: "function a(){ return 0; }\n" },
      },
      head: {
        "src/a.ts": { mode: 0o100644, content: "function a(){ return 1; }\n" },
      },
    };
    const sealed = await uploadSnapshot(
      (path, method, body) =>
        app.request(
          `https://rio${path}`,
          { method, headers: as(credential), body },
          runtime,
        ),
      snapshot,
    );
    expect(sealed.status).toBe(201);
    const read = await app.request(
      `https://rio/v1/reviews/${row.review_id}`,
      { headers: as(credential) },
      runtime,
    );
    expect(read.status).toBe(401);
    const s: any = submission();
    s.snapshot_id = manifestOf(snapshot).id;
    s.fork = false;
    // Preparation took a while: the review's budget starts at the hand-off.
    await runtime.DB.prepare("UPDATE reviews SET created_at=? WHERE id=?")
      .bind(Date.now() - 14 * 60 * 1000, row.review_id)
      .run();
    const handedOff = Date.now();
    const submitted = await app.request(
      "https://rio/v1/reviews",
      { method: "POST", headers: as(credential), body: JSON.stringify(s) },
      runtime,
    );
    expect(submitted.status).toBe(202);
    expect(await submitted.json()).toEqual({
      id: row.review_id,
      status: "queued",
    });
    const again = await app.request(
      "https://rio/v1/reviews",
      { method: "POST", headers: as(credential), body: JSON.stringify(s) },
      runtime,
    );
    expect(again.status).toBe(401);
    await using instance = await introspectWorkflowInstance(
      runtime.REVIEWS,
      row.review_id,
    );
    await instance.waitForStatus("complete");
    const review = await runtime.DB.prepare("SELECT * FROM reviews WHERE id=?")
      .bind(row.review_id)
      .first<any>();
    const stored = await new Store(runtime).get<any>(review.submission_key);
    expect(stored.fork).toBe(true);
    expect(review.created_at).toBeGreaterThanOrEqual(handedOff);
    expect(review.status).toBe("complete");
    expect(stored.report.review.pull_request).toMatchObject({
      fork: true,
      head_sha: pr.head.sha,
    });
    const report = await new Store(runtime).get<any>(review.report_key);
    expect(report.review.pull_request.number).toBe(12);
    expect(report.footer.notes).toContain(
      "Fork PR: static-only; all agent and verifier execution tools are disabled.",
    );
    // Neither the installation token nor the credential is stored anywhere.
    const stored_text = await everything();
    expect(stored_text).not.toContain(token);
    expect(stored_text).not.toContain(credential);
  });

  it("accepts a prepare credential once, and never after it expired", async () => {
    const as = (bearer: string) => ({
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    });
    const prepare = async (number: number) => {
      github.pull("acme/fork", number);
      const { env: e } = capture();
      await handleReviewRequest(e, {
        ...request("acme/fork", number),
        installation_id: 73,
      });
      const [row] = await pullRows("acme/fork", number);
      const claim: any = await (
        await app.request(
          "https://rio/v1/runner/claim",
          {
            method: "POST",
            headers: {
              authorization: "Bearer test-runner-secret-at-least-32-characters",
            },
          },
          runtime,
        )
      ).json();
      expect(claim.job.review_id).toBe(row.review_id);
      const snapshot = {
        base: { "src/a.ts": { mode: 0o100644, content: `base ${number}\n` } },
        head: { "src/a.ts": { mode: 0o100644, content: `head ${number}\n` } },
      };
      await uploadSnapshot(
        (path, method, body) =>
          app.request(
            `https://rio${path}`,
            { method, headers: as(claim.prepare.credential), body },
            runtime,
          ),
        snapshot,
      );
      const s: any = submission();
      s.snapshot_id = manifestOf(snapshot).id;
      return {
        row,
        credential: claim.prepare.credential as string,
        body: JSON.stringify(s),
      };
    };
    const submit = (credential: string, body: string) =>
      app.request(
        "https://rio/v1/reviews",
        { method: "POST", headers: as(credential), body },
        runtime,
      );
    // Concurrent hand-offs: exactly one wins.
    const race = await prepare(14);
    const statuses = (
      await Promise.all([1, 2, 3].map(() => submit(race.credential, race.body)))
    ).map((r) => r.status);
    expect(statuses.sort()).toEqual([202, 401, 401]);
    await using instance = await introspectWorkflowInstance(
      runtime.REVIEWS,
      race.row.review_id,
    );
    await instance.waitForStatus("complete");
    // An expired credential is refused even though the upload succeeded.
    const late = await prepare(15);
    await runtime.DB.prepare(
      "UPDATE api_tokens SET expires_at=0 WHERE scope='prepare'",
    ).run();
    expect((await submit(late.credential, late.body)).status).toBe(401);
    expect((await pullRows("acme/fork", 15))[0]).toMatchObject({
      state: "preparing",
      review_status: "preparing",
    });
  });

  it("schedules again when dispatch failed and follows the head a retry reads", async () => {
    github.pull("acme/fork", 16, { head: sha("first-head") });
    let down = true;
    const sent: any[] = [];
    const e = {
      ...runtime,
      JOBS: {
        send: async (m: any) => {
          if (down) throw new Error("queue unavailable");
          sent.push(m);
        },
      } as any,
    } as Env;
    const cli = { ...request("acme/fork", 16), installation_id: 73 };
    // A webhook attempt for the first head fails to dispatch its job.
    await expect(handleReviewRequest(e, cli)).rejects.toThrow(
      /queue unavailable/,
    );
    const [first] = await pullRows("acme/fork", 16);
    expect(first).toMatchObject({
      state: "preparing",
      head_sha: sha("first-head"),
    });
    expect(
      await runtime.DB.prepare(
        "SELECT COUNT(*) AS n FROM jobs WHERE review_id=?",
      )
        .bind(first.review_id)
        .first(),
    ).toEqual({ n: 0 });
    // The PR moves on; the retry reviews the new head and retires the stale one.
    github.pull("acme/fork", 16, { head: sha("second-head") });
    down = false;
    await handleReviewRequest(e, cli);
    const rows = await pullRows("acme/fork", 16);
    expect(rows.map((r) => [r.head_sha, r.state, r.reason])).toEqual([
      [sha("first-head"), "failed", "superseded by a newer head"],
      [sha("second-head"), "preparing", null],
    ]);
    const job = await payloadOf(rows[1].review_id);
    expect(job.prepare!.head_sha).toBe(sha("second-head"));
    expect(sent).toEqual([
      { review_id: rows[1].review_id, job_id: job.job_id, attempt: 1 },
    ]);
    // A CLI request retried after a failed dispatch keeps its review and takes the new head.
    github.pull("acme/fork", 17, { head: sha("cli-first") });
    down = true;
    const { env: c } = capture();
    const created = await app.request(
      "https://rio/v1/pulls",
      {
        method: "POST",
        headers: owner,
        body: JSON.stringify({
          repository: "github.com/acme/fork",
          number: 17,
        }),
      },
      c,
    );
    const { id } = (await created.json()) as any;
    const message = {
      ...request("acme/fork", 17),
      installation_id: 73,
      trigger: "cli" as const,
      review_id: id,
    };
    await expect(handleReviewRequest(e, message)).rejects.toThrow(
      /queue unavailable/,
    );
    github.pull("acme/fork", 17, { head: sha("cli-second") });
    down = false;
    await handleReviewRequest(e, message);
    const [cliRow] = await pullRows("acme/fork", 17);
    expect(cliRow).toMatchObject({
      review_id: id,
      head_sha: sha("cli-second"),
    });
    expect((await payloadOf(id)).prepare!.head_sha).toBe(sha("cli-second"));
  });

  it("lets one attempt at a time prepare a request and takes over an abandoned claim", async () => {
    github.pull("acme/fork", 18);
    const { env: e, sent } = capture();
    const message = { ...request("acme/fork", 18), installation_id: 73 };
    // Overlapping deliveries of one head schedule exactly one job.
    await Promise.all([1, 2, 3].map(() => handleReviewRequest(e, message)));
    const rows = await pullRows("acme/fork", 18);
    expect(rows).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(rows[0]).toMatchObject({ claim: null, claimed_until: null });
    // A claim left by an attempt that died mid-way blocks others until it expires.
    github.pull("acme/fork", 19);
    const stuck = { ...request("acme/fork", 19), installation_id: 73 };
    const down = {
      ...e,
      JOBS: {
        send: async () => {
          throw new Error("down");
        },
      } as any,
    } as Env;
    await expect(handleReviewRequest(down, stuck)).rejects.toThrow(/down/);
    const [row] = await pullRows("acme/fork", 19);
    await runtime.DB.prepare(
      "UPDATE pull_requests SET claim='dead',claimed_until=? WHERE review_id=?",
    )
      .bind(Date.now() + 60_000, row.review_id)
      .run();
    await handleReviewRequest(e, stuck);
    expect(sent).toHaveLength(1);
    await runtime.DB.prepare(
      "UPDATE pull_requests SET claimed_until=? WHERE review_id=?",
    )
      .bind(Date.now() - 1, row.review_id)
      .run();
    await handleReviewRequest(e, stuck);
    expect(sent.map((m) => m.review_id)).toEqual([
      rows[0].review_id,
      row.review_id,
    ]);
  });

  it("fails the review cleanly when the runner cannot clone", async () => {
    github.pull("acme/fork", 13);
    const { env: e } = capture();
    await handleReviewRequest(e, {
      ...request("acme/fork", 13),
      installation_id: 73,
    });
    const [row] = await pullRows("acme/fork", 13);
    const job = await payloadOf(row.review_id);
    await finishJob(runtime, row.review_id, job.job_id, 1, {
      outcome: "exited",
      job_id: job.job_id,
      attempt: 1,
      version: "head",
      exit_code: 1,
      stdout: "",
      stderr: "clone failed: authentication rejected (HTTP 401)\n",
      timed_out: false,
      truncated: false,
    });
    const [after] = await pullRows("acme/fork", 13);
    expect(after).toMatchObject({
      state: "failed",
      review_status: "error",
      error:
        "preparation failed: clone failed: authentication rejected (HTTP 401)",
    });
  });
});

describe("CLI pull request requests", () => {
  let github: GitHubDouble;
  beforeEach(async () => {
    github = new GitHubDouble().install();
    await install(74, ["acme/cli"]);
  });
  afterEach(() => github.restore());

  it("reports installation coverage and creates a CLI review in preparation", async () => {
    const status = async (repository: string) =>
      (
        await app.request(
          `https://rio/v1/github/installation?repository=${repository}`,
          { headers: owner },
          runtime,
        )
      ).json();
    expect(await status("github.com/acme/cli")).toEqual({
      configured: true,
      repository: "acme/cli",
      installed: true,
      installation_id: 74,
      account: "acme",
    });
    expect(await status("github.com/acme/none")).toEqual({
      configured: true,
      repository: "acme/none",
      installed: false,
    });
    const { env: e, sent } = capture();
    const missing = await app.request(
      "https://rio/v1/pulls",
      {
        method: "POST",
        headers: owner,
        body: JSON.stringify({ repository: "github.com/acme/none", number: 1 }),
      },
      e,
    );
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as any).error).toContain(
      "rio init --github-app",
    );
    const created = await app.request(
      "https://rio/v1/pulls",
      {
        method: "POST",
        headers: owner,
        body: JSON.stringify({
          repository: "github.com/acme/cli",
          number: 4,
          publish: true,
        }),
      },
      e,
    );
    expect(created.status).toBe(202);
    const { id } = (await created.json()) as any;
    expect(sent).toEqual([
      {
        type: "review-request",
        tenant: "owner",
        installation_id: 74,
        repository: "acme/cli",
        number: 4,
        trigger: "cli",
        review_id: id,
      },
    ]);
    const polled = await app.request(
      `https://rio/v1/reviews/${id}`,
      { headers: owner },
      runtime,
    );
    expect(await polled.json()).toEqual({
      id,
      status: "preparing",
      error: null,
    });
    github.pull("acme/cli", 4);
    await handleReviewRequest(e, sent[0]);
    expect((await pullRows("acme/cli", 4))[0]).toMatchObject({
      review_id: id,
      trigger: "cli",
      consent: 1,
      state: "preparing",
    });
    // Its prepare job is named for what it is, so a stop finds its container.
    const prepare = await runtime.DB.prepare(
      "SELECT id,kind,status FROM jobs WHERE review_id=?",
    )
      .bind(id)
      .first<{ id: string; kind: string; status: string }>();
    expect(prepare).toMatchObject({ kind: "prepare", status: "pending" });
    // Cancelled while it is prepared, the review ends there: no workflow
    // exists yet that could end it.
    const cancelled = await app.request(
      `https://rio/v1/reviews/${id}/cancel`,
      { method: "POST", headers: owner, body: "{}" },
      e,
    );
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toEqual({ id, status: "cancelled" });
    expect((await pullRows("acme/cli", 4))[0]).toMatchObject({
      state: "failed",
      reason: "cancelled",
      review_status: "error",
      error: "cancelled",
    });
    expect(
      await runtime.DB.prepare(
        "SELECT cancelled,cancelled_at IS NOT NULL AS stamped FROM reviews WHERE id=?",
      )
        .bind(id)
        .first(),
    ).toEqual({ cancelled: 1, stamped: 1 });
    expect(
      (
        await runtime.DB.prepare(
          "SELECT event FROM events WHERE review_id=? ORDER BY seq",
        )
          .bind(id)
          .all<{ event: string }>()
      ).results.at(-1)?.event,
    ).toBe("review:error");
    // The job never runs, and a result that still arrives hands nothing over.
    const job = () =>
      runtime.DB.prepare("SELECT status FROM jobs WHERE id=?")
        .bind(prepare!.id)
        .first<{ status: string }>();
    expect((await job())?.status).toBe("failed");
    await finishJob(e, id, prepare!.id, 1, {
      outcome: "exited",
      job_id: prepare!.id,
      attempt: 1,
      version: "head",
      exit_code: 0,
      stdout: "",
      stderr: "",
      timed_out: false,
      truncated: false,
      artifact: { submission: submission() },
    });
    expect((await job())?.status).toBe("failed");
    expect(
      await (
        await app.request(`https://rio/v1/reviews/${id}`, { headers: owner }, e)
      ).json(),
    ).toEqual({ id, status: "error", error: "cancelled" });
    // A second cancel changes nothing.
    await app.request(
      `https://rio/v1/reviews/${id}/cancel`,
      { method: "POST", headers: owner, body: "{}" },
      e,
    );
    expect((await pullRows("acme/cli", 4))[0]).toMatchObject({
      state: "failed",
      review_status: "error",
    });
    const unconfigured = await app.request(
      "https://rio/v1/pulls",
      {
        method: "POST",
        headers: owner,
        body: JSON.stringify({ repository: "github.com/acme/cli", number: 4 }),
      },
      { ...e, GITHUB_APP_ID: undefined },
    );
    expect(unconfigured.status).toBe(404);
  });
});

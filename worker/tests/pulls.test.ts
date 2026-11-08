import {
  env,
  applyD1Migrations,
  introspectWorkflowInstance,
} from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/index";
import type { Env, Execution, Snapshot } from "../src/types";
import { handleReviewRequest, trailerAgent } from "../src/pulls";
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
    expect(job.prepare).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect([...github.tokens.values()].every((t) => t.revoked)).toBe(true);
    // The container's artifact becomes the review; policy keys come from the record.
    const s: any = submission();
    s.snapshot_id = expected;
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

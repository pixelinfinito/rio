import { Hono } from "hono";
import {
  qaEvidenceRoutes,
  expireQaEvidence,
  refreshQaReportLinks,
} from "./qa-evidence";
import { qaModelRoutes } from "./qa-model";
import { qaSeedRoutes } from "./qa-seed-routes";
import {
  claimQaRun,
  configureQaRun,
  heartbeatQaRun,
  qaControl,
  revokeQaRun,
} from "./qa-jobs";
import type { Env, Execution, JobMessage, QueueMessage } from "./types";
import { authenticate, equal, jobToken, sign, verifyJobToken } from "./auth";
import {
  RESPONSE_REASONS,
  canonical,
  hash,
  invariant,
  validateGraph,
  validateLineageRef,
  validateSubmission,
} from "./validation";
import {
  LIMITS,
  SYMLINK,
  StoredSnapshot,
  lineCounts,
  materialize,
} from "./snapshot";
import {
  completeUpload,
  missing,
  seal,
  startUpload,
  storeChunk,
  storePack,
  uploadPart,
} from "./upload";
import { TRANSFER_CAP_MS, jobInput } from "./archive";
import { reconcile, sweepReviews } from "./reconcile";
import { attachStatements, lineageId } from "./lineage";
import { Store } from "./storage";
import { ANALYSIS_WALL_MS, PREPARE_WALL_MS, failJob, finishJob } from "./jobs";
import { parseWall } from "./budget";
import { checkProfileModels } from "./gateway";
import { renderSarif, utc } from "./sarif";
import { publicRecord } from "./history";
import { publicProposal } from "./proposals";
import { createReview } from "./reviews";
import { DISPLAY_ID_LEN, recordFeedback, resolvePrefix } from "./feedback";
import { dismissRecommendation } from "./qa-recommendation-history";
import { APP_TENANT, handleGitHubWebhook, installationFor } from "./webhooks";
import {
  handleReviewRequest,
  failPrepare,
  failUnscheduled,
  prepareCredential,
  preparedBy,
  pullOf,
  repositoryName,
  requestReview,
  submitPrepared,
} from "./pulls";
import { handleCommand } from "./commands";
import { previewFinished, publishFinished } from "./publish";
import { redact } from "./redaction";
import {
  InstallationToken,
  PREPARE_PERMISSIONS,
  appRequest,
  appSecrets,
} from "./github";
export { ReviewWorkflow } from "./workflow";
export { MigrationWorkflow } from "./migrate";
export { Sandbox } from "./sandbox";
export { QaSandboxGateway } from "./qa-sandbox-gateway";
const app = new Hono<{ Bindings: Env }>();
app.onError((error, c) =>
  c.json(
    {
      error: /unauthorized|capability/.test(error.message)
        ? "unauthorized"
        : error.message,
    },
    /unauthorized|capability/.test(error.message) ? 401 : 400,
  ),
);
app.get("/health", (c) => c.json({ version: c.env.RIO_VERSION, protocol: 1 }));
app.use("/v1/*", async (c, next) => {
  const protocol = c.req.header("rio-protocol");
  invariant(!protocol || protocol === "1", "unsupported protocol");
  await next();
});
app.route("/v1/qa/seeds", qaSeedRoutes);
app.route("/v1/qa/model", qaModelRoutes);
app.route("/v1/qa", qaEvidenceRoutes);
async function bytes(request: Request, max: number): Promise<Uint8Array> {
  invariant(
    Number(request.headers.get("content-length") ?? 0) <= max,
    "request too large",
  );
  const reader = request.body?.getReader();
  invariant(reader, "request body required");
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new Error("request too large");
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}
async function body(request: Request, max = 40 * 1024 * 1024): Promise<any> {
  return JSON.parse(new TextDecoder().decode(await bytes(request, max)));
}
async function reviewAccess(
  request: Request,
  env: Env,
  id: string,
  scope = "reviews:read",
) {
  const tenant = await authenticate(request, env, scope);
  const row = await env.DB.prepare(
    "SELECT * FROM reviews WHERE id=? AND tenant=?",
  )
    .bind(id, tenant)
    .first<any>();
  invariant(row, "review not found");
  return row;
}
// A PR prepare job uploads with its single-use prepare credential.
const UPLOAD = ["reviews:write", "prepare"];
// Snapshots are uploaded as deduplicated contents plus a chunked manifest
// (docs/cloudflare.md, "Snapshot protocol").
app.post("/v1/contents/missing", async (c) => {
  const tenant = await authenticate(c.req.raw, c.env, UPLOAD);
  return c.json({
    missing: await missing(c.env, tenant, await body(c.req.raw, 1024 * 1024)),
  });
});
app.put("/v1/packs", async (c) => {
  const tenant = await authenticate(c.req.raw, c.env, UPLOAD);
  return c.json(
    await storePack(c.env, tenant, await bytes(c.req.raw, LIMITS.request)),
    201,
  );
});
app.post("/v1/contents/:hash/uploads", async (c) => {
  const tenant = await authenticate(c.req.raw, c.env, UPLOAD);
  const result = await startUpload(
    c.env,
    tenant,
    c.req.param("hash"),
    await body(c.req.raw, 64 * 1024),
  );
  return c.json(result, result.present ? 200 : 201);
});
app.post("/v1/contents/:hash/uploads/complete", async (c) => {
  const tenant = await authenticate(c.req.raw, c.env, UPLOAD);
  return c.json(
    await completeUpload(
      c.env,
      tenant,
      c.req.param("hash"),
      c.req.query("upload"),
      await body(c.req.raw, 64 * 1024),
    ),
    201,
  );
});
app.put("/v1/contents/:hash/uploads/:part", async (c) => {
  const tenant = await authenticate(c.req.raw, c.env, UPLOAD);
  return c.json(
    await uploadPart(
      c.env,
      tenant,
      c.req.param("hash"),
      Number(c.req.param("part")),
      c.req.query("upload"),
      await bytes(c.req.raw, LIMITS.request),
    ),
  );
});
app.put("/v1/manifests/:id/chunks/:n", async (c) => {
  const tenant = await authenticate(c.req.raw, c.env, UPLOAD);
  const chunk = Number(c.req.param("n"));
  await storeChunk(
    c.env,
    tenant,
    c.req.param("id"),
    chunk,
    await bytes(c.req.raw, LIMITS.request),
  );
  return c.json({ chunk }, 201);
});
app.post("/v1/manifests/:id/seal", async (c) => {
  const tenant = await authenticate(c.req.raw, c.env, UPLOAD);
  const result = await seal(
    c.env,
    tenant,
    c.req.param("id"),
    await body(c.req.raw, 64 * 1024),
  );
  return c.json({ id: result.id }, result.created ? 201 : 200);
});
app.post("/v1/reviews", async (c) => {
  const bearer = c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
  // A hosted prepare job hands over its PR review; the credential is single-use.
  const prepared = await preparedBy(c.env, bearer);
  if (prepared) {
    const value = await body(c.req.raw, 8 * 1024 * 1024);
    const id = await submitPrepared(c.env, prepared, value);
    return c.json({ id, status: "queued" }, 202);
  }
  const tenant = await authenticate(c.req.raw, c.env, "reviews:write"),
    value = await body(c.req.raw, 8 * 1024 * 1024);
  // PR metadata is recorded by the endpoint, never accepted from a client.
  if (value && typeof value === "object") {
    delete value.pull_request;
    if (value.report?.review) delete value.report.review.pull_request;
  }
  const id = await createReview(c.env, tenant, value);
  return c.json({ id, status: "queued" }, 202);
});
// GitHub App webhooks (docs/github-app.md); the body is verified before parsing.
app.post("/v1/hooks/github", async (c) =>
  handleGitHubWebhook(
    c.env,
    c.req.raw.headers,
    await bytes(c.req.raw, 26 * 1024 * 1024),
  ),
);
app.all("/v1/hooks/gitlab", (c) =>
  c.json(
    { error: "GitLab integration is not available in this version of Rio" },
    501,
  ),
);
/** Owner-only routes that act with the GitHub App's own credentials. */
async function owner(request: Request, env: Env) {
  const tenant = await authenticate(request, env, "reviews:write");
  invariant(tenant === "owner", "unauthorized");
  return tenant;
}
// PR-mode readiness for `rio doctor` and `rio review --pr`.
app.get("/v1/github/installation", async (c) => {
  const tenant = await authenticate(c.req.raw, c.env, "reviews:read");
  const configured = appSecrets(c.env) !== null;
  const name = repositoryName(c.req.query("repository") ?? "");
  invariant(name, "invalid repository: expected github.com/<owner>/<repo>");
  const row = configured ? await installationFor(c.env, tenant, name) : null;
  return c.json({
    configured,
    repository: name,
    installed: row !== null,
    ...(row ? { installation_id: row.id, account: row.account } : {}),
  });
});
// `rio doctor --rotate`: the app's webhook secret, set with the App JWT. The
// endpoint holds the private key; `restore` puts back its current secret.
app.post("/v1/github/hook-config", async (c) => {
  await owner(c.req.raw, c.env);
  invariant(appSecrets(c.env), "no GitHub App is configured on this endpoint");
  const value = await body(c.req.raw, 4096);
  const secret =
    value?.restore === true ? c.env.GITHUB_WEBHOOK_SECRET : value?.secret;
  invariant(
    typeof secret === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(secret),
    "invalid webhook secret",
  );
  try {
    await appRequest(c.env, "PATCH", "/app/hook/config", { secret });
  } catch (error) {
    return c.json(
      {
        error:
          `GitHub rejected the app webhook update (${error instanceof Error ? error.message : "error"})`.slice(
            0,
            200,
          ),
      },
      502,
    );
  }
  return c.json({ updated: true });
});
// `rio review --pr <n>`: the endpoint prepares and reviews the PR head.
app.post("/v1/pulls", async (c) => {
  const tenant = await authenticate(c.req.raw, c.env, "reviews:write"),
    value = await body(c.req.raw, 4096);
  invariant(
    value &&
      typeof value === "object" &&
      Object.keys(value).every((k) =>
        ["repository", "number", "publish"].includes(k),
      ) &&
      Number.isSafeInteger(value.number) &&
      value.number >= 1 &&
      (value.publish === undefined || typeof value.publish === "boolean"),
    "invalid pull request request",
  );
  const name = repositoryName(String(value.repository ?? ""));
  invariant(name, "invalid repository: expected github.com/<owner>/<repo>");
  if (!appSecrets(c.env))
    return c.json(
      {
        error:
          "no GitHub App is configured on this endpoint; run rio init --github-app",
      },
      404,
    );
  const row = await installationFor(c.env, tenant, name);
  if (!row)
    return c.json(
      {
        error: `no GitHub App installation covers ${name}; install the app (rio init --github-app)`,
      },
      404,
    );
  const id = await requestReview(
    c.env,
    tenant,
    row.id,
    name,
    value.number,
    value.publish === true,
  );
  return c.json({ id, status: "preparing" }, 202);
});
// Consent to publish a finished `ask` review from the CLI.
app.post("/v1/reviews/:id/publish", async (c) => {
  const row = await reviewAccess(
    c.req.raw,
    c.env,
    c.req.param("id"),
    "reviews:write",
  );
  const pull = await pullOf(c.env, row.id);
  if (!pull) return c.json({ error: "not a pull request review" }, 404);
  invariant(
    row.status === "complete" || row.status === "partial",
    "review is not finished",
  );
  // A dry run renders what consent would post and records no consent.
  if (c.req.query("dry_run") === "1") {
    const preview = await previewFinished(c.env, row.id);
    if (!preview) return c.json({ error: "review has no publication" }, 404);
    return c.json({ id: row.id, dry_run: true, ...preview });
  }
  await c.env.DB.prepare("UPDATE pull_requests SET consent=1 WHERE review_id=?")
    .bind(row.id)
    .run();
  await c.env.JOBS.send({ type: "publish", review_id: row.id });
  return c.json({ id: row.id, status: "publishing" }, 202);
});
app.get("/v1/reviews/:id", async (c) => {
  let row = await reviewAccess(c.req.raw, c.env, c.req.param("id"));
  // A workflow that died or overran never reports; its status is settled here.
  if (await reconcile(c.env, row).catch(() => null))
    row = await reviewAccess(c.req.raw, c.env, row.id);
  return c.json({ id: row.id, status: row.status, error: row.error });
});
app.get("/v1/reviews/:id/report", async (c) => {
  const row = await reviewAccess(c.req.raw, c.env, c.req.param("id"));
  const format = c.req.query("format") ?? "json";
  invariant(
    format === "json" || format === "sarif",
    "invalid format: expected json or sarif",
  );
  invariant(row.report_key, "report is not ready");
  const report = await new Store(c.env).get<any>(row.report_key);
  await refreshQaReportLinks(c.env, row.tenant, row.id, report, c.req.url);
  c.header("cache-control", "private, no-store");
  if (format === "json") return c.json(report);
  // The invocation spans the review's creation and its final event.
  const finished = await c.env.DB.prepare(
    "SELECT created_at FROM events WHERE review_id=? AND event IN ('review:done','review:partial') ORDER BY seq DESC LIMIT 1",
  )
    .bind(row.id)
    .first<{ created_at: number }>();
  return c.json(
    renderSarif(report, {
      start_time_utc: utc(row.created_at),
      end_time_utc: utc(finished?.created_at ?? row.created_at),
      exit_code: null,
    }),
    200,
    { "content-type": "application/sarif+json" },
  );
});
app.get("/v1/reviews/:id/audit", async (c) => {
  await reviewAccess(c.req.raw, c.env, c.req.param("id"));
  const id = c.req.param("id");
  const rows = await c.env.DB.prepare(
    "SELECT object_key,hypothesis_id FROM votes WHERE review_id=? ORDER BY hypothesis_id,voter",
  )
    .bind(id)
    .all<{ object_key: string; hypothesis_id: string }>();
  const hypotheses = await c.env.DB.prepare(
    "SELECT object_key FROM hypotheses WHERE review_id=? ORDER BY id",
  )
    .bind(id)
    .all<{ object_key: string }>();
  const usage = await c.env.DB.prepare(
    "SELECT actor,phase,status,input_tokens,cache_read_tokens,cache_write_tokens,usage_convention,output_tokens,cost_usd,cost_source,model FROM usage WHERE review_id=? ORDER BY id",
  )
    .bind(id)
    .all();
  // Council transfers per finding and member, by hash and size; kept past retention.
  const council = await c.env.DB.prepare(
    "SELECT finding_id,member,round,vendor,model,pack_hash,pack_bytes,rendering_hash,rendering_bytes,abstained,cause,created_at FROM council_assessments WHERE review_id=? ORDER BY finding_id,member,round",
  )
    .bind(id)
    .all();
  const store = new Store(c.env);
  const qaRecords: Record<string, unknown> = {};
  for (const name of [
    "plan.json",
    "outcomes.json",
    "manifest.json",
    "recommendations.json",
    "assessment.json",
    "observations.json",
    "observation-candidates.json",
    "baseline.json",
    "audit.json",
    "verification.json",
    "recommendation-history.json",
    "policy.json",
  ]) {
    const record = await c.env.ARTIFACTS.get(`reviews/${id}/qa/${name}`);
    if (record) qaRecords[name] = await record.json();
  }
  c.header("cache-control", "private, no-store");
  return c.json({
    ...(Object.keys(qaRecords).length ? { qa_records: qaRecords } : {}),
    ...(council.results.length ? { council: council.results } : {}),
    hypotheses: await Promise.all(
      hypotheses.results.map((r) => store.get(r.object_key)),
    ),
    votes: await Promise.all(
      rows.results.map(async (r) => ({
        ...(await store.get<any>(r.object_key)),
        hypothesis_id: r.hypothesis_id,
      })),
    ),
    usage: usage.results,
    executions: await Promise.all(
      (
        await c.env.DB.prepare(
          "SELECT id,result_key FROM jobs WHERE review_id=? AND status='completed'",
        )
          .bind(id)
          .all<{ id: string; result_key: string }>()
      ).results.map(async (r) => {
        // Council job results expire with the evidence retention; the audit
        // still answers, naming the job as expired.
        const stored = await c.env.ARTIFACTS.get(r.result_key);
        if (!stored) return { job_id: r.id, expired: true };
        // Runner graphs reach megabytes per version and are not verification
        // evidence; the audit keeps their size, not their content.
        const result = await stored.json<any>();
        const graphs = result?.artifact?.graphs;
        if (graphs && typeof graphs === "object") {
          result.artifact = {
            ...result.artifact,
            graphs: Object.fromEntries(
              Object.entries(graphs).map(([version, graph]: [string, any]) => [
                version,
                {
                  nodes: graph?.nodes?.length ?? 0,
                  edges: graph?.edges?.length ?? 0,
                  truncated: graph?.truncated === true,
                  omitted: true,
                },
              ]),
            ),
          };
        }
        return result;
      }),
    ),
  });
});
app.get("/v1/reviews/:id/events", async (c) => {
  await reviewAccess(c.req.raw, c.env, c.req.param("id"));
  const after = Number(
    c.req.header("last-event-id") ?? c.req.query("after") ?? 0,
  );
  invariant(Number.isSafeInteger(after) && after >= 0, "invalid event cursor");
  const rows = await c.env.DB.prepare(
    "SELECT seq,event,data FROM events WHERE review_id=? AND seq>? ORDER BY seq LIMIT 1000",
  )
    .bind(c.req.param("id"), after)
    .all<{ seq: number; event: string; data: string }>();
  return c.body(
    rows.results
      .map((r) => `id: ${r.seq}\nevent: ${r.event}\ndata: ${r.data}\n\n`)
      .join(""),
    200,
    { "content-type": "text/event-stream", "cache-control": "no-store" },
  );
});
app.post("/v1/reviews/:id/cancel", async (c) => {
  const row = await reviewAccess(
    c.req.raw,
    c.env,
    c.req.param("id"),
    "reviews:write",
  );
  await c.env.DB.prepare(
    "UPDATE reviews SET cancelled=1,status='cancelled' WHERE id=? AND status NOT IN ('complete','partial','error')",
  )
    .bind(row.id)
    .run();
  const qa = await c.env.DB.prepare(
    "SELECT q.id FROM qa_runs q JOIN reviews r ON r.id=q.review_id WHERE q.review_id=? AND r.cancelled=1",
  )
    .bind(row.id)
    .all<{ id: string }>();
  for (const run of qa.results) await revokeQaRun(c.env, run.id);
  return c.json({ id: row.id, status: "cancelled" });
});
app.get("/v1/lineages", async (c) => {
  const tenant = await authenticate(c.req.raw, c.env, "reviews:read");
  const ref = {
    repository: c.req.query("repository"),
    kind: c.req.query("kind"),
    ref: c.req.query("ref"),
  };
  validateLineageRef(ref, false);
  const row = await c.env.DB.prepare(
    "SELECT * FROM lineages WHERE id=? AND tenant=?",
  )
    .bind(lineageId(tenant, ref), tenant)
    .first<any>();
  if (!row) return c.json({ error: "lineage not found" }, 404);
  return c.json({
    repository: row.repository,
    kind: row.kind,
    ref: row.ref,
    generation: row.generation,
    round: row.round,
    previous_head: row.previous_head,
    posted: Object.keys(JSON.parse(row.posted_json)).sort(),
    rounds_to_pass: row.rounds_to_pass,
  });
});
const STATUSES = ["open", "fixed", "dismissed"];
function since(value: string | undefined): number | null {
  if (value === undefined) return null;
  const ms = Date.parse(value);
  invariant(
    /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2}))?$/.test(value) &&
      Number.isFinite(ms),
    "invalid since: expected an RFC 3339 timestamp",
  );
  return ms;
}
// The caller's repository finding registry (finding-history).
app.get("/v1/findings", async (c) => {
  const tenant = await authenticate(c.req.raw, c.env, "reviews:read");
  const repository = c.req.query("repository"),
    status = c.req.query("status"),
    rule = c.req.query("rule"),
    after = since(c.req.query("since"));
  invariant(!status || STATUSES.includes(status), "invalid status");
  invariant(
    repository === undefined ||
      (repository.length > 0 && repository.length <= 512),
    "invalid repository",
  );
  if (repository) {
    const known = await c.env.DB.prepare(
      "SELECT 1 AS known FROM finding_history WHERE tenant=? AND repository=? LIMIT 1",
    )
      .bind(tenant, repository)
      .first();
    if (!known)
      return c.json({ error: "no findings recorded for repository" }, 404);
  }
  const where = ["tenant=?"],
    binds: unknown[] = [tenant];
  for (const [column, value] of [
    ["repository", repository],
    ["status", status],
    ["rule_id", rule],
  ] as const)
    if (value) {
      where.push(`${column}=?`);
      binds.push(value);
    }
  if (after !== null) {
    where.push("updated_at>=?");
    binds.push(after);
  }
  const rows = await c.env.DB.prepare(
    `SELECT * FROM finding_history WHERE ${where.join(" AND ")} ORDER BY updated_at DESC,identity LIMIT 1000`,
  )
    .bind(...binds)
    .all<any>();
  return c.json({ findings: rows.results.map(publicRecord) });
});
// Suppression proposals; the endpoint never writes repository files.
app.get("/v1/suppressions", async (c) => {
  const tenant = await authenticate(c.req.raw, c.env, "reviews:read");
  const repository = c.req.query("repository"),
    status = c.req.query("status");
  invariant(
    !status || ["proposed", "applied", "declined"].includes(status),
    "invalid status",
  );
  const where = ["tenant=?"],
    binds: unknown[] = [tenant];
  if (repository) {
    where.push("repository=?");
    binds.push(repository);
  }
  if (status) {
    where.push("status=?");
    binds.push(status);
  }
  const rows = await c.env.DB.prepare(
    `SELECT * FROM suppressions WHERE ${where.join(" AND ")} ORDER BY created_at,id LIMIT 1000`,
  )
    .bind(...binds)
    .all<any>();
  return c.json({ suppressions: rows.results.map(publicProposal) });
});
// Records the human decision on a proposal; applying edits the profile locally.
app.post("/v1/suppressions/:id", async (c) => {
  const tenant = await authenticate(c.req.raw, c.env, "reviews:write"),
    value = await body(c.req.raw, 16 * 1024);
  invariant(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).every((k) => ["status", "note"].includes(k)) &&
      ["applied", "declined"].includes(value.status) &&
      (value.note === undefined ||
        (typeof value.note === "string" && value.note.length <= 4000)),
    "invalid decision: expected status applied or declined and an optional note",
  );
  const row = await c.env.DB.prepare(
    "SELECT * FROM suppressions WHERE id=? AND tenant=?",
  )
    .bind(c.req.param("id"), tenant)
    .first<any>();
  if (!row) return c.json({ error: "proposal not found" }, 404);
  if (row.status !== "proposed")
    return c.json({ error: `proposal is ${row.status}` }, 409);
  await c.env.DB.prepare(
    "UPDATE suppressions SET status=?,note=?,decided_at=? WHERE id=? AND tenant=? AND status='proposed'",
  )
    .bind(value.status, value.note ?? null, Date.now(), row.id, tenant)
    .run();
  return c.json(
    publicProposal({
      ...row,
      status: value.status,
      note: value.note ?? null,
      decided_at: Date.now(),
    }),
  );
});
// Answers a posted lineage finding, or a finding of the repository registry.
// It writes author_response and a feedback record only; posture, budgets,
// rules and suppressions are never touched.
app.post("/v1/qa/recommendations/:id/feedback", async (c) => {
  const tenant = await authenticate(c.req.raw, c.env, "reviews:write");
  const value = await body(c.req.raw, 64 * 1024),
    id = c.req.param("id");
  invariant(/^[a-f0-9]{64}$/.test(id), "invalid recommendation id");
  invariant(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).every((key) =>
        ["repository", "reason", "note", "actor"].includes(key),
      ),
    "invalid recommendation feedback",
  );
  invariant(
    typeof value.repository === "string" &&
      value.repository.length > 0 &&
      value.repository.length <= 512,
    "invalid repository",
  );
  invariant(
    ["wrong", "intentional", "irrelevant", "style"].includes(value.reason),
    "invalid recommendation dismissal reason",
  );
  invariant(
    value.note === undefined ||
      (typeof value.note === "string" && value.note.length <= 4000),
    "invalid note",
  );
  invariant(
    value.actor === undefined ||
      (typeof value.actor === "string" &&
        value.actor.length > 0 &&
        value.actor.length <= 256),
    "invalid actor",
  );
  const response = {
    reason: value.reason,
    actor: value.actor ?? tenant,
    at: new Date().toISOString(),
    ...(value.note ? { note: value.note } : {}),
  };
  if (
    !(await dismissRecommendation(
      c.env,
      tenant,
      value.repository,
      id,
      response,
    ))
  )
    return c.json({ error: "recommendation not found" }, 404);
  return c.json({ id, status: "dismissed", dismissal: response });
});
app.post("/v1/findings/:id/feedback", async (c) => {
  const tenant = await authenticate(c.req.raw, c.env, "reviews:write"),
    value = await body(c.req.raw, 64 * 1024),
    given = c.req.param("id").toLowerCase();
  invariant(/^[a-f0-9]{1,64}$/.test(given), "invalid finding id");
  if (given.length < DISPLAY_ID_LEN)
    return c.json(
      {
        error: `finding ids need at least ${DISPLAY_ID_LEN} characters`,
      },
      400,
    );
  invariant(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).every((k) =>
        ["reason", "note", "actor", "lineage"].includes(k),
      ),
    "invalid feedback",
  );
  invariant(
    RESPONSE_REASONS.includes(value.reason),
    `invalid reason: expected one of ${RESPONSE_REASONS.join(", ")}`,
  );
  invariant(
    value.note === undefined ||
      (typeof value.note === "string" && value.note.length <= 4000),
    "invalid note",
  );
  invariant(
    value.actor === undefined ||
      (typeof value.actor === "string" &&
        value.actor.length > 0 &&
        value.actor.length <= 256),
    "invalid actor",
  );
  if (value.lineage !== undefined) validateLineageRef(value.lineage, false);
  // A full identity is answered as given; a prefix must match one finding.
  let id = given;
  if (given.length < 64) {
    const match = await resolvePrefix(
      c.env,
      tenant,
      given,
      value.lineage ? lineageId(tenant, value.lineage) : undefined,
    );
    if (match.kind === "ambiguous") {
      // The short error names the candidates for `rio feedback`; the full
      // identities are in `candidates`.
      const shown = match.candidates.slice(0, 5).map((c) => c.slice(0, 16));
      const more = match.candidates.length - shown.length;
      return c.json(
        {
          error: `finding id ${given} is ambiguous; it matches ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`,
          candidates: match.candidates,
        },
        409,
      );
    }
    if (match.kind !== "found")
      return c.json({ error: "finding not found" }, 404);
    id = match.identity;
  }
  const response = await recordFeedback(c.env, tenant, id, value);
  if (!response) return c.json({ error: "finding not found" }, 404);
  return c.json({ id, status: "dismissed", author_response: response });
});
app.post("/v1/runner/claim", async (c) => {
  const bearer = c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
  invariant(
    c.env.RUNNER_SECRET?.length >= 32 &&
      equal(hash(bearer), hash(c.env.RUNNER_SECRET)),
    "unauthorized",
  );
  // A runner may advertise an OpenAI-compatible model endpoint; only such a
  // runner leases model jobs (self-hosted council members).
  let models = false;
  try {
    const body: any = await c.req.raw.clone().json();
    models = body?.capabilities?.model_endpoint === true;
  } catch {
    // Older runners send no body.
  }
  await c.env.DB.prepare(
    "INSERT INTO runner_capabilities(name,seen_at,model_seen_at) VALUES('self-hosted',?,?) ON CONFLICT(name) DO UPDATE SET seen_at=excluded.seen_at,model_seen_at=COALESCE(excluded.model_seen_at,runner_capabilities.model_seen_at)",
  )
    .bind(Date.now(), models ? Date.now() : null)
    .run();
  const row = await c.env.DB.prepare(
    "UPDATE jobs SET status='leased',lease_until=? WHERE id=(SELECT j.id FROM jobs j JOIN reviews r ON r.id=j.review_id WHERE r.cancelled=0 AND r.deadline>? AND (j.status='pending' OR (j.status='leased' AND j.lease_until<?)) AND (j.kind IS NULL OR j.kind!='model' OR (? AND r.status='running')) AND NOT EXISTS(SELECT 1 FROM qa_runs q WHERE q.job_id=j.id AND (q.deadline<=? OR q.state NOT IN ('pending','running'))) ORDER BY j.created_at LIMIT 1) RETURNING *",
  )
    .bind(
      Date.now() + 180000,
      Date.now(),
      Date.now(),
      models ? 1 : 0,
      Date.now(),
    )
    .first<any>();
  if (!row) return c.json({ job: null });
  const payload = await new Store(c.env).get<Execution>(row.payload_key);
  if (payload.kind === "qa")
    return c.json({ job: payload, ...(await claimQaRun(c.env, payload)) });
  if (
    payload.kind !== "prepare" ||
    payload.network !== "clone" ||
    !payload.prepare
  ) {
    // The lease and the completion token outlast the job's transfer and wall.
    const expires =
      Date.now() +
      Math.max(180000, payload.limits.wall_ms + TRANSFER_CAP_MS + 60000);
    await c.env.DB.prepare(
      "UPDATE jobs SET lease_until=? WHERE id=? AND attempt=?",
    )
      .bind(expires, row.id, row.attempt)
      .run();
    return c.json({
      job: payload,
      token: await jobToken(c.env, row.review_id, row.id, row.attempt, expires),
    });
  }
  // A prepare job gets its secrets at claim time only: an installation token
  // (contents: read on one repository) for the clone phase, which the runner
  // revokes after cloning, and the single-use prepare credential. Neither is stored.
  const lease = Date.now() + PREPARE_WALL_MS + 60000;
  await c.env.DB.prepare(
    "UPDATE jobs SET lease_until=? WHERE id=? AND attempt=?",
  )
    .bind(lease, row.id, row.attempt)
    .run();
  const pull = await pullOf(c.env, row.review_id);
  let github: InstallationToken;
  try {
    invariant(
      pull && pull.state === "preparing",
      "pull request review is not preparing",
    );
    github = await InstallationToken.mint(
      c.env,
      payload.prepare.installation_id,
      payload.prepare.repository,
      { contents: "read" },
    );
  } catch (error) {
    await c.env.DB.prepare(
      "UPDATE jobs SET status='failed' WHERE id=? AND attempt=?",
    )
      .bind(row.id, row.attempt)
      .run();
    if (pull?.state === "preparing")
      await failPrepare(
        c.env,
        row.review_id,
        `preparation failed: ${error instanceof Error ? error.message : "no installation token"}`.slice(
          0,
          300,
        ),
      );
    return c.json({ job: null });
  }
  return c.json({
    job: payload,
    token: await jobToken(c.env, row.review_id, row.id, row.attempt, lease),
    prepare: {
      github_token: github.secret(),
      credential: await prepareCredential(c.env, row.review_id, pull!.tenant),
    },
  });
});
// A self-hosted runner downloads exactly the executor input the Sandbox streams.
app.post("/v1/runner/:review/:job/:attempt/heartbeat", async (c) => {
  const review = c.req.param("review"),
    job = c.req.param("job"),
    attempt = Number(c.req.param("attempt"));
  const token = await verifyJobToken(c.req.raw, c.env, review, job, attempt);
  return c.json(
    await heartbeatQaRun(
      c.env,
      await qaControl(c.env, review, job, attempt, token),
    ),
  );
});
app.post("/v1/runner/:review/:job/:attempt/qa-configure", async (c) => {
  const review = c.req.param("review"),
    job = c.req.param("job"),
    attempt = Number(c.req.param("attempt"));
  const token = await verifyJobToken(c.req.raw, c.env, review, job, attempt);
  return c.json(
    await configureQaRun(
      c.env,
      await qaControl(c.env, review, job, attempt, token),
      await body(c.req.raw, 1024 * 1024),
    ),
  );
});
app.get("/v1/runner/:review/:job/:attempt/archive", async (c) => {
  const review = c.req.param("review"),
    job = c.req.param("job"),
    attempt = Number(c.req.param("attempt"));
  await verifyJobToken(c.req.raw, c.env, review, job, attempt);
  const row = await c.env.DB.prepare(
    "SELECT payload_key FROM jobs WHERE id=? AND review_id=? AND attempt=?",
  )
    .bind(job, review, attempt)
    .first<{ payload_key: string }>();
  invariant(row, "unknown job attempt");
  const payload = await new Store(c.env).get<Execution>(row.payload_key);
  if (payload.kind === "qa") {
    const live = await c.env.DB.prepare(
      "SELECT q.id FROM qa_runs q JOIN reviews r ON r.id=q.review_id JOIN jobs j ON j.id=q.job_id AND j.attempt=q.attempt WHERE q.job_id=? AND q.attempt=? AND q.state='running' AND q.deadline>? AND r.cancelled=0 AND r.deadline>? AND j.status='leased' AND j.lease_until>?",
    )
      .bind(job, attempt, Date.now(), Date.now(), Date.now())
      .first();
    invariant(live, "unauthorized stopped QA job");
  }
  return new Response(await jobInput(c.env, payload), {
    headers: {
      "content-type": "application/octet-stream",
      "cache-control": "no-store",
    },
  });
});
app.post("/v1/runner/:review/:job/:attempt/complete", async (c) => {
  const review = c.req.param("review"),
    job = c.req.param("job"),
    attempt = Number(c.req.param("attempt"));
  const token = await verifyJobToken(c.req.raw, c.env, review, job, attempt);
  // Sign the exact transmitted bytes: re-serializing parsed JSON differs across
  // languages (integral floats, large integers, non-BMP key order).
  const raw = new TextDecoder().decode(
      // Matches the runner's COMPLETION_LIMIT: JSON escaping and the artifact copy
      // can expand 1 MiB of executor output well beyond its raw size.
      await bytes(c.req.raw, 16 * 1024 * 1024),
    ),
    expected = await sign(token, raw);
  invariant(
    equal(c.req.header("rio-signature") ?? "", expected),
    "unauthorized completion signature",
  );
  await finishJob(c.env, review, job, attempt, JSON.parse(raw), token);
  return c.json({ accepted: true });
});
export { app };
/** Deliveries per queue message: one plus `max_retries` in wrangler.jsonc. */
const JOB_DELIVERIES = 3;
export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env) {
    await expireQaEvidence(env);
    await sweepReviews(env);
  },
  async queue(batch: MessageBatch<QueueMessage>, env: Env) {
    for (const message of batch.messages) {
      const body = message.body;
      if (body.type && body.type !== "job") {
        // PR mode: GitHub is called here, never from the webhook handler. A
        // failure is retried by the queue, never by GitHub's redelivery.
        try {
          if (body.type === "review-request")
            await handleReviewRequest(env, body);
          else if (body.type === "command") await handleCommand(env, body);
          else if (body.type === "publish")
            await publishFinished(env, body.review_id);
          message.ack();
        } catch (error) {
          console.log(
            `rio: ${body.type} failed: ${redact(error instanceof Error ? error.message : String(error)).slice(0, 300)}`,
          );
          if (message.attempts < JOB_DELIVERIES) {
            message.retry({ delaySeconds: 10 });
            continue;
          }
          if (body.type === "review-request")
            await (
              body.review_id
                ? failPrepare(
                    env,
                    body.review_id,
                    "pull request review request failed",
                  )
                : failUnscheduled(env, body)
            ).catch(() => {});
          message.ack();
        }
        continue;
      }
      if (env.RUNNER_BACKEND !== "sandbox") {
        message.ack();
        continue;
      }
      try {
        const { review_id, job_id, attempt } = message.body as JobMessage,
          store = new Store(env);
        if (await store.cancelled(review_id)) {
          message.ack();
          continue;
        }
        const row = await env.DB.prepare(
          "UPDATE jobs SET status='leased',lease_until=? WHERE id=? AND attempt=? AND status IN ('pending','leased') RETURNING payload_key",
        )
          // Held for the longest Sandbox job: transfer, command wall and teardown.
          .bind(
            Date.now() + TRANSFER_CAP_MS + ANALYSIS_WALL_MS + 60000,
            job_id,
            attempt,
          )
          .first<{ payload_key: string }>();
        if (!row) {
          message.ack();
          continue;
        }
        const payload = await store.get<Execution>(row.payload_key);
        const sandbox = env.SANDBOX.get(
          env.SANDBOX.idFromName(`${review_id}-${job_id}-${attempt}`),
        );
        const response = await sandbox.fetch("https://sandbox/execute", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        invariant(response.ok, "sandbox execution failed");
        if (payload.kind !== "qa")
          await finishJob(
            env,
            review_id,
            job_id,
            attempt,
            await response.json(),
          );
        message.ack();
      } catch (error) {
        // Only infrastructure errors reach here (a deadline is a result). The
        // last delivery (max_retries in wrangler.jsonc) records the failure so
        // the review fails with its reason instead of waiting for the step timeout.
        if (message.attempts < JOB_DELIVERIES) {
          message.retry({ delaySeconds: 10 + Math.floor(Math.random() * 20) });
          continue;
        }
        try {
          const { review_id, job_id, attempt } = message.body as JobMessage;
          await failJob(
            env,
            review_id,
            job_id,
            attempt,
            error instanceof Error ? error.message : String(error),
          );
        } catch {
          /* The job may already be completed or cancelled; the workflow times out as before. */
        }
        message.ack();
      }
    }
  },
};

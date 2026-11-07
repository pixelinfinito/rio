import { Hono } from "hono";
import type { Env, Execution, Submission } from "./types";
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
import { jobInput } from "./archive";
import { attachStatements, lineageId } from "./lineage";
import { Store } from "./storage";
import { failJob, finishJob } from "./jobs";
import { parseWall } from "./budget";
export { ReviewWorkflow } from "./workflow";
export { MigrationWorkflow } from "./migrate";
export { Sandbox } from "./sandbox";
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
// Snapshots are uploaded as deduplicated contents plus a chunked manifest
// (docs/cloudflare.md, "Snapshot protocol").
app.post("/v1/contents/missing", async (c) => {
  const tenant = await authenticate(c.req.raw, c.env, "reviews:write");
  return c.json({
    missing: await missing(c.env, tenant, await body(c.req.raw, 1024 * 1024)),
  });
});
app.put("/v1/packs", async (c) => {
  const tenant = await authenticate(c.req.raw, c.env, "reviews:write");
  return c.json(
    await storePack(c.env, tenant, await bytes(c.req.raw, LIMITS.request)),
    201,
  );
});
app.post("/v1/contents/:hash/uploads", async (c) => {
  const tenant = await authenticate(c.req.raw, c.env, "reviews:write");
  const result = await startUpload(
    c.env,
    tenant,
    c.req.param("hash"),
    await body(c.req.raw, 64 * 1024),
  );
  return c.json(result, result.present ? 200 : 201);
});
app.post("/v1/contents/:hash/uploads/complete", async (c) => {
  const tenant = await authenticate(c.req.raw, c.env, "reviews:write");
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
  const tenant = await authenticate(c.req.raw, c.env, "reviews:write");
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
  const tenant = await authenticate(c.req.raw, c.env, "reviews:write");
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
  const tenant = await authenticate(c.req.raw, c.env, "reviews:write");
  const result = await seal(
    c.env,
    tenant,
    c.req.param("id"),
    await body(c.req.raw, 64 * 1024),
  );
  return c.json({ id: result.id }, result.created ? 201 : 200);
});
app.post("/v1/reviews", async (c) => {
  const tenant = await authenticate(c.req.raw, c.env, "reviews:write"),
    value = await body(c.req.raw, 8 * 1024 * 1024);
  validateSubmission(value);
  const snapshotRow = await c.env.DB.prepare(
    "SELECT object_key FROM snapshots WHERE id=? AND tenant=?",
  )
    .bind(value.snapshot_id, tenant)
    .first<{ object_key: string }>();
  invariant(snapshotRow, "snapshot not found");
  const store = new Store(c.env),
    snapshot = await StoredSnapshot.open(c.env, snapshotRow.object_key);
  for (const version of ["base", "head"] as const) {
    const graph = value.graphs[version];
    invariant(
      graph && Array.isArray(graph.nodes) && graph.nodes.length <= 100000,
      "invalid graph",
    );
    validateGraph(
      graph,
      await lineCounts(
        snapshot[version],
        new Set(graph.nodes.map((n: any) => n?.path)),
      ),
    );
  }
  // Guidance is reproduced from immutable head, never accepted from mutable working state.
  const guidance = await materialize(
    snapshot.head,
    value.owner_guidance.map((g) => g.path),
  );
  for (const g of value.owner_guidance) {
    const file = guidance[g.path];
    invariant(
      file &&
        file.mode !== SYMLINK &&
        !file.encoding &&
        ["REVIEW.md", "CLAUDE.md", "AGENTS.md"].includes(
          g.path.split("/").at(-1) ?? "",
        ) &&
        g.scope_dir === g.path.split("/").slice(0, -1).join("/") &&
        g.content_hash === hash(file.content) &&
        Array.isArray(g.lines) &&
        g.lines.join("\n") ===
          file.content.replace(/\r\n/g, "\n").replace(/\n$/, ""),
      "guidance does not match snapshot",
    );
  }
  const id = crypto.randomUUID(),
    key = `reviews/${id}/submission.json`;
  await store.put(key, value);
  const active =
    value.mode === "deep"
      ? (value.profile.budget.deep ?? value.profile.budget.fast)
      : value.profile.budget.fast;
  const wall = parseWall(active.wall_time);
  invariant(wall <= 3600000, "review wall budget exceeds one hour");
  // The review and its lineage attachment (including a reset) commit together.
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO reviews(id,tenant,submission_key,status,created_at,token_limit,deadline) VALUES(?,?,?,'queued',?,?,?)",
    ).bind(
      id,
      tenant,
      key,
      Date.now(),
      active.tokens ?? 100000,
      Date.now() + wall,
    ),
    ...(value.lineage
      ? attachStatements(c.env, tenant, value.lineage, id, value.snapshot_id)
      : []),
  ]);
  try {
    await c.env.REVIEWS.create({
      id,
      params: { review_id: id, snapshot_key: snapshotRow.object_key },
    });
  } catch {
    await c.env.DB.prepare(
      "UPDATE reviews SET status='error',error='workflow creation failed' WHERE id=?",
    )
      .bind(id)
      .run();
    throw new Error("workflow creation failed");
  }
  return c.json({ id, status: "queued" }, 202);
});
app.get("/v1/reviews/:id", async (c) => {
  const row = await reviewAccess(c.req.raw, c.env, c.req.param("id"));
  return c.json({ id: row.id, status: row.status, error: row.error });
});
app.get("/v1/reviews/:id/report", async (c) => {
  const row = await reviewAccess(c.req.raw, c.env, c.req.param("id"));
  invariant(row.report_key, "report is not ready");
  return c.json(await new Store(c.env).get(row.report_key));
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
    "SELECT actor,phase,status,input_tokens,output_tokens,cost_usd,model FROM usage WHERE review_id=? ORDER BY id",
  )
    .bind(id)
    .all();
  const store = new Store(c.env);
  return c.json({
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
          "SELECT result_key FROM jobs WHERE review_id=? AND status='completed'",
        )
          .bind(id)
          .all<{ result_key: string }>()
      ).results.map((r) => store.get(r.result_key)),
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
// Answers a posted lineage finding. It writes author_response and a feedback
// record only; posture, budgets, rules and suppressions are never touched.
app.post("/v1/findings/:id/feedback", async (c) => {
  const tenant = await authenticate(c.req.raw, c.env, "reviews:write"),
    value = await body(c.req.raw, 64 * 1024),
    id = c.req.param("id");
  invariant(/^[a-f0-9]{64}$/.test(id), "invalid finding id");
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
  const row = await (
    value.lineage
      ? c.env.DB.prepare(
          "SELECT lineage_id,generation FROM findings WHERE tenant=? AND identity=? AND lineage_id=? AND first_posted_in IS NOT NULL ORDER BY generation DESC LIMIT 1",
        ).bind(tenant, id, lineageId(tenant, value.lineage))
      : c.env.DB.prepare(
          "SELECT lineage_id,generation FROM findings WHERE tenant=? AND identity=? AND first_posted_in IS NOT NULL ORDER BY updated_at DESC,generation DESC LIMIT 1",
        ).bind(tenant, id)
  ).first<{ lineage_id: string; generation: number }>();
  if (!row) return c.json({ error: "finding not found" }, 404);
  const response = {
    reason: value.reason,
    actor: value.actor ?? tenant,
    at: new Date().toISOString(),
    ...(value.note ? { note: value.note } : {}),
  };
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE findings SET status='dismissed',author_response_json=?,updated_at=? WHERE tenant=? AND lineage_id=? AND generation=? AND identity=?",
    ).bind(
      JSON.stringify(response),
      Date.now(),
      tenant,
      row.lineage_id,
      row.generation,
      id,
    ),
    c.env.DB.prepare(
      "INSERT INTO feedback(id,tenant,finding_id,reason,actor,note,created_at) VALUES(?,?,?,?,?,?,?)",
    ).bind(
      crypto.randomUUID(),
      tenant,
      id,
      response.reason,
      response.actor,
      value.note ?? null,
      Date.now(),
    ),
  ]);
  return c.json({ id, status: "dismissed", author_response: response });
});
app.post("/v1/runner/claim", async (c) => {
  const bearer = c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
  invariant(
    c.env.RUNNER_SECRET?.length >= 32 &&
      equal(hash(bearer), hash(c.env.RUNNER_SECRET)),
    "unauthorized",
  );
  const row = await c.env.DB.prepare(
    "UPDATE jobs SET status='leased',lease_until=? WHERE id=(SELECT j.id FROM jobs j JOIN reviews r ON r.id=j.review_id WHERE r.cancelled=0 AND r.deadline>? AND (j.status='pending' OR (j.status='leased' AND j.lease_until<?)) ORDER BY j.created_at LIMIT 1) RETURNING *",
  )
    .bind(Date.now() + 180000, Date.now(), Date.now())
    .first<any>();
  if (!row) return c.json({ job: null });
  const payload = await new Store(c.env).get<Execution>(row.payload_key);
  return c.json({
    job: payload,
    token: await jobToken(
      c.env,
      row.review_id,
      row.id,
      row.attempt,
      Date.now() + 180000,
    ),
  });
});
// A self-hosted runner downloads exactly the executor input the Sandbox streams.
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
  await finishJob(c.env, review, job, attempt, JSON.parse(raw));
  return c.json({ accepted: true });
});
export { app };
/** Deliveries per queue message: one plus `max_retries` in wrangler.jsonc. */
const JOB_DELIVERIES = 3;
export default {
  fetch: app.fetch,
  async queue(
    batch: MessageBatch<{ review_id: string; job_id: string; attempt: number }>,
    env: Env,
  ) {
    for (const message of batch.messages) {
      if (env.RUNNER_BACKEND !== "sandbox") {
        message.ack();
        continue;
      }
      try {
        const { review_id, job_id, attempt } = message.body,
          store = new Store(env);
        if (await store.cancelled(review_id)) {
          message.ack();
          continue;
        }
        const row = await env.DB.prepare(
          "UPDATE jobs SET status='leased',lease_until=? WHERE id=? AND attempt=? AND status!='completed' RETURNING payload_key",
        )
          .bind(Date.now() + 180000, job_id, attempt)
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
        await finishJob(env, review_id, job_id, attempt, await response.json());
        message.ack();
      } catch (error) {
        // The last delivery (max_retries in wrangler.jsonc) records the failure so
        // the review fails with its reason instead of waiting for the step timeout.
        if (message.attempts < JOB_DELIVERIES) {
          message.retry({ delaySeconds: 10 });
          continue;
        }
        try {
          const { review_id, job_id, attempt } = message.body;
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

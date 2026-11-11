import { Hono } from "hono";
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { authenticate, equal, sign } from "./auth";
import { authenticateQaRun, type QaConfiguration, type QaRun } from "./qa-jobs";
import { canonical, hash, invariant } from "./validation";
import { scrub } from "./redaction";
import type { Env } from "./types";

const DAY = 86400000,
  PART = 8 * 1024 ** 2;
const formats: Record<string, [string, string]> = {
  screenshot: ["png", "image/png"],
  dom: ["json", "application/json"],
  accessibility: ["json", "application/json"],
  console: ["jsonl", "application/x-ndjson"],
  network: ["jsonl", "application/x-ndjson"],
  capture: ["jsonl", "application/x-ndjson"],
  trace: ["zip", "application/zip"],
  replay: ["jsonl", "application/x-ndjson"],
  transcript: ["jsonl", "application/x-ndjson"],
  video: ["webm", "video/webm"],
  probe: ["json", "application/json"],
};
const optional = new Set(["trace", "video"]);
interface Descriptor {
  id: string;
  content_hash: string;
  bytes: number;
  kind: string;
  journey: string;
  step?: number;
  cell: { viewport: string; color_scheme: string };
  sanitized: true;
}
interface Row {
  run_id: string;
  id: string;
  tenant: string;
  review_id: string;
  generation: string;
  object_key: string;
  descriptor: string;
  bytes: number;
  state: "pending" | "stored";
  expires_at: number;
}
class EvidenceError extends Error {
  constructor(
    readonly reason: string,
    readonly status: 400 | 401 | 404 | 409 | 410 | 429 | 503 = 400,
  ) {
    super(reason);
  }
}
function check(
  value: unknown,
  reason = "invalid_evidence",
  status: EvidenceError["status"] = 400,
): asserts value {
  if (!value) throw new EvidenceError(reason, status);
}
function descriptor(
  value: any,
  run: QaRun,
): { value: Descriptor; key: string } {
  check(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).every((key) =>
        [
          "id",
          "content_hash",
          "bytes",
          "kind",
          "journey",
          "step",
          "cell",
          "sanitized",
        ].includes(key),
      ),
  );
  check(
    /^[a-f0-9]{64}$/.test(value.id) &&
      /^[a-f0-9]{64}$/.test(value.content_hash) &&
      Number.isSafeInteger(value.bytes) &&
      value.bytes >= 0,
  );
  check(
    Object.hasOwn(formats, value.kind) &&
      value.sanitized === true &&
      /^[a-z][a-z0-9-]*$/.test(value.journey),
  );
  check(
    value.step === undefined ||
      (Number.isSafeInteger(value.step) && value.step > 0),
  );
  check(
    value.cell &&
      /^[a-z][a-z0-9-]*$/.test(value.cell.viewport) &&
      ["light", "dark"].includes(value.cell.color_scheme),
  );
  check(
    Object.keys(value.cell).every((key) =>
      ["viewport", "color_scheme"].includes(key),
    ),
  );
  const config = JSON.parse(run.configuration!) as QaConfiguration;
  check(
    config.cells.some(
      (cell) =>
        cell.chain.includes(value.journey) &&
        cell.viewport === value.cell.viewport &&
        cell.color_scheme === value.cell.color_scheme,
    ),
    "unauthorized evidence cell",
    401,
  );
  const key = `${value.journey}/${value.cell.viewport}-${value.cell.color_scheme}/${value.step === undefined ? "cell" : `step-${String(value.step).padStart(4, "0")}`}-${value.kind}-${value.content_hash.slice(0, 16)}.${formats[value.kind][0]}`;
  check(
    value.id === hash(JSON.stringify([key, value.content_hash])),
    "invalid_evidence_identity",
  );
  return { value, key };
}
async function runFor(request: Request, env: Env, runId: string) {
  const run = await authenticateQaRun(request, env);
  check(
    run.id === runId && run.configuration && !run.evidence_pruned,
    "unauthorized evidence run",
    401,
  );
  return run;
}
function prefix(row: Pick<Row, "tenant" | "review_id" | "run_id">) {
  return `qa/${encodeURIComponent(row.tenant)}/${encodeURIComponent(row.review_id)}/${row.run_id}/`;
}
async function link(env: Env, row: Row, origin: string) {
  if (row.expires_at <= Date.now())
    return { expired: true, expires_at: row.expires_at };
  const expires = Math.min(row.expires_at, Date.now() + 7 * DAY);
  invariant(env.RUNNER_SECRET?.length >= 32, "evidence signing unavailable");
  const signature = await sign(
    env.RUNNER_SECRET,
    canonical({
      tenant: row.tenant,
      run: row.run_id,
      id: row.id,
      expires,
      content_hash: JSON.parse(row.descriptor).content_hash,
    }),
  );
  const url = new URL(
    `/v1/qa/evidence/${row.run_id}/${row.id}`,
    env.PUBLIC_URL || origin,
  );
  url.searchParams.set("expires", String(expires));
  url.searchParams.set("signature", signature);
  return {
    link: url.href,
    link_expires_at: expires,
    expires_at: row.expires_at,
  };
}
async function record(env: Env, row: Row, origin: string) {
  const meta = JSON.parse(row.descriptor) as Descriptor;
  const name = `${meta.step === undefined ? "cell" : `step-${String(meta.step).padStart(4, "0")}`}-${meta.kind}-${meta.content_hash.slice(0, 16)}.${formats[meta.kind][0]}`;
  return {
    ...meta,
    storage: "hosted",
    key:
      prefix(row) +
      `${meta.journey}/${meta.cell.viewport}-${meta.cell.color_scheme}/${name}`,
    ...(await link(env, row, origin)),
  };
}
/** Every physical key has one owner. Garbage keys survive failed R2 deletes,
 * and cannot name a later retry's object with the same artifact identity. */
async function retire(env: Env, row: Row, pendingOnly = false) {
  const predicate =
    "run_id=? AND id=? AND object_key=?" +
    (pendingOnly ? " AND state='pending'" : "");
  const args = [row.run_id, row.id, row.object_key];
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO qa_evidence_garbage(object_key,tenant,review_id,pending) SELECT object_key,tenant,review_id,CASE WHEN state='pending' THEN 1 ELSE 0 END FROM qa_evidence WHERE ${predicate} ON CONFLICT DO NOTHING`,
    ).bind(...args),
    env.DB.prepare(
      `UPDATE qa_runs SET evidence_used=evidence_used-COALESCE((SELECT bytes FROM qa_evidence WHERE ${predicate}),0) WHERE id=?`,
    ).bind(...args, row.run_id),
    env.DB.prepare(`DELETE FROM qa_evidence WHERE ${predicate}`).bind(...args),
  ]);
}
async function collectGarbage(env: Env, tenant: string, review: string) {
  let cursor = "";
  while (true) {
    const rows = await env.DB.prepare(
      "SELECT object_key FROM qa_evidence_garbage WHERE tenant=? AND review_id=? AND object_key>? ORDER BY object_key LIMIT 1000",
    )
      .bind(tenant, review, cursor)
      .all<{ object_key: string }>();
    if (!rows.results.length) return;
    const keys = rows.results.map((row) => row.object_key);
    await env.ARTIFACTS.delete(keys);
    await env.DB.prepare(
      "DELETE FROM qa_evidence_garbage WHERE object_key IN (SELECT value FROM json_each(?)) AND pending=0",
    )
      .bind(JSON.stringify(keys))
      .run();
    // Pending upload tombstones remain for a later sweep, but must not starve
    // completed deletions on the following page.
    cursor = keys[keys.length - 1];
  }
}
/** Multipart uploads bound controller-to-Worker memory and verify BLAKE3 before
 * making an object complete. D1 is the publication point after the last check. */
async function upload(
  request: Request,
  env: Env,
  run: QaRun,
  row: Row,
  meta: Descriptor,
  stopped: () => void,
) {
  const multipart = await env.ARTIFACTS.createMultipartUpload(row.object_key, {
    httpMetadata: { contentType: formats[meta.kind][1] },
    customMetadata: {
      expires_at: String(row.expires_at),
      content_hash: meta.content_hash,
    },
  });
  const digest = blake3.create(),
    parts: R2UploadedPart[] = [];
  let total = 0,
    used = 0,
    buffer = new Uint8Array(PART);
  const send = async () => {
    await runFor(request, env, run.id);
    parts.push(
      await multipart.uploadPart(parts.length + 1, buffer.subarray(0, used)),
    );
    used = 0;
    buffer = new Uint8Array(PART);
  };
  try {
    const reader = request.body?.getReader();
    if (reader)
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          total += next.value.length;
          check(total <= meta.bytes, "evidence_size_mismatch");
          digest.update(next.value);
          let at = 0;
          while (at < next.value.length) {
            const size = Math.min(PART - used, next.value.length - at);
            buffer.set(next.value.subarray(at, at + size), used);
            used += size;
            at += size;
            if (used === PART) await send();
          }
        }
      } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
      } finally {
        reader.releaseLock();
      }
    check(
      total === meta.bytes && bytesToHex(digest.digest()) === meta.content_hash,
      "evidence_hash_mismatch",
    );
    if (used || !parts.length) await send();
    await runFor(request, env, run.id);
    await multipart.complete(parts);
    stopped();
  } catch (error) {
    try {
      await multipart.abort();
      stopped();
    } catch {
      /* Keep a tombstone for an uncertain storage outcome. */
    }
    throw error;
  }
}
export async function putEvidence(
  request: Request,
  env: Env,
  runId: string,
  id: string,
) {
  const run = await runFor(request, env, runId);
  let value: any;
  try {
    const header = request.headers.get("rio-evidence-metadata") || "";
    check(header.length < 16384);
    value = JSON.parse(header);
  } catch {
    throw new EvidenceError("invalid_evidence");
  }
  const { value: meta } = descriptor(value, run);
  check(id === meta.id);
  let existing = await env.DB.prepare(
    "SELECT * FROM qa_evidence WHERE run_id=? AND id=?",
  )
    .bind(run.id, id)
    .first<Row>();
  if (existing?.state === "pending" && existing.generation !== run.generation) {
    await retire(env, existing, true);
    existing = null;
  }
  if (existing) {
    check(existing.descriptor === canonical(meta), "conflicting_evidence", 409);
    check(existing.state === "stored", "evidence_upload_in_progress", 409);
    await request.body?.cancel();
    return record(env, existing, request.url);
  }
  const config = JSON.parse(run.configuration!) as QaConfiguration;
  const row: Row = {
    run_id: run.id,
    id,
    tenant: run.tenant,
    review_id: run.review_id,
    generation: run.generation,
    object_key:
      prefix({ run_id: run.id, tenant: run.tenant, review_id: run.review_id }) +
      `objects/${crypto.randomUUID()}`,
    descriptor: canonical(meta),
    bytes: meta.bytes,
    state: "pending",
    expires_at: run.created_at + (config.evidence_retention_days ?? 30) * DAY,
  };
  const now = Date.now();
  check(row.expires_at > now, "evidence_expired", 410);
  const reserved = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO qa_evidence(run_id,id,tenant,review_id,generation,object_key,descriptor,bytes,state,expires_at,created_at)
      SELECT q.id,?,r.tenant,q.review_id,q.generation,?,?,?,'pending',?,? FROM qa_runs q JOIN reviews r ON r.id=q.review_id JOIN jobs j ON j.id=q.job_id AND j.attempt=q.attempt
      WHERE q.id=? AND q.generation=? AND q.state='running' AND q.evidence_pruned=0 AND q.deadline>? AND r.cancelled=0 AND r.deadline>? AND j.status='leased' AND j.lease_until>?
      AND (?=0 OR q.evidence_used+?<=q.evidence_limit) ON CONFLICT DO NOTHING RETURNING id`,
    ).bind(
      id,
      row.object_key,
      row.descriptor,
      row.bytes,
      row.expires_at,
      now,
      run.id,
      run.generation,
      now,
      now,
      now,
      optional.has(meta.kind) ? 1 : 0,
      row.bytes,
    ),
    env.DB.prepare(
      "UPDATE qa_runs SET evidence_used=evidence_used+? WHERE id=? AND EXISTS(SELECT 1 FROM qa_evidence WHERE object_key=? AND state='pending')",
    ).bind(row.bytes, run.id, row.object_key),
  ]);
  if (!reserved[0].results.length) {
    await runFor(request, env, runId);
    const duplicate = await env.DB.prepare(
      "SELECT 1 FROM qa_evidence WHERE run_id=? AND id=?",
    )
      .bind(run.id, id)
      .first();
    throw new EvidenceError(
      duplicate ? "evidence_upload_in_progress" : "evidence_quota_reached",
      duplicate ? 409 : 429,
    );
  }
  let storageStopped = false;
  try {
    await upload(request, env, run, row, meta, () => {
      storageStopped = true;
    });
    const timestamp = Date.now();
    const committed = await env.DB.prepare(
      `UPDATE qa_evidence SET state='stored' WHERE object_key=? AND state='pending' AND expires_at>? AND EXISTS(
      SELECT 1 FROM qa_runs q JOIN reviews r ON r.id=q.review_id JOIN jobs j ON j.id=q.job_id AND j.attempt=q.attempt
      WHERE q.id=qa_evidence.run_id AND q.generation=qa_evidence.generation AND q.state='running' AND q.evidence_pruned=0 AND q.deadline>? AND r.cancelled=0 AND r.deadline>? AND j.status='leased' AND j.lease_until>?) RETURNING id`,
    )
      .bind(row.object_key, timestamp, timestamp, timestamp, timestamp)
      .all();
    check(
      committed.results.length,
      "unauthorized stopped evidence upload",
      401,
    );
    row.state = "stored";
    return await record(env, row, request.url);
  } catch (error) {
    if (row.state === "stored") throw error;
    await retire(env, row, true);
    // A prune can race an upload that is still completing in R2. Keep its
    // tombstone until this request has stopped, including after failed deletes.
    await env.DB.prepare(
      "INSERT INTO qa_evidence_garbage(object_key,tenant,review_id,pending) VALUES(?,?,?,?) ON CONFLICT(object_key) DO UPDATE SET pending=excluded.pending",
    )
      .bind(row.object_key, row.tenant, row.review_id, storageStopped ? 0 : 1)
      .run();
    await collectGarbage(env, row.tenant, row.review_id).catch(() => {});
    throw error;
  }
}
/** Reclaim releases old reservations, but keeps physical-key tombstones until
 * an old upload has stopped. A late completion can never replace a new object. */
export async function abandonEvidence(
  env: Env,
  runId: string,
  generation: string,
) {
  const rows = await env.DB.prepare(
    "SELECT * FROM qa_evidence WHERE run_id=? AND generation!=? AND state='pending'",
  )
    .bind(runId, generation)
    .all<Row>();
  for (const row of rows.results) await retire(env, row, true);
  if (rows.results.length)
    await collectGarbage(
      env,
      rows.results[0].tenant,
      rows.results[0].review_id,
    ).catch(() => {});
}
async function canRead(request: Request, env: Env, id: string) {
  if (request.headers.get("authorization")?.startsWith("Bearer qa-run."))
    return runFor(request, env, id);
  const tenant = await authenticate(request, env, [
    "qa:evidence",
    "reviews:read",
    "reviews:write",
  ]);
  const row = await env.DB.prepare(
    "SELECT q.*,r.tenant FROM qa_runs q JOIN reviews r ON r.id=q.review_id WHERE q.id=? AND r.tenant=?",
  )
    .bind(id, tenant)
    .first<QaRun>();
  check(row, "evidence_not_found", 404);
  return row;
}
export async function evidenceManifest(request: Request, env: Env, id: string) {
  const run = await canRead(request, env, id);
  const rows = await env.DB.prepare(
    "SELECT * FROM qa_evidence WHERE run_id=? AND state='stored' ORDER BY created_at,id",
  )
    .bind(id)
    .all<Row>();
  const notes = await env.DB.prepare(
    "SELECT notes FROM qa_evidence_manifests WHERE run_id=?",
  )
    .bind(id)
    .first<{ notes: string }>();
  return {
    version: 1,
    hash_algorithm: "blake3",
    bytes: rows.results.reduce((sum, row) => sum + row.bytes, 0),
    quota_bytes: run.evidence_limit,
    quota_reached: run.evidence_used >= run.evidence_limit,
    pruned: !!run.evidence_pruned,
    artifacts: await Promise.all(
      rows.results.map((row) => record(env, row, request.url)),
    ),
    notes: JSON.parse(notes?.notes || "[]"),
  };
}
/** Internal verifier access: database ownership and expiry are authoritative;
 * never trust a model/runner-supplied object key or fetch a supplied URL. */
export async function readQaEvidence(
  env: Env,
  tenant: string,
  review: string,
  run: string,
  artifact: import("./qa-verifier").BrowserArtifact,
): Promise<import("./qa-verifier").LoadedArtifact | null> {
  const row = await env.DB.prepare(
    "SELECT * FROM qa_evidence WHERE tenant=? AND review_id=? AND run_id=? AND id=? AND state='stored' AND expires_at>?",
  )
    .bind(tenant, review, run, artifact.id, Date.now())
    .first<Row>();
  if (!row) return null;
  const descriptor = JSON.parse(row.descriptor) as Descriptor;
  if (
    !descriptor.sanitized ||
    descriptor.journey !== artifact.journey ||
    descriptor.step !== artifact.step ||
    descriptor.kind !== artifact.kind ||
    canonical(descriptor.cell) !== canonical(artifact.cell)
  )
    return null;
  if (descriptor.kind === "trace")
    return (await env.ARTIFACTS.head(row.object_key)) ? {} : null;
  // Bound a verifier's memory, while retaining large originals in evidence storage.
  if (row.bytes > 8 * 1024 ** 2) return null;
  const object = await env.ARTIFACTS.get(row.object_key);
  if (!object) return null;
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (
    bytes.length !== row.bytes ||
    bytesToHex(blake3(bytes)) !== descriptor.content_hash
  )
    return null;
  if (descriptor.kind !== "screenshot")
    return { text: new TextDecoder().decode(bytes) };
  if (
    bytes.length < 24 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)
  )
    return null;
  const view = new DataView(bytes.buffer),
    width = view.getUint32(16),
    height = view.getUint32(20);
  if (!width || !height || width > 32768 || height > 32768) return null;
  // Conservative patch bound covers supported vision routes; actual usage is
  // still charged by the shared ledger, including failed/repaired turns.
  const token_bound = 2048 + Math.ceil(width / 28) * Math.ceil(height / 28) * 4;
  return {
    image: {
      data: btoa(
        Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""),
      ),
      media_type: "image/png",
      token_bound,
    },
  };
}
export async function pruneEvidence(env: Env, tenant: string, review: string) {
  check(
    await env.DB.prepare("SELECT 1 FROM reviews WHERE id=? AND tenant=?")
      .bind(review, tenant)
      .first(),
    "evidence_not_found",
    404,
  );
  // Fence uploads before enumerating objects; in-flight writes cannot publish.
  await env.DB.prepare("UPDATE qa_runs SET evidence_pruned=1 WHERE review_id=?")
    .bind(review)
    .run();
  while (true) {
    const rows = await env.DB.prepare(
      "SELECT * FROM qa_evidence WHERE tenant=? AND review_id=? LIMIT 100",
    )
      .bind(tenant, review)
      .all<Row>();
    if (!rows.results.length) break;
    for (const row of rows.results) await retire(env, row);
  }
  await collectGarbage(env, tenant, review);
}

/** No bucket-management capability is needed. Each row keeps the immutable
 * expiry selected by its run. Read URLs already stop working at that instant;
 * bounded minute sweeps remove bytes and retry failed or in-flight deletions. */
export async function expireQaEvidence(
  env: Env,
  now = Date.now(),
  limit = 200,
) {
  invariant(
    Number.isSafeInteger(limit) && limit > 0 && limit <= 200,
    "invalid evidence sweep limit",
  );
  const expired = await env.DB.prepare(
    "SELECT * FROM qa_evidence WHERE expires_at<=? ORDER BY expires_at,run_id,id LIMIT ?",
  )
    .bind(now, limit)
    .all<Row>();
  for (const row of expired.results) await retire(env, row);
  const garbage = await env.DB.prepare(
    "SELECT object_key,pending FROM qa_evidence_garbage WHERE next_attempt_at<=? ORDER BY next_attempt_at,object_key LIMIT ?",
  )
    .bind(now, limit)
    .all<{ object_key: string; pending: number }>();
  const keys = garbage.results.map((row) => row.object_key);
  let deleted = 0,
    retry = 0;
  if (keys.length) {
    // Claim the next attempt before touching R2. A crash or failed delete
    // leaves every key available to the next minute's sweep.
    await env.DB.prepare(
      "UPDATE qa_evidence_garbage SET next_attempt_at=? WHERE object_key IN (SELECT value FROM json_each(?))",
    )
      .bind(now + 60000, JSON.stringify(keys))
      .run();
    try {
      await env.ARTIFACTS.delete(keys);
      await env.DB.prepare(
        "DELETE FROM qa_evidence_garbage WHERE object_key IN (SELECT value FROM json_each(?)) AND pending=0",
      )
        .bind(JSON.stringify(keys))
        .run();
      deleted = keys.length;
    } catch {
      retry = keys.length;
    }
  }
  return { retired: expired.results.length, deleted, retry };
}
const routes = new Hono<{ Bindings: Env }>();
routes.onError((error, c) => {
  const auth = /unauthorized/.test(error.message);
  return c.json(
    {
      error:
        error instanceof EvidenceError
          ? error.reason
          : auth
            ? "unauthorized"
            : "evidence_store_unavailable",
    },
    error instanceof EvidenceError ? error.status : auth ? 401 : 503,
  );
});
routes.put("/runs/:run/evidence/:id", async (c) =>
  c.json(
    await putEvidence(c.req.raw, c.env, c.req.param("run"), c.req.param("id")),
  ),
);
routes.get("/runs/:run/evidence", async (c) =>
  c.json(await evidenceManifest(c.req.raw, c.env, c.req.param("run"))),
);
routes.put("/runs/:run/evidence", async (c) => {
  const run = await runFor(c.req.raw, c.env, c.req.param("run"));
  const reader = c.req.raw.body?.getReader();
  check(reader);
  let text = "",
    size = 0;
  const decoder = new TextDecoder();
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      check(size <= 1024 * 1024);
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    await reader.cancel();
    throw error;
  } finally {
    reader.releaseLock();
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new EvidenceError("invalid_evidence_manifest");
  }
  check(
    value?.version === 1 && Array.isArray(value.notes),
    "invalid_evidence_manifest",
  );
  const now = Date.now();
  const result = await c.env.DB.prepare(
    `INSERT INTO qa_evidence_manifests(run_id,notes,updated_at) SELECT q.id,?,? FROM qa_runs q JOIN reviews r ON r.id=q.review_id JOIN jobs j ON j.id=q.job_id AND j.attempt=q.attempt
    WHERE q.id=? AND q.generation=? AND q.state='running' AND q.evidence_pruned=0 AND q.deadline>? AND r.cancelled=0 AND r.deadline>? AND j.status='leased' AND j.lease_until>?
    ON CONFLICT(run_id) DO UPDATE SET notes=excluded.notes,updated_at=excluded.updated_at RETURNING run_id`,
  )
    .bind(
      JSON.stringify(scrub(value.notes)),
      now,
      run.id,
      run.generation,
      now,
      now,
      now,
    )
    .all();
  check(result.results.length, "unauthorized stopped evidence manifest", 401);
  return c.json({ stored: true });
});
routes.get("/evidence/:run/:id", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT * FROM qa_evidence WHERE run_id=? AND id=? AND state='stored'",
  )
    .bind(c.req.param("run"), c.req.param("id"))
    .first<Row>();
  check(row, "evidence_not_found", 404);
  const expires = Number(c.req.query("expires"));
  check(
    Number.isSafeInteger(expires) &&
      expires > Date.now() &&
      expires <= row.expires_at,
    "evidence_expired",
    410,
  );
  const expected = await sign(
    c.env.RUNNER_SECRET,
    canonical({
      tenant: row.tenant,
      run: row.run_id,
      id: row.id,
      expires,
      content_hash: JSON.parse(row.descriptor).content_hash,
    }),
  );
  check(
    equal(expected, c.req.query("signature") || ""),
    "unauthorized evidence link",
    401,
  );
  const object = await c.env.ARTIFACTS.get(row.object_key);
  check(object, "evidence_expired", 410);
  return new Response(object.body, {
    headers: {
      "content-type": formats[JSON.parse(row.descriptor).kind][1],
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
    },
  });
});
routes.delete("/reviews/:review/evidence", async (c) => {
  const tenant = await authenticate(c.req.raw, c.env, [
    "qa:evidence",
    "reviews:write",
  ]);
  await pruneEvidence(c.env, tenant, c.req.param("review"));
  return c.json({ pruned: true });
});
export { routes as qaEvidenceRoutes };

/** Refresh display links from authenticated database ownership, never from a
 * runner's URL or storage key. Expired cached metadata remains inspectable. */
export async function refreshQaReportLinks(
  env: Env,
  tenant: string,
  review: string,
  report: any,
  origin: string,
) {
  if (report.qa?.evidence?.storage !== "hosted") return;
  const rows = await env.DB.prepare(
    "SELECT e.*,q.version AS run_version FROM qa_evidence e LEFT JOIN qa_runs q ON q.id=e.run_id WHERE e.tenant=? AND e.review_id=? AND e.state='stored' ORDER BY e.created_at,e.run_id,e.id",
  )
    .bind(tenant, review)
    .all<Row & { run_version: string | null }>();
  const artifacts = new Map<string, any>(
    (report.qa.evidence.artifacts ?? []).map((artifact: any) => [
      artifact.id,
      {
        id: artifact.id,
        ...(artifact.kind ? { kind: artifact.kind } : {}),
        ...(Number.isSafeInteger(artifact.expires_at)
          ? { expires_at: artifact.expires_at }
          : {}),
        ...(artifact.expires_at <= Date.now()
          ? { expired: true }
          : { unavailable: true }),
      },
    ]),
  );
  for (const row of rows.results) {
    const meta = JSON.parse(row.descriptor) as Descriptor;
    // Where the artifact belongs (journey, step, cell and the base or head
    // run), so a client can show a step's screenshot and its base.
    // Ids are content addressed: a base screenshot equal to its head one
    // keeps an entry of its own.
    const base = row.run_version === "base";
    artifacts.set(base ? `base:${row.id}` : row.id, {
      id: row.id,
      kind: meta.kind,
      journey: meta.journey,
      ...(Number.isSafeInteger(meta.step) ? { step: meta.step } : {}),
      cell: meta.cell,
      ...(row.run_version === "base" || row.run_version === "head"
        ? { version: row.run_version }
        : {}),
      ...(await link(env, row, origin)),
    });
  }
  // A report entry that only a base run stored is replaced by its base entry,
  // not kept as an unavailable head artifact too.
  const head = new Set(
    rows.results.filter((row) => row.run_version !== "base").map((row) => row.id),
  );
  for (const row of rows.results)
    if (row.run_version === "base" && !head.has(row.id)) artifacts.delete(row.id);
  report.qa.evidence.artifacts = [...artifacts.values()];
}

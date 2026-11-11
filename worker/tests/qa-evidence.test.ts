import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import worker, { app } from "../src/index";
import { createQaJob } from "../src/qa-jobs";
import { dispatchQaReplay } from "../src/qa-replay";
import {
  putEvidence,
  readQaEvidence,
  expireQaEvidence,
} from "../src/qa-evidence";
import { hash, canonical } from "../src/validation";
import type { Env } from "../src/types";
import { allMigrations, submission } from "./fixtures";
import { Store } from "../src/storage";
import { HostedEvidenceTransport } from "../../crates/rio-qa/controller/src/hosted-evidence-transport.mjs";
import {
  EvidenceWriter,
  HostedEvidenceSink,
} from "../../crates/rio-qa/controller/src/evidence.mjs";

const runtime = { ...env, JOBS: { send: async () => {} } } as unknown as Env;
const owner = "test-owner-token-at-least-32-characters",
  runner = "test-runner-secret-at-least-32-characters";
const bytes = (value: string) => new TextEncoder().encode(value);
const cell = { viewport: "mobile", color_scheme: "light" };
async function setup(
  limit = 100000000,
  days = 30,
  review = "review",
  job = "job",
) {
  const submissionValue = submission();
  submissionValue.snapshot_id = "b".repeat(64);
  submissionValue.profile.budget.fast.qa = { evidence_bytes: limit };
  await runtime.DB.prepare(
    "INSERT INTO reviews(id,tenant,submission_key,status,created_at,token_limit,deadline) VALUES(?,'owner','unused','running',?,10000,?)",
  )
    .bind(review, Date.now(), Date.now() + 3600000)
    .run();
  await createQaJob(runtime, {
    review,
    job,
    step: "qa",
    submission: submissionValue,
    options: {},
  });
  const claim = await (
    await api("/v1/runner/claim", runner, "POST")
  ).json<any>();
  const chain = ["checkout"];
  const config = {
    cells: [
      {
        ...cell,
        chain,
        id: hash(canonical({ ...cell, chain, version: "head" })),
      },
    ],
    seed_fingerprints: [],
    seed_max_size: 1024,
    evidence_retention_days: days,
  };
  expect(
    (
      await api(
        `/v1/runner/${review}/${job}/1/qa-configure`,
        claim.token,
        "POST",
        config,
      )
    ).status,
  ).toBe(200);
  return claim;
}
function api(path: string, token = owner, method = "GET", body?: any) {
  return app.request(
    "https://rio.test" + path,
    {
      method,
      headers: { authorization: "Bearer " + token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    runtime,
  );
}
function metadata(
  data: Uint8Array,
  kind = "dom",
  step: number | undefined = 1,
) {
  const content_hash = bytesToHex(blake3(data));
  const extension =
    (
      {
        video: "webm",
        trace: "zip",
        replay: "jsonl",
        screenshot: "png",
      } as Record<string, string>
    )[kind] ?? "json";
  const key = `checkout/mobile-light/${step === undefined ? "cell" : `step-${String(step).padStart(4, "0")}`}-${kind}-${content_hash.slice(0, 16)}.${extension}`;
  return {
    id: hash(JSON.stringify([key, content_hash])),
    content_hash,
    bytes: data.length,
    kind,
    journey: "checkout",
    ...(step === undefined ? {} : { step }),
    cell,
    sanitized: true,
  };
}
function uploadRequest(claim: any, data: Uint8Array, meta = metadata(data)) {
  return new Request(
    `https://rio.test/v1/qa/runs/${claim.qa.run_id}/evidence/${meta.id}`,
    {
      method: "PUT",
      headers: {
        authorization: "Bearer " + claim.qa.capability,
        "rio-evidence-metadata": JSON.stringify(meta),
      },
      body: data,
    },
  );
}
async function send(
  claim: any,
  data: Uint8Array,
  meta = metadata(data),
  e = runtime,
) {
  return app.fetch(uploadRequest(claim, data, meta), e);
}
const objects = async () =>
  (await runtime.ARTIFACTS.list({ prefix: "qa/" })).objects.map(
    (object) => object.key,
  );
beforeAll(async () => {
  await applyD1Migrations(runtime.DB, allMigrations);
});
beforeEach(async () => {
  await runtime.DB.batch(
    [
      "qa_evidence",
      "qa_evidence_manifests",
      "qa_evidence_garbage",
      "qa_seed_leases",
      "qa_model_usage",
      "qa_cells",
      "qa_runs",
      "jobs",
      "events",
      "reviews",
    ].map((table) => runtime.DB.prepare(`DELETE FROM ${table}`)),
  );
  const keys = await objects();
  if (keys.length) await runtime.ARTIFACTS.delete(keys);
});

it("streams a multipart artifact, checks its hash, and signs read access to exactly one object", async () => {
  const claim = await setup(),
    data = new Uint8Array(8 * 1024 ** 2 + 19).fill(7);
  const result = await putEvidence(
    uploadRequest(claim, data),
    runtime,
    claim.qa.run_id,
    metadata(data).id,
  );
  expect(result.bytes).toBe(data.length);
  expect(result.storage).toBe("hosted");
  const response = await app.request(result.link!, {}, runtime);
  expect(response.status).toBe(200);
  // Compared by digest: a deep equality of 8 MB arrays nears the runtime's heap limit.
  const served = new Uint8Array(await response.arrayBuffer());
  expect(served.length).toBe(data.length);
  expect(bytesToHex(blake3(served))).toBe(bytesToHex(blake3(data)));
  const other = bytes("different");
  const otherResult = await (
    await send(claim, other, metadata(other, "dom", 2))
  ).json<any>();
  const tampered = new URL(result.link!);
  tampered.pathname = new URL(otherResult.link).pathname;
  expect((await app.request(tampered.href, {}, runtime)).status).toBe(401);
  tampered.pathname = new URL(result.link!).pathname;
  tampered.searchParams.set("expires", "1");
  expect((await app.request(tampered.href, {}, runtime)).status).toBe(410);
  const manifest = await (
    await api(`/v1/qa/runs/${claim.qa.run_id}/evidence`)
  ).json<any>();
  expect(manifest.artifacts).toHaveLength(2);
  expect(manifest.artifacts[0].expires_at - Date.now()).toBeGreaterThan(
    29 * 86400000,
  );
}, 120000);

it("round trips the controller transport and preserves stored artifacts after cancellation", async () => {
  const claim = await setup();
  const transport = new HostedEvidenceTransport({
    endpoint: "https://rio.test",
    tenant: "owner",
    reviewId: "review",
    runId: claim.qa.run_id,
    capability: claim.qa.capability,
    fetchImpl: (url: string, init: RequestInit) => {
      expect(init.redirect).toBe("error");
      return app.request(url, { ...init, redirect: "manual" }, runtime);
    },
  });
  const data = bytes('{"headers":{"authorization":"[redacted]"}}'),
    meta = metadata(data);
  const key = `qa/owner/review/${claim.qa.run_id}/checkout/mobile-light/step-0001-dom-${meta.content_hash.slice(0, 16)}.json`;
  const artifact = await transport.upload(key, data, meta);
  await transport.upload(
    `qa/owner/review/${claim.qa.run_id}/manifest.json`,
    bytes(JSON.stringify({ version: 1, notes: [] })),
  );
  expect(artifact.link).toBeTypeOf("string");
  expect(
    await (await app.request(artifact.link, {}, runtime)).text(),
  ).toContain("[redacted]");
  await runtime.DB.prepare("UPDATE reviews SET cancelled=1").run();
  await expect(transport.upload(key, data, meta)).rejects.toThrow(
    "upload failed",
  );
  const manifest = await (
    await api(`/v1/qa/runs/${claim.qa.run_id}/evidence`)
  ).json<any>();
  expect(manifest.artifacts.map((row: any) => row.id)).toEqual([artifact.id]);
  expect((await app.request(artifact.link, {}, runtime)).status).toBe(200);
});

it("makes uploads idempotent and enforces the shared quota while retaining mandatory evidence", async () => {
  const claim = await setup(10),
    data = bytes("mandatory evidence");
  expect((await send(claim, data)).status).toBe(200);
  expect((await send(claim, data)).status).toBe(200);
  expect((await objects()).length).toBe(1);
  expect(
    await runtime.DB.prepare("SELECT evidence_used FROM qa_runs").first(),
  ).toEqual({ evidence_used: data.length });
  expect((await send(claim, data, metadata(data, "video"))).status).toBe(429);
  expect((await send(claim, data, metadata(data, "dom", 2))).status).toBe(200);
  const manifest = await (
    await api(`/v1/qa/runs/${claim.qa.run_id}/evidence`)
  ).json<any>();
  expect(manifest).toMatchObject({
    quota_reached: true,
    bytes: 2 * data.length,
  });
});

it("rejects corrupt uploads and evidence outside the configured cell", async () => {
  const claim = await setup(),
    data = bytes("correct");
  expect((await send(claim, bytes("damaged"), metadata(data))).status).toBe(
    400,
  );
  expect((await objects()).length).toBe(0);
  expect(
    await runtime.DB.prepare("SELECT evidence_used FROM qa_runs").first(),
  ).toEqual({ evidence_used: 0 });
  const outside = { ...metadata(data), journey: "admin" };
  expect((await send(claim, data, outside)).status).toBe(401);
  const unsafe = { ...metadata(data), sanitized: false };
  expect((await send(claim, data, unsafe)).status).toBe(400);
  expect(
    (await runtime.DB.prepare("SELECT * FROM qa_evidence").all()).results,
  ).toEqual([]);
});

it("fences an upload cancelled after R2 completion and removes its unpublished object", async () => {
  const claim = await setup(),
    data = bytes("late upload");
  const bucket = new Proxy(runtime.ARTIFACTS, {
    get(target, property) {
      if (property === "createMultipartUpload")
        return async (...args: any[]) => {
          const multipart = await (target.createMultipartUpload as any)(
            ...args,
          );
          return {
            ...multipart,
            uploadPart: multipart.uploadPart.bind(multipart),
            abort: multipart.abort.bind(multipart),
            complete: async (parts: any) => {
              const result = await multipart.complete(parts);
              await runtime.DB.prepare("UPDATE reviews SET cancelled=1").run();
              return result;
            },
          };
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  expect(
    (await send(claim, data, metadata(data), { ...runtime, ARTIFACTS: bucket }))
      .status,
  ).toBe(401);
  expect((await objects()).length).toBe(0);
  expect(
    (await runtime.DB.prepare("SELECT * FROM qa_evidence").all()).results,
  ).toEqual([]);
});

it("prunes one review, revokes links, fences future uploads, and denies controller pruning", async () => {
  const claim = await setup(),
    data = bytes("stored");
  const receipt = await (await send(claim, data)).json<any>();
  expect(
    (await api("/v1/qa/reviews/review/evidence", claim.qa.capability, "DELETE"))
      .status,
  ).toBe(401);
  expect(
    (await api("/v1/qa/reviews/review/evidence", owner, "DELETE")).status,
  ).toBe(200);
  expect((await objects()).length).toBe(0);
  expect((await app.request(receipt.link, {}, runtime)).status).toBe(404);
  expect((await send(claim, data)).status).toBe(401);
  expect(
    await (await api(`/v1/qa/runs/${claim.qa.run_id}/evidence`)).json(),
  ).toMatchObject({ pruned: true, artifacts: [] });
});

it("cleans a physical object that completes after pruning began", async () => {
  const claim = await setup(),
    data = bytes("late multipart completion");
  const bucket = new Proxy(runtime.ARTIFACTS, {
    get(target, property) {
      if (property === "createMultipartUpload")
        return async (...args: any[]) => {
          const multipart = await (target.createMultipartUpload as any)(
            ...args,
          );
          return {
            ...multipart,
            uploadPart: multipart.uploadPart.bind(multipart),
            abort: multipart.abort.bind(multipart),
            complete: async (parts: any) => {
              expect(
                (await api("/v1/qa/reviews/review/evidence", owner, "DELETE"))
                  .status,
              ).toBe(200);
              return multipart.complete(parts);
            },
          };
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  expect(
    (await send(claim, data, metadata(data), { ...runtime, ARTIFACTS: bucket }))
      .status,
  ).toBe(401);
  expect(await objects()).toEqual([]);
  expect(
    (await runtime.DB.prepare("SELECT * FROM qa_evidence_garbage").all())
      .results,
  ).toEqual([]);
});

it("keeps a deletion ledger when storage is unavailable and retries on the next prune", async () => {
  const claim = await setup(),
    data = bytes("stored");
  expect((await send(claim, data)).status).toBe(200);
  const bucket = new Proxy(runtime.ARTIFACTS, {
    get(target, property) {
      if (property === "delete")
        return async () => {
          throw new Error("storage unavailable");
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const response = await app.request(
    "https://rio.test/v1/qa/reviews/review/evidence",
    { method: "DELETE", headers: { authorization: "Bearer " + owner } },
    { ...runtime, ARTIFACTS: bucket },
  );
  expect(response.status).toBe(503);
  expect((await objects()).length).toBe(1);
  expect(
    (await runtime.DB.prepare("SELECT * FROM qa_evidence_garbage").all())
      .results,
  ).toHaveLength(1);
  expect(
    (await api("/v1/qa/reviews/review/evidence", owner, "DELETE")).status,
  ).toBe(200);
  expect(await objects()).toEqual([]);
});

it("reclaim releases abandoned reservations and fences the delayed upload", async () => {
  const claim = await setup(),
    data = bytes("runner replaced");
  let replacement: any;
  const bucket = new Proxy(runtime.ARTIFACTS, {
    get(target, property) {
      if (property === "createMultipartUpload")
        return async (...args: any[]) => {
          const multipart = await (target.createMultipartUpload as any)(
            ...args,
          );
          return {
            ...multipart,
            uploadPart: multipart.uploadPart.bind(multipart),
            abort: multipart.abort.bind(multipart),
            complete: async (parts: any) => {
              await runtime.DB.prepare("UPDATE jobs SET lease_until=0").run();
              replacement = await (
                await api("/v1/runner/claim", runner, "POST")
              ).json<any>();
              expect(
                await runtime.DB.prepare(
                  "SELECT evidence_used FROM qa_runs",
                ).first(),
              ).toEqual({ evidence_used: 0 });
              expect((await send(replacement, data)).status).toBe(200);
              return multipart.complete(parts);
            },
          };
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  expect(
    (await send(claim, data, metadata(data), { ...runtime, ARTIFACTS: bucket }))
      .status,
  ).toBe(401);
  expect((await objects()).length).toBe(1);
  expect((await send(replacement, data)).status).toBe(200);
  expect((await objects()).length).toBe(1);
});

it("honors custom link retention, labels expired artifacts and isolates authenticated tenants", async () => {
  const claim = await setup(100000, 2),
    data = bytes("retained for two days");
  const receipt = await (await send(claim, data)).json<any>();
  expect(receipt.expires_at - Date.now()).toBeGreaterThan(1.9 * 86400000);
  expect(receipt.expires_at - Date.now()).toBeLessThanOrEqual(2 * 86400000);
  expect(receipt.link_expires_at).toBe(receipt.expires_at);
  const other = "other-owner-token-at-least-32-characters";
  await runtime.DB.prepare(
    "INSERT INTO api_tokens(hash,tenant,scope,expires_at) VALUES(?,'other','reviews:read,reviews:write',?)",
  )
    .bind(hash(other), Date.now() + 100000)
    .run();
  expect(
    (await api(`/v1/qa/runs/${claim.qa.run_id}/evidence`, other)).status,
  ).toBe(404);
  expect(
    (await api("/v1/qa/reviews/review/evidence", other, "DELETE")).status,
  ).toBe(404);
  await runtime.DB.prepare("UPDATE qa_evidence SET expires_at=?")
    .bind(Date.now() - 1)
    .run();
  const manifest = await (
    await api(`/v1/qa/runs/${claim.qa.run_id}/evidence`)
  ).json<any>();
  expect(manifest.artifacts[0]).toMatchObject({ expired: true });
  expect(manifest.artifacts[0]).not.toHaveProperty("link");
  expect((await app.request(receipt.link, {}, runtime)).status).toBe(410);
});

it("scheduled deletion honors each run's own retention and leaves future evidence available", async () => {
  const short = await setup(100000, 2),
    long = await setup(100000, 30, "long-review", "long-job");
  const first = await (await send(short, bytes("two days"))).json<any>();
  const second = await (await send(long, bytes("thirty days"))).json<any>();
  expect(second.expires_at - first.expires_at).toBeGreaterThan(27 * 86400000);
  expect(await expireQaEvidence(runtime, first.expires_at)).toEqual({
    retired: 1,
    deleted: 1,
    retry: 0,
  });
  expect(await objects()).toHaveLength(1);
  expect((await app.request(first.link, {}, runtime)).status).toBe(404);
  expect((await app.request(second.link, {}, runtime)).status).toBe(200);
  await runtime.DB.prepare("UPDATE qa_evidence SET expires_at=?")
    .bind(Date.now() - 1)
    .run();
  await worker.scheduled({} as ScheduledController, runtime);
  expect(await objects()).toEqual([]);
});

it("report downloads refresh only owned evidence links and keep expired cached artifacts labeled after deletion", async () => {
  const claim = await setup(),
    receipt = await (await send(claim, bytes("report evidence"))).json<any>();
  const key = "reviews/review/report.json",
    store = new Store(runtime);
  const report = {
    qa: {
      evidence: {
        storage: "hosted",
        expires_at: null,
        bytes: 15,
        artifacts: [
          {
            id: receipt.id,
            expires_at: receipt.expires_at,
            link: "https://untrusted.example/fake",
          },
          { id: "foreign", link: "https://untrusted.example/foreign" },
        ],
      },
    },
  };
  await store.put(key, report);
  await runtime.DB.prepare("UPDATE reviews SET report_key=? WHERE id='review'")
    .bind(key)
    .run();
  const response = await api("/v1/reviews/review/report");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const fresh = await response.json<any>();
  const owned = fresh.qa.evidence.artifacts.find(
    (row: any) => row.id === receipt.id,
  );
  expect(owned.link).not.toContain("untrusted");
  // Where it belongs, so a client can show a step's screenshot.
  expect(owned).toMatchObject({
    journey: expect.any(String),
    cell: {
      viewport: expect.any(String),
      color_scheme: expect.any(String),
    },
    version: "head",
  });
  expect((await app.request(owned.link, {}, runtime)).status).toBe(200);
  // A base run that stored the same content (so the same id) keeps an entry
  // of its own beside the head's.
  const insert = (table: string, row: Record<string, unknown>) =>
    runtime.DB.prepare(
      `INSERT INTO ${table}(${Object.keys(row).join(",")}) VALUES(${Object.keys(row)
        .map(() => "?")
        .join(",")})`,
    )
      .bind(...Object.values(row))
      .run();
  const headRun: any = await runtime.DB.prepare("SELECT * FROM qa_runs").first();
  const headEvidence: any = await runtime.DB.prepare(
    "SELECT * FROM qa_evidence WHERE id=?",
  )
    .bind(receipt.id)
    .first();
  await insert("qa_runs", {
    ...headRun,
    id: "base-run",
    attempt: headRun.attempt + 100,
    version: "base",
    token_hash: null,
  });
  await insert("qa_evidence", {
    ...headEvidence,
    run_id: "base-run",
    object_key: `${headEvidence.object_key}-base`,
  });
  const artifactsNow = async () =>
    (await (await api("/v1/reviews/review/report")).json<any>()).qa.evidence.artifacts.filter(
      (row: any) => row.id === receipt.id,
    );
  const both = await artifactsNow();
  expect(both.map((row: any) => row.version).sort()).toEqual(["base", "head"]);
  expect(both.every((row: any) => row.link)).toBe(true);
  // Only the base run stored it: one base entry, no stale head placeholder.
  await runtime.DB.prepare("DELETE FROM qa_evidence WHERE run_id=?")
    .bind(headRun.id)
    .run();
  const baseOnly = await artifactsNow();
  expect(baseOnly).toHaveLength(1);
  expect(baseOnly[0]).toMatchObject({ version: "base" });
  await runtime.DB.prepare("DELETE FROM qa_evidence WHERE run_id='base-run'").run();
  await runtime.DB.prepare("DELETE FROM qa_runs WHERE id='base-run'").run();
  await insert("qa_evidence", headEvidence);
  expect(
    fresh.qa.evidence.artifacts.find((row: any) => row.id === "foreign"),
  ).toEqual({ id: "foreign", unavailable: true });
  report.qa.evidence.artifacts[0].expires_at = 1;
  await store.put(key, report);
  await runtime.DB.prepare("UPDATE qa_evidence SET expires_at=1").run();
  await expireQaEvidence(runtime);
  const expired = await (await api("/v1/reviews/review/report")).json<any>();
  expect(expired.qa.evidence.artifacts[0]).toEqual({
    id: receipt.id,
    expires_at: 1,
    expired: true,
  });
  expect(JSON.stringify(expired)).not.toContain("untrusted.example");
});

it("retention retries failed deletion and rotates pending tombstones without starving other keys", async () => {
  const claim = await setup(),
    receipt = await (await send(claim, bytes("expired"))).json<any>();
  const bucket = new Proxy(runtime.ARTIFACTS, {
    get(target, property) {
      if (property === "delete")
        return async () => {
          throw new Error("temporary failure");
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  expect(
    await expireQaEvidence(
      { ...runtime, ARTIFACTS: bucket },
      receipt.expires_at,
    ),
  ).toEqual({ retired: 1, deleted: 0, retry: 1 });
  expect(await objects()).toHaveLength(1);
  expect((await app.request(receipt.link, {}, runtime)).status).toBe(404);
  expect(
    await expireQaEvidence(runtime, receipt.expires_at + 60000),
  ).toMatchObject({ deleted: 1 });
  expect(await objects()).toEqual([]);
  await runtime.DB.prepare(
    "INSERT INTO qa_evidence_garbage(object_key,tenant,review_id,pending) VALUES('qa/a','owner','review',1),('qa/b','owner','review',0)",
  ).run();
  await expireQaEvidence(runtime, Date.now(), 1);
  await expireQaEvidence(runtime, Date.now(), 1);
  expect(
    (
      await runtime.DB.prepare(
        "SELECT object_key FROM qa_evidence_garbage ORDER BY object_key",
      ).all()
    ).results,
  ).toEqual([{ object_key: "qa/a" }]);
});

it("an upload that crosses expiry cannot publish after scheduled deletion", async () => {
  const claim = await setup(),
    data = bytes("late expired upload");
  const bucket = new Proxy(runtime.ARTIFACTS, {
    get(target, property) {
      if (property === "createMultipartUpload")
        return async (...args: any[]) => {
          const multipart = await (target.createMultipartUpload as any)(
            ...args,
          );
          return {
            uploadPart: multipart.uploadPart.bind(multipart),
            abort: multipart.abort.bind(multipart),
            complete: async (parts: any) => {
              await runtime.DB.prepare("UPDATE qa_evidence SET expires_at=?")
                .bind(Date.now() - 1)
                .run();
              await expireQaEvidence(runtime);
              return multipart.complete(parts);
            },
          };
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  expect(
    (await send(claim, data, metadata(data), { ...runtime, ARTIFACTS: bucket }))
      .status,
  ).toBe(401);
  expect(await objects()).toEqual([]);
  expect(
    (await runtime.DB.prepare("SELECT * FROM qa_evidence").all()).results,
  ).toEqual([]);
});

it("prunes a review with more than one page of pending deletion records", async () => {
  await setup();
  await runtime.DB.prepare(
    "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1005) INSERT INTO qa_evidence_garbage(object_key,tenant,review_id) SELECT 'qa/owner/review/old/'||i,'owner','review' FROM n",
  ).run();
  expect(
    (await api("/v1/qa/reviews/review/evidence", owner, "DELETE")).status,
  ).toBe(200);
  expect(
    (await runtime.DB.prepare("SELECT * FROM qa_evidence_garbage").all())
      .results,
  ).toEqual([]);
});

it("retains a tombstone when multipart completion and abort both have uncertain outcomes", async () => {
  const claim = await setup(),
    data = bytes("uncertain upload");
  let key = "";
  const bucket = new Proxy(runtime.ARTIFACTS, {
    get(target, property) {
      if (property === "createMultipartUpload")
        return async (objectKey: string) => {
          key = objectKey;
          return {
            uploadPart: async () => ({ partNumber: 1, etag: "part" }),
            complete: async () => {
              throw new Error("connection interrupted");
            },
            abort: async () => {
              throw new Error("connection interrupted");
            },
          };
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  expect(
    (await send(claim, data, metadata(data), { ...runtime, ARTIFACTS: bucket }))
      .status,
  ).toBe(503);
  expect(
    (await runtime.DB.prepare("SELECT pending FROM qa_evidence_garbage").all())
      .results,
  ).toEqual([{ pending: 1 }]);
  await runtime.ARTIFACTS.put(key, data); // A delayed storage operation finishes after the failed request.
  expect(
    (await api("/v1/qa/reviews/review/evidence", owner, "DELETE")).status,
  ).toBe(200);
  expect(await objects()).toEqual([]);
});

it("verifier reads only stored, unexpired, same-run artifact identities", async () => {
  const claim = await setup(),
    data = bytes('{"text":"confirmation"}'),
    meta = metadata(data);
  expect((await send(claim, data, meta)).status).toBe(200);
  const read = (tenant: string, review: string, run: string, artifact = meta) =>
    readQaEvidence(runtime, tenant, review, run, artifact as any);
  expect(await read("owner", "review", claim.qa.run_id)).toEqual({
    text: '{"text":"confirmation"}',
  });
  expect(await read("different", "review", claim.qa.run_id)).toBeNull();
  expect(await read("owner", "different", claim.qa.run_id)).toBeNull();
  expect(await read("owner", "review", "different")).toBeNull();
  expect(
    await read("owner", "review", claim.qa.run_id, { ...meta, step: 99 }),
  ).toBeNull();
  await runtime.DB.prepare("UPDATE qa_evidence SET expires_at=? WHERE id=?")
    .bind(Date.now() - 1, meta.id)
    .run();
  expect(await read("owner", "review", claim.qa.run_id)).toBeNull();
});

it("downloads hosted QA records through the authenticated audit without artifact bodies", async () => {
  await setup();
  const records = {
    "plan.json": { selected: { checkout: ["explicit"] } },
    "outcomes.json": [{ journey: "checkout", cell, outcome: "passed" }],
    "manifest.json": {
      artifacts: [
        {
          id: "shot",
          key: "qa/owner/review/run/shot.png",
          expires_at: 1800000000000,
        },
      ],
    },
    "recommendations.json": [
      { id: "candidate", verification_status: "rejected" },
    ],
    "assessment.json": [],
  };
  for (const [name, value] of Object.entries(records))
    await new Store(runtime).put(`reviews/review/qa/${name}`, value);
  await runtime.ARTIFACTS.put(
    "qa/owner/review/run/shot.png",
    new Uint8Array([1, 2, 3]),
  );
  await new Store(runtime).put("reviews/other/qa/plan.json", {
    private: "other tenant",
  });
  const response = await api("/v1/reviews/review/audit");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect((await response.json<any>()).qa_records).toEqual(records);
  expect(
    (await api("/v1/reviews/review/audit", "invalid-owner-token")).status,
  ).toBe(401);
});

it("dispatches a durable replay from owned events and retains artifacts with its hypothesis", async () => {
  const original = await setup();
  const events = [
    {
      version: 1,
      journey: "checkout",
      step: 1,
      sequence: 0,
      cell,
      action: "step_done",
      arguments: { outcome: "failed", evidence: [] },
    },
  ];
  const log = bytes(events.map((row) => JSON.stringify(row)).join("\n")),
    logMeta = metadata(log, "replay", undefined);
  expect((await send(original, log, logMeta)).status).toBe(200);
  await runtime.DB.prepare(
    "UPDATE jobs SET status='completed' WHERE id='job'",
  ).run();
  const input = submission();
  input.snapshot_id = "b".repeat(64);
  let dispatches = 0,
    waits = 0;
  const step = {
    do: async (_name: string, callback: () => Promise<unknown>) => {
      dispatches++;
      return callback();
    },
    waitForEvent: async (_name: string, options: any) => {
      waits++;
      const claim = await (
        await api("/v1/runner/claim", runner, "POST")
      ).json<any>();
      expect(options.type).toBe(`job-${claim.job.job_id}-1`);
      expect(claim.job.qa.replay.events).toEqual(events);
      expect(claim.job.qa.replay.source_run).toBe(original.qa.run_id);
      const configure = {
        cells: [
          {
            ...cell,
            chain: ["checkout"],
            id: hash(
              canonical({ ...cell, chain: ["checkout"], version: "head" }),
            ),
          },
        ],
        seed_fingerprints: [],
        seed_max_size: 1024,
      };
      expect(
        (
          await api(
            `/v1/runner/review/${claim.job.job_id}/1/qa-configure`,
            claim.token,
            "POST",
            configure,
          )
        ).status,
      ).toBe(200);
      const png = new Uint8Array(24);
      png.set([137, 80, 78, 71, 13, 10, 26, 10]);
      new DataView(png.buffer).setUint32(16, 1);
      new DataView(png.buffer).setUint32(20, 1);
      const artifacts = [];
      for (const [kind, content] of [
        ["screenshot", png],
        ["dom", bytes('{"disabled":true}')],
        ["trace", bytes("sanitized-trace")],
      ] as const) {
        const meta = metadata(content, kind, kind === "trace" ? undefined : 1);
        expect((await send(claim, content, meta)).status).toBe(200);
        artifacts.push(meta);
      }
      const result = {
        job_id: claim.job.job_id,
        attempt: 1,
        version: "head",
        exit_code: 0,
        artifact: {
          outcome: "recurred",
          cell,
          until: { journey: "checkout", step: 1 },
          evidence: { artifacts },
          wall_time_ms: 50,
        },
      };
      await new Store(runtime).put("test/replay-result.json", result);
      return { payload: { key: "test/replay-result.json" } };
    },
  };
  const result = await dispatchQaReplay({
    env: runtime,
    step: step as any,
    review: "review",
    tenant: "owner",
    qaStep: "qa",
    submission: input,
    options: {},
    candidate: {
      finding: { id: "e".repeat(64), qa: { journey: "checkout", step: 1 } },
      cell,
    } as any,
    version: "head",
    sourceRun: original.qa.run_id,
    original: { evidence: { artifacts: [logMeta] } },
  });
  expect(result.outcome).toBe("recurred");
  expect(result.evidence).toHaveLength(3);
  expect(dispatches).toBe(1);
  expect(waits).toBe(1);
  expect(Object.values(result.loaded!).some((data) => data.image)).toBe(true);
  const record = await new Store(runtime).get<any>(
    `reviews/review/qa/replays/${"e".repeat(64)}.json`,
  );
  expect(record.loaded).toBeUndefined();
  expect(record.manifest.artifacts).toHaveLength(3);
  const denied = await dispatchQaReplay({
    env: runtime,
    step: step as any,
    review: "review",
    tenant: "someone-else",
    qaStep: "qa",
    submission: input,
    options: {},
    candidate: {
      finding: { id: "f".repeat(64), qa: { journey: "checkout", step: 1 } },
      cell,
    } as any,
    version: "head",
    sourceRun: original.qa.run_id,
    original: { evidence: { artifacts: [logMeta] } },
  });
  expect(denied.outcome).toBe("prerequisites_failed");
  expect(dispatches).toBe(1);
});

import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Store } from "../src/storage";
import { expireCouncil, recordCouncil } from "../src/council-audit";
import { EVIDENCE_RETENTION_MS } from "../src/cache";
import type { AuditEntry } from "../src/council-step";
import type { Env } from "../src/types";
import { allMigrations } from "./fixtures";

const runtime = env as Env;
beforeAll(async () => {
  await applyD1Migrations(runtime.DB, allMigrations);
});

const entry = (
  member: AuditEntry["member"],
  round: 1 | 2,
  at: number,
): AuditEntry => ({
  finding: "f".repeat(64),
  member,
  round,
  vendor: member === "tester" ? null : "openai",
  model: "openai/gpt-6.1",
  pack_hash: "a".repeat(64),
  pack_bytes: 2048,
  rendering_hash: "b".repeat(64),
  rendering_bytes: 1024,
  at,
  abstained: false,
  assessment_key: `reviews/r-audit/council/${"f".repeat(64)}/${member}-r${round}.json`,
});

describe("council audit", () => {
  it("records every pack sent by hash, logs no content, and keeps rows past retention", async () => {
    const now = Date.now();
    await runtime.DB.prepare(
      "INSERT INTO reviews(id,tenant,submission_key,status,created_at,token_limit,deadline) VALUES('r-audit','owner','s','complete',1,1,1)",
    ).run();
    const store = new Store(runtime);
    const old = now - EVIDENCE_RETENTION_MS - 1000;
    const audit = (
      ["skeptic", "code-owner", "maintainer", "tester"] as const
    ).flatMap((m) => [entry(m, 1, old), entry(m, 2, old)]);
    audit[7] = {
      ...audit[7],
      abstained: true,
      cause: "timeout",
      assessment_key: undefined,
    };
    for (const a of audit)
      if (a.assessment_key)
        await store.put(a.assessment_key, { assessment: "SECRET SOURCE TEXT" });
    await store.put(
      `reviews/r-audit/council/${"f".repeat(64)}/pack-${"a".repeat(64)}.json`,
      {
        files: "SECRET SOURCE TEXT",
      },
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await recordCouncil(runtime, store, "r-audit", "owner", audit);
    const logged = log.mock.calls.flat().join("\n");
    log.mockRestore();
    expect(logged).toContain("a".repeat(12));
    expect(logged).not.toContain("SECRET");
    const stored = await store.get<{ entries: AuditEntry[] }>(
      "reviews/r-audit/council/audit.json",
    );
    expect(stored.entries).toHaveLength(8);
    const rows = await runtime.DB.prepare(
      "SELECT member,round,vendor,model,pack_hash,pack_bytes,abstained,cause FROM council_assessments WHERE review_id='r-audit' ORDER BY member,round",
    ).all<any>();
    expect(rows.results).toHaveLength(8);
    expect(
      rows.results.find((r) => r.member === "tester" && r.round === 1)!.vendor,
    ).toBeNull();
    expect(
      rows.results.find((r) => r.member === "tester" && r.round === 2),
    ).toMatchObject({
      abstained: 1,
      cause: "timeout",
    });
    // Retention deletes packs and assessments; the audit record and rows stay.
    expect(await expireCouncil(runtime, "owner", now)).toBe(1);
    const left = await runtime.ARTIFACTS.list({
      prefix: "reviews/r-audit/council/",
    });
    expect(left.objects.map((o) => o.key)).toEqual([
      "reviews/r-audit/council/audit.json",
    ]);
    const kept = await runtime.DB.prepare(
      "SELECT COUNT(*) AS n, COUNT(assessment_key) AS keys FROM council_assessments WHERE review_id='r-audit'",
    ).first<{ n: number; keys: number }>();
    expect(kept).toEqual({ n: 8, keys: 0 });
    expect(await expireCouncil(runtime, "owner", now)).toBe(0);
  });
});

describe("council retention when every call failed", () => {
  it("still expires the packs of a council with no stored assessment", async () => {
    const now = Date.now();
    await runtime.DB.prepare(
      "INSERT INTO reviews(id,tenant,submission_key,status,created_at,token_limit,deadline) VALUES('r-silent','owner','s','complete',1,1,1)",
    ).run();
    const store = new Store(runtime);
    const old = now - EVIDENCE_RETENTION_MS - 1000;
    const silent = (["skeptic", "tester"] as const).map((m) => ({
      ...entry(m, 1, old),
      abstained: true,
      cause: "timeout" as const,
      assessment_key: undefined,
    }));
    const pack = `reviews/r-silent/council/${"f".repeat(64)}/pack-${"a".repeat(64)}.json`;
    await store.put(pack, { files: "SOURCE" });
    await recordCouncil(runtime, store, "r-silent", "owner", silent);
    expect(await expireCouncil(runtime, "owner", now)).toBe(1);
    expect(
      (
        await runtime.ARTIFACTS.list({ prefix: "reviews/r-silent/council/" })
      ).objects.map((o) => o.key),
    ).toEqual(["reviews/r-silent/council/audit.json"]);
  });
});

describe("second review: council runner jobs expire with the packs", () => {
  it("deletes the payloads and results of the council's jobs", async () => {
    const now = Date.now();
    await runtime.DB.prepare(
      "INSERT INTO reviews(id,tenant,submission_key,status,created_at,token_limit,deadline) VALUES('r-jobs','owner','s','complete',1,1,1)",
    ).run();
    const store = new Store(runtime);
    const job = "c".repeat(32),
      other = "d".repeat(32);
    await store.put(`reviews/r-jobs/jobs/${job}/1/payload.json`, {
      model: { content: "PACK" },
    });
    await store.put(`reviews/r-jobs/jobs/${other}/1/payload.json`, {
      command: ["verifier"],
    });
    const old = now - EVIDENCE_RETENTION_MS - 1000;
    await recordCouncil(
      runtime,
      store,
      "r-jobs",
      "owner",
      [entry("skeptic", 1, old)],
      [job],
    );
    expect(await expireCouncil(runtime, "owner", now)).toBe(1);
    const left = (
      await runtime.ARTIFACTS.list({ prefix: "reviews/r-jobs/" })
    ).objects.map((o) => o.key);
    expect(left.sort()).toEqual([
      "reviews/r-jobs/council/audit.json",
      `reviews/r-jobs/jobs/${other}/1/payload.json`,
    ]);
  });
});

describe("round 8: the audit outlives job results", () => {
  it("answers the review audit after retention removed a job result", async () => {
    const { app } = await import("../src/index");
    await runtime.DB.prepare(
      "INSERT INTO reviews(id,tenant,submission_key,status,created_at,token_limit,deadline) VALUES('r-expired','owner','s','complete',1,1,1)",
    ).run();
    await runtime.DB.prepare(
      "INSERT INTO jobs(id,review_id,attempt,status,payload_key,result_key,created_at,kind) VALUES('e'||hex(randomblob(15)),'r-expired',1,'completed','p','reviews/r-expired/jobs/gone/1/result.json',1,'run')",
    ).run();
    const response = await app.request(
      "https://rio/v1/reviews/r-expired/audit",
      {
        headers: {
          authorization: "Bearer test-owner-token-at-least-32-characters",
        },
      },
      runtime,
    );
    expect(response.status).toBe(200);
    const audit = (await response.json()) as any;
    expect(audit.executions).toEqual([
      { job_id: expect.any(String), expired: true },
    ]);
  });
});

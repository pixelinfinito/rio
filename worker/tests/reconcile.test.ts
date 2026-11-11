import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { Store } from "../src/storage";
import { DEADLINE_GRACE_MS, reconcile, sweepReviews } from "../src/reconcile";
import { transferMs } from "../src/archive";
import { ANALYSIS_WALL_MS, RUN_WALL_MS, wallLimit } from "../src/jobs";
import { timedOut } from "../src/sandbox";
import { allMigrations, submission } from "./fixtures";
import type { Env, Execution } from "../src/types";

const runtime = env as Env;
beforeAll(async () => {
  await applyD1Migrations(runtime.DB, allMigrations);
});

async function review(id: string, deadline: number, status = "running") {
  const key = `reviews/${id}/submission.json`;
  await new Store(runtime).put(key, submission());
  await runtime.DB.prepare(
    "INSERT INTO reviews(id,tenant,submission_key,status,created_at,token_limit,deadline) VALUES(?,'owner',?,?,?,1000,?)",
  )
    .bind(id, key, status, Date.now() - 3600000, deadline)
    .run();
  await runtime.DB.prepare(
    "INSERT INTO jobs(id,review_id,attempt,status,payload_key,created_at,kind) VALUES(?,?,1,'leased','unused',?,'graph')",
  )
    .bind(`${id}-job`, id, Date.now())
    .run();
  return {
    id,
    status,
    deadline,
    submission_key: key,
  };
}
const row = (id: string) =>
  runtime.DB.prepare(
    "SELECT r.status,r.error,r.report_key,j.status AS job FROM reviews r JOIN jobs j ON j.review_id=r.id WHERE r.id=?",
  )
    .bind(id)
    .first<{
      status: string;
      error: string;
      report_key: string;
      job: string;
    }>();

describe("review reconciliation", () => {
  it("ends an overdue review with the submitted report and withdraws its jobs", async () => {
    const r = await review("overdue", Date.now() - DEADLINE_GRACE_MS - 1000);
    expect(await reconcile(runtime, r)).toBe("partial");
    const after = await row("overdue");
    expect(after).toMatchObject({
      status: "partial",
      error: "review exceeded its wall budget",
      job: "failed",
    });
    const report = await new Store(runtime).get<any>(after!.report_key);
    expect(report.status).toBe("partial");
    expect(report.footer.notes.at(-1)).toBe(
      "Rio ended this review: review exceeded its wall budget.",
    );
    // Settled once: a second pass leaves it alone.
    expect(await reconcile(runtime, { ...r, status: "partial" })).toBeNull();
  });

  it("leaves a review within its deadline and finished reviews alone", async () => {
    const r = await review("in-time", Date.now() + 600000);
    expect(await reconcile(runtime, r)).toBeNull();
    expect(await row("in-time")).toMatchObject({
      status: "running",
      job: "leased",
    });
    const done = await review("done", Date.now() - 3600000, "complete");
    expect(await reconcile(runtime, done)).toBeNull();
  });

  it("sweeps overdue reviews from the cron", async () => {
    await review("swept", Date.now() - DEADLINE_GRACE_MS - 1000);
    await sweepReviews(runtime);
    expect((await row("swept"))?.status).toBe("partial");
  });
});

describe("runner deadlines", () => {
  it("gives analysis jobs a longer wall than run commands", () => {
    expect(wallLimit("graph")).toBe(ANALYSIS_WALL_MS);
    expect(wallLimit("checks")).toBe(ANALYSIS_WALL_MS);
    expect(wallLimit("run")).toBe(RUN_WALL_MS);
  });

  it("allows transfer time by input size, capped inside a queue invocation", () => {
    const trees = (bytes: number) => ({
      base: { bytes, paths: 1 },
      head: { bytes, paths: 1 },
    });
    expect(transferMs(trees(0), ["base", "head"])).toBe(60000);
    expect(transferMs(trees(100 * 1048576), ["base", "head"])).toBe(110000);
    expect(transferMs(trees(100 * 1048576), ["head"])).toBe(85000);
    expect(transferMs(trees(10 * 1073741824), ["base", "head"])).toBe(240000);
    // Transfer, the longest analysis wall and a minute stay under 15 minutes.
    expect(240000 + ANALYSIS_WALL_MS + 60000).toBeLessThan(15 * 60000);
  });

  it("reports a deadline as a timed-out result, never as an executor failure", () => {
    const job = {
      job_id: "j",
      attempt: 2,
      version: "head",
    } as Execution;
    expect(timedOut(job, "transfer")).toEqual({
      outcome: "exited",
      job_id: "j",
      attempt: 2,
      version: "head",
      exit_code: 124,
      stdout: "",
      stderr: "runner wall deadline exceeded during transfer",
      timed_out: true,
      truncated: false,
    });
  });
});

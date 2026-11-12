import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { Store } from "../src/storage";
import {
  CANCEL_GRACE_MS,
  DEADLINE_GRACE_MS,
  reconcile,
  sweepReviews,
} from "../src/reconcile";
import { transferMs } from "../src/archive";
import {
  ANALYSIS_WALL_MS,
  RUN_WALL_MS,
  stopRunners,
  wallLimit,
} from "../src/jobs";
import { stopped, timedOut } from "../src/sandbox";
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

  it("leaves a cancelled review to its workflow for the grace, then ends it", async () => {
    const now = Date.now();
    const r = await review("cancelled-late", now + 600000, "cancelled");
    await runtime.DB.prepare(
      "UPDATE reviews SET cancelled=1,cancelled_at=? WHERE id='cancelled-late'",
    )
      .bind(now)
      .run();
    const cancelled = { ...r, cancelled_at: now };
    expect(await reconcile(runtime, cancelled, now + 1000)).toBeNull();
    await sweepReviews(runtime, now + 1000);
    expect(await row("cancelled-late")).toMatchObject({
      status: "cancelled",
      job: "leased",
    });
    // The cron ends it once the grace is over, well before its deadline.
    await sweepReviews(runtime, now + CANCEL_GRACE_MS + 1000);
    const after = await row("cancelled-late");
    expect(after).toMatchObject({
      status: "partial",
      error: "cancelled",
      job: "failed",
    });
    const report = await new Store(runtime).get<any>(after!.report_key);
    expect(report.status).toBe("partial");
    expect(report.footer.notes.at(-1)).toBe(
      "Rio ended this review: cancelled.",
    );
  });

  it("withdraws the idle jobs of finished reviews and leaves held and open ones", async () => {
    const now = Date.now();
    await review("finished", now + 600000, "partial");
    await review("working", now + 600000, "running");
    const job = (id: string, review: string, status: string, lease: number) =>
      runtime.DB.prepare(
        "INSERT INTO jobs(id,review_id,attempt,status,payload_key,created_at,kind,lease_until) VALUES(?,?,1,?,'unused',?,'graph',?)",
      )
        .bind(id, review, status, now, lease)
        .run();
    await job("f-pending", "finished", "pending", 0);
    await job("f-held", "finished", "leased", now + 60000);
    await job("f-lost", "finished", "leased", now - 60000);
    await job("f-done", "finished", "completed", 0);
    await job("w-pending", "working", "pending", 0);
    await job("w-lost", "working", "leased", now - 60000);
    await sweepReviews(runtime, now);
    const jobs = await runtime.DB.prepare(
      "SELECT id,status FROM jobs WHERE review_id IN ('finished','working') ORDER BY id",
    ).all<{ id: string; status: string }>();
    expect(Object.fromEntries(jobs.results.map((j) => [j.id, j.status]))).toEqual({
      "f-done": "completed",
      "f-held": "leased",
      "f-lost": "failed",
      "f-pending": "failed",
      // The job the helper adds: leased, with no lease time.
      "finished-job": "failed",
      // An open review's jobs are its workflow's to wait for or withdraw.
      "w-lost": "leased",
      "w-pending": "pending",
      "working-job": "leased",
    });
    // The runner still holding a job reports later; its lease then runs out.
    await sweepReviews(runtime, now + 120000);
    expect(
      (
        await runtime.DB.prepare(
          "SELECT status FROM jobs WHERE id='f-held'",
        ).first<any>()
      ).status,
    ).toBe("failed");
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
    // Transfer, the longest analysis wall, the extraction grace and a minute of
    // container start stay under the 15-minute queue invocation.
    expect(240000 + ANALYSIS_WALL_MS + 75000 + 60000).toBeLessThan(15 * 60000);
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
      phase: "transfer",
    });
    // With what the transfer had done by then, so a slow archive is told
    // from a slow command and slow storage from a slow container.
    const timing = { transfer_ms: 240000, archive_bytes: 1 << 28, storage_ms: 900 };
    expect(timedOut(job, "command", timing)).toMatchObject({
      stderr: "runner wall deadline exceeded during command",
      phase: "command",
      timing,
    });
  });

  it("ends a stopped runner's job with a result and stops only containers at work", async () => {
    const job = { job_id: "j", attempt: 1, version: "head" } as Execution;
    expect(stopped(job)).toEqual({
      outcome: "exited",
      job_id: "j",
      attempt: 1,
      version: "head",
      exit_code: 124,
      stdout: "",
      stderr: "runner stopped: the review ended or was cancelled",
      timed_out: true,
      truncated: false,
    });
    const now = Date.now();
    await review("stopping", now + 600000);
    for (const [id, status, kind] of [
      ["s-checks", "leased", "checks"],
      ["s-run", "leased", "run"],
      ["s-model", "leased", "model"],
      ["s-pending", "pending", "graph"],
      ["s-done", "completed", "graph"],
    ])
      await runtime.DB.prepare(
        "INSERT INTO jobs(id,review_id,attempt,status,payload_key,created_at,kind,lease_until) VALUES(?,'stopping',2,?,'unused',?,?,?)",
      )
        .bind(id, status, now, kind, now + 60000)
        .run();
    const calls: string[] = [];
    const sandbox = {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        fetch: async (url: string, init: RequestInit) => {
          calls.push(`${init.method} ${url} ${name}`);
          // One container is already gone; the others are still stopped.
          if (name.includes("s-checks")) throw new Error("no such object");
          return Response.json({ stopped: true });
        },
      }),
    };
    const sandboxed = {
      ...runtime,
      DB: runtime.DB,
      RUNNER_BACKEND: "sandbox",
      SANDBOX: sandbox,
    } as unknown as Env;
    await stopRunners(sandboxed, "stopping");
    expect(calls.sort()).toEqual([
      "POST https://sandbox/stop stopping-s-checks-2",
      "POST https://sandbox/stop stopping-s-run-2",
      // The job the helper adds: a leased graph job, attempt 1.
      "POST https://sandbox/stop stopping-stopping-job-1",
    ]);
    // A job whose container answered the stop is withdrawn, so it does not
    // read as running until its lease ends; the one that did not answer
    // keeps its lease, and jobs that are not containers are left alone.
    const jobs = await runtime.DB.prepare(
      "SELECT id,status FROM jobs WHERE review_id='stopping' ORDER BY id",
    ).all<{ id: string; status: string }>();
    expect(
      Object.fromEntries(jobs.results.map((j) => [j.id, j.status])),
    ).toEqual({
      "s-checks": "leased",
      "s-done": "completed",
      "s-model": "leased",
      "s-pending": "pending",
      "s-run": "failed",
      "stopping-job": "failed",
    });
    // A self-hosted runner's containers are its own.
    calls.length = 0;
    await stopRunners({ ...sandboxed, RUNNER_BACKEND: "self-hosted" } as Env, "stopping");
    expect(calls).toEqual([]);
  });
});

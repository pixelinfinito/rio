import { DurableObject } from "cloudflare:workers";
import type { Env, Execution, ExecutionResult, Version } from "./types";
import { invariant } from "./validation";
import {
  ARTIFACT_LIMIT,
  SANDBOX_CPUS,
  SANDBOX_MEMORY_MB,
  validateResult,
  wallLimit,
} from "./jobs";
import { type Transfer, jobInput, snapshotFor, transferMs } from "./archive";
import { SandboxQa } from "./qa-sandbox";
/** A job stopped at its deadline: a result, so the queue never redelivers it. */
export function timedOut(
  job: Execution,
  phase: "transfer" | "command",
  timing?: ExecutionResult["timing"],
): ExecutionResult {
  return {
    outcome: "exited",
    job_id: job.job_id,
    attempt: job.attempt,
    version: job.version,
    exit_code: 124,
    stdout: "",
    stderr: `runner wall deadline exceeded during ${phase}`,
    timed_out: true,
    truncated: false,
    phase,
    ...(timing ? { timing } : {}),
  };
}
/** A job whose review ended while it ran: a result, never a redelivery. */
export function stopped(job: Execution): ExecutionResult {
  return {
    outcome: "exited",
    job_id: job.job_id,
    attempt: job.attempt,
    version: job.version,
    exit_code: 124,
    stdout: "",
    stderr: "runner stopped: the review ended or was cancelled",
    timed_out: true,
    truncated: false,
  };
}
/** Time past the command wall for extraction to finish and the executor to exit. */
const EXTRACT_GRACE_MS = 75000;
export const WARM_IDLE_MS = 180000;
const WARM_CONTAINER_TTL_S = 1800;
const MAX_CONCURRENT_RUNS = 2;

export class Sandbox extends DurableObject<Env> {
  private qaStart?: Promise<void>;
  private runner = new SandboxRunner(this.ctx, this.env);
  async alarm() {
    const mode = await this.ctx.storage?.get<string>("mode");
    if (mode === "warm") {
      await this.runner.onIdleAlarm();
      return;
    }
    await new SandboxQa(this.ctx, this.env).alarm();
  }
  async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/stop") return Response.json(await this.runner.stop());
    const job: Execution = await request.json();
    if (job.kind === "qa") {
      await this.ctx.storage?.put("mode", "qa");
      this.qaStart ??= new SandboxQa(this.ctx, this.env).start(job);
      await this.qaStart;
      return Response.json({ accepted: true }, { status: 202 });
    }
    if (pathname === "/execute-warm") {
      await this.ctx.storage?.put("mode", "warm");
      return Response.json(await this.runner.runWarm(job));
    }
    return Response.json(await this.runner.run(job));
  }
}
/** One container's job(s) and stop, apart from the Durable Object around it. */
export class SandboxRunner {
  private stopped = false;
  /** Ends the wait of the execution in flight. */
  private halt?: () => void;
  /** Ends any in-flight warm executions/hydrations on stop. */
  private warmHalts = new Set<() => void>();
  /** The execution in flight for one-shot jobs: the object is one job attempt's. */
  private running?: Promise<ExecutionResult>;
  private hydrated = new Set<string>();
  private hydrating = new Map<string, Promise<number>>();
  private activeExecs = 0;
  private slotQueue: (() => void)[] = [];
  constructor(
    private ctx: Pick<DurableObjectState, "container"> &
      Partial<Pick<DurableObjectState, "storage">>,
    private env: Env,
  ) {}
  async stop() {
    // The execution(s) in flight answer with `stopped` at once,
    // whatever the destroyed container's streams then do.
    this.stopped = true;
    this.halt?.();
    for (const h of [...this.warmHalts]) h();
    this.hydrated.clear();
    this.hydrating.clear();
    await this.ctx.storage?.deleteAlarm?.().catch(() => {});
    if (this.ctx.container?.running) await this.ctx.container.destroy();
    return { stopped: true };
  }
  async onIdleAlarm() {
    if (this.activeExecs > 0) return;
    this.hydrated.clear();
    this.hydrating.clear();
    if (this.ctx.container?.running) await this.ctx.container.destroy();
  }
  private validateLimits(job: Execution) {
    invariant(
      job.network === false &&
        job.limits.memory_mb <= SANDBOX_MEMORY_MB &&
        job.limits.cpu <= SANDBOX_CPUS &&
        job.limits.wall_ms <= wallLimit(job.kind) &&
        job.limits.output_bytes <= 1048576 &&
        (job.limits.artifact_bytes ?? 0) <= ARTIFACT_LIMIT,
      "invalid sandbox limits",
    );
  }
  private async acquireSlot(): Promise<() => void> {
    if (this.activeExecs < MAX_CONCURRENT_RUNS) {
      this.activeExecs++;
      return () => {
        this.activeExecs--;
        const next = this.slotQueue.shift();
        if (next) next();
      };
    }
    await new Promise<void>((resolve) => this.slotQueue.push(resolve));
    this.activeExecs++;
    return () => {
      this.activeExecs--;
      const next = this.slotQueue.shift();
      if (next) next();
    };
  }
  /**
   * Warm per-review container execution for `run` jobs: starts one container,
   * hydrates each snapshot version once, and executes commands without repeating
   * tree transfers.
   */
  async runWarm(job: Execution): Promise<ExecutionResult> {
    this.validateLimits(job);
    invariant(job.kind === "run", "warm runner supports run jobs only");
    const container = this.ctx.container;
    invariant(container, "Cloudflare Container is unavailable");
    if (this.stopped) return stopped(job);

    const abort = new AbortController();
    let rejectHalted!: (error: Error) => void;
    const halted = new Promise<never>((_, reject) => {
      rejectHalted = reject;
    });
    halted.catch(() => {});
    const onHalt = () => {
      abort.abort();
      rejectHalted(new Error("stopped"));
    };
    this.warmHalts.add(onHalt);
    const unlessStopped = <T>(work: Promise<T>): Promise<T> => {
      work.catch(() => {});
      return Promise.race([work, halted]);
    };

    const ensureContainer = () => {
      if (!container.running) {
        this.hydrated.clear();
        this.hydrating.clear();
        container.start({
          enableInternet: false,
          entrypoint: ["/bin/sleep", String(WARM_CONTAINER_TTL_S)],
        });
      }
    };

    const versionKey = `${job.snapshot_id}:${job.version}`;
    const ensureHydrated = async (
      measured: Transfer,
      treeSizes: Record<Version, { bytes: number }>,
    ): Promise<number> => {
      if (this.hydrated.has(versionKey)) return 0;
      let pending = this.hydrating.get(versionKey);
      if (!pending) {
        pending = (async () => {
          ensureContainer();
          const transfer = transferMs(treeSizes as any, [job.version]);
          const hydrateAbort = new AbortController();
          const onParentAbort = () => hydrateAbort.abort();
          abort.signal.addEventListener("abort", onParentAbort, { once: true });
          const timer = setTimeout(() => hydrateAbort.abort(), transfer);
          try {
            const proc = await container.exec(
              ["/usr/bin/python3", "/opt/rio/execute.py", "hydrate"],
              {
                stdin: "pipe",
                stdout: "pipe",
                stderr: "pipe",
                signal: hydrateAbort.signal,
                user: "10001",
              },
            );
            const hydrateJob: Execution = { ...job, needs: [job.version] };
            const stream = await jobInput(this.env, hydrateJob, {
              shared: false,
              measured,
            });
            const piped = stream
              .pipeTo(proc.stdin!, { signal: hydrateAbort.signal })
              .catch((e: unknown) => e);
            const [output, pipeErr] = await Promise.all([proc.output(), piped]);
            if (hydrateAbort.signal.aborted && !this.stopped)
              throw new Error("hydrate transfer deadline exceeded");
            if (output.exitCode !== 0)
              throw new Error(
                `sandbox hydrate failed: ${new TextDecoder().decode(output.stderr).slice(0, 500)}`,
              );
            if (pipeErr instanceof Error) throw pipeErr;
            const res = JSON.parse(new TextDecoder().decode(output.stdout));
            this.hydrated.add(versionKey);
            return Number(res.extract_ms ?? 0);
          } finally {
            clearTimeout(timer);
            abort.signal.removeEventListener("abort", onParentAbort);
            this.hydrating.delete(versionKey);
          }
        })();
        this.hydrating.set(versionKey, pending);
      }
      return pending;
    };

    const execCachedOnce = async (): Promise<any> => {
      ensureContainer();
      const cmdAbort = new AbortController();
      const onParentAbort = () => cmdAbort.abort();
      abort.signal.addEventListener("abort", onParentAbort, { once: true });
      const timer = setTimeout(
        () => cmdAbort.abort(),
        job.limits.wall_ms + EXTRACT_GRACE_MS,
      );
      try {
        const proc = await container.exec(
          ["/usr/bin/python3", "/opt/rio/execute.py", "run-cached"],
          {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
            signal: cmdAbort.signal,
            user: "10001",
          },
        );
        const header = JSON.stringify({
          protocol: 1,
          kind: "run",
          network: false,
          review_id: job.review_id,
          job_id: job.job_id,
          attempt: job.attempt,
          version: job.version,
          snapshot_id: job.snapshot_id,
          command: job.command,
          limits: job.limits,
        });
        const writer = proc.stdin!.getWriter();
        const piped = (async () => {
          await writer.write(new TextEncoder().encode(`${header}\n`));
          await writer.close();
        })().catch((e: unknown) => e);
        const [output, pipeErr] = await Promise.all([proc.output(), piped]);
        if (this.stopped) return stopped(job);
        if (cmdAbort.signal.aborted)
          return timedOut(job, "command", {
            transfer_ms: 0,
            archive_bytes: 0,
            storage_ms: 0,
          });
        if (output.exitCode !== 0)
          throw new Error(
            `sandbox executor failed: ${new TextDecoder().decode(output.stderr).slice(0, 500)}`,
          );
        if (pipeErr instanceof Error) throw pipeErr;
        return JSON.parse(new TextDecoder().decode(output.stdout));
      } finally {
        clearTimeout(timer);
        abort.signal.removeEventListener("abort", onParentAbort);
      }
    };

    let releaseSlot: (() => void) | undefined;
    try {
      await this.ctx.storage?.deleteAlarm?.().catch(() => {});
      const snap = await unlessStopped(snapshotFor(this.env, job));
      if (await unlessStopped(this.withdrawn(job))) return stopped(job);
      if (this.stopped) return stopped(job);

      const measured: Transfer = { bytes: 0, storage_ms: 0 };
      const hydrateStarted = Date.now();
      let extractMs = 0;
      try {
        extractMs = await unlessStopped(
          ensureHydrated(measured, snap.index.trees),
        );
      } catch (error) {
        if (this.stopped) return stopped(job);
        if (
          error instanceof Error &&
          /hydrate transfer deadline exceeded/.test(error.message)
        )
          return timedOut(job, "transfer", {
            transfer_ms: Date.now() - hydrateStarted,
            archive_bytes: measured.bytes,
            storage_ms: measured.storage_ms,
          });
        throw error;
      }

      releaseSlot = await unlessStopped(this.acquireSlot());
      if (this.stopped) return stopped(job);
      let result = await unlessStopped(execCachedOnce());
      if (result?.outcome === "cache_miss") {
        this.hydrated.delete(versionKey);
        const m2: Transfer = { bytes: 0, storage_ms: 0 };
        extractMs += await unlessStopped(ensureHydrated(m2, snap.index.trees));
        measured.bytes += m2.bytes;
        measured.storage_ms += m2.storage_ms;
        result = await unlessStopped(execCachedOnce());
      }
      if (this.stopped) return stopped(job);
      validateResult(result, job);
      result.timing = {
        ...result.timing,
        ...(extractMs ? { extract_ms: extractMs } : {}),
        archive_bytes: measured.bytes,
        storage_ms: measured.storage_ms,
      };
      return result;
    } catch (error) {
      if (this.stopped) return stopped(job);
      throw error;
    } finally {
      this.warmHalts.delete(onHalt);
      releaseSlot?.();
      if (!this.stopped && this.activeExecs === 0 && container.running)
        await this.ctx.storage
          ?.setAlarm?.(Date.now() + WARM_IDLE_MS)
          .catch(() => {});
    }
  }
  /**
   * A message delivered again while its job is at work joins that execution:
   * one stop ends both, and neither destroys the other's container.
   */
  run(job: Execution): Promise<ExecutionResult> {
    return (this.running ??= this.execute(job).finally(() => {
      this.running = undefined;
    }));
  }
  /**
   * Whether the job was withdrawn, as a stop that was answered leaves it, or
   * its review ended or was cancelled, which is what the queue's lease
   * refuses and stays true when the withdrawal after a stop could not be
   * written: the records that outlive this object, which remembers a stop
   * only while it stays in memory.
   */
  private async withdrawn(job: Execution): Promise<boolean> {
    const row = await this.env.DB.prepare(
      "SELECT j.status,r.cancelled,r.status AS review FROM jobs j LEFT JOIN reviews r ON r.id=j.review_id WHERE j.id=? AND j.review_id=? AND j.attempt=?",
    )
      .bind(job.job_id, job.review_id, job.attempt)
      .first<{ status: string; cancelled: number | null; review: string | null }>();
    return (
      row?.status === "failed" ||
      row?.cancelled === 1 ||
      ["complete", "partial", "incomplete", "error"].includes(row?.review ?? "")
    );
  }
  private async execute(job: Execution): Promise<ExecutionResult> {
    this.validateLimits(job);
    const container = this.ctx.container;
    invariant(container, "Cloudflare Container is unavailable");
    if (this.stopped) return stopped(job);
    // From here a stop ends every wait, the storage reads before the
    // container starts included.
    const abort = new AbortController();
    const halted = new Promise<never>((_, reject) => {
      this.halt = () => {
        abort.abort();
        reject(new Error("stopped"));
      };
    });
    halted.catch(() => {});
    /** The value of work a stop does not wait for. */
    const unlessStopped = <T>(work: Promise<T>): Promise<T> => {
      work.catch(() => {});
      return Promise.race([work, halted]);
    };
    let phase: "transfer" | "command" = "transfer";
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Where the job's time went, reported with its result or its deadline.
    const measured: Transfer = { bytes: 0, storage_ms: 0 };
    let started = Date.now();
    let transferred: number | undefined;
    const timing = () => ({
      transfer_ms: transferred ?? Date.now() - started,
      archive_bytes: measured.bytes,
      storage_ms: measured.storage_ms,
    });
    try {
      // The archive has its own deadline; the command's wall starts once it is in.
      const transfer = transferMs(
        (await unlessStopped(snapshotFor(this.env, job))).index.trees,
        job.needs,
      );
      if (await unlessStopped(this.withdrawn(job))) return stopped(job);
      if (container.running) await container.destroy();
      // A stop that arrived meanwhile found no container to destroy.
      if (this.stopped) return stopped(job);
      container.start({
        enableInternet: false,
        entrypoint: [
          "/bin/sleep",
          String(
            Math.ceil(
              (transfer + job.limits.wall_ms + EXTRACT_GRACE_MS) / 1000,
            ) + 30,
          ),
        ],
      });
      timer = setTimeout(() => abort.abort(), transfer);
      started = Date.now();
      const starting = container.exec(
        ["/usr/bin/python3", "/opt/rio/execute.py"],
        {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          signal: abort.signal,
          user: "10001",
        },
      );
      const process = await unlessStopped(starting);
      // Stream the header and tree archive; output is collected concurrently so
      // neither side can block on a full pipe.
      const archive = jobInput(this.env, job, { shared: true, measured });
      const stream = await unlessStopped(archive).catch((error: unknown) => {
        // Left unread by a stop: cancelled once it exists, so it holds nothing.
        void archive.then((left) => left.cancel()).catch(() => {});
        throw error;
      });
      const input = stream
        .pipeTo(process.stdin!, { signal: abort.signal })
        .then(
          () => {
            clearTimeout(timer);
            transferred = Date.now() - started;
            phase = "command";
            // The executor may still be extracting the archive's tail, and
            // its own wall starts only after that.
            timer = setTimeout(
              () => abort.abort(),
              job.limits.wall_ms + EXTRACT_GRACE_MS,
            );
          },
          (error: unknown) => error,
        );
      let output: Awaited<ReturnType<typeof process.output>>, piped: unknown;
      try {
        [output, piped] = await unlessStopped(
          Promise.all([process.output(), input]),
        );
      } catch (error) {
        if (this.stopped) return stopped(job);
        if (abort.signal.aborted) return timedOut(job, phase, timing());
        throw error;
      }
      if (this.stopped) return stopped(job);
      if (abort.signal.aborted) return timedOut(job, phase, timing());
      // An executor that exits early closes its input; its own error explains why.
      if (output.exitCode !== 0)
        throw new Error(
          `sandbox executor failed: ${new TextDecoder().decode(output.stderr).slice(0, 500)}`,
        );
      if (piped instanceof Error) throw piped;
      const result = JSON.parse(new TextDecoder().decode(output.stdout));
      validateResult(result, job);
      result.timing = { ...result.timing, ...timing() };
      return result;
    } catch (error) {
      if (this.stopped) return stopped(job);
      throw error;
    } finally {
      this.halt = undefined;
      clearTimeout(timer);
      if (container.running) await container.destroy();
    }
  }
}

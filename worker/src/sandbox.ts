import { DurableObject } from "cloudflare:workers";
import type { Env, Execution, ExecutionResult } from "./types";
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
export class Sandbox extends DurableObject<Env> {
  private qaStart?: Promise<void>;
  private runner = new SandboxRunner(this.ctx, this.env);
  async alarm() {
    await new SandboxQa(this.ctx, this.env).alarm();
  }
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/stop")
      return Response.json(await this.runner.stop());
    const job: Execution = await request.json();
    if (job.kind === "qa") {
      this.qaStart ??= new SandboxQa(this.ctx, this.env).start(job);
      await this.qaStart;
      return Response.json({ accepted: true }, { status: 202 });
    }
    return Response.json(await this.runner.run(job));
  }
}
/** One container's job and its stop, apart from the Durable Object around it. */
export class SandboxRunner {
  private stopped = false;
  /** Ends the wait of the execution in flight. */
  private halt?: () => void;
  constructor(
    private ctx: Pick<DurableObjectState, "container">,
    private env: Env,
  ) {}
  async stop() {
    // The execution in flight, if any, answers with `stopped` at once,
    // whatever the destroyed container's streams then do.
    this.stopped = true;
    this.halt?.();
    if (this.ctx.container?.running) await this.ctx.container.destroy();
    return { stopped: true };
  }
  async run(job: Execution): Promise<ExecutionResult> {
    invariant(
      job.network === false &&
        job.limits.memory_mb <= SANDBOX_MEMORY_MB &&
        job.limits.cpu <= SANDBOX_CPUS &&
        job.limits.wall_ms <= wallLimit(job.kind) &&
        job.limits.output_bytes <= 1048576 &&
        (job.limits.artifact_bytes ?? 0) <= ARTIFACT_LIMIT,
      "invalid sandbox limits",
    );
    // The archive has its own deadline; the command's wall starts once it is in.
    const transfer = transferMs(
      (await snapshotFor(this.env, job)).index.trees,
      job.needs,
    );
    const container = this.ctx.container;
    invariant(container, "Cloudflare Container is unavailable");
    if (this.stopped) return stopped(job);
    if (container.running) await container.destroy();
    container.start({
      enableInternet: false,
      entrypoint: [
        "/bin/sleep",
        String(
          Math.ceil((transfer + job.limits.wall_ms + EXTRACT_GRACE_MS) / 1000) +
            30,
        ),
      ],
    });
    const abort = new AbortController();
    const halted = new Promise<never>((_, reject) => {
      this.halt = () => {
        abort.abort();
        reject(new Error("stopped"));
      };
    });
    halted.catch(() => {});
    let phase: "transfer" | "command" = "transfer";
    let timer = setTimeout(() => abort.abort(), transfer);
    // Where the job's time went, reported with its result or its deadline.
    const measured: Transfer = { bytes: 0, storage_ms: 0 };
    const started = Date.now();
    let transferred: number | undefined;
    const timing = () => ({
      transfer_ms: transferred ?? Date.now() - started,
      archive_bytes: measured.bytes,
      storage_ms: measured.storage_ms,
    });
    try {
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
      starting.catch(() => {});
      const process = await Promise.race([starting, halted]);
      // Stream the header and tree archive; output is collected concurrently so
      // neither side can block on a full pipe.
      const input = (await jobInput(this.env, job, { shared: true, measured }))
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
        const running = Promise.all([process.output(), input]);
        running.catch(() => {});
        [output, piped] = await Promise.race([running, halted]);
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

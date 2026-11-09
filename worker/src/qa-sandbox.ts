import type { Env, Execution, ExecutionResult } from "./types";
import { jobInput } from "./archive";
import { invariant } from "./validation";
import { finishJob, validateResult } from "./jobs";
import {
  claimQaRun,
  configureQaRun,
  heartbeatQaRun,
  qaControl,
  revokeQaRun,
  QA_HEARTBEAT_MS,
} from "./qa-jobs";
import type { SandboxGatewayScope } from "./qa-sandbox-gateway";

type Claim = Awaited<ReturnType<typeof claimQaRun>>;
interface State {
  job: Execution;
  claim: Claim;
  started: number;
  stopping?: number;
  stopReason?: string;
  finished?: boolean;
}
const root = "/run/rio-sandbox";
const policy = { egress: "provider_pinned (sandbox)", app_isolation: "none" };
const resultOf = (job: Execution, artifact: any): ExecutionResult => ({
  outcome: "exited",
  job_id: job.job_id,
  attempt: job.attempt,
  version: job.version,
  exit_code: 0,
  stdout: "",
  stderr: "",
  timed_out: false,
  truncated: false,
  artifact: { ...artifact, policy },
});
async function jsonProcess(
  container: Container,
  command: string[],
  timeout = 30000,
) {
  const process = await container.exec(command, {
    user: "0",
    stdout: "pipe",
    stderr: "ignore",
    signal: AbortSignal.timeout(timeout),
  });
  const output = await process.output();
  invariant(
    output.exitCode === 0 && output.stdout.byteLength <= 16 * 1024 * 1024,
    "Sandbox QA process failed",
  );
  return JSON.parse(new TextDecoder().decode(output.stdout));
}

/** Alarms supervise long QA runs independently of the queue consumer's request
 * lifetime. Each alarm renews the lease; cancellation gives traces time to flush. */
export class SandboxQa {
  constructor(
    private ctx: DurableObjectState,
    private env: Env,
  ) {}
  async start(job: Execution) {
    invariant(
      job.kind === "qa" &&
        job.network === "qa" &&
        job.qa?.options.sandbox === "allow" &&
        job.qa.harness_auth === "gateway" &&
        job.limits.cpu <= 2 &&
        job.limits.memory_mb <= 8192 &&
        Number.isSafeInteger(job.limits.wall_ms) &&
        job.limits.wall_ms > 0 &&
        job.limits.wall_ms <= job.qa.budget.wall_ms &&
        job.limits.output_bytes <= 1048576 &&
        (job.limits.artifact_bytes ?? 0) <= 12 * 1024 * 1024,
      "invalid Sandbox QA job",
    );
    const existing = await this.ctx.storage.get<State>("qa");
    if (existing) {
      invariant(
        existing.job.job_id === job.job_id &&
          existing.job.attempt === job.attempt,
        "conflicting Sandbox QA job",
      );
      return;
    }
    const container = this.ctx.container;
    invariant(container, "Cloudflare Container is unavailable");
    const claim = await claimQaRun(this.env, job);
    const state: State = { job, claim, started: Date.now() };
    await this.ctx.storage.put("qa", state);
    try {
      if (container.running) await container.destroy();
      container.start({
        enableInternet: false,
        entrypoint: [
          "/bin/sleep",
          String(Math.ceil(job.limits.wall_ms / 1000) + 600),
        ],
      });
      await container.setInactivityTimeout(5 * 60000);
      const exports = this.ctx.exports as unknown as {
        QaSandboxGateway(options: { props: SandboxGatewayScope }): Fetcher;
      };
      invariant(
        exports.QaSandboxGateway,
        "Sandbox QA gateway binding unavailable",
      );
      await container.interceptOutboundHttp(
        "198.18.0.1",
        exports.QaSandboxGateway({
          props: { run: claim.qa.run_id, generation: claim.qa.generation },
        }),
      );
      const image = (await container.inspect())?.image ?? "";
      const digest = /sha256:[a-f0-9]{64}/.exec(image)?.[0];
      invariant(
        digest,
        "Sandbox QA requires a resolved deployment image digest",
      );
      const process = await container.exec(
        ["rio-runner", "qa", "sandbox", "plan", "--directory", root],
        {
          user: "0",
          stdin: "pipe",
          stdout: "pipe",
          stderr: "ignore",
          signal: AbortSignal.timeout(Math.min(job.limits.wall_ms, 600000)),
        },
      );
      // Read output concurrently with archive upload to avoid a full pipe.
      const outputPromise = process.output();
      const writer = process.stdin!.getWriter();
      const credentials = this.env.QA_PERSONA_CREDENTIALS
        ? JSON.parse(this.env.QA_PERSONA_CREDENTIALS)
        : {};
      await writer.write(
        new TextEncoder().encode(
          JSON.stringify({ claim, image_digest: digest, credentials }) + "\n",
        ),
      );
      writer.releaseLock();
      // Alarms renew the lease even while a large archive is being transferred.
      await this.ctx.storage.setAlarm(
        Math.min(Date.now() + QA_HEARTBEAT_MS, state.claim.qa.deadline),
      );
      await (await jobInput(this.env, job)).pipeTo(process.stdin!);
      const output = await outputPromise;
      invariant(
        output.exitCode === 0 && output.stdout.byteLength <= 16 * 1024 * 1024,
        "Sandbox QA planning failed",
      );
      const planned = JSON.parse(new TextDecoder().decode(output.stdout));
      if (!planned.ready) {
        await this.complete(state, planned.result);
        return;
      }
      const run = await qaControl(
        this.env,
        job.review_id,
        job.job_id,
        job.attempt,
        claim.token,
      );
      await configureQaRun(this.env, run, planned.configuration);
      await jsonProcess(container, [
        "python3",
        "/opt/rio-qa/sandbox.py",
        "launch",
      ]);
      await this.ctx.storage.setAlarm(
        Math.min(Date.now() + QA_HEARTBEAT_MS, state.claim.qa.deadline),
      );
    } catch {
      await this.fail(state);
    }
  }
  async alarm() {
    const state = await this.ctx.storage.get<State>("qa");
    if (!state || state.finished) return;
    const container = this.ctx.container;
    if (!container?.running) {
      await this.fail(state);
      return;
    }
    try {
      const run = await qaControl(
        this.env,
        state.job.review_id,
        state.job.job_id,
        state.job.attempt,
        state.claim.token,
      );
      const heartbeat = await heartbeatQaRun(this.env, run);
      if (heartbeat.cancelled && !state.stopping) {
        state.stopping = Date.now();
        state.stopReason = heartbeat.reason;
        await this.ctx.storage.put("qa", state);
        await jsonProcess(container, [
          "python3",
          "/opt/rio-qa/sandbox.py",
          "cancel",
        ]);
      }
      const status = await jsonProcess(container, [
        "python3",
        "/opt/rio-qa/sandbox.py",
        "status",
      ]);
      if (
        status.done ||
        (state.stopping && Date.now() - state.stopping >= 60000)
      ) {
        const artifact = await jsonProcess(container, [
          "rio-runner",
          "qa",
          "sandbox",
          "finish",
          "--directory",
          root,
        ]);
        if (state.stopping) {
          artifact.outcome = "partial";
          artifact.runtime_reason = state.stopReason ?? "interrupted";
        }
        artifact.wall_time_ms = Date.now() - state.started;
        await this.complete(state, artifact);
      } else
        await this.ctx.storage.setAlarm(
          state.stopping
            ? Date.now() + 10000
            : Math.min(Date.now() + QA_HEARTBEAT_MS, state.claim.qa.deadline),
        );
    } catch {
      await this.fail(state);
    }
  }
  private async complete(state: State, artifact: any) {
    const result = resultOf(state.job, artifact);
    validateResult(result, state.job);
    await finishJob(
      this.env,
      state.job.review_id,
      state.job.job_id,
      state.job.attempt,
      result,
      state.claim.token,
    );
    await this.dispose(state);
  }
  private async fail(state: State) {
    try {
      await finishJob(
        this.env,
        state.job.review_id,
        state.job.job_id,
        state.job.attempt,
        {
          outcome: "runner_failed",
          job_id: state.job.job_id,
          attempt: state.job.attempt,
          version: state.job.version,
          exit_code: 125,
          stdout: "",
          stderr: "Sandbox QA runtime failed",
          timed_out: false,
          truncated: false,
        },
        state.claim.token,
      );
    } finally {
      await this.dispose(state);
    }
  }
  private async dispose(state: State) {
    try {
      await revokeQaRun(
        this.env,
        state.claim.qa.run_id,
        state.claim.qa.generation,
      );
    } finally {
      try {
        await this.ctx.container?.destroy();
      } finally {
        await this.ctx.storage.put("qa", { ...state, finished: true });
        await this.ctx.storage.deleteAlarm();
      }
    }
  }
}

import { DurableObject } from "cloudflare:workers";
import type { Env, Execution } from "./types";
import { invariant } from "./validation";
import { validateResult } from "./jobs";
import { jobInput } from "./archive";
export class Sandbox extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const job: Execution = await request.json();
    invariant(
      job.network === false &&
        job.limits.memory_mb <= 8192 &&
        job.limits.cpu <= 2 &&
        job.limits.wall_ms <= 120000 &&
        job.limits.output_bytes <= 1048576,
      "invalid sandbox limits",
    );
    const container = this.ctx.container;
    invariant(container, "Cloudflare Container is unavailable");
    if (container.running) await container.destroy();
    container.start({
      enableInternet: false,
      entrypoint: ["/bin/sleep", "180"],
    });
    try {
      const process = await container.exec(
        ["/usr/bin/python3", "/opt/rio/execute.py"],
        {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          signal: AbortSignal.timeout(job.limits.wall_ms + 15000),
          user: "10001",
        },
      );
      // Stream the header and tree archive; output is collected concurrently so
      // neither side can block on a full pipe.
      const input = (await jobInput(this.env, job))
        .pipeTo(process.stdin!)
        .catch((error: unknown) => error);
      const [output, piped] = await Promise.all([process.output(), input]);
      // An executor that exits early closes its input; its own error explains why.
      if (output.exitCode !== 0)
        throw new Error(
          `sandbox executor failed: ${new TextDecoder().decode(output.stderr).slice(0, 500)}`,
        );
      if (piped instanceof Error) throw piped;
      const result = JSON.parse(new TextDecoder().decode(output.stdout));
      validateResult(result, job);
      return Response.json(result);
    } finally {
      await container.destroy();
    }
  }
}

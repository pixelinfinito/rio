import { DurableObject } from "cloudflare:workers";
import type { Env, Execution } from "./types";
import { invariant } from "./validation";
import { validateResult } from "./jobs";
export class Sandbox extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const job: Execution = await request.json();
    invariant(
      job.network === false &&
        job.limits.memory_mb <= 8192 && job.limits.cpu <= 2 &&
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
      const writer = process.stdin!.getWriter();
      await writer.write(new TextEncoder().encode(JSON.stringify(job)));
      await writer.close();
      const output = await process.output();
      invariant(output.exitCode === 0, "sandbox executor failed");
      const result = JSON.parse(new TextDecoder().decode(output.stdout));
      validateResult(result, job);
      return Response.json(result);
    } finally {
      await container.destroy();
    }
  }
}

import { WorkerEntrypoint } from "cloudflare:workers";
import { Hono } from "hono";
import type { Env } from "./types";
import { authenticateQaRun } from "./qa-jobs";
import { qaEvidenceRoutes } from "./qa-evidence";
import { qaModelRoutes } from "./qa-model";
import { qaSeedRoutes } from "./qa-seed-routes";

export interface SandboxGatewayScope {
  run: string;
  generation: string;
}
const routes = new Hono<{ Bindings: Env }>();
routes.onError(() => new Response("QA request rejected", { status: 400 }));
routes.route("/v1/qa/model", qaModelRoutes);
routes.route("/v1/qa/seeds", qaSeedRoutes);
routes.route("/v1/qa", qaEvidenceRoutes);

/** This binding never performs arbitrary fetches. Container internet is off;
 * the single intercepted IP exposes only the current run's QA capabilities. */
export async function sandboxGateway(
  request: Request,
  env: Env,
  scope: SandboxGatewayScope,
) {
  const url = new URL(request.url);
  const permitted =
    url.origin === "http://198.18.0.1" &&
    (url.pathname === "/v1/qa/model" ||
      url.pathname.startsWith("/v1/qa/model/") ||
      url.pathname.startsWith("/v1/qa/seeds/") ||
      url.pathname.startsWith(`/v1/qa/runs/${scope.run}/evidence`));
  if (!permitted)
    return new Response("QA gateway route denied", { status: 403 });
  try {
    const run = await authenticateQaRun(request, env);
    if (run.id !== scope.run || run.generation !== scope.generation)
      return new Response("QA gateway scope denied", { status: 403 });
    return await routes.fetch(request, env);
  } catch {
    return new Response("QA capability unavailable", { status: 401 });
  }
}
export class QaSandboxGateway extends WorkerEntrypoint<
  Env,
  SandboxGatewayScope
> {
  fetch(request: Request) {
    return sandboxGateway(request, this.env, this.ctx.props);
  }
}

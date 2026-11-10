import { Hono } from "hono";
import { authenticate } from "./auth";
import { authenticateQaRun, type QaConfiguration } from "./qa-jobs";
import {
  HostedSeeds,
  SEED_MANIFEST_BYTES,
  SEED_PART_BYTES,
  SeedError,
} from "./qa-seeds";
import type { Env } from "./types";

export const qaSeedRoutes = new Hono<{
  Bindings: Env;
  Variables: { seeds: HostedSeeds };
}>();
qaSeedRoutes.onError((error, context) => {
  if (error instanceof SeedError)
    return context.json({ error: error.reason, details: error.details }, 400);
  if (/unauthorized/.test(error.message))
    return context.json({ error: "unauthorized" }, 401);
  return context.json({ error: "seed_store_unavailable" }, 503);
});
qaSeedRoutes.use("*", async (context, next) => {
  if (context.req.header("authorization")?.startsWith("Bearer qa-run.")) {
    const run = await authenticateQaRun(context.req.raw, context.env);
    if (!run.configuration) throw new Error("unauthorized unconfigured QA run");
    const configuration = JSON.parse(run.configuration) as QaConfiguration;
    context.set(
      "seeds",
      new HostedSeeds(context.env, run.tenant, {
        run_id: run.id,
        generation: run.generation,
        fingerprints: configuration.seed_fingerprints,
        max_size: run.seed_max_size,
      }),
    );
    await next();
    return;
  }
  const tenant = await authenticate(context.req.raw, context.env, [
    "qa:seeds",
    "reviews:write",
  ]);
  context.set("seeds", new HostedSeeds(context.env, tenant));
  await next();
});
async function bytes(request: Request, max: number) {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > max) throw new SeedError("seed_request_too_large");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  }
  const all = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  return all;
}
async function json(request: Request, max = 65536) {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        await bytes(request, max),
      ),
    );
  } catch (error) {
    throw error instanceof SeedError ? error : new SeedError("seed_corrupt");
  }
}
qaSeedRoutes.post("/leases", async (c) =>
  c.json(await c.get("seeds").acquire(await json(c.req.raw)), 201),
);
qaSeedRoutes.patch("/leases/:id", async (c) =>
  c.json(await c.get("seeds").renew(c.req.param("id"), await json(c.req.raw))),
);
qaSeedRoutes.delete("/leases/:id", async (c) => {
  await c.get("seeds").release(c.req.param("id"));
  return c.json({ released: true });
});
qaSeedRoutes.get("/parts/:hash/status", async (c) =>
  c.json({
    present: await c
      .get("seeds")
      .hasPart(c.req.param("hash"), Number(c.req.query("bytes"))),
  }),
);
qaSeedRoutes.get(
  "/parts/:hash",
  async (c) =>
    new Response(
      await c
        .get("seeds")
        .getPart(c.req.param("hash"), c.req.header("rio-seed-lease") || ""),
      {
        headers: {
          "content-type": "application/octet-stream",
          "cache-control": "no-store",
        },
      },
    ),
);
qaSeedRoutes.put("/parts/:hash", async (c) =>
  c.json(
    await c
      .get("seeds")
      .putPart(
        c.req.param("hash"),
        await bytes(c.req.raw, SEED_PART_BYTES),
        c.req.header("rio-seed-lease") || "",
      ),
  ),
);
qaSeedRoutes.get("/manifests/:fingerprint", async (c) => {
  const manifest = await c
    .get("seeds")
    .manifest(c.req.param("fingerprint"), c.req.header("rio-seed-lease") || "");
  return manifest
    ? c.json(manifest, 200, { "cache-control": "no-store" })
    : c.json({ error: "seed_missing" }, 404);
});
qaSeedRoutes.put("/manifests/:fingerprint", async (c) => {
  const manifest = await json(c.req.raw, SEED_MANIFEST_BYTES);
  if (manifest?.fingerprint?.fingerprint !== c.req.param("fingerprint"))
    throw new SeedError("seed_corrupt");
  return c.json(
    await c
      .get("seeds")
      .publish(manifest, c.req.header("rio-seed-lease") || ""),
  );
});
qaSeedRoutes.delete("/manifests/:fingerprint", async (c) => {
  await c
    .get("seeds")
    .invalidate(
      c.req.param("fingerprint"),
      c.req.header("rio-seed-lease") || "",
    );
  return c.json({ invalidated: true });
});
qaSeedRoutes.post("/prune", async (c) =>
  c.json({
    removed: await c.get("seeds").prune((await json(c.req.raw)).keep ?? 3),
  }),
);

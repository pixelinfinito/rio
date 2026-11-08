import type { Env, Submission } from "./types";
import {
  hash,
  invariant,
  validateGraph,
  validateSubmission,
} from "./validation";
import { SYMLINK, StoredSnapshot, lineCounts, materialize } from "./snapshot";
import { attachStatements } from "./lineage";
import { Store } from "./storage";
import { parseWall } from "./budget";
import { checkProfileModels } from "./gateway";

/**
 * Validates a submission against its immutable snapshot and starts its review.
 * `existing` names a review row created earlier in state `preparing` (PR mode);
 * it is filled in once and never twice.
 */
export async function createReview(
  env: Env,
  tenant: string,
  value: any,
  existing?: string,
): Promise<string> {
  validateSubmission(value);
  checkProfileModels(env, value.profile);
  const snapshotRow = await env.DB.prepare(
    "SELECT object_key FROM snapshots WHERE id=? AND tenant=?",
  )
    .bind(value.snapshot_id, tenant)
    .first<{ object_key: string }>();
  invariant(snapshotRow, "snapshot not found");
  const store = new Store(env),
    snapshot = await StoredSnapshot.open(env, snapshotRow.object_key);
  for (const version of ["base", "head"] as const) {
    const graph = value.graphs[version];
    invariant(
      graph && Array.isArray(graph.nodes) && graph.nodes.length <= 100000,
      "invalid graph",
    );
    validateGraph(
      graph,
      await lineCounts(
        snapshot[version],
        new Set(graph.nodes.map((n: any) => n?.path)),
      ),
    );
  }
  // Guidance is reproduced from immutable head, never accepted from mutable working state.
  const guidance = await materialize(
    snapshot.head,
    value.owner_guidance.map((g: any) => g.path),
  );
  for (const g of (value as Submission).owner_guidance) {
    const file = guidance[g.path];
    invariant(
      file &&
        file.mode !== SYMLINK &&
        !file.encoding &&
        ["REVIEW.md", "CLAUDE.md", "AGENTS.md"].includes(
          g.path.split("/").at(-1) ?? "",
        ) &&
        g.scope_dir === g.path.split("/").slice(0, -1).join("/") &&
        g.content_hash === hash(file.content) &&
        Array.isArray(g.lines) &&
        g.lines.join("\n") ===
          file.content.replace(/\r\n/g, "\n").replace(/\n$/, ""),
      "guidance does not match snapshot",
    );
  }
  // A prepared review's submission gets its own key, published by the row's
  // compare-and-set below, so a rejected second hand-off cannot replace it.
  const id = existing ?? crypto.randomUUID(),
    key = existing
      ? `reviews/${id}/prepared/${crypto.randomUUID()}/submission.json`
      : `reviews/${id}/submission.json`;
  await store.put(key, value);
  const active =
    value.mode === "deep"
      ? (value.profile.budget.deep ?? value.profile.budget.fast)
      : value.profile.budget.fast;
  const wall = parseWall(active.wall_time);
  invariant(wall <= 3600000, "review wall budget exceeds one hour");
  const now = Date.now();
  // The review and its lineage attachment (including a reset) commit together.
  const results = await env.DB.batch([
    existing
      ? env.DB.prepare(
          "UPDATE reviews SET submission_key=?,status='queued',token_limit=?,deadline=? WHERE id=? AND tenant=? AND status='preparing' AND submission_key=''",
        ).bind(key, active.tokens ?? 100000, now + wall, id, tenant)
      : env.DB.prepare(
          "INSERT INTO reviews(id,tenant,submission_key,status,created_at,token_limit,deadline) VALUES(?,?,?,'queued',?,?,?)",
        ).bind(id, tenant, key, now, active.tokens ?? 100000, now + wall),
    ...(value.lineage
      ? attachStatements(env, tenant, value.lineage, id, value.snapshot_id)
      : []),
  ]);
  invariant(results[0].meta.changes === 1, "review was already submitted");
  try {
    await env.REVIEWS.create({
      id,
      params: { review_id: id, snapshot_key: snapshotRow.object_key },
    });
  } catch {
    await env.DB.prepare(
      "UPDATE reviews SET status='error',error='workflow creation failed' WHERE id=?",
    )
      .bind(id)
      .run();
    throw new Error("workflow creation failed");
  }
  return id;
}

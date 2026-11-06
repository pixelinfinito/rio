import { env, introspectWorkflowInstance } from "cloudflare:test";
import { expect, it } from "vitest";
import migrations from "../src/migrations.json";

async function migrate(id: string) {
  const introspector = await introspectWorkflowInstance(
    (env as any).MIGRATIONS,
    id,
  );
  await (env as any).MIGRATIONS.create({ id, params: {} });
  await introspector.waitForStatus("complete");
}
async function tables(): Promise<string[]> {
  return (
    await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all<{ name: string }>()
  ).results.map((r) => r.name);
}
async function rejectsReason(reason: string) {
  await expect(
    env.DB.prepare(
      "INSERT INTO feedback(id,tenant,finding_id,reason,created_at) VALUES(?,?,?,?,?)",
    )
      .bind(crypto.randomUUID(), "owner", "f", reason, 1)
      .run(),
  ).rejects.toThrow(/CHECK constraint/);
}

it("applies forward migrations once and leaves no deployment lock", async () => {
  for (let i = 0; i < 2; i++) await migrate(`migration-${i}`);
  const ledger = await env.DB.prepare("SELECT name FROM rio_migrations").all();
  expect(ledger.results).toEqual(migrations.map((m) => ({ name: m.name })));
  expect(
    (await env.DB.prepare("SELECT * FROM rio_deploy_lock").all()).results,
  ).toEqual([]);
  expect(await tables()).toEqual(
    expect.arrayContaining([
      "reviews",
      "lineages",
      "lineage_reviews",
      "findings",
      "feedback",
    ]),
  );
  expect(await tables()).not.toContain("feedback_next");
  // The fresh feedback table accepts only the standardized reasons.
  for (const reason of ["false_positive", "known", "other"])
    await rejectsReason(reason);
  for (const reason of ["fixed", "wrong", "intentional", "irrelevant", "style"])
    await env.DB.prepare(
      "INSERT INTO feedback(id,tenant,finding_id,reason,created_at) VALUES(?,?,?,?,?)",
    )
      .bind(crypto.randomUUID(), "owner", "f", reason, 1)
      .run();
});

it("upgrades a v0.2 database and converts draft feedback reasons", async () => {
  // Simulate a database deployed with 0001 only, holding draft-era feedback rows.
  for (const table of [
    "rio_migrations",
    "rio_deploy_lock",
    "feedback",
    "findings",
    "lineage_reviews",
    "lineages",
  ])
    await env.DB.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  const core = migrations.find((m) => m.name === "0001_core.sql")!;
  for (const sql of core.statements.filter((s) => !/^PRAGMA/i.test(s)))
    await env.DB.prepare(sql).run();
  await env.DB.batch([
    env.DB.prepare(
      "CREATE TABLE rio_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
    ),
    env.DB.prepare(
      "INSERT INTO rio_migrations(name,applied_at) VALUES('0001_core.sql',1)",
    ),
    env.DB.prepare(
      "CREATE TABLE feedback (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, finding_id TEXT NOT NULL, reason TEXT NOT NULL, actor TEXT, note TEXT, created_at INTEGER NOT NULL)",
    ),
    ...[
      ["d1", "false_positive"],
      ["d2", "known"],
      ["d3", "style"],
    ].map(([id, reason]) =>
      env.DB.prepare(
        "INSERT INTO feedback(id,tenant,finding_id,reason,actor,note,created_at) VALUES(?,?,?,?,?,?,?)",
      ).bind(id, "owner", "f", reason, "dev", null, 1),
    ),
  ]);
  await migrate("migration-upgrade");
  expect(
    (
      await env.DB.prepare(
        "SELECT name FROM rio_migrations ORDER BY name",
      ).all()
    ).results,
  ).toEqual(migrations.map((m) => ({ name: m.name })));
  expect(
    (
      await env.DB.prepare(
        "SELECT id,reason,actor FROM feedback ORDER BY id",
      ).all()
    ).results,
  ).toEqual([
    { id: "d1", reason: "wrong", actor: "dev" },
    { id: "d2", reason: "intentional", actor: "dev" },
    { id: "d3", reason: "style", actor: "dev" },
  ]);
  await rejectsReason("known");
  expect(await tables()).toEqual(
    expect.arrayContaining(["lineages", "lineage_reviews", "findings"]),
  );
});

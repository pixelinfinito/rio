import { env, introspectWorkflowInstance } from "cloudflare:test";
import { expect, it } from "vitest";
import migrations from "../src/migrations.json";

it("applies forward migrations once and leaves no deployment lock", async () => {
  for (let i = 0; i < 2; i++) {
    const id = `migration-${i}`;
    const introspector = await introspectWorkflowInstance(
      (env as any).MIGRATIONS,
      id,
    );
    await (env as any).MIGRATIONS.create({ id, params: {} });
    await introspector.waitForStatus("complete");
  }
  const ledger = await env.DB.prepare("SELECT name FROM rio_migrations").all();
  expect(ledger.results).toEqual(migrations.map((m) => ({ name: m.name })));
  expect(
    (await env.DB.prepare("SELECT * FROM rio_deploy_lock").all()).results,
  ).toEqual([]);
  expect(
    (
      await env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE name='reviews'",
      ).all()
    ).results,
  ).toHaveLength(1);
});

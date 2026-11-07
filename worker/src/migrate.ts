import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import type { Env } from "./types";
import migrations from "./migrations.json";

// Only the account's Cloudflare API can start this workflow; there is no public SQL endpoint.
export class MigrationWorkflow extends WorkflowEntrypoint<Env, {}> {
  async run(_event: WorkflowEvent<{}>, step: WorkflowStep) {
    await step.do("bootstrap migration ledger", async () => {
      await this.env.DB.batch([
        this.env.DB.prepare(
          "CREATE TABLE IF NOT EXISTS rio_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
        ),
        this.env.DB.prepare(
          "CREATE TABLE IF NOT EXISTS rio_deploy_lock (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL)",
        ),
      ]);
    });
    for (const migration of migrations) {
      await step.do(`migrate ${migration.name}`, async () => {
        if (
          await this.env.DB.prepare(
            "SELECT name FROM rio_migrations WHERE name=?",
          )
            .bind(migration.name)
            .first()
        )
          return;
        // D1 batch is transactional. An overlapping deployment fails on the unique lock
        // or ledger entry and rolls back all statements; Workflow retries recheck the ledger.
        await this.env.DB.batch([
          this.env.DB.prepare(
            "INSERT INTO rio_deploy_lock(id,owner) VALUES(1,?)",
          ).bind(migration.name),
          ...migration.statements
            .filter((sql) => !/^PRAGMA/i.test(sql))
            .map((sql) => this.env.DB.prepare(sql)),
          this.env.DB.prepare(
            "INSERT INTO rio_migrations(name,applied_at) VALUES(?,?)",
          ).bind(migration.name, Date.now()),
          this.env.DB.prepare("DELETE FROM rio_deploy_lock WHERE id=1"),
        ]);
      });
    }
    return { applied: migrations.map((m) => m.name) };
  }
}

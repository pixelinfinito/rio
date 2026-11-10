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

// 0004_pr_mode: suppressions carry origin, status and evidence; history counts start at one.
async function prModeConstraints() {
  const proposal = (id: string, status: string, origin = "proposed") =>
    env.DB.prepare(
      "INSERT INTO suppressions(id,tenant,repository,origin,status,entry_json,evidence_json,evidence_count,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
    )
      .bind(id, "owner", "o/r", origin, status, `{"rule":"${id}"}`, "[]", 3, 1)
      .run();
  for (const status of ["proposed", "applied", "declined"])
    await proposal(`s-${status}`, status);
  await expect(proposal("s-bad", "suppressed")).rejects.toThrow(/CHECK/);
  await expect(proposal("s-manual", "proposed", "manual")).rejects.toThrow(
    /CHECK/,
  );
  await expect(
    env.DB.prepare(
      "INSERT INTO finding_history(tenant,repository,identity,rule_id,first_seen_review,last_seen_review,seen_count,status,location_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
      .bind("owner", "o/r", "f", "r", "a", "a", 0, "open", "{}", 1)
      .run(),
  ).rejects.toThrow(/CHECK/);
  await expect(
    env.DB.prepare(
      "INSERT INTO publications(tenant,lineage_id,identity,review_id,kind,state,updated_at) VALUES(?,?,?,?,?,?,?)",
    )
      .bind("owner", "l", "f", "r", "finding", "duplicated", 1)
      .run(),
  ).rejects.toThrow(/CHECK/);
}

// 0005_registry_integrity: sighting ledger, status versions, feedback provenance.
async function registryColumns() {
  const columns = async (table: string) =>
    (
      await env.DB.prepare(`PRAGMA table_info(${table})`).all<{
        name: string;
      }>()
    ).results.map((c) => c.name);
  expect(await columns("finding_history")).toEqual(
    expect.arrayContaining([
      "seen_code_hash",
      "first_seen_at",
      "last_seen_at",
      "status_at",
    ]),
  );
  expect(await columns("feedback")).toContain("repository");
  const sighting = () =>
    env.DB.prepare(
      "INSERT INTO finding_sightings(tenant,repository,identity,review_id,seen_at) VALUES('owner','o/r','f','r1',1)",
    ).run();
  await sighting();
  await expect(sighting()).rejects.toThrow(/UNIQUE|PRIMARY/);
}

// 0007_council: one audit row per finding, member and round; never pack content.
async function councilAssessments() {
  const row = (
    member: string,
    round: number,
    abstained = 0,
    key: string | null = "k",
  ) =>
    env.DB.prepare(
      "INSERT INTO council_assessments(review_id,tenant,finding_id,member,round,assessment_key,abstained,cause,vendor,model,pack_hash,pack_bytes,rendering_hash,rendering_bytes,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        "r-council",
        "owner",
        "f",
        member,
        round,
        key,
        abstained,
        abstained ? "timeout" : null,
        "openai",
        "gpt-6.1",
        "p",
        10,
        "q",
        12,
        1,
      )
      .run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO reviews(id,tenant,submission_key,status,created_at,token_limit,deadline) VALUES('r-council','owner','s','complete',1,1,1)",
  ).run();
  await row("skeptic", 1);
  await row("tester", 2, 1, null);
  await expect(row("skeptic", 1)).rejects.toThrow(/UNIQUE|PRIMARY/);
  await expect(row("judge", 1)).rejects.toThrow(/CHECK/);
  await expect(row("maintainer", 3)).rejects.toThrow(/CHECK/);
  // Retention clears the assessment key; the audit row stays.
  await row("code-owner", 1, 0, null);
  await expect(
    env.DB.prepare(
      "UPDATE council_assessments SET cause='timeout' WHERE member='code-owner'",
    ).run(),
  ).rejects.toThrow(/CHECK/);
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
      "contents",
      "installations",
      "deliveries",
      "publications",
      "finding_history",
      "suppressions",
      "agent_cache",
      "finding_sightings",
      "council_assessments",
    ]),
  );
  expect(await tables()).not.toContain("feedback_next");
  await registryColumns();
  await councilAssessments();
  await prModeConstraints();
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
    "contents",
    "installations",
    "deliveries",
    "publications",
    "publication_leases",
    "pull_requests",
    "finding_history",
    "suppressions",
    "agent_cache",
    "finding_sightings",
    "council_assessments",
    "runner_capabilities",
    "jobs",
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
    expect.arrayContaining([
      "lineages",
      "lineage_reviews",
      "findings",
      "contents",
      "installations",
      "deliveries",
      "publications",
      "finding_history",
      "suppressions",
      "agent_cache",
      "finding_sightings",
      "council_assessments",
    ]),
  );
  await prModeConstraints();
  await councilAssessments();
  const jobColumns = (
    await env.DB.prepare("PRAGMA table_info(jobs)").all<{ name: string }>()
  ).results.map((c) => c.name);
  expect(jobColumns).toContain("kind");
  expect(await tables()).toContain("runner_capabilities");
  await registryColumns();
});

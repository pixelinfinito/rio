import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/index";
import { renderSarif } from "../src/sarif";
import { Store } from "../src/storage";
import { hash } from "../src/validation";
import { allMigrations } from "./fixtures";
import type { Env } from "../src/types";
// The fixtures rio-core renders too (crates/rio-core/tests/sarif.rs): each
// renderer must reproduce expected.sarif, so the two are equal to each other.
import completeReport from "../../tests/fixtures/sarif/complete-review/report.json";
import completeRender from "../../tests/fixtures/sarif/complete-review/render.json";
import completeExpected from "../../tests/fixtures/sarif/complete-review/expected.sarif?raw";
import errorReport from "../../tests/fixtures/sarif/error-status/report.json";
import errorRender from "../../tests/fixtures/sarif/error-status/render.json";
import errorExpected from "../../tests/fixtures/sarif/error-status/expected.sarif?raw";
import lineageReport from "../../tests/fixtures/sarif/lineage-history/report.json";
import lineageRender from "../../tests/fixtures/sarif/lineage-history/render.json";
import lineageExpected from "../../tests/fixtures/sarif/lineage-history/expected.sarif?raw";
import risksReport from "../../tests/fixtures/sarif/risks-and-plausible/report.json";
import risksRender from "../../tests/fixtures/sarif/risks-and-plausible/render.json";
import risksExpected from "../../tests/fixtures/sarif/risks-and-plausible/expected.sarif?raw";

const runtime = env as Env;
beforeAll(async () => {
  await applyD1Migrations(runtime.DB, allMigrations);
});
const cases = {
  "complete-review": [completeReport, completeRender, completeExpected],
  "error-status": [errorReport, errorRender, errorExpected],
  "lineage-history": [lineageReport, lineageRender, lineageExpected],
  "risks-and-plausible": [risksReport, risksRender, risksExpected],
} as const;

/** Canonical key order, as the mapping's byte-identity rule compares. */
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}

describe("SARIF renderer", () => {
  for (const [name, [report, render, expected]] of Object.entries(cases))
    it(`reproduces ${name} byte for byte after canonical ordering`, () => {
      const rendered = renderSarif(structuredClone(report), render as any);
      expect(JSON.stringify(canonical(rendered), null, 2)).toBe(
        JSON.stringify(canonical(JSON.parse(expected)), null, 2),
      );
    });

  it("leaves pre-existing entries out unless asked and never reads remembered findings", () => {
    const report: any = structuredClone(completeReport);
    const pre = report.findings.filter((f: any) => f.state === "pre-existing");
    expect(pre.length).toBeGreaterThan(0);
    const ids = (log: any) =>
      log.runs[0].results.map((r: any) => [
        r.partialFingerprints["rioFindingId/v1"],
        r.baselineState,
      ]);
    const plain = renderSarif(report, completeRender as any);
    for (const f of pre)
      expect(ids(plain).map(([id]: any) => id)).not.toContain(f.id);
    const shown = renderSarif(report, {
      ...(completeRender as any),
      include_pre_existing: true,
    });
    for (const f of pre) expect(ids(shown)).toContainEqual([f.id, "unchanged"]);
    report.remembered = [{ ...report.findings[0], id: "9".repeat(64) }];
    expect(
      JSON.stringify(renderSarif(report, completeRender as any)),
    ).not.toContain("9".repeat(64));
  });
});

describe("GET /v1/reviews/{id}/report?format=sarif", () => {
  const owner = {
    authorization: "Bearer test-owner-token-at-least-32-characters",
    "rio-protocol": "1",
  };
  it("renders the stored report with the review's times and no exit code", async () => {
    const id = crypto.randomUUID(),
      key = `reviews/${id}/report.json`;
    await new Store(runtime).put(key, lineageReport);
    const created = Date.parse("2026-11-07T12:00:00Z"),
      finished = Date.parse("2026-11-07T12:02:05Z");
    await runtime.DB.batch([
      runtime.DB.prepare(
        "INSERT INTO reviews(id,tenant,submission_key,status,report_key,created_at,token_limit,deadline) VALUES(?,?,?,'complete',?,?,?,?)",
      ).bind(id, "owner", `reviews/${id}/submission.json`, key, created, 1, 1),
      runtime.DB.prepare(
        "INSERT INTO events(review_id,event,data,created_at) VALUES(?,?,?,?)",
      ).bind(id, "review:done", "{}", finished),
    ]);
    const response = await app.request(
      `https://rio/v1/reviews/${id}/report?format=sarif`,
      { headers: owner },
      runtime,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(
      "application/sarif+json",
    );
    // The fixture's render inputs are the endpoint's: these times and null.
    expect(canonical(await response.json())).toEqual(
      canonical(JSON.parse(lineageExpected)),
    );
    const json = await app.request(
      `https://rio/v1/reviews/${id}/report`,
      { headers: owner },
      runtime,
    );
    expect(await json.json()).toEqual(lineageReport);
    const bad = await app.request(
      `https://rio/v1/reviews/${id}/report?format=xml`,
      { headers: owner },
      runtime,
    );
    expect(bad.status).toBe(400);
    // Another tenant cannot read it in any format.
    const token = "a-sarif-reader-of-another-tenant-32";
    await runtime.DB.prepare(
      "INSERT INTO api_tokens(hash,tenant,scope,expires_at) VALUES(?,?,?,?)",
    )
      .bind(hash(token), "other", "reviews:read", Date.now() + 60000)
      .run();
    const other = await app.request(
      `https://rio/v1/reviews/${id}/report?format=sarif`,
      { headers: { ...owner, authorization: `Bearer ${token}` } },
      runtime,
    );
    expect(other.status).toBe(400);
    expect(await other.json()).toEqual({ error: "review not found" });
  });
});

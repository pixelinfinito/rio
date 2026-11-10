import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import { app } from "../src/index";
import {
  loadRecommendationHistory,
  rememberRecommendations,
  recommendationContinuity,
  dismissRecommendation,
} from "../src/qa-recommendation-history";
import {
  recommendationId,
  selectRecommendations,
  type Recommendation,
} from "../src/qa-recommendations";
import { allMigrations } from "./fixtures";
import fixture from "../../crates/rio-core/tests/qa-fixtures/report.json";
import type { Env } from "../src/types";

const runtime = env as Env;
beforeAll(() => applyD1Migrations(runtime.DB, allMigrations));
const candidate = () =>
  structuredClone(fixture.qa.recommendations[0]) as Recommendation;
const dismissal = {
  reason: "intentional" as const,
  actor: "owner",
  at: "2026-11-09T00:00:00Z",
  note: "Separate billing entry is required.",
};

it("retains the full pool, honors dismissal after wording/cell changes and records missing observations without claiming a fix", async () => {
  const repository = "history",
    original = candidate(),
    id = recommendationId(original);
  await rememberRecommendations(runtime, "owner", repository, "first", 1, [
    original,
  ]);
  expect(
    await dismissRecommendation(runtime, "owner", repository, id, dismissal),
  ).toBe(true);
  const changed = candidate();
  changed.cells = [{ viewport: "desktop", color_scheme: "dark" }];
  changed.observed_friction = "Different wording for the same friction";
  const history = await loadRecommendationHistory(runtime, "owner", repository);
  const audit = recommendationContinuity([changed], history);
  expect(audit.records[0]).toMatchObject({
    assessment: "reassessed",
    previous_review: "first",
    candidate: { dismissal },
  });
  expect(selectRecommendations(audit.candidates).recommendations).toEqual([]);
  expect(selectRecommendations(audit.candidates).held_back).toBe(0);
  await rememberRecommendations(runtime, "owner", repository, "second", 2, [
    changed,
  ]);
  const missing = recommendationContinuity(
    [],
    await loadRecommendationHistory(runtime, "owner", repository),
  );
  expect(missing.candidates).toEqual([]);
  expect(missing.records[0]).toMatchObject({
    assessment: "not_assessed",
    previous_review: "second",
    candidate: { observed_friction: changed.observed_friction, dismissal },
  });
});

it("is replay-idempotent, preserves a concurrent dismissal and never replaces a newer review with an older finishing run", async () => {
  const repository = "concurrent",
    original = candidate(),
    id = recommendationId(original);
  await rememberRecommendations(runtime, "owner", repository, "newer", 20, [
    original,
  ]);
  await dismissRecommendation(runtime, "owner", repository, id, dismissal);
  const stale = { ...candidate(), observed_friction: "stale version" };
  for (let i = 0; i < 2; i++)
    await rememberRecommendations(runtime, "owner", repository, "older", 10, [
      stale,
    ]);
  await rememberRecommendations(runtime, "owner", repository, "newer", 20, [
    stale,
  ]);
  const [row] = await loadRecommendationHistory(runtime, "owner", repository);
  expect(row.last_review).toBe("newer");
  expect(JSON.parse(row.candidate_json).observed_friction).toBe(
    original.observed_friction,
  );
  expect(JSON.parse(row.dismissal_json!)).toEqual(dismissal);
  expect(
    (
      await runtime.DB.prepare(
        "SELECT COUNT(*) AS n FROM qa_recommendation_sightings WHERE repository=?",
      )
        .bind(repository)
        .first<any>()
    ).n,
  ).toBe(2);
});

it("scopes the authenticated dismissal endpoint to tenant and repository and leaves findings untouched", async () => {
  const original = candidate(),
    id = recommendationId(original);
  for (const [tenant, repository] of [
    ["owner", "mine"],
    ["owner", "another"],
    ["other-tenant", "mine"],
  ])
    await rememberRecommendations(runtime, tenant, repository, "first", 1, [
      original,
    ]);
  const post = (
    repository: string,
    reason = "intentional",
    token = "test-owner-token-at-least-32-characters",
  ) =>
    app.request(
      `https://rio/v1/qa/recommendations/${id}/feedback`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "rio-protocol": "1",
        },
        body: JSON.stringify({ repository, reason, note: dismissal.note }),
      },
      runtime,
    );
  const before = await runtime.DB.prepare(
    "SELECT COUNT(*) AS n FROM finding_history",
  ).first<any>();
  expect((await post("mine")).status).toBe(200);
  expect(
    (await loadRecommendationHistory(runtime, "owner", "mine"))[0]
      .dismissal_json,
  ).not.toBeNull();
  expect(
    (await loadRecommendationHistory(runtime, "owner", "another"))[0]
      .dismissal_json,
  ).toBeNull();
  expect(
    (await loadRecommendationHistory(runtime, "other-tenant", "mine"))[0]
      .dismissal_json,
  ).toBeNull();
  expect((await post("missing")).status).toBe(404);
  expect((await post("mine", "fixed")).status).toBe(400);
  expect((await post("mine", "intentional", "invalid")).status).toBe(401);
  expect(
    await runtime.DB.prepare(
      "SELECT COUNT(*) AS n FROM finding_history",
    ).first<any>(),
  ).toEqual(before);
});

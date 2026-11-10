import type { Env } from "./types";
import { recommendationId, type Recommendation } from "./qa-recommendations";

type Dismissal = NonNullable<Recommendation["dismissal"]>;
export interface RecommendationHistory {
  identity: string;
  last_review: string;
  last_seen_at: number;
  candidate_json: string;
  dismissal_json: string | null;
}

export async function loadRecommendationHistory(
  env: Env,
  tenant: string,
  repository: string,
) {
  return (
    await env.DB.prepare(
      "SELECT identity,last_review,last_seen_at,candidate_json,dismissal_json FROM qa_recommendation_history WHERE tenant=? AND repository=? ORDER BY identity",
    )
      .bind(tenant, repository)
      .all<RecommendationHistory>()
  ).results;
}

/** Current observations and owner responses remain in the audit even when the
 * report excludes them. Absence is never interpreted as a product improvement. */
export function recommendationContinuity(
  candidates: Recommendation[],
  history: RecommendationHistory[],
) {
  const current = new Map(
    candidates.map((candidate) => {
      const value = structuredClone(candidate);
      value.id = recommendationId(value);
      delete value.dismissal;
      return [value.id, value] as const;
    }),
  );
  const records: {
    id: string;
    assessment: "reassessed" | "not_assessed";
    candidate: Recommendation;
    previous_review?: string;
  }[] = [];
  for (const prior of history) {
    const candidate = current.get(prior.identity);
    const value =
      candidate ?? (JSON.parse(prior.candidate_json) as Recommendation);
    if (prior.dismissal_json)
      value.dismissal = JSON.parse(prior.dismissal_json);
    records.push({
      id: prior.identity,
      assessment: candidate ? "reassessed" : "not_assessed",
      candidate: value,
      previous_review: prior.last_review,
    });
    current.delete(prior.identity);
  }
  for (const [id, candidate] of current)
    records.push({ id, assessment: "reassessed", candidate });
  return {
    records,
    candidates: records
      .filter((row) => row.assessment === "reassessed")
      .map((row) => row.candidate),
  };
}

/** Idempotent per review, ordered by review creation rather than finish time.
 * A running review can never overwrite an owner dismissal. */
export async function rememberRecommendations(
  env: Env,
  tenant: string,
  repository: string,
  review: string,
  seenAt: number,
  candidates: Recommendation[],
) {
  const unique = new Map(
    candidates.map((candidate) => [recommendationId(candidate), candidate]),
  );
  for (const [identity, value] of unique) {
    const candidate = structuredClone(value);
    candidate.id = identity;
    delete candidate.dismissal;
    const document = JSON.stringify(candidate);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO qa_recommendation_sightings(tenant,repository,identity,review_id,seen_at,candidate_json) VALUES(?,?,?,?,?,?) ON CONFLICT(tenant,repository,identity,review_id) DO NOTHING",
      ).bind(tenant, repository, identity, review, seenAt, document),
      env.DB.prepare(
        `INSERT INTO qa_recommendation_history(tenant,repository,identity,first_review,first_seen_at,last_review,last_seen_at,candidate_json) SELECT tenant,repository,identity,review_id,seen_at,review_id,seen_at,candidate_json FROM qa_recommendation_sightings WHERE tenant=? AND repository=? AND identity=? AND review_id=? ON CONFLICT(tenant,repository,identity) DO UPDATE SET
        first_review=CASE WHEN excluded.first_seen_at<qa_recommendation_history.first_seen_at OR (excluded.first_seen_at=qa_recommendation_history.first_seen_at AND excluded.first_review<qa_recommendation_history.first_review) THEN excluded.first_review ELSE qa_recommendation_history.first_review END,
        first_seen_at=MIN(excluded.first_seen_at,qa_recommendation_history.first_seen_at),
        last_review=CASE WHEN excluded.last_seen_at>qa_recommendation_history.last_seen_at OR (excluded.last_seen_at=qa_recommendation_history.last_seen_at AND excluded.last_review>qa_recommendation_history.last_review) THEN excluded.last_review ELSE qa_recommendation_history.last_review END,
        candidate_json=CASE WHEN excluded.last_seen_at>qa_recommendation_history.last_seen_at OR (excluded.last_seen_at=qa_recommendation_history.last_seen_at AND excluded.last_review>qa_recommendation_history.last_review) THEN excluded.candidate_json ELSE qa_recommendation_history.candidate_json END,
        last_seen_at=MAX(excluded.last_seen_at,qa_recommendation_history.last_seen_at)`,
      ).bind(tenant, repository, identity, review),
    ]);
  }
}

export async function dismissRecommendation(
  env: Env,
  tenant: string,
  repository: string,
  identity: string,
  response: Dismissal,
) {
  const result = await env.DB.prepare(
    "UPDATE qa_recommendation_history SET dismissal_json=? WHERE tenant=? AND repository=? AND identity=?",
  )
    .bind(JSON.stringify(response), tenant, repository, identity)
    .run();
  return result.meta.changes === 1;
}

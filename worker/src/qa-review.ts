/** Durable workflow integration for the QA-specific verifier. */
import {
  qaEvidencePack,
  verifyQaCandidate,
  verifyQaRecommendation,
  type QaCandidate,
  type QaPack,
  type BrowserArtifact,
  type LoadedArtifact,
  type ReplayResult,
  onceQaReplay,
} from "./qa-verifier";
import {
  ingestRecommendation,
  selectRecommendations,
  type RecommendationContext,
} from "./qa-recommendations";
import { compareQaResults } from "./qa-results";
import { canonical } from "./validation";
import { finding as validFinding } from "./validators.generated.js";
import type { VerifyOptions } from "./verifier";
import type { Finding } from "./types";

type Options = Pick<
  VerifyOptions,
  | "profile"
  | "gateway"
  | "ledger"
  | "verifyTokens"
  | "call"
  | "cancelled"
  | "tools"
  | "context"
> & {
  snapshot: import("./snapshot").SnapshotReader;
  result: any;
  // The verifier model's partition and the review's hint classes (design D16).
  prompt?: { partition?: string; cache?: { classes: string[]; key?: string } };
  load: (
    artifact: BrowserArtifact,
    version?: "head" | "base",
  ) => Promise<LoadedArtifact | null>;
  save: (key: string, value: unknown) => Promise<unknown>;
  replay?: (
    candidate: QaCandidate,
    version: "head" | "base",
  ) => Promise<ReplayResult>;
};
/** One attempt for the hypothesis across every cell, snapshot and voter. The
 * scope stays attached, so reuse can never prove recurrence in another cell. */
export function qaReplayRegistry(run: NonNullable<Options["replay"]>) {
  const attempts = new Map<string, () => Promise<ReplayResult>>();
  return (candidate: QaCandidate, version: "head" | "base") => {
    const id = candidate.finding.id;
    let attempt = attempts.get(id);
    if (!attempt) {
      const frozen = structuredClone(candidate);
      attempt = onceQaReplay(async () => ({
        ...(await run(frozen, version)),
        scope: {
          version,
          journey: frozen.finding.qa.journey,
          step: frozen.finding.qa.step,
          cell: frozen.cell,
        },
      }));
      attempts.set(id, attempt);
    }
    return attempt();
  };
}
export async function verifyQaReview(o: Options) {
  const replay = o.replay ? qaReplayRegistry(o.replay) : undefined;
  const collect = (result: any) => {
    const uniqueCandidates = new Map<string, QaCandidate>();
    for (const candidate of (result.observation_candidates ??
      []) as QaCandidate[]) {
      const key = canonical([candidate.finding?.id, candidate.cell]);
      const prior = uniqueCandidates.get(key);
      if (prior && Array.isArray(candidate.finding?.evidence)) {
        prior.finding.evidence = [
          ...new Set([
            ...prior.finding.evidence,
            ...candidate.finding.evidence,
          ]),
        ].sort();
        for (const location of candidate.finding.locations ?? []) {
          const same = prior.finding.locations.find(
            (row) => canonical(row.cell) === canonical(location.cell),
          );
          if (same)
            same.evidence = [
              ...new Set([
                ...(same.evidence ?? []),
                ...(location.evidence ?? []),
              ]),
            ].sort();
        }
      } else uniqueCandidates.set(key, structuredClone(candidate));
    }
    return uniqueCandidates;
  };
  const headCandidates = collect(o.result),
    baseCandidates = collect(o.result.baseline ?? {});
  const candidates = new Map([...baseCandidates, ...headCandidates]);
  const findingRows: Finding[] = [],
    baseFindings: Finding[] = [],
    headAssessed: any[] = [],
    baseAssessed: any[] = [],
    decisions: any[] = [],
    recommendations: any[] = [];
  const unresolved = new Set<string>();
  const resolved = new Set<string>();
  const observationKey = (row: any) =>
    canonical([
      row.rule_id,
      row.journey,
      row.step,
      row.cell,
      row.expected,
      row.observed,
    ]);
  let incomplete = false;
  const packs = new Map<string, Promise<QaPack>>();
  const packFor = (
    journey: string,
    steps: number[],
    cell: any,
    version: "head" | "base" = "head",
  ) => {
    const key = canonical([journey, steps, cell, version]);
    let pack = packs.get(key);
    if (!pack) {
      pack = qaEvidencePack({
        result: version === "base" ? o.result.baseline : o.result,
        journey,
        steps,
        cell,
        load: (artifact) => o.load(artifact, version),
      });
      packs.set(key, pack);
    }
    return pack;
  };
  for (const [identity, original] of candidates) {
    if (
      !validFinding(original.finding) ||
      original.finding.category !== "ux" ||
      !original.finding.qa ||
      !original.expected ||
      !original.observed
    ) {
      incomplete = true;
      decisions.push({ error: "invalid_observation_candidate" });
      continue;
    }
    for (const version of (o.result.baseline ? ["head", "base"] : ["head"]) as (
      "head" | "base"
    )[]) {
      const actual = (version === "head" ? headCandidates : baseCandidates).get(
        identity,
      );
      const candidate = structuredClone(actual ?? original),
        f = candidate.finding;
      const key = observationKey({
        ...f.qa,
        rule_id: f.rule_id,
        cell: candidate.cell,
        expected: candidate.expected,
        observed: candidate.observed,
      });
      try {
        const run = version === "base" ? o.result.baseline : o.result;
        const outcome = (run.journey_outcomes ?? []).find(
          (row: any) =>
            row.journey === f.qa.journey &&
            canonical(row.cell) === canonical(candidate.cell),
        );
        // A missing/unfinished counterpart is unknown, never a clean baseline.
        if (
          (version === "base" || !actual) &&
          !["passed", "failed"].includes(outcome?.outcome)
        ) {
          decisions.push({
            id: f.id,
            cell: candidate.cell,
            version,
            error: "comparison_cell_unfinished",
          });
          continue;
        }
        const pack = await packFor(
          f.qa.journey,
          [f.qa.step],
          candidate.cell,
          version,
        );
        {
          const evidence = [...pack.artifacts.values()]
            .filter(
              (row) =>
                row.step === f.qa.step ||
                (row.kind === "trace" && row.step === undefined),
            )
            .map((row) => row.id);
          if (!evidence.length) {
            decisions.push({
              id: f.id,
              cell: candidate.cell,
              version,
              error: "comparison_evidence_unavailable",
            });
            continue;
          }
          f.evidence = evidence;
          f.locations = f.locations
            .filter((row) => canonical(row.cell) === canonical(candidate.cell))
            .map((row) => ({ ...row, evidence }));
        }
        const result = await verifyQaCandidate({
          ...o,
          candidate,
          pack,
          version,
          replay: replay ? () => replay(candidate, version) : undefined,
          save: (vote) =>
            o
              .save(
                `${version === "base" ? "baseline/" : ""}votes/${f.id}/${candidate.cell.viewport}-${candidate.cell.color_scheme}/${vote.voter}.json`,
                vote,
              )
              .then(() => {}),
        });
        decisions.push({ id: f.id, cell: candidate.cell, version, ...result });
        if (result.finding) {
          if (version === "head" && actual) resolved.add(key);
          if (result.finding.evidence_level !== "refuted") {
            if (version === "head" || !result.finding.verification?.split)
              (version === "head" ? findingRows : baseFindings).push(
                result.finding,
              );
          } else if (!result.finding.verification?.split)
            (version === "head" ? headAssessed : baseAssessed).push({
              rule_id: f.rule_id,
              journey: f.qa.journey,
              step: f.qa.step,
              cell: candidate.cell,
            });
        } else if (version === "head" && actual) unresolved.add(key);
        incomplete ||= result.incomplete;
      } catch (error) {
        incomplete = true;
        if (version === "head" && actual) unresolved.add(key);
        decisions.push({
          id: f.id,
          cell: candidate.cell,
          version,
          error: String(error),
        });
      }
    }
  }
  // Merge only independently verified cells. An unverified cell remains in the
  // observation section rather than inheriting another cell's verdict.
  const merged = new Map<string, Finding>();
  const rank = { plausible: 1, static_proven: 2, reproduced: 3, refuted: 0 };
  for (const row of findingRows) {
    const prior = merged.get(row.id);
    if (!prior) {
      merged.set(row.id, structuredClone(row));
      continue;
    }
    prior.locations.push(...row.locations);
    prior.evidence = [...new Set([...prior.evidence, ...row.evidence])].sort();
    if (rank[row.evidence_level] < rank[prior.evidence_level])
      prior.evidence_level = row.evidence_level;
    if (prior.state !== row.state)
      prior.state =
        prior.state === "unclassified" || row.state === "unclassified"
          ? "unclassified"
          : "worsened";
    if (prior.verification && row.verification) {
      prior.verification.agreeing = Math.min(
        prior.verification.agreeing,
        row.verification.agreeing,
      );
      prior.verification.split ||= row.verification.split;
    }
  }
  // Consolidate cells before voting: a stable recommendation identity gets one
  // independent quorum, and durable call keys cannot reuse another cell's vote.
  const recommendationCandidates = selectRecommendations(
    o.result.qa_recommendations ?? [],
    { max: Number.MAX_SAFE_INTEGER },
  ).recommendations;
  for (const raw of recommendationCandidates) {
    try {
      const packs = await Promise.all(
        raw.cells.map((cell: any) => packFor(raw.journey, raw.steps, cell)),
      );
      const pack: QaPack = {
        ...packs[0],
        journey: {
          ...packs[0].journey,
          cell_variants: packs.map((pack, index) => ({
            cell: raw.cells[index],
            journey: pack.journey,
          })),
        },
        guidance: [
          ...new Map(
            packs
              .flatMap((pack) => pack.guidance)
              .map((doc) => [canonical([doc.path, doc.content_hash]), doc]),
          ).values(),
        ],
        criteria: [
          ...new Map(
            packs
              .flatMap((pack) => pack.criteria)
              .map((rule) => [rule.id, rule]),
          ).values(),
        ],
        artifacts: new Map(packs.flatMap((p) => [...p.artifacts])),
        loaded: new Map(packs.flatMap((p) => [...p.loaded])),
        toolCalls: packs.flatMap((p) => p.toolCalls),
        beforeUnavailable: packs.some((p) => p.beforeUnavailable),
      };
      const context: RecommendationContext = {
        artifacts: pack.artifacts as RecommendationContext["artifacts"],
        guidance: pack.guidance,
        sourcePaths: pack.guidance.map(
          (doc) => `${doc.scope_dir ? doc.scope_dir + "/" : ""}__qa_scope__`,
        ),
        criteria: new Map(
          pack.criteria
            .filter((rule) => rule.source)
            .map((rule) => [rule.id, rule]),
        ),
        findings: new Map(
          [...merged.values(), ...(o.result.findings ?? [])].map((finding) => [
            finding.id,
            finding,
          ]),
        ),
      };
      const ingested = ingestRecommendation(raw, context);
      if (!ingested.candidate) {
        recommendations.push({ candidate: raw, dropped: ingested.dropped });
        continue;
      }
      const result = await verifyQaRecommendation({
        ...o,
        candidate: ingested.candidate,
        pack,
        context,
        save: (vote) =>
          o
            .save(
              `recommendation-votes/${ingested.candidate!.id}/${vote.voter}.json`,
              vote,
            )
            .then(() => {}),
      });
      recommendations.push(result);
    } catch (error) {
      recommendations.push({
        candidate: {
          ...raw,
          verification_status: "unverified",
          rationale:
            "Verification deferred: captured evidence or verifier context unavailable; expected benefit remains untested.",
        },
        error: String(error),
      });
    }
  }
  await o.save("verification.json", decisions);
  await o.save("recommendations.json", recommendations);
  let findings = [...merged.values()];
  if (o.result.baseline) {
    findings = compareQaResults(
      { findings, probe_assessments: headAssessed },
      { findings: baseFindings, probe_assessments: baseAssessed },
    ).findings;
  }
  const observations = (o.result.hypotheses ?? []).filter(
    (row: any) =>
      !resolved.has(observationKey(row)) || unresolved.has(observationKey(row)),
  );
  return {
    findings,
    observations,
    recommendations: recommendations
      .filter((row) => !row.dropped)
      .map((row) => row.candidate),
    incomplete: incomplete || observations.length > 0,
  };
}

## Why

After the verifier quorum (`rio-v0-2-verifier`), a residue of findings remains that the verifier cannot settle: `plausible` findings with high severity, hypotheses the voters split on, changes triaged as high risk, and deep or nightly runs where the budget allows a second opinion. For that residue, one more pass from the same model family adds little, because the voters share its blind spots. This change adds `rio/council`: five members from different model families and vendors assess a finding independently from an identical evidence pack, exchange one structured round, and a deterministic aggregator decides from evidence tiers, never from vote counts. The step is expected to run on 5–10 % of findings and stays only while it beats the verifier-only baseline. It implements PRD R30.

**Scope assumption.** Depends on the v0.2 endpoint, the verifier quorum and the self-hosted runner. PR-mode publishing of the council note depends on the GitHub App change. The step is off in `rio/base` and on in the `security` and `critical` profiles.

## What Changes

- **New step `rio/council`** after `rio/verify`, with profile block `council: { members, max_experiments, max_rounds, min_members, vendors_allowed }` and trigger rules in the step's `rules`: `evidence == plausible && severity >= high`, `verify.split`, `risk_tier == high`, `mode == deep`, `nightly`.
- **New module kind `member`** in module manifest v1: `provider`, `model`, `prompt`, `context_pack` (`diff-only | graph-heavy | execution`), `role` (`skeptic | exploit-author | code-owner | maintainer | tester`), `weight`, output schema `council-assessment-v1`. At most one member may share the model family of the PR author when the author is an agent; the author family is read from PR metadata when available.
- **Identical evidence pack** for every member: the hypothesis, the graph slice, base and head of the affected files, and the verifier's artifacts. Members get no live tools. A member may request one experiment in structured form; Rio runs at most `max_experiments` (default 2) as runner jobs and shares results in round 2.
- **New schema `schemas/council-assessment-v1.json`**: `real`, `introduced_by_change`, `impact`, `basis`, `evidence_refs[]`, optional `experiment_request`, and the round-2 position-change fields. Assessments without evidence refs or failing validation count as abstentions.
- **Round 2** (`max_rounds: 2`): members see anonymized assessments and may change position only by citing an artifact or a concrete flaw in another assessment, through structured fields with no free prose.
- **Deterministic aggregator**: per-member weights learned from the eval set (precision and recall per member and category, re-estimated from feedback); decision by weighted evidence tier: an experiment failing on head and passing on base → `reproduced`; a found protection → `refuted`; otherwise `plausible` with a council note for human judgment. Agreement count is never evidence.
- **Degradation**: the step runs with whoever answers within the timeout, minimum `min_members` (default 3 of 5), reports `council: partial (n/5)`, and never blocks a review on a vendor.
- **Data governance**: per-repo allowlist of council vendors, self-hosted open-weights members through the self-hosted runner, and an audit record of which content went to which vendor. `rio init` gains an opt-in council step after the primary provider.
- **Metrics in `eval/`**: council disagreement rate (members agreeing more than 95 % of the time removes the step), promotion and refutation accuracy on the `plausible` bucket versus the verifier-only baseline (A/B on the same cases), cost per finding (members × rounds × experiments).
- **Report**: a council section per council-reviewed finding (decision, tier, participating members by role, experiments run, note), the partial marker, and cost in the footer.

Nothing is breaking. profile-v1 gains the optional `council` block; module-v1 gains the `member` kind; finding-v1 gains the optional `council` block; report-v1 gains `council` metrics. `council-assessment-v1.json` is new.

## Capabilities

### New Capabilities
- `council`: triggers, the evidence pack, member isolation, experiments, round 2 rules, the deterministic aggregator, degradation, and the report section.
- `council-members`: the `member` module kind, context packs, roles, weights, the author-family rule, and the self-hosted open-weights path.
- `council-governance`: vendor allowlist, audit record, `rio init` opt-in, retention of council artifacts.
- `council-evaluation`: disagreement, accuracy and cost metrics; A/B against verifier-only; offline weight estimation; the keep-or-remove release rule.

### Modified Capabilities
- `review-profiles`: `council` block and trigger predicates `evidence == level`, `severity >= level`, `verify.split`, `risk_tier == tier`, `mode == fast|deep`, `nightly`.
- `findings`: `council` block (decision, tier, members, experiments, note).
- `review-report`: council section per councilled finding, the partial marker and cost in the footer.

**Dependencies.** Builds on `rio-v0-2-review-convergence` (feedback reasons feed weights) and `rio-v0-3-core` (the `security` community profile that enables the step, PR metadata for the author-family rule, the nightly eval job as the `nightly` trigger). The step must be implementable before PR mode exists: without PR metadata the author-family rule is reported as not applicable.

## Impact

- **Code**: `worker/` (council step, fan-out through the model gateway with per-vendor adapters, experiment scheduling as runner jobs, aggregator), `modules/members/*` (five built-in member manifests and prompts), `modules/steps/council`, `rio-profile` (new keys, predicates, author-family rule), `rio-core` (`council` block, renderers), `rio-cli` (`rio init` council step), `eval/` (weights, A/B, metrics), D1 migration (`council_assessments`).
- **Contracts**: profile-v1 `council`; module-v1 `member`; finding-v1 `council`; report-v1 `council` metrics; new `schemas/council-assessment-v1.json`. All additive; recorded in the v0.1 proposal's contract paragraph.
- **Network and data**: evidence packs leave the account to every allowlisted vendor; the audit record makes this inspectable; self-hosted members keep it in the account.
- **Cost**: bounded by trigger rate (5–10 % of findings), `max_experiments` and `max_rounds`; shown per finding.

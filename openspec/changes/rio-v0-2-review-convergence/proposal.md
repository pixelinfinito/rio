## Why

A review tool is judged by how fast a change converges, not by how much it says. Without rules for repeated rounds, a reviewer re-posts the same finding on every push, reviews the whole diff again after a one-line fix, and reports each instance of a repeated pattern as a separate comment; authors learn to ignore it. "How the Claude Code team does code review" (Anthropic, Oct 2026) describes the practices that keep review converging: a cap on rounds, diff-only re-review after the first round, flagging the class of a repeated problem rather than every instance, and findings that must be answered so the answers become the feedback signal. This change adopts them. The PRD's R27 (review convergence), R28 (standardized dismissal reasons) and R31 (noise measurement and incident import) are its requirements.

**Scope assumption.** The v0.1 change reserved the contracts this change consumes: profile-v1 `rounds`, finding-v1 `round`, `first_posted_in` and `author_response`, and the `fixed | wrong | intentional | irrelevant | style` reason set. This change implements the behavior on the endpoint and in the CLI for local lineages (`--since-last`). The parts that need a git host (resolving PR threads, auto-resolution from a later commit, reading dismissals from `/rio dismiss`) are specified here and land with PR mode (GitHub App, PRD v0.3); they must not be re-specified by that change.

## What Changes

- **Review lineages.** A lineage is the sequence of heads reviewed for one PR, or for one local branch under `--since-last`. The endpoint stores lineages (`lineages` table) and assigns each review a `round` within its lineage.
- **Round cap.** After `rounds.cap` rounds (default 3) Rio stops posting findings on that lineage and posts one message asking the author to reconsider the approach, summarizing the findings that have not converged. The cap is per lineage, not per finding, and a maintainer `/rio review` resets it.
- **Diff-only re-review.** After round `rounds.diff_only_after` (default 1), agents receive the diff between the previous reviewed head and the new head, the previous round's findings with their states, and the full intent artifact; they re-review only what changed, and deterministic checks still run on the whole change.
- **Flag the class, not the instance.** Consolidation merges findings that share `rule_id` and `trigger_hash` across symbols into one class-level finding with every location when the count exceeds a threshold (default 3), with the message rewritten to describe the pattern.
- **Never re-post a posted finding.** A finding identity already posted in a lineage is suppressed from later posts in the same lineage; its state is updated in place (edited comment, thread status).
- **Findings must be answered.** In PR mode every posted finding ends as `fixed` (the code changed and the finding no longer reproduces) or dismissed with a reason from `fixed | wrong | intentional | irrelevant | style`. A later head that removes the code auto-resolves the finding as `fixed`. `rio feedback <id> --dismiss <reason>`, `POST /v1/findings/{id}/feedback` and the `/rio dismiss <id> <reason>` PR comment all write `author_response` on the finding.
- **Resolution reasons are the feedback signal.** `wrong` feeds the false-positive rate per agent and evidence level; `intentional` feeds the intent agent's calibration; `irrelevant` and `style` feed posture and the category floor; `fixed` is the acceptance signal. The `feedback` table reason set becomes this one.
- **Noise measurement.** A nightly job (`rio eval noise`) runs the reference set's known-clean PRs (merged, with no later revert or fix touching the same lines) through the current pipeline and counts findings that would lead to a harmful change, judged by the existing evaluation harness; per repository, the author-response ratio (share of `fixed` among responses) is computed and shown in the report footer.
- **Incidents are the eval.** `rio eval import-incident <pr> <fix-pr>` turns a revert or fix-forward into a labeled case: the original PR is the input, and the fix PR's hunks define the expected finding location and trigger. The full set (incidents, historical PRs, mutations) is rerun on every prompt, tool or model change by the CI regression gate; a change that lowers the score is dropped.
- **Metric `rounds_to_pass`.** The round at which a lineage first has no open defect, recorded per lineage and aggregated per repository in `eval/` summaries.
- **Report additions.** The footer shows the round number, the lineage's cap state, the per-repository author-response ratio, and the count of findings held back as already posted.

Nothing is breaking. profile-v1, finding-v1 and report-v1 are extended only through keys the v0.1 change reserved; the `feedback.reason` column gains the new enum, and the earlier draft values (`false_positive`, `known`) are mapped to `wrong` and `intentional` at migration time, before any production data exists.

## Capabilities

### New Capabilities
- `review-convergence`: lineages and rounds, the round cap and its author message, diff-only re-review, class-level findings, never re-posting, and the `rounds_to_pass` metric.
- `finding-feedback`: `author_response`, the standardized reason set, auto-resolution from a later head, the three entry points (CLI, API, PR comment) and how reasons feed evaluation.
- `eval/noise-and-incidents`: the nightly noise run on known-clean PRs, the author-response ratio, `rio eval import-incident`, and the regression gate over the full case set.

### Modified Capabilities
- `findings`: `round`, `first_posted_in` and `author_response` are now emitted; state transitions include auto-resolution.
- `review-report`: footer carries round, cap state, author-response ratio and held-back count.
- `cli/review`: `--since-last` establishes a local lineage; `rio feedback` writes `author_response`.

## Impact

- **Code**: `worker/` (lineage storage, round assignment, publisher edits, feedback endpoint), `rio-core` (class-level consolidation, lineage-aware suppression), `rio-cli` (`rio feedback`, `rio eval import-incident`, `rio eval noise`), `eval/` (incident case format, noise job, `rounds_to_pass` and author-response aggregation).
- **Data model**: new `lineages` table; `findings` gains `round`, `first_posted_in`, `author_response_json`; `feedback.reason` enum fixed to `fixed | wrong | intentional | irrelevant | style`.
- **Contracts**: no new schema keys; consumes profile-v1 `rounds`, finding-v1 `round`, `first_posted_in`, `author_response`. `schemas/eval-case-v1.json` is new and internal to `eval/`.
- **Dependencies on other changes**: requires the endpoint and agents (v0.2 core change); PR-thread behaviors activate with the GitHub App change (v0.3).

## Purpose

Make repeated reviews of the same pull request or branch converge: bound the number of rounds, re-review only what changed, report repeated patterns once and never post the same finding twice.

## ADDED Requirements

### Requirement: Review lineages
Every endpoint review that names a pull request, or a local branch through `--since-last`, SHALL belong to a lineage keyed by repository, kind (`pr` or `branch`) and reference (PR number or branch name). Lineage identity SHALL NOT depend on commit ancestry, so rebases and force-pushes SHALL keep the lineage. The endpoint SHALL be the authority for lineage state; a reset SHALL start a new lineage generation at round 1. Reviews without a PR or `--since-last` SHALL NOT belong to a lineage.

#### Scenario: Force-push keeps the lineage
- **WHEN** a PR is reviewed, force-pushed with a rebased history and reviewed again
- **THEN** both reviews belong to the same lineage and the second review's round is computed from the first

#### Scenario: Plain review has no lineage
- **WHEN** `rio review` runs against an endpoint without `--pr` or `--since-last`
- **THEN** the report carries no round and no lineage state

### Requirement: Round assignment
A review's `round` SHALL be one plus the number of earlier reviews in its lineage that posted at least one finding. A review that posts at least one finding of any category, including only `plausible` risks, SHALL consume a round; a review that posts no finding SHALL NOT. Every finding produced by a lineage review SHALL carry that `round`.

#### Scenario: Empty review does not consume a round
- **WHEN** a lineage's first review posts two findings, its second posts none and a third review runs
- **THEN** the second review has round 2 and the third review also has round 2

### Requirement: Round cap
When a review's round exceeds the resolved `rounds.cap`, the report SHALL still contain every finding, but publication SHALL replace agent findings with one message giving the count of unresolved findings, the three highest-impact ones by title and location, and a request to reconsider the approach or split the change. Deterministic findings SHALL always be published. Later capped rounds SHALL edit that message instead of posting another.

#### Scenario: Oversized change gets a split proposal
- **WHEN** a capped round's change exceeded `max_lines`
- **THEN** the reconsider message proposes splitting the change along the prepare step's logical parts

#### Scenario: Fourth round with default cap
- **WHEN** the fourth round of a lineage with `rounds.cap: 3` produces two agent findings and one new type error
- **THEN** the full report lists all three findings, publication posts the type error and a single reconsider message naming the two agent findings, and no agent finding is posted individually

### Requirement: Cap reset
An explicit reset SHALL start a new lineage generation, so the next review is round 1 and publishes normally. In PR mode only a maintainer's `/rio review` SHALL reset; for branch lineages the CLI's `--reset-lineage` SHALL reset. Requests from users without maintainer permission SHALL NOT reset a PR lineage, and losing local cache SHALL NOT reset any lineage.

#### Scenario: Branch reset from the CLI
- **WHEN** `rio review --since-last --reset-lineage` runs on a capped branch lineage
- **THEN** the endpoint starts a new generation and the review is round 1

#### Scenario: Maintainer resets a capped lineage
- **WHEN** a capped lineage receives `/rio review` from a maintainer and is reviewed again
- **THEN** the new review has round 1 and its agent findings are published individually

### Requirement: Diff-only re-review
For rounds greater than the resolved `rounds.diff_only_after`, agents SHALL review the diff between the lineage's previous reviewed head and the new head, with the previous round's findings, their current states and the original intent as context. Deterministic checks and the impact graph SHALL still run on the full base-to-head change. The verifier SHALL re-verify only hypotheses on changed code and previously open findings whose location changed.

#### Scenario: Second round reviews only the fix
- **WHEN** round 1 reported a missing guard and round 2 changes only the guarded function
- **THEN** agents receive only the previous-head-to-new-head diff of that function plus round 1's findings as context, while typecheck and lint still classify every changed file against base

### Requirement: Class-level findings
After root-cause grouping, agent findings that share `rule_id` and `trigger_hash` across different symbols SHALL be merged into one class-level finding when their count exceeds the consolidation `class_threshold` (default 3). The class finding SHALL have identity `blake3(rule_id | "class" | trigger_hash)`, list every instance in `locations`, and describe the pattern with its count and first location. A suppression or response on the class SHALL apply to every instance.

#### Scenario: Repeated pattern becomes one finding
- **WHEN** an agent reports the same unchecked-error pattern with equal `rule_id` and `trigger_hash` in five functions
- **THEN** the report contains one class-level finding with five locations and a message stating five occurrences of the pattern

#### Scenario: Below threshold stays per instance
- **WHEN** the same pattern occurs in three functions with the default threshold
- **THEN** the report contains three separate findings

### Requirement: Never re-post
A finding identity already posted in a lineage SHALL NOT be posted again in that lineage. Publication SHALL instead update the existing comment or thread with the finding's current state (`open`, `fixed` or `dismissed: <reason>`), and the report SHALL count such findings as held back. A finding whose location moved without a change in identity SHALL be held back.

#### Scenario: Same finding on the next push
- **WHEN** round 2 produces a finding identity that round 1 already posted
- **THEN** no new comment is posted, the round 1 comment shows its current state, and the round 2 footer counts one held-back finding

### Requirement: Rounds to pass
Each lineage SHALL record `rounds_to_pass`: the round of its first review with no open defect, or null while defects remain open. Evaluation summaries SHALL aggregate it per repository.

#### Scenario: Lineage converges on the third round
- **WHEN** rounds 1 and 2 have open defects and round 3 has none
- **THEN** the lineage records `rounds_to_pass: 3`

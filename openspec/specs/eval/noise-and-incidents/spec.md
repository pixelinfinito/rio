# eval/noise-and-incidents Specification

## Purpose

Grow and run the evaluation set from production evidence: measure harmful noise on known-clean changes, turn incidents into labeled cases, and gate releases and pipeline changes on the measured results.

## Requirements

### Requirement: Noise measurement
`rio eval noise` SHALL run the current pipeline on the reference set's known-clean PRs (merged, with no later default-branch commit reverting them or touching the same hunks within 90 days) and write a per-PR adjudication skeleton plus `eval/runs/noise/<date>/summary.json`. The summary SHALL report the harmful count as a lower bound and the number of unadjudicated findings.

#### Scenario: Noise summary
- **WHEN** `rio eval noise` runs on ten known-clean PRs, and the adjudicator labels one finding harmful and every other finding
- **THEN** the dated summary records one harmful finding, zero unadjudicated findings, and labels the count a lower bound

### Requirement: Noise adjudication input
Each noise finding SHALL be labeled `harmful` (acting on it would introduce a bug or remove intended behavior), `neutral` or `useful` in the run's adjudication file, with the adjudicator and a rationale, validated by the eval record schema. Skeleton entries SHALL start unlabeled, and the harness SHALL NOT infer a label.

#### Scenario: Unlabeled entry stays unadjudicated
- **WHEN** an adjudication file leaves one finding at its skeleton value
- **THEN** validation reports that finding as unadjudicated and does not count it as neutral

### Requirement: Nightly noise run
A scheduled job on the maintainer's machine SHALL run `rio eval noise` nightly against the pinned provider profile, using the endpoint configuration already saved for that machine. Endpoint URLs, API tokens and provider keys SHALL NOT be stored in the source repository or its hosting service. Runs SHALL be kept outside the repository, privately, for at least 90 days.

#### Scenario: Nightly run stays on the machine
- **WHEN** the nightly job runs
- **THEN** it uses the pinned profile and saved endpoint configuration, writes the dated noise directory and its log to the private local store, and the repository gains no file or secret

#### Scenario: Leaked credential is quarantined
- **WHEN** a run's log or reports contain a saved credential
- **THEN** the job reports the file and credential kind without printing the value, quarantines the run directory and exits non-zero

#### Scenario: Old runs pruned
- **WHEN** the nightly job finds run directories older than 90 days in the local store
- **THEN** it removes them and keeps newer runs

### Requirement: Noise release gate
A release SHALL be blocked when its harmful noise count exceeds the previous release's count on the pinned provider set, or when any finding in the candidate's noise run is unadjudicated.

#### Scenario: Unadjudicated noise blocks release
- **WHEN** the candidate's noise run has zero harmful and two unadjudicated findings
- **THEN** the release gate fails and names the two unadjudicated findings

#### Scenario: Noise regression blocks release
- **WHEN** the previous release recorded zero harmful findings and the candidate records two
- **THEN** the release gate fails and names the two harmful findings

### Requirement: Incident import
`rio eval import-incident <pr> <fix-pr> [--caught-by ci|human|none]` SHALL create a labeled `incident` case whose input is the original PR's base and head and whose expected finding is located at the symbols enclosing the fix PR's hunks, with an editable trigger taken from the fix PR's description and the given `counterfactual_catch`.

#### Scenario: Counterfactual recorded
- **WHEN** an incident is imported with `--caught-by none`
- **THEN** the case records `counterfactual_catch: none` and its expected location is the fix PR's enclosing symbols

### Requirement: Incident overlap check
Incident import SHALL refuse, reporting the overlap, when the fix PR touches no file changed by the original PR.

#### Scenario: Fix touches unrelated files
- **WHEN** `rio eval import-incident 41 57` runs and PR 57 changes no file changed by PR 41
- **THEN** no case is written and the command reports the empty overlap

### Requirement: Incident case storage
Incident cases SHALL be written to the repository's own `eval/` directory and SHALL validate against `schemas/eval-case-v1.json`. Contributing a case to a shared set SHALL be a separate explicit step.

#### Scenario: Case stays in the repository
- **WHEN** an incident is imported in a private repository
- **THEN** the case is written under that repository's `eval/`, validates against `schemas/eval-case-v1.json`, and nothing is sent elsewhere

### Requirement: Regression gate over the full case set
Every prompt, tool or model change SHALL be evaluated on incidents, historical PRs and mutations together, and a change that lowers precision, recall or incident recall against the current baseline SHALL fail the gate.

#### Scenario: Prompt change lowers incident recall
- **WHEN** a prompt edit keeps overall precision but misses one previously caught incident
- **THEN** the regression gate fails and identifies the missed incident

### Requirement: Verifier acceptance comparison
The harness SHALL compare the quorum verifier against a single-verifier baseline on the same pinned reference cases, including known high-severity issues and clean controls, and report artifact-backed verdicts, blind-match buckets, verification tokens and cost, and precision by evidence level. v0.2 acceptance SHALL require precision of at least 80% and high-severity recall no lower than the baseline; a failing comparison SHALL be retained as evidence rather than reported as acceptance.

#### Scenario: Precision below the gate
- **WHEN** the pinned comparison measures 74% verifier precision
- **THEN** the summary records the failure with its cases and v0.2 is not marked accepted

#### Scenario: Recall preserved
- **WHEN** the verifier misses a high-severity issue that the single-verifier baseline caught
- **THEN** the comparison fails the recall condition and names that case

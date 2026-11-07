# Spec Delta

## Purpose

Deliver review results as SARIF 2.1.0 so code-scanning services and editors show the same findings, with the same identities, as the terminal report.

## ADDED Requirements

### Requirement: SARIF format availability
`rio review --format sarif` and the endpoint report query with format `sarif` SHALL both emit a SARIF 2.1.0 log for the review. In the CLI the document SHALL go to standard output in one piece with progress on standard error, as for `json`.

#### Scenario: CLI SARIF output
- **WHEN** `rio review --format sarif` runs with standard output redirected to a file
- **THEN** the file contains exactly one SARIF document and all progress went to standard error

#### Scenario: Endpoint SARIF output
- **WHEN** a finished review's report is requested with format `sarif`
- **THEN** the response body is a SARIF document for that review

### Requirement: Schema validity
Every emitted SARIF document SHALL validate against the official SARIF 2.1.0 JSON schema and declare `version` `2.1.0`.

#### Scenario: Validation of a review with findings
- **WHEN** a review with defects, risks and security findings is rendered as SARIF
- **THEN** the document validates against the SARIF 2.1.0 schema

### Requirement: One run with tool identity
The document SHALL contain exactly one run whose tool driver is named `rio` with the version of the renderer (CLI or endpoint), and whose rules list one entry per distinct rule id with a short description from the first message and the category in its properties.

#### Scenario: Rules derived from rule ids
- **WHEN** a review has findings with rule ids `typecheck/tsc/TS2322` and `lint/eslint/no-unused-vars`
- **THEN** the run lists exactly those two rules and every result references one of them

### Requirement: Result level mapping
Each result SHALL have level `error` for severity `error`, `warning` for severity `warning` and `note` for severity `info`. Every risk entry and every plausible entry SHALL have level `note` regardless of severity.

#### Scenario: Plausible security risk is a note
- **WHEN** a security hypothesis verified at plausible with severity `error` is rendered
- **THEN** its result has level `note` and its properties record category `security` and evidence level `plausible`

### Requirement: Result message and locations
Each result's message SHALL contain the finding message followed by its trigger. Each finding location SHALL appear as a physical location with a repository-relative URI under the base id `SRCROOT` and a region with the finding's line range, and the run SHALL declare the `SRCROOT` original URI base id.

#### Scenario: Class finding with several locations
- **WHEN** a class-level finding with five locations is rendered
- **THEN** its result has five locations, each with a `SRCROOT` relative URI and a line region

### Requirement: Fingerprint and baseline state
Each result SHALL carry `partialFingerprints` with key `rioFindingId/v1` equal to the finding identity, and `baselineState` of `new` for regression state `new` or `worsened`, `unchanged` for `pre-existing`, `absent` for `fixed`, and no `baselineState` for `unclassified`.

#### Scenario: Worsened finding
- **WHEN** a finding with state `worsened` and identity `8c1e…` is rendered
- **THEN** its result has `baselineState` `new` and `partialFingerprints.rioFindingId/v1` equal to `8c1e…`

### Requirement: Result and run properties
Each result's properties SHALL carry the evidence level, category, regression state, lifecycle status, severity, verification metadata, round, author response and history when present. The run's properties SHALL carry the review status, risk tier, lineage state and review id.

#### Scenario: Lineage review properties
- **WHEN** a round 2 lineage review with risk tier `high` is rendered
- **THEN** every result's properties include `round` 2 and the run properties include the risk tier and the lineage state

### Requirement: Invocation record
The run SHALL contain one invocation with `executionSuccessful` true unless the review status is `error`, the CLI exit code when rendered by the CLI, start and end timestamps, and one tool execution notification of level `warning` per check that ended failed, skipped or cancelled, naming the check and its reason.

#### Scenario: Incomplete check reported
- **WHEN** a review's lint check ended `skipped` with reason `tool_missing`
- **THEN** the invocation lists one warning notification naming lint and `tool_missing`

### Requirement: Excluded entries
Refuted hypotheses, suppressed findings, remembered findings, category-floor drops and pre-existing findings not shown in the main sections SHALL NOT appear as results.

#### Scenario: Suppressed finding absent
- **WHEN** a finding is suppressed by the profile
- **THEN** no result carries its identity

### Requirement: Renderer equivalence
For the same report document, the CLI and the endpoint SHALL produce SARIF that is byte-identical after canonical key ordering.

#### Scenario: Same report, two renderers
- **WHEN** a stored report is rendered by the CLI and by the endpoint
- **THEN** the two documents are equal after canonical key ordering

### Requirement: SARIF for error status
When the review status is `error`, the SARIF document SHALL contain one run with no results, `executionSuccessful` false and the error code and message in the invocation's properties.

#### Scenario: Review could not start
- **WHEN** `rio review --format sarif` runs outside a git repository
- **THEN** standard output contains one SARIF document with zero results and `executionSuccessful` false, and the exit code is 3

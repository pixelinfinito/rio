## Purpose

Require every posted finding to end with an answer, record that answer with a standardized reason, and turn the reasons into the evaluation signal for agents, evidence levels and posture.

## ADDED Requirements

### Requirement: Standardized response reasons
A response to a finding SHALL be recorded as `author_response = { reason, actor, at, note }` where `reason` is one of `fixed`, `wrong`, `intentional`, `irrelevant` or `style`, `actor` and `at` identify who responded and when, and `note` is optional free text. Any other reason SHALL be rejected.

#### Scenario: Unknown reason rejected
- **WHEN** a response is submitted with reason `false_positive`
- **THEN** it is rejected with an error listing the five accepted reasons and the finding is unchanged

### Requirement: Lifecycle status
Every posted finding SHALL carry a lifecycle `status` of `open`, `fixed` or `dismissed`, separate from its regression `state`. A posted finding SHALL start `open` and end as `fixed` or `dismissed`; a dismissal's reason SHALL be its `author_response.reason`. `fixed` SHALL also be accepted as a manual dismissal reason for fixes made outside the lineage. Changing `status` SHALL NOT change `state` or how `fail_on` evaluates the finding.

#### Scenario: Manual fixed response
- **WHEN** an author dismisses an open `new` finding with reason `fixed` because it was fixed in another PR
- **THEN** the finding's `status` becomes `dismissed`, its `author_response.reason` is `fixed`, and its `state` remains `new`

### Requirement: Auto-resolution
A finding SHALL become `fixed`, citing the fixing head, only when a later lineage review is `complete`, re-assessed the finding's location (deterministic checks covering it succeeded, and for agent findings verification of that location finished without incomplete votes), no longer produces its identity, and the code at its location was changed or removed. Otherwise the finding SHALL stay `open`; when it vanished on unchanged code, it SHALL note it did not reproduce.

#### Scenario: Code changed and finding gone
- **WHEN** round 2 removes the code at a round 1 finding's location and no longer produces its identity
- **THEN** the finding becomes `fixed` with the round 2 head recorded

#### Scenario: Incomplete review cannot fix a finding
- **WHEN** round 2 changes a round 1 agent finding's code, does not reproduce it, and ends `incomplete` because its votes failed
- **THEN** the finding stays `open` and records that it was not re-assessed

#### Scenario: Failed check cannot fix a finding
- **WHEN** round 2 edits the line of a round 1 type error and the typecheck step fails to run
- **THEN** the type error stays `open`

#### Scenario: Finding vanished on unchanged code
- **WHEN** round 2 does not produce a round 1 finding but its code is unchanged
- **THEN** the finding stays `open` and records that it did not reproduce

### Requirement: Response entry points
`rio feedback <id> --dismiss <reason> [--note TEXT]`, `POST /v1/findings/{id}/feedback`, and in PR mode a `/rio dismiss <id> <reason>` comment SHALL each write the same `author_response` to the finding and to the feedback record. A PR-comment dismissal SHALL be accepted only from repository collaborators; others SHALL be ignored and logged. A dismissal SHALL NOT change posture, budgets, rules or suppressions.

#### Scenario: CLI dismissal
- **WHEN** `rio feedback 8c1e --dismiss intentional --note "documented behavior"` is run against a configured endpoint
- **THEN** the finding's `author_response` records reason `intentional`, the note, the caller and a timestamp, and the command exits 0

#### Scenario: Fork contributor cannot dismiss
- **WHEN** a non-collaborator comments `/rio dismiss 8c1e wrong` on a fork PR
- **THEN** the finding is unchanged and the ignored dismissal is logged

### Requirement: Reasons feed evaluation
Evaluation SHALL compute per repository the author-response ratio `fixed / (fixed + wrong + intentional + irrelevant + style)` over responded findings, `wrong` counts per agent and evidence level as the false-positive signal, `intentional` counts per agent as intent calibration, and `irrelevant` and `style` counts per rule and category. No per-user model SHALL be built, and suppressions proposed from reasons SHALL still require approval.

#### Scenario: Ratio from mixed responses
- **WHEN** a repository has six `fixed`, two `wrong`, one `intentional` and one `style` responses
- **THEN** its author-response ratio is 0.6 and the two `wrong` responses count against the producing agents' evidence levels

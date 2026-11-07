# Spec Delta

## MODIFIED Requirements

### Requirement: Artifact-backed evidence
Only evidence supported by valid review artifacts SHALL count toward quorum. `reproduced` SHALL require a recorded runner execution of a reproduction, or, for a QA hypothesis, a recorded browser execution (trace plus the step screenshot and DOM snapshot) in which the claimed behavior is observable; `static_proven` SHALL require a cited code path present in the head graph, or a QA probe result. Refutation SHALL require an artifact demonstrating protection, a passing reproduction on head, or, for a QA hypothesis, a recorded replay of the same step in which the claimed behavior does not occur. Model agreement alone SHALL NOT establish evidence.

#### Scenario: Unsupported reproduction claim
- **WHEN** voters claim `reproduced` without corresponding runner execution artifacts
- **THEN** those claims do not contribute support at `reproduced`

#### Scenario: Invalid static citation
- **WHEN** a voter cites a code path absent from the selected head graph
- **THEN** the citation cannot support `static_proven`

#### Scenario: Browser trace supports reproduced
- **WHEN** voters cite the trace and step screenshot in which the save button is disabled after a valid entry
- **THEN** the hypothesis can be supported at `reproduced`

#### Scenario: Screenshot alone cannot refute
- **WHEN** a voter asserts the behavior does not occur without a replay artifact
- **THEN** the assertion does not count as a refutation

## ADDED Requirements

### Requirement: Deterministic replay on request
For a QA hypothesis, a voter MAY request one replay of the journey up to the cited step. Rio SHALL execute the replay deterministically from the recorded actions, without the harness, in the same viewport and color scheme, at most once per hypothesis, within the verification budget, and SHALL store the replay artifacts with the hypothesis. A replay in which the behavior recurs SHALL be usable as support for `reproduced`; one in which it does not SHALL be usable as a refutation.

#### Scenario: Replay recurs
- **WHEN** a voter requests a replay and the disabled button recurs at step 4
- **THEN** the replay artifacts are attached and the voter can cite them for `reproduced`

#### Scenario: Second replay refused
- **WHEN** a second voter requests a replay for the same hypothesis
- **THEN** the voter receives the existing replay artifacts and no new replay runs

### Requirement: Evidence pack for QA hypotheses
Voters for a QA hypothesis SHALL receive the hypothesis, the step screenshots before and after, the DOM snapshot, the console and network log excerpts, the base and head content of the attributed source file when attribution succeeded, and the journey file. Voters SHALL NOT receive the harness transcript's free text beyond the tool calls.

#### Scenario: Transcript prose excluded
- **WHEN** a voter's evidence pack is assembled
- **THEN** it contains the tool call sequence from the transcript and none of the agent's narrative text

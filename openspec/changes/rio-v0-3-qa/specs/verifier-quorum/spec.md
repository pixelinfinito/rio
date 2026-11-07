# Spec Delta

## MODIFIED Requirements

### Requirement: Artifact-backed evidence
Only evidence supported by valid review artifacts SHALL count toward quorum. `reproduced` SHALL require a recorded runner execution of a reproduction, or, for a QA hypothesis, a recorded browser execution (sanitized trace plus the step screenshot and DOM snapshot) in which the claimed behavior is observable, or a replay with outcome `recurred`; `static_proven` SHALL require a cited code path present in the head graph, or a QA probe result. Refutation SHALL require an artifact demonstrating protection, a passing reproduction on head, or, for a QA hypothesis, an artifact from the original run showing the expected behavior under the same trigger. A replay that did not recur SHALL be inconclusive. Model agreement alone SHALL NOT establish evidence.

#### Scenario: Unsupported reproduction claim
- **WHEN** voters claim `reproduced` without corresponding runner execution artifacts
- **THEN** those claims do not contribute support at `reproduced`

#### Scenario: Invalid static citation
- **WHEN** a voter cites a code path absent from the selected head graph
- **THEN** the citation cannot support `static_proven`

#### Scenario: Browser trace supports reproduced
- **WHEN** voters cite the trace and step screenshot in which the save button is disabled after a valid entry
- **THEN** the hypothesis can be supported at `reproduced`

#### Scenario: Non-recurrence is not a refutation
- **WHEN** a voter cites a replay with outcome `not_recurred` as refutation
- **THEN** the citation is inconclusive, contributes to neither side, and is recorded

#### Scenario: Refutation from the original evidence
- **WHEN** a voter cites the DOM snapshot of the same step showing the confirmation the agent reported missing
- **THEN** the citation counts as a refutation

## ADDED Requirements

### Requirement: Replay on request
For a QA hypothesis, a voter MAY request one replay of the chain up to the cited step. Rio SHALL execute it in a fresh pod from the seed snapshot, replaying the recorded events of the prerequisite journeys and the target without the harness, in the same cell, at most once per hypothesis and within `qa.replay_wall`. The outcome SHALL be `recurred`, `not_recurred` or `prerequisites_failed`, and the replay artifacts SHALL be stored with the hypothesis.

#### Scenario: Replay recurs
- **WHEN** a voter requests a replay and the disabled button recurs at step 4
- **THEN** the replay artifacts are attached and the voter can cite them for `reproduced`

#### Scenario: Prerequisites fail
- **WHEN** the replay cannot recreate the cart from `add-to-cart`
- **THEN** the outcome is `prerequisites_failed`, it is inconclusive, and the footer records it

#### Scenario: Second replay refused
- **WHEN** a second voter requests a replay for the same hypothesis
- **THEN** the voter receives the existing replay artifacts and no new replay runs

### Requirement: Blind turn for QA hypotheses
In the blind first turn a voter for a QA hypothesis SHALL receive the step evidence (screenshots before and after, DOM snapshot, console and network excerpts, the journey file and the step) without the hypothesis text, and SHALL state what it observes. Blind match SHALL be computed on rule, journey, step and route: `same` when all match, `related` when journey, step and route match, `none` otherwise.

#### Scenario: Blind rediscovery on a journey-attributed finding
- **WHEN** a voter's blind observation names the same rule at the same journey step and route
- **THEN** the voter's blind match is `same` even though the finding has no source symbol

### Requirement: Evidence pack for QA hypotheses
In the second turn voters SHALL additionally receive the hypothesis with its structured `expected` and `observed` fields, the base and head content of the attributed source file when attribution succeeded, and the tool call sequence from the transcript. Voters SHALL NOT receive the agent's narrative text.

#### Scenario: Transcript prose excluded
- **WHEN** a voter's evidence pack is assembled
- **THEN** it contains the tool call sequence from the transcript and none of the agent's narrative text

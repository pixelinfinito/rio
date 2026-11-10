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

#### Scenario: Before and after evidence accepted by the host
- **WHEN** an observation cites sanitized evidence from the current and immediately preceding step in the same journey and cell
- **THEN** host construction retains both, requires current-step evidence, and rejects future-step, other-journey or other-cell artifacts; rejected candidates are counted in the audit

### Requirement: Evidence pack for QA hypotheses
In the second turn voters SHALL additionally receive the hypothesis with its structured `expected` and `observed` fields, the base and head content of the attributed source file when attribution succeeded, and the tool call sequence from the transcript. Voters SHALL NOT receive the agent's narrative text.

#### Scenario: Transcript prose excluded
- **WHEN** a voter's evidence pack is assembled
- **THEN** it contains the tool call sequence from the transcript and none of the agent's narrative text

### Requirement: Guidance in QA verification
Both verifier turns SHALL receive the same applicable owner guidance and criterion definitions as execution, with immutable citations. The first turn SHALL still omit the candidate text. Voters SHALL check that cited requirements apply to the persona and journey; guidance alone SHALL NOT prove the observed behavior or harm.

#### Scenario: Project-specific behavior verified
- **WHEN** the candidate cites checkout's requirement to preserve entered data on retry
- **THEN** voters receive that recorded requirement in both turns and evaluate it against the captured interaction, not a generic preference

#### Scenario: Evidence remains available within bounded prompts
- **WHEN** a later journey step has its own before/after captures and a large text artifact
- **THEN** verification uses those captures without an unrelated journey-opening screenshot, retains the immutable guidance and criterion definitions in the conversation for both turns without duplicating them, and exposes the complete text through bounded pages
- **AND** artifact identities, browser scope, original evidence validation and configured token limits remain unchanged

### Requirement: Verify recommendation grounding separately
Recommendation candidates SHALL use the shared verifier quorum to assess observed friction, source applicability and whether the proposal addresses it. Output SHALL be supported, rejected or inconclusive, with rationale; a deferred verifier SHALL leave it unverified. A supported recommendation SHALL NOT imply reproduced benefit, a failed requirement, or permission to change the product.

#### Scenario: Evidence supports friction only
- **WHEN** artifacts demonstrate duplicate entry but no users have tested the proposed simplification
- **THEN** the verifier can support the recommendation's grounding while the benefit remains an untested expectation

#### Scenario: Quorum outcomes for recommendations
- **WHEN** recommendation votes are aggregated using the configured voter count, quorum and verification budgets
- **THEN** a support quorum alone yields supported, a rejection quorum alone yields rejected, both or neither yield inconclusive, failed or malformed votes supply no support, and the audit record retains each voter's evidence and rationale

#### Scenario: Generic advice rejected
- **WHEN** a candidate recommends a shorter checkout without identifying observed unnecessary steps
- **THEN** it is rejected for insufficient grounding and is not published as a supported recommendation

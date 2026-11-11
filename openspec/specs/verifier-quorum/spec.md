# verifier-quorum Specification

## Purpose

Verify agent hypotheses through independent, bounded passes whose conclusions are backed by inspectable evidence and a blind examination of the affected code.

## Requirements

### Requirement: Independent voters
For each hypothesis, verification SHALL run the resolved number of voters independently using the resolved verifier model. Voters SHALL NOT receive another voter's outputs or the generating agent's reasoning. Hypotheses and voter outputs SHALL remain available for audit. Board reads and writes SHALL be no-ops and SHALL NOT coordinate agents or voters.

#### Scenario: Default fan-out
- **WHEN** a hypothesis is submitted with default verification settings
- **THEN** three independent voters examine it with quorum two and no shared conversation state

#### Scenario: Board independence
- **WHEN** an agent writes a hypothesis through a board tool
- **THEN** that operation does not expose it to another agent or voter, and the report notes that board coordination is deferred

### Requirement: Two-turn blind verification
Each voter SHALL first receive the location, enclosing symbol, base and head symbol content, direct callers, intent and applicable owner guidance without the hypothesis. It SHALL answer what, if anything, is wrong using the hypothesis schema; an empty answer SHALL be valid. Only after recording this answer SHALL the voter receive the hypothesis and verify it using tools. The second turn SHALL append the hypothesis after the voter's complete blind conversation, without altering any earlier message. While the `verifier-system` layout feature is enabled, both turns SHALL use one unchanged system prompt, and the verification instructions and the verification answer schema SHALL arrive only with the hypothesis in the appended message, unless the first disclosed request in that form would not fit the voter's remaining token allowance; that voter SHALL then send the disclosed turn as it would with the feature off. While it is off, each turn SHALL keep the system prompt it used before this change.

#### Scenario: Hypothesis withheld until blind answer
- **WHEN** a voter starts examining a hypothesis
- **THEN** its first turn contains no hypothesis, trigger, proposed impact or generating rationale, and the original hypothesis is disclosed only in the second turn

#### Scenario: Disclosure only after the blind vote is persisted
- **WHEN** a voter's blind answer is accepted
- **THEN** the vote with its blind answer and blind match is saved before any request containing the hypothesis is built or sent, and a failure to save it ends the voter without disclosure

#### Scenario: Disclosed turn extends the blind conversation
- **WHEN** `verifier-system` is enabled and a voter's first disclosed request is sent after a blind phase of three model turns
- **THEN** its system text is identical to the blind requests' system text, its messages begin with the text of every blind message unchanged, and the disclosure is the single appended user message

#### Scenario: Answer schema arrives with the disclosure
- **WHEN** `verifier-system` is enabled and the blind requests of a voter are inspected
- **THEN** none of them contains the verification answer schema, the hypothesis, its rule id or its trigger, and the first disclosed request contains all of them

#### Scenario: Shared system prompt that would not fit
- **WHEN** `verifier-system` is enabled and a voter's remaining allowance covers its disclosed request with the vote-schema system prompt but not with the shared system prompt
- **THEN** the voter's disclosed requests use the vote-schema system prompt and the disclosure without the answer schema, as with the feature off, and the voter is not marked exhausted for it

#### Scenario: Feature off keeps per-phase system prompts
- **WHEN** `verifier-system` is not enabled
- **THEN** blind requests use the hypothesis-schema system prompt and disclosed requests use the vote-schema system prompt, as before this change, and the blindness scenarios above still hold

### Requirement: Computed blind comparison
Blind comparison SHALL be computed from outputs: `same` for matching rule and trigger hash, `related` for matching symbol otherwise, and `none` otherwise. Each voter's result SHALL be recorded. The absence of blind rediscovery SHALL NOT reject a hypothesis or automatically lower its evidence level.

#### Scenario: Matching symbol without matching trigger
- **WHEN** a blind answer identifies the original symbol but a different rule or trigger hash
- **THEN** that voter's blind match is `related`

#### Scenario: Subtle issue missed blindly
- **WHEN** all blind answers are empty but a quorum subsequently supplies valid reproduction evidence
- **THEN** the hypothesis can be promoted to `reproduced` and every blind match remains `none`

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

### Requirement: Quorum aggregation
Verification SHALL choose the highest non-refuted evidence level supported at that level or better by at least `quorum` distinct voters. Artifact-backed refutations SHALL count separately. A refutation quorum alone SHALL refute the hypothesis. If both sides reach quorum, or neither does, the result SHALL be `plausible` with `verify.split`. Disagreement across the refuted boundary SHALL also set `verify.split`.

#### Scenario: Mixed positive evidence
- **WHEN** quorum is two and valid voter levels are `reproduced`, `static_proven` and `plausible`
- **THEN** the result is `static_proven` with two agreeing voters

#### Scenario: Refutation majority
- **WHEN** quorum is two and valid voter levels are `refuted`, `refuted` and `reproduced`
- **THEN** the result is `refuted`, is not rendered as an open finding, and records `verify.split`

#### Scenario: Neither side reaches quorum
- **WHEN** quorum is three and two voters support a hypothesis while one refutes it
- **THEN** the result is `plausible` with `verify.split`

#### Scenario: Both sides reach quorum
- **WHEN** four voters with quorum two return two valid refutations and two valid proofs
- **THEN** the result is `plausible` with `verify.split`

### Requirement: Bounded verification cost
The resolved `budget.<mode>.verify_tokens` SHALL bound each voter's complete two-turn verification of one hypothesis. If absent, it SHALL default to 320,000 tokens in both modes, whatever the review token budget; the review-wide token limit SHALL still bound every call. Verification usage and cost SHALL be accounted separately. Failed, cancelled, exhausted or malformed votes SHALL supply no quorum support and SHALL remain visible in the audit record.

#### Scenario: Budget covers both turns
- **WHEN** the first turn consumes part of a voter's per-hypothesis token allowance
- **THEN** the second turn can consume only the remainder and the voter cannot exceed the allowance

#### Scenario: Default allowance covers a real verification
- **WHEN** a profile sets no token budget and a voter verifies a hypothesis of 2,430 bytes
- **THEN** the voter completes both turns

#### Scenario: Missing votes cannot silently weaken quorum
- **WHEN** two of three voters fail with quorum two
- **THEN** the remaining voter cannot establish a proof or refutation quorum and the failures are recorded

### Requirement: Repository-wide tools
Agent and verifier `read_file` and `search` tools SHALL support repository-contained paths in either selected version outside the suggested triage focus, subject to output and budget limits. Graph queries SHALL remain bounded by hops and node count. Tool access SHALL NOT escape the selected repository snapshots.

#### Scenario: Callee outside suggested focus
- **WHEN** a voter follows a call into a repository file outside its suggested focus
- **THEN** it can read and search that file in base and head

#### Scenario: Repository path escape
- **WHEN** a model requests a traversal path, absolute external path or symlink target outside the selected snapshot
- **THEN** the tool rejects access

### Requirement: Execution defaults and fork restriction
Execution SHALL default to enabled for correctness agents and verifier voters and disabled for other agents. Manifests SHALL be able to override those defaults. Fork PRs SHALL disable execution for all agents and voters regardless of manifest settings, with the restriction reported. Allowed executions SHALL use the existing isolated runner without network access.

#### Scenario: Fork overrides execution enablement
- **WHEN** a fork PR's correctness or verifier manifest enables `run`
- **THEN** runner execution is unavailable and the report states that the review is static-only

#### Scenario: Non-fork defaults
- **WHEN** manifests do not override execution on a non-fork review
- **THEN** correctness and verifier voters can execute through the runner, while other agents cannot

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

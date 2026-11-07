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
Each voter SHALL first receive the location, enclosing symbol, base and head symbol content, direct callers, intent and applicable owner guidance without the hypothesis. It SHALL answer what, if anything, is wrong using the hypothesis schema; an empty answer SHALL be valid. Only after recording this answer SHALL the voter receive the hypothesis and verify it using tools.

#### Scenario: Hypothesis withheld until blind answer
- **WHEN** a voter starts examining a hypothesis
- **THEN** its first turn contains no hypothesis, trigger, proposed impact or generating rationale, and the original hypothesis is disclosed only in the second turn

### Requirement: Computed blind comparison
Blind comparison SHALL be computed from outputs: `same` for matching rule and trigger hash, `related` for matching symbol otherwise, and `none` otherwise. Each voter's result SHALL be recorded. The absence of blind rediscovery SHALL NOT reject a hypothesis or automatically lower its evidence level.

#### Scenario: Matching symbol without matching trigger
- **WHEN** a blind answer identifies the original symbol but a different rule or trigger hash
- **THEN** that voter's blind match is `related`

#### Scenario: Subtle issue missed blindly
- **WHEN** all blind answers are empty but a quorum subsequently supplies valid reproduction evidence
- **THEN** the hypothesis can be promoted to `reproduced` and every blind match remains `none`

### Requirement: Artifact-backed evidence
Only evidence supported by valid review artifacts SHALL count toward quorum. `reproduced` SHALL require a recorded runner execution of a reproduction; `static_proven` SHALL require a cited code path present in the head graph. Refutation SHALL require an artifact demonstrating protection or a passing reproduction on head. Model agreement alone SHALL NOT establish evidence.

#### Scenario: Unsupported reproduction claim
- **WHEN** voters claim `reproduced` without corresponding runner execution artifacts
- **THEN** those claims do not contribute support at `reproduced`

#### Scenario: Invalid static citation
- **WHEN** a voter cites a code path absent from the selected head graph
- **THEN** the citation cannot support `static_proven`

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
The resolved `budget.<mode>.verify_tokens` SHALL bound each voter's complete two-turn verification of one hypothesis. If absent, it SHALL default to one fifth of that agent's resolved token budget, rounded down with a minimum of one token. Verification usage and cost SHALL be accounted separately. Failed, cancelled, exhausted or malformed votes SHALL supply no quorum support and SHALL remain visible in the audit record.

#### Scenario: Budget covers both turns
- **WHEN** the first turn consumes part of a voter's per-hypothesis token allowance
- **THEN** the second turn can consume only the remainder and the voter cannot exceed the allowance

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

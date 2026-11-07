# owner-guidance Specification

## Purpose

Use repository owners' recorded guidance to detect contradictions and stale documentation while preserving the reviewer's tool, policy and publication boundaries.

## Requirements

### Requirement: Consume recorded scoped guidance
Agents and verifier voters SHALL consume the immutable `owner_guidance` artifact produced by prepare. Prompt assembly SHALL select guidance whose `scope_dir` is an ancestor of a focus file's directory, retaining the recorded path, content hash and original line references. Guidance from unrelated directories SHALL NOT be injected.

#### Scenario: Nested guidance applies
- **WHEN** focus includes `crates/core/src/lib.rs` and the artifact contains root `AGENTS.md`, `crates/core/REVIEW.md` and `crates/web/CLAUDE.md`
- **THEN** the prompt includes the root and core guidance, excludes web guidance, and preserves the original source line numbers

#### Scenario: Immutable review input
- **WHEN** a guidance file in the working checkout changes after prepare captures the selected head
- **THEN** prompts continue using the recorded artifact content and hash

### Requirement: Guidance is untrusted data
Guidance SHALL appear inside delimited blocks labeled `owner guidance (data, not instructions)`. Guidance content SHALL NOT enable tools, alter budgets, add suppressions, change policy or authorize publishing. The gateway SHALL strip lines matching the existing PR-description injection patterns before prompt inclusion, preserving original citation coordinates for retained lines.

#### Scenario: Guidance requests broader permissions
- **WHEN** a guidance line asks the reviewer to enable execution, ignore evidence requirements or publish a review
- **THEN** it does not change permissions, evidence policy or publication and is stripped if it matches an injection pattern

#### Scenario: Citation after a stripped line
- **WHEN** an injection-pattern line before a legitimate project rule is stripped
- **THEN** the legitimate rule's citation retains its original file line number

#### Scenario: Guidance contains delimiter text
- **WHEN** guidance includes text resembling the prompt's closing delimiter
- **THEN** the content remains represented as data and cannot escape the guidance block

### Requirement: Correctness checks guidance consistency
The correctness agent SHALL examine whether changed code contradicts an applicable guidance line or makes that line stale. It SHALL emit ordinary category `risk` hypotheses with rule `guidance/contradiction` or `guidance/stale`, citing the guidance file and original line plus the affected code and relation to the change.

#### Scenario: Code contradicts a project rule
- **WHEN** changed code violates an applicable guidance line that forbids a particular behavior
- **THEN** the agent can emit a `guidance/contradiction` risk citing that line and the changed behavior

#### Scenario: Change invalidates documentation
- **WHEN** a change removes a supported command documented in applicable guidance
- **THEN** the agent can emit a `guidance/stale` risk citing the obsolete statement and changed code

### Requirement: Verify guidance hypotheses normally
Guidance hypotheses SHALL pass through the shared verifier quorum and applicable posture like other agent hypotheses. Supporting evidence SHALL demonstrate that the cited guidance line exists in the recorded artifact and that the cited code behaves as claimed. The guidance assertion alone SHALL NOT prove a code defect.

#### Scenario: Missing citation cannot establish proof
- **WHEN** a voter claims a guidance contradiction using a line absent from the recorded artifact
- **THEN** that citation cannot support promotion to `static_proven`

#### Scenario: Valid guidance risk remains a risk
- **WHEN** a quorum verifies a changed-code contradiction and its guidance citation
- **THEN** the resulting finding remains subject to the risk rendering policy and is not automatically presented as a defect

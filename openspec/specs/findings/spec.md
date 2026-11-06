# findings Specification

## Purpose

The finding model is the single representation every check, renderer and later agent shares: what was found, where, with what evidence, whether it is a regression, and a stable identity across runs.

## Requirements

### Requirement: Finding model
A finding SHALL have: `id` (stable identity), `rule_id`, `category` (`defect`, `risk` or `security`), `evidence_level`, `severity` (`error`, `warning`, `info`), `state` (`new`, `worsened`, `pre-existing`, `fixed`, `unclassified`), `location` (repository-relative path, line range, optional column, enclosing symbol path), `message`, `trigger` (the condition under which the problem manifests), optional `impact`, optional `suggested_fix`, `evidence` (references to artifacts in the review cache), `source` (tool and version, or agent name), `locations` for every occurrence merged by root cause, each with its own line range and `occurrence_state` (`new`, `pre-existing`, `fixed` or `unclassified`), and, for `dependency/*` findings, an `advisory` block (`id`, `aliases`, `severity` from `critical`, `high`, `moderate`, `low`, `unknown`, `fixed_version` or `unknown`, `url`). The schema SHALL also define the optional keys `round` (positive integer: the review round within a head lineage that produced the finding), `first_posted_in` (the head SHA or snapshot key of the round in which the finding was first posted) and `author_response` (`{ reason: fixed | wrong | intentional | irrelevant | style, actor, at, note }`); this version never emits them, and their absence SHALL be valid. An optional `verification` block SHALL record `voters`, `agreeing`, per-voter `blind_match` and `split` for verified agent findings; its absence SHALL remain valid for deterministic and historical findings. The JSON form SHALL validate against `schemas/finding-v1.json`.

#### Scenario: JSON validates against the schema
- **WHEN** a review is rendered as JSON
- **THEN** every finding in the document validates against `schemas/finding-v1.json`

#### Scenario: Reserved keys validate
- **WHEN** a hand-written finding document carries `round: 2`, `first_posted_in: "3f2a…"` and `author_response: { reason: intentional, actor: "octocat", at: "2026-11-05T10:00:00Z" }`
- **THEN** it validates against `schemas/finding-v1.json`, and a document with `author_response.reason: known` is rejected

### Requirement: Evidence levels
`evidence_level` SHALL be one of `reproduced`, `static_proven`, `plausible`, `refuted`, ordered from strongest to weakest. A finding SHALL NEVER carry a numeric confidence. Findings below `plausible` SHALL never be rendered. Deterministic checks SHALL emit `static_proven`.

#### Scenario: No percentages anywhere
- **WHEN** any report format is produced
- **THEN** no finding shows a confidence percentage or score

### Requirement: Stable identity
The id SHALL be `blake3(rule_id | normalized_location | trigger_hash)` where `normalized_location` is the repository-relative path plus the enclosing symbol path with line numbers removed, and `trigger_hash` is the hash of the message with only known volatile fragments normalized: line and column references, absolute path prefixes and the repository root, and tool-generated identifiers. Semantic content of the message, including numeric literals, type names and casing, SHALL be preserved. The id SHALL be stable when code moves within a file and when unrelated lines are inserted above it, and SHALL differ for findings whose messages differ in semantic content.

#### Scenario: Line shift keeps the id
- **WHEN** ten lines are inserted above a function that has a type error, and the review is run again
- **THEN** the finding keeps the same id

#### Scenario: Different rule gives a different id
- **WHEN** two different lint rules fire on the same line
- **THEN** they produce two findings with different ids

### Requirement: One finding per root cause
Findings from the same source with equal `rule_id`, enclosing symbol path and `trigger_hash` SHALL be merged into one finding whose `locations` lists every occurrence. Merging SHALL happen after each occurrence has been classified, so grouping never hides an occurrence's state. Separate root causes SHALL NOT be merged even when they share a line. Finding ids SHALL be unique within a report.

#### Scenario: Repeated error in one function
- **WHEN** the type checker reports the same error code and message on four lines of one function
- **THEN** the report shows one finding with four locations

### Requirement: Regression state
Classification SHALL operate on occurrences, as defined by the deterministic-checks capability, and the finding's `state` SHALL be derived from its occurrences: `new` when every occurrence is new; `worsened` when at least one occurrence is new and at least one is pre-existing; `pre-existing` when no occurrence is new and at least one is pre-existing; `fixed` when every occurrence exists only in the base; and `unclassified` when no baseline was obtained. A `pre-existing` finding that lost occurrences SHALL report the number of fixed occurrences. Only `new`, `worsened` and `unclassified` findings SHALL be rendered in the main findings section. A `worsened` finding SHALL show which of its locations are new.

#### Scenario: Worsened finding shows the new occurrence
- **WHEN** a grouped type error had one occurrence in base and has that occurrence plus one new occurrence in head
- **THEN** the finding has state `worsened`, appears in the main findings section, and its `locations` mark one occurrence `pre-existing` and one `new`

#### Scenario: Fewer occurrences is not a regression
- **WHEN** a grouped lint error had three occurrences in base and has two of them in head
- **THEN** the finding has state `pre-existing`, is not listed among open findings, and reports one fixed occurrence

#### Scenario: Fixed finding counted
- **WHEN** a lint error present in base is absent in head
- **THEN** the report's summary counts one fixed finding and does not list it as open

### Requirement: Category separates defects from risks
`category` SHALL be `defect` for type errors, lint errors, secrets and vulnerable dependencies, and `risk` for untested changes. Agent hypotheses SHALL additionally distinguish `security`, `style` and `diagnostic`. Verified security findings SHALL retain category `security`; `style` and `diagnostic` SHALL be confined to the category-floor audit footer. Renderers SHALL present risks in a section separate from defects and SHALL NOT call a risk a bug. Plausible agent hypotheses SHALL never be presented as proven defects, including in the security section.

#### Scenario: Risk section
- **WHEN** a review has one type error and two untested changes
- **THEN** the report lists one defect under findings and two entries under risks

#### Scenario: Plausible security remains uncertain
- **WHEN** a security hypothesis is verified only at plausible
- **THEN** it retains its security classification and is labeled as a risk for human judgment

### Requirement: Suppression application
Suppressions from the resolved profile SHALL be applied after identity assignment and before rendering, and each suppressed finding SHALL be counted by suppression entry in the footer.

#### Scenario: Suppressed by id
- **WHEN** the profile suppresses a specific finding id
- **THEN** that finding is absent from every format and the footer attributes one suppression to that entry

### Requirement: Verification metadata
The optional `verification` object SHALL contain positive `voters`, non-negative `agreeing` no greater than voters, a per-voter `blind_match` list containing only `same`, `related` or `none`, and boolean `split`. Metadata SHALL reflect the artifact-backed aggregation, not a confidence score. The full vote audit SHALL distinguish failed votes from completed votes with no blind match.

#### Scenario: Existing finding remains valid
- **WHEN** a deterministic or historical v1 finding omits `verification`
- **THEN** it remains valid against finding-v1 and requires no synthesized verifier votes

#### Scenario: Valid verification summary
- **WHEN** three voters produce static-proven quorum support from two voters with blind matches same, related and none
- **THEN** the finding records three voters, two agreeing and those three blind matches

#### Scenario: Invalid verification counts
- **WHEN** metadata reports more agreeing voters than configured voters
- **THEN** contract validation rejects the metadata

### Requirement: Agent category floor
After verification, agent hypotheses classified as `style` or `diagnostic` SHALL NOT enter open defects, risks or security findings, regardless of evidence level. They SHALL be counted in the audit footer with their categories. A verifier SHALL reclassify a hypothesis downward only with a recorded reason. Deterministic findings SHALL bypass this category floor.

#### Scenario: Proven style is not a defect
- **WHEN** an agent's naming-preference hypothesis is category style with reproduced evidence
- **THEN** it is dropped from open findings and counted under dropped by category floor

#### Scenario: Deterministic lint retained
- **WHEN** a deterministic lint check reports a new configured-rule error
- **THEN** the category floor does not remove that deterministic finding

### Requirement: Agent evidence and severity floors
After the category floor, agent defects SHALL satisfy their resolved evidence and severity floors. Risks SHALL follow the posture risk policy separately, including its plausible-risk allowance and cap. Refuted hypotheses SHALL never be open findings. Plausible hypotheses SHALL render only as risks when the posture permits. Deterministic findings SHALL bypass agent posture filtering. Security SHALL use its independent policy.

#### Scenario: Critical-only excludes weaker proof
- **WHEN** an error-severity general agent defect has static-proven evidence under critical-only posture with no explicit evidence override
- **THEN** it does not appear as an open defect because reproduced evidence is required

#### Scenario: Balanced limits plausible risks
- **WHEN** balanced posture receives more plausible general risks than its max_defects setting
- **THEN** at most max_defects plausible risks render and the remaining eligible risks are held back

#### Scenario: Thorough retains plausible risks
- **WHEN** thorough posture receives plausible general risks
- **THEN** they can render as risks without a plausible-risk count cap

### Requirement: Separate agent presentation caps
Consolidation SHALL order eligible agent defects by impact and evidence strength and retain at most `max_defects` from the general pool. Security SHALL have a separate pool and cap. Equal-ranked entries SHALL have stable ordering. Eligible entries held back by caps SHALL be counted and listed by title in the footer. Deterministic findings SHALL never consume these slots.

#### Scenario: General defect cap
- **WHEN** seven eligible agent defects enter a general pool capped at five
- **THEN** the five highest-ranked defects render and the footer identifies two held-back entries

#### Scenario: Deterministic results do not consume slots
- **WHEN** seven deterministic defects and four eligible agent defects are present with general max_defects three
- **THEN** all seven deterministic defects and the top three agent defects remain eligible to render

#### Scenario: Suppressed entry does not consume a slot
- **WHEN** the highest-ranked eligible agent defect is explicitly suppressed before presentation is capped
- **THEN** another eligible defect can occupy that slot and the suppressed entry is not counted as held back

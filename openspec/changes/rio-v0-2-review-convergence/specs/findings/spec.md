## MODIFIED Requirements

### Requirement: Finding model
A finding SHALL have: `id` (stable identity), `rule_id`, `category` (`defect`, `risk` or `security`), `evidence_level`, `severity` (`error`, `warning`, `info`), `state` (`new`, `worsened`, `pre-existing`, `fixed`, `unclassified`), `location` (repository-relative path, line range, optional column, enclosing symbol path), `message`, `trigger` (the condition under which the problem manifests), optional `impact`, optional `suggested_fix`, `evidence` (references to artifacts in the review cache), `source` (tool and version, or agent name), `locations` for every occurrence merged by root cause, each with its own line range and `occurrence_state` (`new`, `pre-existing`, `fixed` or `unclassified`), and, for `dependency/*` findings, an `advisory` block (`id`, `aliases`, `severity` from `critical`, `high`, `moderate`, `low`, `unknown`, `fixed_version` or `unknown`, `url`). The schema SHALL also define the optional keys `round` (positive integer: the review round within a head lineage that produced the finding), `first_posted_in` (the head SHA or snapshot key of the round in which the finding was first posted) and `author_response` (`{ reason: fixed | wrong | intentional | irrelevant | style, actor, at, note }`); lineage reviews SHALL emit `round` on every finding, `first_posted_in` once the finding has been posted and `author_response` once it has been answered, and their absence SHALL remain valid outside lineages. An optional lifecycle `status` (`open`, `fixed` or `dismissed`) SHALL be emitted for posted lineage findings; it is independent of `state`, which keeps its regression meaning. An optional `verification` block SHALL record `voters`, `agreeing`, per-voter `blind_match` and `split` for verified agent findings; its absence SHALL remain valid for deterministic and historical findings. The JSON form SHALL validate against `schemas/finding-v1.json`.

#### Scenario: JSON validates against the schema
- **WHEN** a review is rendered as JSON
- **THEN** every finding in the document validates against `schemas/finding-v1.json`

#### Scenario: Reserved keys validate
- **WHEN** a hand-written finding document carries `round: 2`, `first_posted_in: "3f2a…"` and `author_response: { reason: intentional, actor: "octocat", at: "2026-11-05T10:00:00Z" }`
- **THEN** it validates against `schemas/finding-v1.json`, and a document with `author_response.reason: known` is rejected

#### Scenario: Lineage review emits round
- **WHEN** a finding is produced by the second round of a lineage and was first posted in round 1
- **THEN** its JSON carries `round: 2`, `first_posted_in` set to the round 1 head and `status: open`, and validates against `schemas/finding-v1.json`

#### Scenario: Lifecycle status does not replace regression state
- **WHEN** a `new` finding is dismissed with reason `wrong`
- **THEN** its JSON carries `state: new` and `status: dismissed`, and a document with `state: dismissed` is rejected

### Requirement: Stable identity
The id SHALL be `blake3(rule_id | normalized_location | trigger_hash)` where `normalized_location` is the repository-relative path plus the enclosing symbol path with line numbers removed, and `trigger_hash` is the hash of the message with only known volatile fragments normalized: line and column references, absolute path prefixes and the repository root, and tool-generated identifiers. Semantic content of the message, including numeric literals, type names and casing, SHALL be preserved. The id SHALL be stable when code moves within a file and when unrelated lines are inserted above it, and SHALL differ for findings whose messages differ in semantic content. A class-level finding, as defined by the review-convergence capability, SHALL instead have id `blake3(rule_id | "class" | trigger_hash)`, and its instances SHALL keep their own ids in `locations`.

#### Scenario: Line shift keeps the id
- **WHEN** ten lines are inserted above a function that has a type error, and the review is run again
- **THEN** the finding keeps the same id

#### Scenario: Different rule gives a different id
- **WHEN** two different lint rules fire on the same line
- **THEN** they produce two findings with different ids

#### Scenario: Class finding identity ignores locations
- **WHEN** a class-level finding gains a sixth instance in a new file on the next round
- **THEN** its id is unchanged and the new instance appears in `locations`

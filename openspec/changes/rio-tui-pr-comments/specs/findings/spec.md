# Spec Delta

## ADDED Requirements

### Requirement: Machine-applicable fix
The finding and hypothesis schemas SHALL accept an optional `fix` object `{ line_start, line_end, replacement }`. The range is inclusive and 1-based, on the primary location's file in the head version, and `replacement` is the full text of those lines. The range SHALL lie within the primary location's file, and `line_end` SHALL NOT be less than `line_start`. The absence of `fix` SHALL remain valid, and `suggested_fix` keeps its prose meaning.

#### Scenario: Valid fix
- **WHEN** a finding at `src/parser/header.ts:42` carries `fix: { line_start: 42, line_end: 42, replacement: "  const [type, params] = (ctype ?? DEFAULT_CTYPE).split(';')" }`
- **THEN** it validates against `schemas/finding-v1.json`

#### Scenario: Inverted range rejected
- **WHEN** a hypothesis carries `fix: { line_start: 50, line_end: 42, replacement: "" }`
- **THEN** the verifier drops the `fix` and keeps the finding with its prose `suggested_fix`

#### Scenario: Historical findings
- **WHEN** a report written before this change is read
- **THEN** its findings without `fix` validate

### Requirement: Council member detail
The finding's council block SHALL record, for each member when known:
- its model `family`;
- `rounds`: for each round it was asked, its `real` answer (`yes`, `no` or `unknown`) or its abstention cause, and whether a round 2 answer changed position citing evidence.

These are optional, so council blocks without them stay valid. They SHALL NOT carry a numeric confidence.

#### Scenario: Changed position
- **WHEN** the skeptic, from the `claude` family, answers `no` in round 1 and `yes` in round 2 citing an experiment
- **THEN** its member entry carries `family: claude` and rounds `[{ round: 1, real: no }, { round: 2, real: yes, changed: true }]`

#### Scenario: Timed out member
- **WHEN** a member's round 1 call times out
- **THEN** its entry is abstained with its family and a round 1 entry with cause `timeout`

### Requirement: Security trace
A security finding SHALL carry an optional `trace` holding its `catalog_item`, its `change` (`introduced`, `removed` or `weakened`) and its ordered `steps`. Steps run from the source, through the changed step, to the sink, each with its role and location. A step the change removed SHALL be marked `missing`. Findings of other categories SHALL NOT carry `trace`.

#### Scenario: Removed owner check
- **WHEN** the security agent reports catalog item `A01`, `trace_change: removed`, and locations source, removed check (base) and sink
- **THEN** the finding's `trace` lists three steps: source, a `missing` check and sink, with `catalog_item: A01` and `change: removed`

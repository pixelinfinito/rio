# Spec Delta

## MODIFIED Requirements

### Requirement: Section order
Every format SHALL present sections in this order: header (review id, run id, mode, base and head identifiers, profile name and chain, Rio version, status `complete`, `incomplete` or `partial`); deterministic results grouped by check kind, with each root's outcome; impact summary; findings (new, worsened and unclassified defects); risks; security findings when present; council results when present (per councilled finding: decision, tier, participating members by role, experiments run, note, and the partial marker); summary counts (pre-existing, fixed, suppressed); footer (skipped checks, deferred steps, excluded files, size notes, tool versions, timings). Sections with nothing to show SHALL be omitted except the header, the findings statement and the footer.

#### Scenario: No findings
- **WHEN** a review produces no findings and no risks
- **THEN** the report contains the header, a line stating that no findings were produced, and the footer

#### Scenario: No findings but incomplete
- **WHEN** a review produces no findings and the coverage check ended `cancelled` with reason `timeout`
- **THEN** the header status is `incomplete`, and the findings statement says that no findings were produced and that coverage did not complete

#### Scenario: Council section placement
- **WHEN** a review has one security finding and one councilled plausible finding
- **THEN** the council section follows the security section, lists the finding's decision, tier, member roles, experiments and note, and precedes the summary counts

## ADDED Requirements

### Requirement: Council cost and coverage in the footer
When the council step ran, the footer SHALL list the number of councilled findings, the number of eligible findings not councilled because of `max_findings`, partial or skipped markers with answered and total member counts, and the cost per councilled finding as members × rounds × experiments together with tokens and runner seconds. The JSON document SHALL carry the same values in an optional `council` metrics object, omitted when the step did not run.

#### Scenario: Capped council in the footer
- **WHEN** seven findings match council rules, `max_findings` is 5, and one council ran partial with four of five members
- **THEN** the footer states five councilled, two not councilled by the cap, `council: partial (4/5)` for that finding, and the per-finding cost, and the JSON `council` object carries the same values

#### Scenario: No council step
- **WHEN** a review runs a profile without a council step
- **THEN** the footer has no council lines and the JSON document has no `council` metrics object

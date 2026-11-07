# Spec Delta

## MODIFIED Requirements

### Requirement: Suppression application
Suppressions from the resolved profile SHALL be applied after identity assignment and before rendering, and each suppressed finding SHALL be counted by suppression entry in the footer. In the same pass, after profile suppressions, remembered dismissals from the finding-history capability (reasons `intentional`, `irrelevant` or `style` on unchanged code) SHALL be applied and counted separately as remembered; a dismissal with reason `wrong` SHALL never be applied as a remembered dismissal.

#### Scenario: Suppressed by id
- **WHEN** the profile suppresses a specific finding id
- **THEN** that finding is absent from every format and the footer attributes one suppression to that entry

#### Scenario: Remembered dismissal counted separately
- **WHEN** a review produces one finding matching a profile suppression and one finding whose identity was dismissed `style` on unchanged code
- **THEN** the footer attributes one suppression to the profile entry and one remembered finding with reason `style`, and neither is rendered in the main sections

## ADDED Requirements

### Requirement: Finding history block
A finding SHALL carry an optional `history` object with `first_seen`, `last_seen`, `seen_count`, `previous_status`, `previous_response` and `dismissed_in` only when the repository registry has an earlier record for its identity, and SHALL omit it otherwise. The block SHALL NOT affect `state`, `status` or fail policy evaluation.

#### Scenario: History on a recurrence
- **WHEN** a finding identity seen in two earlier reviews and last dismissed `wrong` is produced again
- **THEN** the finding's `history` has `seen_count` 2, `previous_status` `dismissed` and `previous_response.reason` `wrong`, and its `state` and fail policy result are those of the current review

#### Scenario: No history on first occurrence
- **WHEN** a finding identity is produced for the first time in the repository
- **THEN** the finding has no `history` object and still validates

### Requirement: Cached hypothesis provenance
A finding whose hypotheses were replayed from the agent result cache SHALL carry `source.cached: true` and SHALL otherwise be indistinguishable from a freshly generated finding in identity, verification and policy evaluation.

#### Scenario: Cache hit finding
- **WHEN** an agent's hypotheses for a hunk are replayed from the cache and verified
- **THEN** the resulting finding has `source.cached: true`, the same identity it would have had from a fresh model call, and the same fail policy result

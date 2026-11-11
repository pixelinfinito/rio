# Spec Delta

## MODIFIED Requirements

### Requirement: Response entry points
`rio feedback <id> --dismiss <reason> [--note TEXT]`, `POST /v1/findings/{id}/feedback`, and in PR mode a `/rio dismiss <id> <reason>` comment SHALL each write the same `author_response` to the finding and to the feedback record. Each entry point SHALL accept as `<id>` the full identity or a prefix of at least eight characters that matches exactly one posted finding. Shorter or ambiguous prefixes SHALL change nothing. A PR-comment dismissal SHALL be accepted only from repository collaborators; others SHALL be ignored and logged. A dismissal SHALL NOT change posture, budgets, rules or suppressions.

#### Scenario: CLI dismissal
- **WHEN** `rio feedback 8c1e4a9b --dismiss intentional --note "documented behavior"` is run against a configured endpoint
- **THEN** the finding's `author_response` records reason `intentional`, the note, the caller and a timestamp, and the command exits 0

#### Scenario: Same prefix everywhere
- **WHEN** the eight-character id shown in a PR comment footer is used with `rio feedback`, the feedback API and `/rio dismiss`
- **THEN** each resolves the same finding

#### Scenario: Fork contributor cannot dismiss
- **WHEN** a non-collaborator comments `/rio dismiss 8c1e4a9b wrong` on a fork PR
- **THEN** the finding is unchanged and the ignored dismissal is logged

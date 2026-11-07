# Spec Delta

## Purpose

Remember every finding per repository across reviews and lineages, so that answered findings stay answered on unchanged code, recurrences are visible, and the history is queryable.

## ADDED Requirements

### Requirement: Repository finding registry
The endpoint SHALL keep, per tenant and repository, one registry record per finding identity holding the first and last review that produced it, the number of reviews that produced it, its latest lifecycle status, its latest author response, its last location, and a code hash of the normalized text of the enclosing symbol at the head where the status was last set. The record SHALL be updated from every finished review, whether or not the review belongs to a lineage.

#### Scenario: Plain review updates the registry
- **WHEN** a review without a lineage finishes and produces a finding identity never seen in that repository
- **THEN** the registry gains a record for that identity with first seen and last seen set to that review and a seen count of one

#### Scenario: Recurrence increments the count
- **WHEN** a later review of the same repository produces the same identity
- **THEN** the record's last seen is that review and its seen count is two

### Requirement: Remembered dismissals
A finding whose registry status is `dismissed` with reason `intentional`, `irrelevant` or `style`, and whose current code hash equals the recorded one, SHALL be removed from the main findings, risks and security sections of later reviews of the same repository and counted in the footer as remembered, with its reason and the review or pull request in which it was dismissed.

#### Scenario: Dismissed on unchanged code
- **WHEN** a finding was dismissed `intentional` in pull request 41 and a later pull request reproduces the identity on an unchanged enclosing symbol
- **THEN** the finding is absent from the main sections and the footer lists one remembered finding with reason `intentional` from pull request 41

### Requirement: Changed code re-reports
When the current code hash of a remembered identity differs from the recorded one, the finding SHALL be reported normally and SHALL carry a `history` block showing the earlier dismissal.

#### Scenario: Symbol edited after dismissal
- **WHEN** a finding dismissed `irrelevant` reappears after its enclosing symbol was modified
- **THEN** the finding appears in the main section and its `history` names the earlier `irrelevant` response and where it was given

### Requirement: Wrong is never remembered
A `wrong` dismissal SHALL NOT remove a recurring identity from any later report. A recurrence of an identity last dismissed `wrong` SHALL be reported with a `history` block carrying the earlier `wrong` response so the recurrence is visible to readers and evaluation.

#### Scenario: Wrong finding recurs on unchanged code
- **WHEN** a finding dismissed `wrong` reproduces on an unchanged enclosing symbol
- **THEN** the finding is reported in the main section with `history.previous_response.reason` equal to `wrong`

### Requirement: Fixed finding regression
When an identity whose registry status is `fixed` is produced again, the finding SHALL be reported and marked as a regression of a fixed finding, naming the review that recorded the fix.

#### Scenario: Fixed identity reappears
- **WHEN** a finding recorded `fixed` in review R1 is produced by review R3
- **THEN** review R3 reports the finding and labels it a regression of a finding fixed in R1

### Requirement: Registry listing endpoint
`GET /v1/findings` SHALL list the caller's registry records and accept filters for repository, lifecycle status, rule id and a since timestamp. Records of other tenants SHALL never be returned.

#### Scenario: Filter by status and rule
- **WHEN** the endpoint is queried with status `dismissed` and rule `lint/eslint/no-unused-vars`
- **THEN** only dismissed records with that rule id for the caller's tenant are returned

#### Scenario: Cross-tenant isolation
- **WHEN** a token of tenant A queries a repository key that only tenant B has reviewed
- **THEN** the response contains no records

### Requirement: CLI registry view
`rio findings` SHALL render the repository's registry from the configured endpoint in terminal form by default and as one JSON document with `--format json`, accepting `--status`, `--rule` and `--since` filters. Without an endpoint it SHALL exit 2 naming the requirement.

#### Scenario: Terminal listing
- **WHEN** `rio findings --status open` runs in a repository with three open and two dismissed records
- **THEN** three records are printed with identity, rule, last location, status and last seen

#### Scenario: No endpoint
- **WHEN** `rio findings` runs with no endpoint configured
- **THEN** the command exits 2 and states that an endpoint is required

### Requirement: History block contents
The optional finding `history` block SHALL contain `first_seen`, `last_seen`, `seen_count`, `previous_status`, `previous_response` and `dismissed_in`, SHALL be present only when the registry has an earlier record for the identity, and SHALL NOT change `state`, `status` or fail policy evaluation.

#### Scenario: First occurrence has no history
- **WHEN** a finding identity is produced for the first time in a repository
- **THEN** the finding carries no `history` block

### Requirement: Show remembered findings
`rio review --show-remembered` SHALL render remembered findings in the main sections, labeled remembered with their reason, without changing fail policy evaluation or the footer count.

#### Scenario: Remembered finding shown on request
- **WHEN** a review has one remembered `style` finding and runs with `--show-remembered`
- **THEN** the finding is rendered with a remembered label and reason `style`, the footer still counts one remembered finding, and the exit code is unchanged

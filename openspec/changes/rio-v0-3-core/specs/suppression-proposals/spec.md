# Spec Delta

## Purpose

Turn repeated dismissals into suppression proposals that a human reviews and applies to the repository's profile, so nothing is ever silenced automatically.

## ADDED Requirements

### Requirement: Proposal computation
When a review finishes, the endpoint SHALL compute suppression proposals for its repository from responses of the last 90 days: at least `proposal_threshold` (default 3) responses with reason `irrelevant` or `style` on one rule id SHALL yield a `{ rule: <rule id> }` proposal, and the same count on findings under one directory with differing rule ids SHALL yield a `{ path: <dir>/** }` proposal. Responses with reason `wrong`, `fixed` or `intentional` SHALL NOT count.

#### Scenario: Same rule dismissed three times
- **WHEN** a repository has three `style` responses on `lint/eslint/max-len` within 90 days
- **THEN** a proposal `{ rule: "lint/eslint/max-len" }` exists for that repository

#### Scenario: Wrong does not propose
- **WHEN** a repository has five `wrong` responses on one rule id and no other responses
- **THEN** no proposal exists for that rule

#### Scenario: Directory with mixed rules
- **WHEN** three `irrelevant` responses fall on findings under `docs/generated/` with three different rule ids
- **THEN** a proposal `{ path: "docs/generated/**" }` exists

### Requirement: Proposal record
Each proposal SHALL have an id, the suppression entry, a status of `proposed`, `applied` or `declined`, and its evidence: the finding identities, reasons, actors and dates of the responses that produced it.

#### Scenario: Evidence attached
- **WHEN** a proposal is listed
- **THEN** it shows its id, entry, status and every contributing response with identity, reason, actor and date

### Requirement: Proposals in the footer
The report footer SHALL list the repository's open proposals with their entries and evidence counts.

#### Scenario: Open proposal shown
- **WHEN** a review finishes in a repository with one proposal in status `proposed` backed by four responses
- **THEN** the footer lists that entry with an evidence count of four

### Requirement: Listing proposals
`GET /v1/suppressions` SHALL list the caller's proposals filtered by repository and status, never returning another tenant's proposals. `rio suppressions list` SHALL render them for the current repository in terminal form, or as one JSON document with `--format json`.

#### Scenario: CLI listing
- **WHEN** `rio suppressions list` runs in a repository with one proposed and one declined proposal
- **THEN** both are printed with id, entry, status and evidence count

### Requirement: Applying a proposal
`rio suppressions apply <id>` SHALL print the entry and its evidence, require confirmation unless `--yes` is given, append the entry under `suppress` in `.rio/profiles/default.yaml` (creating that file extending `rio/base` when absent), validate the resulting profile, and mark the proposal `applied` on the endpoint. When validation fails the file SHALL be left unchanged and the proposal SHALL stay `proposed`.

#### Scenario: Confirmed application
- **WHEN** `rio suppressions apply p1` runs and the user confirms
- **THEN** the default profile contains the proposed entry, validates, and the proposal's status is `applied`

#### Scenario: Declined confirmation
- **WHEN** `rio suppressions apply p1` runs and the user answers no
- **THEN** no file changes and the proposal remains `proposed`

#### Scenario: Profile missing
- **WHEN** `rio suppressions apply p1 --yes` runs in a repository without `.rio/profiles/default.yaml`
- **THEN** the file is created extending `rio/base` with the single suppression entry

### Requirement: Declining a proposal
`rio suppressions decline <id> [--note TEXT]` SHALL mark the proposal `declined` with the note, and the same entry SHALL NOT be re-proposed for that repository for 180 days.

#### Scenario: Declined entry not re-proposed
- **WHEN** a `{ rule }` proposal is declined and two more `style` responses on that rule arrive within 180 days
- **THEN** no new proposal for that rule is created

### Requirement: Nothing suppressed automatically
A proposal SHALL NOT affect any review until its entry is present in the resolved profile. The endpoint SHALL NOT write to repository files.

#### Scenario: Proposed but not applied
- **WHEN** a proposal is `proposed` and a new review produces a finding matching its entry
- **THEN** the finding is reported normally and the footer shows the proposal

### Requirement: Threshold option
The `rio/report` step SHALL accept `proposal_threshold` (positive integer, default 3) and validation SHALL reject other values.

#### Scenario: Invalid threshold
- **WHEN** a profile sets the report step's `proposal_threshold` to 0
- **THEN** profile validation fails naming the option

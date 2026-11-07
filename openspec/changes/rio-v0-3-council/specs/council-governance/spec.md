# Spec Delta

## Purpose

Control which vendors may receive council evidence packs, make every transfer inspectable, and keep the council opt-in so no repository sends code to a second vendor without an explicit decision.

## ADDED Requirements

### Requirement: Double vendor allowlist
A member SHALL participate only when its vendor appears both in the resolved profile's `council.vendors_allowed` list and in the repository's council vendor allowlist. A member failing either check SHALL be excluded before any evidence pack is built, and the exclusion SHALL be reported in the council section with the vendor and the list that denied it.

#### Scenario: Vendor missing from repository allowlist
- **WHEN** the profile allows `openai` and `google` and the repository allowlist contains only `openai`
- **THEN** members with vendor `google` are excluded before the pack is built and the report names `google` as denied by the repository allowlist

#### Scenario: Empty profile allowlist
- **WHEN** the profile's `council.vendors_allowed` is empty
- **THEN** no external member participates and the council runs only with self-hosted members, or is skipped when none exist

### Requirement: Audit record
For every finding and member the review SHALL record vendor, model, the content hashes and byte sizes of the evidence pack sent, and the timestamp, stored with the review and queryable through the review audit. Self-hosted members SHALL be recorded with no external vendor. Audit entries SHALL contain hashes, never pack content.

#### Scenario: Audit lists every transfer
- **WHEN** a council runs four external members on one finding over two rounds
- **THEN** the audit holds eight entries, each with vendor, model, pack hashes, byte sizes and a timestamp, and none contains source text

#### Scenario: Audit available after the review
- **WHEN** a user requests the review audit for a council-reviewed review
- **THEN** the council transfers are listed per finding and member

### Requirement: Opt-in at initialization
`rio init` SHALL offer a council step after the primary provider step, which chooses vendors, stores their keys as endpoint secrets and writes the repository allowlist. The step SHALL be skippable, SHALL default to no council, and SHALL be reproducible non-interactively from the saved configuration without storing provider keys in the repository.

#### Scenario: Council skipped
- **WHEN** a user declines the council step in `rio init`
- **THEN** no council vendors are allowlisted, no council secrets are stored, and later reviews run without the step

#### Scenario: Non-interactive replay
- **WHEN** `rio init --from config.toml` runs with a saved council vendor selection and keys supplied through the private secrets source
- **THEN** the same allowlist and secrets are configured without prompts and nothing secret is written to the repository

### Requirement: Profile defaults
The council step SHALL be disabled in `rio/base` and enabled in the `security` and `critical` built-in profiles. A profile that enables the council with no allowlisted vendor and no self-hosted member SHALL validate with a warning stating that the step will be skipped.

#### Scenario: Base profile has no council
- **WHEN** `rio/base` is resolved
- **THEN** the council step is present and disabled, and no council model call is possible

#### Scenario: Security profile enables council
- **WHEN** `rio/security` is resolved after `rio init` filled the allowlist
- **THEN** the council step is enabled with the five built-in members and the configured vendors

### Requirement: Retention of council artifacts
Evidence packs, assessments, experiment outputs and decisions SHALL be retained for the repository's evidence retention period and then deleted, while audit entries SHALL be kept as long as the finding they belong to.

#### Scenario: Pack expires, audit stays
- **WHEN** a council-reviewed review passes the evidence retention period
- **THEN** its packs, assessments and experiment outputs are deleted and the audit entries remain queryable with their hashes

### Requirement: Content limited to the evidence pack
Content sent to a council vendor SHALL be limited to the evidence pack for the finding under assessment: the hypothesis, the graph slice, base and head of the affected files, the verifier's artifacts, the intent artifact and in-scope owner guidance. The whole snapshot, unrelated files, repository secrets and other findings' packs SHALL NOT be sent.

#### Scenario: Pack excludes unrelated files
- **WHEN** a finding affects two files in a repository of two hundred files
- **THEN** the evidence pack contains those two files in both versions and the graph slice around them, and no other file content

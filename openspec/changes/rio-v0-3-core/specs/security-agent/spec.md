# Spec Delta

## Purpose

Review changes for security defects against a named catalog, tracing input through validation, authorization and transformation to sensitive operations, and report which catalog items were and were not assessed.

## ADDED Requirements

### Requirement: Catalog modules
Security catalogs SHALL be modules of kind `catalog`. Rio SHALL ship `owasp-top10-2025` and `asvs-5.0`. Each catalog item SHALL have an `id` (the official identifier), `title`, a `summary` written for Rio, `applies_when` predicates over languages, detected frameworks, touched node kinds and sensitive paths, and `trace` hints naming the taint sources and sinks relevant to the item. Catalog files SHALL carry the attribution their source license requires.

#### Scenario: Catalog validates
- **WHEN** the shipped `asvs-5.0` catalog is loaded
- **THEN** every item has an official id, title, summary, `applies_when` and `trace` fields, and the file states its attribution

#### Scenario: Only shipped catalogs
- **WHEN** a profile sets the security step's `catalog` to a path or to a name other than `owasp-top10-2025` or `asvs-5.0`
- **THEN** profile validation rejects the value at the option's location

### Requirement: Applicability filtering
The security step SHALL evaluate each item's `applies_when` against the change (languages, frameworks detected by prepare, touched node kinds such as endpoint, table and config, and matches of the triage sensitive paths) and SHALL give the agent only applicable items. Items that do not apply SHALL be recorded as `not_applicable` in the security section.

#### Scenario: Backend-only change
- **WHEN** a change touches only a Rust database module with no endpoint
- **THEN** items whose `applies_when` requires an endpoint are recorded as `not_applicable` and are not given to the agent

### Requirement: Taint trace model
For each applicable item the agent SHALL trace input through validation, authorization and transformation to the sensitive operation along the graph in both versions, and SHALL state for each hypothesis whether the change introduced, removed or weakened a step of that trace.

#### Scenario: Removed validation
- **WHEN** head removes a length check between a request parameter and a query builder
- **THEN** the hypothesis's trace lists the parameter, the removed check in base, and the query as locations, and states that the change removed validation

### Requirement: Hypothesis content
Security hypotheses SHALL have category `security`, SHALL carry the `catalog_item` id they relate to, SHALL list the trace path as locations, and SHALL pass through the shared verifier before reporting.

#### Scenario: Hypothesis with catalog item
- **WHEN** the agent reports a possible injection under `asvs-5.0`
- **THEN** the hypothesis carries the matching ASVS item id and goes to verification as a `security` hypothesis

### Requirement: Unassessed items
The agent SHALL return an `unassessed` list naming each applicable item it could not conclude on with a reason of `budget`, `no_evidence` or `tools_unavailable`. The security section SHALL list assessed, unassessed and not-applicable items, and the footer SHALL state the unassessed count.

#### Scenario: Budget exhausted
- **WHEN** the agent's budget ends after assessing six of nine applicable items
- **THEN** the three remaining items are listed as unassessed with reason `budget` and the footer states three items were not assessed

### Requirement: Nothing found is not nothing checked
A security run that produces no hypothesis SHALL still report which items were assessed and which were not, and SHALL NOT be presented as a clean security review when any applicable item is unassessed.

#### Scenario: Zero hypotheses with unassessed items
- **WHEN** the agent returns no hypothesis and two applicable items are unassessed
- **THEN** the security section states no security finding was produced, lists the two unassessed items, and the review is not labeled a passed security review

### Requirement: Execution defaults
The security agent SHALL have `run` enabled by default on non-fork reviews and SHALL run static-only on fork pull requests, with the restriction reported.

#### Scenario: Fork security review
- **WHEN** security is enabled on a fork pull request
- **THEN** the agent runs without execution tools and the report notes the static-only restriction

### Requirement: Security community profile
Rio SHALL ship a built-in `rio/security` profile that extends `rio/base`, enables the security step with `posture: thorough` and `catalog: asvs-5.0`, and leaves every other base setting unchanged.

#### Scenario: Community profile resolved
- **WHEN** `rio profile show rio/security` runs
- **THEN** the resolved profile shows the security step enabled with thorough posture and the `asvs-5.0` catalog

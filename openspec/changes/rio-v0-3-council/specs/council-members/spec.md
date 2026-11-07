# Spec Delta

## Purpose

Define council members as modules: their manifest fields, the built-in roles and context packs, the family and vendor constraints on a council's composition, and the structured assessment each member returns.

## ADDED Requirements

### Requirement: Member module kind
Module manifest v1 SHALL accept kind `member` with fields `provider`, `model`, `prompt` (a path), `context_pack` (`diff-only`, `graph-heavy` or `execution`), `role` (`skeptic`, `exploit-author`, `code-owner`, `maintainer` or `tester`), `weight` (positive number), `family` (model family name), `self_hosted` (boolean, default false) and a derived `vendor` taken from `provider`. A manifest with an unknown `role`, `context_pack` or an extra property SHALL be rejected naming the field.

#### Scenario: Valid member manifest
- **WHEN** a manifest declares kind `member` with provider `openai`, model `gpt-5`, role `skeptic`, context pack `diff-only`, weight 1 and family `gpt`
- **THEN** it validates and resolves `vendor` to `openai`

#### Scenario: Unknown role rejected
- **WHEN** a member manifest sets `role: judge`
- **THEN** validation fails naming `role` and listing the five accepted roles

### Requirement: Built-in members
Rio SHALL ship five built-in members: `skeptic` (context pack `diff-only`, argues the finding is wrong), `exploit-author` (`execution`, tries to write the failing input), `code-owner` (`graph-heavy`, asks what the surrounding code assumes), `maintainer` (`graph-heavy`, asks whether the change introduced it) and `tester` (`execution`, asks what test would prove it). Their providers and models SHALL be placeholders in `rio/base` until `rio init` fills them.

#### Scenario: Built-in members load
- **WHEN** the shipped member modules are loaded
- **THEN** exactly five members exist with the roles and context packs listed, each with a prompt file and a positive initial weight

### Requirement: Family diversity validation
Profile validation SHALL reject a council whose configured members span fewer than three distinct model families, naming the families found. Members whose provider is still a placeholder SHALL be reported by `rio profile validate` as unconfigured rather than invalid, and the profile SHALL remain valid for every other purpose.

#### Scenario: Two families rejected
- **WHEN** a profile's five members resolve to families `claude`, `claude`, `claude`, `gpt` and `gpt`
- **THEN** validation fails stating that two families were found and three are required

#### Scenario: Placeholders reported as unconfigured
- **WHEN** `rio profile validate` runs on `rio/security` before `rio init` has filled the council providers
- **THEN** the profile validates and the output lists the council members as unconfigured with the `rio init` hint

### Requirement: Author-family rule
When pull request metadata identifies the author as an agent of model family F, at most one participating member SHALL be of family F; other members of family F SHALL be substituted from allowlisted vendors of other families, or the council SHALL run partial without them. When no metadata identifies the author's family, the rule SHALL be reported as not applicable in the council section.

#### Scenario: Two members share the author's family
- **WHEN** the PR author is an agent of family `claude` and two configured members are of family `claude`, with an allowlisted `gemini` member available
- **THEN** one `claude` member participates, the other is replaced by the `gemini` member, and the substitution is recorded

#### Scenario: No substitute available
- **WHEN** the PR author is an agent of family `gpt`, two members are of family `gpt`, and no other allowlisted family is available
- **THEN** one `gpt` member is dropped and the council runs partial with four members

#### Scenario: No author metadata
- **WHEN** a review has no pull request metadata
- **THEN** every configured member participates and the council section states that the author-family rule was not applicable

### Requirement: Assessment schema
A member's assessment SHALL validate against `council-assessment-v1`: `member` (the role, never a provider identity), `round` (1 or 2), `real` and `introduced_by_change` (`yes`, `no` or `unknown`), `impact` (free text), `basis` (`reproduction`, `static_path`, `protection_found`, `contract` or `none`) and a non-empty `evidence_refs` list of artifact ids. Properties outside the schema SHALL be rejected.

#### Scenario: Valid round-1 assessment
- **WHEN** a member returns role `tester`, round 1, `real: yes`, `introduced_by_change: unknown`, basis `static_path` and one evidence ref
- **THEN** the assessment is accepted

#### Scenario: Extra prose field rejected
- **WHEN** an assessment adds a `reasoning` property
- **THEN** it fails validation and counts as an abstention

### Requirement: Experiment request field
A round-1 assessment SHALL be able to carry one optional `experiment_request` with `command` (an argv list), `version` (`base`, `head` or `both`) and `expect` (`fails`, `passes` or `output_contains`). A request in round 2, a second request in one assessment, or a request missing any of the three fields SHALL be rejected and the assessment SHALL be treated as having no request.

#### Scenario: Valid experiment request
- **WHEN** a round-1 assessment requests `["npm","test","--","auth"]` on `head` expecting `fails`
- **THEN** the request is queued for experiment selection

#### Scenario: Request in round 2 ignored
- **WHEN** a round-2 assessment includes an experiment request
- **THEN** the request is dropped and the assessment is otherwise processed

### Requirement: Round-2 position change fields
A round-2 assessment SHALL either repeat the round-1 position with no change fields, or carry `changed_from`, `changed_to` and `cites` where `cites` is `{ kind: artifact | assessment, ref, reason_code }` and `reason_code` is one of `new_artifact`, `missing_protection`, `wrong_path`, `wrong_version` or `contract_misread`. A change whose `cites.ref` does not name an existing artifact id or assessment letter SHALL be ignored and the round-1 position SHALL stand.

#### Scenario: Valid change with citation
- **WHEN** a member changes `real` from `yes` to `no` citing assessment `B` with reason code `missing_protection`
- **THEN** the round-2 position is `no` and the citation is recorded

#### Scenario: Change without a valid citation
- **WHEN** a member changes position citing artifact `exp-9` that does not exist
- **THEN** the change is ignored, the round-1 position stands, and the invalid citation is recorded

### Requirement: Abstention
An assessment that fails validation, has an empty `evidence_refs` list, or arrives after the step timeout SHALL count as an abstention for that member and round, recorded with its cause. Abstentions SHALL never contribute a position to aggregation.

#### Scenario: Empty evidence refs
- **WHEN** a member returns `real: yes` with `evidence_refs: []`
- **THEN** the member abstains for that round with cause `no_evidence_refs`

#### Scenario: Late answer
- **WHEN** a member's answer arrives after the council timeout
- **THEN** it is recorded as an abstention with cause `timeout` and is not shown to other members

### Requirement: Free prose confined to impact
Only the `impact` field SHALL carry free text; it SHALL be shown to humans and SHALL NOT be parsed, matched or used by aggregation. Every other field SHALL be an enumerated value, a reference or a structured object.

#### Scenario: Impact text ignored by aggregation
- **WHEN** a member's `impact` text asserts that the finding is reproduced while its `basis` is `none`
- **THEN** aggregation treats the assessment as basis `none`

### Requirement: Self-hosted members
A member with `self_hosted: true` SHALL be served through the model endpoint that a registered self-hosted runner advertises in its capabilities, so its evidence pack never leaves the account. When no runner advertises a model endpoint, the member SHALL be recorded as unavailable and the council SHALL continue without it.

#### Scenario: Self-hosted member runs locally
- **WHEN** a self-hosted member is configured and a runner advertises a model endpoint
- **THEN** the member's request is routed to that runner and the audit records no external vendor for it

#### Scenario: No runner endpoint
- **WHEN** a self-hosted member is configured and no registered runner advertises a model endpoint
- **THEN** the member is marked unavailable and the remaining members proceed

### Requirement: Execution pack on fork pull requests
On a fork pull request the `execution` context pack SHALL omit runnable artifacts and the project's test command, and members SHALL NOT be able to request experiments; the `exploit-author` and `tester` roles SHALL receive the `graph-heavy` rendering instead and the council section SHALL state the restriction.

#### Scenario: Fork council
- **WHEN** the council runs on a finding from a fork pull request
- **THEN** no experiment requests are accepted, the `exploit-author` member receives no runnable artifacts, and the report states that the council ran static-only

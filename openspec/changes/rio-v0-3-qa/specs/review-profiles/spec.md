# Spec Delta

## MODIFIED Requirements

### Requirement: Built-in step options
The `with` schemas of the built-in steps SHALL define the review settings that this version supports. Each option SHALL be validated against the step's schema:
- `rio/prepare`: `exclude` (list of globs relative to the repository root, default `[]`);
- `rio/checks`: `typecheck`, `lint`, `secrets`, `coverage`, `dependencies`, `baseline` (booleans, default `true`), and `trust_installed_dependencies` (boolean, default `false`);
- `rio/graph`: `hops` (default 2) and `max_nodes` (default 2000);
- `rio/security`: `enabled` (default false in v0.2 base), `posture`, `fail_on`, `max_defects`, and `catalog` with the security-step contract;
- `rio/qa`: `enabled` (default false in base), `mode` (`changed` default, `full`), `harness` (`codex` default, `pi`), `baseline` (default false), `max_journeys` (default 12), `max_defects` (default 15), `viewports` (names from the contract, default all), `rules` (`disable[]`, `add[]`, `adopt[]`, merged over the contract), `sandbox` (`deny` default, `allow`) and `fail_on` with the same shape as the security policy, defaulting to category `ux` at evidence `plausible` for `new` and `worsened` findings of severity `warning` or above;
- `rio/triage`: explicit risk thresholds for sensitive-path globs, public-contract changes, dependency changes, missing coverage and graph fan-out.

#### Scenario: Exclusion glob from the profile
- **WHEN** the `rio/prepare` step sets `with: { exclude: ["docs/generated/**"] }` and a change modifies `docs/generated/api.ts`
- **THEN** the file is excluded from checks and the graph, and the footer lists it with reason `profile_exclude`

#### Scenario: QA option fails its schema
- **WHEN** a profile sets `rio/qa` with `with: { harness: claude }`
- **THEN** validation fails naming the step, the option and the allowed values `codex` and `pi`

#### Scenario: Profile narrows the matrix but keeps mobile
- **WHEN** a profile sets the qa step's `viewports: [mobile-small, mobile, desktop]`
- **THEN** the resolved profile runs those three viewports; `viewports: [desktop, wide]` is rejected because no mobile viewport remains

#### Scenario: QA policy independent of general cap
- **WHEN** a profile has `max_defects: 3` and the QA step sets `max_defects: 10`
- **THEN** QA findings resolve their cap to ten and the general cap remains three

### Requirement: Local execution subset
When no endpoint is configured, the engine SHALL execute steps whose module is locally executable (`rio/prepare` without its intent agent, `rio/checks`, `rio/graph`, `rio/report`, and enabled `rio/qa` when a Docker daemon and the paired QA runner image are available) in `needs` order, and SHALL mark every other step (`rio/triage`, `rio/agents`, `rio/verify` and enabled `rio/security`) as deferred in the report without failing the run. When `rio/qa` is enabled but no runtime is available, it SHALL be deferred with reason `no_runtime`. Locally executed QA observations SHALL be reported as unverified in the QA section because `rio/verify` is deferred; probe findings SHALL render normally.

#### Scenario: Base profile runs locally
- **WHEN** `rio/base` is used with no endpoint
- **THEN** prepare, checks, graph and report execute, and triage, agents and verify appear in the footer as deferred

#### Scenario: Disabled security is not executed
- **WHEN** the base profile contains security with `with.enabled: false`
- **THEN** no security model call is made and the local deterministic subset still works

#### Scenario: QA runs locally with Docker
- **WHEN** the `rio/qa` built-in profile is used with no endpoint and Docker available
- **THEN** prepare, graph, qa and report execute; probe findings render at `static_proven`; agent observations render as unverified in the QA section; and verify is listed as deferred

### Requirement: Guardrails cannot be overridden
A resolved profile that contains any enabled step using `rio/agents`, `rio/security` or `rio/qa` SHALL also contain a step using `rio/verify` that depends on it; removing or disabling the verifier through inheritance or triage SHALL be rejected. `min_evidence` SHALL never resolve below `plausible`.

#### Scenario: Dropping the verifier is rejected
- **WHEN** a child profile redeclares `steps` with the agents step but no `rio/verify` step
- **THEN** validation fails stating the verifier step is mandatory when agents are configured

#### Scenario: Security requires verification
- **WHEN** a profile enables `rio/security` but no verifier depends on it
- **THEN** validation rejects the unverified security pipeline

#### Scenario: QA requires verification
- **WHEN** a profile enables `rio/qa` but no verifier depends on it
- **THEN** validation rejects the unverified QA pipeline

## ADDED Requirements

### Requirement: QA budget block
`budget.<mode>` SHALL accept an optional `qa` object with `wall`, `cell_wall`, `tokens`, `evidence_bytes` and `replay_wall`; profile-v1 SHALL publish it and validation SHALL reject non-positive values. When a profile enables `rio/qa`, the review deadline SHALL be `wall_time` plus `qa.wall` plus the verification reserve, and the resolved values SHALL be written to the resolved profile.

#### Scenario: QA budget defaults
- **WHEN** a profile enables `rio/qa` without a `qa` budget object
- **THEN** fast resolves to `wall: 30m`, `cell_wall: 8m`, `tokens: 150000`, `evidence_bytes: 512 MiB`, `replay_wall: 5m` and deep to `90m`, `15m`, `300000`, `1 GiB`, `10m`

#### Scenario: Deadline extended by QA
- **WHEN** `budget.fast.wall_time` is `4m`, QA is enabled with default `qa.wall` and the verification reserve is 5 minutes
- **THEN** the resolved review deadline is 39 minutes and the resolved profile records all three parts

#### Scenario: Unknown QA budget key rejected
- **WHEN** a profile sets `budget.fast.qa.journeys: 3`
- **THEN** validation fails naming the key

### Requirement: QA built-in profile
A built-in profile `rio/qa` SHALL extend `rio/base`, enable `rio/qa` in `changed` mode with `needs: [graph]`, add `qa` to the verifier's and the report's `needs`, and keep every other step as in base. `rio/base` SHALL carry `rio/qa` disabled with the same wiring so a document extending it can enable QA by setting one option.

#### Scenario: Enable with one key
- **WHEN** a repository profile extends `rio/base` and sets the qa step's `with.enabled: true`
- **THEN** the resolved profile runs QA in changed mode with the default budgets and policy and `verify` depends on `qa`

#### Scenario: Base makes no QA calls
- **WHEN** `rio/base` is reviewed
- **THEN** no pod is started for QA and no QA model call is made

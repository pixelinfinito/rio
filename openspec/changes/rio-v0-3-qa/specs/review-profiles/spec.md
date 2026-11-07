# Spec Delta

## MODIFIED Requirements

### Requirement: Built-in step options
The `with` schemas of the built-in steps SHALL define the review settings that this version supports. Each option SHALL be validated against the step's schema:
- `rio/prepare`: `exclude` (list of globs relative to the repository root, default `[]`);
- `rio/checks`: `typecheck`, `lint`, `secrets`, `coverage`, `dependencies`, `baseline` (booleans, default `true`), and `trust_installed_dependencies` (boolean, default `false`);
- `rio/graph`: `hops` (default 2) and `max_nodes` (default 2000);
- `rio/security`: `enabled` (default false in v0.2 base), `posture`, `fail_on`, `max_defects`, and `catalog` with the security-step contract;
- `rio/qa`: `enabled` (default false in base), `mode` (`changed` default, `full`), `harness` (`codex` default, `pi`), `baseline` (default false), `max_journeys` (default 12), `max_defects` (default 15), `viewports` (list of names declared in `.rio/qa.yaml`, default all), `rules` (`disable[]`, `add[]`, merged over the environment contract) and `fail_on` with the same shape as the security policy, defaulting to category `ux` at evidence `plausible` for `new` and `worsened` findings;
- `rio/triage`: explicit risk thresholds for sensitive-path globs, public-contract changes, dependency changes, missing coverage and graph fan-out.

#### Scenario: Exclusion glob from the profile
- **WHEN** the `rio/prepare` step sets `with: { exclude: ["docs/generated/**"] }` and a change modifies `docs/generated/api.ts`
- **THEN** the file is excluded from checks and the graph, and the footer lists it with reason `profile_exclude`

#### Scenario: QA option fails its schema
- **WHEN** a profile sets `rio/qa` with `with: { harness: claude }`
- **THEN** validation fails naming the step, the option and the allowed values `codex` and `pi`

#### Scenario: QA policy independent of general cap
- **WHEN** a profile has `max_defects: 3` and the QA step sets `max_defects: 10`
- **THEN** QA findings resolve their cap to ten and the general cap remains three

### Requirement: Local execution subset
When no endpoint is configured, the engine SHALL execute steps whose module is locally executable (`rio/prepare` without its intent agent, `rio/checks`, `rio/graph`, `rio/report`, and enabled `rio/qa` when a Docker daemon and the paired QA runner image are available) in `needs` order, and SHALL mark every other step (`rio/triage`, `rio/agents`, `rio/verify` and enabled `rio/security`) as deferred in the report without failing the run. When `rio/qa` is enabled but no runtime is available, it SHALL be deferred with reason `no_runtime`. Locally executed QA observations SHALL be reported as unverified hypotheses in the QA section because `rio/verify` is deferred.

#### Scenario: Base profile runs locally
- **WHEN** `rio/base` is used with no endpoint
- **THEN** prepare, checks, graph and report execute, and triage, agents and verify appear in the footer as deferred

#### Scenario: Disabled security is not executed
- **WHEN** the base profile contains security with `with.enabled: false`
- **THEN** no security model call is made and the local deterministic subset still works

#### Scenario: QA runs locally with Docker
- **WHEN** the `rio/qa` built-in profile is used with no endpoint and Docker available
- **THEN** prepare, graph, qa and report execute; probe findings render at `static_proven`; agent observations render as unverified in the QA section; and verify is listed as deferred

## ADDED Requirements

### Requirement: QA built-in profile
A built-in profile `rio/qa` SHALL extend `rio/base`, enable `rio/qa` in `changed` mode after `graph` and before `verify`, set `budget.fast.qa_wall: 30m`, `budget.fast.qa_journey_wall: 8m`, `budget.deep.qa_wall: 90m` and `budget.deep.qa_journey_wall: 15m`, and keep every other step as in base. `rio/base` SHALL carry `rio/qa` disabled so a document extending it can enable QA by setting one option.

#### Scenario: Enable with one key
- **WHEN** a repository profile extends `rio/base` and sets the qa step's `with.enabled: true`
- **THEN** the resolved profile runs QA in changed mode with the base budgets and the default QA policy

#### Scenario: Base makes no QA calls
- **WHEN** `rio/base` is reviewed
- **THEN** no container is started for QA and no QA model call is made

# Spec Delta

## MODIFIED Requirements

### Requirement: Built-in step options
The `with` schemas of the built-in steps SHALL define the review settings that this version supports. Each option SHALL be validated against the step's schema:
- `rio/prepare`: `exclude` (list of globs relative to the repository root, default `[]`);
- `rio/checks`: `typecheck`, `lint`, `secrets`, `coverage`, `dependencies`, `baseline` (booleans, default `true`), and `trust_installed_dependencies` (boolean, default `false`);
- `rio/graph`: `hops` (default 2) and `max_nodes` (default 2000);
- `rio/agents`: `cache` (boolean, default `true`) controlling the agent result cache;
- `rio/security`: `enabled` (default false in base), `posture`, `fail_on`, `max_defects`, and `catalog` with the security-step contract;
- `rio/report`: `class_threshold` (integer, default 3, consumed by review convergence) and `proposal_threshold` (integer of at least 1, default 3, the dismissal count that yields a suppression proposal);
- `rio/triage`: explicit risk thresholds for sensitive-path globs, public-contract changes, dependency changes, missing coverage and graph fan-out.

#### Scenario: Exclusion glob from the profile
- **WHEN** the `rio/prepare` step sets `with: { exclude: ["docs/generated/**"] }` and a change modifies `docs/generated/api.ts`
- **THEN** the file is excluded from checks and the graph, and the footer lists it with reason `profile_exclude`

#### Scenario: Agent cache disabled
- **WHEN** the `rio/agents` step sets `with: { cache: false }`
- **THEN** the profile validates, no agent cache lookup is made during the review, and the report records zero cache lookups

#### Scenario: Invalid proposal threshold
- **WHEN** the `rio/report` step sets `with: { proposal_threshold: 0 }`
- **THEN** validation fails at that option's location naming the minimum of 1

## ADDED Requirements

### Requirement: Publish policy
The top-level `publish` key SHALL accept exactly `never`, `ask` or `auto`, and `rio/base` SHALL set `never`. The meaning of each value is defined by the pr-publishing capability; validation SHALL reject any other value at the key's location.

#### Scenario: Unknown publish value
- **WHEN** a profile sets `publish: always`
- **THEN** validation fails at `publish` listing `never`, `ask` and `auto`

#### Scenario: Base default
- **WHEN** `rio/base` is resolved without an override
- **THEN** the resolved profile's `publish` is `never`

### Requirement: Security community profile
Rio SHALL ship a built-in profile named `rio/security` that extends `rio/base` and enables the security step with `posture: thorough` and `catalog: asvs-5.0`. It SHALL validate without an endpoint, and its resolution SHALL show the security step enabled.

#### Scenario: Community profile validates offline
- **WHEN** `rio profile validate rio/security` runs with no endpoint configured
- **THEN** validation passes and `rio profile show rio/security` shows the security step enabled with thorough posture and catalog `asvs-5.0`

### Requirement: Suppression entries written by the CLI
A `suppress` entry appended to a profile by `rio suppressions apply` SHALL be a valid entry of the existing forms, and the resulting profile SHALL validate. When the profile does not validate after the append, the file SHALL be restored to its previous content and the command SHALL fail naming the validation error.

#### Scenario: Applied entry validates
- **WHEN** `rio suppressions apply` appends `{ rule: "lint/eslint/no-console" }` to `.rio/profiles/default.yaml`
- **THEN** the profile validates and the next review counts findings matching that rule as suppressed

#### Scenario: Append breaks the profile
- **WHEN** the append would produce a profile that fails validation
- **THEN** the file is restored byte for byte and the command exits non-zero naming the error

## Purpose

The `rio profile` subcommands let users discover, inspect and validate review profiles from every location Rio reads them, before any review runs.

## ADDED Requirements

### Requirement: List profiles
`rio profile list` SHALL print every profile discoverable from the built-in set, the personal directory (`~/.config/rio/profiles/`) and the repository directory (`.rio/profiles/`), with its name, source (`built-in`, `personal`, `repo`), file path when applicable, and the profile it extends. The profile that `rio review` would use by default SHALL be marked.

#### Scenario: Repo profile shadows a personal profile
- **WHEN** both `.rio/profiles/default.yaml` and `~/.config/rio/profiles/default.yaml` exist
- **THEN** the list shows both entries, and only the repo one is marked as the default

#### Scenario: No custom profiles
- **WHEN** neither directory exists
- **THEN** the list shows the built-in profiles and marks `rio/base` as the default

### Requirement: Show a profile
`rio profile show <name-or-path>` SHALL print the fully resolved profile (inheritance applied, built-in module versions pinned) as YAML. With `--raw` it SHALL print the file as written. Both forms SHALL state the source file and the inheritance chain.

#### Scenario: Resolved view includes inherited steps
- **WHEN** `.rio/profiles/strict.yaml` extends `rio/base` and only overrides `fail_on`
- **THEN** `rio profile show strict` prints the `rio/base` steps and budgets together with the overridden `fail_on`, and names the chain `strict -> rio/base`

### Requirement: Validate a profile
`rio profile validate [<name-or-path>]` SHALL validate the named profile, or the default profile when no argument is given, against the schema and the semantic rules of the review-profiles capability. It SHALL exit 0 when valid and 2 when invalid, printing every error with the YAML path and file that caused it. Warnings (for example a step that cannot run locally) SHALL be printed but SHALL NOT change the exit code.

#### Scenario: Unknown module reference
- **WHEN** a profile step declares `uses: acme/agent-foo@1.0.0`
- **THEN** validation exits 2 and reports that third-party modules are not supported in this version, naming the step id

#### Scenario: Valid profile with local-only warning
- **WHEN** the default `rio/base` profile is validated with no endpoint configured
- **THEN** validation exits 0 and prints a warning that the agent and verifier steps will be deferred locally

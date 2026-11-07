# Spec Delta

## MODIFIED Requirements

### Requirement: Diagnostic report
`rio doctor` SHALL report: whether the current directory is inside a git work tree and the current `HEAD`; the languages detected and their project roots; for each adapter capability, the tool that would be used with its resolved path and version, or that it is missing together with an install hint; the validity of the default profile; and whether an endpoint is configured. When an endpoint is configured it SHALL also report the endpoint's version and whether it is paired with this CLI, whether the GitHub App secrets are configured on the endpoint, whether an installation covers the repository's `origin`, and the `publish` policy of the default profile. It SHALL also report review readiness by running the same planner that `rio review` uses, so that the two cannot disagree. Readiness covers: for each root, the effective environment (workspace root, governing lockfile, `node_modules` or virtual environment used) and the result of the dependency compatibility check, including whether `trust_installed_dependencies` would apply; whether the cache directory is writable and its free space; the effective machine configuration and the source of each value; and, for each scheduled root and check kind, whether the check would run or be skipped and why. It SHALL plan for working-tree mode by default and accept `--staged` and `--base <ref>` to plan for those modes. `--format json` SHALL emit the same information as one JSON document.

#### Scenario: Missing type checker
- **WHEN** `rio doctor` runs in a Python project where neither `pyright` nor `mypy` is installed
- **THEN** the report marks the Python `typecheck` capability as missing and prints an install hint for both tools

#### Scenario: Tools present but checks would be skipped
- **WHEN** `tsc` and `eslint` are installed but `node_modules/.package-lock.json` records a different `react` version than `package-lock.json`
- **THEN** the report shows the tools as found, and shows `typecheck`, `lint` and `coverage` for that root as "would skip: `dependency_mismatch`" with the hint naming `react`

#### Scenario: Unwritable cache
- **WHEN** the configured cache directory cannot be created or written
- **THEN** the report marks the cache as a blocking problem and names the directory

#### Scenario: Project-local tool preferred
- **WHEN** a TypeScript project has `node_modules/.bin/tsc` and a different `tsc` on `PATH`
- **THEN** the report shows the project-local path and version for `typecheck`

#### Scenario: Installation missing
- **WHEN** `rio doctor` runs with an endpoint whose GitHub App is configured but no installation covers the repository's `origin`
- **THEN** the report shows the app as configured, marks the installation as missing with a warning naming the repository and the install URL, and the exit code is unaffected

## ADDED Requirements

### Requirement: Webhook secret rotation
`rio doctor --rotate` SHALL generate a new webhook secret, update the endpoint's secret and the GitHub App's webhook configuration, and verify a ping delivery with the new secret. If any step fails the command SHALL leave the previous secret in effect on both sides, report the failing step, and exit 1.

#### Scenario: Successful rotation
- **WHEN** `rio doctor --rotate` runs with a configured app and reachable endpoint
- **THEN** the endpoint and the app share the new secret, a ping delivery verifies, and the command exits 0

#### Scenario: App update fails
- **WHEN** the GitHub App configuration update is rejected during `rio doctor --rotate`
- **THEN** the endpoint keeps the previous secret, the command names the app update as the failing step, and exits 1

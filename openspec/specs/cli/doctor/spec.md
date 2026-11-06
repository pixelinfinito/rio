# cli/doctor Specification

## Purpose

`rio doctor` diagnoses whether the local review pipeline can run in the current repository and tells the user exactly what is missing.

## Requirements

### Requirement: Diagnostic report
`rio doctor` SHALL report: whether the current directory is inside a git work tree and the current `HEAD`; the languages detected and their project roots; for each adapter capability, the tool that would be used with its resolved path and version, or that it is missing together with an install hint; the validity of the default profile; and that no endpoint is configured (informational in this version). It SHALL also report review readiness by running the same planner that `rio review` uses, so that the two cannot disagree. Readiness covers: for each root, the effective environment (workspace root, governing lockfile, `node_modules` or virtual environment used) and the result of the dependency compatibility check, including whether `trust_installed_dependencies` would apply; whether the cache directory is writable and its free space; the effective machine configuration and the source of each value; and, for each scheduled root and check kind, whether the check would run or be skipped and why. It SHALL plan for working-tree mode by default and accept `--staged` and `--base <ref>` to plan for those modes. `--format json` SHALL emit the same information as one JSON document.

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

### Requirement: Exit code reflects blocking problems
`rio doctor` SHALL exit 1 when a blocking problem exists (not a git repository, an invalid default profile, an invalid machine configuration, or an unwritable cache directory) and 0 otherwise. Missing tools and checks that would be skipped SHALL be reported as warnings and SHALL NOT affect the exit code.

#### Scenario: Only warnings
- **WHEN** the repository is valid, the profile is valid, and `eslint` is not installed
- **THEN** `rio doctor` exits 0 and shows `lint` as a warning

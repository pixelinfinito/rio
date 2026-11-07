# cli/review Specification

## Purpose

The `rio review` command is the terminal-first entry point of Rio: it reviews a set of local changes and renders a report on the developer's machine without any backend, endpoint or model provider.

## Requirements

### Requirement: Change selection modes
The command SHALL review exactly one change set per run, selected by mutually exclusive flags: no selection flag reviews working-tree changes (tracked modifications, staged changes and untracked files not ignored by git) against `HEAD`; `--staged` reviews the index against `HEAD`; `--base <ref>` reviews `HEAD` against the merge base of `<ref>` and `HEAD`. Supplying more than one selection flag SHALL be a usage error.

#### Scenario: Default reviews the working tree
- **WHEN** `rio review` is run with no selection flag in a repository with an unstaged edit, a staged edit and a new untracked file
- **THEN** all three files are part of the reviewed change set and the report header names the mode as `working-tree`

#### Scenario: Staged mode ignores unstaged edits
- **WHEN** `rio review --staged` is run with one staged file and a different file modified but unstaged
- **THEN** only the staged file is in the reviewed change set

#### Scenario: Branch mode uses the merge base
- **WHEN** `rio review --base origin/main` is run on a feature branch that is three commits ahead of `origin/main`, while `origin/main` has also advanced
- **THEN** the reviewed change set is the diff from the merge base of `origin/main` and `HEAD` to `HEAD`, and commits that only exist on `origin/main` are not reviewed

#### Scenario: Conflicting selection flags
- **WHEN** `rio review --staged --base main` is run
- **THEN** the command exits with code 2 and a message stating that selection flags are mutually exclusive, and no review runs

### Requirement: Endpoint-only flags fail explicitly
Flags that need a Rio endpoint (`--pr`, `--deep`, `--publish`, `--since-last`) SHALL be accepted by the parser and SHALL cause the command to exit with code 2 and a message that names the flag and states that it requires a configured endpoint, which v0.1 does not support. The command SHALL NOT run any part of the review in that case.

#### Scenario: PR flag without endpoint
- **WHEN** `rio review --pr 123` is run
- **THEN** the command exits with code 2 and prints a message naming `--pr` and stating that an endpoint is required and not available in this version

### Requirement: Output format selection
The command SHALL accept `--format terminal|json|md` and default to `terminal`. In `terminal` mode results SHALL stream to standard output as checks complete. In `json` and `md` modes the command SHALL write only the final document to standard output and SHALL send progress and diagnostics to standard error, so standard output is machine-consumable. The document SHALL be written in one piece after the run ends, so it is either complete or absent.

In `json` mode, once the arguments have been parsed, every exit SHALL write exactly one `rio-report-v1` document whose `status` is one of: `complete` (every check ended `passed` or `findings`); `incomplete` (the review finished, but at least one check ended `failed` or `cancelled`, or was `skipped` for a reason other than `disabled` or `nothing_to_audit`); `partial` (stopped by a first interrupt); `no_changes`; or `error` (exit 2 or 3, with an `error` object holding `code`, `message` and `details`, plus whatever results were obtained before the error). Exceptions are a second interrupt (exit 130), which writes no document, and argument errors detected before `--format` is known, which write plain text to standard error. In `md` mode, exits 2 and 3 write nothing to standard output.

#### Scenario: JSON output is clean
- **WHEN** `rio review --format json` is run and standard output is redirected to a file
- **THEN** the file contains exactly one JSON document that parses, and all progress lines went to standard error

#### Scenario: JSON for an empty change set
- **WHEN** `rio review --format json` runs with a clean working tree
- **THEN** standard output contains one `rio-report-v1` document with `status: "no_changes"` and empty `findings`, `risks` and `checks`, the "No changes to review" message goes to standard error, and the exit code is 0

#### Scenario: JSON for a configuration error
- **WHEN** `rio review --format json --profile broken.yaml` runs and the profile is invalid
- **THEN** standard output contains one `rio-report-v1` document with `status: "error"` and an `error` object listing every validation error with its YAML path, and the exit code is 2

#### Scenario: JSON when the review cannot start
- **WHEN** `rio review --format json` runs outside a git work tree
- **THEN** standard output contains one `rio-report-v1` document with `status: "error"` and `error.code: "not_a_repository"`, and the exit code is 3

#### Scenario: JSON after an interrupt
- **WHEN** `rio review --format json` receives one interrupt while the coverage check is running
- **THEN** standard output contains one document with `status: "partial"` holding every result obtained so far, and the coverage check has outcome `cancelled` with reason `interrupted`

#### Scenario: Terminal output honors NO_COLOR
- **WHEN** `rio review` is run with the `NO_COLOR` environment variable set, or with `--no-color`, or with standard output not attached to a terminal
- **THEN** the terminal report contains no ANSI escape sequences

### Requirement: Offline operation
The command SHALL accept `--offline`. When set, the Rio process SHALL open no network connection, and built-in checks that need the network SHALL be reported as skipped with reason `offline`. Tool processes Rio executes (type checkers, linters and their plugins, and the project's tests run for coverage) are not network-isolated in this version; the guarantee does not extend to them, and the report footer SHALL state this whenever such a process ran. Preventing all network activity requires running Rio under external network isolation, such as a container or sandbox without network access, or disabling every check that runs a subprocess (`typecheck`, `lint` and `coverage`). When no endpoint is configured, every step that would need one SHALL be reported as deferred rather than failing the run.

#### Scenario: Offline run skips the dependency audit
- **WHEN** `rio review --offline` is run on a change that modifies a lockfile
- **THEN** the report footer lists the dependency audit as skipped with reason `offline` and every other check runs normally

#### Scenario: Offline footer states the subprocess limit
- **WHEN** `rio review --offline` runs and at least one tool or test process executes
- **THEN** the footer states that tool and test processes were not network-isolated

#### Scenario: No endpoint configured is not an error
- **WHEN** `rio review` is run on a machine with no Rio endpoint configured
- **THEN** the deterministic checks, impact graph and report run to completion, and the footer lists the agent and verifier steps as deferred because no endpoint is configured

### Requirement: Machine configuration
Settings that describe the machine rather than the review SHALL be read from a user configuration file, from environment variables, and, for some settings, from command-line flags. They SHALL NOT be read from the repository, so a cloned repository cannot redirect Rio's cache or resource use. The configuration file is `config.toml` in the configuration directory: `$RIO_CONFIG_DIR`, else `$XDG_CONFIG_HOME/rio`, else `~/.config/rio` on Linux and macOS, and `%APPDATA%\rio` on Windows. Personal profiles live in its `profiles/` subdirectory. The keys are:

| Key | Environment variable | Default |
| --- | --- | --- |
| `endpoint.url` | `RIO_ENDPOINT_URL` | unset (only noticed in this version) |
| `cache.dir` | `RIO_CACHE_DIR` | `<repository root>/.rio/cache` |
| `cache.max_age` | `RIO_CACHE_MAX_AGE` | `30d` |
| `cache.max_size` | `RIO_CACHE_MAX_SIZE` | `5GiB` |
| `cache.retain_raw_output` | `RIO_CACHE_RETAIN_RAW_OUTPUT` | `true` |
| `run.parallelism` | `RIO_PARALLELISM` | number of physical cores, at most 4 |
| `run.output_limit` | `RIO_OUTPUT_LIMIT` | `256MiB` per tool output stream |

Precedence SHALL be command-line flag, then environment variable, then configuration file, then default. An unknown key or an invalid value SHALL be a configuration error (exit 2) naming the key and its source. Settings that describe the review (exclusion globs, check options, dependency trust, budgets, policies) belong to the profile, as defined by the review-profiles capability.

#### Scenario: Environment overrides the file
- **WHEN** `config.toml` sets `run.parallelism = 2` and `RIO_PARALLELISM=1` is set
- **THEN** at most one tool process runs at a time

#### Scenario: Unknown configuration key
- **WHEN** `config.toml` contains `cache.maxage = "7d"`
- **THEN** `rio review` exits 2 and names `cache.maxage` and the file

### Requirement: Profile selection
The command SHALL accept `--profile <name-or-path>` and otherwise resolve the default profile as defined by the review-profiles capability. The resolved profile SHALL be validated before any check runs; a validation failure SHALL exit with code 2 listing every error.

#### Scenario: Invalid profile stops the run before checks
- **WHEN** `rio review --profile .rio/profiles/broken.yaml` is run and the file declares a step whose `needs` forms a cycle
- **THEN** the command exits with code 2, prints the cycle, and no adapter tool is executed

### Requirement: Progress and interruption
While checks run in terminal mode, the command SHALL show a progress line naming the checks in flight. A first interrupt signal SHALL cancel in-flight checks by terminating their process trees as defined by the deterministic-checks capability, keep results already obtained, record each stopped or never-started check as `cancelled` with reason `interrupted`, render the report marked as partial, and exit using the normal exit-code rules. A second interrupt signal SHALL kill every remaining tool process group or job immediately and exit with code 130.

#### Scenario: Single interrupt keeps the partial report
- **WHEN** the user presses Ctrl-C once while the coverage check is still running and the type check has finished with two findings
- **THEN** the coverage check's process tree is terminated, the report shows the two type-check findings, the header marks the report as `partial`, the footer lists the coverage check as `cancelled` with reason `interrupted`, and the exit code is 4 unless a finding matched `fail_on`

### Requirement: Exit codes
The command SHALL exit with, in order of precedence: 2 on usage or configuration errors; 3 when the review could not start (for example outside a git repository, or with an unsupported repository state defined by the change-snapshot capability) or was aborted by an internal error; 130 on a second interrupt; 1 when at least one finding matched the profile's `fail_on` policy; 4 when the review is incomplete under `fail_on.incomplete` (see the review-profiles capability); and 0 otherwise. A result with zero findings and a complete review SHALL exit 0 and SHALL state explicitly that no findings were produced. A result with zero findings and an incomplete review SHALL state that no findings were produced and name the checks that did not complete. It SHALL NOT present the result as clean.

#### Scenario: Zero findings is a success
- **WHEN** `rio review` runs on a change where every check passes
- **THEN** the report states that no findings were produced and the exit code is 0

#### Scenario: Zero findings with a failed check is not a success
- **WHEN** `rio review` runs, the type check ends `failed` with reason `tool_crashed`, no other check produces a finding, and `fail_on` is not customized
- **THEN** the report states that no findings were produced but names the failed type check, and the exit code is 4

#### Scenario: Missing tool does not fail by default
- **WHEN** `eslint` is not installed, every other check passes, and `fail_on.required_checks` is not set
- **THEN** lint is listed as `skipped` with reason `tool_missing` and the exit code is 0

#### Scenario: Failing finding sets exit code
- **WHEN** the resolved profile's `fail_on` requires evidence `static_proven` on new defects and the type check reports a new error in the change
- **THEN** the exit code is 1 and the report marks that finding as failing the policy

#### Scenario: Not a git repository
- **WHEN** `rio review` is run in a directory that is not inside a git work tree
- **THEN** the command exits with code 3 and prints a message saying a git repository is required

### Requirement: Empty change set
When the selected mode yields no changed files, the command SHALL report that there is nothing to review and exit with code 0 without running any check. In `terminal` and `md` modes the message goes to standard output. In `json` mode it goes to standard error, and standard output carries the `no_changes` document.

#### Scenario: Clean working tree
- **WHEN** `rio review` is run with a clean working tree
- **THEN** the command prints "No changes to review" (or equivalent) and exits 0 without invoking any adapter tool

### Requirement: Run identity and reproducibility
Every run SHALL be identified by a review id derived deterministically from the snapshot key and the resolved profile hash, which names the inputs. It SHALL also have a run id that is unique to each execution attempt. The report header SHALL print the review id, the run id, the base and head identifiers, and the profile name. The run SHALL persist its inputs and outputs under the review cache as defined by the review-report capability.

#### Scenario: Identical inputs give identical ids
- **WHEN** `rio review --staged` is run twice without changing the index or the profile
- **THEN** both runs print the same review id and different run ids

#### Scenario: Concurrent identical reviews
- **WHEN** `rio review --staged` is started in two terminals at the same time on the same index and profile
- **THEN** both runs complete, each writes its own run directory, neither run's report or evidence is overwritten by the other, and shared cache entries are built once and reused

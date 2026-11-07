# Spec Delta

## MODIFIED Requirements

### Requirement: Endpoint-only flags fail explicitly
Flags that need a Rio endpoint (`--pr`, `--deep`, `--publish`, `--since-last`) SHALL be accepted by the parser and, when no endpoint is configured, SHALL cause the command to exit with code 2 and a message that names the flag and states that it requires a configured endpoint. With an endpoint configured, `--pr` SHALL additionally exit with code 2 when the endpoint has no GitHub App installation covering the repository's `origin`, naming `rio init` and its GitHub App step. The command SHALL NOT run any part of the review in either case.

#### Scenario: PR flag without endpoint
- **WHEN** `rio review --pr 123` is run with no endpoint configured
- **THEN** the command exits with code 2 and prints a message naming `--pr` and stating that a configured endpoint is required

#### Scenario: PR flag without installation
- **WHEN** `rio review --pr 123` is run against an endpoint that has no installation covering the repository's `origin`
- **THEN** the command exits with code 2, names `rio init` and the GitHub App step, and no review runs

#### Scenario: PR flag with installation
- **WHEN** `rio review --pr 123` is run against an endpoint whose installation covers the repository
- **THEN** the review runs through the endpoint and no exit-2 message is printed

### Requirement: Output format selection
The command SHALL accept `--format terminal|json|md|sarif` and default to `terminal`. In `terminal` mode results SHALL stream to standard output as checks complete. In `json`, `md` and `sarif` modes the command SHALL write only the final document to standard output and SHALL send progress and diagnostics to standard error, so standard output is machine-consumable. The document SHALL be written in one piece after the run ends, so it is either complete or absent.

In `json` mode, once the arguments have been parsed, every exit SHALL write exactly one `rio-report-v1` document whose `status` is one of: `complete` (every check ended `passed` or `findings`); `incomplete` (the review finished, but at least one check ended `failed` or `cancelled`, or was `skipped` for a reason other than `disabled` or `nothing_to_audit`); `partial` (stopped by a first interrupt); `no_changes`; or `error` (exit 2 or 3, with an `error` object holding `code`, `message` and `details`, plus whatever results were obtained before the error). Exceptions are a second interrupt (exit 130), which writes no document, and argument errors detected before `--format` is known, which write plain text to standard error. In `md` mode, exits 2 and 3 write nothing to standard output.

In `sarif` mode, once the arguments have been parsed, every exit except a second interrupt SHALL write exactly one SARIF 2.1.0 log as defined by the sarif-output capability. On exits 2 and 3 the log SHALL contain no results and one invocation whose `executionSuccessful` is false and whose notifications carry the error code and message.

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

#### Scenario: SARIF output is clean
- **WHEN** `rio review --format sarif` is run and standard output is redirected to a file
- **THEN** the file contains exactly one SARIF 2.1.0 log that parses, and all progress lines went to standard error

#### Scenario: SARIF for a configuration error
- **WHEN** `rio review --format sarif --profile broken.yaml` runs and the profile is invalid
- **THEN** standard output contains one SARIF log with no results and one invocation whose `executionSuccessful` is false and whose notification names the configuration error, and the exit code is 2

### Requirement: Exit codes
The command SHALL exit with, in order of precedence: 2 on usage or configuration errors; 3 when the review could not start (for example outside a git repository, or with an unsupported repository state defined by the change-snapshot capability) or was aborted by an internal error; 130 on a second interrupt; 1 when at least one finding matched the profile's `fail_on` policy; 4 when the review is incomplete under `fail_on.incomplete` (see the review-profiles capability); 5 when publication was requested and failed after the review completed, with the report still written; and 0 otherwise. A result with zero findings and a complete review SHALL exit 0 and SHALL state explicitly that no findings were produced. A result with zero findings and an incomplete review SHALL state that no findings were produced and name the checks that did not complete. It SHALL NOT present the result as clean.

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

#### Scenario: Publication failure after a clean review
- **WHEN** `rio review --pr 123 --publish` completes with no policy match and the endpoint reports that publication failed
- **THEN** the report is written with its `publication` record showing the failure and the exit code is 5

## ADDED Requirements

### Requirement: Pull request review
`rio review --pr <n>` SHALL review the pull request's head commit through the endpoint as a review in the `pr` lineage for that number, prepared by the endpoint. Nothing SHALL be built from the local checkout and the local working tree SHALL NOT affect the result. Combining `--pr` with `--staged`, `--base` or `--since-last` SHALL be a usage error with exit code 2.

#### Scenario: Local tree ignored
- **WHEN** `rio review --pr 123` runs in a checkout with uncommitted edits unrelated to the pull request
- **THEN** the report covers only the pull request's base-to-head change and the local edits do not appear

#### Scenario: Conflicting selection
- **WHEN** `rio review --pr 123 --base main` is run
- **THEN** the command exits with code 2 stating that `--pr` cannot be combined with selection flags

### Requirement: Publication consent
`--publish` SHALL be the user's consent to publish under `publish: ask`. Under `publish: never` the flag SHALL have no effect and the command SHALL print a message stating that the profile forbids publication. Under `publish: auto` publication SHALL occur with or without the flag.

#### Scenario: Consent under ask
- **WHEN** `rio review --pr 123 --publish` runs with a profile whose `publish` is `ask`
- **THEN** the review is published without an interactive prompt

#### Scenario: Flag under never
- **WHEN** `rio review --pr 123 --publish` runs with a profile whose `publish` is `never`
- **THEN** nothing is published and the command prints that the profile forbids publication

#### Scenario: Prompt under ask without the flag
- **WHEN** `rio review --pr 123` runs interactively with `publish: ask` and the user declines the prompt
- **THEN** the report is rendered and nothing is published

### Requirement: Remembered findings override
`--show-remembered` SHALL render, in a separate section, the findings that the finding-history capability removed from the main sections as remembered dismissals, each with the reason and the review or pull request that dismissed it. Without the flag the footer SHALL only count them.

#### Scenario: Show remembered
- **WHEN** `rio review --show-remembered` runs on a change whose code carries a finding dismissed `intentional` in an earlier pull request
- **THEN** the finding appears under a remembered section with reason `intentional` and the dismissing pull request, and it is absent from the main findings section

# Diagnose readiness

Run in the project with its dependencies installed. Doctor probes tools and checks cache readiness; with an endpoint it also checks protocol/GitHub setup. --rotate changes the GitHub App webhook secret.

## commands
`rio doctor --format json` explains effective settings and their sources, repository/HEAD, profile validity, cache/free space, tools, dependency compatibility, and the same review plan used by review. `--staged` or `--base REF` selects the comparison. `--all-roots` inspects every detected project, including roots outside the diff; clean diffs otherwise schedule no root probes.

## recovery
Missing tool: install the project's pinned dependency/toolchain, then rerun. `dependency_mismatch`: synchronize installed dependencies to the selected lockfile. `trust_installed_dependencies: true` in rio/checks permits unknown compatibility, never a known mismatch. Baseline-unavailable findings outside changed hunks plus three lines of context are treated as pre-existing.
Cache error: check path/permissions/free space in effective settings. Invalid profile: `rio profile validate`. GitHub warning: install the app on the origin repository and check endpoint credentials. `rio doctor --rotate` rotates the webhook secret with rollback handling; use only when rotation is intended.

## exits
0 means no blocking configuration/profile/repository/cache problem; missing tools and skipped checks are warnings. 1 means a blocking readiness problem. These codes differ from review's finding/incomplete codes. Malformed arguments exit 2. Diagnostics must not be interpreted as a complete review.

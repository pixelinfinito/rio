## Purpose

Deterministic checks are the first layer of a review: everything a tool can prove about the change (types, lint rules, secrets, untested lines, vulnerable dependencies) is established without any model, and old issues are separated from regressions by comparing both versions.

## ADDED Requirements

### Requirement: Check kinds and rule ids
The checks step SHALL run, per detected language and scheduled project root, the following kinds with stable rule id prefixes: `typecheck/<tool>/<code>`, `lint/<tool>/<rule>`, `secret/<pattern>`, `coverage/untested_change`, `dependency/vulnerable_dependency`. Each kind SHALL be individually enabled or disabled through the `rio/checks` step's `with` options, and every finding SHALL carry evidence level `static_proven`.

#### Scenario: Kind disabled in profile
- **WHEN** the `rio/checks` step sets `with: { coverage: false }`
- **THEN** no test or coverage tool runs and the footer lists coverage as `skipped` with reason `disabled`

### Requirement: Check outcomes
Every scheduled check run (one kind, one project root, one version) SHALL end in exactly one outcome, recorded in the report with its reason and hint:
- `passed`: the tool ran to completion and reported no diagnostics;
- `findings`: the tool ran to completion and produced at least one finding;
- `failed`: the check was attempted but did not produce a complete, trustworthy result. Reasons: `spawn_failed` (the process could not start), `tool_crashed` (terminated by a signal, or an exit code the adapter does not declare as a normal result), `tool_config_error` (the tool reported invalid configuration, for example an `eslint` exit code 2 or a `pyright` exit code 3), `unparseable_output`, `output_limit`, `disk_full`, `tests_failed` (coverage only), `network_error` (dependency audit only), `partial_data` (dependency audit only);
- `skipped`: the check was not attempted. Reasons: `tool_missing`, `no_project_config`, `not_supported_by_adapter`, `disabled`, `offline`, `dependency_mismatch`, `no_tests`, `nothing_to_audit`;
- `cancelled`: the check was started and stopped by Rio. Reasons: `timeout`, `interrupted`.

Each adapter SHALL declare, per tool, which exit codes mean "completed without diagnostics" and which mean "completed with diagnostics". Any other exit code SHALL be `failed`. An exit code that means "completed with diagnostics" with zero parsed findings SHALL be `failed` with reason `unparseable_output`, never `passed`. Results already obtained by a `failed` or `cancelled` check (for example coverage data written before some tests failed) SHALL be kept when usable and marked as coming from an incomplete run. Outcomes are recorded per root, so a failure in one root never discards another root's results. How outcomes affect the exit code is defined by the review CLI and the profile's `fail_on` policy.

#### Scenario: Type checker crashes
- **WHEN** `tsc` exits after printing a stack trace and no diagnostics
- **THEN** the `typecheck` outcome for that root is `failed` with reason `tool_crashed`, the raw output is kept in the review cache, and the review does not report that the root passed

#### Scenario: Tool cannot start
- **WHEN** the resolved `ruff` path exists but is not executable
- **THEN** the `lint` outcome is `failed` with reason `spawn_failed` and a hint naming the path

#### Scenario: Linter configuration error
- **WHEN** `eslint` exits with code 2 because the project configuration cannot be loaded
- **THEN** the `lint` outcome is `failed` with reason `tool_config_error`, and no `lint/eslint/*` finding is produced from that run

#### Scenario: Failing tests keep usable coverage
- **WHEN** the coverage run completes and writes coverage data, but `pytest` exits 1 because two tests fail
- **THEN** the coverage outcome is `failed` with reason `tests_failed` and the failing-test count, and the `untested_change` findings computed from the coverage data are kept and marked as computed from a run with failing tests

#### Scenario: No tests collected
- **WHEN** `pytest` exits 5 because the project has no tests
- **THEN** the coverage outcome is `skipped` with reason `no_tests`

#### Scenario: Cargo test failures keep usable coverage
- **WHEN** `cargo llvm-cov` writes `lcov.info` and exits 101 because one test fails
- **THEN** the coverage outcome is `failed` with reason `tests_failed` and the failing-test count, and the `untested_change` findings computed from the LCOV data are kept and marked as computed from a run with failing tests

#### Scenario: One root fails, another succeeds
- **WHEN** the type check fails with `tool_crashed` in `packages/api` and passes in `packages/web`
- **THEN** the report records `failed` for `packages/api` and `passed` for `packages/web`, and the `packages/web` result is used

### Requirement: Baseline classification
For `typecheck` and `lint`, the checks step SHALL run the tool on the materialized head tree and, when `baseline` is enabled (default), on the materialized base tree. It SHALL classify individual occurrences before grouping them by root cause (see the findings capability). A head occurrence is `pre-existing` when it matches a base occurrence with the same identity whose line maps to it through the diff (unchanged lines map one to one; lines inside hunks do not map). Remaining head and base occurrences with the same identity are then matched one to one in line order. Unmatched head occurrences are `new`, and unmatched base occurrences are `fixed`. Base results SHALL be cached under a key that covers every input that can change them: base identifier, project root, check kind, tool and tool version, the tool's configuration files, the exact invocation including the set of target files, and the dependency state (the hash of the effective dependency graph defined under head dependency compatibility, plus the content hash of every in-repository linked package's source).

The base run uses the same installed dependencies as the head run. It SHALL therefore be used for classification only when that installation is also valid for the base: the installed dependency graph is compatible with the base's lockfile under the same rules as for the head, and every installed dependency that resolves into the repository (workspace links, editable installs) points at source that is identical in the base and the work tree. When either condition fails or cannot be established, or when the head run used trusted dependencies, that root's `typecheck` and `lint` findings SHALL be classified `unclassified`. The footer SHALL then record `baseline_failed` with a hint that names the dependency or linked package that differs, or `dependencies_trusted`. When the base run ends in `failed` or `cancelled`, findings SHALL be classified `unclassified` and the footer SHALL say why.

#### Scenario: Error caused in an unchanged file
- **WHEN** a change alters a function signature and `tsc` reports a new error in an unchanged caller file
- **THEN** that finding is classified `new`, because it is absent from the base run

#### Scenario: Pre-existing error not shown as a regression
- **WHEN** `tsc` reports the same error in both base and head
- **THEN** the finding is classified `pre-existing`, is not listed among new findings, and is counted in the report's pre-existing summary

#### Scenario: Additional occurrence of an existing error
- **WHEN** a function already contains one `TS2532` error on an unchanged line and the change adds a second, identical `TS2532` error on an added line in the same function
- **THEN** the unchanged-line occurrence is `pre-existing`, the added-line occurrence is `new`, and the grouped finding is reported as `worsened` in the main findings section

#### Scenario: Base run reused from cache
- **WHEN** two consecutive reviews share the same base commit, project root, tool configuration, invocation and dependency state
- **THEN** the second review does not re-run the base type check and the footer reports the baseline as cached

#### Scenario: Lint baseline not reused across different file sets
- **WHEN** one review lints changed file `a.ts` and a later review on the same base lints changed file `b.ts`
- **THEN** the second review does not reuse the first review's lint baseline, and pre-existing lint errors in `b.ts` are classified `pre-existing`, not `new`

#### Scenario: Dependency change disables classification
- **WHEN** a change upgrades a package in the lockfile and the type check reports an error in an unchanged file
- **THEN** that root's type-check findings are classified `unclassified`, not `pre-existing`, and the footer records `baseline_failed` with a hint that dependencies changed

#### Scenario: Workspace source change disables classification
- **WHEN** a change edits `packages/ui/src/button.ts`, which another root imports through the workspace link `node_modules/@acme/ui`, without touching any manifest or lockfile, and the type check reports an error in an unchanged caller
- **THEN** the importing root's type-check findings are classified `unclassified`, not `pre-existing`, and the footer records `baseline_failed` with a hint naming `packages/ui`

### Requirement: Head dependency compatibility
Tool-executing checks (`typecheck`, `lint`, `coverage`) use the dependencies installed in the work tree. Before running them on a project root, the checks step SHALL verify that the installation is compatible with the selected head. The lockfile used is the one that governs the root: the root's own, or that of the workspace root it belongs to. The check SHALL read the installation metadata that the package manager wrote at install time. It SHALL NOT assume the installation was made from the work tree's current manifests.

Compatibility is defined against the effective dependency graph, not against the whole lockfile. The effective graph is the subset of the head lockfile that applies to the root's workspace member, the current platform (OS, CPU, libc and environment markers), and the groups and extras that are installed. It preserves each package's install location and its resolved dependency edges. The installation is compatible when:
- every installed package that the effective graph covers sits at the location and version the graph resolves it to; for npm and yarn `node_modules` layouts the location is the path under `node_modules`; for pnpm it is the importer's dependency map and the package snapshot; for Python, where one environment holds one version per distribution, it is the distribution name;
- every package the effective graph marks as required (not optional, not dev-only when dev dependencies were omitted, not belonging only to an uninstalled group or extra, and applicable to the current platform) is installed;
- no installed package occupies a location the effective graph resolves differently, so identical name and version sets in different layouts are not treated as equal;
- every installed dependency that resolves into the repository (workspace links, editable installs) points at source identical in the work tree and the selected head.

Packages that the lockfile lists but that are legitimately absent (optional dependencies skipped for the platform, `npm ci --omit=dev`, `uv sync --no-dev`, unselected extras) SHALL NOT cause a mismatch. When compatibility fails, those checks SHALL be skipped for that root with reason `dependency_mismatch` and a hint naming the differing file, package or location.

Rust has no installed tree, so for a Rust root compatibility SHALL be defined as: the governing `Cargo.lock` is present and parseable, and the toolchain named in `rust-toolchain.toml` or `rust-toolchain` (or the default toolchain when neither exists) is installed. A Rust root without a `Cargo.lock`, or whose toolchain is not installed, is `unverified`. Changes to affected members' resolved dependency closures allow head checks and disable only baseline classification, with `baseline_failed` naming the changed crate. Unrelated members' dependency changes do not disable classification.

When the installed state cannot be established (no lockfile, no exact pins, missing or unsupported installation metadata such as yarn Plug'n'Play, a Rust root without `Cargo.lock` or with an uninstalled toolchain), the checks SHALL be skipped with reason `dependency_mismatch` and a hint that names why. The exception is when the `rio/checks` option `trust_installed_dependencies` is `true` (default `false`). Then the checks run, their outcomes carry `dependency_state: trusted`, baseline classification for the root is disabled as defined above, and the footer states that results were computed against unverified dependencies. Trust never overrides a mismatch that was established: a stale or conflicting installation is always skipped.

#### Scenario: Unstaged dependency upgrade during a staged review
- **WHEN** `rio review --staged` runs while `package.json` and `package-lock.json` have an unstaged upgrade that is installed in `node_modules`
- **THEN** the root's type check, lint and coverage are skipped with reason `dependency_mismatch` and the hint names `package-lock.json`

#### Scenario: Workspace link to locally modified source
- **WHEN** `rio review --base main` runs and `node_modules/@acme/ui` links to `packages/ui`, which has uncommitted edits
- **THEN** checks for roots that depend on `@acme/ui` are skipped with reason `dependency_mismatch` and the hint names `packages/ui`

#### Scenario: Stale installation after a branch switch
- **WHEN** the user switches to a branch whose `package-lock.json` pins `react@18.3.1` without reinstalling, `node_modules/.package-lock.json` still records `react@18.2.0`, and `rio review` runs in working-tree mode
- **THEN** the root's type check, lint and coverage are skipped with reason `dependency_mismatch` and the hint names `react` and suggests reinstalling

#### Scenario: Valid installation without dev dependencies
- **WHEN** a Python root was installed with `uv sync --no-dev` and `uv.lock` lists a `dev` group whose packages are absent from `.venv`
- **THEN** the installation is compatible and the checks run

#### Scenario: Valid installation without a platform-specific optional package
- **WHEN** `package-lock.json` lists an optional package restricted to `win32` and the review runs on Linux without it installed
- **THEN** the installation is compatible and the checks run

#### Scenario: Same versions, different layout
- **WHEN** the lockfile resolves `lodash@4.17.21` at `node_modules/lodash` and `lodash@3.10.1` at `node_modules/legacy/node_modules/lodash`, and the installation has the same two versions with the locations swapped
- **THEN** the installation is not compatible, and checks are skipped with `dependency_mismatch` and a hint naming `node_modules/lodash`

#### Scenario: Installed state cannot be verified
- **WHEN** a Python root has only a `requirements.txt` without exact pins and `trust_installed_dependencies` is not set
- **THEN** the root's type check, lint and coverage are skipped with reason `dependency_mismatch` and the hint says the installed dependencies cannot be verified and names the `trust_installed_dependencies` option

#### Scenario: Trusted unverifiable installation
- **WHEN** the same root is reviewed with `rio/checks` `with: { trust_installed_dependencies: true }`
- **THEN** the checks run, their outcomes carry `dependency_state: trusted`, the root's `typecheck` and `lint` findings are `unclassified`, and the footer states that results used unverified dependencies

#### Scenario: Rust lockfile changed for an affected member
- **WHEN** a change bumps a dependency of `crates/core` in `Cargo.lock` and `cargo check` reports a new error in an unchanged file of `crates/core`
- **THEN** that member's `typecheck` findings are classified `unclassified` and the footer records `baseline_failed` with a hint naming the crate whose resolved version changed

#### Scenario: Rust toolchain not installed
- **WHEN** `rust-toolchain.toml` names a channel that `rustup` has not installed and `trust_installed_dependencies` is not set
- **THEN** the Rust root's `typecheck`, `lint` and `coverage` are skipped with reason `dependency_mismatch` and the hint names the channel and `rustup toolchain install`

#### Scenario: Trust does not override a known mismatch
- **WHEN** `trust_installed_dependencies` is `true` and the installation records `react@18.2.0` while the head lockfile resolves `react@18.3.1`
- **THEN** the checks are still skipped with reason `dependency_mismatch`

### Requirement: Secrets scan
The secrets scan SHALL run over the head content of every changed text file using a built-in catalog of credential patterns (provider token formats, private key blocks, connection strings with embedded passwords) plus a high-entropy heuristic for values assigned to secret-like names. A match on an added or modified line SHALL be classified `new`; a match elsewhere in a changed file SHALL be `pre-existing`. The report SHALL NEVER print the matched value beyond its first four characters.

#### Scenario: Added API key
- **WHEN** an added line contains a value matching the AWS access key pattern
- **THEN** a `secret/aws-access-key` finding is produced, classified `new`, showing the value redacted after four characters

#### Scenario: Test fixture false positive is suppressible
- **WHEN** a profile has `suppress: [ { path: "tests/fixtures/**" } ]`
- **THEN** secret findings under that path are suppressed and counted in the footer

### Requirement: Diff coverage
When `coverage` is enabled and a test runner with coverage is resolved, the checks step SHALL run the tests of every scheduled root with coverage. It SHALL merge the coverage data of all runs by repository-relative path, counting a line as executed when any run executed it. It SHALL then intersect the merged data with the added and modified line ranges of non-test source files. Test files themselves SHALL be excluded. Test execution SHALL be bounded by the profile budget and terminated on timeout, producing the outcome `cancelled` with reason `timeout`.

Only executable lines are eligible. When a file is present in the coverage data, the executable lines are those the coverage tool reports as instrumented (LCOV `DA` records; coverage.py `executed_lines` plus `missing_lines`). Changed lines that are not instrumented (comments, blank lines, type-only declarations) SHALL be ignored, and so SHALL lines the tool reports as excluded (coverage.py `excluded_lines`, Istanbul ignore hints).

When a changed file is absent from the coverage data, the system SHALL distinguish three cases:
- the file has no executable statements by parse (only type aliases, interfaces, `declare` statements, type-only imports and exports, comments, or a `.d.ts` or `.pyi` file): no finding;
- the file is excluded by the project's coverage configuration, as far as the adapter can read it statically (coverage.py `omit` and `source`, static `include` and `exclude` values in Jest or Vitest configuration): no finding, and the file is listed in the footer as `coverage_excluded`;
- otherwise: a `coverage/untested_change` finding covering the file's changed executable lines, as determined by parse, is produced only when the adapter ran the tool in a mode that reports files never loaded by any test. When it did not, or when the configuration cannot be evaluated statically, the file is listed in the footer as `coverage_not_instrumented` instead of being reported as untested.

For each enclosing function (or per file when no enclosing symbol exists) with eligible unexecuted lines, the check SHALL produce one `coverage/untested_change` finding listing the untested line ranges, with category `risk`.

#### Scenario: Partially tested function
- **WHEN** a function has added lines 10 to 20, all executable, and coverage shows lines 10 to 14 executed
- **THEN** one `untested_change` finding for that function lists lines 15 to 20

#### Scenario: Type-only file
- **WHEN** a change adds `src/types.ts` containing only interfaces and type aliases, and the file is absent from the coverage data
- **THEN** no `untested_change` finding is produced for it

#### Scenario: Comment-only edit
- **WHEN** a change edits only comment lines inside a tested function
- **THEN** no `untested_change` finding is produced, because none of the changed lines is executable

#### Scenario: File excluded by coverage configuration
- **WHEN** `pyproject.toml` sets `[tool.coverage.run] omit = ["scripts/*"]` and a change modifies `scripts/release.py`
- **THEN** no `untested_change` finding is produced and the footer lists `scripts/release.py` as `coverage_excluded`

#### Scenario: Absence that cannot be attributed
- **WHEN** a changed TypeScript file with executable code is absent from the LCOV data, and the runner's coverage configuration is computed in a JavaScript config file that Rio cannot evaluate
- **THEN** the footer lists the file as `coverage_not_instrumented` and no `untested_change` finding is produced for it

#### Scenario: Shared package covered by a consumer's tests
- **WHEN** `packages/shared/src/util.ts` changes and is executed only by tests in `packages/api`
- **THEN** the merged coverage marks the executed lines as tested, and no `untested_change` finding is produced for them

#### Scenario: Tests exceed budget
- **WHEN** the test command runs longer than the budget allows
- **THEN** its process tree is terminated, the coverage outcome is `cancelled` with reason `timeout`, and other checks' results are unaffected

### Requirement: Dependency audit
The dependency audit SHALL parse the manifests and lockfiles of both versions (npm `package-lock.json` v2 and v3, `pnpm-lock.yaml`, `yarn.lock`; Python `uv.lock`, `poetry.lock`, `Pipfile.lock`, and `requirements*.txt` with exact pins; Rust `Cargo.lock` v3 and v4, with `crates.io` as the OSV ecosystem for registry packages). Git and path dependencies in `Cargo.lock` cannot be audited and SHALL be listed in the footer as unauditable; optional dependencies pulled in through `[features]` SHALL carry the `optional` flag in the dependency graph. It SHALL compute added, upgraded and downgraded packages, and query OSV for the head versions of the changed packages only. Retrieval SHALL be complete. The audit follows every `next_page_token` returned by the batch query. It fetches the full record of each returned advisory id with `GET /v1/vulns/{id}`, because the batch endpoint returns only ids and modification times. It caches advisory records under the cache's `osv/` directory, keyed by id and reused while the batch response reports the same `modified` time.

Advisories for the same package version whose ids or `aliases` intersect SHALL be merged into one finding. That finding's advisory id is the lexicographically smallest OSV id in the group, and the other ids are listed as aliases. The audit SHALL produce one `dependency/vulnerable_dependency` finding per package, version and merged advisory. Each finding carries the advisory id, aliases, the advisory severity (`critical`, `high`, `moderate` or `low` from the record's severity data, otherwise `unknown`), and the first fixed version for the installed version's range when the record lists one, otherwise `unknown`.

When some detail requests fail after retries, the audit SHALL still emit findings for the affected ids with severity and fixed version `unknown`, and its outcome SHALL be `failed` with reason `partial_data`. When the batch query itself fails, the outcome SHALL be `failed` with reason `network_error`. With `--offline`, the outcome SHALL be `skipped` with reason `offline`. The audit SHALL never be silently empty.

#### Scenario: Upgraded package with an advisory
- **WHEN** a lockfile upgrades a package to a version with a known OSV advisory
- **THEN** a finding names the package, the new version, the advisory id, its severity and the first fixed version, all taken from the advisory's full record

#### Scenario: Paginated batch result
- **WHEN** the batch response for one package carries a `next_page_token`
- **THEN** the audit requests the next page for that query and includes its advisories

#### Scenario: Aliased advisories merged
- **WHEN** OSV returns `GHSA-xxxx` and `PYSEC-yyyy` for the same package version, and each lists the other in `aliases`
- **THEN** one finding is produced with advisory id `GHSA-xxxx` and alias `PYSEC-yyyy`

#### Scenario: Detail retrieval fails
- **WHEN** the batch query succeeds but fetching one advisory's record fails after retries
- **THEN** a finding for that advisory id is still produced with severity `unknown` and fixed version `unknown`, and the audit outcome is `failed` with reason `partial_data`

#### Scenario: Cargo registry package with an advisory
- **WHEN** `Cargo.lock` upgrades a `registry+https://github.com/rust-lang/crates.io-index` package to a version with an OSV advisory in the `crates.io` ecosystem
- **THEN** a `dependency/vulnerable_dependency` finding names the crate, the version, the advisory id, its severity and the first fixed version

#### Scenario: Git dependency is unauditable
- **WHEN** `Cargo.lock` adds a package whose `source` starts with `git+`
- **THEN** no OSV query is made for it and the footer lists it as unauditable with reason `git_source`

#### Scenario: Unchanged dependencies not queried
- **WHEN** the change does not modify any manifest or lockfile
- **THEN** the dependency audit outcome is `skipped` with reason `nothing_to_audit` and no network request is made

### Requirement: Incomplete checks are always visible
Any check whose outcome is `failed`, `skipped` or `cancelled` SHALL appear in the report footer with the check kind, language, project root, version (head or base), outcome, reason and a hint when one applies. A capability that an adapter declares for a scheduled root SHALL always have a recorded outcome.

#### Scenario: Nothing skipped silently
- **WHEN** a review finishes and some capability was declared by an adapter for a scheduled root but produced no result
- **THEN** the footer contains an entry for it with its outcome and reason

### Requirement: Checks run concurrently and stream
Independent checks SHALL run concurrently up to the configured parallelism and SHALL report results to the renderer as each completes, in completion order. Each check SHALL have a timeout derived from the profile budget.

#### Scenario: Fast check appears before slow check
- **WHEN** the secrets scan finishes before the type check
- **THEN** the terminal shows the secrets results while the type check is still running

### Requirement: Tool process lifecycle
Every tool and test process SHALL be started so that Rio can terminate it together with all its descendants. On Unix, the process starts in a new process group. On Windows, it starts in a Job Object that kills its processes when closed, and it is assigned to the job before it runs any code. When a check is cancelled (timeout or interrupt), the system SHALL signal the whole group or job. On Unix this means `SIGTERM`, then `SIGKILL` to the group after a grace period of 5 seconds. On Windows the job is terminated. The system SHALL then wait until the direct child has exited and no member of the group or job remains, bounded by a further 5 seconds. Only after that SHALL it remove the check's disposable tree. A descendant that leaves the group on purpose (for example by calling `setsid`) cannot be guaranteed to be terminated in this version. When the system detects such a process, it SHALL name it in the footer.

#### Scenario: Test runner with a long-lived child
- **WHEN** a fake test tool starts a child process that sleeps for an hour and writes its pid to a file, and the coverage check times out
- **THEN** after the check ends neither the tool nor its child is running, and the check's disposable tree has been removed

#### Scenario: Interrupt terminates worker processes
- **WHEN** the user interrupts a review while `vitest` is running with worker processes
- **THEN** the `vitest` process and all of its workers are terminated before the partial report is rendered

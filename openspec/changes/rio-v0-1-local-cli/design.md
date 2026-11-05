## Context

Greenfield: the repository contains the PRD, the TRD and an empty OpenSpec root. No code, no CI, no fixtures. See proposal.md for scope and motivation; the eleven delta specs under `specs/` define the behavior. This document fixes the technical shape of v0.1 so that v0.2 (endpoint, agents, verifier) extends it without rewriting it.

Constraints that shape the design:

- The TRD prescribes a Cargo workspace with named crates and says the Rust code is later shared with the self-hosted runner. Crate boundaries chosen now are therefore load-bearing.
- Profile schema v1, module manifest v1 and finding v1 become public contracts the moment they ship; v0.2 must only add to them.
- Everything runs on the developer's machine using tools the project already has. Rio never installs tools and never bundles a toolchain.
- "Old issues separated from regressions" requires running checks on the base version, which requires a materialized base tree with the project's dependencies available.
- The engine's event stream must map one-to-one onto the Server-Sent Events the TRD defines for v0.2, so the terminal renderer written now is reused unchanged against a remote review.

## Goals / Non-Goals

**Goals:**

- A `rio review` that completes in the fast budget on a 300-line TypeScript diff in a mid-size repo, with no network opened by Rio except OSV.
- Crate APIs that the runner (v0.2) can call directly: diff, snapshot, adapter execution, graph.
- Deterministic, reproducible runs: same inputs, same review id, same report; each execution attempt has its own run id and record.
- Every degradation visible in the footer, and no incomplete analysis presented as a clean result (exit code 4).

**Non-Goals:**

- Any model call, endpoint, runner protocol, PR integration or publishing.
- Triage rule evaluation, hypothesis board, consolidation across runs, SARIF.
- Windows as a first-class target in v0.1 (best effort; symlink-based baseline may degrade to `baseline_failed` there).
- LSP-backed reference resolution.

## Decisions

### D1. Workspace layout mirrors the TRD, with two placeholder crates

```text
crates/
  rio-cli/        clap commands, renderers' wiring, config, keyring (unused in v0.1)
  rio-core/       Finding, EvidenceLevel, identity, Report, ReviewEvent, renderers (terminal, md, json)
  rio-git/        Repo access (gix), modes, Diff/Hunk model, Snapshot, base materialization
  rio-profile/    schema types, YAML load, inheritance, jsonschema validation, rule parser, module registry
  rio-adapters/   Adapter trait, ToolResolver, TypeScript + Python adapters, output parsers, secrets scanner, OSV client, coverage parsers
  rio-graph/      symbol tables (tree-sitter), reference search, expansion, slices, delta
  rio-engine/     local step executor: walks the resolved profile DAG and emits ReviewEvents (NEW crate, not in the TRD list)
  rio-client/     empty placeholder with a README (v0.2)
  rio-runner/     empty placeholder with a README (v0.2)
modules/          built-in rio/* modules: adapters/typescript, adapters/python, steps/{prepare,checks,graph,triage,agents,verify,report}, profiles/base.yaml
schemas/          profile-v1.json, module-v1.json, finding-v1.json, report-v1.json
tests/fixtures/   ts-sample/, py-sample/, monorepo-sample/ with seeded issues
eval/             placeholder README only
```

Rationale: `rio-engine` is added because the TRD puts step orchestration in the Cloudflare Workflow, but v0.1 needs a local orchestrator. Keeping it in its own crate makes the local-versus-remote split explicit: `rio-cli` depends on `rio-engine` in v0.1 and on `rio-client` in v0.2, selecting by configuration. Alternative considered: orchestration inside `rio-cli`. Rejected because the runner needs the same step executor in v0.2.

### D2. Git access through `gix`, with the backend behind a trait

`rio-git` exposes a `Repo` trait (resolve ref, merge base, read tree, read blob, status, untracked listing) implemented by `GixRepo`. If a needed operation turns out to be missing or unstable in `gix`, a `Git2Repo` implementation can be swapped in without touching callers. The `git` binary is never required. Alternative: shell out to `git`. Rejected because the self-hosted runner and sandbox should not depend on a git binary and because parsing porcelain output is brittle.

### D3. Pure cached source trees with dependencies linked into disposable tool trees

Every tool-executing check (type check, lint, tests and coverage) runs against a materialized tree, never in the user's work tree, so the checked head is exactly the selected immutable head (the index in `--staged` mode, the `HEAD` commit in `--base` mode, the snapshotted work tree in working-tree mode). `rio-git` writes the base tree from git objects into `.rio/cache/baselines/<base-sha>/tree/`, honoring the repository's ignore rules only for untracked paths (tracked files are always written). The head tree is the base tree with the snapshot applied (head content written, deletion records removed) at `.rio/cache/heads/<snapshot-key>/tree/`. Cached base and head trees contain only repository content and never contain links to a work tree's installed dependencies. Tools run in a disposable clone of a cached tree: a copy-on-write clone (APFS `clonefile`, Linux `FICLONE` reflink) where the file system supports it, otherwise an independent full copy. Hard links are never used, because a tool writing in place to a hard-linked file would modify the cached file and corrupt later reviews. Tool writes (`tsbuildinfo`, coverage data) therefore never alter the cache. After cloning, dependency directories that are gitignored in the current work tree (`node_modules`, `.venv`, `venv`; `__pycache__` is skipped) are symlinked into that disposable tree from the matching project root. Each run creates its own links to its own work tree, even when several worktrees share one cache, so commit- and snapshot-keyed cached source trees remain immutable and independent of installation paths.

The symlinked dependencies are the work tree's installation, which is not guaranteed to match the selected head: in `--staged` and `--base` mode the work tree may hold an unstaged or uncommitted dependency change, and workspace links (`node_modules/<pkg>` symlinks into the repository from npm, pnpm or yarn workspaces) and Python editable installs resolve source from the work tree rather than from the materialized tree. Before running a tool-executing check on a project root, the engine therefore checks head compatibility:

- the installation must be compatible with the selected head's **effective dependency graph**. Rio does not assume the installation came from the work tree's current manifests, because a branch switch or a lockfile edit without reinstalling breaks that. It reads the installation metadata that the package manager wrote at install time: npm `node_modules/.package-lock.json`; pnpm `node_modules/.pnpm/lock.yaml`; yarn classic `node_modules/.yarn-integrity`; yarn with the `node-modules` linker `node_modules/.yarn-state.yml`; and, for Python, `*.dist-info/METADATA` in the root's `.venv` or `venv`. The lockfile is the one that governs the root: its own, or its workspace root's (see D16). The lockfile parsers from D6 produce a graph rather than a set. Its nodes are `(location, name, version, flags)`, where the flags are `dev`, `optional`, `peer`, platform constraints (`os`, `cpu`, `libc`, PEP 508 markers), and the groups and extras that pull the node in. Its edges are the resolved dependencies. The effective graph is that graph restricted to the root's importer or workspace member and to the current platform. Compatibility means three things. Every installed node that the effective graph covers has the location and version the graph gives it. Every required node is present. Nodes that are optional, platform-excluded, dev-only when dev dependencies were omitted, or that belong only to an uninstalled group or extra may be absent. No installed node sits at a location the graph resolves differently. For `node_modules` layouts, the location is the install path. For pnpm, it is the importer's dependency map plus the package snapshot key. For Python, it is the distribution name, because one environment holds one version per distribution, and markers are evaluated against the interpreter in the environment. Comparing `(location, name, version)` catches different hoisting with identical version sets, which a plain set comparison misses. When the comparison cannot be made (no lockfile in the head, a `requirements*.txt` without exact pins, or unreadable or unsupported installation metadata such as yarn Plug'n'Play), the state is `unverified`, not matching;
- npm package versions compare equally with or without one leading `v` (for example `v0.13.0` and `0.13.0`); Python versions retain their existing comparison. A filtered pnpm installation may leave unresolved requests for importers whose `node_modules` is absent and which are outside **all scheduled roots and their reachable workspace dependencies**. Only those importer notes are ignored; scheduled or installed importers, unresolved package snapshot edges and other metadata failures still prevent verification;
- every dependency entry that resolves into the repository (workspace symlink target, editable-install `.pth` or `direct_url.json` path) must point at source whose content is identical in the work tree and the selected head.

If either fails, that root's `typecheck`, `lint` and `coverage` checks are skipped with reason `dependency_mismatch`. If the state is `unverified`, they are skipped the same way, unless the profile sets `rio/checks` `trust_installed_dependencies: true`. In that case they run with `dependency_state: trusted` and footer note `dependencies_trusted: results use unverified dependencies`. Trust does not disable baseline classification: head and base use the same installed environment. A known mismatch is never trusted, because Rio knows those results would be wrong. Both skips carry a hint that names the differing package, location, file or linked package, or says why the installed state could not be verified. Examples: "run `npm install`", "make the installed source match the selected head", or "no lockfile; installed dependencies cannot be verified (set `trust_installed_dependencies` to run anyway)". A reviewed commit range is never described as something to commit or stash. Working-tree mode gets no exemption: an installation older than the current lockfile is a mismatch there too.

The base run uses the same installed dependency versions, so baseline classification still requires a compatible effective dependency graph. A verified head requires a verified base graph; a trusted head permits an unverified base graph but never a known mismatch. Linked source differences between base and head are handled by **link remapping**, rather than rejected as dependency mismatches. Head compatibility still checks work tree versus selected head, so an unstaged source edit cannot leak into an immutable head check.

When linked repository source differs, each base tool tree receives a private dependency overlay: real directories and links to installed files, with repository source links redirected to the corresponding paths in that disposable base tree. This includes root and nested workspace `node_modules`, pnpm virtual-store links, scoped packages and installation-internal links. Node runs with `--preserve-symlinks` so imports retain overlay resolution paths. Targets outside the repository keep their original targets. Dependency directories for discovered workspace members are included even when that member has no scheduled check. Cached source trees and the head installation remain untouched.

Python uses a private environment overlay, rather than a process-global override. Plain `.pth` source paths and egg-link paths are rewritten to base source; egg-links also receive an overriding path `.pth`. Supported PEP 660 finder modules (`__editable__*` / `_editable_impl_*`) have absolute source-path string literals rewritten, including setuptools `MAPPING` and `NAMESPACES`. Original metadata is never edited. Venv console scripts run explicitly with the overlay interpreter, bypassing their original absolute shebang, so Python site processing and type checkers use the rewritten environment. If an editable source cannot be mapped, or its source is absent in the base, baseline execution fails visibly instead of importing head source. The base check hint records `baseline: N linked packages remapped to base` (distinct changed source targets).

A changed linked Node package is also checked for `main`, `module`, `types`, `typings`, conditional `exports` and `typesVersions` pointing into directories absent from the tracked base tree. For example, an ignored `dist/` cannot be borrowed from the head installation. Rio retains `baseline_failed` with `linked package X is consumed through build output dist/ that is not in the tree; run the build in the base or configure source entry points`. Rio never runs a build or installs base dependencies. Unsupported editable finders, unavailable remapping primitives and dependency graph mismatches also retain `baseline_failed`, naming the cause.

Alternatives: (a) `git worktree add` — needs the git binary and pollutes `.git/worktrees`; (b) classify by hunk membership only — misses cross-file regressions, which is the main value of the baseline; (c) copy the whole work tree and revert changed files — fast but wrong for untracked state and large repos. (a) and (c) rejected; (b) is kept as the automatic fallback whenever the baseline is unavailable (including `baseline_failed` or a disabled baseline). Only diagnostics overlapping changed hunks with three lines of head context stay `unclassified`; diagnostics in unchanged files or outside those hunks are demoted to `pre-existing`, with evidence recording the fallback, and are hidden by default. The footer retains the baseline hint. This fallback can miss cross-file regressions.

Baseline results are cached at `.rio/cache/baselines/<base-sha>/<check>/<input-hash>.json`, where `input-hash` covers every input that can change the result: the project root, the tool and its version, the tool's configuration files, the exact invocation including the sorted list of target files (lint runs on changed files only, so linting `a.ts` and later `b.ts` against the same base must not share a baseline), and the dependency state. A profile change that does not affect the tool does not invalidate the baseline. Trusted baseline results are rerun rather than reused across runs, because unverified installation metadata cannot prove that a cached run used the same environment.

### D4. Tool output: machine-readable formats where they exist

| Capability | Tool | Invocation | Parse |
| --- | --- | --- | --- |
| typecheck TS | tsc | `tsc --noEmit --pretty false -p <root>` | line regex `path(line,col): error TSxxxx: msg` |
| lint TS | eslint | `eslint -f json <changed files>` | JSON |
| coverage TS | vitest / jest | `vitest run --coverage --coverage.reporter=lcov --coverage.reportsDirectory=<cache>` / `jest --coverage --coverageReporters=lcov --coverageDirectory=<cache>` | LCOV |
| typecheck Py | pyright / mypy | `pyright --outputjson` / `mypy --output json` (mypy >= 1.11; older versions fall back to line parsing) | JSON |
| lint Py | ruff | `ruff check --output-format json <changed files>` | JSON |
| coverage Py | coverage.py + pytest | `coverage run -m pytest -q` then `coverage json -o <cache>/coverage.json` | coverage.py JSON |

Exit-code contracts, declared per tool in the adapter manifest (any other code is `failed/tool_crashed`; a "diagnostics" code with zero parsed findings is `failed/unparseable_output`):

| Tool | No diagnostics | Diagnostics | Classified separately |
| --- | --- | --- | --- |
| tsc | 0 | 1, 2 | — |
| eslint | 0 | 1 | 2 → `tool_config_error` |
| ruff | 0 | 1 | 2 → `tool_config_error` |
| mypy | 0 | 1 | 2 → `tool_crashed` |
| pyright | 0 | 1 | 2 → `tool_crashed`, 3 and 4 → `tool_config_error` |
| pytest | 0 | 1 → `tests_failed` with coverage kept | 5 → `skipped/no_tests`; 2 to 4 → `tool_crashed` |
| vitest / jest | 0 | 1 → `tests_failed` with coverage kept when the report file exists | — |

Coverage eligibility comes from the coverage data itself (LCOV `DA` lines; coverage.py `executed_lines`, `missing_lines` and `excluded_lines`). Files absent from the data are classified with the adapter's tree-sitter executability query (`queries/executable.scm`: any statement outside type-only declarations) and with a static read of the project's coverage include and exclude settings. coverage.py runs with the project's own configuration, plus `--source=<root>` when the project sets neither `source` nor `include`, so unloaded files are reported. Vitest runs with `--coverage.all` where its version supports it. Jest runs with `collectCoverageFrom` only when the project sets it. Otherwise absent files are `coverage_not_instrumented`. Coverage from every scheduled root (changed and dependent) is merged by repository-relative path before intersection.

Lint runs on changed files only (head paths, and base paths for the baseline). Type checks run on the whole project root because partial type checking is unsound. Coverage runs the whole test suite; a per-change test selection is a later optimization.

Parsers live in `rio-adapters` next to each adapter and are unit-tested against recorded fixtures per tool version. A parse failure produces the outcome `failed` with reason `unparseable_output` and keeps the raw output, per the language-adapters spec.

### D5. Secrets scanning is built in, not delegated

A pattern catalog (`modules/adapters/common/secrets.toml`) of well-known token formats and private-key blocks, plus an entropy heuristic (Shannon entropy over 3.5 bits per character on values of 20 or more characters assigned to names matching `secret|token|password|passwd|api[_-]?key|private[_-]?key`). The scanner runs in-process over head content of changed text files; line membership in hunks sets the state. Alternative: require `gitleaks`. Rejected because the scan must work with no tools installed, which is the zero-setup promise of the deterministic layer. A `gitleaks`-backed scanner can be added as an adapter tool later without changing finding shapes.

### D6. Dependency audit through OSV: batch for ids, per-advisory detail, changed packages only

Lockfile parsers for the formats listed in the deterministic-checks spec produce the dependency graph used by D3. The audit flattens it to `(ecosystem, name, version)` sets for base and head. Only packages whose resolved version differs are sent to OSV. Rio uses the API in three steps:

1. `POST https://api.osv.dev/v1/querybatch` in batches of up to 1000 queries, as the API allows, with a 10-second timeout per request. For every query whose result carries `next_page_token`, the same query is re-sent with that token until no token remains. The batch result holds only `id` and `modified` per advisory.
2. For each distinct advisory id, `GET https://api.osv.dev/v1/vulns/{id}`, with up to 8 requests in flight. The record is cached at `<cache>/osv/<id>.json` together with its `modified` time, and a cached record is reused while the batch reports the same `modified`.
3. Mapping. The advisories returned for one package version are grouped into connected components over `id ∪ aliases`. Each component becomes one finding, whose canonical id is the smallest OSV id in the group. The finding's `trigger_hash` uses that canonical id, so the finding identity does not change when OSV adds an alias. Severity is taken from `database_specific.severity` when it is present (GitHub advisories). Otherwise the highest CVSS v3 or v4 base score in `severity[]` is mapped to `critical` (≥ 9.0), `high` (≥ 7.0), `moderate` (≥ 4.0) or `low`. Otherwise it is `unknown`. The fixed version is the first `fixed` event, in the matching ecosystem range, that is greater than the installed version. Otherwise it is `unknown`.

Retries: two retries with backoff for each request, on connection errors, 429 and 5xx responses. When the batch call fails, the audit ends `failed/network_error` with no findings. When some detail calls fail, the audit still emits findings for those ids from the batch data, with severity and fixed version `unknown`, and ends `failed/partial_data`. Every finding's severity is `error`, because the advisory severity is carried separately in the `advisory` block. `requirements*.txt` entries without an exact `==` pin are reported in the footer as unauditable rather than guessed. Rationale for changed-only: unchanged vulnerable dependencies are pre-existing issues, which the product principle keeps out of a change review; a full audit belongs to a later `rio audit` command.

### D7. Profile engine: validate as JSON, merge as values, type afterwards

Profiles are loaded with `serde_yaml` into a `serde_json::Value`, validated against `schemas/profile-v1.json` with the `jsonschema` crate, inherited by value-level merge (mappings deep, sequences replaced), semantically validated (DAG, module refs, `with` against each module's `schema` block, guardrails), then deserialized into typed structs. Validating before typing yields error messages with YAML paths; merging at the value level makes the inheritance rule trivially specified and testable. The rule expression language gets a hand-written recursive-descent parser producing an AST that v0.2 will evaluate; v0.1 only parses.

Built-in modules are embedded in the binary with `include_dir!` from `modules/`, so a single binary carries `rio/base` and every `rio/*` manifest and the profile engine needs no filesystem lookup for built-ins. Module manifest v1 fields: `kind`, `name`, `version`, `description`, `schema` (JSON Schema for `with`), and kind-specific blocks (`languages`, `capabilities`, `tools` for adapters; `inputs`, `outputs`, `local: true|false` for steps). `local` is the flag the engine uses to decide execute-versus-defer.

`rio/base` v0.1 declares the full TRD step list (prepare, checks, graph, triage, agents, verify, report) with `rio/checks` options `{ typecheck: true, lint: true, secrets: true, coverage: true, dependencies: true, baseline: true }`, budgets `fast: { wall_time: 4m }`, `fail_on` defaults, `min_evidence: plausible`, `max_lines: 1500`.

### D8. Symbol tables and references with tree-sitter plus scoped text search

`rio-graph` builds per-file symbol tables with tree-sitter queries shipped in each adapter module (`queries/symbols.scm`, `queries/references.scm`), keyed in memory by file content hash so a file parsed for the head slice is not re-parsed for a second seed. Reference candidates are found by an Aho-Corasick scan of seed identifiers over all non-excluded files walked with the `ignore` crate; each candidate file is parsed and only identifier nodes outside string and comment nodes count. Import resolution (TypeScript relative imports and `tsconfig.json` `paths`; Python dotted modules against project roots) upgrades an edge to `resolved` when the referencing file imports the seed's defining module. Expansion is breadth-first with a node cap. Alternative: a full index of every symbol in the repository. Rejected for v0.1; it is the v0.4 background graph.

### D9. One event stream drives every renderer

`rio-engine` emits `ReviewEvent` values (`StepStarted`, `CheckFinished { kind, root, findings, skipped }`, `GraphReady`, `FindingVerified` reserved, `Done { report }`, `Partial`) on a channel. The terminal renderer consumes them live; the Markdown and JSON renderers consume the final `Report`. The event enum is defined in `rio-core` with `serde` derives using the field names the TRD's SSE endpoint will carry, so v0.2's `rio-client` deserializes server events into the same type.

Progress goes to standard error through `indicatif`, and findings go to standard output. In `json` and `md` modes the final document is serialized into memory and written with one `write_all` at the end, so standard output never holds a truncated document. Interrupt handling uses a `CancellationToken`. The first signal cancels in-flight checks through the process supervisor (D12), records them and the pending checks as `cancelled/interrupted`, and flips the report to partial. The second signal sends `SIGKILL` to every live process group, or terminates every job on Windows, and exits 130 without writing a document.

### D10. Finding identity normalization

`normalized_location = path + "::" + symbol_path` (no lines). `trigger_hash = blake3(normalized_message)` where normalization removes only known volatile fields: line and column references (each parser declares the patterns its tool embeds, for example `(12,5)` or `line 42`), absolute path prefixes and the repository root, and tool-generated identifiers matching `[A-Za-z]+_[0-9a-f]{6,}`. Case, numeric literals and type names are preserved, so `Type '1' is not assignable to type '2'` and `Type '3' is not assignable to type '2'` in the same symbol get different ids. The id is `blake3(rule_id | normalized_location | trigger_hash)` rendered as 16 hex characters in reports and in full in JSON. A property test asserts that the id does not change under line insertion and function reordering within a file. A unit test asserts that messages differing only in a numeric literal produce different ids.

Classification works on occurrences, before root-cause grouping. Each tool diagnostic is one occurrence, with its identity and its line. For each identity, Rio first pairs base and head occurrences whose lines map onto each other through the diff's unchanged-line mapping. Lines inside hunks do not map. It then pairs the remaining occurrences in line order. The occurrence states are paired → `pre-existing`, head-only → `new`, and base-only → `fixed`. Grouping then derives the finding state: all new → `new`; at least one new and at least one pre-existing → `worsened`; none new → `pre-existing`, with a fixed-occurrence count; all base-only → `fixed`. Comparing only grouped identities would hide a second identical error added to a function that already had one. The occurrence-level pass exists to prevent that, and it is covered by a dedicated test.

### D11. Review id, run id, cache publication, locking and pruning

`review_id = blake3(snapshot_key | blake3(profile.resolved.yaml))[..16]` identifies the inputs. `run_id` is a ULID generated per execution attempt. Two terminals reviewing the same change share a `review_id` and nothing else they write. Cache layout follows the review-report spec. `<cache>/<review-id>/runs/<run-id>/` is private to one run, and `<cache>/<review-id>/latest` is a small file that is replaced by rename.

Publication. Every file and directory is written as `<name>.tmp-<run-id>` in its final parent directory, on the same file system, then fsynced and published with `rename`. Content-addressed entries (snapshots, `baselines/<sha>/tree`, `heads/<key>/tree`, baseline results, OSV records) are immutable once published. If the rename finds the target already present, the run deletes its own copy and uses the published one. Directory renames that hit an existing target fail on every supported OS, which gives first-writer-wins.

Locking uses advisory file locks through the `fs4` crate (`flock` on Unix, `LockFileEx` on Windows), which the OS releases when the process dies:
- `<entry>.lock`, exclusive, is held while building a shared entry. A second run blocks on it, up to the check timeout, and then reuses the published entry;
- `<cache>/active/<run-id>.lock`, exclusive, is held for the life of a run. Next to it, `<run-id>.refs` lists the shared entries the run uses, and it is appended before each use;
- `<cache>/prune.lock` is taken with try-lock, so pruning is skipped when another run is already pruning.

Pruning runs at the start of `rio review` with a budget of one second of work. A run is live when its `.lock` cannot be acquired. Pruning never removes an entry named in a live run's `.refs` file or a `*.tmp-<run-id>` that belongs to a live run. It deletes the temporary files, locks and refs of dead runs, which is crash recovery. After that it applies the age rules from the review-report spec, removes baselines whose base commit is unreachable from every local ref, and evicts the least recently used entries until the cache is under `cache.max_size`. Entry access time is recorded in `<entry>.used`, because file-system atime is unreliable.

Permissions and contents. The cache root is created with mode `0700`, and files with mode `0600`, using an explicit mode because the umask may be wider. On Windows the cache inherits the repository directory's ACL, which is documented. Raw tool output is streamed through the secrets catalog's redactor before it is written. Each stream is capped at 16 MiB on disk, keeping 8 MiB from the head and 8 MiB from the tail. Parsers consume the stream in memory up to `run.output_limit`. Snapshots and materializations necessarily hold source code, and the README says the cache has the same sensitivity as the repository.

### D12. Concurrency and timeouts

The runtime is `tokio` multi-threaded, and each check is a task. Per-check timeouts come from `budget.fast.wall_time`, apportioned as at most 40 % of the budget each for typecheck and lint, 60 % for coverage, and 10 % for secrets and the dependency audit. The whole run is bounded by the budget. Parallelism comes from `run.parallelism` (D13), which defaults to the number of physical cores, capped at 4.

Process supervision. `kill_on_drop` only kills the direct child, and test runners leave workers and servers behind, so every tool process goes through a `ProcessSupervisor` in `rio-adapters`:
- Unix: `CommandExt::process_group(0)` puts the child in a new process group. Cancellation sends `SIGTERM` to `-pgid`, waits up to 5 s for the child, then sends `SIGKILL` to `-pgid`, then polls `kill(-pgid, 0)` until it returns `ESRCH`, bounded at 5 s. On Linux, Rio sets `PR_SET_CHILD_SUBREAPER` so that descendants which call `setsid` are re-parented to Rio and can be found and killed. On macOS, such escapees cannot be tracked, and that is listed as a known limitation.
- Windows: the child is created with `CREATE_SUSPENDED`, assigned to a fresh Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, then resumed, so it can start no process outside the job. Cancellation calls `TerminateJobObject` and then waits on the job until no process remains.
- Disposable trees are removed only after termination is confirmed. A process still alive after the bounds is named in the footer.
- `kill_on_drop(true)` stays as a last resort for panics.

### D13. Configuration and endpoint detection

The machine configuration (the `cli/review` spec has the key table) is read from `config.toml` in the configuration directory: `$RIO_CONFIG_DIR`, then `$XDG_CONFIG_HOME/rio`, then `~/.config/rio` on Linux and macOS, or `%APPDATA%\rio` on Windows. Precedence is flag, then `RIO_*` environment variable, then file, then default, and unknown keys are rejected. There is deliberately no repository-level config file: a cloned repository must not be able to redirect the cache or raise resource limits. Review behavior lives in profiles, through `rio/prepare` `exclude`, the `rio/checks` options including `trust_installed_dependencies`, and `fail_on` `incomplete` and `required_checks`. If `endpoint.url` is set, `rio review` prints that endpoints are not supported by this version and continues locally. If it is absent, local mode is silent. This keeps the file that v0.2 `rio init` writes compatible.

### D14. Testing strategy

- Unit tests per crate; `insta` snapshot tests for diff, graph slices and all three report formats on the fixture repositories.
- `proptest` for identity stability (D10) and for inheritance merge laws (merging with an empty child is identity; lists replace).
- `assert_cmd` integration tests that run the built binary against `tests/fixtures/*` for every CLI scenario in the specs, including exit codes and `NO_COLOR`.
- Tool-dependent tests detect the tool at runtime and are marked skipped with a reason when it is absent. CI installs Node, pnpm, Python, `pyright`, `mypy`, `ruff` and `coverage`, and sets `RIO_REQUIRE_TOOLS=1`, which turns every such skip into a test failure, so the integration tests cannot be skipped silently in CI.
- Process supervision is tested with a fake tool that forks a long-lived grandchild and writes its pid. The test asserts that the grandchild is gone after a timeout and after a cancellation, on Linux, macOS and Windows.
- Concurrency is tested by starting two `rio review` processes on the same fixture and change, asserting two complete run records and one build of each shared entry, and by killing a run during a write and checking recovery.
- Release acceptance. The PRD's v0.1 exit criterion ("useful on its own in 10 real PRs") is measured, not inferred from fixtures. `docs/evaluation/v0.1.md` records ten real pull requests from at least three repositories, covering both languages. Per the user’s acceptance decision, independent sub-agents provide the verdicts and every record is explicitly labelled `automated`; no verdict is represented as human. Each record holds the repository and PR, the mode, the review id, the wall time, each finding with an independent automated reviewer verdict (true positive, false positive or noise), anything a independent automated reviewer found that Rio missed, and a per-PR "useful / not useful" verdict with a reason. The `v0.1.0` tag requires this record to be complete, with a go or no-go conclusion. Performance is measured cold (empty cache) and warm (cached baselines), with p50 and p95 over at least ten runs each, matching the PRD metric.
- Recorded tool outputs (one fixture per supported tool version) drive parser tests offline.

### D15. Distribution: GitHub Releases, checksums, provenance, two installer scripts

A `release.yml` workflow runs on `v*` tags. It reuses the CI test job, then builds the six targets in a matrix: Linux with `cross` against musl so one static binary covers glibc and musl distributions, macOS and Windows natively on GitHub-hosted runners for both architectures. It packages the archives, writes `SHA256SUMS`, and attests each archive with `actions/attest-build-provenance`. A final job then publishes: it creates a **draft** release, uploads every asset with three retries, downloads everything back from the draft and verifies the count, the checksums and `gh attestation verify`, and only then publishes. Any failure leaves a draft that nobody can install from, and a rerun deletes that tag's draft and starts over. Published releases are never edited. Tags with a semver pre-release part are published with `prerelease: true` and `make_latest: false`. Stable tags use `make_latest: true`. The release attaches the installer scripts from the tagged commit. Installers resolve "latest" to a concrete tag once, by reading the redirect target of `releases/latest`, which GitHub computes from stable, non-draft releases only. They then fetch the archive and `SHA256SUMS` from `releases/download/<tag>/`, so a release published mid-install cannot mix files from two versions. `releases/download/v<x>/install.sh` pins a version.

Replacement. A temporary directory may be on a different file system than the install directory, so `rename` from it is not atomic and may fail. Installers therefore copy the verified binary to a staging name inside the install directory, smoke-test it there with `--version`, and only then rename it over the old binary. Windows cannot rename over a running or locked executable, so it goes through `rio.exe.old` and rolls back if the final move fails. Uninstall is a mode of each installer (`--uninstall` or `-Uninstall`, plus `--purge` or `-Purge`), so it shares the target and directory resolution and removes only what the installer put there. On Windows that includes removing only the exact `PATH` entry.

License: Apache-2.0 for the whole repository. `LICENSE` is at the root, `license = "Apache-2.0"` is in the workspace `Cargo.toml`, and the file is shipped in every archive. The PRD's open question about AGPL for the endpoint is not decided by this change. It is revisited with the endpoint in v0.2.

Trust model: HTTPS to GitHub plus the SHA-256 in `SHA256SUMS` detects corrupted or swapped archives on the same release. It does not protect against a compromised release, which is what signing would add; provenance attestations give users who want that assurance a check (`gh attestation verify <archive> --repo pixelinfinito/rio`, documented in the README) without Rio managing signing keys. Code signing, Apple notarization and a Homebrew tap are deferred. Binaries fetched with `curl` or `Invoke-WebRequest` are not quarantined by Gatekeeper and do not carry the Mark of the Web, so unsigned binaries run without prompts on these install paths.

Installers stay small and dependency-free. `install.sh` is POSIX `sh` because `curl | sh` runs under `dash` on Debian and Ubuntu, and it never edits startup files, because there is no safe way to choose between shells. `install.ps1` does update the user `PATH`, because Windows has no startup-file convention and the user registry `PATH` is the normal mechanism; `-NoModifyPath` opts out. Both default to per-user directories, so neither needs elevation. `RIO_DOWNLOAD_BASE` lets the release workflow test the installers against the just-built archives in a local directory before publishing, and serves corporate mirrors.

Alternatives: `cargo-dist`, which generates all of this. Rejected for v0.1 because its generated installers and workflow would then be the contract, and the trust and PATH behavior above should be explicit and reviewed. It can replace the hand-written workflow later if the behavior is kept. Windows remains best effort for review features (D3), but its binary and installer are built and tested like the others.

### D16. Check outcomes, scheduling of dependent roots, exit code 4

`CheckOutcome` in `rio-core` is `Passed | Findings | Failed { reason } | Skipped { reason } | Cancelled { reason }`. Each variant carries its hint, `dependency_state` and any partial results. The deterministic-checks spec lists the reasons. The engine computes the report `status` and the exit code from the outcomes and `fail_on`, and the precedence is 2 and 3, then 130, then 1, then 4, then 0. Exit code 4 is new. Without it, a crashed type checker plus zero findings exited 0, which presented missing analysis as success. The default `fail_on.incomplete: true` makes `failed` and `cancelled` count. `skipped` stays a warning unless the kind is in `fail_on.required_checks`, so a machine without `eslint` still gets exit 0.

Root scheduling. `rio-adapters` builds a root graph from workspace manifests (`package.json` `workspaces`, `pnpm-workspace.yaml`, `[tool.uv.workspace]`), the `references` in each `tsconfig.json`, and Python path or editable dependencies between roots. Roots with changed files are `changed`, and their transitive reverse dependencies are `dependent`. `typecheck` and `coverage` run on both kinds, and `lint` runs on `changed` roots only. Each member resolves its governing lockfile and installation by walking up to its workspace root. Reverse expansion can multiply type-check time in large monorepos. That cost is visible in per-check wall times, and a later option can cap the number of dependent roots.

### D17. Git compatibility boundaries and resource safety

`rio-git` detects unsupported states up front: unmerged index entries; shallow history through `.git/shallow` when branch mode finds no merge base; gitlinks; LFS through the `filter` attribute and pointer sniffing; skip-worktree bits; symlink modes; and case-folding collisions, by building a case-folded path map when the materialization target is case-insensitive, which is probed once per cache directory. The change-snapshot spec defines the policy for each one. Snapshot application deletes before it writes.

Writers go through one `SafeTreeWriter`. It rejects absolute paths, `..`, `.git` in any letter case, and Windows reserved names. It opens each parent with `O_NOFOLLOW`, or on Windows checks the reparse-point attribute, so it never writes through a symlink. Before materializing, it checks free space against the sum of the tree's blob sizes plus 10 %. `ENOSPC` is turned into `disk_full`, and the temporary directory is removed.

## Risks / Trade-offs

- [`gix` lacks an operation, for example untracked-file enumeration with ignore rules] → `Repo` trait (D2) allows a `git2` implementation; the `ignore` crate already handles ignore rules for the walk.
- [Baseline doubles type-check time on large repos] → cached per base commit (D3); `baseline: false` in the profile; `tsc --incremental` with a `tsbuildinfo` kept in the baseline cache as a follow-up.
- [Materialized base tree does not match base dependencies] → known mismatches prevent baseline classification (D3); `baseline_failed` names the cause, with hunk scoping as the fallback. A trusted head may classify against an unverified base using the same installation.
- [Requiring verifiable installation metadata skips checks on projects without a lockfile or exact pins] → explicit `dependency_mismatch` with a hint naming `trust_installed_dependencies`. Opting in runs the checks with clearly marked `trusted` results and baseline classification in the shared environment when the base has no known mismatch. Known mismatches are never trusted.
- [Effective-graph comparison is more complex than set equality, and lockfile formats encode optionality, platforms and groups differently] → one parser per format producing the same graph type, with fixtures for valid partial installs (omitted dev dependencies, a skipped platform optional, an unselected group) and for identical version sets in different layouts.
- [Exit code 4 can surprise users whose test suites already fail on the base] → the report names the failing check. `fail_on.incomplete: false` or `coverage: false` restores the earlier behavior, and the README documents both.
- [Reverse-dependency expansion increases type-check time in large monorepos] → per-root wall times in metrics; a cap on dependent roots is a follow-up.
- [Processes that deliberately leave their process group survive cancellation on macOS] → subreaper on Linux, Job Objects on Windows; on macOS the surviving process is detected and named in the footer.
- [Coverage tools differ in whether they report files no test loads, so some absent files cannot be classified] → `coverage_not_instrumented` in the footer rather than a false `untested_change`.
- [A linked package requires ignored build output, or an editable finder cannot be remapped] → `baseline_failed` names the missing output or unsupported finder; supported source links resolve through a private base dependency overlay (D3).
- [Monorepo changes that edit a workspace package skip checks with `dependency_mismatch` in `--staged` and `--base` mode when the work tree differs from the head in that package] → explicit skip with a hint; working-tree mode is unaffected; base-only remapping does not bypass the selected-head compatibility check.
- [Materializing a full head tree costs time and disk on large repositories] → extraction from git objects plus copy-on-write clones where available; cached by snapshot key; pruned with the review that references it.
- [Text-based reference search over-connects common identifiers such as `get` or `run`] → scope filtering, import resolution for confidence, node cap with a truncation note, and identifiers shorter than three characters are only matched when import-resolved.
- [Running the project's test suite executes project code on the user's machine] → identical to the user running their tests; `coverage: false` disables it; documented in the README. Isolation is the runner's job in v0.2.
- [`--offline` cannot stop tool and test processes from opening connections] → the guarantee is scoped to the Rio process (cli/review spec); the footer states that subprocesses were not network-isolated; full prevention requires external isolation (a container or sandbox without network) or disabling `typecheck`, `lint` and `coverage`, since type checkers and lint plugins can open connections too. Network enforcement for subprocesses is the runner's sandbox in v0.2.
- [Tool output formats drift between versions] → machine-readable formats where available (D4); parser fixtures per version; `unparseable_output` degradation.
- [Secrets heuristic false positives in fixtures and tests] → path suppressions in the profile; the catalog carries per-pattern test cases.
- [Symlinks and long paths on Windows] → Windows is best effort in v0.1; baseline falls back to `baseline_failed` when symlinking fails.
- [The cache holds source copies and tool output that may contain secrets] → user-only permissions, redaction of raw output before storage, `cache.retain_raw_output: false`, and documentation that the cache is as sensitive as the repository.
- [`curl | sh` and `irm | iex` run a script the user has not read] → scripts are short, versioned with the release, and the README shows the download-inspect-run alternative; checksums cover the binary, not the script.
- [Unsigned binaries] → SHA-256 checksums plus provenance attestations; signing and notarization deferred, with no change to archive names or installer behavior when they are added.
- [Scope creep toward v0.2] → anything requiring a model or endpoint is rejected at the CLI with an explicit message, and the deferred list in the footer is the only place it appears.

## Migration Plan

Greenfield; nothing to migrate. Contracts frozen by this change and extended, never broken, by later ones: `schemas/profile-v1.json`, `schemas/module-v1.json`, `schemas/finding-v1.json`, `schemas/report-v1.json` (including `status` and check outcomes), the `ReviewEvent` enum, the review cache layout (review and run directories), the `config.toml` keys and precedence, and the exit codes 0, 1, 2, 3, 4 and 130.

## Open Questions

- Entropy threshold and minimum length for the secrets heuristic will be tuned against the fixture set; the spec only requires redaction and classification.
- Whether to ship a `rio/minimal` built-in profile (checks only, no graph) in v0.1; it is additive and can land in a follow-up.
- Whether baseline lint should run on the base version of changed files only (current plan, cache keyed by file set) or on the full base tree (one reusable baseline per base); the former is cheaper per review, the latter caches better across reviews.

# Litestar deterministic evaluation, 2026-11-05

Reviewer: **sub-agent eval-litestar (automated)**; verdict source: **automated**.
This is automated adjudication, not human confirmation or a release decision.
Repository: `litestar-org/litestar`; no substitution was needed. The chosen
commits have `uv.lock`. Binary version was verified before any review:
`rio 0.1.0 x86_64-unknown-linux-gnu b15dc8ff5001`, binary SHA-256
`512d123450bb93a62f03dc74bbe5057e24abeac70f365acb418f02933904e3f2`.
The binary was not rebuilt. `crates/` and `eval/*.py` were not modified.

## Cases and independent evidence

- **Negative control, real merged maintainer PR #5178**:
  https://github.com/litestar-org/litestar/pull/5178, author `Kumzy` (`MEMBER`),
  merged 2026-10-31. Base `716f8b023b1c13e6f1e8ab08dfa1938f7923312d`, head
  `9870dce9dc2688e78fc43bc73e27eed4198893ac`. The substantive routing change
  escapes mount paths, enforces segment boundaries, and prefers the longest
  matching mount. Full repository Ruff and configured mypy both pass on base
  and head; mypy checks 1116 source files each. Activated Pyright passes both
  with zero errors/warnings. Instrumented relevant routing tests pass: 4 base,
  14 head, with 3 server-integration tests deselected at each commit by the
  repository configuration. Independent coverage has no missing changed
  executable source lines. See `litestar-evidence/oracle-commands.json`,
  `pyright-activated-commands.json`, `*-coverage.json`, and
  `negative-diff-coverage-assessment.json`. The scope is those routing tests,
  not the entire test suite. No deterministic miss was independently found.
- **Positive control, seeded mutation on PR #5164's base**:
  public parent https://github.com/litestar-org/litestar/pull/5164; base
  `f4f7e9831574ed08f50901e62911019b5e7383ac`, synthetic head
  `fcab0954a74c5f8d340adbbfb9091f94982aa9a2`, case ID `5164-seed-f841`.
  Exactly one unused local assignment was added at
  `litestar/utils/path.py:24`, inside `normalize_path`. The function's result
  and control flow are unchanged. This does **not** review #5164's real head
  and does **not** count as a real positive PR. `ruff check .` passes on the
  base and catches exactly one enabled F841 on head. The expected bug
  `unused-local-normalize-path` was registered before mutation/Rio execution.
  The register, seed, exact patch, SHA-256, oracle outputs, commit identity,
  profile hash, lockfile hash, and incremental Git bundle are preserved under
  `litestar-evidence/`. No credential was seeded.

## PR search and rejected candidates

Approximately 30 minutes were spent investigating real introducing heads before
using the authorized fallback. Searches included merged PR titles/bodies for
"typing", "fix typing", "mypy", "pyright", and "lint", plus first-parent Git
history and specific follow-up diffs. This was not an exhaustive proof that no
qualifying real control exists.

- #4689 fixes a misspelled Pyright configuration setting and replaces stale
  ignore comments. Its newly enabled check exposing old errors does not prove
  a previously introduced error under the original enabled configuration.
- #4419 fixes `_dec_pydantic_uuid`'s public return annotation. Its implementation
  casts to the same incorrect type, and the file is excluded by Pyright. No
  base-pass/head-fail deterministic oracle for the introducing PR was proven.
  The fix itself was not substituted for an introducing control.
- #4487 improves `Accept.best_match`'s overloads for callers; it does not establish
  a new error in the repository's configured typecheck targets.
- #3765 repairs websocket listener override typing; no qualifying introducing
  PR plus pinned uv.lock/oracle pair was established during the search.
- #5104 repairs `tools/prepare_release.py`'s return annotation. `tools` is outside
  configured mypy packages and explicitly excluded by Pyright, so this would
  not be a supported configured typecheck control without changing scope.
- #4402 upgrades Ruff and applies lint fixes across existing files. A new tool's
  diagnostics against old code do not prove an introducing head violating its
  then-enabled rules.
- The follow-up commit `c4189610be57a147cebc379a12b5fb399fb5fae7` fixes a real
  optional-host typing error in `allowed_hosts.py`, introduced by direct commit
  `31806105c57cda0e1e82726b37e3f36030ca26ce`. GitHub's commit-to-PR endpoint
  returned no public introducing PR association; it was not relabeled as a PR.
- Lint fix `21b836e6dbaa03753e23d5ec0ed715d69f6350f2` follows `be82df2aa` on
  #4572's branch. The error was fixed before the PR head; that PR was not merged
  when inspected. Reviewing an intermediate commit would violate head selection.
- #2229 predates Litestar's move to uv (#3875), so it lacks the required lockfile
  setup. #4126/3048 were inspected as older public typing fixes but no qualifying
  original head plus enabled-rule oracle was established.
- #4990, #5071, #5158, #5161, #5179 and #5185 were inspected as additional
  recent fixes/coverage candidates. Their changed code has regression tests,
  or there was no independent evidence of an introducing deterministic error.
  None was called a positive control merely because it fixed a semantic bug.

Saved candidate metadata/diffs are in `litestar-evidence/`; some search API
responses and disposable checkouts stayed outside versioned artifacts.

## Setup, attempts, and capability limits

- CPython 3.11.14 downloads stalled. A separate `curl` attempt timed out after
  receiving only part of the archive. These were setup failures, not tool
  diagnostics. The final runtime is pinned CPython **3.12.12**, present in the
  project's Python 3.12 test matrix; the repo's configured type target remains
  Python 3.11. uv **0.13.7** is pinned and recorded.
- Full locked installs use all dependency groups/extras. The first base install
  failed fetching pinned Git dependency `advanced-alchemy` due an HTTP/2 CANCEL/
  early EOF. HTTP/1.1 retry succeeded at the identical locked Git SHA. Installation
  did not exceed the requested 45-minute total wall-time limit, so no repository
  substitution was made. Initial failures and retry logs remain in evidence.
- Locally cloning a blob-filtered Git checkout lost lazy-fetch configuration and
  temporarily produced missing-file errors. The oracle clones were repaired by
  enabling the original GitHub promisor remote and resetting to the exact SHAs;
  subsequent `git diff` checks were empty. Final runner transports used complete
  source objects fetched into a shallow disposable bare repository.
- First Pyright oracle runs used the system interpreter despite invoking the
  virtualenv script, producing missing imports. These outputs are preserved and
  superseded by an activated virtualenv invocation matching CI's `uv run pyright`.
  Both corrected runs pass. They are not Rio false positives.
- **`litestar-5178-attempt1` is excluded**: runner exit 1, no baseline execution or
  classification. Executable `.pth` hooks from coverage, Sphinx, and setuptools
  made dependency verification unavailable. Zero findings is not a clean Rio
  result. Its record is explicitly `environment-failure`, not scored.
- The first repaired install plan uses `--no-editable` and disables only four known
  startup `.pth` hooks, logging their original content and hashes. No tracked
  source, configuration, lockfile, or enabled lint/type rule is edited, and
  `trust_installed_dependencies` stays false. This is a compatibility workaround
  in disposable environments; it is not blanket trust of installed dependencies.
- Both final scored runs use `profile-long.yaml`, retaining all rio/base checks and a
  **60-minute** budget because this shared host was heavily CPU/I/O loaded.
  Both use `PYTEST_ADDOPTS=tests/e2e/test_routing/test_path_mounting.py`.
  The final runs also use `install-plan-final.json` and absolute `COVERAGE_RCFILE` pointing to `litestar-evidence/coverage-scoped-threshold.toml`; exact commands and settings are pinned.
- The dependency audit is deliberately offline, with a fresh unpopulated cache.
  Its expected offline skip is an explicit capability limitation; no vulnerability
  recall or dependency-safety claim is made.
- An unpublished seed cannot be fetched from public GitHub by the unchanged
  runner. A process-scoped Git URL rewrite points only Litestar's URL to a local
  bare transport containing exact public Git objects and the seed. HTTP/1.1 and
  the rewrite are passed through `GIT_CONFIG_*`. The same transport is used for
  the negative control; neither reviewed public commit is reconstructed.
- A complete bundle made from shallow history was not independently cloneable;
  it was replaced with `seed-mutation.bundle`, an incremental seed bundle requiring
  the public base. The retained patch and pinned commit metadata also reproduce
  the mutation. This was evidence packaging, not a Rio defect.

## Rio and harness observations

1. **Installed Python environment compatibility limitation**, no finding ID:
   `litestar-5178-attempt1/report.json` skips typecheck, lint, and coverage with
   `dependency_mismatch`, listing `a1_coverage.pth`, `_sphinx_jinja2_compat.pth`,
   `sphinxcontrib_jsmath-1.0.1-py3.7-nspkg.pth`, and `distutils-precedence.pth`.
   Reproduce using the original `install-plan.json` and 20-minute `profile.yaml`.
   The completed install is not enough for a working baseline. This is a setup/
   verification limitation, not a finding false positive.
2. **Harness evidence gap**, no finding ID: `eval/runner.py` records its own
   subprocesses in `commands.json`, but Rio's internal typecheck argv is absent,
   and its disposable cache is deleted after completion. An external `/proc`
   observer preserves actual tool commands and raw artifacts in each final run's
   `rio-tool-evidence/commands.json` and `rio-tool-evidence/cache/`. The unchanged
   top-level runner ledger is also retained. See `REPRODUCE.md` and the observer
   source in `litestar-evidence/capture-tools.py.txt`.

3. **Incorrect live-source inference for non-editable Python local wheels**, no
   finding ID: both `litestar-*-tmpfs/report.json` footers say
   `baseline_failed: linked dependency litestar points at changed source ...;
   commit or stash the linked package's changes`. Both Git checkouts are clean,
   and uv installed with `--no-editable`. The local wheel's PEP 610
   `direct_url.json` has `dir_info: {}`, not `editable: true`. Rio nevertheless
   treats its file URL as a live link. For #5178 it names the legitimate changed
   `docs/release-notes/changelog.rst`; for the seed it names the intended
   `litestar/utils/path.py` mutation. This blocks **all** base diagnostic pairs
   even with verified head dependencies. Reproduce with
   `install-plan-no-startup-hooks.json`, `profile-long.yaml`, and the pinned SHAs.
   `install-plan-final.json` preserves and renames only this non-editable root
   distribution's provenance file, asserting its URL is the checkout root and
   `editable` is false. The original JSON/hash is logged in each final run. It
   does not remove any package, source, or version metadata, and does not enable
   dependency trust.
4. **Misleading coverage failure wording**, no finding ID: the scoped suites
   pass, and coverage.py writes valid JSON, but its JSON export exits 2 because
   overall coverage (39%/41%) is below the project's global `fail_under=50`.
   Rio records `failed / tool_crashed` with `tool exited with undeclared code 2`.
   This is an ordinary coverage threshold exit, not a crashed process. Its
   failed outcome is a setup blocker, **not** a finding false positive. The
   final external `coverage-scoped.toml` preserves source, plugins, parallel
   settings, omissions and line exclusions, changing only the report threshold
   to zero. The covdefaults plugin then overrode that zero to 100 (a setup mistake),
   so the final `coverage-scoped-threshold.toml` uses 0.01 instead. An independent
   export against existing head coverage data exits 0 with this value. Diff coverage
   remains enabled. No tracked coverage configuration is changed.
5. **Source materialization performance observation**, no finding ID: on this
   loaded ext4 host, both Rio worker threads were observed in
   `jbd2_log_wait_commit` during source copies with per-file syncs. The ext4
   attempts were interrupted after several minutes and are excluded. Repeating
   unchanged pins/profile on `/run/user/1000` tmpfs removes that storage delay.
   These runs are not a controlled performance benchmark.

The seven excluded attempts are retained with adjudicated environment-failure
records: the initial startup-hook attempt; two interrupted ext4 attempts; and
two tmpfs attempts with the non-editable provenance / coverage-export blockers; and
two attempts where covdefaults overrode the external zero threshold to 100.
Any independently proven F841 finding in those attempts is observational only,
and excluded from quality denominators. The two final scored records are
`litestar-5178-scored/record.json` and
`litestar-5164-seed-f841-scored/record.json`.

Final finding adjudications and measured times follow below.


## Final adjudication and resolved target

Both scored runs have `baseline_ran=true`, `baseline_classification_ran=true`,
and `dependency_state=verified` for every applicable base/head mypy and Ruff
root. Coverage and tests pass. Raw status is `incomplete` because of the
explicitly excluded offline dependency audit, not unavailable diagnostic
baselines. Both records are eligible and useful under deterministic-v1.

- `litestar-5178-scored/record.json`: kind `none` (negative control). All five
  finding verdict counts are zero. No expected bugs or established misses.
- `litestar-5164-seed-f841-scored/record.json`: kind `seeded-mutation`.
  True-positive **1**; false-positive, pre-existing-shown, environment-failure
  findings, and out-of-scope **0** each. Expected bugs **1 detected, 0 missed**.
  Exact finding ID:
  `43d6925de36ee0e0beb788c1be9fd46de7152f1be80230d5085329c5f9911eab`,
  `lint/ruff/F841`, state `new`, `litestar/utils/path.py:24`, symbol
  `path.normalize_path`. This is one synthetic lint control, not broad recall
  evidence. No additional independent deterministic miss was established.

Rio selects **mypy 1.19.1**, root `.`. Actual captured argv is `mypy --output
json --config-file <disposable tree>/pyproject.toml`, with no positional target
override. The captured config explicitly selects packages `litestar`, `tests`,
and `docs.examples`, with configured Python version `3.11`. Both commands and
config text are in each scored run's `rio-tool-evidence/commands.json`,
summarized in `typecheck-target.json`. The independent CI-style mypy oracle
checks the same configured scope (1116 files). No wrong typecheck target,
finding false positive, or missed registered bug was observed after setup
repair. Check-level failures above have no finding IDs; none were invented.

## Attempt ledger and wall times

| Directory | Baseline classified | Eligible | Rio seconds | Runner seconds |
| --- | --- | --- | ---: | ---: |
| `litestar-5164-seed-f841` | false | false | 485.257 | 590.363 |
| `litestar-5164-seed-f841-final` | true | false | 166.522 | 202.088 |
| `litestar-5164-seed-f841-scored` | true | true | 139.470 | 210.170 |
| `litestar-5164-seed-f841-tmpfs` | false | false | 84.198 | 143.651 |
| `litestar-5178` | false | false | 578.404 | 679.352 |
| `litestar-5178-attempt1` | false | false | 76.774 | 429.075 |
| `litestar-5178-final` | true | false | 174.318 | 193.308 |
| `litestar-5178-scored` | true | true | 152.531 | 223.871 |
| `litestar-5178-tmpfs` | false | false | 95.871 | 156.403 |

Total measured runner uv command time, summing all attempts: **524.377
seconds**. Initial independent locked installations and retries took about
12 wall-clock minutes, plus the stalled Python download; total installation
work stayed below the 45-minute substitution limit. Concurrent command sums
are not elapsed end-to-end wall time. Shared-host CPU/I/O contention means
these are observations, not a controlled performance benchmark.

Independent oracle times: base/head mypy 707.888/604.087 s; Ruff 0.983/7.531 s;
instrumented routing processes 456.070/355.433 s (pytest itself reports
96.16/28.11 s). Correctly activated Pyright passes in 279.589/280.563 s.
Exact seed oracle and installation timings are in their command ledgers.

`litestar-summary.json` has **2 eligible records and 7 excluded attempts** and
reports **insufficient-evidence** for the full release methodology sample.
No release decision is inferred. All nine records passed schema and semantic
validation. Reviewer identity and automated verdict source are explicit.

## Rerun2 (binary f6e4f87e4c65)

Date: **2026-11-05**. Reviewer: **sub-agent rerun2-litestar (automated)**;
`verdict_source: automated`. Verified before execution:
`rio 0.1.0 x86_64-unknown-linux-gnu f6e4f87e4c65`, SHA-256
`3e28a47f9460af1ae2ad9572d065f4eb03314ee56cdc851c8f185d9bb57572c7`.
No rebuild, `crates/` edits, or `eval/*.py` edits were performed.

Both preregistered cases retain their exact earlier base/head SHAs:

- #5178: base `716f8b023b1c13e6f1e8ab08dfa1938f7923312d`, head
  `9870dce9dc2688e78fc43bc73e27eed4198893ac`.
- `5164-seed-f841`: base `f4f7e9831574ed08f50901e62911019b5e7383ac`,
  synthetic head `fcab0954a74c5f8d340adbbfb9091f94982aa9a2`. The exact
  retained Git commit was fetched, not a new mutation. Its one-line patch hash
  was reverified against the local transport:
  `2ef92d4ca023bd78f1efbec512a0ff9788d1f0e2dbd957c5f66e9d3802455c4a`.
  This remains a seeded case on #5164's public base, not its real PR head.

The prior scored `install-plan.json` and `profile.yaml` were copied byte for
byte. The profile retains its historical name `eval-litestar-b15dc8ff5001`
intentionally; the binary identity above is the actual rerun identity. Input
profile SHA-256 remains
`7f79af17af30fa064a6c7382114fbaca818be229d12e4bfea20ca9678544f4b8`.
Both cases and both commits retain uv.lock SHA-256
`8f25baff7a27134191cd7adcb550963aa1212f1081f13196b929e305ff17dfbd`.
CPython **3.12.12** and uv **0.13.7** were pinned before the runner. Rio selected
mypy **1.19.1**, Ruff **0.15.7**, and coverage.py **7.13.5**.

The same four startup-hook and non-editable-wheel provenance workarounds remain
in the install plan, with original contents/hashes logged. Dependency trust
remains false. The scoped routing suite, external coverage configuration and
0.01 export threshold are unchanged. OSV audit remains deliberately offline
with a fresh unpopulated Rio cache; no vulnerability detection or dependency
safety claim is made. The earlier independent oracles were reused at identical
SHAs, while actual Rio output, scope, baselines, and coverage were rechecked.
Preregistration and exact launch environments are in
`litestar-rerun2-evidence/preregistration.json` and `*-launch.json`.

### Setup failure and retained attempt

Initially `/dev/shm` had about 5.6 GB free. The first #5178 attempt used
`TMPDIR=/dev/shm` and a tmpfs source/cache directory, but uv's default shared
cache still used disk. Base `uv sync` hit the harness's 1,200-second timeout
(measured command wall time 1,272.971 s, exit 124). At investigation,
`/proc/pressure/io` reported `some avg10=84.73 avg60=87.52 avg300=93.13`.
The matching head installer alone was stopped with SIGTERM (exit -15) to avoid
repeating the same stalled setup. No unrelated process was stopped.
`litestar-5178-rerun2` is retained and validated as an **environment-failure**:
baseline ran **no**, baseline classification **no**, dependencies **unavailable**,
zero findings. Its report skips typecheck/lint/coverage with
`dependency_mismatch` because installation never reached the startup-hook
workaround. The exact `.pth` paths and note text remain in its raw report and
`commands.json`; no finding ID exists for these skips. Zero findings here does
not establish a clean review.

Retry `litestar-5178-rerun2-attempt2` uses the separate 4 GB
`/run/user/1000` tmpfs for temporary files, source snapshots, and an isolated
`UV_CACHE_DIR`. The seed then uses the same storage settings. Neither install
plan nor dependency selection changed. Locked base/head uv sync took
10.392/3.356 s for the retry and 1.335/1.235 s for the seed. This workaround
resolved the setup delay. These shared-host observations are not a controlled
performance benchmark. The installer stop and reason are preserved in
`litestar-rerun2-evidence/install-timeout-workaround.json`.

### Case results and comparison

- **#5178**: canonical record
  `litestar-5178-rerun2-attempt2/record.json`. Baseline ran **yes**, baseline
  classification **yes**; all applicable Python mypy/Ruff head/base entries
  succeeded with dependency state **verified**. Eligible **yes**, useful **yes**.
  Findings by raw state: **none**. Verdict counts: true-positive **0**,
  false-positive **0**, pre-existing-shown **0**, pre-existing-hidden **0**,
  environment-failure findings **0**, out-of-scope **0**. Negative control:
  **0 expected bugs**, **0 misses**. Same clean result as `litestar-5178-scored`.
  Fresh routing tests: **14 passed, 3 deselected**. The changed executable anchor
  at `asgi_router.py:187` is executed; the handlers edits have no changed
  executable statements. Current `diff-coverage-assessment.json` confirms this
  using the captured normalized coverage. No findings, risks, or coverage
  exclusions were emitted; no newly established deterministic miss.
- **Seeded #5164**: canonical record
  `litestar-5164-seed-f841-rerun2/record.json`. Baseline ran **yes**, baseline
  classification **yes**; all applicable mypy/Ruff head/base entries succeeded
  with dependencies **verified**. Eligible **yes**, useful **yes**. Findings by
  state: **new 1**, all other states **0**. Verdict counts: true-positive **1**,
  false-positive **0**, pre-existing-shown **0**, pre-existing-hidden **0**,
  environment-failure findings **0**, out-of-scope **0**. Expected
  `unused-local-normalize-path`: **1 detected, 0 missed**. Exact finding ID:
  `43d6925de36ee0e0beb788c1be9fd46de7152f1be80230d5085329c5f9911eab`,
  `lint/ruff/F841`, `new`, `litestar/utils/path.py:24`, symbol
  `path.normalize_path`. This matches the previous scored result and finding ID.
  Base Ruff passes; head has exactly this F841. Fresh scoped tests:
  **4 passed, 3 deselected**. The assignment is instrumented and executed,
  so it remains a lint control and introduces no uncovered-line expectation.
  No additional finding, risk, exclusion, or established miss.

Mypy target resolution remains correct for these explicitly configured cases.
In each successful run, supplemental `/proc` observations capture both actual
`mypy --output json --config-file <tool-tree>/pyproject.toml` invocations without
a positional override. The captured configuration selects packages `litestar`,
`tests`, and `docs.examples`, with Python target `3.11`. Each run preserves
`typecheck-target.json` and `rio-tool-evidence/commands.json`; both base/head
typechecks pass. Secret scans pass with zero findings in both cases: no new
secret-rule false positive was observed on these diffs. The executable-line
coverage requirement produces neither a false alert nor an established miss
here. Neither case is a secret or vulnerability positive control.

### Observed Rio and harness defects

1. **New doctor all-roots base-verification discrepancy; no finding ID.**
   Reproduce in either installed pinned checkout with
   `rio doctor --base FULL_BASE_SHA --format json`, then add `--all-roots`.
   Ordinary `--base` verifies both Python head and base and sets the Python
   typecheck/lint/coverage baseline flags to true. Adding `--all-roots` changes
   Python base to unverified and all three flags to false, with exact hint:
   `baseline_failed: no lockfile in the selected tree; installed dependencies cannot be verified (set trust_installed_dependencies to run anyway)`.
   Both real pinned trees contain the same uv.lock. Both doctor invocations
   exit 0. Each canonical run retains `doctor-base.json`,
   `doctor-all-roots.json`, stderr, and exact command/timing records;
   `litestar-rerun2-evidence/doctor-defect.json` consolidates the repro. Read-only
   source inspection shows doctor replaces `changes.base` with an empty tree
   for all-roots discovery and passes it to dependency planning. The successful
   actual reviews verify and classify their real bases; this doctor diagnostic
   discrepancy does **not** exclude those reviews. Workaround: use
   `doctor --base` plus actual review checks for this review's readiness.
   All-roots also detects standalone JavaScript and warns about missing
   TypeScript tools; those files are outside these preregistered Python diffs.
2. **Harness child-command telemetry gap persists; no finding ID.**
   New `commands.json` explicitly records
   `rio_checks.child_argv_available=false`; Rio does not serialize complete
   per-child executable/argv/cwd/version tuples (selected tool versions are in
   the report footer). The retained external observer
   `litestar-rerun2-evidence/capture-run.py.txt` captures actual mypy commands,
   configurations, tool artifacts and supplemental doctors without changing
   the runner. `/proc` sampling can miss short-lived tools and is not complete
   child telemetry. The authoritative reports and unchanged harness ledgers
   remain alongside the supplemental observations.

The earlier startup-hook, local-wheel provenance and scoped coverage-export
compatibility issues were masked by the mandated unchanged install plan and
coverage configuration. Their fix status is **not established by this rerun**.
The initial install timeout is environment evidence, not an emitted Rio false
positive or a controlled Rio performance defect. No finding-level Rio defect
was observed in either eligible case.

### Wall times and records

Rio seconds below come from `report.json#/metrics/wall_time_ms`; process seconds
come from the runner's review command; runner seconds span its recorded
`started_utc` to `finished_utc` (including installs and cleanup).

| Attempt | Baseline classified | Dependency state | Eligible | Rio s | Review process s | Runner s |
| --- | --- | --- | --- | ---: | ---: | ---: |
| `litestar-5178-rerun2` | no | unavailable | no | 35.814 | 36.726 | 1613.334 |
| `litestar-5178-rerun2-attempt2` | yes | verified | yes | 167.049 | 176.220 | 214.225 |
| `litestar-5164-seed-f841-rerun2` | yes | verified | yes | 147.820 | 150.471 | 173.048 |

Previous scored Rio times were 152.531 s (#5178) and 139.470 s (seed).
Different shared-host load and cache placement preclude performance conclusions.
The wrapper's separate launch durations also include observer startup/final
capture; exact values are retained in `*-launch.json`.

All three attempts have complete automated verdicts and passed
`eval/evaluate.py record` and `validate`. `litestar-rerun2-selection.json`
selects the two eligible canonical records; `litestar-rerun2-summary.json`
preserves the omitted setup attempt in its selection metadata. Both all-eligible
and verified-only views contain **2 eligible cases**, **1 detected seeded
expectation**, **0 missed expectations**, and **0 false positives**. This small
cohort remains **insufficient-evidence**, not a release decision. Historical
`litestar-summary.json` and all older attempts remain unchanged. Large
supplemental JSON graph artifacts are gzipped; no clone, virtualenv, or file
over 5 MB is included.

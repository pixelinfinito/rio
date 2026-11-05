# Pydantic deterministic evaluation

Reviewer: `sub-agent eval-pydantic (automated)`; verdict source: `automated`.
Evaluation started 2026-11-05 approximately 02:16 UTC. No human confirmation is claimed.

## Frozen scope and selection

Read `eval/README.md`, `eval/METHODOLOGY.md`, `eval/positive-controls.md`, and
`eval/runner/README.md` before selecting controls. Binary:
`/home/ubuntu/rio/target/release/rio`, verified with `--version` as
`rio 0.1.0 x86_64-unknown-linux-gnu b15dc8ff5001`. No Rio rebuild or changes to
`crates/` or `eval/*.py` were made.

Candidate metadata, exact patches, selection time, expected bug ID, profile hash,
and pinned SHAs are in `pydantic-evidence/control-register.json` and the saved GitHub
API responses. Expectations were registered before Rio execution/output inspection.

- **Positive candidate, real introducing PR #14199**:
  <https://github.com/pydantic/pydantic/pull/14199>, merged maintainer Viicos PR
  introducing `pydantic/_internal/_contextlib.py`. Base
  `a9f3f3fccc180c05190df0478a17487ec9908e4e`, public PR head
  `262700f815672fc37ed637a1604234f6c7cc7ee9`. Follow-up #14202 explicitly
  excludes previously unexecuted context manager error/suppression paths. Review
  the introducing head, not #14202. One expected underlying testing gap:
  `contextmanager-uncovered-error-paths` (`uncovered-lines`). This does not claim
  a runtime semantic defect; subsequent exclusion is evidence of the intended
  coverage treatment, while independent coverage must establish the head gap.
- **Negative candidate #14213**:
  <https://github.com/pydantic/pydantic/pull/14213>, recent merged MEMBER maintainer
  Viicos refactor replacing distribution enumeration with the entry-points API,
  including updated loader tests. Base
  `5740091dcd08e4a92940ceae841434a83331cb09`, public PR head
  `ef2cb073d6be2ef360d2aedcd5afca0983af2507`.
- **#14202 rejected as the positive**: it is the follow-up coverage exclusion,
  not the introducing PR. Also not selected as the substantive negative: its
  changes are coverage pragmas only.
- **#14176 considered, rejected**: maintainer ByteSize boundary fix is a semantic
  regression reproduction, not independently established as an in-scope type,
  enabled lint, secret, dependency or coverage introduction.
- **#14186 rejected**: Ruff version/dependency update changes the toolchain and
  lockfile; unsuitable for this unchanged-lockfile baseline cohort.
- **Typing search** (`pydantic-evidence/pydantic-typing-prs.json`): #9990, #9924,
  #9914, #9353 and other old typing fixes were inspected by title/history but not
  selected: fixes are not introducing controls, and older pre-uv revisions would
  need a different installation cohort. No oracle verdict is claimed for them.
- **Unmerged PRs** in the saved recent PR response were not selected; the user
  requested real merged controls. A real coverage introduction was found within
  the search budget, so no seeded mutation was needed.

## Setup and limitations

Initial setup used `pydantic-evidence/install-plan.json`: `uv sync --locked --python 3.12.12
--group dev --group linting --group typechecking --group coverage --all-extras`.
The repo has no exact Python pin and tests a Python version matrix; 3.12.12 is
frozen for this evaluation. uv 0.13.7 satisfies its `>=0.13.0` requirement.
Pyright, mypy, Ruff, pytest, coverage and all other installed dependencies remain
lockfile pinned. `uv run --no-sync` prevents oracle commands from dropping the
explicitly installed groups. Exact oracle argv, environments, output, exit codes
and wall times are in each evidence subdirectory's `commands.json`.

The custom profile copies `rio/base` and increases its fast wall budget from
4 minutes to 20 minutes; all check capabilities and verified-dependency baseline
requirements remain enabled. Both candidates leave their lockfiles unchanged.
The runner invokes Rio offline. Dependency auditing without a populated advisory
cache is an explicit capability limitation: these records do not establish
vulnerability safety, and there is no dependency positive-control expectation.

`CONTEXT=eval-pydantic` supplies the environment variable used by the repository's
coverage config. The initial setup used the default pytest selection. The final test scope is
explicitly narrowed below to Pydantic functional/docs tests, excluding the core
workspace tests and benchmarks; no changed source is excluded.

Oracle setup failures (preserved, unscored):

1. `positive-base-setup01`: shared clone from a blob-filtered source lacked several
   promisor objects, including the core workspace manifest/lockfile. `uv sync`
   failed before tests. Materialized both commits in the original network clone,
   then restored the shared checkout. This is evaluator setup, not a Rio defect.
2. `positive-base-setup02`, `positive-head-setup01`: Cargo was installed but absent
   from shell PATH. Maturin tried downloading Rust; interrupted these installs,
   then prepended `/home/ubuntu/.cargo/bin`. The dependency build is Pydantic's
   own workspace extension, not a Rio rebuild.
3. `positive-base-setup03`, `positive-head-setup02`: shared disk I/O saturated
   (Linux IO pressure full avg10 approximately 86%, >3 GiB dirty pages), stalling
   checkouts/cargo metadata for minutes. Interrupted setup and moved disposable
   clones, uv cache, Cargo home/target and eventual runner temp roots to
   `/dev/shm/rio-pydantic`. Durable evidence remains in this worktree. These
   interrupted attempts have nonzero install exit codes and are not scored.

Runtime overrides additionally include `UV_CACHE_DIR`, `CARGO_HOME`,
`CARGO_TARGET_DIR`, and `CARGO_BUILD_JOBS=2`, recorded verbatim by the oracle.
Disposable source trees, caches, compiled dependencies, and venvs are not committed.

4. `positive-base-setup04`, `positive-head-setup03`, `negative-base-setup01`,
   `negative-head-setup01`: full pytest collection failed (exit 2) because the
   root's `tests/pydantic_core` symlink collects workspace tests requiring
   `hypothesis`. Expanded the locked plan with `--all-packages --group
   testing-extra` (both workspace testing extras). The original plan is retained
   as `install-plan-setup01.json`. Complete oracle reruns use the final plan.
   Test scratch files use `TMPDIR=/dev/shm/rio-pydantic/tmp`.

The package-only supplementary oracle (`uv run --no-sync pyright --outputjson
pydantic`) returned zero errors on all four original installed checkouts. Its
outputs/command records are retained in the setup04/setup03/setup01 evidence,
with `package-oracle-progress.log` identifying all four exits. This supplementary
command does not change the project's configured target or replace its native
configuration oracle. Native Pyright reports 12 matching pre-existing diagnostics
in `tests/test_pipeline.py` on both base and head; it checks that file because
`[tool.pyright].include` explicitly includes it alongside `pydantic`.

5. `positive-base-setup05`, `positive-head-setup04`, `negative-base-setup02`,
   `negative-head-setup02`: full workspace coverage was interrupted after roughly
   ten minutes. Base had executed 2,681 passing tests, 277 skips and one xfail;
   this was incomplete, not a clean suite result. SIGINT was caught inside a core
   test in the positive head, so that process required SIGTERM (exit 143); any
   resulting test failure is interruption evidence, not an upstream defect.
   These attempts and their partial coverage are excluded from adjudication.
   Before any Rio execution, froze the final test environment:
   `PYTEST_ADDOPTS='--ignore=tests/pydantic_core --ignore=tests/benchmarks'`.
   This selects the Pydantic Python suite, including docs/functional tests, while
   excluding the separate core workspace tests and performance benchmarks. Both
   selected PRs change only Pydantic source/tests. No changed source is excluded
   from instrumentation. Coverage conclusions are limited to this declared suite.
   Final oracle reruns retain the full dependency plan and all tool/profile pins.

The focused negative-control reproduction additionally passed all nine
`tests/test_plugin_loader.py` tests at base and head. Its coverage executes every
changed executable loader line (6, 40–48); the sole unexecuted loader line 32 is
unchanged. Evidence is retained in `negative-base-setup02` and
`negative-head-setup02` (`plugin-commands.json`, `plugin-tests.stdout.log`, and
`plugin-coverage.json`); normalized comparison is in
`independent-static-and-plugin-summary.json`.

## Independent source assessment

For #14213, `entry_points(group='pydantic')` is supported by the repository's
Python >=3.10 requirement. The refactor retains value-based deduplication,
name-based disabling, warning behavior and the `finally` reset of the reentrancy
flag. The nine focused tests pass at both pinned revisions. Ruff reports no
findings in the source package or changed loader tests. Native Pyright introduces
no diagnostics; the package-only supplemental runs are clean. No credential or
manifest/lockfile change is present in the pinned diff. The final coverage scope
and test results, rather than zero Rio output alone, support the clean-change
assessment.

All four pinned revisions share uv.lock SHA-256
`c03e0e30ac20ef8285ecbd0c8e55a8ef1d1914160f4ba427c927dc0581886331`.
Locked tools: Pyright 1.1.411, mypy 2.3.0, Ruff 0.17.3, pytest 9.1.1,
coverage.py 7.13.5. The Pyright update notice was retained; no tool was upgraded.
OS/kernel information is in `environment.json`; the host does not expose a
container image identifier, so none is claimed.

## Final independent oracle results

`pydantic-evidence/final-oracle-summary.json` captures the successful final scope:

| Control | Base tests | Head tests | pytest process wall (base/head) |
| --- | --- | --- | --- |
| #14199 | 6,560 passed, 247 skipped, 28 xfailed | same | 249,290 / 244,963 ms |
| #14213 | 10,936 passed, 247 skipped, 28 xfailed | same | 278,084 / 279,340 ms |

Both complete pytest invocations exit 0. Native Pyright exits 1 at base/head with
12 identical pre-existing `reportArgumentType` diagnostics in
`tests/test_pipeline.py` (lines 109, 137, 164, 235, 300, 449, 455 twice, 558, 565,
572, 579). Ruff exits 0, `[]`, on both sides. Supplemental package-only Pyright
exits 0. Exact commands/output/versions are retained, including stderr notices.

At #14199 base the new contextlib module does not exist. At the introducing head
coverage records 49 executable lines: 35 executed, 14 missing, none excluded.
Missing lines are 30, 38, 39, 41, 47, 52, 60, 61, 62, 63, 68, 71, 72, 74.
`positive-oracle-summary.json` retains the executed/missing/branch data. This
establishes the preregistered uncovered-lines mechanism under the final scope.
The subsequent #14202 patch adds exclusions to these unreachable/error paths;
it was not reviewed as the introducing change.

For #14213 the complete selected suite also executes every changed executable
loader line. Line 32 remains unexecuted but unchanged and is not a miss.
`final-oracle-summary.json` retains both loader coverage maps. Saved GitHub
check-run summaries are supplemental provenance only, not an oracle substitute.

## Rio setup failures and workarounds

Both `pydantic-14199-attempt01` and `pydantic-14213-attempt01` finished with runner
exit 1 and `baseline_classification_ran=false`. No typecheck/lint base entry ran;
head typecheck, lint and coverage were skipped as `dependency_mismatch`:
`uv.lock: missing aiohappyeyeballs at aiohappyeyeballs; reinstall dependencies`.
Secret scanning passed; dependency auditing skipped offline. Both reports emit
zero top-level findings/risks. No finding IDs apply to this check-level failure.
Neither attempt is scored or has a normalized record.

The requested locked group installs succeeded and `aiohappyeyeballs` belongs to
additional, unrequested groups. Rio's `dependencies/installation.rs` derives
selected groups by unioning all group flags of any installed dependency. Shared
packages/aggregate `all` group membership can therefore select groups that uv
was not asked to install. Reproduction: either attempt's unmodified install plan
and pinned PR, then `rio review` as recorded in commands.json. This is an observed
partial-uv-install compatibility defect, not a false-positive finding.

A premature retry in `pydantic-14199/` was interrupted before Rio ran when the
actual group mismatch was inspected. Its ledger/trace and the interruption log
are preserved; no report, baseline, finding or score is claimed. The corrected
plan is `install-plan-all-groups.json`: `uv sync --locked --python 3.12.12
--all-groups --all-packages --all-extras`.

The corrected plan also removes the exact hash-checked, unused
`a1_coverage.pth` conditional startup hook from the installed venv. Its original
content is saved as `a1-coverage.pth.txt`; both activating environment variables
are unset (`coverage-startup-environment.json`). Tests explicitly run under
`coverage run`, so instrumentation does not rely on this hook. Source inspection
shows Rio cannot verify executable .pth hooks other than its editable-finder
allowance. This is a preventive compatibility workaround, **not** an observed
.pth-rejection verdict: the earlier missing-dependency check fired first.
No tracked project/lockfile or Rio code is modified and dependency trust stays
false. Independent oracles are being rerun in fresh evidence directories after
this all-groups setup change, with identical source/tool pins and test scope.

The all-groups independent reruns also pass on both revisions of each PR, with
unchanged counts and the same 14 uncovered contextlib lines. Their authoritative
final evidence is `all-groups-oracle-summary.json`, `*-all-groups/commands.json`,
`07-stdout.log` (native Pyright), `08-stdout.log` (Ruff), `09-stdout.log` (pytest),
and archived `coverage.json.gz`. Install/hook setup is in commands 0 and 1;
tracked-file checks are in command 11. Previous oracle results remain as history.

Observed exit-status inconsistency: both initial reports have `status:
incomplete` while Rio exits 0. Their resolved profiles explicitly contain
`fail_on.incomplete: true`. The runner exits 1 because classification did not
run. Reproduction is each initial commands.json's final `rio review` argv;
report.json, resolved-profile.txt, and review_exit_code=0 preserve the discrepancy.
This is a check/CLI status observation, with no finding ID; it is not a scored
finding or a clean change result.

An interrupted negative retry used disk-backed `--temp-root /tmp` while keeping
build/test scratch on tmpfs; the positive retry used tmpfs for both. This was intended to avoid
exhausting shared /dev/shm while concurrent evaluations are active. Installation,
source, tool, profile, and test-selection pins were identical. These timings are
not a controlled performance benchmark. Completed oracle scratch clones were
removed after their outputs and full coverage data were archived. The archive
manifest records original paths, SHA-256s, sizes and gzip artifact mappings.

Harness command-capture limitation: unmodified runner.py logs its direct Rio
invocation but omits child typechecker/linter/coverage argv. A strace
`execve,chdir` observer captures those without wrapping tools or changing binaries.
Post-run `observed_child_invocations` and `runtime_environment_overrides` are
explicitly annotated additions to commands.json; the original direct command
ledger is retained. The extraction script and exact launch script are archived as
text in `pydantic-evidence/`. Trace archives identify the source line for each
observed tool command.

Exit-status interpretation after source inspection: `CompiledFailOn::is_incomplete`
counts skipped checks only when their kinds appear in `required_checks`; the
resolved profile has `required_checks: []`. That explains exit 0 despite an
incomplete report. Treat this as a default-policy/UX caveat requiring inspection
of check results, **not** a demonstrated failure of the implemented exit policy.
The earlier factual status/exit observations remain valid. The harness's stricter
baseline eligibility gate is what prevents a false clean score.


## Noneditable environment correction and independent confirmation

The next attempted install plan was
`pydantic-evidence/install-plan-noneditable-root.json`:
`uv sync --locked --python 3.12.12 --all-groups --all-packages --all-extras
--no-editable-package pydantic`, followed by the hash-checked removal of the
unused conditional coverage startup hook described above. Prepend relative
`.venv/bin` to PATH (then the Cargo bin directory). The launch script and external
runtime overrides are retained; neither Rio nor the harness was edited.

All four noneditable independent oracles finished successfully before the
corresponding final Rio review began. See `noneditable-oracle-summary.json` and
each `*-noneditable/commands.json` for exact argv, environment, exit codes and
wall times. These confirmed that setup stage. Positive base/head: 6,560
passed, 247 skipped, 28 xfailed. Negative base/head: 10,936 passed, 247 skipped,
28 xfailed. Ruff is clean. Native Pyright has the same 12 baseline test-file
diagnostics on all four revisions; no new source diagnostics. The positive's
14 missing lines and the negative's fully covered changed executable loader
lines are unchanged. Archived full coverage and original hashes are listed in
`archive-manifest.json`. Completed oracle scratch checkouts were removed.

### Observed own-editable-root baseline refusal

`pydantic-14199-attempt03` installed all groups; head dependency verification
succeeded, but baseline classification failed with this exact reason:

```
baseline_failed: linked dependency .venv/lib/python3.12/site-packages/_editable_impl_pydantic.pth points at changed source : pydantic/_internal/_config.py; commit or stash the linked package's changes
```

This is the checkout's own editable package, installed by the repository's
normal `uv sync`, not an independently modified linked dependency. Reproduce
with attempt03's install plan, source pins, binary and review command in its
commands.json. The noneditable-root plan removes this link without changing
tracked source. The failed attempt is fully annotated for observation and has
no normalized record. Its two correct coverage risk IDs are
`118c18a4b17e4c34b05d5a4a882b58df6e4e1e888c7dca2e28da3d76c95d9001`
and `e7fa463a43044b607c2f933410131203ec164611cc22c7828e682002fefafe89`.

### Observed Pyright interpreter binding problem

Attempt03 runs the venv's Pyright executable, but its Node host resolves global
Python when `.venv/bin` is absent from PATH. The independent
`pyright-interpreter-probe/commands.json` repeats the same direct venv Pyright
command against a snapshot with a linked venv: global PATH yields 291 errors;
project PATH yields the expected 12. Every Rio typecheck occurrence in attempt03
matches the global-PATH output by path, line, rule and exact message. Of its 177
typecheck findings, 166 disappear with project PATH and are environment-failure;
11 survive and exactly match independent baseline diagnostics, so are
pre-existing-shown. No mixed-cause grouping was found. The full finding-ID list
and evidence reasons are in attempt03/verdicts.json. Example environment finding:
`002bdc60607c92db3519cc6ac72c3a50567486a2f4cb93d245b0df443745bb14`
(`pydantic/_internal/_mock_val_ser.py:6`, unresolved `pydantic_core`). This is an
observed environment-binding limitation, not 166 product false positives.

The disk-backed `pydantic-14213/` retry was interrupted during installation
before Rio ran after the editable-root issue was diagnosed. Its ledger has a
post-run interruption annotation and `aborted-negative-retry.log` preserves the
traceback. The Bash EOF was an evaluator launch-script rewrite during an active
shell, not a Rio crash. Both interrupted directories remain unscored.


### Doctor/review planning discrepancy

All completed doctor.json captures report a blocking problem:
`cannot parse tests/typechecking/uv.lock: uv.lock has no package entries`.
The unchanged nested lock contains only version/revision/requires-python
metadata; its exact content and adjacent config are archived as
`tests-typechecking-uv.lock.txt` and `tests-typechecking-pyproject.toml.txt`.
Despite doctor exiting 1 with plan=null, `rio review` proceeds to applicable root
checks. Reproduction: run either completed directory's exact doctor argv at its
pinned head. This is a check-level planning/UX observation, with no finding ID;
it is not a false-positive credential/type finding or a blanket clean result.

The unmodified evaluation harness unit suite passes: 19 tests in 5.709 seconds,
output saved in `pydantic-evidence/harness-tests.log`. No harness, Rust, or other
product source was edited.


### Noneditable local directory still misclassified as linked source

`pydantic-14199-attempt04` and `pydantic-14213-attempt03` completed but again have
`baseline_classification_ran=false`. Pyright's interpreter binding is fixed:
11 top-level grouped findings represent the 12 independently reproduced baseline
test diagnostics; no environment-induced type findings remain. The positive
also repeats the two independently correct coverage findings listed above.
Every finding is annotated; neither failed-baseline run has a normalized record.
The footer now says `linked dependency pydantic points at changed source` for
`pydantic/_internal/_config.py` (positive) or `pydantic/plugin/_loader.py`
(negative), even though installation is explicitly noneditable. Source inspection
confirms `installation.rs` treats any `file:` direct_url whose target is a
directory as linked source without testing the `editable` flag. Exact commands,
versions, source pins and report footers reproduce this observation.

### Wheel-file installation workaround

The final workaround is `pydantic-evidence/install-plan-wheel-file.json`.
It first performs the same locked all-groups/all-packages/all-extras noneditable
uv sync. A setup command then runs `uv build --offline --wheel` for the own
Pydantic package and `uv pip install --offline --no-deps --reinstall` from that
wheel file. It records the wheel SHA-256 and **asserts that every installed
Pydantic package file is byte-identical before and after the reinstall**.
Third-party package versions and code remain unchanged. The resulting standard
installer provenance is a wheel-file URL, so Rio no longer sees a directory
link. No provenance JSON is manually removed/edited, no dependencies are trusted,
and no tracked source, lockfile, Rio or harness code is altered.

The first helper attempt (`*-wheel/`) failed after locked sync because the setup
snippet omitted `import sys`. This is an evaluator helper error, not a Rio crash;
all outputs are retained. The corrected independent evidence uses
`*-wheel-final/`. The conditional coverage startup-hook removal is idempotent,
with its original hash asserted whenever present; the corrected reruns report
it was already removed by the previous setup attempt. Fresh runner installations
still contain and hash-check/remove it. These helper stages do not receive scores.

A separate **unscored** `baseline-wheel-probe` disables coverage only to verify
baseline compatibility cheaply before another full runner invocation. Its
profile, command, raw report and stderr are retained. It is not a cohort record
and does not replace either required full-coverage control run.


The wheel-file baseline probe completed with `baseline_classification_ran=true`:
head/base lint passed and head/base Pyright returned findings, all four with
`dependency_state=verified`. Coverage was intentionally disabled only in that
probe; its environment is therefore not eligible for scoring. The full-control
profile keeps coverage enabled. `baseline-wheel-probe/environment.json` contains
the methodology-derived classification evidence.

Final independent wheel-file oracle outputs retain the same source/tool pins,
the same 12 baseline-only native Pyright diagnostics, and clean Ruff output.
The positive base/head suites each pass 6,560 tests (247 skipped, 28 xfailed),
with the same 14 unexecuted, non-excluded lines in the added contextlib module.
The successful helper's stdout records package-content equality and wheel hashes;
`wheel-oracle-summary.json` is the authoritative final summary. Earlier evidence
and all failed attempts remain available as setup history.


## Authoritative independent evidence for full runner attempts

Final plan: `pydantic-evidence/install-plan-wheel-file.json`; final independent
summary: `pydantic-evidence/wheel-oracle-summary.json`. All four wheel-file
oracles finished before their corresponding full runner retry. Each has a
successful tracked-file cleanliness check and identical 12 pre-existing native
Pyright diagnostics. All Ruff checks return an empty JSON list. The negative
base/head suites each pass 10,936 tests (247 skipped, 28 xfailed), and all changed
executable loader lines 6 and 40–48 execute. Missing loader line 32 is unchanged.
Positive missing lines remain 30,38,39,41,47,52,60–63,68,71–72,74, with no
coverage exclusions in the introducing file. Full coverage JSON is archived.

| Final independent oracle | pytest wall ms | Pyright wall ms | Setup sync wall ms |
| --- | ---: | ---: | ---: |
| positive-base | 133027 | 29586 | 65 |
| positive-head | 135059 | 29185 | 65 |
| negative-base | 164182 | 31013 | 65 |
| negative-head | 163141 | 29748 | 65 |

Setup sync times in this last table can be warm because the immediately prior
helper failed only after its locked sync. Both those earlier syncs and the
corrected syncs are retained; these are not performance-benchmark measurements.
The recorded final setup command reinstalls the own package from its matching
wheel and asserts package content equality. Neither control changes uv.lock;
its SHA-256 remains
`c03e0e30ac20ef8285ecbd0c8e55a8ef1d1914160f4ba427c927dc0581886331`.


## Completed eligible records

### PR 14199: real-pr

Record: `pydantic-14199-attempt05/record.json`; raw report and verdicts are adjacent.
Baseline classification ran: **true**, environment eligible: **true**.
Raw verdict counts: true-positive=2, false-positive=0, pre-existing-shown=11, environment-failure=0, out-of-scope=0.
Distinct causes: true-positive=1, false-positive=0, pre-existing-shown=3, environment-failure=0, out-of-scope=0.
Expected bugs: 1/1 detected, 0 missed; deterministic misses: 0.
Methodology usefulness: `useful`. Rio wall time: 249863 ms.

Exact observed Rio typecheck executable/argv (same args at head/base):

```
/dev/shm/rio-pydantic/tmp/rio-eval-m16v82ac/head/./.venv/bin/pyright --outputjson
```

Both disposable working directories and trace source lines are in
`commands.json: observed_child_invocations`. No mypy invocation ran; Pyright
uses its native configured `pydantic` plus `tests/test_pipeline.py` scope, with
no positional `.` target. Both base and head produce exactly 12 diagnostics,
all in that explicitly configured test file. `typecheck-scope.json` saves the
include/exclude/strict configuration; source configs are also archived.

### PR 14213: none

Record: `pydantic-14213-attempt04/record.json`; raw report and verdicts are adjacent.
Baseline classification ran: **true**, environment eligible: **true**.
Raw verdict counts: true-positive=0, false-positive=0, pre-existing-shown=11, environment-failure=0, out-of-scope=0.
Distinct causes: true-positive=0, false-positive=0, pre-existing-shown=3, environment-failure=0, out-of-scope=0.
Expected bugs: 0/0 detected, 0 missed; deterministic misses: 0.
Methodology usefulness: `not-useful`. Rio wall time: 288125 ms.

Exact observed Rio typecheck executable/argv (same args at head/base):

```
/dev/shm/rio-pydantic/tmp/rio-eval-diul7ije/head/./.venv/bin/pyright --outputjson
```

Both disposable working directories and trace source lines are in
`commands.json: observed_child_invocations`. No mypy invocation ran; Pyright
uses its native configured `pydantic` plus `tests/test_pipeline.py` scope, with
no positional `.` target. Both base and head produce exactly 12 diagnostics,
all in that explicitly configured test file. `typecheck-scope.json` saves the
include/exclude/strict configuration; source configs are also archived.

The positive's two findings partition one preregistered context-manager coverage
gap, so they share one documented template/file-set root cause. Their union
exactly equals the 14 independent missing lines. Expected finding IDs:
`118c18a4b17e4c34b05d5a4a882b58df6e4e1e888c7dca2e28da3d76c95d9001`
and `e7fa463a43044b607c2f933410131203ec164611cc22c7828e682002fefafe89`.

The negative is independently clean **for the change**. The 11 displayed
pre-existing findings represent 12 test diagnostics and three default-normalized
message causes. They make this report `not-useful` under the methodology's
clean-report criterion, despite correct classification and no false positives.
All finding IDs and occurrence-level evidence reasons are retained in each
record/verdicts file. This unwanted existing-diagnostic display is a review-noise
observation, not an introduced defect or a wrong `.` target.

Read-only completed checker artifacts were copied before automatic runner
cleanup: positive head/base lint/typecheck and head coverage, negative head/base
lint/typecheck. Capture manifests give original paths and hashes. The negative
coverage cache was removed before the supplemental copy; its final report still
records successful coverage, and full independent base/head coverage is archived.
No claim depends on a nonexistent supplemental cache copy.

Both record builders and `python3 eval/evaluate.py validate` completed with exit
0. No failed/interrupted attempt has a record or score. Offline dependency audit
remains the predeclared capability limitation; these controls do not change
lockfiles and make no vulnerability-safety claim. The 19 evaluation harness tests
passed. All 26 archived independent coverage reports were decompressed and
checked against their saved original SHA-256 hashes.

## Complete runner attempt ledger and wall times

| Attempt | Runner wall seconds | Rio wall ms | Baseline classification | Scored record |
| --- | ---: | ---: | --- | --- |
| pydantic-14199 | 27.853 | None | False | no |
| pydantic-14199-attempt01 | 353.371 | 65073 | False | no |
| pydantic-14199-attempt03 | 592.834 | 283992 | False | no |
| pydantic-14199-attempt04 | 478.436 | 260759 | False | no |
| pydantic-14199-attempt05 | 467.254 | 249863 | True | yes |
| pydantic-14213 | 653.13 | None | False | no |
| pydantic-14213-attempt01 | 380.644 | 43891 | False | no |
| pydantic-14213-attempt03 | 518.769 | 308532 | False | no |
| pydantic-14213-attempt04 | 498.979 | 288125 | True | yes |

Detailed command durations, failures and class counts: `pydantic-evidence/attempt-ledger.json`.
These timings include shared-host contention and strace capture, and are not a
performance benchmark. Evaluation began approximately 02:16 UTC on 2026-11-05;
evidence finalization was 2026-11-05T03:47:36.425061+00:00.


## Rerun2 (binary f6e4f87e4c65)

Date: 2026-11-05. Reviewer: `sub-agent rerun2-pydantic (automated)`;
`verdict_source=automated`. Re-executed the same preregistered public PRs, full
base/head SHAs, install-plan bytes and profile bytes from the eligible attempts
14199-attempt05 and 14213-attempt04. `rio --version` matched
`rio 0.1.0 x86_64-unknown-linux-gnu f6e4f87e4c65` before each launch. No Rio
rebuild, `crates/` edit, or `eval/*.py` edit was made. Python 3.12.12 and uv
0.13.7 were checked before each launch; installed tools remain Pyright 1.1.411,
mypy 2.3.0, Ruff 0.17.3, pytest 9.1.1 and coverage.py 7.13.5. The exact
wheel-file reinstall/content-equality assertion and hash-checked unused startup
hook removal are retained. Relative `.venv/bin` stays first on PATH, both coverage
startup variables are unset, and the same scoped PYTEST_ADDOPTS/CONTEXT are used.
Full runtime overrides and binary/profile SHA-256s are in each commands.json.

Disposable sources/build scratch use `/dev/shm/rio-pydantic`; preflight showed
5.7 GiB free and the minimum observed during initial setup was approximately
1.2 GiB. Shared-host I/O stalls were substantial; a timestamped sample is in
`pydantic-rerun2-evidence/host-observation.json`. No performance claim follows
from these wall times. Installers may use network; Rio review remains offline.
Dependency auditing without a populated OSV cache remains the declared capability
limitation. Neither PR changes the lockfile; no vulnerability-safety claim is made.

The canonical case records are:

- Positive #14199: `pydantic-14199-rerun2-attempt2/record.json`.
- Independently clean negative #14213: `pydantic-14213-rerun2/record.json`.

| Attempt | Baseline classification | Dependency state | Eligible | TP | FP | Existing shown | Existing hidden | Environment | Out of scope | Runner s | Rio ms | Runner exit |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| pydantic-14199-rerun2 | yes | verified | yes | 2 | 0 | 0 | 11 | 0 | 0 | 2285.108 | 549833 | 1 |
| pydantic-14199-rerun2-attempt2 | yes | verified | yes | 2 | 0 | 0 | 11 | 0 | 0 | 817.007 | 323325 | 0 |
| pydantic-14213-rerun2 | yes | verified | yes | 0 | 0 | 0 | 11 | 0 | 0 | 841.62 | 428916 | 0 |

Counts above are raw top-level findings/risks after adjudication; nested check
copies are not counted again. Each positive has one true-positive root cause
(two coverage findings), three hidden pre-existing causes (11 findings), and
zero other causes. The negative has three hidden pre-existing causes and zero
other causes. All three records have baseline_ran=true and successful verified
head/base lint and typecheck pairs. Head coverage also passed with verified
dependencies. Both canonical runner ledgers have successful base/head installs
and no recorded failures. All three records are `useful` under current v2 rules;
the negative has an independent clean-change assessment, no visible unwanted
diagnostics and no deterministic misses. The two positive attempts represent
one case; this rerun contains two independent PR cases.

First positive attempt: base `uv sync` exceeded the default 1200-second harness
command limit, exit 124, recorded wall 1,295,391 ms; see
`pydantic-14199-rerun2/07-stderr.log` and commands.json command 7. Head sync
succeeded and Rio subsequently classified its baseline successfully using the
head installation. Runner exit 1 therefore did **not** imply absent baseline
classification in this attempt: its sole failure is the timed-out separate base
installation. This is setup/host contention, with no finding ID. It is preserved
with full verdicts and a validated report-derived eligible record, but is not the
canonical positive measurement. The retry changes only the harness command
timeout to 3600 seconds; the selected Rio profile still has the original
20-minute fast budget. Negative setup also uses --timeout 3600.

Comparison with previous attempts and independent evidence:

- Every top-level finding object is field-for-field identical to the previous
  raw report for its case, including IDs, messages, locations and raw states.
  No finding was added or removed. The hidden pre-existing count remains 11
  in **both** controls; all are native configured Pyright reportArgumentType
  diagnostics in unchanged tests/test_pipeline.py, representing 12 diagnostic
  occurrences. Captured head/base native outputs are checked against the prior
  independent wheel-file oracle by path/range/rule/exact message.
- The earlier notes, verdict labels and stored records called those diagnostics
  `pre-existing-shown` and called the negative `not-useful`. Those historical
  scoring claims contradict the original raw `pre-existing` states. Current
  METHODOLOGY.md and record-v2 correctly override such labels to
  `pre-existing-hidden`; this is an evaluation correction, not a change in Rio's
  findings or their visibility. Prior artifacts are preserved unchanged.
- Positive expectation `contextmanager-uncovered-error-paths` remains detected
  (1 expected bug detected, 0 missed). Matching true-positive finding IDs are
  `118c18a4b17e4c34b05d5a4a882b58df6e4e1e888c7dca2e28da3d76c95d9001`
  and `e7fa463a43044b607c2f933410131203ec164611cc22c7828e682002fefafe89`.
  Their union is precisely missing executable lines
  30,38,39,41,47,52,60,61,62,63,68,71,72,74 in the new contextlib module.
  Captured current coverage retains 49 instrumented, 35 executed, zero excluded
  lines; selected tests pass 6,560 / 247 skipped / 28 xfailed. The unchanged-SHA
  independent wheel-file base/head oracle remains the oracle, not a Rio output
  substituted for independent evidence.
- Negative #14213 has no expected positive bug and no deterministic or
  agent-layer miss established. The prior independent clean assessment is
  retained: entry-point compatibility and loader semantics inspected, source
  Ruff clean, native Pyright unchanged, nine focused loader tests passing, and
  every changed executable loader line (6,40-48) executed. Current coverage is
  compared with that evidence; unchanged missing loader line 32 is not a miss.

Remaining Rio defects / capability observations:

- No new incorrect finding, visible pre-existing finding, control miss or
  review-baseline defect was observed with the frozen workaround plan. Exact
  unchanged finding IDs and comparison assertions are in
  `pydantic-rerun2-evidence/comparison.json` and each verdicts.json.
- Mypy target-resolution changes are **not exercised** here: strace confirms
  Rio still invokes venv `pyright --outputjson` without positional `.` for both
  head and base. Secret scans pass on both unchanged credential-free diffs;
  this is not a credential positive-control claim. The executable-line
  diff-coverage control remains detected, with no negative-control coverage
  false alarm.
- Doctor/review planning discrepancy from the earlier notes no longer occurs
  for the selected change. Harness `rio doctor --format json` and supplemental
  `rio doctor --base FULL_BASE_SHA --format json` return 0, blocking_problems=[],
  with a plan for root checks and verified baseline planning in the explicit
  --base probe. Reproduce using each supplemental commands.json's argv/cwd and
  environment at that pinned head with the same installation.
- `rio doctor --all-roots --format json` also returns 0 and a non-null plan;
  it lists unrelated root skips rather than aborting the whole plan. In
  particular tests/typechecking's metadata-only uv.lock still yields per-check
  dependency_mismatch with exact hint `cannot parse tests/typechecking/uv.lock:
  uv.lock has no package entries; installed dependencies cannot be verified
  (set trust_installed_dependencies to run anyway)`. Other unrelated roots
  include missing tool/config/install skips. This is a planning/capability
  observation with no finding ID, not proof those roots' checks passed and
  not an eligibility failure for the selected-root review.
- Historical partial-group inference, own-editable/direct-directory baseline
  guards and executable startup-hook constraints are masked by the explicitly
  required unchanged install plan and were not independently retested. Their
  earlier repros remain in this notes file; no claim of resolution is made.
  Reports retain the declared offline audit skip and local no_endpoint/graph
  limitations. No new product defect is inferred from those expected notes.

Evidence: `pydantic-rerun2-evidence/{launch.py.txt,supplement.py.txt,compare.py.txt,
extract-trace.py.txt,adjudicate.py.txt,attempt-ledger.json,comparison.json}`;
per-attempt launch ledgers, compressed execve/chdir traces, and supplemental
doctor/config/diff/check-artifact manifests. Runtime/child evidence is an
explicit post-run addition to the unmodified harness command ledger. Artifact
capture is read-only and supplementary; the final raw reports establish outcomes.
Every finding has an evidence-backed verdict; all misses lists are complete
and empty. Positive expectations include matching finding IDs. All record
builders and validators pass; exact validation output is retained in
`pydantic-rerun2-evidence/validation.log`. The unmodified evaluation harness
suite passes all 30 tests (`harness-tests.log`). No source clone, venv, wheel or
build output is committed. Large raw exec logs are gzipped; no committed file
exceeds 5 MB. No push or PR was performed.

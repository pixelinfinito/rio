# pydantic-settings evaluation — b15dc8ff5001

Reviewer: `sub-agent eval-pydantic-settings (automated)`; verdict source:
`automated`. No human confirmation is claimed. Work began 2026-11-05 at
02:17 UTC. All reviewed changes are real public merged PRs, with original PR
heads pinned rather than squash-merge commits or later fixes. No mutation was
needed. No product code, `crates/`, or `eval/*.py` was changed; no binary was
rebuilt, no push was made, and no PR was opened.

Three eligible, completely adjudicated records were produced:

| PR | Role / control kind | Record | Baseline classification | TP | FP | Pre-existing-shown | Environment-failure | Out-of-scope | Expected detected / missed |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| [#708](https://github.com/pydantic/pydantic-settings/pull/708) | Positive / `real-pr` | [record](pydantic-settings-708/record.json) | Yes, verified typecheck and lint pairs | 1 | 0 | 0 | 0 | 0 | 1 / 0 |
| [#1097](https://github.com/pydantic/pydantic-settings/pull/1097) | Maintainer negative / `none` | [record](pydantic-settings-1097-attempt2/record.json) | Yes, verified typecheck and lint pairs | 0 | 1 | 0 | 0 | 0 | No expected bugs |
| [#1109](https://github.com/pydantic/pydantic-settings/pull/1109) | Regression and additional independently clean negative / `none` | [record](pydantic-settings-1109-attempt4/record.json) | Yes, verified typecheck and lint pairs | 0 | 1 | 0 | 0 | 0 | No expected bugs |

Counts above are both raw findings/risks and distinct per-PR causes. #708 has
one risk, zero defect findings; each negative has one defect finding with six
locations. The same false-positive cause recurs in both negative PRs, so there
is one globally unique FP cause, not two independent product defects. The
validated [summary](pydantic-settings-SUMMARY.json) contains only these three
eligible records. Four failed setup attempts are preserved and excluded, with
no `record.json` or scoring. This single-repository sample does not establish
release readiness.

## Regression comparison first

The historical evidence is `docs/evaluation/agent-python.json` and
`docs/evaluation/v0.1.md`, extracted into
[historical-regression.json](pydantic-settings-evidence/historical-regression.json).
“Visible” includes top-level `findings` and `risks`, once each. “Classified”
means any state other than `unclassified`; a secret occurrence can be labelled
pre-existing independently of successful typecheck/lint baseline execution.

| PR | Historical visible | Historical unclassified / classified | Historical baseline classification | New visible | New unclassified / classified | New baseline classification |
| --- | ---: | --- | --- | ---: | --- | --- |
| #1109 | 1,408 | 1,407 / 1 (pre-existing) | No; only head checks, trusted installation | 1 | 0 / 1 (pre-existing) | Yes |
| #1097 | 1,362 | 1,361 / 1 (pre-existing) | No; only head checks, trusted installation | 1 | 0 / 1 (pre-existing) | Yes |

Historical Rio invoked `mypy .`, checking tests outside the Makefile's
`mypy pydantic_settings` target. The new binary checks `pydantic_settings`, and
both final runs report no mypy diagnostics. Exact new commands are appended
below and retained in each eligible run's `observed/commands.json`. Historical
full nested argv is not available in the retained old record; do not infer its
flags. This comparison spans different binaries and repaired installation
setups; it is an observed regression check, not a timing or isolated causal
experiment.

## Pins, setup, and declared scope

The binary reports `rio 0.1.0 x86_64-unknown-linux-gnu b15dc8ff5001`.
SHA-256: `512d123450bb93a62f03dc74bbe5057e24abeac70f365acb418f02933904e3f2`.
Installed CPython 3.13.9 with `uv python install 3.13.9`; uv was already
0.13.7. Upstream CI requests supported Python minor versions, not an exact
patch or uv version; these exact evaluation choices are frozen in
[setup.json](pydantic-settings-evidence/setup.json). Tool versions and lockfile
hashes are in each oracle and runner ledger. #708 uses mypy 1.18.2 and Ruff
0.13.1; the regression PRs use their newer locked tools.

All final runs use [profile.yaml](pydantic-settings-evidence/profile.yaml),
extending `rio/base` with a 20-minute fast budget; profile SHA-256:
`64e6ce34ac0cf189c92e8aac8e336f4d83a91f6aa456126c420214d9976c1dde`.
Typecheck, enabled Ruff lint, secrets, and instrumented test coverage are
applicable. Network dependency auditing is explicitly excluded: Rio runs
offline, no populated advisory cache is claimed, and no dependency-safety or
audit-recall conclusion is made. Semantic/model steps are deferred because no
endpoint is configured. Installers and tests were not network isolated.

The successful install plan is
[install-plan-v3.json](pydantic-settings-evidence/install-plan-v3.json):
`uv sync --locked --all-groups --all-extras --no-install-project`, followed by
removal of the optional `a1_coverage.pth` startup hook if present. This changes
no locked versions or tracked files. Coverage is still invoked explicitly.
`trust_installed_dependencies` remains false, and Rio verifies dependencies at
both head and base. Each snapshot imports its own source without an editable
link to the original head checkout. The runner independently installs both
checkouts; their lockfiles match within each PR.

Final commands inherit `UV_PYTHON=3.13.9`,
`TMPDIR=/dev/shm/pydantic-settings-eval`, and
`UV_CACHE_DIR=/dev/shm/pydantic-settings-eval/uv-cache`. Fresh per-run Rio
config/cache directories and stripped inherited `RIO_*` keys appear in the
runner ledgers. This shared VM had severe disk write stalls: observed mypy
processes were in `D` state, waiting in `balance_dirty_pages`, and system I/O
pressure was high. Moving disposable checkouts and caches into memory avoided
that bottleneck. No shared machine kernel settings or other evaluators'
processes were changed.

## Independent oracles and selection

The independent [oracle.py](pydantic-settings-evidence/oracle.py) creates a
disposable checkout, installs each commit's locked dependencies, and records
the exact commands, outputs, status, tool versions, lockfile hash, and timing.
It runs `uv run --no-sync mypy pydantic_settings`, `uv run --no-sync ruff check`,
Ruff's format check, and `uv run --no-sync coverage run -m pytest`, followed by
coverage JSON/report generation. `--no-sync` preserves the preceding locked
installation. Coverage JSON is retained gzipped; tracked-file status is empty
at every completed oracle.

| PR | Oracle base / head directories under `pydantic-settings-evidence/` | mypy / Ruff / format at both | Full tests base → head | Changed library lines missing execution at head |
| --- | --- | --- | --- | --- |
| #708 | `708-base-attempt2`, `708-head-attempt2` | All exit 0 | 495 passed, 4 skipped → same | `providers/aws.py:66` |
| #1097 | `1097-base`, `1097-head` | All exit 0 | 1,278 passed, 5 skipped → 1,304 passed, 5 skipped | None |
| #1109 | `1109-base`, `1109-head` | All exit 0 | 1,365 passed, 5 skipped → 1,375 passed, 5 skipped | None |

The `*-independent-diff-coverage.json` files intersect zero-context Git diff
head line ranges with coverage.py's executed/missing lines, restricted to
changed library files. They establish instrumentation, not merely absence of
Rio output. The #1097 review inspected union alias unwrapping, scalar-value
preservation, and parent-field decoding metadata. #1109 inspects dictionary
recognition before descending into type arguments; all ten additional nested
container/wrapper/model-key regression cases pass. Both changes are clean in
the declared deterministic scope; exhaustive semantic correctness and
dependency safety are not claimed. #1097 is the required recent maintainer
negative (author `hramezani`), with substantive library changes.

Positive control #708 introduces a new AWS `version_id` request branch with
no test changes. At base, the AWS file has no missing statements. At the PR's
original head, coverage.py instruments but never executes line 66, and reports
missing branch 65→66. The independent
[coverage_gate.py](pydantic-settings-evidence/coverage_gate.py) checks the
retained coverage JSON for missing statements in that file: base exit 0,
head exit 1. This is a test gap, not a claimed semantic/runtime failure.
The later [#963](https://github.com/pydantic/pydantic-settings/pull/963)
“Reach 100% test coverage” adds `test_version_id`, supporting the provenance.

[positive-control-register.json](pydantic-settings-evidence/positive-control-register.json)
was written at 02:45:24 UTC, before any Rio review of #708; its expectation is
`aws-version-id-uncovered` / `uncovered-lines`. Original base and head are
`61e0b46eb96e2f67f390b0371c4297f2d6b24573` and
`7d60367d8cc83fb49fb7d93568ff4f10fea9a904`; lockfile SHA-256 is
`9fe62976be64c14874fcbadab63896828076ef7b44c22130d5c608b52006293d`.
The original PR patch is retained with SHA-256
`5c37f2c451be2de8c7228c4b229fd9731377334bfc30e9ef8772d35f7e4c1985`.
The register stays unchanged; the post-run matching ID is recorded separately
in [positive-control-result.json](pydantic-settings-evidence/positive-control-result.json)
and in final `verdicts.json`/`record.json`.

Candidates considered and rejected for this positive control:

- #1131: recent maintainer utility-copy PR, but no independently established
  introduced deterministic problem; historical noise is not a positive oracle.
- #1089 and follow-up #1097: a real semantic decoding regression, but semantic
  reproductions alone do not establish an in-scope type/lint/coverage issue.
- #982 and its earlier introducing history: fixes a Windows-target mypy error;
  no failing Linux-target package oracle was established for a recent
  introducing PR. The fix itself is not an introducing positive control.
- #971: fixes a python-dotenv requirement floor; that edit alone does not prove
  a newly vulnerable resolved version. An offline audit control also needs a
  populated advisory cache, which this cohort does not have.
- #931 and #950: enable additional Ruff rules and fix diagnostics; they do not
  establish violations of the previously enabled rules in an introducing PR.
- #878: later coverage tests suggest gaps in project-resolution caching, but
  #708 offered a smaller, unambiguous new executable line with no test changes.
- #963: used as follow-up provenance, not reviewed as the introducing change.

Search evidence includes Git history and the retained
`recent-prs.json.gz`, `pr-708.json`, and `pr-963-followup.json`. #708 was found
within the search window; no seeded fallback or live credential was used.

## Findings, product defects, and harness limitations

1. **Dummy credential false positive**, ID
   `f59b1964321361d6f49fa60104f8329ceb09f12e8748ffa4f82f26b48026e658`,
   rule `secret/connection-string`, in both final negative records. Six
   unchanged test inputs/assertions use `postgres://user:password@localhost/…`
   in `test_parsing_secret_field` and `test_parsing_secret_subclass_field`.
   These are deterministic fixtures with generic dummy values, not leaked
   credentials; the removal/rotation advice is incorrect. Base/head source
   excerpts with exact line numbers are retained in each
   `*-connection-fixtures.txt`. Rio correctly labels occurrences pre-existing,
   but that does not make the credential claim true. Reproduction: run either
   final pinned PR command with the final install plan/profile. Neither
   negative report earns usefulness because of this FP. #708 does not change
   that test file and emits no credential alert.
2. **Executable coverage startup hook blocks all dependency-bound checks.**
   The standard all-groups/all-extras install produces `a1_coverage.pth`, which
   Rio cannot verify. #1109 attempt 1 skips typecheck, lint, and coverage, and
   baseline never runs. No type/lint finding ID exists for these skips; the
   unrelated credential ID above is still emitted. The hook's exact contents
   are printed in the repaired install logs. Removing this optional automatic
   coverage-startup hook preserves explicit coverage execution. This is a
   compatibility/setup limitation, not a typecheck false positive.
3. **Editable self-install prevents source-change baseline classification.**
   #1109 attempt 3 passes head mypy/lint/coverage with verified dependencies,
   then rejects `_editable_impl_pydantic_settings.pth` as pointing at changed
   source `pydantic_settings/sources/providers/env.py` when preparing base.
   The report notes `baseline_failed: linked dependency ... points at changed
   source ...; commit or stash ...`, although the reviewed source is already
   committed. No diagnostic finding ID exists for the baseline failure.
   Reproduce with install-plan-v2 and the pinned #1109 pair. The final plan's
   `--no-install-project` avoids this blocker and preserves verified baseline
   classification. Separate base installation alone did not fix it.
4. **Nested command provenance missing from runner ledger.**
   Original `commands.json` records `rio review`, not the nested mypy/Ruff/test
   processes. No harness file was modified. Final invocations were run under
   `strace -f -e trace=execve -s 8192`; successful execve argv is extracted into
   `observed/commands.json`, with raw trace in `observed/execve.log.gz`.
   `extract_commands.py` is retained. An earlier read-only `/proc` observer
   missed short-lived commands; attempt 3 preserves that partial observation.
   Attaching strace to an existing process was denied by the machine's ptrace
   policy; launching the runner as a strace child succeeded. No secret-bearing
   environment values were traced. The original runner ledgers are unchanged.

The historical broad mypy target is fixed in the observed new runs. There were
no Rio crashes and no independently established deterministic misses. #708
produces TP ID
`9fef2a2d9e8b5202043d7425de33cae2f3aa38091bad992b3086e7ab3ed1c489`,
rule `coverage/untested_change`, at `providers/aws.py:66`. It is in top-level
`risks[]`. Its coverage check says `passed` and the CLI exits 0 because test
execution succeeded and `rio/base`'s failure gate selects `defect`, excluding
coverage's `risk` category. Counting only `findings[]` would miss this output;
both arrays were adjudicated. This behavior is documented here without
claiming an additional product bug.

## Attempt and wall-time ledger

All attempts are retained. The disk deadline failures below are environmental
observations, not product false positives. Full pin/eligibility/state metadata
is in [attempt-ledger.json](pydantic-settings-evidence/attempt-ledger.json).

| Directory | Runner wall seconds | Rio command wall seconds | Baseline classification | Disposition |
| --- | ---: | ---: | --- | --- |
| `pydantic-settings-1109` | 170.544 | 111.648 | No | Excluded: executable coverage .pth |
| `pydantic-settings-1109-attempt2` | 432.401 | 248.608 | No | Excluded: shared disk stalls / 4m timeout |
| `pydantic-settings-1109-attempt3` | 149.055 | 77.204 | No | Excluded: editable self-install mismatch |
| `pydantic-settings-1109-attempt4` | 187.934 | 139.391 | Yes | Final regression / clean negative |
| `pydantic-settings-1097` | 550.445 | 245.998 | No | Excluded: shared disk stalls / 4m timeout |
| `pydantic-settings-1097-attempt2` | 187.739 | 132.746 | Yes | Final maintainer negative |
| `pydantic-settings-708` | 110.684 | 54.802 | Yes | Final real positive |

Independent oracle total wall seconds: #1109 base 1292.384/head 1286.965;
#1097 base 319.672/head 127.081; #708 original disk attempts base 1184.322/head
1180.895, then memory attempts base 221.088/head 223.843. All original oracle
attempts eventually completed successfully and remain retained; the second
#708 pair supplied the completed preregistration evidence sooner. These runs
overlap and execute on a busy shared VM; summing them is not elapsed evaluation
time and they are not controlled cold/warm performance measurements.

Final records and summary were built with `eval/evaluate.py record`/`aggregate`
and checked with `validate`. `validation.log` contains the final verification.
Only `eval/runs/**` artifacts and this note are committed. Disposable source,
virtual environments, and caches remain outside Git; all committed files are
below 5 MB. Raw JSON reports are small; larger coverage JSON and syscall logs
are gzip-compressed.


## Exact observed mypy commands

The following arrays are copied from each final run's `observed/commands.json`.
For each PR, Rio executes head first, then base; temporary paths identify
separate materialized tool trees. `--config-file` points at that tree's pinned
pyproject. These are actual successful execve calls, not reconstructed flags.
The extractor also joins strace unfinished/resumed execve calls.

### 1109-attempt4

```json
[
  [
    "/dev/shm/pydantic-settings-eval/rio-eval-e8dagj6_/head/./.venv/bin/mypy",
    "--output",
    "json",
    "--config-file",
    "/dev/shm/pydantic-settings-eval/rio-eval-e8dagj6_/cache/d1c8882c886b285a/runs/01M6MS2DV0DC9639FADZ3B63YF/tools/tool.tmp-2FpvNi/pyproject.toml",
    "pydantic_settings"
  ],
  [
    "/dev/shm/pydantic-settings-eval/rio-eval-e8dagj6_/head/./.venv/bin/mypy",
    "--output",
    "json",
    "--config-file",
    "/dev/shm/pydantic-settings-eval/rio-eval-e8dagj6_/cache/d1c8882c886b285a/runs/01M6MS2DV0DC9639FADZ3B63YF/tools/tool.tmp-z7gNyn/pyproject.toml",
    "pydantic_settings"
  ]
]
```

### 1097-attempt2

```json
[
  [
    "/dev/shm/pydantic-settings-eval/rio-eval-z710x703/head/./.venv/bin/mypy",
    "--output",
    "json",
    "--config-file",
    "/dev/shm/pydantic-settings-eval/rio-eval-z710x703/cache/c52ea3bc2353d064/runs/01M6MS35EARPPKGPR2FMKJ85KN/tools/tool.tmp-wPa1zp/pyproject.toml",
    "pydantic_settings"
  ],
  [
    "/dev/shm/pydantic-settings-eval/rio-eval-z710x703/head/./.venv/bin/mypy",
    "--output",
    "json",
    "--config-file",
    "/dev/shm/pydantic-settings-eval/rio-eval-z710x703/cache/c52ea3bc2353d064/runs/01M6MS35EARPPKGPR2FMKJ85KN/tools/tool.tmp-Cj6a4B/pyproject.toml",
    "pydantic_settings"
  ]
]
```

### 708

```json
[
  [
    "/dev/shm/pydantic-settings-eval/rio-eval-3u5jk8zv/head/./.venv/bin/mypy",
    "--output",
    "json",
    "--config-file",
    "/dev/shm/pydantic-settings-eval/rio-eval-3u5jk8zv/cache/1b9ac648fd6992f7/runs/01M6MSK3FNGQWGVJGYAX7H5Z5X/tools/tool.tmp-xyGJ74/pyproject.toml",
    "pydantic_settings"
  ],
  [
    "/dev/shm/pydantic-settings-eval/rio-eval-3u5jk8zv/head/./.venv/bin/mypy",
    "--output",
    "json",
    "--config-file",
    "/dev/shm/pydantic-settings-eval/rio-eval-3u5jk8zv/cache/1b9ac648fd6992f7/runs/01M6MSK3FNGQWGVJGYAX7H5Z5X/tools/tool.tmp-CowTdh/pyproject.toml",
    "pydantic_settings"
  ]
]
```

## Reproduce final runs

From this worktree, after installing Python/uv, export the values in setup.json
and run the following, supplying each original pinned base/head from its
commands.json and a fresh output directory:

```sh
python3 eval/runner.py --repository pydantic/pydantic-settings --pr NUMBER \
  --base FULL_BASE_SHA --head FULL_HEAD_SHA --languages python \
  --rio /home/ubuntu/rio/target/release/rio \
  --install-plan eval/runs/pydantic-settings-evidence/install-plan-v3.json \
  --profile eval/runs/pydantic-settings-evidence/profile.yaml \
  --timeout 1800 --out "$PWD/eval/runs/pydantic-settings-NUMBER-reproduction"
```

Reproduce independent checks with `oracle.py --source CLONE --sha SHA --out
NEW_EVIDENCE_DIRECTORY`; clone/fetch the public PR heads first. The retained
coverage gate consumes the resulting `coverage.json.gz`.

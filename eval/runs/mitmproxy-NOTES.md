# mitmproxy/mitmproxy fallback evaluation

Reviewer: sub-agent eval-pydantic-ai (automated); verdict_source automated.

Fallback from pydantic/pydantic-ai after approximately 45 minutes of setup/repair; see pydantic-ai-NOTES.md for retained attempts and the blocking uv universal-lock verification defect. Textualize/textual was inspected but uses poetry.lock rather than the requested uv.lock. Marimo was inspected but not selected; mitmproxy has a current uv.lock, a simpler environment, and maintainer source PRs.

Negative: maintainer mhils's merged PR #8473 (2026-10-05), base 3368a0a06ae6195aad817a1ece1aaeb6fe0353a1, head be9f49d248a0142ae30f8bd412ad45060d0ee25e. Changes certificate generation to omit empty SAN extensions. Independently check configured mypy, repository Ruff, and test/mitmproxy/test_certs.py with coverage at both pins before Rio.

Positive: seeded mutation on merged parent PR #8521's base 6debf65b612abc726fe9cabe5c2a1ebb1cb36df4. Review exactly one inert unused import, not the parent PR's actual change. Register the patch, synthetic head, seed and oracle outcomes before Rio. Seed fallback follows the earlier approximately 30-minute unsuccessful search for an in-scope real introducing PR, documented in pydantic-ai-NOTES.md.

Effective Python pin: managed CPython 3.14.10, satisfying upstream .python-version `3.14`. uv launcher 0.13.7. Initial Python 3.13.9 exploration logs are retained but not used as the frozen control oracle. uv's warning about .python-version led to reinstalling the environment and rerunning independent checks on 3.14.10 before Rio. `oracle-driver.txt` records exact checks and command ledgers.

Install: uv sync --locked --python 3.14.10 --all-groups --all-extras. Installed executable bootstrap .pth files a1_coverage.pth and distutils-precedence.pth are removed only for Rio's verified static environment; independent instrumented coverage runs precede removal. No package version or tracked source/lockfile changes are made by setup.

Profile: full built-in base checks (baseline typecheck/lint, secrets, coverage, dependencies), 20m budget. Rio is offline; an explicitly skipped offline dependency audit is a capability limitation and not proof of safety. Coverage uses PYTEST_ADDOPTS to select the relevant committed test module, recorded in environment provenance. This is a targeted coverage cohort, not a full repository test claim.

Disposable clones, uv cache and Rio caches use the private tmpfs described in the pydantic notes. No external messages, PR creation, pushes or source changes in the evaluation harness or crates.

Final results and wall times follow below.

## Completed controls

| Record | Kind | Baseline classification | TP | FP | Pre-existing-shown | Environment findings | Out-of-scope | Expected detected / missed |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| [8473 attempt2](mitmproxy-8473-attempt2/record.json) | none (negative) | yes, verified base/head | 0 | 1 | 0 | 0 | 0 | 0 / 0 |
| [8521 seeded](mitmproxy-8521-seeded/record.json) | seeded-mutation | yes, verified base/head | 1 | 0 | 0 | 0 | 0 | 1 / 0 |
| [8473 attempt1](mitmproxy-8473/record.json) | none (negative) | no, excluded | 0 | 1 | 0 | 0 | 0 | 0 / 0 |

Counts are raw findings and distinct causes (identical here). Only the first two records are eligible. Positive is useful; negative is not-useful due to the false positive. This small correlated sample cannot establish a release decision. There are no observed in-scope misses in eligible records. Other observed setup skips are environment evidence, not invented findings.

Independent oracle before Rio used `uv run --no-sync mypy`, `uv run --no-sync ruff check`, and `uv run --no-sync coverage run --source=mitmproxy -m pytest -q TEST_MODULE` at both pins. Exact commands, statuses and versions are in mitmproxy-evidence/*-py314-commands.json and oracle-driver.txt. Mypy 1.20.2 and Ruff 0.16.9 pass the negative base/head; 37 certificate tests pass both. Positive base Ruff passes and seeded head fails **exactly F401**, while mypy and 19 multidict tests pass both. Coverage.py 7.13.2 instruments both changed modules; independent-diff-coverage.json confirms certificate executable added lines 356/357/359 and seed import line 1 executed, no missing added executable lines. Test scope is targeted; no full-suite or online audit claim.

Positive preregistration (03:06:46 UTC) precedes Rio run (03:07:16 UTC). Synthetic head 986ba556378985647957301e28069e46ee6074ec is base plus exactly 8521-seed.patch; it is **not public PR #8521's actual head**. Seed 20261105-unused-itertools-v1, patch/profile hashes and parent PR are in mitmproxy-evidence/positive-control-register.json. Expected unused-itertools-import matches finding **86aa2b2d6d676dda8042c04d8cc9338614f0336ad15f94a7c7c704dcf6c08820**, `lint/ruff/F401`, multidict.py:1. It is a true positive backed by the independent oracle, not merely an inference from Rio output.

## Setup repair, workspace handling, defects

The first #8473 runner attempt exits 1 despite successful head checks: Rio cannot materialize the base when the reviewed project is installed editable, reporting `linked dependency mitmproxy points at changed source : mitmproxy/certs.py; commit or stash the linked package's changes`. The checkout is clean; the difference is the reviewed PR. This is the same baseline compatibility limitation observed in the pydantic workspace. It has no finding ID. Initial failed attempt is retained and excluded.

Repair: install **locked dependencies only**, adding `--no-install-project`, retain source-root execution of checks/tests, remove the two known installed executable .pth bootstrap files after independent coverage runs. Exact corrected plan: mitmproxy-evidence/install-plan-dependencies-only.json. Additional independent source-only mypy and pytest proof remains in mitmproxy-8473-source-only-* logs; removing editable project metadata does not prevent source checks. Both final records verify base/head with no trust override or source/lock edits. The installed project itself is not required because all invocations run from the checkout root. Full built-in profile checks remain enabled; offline dependency audit is a declared limitation.

Rio schedules only Python root `.` (changed), no dependent roots. It selects mypy with explicit root pyproject targets `mitmproxy`, `examples/addons`, `release/*.py`. No inferred positional targets are needed. commands.json evaluation_annotations records outcomes, selected tool, config targets and an inferred template argv. Original runner entries are preserved; underlying tool argv is not captured by the harness. Config excerpts are in mitmproxy-evidence/typecheck-config-evidence.json.

**Secret scanner false positive:** finding **49a4254e92e57f4a7a9a3cf017c64d89abdba6c11b56ebbf413bc3475c805562**, `secret/high-entropy`, mitmproxy/certs.py head:723/base:721. Source `privatekey=self.default_privatekey,` is a Python attribute reference. Independent AST value type is Attribute, not a literal credential; see secret-false-positive-evidence.json. Rio reports `Potential high-entropy credential: self[REDACTED]` and recommends rotation. It correctly marks the occurrence pre-existing, but the claim is incorrect, so both attempt records classify it false-positive rather than pre-existing-shown. No committed live secret was sought or used. No crash observed.

Reproduce final negative with the pinned SHAs, plan/profile and runtime-overrides.json:

```sh
PYTEST_ADDOPTS=test/mitmproxy/test_certs.py python3 eval/runner.py \
  --repository mitmproxy/mitmproxy --pr 8473 --languages python \
  --base 3368a0a06ae6195aad817a1ece1aaeb6fe0353a1 \
  --head be9f49d248a0142ae30f8bd412ad45060d0ee25e \
  --rio /home/ubuntu/rio/target/release/rio \
  --install-plan eval/runs/mitmproxy-evidence/install-plan-dependencies-only.json \
  --profile eval/runs/mitmproxy-evidence/profile.yaml --out NEW_DIRECTORY
```

For positive, restore the registered one-line patch as a synthetic commit on its base, fetch/advertise that commit to the runner, then use PR 8521 with the registered base/synthetic head and PYTEST_ADDOPTS=test/mitmproxy/coretypes/test_multidict.py. The original cache's exact synthetic SHA is recorded; reconstruction may change commit metadata and therefore SHA. For editable-baseline reproduction use the original install-plan.json instead of dependencies-only. Every runner's exact invocation dependencies, stdout/stderr, binary SHA-256 and pinned profile are retained.

## Wall times and validation

| Attempt | Runner elapsed s | uv sync summed s | Rio review process s | Rio reported s |
| --- | ---: | ---: | ---: | ---: |
| 8473 first (excluded) | 40.624 | 4.679 | 28.056 | 26.668 |
| 8473 repaired | 43.359 | 0.434 | 37.016 | 35.667 |
| 8521 seeded | 40.988 | 0.431 | 35.113 | 33.682 |

Start/end timestamps are in attempt-times.json and each commands.json. Two final independent oracle ledgers take 68.752s total for the negative base/head, 41.853s for positive base/head (command sums; source operations and parallel runs excluded). These are warm tmpfs runs, not cold performance benchmarks. Setup/research elapsed time includes the documented earlier 45-minute pydantic investigation.

All five report-bearing attempts have fully adjudicated verdicts, normalized records and successful `eval/evaluate.py validate`. Two earlier clone failures have command evidence only. Required harness unit tests were also run; their result is recorded in validation.log. Files over 5 MB, disposable clones and virtual environments are excluded from the commit; large coverage JSON evidence is gzip-compressed. No code in crates/ or eval/*.py changed.

## Rerun2 (binary f6e4f87e4c65)

Date: 2026-11-05 UTC. Reviewer: `sub-agent rerun2-mitmproxy (automated)`;
verdict_source: `automated`. Verified the supplied release binary before execution:
`rio 0.1.0 x86_64-unknown-linux-gnu f6e4f87e4c65`, SHA-256
`3e28a47f9460af1ae2ad9572d065f4eb03314ee56cdc851c8f185d9bb57572c7`.
No rebuild and no changes to `crates/` or `eval/*.py`.

The cases retain their original PRs and exact commits:

- #8473: base `3368a0a06ae6195aad817a1ece1aaeb6fe0353a1`, head
  `be9f49d248a0142ae30f8bd412ad45060d0ee25e`.
- #8521 seeded: base `6debf65b612abc726fe9cabe5c2a1ebb1cb36df4`, synthetic head
  `986ba556378985647957301e28069e46ee6074ec`, seed
  `20261105-unused-itertools-v1`. The original synthetic commit still exists in
  the local Git cache; its diff matches the preregistered patch byte for byte
  (SHA-256 `1096dd5b71a2f66f6d872bf4593456baef7311432f3be9cb9d0c41b3fd576f4a`).
  [Saved commit object](mitmproxy-rerun2-evidence/seed-commit.txt) hashes back to
  the exact original synthetic SHA. This reviews only the unused import, not
  the public parent's actual head.

Both use managed CPython 3.14.10, uv 0.13.7, the byte-identical previous
`install-plan.json` and `profile.yaml` (profile SHA-256
`6676975243f9501c30ecc15792d0ba479e5b98545dae56042e09f911a7b7de07`). The
plan installs locked dependencies with `--no-install-project` and removes only
`a1_coverage.pth` and `distutils-precedence.pth`; there is no trust override.
`PYTEST_ADDOPTS` still selects `test/mitmproxy/test_certs.py` or
`test/mitmproxy/coretypes/test_multidict.py`. Independent oracle evidence is reused
at unchanged SHAs: [original oracle ledgers](mitmproxy-evidence/oracle-driver.txt)
and [executable changed-line coverage](mitmproxy-evidence/independent-diff-coverage.json).
Fresh Rio findings, check outcomes, states and control matches are adjudicated
again. Full source/root mypy and Ruff are in scope; coverage is targeted, not
full-suite coverage. Offline OSV audit is a declared capability limitation.
[Runtime provenance](mitmproxy-rerun2-evidence/runtime-overrides.json) and per-attempt
timing ledgers preserve the inherited environment and exact outer invocations.

The first two attempts (`mitmproxy-8473-rerun2` and `mitmproxy-8521-rerun2`)
ran concurrently on tmpfs after checking 5.6 GiB free. Other evaluations were
active on the same host. During the stall `/dev/shm` reached 94% usage (1.3 GiB
free); memory observations were 39 GiB total, 36 GiB used, 1.0 GiB free, 2.6 GiB
available, no swap. Both Rio processes were observed in `Dl` (uninterruptible I/O)
and had emitted only prepare/check progress. The evaluator sent SIGTERM to its
own Rio PIDs 949518/949521. Both installers had succeeded, but reports remained
zero bytes and no baseline classification evidence was available: baseline ran
is **not established**, classification **no**, dependency state **unavailable**,
eligible **no**. These are environmental interruptions, not evidence of a Rio
logic defect or missed control. No findings can be counted from absent reports.

The runner preserved `review_exit_code: -15` and failure text
`Expecting value: line 1 column 1 (char 0)`; it produced neither verdict skeleton
nor schema-valid report/record. No finding IDs or footer notes exist for these
attempts. This is the harness's generic empty-JSON error after an interrupted
review, not an adjudicable finding. Reproduction: run the corresponding argv and
environment in `8473-attempt-time.json` or `8521-attempt-time.json` under the
[rerun evidence directory](mitmproxy-rerun2-evidence), choose a fresh output
path, terminate Rio during checks, and inspect the empty report and final
`commands.json`. Resource pressure itself is not asserted reproducible.
[Interruption evidence](mitmproxy-rerun2-evidence/interrupted-attempts.json) preserves
the exact review commands, exit codes and limitations. Both original directories
are retained without inventing reports or verdicts.

The repair runs sequentially with disk-backed
`TMPDIR=/tmp/rio-rerun2-mitmproxy-disk`, otherwise identical pins, runtime,
install plan, profile and test scope. uv reports its hardlink-to-copy fallback
between the tmpfs package cache and disk checkout; this changes installation
cost, not resolved dependencies. [Retry driver](mitmproxy-rerun2-evidence/rerun-driver.txt)
and the `*-attempt2-time.json` files preserve the complete retry reproduction
(use fresh `--out` paths when repeating).

Final selected records:

| Case | Record | Baseline classification | Dependency state | TP | FP | Pre-existing shown | Pre-existing hidden | Environment findings | Out of scope | Controls detected / missed |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| #8473 negative | [record](mitmproxy-8473-rerun2-attempt2/record.json) | yes | verified | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 |
| #8521 seeded | [record](mitmproxy-8521-rerun2-attempt2/record.json) | yes | verified | 1 | 0 | 0 | 0 | 0 | 0 | 1 / 0 |

Both final cases have baseline ran **yes**, successful typecheck and lint pairs
for root `.`, and verified dependency states on every applicable pair. #8473
passes both checks on both pins. #8521 has head Ruff findings/base Ruff passed,
and mypy passed on both pins. Coverage passes with verified dependencies in both
cases. Tool versions remain mypy 1.20.2, Ruff 0.16.9 and Coverage.py 7.13.2.
Both reports are `incomplete` solely because the dependency audit is offline;
this explicit limitation does not block classification eligibility under the
methodology. Footer notes are exactly `Intent inference is deferred: no_endpoint`,
`Graph references use syntax and text; no language server was used`, and
`Offline applies to Rio; tool and test processes were not network-isolated`.

Raw state counts: #8473 has zero findings/risks in every state; #8521 has exactly
one `new` finding, zero `worsened`, `unclassified`, `pre-existing`, or `fixed`,
and zero risks. Raw finding/location counts and distinct cause counts coincide
(0 and 1 respectively). There are no deterministic or agent-layer misses recorded.
The negative has a reused independent clean assessment; both final records are
useful under methodology v2 (clean confirmation and actionable control).

Comparison with the previous runs:

- #8473: previous report had the hidden `pre-existing` alert
  `49a4254e92e57f4a7a9a3cf017c64d89abdba6c11b56ebbf413bc3475c805562`,
  `secret/high-entropy`, certs.py:723, with message
  `Potential high-entropy credential: self[REDACTED]`. It is **absent** now,
  not merely suppressed or hidden: the secrets check passes, its findings list
  and report suppressions are empty, and no secret finding appears at top level.
  The source is still the nonliteral `privatekey=self.default_privatekey`
  (independent AST `Attribute` evidence is unchanged). The historical notes/v1
  verdict labelled it FP; v2 treats its raw `pre-existing` state as
  `pre-existing-hidden` and excludes it from precision. The observed fix is
  removal of an incorrect raw diagnostic, not removal of a previously visible
  false positive under the current visibility rule. No new or wrong finding.
- #8521: expected `unused-itertools-import` remains detected as
  `86aa2b2d6d676dda8042c04d8cc9338614f0336ad15f94a7c7c704dcf6c08820`,
  `lint/ruff/F401`, `new`, multidict.py:1:8, message
  `` `itertools` imported but unused ``. Exactly the same finding ID, rule,
  location, message and state as before. No secret finding before or now, no
  new findings, and no coverage false alarm on the executed added import.

Remaining observed Rio diagnostic defects: **none in these two completed
cases**. The mypy target-resolution changes did not introduce a failure at these
explicit-config targets. Diff coverage passes and agrees with the reused
independent executable-line oracle: certs.py added executable lines 356/357/359
are covered; seeded multidict.py import line 1 is covered. These cases do not
establish behavior for inferred targets or uninstrumented changed files.
The offline audit skip remains `reason: offline`,
`hint: Dependency audit needs api.osv.dev`; it is not a vulnerability miss.
Rio child argv/cwd remains unavailable in the report/harness, as documented by
each `commands.json#/rio_checks`; independent oracle commands are not claimed
to be Rio subprocess traces. Initial resource interruptions and the generic
empty-report runner error are recorded above, with no invented finding IDs.

Wall times (seconds; warm caches, shared-host contention, not performance gates):

| Attempt | Outer runner elapsed | uv sync summed | Rio review process | Rio reported |
| --- | ---: | ---: | ---: | ---: |
| 8473 initial interrupted | 1312.742 | 2.716 | 961.400 | no report |
| 8473 disk retry | 1055.553 | 804.963 | 226.883 | 224.912 |
| 8521 initial interrupted | 1312.407 | 2.675 | 961.468 | no report |
| 8521 disk retry | 514.631 | 304.459 | 201.288 | 199.97 |

The two initial attempts overlap; successful retries run sequentially. The
previous #8473 repaired/#8521 seeded outer wall times were 43.359/40.988s and
Rio reported times 35.667/33.682s. Resource pressure, cross-filesystem dependency
copying and shared I/O make this rerun's elapsed times unsuitable for attributing
a binary performance regression. Exact per-command times and UTC timestamps
are retained in every attempt's commands ledger and the outer timing files.

`eval/evaluate.py record` and `validate` succeeded for both final records;
[validation log](mitmproxy-rerun2-evidence/validation.log). All 30 harness unit
tests passed ([test log](mitmproxy-rerun2-evidence/harness-tests.log)). Raw reports,
completed verdicts and normalized v2 records are preserved; the two interrupted
attempts have command/log evidence only because their reports are empty.
No new evidence file exceeds 5 MB; no clone, virtual environment or package cache
is committed. No push or PR.

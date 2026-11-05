# structlog evaluation — b15dc8ff5001

Reviewer: `sub-agent eval-structlog (automated)`; verdict source: `automated`. Work began approximately 2026-11-05 02:17 UTC. These are automated adjudications, not human confirmation. No build, upstream write, push, or PR creation. No edits to crates/ or existing eval/*.py.

## Result and scoring limitation

Three completed canonical cases, plus two retained failed installation attempts, have fully adjudicated schema-valid records. #811 is an independently clean negative control; #805 is an independently clean regression rerun. The positive control is an explicitly synthetic mutation on #811's public base. Exactly one expected type error was observed and detected, with no observed deterministic miss. Canonical finding verdict totals: **1 true-positive, 0 false-positive, 0 pre-existing-shown, 0 environment-failure findings, 0 out-of-scope**. There are no unadjudicated findings.

**Zero release-scored records.** The unchanged evaluator requires `dependency_state: verified` for both halves of every baseline pair. Rio now successfully executes trusted baseline pairs and the seed finding is explicitly `new`; the evaluator nonetheless reports `baseline_classification_ran: false`, `eligible: false`, and overall `environment-failure` for every case. Those fields are preserved exactly. Finding-level adjudication is not release eligibility. No precision, recall, usefulness, or release-readiness claim is made from these excluded records.

## Frozen setup and provenance

- Repository: `hynek/structlog`; language flag: `--languages python`; no supported lockfile. The user's explicit trusted-path instruction takes precedence over the older methodology's prohibition on trusted scoring. The unchanged evaluator still excludes trust, as described above.
- Binary: `/home/ubuntu/rio/target/release/rio`, verified `rio 0.1.0 x86_64-unknown-linux-gnu b15dc8ff5001`; SHA-256 in `structlog-setup/environment.json` and every commands.json. Never rebuilt.
- Profile: `structlog-setup/profile.yaml`; exact agent-third.json step shape, renamed `eval-structlog-trusted`, fast budget 300s instead of 90s. `rio/checks.with.trust_installed_dependencies: true`; baseline and all checks enabled. Input and resolved profile hashes are in every ledger. Input profile SHA-256: `ce27b33c524faa91315c411fe98f12276cdd542ac4dfa8bc4dd1115bfeb0a624`.
- Python 3.12.3. Pip-created venvs install every package with explicit `==` pins, then install the pinned checkout editable with `--no-deps --no-build-isolation`. Final plan: `structlog-setup/install-plan-v2.json`; complete direct/transitive pins: `requirements-v2.txt`. Mypy 2.4.1, Ruff 0.15.12, coverage.py 7.17.1, pytest 9.2.0, pytest-asyncio 1.3.0, Rich 15.0.0, Twisted 26.10.0. Build tools are pinned too, including editables 0.5. Per-checkout freeze outputs and per-oracle package lists retain installed versions.
- Ruff 0.15.12 matches both regression PRs' `.pre-commit-config.yaml`. Historical acceptance used Ruff 0.17.3; the historical finding-count reduction is **not solely attributable to the binary**. Mypy scope also changed in Rio. The secret-check result is independent of Ruff.
- `TMPDIR=/dev/shm`, `PIP_CACHE_DIR=/dev/shm/structlog-pip-cache`; disposable clones and venvs use executable tmpfs. Rio config/cache are freshly isolated by the runner, which strips inherited RIO_* keys. Runtime/platform and the seed-only Git environment are recorded in `structlog-setup/environment.json`.
- Rio reviews are offline. Dependency audit consistently skips with reason `offline` (needs api.osv.dev). Vulnerable dependency detection was not tested and no safety conclusion is drawn from this skip. No supported lockfile was fabricated.

## Regression before / after

Counts below include top-level findings plus risks, never nested check copies. Historical source reports remain in `docs/evaluation/evidence/structlog/pr-805-trusted.json` and `pr-811-trusted.json`. Machine-readable comparison: `structlog-setup/regression-comparison.json`.

| PR | Historical visible findings / state | New visible findings / state | Historical baseline | New actual Rio baseline | Dependency state |
| --- | --- | --- | --- | --- | --- |
| #805 | 13 = 11 unclassified tool diagnostics + 2 worsened secret alerts | 0; no visible diagnostic state | No base lint/typecheck entries | Lint head/base passed; mypy head/base passed; coverage passed | trusted |
| #811 | 5 unclassified tool diagnostics | 0; no visible diagnostic state | No base lint/typecheck entries | Lint head/base passed; mypy head/base passed; coverage passed | trusted |

The two false ContextVar credential alerts are absent in both new #805 attempts. Exact historical IDs: `3546bf6ef41f8d6042ee14d590c3c99bfd6efb61a7afae062dc7336435e625ff` and `6793e5b8a3fbb6001c32ab4ce830b9b1e594c4f0335667aa655729916fd0d00d`. Historical rule: `secret/high-entropy`, state `worsened`; 11 **other** diagnostics were unclassified. These are prior-binary defects, not defects observed in b15dc8ff5001. New secrets checks passed with no findings.

The clean reruns contain no findings on which to observe `new`/`pre_existing`; the seed supplies direct classification evidence: its one diagnostic is `new` while base mypy passes. Actual Rio classification succeeded. The unchanged evaluator's `baseline_ran` is true but `baseline_classification_ran` remains false solely because of its verified-only predicate after setup repair.

## Independent oracles and control selection

Candidate investigation and setup ran approximately 02:18–02:46 UTC (~28 minutes), before the seeded fallback. Search evidence is retained in `structlog-setup/pr-search.json`, `typing-pr-search.json`, `mypy-issue-search.json`, `lint-pr-search.json`, and history search text files. CI check-run responses for #786 and #811 are also retained. No qualifying real introducing PR's final head was established; absence of a proven candidate is not a claim that no such PR exists.

Independent commands are **not Rio output**: `mypy src` and `mypy tests/typing` match tox's source/API mypy targets, with strict configuration from each checkout's pyproject; `ruff check . --output-format=json` uses the repository's enabled rules; `coverage run -m pytest -q`, `coverage combine`, and `coverage json` instrument the installed source. Commands, exact cwd, exits, tool versions, stdout/stderr, full compressed coverage JSON, reviewed diffs, and changed-line summaries are retained. Driver: `structlog-setup/oracle-driver.py`. Only the expected seed mypy command has a nonzero exit in the completed oracle ledgers. Tests execute project code in disposable clones. Skips and warnings are preserved, not treated as passes for unexecuted code.

| Case | Base independent result | Head independent result | Evidence |
| --- | --- | --- | --- |
| #811 negative | mypy src/API and Ruff pass; 924 passed, 20 skipped | mypy src/API and Ruff pass; 924 passed, 20 skipped; both added source lines 192–193 execute | structlog-oracle-811-attempt2/ |
| #805 regression | mypy src/API and Ruff pass; 924 passed, 20 skipped | mypy src/API and Ruff pass; 925 passed, 20 skipped; no unexecuted added source statement | structlog-oracle-805/ |
| #786 candidate | mypy src/API and Ruff pass; 910 passed, 20 skipped | mypy src/API and Ruff pass; 924 passed, 20 skipped; no unexecuted added source statement | structlog-oracle-786/ |
| seeded assignment | mypy src/API and Ruff pass; 924 passed, 20 skipped | mypy src: exactly one assignment error; API mypy and Ruff pass; 924 passed, 20 skipped; mutated line executes | structlog-oracle-811-seeded-assignment/ |

#811 is authored by repository owner hynek, merged 2026-05-10, and restores cached `_write`/`_flush` methods during unpickling. Pinned base `de5dcd4127b8c9652ebadf0b6411c4bb9c10f3b7`, public head `c0ba373b5c4ead7f39630026808bc74418a4460a`. The complete source/test diff, independent successful tests and type/lint checks, and executed changed source statements establish a clean change within the tested deterministic scope. No introduced credential or dependency bump is in this diff. No claim is made about every platform or semantic correctness beyond this assessment.

Other candidates considered and rejected:

- #805: required rerun; independent checks show no introduced deterministic bug. Public base `c6e7cad18ffe91febf2b97dac03a465134b1a5d1`, public head `7d7708fdf39061b6f7515c13ed0404a9bc05fb33`.
- #786: complete base/head oracle is clean; upstream `Ensure 100% test coverage` and supported type-checker checks also succeeded. Not a positive control. Base `2796b22ee1b5eed48cf1d25113d43bcf971711a4`, head `0f230f3ef1894c5b99e562e2950eeea814b8b5d5`.
- #807: prior weak-reference writer regression is semantic. No independent enabled type/lint/coverage/secret/dependency oracle established its detectability. Not mislabelled a deterministic positive.
- #818: new snake_case methods have direct tests in the final diff; no demonstrated deterministic defect.
- #794: uncovered new alternate optional-dependency assignments appear with Rich installed, but tox deliberately runs dependency variants; selected-environment missing branches do not prove absent repository tests. Rejected rather than claiming an actionable coverage bug from an incomplete matrix.
- #741: intermediate commits named `Fix type` were already incorporated into the public final head. Reviewing an intermediate broken revision would violate the introducing-head requirement.
- #659 / #694: inspected Self-return typing changes and follow-ups; no same-oracle base-pass/head-fail source/API error established at a public introducing final head.
- #763 / #761: stacklevel and qualified-callsite changes inspected; final diffs include targeted tests. No positive established.
- #627: `Fix docs and test coverage` occurred inside the introducing PR before its final head, not a later independently demonstrated regression.
- Commits 57e165b (`Make Mypy 1.16 pass`), 0f0150a (`Mypy error changed`), 8d3eeb1 (Mypy 1.7), fe4ded1 (`Fix ignore`): checker-version adaptations alone do not establish that a public introducing PR introduced a defect under the same configured oracle.
- Issues #660, #518, #294, #290: consumer typing complaints, without an established introducing PR caught by the repository-configured source/API command.

## Seeded positive control

Kind: **seeded-mutation**, parent PR https://github.com/hynek/structlog/pull/811; case ID `811-seeded-assignment`. The public PR itself is not claimed to contain this error.

Known-good base: `de5dcd4127b8c9652ebadf0b6411c4bb9c10f3b7`. Synthetic head: `50aa6f517262a936224ab1338e244eb5a4dbaefb`. Seed: `structlog-incompatible-assignment-20261105`. One commit adds only `_EVAL_STRUCTLOG_TYPE_PROBE: int = "rio-eval-seed-20261105"` and a blank line at `_output.py:22`. It does not alter runtime behavior used by tests and introduces no credential.

Patch: `structlog-seed-evidence/mutation.patch`, SHA-256 `6a442cab1e8704005adffd7b7494eed736bb7a56a76dd5d886aad424263c4e9a`. The 678-byte `mutation.bundle` preserves the exact synthetic commit with the public base as prerequisite. `registration.json` contains preregistration time, oracle-completion time **before Rio execution**, profile/install-plan hashes, seed, mechanism, and subsequent matching finding ID. Independent base/head checks completed before running Rio on this mutation.

Expected bug: `seeded-incompatible-assignment`, mechanism `type-error`. Independent mypy: base exit 0; head exit 1 solely for `assignment`, expression str vs annotated int, at source line 22. Rio emitted **one** corresponding finding, ID `2238acfbeea4da42971fce566ac2420bad7adefb8130dd42a71e928445457d1a`, rule `typecheck/mypy/assignment`, state **new**. Adjudicated true-positive and linked in `positive_control.expected[].finding_ids`. **Observed: 1 expected detected, 0 missed**; excluded from release scoring by the evaluator limitation.

Runner workaround for synthetic commits: the unchanged runner fetches only from a hardcoded public URL. Seed-only `GIT_CONFIG_GLOBAL=/dev/shm/structlog-seed-gitconfig` supplies a process-local `url.<local-seed-clone>.insteadOf` mapping for precisely that URL; no machine Git config is edited. Base is public and synthetic head exists only locally. Exact mapping: `structlog-seed-evidence/gitconfig.txt`; command provenance in the seed verdicts and `structlog-setup/environment.json`. Reproduce by cloning upstream, fetching `mutation.bundle` into that clone, and updating this disposable mapping's local path. No synthetic SHA is represented as upstream.

## Failed attempts and harness reproduction

1. Original disk-backed bootstrap was blocked in `balance_dirty_pages`; `/proc/pressure/io` showed >80% pressure. Terminated it and recreated the environment and pip cache in `/dev/shm` (20 GB tmpfs, executable). Original and retry logs remain under structlog-setup/. These wall times are not a controlled performance benchmark.
2. First plan omitted `editables==0.5` while using `--no-build-isolation`. Both editable installs failed with `ModuleNotFoundError: No module named editables`; coverage failed `tool_crashed`, exit 4. Retained `structlog-805/` and `structlog-811/` as schema-valid excluded attempt records, with unique case IDs `805-attempt1` and `811-attempt1`. Empty finding maps are complete: each report has zero top-level findings/risks. They are not negative controls and `independently_clean` is false.
3. Independent #811 oracle's first attempt failed for the same missing build dependency; retained `structlog-oracle-811/`. It has no Rio report or record. Corrected oracle evidence is in `structlog-oracle-811-attempt2/`.
4. Corrected plan pins editables and succeeds at base/head. Fresh runner directories `structlog-805-attempt2/`, `structlog-811-attempt2/` preserve the originals. Seed also uses v2 and installs successfully.
5. Harness mismatch: `eval/evaluate.py:196–199` rejects any head/base dependency state other than verified. `eval/runner.py:170–173` uses that result and records `Baseline/setup ineligible; fix before scoring`, exiting 1. Exact reproduction: inspect the corrected reports' successful trusted head/base check entries, then run `python3 eval/evaluate.py record --report eval/runs/structlog-811-attempt2/report.json --verdicts eval/runs/structlog-811-attempt2/verdicts.json --out /tmp/structlog-repro-record.json`. The resulting record has `environment.baseline_ran: true`, `baseline_classification_ran: false`, and reasons naming `head=passed, dependency_state=trusted, base=passed` for both tools. Seed instead has head typecheck findings, base passed, and explicit finding state new, yet the same false evaluator classification flag. This is a harness/policy incompatibility with the requested trusted classification path, **not an observed Rio baseline failure**. Finding IDs for this harness issue: not applicable (no synthetic Rio finding).

No new Rio binary defect was independently observed. The old ContextVar false positives are gone. Offline audit is an explicit limitation. The verified-only evaluator predicate cannot be repaired by changing a correct lockfile-free trusted setup, so it was documented rather than repeatedly rerunning identical inputs or falsifying dependency metadata. Existing eval/*.py remain untouched.

## Wall times

Full runner duration includes clone/install, subprocess startup, ledger writes and cleanup. Rio review time is the report metric. Both include shared-host effects; profile budget and Ruff differ from historical acceptance. Historical Rio times: #805 68.991s; #811 32.710s. Oracle command durations are in their commands.json; pytest's own times are retained in its stdout.

| Attempt | Full runner | Rio review | Rio exit | Runner exit |
| --- | --- | --- | --- | --- |
| structlog-805 | 150.435s | 12.123s | 4 | 1 |
| structlog-811 | 154.639s | 10.433s | 4 | 1 |
| structlog-805-attempt2 | 192.115s | 29.405s | 0 | 1 |
| structlog-811-attempt2 | 187.569s | 28.927s | 0 | 1 |
| structlog-811-seeded-assignment | 137.488s | 14.628s | 1 | 1 |

## Durable records and validation

- Regression #805: [structlog-805-attempt2/record.json](structlog-805-attempt2/record.json), kind none, trusted, actual baseline pairs successful, evaluator classification false; no findings.
- Negative #811: [structlog-811-attempt2/record.json](structlog-811-attempt2/record.json), kind none, trusted, actual baseline pairs successful, evaluator classification false; no findings.
- Seeded positive: [structlog-811-seeded-assignment/record.json](structlog-811-seeded-assignment/record.json), kind seeded-mutation, trusted, actual classification new, evaluator classification false; one true-positive.
- Failed first attempts: [structlog-805/record.json](structlog-805/record.json), [structlog-811/record.json](structlog-811/record.json); retained and excluded.

Each record was generated with `python3 eval/evaluate.py record` and validated with `python3 eval/evaluate.py validate`. `structlog-setup/results.json` is a supplemental observation ledger, **not an eligible aggregate score**. Complete raw reports, verdict maps, command/install logs, pins, source patches and oracle evidence are durable in this tree. Reports are small; coverage JSON is gzipped. No committed file exceeds 5 MB. Disposable clones and venvs are outside the worktree and are not committed.

Validation detail: `git diff --cached --check` reports original whitespace in the preserved pip error logs and standard git-format-patch output. These raw evidence bytes were intentionally retained; authored Markdown, Python helper, profiles, and JSON pass the whitespace check. All five evaluator record validations pass. Total committed evidence is approximately 3.1 MB across 489 files (many are intentionally empty subprocess logs).

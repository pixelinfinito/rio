Control ID: litestar-5164-seed-f841
Repository / public parent PR: https://github.com/litestar-org/litestar/pull/5164
Language: Python
Base SHA: f4f7e9831574ed08f50901e62911019b5e7383ac
Kind: seeded-mutation
Seed: litestar-f841-20261105-v1
Mutation: add `rio_eval_unused = 1` inside `litestar/utils/path.py::normalize_path`, without changing its return value. Exactly this mutation is the reviewed head; the parent PR's changes are not included.
Expected bug: unused-local-normalize-path; mechanism lint-rule; Ruff F841 is enabled through the repository's `lint.select = ["F", ...]` and has no applicable suppression.
Independent oracle: `.venv/bin/ruff check .` on the base and the mutated head; capture exact stdout/stderr, exit codes and times in seed-oracle-commands.json before Rio execution.
Installer: uv 0.13.7, CPython 3.12.12, `uv sync --locked --all-groups --all-extras --no-editable --python 3.12.12`; same uv.lock as negative control. Disable only the four explicitly enumerated executable startup .pth files in the disposable Rio environments; no dependency trust override.
Profile: profile-long.yaml, all rio/base checks enabled, baseline true, trust false; 60m budget accommodates a heavily shared host. PYTEST_ADDOPTS=tests/e2e/test_routing/test_path_mounting.py for both controls; coverage is limited to that suite. Dependency audit is offline and excluded, never evidence of safety.
Reviewer: sub-agent eval-litestar (automated); verdict_source automated.
Selection rationale (before seed or Rio output): around 30 minutes of real introducing-PR searches did not establish a qualifying head. Use an inert lint-only mutation with a passing base oracle. This is a synthetic bug and must not count as a real PR or as a secret/audit/coverage/type control.
Transport: the harness cannot fetch an unpublished seeded SHA from GitHub. A scoped Git URL rewrite points only this repository URL to /tmp/litestar-eval-transport.git, which contains exact public commits fetched from GitHub plus the seed commit. Neither eval/*.py nor crates/ is modified. Preserve the patch and a small Git bundle for reproduction.
Raw report/verdicts/record: ../litestar-5164-seed-f841-scored/{report,verdicts,record}.json
Final mutation SHA: fcab0954a74c5f8d340adbbfb9091f94982aa9a2.
Patch SHA-256: 2ef92d4ca023bd78f1efbec512a0ff9788d1f0e2dbd957c5f66e9d3802455c4a.
Profile SHA-256: 7f79af17af30fa064a6c7382114fbaca818be229d12e4bfea20ca9678544f4b8.
Final installer: install-plan-final.json. Root non-editable-wheel provenance workaround was added after the documented failed baselines. Final external coverage override: coverage-scoped-threshold.toml, fail_under=0.01, identical instrumentation/exclusions; zero was replaced with 100 by covdefaults. Temporary storage: /run/user/1000/rio-litestar-eval.
Final baseline classification true; all head/base typecheck and lint pairs successful with verified dependencies; coverage passed. Evidence: ../litestar-5164-seed-f841-scored/{commands,report}.json and rio-tool-evidence/commands.json.
Detected finding: 43d6925de36ee0e0beb788c1be9fd46de7152f1be80230d5085329c5f9911eab, lint/ruff/F841, state new. Expected bugs 1 detected, 0 missed.
Setup and rerun history: ../litestar-NOTES.md and attempt-ledger.json; every excluded attempt is retained and unscored.

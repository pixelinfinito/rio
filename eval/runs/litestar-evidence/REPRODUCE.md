# Reproduction pins and limitations

The prebuilt Rio binary is `/home/ubuntu/rio/target/release/rio`, reporting
`rio 0.1.0 x86_64-unknown-linux-gnu b15dc8ff5001`.
Its SHA-256 is `512d123450bb93a62f03dc74bbe5057e24abeac70f365acb418f02933904e3f2`.
No build was performed and neither `crates/` nor `eval/*.py` was edited.

Use CPython 3.12.12 (a pinned patch release in Litestar's supported 3.12 test
matrix) and uv 0.13.7. Both changes have the same unchanged `uv.lock`, SHA-256
`8f25baff7a27134191cd7adcb550963aa1212f1081f13196b929e305ff17dfbd`.
The exact frozen installer and startup-hook workaround are in
`install-plan-final.json`. Its second command logs the original
content and SHA-256 of each disabled `.pth` file. It renames only four known
startup hooks, inside disposable virtualenvs. It does not suppress diagnostics,
change project code, or enable dependency trust. Its third command asserts that
the installed root package has a **non-editable** local-wheel `direct_url.json`,
logs that JSON and its hash, then renames it to `.json.disabled`. This avoids
Rio incorrectly treating a non-editable local wheel as a live source link.
The two previous tmpfs attempts preserve the exact baseline refusal.

All final runs use `profile-long.yaml` (SHA-256
`7f79af17af30fa064a6c7382114fbaca818be229d12e4bfea20ca9678544f4b8`).
It preserves all `rio/base` checks and increases the budget to 60 minutes for
the heavily shared host. The first, excluded attempt used a 20-minute budget.
Coverage was intentionally scoped through
`PYTEST_ADDOPTS=tests/e2e/test_routing/test_path_mounting.py` for both controls.
These are not full-suite coverage claims. Set `COVERAGE_RCFILE` to the absolute path
of `coverage-scoped-threshold.toml`. That external config copies the repository's coverage
instrumentation/exclusions exactly and changes only the global report/export
threshold from 50 to 0.01 for the scoped suite. Zero is not usable here: the
`covdefaults` plugin replaces it with its default of 100. The preserved
`coverage-scoped.toml` and `*-final` attempts demonstrate that setup error; only
the `*-scored` attempts use the corrected nonzero threshold. Diff coverage stays enabled.
Use `--temp-root /run/user/1000/rio-litestar-eval` (or another sufficiently large
tmpfs directory) to avoid ext4 per-file sync delays. Dependency auditing was offline with
an empty fresh Rio cache, so the audit skip is an explicitly excluded
capability, not evidence that dependencies are safe.

## Public negative control

PR https://github.com/litestar-org/litestar/pull/5178, merged maintainer `Kumzy`
(`MEMBER`), 2026-10-31. Pin base
`716f8b023b1c13e6f1e8ab08dfa1938f7923312d`, head
`9870dce9dc2688e78fc43bc73e27eed4198893ac`.
Run the unmodified `eval/runner.py` with those `--base`/`--head` values,
`--repository litestar-org/litestar --pr 5178 --languages python`, the binary,
installer plan and profile above, and a new `--out` directory.

For the independent oracles, use each checkout's `.venv/bin/mypy`,
`.venv/bin/ruff check .`, and `.venv/bin/coverage run -m pytest -q
 tests/e2e/test_routing/test_path_mounting.py`. Combine parallel coverage data
and export JSON with `--fail-under=0` (only the export threshold is waived;
test success is required). Activate the virtualenv before running Pyright,
matching `uv run pyright` in CI. The initial nonactivated Pyright invocations
are retained as failed oracle setup attempts and are superseded by
`*-pyright-activated.*` and `pyright-activated-commands.json`.

`negative-diff-coverage-assessment.json` intersects the actual changed line
ranges with independent coverage.py executed, missing, and excluded line sets.
The changed source has no missing executable lines; multiline expressions are
reported by coverage.py at their executable anchor line. Docstring-only edits
are not executable lines. This is a deterministic clean-change assessment plus
a passing relevant regression suite, not a claim to prove all semantics.

## Synthetic positive control

Public parent: https://github.com/litestar-org/litestar/pull/5164. The reviewed
base is that PR's **base**, `f4f7e9831574ed08f50901e62911019b5e7383ac`, and the
reviewed head is only the F841 mutation,
`fcab0954a74c5f8d340adbbfb9091f94982aa9a2`. It does not include PR #5164's real
changes and does not count as a real introducing PR.

`positive-control-register.md` was written before mutation and before running
Rio on it. `seed-f841.patch`, `seed-manifest.json`, `seed-oracle-commands.json`,
and `seed-{base,head}-ruff.*` pin the mutation and oracle. `ruff check .` passes
at base, and head has exactly one F841, at `litestar/utils/path.py:24`.

Fetch the public base from GitHub first, then fetch the incremental
`seed-mutation.bundle` ref `refs/heads/seed-f841`. This small bundle has the
public base as a prerequisite. Alternatively apply `seed-f841.patch` to that
base and commit with the exact identity, date and message in
`seed-oracle-driver.py.txt` to reproduce the head SHA.

The unmodified harness insists on fetching head from the repository URL. For
an unpublished seed, create a disposable local Git transport containing the
public commits and seed, then scope this URL rewrite to the runner process:

```
GIT_CONFIG_COUNT=2
GIT_CONFIG_KEY_0=http.version
GIT_CONFIG_VALUE_0=HTTP/1.1
GIT_CONFIG_KEY_1=url.file:///tmp/litestar-eval-transport.git.insteadOf
GIT_CONFIG_VALUE_1=https://github.com/litestar-org/litestar.git
```

The same scoped transport was used for the negative control to avoid repeated
public full-history downloads. It contains original GitHub-fetched objects,
not reconstructed public commits. The seed runner uses `--pr 5164 --case-id
5164-seed-f841` and its full base/head pins. All exact runner invocations are
in each attempt's `commands.json` and verdict commands.

## Internal command evidence

The unchanged runner's `commands.json` does not record Rio's internal tool
argv. `capture-tools.py.txt` is an external Linux `/proc` observer that saves
these into each run's `rio-tool-evidence/commands.json`, with the observed cwd,
selected nonsecret environment fields, and the mypy config text. It also copies
Rio's raw check artifacts before the runner deletes disposable trees. The
runner ledger and raw report remain unchanged. This closes the evidence gap
without modifying the harness or binary.

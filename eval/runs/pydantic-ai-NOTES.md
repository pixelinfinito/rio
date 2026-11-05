# pydantic/pydantic-ai deterministic evaluation

Reviewer: sub-agent eval-pydantic-ai (automated). Verdict source: automated.
Rio: prebuilt /home/ubuntu/rio/target/release/rio, verified `rio 0.1.0 x86_64-unknown-linux-gnu b15dc8ff5001`; no rebuild or changes to crates/ or the evaluation harness.

## Selection (before Rio)

- Positive candidate: #8641, introducing head 3ddc4c33d31468f59be4aa0ae590d40612c5ac39 against base 8ed5b18b4133d85252de924d1c65a24fb295589c. Follow-up #8730 and issue #8717 identify generic OutputSpec[T] forwarding losing T under mypy 2.1.0. External oracle fixture is a reproduction only; it is not added to the reviewed PR. The external fixture passes at base and fails with no-any-return at head; the repo-configured mypy/Ruff pass at both pins. Rejected as a deterministic control because detection requires adding a new fixture.
- Negative candidate: maintainer DouweM's #12540, head 17c4ab5539f8a38aa86b2af69a783cb595269d27 against base 2f0e98cbb7b60e12dcd0edc397f6df11c5cc1c56. Changes asyncio warning handling in pydantic_ai_slim, pydantic_graph and pydantic_evals, with regression tests. Independent results are recorded below.
- Rejected #9710 / #7964: follow-up #10670 describes four Pyright errors after combining the two PRs. #9710's actual head has no tests/realtime/test_elevenlabs_agents.py (HTTP 404); #7964's head has a non-generic NativeToolReturnPart. The integration regression cannot establish a failing individual introducing head.
- Rejected #9406 / #9582: follow-up commit 14add2662fc35c17f797858b8e83c3dc8885be4e explicitly says the duplicate imports fail only together. No individual-head failure established.
- Rejected #8818 import-history PR: intentionally incomplete packaging/CI integration and many unrelated setup failures; follow-ups #8829 and #8832 change the enabled lint/typecheck scope. Poor isolated control.
- Considered #9091 (bool/int Literal decision matching): semantic runtime bug, not by itself a deterministic positive control; contributor-authored, so #12540 chosen for the maintainer negative.
- Considered #12520 (RenderSandbox spec support) and #12577 (clai2 agent defaults): both have regression tests; no independent deterministic introducing bug established.
- Considered fixes #3308 (overload omission), #1113 (runtime missing import), and #10080 (CI budget/subprocess guard): no qualifying introducing-head oracle established; not used.

## Setup and declared scope

- Python 3.13.9 (managed CPython) and uv 0.13.7, recorded exact effective pins. Upstream uses Python 3.13 in quality CI and allows uv >=0.9.25 rather than pinning an exact uv release.
- Custom profile pydantic-ai-evidence/profile.yaml: verified baseline typecheck, repository Ruff rules, and secret scan enabled. Coverage and dependency audit explicitly disabled in Rio. Independent targeted coverage is used to assess the negative change; no audit safety claim or coverage-adapter recall claim is made.
- Default locked install: uv sync --locked --python 3.13.9 --group lint, including the default dev group and default root extras. No trust_installed_dependencies.
- Shared machine had severe write stalls: /proc/pressure/io showed some avg10=77.27%, full avg10=64.81%; Git checkout process was in D state (do_get_write_access). Abandoned redundant disk-backed full/shallow clones and moved disposable work to private executable tmpfs /tmp/rio-pydantic-ai-ram (initially 5 GiB, expanded to 8 GiB) plus a private uv cache. Initial source partial clone retained solely as a local object cache. These are machine setup observations, not Rio defects or performance measurements.
- Initial profile draft replacing only `checks` was rejected because a steps array replaces inherited steps (`needs unknown step prepare`); corrected by copying the full built-in base profile before any Rio review.
- Coverage installs an executable a1_coverage.pth bootstrap; Rio source inspection indicates it will refuse dependency verification for such files. Instrumented independent tests run before any removal. The runner workaround is recorded below.

Final results, exact finding IDs, roots, configured targets, attempt ledger and wall times appear below.

## First attempts and compatibility investigations

- `pydantic-ai-8641-seeded-attempt1`: runner exit 1, baseline_classification_ran=false, baseline_ran=false, no findings. Rio skips typecheck/lint because a valid uv installation has burner-redis 0.1.7 while Rio also expects the mutually exclusive 0.1.6 variant. Both lock entries have matching Python resolution markers; incompatible extra/group branches are still included in the effective graph. This attempt is excluded from scoring. Independent seed oracle is F401 at output.py:4. No emitted finding ID exists because the checks never ran.
- `pydantic-ai-12540`: runner stops before Rio when the local partial Git cache cannot serve an absent blob (99c1c8a837d8e00fc5e0d71fd122f64d93f003d8); preserve 02-stderr.log. The cache was hydrated from the public pinned commits before rerunning into new directories. This is an object-cache setup failure, not a Rio diagnostic.
- Minimal locked `pydantic-ai-slim[ui,evals]` installation without the dev group verifies slim and evals in `8641-minimal-doctor.json`, but the dependent examples root lacks its own dependencies. This confirms the conflict depends on optional/development installation contents; omitting an applicable dependent root is not an eligible repair.
- Harness issue: eval/evaluate.py environment() treats explicitly profile-disabled coverage/audit checks as environment failures, although the methodology permits predeclared scope. No harness source was changed; these original reports are preserved as unscored attempts. Later cohort setup must address this before any eligible record can be claimed.
- Target resolution issue independently reproduced: mypy --config-file /ABS/pyproject.toml from pydantic_ai_slim exits 2 with `Cannot read file tests/typed_agent.py`. The config is inherited from the workspace root, but mypy resolves its files relative to cwd. `mypy-workspace-wrapper.txt` records the proposed setup workaround (cd to the supplied config directory, invoke the unchanged installed mypy module). The first run was blocked earlier at dependency verification, so this is not claimed as an observed emitted Rio finding.
- Coverage bootstrap removal in install plans removes only installed a1_coverage.pth after independent instrumented tests. The original contents are retained in coverage-bootstrap-original.txt. The dependency package/version metadata and tracked lockfiles are unchanged.

## Substitution decision

At approximately 03:03 UTC, after starting around 02:18 UTC (45 minutes of repository acquisition, installation, independent checks and compatibility repair), switched the scored-control work to the user-listed fallback `mitmproxy/mitmproxy`. This was setup/repair elapsed time, not 45 minutes solely downloading packages. Pydantic-ai installations themselves succeeded; Rio's conflicting universal-lock variant verification prevented baseline classification. The original repository is not silently dropped: its raw attempts, independent positive/negative evidence, workspace plans and excluded records are retained.

A smaller locked install (`uv sync --locked --python 3.13.9 --no-default-groups --group lint --package pydantic-ai-slim --extra ui --extra evals`) lets Rio verify slim and evals but leaves the scheduled dependent examples root missing required packages. Installing the examples package from the same lock makes uv choose MCP 2.0.0; Rio then rejects it against MCP 1.28.1. Evidence: 8641-minimal-{install.log,doctor.json} and 8641-examples-{install.log,doctor.json}. This cannot be repaired by selecting a single package version that satisfies both mutually exclusive graph variants. No trust override, source changes, lockfile edits or binary rebuild were used to bypass verification.

Attempts 12540 and 12540-attempt2 both failed in the partial local Git cache before Rio. The second absent blob was a4b7e7dbc4509fc6f15fe455733cf9c99a803211. Hydrating the pinned trees was insufficient because fetch negotiation wanted other historical blobs. Advertising each pin under refs/heads/eval-* in the cache repaired fetch negotiation; 12540-attempt3 proceeded through installation and doctor. This is a cache transport setup problem, not a Rio crash.

## Final adjudication and workspace observations

Both pydantic records validate against schema v1 but are **excluded environment failures**. They do not enter any quality denominator.

- `pydantic-ai-8641-seeded-attempt1/record.json`: seeded-mutation, baseline_ran=false, baseline_classification_ran=false. Zero emitted findings. Registered unused-itertools-import was not detected because Ruff was skipped; retain an environment-blocked deterministic miss rather than claiming a scored recall failure. Base full Ruff exits 0; seeded head exits 1 with exactly F401 at output.py:4; configured mypy passes. Seed/pins/hash/profile were registered before Rio in pydantic-ai-evidence/positive-control-register.json.
- `pydantic-ai-12540-attempt3/record.json`: negative control (`kind: none`), independently_clean=true, baseline_ran=false, baseline_classification_ran=false. One false-positive; all other finding classes zero. Independent configured mypy and full Ruff pass base/head, focused Pyright on changed utils files passes both, and targeted instrumented tests pass (124 base, 127 head). No missing instrumented changed executable lines: pydantic-ai-evidence/12540-independent-diff-coverage.json.gz. This is a scoped deterministic clean assessment, not an exhaustive semantic or vulnerability claim.
- `pydantic-ai-12540/` and `pydantic-ai-12540-attempt2/`: clone/fetch failure before Rio, no report and no fabricated record. All logs retained.

Actual review scheduling and target evidence are appended under `evaluation_annotations` in each report-producing attempt's **commands.json**. Original runner command entries are preserved. The harness captures top-level Rio argv but does not expose underlying typechecker subprocess argv; configuration/source-derived templates are explicitly labelled as inference, not a captured trace. Relevant config excerpts are saved in pydantic-ai-evidence/typecheck-config-evidence.json.

| Attempt | Scheduled changed typecheck roots | Scheduled dependent typecheck roots | Executed targets |
| --- | --- | --- | --- |
| 8641 seed | pydantic_ai_slim | pydantic_evals, examples | None: dependency verification skipped all typechecks and slim lint. |
| 12540 attempt3 | ., pydantic_ai_slim, pydantic_evals, pydantic_graph | examples, src/pydantic_ai_harness, src/pydantic_clai2 | Only graph head mypy and Ruff ran; no base. All dependent roots skipped. |

Rio selected **mypy**, not Pyright, for every listed Python typecheck root. The inherited workspace root config explicitly sets `files = "tests/typed_agent.py"`, so the adapter supplies `--config-file <tree>/pyproject.toml` with no inferred package target arguments. Independent nested-cwd reproduction fails with cannot-read-file; attempt3's installed mypy wrapper anchors cwd to the config directory. Consequently graph's passing head check (95.660s) checks **root tests/typed_agent.py**, not the graph sources themselves. This is a scope limitation of inheriting the repo's narrow mypy configuration, plus a cwd compatibility problem; it is not evidence graph source typing was checked. Dependent roots were discovered and scheduled, but were **not successfully handled**. Impact graph was truncated at max_nodes=2000.

## Defects and reproductions

1. **Universal uv lock variant verification blocks legitimate installs.** Reproduce original seed with pinned base/head from the preregistration, install-plan.json and profile.yaml, and `python3 eval/runner.py --repository pydantic/pydantic-ai --pr 8641 --languages python --base 8ed5b18b4133d85252de924d1c65a24fb295589c --head c9841c796bb6a8fbfd5492bdcc532f2410518e2c --rio /home/ubuntu/rio/target/release/rio --install-plan eval/runs/pydantic-ai-evidence/install-plan.json --profile eval/runs/pydantic-ai-evidence/profile.yaml --out NEW_DIRECTORY`. Restore labelled synthetic commit from 8641-seed.patch if using a fresh cache. No diagnostic IDs: checks are skipped. Exact hint: `uv.lock: burner-redis: expected burner-redis@0.1.6, installed burner-redis@0.1.7`. Minimal and examples locked installs in the retained doctor evidence demonstrate mutually exclusive MCP 1.28.1/2.0.0 expectations. At #12540, valid fastmcp-slim 3.4.7 is rejected against 4.0.5. Source inspection in crates/rio-adapters/src/dependencies/effective.rs indicates compatibility comparison retains optional/false graph variants. This observation does not justify changing the lock or trusting installed dependencies.
2. **Inherited mypy target cwd.** In a pinned checkout after locked install, `cd pydantic_ai_slim` then `../.venv/bin/mypy --config-file "$PWD/../pyproject.toml"` resolves tests/typed_agent.py beneath the package and fails. Exact independent output: pydantic-ai-evidence/8641-seed-nested-mypy-repro.log. Wrapper and exact installation are recorded in install-plan-workspace.json and mypy-workspace-wrapper.txt; no tracked project or harness source changed. No finding ID; first review blocked earlier.
3. **Editable workspace dependencies prevent baseline materialization.** Attempt3 graph head checks pass, but the baseline is rejected: `linked dependency .venv/lib/python3.13/site-packages/_editable_impl_pydantic_ai.pth points at changed source : pydantic_ai_slim/pydantic_ai/_utils.py; commit or stash the linked package's changes`. This is the reviewed base/head difference, not an evaluator working-tree edit. See commands.json environment notes. Mitmproxy demonstrates the same limitation and its dependencies-only repair below.
4. **Dummy AWS credential false positive.** Finding `e6161a78e91e93a541f261f3c38ca2945416fd5a54ede6acf8e3fbbb6b78516e`, `secret/aws-access-key`, tests/conftest.py head:1593/base:1574. Independent source/AST evidence shows an unchanged os.getenv fallback made of the AKIA prefix and sixteen repeated 6 digits, adjacent to a repeated-digit dummy secret. No live credential used. Reproduce with the pinned #12540 review or inspect the saved raw report and pydantic-ai-evidence/secret-false-positive-evidence.json. Rio labels it pre-existing, but its credential/rotation claim is false.
5. **Harness scope handling and command observability.** Profile-disabled checks are recorded as setup failures by evaluate.py environment(); no harness edits. commands.json lacks internal tool argv, so target annotations disclose this evidence limitation. Neither has a finding ID. No Rio crash was observed.

## Wall times and retained evidence

Exact start/end timestamps and process timings for **all seven attempts** are in [attempt-times.json](attempt-times.json). Pydantic runner elapsed / summed uv-sync / Rio process seconds:

| Attempt | Runner | uv sync | Rio review | Baseline classified |
| --- | ---: | ---: | ---: | --- |
| 8641 seed attempt1 | 113.373 | 30.654 | 44.282 | no |
| 12540 attempt1 | 12.099 | 0 | did not run | no |
| 12540 attempt2 | 11.116 | 0 | did not run | no |
| 12540 attempt3 | 285.895 | 33.345 | 217.624 | no |

These warm tmpfs process timings exclude earlier acquisition/research and shared-disk stalls; do not use them as cold performance measurements. Independent check timings, exit statuses, exact argv and version outputs are in pydantic-ai-evidence/*-commands.json and corresponding logs. Research began around 02:18 UTC; seeded fallback registered 02:48:21 UTC; repository substitution chosen around 03:03 UTC. Raw reports and evidence remain versioned. Every emitted finding was adjudicated, every report was normalized and schema-validated. Reviewer/source are automated, not human confirmation.

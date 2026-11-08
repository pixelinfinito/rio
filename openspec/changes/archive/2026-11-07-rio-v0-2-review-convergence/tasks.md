# Tasks

## 1. Carried-over v0.2 verifier acceptance

- [x] 1.1 (Migrated from `rio-v0-2-verifier` task 9.2.) Extend the existing `eval/` harness (`eval/verifier.py`, `eval/evaluate.py`) with a pinned verifier-versus-single-verifier comparison on the same reference cases, including known high-severity issues and clean controls, artifact-backed verdicts, blind-match buckets, verification tokens/cost and precision by evidence level. Verify harness tests pass, high-severity recall does not fall against the baseline and the measured v0.2 precision meets the PRD's 80% gate; write the summary under `docs/evaluation/` and retain failures as evidence instead of claiming acceptance.

## 2. Contracts and storage

- [x] 2.1 Add Worker migration `0002_convergence.sql`: `lineages` (repository, kind, ref, generation, round counter, last reviewed head, posted identities with comment/thread ids, `rounds_to_pass`), a new `findings` table (tenant, review, lineage and generation, identity, regression `state`, lifecycle `status`, `round`, `first_posted_in`, `author_response_json`, location) and a `feedback` table whose `reason` accepts only `fixed | wrong | intentional | irrelevant | style`, mapping draft values `false_positive`→`wrong` and `known`→`intentional`. Verify `rio deploy` applies it through the migration Workflow on a fresh and an upgraded database in the deployment mock tests, and that a draft reason is converted.
- [x] 2.2 Add optional lifecycle `status` (`open | fixed | dismissed`) to `schemas/finding-v1.json` and `rio-core::Finding`, separate from regression `state`, and emit `round`, `first_posted_in`, `status` and `author_response` when a review belongs to a lineage, keeping their absence valid elsewhere. Verify `crates/rio-core/tests/contracts.rs` and the generated Worker validators accept both forms, reject `state: dismissed` and `author_response.reason: known`, and that `fail_on` results are unchanged by `status`.
- [x] 2.3 Populate the `findings` table from each lineage review's report when the review finishes, keyed by tenant, lineage generation and identity. Verify Worker tests that a finished lineage review writes one row per finding and a non-lineage review writes none.
- [x] 2.4 Add internal `schemas/eval-case-v1.json` (input base/head, expected findings, `incident` label, `counterfactual_catch`) and regenerate validators. Verify `npm run check` and the `eval/tests` schema tests pass.

## 3. Lineages and rounds

- [x] 3.1 Accept an optional lineage reference (`pr` number or `branch` name) and an optional reset request on review submission, resolve it to the endpoint-held lineage keyed by repository, kind and ref (independent of commit ancestry), and start a new generation at round 1 on reset. Verify Worker tests that a force-pushed head keeps its lineage, a reset starts round 1, and a submission without a reference has no round.
- [x] 3.2 Assign `round` as one plus earlier lineage reviews that posted any finding (including risk-only rounds), stamp it on every finding, and record `rounds_to_pass` when a review has no open defect. Verify Worker tests for an empty middle round not consuming a round and convergence on round 3.
- [x] 3.3 Document lineages, rounds and `rounds_to_pass` in `docs/verifier-contracts.md`. Verify the documented submission example validates in the API tests.

## 4. Diff-only re-review and class findings

- [x] 4.1 For rounds above `rounds.diff_only_after`, compute the previous-head-to-new-head diff and give agents that diff, the previous round's findings with current states and the carried-forward intent, while checks and the graph still use base→head. Verify a workflow test that round 2 agent prompts contain only the incremental diff and checks still classify every changed file against base.
- [x] 4.2 Limit re-verification to hypotheses on changed code plus previously open findings whose location changed. Verify a workflow test counts the expected voter dispatches for an unchanged open finding (none) and a moved one (re-verified).
- [x] 4.3 In Worker consolidation, merge agent findings sharing `rule_id` and `trigger_hash` across symbols into a class finding with identity `blake3(rule_id | "class" | trigger_hash)`, all instance `locations` and a pattern message when the count exceeds `class_threshold` (default 3), applying suppressions and responses to every instance. Verify consolidation tests at three (kept separate) and five (merged) instances.

## 5. Publication rules

- [x] 5.1 Hold back finding identities already posted in the lineage, update their recorded state instead, and count them in the report. Verify a workflow test where round 2 reproduces a round 1 finding at shifted lines: it is held back and counted.
- [x] 5.2 Above `rounds.cap`, keep the full report but replace published agent findings with one reconsider message (unresolved count, three highest-impact titles and locations, and a split proposal along the prepare step's logical parts when `max_lines` was exceeded), always publishing deterministic findings. Editing an already-posted reconsider message on later capped rounds needs the PR publisher and is covered by the Workflow follow-up (v0.3). Verify report and publication tests for a fourth round with and without `max_lines` exceeded.
- [x] 5.3 Add the lineage footer lines (round and cap state, author-response ratio when responses exist, held-back count) to terminal, Markdown and JSON renderers. Verify `crates/rio-core/tests/render.rs` snapshots for a capped lineage and a review without a lineage.

## 6. Finding feedback

- [x] 6.1 Add `POST /v1/findings/{id}/feedback` writing `author_response` to the finding and the `feedback` table, rejecting unknown reasons and never changing posture, budgets, rules or suppressions. Verify API tests for each accepted reason, an unknown reason, a cross-tenant finding and an unchanged profile.
- [x] 6.2 Auto-resolve a lineage finding as `fixed` (recording the fixing head) only when the later review is `complete`, re-assessed its location (covering checks succeeded; agent verification finished without incomplete votes), no longer produces its identity and changed its code; otherwise keep it `open`, noting "not re-assessed" or "did not reproduce". Verify workflow tests for the fixed case, an incomplete-vote review, a failed covering check and unchanged code.
- [x] 6.3 Add `rio feedback <id> --dismiss <reason> [--note TEXT]` with exit codes 0, 2 (invalid reason or no endpoint) and 3 (rejected or unknown finding), validating the reason before any network call. Verify CLI tests for each exit code and document the command in `README.md`.

## 7. Local lineages in the CLI

- [x] 7.1 Implement `rio review --since-last [--reset-lineage]` with an endpoint: require a branch, submit the lineage reference (and reset request), keep a versioned local copy of the endpoint's lineage state (previous head, posted identities, round, generation) under the review cache, and render held-back counts and the reconsider message locally. Verify CLI tests for two successive runs, a deleted local copy continuing at the next round, `--reset-lineage` returning to round 1, a detached HEAD (exit 2) and `--offline` (exit 2).
- [x] 7.2 Include `lineages/` in the review cache's age and size pruning. Verify cache tests that an expired lineage copy is pruned and a current one is kept.

## 8. Evaluation growth

- [x] 8.1 Implement `rio eval noise`: select known-clean PRs (merged, no revert or same-hunk touch within 90 days), run the pipeline, write an unlabeled adjudication skeleton per PR and `eval/runs/noise/<date>/summary.json` with the harmful count (as a lower bound) and the unadjudicated count. Extend the eval record schema with `harmful | neutral | useful` labels, adjudicator and rationale; never infer a label. Verify harness tests with recorded fixtures for selection, schema validation and an unlabeled entry reported as unadjudicated.
- [x] 8.2 Add the noise release check: fail when the candidate's harmful count exceeds the previous release's or any finding is unadjudicated. Verify harness tests for both failure cases and a passing run.
- [x] 8.3 Add `eval/nightly.py`: run `rio eval noise` with the pinned profile and the machine's saved endpoint configuration, keep the dated run and its log privately under `~/.local/share/rio/noise/`, scan them for the saved credentials (quarantining the run and exiting non-zero on a match), prune runs older than 90 days, and install a systemd user timer (or print a cron line) for the nightly schedule. Remove the GitHub workflow so no endpoint or token is stored in the public repository. Verify harness tests for the run, quarantine and pruning paths, a real local run that writes the dated directory, and that the repository contains no secret; document it in `eval/README.md`.
- [x] 8.4 Implement `rio eval import-incident <pr> <fix-pr> [--caught-by]`: refuse on empty file overlap, otherwise write an `incident` case under the repository's `eval/` validated against `schemas/eval-case-v1.json`. Verify tests for the overlap refusal, enclosing-symbol expectations and `counterfactual_catch`.
- [x] 8.5 Aggregate the author-response ratio, `wrong` per agent and evidence level, `intentional` per agent, `irrelevant`/`style` per rule and category, and `rounds_to_pass` per repository in `eval/` summaries, and add the regression gate over incidents, historical PRs and mutations that fails on lower precision, recall or incident recall. Verify `python3 -m unittest discover -s eval/tests -v` covers the ratio example (0.6) and a gate failure naming a missed incident; update `eval/README.md`.

## 9. Integration

- [x] 9.1 Run a recorded-gateway end-to-end lineage of three rounds through the deployed-equivalent Worker: round 1 posts findings, round 2 is diff-only with held-back and auto-fixed findings and a feedback dismissal, round 4 under `rounds.cap: 3` produces the reconsider message. Verify expected footers, states and exit codes in all report formats.
- [x] 9.2 (Migrated from `rio-v0-2-verifier` task 9.3.) Run `cargo fmt --all --check`, `cargo clippy --workspace --all-targets --locked`, `cargo test --workspace --locked --no-fail-fast`, the Worker package checks and tests, `python3 -m unittest discover -s eval/tests -v`, generated-profile-reference verification, `openspec validate --specs` and `openspec validate rio-v0-2-review-convergence --strict`. Verify the hosted Linux/macOS/Windows CI matrix (`.github/workflows/ci.yml`) and integrated contract tests pass on the pushed branch before marking implementation complete.

## Workflow follow-up

- PR-thread behaviors (editing posted comments, including the capped-round reconsider message, `/rio dismiss` and `/rio review` comment handling, thread resolution) are specified here and land with the GitHub App change (v0.3); that change must not re-specify them.
- Archive this change after its tasks, including the carried-over v0.2 acceptance gates, are complete.

## Validation record (2026-11-06)

Local: Rust workspace 300 tests passed with fmt and clippy clean; Worker 101 tests, contract/bundle check and Prettier; eval harness 80 tests; generated profile reference unchanged; `openspec validate --specs` and strict change validation passed. Hosted CI (Linux, macOS, Windows, Worker) passed on `0e5c1cd` after fixing a PID-read race and macOS non-blocking mock sockets in the CLI tests; the Windows failure before that was a PowerShell Gallery download error. The redeployed endpoint ran live `--since-last` rounds: round 1 posted the reproduced fixture defect, and an unchanged follow-up round carried it forward as held back without re-running agents (fixed in `c3de0fc`).

Open: 1.1 — the case set (`docs/evaluation/v0.2-verifier-candidates.md`) was approved on 2026-11-06, but 8 of its 24 cases exceed the endpoint's 32 MiB snapshot limit; the limit was then lifted by `rio-v0-2-large-snapshots` and `rio-v0-2-graph-scale` (both archived 2026-11-07; all eight now fit), so both arms can run on the unchanged set and be independently adjudicated; 8.3 moved to a local nightly job at the owner's request (no secrets in the public repository); `eval/nightly.py` is implemented and a real run on 2026-11-06 reviewed two clean python-attrs PRs (one finding awaiting adjudication), but the owner chose not to enable the nightly schedule yet, so the task stays open until `python3 -I eval/nightly.py install --enable` (or a cron line) is in place.

## Validation record (2026-11-07)

8.3 done: `python3 -I eval/nightly.py install --enable`, run from the stable main checkout, installed and enabled the systemd user timer `rio-noise.timer` (linger on). `systemctl --user list-timers` lists it with the next run on 2026-11-08 03:00 UTC. A manual `systemctl --user start rio-noise.service` exited 0 and wrote `~/.local/share/rio/noise/2026-11-07` (mode 0700) with a clean credential scan. The repository's tracked files and every object in its history contain none of the saved credentials, the endpoint host or the account id. Token-shape matches are only synthetic test fixtures, and no GitHub workflow runs the noise job. `eval/README.md` now says to install from a stable checkout, because the unit records the script path.

1.1 still open: the live comparison ran on all 24 approved cases in both arms (`rio/openrouter` quorum against `verify.voters: 1`) against the deployed endpoint. Neither arm produced an agent finding on any case, and `eval/verifier.py` reports `accepted: false` ([docs/evaluation/v0.2-verifier.md](../../../docs/evaluation/v0.2-verifier.md)). Blockers:
- agent prompts include the repository-scale runner graphs, which exceed the token allowance before any model call (10 cases);
- 240-second Workflow step timeouts or runner analysis failures (8 cases);
- git submodules are rejected by the CLI (4 cases);
- review submissions return HTTP 400 (2 cases);
- malformed model output (1 case).

The harness also scores only `complete` reports, which the hosted runner never produces while it skips typecheck, lint, coverage and the OSV audit. Owner labels (`docs/evaluation/v0.2-verifier/labels.json`) remain to be adjudicated. The change is therefore not archived.

Local checks on this branch: `cargo fmt --all --check` and `cargo clippy --workspace --all-targets --locked` passed. `cargo test --workspace --locked --no-fail-fast` passed 313 tests; one failure (`rio-client` `snapshot::tests::uploads_only_missing_contents_once_and_retries_transient_failures`, a mock socket `WouldBlock` while the live run loaded the machine) passed on three reruns. Worker `npm run check` and 116 tests passed, the eval harness passed 86 tests, and `openspec validate --specs` and `openspec validate rio-v0-2-review-convergence --strict` passed.

## Archive record (2026-11-07)

Archived at the owner's decision with task 1.1 open. The blockers listed above were fixed and merged in PR #5 (`bc6912d`): bounded graph excerpts in agent prompts, graphs bounded to 2 MiB per version in submissions, lenient manifest parsing in the runner, submodule entries omitted from snapshots, a repair turn for replies in native tool syntax, review budgets sized for agents and voters together, and audit responses without graph bodies. Pilots against the redeployed endpoint on CL-PY-04, CL-PY-03, HS-RS-02 and CL-TS-01 then ran end to end in both arms with reproduced or static-proven findings and complete quorum votes, at USD 0.5 to 1.3 per arm. The full 24-case comparison has not been rerun, the owner labels are not adjudicated, and the harness still scores only `complete` reports while the hosted runner skips typecheck, lint, coverage and the dependency audit. The v0.2 precision gate therefore remains unmeasured; the rerun is tracked as the v0.3 stage 1 follow-up in `docs/v0.3-sequence.md`, and the acceptance comparison requirement lives on in the `eval/noise-and-incidents` main spec.

## Owner acceptance (2026-11-08)

Task 1.1 closes on the live run of 2026-11-08 (`docs/evaluation/v0.2-verifier.md`): both arms on 23 of the 24 approved cases (HS-RS-03 dropped by the owner as unrunnable within the wall budget), `accepted: true` with the owner adjudicating every rendered agent finding as a true positive and confirming every label without an independent review. Owner-adjudicated precision is 100 % in both arms; 8 of 11 scored high-severity controls were detected by both arms, so the quorum lost none to the baseline. The scoring rule now treats reviews that are incomplete only because the hosted runner skipped deterministic checks as scorable. The models were reached through OpenRouter until its credit limit and through the account's AI Gateway custom providers afterwards; the manifest records the route per case.

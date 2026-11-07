# Tasks

## 1. Measurement baseline

- [x] 1.1 Add the `graph-bench` example to `rio-graph`. It takes a repository path plus base and head refs, and prints build time, files parsed, bytes parsed, nodes, edges and truncation. It has an option to build with one thread and with N threads and compare the slices. Copy the current `slice` implementation to a test-only `legacy_slice`. Verify by running the bench on a small fixture repository and on the ruff clone at HS-RS-04 (base `2a959ef3f212`, head `5b475b45aa02`) with a 300 s cap. Record the baseline timings, or the point at which it is still running, in this file.

Baseline (2026-11-07, this machine, today's builder, one thread):
- **rio repository** (`HEAD~3`, 43 changed files): 170 s; 257 files and 4.2 MiB parsed; 841/1,414 nodes; not truncated.
- **ruff HS-RS-04** (`2a959ef3f212`): stopped at the 300 s deadline, which it noticed only after 362 s. It had 9 base nodes and 0 edges, after parsing 198 files (1.7 MiB).
- **For comparison:** parsing every one of ruff's 5,431 Rust and Python files once takes 72 s in total.
- **Profile:** the time goes into tree-sitter parses issued by `resolve_rust`, which re-parses a crate's whole module tree for every import it resolves (design D7).

## 2. Indexed expansion

- [x] 2.0 Cache Rust manifests, crate names and crate module maps per slice (design D7). Verify that the Rust graph fixtures and `legacy_slice` equivalence pass, and that `graph-bench` on the rio repository (`HEAD~3`) gives the same nodes and edges in a fraction of the baseline time.
- [x] 2.1 Compile ignore rules once per slice. Verify that the existing ignore and exclusion graph tests pass, and that a new test with nested `.gitignore` re-include rules matches `legacy_slice`.
- [x] 2.2 Build the per-version token index and use it to select candidate files, with the full-scan fallback for terms that are not single tokens. Verify with unit tests for the token rules (ASCII, `_`/`$`, non-ASCII, substring hits such as `myargs`, and a hyphenated stem fallback), and that `legacy_slice` equivalence holds on every graph fixture.
- [x] 2.3 Add the per-file occurrence index (identifiers by name, in source order). Verify that `legacy_slice` equivalence holds on the fixtures and on a generated repository of at least 2,000 files with aliased imports, test files and a common module stem.
- [x] 2.4 Parse newly needed files in parallel. Verify that a test builds the generated repository with 1 and 8 threads and gets identical serialized slices, and that `cargo test -p rio-graph` passes.

## 3. Deadlines

- [x] 3.1 Use `build_until` with a 120 s graph budget in `rio-cli` endpoint mode, and with `limits.wall_ms` minus a margin (15 s, or a quarter of a shorter limit) in `rio-runner inside`. Share the truncation-reason notes with `rio-engine`. Verify with a test where an always-expired deadline gives a truncated slice and the deadline note in the endpoint report, and with runner unit tests for the deadline computed from the header.

- [x] 3.2 Return analysis artifacts separately from command output with a 12 MiB cap (design D8): `limits.artifact_bytes` in `createJob`, `execute.py` capture, Worker `validateResult` and the Sandbox limit check. Verify with:
  - executor tests: an artifact above 1 MiB is returned with empty stdout; an artifact over its cap is truncated without an artifact; `run` output is still cut at 1 MiB;
  - Worker tests: an oversized artifact is rejected;
  - the `RIO_TEST_DOCKER=1` runner tests with the rebuilt image.

## 4. Integration

- [x] 4.1 Run the full local suites: `cargo fmt --all --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings`, `cargo test --workspace --locked`, the `RIO_TEST_DOCKER=1` runner tests with a rebuilt image, and the Worker and eval suites. Verify that all pass, then push so hosted CI passes on Linux, macOS and Windows.
- [x] 4.2 Re-run `graph-bench` on the ruff case. Verify that it completes without reaching its deadline (the node cap may truncate it), well within 120 s, with identical slices for 1 and N threads. Record the timings next to the baseline from 1.1.
  Measured on 2026-11-07, this machine, ruff HS-RS-04:
  - 1 thread: 38.9 s; 2 threads (the container's CPU count): 25.3 s; 8 threads: 16.1 s.
  - Each run: 3,682 files and 25.3 MiB parsed, 2,000/2,000 nodes and 3,306/3,306 edges, deadline not reached (stopped at the node cap).
  - The 1- and 8-thread slices were identical.
  - rio `HEAD~3`: 12.6 s, against 170.3 s for the legacy builder, with identical slices.
- [x] 4.3 Redeploy with `rio deploy` and the rebuilt runner image, then run the live endpoint review of HS-RS-04. Verify that the CLI leaves graph building and uploads, and that the runner `graph`/`checks` job finishes within its wall limit. The resulting report and upload statistics also complete task 5.2 of `rio-v0-2-large-snapshots`.
  Live run on 2026-11-07, review `4b83a147-bb1c-440c-8ac6-db4df5c48ade`:
  - **CLI:** built the graph (stopped at the node cap) and uploaded; the whole review took 198 s.
  - **Container jobs:** `graph` and `checks` exited 0 within the wall limit, untruncated, with 3.17 MiB and 3.03 MiB artifacts. The secrets check passed; the toolchain checks were skipped offline.
  - **Status `partial`:** "token budget exhausted" in the agent phase (a profile budget, outside this change).
  - **Fixes found on the way:** the archive's ASCII name field (commit 5528ab5) and the separate artifact bound (task 3.2).

## Workflow follow-up

- Task 5.2 of `rio-v0-2-large-snapshots` was marked complete from 4.3, and that change was archived on 2026-11-07. Task 1.1 of `rio-v0-2-review-convergence` resumes next.
- Archived 2026-11-07. At archive time the legacy builder was removed: the `legacy` feature, the equivalence checks and the benchmark's `--legacy` options. The thread-determinism test and `graph-bench --compare-threads` remain.

# Independent automated Rust assessment

Reviewer: `sub-agent rust_acceptance`; all verdicts are automated. Runtime validation took place on Linux. No claim of human review or exhaustive absence of defects is made.

## ripgrep #3564

The PR changes only the Unix `file_name` helper and adds tests in `pathutil.rs` and `walk.rs`. The old helper rejected every final byte `.`; thus `.hidden.`, `.hidden..`, and `...` escaped hidden-file filtering. The head implementation obtains the final component and rejects exactly `.` and `..`, retaining real names ending in a dot. The non-Unix implementation still delegates to `std::path::Path::file_name`.

I inspected the complete two-file diff and the caller `is_hidden_path_only`. I ran `cargo test --locked -p ignore`: 188 unit tests, 6 integration tests, and 7 doc tests passed. To independently establish the tested behavioral change, I retained the head regression tests but replaced only `pathutil.rs`'s implementation with its exact base version. The new walker regression failed (exit 101): the base incorrectly included the hidden dotted names and descendants. I restored the exact head source afterward; tracked Git status is clean. Logs and commands are retained next to this file.

The final Rio run typechecks both the changed member and its dependent root package on head and base, and both coverage runs pass. It produces no findings or untested-change risks. I judge that useful compile/coverage assurance for this clean fix. Its graph is truncated at the review deadline, so its `test_referenced: false` result is not evidence that the changed helper has no tests. Formatting is explicitly skipped because the default stable toolchain lacks rustfmt. No introduced production defect or independently established missed defect was found.

## Rio #1

This is the repository's actual merged initial implementation PR, rather than a seeded change. Its full diff contains 1,372,008 added/deleted lines, largely prior evaluation/release evidence. The preserved Rust/Cargo diff covers the implementation while the full diffstat records every changed file. The Rio review itself retains the full selected source and uses no exclusion override.

Independent source inspection focused on the Git materialization/cache boundary, source-copy isolation, finding classification contracts, and the related tests. I ran the actual head's core/profile/git/graph component tests separately from Rio. The multi-crate run had 32 passing tests and one materialization concurrency test failure on a two-second preparation deadline under concurrent load; the isolated concurrency test passed. The separately rerun profile/graph suites passed another 24 tests. The earlier parallel attempt also hit preparation deadlines. These observations establish timing sensitivity in this environment, not a new production correctness defect. The evidence does not claim full CLI/toolchain or cross-platform validation of the older PR.

The full-PR Rio run is limited by preparation/check scheduling and its four-minute fast budget. Explicit cancellation or an incomplete document cannot establish Rust correctness, and no useful actionable finding is inferred from a zero-finding incomplete review. The final per-PR verdict and measured elapsed time are recorded in `../agent-rust.json` after the process completes. No independently established missed production defect is claimed.

## Aggregate recommendation

**No-go.** Preserve the prior ten-PR record and its independently reproduced missed regressions. The additional Rust records establish language coverage and demonstrate useful package-scoped typecheck/coverage on ripgrep, but they do not establish standalone usefulness in ten real PRs. Stable release must remain blocked. This is an automated aggregate recommendation, not a human verdict.

# Rust acceptance evidence (automated)

Independent reviewer: `sub-agent rust_acceptance` (automated). No human verdicts are claimed.

The two selected merged pull requests are Rio #1 and ripgrep #3564. `*-pr.json` pins their upstream metadata and exact base/head commits. `rio-diffstat.txt` lists the full Rio change; `rio-rust.diff` preserves its Rust/Cargo source diff (the full PR also adds approximately 100MB of prior evaluation/release evidence). `ripgrep.diff` is the entire smaller PR diff. The reviewer inspected the relevant source and regression tests, rather than treating PR descriptions as proof.

`*-report.json` and `*-stderr.txt` are actual current-binary Rio outputs in branch mode. `*-invocation.json` records commands, timing and exit status. Profiles extend `rio/base`, use a four-minute fast budget, and run offline. Offline disables OSV but does not isolate tool/test subprocess networking. Upstream dependencies are permitted to resolve/download through Cargo; no Rio endpoint or model provider is configured.

`*-independent-tests.*` record separately invoked upstream tests. The ripgrep base reproduction runs the head's new walker regression test with the base's `pathutil.rs` implementation; exit 101 is the expected failing control. The unmodified head passes its 201 tests. Rio's initial multi-crate test run exposed short two-second materialization-test deadline failures under concurrent load; the serial retry had one such failure, while the isolated concurrency test passed. Those timing observations are limitations, not an independently proved production defect. Additional profile/graph tests ran separately because Cargo stopped the first command on the materialization failure.

The Rio checkout's ignored `target` symlink points to the existing workspace's target cache to reuse compiled dependencies. Its selected tracked source is unchanged. Ripgrep uses its own ignored target directory. No upstream changes, commits, pushes, or comments are made.


Prior-pass observations and final reruns

The first pass discovered two review-tool problems, which the parent corrected before rebuilding and rerunning both full PRs: an affected root package was selected with `--workspace` instead of `-p ripgrep`; and cargo-llvm-cov 0.9.1 ignored `CARGO_LLVM_COV_NO_AUTO_INSTALL` (its supported refusal setting is `CARGO_LLVM_COV_SETUP=no`). The first ripgrep pass installed the default stable toolchain's llvm-tools-preview component through its default-Yes setup prompt; this observed behavior is retained honestly as prior-binary evidence. Final runs use the corrected component preflight and explicit refusal setting. `*-prior-*` holds those original reports/timings. `prior-findings-assessment.json` independently classifies the first pass's single unchanged nightly-benchmark diagnostic as noise. These review-tool observations are not represented as newly introduced defects in upstream ripgrep or the reviewed older Rio PR.

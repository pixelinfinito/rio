# Rust sample workspace

`core` and `cli` build and test with the pinned toolchain. `cli` depends on `core`.
The lockfile intentionally pins chrono 0.4.19 (RUSTSEC-2020-0159).
`core` contains an untested function, type-only module, impl method, clippy lint,
inline tests, and a fake credential. `cases/` contains source patches used by
integration tests: append base-errors.rs before the base commit, replace it with
head-errors.rs for the head, and append format.rs to seed a formatting difference.
Keeping compile errors in patches lets the unmodified fixture build and test.

Run `cargo test --locked --manifest-path tests/fixtures/rs-sample/Cargo.toml`.

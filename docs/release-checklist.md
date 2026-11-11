# v0.1 release validation

A checked box records actual evidence. Source code or a workflow definition alone does not establish that a release ran successfully.

- [x] Corrected CI passes, including a negative check with Ruff removed under `RIO_REQUIRE_TOOLS=1`; the first-push failures remain recorded below (user-accepted exception, 2026-11-05).
- [x] Unix installer checks pass on Ubuntu and macOS; PowerShell checks pass on Windows with 5.1 and 7.
- [x] Cold/warm benchmark has ten runs of each, p50/p95 and per-check breakdown, with cold p50 at most four minutes or a linked performance issue.
- [x] Twelve real PRs across five repositories and TypeScript, Python and Rust (including Rio itself) have complete independent automated verdicts and a go/no-go conclusion in `docs/evaluation/v0.1.md`.
- [x] A fork release of `v0.1.0-rc.1` has six archives, LICENSE/README per archive, matching SHA256SUMS, tagged installers and verified provenance.
- [x] The RC is marked pre-release and `releases/latest` is unchanged.
- [x] Forced asset-upload failure leaves only a draft; rerun replaces that draft, while published releases cannot be modified.
- [x] Published Unix installer succeeds on Ubuntu, Alpine and macOS arm64; `rio --version`, `rio doctor` in a fixture repository, and uninstall work.
- [x] Published PowerShell installer succeeds on Windows x64 in both shells; version, doctor and uninstall work.
- [x] Stable tag is permitted only after the acceptance record is complete and says go.

Local validation completed during implementation is recorded in the OpenSpec task checklist. Platform and published-release evidence must include run URLs, platform/architecture, exact tag and commit, and observed results here before the corresponding gate is checked.

## Local evidence (2026-11-04)

- Rust 1.99.1 on Linux x86_64: `RIO_REQUIRE_TOOLS=1 cargo test --workspace --locked` passed 163 tests with no ignored tests. `cargo fmt --all --check` and `cargo clippy --workspace --all-targets --locked` passed.
- All fixture-owned TypeScript, Python and pnpm workspace tests passed. Removing the fixture's Ruff executable made the required-tool end-to-end test fail immediately; restoring it made the positive run pass.
- Unix installer: ten tests passed on Ubuntu, including a different filesystem (`/dev/shm`, mounted noexec) and rollback. ShellCheck passed. PowerShell ScriptAnalyzer passed locally; Windows execution requires CI evidence below.
- Release publisher: nine fake-GitHub lifecycle/package tests passed, including forced upload failure, draft replacement, published-release refusal, exact asset/checksum membership, corrupt download and failed provenance verification.
- Ten real PR records from Immer, pydantic-settings and structlog are complete. Independent **automated** aggregate verdict: **no-go**, with 1 useful/9 not-useful assessments, no true positives and two reproduced missed regressions. The record-only checker passes; the stable-release checker correctly rejects no-go.
- External validation repository authorized by the user: https://github.com/mctlisboa/rio-v01-validation-20261104. Release candidates and CI use this temporary public repository; no upstream stable release is authorized or claimed.
- Process-supervision task 5.2 is verified on Linux and Windows by [CI 41911107532](https://github.com/mctlisboa/rio-v01-validation-20261104/actions/runs/41911107532), and on macOS 26 ARM by [its macOS job](https://github.com/mctlisboa/rio-v01-validation-20261104/actions/runs/41911107532/job/126858578168): timeout, cancellation, output-limit handling, redaction, spawn failure, and Unix signal-resistant descendant cleanup all passed. The run's unrelated failures are documented below.

## First pushed CI run

- Commit `8ea5d63f675a9208f39fe9064a3d0599bc3e7967`: [CI run 41905465387](https://github.com/mctlisboa/rio-v01-validation-20261104/actions/runs/41905465387). The Windows supervision job passed four tests but the timeout test expired after 750 ms before Python wrote its grandchild PID. The fixture now allows three seconds; the worker still sleeps for an hour, so the test continues to verify actual timeout termination. This initial run is not reported as green.

- The same initial run's Ubuntu suite reached the Git repository tests, where a merge fixture relied on a globally configured Git identity. The merge stopped before creating a conflict. Test repositories now configure their own identity, and the conflict test verifies conflict markers before exercising Rio. This is a test-isolation correction; the original failure remains part of the first-run record.

- Corrected commit `1a534ec366bd558a76f2e48b35af8b133c8a1ae7`: [CI run 41906943826](https://github.com/mctlisboa/rio-v01-validation-20261104/actions/runs/41906943826) passed Ubuntu and Windows, including both PowerShell shells, then the queued macOS 15 job was cancelled in favor of available macOS 26 ARM capacity. The first macOS 26 run caught an unused test variable under warnings-as-errors; the interrupt test now also checks worker survival on macOS.

- Commit `cac03d923e26de5045af2038c31cc096d9e27a95`: [CI run 41908450971](https://github.com/mctlisboa/rio-v01-validation-20261104/actions/runs/41908450971) passed Ubuntu and Windows. macOS exposed inherited nonblocking mode on the audit test server's accepted sockets. The fixture now explicitly selects blocking reads; all six focused audit tests pass locally.

## Release candidate validation

- The initial tag `v0.1.0-rc.1` pointed to `76c9b457f0ea541c145465101055d89c85c94e49` in the temporary public validation repository. [Release run 41910039900](https://github.com/mctlisboa/rio-v01-validation-20261104/actions/runs/41910039900) ran the complete CI gate before building or publishing. The repository variable `RIO_FORCE_UPLOAD_FAILURE=1` requested a deliberate upload failure for the first publication attempt.
- A local `cross 0.2.5` build of `x86_64-unknown-linux-musl` succeeded in an isolated target directory. `file` identifies a static PIE executable; `--version` reports the supplied `0.1.0-rc.1`, target and commit. `Cross.toml` passes release version and commit through to the container. Rootless local Docker required container UID/GID zero; GitHub's rootful Docker jobs use the normal defaults.
- The first RC workflow's Windows timeout fixture expired before its PID file was created, despite passing on the same commit in [branch CI 41909872295](https://github.com/mctlisboa/rio-v01-validation-20261104/actions/runs/41909872295). The Windows timeout budget is now 15 seconds, with a 30-second readiness budget for the cancellation fixture. Neither changes the one-hour worker lifetime or the requirement to confirm descendant termination. All six Linux supervision tests pass after this fixture correction.
- That RC attempt also exposed canonical-path mismatches in workspace and Python editable dependency detection on macOS (`/var` versus `/private/var`). Link discovery and compatibility now compare canonical roots. Three existing compatibility tests use an explicitly aliased worktree so Linux exercises the same case; all 13 compatibility tests pass locally. No assets were built or published by this failed attempt.
- [CI run 41911107532](https://github.com/mctlisboa/rio-v01-validation-20261104/actions/runs/41911107532) passed Ubuntu and Windows, including the adjusted timeout test. macOS passed dependency-link checks, supervision and end-to-end fixture tests, but exposed an ESLint target alias and two fixture assumptions. A separate Linux reproduction confirmed ESLint reported `File ignored because outside of base path` for an aliased absolute target. Commands now resolve the disposable root before constructing cwd and targets; the real-tool test explicitly uses an alias. Doctor's fixture compares canonical paths, and the case-only rename fixture uses `git mv -f` to update the index on case-insensitive filesystems.

## Corrected platform CI

- Commit `d07dfa8f337333348db6622044b4f906c590625c`: [CI run 41912745695](https://github.com/mctlisboa/rio-v01-validation-20261104/actions/runs/41912745695) passed Ubuntu 24.04 x86_64, macOS 26 ARM64 and Windows 2025 x86_64. Both Unix jobs passed fmt, Clippy, the full workspace suite with required tools, fixture suites, the missing-Ruff negative check, ShellCheck, ten installer tests, nine release lifecycle tests, the automated acceptance completeness check and profile-reference freshness. Windows passed supervision, CLI build, ScriptAnalyzer, and installer checks in PowerShell 7 and 5.1.
- The macOS installer test created and mounted a separate HFS+ disk image and verified successful installation there. Windows used a temporary VHD; Linux verified rollback on a separate noexec filesystem. Task 12.3 is complete.
- On 2026-11-05, the user accepted the green rerun for task 10.3 while retaining the first-push failure record. This explicitly replaces the original requirement for a green first push. [Final implementation/evidence CI 41918738887](https://github.com/mctlisboa/rio-v01-validation-20261104/actions/runs/41918738887), commit `ee2a22fb1cccd60dcebf28de8512cfec5d4c8f6f`, passed Ubuntu, macOS and Windows. Task 10.3 is complete under that accepted exception; the original Windows and Ubuntu failures remain recorded above.

## Actual forced-upload failure

- At commit `916f34d87b2427e27939550c45bda19cb6a1f5fd`, [release run 41914231087](https://github.com/mctlisboa/rio-v01-validation-20261104/actions/runs/41914231087) passed all platform checks and all six release builds, native installer smoke tests, the ARM Linux QEMU smoke test, exact version/target/commit assertions, and provenance attestation generation.
- The publisher retried the deliberately failing fourth upload and stopped with `Upload failed; release remains a draft`. Authenticated release-list inspection found exactly one release, draft ID `434473573`, with only `SHA256SUMS`, `install.sh` and `install.ps1`. No published release existed, and `releases/latest` returned HTTP 404, matching the baseline. The observed metadata is saved in [forced-upload-draft.json](release-evidence/forced-upload-draft.json).
- GitHub's lookup by tag returned 404 for this existing draft, while its authenticated release list included it. The publisher now searches all paginated release-list pages, refuses any matching published release before mutation, and deletes matching leftover drafts. The local GitHub double now reproduces draft tag-lookup 404 and a matching release on a later page. The existing failure/replacement regression failed before this correction and passes afterward.

## Published RC and recovery evidence

- Final tag `v0.1.0-rc.1` points to **`abb02751de7cd95dac021da3f21b02bb89425eef`**. [Recovery release run 41916670430](https://github.com/mctlisboa/rio-v01-validation-20261104/actions/runs/41916670430) passed every check, all six target builds, installer smokes, provenance creation, draft download verification and publication. The corrected publisher deleted the actual leftover draft `434473573` (its API URL now returns 404) and created release `434484343`.
- Published RC: https://github.com/mctlisboa/rio-v01-validation-20261104/releases/tag/v0.1.0-rc.1. API metadata confirms `draft=false`, `prerelease=true` and exactly **15 assets**: six archives, six attestation bundles, SHA256SUMS and both tagged installers. `releases/latest` still returns HTTP 404. [Published metadata](release-evidence/published-release.json) preserves asset sizes and server digests.
- Independent download verification checked the exact asset set, every archive checksum, exactly `rio`/`rio.exe`, LICENSE and README per archive, executable Unix modes, and all six cryptographic provenance bundles using checksum-verified GitHub CLI 2.103.3. Each signed statement names the matching archive digest, release workflow, tag and final source commit. [Download verification](release-evidence/download-verification.json) records all target hashes and results. Task 12.4 is complete.
- The forced-failure repository variable was deleted before the recovery run. No stable release was published; automated real-PR acceptance remains **no-go**, and the stable-tag gate rejects it.

## Published installer evidence

[Installer run 41918223523](https://github.com/mctlisboa/rio-v01-validation-20261104/actions/runs/41918223523) passed every job against the published RC assets using the temporary repository's HTTPS download URL. Task 12.5 is complete.

| Platform | Architecture | Installer and shell | Observed result |
| --- | --- | --- | --- |
| Ubuntu 24.04 | x86_64 | install.sh, Bash | Install, exact version/target/commit, JSON doctor in committed fixture, uninstall passed |
| Alpine 3.21 | x86_64 | install.sh, ash | Published HTTPS install, version, JSON doctor in committed fixture, uninstall passed |
| macOS 26 | ARM64 | install.sh, Bash | Install, exact version/target/commit, JSON doctor in committed fixture, uninstall passed |
| Windows 2025 | x86_64 | install.ps1, Windows PowerShell 5.1 | Install, exact version/target/commit, JSON doctor, uninstall passed |
| Windows 2025 | x86_64 | install.ps1, PowerShell 7 | Install, exact version/target/commit, JSON doctor, uninstall passed |

Downloaded doctor artifacts from all four runner jobs parse as JSON with no blocking problems. Ubuntu's separate Alpine step also passed. [Installer evidence](release-evidence/published-installers.json) records job URLs, observed binary versions and successful steps. All versions report `0.1.0-rc.1` and source commit `abb02751de7cd95dac021da3f21b02bb89425eef`.

## Rust adapter continuation (2026-11-05)

- Local Linux x86_64, Rust 1.99.1: `RIO_REQUIRE_TOOLS=1 cargo test --workspace --locked --no-fail-fast -- --test-threads=2` passed 253 tests with zero failures and zero ignored tests after rebuilding workspace artifacts without concurrent acceptance-checkout builds. An earlier overlapping run used conflicting shared-target artifacts; its failures are not claimed as a successful validation.
- The final focused Rust adapter suite passed 13 tests, including the subsequent trusted/no-lock regression; the Rust-focused engine suite passed three tests. `cargo clippy --workspace --all-targets --locked`, `cargo fmt --all --check`, and `git diff --check` passed.
- The pinned Rust fixture's own tests passed. Its CLI integration covers working-tree, staged and branch selections in JSON, terminal and Markdown. Cargo/Clippy/rustfmt recorded-output cases, failed-test coverage retention, zero-test handling, type-only coverage, workspace-root package scheduling, target isolation, and the recorded chrono OSV advisory are exercised locally.
- With an isolated PATH and Cargo home hiding cargo-llvm-cov, the required-tool coverage integration failed with `required fixture tool missing: cargo-llvm-cov`, as intended. The checked-in CI workflow installs cargo-llvm-cov 0.9.1 and llvm-tools-preview and runs the corresponding negative check. These new workflow changes have not been pushed or run on hosted CI during this continuation; earlier platform results above describe their recorded revisions.
- OpenSpec validation and the generated profile reference checks passed. OpenSpec retains requirement-length warnings.
- Acceptance now records 12 real PRs from five repositories across TypeScript, Python and Rust, including Rio #1. Independent automated verdicts are two useful and ten not-useful. The record-only gate passes; the stable-release gate rejects the preserved **no-go** conclusion. See [the acceptance record](evaluation/v0.1.md) and [Rust evidence](evaluation/rust/README.md).
- CodeRabbit authentication status succeeded, but the review request failed before analysis with a session/Git-provider authentication error. No CodeRabbit validation is claimed. No commits, pushes or releases were made in this continuation.

# v0.3 release gates

The PRD's v0.3 exit criteria (`docs/PRD.md`, release table; `docs/v0.3-sequence.md`, exit criteria mapping). As above, a box is checked only with recorded evidence: the command, its inputs (pinned report and noise run paths) and its output.

- [ ] False positives per agent are below 15 %: `python3 -I eval/gate.py gate --baseline BASE.json --candidate CAND.json --false-positive-rate REPORT.json [...] NOISE-RUN-DIR [...]` passes over the posted agent findings of the reference set and the adjudicated noise runs. Each agent's rate is `wrong / responses`; a noise finding adjudicated `harmful` counts as `wrong`. Agents with fewer than 30 responses are listed in the gate notes and are not gated; record them here with their counts.
- [ ] The council beats the verifier-only baseline on the `plausible` bucket, or the council step is removed (`rio-v0-3-council` keep-or-remove rule): run `python3 -I eval/council.py summarize --outcomes OUTCOMES.json --council RUN-DIR --baseline RUN-DIR --out SUMMARY.json` for every A/B run of the release cycle (both arms on the same cases on the same day), then `python3 -I eval/gate.py council --summary SUMMARY.json [...]`. It passes (KEEP) only when the cycle's disagreement rate is at least 5 % and the council's accuracy exceeds the verifier-only accuracy on the same cases. When it fails (REMOVE), remove the `rio/council` step from the `rio/security` and `rio/critical` profiles in this release (leave it present and disabled, as in `rio/base`) and record the gate output here.

# Interactive UI and PR comments (`rio-tui-pr-comments`)

Checked locally on 2026-11-10 (Linux x86_64, Rust 1.99.1): the workspace tests, the Worker suite, `cargo clippy --workspace --all-targets` and `cross build --release --locked -p rio-cli` for `x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl` (with `CROSS_ROOTLESS_CONTAINER_ENGINE=1` on rootless Docker). In a pseudo-terminal emulator, `rio review --offline` ran start → live → findings → export → quit at 120×40 and printed its summary and exit code. The start screen stayed readable at 80×24, every drawn character was ASCII with `RIO_ASCII=1`, Ctrl-C twice exited 130 with the terminal restored, and `q` before a run exited 0. Still to do before release:

- [x] The workspace builds and its tests pass on macOS 26 and Windows 2025 (pull request #20's CI, debug profile).
- [ ] Release builds pass on all six `release.yml` targets (at tag time; ratatui, crossterm and ratatui-image are new dependencies).
- [x] `rio review`, `rio qa` and `rio init` in real terminal emulators (2026-11-11). In tmux 3.4 at 120×40 and 80×24 every captured row is exactly the terminal's width, and Ctrl-C twice exits 130 and leaves the alternate screen. In GNU screen 4.09 with `cjkwidth on` (ambiguous-width characters drawn wide), `RIO_ASCII=1` keeps the start screen's divider in one column on all 22 captured rows with no non-ASCII character, and Ctrl-C twice exits 130. Without it, the divider shifts on the rows holding `·`, as expected. tmux first showed that keys were lost after image detection: ratatui-image's query thread outlives a query the multiplexer does not pass on. Rio now asks the terminal itself, with a deadline, and uses half-blocks under tmux and screen.
- [x] Image protocols against emulated replies (2026-11-11): answering as kitty (`_Gi=31;OK`), as a sixel terminal (device attribute 4) and as iTerm2 (`TERM_PROGRAM`), the cell detail of the `missing-cancel` run wrote kitty transmit, sixel DCS and OSC 1337 images respectively, and half-blocks to a terminal that answers neither.
- [ ] The same screenshot in graphical kitty, iTerm2 and a sixel terminal (WezTerm or foot), checked by eye.
- [ ] A live local `rio qa` run (QA image rebuilt with this branch's controller) through pause, cancel of the running and of a queued cell, a failed cell's detail and its rerun. On 2026-11-11 this machine's run stopped before any model call: the gateway route's key is in a host keychain that was locked, and the Codex login is an API key, not a subscription. The controller, runtime and host paths are covered by tests (`executePlan` pause and cancel, `LiveSync`, `LiveFiles`, the TUI reducers).
- [x] One pull request round against the live endpoint (mctlisboa/myPA#48, 2026-11-10; see `docs/release-evidence/pr-comments-2026-11-10/`): comments render in the new format, a pasted footer reply dismisses its finding, a second round edits in place with no second summary, and a finding with an in-hunk `fix` shows Commit suggestion.
- [x] The new comments checked in GitHub light and dark mode, with screenshots in `docs/release-evidence/pr-comments-2026-11-10/`. The fixed (✅) edit was not exercised live: both rounds were incomplete (the runner skipped typecheck and lint), and an incomplete review never marks earlier findings fixed.

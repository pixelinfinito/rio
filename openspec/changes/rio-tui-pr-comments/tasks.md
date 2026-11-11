# Tasks

## 1. Design assets and shared foundations

- [x] 1.1 Copy the handoff's text assets into `docs/design/tui-pr-comments/` and verify every `screen.txt` row is 120 (G3: 80) cells by `unicode-width`.
  - From the handoff's `tui/`: `screens.json`, `tokens.json`, `glyphs.json`, and each screen's `screens/*/{screen.txt,spans.json,screen.ans}`.
  - From `pr-comments/`: the `markdown/*.md` bodies.
  - Both READMEs, with the open decisions marked resolved: 8-char ids, ASCII set, auto TUI, one change.
  - No PNG or PDF files.
- [x] 1.2 Add the optional `fix { line_start, line_end, replacement }` to `schemas/finding-v1.json`, `hypothesis-v1.json` and the embedded definitions in `report-v1.json`. Regenerate the validators and add the field to `rio-core::model::Finding` with `skip_serializing_if`. Verify the schema tests: valid fix, missing fix, and inverted range rejected by the verifier rule.
- [x] 1.3 Make the verifier keep `fix` only when the range is valid and inside the primary location's file, and drop it otherwise. Verify with an engine test that an inverted range keeps the finding and drops `fix`.
- [x] 1.4 Add `rio-core::glyphs` with `UNICODE` and `ASCII` sets. Verify with a unit test that the paired glyphs have equal widths and every ASCII glyph is ASCII.
- [x] 1.5 Wire `--ascii`/`RIO_ASCII=1` into `render.rs`. Verify with an `insta` snapshot of the streaming report under ASCII, and a test that its output bytes are all < 0x80.
- [x] 1.6 Display 8-char ids in the terminal and Markdown renderers. JSON and SARIF keep full ids. Verify with snapshot updates and a test asserting full ids in JSON.
- [x] 1.7 Add optional `family` and `rounds[{round, real|abstained+cause, changed}]` to finding-v1 `council.members[]` (schemas, Rust model, worker types) and fill them in the council step from member config and round 1/2 assessments. Verify with a schema test and a council-step test for a changed position and a timeout.
- [x] 1.8 Add the optional security `trace { catalog_item, change, steps[{role, path, line_start, missing?}] }` to finding-v1, built by `findingOf` from security hypotheses' ordered `locations`, `catalog_item` and `trace_change`. Verify with a schema test and a consolidation test for a removed check.

## 2. Feedback id prefixes

- [x] 2.1 Move `resolvePrefix` into `worker/src/feedback.ts`, scoped to tenant and optional lineage, and use it from `/rio dismiss` and `POST /v1/findings/{id}/feedback`. The endpoint returns 400 for prefixes shorter than 8 and 409 with candidates when a prefix is ambiguous. Verify with worker tests for a unique prefix, an ambiguous prefix, a short prefix and a full id.
- [x] 2.2 In `rio feedback`, reject ids shorter than 8 with exit 2 before any network call and map 409 to exit 3 listing the candidates. Update the `cli.rs` tests using `8c1e`. Verify with `cargo test -p rio-cli feedback`.
- [x] 2.3 Update the `rio feedback` help text and `docs/finding-history.md`/`docs/github-app.md` to say ids are 8+ characters. Verify the documented commands run against the test endpoint fixture.

## 3. PR comment rewrite

- [x] 3.1 Add `worker/src/comment/glyphs.ts` with the one-emoji-one-meaning table and `proof(f)`. Replace `EVIDENCE` in `publish.ts`. Verify that a unit test finds no ✅ in any open-finding body across every evidence level.
- [x] 3.2 Implement the open inline layout in `comment/finding.ts`, keeping `findingBody()`'s signature. Verify by matching `01-inline-finding.md` in `worker/tests/comment-format.test.ts`.
  - Order: the `####` title, the `<sub>` metadata with the `fail_on` marker, one paragraph, the fix, `<details>` folds (how rio knows, other locations).
  - The footer has the 8-char id and the pasteable reply, and the unchanged marker comes last.
- [x] 3.3 Emit suggestion blocks only when `fix` lies entirely on RIGHT-side lines of the anchored hunk (`rightLines`). Fence with a backtick run longer than any in the replacement. Verify with tests for an in-hunk range, a range outside the hunk falling back to prose, a multi-line range, and a replacement containing backticks.
- [x] 3.4 Render the security and council variant (trace table, `http` reproduction, council table, OWASP coverage fold) and the QA variant (base/head screenshots, cell table, evidence links with expiry). Verify by matching `02-inline-security-council.md` and `03-inline-qa-finding.md`.
- [x] 3.5 Render the fixed, dismissed (reason-specific memory sentence, including `wrong`) and regression edits. Verify by matching `04`–`06` and with an existing `publish.test.ts` case showing the marker is byte-identical before and after a state change.
- [x] 3.6 Rewrite `summaryBody()` and `qaSummary()` and update existing `publish.test.ts` expectations. Verify by matching `07-summary.md`, plus a test that the title count equals the scoreboard.
  - Contents: the verdict title, the provenance `<sub>`, CAUTION or NOTE, the scoreboard, and the "To fix" and "Worth a look" tables with thread links or locations for unanchored findings.
  - QA: the journeys × cells table. Folds: recommendations, rounds, what ran. The footer lists the replies.
- [x] 3.7 Add `comment/limits.ts`: at most 25 rows and 10 journeys with "n more" rows, and folded sections truncated first, keeping each body under 65,536 characters. Verify with tests at 14 journeys, 40 findings and a body built to exceed the limit.
- [x] 3.8 Make agent prompts in `modules/agents/*` request `fix` for local fixes, and map ESLint/Ruff fix ranges in adapters that already parse them. Verify with an adapter fixture test producing `fix`, and the eval schema check on agent outputs.
- [x] 3.9 Add `dry_run=1` to `POST /v1/reviews/{id}/publish`, returning the bodies, anchors and check-run text. It reads the PR's diff with a read-only token and never writes to GitHub. Verify with a worker test asserting no GitHub write request and the same bodies and lines as a real publish.
- [x] 3.10 Check the redesigned comments in GitHub dark and light mode on a test PR through the live endpoint. Record the screenshots in `docs/release-evidence/`.

## 4. TUI crate and shell

- [x] 4.1 Add `ratatui`, `crossterm` and `unicode-width` to the workspace and create `crates/rio-tui` depending on `rio-core` only. Verify that `cargo build --release` succeeds for every `Cross.toml` target and that `cargo clippy` is clean. (Both musl targets built with `cross`. macOS and Windows build and pass the tests in pull request #20's CI. Release-profile builds on all six targets stay a `release.yml` check.)
- [x] 4.2 Implement the `App`/`Msg`/`Effect` reducer, the terminal guard (`Drop` + panic hook) and the 250 ms tick. Verify with a test that a panic inside `view` leaves raw mode and the alternate screen, plus reducer unit tests.
- [x] 4.3 Implement the theme tokens from `tokens.json`, `NO_COLOR` (reset colors, reversed cursor row) and the glyph set selection. Verify with a test mapping every token in every `spans.json` to a theme color.
- [x] 4.4 Implement the header bar, the key bar fed by per-screen keymap tables, the global keys, text-field focus precedence and the minimum-size screen below 80×24. Verify with `insta` snapshots at 80×24 and 79×24 and a reducer test that `q` in a focused field inserts text.
- [x] 4.5 Build the golden harness. Verify by running it on one trivial screen.
  - Fixture builders for the handoff sample data.
  - Rendering to `TestBackend`.
  - Comparison of text against `screen.txt` and of styles against `spans.json`.
  - Per-screen `deviations.toml` for the 8-char id columns.
- [x] 4.6 Add `interactive()` selection and `--no-tui`/`--ascii` to `rio-cli`, and make `--format` an `Option` so an explicit `terminal` is distinguishable from the default. Verify with a truth-table unit test and the existing `cli.rs` suite passing unchanged.
- [x] 4.7 Map Ctrl-C in raw mode to the shared `CancellationToken` and a second press to `kill_all()` plus exit 130, and print the plain summary after leaving the UI. Verify with reducer tests and a `rio-cli` test driving the app through a fake terminal.

## 5. Review and guide flows

- [x] 5.1 Add the `agent:*`, `verify:progress`, `qa:cell` and local `log` variants to `ReviewEvent`, emit them from `rio-engine`, and add the first three to `SSE_EVENTS`. Verify with engine tests for event order and the SSE contract test.
- [x] 5.2 Implement screens 00 (start, flags preselected, copy command) and 01 (live steps, step log). Verify with golden tests for `review-00-start` and `review-01-live-review` and a reducer test showing flags preselect the form.
- [x] 5.3 Implement 02 (findings hub: filters, list, detail with hunk and quorum, `refuted` as a count only) and 04 (impact graph head/base/delta with hops). Verify with golden tests for `review-02-findings` and `review-04-impact-graph`.
- [x] 5.4 Implement 03 (dismissal dialog through the `Commands::feedback` effect, and the no-endpoint message). Verify with the `review-03-lineage-feedback` golden test and a reducer test recording a reason and note.
- [x] 5.5 Implement 05 (export md, json and sarif) and 06 (exit), with the save prompt on `q`. Verify with goldens and a test that exported JSON is byte-identical to `--format json` for the same report.
- [x] 5.6 Implement G1 (palette) and G2 (help and view map) from the keymap tables. Verify with goldens and a test that every screen's key bar keys appear in G2. G3 stays a reference only: it redesigns the streaming report, which must stay byte-for-byte for scripts. Instead, verify that the streaming renderer at 80 columns under `NO_COLOR` keeps every location line within 80 columns and uses no escape sequences.
- [x] 5.7 Add a TUI section to `README.md`. Verify the documented commands run.
  - Contents: the selection rule, `--no-tui`, `RIO_TUI=0`, `--ascii` and the keys.

## 6. QA flow

- [x] 6.1 Implement Q1 (journeys, selection, run options) and Q2 (live matrix from `qa:cell`, pause, cancel a cell recorded as cancelled). Verify with goldens for `qa-q1-journeys` and `qa-q2-matrix-live` and a reducer test showing a cancelled cell.
- [x] 6.2 Implement Q3 (cell detail with base comparison, evidence and editor) and Q4 (recommendations labeled advice, copy as issue, md export). Verify with goldens and a test that no Q4 action changes the exit code.

## 7. Init flow

- [x] 7.1 Refactor `deployment.rs` into named, idempotent steps with a progress callback, keeping the non-TTY prompts. Verify that the existing deployment tests pass and the dry-run plan output is unchanged.
- [x] 7.2 Write the chosen configuration and `deployment.pending` before the first remote step, clear it on success, and offer resume on a later `rio init`. Verify with a test that a failure at `secrets` resumes there without repeating earlier steps.
- [x] 7.3 Implement I1–I6. Verify with goldens for all six screens and a test that the connect-existing screen writes the same config as `--endpoint --token-stdin`.
  - The screens: mode, configure with the `p` plan, deploying, failed and resumable (retry, self-hosted, dashboard, log), deployed, connect existing.

## 8. Team flow

- [x] 8.1 Implement P1 (security finding: catalog item, trace, council rounds with families, abstentions and timeouts, decision by evidence tier, audit record). Verify with the `team-p1-security-council` golden test.
- [x] 8.2 Implement P2 (publish preview from `dry_run`). Verify with the golden test and reducer tests for `y` (publishes), `n` (reason `ask_without_consent`, nothing posted) and `publish: never` (no publish key).
- [x] 8.3 Implement P3 (finding history from `GET /v1/findings` with filters, timeline and JSON) and P4 (proposals: `y` applies via the same code as `rio suppressions apply`, `x` declines with a reason, `N` leaves the profile unchanged). Verify with goldens and a test that `N` leaves the profile file byte-identical.

## 10. QA screenshots in the terminal

- [x] 10.1 Add `ratatui-image` (crossterm, no chafa) and `image` (PNG only) to the workspace. Verify `cargo build --release` for the Linux musl targets and that `cargo tree -p rio-cli` shows no chafa or native image library.
- [x] 10.2 Detect the terminal's image protocol and cell size once after entering the alternate screen, and keep it for the session. `NO_COLOR` and `--ascii` disable images. Verify with unit tests of the selection, and in a pseudo-terminal that a terminal answering no protocol gets halfblocks.
- [x] 10.3 Draw the focused step's screenshot in the Q3 pane from the run's evidence, with `b` for the base run, and missing, unreadable or loading states named in the pane. Verify with a test that renders a real masked PNG with halfblocks and checks the pane's colors against the image, and with the existing goldens unchanged.
- [x] 10.4 Fill each cell's screenshots in the host: local runs from `.rio/cache/qa/…`; endpoint runs by downloading the signed URL into the run cache when the cell opens (`Fetch("qa-image:<id>")`), reporting an expired link. Verify with a host test against a local file and a mock HTTP server, including an expired link.
- [x] 10.5 Open the cell detail on a real local QA run's report and cache in a pseudo-terminal (`cargo run --example qa_cell`, the `missing-cancel` acceptance run) and take screenshots of two steps. Verify the masked page is drawn, the step timeline moves the screenshot, and detection falls back to halfblocks in a terminal that answers no image query. A live `rio qa` run to a failed cell stays a release check.

## 11. Gaps closed after the first review round

- [x] 11.1 Pause and cancel in the QA controller: `executePlan` waits before the next cell while paused, aborts a running cell the host cancels and skips a queued one, recording `cancelled` with reason `user`. It reports progress as cells start, reach a step and end. Verify with controller tests for a paused queue, a cancel in flight and a cancel before start.
- [x] 11.2 The runtime's live channel: `runtime.py` copies `control.json` into the controller when it changes and `qa-progress.json` out each second; `DockerQaRuntime::execute_live` writes the host's `QaControl` and passes new progress on. The engine turns progress into `qa:cell` events. Verify with `LiveSync` and `LiveFiles` unit tests.
- [x] 11.3 The TUI host applies `qa:pause`, `qa:resume` and `qa:cancel:` to the running review's `QaControl`. It refuses them for an endpoint run, with the reason, and the matrix rolls back. Verify with host unit tests.
- [x] 11.4 `rio qa --cell <viewport>/<scheme>` and the QA step's `cell` option narrow the plan to one planned cell (engine, Docker runner and Sandbox runner). `r` in the cell detail of a finished run starts that rerun; its result replaces the cell and the first run's report stays the session's. Verify with plan, option-parsing and reducer tests.
- [x] 11.5 Screens covered while a run reports receive its events when they are on top again (a run that ends under the cell detail reaches the matrix). Verify with a reducer test.
- [x] 11.6 Endpoint base screenshots: refreshed report artifacts carry `version` (base or head) from `qa_runs`, base copies keep their own entry, and `b` finds the base screenshot by it. Verify with Worker and TUI tests; add the fields to `report-v1.json`.
- [x] 11.7 Below 120 columns `v` switches Q3's right pane to the screenshot. Verify with a 100-column test and the updated 80×24 snapshot.
- [x] 11.8 Downloaded screenshots are reused per object and pruned to seven days and 200 MB. Verify with host tests.
- [x] 11.9 Terminals that answer no query: detection reads the replies itself with a deadline (half-blocks under tmux or screen), and redraws no longer ask for the cursor position. Verify with a pseudo-terminal test that fails without either fix, and a reply-parser test.
- [x] 11.10 The palette and the quit dialog float over the faded screen they were opened from. Verify with a test.
- [x] 11.11 Repository and personal profiles appear on the start screen and in its command line by name, unless the name finds another profile. Verify with a discovery test.
- [x] 11.12 The Worker suite's 8 MB evidence test compares by digest; its deep equality had pushed the test runtime past its heap limit in CI. Verify that its peak memory drops from 2.1 GB to under 0.5 GB.

## 9. Integration

- [x] 9.1 Run the full suites: `cargo test --workspace`, `cargo clippy --workspace`, worker `npm test` and `openspec validate rio-tui-pr-comments --strict`. Verify all pass.
- [x] 9.2 Run `rio review`, `rio qa` and `rio init --dry-run` in a real terminal at 120×40 and 80×24, and once in a terminal set to CJK ambiguous-as-wide with `RIO_ASCII=1`. Verify that the grid holds and Ctrl-C twice exits 130 with the terminal restored, and add the result to `docs/release-checklist.md`. (tmux 3.4 and GNU screen 4.09 with `cjkwidth on`; `rio init` opened in the UI, since `--dry-run` prints the plan without it.)
- [x] 9.3 Run one PR round end to end against the live endpoint. Verify that comments render in the new format, a pasted footer reply dismisses the finding, a second round edits in place with no duplicate summary, and a fix shows Commit suggestion.

## Workflow follow-up

- Archive only after `rio-v0-3-core` and `rio-v0-3-council` are archived. At that point, reconcile the `pr-publishing` scenarios quoting `dismissed: <reason>` and `fixed in <sha>` with the `pr-comment-format` wording.

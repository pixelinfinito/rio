# Design

## Context

The design handoff (`rio-tui-pr-comments.zip`, grounded in `c2b6900`) is the visual source of truth. Its `screen.txt` and `spans.json` grids are exact, its sample data is illustrative, and its four open decisions were settled with the owner before this change:
- The TUI opens automatically on a terminal.
- Everything ships in one change, in phases.
- Ids are 8 characters everywhere.
- An ASCII glyph set is added.

Current state:
- **CLI renderer.** `rio-cli/src/main.rs` builds the streaming renderer (`rio-core/src/render.rs`). It colors output only when `io::stdout().is_terminal() && !--no-color` and `NO_COLOR` is unset. Ctrl-C handling is a `tokio::signal::ctrl_c` task: first press cancels a `CancellationToken`, second press calls `supervisor.kill_all()` (`main.rs:619–626`).
- **Engine events.** The engine already emits `ReviewEvent` (`step:started|finished`, `check:finished`, `graph:ready`, `finding:verified`, `review:done|partial`) over an `mpsc::UnboundedSender` (`rio-engine/src/execute.rs:70,785`). The same events are re-served as SSE.
- **`rio init`.** It prompts with `stdin().is_terminal()` checks in `deployment.rs`. Deployment steps are idempotent: "rerun rio deploy to resume", with a migration ledger. `--from <config>` replays choices.
- **PR comments.** `findingBody()` (`publish.ts:371`) and `summaryBody()` (`:775`) build comments from `EVIDENCE`/`SEVERITY` tables. They use a 12-char id and `<!-- rio:… -->` markers via `findingMarker()`.
- **Dismissal ids.** `/rio dismiss` resolves ≥8-char prefixes (`commands.ts:resolvePrefix`). `POST /v1/findings/{id}/feedback` (`feedback.ts`) matches only the full identity.
- **Change ordering.** `pr-publishing`, `finding-history` and `suppression-proposals` exist only in the unarchived `rio-v0-3-core` change. `rio-v0-3-core` also MODIFIES `cli/review` `Output format selection`. This change therefore adds requirements rather than modifying that one.

## Goals / Non-Goals

**Goals:**
- One rendering model in which the TUI is a view over the same report and events as the streaming renderer, with no second source of review state.
- Screens are testable cell-for-cell against the committed grids.
- PR comment bodies are pure functions from `(finding, state, hunk, qa)` to Markdown, golden-tested against the handoff Markdown.

**Non-Goals:**
- Mouse support, theming beyond the token set, or light terminal themes.
- A TUI for `rio profile`, `rio doctor`, `rio eval` or `rio deploy`. They are reachable from the palette as commands that print and return.
- GitLab comment formats.
- Changing what the publisher posts or when it posts. Policy, anchoring, the marker search and thread resolution stay as `pr-publishing` specifies.
- Localizing the TUI or comments.

## Decisions

### 1. New crate `rio-tui` on ratatui + crossterm
`crates/rio-tui` depends on `ratatui` (crossterm backend), `crossterm` and `unicode-width`, and on `rio-core` types only. `rio-cli` owns process concerns (args, endpoint, signals, files) and hands the TUI a channel of `UiEvent` plus a `Commands` trait for side effects such as export, feedback, publish, apply proposal and deploy step.
- **Why:** this keeps the TUI free of network and filesystem code, so every screen renders from data in tests.
- **Alternatives:** `cursive` was rejected because the handoff's spans map 1:1 onto ratatui `Span`. Building inside `rio-cli` was rejected because that crate is already 10k lines and the snapshot tests need a small dependency graph.

### 2. App architecture: Elm-style state + reducer
There is one `App` state. `update(App, Msg) -> Vec<Effect>` is pure, and `view(&App, &mut Frame)` is pure. Effects run on the tokio runtime and come back as `Msg`. Engine `ReviewEvent`s, key events, ticks (250 ms, for elapsed times) and effect results are all `Msg`.
- **Why:** reducer tests can drive whole flows (start → live → findings → dismiss) without a terminal. `view` snapshot tests use `TestBackend`.
- **Alternatives:** a widget-owned-state pattern was rejected because it couples rendering to async work and makes Ctrl-C hard to reason about.

### 3. TUI selection lives in one function
`fn interactive(args, env) -> bool` in `rio-cli` implements the terminal-ui rule: TTY on stdin and stdout, no explicit `--format`, no `--no-tui`, `RIO_TUI != 0`, `CI` empty.
- clap's `--format` default must become "unset" (`Option<Format>`), so we can tell explicit `terminal` from the default.
- Every existing CLI test sets no TTY, so they keep exercising the streaming path unchanged.
- A unit test covers the truth table.

### 4. Engine events gain progress detail, additively
The live screens need per-agent, per-verification and per-QA-cell progress, plus tool log lines. `ReviewEvent` gains these variants:
- `agent:started|finished { agent, hypotheses }`
- `verify:progress { done, total }`
- `qa:cell { journey, cell, step, outcome }`
- `log { source, line }`, bounded to the last 500 lines per source in the UI.

The SSE event list (`SSE_EVENTS`) gains the first three. `log` stays local, because tool output may contain source code.
- **Alternatives:** polling the report cache was rejected as laggy and racy.

### 5. Ctrl-C under raw mode
Raw mode delivers Ctrl-C as a key event, not SIGINT. The TUI maps the first Ctrl-C to the same `CancellationToken` that `main.rs` uses and the second to `supervisor.kill_all()` plus exit 130. The terminal is always restored first. A panic hook and a `Drop` guard on the terminal both leave the alternate screen and raw mode.
- **Why:** the specified interruption semantics must be identical in both modes. The guard covers panics, the hook covers aborts.

### 6. Theme and glyph sets as data
- `tokens.json` from the handoff becomes `rio-tui/src/theme.rs` constants: `Token` enum → `Color::Rgb`.
- A `Glyphs` struct has two instances: `UNICODE`, whose glyphs are taken from `glyphs.json`, and `ASCII`. The ASCII instance is shared with `rio-core::render` through a small `rio-core::glyphs` module, so the streaming renderer honors `--ascii` too.
- `NO_COLOR` maps every token to `Color::Reset` and adds `Modifier::REVERSED` on the cursor row.
- A test asserts that each ASCII glyph has the same `unicode-width` as its Unicode counterpart, and that every ASCII-set screen is pure ASCII.

### 7. Golden conformance
The handoff's `screens/*/screen.txt`, `spans.json`, `screens.json`, `tokens.json` and `glyphs.json` are committed to `docs/design/tui-pr-comments/tui/`, and the comment Markdown to `docs/design/tui-pr-comments/pr-comments/`. The PNGs and PDFs (28 MB) are not committed; the README links the canvas.
- A fixture builder, `rio-tui/tests/fixtures/sample.rs`, reproduces each screen's sample data: PR #142, `parseHeader`, and so on.
- Each screen test renders to `TestBackend` at the screen's size and compares two things: the text grid against `screen.txt`, and the style runs against `spans.json`, mapped through token names.
- Allowed deviations: the 8-character id columns. These are applied as a declared patch per screen (`deviations.toml`: row, column range, expected text), so any other drift fails.
- The 8-char ids widen id columns by 4 cells. Layouts take the space from the message column, which already truncates.
- **Alternatives:** `insta` snapshots alone were rejected because they would accept whatever the first implementation drew. Comparing against the handoff keeps the design authoritative. `insta` is still used for screens and states the handoff doesn't cover, such as 80×24 and error dialogs.

### 8. Screen coverage and data sources
- review 00–06 → engine events + `Report`.
- guide G1–G2 → static keymap tables, the same tables that render the key bars, so help can't drift.
- G3 → the existing streaming renderer, with an `--ascii` variant.
- qa Q1–Q4 → `rio-qa` config, journeys and `qa:cell` events.
- init I1–I6 → `deployment.rs` refactored into named steps (`plan`, `account`, `worker`, `secrets`, `migrations`, `runner`, `github_app`) that report progress through a callback. The prompts become TUI fields, and the non-TTY path keeps the prompts.
- team P1–P4 → `Report` (council, security), the endpoint `GET /v1/findings`, and `GET/POST /v1/suppressions`.
- P2 publish preview → the Worker renders the bodies; see decision 10.

### 9. Init resume
Before the first remote step, init writes the chosen configuration to the user config, the same file `--from` reads. It also records `deployment.pending = <step>`, which is cleared on success.
- A later `rio init` that finds `pending` offers to resume, which runs as `--from`. Retry (`r`) re-runs from the failed step.
- **Why this is safe:** the steps are already idempotent, so resuming needs no new remote state.

### 10. Publish preview reuses the Worker's renderer
The comment Markdown is produced only by `worker/src/publish.ts`. A preview endpoint, `POST /v1/reviews/{id}/publish?dry_run=1`, returns the bodies and anchors the publisher would post and posts nothing. The TUI renders those bodies as text, and `y` calls the existing publish route.
- **Why:** one renderer means the preview cannot lie.
- **Alternatives:** porting the Markdown builder to Rust was rejected because two renderers would drift.

### 11. Comment rendering as pure functions
`publish.ts` gains `comment/` modules: `glyphs.ts` (the vocabulary table), `finding.ts` (open, fixed, dismissed, regression, qa, security), `summary.ts` and `limits.ts`. Each is a pure function. `findingBody()` and `summaryBody()` keep their signatures, so `publishWith()` and `reflectDismissal()` are unchanged.
- **Proof wording.** The tool comes from `f.source.tool` or the QA probe's `rule_id`.
- **Paragraph.** The rest of the message, the trigger and the impact are joined into one paragraph with `plain()`.
- **Suggestion blocks.** They require `f.fix` and `rightLines(patch)` to contain every line in `[line_start, line_end]` of the anchored hunk.
- **Fence safety.** The replacement is fenced with a backtick run one longer than any it contains.
- **Footer.** It uses `f.id.slice(0, 8)`. The marker stays `findingMarker(f.id)`, so it is byte-identical to today's and existing comments are edited, not duplicated.
- **Golden tests.** `worker/tests/comment-format.test.ts` renders the handoff fixtures and compares them with `docs/design/…/markdown/*.md`, after substituting the illustrative values (`<SIGNED_URL>`, `<THREAD_URL>`, `…`).

### 12. `fix` field end to end
- **Schemas.** `finding-v1.json`, `hypothesis-v1.json` and the embedded definitions in `report-v1.json` get `fix` with `additionalProperties: false`. The generated validators are regenerated.
- **Validation.** The verifier keeps `fix` only when the range is valid and inside the primary location's file. Otherwise it drops it silently.
- **Sources.** Agent prompts (`modules/agents/*`) ask for `fix` when the fix is local. ESLint `fix` ranges and the TypeScript and Ruff quick fixes are mapped to `fix` where the adapters already parse them. Otherwise the adapters leave it out.
- **Identity.** It is unaffected, because `fix` is not part of the identity inputs.

### 13. Feedback prefix resolution in one place
`resolvePrefix` moves from `commands.ts` into `feedback.ts`, scoped to the tenant (and the lineage when one is given). Both `/rio dismiss` and `POST /v1/findings/{id}/feedback` call it.
- The endpoint returns 409 with the candidate identities when a prefix is ambiguous, and 400 when it is shorter than 8 characters.
- `rio feedback` validates the length locally (exit 2) and maps 409 to exit 3.

### 14. QA screenshots through `ratatui-image`
The cell detail draws the step's PNG with `ratatui-image` 11 (built for crossterm, without chafa, and with `image` limited to PNG).
- **Protocol detection.** The host queries the terminal's image protocol and cell size once, after entering the alternate screen, and keeps the result in the session. Halfblocks are the answer when nothing is detected. `NO_COLOR` and `--ascii` skip images altogether.
- **Loading.** Images load when a cell is opened, never for the whole matrix: local runs read `.rio/cache/qa/…`, and endpoint runs download the signed URL through `Effect::Fetch("qa-image:<artifact id>")` into the run cache. Decoded images are cached per artifact and resized to the pane.
- **Design conformance.** The golden test covers the frame around the pane and the text fallback. The image itself is checked by a test that renders a real masked screenshot with halfblocks and compares the pane's colors with the PNG's.
- **Alternatives:** opening an external viewer only (today's `o`) keeps the terminal simple but hides the screenshot that explains the failure. Drawing the design's wireframe from the DOM snapshot would be an invention, not the evidence.

## Risks / Trade-offs

- **Binary size and cross builds.** ratatui and crossterm add roughly 1 MB. → `cargo build --release` for every `Cross.toml` target in CI; crossterm supports Windows consoles.
- **Silent behavior change for interactive users.** `rio review` in a terminal now opens a full-screen UI. → `--no-tui`/`RIO_TUI=0`, the release notes, and printing the plain summary on exit so scrollback still has the result.
- **Golden grids encode sample data and 4-char ids.** → A declared deviation list per screen. If the canvas is re-exported with 8-char ids, the deviations are removed and the build still passes.
- **Ambiguous-width glyphs.** → The ASCII set plus a width test. A manual check on one CJK-configured terminal is part of the release checklist.
- **The preview endpoint must never post.** → `dry_run` needs the PR's diff lines to place anchors and suggestions exactly as a real publish would, so it reads them with a read-only (`pull_requests: read`) token that is revoked right after. It never builds a writing host, and a test asserts that no GitHub write request is made.
- **GitHub suggestion edge cases.** Multi-line ranges and deleted lines can misapply. → Emit a suggestion only when every line in the range is a RIGHT-side line of the anchored hunk. Otherwise fall back to prose.
- **Comment length.** → `limits.ts` measures the final body. It truncates folded sections first, then rows, with "n more" links, and is tested at the 65,536-character boundary.
- **Image protocols vary.** tmux needs passthrough and some terminals misreport support. → Detection falls back to halfblocks, and images never draw outside their pane.
- **Dark mode rendering** of the scoreboard and tables is unverified. → A manual check in GitHub dark mode before release; the glyphs are emoji, so no color contrast depends on the theme.
- **Archive order.** → This change archives after `rio-v0-3-core` and `rio-v0-3-council`. At archive time, the `pr-publishing` scenarios quoting `dismissed: <reason>` and `fixed in <sha>` are reconciled with the new wording.

## Migration Plan

1. Land the schema `fix` field, the feedback prefix and the 8-char display first. They are independent and safe.
2. Land the comment rewrite behind no flag. Markers are unchanged, so the next round edits existing comments into the new format. Rollback is a Worker redeploy.
3. Land the `rio-tui` shell and review and guide flows, then qa, init and team. Each phase is usable on its own. Until a flow exists, its command keeps the streaming path even on a TTY.
4. The release notes announce the TUI with `--no-tui`/`RIO_TUI=0`.

## Open Questions

- Clipboard on headless and SSH terminals: OSC 52 versus a platform clipboard crate. Either satisfies the spec, so choose during implementation and fall back to showing the text when neither works.
- Whether to add per-step `Log` events to the SSE stream later, for hosted runs. That is deferrable, and local `log` events are enough for the screens.

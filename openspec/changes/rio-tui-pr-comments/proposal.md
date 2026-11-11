# Proposal

## Why

Rio's two human surfaces read like debug output. The terminal streams text that cannot be navigated, and the PR comments rio[bot] posts lead with metadata, put a green ✅ on open errors, never offer GitHub's Commit suggestion, and end with a 12-character id plus a reason list the reader must retype. A design handoff (`rio-tui-pr-comments`, exported 2026-11-10 against `c2b6900`) specifies both surfaces exactly: 24 ratatui screens as cell grids and seven GFM comment bodies. v0.3 (PR mode, finding history, suppression proposals, council) is now implemented, so the screens and comments have real data behind them.

## What Changes

- **Interactive terminal UI (new).** A ratatui + crossterm TUI opens automatically when `rio review`, `rio qa` or `rio init` runs with standard input and output attached to a terminal, no explicit `--format`, no `--no-tui`, `RIO_TUI` not `0`, and no `CI` variable. Pipes, CI, `--format` and `--no-tui` keep today's streaming renderer byte-for-byte (the handoff's G3 screen). The TUI covers five flows:
  - **review**: start, live run, findings hub, lineage and feedback, impact graph, summary and export, exit.
  - **init**: mode, configure, deploy, resumable failure, done, connect existing.
  - **qa**: journeys, live viewport matrix, cell detail, UX recommendations.
  - **QA screenshots in the terminal:** the cell detail shows the step's masked screenshot (head, or base with `b`) as an image in terminals that support the kitty, iTerm2 or sixel protocols, as half-block characters elsewhere, and as a path with `o` to open it where neither fits.
  - **team**: security finding and council, publish preview, finding history, suppression proposals.
  - **guide**: command palette and help/view map.
- **TUI rules from the specs.** Evidence levels instead of percentages, and `refuted` never shown. Nothing is published or written to a profile without an explicit `y`. Ctrl-C keeps a partial report, and a second Ctrl-C exits 130. Advice never changes the exit code. Every state still reads by glyph without color. An **ASCII glyph set** (`--ascii`, `RIO_ASCII=1`) is added for terminals that draw ambiguous-width glyphs two cells wide.
- **PR comment rewrite.** `findingBody()` and `summaryBody()` in `worker/src/publish.ts` follow the handoff:
  - The title is the headline with a severity glyph. One `<sub>` metadata line follows, with a one-emoji-one-meaning vocabulary.
  - One paragraph explains why. Suggestion blocks appear when an in-hunk fix exists, and detail is folded into `<details>`.
  - The footer has the 8-character id and a ready-to-paste reply.
  - Fixed, dismissed and regression states are rendered as edits.
  - The summary's title is the verdict, followed by a scoreboard, findings grouped by action, and a journeys × cells QA table.
- **Machine-applicable fix (additive).** finding-v1 and hypothesis-v1 gain an optional `fix { line_start, line_end, replacement }`. Agents and adapters may fill it, and the publisher emits a ```` ```suggestion ```` block only when the range lies inside the anchored hunk.
- **Council and trace detail (additive).** finding-v1's `council.members[]` gains optional `family` and per-round answers, and security findings gain an optional `trace` (catalog item, change, ordered steps). The security comment and the TUI's council screen render them.
- **One finding id length.** Every surface shows the first 8 characters of a finding's identity: TUI, streaming terminal, Markdown and PR comments. `rio feedback` and `POST /v1/findings/{id}/feedback` accept a unique prefix of at least 8 characters, matching `/rio dismiss`. Today the endpoint accepts only the full identity.

Nothing is breaking for scripts: non-interactive output, JSON, Markdown and SARIF documents are unchanged. The schema additions are optional.

## Capabilities

### New Capabilities
- `terminal-ui`: covers the following.
  - When the interactive TUI starts and when it falls back.
  - Layout grid, theme tokens and glyph sets.
  - Global keymap, help and palette.
  - Interrupt behavior and the minimum size.
  - Per-flow screen behavior for review, init, qa, team and guide.
  - Consent rules and conformance to the design grids.
- `pr-comment-format`: covers the following.
  - The content and layout of rio[bot]'s inline finding and summary comments.
  - The glyph vocabulary, suggestion blocks and folding.
  - The reply footer and lifecycle-state edits.
  - The QA table and size limits.

### Modified Capabilities
- `findings`: the optional machine-applicable `fix` on a finding.
- `cli/review`: interactive mode on a terminal (`--no-tui`, `--ascii`). `rio feedback` accepts an 8-character unique prefix.
- `finding-feedback`: response entry points resolve an id prefix of at least 8 characters, the same way everywhere.
- `review-report`: finding ids are displayed as 8 characters in the terminal and Markdown renderers. The streaming terminal renderer honors the ASCII glyph set.

## Impact

- **Code**:
  - New crate `crates/rio-tui`: ratatui, crossterm, unicode-width, with `insta` snapshots on `TestBackend`.
  - `rio-cli`: TUI selection, wiring for `review`, `qa`, `init`, `findings` and `suppressions`, plus `--no-tui` and `--ascii`.
  - `rio-core`: the glyph set in `render.rs`, 8-character ids, and the `fix` field in the model.
  - `rio-engine`: `ReviewEvent` gains the per-agent, verify and QA-cell progress the live screens need, as an additive change.
  - `worker/src/publish.ts`: rewrite of `findingBody`, `summaryBody` and `qaSummary`.
  - `worker/src/feedback.ts`: prefix resolution.
  - `POST /v1/reviews/{id}/publish`: gains `dry_run=1`, which returns the rendered bodies for the TUI's publish preview without posting.
  - Agent prompts and adapters, so they can fill `fix`.
- **Contracts**: optional `fix` on `schemas/finding-v1.json`, `hypothesis-v1.json` and the embedded copies in `report-v1.json`.
- **Design assets**: the handoff's `screen.txt`, `spans.json`, `tokens.json`, `glyphs.json`, `screens.json` and comment Markdown are committed under `docs/design/tui-pr-comments/` as golden references, without the 28 MB of images.
- **Dependencies**: `ratatui`, `crossterm` and `unicode-width` are added to the workspace, and `ratatui-image` with `image` (PNG only) for QA screenshots. The release binaries grow, and `Cross.toml` targets must still build.
- **Ordering**: `pr-comment-format` refines comments that `rio-v0-3-core`'s `pr-publishing` capability owns, and that change is complete but unarchived. This change archives after `rio-v0-3-core` and `rio-v0-3-council`.

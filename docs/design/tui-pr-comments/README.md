# rio — TUI and PR comments design handoff

Exported from the pen.dev canvas on 2026-11-10. Grounded in `pixelinfinito/rio` at `c2b6900` (“review-qa-ux-specs”): its OpenSpec specs, the active changes `rio-v0-3-core` and `rio-v0-3-council`, `crates/rio-cli` and `worker/src/publish.ts`.

| Folder | For | Start with |
| --- | --- | --- |
| [`tui/`](tui/README.md) | Building the interactive terminal UI with ratatui: 24 screens in `review`, `init`, `qa`, `team` and `guide` flows | `tui/README.md`, then `tui/rio-tui-screens.pdf` |
| [`pr-comments/`](pr-comments/README.md) | Rewriting the GitHub comments rio[bot] posts: inline finding, its variants and states, and the summary | `pr-comments/README.md`, then `pr-comments/markdown/` |
| `tools/build.py` | Regenerating this package after the canvas changes | see below |

## What's exact and what's illustrative

- **Exact**: every TUI screen's text and colors (`screen.txt`, `spans.json`, `screen.ans` are generated from the canvas file, not traced from images); the comment Markdown; token values; keymaps.
- **Illustrative**: sample data (PR #142, `@ana`, order ids, costs, council model families), and the emoji in PR comment images, which are drawn stand-ins.

## Decisions (resolved 2026-11-10, OpenSpec change `rio-tui-pr-comments`)

1. **TUI scope.** Specified as the `terminal-ui` capability; all 24 screens, built with ratatui + crossterm in `crates/rio-tui`. The TUI opens automatically when stdin and stdout are terminals (`--no-tui`, `RIO_TUI=0`, `CI` or `--format` keep the streaming output).
2. **Suggestion blocks.** finding-v1 and hypothesis-v1 gain the optional `fix { line_start, line_end, replacement }`.
3. **Finding id length.** 8 characters everywhere; `rio feedback`, the feedback API and `/rio dismiss` accept unique prefixes of 8 or more. Screens still drawn with 4-character ids list the id columns in their `deviations.toml`.
4. **Ambiguous-width glyphs.** An ASCII glyph set (`--ascii`, `RIO_ASCII=1`) keeps the grid on CJK ambiguous-as-wide terminals.
5. **Dark mode** is checked on a live PR before release (`docs/release-checklist.md`).

Only the text assets are committed here (`screen.txt`, `spans.json`, `screen.ans`, the JSON indexes and the comment Markdown). The PNG and PDF renders live on the pen.dev canvas and in the original handoff archive.

## Regenerate

```sh
# 1. In pen.dev, re-export PNG/PDF to handoff/_work/raw (same node ids; see tools/build.py)
# 2. Rebuild the package from the saved .pen file
python3 -I tools/build.py <path>/untitled.pen <path>/handoff/_work/raw <path>/handoff/rio-tui-pr-comments
```
The build fails loudly if any screen row isn't exactly 120 (or 80) cells wide, and lists colors that don't map to a token.

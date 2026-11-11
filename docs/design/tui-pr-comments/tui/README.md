# rio TUI (ratatui) design handoff

24 screens in four flows, drawn on a strict character grid. Every screen ships as an image **and** as an exact cell grid, so implementation can be checked cell by cell instead of by eye.

| Flow | Screens | Covers | Spec sources |
| --- | --- | --- | --- |
| `review` | 00–06 | `rio review`: start, live run, findings hub, lineage and feedback, impact graph, summary and export, exit | `cli/review`, `review-report`, `findings`, `review-convergence`, `impact-graph` |
| `init` | I1–I6 | `rio init` Cloudflare setup: mode, configure, deploy, failure with resume, done, connect existing | `distribution`, `model-providers`, `hosted-snapshots` |
| `qa` | Q1–Q4 | `rio qa`: journeys, live viewport matrix, failed cell, UX recommendations | `qa-journeys`, `qa-execution`, `qa-evidence`, `ui-quality-rules` |
| `team` | P1–P4 | security finding and council, publish preview, finding history, suppression proposals | v0.3 changes: `rio-v0-3-core`, `rio-v0-3-council`; `finding-feedback` |
| `guide` | G1–G3 | command palette, help and view map, 80 columns with NO_COLOR | `review-report` (Terminal renderer) |

## Files per screen — `screens/<slug>/`

| File | Use it for |
| --- | --- |
| `screen@2x.png` | Visual reference (2016×1440). |
| `screen.txt` | The exact 120×40 (G3: 80×40) cell grid. Use it as a golden snapshot with ratatui's `TestBackend` (for example through `insta`). |
| `screen.ans` | The same grid in 24-bit ANSI color. `cat screen.ans` in a truecolor terminal to see the screen as a terminal draws it. |
| `spans.json` | Every row as styled runs `{text, fg, bg, bold}` with **token names**. It maps 1:1 onto `Line`/`Span`. |

`screens.json` indexes all screens with their caption (the navigation note shown above each screen on the canvas) and their key bar.

## Grid and tokens

- One cell = 8.4 × 18 px at JetBrains Mono 14 px. Screens are 120 × 40 cells; G3 is 80 × 40.
- Row 0 is the header bar (`panel`), row 39 the key bar (`panel`). The key the screen is “about” is highlighted (`bg` on `signal`).
- Colors are in `tokens.json`. They match the canvas variables `tui-*`, plus four tints for selected or failing rows.

| Token | Hex | Role |
| --- | --- | --- |
| `bg` | `#0E0F11` | screen background |
| `panel` | `#15171A` | header and key bar |
| `raise` | `#1C1F23` | cursor row, dialogs |
| `rule` | `#2A2E34` | pane borders, separators |
| `fg` / `dim` / `faint` | `#E8E9EC` / `#8A8F98` / `#5A5F68` | text, secondary, tertiary |
| `signal` | `#6B8BFF` | focus, links, primary action |
| `fail` / `warn` / `pass` / `sec` | `#FF6B5B` / `#E8B341` / `#45D18F` / `#C77DFF` | outcome and category colors |
| `fail-tint` / `pass-tint` / `warn-tint` / `sec-tint` | `#301C1B` / `#152620` / `#2B2414` / `#251B30` | row and diff-line backgrounds |

```rust
// spans.json run -> ratatui
let style = Style::new()
    .fg(theme.color(&run.fg))
    .bg(theme.color(&run.bg))
    .add_modifier(if run.bold { Modifier::BOLD } else { Modifier::empty() });
Span::styled(run.text, style)
```

## Interaction model

Global keys (shown on G2): `?` help · `:` palette · `tab` pane · `1–6` tabs in `rio qa` · `esc` back · `q` quit (offers to save) · `^C` stop and keep a partial report · `^C ^C` kill tools and exit 130.
Movement: `↑↓`/`jk` items · `←→`/`hl` steps or cells · `[ ]` previous/next cell · `/` search.
Actions: `⏎` open · `d` dismiss with reason · `e` `$EDITOR` · `o` evidence · `y` copy · `x` export (md, json, sarif) · `P` publish preview · `F` finding history · `S` proposals · `c` council · `a` audit record.

```
review --⏎--> Live --auto--> Findings --x--> Summary --q--> exit
                               |  |  |  |
                               |  |  |  +--g--> Impact graph
                               |  |  +-----d--> Lineage & feedback
                               |  +--------F--> History --S--> Proposals
                               +-----------⏎--> Finding --c--> Council
                                                   +--P--> Publish --y--> PR
qa   --> Journeys --⏎--> Matrix --⏎--> Cell --4--> UX
init --> Mode --⏎--> Configure --⏎--> Deploy --> Done   (failure -> I4, resumable)
```

Rules the screens rely on (all from the specs):
- **Evidence, never a percentage.** Findings show `reproduced`, `static_proven` or `plausible`; `refuted` is never rendered.
- **Nothing posts or edits without consent.** `publish: ask` shows P2's y/N dialog; suppression proposals write the profile only on `y` (P4).
- **Ctrl-C is safe.** The first press keeps a partial report and marks cells or checks cancelled; the second exits 130.
- **UX advice never changes the exit code** (Q4).
- **Degrade, don't break.** At 80 columns the message is truncated, never the path; with NO_COLOR every state still reads by glyph (G3).

## Glyph widths — check before building

`glyphs.json` lists every non-ASCII glyph used. None is East Asian *wide*, but these are **ambiguous width** (`A`): box drawing, block elements, `● ○ ◐ ◆ ▲ ▶ ▣`, arrows, `…`, `·`, `€` and others. ratatui (via `unicode-width`) counts them as one cell, which matches the designs. Terminals configured for CJK ambiguous-as-wide will draw them two cells wide and break the grid. Test at least one such terminal, or keep an ASCII fallback set next to the NO_COLOR one.

## Known gaps

- ~~ratatui is not a dependency yet, and no OpenSpec capability covers an interactive TUI.~~ Resolved by the `rio-tui-pr-comments` change: `crates/rio-tui` (ratatui) implements these screens, and the `terminal-ui` spec covers them.
- ~~The TUI shows 4-character finding ids.~~ Resolved by the same change: ids are 8 characters everywhere, and `rio feedback`, the feedback API and `/rio dismiss` accept unique prefixes of 8 or more. Screens drawn here with 4 characters list the difference in their deviations file.
- Content is realistic sample data (repo `pixelinfinito/rio`, PR #142, `@ana`, costs, council model families). Rule ids, journey names, OWASP items, commands, flags and reasons come from the repository at `c2b6900`.

## Screen index
| Screen | Flow | Size | Key bar |
| --- | --- | --- | --- |
| [`review-00-start`](screens/review-00-start/screen@2x.png) — 00 — Start | review | 120x40 | `↑↓ select ←→ preset space toggle tab section ⏎ start c copy cmd ? help q quit` |
| [`review-01-live-review`](screens/review-01-live-review/screen@2x.png) — 01 — Live Review | review | 120x40 | `ctrl-c stop ↑↓ move ⏎ step log l full log f findings ? help` |
| [`review-02-findings`](screens/review-02-findings/screen@2x.png) — 02 — Findings | review | 120x40 | `↑↓ move ⏎ open d dismiss g graph f filter tab pane x export ? help q quit` |
| [`review-03-lineage-feedback`](screens/review-03-lineage-feedback/screen@2x.png) — 03 — Lineage & Feedback | review | 120x40 | `↑↓ reason tab note ⏎ record esc cancel` |
| [`review-04-impact-graph`](screens/review-04-impact-graph/screen@2x.png) — 04 — Impact Graph | review | 120x40 | `←→ hop ↑↓ node ⏎ focus +/- hops v head/base/delta esc back` |
| [`review-05-summary-export`](screens/review-05-summary-export/screen@2x.png) — 05 — Summary & Export | review | 120x40 | `↑↓ format tab field space toggle ⏎ save esc cancel` |
| [`review-06-exit`](screens/review-06-exit/screen@2x.png) — 06 — Exit | review | 120x40 | `` |
| [`init-i1-choose-mode`](screens/init-i1-choose-mode/screen@2x.png) — I1 — Choose Mode | init | 120x40 | `↑↓ mode ⏎ continue p dry run ? help q quit` |
| [`init-i2-configure`](screens/init-i2-configure/screen@2x.png) — I2 — Configure | init | 120x40 | `tab section ↑↓ select ←→ option ⏎ deploy p plan esc back` |
| [`init-i3-deploying`](screens/init-i3-deploying/screen@2x.png) — I3 — Deploying | init | 120x40 | `↑↓ step ⏎ step log l full log ctrl-c stop safely` |
| [`init-i4-failed-resumable`](screens/init-i4-failed-resumable/screen@2x.png) — I4 — Failed, Resumable | init | 120x40 | `r retry s self-hosted o dashboard l log q quit · resume later` |
| [`init-i5-deployed`](screens/init-i5-deployed/screen@2x.png) — I5 — Deployed | init | 120x40 | `⏎ first review t teammate c copy URL l deploy log q quit` |
| [`init-i6-connect-existing`](screens/init-i6-connect-existing/screen@2x.png) — I6 — Connect Existing | init | 120x40 | `tab field ↑↓ token source ⏎ connect esc back` |
| [`qa-q1-journeys`](screens/qa-q1-journeys/screen@2x.png) — Q1 — Journeys | qa | 120x40 | `↑↓ move space select ⏎ run a --full b baseline s sync i init v validate ? help q quit` |
| [`qa-q2-matrix-live`](screens/qa-q2-matrix-live/screen@2x.png) — Q2 — Matrix (live) | qa | 120x40 | `↑↓←→ cell ⏎ open cell l follow log p pause queue c cancel cell ^C stop, keep partial ? help` |
| [`qa-q3-cell-detail`](screens/qa-q3-cell-detail/screen@2x.png) — Q3 — Cell detail | qa | 120x40 | `←→ step [ ] cell o evidence b vs base e editor r rerun cell 4 ux esc matrix` |
| [`qa-q4-ux-recommendations`](screens/qa-q4-ux-recommendations/screen@2x.png) — Q4 — UX recommendations | qa | 120x40 | `↑↓ move ⏎ expand g guidance o evidence y copy as issue x export md esc matrix` |
| [`team-p1-security-council`](screens/team-p1-security-council/screen@2x.png) — P1 — Security finding + council | team | 120x40 | `↑↓ finding t trace c council a audit d dismiss… P publish F history esc back` |
| [`team-p2-publish-preview`](screens/team-p2-publish-preview/screen@2x.png) — P2 — Publish preview | team | 120x40 | `y publish n keep local e edit selection ↑↓ preview item esc back` |
| [`team-p3-finding-history`](screens/team-p3-finding-history/screen@2x.png) — P3 — Finding history | team | 120x40 | `↑↓ move f status r rule ⏎ timeline d dismiss… S proposals j json esc back` |
| [`team-p4-suppression-proposals`](screens/team-p4-suppression-proposals/screen@2x.png) — P4 — Suppression proposals | team | 120x40 | `y apply N leave unchanged x decline… (180 d) ↑↓ proposal esc history` |
| [`guide-g1-command-palette`](screens/guide-g1-command-palette/screen@2x.png) — G1 — Command palette | guide | 120x40 | `type filter ↑↓ move ⏎ run tab insert args esc close` |
| [`guide-g2-help-view-map`](screens/guide-g2-help-view-map/screen@2x.png) — G2 — Help & view map | guide | 120x40 | `? close / search keys : palette` |
| [`guide-g3-80col-no-color`](screens/guide-g3-80col-no-color/screen@2x.png) — G3 — 80 cols · NO_COLOR | guide | 80x40 | streaming output, no key bar |

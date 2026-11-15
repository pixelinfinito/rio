# Terminal interface

Review, QA and setup open the TUI when stdin/stdout are terminals, no explicit --format is given and CI is unset. Minimum size 80x24. UI strings remain English. --no-tui or RIO_TUI=0 selects streaming output.

## navigation
`?` help/view map; `:` command palette; Tab next pane; arrows or j/k move; Enter open; Esc back; `/` search; q quit (offers to save unsaved report). Review begins with source/profile/preset selection, then live progress and findings. Open a finding for hunk/evidence; export from the summary. Use the current help for context-specific keys.
`F` finding history, `S` suppression proposals, `P` PR publish preview. A security finding can open trace/council detail. Publishing and applying profile changes require explicit confirmation in the UI. A palette entry does not imply every action is available in every mode.

## qa
Journey selection leads to a live viewport/scheme matrix; Enter opens cell details/evidence. Local matrix `p` pauses new cells (budget clock continues); `c` cancels the focused cell. Hosted queues do not support these controls. In completed cell detail `r` reruns that cell, but exported report and exit code retain the original run. Below 120 columns, `v` switches detail/screenshot view.

## recovery
First Ctrl-C cancels tools and preserves partial report; second kills remaining tools and exits 130. SIGTERM closes the UI like quitting, stopping a running review first. `--ascii`/RIO_ASCII=1 addresses double-width box drawing; NO_COLOR removes color without removing state labels. Enlarge the terminal or use --no-tui if too small. Setup failures record a resumable step; retry in the UI or later with `rio deploy`.

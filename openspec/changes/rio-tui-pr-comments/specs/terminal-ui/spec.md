# Spec Delta

## Purpose

An interactive full-screen terminal interface for `rio review`, `rio qa` and `rio init` that lets a developer start, watch, navigate, answer, export and publish a review without leaving the terminal, while scripts and CI keep the streaming output.

## ADDED Requirements

### Requirement: Interactive mode selection
`rio review`, `rio qa` and `rio init` SHALL open the interactive UI only when standard input and standard output are terminals, `--format` was not given, `--no-tui` is absent, `RIO_TUI` is not `0`, and `CI` is unset or empty. Otherwise they SHALL behave exactly as without this capability.

#### Scenario: Terminal session
- **WHEN** `rio review` runs in a terminal with no `--format` and no `CI` variable
- **THEN** the interactive UI opens on the review start screen

#### Scenario: Piped output
- **WHEN** `rio review | cat` runs
- **THEN** no interactive UI opens and standard output is the streaming terminal report

#### Scenario: Explicit format
- **WHEN** `rio review --format json` runs in a terminal
- **THEN** no interactive UI opens and standard output holds exactly one JSON document

#### Scenario: Opt-out
- **WHEN** `rio qa --no-tui` or `RIO_TUI=0 rio qa` runs in a terminal
- **THEN** the streaming output is used

### Requirement: Same results and exit codes
A review, QA run or init performed through the interactive UI SHALL produce the same report, cache entries, endpoint calls and exit code as the same command run without it. Leaving the UI SHALL restore the terminal and print the streaming summary of the final report to standard output.

#### Scenario: Exit code preserved
- **WHEN** a review in the interactive UI finds an error matching `fail_on` and the user quits
- **THEN** the process exits 1, the terminal is restored, and the final summary is printed as plain lines

#### Scenario: Terminal restored on panic
- **WHEN** the UI encounters an internal error
- **THEN** the alternate screen and raw mode are left before the error is printed and the exit code is 3

### Requirement: Screen grid and layout
The UI SHALL draw on a cell grid with a header bar on the first row and a key bar on the last row. The key bar SHALL list the keys valid on the current screen. The design size is 120×40, and every screen SHALL remain usable down to 80×24.

#### Scenario: Key bar matches the screen
- **WHEN** the findings screen is shown
- **THEN** the last row lists `↑↓ move`, `⏎ open`, `d dismiss`, `g graph`, `f filter`, `tab pane`, `x export`, `? help` and `q quit`

#### Scenario: Too small
- **WHEN** the terminal is resized below 80×24
- **THEN** the UI shows only a message stating the minimum size and the current size, and resumes when the terminal is large enough

### Requirement: Theme tokens
Colors SHALL come from one named token set (`bg`, `panel`, `raise`, `rule`, `fg`, `dim`, `faint`, `signal`, `fail`, `warn`, `pass`, `sec` and the four tints) with the values of the design handoff. Outcome colors SHALL mean the same on every screen: `fail` failed or error, `warn` warning, `pass` passed or fixed, `sec` security.

#### Scenario: Consistent meaning
- **WHEN** any screen shows a passed check and a failed QA cell
- **THEN** the passed item uses the `pass` token and the failed one the `fail` token

### Requirement: No color still reads
When `NO_COLOR` is set or `--no-color` is given, the UI SHALL use no color. Every state SHALL remain distinguishable by glyph or text alone, and the focused row SHALL be marked by a cursor glyph and reverse video.

#### Scenario: NO_COLOR findings list
- **WHEN** the findings screen is shown with `NO_COLOR=1`
- **THEN** new, worsened, security and pre-existing findings are distinguished by their glyphs and the focused row carries the cursor glyph

### Requirement: ASCII glyph set
The UI and the streaming renderer SHALL offer an ASCII glyph set selected by `--ascii` or `RIO_ASCII=1`. It replaces every ambiguous-width glyph (box drawing, block elements, `● ○ ◐ ◆ ▲ ▶ ▣`, arrows, `…`, `·`) with ASCII that keeps the same cell widths and meanings.

#### Scenario: CJK ambiguous-wide terminal
- **WHEN** `RIO_ASCII=1 rio review` runs on any terminal
- **THEN** every drawn character is ASCII, every row is exactly the terminal width, and states remain distinguishable

### Requirement: Global keys
Every screen SHALL honor these global keys:
- `?` help and view map, `:` command palette.
- `tab` next pane, `esc` back.
- `q` quit: it offers to save the report when an unsaved review exists.
- `↑↓`/`jk` items, `←→`/`hl` steps or cells, `/` search.

Text fields SHALL take precedence while focused.

#### Scenario: Quit with unsaved review
- **WHEN** the user presses `q` on the findings screen of a finished review that was not exported
- **THEN** a dialog offers save, quit without saving and cancel, and nothing is written until one is chosen

#### Scenario: Text field focus
- **WHEN** the dismissal note field is focused and the user types `q`
- **THEN** `q` is inserted in the note and the UI does not quit

### Requirement: Interrupt keeps a partial report
In the UI, the first Ctrl-C during a run SHALL cancel in-flight checks, agents, verifications or QA cells exactly as the review CLI's interruption rule specifies. It SHALL then mark them cancelled and show the partial report. A second Ctrl-C SHALL kill remaining work, restore the terminal and exit 130.

#### Scenario: First Ctrl-C
- **WHEN** the user presses Ctrl-C once on the live review screen while coverage runs
- **THEN** coverage is shown cancelled with reason interrupted and the findings screen opens with the header marked partial

#### Scenario: Second Ctrl-C
- **WHEN** the user presses Ctrl-C again before the partial report is ready
- **THEN** the terminal is restored and the process exits 130

### Requirement: Command palette and help
`:` SHALL open a palette listing every action available from the current screen and every `rio` command, filtered as the user types. Running a command SHALL show the equivalent command line. `?` SHALL show the global keys, the current screen's keys and a map of the views with the keys that reach them.

The palette and the quit dialog SHALL be drawn over the screen they were opened from, which stays visible in the faint color around them.

#### Scenario: Palette filter
- **WHEN** the user types `:` then `exp`
- **THEN** the palette lists export actions first and `⏎` opens the export screen

#### Scenario: Palette over the findings
- **WHEN** the user opens the palette on the findings view
- **THEN** the findings rows show faded above and below the palette's box, the header stays the view's own, and the key bar is the palette's

### Requirement: Terminals that answer no query
The UI SHALL keep reading keys and redrawing in a terminal that answers no query. Image detection SHALL read the terminal's replies itself with a deadline, so that no reader of standard input outlives it. Under tmux or GNU screen, which would answer for the outer terminal only through passthrough, it SHALL use half-blocks without asking. A full redraw SHALL NOT ask the terminal for its cursor position.

#### Scenario: Silent terminal
- **WHEN** `rio qa` opens in a terminal that answers neither device attributes nor cursor position, and the user presses `⏎`
- **THEN** the matrix opens, and the UI does not exit with a cursor error

#### Scenario: Inside tmux
- **WHEN** `rio qa` opens inside tmux and the user presses Ctrl-C twice
- **THEN** rio exits 130 and the terminal leaves the alternate screen

### Requirement: Evidence, never a percentage
Wherever a finding appears, the UI SHALL show its evidence level (`reproduced`, `static_proven` or `plausible`). It SHALL NOT show a confidence percentage, and SHALL NOT show refuted findings except as a count.

#### Scenario: Refuted findings
- **WHEN** a review has three refuted hypotheses
- **THEN** the agents pane shows `refuted 3` and no refuted finding appears in any list

### Requirement: Finding ids are eight characters
The UI SHALL display a finding's identity as its first eight characters. Copying an id SHALL copy those eight characters, and any command the UI shows or runs for a finding SHALL use them.

#### Scenario: Copy id
- **WHEN** the user presses `y` on a finding whose identity starts `8c1e4a9b`
- **THEN** the clipboard holds `8c1e4a9b` and the row shows `8c1e4a9b`

### Requirement: Review start screen
Opening `rio review` in the UI SHALL first show a start screen. It SHALL contain:
- the change selection (branch vs base, working tree, staged) with file and line counts;
- the profile and preset, with the since-last, offline and show-pre-existing options;
- the changed files;
- the doctor preflight per root with warnings;
- the equivalent command line.

Flags given on the command line SHALL preselect these. `⏎` SHALL start the review.

#### Scenario: Flags preselect
- **WHEN** `rio review --base origin/main --preset deep` opens the UI
- **THEN** branch vs base and `deep` are selected and the command line shows both flags

#### Scenario: Copy command
- **WHEN** the user presses `c`
- **THEN** the shown command line is copied and running it without the UI performs the same review

### Requirement: Profiles shown by name
The start screen SHALL show a repository or personal profile, and put it in the command line, by its name. It SHALL use the profile's path only when that name would find another profile.

#### Scenario: Personal profile
- **WHEN** the personal profile `~/.config/rio/profiles/node.yaml` is the default and no repository profile is named `node`
- **THEN** the start screen lists it as `node` and the command line reads `--profile node`

### Requirement: Live review screen
While a review runs, the UI SHALL show each step (prepare, checks, graph, triage, agents, verify, report) with its state, elapsed time and counts, and the findings that have arrived. `⏎` on a step SHALL show that step's log. The findings screen SHALL open automatically when the review ends.

#### Scenario: Step log
- **WHEN** the user presses `⏎` on the lint check while it runs
- **THEN** the tail of the lint tool's output is shown and updates as it arrives

### Requirement: Findings hub
The findings screen SHALL show three panes:
- **filters**: all, new, worsened, security, pre-existing, with counts; plus checks and agents with their outcomes;
- **the findings list**: in report order;
- **the focused finding**: rule, location, trigger, evidence, impact, the diff hunk with the cited lines marked, and verification.

The footer SHALL show hidden pre-existing count and cost.

#### Scenario: Long list
- **WHEN** a review has 40 findings and the list shows 11 of them
- **THEN** the list header shows the cursor's position (e.g. `13/40`), its rules show how many findings are above and below, the list moves only to keep the cursor in view, and PageUp, PageDown, Home and End move by a window or to either end

#### Scenario: Open a finding
- **WHEN** the user moves to a finding and presses `⏎`
- **THEN** the detail pane shows its hunk with the cited lines marked and its verification quorum

### Requirement: Dismissal from the UI
`d` on a finding SHALL open a dialog listing the standardized reasons with an optional note. Its lineage history SHALL also be shown. Recording SHALL go through the finding-feedback capability exactly like `rio feedback`. Without an endpoint, the dialog SHALL say so and record nothing.

#### Scenario: Record a dismissal
- **WHEN** the user selects `intentional`, types a note and presses `⏎`
- **THEN** the finding's response is recorded with that reason and note and the list marks it dismissed

#### Scenario: No endpoint
- **WHEN** no endpoint is configured and the user presses `d`
- **THEN** the dialog states that dismissals need an endpoint and nothing is recorded

### Requirement: Impact graph view
`g` SHALL show the impact graph around the focused finding's symbol, in head, base or delta. `←→` moves between hops and `+`/`-` changes the hop count. Nodes SHALL be marked changed, dependent or unchanged.

#### Scenario: Delta view
- **WHEN** the user presses `v` until delta is selected
- **THEN** only nodes and edges that differ between head and base are shown

### Requirement: Summary and export
`x` SHALL open an export screen offering `md`, `json` and `sarif`, with the destination path. Saved documents SHALL be byte-identical to `--format` output for the same report. The exit screen SHALL state the exit code with its reason and where the report was saved.

#### Scenario: Export JSON
- **WHEN** the user exports `json` to `review.json`
- **THEN** the file equals what `rio review --format json` writes for the same report

### Requirement: Init flow
In the UI, `rio init` SHALL show these steps:
- mode choice (deploy to Cloudflare, connect an existing endpoint, or self-hosted);
- configuration with a dry-run plan;
- deployment with each step's state and log;
- the deployed result with the endpoint URL and next actions.

Each step SHALL perform the same operations and write the same files as the non-interactive init.

#### Scenario: Dry run
- **WHEN** the user presses `p` on the configure screen
- **THEN** the plan of resources and secrets is shown and nothing is created

#### Scenario: Connect existing
- **WHEN** the user chooses connect existing and enters an endpoint and token
- **THEN** the same configuration is written as by `rio init --endpoint <url> --token-stdin`

### Requirement: Resumable init failure
When a deployment step fails, the UI SHALL show the failed step, the provider's error and what was already created. It SHALL offer retry (resuming from the failed step), switching to self-hosted, opening the provider dashboard, or quitting. After quitting, a later `rio init` SHALL offer to resume.

#### Scenario: Retry resumes
- **WHEN** the secrets step fails and the user presses `r`
- **THEN** completed steps are not repeated and deployment continues from the secrets step

### Requirement: QA flow
In the UI, `rio qa` SHALL show four screens:
- the journeys with their selection and coverage;
- a live matrix of journeys × cells (viewport × color scheme) updating as cells start, reach a step and finish;
- a cell's step-by-step detail with base vs head evidence;
- the UX recommendations.

A local run SHALL report each cell's progress as it happens. A run that ends while the cell detail or another screen covers the matrix SHALL still reach the matrix.

#### Scenario: Failed cell detail
- **WHEN** the user opens the failed `checkout` mobile/dark cell
- **THEN** each step is listed with its outcome, the failed step's observation and evidence links are shown, and `b` compares with the base run

#### Scenario: Run ends under the cell detail
- **WHEN** the run finishes while a cell's detail is open and the user returns to the matrix
- **THEN** the matrix shows the run finished with every cell's final outcome

### Requirement: QA queue control
`p` SHALL pause the queue: the running cell finishes and no other starts until `p` resumes it. `c` SHALL cancel the focused cell, stopping it if it runs and never starting it if queued, and record it `cancelled` with reason `user`; the baseline run cancels it too. A run on an endpoint runs its queue to the end: it SHALL refuse pause and cancel with that reason and leave the matrix as it was.

#### Scenario: Pause and cancel a local run
- **WHEN** the user presses `p` while the first cell of a local run runs, then `c` on a queued cell, then `p` again
- **THEN** the first cell finishes, no cell starts until the second `p`, and the cancelled cell never starts and is recorded `cancelled` with reason `user`

#### Scenario: Endpoint run refuses pause
- **WHEN** the user presses `p` during a QA run on the endpoint
- **THEN** the footer says the endpoint runs its queue to the end and the queue is not shown paused

### Requirement: Rerun one QA cell
In the cell detail of a finished run, `r` SHALL run that one cell again (`rio qa --journey <journey> --cell <viewport>/<color-scheme>`). Its outcome and detail SHALL replace the cell's in the matrix. The first run's report SHALL remain the session's report for export and the exit code.

#### Scenario: Rerun one cell
- **WHEN** the user presses `r` in the detail of the failed `checkout` mobile/dark cell after the run
- **THEN** only that cell runs again, the matrix and detail show its new outcome, and exporting still saves the first run's report

### Requirement: Screenshot on a narrow terminal
Below 120 columns the cell detail SHALL keep the screenshot reachable: `v` SHALL switch the right pane between the details and the screenshot.

#### Scenario: Narrow terminal
- **WHEN** the cell detail is open in a 100-column terminal and the user presses `v`
- **THEN** the right pane shows the step's screenshot instead of the details, and `v` switches back

### Requirement: QA screenshots in the cell detail
The cell detail SHALL show the focused step's masked screenshot, with `b` switching between head and base. It SHALL be drawn as an image where the terminal supports kitty, iTerm2 or sixel, and with half-block characters otherwise. With `NO_COLOR` or the ASCII set it SHALL show the path with `o` to open it. A missing, unreadable or loading screenshot SHALL be named, never an empty pane.

#### Scenario: Image-capable terminal
- **WHEN** the user opens the failed `checkout` mobile/dark cell after a local run in a terminal that supports the kitty protocol
- **THEN** the step's masked screenshot is drawn in the screenshot pane, and `b` replaces it with the base run's screenshot of the same step

#### Scenario: No image protocol
- **WHEN** the same cell is opened in a terminal without an image protocol
- **THEN** the screenshot is drawn with half-block characters within the pane, and no image escape sequence is written

#### Scenario: Plain output
- **WHEN** the cell is opened with `NO_COLOR` set
- **THEN** the pane shows the screenshot's path and `o open`, and draws no image

#### Scenario: Endpoint run
- **WHEN** the cell belongs to an endpoint QA run whose screenshots are signed URLs
- **THEN** the screenshot is downloaded when the cell is opened, the pane says it is loading until then, and an expired link is reported as expired

#### Scenario: Endpoint base screenshot
- **WHEN** the user presses `b` in the cell detail of an endpoint run that ran a baseline
- **THEN** the base run's screenshot of the same step is downloaded and drawn, found by the artifact's `version: base`

#### Scenario: Downloads are kept a week
- **WHEN** a screenshot is downloaded
- **THEN** one already kept for the same object is used without a request, and downloads older than seven days, then the oldest beyond 200 MB, are removed

### Requirement: Advice never changes the exit code
The UX recommendations screen SHALL label recommendations as advice. No action on it SHALL change the review's status or exit code.

#### Scenario: Recommendations only
- **WHEN** a QA run passes every cell and has two recommendations
- **THEN** the screen shows them as advice and the process exits 0

### Requirement: Security finding and council
For a security finding, the UI SHALL show its catalog item and the input → validation → authorization → sensitive-operation trace. When a council ran, it SHALL show each member's family and position per round, abstentions and timeouts, and the deciding evidence tier. `a` SHALL show the audit record.

#### Scenario: Council shown
- **WHEN** the user presses `c` on a councilled security finding
- **THEN** every member is listed with its family, its round positions, and whether it answered, and the decision cites the evidence tier, not a vote count

### Requirement: Publish only on consent
`P` SHALL show a preview of exactly what would be posted: inline comments, the summary and the check run, rendered as the PR comment format specifies. Publishing SHALL happen only after `y` in that preview. `n` or `esc` SHALL publish nothing. Under `publish: never` the preview SHALL state the policy and offer no publish key.

#### Scenario: Declined
- **WHEN** the user opens the publish preview and presses `n`
- **THEN** nothing is posted and the report's publication reason is `ask_without_consent`

#### Scenario: Never policy
- **WHEN** the profile resolves `publish: never` and the user presses `P`
- **THEN** the preview states that the policy forbids publishing and `y` does nothing

### Requirement: Finding history and suppression proposals
`F` SHALL show the repository's finding registry with status, rule and timeline filters. `S` SHALL show suppression proposals with their evidence. A proposal SHALL be written to the profile only after `y`, and declined only after `x` with a reason. `N` SHALL leave it unchanged.

#### Scenario: Apply on consent
- **WHEN** the user presses `y` on a proposal
- **THEN** the entry is written exactly as `rio suppressions apply <id>` would, and no other proposal changes

#### Scenario: Leave unchanged
- **WHEN** the user presses `N`
- **THEN** the profile file is unchanged and the proposal stays open

### Requirement: Conformance to the design grids
For each interactive screen in the design handoff, rendering the handoff's sample data at its size SHALL produce its committed cell grid. G3 draws the streaming renderer, whose output stays as the review CLI specifies, so it is a reference rather than a golden. The text must match cell for cell, and the token styling of each run must match. The only allowed deviations are the eight-character ids, and those SHALL be listed with the snapshot.

#### Scenario: Golden snapshot
- **WHEN** the findings screen is rendered at 120×40 with the handoff's sample review
- **THEN** its text grid equals `review-02-findings/screen.txt` except the documented id columns

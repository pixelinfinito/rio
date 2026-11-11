//! Q2: journeys × cells, filling in live as cells reach steps and finish.

use ratatui::crossterm::event::{KeyCode, KeyEvent};
use rio_core::ReviewEvent;

use super::{
    CellDetail, CellId, CellOutcome, Pane, Tone, UxData, abbrev, body_bottom, border, cell_key,
    footer, kilo, mark, mmss, tabs, wide,
};
use crate::{
    app::{Action, Effect, Msg, Outcome, Screen, Session},
    canvas::{Canvas, bold, pad, run, width},
    chrome::{self, Board, Key, focus, key},
    theme::Token,
};

/// Everything Q2 shows about a run.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MatrixData {
    /// The agent harness (`codex`).
    pub harness: String,
    /// How the harness reaches models (`gateway`).
    pub via: String,
    /// The isolation (`pod`).
    pub isolation: String,
    /// The matrix columns.
    pub cells: Vec<CellId>,
    /// The matrix rows: chained dependencies first, then the selected journeys.
    pub journeys: Vec<MatrixJourney>,
    /// Cells the plan counts (selected journeys × cells); 0 counts the matrix.
    pub planned: u32,
    /// Environment steps: image, seed, app, egress, doubles, clock.
    pub environment: Vec<EnvStep>,
    /// The budget preset (`fast`).
    pub budget_preset: String,
    /// Tokens used of the run budget.
    pub tokens: Meter,
    /// Tokens used of the per-voter budget.
    pub voter: Meter,
    /// Seconds the run has taken when the screen opens.
    pub elapsed_secs: u32,
    /// Estimated seconds left, if known.
    pub remaining_secs: Option<u32>,
    /// Cost so far in US dollars.
    pub usd: f64,
    /// UI probe counts so far.
    pub probes: Vec<ProbeCount>,
    /// Agent log lines per cell, keyed by `<journey>/<viewport>/<color_scheme>`.
    pub logs: Vec<(String, Vec<LogEntry>)>,
    /// The cell the live log follows (a key as in `logs`).
    pub live: Option<String>,
    /// Detail for cells that have it (Q3).
    pub details: Vec<CellDetail>,
    /// The UX recommendations, once assessed (Q4).
    pub ux: Option<UxData>,
}

impl MatrixData {
    /// The journeys × cells of a finished or partial run, from `Report.qa`.
    pub fn from_qa(qa: &serde_json::Value) -> Self {
        let mut data = MatrixData {
            harness: str_at(qa, "harness"),
            isolation: str_at(qa, "isolation"),
            ..MatrixData::default()
        };
        data.apply_qa(qa);
        if let Some(cost) = qa.get("cost") {
            data.elapsed_secs = cost
                .get("wall_time_ms")
                .and_then(|v| v.as_u64())
                .map_or(0, |ms| (ms / 1000) as u32);
            data.usd = cost.get("usd").and_then(|v| v.as_f64()).unwrap_or(0.0);
            data.tokens.used = cost.get("tokens").and_then(|v| v.as_u64()).unwrap_or(0);
        }
        data.remaining_secs = Some(0);
        data.ux = UxData::from_qa(qa);
        data
    }

    /// Set each cell's outcome from `Report.qa.journeys`.
    pub fn apply_qa(&mut self, qa: &serde_json::Value) {
        let Some(journeys) = qa.get("journeys").and_then(|j| j.as_array()) else {
            return;
        };
        for j in journeys {
            let name = str_at(j, "name");
            for cell in j
                .get("cells")
                .and_then(|c| c.as_array())
                .into_iter()
                .flatten()
            {
                let Some(id) = CellId::from_json(cell) else {
                    continue;
                };
                let outcome = CellOutcome::parse(&str_at(cell, "outcome"));
                let step = cell
                    .get("step_reached")
                    .and_then(|s| s.as_u64())
                    .unwrap_or(0) as u32;
                let (r, c) = self.slot(&name, &id);
                let target = &mut self.journeys[r].cells[c];
                target.outcome = outcome;
                target.step = step;
            }
        }
    }

    /// The row and column of a cell, adding them when new.
    fn slot(&mut self, journey: &str, cell: &CellId) -> (usize, usize) {
        let c = match self.cells.iter().position(|x| x == cell) {
            Some(c) => c,
            None => {
                self.cells.push(cell.clone());
                for j in &mut self.journeys {
                    j.cells.push(MatrixCell::new(CellOutcome::Queued));
                }
                self.cells.len() - 1
            }
        };
        let r = match self.journeys.iter().position(|j| j.name == journey) {
            Some(r) => r,
            None => {
                self.journeys.push(MatrixJourney {
                    name: journey.to_owned(),
                    chained: false,
                    steps: vec![],
                    cells: self
                        .cells
                        .iter()
                        .map(|_| MatrixCell::new(CellOutcome::Queued))
                        .collect(),
                });
                self.journeys.len() - 1
            }
        };
        (r, c)
    }
}

fn str_at(value: &serde_json::Value, key: &str) -> String {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_owned()
}

/// A row of the matrix.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MatrixJourney {
    pub name: String,
    /// A dependency of a selected journey, drawn `↳ name`.
    pub chained: bool,
    /// Step titles, for the live log's header and `n/n` counts.
    pub steps: Vec<String>,
    /// One per column of [`MatrixData::cells`].
    pub cells: Vec<MatrixCell>,
}

/// One journey × one cell.
#[derive(Debug, Clone, PartialEq)]
pub struct MatrixCell {
    pub outcome: CellOutcome,
    /// The step reached (running), failed at, or the last one passed.
    pub step: u32,
    /// Wall time once finished.
    pub secs: Option<u32>,
    /// The tick the cell started running at, for its wall time.
    pub started: Option<u64>,
}

impl MatrixCell {
    pub fn new(outcome: CellOutcome) -> Self {
        Self {
            outcome,
            step: 0,
            secs: None,
            started: None,
        }
    }
}

/// A step of the environment set-up.
#[derive(Debug, Clone, PartialEq)]
pub struct EnvStep {
    /// `image built`, `seed restored`.
    pub label: String,
    /// Running, passed or failed.
    pub outcome: CellOutcome,
    /// How long it took (`48 s`).
    pub time: String,
    /// A line shown under it (`GET /api/health 200`).
    pub note: Option<String>,
}

/// Tokens used of a limit.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Meter {
    pub used: u64,
    pub limit: u64,
}

/// A UI probe's hits so far.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProbeCount {
    /// The rule id (`ui/low-contrast`).
    pub rule: String,
    pub hits: u32,
    /// Elements checked, when the probe counts them.
    pub checked: Option<u32>,
    /// How a hit reads (`Warn`, `Fail`); no hits read as passed.
    pub severity: Tone,
}

/// What an agent log line is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogKind {
    /// A browser action (`goto`, `fill`, `click`).
    Action,
    /// An expectation that held.
    Expect,
    /// An expectation that did not hold.
    Failed,
    /// A call to a service double.
    Double,
    /// Waiting for the page.
    Waiting,
}

/// One line of a cell's agent log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogEntry {
    /// The app clock (`09:00:41`).
    pub time: String,
    /// `goto`, `fill`, `expect`, `stripe`.
    pub verb: String,
    pub kind: LogKind,
    pub text: String,
    /// A typed value, shown faint (masked when secret).
    pub value: Option<String>,
}

impl LogEntry {
    /// A `log` event line: `HH:MM:SS verb text`, a typed value after two spaces
    /// for `fill`, `double · …` for service doubles.
    pub fn parse(line: &str) -> Self {
        let mut rest = line.trim();
        let mut time = String::new();
        if let Some((first, tail)) = rest.split_once(' ')
            && first.contains(':')
            && first.chars().all(|c| c.is_ascii_digit() || c == ':')
        {
            time = first.to_owned();
            rest = tail.trim_start();
        }
        let (verb, text) = rest.split_once(' ').unwrap_or((rest, ""));
        let text = text.trim_start();
        let kind = match verb {
            "expect" => LogKind::Expect,
            "failed" | "fail" => LogKind::Failed,
            "waiting" => LogKind::Waiting,
            _ if text.starts_with("double") => LogKind::Double,
            _ => LogKind::Action,
        };
        let (text, value) = match text.split_once("  ") {
            Some((t, v)) if verb == "fill" => (t.to_owned(), Some(v.trim().to_owned())),
            _ => (text.to_owned(), None),
        };
        Self {
            time,
            verb: verb.to_owned(),
            kind,
            text,
            value,
        }
    }
}

const SPIN: [&str; 4] = ["⠼", "⠦", "⠧", "⠏"];

const KEYS: &[Key] = &[
    key("↑↓←→", "cell"),
    focus("⏎", "open cell"),
    key("l", "follow log"),
    key("p", "pause queue"),
    key("c", "cancel cell"),
    key("^C", "stop, keep partial"),
    key("?", "help"),
];

pub(super) struct MatrixScreen {
    data: MatrixData,
    row: usize,
    col: usize,
    /// The log follows the focused cell rather than the live one.
    follow_focus: bool,
    paused: bool,
    finished: bool,
    ticks: u64,
    first_failure: Option<(usize, usize)>,
    /// A pause or cancel the host has not answered yet, undone if it fails
    /// (a runner without that control).
    requested: Option<Request>,
}

/// What `p` or `c` asked the host for, and how to undo it on the screen.
enum Request {
    Pause,
    Cancel {
        row: usize,
        col: usize,
        before: CellOutcome,
    },
}

impl MatrixScreen {
    pub fn new(data: MatrixData) -> Self {
        let first_failure = data.journeys.iter().enumerate().find_map(|(r, j)| {
            j.cells
                .iter()
                .position(|c| c.outcome == CellOutcome::Failed)
                .map(|c| (r, c))
        });
        let (row, col) = first_failure.unwrap_or((0, 0));
        Self {
            data,
            row,
            col,
            follow_focus: false,
            paused: false,
            finished: false,
            ticks: 0,
            first_failure,
            requested: None,
        }
    }

    fn all_cells(&self) -> impl Iterator<Item = &MatrixCell> {
        self.data.journeys.iter().flat_map(|j| j.cells.iter())
    }

    fn counts(&self) -> (u32, u32, u32, u32) {
        let done = self.all_cells().filter(|c| c.outcome.is_done()).count() as u32;
        let running = self
            .all_cells()
            .filter(|c| c.outcome == CellOutcome::Running)
            .count() as u32;
        let failed = self
            .all_cells()
            .filter(|c| c.outcome == CellOutcome::Failed)
            .count() as u32;
        let planned = if self.data.planned > 0 {
            self.data.planned
        } else {
            self.all_cells()
                .filter(|c| !matches!(c.outcome, CellOutcome::NotApplicable(_)))
                .count() as u32
        };
        (done, running, failed, planned)
    }

    fn elapsed(&self) -> u32 {
        self.data.elapsed_secs + (self.ticks / 4) as u32
    }

    fn remaining(&self) -> Option<u32> {
        self.data
            .remaining_secs
            .map(|r| r.saturating_sub((self.ticks / 4) as u32))
    }

    fn focused(&self) -> Option<(&MatrixJourney, &CellId, &MatrixCell)> {
        let j = self.data.journeys.get(self.row)?;
        Some((j, self.data.cells.get(self.col)?, j.cells.get(self.col)?))
    }

    /// The spinner frame of the running cell at `(r, c)`; concurrent cells
    /// are a frame apart so they never spin in lockstep.
    fn spin(&self, r: usize, c: usize) -> &'static str {
        let rank = self
            .data
            .journeys
            .iter()
            .enumerate()
            .flat_map(|(jr, j)| j.cells.iter().enumerate().map(move |(jc, x)| (jr, jc, x)))
            .filter(|(_, _, x)| x.outcome == CellOutcome::Running)
            .position(|(jr, jc, _)| (jr, jc) == (r, c))
            .unwrap_or(0);
        SPIN[(self.ticks as usize + rank) % SPIN.len()]
    }

    fn cell_text(&self, j: &MatrixJourney, cell: &MatrixCell, r: usize, c: usize) -> String {
        let text = match &cell.outcome {
            CellOutcome::Passed => {
                let steps = if j.steps.is_empty() {
                    cell.step
                } else {
                    j.steps.len() as u32
                };
                match cell.secs {
                    Some(s) => format!("{}/{steps}  {}", cell.step, mmss(s)),
                    None => format!("{}/{steps}", cell.step),
                }
            }
            CellOutcome::Failed => format!("step {}", cell.step),
            CellOutcome::Running => format!("step {} {}", cell.step.max(1), self.spin(r, c)),
            other => other.word(),
        };
        format!(" {} {text}", cell.outcome.glyph())
    }

    /// The key of the cell whose log is shown.
    fn log_key(&self) -> Option<String> {
        if self.follow_focus {
            let (j, cell, _) = self.focused()?;
            return Some(cell_key(&j.name, cell));
        }
        self.data.live.clone()
    }

    fn find(&self, key: &str) -> Option<(usize, usize)> {
        self.data.journeys.iter().enumerate().find_map(|(r, j)| {
            self.data
                .cells
                .iter()
                .position(|cell| cell_key(&j.name, cell) == key)
                .map(|c| (r, c))
        })
    }

    fn draw_left(&self, c: &mut Canvas<'_>, p: Pane) {
        let d = &self.data;
        let head = |text: String| bold(text, Token::Faint, Token::Bg);
        let mut y = 2;
        p.line(c, y, &[head(" ENVIRONMENT".into())]);
        y += 1;
        let end = usize::from(p.right.saturating_sub(1));
        for step in &d.environment {
            let room = end.saturating_sub(3 + width(&step.time));
            let label = if step.time.is_empty() {
                step.label.clone()
            } else {
                pad(&step.label, room)
            };
            p.line(
                c,
                y,
                &[
                    run(
                        format!(" {} ", step.outcome.glyph()),
                        step.outcome.token(),
                        Token::Bg,
                    ),
                    run(label, Token::Fg, Token::Bg),
                    run(step.time.as_str(), Token::Faint, Token::Bg),
                ],
            );
            y += 1;
            if let Some(note) = &step.note {
                p.line(c, y, &[run(format!("   {note}"), Token::Faint, Token::Bg)]);
                y += 1;
            }
        }
        y += 1;
        p.line(c, y, &[head(format!(" BUDGET  {}", d.budget_preset))]);
        y += 1;
        for (label, meter) in [("tokens", d.tokens), ("voter", d.voter)] {
            let filled = (meter.used * 12 + meter.limit / 2)
                .checked_div(meter.limit)
                .map_or(0, |n| n.min(12) as usize);
            p.line(
                c,
                y,
                &[
                    run(format!(" {}", pad(label, 7)), Token::Faint, Token::Bg),
                    run(
                        format!("{}{}", "█".repeat(filled), "░".repeat(12 - filled)),
                        Token::Signal,
                        Token::Bg,
                    ),
                    run(format!(" {}", kilo(meter.used)), Token::Fg, Token::Bg),
                ],
            );
            p.line(
                c,
                y + 1,
                &[run(
                    format!("        of {}", kilo(meter.limit)),
                    Token::Faint,
                    Token::Bg,
                )],
            );
            y += 2;
        }
        let total = self.remaining().map(|r| {
            let t = self.elapsed() + r;
            format!("/ ~{}m", (t + 30) / 60)
        });
        p.line(
            c,
            y,
            &[
                run(" time   ", Token::Faint, Token::Bg),
                run(format!("{} ", mmss(self.elapsed())), Token::Fg, Token::Bg),
                run(total.unwrap_or_default(), Token::Faint, Token::Bg),
            ],
        );
        y += 2;
        p.line(c, y, &[head(" PROBES  live".into())]);
        y += 1;
        for probe in &d.probes {
            let count = match probe.checked {
                Some(n) => format!("{}/{n}", probe.hits),
                None => probe.hits.to_string(),
            };
            let tone = if probe.hits == 0 {
                Token::Pass
            } else {
                probe.severity.token()
            };
            p.line(
                c,
                y,
                &[
                    run(
                        format!(" {}", pad(&abbrev(&probe.rule, 19), 19)),
                        Token::Fg,
                        Token::Bg,
                    ),
                    run(count, tone, Token::Bg),
                ],
            );
            y += 1;
        }
        p.line(
            c,
            y,
            &[run("   minority test runs", Token::Faint, Token::Bg)],
        );
        p.line(
            c,
            y + 1,
            &[run("   when the run ends", Token::Faint, Token::Bg)],
        );
        y += 3;
        p.line(c, y, &[head(" INTERRUPT".into())]);
        p.line(
            c,
            y + 1,
            &[
                bold(" ^C ", Token::Fg, Token::Bg),
                run("keep partial", Token::Faint, Token::Bg),
            ],
        );
        p.line(
            c,
            y + 2,
            &[
                bold(" ^C^C ", Token::Fg, Token::Bg),
                run("kill · 130", Token::Faint, Token::Bg),
            ],
        );
    }

    fn draw_matrix(&self, c: &mut Canvas<'_>, p: Pane) {
        let d = &self.data;
        let (done, running, _, planned) = self.counts();
        p.line(
            c,
            2,
            &[
                bold(" Matrix ", Token::Fg, Token::Bg),
                run(
                    format!("{done} of {planned} cells done"),
                    Token::Dim,
                    Token::Bg,
                ),
            ],
        );
        let queued = planned.saturating_sub(done + running);
        let mut right = if self.finished {
            vec![run("✓ run finished", Token::Pass, Token::Bg)]
        } else {
            vec![
                run(format!("◐ {running} running"), Token::Signal, Token::Bg),
                run("   ", Token::Fg, Token::Bg),
                run(format!("· {queued} queued"), Token::Faint, Token::Bg),
            ]
        };
        if self.paused && !self.finished {
            right.push(run("   ■ queue paused", Token::Warn, Token::Bg));
        }
        p.at(c, p.x + 47, 2, &right);
        p.rule(c, 3);
        let cells_x = p.x + 21;
        let ncols = d.cells.len().max(1);
        let cw = (usize::from(p.right.saturating_sub(cells_x + 1)) / ncols).clamp(8, 15) as u16;
        for (i, cell) in d.cells.iter().enumerate() {
            let x = cells_x + 2 + i as u16 * cw;
            p.at(
                c,
                x,
                4,
                &[bold(
                    pad(&cell.label(), usize::from(cw)),
                    Token::Faint,
                    Token::Bg,
                )],
            );
            p.at(
                c,
                x,
                5,
                &[run("─".repeat(usize::from(cw - 2)), Token::Rule, Token::Bg)],
            );
        }
        let bottom = p.bottom;
        let n = d.journeys.len() as u16;
        let spacing: u16 = if 6 + 2 * n + 5 <= bottom { 2 } else { 1 };
        let rows_room = usize::from(bottom.saturating_sub(6 + 3) / spacing).max(1);
        let start = self.row.saturating_sub(rows_room.saturating_sub(1));
        let mut y = 6;
        for (r, j) in d.journeys.iter().enumerate().skip(start).take(rows_room) {
            let focused_row = r == self.row;
            let bg = if focused_row { Token::Raise } else { Token::Bg };
            let name = if j.chained {
                format!("↳ {}", j.name)
            } else {
                j.name.clone()
            };
            let name = pad(&name, 19);
            p.line(
                c,
                y,
                &[
                    if focused_row {
                        run("▌", Token::Signal, bg)
                    } else {
                        run(" ", Token::Fg, bg)
                    },
                    run(" ", Token::Fg, bg),
                    if focused_row {
                        bold(name, Token::Fg, bg)
                    } else {
                        run(name, Token::Fg, bg)
                    },
                ],
            );
            for (i, cell) in j.cells.iter().enumerate() {
                let x = cells_x + i as u16 * cw;
                let text = pad(&self.cell_text(j, cell, r, i), usize::from(cw));
                let fg = cell.outcome.token();
                let r_ = if focused_row && i == self.col {
                    bold(text, fg, cell.outcome.tint())
                } else {
                    run(text, fg, bg)
                };
                p.at(c, x, y, &[r_]);
                if focused_row && i == self.col {
                    mark(c, y, x, x + cw, bottom);
                }
            }
            y += spacing;
        }
        let rule_y = 6 + spacing * (rows_room.min(d.journeys.len()) as u16) + (spacing == 1) as u16;
        p.rule(c, rule_y);
        self.draw_log(c, p, rule_y + 1);
    }

    fn draw_log(&self, c: &mut Canvas<'_>, p: Pane, y0: u16) {
        let d = &self.data;
        let key = self.log_key();
        let target = key.as_deref().and_then(|k| self.find(k));
        if let Some((r, col)) = target {
            let j = &d.journeys[r];
            let cell = &j.cells[col];
            let step = cell.step.max(1);
            let title = j
                .steps
                .get(step as usize - 1)
                .map(|t| format!(" · {t}"))
                .unwrap_or_default();
            let steps = if j.steps.is_empty() {
                String::new()
            } else {
                format!(" of {}", j.steps.len())
            };
            p.line(
                c,
                y0,
                &[
                    bold(
                        if self.follow_focus {
                            " LOG · "
                        } else {
                            " LIVE · "
                        },
                        Token::Faint,
                        Token::Bg,
                    ),
                    bold(
                        format!("{} × {}", j.name, d.cells[col].label()),
                        Token::Fg,
                        Token::Bg,
                    ),
                    run(
                        format!("   harness {} · step {step}{steps}{title}", d.harness),
                        Token::Faint,
                        Token::Bg,
                    ),
                ],
            );
        } else {
            p.line(
                c,
                y0,
                &[
                    bold(" LIVE", Token::Faint, Token::Bg),
                    run("   no cell is running", Token::Faint, Token::Bg),
                ],
            );
        }
        let entries: &[LogEntry] = key
            .as_deref()
            .and_then(|k| d.logs.iter().find(|(lk, _)| lk == k))
            .map_or(&[], |(_, e)| e.as_slice());
        let room = usize::from(p.bottom.saturating_sub(y0 + 4));
        let skip = entries.len().saturating_sub(room);
        let mut y = y0 + 1;
        let spin = target.map_or(SPIN[0], |(r, col)| self.spin(r, col));
        for e in entries.iter().skip(skip) {
            let (glyph, fg, text_fg) = match e.kind {
                LogKind::Action => ("▸", Token::Signal, Token::Fg),
                LogKind::Expect => ("✓", Token::Pass, Token::Fg),
                LogKind::Failed => ("✕", Token::Fail, Token::Fg),
                LogKind::Double => ("▸", Token::Sec, Token::Fg),
                LogKind::Waiting => (spin, Token::Signal, Token::Dim),
            };
            let mut runs = vec![
                run(format!("  {}  ", pad(&e.time, 8)), Token::Faint, Token::Bg),
                run(format!("{glyph} {}", pad(&e.verb, 11)), fg, Token::Bg),
            ];
            match &e.value {
                Some(v) => {
                    runs.push(run(format!("{}  ", e.text), text_fg, Token::Bg));
                    runs.push(run(v.as_str(), Token::Faint, Token::Bg));
                }
                None => runs.push(run(e.text.as_str(), text_fg, Token::Bg)),
            }
            p.line(c, y, &runs);
            y += 1;
        }
        y += 1;
        if let Some((r, col)) = self.first_failure
            && let (Some(j), Some(cell)) = (d.journeys.get(r), d.cells.get(col))
        {
            let step = j.cells.get(col).map_or(0, |x| x.step);
            p.line(
                c,
                y,
                &[
                    run(
                        format!(
                            "  first failure: {} × {} at step {step} · ",
                            j.name,
                            cell.label()
                        ),
                        Token::Faint,
                        Token::Bg,
                    ),
                    bold("⏎ open cell", Token::Fg, Token::Bg),
                    run(
                        if self.finished {
                            "  the run has finished"
                        } else {
                            "  other cells keep running"
                        },
                        Token::Faint,
                        Token::Bg,
                    ),
                ],
            );
        }
    }

    fn draw_progress(&self, c: &mut Canvas<'_>) {
        let (done, _, _, planned) = self.counts();
        let text = if self.finished {
            format!(
                " {done}/{planned} · done in {} · ${:.2}",
                mmss(self.elapsed()),
                self.data.usd
            )
        } else {
            match self.remaining() {
                Some(r) => format!(
                    " {done}/{planned} · ~{} left · ${:.2}",
                    mmss(r),
                    self.data.usd
                ),
                None => format!(" {done}/{planned} · ${:.2}", self.data.usd),
            }
        };
        let bar = usize::from(c.width()).saturating_sub(2 + width(&text));
        let filled = if self.finished {
            bar
        } else {
            match self.remaining() {
                Some(r) if self.elapsed() + r > 0 => {
                    bar * self.elapsed() as usize / (self.elapsed() + r) as usize
                }
                _ if planned > 0 => bar * done as usize / planned as usize,
                _ => 0,
            }
        };
        footer(
            c,
            &[
                run(" ", Token::Fg, Token::Bg),
                run(
                    format!("{}{}", "█".repeat(filled), "░".repeat(bar - filled)),
                    Token::Signal,
                    Token::Bg,
                ),
                run(text, Token::Faint, Token::Bg),
            ],
        );
    }

    /// Every cell of the run that runs, as Q3 details, and the focused one's index.
    fn details(&self) -> (Vec<CellDetail>, usize) {
        let d = &self.data;
        let mut out = Vec::new();
        let mut index = 0;
        for (r, j) in d.journeys.iter().enumerate() {
            for (col, cell) in j.cells.iter().enumerate() {
                if matches!(cell.outcome, CellOutcome::NotApplicable(_)) {
                    continue;
                }
                let Some(id) = d.cells.get(col) else {
                    continue;
                };
                if (r, col) == (self.row, self.col) {
                    index = out.len();
                }
                let mut detail = d
                    .details
                    .iter()
                    .find(|x| x.journey == j.name && x.cell == *id)
                    .cloned()
                    .unwrap_or_else(|| {
                        CellDetail::basic(
                            &j.name,
                            id.clone(),
                            &j.steps,
                            cell.outcome.clone(),
                            cell.step,
                        )
                    });
                detail.outcome = cell.outcome.clone();
                detail.step = cell.step;
                detail.others = j
                    .cells
                    .iter()
                    .enumerate()
                    .filter(|(i, x)| {
                        *i != col && !matches!(x.outcome, CellOutcome::NotApplicable(_))
                    })
                    .filter_map(|(i, x)| Some((d.cells.get(i)?.clone(), x.outcome.clone())))
                    .collect();
                out.push(detail);
            }
        }
        (out, index)
    }

    fn open_cell(&self) -> Action {
        match self.focused() {
            Some((_, _, cell)) if !matches!(cell.outcome, CellOutcome::NotApplicable(_)) => {
                let (cells, index) = self.details();
                Action::Push(super::cell_detail(cells, index, self.data.ux.clone()))
            }
            _ => Action::None,
        }
    }

    fn on_cell(&mut self, journey: &str, id: CellId, step: u32, outcome: &str) {
        let (r, col) = self.data.slot(journey, &id);
        let ticks = self.ticks;
        let outcome = CellOutcome::parse(outcome);
        let cell = &mut self.data.journeys[r].cells[col];
        if cell.outcome == CellOutcome::Cancelled && outcome == CellOutcome::Running {
            return;
        }
        if outcome == CellOutcome::Running && cell.started.is_none() {
            cell.started = Some(ticks);
        }
        if outcome.is_done()
            && let Some(start) = cell.started
        {
            cell.secs = Some(((ticks - start) / 4) as u32);
        }
        cell.step = step;
        cell.outcome = outcome.clone();
        match outcome {
            CellOutcome::Running => self.data.live = Some(cell_key(journey, &id)),
            CellOutcome::Failed if self.first_failure.is_none() => {
                self.first_failure = Some((r, col));
            }
            _ => {}
        }
    }

    /// A cell's detail from a report, with the journey's own step titles
    /// when the run planned them.
    fn detail_from(
        report: &rio_core::Report,
        j: &MatrixJourney,
        id: &CellId,
    ) -> Option<CellDetail> {
        let mut detail = CellDetail::from_report(report, &j.name, id)?;
        if !j.steps.is_empty() {
            detail.steps = CellDetail::basic(
                &j.name,
                id.clone(),
                &j.steps,
                detail.outcome.clone(),
                detail.step,
            )
            .steps;
        }
        Some(detail)
    }

    /// A cell run again (`r` in the cell detail): its outcome and detail
    /// replace the first run's; the first run's report stays the session's.
    fn merge_rerun(&mut self, report: &rio_core::Report, session: &mut Session) {
        session.add_rerun(report);
        let Some(qa) = &report.qa else {
            return;
        };
        self.data.apply_qa(qa);
        for journey in qa["journeys"].as_array().into_iter().flatten() {
            let Some(j) = self
                .data
                .journeys
                .iter()
                .find(|j| journey["name"] == j.name.as_str())
            else {
                continue;
            };
            for id in journey["cells"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(CellId::from_json)
            {
                if let Some(detail) = Self::detail_from(report, j, &id) {
                    self.data
                        .details
                        .retain(|d| !(d.journey == j.name && d.cell == id));
                    self.data.details.push(detail);
                }
            }
        }
    }

    fn finish(&mut self, report: &rio_core::Report, partial: bool, session: &mut Session) {
        if self.finished {
            return self.merge_rerun(report, session);
        }
        session.report = Some(report.clone());
        self.finished = true;
        if let Some(qa) = &report.qa {
            self.data.apply_qa(qa);
            if self.data.ux.is_none() {
                self.data.ux = UxData::from_qa(qa);
            }
        }
        // Q3 shows each cell's steps, observation and evidence from the report.
        for j in &self.data.journeys {
            for id in &self.data.cells {
                if !self
                    .data
                    .details
                    .iter()
                    .any(|d| d.journey == j.name && d.cell == *id)
                    && let Some(detail) = Self::detail_from(report, j, id)
                {
                    self.data.details.push(detail);
                }
            }
        }
        if partial {
            for j in &mut self.data.journeys {
                for cell in &mut j.cells {
                    if matches!(cell.outcome, CellOutcome::Running | CellOutcome::Queued) {
                        cell.outcome = CellOutcome::Cancelled;
                    }
                }
            }
        }
        if self.first_failure.is_none() {
            self.first_failure = self.data.journeys.iter().enumerate().find_map(|(r, j)| {
                j.cells
                    .iter()
                    .position(|c| c.outcome == CellOutcome::Failed)
                    .map(|c| (r, c))
            });
        }
    }
}

impl Screen for MatrixScreen {
    fn title(&self) -> &'static str {
        "QA matrix"
    }
    fn board(&self) -> Board {
        Board::V3
    }
    fn keys(&self) -> &'static [Key] {
        KEYS
    }

    fn draw(&self, c: &mut Canvas<'_>, _session: &Session) {
        c.clear(Token::Bg);
        let d = &self.data;
        let journeys = d.journeys.iter().filter(|j| !j.chained).count();
        let context = format!(
            "qa · {}{journeys} journeys × {} cells · {}{} · {}",
            if self.finished { "" } else { "running " },
            d.cells.len(),
            d.harness,
            if d.via.is_empty() {
                String::new()
            } else {
                format!(" ({})", d.via)
            },
            d.isolation
        );
        let (done, _, failed, planned) = self.counts();
        let mut right = vec![if self.finished && failed == 0 {
            chrome::status(format!("✓ {done}/{planned}"), Token::Pass)
        } else {
            chrome::status(format!("◐ {done}/{planned}"), Token::Signal)
        }];
        if failed > 0 {
            right.push(chrome::status(format!("✕ {failed} failed"), Token::Fail));
        }
        right.push(chrome::quiet(mmss(self.elapsed())));
        super::header(c, &context, &right);
        tabs(c, 1);
        let bottom = body_bottom(c);
        let x = if wide(c) {
            border(c, 24, 2, bottom);
            self.draw_left(c, Pane::new(0, 24, bottom));
            24
        } else {
            0
        };
        self.draw_matrix(c, Pane::new(x + u16::from(x > 0), c.width(), bottom));
        self.draw_progress(c);
        chrome::keybar(c, KEYS);
    }

    fn on_key(&mut self, key: KeyEvent, _session: &mut Session) -> Action {
        let rows = self.data.journeys.len();
        let cols = self.data.cells.len();
        match key.code {
            KeyCode::Up | KeyCode::Char('k') => self.row = self.row.saturating_sub(1),
            KeyCode::Down | KeyCode::Char('j') => {
                if self.row + 1 < rows {
                    self.row += 1;
                }
            }
            KeyCode::Left | KeyCode::Char('h') => self.col = self.col.saturating_sub(1),
            KeyCode::Right => {
                if self.col + 1 < cols {
                    self.col += 1;
                }
            }
            KeyCode::Enter | KeyCode::Char('3') => return self.open_cell(),
            KeyCode::Char('4') => {
                if let Some(ux) = &self.data.ux {
                    return Action::Push(Box::new(super::ux::UxScreen::new(ux.clone(), 1)));
                }
            }
            KeyCode::Char('l') => self.follow_focus = !self.follow_focus,
            KeyCode::Char('p') if !self.finished => {
                self.paused = !self.paused;
                self.requested = Some(Request::Pause);
                let step = if self.paused { "qa:pause" } else { "qa:resume" };
                return Action::Effect(Effect::Step(step.into()));
            }
            KeyCode::Char('c') => {
                let (row, col) = (self.row, self.col);
                let Some(j) = self.data.journeys.get_mut(row) else {
                    return Action::None;
                };
                let name = j.name.clone();
                let Some(cell) = j.cells.get_mut(col) else {
                    return Action::None;
                };
                if matches!(cell.outcome, CellOutcome::Running | CellOutcome::Queued) {
                    let before = std::mem::replace(&mut cell.outcome, CellOutcome::Cancelled);
                    self.requested = Some(Request::Cancel { row, col, before });
                    let key = cell_key(&name, &self.data.cells[col]);
                    return Action::Effect(Effect::Step(format!("qa:cancel:{key}")));
                }
            }
            _ => {}
        }
        Action::None
    }

    fn on_msg(&mut self, msg: &Msg, session: &mut Session) -> Action {
        match msg {
            Msg::Tick if !self.finished => self.ticks += 1,
            Msg::Review(event) => match event {
                ReviewEvent::QaCell {
                    journey,
                    viewport,
                    color_scheme,
                    step,
                    outcome,
                } => self.on_cell(
                    journey,
                    CellId::new(viewport.as_str(), color_scheme.as_str()),
                    *step,
                    outcome,
                ),
                ReviewEvent::StepStarted { step } => {
                    let label = step.trim_start_matches("qa:").replace(['-', '_'], " ");
                    match self.data.environment.iter_mut().find(|e| e.label == label) {
                        Some(e) => e.outcome = CellOutcome::Running,
                        None => self.data.environment.push(EnvStep {
                            label,
                            outcome: CellOutcome::Running,
                            time: String::new(),
                            note: None,
                        }),
                    }
                }
                ReviewEvent::StepFinished { step } => {
                    let label = step.trim_start_matches("qa:").replace(['-', '_'], " ");
                    if let Some(e) = self.data.environment.iter_mut().find(|e| e.label == label) {
                        e.outcome = CellOutcome::Passed;
                    }
                }
                ReviewEvent::Log { source, line } => {
                    let key = source.trim_start_matches("qa:").to_owned();
                    if self.find(&key).is_some() {
                        let entry = LogEntry::parse(line);
                        match self.data.logs.iter_mut().find(|(k, _)| *k == key) {
                            Some((_, entries)) => entries.push(entry),
                            None => self.data.logs.push((key, vec![entry])),
                        }
                    }
                }
                ReviewEvent::Done { report } => self.finish(report, false, session),
                ReviewEvent::Partial { report } => self.finish(report, true, session),
                _ => {}
            },
            // The runner could not pause or cancel: show the queue as it is.
            Msg::Done(Outcome::Failed(_)) => match self.requested.take() {
                Some(Request::Pause) => self.paused = !self.paused,
                Some(Request::Cancel { row, col, before }) => {
                    if let Some(cell) = self
                        .data
                        .journeys
                        .get_mut(row)
                        .and_then(|j| j.cells.get_mut(col))
                        .filter(|c| c.outcome == CellOutcome::Cancelled)
                    {
                        cell.outcome = before;
                    }
                }
                None => {}
            },
            Msg::Done(_) => self.requested = None,
            _ => {}
        }
        Action::None
    }
}

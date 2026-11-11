//! The `qa` flow: `rio qa` as four screens.
//!
//! - Q1 [`journeys`]: the journeys with their selection and coverage, sync
//!   status, and the selected journey's steps. `⏎` starts the run.
//! - Q2 [`matrix`]: journeys × cells (viewport × color scheme) filling in live
//!   from `qa:cell` events; a failure never stops the other cells.
//! - Q3 (`⏎` on a cell): one journey × one cell: step timeline, the failed
//!   step's observation, the masked screenshot, the attributed source line and
//!   the evidence, with `b` comparing against the base run.
//! - Q4 (`4` on a cell): UX recommendations, always advice: nothing on it can
//!   change the review's status or exit code.
//!
//! Effects the host performs beyond the shared ones, as `Effect::Step` names:
//! `qa:sync`, `qa:init`, `qa:validate` (the `rio qa` subcommands), `qa:accept`
//! and `qa:diff` (accept or diff `.rio/qa.proposed.yaml`), `qa:pause` and
//! `qa:resume` (hold or release the queue of cells not started yet),
//! `qa:cancel:<journey>/<viewport>/<color_scheme>` (cancel one cell and record
//! it `cancelled`), and `qa:rerun:<journey>/<viewport>/<color_scheme>`.
//! The host answers each with `Outcome::Ok` or `Outcome::Failed`; Q2 undoes
//! a pause or a cancelled cell it was refused (a runner without that control).
//!
//! Q4's `x` asks for `Effect::Export { format: "md", path:
//! "ux-recommendations.md" }`: the host writes only the recommendations there,
//! never the report.

mod cell;
mod journeys;
mod matrix;
mod ux;

pub use cell::{
    Base, CellDetail, CellFinding, DiffLine, EvidenceFile, Ink, Observation, Screenshot,
    SourceDiff, StepOutcome, StepResult,
};
pub use journeys::{
    Baseline, Budget, ChangedFile, Harness, Journey, JourneyStep, JourneysData, Persona, Proposed,
    ProposedItem, Seed, SyncItem, SyncStatus, Why,
};
pub use matrix::{
    EnvStep, LogEntry, LogKind, MatrixCell, MatrixData, MatrixJourney, Meter, ProbeCount,
};
pub use ux::{
    Citation, Criterion, CriterionStatus, GuidanceUse, RecStatus, Recommendation, UxData,
};

use ratatui::layout::Rect;
use unicode_width::UnicodeWidthChar;

use crate::{
    app::Screen,
    canvas::{Canvas, Run, run},
    theme::Token,
};

/// Q1, the journeys list: select journeys and start `rio qa`.
pub fn journeys(data: JourneysData) -> Box<dyn Screen> {
    Box::new(journeys::JourneysScreen::new(data))
}

/// Q2, the live matrix, opened straight on a run.
pub fn matrix(data: MatrixData) -> Box<dyn Screen> {
    Box::new(matrix::MatrixScreen::new(data))
}

/// Q3 on one cell of `cells` (all the run's cells, so `[` `]` can move).
pub fn cell_detail(cells: Vec<CellDetail>, index: usize, ux: Option<UxData>) -> Box<dyn Screen> {
    Box::new(cell::CellScreen::new(cells, index, ux))
}

/// Q4, the UX recommendations.
pub fn ux_recommendations(data: UxData) -> Box<dyn Screen> {
    Box::new(ux::UxScreen::new(data, 1))
}

/// A viewport × color scheme combination.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct CellId {
    /// The viewport name, e.g. `mobile`.
    pub viewport: String,
    /// `light` or `dark`.
    pub color_scheme: String,
}

impl CellId {
    pub fn new(viewport: impl Into<String>, color_scheme: impl Into<String>) -> Self {
        Self {
            viewport: viewport.into(),
            color_scheme: color_scheme.into(),
        }
    }

    /// `mobile·dark`.
    pub fn label(&self) -> String {
        format!("{}·{}", self.viewport, self.color_scheme)
    }

    /// The cell from a `{viewport, color_scheme}` JSON object.
    pub fn from_json(value: &serde_json::Value) -> Option<Self> {
        Some(Self::new(
            value.get("viewport")?.as_str()?,
            value.get("color_scheme")?.as_str()?,
        ))
    }
}

/// The address of one cell of a run, as used in `Effect::Step` names:
/// `<journey>/<viewport>/<color_scheme>`.
pub fn cell_key(journey: &str, cell: &CellId) -> String {
    format!("{journey}/{}/{}", cell.viewport, cell.color_scheme)
}

/// Where a cell stands.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum CellOutcome {
    /// Waiting for a worker.
    #[default]
    Queued,
    Running,
    Passed,
    Failed,
    Skipped,
    Cancelled,
    /// The environment failed before the cell ran.
    NotRun,
    /// The journey does not run in this cell; the reason (`desktop only`).
    NotApplicable(String),
}

impl CellOutcome {
    /// From a `qa:cell` event or report outcome string.
    pub fn parse(outcome: &str) -> Self {
        match outcome {
            "running" => Self::Running,
            "passed" => Self::Passed,
            "failed" => Self::Failed,
            "skipped" => Self::Skipped,
            "cancelled" => Self::Cancelled,
            "not_run" => Self::NotRun,
            "queued" => Self::Queued,
            other => Self::NotApplicable(other.replace('_', " ")),
        }
    }

    pub fn glyph(&self) -> &'static str {
        match self {
            Self::Queued | Self::NotRun => "·",
            Self::Running => "◐",
            Self::Passed => "✓",
            Self::Failed => "✕",
            Self::Cancelled => "■",
            Self::Skipped | Self::NotApplicable(_) => "–",
        }
    }

    pub fn token(&self) -> Token {
        match self {
            Self::Running => Token::Signal,
            Self::Passed => Token::Pass,
            Self::Failed => Token::Fail,
            Self::Cancelled => Token::Warn,
            _ => Token::Faint,
        }
    }

    /// The row tint of a focused cell in this state.
    pub fn tint(&self) -> Token {
        match self {
            Self::Passed => Token::PassTint,
            Self::Failed => Token::FailTint,
            Self::Cancelled => Token::WarnTint,
            _ => Token::Raise,
        }
    }

    pub fn word(&self) -> String {
        match self {
            Self::Queued => "queued".into(),
            Self::Running => "running".into(),
            Self::Passed => "passed".into(),
            Self::Failed => "failed".into(),
            Self::Skipped => "skipped".into(),
            Self::Cancelled => "cancelled".into(),
            Self::NotRun => "not run".into(),
            Self::NotApplicable(reason) => reason.clone(),
        }
    }

    /// Finished: passed, failed, skipped, cancelled or not run.
    pub fn is_done(&self) -> bool {
        matches!(
            self,
            Self::Passed | Self::Failed | Self::Skipped | Self::Cancelled | Self::NotRun
        )
    }
}

/// The color a value is drawn in, for data that carries its own emphasis.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Tone {
    #[default]
    Faint,
    Plain,
    Pass,
    Warn,
    Fail,
}

impl Tone {
    pub fn token(self) -> Token {
        match self {
            Tone::Faint => Token::Faint,
            Tone::Plain => Token::Fg,
            Tone::Pass => Token::Pass,
            Tone::Warn => Token::Warn,
            Tone::Fail => Token::Fail,
        }
    }
}

/// `text` cut to at most `cells` cells, without an ellipsis (pane edges cut
/// hard, as in the designs).
pub(crate) fn clip(text: &str, cells: usize) -> String {
    let mut out = String::new();
    let mut used = 0;
    for c in text.chars() {
        let w = c.width().unwrap_or(0);
        if used + w > cells {
            break;
        }
        out.push(c);
        used += w;
    }
    out
}

/// `text` cut to `cells` ending in `.` when cut (rule ids in narrow columns).
pub(crate) fn abbrev(text: &str, cells: usize) -> String {
    if crate::canvas::width(text) <= cells {
        return text.to_owned();
    }
    let mut out = clip(text, cells.saturating_sub(1));
    out.push('.');
    out
}

/// Greedy word wrap to `width` cells; words longer than a line are cut.
pub(crate) fn wrap(text: &str, width: usize) -> Vec<String> {
    let width = width.max(1);
    let mut lines = Vec::new();
    let mut line = String::new();
    for word in text.split_whitespace() {
        let w = crate::canvas::width(word);
        let used = crate::canvas::width(&line);
        if line.is_empty() {
            line = clip(word, width);
        } else if used + 1 + w <= width {
            line.push(' ');
            line.push_str(word);
        } else {
            lines.push(std::mem::take(&mut line));
            line = clip(word, width);
        }
    }
    if !line.is_empty() || lines.is_empty() {
        lines.push(line);
    }
    lines
}

/// `3m12s`, `48s`.
pub(crate) fn mmss(secs: u32) -> String {
    if secs < 60 {
        format!("{secs}s")
    } else {
        format!("{}m{:02}s", secs / 60, secs % 60)
    }
}

/// `500k`, `1.2M`, `950`.
pub(crate) fn kilo(n: u64) -> String {
    if n >= 1_000_000 {
        let tenths = n / 100_000;
        if tenths.is_multiple_of(10) {
            format!("{}M", tenths / 10)
        } else {
            format!("{}.{}M", tenths / 10, tenths % 10)
        }
    } else if n >= 1_000 {
        format!("{}k", n / 1_000)
    } else {
        n.to_string()
    }
}

/// A rectangle of the screen that clips what is drawn in it.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Pane {
    /// First column.
    pub x: u16,
    /// Column after the last.
    pub right: u16,
    /// Row after the last.
    pub bottom: u16,
}

impl Pane {
    pub fn new(x: u16, right: u16, bottom: u16) -> Self {
        Self { x, right, bottom }
    }

    pub fn width(&self) -> usize {
        usize::from(self.right.saturating_sub(self.x))
    }

    /// Draw `runs` from column `x`, cut at the pane's right edge.
    pub fn at(&self, c: &mut Canvas<'_>, x: u16, y: u16, runs: &[Run]) -> u16 {
        if y >= self.bottom {
            return x;
        }
        let mut x = x;
        for r in runs {
            if x >= self.right {
                break;
            }
            let room = usize::from(self.right - x);
            let text = clip(&r.text, room);
            if text.is_empty() {
                continue;
            }
            x = c.put(
                x,
                y,
                &Run {
                    text,
                    fg: r.fg,
                    bg: r.bg,
                    bold: r.bold,
                },
            );
        }
        x
    }

    /// Draw `runs` from the pane's first column.
    pub fn line(&self, c: &mut Canvas<'_>, y: u16, runs: &[Run]) -> u16 {
        self.at(c, self.x, y, runs)
    }

    /// A horizontal rule across the pane.
    pub fn rule(&self, c: &mut Canvas<'_>, y: u16) {
        let dashes = "─".repeat(self.width());
        self.line(c, y, &[run(dashes, Token::Rule, Token::Bg)]);
    }
}

/// A vertical pane border at column `x` from row `top` to before `bottom`.
pub(crate) fn border(c: &mut Canvas<'_>, x: u16, top: u16, bottom: u16) {
    for y in top..bottom {
        if x < c.width() {
            c.put(x, y, &run("│", Token::Rule, Token::Bg));
        }
    }
}

const TABS: [&str; 6] = ["Journeys", "Matrix", "Cell", "UX", "Seed", "Rules"];

/// Row 1: the `rio qa` tabs with `active` (0-based) highlighted.
pub(crate) fn tabs(c: &mut Canvas<'_>, active: usize) {
    let mut runs = vec![run(" ", Token::Fg, Token::Bg)];
    for (i, name) in TABS.iter().enumerate() {
        let text = format!(" {} {name} ", i + 1);
        if i == active {
            runs.push(crate::canvas::bold(text, Token::Bg, Token::Signal));
        } else {
            runs.push(run(text, Token::Dim, Token::Bg));
        }
        runs.push(run(" ", Token::Fg, Token::Bg));
    }
    c.row(1, &runs, Token::Bg);
}

/// The last row above the key bar: a faint summary line.
pub(crate) fn footer(c: &mut Canvas<'_>, runs: &[Run]) {
    let y = c.height().saturating_sub(2);
    let pane = Pane::new(0, c.width(), y + 1);
    c.fill(y, 0, c.width(), Token::Bg);
    pane.line(c, y, runs);
}

/// The header, the context cut so it never runs into the status segments.
pub(crate) fn header(c: &mut Canvas<'_>, context: &str, right: &[crate::chrome::Status]) {
    let right_w: usize = right
        .iter()
        .map(|s| crate::canvas::width(&s.text) + 2)
        .sum::<usize>()
        .saturating_sub(1);
    let room = usize::from(c.width()).saturating_sub(20 + right_w + 2);
    crate::chrome::header(
        c,
        crate::chrome::Board::V3,
        &crate::canvas::fit(context, room),
        right,
    );
}

/// The rows panes may draw in: below the tabs, above the footer.
pub(crate) fn body_bottom(c: &Canvas<'_>) -> u16 {
    c.height().saturating_sub(2)
}

/// Mark a focused range for NO_COLOR (reverse video) — color themes draw
/// the raised background themselves.
pub(crate) fn mark(c: &mut Canvas<'_>, y: u16, x0: u16, x1: u16, bottom: u16) {
    if y < bottom {
        c.cursor(y, x0, x1);
    }
}

/// The area a screen draws in, for layout decisions.
pub(crate) fn wide(c: &Canvas<'_>) -> bool {
    let Rect { width, .. } = c.area;
    width >= 120
}

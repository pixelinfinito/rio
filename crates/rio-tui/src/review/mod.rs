//! The `review` flow: start (00), live run (01), findings hub (02), dismissal
//! with lineage (03), impact graph (04), summary and export (05), and the
//! summary printed after the UI closes (06).
//!
//! Every screen renders from a plain data struct the CLI fills in. Keys that
//! run, write or call the endpoint become [`Effect`](crate::Effect)s:
//!
//! - start: `Effect::Start(args)` (the arguments of the shown command line
//!   after `rio`), `Effect::Copy(command line)`, `Effect::Step("review:doctor")`
//!   (the host prints `rio doctor` for the shown selection);
//! - findings: `Effect::Copy(8-char id)`, `Effect::Edit { path, line }`; with
//!   [`FindingsData::open`] set, `⏎` on the open detail of a security finding
//!   with a trace or a council, `F`, `S` and `P` open the team screens the host
//!   builds (the key bar has no room for `F` `S` `P`: the palette lists them);
//! - dismissal: `Effect::Feedback { id, reason, note }` with the full identity;
//! - graph: `Effect::Edit { path, line }` for the selected node;
//! - export: `Effect::Step("review:export-include-pre-existing")` before and
//!   `Effect::Step("review:export-copy")` after `Effect::Export { format, path }`
//!   when those options are checked, then `Effect::Edit { path, line: 1 }` when
//!   "open in $EDITOR" is checked.

mod dismiss;
mod exit;
mod export;
mod findings;
mod graph;
mod live;
mod start;

pub use dismiss::{LineageFinding, LineageHistory, LineageRound};
pub use exit::{ExitData, ExitFinding, NextStep, SavedReport, exit_summary, exit_text};
pub use export::ExportOptions;
pub use findings::{
    AgentCount, FindingLabel, FindingsData, Hunk, HunkLine, HunkLineKind, Open, Opener,
};
pub use graph::{GraphData, GraphEdge, GraphFinding, GraphNode, NodeKind, NodeState};
pub use live::{
    AgentRow, CheckRow, FindingCounts, FindingsBuilder, ItemState, LOG_LINES, LiveData, LiveState,
    LogLine, RootRow, SharedFindingsBuilder, StepRow, Usage,
};
pub use start::{
    ChangeSet, ChangedFile, DoctorRoot, DoctorTool, MachineCheck, MachineState, PresetInfo,
    SelectionKind, StartData,
};

use crate::{
    app::Screen,
    canvas::{Canvas, Run, fit, run, width},
    theme::Token,
};
use rio_core::{Category, EvidenceLevel, Finding, Severity, State};

/// The start screen (00) with the data's initial choices preselected.
pub fn start(data: StartData) -> Box<dyn Screen> {
    Box::new(start::StartScreen::new(data))
}

/// The start screen (00) whose review ends on findings built by `on_report`
/// (the host adds what the report doesn't carry: hunks, the exit code, labels).
pub fn start_with(data: StartData, on_report: SharedFindingsBuilder) -> Box<dyn Screen> {
    Box::new(start::StartScreen::new(data).with_findings(on_report))
}

/// The live screen (01) for a review that is starting or running.
pub fn live(data: LiveData) -> Box<dyn Screen> {
    Box::new(live::LiveScreen::new(data))
}

/// The findings hub (02) opened straight on a finished or partial report.
pub fn findings(data: FindingsData) -> Box<dyn Screen> {
    Box::new(findings::FindingsScreen::new(data))
}

/// The impact graph (04) on its own, around `data.seed`.
pub fn graph(data: GraphData) -> Box<dyn Screen> {
    Box::new(graph::GraphScreen::new(data))
}

/// The eight characters of a finding identity people see and copy.
pub(crate) fn id8(id: &str) -> &str {
    rio_core::display_id(id)
}

/// A finding's state glyph and its color: security, worsened, pre-existing,
/// anything else.
pub(crate) fn finding_glyph(finding: &Finding) -> (&'static str, Token) {
    if finding.category == Category::Security {
        ("◆", Token::Sec)
    } else {
        match finding.state {
            State::Worsened => ("▲", Token::Warn),
            State::PreExisting => ("○", Token::Faint),
            State::Fixed => ("✓", Token::Pass),
            State::New | State::Unclassified => ("●", Token::Fail),
        }
    }
}

/// The evidence level's name as the report writes it.
pub(crate) fn evidence_name(level: EvidenceLevel) -> &'static str {
    match level {
        EvidenceLevel::Reproduced => "reproduced",
        EvidenceLevel::StaticProven => "static_proven",
        EvidenceLevel::Plausible => "plausible",
        EvidenceLevel::Refuted => "refuted",
    }
}

/// The evidence level in a narrow column.
pub(crate) fn evidence_short(level: EvidenceLevel) -> &'static str {
    match level {
        EvidenceLevel::StaticProven => "proven",
        other => evidence_name(other),
    }
}

pub(crate) fn severity_name(severity: Severity) -> &'static str {
    match severity {
        Severity::Error => "error",
        Severity::Warning => "warning",
        Severity::Info => "info",
    }
}

pub(crate) fn state_name(state: State) -> &'static str {
    match state {
        State::New => "new",
        State::Worsened => "worsened",
        State::PreExisting => "pre-existing",
        State::Fixed => "fixed",
        State::Unclassified => "unclassified",
    }
}

pub(crate) fn category_name(category: Category) -> &'static str {
    match category {
        Category::Defect => "defect",
        Category::Risk => "risk",
        Category::Security => "security",
        Category::Ux => "ux",
    }
}

/// Seconds with one decimal under a minute (`14.2s`), else `2m14s`.
pub(crate) fn seconds(ms: u64) -> String {
    if ms < 60_000 {
        format!("{}.{}s", ms / 1000, (ms % 1000) / 100)
    } else {
        clock(ms)
    }
}

/// Minutes and seconds: `0m48s`, `2m14s`.
pub(crate) fn clock(ms: u64) -> String {
    let s = ms / 1000;
    format!("{}m{:02}s", s / 60, s % 60)
}

/// Words of `text` in lines of at most `max` cells.
pub(crate) fn wrap(text: &str, max: usize) -> Vec<String> {
    let mut lines = Vec::new();
    let mut line = String::new();
    for word in text.split_whitespace() {
        if !line.is_empty() && width(&line) + 1 + width(word) > max {
            lines.push(std::mem::take(&mut line));
        }
        if !line.is_empty() {
            line.push(' ');
        }
        line.push_str(word);
    }
    if !line.is_empty() {
        lines.push(line);
    }
    lines
}

/// `path` with leading directories dropped until it fits in `max` cells.
pub(crate) fn short_path(path: &str, max: usize) -> String {
    let mut rest = path;
    while width(rest) > max {
        match rest.find('/') {
            Some(i) => rest = &rest[i + 1..],
            None => break,
        }
    }
    fit(rest, max)
}

/// Draw `runs` from `x`, never past column `right`; a cut run ends in `…`.
pub(crate) fn put_in(c: &mut Canvas<'_>, x: u16, y: u16, right: u16, runs: &[Run]) -> u16 {
    let mut x = x;
    for r in runs {
        if x >= right {
            break;
        }
        let room = usize::from(right - x);
        if r.width() > room {
            let cut = Run {
                text: fit(&r.text, room),
                ..r.clone()
            };
            x = c.put(x, y, &cut);
        } else {
            x = c.put(x, y, r);
        }
    }
    x
}

/// A horizontal rule `─` over `x0..x1` of row `y`.
pub(crate) fn hrule(c: &mut Canvas<'_>, y: u16, x0: u16, x1: u16) {
    if x1 > x0 {
        let line = "─".repeat(usize::from(x1 - x0));
        put_in(c, x0, y, x1, &[run(line, Token::Rule, Token::Bg)]);
    }
}

/// A vertical pane border `│` at column `x` over rows `y0..y1`.
pub(crate) fn vrule(c: &mut Canvas<'_>, x: u16, y0: u16, y1: u16) {
    for y in y0..y1 {
        c.put(x, y, &run("│", Token::Rule, Token::Bg));
    }
}

/// A dialog with a double border in `signal` on `panel`, titled in its top
/// edge, over columns `x0..=x1` and rows `y0..=y1`.
pub(crate) fn dialog(c: &mut Canvas<'_>, x0: u16, y0: u16, x1: u16, y1: u16, title: &str) {
    if x1 <= x0 + 4 || y1 <= y0 {
        return;
    }
    let inner = usize::from(x1 - x0 - 1);
    let head = format!("═ {title} ");
    let fill = inner.saturating_sub(width(&head));
    let top = format!("╔{}{}╗", fit(&head, inner), "═".repeat(fill));
    c.put(x0, y0, &run(top, Token::Signal, Token::Panel));
    for y in y0 + 1..y1 {
        c.put(x0, y, &run("║", Token::Signal, Token::Panel));
        c.fill(y, x0 + 1, x1, Token::Panel);
        c.put(x1, y, &run("║", Token::Signal, Token::Panel));
    }
    let bottom = format!("╚{}╝", "═".repeat(inner));
    c.put(x0, y1, &run(bottom, Token::Signal, Token::Panel));
}

/// A key chip as the dialogs draw their primary action: ` ⏎ record `.
pub(crate) fn chip(c: &mut Canvas<'_>, x: u16, y: u16, text: &str) -> u16 {
    let x = c.put(x, y, &run(" ", Token::Fg, Token::Signal));
    let x = c.put(x, y, &crate::canvas::bold(text, Token::Bg, Token::Signal));
    c.put(x, y, &run(" ", Token::Fg, Token::Signal))
}

/// Secondary keys after a chip: `key label`, three spaces apart.
pub(crate) fn hints(
    c: &mut Canvas<'_>,
    x: u16,
    y: u16,
    right: u16,
    bg: Token,
    keys: &[(&str, &str)],
) -> u16 {
    let mut x = x;
    for (key, label) in keys {
        let w = 3 + width(key) + 1 + width(label);
        if usize::from(x) + w > usize::from(right) {
            break;
        }
        x = put_in(
            c,
            x,
            y,
            right,
            &[
                run("   ", Token::Fg, bg),
                crate::canvas::bold(*key, Token::Fg, bg),
                run(format!(" {label}"), Token::Faint, bg),
            ],
        );
    }
    x
}

/// The header bar with `context` cut so the status segments stay readable.
pub(crate) fn head(c: &mut Canvas<'_>, context: &str, right: &[crate::chrome::Status]) {
    let segments: usize =
        right.iter().map(|s| width(&s.text)).sum::<usize>() + 2 * right.len().saturating_sub(1) + 1;
    let room = usize::from(c.width()).saturating_sub(19 + segments + 2);
    crate::chrome::header(c, crate::chrome::Board::V2, &fit(context, room), right);
}

/// The logo as the header bar draws it.
pub(crate) const LOGO: &str = " ▃▅▇▇▇▅▃▃▁▁▁▃ ";

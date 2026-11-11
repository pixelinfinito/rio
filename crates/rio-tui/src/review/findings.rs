//! 02 — Findings hub: filters, checks and agents; the findings in policy
//! order; the focused finding with its hunk and its blind quorum.

use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    rc::Rc,
};

use ratatui::crossterm::event::{KeyCode, KeyEvent};
use rio_core::{
    BlindMatch, Category, CheckEntry, CheckKind, CheckOutcome, EvidenceLevel, Finding, Report,
    ReportStatus, Severity, SkipReason, State, Version,
};

use super::{
    ExportOptions, GraphData, LineageHistory, category_name, chip, clock, dismiss, evidence_name,
    evidence_short, export, finding_glyph, graph, hrule, id8, put_in, seconds, severity_name,
    short_path, state_name, vrule,
};
use crate::{
    app::{Action, Effect, Screen, Session},
    canvas::{Canvas, Run, bold, fit, pad, pad_left, run, width},
    chrome::{Board, Key, Status, key, keybar, quiet, status},
    theme::Token,
};

/// A finding's short title and place for lists, when the host has them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FindingLabel {
    /// A short title, e.g. `null deref in parseHeader`.
    pub title: String,
    /// A short place, e.g. `header.ts:42`.
    pub place: String,
}

/// What a hunk line is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HunkLineKind {
    /// Unchanged.
    Context,
    /// Added in head.
    Added,
    /// Removed from base.
    Removed,
}

/// One line of a hunk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HunkLine {
    /// Its line number (head for added and context lines, base for removed ones).
    pub number: u32,
    /// What it is.
    pub kind: HunkLineKind,
    /// The text, without the diff sign.
    pub text: String,
}

/// The diff hunk a finding cites.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hunk {
    /// The file.
    pub path: String,
    /// The hunk header, e.g. `@@ -38,7 +38,9 @@`.
    pub header: String,
    /// Its lines.
    pub lines: Vec<HunkLine>,
    /// Head lines the finding cites (marked `▌`); empty for the finding's location range.
    pub cited: Vec<u32>,
    /// A note under the cited lines, e.g. `type may be undefined; line 41 reads .params`.
    pub note: Option<String>,
}

/// An agent's row in the agents pane.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentCount {
    /// The agent.
    pub name: String,
    /// Findings it contributed after verification.
    pub findings: usize,
}

/// A screen of another flow the hub opens; the host builds it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Open {
    /// `⏎` on the detail of a security finding with a trace or a council: P1.
    Security,
    /// `F`: the repository's finding history (P3).
    History,
    /// `S`: the suppression proposals (P4).
    Proposals,
    /// `P`: the publish preview (P2), for a pull request review.
    Publish,
}

/// Builds what [`Open`] opens for the focused finding, usually a screen
/// pushed with the effect that loads it.
pub type Opener = Rc<dyn Fn(Open, Option<&Finding>) -> Action>;

/// Everything the findings hub (and the screens it opens) shows.
pub struct FindingsData {
    /// The finished or partial report.
    pub report: Report,
    /// The header context, e.g. `feature/parser-guards → origin/main · rio/openrouter · standard`.
    pub context: String,
    /// The process exit code under the profile's policy.
    pub exit_code: Option<u8>,
    /// Identities of the findings that match `fail_on` (the host compiles the policy).
    pub failing: Vec<String>,
    /// What `fail_on` means, e.g. `new defects with static_proven or stronger evidence`.
    pub policy: String,
    /// Short titles and places by finding identity.
    pub labels: BTreeMap<String, FindingLabel>,
    /// The hunk each finding cites, by identity.
    pub hunks: BTreeMap<String, Hunk>,
    /// The agents with their verified findings.
    pub agents: Vec<AgentCount>,
    /// Hypotheses verification refuted (shown only as a count).
    pub refuted: usize,
    /// Cost and tokens, e.g. `$0.41 · 182k in / 21k out`.
    pub cost: String,
    /// The impact graph around each finding's symbol, by identity.
    pub graphs: BTreeMap<String, GraphData>,
    /// The lineage history, for the dismissal dialog.
    pub lineage: Option<LineageHistory>,
    /// An endpoint is configured (dismissals need one).
    pub endpoint: bool,
    /// Who records dismissals, e.g. `you@example.com (git config user.email)`.
    pub actor: String,
    /// The export popup's defaults.
    pub export: ExportOptions,
    /// Opens the team screens (`⏎` on a security finding's detail, `F`, `S`,
    /// `P`); without it those keys do nothing.
    pub open: Option<Opener>,
}

impl FindingsData {
    /// The report alone: no hunks, graphs, labels or lineage history.
    pub fn new(report: Report, context: &str) -> Self {
        Self {
            report,
            context: context.into(),
            exit_code: None,
            failing: Vec::new(),
            policy: "fail_on".into(),
            labels: BTreeMap::new(),
            hunks: BTreeMap::new(),
            agents: Vec::new(),
            refuted: 0,
            cost: String::new(),
            graphs: BTreeMap::new(),
            lineage: None,
            endpoint: false,
            actor: String::new(),
            export: ExportOptions::default(),
            open: None,
        }
    }

    /// The finding's short title: its label, else its message.
    pub fn title(&self, finding: &Finding) -> String {
        self.labels
            .get(&finding.id)
            .map(|l| l.title.clone())
            .unwrap_or_else(|| finding.message.clone())
    }

    /// The finding's short place in `max` cells: its label, else its path and line.
    pub fn place(&self, finding: &Finding, max: usize) -> String {
        match self.labels.get(&finding.id) {
            Some(label) => fit(&label.place, max),
            None => short_path(&location(finding), max),
        }
    }

    /// Every finding a list shows: no refuted or fixed ones, failing first,
    /// then by severity and evidence, pre-existing ones last.
    pub fn listed(&self) -> Vec<&Finding> {
        let r = &self.report;
        let mut all: Vec<&Finding> = r
            .findings
            .iter()
            .chain(&r.risks)
            .chain(&r.security)
            .filter(|f| f.evidence_level != EvidenceLevel::Refuted && f.state != State::Fixed)
            .collect();
        // Severity, then evidence, then path and line (review-report "Finding ordering").
        all.sort_by(|a, b| {
            let key = |f: &Finding| {
                (
                    f.state == State::PreExisting,
                    !self.failing.contains(&f.id),
                    f.severity,
                    std::cmp::Reverse(f.evidence_level),
                )
            };
            key(a)
                .cmp(&key(b))
                .then_with(|| a.location.path.cmp(&b.location.path))
                .then_with(|| a.location.line_start.cmp(&b.location.line_start))
        });
        all
    }

    /// Whether the finding matches `fail_on`.
    pub fn fails(&self, finding: &Finding) -> bool {
        self.failing.contains(&finding.id)
    }

    /// The header's status segment and the run time.
    pub(crate) fn header_status(&self, label: Option<&str>) -> [Status; 2] {
        let time = quiet(clock(self.report.metrics.wall_time_ms));
        let failing = self.listed().iter().filter(|f| self.fails(f)).count();
        let segment = match (self.report.status, self.exit_code) {
            (ReportStatus::Partial, code) => status(
                format!(
                    "◐ partial{}",
                    code.map(|c| format!(" · exit {c}")).unwrap_or_default()
                ),
                Token::Warn,
            ),
            (_, Some(0)) => status(
                format!("✓ exit 0 · {}", label.unwrap_or("pass")),
                Token::Pass,
            ),
            (_, Some(code)) => status(
                match label {
                    Some(label) => format!("✕ exit {code} · {label}"),
                    None => format!("✕ exit {code} · {failing} fail"),
                },
                Token::Fail,
            ),
            (s, None) => status(report_status(s), Token::Dim),
        };
        [segment, time]
    }
}

pub(crate) fn report_status(status: ReportStatus) -> &'static str {
    match status {
        ReportStatus::Complete => "complete",
        ReportStatus::Incomplete => "incomplete",
        ReportStatus::Partial => "partial",
        ReportStatus::NoChanges => "no changes",
        ReportStatus::Error => "error",
    }
}

/// `path:line`, or the path alone for a file-level finding.
pub(crate) fn location(finding: &Finding) -> String {
    if finding.location.line_start == 0 {
        finding.location.path.clone()
    } else {
        format!("{}:{}", finding.location.path, finding.location.line_start)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Filter {
    All,
    New,
    Worsened,
    Security,
    PreExisting,
}

const FILTERS: [Filter; 5] = [
    Filter::All,
    Filter::New,
    Filter::Worsened,
    Filter::Security,
    Filter::PreExisting,
];

impl Filter {
    fn keeps(self, f: &Finding) -> bool {
        let security = f.category == Category::Security;
        match self {
            Filter::All => true,
            Filter::New => !security && f.state == State::New,
            Filter::Worsened => !security && f.state == State::Worsened,
            Filter::Security => security,
            Filter::PreExisting => f.state == State::PreExisting,
        }
    }

    fn label(self) -> (&'static str, &'static str, Token) {
        match self {
            Filter::All => (" ", "All", Token::Fg),
            Filter::New => ("●", "new", Token::Fail),
            Filter::Worsened => ("▲", "worsened", Token::Warn),
            Filter::Security => ("◆", "security", Token::Sec),
            Filter::PreExisting => ("○", "pre-existing", Token::Faint),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Pane {
    Filters,
    List,
    Detail,
}

const KEYS: &[Key] = &[
    key("↑↓", "move"),
    key("⏎", "open"),
    key("d", "dismiss"),
    key("g", "graph"),
    key("f", "filter"),
    key("tab", "pane"),
    key("x", "export"),
    key("?", "help"),
    key("q", "quit"),
];

/// The key bar's keys plus the team screens' keys, which the key bar has no
/// room for: the palette lists them as the hub's actions.
const TEAM_KEYS: &[Key] = &[
    key("↑↓", "move"),
    key("⏎", "open"),
    key("d", "dismiss"),
    key("g", "graph"),
    key("f", "filter"),
    key("tab", "pane"),
    key("x", "export"),
    key("F", "finding history"),
    key("S", "suppression proposals"),
    key("P", "publish preview"),
    key("?", "help"),
    key("q", "quit"),
];

pub(crate) struct FindingsScreen {
    data: Rc<FindingsData>,
    filter: usize,
    cursor: usize,
    pane: Pane,
    votes: bool,
    dismissed: Rc<RefCell<BTreeSet<String>>>,
    /// The first list item in view; the list moves only to keep the cursor in view.
    first: std::cell::Cell<usize>,
    /// How many items the last drawing showed, for PageUp and PageDown.
    page: std::cell::Cell<usize>,
}

impl FindingsScreen {
    pub(crate) fn new(data: FindingsData) -> Self {
        Self {
            data: Rc::new(data),
            filter: 0,
            cursor: 0,
            pane: Pane::List,
            votes: true,
            dismissed: Rc::default(),
            first: std::cell::Cell::new(0),
            page: std::cell::Cell::new(1),
        }
    }

    fn filter(&self) -> Filter {
        FILTERS[self.filter.min(FILTERS.len() - 1)]
    }

    fn shown(&self) -> Vec<&Finding> {
        let filter = self.filter();
        self.data
            .listed()
            .into_iter()
            .filter(|f| filter.keeps(f))
            .collect()
    }

    fn focused(&self) -> Option<&Finding> {
        self.shown().get(self.cursor).copied()
    }

    fn set_filter(&mut self, i: usize) {
        self.filter = i % FILTERS.len();
        self.cursor = 0;
    }

    fn count(&self, filter: Filter) -> usize {
        match filter {
            Filter::PreExisting => self.data.report.summary.pre_existing.max(
                self.data
                    .listed()
                    .iter()
                    .filter(|f| filter.keeps(f))
                    .count(),
            ),
            _ => self
                .data
                .listed()
                .iter()
                .filter(|f| filter.keeps(f))
                .count(),
        }
    }
}

/// Checks aggregated per kind: glyph, label, value and the value's color.
fn check_rows(checks: &[CheckEntry]) -> Vec<(&'static str, Token, &'static str, String, Token)> {
    let kinds = [
        (CheckKind::Typecheck, "typecheck"),
        (CheckKind::Lint, "lint"),
        (CheckKind::Coverage, "coverage"),
        (CheckKind::Secrets, "secrets"),
        (CheckKind::Dependencies, "audit"),
    ];
    let mut rows = Vec::new();
    for (kind, label) in kinds {
        let entries: Vec<&CheckEntry> = checks
            .iter()
            .filter(|c| c.kind == kind && c.version == Version::Head)
            .collect();
        if entries.is_empty() {
            continue;
        }
        let time = entries.iter().map(|c| c.wall_time_ms).max().unwrap_or(0);
        let findings: usize = entries
            .iter()
            .map(|c| c.outcome.details().findings.len())
            .sum();
        let errors = entries.iter().any(|c| {
            matches!(c.outcome, CheckOutcome::Failed { .. })
                || c.outcome
                    .details()
                    .findings
                    .iter()
                    .any(|f| f.severity == Severity::Error)
        });
        let skipped: Vec<&SkipReason> = entries
            .iter()
            .filter_map(|c| match &c.outcome {
                CheckOutcome::Skipped { reason, .. } => Some(reason),
                _ => None,
            })
            .collect();
        let cancelled = entries
            .iter()
            .any(|c| matches!(c.outcome, CheckOutcome::Cancelled { .. }));
        let row = if skipped.len() == entries.len() {
            (
                "-",
                Token::Faint,
                label,
                skip_word(*skipped[0]).into(),
                Token::Dim,
            )
        } else if cancelled {
            ("-", Token::Warn, label, "cancelled".into(), Token::Warn)
        } else if findings > 0 || errors {
            let value = format!("{findings} · {}", seconds(time));
            if errors {
                ("✕", Token::Fail, label, value, Token::Fail)
            } else {
                ("▲", Token::Warn, label, value, Token::Warn)
            }
        } else {
            ("✓", Token::Pass, label, seconds(time), Token::Dim)
        };
        rows.push(row);
    }
    rows
}

pub(crate) fn skip_word(reason: SkipReason) -> &'static str {
    match reason {
        SkipReason::ToolMissing => "missing",
        SkipReason::NoProjectConfig => "no config",
        SkipReason::NotSupportedByAdapter => "unsupported",
        SkipReason::Disabled => "disabled",
        SkipReason::Offline => "offline",
        SkipReason::DependencyMismatch => "deps differ",
        SkipReason::NoTests => "no tests",
        SkipReason::NothingToAudit => "nothing",
    }
}

/// The list marker at the end of a finding's first row.
fn marker(data: &FindingsData, f: &Finding, dismissed: bool) -> Run {
    if dismissed {
        return run("dismissed", Token::Faint, Token::Bg);
    }
    if data.fails(f) {
        return bold("FAIL", Token::Fail, Token::Bg);
    }
    let text = if f.state == State::PreExisting {
        "pre-exist."
    } else if f.category == Category::Security {
        "risk"
    } else {
        match f.severity {
            Severity::Error => "error",
            Severity::Warning => "warn",
            Severity::Info => "info",
        }
    };
    run(text, Token::Faint, Token::Bg)
}

impl Screen for FindingsScreen {
    fn title(&self) -> &'static str {
        "Findings"
    }
    fn board(&self) -> Board {
        Board::V2
    }
    fn keys(&self) -> &'static [Key] {
        KEYS
    }
    fn palette_keys(&self) -> &'static [Key] {
        if self.data.open.is_some() {
            TEAM_KEYS
        } else {
            KEYS
        }
    }

    fn draw(&self, c: &mut Canvas<'_>, _session: &Session) {
        c.clear(Token::Bg);
        let data = &*self.data;
        super::head(c, &data.context, &data.header_status(None));
        let (w, h) = (c.width(), c.height());
        let bottom = h.saturating_sub(1);
        // Below 110 columns the filters pane gives its room to the list; `f`
        // still cycles the filters and the list header names the current one.
        let (x, d2) = if w >= 120 {
            (25, 63)
        } else if w >= 110 {
            (23, 23 + (w - 23) * 39 / 96)
        } else {
            (0, w * 47 / 100)
        };
        if x > 0 {
            vrule(c, x - 1, 1, bottom);
            self.draw_filters(c, x - 1);
        }
        vrule(c, d2, 1, bottom);
        self.draw_list(c, x, d2);
        self.draw_detail(c, d2 + 2, w.saturating_sub(1));
        keybar(c, KEYS);
    }

    fn on_key(&mut self, key: KeyEvent, _session: &mut Session) -> Action {
        let len = self.shown().len();
        match key.code {
            KeyCode::Up | KeyCode::Char('k') => match self.pane {
                Pane::Filters => self.set_filter(self.filter.saturating_sub(1)),
                _ => self.cursor = self.cursor.saturating_sub(1),
            },
            KeyCode::Down | KeyCode::Char('j') => match self.pane {
                Pane::Filters => self.set_filter((self.filter + 1).min(FILTERS.len() - 1)),
                _ => self.cursor = (self.cursor + 1).min(len.saturating_sub(1)),
            },
            KeyCode::PageDown => {
                self.cursor = (self.cursor + self.page.get()).min(len.saturating_sub(1));
            }
            KeyCode::PageUp => self.cursor = self.cursor.saturating_sub(self.page.get()),
            KeyCode::Home => self.cursor = 0,
            KeyCode::End => self.cursor = len.saturating_sub(1),
            KeyCode::Enter => {
                // `⏎` on the open detail of a security finding with a trace or
                // a council opens P1 for it.
                if self.pane == Pane::Detail
                    && let (Some(open), Some(f)) = (&self.data.open, self.focused())
                    && f.category == Category::Security
                    && (f.trace.is_some() || f.council.is_some())
                {
                    return open(Open::Security, Some(f));
                }
                self.pane = match self.pane {
                    Pane::Filters => Pane::List,
                    _ => Pane::Detail,
                }
            }
            KeyCode::Char(c @ ('F' | 'S' | 'P')) => {
                if let Some(open) = &self.data.open {
                    let what = match c {
                        'F' => Open::History,
                        'S' => Open::Proposals,
                        _ => Open::Publish,
                    };
                    return open(what, self.focused());
                }
            }
            KeyCode::Tab => {
                self.pane = match self.pane {
                    Pane::Filters => Pane::List,
                    Pane::List => Pane::Detail,
                    Pane::Detail => Pane::Filters,
                }
            }
            KeyCode::BackTab => {
                self.pane = match self.pane {
                    Pane::Filters => Pane::Detail,
                    Pane::List => Pane::Filters,
                    Pane::Detail => Pane::List,
                }
            }
            KeyCode::Char('f') => self.set_filter(self.filter + 1),
            KeyCode::Char('p') => {
                let pre = FILTERS.len() - 1;
                self.set_filter(if self.filter == pre { 0 } else { pre });
            }
            KeyCode::Char('v') => self.votes = !self.votes,
            KeyCode::Char('y') => {
                if let Some(f) = self.focused() {
                    return Action::Effect(Effect::Copy(id8(&f.id).to_owned()));
                }
            }
            KeyCode::Char('e') => {
                if let Some(f) = self.focused() {
                    return Action::Effect(Effect::Edit {
                        path: f.location.path.clone(),
                        line: f.location.line_start.max(1),
                    });
                }
            }
            KeyCode::Char('d') => {
                if let Some(f) = self.focused() {
                    return Action::Push(Box::new(dismiss::DismissScreen::new(
                        self.data.clone(),
                        f.clone(),
                        self.dismissed.clone(),
                    )));
                }
            }
            KeyCode::Char('g') => {
                if let Some(f) = self.focused() {
                    let graph = self.data.graphs.get(&f.id).cloned().unwrap_or_else(|| {
                        GraphData::empty(&self.data.context, &f.location.symbol_path)
                    });
                    return Action::Push(Box::new(graph::GraphScreen::new(graph)));
                }
            }
            KeyCode::Char('x') => {
                return Action::Push(Box::new(export::ExportScreen::new(self.data.clone())));
            }
            _ => {}
        }
        Action::None
    }
}

impl FindingsScreen {
    fn draw_filters(&self, c: &mut Canvas<'_>, d1: u16) {
        let right = d1 - 1;
        c.put(2, 2, &bold("FILTER", Token::Faint, Token::Bg));
        for (i, filter) in FILTERS.iter().enumerate() {
            let y = 3 + i as u16;
            let selected = i == self.filter;
            let bg = if selected {
                c.fill(y, 0, d1, Token::Raise);
                c.put(0, y, &run("▌", Token::Signal, Token::Raise));
                c.cursor(y, 0, d1);
                Token::Raise
            } else {
                Token::Bg
            };
            let (glyph, label, gfg) = filter.label();
            let faint = *filter == Filter::PreExisting;
            let label_run = if selected {
                bold(label, Token::Fg, bg)
            } else {
                run(label, if faint { Token::Faint } else { Token::Fg }, bg)
            };
            c.puts(
                2,
                y,
                &[run(glyph, gfg, bg), run(" ", Token::Fg, bg), label_run],
            );
            let count = self.count(*filter).to_string();
            let fg = if selected {
                Token::Fg
            } else if faint {
                Token::Faint
            } else {
                Token::Dim
            };
            c.put_right(right, y, &[run(count, fg, bg)]);
        }
        let mut y = 9;
        c.put(2, y, &bold("CHECKS", Token::Faint, Token::Bg));
        for (glyph, gfg, label, value, vfg) in check_rows(&self.data.report.checks) {
            y += 1;
            c.puts(
                2,
                y,
                &[run(glyph, gfg, Token::Bg), run(" ", Token::Fg, Token::Bg)],
            );
            let vx = right.saturating_sub(width(&value) as u16);
            put_in(
                c,
                4,
                y,
                vx.saturating_sub(1),
                &[run(label, Token::Fg, Token::Bg)],
            );
            c.put_right(right, y, &[run(value, vfg, Token::Bg)]);
        }
        y += 2;
        c.put(2, y, &bold("AGENTS · VERIFY", Token::Faint, Token::Bg));
        for agent in &self.data.agents {
            y += 1;
            let count = agent.findings.to_string();
            let vx = right.saturating_sub(width(&count) as u16);
            put_in(
                c,
                2,
                y,
                vx.saturating_sub(1),
                &[
                    run("✓", Token::Pass, Token::Bg),
                    run(" ", Token::Fg, Token::Bg),
                    run(agent.name.clone(), Token::Fg, Token::Bg),
                ],
            );
            c.put_right(right, y, &[run(count, Token::Dim, Token::Bg)]);
        }
        y += 1;
        c.put(4, y, &run("refuted", Token::Faint, Token::Bg));
        c.put_right(
            right,
            y,
            &[run(self.data.refuted.to_string(), Token::Faint, Token::Bg)],
        );
    }

    fn draw_list(&self, c: &mut Canvas<'_>, x: u16, d2: u16) {
        let data = &*self.data;
        let h = c.height();
        let right = d2 - 1;
        let shown = self.shown();
        let dismissed = self.dismissed.borrow();
        put_in(
            c,
            x + 1,
            2,
            right,
            &[
                bold("Findings", Token::Fg, Token::Bg),
                run(" ", Token::Fg, Token::Bg),
                run(shown.len().to_string(), Token::Dim, Token::Bg),
                run(
                    if x == 0 {
                        format!(" · {}", self.filter().label().1)
                    } else {
                        String::new()
                    },
                    Token::Faint,
                    Token::Bg,
                ),
            ],
        );
        if right > x + 30 {
            c.put_right(right, 2, &[run("sort: policy ▾", Token::Faint, Token::Bg)]);
        }
        hrule(c, 3, x, d2);
        let footer = h.saturating_sub(4);
        hrule(c, footer, x, d2);
        let hidden = data.report.summary.pre_existing;
        if hidden > 0 && self.filter() != Filter::PreExisting {
            put_in(
                c,
                x + 1,
                footer + 1,
                right,
                &[run(
                    format!("{hidden} pre-existing hidden · p show"),
                    Token::Faint,
                    Token::Bg,
                )],
            );
        }
        put_in(
            c,
            x + 1,
            footer + 2,
            right,
            &[run(data.cost.clone(), Token::Faint, Token::Bg)],
        );
        // Lay the items out: two rows and a rule each, pre-existing ones one row.
        let mut layout = Vec::new();
        let mut y: u16 = 0;
        let mut grouped = false;
        for (i, f) in shown.iter().enumerate() {
            if f.state == State::PreExisting {
                if !grouped && i > 0 {
                    y += 1;
                }
                grouped = true;
                layout.push((y, 1u16));
                y += 1;
            } else {
                layout.push((y, 3u16));
                y += 3;
            }
        }
        let room = footer.saturating_sub(4);
        // Keep the window where it was; move it only to bring the cursor into view.
        let last = shown.len().saturating_sub(1);
        let cursor = self.cursor.min(last);
        let mut first = self.first.get().min(last).min(cursor);
        let fits = |first: usize, i: usize| {
            let (top, rows) = layout[i];
            top + rows.min(2) <= layout[first].0 + room
        };
        while first < cursor && !fits(first, cursor) {
            first += 1;
        }
        self.first.set(first);
        let scroll = layout.get(first).map_or(0, |(top, _)| *top);
        let below = (0..shown.len())
            .filter(|&i| i > first && !fits(first, i))
            .count();
        self.page
            .set(shown.len().saturating_sub(first + below).max(1));
        for (i, f) in shown.iter().enumerate() {
            let (top, rows) = layout[i];
            if top < scroll || top + rows.min(2) > scroll + room {
                continue;
            }
            let y = 4 + top - scroll;
            let focused = i == self.cursor;
            let is_dismissed = dismissed.contains(&f.id);
            let bg = if focused { Token::Raise } else { Token::Bg };
            let lines = if rows == 1 { 1 } else { 2 };
            for dy in 0..lines {
                if focused {
                    c.fill(y + dy, x, d2, Token::Raise);
                    c.put(x, y + dy, &run("▌", Token::Signal, Token::Raise));
                    c.cursor(y + dy, x, d2);
                }
            }
            let (glyph, gfg) = finding_glyph(f);
            let mut mark = marker(data, f, is_dismissed);
            mark.bg = bg;
            let mark_x = right.saturating_sub(mark.width() as u16);
            let id_x = x + 4;
            let title_x = id_x + 9;
            let title_w = usize::from(mark_x.saturating_sub(title_x + 1));
            let title = data.title(f);
            let title_run = if f.state == State::PreExisting || is_dismissed {
                run(pad(&title, title_w), Token::Faint, bg)
            } else if focused {
                bold(pad(&title, title_w), Token::Fg, bg)
            } else {
                run(pad(&title, title_w), Token::Fg, bg)
            };
            put_in(
                c,
                x + 2,
                y,
                mark_x,
                &[
                    run(glyph, gfg, bg),
                    run(" ", Token::Fg, bg),
                    run(id8(&f.id), Token::Faint, bg),
                    run(" ", Token::Fg, bg),
                    title_run,
                ],
            );
            c.put(mark_x, y, &mark);
            if rows == 3 {
                let ev = evidence_short(f.evidence_level);
                let ev_x = right.saturating_sub(width(ev) as u16);
                let place_x = x + 9;
                let place = data.place(f, usize::from(ev_x.saturating_sub(place_x + 1)));
                put_in(c, place_x, y + 1, ev_x, &[run(place, Token::Dim, bg)]);
                c.put(ev_x, y + 1, &run(ev, Token::Faint, bg));
                hrule(c, y + 2, x, d2);
            }
        }
        // The rule that opens the pre-existing group.
        if let Some(first) = shown.iter().position(|f| f.state == State::PreExisting)
            && first > 0
        {
            let (top, _) = layout[first];
            if top > scroll && top <= scroll + room {
                hrule(c, 4 + top - scroll - 1, x, d2);
            }
        }
        // Position and what is out of view, only when the list overflows.
        if first > 0 || below > 0 {
            c.put_right(
                right,
                3,
                &[run(
                    if first > 0 {
                        format!(" ↑ {first} more ")
                    } else {
                        String::new()
                    },
                    Token::Faint,
                    Token::Bg,
                )],
            );
            if below > 0 {
                c.put_right(
                    right,
                    footer,
                    &[run(format!(" ↓ {below} more "), Token::Faint, Token::Bg)],
                );
            }
            let at = format!(" {}/{} ", cursor + 1, shown.len());
            c.put(
                x + 1 + width("Findings ") as u16 + width(&shown.len().to_string()) as u16,
                2,
                &run(format!(" ·{at}"), Token::Faint, Token::Bg),
            );
        }
        if shown.is_empty() {
            put_in(
                c,
                x + 2,
                4,
                right,
                &[run("nothing matches this filter", Token::Faint, Token::Bg)],
            );
        }
    }

    fn draw_detail(&self, c: &mut Canvas<'_>, x: u16, right: u16) {
        let data = &*self.data;
        let h = c.height();
        let Some(f) = self.focused() else {
            return;
        };
        let footer = h.saturating_sub(3);
        let limit = footer.saturating_sub(1);
        put_in(
            c,
            x,
            2,
            right,
            &[
                run(id8(&f.id), Token::Faint, Token::Bg),
                run(" ", Token::Fg, Token::Bg),
                bold(f.message.clone(), Token::Fg, Token::Bg),
            ],
        );
        let state_fg = match f.state {
            State::New => Token::Fail,
            State::Worsened => Token::Warn,
            _ => Token::Faint,
        };
        let mut tags = vec![
            bold(format!("[{}]", state_name(f.state)), state_fg, Token::Bg),
            run(
                format!(" [{}] ", severity_name(f.severity)),
                Token::Fg,
                Token::Bg,
            ),
            run(
                format!("[{}]", category_name(f.category)),
                if f.category == Category::Security {
                    Token::Sec
                } else {
                    Token::Dim
                },
                Token::Bg,
            ),
            run(" ", Token::Fg, Token::Bg),
            run(
                format!("[{}]", evidence_name(f.evidence_level)),
                Token::Signal,
                Token::Bg,
            ),
        ];
        if self.dismissed.borrow().contains(&f.id) {
            tags.push(run(" [dismissed]", Token::Faint, Token::Bg));
        } else if data.fails(f) {
            tags.push(run(" ", Token::Fg, Token::Bg));
            tags.push(bold("[FAIL]", Token::Fail, Token::Bg));
        }
        put_in(c, x, 3, right, &tags);
        let field = |c: &mut Canvas<'_>, y: u16, label: &str, value: String, fg: Token| {
            put_in(
                c,
                x,
                y,
                right,
                &[
                    run(label.to_owned(), Token::Faint, Token::Bg),
                    run(" ".repeat(10 - label.len()), Token::Fg, Token::Bg),
                    run(value, fg, Token::Bg),
                ],
            );
        };
        field(c, 5, "rule", f.rule_id.clone(), Token::Fg);
        let symbol = if f.location.symbol_path.is_empty() {
            String::new()
        } else {
            format!(" {}", f.location.symbol_path)
        };
        field(
            c,
            6,
            "location",
            format!("{}{symbol}", location(f)),
            Token::Fg,
        );
        field(c, 7, "trigger", f.trigger.clone(), Token::Fg);
        field(c, 8, "evidence", f.evidence.join(", "), Token::Fg);
        let impact = match &f.impact {
            Some(impact) => format!("{impact} · press g for graph"),
            None => "press g for graph".into(),
        };
        field(c, 9, "impact", impact, Token::Dim);
        let mut y = 11;
        if let Some(hunk) = data.hunks.get(&f.id) {
            y = draw_hunk(c, x, right, y, limit, hunk, f) + 2;
        }
        if y < limit {
            match &f.verification {
                Some(v) => {
                    put_in(
                        c,
                        x,
                        y,
                        right,
                        &[bold(
                            format!("VERIFICATION · BLIND QUORUM {} OF {}", v.agreeing, v.voters),
                            Token::Faint,
                            Token::Bg,
                        )],
                    );
                    if self.votes {
                        for (i, blind) in v.blind_match.iter().enumerate() {
                            let row = y + 1 + i as u16;
                            if row >= limit {
                                break;
                            }
                            let agrees = (i as u32) < v.agreeing;
                            let blind = match blind {
                                BlindMatch::Same => "same",
                                BlindMatch::Related => "related",
                                BlindMatch::None => "none",
                            };
                            put_in(
                                c,
                                x,
                                row,
                                right,
                                &[
                                    run(format!("voter {}", i + 1), Token::Dim, Token::Bg),
                                    run("   ", Token::Fg, Token::Bg),
                                    if agrees {
                                        run(pad("✓ agrees", 14), Token::Pass, Token::Bg)
                                    } else {
                                        run(pad("✕ no repro", 14), Token::Faint, Token::Bg)
                                    },
                                    run(format!("blind: {blind}"), Token::Faint, Token::Bg),
                                ],
                            );
                        }
                    } else if y + 1 < limit {
                        put_in(
                            c,
                            x,
                            y + 1,
                            right,
                            &[run(
                                format!(
                                    "{} of {} agree{}",
                                    v.agreeing,
                                    v.voters,
                                    if v.split { " · split" } else { "" }
                                ),
                                Token::Dim,
                                Token::Bg,
                            )],
                        );
                    }
                }
                None => {
                    put_in(
                        c,
                        x,
                        y,
                        right,
                        &[bold("VERIFICATION", Token::Faint, Token::Bg)],
                    );
                    let how = match &f.source {
                        rio_core::Source::Tool { tool, version } => {
                            format!("deterministic · {tool} {version}")
                        }
                        rio_core::Source::Agent { .. } => "not verified".into(),
                    };
                    if y + 1 < limit {
                        put_in(c, x, y + 1, right, &[run(how, Token::Dim, Token::Bg)]);
                    }
                }
            }
        }
        let cx = chip(c, x, footer, "d dismiss…");
        let mut cx = c.put(cx, footer, &run("  ", Token::Fg, Token::Bg));
        for (i, (k, label)) in [("e", "editor"), ("v", "votes"), ("y", "copy id")]
            .iter()
            .enumerate()
        {
            if i > 0 {
                cx = c.put(cx, footer, &run("  ", Token::Fg, Token::Bg));
            }
            cx = put_in(
                c,
                cx,
                footer,
                right,
                &[
                    bold(*k, Token::Fg, Token::Bg),
                    run(" ", Token::Fg, Token::Bg),
                    run(*label, Token::Faint, Token::Bg),
                ],
            );
        }
    }
}

/// Draw a hunk in a box from row `y`; returns the box's last row.
fn draw_hunk(
    c: &mut Canvas<'_>,
    x: u16,
    right: u16,
    y: u16,
    limit: u16,
    hunk: &Hunk,
    f: &Finding,
) -> u16 {
    let x1 = right.saturating_sub(1);
    if x1 <= x + 12 {
        return y;
    }
    let inner = usize::from(x1 - x - 1);
    let path = format!(" {} ", hunk.path);
    let head = format!(" {} ", hunk.header);
    let fill = usize::from(right + 1 - x).saturating_sub(2 + width(&path) + width(&head));
    let mut top = vec![
        run("┌─", Token::Rule, Token::Bg),
        run(path, Token::Dim, Token::Bg),
    ];
    if fill > 0 {
        top.push(run("─".repeat(fill), Token::Rule, Token::Bg));
        top.push(run(head, Token::Faint, Token::Bg));
    }
    put_in(c, x, y, right + 1, &top);
    let cited: Vec<u32> = if hunk.cited.is_empty() {
        (f.location.line_start..=f.location.line_end).collect()
    } else {
        hunk.cited.clone()
    };
    let digits = hunk
        .lines
        .iter()
        .map(|l| l.number.to_string().len())
        .max()
        .unwrap_or(1)
        .max(2);
    let mut row = y + 1;
    let text_x = x + 3 + digits as u16 + 2;
    for line in &hunk.lines {
        if row >= limit {
            break;
        }
        let is_cited = line.kind != HunkLineKind::Removed && cited.contains(&line.number);
        let bg = match (line.kind, is_cited) {
            (HunkLineKind::Removed, _) | (_, true) => Token::FailTint,
            (HunkLineKind::Added, false) => Token::PassTint,
            (HunkLineKind::Context, false) => Token::Bg,
        };
        c.put(x, row, &run("│", Token::Rule, Token::Bg));
        c.fill(row, x + 1, x1, bg);
        let (sign, sfg) = match line.kind {
            HunkLineKind::Context => (" ", Token::Fg),
            HunkLineKind::Added => ("+", Token::Pass),
            HunkLineKind::Removed => ("-", Token::Fail),
        };
        c.puts(
            x + 1,
            row,
            &[
                if is_cited {
                    run("▌", Token::Fail, bg)
                } else {
                    run(" ", Token::Fg, bg)
                },
                run(pad_left(&line.number.to_string(), digits), Token::Faint, bg),
                run(" ", Token::Fg, bg),
                run(sign, sfg, bg),
                run(" ", Token::Fg, bg),
            ],
        );
        let fg = if line.kind == HunkLineKind::Context && !is_cited {
            Token::Dim
        } else {
            Token::Fg
        };
        put_in(c, text_x, row, x1, &[run(line.text.clone(), fg, bg)]);
        c.put(x1, row, &run("│", Token::Rule, Token::Bg));
        row += 1;
    }
    if let Some(note) = &hunk.note
        && row < limit
    {
        c.put(x, row, &run("│", Token::Rule, Token::Bg));
        put_in(
            c,
            x + 3 + digits as u16,
            row,
            x1,
            &[run(format!("└ {note}"), Token::Fail, Token::Bg)],
        );
        c.put(x1, row, &run("│", Token::Rule, Token::Bg));
        row += 1;
    }
    let bottom = format!("└{}┘", "─".repeat(inner));
    c.put(x, row, &run(bottom, Token::Rule, Token::Bg));
    row
}

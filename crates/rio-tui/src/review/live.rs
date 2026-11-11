//! 01 — Live review: each step with its state, elapsed time and counts, the
//! findings so far, usage, and the tail of the tools' output.

use std::collections::{BTreeMap, VecDeque};

use ratatui::crossterm::event::{KeyCode, KeyEvent};
use rio_core::{
    CancellationReason, Category, CheckKind, CheckOutcome, FailureReason, Finding, Report,
    ReviewEvent, SkipReason, State,
};

use super::{
    FindingsData, clock, evidence_short, finding_glyph, findings, hrule, id8, put_in, seconds,
    vrule,
};
use crate::{
    app::{Action, Msg, Screen, Session},
    canvas::{Canvas, bold, pad, run, width},
    chrome::{Board, Key, key, keybar, quiet, status},
    theme::Token,
};

/// Lines kept per log source.
pub const LOG_LINES: usize = 500;

/// The state of a step, check or agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ItemState {
    /// Not started (`○`).
    Queued,
    /// Running (`◐`).
    Running,
    /// Finished cleanly (`✓`).
    Passed,
    /// Finished with findings (`✕`).
    Flagged,
    /// The tool failed (`✕`).
    Failed,
    /// Skipped (`-`).
    Skipped,
    /// Cancelled by a timeout or Ctrl-C (`-`, in `warn`).
    Cancelled,
}

impl ItemState {
    fn finished(self) -> bool {
        !matches!(self, ItemState::Queued | ItemState::Running)
    }

    fn glyph(self) -> (&'static str, Token) {
        match self {
            ItemState::Queued => ("○", Token::Faint),
            ItemState::Running => ("◐", Token::Warn),
            ItemState::Passed => ("✓", Token::Pass),
            ItemState::Flagged | ItemState::Failed => ("✕", Token::Fail),
            ItemState::Skipped => ("-", Token::Faint),
            ItemState::Cancelled => ("-", Token::Warn),
        }
    }

    fn note_fg(self) -> Token {
        match self {
            ItemState::Flagged | ItemState::Failed => Token::Fail,
            ItemState::Cancelled => Token::Warn,
            _ => Token::Dim,
        }
    }
}

/// A pipeline step: prepare, checks, graph, triage, agents, verify, report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepRow {
    /// The step id the engine's events name.
    pub name: String,
    /// Its state.
    pub state: ItemState,
    /// What it did or is doing, e.g. `snapshot a41f…c09`.
    pub note: String,
    /// Parts done of the step's parts (agents: finished of all).
    pub progress: Option<(usize, usize)>,
    /// When it started, in ms since the session started.
    pub started_ms: Option<u64>,
    /// How long it took, once finished.
    pub elapsed_ms: Option<u64>,
}

impl StepRow {
    fn new(name: &str) -> Self {
        Self {
            name: name.into(),
            state: ItemState::Queued,
            note: String::new(),
            progress: None,
            started_ms: None,
            elapsed_ms: None,
        }
    }
}

/// A project root of the checks step.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RootRow {
    /// The root, e.g. `web/`.
    pub root: String,
    /// Its language.
    pub language: String,
}

/// One check of a root, or a repository-wide check (secrets, audit).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckRow {
    /// The root it runs in; a root not listed in `roots` draws it at the top level.
    pub root: String,
    /// The check.
    pub kind: CheckKind,
    /// Its label, e.g. `typecheck`.
    pub label: String,
    /// The tool, also the log source its `⏎` shows.
    pub tool: String,
    /// Its state.
    pub state: ItemState,
    /// What it found or is doing; empty for the default text.
    pub note: String,
    /// When it started, in ms since the session started.
    pub started_ms: Option<u64>,
    /// How long it took, once finished.
    pub elapsed_ms: Option<u64>,
}

impl CheckRow {
    /// A queued check.
    pub fn new(root: &str, kind: CheckKind, label: &str, tool: &str) -> Self {
        Self {
            root: root.into(),
            kind,
            label: label.into(),
            tool: tool.into(),
            state: ItemState::Queued,
            note: String::new(),
            started_ms: None,
            elapsed_ms: None,
        }
    }

    fn note(&self) -> String {
        if !self.note.is_empty() {
            return self.note.clone();
        }
        match self.state {
            ItemState::Queued => "queued".into(),
            ItemState::Running => format!("{} · running", self.tool),
            _ => self.tool.clone(),
        }
    }
}

/// An agent of the agents step.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRow {
    /// Its name, as `agent:*` events name it.
    pub name: String,
    /// Its state.
    pub state: ItemState,
    /// What it is doing or found; empty for the default text.
    pub note: String,
    /// When it started, in ms since the session started.
    pub started_ms: Option<u64>,
    /// How long it took, once finished.
    pub elapsed_ms: Option<u64>,
}

/// Findings reported so far, by kind.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FindingCounts {
    /// New findings (not security).
    pub new: usize,
    /// Worsened findings (not security).
    pub worsened: usize,
    /// Security findings.
    pub security: usize,
    /// Pre-existing findings.
    pub pre_existing: usize,
}

impl FindingCounts {
    fn add(&mut self, finding: &Finding) {
        if finding.category == Category::Security {
            self.security += 1;
        } else {
            match finding.state {
                State::New => self.new += 1,
                State::Worsened => self.worsened += 1,
                State::PreExisting => self.pre_existing += 1,
                _ => {}
            }
        }
    }
}

/// Model usage against the budget.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Usage {
    /// Input tokens.
    pub tokens_in: u64,
    /// Output tokens.
    pub tokens_out: u64,
    /// Spent, in cents.
    pub cost_cents: u64,
    /// The budget, in cents.
    pub budget_cents: u64,
}

/// A line of a tool's output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogLine {
    /// When it arrived, in ms since the session started.
    pub at_ms: u64,
    /// The tool or step that wrote it.
    pub source: String,
    /// The line.
    pub line: String,
}

/// The live screen's model; events update it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveState {
    /// The seven steps in order.
    pub steps: Vec<StepRow>,
    /// The roots of the checks step.
    pub roots: Vec<RootRow>,
    /// The checks, grouped under their roots when drawn.
    pub checks: Vec<CheckRow>,
    /// The agents in order.
    pub agents: Vec<AgentRow>,
    /// Verifiers per hypothesis.
    pub quorum: u32,
    /// Findings so far.
    pub counts: FindingCounts,
    /// Findings reported so far, in arrival order.
    pub findings: Vec<Finding>,
    /// Model usage; no event carries it yet, so it shows what the host set.
    pub usage: Option<Usage>,
    /// The host's estimate of the time left.
    pub eta_ms: Option<u64>,
    /// The last lines of every source, in arrival order.
    pub log: VecDeque<LogLine>,
    /// The last lines per source.
    pub by_source: BTreeMap<String, VecDeque<LogLine>>,
}

const STEPS: [&str; 7] = [
    "prepare", "checks", "graph", "triage", "agents", "verify", "report",
];

impl LiveState {
    /// Every step queued, with these agents.
    pub fn new(agents: Vec<String>) -> Self {
        Self {
            steps: STEPS.iter().map(|s| StepRow::new(s)).collect(),
            roots: Vec::new(),
            checks: Vec::new(),
            agents: agents
                .into_iter()
                .map(|name| AgentRow {
                    name,
                    state: ItemState::Queued,
                    note: String::new(),
                    started_ms: None,
                    elapsed_ms: None,
                })
                .collect(),
            quorum: 0,
            counts: FindingCounts::default(),
            findings: Vec::new(),
            usage: None,
            eta_ms: None,
            log: VecDeque::new(),
            by_source: BTreeMap::new(),
        }
    }

    /// Record a log line, keeping at most [`LOG_LINES`] per source.
    pub fn push_log(&mut self, at_ms: u64, source: &str, line: &str) {
        let entry = LogLine {
            at_ms,
            source: source.into(),
            line: line.into(),
        };
        let lines = self.by_source.entry(source.into()).or_default();
        lines.push_back(entry.clone());
        while lines.len() > LOG_LINES {
            lines.pop_front();
        }
        self.log.push_back(entry);
        while self.log.len() > LOG_LINES {
            self.log.pop_front();
        }
    }

    fn step_mut(&mut self, name: &str) -> Option<&mut StepRow> {
        self.steps.iter_mut().find(|s| s.name == name)
    }

    /// Apply one engine event at `now` ms.
    pub fn apply(&mut self, event: &ReviewEvent, now: u64) {
        match event {
            ReviewEvent::StepStarted { step } => {
                if let Some(row) = self.step_mut(step) {
                    row.state = ItemState::Running;
                    row.started_ms = Some(now);
                }
                if step == "checks" {
                    for check in &mut self.checks {
                        if check.state == ItemState::Queued {
                            check.state = ItemState::Running;
                            check.started_ms = Some(now);
                        }
                    }
                }
                if step == "agents" {
                    let total = self.agents.len();
                    if let Some(row) = self.step_mut("agents") {
                        row.progress = Some((0, total));
                    }
                }
            }
            ReviewEvent::StepFinished { step } => {
                if let Some(row) = self.step_mut(step) {
                    row.state = ItemState::Passed;
                    row.elapsed_ms = Some(now.saturating_sub(row.started_ms.unwrap_or(now)));
                }
            }
            ReviewEvent::CheckFinished {
                kind,
                root,
                findings,
                outcome,
                ..
            } => {
                let index = match self
                    .checks
                    .iter()
                    .position(|c| c.kind == *kind && c.root == *root)
                {
                    Some(i) => i,
                    None => {
                        let label = check_label(*kind);
                        let mut row = CheckRow::new(root, *kind, label, label);
                        row.started_ms = self.steps.get(1).and_then(|s| s.started_ms);
                        self.checks.push(row);
                        self.checks.len() - 1
                    }
                };
                let row = &mut self.checks[index];
                let (state, note) = outcome_state(outcome, *findings, &row.tool, *kind);
                row.state = state;
                row.note = note;
                row.elapsed_ms = Some(now.saturating_sub(row.started_ms.unwrap_or(now)));
                for finding in &outcome.details().findings {
                    self.counts.add(finding);
                    self.findings.push(finding.clone());
                }
            }
            ReviewEvent::GraphReady { impact } => {
                if let Some(row) = self.step_mut("graph")
                    && row.note.is_empty()
                {
                    let n = impact.symbols.len();
                    row.note = format!(
                        "{n} changed symbol{} · {} unresolved",
                        if n == 1 { "" } else { "s" },
                        impact.unresolved
                    );
                }
            }
            ReviewEvent::AgentStarted { agent } => {
                let row = match self.agents.iter().position(|a| a.name == *agent) {
                    Some(i) => &mut self.agents[i],
                    None => {
                        self.agents.push(AgentRow {
                            name: agent.clone(),
                            state: ItemState::Queued,
                            note: String::new(),
                            started_ms: None,
                            elapsed_ms: None,
                        });
                        self.agents.last_mut().expect("just pushed")
                    }
                };
                row.state = ItemState::Running;
                row.note.clear();
                row.started_ms = Some(now);
                self.update_agent_progress();
            }
            ReviewEvent::AgentFinished { agent, hypotheses } => {
                if let Some(row) = self.agents.iter_mut().find(|a| a.name == *agent) {
                    row.state = ItemState::Passed;
                    row.note = format!(
                        "{hypotheses} hypothes{}",
                        if *hypotheses == 1 { "is" } else { "es" }
                    );
                    row.elapsed_ms = Some(now.saturating_sub(row.started_ms.unwrap_or(now)));
                }
                self.update_agent_progress();
            }
            ReviewEvent::VerifyProgress { done, total } => {
                let quorum = self.quorum;
                if let Some(row) = self.step_mut("verify") {
                    if row.state == ItemState::Queued {
                        row.state = ItemState::Running;
                        row.started_ms = Some(now);
                    }
                    row.progress = Some((*done, *total));
                    row.note = if quorum > 0 {
                        format!(
                            "quorum {} of {quorum} · {done}/{total} done",
                            quorum.div_ceil(2).max(1)
                        )
                    } else {
                        format!("{done}/{total} done")
                    };
                }
            }
            ReviewEvent::FindingVerified { finding } => {
                self.counts.add(finding);
                self.findings.push((**finding).clone());
            }
            ReviewEvent::Log { source, line } => self.push_log(now, source, line),
            ReviewEvent::Done { .. } | ReviewEvent::Partial { .. } | ReviewEvent::QaCell { .. } => {
            }
        }
    }

    fn update_agent_progress(&mut self) {
        let done = self.agents.iter().filter(|a| a.state.finished()).count();
        let total = self.agents.len();
        if let Some(row) = self.step_mut("agents") {
            row.progress = Some((done, total));
        }
    }

    /// Finished parts of all parts: each step without children, each check, each agent.
    fn progress(&self) -> (usize, usize) {
        let mut done = 0;
        let mut total = 0;
        for step in &self.steps {
            match step.name.as_str() {
                "checks" => {
                    total += self.checks.len();
                    done += self.checks.iter().filter(|c| c.state.finished()).count();
                }
                "agents" => {
                    total += self.agents.len();
                    done += self.agents.iter().filter(|a| a.state.finished()).count();
                }
                _ => {
                    total += 1;
                    done += usize::from(step.state.finished());
                }
            }
        }
        (done, total)
    }
}

fn check_label(kind: CheckKind) -> &'static str {
    match kind {
        CheckKind::Typecheck => "typecheck",
        CheckKind::Lint => "lint",
        CheckKind::Secrets => "secrets",
        CheckKind::Coverage => "coverage",
        CheckKind::Dependencies => "audit",
    }
}

/// The row state and text of a finished check.
fn outcome_state(
    outcome: &CheckOutcome,
    findings: usize,
    tool: &str,
    kind: CheckKind,
) -> (ItemState, String) {
    let plural = |n: usize| if n == 1 { "" } else { "s" };
    match outcome {
        CheckOutcome::Passed { .. } if kind == CheckKind::Secrets => {
            (ItemState::Passed, "0 found".into())
        }
        CheckOutcome::Passed { .. } => (ItemState::Passed, String::new()),
        CheckOutcome::Findings { .. } if kind == CheckKind::Secrets => {
            (ItemState::Flagged, format!("{findings} found"))
        }
        CheckOutcome::Findings { .. } => (
            ItemState::Flagged,
            format!("{tool} · {findings} finding{}", plural(findings)),
        ),
        CheckOutcome::Failed { reason, .. } => {
            (ItemState::Failed, format!("failed: {}", failure(*reason)))
        }
        CheckOutcome::Skipped { reason, .. } => (
            ItemState::Skipped,
            format!("skipped: {}", skip(*reason, tool)),
        ),
        CheckOutcome::Cancelled { reason, .. } => (
            ItemState::Cancelled,
            match reason {
                CancellationReason::Interrupted => "cancelled: interrupted".into(),
                CancellationReason::Timeout => "cancelled: timeout".into(),
            },
        ),
    }
}

fn failure(reason: FailureReason) -> &'static str {
    match reason {
        FailureReason::SpawnFailed => "spawn failed",
        FailureReason::ToolCrashed => "tool crashed",
        FailureReason::ToolConfigError => "tool config error",
        FailureReason::UnparseableOutput => "unparseable output",
        FailureReason::OutputLimit => "output limit",
        FailureReason::DiskFull => "disk full",
        FailureReason::TestsFailed => "tests failed",
        FailureReason::NetworkError => "network error",
        FailureReason::PartialData => "partial data",
    }
}

fn skip(reason: SkipReason, tool: &str) -> String {
    match reason {
        SkipReason::ToolMissing => format!("{tool} missing"),
        SkipReason::NoProjectConfig => "no project config".into(),
        SkipReason::NotSupportedByAdapter => "not supported".into(),
        SkipReason::Disabled => "disabled".into(),
        SkipReason::Offline => "offline".into(),
        SkipReason::DependencyMismatch => "dependencies differ".into(),
        SkipReason::NoTests => "no tests".into(),
        SkipReason::NothingToAudit => "nothing to audit".into(),
    }
}

/// Builds the findings screen's data from the final or partial report.
pub type FindingsBuilder = Box<dyn Fn(&Report) -> FindingsData>;

/// A findings builder the host shares between the start and live screens.
pub type SharedFindingsBuilder = std::rc::Rc<dyn Fn(&Report) -> FindingsData>;

/// What the live screen shows besides the events.
pub struct LiveData {
    /// The header context, e.g. `feature/parser-guards → origin/main · rio/openrouter · standard`.
    pub context: String,
    /// The command line running, on one line.
    pub command: String,
    /// The headline, e.g. `Reviewing feature/parser-guards`.
    pub title: String,
    /// The footer line under the pipeline.
    pub note: String,
    /// The model at the start (normally every step queued).
    pub state: LiveState,
    /// Builds the findings screen's data from the report the review ends with.
    pub on_report: FindingsBuilder,
}

impl LiveData {
    /// Live data whose findings screen shows the report with this header context.
    pub fn new(context: String, command: String, title: String, state: LiveState) -> Self {
        let header = context.clone();
        Self {
            context,
            command,
            title,
            note: String::new(),
            state,
            on_report: Box::new(move |report| FindingsData::new(report.clone(), &header)),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Pane {
    /// The tail of every source.
    Tail,
    /// The tail of one row's source.
    Step(String),
    /// Every source over the whole right pane.
    Full,
    /// The findings that arrived.
    Findings,
}

const KEYS: &[Key] = &[
    key("ctrl-c", "stop"),
    key("↑↓", "move"),
    key("⏎", "step log"),
    key("l", "full log"),
    key("f", "findings"),
    key("?", "help"),
];

pub(crate) struct LiveScreen {
    data: LiveData,
    cursor: usize,
    pane: Pane,
    /// The review could not run: why (shown instead of the progress).
    failed: Option<String>,
}

/// A drawn pipeline row.
struct Row {
    /// 0 step, 1 root header, 2 check of a root, 3 top-level check or agent.
    level: u8,
    state: ItemState,
    label: String,
    note: String,
    note_fg: Token,
    elapsed: Option<u64>,
    source: Option<String>,
}

impl LiveScreen {
    pub(crate) fn new(data: LiveData) -> Self {
        let mut screen = Self {
            data,
            cursor: 0,
            pane: Pane::Tail,
            failed: None,
        };
        screen.cursor = screen.selectable().first().copied().unwrap_or(0);
        screen
    }

    fn rows(&self, now: u64) -> Vec<Row> {
        let s = &self.data.state;
        let elapsed = |started: Option<u64>, done: Option<u64>, state: ItemState| {
            done.or_else(|| {
                (state == ItemState::Running)
                    .then_some(started)
                    .flatten()
                    .map(|t| now.saturating_sub(t))
            })
        };
        let mut rows = Vec::new();
        for step in &s.steps {
            let note = match (step.name.as_str(), step.progress) {
                ("checks", _) if step.note.is_empty() => {
                    let n = s.roots.len();
                    format!("{n} root{}", if n == 1 { "" } else { "s" })
                }
                ("agents", Some((done, total))) if step.note.is_empty() => {
                    format!("{done} of {total}")
                }
                ("verify", _) if step.note.is_empty() && s.quorum > 0 => {
                    format!("quorum {} of {}", s.quorum.div_ceil(2).max(1), s.quorum)
                }
                _ => step.note.clone(),
            };
            rows.push(Row {
                level: 0,
                state: step.state,
                label: step.name.clone(),
                note,
                note_fg: Token::Dim,
                elapsed: elapsed(step.started_ms, step.elapsed_ms, step.state),
                source: Some(step.name.clone()),
            });
            match step.name.as_str() {
                "checks" => {
                    for root in &s.roots {
                        rows.push(Row {
                            level: 1,
                            state: ItemState::Queued,
                            label: root.root.clone(),
                            note: root.language.clone(),
                            note_fg: Token::Dim,
                            elapsed: None,
                            source: None,
                        });
                        for check in s.checks.iter().filter(|c| c.root == root.root) {
                            rows.push(check_row(check, 2, &elapsed));
                        }
                    }
                    for check in s
                        .checks
                        .iter()
                        .filter(|c| !s.roots.iter().any(|r| r.root == c.root))
                    {
                        rows.push(check_row(check, 3, &elapsed));
                    }
                }
                "agents" => {
                    for agent in &s.agents {
                        let note = if agent.note.is_empty() {
                            match agent.state {
                                ItemState::Queued => "queued".into(),
                                ItemState::Running => "running".into(),
                                _ => String::new(),
                            }
                        } else {
                            agent.note.clone()
                        };
                        rows.push(Row {
                            level: 3,
                            state: agent.state,
                            label: agent.name.clone(),
                            note,
                            note_fg: agent.state.note_fg(),
                            elapsed: elapsed(agent.started_ms, agent.elapsed_ms, agent.state),
                            source: Some("agents".into()),
                        });
                    }
                }
                _ => {}
            }
        }
        rows
    }

    fn selectable(&self) -> Vec<usize> {
        self.rows(0)
            .iter()
            .enumerate()
            .filter(|(_, r)| r.source.is_some())
            .map(|(i, _)| i)
            .collect()
    }

    fn move_cursor(&mut self, delta: isize) {
        let rows = self.selectable();
        let at = rows.iter().position(|&r| r == self.cursor).unwrap_or(0);
        let next = at
            .saturating_add_signed(delta)
            .min(rows.len().saturating_sub(1));
        if let Some(&row) = rows.get(next) {
            self.cursor = row;
        }
    }

    /// The step running last in pipeline order, with its position.
    fn current(&self) -> Option<(usize, &StepRow)> {
        self.data
            .state
            .steps
            .iter()
            .enumerate()
            .rfind(|(_, s)| s.state == ItemState::Running)
    }
}

fn check_row(
    check: &CheckRow,
    level: u8,
    elapsed: &dyn Fn(Option<u64>, Option<u64>, ItemState) -> Option<u64>,
) -> Row {
    Row {
        level,
        state: check.state,
        label: check.label.clone(),
        note: check.note(),
        note_fg: check.state.note_fg(),
        elapsed: elapsed(check.started_ms, check.elapsed_ms, check.state),
        source: Some(check.tool.clone()),
    }
}

/// The first line of `command` that fits in `max` cells, cut at flags.
fn first_line(command: &str, max: usize) -> String {
    let mut line = String::new();
    for (i, part) in command.split(" --").enumerate() {
        let part = if i == 0 {
            part.to_owned()
        } else {
            format!(" --{part}")
        };
        if i > 0 && width(&line) + width(&part) > max {
            break;
        }
        line.push_str(&part);
    }
    crate::canvas::fit(&line, max)
}

/// `141k`.
fn tokens(n: u64) -> String {
    if n >= 1000 {
        format!("{}k", n / 1000)
    } else {
        n.to_string()
    }
}

fn dollars(cents: u64) -> String {
    format!("${}.{:02}", cents / 100, cents % 100)
}

/// A log line's color: a running marker warns, a `path:line` or `✕` fails.
fn log_fg(line: &str) -> Token {
    let first = line.split_whitespace().next().unwrap_or("");
    if line.starts_with('◐') {
        Token::Warn
    } else if line.starts_with('✕')
        || line.starts_with("error")
        || first.rsplit_once(':').is_some_and(|(path, n)| {
            path.contains('.') && n.chars().all(|c| c.is_ascii_digit()) && !n.is_empty()
        })
    {
        Token::Fail
    } else {
        Token::Dim
    }
}

impl Screen for LiveScreen {
    fn title(&self) -> &'static str {
        "Live review"
    }
    fn board(&self) -> Board {
        Board::V2
    }
    fn keys(&self) -> &'static [Key] {
        KEYS
    }

    fn draw(&self, c: &mut Canvas<'_>, session: &Session) {
        c.clear(Token::Bg);
        let now = session.ticks * 250;
        let s = &self.data.state;
        let state = if self.failed.is_some() {
            status("✕ the review did not run", Token::Fail)
        } else if session.interrupted {
            status("◐ stopping · partial report follows", Token::Warn)
        } else {
            match self.current() {
                Some((_, step)) => {
                    let progress = step
                        .progress
                        .map(|(d, t)| format!(" {d}/{t}"))
                        .unwrap_or_default();
                    status(format!("◐ running · {}{progress}", step.name), Token::Warn)
                }
                None => status("◐ starting", Token::Warn),
            }
        };
        super::head(c, &self.data.context, &[state, quiet(clock(now))]);
        let (w, h) = (c.width(), c.height());
        let div = if w >= 120 { 56 } else { (w * 56 / 120).max(40) };
        let lr = div - 2;
        let bottom = h.saturating_sub(1);
        vrule(c, div, 1, bottom);

        // Pipeline.
        c.put(2, 2, &bold("PIPELINE", Token::Faint, Token::Bg));
        let rows = self.rows(now);
        let room = usize::from(bottom.saturating_sub(4));
        let skip = (self.cursor + 1).saturating_sub(room);
        let mut y = 3;
        for (i, row) in rows.iter().enumerate().skip(skip).take(room) {
            let focused = i == self.cursor;
            let bg = if focused {
                c.fill(y, 0, div, Token::Raise);
                c.put(0, y, &run("▌", Token::Signal, Token::Raise));
                c.cursor(y, 0, div);
                Token::Raise
            } else {
                Token::Bg
            };
            let (glyph, gfg) = row.state.glyph();
            let label = |x: u16, bold_label: bool| {
                if bold_label {
                    bold(pad(&row.label, usize::from(24 - x.min(23))), Token::Fg, bg)
                } else {
                    run(pad(&row.label, usize::from(24 - x.min(23))), Token::Fg, bg)
                }
            };
            match row.level {
                0 => {
                    c.puts(
                        2,
                        y,
                        &[run(glyph, gfg, bg), run(" ", Token::Fg, bg), label(4, true)],
                    );
                }
                1 => {
                    c.puts(
                        3,
                        y,
                        &[
                            run("·", Token::Rule, bg),
                            run("   ", Token::Fg, bg),
                            run(pad(&row.label, 17), Token::Dim, bg),
                        ],
                    );
                }
                2 => {
                    c.puts(
                        6,
                        y,
                        &[
                            run("·", Token::Rule, bg),
                            run(" ", Token::Fg, bg),
                            run(glyph, gfg, bg),
                            run(" ", Token::Fg, bg),
                            label(10, focused),
                        ],
                    );
                }
                _ => {
                    c.puts(
                        3,
                        y,
                        &[
                            run("·", Token::Rule, bg),
                            run(" ", Token::Fg, bg),
                            run(glyph, gfg, bg),
                            run(" ", Token::Fg, bg),
                            label(7, focused),
                        ],
                    );
                }
            }
            let elapsed = row.elapsed.map(seconds);
            let note_right = lr.saturating_sub(elapsed.as_ref().map_or(0, |e| width(e) as u16 + 1));
            put_in(
                c,
                24.min(lr),
                y,
                note_right,
                &[run(row.note.clone(), row.note_fg, bg)],
            );
            if let Some(e) = elapsed {
                c.put_right(lr, y, &[run(e, Token::Faint, bg)]);
            }
            y += 1;
        }
        if let Some(error) = &self.failed
            && y + 2 < bottom
        {
            put_in(
                c,
                2,
                y + 2,
                lr,
                &[run(format!("✕ {error}"), Token::Fail, Token::Bg)],
            );
            if y + 3 < bottom {
                put_in(
                    c,
                    2,
                    y + 3,
                    lr,
                    &[run(
                        "q quit · rio review --no-tui shows the same error",
                        Token::Faint,
                        Token::Bg,
                    )],
                );
            }
        } else if !self.data.note.is_empty() && y + 2 < bottom {
            put_in(
                c,
                2,
                y + 2,
                lr,
                &[run(self.data.note.clone(), Token::Faint, Token::Bg)],
            );
        }

        // Right pane.
        let x = div + 2;
        let right = w.saturating_sub(2);
        let notice_y = h.saturating_sub(3);
        let line = |c: &mut Canvas<'_>, y: u16| hrule(c, y, div + 1, w);
        let title = |c: &mut Canvas<'_>, y: u16, text: &str| {
            put_in(c, x, y, right, &[bold(text, Token::Faint, Token::Bg)]);
        };
        // Short terminals give the usage block's rows to the log.
        let compact = h < 32;
        let log_head = if compact { 14 } else { 19 };
        let log_top = if self.pane == Pane::Full {
            4
        } else {
            log_head + 2
        };
        let log_title = match &self.pane {
            Pane::Full => "FULL LOG · ALL SOURCES".to_owned(),
            Pane::Step(source) => format!("LOG · {}", source.to_uppercase()),
            Pane::Findings => "FINDINGS".into(),
            Pane::Tail => "STDERR · TAIL".into(),
        };
        if self.pane == Pane::Full {
            title(c, 2, &log_title);
        } else {
            put_in(
                c,
                x,
                2,
                right,
                &[run(
                    first_line(&self.data.command, usize::from(right - x)),
                    Token::Faint,
                    Token::Bg,
                )],
            );
            put_in(
                c,
                x,
                3,
                right,
                &[bold(self.data.title.clone(), Token::Fg, Token::Bg)],
            );
            let (done, total) = s.progress();
            let cells = usize::from(right - x);
            let filled = (cells * done).checked_div(total).unwrap_or(0);
            c.puts(
                x,
                5,
                &[
                    run("█".repeat(filled), Token::Signal, Token::Bg),
                    run("░".repeat(cells - filled), Token::Rule, Token::Bg),
                ],
            );
            if let Some((i, step)) = self.current() {
                put_in(
                    c,
                    x,
                    6,
                    right,
                    &[run(
                        format!("step {} of {} · {}", i + 1, s.steps.len(), step.name),
                        Token::Dim,
                        Token::Bg,
                    )],
                );
            }
            if let Some(eta) = s.eta_ms {
                c.put_right(
                    right,
                    6,
                    &[run(format!("~{} left ", clock(eta)), Token::Dim, Token::Bg)],
                );
            }
            line(c, 8);
            title(c, 9, "FINDINGS SO FAR");
            let counts = [
                (s.counts.new, "new", Token::Fail),
                (s.counts.worsened, "worsened", Token::Warn),
                (s.counts.security, "security", Token::Sec),
                (s.counts.pre_existing, "pre-existing", Token::Faint),
            ];
            for (i, (n, label, fg)) in counts.iter().enumerate() {
                let cx = x + 15 * i as u16;
                if cx < right {
                    put_in(
                        c,
                        cx,
                        11,
                        right,
                        &[
                            bold(n.to_string(), *fg, Token::Bg),
                            run(" ", Token::Fg, Token::Bg),
                            run(*label, Token::Dim, Token::Bg),
                        ],
                    );
                }
            }
            line(c, 13);
            if !compact {
                title(c, 14, "USAGE");
            }
            if let Some(u) = s.usage.filter(|_| !compact) {
                put_in(
                    c,
                    x,
                    15,
                    right,
                    &[run(
                        format!("{} in · {} out", tokens(u.tokens_in), tokens(u.tokens_out)),
                        Token::Dim,
                        Token::Bg,
                    )],
                );
                c.put_right(
                    right,
                    15,
                    &[run(
                        format!("{} / {}", dollars(u.cost_cents), dollars(u.budget_cents)),
                        Token::Dim,
                        Token::Bg,
                    )],
                );
                let used = (cells as u64 * u.cost_cents + u.budget_cents / 2)
                    .checked_div(u.budget_cents)
                    .unwrap_or(0)
                    .min(cells as u64) as usize;
                c.puts(
                    x,
                    16,
                    &[
                        run("━".repeat(used), Token::Signal, Token::Bg),
                        run("─".repeat(cells - used), Token::Rule, Token::Bg),
                    ],
                );
            }
            if !compact {
                line(c, 18);
            }
            title(c, log_head, &log_title);
        }
        let log_rows = usize::from(notice_y.saturating_sub(1).saturating_sub(log_top));
        if self.pane == Pane::Findings {
            for (i, f) in s.findings.iter().take(log_rows).enumerate() {
                let y = log_top + i as u16;
                let (g, fg) = finding_glyph(f);
                put_in(
                    c,
                    x,
                    y,
                    right,
                    &[
                        run(g, fg, Token::Bg),
                        run(" ", Token::Fg, Token::Bg),
                        run(id8(&f.id), Token::Faint, Token::Bg),
                        run(" ", Token::Fg, Token::Bg),
                        run(f.message.clone(), Token::Fg, Token::Bg),
                        run(
                            format!("  {}", evidence_short(f.evidence_level)),
                            Token::Faint,
                            Token::Bg,
                        ),
                    ],
                );
            }
        } else {
            let lines: Vec<&LogLine> = match &self.pane {
                Pane::Step(source) => s
                    .by_source
                    .get(source)
                    .map(|l| l.iter().collect())
                    .unwrap_or_default(),
                _ => s.log.iter().collect(),
            };
            let start = lines.len().saturating_sub(log_rows);
            for (i, l) in lines[start..].iter().enumerate() {
                let y = log_top + i as u16;
                let secs = l.at_ms / 1000;
                put_in(
                    c,
                    x,
                    y,
                    right,
                    &[
                        run(
                            format!("{:02}:{:02}", secs / 60, secs % 60),
                            Token::Faint,
                            Token::Bg,
                        ),
                        run(" ", Token::Fg, Token::Bg),
                        run(pad(&l.source, 6), Token::Signal, Token::Bg),
                        run("  ", Token::Fg, Token::Bg),
                        run(l.line.clone(), log_fg(&l.line), Token::Bg),
                    ],
                );
            }
            if lines.is_empty() && self.pane != Pane::Tail {
                put_in(
                    c,
                    x,
                    log_top,
                    right,
                    &[run("no output yet", Token::Faint, Token::Bg)],
                );
            }
        }
        // The interrupt notice.
        c.fill(notice_y, div + 1, w, Token::Panel);
        let notice = if session.interrupted {
            "stopping · a partial report follows  (again: exit 130)"
        } else {
            "stop · keep partial report  (twice: exit 130)"
        };
        put_in(
            c,
            x,
            notice_y,
            w,
            &[
                bold("ctrl-c", Token::Fg, Token::Panel),
                run(" ", Token::Fg, Token::Panel),
                run(
                    notice,
                    if session.interrupted {
                        Token::Warn
                    } else {
                        Token::Faint
                    },
                    Token::Panel,
                ),
            ],
        );
        keybar(c, KEYS);
    }

    fn on_key(&mut self, key: KeyEvent, _session: &mut Session) -> Action {
        match key.code {
            KeyCode::Up | KeyCode::Char('k') => self.move_cursor(-1),
            KeyCode::Down | KeyCode::Char('j') => self.move_cursor(1),
            KeyCode::Enter => {
                let source = self.rows(0).get(self.cursor).and_then(|r| r.source.clone());
                if let Some(source) = source {
                    self.pane = if self.pane == Pane::Step(source.clone()) {
                        Pane::Tail
                    } else {
                        Pane::Step(source)
                    };
                }
            }
            KeyCode::Char('l') => {
                self.pane = if self.pane == Pane::Full {
                    Pane::Tail
                } else {
                    Pane::Full
                }
            }
            KeyCode::Char('f') => {
                self.pane = if self.pane == Pane::Findings {
                    Pane::Tail
                } else {
                    Pane::Findings
                }
            }
            KeyCode::Esc if self.pane != Pane::Tail => self.pane = Pane::Tail,
            _ => {}
        }
        Action::None
    }

    fn on_msg(&mut self, msg: &Msg, session: &mut Session) -> Action {
        if let Msg::Done(crate::app::Outcome::Failed(error)) = msg {
            self.failed = Some(error.clone());
            return Action::None;
        }
        let Msg::Review(event) = msg else {
            return Action::None;
        };
        let now = session.ticks * 250;
        match event {
            ReviewEvent::Done { report } | ReviewEvent::Partial { report } => {
                session.report = Some((**report).clone());
                session.saved = false;
                Action::Replace(findings((self.data.on_report)(report)))
            }
            event => {
                self.data.state.apply(event, now);
                Action::None
            }
        }
    }
}

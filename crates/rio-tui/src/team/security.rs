//! P1: security findings with their catalog coverage, the input → sink
//! trace, and the council's members, rounds, experiments and decision.

use std::collections::BTreeMap;

use ratatui::crossterm::event::{KeyCode, KeyEvent};
use rio_core::{
    BlindMatch, Category, CouncilDecision, CouncilMember, CouncilReview, CouncilTier,
    EvidenceLevel, Finding, SecurityCatalog, SecurityCoverage, Severity, State,
};
use serde_json::Value;

use crate::{
    app::{Action, Effect, Msg, Outcome, Screen, Session},
    canvas::{Canvas, Run, bold, pad, run},
    chrome::{Board, Key, Status, focus, key, keybar},
    theme::Token,
};

use super::{
    history::{HistoryData, history},
    picker::{self, Picked, Picker},
    publish::{PublishData, publish},
    ui::{Pane, body_bottom, clip, footer, plural, short, top, vrule, wrap},
};

/// What P1 shows. Built by the CLI from the finished `Report` plus a few
/// presentation details the report does not carry.
#[derive(Debug, Clone, Default)]
pub struct SecurityData {
    /// Header context, e.g. `review · PR #142 · rio/security · deep`.
    pub context: String,
    /// Header status segments, right-aligned (outcome, risk, elapsed).
    pub status: Vec<Status>,
    /// Where the findings come from, e.g. `PR #142`.
    pub scope: String,
    /// The findings of the review in list order; refuted ones are never shown.
    pub entries: Vec<SecurityEntry>,
    /// `Report.security_coverage`: which catalog items the security step assessed.
    pub coverage: Option<SecurityCoverage>,
    /// Per catalog item (`A03`), a short note: the tool that assessed it or why it does not apply.
    pub notes: BTreeMap<String, String>,
    /// The review posture, e.g. `thorough`.
    pub posture: Option<String>,
    /// An endpoint is configured (dismissals, audit and publishing need one).
    pub endpoint: bool,
    /// What `P` opens: the pull request and lineage context of the publish preview.
    pub publish: PublishData,
    /// What `F` opens: the repository registry context.
    pub history: HistoryData,
}

/// One finding of the list and the detail P1 draws for it.
#[derive(Debug, Clone)]
pub struct SecurityEntry {
    /// The finding as the report carries it, `council` and `trace` included.
    pub finding: Finding,
    /// Short label for the list; the message is used when absent.
    pub label: Option<String>,
    /// The finding fails the review's `fail_on` policy (`FAIL` tag).
    pub fails: bool,
    /// Source excerpt around the location, read from the working tree.
    pub code: Vec<CodeLine>,
    /// The version the excerpt was read from (`head`).
    pub code_version: String,
    /// What each `finding.trace.steps[i]` is, in the same order.
    pub steps: Vec<StepText>,
    /// What each `finding.council.experiments[i]` asked and observed, in the same order.
    pub experiments: Vec<ExperimentNote>,
    /// The council trigger rule that selected the finding, e.g. `verify.split`.
    pub council_trigger: Option<String>,
    /// The finding's council cost, e.g. `$0.21`.
    pub cost: Option<String>,
    /// The audit record id of the council run, e.g. `au-77f1`.
    pub audit: Option<String>,
}

/// One line of a source excerpt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodeLine {
    /// 1-based line number.
    pub line: u32,
    /// The line's text.
    pub text: String,
    /// The change touched this line (drawn on `fail-tint` with `+`).
    pub changed: bool,
}

/// The cited expression and stage of one trace step.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepText {
    /// The cited code, e.g. `req.params.id`; for a missing step what is missing.
    pub code: String,
    /// `input`, `validation`, `authorization` or `sensitive read`.
    pub stage: String,
    /// Why the step matters, shown after the stage.
    pub note: Option<String>,
}

/// What an experiment was asked to show and what each version did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExperimentNote {
    /// The member that requested it.
    pub requested_by: Option<String>,
    /// What head returned, e.g. `200` / `returns shopper A's order`.
    pub head: Option<Observation>,
    /// What base returned.
    pub base: Option<Observation>,
}

/// One version's observed result.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Observation {
    /// The short result, e.g. `200`.
    pub result: String,
    /// What it means, e.g. `returns shopper A's order`.
    pub detail: String,
}

impl SecurityEntry {
    pub fn new(finding: Finding) -> Self {
        Self {
            finding,
            label: None,
            fails: false,
            code: Vec::new(),
            code_version: "head".into(),
            steps: Vec::new(),
            experiments: Vec::new(),
            council_trigger: None,
            cost: None,
            audit: None,
        }
    }
}

const KEYS: &[Key] = &[
    key("↑↓", "finding"),
    key("t", "trace"),
    key("c", "council"),
    key("a", "audit"),
    key("d", "dismiss…"),
    focus("P", "publish"),
    key("F", "history"),
    key("esc", "back"),
];

/// Which detail the right pane (or, below 120 columns, the only detail pane) shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum View {
    Trace,
    Council,
    Audit,
}

pub struct SecurityScreen {
    data: SecurityData,
    cursor: usize,
    view: View,
    picker: Option<Picker>,
    /// The audit record once fetched (`Outcome::Value("audit", …)`).
    audit: Option<Result<Value, String>>,
    /// Responses recorded in this session: identity → reason.
    dismissed: BTreeMap<String, String>,
}

/// P1. Expects `Outcome::Value("audit", <GET /v1/reviews/{id}/audit>)` after
/// `Effect::Fetch("audit")`; `P` and `F` open P2 and P3.
pub fn security(data: SecurityData) -> Box<dyn Screen> {
    Box::new(SecurityScreen::new(data))
}

impl SecurityScreen {
    pub fn new(mut data: SecurityData) -> Self {
        data.entries
            .retain(|e| e.finding.evidence_level != EvidenceLevel::Refuted);
        Self {
            data,
            cursor: 0,
            view: View::Council,
            picker: None,
            audit: None,
            dismissed: BTreeMap::new(),
        }
    }

    /// Focus the finding with this identity (opened from the findings hub).
    pub fn focused_on(mut self, id: &str) -> Self {
        if let Some(i) = self.data.entries.iter().position(|e| e.finding.id == id) {
            self.cursor = i;
            if self.data.entries[i].finding.council.is_none() {
                self.view = View::Trace;
            }
        }
        self
    }

    fn entry(&self) -> Option<&SecurityEntry> {
        self.data.entries.get(self.cursor)
    }
}

impl Screen for SecurityScreen {
    fn title(&self) -> &'static str {
        "Security finding and council"
    }
    fn board(&self) -> Board {
        Board::V3
    }
    fn keys(&self) -> &'static [Key] {
        if self.picker.is_some() {
            picker::KEYS
        } else {
            KEYS
        }
    }
    fn wants_text(&self) -> bool {
        self.picker.as_ref().is_some_and(|p| p.note_focus)
    }

    fn draw(&self, c: &mut Canvas<'_>, session: &Session) {
        c.clear(Token::Bg);
        top(c, &self.data.context, &self.data.status);
        let bottom = body_bottom(c);
        let wide = c.width() >= 120;
        vrule(c, 30, 1, bottom);
        self.draw_left(c, Pane::new(0, 30, bottom));
        if wide {
            vrule(c, 73, 1, bottom);
            self.draw_detail(c, Pane::new(31, 73, bottom));
            self.draw_side(c, Pane::new(74, c.width(), bottom));
        } else if self.view == View::Trace {
            self.draw_detail(c, Pane::new(31, c.width(), bottom));
        } else {
            self.draw_side(c, Pane::new(31, c.width(), bottom));
        }
        let security: Vec<_> = self
            .data
            .entries
            .iter()
            .filter(|e| e.finding.category == Category::Security)
            .collect();
        let councilled = security
            .iter()
            .filter(|e| e.finding.council.is_some())
            .count();
        footer(
            c,
            session,
            &[run(
                format!(
                    " {councilled} of {} went to council · cost shown per finding",
                    plural(security.len(), "security finding", "security findings")
                ),
                Token::Faint,
                Token::Bg,
            )],
        );
        if let Some(p) = &self.picker {
            p.draw(c);
        }
        keybar(c, self.keys());
    }

    fn on_key(&mut self, key: KeyEvent, _session: &mut Session) -> Action {
        if let Some(p) = &mut self.picker {
            return match p.on_key(key) {
                Picked::Open => Action::Many(Vec::new()),
                Picked::Cancelled => {
                    self.picker = None;
                    Action::Many(Vec::new())
                }
                Picked::Record(effect) => {
                    if let Effect::Feedback { id, reason, .. } = &effect {
                        self.dismissed.insert(id.clone(), reason.clone());
                    }
                    self.picker = None;
                    Action::Effect(effect)
                }
            };
        }
        match key.code {
            KeyCode::Up | KeyCode::Char('k') => {
                self.cursor = self.cursor.saturating_sub(1);
            }
            KeyCode::Down | KeyCode::Char('j') if self.cursor + 1 < self.data.entries.len() => {
                self.cursor += 1;
            }
            KeyCode::Char('t') => self.view = View::Trace,
            KeyCode::Char('c') => self.view = View::Council,
            KeyCode::Char('a') => {
                self.view = View::Audit;
                if self.audit.is_none() {
                    return Action::Effect(Effect::Fetch("audit".into()));
                }
            }
            KeyCode::Char('d') => {
                if let Some(e) = self.entry() {
                    self.picker = Some(Picker::new(&e.finding.id, self.data.endpoint));
                }
            }
            KeyCode::Char('P') => {
                return Action::Many(vec![
                    Action::Push(publish(self.data.publish.clone())),
                    Action::Effect(Effect::PreviewPublish),
                ]);
            }
            KeyCode::Char('F') => {
                return Action::Many(vec![
                    Action::Push(history(self.data.history.clone())),
                    Action::Effect(Effect::Fetch("findings".into())),
                ]);
            }
            _ => {}
        }
        Action::None
    }

    fn on_msg(&mut self, msg: &Msg, _session: &mut Session) -> Action {
        if let Msg::Done(Outcome::Value(name, value)) = msg
            && name == "audit"
        {
            self.audit = Some(Ok(value.clone()));
        }
        if let Msg::Done(Outcome::Failed(error)) = msg
            && self.view == View::Audit
            && self.audit.is_none()
        {
            self.audit = Some(Err(error.clone()));
        }
        Action::None
    }
}

/// Short catalog titles for the coverage list.
fn short_title(item: &str, title: &str) -> String {
    let known = match item {
        "A01" => "Access Control",
        "A02" => "Misconfiguration",
        "A03" => "Supply Chain",
        "A04" => "Cryptographic",
        "A05" => "Injection",
        "A06" => "Insecure Design",
        "A07" => "Authentication",
        "A08" => "Integrity",
        "A09" => "Logging",
        "A10" => "Exceptional",
        _ => title,
    };
    known.to_owned()
}

fn catalog_name(catalog: SecurityCatalog) -> &'static str {
    match catalog {
        SecurityCatalog::OwaspTop10_2025 => "OWASP Top 10:2025",
        SecurityCatalog::Asvs5_0 => "ASVS 5.0",
    }
}

/// The list glyph of a finding and its token.
fn glyph(f: &Finding, dismissed: bool) -> (&'static str, Token) {
    if dismissed {
        ("◆", Token::Dim)
    } else if f.state == State::Fixed {
        ("○", Token::Faint)
    } else {
        match f.severity {
            Severity::Error => ("●", Token::Fail),
            Severity::Warning => ("◆", Token::Warn),
            Severity::Info => ("◇", Token::Dim),
        }
    }
}

fn evidence(level: EvidenceLevel) -> &'static str {
    match level {
        EvidenceLevel::Reproduced => "reproduced",
        EvidenceLevel::StaticProven => "static_proven",
        EvidenceLevel::Plausible => "plausible",
        // Never listed: refuted findings are filtered out.
        EvidenceLevel::Refuted => "",
    }
}

fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn number(i: usize) -> String {
    ["①", "②", "③", "④"]
        .get(i)
        .map_or_else(|| format!("{}", i + 1), |s| (*s).to_owned())
}

impl SecurityScreen {
    fn draw_left(&self, c: &mut Canvas<'_>, pane: Pane) {
        let mut y = 2;
        // Below the design height the findings come first so they stay visible.
        if c.height() < 40 {
            y = self.draw_list(c, pane, y);
            y += 1;
            self.draw_catalog(c, pane, y);
        } else {
            y = self.draw_catalog(c, pane, y);
            y += 1;
            self.draw_list(c, pane, y);
        }
    }

    fn draw_catalog(&self, c: &mut Canvas<'_>, pane: Pane, mut y: u16) -> u16 {
        let Some(coverage) = &self.data.coverage else {
            pane.put(
                c,
                y,
                &[
                    bold(" SECURITY", Token::Faint, Token::Bg),
                    run("  no catalog run", Token::Faint, Token::Bg),
                ],
            );
            return y + 1;
        };
        pane.put(
            c,
            y,
            &[bold(
                format!(" SECURITY  {}", catalog_name(coverage.catalog)),
                Token::Faint,
                Token::Bg,
            )],
        );
        y += 1;
        enum Item<'a> {
            Assessed(&'a [String]),
            Unassessed(&'a str),
            NotApplicable,
        }
        let mut items: Vec<(&str, &str, Item<'_>)> = Vec::new();
        for a in &coverage.assessed {
            items.push((&a.item, &a.title, Item::Assessed(&a.findings)));
        }
        for u in &coverage.unassessed {
            let reason = match u.reason {
                rio_core::UnassessedReason::Budget => "budget",
                rio_core::UnassessedReason::NoEvidence => "no evidence",
                rio_core::UnassessedReason::ToolsUnavailable => "no tools",
            };
            items.push((&u.item, &u.title, Item::Unassessed(reason)));
        }
        for n in &coverage.not_applicable {
            items.push((&n.item, &n.title, Item::NotApplicable));
        }
        items.sort_by(|a, b| a.0.cmp(b.0));
        for (item, title, state) in items {
            let label = pad(&short_title(item, title), 16);
            let note = self.data.notes.get(item);
            match state {
                Item::Assessed(ids) => {
                    let (mut finds, mut risks) = (0, 0);
                    for id in ids {
                        let category = self
                            .data
                            .entries
                            .iter()
                            .find(|e| &e.finding.id == id)
                            .map(|e| e.finding.category);
                        if category == Some(Category::Risk) {
                            risks += 1;
                        } else {
                            finds += 1;
                        }
                    }
                    let mut runs = vec![
                        run(format!(" {item} "), Token::Faint, Token::Bg),
                        run(label, Token::Fg, Token::Bg),
                        run("✓ ", Token::Pass, Token::Bg),
                    ];
                    if finds > 0 {
                        runs.push(bold(format!("{finds} find"), Token::Fail, Token::Bg));
                    }
                    if risks > 0 {
                        if finds > 0 {
                            runs.push(run(" ", Token::Fg, Token::Bg));
                        }
                        runs.push(run(format!("{risks} risk"), Token::Warn, Token::Bg));
                    }
                    if finds + risks == 0
                        && let Some(note) = note
                    {
                        runs.push(run(note.clone(), Token::Faint, Token::Bg));
                    }
                    pane.put(c, y, &runs);
                    y += 1;
                }
                Item::Unassessed(reason) => {
                    pane.put(
                        c,
                        y,
                        &[
                            run(format!(" {item} "), Token::Faint, Token::Bg),
                            run(label, Token::Fg, Token::Bg),
                            run(format!("? {reason}"), Token::Warn, Token::Bg),
                        ],
                    );
                    y += 1;
                }
                Item::NotApplicable => {
                    pane.put(
                        c,
                        y,
                        &[run(format!(" {item} {label}– "), Token::Faint, Token::Bg)],
                    );
                    y += 1;
                    if let Some(note) = note {
                        pane.put(
                            c,
                            y,
                            &[run(format!("      {note}"), Token::Faint, Token::Bg)],
                        );
                        y += 1;
                    }
                }
            }
        }
        y += 1;
        let mut summary = format!(
            "{} assessed · {} not, with reasons",
            coverage.assessed.len(),
            coverage.not_applicable.len()
        );
        if !coverage.unassessed.is_empty() {
            summary.push_str(&format!(
                " · {} unassessed: not a passed security review",
                coverage.unassessed.len()
            ));
        }
        if let Some(posture) = &self.data.posture {
            summary.push_str(&format!(" · posture {posture}"));
        }
        for line in wrap(&summary, pane.width().saturating_sub(2)) {
            pane.put(c, y, &[run(format!(" {line}"), Token::Dim, Token::Bg)]);
            y += 1;
        }
        y
    }

    fn draw_list(&self, c: &mut Canvas<'_>, pane: Pane, mut y: u16) -> u16 {
        pane.put(
            c,
            y,
            &[bold(
                format!(" FINDINGS  {}", self.data.scope),
                Token::Faint,
                Token::Bg,
            )],
        );
        y += 1;
        if self.data.entries.is_empty() {
            pane.put(c, y, &[run(" no findings", Token::Faint, Token::Bg)]);
            return y + 1;
        }
        let room = usize::from(pane.bottom.saturating_sub(y)).max(1);
        let first = self.cursor.saturating_sub(room - 1);
        for (i, e) in self.data.entries.iter().enumerate().skip(first).take(room) {
            let f = &e.finding;
            let dismissed = self.dismissed.get(&f.id);
            let (g, tone) = glyph(f, dismissed.is_some());
            let id = format!("{} ", short(&f.id));
            let label_room = 29usize.saturating_sub(3 + id.chars().count());
            let label = if let Some(reason) = dismissed {
                format!("dismissed: {reason}")
            } else if f.state == State::Fixed {
                "fixed · resolves".to_owned()
            } else {
                e.label.clone().unwrap_or_else(|| f.message.clone())
            };
            if i == self.cursor {
                pane.put(
                    c,
                    y,
                    &[
                        run("▌", Token::Signal, Token::Raise),
                        run(format!("{g} "), tone, Token::Raise),
                        run(id, Token::Faint, Token::Raise),
                        bold(pad(&label, label_room), Token::Fg, Token::Raise),
                    ],
                );
                c.cursor(y, 0, 29);
            } else if f.state == State::Fixed && dismissed.is_none() {
                pane.put(
                    c,
                    y,
                    &[run(
                        format!(" {g} {id}{}", crate::canvas::fit(&label, label_room)),
                        Token::Faint,
                        Token::Bg,
                    )],
                );
            } else {
                pane.put(
                    c,
                    y,
                    &[
                        run(format!(" {g} "), tone, Token::Bg),
                        run(id, Token::Faint, Token::Bg),
                        run(pad(&label, label_room), Token::Fg, Token::Bg),
                    ],
                );
            }
            y += 1;
        }
        y
    }

    /// The finding, its trace, code excerpt and verification.
    fn draw_detail(&self, c: &mut Canvas<'_>, pane: Pane) {
        let Some(e) = self.entry() else {
            pane.put(
                c,
                2,
                &[run(" no finding selected", Token::Faint, Token::Bg)],
            );
            return;
        };
        let f = &e.finding;
        let id = format!(" {} ", short(&f.id));
        let title_room = pane.width().saturating_sub(id.chars().count());
        pane.put(
            c,
            2,
            &[
                run(id, Token::Faint, Token::Bg),
                bold(
                    crate::canvas::fit(&f.message, title_room),
                    Token::Fg,
                    Token::Bg,
                ),
            ],
        );
        let (state, state_fg, state_bold) = match f.state {
            State::New => ("[new]", Token::Fail, true),
            State::Worsened => ("[worsened]", Token::Fail, true),
            State::PreExisting => ("[pre-existing]", Token::Dim, false),
            State::Fixed => ("[fixed]", Token::Pass, false),
            State::Unclassified => ("[unclassified]", Token::Faint, false),
        };
        let severity = match f.severity {
            Severity::Error => "[err] ",
            Severity::Warning => "[warn] ",
            Severity::Info => "[info] ",
        };
        let (category, category_fg) = match f.category {
            Category::Security => ("[security] ", Token::Sec),
            Category::Risk => ("[risk] ", Token::Warn),
            Category::Defect => ("[defect] ", Token::Fg),
            Category::Ux => ("[ux] ", Token::Fg),
        };
        let state_run = Run {
            text: format!(" {state} "),
            fg: state_fg,
            bg: Token::Bg,
            bold: state_bold,
        };
        let mut tags = vec![
            state_run,
            run(severity, Token::Fg, Token::Bg),
            run(category, category_fg, Token::Bg),
            run(
                format!("[{}] ", evidence(f.evidence_level)),
                Token::Signal,
                Token::Bg,
            ),
        ];
        if e.fails {
            tags.push(bold("FAIL", Token::Fail, Token::Bg));
        }
        pane.put(c, 3, &tags);
        let mut y = 4;
        if let Some(trace) = &f.trace {
            let title = self.catalog_title(&trace.catalog_item);
            pane.put(
                c,
                y,
                &[
                    run(" catalog ", Token::Faint, Token::Bg),
                    run(
                        format!("{} {title}", trace.catalog_item)
                            .trim_end()
                            .to_owned(),
                        Token::Sec,
                        Token::Bg,
                    ),
                ],
            );
            y += 1;
        }
        let mut place = vec![
            run(" where   ", Token::Faint, Token::Bg),
            run(
                format!("{}:{}", f.location.path, f.location.line_start),
                Token::Signal,
                Token::Bg,
            ),
        ];
        if !f.location.symbol_path.is_empty() {
            place.push(run(
                format!("  {}", f.location.symbol_path),
                Token::Faint,
                Token::Bg,
            ));
        }
        pane.put(c, y, &place);
        y += 2;
        pane.put(
            c,
            y,
            &[bold(" TRACE  input → sink", Token::Faint, Token::Bg)],
        );
        y += 1;
        match &f.trace {
            None => {
                pane.put(
                    c,
                    y,
                    &[run(
                        " no trace: only security findings cite one",
                        Token::Faint,
                        Token::Bg,
                    )],
                );
                y += 1;
            }
            Some(trace) => {
                let n = trace.steps.len();
                for (i, step) in trace.steps.iter().enumerate() {
                    let text = e.steps.get(i);
                    let code =
                        text.map_or_else(|| basename(&step.path).to_owned(), |t| t.code.clone());
                    let stage = text.map_or_else(|| step.role.clone(), |t| t.stage.clone());
                    let last = i + 1 == n;
                    let check = step.role == "step";
                    if step.missing {
                        pane.put(
                            c,
                            y,
                            &[
                                run(format!("  {} ", number(i)), Token::Fail, Token::Bg),
                                bold(pad(&code, 21), Token::Fail, Token::Bg),
                            ],
                        );
                    } else {
                        pane.put(
                            c,
                            y,
                            &[
                                run(format!("  {} ", number(i)), Token::Signal, Token::Bg),
                                run(pad(&code, 21), Token::Fg, Token::Bg),
                                run(
                                    format!("{}:{}", basename(&step.path), step.line_start),
                                    Token::Faint,
                                    Token::Bg,
                                ),
                            ],
                        );
                    }
                    y += 1;
                    let (caption, tone) = if step.missing {
                        (format!("{stage} ✕"), Token::Fail)
                    } else if check {
                        (format!("{stage} ✓"), Token::Pass)
                    } else {
                        (stage, Token::Faint)
                    };
                    let caption = match text.and_then(|t| t.note.as_ref()) {
                        Some(note) => format!("{caption}  {note}"),
                        None => caption,
                    };
                    let rail = if last { "     " } else { "  │  " };
                    let room = pane.width().saturating_sub(7);
                    for line in wrap(&caption, room) {
                        pane.put(
                            c,
                            y,
                            &[
                                run(rail, Token::Rule, Token::Bg),
                                run(line, tone, Token::Bg),
                            ],
                        );
                        y += 1;
                    }
                }
            }
        }
        if !e.code.is_empty() {
            y += 1;
            pane.put(
                c,
                y,
                &[bold(
                    format!(" CODE  {}", e.code_version),
                    Token::Faint,
                    Token::Bg,
                )],
            );
            y += 1;
            let digits = e
                .code
                .iter()
                .map(|l| l.line.to_string().len())
                .max()
                .unwrap_or(2)
                .max(2);
            for line in &e.code {
                let gutter = format!(
                    "{} {:>digits$}  ",
                    if line.changed { "+" } else { " " },
                    line.line
                );
                let room = pane.width().saturating_sub(gutter.chars().count());
                let text = pad(&clip(&line.text, room), room);
                if line.changed {
                    pane.put(
                        c,
                        y,
                        &[
                            run(gutter, Token::Fail, Token::FailTint),
                            run(text, Token::Fg, Token::FailTint),
                        ],
                    );
                } else {
                    pane.put(
                        c,
                        y,
                        &[
                            run(gutter, Token::Faint, Token::Bg),
                            run(text, Token::Fg, Token::Bg),
                        ],
                    );
                }
                y += 1;
            }
        }
        if let Some(v) = &f.verification {
            y += 1;
            pane.put(
                c,
                y,
                &[bold(" VERIFY  blind quorum", Token::Faint, Token::Bg)],
            );
            y += 1;
            let mut runs = Vec::new();
            for (i, m) in v.blind_match.iter().enumerate() {
                runs.push(run(format!(" voter {} ", i + 1), Token::Faint, Token::Bg));
                let (label, tone) = match m {
                    BlindMatch::Same => ("✓ real", Token::Pass),
                    BlindMatch::Related => ("◐ related", Token::Warn),
                    BlindMatch::None => ("✕ refuted", Token::Fail),
                };
                runs.push(run(format!("{label:<8}"), tone, Token::Bg));
            }
            pane.put(c, y, &runs);
            y += 1;
            let count = |k: &BlindMatch| v.blind_match.iter().filter(|m| *m == k).count();
            let split = if v.split {
                format!(
                    " split {}–{}–{}",
                    count(&BlindMatch::Same),
                    count(&BlindMatch::Related),
                    count(&BlindMatch::None)
                )
            } else {
                " no split".to_owned()
            };
            let mut runs = vec![run(split, Token::Dim, Token::Bg)];
            if f.council.is_some() {
                runs.push(run(" → ", Token::Dim, Token::Bg));
                runs.push(bold("sent to council", Token::Signal, Token::Bg));
            }
            pane.put(c, y, &runs);
            y += 1;
            if let Some(trigger) = &e.council_trigger {
                let severity = match f.severity {
                    Severity::Error => "error",
                    Severity::Warning => "warning",
                    Severity::Info => "info",
                };
                pane.put(
                    c,
                    y,
                    &[run(
                        format!(" trigger {trigger} · severity {severity}"),
                        Token::Faint,
                        Token::Bg,
                    )],
                );
            }
        }
    }

    fn catalog_title(&self, item: &str) -> String {
        let Some(coverage) = &self.data.coverage else {
            return String::new();
        };
        coverage
            .assessed
            .iter()
            .map(|a| (&a.item, &a.title))
            .chain(coverage.unassessed.iter().map(|u| (&u.item, &u.title)))
            .chain(coverage.not_applicable.iter().map(|n| (&n.item, &n.title)))
            .find(|(i, _)| *i == item)
            .map(|(_, t)| t.clone())
            .unwrap_or_default()
    }

    /// The council, or the audit record after `a`.
    fn draw_side(&self, c: &mut Canvas<'_>, pane: Pane) {
        let Some(e) = self.entry() else {
            return;
        };
        if self.view == View::Audit {
            self.draw_audit(c, pane, e);
            return;
        }
        let Some(council) = &e.finding.council else {
            pane.put(
                c,
                2,
                &[
                    bold(" COUNCIL ", Token::Faint, Token::Bg),
                    run(" not councilled", Token::Faint, Token::Bg),
                ],
            );
            pane.put(
                c,
                3,
                &[run(
                    " the council reviews findings its triggers select",
                    Token::Faint,
                    Token::Bg,
                )],
            );
            return;
        };
        draw_council(c, pane, e, council);
    }

    fn draw_audit(&self, c: &mut Canvas<'_>, pane: Pane, e: &SecurityEntry) {
        let id = e.audit.clone().unwrap_or_default();
        pane.put(
            c,
            2,
            &[bold(format!(" AUDIT  {id}"), Token::Faint, Token::Bg)],
        );
        pane.put(
            c,
            3,
            &[run(" which content went where", Token::Faint, Token::Bg)],
        );
        pane.rule(c, 4, 1);
        let mut y = 5;
        match &self.audit {
            None => {
                pane.put(
                    c,
                    y,
                    &[run(" loading the audit record…", Token::Faint, Token::Bg)],
                );
            }
            Some(Err(error)) => {
                pane.put(c, y, &[run(format!(" ✕ {error}"), Token::Fail, Token::Bg)]);
            }
            Some(Ok(value)) => {
                let rows: Vec<&Value> = value["council"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter(|r| r["finding_id"].as_str() == Some(e.finding.id.as_str()))
                            .collect()
                    })
                    .unwrap_or_default();
                if rows.is_empty() {
                    pane.put(
                        c,
                        y,
                        &[run(
                            " no council transfer recorded for this finding",
                            Token::Faint,
                            Token::Bg,
                        )],
                    );
                    y += 1;
                }
                for r in rows {
                    let text = |k: &str| match &r[k] {
                        Value::String(s) => s.clone(),
                        Value::Null => String::new(),
                        v => v.to_string(),
                    };
                    let abstained = r["abstained"].as_bool() == Some(true)
                        || r["abstained"].as_i64() == Some(1);
                    pane.put(
                        c,
                        y,
                        &[
                            run(
                                format!(" {} ", pad(&text("member"), 14)),
                                Token::Fg,
                                Token::Bg,
                            ),
                            run(format!("r{} ", text("round")), Token::Faint, Token::Bg),
                            run(
                                format!("{}/{}", text("vendor"), text("model")),
                                Token::Dim,
                                Token::Bg,
                            ),
                        ],
                    );
                    y += 1;
                    let mut detail = format!(
                        "   pack {} B · rendering {} B",
                        text("pack_bytes"),
                        text("rendering_bytes")
                    );
                    if abstained {
                        detail.push_str(&format!(" · abstained {}", text("cause")));
                    }
                    pane.put(c, y, &[run(detail, Token::Faint, Token::Bg)]);
                    y += 1;
                }
                let usage = value["usage"].as_array().map_or(0, Vec::len);
                y += 1;
                pane.put(
                    c,
                    y,
                    &[run(
                        format!(
                            " {} · hashes and sizes, never content",
                            plural(usage, "model call", "model calls")
                        ),
                        Token::Faint,
                        Token::Bg,
                    )],
                );
            }
        }
        let y = pane.bottom.saturating_sub(1).max(y + 2);
        pane.put(
            c,
            y,
            &[
                bold(" c ", Token::Fg, Token::Bg),
                run("back to the council", Token::Faint, Token::Bg),
            ],
        );
    }
}

/// One member's answer in a round.
fn answer(member: &CouncilMember, round: u8) -> (String, Token) {
    let Some(r) = member.rounds.iter().find(|r| r.round == round) else {
        if round == 1 && member.rounds.is_empty() && member.abstained {
            return match member.cause.as_deref() {
                Some("timeout") => ("timeout".into(), Token::Faint),
                _ => ("? abstain".into(), Token::Faint),
            };
        }
        return ("—".into(), Token::Faint);
    };
    match (r.real.as_deref(), r.cause.as_deref()) {
        (Some("yes"), _) => ("✓ real".into(), Token::Pass),
        (Some("no"), _) => ("✕ not real".into(), Token::Fail),
        (Some("unknown"), _) => ("? unsure".into(), Token::Faint),
        (Some(other), _) => (other.to_owned(), Token::Dim),
        (None, Some("timeout")) => ("timeout".into(), Token::Faint),
        (None, _) => ("? abstain".into(), Token::Faint),
    }
}

/// The label of experiment `i`: its artifact id, or `exp-N`.
fn experiment_label(council: &CouncilReview, i: usize) -> String {
    council
        .experiments
        .get(i)
        .and_then(|e| e.artifact.clone())
        .unwrap_or_else(|| format!("exp-{}", i + 1))
}

fn draw_council(c: &mut Canvas<'_>, pane: Pane, e: &SecurityEntry, council: &CouncilReview) {
    let rounds = council
        .members
        .iter()
        .flat_map(|m| m.rounds.iter().map(|r| r.round))
        .max()
        .unwrap_or(1)
        .max(1);
    let of = rounds.max(2);
    let mut head = vec![
        bold(" COUNCIL ", Token::Faint, Token::Bg),
        run(
            format!(" round {rounds} of {of} · "),
            Token::Faint,
            Token::Bg,
        ),
    ];
    if council.partial {
        head.push(run(
            format!("partial {}/{}", council.answered, council.total),
            Token::Warn,
            Token::Bg,
        ));
    } else {
        head.push(run(
            format!("{}/{} answered", council.answered, council.total),
            Token::Faint,
            Token::Bg,
        ));
    }
    pane.put(c, 2, &head);
    let mut columns = String::from(" role           family    ");
    for r in 1..=of {
        columns.push_str(&pad(&format!("round {r}"), 10));
    }
    pane.put(
        c,
        3,
        &[run(columns.trim_end().to_owned(), Token::Faint, Token::Bg)],
    );
    pane.rule(c, 4, 1);
    let mut y = 5;
    let cite = council
        .experiments
        .iter()
        .position(|x| x.run)
        .map_or_else(|| "evidence".to_owned(), |i| experiment_label(council, i));
    for m in &council.members {
        let mut runs = vec![
            run(format!(" {}", pad(&m.role, 15)), Token::Fg, Token::Bg),
            run(
                pad(m.family.as_deref().unwrap_or("?"), 10),
                Token::Faint,
                Token::Bg,
            ),
        ];
        for r in 1..=of {
            let (text, tone) = answer(m, r);
            let w = if r == of { 8 } else { 10 };
            runs.push(run(pad(&text, w), tone, Token::Bg));
        }
        if m.rounds.iter().any(|r| r.changed) {
            runs.push(run(cite.clone(), Token::Faint, Token::Bg));
        }
        pane.put(c, y, &runs);
        y += 1;
    }
    pane.put(
        c,
        y,
        &[run(
            " positions change only by citing an artifact",
            Token::Faint,
            Token::Bg,
        )],
    );
    y += 2;
    for (i, x) in council.experiments.iter().enumerate() {
        let note = e.experiments.get(i).cloned().unwrap_or_default();
        let how = if x.run {
            "runner job".to_owned()
        } else {
            format!(
                "not run{}",
                x.reason
                    .as_ref()
                    .map(|r| format!(" · {r}"))
                    .unwrap_or_default()
            )
        };
        pane.put(
            c,
            y,
            &[bold(
                format!(" EXPERIMENT  {} · {how}", experiment_label(council, i)),
                Token::Faint,
                Token::Bg,
            )],
        );
        y += 1;
        if let Some(who) = &note.requested_by {
            pane.put(
                c,
                y,
                &[
                    run(" requested by ", Token::Faint, Token::Bg),
                    run(who.clone(), Token::Fg, Token::Bg),
                ],
            );
            y += 1;
        }
        pane.put(
            c,
            y,
            &[run(
                format!(" {}", x.command.join(" ")),
                Token::Fg,
                Token::Bg,
            )],
        );
        y += 1;
        let outcome = x.outcome.clone().unwrap_or(rio_core::ExperimentOutcome {
            base: None,
            head: None,
        });
        for (version, result, seen) in [
            ("head", outcome.head, note.head),
            ("base", outcome.base, note.base),
        ] {
            let Some(result) = result else {
                continue;
            };
            let (mark, tone) = if result == "passed" {
                ("✓", Token::Pass)
            } else {
                ("✕", Token::Fail)
            };
            let (shown, detail) = match seen {
                Some(o) => (o.result, o.detail),
                None => (result.clone(), String::new()),
            };
            let mut runs = vec![
                run(format!(" {version}  "), Token::Faint, Token::Bg),
                bold(format!("{mark} {shown}"), tone, Token::Bg),
            ];
            if !detail.is_empty() {
                runs.push(run(format!("  {detail}"), Token::Dim, Token::Bg));
            }
            pane.put(c, y, &runs);
            y += 1;
        }
        y += 1;
    }
    pane.put(c, y, &[bold(" DECISION", Token::Faint, Token::Bg)]);
    y += 1;
    let decision = match council.decision {
        Some(CouncilDecision::Reproduced) => Some("reproduced"),
        Some(CouncilDecision::Plausible) => Some("plausible"),
        // A refuted finding leaves the lists; it is only ever counted.
        Some(CouncilDecision::Refuted) | None => None,
    };
    match decision {
        Some(d) => pane.put(
            c,
            y,
            &[
                bold(format!(" {d} "), Token::Signal, Token::Raise),
                run("  by evidence tier", Token::Dim, Token::Bg),
            ],
        ),
        None => pane.put(c, y, &[run(" no decision", Token::Faint, Token::Bg)]),
    };
    y += 1;
    let tier = match council.tier {
        Some(CouncilTier::Experiment) => "fails on head, passes on base".to_owned(),
        Some(CouncilTier::Protection) => format!(
            "protection: {}",
            council.protection.clone().unwrap_or_else(|| "cited".into())
        ),
        Some(CouncilTier::Judgment) => council
            .note
            .clone()
            .unwrap_or_else(|| "no experiment or protection decided it".into()),
        None => council.note.clone().unwrap_or_default(),
    };
    for line in wrap(&tier, pane.width().saturating_sub(2)) {
        pane.put(c, y, &[run(format!(" {line}"), Token::Fg, Token::Bg)]);
        y += 1;
    }
    y += 1;
    // Agreement is shown only to say it does not count.
    let finals: Vec<&str> = council
        .members
        .iter()
        .filter_map(|m| {
            m.rounds
                .iter()
                .rev()
                .find_map(|r| r.real.as_deref().filter(|a| *a == "yes" || *a == "no"))
        })
        .collect();
    let agree = finals.iter().filter(|a| **a == "yes").count();
    pane.put(
        c,
        y,
        &[run(" agreement is never evidence", Token::Faint, Token::Bg)],
    );
    y += 1;
    pane.put(
        c,
        y,
        &[run(
            format!(" {agree} of {} agree: not counted", finals.len()),
            Token::Faint,
            Token::Bg,
        )],
    );
    y += 2;
    pane.put(c, y, &[bold(" COST", Token::Faint, Token::Bg)]);
    y += 1;
    let ran = council.experiments.iter().filter(|x| x.run).count();
    let mut cost = Vec::new();
    if let Some(dollars) = &e.cost {
        cost.push(dollars.clone());
    }
    cost.push(plural(usize::from(rounds), "round", "rounds"));
    cost.push(plural(ran, "experiment", "experiments"));
    pane.put(
        c,
        y,
        &[run(format!(" {}", cost.join(" · ")), Token::Fg, Token::Bg)],
    );
    y += 1;
    let vendors = if council.excluded.is_empty() {
        "vendors allowlisted".to_owned()
    } else {
        format!(
            "{} excluded by the allowlist",
            plural(council.excluded.len(), "vendor", "vendors")
        )
    };
    let audit = e
        .audit
        .as_ref()
        .map(|a| format!(" · audit {a}"))
        .unwrap_or_default();
    pane.put(
        c,
        y,
        &[run(format!(" {vendors}{audit}"), Token::Faint, Token::Bg)],
    );
    y += 1;
    pane.put(
        c,
        y,
        &[
            bold(" a ", Token::Fg, Token::Bg),
            run("shows which content went where", Token::Faint, Token::Bg),
        ],
    );
}

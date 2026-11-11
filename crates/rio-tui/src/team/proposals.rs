//! P4: suppression proposals (`rio suppressions`): the evidence first, the
//! exact profile diff, its validation, and an explicit y/N. Nothing is
//! written without `y`; `x` declines with a reason.

use ratatui::crossterm::event::{KeyCode, KeyEvent};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{
    app::{Action, Effect, Msg, Outcome, Screen, Session},
    canvas::{Canvas, Run, bold, fit, pad, run},
    chrome::{Board, Key, focus, key, keybar, quiet, status},
    theme::Token,
};

use super::{
    history::RegistryRecord,
    ui::{Pane, at, body_bottom, cells, footer, short, top, vrule},
};

/// Days a declined proposal stays quiet before it can be proposed again.
pub const DECLINE_QUIET_DAYS: i64 = 180;

/// What P4 shows. `proposals` is answered as
/// `Outcome::Value("suppressions", <GET /v1/suppressions body>)` after
/// `Effect::Fetch("suppressions")`; the host adds each open proposal's
/// `change` (the profile written to a temp file and validated, not renamed).
#[derive(Debug, Clone)]
pub struct ProposalsData {
    /// `owner/name`, as the header shows it.
    pub repository: String,
    /// The proposals once fetched.
    pub proposals: Option<Vec<Proposal>>,
    /// The registry, to show each piece of evidence with its path, review and note.
    pub records: Vec<RegistryRecord>,
    /// Dismissals of one rule or directory that create a proposal (`proposal_threshold`).
    pub threshold: u32,
    /// The window those dismissals are counted in, in days.
    pub window_days: u32,
}

impl Default for ProposalsData {
    fn default() -> Self {
        Self {
            repository: String::new(),
            proposals: None,
            records: Vec::new(),
            threshold: 3,
            window_days: 90,
        }
    }
}

/// One proposal of `GET /v1/suppressions` (`publicProposal` in `worker/src/proposals.ts`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Proposal {
    pub id: String,
    #[serde(default)]
    pub repository: String,
    /// The proposed `suppress` entry: a rule, a directory glob, or both.
    pub entry: Entry,
    /// `proposed`, `applied` or `declined`.
    pub status: String,
    #[serde(default)]
    pub evidence_count: u32,
    #[serde(default)]
    pub evidence: Vec<Evidence>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decided_at: Option<String>,
    /// Added by the host: the profile change `y` would write, validated.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub change: Option<ProfileChange>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rule: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// One dismissal behind a proposal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Evidence {
    /// Finding identity.
    pub finding: String,
    pub reason: String,
    #[serde(default)]
    pub actor: Option<String>,
    #[serde(default)]
    pub at: String,
}

/// The profile as `y` would leave it, written next to it and validated.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProfileChange {
    /// Repository-relative profile path, e.g. `.rio/profiles/default.yaml`.
    pub path: String,
    /// Every line of the resulting file; `added` marks the appended ones.
    pub lines: Vec<ProfileLine>,
    /// The candidate was written to a temp file next to the profile.
    pub written: bool,
    /// `rio profile validate` on the candidate: `None` when it passed, else the error.
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProfileLine {
    pub line: u32,
    pub text: String,
    #[serde(default)]
    pub added: bool,
}

const KEYS: &[Key] = &[
    focus("y", "apply"),
    key("N", "leave unchanged"),
    key("x", "decline… (180 d)"),
    key("↑↓", "proposal"),
    key("esc", "history"),
];

const DECLINE_KEYS: &[Key] = &[
    key("type", "reason"),
    key("⏎", "decline"),
    key("esc", "cancel"),
];

pub struct ProposalsScreen {
    data: ProposalsData,
    cursor: usize,
    /// `x` was pressed: the reason being typed.
    decline: Option<String>,
    /// A proposal whose `y` or decline the host is carrying out.
    pending: Option<String>,
    message: Option<String>,
    error: Option<String>,
}

/// P4.
pub fn proposals(data: ProposalsData) -> Box<dyn Screen> {
    Box::new(ProposalsScreen::new(data))
}

impl ProposalsScreen {
    pub fn new(data: ProposalsData) -> Self {
        Self {
            data,
            cursor: 0,
            decline: None,
            pending: None,
            message: None,
            error: None,
        }
    }

    fn list(&self) -> &[Proposal] {
        self.data.proposals.as_deref().unwrap_or(&[])
    }

    fn focused(&self) -> Option<&Proposal> {
        self.list().get(self.cursor)
    }

    fn record(&self, identity: &str) -> Option<&RegistryRecord> {
        self.data.records.iter().find(|r| r.identity == identity)
    }
}

impl Screen for ProposalsScreen {
    fn title(&self) -> &'static str {
        "Suppression proposals"
    }
    fn board(&self) -> Board {
        Board::V3
    }
    fn keys(&self) -> &'static [Key] {
        if self.decline.is_some() {
            DECLINE_KEYS
        } else {
            KEYS
        }
    }
    fn wants_text(&self) -> bool {
        self.decline.is_some()
    }

    fn draw(&self, c: &mut Canvas<'_>, session: &Session) {
        c.clear(Token::Bg);
        let open = self
            .list()
            .iter()
            .filter(|p| p.status == "proposed")
            .count();
        top(
            c,
            &format!("suppressions · {}", self.data.repository),
            &[
                status(
                    format!("{open} open proposal{}", if open == 1 { "" } else { "s" }),
                    Token::Signal,
                ),
                quiet("nothing auto-applied"),
            ],
        );
        let bottom = body_bottom(c);
        let wide = c.width() >= 120;
        if wide {
            vrule(c, 41, 1, bottom);
            let left = Pane::new(0, 41, bottom);
            let right = Pane::new(42, c.width(), bottom);
            left.rule(c, 3, 0);
            right.rule(c, 3, 0);
            c.put(41, 3, &run("│", Token::Rule, Token::Bg));
            self.draw_list(c, left, true);
            self.draw_detail(c, right);
        } else {
            let split = 34.min(c.width() / 2);
            vrule(c, split, 1, bottom);
            let left = Pane::new(0, split, bottom);
            let right = Pane::new(split + 1, c.width(), bottom);
            left.rule(c, 3, 0);
            right.rule(c, 3, 0);
            c.put(split, 3, &run("│", Token::Rule, Token::Bg));
            self.draw_list(c, left, false);
            self.draw_detail(c, right);
        }
        let own = self.message.clone().unwrap_or_else(|| {
            "answering anything but y exits 1 and leaves both the file and the proposal unchanged"
                .to_owned()
        });
        footer(
            c,
            session,
            &[run(format!(" {own}"), Token::Faint, Token::Bg)],
        );
        keybar(c, self.keys());
    }

    fn on_key(&mut self, key: KeyEvent, _session: &mut Session) -> Action {
        if let Some(reason) = &mut self.decline {
            match key.code {
                KeyCode::Esc => {
                    self.decline = None;
                    self.message = Some("not declined · the proposal stays open".into());
                }
                KeyCode::Enter => {
                    let reason = reason.trim().to_owned();
                    if reason.is_empty() {
                        self.message = Some("a decline needs a reason".into());
                        return Action::Many(Vec::new());
                    }
                    self.decline = None;
                    if let Some(p) = self.focused() {
                        let id = p.id.clone();
                        self.pending = Some(id.clone());
                        self.message = Some(format!("declining {id}"));
                        return Action::Effect(Effect::DeclineProposal { id, reason });
                    }
                }
                KeyCode::Backspace => {
                    reason.pop();
                }
                KeyCode::Char(ch) => reason.push(ch),
                _ => {}
            }
            return Action::Many(Vec::new());
        }
        match key.code {
            KeyCode::Up | KeyCode::Char('k') => self.cursor = self.cursor.saturating_sub(1),
            KeyCode::Down | KeyCode::Char('j') if self.cursor + 1 < self.list().len() => {
                self.cursor += 1;
            }
            KeyCode::Char('y') => {
                let Some(p) = self.focused() else {
                    return Action::None;
                };
                if self.pending.is_some() {
                    return Action::None;
                }
                if p.status != "proposed" {
                    self.message = Some(format!("{} is {}; nothing to apply", p.id, p.status));
                    return Action::None;
                }
                if let Some(error) = p.change.as_ref().and_then(|ch| ch.error.clone()) {
                    self.message = Some(format!("the profile does not validate: {error}"));
                    return Action::None;
                }
                let id = p.id.clone();
                self.pending = Some(id.clone());
                self.message = Some(format!("applying {id}"));
                return Action::Effect(Effect::ApplyProposal(id));
            }
            KeyCode::Char('N') | KeyCode::Char('n') => {
                if let Some(p) = self.focused() {
                    self.message = Some(format!(
                        "left unchanged · {} stays {} and the profile is untouched",
                        p.id, p.status
                    ));
                }
            }
            KeyCode::Char('x') => {
                if let Some(p) = self.focused() {
                    if p.status == "proposed" && self.pending.is_none() {
                        self.decline = Some(String::new());
                    } else {
                        self.message =
                            Some(format!("{} is {}; nothing to decline", p.id, p.status));
                    }
                }
            }
            _ => {}
        }
        Action::None
    }

    fn on_msg(&mut self, msg: &Msg, _session: &mut Session) -> Action {
        match msg {
            Msg::Done(Outcome::Value(name, value)) if name == "suppressions" => {
                match serde_json::from_value::<Vec<Proposal>>(value["suppressions"].clone()) {
                    Ok(list) => {
                        self.cursor = self.cursor.min(list.len().saturating_sub(1));
                        self.data.proposals = Some(list);
                        self.error = None;
                    }
                    Err(error) => self.error = Some(format!("unreadable proposals: {error}")),
                }
            }
            Msg::Done(Outcome::Ok(_)) => self.pending = None,
            Msg::Done(Outcome::Failed(error)) => {
                if self.data.proposals.is_none() {
                    self.error = Some(error.clone());
                }
                self.pending = None;
            }
            _ => {}
        }
        Action::None
    }
}

/// Days since 1970-01-01 of a civil date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (
        if m <= 2 {
            yoe + era * 400 + 1
        } else {
            yoe + era * 400
        },
        m,
        d,
    )
}

/// The date `days` after the RFC 3339 timestamp's date, as `YYYY-MM-DD`.
pub fn date_after(timestamp: &str, days: i64) -> Option<String> {
    let date = timestamp.get(..10)?;
    let mut parts = date.split('-').map(str::parse::<i64>);
    let (y, m, d) = (
        parts.next()?.ok()?,
        parts.next()?.ok()?,
        parts.next()?.ok()?,
    );
    let (y, m, d) = civil_from_days(days_from_civil(y, m, d) + days);
    Some(format!("{y:04}-{m:02}-{d:02}"))
}

impl Proposal {
    /// The rule or directory the proposal is about.
    fn subject(&self) -> String {
        self.entry
            .rule
            .clone()
            .or_else(|| self.entry.path.clone())
            .unwrap_or_else(|| "?".into())
    }

    fn title(&self) -> String {
        match (&self.entry.rule, &self.entry.path) {
            (Some(rule), Some(path)) => format!("Stop reporting {rule} in {path}"),
            (Some(rule), None) => format!("Stop reporting {rule}"),
            (None, Some(path)) => format!("Stop reporting findings in {path}"),
            (None, None) => "Stop reporting".into(),
        }
    }

    /// The reason every piece of evidence shares, or `dismissals`.
    fn reason(&self) -> String {
        let first = self.evidence.first().map(|e| e.reason.clone());
        match first {
            Some(r) if self.evidence.iter().all(|e| e.reason == r) => r,
            _ => "dismissals".into(),
        }
    }

    fn scope(&self) -> String {
        match &self.status[..] {
            "declined" => self
                .decided_at
                .as_deref()
                .and_then(|d| date_after(d, DECLINE_QUIET_DAYS))
                .map_or_else(|| "declined".into(), |d| format!("quiet until {d}")),
            "applied" => "applied to the profile".into(),
            _ => {
                let place = match (&self.entry.rule, &self.entry.path) {
                    (Some(_), Some(path)) => path.clone(),
                    (Some(_), None) => "every path".into(),
                    _ => "every rule".into(),
                };
                format!("{place} · {} {}", self.evidence_count, self.reason())
            }
        }
    }
}

impl ProposalsScreen {
    fn draw_list(&self, c: &mut Canvas<'_>, pane: Pane, notes: bool) {
        let list = self.list();
        let open = list.iter().filter(|p| p.status == "proposed").count();
        let declined = list.iter().filter(|p| p.status == "declined").count();
        pane.put(
            c,
            2,
            &[
                bold(" Proposals ", Token::Fg, Token::Bg),
                run(
                    format!("{open} open · {declined} declined"),
                    Token::Dim,
                    Token::Bg,
                ),
            ],
        );
        let mut y = 4;
        if self.data.proposals.is_none() {
            let text = match &self.error {
                Some(e) => run(format!(" ✕ {e}"), Token::Fail, Token::Bg),
                None => run(" asking the endpoint…", Token::Faint, Token::Bg),
            };
            pane.put(c, y, &[text]);
            return;
        }
        if list.is_empty() {
            pane.put(c, y, &[run(" no proposals", Token::Faint, Token::Bg)]);
        }
        let id_w = list
            .iter()
            .map(|p| p.id.chars().count())
            .max()
            .unwrap_or(7)
            .max(7)
            + 2;
        let rule_w = pane.width().saturating_sub(id_w + 2 + 9 + 1).max(8);
        let area = if notes && c.height() >= 40 {
            9
        } else {
            usize::from(pane.bottom.saturating_sub(y))
        };
        let indent = if pane.width() >= 40 { id_w + 3 } else { 4 };
        let per = 3;
        let room = (area / per).max(1);
        let first = self.cursor.saturating_sub(room - 1);
        for (i, p) in list.iter().enumerate().skip(first).take(room) {
            let cursor = i == self.cursor;
            let bg = if cursor { Token::Raise } else { Token::Bg };
            let (state, tone) = match &p.status[..] {
                "proposed" => ("open", Token::Signal),
                "applied" => ("applied", Token::Pass),
                other => (other, Token::Faint),
            };
            pane.put(
                c,
                y,
                &[
                    run(if cursor { "▌" } else { " " }, Token::Signal, bg),
                    run(format!(" {}", pad(&p.id, id_w)), Token::Faint, bg),
                    Run {
                        text: pad(&fit(&p.subject(), rule_w - 1), rule_w),
                        fg: Token::Fg,
                        bg,
                        bold: cursor,
                    },
                    run(pad(state, 9), tone, bg),
                ],
            );
            if cursor {
                c.cursor(y, pane.x, pane.right);
            }
            pane.put(
                c,
                y + 1,
                &[run(
                    format!("{}{}", " ".repeat(indent), p.scope()),
                    Token::Faint,
                    Token::Bg,
                )],
            );
            y += cells(per);
        }
        if !notes || c.height() < 40 {
            return;
        }
        let mut y = 4 + cells(area);
        pane.rule(c, y, 0);
        y += 1;
        pane.put(
            c,
            y,
            &[bold(" HOW PROPOSALS APPEAR", Token::Faint, Token::Bg)],
        );
        for (i, text) in [
            format!(" {} irrelevant or style dismissals of", self.data.threshold),
            " one rule, or of rules under one dir,".to_owned(),
            format!(" within {} days", self.data.window_days),
        ]
        .into_iter()
        .enumerate()
        {
            pane.put(c, y + 1 + cells(i), &[run(text, Token::Dim, Token::Bg)]);
        }
        pane.put(
            c,
            y + 4,
            &[run(
                " proposal_threshold on rio/report",
                Token::Faint,
                Token::Bg,
            )],
        );
        y += 6;
        pane.put(
            c,
            y,
            &[
                bold(" ◆ wrong ", Token::Warn, Token::Bg),
                run("never proposes anything", Token::Faint, Token::Bg),
            ],
        );
        pane.put(
            c,
            y + 1,
            &[run(
                " ◆ nothing is suppressed until you",
                Token::Faint,
                Token::Bg,
            )],
        );
        pane.put(
            c,
            y + 2,
            &[run(
                "   apply it here or with the CLI",
                Token::Faint,
                Token::Bg,
            )],
        );
        y += 4;
        let id = self.focused().map_or("<id>".to_owned(), |p| p.id.clone());
        pane.put(c, y, &[bold(" CLI", Token::Faint, Token::Bg)]);
        for (i, text) in [
            " rio suppressions list".to_owned(),
            format!(" rio suppressions apply {id}"),
            format!(" rio suppressions decline {id} \\"),
            "   --note \"we want these\"".to_owned(),
        ]
        .into_iter()
        .enumerate()
        {
            pane.put(c, y + 1 + cells(i), &[run(text, Token::Signal, Token::Bg)]);
        }
    }

    fn draw_detail(&self, c: &mut Canvas<'_>, pane: Pane) {
        let Some(p) = self.focused() else {
            return;
        };
        let id = format!(" {} ", p.id);
        let room = pane.width().saturating_sub(id.chars().count());
        pane.put(
            c,
            2,
            &[
                run(id, Token::Faint, Token::Bg),
                bold(fit(&p.title(), room), Token::Fg, Token::Bg),
            ],
        );
        pane.put(
            c,
            4,
            &[bold(
                format!(
                    " EVIDENCE  {} · reason {} · {} days",
                    plural_dismissals(p.evidence_count),
                    p.reason(),
                    self.data.window_days
                ),
                Token::Faint,
                Token::Bg,
            )],
        );
        let mut y = 5;
        // The design's path column; narrower panes size it to the paths.
        let path_w = if pane.width() >= 70 {
            19
        } else {
            p.evidence
                .iter()
                .filter_map(|e| self.record(&e.finding))
                .map(|r| r.location.path.chars().count() + 2)
                .max()
                .unwrap_or(8)
        };
        for e in &p.evidence {
            let record = self.record(&e.finding);
            let review = record
                .and_then(|r| r.dismissed_in.clone())
                .unwrap_or_else(|| e.at.get(..10).unwrap_or(&e.at).to_owned());
            let path = record
                .map(|r| r.location.path.clone())
                .unwrap_or_else(|| "?".into());
            let actor = e.actor.as_deref().map(at).unwrap_or_default();
            let actor_w = if path_w == 19 {
                7
            } else {
                actor.chars().count() + 1
            };
            pane.put(
                c,
                y,
                &[
                    run(
                        format!("  {}  {}  ", pad(&review, 4), short(&e.finding)),
                        Token::Faint,
                        Token::Bg,
                    ),
                    run(pad(&path, path_w), Token::Fg, Token::Bg),
                    run(pad(&actor, actor_w), Token::Dim, Token::Bg),
                    run(e.reason.clone(), Token::Warn, Token::Bg),
                ],
            );
            y += 1;
            if let Some(note) = record
                .and_then(|r| r.author_response.as_ref())
                .and_then(|r| r.note.clone())
            {
                pane.put(
                    c,
                    y,
                    &[run(
                        format!("{}\"{note}\"", " ".repeat(17)),
                        Token::Faint,
                        Token::Bg,
                    )],
                );
                y += 1;
            }
        }
        y += 1;
        let Some(change) = &p.change else {
            pane.put(
                c,
                y,
                &[
                    bold(" CHANGE", Token::Faint, Token::Bg),
                    run(
                        if p.status == "proposed" {
                            "  the profile change has not been computed"
                        } else {
                            "  no change: the proposal is not open"
                        },
                        Token::Faint,
                        Token::Bg,
                    ),
                ],
            );
            self.draw_prompt(c, pane, p, y + 2, true);
            return;
        };
        pane.put(
            c,
            y,
            &[bold(
                format!(" CHANGE  {}", change.path),
                Token::Faint,
                Token::Bg,
            )],
        );
        y += 1;
        let digits = change
            .lines
            .iter()
            .map(|l| l.line.to_string().len())
            .max()
            .unwrap_or(1);
        let text_w = usize::from(pane.right.saturating_sub(1))
            .saturating_sub(usize::from(pane.x) + digits + 5);
        for l in &change.lines {
            let gutter = format!(" {} {:>digits$}  ", if l.added { "+" } else { " " }, l.line);
            if l.added {
                pane.put(
                    c,
                    y,
                    &[
                        run(gutter, Token::Pass, Token::PassTint),
                        run(pad(&l.text, text_w), Token::Fg, Token::PassTint),
                    ],
                );
            } else {
                pane.put(
                    c,
                    y,
                    &[
                        run(gutter, Token::Faint, Token::Bg),
                        run(l.text.clone(), Token::Fg, Token::Bg),
                    ],
                );
            }
            y += 1;
        }
        y += 1;
        pane.rule(c, y, 0);
        y += 1;
        if change.written {
            pane.put(
                c,
                y,
                &[
                    run(" ✓ ", Token::Pass, Token::Bg),
                    run(
                        "written to a temp file next to the profile",
                        Token::Fg,
                        Token::Bg,
                    ),
                ],
            );
        } else {
            pane.put(
                c,
                y,
                &[
                    run(" ✕ ", Token::Fail, Token::Bg),
                    run(
                        "not written: the candidate could not be created",
                        Token::Fg,
                        Token::Bg,
                    ),
                ],
            );
        }
        y += 1;
        match &change.error {
            None => pane.put(
                c,
                y,
                &[
                    run(" ✓ ", Token::Pass, Token::Bg),
                    run("rio profile validate · ok", Token::Fg, Token::Bg),
                ],
            ),
            Some(error) => pane.put(
                c,
                y,
                &[
                    run(" ✕ ", Token::Fail, Token::Bg),
                    run(
                        format!("rio profile validate · {error}"),
                        Token::Fg,
                        Token::Bg,
                    ),
                ],
            ),
        };
        y += 1;
        pane.put(
            c,
            y,
            &[
                run(" → ", Token::Signal, Token::Bg),
                run(
                    "replaces the profile only on y; any other answer leaves it byte for byte",
                    Token::Dim,
                    Token::Bg,
                ),
            ],
        );
        self.draw_prompt(c, pane, p, y + 3, change.error.is_none());
    }

    fn draw_prompt(&self, c: &mut Canvas<'_>, pane: Pane, p: &Proposal, y: u16, valid: bool) {
        let path = p
            .change
            .as_ref()
            .map_or(".rio/profiles/default.yaml", |ch| ch.path.as_str());
        if let Some(reason) = &self.decline {
            pane.put(
                c,
                y,
                &[
                    bold(
                        format!(" Decline {} · reason: ", p.id),
                        Token::Fg,
                        Token::Bg,
                    ),
                    run(reason.clone(), Token::Fg, Token::Bg),
                    run("█", Token::Fg, Token::Bg),
                ],
            );
            pane.put(
                c,
                y + 2,
                &[run(
                    format!(
                        "   ⏎ declines · esc keeps it open · not proposed again for {DECLINE_QUIET_DAYS} days"
                    ),
                    Token::Faint,
                    Token::Bg,
                )],
            );
            return;
        }
        if self.pending.as_deref() == Some(p.id.as_str()) {
            pane.put(
                c,
                y,
                &[run(
                    format!(" {} · waiting for the answer…", p.id),
                    Token::Faint,
                    Token::Bg,
                )],
            );
        } else if p.status != "proposed" {
            pane.put(
                c,
                y,
                &[run(
                    format!(" {} is {} · {}", p.id, p.status, p.scope()),
                    Token::Faint,
                    Token::Bg,
                )],
            );
        } else if !valid {
            pane.put(
                c,
                y,
                &[run(
                    " the entry does not validate · y does nothing",
                    Token::Fail,
                    Token::Bg,
                )],
            );
        } else {
            pane.put(
                c,
                y,
                &[
                    bold(format!(" Apply {} to {path}? ", p.id), Token::Fg, Token::Bg),
                    run("[y/N] ", Token::Signal, Token::Bg),
                    run("█", Token::Fg, Token::Bg),
                ],
            );
        }
        pane.put(
            c,
            y + 2,
            &[run(
                "   commit the profile with your code · the endpoint never writes repository files",
                Token::Faint,
                Token::Bg,
            )],
        );
    }
}

fn plural_dismissals(n: u32) -> String {
    format!("{n} dismissal{}", if n == 1 { "" } else { "s" })
}

#[cfg(test)]
mod tests {
    use super::date_after;

    #[test]
    fn a_declined_proposal_is_quiet_for_180_days() {
        assert_eq!(
            date_after("2026-11-10T09:00:00Z", 180).as_deref(),
            Some("2027-05-09")
        );
        assert_eq!(date_after("2024-02-28", 1).as_deref(), Some("2024-02-29"));
        assert_eq!(date_after("bad", 1), None);
    }
}

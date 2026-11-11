//! P3: the repository's finding registry (`rio findings`): one identity
//! across rounds, branches and PRs, regressions and remembered dismissals.

use ratatui::crossterm::event::{KeyCode, KeyEvent};
use rio_core::LifecycleStatus;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{
    app::{Action, Effect, Msg, Outcome, Screen, Session},
    canvas::{Canvas, Run, bold, fit, pad, pad_left, run},
    chrome::{Board, Key, Status, focus, key, keybar, quiet, status},
    theme::Token,
};

use super::{
    picker::{self, Picked, Picker},
    proposals::{ProposalsData, proposals},
    ui::{Pane, at, body_bottom, cells, footer, short, top, vrule, wrap},
};

/// What P3 shows. `records` is the endpoint's registry, answered as
/// `Outcome::Value("findings", <GET /v1/findings body>)` after
/// `Effect::Fetch("findings")`.
#[derive(Debug, Clone, Default)]
pub struct HistoryData {
    /// `owner/name`, as the header shows it.
    pub repository: String,
    /// The registry key: the normalized origin, e.g. `github.com/pixelinfinito/rio`.
    pub origin: String,
    /// An endpoint is configured; the registry lives there.
    pub endpoint: bool,
    /// The registry records once fetched.
    pub records: Option<Vec<RegistryRecord>>,
    /// The window the registry query covers, in days.
    pub since_days: u32,
    /// The lineage's author response ratio (answered / posted), when known.
    pub response_ratio: Option<f64>,
    /// Where the records come from, e.g. `across 9 PRs and 3 branches`.
    pub scope: Option<String>,
    /// A proposal the dismissals would create, shown under the notes.
    pub hint: Option<ProposalHint>,
    /// What `S` opens.
    pub proposals: ProposalsData,
}

/// `3 style dismissals of ui/spacing-scale under src/legacy/**` → `sp-3f2a`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProposalHint {
    pub summary: String,
    pub id: String,
}

/// One record of `GET /v1/findings` (`publicRecord` in `worker/src/history.ts`).
/// The fields after `updated_at` are optional extras the endpoint may add;
/// without them the screen falls back to what it can derive.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RegistryRecord {
    pub identity: String,
    #[serde(default)]
    pub repository: String,
    pub rule_id: String,
    pub status: LifecycleStatus,
    /// Review that first saw the identity.
    #[serde(default)]
    pub first_seen: String,
    /// Review that last saw it.
    #[serde(default)]
    pub last_seen: String,
    #[serde(default)]
    pub seen_count: u32,
    pub location: RecordLocation,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_response: Option<Response>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dismissed_in: Option<String>,
    /// Review that recorded it fixed; open again means a regression.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fixed_in: Option<String>,
    #[serde(default)]
    pub updated_at: String,
    /// The finding's message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// A remembered dismissal: left out of later reviews while its symbol is unchanged.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub remembered: bool,
    /// The enclosing symbol changed since the last answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub symbol_changed: Option<bool>,
    /// Why a regression came back, line breaks kept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub came_back: Option<String>,
    /// Anything else the endpoint sent, kept for `j`.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecordLocation {
    pub path: String,
    #[serde(default)]
    pub line_start: u32,
    #[serde(default)]
    pub symbol_path: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// The latest author response of a record.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Response {
    pub reason: String,
    #[serde(default)]
    pub actor: Option<String>,
    #[serde(default)]
    pub at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl RegistryRecord {
    /// Open again after it was recorded fixed.
    pub fn regression(&self) -> bool {
        self.status == LifecycleStatus::Open && self.fixed_in.is_some()
    }

    fn group(&self) -> Group {
        match self.status {
            LifecycleStatus::Open if self.regression() => Group::Regression,
            LifecycleStatus::Open => Group::Open,
            LifecycleStatus::Fixed => Group::Fixed,
            LifecycleStatus::Dismissed => Group::Dismissed,
        }
    }

    fn reason(&self) -> Option<&str> {
        self.author_response.as_ref().map(|r| r.reason.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Group {
    Open,
    Regression,
    Fixed,
    Dismissed,
}

const GROUPS: [Group; 4] = [
    Group::Open,
    Group::Regression,
    Group::Fixed,
    Group::Dismissed,
];

impl Group {
    fn label(self) -> &'static str {
        match self {
            Group::Open => "● open",
            Group::Regression => "▲ regression",
            Group::Fixed => "✓ fixed",
            Group::Dismissed => "◆ dismissed",
        }
    }
    fn tone(self) -> Token {
        match self {
            Group::Open | Group::Regression => Token::Fail,
            Group::Fixed => Token::Pass,
            Group::Dismissed => Token::Dim,
        }
    }
    fn query(self) -> &'static str {
        match self {
            Group::Open | Group::Regression => "open",
            Group::Fixed => "fixed",
            Group::Dismissed => "dismissed",
        }
    }
}

const KEYS: &[Key] = &[
    key("↑↓", "move"),
    key("f", "status"),
    key("r", "rule"),
    key("⏎", "timeline"),
    key("d", "dismiss…"),
    focus("S", "proposals"),
    key("j", "json"),
    key("esc", "back"),
];

pub struct HistoryScreen {
    data: HistoryData,
    /// Index into the filtered rows.
    cursor: usize,
    status: Option<Group>,
    rule: Option<String>,
    /// Below 120 columns, `⏎` swaps the table for the timeline.
    timeline: bool,
    picker: Option<Picker>,
    error: Option<String>,
}

/// P3. `S` opens P4 and asks for `Effect::Fetch("suppressions")`.
pub fn history(data: HistoryData) -> Box<dyn Screen> {
    Box::new(HistoryScreen::new(data))
}

impl HistoryScreen {
    pub fn new(data: HistoryData) -> Self {
        let mut screen = Self {
            data,
            cursor: 0,
            status: None,
            rule: None,
            timeline: false,
            picker: None,
            error: None,
        };
        screen.focus_regression();
        screen
    }

    /// Open on the first regression: the record most worth an answer.
    fn focus_regression(&mut self) {
        self.cursor = self.rows().iter().position(|r| r.regression()).unwrap_or(0);
    }

    fn all(&self) -> &[RegistryRecord] {
        self.data.records.as_deref().unwrap_or(&[])
    }

    fn rows(&self) -> Vec<&RegistryRecord> {
        self.all()
            .iter()
            .filter(|r| self.status.is_none_or(|g| r.group() == g))
            .filter(|r| self.rule.as_ref().is_none_or(|rule| &r.rule_id == rule))
            .collect()
    }

    fn focused(&self) -> Option<&RegistryRecord> {
        self.rows().get(self.cursor).copied()
    }

    fn command(&self) -> String {
        let mut cmd = format!(
            "rio findings --status {}",
            self.status.map_or("all", Group::query)
        );
        if let Some(rule) = &self.rule {
            cmd.push_str(&format!(" --rule {rule}"));
        }
        cmd
    }
}

impl Screen for HistoryScreen {
    fn title(&self) -> &'static str {
        "Finding history"
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
        let all = self.all();
        let regressions = all.iter().filter(|r| r.regression()).count();
        let remembered = all.iter().filter(|r| r.remembered).count();
        let mut right: Vec<Status> = Vec::new();
        if regressions > 0 {
            right.push(status(
                format!(
                    "{regressions} regression{}",
                    if regressions == 1 { "" } else { "s" }
                ),
                Token::Fail,
            ));
        }
        right.push(quiet(format!("{remembered} remembered")));
        right.push(if self.data.endpoint {
            Status {
                text: "endpoint ✓".into(),
                fg: Token::Pass,
                bold: false,
            }
        } else {
            status("no endpoint", Token::Fail)
        });
        top(
            c,
            &format!("findings · registry · {}", self.data.repository),
            &right,
        );
        let bottom = body_bottom(c);
        if c.width() >= 120 {
            vrule(c, 22, 1, bottom);
            vrule(c, 80, 1, bottom);
            self.draw_filters(c, Pane::new(0, 22, bottom));
            self.draw_table(c, Pane::new(23, 80, bottom));
            self.draw_record(c, Pane::new(81, c.width(), bottom));
        } else if self.timeline {
            self.draw_record(c, Pane::new(0, c.width(), bottom));
        } else {
            self.draw_table(c, Pane::new(0, c.width(), bottom));
        }
        let own = if self.data.endpoint {
            let scope = self
                .data
                .scope
                .as_ref()
                .map(|s| format!(" {s}"))
                .unwrap_or_default();
            format!(
                " {} findings{scope} · registry lives on the endpoint · exits 2 without one",
                all.len()
            )
        } else {
            " no endpoint: the registry lives on the endpoint · rio findings exits 2 without one"
                .to_owned()
        };
        footer(c, session, &[run(own, Token::Faint, Token::Bg)]);
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
                    self.picker = None;
                    if let Effect::Feedback { id, reason, note } = &effect
                        && let Some(records) = &mut self.data.records
                        && let Some(r) = records.iter_mut().find(|r| &r.identity == id)
                    {
                        r.status = LifecycleStatus::Dismissed;
                        r.author_response = Some(Response {
                            reason: reason.clone(),
                            actor: None,
                            at: None,
                            note: note.clone(),
                            extra: Map::new(),
                        });
                    }
                    Action::Effect(effect)
                }
            };
        }
        let rows = self.rows().len();
        match key.code {
            KeyCode::Up | KeyCode::Char('k') => self.cursor = self.cursor.saturating_sub(1),
            KeyCode::Down if self.cursor + 1 < rows => {
                self.cursor += 1;
            }
            KeyCode::Char('f') => {
                self.status = match self.status {
                    None => Some(GROUPS[0]),
                    Some(g) => GROUPS
                        .iter()
                        .position(|x| *x == g)
                        .and_then(|i| GROUPS.get(i + 1))
                        .copied(),
                };
                self.cursor = 0;
            }
            KeyCode::Char('r') => {
                self.rule = match (&self.rule, self.focused()) {
                    (None, Some(r)) => Some(r.rule_id.clone()),
                    _ => None,
                };
                self.cursor = 0;
            }
            KeyCode::Enter => self.timeline = !self.timeline,
            KeyCode::Char('d') => {
                if let Some(r) = self.focused() {
                    self.picker = Some(Picker::new(&r.identity, self.data.endpoint));
                }
            }
            KeyCode::Char('S') => {
                let mut data = self.data.proposals.clone();
                data.records = self.all().to_vec();
                return Action::Many(vec![
                    Action::Push(proposals(data)),
                    Action::Effect(Effect::Fetch("suppressions".into())),
                ]);
            }
            KeyCode::Char('j') => {
                if let Some(r) = self.focused()
                    && let Ok(json) = serde_json::to_string_pretty(r)
                {
                    return Action::Effect(Effect::Copy(json));
                }
            }
            KeyCode::Esc if self.timeline && self.picker.is_none() => {
                self.timeline = false;
                return Action::Many(Vec::new());
            }
            _ => {}
        }
        Action::None
    }

    fn on_msg(&mut self, msg: &Msg, _session: &mut Session) -> Action {
        match msg {
            Msg::Done(Outcome::Value(name, value)) if name == "findings" => {
                match serde_json::from_value::<Vec<RegistryRecord>>(value["findings"].clone()) {
                    Ok(records) => {
                        self.data.records = Some(records);
                        self.error = None;
                        self.focus_regression();
                    }
                    Err(error) => self.error = Some(format!("unreadable registry: {error}")),
                }
            }
            Msg::Done(Outcome::Failed(error)) if self.data.records.is_none() => {
                self.error = Some(error.clone());
            }
            _ => {}
        }
        Action::None
    }
}

/// The status cell of a row: the group, or the dismissal's reason.
fn status_cell(r: &RegistryRecord) -> (String, Token, bool) {
    match r.group() {
        Group::Dismissed => {
            let reason = r.reason().unwrap_or("dismissed");
            let reason = if reason.chars().count() > 10 {
                format!("{}.", reason.chars().take(9).collect::<String>())
            } else {
                reason.to_owned()
            };
            let tone = if r.reason() == Some("wrong") {
                Token::Warn
            } else {
                Token::Dim
            };
            (format!("◆ {reason}"), tone, false)
        }
        Group::Regression => (Group::Regression.label().into(), Token::Fail, true),
        g => (g.label().into(), g.tone(), false),
    }
}

/// A review reference as the timeline shows it: a timestamp becomes its date.
fn when(text: &str) -> String {
    if text.len() >= 10 && text.as_bytes().get(4) == Some(&b'-') && text.contains('T') {
        text.get(..10).unwrap_or(text).to_owned()
    } else {
        text.to_owned()
    }
}

impl HistoryScreen {
    fn draw_filters(&self, c: &mut Canvas<'_>, pane: Pane) {
        let all = self.all();
        let focused = self.focused().map(RegistryRecord::group);
        pane.put(c, 2, &[bold(" STATUS", Token::Faint, Token::Bg)]);
        pane.put(
            c,
            3,
            &[
                run(" ", Token::Fg, Token::Bg),
                run(pad("All", 15), Token::Fg, Token::Bg),
                run(pad_left(&all.len().to_string(), 4), Token::Dim, Token::Bg),
            ],
        );
        let mut y = 4;
        for g in GROUPS {
            let n = all.iter().filter(|r| r.group() == g).count();
            if focused == Some(g) {
                pane.put(
                    c,
                    y,
                    &[
                        run("▌", Token::Signal, Token::Raise),
                        bold(pad(g.label(), 15), Token::Fg, Token::Raise),
                        bold(pad_left(&n.to_string(), 4), g.tone(), Token::Raise),
                        run("  ", Token::Fg, Token::Raise),
                    ],
                );
                c.cursor(y, pane.x, pane.right);
            } else {
                pane.put(
                    c,
                    y,
                    &[
                        run(" ", Token::Fg, Token::Bg),
                        run(pad(g.label(), 15), Token::Fg, Token::Bg),
                        run(pad_left(&n.to_string(), 4), g.tone(), Token::Bg),
                    ],
                );
            }
            y += 1;
        }
        let remembered = all.iter().filter(|r| r.remembered).count();
        pane.put(
            c,
            y,
            &[run(
                format!("   {remembered} remembered"),
                Token::Faint,
                Token::Bg,
            )],
        );
        y += 2;
        pane.put(c, y, &[bold(" REASONS", Token::Faint, Token::Bg)]);
        y += 1;
        for reason in rio_core::ResponseReason::ALL {
            let n = all
                .iter()
                .filter(|r| {
                    r.status == LifecycleStatus::Dismissed && r.reason() == Some(reason.as_str())
                })
                .count();
            pane.put(
                c,
                y,
                &[
                    run(
                        format!(" {}", pad(reason.as_str(), 13)),
                        Token::Fg,
                        Token::Bg,
                    ),
                    run(n.to_string(), Token::Dim, Token::Bg),
                ],
            );
            y += 1;
        }
        y += 1;
        pane.put(c, y, &[bold(" SINCE", Token::Faint, Token::Bg)]);
        pane.put(
            c,
            y + 1,
            &[run(
                format!(" {} days", self.data.since_days),
                Token::Fg,
                Token::Bg,
            )],
        );
        y += 3;
        if let Some(ratio) = self.data.response_ratio {
            pane.put(c, y, &[bold(" RESPONSE RATIO", Token::Faint, Token::Bg)]);
            pane.put(
                c,
                y + 1,
                &[
                    bold(format!(" {ratio:.2} "), Token::Fg, Token::Bg),
                    run("authors answer", Token::Faint, Token::Bg),
                ],
            );
            pane.put(
                c,
                y + 2,
                &[run(
                    format!("      {:.0} % of posted", ratio * 100.0),
                    Token::Faint,
                    Token::Bg,
                )],
            );
            y += 4;
        }
        pane.put(c, y, &[bold(" KEY", Token::Faint, Token::Bg)]);
        let (host, rest) = match self.data.origin.split_once('/') {
            Some((host, rest)) => (format!("{host}/"), rest.to_owned()),
            None => (String::new(), self.data.origin.clone()),
        };
        pane.put(
            c,
            y + 1,
            &[run(format!(" {host}"), Token::Faint, Token::Bg)],
        );
        pane.put(c, y + 2, &[run(format!(" {rest}"), Token::Fg, Token::Bg)]);
        pane.put(
            c,
            y + 3,
            &[run(" origin, normalized", Token::Faint, Token::Bg)],
        );
    }

    fn draw_table(&self, c: &mut Canvas<'_>, pane: Pane) {
        let all = self.all();
        pane.put(
            c,
            2,
            &[
                bold(" Findings ", Token::Fg, Token::Bg),
                run(all.len().to_string(), Token::Dim, Token::Bg),
                run(format!("   {}", self.command()), Token::Faint, Token::Bg),
            ],
        );
        pane.put(
            c,
            3,
            &[run(
                format!(
                    " {}{}{}{}last seen  seen",
                    pad("id", 9),
                    pad("status", 12),
                    pad("rule", 18),
                    pad("path", 17)
                ),
                Token::Faint,
                Token::Bg,
            )],
        );
        pane.rule(c, 4, 0);
        let mut y = 5;
        if self.data.records.is_none() {
            let text = match &self.error {
                Some(e) => run(format!(" ✕ {e}"), Token::Fail, Token::Bg),
                None => run(
                    " asking the endpoint for the registry…",
                    Token::Faint,
                    Token::Bg,
                ),
            };
            pane.put(c, y, &[text]);
            return;
        }
        let rows = self.rows();
        let notes = c.height() >= 40;
        let room = if notes {
            12
        } else {
            usize::from(pane.bottom.saturating_sub(y + 1)).max(1)
        };
        let first = self.cursor.saturating_sub(room - 1);
        for (i, r) in rows.iter().enumerate().skip(first).take(room) {
            let cursor = i == self.cursor;
            let bg = if cursor { Token::Raise } else { Token::Bg };
            let (label, tone, strong) = status_cell(r);
            let rule = Run {
                text: pad(&r.rule_id, 18),
                fg: Token::Fg,
                bg,
                bold: cursor,
            };
            pane.put(
                c,
                y,
                &[
                    run(if cursor { "▌" } else { " " }, Token::Signal, bg),
                    run(format!("{} ", pad(short(&r.identity), 8)), Token::Faint, bg),
                    Run {
                        text: pad(&label, 12),
                        fg: tone,
                        bg,
                        bold: strong,
                    },
                    rule,
                    run(pad(&r.location.path, 17), Token::Dim, bg),
                    run(
                        format!("{}  ×{}", pad(&when(&r.last_seen), 9), r.seen_count),
                        Token::Faint,
                        bg,
                    ),
                ],
            );
            if cursor {
                c.cursor(y, pane.x, pane.right);
            }
            y += 1;
        }
        if rows.is_empty() {
            pane.put(c, y, &[run(" no record matches", Token::Faint, Token::Bg)]);
            y += 1;
        }
        let hidden = rows.len().saturating_sub(room);
        if hidden > 0 {
            pane.put(
                c,
                y,
                &[run(format!(" ⋯ {hidden} more"), Token::Faint, Token::Bg)],
            );
        }
        if !notes {
            return;
        }
        let mut y = 5 + cells(room) + 2;
        pane.rule(c, y, 0);
        y += 1;
        let remembered = all.iter().filter(|r| r.remembered).count();
        pane.put(
            c,
            y,
            &[
                bold(" ◆ remembered ", Token::Faint, Token::Bg),
                run(
                    format!("{remembered} · left out of later reviews"),
                    Token::Faint,
                    Token::Bg,
                ),
            ],
        );
        for (i, text) in [
            "   while the enclosing symbol is unchanged",
            "   rio review --show-remembered lists them",
        ]
        .iter()
        .enumerate()
        {
            pane.put(c, y + 1 + cells(i), &[run(*text, Token::Faint, Token::Bg)]);
        }
        y += 4;
        pane.put(
            c,
            y,
            &[
                bold(" ◆ wrong ", Token::Warn, Token::Bg),
                run("is never remembered:", Token::Faint, Token::Bg),
            ],
        );
        for (i, text) in [
            "   a recurrence is reported again with a",
            "   history line naming the earlier answer",
        ]
        .iter()
        .enumerate()
        {
            pane.put(c, y + 1 + cells(i), &[run(*text, Token::Faint, Token::Bg)]);
        }
        y += 4;
        if let Some(hint) = &self.data.hint {
            let text = format!("{} → ", hint.summary);
            let lines = wrap(&text, pane.width().saturating_sub(2));
            let n = lines.len();
            for (i, line) in lines.into_iter().enumerate() {
                let mut runs = vec![run(format!(" {line}"), Token::Dim, Token::Bg)];
                if i + 1 == n {
                    runs.push(bold(
                        format!("proposal {}", hint.id),
                        Token::Signal,
                        Token::Bg,
                    ));
                    runs.push(bold("  S", Token::Fg, Token::Bg));
                }
                pane.put(c, y, &runs);
                y += 1;
            }
        }
    }

    fn draw_record(&self, c: &mut Canvas<'_>, pane: Pane) {
        let Some(r) = self.focused() else {
            pane.put(c, 2, &[run(" no record", Token::Faint, Token::Bg)]);
            return;
        };
        let id = format!(" {} ", short(&r.identity));
        let title = r.message.clone().unwrap_or_else(|| {
            let symbol = r.location.symbol_path.trim_end_matches("()");
            if symbol.is_empty() {
                r.rule_id.clone()
            } else {
                format!("{} in {symbol}", r.rule_id)
            }
        });
        let room = pane.width().saturating_sub(id.chars().count());
        pane.put(
            c,
            2,
            &[
                run(id, Token::Faint, Token::Bg),
                bold(fit(&title, room), Token::Fg, Token::Bg),
            ],
        );
        let (label, tone, _) = status_cell(r);
        pane.put(
            c,
            3,
            &[
                bold(format!(" {label}"), tone, Token::Bg),
                run(
                    format!("  {}:{}", r.location.path, r.location.line_start),
                    Token::Signal,
                    Token::Bg,
                ),
            ],
        );
        let mut symbol = vec![
            run(" symbol ", Token::Faint, Token::Bg),
            run(r.location.symbol_path.clone(), Token::Fg, Token::Bg),
        ];
        match r.symbol_changed {
            Some(true) => symbol.push(run("  changed", Token::Warn, Token::Bg)),
            Some(false) => symbol.push(run("  unchanged", Token::Faint, Token::Bg)),
            None => {}
        }
        pane.put(c, 4, &symbol);
        pane.rule(c, 5, 0);
        pane.put(c, 6, &[bold(" TIMELINE", Token::Faint, Token::Bg)]);
        let mut events: Vec<(String, Token, String, String)> = Vec::new();
        if !r.first_seen.is_empty() {
            events.push((
                r.first_seen.clone(),
                Token::Fail,
                "first seen".into(),
                "open".into(),
            ));
        }
        if let Some(resp) = &r.author_response {
            let tone = match resp.reason.as_str() {
                "fixed" => Token::Pass,
                "wrong" => Token::Warn,
                _ => Token::Dim,
            };
            let when_ = resp
                .at
                .clone()
                .or_else(|| r.dismissed_in.clone())
                .unwrap_or_default();
            events.push((
                when_,
                tone,
                format!("author: {}", resp.reason),
                resp.actor.as_deref().map(at).unwrap_or_default(),
            ));
        }
        if let Some(fixed) = &r.fixed_in {
            events.push((
                fixed.clone(),
                Token::Pass,
                "verified fixed".into(),
                "gone".into(),
            ));
        }
        let regression = r.regression();
        if regression {
            events.push((
                r.last_seen.clone(),
                Token::Fail,
                "seen again".into(),
                "head".into(),
            ));
        } else if r.last_seen != r.first_seen && !r.last_seen.is_empty() {
            events.push((
                r.last_seen.clone(),
                Token::Dim,
                "last seen".into(),
                String::new(),
            ));
        }
        let mut y = 7;
        let n = events.len();
        for (i, (when_, tone, what, detail)) in events.into_iter().enumerate() {
            pane.put(
                c,
                y,
                &[
                    run(
                        format!(" {}", pad(&when(&when_), 10)),
                        Token::Faint,
                        Token::Bg,
                    ),
                    run("● ", tone, Token::Bg),
                    run(pad(&what, 18), Token::Fg, Token::Bg),
                    run(detail, Token::Faint, Token::Bg),
                ],
            );
            y += 1;
            if i + 1 < n {
                pane.put(c, y, &[run("           │", Token::Rule, Token::Bg)]);
                y += 1;
            }
        }
        if regression {
            for line in ["labelled regression,", "not new"] {
                pane.put(
                    c,
                    y,
                    &[run(format!("             {line}"), Token::Fail, Token::Bg)],
                );
                y += 1;
            }
            y += 1;
            pane.put(c, y, &[bold(" WHY IT CAME BACK", Token::Faint, Token::Bg)]);
            y += 1;
            let why = r.came_back.clone().unwrap_or_else(|| {
                format!(
                    "fixed in {}, seen again in {}",
                    r.fixed_in.clone().unwrap_or_default(),
                    r.last_seen
                )
            });
            for line in wrap(&why, pane.width().saturating_sub(2)) {
                pane.put(c, y, &[run(format!(" {line}"), Token::Dim, Token::Bg)]);
                y += 1;
            }
        }
        y += 1;
        pane.put(c, y, &[bold(" ANSWER IT", Token::Faint, Token::Bg)]);
        pane.put(
            c,
            y + 1,
            &[
                bold(" d ", Token::Fg, Token::Bg),
                run("dismiss with a reason", Token::Faint, Token::Bg),
            ],
        );
        pane.put(
            c,
            y + 2,
            &[run(
                format!(" rio feedback {} --dismiss", short(&r.identity)),
                Token::Signal,
                Token::Bg,
            )],
        );
        for (i, text) in [
            "   fixed|wrong|intentional|",
            "   irrelevant|style",
            " a dismissal never changes posture,",
            " budgets, rules or suppressions",
        ]
        .iter()
        .enumerate()
        {
            pane.put(c, y + 3 + cells(i), &[run(*text, Token::Faint, Token::Bg)]);
        }
    }
}

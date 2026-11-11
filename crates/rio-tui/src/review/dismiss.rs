//! 03 — Lineage and feedback: the dismissal dialog over the lineage history.

use std::{cell::RefCell, collections::BTreeSet, rc::Rc};

use ratatui::crossterm::event::{KeyCode, KeyEvent};
use rio_core::{Finding, LifecycleStatus, LineageKind, ResponseReason};

use super::{FindingsData, chip, dialog, id8, put_in, short_path, vrule};
use crate::{
    app::{Action, Effect, Msg, Outcome, Screen, Session},
    canvas::{Canvas, bold, pad, run, width},
    chrome::{Board, Key, key, keybar, quiet, status},
    theme::Token,
};

/// One round of a lineage.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineageRound {
    /// Its number, from 1.
    pub round: u32,
    /// Findings it reported.
    pub findings: usize,
    /// What ran, e.g. `full review` or `diff only`.
    pub note: String,
    /// The snapshot it reviewed, as shown (e.g. `3e1a`).
    pub snapshot: String,
}

/// A finding of the lineage and where it stands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineageFinding {
    /// Its full identity.
    pub id: String,
    /// Open, fixed or dismissed.
    pub status: LifecycleStatus,
    /// When and how, e.g. `first posted R1` or `intentional`.
    pub note: String,
}

/// The lineage history the report doesn't carry: rounds and findings.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LineageHistory {
    /// Every round so far, oldest first.
    pub rounds: Vec<LineageRound>,
    /// The lineage's findings.
    pub findings: Vec<LineageFinding>,
}

const KEYS: &[Key] = &[
    key("↑↓", "reason"),
    key("tab", "note"),
    key("⏎", "record"),
    key("esc", "cancel"),
];

const EXPLAIN: [&str; 5] = [
    "the code was changed",
    "the finding is incorrect",
    "the behaviour is deliberate",
    "not relevant to this change",
    "a matter of style",
];

#[derive(Debug, Clone, PartialEq, Eq)]
enum Progress {
    Editing,
    Recording,
    Failed(String),
}

pub(crate) struct DismissScreen {
    data: Rc<FindingsData>,
    finding: Finding,
    dismissed: Rc<RefCell<BTreeSet<String>>>,
    reason: usize,
    note: String,
    note_focused: bool,
    progress: Progress,
}

impl DismissScreen {
    pub(crate) fn new(
        data: Rc<FindingsData>,
        finding: Finding,
        dismissed: Rc<RefCell<BTreeSet<String>>>,
    ) -> Self {
        Self {
            data,
            finding,
            dismissed,
            reason: 0,
            note: String::new(),
            note_focused: false,
            progress: Progress::Editing,
        }
    }

    fn record(&mut self) -> Action {
        if !self.data.endpoint || self.progress == Progress::Recording {
            return Action::None;
        }
        self.progress = Progress::Recording;
        let note = self.note.trim();
        Action::Effect(Effect::Feedback {
            id: self.finding.id.clone(),
            reason: ResponseReason::ALL[self.reason].as_str().into(),
            note: (!note.is_empty()).then(|| note.to_owned()),
        })
    }

    fn draw_background(&self, c: &mut Canvas<'_>) {
        let data = &*self.data;
        let (w, h) = (c.width(), c.height());
        let div: u16 = if w >= 120 { 58 } else { w / 2 };
        vrule(c, div, 1, h.saturating_sub(1));
        let lr = div - 2;
        let dim = |text: String| run(text, Token::Faint, Token::Bg);
        let title = |text: &str| run(text.to_owned(), Token::Rule, Token::Bg);
        put_in(c, 2, 2, lr, &[title("LINEAGE")]);
        let history = data.lineage.clone().unwrap_or_default();
        let mut y = 3;
        if let Some(l) = &data.report.lineage {
            let kind = match l.kind {
                LineageKind::Pr => "pr",
                LineageKind::Branch => "branch",
            };
            put_in(c, 2, 3, lr, &[dim(format!("{} · {kind}", l.repository))]);
            put_in(c, 2, 4, lr, &[dim(l.reference.clone())]);
            put_in(
                c,
                2,
                5,
                lr,
                &[title(&format!(
                    "generation {} · round {} of cap {}",
                    l.generation, l.round, l.cap
                ))],
            );
            y = 7;
        }
        put_in(c, 2, y, lr, &[title("ROUNDS")]);
        let bars = history
            .rounds
            .iter()
            .map(|r| r.findings)
            .max()
            .unwrap_or(0)
            .min(10);
        let current = data.report.lineage.as_ref().map(|l| l.round);
        for r in &history.rounds {
            y += 1;
            let label = format!("R{}", r.round);
            let label = if Some(r.round) == current {
                title(&label)
            } else {
                dim(label)
            };
            let x = put_in(c, 2, y, lr, &[label, run("  ", Token::Fg, Token::Bg)]);
            let n = r.findings.min(10);
            let x = put_in(
                c,
                x,
                y,
                lr,
                &[
                    run("■".repeat(n), Token::Rule, Token::Bg),
                    dim(format!(
                        "{}{} finding{}",
                        " ".repeat(bars - n + 2),
                        r.findings,
                        if r.findings == 1 { "" } else { "s" }
                    )),
                ],
            );
            if x + 3 < lr {
                put_in(c, x + 3, y, lr, &[title(&r.note)]);
            }
            c.put_right(lr, y, &[title(&r.snapshot)]);
            y += 1;
        }
        if let Some(l) = &data.report.lineage {
            y += 1;
            put_in(
                c,
                2,
                y,
                lr,
                &[title(&format!("cap {} {}", "─".repeat(15), l.cap))],
            );
            y += 2;
            put_in(c, 2, y, lr, &[title("CONVERGENCE")]);
            let rows = [
                ("held back (already posted)", l.held_back.to_string()),
                (
                    "author-response ratio",
                    l.author_response_ratio
                        .map_or("–".into(), |r| format!("{:.2}", r.get())),
                ),
                (
                    "rounds to pass",
                    l.rounds_to_pass.map_or("–".into(), |n| n.to_string()),
                ),
            ];
            for (label, value) in rows {
                y += 1;
                put_in(c, 2, y, lr, &[dim(format!("{label:<23} {value}"))]);
            }
            y += 2;
        }
        y += 1;
        put_in(c, 2, y, lr, &[title("FINDINGS IN LINEAGE")]);
        for f in &history.findings {
            y += 1;
            let status = match f.status {
                LifecycleStatus::Open => "open",
                LifecycleStatus::Fixed => "fixed",
                LifecycleStatus::Dismissed => "dismissed",
            };
            put_in(
                c,
                2,
                y,
                lr,
                &[
                    title(id8(&f.id)),
                    run("  ", Token::Fg, Token::Bg),
                    title(status),
                    dim(format!("{}{}", " ".repeat(11 - status.len()), f.note)),
                ],
            );
        }
        // The reconsider box.
        let Some(reconsider) = data
            .report
            .lineage
            .as_ref()
            .and_then(|l| l.reconsider.as_ref().map(|r| (r, l.round, l.cap)))
        else {
            return;
        };
        let (r, round, cap) = reconsider;
        let x0 = div + 2;
        let x1 = w.saturating_sub(3);
        if x1 <= x0 + 10 {
            return;
        }
        let inner = usize::from(x1 - x0 - 1);
        let head = "─ ▲ Reconsider ";
        let top = format!("┌{head}{}┐", "─".repeat(inner.saturating_sub(width(head))));
        c.put(x0, 2, &title(&top));
        let mut lines: Vec<Vec<crate::canvas::Run>> = vec![
            vec![],
            vec![dim(format!(
                " Round {round} exceeds the cap of {cap}: {} unresolved findings.",
                r.unresolved
            ))],
            vec![dim(" Reconsider the approach or split the change.".into())],
            vec![],
        ];
        let place_x = inner.saturating_sub(17);
        for item in &r.top {
            let title_text = data
                .labels
                .get(&item.id)
                .map(|l| l.title.clone())
                .unwrap_or_else(|| item.title.clone());
            let place = data
                .labels
                .get(&item.id)
                .map(|l| l.place.clone())
                .unwrap_or_else(|| short_path(&format!("{}:{}", item.path, item.line_start), 16));
            let left = format!(" {}", pad(&title_text, place_x.saturating_sub(10)));
            lines.push(vec![
                run(" ", Token::Fg, Token::Bg),
                title(id8(&item.id)),
                dim(left),
                dim(pad(&place, 17)),
            ]);
        }
        if let Some(split) = &r.split {
            lines.push(vec![]);
            lines.push(vec![dim(" Split suggested:".into())]);
            lines.push(vec![dim(format!("   {}", split.join(" · ")))]);
            lines.push(vec![]);
            lines.push(vec![dim(" then rio review --since-last".into())]);
        }
        lines.push(vec![]);
        let mut y = 3;
        for line in lines {
            if y + 1 >= h.saturating_sub(1) {
                break;
            }
            c.put(x0, y, &title("│"));
            put_in(c, x0 + 1, y, x1, &line);
            c.put(x1, y, &title("│"));
            y += 1;
        }
        c.put(x0, y, &title(&format!("└{}┘", "─".repeat(inner))));
    }
}

impl Screen for DismissScreen {
    fn title(&self) -> &'static str {
        "Dismiss finding"
    }
    fn board(&self) -> Board {
        Board::V2
    }
    fn keys(&self) -> &'static [Key] {
        KEYS
    }
    fn wants_text(&self) -> bool {
        self.note_focused
    }

    fn draw(&self, c: &mut Canvas<'_>, _session: &Session) {
        c.clear(Token::Bg);
        let data = &*self.data;
        let (context, right) = match &data.report.lineage {
            Some(l) => {
                let command = match l.kind {
                    LineageKind::Branch => "rio review --since-last",
                    LineageKind::Pr => "rio review --pr",
                };
                let state = if l.capped {
                    status(
                        format!("▲ capped · round {} of {}", l.round, l.cap),
                        Token::Warn,
                    )
                } else {
                    quiet(format!("round {} of {}", l.round, l.cap))
                };
                (
                    format!("{} · {command}", l.reference),
                    vec![state, quiet(format!("gen {}", l.generation))],
                )
            }
            None => (data.context.clone(), vec![quiet("dismiss")]),
        };
        super::head(c, &context, &right);
        self.draw_background(c);
        let (w, h) = (c.width(), c.height());
        let dw = 68.min(w.saturating_sub(4));
        let dh = 20.min(h.saturating_sub(3));
        let x0 = (w - dw) / 2;
        let y0 = ((h - dh) / 2).max(1);
        let x1 = x0 + dw - 1;
        let y1 = y0 + dh - 1;
        let f = &self.finding;
        dialog(c, x0, y0, x1, y1, &format!("rio feedback {}", id8(&f.id)));
        let cx = x0 + 3;
        let right = x1 - 1;
        let at = |dy: u16| y0 + dy;
        let rows_left = |dy: u16| at(dy) < y1;
        put_in(
            c,
            cx,
            at(2),
            right,
            &[bold("Dismiss finding", Token::Fg, Token::Panel)],
        );
        put_in(
            c,
            cx,
            at(3),
            right,
            &[run(
                format!("{} · {}", id8(&f.id), f.message),
                Token::Dim,
                Token::Panel,
            )],
        );
        put_in(
            c,
            cx,
            at(5),
            right,
            &[bold("REASON", Token::Faint, Token::Panel)],
        );
        for (i, reason) in ResponseReason::ALL.iter().enumerate() {
            let y = at(6 + i as u16);
            if !rows_left(6 + i as u16) {
                break;
            }
            let selected = i == self.reason;
            let bg = if selected {
                c.fill(y, x0 + 2, right, Token::Raise);
                c.put(x0 + 2, y, &run("▌", Token::Signal, Token::Raise));
                c.cursor(y, x0 + 2, right);
                Token::Raise
            } else {
                Token::Panel
            };
            put_in(
                c,
                x0 + 4,
                y,
                right,
                &[
                    if selected {
                        run("(•)", Token::Signal, bg)
                    } else {
                        run("( )", Token::Faint, bg)
                    },
                    run(" ", Token::Fg, bg),
                    if selected {
                        bold(pad(reason.as_str(), 14), Token::Fg, bg)
                    } else {
                        run(pad(reason.as_str(), 14), Token::Dim, bg)
                    },
                    run(EXPLAIN[i], Token::Faint, bg),
                ],
            );
        }
        if rows_left(13) {
            put_in(
                c,
                cx,
                at(12),
                right,
                &[bold("NOTE", Token::Faint, Token::Panel)],
            );
            let y = at(13);
            let field_right = x1 - 2;
            c.fill(y, cx, field_right, Token::Raise);
            let room = usize::from(field_right - cx).saturating_sub(2);
            let shown: String = {
                let text = format!(" {}", self.note);
                if width(&text) > room {
                    let skip = width(&text) - room;
                    text.chars().skip(skip).collect()
                } else {
                    text
                }
            };
            let end = put_in(
                c,
                cx,
                y,
                field_right,
                &[run(shown, Token::Fg, Token::Raise)],
            );
            if self.note_focused {
                c.put(end, y, &run("▏", Token::Signal, Token::Raise));
            } else if self.note.is_empty() {
                put_in(
                    c,
                    end,
                    y,
                    field_right,
                    &[run(" optional · tab to type", Token::Faint, Token::Raise)],
                );
            }
        }
        if rows_left(15) {
            let line = if data.endpoint {
                run(format!("actor  {}", data.actor), Token::Faint, Token::Panel)
            } else {
                run(
                    "dismissals need an endpoint · run rio init to configure one",
                    Token::Warn,
                    Token::Panel,
                )
            };
            put_in(c, cx, at(15), right, &[line]);
        }
        if rows_left(16) {
            match &self.progress {
                Progress::Recording => {
                    put_in(
                        c,
                        cx,
                        at(16),
                        right,
                        &[run("recording…", Token::Faint, Token::Panel)],
                    );
                }
                Progress::Failed(error) => {
                    put_in(
                        c,
                        cx,
                        at(16),
                        right,
                        &[run(format!("✕ {error}"), Token::Fail, Token::Panel)],
                    );
                }
                Progress::Editing => {}
            }
        }
        if rows_left(17) {
            let y = at(17);
            let x = if data.endpoint {
                chip(c, cx, y, "⏎ record")
            } else {
                c.put(cx, y, &run(" ⏎ record ", Token::Faint, Token::Panel))
            };
            let x = put_in(
                c,
                x,
                y,
                right,
                &[
                    run("  ", Token::Fg, Token::Panel),
                    bold("esc", Token::Fg, Token::Panel),
                    run(" ", Token::Fg, Token::Panel),
                    run("cancel", Token::Faint, Token::Panel),
                    run("     ", Token::Fg, Token::Panel),
                ],
            );
            put_in(
                c,
                x,
                y,
                right,
                &[run(
                    "never changes posture or rules",
                    Token::Faint,
                    Token::Panel,
                )],
            );
        }
        keybar(c, KEYS);
    }

    fn on_key(&mut self, key: KeyEvent, _session: &mut Session) -> Action {
        match key.code {
            KeyCode::Esc => return Action::Pop,
            KeyCode::Enter => return self.record(),
            KeyCode::Tab | KeyCode::BackTab => self.note_focused = !self.note_focused,
            KeyCode::Up => self.reason = self.reason.saturating_sub(1),
            KeyCode::Down => self.reason = (self.reason + 1).min(ResponseReason::ALL.len() - 1),
            KeyCode::Backspace if self.note_focused => {
                self.note.pop();
            }
            KeyCode::Char(ch) if self.note_focused => self.note.push(ch),
            KeyCode::Char('k') => self.reason = self.reason.saturating_sub(1),
            KeyCode::Char('j') => {
                self.reason = (self.reason + 1).min(ResponseReason::ALL.len() - 1)
            }
            _ => {}
        }
        Action::None
    }

    fn on_msg(&mut self, msg: &Msg, _session: &mut Session) -> Action {
        if self.progress != Progress::Recording {
            return Action::None;
        }
        match msg {
            Msg::Done(Outcome::Ok(_)) => {
                self.dismissed.borrow_mut().insert(self.finding.id.clone());
                Action::Pop
            }
            Msg::Done(Outcome::Failed(error)) => {
                self.progress = Progress::Failed(error.clone());
                Action::None
            }
            _ => Action::None,
        }
    }
}

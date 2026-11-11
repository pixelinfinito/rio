//! The compact dismissal dialog `d` opens on P1 and P3: the five
//! standardized reasons and an optional note, recorded through the
//! finding-feedback capability exactly like `rio feedback`.

use ratatui::crossterm::event::{KeyCode, KeyEvent};
use rio_core::ResponseReason;

use crate::{
    app::Effect,
    canvas::{Canvas, bold, run},
    chrome::{Key, key},
    theme::Token,
};

use super::ui::{Pane, dialog, short};

pub(crate) const KEYS: &[Key] = &[
    key("↑↓", "reason"),
    key("tab", "note"),
    key("⏎", "record"),
    key("esc", "cancel"),
];

/// What a key did to the dialog.
pub(crate) enum Picked {
    /// Still open.
    Open,
    /// Closed without recording anything.
    Cancelled,
    /// Closed; the host records this response.
    Record(Effect),
}

pub(crate) struct Picker {
    /// The full identity, as `Effect::Feedback` takes it.
    pub id: String,
    pub reason: usize,
    pub note: String,
    pub note_focus: bool,
    /// An endpoint is configured; without one nothing can be recorded.
    pub endpoint: bool,
}

impl Picker {
    pub fn new(id: &str, endpoint: bool) -> Self {
        Self {
            id: id.to_owned(),
            reason: 0,
            note: String::new(),
            note_focus: false,
            endpoint,
        }
    }

    pub fn reason(&self) -> ResponseReason {
        ResponseReason::ALL[self.reason.min(ResponseReason::ALL.len() - 1)]
    }

    pub fn on_key(&mut self, key: KeyEvent) -> Picked {
        match key.code {
            KeyCode::Esc => return Picked::Cancelled,
            KeyCode::Tab | KeyCode::BackTab => self.note_focus = !self.note_focus,
            KeyCode::Enter => {
                if !self.endpoint {
                    return Picked::Cancelled;
                }
                let note = self.note.trim();
                return Picked::Record(Effect::Feedback {
                    id: self.id.clone(),
                    reason: self.reason().as_str().to_owned(),
                    note: (!note.is_empty()).then(|| note.to_owned()),
                });
            }
            KeyCode::Backspace if self.note_focus => {
                self.note.pop();
            }
            KeyCode::Char(ch) if self.note_focus => self.note.push(ch),
            KeyCode::Up | KeyCode::Char('k') => self.reason = self.reason.saturating_sub(1),
            KeyCode::Down | KeyCode::Char('j') => {
                self.reason = (self.reason + 1).min(ResponseReason::ALL.len() - 1);
            }
            _ => {}
        }
        Picked::Open
    }

    /// Draw the dialog centred over the canvas.
    pub fn draw(&self, c: &mut Canvas<'_>) {
        let w = 50.min(c.width().saturating_sub(4));
        let h = 12;
        let x = c.width().saturating_sub(w) / 2;
        let y = (c.height().saturating_sub(h) / 2).max(1);
        dialog(c, x, y, w, h, &format!("Dismiss {}", short(&self.id)));
        let pane = Pane::new(x + 2, x + w.saturating_sub(2), y + h - 1);
        if !self.endpoint {
            pane.put(
                c,
                y + 2,
                &[bold(
                    "Dismissals need an endpoint.",
                    Token::Warn,
                    Token::Raise,
                )],
            );
            pane.put(
                c,
                y + 3,
                &[run(
                    "Nothing is recorded; run rio init or connect one.",
                    Token::Dim,
                    Token::Raise,
                )],
            );
            pane.put(
                c,
                y + 5,
                &[run("⏎ or esc closes", Token::Faint, Token::Raise)],
            );
            return;
        }
        for (i, reason) in ResponseReason::ALL.iter().enumerate() {
            let focused = i == self.reason;
            let row = y + 1 + u16::try_from(i).unwrap_or(0);
            let text = format!("{} {}", if focused { "▶" } else { " " }, reason.as_str());
            let fg = if focused { Token::Signal } else { Token::Dim };
            pane.put(c, row, &[run(text, fg, Token::Raise)]);
            if focused && !self.note_focus {
                c.cursor(row, pane.x, pane.right);
            }
        }
        let note_row = y + 7;
        let shown = if self.note.is_empty() && !self.note_focus {
            run("optional", Token::Faint, Token::Raise)
        } else {
            run(self.note.clone(), Token::Fg, Token::Raise)
        };
        let label = if self.note_focus {
            bold("note  ", Token::Signal, Token::Raise)
        } else {
            run("note  ", Token::Dim, Token::Raise)
        };
        let mut runs = vec![label, shown];
        if self.note_focus {
            runs.push(run("█", Token::Fg, Token::Raise));
        }
        pane.put(c, note_row, &runs);
        if self.note_focus {
            c.cursor(note_row, pane.x, pane.right);
        }
        pane.put(
            c,
            y + 9,
            &[run(
                "never changes posture, budgets, rules or suppressions",
                Token::Faint,
                Token::Raise,
            )],
        );
    }
}

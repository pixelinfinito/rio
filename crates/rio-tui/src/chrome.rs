//! The header bar (row 0) and the key bar (last row) every screen shares.

use crate::{
    canvas::{Canvas, Run, bold, run},
    theme::Token,
};

/// The two boards of the handoff draw the logo with different spacing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Board {
    /// `review` and `init` (v0.2 boards).
    V2,
    /// `qa`, `team` and `guide` (v0.3 boards).
    V3,
}

const LOGO: &str = " ▃▅▇▇▇▅▃▃▁▁▁▃ ";

/// A status segment at the right of the header.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Status {
    pub text: String,
    pub fg: Token,
    pub bold: bool,
}

pub fn status(text: impl Into<String>, fg: Token) -> Status {
    Status {
        text: text.into(),
        fg,
        bold: true,
    }
}

pub fn quiet(text: impl Into<String>) -> Status {
    Status {
        text: text.into(),
        fg: Token::Faint,
        bold: false,
    }
}

/// Logo, `rio`, the context in `dim`, and status segments right-aligned.
pub fn header(c: &mut Canvas<'_>, board: Board, context: &str, right: &[Status]) {
    // The context gives way to the status segments on narrow terminals.
    let prefix = crate::canvas::width(LOGO) + if board == Board::V2 { 5 } else { 6 };
    // Status segments, the two spaces between them and the trailing space.
    let status = right
        .iter()
        .map(|s| crate::canvas::width(&s.text))
        .sum::<usize>()
        + 2 * right.len().saturating_sub(1)
        + 1;
    // One cell of gap between the context and the status.
    let room = usize::from(c.width()).saturating_sub(prefix + status + 1);
    let context = crate::canvas::fit(context, room);
    let context = context.as_str();
    let mut runs = vec![run(LOGO, Token::Fg, Token::Panel)];
    match board {
        Board::V2 => runs.push(bold("rio", Token::Fg, Token::Panel)),
        Board::V3 => runs.push(bold(" rio", Token::Fg, Token::Panel)),
    }
    runs.push(run("  ", Token::Fg, Token::Panel));
    runs.push(run(context, Token::Dim, Token::Panel));
    c.row(0, &runs, Token::Panel);
    let mut segments = Vec::new();
    for (i, s) in right.iter().enumerate() {
        if i > 0 {
            segments.push(run("  ", Token::Fg, Token::Panel));
        }
        segments.push(Run {
            text: s.text.clone(),
            fg: s.fg,
            bg: Token::Panel,
            bold: s.bold,
        });
    }
    segments.push(run(" ", Token::Fg, Token::Panel));
    let right_edge = c.width();
    c.put_right(right_edge, 0, &segments);
}

/// One key of the key bar.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Key {
    pub key: &'static str,
    pub label: &'static str,
    /// The key the screen is about, drawn as a chip on `signal`.
    pub focus: bool,
}

pub const fn key(key: &'static str, label: &'static str) -> Key {
    Key {
        key,
        label,
        focus: false,
    }
}

pub const fn focus(key: &'static str, label: &'static str) -> Key {
    Key {
        key,
        label,
        focus: true,
    }
}

/// The key bar: each key bold, its label faint, two spaces between them.
pub fn keybar(c: &mut Canvas<'_>, keys: &[Key]) {
    let y = c.height().saturating_sub(1);
    let mut runs = vec![run(" ", Token::Fg, Token::Panel)];
    for k in keys {
        if k.focus {
            runs.push(bold(
                format!(" {} {} ", k.key, k.label),
                Token::Bg,
                Token::Signal,
            ));
            runs.push(run(" ", Token::Fg, Token::Panel));
        } else {
            runs.push(bold(k.key, Token::Fg, Token::Panel));
            runs.push(run(format!(" {}  ", k.label), Token::Faint, Token::Panel));
        }
    }
    c.row(y, &runs, Token::Panel);
}

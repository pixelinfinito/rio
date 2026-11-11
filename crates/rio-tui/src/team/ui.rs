//! Drawing helpers the team screens share: clipped panes, rules, wrapping,
//! the footer line and the dimmed backdrop behind a dialog.

use crate::{
    app::{Outcome, Session},
    canvas::{Canvas, Run, fit, run, width},
    chrome::{Board, Status, header},
    theme::Token,
};

/// The header bar with the context cut so it never runs into the status
/// segments on narrow terminals.
pub(crate) fn top(c: &mut Canvas<'_>, context: &str, right: &[Status]) {
    let segments: usize =
        right.iter().map(|s| width(&s.text)).sum::<usize>() + 2 * right.len().saturating_sub(1) + 1;
    let room = usize::from(c.width()).saturating_sub(20 + segments + 1);
    header(c, Board::V3, &fit(context, room), right);
}

/// `text` cut to at most `max` cells without an ellipsis, as a pane edge clips it.
pub(crate) fn clip(text: &str, max: usize) -> String {
    let mut out = String::new();
    let mut used = 0;
    for ch in text.chars() {
        let w = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0);
        if used + w > max {
            break;
        }
        out.push(ch);
        used += w;
    }
    out
}

/// A finding identity as the UI shows it: its first eight characters.
pub(crate) fn short(id: &str) -> &str {
    rio_core::display_id(id)
}

/// `n` as a `u16` cell count, saturating.
pub(crate) fn cells(n: usize) -> u16 {
    u16::try_from(n).unwrap_or(u16::MAX)
}

/// A rectangular region drawn into row by row; text past `right` is clipped
/// and rows at or below `bottom` are dropped.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Pane {
    pub x: u16,
    pub right: u16,
    pub bottom: u16,
}

impl Pane {
    pub fn new(x: u16, right: u16, bottom: u16) -> Self {
        Self { x, right, bottom }
    }

    /// Usable width in cells.
    pub fn width(&self) -> usize {
        usize::from(self.right.saturating_sub(self.x))
    }

    /// Draw `runs` from the left edge of row `y`; returns the next column.
    pub fn put(&self, c: &mut Canvas<'_>, y: u16, runs: &[Run]) -> u16 {
        self.put_at(c, self.x, y, runs)
    }

    /// Draw `runs` from column `x` of row `y`, clipped to the pane.
    pub fn put_at(&self, c: &mut Canvas<'_>, x: u16, y: u16, runs: &[Run]) -> u16 {
        if y >= self.bottom {
            return x;
        }
        let mut x = x;
        for r in runs {
            if x >= self.right {
                break;
            }
            let room = usize::from(self.right - x);
            if width(&r.text) > room {
                let cut = Run {
                    text: clip(&r.text, room),
                    ..r.clone()
                };
                x = c.put(x, y, &cut);
            } else {
                x = c.put(x, y, r);
            }
        }
        x
    }

    /// A horizontal rule across the pane, starting `indent` cells in.
    pub fn rule(&self, c: &mut Canvas<'_>, y: u16, indent: u16) {
        let x = self.x.saturating_add(indent);
        let n = usize::from(self.right.saturating_sub(x));
        self.put_at(c, x, y, &[run("─".repeat(n), Token::Rule, Token::Bg)]);
    }

    /// Whether row `y` is inside the pane.
    pub fn has(&self, y: u16) -> bool {
        y < self.bottom
    }
}

/// The last row screens draw content on (exclusive): the footer sits there.
pub(crate) fn body_bottom(c: &Canvas<'_>) -> u16 {
    c.height().saturating_sub(2)
}

/// A vertical rule at column `x` from row `y0` up to (not including) `y1`.
pub(crate) fn vrule(c: &mut Canvas<'_>, x: u16, y0: u16, y1: u16) {
    if x >= c.width() {
        return;
    }
    for y in y0..y1 {
        c.put(x, y, &run("│", Token::Rule, Token::Bg));
    }
}

/// Greedy word wrap at `max` cells; words longer than a line are cut.
pub(crate) fn wrap(text: &str, max: usize) -> Vec<String> {
    let max = max.max(1);
    let mut lines = Vec::new();
    for source in text.split('\n') {
        let mut line = String::new();
        let mut first = true;
        for word in source.split(' ') {
            let candidate = if first {
                word.to_owned()
            } else {
                format!("{line} {word}")
            };
            if width(&candidate) <= max {
                line = candidate;
            } else if first {
                line = clip(word, max);
            } else {
                lines.push(std::mem::take(&mut line));
                line = clip(word, max);
            }
            first = false;
        }
        lines.push(line);
    }
    lines
}

/// The footer row: the session's last effect outcome when there is one,
/// otherwise the screen's own line.
pub(crate) fn footer(c: &mut Canvas<'_>, session: &Session, own: &[Run]) {
    let y = c.height().saturating_sub(2);
    let pane = Pane::new(0, c.width(), y + 1);
    match &session.notice {
        Some(Outcome::Failed(error)) => {
            pane.put(c, y, &[run(format!(" ✕ {error}"), Token::Fail, Token::Bg)]);
        }
        Some(Outcome::Ok(text)) => {
            pane.put(c, y, &[run(format!(" {text}"), Token::Dim, Token::Bg)]);
        }
        _ => {
            pane.put(c, y, own);
        }
    }
}

/// Redraw rows `y0..y1` faint on `bg`, keeping the cursor row's `raise`, for
/// the backdrop behind a dialog. Without color nothing changes.
pub(crate) fn dim(c: &mut Canvas<'_>, y0: u16, y1: u16) {
    if !c.theme.color {
        return;
    }
    let raise = Token::Raise.color();
    let faint = c.theme.style(Token::Faint, Token::Bg, false);
    let faint_raise = c.theme.style(Token::Faint, Token::Raise, false);
    for y in y0..y1.min(c.height()) {
        for x in 0..c.width() {
            let cell = &mut c.buf[(c.area.x + x, c.area.y + y)];
            let style = if cell.style().bg == Some(raise) {
                faint_raise
            } else {
                faint
            };
            cell.set_style(ratatui::style::Style::reset());
            cell.set_style(style);
        }
    }
}

/// A bordered box on `raise` with a bold title in the top border.
pub(crate) fn dialog(c: &mut Canvas<'_>, x: u16, y: u16, w: u16, h: u16, title: &str) {
    let w = w.min(c.width().saturating_sub(x));
    if w < 4 || h < 2 {
        return;
    }
    let inner = usize::from(w - 2);
    let head = format!("{title} ");
    let used = 2 + width(&head);
    let mut top = vec![run("┌─ ", Token::Signal, Token::Raise)];
    top.push(
        Run::new(
            clip(&head, inner.saturating_sub(2)),
            Token::Fg,
            Token::Raise,
        )
        .bold(),
    );
    top.push(run(
        format!("{}┐", "─".repeat(inner.saturating_sub(used))),
        Token::Signal,
        Token::Raise,
    ));
    c.puts(x, y, &top);
    for row in 1..h - 1 {
        c.fill(y + row, x, x + w, Token::Raise);
        c.put(x, y + row, &run("│ ", Token::Signal, Token::Raise));
        c.put(x + w - 2, y + row, &run(" │", Token::Signal, Token::Raise));
    }
    c.put(
        x,
        y + h - 1,
        &run(
            format!("└{}┘", "─".repeat(inner)),
            Token::Signal,
            Token::Raise,
        ),
    );
}

/// `n` with `one` or `many` after it.
pub(crate) fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// A login with exactly one leading `@`.
pub(crate) fn at(actor: &str) -> String {
    format!("@{}", actor.trim_start_matches('@'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrap_keeps_double_spaces_and_breaks_greedily() {
        assert_eq!(
            wrap(
                "authorization ✕  session.user may be guest; owner never compared",
                35
            ),
            vec![
                "authorization ✕  session.user may",
                "be guest; owner never compared"
            ]
        );
        assert_eq!(wrap("a\nb", 10), vec!["a", "b"]);
        assert_eq!(wrap("", 10), vec![""]);
        assert_eq!(wrap("abcdefghijkl", 4), vec!["abcd"]);
    }

    #[test]
    fn clip_never_exceeds_the_room() {
        assert_eq!(clip("abc", 2), "ab");
        assert_eq!(clip("abc", 0), "");
        assert_eq!(short("8c1e4a9b77"), "8c1e4a9b");
        assert_eq!(short("8c1e"), "8c1e");
    }
}

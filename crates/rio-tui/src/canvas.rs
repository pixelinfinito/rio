//! Drawing on a cell grid.
//!
//! Screens are specified cell for cell, so they are drawn by placing styled
//! runs at exact columns rather than through flowing layout widgets.

use ratatui::{buffer::Buffer, layout::Rect};
use unicode_width::UnicodeWidthStr;

use crate::theme::{Theme, Token};

/// A styled piece of text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Run {
    pub text: String,
    pub fg: Token,
    pub bg: Token,
    pub bold: bool,
}

impl Run {
    pub fn new(text: impl Into<String>, fg: Token, bg: Token) -> Self {
        Self {
            text: text.into(),
            fg,
            bg,
            bold: false,
        }
    }

    pub fn bold(mut self) -> Self {
        self.bold = true;
        self
    }

    pub fn width(&self) -> usize {
        self.text.width()
    }
}

/// Plain text in `fg` on `bg`.
pub fn run(text: impl Into<String>, fg: Token, bg: Token) -> Run {
    Run::new(text, fg, bg)
}

/// Bold text in `fg` on `bg`.
pub fn bold(text: impl Into<String>, fg: Token, bg: Token) -> Run {
    Run::new(text, fg, bg).bold()
}

/// Display width of `text` in cells.
pub fn width(text: &str) -> usize {
    text.width()
}

/// `text` cut to `max` cells, ending in `…` when cut.
pub fn fit(text: &str, max: usize) -> String {
    if text.width() <= max {
        return text.to_owned();
    }
    let mut out = String::new();
    let mut used = 0;
    for c in text.chars() {
        let w = unicode_width::UnicodeWidthChar::width(c).unwrap_or(0);
        if used + w + 1 > max {
            break;
        }
        out.push(c);
        used += w;
    }
    if max > 0 {
        out.push('…');
    }
    out
}

/// `text` padded with spaces (or cut) to exactly `cells` wide.
pub fn pad(text: &str, cells: usize) -> String {
    let text = fit(text, cells);
    let w = text.width();
    format!("{text}{}", " ".repeat(cells.saturating_sub(w)))
}

/// `text` right-aligned in `cells`.
pub fn pad_left(text: &str, cells: usize) -> String {
    let text = fit(text, cells);
    let w = text.width();
    format!("{}{text}", " ".repeat(cells.saturating_sub(w)))
}

pub struct Canvas<'a> {
    pub buf: &'a mut Buffer,
    pub area: Rect,
    pub theme: Theme,
}

impl<'a> Canvas<'a> {
    pub fn new(buf: &'a mut Buffer, area: Rect, theme: Theme) -> Self {
        Self { buf, area, theme }
    }

    pub fn width(&self) -> u16 {
        self.area.width
    }

    pub fn height(&self) -> u16 {
        self.area.height
    }

    /// Fill cells `x0..x1` of row `y` with spaces on `bg`.
    pub fn fill(&mut self, y: u16, x0: u16, x1: u16, bg: Token) {
        let style = self.theme.style(Token::Fg, bg, false);
        for x in x0..x1.min(self.area.width) {
            if y < self.area.height {
                let cell = &mut self.buf[(self.area.x + x, self.area.y + y)];
                cell.set_symbol(" ");
                cell.set_style(style);
            }
        }
    }

    /// Fill the whole canvas with `bg`.
    pub fn clear(&mut self, bg: Token) {
        for y in 0..self.area.height {
            self.fill(y, 0, self.area.width, bg);
        }
    }

    /// Draw `run` at `(x, y)`, clipped to the canvas; returns the next column.
    pub fn put(&mut self, x: u16, y: u16, run: &Run) -> u16 {
        if y >= self.area.height || x >= self.area.width {
            return x;
        }
        let text = self.theme.glyphs.apply(&run.text);
        let style = self.theme.style(run.fg, run.bg, run.bold);
        let room = usize::from(self.area.width - x);
        let (next, _) =
            self.buf
                .set_stringn(self.area.x + x, self.area.y + y, text.as_ref(), room, style);
        next - self.area.x
    }

    /// Draw `runs` one after another from `x`; returns the next column.
    pub fn puts(&mut self, x: u16, y: u16, runs: &[Run]) -> u16 {
        runs.iter().fold(x, |x, run| self.put(x, y, run))
    }

    /// Draw `runs` from column 0 and fill the rest of the row with `bg`.
    pub fn row(&mut self, y: u16, runs: &[Run], bg: Token) {
        let end = self.puts(0, y, runs);
        self.fill(y, end, self.area.width, bg);
    }

    /// Draw `runs` so that they end at column `right` (exclusive).
    pub fn put_right(&mut self, right: u16, y: u16, runs: &[Run]) -> u16 {
        let w: usize = runs.iter().map(Run::width).sum();
        let x = right.saturating_sub(u16::try_from(w).unwrap_or(u16::MAX));
        self.puts(x, y, runs);
        x
    }

    /// Mark the cells `x0..x1` of row `y` as the focused row.
    pub fn cursor(&mut self, y: u16, x0: u16, x1: u16) {
        if self.theme.color || y >= self.area.height {
            return;
        }
        for x in x0..x1.min(self.area.width) {
            let cell = &mut self.buf[(self.area.x + x, self.area.y + y)];
            let style = self.theme.cursor(cell.style());
            cell.set_style(style);
        }
    }
}

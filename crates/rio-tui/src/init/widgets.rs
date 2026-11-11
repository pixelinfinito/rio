//! Drawing helpers the init screens share: panes, headings, radio lists,
//! segmented choices, input fields, gauges and chips.

use crate::{
    canvas::{Canvas, Run, bold, fit, run, width},
    theme::Token,
};

/// The rows the logo block of I1 and I5 draws, as `(column, cells)` runs.
const LOGO: [&[(u16, u16)]; 5] = [
    &[(6, 6)],
    &[(4, 10)],
    &[(2, 4), (12, 6), (24, 2)],
    &[(2, 2), (14, 12)],
    &[(18, 6)],
];

/// The column where the banner text starts, right of the logo.
pub const BANNER_TEXT: u16 = 30;

/// Is the screen tall enough for the logo banner?
pub fn tall(c: &Canvas<'_>) -> bool {
    c.height() >= 32
}

/// The logo at rows `y..y + 5` in `fg`.
pub fn logo(c: &mut Canvas<'_>, y: u16, fg: Token) {
    for (i, row) in LOGO.iter().enumerate() {
        for (x, n) in row.iter() {
            c.put(
                *x,
                y + i as u16,
                &run("█".repeat(usize::from(*n)), fg, Token::Bg),
            );
        }
    }
}

/// The left pane's width: the design's split at 120 columns, scaled below it.
pub fn split(c: &Canvas<'_>, design: u16) -> u16 {
    if c.width() >= 120 {
        design
    } else {
        c.width() * design / 120
    }
}

/// The last row content may use (the hint row sits at `height - 3`).
pub fn content_end(c: &Canvas<'_>) -> u16 {
    c.height().saturating_sub(4)
}

/// The hint row above the key bar.
pub fn hint_row(c: &Canvas<'_>) -> u16 {
    c.height().saturating_sub(3)
}

/// Draw `runs` from `x`, clipped at column `right` with an ellipsis.
pub fn clip(c: &mut Canvas<'_>, x: u16, y: u16, right: u16, runs: &[Run]) -> u16 {
    let mut x = x;
    for r in runs {
        if x >= right {
            break;
        }
        let room = usize::from(right - x);
        if r.width() <= room {
            x = c.put(x, y, r);
        } else {
            let cut = Run {
                text: fit(&r.text, room),
                ..r.clone()
            };
            x = c.put(x, y, &cut);
            break;
        }
    }
    x
}

/// A section heading: faint bold capitals.
pub fn heading(text: impl Into<String>) -> Run {
    bold(text, Token::Faint, Token::Bg)
}

/// A vertical rule at column `x` on rows `from..to`.
pub fn separator(c: &mut Canvas<'_>, x: u16, from: u16, to: u16) {
    for y in from..to {
        c.put(x, y, &run("│", Token::Rule, Token::Bg));
    }
}

/// A horizontal rule across the whole row.
pub fn rule(c: &mut Canvas<'_>, y: u16) {
    let w = usize::from(c.width());
    c.put(0, y, &run("─".repeat(w), Token::Rule, Token::Bg));
}

/// A chip: `text` bold on `signal`, padded to `cells` with one leading space.
pub fn chip(c: &mut Canvas<'_>, x: u16, y: u16, text: &str, cells: usize) -> u16 {
    let body = format!(" {text}");
    let pad = cells.saturating_sub(width(&body));
    c.put(x, y, &run(" ", Token::Bg, Token::Signal));
    let next = c.put(x + 1, y, &bold(text, Token::Bg, Token::Signal));
    c.put(next, y, &run(" ".repeat(pad), Token::Bg, Token::Signal))
}

/// A key hint: the key bold, the label faint.
pub fn key_hint(key: &str, label: &str, bg: Token) -> [Run; 2] {
    [
        bold(key, Token::Fg, bg),
        run(format!(" {label}"), Token::Faint, bg),
    ]
}

/// A gauge of `cells` cells, `done / total` filled in `fg`.
pub fn gauge(c: &mut Canvas<'_>, x: u16, y: u16, cells: u16, done: u64, total: u64, fg: Token) {
    let filled = (u64::from(cells) * done.min(total))
        .checked_div(total)
        .map_or(0, |n| n as u16);
    let next = c.put(x, y, &run("█".repeat(usize::from(filled)), fg, Token::Bg));
    c.put(
        next,
        y,
        &run(
            "░".repeat(usize::from(cells - filled)),
            Token::Rule,
            Token::Bg,
        ),
    );
}

/// Segmented choices from `x`: the selected one bold on `signal`, others dim.
/// Without color the selected one is bracketed so it still reads.
pub fn segments(c: &mut Canvas<'_>, x: u16, y: u16, right: u16, options: &[&str], selected: usize) {
    let mut x = x;
    for (i, option) in options.iter().enumerate() {
        if i > 0 {
            x = clip(c, x, y, right, &[run(" ", Token::Fg, Token::Bg)]);
        }
        let r = if i == selected {
            let text = if c.theme.color {
                format!(" {option} ")
            } else {
                format!("[{option}]")
            };
            bold(text, Token::Bg, Token::Signal)
        } else {
            run(format!(" {option} "), Token::Dim, Token::Bg)
        };
        let start = x;
        x = clip(c, x, y, right, &[r]);
        if i == selected {
            c.cursor(y, start, x);
        }
    }
}

/// A text input of `cells` cells on `bg`: the text, then the caret if shown.
pub fn text_field(
    c: &mut Canvas<'_>,
    x: u16,
    y: u16,
    cells: u16,
    text: &str,
    caret: bool,
    bg: Token,
) {
    let end = x + cells;
    c.fill(y, x, end, bg);
    let room = usize::from(cells.saturating_sub(2));
    // Keep the end of a long value visible: that is where typing goes.
    let shown = if width(text) > room {
        let skip = text.chars().count().saturating_sub(room.saturating_sub(1));
        format!("…{}", text.chars().skip(skip).collect::<String>())
    } else {
        text.to_owned()
    };
    let next = clip(c, x, y, end, &[run(format!(" {shown}"), Token::Fg, bg)]);
    if caret {
        clip(c, next, y, end, &[run("▏", Token::Signal, bg)]);
    }
}

/// A masked input: one bullet per character typed, never the characters.
pub fn masked_field(
    c: &mut Canvas<'_>,
    x: u16,
    y: u16,
    cells: u16,
    chars: usize,
    caret: bool,
    bg: Token,
) {
    let end = x + cells;
    c.fill(y, x, end, bg);
    let room = usize::from(cells.saturating_sub(2));
    let next = clip(
        c,
        x,
        y,
        end,
        &[run(
            format!(" {}", "•".repeat(chars.min(room))),
            Token::Fg,
            bg,
        )],
    );
    if caret {
        clip(c, next, y, end, &[run("▏", Token::Signal, bg)]);
    }
}

/// A radio item's first row: the cursor bar and raised row when focused,
/// `(•)` when chosen, the label, and an optional right-aligned tag.
pub struct Radio<'a> {
    pub label: &'a str,
    pub chosen: bool,
    pub focused: bool,
    pub note: Option<(usize, Run)>,
    pub tag: Option<Run>,
}

pub fn radio(c: &mut Canvas<'_>, y: u16, x: u16, right: u16, item: Radio<'_>) {
    let bg = if item.focused {
        Token::Raise
    } else {
        Token::Bg
    };
    if item.focused {
        c.fill(y, 0, right, bg);
        c.put(0, y, &run("▌", Token::Signal, bg));
    }
    let (mark, mark_fg) = if item.chosen {
        ("(•)", Token::Signal)
    } else {
        ("( )", Token::Faint)
    };
    let label = if item.chosen {
        bold(item.label, Token::Fg, bg)
    } else {
        run(item.label, Token::Dim, bg)
    };
    let mut runs = vec![run(mark, mark_fg, bg), run(" ", Token::Fg, bg), label];
    if let Some((cells, note)) = item.note {
        let used = width(item.label);
        runs.push(run(
            " ".repeat(cells.saturating_sub(used).max(1)),
            Token::Fg,
            bg,
        ));
        runs.push(Run { bg, ..note });
    }
    let tag_width = item.tag.as_ref().map_or(0, |t| t.width() as u16 + 1);
    let end = clip(c, x, y, right.saturating_sub(2 + tag_width), &runs);
    if let Some(tag) = item.tag {
        let at = right.saturating_sub(2 + tag.width() as u16).max(end + 1);
        clip(c, at, y, right, &[Run { bg, ..tag }]);
    }
    if item.focused {
        c.cursor(y, 0, right);
    }
}

/// Words of `text` in lines of at most `cells`.
pub fn wrap(text: &str, cells: usize) -> Vec<String> {
    let mut lines = Vec::new();
    let mut line = String::new();
    for word in text.split_whitespace() {
        if !line.is_empty() && width(&line) + 1 + width(word) > cells {
            lines.push(std::mem::take(&mut line));
        }
        if !line.is_empty() {
            line.push(' ');
        }
        line.push_str(word);
    }
    if !line.is_empty() {
        lines.push(line);
    }
    lines
}

/// `items` joined by ` · ` in lines of at most `cells`.
pub fn wrap_items(items: &[String], cells: usize) -> Vec<String> {
    let mut lines = Vec::new();
    let mut line = String::new();
    for item in items {
        if !line.is_empty() && width(&line) + 3 + width(item) > cells {
            lines.push(std::mem::take(&mut line));
        }
        if !line.is_empty() {
            line.push_str(" · ");
        }
        line.push_str(item);
    }
    if !line.is_empty() {
        lines.push(line);
    }
    lines
}

/// An account id shown as its first and last four characters (`3f9c…a21e`).
pub fn short_id(id: &str) -> String {
    let chars: Vec<char> = id.chars().collect();
    if chars.len() <= 9 {
        return id.to_owned();
    }
    let head: String = chars[..4].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{head}…{tail}")
}

/// Elapsed time as `48s` or `1m48s`.
pub fn clock(secs: u64) -> String {
    if secs < 60 {
        format!("{secs}s")
    } else {
        format!("{}m{:02}s", secs / 60, secs % 60)
    }
}

/// A step's duration as `0.3s` or `1m02s`.
pub fn seconds(secs: f64) -> String {
    if secs < 60.0 {
        format!("{secs:.1}s")
    } else {
        clock(secs as u64)
    }
}

/// The glyph and color of a step or resource state.
pub fn state_glyph(state: crate::init::StepState) -> (&'static str, Token) {
    use crate::init::StepState::*;
    match state {
        Pending => ("○", Token::Faint),
        Running => ("◐", Token::Warn),
        Done => ("✓", Token::Pass),
        Reused => ("↺", Token::Signal),
        Skipped => ("–", Token::Faint),
        Failed => ("✕", Token::Fail),
    }
}

/// The header with the context cut so it never runs into the status segments.
pub fn header(c: &mut Canvas<'_>, context: &str, right: &[crate::chrome::Status]) {
    let used: usize =
        right.iter().map(|s| width(&s.text)).sum::<usize>() + 2 * right.len().saturating_sub(1) + 1;
    // Logo (14), `rio` (3), two spaces, and a space before the status.
    let room = usize::from(c.width()).saturating_sub(19 + used + 1);
    crate::chrome::header(c, crate::chrome::Board::V2, &fit(context, room), right);
}

/// Draw a pane taller than the screen: `draw` paints rows from `top` on a
/// virtual canvas and returns the rows to keep visible; rows `top..=end` of
/// columns `0..right` show the window that contains them.
pub fn scrolled(
    c: &mut Canvas<'_>,
    right: u16,
    top: u16,
    end: u16,
    draw: impl FnOnce(&mut Canvas<'_>) -> (u16, u16),
) {
    use ratatui::{buffer::Buffer, layout::Rect};
    let tall = Rect::new(0, 0, c.width(), 96);
    let mut buf = Buffer::empty(tall);
    let mut virt = Canvas::new(&mut buf, tall, c.theme);
    virt.clear(Token::Bg);
    let (from, to) = draw(&mut virt);
    let visible = end.saturating_sub(top) + 1;
    let offset = if to >= top + visible {
        (to + 1 - visible - top).min(from.saturating_sub(top))
    } else {
        0
    };
    for y in top..=end {
        let src = y + offset;
        if src >= tall.height {
            break;
        }
        for x in 0..right.min(c.width()) {
            let cell = buf[(x, src)].clone();
            c.buf[(c.area.x + x, c.area.y + y)] = cell;
        }
    }
}

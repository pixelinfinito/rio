//! Golden comparison against the design handoff's cell grids
//! (`docs/design/tui-pr-comments/tui/screens/<slug>/`).
//!
//! Text is compared cell for cell with `screen.txt`. Styles are compared with
//! `spans.json` by token: the background of every cell, and the foreground and
//! weight of every non-space cell (a space's foreground is invisible). Rows
//! listed in `tests/deviations/<slug>.json` replace the expected text, for the
//! documented differences such as 8-character finding ids, and are compared by
//! text and background only.

#![allow(dead_code)]

use std::{collections::BTreeMap, path::PathBuf};

use ratatui::{buffer::Buffer, layout::Rect, style::Modifier};
use rio_tui::{App, Screen, Session, Theme, Token};
use serde_json::Value;
use unicode_width::UnicodeWidthStr;

pub fn design(slug: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../docs/design/tui-pr-comments/tui/screens")
        .join(slug)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cell {
    pub symbol: String,
    pub fg: Option<Token>,
    pub bg: Option<Token>,
    pub bold: bool,
}

/// The expected grid of a screen, deviations applied.
/// Deviation rows by row: their text, and whether their backgrounds are compared.
pub type Deviations = BTreeMap<usize, (String, bool)>;

/// Expected rows, and deviation rows: their text, and whether their
/// backgrounds are still compared (`"bg": false` when the cursor row moves).
pub fn expected(slug: &str) -> (Vec<Vec<Cell>>, Deviations) {
    let spans: Value =
        serde_json::from_str(&std::fs::read_to_string(design(slug).join("spans.json")).unwrap())
            .unwrap();
    let mut rows = Vec::new();
    for line in spans["lines"].as_array().unwrap() {
        let mut cells = Vec::new();
        for span in line.as_array().unwrap() {
            let fg = Token::parse(span["fg"].as_str().unwrap());
            let bg = Token::parse(span["bg"].as_str().unwrap());
            let bold = span["bold"].as_bool().unwrap_or(false);
            for c in span["text"].as_str().unwrap().chars() {
                let symbol = c.to_string();
                let w = symbol.width();
                cells.push(Cell {
                    symbol,
                    fg,
                    bg,
                    bold,
                });
                for _ in 1..w {
                    cells.push(Cell {
                        symbol: String::new(),
                        fg,
                        bg,
                        bold,
                    });
                }
            }
        }
        rows.push(cells);
    }
    let text: Vec<String> = std::fs::read_to_string(design(slug).join("screen.txt"))
        .unwrap()
        .lines()
        .map(str::to_owned)
        .collect();
    for (y, row) in text.iter().enumerate() {
        let joined: String = rows[y].iter().map(|c| c.symbol.as_str()).collect();
        assert_eq!(
            &joined, row,
            "{slug}: spans.json and screen.txt disagree on row {y}"
        );
    }
    let mut deviations = BTreeMap::new();
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/deviations")
        .join(format!("{slug}.json"));
    if let Ok(raw) = std::fs::read_to_string(path) {
        let list: Value = serde_json::from_str(&raw).unwrap();
        for d in list.as_array().unwrap() {
            assert!(
                d["reason"].as_str().is_some_and(|r| !r.is_empty()),
                "{slug}: every deviation has a reason"
            );
            deviations.insert(
                d["row"].as_u64().unwrap() as usize,
                (
                    d["text"].as_str().unwrap().to_owned(),
                    d["bg"].as_bool().unwrap_or(true),
                ),
            );
        }
    }
    (rows, deviations)
}

/// The cells of a rendered buffer, wide glyphs followed by empty cells.
pub fn actual(buf: &Buffer) -> Vec<Vec<Cell>> {
    let area = buf.area;
    (0..area.height)
        .map(|y| {
            let mut cells = Vec::new();
            let mut x = 0;
            while x < area.width {
                let cell = &buf[(x, y)];
                let symbol = cell.symbol().to_owned();
                let w = symbol.width().max(1) as u16;
                let style = cell.style();
                let fg = style.fg.and_then(Token::of);
                let bg = style.bg.and_then(Token::of);
                let bold = style.add_modifier.contains(Modifier::BOLD);
                cells.push(Cell {
                    symbol,
                    fg,
                    bg,
                    bold,
                });
                for _ in 1..w {
                    cells.push(Cell {
                        symbol: String::new(),
                        fg,
                        bg,
                        bold,
                    });
                }
                x += w;
            }
            cells
        })
        .collect()
}

fn text(row: &[Cell]) -> String {
    row.iter().map(|c| c.symbol.as_str()).collect()
}

/// Compare `rows` of a rendered buffer with the design; panic with every difference.
pub fn assert_rows(slug: &str, buf: &Buffer, rows: impl IntoIterator<Item = usize>) {
    let (want, deviations) = expected(slug);
    let got = actual(buf);
    let mut problems = Vec::new();
    for y in rows {
        let expected_text = deviations
            .get(&y)
            .map(|(text, _)| text.clone())
            .unwrap_or_else(|| text(&want[y]));
        let actual_text = text(&got[y]);
        if expected_text != actual_text {
            problems.push(format!(
                "row {y:>2} text\n  want |{expected_text}|\n  got  |{actual_text}|"
            ));
            continue;
        }
        let deviated = deviations.contains_key(&y);
        let compare_bg = deviations.get(&y).is_none_or(|(_, bg)| *bg);
        for (x, (w, g)) in want[y].iter().zip(&got[y]).enumerate() {
            if w.symbol.is_empty() {
                continue;
            }
            let mut wrong = Vec::new();
            if compare_bg && w.bg != g.bg {
                wrong.push(format!("bg {:?} != {:?}", w.bg, g.bg));
            }
            if !deviated && !w.symbol.trim().is_empty() {
                if w.fg != g.fg {
                    wrong.push(format!("fg {:?} != {:?}", w.fg, g.fg));
                }
                if w.bold != g.bold {
                    wrong.push(format!("bold {} != {}", w.bold, g.bold));
                }
            }
            if !wrong.is_empty() {
                problems.push(format!(
                    "row {y:>2} col {x:>3} {:?}: {}",
                    w.symbol,
                    wrong.join(", ")
                ));
                break;
            }
        }
    }
    assert!(
        problems.is_empty(),
        "{slug} differs from its design:\n{}",
        problems.join("\n")
    );
}

/// Compare every row.
pub fn assert_screen(slug: &str, buf: &Buffer) {
    let rows = expected(slug).0.len();
    assert_eq!(buf.area.height as usize, rows, "{slug}: height");
    assert_rows(slug, buf, 0..rows);
}

/// Render a screen alone at `cols × rows`.
pub fn render(screen: Box<dyn Screen>, session: Session, cols: u16, rows: u16) -> Buffer {
    render_with(screen, session, cols, rows, Theme::default())
}

pub fn render_with(
    screen: Box<dyn Screen>,
    session: Session,
    cols: u16,
    rows: u16,
    theme: Theme,
) -> Buffer {
    let mut app = App::new(screen, theme);
    app.session = session;
    let area = Rect::new(0, 0, cols, rows);
    let mut buf = Buffer::empty(area);
    app.draw(&mut buf, area);
    buf
}

/// The rendered text, one line per row, for snapshots.
pub fn lines(buf: &Buffer) -> String {
    actual(buf)
        .iter()
        .map(|row| text(row))
        .collect::<Vec<_>>()
        .join("\n")
}

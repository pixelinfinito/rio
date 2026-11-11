//! G2: help and the view map.
//!
//! `?` opens it from any view. The left column is the keymap: the global keys,
//! then the keys of the view it was opened from (those the global keys don't
//! already list), then the movement, action and team keys every view shares.
//! The right column is the navigation graph of every view with the keys that
//! reach them, and the glyph and evidence legend. `/` searches the keys; `?`
//! closes; `:` is left to the app, which opens the palette.

use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use crate::{
    app::{Action, Screen, Session},
    canvas::{Canvas, Run, bold, fit, pad, run},
    chrome::{Board, Key, focus, header, key, keybar, quiet},
    theme::Token,
};

/// A titled group of keys in the keymap.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeySection {
    pub title: &'static str,
    pub keys: &'static [Key],
}

/// The keys every view honours (handled by the app).
pub const GLOBAL_KEYS: &[Key] = &[
    key("?", "this help"),
    key(":", "command palette"),
    key("tab", "next pane"),
    key("1–6", "tabs in rio qa"),
    key("esc", "back one view"),
    key("q", "quit · offers to save"),
    key("^C", "stop, keep partial"),
    key("^C ^C", "kill tools · exit 130"),
];

/// The keymap the views share, global keys first.
pub const KEYMAP: &[KeySection] = &[
    KeySection {
        title: "EVERYWHERE",
        keys: GLOBAL_KEYS,
    },
    KeySection {
        title: "MOVE",
        keys: &[
            key("↑↓ j k", "items"),
            key("←→ h l", "steps · cells"),
            key("[ ]", "prev/next cell"),
            key("/", "search"),
        ],
    },
    KeySection {
        title: "ACT",
        keys: &[
            key("⏎", "open"),
            key("d", "dismiss with reason…"),
            key("e", "open in $EDITOR"),
            key("o", "open evidence"),
            key("y", "copy id / as issue"),
            key("x", "export md · json · sarif"),
        ],
    },
    KeySection {
        title: "TEAM",
        keys: &[
            key("P", "publish preview"),
            key("F", "finding history"),
            key("S", "suppression proposals"),
            key("c", "council detail"),
            key("a", "vendor audit record"),
        ],
    },
];

/// What the help screen shows on its left.
#[derive(Debug, Clone)]
pub struct HelpData {
    /// The title of the view the help was opened from.
    pub view: &'static str,
    /// That view's key bar.
    pub view_keys: &'static [Key],
    /// The shared keymap; the first section is the global keys.
    pub keymap: &'static [KeySection],
}

impl HelpData {
    pub fn new(view: &'static str, view_keys: &'static [Key]) -> Self {
        Self {
            view,
            view_keys,
            keymap: KEYMAP,
        }
    }

    /// The sections in display order: the first keymap section, the view's
    /// own keys not listed there, then the rest of the keymap.
    pub fn sections(&self) -> Vec<(String, Vec<Key>)> {
        let mut out = Vec::new();
        let mut rest = self.keymap.iter();
        let first = rest.next();
        if let Some(s) = first {
            out.push((s.title.to_owned(), s.keys.to_vec()));
        }
        let own: Vec<Key> = self
            .view_keys
            .iter()
            .filter(|k| !first.is_some_and(|s| s.keys.iter().any(|g| g.key == k.key)))
            .copied()
            .collect();
        if !own.is_empty() {
            out.push((format!("THIS VIEW  {}", self.view), own));
        }
        out.extend(rest.map(|s| (s.title.to_owned(), s.keys.to_vec())));
        out
    }
}

/// How a piece of the view map is drawn.
#[derive(Debug, Clone, Copy)]
enum Tone {
    Plain,
    View,
    Edge,
    Line,
    Faint,
    Heading,
    Dim,
    Fail,
    Pass,
    Warn,
}

impl Tone {
    fn run(self, text: &str) -> Run {
        let (fg, strong) = match self {
            Tone::Plain => (Token::Fg, false),
            Tone::View => (Token::Fg, true),
            Tone::Edge => (Token::Signal, false),
            Tone::Line => (Token::Rule, false),
            Tone::Faint => (Token::Faint, false),
            Tone::Heading => (Token::Faint, true),
            Tone::Dim => (Token::Dim, false),
            Tone::Fail => (Token::Fail, false),
            Tone::Pass => (Token::Pass, false),
            Tone::Warn => (Token::Warn, false),
        };
        let r = run(text, fg, Token::Bg);
        if strong { r.bold() } else { r }
    }
}

enum Right {
    Blank,
    Rule,
    Runs(&'static [(&'static str, Tone)]),
}

use Tone::{Dim, Edge, Fail, Faint, Heading, Line, Pass, Plain, View, Warn};

const PAD30: &str = "                              ";
const PAD43: &str = "                                           ";

/// The right column: the view map, then the glyph and evidence legend.
const RIGHT: &[Right] = &[
    Right::Runs(&[(" VIEW MAP", Heading)]),
    Right::Blank,
    Right::Runs(&[
        (" review ", Faint),
        ("─⏎─▶ ", Edge),
        ("Live", View),
        (" ─auto─▶ ", Edge),
        ("Findings", View),
        (" ─x─▶ ", Edge),
        ("Summary", View),
        (" ─q─▶ ", Edge),
        ("exit", Faint),
    ]),
    Right::Runs(&[(PAD30, Plain), ("│ │ │ │", Line)]),
    Right::Runs(&[
        (PAD30, Plain),
        ("│ │ │ └", Line),
        ("─g─▶ ", Edge),
        ("Impact graph", Plain),
    ]),
    Right::Runs(&[
        (PAD30, Plain),
        ("│ │ └──", Line),
        ("─d─▶ ", Edge),
        ("Lineage & feedback", Plain),
    ]),
    Right::Runs(&[
        (PAD30, Plain),
        ("│ └────", Line),
        ("─F─▶ ", Edge),
        ("History", View),
        (" ─S─▶ ", Edge),
        ("Proposals", View),
    ]),
    Right::Runs(&[
        (PAD30, Plain),
        ("└──────", Line),
        ("─⏎─▶ ", Edge),
        ("Finding", View),
        (" ─c─▶ ", Edge),
        ("Council", View),
    ]),
    Right::Runs(&[(PAD43, Plain), ("│", Line)]),
    Right::Runs(&[
        (PAD43, Plain),
        ("└", Line),
        ("─P─▶ ", Edge),
        ("Publish", View),
        (" ─y─▶ ", Edge),
        ("PR", Faint),
    ]),
    Right::Blank,
    Right::Runs(&[
        (" qa     ", Faint),
        ("─▶ ", Edge),
        ("Journeys", View),
        (" ─⏎─▶ ", Edge),
        ("Matrix", View),
        (" ─⏎─▶ ", Edge),
        ("Cell", View),
        (" ─4─▶ ", Edge),
        ("UX", View),
    ]),
    Right::Runs(&[
        ("                    ", Plain),
        ("└", Line),
        ("─i─▶ ", Edge),
        ("init  ", Plain),
        ("└", Line),
        ("─s─▶ ", Edge),
        ("sync", Plain),
    ]),
    Right::Blank,
    Right::Runs(&[
        (" init   ", Faint),
        ("─▶ ", Edge),
        ("Mode", View),
        (" ─⏎─▶ ", Edge),
        ("Configure", View),
        (" ─⏎─▶ ", Edge),
        ("Deploy", View),
        (" ─▶ ", Edge),
        ("Done", View),
    ]),
    Right::Blank,
    Right::Rule,
    Right::Runs(&[(" GLYPHS  readable without color", Heading)]),
    Right::Runs(&[
        (" ●", Fail),
        (" open     ", Dim),
        (" ✓", Pass),
        (" passed   ", Dim),
        (" ✕", Fail),
        (" failed   ", Dim),
        (" ◐", Edge),
        (" running  ", Dim),
        (" ·", Faint),
        (" queued", Dim),
    ]),
    Right::Runs(&[
        (" ▲", Fail),
        (" regress. ", Dim),
        (" ◆", Warn),
        (" dismissed", Dim),
        (" ○", Faint),
        (" unverif. ", Dim),
        (" –", Faint),
        (" skipped  ", Dim),
        (" ▌", Edge),
        (" cursor", Dim),
    ]),
    Right::Blank,
    Right::Runs(&[(" EVIDENCE  strongest first · never a percentage", Heading)]),
    Right::Runs(&[
        (" reproduced    ", Edge),
        ("an experiment fails on head, passes on base", Dim),
    ]),
    Right::Runs(&[
        (" static_proven ", Edge),
        ("a tool or probe measured it", Dim),
    ]),
    Right::Runs(&[
        (" plausible     ", Warn),
        ("verified as possible, not proven", Dim),
    ]),
    Right::Runs(&[
        (" refuted       ", Faint),
        ("never rendered as a finding", Dim),
    ]),
    Right::Blank,
    Right::Runs(&[(" ADVICE", Heading)]),
    Right::Runs(&[(
        " recommendations live in rio qa → 4 UX and never change the exit code",
        Dim,
    )]),
];

/// The right column when it is narrower than the map (under 120 columns):
/// the same graph as one edge list per view, and a shorter legend.
const NARROW: &[Right] = &[
    Right::Runs(&[(" VIEW MAP", Heading)]),
    Right::Blank,
    Right::Runs(&[
        (" review ", Faint),
        ("─⏎─▶ ", Edge),
        ("Live", View),
        (" ─auto─▶ ", Edge),
        ("Findings", View),
    ]),
    Right::Runs(&[
        (" Findings", View),
        (" ─x─▶ ", Edge),
        ("Summary", View),
        (" ─q─▶ ", Edge),
        ("exit", Faint),
    ]),
    Right::Runs(&[("          ─g─▶ ", Edge), ("Impact graph", Plain)]),
    Right::Runs(&[("          ─d─▶ ", Edge), ("Lineage & feedback", Plain)]),
    Right::Runs(&[
        ("          ─F─▶ ", Edge),
        ("History", View),
        (" ─S─▶ ", Edge),
        ("Proposals", View),
    ]),
    Right::Runs(&[
        ("          ─⏎─▶ ", Edge),
        ("Finding", View),
        (" ─c─▶ ", Edge),
        ("Council", View),
    ]),
    Right::Runs(&[
        ("               ", Plain),
        ("Finding", View),
        (" ─P─▶ ", Edge),
        ("Publish", View),
        (" ─y─▶ ", Edge),
        ("PR", Faint),
    ]),
    Right::Blank,
    Right::Runs(&[
        (" qa     ", Faint),
        ("─▶ ", Edge),
        ("Journeys", View),
        (" ─⏎─▶ ", Edge),
        ("Matrix", View),
        (" ─⏎─▶ ", Edge),
        ("Cell", View),
    ]),
    Right::Runs(&[
        ("        ", Plain),
        ("Journeys", View),
        (" ─i─▶ ", Edge),
        ("init", Plain),
    ]),
    Right::Runs(&[
        ("        ", Plain),
        ("Matrix", View),
        (" ─s─▶ ", Edge),
        ("sync", Plain),
    ]),
    Right::Runs(&[
        ("        ", Plain),
        ("Cell", View),
        (" ─4─▶ ", Edge),
        ("UX", View),
    ]),
    Right::Blank,
    Right::Runs(&[
        (" init   ", Faint),
        ("─▶ ", Edge),
        ("Mode", View),
        (" ─⏎─▶ ", Edge),
        ("Configure", View),
        (" ─⏎─▶ ", Edge),
        ("Deploy", View),
    ]),
    Right::Runs(&[
        ("        ", Plain),
        ("Deploy", View),
        (" ─▶ ", Edge),
        ("Done", View),
    ]),
    Right::Blank,
    Right::Rule,
    Right::Runs(&[(" GLYPHS  readable without color", Heading)]),
    Right::Runs(&[
        (" ●", Fail),
        (" open  ", Dim),
        (" ✓", Pass),
        (" passed  ", Dim),
        (" ✕", Fail),
        (" failed  ", Dim),
        (" ◐", Edge),
        (" running", Dim),
    ]),
    Right::Runs(&[
        (" ·", Faint),
        (" queued  ", Dim),
        (" ▲", Fail),
        (" regress.  ", Dim),
        (" ◆", Warn),
        (" dismissed", Dim),
    ]),
    Right::Runs(&[
        (" ○", Faint),
        (" unverif.  ", Dim),
        (" –", Faint),
        (" skipped  ", Dim),
        (" ▌", Edge),
        (" cursor", Dim),
    ]),
    Right::Blank,
    Right::Runs(&[(" EVIDENCE  never a percentage", Heading)]),
    Right::Runs(&[
        (" reproduced    ", Edge),
        ("fails on head, passes on base", Dim),
    ]),
    Right::Runs(&[
        (" static_proven ", Edge),
        ("a tool or probe measured it", Dim),
    ]),
    Right::Runs(&[(" plausible     ", Warn), ("possible, not proven", Dim)]),
    Right::Runs(&[
        (" refuted       ", Faint),
        ("never shown as a finding", Dim),
    ]),
    Right::Blank,
    Right::Runs(&[(" ADVICE", Heading)]),
    Right::Runs(&[(" rio qa → 4 UX · never changes the exit code", Dim)]),
];

/// The widest row of [`RIGHT`].
const MAP_WIDTH: u16 = 75;

const KEYS: &[Key] = &[
    focus("?", "close"),
    key("/", "search keys"),
    key(":", "palette"),
];

const SEARCH_KEYS: &[Key] = &[
    key("type", "search keys"),
    focus("⏎", "keep"),
    key("esc", "clear"),
];

pub struct Help {
    pub data: HelpData,
    /// The search field has focus.
    pub searching: bool,
    /// Only keys whose key or label contain this (case-insensitive) are listed.
    pub query: String,
}

impl Help {
    pub fn new(data: HelpData) -> Self {
        Self {
            data,
            searching: false,
            query: String::new(),
        }
    }

    fn matches(&self, k: &Key) -> bool {
        let q = self.query.to_lowercase();
        q.is_empty() || k.key.to_lowercase().contains(&q) || k.label.to_lowercase().contains(&q)
    }
}

/// A key action that is not `Action::None`, so `esc` is not taken as "back".
fn handled() -> Action {
    Action::Many(Vec::new())
}

impl Screen for Help {
    fn title(&self) -> &'static str {
        "Help"
    }
    fn board(&self) -> Board {
        Board::V3
    }
    fn keys(&self) -> &'static [Key] {
        if self.searching { SEARCH_KEYS } else { KEYS }
    }
    fn draw(&self, c: &mut Canvas<'_>, _: &Session) {
        c.clear(Token::Bg);
        header(c, Board::V3, "help", &[quiet("? closes")]);
        let width = c.width();
        let lw = width.saturating_sub(76).clamp(34, 44);
        let last = c.height().saturating_sub(3);
        for y in 1..=last {
            c.put(lw, y, &run("│", Token::Rule, Token::Bg));
        }

        // Left: the keymap.
        let mut y = 2;
        let label = usize::from(lw).saturating_sub(11);
        let sections: Vec<(String, Vec<Key>)> = self
            .data
            .sections()
            .into_iter()
            .map(|(t, keys)| (t, keys.into_iter().filter(|k| self.matches(k)).collect()))
            .filter(|(_, keys): &(String, Vec<Key>)| !keys.is_empty())
            .collect();
        if sections.is_empty() {
            c.put(0, y, &run(" no key matches", Token::Faint, Token::Bg));
        }
        for (i, (title, keys)) in sections.iter().enumerate() {
            if i > 0 {
                y += 1;
            }
            if y > last {
                break;
            }
            c.put(
                0,
                y,
                &bold(
                    format!(" {}", fit(title, usize::from(lw) - 2)),
                    Token::Faint,
                    Token::Bg,
                ),
            );
            y += 1;
            for k in keys {
                if y > last {
                    break;
                }
                c.put(
                    0,
                    y,
                    &bold(format!(" {}", pad(k.key, 9)), Token::Fg, Token::Bg),
                );
                c.put(10, y, &run(fit(k.label, label), Token::Dim, Token::Bg));
                y += 1;
            }
        }

        // Right: the view map and the legend.
        let right = if width.saturating_sub(lw + 1) < MAP_WIDTH {
            NARROW
        } else {
            RIGHT
        };
        for (i, row) in right.iter().enumerate() {
            let y = 2 + i as u16;
            if y > last {
                break;
            }
            match row {
                Right::Blank => {}
                Right::Rule => {
                    let rule = format!("│{}", "─".repeat(usize::from(width - lw - 1)));
                    c.put(lw, y, &run(rule, Token::Rule, Token::Bg));
                }
                Right::Runs(runs) => {
                    let runs: Vec<Run> = runs.iter().map(|(t, tone)| tone.run(t)).collect();
                    c.puts(lw + 1, y, &runs);
                }
            }
        }

        // The search field, or the hint.
        let y = c.height().saturating_sub(2);
        if self.searching || !self.query.is_empty() {
            let x = c.put(0, y, &bold(" / ", Token::Fg, Token::Bg));
            let room = usize::from(width).saturating_sub(5);
            let x = c.put(x, y, &run(fit(&self.query, room), Token::Fg, Token::Bg));
            if self.searching {
                c.put(x, y, &run("█", Token::Fg, Token::Bg));
            }
        } else {
            let hint = " every key here also appears in the bottom bar of the view that uses it";
            c.put(
                0,
                y,
                &run(fit(hint, usize::from(width)), Token::Faint, Token::Bg),
            );
        }
        keybar(c, self.keys());
    }
    fn on_key(&mut self, key: KeyEvent, _: &mut Session) -> Action {
        if self.searching {
            match key.code {
                KeyCode::Esc => {
                    self.searching = false;
                    self.query.clear();
                }
                KeyCode::Enter => self.searching = false,
                KeyCode::Backspace => {
                    self.query.pop();
                }
                KeyCode::Char(ch) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                    self.query.push(ch);
                }
                _ => {}
            }
            return handled();
        }
        match key.code {
            KeyCode::Char('?') => Action::Pop,
            KeyCode::Char('/') => {
                self.searching = true;
                handled()
            }
            KeyCode::Esc if !self.query.is_empty() => {
                self.query.clear();
                handled()
            }
            KeyCode::Esc => Action::Pop,
            _ => Action::None,
        }
    }
    fn wants_text(&self) -> bool {
        self.searching
    }
}

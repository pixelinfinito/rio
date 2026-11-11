//! The shell every screen shares: global keys, interruption, size, theme and chrome.

mod common;

use std::sync::atomic::{AtomicBool, Ordering};

use ratatui::crossterm::event::{KeyCode, KeyEvent};
use rio_tui::{
    Action, App, Effect, Msg, Screen, Session, Theme, Token,
    app::{ctrl, press},
    canvas::Canvas,
    chrome::{Board, Key, focus, header, key, keybar, quiet, status},
};

/// A screen with a text field and the chrome of a design screen.
struct Probe {
    slug: &'static str,
    board: Board,
    context: &'static str,
    right: Vec<(&'static str, Token, bool)>,
    keys: &'static [Key],
    text: bool,
    typed: String,
}

impl Probe {
    fn new(keys: &'static [Key]) -> Self {
        Self {
            slug: "",
            board: Board::V2,
            context: "",
            right: vec![],
            keys,
            text: false,
            typed: String::new(),
        }
    }
}

impl Screen for Probe {
    fn title(&self) -> &'static str {
        "Probe"
    }
    fn board(&self) -> Board {
        self.board
    }
    fn keys(&self) -> &'static [Key] {
        self.keys
    }
    fn draw(&self, c: &mut Canvas<'_>, _: &Session) {
        c.clear(Token::Bg);
        let right: Vec<_> = self
            .right
            .iter()
            .map(|(t, fg, b)| if *b { status(*t, *fg) } else { quiet(*t) })
            .collect();
        header(c, self.board, self.context, &right);
        keybar(c, self.keys);
        let _ = self.slug;
    }
    fn on_key(&mut self, key: KeyEvent, _: &mut Session) -> Action {
        if let KeyCode::Char(c) = key.code {
            self.typed.push(c);
        }
        Action::None
    }
    fn wants_text(&self) -> bool {
        self.text
    }
}

const FINDINGS: &[Key] = &[
    key("↑↓", "move"),
    key("⏎", "open"),
    key("d", "dismiss"),
    key("g", "graph"),
    key("f", "filter"),
    key("tab", "pane"),
    key("x", "export"),
    key("?", "help"),
    key("q", "quit"),
];

#[test]
fn chrome_matches_the_v2_and_v3_boards() {
    let review = Probe {
        slug: "review-02-findings",
        board: Board::V2,
        context: "feature/parser-guards → origin/main · rio/openrouter · standard",
        right: vec![
            ("✕ exit 1 · 2 fail", Token::Fail, true),
            ("2m14s", Token::Faint, false),
        ],
        ..Probe::new(FINDINGS)
    };
    let buf = common::render(Box::new(review), Session::default(), 120, 40);
    common::assert_rows("review-02-findings", &buf, [0, 39]);

    const JOURNEYS: &[Key] = &[
        key("↑↓", "move"),
        key("space", "select"),
        focus("⏎", "run"),
        key("a", "--full"),
        key("b", "baseline"),
        key("s", "sync"),
        key("i", "init"),
        key("v", "validate"),
        key("?", "help"),
        key("q", "quit"),
    ];
    let qa = Probe {
        board: Board::V3,
        context: "qa · shop-demo · .rio/qa.yaml · changed mode",
        right: vec![
            ("◐ sync: 2 need review", Token::Warn, true),
            ("docker · pod", Token::Faint, false),
        ],
        ..Probe::new(JOURNEYS)
    };
    let buf = common::render(Box::new(qa), Session::default(), 120, 40);
    common::assert_rows("qa-q1-journeys", &buf, [0, 39]);

    const PUBLISH: &[Key] = &[
        focus("y", "publish"),
        key("n", "keep local"),
        key("e", "edit selection"),
        key("↑↓", "preview item"),
        key("esc", "back"),
    ];
    let team = Probe {
        board: Board::V3,
        context: "review · PR #142 · publish: ask",
        right: vec![
            ("awaiting your answer", Token::Warn, true),
            ("round 2/3", Token::Faint, false),
        ],
        ..Probe::new(PUBLISH)
    };
    let buf = common::render(Box::new(team), Session::default(), 120, 40);
    common::assert_rows("team-p2-publish-preview", &buf, [0, 39]);
}

#[test]
fn every_design_color_is_a_theme_token() {
    let screens = std::fs::read_dir(common::design("").parent().unwrap().join("screens")).unwrap();
    for entry in screens {
        let spans: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(entry.unwrap().path().join("spans.json")).unwrap(),
        )
        .unwrap();
        for line in spans["lines"].as_array().unwrap() {
            for span in line.as_array().unwrap() {
                for key in ["fg", "bg"] {
                    let name = span[key].as_str().unwrap();
                    assert!(Token::parse(name).is_some(), "{name} has no token");
                }
            }
        }
    }
    let tokens: serde_json::Value = serde_json::from_str(include_str!(
        "../../../docs/design/tui-pr-comments/tui/tokens.json"
    ))
    .unwrap();
    for (name, hex) in tokens["colors"].as_object().unwrap() {
        let token = Token::parse(name).unwrap();
        let (r, g, b) = token.rgb();
        assert_eq!(
            format!("#{r:02X}{g:02X}{b:02X}"),
            hex.as_str().unwrap(),
            "{name}"
        );
    }
}

#[test]
fn no_color_draws_no_color_and_marks_the_cursor_by_reverse_video() {
    let theme = Theme {
        color: false,
        ..Theme::default()
    };
    let buf = common::render_with(
        Box::new(Probe::new(FINDINGS)),
        Session::default(),
        80,
        24,
        theme,
    );
    for cell in buf.content() {
        assert_eq!(cell.style().fg, Some(ratatui::style::Color::Reset));
        assert_eq!(cell.style().bg, Some(ratatui::style::Color::Reset));
    }
    let style = theme.cursor(theme.style(Token::Fg, Token::Raise, false));
    assert!(
        style
            .add_modifier
            .contains(ratatui::style::Modifier::REVERSED)
    );
}

#[test]
fn ascii_glyphs_keep_every_row_the_terminal_width() {
    let theme = Theme {
        glyphs: rio_core::glyphs::GlyphSet::Ascii,
        ..Theme::default()
    };
    let review = Probe {
        context: "feature/parser-guards → origin/main · rio/openrouter · standard",
        right: vec![("✕ exit 1 · 2 fail", Token::Fail, true)],
        ..Probe::new(FINDINGS)
    };
    let buf = common::render_with(Box::new(review), Session::default(), 120, 40, theme);
    let text = common::lines(&buf);
    assert!(text.is_ascii(), "{text}");
    assert!(text.lines().all(|line| line.len() == 120));
    assert!(
        text.lines()
            .next()
            .unwrap()
            .starts_with(" -=###=--___- rio  feature/parser-guards > origin/main . ")
    );
}

#[test]
fn the_minimum_size_is_80_by_24() {
    let fits = common::render(Box::new(Probe::new(FINDINGS)), Session::default(), 80, 24);
    insta::assert_snapshot!("probe_80x24", common::lines(&fits));
    let small = common::render(Box::new(Probe::new(FINDINGS)), Session::default(), 79, 24);
    insta::assert_snapshot!("too_small_79x24", common::lines(&small));
    assert!(common::lines(&small).contains("rio needs at least 80×24 cells"));
    assert!(common::lines(&small).contains("this terminal is 79×24"));
}

#[test]
fn a_focused_text_field_takes_q_and_other_global_keys() {
    let mut app = App::new(
        Box::new(Probe {
            text: true,
            ..Probe::new(FINDINGS)
        }),
        Theme::default(),
    );
    for c in ['q', '?', ':'] {
        assert!(app.update(press(KeyCode::Char(c))).is_empty());
    }
    assert!(!app.done);
    assert_eq!(app.stack.len(), 1);
}

#[test]
fn quitting_offers_to_save_an_unsaved_report() {
    let mut app = App::new(Box::new(Probe::new(FINDINGS)), Theme::default());
    // Nothing to save: q quits.
    assert_eq!(app.update(press(KeyCode::Char('q'))), vec![Effect::Quit]);
    assert!(app.done);

    let mut app = App::new(Box::new(Probe::new(FINDINGS)), Theme::default());
    app.session.report = Some(
        serde_json::from_str(include_str!("../../rio-core/tests/fixtures/complete.json")).unwrap(),
    );
    assert!(app.update(press(KeyCode::Char('q'))).is_empty());
    assert_eq!(app.top().title(), "Quit");
    // Cancel returns to the screen and nothing was written.
    app.update(press(KeyCode::Down));
    app.update(press(KeyCode::Down));
    assert!(app.update(press(KeyCode::Enter)).is_empty());
    assert_eq!(app.top().title(), "Probe");
    // Save and quit exports first.
    app.update(press(KeyCode::Char('q')));
    assert_eq!(
        app.update(press(KeyCode::Enter)),
        vec![
            Effect::Export {
                format: "md".into(),
                path: "report.md".into()
            },
            Effect::Quit
        ]
    );
    assert!(app.done);
}

#[test]
fn ctrl_c_cancels_once_and_kills_on_the_second_press() {
    let mut app = App::new(Box::new(Probe::new(FINDINGS)), Theme::default());
    assert_eq!(app.update(ctrl('c')), vec![Effect::Cancel]);
    assert!(app.session.interrupted && !app.done);
    assert_eq!(app.update(ctrl('c')), vec![Effect::Kill]);
    assert!(app.done);
    // A text field never swallows Ctrl-C.
    let mut app = App::new(
        Box::new(Probe {
            text: true,
            ..Probe::new(FINDINGS)
        }),
        Theme::default(),
    );
    assert_eq!(app.update(ctrl('c')), vec![Effect::Cancel]);
}

#[test]
fn esc_goes_back_and_ticks_count() {
    let mut app = App::new(Box::new(Probe::new(FINDINGS)), Theme::default());
    app.stack.push(Box::new(Probe::new(FINDINGS)));
    app.update(press(KeyCode::Esc));
    assert_eq!(app.stack.len(), 1);
    app.update(press(KeyCode::Esc));
    assert_eq!(app.stack.len(), 1, "the first screen stays");
    app.update(Msg::Tick);
    assert_eq!(app.session.ticks, 1);
}

static RESTORED: AtomicBool = AtomicBool::new(false);

#[test]
fn a_panic_restores_the_terminal_before_it_reports() {
    rio_tui::terminal::restore_on_panic(|| RESTORED.store(true, Ordering::SeqCst));
    let result = std::panic::catch_unwind(|| {
        let mut app = App::new(Box::new(Panics), Theme::default());
        let area = ratatui::layout::Rect::new(0, 0, 80, 24);
        app.draw(&mut ratatui::buffer::Buffer::empty(area), area);
        app.update(Msg::Tick);
    });
    assert!(result.is_err());
    assert!(RESTORED.load(Ordering::SeqCst));
}

struct Panics;
impl Screen for Panics {
    fn title(&self) -> &'static str {
        "Panics"
    }
    fn keys(&self) -> &'static [Key] {
        &[]
    }
    fn draw(&self, _: &mut Canvas<'_>, _: &Session) {
        panic!("drawing failed");
    }
    fn on_key(&mut self, _: KeyEvent, _: &mut Session) -> Action {
        Action::None
    }
}

#[test]
fn replay_closes_the_top_screen_and_presses_the_key_below() {
    struct Palette;
    impl Screen for Palette {
        fn title(&self) -> &'static str {
            "Command palette"
        }
        fn keys(&self) -> &'static [Key] {
            &[]
        }
        fn draw(&self, _: &mut Canvas<'_>, _: &Session) {}
        fn on_key(&mut self, _: KeyEvent, _: &mut Session) -> Action {
            Action::Replay(KeyEvent::new(
                KeyCode::Char('x'),
                ratatui::crossterm::event::KeyModifiers::NONE,
            ))
        }
        fn wants_text(&self) -> bool {
            true
        }
    }
    let mut app = App::new(Box::new(Probe::new(FINDINGS)), Theme::default());
    app.stack.push(Box::new(Palette));
    app.update(press(KeyCode::Enter));
    assert_eq!(app.stack.len(), 1);
    assert_eq!(app.top().title(), "Probe");
}

#[test]
fn a_message_for_the_screen_below_closes_help() {
    let mut app = App::new(Box::new(Probe::new(FINDINGS)), Theme::default());
    app.globals = Some(rio_tui::app::Globals {
        help: |_, _| Box::new(Overlay("Help")),
        palette: |_, _| Box::new(Overlay("Command palette")),
    });
    app.update(press(KeyCode::Char('?')));
    assert_eq!(app.top().title(), "Help");
    app.update(Msg::Tick);
    assert_eq!(app.top().title(), "Help", "the clock does not close help");
    app.update(Msg::Done(rio_tui::Outcome::Ok("saved".into())));
    assert_eq!(app.top().title(), "Probe");
}

#[test]
fn a_long_context_never_runs_into_the_status() {
    let review = Probe {
        context: "feature/a-very-long-branch-name-that-goes-on → origin/main · rio/openrouter · standard",
        right: vec![
            ("◐ running · agents 3/5", Token::Warn, true),
            ("0m48s", Token::Faint, false),
        ],
        ..Probe::new(FINDINGS)
    };
    let buf = common::render(Box::new(review), Session::default(), 80, 24);
    let first = common::lines(&buf).lines().next().unwrap().to_owned();
    assert!(first.ends_with("◐ running · agents 3/5  0m48s "), "{first}");
    assert!(first.contains("…"), "{first}");
}

struct Overlay(&'static str);
impl Screen for Overlay {
    fn title(&self) -> &'static str {
        self.0
    }
    fn keys(&self) -> &'static [Key] {
        &[]
    }
    fn draw(&self, _: &mut Canvas<'_>, _: &Session) {}
    fn on_key(&mut self, _: KeyEvent, _: &mut Session) -> Action {
        Action::None
    }
}

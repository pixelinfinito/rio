#![cfg(feature = "guide")]
//! The `guide` flow: the command palette (G1) and help with the view map (G2).

mod common;

use ratatui::{
    buffer::Buffer,
    crossterm::event::{KeyCode, KeyEvent},
    layout::Rect,
    style::Modifier,
};
use rio_tui::{
    Action, App, Effect, Screen, Session, Theme, Token,
    app::press,
    canvas::{Canvas, run},
    chrome::{Key, header, key, keybar},
    guide::{self, Command, Palette, PaletteData},
};

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

/// A view whose `x` opens an "Export" screen, like the findings screen.
struct Probe;

impl Screen for Probe {
    fn title(&self) -> &'static str {
        "Findings"
    }
    fn keys(&self) -> &'static [Key] {
        FINDINGS
    }
    fn draw(&self, c: &mut Canvas<'_>, _: &Session) {
        c.clear(Token::Bg);
        header(c, rio_tui::chrome::Board::V2, "findings", &[]);
        for y in [2, 30] {
            c.put(
                1,
                y,
                &rio_tui::canvas::bold("● 8c1e null deref parseHeader", Token::Fg, Token::Bg),
            );
        }
        keybar(c, FINDINGS);
    }
    fn on_key(&mut self, key: KeyEvent, _: &mut Session) -> Action {
        match key.code {
            KeyCode::Char('x') => Action::Push(Box::new(Export)),
            _ => Action::None,
        }
    }
}

struct Export;

impl Screen for Export {
    fn title(&self) -> &'static str {
        "Export"
    }
    fn keys(&self) -> &'static [Key] {
        &[]
    }
    fn draw(&self, _: &mut Canvas<'_>, _: &Session) {}
    fn on_key(&mut self, _: KeyEvent, _: &mut Session) -> Action {
        Action::None
    }
}

fn app() -> App {
    let mut app = App::new(Box::new(Probe), Theme::default());
    app.globals = Some(guide::globals());
    app
}

fn typing(app: &mut App, text: &str) -> Vec<Effect> {
    text.chars()
        .flat_map(|c| app.update(press(KeyCode::Char(c))))
        .collect()
}

/// The commands G1 shows: the handoff's recent commands, grouped by job.
fn design_commands() -> Vec<Command> {
    [
        (
            "QA",
            "rio qa --journey checkout",
            "run one journey · last failed",
        ),
        ("QA", "rio qa --full", "every journey, every cell"),
        ("QA", "rio qa sync --check", "journeys that need review"),
        ("QA", "rio qa init", "agent authors from REVIEW.md"),
        ("QA", "rio qa seed build", "rebuild the seed snapshot"),
        (
            "REVIEW",
            "rio review --since-last",
            "next round of this lineage",
        ),
        (
            "REVIEW",
            "rio review --pr 142 --publish",
            "hosted review of a PR",
        ),
        ("REVIEW", "rio review --deep", "more agents, larger budget"),
        ("TEAM", "rio findings --status open", "the finding registry"),
        ("TEAM", "rio suppressions list", "proposals from dismissals"),
        ("SETUP", "rio doctor", "tools, roots, cache, app"),
        ("SETUP", "rio deploy", "upgrade the paired Worker"),
    ]
    .into_iter()
    .map(|(job, cli, about)| Command::new(job, cli, about))
    .collect()
}

fn design_palette() -> Palette {
    Palette::new(PaletteData {
        view: "Findings",
        view_keys: FINDINGS,
        commands: design_commands(),
    })
}

/// Paint the design's own grid (everything behind the palette) into `buf`.
fn paint_design(slug: &str, buf: &mut Buffer) {
    let spans: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(common::design(slug).join("spans.json")).unwrap(),
    )
    .unwrap();
    let area = buf.area;
    let mut c = Canvas::new(buf, area, Theme::default());
    for (y, line) in spans["lines"].as_array().unwrap().iter().enumerate() {
        let mut x = 0;
        for span in line.as_array().unwrap() {
            let fg = Token::parse(span["fg"].as_str().unwrap()).unwrap();
            let bg = Token::parse(span["bg"].as_str().unwrap()).unwrap();
            let mut r = run(span["text"].as_str().unwrap(), fg, bg);
            r.bold = span["bold"].as_bool().unwrap_or(false);
            x = c.put(x, y as u16, &r);
        }
    }
}

// G1 is drawn over the findings view, which this module cannot draw: the
// golden paints the design's grid first (header, the dimmed findings behind
// the box) and then the palette's own cells, so every row is compared and the
// palette is responsible for the box (rows 5–29, columns 20–99) and the key
// bar (row 39). Row 6 is a declared deviation: the design shows `q` typed in
// the filter yet lists REVIEW, TEAM and SETUP commands that do not contain a
// `q`; the palette filters as the user types (spec: "filtered as the user
// types"), so the golden is the palette as opened, with an empty filter.
#[test]
fn g1_command_palette_matches_the_design() {
    let slug = "guide-g1-command-palette";
    let area = Rect::new(0, 0, 120, 40);
    let mut buf = Buffer::empty(area);
    paint_design(slug, &mut buf);
    // Clear the box and the key bar so the palette has to draw them.
    for y in 5..30 {
        for x in 20..100 {
            buf[(x, y)].reset();
        }
    }
    for x in 0..120 {
        buf[(x, 39)].reset();
    }
    let palette = design_palette();
    palette.draw_overlay(&mut Canvas::new(&mut buf, area, Theme::default()));
    common::assert_screen(slug, &buf);
}

#[test]
fn g2_help_view_map_matches_the_design() {
    // Opened from a view whose keys are all global keys, so the left column is
    // the shared keymap alone, as designed.
    const JOURNEY: &[Key] = &[key("?", "help"), key("q", "quit")];
    let buf = common::render(
        guide::help("Journeys", JOURNEY),
        Session::default(),
        120,
        40,
    );
    common::assert_screen("guide-g2-help-view-map", &buf);
}

#[test]
fn palette_filter_lists_export_first_and_enter_opens_the_export_screen() {
    let mut app = app();
    assert!(app.update(press(KeyCode::Char(':'))).is_empty());
    assert_eq!(app.top().title(), "Command palette");
    assert!(app.top().wants_text());
    assert!(typing(&mut app, "exp").is_empty());
    let mut buf = Buffer::empty(Rect::new(0, 0, 120, 40));
    let area = buf.area;
    app.draw(&mut buf, area);
    let text = common::lines(&buf);
    let rows: Vec<&str> = text.lines().collect();
    assert!(rows[8].contains("THIS VIEW  Findings"), "{text}");
    assert!(
        rows[9].contains("▌ export") && rows[9].contains("key x"),
        "{text}"
    );
    assert!(text.contains("rio qa seed export"), "{text}");
    assert!(!text.contains("rio doctor"), "{text}");
    // ⏎ closes the palette and presses `x` on the findings view.
    assert!(app.update(press(KeyCode::Enter)).is_empty());
    assert_eq!(app.top().title(), "Export");
    assert_eq!(app.stack.len(), 2);
}

#[test]
fn the_palette_floats_over_the_faded_screen_it_was_opened_from() {
    let mut app = app();
    app.update(press(KeyCode::Char(':')));
    let mut buf = Buffer::empty(Rect::new(0, 0, 120, 40));
    let area = buf.area;
    app.draw(&mut buf, area);
    let text = common::lines(&buf);
    let rows: Vec<&str> = text.lines().collect();
    // The findings view shows above and below the box, faded.
    assert!(rows[2].contains("● 8c1e null deref parseHeader"), "{text}");
    assert!(rows[30].contains("● 8c1e null deref parseHeader"), "{text}");
    let faint = Theme::default().style(Token::Faint, Token::Bg, false).fg;
    assert_eq!(buf[(3, 2)].fg, faint.unwrap());
    assert!(
        !buf[(3, 2)]
            .modifier
            .contains(ratatui::style::Modifier::BOLD)
    );
    // The header is the screen's own, the box and key bar the palette's.
    assert!(rows[0].contains("rio"), "{text}");
    assert!(text.contains("command palette"), "{text}");
    assert!(rows[39].contains("esc close"), "{text}");
}

#[test]
fn enter_on_a_command_copies_its_line_and_shows_it() {
    let mut app = app();
    app.update(press(KeyCode::Char(':')));
    typing(&mut app, "qa full");
    assert_eq!(
        app.update(press(KeyCode::Enter)),
        vec![Effect::Copy("rio qa --full".into())]
    );
    assert_eq!(app.top().title(), "Command palette");
    let mut buf = Buffer::empty(Rect::new(0, 0, 120, 40));
    let area = buf.area;
    app.draw(&mut buf, area);
    assert!(common::lines(&buf).contains("copied  rio qa --full"));
}

#[test]
fn moving_picks_the_next_command() {
    let mut app = App::new(Box::new(design_palette()), Theme::default());
    app.update(press(KeyCode::Down));
    app.update(press(KeyCode::Down));
    app.update(press(KeyCode::Up));
    assert_eq!(
        app.update(press(KeyCode::Enter)),
        vec![Effect::Copy("rio qa --full".into())]
    );
}

#[test]
fn tab_puts_the_command_line_in_the_filter_for_editing() {
    let mut app = app();
    app.update(press(KeyCode::Char(':')));
    typing(&mut app, "journey");
    app.update(press(KeyCode::Tab));
    for _ in 0.."checkout".len() {
        app.update(press(KeyCode::Backspace));
    }
    typing(&mut app, "login");
    assert_eq!(
        app.update(press(KeyCode::Enter)),
        vec![Effect::Copy("rio qa --journey login".into())]
    );
}

#[test]
fn esc_closes_the_palette_and_q_is_typed_not_quit() {
    let mut app = app();
    app.update(press(KeyCode::Char(':')));
    assert!(app.update(press(KeyCode::Char('q'))).is_empty());
    assert!(!app.done);
    assert_eq!(app.top().title(), "Command palette");
    // `?` and `:` are text too.
    typing(&mut app, "?:");
    assert_eq!(app.stack.len(), 2);
    assert!(app.update(press(KeyCode::Esc)).is_empty());
    assert_eq!(app.top().title(), "Findings");
    assert_eq!(app.stack.len(), 1);
}

#[test]
fn the_catalogue_has_every_user_facing_subcommand() {
    let lines: Vec<String> = guide::catalogue().into_iter().map(|c| c.cli).collect();
    for prefix in [
        "rio review",
        "rio review --staged",
        "rio review --base",
        "rio review --since-last",
        "rio review --pr",
        "rio review --deep",
        "rio review --preset",
        "rio review --offline",
        "rio review --format",
        "rio qa --journey",
        "rio qa --full",
        "rio qa --baseline",
        "rio qa init",
        "rio qa validate",
        "rio qa list",
        "rio qa show",
        "rio qa fixtures status",
        "rio qa rules",
        "rio qa seed build",
        "rio qa seed export",
        "rio qa seed prune",
        "rio qa seed status",
        "rio qa evidence prune",
        "rio qa sync --check",
        "rio init",
        "rio init --endpoint",
        "rio init --github-app",
        "rio deploy",
        "rio deploy --dry-run",
        "rio feedback",
        "rio findings --status",
        "rio suppressions list",
        "rio suppressions apply",
        "rio suppressions decline",
        "rio profile list",
        "rio profile show",
        "rio profile validate",
        "rio doctor",
        "rio eval noise",
        "rio eval import-incident",
    ] {
        assert!(
            lines.iter().any(|l| l.starts_with(prefix)),
            "{prefix} is missing"
        );
    }
    assert!(!lines.iter().any(|l| l.contains("prepare")));
}

#[test]
fn question_mark_opens_help_and_closes_it() {
    let mut app = app();
    app.update(press(KeyCode::Char('?')));
    assert_eq!(app.top().title(), "Help");
    app.update(press(KeyCode::Char('?')));
    assert_eq!(app.top().title(), "Findings");
    // esc closes it too.
    app.update(press(KeyCode::Char('?')));
    app.update(press(KeyCode::Esc));
    assert_eq!(app.stack.len(), 1);
}

#[test]
fn colon_in_help_opens_the_palette() {
    let mut app = app();
    app.update(press(KeyCode::Char('?')));
    app.update(press(KeyCode::Char(':')));
    assert_eq!(app.top().title(), "Command palette");
    app.update(press(KeyCode::Esc));
    assert_eq!(app.top().title(), "Help");
}

#[test]
fn help_searches_keys() {
    let mut app = app();
    app.update(press(KeyCode::Char('?')));
    app.update(press(KeyCode::Char('/')));
    assert!(app.top().wants_text());
    // `q` and `?` are typed while searching.
    typing(&mut app, "ex");
    assert!(!app.done);
    let mut buf = Buffer::empty(Rect::new(0, 0, 120, 40));
    let area = buf.area;
    app.draw(&mut buf, area);
    let text = common::lines(&buf);
    let left: Vec<String> = text.lines().map(|l| l.chars().take(44).collect()).collect();
    let left = left.join("\n");
    assert!(left.contains("export md · json · sarif"), "{left}");
    assert!(left.contains("next pane"), "{left}");
    assert!(left.contains("kill tools · exit 130"), "{left}");
    assert!(!left.contains("publish preview"), "{left}");
    assert!(text.lines().nth(38).unwrap().starts_with(" / ex█"));
    // ⏎ keeps the filter; esc clears it, then closes.
    app.update(press(KeyCode::Enter));
    assert!(!app.top().wants_text());
    app.update(press(KeyCode::Esc));
    assert_eq!(app.top().title(), "Help");
    app.update(press(KeyCode::Esc));
    assert_eq!(app.top().title(), "Findings");
    // esc while searching clears the search and stays.
    app.update(press(KeyCode::Char('?')));
    app.update(press(KeyCode::Char('/')));
    app.update(press(KeyCode::Esc));
    assert_eq!(app.top().title(), "Help");
    assert!(!app.top().wants_text());
}

fn help_text(title: &'static str, keys: &'static [Key], cols: u16, rows: u16) -> String {
    common::lines(&common::render(
        guide::help(title, keys),
        Session::default(),
        cols,
        rows,
    ))
}

#[test]
fn help_lists_the_current_screens_keys() {
    let text = help_text("Findings", FINDINGS, 120, 40);
    assert!(text.contains("THIS VIEW  Findings"), "{text}");
    for (k, label) in [
        ("d", "dismiss"),
        ("g", "graph"),
        ("f", "filter"),
        ("x", "export"),
    ] {
        assert!(
            text.lines()
                .any(|l| l.starts_with(&format!(" {k:<9}{label}"))),
            "{k} {label}\n{text}"
        );
    }
}

#[test]
fn every_key_given_to_help_appears_in_it() {
    const LIVE: &[Key] = &[
        key("ctrl-c", "stop"),
        key("↑↓", "move"),
        key("⏎", "step log"),
        key("l", "full log"),
        key("f", "findings"),
        key("?", "help"),
    ];
    const MATRIX: &[Key] = &[
        key("↑↓←→", "cell"),
        key("⏎", "open cell"),
        key("l", "follow log"),
        key("p", "pause queue"),
        key("c", "cancel cell"),
        key("^C", "stop, keep partial"),
        key("?", "help"),
    ];
    const PROPOSALS: &[Key] = &[
        key("y", "apply"),
        key("N", "leave unchanged"),
        key("x", "decline… (180 d)"),
        key("↑↓", "proposal"),
        key("esc", "history"),
    ];
    const GRAPH: &[Key] = &[
        key("←→", "hop"),
        key("↑↓", "node"),
        key("⏎", "focus"),
        key("+/-", "hops"),
        key("v", "head/base/delta"),
        key("esc", "back"),
    ];
    for (title, keys) in [
        ("Findings", FINDINGS),
        ("Live review", LIVE),
        ("Matrix", MATRIX),
        ("Proposals", PROPOSALS),
        ("Impact graph", GRAPH),
    ] {
        for (cols, rows) in [(120, 40), (80, 24)] {
            let text = help_text(title, keys, cols, rows);
            for k in keys {
                assert!(
                    text.lines()
                        .any(|l| l.starts_with(&format!(" {:<9}", k.key))),
                    "{title} {cols}×{rows}: {} missing\n{text}",
                    k.key
                );
            }
        }
    }
}

#[test]
fn screens_at_80_by_24() {
    let buf = common::render(
        guide::palette("Findings", FINDINGS),
        Session::default(),
        80,
        24,
    );
    insta::assert_snapshot!("guide-g1-command-palette_80x24", common::lines(&buf));
    let buf = common::render(
        guide::help("Findings", FINDINGS),
        Session::default(),
        80,
        24,
    );
    insta::assert_snapshot!("guide-g2-help-view-map_80x24", common::lines(&buf));
    // Scrolling keeps the selection in view in the small box.
    let mut app = App::new(guide::palette("Findings", FINDINGS), Theme::default());
    for _ in 0..30 {
        app.update(press(KeyCode::Down));
    }
    let area = Rect::new(0, 0, 80, 24);
    let mut buf = Buffer::empty(area);
    app.draw(&mut buf, area);
    let text = common::lines(&buf);
    assert!(text.contains("▌ "), "{text}");
    for line in text.lines() {
        assert_eq!(unicode_width::UnicodeWidthStr::width(line), 80);
    }
}

#[test]
fn without_color_every_state_reads_by_glyph_or_text() {
    let theme = Theme {
        color: false,
        ..Theme::default()
    };
    let buf = common::render_with(
        guide::palette("Findings", FINDINGS),
        Session::default(),
        120,
        40,
        theme,
    );
    let text = common::lines(&buf);
    let row = text
        .lines()
        .position(|l| l.contains("▌ rio qa --journey"))
        .expect("the selection is marked by ▌");
    assert!(
        buf[(30, row as u16)]
            .style()
            .add_modifier
            .contains(Modifier::REVERSED)
    );
    let buf = common::render_with(
        guide::help("Findings", FINDINGS),
        Session::default(),
        120,
        40,
        theme,
    );
    let text = common::lines(&buf);
    for word in [
        "● open",
        "✓ passed",
        "✕ failed",
        "◐ running",
        "reproduced",
        "plausible",
    ] {
        assert!(text.contains(word), "{word}");
    }
    for cell in buf.content() {
        assert_eq!(cell.style().bg, Some(ratatui::style::Color::Reset));
    }
}

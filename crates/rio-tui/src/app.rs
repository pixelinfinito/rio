//! The application: a stack of screens, global keys, and the effects screens ask for.
//!
//! `App::update` turns a message into state changes and effects; `App::draw`
//! renders the top screen. Neither touches the terminal, the network or the
//! file system, so whole flows run in tests on a `TestBackend`.

use ratatui::{
    buffer::Buffer,
    crossterm::event::{KeyCode, KeyEvent, KeyModifiers},
    layout::Rect,
};
use rio_core::{Report, ReviewEvent};

use crate::{
    canvas::{Canvas, bold, run},
    chrome::{Board, Key},
    theme::{Theme, Token},
};

/// The smallest terminal every screen stays usable in.
pub const MIN_WIDTH: u16 = 80;
pub const MIN_HEIGHT: u16 = 24;

/// What the UI receives.
#[derive(Debug, Clone)]
pub enum Msg {
    Key(KeyEvent),
    /// The 250 ms clock, for elapsed times and spinners.
    Tick,
    /// Progress of the running review.
    Review(ReviewEvent),
    /// The outcome of an effect.
    Done(Outcome),
}

/// An effect's outcome, reported back to the screens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Done; the text says what happened (shown in the footer).
    Ok(String),
    /// Failed; the text is the error shown to the user.
    Failed(String),
    /// A value a screen asked for (a publish preview, a registry page, …) as JSON.
    Value(String, serde_json::Value),
}

/// Something only the host can do: run, write, call the endpoint.
#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    /// First Ctrl-C: cancel in-flight work and keep a partial report.
    Cancel,
    /// Second Ctrl-C: kill every tool and exit 130.
    Kill,
    /// Leave the UI and exit with the review's exit code.
    Quit,
    /// Start the review described by the command-line arguments.
    Start(Vec<String>),
    /// Save the report as `md`, `json` or `sarif` at `path`.
    Export { format: String, path: String },
    /// Record a response through the finding-feedback capability.
    Feedback {
        id: String,
        reason: String,
        note: Option<String>,
    },
    /// Fetch what publishing would post (`dry_run`).
    PreviewPublish,
    /// Publish after the user's `y`.
    Publish,
    /// Write a suppression proposal to the profile after the user's `y`.
    ApplyProposal(String),
    /// Decline a suppression proposal with a reason.
    DeclineProposal { id: String, reason: String },
    /// Ask the endpoint for a JSON resource, answered as `Outcome::Value`.
    Fetch(String),
    /// Copy text to the clipboard.
    Copy(String),
    /// Open a file at a line in `$EDITOR`.
    Edit { path: String, line: u32 },
    /// Open a URL or a local evidence file.
    Open(String),
    /// Run a deploy, QA or init step named by the screen.
    Step(String),
}

/// What a screen asks the app to do after a key or a message.
pub enum Action {
    None,
    Push(Box<dyn Screen>),
    Pop,
    Replace(Box<dyn Screen>),
    Effect(Effect),
    Many(Vec<Action>),
    /// Close this screen and press `key` on the screen below (the palette
    /// running an action of the screen it was opened from).
    Replay(KeyEvent),
}

impl Action {
    pub fn effect(effect: Effect) -> Self {
        Action::Effect(effect)
    }
}

/// State every screen of a session shares.
#[derive(Default)]
pub struct Session {
    /// The finished or partial report.
    pub report: Option<Report>,
    /// The report was saved or exported since it changed.
    pub saved: bool,
    /// The process exit code once the review is over.
    pub exit_code: Option<u8>,
    /// Ctrl-C was pressed once.
    pub interrupted: bool,
    /// The last effect outcome, for the footer.
    pub notice: Option<Outcome>,
    /// Ticks since the session started (4 per second).
    pub ticks: u64,
    /// How QA screenshots are drawn, and the ones loaded so far.
    pub images: crate::images::Images,
}

pub trait Screen {
    /// The name the help screen and the palette show.
    fn title(&self) -> &'static str;
    fn board(&self) -> Board {
        Board::V2
    }
    /// The keys of the key bar, in order.
    fn keys(&self) -> &'static [Key];
    /// The keys the command palette offers as this screen's actions: the key
    /// bar's, plus any it has no room for.
    fn palette_keys(&self) -> &'static [Key] {
        self.keys()
    }
    fn draw(&self, c: &mut Canvas<'_>, session: &Session);
    fn on_key(&mut self, key: KeyEvent, session: &mut Session) -> Action;
    fn on_msg(&mut self, _msg: &Msg, _session: &mut Session) -> Action {
        Action::None
    }
    /// A text field has focus: every key goes to the screen.
    fn wants_text(&self) -> bool {
        false
    }
    /// The screen gives `q` its own meaning (an init failure's "resume later").
    fn owns_quit(&self) -> bool {
        false
    }
}

/// Opens the screens that every screen reaches through a global key.
pub struct Globals {
    /// The help screen for the current screen: its title and its keys.
    pub help: fn(&'static str, &'static [Key]) -> Box<dyn Screen>,
    /// The command palette for the current screen: its title and its keys.
    pub palette: fn(&'static str, &'static [Key]) -> Box<dyn Screen>,
}

pub struct App {
    pub stack: Vec<Box<dyn Screen>>,
    pub session: Session,
    pub theme: Theme,
    pub globals: Option<Globals>,
    pub done: bool,
}

impl App {
    pub fn new(first: Box<dyn Screen>, theme: Theme) -> Self {
        Self {
            stack: vec![first],
            session: Session::default(),
            theme,
            globals: None,
            done: false,
        }
    }

    pub fn top(&self) -> &dyn Screen {
        self.stack
            .last()
            .expect("the stack is never empty")
            .as_ref()
    }

    /// Apply a message; return the effects the host must run.
    pub fn update(&mut self, msg: Msg) -> Vec<Effect> {
        let mut effects = Vec::new();
        if let Msg::Tick = msg {
            self.session.ticks += 1;
        }
        if let Msg::Done(outcome) = &msg {
            self.session.notice = Some(outcome.clone());
        }
        if let Msg::Key(key) = msg {
            let action = self.global(key);
            self.apply(action, &mut effects);
        } else {
            // Help, the palette and the quit dialog are transient: a message
            // for the screen below closes them, so a finished review or an
            // effect's outcome is never lost while they are open.
            if !matches!(msg, Msg::Tick) {
                while self.stack.len() > 1 && is_overlay(self.top().title()) {
                    self.stack.pop();
                }
            }
            let mut screen = self.stack.pop().expect("the stack is never empty");
            let action = screen.on_msg(&msg, &mut self.session);
            self.stack.push(screen);
            self.apply(action, &mut effects);
        }
        if effects
            .iter()
            .any(|e| matches!(e, Effect::Quit | Effect::Kill))
        {
            self.done = true;
        }
        effects
    }

    fn global(&mut self, key: KeyEvent) -> Action {
        let ctrl_c =
            key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL);
        if ctrl_c {
            return if self.session.interrupted {
                Action::Effect(Effect::Kill)
            } else {
                self.session.interrupted = true;
                Action::Effect(Effect::Cancel)
            };
        }
        if self.top().wants_text() {
            return self.forward(key);
        }
        match key.code {
            KeyCode::Char('?') if self.top().title() != "Help" => {
                if let Some(globals) = &self.globals {
                    return Action::Push((globals.help)(self.top().title(), self.top().keys()));
                }
                self.forward(key)
            }
            KeyCode::Char(':') if self.top().title() != "Command palette" => match &self.globals {
                Some(globals) => Action::Push((globals.palette)(
                    self.top().title(),
                    self.top().palette_keys(),
                )),
                None => self.forward(key),
            },
            KeyCode::Char('q') if !self.top().owns_quit() => self.quit(),
            _ => self.forward(key),
        }
    }

    /// `q`: offer to save an unsaved report first.
    pub fn quit(&mut self) -> Action {
        if self.session.report.is_some() && !self.session.saved {
            Action::Push(Box::new(QuitDialog::default()))
        } else {
            Action::Effect(Effect::Quit)
        }
    }

    fn forward(&mut self, key: KeyEvent) -> Action {
        let mut screen = self.stack.pop().expect("the stack is never empty");
        let action = screen.on_key(key, &mut self.session);
        self.stack.push(screen);
        match action {
            Action::None if key.code == KeyCode::Esc && self.stack.len() > 1 => Action::Pop,
            action => action,
        }
    }

    fn apply(&mut self, action: Action, effects: &mut Vec<Effect>) {
        match action {
            Action::None => {}
            Action::Push(screen) => self.stack.push(screen),
            Action::Pop => {
                if self.stack.len() > 1 {
                    self.stack.pop();
                }
            }
            Action::Replace(screen) => {
                self.stack.pop();
                self.stack.push(screen);
            }
            Action::Effect(effect) => effects.push(effect),
            Action::Many(actions) => {
                for action in actions {
                    self.apply(action, effects);
                }
            }
            Action::Replay(key) => {
                if self.stack.len() > 1 {
                    self.stack.pop();
                }
                let action = self.forward(key);
                self.apply(action, effects);
            }
        }
    }

    /// Render the top screen, or the minimum-size notice.
    pub fn draw(&self, buf: &mut Buffer, area: Rect) {
        let mut c = Canvas::new(buf, area, self.theme);
        if area.width < MIN_WIDTH || area.height < MIN_HEIGHT {
            too_small(&mut c);
            return;
        }
        self.top().draw(&mut c, &self.session);
    }
}

fn too_small(c: &mut Canvas<'_>) {
    c.clear(Token::Bg);
    let lines = [
        format!("rio needs at least {MIN_WIDTH}×{MIN_HEIGHT} cells"),
        format!("this terminal is {}×{}", c.width(), c.height()),
    ];
    let top = c.height().saturating_sub(2) / 2;
    for (i, line) in lines.iter().enumerate() {
        let x = c.width().saturating_sub(crate::canvas::width(line) as u16) / 2;
        let fg = if i == 0 { Token::Fg } else { Token::Dim };
        c.put(x, top + i as u16, &run(line.as_str(), fg, Token::Bg));
    }
}

/// Screens that sit over another and close when it receives a message.
fn is_overlay(title: &str) -> bool {
    matches!(title, "Help" | "Command palette" | "Quit")
}

/// `q` with an unsaved report: save, quit without saving, or cancel.
#[derive(Default)]
pub struct QuitDialog {
    choice: usize,
}

const QUIT_CHOICES: [&str; 3] = ["save report.md and quit", "quit without saving", "cancel"];
const QUIT_KEYS: &[Key] = &[
    crate::chrome::key("↑↓", "choose"),
    crate::chrome::key("⏎", "confirm"),
    crate::chrome::key("esc", "cancel"),
];

impl Screen for QuitDialog {
    fn title(&self) -> &'static str {
        "Quit"
    }
    fn keys(&self) -> &'static [Key] {
        QUIT_KEYS
    }
    fn draw(&self, c: &mut Canvas<'_>, _session: &Session) {
        c.clear(Token::Bg);
        crate::chrome::header(c, Board::V2, "quit", &[]);
        let (x, y) = (c.width() / 2 - 22, c.height() / 2 - 3);
        for row in 0..6 {
            c.fill(y + row, x, x + 44, Token::Raise);
        }
        c.put(
            x + 2,
            y + 1,
            &bold("The report is not saved.", Token::Fg, Token::Raise),
        );
        for (i, label) in QUIT_CHOICES.iter().enumerate() {
            let focused = i == self.choice;
            let line = format!("{} {label}", if focused { "▶" } else { " " });
            c.put(
                x + 2,
                y + 2 + i as u16,
                &run(
                    line,
                    if focused { Token::Signal } else { Token::Dim },
                    Token::Raise,
                ),
            );
            if focused {
                c.cursor(y + 2 + i as u16, x, x + 44);
            }
        }
        crate::chrome::keybar(c, QUIT_KEYS);
    }
    fn on_key(&mut self, key: KeyEvent, session: &mut Session) -> Action {
        match key.code {
            KeyCode::Up => self.choice = self.choice.saturating_sub(1),
            KeyCode::Down => self.choice = (self.choice + 1).min(2),
            KeyCode::Enter => {
                return match self.choice {
                    0 => {
                        session.saved = true;
                        Action::Many(vec![
                            Action::Effect(Effect::Export {
                                format: "md".into(),
                                path: "report.md".into(),
                            }),
                            Action::Effect(Effect::Quit),
                        ])
                    }
                    1 => Action::Effect(Effect::Quit),
                    _ => Action::Pop,
                };
            }
            KeyCode::Esc => return Action::Pop,
            _ => {}
        }
        Action::None
    }
}

/// A key event, for tests and replays.
pub fn press(code: KeyCode) -> Msg {
    Msg::Key(KeyEvent::new(code, KeyModifiers::NONE))
}

/// Ctrl plus a character.
pub fn ctrl(c: char) -> Msg {
    Msg::Key(KeyEvent::new(KeyCode::Char(c), KeyModifiers::CONTROL))
}

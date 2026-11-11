//! I6 — connect to an existing endpoint, as `rio init --endpoint URL --token-stdin`.

use ratatui::crossterm::event::{KeyCode, KeyEvent};

use super::{
    InitData, TokenSource,
    widgets::{
        Radio, chip, clip, content_end, header, heading, hint_row, key_hint, masked_field, radio,
        rule, text_field,
    },
};
use crate::{
    Action, Effect, Msg, Outcome, Screen, Session,
    canvas::{Canvas, Run, bold, pad, run},
    chrome::{Board, Key, key, keybar, quiet, status},
    theme::Token,
};

const KEYS: &[Key] = &[
    key("tab", "field"),
    key("↑↓", "token source"),
    key("⏎", "connect"),
    key("esc", "back"),
];

/// The form's fields, in `tab` order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Field {
    Url,
    Source,
    Token,
}

/// An endpoint URL `rio init --endpoint` accepts: HTTPS, or plain HTTP to loopback.
pub fn valid_url(url: &str) -> bool {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| {
            ["http://localhost", "http://127.0.0.1", "http://[::1]"]
                .iter()
                .find(|p| url.starts_with(**p))
                .map(|_| url)
        })
        .unwrap_or("");
    !rest.is_empty() && !rest.chars().any(char::is_whitespace)
}

/// I6: endpoint URL and API token source.
pub struct ConnectExisting {
    data: InitData,
    url: String,
    source: TokenSource,
    focus: Field,
    /// The token as typed (the terminal's stand-in for stdin); never drawn.
    token: String,
    problem: Option<String>,
    outcome: Option<Outcome>,
}

impl ConnectExisting {
    pub fn new(data: InitData) -> Self {
        Self {
            url: data.connect.url.clone(),
            source: data.connect.source,
            focus: Field::Url,
            token: String::new(),
            problem: None,
            outcome: None,
            data,
        }
    }

    pub fn field(&self) -> Field {
        self.focus
    }

    fn next_field(&mut self, back: bool) {
        let order: &[Field] = match self.source {
            TokenSource::Stdin => &[Field::Url, Field::Source, Field::Token],
            TokenSource::Env => &[Field::Url, Field::Source],
        };
        let i = order.iter().position(|f| *f == self.focus).unwrap_or(0);
        let n = order.len();
        self.focus = order[if back { (i + n - 1) % n } else { (i + 1) % n }];
    }

    fn connect(&mut self) -> Action {
        let url = self.url.trim().to_owned();
        if !valid_url(&url) {
            self.problem = Some("an https:// URL is needed (http only for loopback)".into());
            return Action::Many(vec![]);
        }
        let mut args = vec!["init".to_owned(), "--endpoint".into(), url];
        match self.source {
            TokenSource::Stdin => {
                if self.token.trim().is_empty() {
                    self.problem = Some("paste the API token first".into());
                    self.focus = Field::Token;
                    return Action::Many(vec![]);
                }
                args.push("--token-stdin".into());
                self.data
                    .handoff
                    .set_secret(Some(("stdin".into(), self.token.trim().to_owned())));
            }
            TokenSource::Env => self.data.handoff.set_secret(None),
        }
        self.problem = None;
        self.data.handoff.set_args(args.clone());
        Action::Effect(Effect::Start(args))
    }
}

impl Screen for ConnectExisting {
    fn title(&self) -> &'static str {
        "Connect existing"
    }
    fn board(&self) -> Board {
        Board::V2
    }
    fn keys(&self) -> &'static [Key] {
        KEYS
    }
    fn wants_text(&self) -> bool {
        matches!(self.focus, Field::Url | Field::Token)
    }

    fn draw(&self, c: &mut Canvas<'_>, _session: &Session) {
        c.clear(Token::Bg);
        header(
            c,
            "rio init · --endpoint",
            &[
                status("● connect", Token::Signal),
                quiet(format!("rio {}", self.data.version)),
            ],
        );
        let w = c.width();
        let end = content_end(c);
        let right = w.saturating_sub(2);
        c.put(
            2,
            2,
            &bold("Connect to an existing rio endpoint", Token::Fg, Token::Bg),
        );
        clip(
            c,
            2,
            3,
            right,
            &[run(
                "a teammate already deployed rio in their Cloudflare account",
                Token::Dim,
                Token::Bg,
            )],
        );
        rule(c, 5);
        let mut y = 6;
        let mark = |c: &mut Canvas<'_>, y: u16, on: bool| {
            if on {
                c.put(0, y, &run("▌", Token::Signal, Token::Bg));
                c.cursor(y, 0, w);
            }
        };
        let line = |c: &mut Canvas<'_>, y: &mut u16, x: u16, runs: &[Run]| {
            if *y <= end {
                clip(c, x, *y, right, runs);
            }
            *y += 1;
        };

        line(c, &mut y, 2, &[heading("ENDPOINT")]);
        if y <= end {
            text_field(c, 2, y, 60.min(right - 2), &self.url, true, Token::Raise);
            mark(c, y, self.focus == Field::Url);
        }
        y += 1;
        let policy = "HTTPS (plain http only for loopback development)";
        let check = if self.url.trim().is_empty() {
            [
                run("·", Token::Faint, Token::Bg),
                run(policy, Token::Faint, Token::Bg),
            ]
        } else if valid_url(self.url.trim()) {
            [
                run("✓", Token::Pass, Token::Bg),
                run(policy, Token::Dim, Token::Bg),
            ]
        } else {
            [
                run("✕", Token::Fail, Token::Bg),
                run(
                    "HTTPS required (plain http only for loopback development)",
                    Token::Fg,
                    Token::Bg,
                ),
            ]
        };
        let [glyph, text] = check;
        line(c, &mut y, 2, &[glyph, run(" ", Token::Fg, Token::Bg), text]);
        line(
            c,
            &mut y,
            2,
            &[
                run("✓", Token::Pass, Token::Bg),
                run(" ", Token::Fg, Token::Bg),
                run(
                    "redirects disabled · the bearer token never leaves this origin",
                    Token::Dim,
                    Token::Bg,
                ),
            ],
        );
        y += 1;

        line(c, &mut y, 2, &[heading("API TOKEN")]);
        for (source, label, note) in [
            (
                TokenSource::Stdin,
                "read from stdin",
                "your-secret-manager read rio-api-token | rio init … --token-stdin",
            ),
            (
                TokenSource::Env,
                "RIO_API_TOKEN",
                "environment variable · takes precedence over the stored token",
            ),
        ] {
            let chosen = self.source == source;
            let focused = chosen && self.focus == Field::Source;
            if y + 1 > end {
                break;
            }
            radio(
                c,
                y,
                2,
                w,
                Radio {
                    label,
                    chosen,
                    focused,
                    note: None,
                    tag: None,
                },
            );
            let bg = if focused { Token::Raise } else { Token::Bg };
            if focused {
                c.fill(y + 1, 0, w, bg);
                c.put(0, y + 1, &run("▌", Token::Signal, bg));
            }
            clip(c, 6, y + 1, right, &[run(note, Token::Faint, bg)]);
            if focused {
                c.cursor(y + 1, 0, w);
            }
            y += 2;
        }
        if y <= end {
            clip(c, 6, y, right, &[run("token", Token::Faint, Token::Bg)]);
            match self.source {
                TokenSource::Stdin => {
                    let focused = self.focus == Field::Token;
                    let bg = if focused { Token::Raise } else { Token::Panel };
                    let cells = 40.min(right.saturating_sub(13 + 22));
                    masked_field(c, 13, y, cells, self.token.chars().count(), focused, bg);
                    let (text, fg) = if self.token.is_empty() {
                        ("· paste it here, echo off", Token::Faint)
                    } else {
                        ("✓ received on stdin", Token::Pass)
                    };
                    clip(c, 15 + cells, y, right, &[run(text, fg, Token::Bg)]);
                    mark(c, y, focused);
                }
                TokenSource::Env => {
                    let (text, fg) = if self.data.connect.env_token {
                        ("✓ RIO_API_TOKEN is set · nothing stored", Token::Pass)
                    } else {
                        ("· set RIO_API_TOKEN before reviewing", Token::Faint)
                    };
                    clip(c, 13, y, right, &[run(text, fg, Token::Bg)]);
                }
            }
        }
        y += 2;

        line(c, &mut y, 2, &[heading("WRITES")]);
        let config = self.data.config_file();
        let mut writes = vec![(config, "endpoint.url · other machine settings preserved")];
        if self.source == TokenSource::Stdin {
            writes.push((
                format!("{}/ (private dir)", self.data.config_dir),
                "API token · mode 0600",
            ));
        }
        for (path, note) in writes {
            line(
                c,
                &mut y,
                2,
                &[
                    run("+", Token::Pass, Token::Bg),
                    run(format!(" {}", pad(&path, 32)), Token::Fg, Token::Bg),
                    run(note, Token::Faint, Token::Bg),
                ],
            );
        }
        y += 1;
        line(c, &mut y, 2, &[heading("OVERRIDES")]);
        for (name, note) in [
            (
                "RIO_ENDPOINT_URL",
                "replaces the saved endpoint for one shell",
            ),
            ("RIO_API_TOKEN", "replaces the stored token"),
        ] {
            line(
                c,
                &mut y,
                2,
                &[
                    run(pad(name, 18), Token::Signal, Token::Bg),
                    run(note, Token::Faint, Token::Bg),
                ],
            );
        }
        y += 1;
        line(c, &mut y, 2, &[heading("THEN")]);
        for (cmd, note) in [
            (
                "rio review --preset quick",
                "checks run in the endpoint's isolated runner",
            ),
            (
                "rio review --offline",
                "keeps the local deterministic review",
            ),
        ] {
            line(
                c,
                &mut y,
                2,
                &[
                    run(pad(cmd, 28), Token::Fg, Token::Bg),
                    run(note, Token::Faint, Token::Bg),
                ],
            );
        }

        let hy = hint_row(c);
        let x = chip(c, 2, hy, "⏎ connect", 11);
        let mut runs = vec![run("   ", Token::Fg, Token::Bg)];
        runs.extend(key_hint("esc", "back to modes", Token::Bg));
        let x = clip(c, x, hy, right, &runs);
        let notice = match (&self.problem, &self.outcome) {
            (Some(problem), _) => Some(run(format!("✕ {problem}"), Token::Fail, Token::Bg)),
            (None, Some(Outcome::Failed(error))) => {
                Some(run(format!("✕ {error}"), Token::Fail, Token::Bg))
            }
            (None, Some(Outcome::Ok(text))) => {
                Some(run(format!("✓ {text}"), Token::Pass, Token::Bg))
            }
            _ => None,
        };
        if let Some(notice) = notice {
            clip(c, x + 3, hy, right, &[notice]);
        }
        keybar(c, KEYS);
    }

    fn on_key(&mut self, key: KeyEvent, _session: &mut Session) -> Action {
        match key.code {
            KeyCode::Tab => self.next_field(false),
            KeyCode::BackTab => self.next_field(true),
            KeyCode::Enter => return self.connect(),
            KeyCode::Esc => return Action::Pop,
            KeyCode::Up => self.source = TokenSource::Stdin,
            KeyCode::Down => {
                self.source = TokenSource::Env;
                if self.focus == Field::Token {
                    self.focus = Field::Source;
                }
            }
            KeyCode::Backspace => {
                match self.focus {
                    Field::Url => {
                        self.url.pop();
                    }
                    Field::Token => {
                        self.token.pop();
                    }
                    Field::Source => {}
                }
                self.problem = None;
            }
            KeyCode::Char(ch) => match self.focus {
                Field::Url => {
                    self.url.push(ch);
                    self.problem = None;
                }
                Field::Token => {
                    self.token.push(ch);
                    self.problem = None;
                }
                Field::Source => match ch {
                    'k' => self.source = TokenSource::Stdin,
                    'j' => self.source = TokenSource::Env,
                    _ => {}
                },
            },
            _ => {}
        }
        Action::None
    }

    fn on_msg(&mut self, msg: &Msg, _session: &mut Session) -> Action {
        if let Msg::Done(outcome @ (Outcome::Ok(_) | Outcome::Failed(_))) = msg {
            self.outcome = Some(outcome.clone());
        }
        Action::None
    }
}

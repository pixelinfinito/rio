//! I1 — choose where reviews run, with the local preflight.

use ratatui::crossterm::event::{KeyCode, KeyEvent};

use super::{
    CheckState, InitData,
    configure::{Configure, deploy_args},
    connect::ConnectExisting,
    widgets::{
        BANNER_TEXT, Radio, chip, clip, content_end, header, heading, hint_row, key_hint, logo,
        radio, rule, separator, split, tall,
    },
};
use crate::{
    Action, Effect, Screen, Session,
    canvas::{Canvas, bold, run},
    chrome::{Board, Key, key, keybar, quiet, status},
    theme::Token,
};

const KEYS: &[Key] = &[
    key("↑↓", "mode"),
    key("⏎", "continue"),
    key("p", "dry run"),
    key("?", "help"),
    key("q", "quit"),
];

/// The three ways to run reviews, as drawn: title, two lines, tag.
const MODES: [(&str, &str, &str, Option<&str>); 3] = [
    (
        "Deploy to my Cloudflare account",
        "Worker · Workflows · D1 · R2 · Queues · AI Gateway, all in your",
        "account. Agents, blind verifier, isolated runners.",
        Some("recommended"),
    ),
    (
        "Connect an existing endpoint",
        "A teammate already deployed rio: paste its URL and an API token.",
        "rio init --endpoint URL --token-stdin",
        None,
    ),
    (
        "Local only",
        "Deterministic checks and the graph on this machine.",
        "Agents, triage and verify are deferred (no_endpoint).",
        None,
    ),
];

const NEEDS: [&str; 4] = [
    "Workers Paid plan with D1, R2, Queues, Workflows",
    "Containers enabled (Cloudflare Sandbox runner)",
    "a model key: OpenRouter, OpenAI or Anthropic",
    "Docker running locally to copy the runner image",
];

const PRIVACY: [&str; 3] = [
    "no account or resource IDs in the repo",
    "secrets: keychain, never in args",
    "gateway logs and cache disabled",
];

/// The mode chosen on I1.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Deploy,
    Connect,
    Local,
}

const ORDER: [Mode; 3] = [Mode::Deploy, Mode::Connect, Mode::Local];

/// I1: mode choice and the local preflight.
pub struct ChooseMode {
    data: InitData,
    mode: usize,
}

impl ChooseMode {
    pub fn new(data: InitData) -> Self {
        Self { data, mode: 0 }
    }

    pub fn mode(&self) -> Mode {
        ORDER[self.mode]
    }
}

impl Screen for ChooseMode {
    fn title(&self) -> &'static str {
        "Choose mode"
    }
    fn board(&self) -> Board {
        Board::V2
    }
    fn keys(&self) -> &'static [Key] {
        KEYS
    }

    fn draw(&self, c: &mut Canvas<'_>, _session: &Session) {
        c.clear(Token::Bg);
        let context = format!("rio init · {}", self.data.config_dir);
        header(
            c,
            &context,
            &[
                status("● setup", Token::Signal),
                quiet(format!("rio {}", self.data.version)),
            ],
        );
        let w = c.width();
        let left = split(c, 72);
        let end = content_end(c);
        // Banner.
        let (title_y, top) = if tall(c) {
            logo(c, 2, Token::Fg);
            (3, 8)
        } else {
            (2, 5)
        };
        let tx = if tall(c) { BANNER_TEXT } else { 2 };
        c.put(tx, title_y, &bold("Set up rio", Token::Fg, Token::Bg));
        clip(
            c,
            tx,
            title_y + 1,
            w,
            &[run(
                "choose where reviews run · change later with rio init or rio deploy",
                Token::Dim,
                Token::Bg,
            )],
        );
        clip(
            c,
            tx,
            title_y + 2,
            w,
            &[run(
                "nothing is written to the repository",
                Token::Faint,
                Token::Bg,
            )],
        );
        rule(c, top);
        separator(c, left, top, c.height().saturating_sub(1));

        // Left: the modes, then what deploying needs.
        let mut y = top + 1;
        clip(c, 2, y, left, &[heading("HOW SHOULD RIO RUN REVIEWS?")]);
        y += 2;
        for (i, (title, line1, line2, tag)) in MODES.iter().enumerate() {
            if y + 2 > end {
                break;
            }
            let focused = i == self.mode;
            radio(
                c,
                y,
                2,
                left,
                Radio {
                    label: title,
                    chosen: focused,
                    focused,
                    note: None,
                    tag: tag.map(|t| run(t, Token::Pass, Token::Bg)),
                },
            );
            let bg = if focused { Token::Raise } else { Token::Bg };
            for (k, (line, fg)) in [
                (line1, if focused { Token::Dim } else { Token::Faint }),
                (line2, Token::Faint),
            ]
            .into_iter()
            .enumerate()
            {
                let ly = y + 1 + k as u16;
                if focused {
                    c.fill(ly, 0, left, bg);
                    c.put(0, ly, &run("▌", Token::Signal, bg));
                }
                clip(c, 6, ly, left.saturating_sub(2), &[run(*line, fg, bg)]);
                if focused {
                    c.cursor(ly, 0, left);
                }
            }
            y += 4;
        }
        y += 1;
        if y < end {
            clip(c, 2, y, left, &[heading("WHAT DEPLOY NEEDS")]);
            y += 1;
            for need in NEEDS {
                if y >= end {
                    break;
                }
                clip(
                    c,
                    2,
                    y,
                    left.saturating_sub(1),
                    &[
                        run("·", Token::Signal, Token::Bg),
                        run(" ", Token::Fg, Token::Bg),
                        run(need, Token::Dim, Token::Bg),
                    ],
                );
                y += 1;
            }
            y += 1;
            if y < end {
                clip(
                    c,
                    2,
                    y,
                    left.saturating_sub(1),
                    &[run(
                        "Your provider bills model usage; Cloudflare bills your account.",
                        Token::Faint,
                        Token::Bg,
                    )],
                );
            }
        }
        let hy = hint_row(c);
        let next = chip(c, 2, hy, "⏎ continue", 13);
        let mut hint = key_hint("p", "dry-run plan (no login, no changes)", Token::Bg).to_vec();
        hint.insert(0, run("   ", Token::Fg, Token::Bg));
        clip(c, next, hy, left.saturating_sub(1), &hint);

        // Right: this machine, the existing config, privacy.
        let x = left + 2;
        let mut y = top + 1;
        let line = |c: &mut Canvas<'_>, y: &mut u16, runs: &[crate::canvas::Run]| {
            if *y <= end {
                clip(c, x, *y, w, runs);
            }
            *y += 1;
        };
        line(c, &mut y, &[heading("THIS MACHINE")]);
        y += 1;
        for check in &self.data.preflight {
            let (glyph, gfg, tfg) = match check.state {
                CheckState::Ok => ("✓", Token::Pass, Token::Dim),
                CheckState::Missing => ("·", Token::Faint, Token::Faint),
                CheckState::Failed => ("✕", Token::Fail, Token::Fg),
            };
            line(
                c,
                &mut y,
                &[
                    run(glyph, gfg, Token::Bg),
                    run(" ", Token::Fg, Token::Bg),
                    run(check.text.as_str(), tfg, Token::Bg),
                ],
            );
            if let Some(hint) = &check.hint {
                line(
                    c,
                    &mut y,
                    &[run(format!("  → {hint}"), Token::Faint, Token::Bg)],
                );
            }
        }
        y += 1;
        line(c, &mut y, &[heading("EXISTING CONFIG")]);
        let file = self.data.config_file();
        line(c, &mut y, &[run(file, Token::Dim, Token::Bg)]);
        line(
            c,
            &mut y,
            &[run(self.data.existing.as_str(), Token::Faint, Token::Bg)],
        );
        if let Some(step) = &self.data.pending {
            line(
                c,
                &mut y,
                &[run(format!("◐ stopped at {step}"), Token::Warn, Token::Bg)],
            );
            line(
                c,
                &mut y,
                &[run("rio deploy resumes it", Token::Faint, Token::Bg)],
            );
        }
        y += 1;
        line(c, &mut y, &[heading("PRIVACY")]);
        for item in PRIVACY {
            line(
                c,
                &mut y,
                &[
                    run("✓", Token::Pass, Token::Bg),
                    run(" ", Token::Fg, Token::Bg),
                    run(item, Token::Dim, Token::Bg),
                ],
            );
        }
        keybar(c, KEYS);
    }

    fn on_key(&mut self, key: KeyEvent, _session: &mut Session) -> Action {
        match key.code {
            KeyCode::Up | KeyCode::Char('k') => self.mode = self.mode.saturating_sub(1),
            KeyCode::Down | KeyCode::Char('j') => self.mode = (self.mode + 1).min(ORDER.len() - 1),
            KeyCode::Enter => {
                return match self.mode() {
                    Mode::Deploy => Action::Push(Box::new(Configure::new(self.data.clone()))),
                    Mode::Connect => {
                        Action::Push(Box::new(ConnectExisting::new(self.data.clone())))
                    }
                    Mode::Local => Action::Effect(Effect::Step("init:local".into())),
                };
            }
            KeyCode::Char('p') => {
                let configure = Configure::new(self.data.clone());
                self.data
                    .handoff
                    .set_args(deploy_args(&self.data.configure));
                return Action::Many(vec![
                    Action::Effect(Effect::Step("init:plan".into())),
                    Action::Push(Box::new(configure)),
                ]);
            }
            _ => {}
        }
        Action::None
    }
}

//! I5 — deployed: the endpoint, what was saved, resources, next commands.

use ratatui::crossterm::event::{KeyCode, KeyEvent};

use super::{
    DeployedData, DeployingData, StepState,
    deploying::{LOG_KEYS, LogView},
    widgets::{BANNER_TEXT, chip, clip, clock, content_end, header, heading, logo, rule, tall},
};
use crate::{
    Action, Effect, Screen, Session,
    canvas::{Canvas, Run, bold, pad, run},
    chrome::{Board, Key, key, keybar, quiet, status},
    theme::Token,
};

const KEYS: &[Key] = &[
    key("⏎", "first review"),
    key("t", "teammate"),
    key("c", "copy URL"),
    key("l", "deploy log"),
    key("q", "quit"),
];

/// I5: the result of a deployment.
pub struct Deployed {
    deploy: DeployingData,
    done: DeployedData,
    log: Option<LogView>,
}

impl Deployed {
    pub fn new(deploy: DeployingData, done: DeployedData) -> Self {
        Self {
            deploy,
            done,
            log: None,
        }
    }

    /// The command a teammate runs to use this endpoint.
    pub fn teammate_command(&self) -> String {
        format!("rio init --endpoint {} --token-stdin", self.done.endpoint)
    }

    fn config_file(&self) -> String {
        self.done
            .artifacts
            .iter()
            .find(|a| a.label == "config")
            .map_or_else(|| "~/.config/rio/config.toml".into(), |a| a.path.clone())
    }

    /// The next commands: key, label, command shown, command copied.
    fn next(&self) -> [(char, &'static str, String, String); 4] {
        [
            (
                't',
                "connect a teammate",
                self.teammate_command(),
                self.teammate_command(),
            ),
            (
                'u',
                "upgrade later",
                "rio deploy · reuses choices, resumes partial runs".into(),
                "rio deploy".into(),
            ),
            (
                'p',
                "plan any time",
                "rio deploy --dry-run · no login, no changes".into(),
                "rio deploy --dry-run".into(),
            ),
            (
                'e',
                "CI / another machine",
                format!("rio init --from {}", self.config_file()),
                format!("rio init --from {}", self.config_file()),
            ),
        ]
    }
}

impl Screen for Deployed {
    fn title(&self) -> &'static str {
        "Deployed"
    }
    fn board(&self) -> Board {
        Board::V2
    }
    fn keys(&self) -> &'static [Key] {
        if self.log.is_some() { LOG_KEYS } else { KEYS }
    }

    fn draw(&self, c: &mut Canvas<'_>, _session: &Session) {
        c.clear(Token::Bg);
        let d = &self.deploy;
        header(
            c,
            &format!("rio init · {} → {}", d.name, d.account_name),
            &[status("✓ deployed", Token::Pass), quiet(clock(d.elapsed))],
        );
        if let Some(log) = &self.log {
            log.draw(c);
            return;
        }
        let w = c.width();
        let end = content_end(c) + 2;
        let reused = d
            .steps
            .iter()
            .filter(|s| s.state == StepState::Reused)
            .count();
        let retries = self.done.retries;
        let summary = format!(
            "{} · {} steps · {reused} reused · {retries} {} · {}",
            d.account_name,
            d.steps.len(),
            if retries == 1 { "retry" } else { "retries" },
            clock(d.elapsed)
        );
        let (tx, ty, top) = if tall(c) {
            logo(c, 2, Token::Pass);
            (BANNER_TEXT, 3, 8)
        } else {
            (2, 2, 5)
        };
        c.put(tx, ty, &bold("rio is deployed", Token::Fg, Token::Bg));
        clip(c, tx, ty + 1, w, &[run(summary, Token::Dim, Token::Bg)]);
        clip(
            c,
            tx,
            ty + 2,
            w,
            &[run(
                "everything runs in your own Cloudflare account",
                Token::Faint,
                Token::Bg,
            )],
        );
        rule(c, top);

        let mut y = top + 2;
        let line = |c: &mut Canvas<'_>, y: &mut u16, x: u16, runs: &[Run]| {
            if *y <= end {
                clip(c, x, *y, w.saturating_sub(1), runs);
            }
            *y += 1;
        };
        line(c, &mut y, 2, &[heading("ENDPOINT")]);
        if y <= end {
            let boxw = 60.min(w.saturating_sub(4));
            c.fill(y, 2, 2 + boxw, Token::Panel);
            clip(
                c,
                3,
                y,
                2 + boxw.saturating_sub(8),
                &[bold(
                    self.done.endpoint.as_str(),
                    Token::Signal,
                    Token::Panel,
                )],
            );
            c.put_right(2 + boxw, y, &[run("c copy", Token::Faint, Token::Panel)]);
        }
        y += 2;
        if !self.done.artifacts.is_empty() {
            line(c, &mut y, 2, &[heading("SAVED")]);
            for a in &self.done.artifacts {
                line(
                    c,
                    &mut y,
                    2,
                    &[
                        run("✓", Token::Pass, Token::Bg),
                        run(" ", Token::Fg, Token::Bg),
                        run(pad(&a.label, 10), Token::Faint, Token::Bg),
                        run(pad(&a.path, 38), Token::Fg, Token::Bg),
                        run(a.note.as_str(), Token::Faint, Token::Bg),
                    ],
                );
            }
            y += 1;
        }
        if !self.done.resources.is_empty() {
            line(c, &mut y, 2, &[heading("RESOURCES")]);
            let columns = usize::from((w.saturating_sub(2) / 29).max(1));
            for row in self.done.resources.chunks(columns) {
                if y <= end {
                    for (i, r) in row.iter().enumerate() {
                        let name = if r.reused {
                            format!("{} ↺", r.name)
                        } else {
                            r.name.clone()
                        };
                        let x = 2 + 29 * i as u16;
                        clip(
                            c,
                            x,
                            y,
                            (x + 29).min(w),
                            &[
                                run("✓", Token::Pass, Token::Bg),
                                run(" ", Token::Fg, Token::Bg),
                                run(pad(&r.kind, 11), Token::Faint, Token::Bg),
                                run(pad(&name, 16), Token::Dim, Token::Bg),
                            ],
                        );
                    }
                }
                y += 1;
            }
            y += 1;
        }
        line(c, &mut y, 2, &[heading("NEXT")]);
        if y <= end {
            let x = chip(c, 2, y, "⏎ run your first review", 24);
            clip(
                c,
                x,
                y,
                w,
                &[run(
                    "    rio review --preset standard",
                    Token::Fg,
                    Token::Bg,
                )],
            );
        }
        y += 2;
        for (k, label, shown, _) in self.next() {
            line(
                c,
                &mut y,
                3,
                &[
                    bold(k.to_string(), Token::Fg, Token::Bg),
                    run("  ", Token::Fg, Token::Bg),
                    run(pad(label, 24), Token::Dim, Token::Bg),
                    run(shown, Token::Faint, Token::Bg),
                ],
            );
        }
        y += 2;
        if y <= end {
            rule(c, y);
        }
        y += 1;
        let provider = if self.done.provider.is_empty() {
            "model provider".to_owned()
        } else {
            self.done.provider.clone()
        };
        line(
            c,
            &mut y,
            2,
            &[
                heading("Billing"),
                run(
                    format!(
                        "  model usage → your {provider} account · Workers, D1, R2, Queues, Containers → Cloudflare"
                    ),
                    Token::Faint,
                    Token::Bg,
                ),
            ],
        );
        let share = "Share the endpoint and an API token through your secret manager, never in chat or the repo.";
        line(c, &mut y, 2, &[run(share, Token::Faint, Token::Bg)]);
        keybar(c, KEYS);
    }

    fn on_key(&mut self, key: KeyEvent, _session: &mut Session) -> Action {
        if let Some(log) = &mut self.log {
            if !log.on_key(key) {
                self.log = None;
            }
            return Action::Many(vec![]);
        }
        match key.code {
            KeyCode::Enter => Action::Effect(Effect::Step("init:first-review".into())),
            KeyCode::Char('c') => Action::Effect(Effect::Copy(self.done.endpoint.clone())),
            KeyCode::Char('l') => {
                self.log = Some(LogView::new("deployment", self.deploy.log.clone()));
                Action::None
            }
            KeyCode::Char(ch) => match self.next().into_iter().find(|n| n.0 == ch) {
                Some((_, _, _, copied)) => Action::Effect(Effect::Copy(copied)),
                None => Action::None,
            },
            // The deployment is done: nothing to go back to.
            KeyCode::Esc => Action::Many(vec![]),
            _ => Action::None,
        }
    }
}

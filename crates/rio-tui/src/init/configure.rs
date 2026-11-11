//! I2 — the deploy form with the live dry-run plan.

use ratatui::crossterm::event::{KeyCode, KeyEvent};

use super::{
    ConfigureData, CredentialStore, DeployingData, InitData, Plan, Provider, Runner,
    deploying::Deploying,
    widgets::{
        Radio, chip, clip, content_end, header, heading, hint_row, key_hint, masked_field, radio,
        scrolled, segments, separator, short_id, split, text_field, wrap_items,
    },
};
use crate::{
    Action, Effect, Msg, Outcome, Screen, Session,
    canvas::{Canvas, Run, bold, pad, run},
    chrome::{Board, Key, key, keybar, quiet, status},
    theme::Token,
};

const KEYS: &[Key] = &[
    key("tab", "section"),
    key("↑↓", "select"),
    key("←→", "option"),
    key("⏎", "deploy"),
    key("p", "plan"),
    key("esc", "back"),
];

/// The form's sections, in `tab` order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Section {
    Account,
    Name,
    Runner,
    Provider,
    Key,
    Credentials,
}

const SECTIONS: [Section; 6] = [
    Section::Account,
    Section::Name,
    Section::Runner,
    Section::Provider,
    Section::Key,
    Section::Credentials,
];

/// The `rio init` arguments equivalent to the form's choices. The provider
/// key is never an argument: it travels in the handoff under its env name.
pub fn deploy_args(data: &ConfigureData) -> Vec<String> {
    let mut args = vec!["init".to_owned()];
    if let Some(account) = data.accounts.get(data.account) {
        args.extend(["--account".into(), account.id.clone()]);
    }
    args.extend([
        "--name".into(),
        data.name.clone(),
        "--runner".into(),
        data.runner.flag().into(),
        "--credential-store".into(),
        data.credential_store.flag().into(),
    ]);
    args
}

/// A deployment name `rio init` accepts: 3–48 lowercase letters, digits or
/// hyphens, starting with a letter.
pub fn valid_name(name: &str) -> bool {
    (3..=48).contains(&name.len())
        && name.starts_with(|c: char| c.is_ascii_lowercase())
        && name
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

/// I2: account, name, runner, provider and key, credential store; the plan.
pub struct Configure {
    data: InitData,
    form: ConfigureData,
    focus: usize,
    /// The provider key as typed; drawn only as bullets.
    key: String,
    /// The choices changed since the plan was made.
    stale: bool,
    /// Why ⏎ did not deploy.
    problem: Option<String>,
}

impl Configure {
    pub fn new(data: InitData) -> Self {
        let form = data.configure.clone();
        Self {
            data,
            form,
            focus: 0,
            key: String::new(),
            stale: false,
            problem: None,
        }
    }

    pub fn section(&self) -> Section {
        SECTIONS[self.focus]
    }

    /// The choices as they stand.
    pub fn choices(&self) -> &ConfigureData {
        &self.form
    }

    fn changed(&mut self) {
        self.stale = self.form.plan.is_some();
        self.problem = None;
    }

    fn key_in_env(&self) -> bool {
        self.form
            .env_keys
            .iter()
            .any(|k| k == self.form.provider.key_name())
    }

    fn endpoint(&self) -> String {
        match &self.form.subdomain {
            Some(sub) => format!("https://{}.{sub}.workers.dev", self.form.name),
            None => format!("https://{}.<new subdomain>.workers.dev", self.form.name),
        }
    }

    fn plan(&mut self) -> Action {
        self.data.handoff.set_args(deploy_args(&self.form));
        Action::Effect(Effect::Step("init:plan".into()))
    }

    fn deploy(&mut self) -> Action {
        if !valid_name(&self.form.name) {
            self.problem = Some(
                "name: 3–48 lowercase letters, digits or hyphens, starting with a letter".into(),
            );
            return Action::Many(vec![]);
        }
        let Some(account) = self.form.accounts.get(self.form.account).cloned() else {
            self.problem = Some("no Cloudflare account: run cf auth login".into());
            return Action::Many(vec![]);
        };
        if self.key.trim().is_empty() && !self.key_in_env() {
            self.problem = Some(format!("{} key needed", self.form.provider.name()));
            return Action::Many(vec![]);
        }
        let args = deploy_args(&self.form);
        self.data.handoff.set_args(args.clone());
        self.data.handoff.set_secret(if self.key.trim().is_empty() {
            None
        } else {
            Some((
                self.form.provider.key_name().into(),
                self.key.trim().to_owned(),
            ))
        });
        let deploying = DeployingData::new(
            &account,
            &self.form.name,
            self.form.runner,
            self.form.subdomain.as_deref(),
        );
        Action::Many(vec![
            Action::Effect(Effect::Start(args)),
            Action::Push(Box::new(Deploying::new(deploying))),
        ])
    }

    fn draw_plan(&self, c: &mut Canvas<'_>, x: u16, end: u16) {
        let w = c.width();
        let mut y = 2;
        let line = |c: &mut Canvas<'_>, y: &mut u16, runs: &[Run]| {
            if *y <= end {
                clip(c, x, *y, w, runs);
            }
            *y += 1;
        };
        line(c, &mut y, &[heading("PLAN · rio deploy --dry-run")]);
        match &self.form.plan {
            None => line(
                c,
                &mut y,
                &[run(
                    "p makes the plan · no login, no changes",
                    Token::Faint,
                    Token::Bg,
                )],
            ),
            Some(plan) => {
                let bundle: String = plan.bundle.chars().take(8).collect();
                let summary = format!(
                    "bundle {bundle} · worker {} · {}",
                    plan.worker_version,
                    if plan.changes {
                        "changes pending"
                    } else {
                        "no changes yet"
                    }
                );
                line(c, &mut y, &[run(summary, Token::Faint, Token::Bg)]);
                if self.stale {
                    line(
                        c,
                        &mut y,
                        &[run(
                            "choices changed · p plans again",
                            Token::Warn,
                            Token::Bg,
                        )],
                    );
                }
                y += 1;
                for r in &plan.resources {
                    let (glyph, fg) = match r.action.as_str() {
                        "reuse" => ("↺", Token::Signal),
                        "update" => ("→", Token::Warn),
                        _ => ("+", Token::Pass),
                    };
                    line(
                        c,
                        &mut y,
                        &[
                            run(glyph, fg, Token::Bg),
                            run(" ", Token::Fg, Token::Bg),
                            run(pad(&r.kind, 19), Token::Dim, Token::Bg),
                            run(pad(&r.name, 23), Token::Fg, Token::Bg),
                            run(r.action.as_str(), Token::Faint, Token::Bg),
                        ],
                    );
                }
                if !plan.bindings.is_empty() {
                    y += 1;
                    line(c, &mut y, &[heading("BINDINGS")]);
                    for l in wrap_items(&plan.bindings, 40) {
                        line(c, &mut y, &[run(l, Token::Dim, Token::Bg)]);
                    }
                }
            }
        }
        if !self.form.scopes.is_empty() {
            y += 1;
            line(c, &mut y, &[heading("TOKEN SCOPES · cf auth scopes")]);
            for scope in &self.form.scopes {
                line(
                    c,
                    &mut y,
                    &[
                        run("✓", Token::Pass, Token::Bg),
                        run(" ", Token::Fg, Token::Bg),
                        run(scope.as_str(), Token::Dim, Token::Bg),
                    ],
                );
            }
        }
        y += 1;
        line(c, &mut y, &[heading("SAVED TO")]);
        line(
            c,
            &mut y,
            &[run(self.data.config_file(), Token::Fg, Token::Bg)],
        );
        line(
            c,
            &mut y,
            &[run(
                "choices only · no secrets · no IDs in repo",
                Token::Faint,
                Token::Bg,
            )],
        );
    }
    /// The form's sections on a tall canvas; returns the focused rows.
    fn draw_form(&self, c: &mut Canvas<'_>, left: u16) -> (u16, u16) {
        // The virtual pane is tall: every block fits.
        let end = 90;
        let mut focus = (2, 2);
        let section = self.section();
        let right = left.saturating_sub(2);
        let mut y = 2;
        let mark = |c: &mut Canvas<'_>, y: u16, on: bool| {
            if on {
                c.put(0, y, &run("▌", Token::Signal, Token::Bg));
                c.cursor(y, 0, left);
            }
        };

        // ACCOUNT
        clip(
            c,
            2,
            y,
            left,
            &[
                heading("ACCOUNT"),
                run(" ".repeat(21), Token::Fg, Token::Bg),
                run("from cf auth · --account ID", Token::Faint, Token::Bg),
            ],
        );
        y += 1;
        if section == Section::Account {
            focus = (y, y + self.form.accounts.len().max(1) as u16 - 1);
        }
        for (i, account) in self.form.accounts.iter().enumerate() {
            if y > end {
                break;
            }
            let chosen = i == self.form.account;
            let id = short_id(&account.id);
            radio(
                c,
                y,
                2,
                left,
                Radio {
                    label: &account.name,
                    chosen,
                    focused: chosen && section == Section::Account,
                    note: None,
                    tag: Some(run(id, Token::Faint, Token::Bg)),
                },
            );
            y += 1;
        }
        y += 1;

        // NAME
        if y < end {
            clip(c, 2, y, left, &[heading("NAME")]);
            text_field(c, 2, y + 1, 20, &self.form.name, true, Token::Raise);
            clip(
                c,
                24,
                y + 1,
                right,
                &[run(
                    format!("prefix · {}-team for 2nd install", self.form.name),
                    Token::Faint,
                    Token::Bg,
                )],
            );
            mark(c, y + 1, section == Section::Name);
            if section == Section::Name {
                focus = (y, y + 1);
            }
            y += 3;
        }

        // RUNNER
        if y + 2 < end {
            clip(c, 2, y, left, &[heading("RUNNER")]);
            let runner = usize::from(self.form.runner == Runner::SelfHosted);
            segments(
                c,
                2,
                y + 1,
                right,
                &["Cloudflare Sandbox", "Self-hosted Docker"],
                runner,
            );
            mark(c, y + 1, section == Section::Runner);
            if section == Section::Runner {
                focus = (y, y + 3);
            }
            let (l1, l2) = match self.form.runner {
                Runner::Sandbox => (
                    "standard-4 · 4 vCPU · 12 GiB · network off · fresh per job".to_owned(),
                    format!("copies {} to your registry", self.form.runner_image),
                ),
                Runner::SelfHosted => (
                    "your Docker host pulls jobs · network off · fresh per job".to_owned(),
                    format!("runs {} on your machine", self.form.runner_image),
                ),
            };
            clip(c, 2, y + 2, right, &[run(l1, Token::Dim, Token::Bg)]);
            clip(c, 2, y + 3, right, &[run(l2, Token::Faint, Token::Bg)]);
            y += 5;
        }

        // MODEL PROVIDER
        if y + 2 < end {
            clip(c, 2, y, left, &[heading("MODEL PROVIDER")]);
            let provider = Provider::ALL
                .iter()
                .position(|p| *p == self.form.provider)
                .unwrap_or(0);
            let names: Vec<&str> = Provider::ALL.iter().map(|p| p.name()).collect();
            segments(c, 2, y + 1, right, &names, provider);
            mark(c, y + 1, section == Section::Provider);
            let ky = y + 2;
            clip(c, 2, ky, right, &[run("key", Token::Faint, Token::Bg)]);
            if self.key.is_empty() && self.key_in_env() {
                clip(
                    c,
                    7,
                    ky,
                    right,
                    &[run(
                        format!("from {}", self.form.provider.key_name()),
                        Token::Dim,
                        Token::Bg,
                    )],
                );
            } else {
                let cells = 40.min(right.saturating_sub(7 + 12));
                masked_field(
                    c,
                    7,
                    ky,
                    cells,
                    self.key.chars().count(),
                    section == Section::Key,
                    Token::Raise,
                );
                clip(
                    c,
                    9 + cells,
                    ky,
                    right,
                    &[run("✓ echo off", Token::Pass, Token::Bg)],
                );
            }
            mark(c, ky, section == Section::Key);
            if matches!(section, Section::Provider | Section::Key) {
                focus = (y, y + 3);
            }
            clip(
                c,
                2,
                y + 3,
                right,
                &[run(self.form.provider.models(), Token::Faint, Token::Bg)],
            );
            y += 5;
        }

        // CREDENTIALS
        if y + 1 < end {
            clip(c, 2, y, left, &[heading("CREDENTIALS")]);
            for (i, (store, label, note)) in [
                (CredentialStore::Keychain, "OS keychain", "default"),
                (CredentialStore::File, "file · 0600", "headless hosts"),
            ]
            .into_iter()
            .enumerate()
            {
                let chosen = self.form.credential_store == store;
                radio(
                    c,
                    y + 1 + i as u16,
                    2,
                    left,
                    Radio {
                        label,
                        chosen,
                        focused: chosen && section == Section::Credentials,
                        note: Some((18, run(note, Token::Faint, Token::Bg))),
                        tag: None,
                    },
                );
            }
            if section == Section::Credentials {
                focus = (y, y + 2);
            }
            y += 4;
        }

        // WORKERS.DEV
        if y < end {
            clip(c, 2, y, left, &[heading("WORKERS.DEV")]);
            let (host, note) = match &self.form.subdomain {
                Some(sub) => (format!("{sub}.workers.dev"), "existing subdomain · reused"),
                None => (
                    "new subdomain".to_owned(),
                    "registered at deploy · --workers-subdomain",
                ),
            };
            clip(
                c,
                2,
                y + 1,
                right,
                &[
                    run(format!("{host}  "), Token::Fg, Token::Bg),
                    run(note, Token::Faint, Token::Bg),
                ],
            );
            y += 3;
        }

        // ENDPOINT
        if y < end {
            clip(c, 2, y, left, &[heading("ENDPOINT")]);
            clip(
                c,
                2,
                y + 1,
                right,
                &[bold(self.endpoint(), Token::Signal, Token::Bg)],
            );
        }
        focus
    }
}

impl Screen for Configure {
    fn title(&self) -> &'static str {
        "Configure"
    }
    fn board(&self) -> Board {
        Board::V2
    }
    fn keys(&self) -> &'static [Key] {
        KEYS
    }
    fn wants_text(&self) -> bool {
        matches!(self.section(), Section::Name | Section::Key)
    }

    fn draw(&self, c: &mut Canvas<'_>, _session: &Session) {
        c.clear(Token::Bg);
        header(
            c,
            "rio init · deploy · step 2 of 3",
            &[
                status("● configure", Token::Signal),
                quiet(format!("rio {}", self.data.version)),
            ],
        );
        let left = split(c, 66);
        let end = content_end(c);
        scrolled(c, left, 2, end, |v| self.draw_form(v, left));
        separator(c, left, 1, c.height().saturating_sub(1));
        let right = left.saturating_sub(2);
        let hy = hint_row(c);
        if let Some(problem) = &self.problem {
            clip(
                c,
                2,
                hy.saturating_sub(1),
                right,
                &[run(format!("✕ {problem}"), Token::Fail, Token::Bg)],
            );
        }
        let mut x = chip(c, 2, hy, "⏎ deploy", 10);
        for (k, label) in [("p", "plan JSON"), ("s", "save choices for --from")] {
            let mut runs = key_hint(k, label, Token::Bg).to_vec();
            runs.insert(0, run("   ", Token::Fg, Token::Bg));
            x = clip(c, x, hy, right, &runs);
        }

        self.draw_plan(c, left + 2, end);
        keybar(c, KEYS);
    }

    fn on_key(&mut self, key: KeyEvent, _session: &mut Session) -> Action {
        match key.code {
            KeyCode::Tab => {
                self.focus = (self.focus + 1) % SECTIONS.len();
                return Action::None;
            }
            KeyCode::BackTab => {
                self.focus = (self.focus + SECTIONS.len() - 1) % SECTIONS.len();
                return Action::None;
            }
            KeyCode::Enter => return self.deploy(),
            KeyCode::Esc => return Action::Pop,
            _ => {}
        }
        match (self.section(), key.code) {
            (Section::Name, KeyCode::Char(ch)) => {
                if self.form.name.len() < 48 {
                    self.form.name.push(ch.to_ascii_lowercase());
                    self.changed();
                }
            }
            (Section::Name, KeyCode::Backspace) => {
                self.form.name.pop();
                self.changed();
            }
            (Section::Key, KeyCode::Char(ch)) => {
                self.key.push(ch);
                self.problem = None;
            }
            (Section::Key, KeyCode::Backspace) => {
                self.key.pop();
            }
            (Section::Account, KeyCode::Up | KeyCode::Char('k')) => {
                self.form.account = self.form.account.saturating_sub(1);
                self.changed();
            }
            (Section::Account, KeyCode::Down | KeyCode::Char('j')) => {
                self.form.account =
                    (self.form.account + 1).min(self.form.accounts.len().saturating_sub(1));
                self.changed();
            }
            (Section::Credentials, KeyCode::Up | KeyCode::Char('k')) => {
                self.form.credential_store = CredentialStore::Keychain;
                self.changed();
            }
            (Section::Credentials, KeyCode::Down | KeyCode::Char('j')) => {
                self.form.credential_store = CredentialStore::File;
                self.changed();
            }
            (Section::Runner, KeyCode::Left | KeyCode::Char('h')) => {
                self.form.runner = Runner::Sandbox;
                self.changed();
            }
            (Section::Runner, KeyCode::Right | KeyCode::Char('l')) => {
                self.form.runner = Runner::SelfHosted;
                self.changed();
            }
            (Section::Provider, KeyCode::Left | KeyCode::Char('h')) => {
                let i = Provider::ALL
                    .iter()
                    .position(|p| *p == self.form.provider)
                    .unwrap_or(0);
                self.form.provider = Provider::ALL[i.saturating_sub(1)];
                self.changed();
            }
            (Section::Provider, KeyCode::Right | KeyCode::Char('l')) => {
                let i = Provider::ALL
                    .iter()
                    .position(|p| *p == self.form.provider)
                    .unwrap_or(0);
                self.form.provider = Provider::ALL[(i + 1).min(Provider::ALL.len() - 1)];
                self.changed();
            }
            (_, KeyCode::Char('p')) => return self.plan(),
            (_, KeyCode::Char('s')) => {
                self.data.handoff.set_args(deploy_args(&self.form));
                return Action::Effect(Effect::Step("init:save-choices".into()));
            }
            _ => {}
        }
        Action::None
    }

    fn on_msg(&mut self, msg: &Msg, _session: &mut Session) -> Action {
        if let Msg::Done(Outcome::Value(name, value)) = msg
            && name == "init:plan"
            && let Ok(plan) = serde_json::from_value::<Plan>(value.clone())
        {
            self.form.plan = Some(plan);
            self.stale = false;
        }
        Action::None
    }
}

//! G1: the command palette.
//!
//! `:` opens it over any view. It always takes text: what the user types
//! filters (a fuzzy, case-insensitive subsequence match over each entry's
//! name, group and command line). Matching actions of the view it was opened
//! from come first; `⏎` on one closes the palette and presses that key on the
//! view ([`Action::Replay`]). Then come the `rio` commands, grouped by job in
//! the data's (recent first) order; `⏎` on one copies its exact command line
//! and shows it. `tab` puts the selected command's line in the filter so its
//! arguments can be edited; while editing, `⏎` copies the edited line.

use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use crate::{
    app::{Action, Effect, Screen, Session},
    canvas::{Canvas, bold, fit, pad, run},
    chrome::{Board, Key, focus, header, key, keybar},
    theme::Token,
};

/// One `rio` command the palette offers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Command {
    /// The job it belongs to, shown as the group heading (`QA`, `REVIEW`, `TEAM`, `SETUP`).
    pub job: String,
    /// The exact command line, copied when the command runs.
    pub cli: String,
    /// What it does, in a few words.
    pub about: String,
}

impl Command {
    pub fn new(job: &str, cli: &str, about: &str) -> Self {
        Self {
            job: job.to_owned(),
            cli: cli.to_owned(),
            about: about.to_owned(),
        }
    }
}

/// What the palette lists.
#[derive(Debug, Clone)]
pub struct PaletteData {
    /// The title of the view the palette was opened from.
    pub view: &'static str,
    /// That view's keys; the ones a key press can replay are its actions.
    pub view_keys: &'static [Key],
    /// The commands, most recently used first; groups appear in the order of
    /// their first command.
    pub commands: Vec<Command>,
}

/// Every user-facing `rio` subcommand with its key flags, grouped by job
/// (from `rio-cli`'s clap definitions; the hidden `prepare` is left out).
pub fn catalogue() -> Vec<Command> {
    const LIST: &[(&str, &str, &str)] = &[
        ("QA", "rio qa --journey checkout", "run one journey"),
        ("QA", "rio qa --full", "every journey, every cell"),
        ("QA", "rio qa --baseline", "also run every journey on base"),
        ("QA", "rio qa sync --check", "journeys that need review"),
        ("QA", "rio qa init", "agent authors from REVIEW.md"),
        (
            "QA",
            "rio qa init --accept-contract",
            "accept the reviewed proposal",
        ),
        ("QA", "rio qa init --force", "replace committed journeys"),
        ("QA", "rio qa validate", "check journeys without an app"),
        ("QA", "rio qa list", "runnable journeys and dependencies"),
        (
            "QA",
            "rio qa show checkout",
            "a journey or the contract as JSON",
        ),
        (
            "QA",
            "rio qa fixtures status",
            "uploads, doubles and messages",
        ),
        ("QA", "rio qa rules", "UI probes and the UX rubric"),
        ("QA", "rio qa seed build", "rebuild the seed snapshot"),
        ("QA", "rio qa seed status", "fingerprint and rebuild reason"),
        (
            "QA",
            "rio qa seed export seeds/",
            "export verified seed archives",
        ),
        (
            "QA",
            "rio qa seed prune --keep 3",
            "keep the newest snapshots",
        ),
        (
            "QA",
            "rio qa evidence prune --review ID",
            "delete hosted evidence",
        ),
        ("REVIEW", "rio review", "review the working tree"),
        ("REVIEW", "rio review --staged", "only the staged changes"),
        (
            "REVIEW",
            "rio review --base origin/main",
            "the branch against its base",
        ),
        (
            "REVIEW",
            "rio review --since-last",
            "next round of this lineage",
        ),
        (
            "REVIEW",
            "rio review --since-last --reset-lineage",
            "start a new generation",
        ),
        (
            "REVIEW",
            "rio review --pr 142 --publish",
            "hosted review of a PR",
        ),
        ("REVIEW", "rio review --deep", "more agents, larger budget"),
        (
            "REVIEW",
            "rio review --preset quick",
            "fewer agents, smaller budget",
        ),
        ("REVIEW", "rio review --offline", "no endpoint, local only"),
        (
            "REVIEW",
            "rio review --show-pre-existing",
            "include unchanged-code findings",
        ),
        (
            "REVIEW",
            "rio review --show-remembered",
            "list remembered dismissals",
        ),
        (
            "REVIEW",
            "rio review --format sarif",
            "print md, json or sarif",
        ),
        ("REVIEW", "rio review --no-tui", "stream plain output"),
        ("TEAM", "rio findings --status open", "the finding registry"),
        (
            "TEAM",
            "rio findings --rule RULE",
            "registry records of one rule",
        ),
        ("TEAM", "rio suppressions list", "proposals from dismissals"),
        (
            "TEAM",
            "rio suppressions apply ID",
            "write a proposal to the profile",
        ),
        (
            "TEAM",
            "rio suppressions decline ID --note TEXT",
            "decline for 180 days",
        ),
        (
            "TEAM",
            "rio feedback ID --dismiss wrong",
            "answer a posted finding",
        ),
        ("SETUP", "rio doctor", "tools, roots, cache, app"),
        (
            "SETUP",
            "rio doctor --all-roots",
            "every project, not just the diff",
        ),
        ("SETUP", "rio doctor --rotate", "rotate the webhook secret"),
        ("SETUP", "rio deploy", "upgrade the paired Worker"),
        (
            "SETUP",
            "rio deploy --dry-run",
            "an offline plan, no changes",
        ),
        ("SETUP", "rio init", "deploy rio to Cloudflare"),
        (
            "SETUP",
            "rio init --github-app",
            "register a GitHub App for PRs",
        ),
        (
            "SETUP",
            "rio init --endpoint URL --token-stdin",
            "connect an existing endpoint",
        ),
        ("SETUP", "rio profile list", "the profiles in reach"),
        ("SETUP", "rio profile show default", "one resolved profile"),
        ("SETUP", "rio profile validate", "check the profiles"),
        ("SETUP", "rio eval noise", "noise adjudication on clean PRs"),
        (
            "SETUP",
            "rio eval import-incident PR FIX_PR",
            "a PR and its fix as a case",
        ),
    ];
    LIST.iter()
        .map(|(job, cli, about)| Command::new(job, cli, about))
        .collect()
}

const KEYS: &[Key] = &[
    key("type", "filter"),
    key("↑↓", "move"),
    focus("⏎", "run"),
    key("tab", "insert args"),
    key("esc", "close"),
];

/// Something `⏎` can run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Item {
    /// A key of the view below, pressed again there.
    Action(Key, KeyCode),
    /// An index into `PaletteData::commands`.
    Command(usize),
}

enum Line {
    Heading(String),
    Blank,
    Item(usize),
    Empty,
}

/// The key code a key-bar key stands for, when pressing it can be replayed.
/// Global keys (`?`, `:`, `q`, `esc`) and key groups (`↑↓`, `[ ]`) are not
/// actions.
fn code(key: &str) -> Option<KeyCode> {
    match key {
        "⏎" => Some(KeyCode::Enter),
        "tab" => Some(KeyCode::Tab),
        "space" => Some(KeyCode::Char(' ')),
        _ => {
            let mut chars = key.chars();
            match (chars.next(), chars.next()) {
                (Some(c), None) if !matches!(c, '?' | ':' | 'q') && !c.is_whitespace() => {
                    Some(KeyCode::Char(c))
                }
                _ => None,
            }
        }
    }
}

/// `query` is a case-insensitive subsequence of `text`.
pub(crate) fn fuzzy(query: &str, text: &str) -> bool {
    let mut text = text.chars().flat_map(char::to_lowercase);
    query
        .chars()
        .flat_map(char::to_lowercase)
        .all(|q| text.any(|c| c == q))
}

pub struct Palette {
    pub data: PaletteData,
    /// The filter text.
    pub filter: String,
    /// The selected item among those listed.
    pub selected: usize,
    /// `tab` put a command line in the filter; `⏎` copies the filter.
    pub editing: bool,
    /// The last command line copied, shown in the footer.
    pub shown: Option<String>,
}

impl Palette {
    pub fn new(data: PaletteData) -> Self {
        Self {
            data,
            filter: String::new(),
            selected: 0,
            editing: false,
            shown: None,
        }
    }

    /// The items the filter keeps, in order, and the lines that list them.
    fn listing(&self) -> (Vec<Item>, Vec<Line>) {
        let q = self.filter.as_str();
        let mut items = Vec::new();
        let mut lines = Vec::new();
        if !q.is_empty() {
            let view = self.data.view;
            for k in self.data.view_keys {
                if let Some(code) = code(k.key)
                    && (fuzzy(q, k.label) || fuzzy(q, view) || fuzzy(q, k.key))
                {
                    if items.is_empty() {
                        lines.push(Line::Heading(format!("THIS VIEW  {view}")));
                    }
                    lines.push(Line::Item(items.len()));
                    items.push(Item::Action(*k, code));
                }
            }
        }
        let mut jobs: Vec<&str> = Vec::new();
        for c in &self.data.commands {
            if !jobs.contains(&c.job.as_str()) {
                jobs.push(&c.job);
            }
        }
        for job in jobs {
            let mut first = true;
            for (i, c) in self.data.commands.iter().enumerate() {
                if c.job != job
                    || !(q.is_empty() || fuzzy(q, &c.about) || fuzzy(q, job) || fuzzy(q, &c.cli))
                {
                    continue;
                }
                if first {
                    if !lines.is_empty() {
                        lines.push(Line::Blank);
                    }
                    lines.push(Line::Heading(job.to_uppercase()));
                    first = false;
                }
                lines.push(Line::Item(items.len()));
                items.push(Item::Command(i));
            }
        }
        if items.is_empty() {
            lines.push(Line::Empty);
        }
        (items, lines)
    }

    /// Draw the palette's box and key bar over whatever the canvas holds.
    pub fn draw_overlay(&self, c: &mut Canvas<'_>) {
        let (cols, rows) = (c.width(), c.height());
        let w = cols.saturating_sub(4).min(80);
        let x0 = (cols - w.min(cols)) / 2;
        let y0 = ((i32::from(rows) - 30) / 2).clamp(2, 5) as u16;
        let bottom = (y0 + 24).min(rows.saturating_sub(3));
        if w < 40 || bottom < y0 + 6 {
            keybar(c, KEYS);
            return;
        }
        let inner = usize::from(w - 4);
        let (left, right) = (x0 + 2, x0 + w - 2);
        let border = |c: &mut Canvas<'_>, y: u16| {
            c.put(x0, y, &run("│ ", Token::Signal, Token::Raise));
            c.put(right, y, &run(" │", Token::Signal, Token::Raise));
        };

        // Title.
        let title = ":  command palette ";
        let x = c.put(x0, y0, &run("┌─ ", Token::Signal, Token::Raise));
        let x = c.put(x, y0, &bold(title, Token::Fg, Token::Raise));
        let rest = usize::from(x0 + w).saturating_sub(usize::from(x) + 1);
        c.put(
            x,
            y0,
            &run(
                format!("{}┐", "─".repeat(rest)),
                Token::Signal,
                Token::Raise,
            ),
        );

        // Filter.
        let y = y0 + 1;
        border(c, y);
        c.fill(y, left, right, Token::Raise);
        let shown = fit(&self.filter, inner.saturating_sub(6));
        let x = c.put(left, y, &bold("  : ", Token::Signal, Token::Raise));
        let x = c.put(x, y, &bold(shown, Token::Fg, Token::Raise));
        let end = c.put(x, y, &run("█", Token::Fg, Token::Raise));
        let recent = left + (w - 4).saturating_sub(29);
        if end < recent {
            c.put(recent, y, &run("recent first", Token::Faint, Token::Raise));
        }

        // Rule.
        border(c, y0 + 2);
        c.put(
            left,
            y0 + 2,
            &run("─".repeat(inner), Token::Rule, Token::Raise),
        );

        // The list, scrolled to keep the selection in view.
        let (items, lines) = self.listing();
        let selected = self.selected.min(items.len().saturating_sub(1));
        let top = y0 + 3;
        let height = usize::from(bottom.saturating_sub(2).saturating_sub(top));
        let at = lines
            .iter()
            .position(|l| matches!(l, Line::Item(i) if *i == selected))
            .unwrap_or(0);
        let offset = (at + 1).saturating_sub(height);
        let cmd = 36.min(inner.saturating_sub(4));
        let about = inner.saturating_sub(cmd + 2);
        for row in 0..height {
            let y = top + row as u16;
            border(c, y);
            c.fill(y, left, right, Token::Raise);
            match lines.get(offset + row) {
                Some(Line::Heading(h)) => {
                    c.put(
                        left,
                        y,
                        &bold(
                            format!("  {}", fit(h, inner - 2)),
                            Token::Faint,
                            Token::Raise,
                        ),
                    );
                }
                Some(Line::Empty) => {
                    let text = if self.editing {
                        "  ⏎ copies the edited line"
                    } else {
                        "  nothing matches"
                    };
                    c.put(left, y, &run(text, Token::Faint, Token::Raise));
                }
                Some(Line::Item(i)) => {
                    let (name, what) = match items[*i] {
                        Item::Action(k, _) => (k.label.to_owned(), format!("key {}", k.key)),
                        Item::Command(n) => {
                            let command = &self.data.commands[n];
                            (command.cli.clone(), command.about.clone())
                        }
                    };
                    if *i == selected {
                        c.put(left, y, &run("▌ ", Token::Signal, Token::Signal));
                        c.put(
                            left + 2,
                            y,
                            &bold(pad(&name, cmd), Token::Bg, Token::Signal),
                        );
                        c.put(
                            left + 2 + cmd as u16,
                            y,
                            &run(pad(&what, about), Token::Bg, Token::Signal),
                        );
                        c.cursor(y, left, right);
                    } else {
                        c.put(
                            left,
                            y,
                            &run(format!("  {}", pad(&name, cmd)), Token::Fg, Token::Raise),
                        );
                        c.put(
                            left + 2 + cmd as u16,
                            y,
                            &run(fit(&what, about), Token::Faint, Token::Raise),
                        );
                    }
                }
                Some(Line::Blank) | None => {}
            }
        }

        // Footer.
        for y in [bottom - 2, bottom - 1] {
            border(c, y);
            c.fill(y, left, right, Token::Raise);
        }
        match &self.shown {
            Some(line) => {
                let x = c.put(
                    left,
                    bottom - 1,
                    &run("  copied  ", Token::Faint, Token::Raise),
                );
                c.put(
                    x,
                    bottom - 1,
                    &bold(fit(line, inner - 10), Token::Fg, Token::Raise),
                );
            }
            None => {
                let text = "  Every action prints its CLI line, so you can script it.";
                c.put(
                    left,
                    bottom - 1,
                    &run(fit(text, inner), Token::Faint, Token::Raise),
                );
            }
        }
        c.put(
            x0,
            bottom,
            &run(
                format!("└{}┘", "─".repeat(usize::from(w - 2))),
                Token::Signal,
                Token::Raise,
            ),
        );
        keybar(c, KEYS);
    }

    fn run_selected(&mut self) -> Action {
        if self.editing && !self.filter.trim().is_empty() {
            let line = self.filter.trim().to_owned();
            self.shown = Some(line.clone());
            return Action::Effect(Effect::Copy(line));
        }
        let (items, _) = self.listing();
        match items.get(self.selected) {
            Some(Item::Action(_, code)) => Action::Replay(KeyEvent::new(*code, KeyModifiers::NONE)),
            Some(Item::Command(n)) => {
                let line = self.data.commands[*n].cli.clone();
                self.shown = Some(line.clone());
                Action::Effect(Effect::Copy(line))
            }
            None => Action::Many(Vec::new()),
        }
    }

    fn filter_changed(&mut self) {
        self.selected = 0;
        if self.filter.is_empty() {
            self.editing = false;
        }
    }
}

impl Screen for Palette {
    fn title(&self) -> &'static str {
        "Command palette"
    }
    fn board(&self) -> Board {
        Board::V3
    }
    fn keys(&self) -> &'static [Key] {
        KEYS
    }
    fn floats(&self) -> bool {
        true
    }
    fn draw(&self, c: &mut Canvas<'_>, _: &Session) {
        c.clear(Token::Bg);
        header(c, Board::V3, self.data.view, &[]);
        self.draw_overlay(c);
    }
    fn draw_over(&self, c: &mut Canvas<'_>, _: &Session) {
        self.draw_overlay(c);
    }
    fn on_key(&mut self, key: KeyEvent, _: &mut Session) -> Action {
        match key.code {
            KeyCode::Esc => return Action::Pop,
            KeyCode::Enter => return self.run_selected(),
            KeyCode::Up => self.selected = self.selected.saturating_sub(1),
            KeyCode::Down => {
                let count = self.listing().0.len();
                self.selected = (self.selected + 1).min(count.saturating_sub(1));
            }
            KeyCode::Tab => {
                let (items, _) = self.listing();
                if let Some(Item::Command(n)) = items.get(self.selected) {
                    self.filter = self.data.commands[*n].cli.clone();
                    self.filter_changed();
                    self.editing = true;
                }
            }
            KeyCode::Backspace => {
                self.filter.pop();
                self.filter_changed();
            }
            KeyCode::Char(ch) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.filter.push(ch);
                self.filter_changed();
            }
            _ => {}
        }
        Action::None
    }
    fn wants_text(&self) -> bool {
        true
    }
}

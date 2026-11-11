//! 00 — Start: what to review, profile and preset, options, the changed
//! files, the doctor preflight, and the equivalent command line.

use ratatui::crossterm::event::{KeyCode, KeyEvent};
use rio_core::CheckKind;

use super::{
    chip, hints, hrule, live,
    live::{CheckRow, ItemState, LiveData, LiveState, RootRow},
    put_in, vrule, wrap,
};
use crate::{
    app::{Action, Effect, Screen, Session},
    canvas::{Canvas, Run, bold, pad, run, width},
    chrome::{Board, Key, key, keybar, status},
    theme::Token,
};

/// Which changes a review covers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelectionKind {
    /// HEAD against its merge base with the base ref (`--base REF`).
    Branch,
    /// Tree, staged and untracked changes against HEAD (no flag).
    WorkingTree,
    /// The index against HEAD (`--staged`).
    Staged,
}

/// One change selection with its size.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangeSet {
    /// The selection this describes.
    pub kind: SelectionKind,
    /// What it compares, e.g. `tree + staged + untracked vs HEAD`.
    pub description: String,
    /// Changed files.
    pub files: usize,
    /// Added lines.
    pub added: usize,
    /// Removed lines.
    pub removed: usize,
    /// The changed files to list (the first ones are shown, then `… n more`).
    pub listed: Vec<ChangedFile>,
}

/// A changed file of a selection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangedFile {
    /// Git's status letter: `M`, `A`, `D`, `R`.
    pub status: char,
    /// Repository-relative path.
    pub path: String,
    /// Added lines.
    pub added: usize,
    /// Removed lines.
    pub removed: usize,
}

/// A preset the start screen offers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PresetInfo {
    /// `quick`, `standard` or `deep`.
    pub name: String,
    /// What it runs, e.g. `triage + 5 agents + quorum 3`.
    pub description: String,
    /// The agents it runs, in order, for the live screen.
    pub agents: Vec<String>,
    /// Verifiers per hypothesis.
    pub quorum: u32,
}

/// One project root of the doctor preflight.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DoctorRoot {
    /// The root as the report names it, e.g. `web/`.
    pub root: String,
    /// Its language, e.g. `typescript`.
    pub language: String,
    /// The lockfile the root resolves dependencies from.
    pub lockfile: Option<String>,
    /// The check tools found or missing.
    pub tools: Vec<DoctorTool>,
    /// Whether installed dependencies match the lockfile, when checked.
    pub lockfile_matches: Option<bool>,
}

/// A check tool of a root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DoctorTool {
    /// Executable name, e.g. `tsc`.
    pub name: String,
    /// Its version; `None` when the tool is missing.
    pub version: Option<String>,
    /// The check it runs: `typecheck`, `lint` or `coverage`.
    pub role: String,
}

/// The outcome of a machine check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MachineState {
    /// Passed (`✓`).
    Ok,
    /// Failed (`✕`); the review can't start.
    Failed,
    /// Information only (`·`).
    Info,
}

/// A machine check of the preflight (cache, endpoint, budget).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MachineCheck {
    /// Its outcome.
    pub state: MachineState,
    /// What was checked and found.
    pub text: String,
}

/// Everything the start screen shows; flags given on the command line set the
/// initial choices.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartData {
    /// The repository path as shown, e.g. `~/code/web-app`.
    pub repository: String,
    /// The checked-out branch.
    pub branch: String,
    /// Rio's version.
    pub version: String,
    /// The base ref of the branch selection.
    pub base: String,
    /// The three selections, in display order.
    pub changes: Vec<ChangeSet>,
    /// The initially selected changes.
    pub selection: SelectionKind,
    /// Profiles to choose from (`←→` on the profile row).
    pub profiles: Vec<String>,
    /// The initially chosen profile.
    pub profile: String,
    /// The file the profile choice comes from.
    pub profile_source: String,
    /// Presets in display order.
    pub presets: Vec<PresetInfo>,
    /// The initially chosen preset's name.
    pub preset: String,
    /// `--since-last` is on.
    pub since_last: bool,
    /// What `--since-last` continues, e.g. `continue lineage · next is round 4 of cap 3`.
    pub since_last_note: String,
    /// The next lineage round exceeds the cap (the note is a warning).
    pub since_last_capped: bool,
    /// `--offline` is on.
    pub offline: bool,
    /// `--show-pre-existing` is on.
    pub show_pre_existing: bool,
    /// The doctor preflight per root.
    pub roots: Vec<DoctorRoot>,
    /// The doctor's machine checks.
    pub machine: Vec<MachineCheck>,
    /// Preflight warnings.
    pub warnings: Vec<String>,
    /// The live screen's footer line, e.g. `hops 2 · max 2000 nodes · tools not network-isolated`.
    pub live_note: String,
}

const KEYS: &[Key] = &[
    key("↑↓", "select"),
    key("←→", "preset"),
    key("space", "toggle"),
    key("tab", "section"),
    key("⏎", "start"),
    key("c", "copy cmd"),
    key("?", "help"),
    key("q", "quit"),
];

const SELECTIONS: [(SelectionKind, &str); 3] = [
    (SelectionKind::Branch, "branch vs base"),
    (SelectionKind::WorkingTree, "working tree"),
    (SelectionKind::Staged, "staged"),
];

const OPTIONS: [&str; 3] = ["since-last", "offline", "show pre-existing"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Section {
    Selection,
    Profile,
    Options,
}

pub(crate) struct StartScreen {
    data: StartData,
    section: Section,
    selection: usize,
    profile: usize,
    preset: usize,
    /// 0 the profile row, 1 the preset row.
    depth_row: usize,
    option: usize,
    options: [bool; 3],
    /// Builds the findings screen's data when the host has more than the report.
    on_report: Option<super::SharedFindingsBuilder>,
}

impl StartScreen {
    /// Use `on_report` to build the findings screen from the final report.
    pub(crate) fn with_findings(mut self, on_report: super::SharedFindingsBuilder) -> Self {
        self.on_report = Some(on_report);
        self
    }

    pub(crate) fn new(data: StartData) -> Self {
        let selection = SELECTIONS
            .iter()
            .position(|(kind, _)| *kind == data.selection)
            .unwrap_or(0);
        let profile = data
            .profiles
            .iter()
            .position(|p| *p == data.profile)
            .unwrap_or(0);
        let preset = data
            .presets
            .iter()
            .position(|p| p.name == data.preset)
            .unwrap_or(0);
        let options = [data.since_last, data.offline, data.show_pre_existing];
        Self {
            data,
            section: Section::Selection,
            selection,
            profile,
            preset,
            depth_row: 1,
            option: 0,
            options,
            on_report: None,
        }
    }

    fn kind(&self) -> SelectionKind {
        SELECTIONS[self.selection.min(2)].0
    }

    fn profile_name(&self) -> String {
        self.data
            .profiles
            .get(self.profile)
            .cloned()
            .unwrap_or_else(|| self.data.profile.clone())
    }

    fn preset_info(&self) -> Option<&PresetInfo> {
        self.data.presets.get(self.preset)
    }

    fn preset_name(&self) -> String {
        self.preset_info()
            .map(|p| p.name.clone())
            .unwrap_or_else(|| self.data.preset.clone())
    }

    fn change_set(&self) -> Option<&ChangeSet> {
        self.data.changes.iter().find(|c| c.kind == self.kind())
    }

    /// The flag groups after `rio review`, as the command line shows them.
    fn groups(&self) -> Vec<Vec<String>> {
        let mut groups = Vec::new();
        match self.kind() {
            SelectionKind::Branch => groups.push(vec!["--base".into(), self.data.base.clone()]),
            SelectionKind::WorkingTree => {}
            SelectionKind::Staged => groups.push(vec!["--staged".into()]),
        }
        // Presets need an endpoint; without one the host offers none.
        if !self.data.presets.is_empty() {
            groups.push(vec!["--preset".into(), self.preset_name()]);
        }
        let profile = self.profile_name();
        if !profile.is_empty() {
            groups.push(vec!["--profile".into(), profile]);
        }
        for (on, flag) in
            self.options
                .iter()
                .zip(["--since-last", "--offline", "--show-pre-existing"])
        {
            if *on {
                groups.push(vec![flag.into()]);
            }
        }
        groups
    }

    /// The arguments of the shown command line, after `rio`.
    pub(crate) fn args(&self) -> Vec<String> {
        let mut args = vec!["review".to_owned()];
        args.extend(self.groups().into_iter().flatten());
        args
    }

    /// The shown command line on one line.
    pub(crate) fn command(&self) -> String {
        format!("rio {}", self.args().join(" "))
    }

    /// The command line wrapped at flag groups into lines of at most `max` cells.
    fn command_lines(&self, first: &str, rest: &str, max: usize) -> Vec<String> {
        command_lines(&self.groups(), first, rest, max)
    }

    fn live_data(&self) -> LiveData {
        let data = &self.data;
        let base = match self.kind() {
            SelectionKind::Branch => format!(" → {}", data.base),
            SelectionKind::WorkingTree => " · working tree".into(),
            SelectionKind::Staged => " · staged".into(),
        };
        let context = format!(
            "{}{base} · {} · {}",
            data.branch,
            self.profile_name(),
            self.preset_name()
        );
        let mut state = LiveState::new(
            self.preset_info()
                .map(|p| p.agents.clone())
                .unwrap_or_default(),
        );
        state.quorum = self.preset_info().map_or(0, |p| p.quorum);
        for root in &data.roots {
            state.roots.push(RootRow {
                root: root.root.clone(),
                language: root.language.clone(),
            });
            for tool in &root.tools {
                let Some(kind) = check_kind(&tool.role) else {
                    continue;
                };
                let mut row = CheckRow::new(&root.root, kind, &tool.role, &tool.name);
                if tool.version.is_none() {
                    row.state = ItemState::Skipped;
                    row.note = format!("skipped: {} missing", tool.name);
                }
                state.checks.push(row);
            }
        }
        state
            .checks
            .push(CheckRow::new(".", CheckKind::Secrets, "secrets", "secrets"));
        let mut audit = CheckRow::new(".", CheckKind::Dependencies, "audit", "osv");
        if self.options[1] {
            audit.state = ItemState::Skipped;
            audit.note = "skipped: offline".into();
        }
        state.checks.push(audit);
        let mut live = LiveData::new(
            context,
            self.command(),
            format!("Reviewing {}", data.branch),
            state,
        );
        live.note = data.live_note.clone();
        if let Some(build) = &self.on_report {
            let build = build.clone();
            live.on_report = Box::new(move |report| build(report));
        }
        live
    }

    fn change(&mut self, delta: isize) {
        match self.section {
            Section::Selection => self.selection = step(self.selection, delta, 3),
            Section::Profile => self.depth_row = step(self.depth_row, delta, 2),
            Section::Options => self.option = step(self.option, delta, 3),
        }
    }

    fn cycle(&mut self, delta: isize) {
        if self.section == Section::Profile && self.depth_row == 0 {
            self.profile = cycle(self.profile, delta, self.data.profiles.len());
        } else {
            self.preset = cycle(self.preset, delta, self.data.presets.len());
        }
    }
}

/// `CheckKind` of a doctor role.
fn check_kind(role: &str) -> Option<CheckKind> {
    match role {
        "typecheck" => Some(CheckKind::Typecheck),
        "lint" => Some(CheckKind::Lint),
        "coverage" => Some(CheckKind::Coverage),
        "secrets" => Some(CheckKind::Secrets),
        "audit" | "dependencies" => Some(CheckKind::Dependencies),
        _ => None,
    }
}

fn step(i: usize, delta: isize, len: usize) -> usize {
    i.saturating_add_signed(delta).min(len.saturating_sub(1))
}

fn cycle(i: usize, delta: isize, len: usize) -> usize {
    if len == 0 {
        return 0;
    }
    (i as isize + delta).rem_euclid(len as isize) as usize
}

/// `rio review` and the flag groups wrapped into lines of at most `max`
/// cells: the first line starts with `first`, the next ones with `rest`.
pub(crate) fn command_lines(
    groups: &[Vec<String>],
    first: &str,
    rest: &str,
    max: usize,
) -> Vec<String> {
    let mut lines = vec![first.to_owned()];
    for group in groups {
        let part = format!(" {}", group.join(" "));
        let last = lines.last_mut().expect("lines is never empty");
        if width(last) + width(&part) > max && width(last) > width(rest) {
            lines.push(format!("{rest}{part}"));
        } else {
            last.push_str(&part);
        }
    }
    lines
}

/// `+a −r`, leaving out a zero side.
fn line_delta(added: usize, removed: usize) -> String {
    match (added, removed) {
        (a, 0) => format!("+{a}"),
        (0, r) => format!("−{r}"),
        (a, r) => format!("+{a} −{r}"),
    }
}

fn file_count(n: usize) -> String {
    if n == 1 {
        "1 file".into()
    } else {
        format!("{n} files")
    }
}

const ART: [&str; 5] = [
    "      ██████",
    "    ██████████                ",
    "  ████      ██████      ██    ",
    "  ██          ████████████    ",
    "                  ██████",
];

impl Screen for StartScreen {
    fn title(&self) -> &'static str {
        "Review start"
    }
    fn board(&self) -> Board {
        Board::V2
    }
    fn keys(&self) -> &'static [Key] {
        KEYS
    }

    fn draw(&self, c: &mut Canvas<'_>, _session: &Session) {
        c.clear(Token::Bg);
        let data = &self.data;
        let ready = !data.machine.iter().any(|m| m.state == MachineState::Failed);
        let right = [
            if ready {
                status("● ready", Token::Pass)
            } else {
                status("✕ not ready", Token::Fail)
            },
            crate::chrome::quiet(format!("rio {}", data.version)),
        ];
        super::head(c, &format!("{} · {}", data.repository, data.branch), &right);
        let (w, h) = (c.width(), c.height());
        // The banner only when there is room for it.
        let b: u16 = if h >= 36 {
            for (i, line) in ART.iter().enumerate() {
                c.put(0, 2 + i as u16, &run(*line, Token::Fg, Token::Bg));
            }
            c.puts(
                30,
                3,
                &[
                    bold("rio", Token::Fg, Token::Bg),
                    run(" ", Token::Fg, Token::Bg),
                    run(
                        "review local changes before they merge",
                        Token::Dim,
                        Token::Bg,
                    ),
                ],
            );
            c.put(
                30,
                4,
                &run(
                    "deterministic checks · impact graph · agents · blind verify",
                    Token::Faint,
                    Token::Bg,
                ),
            );
            c.put(
                30,
                5,
                &run(
                    "github.com/pixelinfinito/rio · Apache-2.0",
                    Token::Faint,
                    Token::Bg,
                ),
            );
            8
        } else {
            1
        };
        hrule(c, b, 0, w);
        let div = if w >= 120 { 73 } else { w * 73 / 120 };
        let lr = div - 2;
        let bottom = h.saturating_sub(1);
        vrule(c, div, b + 1, bottom);
        self.draw_left(c, b, lr);
        self.draw_right(c, b, div + 2, w.saturating_sub(1));
        keybar(c, KEYS);
    }

    fn on_key(&mut self, key: KeyEvent, _session: &mut Session) -> Action {
        match key.code {
            KeyCode::Up | KeyCode::Char('k') => self.change(-1),
            KeyCode::Down | KeyCode::Char('j') => self.change(1),
            KeyCode::Left | KeyCode::Char('h') => self.cycle(-1),
            KeyCode::Right | KeyCode::Char('l') => self.cycle(1),
            KeyCode::Tab => {
                self.section = match self.section {
                    Section::Selection => Section::Profile,
                    Section::Profile => Section::Options,
                    Section::Options => Section::Selection,
                }
            }
            KeyCode::BackTab => {
                self.section = match self.section {
                    Section::Selection => Section::Options,
                    Section::Profile => Section::Selection,
                    Section::Options => Section::Profile,
                }
            }
            KeyCode::Char(' ') => match self.section {
                Section::Options => {
                    let i = self.option.min(2);
                    self.options[i] = !self.options[i];
                }
                Section::Profile => self.cycle(1),
                Section::Selection => {}
            },
            KeyCode::Enter => {
                return Action::Many(vec![
                    Action::Effect(Effect::Start(self.args())),
                    Action::Replace(live(self.live_data())),
                ]);
            }
            KeyCode::Char('c') => return Action::Effect(Effect::Copy(self.command())),
            KeyCode::Char('d') => return Action::Effect(Effect::Step("review:doctor".into())),
            _ => {}
        }
        Action::None
    }
}

impl StartScreen {
    fn cursor_row(&self, c: &mut Canvas<'_>, y: u16, focused: bool, right: u16) -> Token {
        if focused {
            c.fill(y, 0, right, Token::Raise);
            c.put(0, y, &run("▌", Token::Signal, Token::Raise));
            c.cursor(y, 0, right);
            Token::Raise
        } else {
            Token::Bg
        }
    }

    fn draw_left(&self, c: &mut Canvas<'_>, b: u16, lr: u16) {
        let data = &self.data;
        let div = lr + 2;
        let h = c.height();
        let section = |title: &str| bold(title, Token::Faint, Token::Bg);
        // What to review.
        c.put(2, b + 1, &section("WHAT TO REVIEW"));
        for (i, (kind, label)) in SELECTIONS.iter().enumerate() {
            let y = b + 2 + i as u16;
            let focused = self.section == Section::Selection && self.selection == i;
            let selected = self.selection == i;
            let bg = self.cursor_row(c, y, focused, div);
            let set = data.changes.iter().find(|s| s.kind == *kind);
            let mut runs = vec![
                if selected {
                    run("(•)", Token::Signal, bg)
                } else {
                    run("( )", Token::Faint, bg)
                },
                run(" ", Token::Fg, bg),
                if selected {
                    bold(pad(label, 14), Token::Fg, bg)
                } else {
                    run(pad(label, 14), Token::Dim, bg)
                },
                run("  ", Token::Fg, bg),
            ];
            if *kind == SelectionKind::Branch {
                runs.push(run("vs merge base of", Token::Faint, bg));
                runs.push(run(" ", Token::Fg, bg));
                runs.push(run(format!("{} ▾", data.base), Token::Fg, Token::Panel));
            } else if let Some(set) = set {
                runs.push(run(set.description.clone(), Token::Faint, bg));
            }
            let end = put_in(c, 2, y, lr, &runs);
            if let Some(set) = set {
                if selected {
                    let text = format!(
                        " {} {}",
                        file_count(set.files),
                        line_delta(set.added, set.removed)
                    );
                    put_in(c, end, y, lr, &[run(text, Token::Fg, bg)]);
                } else {
                    let text = format!(
                        "{}  {}",
                        file_count(set.files),
                        line_delta(set.added, set.removed)
                    );
                    if end + 1 + width(&text) as u16 <= lr {
                        c.put_right(lr, y, &[run(text, Token::Faint, bg)]);
                    }
                }
            }
        }
        // Profile and depth.
        c.put(2, b + 6, &section("PROFILE & DEPTH"));
        let y = b + 7;
        let bg = self.cursor_row(
            c,
            y,
            self.section == Section::Profile && self.depth_row == 0,
            div,
        );
        put_in(
            c,
            2,
            y,
            lr,
            &[
                run("profile", Token::Faint, bg),
                run("   ", Token::Fg, bg),
                run(format!("{} ▾", self.profile_name()), Token::Fg, bg),
                run("   ", Token::Fg, bg),
                run(format!("from {}", data.profile_source), Token::Faint, bg),
            ],
        );
        let y = b + 8;
        let bg = self.cursor_row(
            c,
            y,
            self.section == Section::Profile && self.depth_row == 1,
            div,
        );
        let mut runs = vec![run("preset", Token::Faint, bg), run("    ", Token::Fg, bg)];
        for (i, preset) in data.presets.iter().enumerate() {
            let text = format!(" {} ", preset.name);
            runs.push(if i == self.preset {
                bold(text, Token::Bg, Token::Signal)
            } else {
                run(text, Token::Dim, bg)
            });
        }
        runs.push(run("  ", Token::Fg, bg));
        if let Some(preset) = self.preset_info() {
            runs.push(run(preset.description.clone(), Token::Faint, bg));
        }
        put_in(c, 2, y, lr, &runs);
        // Options.
        c.put(2, b + 10, &section("OPTIONS"));
        let notes = [
            data.since_last_note.as_str(),
            "no network calls by rio",
            "include findings outside changed hunks",
        ];
        for (i, label) in OPTIONS.iter().enumerate() {
            let y = b + 11 + i as u16;
            let bg = self.cursor_row(
                c,
                y,
                self.section == Section::Options && self.option == i,
                div,
            );
            let on = self.options[i];
            let note_fg = if i == 0 && on && data.since_last_capped {
                Token::Warn
            } else {
                Token::Faint
            };
            put_in(
                c,
                2,
                y,
                lr,
                &[
                    if on {
                        run("[x]", Token::Signal, bg)
                    } else {
                        run("[ ]", Token::Faint, bg)
                    },
                    run(format!(" {}", pad(label, 20)), Token::Fg, bg),
                    run(notes[i], note_fg, bg),
                ],
            );
        }
        // The command line, anchored to the bottom.
        let chips = h.saturating_sub(3);
        let box_rows = 2u16;
        let label = chips.saturating_sub(box_rows + 3);
        let lines = self.command_lines(" $ rio review", "    ", usize::from(lr - 2));
        // Changed files between the options and the command.
        let files_top = b + 15;
        if let Some(set) = self.change_set()
            && files_top + 2 < label
        {
            c.put(
                2,
                files_top,
                &section(&format!(
                    "CHANGES · {}",
                    file_count(set.files).to_uppercase()
                )),
            );
            let room = usize::from(label - files_top - 2);
            let more = set.files.saturating_sub(set.listed.len());
            let shown = if set.listed.len() > room || more > 0 {
                set.listed.len().min(room.saturating_sub(1))
            } else {
                set.listed.len()
            };
            for (i, file) in set.listed.iter().take(shown).enumerate() {
                let y = files_top + 1 + i as u16;
                let fg = match file.status {
                    'A' => Token::Pass,
                    'D' => Token::Fail,
                    'R' => Token::Signal,
                    _ => Token::Warn,
                };
                let counts = line_delta(file.added, file.removed);
                let path_room = usize::from(lr - 5).saturating_sub(width(&counts) + 1);
                c.puts(
                    2,
                    y,
                    &[
                        run(file.status.to_string(), fg, Token::Bg),
                        run("  ", Token::Fg, Token::Bg),
                        run(
                            super::short_path(&file.path, path_room),
                            Token::Dim,
                            Token::Bg,
                        ),
                    ],
                );
                c.put_right(lr, y, &[run(counts, Token::Faint, Token::Bg)]);
            }
            let hidden = set.files.saturating_sub(shown);
            if hidden > 0 {
                c.put(
                    5,
                    files_top + 1 + shown as u16,
                    &run(format!("… {hidden} more"), Token::Faint, Token::Bg),
                );
            }
        }
        c.put(2, label, &section("COMMAND"));
        for (i, line) in lines.iter().take(usize::from(box_rows)).enumerate() {
            let y = label + 1 + i as u16;
            c.fill(y, 2, lr, Token::Panel);
            put_in(c, 2, y, lr, &[run(line.clone(), Token::Fg, Token::Panel)]);
        }
        let x = chip(c, 2, chips, "⏎ start review");
        hints(
            c,
            x,
            chips,
            lr,
            Token::Bg,
            &[("c", "copy command"), ("d", "doctor details")],
        );
    }

    fn draw_right(&self, c: &mut Canvas<'_>, b: u16, x: u16, right: u16) {
        let data = &self.data;
        let limit = c.height().saturating_sub(1);
        c.put(
            x,
            b + 1,
            &bold("PREFLIGHT · rio doctor", Token::Faint, Token::Bg),
        );
        let mut y = b + 3;
        let role_x = x + 26;
        let item = |c: &mut Canvas<'_>, y: u16, glyph: Run, text: Run, role: Option<Run>| {
            put_in(
                c,
                x + 1,
                y,
                right,
                &[glyph, run(" ", Token::Fg, Token::Bg), text],
            );
            if let Some(role) = role
                && role_x < right
            {
                put_in(c, role_x, y, right, &[role]);
            }
        };
        for root in &data.roots {
            let mut detail = root.language.clone();
            if let Some(lock) = &root.lockfile {
                detail = format!("{detail} · {lock}");
            }
            put_in(
                c,
                x,
                y,
                right,
                &[
                    bold(root.root.clone(), Token::Fg, Token::Bg),
                    run("  ", Token::Fg, Token::Bg),
                    run(detail, Token::Faint, Token::Bg),
                ],
            );
            y += 1;
            for tool in &root.tools {
                match &tool.version {
                    Some(version) => item(
                        c,
                        y,
                        run("✓", Token::Pass, Token::Bg),
                        run(
                            pad(&format!("{} {version}", tool.name), 22),
                            Token::Dim,
                            Token::Bg,
                        ),
                        Some(run(tool.role.clone(), Token::Faint, Token::Bg)),
                    ),
                    None => item(
                        c,
                        y,
                        run("✕", Token::Warn, Token::Bg),
                        run(
                            pad(&format!("{} missing", tool.name), 22),
                            Token::Warn,
                            Token::Bg,
                        ),
                        Some(run(format!("{} skips", tool.role), Token::Warn, Token::Bg)),
                    ),
                }
                y += 1;
            }
            match root.lockfile_matches {
                Some(true) => {
                    item(
                        c,
                        y,
                        run("✓", Token::Pass, Token::Bg),
                        run("deps match lockfile", Token::Dim, Token::Bg),
                        None,
                    );
                    y += 1;
                }
                Some(false) => {
                    item(
                        c,
                        y,
                        run("✕", Token::Warn, Token::Bg),
                        run("deps differ from lockfile", Token::Warn, Token::Bg),
                        None,
                    );
                    y += 1;
                }
                None => {}
            }
            y += 1;
        }
        put_in(c, x, y, right, &[bold("machine", Token::Fg, Token::Bg)]);
        y += 1;
        for check in &data.machine {
            let glyph = match check.state {
                MachineState::Ok => run("✓", Token::Pass, Token::Bg),
                MachineState::Failed => run("✕", Token::Fail, Token::Bg),
                MachineState::Info => run("·", Token::Faint, Token::Bg),
            };
            item(
                c,
                y,
                glyph,
                run(check.text.clone(), Token::Dim, Token::Bg),
                None,
            );
            y += 1;
        }
        if data.warnings.is_empty() {
            return;
        }
        y += 2;
        let wrap_at = usize::from(right.saturating_sub(x + 2)).min(36);
        let count = data.warnings.len();
        let mut rows = vec![(bold(
            format!("{count} warning{}", if count == 1 { "" } else { "s" }),
            Token::Warn,
            Token::Panel,
        ),)];
        for warning in &data.warnings {
            for line in wrap(warning, wrap_at.max(10)) {
                rows.push((run(line, Token::Dim, Token::Panel),));
            }
        }
        for (text,) in rows {
            if y >= limit {
                break;
            }
            c.fill(y, x, right, Token::Panel);
            put_in(
                c,
                x,
                y,
                right,
                &[
                    run("▌", Token::Warn, Token::Panel),
                    run(" ", Token::Fg, Token::Panel),
                    text,
                ],
            );
            y += 1;
        }
    }
}

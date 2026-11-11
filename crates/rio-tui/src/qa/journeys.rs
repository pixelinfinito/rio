//! Q1: the journeys, their selection and coverage, and the run's setup.

use ratatui::crossterm::event::{KeyCode, KeyEvent};

use super::{
    CellId, CellOutcome, MatrixData, Pane, body_bottom, border, clip, footer, kilo, mark, tabs,
    wide,
};
use crate::{
    app::{Action, Effect, Screen, Session},
    canvas::{Canvas, bold, pad, run},
    chrome::{self, Board, Key, focus, key},
    theme::Token,
};

/// Everything Q1 shows: `.rio/qa.yaml`, the journeys, and the run's setup.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct JourneysData {
    /// The project name from the QA config (`shop-demo`).
    pub project: String,
    /// The QA config path (`.rio/qa.yaml`).
    pub config: String,
    /// Selection mode: `changed` or `full`.
    pub mode: String,
    /// Where the app runs (`docker · pod`).
    pub runtime: String,
    /// Personas and whether their credentials resolve.
    pub personas: Vec<Persona>,
    /// The cells every journey runs in.
    pub cells: Vec<CellId>,
    /// Files changed against the base, with guidance edits.
    pub changed: Vec<ChangedFile>,
    /// `max_journeys`.
    pub cap: u32,
    /// Every journey, in the order the list shows them.
    pub journeys: Vec<Journey>,
    /// Candidates in `.rio/qa.proposed.yaml`, if any.
    pub proposed: Option<Proposed>,
    /// The result of `rio qa sync --check`.
    pub sync: SyncStatus,
    /// The seed snapshot.
    pub seed: Seed,
    /// The agent harness and the sandbox.
    pub harness: Harness,
    /// The run budget.
    pub budget: Budget,
    /// Estimated wall time per cell, in milliseconds.
    pub ms_per_cell: u32,
}

/// A persona of the QA config.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Persona {
    pub name: String,
    /// Its credentials resolve (or it needs none).
    pub ready: bool,
    /// `creds ok`, `no login`, `missing RIO_QA_ADMIN`.
    pub note: String,
}

/// A changed file and how many lines it adds.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChangedFile {
    /// Git status letter (`M`, `A`, `D`).
    pub status: char,
    pub path: String,
    pub added: u32,
    /// A note shown under the file (`guidance edited`).
    pub note: Option<String>,
}

/// Why a journey is or is not selected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Why {
    /// Its covered paths match a changed file (the pattern).
    Covers(String),
    /// Owner guidance asks for it (the `REVIEW.md` section).
    Guidance(String),
    /// Its covered code changed since the journey was written.
    Drift,
    /// A dependency of the named journey; runs whenever that one runs.
    ChainedBy(String),
    /// Held back (`cap`, `missing_credentials`).
    Held(String),
    /// No changed file matches it.
    NotCovered,
    /// Tagged `smoke`: always selected first.
    Smoke,
}

impl Why {
    fn text(&self) -> (String, Token) {
        match self {
            Why::Covers(pattern) => (format!("covers {pattern}"), Token::Dim),
            Why::Guidance(section) => (format!("§{section}"), Token::Warn),
            Why::Drift => ("◐ drift".into(), Token::Warn),
            Why::ChainedBy(journey) => (format!("chained by {journey}"), Token::Faint),
            Why::Held(reason) => (format!("held · {reason}"), Token::Warn),
            Why::NotCovered => ("not covered".into(), Token::Faint),
            Why::Smoke => ("smoke".into(), Token::Dim),
        }
    }
}

/// One journey of `.rio/qa/journeys/`.
#[derive(Debug, Clone, PartialEq)]
pub struct Journey {
    pub name: String,
    /// The journey's goal (`Checkout with saved address`).
    pub title: String,
    pub persona: String,
    pub tags: Vec<String>,
    /// Selected to run.
    pub selected: bool,
    /// Why it is (not) selected.
    pub why: Why,
    /// The dependency chain ending in this journey.
    pub chain: Vec<String>,
    /// Covered path globs.
    pub paths: Vec<String>,
    /// Covered routes.
    pub routes: Vec<String>,
    pub preconditions: Vec<String>,
    pub steps: Vec<JourneyStep>,
    /// Success criteria checked after the last step.
    pub success: Vec<String>,
    /// Viewports it is limited to; empty for all.
    pub viewports: Vec<String>,
    /// The last baseline run, if any.
    pub baseline: Option<Baseline>,
}

impl Journey {
    pub fn chained(&self) -> bool {
        matches!(self.why, Why::ChainedBy(_))
    }
}

/// A step of a journey.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct JourneyStep {
    pub title: String,
    /// The route the step acts on.
    pub route: String,
    /// What must hold after it.
    pub expect: String,
}

/// The last baseline run of a journey.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Baseline {
    /// The base branch it ran on.
    pub branch: String,
    /// How long ago (`2h ago`).
    pub age: String,
    /// Each cell's outcome.
    pub cells: Vec<(CellId, CellOutcome)>,
}

/// `.rio/qa.proposed.yaml`: candidates waiting for review.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Proposed {
    pub file: String,
    pub items: Vec<ProposedItem>,
}

/// A proposed journey or change to one.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProposedItem {
    /// A new journey (`+`) rather than a change (`~`).
    pub new: bool,
    pub journey: String,
    /// Where it comes from or what changes (`from §Goals`).
    pub note: String,
}

/// The result of `rio qa sync --check`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncStatus {
    /// The command that ran.
    pub command: String,
    pub exit: i32,
    /// Journeys that need reconciliation.
    pub items: Vec<SyncItem>,
}

/// A journey sync flagged.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncItem {
    pub journey: String,
    /// What changed (`server.mjs changed`, `guidance edited`).
    pub reason: String,
}

/// The seed snapshot.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Seed {
    /// A snapshot matching the fingerprint is cached.
    pub cached: bool,
    /// The short fingerprint (`9f3a·c21`).
    pub fingerprint: String,
    /// What using it costs (`restore ~2.1 s`).
    pub note: String,
}

impl Seed {
    /// From `Report.qa.seed`.
    pub fn from_qa(qa: &serde_json::Value) -> Option<Self> {
        let seed = qa.get("seed")?;
        let fp = seed.get("fingerprint")?.as_str()?;
        let short = format!("{}·{}", clip(fp, 4), fp.get(4..7).unwrap_or(""));
        let status = seed.get("status").and_then(|s| s.as_str()).unwrap_or("");
        let ms = seed
            .get("duration_ms")
            .and_then(|d| d.as_u64())
            .unwrap_or(0);
        Some(Self {
            cached: status == "restored",
            fingerprint: short,
            note: format!("{status} {}.{} s", ms / 1000, (ms % 1000) / 100),
        })
    }
}

/// The agent harness and the sandbox.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Harness {
    /// `codex` or `pi`.
    pub name: String,
    /// How it reaches models (`gateway`).
    pub via: String,
    /// The egress policy (`deny-all`).
    pub egress: String,
    /// Service doubles (`stripe`, `mail`).
    pub doubles: Vec<String>,
}

/// The run budget.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Budget {
    /// Total tokens.
    pub tokens: u64,
    /// Tokens per verification voter.
    pub per_voter: u64,
    /// The preset (`fast`).
    pub preset: String,
}

const KEYS: &[Key] = &[
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

pub(super) struct JourneysScreen {
    data: JourneysData,
    cursor: usize,
    full: bool,
    baseline: bool,
}

impl JourneysScreen {
    pub fn new(data: JourneysData) -> Self {
        let full = data.mode == "full";
        Self {
            data,
            cursor: 0,
            full,
            baseline: false,
        }
    }

    fn runnable(&self) -> impl Iterator<Item = &Journey> {
        self.data.journeys.iter().filter(|j| !j.chained())
    }

    fn selected(&self) -> Vec<&Journey> {
        self.runnable()
            .filter(|j| self.full || j.selected)
            .collect()
    }

    fn chained_needed(&self) -> Vec<&Journey> {
        let selected: Vec<&str> = self.selected().iter().map(|j| j.name.as_str()).collect();
        self.data
            .journeys
            .iter()
            .filter(|j| matches!(&j.why, Why::ChainedBy(by) if selected.contains(&by.as_str())))
            .collect()
    }

    /// The `rio qa` arguments for the current selection.
    fn args(&self) -> Vec<String> {
        let mut args = vec!["qa".to_owned()];
        if self.full {
            args.push("--full".into());
        } else {
            for j in self.selected() {
                args.push("--journey".into());
                args.push(j.name.clone());
            }
        }
        if self.baseline {
            args.push("--baseline".into());
        }
        args
    }

    fn mode(&self) -> &str {
        if self.full { "full" } else { &self.data.mode }
    }

    fn cells(&self) -> usize {
        self.selected().len() * self.data.cells.len()
    }

    fn draw_left(&self, c: &mut Canvas<'_>, p: Pane) {
        let d = &self.data;
        let mut y = 2;
        let head = |text: &str| bold(text, Token::Faint, Token::Bg);
        p.line(c, y, &[head(" PERSONAS")]);
        y += 1;
        for persona in &d.personas {
            let (glyph, fg) = if persona.ready {
                (" ● ", Token::Pass)
            } else {
                (" ○ ", Token::Faint)
            };
            p.line(
                c,
                y,
                &[
                    run(glyph, fg, Token::Bg),
                    run(pad(&persona.name, 12), Token::Fg, Token::Bg),
                    run(persona.note.as_str(), Token::Faint, Token::Bg),
                ],
            );
            y += 1;
        }
        y += 1;
        let viewports = distinct(d.cells.iter().map(|c| c.viewport.as_str()));
        let schemes = distinct(d.cells.iter().map(|c| c.color_scheme.as_str()));
        p.line(c, y, &[head(&format!(" CELLS  {viewports} × {schemes}"))]);
        y += 1;
        let vw = d
            .cells
            .iter()
            .map(|c| crate::canvas::width(&c.viewport))
            .max()
            .unwrap_or(0);
        for cell in &d.cells {
            p.line(
                c,
                y,
                &[
                    run(" ▣ ", Token::Signal, Token::Bg),
                    run(
                        format!("{} · {}", pad(&cell.viewport, vw), cell.color_scheme),
                        Token::Fg,
                        Token::Bg,
                    ),
                ],
            );
            y += 1;
        }
        y += 1;
        p.line(
            c,
            y,
            &[head(&format!(" CHANGED  {} files", d.changed.len()))],
        );
        y += 1;
        let end = p.right.saturating_sub(2);
        for f in &d.changed {
            let added = format!("+{}", f.added);
            let room = usize::from(end.saturating_sub(3)).saturating_sub(added.len());
            p.line(
                c,
                y,
                &[
                    run(format!(" {} ", f.status), Token::Warn, Token::Bg),
                    run(pad(&f.path, room), Token::Fg, Token::Bg),
                    run(added, Token::Pass, Token::Bg),
                ],
            );
            y += 1;
            if let Some(note) = &f.note {
                p.line(c, y, &[run(format!("   {note}"), Token::Faint, Token::Bg)]);
                y += 1;
            }
        }
        y += 1;
        p.line(c, y, &[head(" SELECTION")]);
        let held = self
            .runnable()
            .filter(|j| !self.full && !j.selected && matches!(j.why, Why::Held(_)))
            .count();
        let held_reason = d
            .journeys
            .iter()
            .find_map(|j| match &j.why {
                Why::Held(r) => Some(r.clone()),
                _ => None,
            })
            .unwrap_or_default();
        let kv = |label: &str, value: String, fg: Token| {
            vec![
                run(format!(" {}", pad(label, 8)), Token::Faint, Token::Bg),
                run(value, fg, Token::Bg),
            ]
        };
        p.line(c, y + 1, &kv("mode", self.mode().to_owned(), Token::Fg));
        p.line(
            c,
            y + 2,
            &kv("cap", format!("{} journeys", d.cap), Token::Fg),
        );
        p.line(
            c,
            y + 3,
            &kv(
                "picked",
                format!("{} of {}", self.selected().len(), d.journeys.len()),
                Token::Fg,
            ),
        );
        if held > 0 {
            p.line(
                c,
                y + 4,
                &kv("held", format!("{held} · {held_reason}"), Token::Warn),
            );
        } else {
            p.line(c, y + 4, &kv("held", "none".into(), Token::Fg));
        }
        y += 6;
        p.line(c, y, &[head(" SEED")]);
        let (glyph, fg, state) = if d.seed.cached {
            (" ✓ ", Token::Pass, "cached")
        } else {
            (" ◐ ", Token::Warn, "build needed")
        };
        p.line(
            c,
            y + 1,
            &[
                run(glyph, fg, Token::Bg),
                run(
                    format!("fp {} {state}", d.seed.fingerprint),
                    Token::Fg,
                    Token::Bg,
                ),
            ],
        );
        p.line(
            c,
            y + 2,
            &[run(format!("   {}", d.seed.note), Token::Faint, Token::Bg)],
        );
        y += 4;
        let h = &d.harness;
        p.line(c, y, &[head(" HARNESS")]);
        p.line(
            c,
            y + 1,
            &[run(
                format!(" {} · {}", h.name, h.via),
                Token::Fg,
                Token::Bg,
            )],
        );
        p.line(
            c,
            y + 2,
            &[
                run(" egress   ", Token::Faint, Token::Bg),
                run(h.egress.as_str(), Token::Fg, Token::Bg),
            ],
        );
        p.line(
            c,
            y + 3,
            &[
                run(" doubles  ", Token::Faint, Token::Bg),
                run(h.doubles.join(", "), Token::Fg, Token::Bg),
            ],
        );
    }

    /// Rows of the journey list that fit, keeping the cursor visible.
    fn window(&self, rows: usize) -> (usize, usize) {
        let n = self.data.journeys.len();
        if n <= rows {
            return (0, n);
        }
        let start = self
            .cursor
            .saturating_sub(rows.saturating_sub(1))
            .min(n - rows);
        (start, start + rows)
    }

    fn draw_middle(&self, c: &mut Canvas<'_>, p: Pane, bottom: u16) {
        let d = &self.data;
        p.line(
            c,
            2,
            &[
                bold(" Journeys ", Token::Fg, Token::Bg),
                run(d.journeys.len().to_string(), Token::Dim, Token::Bg),
                run("              why selected", Token::Faint, Token::Bg),
            ],
        );
        p.rule(c, 3);
        // The sections under the list: proposed and sync.
        let proposed_rows = d.proposed.as_ref().map_or(1, |pr| pr.items.len() + 5);
        let sync_rows = d.sync.items.len() + 4;
        let room = usize::from(bottom.saturating_sub(4)).saturating_sub(proposed_rows + sync_rows);
        let list_rows = d.journeys.len().min(room.max(3));
        let (start, end) = self.window(list_rows);
        let mut y = 4;
        for (i, j) in d.journeys.iter().enumerate().take(end).skip(start) {
            let focused = i == self.cursor;
            let bg = if focused { Token::Raise } else { Token::Bg };
            let (glyph, gfg) = if j.chained() {
                (" ↳ ", Token::Faint)
            } else if j.selected || self.full {
                (" ● ", Token::Pass)
            } else {
                (" ○ ", Token::Faint)
            };
            let (why, wfg) = j.why.text();
            let why_room = usize::from(p.right.saturating_sub(p.x + 32));
            let name = pad(&j.name, 19);
            p.line(
                c,
                y,
                &[
                    if focused {
                        run("▌", Token::Signal, bg)
                    } else {
                        run(" ", Token::Fg, bg)
                    },
                    run(glyph, gfg, bg),
                    if focused {
                        bold(name, Token::Fg, bg)
                    } else {
                        run(name, Token::Fg, bg)
                    },
                    run(pad(&j.persona, 9), Token::Faint, bg),
                    run(
                        format!("{}{}", why, " ".repeat(why_room)),
                        if j.chained() { Token::Faint } else { wfg },
                        bg,
                    ),
                ],
            );
            if focused {
                mark(c, y, p.x, p.right, bottom);
            }
            y += 1;
        }
        y += 1;
        if let Some(pr) = &d.proposed {
            self.rule_with_borders(c, p, y);
            y += 1;
            p.line(
                c,
                y,
                &[
                    bold(" PROPOSED ", Token::Faint, Token::Bg),
                    run(format!(" {}", pr.file), Token::Faint, Token::Bg),
                ],
            );
            y += 1;
            for item in &pr.items {
                let (sign, fg) = if item.new {
                    (" + ", Token::Pass)
                } else {
                    (" ~ ", Token::Warn)
                };
                p.line(
                    c,
                    y,
                    &[
                        run(sign, fg, Token::Bg),
                        run(pad(&item.journey, 18), Token::Fg, Token::Bg),
                        run(item.note.as_str(), Token::Faint, Token::Bg),
                    ],
                );
                y += 1;
            }
            p.line(
                c,
                y,
                &[
                    bold(" A ", Token::Fg, Token::Bg),
                    run("accept  ", Token::Faint, Token::Bg),
                    bold("D ", Token::Fg, Token::Bg),
                    run("diff  committed files untouched", Token::Faint, Token::Bg),
                ],
            );
            y += 2;
        }
        self.rule_with_borders(c, p, y);
        y += 1;
        let s = &d.sync;
        p.line(
            c,
            y,
            &[
                bold(" SYNC ", Token::Faint, Token::Bg),
                run(
                    format!(" {} · exit {}", s.command, s.exit),
                    Token::Faint,
                    Token::Bg,
                ),
            ],
        );
        y += 1;
        if s.items.is_empty() {
            p.line(
                c,
                y,
                &[
                    run(" ✓ ", Token::Pass, Token::Bg),
                    run("every journey matches the code", Token::Faint, Token::Bg),
                ],
            );
            y += 1;
        }
        for item in &s.items {
            p.line(
                c,
                y,
                &[
                    run(" ◐ ", Token::Warn, Token::Bg),
                    run(pad(&item.journey, 18), Token::Fg, Token::Bg),
                    run(item.reason.as_str(), Token::Faint, Token::Bg),
                ],
            );
            y += 1;
        }
        p.line(
            c,
            y,
            &[run(
                "   sync never rewrites a journey;",
                Token::Faint,
                Token::Bg,
            )],
        );
        p.line(
            c,
            y + 1,
            &[run(
                "   s opens the reconcile diff",
                Token::Faint,
                Token::Bg,
            )],
        );
    }

    /// A rule across the middle pane, joined to the borders on both sides.
    fn rule_with_borders(&self, c: &mut Canvas<'_>, p: Pane, y: u16) {
        p.rule(c, y);
    }

    fn draw_right(&self, c: &mut Canvas<'_>, p: Pane) {
        let Some(j) = self.data.journeys.get(self.cursor) else {
            return;
        };
        let head = |text: &str| bold(text, Token::Faint, Token::Bg);
        p.line(
            c,
            2,
            &[
                bold(format!(" {} ", j.name), Token::Fg, Token::Bg),
                run(format!(" {}", j.title), Token::Dim, Token::Bg),
            ],
        );
        p.line(
            c,
            3,
            &[
                run(" persona ", Token::Faint, Token::Bg),
                run(pad(&j.persona, 10), Token::Fg, Token::Bg),
                run("tags ", Token::Faint, Token::Bg),
                run(j.tags.join(", "), Token::Fg, Token::Bg),
            ],
        );
        let chain = if j.chain.is_empty() {
            j.name.clone()
        } else {
            j.chain.join(" → ")
        };
        p.line(
            c,
            4,
            &[
                run(" chain   ", Token::Faint, Token::Bg),
                run(chain, Token::Fg, Token::Bg),
            ],
        );
        // The rule joins the border on its left.
        p.rule(c, 5);
        let mut y = 6;
        p.line(c, y, &[head(" COVERS")]);
        p.line(
            c,
            y + 1,
            &[
                run(" paths   ", Token::Faint, Token::Bg),
                run(j.paths.join("   "), Token::Fg, Token::Bg),
            ],
        );
        p.line(
            c,
            y + 2,
            &[
                run(" routes  ", Token::Faint, Token::Bg),
                run(j.routes.join("   "), Token::Fg, Token::Bg),
            ],
        );
        y += 4;
        if !j.preconditions.is_empty() {
            p.line(c, y, &[head(" PRECONDITIONS")]);
            y += 1;
            for pre in &j.preconditions {
                p.line(c, y, &[run(format!(" · {pre}"), Token::Dim, Token::Bg)]);
                y += 1;
            }
            y += 1;
        }
        p.line(c, y, &[head(" STEPS")]);
        y += 1;
        for (i, step) in j.steps.iter().enumerate() {
            p.line(
                c,
                y,
                &[
                    run(format!("  {}  ", i + 1), Token::Signal, Token::Bg),
                    run(pad(&step.title, 32), Token::Fg, Token::Bg),
                    run(step.route.as_str(), Token::Faint, Token::Bg),
                ],
            );
            p.line(
                c,
                y + 1,
                &[
                    run("     expect  ", Token::Faint, Token::Bg),
                    run(step.expect.as_str(), Token::Dim, Token::Bg),
                ],
            );
            y += 2;
        }
        y += 1;
        if !j.success.is_empty() {
            p.line(c, y, &[head(" SUCCESS")]);
            y += 1;
            for s in &j.success {
                p.line(
                    c,
                    y,
                    &[
                        run(" ✓ ", Token::Pass, Token::Bg),
                        run(s.as_str(), Token::Fg, Token::Bg),
                    ],
                );
                y += 1;
            }
            y += 1;
        }
        let Some(b) = &j.baseline else {
            p.line(
                c,
                y,
                &[
                    head(" LAST BASELINE"),
                    run("  none · b runs one", Token::Faint, Token::Bg),
                ],
            );
            return;
        };
        p.line(
            c,
            y,
            &[head(&format!(" LAST BASELINE  {} · {}", b.branch, b.age))],
        );
        let mut viewports: Vec<&str> = Vec::new();
        let mut schemes: Vec<&str> = Vec::new();
        for (cell, _) in &b.cells {
            if !viewports.contains(&cell.viewport.as_str()) {
                viewports.push(&cell.viewport);
            }
            if !schemes.contains(&cell.color_scheme.as_str()) {
                schemes.push(&cell.color_scheme);
            }
        }
        let header: String = viewports.iter().map(|v| pad(v, 14)).collect();
        p.line(
            c,
            y + 1,
            &[run(
                format!("{}{}", " ".repeat(12), header.trim_end()),
                Token::Faint,
                Token::Bg,
            )],
        );
        for (r, scheme) in schemes.iter().enumerate() {
            let mut runs = vec![run(pad(&format!(" {scheme}"), 12), Token::Faint, Token::Bg)];
            for (i, v) in viewports.iter().enumerate() {
                let outcome = b
                    .cells
                    .iter()
                    .find(|(cell, _)| cell.viewport == *v && cell.color_scheme == *scheme)
                    .map(|(_, o)| o.clone())
                    .unwrap_or(CellOutcome::NotRun);
                let text = format!("{} {}", outcome.glyph(), outcome.word());
                let text = if i + 1 < viewports.len() {
                    pad(&text, 14)
                } else {
                    text
                };
                runs.push(run(text, outcome.token(), Token::Bg));
            }
            p.line(c, y + 2 + r as u16, &runs);
        }
    }

    fn footer_text(&self) -> String {
        let d = &self.data;
        let selection = if self.full {
            format!("--full: {} journeys", self.selected().len())
        } else {
            format!(
                "{} selected + {} chained",
                self.selected().len(),
                self.chained_needed().len()
            )
        };
        let est_ms = self.cells() as u64 * u64::from(d.ms_per_cell);
        let secs = est_ms / 1000;
        let mut text = format!(
            " {selection} · {} cells · est. {}m {}s · budget {} tok, {} per voter · {}",
            self.cells(),
            secs / 60,
            secs % 60,
            kilo(d.budget.tokens),
            kilo(d.budget.per_voter),
            d.budget.preset
        );
        if self.baseline {
            text.push_str(" · --baseline");
        }
        text
    }

    fn plan(&self) -> MatrixData {
        let d = &self.data;
        let mut journeys: Vec<&Journey> = self.chained_needed();
        journeys.extend(self.selected());
        let mut data = MatrixData {
            harness: d.harness.name.clone(),
            via: d.harness.via.clone(),
            isolation: d
                .runtime
                .rsplit(" · ")
                .next()
                .unwrap_or(&d.runtime)
                .to_owned(),
            cells: d.cells.clone(),
            planned: self.cells() as u32,
            remaining_secs: Some((self.cells() as u64 * u64::from(d.ms_per_cell) / 1000) as u32),
            ..MatrixData::default()
        };
        data.budget_preset = d.budget.preset.clone();
        data.tokens = super::Meter {
            used: 0,
            limit: d.budget.tokens,
        };
        data.voter = super::Meter {
            used: 0,
            limit: d.budget.per_voter,
        };
        for j in journeys {
            data.journeys.push(super::MatrixJourney {
                name: j.name.clone(),
                chained: j.chained(),
                steps: j.steps.iter().map(|s| s.title.clone()).collect(),
                cells: d
                    .cells
                    .iter()
                    .map(|cell| {
                        let outcome = if j.viewports.is_empty()
                            || j.viewports.contains(&cell.viewport)
                        {
                            CellOutcome::Queued
                        } else {
                            CellOutcome::NotApplicable(format!("{} only", j.viewports.join("/")))
                        };
                        super::MatrixCell::new(outcome)
                    })
                    .collect(),
            });
        }
        data
    }
}

fn distinct<'a>(items: impl Iterator<Item = &'a str>) -> usize {
    let mut seen: Vec<&str> = Vec::new();
    for item in items {
        if !seen.contains(&item) {
            seen.push(item);
        }
    }
    seen.len()
}

impl Screen for JourneysScreen {
    fn title(&self) -> &'static str {
        "QA journeys"
    }
    fn board(&self) -> Board {
        Board::V3
    }
    fn keys(&self) -> &'static [Key] {
        KEYS
    }

    fn draw(&self, c: &mut Canvas<'_>, session: &Session) {
        c.clear(Token::Bg);
        let d = &self.data;
        let context = format!("qa · {} · {} · {} mode", d.project, d.config, self.mode());
        let sync = if d.sync.items.is_empty() {
            chrome::status("✓ sync: clean", Token::Pass)
        } else {
            chrome::status(
                format!("◐ sync: {} need review", d.sync.items.len()),
                Token::Warn,
            )
        };
        super::header(c, &context, &[sync, chrome::quiet(d.runtime.as_str())]);
        tabs(c, 0);
        let bottom = body_bottom(c);
        let w = c.width();
        let mid_right = if wide(c) { 67 } else { w };
        border(c, 24, 2, bottom);
        if mid_right < w {
            border(c, mid_right, 2, bottom);
        }
        self.draw_left(c, Pane::new(0, 24, bottom));
        self.draw_middle(c, Pane::new(25, mid_right, bottom), bottom);
        if mid_right < w {
            self.draw_right(c, Pane::new(mid_right + 1, w, bottom));
        }
        // The outcome of `s`, `i`, `v`, `A` or `D` follows the run summary.
        let mut runs = vec![run(self.footer_text(), Token::Faint, Token::Bg)];
        match &session.notice {
            Some(crate::Outcome::Ok(text)) => {
                runs.push(run(format!("   ✓ {text}"), Token::Pass, Token::Bg))
            }
            Some(crate::Outcome::Failed(text)) => {
                runs.push(run(format!("   ✕ {text}"), Token::Fail, Token::Bg))
            }
            _ => {}
        }
        footer(c, &runs);
        chrome::keybar(c, KEYS);
    }

    fn on_key(&mut self, key: KeyEvent, _session: &mut Session) -> Action {
        let n = self.data.journeys.len();
        match key.code {
            KeyCode::Up | KeyCode::Char('k') => self.cursor = self.cursor.saturating_sub(1),
            KeyCode::Down | KeyCode::Char('j') => {
                if self.cursor + 1 < n {
                    self.cursor += 1;
                }
            }
            KeyCode::Char(' ') => {
                if let Some(j) = self.data.journeys.get_mut(self.cursor)
                    && !j.chained()
                {
                    j.selected = !j.selected;
                    self.full = false;
                }
            }
            KeyCode::Enter => {
                return Action::Many(vec![
                    Action::Effect(Effect::Start(self.args())),
                    Action::Push(Box::new(super::matrix::MatrixScreen::new(self.plan()))),
                ]);
            }
            KeyCode::Char('a') => self.full = !self.full,
            KeyCode::Char('b') => self.baseline = !self.baseline,
            KeyCode::Char('s') => return Action::Effect(Effect::Step("qa:sync".into())),
            KeyCode::Char('i') => return Action::Effect(Effect::Step("qa:init".into())),
            KeyCode::Char('v') => return Action::Effect(Effect::Step("qa:validate".into())),
            KeyCode::Char('A') if self.data.proposed.is_some() => {
                return Action::Effect(Effect::Step("qa:accept".into()));
            }
            KeyCode::Char('D') if self.data.proposed.is_some() => {
                return Action::Effect(Effect::Step("qa:diff".into()));
            }
            _ => {}
        }
        Action::None
    }
}

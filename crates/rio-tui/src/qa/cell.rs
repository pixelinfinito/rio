//! Q3: one journey × one cell: step timeline, the failed step's observation,
//! the masked screenshot, the attributed source line and the evidence.

use ratatui::crossterm::event::{KeyCode, KeyEvent};
use rio_core::Finding;

use super::{
    CellId, CellOutcome, Pane, Tone, UxData, body_bottom, border, cell_key, clip, footer, mark,
    mmss, tabs, wide, wrap,
};
use crate::{
    app::{Action, Effect, Msg, Outcome, Screen, Session},
    canvas::{Canvas, Run, bold, pad, run, width},
    chrome::{self, Board, Key, focus, key},
    images::{Query, Shot},
    theme::Token,
};

/// Everything Q3 shows about one journey × one cell.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CellDetail {
    pub journey: String,
    pub cell: CellId,
    pub outcome: CellOutcome,
    /// The step reached, or failed at.
    pub step: u32,
    /// The same cell on the base branch, if it ran there.
    pub base: Option<Base>,
    /// The step timeline.
    pub steps: Vec<StepResult>,
    /// The masked screenshot of the focused step, as a wireframe.
    pub screenshot: Option<Screenshot>,
    /// The base run's screenshot of the same step (`b`).
    pub base_screenshot: Option<Screenshot>,
    /// The journey's other cells and their outcomes.
    pub others: Vec<(CellId, CellOutcome)>,
    /// What differs from a passing cell: that cell and the difference.
    pub delta: Option<(CellId, String)>,
    /// Retained evidence files.
    pub evidence: Vec<EvidenceFile>,
    /// Where evidence is kept and for how long (`.rio/cache/qa · 7 d`).
    pub evidence_store: String,
    /// The finding the failure produced.
    pub finding: Option<CellFinding>,
    /// The change the finding is attributed to.
    pub diff: Option<SourceDiff>,
    /// Unverified observations: shown, never counted as findings.
    pub observations: Vec<Observation>,
    /// How the finding was proven; the first line is the verdict.
    pub proof: Vec<String>,
}

impl CellDetail {
    /// A cell with only its matrix state: steps from the journey's titles,
    /// passed up to the step reached.
    pub fn basic(
        journey: &str,
        cell: CellId,
        titles: &[String],
        outcome: CellOutcome,
        step: u32,
    ) -> Self {
        let steps = titles
            .iter()
            .enumerate()
            .map(|(i, title)| {
                let n = i as u32 + 1;
                let o = match &outcome {
                    CellOutcome::Passed => CellOutcome::Passed,
                    _ if n < step => CellOutcome::Passed,
                    CellOutcome::Failed | CellOutcome::Running if n == step => outcome.clone(),
                    _ => CellOutcome::NotRun,
                };
                StepResult {
                    title: title.clone(),
                    outcome: o,
                    secs: None,
                    expect: String::new(),
                    saw: None,
                }
            })
            .collect();
        Self {
            journey: journey.to_owned(),
            cell,
            outcome,
            step,
            steps,
            evidence_store: ".rio/cache/qa".into(),
            ..Self::default()
        }
    }

    /// The cell as a finished report records it: outcome, evidence, and the
    /// finding with an occurrence in this cell.
    pub fn from_report(report: &rio_core::Report, journey: &str, cell: &CellId) -> Option<Self> {
        let qa = report.qa.as_ref()?;
        let j = qa
            .get("journeys")?
            .as_array()?
            .iter()
            .find(|j| j.get("name").and_then(|n| n.as_str()) == Some(journey))?;
        let c = j
            .get("cells")?
            .as_array()?
            .iter()
            .find(|c| CellId::from_json(c).as_ref() == Some(cell))?;
        let outcome = CellOutcome::parse(c.get("outcome")?.as_str()?);
        let step = c.get("step_reached").and_then(|s| s.as_u64()).unwrap_or(0) as u32;
        // Without the journey's titles, steps are numbered up to the one reached.
        let titles: Vec<String> = (1..=step.max(1)).map(|n| format!("step {n}")).collect();
        let mut detail = Self::basic(journey, cell.clone(), &titles, outcome, step);
        // Evidence by file name: the report's artifacts know where each id is.
        let artifacts = qa["evidence"]["artifacts"].as_array();
        detail.evidence = c
            .get("evidence")
            .and_then(|e| e.as_array())
            .into_iter()
            .flatten()
            .filter_map(|e| e.as_str())
            .map(|id| {
                let found = artifacts
                    .into_iter()
                    .flatten()
                    .find(|a| a["id"] == id)
                    .and_then(|a| Some((a["link"].as_str()?, a["kind"].as_str().unwrap_or(""))));
                match found {
                    Some((link, kind)) => {
                        let mut file = EvidenceFile::at(link.split('?').next().unwrap_or(link));
                        file.path = link.to_owned();
                        file.note = kind.to_owned();
                        file
                    }
                    None => EvidenceFile::at(id),
                }
            })
            .collect();
        detail.finding = report
            .findings
            .iter()
            .find(|f| {
                f.qa.as_ref().is_some_and(|q| q.journey == journey)
                    && f.locations.iter().any(|l| {
                        l.cell.as_ref().is_some_and(|x| {
                            x.viewport == cell.viewport && x.color_scheme == cell.color_scheme
                        })
                    })
            })
            .map(CellFinding::from_finding);
        Some(detail)
    }
}

/// The same cell on the base branch.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Base {
    pub branch: String,
    pub outcome: CellOutcome,
}

/// How a step went. Steps use the cell outcomes: passed, failed, running,
/// not run.
pub type StepOutcome = CellOutcome;

/// One step of the timeline.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct StepResult {
    pub title: String,
    pub outcome: StepOutcome,
    /// Wall time.
    pub secs: Option<u32>,
    /// What the step expected.
    pub expect: String,
    /// What the agent saw instead, for a failed step.
    pub saw: Option<String>,
}

/// A masked screenshot drawn as a wireframe: rows of styled segments inside a
/// device frame. Text the masking hid is drawn as blocks.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Screenshot {
    pub step: u32,
    /// The viewport size (`390×844`).
    pub size: String,
    /// The frame's rows, each a list of segments.
    pub rows: Vec<Vec<(Ink, String)>>,
    /// What the probe measured; the first line is the verdict.
    pub verdict: Vec<String>,
}

/// How a wireframe segment is drawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ink {
    /// Device chrome and labels.
    Chrome,
    Text,
    Strong,
    /// Links and controls.
    Accent,
    /// Masked text.
    Masked,
    /// The element the failure is about.
    Overlay,
    OverlayText,
    OverlayStrong,
}

impl Ink {
    fn run(self, text: &str) -> Run {
        match self {
            Ink::Chrome => run(text, Token::Faint, Token::Bg),
            Ink::Text => run(text, Token::Fg, Token::Bg),
            Ink::Strong => bold(text, Token::Fg, Token::Bg),
            Ink::Accent => run(text, Token::Signal, Token::Bg),
            Ink::Masked => run(text, Token::Rule, Token::Bg),
            Ink::Overlay => run(text, Token::Fail, Token::FailTint),
            Ink::OverlayText => run(text, Token::Fg, Token::FailTint),
            Ink::OverlayStrong => bold(text, Token::Fg, Token::FailTint),
        }
    }
}

/// A retained evidence file.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct EvidenceFile {
    /// The file name shown.
    pub name: String,
    /// The path or URL `o` opens.
    pub path: String,
    /// `masked`, `1.8 MB`, `0 err`.
    pub note: String,
    pub tone: Tone,
}

impl EvidenceFile {
    /// A file known only by its path.
    pub fn at(path: &str) -> Self {
        Self {
            name: path.rsplit('/').next().unwrap_or(path).to_owned(),
            path: path.to_owned(),
            note: String::new(),
            tone: Tone::Faint,
        }
    }
}

/// The finding a failed cell produced.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CellFinding {
    /// The finding id (shown as its first 8 characters).
    pub id: String,
    /// `new`, `worsened`, `pre-existing`.
    pub state: String,
    pub severity: String,
    pub category: String,
    /// `reproduced`, `static_proven` or `plausible`; never a percentage.
    pub evidence_level: String,
    /// It fails the review under the profile's `fail_on`.
    pub fails: bool,
    pub title: String,
    pub rule: String,
    /// What raised it (`probe`, `functional`).
    pub kind: String,
    pub route: String,
    pub element: String,
    /// The attributed source line.
    pub source: Option<(String, u32)>,
    /// `attributed` or `journey`.
    pub attribution: String,
    /// Cells it occurs in, of the cells that ran the step.
    pub cells: Vec<CellId>,
    pub cells_total: u32,
}

fn word<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

impl CellFinding {
    pub fn from_finding(f: &Finding) -> Self {
        let qa = f.qa.as_ref();
        let attribution = qa.map(|q| word(&q.attribution)).unwrap_or_default();
        let cells: Vec<CellId> = f
            .locations
            .iter()
            .filter_map(|l| l.cell.as_ref())
            .map(|c| CellId::new(c.viewport.as_str(), c.color_scheme.as_str()))
            .collect();
        Self {
            id: f.id.clone(),
            state: word(&f.state),
            severity: word(&f.severity),
            category: word(&f.category),
            evidence_level: word(&f.evidence_level),
            fails: false,
            title: f.message.clone(),
            rule: f.rule_id.clone(),
            kind: qa.map(|q| word(&q.kind)).unwrap_or_default(),
            route: qa.map(|q| q.route.clone()).unwrap_or_default(),
            element: qa
                .and_then(|q| q.element_paths.first().cloned())
                .unwrap_or_default(),
            source: Some((f.location.path.clone(), f.location.line_start)),
            attribution,
            cells_total: cells.len() as u32,
            cells,
        }
    }

    /// `q-` and the first 8 characters of the id.
    fn short_id(&self) -> String {
        let id = self.id.strip_prefix("q-").unwrap_or(&self.id);
        format!("q-{}", clip(id, 8))
    }
}

/// The attributed change, as a diff hunk.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SourceDiff {
    pub path: String,
    pub added: u32,
    pub removed: u32,
    pub lines: Vec<DiffLine>,
    /// The line the finding is attributed to.
    pub attributed: u32,
    /// Notes under the hunk; the first is pointed at the attributed line.
    pub note: Vec<String>,
}

/// One line of the hunk.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DiffLine {
    pub number: u32,
    /// `+`, `-` or ` `.
    pub sign: char,
    pub text: String,
}

/// An unverified observation: shown, never counted as a finding.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Observation {
    pub text: String,
    pub notes: Vec<String>,
}

const KEYS: &[Key] = &[
    key("←→", "step"),
    key("[ ]", "cell"),
    focus("o", "evidence"),
    key("b", "vs base"),
    key("e", "editor"),
    key("r", "rerun cell"),
    key("4", "ux"),
    key("esc", "matrix"),
];

pub(super) struct CellScreen {
    cells: Vec<CellDetail>,
    index: usize,
    step: usize,
    base: bool,
    ux: Option<UxData>,
}

impl CellScreen {
    pub fn new(cells: Vec<CellDetail>, index: usize, ux: Option<UxData>) -> Self {
        let mut screen = Self {
            index: index.min(cells.len().saturating_sub(1)),
            cells,
            step: 0,
            base: false,
            ux,
        };
        screen.step = screen.default_step();
        screen
    }

    fn detail(&self) -> Option<&CellDetail> {
        self.cells.get(self.index)
    }

    /// The failed or running step, else the last one.
    fn default_step(&self) -> usize {
        let Some(d) = self.detail() else {
            return 0;
        };
        d.steps
            .iter()
            .position(|s| matches!(s.outcome, CellOutcome::Failed | CellOutcome::Running))
            .unwrap_or(d.steps.len().saturating_sub(1))
    }

    fn source(&self) -> Option<(String, u32)> {
        let d = self.detail()?;
        if let Some(src) = d.finding.as_ref().and_then(|f| f.source.clone()) {
            return Some(src);
        }
        d.diff.as_ref().map(|x| (x.path.clone(), x.attributed))
    }

    fn draw_left(&self, c: &mut Canvas<'_>, d: &CellDetail, p: Pane) {
        p.line(
            c,
            2,
            &[
                bold(format!(" {} ", d.journey), Token::Fg, Token::Bg),
                run("× ", Token::Faint, Token::Bg),
                bold(d.cell.label(), Token::Fg, Token::Bg),
            ],
        );
        let status = match &d.outcome {
            CellOutcome::Failed => format!(" ✕ failed at step {}", d.step),
            CellOutcome::Running => format!(" ◐ running step {}", d.step.max(1)),
            CellOutcome::Passed => format!(" ✓ passed · {} steps", d.steps.len()),
            other => format!(" {} {}", other.glyph(), other.word()),
        };
        p.line(c, 3, &[bold(status, d.outcome.token(), Token::Bg)]);
        match &d.base {
            Some(b) => {
                let (verdict, fg) = verdict(&b.outcome, &d.outcome);
                p.line(
                    c,
                    4,
                    &[
                        run(format!(" base {} ", b.branch), Token::Faint, Token::Bg),
                        run(
                            format!("{} {} ", b.outcome.glyph(), b.outcome.word()),
                            b.outcome.token(),
                            Token::Bg,
                        ),
                        run("→ ", Token::Faint, Token::Bg),
                        bold(verdict, fg, Token::Bg),
                    ],
                );
            }
            None => {
                p.line(c, 4, &[run(" no base run", Token::Faint, Token::Bg)]);
            }
        }
        p.rule(c, 5);
        p.line(c, 6, &[bold(" STEPS", Token::Faint, Token::Bg)]);
        let mut y = 7;
        let n = d.steps.len();
        for (i, s) in d.steps.iter().enumerate() {
            let focused = i == self.step;
            let label = format!("{} {}", i + 1, s.title);
            let dur = s.secs.map(mmss).unwrap_or_default();
            if s.outcome == CellOutcome::NotRun {
                p.line(c, y, &[run(format!(" · {label}"), Token::Faint, Token::Bg)]);
                if focused {
                    mark(c, y, p.x, p.right, p.bottom);
                }
            } else if focused {
                let tint = if s.outcome == CellOutcome::Failed {
                    Token::FailTint
                } else {
                    Token::Raise
                };
                let room = 23usize.saturating_sub(width(&dur));
                p.line(
                    c,
                    y,
                    &[
                        run("▌", Token::Signal, tint),
                        run(format!("{} ", s.outcome.glyph()), s.outcome.token(), tint),
                        bold(pad(&label, room), Token::Fg, tint),
                        run(dur.as_str(), Token::Faint, tint),
                        run("  ", Token::Fg, tint),
                    ],
                );
                mark(c, y, p.x, p.x + 28, p.bottom);
            } else {
                let room = 24usize.saturating_sub(width(&dur));
                p.line(
                    c,
                    y,
                    &[
                        run(
                            format!(" {} ", s.outcome.glyph()),
                            s.outcome.token(),
                            Token::Bg,
                        ),
                        run(pad(&label, room), Token::Fg, Token::Bg),
                        run(dur.as_str(), Token::Faint, Token::Bg),
                    ],
                );
            }
            y += 1;
            if focused {
                if !s.expect.is_empty() {
                    for (k, line) in wrap(&s.expect, 18).iter().enumerate() {
                        let label = if k == 0 { "   expect " } else { "          " };
                        p.line(
                            c,
                            y,
                            &[
                                run(label, Token::Faint, Token::Bg),
                                run(line.as_str(), Token::Dim, Token::Bg),
                            ],
                        );
                        y += 1;
                    }
                }
                if let Some(saw) = &s.saw {
                    for (k, line) in wrap(saw, 18).iter().enumerate() {
                        let label = if k == 0 { "   saw    " } else { "          " };
                        p.line(
                            c,
                            y,
                            &[
                                run(label, Token::Faint, Token::Bg),
                                run(line.as_str(), Token::Fg, Token::Bg),
                            ],
                        );
                        y += 1;
                    }
                }
            }
            let last_not_run = s.outcome == CellOutcome::NotRun
                && d.steps
                    .get(i + 1)
                    .is_none_or(|next| next.outcome != CellOutcome::NotRun);
            if last_not_run && i + 1 == n {
                p.line(c, y, &[run("   not run", Token::Faint, Token::Bg)]);
                y += 1;
            }
        }
        y += 1;
        if !d.others.is_empty() {
            p.line(c, y, &[bold(" OTHER CELLS", Token::Faint, Token::Bg)]);
            y += 1;
            for pair in d.others.chunks(2) {
                for (k, (cell, outcome)) in pair.iter().enumerate() {
                    let x = p.x + 1 + 17 * k as u16;
                    let room = usize::from(p.right.saturating_sub(x + 3)).min(15);
                    p.at(
                        c,
                        x,
                        y,
                        &[
                            run(format!("{} ", outcome.glyph()), outcome.token(), Token::Bg),
                            run(pad(&clip(&cell.label(), room), room), Token::Fg, Token::Bg),
                        ],
                    );
                }
                y += 1;
            }
        }
        if let Some((against, text)) = &d.delta {
            p.line(
                c,
                y,
                &[run(
                    format!(" Δ vs {}", against.label()),
                    Token::Faint,
                    Token::Bg,
                )],
            );
            p.line(
                c,
                y + 1,
                &[run(format!("   {text}"), Token::Warn, Token::Bg)],
            );
            y += 2;
        }
        y += 1;
        p.line(
            c,
            y,
            &[bold(" EVIDENCE  sanitized", Token::Faint, Token::Bg)],
        );
        y += 1;
        if d.evidence.is_empty() {
            p.line(c, y, &[run("   none retained", Token::Faint, Token::Bg)]);
            y += 1;
        }
        for e in &d.evidence {
            p.line(
                c,
                y,
                &[
                    run(" ▣ ", Token::Signal, Token::Bg),
                    // A cut name keeps one space before its note.
                    run(
                        if e.note.is_empty() {
                            pad(&e.name, 15)
                        } else {
                            format!("{} ", pad(&e.name, 14))
                        },
                        Token::Fg,
                        Token::Bg,
                    ),
                    run(e.note.as_str(), e.tone.token(), Token::Bg),
                ],
            );
            y += 1;
        }
        if !d.evidence_store.is_empty() {
            p.line(
                c,
                y,
                &[run(
                    format!("   {}", d.evidence_store),
                    Token::Faint,
                    Token::Bg,
                )],
            );
        }
    }

    /// The focused step's screenshot from the run's evidence, if the session has a run.
    fn real_shot(&self, d: &CellDetail, session: &Session) -> Option<Shot> {
        let report = session.report.as_ref()?;
        let shot = session.images.locate(
            report,
            Query {
                journey: &d.journey,
                viewport: &d.cell.viewport,
                color_scheme: &d.cell.color_scheme,
                step: self.step as u32 + 1,
                base: self.base,
            },
        );
        (shot != Shot::Missing).then_some(shot)
    }

    /// The run's own screenshot: an image, its path without images, or why
    /// it is not shown.
    fn draw_real(
        &self,
        c: &mut Canvas<'_>,
        d: &CellDetail,
        p: Pane,
        session: &Session,
        shot: Shot,
    ) {
        let title = if self.base {
            format!(
                " BASE {} ",
                d.base.as_ref().map_or("base", |b| b.branch.as_str())
            )
        } else {
            " SCREENSHOT ".to_owned()
        };
        p.line(
            c,
            2,
            &[
                bold(title, Token::Faint, Token::Bg),
                run(
                    format!("step {} · {} · masked", self.step + 1, d.cell.color_scheme),
                    Token::Faint,
                    Token::Bg,
                ),
            ],
        );
        let note = |c: &mut Canvas<'_>, y: u16, glyph: &str, fg: Token, text: String| {
            p.line(
                c,
                y,
                &[
                    run(format!("   {glyph} "), fg, Token::Bg),
                    run(text, Token::Fg, Token::Bg),
                ],
            );
        };
        match shot {
            Shot::Local(path) if session.images.enabled() => {
                let area = ratatui::layout::Rect::new(
                    p.x + 2,
                    4,
                    p.right.saturating_sub(p.x + 4),
                    p.bottom.saturating_sub(5),
                );
                if let Err(error) = session.images.draw(c, area, &path) {
                    let lines = wrap(&error, p.width().saturating_sub(6));
                    for (i, line) in lines.iter().enumerate() {
                        let glyph = if i == 0 { "✕" } else { " " };
                        note(c, 4 + i as u16, glyph, Token::Fail, line.clone());
                    }
                    note(
                        c,
                        4 + lines.len() as u16,
                        " ",
                        Token::Faint,
                        "o opens the file".into(),
                    );
                }
            }
            Shot::Local(path) => {
                // The file's name, then its folder cut from the left.
                let (dir, name) = path.rsplit_once('/').unwrap_or(("", path.as_str()));
                let room = p.width().saturating_sub(6);
                let chars: Vec<char> = dir.chars().collect();
                let dir = if chars.len() > room {
                    format!(
                        "…{}",
                        chars[chars.len() + 1 - room.max(1)..]
                            .iter()
                            .collect::<String>()
                    )
                } else {
                    dir.to_owned()
                };
                note(c, 4, "·", Token::Faint, name.to_owned());
                note(c, 5, " ", Token::Faint, dir);
                note(c, 6, " ", Token::Faint, "o opens it".into());
            }
            Shot::Remote(_) | Shot::Loading => {
                note(c, 4, "◐", Token::Warn, "downloading the screenshot…".into());
            }
            Shot::Failed(error) => {
                // Errors wrap within the pane; the first line carries the mark.
                for (i, line) in wrap(&error, p.width().saturating_sub(6))
                    .into_iter()
                    .enumerate()
                {
                    let glyph = if i == 0 { "✕" } else { " " };
                    note(c, 4 + i as u16, glyph, Token::Fail, line);
                }
            }
            Shot::Missing => {}
        }
    }

    fn draw_screenshot(&self, c: &mut Canvas<'_>, d: &CellDetail, p: Pane, session: &Session) {
        if let Some(shot) = self.real_shot(d, session) {
            return self.draw_real(c, d, p, session, shot);
        }
        let (shot, title) = if self.base {
            let branch = d.base.as_ref().map_or("base", |b| b.branch.as_str());
            (d.base_screenshot.as_ref(), format!(" BASE {branch} "))
        } else {
            (d.screenshot.as_ref(), " SCREENSHOT ".to_owned())
        };
        let Some(shot) = shot else {
            p.line(
                c,
                2,
                &[
                    bold(title, Token::Faint, Token::Bg),
                    run("no screenshot for this step", Token::Faint, Token::Bg),
                ],
            );
            return;
        };
        p.line(
            c,
            2,
            &[
                bold(title, Token::Faint, Token::Bg),
                run(
                    format!(
                        "step {} · {} · {}",
                        shot.step, shot.size, d.cell.color_scheme
                    ),
                    Token::Faint,
                    Token::Bg,
                ),
            ],
        );
        let inner = 30usize;
        let x0 = p.x + 3;
        p.at(
            c,
            x0,
            4,
            &[run(
                format!("╭{}╮", "─".repeat(inner)),
                Token::Faint,
                Token::Bg,
            )],
        );
        let mut y = 5;
        for row in &shot.rows {
            p.at(c, x0, y, &[run("│", Token::Faint, Token::Bg)]);
            let mut used = 0;
            let mut runs = Vec::new();
            for (ink, text) in row {
                let text = clip(text, inner - used);
                used += width(&text);
                runs.push(ink.run(&text));
            }
            runs.push(run(" ".repeat(inner - used), Token::Fg, Token::Bg));
            runs.push(run("│", Token::Faint, Token::Bg));
            p.at(c, x0 + 1, y, &runs);
            y += 1;
        }
        p.at(
            c,
            x0,
            y,
            &[run(
                format!("╰{}╯", "─".repeat(inner)),
                Token::Faint,
                Token::Bg,
            )],
        );
        y += 2;
        for (k, line) in shot.verdict.iter().enumerate() {
            if k == 0 {
                p.line(
                    c,
                    y,
                    &[
                        run("   ▲ ", Token::Fail, Token::Bg),
                        bold(line.as_str(), Token::Fg, Token::Bg),
                    ],
                );
            } else {
                p.line(
                    c,
                    y,
                    &[run(format!("     {line}"), Token::Faint, Token::Bg)],
                );
            }
            y += 1;
        }
    }

    fn draw_right(&self, c: &mut Canvas<'_>, d: &CellDetail, p: Pane) {
        let head = |text: &str| bold(text, Token::Faint, Token::Bg);
        let rule = |c: &mut Canvas<'_>, y: u16| {
            let w = p.width().saturating_sub(1);
            p.line(c, y, &[run("─".repeat(w), Token::Rule, Token::Bg)]);
        };
        let mut y = 2;
        if let Some(f) = &d.finding {
            p.line(
                c,
                y,
                &[
                    head(" FINDING "),
                    run(format!(" {}", f.short_id()), Token::Faint, Token::Bg),
                ],
            );
            let mut tags = vec![
                bold(format!("[{}] ", f.state), Token::Fail, Token::Bg),
                run(format!("[{}] ", f.severity), Token::Fg, Token::Bg),
                run(format!("[{}] ", f.category), Token::Dim, Token::Bg),
                run(format!("[{}] ", f.evidence_level), Token::Signal, Token::Bg),
            ];
            if f.fails {
                tags.push(bold("[FAIL]", Token::Fail, Token::Bg));
            }
            p.line(c, y + 1, &tags);
            y += 3;
            for line in wrap(&f.title, p.width().saturating_sub(2)) {
                p.line(c, y, &[bold(format!(" {line}"), Token::Fg, Token::Bg)]);
                y += 1;
            }
            p.line(
                c,
                y,
                &[bold(
                    format!(" on {} in {} mode", d.cell.viewport, d.cell.color_scheme),
                    Token::Fg,
                    Token::Bg,
                )],
            );
            y += 2;
            let kv = |label: &str| run(format!(" {}", pad(label, 9)), Token::Faint, Token::Bg);
            p.line(
                c,
                y,
                &[
                    kv("rule"),
                    run(f.rule.as_str(), Token::Fg, Token::Bg),
                    run(format!("  {}", f.kind), Token::Faint, Token::Bg),
                ],
            );
            p.line(
                c,
                y + 1,
                &[
                    kv("where"),
                    run(format!("{}  {}", f.route, f.element), Token::Fg, Token::Bg),
                ],
            );
            let mut src = vec![kv("source")];
            match &f.source {
                Some((path, line)) => {
                    src.push(run(format!("{path}:{line}"), Token::Signal, Token::Bg));
                    src.push(run(format!("  {}", f.attribution), Token::Faint, Token::Bg));
                }
                None => src.push(run("journey", Token::Faint, Token::Bg)),
            }
            p.line(c, y + 2, &src);
            let hit: Vec<String> = f.cells.iter().map(CellId::label).collect();
            p.line(
                c,
                y + 3,
                &[
                    kv("cells"),
                    run(
                        format!("{} of {} ", f.cells.len(), f.cells_total),
                        Token::Fg,
                        Token::Bg,
                    ),
                    run(format!("· {}", hit.join(", ")), Token::Faint, Token::Bg),
                ],
            );
            y += 4;
        } else {
            p.line(
                c,
                y,
                &[
                    head(" FINDING "),
                    run(" none in this cell", Token::Faint, Token::Bg),
                ],
            );
            y += 1;
        }
        if let Some(diff) = &d.diff {
            rule(c, y);
            p.line(
                c,
                y + 1,
                &[
                    run(pad(&format!(" {}", diff.path), 34), Token::Dim, Token::Bg),
                    run(
                        format!("+{} −{}", diff.added, diff.removed),
                        Token::Faint,
                        Token::Bg,
                    ),
                ],
            );
            y += 2;
            for line in &diff.lines {
                let (sign_fg, bg) = if line.number == diff.attributed && line.sign != ' ' {
                    (Token::Fail, Token::FailTint)
                } else if line.sign == '+' {
                    (Token::Pass, Token::PassTint)
                } else if line.sign == '-' {
                    (Token::Fail, Token::FailTint)
                } else {
                    (Token::Faint, Token::Bg)
                };
                p.line(
                    c,
                    y,
                    &[
                        run(format!("{} {:>3}  ", line.sign, line.number), sign_fg, bg),
                        run(pad(&line.text, 35), Token::Fg, bg),
                    ],
                );
                y += 1;
            }
            for (k, note) in diff.note.iter().enumerate() {
                if k == 0 {
                    p.line(
                        c,
                        y,
                        &[
                            run("        ▲ ", Token::Fail, Token::Bg),
                            run(note.as_str(), Token::Dim, Token::Bg),
                        ],
                    );
                } else {
                    p.line(
                        c,
                        y,
                        &[run(format!("          {note}"), Token::Faint, Token::Bg)],
                    );
                }
                y += 1;
            }
        }
        if !d.observations.is_empty() {
            rule(c, y);
            p.line(
                c,
                y + 1,
                &[
                    head(" OBSERVATIONS "),
                    run("· unverified", Token::Warn, Token::Bg),
                ],
            );
            y += 2;
            for o in &d.observations {
                p.line(
                    c,
                    y,
                    &[
                        run(" ○ ", Token::Faint, Token::Bg),
                        run(o.text.as_str(), Token::Dim, Token::Bg),
                    ],
                );
                y += 1;
                for note in &o.notes {
                    p.line(c, y, &[run(format!("   {note}"), Token::Faint, Token::Bg)]);
                    y += 1;
                }
            }
        }
        if !d.proof.is_empty() {
            rule(c, y);
            p.line(c, y + 1, &[head(" PROOF ")]);
            y += 2;
            for (k, line) in d.proof.iter().enumerate() {
                let fg = if k == 0 { Token::Fg } else { Token::Faint };
                p.line(c, y, &[run(format!(" {line}"), fg, Token::Bg)]);
                y += 1;
            }
        }
    }
}

/// Base → head, as a word.
fn verdict(base: &CellOutcome, head: &CellOutcome) -> (&'static str, Token) {
    match (base, head) {
        (CellOutcome::Passed, CellOutcome::Failed) => ("regression", Token::Fail),
        (CellOutcome::Failed, CellOutcome::Passed) => ("fixed", Token::Pass),
        (CellOutcome::Failed, CellOutcome::Failed) => ("still failing", Token::Warn),
        _ => ("unchanged", Token::Dim),
    }
}

impl Screen for CellScreen {
    fn title(&self) -> &'static str {
        "QA cell"
    }
    fn board(&self) -> Board {
        Board::V3
    }
    fn keys(&self) -> &'static [Key] {
        KEYS
    }

    fn draw(&self, c: &mut Canvas<'_>, session: &Session) {
        c.clear(Token::Bg);
        let Some(d) = self.detail() else {
            super::header(c, "qa · no cell", &[]);
            tabs(c, 2);
            chrome::keybar(c, KEYS);
            return;
        };
        let context = format!("qa · {} × {}", d.journey, d.cell.label());
        let status = match &d.outcome {
            CellOutcome::Failed | CellOutcome::Running => {
                format!(
                    "{} {} · step {}",
                    d.outcome.glyph(),
                    d.outcome.word(),
                    d.step
                )
            }
            other => format!("{} {}", other.glyph(), other.word()),
        };
        let mut right = vec![chrome::status(status, d.outcome.token())];
        if let Some(b) = &d.base {
            let (verdict, _) = verdict(&b.outcome, &d.outcome);
            right.push(chrome::quiet(format!("{verdict} vs {}", b.branch)));
        }
        super::header(c, &context, &right);
        tabs(c, 2);
        let bottom = body_bottom(c);
        let w = c.width();
        border(c, 30, 2, bottom);
        self.draw_left(c, d, Pane::new(0, 30, bottom));
        let right_x = if wide(c) {
            border(c, 70, 2, bottom);
            self.draw_screenshot(c, d, Pane::new(31, 70, bottom), session);
            71
        } else {
            31
        };
        self.draw_right(c, d, Pane::new(right_x, w, bottom));
        let mut text =
            " o open evidence in $BROWSER · screenshots are masked before storage".to_owned();
        if let Some((path, line)) = self.source() {
            text.push_str(&format!(" · e opens {path}:{line} in $EDITOR"));
        }
        footer(c, &[run(text, Token::Faint, Token::Bg)]);
        chrome::keybar(c, KEYS);
    }

    fn on_msg(&mut self, msg: &Msg, session: &mut Session) -> Action {
        match msg {
            // An endpoint run's screenshot is downloaded once, when shown.
            Msg::Tick => {
                if let Some(d) = self.detail()
                    && session.images.enabled()
                    && let Some(Shot::Remote(url)) = self.real_shot(d, session)
                    && session.images.request(&url)
                {
                    return Action::Effect(Effect::Fetch(format!("qa-image:{url}")));
                }
            }
            Msg::Done(Outcome::Value(name, value)) if name == "qa-image" => {
                if let Some(url) = value["url"].as_str() {
                    let result = match value["path"].as_str() {
                        Some(path) => Ok(path.to_owned()),
                        None => Err(value["error"]
                            .as_str()
                            .unwrap_or("the screenshot could not be downloaded")
                            .to_owned()),
                    };
                    session.images.downloaded(url, result);
                }
            }
            _ => {}
        }
        Action::None
    }

    fn on_key(&mut self, key: KeyEvent, _session: &mut Session) -> Action {
        let steps = self.detail().map_or(0, |d| d.steps.len());
        match key.code {
            KeyCode::Left | KeyCode::Char('h') => self.step = self.step.saturating_sub(1),
            KeyCode::Right | KeyCode::Char('l') => {
                if self.step + 1 < steps {
                    self.step += 1;
                }
            }
            KeyCode::Char('[') => {
                if self.index > 0 {
                    self.index -= 1;
                    self.step = self.default_step();
                }
            }
            KeyCode::Char(']') => {
                if self.index + 1 < self.cells.len() {
                    self.index += 1;
                    self.step = self.default_step();
                }
            }
            KeyCode::Char('b') => self.base = !self.base,
            KeyCode::Char('o') => {
                let Some(d) = self.detail() else {
                    return Action::None;
                };
                // The step's own screenshot first, then the evidence list.
                if let Some(Shot::Local(path) | Shot::Remote(path)) = self.real_shot(d, _session) {
                    return Action::Effect(Effect::Open(path));
                }
                // Evidence names carry the step after `step-`, padded or not
                // (`step-0004-screenshot-….png`, `step-4.png`).
                let step_of = |name: &str| {
                    let digits: String = name
                        .strip_prefix("step-")?
                        .chars()
                        .take_while(char::is_ascii_digit)
                        .collect();
                    digits.parse::<usize>().ok()
                };
                let file = d
                    .evidence
                    .iter()
                    .find(|e| step_of(&e.name) == Some(self.step + 1))
                    .or_else(|| d.evidence.first());
                if let Some(file) = file {
                    return Action::Effect(Effect::Open(file.path.clone()));
                }
            }
            KeyCode::Char('e') => {
                if let Some((path, line)) = self.source() {
                    return Action::Effect(Effect::Edit { path, line });
                }
            }
            KeyCode::Char('r') => {
                if let Some(d) = self.detail() {
                    return Action::Effect(Effect::Step(format!(
                        "qa:rerun:{}",
                        cell_key(&d.journey, &d.cell)
                    )));
                }
            }
            KeyCode::Char('4') => {
                if let Some(ux) = &self.ux {
                    return Action::Push(Box::new(super::ux::UxScreen::new(ux.clone(), 2)));
                }
            }
            KeyCode::Char('2') => return Action::Pop,
            _ => {}
        }
        Action::None
    }
}

//! Q4: UX recommendations. Always advice: no key here changes the review's
//! status or exit code.

use ratatui::crossterm::event::{KeyCode, KeyEvent};

use super::{CellId, EvidenceFile, Pane, body_bottom, border, footer, mark, wide, wrap};
use crate::{
    app::{Action, Effect, Screen, Session},
    canvas::{Canvas, Run, bold, pad, run},
    chrome::{self, Board, Key, Status, focus, key},
    theme::Token,
};

/// Everything Q4 shows: rubric coverage and recommendations.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct UxData {
    /// The rubric (`rio/ui-v1`).
    pub rubric: String,
    /// Its version (`0.1.0`).
    pub version: String,
    /// The rules it covers (`ux/*`).
    pub scope: String,
    /// Each criterion and whether it was assessed.
    pub criteria: Vec<Criterion>,
    /// Recommendations, held ones included.
    pub recommendations: Vec<Recommendation>,
    /// The owner guidance file (`REVIEW.md`).
    pub guidance_file: String,
    /// Guidance sections and how they were used.
    pub guidance: Vec<GuidanceUse>,
    /// Where recommendations were verified (`hosted`, `local`).
    pub verification: String,
}

/// A rubric criterion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Criterion {
    /// The rule without `ux/` (`error-recovery`).
    pub name: String,
    pub status: CriterionStatus,
}

/// Whether a criterion was assessed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CriterionStatus {
    Assessed,
    /// Not assessed, with the reason.
    NotAssessed(String),
    /// Not applicable, with the reason.
    NotApplicable(String),
}

/// A guidance section and how often it was used or held a recommendation back.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GuidanceUse {
    /// The section without `§` (`Recovery`).
    pub section: String,
    pub used: u32,
    pub held: u32,
}

/// Verification status of a recommendation.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum RecStatus {
    /// Voters grounded it.
    #[default]
    Supported,
    /// No endpoint, or the voters split.
    Unverified,
    Inconclusive,
    /// Owner guidance holds it back.
    Held,
}

impl RecStatus {
    fn label(self) -> (&'static str, Token) {
        match self {
            RecStatus::Supported => ("supported", Token::Pass),
            RecStatus::Unverified => ("unverified", Token::Warn),
            RecStatus::Inconclusive => ("inconclusive", Token::Warn),
            RecStatus::Held => ("held", Token::Warn),
        }
    }

    fn parse(s: &str) -> Self {
        match s {
            "supported" => RecStatus::Supported,
            "inconclusive" => RecStatus::Inconclusive,
            "held" | "held_back" => RecStatus::Held,
            _ => RecStatus::Unverified,
        }
    }
}

/// A cited owner guidance passage.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Citation {
    pub file: String,
    /// Without `§`.
    pub section: String,
    pub line: u32,
    pub quote: String,
}

/// A UX recommendation.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Recommendation {
    /// The rule (`ux/error-recovery`).
    pub rule: String,
    /// The friction, as a sentence.
    pub title: String,
    pub status: RecStatus,
    /// The agent hit the friction (rather than proposing from the rubric alone).
    pub observed: bool,
    /// Why owner guidance holds it back (`dense grid is intentional`).
    pub held: Option<String>,
    pub journey: String,
    pub cell: Option<CellId>,
    pub step: Option<u32>,
    pub evidence: Vec<EvidenceFile>,
    /// What the agent observed.
    pub notes: Vec<String>,
    /// The guidance it cites, or that holds it back.
    pub guidance: Option<Citation>,
    /// The proposed improvement.
    pub proposal: String,
    /// The expected benefit; never tested by rio.
    pub benefit: String,
    /// Voters that grounded it, of voters asked.
    pub voters: Option<(u32, u32)>,
    /// What the voters saw.
    pub voter_note: String,
    /// Where it would be published.
    pub publish: String,
}

impl Recommendation {
    fn name(&self) -> &str {
        self.rule.strip_prefix("ux/").unwrap_or(&self.rule)
    }

    /// The recommendation as a Markdown issue body.
    pub fn markdown(&self) -> String {
        let (status, _) = self.status.label();
        let mut md = format!(
            "### UX: {}\n\n- Rule: `{}` · {status} · advice, never fails the review\n",
            self.title, self.rule
        );
        if let Some(cell) = &self.cell {
            md.push_str(&format!("- Observed: {} × {}", self.journey, cell.label()));
            if let Some(step) = self.step {
                md.push_str(&format!(" · step {step}"));
            }
            md.push('\n');
        }
        for note in &self.notes {
            md.push_str(&format!("  - {note}\n"));
        }
        if !self.evidence.is_empty() {
            let files: Vec<&str> = self.evidence.iter().map(|e| e.path.as_str()).collect();
            md.push_str(&format!("- Evidence: {}\n", files.join(", ")));
        }
        if let Some(g) = &self.guidance {
            md.push_str(&format!(
                "- Guidance: {} §{} (line {})\n\n> {}\n",
                g.file, g.section, g.line, g.quote
            ));
        }
        md.push_str(&format!("\n**Recommendation.** {}\n", self.proposal));
        md.push_str(&format!(
            "\n**Benefit.** proposed · untested · {}\n",
            self.benefit
        ));
        md
    }
}

impl UxData {
    /// Coverage and recommendations from `Report.qa`, when it assessed any.
    pub fn from_qa(qa: &serde_json::Value) -> Option<Self> {
        let recs = qa.get("recommendations").and_then(|r| r.as_array());
        let assessment = qa.get("assessment").and_then(|a| a.as_array());
        if recs.is_none() && assessment.is_none() {
            return None;
        }
        let s = |v: &serde_json::Value, k: &str| {
            v.get(k)
                .and_then(|x| x.as_str())
                .unwrap_or_default()
                .to_owned()
        };
        let version = s(qa, "rubric_version");
        let (rubric, version) = version
            .split_once('@')
            .map(|(r, v)| (format!("rio/{r}"), v.to_owned()))
            .unwrap_or((version.clone(), String::new()));
        let mut criteria: Vec<Criterion> = Vec::new();
        for a in assessment.into_iter().flatten() {
            let rule = s(a, "rule_id");
            let name = rule.strip_prefix("ux/").unwrap_or(&rule).to_owned();
            let reason = s(a, "reason");
            let status = match s(a, "status").as_str() {
                "assessed" => CriterionStatus::Assessed,
                "not_applicable" => CriterionStatus::NotApplicable(reason),
                _ => CriterionStatus::NotAssessed(reason),
            };
            match criteria.iter_mut().find(|c| c.name == name) {
                Some(c) if status == CriterionStatus::Assessed => c.status = status,
                Some(_) => {}
                None => criteria.push(Criterion { name, status }),
            }
        }
        let recommendations = recs
            .into_iter()
            .flatten()
            .map(|r| {
                let status = RecStatus::parse(&s(r, "verification_status"));
                let friction = s(r, "observed_friction");
                Recommendation {
                    rule: s(r, "rule_id"),
                    title: friction.clone(),
                    status,
                    observed: !friction.is_empty(),
                    held: None,
                    journey: s(r, "journey"),
                    cell: r
                        .get("cells")
                        .and_then(|c| c.as_array())
                        .and_then(|c| c.first())
                        .and_then(CellId::from_json),
                    step: r
                        .get("steps")
                        .and_then(|c| c.as_array())
                        .and_then(|c| c.first())
                        .and_then(|n| n.as_u64())
                        .map(|n| n as u32),
                    evidence: r
                        .get("evidence")
                        .and_then(|e| e.as_array())
                        .into_iter()
                        .flatten()
                        .filter_map(|e| e.as_str())
                        .map(EvidenceFile::at)
                        .collect(),
                    notes: vec![],
                    guidance: None,
                    proposal: s(r, "proposed_improvement"),
                    benefit: s(r, "expected_benefit"),
                    voters: None,
                    voter_note: s(r, "rationale"),
                    publish: if status == RecStatus::Supported {
                        "PR summary only, never inline".into()
                    } else {
                        "not published".into()
                    },
                }
            })
            .collect();
        Some(Self {
            rubric,
            version,
            scope: "ux/*".into(),
            criteria,
            recommendations,
            guidance_file: "REVIEW.md".into(),
            guidance: vec![],
            verification: String::new(),
        })
    }

    fn assessed(&self) -> usize {
        self.criteria
            .iter()
            .filter(|c| c.status == CriterionStatus::Assessed)
            .count()
    }

    fn held(&self) -> usize {
        self.recommendations
            .iter()
            .filter(|r| r.status == RecStatus::Held)
            .count()
    }
}

const KEYS: &[Key] = &[
    key("↑↓", "move"),
    focus("⏎", "expand"),
    key("g", "guidance"),
    key("o", "evidence"),
    key("y", "copy as issue"),
    key("x", "export md"),
    key("esc", "matrix"),
];

/// Text width of the detail pane's paragraphs.
const TEXT: usize = 41;
/// Text width of a quoted guidance passage.
const QUOTE: usize = 36;

pub(super) struct UxScreen {
    data: UxData,
    cursor: usize,
    expanded: Vec<bool>,
    /// Screens to close to get back to the matrix.
    depth: usize,
}

impl UxScreen {
    pub fn new(data: UxData, depth: usize) -> Self {
        let expanded = vec![false; data.recommendations.len()];
        Self {
            data,
            cursor: 0,
            expanded,
            depth: depth.max(1),
        }
    }

    fn draw_left(&self, c: &mut Canvas<'_>, p: Pane) {
        let d = &self.data;
        let head = |t: String| bold(t, Token::Faint, Token::Bg);
        p.line(
            c,
            2,
            &[head(format!(" RUBRIC  {} · {}", d.rubric, d.scope))],
        );
        let mut y = 3;
        for cr in &d.criteria {
            match &cr.status {
                CriterionStatus::Assessed => {
                    p.line(
                        c,
                        y,
                        &[
                            run(" ✓ ", Token::Pass, Token::Bg),
                            run(cr.name.as_str(), Token::Fg, Token::Bg),
                        ],
                    );
                    y += 1;
                }
                CriterionStatus::NotAssessed(reason) | CriterionStatus::NotApplicable(reason) => {
                    let na = matches!(cr.status, CriterionStatus::NotApplicable(_));
                    p.line(
                        c,
                        y,
                        &[run(
                            format!(" – {}{}", cr.name, if na { "  n/a" } else { "" }),
                            Token::Faint,
                            Token::Bg,
                        )],
                    );
                    y += 1;
                    for line in wrap(reason, 26) {
                        if line.is_empty() {
                            continue;
                        }
                        p.line(c, y, &[run(format!("   {line}"), Token::Faint, Token::Bg)]);
                        y += 1;
                    }
                }
            }
        }
        y += 1;
        p.line(
            c,
            y,
            &[run(
                format!(
                    " {} of {} criteria assessed",
                    d.assessed(),
                    d.criteria.len()
                ),
                Token::Dim,
                Token::Bg,
            )],
        );
        y += 2;
        p.line(c, y, &[head(format!(" GUIDANCE  {}", d.guidance_file))]);
        y += 1;
        if d.guidance.is_empty() {
            p.line(c, y, &[run("   none applies", Token::Faint, Token::Bg)]);
            y += 1;
        }
        for g in &d.guidance {
            let (text, fg) = if g.held > 0 {
                (format!("{} held", g.held), Token::Warn)
            } else {
                (format!("{} used", g.used), Token::Faint)
            };
            p.line(
                c,
                y,
                &[
                    run(
                        format!(" {}", pad(&format!("§{}", g.section), 15)),
                        Token::Fg,
                        Token::Bg,
                    ),
                    run(text, fg, Token::Bg),
                ],
            );
            y += 1;
        }
        y += 1;
        for line in [
            "guidance is data: it can hold",
            "a recommendation back, never",
            "change a policy or a rule",
        ] {
            p.line(c, y, &[run(format!("   {line}"), Token::Faint, Token::Bg)]);
            y += 1;
        }
    }

    fn draw_middle(&self, c: &mut Canvas<'_>, p: Pane) {
        let d = &self.data;
        let shown = d.recommendations.len() - d.held();
        let mut header = vec![
            bold(" Recommendations ", Token::Fg, Token::Bg),
            run(shown.to_string(), Token::Dim, Token::Bg),
        ];
        if d.held() > 0 {
            header.push(run(
                format!("   + {} held", d.held()),
                Token::Faint,
                Token::Bg,
            ));
        }
        p.line(c, 2, &header);
        p.rule(c, 3);
        // The legend and the advice lines below the list take 9 rows; the
        // list shows a window of items that keeps the cursor in view.
        let limit = p.bottom.saturating_sub(9).max(5);
        let n = d.recommendations.len();
        let heights: Vec<u16> = (0..n).map(|i| self.item_rows(i, p.width())).collect();
        let mut start = 0;
        while start < self.cursor
            && 4 + u16::from(start > 0) + heights[start..=self.cursor].iter().sum::<u16>() > limit
        {
            start += 1;
        }
        let mut y = 4;
        if start > 0 {
            p.line(
                c,
                y,
                &[run(format!(" ↑ {start} more"), Token::Faint, Token::Bg)],
            );
            y += 1;
        }
        for (i, r) in d.recommendations.iter().enumerate().skip(start) {
            // Keep a row for "↓ n more" unless this is the last item.
            let room = if i + 1 < n { 1 } else { 0 };
            if i > start && y + heights[i] + room > limit {
                p.line(
                    c,
                    y,
                    &[run(format!(" ↓ {} more", n - i), Token::Faint, Token::Bg)],
                );
                y += 2;
                break;
            }
            let focused = i == self.cursor;
            let bg = if focused { Token::Raise } else { Token::Bg };
            let (status, sfg) = r.status.label();
            let id = format!(" R{}  ", i + 1);
            let name = pad(r.name(), 20);
            let first: Vec<Run> = if r.status == RecStatus::Held && !focused {
                vec![
                    run(format!(" {id}{name}"), Token::Faint, bg),
                    run(status, sfg, bg),
                ]
            } else if focused {
                vec![
                    run("▌", Token::Signal, bg),
                    bold(format!("{id}{name}"), Token::Fg, bg),
                    run(status, sfg, bg),
                ]
            } else {
                vec![
                    run(" ", Token::Fg, bg),
                    run(id, Token::Dim, bg),
                    run(name, Token::Fg, bg),
                    run(status, sfg, bg),
                ]
            };
            let end = p.line(c, y, &first);
            if focused {
                mark(c, y, p.x, end, p.bottom);
            }
            y += 1;
            let mut second: Vec<(String, Token)> = Vec::new();
            if r.status == RecStatus::Held {
                if let Some(reason) = &r.held {
                    second.push((reason.clone(), Token::Faint));
                }
                if let Some(g) = &r.guidance {
                    second.push((format!("{} §{}", g.file, g.section), Token::Faint));
                }
            } else if r.observed {
                second.push(("observed friction".into(), Token::Warn));
            } else {
                second.push(("proposed · untested".into(), Token::Signal));
            }
            if self.expanded.get(i).copied().unwrap_or(false) {
                for line in wrap(&r.proposal, p.width().saturating_sub(8)) {
                    second.push((line, Token::Dim));
                }
            }
            for (text, fg) in second {
                let end = p.line(c, y, &[run("       ", Token::Fg, bg), run(text, fg, bg)]);
                if focused {
                    mark(c, y, p.x, end, p.bottom);
                }
                y += 1;
            }
            y += 1;
        }
        p.rule(c, y);
        y += 1;
        p.line(
            c,
            y,
            &[bold(" WHAT THE LABELS MEAN", Token::Faint, Token::Bg)],
        );
        let legend = [
            (" observed friction ", Token::Warn, "the agent hit it"),
            (" proposed · untested ", Token::Signal, "benefit not run"),
            (" supported ", Token::Pass, "voters grounded it"),
            (" unverified ", Token::Warn, "no endpoint / split"),
        ];
        for (k, (label, fg, meaning)) in legend.iter().enumerate() {
            p.line(
                c,
                y + 1 + k as u16,
                &[
                    run(*label, *fg, Token::Bg),
                    run(*meaning, Token::Faint, Token::Bg),
                ],
            );
        }
        y += 6;
        p.line(
            c,
            y,
            &[run(" Advice never fails a review.", Token::Dim, Token::Bg)],
        );
        p.line(
            c,
            y + 1,
            &[run(
                " Exit code and fail_on unchanged.",
                Token::Dim,
                Token::Bg,
            )],
        );
    }

    /// The rows item `i` takes in a list pane `width` wide, its gap included.
    fn item_rows(&self, i: usize, width: usize) -> u16 {
        let r = &self.data.recommendations[i];
        let second = if r.status == RecStatus::Held {
            usize::from(r.held.is_some()) + usize::from(r.guidance.is_some())
        } else {
            1
        };
        let expanded = if self.expanded.get(i).copied().unwrap_or(false) {
            wrap(&r.proposal, width.saturating_sub(8)).len()
        } else {
            0
        };
        (2 + second + expanded) as u16
    }

    fn draw_right(&self, c: &mut Canvas<'_>, p: Pane) {
        let Some(r) = self.data.recommendations.get(self.cursor) else {
            p.line(c, 2, &[run(" no recommendations", Token::Faint, Token::Bg)]);
            return;
        };
        let text_w = TEXT.min(p.width().saturating_sub(2)).max(20);
        let head = |t: &str| bold(t, Token::Faint, Token::Bg);
        p.line(
            c,
            2,
            &[
                head(&format!(" R{} ", self.cursor + 1)),
                run(format!(" {}", r.rule), Token::Faint, Token::Bg),
            ],
        );
        let mut y = 3;
        for line in wrap(&r.title, text_w) {
            p.line(c, y, &[bold(format!(" {line}"), Token::Fg, Token::Bg)]);
            y += 1;
        }
        y += 1;
        if r.cell.is_some() || !r.evidence.is_empty() || !r.notes.is_empty() {
            p.line(c, y, &[head(" OBSERVED")]);
            y += 1;
            if let Some(cell) = &r.cell {
                let step = r.step.map(|s| format!(" · step {s}")).unwrap_or_default();
                p.line(
                    c,
                    y,
                    &[run(
                        format!(" {} × {}{step}", r.journey, cell.label()),
                        Token::Dim,
                        Token::Bg,
                    )],
                );
                y += 1;
            }
            if !r.evidence.is_empty() {
                let mut runs = vec![run(" ", Token::Fg, Token::Bg)];
                for (k, e) in r.evidence.iter().enumerate() {
                    if k > 0 {
                        runs.push(run("   ", Token::Fg, Token::Bg));
                    }
                    runs.push(run("▣ ", Token::Signal, Token::Bg));
                    runs.push(run(e.name.as_str(), Token::Fg, Token::Bg));
                    if !e.note.is_empty() {
                        runs.push(run(" ", Token::Fg, Token::Bg));
                        runs.push(run(e.note.as_str(), e.tone.token(), Token::Bg));
                    }
                }
                p.line(c, y, &runs);
                y += 1;
            }
            for note in &r.notes {
                p.line(c, y, &[run(format!(" · {note}"), Token::Fg, Token::Bg)]);
                y += 1;
            }
            y += 1;
        }
        if let Some(g) = &r.guidance {
            p.line(c, y, &[head(" GUIDANCE")]);
            p.line(
                c,
                y + 1,
                &[run(
                    format!(" {} §{}  line {}", g.file, g.section, g.line),
                    Token::Faint,
                    Token::Bg,
                )],
            );
            y += 2;
            for line in wrap(&g.quote, QUOTE.min(p.width().saturating_sub(4))) {
                p.line(
                    c,
                    y,
                    &[
                        run(" ┃ ", Token::Signal, Token::Bg),
                        run(line, Token::Dim, Token::Bg),
                    ],
                );
                y += 1;
            }
            y += 1;
        }
        p.line(c, y, &[head(" RECOMMENDATION")]);
        y += 1;
        for line in wrap(&r.proposal, text_w) {
            p.line(c, y, &[run(format!(" {line}"), Token::Fg, Token::Bg)]);
            y += 1;
        }
        y += 1;
        p.line(c, y, &[head(" BENEFIT")]);
        y += 1;
        let label = "proposed · untested";
        let lines = wrap(&format!("{label} · {}", r.benefit), text_w - 1);
        for (k, line) in lines.iter().enumerate() {
            if k == 0 && line.starts_with(label) {
                p.line(
                    c,
                    y,
                    &[
                        run(format!(" {label}"), Token::Signal, Token::Bg),
                        run(&line[label.len()..], Token::Faint, Token::Bg),
                    ],
                );
            } else {
                p.line(c, y, &[run(format!(" {line}"), Token::Faint, Token::Bg)]);
            }
            y += 1;
        }
        y += 1;
        p.line(
            c,
            y,
            &[head(&format!(" VERIFICATION  {}", self.data.verification))],
        );
        let (status, fg) = r.status.label();
        let glyph = if r.status == RecStatus::Supported {
            "✓"
        } else {
            "◐"
        };
        let mut grounding = vec![
            run(" grounding ", Token::Faint, Token::Bg),
            run(format!("{glyph} {status}"), fg, Token::Bg),
        ];
        if let Some((yes, of)) = r.voters {
            grounding.push(run(
                format!("  {yes} of {of} voters"),
                Token::Faint,
                Token::Bg,
            ));
        }
        p.line(c, y + 1, &grounding);
        y += 2;
        if !r.voter_note.is_empty() {
            p.line(
                c,
                y,
                &[run(format!(" {}", r.voter_note), Token::Faint, Token::Bg)],
            );
            y += 1;
        }
        y += 1;
        p.line(
            c,
            y,
            &[
                run(" publish ", Token::Faint, Token::Bg),
                run(r.publish.as_str(), Token::Fg, Token::Bg),
            ],
        );
    }
}

impl Screen for UxScreen {
    fn title(&self) -> &'static str {
        "QA UX recommendations"
    }
    fn board(&self) -> Board {
        Board::V3
    }
    fn keys(&self) -> &'static [Key] {
        KEYS
    }

    fn draw(&self, c: &mut Canvas<'_>, _session: &Session) {
        c.clear(Token::Bg);
        let d = &self.data;
        let context = format!("qa · ux review · rubric {} {}", d.rubric, d.version);
        super::header(
            c,
            &context,
            &[
                Status {
                    text: "advice · never fails the review".into(),
                    fg: Token::Signal,
                    bold: false,
                },
                chrome::quiet(format!("{}/{} assessed", d.assessed(), d.criteria.len())),
            ],
        );
        super::tabs(c, 3);
        let bottom = body_bottom(c);
        let w = c.width();
        let (mid, right) = if wide(c) {
            border(c, 30, 2, bottom);
            self.draw_left(c, Pane::new(0, 30, bottom));
            (31, 71)
        } else {
            (0, 41)
        };
        border(c, right, 2, bottom);
        self.draw_middle(c, Pane::new(mid, right, bottom));
        self.draw_right(c, Pane::new(right + 1, w, bottom));
        let not_assessed = d.criteria.len() - d.assessed();
        let shown = d.recommendations.len() - d.held();
        let mut text = format!(" {shown} recommendations");
        if d.held() > 0 {
            text.push_str(&format!(" · {} held by owner guidance", d.held()));
        }
        if not_assessed > 0 {
            text.push_str(&format!(
                " · {not_assessed} criteria not assessed (reasons listed)"
            ));
        }
        text.push_str(" · exit code unchanged");
        footer(c, &[run(text, Token::Faint, Token::Bg)]);
        chrome::keybar(c, KEYS);
    }

    fn on_key(&mut self, key: KeyEvent, _session: &mut Session) -> Action {
        let n = self.data.recommendations.len();
        let rec = self.data.recommendations.get(self.cursor);
        match key.code {
            KeyCode::Up | KeyCode::Char('k') => self.cursor = self.cursor.saturating_sub(1),
            KeyCode::Down | KeyCode::Char('j') => {
                if self.cursor + 1 < n {
                    self.cursor += 1;
                }
            }
            KeyCode::Enter => {
                if let Some(e) = self.expanded.get_mut(self.cursor) {
                    *e = !*e;
                }
            }
            KeyCode::Char('g') => {
                if let Some(g) = rec.and_then(|r| r.guidance.as_ref()) {
                    return Action::Effect(Effect::Edit {
                        path: g.file.clone(),
                        line: g.line,
                    });
                }
            }
            KeyCode::Char('o') => {
                if let Some(e) = rec.and_then(|r| r.evidence.first()) {
                    return Action::Effect(Effect::Open(e.path.clone()));
                }
            }
            KeyCode::Char('y') => {
                if let Some(r) = rec {
                    return Action::Effect(Effect::Copy(r.markdown()));
                }
            }
            KeyCode::Char('x') => {
                return Action::Effect(Effect::Export {
                    format: "md".into(),
                    path: "ux-recommendations.md".into(),
                });
            }
            KeyCode::Esc | KeyCode::Char('2') => {
                return Action::Many((0..self.depth).map(|_| Action::Pop).collect());
            }
            _ => {}
        }
        Action::None
    }
}

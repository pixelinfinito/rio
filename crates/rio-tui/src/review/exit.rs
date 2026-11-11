//! 06 — Exit: the summary printed after the UI closes and the terminal is restored.

use rio_core::{EvidenceLevel, Finding};

use super::{LOGO, evidence_name, findings::location, id8};
use crate::{
    canvas::{Run, bold, pad, run},
    theme::Token,
};

/// A failing finding as the exit summary lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExitFinding {
    /// Its full identity (eight characters are shown).
    pub id: String,
    /// Its short title.
    pub title: String,
    /// `path:line`.
    pub location: String,
    /// Its evidence level.
    pub evidence: EvidenceLevel,
}

impl ExitFinding {
    /// A finding with a short title (its message when `None`).
    pub fn from_finding(finding: &Finding, title: Option<&str>) -> Self {
        Self {
            id: finding.id.clone(),
            title: title.map_or_else(|| finding.message.clone(), str::to_owned),
            location: location(finding),
            evidence: finding.evidence_level,
        }
    }
}

/// Where the report was saved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedReport {
    /// The path as given.
    pub path: String,
    /// Its size as shown, e.g. `14.2 KB`.
    pub size: String,
    /// It was also copied to the clipboard.
    pub copied: bool,
}

/// The next step to suggest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NextStep {
    /// What to do first, e.g. `fix, then`.
    pub before: String,
    /// The command, e.g. `rio review --since-last`.
    pub command: String,
    /// Why, e.g. `(round 5, diff only)`.
    pub after: String,
}

/// Everything the exit summary states.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExitData {
    /// Rio's version.
    pub version: String,
    /// The report status, e.g. `complete`.
    pub status: String,
    /// The branch, and the base it was compared with.
    pub branch: String,
    /// The base ref, if any.
    pub base: Option<String>,
    /// The preset.
    pub preset: String,
    /// The policy outcome, e.g. `policy failed: 2 findings match fail_on`.
    pub policy: String,
    /// The policy failed (the line is drawn as a failure).
    pub failed: bool,
    /// The findings that match `fail_on`.
    pub failing: Vec<ExitFinding>,
    /// Counts, e.g. `7 findings · 3 new · 1 worsened · 1 security · 2 pre-existing hidden`.
    pub counts: String,
    /// Lineage state, e.g. `1 dismissed (intentional) · round 4 of cap 3 → reconsider: …`.
    pub lineage: Option<String>,
    /// The lineage needs attention (drawn as a warning).
    pub lineage_warn: bool,
    /// Where the report was saved, if it was.
    pub saved: Option<SavedReport>,
    /// The kept cache directory.
    pub kept: Option<String>,
    /// The suggested next step.
    pub next: Option<NextStep>,
}

/// Rows 1–13 of the exit screen: the lines printed after the UI closes.
pub fn exit_summary(data: &ExitData) -> Vec<Vec<Run>> {
    let bg = Token::Bg;
    let mut rows = vec![
        vec![
            run(" ", Token::Fg, bg),
            run(
                "⋯ interactive session closed · terminal restored",
                Token::Faint,
                bg,
            ),
        ],
        vec![],
    ];
    let mut context = data.branch.clone();
    if let Some(base) = &data.base {
        context.push_str(&format!(" → {base}"));
    }
    context.push_str(&format!(" · {}", data.preset));
    rows.push(vec![
        run(LOGO, Token::Fg, bg),
        bold(
            format!("rio {} — {}", data.version, data.status),
            Token::Fg,
            bg,
        ),
        run("  ", Token::Fg, bg),
        run(context, Token::Dim, bg),
    ]);
    let (glyph, fg) = if data.failed {
        ("✕", Token::Fail)
    } else {
        ("✓", Token::Pass)
    };
    rows.push(vec![
        run(" ", Token::Fg, bg),
        bold(format!("{glyph} {}", data.policy), fg, bg),
    ]);
    rows.push(vec![]);
    for f in &data.failing {
        rows.push(vec![
            run("   ", Token::Fg, bg),
            run("●", Token::Fail, bg),
            run(" ", Token::Fg, bg),
            run(id8(&f.id), Token::Faint, bg),
            run(format!("  {}  ", pad(&f.title, 23)), Token::Fg, bg),
            run(pad(&f.location, 23), Token::Dim, bg),
            run("   ", Token::Fg, bg),
            run(evidence_name(f.evidence), Token::Signal, bg),
        ]);
    }
    rows.push(vec![
        run("   ", Token::Fg, bg),
        run(data.counts.clone(), Token::Dim, bg),
    ]);
    if let Some(lineage) = &data.lineage {
        rows.push(vec![
            run("   ", Token::Fg, bg),
            run(
                lineage.clone(),
                if data.lineage_warn {
                    Token::Warn
                } else {
                    Token::Dim
                },
                bg,
            ),
        ]);
    }
    rows.push(vec![]);
    let label = |glyph: &str, fg: Token, name: &str| {
        vec![
            run(" ", Token::Fg, bg),
            run(glyph.to_owned(), fg, bg),
            run(" ", Token::Fg, bg),
            bold(name.to_owned(), Token::Fg, bg),
            run(" ".repeat(8 - name.len()), Token::Fg, bg),
        ]
    };
    if let Some(saved) = &data.saved {
        let mut row = label("✓", Token::Pass, "saved");
        row.push(run(format!("{}  ", saved.path), Token::Fg, bg));
        let mut note = saved.size.clone();
        if saved.copied {
            note.push_str(" · copied to clipboard");
        }
        row.push(run(note, Token::Faint, bg));
        rows.push(row);
    } else {
        let mut row = label("·", Token::Faint, "saved");
        row.push(run("not saved", Token::Faint, bg));
        rows.push(row);
    }
    if let Some(kept) = &data.kept {
        let mut row = label("✓", Token::Pass, "kept");
        row.push(run(format!("{kept}  "), Token::Fg, bg));
        row.push(run("latest", Token::Faint, bg));
        rows.push(row);
    }
    if let Some(next) = &data.next {
        let mut row = label("→", Token::Signal, "next");
        row.push(run(next.before.clone(), Token::Faint, bg));
        row.push(run(" ", Token::Fg, bg));
        row.push(run(next.command.clone(), Token::Signal, bg));
        row.push(run(" ", Token::Fg, bg));
        row.push(run(next.after.clone(), Token::Faint, bg));
        rows.push(row);
    }
    rows
}

/// The exit summary as plain text, one line per row, for the host to print.
pub fn exit_text(data: &ExitData) -> String {
    exit_summary(data)
        .iter()
        .map(|row| {
            let line: String = row.iter().map(|r| r.text.as_str()).collect();
            line.trim_end().to_owned()
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}

//! 05 — Summary and export: the review's summary under the export popup.

use std::rc::Rc;

use ratatui::crossterm::event::{KeyCode, KeyEvent};
use rio_core::{CheckOutcome, Severity, State, Version};

use super::{FindingsData, chip, dialog, findings::report_status, hints, id8, put_in};
use crate::{
    app::{Action, Effect, Msg, Outcome, Screen, Session},
    canvas::{Canvas, bold, pad, run, width},
    chrome::{Board, Key, key, keybar},
    theme::Token,
};

/// The export popup's defaults.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportOptions {
    /// The header context; empty for the findings screen's context.
    pub context: String,
    /// The destination for Markdown; the extension follows the format.
    pub path: String,
    /// Where the run stays cached, e.g. `.rio/cache/1234567890ab/runs/01J9ZK4Q/ (latest)`.
    pub kept: String,
    /// Copy the saved document to the clipboard (OSC 52).
    pub copy: bool,
    /// Include pre-existing findings.
    pub include_pre_existing: bool,
    /// Open the saved file in `$EDITOR`.
    pub open_editor: bool,
}

impl Default for ExportOptions {
    fn default() -> Self {
        Self {
            context: String::new(),
            path: "./rio-review.md".into(),
            kept: String::new(),
            copy: false,
            include_pre_existing: false,
            open_editor: false,
        }
    }
}

const KEYS: &[Key] = &[
    key("↑↓", "format"),
    key("tab", "field"),
    key("space", "toggle"),
    key("⏎", "save"),
    key("esc", "cancel"),
];

const FORMATS: [(&str, &str, &str); 3] = [
    ("md", "Markdown", "report.md · for PR descriptions and chat"),
    ("json", "JSON", "report-v1 · schema-validated, for CI"),
    ("sarif", "SARIF", "SARIF 2.1.0 · for code scanning uploads"),
];

const OPTIONS: [&str; 3] = [
    "copy to clipboard (OSC 52)",
    "include pre-existing findings",
    "open in $EDITOR after saving",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Field {
    Format,
    Destination,
    Option(usize),
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Progress {
    Editing,
    Saving,
    Failed(String),
}

pub(crate) struct ExportScreen {
    data: Rc<FindingsData>,
    format: usize,
    path: String,
    options: [bool; 3],
    field: Field,
    progress: Progress,
}

impl ExportScreen {
    pub(crate) fn new(data: Rc<FindingsData>) -> Self {
        let e = &data.export;
        Self {
            format: 0,
            path: e.path.clone(),
            options: [e.copy, e.include_pre_existing, e.open_editor],
            field: Field::Format,
            progress: Progress::Editing,
            data,
        }
    }

    fn set_format(&mut self, format: usize) {
        let format = format.min(FORMATS.len() - 1);
        for (ext, _, _) in FORMATS {
            if let Some(stem) = self.path.strip_suffix(&format!(".{ext}")) {
                self.path = format!("{stem}.{}", FORMATS[format].0);
                break;
            }
        }
        self.format = format;
    }

    fn save(&mut self) -> Action {
        if self.progress == Progress::Saving || self.path.trim().is_empty() {
            return Action::None;
        }
        self.progress = Progress::Saving;
        let path = self.path.trim().to_owned();
        let mut actions = Vec::new();
        if self.options[1] {
            actions.push(Action::Effect(Effect::Step(
                "review:export-include-pre-existing".into(),
            )));
        }
        actions.push(Action::Effect(Effect::Export {
            format: FORMATS[self.format].0.into(),
            path: path.clone(),
        }));
        if self.options[0] {
            actions.push(Action::Effect(Effect::Step("review:export-copy".into())));
        }
        if self.options[2] {
            actions.push(Action::Effect(Effect::Edit { path, line: 1 }));
        }
        Action::Many(actions)
    }

    /// The first lines of the document the chosen format writes.
    fn preview(&self) -> Vec<String> {
        let data = &*self.data;
        let r = &data.report;
        let listed = data.listed();
        let failing = listed.iter().filter(|f| data.fails(f)).count();
        let status = report_status(r.status);
        match FORMATS[self.format].0 {
            "md" => {
                let mut lines = vec![
                    format!("# Rio {} — {status}", r.review.rio_version),
                    if failing > 0 {
                        format!("**Policy failed** · {failing} findings match `fail_on`")
                    } else {
                        "**Policy passed** · no finding matches `fail_on`".into()
                    },
                    format!("## Findings ({})", listed.len()),
                ];
                if let Some(f) = listed.first() {
                    lines.push(format!(
                        "- `{}` {} — {}",
                        id8(&f.id),
                        data.title(f),
                        data.place(f, 24)
                    ));
                }
                lines
            }
            "json" => vec![
                "{".into(),
                format!("  \"schema\": \"{}\",", r.schema),
                format!("  \"status\": \"{}\",", status.replace(' ', "_")),
                format!("  \"findings\": [ … {} ],", r.findings.len()),
            ],
            _ => vec![
                "{".into(),
                "  \"version\": \"2.1.0\",".into(),
                "  \"runs\": [ { \"tool\": { \"driver\": { \"name\": \"rio\" } } } ],".into(),
                format!("  … {} results", listed.len()),
            ],
        }
    }

    /// The summary under the popup, drawn dimmed.
    fn draw_summary(&self, c: &mut Canvas<'_>) {
        let data = &*self.data;
        let r = &data.report;
        let w = c.width();
        let right = w.saturating_sub(2);
        let faint = |t: String| run(t, Token::Faint, Token::Bg);
        let rule = |t: String| run(t, Token::Rule, Token::Bg);
        let mut head = format!("Review {}", report_status(r.status));
        if let Some(run_id) = &r.review.run_id {
            head.push_str(&format!("  run {run_id}"));
        }
        if let Some(id) = &r.review.id {
            head.push_str(&format!(" · review {id}"));
        }
        put_in(c, 2, 2, right, &[faint(head)]);
        let listed = data.listed();
        let failing = listed.iter().filter(|f| data.fails(f)).count();
        let (verdict, why) = if failing > 0 {
            (
                "✕ Policy failed".to_owned(),
                format!(" {failing} findings match fail_on: {}", data.policy),
            )
        } else {
            (
                "✓ Policy passed".to_owned(),
                " no finding matches fail_on".into(),
            )
        };
        let mut rows = vec![vec![rule(verdict)], vec![faint(why)]];
        if let Some(code) = data.exit_code {
            rows.push(vec![faint(format!(" exit code {code}"))]);
        }
        for (i, runs) in rows.iter().enumerate() {
            let y = 4 + i as u16;
            c.put(2, y, &rule("▌".into()));
            let x = if i == 0 { 4 } else { 3 };
            put_in(c, x, y, right, runs);
        }
        let security = |f: &&&rio_core::Finding| f.category == rio_core::Category::Security;
        let count = |state: State| {
            listed
                .iter()
                .filter(|f| !security(f) && f.state == state)
                .count()
        };
        let security = listed.iter().filter(|f| security(f)).count();
        put_in(
            c,
            2,
            8,
            right,
            &[
                faint(format!("{} findings  ", listed.len())),
                rule(format!("{} new", count(State::New))),
                faint("  ".into()),
                rule(format!("{} worsened", count(State::Worsened))),
                faint("  ".into()),
                rule(format!("{security} security")),
                faint("  ".into()),
                rule(format!("{} pre-existing", r.summary.pre_existing)),
            ],
        );
        put_in(c, 2, 10, right, &[rule("CHECKS".into())]);
        let head = r.checks.iter().filter(|c| c.version == Version::Head);
        for (y, check) in (11..).zip(head) {
            let glyph = match &check.outcome {
                CheckOutcome::Passed { .. } => "✓",
                CheckOutcome::Findings { details } => {
                    if details
                        .findings
                        .iter()
                        .any(|f| f.severity == Severity::Error)
                    {
                        "✕"
                    } else {
                        "▲"
                    }
                }
                CheckOutcome::Failed { .. } => "✕",
                CheckOutcome::Skipped { .. } | CheckOutcome::Cancelled { .. } => "-",
            };
            let root = if check.root == "." {
                ""
            } else {
                check.root.as_str()
            };
            let kind = match check.kind {
                rio_core::CheckKind::Typecheck => "typecheck",
                rio_core::CheckKind::Lint => "lint",
                rio_core::CheckKind::Secrets => "secrets",
                rio_core::CheckKind::Coverage => "coverage",
                rio_core::CheckKind::Dependencies => "audit",
            };
            put_in(
                c,
                2,
                y,
                right,
                &[
                    rule(pad(root, 4)),
                    faint(format!("  {kind:<12}")),
                    rule(format!("{glyph} ")),
                ],
            );
        }
        if !r.footer.notes.is_empty() && w >= 100 {
            put_in(c, 60, 10, right, &[rule("NOTES".into())]);
            for (i, note) in r.footer.notes.iter().enumerate() {
                put_in(c, 60, 11 + i as u16, right, &[faint(note.clone())]);
            }
        }
    }
}

impl Screen for ExportScreen {
    fn title(&self) -> &'static str {
        "Export"
    }
    fn board(&self) -> Board {
        Board::V2
    }
    fn keys(&self) -> &'static [Key] {
        KEYS
    }
    fn wants_text(&self) -> bool {
        self.field == Field::Destination
    }

    fn draw(&self, c: &mut Canvas<'_>, _session: &Session) {
        c.clear(Token::Bg);
        let data = &*self.data;
        let r = &data.report;
        let context = if data.export.context.is_empty() {
            data.context.clone()
        } else {
            data.export.context.clone()
        };
        super::head(
            c,
            &context,
            &data.header_status(Some(report_status(r.status))),
        );
        self.draw_summary(c);
        let (w, h) = (c.width(), c.height());
        let dw = 76.min(w.saturating_sub(4));
        let dh = 30.min(h.saturating_sub(3));
        let x0 = (w - dw) / 2;
        let y0 = ((h - dh) / 2 + 1).min(h.saturating_sub(dh + 1)).max(1);
        let x1 = x0 + dw - 1;
        let y1 = y0 + dh - 1;
        dialog(c, x0, y0, x1, y1, "export review");
        let cx = x0 + 3;
        let right = x1 - 1;
        let fits = |dy: u16| y0 + dy < y1;
        let mut lines: Vec<(u16, Vec<crate::canvas::Run>)> = Vec::new();
        lines.push((2, vec![bold("Export review", Token::Fg, Token::Panel)]));
        let mut about = Vec::new();
        if let Some(id) = &r.review.id {
            about.push(format!("review {id}"));
        }
        if let Some(run_id) = &r.review.run_id {
            about.push(format!("run {run_id}"));
        }
        about.push(format!("{} findings", data.listed().len()));
        lines.push((3, vec![run(about.join(" · "), Token::Dim, Token::Panel)]));
        lines.push((5, vec![bold("FORMAT", Token::Faint, Token::Panel)]));
        lines.push((10, vec![bold("DESTINATION", Token::Faint, Token::Panel)]));
        lines.push((
            12,
            vec![run(
                "tab completes paths · existing file asks before overwrite",
                Token::Faint,
                Token::Panel,
            )],
        ));
        lines.push((14, vec![bold("OPTIONS", Token::Faint, Token::Panel)]));
        // On short terminals the preview and the cache line give way to the keys.
        let compact = dh < 30;
        if !compact {
            lines.push((19, vec![bold("PREVIEW", Token::Faint, Token::Panel)]));
        }
        if !compact && !data.export.kept.is_empty() {
            lines.push((
                25,
                vec![run(
                    format!("always kept: {}", data.export.kept),
                    Token::Faint,
                    Token::Panel,
                )],
            ));
        }
        for (dy, runs) in lines {
            if fits(dy) {
                put_in(c, cx, y0 + dy, right, &runs);
            }
        }
        for (i, (_, label, about)) in FORMATS.iter().enumerate() {
            let dy = 6 + i as u16;
            if !fits(dy) {
                break;
            }
            let y = y0 + dy;
            let selected = i == self.format;
            let bg = if selected {
                c.fill(y, x0 + 2, right, Token::Raise);
                c.put(x0 + 2, y, &run("▌", Token::Signal, Token::Raise));
                c.cursor(y, x0 + 2, right);
                Token::Raise
            } else {
                Token::Panel
            };
            put_in(
                c,
                x0 + 4,
                y,
                right,
                &[
                    if selected {
                        run("(•)", Token::Signal, bg)
                    } else {
                        run("( )", Token::Faint, bg)
                    },
                    run(" ", Token::Fg, bg),
                    if selected {
                        bold(pad(label, 11), Token::Fg, bg)
                    } else {
                        run(pad(label, 11), Token::Dim, bg)
                    },
                    run(*about, Token::Faint, bg),
                ],
            );
        }
        if fits(11) {
            let y = y0 + 11;
            let field_right = x1 - 2;
            c.fill(y, cx, field_right, Token::Raise);
            let room = usize::from(field_right - cx).saturating_sub(2);
            let text = format!(" {}", self.path);
            let shown: String = if width(&text) > room {
                text.chars().skip(width(&text) - room).collect()
            } else {
                text
            };
            let end = put_in(
                c,
                cx,
                y,
                field_right,
                &[run(shown, Token::Fg, Token::Raise)],
            );
            if self.field == Field::Destination {
                c.put(end, y, &run("▏", Token::Signal, Token::Raise));
            }
        }
        for (i, label) in OPTIONS.iter().enumerate() {
            let dy = 15 + i as u16;
            if !fits(dy) {
                break;
            }
            let y = y0 + dy;
            let focused = self.field == Field::Option(i);
            let bg = if focused {
                c.fill(y, x0 + 2, right, Token::Raise);
                c.put(x0 + 2, y, &run("▌", Token::Signal, Token::Raise));
                c.cursor(y, x0 + 2, right);
                Token::Raise
            } else {
                Token::Panel
            };
            put_in(
                c,
                x0 + 4,
                y,
                right,
                &[
                    if self.options[i] {
                        run("[x]", Token::Signal, bg)
                    } else {
                        run("[ ]", Token::Faint, bg)
                    },
                    run(format!(" {label}"), Token::Fg, bg),
                ],
            );
        }
        let preview = if compact { Vec::new() } else { self.preview() };
        for (i, line) in preview.iter().enumerate() {
            let dy = 20 + i as u16;
            if !fits(dy) {
                break;
            }
            let y = y0 + dy;
            let field_right = x1 - 2;
            c.fill(y, cx, field_right, Token::Bg);
            let fg = if line.starts_with('#') {
                Token::Fg
            } else {
                Token::Dim
            };
            put_in(
                c,
                cx,
                y,
                field_right,
                &[
                    run(" ", Token::Fg, Token::Bg),
                    run(line.clone(), fg, Token::Bg),
                ],
            );
        }
        let keys_dy = if compact { 19 } else { 27 };
        if fits(keys_dy) {
            let y = y0 + keys_dy;
            match &self.progress {
                Progress::Editing => {
                    let x = chip(c, cx, y, "⏎ save");
                    hints(
                        c,
                        x,
                        y,
                        right,
                        Token::Panel,
                        &[("esc", "cancel"), ("p", "full preview")],
                    );
                }
                Progress::Saving => {
                    put_in(
                        c,
                        cx,
                        y,
                        right,
                        &[run("saving…", Token::Faint, Token::Panel)],
                    );
                }
                Progress::Failed(error) => {
                    put_in(
                        c,
                        cx,
                        y,
                        right,
                        &[run(format!("✕ {error}"), Token::Fail, Token::Panel)],
                    );
                }
            }
        }
        keybar(c, KEYS);
    }

    fn on_key(&mut self, key: KeyEvent, _session: &mut Session) -> Action {
        let editing = self.field == Field::Destination;
        match key.code {
            KeyCode::Esc => return Action::Pop,
            KeyCode::Enter => return self.save(),
            KeyCode::Tab => {
                self.field = match self.field {
                    Field::Format => Field::Destination,
                    Field::Destination => Field::Option(0),
                    Field::Option(_) => Field::Format,
                }
            }
            KeyCode::BackTab => {
                self.field = match self.field {
                    Field::Format => Field::Option(0),
                    Field::Destination => Field::Format,
                    Field::Option(_) => Field::Destination,
                }
            }
            KeyCode::Up => match self.field {
                Field::Option(i) => self.field = Field::Option(i.saturating_sub(1)),
                _ => self.set_format(self.format.saturating_sub(1)),
            },
            KeyCode::Down => match self.field {
                Field::Option(i) => self.field = Field::Option((i + 1).min(OPTIONS.len() - 1)),
                _ => self.set_format(self.format + 1),
            },
            KeyCode::Backspace if editing => {
                self.path.pop();
            }
            KeyCode::Char(ch) if editing => self.path.push(ch),
            KeyCode::Char(' ') => {
                if let Field::Option(i) = self.field {
                    self.options[i] = !self.options[i];
                }
            }
            KeyCode::Char('p') => {
                return Action::Effect(Effect::Step("review:export-preview".into()));
            }
            _ => {}
        }
        Action::None
    }

    fn on_msg(&mut self, msg: &Msg, session: &mut Session) -> Action {
        if self.progress != Progress::Saving {
            return Action::None;
        }
        match msg {
            Msg::Done(Outcome::Ok(_)) => {
                session.saved = true;
                Action::Pop
            }
            Msg::Done(Outcome::Failed(error)) => {
                self.progress = Progress::Failed(error.clone());
                Action::None
            }
            _ => Action::None,
        }
    }
}

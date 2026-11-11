//! I3 — deploying, and I4 — failed, resumable. Both draw the step list.

use ratatui::crossterm::event::{KeyCode, KeyEvent};

use super::{
    DeployedData, DeployingData, FailureData, FailureUpdate, Level, LogLine, SANDBOX_STEPS,
    StepState, StepUpdate,
    deployed::Deployed,
    widgets::{
        chip, clip, clock, content_end, gauge, header, heading, hint_row, seconds, separator,
        short_id, split, state_glyph, wrap, wrap_items,
    },
};
use crate::{
    Action, Effect, Msg, Outcome, Screen, Session,
    canvas::{Canvas, Run, bold, fit, pad, pad_left, run, width},
    chrome::{Board, Key, key, keybar, quiet, status},
    theme::Token,
};

const KEYS: &[Key] = &[
    key("↑↓", "step"),
    key("⏎", "step log"),
    key("l", "full log"),
    key("ctrl-c", "stop safely"),
];

const FAILED_KEYS: &[Key] = &[
    key("r", "retry"),
    key("s", "self-hosted"),
    key("o", "dashboard"),
    key("l", "log"),
    key("q", "quit · resume later"),
];

pub(crate) const LOG_KEYS: &[Key] = &[key("↑↓", "scroll"), key("esc", "back")];

/// A full-screen log, opened over a screen that keeps receiving progress.
pub(crate) struct LogView {
    pub title: String,
    pub lines: Vec<LogLine>,
    /// Lines scrolled up from the end.
    pub scroll: usize,
}

impl LogView {
    pub fn new(title: impl Into<String>, lines: Vec<LogLine>) -> Self {
        Self {
            title: title.into(),
            lines,
            scroll: 0,
        }
    }

    pub fn draw(&self, c: &mut Canvas<'_>) {
        let end = content_end(c);
        let w = c.width();
        clip(c, 2, 2, w, &[heading(format!("LOG · {}", self.title))]);
        let room = usize::from((end + 1).saturating_sub(3));
        if self.lines.is_empty() {
            clip(
                c,
                2,
                3,
                w,
                &[run("nothing logged yet", Token::Faint, Token::Bg)],
            );
        }
        let last = self.lines.len().saturating_sub(self.scroll);
        let first = last.saturating_sub(room);
        for (i, line) in self.lines[first..last].iter().enumerate() {
            log_line(c, 3 + i as u16, w.saturating_sub(1), line);
        }
        keybar(c, LOG_KEYS);
    }

    /// Scroll keys; `false` when the key closes the view.
    pub fn on_key(&mut self, key: KeyEvent) -> bool {
        match key.code {
            KeyCode::Up | KeyCode::Char('k') => {
                self.scroll = (self.scroll + 1).min(self.lines.len().saturating_sub(1));
            }
            KeyCode::Down | KeyCode::Char('j') => self.scroll = self.scroll.saturating_sub(1),
            KeyCode::Esc | KeyCode::Char('l') => return false,
            _ => {}
        }
        true
    }
}

/// A log line: a rule, then the text colored by level.
fn log_line(c: &mut Canvas<'_>, y: u16, right: u16, line: &LogLine) {
    let fg = match line.level {
        Level::Info => Token::Dim,
        Level::Warn => Token::Warn,
        Level::Error => Token::Fail,
    };
    clip(
        c,
        2,
        y,
        right,
        &[
            run("│", Token::Rule, Token::Bg),
            run(" ", Token::Fg, Token::Bg),
            run(line.text.as_str(), fg, Token::Bg),
        ],
    );
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Style {
    Deploying,
    Stopped,
}

/// The step list from row `y`; returns the row after it. Shows a window
/// around `cursor` when the rows don't fit.
fn draw_steps(
    c: &mut Canvas<'_>,
    data: &DeployingData,
    cursor: usize,
    style: Style,
    y: u16,
    rows: usize,
    left: u16,
) -> u16 {
    let n = data.steps.len();
    let shown = n.min(rows);
    let first = cursor
        .saturating_sub(shown / 2)
        .min(n.saturating_sub(shown));
    let mut y = y;
    for (i, step) in data.steps.iter().enumerate().skip(first).take(shown) {
        let on = i == cursor;
        // On I4, steps the failure stopped before are drawn as skipped.
        let state = match (style, step.state) {
            (Style::Stopped, StepState::Pending | StepState::Running) => StepState::Skipped,
            (_, state) => state,
        };
        let bg = match (on, state) {
            (true, StepState::Failed) => Token::FailTint,
            (true, _) => Token::Raise,
            _ => Token::Bg,
        };
        c.fill(y, 0, left, bg);
        let (glyph, gfg) = state_glyph(state);
        if on {
            let bar = match state {
                StepState::Running => Token::Warn,
                StepState::Failed => Token::Fail,
                _ => Token::Signal,
            };
            c.put(0, y, &run("▌", bar, bg));
        }
        let name_fg = match state {
            StepState::Pending => Token::Dim,
            StepState::Skipped => Token::Faint,
            _ => Token::Fg,
        };
        let (detail, detail_fg) = match (style, state) {
            (_, StepState::Failed) => (step.detail.clone(), Token::Fail),
            (Style::Stopped, StepState::Skipped) if step.state != StepState::Skipped => {
                ("skipped".to_owned(), Token::Faint)
            }
            (Style::Stopped, StepState::Done | StepState::Reused) => {
                ("in place".to_owned(), Token::Faint)
            }
            (_, StepState::Pending | StepState::Skipped) => (step.detail.clone(), Token::Faint),
            _ => (step.detail.clone(), Token::Dim),
        };
        let elapsed = match (style, step.elapsed) {
            (Style::Deploying, Some(secs)) if state.finished() => seconds(secs),
            _ => String::new(),
        };
        let name = run(pad(&step.label, 17), name_fg, bg);
        let name = if on { name.bold() } else { name };
        let right = left.saturating_sub(2);
        let detail_end =
            right.saturating_sub(width(&elapsed) as u16 + u16::from(!elapsed.is_empty()));
        let x = clip(
            c,
            2,
            y,
            detail_end,
            &[
                run(pad_left(&(i + 1).to_string(), 2), Token::Faint, bg),
                run(" ", Token::Fg, bg),
                run(glyph, gfg, bg),
                run(" ", Token::Fg, bg),
                name,
                run(detail, detail_fg, bg),
            ],
        );
        if !elapsed.is_empty() {
            let at = right.saturating_sub(width(&elapsed) as u16).max(x + 1);
            clip(c, at, y, right, &[run(elapsed, Token::Faint, bg)]);
        }
        if on {
            c.cursor(y, 0, left);
        }
        y += 1;
    }
    y
}

/// The log heading and its last lines, from row `y` to `end`.
fn draw_log_tail(c: &mut Canvas<'_>, log: &[LogLine], y: u16, end: u16, left: u16) {
    if y > end {
        return;
    }
    clip(c, 2, y, left, &[heading("LOG")]);
    let room = usize::from(end.saturating_sub(y));
    let first = log.len().saturating_sub(room);
    for (i, line) in log[first..].iter().enumerate() {
        log_line(c, y + 1 + i as u16, left.saturating_sub(2), line);
    }
}

/// The panel-colored hint across the left pane.
fn panel_hint(c: &mut Canvas<'_>, left: u16, runs: &[Run]) {
    let y = hint_row(c);
    c.fill(y, 0, left, Token::Panel);
    clip(c, 2, y, left.saturating_sub(1), runs);
}

/// I3: the deployment's steps, gauges, resource map and log tail.
pub struct Deploying {
    data: DeployingData,
    cursor: usize,
    /// The cursor follows the running step until the user moves it.
    follow: bool,
    ticks: u64,
    log: Option<LogView>,
}

impl Deploying {
    pub fn new(data: DeployingData) -> Self {
        let mut screen = Self {
            data,
            cursor: 0,
            follow: true,
            ticks: 0,
            log: None,
        };
        screen.track();
        screen
    }

    /// The deployment as it stands.
    pub fn data(&self) -> &DeployingData {
        &self.data
    }

    pub fn cursor(&self) -> usize {
        self.cursor
    }

    fn elapsed(&self) -> u64 {
        self.data.elapsed + self.ticks / 4
    }

    fn track(&mut self) {
        if !self.follow {
            return;
        }
        if let Some(i) = self
            .data
            .steps
            .iter()
            .position(|s| matches!(s.state, StepState::Running | StepState::Failed))
            .or_else(|| {
                self.data
                    .steps
                    .iter()
                    .position(|s| s.state == StepState::Pending)
            })
        {
            self.cursor = i;
        }
    }

    fn draw_right(&self, c: &mut Canvas<'_>, x: u16, end: u16) {
        let w = c.width();
        let mut y = 2;
        let line = |c: &mut Canvas<'_>, y: &mut u16, runs: &[Run]| {
            if *y <= end {
                clip(c, x, *y, w.saturating_sub(1), runs);
            }
            *y += 1;
        };
        line(
            c,
            &mut y,
            &[heading(format!("RESOURCES · {}", self.data.name))],
        );
        for r in &self.data.resources {
            let (glyph, gfg) = state_glyph(r.state);
            let name_fg = if r.state == StepState::Pending {
                Token::Dim
            } else {
                Token::Fg
            };
            let id = if r.id.is_empty() {
                "—"
            } else {
                r.id.as_str()
            };
            line(
                c,
                &mut y,
                &[
                    run(glyph, gfg, Token::Bg),
                    run(" ", Token::Fg, Token::Bg),
                    run(pad(&r.kind, 10), Token::Faint, Token::Bg),
                    run(pad(&r.name, 15), name_fg, Token::Bg),
                    run(fit(id, 7), Token::Faint, Token::Bg),
                ],
            );
        }
        if let Some(m) = &self.data.migration {
            y += 1;
            line(c, &mut y, &[heading(format!("MIGRATION {}", m.version))]);
            if y <= end {
                let cells = w.saturating_sub(x + 2);
                let fg = if m.applied >= m.total {
                    Token::Pass
                } else {
                    Token::Warn
                };
                gauge(c, x, y, cells, u64::from(m.applied), u64::from(m.total), fg);
            }
            y += 1;
            if y <= end {
                let label = format!("{} of {} statements", m.applied, m.total);
                clip(c, x, y, w, &[run(label.as_str(), Token::Dim, Token::Bg)]);
                let right = w.saturating_sub(3);
                let at = right.saturating_sub(12).max(x + width(&label) as u16 + 1);
                clip(
                    c,
                    at,
                    y,
                    right,
                    &[run("forward-only", Token::Faint, Token::Bg)],
                );
            }
            y += 1;
            line(
                c,
                &mut y,
                &[run(
                    "one D1 transaction · deploy lock",
                    Token::Faint,
                    Token::Bg,
                )],
            );
        }
        if let Some(image) = &self.data.runner_image {
            y += 1;
            line(c, &mut y, &[heading("RUNNER IMAGE")]);
            line(
                c,
                &mut y,
                &[run(image.source.as_str(), Token::Dim, Token::Bg)],
            );
            line(
                c,
                &mut y,
                &[run(
                    format!("→ {}", image.destination),
                    Token::Dim,
                    Token::Bg,
                )],
            );
            line(
                c,
                &mut y,
                &[run(image.note.as_str(), Token::Faint, Token::Bg)],
            );
        }
        if !self.data.secrets.is_empty() {
            y += 1;
            line(c, &mut y, &[heading("SECRETS")]);
            for s in &self.data.secrets {
                let (glyph, fg) = if s.done {
                    ("✓", Token::Pass)
                } else {
                    ("○", Token::Faint)
                };
                line(
                    c,
                    &mut y,
                    &[
                        run(glyph, fg, Token::Bg),
                        run(" ", Token::Fg, Token::Bg),
                        run(s.name.as_str(), Token::Dim, Token::Bg),
                    ],
                );
            }
            if !self.data.secrets_note.is_empty() {
                line(
                    c,
                    &mut y,
                    &[run(
                        self.data.secrets_note.as_str(),
                        Token::Faint,
                        Token::Bg,
                    )],
                );
            }
        }
    }
}

impl Screen for Deploying {
    fn title(&self) -> &'static str {
        "Deploying"
    }
    fn board(&self) -> Board {
        Board::V2
    }
    fn keys(&self) -> &'static [Key] {
        if self.log.is_some() { LOG_KEYS } else { KEYS }
    }

    fn draw(&self, c: &mut Canvas<'_>, _session: &Session) {
        c.clear(Token::Bg);
        let d = &self.data;
        header(
            c,
            &format!("rio init · deploying {} → {}", d.name, d.account_name),
            &[
                status(
                    format!("◐ deploying · {} of {}", d.finished(), d.steps.len()),
                    Token::Warn,
                ),
                quiet(clock(self.elapsed())),
            ],
        );
        if let Some(log) = &self.log {
            log.draw(c);
            return;
        }
        let left = split(c, 72);
        let end = content_end(c);
        separator(c, left, 1, c.height().saturating_sub(1));
        clip(
            c,
            2,
            2,
            left,
            &[
                bold(
                    format!("Deploying {} to {}", d.name, d.account_name),
                    Token::Fg,
                    Token::Bg,
                ),
                run("  ", Token::Fg, Token::Bg),
                run(short_id(&d.account_id), Token::Faint, Token::Bg),
            ],
        );
        gauge(
            c,
            2,
            3,
            left.saturating_sub(4),
            d.finished() as u64,
            d.steps.len() as u64,
            Token::Signal,
        );
        clip(c, 2, 5, left, &[heading("STEPS")]);
        // Steps, the legend, then the log tail when there is room.
        let rows = usize::from((end + 1).saturating_sub(7));
        let y = draw_steps(c, d, self.cursor, Style::Deploying, 6, rows, left);
        if y <= end {
            clip(
                c,
                5,
                y,
                left,
                &[run(
                    "✓ done   ↺ reused   ◐ running   ○ pending",
                    Token::Faint,
                    Token::Bg,
                )],
            );
        }
        draw_log_tail(c, &d.log, y + 2, end, left);
        panel_hint(
            c,
            left,
            &[
                bold("ctrl-c", Token::Fg, Token::Panel),
                run(
                    " is safe · rerun rio deploy to resume",
                    Token::Faint,
                    Token::Panel,
                ),
            ],
        );
        self.draw_right(c, left + 2, end);
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
            KeyCode::Up | KeyCode::Char('k') => {
                self.follow = false;
                self.cursor = self.cursor.saturating_sub(1);
            }
            KeyCode::Down | KeyCode::Char('j') => {
                self.follow = false;
                self.cursor = (self.cursor + 1).min(self.data.steps.len().saturating_sub(1));
            }
            KeyCode::Enter => {
                if let Some(step) = self.data.steps.get(self.cursor) {
                    self.log = Some(LogView::new(
                        format!("{} {}", self.cursor + 1, step.label),
                        step.log.clone(),
                    ));
                }
            }
            KeyCode::Char('l') => {
                self.log = Some(LogView::new("deployment", self.data.log.clone()));
            }
            // The deployment runs on: ctrl-c stops it safely, esc does nothing.
            KeyCode::Esc => return Action::Many(vec![]),
            _ => {}
        }
        Action::None
    }

    fn on_msg(&mut self, msg: &Msg, _session: &mut Session) -> Action {
        match msg {
            Msg::Tick => self.ticks += 1,
            Msg::Done(Outcome::Value(name, value)) => match name.as_str() {
                "init:step" => {
                    if let Ok(update) = serde_json::from_value::<StepUpdate>(value.clone()) {
                        self.data.apply(update);
                        self.track();
                        if let Some(log) = &mut self.log {
                            log.lines = self.data.log.clone();
                        }
                    }
                }
                "init:failed" => {
                    if let Ok(update) = serde_json::from_value::<FailureUpdate>(value.clone()) {
                        let mut data = self.data.clone();
                        data.elapsed = self.elapsed();
                        let failure = FailureData::from(update);
                        if let Some(step) = data.steps.iter_mut().find(|s| {
                            s.id == failure.step || s.label.eq_ignore_ascii_case(&failure.step)
                        }) {
                            step.state = StepState::Failed;
                            if !failure.error.title.is_empty() {
                                step.detail = failure.error.title.clone();
                            }
                        }
                        return Action::Replace(Box::new(Failed::new(data, failure)));
                    }
                }
                "init:deployed" => {
                    if let Ok(done) = serde_json::from_value::<DeployedData>(value.clone()) {
                        let mut data = self.data.clone();
                        data.elapsed = self.elapsed();
                        return Action::Replace(Box::new(Deployed::new(data, done)));
                    }
                }
                _ => {}
            },
            _ => {}
        }
        Action::None
    }
}

/// I4: the failed step, the provider's error, what is kept and how to go on.
pub struct Failed {
    data: DeployingData,
    failure: FailureData,
    log: Option<LogView>,
}

impl Failed {
    pub fn new(data: DeployingData, failure: FailureData) -> Self {
        Self {
            data,
            failure,
            log: None,
        }
    }

    fn failed_index(&self) -> usize {
        self.data
            .steps
            .iter()
            .position(|s| s.state == StepState::Failed)
            .or_else(|| {
                self.data
                    .steps
                    .iter()
                    .position(|s| s.id == self.failure.step)
            })
            .unwrap_or(0)
    }

    /// Back to I3 at the failed step; finished steps stay finished.
    fn resume(&self, self_hosted: bool) -> Deploying {
        let mut data = self.data.clone();
        for step in &mut data.steps {
            if self_hosted && SANDBOX_STEPS.contains(&step.id.as_str()) {
                step.state = StepState::Skipped;
                step.detail = "self-hosted runner".into();
            } else if step.state == StepState::Failed {
                step.state = StepState::Running;
                step.detail = "retrying".into();
            }
        }
        if self_hosted {
            for r in &mut data.resources {
                if matches!(r.kind.as_str(), "Registry" | "Sandbox") {
                    r.state = StepState::Skipped;
                }
            }
            let running = data.steps.iter().any(|s| s.state == StepState::Running);
            if let Some(step) = data
                .steps
                .iter_mut()
                .find(|s| s.state == StepState::Pending)
                .filter(|_| !running)
            {
                step.state = StepState::Running;
            }
        }
        data.log.push(LogLine::info(if self_hosted {
            "Resuming with the self-hosted runner…".to_owned()
        } else {
            format!(
                "Retrying {}…",
                self.data
                    .steps
                    .get(self.failed_index())
                    .map_or("", |s| s.label.as_str())
            )
        }));
        Deploying::new(data)
    }

    fn draw_right(&self, c: &mut Canvas<'_>, x: u16, end: u16) {
        let w = c.width();
        let f = &self.failure;
        // The error block.
        let box_w = w.saturating_sub(x + 1);
        let inner = usize::from(box_w.saturating_sub(4));
        let title = "┌─ error ";
        let top = format!(
            "{title}{}┐",
            "─".repeat(usize::from(box_w).saturating_sub(width(title) + 1))
        );
        let mut body: Vec<Run> = vec![bold(format!("✕ {}", f.error.title), Token::Fail, Token::Bg)];
        if !f.error.request.is_empty() {
            body.push(run(f.error.request.as_str(), Token::Faint, Token::Bg));
        }
        if !f.error.message.is_empty() {
            body.push(run("", Token::Fg, Token::Bg));
            // A short measure keeps the provider's message readable.
            for line in wrap(&f.error.message, inner.min(32)) {
                body.push(run(line, Token::Dim, Token::Bg));
            }
        }
        body.push(run("", Token::Fg, Token::Bg));
        let mut y = 2;
        if y <= end {
            clip(c, x, y, w, &[run(top, Token::Fail, Token::Bg)]);
        }
        y += 1;
        for r in body {
            if y > end {
                break;
            }
            c.put(x, y, &run("│", Token::Fail, Token::Bg));
            clip(c, x + 2, y, (x + box_w).saturating_sub(1), &[r]);
            c.put(
                (x + box_w).saturating_sub(1),
                y,
                &run("│", Token::Fail, Token::Bg),
            );
            y += 1;
        }
        if y <= end {
            let bottom = format!("└{}┘", "─".repeat(usize::from(box_w).saturating_sub(2)));
            clip(c, x, y, w, &[run(bottom, Token::Fail, Token::Bg)]);
        }
        y += 2;
        let line = |c: &mut Canvas<'_>, y: &mut u16, runs: &[Run]| {
            if *y <= end {
                clip(c, x, *y, w.saturating_sub(1), runs);
            }
            *y += 1;
        };
        if !f.fixes.is_empty() {
            line(c, &mut y, &[heading("HOW TO FIX")]);
            for fix in &f.fixes {
                let key = match fix.key {
                    Some(k) => bold(k.to_string(), Token::Fg, Token::Bg),
                    None => run("·", Token::Faint, Token::Bg),
                };
                line(
                    c,
                    &mut y,
                    &[key, run(format!("  {}", fix.title), Token::Fg, Token::Bg)],
                );
                if !fix.hint.is_empty() {
                    line(
                        c,
                        &mut y,
                        &[run(format!("   {}", fix.hint), Token::Faint, Token::Bg)],
                    );
                }
            }
            y += 1;
        }
        line(c, &mut y, &[heading("THEN")]);
        if y <= end {
            chip(
                c,
                x,
                y,
                &format!("r retry step {}", self.failed_index() + 1),
                20,
            );
        }
        y += 2;
        line(
            c,
            &mut y,
            &[run("or later, from any shell:", Token::Faint, Token::Bg)],
        );
        line(
            c,
            &mut y,
            &[
                run("rio deploy  ", Token::Fg, Token::Bg),
                run("resumes here", Token::Faint, Token::Bg),
            ],
        );
        if !f.created.is_empty() {
            y += 1;
            line(c, &mut y, &[heading("KEPT")]);
            for l in wrap_items(&f.created, 40) {
                line(c, &mut y, &[run(l, Token::Dim, Token::Bg)]);
            }
        }
    }
}

impl Screen for Failed {
    fn title(&self) -> &'static str {
        "Deployment stopped"
    }
    fn board(&self) -> Board {
        Board::V2
    }
    fn keys(&self) -> &'static [Key] {
        if self.log.is_some() {
            LOG_KEYS
        } else {
            FAILED_KEYS
        }
    }
    fn owns_quit(&self) -> bool {
        true
    }

    fn draw(&self, c: &mut Canvas<'_>, _session: &Session) {
        c.clear(Token::Bg);
        let d = &self.data;
        let failed = self.failed_index();
        header(
            c,
            &format!("rio init · {} → {}", d.name, d.account_name),
            &[
                status(
                    format!("✕ stopped at step {} of {}", failed + 1, d.steps.len()),
                    Token::Fail,
                ),
                quiet(clock(d.elapsed)),
            ],
        );
        if let Some(log) = &self.log {
            log.draw(c);
            return;
        }
        let left = split(c, 72);
        let end = content_end(c);
        separator(c, left, 1, c.height().saturating_sub(1));
        clip(
            c,
            2,
            2,
            left,
            &[
                bold("Deployment stopped", Token::Fail, Token::Bg),
                run("  nothing was rolled back", Token::Fg, Token::Bg),
            ],
        );
        gauge(
            c,
            2,
            3,
            left.saturating_sub(4),
            d.finished() as u64,
            d.steps.len() as u64,
            Token::Fail,
        );
        clip(c, 2, 5, left, &[heading("STEPS")]);
        let rows = usize::from((end + 1).saturating_sub(6));
        let y = draw_steps(c, d, failed, Style::Stopped, 6, rows, left);
        draw_log_tail(c, &d.log, y + 1, end, left);
        let kept = d
            .steps
            .iter()
            .filter(|s| matches!(s.state, StepState::Done | StepState::Reused))
            .count();
        panel_hint(
            c,
            left,
            &[run(
                format!("{kept} resources kept · retry or rio deploy reuses them"),
                Token::Faint,
                Token::Panel,
            )],
        );
        self.draw_right(c, left + 2, end);
        keybar(c, FAILED_KEYS);
    }

    fn on_key(&mut self, key: KeyEvent, _session: &mut Session) -> Action {
        if let Some(log) = &mut self.log {
            if key.code == KeyCode::Char('q') {
                return Action::Effect(Effect::Quit);
            }
            if !log.on_key(key) {
                self.log = None;
            }
            return Action::Many(vec![]);
        }
        match key.code {
            KeyCode::Char('r') => Action::Many(vec![
                Action::Effect(Effect::Step("init:retry".into())),
                Action::Replace(Box::new(self.resume(false))),
            ]),
            KeyCode::Char('s') => Action::Many(vec![
                Action::Effect(Effect::Step("init:self-hosted".into())),
                Action::Replace(Box::new(self.resume(true))),
            ]),
            KeyCode::Char('o') => Action::Effect(Effect::Open(self.failure.dashboard.clone())),
            KeyCode::Char('l') => {
                self.log = Some(LogView::new("deployment", self.data.log.clone()));
                Action::None
            }
            // Resume later: the host keeps `deployment.pending`.
            KeyCode::Char('q') => Action::Effect(Effect::Quit),
            // Nothing to go back to: the deployment stopped here.
            KeyCode::Esc => Action::Many(vec![]),
            _ => Action::None,
        }
    }
}

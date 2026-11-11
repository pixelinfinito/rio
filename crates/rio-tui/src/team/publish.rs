//! P2: exactly what publishing would post (inline comments, the summary
//! comment and the check run), and the y/N consent dialog.
//!
//! Publishing posts what the preview shows; nothing is posted before `y`.

use ratatui::crossterm::event::{KeyCode, KeyEvent};
use rio_core::{Finding, PublishPolicy, UnpublishedReason};
use serde::{Deserialize, Serialize};

use crate::{
    app::{Action, Effect, Msg, Outcome, Screen, Session},
    canvas::{Canvas, Run, bold, pad, run},
    chrome::{Board, Key, Status, focus, key, keybar, quiet, status},
    theme::Token,
};

use super::ui::{Pane, body_bottom, cells, dialog, dim, footer, plural, short, top, vrule, wrap};

/// What P2 shows besides the preview itself: the pull request, the lineage
/// and the findings the preview's ids refer to.
#[derive(Debug, Clone)]
pub struct PublishData {
    /// `owner/name` of the pull request's repository.
    pub repository: String,
    /// Pull request number.
    pub pr: u64,
    /// Head branch, e.g. `parser-guards`.
    pub head: String,
    /// Base branch, e.g. `main`.
    pub base: String,
    /// The pull request author's login.
    pub author: String,
    /// The pull request comes from a fork.
    pub fork: bool,
    /// The user's role as the host reports it, e.g. `maintainer (GitHub)`.
    pub you: String,
    /// The app that posts, e.g. `rio[bot]`.
    pub app: String,
    /// The app is installed on the repository.
    pub installed: bool,
    /// Lineage kind (`pr` or `branch`).
    pub lineage: String,
    /// Lineage round of this review and the round cap.
    pub round: u32,
    pub cap: u32,
    /// The policy the profile resolves, shown until the preview answers.
    pub policy: PublishPolicy,
    /// The review's findings, to name the preview's ids by path.
    pub findings: Vec<Finding>,
    /// Identities that already have an inline comment in this lineage: theirs is edited in place.
    pub posted: Vec<String>,
    /// The lineage's existing summary comment, edited rather than duplicated.
    pub summary_comment: Option<u64>,
    /// Review threads publishing resolves, each with its reason.
    pub resolved: u32,
    /// The preview once fetched (`Outcome::Value("publish:preview", …)`).
    pub preview: Option<Preview>,
}

impl Default for PublishData {
    fn default() -> Self {
        Self {
            repository: String::new(),
            pr: 0,
            head: String::new(),
            base: String::new(),
            author: String::new(),
            fork: false,
            you: String::new(),
            app: "rio[bot]".into(),
            installed: true,
            lineage: "pr".into(),
            round: 1,
            cap: 1,
            policy: PublishPolicy::Ask,
            findings: Vec::new(),
            posted: Vec::new(),
            summary_comment: None,
            resolved: 0,
            preview: None,
        }
    }
}

/// The body of `POST /v1/reviews/{id}/publish?dry_run=1` (`Preview` in
/// `worker/src/publish.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Preview {
    pub policy: PublishPolicy,
    /// Why nothing, or only the check run, would be posted.
    #[serde(default)]
    pub reason: Option<UnpublishedReason>,
    /// Inline comments with their anchors and Markdown bodies.
    #[serde(default)]
    pub comments: Vec<PreviewComment>,
    /// Findings listed in the summary only.
    #[serde(default)]
    pub unanchored: Vec<String>,
    /// The summary comment's Markdown.
    #[serde(default)]
    pub summary: Option<String>,
    /// The check run.
    #[serde(default)]
    pub check: Option<CheckPreview>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreviewComment {
    /// Finding identity.
    pub id: String,
    pub path: String,
    pub line: u32,
    #[serde(default)]
    pub start_line: Option<u32>,
    /// Markdown body as the publisher would post it.
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckPreview {
    pub title: String,
    pub summary: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub conclusion: Option<String>,
}

const KEYS: &[Key] = &[
    focus("y", "publish"),
    key("n", "keep local"),
    key("e", "edit selection"),
    key("↑↓", "preview item"),
    key("esc", "back"),
];

/// Under `publish: never` there is no publish key.
const NEVER_KEYS: &[Key] = &[
    key("n", "keep local"),
    key("↑↓", "preview item"),
    key("esc", "back"),
];

/// One selectable item of the plan.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Item {
    Comment(usize),
    Summary,
}

pub struct PublishScreen {
    data: PublishData,
    cursor: usize,
    /// The consent dialog is hidden to browse the preview (`e`).
    browsing: bool,
    /// `y` was pressed; a second `y` never posts twice.
    requested: bool,
    /// A line for the footer: why a key did nothing.
    message: Option<String>,
    /// The preview request failed.
    error: Option<String>,
}

/// P2. Expects `Outcome::Value("publish:preview", <Preview JSON>)` after
/// `Effect::PreviewPublish`.
pub fn publish(data: PublishData) -> Box<dyn Screen> {
    Box::new(PublishScreen::new(data))
}

impl PublishScreen {
    pub fn new(data: PublishData) -> Self {
        Self {
            data,
            cursor: 0,
            browsing: false,
            requested: false,
            message: None,
            error: None,
        }
    }

    fn policy(&self) -> PublishPolicy {
        self.data
            .preview
            .as_ref()
            .map_or(self.data.policy, |p| p.policy)
    }

    fn items(&self) -> Vec<Item> {
        let Some(p) = &self.data.preview else {
            return Vec::new();
        };
        let mut items: Vec<Item> = (0..p.comments.len()).map(Item::Comment).collect();
        if p.summary.is_some() {
            items.push(Item::Summary);
        }
        items
    }

    /// Something would be posted and the policy allows asking.
    fn can_publish(&self) -> bool {
        match &self.data.preview {
            Some(p) => {
                p.policy != PublishPolicy::Never
                    && (!p.comments.is_empty() || p.summary.is_some() || p.check.is_some())
            }
            None => false,
        }
    }

    fn path_of(&self, id: &str) -> Option<String> {
        self.data
            .findings
            .iter()
            .find(|f| f.id == id)
            .map(|f| f.location.path.clone())
    }

    fn edited(&self, id: &str) -> bool {
        self.data.posted.iter().any(|p| p == id)
    }
}

impl Screen for PublishScreen {
    fn title(&self) -> &'static str {
        "Publish preview"
    }
    fn board(&self) -> Board {
        Board::V3
    }
    fn keys(&self) -> &'static [Key] {
        if self.policy() == PublishPolicy::Never {
            NEVER_KEYS
        } else {
            KEYS
        }
    }

    fn draw(&self, c: &mut Canvas<'_>, session: &Session) {
        c.clear(Token::Bg);
        let policy = policy_name(self.policy());
        let context = format!("review · PR #{} · publish: {policy}", self.data.pr);
        let state: Status = if self.requested {
            status("publishing", Token::Signal)
        } else if self.error.is_some() {
            status("preview failed", Token::Fail)
        } else if self.data.preview.is_none() {
            quiet("loading preview")
        } else if self.policy() == PublishPolicy::Never {
            status("publish: never", Token::Warn)
        } else if self.can_publish() {
            status("awaiting your answer", Token::Warn)
        } else {
            quiet("nothing to publish")
        };
        let round = quiet(format!("round {}/{}", self.data.round, self.data.cap));
        top(c, &context, &[state, round]);
        let bottom = body_bottom(c);
        let wide = c.width() >= 120;
        let (left, mid, right) = if wide {
            (
                Some(Pane::new(0, 30, bottom)),
                Pane::new(31, 75, bottom),
                Pane::new(76, c.width(), bottom),
            )
        } else {
            let split = c.width() / 2;
            (
                None,
                Pane::new(0, split, bottom),
                Pane::new(split + 1, c.width(), bottom),
            )
        };
        if let Some(left) = left {
            vrule(c, left.right, 1, bottom);
            self.draw_context(c, left);
        }
        vrule(c, mid.right, 1, bottom);
        self.draw_plan(c, mid);
        self.draw_preview(c, right);
        let own = self.message.clone().unwrap_or_else(|| {
            "nothing has been posted · n keeps the report local and still writes the run record"
                .to_owned()
        });
        footer(
            c,
            session,
            &[run(format!(" {own}"), Token::Faint, Token::Bg)],
        );
        let dialog_open = self.data.preview.is_some() && !self.browsing && !self.requested;
        if dialog_open && (self.can_publish() || self.policy() == PublishPolicy::Never) {
            dim(c, 2, bottom + 1);
            self.draw_dialog(c);
        }
        keybar(c, self.keys());
    }

    fn on_key(&mut self, key: KeyEvent, session: &mut Session) -> Action {
        let items = self.items().len();
        match key.code {
            KeyCode::Char('y') => {
                if self.requested {
                    return Action::None;
                }
                if self.policy() == PublishPolicy::Never {
                    self.message = Some("publish: never · the profile forbids publishing".into());
                    return Action::None;
                }
                if !self.can_publish() {
                    self.message = Some(if self.data.preview.is_none() {
                        "the preview has not loaded; nothing was posted".into()
                    } else {
                        "nothing to publish".into()
                    });
                    return Action::None;
                }
                self.requested = true;
                self.message = Some("publishing what this preview shows".into());
                return Action::Effect(Effect::Publish);
            }
            KeyCode::Char('n') => {
                session.notice = Some(Outcome::Ok(
                    "nothing posted · the report stays local and the run record is written".into(),
                ));
                return Action::Pop;
            }
            KeyCode::Char('e') => {
                self.browsing = !self.browsing;
                self.message = Some(
                    "publishing posts every item shown here; dismiss a finding to leave it out"
                        .into(),
                );
            }
            KeyCode::Up | KeyCode::Char('k') => self.cursor = self.cursor.saturating_sub(1),
            KeyCode::Down | KeyCode::Char('j') if self.cursor + 1 < items => {
                self.cursor += 1;
            }
            _ => {}
        }
        Action::None
    }

    fn on_msg(&mut self, msg: &Msg, _session: &mut Session) -> Action {
        match msg {
            Msg::Done(Outcome::Value(name, value)) if name == "publish:preview" => {
                match serde_json::from_value::<Preview>(value.clone()) {
                    Ok(preview) => {
                        self.data.preview = Some(preview);
                        self.error = None;
                        self.cursor = 0;
                    }
                    Err(error) => self.error = Some(format!("unreadable preview: {error}")),
                }
            }
            Msg::Done(Outcome::Failed(error)) => {
                if self.data.preview.is_none() {
                    self.error = Some(error.clone());
                }
                self.requested = false;
            }
            Msg::Done(Outcome::Ok(_)) if self.requested => {
                self.message = Some("published".into());
            }
            _ => {}
        }
        Action::None
    }
}

fn policy_name(policy: PublishPolicy) -> &'static str {
    match policy {
        PublishPolicy::Never => "never",
        PublishPolicy::Ask => "ask",
        PublishPolicy::Auto => "auto",
    }
}

fn reason_text(reason: UnpublishedReason) -> &'static str {
    match reason {
        UnpublishedReason::PolicyNever => "publish: never",
        UnpublishedReason::AskWithoutConsent => "ask without consent",
        UnpublishedReason::ForkNotEscalated => "fork PR not escalated by a maintainer",
        UnpublishedReason::NoInstallation => "the app is not installed",
    }
}

impl PublishScreen {
    fn draw_context(&self, c: &mut Canvas<'_>, pane: Pane) {
        let d = &self.data;
        let faint = |t: String| run(t, Token::Faint, Token::Bg);
        let fg = |t: String| run(t, Token::Fg, Token::Bg);
        pane.put(
            c,
            2,
            &[
                bold(format!(" PR #{}", d.pr), Token::Fg, Token::Bg),
                fg(format!(" {} → {}", d.head, d.base)),
            ],
        );
        pane.put(
            c,
            3,
            &[
                faint(" author ".into()),
                fg(format!("@{}", d.author.trim_start_matches('@'))),
                faint(if d.fork { " · fork" } else { " · not a fork" }.into()),
            ],
        );
        pane.put(c, 4, &[faint(" you    ".into()), fg(d.you.clone())]);
        pane.put(
            c,
            5,
            &[
                faint(" app    ".into()),
                fg(format!(
                    "{} {}",
                    d.app,
                    if d.installed {
                        "installed"
                    } else {
                        "not installed"
                    }
                )),
            ],
        );
        pane.put(
            c,
            6,
            &[
                faint(" lineage ".into()),
                fg(format!("{} · round {} of {}", d.lineage, d.round, d.cap)),
            ],
        );
        pane.rule(c, 7, 0);
        let policy = self.policy();
        pane.put(
            c,
            8,
            &[
                bold(" POLICY", Token::Faint, Token::Bg),
                fg(format!("  publish: {}", policy_name(policy))),
            ],
        );
        for (y, p, text) in [
            (9, PublishPolicy::Ask, " ask   preview, then y/N"),
            (10, PublishPolicy::Auto, " auto  posts without asking"),
            (11, PublishPolicy::Never, " never check run only"),
        ] {
            let tone = if p == policy { Token::Fg } else { Token::Faint };
            pane.put(c, y, &[run(text, tone, Token::Bg)]);
        }
        pane.rule(c, 12, 0);
        let check = self.data.preview.as_ref().and_then(|p| p.check.as_ref());
        let name = check
            .and_then(|k| k.name.clone())
            .unwrap_or_else(|| "rio/review".into());
        pane.put(
            c,
            13,
            &[bold(format!(" CHECK RUN  {name}"), Token::Faint, Token::Bg)],
        );
        match check {
            Some(k) => {
                let conclusion = k.conclusion.clone().unwrap_or_else(|| "neutral".into());
                let (mark, tone) = if conclusion == "failure" {
                    ("✕", Token::Fail)
                } else {
                    ("◇", Token::Dim)
                };
                pane.put(
                    c,
                    14,
                    &[run(format!(" {mark} {conclusion}"), tone, Token::Bg)],
                );
                let note = if conclusion == "failure" {
                    "   fails the check on fail_on"
                } else {
                    "   never blocks, never approves"
                };
                pane.put(c, 15, &[faint(note.into())]);
                pane.put(c, 16, &[fg(format!(" {}", k.title))]);
                let first = k
                    .summary
                    .lines()
                    .find(|l| !l.trim().is_empty())
                    .unwrap_or("");
                pane.put(
                    c,
                    17,
                    &[run(format!(" {}", first.trim()), Token::Dim, Token::Bg)],
                );
            }
            None => {
                pane.put(c, 14, &[faint(" no check run".into())]);
            }
        }
        pane.rule(c, 18, 0);
        pane.put(c, 19, &[bold(" FORK RULE", Token::Faint, Token::Bg)]);
        pane.put(c, 20, &[faint("  fork PRs stay static-only".into())]);
        pane.put(c, 21, &[faint("  unpublished until a maintainer".into())]);
        pane.put(c, 22, &[faint("  comments /rio review".into())]);
    }

    fn draw_plan(&self, c: &mut Canvas<'_>, pane: Pane) {
        let Some(p) = &self.data.preview else {
            pane.put(c, 2, &[bold(" Publish plan", Token::Fg, Token::Bg)]);
            pane.rule(c, 3, 0);
            let text = match &self.error {
                Some(e) => run(format!(" ✕ {e}"), Token::Fail, Token::Bg),
                None => run(
                    " asking the endpoint what would be posted…",
                    Token::Faint,
                    Token::Bg,
                ),
            };
            pane.put(c, 4, &[text]);
            return;
        };
        let actions = p.comments.len()
            + usize::from(p.summary.is_some())
            + if p.summary.is_some() {
                p.unanchored.len()
            } else {
                0
            }
            + if p.summary.is_some() || !p.comments.is_empty() {
                self.data.resolved as usize
            } else {
                0
            }
            + usize::from(p.check.is_some());
        pane.put(
            c,
            2,
            &[
                bold(" Publish plan", Token::Fg, Token::Bg),
                run(
                    format!("   {}", plural(actions, "action", "actions")),
                    Token::Dim,
                    Token::Bg,
                ),
            ],
        );
        pane.rule(c, 3, 0);
        let mut y = 4;
        if let Some(reason) = p.reason {
            pane.put(
                c,
                y,
                &[run(
                    format!(" nothing inline: {}", reason_text(reason)),
                    Token::Warn,
                    Token::Bg,
                )],
            );
            y += 2;
        }
        pane.put(
            c,
            y,
            &[
                bold(" INLINE", Token::Faint, Token::Bg),
                run(
                    format!(" · anchored on diff lines  {}", p.comments.len()),
                    Token::Faint,
                    Token::Bg,
                ),
            ],
        );
        y += 1;
        let items = self.items();
        let focused = items.get(self.cursor).copied();
        let path_room = pane.width().saturating_sub(16);
        for (i, comment) in p.comments.iter().enumerate() {
            let edit = self.edited(&comment.id);
            let (mark, mark_fg, kind) = if edit {
                ("~", Token::Warn, "edit")
            } else {
                ("+", Token::Pass, "new")
            };
            let at = pad(
                &format!("{}:{}", comment.path, comment.line),
                path_room.min(20),
            );
            let cursor = focused == Some(Item::Comment(i));
            let bg = if cursor { Token::Raise } else { Token::Bg };
            pane.put(
                c,
                y,
                &[
                    run(if cursor { "▌ " } else { "  " }, Token::Signal, bg),
                    run(format!("{mark} "), mark_fg, bg),
                    run(format!("{} ", short(&comment.id)), Token::Faint, bg),
                    run(at, Token::Signal, bg),
                    run(kind, Token::Dim, bg),
                ],
            );
            if cursor {
                c.cursor(y, pane.x, pane.right);
            }
            y += 1;
        }
        if p.comments.is_empty() {
            pane.put(c, y, &[run("  no inline comment", Token::Faint, Token::Bg)]);
            y += 1;
        }
        y += 1;
        pane.put(
            c,
            y,
            &[
                bold(" SUMMARY", Token::Faint, Token::Bg),
                run(" · one per lineage", Token::Faint, Token::Bg),
            ],
        );
        y += 1;
        if p.summary.is_some() {
            let cursor = focused == Some(Item::Summary);
            let bg = if cursor { Token::Raise } else { Token::Bg };
            let (mark, mark_fg, what, why) = match self.data.summary_comment {
                Some(n) => (
                    "~",
                    Token::Warn,
                    format!("edit comment #{n}"),
                    "never a 2nd",
                ),
                None => (
                    "+",
                    Token::Pass,
                    "new comment".to_owned(),
                    "one per lineage",
                ),
            };
            pane.put(
                c,
                y,
                &[
                    run(if cursor { "▌  " } else { "   " }, Token::Signal, bg),
                    run(format!("{mark} "), mark_fg, bg),
                    run(format!("{}   ", pad(&what, 18)), Token::Fg, bg),
                    run(why, Token::Dim, bg),
                ],
            );
            if cursor {
                c.cursor(y, pane.x, pane.right);
            }
            y += 1;
            for id in &p.unanchored {
                let path = self.path_of(id).unwrap_or_default();
                pane.put(
                    c,
                    y,
                    &[
                        run("   + ", Token::Pass, Token::Bg),
                        run(format!("{} ", short(id)), Token::Faint, Token::Bg),
                        run(
                            pad(&path, 21usize.saturating_sub(short(id).len() + 1)),
                            Token::Fg,
                            Token::Bg,
                        ),
                        run("not in diff", Token::Dim, Token::Bg),
                    ],
                );
                y += 1;
            }
        } else {
            pane.put(
                c,
                y,
                &[run("   no summary comment", Token::Faint, Token::Bg)],
            );
        }
    }

    fn draw_preview(&self, c: &mut Canvas<'_>, pane: Pane) {
        let Some(p) = &self.data.preview else {
            pane.put(c, 2, &[bold(" PREVIEW", Token::Faint, Token::Bg)]);
            pane.rule(c, 3, 0);
            return;
        };
        let item = self.items().get(self.cursor).copied();
        let (title, body) = match item {
            Some(Item::Comment(i)) => {
                let k = &p.comments[i];
                let lines = match k.start_line {
                    Some(start) if start < k.line => format!("{start}-{}", k.line),
                    _ => k.line.to_string(),
                };
                (
                    format!(" PREVIEW  {} on {}:{lines}", self.data.app, k.path),
                    k.body.clone(),
                )
            }
            Some(Item::Summary) => (
                format!(" PREVIEW  {} · summary comment", self.data.app),
                p.summary.clone().unwrap_or_default(),
            ),
            None => (
                " PREVIEW".to_owned(),
                match &p.check {
                    Some(k) => format!("{}\n\n{}", k.title, k.summary),
                    None => "nothing would be posted".to_owned(),
                },
            ),
        };
        pane.put(c, 2, &[bold(title, Token::Faint, Token::Bg)]);
        pane.rule(c, 3, 0);
        let mut y = 4;
        let room = pane.width().saturating_sub(2);
        let mut first = true;
        let mut blank = false;
        for source in body.lines() {
            let (text, line_run): (String, fn(String) -> Run) = markdown(source);
            if text.trim().is_empty() {
                if !blank && !first {
                    y += 1;
                }
                blank = true;
                continue;
            }
            blank = false;
            for line in wrap(&text, room) {
                let r = if first {
                    bold(format!(" {line}"), Token::Fg, Token::Bg)
                } else {
                    line_run(format!(" {line}"))
                };
                pane.put(c, y, &[r]);
                y += 1;
            }
            first = false;
            if !pane.has(y) {
                break;
            }
        }
    }

    fn draw_dialog(&self, c: &mut Canvas<'_>) {
        let w = 64.min(c.width().saturating_sub(2));
        let h = 12;
        let x = c.width().saturating_sub(w) / 2;
        let y = (c.height().saturating_sub(h) / 2).saturating_sub(2).max(1);
        let Some(p) = &self.data.preview else {
            return;
        };
        let pane = Pane::new(x + 2, x + w.saturating_sub(2), y + h - 1);
        if p.policy == PublishPolicy::Never {
            dialog(c, x, y, w, h, "publish: never");
            pane.put(
                c,
                y + 2,
                &[bold(
                    "  The profile's policy forbids publishing.",
                    Token::Warn,
                    Token::Raise,
                )],
            );
            pane.put(
                c,
                y + 3,
                &[run(
                    "  Nothing is posted; the run record is still written.",
                    Token::Dim,
                    Token::Raise,
                )],
            );
            pane.put(
                c,
                y + 5,
                &[run(
                    "  Change publish: in the profile to post from here.",
                    Token::Faint,
                    Token::Raise,
                )],
            );
            pane.put(
                c,
                y + 9,
                &[
                    run("  ", Token::Fg, Token::Raise),
                    bold(" n  keep local ", Token::Fg, Token::Panel),
                    run("    ", Token::Fg, Token::Raise),
                    bold(" esc  back ", Token::Fg, Token::Panel),
                ],
            );
            return;
        }
        dialog(
            c,
            x,
            y,
            w,
            h,
            &format!("Publish to {}#{}?", self.data.repository, self.data.pr),
        );
        let edits = p.comments.iter().filter(|k| self.edited(&k.id)).count();
        let news = p.comments.len() - edits;
        let line = |label: String, detail: String| {
            [
                bold(format!("  {}", pad(&label, 20)), Token::Fg, Token::Raise),
                run(detail, Token::Dim, Token::Raise),
            ]
        };
        let mut rows = vec![line(
            plural(p.comments.len(), "inline comment", "inline comments"),
            if edits > 0 {
                format!("{news} new · {edits} edited in place")
            } else {
                format!("{news} new")
            },
        )];
        if p.summary.is_some() {
            rows.push(line(
                "1 summary comment".into(),
                if self.data.summary_comment.is_some() {
                    "edited, never duplicated".into()
                } else {
                    "new, one per lineage".into()
                },
            ));
        }
        if self.data.resolved > 0 {
            rows.push(line(
                plural(
                    self.data.resolved as usize,
                    "thread resolved",
                    "threads resolved",
                ),
                "each with its reason".into(),
            ));
        }
        if let Some(k) = &p.check {
            rows.push(line(
                "1 check run".into(),
                format!(
                    "{} · {}",
                    k.conclusion.clone().unwrap_or_else(|| "neutral".into()),
                    k.name.clone().unwrap_or_else(|| "rio/review".into())
                ),
            ));
        }
        for (i, r) in rows.iter().take(4).enumerate() {
            pane.put(c, y + 2 + cells(i), r);
        }
        pane.put(
            c,
            y + 7,
            &[run(
                "  Comment bodies are data; a reply can't change policy.",
                Token::Faint,
                Token::Raise,
            )],
        );
        pane.put(
            c,
            y + 9,
            &[
                run("  ", Token::Fg, Token::Raise),
                bold(" y  publish ", Token::Bg, Token::Signal),
                run("    ", Token::Fg, Token::Raise),
                bold(" n  keep local ", Token::Fg, Token::Panel),
                run("    ", Token::Fg, Token::Raise),
                bold(" e  edit selection ", Token::Fg, Token::Panel),
            ],
        );
    }
}

/// A compact Markdown line: headings and `**bold**` lose their markers,
/// quotes are dimmed and HTML comments (the publisher's markers) are faint.
fn markdown(source: &str) -> (String, fn(String) -> Run) {
    let trimmed = source.trim_end();
    if trimmed.trim_start().starts_with("<!--") {
        return (trimmed.to_owned(), |t| run(t, Token::Faint, Token::Bg));
    }
    if let Some(rest) = trimmed.strip_prefix("> ") {
        return (rest.to_owned(), |t| run(t, Token::Dim, Token::Bg));
    }
    let heading = trimmed.trim_start_matches('#');
    if heading.len() != trimmed.len() {
        return (heading.trim().replace("**", ""), |t| {
            bold(t, Token::Fg, Token::Bg)
        });
    }
    (trimmed.replace("**", ""), |t| run(t, Token::Fg, Token::Bg))
}

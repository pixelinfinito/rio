//! The host of `rio review` in the interactive UI: it fills the screens' data
//! from the repository and the report, and runs the effects they ask for.

use std::{
    collections::BTreeMap,
    io::Write,
    rc::Rc,
    sync::{Arc, Mutex, mpsc::Sender},
};

use base64::Engine;
use clap::Parser;
use rio_adapters::ProcessSupervisor;
use rio_core::{
    Category, ExitContext, Report, ReportStatus, ReviewEvent, Source, State, display_id, exit_code,
    redact,
};
use rio_git::{ChangeSet, GixRepo, Repo, Selection, select};
use rio_tui::{
    Effect, Msg, Outcome,
    review::{
        AgentCount, ChangeSet as ShownChanges, ChangedFile, DoctorRoot, DoctorTool, ExitData,
        ExitFinding, FindingsData, Hunk, HunkLine, HunkLineKind, MachineCheck, MachineState,
        NextStep, PresetInfo, SavedReport, SelectionKind, StartData,
    },
};
use tokio_util::sync::CancellationToken;

use crate::{Cli, Command, Executed, Format, Hooks, ReviewArgs, config::MachineConfig};

/// What the host and the screens' builders share across threads.
#[derive(Clone)]
pub struct Shared(Arc<Mutex<State_>>);

struct State_ {
    /// Flags of the command that opened the UI (`--ascii`, `--no-color`, …).
    no_color: bool,
    ascii: bool,
    started: String,
    /// The last review run from the UI.
    executed: Option<Executed>,
    /// The arguments it ran with.
    args: Option<Vec<String>>,
    /// Documents saved from the export screen, with their sizes.
    saved: Vec<(String, u64)>,
    /// Include pre-existing findings in the next export.
    include_pre_existing: bool,
    endpoint: bool,
    actor: Option<String>,
    /// Set for `rio qa`: what its runs carry from the command line.
    qa: Option<QaContext>,
    /// The review runs `--offline` (no endpoint calls from the team screens).
    offline: bool,
    /// The pull request of a `rio review --pr` review.
    pr: Option<u64>,
}

/// The flags of the `rio qa` command that opened the UI which its runs keep
/// (selection, profile, harness), and its change selection.
#[derive(Clone, Default)]
pub struct QaContext {
    pub carried: Vec<String>,
    pub staged: bool,
    pub base: Option<String>,
}

impl Shared {
    pub fn new(args: &ReviewArgs, started: String) -> Self {
        let cwd = std::env::current_dir().unwrap_or_default();
        let root = GixRepo::discover(&cwd).ok().map(|r| r.root().to_owned());
        let config = MachineConfig::load(root.as_deref().unwrap_or(&cwd)).ok();
        Self(Arc::new(Mutex::new(State_ {
            no_color: args.no_color,
            ascii: args.ascii,
            started,
            executed: None,
            args: None,
            saved: Vec::new(),
            include_pre_existing: args.show_pre_existing,
            endpoint: !args.offline && config.as_ref().is_some_and(|c| c.endpoint_url.is_some()),
            actor: crate::git_user_email(root.as_deref().unwrap_or(&cwd)),
            qa: None,
            offline: args.offline,
            pr: None,
        })))
    }

    /// The shared state of `rio qa`: runs keep its selection, profile and harness.
    pub fn for_qa(args: &ReviewArgs, started: String) -> Self {
        let shared = Self::new(args, started);
        shared.lock().qa = Some(QaContext {
            carried: crate::qa::carried_flags(args),
            staged: args.selection.staged,
            base: args.selection.base.clone(),
        });
        shared
    }

    /// The shared state of a finished `rio review --pr` review.
    pub fn for_pull_request(
        args: &ReviewArgs,
        started: String,
        report: Report,
        policy: rio_core::CompiledFailOn,
        id: String,
        number: u64,
    ) -> Self {
        let shared = Self::new(args, started);
        {
            let mut state = shared.lock();
            state.pr = Some(number);
            state.args = Some(vec!["review".into(), "--pr".into(), number.to_string()]);
            state.executed = Some(Executed {
                report,
                policy,
                posted: None,
                // The endpoint reviewed the pull request head; nothing is local.
                changes: ChangeSet {
                    selection: Selection::WorkingTree,
                    base_id: String::new(),
                    head_id: String::new(),
                    base: rio_git::Tree::new(),
                    head: rio_git::Tree::new(),
                },
                remote_id: Some(id),
            });
        }
        shared
    }

    /// The findings hub's data for the review this state holds.
    pub fn findings(&self) -> Option<FindingsData> {
        let report = self.lock().executed.as_ref()?.report.clone();
        Some(findings_builder(self.clone())(&report))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State_> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// After the UI closed: print the summary and return the exit code.
    pub fn finish(&self) -> u8 {
        let state = self.lock();
        let Some(executed) = &state.executed else {
            return 0;
        };
        let code = exit_code(&executed.report, &executed.policy, ExitContext::default());
        let data = exit_data(
            executed,
            state.args.as_deref().unwrap_or(&[]),
            &state.saved,
            code,
        );
        let mut text = rio_tui::review::exit_text(&data);
        if state.qa.is_some()
            && let Some(line) = super::qa::cells_line(&executed.report)
        {
            text.push_str(&line);
        }
        let text = rio_core::glyphs::GlyphSet::select(state.ascii)
            .apply(&text)
            .into_owned();
        let _ = crate::write_stdout(text.as_bytes());
        code
    }
}

/// The start screen's data: the repository, the three change selections, the
/// profile and presets, and the doctor preflight. `Err` when the repository or
/// the configuration cannot be read (the streaming path reports why).
pub async fn start_data(args: &ReviewArgs) -> Result<StartData, ()> {
    let cwd = std::env::current_dir().map_err(|_| ())?;
    let repo = GixRepo::discover(&cwd).map_err(|_| ())?;
    let config = MachineConfig::load(repo.root()).map_err(|_| ())?;
    let profile = crate::loader(Some(repo.root().into()), &config, cwd.clone())
        .load(args.profile.as_deref())
        .map_err(|_| ())?;
    let branch = repo
        .branch()
        .ok()
        .flatten()
        .unwrap_or_else(|| "HEAD".into());
    let base = args
        .selection
        .base
        .clone()
        .unwrap_or_else(|| "origin/main".into());
    let mut changes = Vec::new();
    for (kind, selection, description) in [
        (
            SelectionKind::Branch,
            Selection::Branch {
                reference: base.clone(),
            },
            format!("vs merge base of {base}"),
        ),
        (
            SelectionKind::WorkingTree,
            Selection::WorkingTree,
            "tree + staged + untracked vs HEAD".to_owned(),
        ),
        (
            SelectionKind::Staged,
            Selection::Staged,
            "index vs HEAD".to_owned(),
        ),
    ] {
        changes.push(match select(&repo, selection) {
            Ok(set) => shown(kind, description, &set),
            Err(error) => ShownChanges {
                kind,
                description: format!("unavailable: {}", redact(&format!("{error:#}"))),
                files: 0,
                added: 0,
                removed: 0,
                listed: Vec::new(),
            },
        });
    }
    let selection = if args.selection.staged {
        SelectionKind::Staged
    } else if args.selection.base.is_some() {
        SelectionKind::Branch
    } else {
        SelectionKind::WorkingTree
    };
    // `--profile` takes a reference: a built-in name, or the profile's file.
    let listed = crate::loader(Some(repo.root().into()), &config, cwd)
        .list()
        .unwrap_or_default();
    let reference = |p: &rio_profile::ProfileSummary| match &p.source {
        rio_profile::ProfileSource::BuiltIn(_) => p.name.clone(),
        source => source.label(),
    };
    let profiles: Vec<String> = listed.iter().map(reference).collect();
    let chosen = match &args.profile {
        Some(given) => given.clone(),
        None => listed
            .iter()
            .find(|p| p.is_default)
            .map(reference)
            .unwrap_or_default(),
    };
    let agents: Vec<String> = profile
        .profile
        .steps
        .iter()
        .filter(|step| step.uses.starts_with("rio/agents@"))
        .flat_map(|step| {
            step.options["agents"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|a| a.as_object().and_then(|o| o.keys().next().cloned()))
                .collect::<Vec<_>>()
        })
        .collect();
    let quorum = profile.profile.verify.voters;
    let online = config.endpoint_url.is_some() && !args.offline;
    let presets = [
        ("quick", "triage + 1 agent"),
        ("standard", "triage + agents + quorum"),
        ("deep", "every agent + council"),
    ]
    .into_iter()
    .map(|(name, description)| PresetInfo {
        name: name.into(),
        description: description.into(),
        agents: agents.clone(),
        quorum,
    })
    .filter(|_| online)
    .collect();
    let preset = if args.deep {
        "deep"
    } else {
        match args.preset {
            Some(crate::Preset::Quick) => "quick",
            Some(crate::Preset::Deep) => "deep",
            _ => "standard",
        }
    };
    let (roots, warnings) = preflight(&repo, &config, &profile, args).await;
    let mut machine = vec![MachineCheck {
        state: MachineState::Ok,
        text: format!(
            "cache {} · {} free",
            config.cache.dir.display(),
            fs4::available_space(&config.cache.dir)
                .map(|b| format!("{} GB", b / 1_000_000_000))
                .unwrap_or_else(|_| "unknown".into())
        ),
    }];
    machine.push(match &config.endpoint_url {
        Some(url) if !args.offline => MachineCheck {
            state: MachineState::Ok,
            text: format!("endpoint · {}", redact(url)),
        },
        _ => MachineCheck {
            state: MachineState::Info,
            text: "no endpoint · local checks only".into(),
        },
    });
    machine.push(MachineCheck {
        state: MachineState::Info,
        text: format!("parallelism {}", config.parallelism),
    });
    let home = std::env::var("HOME").unwrap_or_default();
    let shown_root = repo.root().display().to_string();
    let repository = match shown_root.strip_prefix(&home) {
        Some(rest) if !home.is_empty() => format!("~{rest}"),
        _ => shown_root,
    };
    Ok(StartData {
        repository,
        branch,
        version: env!("CARGO_PKG_VERSION").into(),
        base,
        changes,
        selection,
        profiles,
        profile: chosen,
        profile_source: profile.chain.first().cloned().unwrap_or_default(),
        presets,
        preset: preset.into(),
        since_last: args.since_last,
        since_last_note: "continue the branch lineage on the endpoint".into(),
        since_last_capped: false,
        offline: args.offline,
        show_pre_existing: args.show_pre_existing,
        roots,
        machine,
        warnings,
        live_note: String::new(),
    })
}

/// Files and line counts of a selection, the first six listed.
pub(crate) fn shown(kind: SelectionKind, description: String, set: &ChangeSet) -> ShownChanges {
    let mut listed = Vec::new();
    let (mut added, mut removed) = (0, 0);
    let paths: std::collections::BTreeSet<&String> =
        set.base.keys().chain(set.head.keys()).collect();
    for path in paths {
        let before = set.base.get(path);
        let after = set.head.get(path);
        if before.zip(after).is_some_and(|(b, a)| b.same_content(a)) {
            continue;
        }
        let text = |entry: Option<&rio_git::TreeEntry>| {
            entry
                .map(|e| String::from_utf8_lossy(&e.content).into_owned())
                .unwrap_or_default()
        };
        let (old, new) = (text(before), text(after));
        let diff = similar::TextDiff::from_lines(&old, &new);
        let (mut plus, mut minus) = (0, 0);
        for change in diff.iter_all_changes() {
            match change.tag() {
                similar::ChangeTag::Insert => plus += 1,
                similar::ChangeTag::Delete => minus += 1,
                similar::ChangeTag::Equal => {}
            }
        }
        added += plus;
        removed += minus;
        listed.push(ChangedFile {
            status: match (before, after) {
                (None, Some(_)) => 'A',
                (Some(_), None) => 'D',
                _ => 'M',
            },
            path: path.clone(),
            added: plus,
            removed: minus,
        });
    }
    ShownChanges {
        kind,
        description,
        files: listed.len(),
        added,
        removed,
        listed,
    }
}

/// The doctor's view of the selected change: roots, their tools, and what would skip.
async fn preflight(
    repo: &GixRepo,
    config: &MachineConfig,
    profile: &rio_profile::ResolvedProfile,
    args: &ReviewArgs,
) -> (Vec<DoctorRoot>, Vec<String>) {
    let mut warnings = Vec::new();
    let plan = async {
        let changes = select(repo, args.selection.selection())?;
        let delta = rio_git::diff(&changes, &rio_engine::profile_excludes(profile))?;
        let working = repo.working_tree()?;
        let resolver = rio_adapters::ToolResolver::from_environment(repo.root().into());
        rio_engine::plan_review_with_progress(
            rio_engine::PlanRequest {
                worktree: repo.root(),
                working: &working,
                changes: &changes,
                diff: &delta,
                profile,
                resolver: &resolver,
            },
            &ProcessSupervisor::default(),
            CancellationToken::new(),
            &|_| {},
        )
        .await
    }
    .await;
    let _ = config;
    let mut roots: BTreeMap<String, DoctorRoot> = BTreeMap::new();
    match plan {
        Ok(plan) => {
            for check in &plan.checks {
                let root = roots
                    .entry(check.root.clone())
                    .or_insert_with(|| DoctorRoot {
                        root: check.root.clone(),
                        language: check.language.clone(),
                        lockfile: None,
                        tools: Vec::new(),
                        lockfile_matches: None,
                    });
                root.tools.push(DoctorTool {
                    name: check
                        .tool
                        .as_ref()
                        .map(|t| t.name.clone())
                        .unwrap_or_else(|| rio_core::label(&check.kind)),
                    // A check without an external tool that does not skip runs built in.
                    version: check
                        .tool
                        .as_ref()
                        .map(|t| t.version.clone())
                        .or_else(|| check.skip.is_none().then(|| "built-in".into())),
                    role: rio_core::label(&check.kind),
                });
                if let Some(skip) = &check.skip {
                    warnings.push(format!(
                        "{} {} would skip: {}",
                        rio_core::label(&check.kind),
                        check.root,
                        rio_core::outcome_label(skip)
                    ));
                }
            }
        }
        Err(error) => warnings.push(redact(&format!("{error:#}"))),
    }
    (roots.into_values().collect(), warnings)
}

/// Builds the findings hub from the final report and what the host knows.
pub fn findings_builder(shared: Shared) -> rio_tui::review::SharedFindingsBuilder {
    Rc::new(move |report: &Report| {
        let state = shared.lock();
        let context = context_of(state.args.as_deref().unwrap_or(&[]));
        let mut data = FindingsData::new(report.clone(), &context);
        data.endpoint = state.endpoint;
        data.actor = state.actor.clone().unwrap_or_default();
        if let Some(executed) = &state.executed {
            data.exit_code = Some(exit_code(report, &executed.policy, ExitContext::default()));
            data.failing = report
                .findings
                .iter()
                .chain(&report.risks)
                .filter(|f| executed.policy.matches(f))
                .map(|f| f.id.clone())
                .collect();
            for finding in report.findings.iter().chain(&report.risks) {
                if let Some(hunk) = hunk(&executed.changes, finding) {
                    data.hunks.insert(finding.id.clone(), hunk);
                }
            }
        }
        let mut agents: BTreeMap<String, usize> = BTreeMap::new();
        for finding in report.findings.iter().chain(&report.risks) {
            if let Source::Agent { agent, .. } = &finding.source {
                *agents.entry(agent.clone()).or_default() += 1;
            }
        }
        data.agents = agents
            .into_iter()
            .map(|(name, findings)| AgentCount { name, findings })
            .collect();
        data.refuted = report
            .agent_audit
            .as_ref()
            .and_then(|audit| audit["refuted"].as_array().map(Vec::len))
            .unwrap_or(0);
        // The team screens: P1 on a security finding, F, S and P.
        let changed: BTreeMap<String, Vec<u32>> = data
            .hunks
            .iter()
            .map(|(id, hunk)| {
                let added = hunk
                    .lines
                    .iter()
                    .filter(|l| l.kind == HunkLineKind::Added)
                    .map(|l| l.number)
                    .collect();
                (id.clone(), added)
            })
            .collect();
        data.open = Some(super::team::opener(
            report,
            &context,
            state.endpoint,
            &data.failing,
            &changed,
            state.executed.as_ref().and_then(|e| e.posted.as_ref()),
            state.pr,
        ));
        data
    })
}

/// The header context of a review, e.g. `feature/x → origin/main · rio/base · standard`.
fn context_of(args: &[String]) -> String {
    let flag = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let branch = GixRepo::discover(std::env::current_dir().unwrap_or_default())
        .ok()
        .and_then(|r| r.branch().ok().flatten())
        .unwrap_or_else(|| "HEAD".into());
    let selection = match flag("--base") {
        Some(base) => format!(" → {base}"),
        None if args.iter().any(|a| a == "--staged") => " · staged".into(),
        None => " · working tree".into(),
    };
    // A profile given as a file is shown by its name.
    let profile = flag("--profile")
        .map(|p| {
            std::path::Path::new(&p)
                .file_stem()
                .filter(|_| p.ends_with(".yaml") || p.ends_with(".yml"))
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or(p)
        })
        .unwrap_or_else(|| "default profile".into());
    let mut context = format!("{branch}{selection} · {profile}");
    if let Some(preset) = flag("--preset") {
        context.push_str(&format!(" · {preset}"));
    }
    if args.iter().any(|a| a == "--offline") {
        context.push_str(" · offline");
    }
    context
}

/// The diff hunk around a finding's primary line, from the reviewed change.
fn hunk(changes: &ChangeSet, finding: &rio_core::Finding) -> Option<Hunk> {
    let path = &finding.location.path;
    let text = |tree: &rio_git::Tree| {
        tree.get(path)
            .map(|e| String::from_utf8_lossy(&e.content).into_owned())
            .unwrap_or_default()
    };
    let (old, new) = (text(&changes.base), text(&changes.head));
    if new.is_empty() {
        return None;
    }
    let line = finding.location.line_start as usize;
    let diff = similar::TextDiff::from_lines(&old, &new);
    let group = diff.grouped_ops(3).into_iter().find(|ops| {
        let first = ops.first().map(|op| op.new_range().start).unwrap_or(0);
        let last = ops.last().map(|op| op.new_range().end).unwrap_or(0);
        (first + 1..=last).contains(&line)
    })?;
    let mut lines = Vec::new();
    for op in &group {
        for change in diff.iter_changes(op) {
            let (number, kind) = match change.tag() {
                similar::ChangeTag::Equal => (change.new_index(), HunkLineKind::Context),
                similar::ChangeTag::Insert => (change.new_index(), HunkLineKind::Added),
                similar::ChangeTag::Delete => (change.old_index(), HunkLineKind::Removed),
            };
            lines.push(HunkLine {
                number: number.map_or(0, |n| n as u32 + 1),
                kind,
                // Secrets in the code are redacted as in every other output.
                text: redact(change.value().trim_end_matches(['\n', '\r'])),
            });
        }
    }
    let old_range = (group[0].old_range().start, group.last()?.old_range().end);
    let new_range = (group[0].new_range().start, group.last()?.new_range().end);
    Some(Hunk {
        path: path.clone(),
        header: format!(
            "@@ -{},{} +{},{} @@",
            old_range.0 + 1,
            old_range.1 - old_range.0,
            new_range.0 + 1,
            new_range.1 - new_range.0
        ),
        lines,
        cited: (finding.location.line_start..=finding.location.line_end).collect(),
        note: None,
    })
}

/// The first sentence of a message.
fn headline(message: &str) -> String {
    let first = message.lines().next().unwrap_or("");
    match first.find(". ") {
        Some(end) if end > 20 => first[..=end].trim_end().to_owned(),
        _ => first.to_owned(),
    }
}

pub(crate) fn exit_data(
    executed: &Executed,
    args: &[String],
    saved: &[(String, u64)],
    code: u8,
) -> ExitData {
    let report = &executed.report;
    let all: Vec<&rio_core::Finding> = report.findings.iter().chain(&report.risks).collect();
    let count = |pred: &dyn Fn(&rio_core::Finding) -> bool| all.iter().filter(|f| pred(f)).count();
    let failing: Vec<ExitFinding> = all
        .iter()
        .filter(|f| executed.policy.matches(f))
        .map(|f| ExitFinding {
            id: display_id(&f.id).into(),
            title: headline(&f.message),
            location: format!("{}:{}", f.location.path, f.location.line_start),
            evidence: f.evidence_level,
        })
        .collect();
    let flag = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    ExitData {
        version: env!("CARGO_PKG_VERSION").into(),
        status: rio_core::label(&report.status),
        branch: GixRepo::discover(std::env::current_dir().unwrap_or_default())
            .ok()
            .and_then(|r| r.branch().ok().flatten())
            .unwrap_or_else(|| "HEAD".into()),
        base: flag("--base"),
        preset: flag("--preset").unwrap_or_else(|| "standard".into()),
        policy: if failing.is_empty() {
            "no finding matched fail_on".into()
        } else {
            format!("policy failed: {} findings match fail_on", failing.len())
        },
        failed: code == 1,
        failing,
        counts: format!(
            "{} findings · {} new · {} worsened · {} security · {} pre-existing",
            all.len(),
            count(&|f| f.state == State::New),
            count(&|f| f.state == State::Worsened),
            count(&|f| f.category == Category::Security),
            report.summary.pre_existing
        ),
        lineage: report
            .lineage
            .as_ref()
            .map(|l| format!("round {} of cap {}", l.round, l.cap)),
        lineage_warn: report.lineage.as_ref().is_some_and(|l| l.round > l.cap),
        saved: saved.last().map(|(path, size)| SavedReport {
            path: path.clone(),
            size: if *size >= 1024 {
                format!("{:.1} KB", *size as f64 / 1024.0)
            } else {
                format!("{size} B")
            },
            copied: false,
        }),
        kept: None,
        next: Some(NextStep {
            before: "fix, then".into(),
            command: "rio review --since-last".into(),
            after: String::new(),
        }),
    }
}

/// Runs the review flow's effects.
pub struct ReviewHost {
    shared: Shared,
    runtime: tokio::runtime::Handle,
    reply: Sender<Msg>,
    running: Option<(CancellationToken, ProcessSupervisor)>,
    thread: Option<std::thread::JoinHandle<()>>,
    redraw: bool,
    /// The second Ctrl-C ended the session (exit 130).
    pub killed: bool,
}

impl ReviewHost {
    pub fn new(shared: Shared, runtime: tokio::runtime::Handle, reply: Sender<Msg>) -> Self {
        Self {
            shared,
            runtime,
            reply,
            running: None,
            thread: None,
            redraw: false,
            killed: false,
        }
    }

    fn start(&mut self, mut args: Vec<String>) {
        let qa = self.shared.lock().qa.clone();
        if let Some(qa) = &qa
            && args.first().is_some_and(|a| a == "qa")
        {
            // `rio qa` runs keep the selection, profile and harness they were opened with.
            for pair in qa.carried.chunk_by(|_, b| !b.starts_with("--")) {
                if !args.contains(&pair[0]) {
                    args.extend(pair.iter().cloned());
                }
            }
        }
        let parsed = Cli::try_parse_from(std::iter::once("rio".to_owned()).chain(args.clone()));
        let mut review = match parsed {
            Ok(Cli {
                command: Command::Review(review),
            }) if qa.is_none() => review,
            Ok(Cli {
                command:
                    Command::Qa {
                        command: None,
                        args: run,
                    },
            }) if qa.is_some() => run.review_args(),
            Ok(_) if qa.is_some() => return self.failed("only QA runs start from here"),
            Ok(_) => return self.failed("only reviews start from here"),
            Err(error) => return self.failed(&error.to_string()),
        };
        {
            let mut state = self.shared.lock();
            review.no_color |= state.no_color;
            review.ascii |= state.ascii;
            state.args = Some(args);
            state.include_pre_existing = review.show_pre_existing;
        }
        review.no_tui = true;
        let cancellation = CancellationToken::new();
        let supervisor = ProcessSupervisor::default();
        supervisor.tap_output(log_tap(self.reply.clone()));
        self.running = Some((cancellation.clone(), supervisor.clone()));
        let reply = self.reply.clone();
        let shared = self.shared.clone();
        let runtime = self.runtime.clone();
        // The review holds repository handles that stay on one thread, so it
        // runs on a thread of its own, on the process's runtime.
        self.thread = Some(std::thread::spawn(move || {
            runtime.clone().block_on(async move {
                let (events, mut received) = tokio::sync::mpsc::unbounded_channel();
                let ui = reply.clone();
                let forward = tokio::spawn(async move {
                    while let Some(event) = received.recv().await {
                        // The host sends the final report itself, once it is stored.
                        if !matches!(
                            event,
                            ReviewEvent::Done { .. } | ReviewEvent::Partial { .. }
                        ) {
                            let _ = ui.send(Msg::Review(event));
                        }
                    }
                });
                let outcome = crate::execute_review(
                    &review,
                    Hooks {
                        events: Some(events),
                        remote_events: true,
                        cancellation,
                        supervisor,
                    },
                )
                .await;
                let _ = forward.await;
                match outcome {
                    Ok(executed) => {
                        let report = Box::new(executed.report.clone());
                        let partial = executed.report.status == ReportStatus::Partial;
                        shared.lock().executed = Some(executed);
                        let _ = reply.send(Msg::Review(if partial {
                            ReviewEvent::Partial { report }
                        } else {
                            ReviewEvent::Done { report }
                        }));
                    }
                    Err(error) => {
                        let _ = reply.send(Msg::Done(Outcome::Failed(redact(&format!(
                            "{}: {}",
                            error.name, error.message
                        )))));
                    }
                }
            })
        }));
    }

    /// Cancel a running review and wait until it has stopped.
    pub fn stop(&mut self) {
        if let Some((cancellation, _)) = &self.running {
            cancellation.cancel();
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }

    fn failed(&self, message: &str) {
        let _ = self.reply.send(Msg::Done(Outcome::Failed(message.into())));
    }

    fn ok(&self, message: impl Into<String>) {
        let _ = self.reply.send(Msg::Done(Outcome::Ok(message.into())));
    }

    fn export(&mut self, format: &str, path: &str) {
        if std::path::Path::new(path)
            .file_name()
            .is_some_and(|name| name == super::qa::UX_EXPORT)
        {
            return self.export_ux(path);
        }
        let format = match format {
            "md" => Format::Md,
            "json" => Format::Json,
            "sarif" => Format::Sarif,
            other => return self.failed(&format!("unknown format {other}")),
        };
        let mut state = self.shared.lock();
        let Some(executed) = &state.executed else {
            drop(state);
            return self.failed("no report to export yet");
        };
        let options = rio_core::RenderOptions {
            width: 80,
            color: false,
            show_pre_existing: state.include_pre_existing,
            show_remembered: false,
            policy: Some(&executed.policy),
            posted: executed.posted.as_ref(),
            glyphs: rio_core::glyphs::GlyphSet::Unicode,
        };
        let exit = exit_code(&executed.report, &executed.policy, ExitContext::default());
        let bytes = crate::document(
            &executed.report,
            format,
            &options,
            state.started.clone(),
            exit,
        );
        let written = bytes.map_err(|e| e.to_string()).and_then(|bytes| {
            std::fs::write(path, &bytes)
                .map(|()| bytes.len() as u64)
                .map_err(|e| format!("{path}: {e}"))
        });
        match written {
            Ok(size) => {
                state.saved.push((path.into(), size));
                drop(state);
                self.ok(format!("saved {path}"));
            }
            Err(error) => {
                drop(state);
                self.failed(&error);
            }
        }
    }

    /// Q4's export: only the UX recommendations, never the report.
    fn export_ux(&mut self, path: &str) {
        let markdown = self
            .shared
            .lock()
            .executed
            .as_ref()
            .and_then(|e| super::qa::ux_markdown(&e.report));
        let Some(markdown) = markdown else {
            return self.failed("no UX recommendations to export");
        };
        match std::fs::write(path, markdown.as_bytes()) {
            Ok(()) => self.ok(format!("saved {path} (recommendations only)")),
            Err(error) => self.failed(&format!("{path}: {error}")),
        }
    }

    fn feedback(&self, id: String, reason: String, note: Option<String>) {
        let reply = self.reply.clone();
        let actor = self.shared.lock().actor.clone();
        self.runtime.spawn(async move {
            let result = async {
                let cwd = std::env::current_dir()?;
                let root = GixRepo::discover(&cwd).ok().map(|r| r.root().to_owned());
                let config = MachineConfig::load(root.as_deref().unwrap_or(&cwd))?;
                let url = config
                    .endpoint_url
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("dismissals need a configured endpoint"))?;
                let client = crate::endpoint::client(url, &config.config_dir)?;
                let mut body = serde_json::json!({ "reason": reason });
                if let Some(note) = note {
                    body["note"] = note.into();
                }
                if let Some(actor) = actor {
                    body["actor"] = actor.into();
                }
                client.feedback(&id, &body).await
            }
            .await;
            let _ = reply.send(Msg::Done(match result {
                Ok(_) => Outcome::Ok(format!("{} dismissed ({reason})", display_id(&id))),
                Err(error) => Outcome::Failed(redact(&format!("{error:#}"))),
            }));
        });
    }

    fn edit(&mut self, path: &str, line: u32) {
        let editor = std::env::var("VISUAL")
            .or_else(|_| std::env::var("EDITOR"))
            .unwrap_or_else(|_| "vi".into());
        rio_tui::terminal::suspend();
        let status = std::process::Command::new(&editor)
            .arg(format!("+{line}"))
            .arg(path)
            .status();
        let _ = rio_tui::terminal::resume();
        self.redraw = true;
        match status {
            Ok(_) => self.ok(format!("edited {path}")),
            Err(error) => self.failed(&format!("{editor}: {error}")),
        }
    }
}

/// Tool output as `log` events, one per line, redacted.
fn log_tap(reply: Sender<Msg>) -> rio_adapters::OutputTap {
    let partial: Arc<Mutex<BTreeMap<String, String>>> = Arc::default();
    Arc::new(move |program: &str, chunk: &[u8]| {
        let mut pending = partial.lock().unwrap_or_else(|p| p.into_inner());
        let buffer = pending.entry(program.to_owned()).or_default();
        buffer.push_str(&String::from_utf8_lossy(chunk));
        while let Some(end) = buffer.find('\n') {
            let line: String = buffer.drain(..=end).collect();
            let _ = reply.send(Msg::Review(ReviewEvent::Log {
                source: program.to_owned(),
                line: redact(line.trim_end()),
            }));
        }
    })
}

/// The run cache root, canonical as the QA runtime records evidence links.
pub fn cache_root() -> Option<std::path::PathBuf> {
    let cwd = std::env::current_dir().ok()?;
    let root = GixRepo::discover(&cwd).ok().map(|r| r.root().to_owned());
    let config = MachineConfig::load(root.as_deref().unwrap_or(&cwd)).ok()?;
    std::fs::canonicalize(&config.cache.dir).ok()
}

/// Copy to the clipboard of the terminal, also over SSH (OSC 52).
pub fn copy(text: &str) {
    let encoded = base64::engine::general_purpose::STANDARD.encode(text);
    let mut out = std::io::stdout();
    let _ = write!(out, "\x1b]52;c;{encoded}\x07");
    let _ = out.flush();
}

impl rio_tui::terminal::Host for ReviewHost {
    fn run(&mut self, effect: Effect, _reply: &Sender<Msg>) {
        match effect {
            Effect::Start(args) => self.start(args),
            Effect::Cancel => {
                if let Some((cancellation, _)) = &self.running {
                    cancellation.cancel();
                }
            }
            Effect::Kill => {
                if let Some((_, supervisor)) = &self.running {
                    supervisor.kill_all();
                }
                self.killed = true;
            }
            Effect::Quit => {}
            Effect::Export { format, path } => self.export(&format, &path),
            Effect::Feedback { id, reason, note } => self.feedback(id, reason, note),
            Effect::Copy(text) => {
                copy(&text);
                self.ok("copied to the clipboard");
            }
            Effect::Edit { path, line } => self.edit(&path, line),
            Effect::Open(target) => {
                let opener = if cfg!(target_os = "macos") {
                    "open"
                } else {
                    "xdg-open"
                };
                match std::process::Command::new(opener)
                    .arg(&target)
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                {
                    Ok(_) => self.ok(format!("opened {target}")),
                    Err(error) => self.failed(&format!("{opener}: {error}")),
                }
            }
            Effect::Step(name) => match name.as_str() {
                "review:export-include-pre-existing" => {
                    self.shared.lock().include_pre_existing = true;
                }
                "review:export-copy" => {
                    let saved = self.shared.lock().saved.last().map(|(p, _)| p.clone());
                    if let Some(text) = saved.and_then(|p| std::fs::read_to_string(p).ok()) {
                        copy(&text);
                        self.ok("copied the saved report");
                    }
                }
                "review:doctor" => self.ok("run `rio doctor` for the full preflight"),
                other if other.starts_with("qa:") => {
                    let qa = self.shared.lock().qa.clone().unwrap_or_default();
                    if !super::qa::step(other, qa.staged, qa.base, &self.runtime, &self.reply) {
                        self.failed(&format!("{other} is not available in this view"));
                    }
                }
                other => self.failed(&format!("{other} is not available in this view")),
            },
            Effect::Fetch(name) if name.starts_with("qa-image:") => {
                let url = name.trim_start_matches("qa-image:").to_owned();
                let reply = self.reply.clone();
                let dir = cache_root();
                self.runtime.spawn(async move {
                    let result = match dir {
                        Some(dir) => super::images::fetch_image(&url, &dir).await,
                        None => Err("no run cache to keep the screenshot in".into()),
                    };
                    let value = match result {
                        Ok(path) => serde_json::json!({"url": url, "path": path}),
                        Err(error) => serde_json::json!({"url": url, "error": error}),
                    };
                    let _ = reply.send(Msg::Done(Outcome::Value("qa-image".into(), value)));
                });
            }
            effect @ (Effect::PreviewPublish
            | Effect::Publish
            | Effect::Fetch(_)
            | Effect::ApplyProposal(_)
            | Effect::DeclineProposal { .. }) => {
                let context = {
                    let state = self.shared.lock();
                    super::team::TeamContext {
                        offline: state.offline,
                        review_id: state.executed.as_ref().and_then(|e| e.remote_id.clone()),
                        pr: state.pr,
                    }
                };
                let shared = self.shared.clone();
                super::team::run(
                    effect,
                    &context,
                    &self.runtime,
                    &self.reply,
                    Box::new(move |report| {
                        if let Some(executed) = shared.lock().executed.as_mut() {
                            executed.report = report;
                        }
                    }),
                );
            }
        }
    }

    fn take_redraw(&mut self) -> bool {
        std::mem::take(&mut self.redraw)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn executed() -> Executed {
        let report: Report = serde_json::from_str(include_str!(
            "../../../rio-core/tests/fixtures/complete.json"
        ))
        .unwrap();
        Executed {
            report,
            policy: rio_core::FailOn::default().compile().unwrap(),
            posted: None,
            changes: ChangeSet {
                selection: Selection::WorkingTree,
                base_id: String::new(),
                head_id: String::new(),
                base: rio_git::Tree::new(),
                head: rio_git::Tree::new(),
            },
            remote_id: None,
        }
    }

    #[test]
    fn exports_are_the_documents_format_writes() {
        let dir = tempfile::tempdir().unwrap();
        let Ok(Cli {
            command: Command::Review(args),
        }) = Cli::try_parse_from(["rio", "review"])
        else {
            panic!("rio review parses");
        };
        let shared = Shared::new(&args, "2026-11-10T00:00:00Z".into());
        shared.lock().executed = Some(executed());
        let (reply, messages) = std::sync::mpsc::channel();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let mut host = ReviewHost::new(shared.clone(), runtime.handle().clone(), reply);
        for (format, kind) in [
            ("json", Format::Json),
            ("md", Format::Md),
            ("sarif", Format::Sarif),
        ] {
            let path = dir.path().join(format!("report.{format}"));
            host.export(format, path.to_str().unwrap());
            assert!(matches!(
                messages.recv().unwrap(),
                Msg::Done(Outcome::Ok(_))
            ));
            let state = shared.lock();
            let executed = state.executed.as_ref().unwrap();
            let options = rio_core::RenderOptions {
                width: 80,
                color: false,
                show_pre_existing: false,
                show_remembered: false,
                policy: Some(&executed.policy),
                posted: None,
                glyphs: rio_core::glyphs::GlyphSet::Unicode,
            };
            let exit = exit_code(&executed.report, &executed.policy, ExitContext::default());
            let expected = crate::document(
                &executed.report,
                kind,
                &options,
                state.started.clone(),
                exit,
            )
            .unwrap();
            assert_eq!(std::fs::read(&path).unwrap(), expected, "{format}");
        }
        assert_eq!(shared.lock().saved.len(), 3);
    }

    #[test]
    fn the_header_context_reads_like_the_design() {
        let args: Vec<String> = [
            "review",
            "--base",
            "origin/main",
            "--profile",
            "/x/default.yaml",
            "--preset",
            "deep",
        ]
        .map(String::from)
        .into();
        assert!(context_of(&args).ends_with(" → origin/main · default · deep"));
    }
}

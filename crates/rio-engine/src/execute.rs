use crate::{
    CacheOptions, PlanRequest, PlannedCheck, ReviewPlan, RunCache, atomic_write, plan_review,
    profile_excludes, prune_cache,
};
use anyhow::{Context, Result, ensure};
use rio_adapters::*;
use rio_core::*;
use rio_git::*;
use rio_graph::{GraphBuilder, GraphOptions};
use rio_profile::{ResolvedProfile, Step, parse_duration, resolve_module};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    sync::{Semaphore, mpsc},
    task::JoinSet,
};
use tokio_util::sync::CancellationToken;

pub struct ReviewRequest {
    pub worktree: PathBuf,
    pub working: Tree,
    pub changes: ChangeSet,
    pub profile: ResolvedProfile,
    pub cache: CacheOptions,
    pub parallelism: usize,
    pub output_limit: usize,
    pub offline: bool,
}
struct Execution {
    request: ReviewRequest,
    diff: Diff,
    cache: Arc<RunCache>,
    supervisor: ProcessSupervisor,
    cancellation: CancellationToken,
    deadline: Instant,
    per_check: Duration,
    links: Vec<DependencyLink>,
    materials: Option<Materializations>,
    material_error: Option<String>,
}
#[derive(Default)]
struct CheckResult {
    entries: Vec<CheckEntry>,
    findings: Vec<Finding>,
    coverage: CoverageData,
    settings: Vec<CoverageSettings>,
    notes: Vec<String>,
    tools_ran: bool,
}

pub fn ordered_steps(profile: &ResolvedProfile) -> Result<Vec<Step>> {
    let mut remaining = profile.profile.steps.clone();
    let mut done = BTreeSet::new();
    let mut ordered = Vec::new();
    while !remaining.is_empty() {
        let index = remaining
            .iter()
            .position(|step| step.needs.iter().all(|need| done.contains(need)))
            .context("step dependency cycle")?;
        let step = remaining.remove(index);
        done.insert(step.id.clone());
        ordered.push(step);
    }
    Ok(ordered)
}
fn emit(sender: &Option<mpsc::UnboundedSender<ReviewEvent>>, event: ReviewEvent) {
    if let Some(sender) = sender {
        let _ = sender.send(event);
    }
}
fn timeout_for(kind: CheckKind, budget: Duration) -> Duration {
    budget.mul_f64(match kind {
        CheckKind::Typecheck | CheckKind::Lint => 0.4,
        CheckKind::Coverage => 0.6,
        _ => 0.1,
    })
}
fn key(kind: CheckKind) -> &'static str {
    match kind {
        CheckKind::Typecheck => "typecheck",
        CheckKind::Lint => "lint",
        CheckKind::Coverage => "coverage",
        CheckKind::Secrets => "secrets",
        CheckKind::Dependencies => "dependencies",
    }
}
fn component(root: &str) -> String {
    if root == "." {
        return "%2E".into();
    }
    root.bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.') {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}
fn check_path(check: &PlannedCheck, version: Version) -> String {
    format!(
        "checks/{}/{}/{}",
        key(check.kind),
        component(&check.root),
        if version == Version::Base {
            "base"
        } else {
            "head"
        }
    )
}
fn cancelled(reason: CancellationReason) -> CheckOutcome {
    CheckOutcome::Cancelled {
        reason,
        details: CheckDetails::default(),
    }
}
fn failure(message: String) -> CheckOutcome {
    CheckOutcome::Failed {
        reason: if message.contains("disk_full") || message.contains("No space left") {
            FailureReason::DiskFull
        } else {
            FailureReason::ToolCrashed
        },
        details: CheckDetails {
            hint: Some(redact(&message)),
            ..Default::default()
        },
    }
}
fn completed(outcome: &CheckOutcome) -> bool {
    matches!(
        outcome,
        CheckOutcome::Passed { .. } | CheckOutcome::Findings { .. }
    )
}
fn entry(
    check: &PlannedCheck,
    version: Version,
    outcome: CheckOutcome,
    wall: Duration,
    cached: bool,
) -> CheckEntry {
    CheckEntry {
        kind: check.kind,
        language: check.language.clone(),
        root: check.root.clone(),
        version,
        scheduled_as: check.scheduled_as,
        outcome,
        wall_time_ms: wall.as_millis() as u64,
        cached,
    }
}

impl Execution {
    fn available(&self, kind: CheckKind) -> Duration {
        timeout_for(kind, self.per_check)
            .min(self.deadline.saturating_duration_since(Instant::now()))
    }
    fn before(&self) -> Option<CheckOutcome> {
        if self.cancellation.is_cancelled() {
            Some(cancelled(CancellationReason::Interrupted))
        } else if Instant::now() >= self.deadline {
            Some(cancelled(CancellationReason::Timeout))
        } else {
            None
        }
    }
    fn persist_process(
        &self,
        check: &PlannedCheck,
        version: Version,
        result: &ProcessResult,
    ) -> Result<()> {
        if self.request.cache.retain_raw_output {
            let path = check_path(check, version);
            self.cache
                .write(&format!("{path}/stdout.txt"), &result.raw_stdout)?;
            self.cache
                .write(&format!("{path}/stderr.txt"), &result.raw_stderr)?;
        }
        Ok(())
    }
    async fn diagnostic(
        &self,
        check: &PlannedCheck,
        version: Version,
    ) -> Result<(CheckEntry, bool)> {
        let started = Instant::now();
        if let Some(outcome) = self.before() {
            return Ok((
                entry(check, version, outcome, started.elapsed(), false),
                false,
            ));
        }
        let materials = self
            .materials
            .as_ref()
            .context("materialization unavailable")?;
        let (cached, tree) = if version == Version::Head {
            (&materials.head, &self.request.changes.head)
        } else {
            (&materials.base, &self.request.changes.base)
        };
        let targets: Vec<_> = check
            .targets
            .iter()
            .map(|path| {
                if version == Version::Base {
                    self.diff
                        .files
                        .iter()
                        .find(|file| &file.path == path)
                        .and_then(|file| file.old_path.clone())
                        .unwrap_or_else(|| path.clone())
                } else {
                    path.clone()
                }
            })
            .filter(|path| tree.contains_key(path))
            .collect();
        if check.kind == CheckKind::Lint && targets.is_empty() {
            return Ok((
                entry(
                    check,
                    version,
                    CheckOutcome::Passed {
                        details: CheckDetails {
                            hint: Some("No changed files exist in this version".into()),
                            ..Default::default()
                        },
                    },
                    started.elapsed(),
                    false,
                ),
                false,
            ));
        }
        let disposable =
            ToolTree::create_until(cached, &self.cache.path.join("tools"), &self.links, &|| {
                self.before().is_some()
            })?;
        let tool = check.tool.as_ref().context("no diagnostic tool")?;
        let mut command = diagnostic_command(tool, tree, disposable.path(), &check.root, &targets)?;
        command.timeout = self.available(check.kind);
        command.output_limit = self.request.output_limit;
        let result = self
            .supervisor
            .run(command, self.cancellation.clone())
            .await;
        let context = DiagnosticContext {
            repository_root: disposable.path(),
            project_root: &check.root,
            tool_version: &tool.version,
            worktree_root: Some(&self.request.worktree),
            sources: Some(tree),
        };
        let adapter: &dyn Adapter = if check.language == "typescript" {
            &TypeScriptAdapter
        } else {
            &PythonAdapter
        };
        let parsed = adapter.parse_output(&tool.name, &result.stdout, &result.stderr, &context);
        let spec = tool_contract(&adapter.manifest().name, key(check.kind), &tool.name)?;
        let mut outcome = evaluate_exit(&result, &spec.exit_codes, parsed);
        outcome.details_mut().dependency_state = check.dependency_state;
        if let Err(error) = self.persist_process(check, version, &result) {
            outcome = failure(error.to_string());
        }
        if !result.cleanup_confirmed {
            let preserved = disposable.preserve();
            outcome.details_mut().hint = Some(format!(
                "{}; disposable tree retained at {}",
                outcome
                    .details()
                    .hint
                    .as_deref()
                    .unwrap_or("process cleanup unconfirmed"),
                preserved.display()
            ));
        }
        self.cache.write(
            &format!("{}/findings.json", check_path(check, version)),
            &serde_json::to_vec(&outcome.details().findings)?,
        )?;
        Ok((
            entry(check, version, outcome, started.elapsed(), false),
            true,
        ))
    }

    async fn baseline(&self, check: &PlannedCheck) -> Result<(CheckEntry, bool)> {
        // Unverified installation metadata cannot prove that a prior run used
        // this environment. Compare trusted head/base results within this run.
        if check.dependency_state == Some(DependencyState::Trusted) {
            return self.diagnostic(check, Version::Base).await;
        }
        let tool = check.tool.as_ref().context("no baseline tool")?;
        let mut targets = check.targets.clone();
        targets.sort();
        let input = serde_json::to_vec(
            &serde_json::json!({"version":1,"root":check.root,"kind":check.kind,"tool":tool.name,"tool_version":tool.version,"targets":targets,"dependencies":check.dependency_hash,"dependency_state":check.dependency_state,"invocation":"rio-diagnostic-v3"}),
        )?;
        let hash = blake3::hash(&input).to_hex().to_string();
        let relative = format!(
            "baselines/{}/{}/{hash}.json",
            self.request.changes.base_id,
            key(check.kind)
        );
        let _lock = self
            .cache
            .entry_lock(&relative, self.available(check.kind), &self.cancellation)
            .await?;
        let path = self.cache.options.dir.join(&relative);
        if let Ok(bytes) = std::fs::read(&path)
            && let Ok(mut cached) = serde_json::from_slice::<CheckEntry>(&bytes)
        {
            cached.cached = true;
            cached.wall_time_ms = 0;
            return Ok((cached, false));
        }
        let (baseline, ran) = self.diagnostic(check, Version::Base).await?;
        if completed(&baseline.outcome) {
            atomic_write(&path, &serde_json::to_vec(&baseline)?)?;
        }
        Ok((baseline, ran))
    }

    async fn check(&self, check: PlannedCheck) -> Result<CheckResult> {
        let started = Instant::now();
        let mut result = CheckResult::default();
        if let Some(outcome) = self.before().or_else(|| check.skip.clone()) {
            result.entries.push(entry(
                &check,
                Version::Head,
                outcome,
                started.elapsed(),
                false,
            ));
            return Ok(result);
        }
        match check.kind {
            CheckKind::Typecheck | CheckKind::Lint => {
                if let Some(error) = &self.material_error {
                    result.entries.push(entry(
                        &check,
                        Version::Head,
                        failure(error.clone()),
                        started.elapsed(),
                        false,
                    ));
                    return Ok(result);
                }
                let (mut head, ran) = self.diagnostic(&check, Version::Head).await?;
                result.tools_ran |= ran;
                if let Some(hint) = &check.baseline_hint {
                    result
                        .notes
                        .push(format!("{} {}: {hint}", key(check.kind), check.root));
                }
                let baseline = if check.baseline && completed(&head.outcome) {
                    match self.baseline(&check).await {
                        Ok((base, ran)) => {
                            result.tools_ran |= ran;
                            let findings = completed(&base.outcome)
                                .then(|| base.outcome.details().findings.clone());
                            if findings.is_none() {
                                result.notes.push(format!(
                                    "baseline_failed: {} {}: {:?}",
                                    key(check.kind),
                                    check.root,
                                    base.outcome
                                ));
                            }
                            if base.cached {
                                result.notes.push(format!(
                                    "{} {} baseline cached",
                                    key(check.kind),
                                    check.root
                                ));
                            }
                            result.entries.push(base);
                            findings
                        }
                        Err(error) => {
                            result.notes.push(format!(
                                "baseline_failed: {} {}: {error}",
                                key(check.kind),
                                check.root
                            ));
                            None
                        }
                    }
                } else {
                    None
                };
                let findings = classify_and_group_scoped(
                    baseline,
                    head.outcome.details().findings.clone(),
                    |path, line| self.diff.map_line(path, line),
                    |location| {
                        self.diff.files.iter().any(|file| {
                            file.path == location.path
                                && file.hunks.iter().any(|hunk| {
                                    // Three context lines on either side, including
                                    // the surviving boundary of a deletion-only hunk.
                                    let start = hunk.head.start.saturating_sub(3).max(1);
                                    let end = hunk
                                        .head
                                        .start
                                        .saturating_add(hunk.head.count.saturating_sub(1))
                                        .saturating_add(3);
                                    location.line_start <= end && location.line_end >= start
                                })
                        })
                    },
                )?;
                head.outcome.details_mut().findings = findings.clone();
                result.findings = findings;
                result.entries.insert(0, head);
            }
            CheckKind::Coverage => {
                if let Some(error) = &self.material_error {
                    result.entries.push(entry(
                        &check,
                        Version::Head,
                        failure(error.clone()),
                        started.elapsed(),
                        false,
                    ));
                    return Ok(result);
                }
                let tool = check.tool.as_ref().context("coverage tool unavailable")?;
                let mut settings = if check.language == "typescript" {
                    typescript_coverage_settings(
                        &self.request.changes.head,
                        &check.root,
                        &tool.name,
                        &tool.version,
                    )?
                } else {
                    python_coverage_settings(&self.request.changes.head, &check.root)?
                };
                let disposable = ToolTree::create_until(
                    &self.materials.as_ref().unwrap().head,
                    &self.cache.path.join("tools"),
                    &self.links,
                    &|| self.before().is_some(),
                )?;
                let run = run_coverage(
                    CoverageRequest {
                        tool,
                        settings: &settings,
                        tool_tree: disposable.path(),
                        worktree_root: Some(&self.request.worktree),
                        timeout: self.available(check.kind),
                        output_limit: self.request.output_limit,
                    },
                    &self.supervisor,
                    self.cancellation.clone(),
                )
                .await;
                let mut outcome = run.outcome;
                outcome.details_mut().dependency_state = check.dependency_state;
                for (index, process) in run.processes.iter().enumerate() {
                    if let Err(error) = self.persist_process(&check, Version::Head, process) {
                        outcome = failure(error.to_string());
                    }
                    if self.request.cache.retain_raw_output {
                        self.cache.write(
                            &format!(
                                "{}/process-{index}.stdout.txt",
                                check_path(&check, Version::Head)
                            ),
                            &process.raw_stdout,
                        )?;
                        self.cache.write(
                            &format!(
                                "{}/process-{index}.stderr.txt",
                                check_path(&check, Version::Head)
                            ),
                            &process.raw_stderr,
                        )?;
                    }
                }
                if run
                    .processes
                    .iter()
                    .any(|process| !process.cleanup_confirmed)
                {
                    result.notes.push(format!(
                        "coverage {}: retained disposable tree {}",
                        check.root,
                        disposable.preserve().display()
                    ));
                }
                result.tools_ran = !run.processes.is_empty();
                settings.reports_unloaded &= !run.data.is_empty();
                result.coverage = run.data;
                self.cache.write(
                    &format!("{}/coverage.json", check_path(&check, Version::Head)),
                    &serde_json::to_vec(&result.coverage)?,
                )?;
                result.settings.push(settings);
                result.entries.push(entry(
                    &check,
                    Version::Head,
                    outcome,
                    started.elapsed(),
                    false,
                ));
            }
            CheckKind::Secrets => {
                let findings = scan_secrets(&self.diff, &self.request.changes.head)?;
                result.findings = group_preserving_states(findings);
                let details = CheckDetails {
                    findings: result.findings.clone(),
                    ..Default::default()
                };
                let outcome = if result.findings.is_empty() {
                    CheckOutcome::Passed { details }
                } else {
                    CheckOutcome::Findings { details }
                };
                result.entries.push(entry(
                    &check,
                    Version::Head,
                    outcome,
                    started.elapsed(),
                    false,
                ));
            }
            CheckKind::Dependencies => {
                let audit = dependency_audit_plan(
                    &self.request.changes.base,
                    &self.request.changes.head,
                    &self.diff,
                )?;
                result.notes.extend(audit.notes);
                let client = OsvClient::new(self.request.cache.dir.clone())?;
                // Advisory ids are discovered by the batch request. A directory
                // reference protects detail publication and reuse until finish.
                self.cache.reference("osv")?;
                let outcome = match tokio::time::timeout(
                    self.available(check.kind),
                    client.audit(
                        &audit.packages,
                        self.request.offline,
                        self.cancellation.clone(),
                    ),
                )
                .await
                {
                    Ok(outcome) => outcome,
                    Err(_) => cancelled(CancellationReason::Timeout),
                };
                for relative in client.used_cache_entries() {
                    self.cache.reference(&relative)?;
                }
                self.cache.unreference("osv")?;
                result.findings = outcome.details().findings.clone();
                result.entries.push(entry(
                    &check,
                    Version::Head,
                    outcome,
                    started.elapsed(),
                    false,
                ));
            }
        }
        Ok(result)
    }
}

fn group_preserving_states(findings: Vec<Finding>) -> Vec<Finding> {
    let mut grouped = BTreeMap::<String, Finding>::new();
    for finding in findings {
        if let Some(group) = grouped.get_mut(&finding.id) {
            group.locations.extend(finding.locations);
        } else {
            grouped.insert(finding.id.clone(), finding);
        }
    }
    for finding in grouped.values_mut() {
        let new = finding
            .locations
            .iter()
            .any(|location| location.occurrence_state == OccurrenceState::New);
        let existing = finding
            .locations
            .iter()
            .any(|location| location.occurrence_state == OccurrenceState::PreExisting);
        finding.state = if new && existing {
            State::Worsened
        } else if new {
            State::New
        } else {
            State::PreExisting
        };
    }
    grouped.into_values().collect()
}

pub async fn review(
    request: ReviewRequest,
    supervisor: ProcessSupervisor,
    cancellation: CancellationToken,
    events: Option<mpsc::UnboundedSender<ReviewEvent>>,
) -> Result<Report> {
    ensure!(request.parallelism > 0, "parallelism must be positive");
    let started = Instant::now();
    let budget = parse_duration(&request.profile.profile.budget.fast.wall_time)
        .map_err(anyhow::Error::msg)?;
    let diff = diff(&request.changes, &profile_excludes(&request.profile))?;
    let snapshot = Snapshot::from_changes(&request.changes);
    let profile_hash = request.profile.hash()?;
    let review_id = blake3::hash(format!("{}|{profile_hash}", snapshot.key).as_bytes()).to_hex()
        [..16]
        .to_owned();
    let mut report = Report::empty(if diff.files.is_empty() {
        ReportStatus::NoChanges
    } else {
        ReportStatus::Complete
    });
    report.review = ReviewHeader {
        id: Some(review_id.clone()),
        run_id: Some(ulid::Ulid::new().to_string()),
        mode: Some(match request.changes.selection {
            Selection::WorkingTree => ReviewMode::WorkingTree,
            Selection::Staged => ReviewMode::Staged,
            Selection::Branch { .. } => ReviewMode::Branch,
        }),
        base: Some(request.changes.base_id.clone()),
        head: Some(request.changes.head_id.clone()),
        profile: Some(request.profile.profile.name.clone()),
        chain: Some(request.profile.chain.clone()),
        ..Default::default()
    };
    if diff.files.is_empty() {
        return Ok(report);
    }
    let reachable = GixRepo::discover(&request.worktree).ok().and_then(|repo| {
        repo.reachable_commits(Duration::from_millis(200))
            .ok()
            .flatten()
    });
    prune_cache(&request.cache, reachable.as_ref())?;
    let cache = Arc::new(RunCache::begin(request.cache.clone(), review_id)?);
    report.review.run_id = Some(cache.run_id.clone());
    cache.write(
        "profile.resolved.yaml",
        request.profile.to_yaml()?.as_bytes(),
    )?;
    for relative in [
        format!("snapshots/{}.tar.zst", snapshot.key),
        format!("baselines/{}/tree", request.changes.base_id),
        format!("heads/{}/tree", snapshot.key),
    ] {
        cache.reference(&relative)?;
    }
    let snapshot_cache = request.cache.dir.clone();
    tokio::task::spawn_blocking(move || snapshot.write_with_timeout(&snapshot_cache, budget))
        .await??;
    let mut plan: Option<ReviewPlan> = None;
    let mut tools_ran = false;
    let order = ordered_steps(&request.profile)?;
    let profile = request.profile.clone();
    let mut execution = Execution {
        request,
        diff,
        cache: cache.clone(),
        supervisor: supervisor.clone(),
        cancellation: cancellation.clone(),
        deadline: started + budget,
        per_check: budget,
        links: Vec::new(),
        materials: None,
        material_error: None,
    };
    for step in order {
        let module = resolve_module(&step.uses)?;
        if !module.local {
            report.deferred.push(DeferredStep {
                step: step.id,
                reason: DeferredReason::NoEndpoint,
            });
            continue;
        }
        emit(
            &events,
            ReviewEvent::StepStarted {
                step: step.id.clone(),
            },
        );
        match module.name.as_str() {
            "rio/prepare" => {
                report.excluded = execution
                    .diff
                    .files
                    .iter()
                    .filter_map(|file| {
                        file.excluded.as_ref().map(|reason| ExcludedFile {
                            path: file.path.clone(),
                            reason: reason.clone(),
                        })
                    })
                    .collect();
                let lines = execution.diff.changed_line_count();
                if lines > profile.profile.max_lines {
                    report.footer.notes.push(format!(
                        "Change has {lines} lines, exceeding max_lines {}; consider splitting it",
                        profile.profile.max_lines
                    ));
                }
                report
                    .footer
                    .notes
                    .push("Intent inference is deferred: no_endpoint".into());
            }
            "rio/checks" => {
                let resolver = ToolResolver::from_environment(execution.request.worktree.clone());
                let planning_cancellation = cancellation.child_token();
                let planning_deadline = execution.deadline;
                let deadline_token = planning_cancellation.clone();
                let deadline_task = tokio::spawn(async move {
                    tokio::time::sleep(planning_deadline.saturating_duration_since(Instant::now()))
                        .await;
                    deadline_token.cancel();
                });
                let mut step_profile = profile.clone();
                step_profile
                    .profile
                    .steps
                    .retain(|candidate| candidate.uses != "rio/checks" || candidate.id == step.id);
                let planned = plan_review(
                    PlanRequest {
                        worktree: &execution.request.worktree,
                        working: &execution.request.working,
                        changes: &execution.request.changes,
                        diff: &execution.diff,
                        profile: &step_profile,
                        resolver: &resolver,
                    },
                    &supervisor,
                    planning_cancellation,
                )
                .await;
                deadline_task.abort();
                let planned = planned?;
                tools_ran |= planned.probes_ran;
                report.footer.notes.extend(planned.notes.clone());
                let mut roots: BTreeSet<_> = planned
                    .roots
                    .iter()
                    .map(|root| root.project.path.clone())
                    .collect();
                roots.extend(
                    planned
                        .roots
                        .iter()
                        .filter_map(|root| root.project.workspace.clone()),
                );
                execution.links = discover_dependency_links(
                    &execution.request.worktree,
                    &roots.into_iter().collect::<Vec<_>>(),
                )?;
                if planned
                    .checks
                    .iter()
                    .any(|check| check.tool.is_some() && check.skip.is_none())
                {
                    let changes = execution.request.changes.clone();
                    let cache_dir = execution.request.cache.dir.clone();
                    let remaining = execution.deadline.saturating_duration_since(Instant::now());
                    let material_cancellation = cancellation.clone();
                    match tokio::task::spawn_blocking(move || {
                        MaterializationCache::new(cache_dir, remaining)
                            .materialize_until(&changes, &|| material_cancellation.is_cancelled())
                    })
                    .await?
                    {
                        Ok(materials) => {
                            report.footer.notes.extend(materials.base.notes.clone());
                            report.footer.notes.extend(materials.head.notes.clone());
                            execution.materials = Some(materials);
                        }
                        Err(error) => execution.material_error = Some(error.to_string()),
                    }
                }
                let shared = Arc::new(execution);
                let semaphore = Arc::new(Semaphore::new(shared.request.parallelism));
                let mut tasks = JoinSet::new();
                for check in &planned.checks {
                    let check = check.clone();
                    let execution = shared.clone();
                    let semaphore = semaphore.clone();
                    tasks.spawn(async move {
                        let acquired=tokio::select! {_=execution.cancellation.cancelled()=>false,_=tokio::time::sleep(execution.deadline.saturating_duration_since(Instant::now()))=>false,permit=semaphore.acquire_owned()=>{let _permit=permit.expect("open semaphore");return (check.clone(),execution.check(check).await);}};
                        debug_assert!(!acquired);let reason=if execution.cancellation.is_cancelled(){CancellationReason::Interrupted}else{CancellationReason::Timeout};let mut result=CheckResult::default();result.entries.push(entry(&check,Version::Head,cancelled(reason),Duration::ZERO,false));(check,Ok(result))
                    });
                }
                let mut coverage = CoverageData::new();
                let mut settings = Vec::new();
                while let Some(task) = tasks.join_next().await {
                    let (check, result) = task?;
                    let result = match result {
                        Ok(result) => result,
                        Err(error) => CheckResult {
                            entries: vec![entry(
                                &check,
                                Version::Head,
                                shared
                                    .before()
                                    .unwrap_or_else(|| failure(error.to_string())),
                                Duration::ZERO,
                                false,
                            )],
                            ..Default::default()
                        },
                    };
                    tools_ran |= result.tools_ran;
                    merge_coverage(&mut coverage, result.coverage);
                    settings.extend(result.settings);
                    report.footer.notes.extend(result.notes);
                    for entry in result.entries {
                        emit(
                            &events,
                            ReviewEvent::CheckFinished {
                                kind: entry.kind,
                                root: entry.root.clone(),
                                findings: entry.outcome.details().findings.len(),
                                skipped: matches!(entry.outcome, CheckOutcome::Skipped { .. }),
                                outcome: entry.outcome.clone(),
                            },
                        );
                        report.checks.push(entry);
                    }
                    for finding in result.findings {
                        if finding.category == Category::Risk {
                            report.risks.push(finding);
                        } else {
                            report.findings.push(finding);
                        }
                    }
                }
                let findings = diff_coverage(
                    &shared.request.changes.head,
                    &shared.diff,
                    &coverage,
                    &settings,
                )?;
                for mut finding in findings.findings {
                    if report.checks.iter().any(|entry| {
                        entry.kind == CheckKind::Coverage && !completed(&entry.outcome)
                    }) {
                        finding
                            .evidence
                            .push("Coverage includes usable data from an incomplete run".into());
                    }
                    report.risks.push(finding);
                }
                report.excluded.extend(findings.excluded);
                for check in &planned.checks {
                    if let Some(tool) = &check.tool {
                        report.footer.tool_versions.insert(
                            format!("{}:{}:{}", check.language, check.root, tool.name),
                            tool.version.clone(),
                        );
                        if let Some(hint) = &tool.version_hint {
                            report.footer.notes.push(hint.clone());
                        }
                    }
                }
                execution = Arc::try_unwrap(shared)
                    .map_err(|_| anyhow::anyhow!("check execution still referenced"))?;
                plan = Some(planned);
            }
            "rio/graph" => {
                let options = GraphOptions {
                    hops: step.options["hops"].as_u64().unwrap_or(2) as usize,
                    max_nodes: step.options["max_nodes"].as_u64().unwrap_or(2000) as usize,
                    exclude: profile_excludes(&profile),
                };
                let graph = GraphBuilder::default().build_until(
                    &execution.request.changes,
                    &execution.diff,
                    &options,
                    &|| cancellation.is_cancelled() || Instant::now() >= execution.deadline,
                )?;
                graph.write(&cache.path)?;
                report.impact = graph.impact(options.hops);
                report.footer.notes.push(
                    "Graph references use syntax and text; no language server was used".into(),
                );
                if report.impact.truncated {
                    report.footer.notes.push(
                        if cancellation.is_cancelled() {
                            "Impact graph truncated after interruption"
                        } else if Instant::now() >= execution.deadline {
                            "Impact graph truncated at the review deadline"
                        } else {
                            "Impact graph truncated at max_nodes"
                        }
                        .into(),
                    );
                }
                emit(
                    &events,
                    ReviewEvent::GraphReady {
                        impact: report.impact.clone(),
                    },
                );
            }
            "rio/report" => {}
            _ => {}
        }
        emit(&events, ReviewEvent::StepFinished { step: step.id });
    }
    let _ = plan;
    if cancellation.is_cancelled() {
        report.status = ReportStatus::Partial;
    }
    if execution.request.offline && tools_ran {
        report.footer.notes.push(
            "Offline applies to Rio; tool and test processes were not network-isolated".into(),
        );
    }
    if report
        .checks
        .iter()
        .any(|entry| entry.outcome.details().dependency_state == Some(DependencyState::Trusted))
    {
        report.footer.notes.push(
            "dependencies_trusted: results were computed against unverified dependencies".into(),
        );
    }
    report.findings = deduplicate(report.findings);
    report.risks = deduplicate(report.risks);
    apply_suppressions(&mut report, &profile.profile.suppress)?;
    report.summary.pre_existing = report
        .findings
        .iter()
        .chain(&report.risks)
        .filter(|finding| finding.state == State::PreExisting)
        .count();
    report.summary.fixed = report
        .findings
        .iter()
        .chain(&report.risks)
        .filter(|finding| finding.state == State::Fixed)
        .count();
    derive_report_status(&mut report);
    report.metrics.wall_time_ms = started.elapsed().as_millis() as u64;
    report.metrics.checks = report
        .checks
        .iter()
        .map(|entry| CheckMetric {
            kind: entry.kind,
            root: entry.root.clone(),
            version: entry.version,
            wall_time_ms: entry.wall_time_ms,
        })
        .collect();
    report.metrics.tool_versions = report.footer.tool_versions.clone();
    cache.finish(&report)?;
    emit(
        &events,
        if report.status == ReportStatus::Partial {
            ReviewEvent::Partial {
                report: Box::new(report.clone()),
            }
        } else {
            ReviewEvent::Done {
                report: Box::new(report.clone()),
            }
        },
    );
    Ok(report)
}
fn deduplicate(findings: Vec<Finding>) -> Vec<Finding> {
    let mut unique = BTreeMap::new();
    for finding in findings {
        unique.entry(finding.id.clone()).or_insert(finding);
    }
    unique.into_values().collect()
}

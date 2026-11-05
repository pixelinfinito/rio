use anyhow::Result;
use rio_adapters::*;
use rio_core::*;
use rio_git::{ChangeSet, Diff, Tree};
use rio_profile::ResolvedProfile;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlannedCheck {
    pub kind: CheckKind,
    pub language: String,
    pub root: String,
    #[serde(default)]
    pub workspace_wide: bool,
    pub scheduled_as: ScheduledAs,
    pub tool: Option<ResolvedTool>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub additional_tools: Vec<ResolvedTool>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_skips: Vec<CheckOutcome>,
    pub skip: Option<CheckOutcome>,
    pub targets: Vec<String>,
    pub dependency_state: Option<DependencyState>,
    pub dependency_hash: Option<String>,
    pub baseline: bool,
    #[serde(default)]
    pub baseline_remap: bool,
    pub baseline_hint: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RootReadiness {
    pub project: ProjectRoot,
    pub installation_root: String,
    pub lockfile: Option<String>,
    /// Repository-relative governing lockfile found in the selected base tree.
    #[serde(default)]
    pub base_lockfile: Option<String>,
    pub environment: Option<PathBuf>,
    pub head: Compatibility,
    pub base: Compatibility,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ReviewPlan {
    pub layout: RepositoryLayout,
    pub roots: Vec<RootReadiness>,
    pub checks: Vec<PlannedCheck>,
    pub notes: Vec<String>,
    pub probes_ran: bool,
}

pub fn check_enabled(profile: &ResolvedProfile, kind: CheckKind) -> bool {
    let key = match kind {
        CheckKind::Typecheck => "typecheck",
        CheckKind::Lint => "lint",
        CheckKind::Coverage => "coverage",
        CheckKind::Secrets => "secrets",
        CheckKind::Dependencies => "dependencies",
    };
    profile
        .profile
        .step("rio/checks")
        .is_some_and(|step| step.options[key].as_bool().unwrap_or(true))
}
pub fn profile_excludes(profile: &ResolvedProfile) -> Vec<String> {
    profile
        .profile
        .step("rio/prepare")
        .and_then(|step| step.options["exclude"].as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}
fn skip(reason: SkipReason, hint: impl Into<String>) -> CheckOutcome {
    CheckOutcome::Skipped {
        reason,
        details: CheckDetails {
            hint: Some(hint.into()),
            ..Default::default()
        },
    }
}

async fn python_environment(
    resolver: &ToolResolver,
    root: &str,
    supervisor: &ProcessSupervisor,
    cancellation: CancellationToken,
    notes: &mut Vec<String>,
) -> Option<pep508_rs::MarkerEnvironment> {
    let python = resolver
        .locate("python", root, "python")
        .or_else(|| resolver.locate("python3", root, "python"))?;
    let temporary = tempfile::tempdir().ok()?;
    let mut command = ToolCommand::new(python, temporary.path().into());
    command.args=vec!["-I".into(),"-c".into(),r#"import json,os,platform,sys; v=sys.version_info; print(json.dumps(dict(implementation_name=sys.implementation.name,implementation_version='.'.join(map(str,sys.implementation.version[:3])),os_name=os.name,platform_machine=platform.machine(),platform_python_implementation=platform.python_implementation(),platform_release=platform.release(),platform_system=platform.system(),platform_version=platform.version(),python_full_version=platform.python_version(),python_version=f'{v.major}.{v.minor}',sys_platform=sys.platform)))"#.into()];
    command.timeout = Duration::from_secs(10);
    command.output_limit = 65536;
    let result = supervisor.run(command, cancellation).await;
    if !result.cleanup_confirmed {
        let retained = temporary.keep();
        notes.push(redact(&format!("Python marker-probe directory retained at {} because cleanup could not be confirmed: {}", retained.display(), result.survivors.join("; "))));
        return None;
    }
    if matches!(result.termination, Termination::Exited { code: Some(0) }) {
        serde_json::from_slice(&result.stdout).ok()
    } else {
        None
    }
}

pub struct PlanRequest<'a> {
    pub worktree: &'a Path,
    pub working: &'a Tree,
    pub changes: &'a ChangeSet,
    pub diff: &'a Diff,
    pub profile: &'a ResolvedProfile,
    pub resolver: &'a ToolResolver,
}

pub async fn plan_review(
    request: PlanRequest<'_>,
    supervisor: &ProcessSupervisor,
    cancellation: CancellationToken,
) -> Result<ReviewPlan> {
    plan_review_with_progress(request, supervisor, cancellation, &|_| {}).await
}

pub async fn plan_review_with_progress(
    request: PlanRequest<'_>,
    supervisor: &ProcessSupervisor,
    cancellation: CancellationToken,
    progress: &(dyn Fn(&str) + Sync),
) -> Result<ReviewPlan> {
    let PlanRequest {
        worktree,
        working,
        changes,
        diff,
        profile,
        resolver,
    } = request;
    let mut layout = detect_repository(&changes.head, diff)?;
    let rust_workspaces: std::collections::BTreeSet<_> = layout
        .roots
        .iter()
        .filter(|root| root.language == "rust")
        .map(|root| root.workspace.clone().unwrap_or_else(|| root.path.clone()))
        .collect();
    let rust_probes =
        !rust_workspaces.is_empty() && resolver.locate("rustup", ".", "rust").is_some();
    for root in rust_workspaces {
        if let Some(cargo) = rust_cargo(
            resolver,
            &changes.head,
            &root,
            supervisor,
            cancellation.clone(),
        )
        .await?
        {
            match rust_metadata(
                &changes.head,
                &root,
                &cargo,
                supervisor,
                cancellation.clone(),
            )
            .await
            {
                Ok(metadata) => apply_rust_metadata(&mut layout, &metadata),
                Err(error) => layout
                    .notes
                    .push(format!("Rust workspace discovery: {error:#}")),
            }
        }
    }
    let scheduled = layout.schedule(diff);
    let mut plan = ReviewPlan {
        notes: layout.notes.clone(),
        layout,
        probes_ran: rust_probes,
        ..Default::default()
    };
    let options = profile
        .profile
        .step("rio/checks")
        .map(|step| step.options.clone())
        .unwrap_or_default();
    let trust = options["trust_installed_dependencies"]
        .as_bool()
        .unwrap_or(false);
    let baseline = options["baseline"].as_bool().unwrap_or(true);
    let mut versions = BTreeMap::<(String, String, String), Option<ResolvedTool>>::new();
    let scheduled_roots: Vec<_> = scheduled
        .iter()
        .map(|root| root.project.path.clone())
        .collect();
    for scheduled in scheduled {
        let project = &scheduled.project;
        let language = &project.language;
        let root = &project.path;
        progress(root);
        let ecosystem = match language.as_str() {
            "typescript" => Ecosystem::Npm,
            "rust" => Ecosystem::CratesIo,
            _ => Ecosystem::PyPi,
        };
        let mut lock =
            governing_lockfile(&changes.head, root, project.workspace.as_deref(), ecosystem)?;
        let mut base_lock =
            governing_lockfile(&changes.base, root, project.workspace.as_deref(), ecosystem)?;
        if language == "rust"
            && let Some(lock) = &lock
        {
            for note in &lock.graph.notes {
                let note = format!("{}: {note}", lock.path);
                if !plan.notes.contains(&note) {
                    plan.notes.push(note);
                }
            }
        }
        if language == "rust" && scheduled.workspace_wide {
            for lock in [&mut lock, &mut base_lock].into_iter().flatten() {
                let dependencies = lock
                    .graph
                    .importers
                    .values()
                    .flat_map(|importer| importer.dependencies.clone())
                    .collect();
                lock.importer = "__rio_workspace".into();
                lock.graph
                    .importers
                    .insert(lock.importer.clone(), Importer { dependencies });
            }
        }
        let installation_root = lock
            .as_ref()
            .map(|lock| lock.root.clone())
            .unwrap_or_else(|| project.workspace.clone().unwrap_or_else(|| root.clone()));
        let installed_graph = lock
            .as_ref()
            .or(base_lock.as_ref())
            .map(|lock| lock.graph.clone())
            .unwrap_or_else(|| {
                DependencyGraph::new(if language == "typescript" {
                    "npm"
                } else {
                    "requirements"
                })
            });
        let mut installation = if language == "rust" {
            Installation::default()
        } else {
            read_installation(worktree, &installation_root, &installed_graph)
        };
        if let Some(lock) = &mut lock {
            scope_pnpm_importers(
                &mut lock.graph,
                Some(&mut installation),
                worktree,
                &installation_root,
                &scheduled_roots,
            );
        }
        if let Some(lock) = &mut base_lock {
            scope_pnpm_importers(
                &mut lock.graph,
                None,
                worktree,
                &installation_root,
                &scheduled_roots,
            );
        }
        let mut environment = DependencyEnvironment::default();
        if language == "python"
            && [CheckKind::Typecheck, CheckKind::Lint, CheckKind::Coverage]
                .iter()
                .any(|kind| check_enabled(profile, *kind))
        {
            environment.python = python_environment(
                resolver,
                root,
                supervisor,
                cancellation.clone(),
                &mut plan.notes,
            )
            .await;
            plan.probes_ran = true;
        }
        let compatibility = |selected: &Tree, lockfile: Option<&GoverningLockfile>, trust, base| {
            let checker = if base {
                check_base_compatibility
            } else {
                check_compatibility
            };
            checker(CompatibilityRequest {
                worktree,
                working,
                selected,
                project_root: root,
                lockfile,
                installation: &installation,
                environment: &environment,
                trust,
            })
        };
        let cargo = if language == "rust" {
            rust_cargo(
                resolver,
                &changes.head,
                root,
                supervisor,
                cancellation.clone(),
            )
            .await?
        } else {
            None
        };
        let (head, base) = if language == "rust" {
            cargo_compatibility(
                lock.as_ref(),
                base_lock.as_ref(),
                cargo.is_some(),
                rust_toolchain(&changes.head, root)?
                    .as_deref()
                    .unwrap_or("default"),
                trust,
            )
        } else {
            (
                compatibility(&changes.head, lock.as_ref(), trust, false),
                compatibility(&changes.base, base_lock.as_ref(), false, true),
            )
        };
        let canonical_worktree = worktree.canonicalize()?;
        let baseline_remap = matches!(head, Compatibility::Trusted { .. })
            || installation
                .links
                .values()
                .any(|target| target.strip_prefix(&canonical_worktree).is_ok());
        let environment_path = if language == "rust" {
            Some(worktree.join(&installation_root).join("target"))
        } else if language == "typescript" {
            Some(worktree.join(&installation_root).join("node_modules"))
        } else {
            [
                worktree.join(&installation_root).join(".venv"),
                worktree.join(&installation_root).join("venv"),
            ]
            .into_iter()
            .find(|path| path.is_dir())
            .or_else(|| resolver.virtual_env.clone())
        };
        for kind in scheduled.checks() {
            let enabled = check_enabled(profile, kind);
            let mut skipped =
                (!enabled).then(|| skip(SkipReason::Disabled, "Disabled in the profile"));
            let tool_name = match kind {
                CheckKind::Typecheck if language == "rust" => Some("cargo-check"),
                CheckKind::Lint if language == "rust" => {
                    rust_lint_tools(&changes.head, root).first().copied()
                }
                CheckKind::Coverage if language == "rust" => Some("cargo-llvm-cov"),
                CheckKind::Typecheck if language == "typescript" => Some("tsc"),
                CheckKind::Typecheck => python_typechecker(&changes.head, root, |name| {
                    resolver.locate(name, root, language).is_some()
                }),
                CheckKind::Lint => Some(if language == "typescript" {
                    typescript_linter(&changes.head, root)
                } else {
                    "ruff"
                }),
                CheckKind::Coverage if language == "typescript" => {
                    typescript_test_runner(&changes.head, root)
                }
                CheckKind::Coverage => Some("coverage"),
                _ => None,
            };
            let mut tool = if enabled {
                if let Some(name) = tool_name {
                    let key = (root.clone(), language.clone(), name.into());
                    if !versions.contains_key(&key) {
                        let tool = if language == "rust" {
                            match &cargo {
                                Some(cargo) => {
                                    rust_subcommand(
                                        cargo,
                                        name,
                                        &changes.head,
                                        root,
                                        supervisor,
                                        cancellation.clone(),
                                    )
                                    .await?
                                }
                                None => None,
                            }
                        } else {
                            resolver
                                .resolve(name, root, language, supervisor, cancellation.clone())
                                .await
                        };
                        plan.probes_ran |= tool.is_some();
                        versions.insert(key.clone(), tool);
                    }
                    versions[&key].clone()
                } else {
                    None
                }
            } else {
                None
            };
            let mut additional_tools = Vec::new();
            let mut tool_skips = Vec::new();
            if enabled
                && language == "rust"
                && kind == CheckKind::Lint
                && let Some(cargo) = &cargo
            {
                for name in rust_lint_tools(&changes.head, root).into_iter().skip(1) {
                    if let Some(tool) = rust_subcommand(
                        cargo,
                        name,
                        &changes.head,
                        root,
                        supervisor,
                        cancellation.clone(),
                    )
                    .await?
                    {
                        additional_tools.push(tool);
                    } else {
                        tool_skips.push(skip(
                            SkipReason::ToolMissing,
                            format!("Install the {name} component for the selected Rust toolchain"),
                        ));
                    }
                }
            }
            if enabled
                && language == "rust"
                && kind == CheckKind::Lint
                && tool.is_none()
                && let Some(available) = additional_tools.pop()
            {
                tool = Some(available);
                tool_skips.push(skip(
                    SkipReason::ToolMissing,
                    format!(
                        "Install {} for the selected Rust toolchain",
                        tool_name.unwrap_or("clippy")
                    ),
                ));
            }
            if skipped.is_none() {
                skipped = diagnostic_config_skip(kind, language, &changes.head, root);
            }
            if skipped.is_none() && tool.is_none() {
                skipped = Some(skip(
                    SkipReason::ToolMissing,
                    if language == "rust" && kind == CheckKind::Coverage {
                        "Install cargo-llvm-cov with cargo install cargo-llvm-cov and llvm-tools-preview with rustup component add llvm-tools-preview for the selected toolchain".into()
                    } else if language == "python" && kind == CheckKind::Typecheck {
                        "Install pyright or mypy in the project environment".into()
                    } else {
                        format!(
                            "Install {} in the project environment",
                            tool_name.unwrap_or("vitest or jest")
                        )
                    },
                ));
            }
            if skipped.is_none()
                && language == "python"
                && kind == CheckKind::Coverage
                && resolver.locate("pytest", root, language).is_none()
            {
                skipped = Some(skip(
                    SkipReason::ToolMissing,
                    "Install pytest in the project environment for coverage",
                ));
            }
            if skipped.is_none() && !head.can_run() {
                skipped = Some(skip(
                    SkipReason::DependencyMismatch,
                    head.hint().unwrap_or("Installed dependencies do not match"),
                ));
            }
            // Preserve source-lock parse failures even when an earlier readiness
            // check (such as a missing tool) also prevents execution.
            if let Some(outcome) = &mut skipped
                && let Some(problem) = lock.as_ref().and_then(|lock| {
                    lock.graph
                        .notes
                        .iter()
                        .find(|note| note.starts_with("cannot parse "))
                })
            {
                let hint = outcome.details_mut().hint.get_or_insert_default();
                if !hint.contains(problem) {
                    *hint = format!("{hint}; {problem}");
                }
            }
            let (can_baseline, baseline_hint) = baseline_readiness(baseline, &head, &base);
            let dependency_hash = match (&head, &base) {
                (Compatibility::Trusted { hash, .. }, _)
                | (_, Compatibility::Verified { hash }) => Some(hash.clone()),
                _ => None,
            };
            plan.checks.push(PlannedCheck {
                kind,
                language: language.clone(),
                root: root.clone(),
                workspace_wide: scheduled.workspace_wide,
                scheduled_as: scheduled.scheduled_as,
                tool,
                additional_tools,
                tool_skips,
                skip: skipped,
                targets: scheduled
                    .changed_files
                    .iter()
                    .filter(|path| language_for_path(path) == Some(language.as_str()))
                    .cloned()
                    .collect(),
                dependency_state: head.dependency_state(),
                dependency_hash,
                baseline: can_baseline,
                baseline_remap,
                baseline_hint,
            });
        }
        plan.roots.push(RootReadiness {
            project: project.clone(),
            installation_root,
            lockfile: lock.map(|lock| lock.path),
            base_lockfile: base_lock.map(|lock| lock.path),
            environment: environment_path,
            head,
            base,
        });
    }
    for kind in [CheckKind::Secrets, CheckKind::Dependencies] {
        plan.checks.push(PlannedCheck {
            kind,
            language: "common".into(),
            root: ".".into(),
            workspace_wide: false,
            scheduled_as: ScheduledAs::Changed,
            tool: None,
            additional_tools: Vec::new(),
            tool_skips: Vec::new(),
            skip: (!check_enabled(profile, kind))
                .then(|| skip(SkipReason::Disabled, "Disabled in the profile")),
            targets: Vec::new(),
            dependency_state: None,
            dependency_hash: None,
            baseline: false,
            baseline_remap: false,
            baseline_hint: None,
        });
    }
    Ok(plan)
}

// Both runs link the same installation. Trust permits an unverified base, but
// cannot override a known mismatch (including linked source differences).
fn baseline_readiness(
    enabled: bool,
    head: &Compatibility,
    base: &Compatibility,
) -> (bool, Option<String>) {
    let trusted = matches!(head, Compatibility::Trusted { .. });
    let compatible = head.can_classify_baseline() && base.can_classify_baseline()
        || trusted && !matches!(base, Compatibility::Mismatch { .. });
    let mut hints = Vec::new();
    if !enabled {
        hints.push("baseline disabled in the profile".to_owned());
    } else if !compatible {
        let failed = if matches!(head, Compatibility::Mismatch { .. }) {
            head
        } else {
            base
        };
        hints.push(format!(
            "baseline_failed: {}",
            failed.hint().unwrap_or("dependencies cannot be verified")
        ));
    }
    if trusted {
        hints.push("dependencies_trusted: results use unverified dependencies".into());
    }
    (
        enabled && compatible,
        (!hints.is_empty()).then(|| hints.join("; ")),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn baseline_requires_verified_dependencies_or_a_shared_trusted_environment() {
        let states = [
            Compatibility::Verified {
                hash: "verified".into(),
            },
            Compatibility::Trusted {
                hash: "trusted".into(),
                hint: "trusted".into(),
            },
            Compatibility::Unverified {
                hint: "no metadata".into(),
            },
            Compatibility::Mismatch {
                hint: "different package".into(),
            },
        ];
        for (h, head) in states.iter().enumerate() {
            for (b, base) in states.iter().enumerate() {
                let (runs, hint) = baseline_readiness(true, head, base);
                assert_eq!(
                    runs,
                    h == 0 && b == 0 || h == 1 && b != 3,
                    "{head:?}, {base:?}"
                );
                if h == 3 || b == 3 {
                    assert!(hint.as_ref().unwrap().contains("baseline_failed"));
                }
                if h == 1 {
                    assert!(
                        hint.unwrap()
                            .contains("dependencies_trusted: results use unverified dependencies")
                    );
                }
                assert!(!baseline_readiness(false, head, base).0);
            }
        }
    }
}

use crate::{
    CoverageData, CoverageRequest, CoverageRun, CoverageSettings, DiagnosticContext,
    ProcessSupervisor, Termination, ToolCommand, configure_cargo, evaluate_exit, parse_lcov,
    rust_selection, rust_workspace_root,
};
use anyhow::Result;
use rio_core::{CheckDetails, CheckOutcome, FailureReason, SkipReason};
use rio_git::Tree;
use tokio_util::sync::CancellationToken;

pub fn rust_coverage_settings(tree: &Tree, root: &str) -> Result<CoverageSettings> {
    Ok(CoverageSettings {
        root: root.into(),
        language: "rust".into(),
        invocation_root: Some(rust_workspace_root(tree, root)),
        runner_args: {
            let mut selection = rust_selection(tree, root)?;
            if crate::rust_has_lockfile(tree, root) {
                selection.push("--locked".into());
            }
            selection
        },
        static_known: true,
        reports_unloaded: true,
        ..Default::default()
    })
}

pub(crate) async fn run(
    request: CoverageRequest<'_>,
    supervisor: &ProcessSupervisor,
    cancellation: CancellationToken,
) -> CoverageRun {
    let started = std::time::Instant::now();
    let root = request
        .settings
        .invocation_root
        .as_deref()
        .unwrap_or(&request.settings.root);
    let cwd = request.tool_tree.join(root);
    // Cargo locks compilation, but llvm-cov also cleans/exports profile data.
    // Hold a cross-process lock for that complete sequence across linked targets.
    let cargo_target = std::env::var_os("CARGO_TARGET_DIR")
        .map(std::path::PathBuf::from)
        .map(|path| {
            if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            }
        })
        .unwrap_or_else(|| cwd.join("target"));
    let target = std::env::var_os("CARGO_LLVM_COV_TARGET_DIR")
        .map(std::path::PathBuf::from)
        .map(|path| {
            if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            }
        })
        .unwrap_or_else(|| cargo_target.join("llvm-cov-target"));
    let lock = match coverage_lock(&target, request.timeout, &cancellation).await {
        Ok(lock) => lock,
        Err(outcome) => {
            return CoverageRun {
                data: CoverageData::new(),
                processes: Vec::new(),
                outcome,
            };
        }
    };
    let _lock = lock;
    let output = cwd.join(".rio-coverage");
    if let Err(error) = std::fs::create_dir_all(&output) {
        return CoverageRun {
            data: CoverageData::new(),
            processes: Vec::new(),
            outcome: CheckOutcome::Failed {
                reason: FailureReason::DiskFull,
                details: CheckDetails {
                    hint: Some(error.to_string()),
                    ..Default::default()
                },
            },
        };
    }
    let report = output.join(format!(
        "{}.lcov.info",
        blake3::hash(request.settings.root.as_bytes()).to_hex()
    ));
    let mut command = ToolCommand::new(request.tool.path.clone(), cwd);
    command.args = vec![
        "llvm-cov".into(),
        "--lcov".into(),
        "--output-path".into(),
        report.clone().into_os_string(),
    ];
    command
        .args
        .extend(request.settings.runner_args.iter().map(Into::into));
    // Read only Cargo/toolchain configuration; this is the selected disposable tree.
    let mut tree = Tree::new();
    for directory in request
        .tool_tree
        .join(&request.settings.root)
        .ancestors()
        .take_while(|directory| directory.starts_with(request.tool_tree))
    {
        for name in ["rust-toolchain.toml", "rust-toolchain"] {
            let path = directory.join(name);
            if let Ok(content) = std::fs::read(&path)
                && let Ok(path) = path.strip_prefix(request.tool_tree)
            {
                tree.insert(
                    path.to_string_lossy().replace('\\', "/"),
                    rio_git::TreeEntry {
                        mode: 0o100644,
                        object_id: String::new(),
                        content,
                    },
                );
            }
        }
    }
    let _ = configure_cargo(&mut command, &tree, &request.settings.root);
    configure_output(&mut command, &cargo_target, &target);
    command
        .env
        .insert("CARGO_LLVM_COV_SETUP".into(), "no".into());
    command.timeout = request.timeout.saturating_sub(started.elapsed());
    command.output_limit = request.output_limit;
    let result = supervisor.run(command, cancellation.clone()).await;
    let stdout = String::from_utf8_lossy(&result.stdout);
    let stderr = String::from_utf8_lossy(&result.stderr);
    let text = format!("{stdout}\n{stderr}");
    let failed = text.contains("test result: FAILED") || text.contains("\"event\":\"failed\"");
    let zero_tests = regex::Regex::new(r"running (\d+) tests?").unwrap();
    let counts: Vec<_> = zero_tests
        .captures_iter(&text)
        .filter_map(|capture| capture[1].parse::<usize>().ok())
        .collect();
    let code = match result.termination {
        Termination::Exited { code } => code,
        _ => None,
    };
    let mut contract = crate::ExitCodeContract {
        clean: vec![0],
        ..Default::default()
    };
    if failed {
        contract.failed.insert(101, FailureReason::TestsFailed);
    }
    let mut outcome = evaluate_exit(&result, &contract, Ok(Vec::new()));
    if code == Some(0)
        && !counts.is_empty()
        && counts.iter().all(|count| *count == 0)
        && result.cleanup_confirmed
    {
        outcome = CheckOutcome::Skipped {
            reason: SkipReason::NoTests,
            details: CheckDetails {
                hint: Some("Every Cargo target ran zero tests".into()),
                ..Default::default()
            },
        };
    }
    let context = DiagnosticContext {
        repository_root: request.tool_tree,
        project_root: root,
        tool_version: &request.tool.version,
        worktree_root: request.worktree_root,
        sources: None,
    };
    let confirmed = result.cleanup_confirmed;
    let mut processes = vec![result];
    if failed && code == Some(101) && confirmed && !report.is_file() {
        // cargo-llvm-cov skips its report phase when cargo test fails. Export
        // the already-written profile data without running tests a second time.
        let mut export = ToolCommand::new(request.tool.path.clone(), request.tool_tree.join(root));
        export.args = vec![
            "llvm-cov".into(),
            "report".into(),
            "--lcov".into(),
            "--output-path".into(),
            report.clone().into_os_string(),
        ];
        export
            .args
            .extend(request.settings.runner_args.iter().map(Into::into));
        let _ = configure_cargo(&mut export, &tree, &request.settings.root);
        configure_output(&mut export, &cargo_target, &target);
        export
            .env
            .insert("CARGO_LLVM_COV_SETUP".into(), "no".into());
        export.timeout = request.timeout.saturating_sub(started.elapsed());
        export.output_limit = request.output_limit;
        processes.push(supervisor.run(export, cancellation).await);
    }
    let data = std::fs::read(&report)
        .map_err(anyhow::Error::from)
        .and_then(|bytes| parse_lcov(&bytes, &context));
    let data = match data {
        Ok(data) => data,
        Err(error) if matches!(outcome, CheckOutcome::Passed { .. }) => {
            outcome = CheckOutcome::Failed {
                reason: FailureReason::UnparseableOutput,
                details: CheckDetails {
                    hint: Some(error.to_string()),
                    ..Default::default()
                },
            };
            CoverageData::new()
        }
        Err(_) => CoverageData::new(),
    };
    if failed && code == Some(101) && !data.is_empty() {
        let count = regex::Regex::new(r"(\d+) failed")
            .unwrap()
            .captures(&text)
            .map(|capture| capture[1].to_owned())
            .unwrap_or_else(|| "unknown number of".into());
        outcome.details_mut().hint = Some(format!(
            "{count} tests failed; usable coverage from the incomplete run is retained"
        ));
    }
    CoverageRun {
        data,
        outcome,
        processes,
    }
}

/// Pin metadata, build artifacts and profiles to the directories guarded by
/// the coverage lock, overriding project/global Cargo output configuration.
fn configure_output(
    command: &mut ToolCommand,
    cargo_target: &std::path::Path,
    coverage_target: &std::path::Path,
) {
    for (name, path) in [
        ("CARGO_TARGET_DIR", cargo_target),
        ("CARGO_BUILD_BUILD_DIR", coverage_target),
        ("CARGO_LLVM_COV_TARGET_DIR", coverage_target),
        ("CARGO_LLVM_COV_BUILD_DIR", coverage_target),
    ] {
        command.env.insert(name.into(), path.as_os_str().to_owned());
    }
}

async fn coverage_lock(
    target: &std::path::Path,
    timeout: std::time::Duration,
    cancellation: &CancellationToken,
) -> Result<std::fs::File, CheckOutcome> {
    use fs4::fs_std::FileExt;
    let file = (|| -> std::io::Result<_> {
        std::fs::create_dir_all(target)?;
        std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(target.join(".rio-llvm-cov.lock"))
    })()
    .map_err(|error| CheckOutcome::Failed {
        reason: FailureReason::ToolCrashed,
        details: CheckDetails {
            hint: Some(format!("Rust coverage lock: {error}")),
            ..Default::default()
        },
    })?;
    let started = tokio::time::Instant::now();
    loop {
        let reason = if cancellation.is_cancelled() {
            Some(rio_core::CancellationReason::Interrupted)
        } else if started.elapsed() >= timeout {
            Some(rio_core::CancellationReason::Timeout)
        } else {
            None
        };
        if let Some(reason) = reason {
            return Err(CheckOutcome::Cancelled {
                reason,
                details: CheckDetails {
                    hint: Some("Waiting for shared Rust coverage target".into()),
                    ..Default::default()
                },
            });
        }
        match FileExt::try_lock_exclusive(&file) {
            Ok(true) => return Ok(file),
            Ok(false) => {}
            Err(error) => {
                return Err(CheckOutcome::Failed {
                    reason: FailureReason::ToolCrashed,
                    details: CheckDetails {
                        hint: Some(error.to_string()),
                        ..Default::default()
                    },
                });
            }
        }
        tokio::select! {
            _ = cancellation.cancelled() => {},
            _ = tokio::time::sleep(std::time::Duration::from_millis(10)) => {},
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn shared_target_lock_obeys_deadlines_cancellation_and_release() {
        let temp = tempfile::tempdir().unwrap();
        let first = coverage_lock(
            temp.path(),
            Duration::from_secs(1),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        let timed = coverage_lock(
            temp.path(),
            Duration::from_millis(25),
            &CancellationToken::new(),
        )
        .await;
        assert!(matches!(
            timed,
            Err(CheckOutcome::Cancelled {
                reason: rio_core::CancellationReason::Timeout,
                ..
            })
        ));
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        assert!(matches!(
            coverage_lock(temp.path(), Duration::from_secs(1), &cancellation).await,
            Err(CheckOutcome::Cancelled {
                reason: rio_core::CancellationReason::Interrupted,
                ..
            })
        ));
        drop(first);
        assert!(
            coverage_lock(
                temp.path(),
                Duration::from_secs(1),
                &CancellationToken::new()
            )
            .await
            .is_ok()
        );
    }
}

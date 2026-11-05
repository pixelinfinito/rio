use rio_adapters::tool_contract;
#[cfg(unix)]
use rio_adapters::{ProcessSupervisor, Termination, ToolCommand, ToolResolver, evaluate_exit};
#[cfg(unix)]
use rio_core::{CheckOutcome, FailureReason};
#[cfg(unix)]
use tokio_util::sync::CancellationToken;

#[test]
fn every_embedded_adapter_tool_has_a_readable_exit_contract() {
    for (module, capability, name) in [
        ("rio/adapter-typescript", "typecheck", "tsc"),
        ("rio/adapter-typescript", "lint", "eslint"),
        ("rio/adapter-python", "typecheck", "pyright"),
        ("rio/adapter-python", "typecheck", "mypy"),
        ("rio/adapter-python", "lint", "ruff"),
    ] {
        let spec = tool_contract(module, capability, name).unwrap();
        assert!(!spec.exit_codes.clean.is_empty());
        assert!(!spec.command.is_empty());
    }
}

#[cfg(unix)]
fn fake(root: &std::path::Path, path: &str, code: &str, executable: bool) -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = root.join(path);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, format!("#!/bin/sh\n{code}\n")).unwrap();
    std::fs::set_permissions(
        &path,
        std::fs::Permissions::from_mode(if executable { 0o700 } else { 0o600 }),
    )
    .unwrap();
    path
}

#[cfg(unix)]
#[tokio::test]
async fn project_local_and_workspace_tools_precede_path_and_versions_are_supervised() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(root.path().join("packages/api")).unwrap();
    let local = fake(
        root.path(),
        "packages/api/node_modules/.bin/tsc",
        "touch probe-write; echo Version-local",
        true,
    );
    let workspace = fake(
        root.path(),
        "node_modules/.bin/tsc",
        "echo Version-workspace",
        true,
    );
    fake(root.path(), "path/tsc", "echo Version-path", true);
    let resolver = ToolResolver {
        repository_root: root.path().into(),
        search_path: vec![root.path().join("path")],
        virtual_env: None,
    };
    let supervisor = ProcessSupervisor::default();
    let tool = resolver
        .resolve(
            "tsc",
            "packages/api",
            "typescript",
            &supervisor,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(tool.path, local);
    assert_eq!(tool.version, "Version-local");
    assert!(!root.path().join("probe-write").exists());
    assert!(!root.path().join("packages/api/probe-write").exists());
    std::fs::remove_file(local).unwrap();
    let tool = resolver
        .resolve(
            "tsc",
            "packages/api",
            "typescript",
            &supervisor,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(tool.path, workspace);
    assert_eq!(tool.version, "Version-workspace");
    assert!(resolver.locate("unknown", ".", "typescript").is_none());
    let python = fake(
        root.path(),
        "packages/api/.venv/bin/ruff",
        "echo ruff-local",
        true,
    );
    let venv = fake(root.path(), "external/bin/ruff", "echo ruff-env", true);
    let resolver = ToolResolver {
        virtual_env: Some(root.path().join("external")),
        ..resolver
    };
    assert_eq!(
        resolver.locate("ruff", "packages/api", "python"),
        Some(python)
    );
    assert_eq!(resolver.locate("ruff", ".", "python"), Some(venv));
}

#[cfg(unix)]
#[tokio::test]
async fn fake_tool_failures_are_distinguished_from_success_and_findings() {
    let root = tempfile::tempdir().unwrap();
    let supervisor = ProcessSupervisor::default();
    let contract = tool_contract("rio/adapter-typescript", "lint", "eslint")
        .unwrap()
        .exit_codes;
    for (name, code, expected) in [
        ("crash", "exit 77", FailureReason::ToolCrashed),
        ("configuration", "exit 2", FailureReason::ToolConfigError),
        (
            "empty-diagnostics",
            "exit 1",
            FailureReason::UnparseableOutput,
        ),
    ] {
        let path = fake(root.path(), name, code, true);
        let result = supervisor
            .run(
                ToolCommand::new(path, root.path().into()),
                CancellationToken::new(),
            )
            .await;
        let outcome = evaluate_exit(&result, &contract, Ok(Vec::new()));
        assert!(
            matches!(outcome,CheckOutcome::Failed {reason,..} if reason==expected),
            "{name}: {outcome:?}"
        );
    }
    let nonexecutable = fake(root.path(), "node_modules/.bin/eslint", "exit 0", false);
    let resolver = ToolResolver {
        repository_root: root.path().into(),
        search_path: Vec::new(),
        virtual_env: None,
    };
    let tool = resolver
        .resolve(
            "eslint",
            ".",
            "typescript",
            &supervisor,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(tool.path, nonexecutable);
    assert_eq!(tool.version, "unknown");
    let result = supervisor
        .run(
            ToolCommand::new(tool.path, root.path().into()),
            CancellationToken::new(),
        )
        .await;
    assert!(matches!(
        result.termination,
        Termination::Failed {
            reason: FailureReason::SpawnFailed,
            ..
        }
    ));
    assert!(matches!(
        evaluate_exit(&result, &contract, Ok(Vec::new())),
        CheckOutcome::Failed {
            reason: FailureReason::SpawnFailed,
            ..
        }
    ));
    let path = fake(root.path(), "clean", "exit 0", true);
    let result = supervisor
        .run(
            ToolCommand::new(path, root.path().into()),
            CancellationToken::new(),
        )
        .await;
    assert!(matches!(
        evaluate_exit(&result, &contract, Ok(Vec::new())),
        CheckOutcome::Passed { .. }
    ));
    assert!(matches!(
        evaluate_exit(&result, &contract, Err(anyhow::anyhow!("invalid JSON"))),
        CheckOutcome::Failed {
            reason: FailureReason::UnparseableOutput,
            ..
        }
    ));
}

#[cfg(unix)]
#[tokio::test]
async fn vitest_version_comes_from_resolved_package_metadata() {
    let root = tempfile::tempdir().unwrap();
    fake(
        root.path(),
        "node_modules/.bin/vitest",
        "echo vitest/3.0.0",
        true,
    );
    std::fs::create_dir_all(root.path().join("node_modules/vitest")).unwrap();
    std::fs::write(
        root.path().join("node_modules/vitest/package.json"),
        r#"{"name":"vitest","version":"4.1.5"}"#,
    )
    .unwrap();
    let resolver = ToolResolver {
        repository_root: root.path().into(),
        search_path: Vec::new(),
        virtual_env: None,
    };
    let tool = resolver
        .resolve(
            "vitest",
            ".",
            "typescript",
            &ProcessSupervisor::default(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(tool.version, "4.1.5");
}

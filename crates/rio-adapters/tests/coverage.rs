mod common;
use common::*;
use rio_adapters::*;
use rio_core::{CheckOutcome, FailureReason, SkipReason};
use rio_git::{CachedTree, DependencyLink, SafeTreeWriter, ToolTree, Tree, diff};
use std::{path::Path, time::Duration};
use tokio_util::sync::CancellationToken;

fn context() -> DiagnosticContext<'static> {
    DiagnosticContext {
        repository_root: Path::new("/recorded/repo"),
        project_root: ".",
        tool_version: "recorded",
        worktree_root: None,
        sources: None,
    }
}
fn all_diff(tree: Tree) -> (Tree, rio_git::Diff) {
    let changes = changes(Tree::new(), tree);
    let diff = diff(&changes, &[]).unwrap();
    (changes.head, diff)
}

#[test]
fn lcov_and_python_data_use_instrumented_executed_and_excluded_lines() {
    let lcov = b"TN:\nSF:src/math.ts\nDA:1,1\nDA:2,0\nLF:2\nLH:1\nend_of_record\n";
    let data = parse_lcov(lcov, &context()).unwrap();
    assert_eq!(
        data["src/math.ts"]
            .instrumented
            .iter()
            .copied()
            .collect::<Vec<_>>(),
        [1, 2]
    );
    assert_eq!(
        data["src/math.ts"]
            .executed
            .iter()
            .copied()
            .collect::<Vec<_>>(),
        [1]
    );
    let py = br#"{"files":{"src/math.py":{"executed_lines":[1],"missing_lines":[2,3],"excluded_lines":[3]}}}"#;
    let data = parse_python_coverage(py, &context()).unwrap();
    assert_eq!(
        data["src/math.py"]
            .instrumented
            .iter()
            .copied()
            .collect::<Vec<_>>(),
        [1, 2]
    );
    assert!(parse_lcov(b"SF:a.ts\nDA:2,0\n", &context()).is_err());
    assert!(parse_lcov(b"compiler stacktrace", &context()).is_err());
    assert!(parse_python_coverage(b"{}", &context()).is_err());
}

#[test]
fn types_comments_and_static_exclusions_are_distinct_from_unknown_instrumentation() {
    let tree: Tree = [
        (
            "src/types.ts".into(),
            entry("export interface User {name: string}\nexport type Id = string;\n"),
        ),
        (
            "src/math.ts".into(),
            entry("export function add() {\n// comment\n return 42;\n}\n"),
        ),
        ("scripts/release.py".into(), entry("print('release')\n")),
        ("tests/test_math.py".into(), entry("assert True\n")),
        (
            "pyproject.toml".into(),
            entry("[tool.coverage.run]\nomit=['scripts/*']\n"),
        ),
        (
            "vitest.config.ts".into(),
            entry("export default {test:{coverage:{include: compute()}}};"),
        ),
    ]
    .into();
    let (tree, diff) = all_diff(tree);
    let ts = typescript_coverage_settings(&tree, ".", "vitest", "vitest/2.1.9 linux-x64 node-v26")
        .unwrap();
    assert!(!ts.static_known);
    let result = diff_coverage(&tree, &diff, &CoverageData::new(), &[ts]).unwrap();
    assert!(result.findings.is_empty());
    assert!(
        !result
            .excluded
            .iter()
            .any(|file| file.path == "src/types.ts")
    );
    assert!(
        result
            .excluded
            .iter()
            .any(|file| file.path == "src/math.ts" && file.reason == "coverage_not_instrumented")
    );
    let py = python_coverage_settings(&tree, ".").unwrap();
    assert!(py.add_python_source);
    let result = diff_coverage(&tree, &diff, &CoverageData::new(), &[py]).unwrap();
    assert!(
        result
            .excluded
            .iter()
            .any(|file| file.path == "scripts/release.py" && file.reason == "coverage_excluded")
    );
    assert!(
        !result
            .findings
            .iter()
            .any(|finding| finding.location.path.contains("test_math"))
    );
    let base: Tree = [(
        "math.ts".into(),
        entry("export function add() {\n// old comment\n return 42;\n}\n"),
    )]
    .into();
    let head: Tree = [(
        "math.ts".into(),
        entry("export function add() {\n// changed comment\n return 42;\n}\n"),
    )]
    .into();
    let change = changes(base, head);
    let diff = rio_git::diff(&change, &[]).unwrap();
    let data = parse_lcov(b"SF:math.ts\nDA:3,0\nend_of_record\n", &context()).unwrap();
    assert!(
        diff_coverage(&change.head, &diff, &data, &[])
            .unwrap()
            .findings
            .is_empty()
    );
}

#[test]
fn static_typescript_configuration_is_read_without_evaluating_code() {
    let tree: Tree = [("vitest.config.ts".into(), entry("import {defineConfig} from 'vitest/config'; export default defineConfig({test:{coverage:{include:['src/**/*.ts'],exclude:['src/generated/**']}}});"))].into();
    let settings = typescript_coverage_settings(&tree, ".", "vitest", "vitest/2.1.9").unwrap();
    assert!(settings.static_known && settings.reports_unloaded);
    assert!(settings.excludes("src/generated/api.ts").unwrap());
    assert!(settings.excludes("scripts/tool.ts").unwrap());
    assert!(!settings.excludes("src/math.ts").unwrap());
    let tree: Tree = [(
        "jest.config.cjs".into(),
        entry("module.exports = {collectCoverageFrom:['src/**/*.ts']};"),
    )]
    .into();
    assert!(
        typescript_coverage_settings(&tree, ".", "jest", "29.7.0")
            .unwrap()
            .reports_unloaded
    );
    assert!(
        !typescript_coverage_settings(&Tree::new(), ".", "jest", "29.7.0")
            .unwrap()
            .reports_unloaded
    );
    let tree: Tree = [(
        ".coveragerc".into(),
        entry("[run]\nomit =\n    scripts/*\n    generated/*\n"),
    )]
    .into();
    let settings = python_coverage_settings(&tree, ".").unwrap();
    assert!(settings.excludes("scripts/release.py").unwrap());
    assert!(settings.excludes("generated/api.py").unwrap());
}

#[test]
fn coverage_from_a_consumer_covers_a_changed_shared_package() {
    let mut base = read_tree(&fixture("monorepo-sample"));
    let mut head = base.clone();
    head.insert(
        "packages/shared/src/util.ts".into(),
        entry("export function util() {\n return 42;\n}\n"),
    );
    base.remove("packages/shared/src/util.ts");
    let change = changes(base, head);
    let diff = rio_git::diff(&change, &[]).unwrap();
    let mut data = CoverageData::new();
    let shared = parse_lcov(
        b"SF:packages/shared/src/util.ts\nDA:2,0\nend_of_record\n",
        &context(),
    )
    .unwrap();
    let consumer = parse_lcov(
        b"SF:packages/shared/src/util.ts\nDA:2,1\nend_of_record\n",
        &context(),
    )
    .unwrap();
    merge_coverage(&mut data, shared);
    merge_coverage(&mut data, consumer);
    assert!(
        diff_coverage(&change.head, &diff, &data, &[])
            .unwrap()
            .findings
            .is_empty()
    );
}

async fn fixture_run(name: &str, tree: &Tree) -> Option<(CoverageRun, CoverageSettings)> {
    let source = fixture(name);
    let language = if name == "ts-sample" {
        "typescript"
    } else {
        "python"
    };
    let tool_name = if language == "typescript" {
        "vitest"
    } else {
        "coverage"
    };
    let resolver = ToolResolver::from_environment(source.clone());
    if !require_tool(
        resolver.locate(tool_name, ".", language).is_some(),
        tool_name,
    ) {
        return None;
    }
    let supervisor = ProcessSupervisor::default();
    let tool = resolver
        .resolve(
            tool_name,
            ".",
            language,
            &supervisor,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let settings = if language == "typescript" {
        typescript_coverage_settings(tree, ".", tool_name, &tool.version).unwrap()
    } else {
        python_coverage_settings(tree, ".").unwrap()
    };
    let temporary = tempfile::tempdir().unwrap();
    let cached = temporary.path().join("cache");
    std::fs::create_dir(&cached).unwrap();
    SafeTreeWriter::new(&cached)
        .unwrap()
        .write_tree(tree)
        .unwrap();
    let dependency = if language == "typescript" {
        "node_modules"
    } else {
        ".venv"
    };
    let disposable = ToolTree::create(
        &CachedTree {
            path: cached.clone(),
            reused: false,
            notes: Vec::new(),
        },
        temporary.path(),
        &[DependencyLink {
            path: dependency.into(),
            target: source.join(dependency),
        }],
    )
    .unwrap();
    let result = run_coverage(
        CoverageRequest {
            tool: &tool,
            settings: &settings,
            tool_tree: disposable.path(),
            worktree_root: Some(&source),
            timeout: Duration::from_secs(40),
            output_limit: 16 * 1024 * 1024,
        },
        &supervisor,
        CancellationToken::new(),
    )
    .await;
    assert!(
        result
            .processes
            .iter()
            .all(|process| process.cleanup_confirmed)
    );
    assert!(!cached.join(".rio-coverage").exists());
    assert!(!cached.join(dependency).exists());
    Some((result, settings))
}

#[tokio::test]
async fn installed_vitest_and_python_coverage_report_untested_functions_and_omit() {
    for (name, untested) in [
        ("ts-sample", "src/untested.ts"),
        ("py-sample", "src/sample/untested.py"),
    ] {
        let tree = read_tree(&fixture(name));
        if let Some((run, settings)) = fixture_run(name, &tree).await {
            assert!(
                matches!(run.outcome, CheckOutcome::Passed { .. }),
                "{:?}; {}",
                run.outcome,
                run.processes
                    .iter()
                    .map(|process| String::from_utf8_lossy(&process.stderr))
                    .collect::<Vec<_>>()
                    .join("\n")
            );
            assert!(!run.data.is_empty());
            let (tree, diff) = all_diff(tree);
            let findings = diff_coverage(&tree, &diff, &run.data, &[settings]).unwrap();
            assert!(
                findings
                    .findings
                    .iter()
                    .any(|finding| finding.location.path == untested),
                "{:#?}",
                findings.findings
            );
            assert!(
                !findings
                    .findings
                    .iter()
                    .any(|finding| finding.location.path == "src/types.ts"
                        || finding.location.path == "scripts/release.py")
            );
        }
    }
}

#[tokio::test]
async fn failing_tests_keep_coverage_and_no_tests_is_a_skip() {
    let mut tree = read_tree(&fixture("py-sample"));
    tree.insert(
        "tests/test_failure.py".into(),
        entry("def test_failure():\n    assert False\n"),
    );
    if let Some((run, _)) = fixture_run("py-sample", &tree).await {
        assert!(
            matches!(
                run.outcome,
                CheckOutcome::Failed {
                    reason: FailureReason::TestsFailed,
                    ..
                }
            ),
            "{:?}",
            run.outcome
        );
        assert!(!run.data.is_empty());
    }
    tree.retain(|path, _| !path.starts_with("tests/"));
    if let Some((run, _)) = fixture_run("py-sample", &tree).await {
        assert!(
            matches!(
                run.outcome,
                CheckOutcome::Skipped {
                    reason: SkipReason::NoTests,
                    ..
                }
            ),
            "{:?}",
            run.outcome
        );
    }
}

#[tokio::test]
async fn vitest_without_matching_tests_is_a_no_tests_skip() {
    let mut tree = read_tree(&fixture("ts-sample"));
    tree.retain(|path, _| !is_test_path(path));
    if let Some((run, _)) = fixture_run("ts-sample", &tree).await {
        assert!(
            matches!(
                run.outcome,
                CheckOutcome::Skipped {
                    reason: SkipReason::NoTests,
                    ..
                }
            ),
            "{:?}",
            run.outcome
        );
    }
}

#[tokio::test]
async fn python_parallel_coverage_data_is_combined_before_export() {
    let mut tree = read_tree(&fixture("py-sample"));
    let source = tree.get_mut("pyproject.toml").unwrap();
    source.content = String::from_utf8(source.content.clone())
        .unwrap()
        .replace(
            "[tool.coverage.run]",
            "[tool.coverage.run]\nparallel = true",
        )
        .into_bytes();
    if let Some((run, settings)) = fixture_run("py-sample", &tree).await {
        assert!(settings.python_parallel);
        assert!(
            matches!(run.outcome, CheckOutcome::Passed { .. }),
            "{:?}",
            run.outcome
        );
        assert!(!run.data.is_empty());
        assert_eq!(run.processes.len(), 3);
    }
}

#[test]
fn vitest_worker_and_coverage_flags_match_installed_major() {
    for version in ["1.1.0", "2.1.9", "3.2.4", "4.1.5"] {
        let tool = ResolvedTool {
            name: "vitest".into(),
            path: "/bin/vitest".into(),
            version: version.into(),
            version_hint: None,
        };
        let command =
            vitest_coverage_command(&tool, Path::new("/repo"), Path::new("/repo/coverage"));
        let args: Vec<_> = command
            .args
            .iter()
            .map(|arg| arg.to_str().unwrap())
            .collect();
        assert!(args.contains(&"--coverage.enabled"));
        assert_eq!(
            args.contains(&"--minWorkers=1"),
            version.starts_with(['2', '3'])
        );
        assert_eq!(args.contains(&"--maxWorkers=2"), !version.starts_with('1'));
        assert_eq!(args.contains(&"--coverage.all"), !version.starts_with('4'));
        assert_eq!(command.env.is_empty(), !version.starts_with('1'));
    }
}

#[test]
fn vitest_discovers_scripts_vite_configs_and_root_workspaces() {
    let mut tree: Tree = [
        (
            "package.json".into(),
            entry(r#"{"devDependencies":{"vitest":"^4"}}"#),
        ),
        (
            "packages/a/package.json".into(),
            entry(r#"{"scripts":{"test:lib":"vitest"}}"#),
        ),
        (
            "packages/a/vite.config.ts".into(),
            entry("export default {test:{name:'a'}}"),
        ),
    ]
    .into();
    assert_eq!(typescript_test_runner(&tree, "packages/a"), Some("vitest"));
    assert_eq!(
        vitest_execution(&tree, "packages/a"),
        (
            "packages/a".into(),
            vec!["--config".into(), "vite.config.ts".into()]
        )
    );
    tree.insert(
        "vitest.workspace.ts".into(),
        entry("export default ['vitest.unit.config.ts']"),
    );
    assert_eq!(
        vitest_execution(&tree, "packages/a"),
        (".".into(), vec!["packages/a".into()])
    );
    tree.remove("vitest.workspace.ts");
    tree.insert(
        "vitest.config.ts".into(),
        entry("export default {test:{projects:['packages/*']}}"),
    );
    let settings = typescript_coverage_settings(&tree, "packages/a", "vitest", "4.1.5").unwrap();
    assert_eq!(settings.invocation_root.as_deref(), Some("."));
    assert_eq!(
        settings.runner_args,
        ["--config", "vitest.config.ts", "packages/a"]
    );
    tree.remove("packages/a/vite.config.ts");
    tree.insert("packages/a/package.json".into(), entry("{}"));
    assert_eq!(typescript_test_runner(&tree, "packages/a"), Some("vitest"));
}

#[cfg(unix)]
#[tokio::test]
async fn vitest_workspace_coverage_runs_at_workspace_cwd_and_normalizes_lcov() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(root.path().join("packages/a")).unwrap();
    std::fs::write(
        root.path().join("vitest.unit.config.ts"),
        "export default {};",
    )
    .unwrap();
    let executable = root.path().join("vitest");
    std::fs::write(&executable, r#"#!/usr/bin/python3
import sys,pathlib
assert pathlib.Path('vitest.unit.config.ts').is_file(), 'workspace import resolved from wrong cwd'
assert 'packages/a' in sys.argv
assert '--minWorkers=1' not in sys.argv
output=next(arg.split('=',1)[1] for arg in sys.argv if arg.startswith('--coverage.reportsDirectory='))
pathlib.Path(output, 'lcov.info').write_text('SF:packages/a/index.ts\nDA:1,1\nend_of_record\n')
"#).unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    let tree: Tree = [
        (
            "vitest.workspace.ts".into(),
            entry("export default ['vitest.unit.config.ts']"),
        ),
        (
            "packages/a/index.ts".into(),
            entry("export const value = 1;"),
        ),
    ]
    .into();
    let settings = typescript_coverage_settings(&tree, "packages/a", "vitest", "4.1.5").unwrap();
    let tool = ResolvedTool {
        name: "vitest".into(),
        path: executable,
        version: "4.1.5".into(),
        version_hint: None,
    };
    let run = run_coverage(
        CoverageRequest {
            tool: &tool,
            settings: &settings,
            tool_tree: root.path(),
            worktree_root: None,
            timeout: Duration::from_secs(10),
            output_limit: 1024 * 1024,
        },
        &ProcessSupervisor::default(),
        CancellationToken::new(),
    )
    .await;
    assert!(
        matches!(run.outcome, CheckOutcome::Passed { .. }),
        "{:?}",
        run.outcome
    );
    assert!(run.data["packages/a/index.ts"].executed.contains(&1));
}

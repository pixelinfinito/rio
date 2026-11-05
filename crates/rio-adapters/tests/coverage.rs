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
    let result = diff_coverage(&Tree::new(), &tree, &diff, &CoverageData::new(), &[ts]).unwrap();
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
    let result = diff_coverage(&Tree::new(), &tree, &diff, &CoverageData::new(), &[py]).unwrap();
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
        diff_coverage(&change.base, &change.head, &diff, &data, &[])
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
        diff_coverage(&change.base, &change.head, &diff, &data, &[])
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
            let findings =
                diff_coverage(&Tree::new(), &tree, &diff, &run.data, &[settings]).unwrap();
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
fn hono_annotation_only_change_ignores_synthetic_zero_hit_counter() {
    let path = "deno_dist/helper/factory/index.ts";
    let base: Tree = [(
        path.into(),
        entry(include_str!(
            "fixtures/coverage-regressions/hono-type-only.base.ts"
        )),
    )]
    .into();
    let head: Tree = [(
        path.into(),
        entry(include_str!(
            "fixtures/coverage-regressions/hono-type-only.head.ts"
        )),
    )]
    .into();
    let change = changes(base, head);
    let diff = rio_git::diff(&change, &[]).unwrap();
    assert_eq!(diff.files[0].hunks[0].head.start, 2);
    let data = parse_lcov(
        include_bytes!("fixtures/coverage-regressions/hono-type-only.lcov"),
        &context(),
    )
    .unwrap();
    assert!(data[path].instrumented.contains(&2));
    assert!(!data[path].executed.contains(&2));
    assert!(
        diff_coverage(&change.base, &change.head, &diff, &data, &[])
            .unwrap()
            .findings
            .is_empty()
    );
}

#[test]
fn typescript_type_positions_are_erased_but_runtime_changes_remain() {
    for (before, after, expected) in [
        (
            "function f(value: string) { return value; }",
            "function f(value: number) { return value; }",
            0,
        ),
        (
            "function f<T>(value: T) { return value; }",
            "function f<T extends string>(value: T) { return value; }",
            0,
        ),
        (
            "export interface User { name: string }",
            "export interface User { name: number }",
            0,
        ),
        (
            "export type Id = string;",
            "export type Id = string | number;",
            0,
        ),
        (
            "import type { Id } from './old';",
            "import type { Id } from './new';",
            0,
        ),
        (
            "export type { Id } from './old';",
            "export type { Id } from './new';",
            0,
        ),
        ("", "export interface User { name: string }", 0),
        (
            "const value: string = oldValue;",
            "const value: number = newValue;",
            1,
        ),
        (
            "const value = {password: oldValue};",
            "const value = {password: newValue};",
            1,
        ),
        (
            "const value = a < b && c > d;",
            "const value = a < b && c > e;",
            1,
        ),
        (
            "const value: string = 'old';",
            "const value: string = 'new';",
            1,
        ),
        (
            "import type { Id } from './types';",
            "import { Id } from './types';",
            1,
        ),
        ("enum Value { One = 1 }", "enum Value { One = 2 }", 1),
        ("", "const value: number = compute();", 1),
        // Invalid syntax must not qualify for type erasure.
        ("const value: = oldValue;", "const value: = newValue;", 1),
    ] {
        let before = format!("{before}\n");
        let after = format!("{after}\n");
        let change = changes(
            [("value.ts".into(), entry(&before))].into(),
            [("value.ts".into(), entry(&after))].into(),
        );
        let diff = rio_git::diff(&change, &[]).unwrap();
        let data = parse_lcov(b"SF:value.ts\nDA:1,0\nend_of_record\n", &context()).unwrap();
        let findings = diff_coverage(&change.base, &change.head, &diff, &data, &[]).unwrap();
        assert_eq!(findings.findings.len(), expected, "{before} -> {after}");
    }
}

#[test]
fn diff_coverage_requires_reported_executable_lines_for_each_format() {
    for (path, source, bytes, python) in [
        (
            "math.ts",
            "export const first = 1;\nexport const second = compute();\n",
            "SF:math.ts\nDA:1,1\nend_of_record\n",
            false,
        ),
        (
            "math.py",
            "first = 1\nsecond = compute()\n",
            r#"{"files":{"math.py":{"executed_lines":[1],"missing_lines":[],"excluded_lines":[]}}}"#,
            true,
        ),
    ] {
        let (tree, diff) = all_diff([(path.into(), entry(source))].into());
        let data = if python {
            parse_python_coverage(bytes.as_bytes(), &context()).unwrap()
        } else {
            parse_lcov(bytes.as_bytes(), &context()).unwrap()
        };
        assert!(
            diff_coverage(&Tree::new(), &tree, &diff, &data, &[])
                .unwrap()
                .findings
                .is_empty()
        );
        // Report the new statement as executable with zero hits: it now warrants a finding.
        let mut uncovered = data;
        uncovered.get_mut(path).unwrap().instrumented.insert(2);
        let result = diff_coverage(&Tree::new(), &tree, &diff, &uncovered, &[]).unwrap();
        assert_eq!(result.findings.len(), 1);
        assert_eq!(result.findings[0].location.line_start, 2);
        // Even all-files settings cannot establish counters for an absent file.
        let settings = CoverageSettings {
            language: if python { "python" } else { "typescript" }.into(),
            root: ".".into(),
            static_known: true,
            reports_unloaded: true,
            ..Default::default()
        };
        let result = diff_coverage(
            &Tree::new(),
            &tree,
            &diff,
            &CoverageData::new(),
            &[settings],
        )
        .unwrap();
        assert!(result.findings.is_empty());
        assert_eq!(result.excluded[0].reason, "coverage_not_instrumented");
    }
}

#[test]
fn multiline_type_changes_do_not_hide_runtime_string_or_statement_changes() {
    for (before, after, expected) in [
        (
            "interface User {\nname: string;\n}",
            "interface User {\nname: string;\nid: number;\n}",
            0,
        ),
        ("type Id =\n string;", "type Id =\n string | number;", 0),
        (
            "const value: string = `first\nold\nlast`;",
            "const value: string = `first\nnew\nlast`;",
            1,
        ),
        (
            "function f(value: string) {\n return 'old';\n}",
            "function f(value: number) {\n return 'new';\n}",
            1,
        ),
    ] {
        let change = changes(
            [("value.ts".into(), entry(before))].into(),
            [("value.ts".into(), entry(after))].into(),
        );
        let diff = rio_git::diff(&change, &[]).unwrap();
        let data = parse_lcov(
            b"SF:value.ts\nDA:1,0\nDA:2,0\nDA:3,0\nDA:4,0\nend_of_record\n",
            &context(),
        )
        .unwrap();
        assert_eq!(
            diff_coverage(&change.base, &change.head, &diff, &data, &[])
                .unwrap()
                .findings
                .len(),
            expected,
            "{before} -> {after}"
        );
    }
}

#[cfg(unix)]
async fn recorded_runner(name: &str, script: &str) -> CoverageRun {
    use std::os::unix::fs::PermissionsExt;
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("runner");
    std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    let tool = ResolvedTool {
        name: name.into(),
        path,
        version: "2.1.9".into(),
        version_hint: None,
    };
    let settings = CoverageSettings {
        root: ".".into(),
        ..Default::default()
    };
    run_coverage(
        CoverageRequest {
            tool: &tool,
            settings: &settings,
            tool_tree: temporary.path(),
            worktree_root: None,
            timeout: Duration::from_secs(5),
            output_limit: 1024 * 1024,
        },
        &ProcessSupervisor::default(),
        CancellationToken::new(),
    )
    .await
}

#[cfg(unix)]
#[tokio::test]
async fn runner_startup_errors_include_first_nonempty_stderr_without_retention_claim() {
    for tool in ["vitest", "jest", "coverage"] {
        for code in [1, 2] {
            let run = recorded_runner(tool, &format!("printf '\\n  \\nUnknown option: --unsupported\\nsecond error line\\n' >&2\nexit {code}")).await;
            assert!(
                matches!(run.outcome, CheckOutcome::Failed { .. }),
                "{tool}: {:?}",
                run.outcome
            );
            assert!(run.data.is_empty());
            let hint = run.outcome.details().hint.as_deref().unwrap();
            assert!(
                hint.contains("Unknown option: --unsupported"),
                "{tool}: {hint}"
            );
            assert!(!hint.contains("second error line"), "{hint}");
            assert!(!hint.contains("retained"), "{hint}");
        }
    }
}

#[cfg(unix)]
#[tokio::test]
async fn runner_error_hints_are_redacted_and_empty_reports_are_not_usable() {
    let secret = "aB3dE5gH7jK9mN1pQ4sT6vW8xY0zR2";
    let script = format!(
        r#"cat > .rio-coverage/lcov.info <<'EOF'
SF:value.ts
end_of_record
EOF
cat >&2 <<'EOF'

Unknown option; token = '{secret}'
EOF
exit 1"#
    );
    let run = recorded_runner("vitest", &script).await;
    assert!(!run.data.is_empty());
    let hint = run.outcome.details().hint.as_deref().unwrap();
    assert!(hint.contains("Unknown option"));
    assert!(hint.contains("[REDACTED]"));
    assert!(!hint.contains(secret));
    assert!(!hint.contains("retained"));
    let run = recorded_runner("vitest", "exit 1").await;
    let hint = run.outcome.details().hint.as_deref().unwrap();
    assert!(hint.contains("without producing usable coverage"));
    assert!(!hint.contains("retained"));
}

#[cfg(unix)]
#[tokio::test]
async fn failed_runner_retains_partial_coverage_with_accurate_hint() {
    let run = recorded_runner(
        "vitest",
        r#"cat > .rio-coverage/lcov.info <<'EOF'
SF:value.ts
DA:1,1
DA:2,0
end_of_record
EOF
printf '3 failed\n'
exit 1"#,
    )
    .await;
    assert!(matches!(
        run.outcome,
        CheckOutcome::Failed {
            reason: FailureReason::TestsFailed,
            ..
        }
    ));
    assert_eq!(run.data["value.ts"].executed.len(), 1);
    let hint = run.outcome.details().hint.as_deref().unwrap();
    assert!(hint.starts_with("3 tests failed"), "{hint}");
    assert!(hint.contains("usable coverage from the incomplete run is retained"));
}

mod common;
use common::*;
use rio_adapters::*;
use rio_core::{CheckKind, CheckOutcome, FailureReason, SkipReason};
use rio_git::{CachedTree, DependencyLink, SafeTreeWriter, ToolTree, Tree};
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

#[test]
fn recorded_typescript_and_python_diagnostics_preserve_locations_and_rules() {
    let tsc = parse_tsc(
        include_bytes!("fixtures/diagnostics/tsc.stdout"),
        &context(),
    )
    .unwrap();
    assert!(
        tsc.iter()
            .any(|finding| finding.rule_id == "typecheck/tsc/TS2322"
                && finding.location.path == "src/existing.ts"
                && finding.location.line_start == 2
                && finding.location.column == Some(3))
    );
    let eslint = parse_eslint(
        include_bytes!("fixtures/diagnostics/eslint.stdout"),
        &context(),
    )
    .unwrap();
    assert_eq!(
        eslint[0].rule_id,
        "lint/eslint/@typescript-eslint/no-unused-vars"
    );
    assert_eq!(eslint[0].location.path, "src/lint.ts");
    let mypy = parse_mypy(
        include_bytes!("fixtures/diagnostics/mypy.stdout"),
        &context(),
    )
    .unwrap();
    assert_eq!(mypy[0].rule_id, "typecheck/mypy/return-value");
    assert_eq!(mypy[0].location.column, Some(12));
    let ruff = parse_ruff(
        include_bytes!("fixtures/diagnostics/ruff.stdout"),
        &context(),
    )
    .unwrap();
    assert_eq!(ruff[0].rule_id, "lint/ruff/F401");
    assert_eq!(ruff[0].location.path, "src/sample/lint.py");
    assert_eq!(ruff[0].location.line_start, 1);
}

#[test]
fn pyright_zero_based_coordinates_and_mypy_line_fallback_are_normalized() {
    let output = br#"{"generalDiagnostics":[{"file":"/recorded/repo/pkg/mod.py","severity":"error","message":"Type str is not assignable to int","rule":"reportReturnType","range":{"start":{"line":2,"character":4},"end":{"line":3,"character":0}}}]}"#;
    let parsed = parse_pyright(output, &context()).unwrap();
    assert_eq!(parsed[0].rule_id, "typecheck/pyright/reportReturnType");
    assert_eq!(parsed[0].location.line_start, 3);
    assert_eq!(parsed[0].location.line_end, 4);
    assert_eq!(parsed[0].location.column, Some(5));
    let output = b"pkg/mod.py:3:5: error: Incompatible return value type  [return-value]\npkg/mod.py:3: note: see function\nFound 1 error in 1 file (checked 1 source file)\n";
    let parsed = parse_mypy(output, &context()).unwrap();
    assert_eq!(parsed.len(), 1);
    assert_eq!(parsed[0].rule_id, "typecheck/mypy/return-value");
    assert_eq!(parsed[0].location.column, Some(5));
    assert!(mypy_supports_json("mypy 1.14.1 (compiled: yes)"));
    assert!(!mypy_supports_json("mypy 1.10.0"));
}

#[test]
fn malformed_output_and_outside_paths_are_never_silently_discarded() {
    assert!(
        parse_tsc(b"compiler stack trace", &context())
            .unwrap()
            .is_empty()
    );
    assert!(parse_tsc(b"../../outside.ts(1,1): error TS2322: invalid", &context()).is_err());
    assert!(parse_eslint(b"{}", &context()).is_err());
    assert!(parse_pyright(b"{}", &context()).is_err());
    assert!(parse_mypy(b"unexpected output", &context()).is_err());
    assert!(parse_ruff(b"null", &context()).is_err());
    let parsed = parse_tsc(b"src/a.ts(2,3): error TS2322: Type '1' is not assignable\n  Additional diagnostic detail\n", &context()).unwrap();
    assert!(parsed[0].message.contains("Additional diagnostic detail"));
}

#[test]
fn project_configuration_controls_lint_and_python_checker_preference() {
    let mut tree = Tree::new();
    for language in ["typescript", "python"] {
        assert!(matches!(
            diagnostic_config_skip(CheckKind::Lint, language, &tree, "."),
            Some(CheckOutcome::Skipped {
                reason: SkipReason::NoProjectConfig,
                ..
            })
        ));
    }
    tree.insert("pyproject.toml".into(), entry("[tool.mypy]\n[tool.ruff]"));
    tree.insert("package.json".into(), entry(r#"{"eslintConfig":{}}"#));
    assert_eq!(python_typechecker(&tree, ".", |_| true), Some("mypy"));
    assert!(diagnostic_config_skip(CheckKind::Lint, "python", &tree, ".").is_none());
    assert!(diagnostic_config_skip(CheckKind::Lint, "typescript", &tree, ".").is_none());
    tree.insert("packages/a/pyrightconfig.json".into(), entry("{}"));
    assert_eq!(
        python_typechecker(&tree, "packages/a", |_| true),
        Some("pyright")
    );
    assert_eq!(
        python_typechecker(&Tree::new(), ".", |name| name == "mypy"),
        Some("mypy")
    );
}

async fn fixture_diagnostic(
    name: &str,
    language: &str,
    tool: &str,
    target: &str,
) -> Option<CheckOutcome> {
    let source = fixture(name);
    let resolver = ToolResolver::from_environment(source.clone());
    if !require_tool(resolver.locate(tool, ".", language).is_some(), tool) {
        return None;
    }
    let tree = read_tree(&source);
    let temporary = tempfile::tempdir().unwrap();
    let cached_path = temporary.path().join("cache");
    std::fs::create_dir(&cached_path).unwrap();
    SafeTreeWriter::new(&cached_path)
        .unwrap()
        .write_tree(&tree)
        .unwrap();
    let dependency = if language == "typescript" {
        "node_modules"
    } else {
        ".venv"
    };
    let disposable = ToolTree::create(
        &CachedTree {
            path: cached_path.clone(),
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
    let supervisor = ProcessSupervisor::default();
    let tool = resolver
        .resolve(tool, ".", language, &supervisor, CancellationToken::new())
        .await
        .unwrap();
    #[cfg(unix)]
    let tool_root = {
        let alias = temporary.path().join("tool-alias");
        std::os::unix::fs::symlink(disposable.path(), &alias).unwrap();
        alias
    };
    #[cfg(not(unix))]
    let tool_root = disposable.path().to_path_buf();
    let mut command = diagnostic_command(&tool, &tree, &tool_root, ".", &[target.into()]).unwrap();
    command.timeout = Duration::from_secs(30);
    let result = supervisor.run(command, CancellationToken::new()).await;
    assert!(result.cleanup_confirmed);
    let context = DiagnosticContext {
        repository_root: &tool_root,
        project_root: ".",
        tool_version: &tool.version,
        worktree_root: Some(&source),
        sources: Some(&tree),
    };
    let adapter: &dyn Adapter = if language == "typescript" {
        &TypeScriptAdapter
    } else {
        &PythonAdapter
    };
    let parsed = adapter.parse_output(&tool.name, &result.stdout, &result.stderr, &context);
    let capability = if tool.name == "tsc" || tool.name == "mypy" {
        "typecheck"
    } else {
        "lint"
    };
    let contract = tool_contract(adapter.manifest().name.as_str(), capability, &tool.name).unwrap();
    let outcome = evaluate_exit(&result, &contract.exit_codes, parsed);
    assert!(
        matches!(outcome, CheckOutcome::Findings { .. }),
        "{outcome:?}; stderr={}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(!cached_path.join(dependency).exists());
    Some(outcome)
}

#[tokio::test]
async fn installed_fixture_tools_run_only_in_disposable_trees() {
    for (fixture, language, tool, target, rule) in [
        (
            "ts-sample",
            "typescript",
            "tsc",
            "src/existing.ts",
            "typecheck/tsc/TS2322",
        ),
        (
            "ts-sample",
            "typescript",
            "eslint",
            "src/lint.ts",
            "lint/eslint/@typescript-eslint/no-unused-vars",
        ),
        (
            "py-sample",
            "python",
            "mypy",
            "src/sample/existing.py",
            "typecheck/mypy/return-value",
        ),
        (
            "py-sample",
            "python",
            "ruff",
            "src/sample/lint.py",
            "lint/ruff/F401",
        ),
    ] {
        if let Some(outcome) = fixture_diagnostic(fixture, language, tool, target).await {
            assert!(
                outcome
                    .details()
                    .findings
                    .iter()
                    .any(|finding| finding.rule_id == rule),
                "{tool}: expected {rule}; got {outcome:?}"
            );
        }
    }
}

#[tokio::test]
async fn real_eslint_configuration_failure_is_an_outcome_without_findings() {
    let source = fixture("ts-sample");
    let resolver = ToolResolver::from_environment(source);
    if !require_tool(
        resolver.locate("eslint", ".", "typescript").is_some(),
        "eslint",
    ) {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    std::fs::write(
        root.path().join("eslint.config.mjs"),
        "throw new Error('invalid project configuration');",
    )
    .unwrap();
    std::fs::write(root.path().join("a.js"), "const a = 1;\n").unwrap();
    let supervisor = ProcessSupervisor::default();
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
    let command =
        diagnostic_command(&tool, &Tree::new(), root.path(), ".", &["a.js".into()]).unwrap();
    let result = supervisor.run(command, CancellationToken::new()).await;
    let contract = tool_contract("rio/adapter-typescript", "lint", "eslint").unwrap();
    let outcome = evaluate_exit(
        &result,
        &contract.exit_codes,
        parse_eslint(&result.stdout, &context()),
    );
    assert!(
        matches!(
            outcome,
            CheckOutcome::Failed {
                reason: FailureReason::ToolConfigError,
                ..
            }
        ),
        "{outcome:?}"
    );
    assert!(outcome.details().findings.is_empty());
}

#[cfg(unix)]
#[test]
fn canonical_tool_paths_are_mapped_through_a_repository_directory_alias() {
    let parent = tempfile::tempdir().unwrap();
    let real = parent.path().join("real");
    let alias = parent.path().join("alias");
    std::fs::create_dir(&real).unwrap();
    std::os::unix::fs::symlink(&real, &alias).unwrap();
    let context = DiagnosticContext {
        repository_root: &alias,
        project_root: ".",
        tool_version: "test",
        worktree_root: None,
        sources: None,
    };
    let output = serde_json::json!([{
        "filename": real.canonicalize().unwrap().join("source.py"),
        "code": "F821", "message": "Undefined name", "location": {"row": 1, "column": 1},
        "end_location": {"row": 1, "column": 2}
    }]);
    let findings = parse_ruff(&serde_json::to_vec(&output).unwrap(), &context).unwrap();
    assert_eq!(findings[0].location.path, "source.py");
}

#[test]
fn tsc_trace_and_global_errors_preserve_valid_diagnostics() {
    let parsed = parse_tsc(
        include_bytes!("fixtures/diagnostics/tsc-trace-global.stdout"),
        &context(),
    )
    .unwrap();
    assert_eq!(parsed.len(), 2);
    assert_eq!(parsed[0].rule_id, "typecheck/tsc/TS2322");
    assert_eq!(parsed[1].rule_id, "typecheck/tsc/TS6504");
    assert_eq!(parsed[1].location.path, "tsconfig.json");
    let parsed = parse_tsc(b"error TS5112: tsconfig.json is present but will not be loaded if files are specified on commandline.", &context()).unwrap();
    assert_eq!(parsed[0].rule_id, "typecheck/tsc/TS5112");
}

#[test]
fn typescript_uses_ancestor_and_referenced_configs_for_ts5_and_ts6() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(root.path().join("packages/a")).unwrap();
    let mut tree: Tree = [
        (
            "tsconfig.json".into(),
            entry(r#"{compilerOptions:{strict:true,target:'esnext'},include:['packages/**/*']}"#),
        ),
        (
            "packages/a/index.ts".into(),
            entry("export const n: number = 'bad'"),
        ),
    ]
    .into();
    for version in ["Version 5.9.3", "Version 6.0.3"] {
        let tool = ResolvedTool {
            name: "tsc".into(),
            path: "tsc".into(),
            version: version.into(),
            version_hint: None,
        };
        let command = diagnostic_command(&tool, &tree, root.path(), "packages/a", &[]).unwrap();
        assert_eq!(command.args.len(), 5);
        assert_eq!(command.args[3], "-p");
        assert!(Path::new(&command.args[4]).ends_with("tsconfig.json"));
        assert!(
            !command
                .args
                .iter()
                .any(|arg| arg.to_string_lossy().ends_with("index.ts"))
        );
    }
    tree.insert(
        "tsconfig.json".into(),
        entry(r#"{files:[],references:[{path:'./packages/a/tsconfig.build.json'}]}"#),
    );
    tree.insert(
        "packages/a/tsconfig.build.json".into(),
        entry(r#"{extends:'../../tsconfig.base.json',include:['*.ts']}"#),
    );
    assert_eq!(
        typescript_config(&tree, "packages/a"),
        Some("packages/a/tsconfig.build.json".into())
    );
}

#[test]
fn typescript_file_fallback_writes_disposable_config_with_inherited_options() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(root.path().join("pkg")).unwrap();
    let mut tree: Tree = [("pkg/index.ts".into(), entry("const x = 1"))].into();
    let tool = ResolvedTool {
        name: "tsc".into(),
        path: "tsc".into(),
        version: "Version 6.0.3".into(),
        version_hint: None,
    };
    for inherited in [false, true] {
        if inherited {
            tree.insert(
                "tsconfig.json".into(),
                entry("{files:[],compilerOptions:{strict:true}}"),
            );
        }
        let command = diagnostic_command(&tool, &tree, root.path(), "pkg", &[]).unwrap();
        let path = Path::new(&command.args[4]);
        assert!(
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(".rio-tsconfig-")
        );
        let value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(value["files"].as_array().unwrap().len(), 1);
        assert_eq!(value.get("extends").is_some(), inherited);
        assert!(
            value["files"][0]
                .as_str()
                .unwrap()
                .ends_with("pkg/index.ts")
        );
    }
}

#[test]
fn biome_1_and_2_json_warnings_become_lint_findings() {
    for output in [
        include_bytes!("fixtures/diagnostics/biome1.stdout").as_slice(),
        include_bytes!("fixtures/diagnostics/biome2.stdout").as_slice(),
    ] {
        let findings = parse_biome(output, &context()).unwrap();
        assert_eq!(findings.len(), 1);
        assert_eq!(
            findings[0].rule_id,
            "lint/biome/correctness/noUnusedVariables"
        );
        assert_eq!(findings[0].location.path, "src/biome.ts");
        assert_eq!(findings[0].location.line_start, 2);
        assert_eq!(findings[0].location.column, Some(9));
        assert_eq!(findings[0].severity, rio_core::Severity::Warning);
    }
    assert!(parse_biome(b"{}", &context()).is_err());
    let tree: Tree = [("biome.jsonc".into(), entry("{}"))].into();
    assert_eq!(typescript_linter(&tree, "pkg"), "biome");
    assert!(diagnostic_config_skip(CheckKind::Lint, "typescript", &tree, "pkg").is_none());
}

#[test]
fn biome_ignored_targets_skip_only_on_a_cleaned_up_no_files_exit() {
    let empty = br#"{"summary":{"changed":0,"unchanged":0,"errors":0,"warnings":0},"diagnostics":[],"command":"lint"}"#;
    let diagnostic = br#"{"summary":{"changed":0,"unchanged":0},"diagnostics":[{"severity":"error","category":"internalError/io","description":"No files were processed in the specified paths."}]}"#;
    let message = b"internalError/io\nNo files were processed in the specified paths.";
    let spec = tool_contract("rio/adapter-typescript", "lint", "biome").unwrap();
    for (stdout, stderr, code, cleaned_up, skip) in [
        (empty.as_slice(), message.as_slice(), 1, true, true),
        (b"".as_slice(), message.as_slice(), 1, true, true),
        (diagnostic.as_slice(), b"".as_slice(), 1, true, true),
        (empty.as_slice(), b"".as_slice(), 1, true, false),
        (
            b"malformed JSON".as_slice(),
            message.as_slice(),
            1,
            true,
            false,
        ),
        (empty.as_slice(), message.as_slice(), 2, true, false),
        (empty.as_slice(), message.as_slice(), 1, false, false),
        (
            include_bytes!("fixtures/diagnostics/biome1.stdout").as_slice(),
            message.as_slice(),
            1,
            true,
            false,
        ),
    ] {
        let result = ProcessResult {
            termination: Termination::Exited { code: Some(code) },
            stdout: stdout.into(),
            stderr: stderr.into(),
            raw_stdout: Vec::new(),
            raw_stderr: Vec::new(),
            wall_time: Duration::ZERO,
            cleanup_confirmed: cleaned_up,
            survivors: Vec::new(),
        };
        let parsed = TypeScriptAdapter.parse_output("biome", stdout, stderr, &context());
        let outcome = evaluate_exit(&result, &spec.exit_codes, parsed);
        assert_eq!(
            matches!(outcome, CheckOutcome::Skipped { .. }),
            skip,
            "{outcome:?}"
        );
        if skip {
            assert!(
                outcome
                    .details()
                    .hint
                    .as_deref()
                    .unwrap()
                    .contains("No files were processed")
            );
        } else {
            assert!(!matches!(outcome, CheckOutcome::Passed { .. }));
        }
    }
}

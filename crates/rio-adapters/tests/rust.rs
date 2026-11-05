mod common;
use common::*;
use rio_adapters::*;
use rio_core::*;
use rio_git::{SafeTreeWriter, diff as git_diff};
use std::{fs, path::Path};
use tokio_util::sync::CancellationToken;

#[cfg(unix)]
#[tokio::test]
async fn cargo_discovery_supports_path_installations_and_preserves_rustup_selection() {
    use std::os::unix::fs::PermissionsExt;
    for mode in [
        "path",
        "selected",
        "missing-toolchain",
        "failed-version",
        "missing",
    ] {
        let temp = tempfile::tempdir().unwrap();
        let bin = temp.path().join("bin");
        fs::create_dir(&bin).unwrap();
        let executable = |name: &str, body: &str| {
            let path = bin.join(name);
            fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
            path
        };
        if mode != "missing" {
            executable(
                "cargo",
                if mode == "failed-version" {
                    "exit 2"
                } else {
                    "[ \"$1\" = --version ] && [ \"$RUSTUP_AUTO_INSTALL\" = 0 ] && [ \"$RUSTUP_TOOLCHAIN\" = installed ] || exit 90\necho cargo-path"
                },
            );
        }
        if mode == "selected" {
            executable(
                "selected-cargo",
                "[ \"$1\" = --version ] && [ \"$RUSTUP_TOOLCHAIN\" = installed ] || exit 91\necho cargo-selected",
            );
            executable(
                "rustup",
                "[ \"$*\" = 'which cargo --toolchain installed' ] && [ \"$RUSTUP_AUTO_INSTALL\" = 0 ] || exit 92\nprintf '%s/selected-cargo\\n' \"${0%/*}\"",
            );
        } else if mode == "missing-toolchain" {
            executable("rustup", "exit 1");
        }
        let resolver = ToolResolver {
            repository_root: temp.path().into(),
            search_path: vec![bin.clone()],
            virtual_env: None,
        };
        let tree = rio_git::Tree::from([(
            "rust-toolchain.toml".into(),
            entry("[toolchain]\nchannel = 'installed'\n"),
        )]);
        let tool = rust_cargo(
            &resolver,
            &tree,
            ".",
            &ProcessSupervisor::default(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        match mode {
            "path" | "selected" => {
                let tool = tool.unwrap_or_else(|| panic!("Cargo was not found: {mode}"));
                let selected = mode == "selected";
                assert_eq!(
                    tool.path,
                    bin.join(if selected { "selected-cargo" } else { "cargo" })
                );
                assert_eq!(
                    tool.version,
                    if selected {
                        "cargo-selected"
                    } else {
                        "cargo-path"
                    }
                );
            }
            _ => assert!(tool.is_none(), "{mode}: {tool:?}"),
        }
    }
}

#[test]
fn rust_workspace_roots_schedule_members_consumers_and_workspace_changes() {
    let base = read_tree(&fixture("rs-sample"));
    let mut head = base.clone();
    head.get_mut("core/src/lib.rs")
        .unwrap()
        .content
        .extend_from_slice(b"\npub fn added() {}\n");
    let diff = git_diff(&changes(base.clone(), head.clone()), &[]).unwrap();
    let layout = detect_repository(&head, &diff).unwrap();
    let scheduled = layout.schedule(&diff);
    assert_eq!(
        scheduled
            .iter()
            .map(|root| (root.project.path.as_str(), root.scheduled_as))
            .collect::<Vec<_>>(),
        [
            ("cli", ScheduledAs::Dependent),
            ("core", ScheduledAs::Changed)
        ]
    );
    assert_eq!(
        rust_selection(&head, "core").unwrap(),
        ["-p", "sample-core"]
    );
    assert_eq!(rust_selection(&head, ".").unwrap(), ["--workspace"]);
    assert_eq!(
        scheduled[0].checks(),
        [CheckKind::Typecheck, CheckKind::Coverage]
    );
    let mut head = base.clone();
    head.get_mut("rust-toolchain.toml")
        .unwrap()
        .content
        .extend_from_slice(b"# changed\n");
    let scheduled = detect_repository(
        &head,
        &git_diff(&changes(base.clone(), head.clone()), &[]).unwrap(),
    )
    .unwrap()
    .schedule(&git_diff(&changes(base.clone(), head.clone()), &[]).unwrap());
    assert_eq!(scheduled.len(), 1);
    assert_eq!(scheduled[0].project.path, ".");
}

#[test]
fn cargo_lock_v3_v4_and_manifest_flags_preserve_resolution_and_auditability() {
    let mut tree = read_tree(&fixture("rs-sample"));
    let lock = std::str::from_utf8(&tree["Cargo.lock"].content).unwrap();
    for version in [3, 4] {
        let mut graph = parse_lockfile(
            "Cargo.lock",
            &lock.replace("version = 4", &format!("version = {version}")),
        )
        .unwrap();
        assert!(graph.flattened().contains(&(
            Ecosystem::CratesIo,
            "chrono".into(),
            "0.4.19".into()
        )));
        assert!(
            graph
                .notes
                .iter()
                .any(|note| note.contains("sample-core") && note.contains("path_source"))
        );
        annotate_cargo_manifests(&mut graph, &tree, ".").unwrap();
        assert!(graph.importers.contains_key("core"));
        assert!(
            graph
                .nodes
                .values()
                .find(|node| node.name == "sample-cli")
                .unwrap()
                .dependencies
                .iter()
                .any(|edge| graph.nodes[&edge.target].name == "sample-core")
        );
    }
    let manifest = String::from_utf8(tree["core/Cargo.toml"].content.clone())
        .unwrap()
        .replace(
            "default-features = false",
            "default-features = false, optional = true",
        );
    tree.insert(
        "core/Cargo.toml".into(),
        entry(&(manifest + "\n[features]\nclock = [\"dep:chrono\"]\n")),
    );
    let lock = governing_lockfile(&tree, "core", Some("."), Ecosystem::CratesIo)
        .unwrap()
        .unwrap();
    assert!(
        lock.graph
            .nodes
            .values()
            .find(|node| node.name == "chrono")
            .unwrap()
            .flags
            .optional
    );
    let git = "version = 3\n[[package]]\nname = 'git-dep'\nversion = '1.0.0'\nsource = 'git+https://example.invalid/repo#abc'\n";
    let graph = parse_lockfile("Cargo.lock", git).unwrap();
    assert!(graph.flattened().is_empty());
    assert!(graph.notes[0].contains("git_source"));
    assert!(parse_lockfile("Cargo.lock", "[[package]]\nname = 'broken'\n").is_err());
}

#[test]
fn changed_member_closure_disables_only_baseline_and_names_the_changed_crate() {
    let base = read_tree(&fixture("rs-sample"));
    let mut head = base.clone();
    head.insert(
        "Cargo.lock".into(),
        entry(
            &String::from_utf8(base["Cargo.lock"].content.clone())
                .unwrap()
                .replace("0.4.19", "0.4.20"),
        ),
    );
    let locks = |tree: &rio_git::Tree| {
        governing_lockfile(tree, "core", Some("."), Ecosystem::CratesIo).unwrap()
    };
    let old = locks(&base);
    let new = locks(&head);
    let (head_state, base_state) =
        cargo_compatibility(new.as_ref(), old.as_ref(), true, "1.99.1", false);
    assert!(head_state.can_run());
    assert!(matches!(base_state, Compatibility::Mismatch { .. }));
    assert!(base_state.hint().unwrap().contains("chrono"));
    let mut unrelated = base.clone();
    unrelated.get_mut("Cargo.lock").unwrap().content.extend_from_slice(b"\n[[package]]\nname = 'unrelated'\nversion = '2.0.0'\nsource = 'registry+https://github.com/rust-lang/crates.io-index'\n");
    let new = locks(&unrelated);
    assert!(
        cargo_compatibility(new.as_ref(), old.as_ref(), true, "1.99.1", false)
            .1
            .can_classify_baseline()
    );
    assert!(
        !cargo_compatibility(new.as_ref(), old.as_ref(), false, "missing", false)
            .0
            .can_run()
    );
    assert!(matches!(
        cargo_compatibility(None, None, true, "default", true).0,
        Compatibility::Trusted { .. }
    ));
}

#[test]
fn rust_syntax_tracks_impls_macros_imports_and_type_only_files() {
    let tree = read_tree(&fixture("rs-sample"));
    let table = analyze_source("core/src/lib.rs", &tree["core/src/lib.rs"].content).unwrap();
    assert!(table.symbols.iter().any(
        |symbol| symbol.symbol_path == "lib.Counter.value" && symbol.kind == SymbolKind::Method
    ));
    assert!(
        table
            .symbols
            .iter()
            .any(|symbol| symbol.symbol_path == "lib.tests.answer_is_42"
                && symbol.kind == SymbolKind::Test)
    );
    assert!(
        table
            .identifiers
            .iter()
            .any(|identifier| identifier.name == "assert_eq" && identifier.call)
    );
    let types = analyze_source("core/src/types.rs", &tree["core/src/types.rs"].content).unwrap();
    assert!(types.executable_lines.is_empty(), "{types:?}");
    let macro_only = analyze_source("main.rs", b"fn main() { println!(\"hello\"); }\n").unwrap();
    assert!(macro_only.executable_lines.contains(&1));
    insta::assert_yaml_snapshot!("rust_symbols", table.symbols);
}

#[tokio::test]
async fn rust_metadata_uses_selected_source_and_discovers_member_dependencies() {
    let source = fixture("rs-sample");
    let tree = read_tree(&source);
    let supervisor = ProcessSupervisor::default();
    let cargo = rust_cargo(
        &ToolResolver::from_environment(source),
        &tree,
        ".",
        &supervisor,
        CancellationToken::new(),
    )
    .await
    .unwrap();
    if !require_tool(cargo.is_some(), "cargo for Rust fixture") {
        return;
    }
    let metadata = rust_metadata(
        &tree,
        ".",
        cargo.as_ref().unwrap(),
        &supervisor,
        CancellationToken::new(),
    )
    .await
    .unwrap();
    let mut layout = RepositoryLayout::default();
    apply_rust_metadata(&mut layout, &metadata);
    assert!(layout.dependencies["cli"].contains("core"));
    assert!(
        layout
            .roots
            .iter()
            .all(|root| !Path::new(&root.path).is_absolute())
    );
}

#[tokio::test]
async fn real_rust_diagnostics_parse_compile_clippy_format_and_internal_errors() {
    let tree = read_tree(&fixture("rs-sample"));
    let supervisor = ProcessSupervisor::default();
    let cargo = rust_cargo(
        &ToolResolver::from_environment(fixture("rs-sample")),
        &tree,
        ".",
        &supervisor,
        CancellationToken::new(),
    )
    .await
    .unwrap();
    if !require_tool(cargo.is_some(), "cargo") {
        return;
    }
    let cargo = cargo.unwrap();
    let temp = tempfile::tempdir().unwrap();
    SafeTreeWriter::new(temp.path())
        .unwrap()
        .write_tree(&tree)
        .unwrap();
    let context = DiagnosticContext {
        repository_root: temp.path(),
        project_root: ".",
        tool_version: &cargo.version,
        worktree_root: None,
        sources: Some(&tree),
    };
    let clippy = rust_subcommand(
        &cargo,
        "cargo-clippy",
        &tree,
        "core",
        &supervisor,
        CancellationToken::new(),
    )
    .await
    .unwrap();
    if !require_tool(clippy.is_some(), "clippy") {
        return;
    }
    let result = supervisor
        .run(
            rust_diagnostic_command(&clippy.unwrap(), &tree, temp.path(), "core", false).unwrap(),
            CancellationToken::new(),
        )
        .await;
    let parsed = parse_cargo(&result.stdout, &context).unwrap();
    assert!(
        parsed
            .findings
            .iter()
            .any(|finding| finding.rule_id.starts_with("lint/clippy/")),
        "{}",
        String::from_utf8_lossy(&result.stdout)
    );
    fs::write(
        temp.path().join("core/src/lib.rs"),
        [
            tree["core/src/lib.rs"].content.as_slice(),
            tree["cases/head-errors.rs"].content.as_slice(),
            tree["cases/format.rs"].content.as_slice(),
        ]
        .concat(),
    )
    .unwrap();
    let result = supervisor
        .run(
            rust_diagnostic_command(&cargo, &tree, temp.path(), "core", false).unwrap(),
            CancellationToken::new(),
        )
        .await;
    let parsed = parse_cargo(&result.stdout, &context).unwrap();
    assert!(
        parsed
            .findings
            .iter()
            .any(|finding| finding.rule_id == "typecheck/rustc/E0308"
                && finding.location.path == "core/src/lib.rs")
    );
    assert!(matches!(
        evaluate_cargo_exit(&result, CheckKind::Typecheck, Ok(Vec::new())),
        CheckOutcome::Failed {
            reason: FailureReason::ToolCrashed,
            ..
        }
    ));
    let fmt = rust_subcommand(
        &cargo,
        "cargo-fmt",
        &tree,
        "core",
        &supervisor,
        CancellationToken::new(),
    )
    .await
    .unwrap();
    if !require_tool(fmt.is_some(), "rustfmt") {
        return;
    }
    let result = supervisor
        .run(
            rust_diagnostic_command(&fmt.unwrap(), &tree, temp.path(), "core", false).unwrap(),
            CancellationToken::new(),
        )
        .await;
    assert!(
        parse_rustfmt(&result.stdout, &context)
            .unwrap()
            .iter()
            .any(|finding| finding.rule_id == "lint/rustfmt/format")
    );
}

#[tokio::test]
async fn real_rust_coverage_keeps_failures_and_distinguishes_zero_tests() {
    let mut tree = read_tree(&fixture("rs-sample"));
    let configured_target = tempfile::tempdir().unwrap();
    tree.insert(
        ".cargo/config.toml".into(),
        entry(&format!(
            "[build]\ntarget-dir = {}\nbuild-dir = {}\n",
            serde_json::to_string(&configured_target.path().join("shared-target")).unwrap(),
            serde_json::to_string(&configured_target.path().join("shared-build")).unwrap()
        )),
    );
    let supervisor = ProcessSupervisor::default();
    let cargo = rust_cargo(
        &ToolResolver::from_environment(fixture("rs-sample")),
        &tree,
        ".",
        &supervisor,
        CancellationToken::new(),
    )
    .await
    .unwrap();
    if !require_tool(cargo.is_some(), "cargo") {
        return;
    }
    let tool = rust_subcommand(
        &cargo.unwrap(),
        "cargo-llvm-cov",
        &tree,
        ".",
        &supervisor,
        CancellationToken::new(),
    )
    .await
    .unwrap();
    if !require_tool(tool.is_some(), "cargo-llvm-cov") {
        return;
    }
    let tool = tool.unwrap();
    let base = tree.clone();
    let changed = String::from_utf8(tree["core/src/lib.rs"].content.clone())
        .unwrap()
        .replace("value * 2", "value * 3");
    tree.insert("core/src/lib.rs".into(), entry(&changed));
    for case in ["passing", "failing", "no-tests"] {
        let temp = tempfile::tempdir().unwrap();
        if case == "failing" {
            tree.get_mut("core/src/lib.rs")
                .unwrap()
                .content
                .extend_from_slice(b"\n#[test] fn failure() { assert!(false); }\n");
        }
        if case == "no-tests" {
            let text = String::from_utf8(tree["core/src/lib.rs"].content.clone()).unwrap();
            tree.insert(
                "core/src/lib.rs".into(),
                entry(text.split("#[cfg(test)]").next().unwrap()),
            );
        }
        SafeTreeWriter::new(temp.path())
            .unwrap()
            .write_tree(&tree)
            .unwrap();
        let settings = rust_coverage_settings(&tree, "core").unwrap();
        let request = || CoverageRequest {
            tool: &tool,
            settings: &settings,
            tool_tree: temp.path(),
            worktree_root: None,
            timeout: std::time::Duration::from_secs(90),
            output_limit: 4 * 1024 * 1024,
        };
        let run = run_coverage(request(), &supervisor, CancellationToken::new()).await;
        // Project configuration must not send cleanup/profile writes outside
        // the output directory protected by Rio's coverage lock.
        assert!(!configured_target.path().join("shared-target").exists());
        assert!(!configured_target.path().join("shared-build").exists());
        match case {
            "passing" => {
                let diff = git_diff(&changes(base.clone(), tree.clone()), &[]).unwrap();
                let coverage = diff_coverage(
                    &base,
                    &tree,
                    &diff,
                    &run.data,
                    std::slice::from_ref(&settings),
                )
                .unwrap();
                assert_eq!(coverage.findings.len(), 1, "{:?}", coverage.findings);
                assert_eq!(coverage.findings[0].location.symbol_path, "lib.untested");
                assert_eq!(coverage.findings[0].location.line_start, 17);
                assert_eq!(coverage.findings[0].location.line_end, 17);
                assert!(
                    matches!(run.outcome, CheckOutcome::Passed { .. }),
                    "{:?}",
                    run.outcome
                );
                assert!(
                    run.data["core/src/lib.rs"]
                        .instrumented
                        .difference(&run.data["core/src/lib.rs"].executed)
                        .next()
                        .is_some()
                );
                let repeated = run_coverage(request(), &supervisor, CancellationToken::new()).await;
                assert!(
                    matches!(repeated.outcome, CheckOutcome::Passed { .. }),
                    "{:?}",
                    repeated.outcome
                );
            }
            "failing" => {
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
            _ => assert!(
                matches!(
                    run.outcome,
                    CheckOutcome::Skipped {
                        reason: SkipReason::NoTests,
                        ..
                    }
                ),
                "{:?}",
                run.outcome
            ),
        }
    }
}

#[test]
fn recorded_cargo_and_rustfmt_outputs_keep_diagnostics_and_disambiguate_101() {
    let tree = read_tree(&fixture("rs-sample"));
    let context = DiagnosticContext {
        repository_root: Path::new("/recorded/workspace"),
        project_root: ".",
        tool_version: "1.99.1",
        worktree_root: None,
        sources: Some(&tree),
    };
    let parsed = parse_cargo(
        include_bytes!("fixtures/diagnostics/cargo-check.stdout"),
        &context,
    )
    .unwrap();
    assert_eq!(
        parsed
            .findings
            .iter()
            .filter(|f| f.rule_id == "typecheck/rustc/E0308")
            .count(),
        4
    );
    assert!(
        parsed
            .findings
            .iter()
            .all(|f| f.location.path == "core/src/lib.rs" && f.severity == Severity::Error)
    );
    let clippy = parse_cargo(
        include_bytes!("fixtures/diagnostics/cargo-clippy.stdout"),
        &context,
    )
    .unwrap();
    assert!(
        clippy
            .findings
            .iter()
            .any(|f| f.rule_id == "lint/clippy/needless_return")
    );
    let fmt = parse_rustfmt(
        include_bytes!("fixtures/diagnostics/cargo-fmt.stdout"),
        &context,
    )
    .unwrap();
    assert_eq!(fmt.len(), 1);
    assert_eq!(fmt[0].rule_id, "lint/rustfmt/format");
    let outside = include_str!("fixtures/diagnostics/cargo-check.stdout")
        .replace("core/src/lib.rs", "/outside/dependency.rs");
    let dropped = parse_cargo(outside.as_bytes(), &context).unwrap();
    assert!(dropped.findings.is_empty() && dropped.outside_repository > 0);
    let internal = ProcessResult {
        termination: Termination::Exited { code: Some(101) },
        stdout: include_bytes!("fixtures/diagnostics/cargo-internal.stdout").to_vec(),
        stderr: include_bytes!("fixtures/diagnostics/cargo-internal.stderr").to_vec(),
        raw_stdout: Vec::new(),
        raw_stderr: Vec::new(),
        wall_time: Default::default(),
        cleanup_confirmed: true,
        survivors: Vec::new(),
    };
    assert!(matches!(
        evaluate_cargo_exit(
            &internal,
            CheckKind::Typecheck,
            parse_cargo(&internal.stdout, &context).map(|p| p.findings)
        ),
        CheckOutcome::Failed {
            reason: FailureReason::ToolCrashed,
            ..
        }
    ));
    assert!(matches!(
        evaluate_cargo_exit(&internal, CheckKind::Typecheck, Ok(parsed.findings)),
        CheckOutcome::Findings { .. }
    ));
}

#[test]
fn rust_type_only_files_do_not_produce_diff_coverage_findings() {
    let base = read_tree(&fixture("rs-sample"));
    let mut head = base.clone();
    head.get_mut("core/src/types.rs")
        .unwrap()
        .content
        .extend_from_slice(b"\npub enum State { Ready, Waiting }\n");
    let diff = git_diff(&changes(base.clone(), head.clone()), &[]).unwrap();
    let result = diff_coverage(
        &base,
        &head,
        &diff,
        &CoverageData::new(),
        &[rust_coverage_settings(&head, "core").unwrap()],
    )
    .unwrap();
    assert!(result.findings.is_empty() && result.excluded.is_empty());
}

#[test]
fn inherited_cargo_aliases_and_dev_dependencies_annotate_resolved_edges() {
    let mut tree = read_tree(&fixture("rs-sample"));
    tree.get_mut("Cargo.toml").unwrap().content.extend_from_slice(b"\n[workspace.dependencies]\nclock = { package = 'chrono', version = '=0.4.19', default-features = false }\n");
    tree.insert("core/Cargo.toml".into(), entry("[package]\nname = 'sample-core'\nversion = '0.1.0'\n[dependencies]\nclock = { workspace = true, optional = true }\n[features]\nclock = ['dep:clock']\n"));
    let lock = governing_lockfile(&tree, "core", Some("."), Ecosystem::CratesIo)
        .unwrap()
        .unwrap();
    let core = lock
        .graph
        .nodes
        .values()
        .find(|node| node.name == "sample-core")
        .unwrap();
    let edge = core
        .dependencies
        .iter()
        .find(|edge| edge.name == "chrono")
        .unwrap();
    assert!(!edge.dev && edge.optional);
    tree.get_mut("cli/Cargo.toml")
        .unwrap()
        .content
        .extend_from_slice(b"\n[dev-dependencies]\nclock = { workspace = true }\n");
    // Add the edge Cargo would resolve for this manifest.
    let lock_text = String::from_utf8(tree["Cargo.lock"].content.clone())
        .unwrap()
        .replace(" \"sample-core\",", " \"sample-core\",\n \"chrono\",");
    tree.insert("Cargo.lock".into(), entry(&lock_text));
    let lock = governing_lockfile(&tree, "cli", Some("."), Ecosystem::CratesIo)
        .unwrap()
        .unwrap();
    let cli = lock
        .graph
        .nodes
        .values()
        .find(|node| node.name == "sample-cli")
        .unwrap();
    assert!(
        cli.dependencies
            .iter()
            .any(|edge| edge.name == "chrono" && edge.dev)
    );
}

#[test]
fn root_package_as_a_dependent_does_not_schedule_the_whole_workspace() {
    let mut base = read_tree(&fixture("rs-sample"));
    base.get_mut("Cargo.toml").unwrap().content.extend_from_slice(b"\n[package]\nname = 'root-consumer'\nversion = '0.1.0'\n[dependencies]\nsample-core = { path = 'core' }\n");
    base.insert(
        "src/lib.rs".into(),
        entry("pub fn root() { sample_core::answer(); }\n"),
    );
    let mut head = base.clone();
    head.get_mut("core/src/lib.rs")
        .unwrap()
        .content
        .extend_from_slice(b"\npub fn changed() {}\n");
    let diff = git_diff(&changes(base.clone(), head.clone()), &[]).unwrap();
    let scheduled = detect_repository(&head, &diff).unwrap().schedule(&diff);
    assert_eq!(scheduled.len(), 3);
    let root = scheduled
        .iter()
        .find(|root| root.project.path == ".")
        .unwrap();
    assert_eq!(root.scheduled_as, ScheduledAs::Dependent);
    assert!(!root.workspace_wide);
    assert_eq!(
        rust_selection_scoped(&head, ".", root.workspace_wide).unwrap(),
        ["-p", "root-consumer"]
    );
    head.get_mut("Cargo.toml")
        .unwrap()
        .content
        .extend_from_slice(b"# workspace edit\n");
    let diff = git_diff(&changes(base, head.clone()), &[]).unwrap();
    let scheduled = detect_repository(&head, &diff).unwrap().schedule(&diff);
    assert_eq!(scheduled.len(), 1);
    assert!(scheduled[0].workspace_wide);
    assert_eq!(
        rust_selection_scoped(&head, ".", true).unwrap(),
        ["--workspace"]
    );
}

#[cfg(unix)]
#[tokio::test]
async fn missing_llvm_component_skips_coverage_before_the_runner_can_install_it() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let cargo_path = temp.path().join("cargo");
    fs::write(&cargo_path, "#!/bin/sh\nif [ \"$1\" = llvm-cov ] && [ \"$2\" = --version ]; then echo cargo-llvm-cov-test; exit 0; fi\nexit 99\n").unwrap();
    fs::write(
        temp.path().join("rustc"),
        "#!/bin/sh\nprintf '%s\\n' '/uninstalled-toolchain/lib/rustlib/test-triple/lib'\n",
    )
    .unwrap();
    for name in ["cargo", "rustc"] {
        fs::set_permissions(temp.path().join(name), fs::Permissions::from_mode(0o755)).unwrap();
    }
    let tool = ResolvedTool {
        name: "cargo-check".into(),
        path: cargo_path,
        version: "test".into(),
        version_hint: None,
    };
    let tree = read_tree(&fixture("rs-sample"));
    let available = rust_subcommand(
        &tool,
        "cargo-llvm-cov",
        &tree,
        ".",
        &ProcessSupervisor::default(),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert!(available.is_none());
}

#[tokio::test]
async fn trusted_rust_root_without_a_lock_can_run_in_the_disposable_tree() {
    let mut tree = read_tree(&fixture("rs-sample"));
    tree.remove("Cargo.lock");
    let manifest = String::from_utf8(tree["core/Cargo.toml"].content.clone()).unwrap();
    tree.insert(
        "core/Cargo.toml".into(),
        entry(manifest.split("[dependencies]").next().unwrap()),
    );
    let supervisor = ProcessSupervisor::default();
    let cargo = rust_cargo(
        &ToolResolver::from_environment(fixture("rs-sample")),
        &tree,
        "core",
        &supervisor,
        CancellationToken::new(),
    )
    .await
    .unwrap();
    if !require_tool(cargo.is_some(), "cargo") {
        return;
    }
    assert!(matches!(
        cargo_compatibility(None, None, true, "1.99.1", true).0,
        Compatibility::Trusted { .. }
    ));
    let temp = tempfile::tempdir().unwrap();
    SafeTreeWriter::new(temp.path())
        .unwrap()
        .write_tree(&tree)
        .unwrap();
    let command =
        rust_diagnostic_command(cargo.as_ref().unwrap(), &tree, temp.path(), "core", false)
            .unwrap();
    assert!(!command.args.iter().any(|arg| arg == "--locked"));
    let result = supervisor.run(command, CancellationToken::new()).await;
    let context = DiagnosticContext {
        repository_root: temp.path(),
        project_root: ".",
        tool_version: "1.99.1",
        worktree_root: None,
        sources: Some(&tree),
    };
    let findings = RustAdapter
        .parse_output("cargo-check", &result.stdout, &result.stderr, &context)
        .unwrap();
    assert!(matches!(
        evaluate_cargo_exit(&result, CheckKind::Typecheck, Ok(findings)),
        CheckOutcome::Passed { .. }
    ));
    assert!(temp.path().join("Cargo.lock").is_file());
    assert!(!tree.contains_key("Cargo.lock"));
    assert!(
        !rust_coverage_settings(&tree, "core")
            .unwrap()
            .runner_args
            .contains(&"--locked".into())
    );
}

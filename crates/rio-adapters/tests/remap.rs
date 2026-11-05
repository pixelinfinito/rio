#![cfg(unix)]
use rio_adapters::{ToolCommand, configure_base_command, remap_base_dependencies};
use rio_git::{DependencyLink, Tree, TreeEntry};
use std::{fs, path::Path};

fn write(root: &Path, path: &str, text: &str) {
    let path = root.join(path);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}
fn tree(path: &str, text: &str) -> Tree {
    [(
        path.into(),
        TreeEntry {
            mode: 0o100644,
            object_id: String::new(),
            content: text.as_bytes().to_vec(),
        },
    )]
    .into()
}

#[test]
fn global_python_checkers_select_the_nearest_venv_among_mixed_language_links() {
    for name in [".venv", "venv"] {
        for checker in ["mypy", "pyright"] {
            let repo = tempfile::tempdir().unwrap();
            let base = tempfile::tempdir().unwrap();
            let global = tempfile::tempdir().unwrap();
            let environment = format!("packages/api/{name}");
            let paths = [
                ".venv",
                "target",
                "node_modules",
                environment.as_str(),
                "packages/api/target",
                "packages/api/node_modules",
            ];
            let links: Vec<_> = paths
                .iter()
                .map(|path| {
                    fs::create_dir_all(repo.path().join(path)).unwrap();
                    fs::create_dir_all(base.path().join(path)).unwrap();
                    DependencyLink {
                        path: (*path).into(),
                        target: repo.path().join(path).canonicalize().unwrap(),
                    }
                })
                .collect();
            write(base.path(), &format!("{environment}/bin/python"), "");
            write(global.path(), checker, "");
            let program = global.path().join(checker);
            let mut command = ToolCommand::new(program.clone(), base.path().join("packages/api"));
            configure_base_command(&mut command, repo.path(), base.path(), &links, checker)
                .unwrap();
            let private_environment = base.path().canonicalize().unwrap().join(environment);
            assert_eq!(
                command.env[std::ffi::OsStr::new("VIRTUAL_ENV")],
                private_environment.as_os_str()
            );
            assert_eq!(
                command.args.last().unwrap(),
                private_environment.join("bin/python").as_os_str()
            );
            assert_eq!(command.program, program);
        }
    }
}

#[test]
fn pnpm_virtual_store_nested_links_and_external_targets_are_preserved() {
    let repo = tempfile::tempdir().unwrap();
    let base = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    let real_root = repo.path().join("real");
    fs::create_dir(&real_root).unwrap();
    let alias = repo.path().join("alias");
    std::os::unix::fs::symlink(&real_root, &alias).unwrap();
    let root = alias.as_path();
    write(root, "packages/a/src/value.ts", "head");
    write(base.path(), "packages/a/src/value.ts", "base");
    write(
        root,
        "node_modules/.pnpm/consumer@1/node_modules/consumer/package.json",
        "{}",
    );
    fs::create_dir_all(root.join("packages/b/node_modules")).unwrap();
    std::os::unix::fs::symlink(
        root.join("packages/a"),
        root.join("node_modules/.pnpm/consumer@1/node_modules/a"),
    )
    .unwrap();
    std::os::unix::fs::symlink(
        root.join("packages/a"),
        root.join("packages/b/node_modules/a"),
    )
    .unwrap();
    std::os::unix::fs::symlink(
        ".pnpm/consumer@1/node_modules/consumer",
        root.join("node_modules/consumer"),
    )
    .unwrap();
    std::os::unix::fs::symlink(external.path(), root.join("node_modules/external")).unwrap();
    let links: Vec<_> = ["node_modules", "packages/b/node_modules"]
        .into_iter()
        .map(|path| DependencyLink {
            path: path.into(),
            target: root.join(path),
        })
        .collect();
    for link in &links {
        fs::create_dir_all(base.path().join(&link.path).parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&link.target, base.path().join(&link.path)).unwrap();
    }
    let n = remap_base_dependencies(
        root,
        base.path(),
        &links,
        &tree("packages/a/src/value.ts", "head"),
        &tree("packages/a/src/value.ts", "base"),
        &|| false,
    )
    .unwrap();
    assert_eq!(n.packages, 1);
    for path in [
        "node_modules/.pnpm/consumer@1/node_modules/a/src/value.ts",
        "packages/b/node_modules/a/src/value.ts",
    ] {
        assert_eq!(fs::read_to_string(base.path().join(path)).unwrap(), "base");
    }
    assert_eq!(
        base.path()
            .join("node_modules/consumer")
            .canonicalize()
            .unwrap(),
        base.path()
            .join("node_modules/.pnpm/consumer@1/node_modules/consumer")
            .canonicalize()
            .unwrap()
    );
    assert_eq!(
        fs::read_link(base.path().join("node_modules/external")).unwrap(),
        external.path().canonicalize().unwrap()
    );
    assert_eq!(
        fs::read_to_string(root.join("packages/b/node_modules/a/src/value.ts")).unwrap(),
        "head"
    );
}

#[test]
fn unsupported_editable_finder_fails_instead_of_importing_head() {
    let repo = tempfile::tempdir().unwrap();
    let base = tempfile::tempdir().unwrap();
    write(repo.path(), "src/a.py", "head");
    write(base.path(), "src/a.py", "base");
    write(repo.path(), ".venv/lib/python3.12/site-packages/a.dist-info/direct_url.json", &serde_json::json!({"url":format!("file://{}",repo.path().display()),"dir_info":{"editable":true}}).to_string());
    write(
        repo.path(),
        ".venv/lib/python3.12/site-packages/a.pth",
        "import __editable__opaque; __editable__opaque.install()\n",
    );
    write(
        repo.path(),
        ".venv/lib/python3.12/site-packages/__editable__opaque.py",
        "def install(): pass\n",
    );
    let link = DependencyLink {
        path: ".venv".into(),
        target: repo.path().join(".venv"),
    };
    std::os::unix::fs::symlink(&link.target, base.path().join(".venv")).unwrap();
    let error = remap_base_dependencies(
        repo.path(),
        base.path(),
        &[link],
        &tree("src/a.py", "head"),
        &tree("src/a.py", "base"),
        &|| false,
    )
    .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("editable finder cannot be remapped"),
        "{error}"
    );
}

#[test]
fn egg_link_and_plain_pth_remap_without_touching_original_metadata() {
    let repo = tempfile::tempdir().unwrap();
    let base = tempfile::tempdir().unwrap();
    write(repo.path(), "src/a.py", "head");
    write(base.path(), "src/a.py", "base");
    let site = ".venv/lib/python3.12/site-packages";
    let original = format!("{}\n.\n", repo.path().join("src").display());
    write(repo.path(), &format!("{site}/a.egg-link"), &original);
    let link = DependencyLink {
        path: ".venv".into(),
        target: repo.path().join(".venv"),
    };
    std::os::unix::fs::symlink(&link.target, base.path().join(".venv")).unwrap();
    assert_eq!(
        remap_base_dependencies(
            repo.path(),
            base.path(),
            &[link],
            &tree("src/a.py", "head"),
            &tree("src/a.py", "base"),
            &|| false
        )
        .unwrap()
        .packages,
        1
    );
    assert!(
        fs::read_to_string(base.path().join(format!("{site}/a.egg-link")))
            .unwrap()
            .starts_with(base.path().join("src").to_str().unwrap())
    );
    assert_eq!(
        fs::read_to_string(repo.path().join(format!("{site}/a.egg-link"))).unwrap(),
        original
    );
}

#[test]
fn compiled_finder_without_direct_url_is_never_silently_accepted() {
    let repo = tempfile::tempdir().unwrap();
    let base = tempfile::tempdir().unwrap();
    write(repo.path(), "src/a.py", "head");
    write(base.path(), "src/a.py", "base");
    write(
        repo.path(),
        ".venv/lib/python3.12/site-packages/a.pth",
        "import __editable__compiled; __editable__compiled.install()\n",
    );
    let link = DependencyLink {
        path: ".venv".into(),
        target: repo.path().join(".venv"),
    };
    std::os::unix::fs::symlink(&link.target, base.path().join(".venv")).unwrap();
    let error = remap_base_dependencies(
        repo.path(),
        base.path(),
        &[link],
        &tree("src/a.py", "head"),
        &tree("src/a.py", "base"),
        &|| false,
    )
    .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("editable finder cannot be remapped"),
        "{error}"
    );
}

fn linked_package(
    manifest: serde_json::Value,
    files: &[(&str, &str)],
) -> (tempfile::TempDir, tempfile::TempDir, Tree, DependencyLink) {
    let repo = tempfile::tempdir().unwrap();
    let base = tempfile::tempdir().unwrap();
    let mut selected = tree("packages/shared/package.json", &manifest.to_string());
    for (path, text) in files {
        selected.extend(tree(&format!("packages/shared/{path}"), text));
    }
    for (path, entry) in &selected {
        write(
            repo.path(),
            path,
            std::str::from_utf8(&entry.content).unwrap(),
        );
        write(
            base.path(),
            path,
            std::str::from_utf8(&entry.content).unwrap(),
        );
    }
    fs::create_dir_all(repo.path().join("node_modules")).unwrap();
    std::os::unix::fs::symlink(
        "../packages/shared",
        repo.path().join("node_modules/shared"),
    )
    .unwrap();
    let link = DependencyLink {
        path: "node_modules".into(),
        target: repo.path().join("node_modules"),
    };
    std::os::unix::fs::symlink(&link.target, base.path().join("node_modules")).unwrap();
    (repo, base, selected, link)
}

#[test]
fn ignored_build_entries_resolve_to_base_source_and_preserve_inherited_paths() {
    let variants = [
        serde_json::json!({"main":"index.cjs"}),
        serde_json::json!({"types":"dist/index.d.ts", "source":"src/source.ts"}),
        serde_json::json!({"main":"dist/index.js", "development":"src/source.ts"}),
        serde_json::json!({"exports":{".":{"@custom/source":"./src/source.ts", "types":"./build/index.d.ts", "default":"./build/index.js"}, "./feature":{"source":"./src/feature.ts","default":"./dist/feature.js"}, "./*":{"source":"./src/*.ts","default":"./dist/*.js"}}}),
        serde_json::json!({"main":"dist/index.js", "publishConfig":{"exports":{".":{"source":"./src/source.ts","default":"./dist/index.js"}}}}),
    ];
    for (index, mut manifest) in variants.into_iter().enumerate() {
        manifest["name"] = "shared".into();
        let (repo, base, selected, link) = linked_package(
            manifest,
            &[
                ("src/index.ts", "export const value = 1;"),
                ("src/source.ts", "export const value = 1;"),
                ("src/feature.ts", "export const feature = true;"),
            ],
        );
        let mut head = selected.clone();
        head.extend(tree(
            "packages/shared/src/index.ts",
            "export const value = 'head';",
        ));
        write(
            repo.path(),
            "packages/shared/dist/index.js",
            "head build must not be reused",
        );
        let remapped =
            remap_base_dependencies(repo.path(), base.path(), &[link], &head, &selected, &|| {
                false
            })
            .unwrap();
        assert_eq!(remapped.packages, 1);
        assert!(remapped.unavailable.is_empty());
        let expected = if index == 0 {
            "src/index.ts"
        } else {
            "src/source.ts"
        };
        assert_eq!(
            remapped.source_paths["shared"],
            vec![
                base.path()
                    .join("packages/shared")
                    .join(expected)
                    .to_str()
                    .unwrap()
            ]
        );
        if index == 3 {
            assert!(remapped.source_paths.contains_key("shared/feature"));
            assert!(remapped.source_paths.contains_key("shared/*"));
        }
        assert!(!base.path().join("packages/shared/dist").exists());
        assert_eq!(
            fs::read_to_string(base.path().join("packages/shared/src/index.ts")).unwrap(),
            "export const value = 1;"
        );

        write(
            base.path(),
            "config/tsconfig.base.json",
            "{ // JSONC and extensionless extends\n compilerOptions: { baseUrl: '..', paths: { '@local/*': ['local/*'], shared: ['packages/shared/dist/index.d.ts'] } } }",
        );
        write(
            base.path(),
            "tsconfig.json",
            "{\"extends\":\"./config/tsconfig.base\",\"include\":[\"consumer.ts\"]}",
        );
        let mut command = rio_adapters::ToolCommand::new("tsc".into(), base.path().into());
        command.args = vec![
            "--noEmit".into(),
            "-p".into(),
            base.path().join("tsconfig.json").into_os_string(),
        ];
        remapped.configure_typescript(&mut command).unwrap();
        let config: serde_json::Value =
            serde_json::from_slice(&fs::read(&command.args[2]).unwrap()).unwrap();
        assert_eq!(
            config["extends"],
            base.path().join("tsconfig.json").to_str().unwrap()
        );
        assert_eq!(
            config["compilerOptions"]["paths"]["shared"][0],
            base.path()
                .join("packages/shared")
                .join(expected)
                .to_str()
                .unwrap()
        );
        assert_eq!(
            config["compilerOptions"]["paths"]["@local/*"][0],
            base.path()
                .canonicalize()
                .unwrap()
                .join("config/../local/*")
                .to_str()
                .unwrap()
        );
    }
}

#[test]
fn unchanged_package_build_output_is_copied_privately_but_source_changes_refuse_reuse() {
    for output in ["dist/index.d.ts", "build/index.d.ts", "index.cjs"] {
        for changed in [false, true] {
            let (repo, base, selected, link) = linked_package(
                serde_json::json!({"name":"shared", "types":output}),
                &[("lib/value.ts", "export const value = 1;")],
            );
            write(
                repo.path(),
                &format!("packages/shared/{output}"),
                "export declare const value: number;",
            );
            let mut head = selected.clone();
            if changed {
                head.extend(tree(
                    "packages/shared/lib/value.ts",
                    "export const value = 'changed';",
                ));
            }
            let remapped = remap_base_dependencies(
                repo.path(),
                base.path(),
                &[link],
                &head,
                &selected,
                &|| false,
            )
            .unwrap();
            if changed {
                assert!(!base.path().join("packages/shared").join(output).exists());
                assert!(remapped.unavailable[0].contains("tracked package inputs changed"));
                assert!(remapped.unavailable[0].contains(output));
                let mut command = rio_adapters::ToolCommand::new("tsc".into(), base.path().into());
                assert!(remapped.configure_typescript(&mut command).is_err());
            } else {
                assert!(remapped.unavailable.is_empty());
                write(
                    base.path(),
                    &format!("packages/shared/{output}"),
                    "changed in private tree",
                );
                assert_eq!(
                    fs::read_to_string(repo.path().join("packages/shared").join(output)).unwrap(),
                    "export declare const value: number;"
                );
            }
        }
    }
}

#[test]
fn missing_source_and_artifacts_report_the_package_entry_and_remedy() {
    let (repo, base, selected, link) = linked_package(
        serde_json::json!({"name":"shared", "types":"dist/index.d.ts"}),
        &[("lib/value.ts", "export const value = 1;")],
    );
    let remapped = remap_base_dependencies(
        repo.path(),
        base.path(),
        &[link],
        &selected,
        &selected,
        &|| false,
    )
    .unwrap();
    let hint = &remapped.unavailable[0];
    assert!(hint.contains("packages/shared::shared"));
    assert!(hint.contains("dist/index.d.ts"));
    assert!(hint.contains("Configure a source entry point"));
    assert!(hint.contains("HEAD build output is unavailable"));
}

#[test]
fn artifact_reuse_hash_includes_added_deleted_and_changed_tracked_inputs() {
    for change in ["addition", "deletion", "config", "mode"] {
        let (repo, base, selected, link) = linked_package(
            serde_json::json!({"name":"shared", "types":"dist/index.d.ts"}),
            &[("lib/value.ts", "export const value = 1;")],
        );
        write(
            repo.path(),
            "packages/shared/dist/index.d.ts",
            "export declare const value: number;",
        );
        let mut head = selected.clone();
        match change {
            "addition" => head.extend(tree(
                "packages/shared/lib/new.ts",
                "export const added = 1;",
            )),
            "deletion" => {
                head.remove("packages/shared/lib/value.ts");
            }
            "config" => head.extend(tree("packages/shared/tsconfig.json", "{}")),
            "mode" => head.get_mut("packages/shared/lib/value.ts").unwrap().mode = 0o100755,
            _ => unreachable!(),
        }
        let remapped =
            remap_base_dependencies(repo.path(), base.path(), &[link], &head, &selected, &|| {
                false
            })
            .unwrap();
        assert!(
            remapped
                .unavailable
                .iter()
                .any(|hint| hint.contains("tracked package inputs changed")),
            "{change}: {remapped:?}"
        );
        assert!(!base.path().join("packages/shared/dist").exists());
    }
}

#[test]
fn incomplete_builds_and_symlinked_artifacts_never_become_usable_baselines() {
    let (repo, base, selected, link) = linked_package(
        serde_json::json!({"name":"shared", "types":"dist/index.d.ts"}),
        &[("lib/value.ts", "export const value = 1;")],
    );
    write(
        repo.path(),
        "packages/shared/dist/unrelated.js",
        "unrelated build file",
    );
    let remapped = remap_base_dependencies(
        repo.path(),
        base.path(),
        &[link],
        &selected,
        &selected,
        &|| false,
    )
    .unwrap();
    assert!(remapped.unavailable[0].contains("base build entry dist/index.d.ts is missing"));

    let (repo, base, selected, link) = linked_package(
        serde_json::json!({"name":"shared", "types":"dist/index.d.ts"}),
        &[("lib/value.ts", "export const value = 1;")],
    );
    fs::create_dir_all(repo.path().join("packages/shared/dist")).unwrap();
    std::os::unix::fs::symlink(
        repo.path().join("packages/shared/lib/value.ts"),
        repo.path().join("packages/shared/dist/index.d.ts"),
    )
    .unwrap();
    let error = remap_base_dependencies(
        repo.path(),
        base.path(),
        &[link],
        &selected,
        &selected,
        &|| false,
    )
    .unwrap_err();
    assert!(error.to_string().contains("is a symlink"));
}

#[test]
fn a_root_source_alias_does_not_satisfy_an_unbuilt_exported_subpath() {
    let (repo, base, selected, link) = linked_package(
        serde_json::json!({"name":"shared", "exports":{
            ".":{"types":"./dist/index.d.ts","default":"./dist/index.js"},
            "./extra":{"types":"./dist/extra.d.ts","default":"./dist/extra.js"}
        }}),
        &[("src/index.ts", "export const value = 1;")],
    );
    let remapped = remap_base_dependencies(
        repo.path(),
        base.path(),
        &[link],
        &selected,
        &selected,
        &|| false,
    )
    .unwrap();
    assert!(remapped.source_paths.contains_key("shared"));
    assert!(!remapped.source_paths.contains_key("shared/extra"));
    assert!(
        remapped
            .unavailable
            .iter()
            .any(|hint| hint.contains("dist/extra.d.ts"))
    );
}

#[test]
fn subpath_only_exports_do_not_gain_an_unexported_root_alias() {
    let (repo, base, selected, link) = linked_package(
        serde_json::json!({"name":"shared", "exports":{
            "./feature":{"source":"./src/feature.ts", "default":"./dist/feature.js"}
        }}),
        &[
            ("src/index.ts", "export const privateValue = 1;"),
            ("src/feature.ts", "export const feature = 1;"),
        ],
    );
    let remapped = remap_base_dependencies(
        repo.path(),
        base.path(),
        &[link],
        &selected,
        &selected,
        &|| false,
    )
    .unwrap();
    assert!(!remapped.source_paths.contains_key("shared"));
    assert!(remapped.source_paths.contains_key("shared/feature"));
    assert!(remapped.unavailable.is_empty());
}

#[test]
fn extensionless_source_export_patterns_preserve_typescript_extension_substitution() {
    // Zod's locale exports use the same wildcard for .js consumers and .ts
    // source. Appending .ts to this pattern would incorrectly resolve en.js.ts.
    let (repo, base, selected, link) = linked_package(
        serde_json::json!({"name":"shared", "exports":{
            "./locales/*":{"@custom/source":"./src/locales/*", "default":"./locales/*"}
        }}),
        &[("src/locales/en.ts", "export default 'en';")],
    );
    let remapped = remap_base_dependencies(
        repo.path(),
        base.path(),
        &[link],
        &selected,
        &selected,
        &|| false,
    )
    .unwrap();
    assert_eq!(
        remapped.source_paths["shared/locales/*"],
        vec![
            base.path()
                .join("packages/shared/src/locales/*")
                .to_str()
                .unwrap()
        ]
    );
    assert!(remapped.unavailable.is_empty());
}

use rio_adapters::{
    Compatibility, CompatibilityRequest, DependencyEnvironment, Ecosystem, GoverningLockfile,
    Installation, check_compatibility, governing_lockfile, read_installation,
};
use rio_git::{Tree, TreeEntry};
use serde_json::json;
use std::{fs, path::Path};

#[cfg(unix)]
fn aliased_worktree() -> (tempfile::TempDir, std::path::PathBuf) {
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("source");
    fs::create_dir(&source).unwrap();
    let alias = temporary.path().join("alias");
    std::os::unix::fs::symlink(&source, &alias).unwrap();
    (temporary, alias)
}

fn put(tree: &mut Tree, path: &str, text: &str) {
    tree.insert(
        path.into(),
        TreeEntry {
            mode: 0o100644,
            object_id: String::new(),
            content: text.as_bytes().to_vec(),
        },
    );
}
fn write(root: &Path, path: &str, text: &str) {
    let path = root.join(path);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}
fn package(root: &Path, location: &str, name: &str, version: &str) {
    write(
        root,
        &format!("{location}/package.json"),
        &json!({"name":name,"version":version}).to_string(),
    );
}
fn npm_lock(version: &str) -> String {
    json!({"lockfileVersion":3,"packages":{"":{"dependencies":{"react":version}},"node_modules/react":{"version":version}}}).to_string()
}
fn check(
    root: &Path,
    working: &Tree,
    selected: &Tree,
    lock: Option<&GoverningLockfile>,
    installed: &Installation,
    trust: bool,
) -> Compatibility {
    check_compatibility(CompatibilityRequest {
        worktree: root,
        working,
        selected,
        project_root: ".",
        lockfile: lock,
        installation: installed,
        environment: &DependencyEnvironment::default(),
        trust,
    })
}
fn npm_tree(version: &str) -> Tree {
    let mut tree = Tree::new();
    put(&mut tree, "package-lock.json", &npm_lock(version));
    tree
}

#[test]
fn unstaged_lockfile_upgrade_and_stale_installation_after_switch_are_known_mismatches_even_with_trust()
 {
    let root = tempfile::tempdir().unwrap();
    let selected = npm_tree("18.3.1");
    let working = npm_tree("19.0.0");
    write(
        root.path(),
        "node_modules/.package-lock.json",
        &npm_lock("19.0.0"),
    );
    package(root.path(), "node_modules/react", "react", "19.0.0");
    let lock = governing_lockfile(&selected, ".", None, Ecosystem::Npm)
        .unwrap()
        .unwrap();
    let installed = read_installation(root.path(), ".", &lock.graph);
    for trust in [false, true] {
        let result = check(
            root.path(),
            &working,
            &selected,
            Some(&lock),
            &installed,
            trust,
        );
        assert!(
            matches!(result, Compatibility::Mismatch { .. }),
            "{result:?}"
        );
        assert!(result.hint().unwrap().contains("package-lock.json"));
        assert!(result.hint().unwrap().contains("react"));
    }
    write(
        root.path(),
        "node_modules/.package-lock.json",
        &npm_lock("18.2.0"),
    );
    package(root.path(), "node_modules/react", "react", "18.2.0");
    let installed = read_installation(root.path(), ".", &lock.graph);
    let result = check(
        root.path(),
        &selected,
        &selected,
        Some(&lock),
        &installed,
        false,
    );
    assert!(matches!(result, Compatibility::Mismatch { .. }));
    assert!(result.hint().unwrap().contains("reinstall"));
}

#[test]
fn identical_version_sets_with_swapped_nested_locations_do_not_match() {
    let root = tempfile::tempdir().unwrap();
    let selected_lock = json!({"lockfileVersion":3,"packages":{
        "":{"dependencies":{"lodash":"4.17.21","legacy":"1.0.0"}},
        "node_modules/lodash":{"version":"4.17.21"},
        "node_modules/legacy":{"version":"1.0.0","dependencies":{"lodash":"3.10.1"}},
        "node_modules/legacy/node_modules/lodash":{"version":"3.10.1"}
    }});
    let mut selected = Tree::new();
    put(
        &mut selected,
        "package-lock.json",
        &selected_lock.to_string(),
    );
    let mut installed_lock = selected_lock.clone();
    installed_lock["packages"]["node_modules/lodash"]["version"] = json!("3.10.1");
    installed_lock["packages"]["node_modules/legacy/node_modules/lodash"]["version"] =
        json!("4.17.21");
    write(
        root.path(),
        "node_modules/.package-lock.json",
        &installed_lock.to_string(),
    );
    package(root.path(), "node_modules/lodash", "lodash", "3.10.1");
    package(root.path(), "node_modules/legacy", "legacy", "1.0.0");
    package(
        root.path(),
        "node_modules/legacy/node_modules/lodash",
        "lodash",
        "4.17.21",
    );
    let lock = governing_lockfile(&selected, ".", None, Ecosystem::Npm)
        .unwrap()
        .unwrap();
    let installed = read_installation(root.path(), ".", &lock.graph);
    let result = check(
        root.path(),
        &selected,
        &selected,
        Some(&lock),
        &installed,
        false,
    );
    assert!(
        matches!(result, Compatibility::Mismatch { .. }),
        "{result:?}"
    );
    assert!(result.hint().unwrap().contains("node_modules/lodash"));
}

#[test]
fn omitted_dev_and_platform_specific_optional_dependencies_are_compatible() {
    let root = tempfile::tempdir().unwrap();
    let text = json!({"lockfileVersion":3,"packages":{
        "":{"dependencies":{"react":"18.3.1"},"devDependencies":{"eslint":"9.0.0"},"optionalDependencies":{"win-package":"1.0.0"}},
        "node_modules/react":{"version":"18.3.1"},
        "node_modules/eslint":{"version":"9.0.0","dev":true},
        "node_modules/win-package":{"version":"1.0.0","optional":true,"os":["win32"]}
    }}).to_string();
    let mut selected = Tree::new();
    put(&mut selected, "package-lock.json", &text);
    write(
        root.path(),
        "node_modules/.package-lock.json",
        &npm_lock("18.3.1"),
    );
    package(root.path(), "node_modules/react", "react", "18.3.1");
    let lock = governing_lockfile(&selected, ".", None, Ecosystem::Npm)
        .unwrap()
        .unwrap();
    let installed = read_installation(root.path(), ".", &lock.graph);
    assert!(installed.omit_dev);
    let result = check(
        root.path(),
        &selected,
        &selected,
        Some(&lock),
        &installed,
        false,
    );
    assert!(
        matches!(result, Compatibility::Verified { .. }),
        "{result:?}"
    );
}

#[test]
fn missing_lockfile_and_unpinned_requirements_are_unverified_and_only_then_trust_applies() {
    let root = tempfile::tempdir().unwrap();
    let tree = Tree::new();
    let installation = Installation::default();
    let result = check(root.path(), &tree, &tree, None, &installation, false);
    assert!(matches!(result, Compatibility::Unverified { .. }));
    assert!(result.hint().unwrap().contains("no lockfile"));
    let result = check(root.path(), &tree, &tree, None, &installation, true);
    assert!(matches!(result, Compatibility::Trusted { .. }));
    assert!(!result.can_classify_baseline());
    let mut tree = Tree::new();
    put(&mut tree, "requirements.txt", "requests>=2\n");
    let lock = governing_lockfile(&tree, ".", None, Ecosystem::PyPi)
        .unwrap()
        .unwrap();
    let result = check(root.path(), &tree, &tree, Some(&lock), &installation, false);
    assert!(
        matches!(result, Compatibility::Unverified { .. }),
        "{result:?}"
    );
    assert!(result.hint().unwrap().contains("exact pin"));
}

#[test]
fn absent_installation_metadata_is_unverifiable_and_trustable_not_a_known_missing_package() {
    let root = tempfile::tempdir().unwrap();
    let tree = npm_tree("18.3.1");
    let lock = governing_lockfile(&tree, ".", None, Ecosystem::Npm)
        .unwrap()
        .unwrap();
    let installed = read_installation(root.path(), ".", &lock.graph);
    assert!(!installed.complete);
    assert!(matches!(
        check(root.path(), &tree, &tree, Some(&lock), &installed, false),
        Compatibility::Unverified { .. }
    ));
    assert!(matches!(
        check(root.path(), &tree, &tree, Some(&lock), &installed, true),
        Compatibility::Trusted { .. }
    ));
}

#[cfg(unix)]
#[test]
fn workspace_links_compare_source_against_head_and_base_even_with_unchanged_manifests() {
    let (_temporary, root) = aliased_worktree();
    let lockfile = json!({"lockfileVersion":3,"packages":{
        "":{"dependencies":{"shared":"file:packages/shared"}},
        "packages/shared":{"name":"shared","version":"1.0.0"},
        "node_modules/shared":{"resolved":"packages/shared","link":true}
    }})
    .to_string();
    let mut base = Tree::new();
    put(&mut base, "package-lock.json", &lockfile);
    put(&mut base, "packages/shared/src/a.ts", "export const a = 1;");
    let mut head = base.clone();
    put(&mut head, "packages/shared/src/a.ts", "export const a = 2;");
    write(root.as_path(), "node_modules/.package-lock.json", &lockfile);
    package(root.as_path(), "packages/shared", "shared", "1.0.0");
    fs::create_dir_all(root.as_path().join("node_modules")).unwrap();
    std::os::unix::fs::symlink(
        "../packages/shared",
        root.as_path().join("node_modules/shared"),
    )
    .unwrap();
    let lock = governing_lockfile(&head, ".", None, Ecosystem::Npm)
        .unwrap()
        .unwrap();
    let installed = read_installation(root.as_path(), ".", &lock.graph);
    assert_eq!(installed.links.len(), 1);
    let head_result = check(root.as_path(), &head, &head, Some(&lock), &installed, false);
    assert!(head_result.can_run(), "{head_result:?}");
    for trust in [false, true] {
        let result = check(root.as_path(), &head, &base, Some(&lock), &installed, trust);
        assert!(
            matches!(result, Compatibility::Mismatch { .. }),
            "{result:?}"
        );
        assert!(result.hint().unwrap().contains("packages/shared"));
    }
    let mut changed = head.clone();
    put(&mut changed, "packages/shared/src/a.ts", "uncommitted");
    assert!(matches!(
        check(
            root.as_path(),
            &changed,
            &head,
            Some(&lock),
            &installed,
            false
        ),
        Compatibility::Mismatch { .. }
    ));
}

#[test]
fn member_uses_workspace_importer_and_does_not_require_unrelated_members_dependencies() {
    let mut tree = Tree::new();
    put(
        &mut tree,
        "pnpm-workspace.yaml",
        "packages: ['packages/*']\n",
    );
    put(
        &mut tree,
        "pnpm-lock.yaml",
        "lockfileVersion: '9.0'\nimporters:\n  .: {}\n  packages/api:\n    dependencies: {foo: {version: 1.0.0}}\n  packages/web:\n    dependencies: {bar: {version: 2.0.0}}\npackages:\n  foo@1.0.0: {}\n  bar@2.0.0: {}\nsnapshots:\n  foo@1.0.0: {}\n  bar@2.0.0: {}\n",
    );
    let lock = governing_lockfile(&tree, "packages/api", Some("."), Ecosystem::Npm)
        .unwrap()
        .unwrap();
    assert_eq!(lock.path, "pnpm-lock.yaml");
    assert_eq!(lock.importer, "packages/api");
    let effective = lock
        .graph
        .effective(&lock.importer, &DependencyEnvironment::default())
        .unwrap();
    assert_eq!(effective.nodes.len(), 1);
    assert!(effective.nodes.contains_key("foo@1.0.0"));
}

#[test]
fn yarn_installation_readers_compare_resolved_edges_and_nested_package_versions() {
    for berry in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let text = if berry {
            "__metadata: {version: 8}\n\"debug@npm:^4\":\n  version: 4.4.3\n  resolution: debug@npm:4.4.3\n  dependencies: {ms: 'npm:^2'}\n\"ms@npm:^2\":\n  version: 2.1.3\n  resolution: ms@npm:2.1.3\n"
        } else {
            "debug@^4:\n  version \"4.4.3\"\n  dependencies:\n    ms \"^2\"\nms@^2:\n  version \"2.1.3\"\n"
        };
        let mut tree = Tree::new();
        put(&mut tree, "yarn.lock", text);
        put(
            &mut tree,
            "package.json",
            r#"{"name":"app","dependencies":{"debug":"^4"}}"#,
        );
        write(
            root.path(),
            if berry {
                "node_modules/.yarn-state.yml"
            } else {
                "node_modules/.yarn-integrity"
            },
            if berry {
                "__metadata: {version: 1}\n"
            } else {
                r#"{"flags":[],"topLevelPatterns":["debug@^4"]}"#
            },
        );
        package(root.path(), "node_modules/debug", "debug", "4.4.3");
        package(
            root.path(),
            "node_modules/debug/node_modules/ms",
            "ms",
            "2.1.3",
        );
        let lock = governing_lockfile(&tree, ".", None, Ecosystem::Npm)
            .unwrap()
            .unwrap();
        let installed = read_installation(root.path(), ".", &lock.graph);
        let result = check(root.path(), &tree, &tree, Some(&lock), &installed, false);
        assert!(result.can_run(), "{result:?}");
        package(
            root.path(),
            "node_modules/debug/node_modules/ms",
            "ms",
            "1.0.0",
        );
        let installed = read_installation(root.path(), ".", &lock.graph);
        let result = check(root.path(), &tree, &tree, Some(&lock), &installed, false);
        assert!(
            matches!(result, Compatibility::Mismatch { .. }),
            "{result:?}"
        );
    }
}

#[test]
fn pnpm_metadata_records_importer_locations_and_detects_a_stale_importer() {
    let root = tempfile::tempdir().unwrap();
    let text = "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies: {foo: {version: 1.0.0}}\npackages:\n  foo@1.0.0: {}\nsnapshots:\n  foo@1.0.0: {}\n";
    let mut tree = Tree::new();
    put(&mut tree, "pnpm-lock.yaml", text);
    write(root.path(), "node_modules/.pnpm/lock.yaml", text);
    package(
        root.path(),
        "node_modules/.pnpm/foo@1.0.0/node_modules/foo",
        "foo",
        "1.0.0",
    );
    let lock = governing_lockfile(&tree, ".", None, Ecosystem::Npm)
        .unwrap()
        .unwrap();
    let installed = read_installation(root.path(), ".", &lock.graph);
    assert_eq!(installed.resolutions["."]["foo"], "foo@1.0.0");
    assert!(check(root.path(), &tree, &tree, Some(&lock), &installed, false).can_run());
    let mut stale = installed.clone();
    stale
        .resolutions
        .get_mut(".")
        .unwrap()
        .insert("foo".into(), "foo@2.0.0".into());
    assert!(matches!(
        check(root.path(), &tree, &tree, Some(&lock), &stale, false),
        Compatibility::Mismatch { .. }
    ));
}

#[test]
fn python_dist_info_without_dev_group_is_compatible() {
    let root = tempfile::tempdir().unwrap();
    let text = "version = 1\n[[package]]\nname = 'app'\nversion = '0.1.0'\nsource = {virtual = '.'}\ndependencies = [{name = 'requests'}]\n[package.dev-dependencies]\ndev = [{name = 'pytest'}]\n[[package]]\nname = 'requests'\nversion = '2.32.3'\n[[package]]\nname = 'pytest'\nversion = '8.3.4'\n";
    let mut tree = Tree::new();
    put(&mut tree, "uv.lock", text);
    write(
        root.path(),
        ".venv/lib/python3.12/site-packages/requests-2.32.3.dist-info/METADATA",
        "Metadata-Version: 2.3\nName: requests\nVersion: 2.32.3\n",
    );
    let lock = governing_lockfile(&tree, ".", None, Ecosystem::PyPi)
        .unwrap()
        .unwrap();
    let installed = read_installation(root.path(), ".", &lock.graph);
    let result = check(root.path(), &tree, &tree, Some(&lock), &installed, false);
    assert!(result.can_run(), "{result:?}");
}

#[cfg(unix)]
#[test]
fn irrelevant_workspace_links_do_not_disable_a_root_and_wrong_link_targets_are_rejected() {
    let (_temporary, root) = aliased_worktree();
    let lockfile = json!({"lockfileVersion":3,"packages":{
        "":{"dependencies":{"shared":"file:packages/shared"}},
        "packages/shared":{"name":"shared","version":"1.0.0"},
        "packages/unrelated":{"name":"unrelated","version":"1.0.0"},
        "node_modules/shared":{"link":true,"resolved":"packages/shared"},
        "node_modules/unrelated":{"link":true,"resolved":"packages/unrelated"}
    }})
    .to_string();
    let mut selected = Tree::new();
    put(&mut selected, "package-lock.json", &lockfile);
    put(&mut selected, "packages/shared/a.ts", "source");
    put(&mut selected, "packages/unrelated/a.ts", "base");
    let mut working = selected.clone();
    put(&mut working, "packages/unrelated/a.ts", "modified");
    write(root.as_path(), "node_modules/.package-lock.json", &lockfile);
    package(root.as_path(), "packages/shared", "shared", "1.0.0");
    package(root.as_path(), "packages/unrelated", "unrelated", "1.0.0");
    std::os::unix::fs::symlink(
        "../packages/shared",
        root.as_path().join("node_modules/shared"),
    )
    .unwrap();
    std::os::unix::fs::symlink(
        "../packages/unrelated",
        root.as_path().join("node_modules/unrelated"),
    )
    .unwrap();
    let lock = governing_lockfile(&selected, ".", None, Ecosystem::Npm)
        .unwrap()
        .unwrap();
    let installed = read_installation(root.as_path(), ".", &lock.graph);
    let result = check(
        root.as_path(),
        &working,
        &selected,
        Some(&lock),
        &installed,
        false,
    );
    assert!(result.can_run(), "{result:?}");
    fs::remove_file(root.as_path().join("node_modules/shared")).unwrap();
    package(root.as_path(), "packages/wrong", "shared", "1.0.0");
    std::os::unix::fs::symlink(
        "../packages/wrong",
        root.as_path().join("node_modules/shared"),
    )
    .unwrap();
    let installed = read_installation(root.as_path(), ".", &lock.graph);
    let result = check(
        root.as_path(),
        &selected,
        &selected,
        Some(&lock),
        &installed,
        true,
    );
    assert!(
        matches!(result, Compatibility::Mismatch { .. }),
        "{result:?}"
    );
    assert!(result.hint().unwrap().contains("packages/wrong"));
}

#[cfg(unix)]
#[test]
fn python_editable_links_and_pth_sources_are_checked_against_selected_source() {
    let (_temporary, root) = aliased_worktree();
    let mut selected = Tree::new();
    put(&mut selected, "requirements.txt", "shared==1.0.0\n");
    put(&mut selected, "packages/shared/a.py", "source");
    let mut working = selected.clone();
    put(&mut working, "packages/shared/a.py", "modified");
    let site = ".venv/lib/python3.12/site-packages";
    write(
        root.as_path(),
        &format!("{site}/shared-1.0.0.dist-info/METADATA"),
        "Metadata-Version: 2.3\nName: shared\nVersion: 1.0.0\n",
    );
    fs::create_dir_all(root.as_path().join("packages/shared")).unwrap();
    write(root.as_path(),&format!("{site}/shared-1.0.0.dist-info/direct_url.json"),&json!({"url":format!("file://{}",root.as_path().join("packages/shared").display()),"dir_info":{"editable":true}}).to_string());
    write(
        root.as_path(),
        &format!("{site}/shared.pth"),
        root.as_path().join("packages/shared").to_str().unwrap(),
    );
    let lock = governing_lockfile(&selected, ".", None, Ecosystem::PyPi)
        .unwrap()
        .unwrap();
    let installed = read_installation(root.as_path(), ".", &lock.graph);
    assert_eq!(installed.links.len(), 2);
    let result = check(
        root.as_path(),
        &working,
        &selected,
        Some(&lock),
        &installed,
        true,
    );
    assert!(
        matches!(result, Compatibility::Mismatch { .. }),
        "{result:?}"
    );
    assert!(result.hint().unwrap().contains("packages/shared"));
}

#[cfg(unix)]
#[test]
fn yarn_classic_workspace_links_are_resolved_using_workspace_manifests() {
    let root = tempfile::tempdir().unwrap();
    let mut tree = Tree::new();
    put(
        &mut tree,
        "package.json",
        r#"{"name":"app","version":"1.0.0","private":true,"workspaces":["packages/*"],"dependencies":{"shared":"1.0.0"}}"#,
    );
    put(
        &mut tree,
        "packages/shared/package.json",
        r#"{"name":"shared","version":"1.0.0","dependencies":{"ms":"^2"}}"#,
    );
    put(&mut tree, "yarn.lock", "ms@^2:\n  version \"2.1.3\"\n");
    write(
        root.path(),
        "node_modules/.yarn-integrity",
        r#"{"flags":[],"topLevelPatterns":["shared@1.0.0"]}"#,
    );
    package(root.path(), "packages/shared", "shared", "1.0.0");
    package(root.path(), "node_modules/ms", "ms", "2.1.3");
    std::os::unix::fs::symlink(
        "../packages/shared",
        root.path().join("node_modules/shared"),
    )
    .unwrap();
    let lock = governing_lockfile(&tree, ".", None, Ecosystem::Npm)
        .unwrap()
        .unwrap();
    assert!(lock.graph.complete, "{:?}", lock.graph.notes);
    let installed = read_installation(root.path(), ".", &lock.graph);
    let result = check(root.path(), &tree, &tree, Some(&lock), &installed, false);
    assert!(result.can_run(), "{result:?}");
}

#[cfg(unix)]
#[test]
fn baseline_defers_untracked_build_entry_points_to_private_overlay() {
    use rio_adapters::check_base_compatibility;
    let root = tempfile::tempdir().unwrap();
    let lock = serde_json::json!({"lockfileVersion":3,"packages":{
        "":{"dependencies":{"shared":"*"}},
        "packages/shared":{"name":"shared","version":"1.0.0"},
        "node_modules/shared":{"resolved":"packages/shared","link":true}
    }})
    .to_string();
    let mut base = Tree::new();
    put(&mut base, "package-lock.json", &lock);
    put(
        &mut base,
        "packages/shared/package.json",
        r#"{"name":"shared","version":"1.0.0","types":"src/index.ts"}"#,
    );
    put(
        &mut base,
        "packages/shared/src/index.ts",
        "export const value = 1;",
    );
    let mut head = base.clone();
    put(
        &mut head,
        "packages/shared/src/index.ts",
        "export const value = 'new';",
    );
    write(root.path(), "node_modules/.package-lock.json", &lock);
    package(root.path(), "packages/shared", "shared", "1.0.0");
    std::os::unix::fs::symlink(
        "../packages/shared",
        root.path().join("node_modules/shared"),
    )
    .unwrap();
    let installed = read_installation(
        root.path(),
        ".",
        &governing_lockfile(&head, ".", None, Ecosystem::Npm)
            .unwrap()
            .unwrap()
            .graph,
    );
    for field in ["types", "main", "exports"] {
        for entry in ["./src/index.ts", "./dist/index.js", "./index.cjs"] {
            let mut selected = base.clone();
            // A tracked placeholder does not make ignored build output usable.
            put(
                &mut selected,
                "packages/shared/dist/README.md",
                "build output goes here",
            );
            let mut manifest = serde_json::json!({"name":"shared","version":"1.0.0"});
            manifest[field] = if field == "exports" {
                serde_json::json!({".":{"types":entry,"default":entry}})
            } else {
                serde_json::json!(entry)
            };
            put(
                &mut selected,
                "packages/shared/package.json",
                &manifest.to_string(),
            );
            let lock = governing_lockfile(&selected, ".", None, Ecosystem::Npm)
                .unwrap()
                .unwrap();
            let result = check_base_compatibility(CompatibilityRequest {
                worktree: root.path(),
                working: &head,
                selected: &selected,
                project_root: ".",
                lockfile: Some(&lock),
                installation: &installed,
                environment: &DependencyEnvironment::default(),
                trust: false,
            });
            assert!(result.can_run(), "{result:?}");
        }
    }
}

#[test]
fn npm_versions_allow_one_leading_v_but_still_reject_different_versions() {
    let root = tempfile::tempdir().unwrap();
    let selected = npm_tree("0.13.0");
    write(
        root.path(),
        "node_modules/.package-lock.json",
        &npm_lock("0.13.0"),
    );
    let lock = governing_lockfile(&selected, ".", None, Ecosystem::Npm)
        .unwrap()
        .unwrap();
    for (version, compatible) in [("v0.13.0", true), ("v0.14.0", false), ("vv0.13.0", false)] {
        package(root.path(), "node_modules/react", "react", version);
        let installed = read_installation(root.path(), ".", &lock.graph);
        let result = check(
            root.path(),
            &selected,
            &selected,
            Some(&lock),
            &installed,
            false,
        );
        assert_eq!(result.can_run(), compatible, "{version}: {result:?}");
    }
}

#[test]
fn filtered_pnpm_importers_are_optional_only_when_absent_and_outside_scheduled_roots() {
    use rio_adapters::{parse_lockfile, scope_pnpm_importers};
    let root = tempfile::tempdir().unwrap();
    let content = "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      react: {version: 0.13.0}\n  examples/uninstalled:\n    dependencies:\n      missing: {version: 2.0.0}\npackages:\n  react@0.13.0: {}\nsnapshots:\n  react@0.13.0: {}\n";
    write(root.path(), "node_modules/.pnpm/lock.yaml", content);
    package(
        root.path(),
        "node_modules/.pnpm/react@0.13.0/node_modules/react",
        "react",
        "v0.13.0",
    );
    let graph = parse_lockfile("pnpm-lock.yaml", content).unwrap();
    assert!(!graph.complete);
    for scheduled in [
        vec![".".into()],
        vec![".".into(), "examples/uninstalled".into()],
    ] {
        let mut lock = GoverningLockfile {
            path: "pnpm-lock.yaml".into(),
            root: ".".into(),
            importer: ".".into(),
            graph: graph.clone(),
        };
        let mut installed = read_installation(root.path(), ".", &graph);
        scope_pnpm_importers(
            &mut lock.graph,
            Some(&mut installed),
            root.path(),
            ".",
            &scheduled,
        );
        let result = check(
            root.path(),
            &Tree::new(),
            &Tree::new(),
            Some(&lock),
            &installed,
            false,
        );
        assert_eq!(result.can_run(), scheduled.len() == 1, "{result:?}");
    }
    fs::create_dir_all(root.path().join("examples/uninstalled/node_modules")).unwrap();
    let mut graph = graph;
    scope_pnpm_importers(&mut graph, None, root.path(), ".", &[".".into()]);
    assert!(!graph.complete, "installed importer must remain strict");
}

#[test]
fn unresolved_required_workspace_importer_is_never_ignored_by_filtered_install_scope() {
    use rio_adapters::{parse_lockfile, scope_pnpm_importers};
    let root = tempfile::tempdir().unwrap();
    let content = "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      required: {version: 'link:packages/required'}\n  packages/required:\n    dependencies:\n      missing: {version: 2.0.0}\n";
    let mut graph = parse_lockfile("pnpm-lock.yaml", content).unwrap();
    scope_pnpm_importers(&mut graph, None, root.path(), ".", &[".".into()]);
    assert!(!graph.complete);
    assert!(
        graph
            .notes
            .iter()
            .any(|note| note.contains("packages/required"))
    );
}

#[test]
fn malformed_lock_is_unverified_with_parse_hint() {
    let mut tree = Tree::new();
    put(&mut tree, "pnpm-lock.yaml", "lockfileVersion: [broken");
    let lock = governing_lockfile(&tree, ".", None, Ecosystem::Npm)
        .unwrap()
        .unwrap();
    assert!(!lock.graph.complete);
    assert!(lock.graph.notes[0].contains("cannot parse pnpm-lock.yaml"));
    let root = tempfile::tempdir().unwrap();
    let result = check(
        root.path(),
        &tree,
        &tree,
        Some(&lock),
        &Installation::default(),
        false,
    );
    assert!(
        matches!(result, Compatibility::Unverified { .. }),
        "{result:?}"
    );
    assert!(result.hint().unwrap().contains("parse"));
}
#[test]
fn pnpm_installed_lock_and_modules_resolve_recorded_store_names() {
    let mut rows: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("fixtures/lockfiles/pnpm-store-names.json")).unwrap();
    rows.push(json!({"key":"@vitejs/plugin-vue@5.2.4(vite@5.4.15(@types/node@22.14.1)(sass@1.87.0))(vue@packages/vue)", "directory":"@vitejs+plugin-vue@5.2.4_vite@5.4.15_@types+node@22.14.1_sass@1.87.0__vue@packages+vue", "max_length":120}));
    for row in rows {
        let root = tempfile::tempdir().unwrap();
        let key = row["key"].as_str().unwrap();
        let base = key.split('(').next().unwrap();
        let (name, version) = base.rsplit_once('@').unwrap();
        let lock = format!(
            "lockfileVersion: '9.0'\nimporters: {{.: {{dependencies: {{'{name}': {{version: '{}'}}}}}}}}\npackages: {{'{base}': {{}}}}\nsnapshots: {{'{key}': {{}}}}\n",
            &key[name.len() + 1..]
        );
        write(root.path(), "node_modules/.pnpm/lock.yaml", &lock);
        write(
            root.path(),
            "node_modules/.modules.yaml",
            &json!({"virtualStoreDirMaxLength":row["max_length"]}).to_string(),
        );
        package(
            root.path(),
            &format!(
                "node_modules/.pnpm/{}/node_modules/{name}",
                row["directory"].as_str().unwrap()
            ),
            name,
            version,
        );
        let graph = rio_adapters::parse_lockfile("pnpm-lock.yaml", &lock).unwrap();
        let installation = read_installation(root.path(), ".", &graph);
        assert!(installation.complete, "{:?}", installation.notes);
        assert!(installation.nodes.contains_key(key), "missing {key}");
    }
}

#[test]
fn pnpm_quoted_store_length_and_project_settings_resolve_long_peer_paths() {
    // TanStack/query rerun2: pnpm 11 writes "250" in .modules.yaml.
    let key = "@testing-library/react@16.3.2(@testing-library/dom@10.4.1)(@types/react-dom@19.2.3(@types/react@19.2.14))(@types/react@19.2.14)(react-dom@19.2.4(react@19.2.4))(react@19.2.4)";
    let directory = "@testing-library+react@16.3.2_@testing-library+dom@10.4.1_@types+react-dom@19.2.3_@types+react@19.2.14__@types+react@19.2.14_react-dom@19.2.4_react@19.2.4__react@19.2.4";
    let lock = format!(
        "lockfileVersion: '9.0'\npackages: {{'@testing-library/react@16.3.2': {{}}}}\nsnapshots: {{'{key}': {{}}}}\n"
    );
    let graph = rio_adapters::parse_lockfile("pnpm-lock.yaml", &lock).unwrap();
    for (modules, npmrc, workspace, found) in [
        ("virtualStoreDirMaxLength: \"250\"", "", "", true),
        ("virtualStoreDirMaxLength: 250", "", "", true),
        ("", "virtual-store-dir-max-length=250", "", true),
        (
            "",
            "virtual-store-dir-max-length=\"250\" # length",
            "",
            true,
        ),
        ("", "virtualStoreDirMaxLength='250'", "", true),
        ("", "", "virtualStoreDirMaxLength: \"250\"", true),
        ("", "", "virtualStoreDirMaxLength: 250", true),
        // Installed metadata wins; .npmrc wins over workspace configuration.
        (
            "virtualStoreDirMaxLength: '250'",
            "virtual-store-dir-max-length=120",
            "virtualStoreDirMaxLength: 120",
            true,
        ),
        (
            "",
            "virtual-store-dir-max-length=250",
            "virtualStoreDirMaxLength: 120",
            true,
        ),
        ("", "", "", false),
        (
            "virtualStoreDirMaxLength: invalid",
            "virtual-store-dir-max-length=-1",
            "virtualStoreDirMaxLength: 0",
            false,
        ),
    ] {
        let root = tempfile::tempdir().unwrap();
        write(root.path(), "project/node_modules/.pnpm/lock.yaml", &lock);
        for (path, text) in [
            ("node_modules/.modules.yaml", modules),
            (".npmrc", npmrc),
            ("pnpm-workspace.yaml", workspace),
        ] {
            if !text.is_empty() {
                write(root.path(), &format!("project/{path}"), text);
            }
        }
        package(
            root.path(),
            &format!("project/node_modules/.pnpm/{directory}/node_modules/@testing-library/react"),
            "@testing-library/react",
            "16.3.2",
        );
        let installed = read_installation(root.path(), "project", &graph);
        assert!(installed.complete, "{:?}", installed.notes);
        assert_eq!(
            installed.nodes.contains_key(key),
            found,
            "{modules}; {npmrc}; {workspace}"
        );
    }
}

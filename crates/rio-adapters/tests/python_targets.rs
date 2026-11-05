mod common;

use common::entry;
use rio_adapters::{ResolvedTool, diagnostic_command};
use rio_git::Tree;

fn command(tree: &Tree, root: &str, name: &str) -> (tempfile::TempDir, Vec<String>) {
    let temp = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(temp.path().join(root)).unwrap();
    let tool = ResolvedTool {
        name: name.into(),
        path: name.into(),
        version: "1.14.0".into(),
        version_hint: None,
    };
    let command = diagnostic_command(&tool, tree, temp.path(), root, &[]).unwrap();
    let args = command
        .args
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    (temp, args)
}

fn targets(tree: &Tree, root: &str) -> Vec<String> {
    let (_, args) = command(tree, root, "mypy");
    let mut args = args.into_iter();
    let mut targets = Vec::new();
    while let Some(arg) = args.next() {
        if ["--output", "--config-file"].contains(&arg.as_str()) {
            args.next();
        } else {
            targets.push(arg);
        }
    }
    targets
}

fn fixture(name: &str, paths: &[&str]) -> Tree {
    let config = std::fs::read_to_string(format!(
        "{}/tests/fixtures/python-targets/{name}.toml",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    let mut tree = Tree::from([("pyproject.toml".into(), entry(&config))]);
    for path in paths {
        tree.insert((*path).into(), entry(""));
    }
    // These must never replace explicit or inferred package scope.
    tree.insert("tests/__init__.py".into(), entry(""));
    tree.insert("tests/test_types.py".into(), entry("broken: int = 'wrong'"));
    tree
}

#[test]
fn explicit_mypy_targets_are_delegated_to_native_configuration() {
    for name in ["files", "packages", "modules"] {
        let tree = fixture(name, &["custom/__init__.py"]);
        assert!(targets(&tree, ".").is_empty(), "{name}");
        let (temp, args) = command(&tree, ".", "mypy");
        assert!(args.windows(2).any(|pair| pair
            == [
                "--config-file",
                temp.path().join("pyproject.toml").to_str().unwrap()
            ]));
    }
    for name in ["mypy.ini", ".mypy.ini", "setup.cfg"] {
        let tree = Tree::from([
            (
                name.into(),
                entry(
                    "[other]\nfiles = ignored\n[mypy]\nfiles =\n    custom\n    tests/typecheck.py\nexclude = generated/\n",
                ),
            ),
            ("custom/__init__.py".into(), entry("")),
        ]);
        assert!(targets(&tree, ".").is_empty(), "{name}");
        let (temp, args) = command(&tree, ".", "mypy");
        assert!(args.contains(&temp.path().join(name).to_string_lossy().into_owned()));
    }
}

#[test]
fn backend_packages_precede_discovery_and_distribution_name() {
    for (name, path, expected) in [
        ("setuptools", "custom/__init__.py", "custom"),
        ("setuptools-src", "src/custom/__init__.py", "src/custom"),
        ("find", "src/custom/sub/module.py", "src/custom"),
        ("hatch", "src/custom/__init__.py", "src/custom"),
        ("poetry", "src/custom/__init__.py", "src/custom"),
        ("flit", "custom/__init__.py", "custom"),
        ("flit", "src/custom/__init__.py", "src/custom"),
        ("project", "custom_dist/__init__.py", "custom_dist"),
        ("project", "src/custom_dist/__init__.py", "src/custom_dist"),
    ] {
        let mut tree = fixture(name, &[path, "other/__init__.py", "src/other/__init__.py"]);
        if name != "project" {
            tree.get_mut("pyproject.toml")
                .unwrap()
                .content
                .extend_from_slice(b"\n[project]\nname = 'other'\n");
        }
        assert_eq!(targets(&tree, "."), [expected], "{name}: {path}");
    }
}

#[test]
fn package_discovery_excludes_non_product_directories_and_uses_dot_as_last_resort() {
    let excluded = [
        "tests",
        "test",
        "docs",
        "examples",
        "scripts",
        "benchmarks",
        "build",
        "dist",
        "target",
        "venv",
        ".venv",
        "__pycache__",
    ];
    let mut tree = fixture(
        "discovery",
        &["product/__init__.py", "second/__init__.py", "loose.py"],
    );
    for dir in excluded {
        tree.insert(format!("{dir}/__init__.py"), entry(""));
    }
    assert_eq!(targets(&tree, "."), ["product", "second"]);
    tree.remove("product/__init__.py");
    tree.remove("second/__init__.py");
    assert_eq!(targets(&tree, "."), ["."]);
}

#[test]
fn scope_and_config_are_relative_to_the_scheduled_root() {
    let tree = fixture("hatch", &["src/custom/__init__.py"]);
    let tree = tree
        .into_iter()
        .map(|(path, entry)| (format!("packages/api/{path}"), entry))
        .collect();
    assert_eq!(targets(&tree, "packages/api"), ["src/custom"]);
    let tree = Tree::from([("mypy.ini".into(), entry("[mypy]\nfiles = custom\n"))]);
    assert!(targets(&tree, "packages/api").is_empty());
}

#[test]
fn mypy_config_precedence_and_exclude_are_preserved_for_inferred_targets() {
    let mut tree = fixture(
        "empty",
        &["product/__init__.py", "product/generated/invalid.py"],
    );
    assert_eq!(targets(&tree, "."), ["product"]);
    let (temp, args) = command(&tree, ".", "mypy");
    // Mypy applies tool.mypy.exclude during directory discovery; it must read
    // the original config even when Rio supplies inferred package directories.
    assert!(
        args.contains(
            &temp
                .path()
                .join("pyproject.toml")
                .to_string_lossy()
                .into_owned()
        )
    );
    tree.insert("setup.cfg".into(), entry("[mypy]\nfiles = wrong\n"));
    assert_eq!(targets(&tree, "."), ["product"]);
    tree.insert("mypy.ini".into(), entry("[mypy]\nfiles = custom\n"));
    assert!(targets(&tree, ".").is_empty());
}

#[test]
fn pyright_keeps_its_native_include_and_exclude_selection() {
    for (path, content) in [
        (
            "pyrightconfig.json",
            r#"{"include":["custom"],"exclude":["tests"]}"#,
        ),
        (
            "pyproject.toml",
            "[tool.pyright]\ninclude = ['custom']\nexclude = ['tests']\n",
        ),
    ] {
        let tree = Tree::from([(path.into(), entry(content))]);
        let (_, args) = command(&tree, ".", "pyright");
        assert_eq!(args, ["--outputjson"]);
    }
}

#[tokio::test]
async fn real_mypy_respects_explicit_targets_inference_and_exclusions() {
    use rio_adapters::{ProcessSupervisor, Termination};
    use tokio_util::sync::CancellationToken;

    let tool_path = common::fixture("py-sample").join(".venv/bin/mypy");
    if !common::require_tool(tool_path.exists(), "mypy") {
        return;
    }
    for name in [
        "files",
        "packages",
        "modules",
        "setuptools",
        "setuptools-src",
        "find",
        "hatch",
        "poetry",
        "flit",
        "project",
        "discovery",
        "empty",
    ] {
        let mut tree = fixture(
            name,
            &[
                "custom/__init__.py",
                "custom/main.py",
                "src/custom/__init__.py",
                "custom_dist/__init__.py",
                "tests/typecheck.py",
            ],
        );
        if name == "files" {
            tree.insert(
                "custom/generated/invalid.py".into(),
                entry("wrong: int = 'wrong'"),
            );
        }
        if name == "empty" {
            tree.insert(
                "custom/generated/invalid.py".into(),
                entry("wrong: int = 'wrong'"),
            );
        }
        let temp = tempfile::tempdir().unwrap();
        rio_git::SafeTreeWriter::new(temp.path())
            .unwrap()
            .write_tree(&tree)
            .unwrap();
        let tool = ResolvedTool {
            name: "mypy".into(),
            path: tool_path.clone(),
            version: "1.14.1".into(),
            version_hint: None,
        };
        let mut cmd = diagnostic_command(&tool, &tree, temp.path(), ".", &[]).unwrap();
        cmd.args.push("--no-incremental".into());
        let result = ProcessSupervisor::default()
            .run(cmd, CancellationToken::new())
            .await;
        assert!(
            matches!(result.termination, Termination::Exited { code: Some(0) }),
            "{name}: {:?}\n{}\n{}",
            result.termination,
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
    }
}

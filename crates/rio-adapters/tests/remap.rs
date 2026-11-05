#![cfg(unix)]
use rio_adapters::remap_base_dependencies;
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
fn pnpm_virtual_store_nested_links_and_external_targets_are_preserved() {
    let repo = tempfile::tempdir().unwrap();
    let base = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    let root = repo.path();
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
    assert_eq!(n, 1);
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
    );
    assert_eq!(
        fs::read_link(base.path().join("node_modules/external")).unwrap(),
        external.path()
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
        .unwrap(),
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

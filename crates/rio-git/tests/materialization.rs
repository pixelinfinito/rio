mod common;

use std::{collections::BTreeMap, fs, time::Duration};

use common::{commit, git, init, write};
use rio_git::{
    GixRepo, MaterializationCache, Selection, ToolTree, dependency_state_hash,
    discover_dependency_links, select,
};

#[test]
fn staged_materialization_is_exact_and_tool_writes_cannot_mutate_cached_sources() {
    let root = init();
    write(
        root.path(),
        ".gitignore",
        "node_modules/\n.venv/\n__pycache__/\ntarget/\n",
    );
    write(root.path(), "src/a.ts", "export const a = 1;\n");
    write(root.path(), "deleted.ts", "delete me\n");
    commit(root.path(), "base");
    write(root.path(), "src/a.ts", "export const a = 2;\n");
    fs::remove_file(root.path().join("deleted.ts")).unwrap();
    git(root.path(), &["add", "-A"]);
    write(root.path(), "src/a.ts", "export const a = 'unstaged';\n");
    write(root.path(), "untracked.ts", "not selected\n");
    write(
        root.path(),
        "node_modules/package/index.js",
        "installed package\n",
    );
    write(root.path(), ".venv/pyvenv.cfg", "python environment\n");
    write(root.path(), "__pycache__/a.pyc", "skip\n");
    write(
        root.path(),
        "target/debug/build-artifact",
        "cached Rust artifact\n",
    );
    let before = git(
        root.path(),
        &["status", "--porcelain=v1", "--untracked-files=all"],
    );
    let repo = GixRepo::discover(root.path()).unwrap();
    let selected = select(&repo, Selection::Staged).unwrap();
    let cache_root = tempfile::tempdir().unwrap();
    let cache = MaterializationCache::new(cache_root.path().into(), Duration::from_secs(10));
    let trees = cache.materialize(&selected).unwrap();
    assert!(!trees.base.reused && !trees.head.reused);
    assert_eq!(
        fs::read_to_string(trees.base.path.join("src/a.ts")).unwrap(),
        "export const a = 1;\n"
    );
    assert_eq!(
        fs::read_to_string(trees.head.path.join("src/a.ts")).unwrap(),
        "export const a = 2;\n"
    );
    assert!(trees.base.path.join("deleted.ts").is_file());
    assert!(!trees.head.path.join("deleted.ts").exists());
    assert!(!trees.head.path.join("untracked.ts").exists());
    let links = discover_dependency_links(root.path(), &[".".into()]).unwrap();
    assert_eq!(links.len(), 3);
    for tree in [&trees.base, &trees.head] {
        assert!(!tree.path.join("node_modules").exists());
        assert!(!tree.path.join(".venv").exists());
        assert!(!tree.path.join("target").exists());
        assert!(!tree.path.join("__pycache__").exists());
    }
    let tool = ToolTree::create(&trees.head, &cache_root.path().join("runs/one"), &links).unwrap();
    assert_eq!(
        fs::read_to_string(tool.path().join("node_modules/package/index.js")).unwrap(),
        "installed package\n"
    );
    assert!(
        fs::symlink_metadata(tool.path().join("node_modules"))
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(
        fs::read_to_string(tool.path().join("target/debug/build-artifact")).unwrap(),
        "cached Rust artifact\n"
    );
    assert!(
        fs::symlink_metadata(tool.path().join("target"))
            .unwrap()
            .file_type()
            .is_symlink()
    );
    // Opening with truncate is the failure case for hard-linked copies.
    fs::write(tool.path().join("src/a.ts"), "tool rewrote this file").unwrap();
    assert_eq!(
        fs::read_to_string(trees.head.path.join("src/a.ts")).unwrap(),
        "export const a = 2;\n"
    );
    drop(tool);
    assert!(root.path().join("node_modules/package/index.js").is_file());
    let again = cache.materialize(&selected).unwrap();
    assert!(again.base.reused && again.head.reused);
    assert_eq!(
        before,
        git(
            root.path(),
            &["status", "--porcelain=v1", "--untracked-files=all"]
        )
    );
}

#[test]
fn worktrees_share_pure_sources_and_get_separate_dependency_links() {
    let root = init();
    write(root.path(), ".gitignore", "node_modules/\n");
    write(root.path(), "package.json", "{\"name\":\"example\"}\n");
    commit(root.path(), "base");
    let other_parent = tempfile::tempdir().unwrap();
    let other = other_parent.path().join("other");
    git(
        root.path(),
        &["worktree", "add", "--detach", other.to_str().unwrap()],
    );
    write(
        root.path(),
        "node_modules/package/index.js",
        "installation one",
    );
    write(&other, "node_modules/package/index.js", "installation two");
    let cache_root = tempfile::tempdir().unwrap();
    let cache = MaterializationCache::new(cache_root.path().into(), Duration::from_secs(10));
    let a = cache
        .materialize(&select(&GixRepo::discover(root.path()).unwrap(), Selection::Staged).unwrap())
        .unwrap();
    let b = cache
        .materialize(&select(&GixRepo::discover(&other).unwrap(), Selection::Staged).unwrap())
        .unwrap();
    assert_eq!(a.base.path, b.base.path);
    assert_eq!(a.head.path, b.head.path);
    assert!(b.base.reused && b.head.reused);
    let links_a = discover_dependency_links(root.path(), &[".".into()]).unwrap();
    let links_b = discover_dependency_links(&other, &[".".into()]).unwrap();
    let tool_a = ToolTree::create(&a.head, &cache_root.path().join("runs/one"), &links_a).unwrap();
    let tool_b = ToolTree::create(&b.head, &cache_root.path().join("runs/two"), &links_b).unwrap();
    assert_eq!(
        fs::read_to_string(tool_a.path().join("node_modules/package/index.js")).unwrap(),
        "installation one"
    );
    assert_eq!(
        fs::read_to_string(tool_b.path().join("node_modules/package/index.js")).unwrap(),
        "installation two"
    );
    assert_ne!(
        fs::read_link(tool_a.path().join("node_modules")).unwrap(),
        fs::read_link(tool_b.path().join("node_modules")).unwrap()
    );
    assert!(!a.head.path.join("node_modules").exists());
    assert!(!a.base.path.join("node_modules").exists());
}

#[test]
fn dependency_links_are_ignored_only_and_never_replace_tracked_content() {
    let root = init();
    write(
        root.path(),
        ".gitignore",
        "packages/*/node_modules/\nvenv/\n",
    );
    write(root.path(), "venv/tracked.txt", "tracked");
    git(root.path(), &["add", "-f", "venv/tracked.txt"]);
    commit(root.path(), "base");
    write(root.path(), "node_modules/not-ignored.txt", "not ignored");
    write(
        root.path(),
        "packages/api/node_modules/package/index.js",
        "ignored",
    );
    let links =
        discover_dependency_links(root.path(), &[".".into(), "packages/api".into()]).unwrap();
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].path, "packages/api/node_modules");
}

#[test]
fn canonical_dependency_hash_includes_metadata_graph_platform_and_linked_sources() {
    let mut inputs = BTreeMap::from([
        ("root/graph".into(), b"graph one".to_vec()),
        ("root/installation".into(), b"installation one".to_vec()),
        ("platform".into(), b"linux-x64".to_vec()),
        ("linked/shared/a.ts".into(), b"source one".to_vec()),
    ]);
    let original = dependency_state_hash(&inputs);
    let mut reordered = BTreeMap::new();
    for (key, value) in inputs.iter().rev() {
        reordered.insert(key.clone(), value.clone());
    }
    assert_eq!(original, dependency_state_hash(&reordered));
    for key in inputs.clone().keys() {
        let previous = inputs.insert(key.clone(), b"different".to_vec()).unwrap();
        assert_ne!(original, dependency_state_hash(&inputs), "{key}");
        inputs.insert(key.clone(), previous);
    }
}

#[test]
fn concurrent_materializers_publish_one_complete_entry() {
    let root = init();
    write(root.path(), "src/a.ts", "source");
    commit(root.path(), "base");
    let selected = select(&GixRepo::discover(root.path()).unwrap(), Selection::Staged).unwrap();
    let cache_root = tempfile::tempdir().unwrap();
    let barrier = std::sync::Barrier::new(2);
    std::thread::scope(|scope| {
        let handles: Vec<_> = (0..2)
            .map(|_| {
                scope.spawn(|| {
                    barrier.wait();
                    let cache = MaterializationCache::new(
                        cache_root.path().into(),
                        Duration::from_secs(10),
                    );
                    cache.materialize(&selected).unwrap()
                })
            })
            .collect();
        let trees: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(trees.iter().filter(|t| !t.head.reused).count(), 1);
        assert_eq!(trees[0].head.path, trees[1].head.path);
    });
}

#[cfg(unix)]
#[test]
fn disposable_tree_preserves_leaf_links_and_refuses_dependency_symlink_parents() {
    use rio_git::DependencyLink;
    let root = init();
    write(root.path(), "a.ts", "source");
    std::os::unix::fs::symlink("a.ts", root.path().join("file-link")).unwrap();
    std::os::unix::fs::symlink("outside", root.path().join("parent")).unwrap();
    commit(root.path(), "base");
    let cache_root = tempfile::tempdir().unwrap();
    let cache = MaterializationCache::new(cache_root.path().into(), Duration::from_secs(10));
    let trees = cache
        .materialize(&select(&GixRepo::discover(root.path()).unwrap(), Selection::Staged).unwrap())
        .unwrap();
    let tool = ToolTree::create(&trees.head, &cache_root.path().join("runs"), &[]).unwrap();
    assert_eq!(
        fs::read_link(tool.path().join("file-link"))
            .unwrap()
            .to_str(),
        Some("a.ts")
    );
    let error = ToolTree::create(
        &trees.head,
        &cache_root.path().join("runs"),
        &[DependencyLink {
            path: "parent/node_modules".into(),
            target: root.path().into(),
        }],
    )
    .err()
    .unwrap();
    assert!(error.to_string().contains("symlink_parent"), "{error}");
}

#[test]
fn stopped_preparation_never_publishes_or_leaves_a_disposable_copy() {
    let root = init();
    for index in 0..20 {
        write(
            root.path(),
            &format!("src/{index}.ts"),
            "export const value = 1;\n",
        );
    }
    commit(root.path(), "base");
    write(root.path(), "src/0.ts", "export const value = 2;\n");
    let changes = select(
        &GixRepo::discover(root.path()).unwrap(),
        Selection::WorkingTree,
    )
    .unwrap();
    let directory = tempfile::tempdir().unwrap();
    let stopped = MaterializationCache::new(directory.path().into(), Duration::ZERO);
    assert!(
        stopped
            .materialize(&changes)
            .unwrap_err()
            .to_string()
            .contains("timeout")
    );
    assert!(!directory.path().join("baselines").exists());
    let cache = MaterializationCache::new(directory.path().into(), Duration::from_secs(10));
    let trees = cache.materialize(&changes).unwrap();
    let copies = directory.path().join("copies");
    let calls = std::cell::Cell::new(0);
    let result = ToolTree::create_until(&trees.head, &copies, &[], &|| {
        calls.set(calls.get() + 1);
        calls.get() > 4
    });
    assert!(result.is_err());
    assert_eq!(fs::read_dir(copies).unwrap().count(), 0);
    assert_eq!(
        fs::read(trees.head.path.join("src/0.ts")).unwrap(),
        b"export const value = 2;\n"
    );
}

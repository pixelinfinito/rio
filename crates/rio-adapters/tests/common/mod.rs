#![allow(dead_code)]
use rio_git::{ChangeSet, Selection, Tree, TreeEntry};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures")
        .join(name)
        .canonicalize()
        .unwrap()
}

pub fn read_tree(root: &Path) -> Tree {
    fn walk(root: &Path, directory: &Path, tree: &mut Tree) {
        for entry in fs::read_dir(directory).unwrap() {
            let entry = entry.unwrap();
            if [
                "node_modules",
                "target",
                ".venv",
                "venv",
                ".git",
                "__pycache__",
                ".mypy_cache",
                ".ruff_cache",
                ".pytest_cache",
                "coverage",
            ]
            .iter()
            .any(|name| entry.file_name() == *name)
            {
                continue;
            }
            let path = entry.path();
            if entry.file_type().unwrap().is_dir() {
                walk(root, &path, tree);
            } else if entry.file_type().unwrap().is_file() {
                tree.insert(
                    path.strip_prefix(root)
                        .unwrap()
                        .to_str()
                        .unwrap()
                        .replace('\\', "/"),
                    TreeEntry {
                        mode: 0o100644,
                        object_id: String::new(),
                        content: fs::read(path).unwrap(),
                    },
                );
            }
        }
    }
    let mut tree = Tree::new();
    walk(root, root, &mut tree);
    tree
}

pub fn entry(text: &str) -> TreeEntry {
    TreeEntry {
        mode: 0o100644,
        object_id: String::new(),
        content: text.as_bytes().to_vec(),
    }
}

pub fn changes(base: Tree, head: Tree) -> ChangeSet {
    ChangeSet {
        selection: Selection::WorkingTree,
        base_id: "empty".into(),
        head_id: "fixture".into(),
        base,
        head,
    }
}

pub fn require_tool(available: bool, name: &str) -> bool {
    assert!(
        available || std::env::var_os("RIO_REQUIRE_TOOLS").is_none(),
        "required fixture tool missing: {name}"
    );
    if !available {
        eprintln!("skipping integration: {name} is not installed");
    }
    available
}

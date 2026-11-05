mod common;

use common::*;
use rio_git::{
    ChangeSet, GixRepo, Repo, Selection, Snapshot, Tree, TreeEntry, materialize_tree,
    read_snapshot, select,
};
use std::{collections::BTreeMap, fs};

fn entry(content: &str) -> TreeEntry {
    TreeEntry {
        mode: 0o100644,
        object_id: "unused".into(),
        content: content.as_bytes().to_vec(),
    }
}
fn changes(base: Tree, head: Tree) -> ChangeSet {
    ChangeSet {
        selection: Selection::Staged,
        base_id: "base".into(),
        head_id: "head".into(),
        base,
        head,
    }
}

#[test]
fn canonical_keys_distinguish_whitespace_and_deleted_paths() {
    let base: Tree = [("a.ts".into(), entry("a\n")), ("b.ts".into(), entry("b\n"))]
        .into_iter()
        .collect();
    let first = changes(
        base.clone(),
        [("b.ts".into(), entry("b\n"))].into_iter().collect(),
    );
    let second = changes(
        base.clone(),
        [("a.ts".into(), entry("a\n"))].into_iter().collect(),
    );
    let one = Snapshot::from_changes(&first);
    assert_eq!(one.key, Snapshot::from_changes(&first).key);
    assert_ne!(one.key, Snapshot::from_changes(&second).key);
    assert_eq!(one.manifest.deleted, ["a.ts"]);
    let mut with_space = first.clone();
    with_space.head.get_mut("b.ts").unwrap().content.push(b' ');
    assert_ne!(one.key, Snapshot::from_changes(&with_space).key);
    let mut other_base = first;
    other_base.base_id = "different base".into();
    assert_ne!(one.key, Snapshot::from_changes(&other_base).key);
}

#[test]
fn archive_round_trip_and_delete_before_write_reconstruct_head() {
    let directory = tempfile::tempdir().unwrap();
    let base: Tree = [
        ("a.ts".into(), entry("deleted\n")),
        ("b.ts".into(), entry("renamed\n")),
        ("Case.ts".into(), entry("case\n")),
    ]
    .into_iter()
    .collect();
    let head: Tree = [
        ("c.ts".into(), entry("renamed and edited\n")),
        ("case.ts".into(), entry("case\n")),
    ]
    .into_iter()
    .collect();
    let changes = changes(base.clone(), head.clone());
    let snapshot = Snapshot::from_changes(&changes);
    let archive = snapshot.write(directory.path()).unwrap();
    let read = read_snapshot(&archive, &snapshot.key).unwrap();
    assert_eq!(snapshot.key, read.key);
    assert_eq!(read.manifest.deleted, ["Case.ts", "a.ts", "b.ts"]);
    let destination = directory.path().join("tree");
    materialize_tree(&destination, &base).unwrap();
    read.apply(&destination).unwrap();
    assert!(!destination.join("a.ts").exists());
    assert!(!destination.join("b.ts").exists());
    assert_eq!(
        fs::read(destination.join("c.ts")).unwrap(),
        head["c.ts"].content
    );
    assert_eq!(
        fs::read(destination.join("case.ts")).unwrap(),
        head["case.ts"].content
    );
    let names: Vec<_> = fs::read_dir(&destination)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_str().unwrap().to_owned())
        .collect();
    assert!(!names.contains(&"Case.ts".into()));
    assert!(read_snapshot(&archive, "incorrect key").is_err());
}

#[test]
fn selected_head_id_is_the_same_key_as_the_persisted_snapshot() {
    let directory = init();
    write(directory.path(), "a.py", "base = 1\n");
    commit(directory.path(), "base");
    write(directory.path(), "a.py", "staged = 2\n");
    git(directory.path(), &["add", "a.py"]);
    write(directory.path(), "a.py", "unstaged = 3\n");
    let repo = GixRepo::discover(directory.path()).unwrap();
    let changes = select(&repo, Selection::Staged).unwrap();
    let snapshot = Snapshot::from_changes(&changes);
    assert_eq!(changes.head_id, format!("snapshot:{}", snapshot.key));
    assert_eq!(snapshot.files["a.py"].content, b"staged = 2\n");
    let cache = tempfile::tempdir().unwrap();
    let archive = snapshot.write(cache.path()).unwrap();
    assert_eq!(snapshot.write(cache.path()).unwrap(), archive);
    assert_eq!(
        Snapshot::read(&archive).unwrap().files["a.py"].content,
        b"staged = 2\n"
    );
    assert_eq!(repo.status().unwrap().staged, ["a.py"]);
}

#[test]
fn unsafe_manifest_is_rejected_before_applying_any_file() {
    let directory = tempfile::tempdir().unwrap();
    let source = changes(
        BTreeMap::new(),
        [("safe.ts".into(), entry("okay"))].into_iter().collect(),
    );
    let mut snapshot = Snapshot::from_changes(&source);
    snapshot.manifest.deleted.push("../outside.txt".into());
    assert!(snapshot.apply(directory.path()).is_err());
    assert!(!directory.path().join("safe.ts").exists());
}

#[test]
fn archive_member_with_parent_traversal_is_rejected_without_extraction() {
    use std::io::Write;
    let directory = tempfile::tempdir().unwrap();
    let source = changes(
        Tree::new(),
        [("safe.ts".into(), entry("okay"))].into_iter().collect(),
    );
    let snapshot = Snapshot::from_changes(&source);
    let archive_path = directory.path().join("unsafe.tar.zst");
    let encoder = zstd::Encoder::new(fs::File::create(&archive_path).unwrap(), 3).unwrap();
    let mut archive = tar::Builder::new(encoder);
    let manifest = serde_json::to_vec(&snapshot.manifest).unwrap();
    let mut header = tar::Header::new_gnu();
    header.set_size(manifest.len() as u64);
    header.set_mode(0o600);
    header.set_cksum();
    archive
        .append_data(&mut header, "manifest.json", manifest.as_slice())
        .unwrap();
    let mut header = tar::Header::new_gnu();
    header.set_size(4);
    header.set_mode(0o600);
    let name = b"files/../outside.txt";
    header.as_mut_bytes()[..name.len()].copy_from_slice(name);
    header.set_cksum();
    archive.append(&header, &b"oops"[..]).unwrap();
    archive
        .into_inner()
        .unwrap()
        .finish()
        .unwrap()
        .flush()
        .unwrap();
    let error = Snapshot::read(&archive_path).unwrap_err().to_string();
    assert!(error.contains("unsafe_path"), "{error}");
    assert!(!directory.path().join("outside.txt").exists());
}

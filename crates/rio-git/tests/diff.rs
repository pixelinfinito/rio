mod common;

use common::*;
use rio_git::{Exclusions, FileStatus, GixRepo, Selection, Tree, TreeEntry, diff, select};
use std::fs;

#[test]
fn diff_snapshot_covers_git_file_kinds_and_exclusions() {
    let dir = init();
    for (path, content) in [
        ("modified.ts", "one\ntwo\nthree\n"),
        ("deleted.ts", "deleted only\n"),
        (
            "old.ts",
            "export function old() {\n  return 1;\n}\n// tail\n",
        ),
        ("Case.ts", "case name\n"),
        ("package-lock.json", "{\"lockfileVersion\": 3}\n"),
        ("generated.ts", "generated base\n"),
        ("asset.bin", "old binary\0"),
        ("large.dat", "old large file\n"),
        (".gitattributes", "generated.ts linguist-generated\n"),
    ] {
        write(dir.path(), path, content);
    }
    git(dir.path(), &["add", "."]);
    git(
        dir.path(),
        &[
            "update-index",
            "--add",
            "--cacheinfo",
            "160000,aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,vendor/sub",
        ],
    );
    git(dir.path(), &["commit", "-m", "base"]);
    write(dir.path(), "modified.ts", "one\nchanged\nthree\n");
    fs::remove_file(dir.path().join("deleted.ts")).unwrap();
    fs::rename(dir.path().join("old.ts"), dir.path().join("renamed.ts")).unwrap();
    write(
        dir.path(),
        "renamed.ts",
        "export function old() {\n  return 2;\n}\n// tail\n",
    );
    // Update the index explicitly on case-insensitive filesystems too.
    git(dir.path(), &["mv", "-f", "Case.ts", "case.ts"]);
    write(dir.path(), "added.ts", "brand new content\n");
    write(dir.path(), "asset.bin", "new binary\0");
    write(
        dir.path(),
        "package-lock.json",
        "{\"lockfileVersion\": 3, \"packages\": {}}\n",
    );
    write(dir.path(), "generated.ts", "generated changed\n");
    write(
        dir.path(),
        "large.dat",
        "version https://git-lfs.github.com/spec/v1\noid sha256:123\nsize 100\n",
    );
    git(dir.path(), &["add", "-A"]);
    git(
        dir.path(),
        &[
            "update-index",
            "--add",
            "--cacheinfo",
            "160000,bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb,vendor/sub",
        ],
    );
    let repo = GixRepo::discover(dir.path()).unwrap();
    let changes = select(&repo, Selection::Staged).unwrap();
    let diff = diff(&changes, &[]).unwrap();
    insta::assert_json_snapshot!("git_file_kinds", diff);
    let renamed = diff.files.iter().find(|f| f.path == "renamed.ts").unwrap();
    assert_eq!(renamed.status, FileStatus::Renamed);
    assert_eq!(renamed.hunks.len(), 1);
    assert_eq!(diff.map_line("old.ts", 1), Some(1));
    assert_eq!(diff.map_line("old.ts", 2), None);
    assert_eq!(diff.map_line("unchanged.ts", 12), Some(12));
}

#[test]
fn exclusion_attributes_follow_git_scoping_and_override_rules() {
    let file = |content: &str| TreeEntry {
        mode: 0o100644,
        object_id: String::new(),
        content: content.as_bytes().to_vec(),
    };
    let tree: Tree = [
        (
            ".gitattributes".into(),
            file("*.ts linguist-generated\nassets/** filter=lfs\n"),
        ),
        (
            "src/.gitattributes".into(),
            file("hand.ts -linguist-generated\n\"space name.ts\" linguist-generated\n"),
        ),
    ]
    .into_iter()
    .collect();
    let exclusions = Exclusions::new(&tree, &["docs/generated/**".into()]).unwrap();
    assert_eq!(
        exclusions.reason("src/code.ts", &file(""), true).as_deref(),
        Some("generated")
    );
    assert_eq!(exclusions.reason("src/hand.ts", &file(""), true), None);
    assert_eq!(
        exclusions
            .reason("src/space name.ts", &file(""), true)
            .as_deref(),
        Some("generated")
    );
    assert_eq!(
        exclusions
            .reason("assets/file.dat", &file(""), true)
            .as_deref(),
        Some("lfs")
    );
    assert_eq!(
        exclusions
            .reason("docs/generated/api.py", &file(""), true)
            .as_deref(),
        Some("profile_exclude")
    );
    assert_eq!(
        exclusions
            .reason("vendor/new.py", &file(""), false)
            .as_deref(),
        Some("vendored")
    );
    assert_eq!(
        exclusions.reason("vendor/tracked.py", &file(""), true),
        None
    );
    assert_eq!(
        exclusions
            .reason("node_modules/a.py", &file(""), true)
            .as_deref(),
        Some("vendored")
    );
}

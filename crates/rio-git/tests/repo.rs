mod common;

use common::*;
use rio_git::{GixRepo, Repo, Selection, changed_paths, select};
use std::{fs, process::Command};

#[test]
fn refs_merge_base_tree_and_blob_reads_use_git_objects() {
    let dir = init();
    write(dir.path(), "src/a.ts", "export const value = 1;\n");
    let first = commit(dir.path(), "first");
    git(dir.path(), &["checkout", "-b", "feature"]);
    write(dir.path(), "src/a.ts", "export const value = 2;\n");
    let second = commit(dir.path(), "second");
    let repo = GixRepo::discover(dir.path().join("src")).unwrap();
    assert_eq!(repo.head_id().unwrap(), Some(second.clone()));
    assert_eq!(repo.resolve_ref("main").unwrap(), first);
    assert_eq!(
        repo.merge_base(&first, &second).unwrap(),
        Some(first.clone())
    );
    let tree = repo.read_tree(&first).unwrap();
    assert_eq!(tree["src/a.ts"].content, b"export const value = 1;\n");
    assert_eq!(
        repo.read_blob(&tree["src/a.ts"].object_id).unwrap(),
        tree["src/a.ts"].content
    );
    assert!(!repo.is_shallow().unwrap());
}

#[test]
fn working_staged_and_branch_modes_pin_distinct_versions() {
    let dir = init();
    write(dir.path(), "staged.ts", "base\n");
    write(dir.path(), "unstaged.ts", "base\n");
    write(dir.path(), ".gitignore", "ignored.ts\n");
    commit(dir.path(), "base");
    git(dir.path(), &["checkout", "-b", "feature"]);
    write(dir.path(), "committed.ts", "commit\n");
    commit(dir.path(), "feature");
    write(dir.path(), "staged.ts", "staged\n");
    git(dir.path(), &["add", "staged.ts"]);
    write(dir.path(), "staged.ts", "unstaged on staged\n");
    write(dir.path(), "unstaged.ts", "unstaged\n");
    write(dir.path(), "untracked.ts", "untracked\n");
    write(dir.path(), "ignored.ts", "ignored\n");
    let repo = GixRepo::discover(dir.path()).unwrap();
    let work = select(&repo, Selection::WorkingTree).unwrap();
    assert_eq!(
        changed_paths(&work.base, &work.head),
        ["staged.ts", "unstaged.ts", "untracked.ts"]
    );
    assert_eq!(work.head["staged.ts"].content, b"unstaged on staged\n");
    let staged = select(&repo, Selection::Staged).unwrap();
    assert_eq!(changed_paths(&staged.base, &staged.head), ["staged.ts"]);
    assert_eq!(staged.head["staged.ts"].content, b"staged\n");
    let branch = select(
        &repo,
        Selection::Branch {
            reference: "main".into(),
        },
    )
    .unwrap();
    assert_eq!(changed_paths(&branch.base, &branch.head), ["committed.ts"]);
    let status = repo.status().unwrap();
    assert_eq!(status.staged, ["staged.ts"]);
    assert_eq!(status.untracked, ["untracked.ts"]);
}

#[test]
fn unborn_head_and_reference_failures_are_explicit() {
    let dir = init();
    write(dir.path(), "new.py", "value = 1\n");
    let repo = GixRepo::discover(dir.path()).unwrap();
    let changes = select(&repo, Selection::WorkingTree).unwrap();
    assert_eq!(changes.base_id, "empty");
    assert!(changes.base.is_empty());
    assert!(changes.head.contains_key("new.py"));
    commit(dir.path(), "first");
    let repo = GixRepo::discover(dir.path()).unwrap();
    let error = select(
        &repo,
        Selection::Branch {
            reference: "missing".into(),
        },
    )
    .unwrap_err();
    assert!(error.to_string().contains("unknown_ref"));
    git(dir.path(), &["checkout", "--orphan", "unrelated"]);
    fs::remove_file(dir.path().join("new.py")).unwrap();
    write(dir.path(), "other.py", "x = 2\n");
    commit(dir.path(), "unrelated root");
    let repo = GixRepo::discover(dir.path()).unwrap();
    assert!(
        select(
            &repo,
            Selection::Branch {
                reference: "main".into()
            }
        )
        .unwrap_err()
        .to_string()
        .contains("no_merge_base")
    );
}

#[test]
fn conflicted_indexes_fail_local_modes_but_commit_mode_is_available() {
    let dir = init();
    write(dir.path(), "a.ts", "base\n");
    commit(dir.path(), "base");
    git(dir.path(), &["checkout", "-b", "feature"]);
    write(dir.path(), "a.ts", "feature\n");
    commit(dir.path(), "feature");
    git(dir.path(), &["checkout", "main"]);
    write(dir.path(), "a.ts", "main\n");
    commit(dir.path(), "main");
    let output = Command::new("git")
        .args(["merge", "feature"])
        .current_dir(dir.path())
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(
        fs::read_to_string(dir.path().join("a.ts"))
            .unwrap()
            .contains("<<<<<<<"),
        "merge did not create a conflict: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let repo = GixRepo::discover(dir.path()).unwrap();
    for selection in [Selection::WorkingTree, Selection::Staged] {
        let error = select(&repo, selection).unwrap_err().to_string();
        assert!(
            error.contains("conflicted_index") && error.contains("a.ts"),
            "{error}"
        );
    }
    select(
        &repo,
        Selection::Branch {
            reference: "feature".into(),
        },
    )
    .unwrap();
}

#[test]
fn sparse_checkout_does_not_invent_deletions() {
    let dir = init();
    write(dir.path(), "services/api/a.ts", "export const x = 1;\n");
    write(dir.path(), "services/billing/b.ts", "export const y = 2;\n");
    commit(dir.path(), "base");
    git(dir.path(), &["sparse-checkout", "init", "--cone"]);
    git(dir.path(), &["sparse-checkout", "set", "services/api"]);
    assert!(!dir.path().join("services/billing/b.ts").exists());
    let repo = GixRepo::discover(dir.path()).unwrap();
    assert!(
        repo.index_entries()
            .unwrap()
            .iter()
            .any(|entry| entry.skip_worktree)
    );
    let changes = select(&repo, Selection::WorkingTree).unwrap();
    assert!(changed_paths(&changes.base, &changes.head).is_empty());
}

#[test]
fn shallow_history_error_suggests_fetching_more_history() {
    let source = init();
    write(source.path(), "a.ts", "base\n");
    commit(source.path(), "base");
    git(source.path(), &["checkout", "-b", "feature"]);
    write(source.path(), "a.ts", "feature\n");
    commit(source.path(), "feature");
    git(source.path(), &["checkout", "main"]);
    write(source.path(), "a.ts", "main\n");
    commit(source.path(), "main");
    let clone = tempfile::tempdir().unwrap();
    git(
        clone.path(),
        &[
            "clone",
            "--depth=1",
            "--no-single-branch",
            &format!("file://{}", source.path().display()),
            "repo",
        ],
    );
    let repo = GixRepo::discover(clone.path().join("repo")).unwrap();
    assert!(repo.is_shallow().unwrap());
    let error = select(
        &repo,
        Selection::Branch {
            reference: "origin/feature".into(),
        },
    )
    .unwrap_err()
    .to_string();
    assert!(
        error.contains("shallow_history") && error.contains("--unshallow"),
        "{error}"
    );
}

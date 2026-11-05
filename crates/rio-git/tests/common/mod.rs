#![allow(dead_code)] // Shared helpers are used by independent integration-test binaries.

use std::{fs, path::Path, process::Command};

pub fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args([
            "-c",
            "user.name=Rio Tests",
            "-c",
            "user.email=tests@rio.invalid",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .current_dir(root)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

pub fn init() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    git(dir.path(), &["init", "-b", "main"]);
    // Direct Git operations such as merge also need an isolated identity;
    // CI must not depend on a developer's global Git configuration.
    git(dir.path(), &["config", "user.name", "Rio Tests"]);
    git(dir.path(), &["config", "user.email", "tests@rio.invalid"]);
    git(dir.path(), &["config", "commit.gpgsign", "false"]);
    dir
}

pub fn write(root: &Path, path: &str, content: &str) {
    let path = root.join(path);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

pub fn commit(root: &Path, message: &str) -> String {
    git(root, &["add", "."]);
    git(root, &["commit", "-m", message]);
    git(root, &["rev-parse", "HEAD"])
}

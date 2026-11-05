#![cfg(unix)]
#[path = "../../rio-adapters/tests/common/mod.rs"]
mod common;
use common::*;
use rio_git::SafeTreeWriter;
use serde_json::Value;
use std::{fs, path::Path, process::Command};
fn git(root: &Path, args: &[&str]) {
    let result = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}
// Preserve dependency-store links while redirecting workspace-source links into
// this test repository. Installation directories remain ignored and untracked.
fn installation(source: &Path, target: &Path, source_root: &Path, target_root: &Path) {
    fs::create_dir_all(target).unwrap();
    for entry in fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let path = entry.path();
        let destination = target.join(entry.file_name());
        let resolved = path.canonicalize().unwrap();
        if entry.file_type().unwrap().is_symlink()
            && resolved.starts_with(source_root)
            && !resolved
                .components()
                .any(|component| component.as_os_str() == "node_modules")
        {
            std::os::unix::fs::symlink(
                target_root.join(resolved.strip_prefix(source_root).unwrap()),
                destination,
            )
            .unwrap();
        } else if entry.file_type().unwrap().is_dir() && (entry.file_name() == "@acme") {
            installation(&path, &destination, source_root, target_root);
        } else {
            std::os::unix::fs::symlink(path, destination).unwrap();
        }
    }
}
fn run_fixture(name: &str) {
    let source = fixture(name);
    let python = name == "py-sample";
    let tools = if python {
        source.join(".venv/bin/mypy").exists()
            && source.join(".venv/bin/ruff").exists()
            && source.join(".venv/bin/coverage").exists()
    } else {
        source.join("node_modules/.bin/tsc").exists()
            && source.join("node_modules/.bin/vitest").exists()
    };
    if !require_tool(tools, name) {
        return;
    }
    let mut temp = tempfile::tempdir().unwrap();
    if std::env::var_os("RIO_DEBUG_FIXTURE").is_some() {
        temp.disable_cleanup(true);
        eprintln!("Fixture retained at {}", temp.path().display());
    }
    let root = temp.path();
    SafeTreeWriter::new(root)
        .unwrap()
        .write_tree(&read_tree(&source))
        .unwrap();
    fs::write(
        root.join(".gitignore"),
        "node_modules/\n.venv/\n.rio/cache/\n__pycache__/\n",
    )
    .unwrap();
    if python {
        std::os::unix::fs::symlink(source.join(".venv"), root.join(".venv")).unwrap();
    } else {
        installation(
            &source.join("node_modules"),
            &root.join("node_modules"),
            &source,
            root,
        );
        if name == "monorepo-sample" {
            installation(
                &source.join("packages/api/node_modules"),
                &root.join("packages/api/node_modules"),
                &source,
                root,
            );
        }
    }
    git(root, &["init", "-b", "main"]);
    git(root, &["config", "user.name", "Rio fixture"]);
    git(root, &["config", "user.email", "rio@example.invalid"]);
    git(root, &["add", "."]);
    git(root, &["commit", "-m", "base"]);
    if python {
        fs::write(root.join("src/sample/duplicate.py"),"def duplicate(value: str | None) -> int:\n    first = len(value)\n    second = len(value)\n    return first + second\n").unwrap();
        fs::write(root.join("src/sample/untested.py"),"def classify(value: int) -> str:\n    if value > 1:\n        return 'greater'\n    return 'small'\n").unwrap();
    } else if name == "ts-sample" {
        fs::write(
            root.join("src/math.ts"),
            "export function format(value: string): string {\n return value.toUpperCase();\n}\n",
        )
        .unwrap();
        fs::write(root.join("src/duplicate.ts"),"export function duplicate(value?: {name:string}):string {\n const first = value.name;\n const second = value.name;\n return first + second;\n}\n").unwrap();
        fs::write(root.join("src/untested.ts"),"export function untested(value:number):string {\n if(value>3) return 'greater';\n return 'small';\n}\n").unwrap();
    } else {
        fs::write(
            root.join("packages/shared/src/index.ts"),
            "export function double(value: string): string {\n return value + value;\n}\n",
        )
        .unwrap();
    }
    let mut keys = Vec::new();
    for mode in ["working", "staged", "base"] {
        if mode == "staged" {
            git(root, &["add", "."]);
        }
        if mode == "base" {
            git(root, &["checkout", "-b", "feature"]);
            git(root, &["commit", "-m", "change"]);
        }
        for format in ["json", "terminal", "md"] {
            let mut command = assert_cmd::Command::new(assert_cmd::cargo::cargo_bin!("rio"));
            command
                .current_dir(root)
                .env("RIO_CONFIG_DIR", root.join("config"))
                .env("NO_COLOR", "1");
            for variable in [
                "RIO_ENDPOINT_URL",
                "RIO_CACHE_DIR",
                "RIO_PARALLELISM",
                "RIO_OUTPUT_LIMIT",
                "VIRTUAL_ENV",
            ] {
                command.env_remove(variable);
            }
            command.args(["review", "--offline", "--format", format]);
            if mode == "staged" {
                command.arg("--staged");
            }
            if mode == "base" {
                command.args(["--base", "main"]);
            }
            let result = command.output().unwrap();
            assert_eq!(
                result.status.code(),
                Some(if name == "monorepo-sample" { 0 } else { 1 }),
                "{name} {mode} {format}: {}\n{}",
                String::from_utf8_lossy(&result.stdout),
                String::from_utf8_lossy(&result.stderr)
            );
            if format == "json" {
                let report: Value = serde_json::from_slice(&result.stdout).unwrap();
                let schema: Value =
                    serde_json::from_str(include_str!("../../../schemas/report-v1.json")).unwrap();
                assert!(
                    jsonschema::validator_for(&schema)
                        .unwrap()
                        .is_valid(&report)
                );
                if name == "monorepo-sample" {
                    // The shared workspace source cannot be baselined through
                    // installation links. Its unchanged caller is outside the
                    // fallback hunks and remains available as pre-existing.
                    let findings = report["findings"].as_array().unwrap();
                    assert!(!findings.is_empty());
                    for finding in findings {
                        assert_eq!(finding["state"], "pre-existing");
                        assert_eq!(finding["location"]["path"], "packages/api/src/index.ts");
                        assert!(
                            finding["evidence"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .any(|evidence| {
                                    evidence
                                        .as_str()
                                        .unwrap()
                                        .contains("outside changed hunks, baseline unavailable")
                                })
                        );
                    }
                    assert!(
                        report["footer"]["notes"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|note| { note.as_str().unwrap().contains("baseline_failed") })
                    );
                } else {
                    assert!(
                        report["findings"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|finding| {
                                finding["state"] == "new" || finding["state"] == "worsened"
                            }),
                        "{name}: {}",
                        report["checks"]
                    );
                }
                if name != "monorepo-sample" {
                    assert!(
                        report["findings"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|finding| finding["state"] == "worsened"),
                        "{name}: {}",
                        report["findings"]
                    );
                    assert!(
                        report["findings"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|finding| finding["state"] == "pre-existing")
                    );
                }
                assert!(
                    report["checks"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|check| check["kind"] == "coverage")
                );
                assert!(
                    report["footer"]["notes"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|note| note.as_str().unwrap().contains("not network-isolated"))
                );
                if name == "monorepo-sample" {
                    assert!(
                        report["checks"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|check| check["root"] == "packages/api"
                                && check["scheduled_as"] == "dependent")
                    );
                    assert!(
                        !report["checks"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|check| check["root"] == "packages/web")
                    );
                }
                keys.push(report["review"]["id"].clone());
            } else {
                let text = String::from_utf8_lossy(&result.stdout);
                assert!(
                    text.contains("worsened")
                        || text.contains("new")
                        || text.contains("unclassified")
                );
                assert!(text.contains("Footer"));
                assert!(!text.contains('\x1b'));
                if format == "md" {
                    assert!(text.contains("## Findings"));
                }
                if name == "monorepo-sample" {
                    assert!(text.contains("0 unclassified: baseline_failed"));
                    assert!(!text.contains("Argument of type"));
                    if mode == "working" {
                        let expanded = command.arg("--show-pre-existing").output().unwrap();
                        assert_eq!(expanded.status.code(), Some(0));
                        let text = String::from_utf8_lossy(&expanded.stdout);
                        assert!(text.contains("pre-existing"));
                        assert!(text.contains("Argument of type"));
                    }
                }
            }
        }
    }
    assert_eq!(keys[0], keys[1]);
}
#[test]
fn typescript_fixture_all_modes_and_formats() {
    run_fixture("ts-sample");
}
#[test]
fn python_fixture_all_modes_and_formats() {
    run_fixture("py-sample");
}
#[test]
fn workspace_fixture_all_modes_and_formats() {
    run_fixture("monorepo-sample");
}

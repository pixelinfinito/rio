use assert_cmd::Command;
use serde_json::Value;
use std::{fs, path::Path, process::Command as Process};

fn git(root: &Path, args: &[&str]) {
    let output = Process::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
fn repository() -> tempfile::TempDir {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    git(root, &["init", "-b", "main"]);
    git(root, &["config", "user.name", "Rio test"]);
    git(root, &["config", "user.email", "rio@example.invalid"]);
    fs::write(root.join(".gitignore"), ".rio/cache/\nnode_modules/\n").unwrap();
    fs::write(root.join("a.txt"), "one\n").unwrap();
    git(root, &["add", "."]);
    git(root, &["commit", "-m", "base"]);
    temp
}
fn rio(root: &Path) -> Command {
    let mut cmd = Command::new(assert_cmd::cargo::cargo_bin!("rio"));
    cmd.current_dir(root)
        .env("RIO_CONFIG_DIR", root.join("user-config"))
        .env("NO_COLOR", "1");
    for variable in [
        "RIO_CACHE_DIR",
        "RIO_CACHE_MAX_AGE",
        "RIO_CACHE_MAX_SIZE",
        "RIO_CACHE_RETAIN_RAW_OUTPUT",
        "RIO_PARALLELISM",
        "RIO_OUTPUT_LIMIT",
        "RIO_ENDPOINT_URL",
        "VIRTUAL_ENV",
    ] {
        cmd.env_remove(variable);
    }
    cmd
}
fn json_report(output: &std::process::Output) -> Value {
    let value: Value = serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
        panic!(
            "{error}: {}\nstderr: {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    });
    let schema: Value =
        serde_json::from_str(include_str!("../../../schemas/report-v1.json")).unwrap();
    assert!(jsonschema::validator_for(&schema).unwrap().is_valid(&value));
    value
}
#[test]
fn version_contains_version_target_and_commit() {
    let temp = tempfile::tempdir().unwrap();
    let output = rio(temp.path())
        .arg("--version")
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let text = String::from_utf8(output).unwrap();
    let fields: Vec<_> = text.split_whitespace().collect();
    assert_eq!(fields.len(), 4);
    assert_eq!(
        fields[1],
        option_env!("RIO_BUILD_VERSION").unwrap_or(env!("CARGO_PKG_VERSION"))
    );
    assert!(fields[2].contains('-'));
    assert!(fields[3].chars().all(|ch| ch.is_ascii_hexdigit()) || fields[3] == "unknown");
}
#[test]
fn deployment_dry_run_needs_no_checkout_toolchain_or_credentials() {
    let temp = tempfile::tempdir().unwrap();
    let config = temp.path().join("deployment-config");
    let output = rio(temp.path())
        .env("RIO_CONFIG_DIR", &config)
        .env("PATH", "")
        .env_remove("CLOUDFLARE_API_TOKEN")
        .env_remove("CLOUDFLARE_ACCOUNT_ID")
        .args([
            "init",
            "--dry-run",
            "--account",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "--runner",
            "self-hosted",
        ])
        .assert()
        .success()
        .get_output()
        .clone();
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["mutations"], false);
    assert_eq!(value["sandbox"], false);
    assert_eq!(
        value["deployment"]["account_id"],
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );
    assert!(!config.exists());
    rio(temp.path())
        .args(["init", "--endpoint", "https://example.com", "--dry-run"])
        .assert()
        .code(2);
}
#[test]
fn errors_and_empty_changes_emit_exactly_one_json_document() {
    let temp = tempfile::tempdir().unwrap();
    let output = rio(temp.path())
        .args(["review", "--format", "json"])
        .assert()
        .code(3)
        .get_output()
        .clone();
    let report = json_report(&output);
    assert_eq!(report["error"]["code"], "not_a_repository");
    let temp = repository();
    let output = rio(temp.path())
        .args(["review", "--format", "json"])
        .assert()
        .success()
        .get_output()
        .clone();
    let report = json_report(&output);
    assert_eq!(report["status"], "no_changes");
    assert!(String::from_utf8_lossy(&output.stderr).contains("No changes to review"));
    assert!(report["checks"].as_array().unwrap().is_empty());
    fs::write(
        temp.path().join("broken.yaml"),
        "version: 1\nname: broken\nunknown: true\n",
    )
    .unwrap();
    let output = rio(temp.path())
        .args(["review", "--format", "json", "--profile", "broken.yaml"])
        .assert()
        .code(2)
        .get_output()
        .clone();
    assert_eq!(json_report(&output)["error"]["code"], "invalid_profile");
    assert!(String::from_utf8_lossy(&output.stderr).contains('$'));
    let output = rio(temp.path())
        .args(["review", "--format", "md", "--profile", "broken.yaml"])
        .assert()
        .code(2)
        .get_output()
        .clone();
    assert!(output.stdout.is_empty());
}
#[test]
fn selectors_and_endpoint_only_flags_fail_before_review() {
    let temp = repository();
    let output = rio(temp.path())
        .args(["review", "--staged", "--base", "main"])
        .assert()
        .code(2)
        .get_output()
        .clone();
    assert!(String::from_utf8_lossy(&output.stderr).contains("cannot be used"));
    for args in [
        vec!["--pr", "123"],
        vec!["--deep"],
        vec!["--fork"],
        vec!["--publish"],
        vec!["--since-last"],
    ] {
        let output = rio(temp.path())
            .args(["review", "--format", "json"])
            .args(&args)
            .assert()
            .code(2)
            .get_output()
            .clone();
        let report = json_report(&output);
        assert_eq!(report["error"]["code"], "endpoint_required");
        let message = report["error"]["message"].as_str().unwrap();
        assert!(message.contains(args[0]));
        assert!(message.contains("configured endpoint") || message.contains("not implemented"));
    }
}
#[test]
fn formats_and_selection_modes_preserve_stdout_separation() {
    let temp = repository();
    let root = temp.path();
    fs::write(root.join("a.txt"), "two\n").unwrap();
    git(root, &["add", "a.txt"]);
    fs::write(root.join("a.txt"), "three\n").unwrap();
    for (flags, mode) in [(vec![], "working-tree"), (vec!["--staged"], "staged")] {
        let output = rio(root)
            .args(["review", "--offline", "--format", "json"])
            .args(flags)
            .assert()
            .success()
            .get_output()
            .clone();
        let report = json_report(&output);
        assert_eq!(report["review"]["mode"], mode);
        assert!(String::from_utf8_lossy(&output.stderr).contains("Running"));
        assert!(
            report["deferred"]
                .as_array()
                .unwrap()
                .iter()
                .any(|step| step["step"] == "agents")
        );
    }
    git(root, &["checkout", "-b", "feature"]);
    git(root, &["add", "a.txt"]);
    git(root, &["commit", "-m", "change"]);
    for format in ["json", "md", "terminal"] {
        let output = rio(root)
            .args(["review", "--base", "main", "--offline", "--format", format])
            .assert()
            .success()
            .get_output()
            .clone();
        if format == "json" {
            assert_eq!(json_report(&output)["review"]["mode"], "branch");
        } else {
            let text = String::from_utf8_lossy(&output.stdout);
            assert!(text.contains("No findings were produced"));
            assert!(!text.contains('\x1b'));
            if format == "md" {
                assert!(text.contains("## Findings"));
            }
        }
    }
}
#[test]
fn planted_secret_is_redacted_and_sets_exit_one() {
    let temp = repository();
    let token = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
    fs::write(temp.path().join("a.txt"), format!("token = '{token}'\n")).unwrap();
    let output = rio(temp.path())
        .args(["review", "--format", "json", "--offline"])
        .assert()
        .code(1)
        .get_output()
        .clone();
    let report = json_report(&output);
    assert!(
        report["findings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["rule_id"] == "secret/github-token")
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains(token));
}
#[test]
fn profiles_show_list_raw_validate_and_third_party_rejection() {
    let temp = repository();
    let root = temp.path();
    let repo_dir = root.join(".rio/profiles");
    let personal = root.join("user-config/profiles");
    fs::create_dir_all(&repo_dir).unwrap();
    fs::create_dir_all(&personal).unwrap();
    let content = "version: 1\nname: repo-default\nextends: rio/base\n";
    fs::write(repo_dir.join("default.yaml"), content).unwrap();
    fs::write(
        personal.join("default.yaml"),
        content.replace("repo-default", "personal-default"),
    )
    .unwrap();
    let output = rio(root)
        .args(["profile", "list"])
        .assert()
        .success()
        .get_output()
        .clone();
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(text.contains("* repo-default [repo]"));
    assert!(text.contains("personal-default [personal]"));
    assert!(!text.contains("* personal-default"));
    let output = rio(root)
        .args(["profile", "show", "default"])
        .assert()
        .success()
        .get_output()
        .clone();
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(text.contains("rio/checks@0.1.0"));
    assert!(text.contains("# Chain:"));
    let output = rio(root)
        .args(["profile", "show", "default", "--raw"])
        .assert()
        .success()
        .get_output()
        .clone();
    assert!(String::from_utf8_lossy(&output.stdout).contains(content));
    let output = rio(root)
        .args(["profile", "validate"])
        .assert()
        .success()
        .get_output()
        .clone();
    assert!(String::from_utf8_lossy(&output.stderr).contains("deferred"));
    fs::write(
        repo_dir.join("bad.yaml"),
        "version: 1\nname: bad\nsteps:\n  - id: custom\n    uses: acme/agent-foo@1.0.0\n",
    )
    .unwrap();
    let output = rio(root)
        .args(["profile", "validate", "bad"])
        .assert()
        .code(2)
        .get_output()
        .clone();
    assert!(String::from_utf8_lossy(&output.stderr).contains("third-party"));
}
#[test]
fn configuration_precedence_sources_unknown_keys_and_endpoint_notice() {
    let temp = repository();
    let root = temp.path();
    fs::create_dir_all(root.join("user-config")).unwrap();
    let file = root.join("user-config/config.toml");
    fs::write(
        &file,
        "[run]\nparallelism = 2\n[endpoint]\nurl = 'https://example.invalid'\n",
    )
    .unwrap();
    let output = rio(root)
        .env("RIO_PARALLELISM", "1")
        .args(["doctor", "--format", "json"])
        .assert()
        .success()
        .get_output()
        .clone();
    let doc: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(doc["configuration"]["parallelism"], 1);
    assert_eq!(
        doc["configuration"]["sources"]["run.parallelism"],
        "RIO_PARALLELISM"
    );
    assert_eq!(doc["endpoint"], "https://example.invalid");
    fs::write(root.join("a.txt"), "changed\n").unwrap();
    let output = rio(root)
        .args(["review", "--offline", "--format", "json"])
        .assert()
        .success()
        .get_output()
        .clone();
    json_report(&output);
    assert!(!String::from_utf8_lossy(&output.stderr).contains("not supported in this version"));
    fs::write(&file, "[cache]\nmaxage = '7d'\n").unwrap();
    let output = rio(root)
        .args(["review", "--format", "json"])
        .assert()
        .code(2)
        .get_output()
        .clone();
    let report = json_report(&output);
    assert!(
        report["error"]["message"]
            .as_str()
            .unwrap()
            .contains("cache.maxage")
    );
    assert!(
        report["error"]["message"]
            .as_str()
            .unwrap()
            .contains("config.toml")
    );
}
#[test]
fn doctor_warns_on_missing_tools_and_blocks_on_unwritable_cache() {
    let temp = repository();
    let root = temp.path();
    fs::write(root.join("package.json"), "{}").unwrap();
    fs::write(root.join("tsconfig.json"), "{}").unwrap();
    fs::write(root.join("a.ts"), "const x=1;\n").unwrap();
    let output = rio(root)
        .env("PATH", "")
        .args(["doctor", "--format", "json"])
        .assert()
        .success()
        .get_output()
        .clone();
    let doc: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(
        doc["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|warning| warning.as_str().unwrap().contains("tool_missing"))
    );
    assert!(doc["blocking_problems"].as_array().unwrap().is_empty());
    let output = rio(root)
        .env("PATH", "")
        .args(["review", "--format", "json", "--offline"])
        .assert()
        .success()
        .get_output()
        .clone();
    let review = json_report(&output);
    for check in doc["plan"]["checks"].as_array().unwrap() {
        if let Some(skip) = check["skip"].as_object() {
            assert!(
                review["checks"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|outcome| outcome["kind"] == check["kind"]
                        && outcome["root"] == check["root"]
                        && outcome["reason"] == skip["reason"])
            );
        }
    }
    fs::write(root.join("blocked-cache"), "file").unwrap();
    let output = rio(root)
        .env("RIO_CACHE_DIR", root.join("blocked-cache"))
        .args(["doctor", "--format", "json"])
        .assert()
        .code(1)
        .get_output()
        .clone();
    let doc: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(doc["cache"]["writable"], false);
}
#[test]
fn conflict_refusal_shallow_message_and_sparse_checkout_policy() {
    let temp = repository();
    let root = temp.path();
    git(root, &["checkout", "-b", "side"]);
    fs::write(root.join("a.txt"), "side\n").unwrap();
    git(root, &["commit", "-am", "side"]);
    git(root, &["checkout", "main"]);
    fs::write(root.join("a.txt"), "main\n").unwrap();
    git(root, &["commit", "-am", "main"]);
    assert!(
        !Process::new("git")
            .arg("-C")
            .arg(root)
            .args(["merge", "side"])
            .output()
            .unwrap()
            .status
            .success()
    );
    for mode in [vec![], vec!["--staged"]] {
        let output = rio(root)
            .args(["review", "--format", "json"])
            .args(mode)
            .assert()
            .code(3)
            .get_output()
            .clone();
        assert_eq!(json_report(&output)["error"]["code"], "conflicted_index");
    }
    git(root, &["merge", "--abort"]);
    git(root, &["checkout", "side"]);
    git(root, &["checkout", "main"]);
    let clone = tempfile::tempdir().unwrap();
    let output = Process::new("git")
        .args(["clone", "--depth=1", "--no-single-branch"])
        .arg(format!("file://{}", root.display()))
        .arg(clone.path())
        .output()
        .unwrap();
    assert!(output.status.success());
    let output = rio(clone.path())
        .args(["review", "--base", "origin/side", "--format", "json"])
        .assert()
        .code(3)
        .get_output()
        .clone();
    let report = json_report(&output);
    assert_eq!(report["error"]["code"], "shallow_history");
    assert!(
        report["error"]["message"]
            .as_str()
            .unwrap()
            .contains("--unshallow")
    );
    fs::create_dir(root.join("selected")).unwrap();
    fs::create_dir(root.join("hidden")).unwrap();
    fs::write(root.join("selected/a.txt"), "a").unwrap();
    fs::write(root.join("hidden/b.txt"), "b").unwrap();
    git(root, &["add", "."]);
    git(root, &["commit", "-m", "directories"]);
    git(root, &["sparse-checkout", "set", "selected"]);
    let output = rio(root)
        .args(["review", "--format", "json"])
        .assert()
        .success()
        .get_output()
        .clone();
    assert_eq!(json_report(&output)["status"], "no_changes");
}

#[cfg(unix)]
fn fake_typescript(root: &Path, body: &str) {
    use std::os::unix::fs::PermissionsExt;
    fs::create_dir_all(root.join("node_modules/.bin")).unwrap();
    fs::write(
        root.join("node_modules/.bin/tsc"),
        format!(
            "#!/bin/sh\nif [ \"$1\" = --version ]; then echo 'Version 5.7.3'; exit 0; fi\n{body}\n"
        ),
    )
    .unwrap();
    fs::set_permissions(
        root.join("node_modules/.bin/tsc"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    fs::write(
        root.join("package.json"),
        "{\"name\":\"fixture\",\"version\":\"1.0.0\",\"dependencies\":{}}",
    )
    .unwrap();
    let lock =
        "{\"lockfileVersion\":3,\"packages\":{\"\":{\"name\":\"fixture\",\"version\":\"1.0.0\"}}}";
    fs::write(root.join("package-lock.json"), lock).unwrap();
    fs::write(root.join("node_modules/.package-lock.json"), lock).unwrap();
    fs::write(root.join("tsconfig.json"), "{}").unwrap();
    fs::write(root.join("a.ts"), "const x=1;\n").unwrap();
    git(root, &["add", "."]);
    git(root, &["commit", "-m", "typescript"]);
    fs::write(root.join("a.ts"), "const x=2;\n").unwrap();
}
#[cfg(unix)]
#[test]
fn tool_failure_is_incomplete_and_doctor_prefers_project_local_tool() {
    let temp = repository();
    let root = temp.path();
    fake_typescript(root, "exit 3");
    let output = rio(root)
        .args(["doctor", "--format", "json"])
        .assert()
        .success()
        .get_output()
        .clone();
    let doctor: Value = serde_json::from_slice(&output.stdout).unwrap();
    let tsc = doctor["plan"]["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["kind"] == "typecheck")
        .unwrap();
    assert!(
        Path::new(tsc["tool"]["path"].as_str().unwrap())
            .canonicalize()
            .unwrap()
            .starts_with(root.canonicalize().unwrap())
    );
    assert_eq!(tsc["tool"]["version"], "Version 5.7.3");
    assert!(tsc["skip"].is_null());
    let output = rio(root)
        .args(["review", "--format", "json", "--offline"])
        .assert()
        .code(4)
        .get_output()
        .clone();
    let report = json_report(&output);
    assert_eq!(report["status"], "incomplete");
    assert!(report["findings"].as_array().unwrap().is_empty());
    assert!(
        report["checks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["reason"] == "tool_crashed")
    );
    fs::write(
        root.join("policy.yaml"),
        "version: 1\nname: policy\nextends: rio/base\nfail_on:\n  incomplete: false\n",
    )
    .unwrap();
    rio(root)
        .args(["review", "--offline", "--profile", "policy.yaml"])
        .assert()
        .success();
    fs::write(
        root.join("policy.yaml"),
        "version: 1\nname: policy\nextends: rio/base\nfail_on:\n  required_checks: [lint]\n",
    )
    .unwrap();
    rio(root)
        .env("PATH", "")
        .args(["review", "--offline", "--profile", "policy.yaml"])
        .assert()
        .code(4);
}
#[cfg(unix)]
#[test]
fn doctor_and_review_agree_on_dependency_mismatch() {
    let temp = repository();
    let root = temp.path();
    fake_typescript(root, "exit 0");
    fs::write(root.join("package-lock.json"),"{\"lockfileVersion\":3,\"packages\":{\"\":{\"name\":\"fixture\",\"version\":\"1.0.0\",\"dependencies\":{\"react\":\"18.0.0\"}},\"node_modules/react\":{\"name\":\"react\",\"version\":\"18.0.0\"}}}").unwrap();
    let output = rio(root)
        .args(["doctor", "--format", "json"])
        .assert()
        .success()
        .get_output()
        .clone();
    let doc: Value = serde_json::from_slice(&output.stdout).unwrap();
    let check = doc["plan"]["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["kind"] == "typecheck")
        .unwrap();
    assert!(check["tool"].is_object());
    assert_eq!(check["skip"]["reason"], "dependency_mismatch");
    let output = rio(root)
        .args(["review", "--format", "json", "--offline"])
        .assert()
        .success()
        .get_output()
        .clone();
    let report = json_report(&output);
    assert!(
        report["checks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["kind"] == "typecheck" && c["reason"] == "dependency_mismatch")
    );
}
#[cfg(unix)]
#[test]
fn no_color_environment_overrides_renderer_color_request() {
    let temp = repository();
    fs::write(temp.path().join("a.txt"), "changed").unwrap();
    let output = rio(temp.path())
        .env("NO_COLOR", "")
        .args(["review", "--offline"])
        .assert()
        .success()
        .get_output()
        .clone();
    assert!(!output.stdout.contains(&0x1b));
}

#[cfg(unix)]
#[test]
fn interrupts_preserve_one_partial_document_and_second_interrupt_emits_none() {
    use std::time::{Duration, Instant};
    for twice in [false, true] {
        let temp = repository();
        let root = temp.path();
        // Ignore TERM so the second interrupt is tested during the cleanup grace period.
        fake_typescript(
            root,
            &format!(
                "trap '' TERM\necho $$ > '{}'\nwhile :; do /bin/sleep 1; done",
                root.join("worker.pid").display()
            ),
        );
        let setup = rio(root);
        let mut command = Process::new(setup.get_program());
        command.current_dir(root);
        for (key, value) in setup.get_envs() {
            if let Some(value) = value {
                command.env(key, value);
            } else {
                command.env_remove(key);
            }
        }
        let mut child = command
            .args(["review", "--format", "json", "--offline"])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let started = Instant::now();
        while !root.join("worker.pid").exists() {
            if started.elapsed() >= Duration::from_secs(30) {
                let _ = child.kill();
                let output = child.wait_with_output().unwrap();
                panic!(
                    "tool did not start: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let worker: i32 = fs::read_to_string(root.join("worker.pid"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        // SAFETY: signaling only the child CLI started by this test.
        unsafe {
            libc::kill(child.id() as i32, libc::SIGINT);
        }
        if twice {
            std::thread::sleep(Duration::from_millis(200));
            unsafe {
                libc::kill(child.id() as i32, libc::SIGINT);
            }
        }
        let deadline = Instant::now() + Duration::from_secs(20);
        while child.try_wait().unwrap().is_none() {
            if Instant::now() >= deadline {
                let _ = child.kill();
                let output = child.wait_with_output().unwrap();
                panic!(
                    "interrupt cleanup did not finish: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let output = child.wait_with_output().unwrap();
        if twice {
            assert_eq!(output.status.code(), Some(130));
            assert!(output.stdout.is_empty());
        } else {
            assert_eq!(output.status.code(), Some(4));
            let report = json_report(&output);
            assert_eq!(report["status"], "partial");
            assert!(
                report["checks"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|check| check["reason"] == "interrupted")
            );
        }
        // A killed, orphaned process may briefly be a zombie on platforms with slow reaping.
        #[cfg(target_os = "linux")]
        {
            let path = std::path::PathBuf::from(format!("/proc/{worker}/stat"));
            let deadline = Instant::now() + Duration::from_secs(5);
            while path.exists() {
                let stat = fs::read_to_string(&path).unwrap_or_default();
                if stat.split_whitespace().nth(2) == Some("Z") {
                    break;
                }
                assert!(Instant::now() < deadline, "worker {worker} survived");
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            let deadline = Instant::now() + Duration::from_secs(5);
            // SAFETY: signal zero only checks this test's worker for survival.
            while unsafe { libc::kill(worker, 0) } == 0 {
                assert!(Instant::now() < deadline, "worker {worker} survived");
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
}

#[cfg(unix)]
#[test]
fn concurrent_cli_processes_publish_two_runs_and_share_the_baseline() {
    let temp = repository();
    let root = temp.path();
    fake_typescript(root, "/bin/sleep 1\nexit 0");
    let mut processes = Vec::new();
    for _ in 0..2 {
        let setup = rio(root);
        let mut command = Process::new(setup.get_program());
        command.current_dir(root);
        for (key, value) in setup.get_envs() {
            if let Some(value) = value {
                command.env(key, value);
            } else {
                command.env_remove(key);
            }
        }
        processes.push(
            command
                .args(["review", "--format", "json", "--offline"])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .unwrap(),
        );
    }
    let reports: Vec<_> = processes
        .into_iter()
        .map(|process| {
            let output = process.wait_with_output().unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            json_report(&output)
        })
        .collect();
    assert_eq!(reports[0]["review"]["id"], reports[1]["review"]["id"]);
    assert_ne!(
        reports[0]["review"]["run_id"],
        reports[1]["review"]["run_id"]
    );
    let baselines: Vec<_> = reports
        .iter()
        .flat_map(|report| report["checks"].as_array().unwrap())
        .filter(|check| check["kind"] == "typecheck" && check["version"] == "base")
        .collect();
    assert_eq!(baselines.len(), 2);
    assert_eq!(
        baselines
            .iter()
            .filter(|check| check["cached"] == true)
            .count(),
        1
    );
    for report in &reports {
        let path = root
            .join(".rio/cache")
            .join(report["review"]["id"].as_str().unwrap())
            .join("runs")
            .join(report["review"]["run_id"].as_str().unwrap());
        assert!(path.join("report.json").is_file());
        assert!(path.join("profile.resolved.yaml").is_file());
        assert!(path.join("graph/base.json").is_file());
    }
}

#[test]
fn doctor_limits_clean_and_changed_monorepos_and_all_roots_is_explicit() {
    let temp = repository();
    let root = temp.path();
    for package in ["a", "b"] {
        let directory = root.join("packages").join(package);
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("package.json"),
            format!(r#"{{"name":"{package}"}}"#),
        )
        .unwrap();
        fs::write(directory.join("index.ts"), "export const value = 1;\n").unwrap();
    }
    git(root, &["add", "."]);
    git(root, &["commit", "-m", "monorepo"]);
    let output = rio(root)
        .args(["doctor", "--format", "json"])
        .assert()
        .success()
        .get_output()
        .clone();
    let document: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(document["plan"]["roots"].as_array().unwrap().is_empty());
    assert!(!String::from_utf8_lossy(&output.stderr).contains("Checking root"));
    let output = rio(root)
        .args(["doctor", "--all-roots", "--format", "json"])
        .assert()
        .success()
        .get_output()
        .clone();
    let document: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(document["plan"]["roots"].as_array().unwrap().len(), 2);
    for package in ["a", "b"] {
        assert!(
            String::from_utf8_lossy(&output.stderr)
                .contains(&format!("Checking root packages/{package}"))
        );
    }
    fs::write(
        root.join("packages/a/index.ts"),
        "export const value = 2;\n",
    )
    .unwrap();
    let output = rio(root)
        .args(["doctor", "--format", "json"])
        .assert()
        .success()
        .get_output()
        .clone();
    let document: Value = serde_json::from_slice(&output.stdout).unwrap();
    let roots = document["plan"]["roots"].as_array().unwrap();
    assert_eq!(roots.len(), 1);
    assert_eq!(roots[0]["project"]["path"], "packages/a");
    assert!(String::from_utf8_lossy(&output.stderr).contains("Checking root packages/a"));
}

#[cfg(unix)]
#[test]
fn doctor_all_roots_preserves_selected_base_dependencies_for_root_and_nested_projects() {
    use std::os::unix::fs::PermissionsExt;

    let lockfile = |version| {
        format!("version = 1\n[[package]]\nname = 'sample-dependency'\nversion = '{version}'\n")
    };
    for (nested_version, nested_state, nested_baseline) in [
        (Some("1.0.0"), "verified", true),
        (Some("2.0.0"), "mismatch", false),
        (None, "unverified", false),
    ] {
        let temp = repository();
        let root = temp.path();
        fs::write(root.join(".gitignore"), ".rio/cache/\n.venv/\n").unwrap();
        for project in [".", "nested"] {
            let directory = root.join(project);
            fs::create_dir_all(&directory).unwrap();
            fs::write(
                directory.join("pyproject.toml"),
                "[project]\nname = 'fixture'\nversion = '0.1.0'\n[tool.mypy]\n[tool.ruff]\n",
            )
            .unwrap();
            fs::write(directory.join("app.py"), "value = 1\n").unwrap();
            let version = if project == "." {
                Some("1.0.0")
            } else {
                nested_version
            };
            if let Some(version) = version {
                fs::write(directory.join("uv.lock"), lockfile(version)).unwrap();
            }
            let metadata = directory
                .join(".venv/lib/python3.12/site-packages/sample_dependency-1.0.0.dist-info");
            fs::create_dir_all(&metadata).unwrap();
            fs::write(
                metadata.join("METADATA"),
                "Metadata-Version: 2.3\nName: sample-dependency\nVersion: 1.0.0\n",
            )
            .unwrap();
            let bin = directory.join(".venv/bin");
            fs::create_dir_all(&bin).unwrap();
            for tool in ["mypy", "ruff", "coverage", "pytest"] {
                let path = bin.join(tool);
                fs::write(&path, "#!/bin/sh\necho 'fixture 1.0.0'\n").unwrap();
                fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
            }
        }
        git(root, &["add", "."]);
        git(root, &["commit", "-m", "Python base environments"]);
        let base = Process::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(root)
            .output()
            .unwrap();
        assert!(base.status.success());
        let base = String::from_utf8(base.stdout).unwrap();
        fs::write(root.join("app.py"), "value = 2\n").unwrap();
        fs::write(root.join("nested/uv.lock"), lockfile("1.0.0")).unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-m", "Python head environments"]);

        let doctor = |all_roots| {
            let mut command = rio(root);
            command
                .env("PATH", "")
                .args(["doctor", "--base", base.trim(), "--format", "json"]);
            if all_roots {
                command.arg("--all-roots");
            }
            let output = command.assert().success().get_output().clone();
            serde_json::from_slice::<Value>(&output.stdout).unwrap()
        };
        let all_roots = doctor(true);
        assert_eq!(all_roots["plan"]["roots"].as_array().unwrap().len(), 2);
        for readiness in all_roots["plan"]["roots"].as_array().unwrap() {
            let nested = readiness["project"]["path"] == "nested";
            assert_eq!(readiness["head"]["state"], "verified");
            assert_eq!(
                readiness["base"]["state"],
                if nested { nested_state } else { "verified" }
            );
            assert_eq!(
                readiness["base_lockfile"],
                if nested && nested_version.is_none() {
                    Value::Null
                } else {
                    Value::from(if nested { "nested/uv.lock" } else { "uv.lock" })
                }
            );
            let checks: Vec<_> = all_roots["plan"]["checks"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|check| {
                    check["language"] == "python" && check["root"] == readiness["project"]["path"]
                })
                .collect();
            assert_eq!(checks.len(), 3);
            for check in checks {
                assert!(check["skip"].is_null(), "{check}");
                assert_eq!(check["baseline"], !nested || nested_baseline, "{check}");
                assert_eq!(check["baseline_hint"].is_null(), !nested || nested_baseline);
            }
        }

        // With matching locks, nested is outside the diff but still verified above.
        let scoped = doctor(false);
        if nested_baseline {
            assert_eq!(scoped["plan"]["roots"].as_array().unwrap().len(), 1);
        }
        fs::write(root.join("nested/app.py"), "value = 2\n").unwrap();
        git(root, &["add", "."]);
        git(
            root,
            &["commit", "-m", "Include nested project in the diff"],
        );
        let scoped = doctor(false);
        assert_eq!(scoped["plan"]["roots"], all_roots["plan"]["roots"]);
        for check in scoped["plan"]["checks"].as_array().unwrap() {
            let all_check = all_roots["plan"]["checks"]
                .as_array()
                .unwrap()
                .iter()
                .find(|candidate| {
                    candidate["root"] == check["root"] && candidate["kind"] == check["kind"]
                })
                .unwrap();
            assert_eq!(check["baseline"], all_check["baseline"]);
            assert_eq!(check["baseline_hint"], all_check["baseline_hint"]);
        }
    }
}

#[test]
fn malformed_lockfile_reports_unverified_dependencies_without_internal_error() {
    let temp = repository();
    let root = temp.path();
    fs::write(root.join("package.json"), "{}").unwrap();
    fs::write(root.join("pnpm-lock.yaml"), "lockfileVersion: [broken").unwrap();
    fs::write(root.join("index.ts"), "export const n = 1;\n").unwrap();
    let output = rio(root)
        .args(["doctor", "--format", "json"])
        .assert()
        .success()
        .get_output()
        .clone();
    let document: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(document["blocking_problems"].as_array().unwrap().is_empty());
    assert_eq!(document["plan"]["roots"][0]["head"]["state"], "unverified");
    assert!(
        document["plan"]["roots"][0]["head"]["hint"]
            .as_str()
            .unwrap()
            .contains("cannot parse pnpm-lock.yaml")
    );
    let output = rio(root)
        .args(["review", "--offline", "--format", "json"])
        .output()
        .unwrap();
    assert_ne!(
        output.status.code(),
        Some(3),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains("internal_error"));
    let report = json_report(&output);
    assert!(report["checks"].as_array().unwrap().iter().any(|check| {
        check["hint"]
            .as_str()
            .is_some_and(|hint| hint.contains("cannot parse pnpm-lock.yaml"))
    }));
}

#[test]
fn endpoint_presets_submit_snapshots_and_cache_verification_without_local_commands() {
    use std::{
        io::{Read, Write},
        net::TcpListener,
        time::{Duration, Instant},
    };
    for (args, posture, mode) in [
        (vec!["--preset", "quick"], "critical-only", "fast"),
        (vec!["--preset", "standard"], "balanced", "fast"),
        (vec!["--deep"], "thorough", "deep"),
    ] {
        let temp = repository();
        let root = temp.path();
        fs::write(root.join("a.txt"), "two\n").unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(20);
            let mut report = serde_json::json!({});
            let mut seen = Vec::new();
            while seen.len() < 5 && Instant::now() < deadline {
                let (mut stream, _) = match listener.accept() {
                    Ok(value) => value,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(error) => panic!("{error}"),
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut chunk = [0; 8192];
                let (header_end, headers) = loop {
                    let n = stream.read(&mut chunk).unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&chunk[..n]);
                    if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                        let h = String::from_utf8_lossy(&bytes[..end]).to_string();
                        let length = h
                            .lines()
                            .find_map(|l| {
                                l.to_lowercase()
                                    .strip_prefix("content-length: ")
                                    .map(str::to_owned)
                            })
                            .and_then(|l| l.parse::<usize>().ok())
                            .unwrap_or(0);
                        if bytes.len() >= end + 4 + length {
                            break (end, h);
                        }
                    }
                };
                let path = headers
                    .lines()
                    .next()
                    .unwrap()
                    .split_whitespace()
                    .nth(1)
                    .unwrap()
                    .to_owned();
                assert!(
                    headers
                        .to_lowercase()
                        .contains("authorization: bearer long-enough-api-token-32-characters")
                );
                let response = if path == "/v1/snapshots" {
                    let value: Value = serde_json::from_slice(&bytes[header_end + 4..]).unwrap();
                    assert_eq!(value["base"]["a.txt"]["content"], "one\n");
                    assert_eq!(value["head"]["a.txt"]["content"], "two\n");
                    serde_json::json!({"id":"a".repeat(64)})
                } else if path == "/v1/reviews" {
                    let value: Value = serde_json::from_slice(&bytes[header_end + 4..]).unwrap();
                    assert_eq!(value["profile"]["posture"], posture);
                    assert_eq!(value["mode"], mode);
                    assert_eq!(
                        value["profile"]["max_defects"],
                        if posture == "critical-only" {
                            3
                        } else if posture == "balanced" {
                            5
                        } else {
                            15
                        }
                    );
                    report = value["report"].clone();
                    serde_json::json!({"id":"remote-review"})
                } else if path.ends_with("/report") {
                    report.clone()
                } else if path.ends_with("/audit") {
                    serde_json::json!({"hypotheses":[],"votes":[],"usage":[],"executions":[]})
                } else {
                    serde_json::json!({"status":"complete"})
                };
                let body = serde_json::to_vec(&response).unwrap();
                write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).unwrap();
                stream.write_all(&body).unwrap();
                seen.push(path);
            }
            assert_eq!(seen.len(), 5, "requests: {seen:?}");
        });
        let output = rio(root)
            .env("RIO_ENDPOINT_URL", format!("http://{address}"))
            .env("RIO_API_TOKEN", "long-enough-api-token-32-characters")
            .args(["review", "--format", "json"])
            .args(args)
            .assert()
            .success()
            .get_output()
            .clone();
        let report = json_report(&output);
        assert!(report["checks"].as_array().unwrap().is_empty());
        let run = root
            .join(".rio/cache")
            .join(report["review"]["id"].as_str().unwrap())
            .join("runs")
            .join(report["review"]["run_id"].as_str().unwrap());
        assert!(run.join("verification/audit.json").is_file());
        assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "two\n");
        server.join().unwrap();
    }
}

#[test]
fn init_preserves_user_config_and_stores_private_credentials() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join("user-config");
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join("config.toml"), "[run]\nparallelism = 2\n").unwrap();
    rio(temp.path())
        .args([
            "init",
            "--endpoint",
            "http://127.0.0.1:8787",
            "--token-stdin",
        ])
        .write_stdin("long-enough-api-token-32-characters\n")
        .assert()
        .success();
    assert!(
        fs::read_to_string(directory.join("config.toml"))
            .unwrap()
            .contains("parallelism = 2")
    );
    assert_eq!(
        fs::read_to_string(directory.join("credentials")).unwrap(),
        "long-enough-api-token-32-characters"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(directory.join("credentials"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}
#[test]
fn changing_endpoint_does_not_forward_the_previous_deployment_credential() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join("user-config");
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join("config.toml"), "[endpoint]\nurl='https://old.example.com'\n[deployment]\naccount_id='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'\ncredential_store='file'\n").unwrap();
    fs::write(directory.join("credentials"), "old-credential").unwrap();
    rio(temp.path())
        .args(["init", "--endpoint", "https://new.example.com"])
        .assert()
        .success();
    let document: toml::Value =
        toml::from_str(&fs::read_to_string(directory.join("config.toml")).unwrap()).unwrap();
    assert!(document.get("deployment").is_none());
    assert!(!directory.join("credentials").exists());
}

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
fn profile_validate_checks_agent_cache_and_proposal_threshold_options() {
    let temp = repository();
    let root = temp.path();
    let dir = root.join(".rio/profiles");
    fs::create_dir_all(&dir).unwrap();
    // A child's `steps` replaces the inherited list, so the pipeline is complete.
    let profile = |threshold: u32| {
        format!(
            "version: 1\nname: options\nextends: rio/base\nsteps:\n  - {{id: prepare, uses: rio/prepare}}\n  - {{id: checks, uses: rio/checks, needs: [prepare]}}\n  - {{id: graph, uses: rio/graph, needs: [prepare]}}\n  - {{id: triage, uses: rio/triage, needs: [checks, graph]}}\n  - {{id: agents, uses: rio/agents, needs: [triage], with: {{cache: false}}}}\n  - {{id: verify, uses: rio/verify, needs: [agents]}}\n  - {{id: report, uses: rio/report, needs: [verify], with: {{proposal_threshold: {threshold}}}}}\n"
        )
    };
    fs::write(dir.join("options.yaml"), profile(2)).unwrap();
    rio(root)
        .args(["profile", "validate", "options"])
        .assert()
        .success();
    let output = rio(root)
        .args(["profile", "show", "options"])
        .assert()
        .success()
        .get_output()
        .clone();
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(text.contains("cache: false") && text.contains("proposal_threshold: 2"));
    fs::write(dir.join("options.yaml"), profile(0)).unwrap();
    let output = rio(root)
        .args(["profile", "validate", "options"])
        .assert()
        .code(2)
        .get_output()
        .clone();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("proposal_threshold"), "{stderr}");
    assert!(stderr.contains("minimum of 1"), "{stderr}");
}
#[test]
fn security_community_profile_validates_offline_and_enables_thorough_asvs() {
    let temp = repository();
    let root = temp.path();
    rio(root)
        .args(["profile", "validate", "rio/security"])
        .assert()
        .success();
    let output = rio(root)
        .args(["profile", "show", "rio/security"])
        .assert()
        .success()
        .get_output()
        .clone();
    let resolved: serde_yaml::Value = serde_yaml::from_slice(&output.stdout).unwrap();
    let security = resolved["steps"]
        .as_sequence()
        .unwrap()
        .iter()
        .find(|s| s["id"] == "security")
        .unwrap();
    assert_eq!(security["uses"], "rio/security@0.2.0");
    assert_eq!(security["with"]["enabled"], true);
    assert_eq!(security["with"]["posture"], "thorough");
    assert_eq!(security["with"]["catalog"], "asvs-5.0");
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(
        text.contains("rio/base") && text.contains("rio/security"),
        "{text}"
    );
    // Every other base setting is unchanged.
    let base = rio(root)
        .args(["profile", "show", "rio/base"])
        .assert()
        .success()
        .get_output()
        .clone();
    let base: serde_yaml::Value = serde_yaml::from_slice(&base.stdout).unwrap();
    for key in [
        "budget",
        "fail_on",
        "posture",
        "publish",
        "max_defects",
        "verify",
    ] {
        assert_eq!(resolved[key], base[key], "{key}");
    }
    let steps = |v: &serde_yaml::Value| -> Vec<serde_yaml::Value> {
        v["steps"]
            .as_sequence()
            .unwrap()
            .iter()
            .filter(|s| s["id"] != "security")
            .cloned()
            .collect()
    };
    assert_eq!(steps(&resolved), steps(&base));
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
        // The shell creates the file before writing the PID; wait for a complete value.
        let read_pid = || {
            fs::read_to_string(root.join("worker.pid"))
                .ok()
                .and_then(|text| text.trim().parse::<i32>().ok())
        };
        while read_pid().is_none() {
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
        let worker = read_pid().unwrap();
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
    // The last case also exhausts the graph budget: the review continues with a
    // truncated graph and says why.
    for (args, posture, mode, budget) in [
        (vec!["--preset", "quick"], "critical-only", "fast", None),
        (vec!["--preset", "standard"], "balanced", "fast", None),
        (vec!["--deep"], "thorough", "deep", Some("0")),
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
            let (mut manifest, mut snapshot) = (String::new(), String::new());
            let mut seen = Vec::new();
            while seen.len() < 8 && Instant::now() < deadline {
                let (mut stream, _) = match listener.accept() {
                    Ok(value) => value,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(error) => panic!("{error}"),
                };
                // Accepted sockets inherit non-blocking mode on macOS and BSD.
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut chunk = [0; 8192];
                let request = loop {
                    // Probes and unused connections close or time out without a request.
                    let n = match stream.read(&mut chunk) {
                        Ok(n) if n > 0 => n,
                        _ => break None,
                    };
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
                            break Some((end, h));
                        }
                    }
                };
                let Some((header_end, headers)) = request else {
                    continue;
                };
                let path = headers
                    .lines()
                    .next()
                    .unwrap()
                    .split_whitespace()
                    .nth(1)
                    .unwrap()
                    .to_owned();
                // Drop unrelated local probes of the port; a CLI request without
                // the token then fails the review.
                if !headers
                    .to_lowercase()
                    .contains("authorization: bearer long-enough-api-token-32-characters")
                {
                    continue;
                }
                let body = &bytes[header_end + 4..];
                let response = if path == "/v1/contents/missing" {
                    let value: Value = serde_json::from_slice(body).unwrap();
                    assert_eq!(value["hashes"].as_array().unwrap().len(), 3);
                    serde_json::json!({"missing": value["hashes"]})
                } else if path == "/v1/packs" {
                    // .gitignore, then a.txt in base and head.
                    assert!(body.ends_with(b"one\ntwo\n"));
                    serde_json::json!({"pack":"p","contents":3})
                } else if path.ends_with("/chunks/0") {
                    manifest = String::from_utf8(body.to_vec()).unwrap();
                    serde_json::json!({})
                } else if path.ends_with("/seal") {
                    let id = blake3_hex(&manifest);
                    assert_eq!(path, format!("/v1/manifests/{id}/seal"));
                    let lines: Vec<Value> = manifest
                        .lines()
                        .map(|line| serde_json::from_str(line).unwrap())
                        .collect();
                    assert_eq!(lines.len(), 4);
                    assert_eq!(lines[1]["path"], "a.txt");
                    assert_eq!(lines[1]["hash"], blake3_hex("one\n"));
                    assert_eq!(lines[3]["version"], "head");
                    assert_eq!(lines[3]["hash"], blake3_hex("two\n"));
                    snapshot = id.clone();
                    serde_json::json!({ "id": id })
                } else if path == "/v1/reviews" {
                    let value: Value = serde_json::from_slice(body).unwrap();
                    assert_eq!(value["snapshot_id"], snapshot.as_str());
                    assert_eq!(value["profile"]["posture"], posture);
                    assert_eq!(value["mode"], mode);
                    // Without an origin the registry key is the directory name.
                    assert!(
                        value["repository"]
                            .as_str()
                            .is_some_and(|r| !r.is_empty() && !r.contains('/')),
                        "{}",
                        value["repository"]
                    );
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
            assert_eq!(seen.len(), 8, "requests: {seen:?}");
        });
        let mut command = rio(root);
        if let Some(budget) = budget {
            command.env("RIO_GRAPH_BUDGET_SECS", budget);
        }
        let output = command
            .env("RIO_ENDPOINT_URL", format!("http://{address}"))
            .env("RIO_API_TOKEN", "long-enough-api-token-32-characters")
            .args(["review", "--format", "json"])
            .args(args)
            .assert()
            .success()
            .get_output()
            .clone();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.contains(
                "snapshot: uploaded 34 B in 3 new contents (34 B in 3 distinct contents, 4 files total)"
            ),
            "{stderr}"
        );
        let report = json_report(&output);
        assert!(report["checks"].as_array().unwrap().is_empty());
        let truncated = report["footer"]["notes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|note| note == "Impact graph truncated at the graph deadline");
        assert_eq!(truncated, budget.is_some(), "{}", report["footer"]);
        assert_eq!(report["impact"]["truncated"], budget.is_some());
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

type Requests = std::sync::Arc<std::sync::Mutex<Vec<(String, String, Value)>>>;
/// A loopback HTTP endpoint answering every request with `handler(method, path, body)`
/// until dropped. Requests are logged in order.
struct MockEndpoint {
    url: String,
    requests: Requests,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl MockEndpoint {
    fn start(mut handler: impl FnMut(&str, &str, &Value) -> (u16, Value) + Send + 'static) -> Self {
        use std::{
            io::{Read, Write},
            net::TcpListener,
            sync::{Arc, Mutex, atomic::AtomicBool, atomic::Ordering},
            time::Duration,
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests: Requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let (log, halt) = (requests.clone(), stop.clone());
        let thread = std::thread::spawn(move || {
            while !halt.load(Ordering::SeqCst) {
                let mut stream = match listener.accept() {
                    Ok((stream, _)) => stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(error) => panic!("{error}"),
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(10)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut chunk = [0; 65536];
                let request = loop {
                    // Probes and unused connections close or time out without a request.
                    let n = match stream.read(&mut chunk) {
                        Ok(n) if n > 0 => n,
                        _ => break None,
                    };
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
                            break Some((end, h));
                        }
                    }
                };
                let Some((end, headers)) = request else {
                    continue;
                };
                // Drop unrelated local probes of the port; a CLI request without
                // the token then fails the review.
                if !headers
                    .to_lowercase()
                    .contains("authorization: bearer long-enough-api-token-32-characters")
                {
                    continue;
                }
                let mut first = headers.lines().next().unwrap().split_whitespace();
                let method = first.next().unwrap().to_owned();
                let path = first.next().unwrap().to_owned();
                let body: Value = serde_json::from_slice(&bytes[end + 4..]).unwrap_or(Value::Null);
                let (status, response) = handler(&method, &path, &body);
                log.lock().unwrap().push((method, path, body));
                let body = serde_json::to_vec(&response).unwrap();
                write!(stream, "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).unwrap();
                stream.write_all(&body).unwrap();
            }
        });
        Self {
            url,
            requests,
            stop,
            thread: Some(thread),
        }
    }
    fn take(&self) -> Vec<(String, String, Value)> {
        std::mem::take(&mut *self.requests.lock().unwrap())
    }
}
impl Drop for MockEndpoint {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(thread) = self.thread.take()
            && thread.join().is_err()
            && !std::thread::panicking()
        {
            panic!("mock endpoint failed");
        }
    }
}

/// Lineage semantics of the endpoint, reduced to what the CLI observes: every
/// review posts the same defect, so each run consumes a round and later rounds
/// hold it back.
fn lineage_endpoint() -> MockEndpoint {
    // Contents the endpoint holds; negotiated contents count as uploaded.
    let mut stored = std::collections::HashSet::<String>::new();
    let mut reports = std::collections::BTreeMap::<String, Value>::new();
    // (repository, ref) -> (generation, round, previous_head, posted: id -> first snapshot)
    let mut lineages = std::collections::BTreeMap::<
        (String, String),
        (
            u64,
            u64,
            Option<String>,
            std::collections::BTreeMap<String, String>,
        ),
    >::new();
    MockEndpoint::start(move |method, path, body| {
        let id = "d".repeat(64);
        if path == "/v1/contents/missing" {
            let missing: Vec<&Value> = body["hashes"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|hash| stored.insert(hash.as_str().unwrap().to_owned()))
                .collect();
            return (200, serde_json::json!({ "missing": missing }));
        }
        if path == "/v1/packs" || path.contains("/chunks/") {
            return (201, serde_json::json!({}));
        }
        if let Some(seal) = path.strip_prefix("/v1/manifests/") {
            let id = seal.strip_suffix("/seal").unwrap();
            return (201, serde_json::json!({ "id": id }));
        }
        if path.starts_with("/v1/lineages?") {
            let query: std::collections::BTreeMap<String, String> = path
                .split_once('?')
                .unwrap()
                .1
                .split('&')
                .map(|pair| {
                    let (k, v) = pair.split_once('=').unwrap();
                    let v = v.replace("%2F", "/").replace("%3A", ":");
                    (k.to_owned(), v)
                })
                .collect();
            assert_eq!(query["kind"], "branch");
            return match lineages.get(&(query["repository"].clone(), query["ref"].clone())) {
                Some((generation, round, previous, posted)) => (
                    200,
                    serde_json::json!({"repository":query["repository"],"kind":"branch",
                        "ref":query["ref"],"generation":generation,"round":round,
                        "previous_head":previous,"posted":posted.keys().collect::<Vec<_>>(),
                        "rounds_to_pass":null}),
                ),
                None => (404, serde_json::json!({"error":"not_found"})),
            };
        }
        if method == "POST" && path == "/v1/reviews" {
            let mut report = body["report"].clone();
            let mut finding: Value =
                serde_json::from_str(include_str!("../../rio-core/tests/fixtures/finding.json"))
                    .unwrap();
            finding["id"] = serde_json::json!(id);
            if let Some(lineage) = body.get("lineage") {
                let key = (
                    lineage["repository"].as_str().unwrap().to_owned(),
                    lineage["ref"].as_str().unwrap().to_owned(),
                );
                let snapshot = body["snapshot_id"].as_str().unwrap().to_owned();
                let entry = lineages
                    .entry(key)
                    .or_insert((0, 0, None, Default::default()));
                if lineage["reset"] == true || entry.0 == 0 {
                    *entry = (entry.0 + 1, 0, None, Default::default());
                }
                let previous = entry.2.replace(snapshot.clone());
                entry.1 += 1;
                let held_back = u64::from(entry.3.contains_key(&id));
                let first = entry.3.entry(id.clone()).or_insert(snapshot).clone();
                finding["round"] = serde_json::json!(entry.1);
                finding["first_posted_in"] = serde_json::json!(first);
                report["lineage"] = serde_json::json!({"repository":lineage["repository"],
                    "kind":"branch","ref":lineage["ref"],"generation":entry.0,"round":entry.1,
                    "cap":3,"capped":false,"diff_only":entry.1 > 1,"previous_head":previous,
                    "held_back":held_back,"rounds_to_pass":null,"author_response_ratio":null});
            }
            report["findings"] = serde_json::json!([finding]);
            let remote = format!("review-{}", reports.len() + 1);
            reports.insert(remote.clone(), report);
            return (200, serde_json::json!({"id": remote}));
        }
        let remote = path.split('/').nth(3).unwrap_or_default().to_owned();
        if path.ends_with("/report") {
            (200, reports[&remote].clone())
        } else if path.ends_with("/audit") {
            (
                200,
                serde_json::json!({"hypotheses":[],"votes":[],"usage":[],"executions":[]}),
            )
        } else {
            (200, serde_json::json!({"status":"complete"}))
        }
    })
}

#[test]
fn since_last_keeps_endpoint_rounds_held_back_counts_and_a_refetchable_local_copy() {
    let temp = repository();
    let root = temp.path();
    git(
        root,
        &[
            "remote",
            "add",
            "origin",
            "https://user:secret@github.com/pixelinfinito/rio.git",
        ],
    );
    git(root, &["checkout", "-b", "feature/x"]);
    let endpoint = lineage_endpoint();
    let review = |args: &[&str], content: &str| {
        fs::write(root.join("a.txt"), content).unwrap();
        rio(root)
            .env("RIO_ENDPOINT_URL", &endpoint.url)
            .env("RIO_API_TOKEN", "long-enough-api-token-32-characters")
            .args(["review", "--since-last"])
            .args(args)
            .assert()
            // The reproduced defect is `worsened`: fail_on is unaffected by lineage state.
            .code(1)
            .get_output()
            .clone()
    };
    let copy = root.join(".rio/cache/lineages").join(format!(
        "{}.json",
        blake3_hex("github.com/pixelinfinito/rio|feature/x")
    ));
    let lineage_fetches = |requests: &[(String, String, Value)]| {
        requests
            .iter()
            .filter(|(_, path, _)| path.starts_with("/v1/lineages?"))
            .count()
    };
    let submitted = |requests: &[(String, String, Value)]| {
        requests
            .iter()
            .find(|(_, path, _)| path == "/v1/reviews")
            .unwrap()
            .2["lineage"]
            .clone()
    };

    // Round 1: no copy and no endpoint lineage yet (404).
    let output = review(&["--format", "json"], "two\n");
    let report = json_report(&output);
    let requests = endpoint.take();
    let first_snapshot = requests
        .iter()
        .find(|(_, path, _)| path == "/v1/reviews")
        .unwrap()
        .2["snapshot_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("B in 3 new contents (") && stderr.contains("snapshot: uploaded "),
        "{stderr}"
    );
    assert_eq!(lineage_fetches(&requests), 1);
    assert_eq!(
        submitted(&requests),
        serde_json::json!({"repository":"github.com/pixelinfinito/rio","kind":"branch",
            "ref":"feature/x","reset":false})
    );
    assert_eq!(report["lineage"]["round"], 1);
    assert_eq!(report["lineage"]["held_back"], 0);
    let local: Value = serde_json::from_slice(&fs::read(&copy).unwrap()).unwrap();
    assert_eq!(local["version"], 1);
    assert_eq!(local["round"], 1);
    assert_eq!(local["previous_head"], first_snapshot.as_str());
    assert_eq!(local["posted"], serde_json::json!(["d".repeat(64)]));

    // Round 2: the local copy is used; the reproduced defect is held back.
    let output = review(&["--format", "md"], "three\n");
    let markdown = String::from_utf8_lossy(&output.stdout);
    // Only the new head content is uploaded again.
    assert!(String::from_utf8_lossy(&output.stderr).contains("B in 1 new contents ("));
    let requests = endpoint.take();
    assert_eq!(lineage_fetches(&requests), 0);
    assert!(markdown.contains("Round 2 of cap 3"), "{markdown}");
    assert!(markdown.contains("Held back as already posted: 1"));
    assert!(markdown.contains("(already posted)"));
    assert!(markdown.contains(&format!("Diff-only re-review since {first_snapshot}")));

    // A deleted copy is refetched from the endpoint and the lineage continues.
    fs::remove_dir_all(root.join(".rio/cache/lineages")).unwrap();
    let report = json_report(&review(&["--format", "json"], "four\n"));
    let requests = endpoint.take();
    assert_eq!(lineage_fetches(&requests), 1);
    assert_eq!(submitted(&requests)["reset"], false);
    assert_eq!(report["lineage"]["round"], 3);
    assert_eq!(report["lineage"]["generation"], 1);
    assert_eq!(report["lineage"]["held_back"], 1);
    let local: Value = serde_json::from_slice(&fs::read(&copy).unwrap()).unwrap();
    assert_eq!(local["round"], 3);

    // --reset-lineage starts a new generation at round 1 without consulting state.
    let output = review(&["--reset-lineage"], "five\n");
    let terminal = String::from_utf8_lossy(&output.stdout);
    let requests = endpoint.take();
    assert_eq!(lineage_fetches(&requests), 0);
    assert_eq!(submitted(&requests)["reset"], true);
    assert!(terminal.contains("Round 1 of cap 3"), "{terminal}");
    assert!(terminal.contains("generation 2"));
    assert!(!terminal.contains("(already posted)"));
    let local: Value = serde_json::from_slice(&fs::read(&copy).unwrap()).unwrap();
    assert_eq!(
        (local["round"].clone(), local["generation"].clone()),
        (1.into(), 2.into())
    );

    // A plain endpoint review carries no lineage.
    fs::write(root.join("a.txt"), "six\n").unwrap();
    let output = rio(root)
        .env("RIO_ENDPOINT_URL", &endpoint.url)
        .env("RIO_API_TOKEN", "long-enough-api-token-32-characters")
        .args(["review", "--format", "json"])
        .assert()
        .code(1)
        .get_output()
        .clone();
    assert!(json_report(&output).get("lineage").is_none());
    let requests = endpoint.take();
    assert!(submitted(&requests).is_null());
    assert_eq!(lineage_fetches(&requests), 0);
}

fn blake3_hex(text: &str) -> String {
    blake3::hash(text.as_bytes()).to_hex().to_string()
}

#[test]
fn since_last_needs_a_branch_an_online_endpoint_and_reset_needs_since_last() {
    let temp = repository();
    let root = temp.path();
    fs::write(root.join("a.txt"), "two\n").unwrap();
    // Nothing listens here; these failures must precede any network access.
    let endpoint = "http://127.0.0.1:9";
    let output = rio(root)
        .env("RIO_ENDPOINT_URL", endpoint)
        .env("RIO_API_TOKEN", "long-enough-api-token-32-characters")
        .args(["review", "--since-last", "--offline", "--format", "json"])
        .assert()
        .code(2)
        .get_output()
        .clone();
    let report = json_report(&output);
    assert_eq!(report["error"]["code"], "endpoint_required");
    assert!(
        report["error"]["message"]
            .as_str()
            .unwrap()
            .contains("--since-last")
    );
    rio(root)
        .env("RIO_ENDPOINT_URL", endpoint)
        .args(["review", "--reset-lineage"])
        .assert()
        .code(2);
    git(root, &["checkout", "--detach", "HEAD"]);
    let output = rio(root)
        .env("RIO_ENDPOINT_URL", endpoint)
        .env("RIO_API_TOKEN", "long-enough-api-token-32-characters")
        .args(["review", "--since-last", "--format", "json"])
        .assert()
        .code(2)
        .get_output()
        .clone();
    let report = json_report(&output);
    assert_eq!(report["error"]["code"], "branch_required");
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("a branch is required"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!root.join(".rio/cache/lineages").exists());
}

#[test]
fn feedback_validates_reasons_locally_and_maps_endpoint_answers_to_exit_codes() {
    let temp = repository();
    let root = temp.path();
    // Invalid reason: exit 2 listing the accepted reasons, without any request.
    let silent = MockEndpoint::start(|_, _, _| panic!("no request expected"));
    for reason in ["known", "false_positive"] {
        let output = rio(root)
            .env("RIO_ENDPOINT_URL", &silent.url)
            .env("RIO_API_TOKEN", "long-enough-api-token-32-characters")
            .args(["feedback", "8c1e", "--dismiss", reason])
            .assert()
            .code(2)
            .get_output()
            .clone();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.contains("fixed, wrong, intentional, irrelevant, style"),
            "{stderr}"
        );
    }
    assert!(silent.take().is_empty());
    drop(silent);
    // No endpoint configured.
    let output = rio(root)
        .args(["feedback", "8c1e", "--dismiss", "wrong"])
        .assert()
        .code(2)
        .get_output()
        .clone();
    assert!(String::from_utf8_lossy(&output.stderr).contains("endpoint"));

    let endpoint = MockEndpoint::start(|method, path, body| {
        assert_eq!(method, "POST");
        match path {
            "/v1/findings/8c1e/feedback" => (
                200,
                serde_json::json!({"id":"8c1e","status":"dismissed","author_response":{
                    "reason":body["reason"],"actor":body["actor"],"at":"2026-11-06T10:00:00Z",
                    "note":body["note"]}}),
            ),
            "/v1/findings/0bad/feedback" => (404, serde_json::json!({"error":"not_found"})),
            _ => (400, serde_json::json!({"error":"invalid"})),
        }
    });
    let feedback = |args: &[&str]| {
        rio(root)
            .env("RIO_ENDPOINT_URL", &endpoint.url)
            .env("RIO_API_TOKEN", "long-enough-api-token-32-characters")
            .arg("feedback")
            .args(args)
            .assert()
    };
    let output = feedback(&[
        "8c1e",
        "--dismiss",
        "intentional",
        "--note",
        "documented behavior",
    ])
    .code(0)
    .get_output()
    .clone();
    assert!(String::from_utf8_lossy(&output.stdout).contains("8c1e dismissed (intentional)"));
    let requests = endpoint.take();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].2,
        serde_json::json!({"reason":"intentional","note":"documented behavior",
            "actor":"rio@example.invalid"})
    );
    let output = feedback(&["0bad", "--dismiss", "wrong"])
        .code(3)
        .get_output()
        .clone();
    assert!(String::from_utf8_lossy(&output.stderr).contains("not found"));
    feedback(&["1bad", "--dismiss", "fixed"]).code(3);
    feedback(&["../reviews", "--dismiss", "fixed"]).code(2);
    assert_eq!(endpoint.take().len(), 2);
}
#[test]
fn eval_requires_the_harness_and_forwards_to_it() {
    let temp = repository();
    let output = rio(temp.path())
        .args(["eval", "import-incident", "41", "57"])
        .env_remove("RIO_EVAL_DIR")
        .assert()
        .code(2)
        .get_output()
        .clone();
    assert!(String::from_utf8_lossy(&output.stderr).contains("RIO_EVAL_DIR"));
    let harness = tempfile::tempdir().unwrap();
    std::fs::write(harness.path().join("noise.py"), "").unwrap();
    std::fs::write(
        harness.path().join("incident.py"),
        "import sys\nprint(' '.join(sys.argv[1:]))\nsys.exit(7)\n",
    )
    .unwrap();
    let output = rio(temp.path())
        .args(["eval", "import-incident", "41", "57", "--caught-by", "none"])
        .env("RIO_EVAL_DIR", harness.path())
        .assert()
        .code(7)
        .get_output()
        .clone();
    assert_eq!(
        String::from_utf8_lossy(&output.stdout).trim(),
        "41 57 --caught-by none"
    );
}

fn sarif_log(output: &std::process::Output) -> Value {
    let value: Value = serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
        panic!(
            "{error}: {}\nstderr: {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    });
    let schema: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/sarif-schema/sarif-schema-2.1.0.json"
    ))
    .unwrap();
    let validator = jsonschema::validator_for(&schema).unwrap();
    let errors: Vec<_> = validator
        .iter_errors(&value)
        .map(|e| e.to_string())
        .collect();
    assert!(errors.is_empty(), "{errors:?}");
    assert_eq!(value["version"], "2.1.0");
    assert_eq!(value["runs"].as_array().unwrap().len(), 1);
    value
}
#[test]
fn sarif_output_is_one_clean_log_including_errors() {
    // Outside a git repository: one log, no results, exit code 3.
    let temp = tempfile::tempdir().unwrap();
    let output = rio(temp.path())
        .args(["review", "--format", "sarif"])
        .assert()
        .code(3)
        .get_output()
        .clone();
    let log = sarif_log(&output);
    let run = &log["runs"][0];
    assert!(run["results"].as_array().unwrap().is_empty());
    assert_eq!(run["invocations"][0]["executionSuccessful"], false);
    assert_eq!(run["invocations"][0]["exitCode"], 3);
    assert_eq!(
        run["invocations"][0]["properties"]["error"]["code"],
        "not_a_repository"
    );
    assert_eq!(run["properties"]["rio.status"], "error");
    // A configuration error: exit 2 and the error in the invocation.
    let temp = repository();
    let root = temp.path();
    fs::write(
        root.join("broken.yaml"),
        "version: 1\nname: broken\nunknown: true\n",
    )
    .unwrap();
    let output = rio(root)
        .args(["review", "--format", "sarif", "--profile", "broken.yaml"])
        .assert()
        .code(2)
        .get_output()
        .clone();
    let log = sarif_log(&output);
    let invocation = &log["runs"][0]["invocations"][0];
    assert_eq!(invocation["executionSuccessful"], false);
    assert_eq!(invocation["exitCode"], 2);
    assert_eq!(invocation["properties"]["error"]["code"], "invalid_profile");
    // A complete review with a failing finding: the result and exit code 1;
    // progress went to standard error.
    let token = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
    fs::write(root.join("a.txt"), format!("token = '{token}'\n")).unwrap();
    let output = rio(root)
        .args(["review", "--format", "sarif", "--offline"])
        .assert()
        .code(1)
        .get_output()
        .clone();
    let log = sarif_log(&output);
    let run = &log["runs"][0];
    assert!(String::from_utf8_lossy(&output.stderr).contains("Running"));
    assert!(!String::from_utf8_lossy(&output.stdout).contains(token));
    assert_eq!(run["invocations"][0]["executionSuccessful"], true);
    assert_eq!(run["invocations"][0]["exitCode"], 1);
    let result = run["results"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["ruleId"] == "secret/github-token")
        .unwrap();
    assert_eq!(
        result["locations"][0]["physicalLocation"]["artifactLocation"]["uri"],
        "a.txt"
    );
    assert_eq!(
        result["locations"][0]["physicalLocation"]["artifactLocation"]["uriBaseId"],
        "SRCROOT"
    );
    assert_eq!(
        result["partialFingerprints"]["rioFindingId/v1"]
            .as_str()
            .unwrap()
            .len(),
        64
    );
    // The same review as JSON names the same identities.
    let json = json_report(
        &rio(root)
            .args(["review", "--format", "json", "--offline"])
            .assert()
            .code(1)
            .get_output()
            .clone(),
    );
    let ids: Vec<_> = json["findings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["id"].clone())
        .collect();
    for result in run["results"].as_array().unwrap() {
        assert!(ids.contains(&result["partialFingerprints"]["rioFindingId/v1"]));
    }
    // A clean working tree is one successful log without results.
    git(root, &["checkout", "--", "a.txt"]);
    fs::remove_file(root.join("broken.yaml")).unwrap();
    let log = sarif_log(
        &rio(root)
            .args(["review", "--format", "sarif"])
            .assert()
            .success()
            .get_output()
            .clone(),
    );
    assert_eq!(log["runs"][0]["properties"]["rio.status"], "no_changes");
    assert_eq!(log["runs"][0]["invocations"][0]["exitCode"], 0);
}

const TOKEN: &str = "long-enough-api-token-32-characters";
fn registry_endpoint() -> MockEndpoint {
    let mut status = "proposed";
    MockEndpoint::start(move |method, path, body| {
        let (route, query) = path.split_once('?').unwrap_or((path, ""));
        match (method, route) {
            ("GET", "/v1/findings") => {
                if !query.contains("repository=") {
                    return (400, serde_json::json!({"error":"repository required"}));
                }
                let records = [
                    ("open", "aaaa"),
                    ("open", "bbbb"),
                    ("open", "cccc"),
                    ("dismissed", "dddd"),
                    ("dismissed", "eeee"),
                ];
                let findings: Vec<Value> = records
                    .iter()
                    .filter(|(s, _)| !query.contains("status=") || query.contains(&format!("status={s}")))
                    .map(|(s, id)| serde_json::json!({
                        "identity": id.repeat(16), "repository": "r", "rule_id": "lint/eslint/no-unused-vars",
                        "status": s, "first_seen": "rev-1", "last_seen": "rev-2", "seen_count": 2,
                        "location": {"path":"src/a.ts","line_start":3,"line_end":3,"symbol_path":"a","occurrence_state":"new"},
                        "author_response": if *s == "dismissed" { serde_json::json!({"reason":"style","actor":"a","at":"2026-11-01T00:00:00Z"}) } else { Value::Null },
                    }))
                    .collect();
                (200, serde_json::json!({ "findings": findings }))
            }
            ("GET", "/v1/suppressions") => (
                200,
                serde_json::json!({"suppressions": [
                    {"id":"sp-1","repository":"r","entry":{"rule":"lint/eslint/no-console"},"status":status,
                     "evidence_count":3,"evidence":[
                        {"finding":"a".repeat(64),"reason":"style","actor":"ana","at":"2026-11-01T00:00:00Z"},
                        {"finding":"b".repeat(64),"reason":"irrelevant","actor":"bo","at":"2026-11-02T00:00:00Z"},
                        {"finding":"c".repeat(64),"reason":"style","actor":"cy","at":"2026-11-03T00:00:00Z"}],
                     "created_at":"2026-11-03T00:00:00Z"},
                    {"id":"sp-2","repository":"r","entry":{"path":"docs/generated/**"},"status":"declined",
                     "evidence_count":3,"evidence":[],"created_at":"2026-11-03T00:00:00Z"}]}),
            ),
            ("POST", "/v1/suppressions/sp-1") => {
                status = if body["status"] == "applied" {
                    "applied"
                } else {
                    "declined"
                };
                (200, serde_json::json!({"id":"sp-1","status":status}))
            }
            _ => (404, serde_json::json!({"error":"not found"})),
        }
    })
}
#[test]
fn findings_lists_the_registry_and_needs_an_endpoint() {
    let temp = repository();
    let root = temp.path();
    let output = rio(root)
        .args(["findings"])
        .assert()
        .code(2)
        .get_output()
        .clone();
    assert!(String::from_utf8_lossy(&output.stderr).contains("requires a configured endpoint"));
    let endpoint = registry_endpoint();
    let run = |args: &[&str]| {
        rio(root)
            .env("RIO_ENDPOINT_URL", &endpoint.url)
            .env("RIO_API_TOKEN", TOKEN)
            .arg("findings")
            .args(args)
            .assert()
            .success()
            .get_output()
            .clone()
    };
    let output = run(&["--status", "open"]);
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(text.contains(": 3 record(s)"), "{text}");
    assert_eq!(text.matches("lint/eslint/no-unused-vars").count(), 3);
    assert!(
        text.contains(
            "aaaaaaaaaaaa  lint/eslint/no-unused-vars  src/a.ts:3  open  last seen rev-2"
        )
    );
    let requests = endpoint.take();
    let directory = root.file_name().unwrap().to_string_lossy().to_string();
    assert_eq!(
        requests[0].1,
        format!("/v1/findings?repository={directory}&status=open")
    );
    let output = run(&[
        "--format",
        "json",
        "--rule",
        "lint/eslint/no-unused-vars",
        "--since",
        "2026-11-01T00:00:00Z",
    ]);
    let document: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(document["findings"].as_array().unwrap().len(), 5);
    assert_eq!(document["repository"], directory.as_str());
    assert!(
        endpoint.take()[0]
            .1
            .contains("rule=lint%2Feslint%2Fno-unused-vars&since=2026-11-01T00%3A00%3A00Z")
    );
    rio(root)
        .env("RIO_ENDPOINT_URL", &endpoint.url)
        .env("RIO_API_TOKEN", TOKEN)
        .args(["findings", "--status", "closed"])
        .assert()
        .code(2);
}
#[test]
fn suppressions_list_apply_and_decline() {
    let temp = repository();
    let root = temp.path();
    let endpoint = registry_endpoint();
    let rio_s = |args: &[&str], stdin: &str| {
        rio(root)
            .env("RIO_ENDPOINT_URL", &endpoint.url)
            .env("RIO_API_TOKEN", TOKEN)
            .arg("suppressions")
            .args(args)
            .write_stdin(stdin.to_owned())
            .assert()
    };
    let output = rio_s(&["list"], "").success().get_output().clone();
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(
        text.contains("sp-1  rule: \"lint/eslint/no-console\"  proposed  3 piece(s) of evidence"),
        "{text}"
    );
    assert!(
        text.contains("sp-2  path: \"docs/generated/**\"  declined  3"),
        "{text}"
    );
    let document: Value = serde_json::from_slice(
        &rio_s(&["list", "--format", "json"], "")
            .success()
            .get_output()
            .stdout,
    )
    .unwrap();
    assert_eq!(document["suppressions"].as_array().unwrap().len(), 2);
    endpoint.take();
    // No confirmation: nothing written and nothing marked.
    let profile = root.join(".rio/profiles/default.yaml");
    let output = rio_s(&["apply", "sp-1"], "n\n")
        .code(1)
        .get_output()
        .clone();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("- rule: \"lint/eslint/no-console\"") && stdout.contains("style by ana"),
        "{stdout}"
    );
    assert!(String::from_utf8_lossy(&output.stderr).contains("Not applied"));
    assert!(!profile.exists());
    assert!(endpoint.take().iter().all(|(m, _, _)| m == "GET"));
    // A validation failure restores the previous bytes and keeps the proposal.
    fs::create_dir_all(profile.parent().unwrap()).unwrap();
    let broken = "version: 1\nname: default\nextends: rio/base\nposture: sloppy\n";
    fs::write(&profile, broken).unwrap();
    let output = rio_s(&["apply", "sp-1", "--yes"], "")
        .code(2)
        .get_output()
        .clone();
    assert!(String::from_utf8_lossy(&output.stderr).contains("does not validate"));
    assert_eq!(fs::read_to_string(&profile).unwrap(), broken);
    assert!(endpoint.take().iter().all(|(m, _, _)| m == "GET"));
    let leftovers = |dir: &Path| {
        fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with(".default.rio-apply-"))
            .collect::<Vec<_>>()
    };
    assert!(leftovers(profile.parent().unwrap()).is_empty());
    // A write that cannot happen (read-only directory) leaves the profile intact.
    #[cfg(unix)]
    if unsafe { libc::geteuid() } != 0 {
        use std::os::unix::fs::PermissionsExt;
        let valid = "version: 1\nname: default\nextends: rio/base\n";
        fs::write(&profile, valid).unwrap();
        let dir = profile.parent().unwrap().to_owned();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o555)).unwrap();
        let failed = rio_s(&["apply", "sp-1", "--yes"], "")
            .code(2)
            .get_output()
            .clone();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(!String::from_utf8_lossy(&failed.stderr).is_empty());
        assert_eq!(fs::read_to_string(&profile).unwrap(), valid);
        assert!(endpoint.take().iter().all(|(m, _, _)| m == "GET"));
    }
    // Missing profile: created extending rio/base with the single entry.
    fs::remove_file(&profile).unwrap();
    rio_s(&["apply", "sp-1"], "y\n").success();
    let created = fs::read_to_string(&profile).unwrap();
    assert!(
        created.contains("extends: rio/base\nsuppress:\n  - rule: \"lint/eslint/no-console\"\n"),
        "{created}"
    );
    let posts: Vec<_> = endpoint
        .take()
        .into_iter()
        .filter(|(m, _, _)| m == "POST")
        .collect();
    assert_eq!(posts.len(), 1);
    assert_eq!(posts[0].1, "/v1/suppressions/sp-1");
    assert_eq!(posts[0].2, serde_json::json!({"status":"applied"}));
    rio(root).args(["profile", "validate"]).assert().success();
    assert!(leftovers(profile.parent().unwrap()).is_empty());
    // Already applied: refused.
    rio_s(&["apply", "sp-1", "--yes"], "").code(2);
    rio_s(&["decline", "sp-2"], "").code(2);
    rio_s(&["decline", "sp-9"], "").code(3);
}
#[test]
fn suppressions_append_to_an_existing_profile_and_decline_with_a_note() {
    let temp = repository();
    let root = temp.path();
    let endpoint = registry_endpoint();
    let profile = root.join(".rio/profiles/default.yaml");
    fs::create_dir_all(profile.parent().unwrap()).unwrap();
    let existing = "# team defaults\nversion: 1\nname: team\nextends: rio/base\nsuppress:\n  - path: \"vendor/**\"\nposture: balanced\n";
    fs::write(&profile, existing).unwrap();
    rio(root)
        .env("RIO_ENDPOINT_URL", &endpoint.url)
        .env("RIO_API_TOKEN", TOKEN)
        .args(["suppressions", "apply", "sp-1", "--yes"])
        .assert()
        .success();
    assert_eq!(
        fs::read_to_string(&profile).unwrap(),
        existing.replace(
            "  - path: \"vendor/**\"\n",
            "  - path: \"vendor/**\"\n  - rule: \"lint/eslint/no-console\"\n"
        )
    );
    let shown = rio(root)
        .args(["profile", "show", ".rio/profiles/default.yaml"])
        .assert()
        .success()
        .get_output()
        .clone();
    assert!(String::from_utf8_lossy(&shown.stdout).contains("lint/eslint/no-console"));
    let temp = repository();
    let endpoint = registry_endpoint();
    rio(temp.path())
        .env("RIO_ENDPOINT_URL", &endpoint.url)
        .env("RIO_API_TOKEN", TOKEN)
        .args(["suppressions", "decline", "sp-1", "--note", "we want these"])
        .assert()
        .success();
    let posts: Vec<_> = endpoint
        .take()
        .into_iter()
        .filter(|(m, _, _)| m == "POST")
        .collect();
    assert_eq!(
        posts[0].2,
        serde_json::json!({"status":"declined","note":"we want these"})
    );
    assert!(!temp.path().join(".rio/profiles/default.yaml").exists());
}

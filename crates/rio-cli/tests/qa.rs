use assert_cmd::Command;
use serde_json::{Value, json};
use std::{fs, path::Path, process::Command as Process};

fn write(root: &Path, path: &str, value: &Value) {
    let target = root.join(path);
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    fs::write(target, serde_json::to_vec_pretty(value).unwrap()).unwrap();
}
fn git(root: &Path, args: &[&str]) {
    assert!(
        Process::new("git")
            .current_dir(root)
            .args(args)
            .output()
            .unwrap()
            .status
            .success()
    );
}
fn fixture() -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    git(root.path(), &["init", "-q"]);
    write(
        root.path(),
        ".rio/qa.yaml",
        &json!({"version":1,"app":{"packaging":"static","directory":"public","url":"http://app:8080","ready":{"path":"/","status":200}},"personas":[{"name":"shopper","description":"Synthetic shopper"}]}),
    );
    fs::create_dir_all(root.path().join("src")).unwrap();
    fs::write(
        root.path().join("src/checkout.js"),
        "export const checkout = 1;\n",
    )
    .unwrap();
    fs::write(
        root.path().join("REVIEW.md"),
        "Preserve the shopper's cart during checkout.\n",
    )
    .unwrap();
    for name in ["cart", "checkout"] {
        write(
            root.path(),
            &format!(".rio/qa/journeys/{name}.yaml"),
            &journey(name),
        );
    }
    git(root.path(), &["add", "."]);
    git(
        root.path(),
        &[
            "-c",
            "user.name=QA fixture",
            "-c",
            "user.email=qa@example.test",
            "commit",
            "-qm",
            "fixture",
        ],
    );
    root
}
fn journey(name: &str) -> Value {
    let mut result = json!({"version":1,"name":name,"title":name,"persona":"shopper","tags":[],"covers":{"paths":["src/**"]},"preconditions":[],"steps":[{"do":"Open the page","expect":"The page is ready"}],"success":["The goal is complete"]});
    if name == "checkout" {
        result["after"] = json!(["cart"]);
    } else {
        result["resets"] = json!(true);
    }
    result
}
fn rio(root: &Path) -> Command {
    let mut command = Command::new(assert_cmd::cargo::cargo_bin!("rio"));
    command.current_dir(root).arg("qa");
    command
}

#[cfg(unix)]
#[test]
fn review_defers_qa_when_docker_is_unreachable() {
    use std::os::unix::fs::PermissionsExt;
    let root = fixture();
    let host = tempfile::tempdir().unwrap();
    let docker = host.path().join("docker");
    fs::write(&docker, "#!/bin/sh\nexit 1\n").unwrap();
    fs::set_permissions(&docker, fs::Permissions::from_mode(0o700)).unwrap();
    let paths = std::iter::once(host.path().to_path_buf())
        .chain(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        ))
        .collect::<Vec<_>>();
    let output = Command::new(assert_cmd::cargo::cargo_bin!("rio"))
        .current_dir(root.path())
        .env("PATH", std::env::join_paths(paths).unwrap())
        .env("RIO_CONFIG_DIR", host.path().join("config"))
        .env_remove("RIO_ENDPOINT_URL")
        .args(["review", "--profile", "rio/qa", "--format", "json"])
        .output()
        .unwrap();
    let report: Value = serde_json::from_slice(&output.stdout)
        .unwrap_or_else(|_| panic!("{}", String::from_utf8_lossy(&output.stderr)));
    assert!(
        report["deferred"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["step"] == "qa" && row["reason"] == "no_runtime"),
        "{report}"
    );
    assert!(
        report["footer"]["notes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|note| note
                .as_str()
                .is_some_and(|s| s.contains("reachable Docker daemon")))
    );
}
#[test]
fn validation_rejects_incompatible_chain_before_any_execution() {
    let root = fixture();
    let mut cart = journey("cart");
    cart["viewports"] = json!(["mobile"]);
    write(root.path(), ".rio/qa/journeys/cart.yaml", &cart);
    let failure = rio(root.path())
        .arg("validate")
        .assert()
        .code(2)
        .get_output()
        .stderr
        .clone();
    let message = String::from_utf8(failure).unwrap();
    for detail in ["incompatible chain matrices", "checkout", "cart", "desktop"] {
        assert!(message.contains(detail), "{message}");
    }
    let mut checkout = journey("checkout");
    checkout["viewports"] = json!(["mobile"]);
    write(root.path(), ".rio/qa/journeys/checkout.yaml", &checkout);
    rio(root.path()).arg("validate").assert().success();
}
#[test]
fn list_keeps_candidates_separate_and_show_retains_dependencies() {
    let root = fixture();
    let mut candidate = journey("checkout");
    candidate["sync_reason"] = json!("Guidance changed");
    write(
        root.path(),
        ".rio/qa/journeys/checkout.proposed.yaml",
        &candidate,
    );
    let result = rio(root.path())
        .arg("list")
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let value: Value = serde_json::from_slice(&result).unwrap();
    assert_eq!(value["journeys"].as_array().unwrap().len(), 2);
    assert_eq!(value["candidates"].as_array().unwrap().len(), 1);
    let result = rio(root.path())
        .args(["show", "checkout"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    assert_eq!(
        serde_json::from_slice::<Value>(&result).unwrap()["after"],
        json!(["cart"])
    );
    rio(root.path()).args(["show", "unknown"]).assert().code(2);
}

#[test]
fn show_contract_and_fixture_status_inspect_definitions_without_starting_services() {
    let root = fixture();
    write(
        root.path(),
        ".rio/qa/fixtures/fixtures.yaml",
        &json!({"version":1,
        "files":[{"name":"contacts","generate":{"kind":"csv","rows":2}}],
        "services":[{"name":"mail","kind":"smtp-capture","env":{}}],"capture":{"mail":true}}),
    );
    let config = rio(root.path())
        .arg("show")
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    assert_eq!(
        serde_json::from_slice::<Value>(&config).unwrap()["app"]["packaging"],
        "static"
    );
    let status = rio(root.path())
        .args(["fixtures", "status"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let status: Value = serde_json::from_slice(&status).unwrap();
    assert_eq!(status["files"][0]["source"], "generated");
    assert_eq!(status["services"][0]["source"], "captured");
    assert_eq!(status["runtime_started"], false);
}
#[test]
fn guidance_only_sync_check_flags_stale_journeys_without_writing_candidates() {
    let root = fixture();
    rio(root.path())
        .args(["sync", "--check"])
        .assert()
        .success();
    fs::write(
        root.path().join("REVIEW.md"),
        "Checkout must allow guests and preserve entered addresses.\n",
    )
    .unwrap();
    let output = rio(root.path())
        .args(["sync", "--check"])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();
    let value: Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(value["possibly_stale"]["checkout"], json!(["REVIEW.md"]));
    assert!(
        !root
            .path()
            .join(".rio/qa/journeys/checkout.proposed.yaml")
            .exists()
    );
    let rules = rio(root.path())
        .arg("rules")
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    assert!(String::from_utf8(rules).unwrap().contains("ux/"));
}

#[test]
fn sync_with_no_stale_journeys_does_not_need_a_runtime_or_model() {
    let root = fixture();
    let output = rio(root.path())
        .env("RIO_CONFIG_DIR", root.path().join("user-config"))
        .env_remove("RIO_QA_MODEL_ROUTE")
        .arg("sync")
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let result: Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(result["possibly_stale"], json!({}));
    assert_eq!(result["checked_without_runtime"], true);
}

#[cfg(unix)]
#[test]
fn standalone_qa_skips_static_and_agent_steps_and_keeps_the_report_when_publish_has_no_pr() {
    use std::os::unix::fs::PermissionsExt;
    let root = fixture();
    let host = tempfile::tempdir().unwrap();
    let docker = host.path().join("docker");
    fs::write(&docker, "#!/bin/sh\nexit 1\n").unwrap();
    fs::set_permissions(&docker, fs::Permissions::from_mode(0o700)).unwrap();
    let paths = std::iter::once(host.path().to_path_buf())
        .chain(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        ))
        .collect::<Vec<_>>();
    let output = rio(root.path())
        .env("PATH", std::env::join_paths(paths).unwrap())
        .env("RIO_CONFIG_DIR", host.path().join("config"))
        .env("RIO_CACHE_DIR", host.path().join("cache"))
        .env_remove("RIO_ENDPOINT_URL")
        .args(["--full", "--format", "json", "--publish"])
        .assert()
        .code(2)
        .get_output()
        .clone();
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["checks"], json!([]));
    let notes = report["footer"]["notes"].as_array().unwrap();
    for step in ["checks", "triage", "agents", "security"] {
        assert!(notes.contains(&json!(format!("{step} skipped: standalone"))));
        assert!(
            !report["deferred"]
                .as_array()
                .unwrap()
                .iter()
                .any(|row| row["step"] == step)
        );
    }
    assert!(
        report["deferred"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["step"] == "verify")
    );
    assert!(String::from_utf8_lossy(&output.stderr).contains("GitHub App pull request transport"));
    assert!(host.path().join("cache").exists());
}

#[test]
fn doctor_reports_subscription_authentication_without_exposing_credentials() {
    let root = fixture();
    let codex = root.path().join("host-codex");
    fs::create_dir(&codex).unwrap();
    fs::write(
        codex.join("auth.json"),
        r#"{"auth_mode":"chatgpt","tokens":{"access_token":"private-subscription-value"}}"#,
    )
    .unwrap();
    let output = Command::new(assert_cmd::cargo::cargo_bin!("rio"))
        .current_dir(root.path())
        .env("RIO_CONFIG_DIR", root.path().join("user-config"))
        .env("RIO_CACHE_DIR", root.path().join("cache"))
        .env("CODEX_HOME", &codex)
        .args(["doctor", "--format", "json"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let text = String::from_utf8(output).unwrap();
    assert!(!text.contains("private-subscription-value"));
    let result: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(
        result["qa"]["authentication"]["harness_auth"],
        "subscription"
    );
    assert_eq!(result["qa"]["authentication"]["tokens"], "unmetered");
    assert!(result["qa"]["docker_available"].is_boolean());
}

#[cfg(unix)]
#[test]
fn seed_status_inspects_an_image_without_starting_containers_or_claiming_an_uncached_seed() {
    use std::os::unix::fs::PermissionsExt;
    let root = fixture();
    let bin = root.path().join("host-bin");
    fs::create_dir(&bin).unwrap();
    let docker = bin.join("docker");
    fs::write(
        &docker,
        format!(
            "#!/bin/sh\n[ \"$1 $2\" = 'image inspect' ] || exit 99\nprintf 'sha256:{}\\n'\n",
            "a".repeat(64)
        ),
    )
    .unwrap();
    fs::set_permissions(&docker, fs::Permissions::from_mode(0o755)).unwrap();
    let output = rio(root.path())
        .env("PATH", &bin)
        .env("RIO_CONFIG_DIR", root.path().join("user-config"))
        .env("RIO_CACHE_DIR", root.path().join("cache"))
        .args(["seed", "status", "--image", "synthetic-image"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let result: Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(result["next"], "build");
    assert_eq!(result["reason"], "no cached snapshot");
    assert_eq!(result["fingerprint"].as_str().unwrap().len(), 64);
    assert_eq!(result["image"], "synthetic-image");
    assert!(!root.path().join("cache/qa-seeds").exists());
}

#[test]
fn evidence_prune_uses_the_configured_endpoint_without_loading_a_project() {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    let root = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(10)))
            .unwrap();
        let mut data = Vec::new();
        let mut buffer = [0; 2048];
        while !data.windows(4).any(|part| part == b"\r\n\r\n") {
            let count = stream.read(&mut buffer).unwrap();
            assert!(count > 0);
            data.extend_from_slice(&buffer[..count]);
        }
        let request = String::from_utf8(data).unwrap();
        assert!(request.starts_with("DELETE /v1/qa/reviews/review-123/evidence HTTP/1.1"));
        assert!(
            request
                .to_lowercase()
                .contains("authorization: bearer synthetic-qa-owner-token-123456789")
        );
        let body = r#"{"pruned":true}"#;
        write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
    });
    let output = rio(root.path())
        .env("RIO_CONFIG_DIR", root.path().join("config"))
        .env("RIO_ENDPOINT_URL", format!("http://{address}"))
        .env("RIO_API_TOKEN", "synthetic-qa-owner-token-123456789")
        .args(["evidence", "prune", "--review", "review-123"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    assert_eq!(
        serde_json::from_slice::<Value>(&output).unwrap(),
        json!({"pruned":true})
    );
    server.join().unwrap();
}

#[test]
fn seed_prune_works_without_project_or_docker_and_defaults_to_three_snapshots() {
    let root = tempfile::tempdir().unwrap();
    let cache = root.path().join("cache");
    let output = rio(root.path())
        .env("RIO_CONFIG_DIR", root.path().join("config"))
        .env("RIO_CACHE_DIR", &cache)
        .args(["seed", "prune"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    assert_eq!(
        serde_json::from_slice::<Value>(&output).unwrap(),
        json!({"storage":"local","removed":[],"keep":3})
    );
    assert!(!cache.join("qa-seeds").exists());
}

#[test]
fn init_rejects_compose_and_writes_only_a_reviewable_dockerfile_skeleton() {
    let root = tempfile::tempdir().unwrap();
    git(root.path(), &["init", "-q"]);
    fs::write(root.path().join("compose.yaml"), "services: {}\n").unwrap();
    let result = rio(root.path()).arg("init").output().unwrap();
    assert_eq!(result.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&result.stderr).contains("unsupported_topology"));
    assert!(root.path().join("Dockerfile.qa.proposed").exists());
    assert!(!root.path().join(".rio/qa/journeys").exists());
    assert!(!root.path().join(".rio/qa.yaml").exists());
}

#[test]
fn init_shows_and_writes_detected_contract_before_any_model_or_seed_generation() {
    let root = tempfile::tempdir().unwrap();
    let host = tempfile::tempdir().unwrap();
    git(root.path(), &["init", "-q"]);
    fs::write(
        root.path().join("Dockerfile"),
        "FROM node:22\nEXPOSE 3000\n",
    )
    .unwrap();
    let result = rio(root.path())
        .arg("init")
        .env("CODEX_HOME", host.path().join("no-auth"))
        .env("RIO_CONFIG_DIR", host.path().join("config"))
        .env_remove("RIO_QA_MODEL_ROUTE")
        .output()
        .unwrap();
    assert_eq!(result.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&result.stderr);
    assert!(stderr.contains("http://127.0.0.1:3000"), "{stderr}");
    assert!(stderr.contains("QA authoring needs"), "{stderr}");
    let contract: Value =
        serde_yaml::from_slice(&fs::read(root.path().join(".rio/qa.yaml")).unwrap()).unwrap();
    assert_eq!(contract["app"]["dockerfile"], "Dockerfile");
    assert!(root.path().join(".rio/qa/skills/rio-qa/SKILL.md").exists());
    assert!(!root.path().join(".rio/qa/journeys").exists());
}

#[test]
fn contract_acceptance_requires_a_staged_proposal_and_never_replaces_existing_contracts() {
    let root = fixture();
    let existing = fs::read(root.path().join(".rio/qa.yaml")).unwrap();
    let result = rio(root.path())
        .args(["init", "--accept-contract", "--force"])
        .output()
        .unwrap();
    assert_eq!(result.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&result.stderr).contains("cannot replace"));
    assert_eq!(
        fs::read(root.path().join(".rio/qa.yaml")).unwrap(),
        existing
    );
    fs::remove_file(root.path().join(".rio/qa.yaml")).unwrap();
    let result = rio(root.path())
        .args(["init", "--accept-contract"])
        .output()
        .unwrap();
    assert_eq!(result.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&result.stderr).contains("No .rio/qa.proposed.yaml"));
    assert!(!root.path().join(".rio/qa.yaml").exists());
}

/// A terminal that answers no query (no device attributes, no cursor
/// position): the QA UI must still read keys and redraw. Image detection
/// once left a thread reading stdin, and a full redraw asked for the cursor.
#[cfg(unix)]
#[test]
fn the_qa_ui_works_in_a_terminal_that_answers_no_query() {
    use std::{
        io::{Read, Write},
        os::{fd::FromRawFd, unix::fs::PermissionsExt},
        process::Stdio,
        time::{Duration, Instant},
    };
    let root = fixture();
    let host = tempfile::tempdir().unwrap();
    let docker = host.path().join("docker");
    fs::write(&docker, "#!/bin/sh\nexit 1\n").unwrap();
    fs::set_permissions(&docker, fs::Permissions::from_mode(0o700)).unwrap();
    let paths = std::iter::once(host.path().to_path_buf())
        .chain(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        ))
        .collect::<Vec<_>>();
    let (mut leader, mut follower) = (0, 0);
    let mut size = libc::winsize {
        ws_row: 40,
        ws_col: 120,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    // SAFETY: two out-pointers and a valid winsize.
    assert_eq!(
        unsafe {
            libc::openpty(
                &mut leader,
                &mut follower,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut size,
            )
        },
        0
    );
    // SAFETY: openpty returned these descriptors; each is owned once.
    let (mut input, output, stdin, stdout, stderr) = unsafe {
        (
            std::fs::File::from_raw_fd(libc::dup(leader)),
            std::fs::File::from_raw_fd(leader),
            Stdio::from_raw_fd(libc::dup(follower)),
            Stdio::from_raw_fd(libc::dup(follower)),
            Stdio::from_raw_fd(follower),
        )
    };
    let mut child = Process::new(assert_cmd::cargo::cargo_bin!("rio"))
        .current_dir(root.path())
        .env("PATH", std::env::join_paths(paths).unwrap())
        .env("RIO_CONFIG_DIR", host.path().join("config"))
        .env("TERM", "xterm-256color")
        .env("COLORTERM", "truecolor")
        .env_remove("NO_COLOR")
        .env_remove("CI")
        .env_remove("RIO_TUI")
        .env_remove("RIO_ENDPOINT_URL")
        .args(["qa", "--journey", "cart"])
        .stdin(stdin)
        .stdout(stdout)
        .stderr(stderr)
        .spawn()
        .unwrap();
    // Read the screen on a thread; the test waits on what it shows.
    let (sender, received) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut output = output;
        let mut buffer = [0u8; 65536];
        while let Ok(n) = output.read(&mut buffer) {
            if n == 0 || sender.send(buffer[..n].to_vec()).is_err() {
                break;
            }
        }
    });
    let mut seen = Vec::new();
    let mut wait_for = |needle: &str, seconds: u64| {
        let end = Instant::now() + Duration::from_secs(seconds);
        while Instant::now() < end {
            if let Ok(chunk) = received.recv_timeout(Duration::from_millis(100)) {
                seen.extend(chunk);
            }
            if String::from_utf8_lossy(&seen).contains(needle) {
                return true;
            }
        }
        false
    };
    assert!(wait_for("select", 30), "Q1 never drew");
    std::thread::sleep(Duration::from_millis(500));
    input.write_all(b"\r").unwrap();
    // The matrix's own key bar (Q1 also names the Matrix tab).
    let opened = wait_for("follow log", 30);
    let text = String::from_utf8_lossy(&seen).into_owned();
    input.write_all(b"\x03").unwrap();
    std::thread::sleep(Duration::from_millis(300));
    input.write_all(b"\x03").unwrap();
    let _ = child.kill();
    let _ = child.wait();
    assert!(
        !text.contains("cursor position could not be read"),
        "the UI exited on the unanswered cursor query"
    );
    assert!(opened, "Enter did not open the matrix");
}

//! The documentation command must work with only a copied binary, without
//! reading a repository, credentials, or even a valid machine configuration.
use serde_json::Value;
use std::{
    fs,
    path::Path,
    process::{Command, Output},
};

fn run(root: &Path, args: &[&str]) -> Output {
    Command::new(assert_cmd::cargo::cargo_bin!("rio"))
        .args(["docs"])
        .args(args)
        .current_dir(root)
        .env("RIO_CONFIG_DIR", root.join("broken-config"))
        .env("RIO_CACHE_DIR", root.join("do-not-create"))
        .env("RIO_ENDPOINT_URL", "http://127.0.0.1:1")
        .env("RIO_API_TOKEN", "not-a-real-token")
        .env("PATH", "")
        .env("NO_COLOR", "1")
        .output()
        .unwrap()
}
fn validate(output: &Output) -> Value {
    assert!(
        output.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let data: Value = serde_json::from_slice(&output.stdout).unwrap();
    let schema: Value =
        serde_json::from_str(include_str!("../../../schemas/docs-v1.json")).unwrap();
    let validator = jsonschema::validator_for(&schema).unwrap();
    assert!(validator.is_valid(&data), "{data}");
    data
}
#[test]
fn copied_binary_ignores_invalid_configuration_and_needs_no_helpers() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::create_dir(root.join("broken-config")).unwrap();
    fs::write(
        root.join("broken-config/config.toml"),
        "this is not valid TOML [",
    )
    .unwrap();
    let target = root.join(if cfg!(windows) {
        "rio-copy.exe"
    } else {
        "rio-copy"
    });
    fs::copy(assert_cmd::cargo::cargo_bin!("rio"), &target).unwrap();
    let out = Command::new(&target)
        .args(["docs", "review", "--format", "json"])
        .current_dir(root)
        .env("PATH", "")
        .env("RIO_CONFIG_DIR", root.join("broken-config"))
        .env("RIO_CACHE_DIR", root.join("do-not-create"))
        .env("RIO_ENDPOINT_URL", "http://127.0.0.1:1")
        .output()
        .unwrap();
    assert!(out.status.success());
    assert_eq!(validate(&out)["data"]["id"], "review");
    // A regular file as the parent makes these locations unusable on every OS,
    // including privileged test runners where chmod would not be meaningful.
    let blocker = root.join("not-a-directory");
    fs::write(&blocker, "unchanged").unwrap();
    let unavailable = Command::new(&target)
        .args(["docs", "review", "--format", "json"])
        .current_dir(root)
        .env("PATH", "")
        .env("RIO_CONFIG_DIR", blocker.join("config"))
        .env("RIO_CACHE_DIR", blocker.join("cache"))
        .output()
        .unwrap();
    assert!(unavailable.status.success());
    assert_eq!(unavailable.stdout, out.stdout);
    assert_eq!(fs::read_to_string(blocker).unwrap(), "unchanged");
    assert!(!root.join("do-not-create").exists());
    assert!(!root.join(".rio").exists());
    assert_eq!(
        fs::read_to_string(root.join("broken-config/config.toml")).unwrap(),
        "this is not valid TOML ["
    );
}
#[test]
fn every_topic_and_section_has_bounded_valid_output() {
    let dir = tempfile::tempdir().unwrap();
    let corpus: Value = serde_json::from_str(include_str!("../assets/docs.json")).unwrap();
    let index = run(dir.path(), &[]);
    assert!(index.status.success());
    assert!(index.stdout.len() <= 4096);
    assert_eq!(index.stdout, run(dir.path(), &["list"]).stdout);
    for topic in corpus["topics"].as_array().unwrap() {
        let id = topic["id"].as_str().unwrap();
        let plain = run(dir.path(), &[id]);
        assert!(plain.status.success(), "{id}");
        assert!(plain.stdout.len() <= 8192);
        assert!(!plain.stdout.contains(&27));
        let out = run(dir.path(), &[id, "--format", "json"]);
        assert!(out.status.success());
        assert!(out.stdout.len() <= 12288);
        let data = validate(&out);
        assert_eq!(data["docs_revision"], corpus["revision"]);
        for section in topic["sections"].as_array().unwrap() {
            let sid = section["id"].as_str().unwrap();
            let out = run(dir.path(), &[id, "--section", sid, "--format", "json"]);
            assert!(out.status.success());
            let data = validate(&out);
            assert_eq!(data["kind"], "section");
            assert_eq!(data["data"]["sections"].as_array().unwrap().len(), 1);
            assert_eq!(data["data"]["prerequisites"], topic["prerequisites"]);
            assert!(run(dir.path(), &[id, "--section", sid]).stdout.len() <= 4096);
        }
    }
}
#[test]
fn semantic_errors_are_json_and_parser_errors_are_stderr() {
    let dir = tempfile::tempdir().unwrap();
    for (args, code) in [
        (vec!["nonexistent"], "unknown_topic"),
        (vec!["../config.toml"], "unknown_topic"),
        (vec!["https://example.invalid"], "unknown_topic"),
        (vec!["review", "--section", "absent"], "unknown_section"),
        (vec!["--section", "inheritance"], "invalid_arguments"),
        (vec!["list", "--section", "x"], "invalid_arguments"),
        (vec!["search", "x", "--section", "x"], "invalid_arguments"),
        (vec!["review", "--limit", "1"], "invalid_arguments"),
        (vec!["search", " "], "invalid_query"),
        (vec!["search", "x", "--limit", "0"], "invalid_limit"),
        (vec!["search", "x", "--limit", "11"], "invalid_limit"),
    ] {
        let mut json_args = args.clone();
        json_args.extend(["--format", "json"]);
        let out = run(dir.path(), &json_args);
        assert_eq!(out.status.code(), Some(2));
        assert_eq!(validate(&out)["data"]["code"], code);
        let text = run(dir.path(), &args);
        assert!(text.stdout.is_empty());
        assert!(!text.stderr.is_empty());
    }
    let long = "x".repeat(257);
    let out = run(dir.path(), &["search", &long, "--format", "json"]);
    assert_eq!(validate(&out)["data"]["code"], "invalid_query");
    let out = run(dir.path(), &["--format", "xml"]);
    assert_eq!(out.status.code(), Some(2));
    assert!(out.stdout.is_empty());
    assert!(!out.stderr.is_empty());
}
#[test]
fn search_is_ranked_bounded_and_case_insensitive() {
    let dir = tempfile::tempdir().unwrap();
    let one = run(
        dir.path(),
        &["search", "profiles", "--limit", "1", "--format", "json"],
    );
    let data = validate(&one);
    assert_eq!(data["data"]["results"][0]["topic"], "profiles");
    assert_eq!(
        one.stdout,
        run(
            dir.path(),
            &["search", "PROFILES", "--limit", "1", "--format", "json"]
        )
        .stdout
    );
    let empty = run(
        dir.path(),
        &["search", "zz-nothing-matches", "--format", "json"],
    );
    assert!(empty.status.success());
    assert!(
        validate(&empty)["data"]["results"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let hits = validate(&run(
        dir.path(),
        &["search", "rio", "--limit", "10", "--format", "json"],
    ));
    assert_eq!(hits["data"]["results"].as_array().unwrap().len(), 10);
    assert_eq!(hits["data"]["more"], true);
    let match_ = validate(&run(
        dir.path(),
        &["search", "dependency mismatch", "--format", "json"],
    ));
    assert!(!match_["data"]["results"].as_array().unwrap().is_empty());
}
#[test]
fn locale_color_ci_and_directory_do_not_affect_success_output() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let expected = run(a.path(), &["profiles", "--section", "inheritance"]).stdout;
    let output = Command::new(assert_cmd::cargo::cargo_bin!("rio"))
        .args(["docs", "profiles", "--section", "inheritance"])
        .current_dir(b.path())
        .env("LANG", "pt_BR.UTF-8")
        .env("LC_ALL", "C")
        .env("CI", "1")
        .env("CLICOLOR_FORCE", "1")
        .env("RIO_TUI", "1")
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(expected, output.stdout);
    assert!(!output.stdout.contains(&27));
}

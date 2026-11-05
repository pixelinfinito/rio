#[path = "../../rio-adapters/tests/common/mod.rs"]
mod common;
use common::*;
use rio_adapters::ProcessSupervisor;
use rio_core::*;
use rio_engine::*;
use rio_git::{GixRepo, Repo, SafeTreeWriter, Selection, select};
use rio_profile::{ProfileLoader, ResolvedProfile};
use std::{fs, path::Path, time::Duration};
use tokio_util::sync::CancellationToken;

fn git(root: &Path, args: &[&str]) {
    let output = std::process::Command::new("git")
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
fn init(root: &Path) {
    git(root, &["init", "-b", "main"]);
    git(root, &["config", "user.email", "rio@example.invalid"]);
    git(root, &["config", "user.name", "Rio Test"]);
}
fn profile(root: &Path, budget: &str, baseline: bool) -> ResolvedProfile {
    let path = root.join("profile.yaml");
    fs::write(&path,format!("version: 1\nname: engine-test\nextends: rio/base\nbudget:\n  fast: {{wall_time: {budget}}}\nsteps:\n  - id: prepare\n    uses: rio/prepare\n  - id: checks\n    uses: rio/checks\n    needs: [prepare]\n    with: {{typecheck: true, lint: false, coverage: false, secrets: true, dependencies: false, baseline: {baseline}}}\n  - id: graph\n    uses: rio/graph\n    needs: [prepare]\n  - id: triage\n    uses: rio/triage\n    needs: [checks, graph]\n  - id: agents\n    uses: rio/agents\n    needs: [triage]\n  - id: verify\n    uses: rio/verify\n    needs: [agents]\n  - id: report\n    uses: rio/report\n    needs: [verify]\n")).unwrap();
    ProfileLoader::new(Some(root.into()), root.join("config"), root.into())
        .load(Some(path.to_str().unwrap()))
        .unwrap()
}
fn request(root: &Path, profile: ResolvedProfile) -> ReviewRequest {
    let repo = GixRepo::discover(root).unwrap();
    let changes = select(&repo, Selection::WorkingTree).unwrap();
    ReviewRequest {
        worktree: root.into(),
        working: repo.working_tree().unwrap(),
        changes,
        profile,
        cache: CacheOptions::for_repository(root),
        parallelism: 2,
        output_limit: 1024 * 1024,
        offline: true,
    }
}

#[tokio::test]
async fn real_typecheck_classifies_cross_file_regressions_existing_errors_and_worsened_occurrences()
{
    let original = fixture("ts-sample");
    if !require_tool(original.join("node_modules/.bin/tsc").exists(), "tsc") {
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let tree = read_tree(&original);
    SafeTreeWriter::new(root)
        .unwrap()
        .write_tree(&tree)
        .unwrap();
    fs::write(root.join(".gitignore"), "node_modules/\n.rio/cache/\n").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(original.join("node_modules"), root.join("node_modules")).unwrap();
    #[cfg(windows)]
    std::os::windows::fs::symlink_dir(original.join("node_modules"), root.join("node_modules"))
        .unwrap();
    init(root);
    let profile = profile(root, "60s", true);
    git(root, &["add", "."]);
    git(root, &["commit", "-m", "base"]);
    fs::write(
        root.join("src/math.ts"),
        "export function format(value: string): string {\n  return value.toUpperCase();\n}\n",
    )
    .unwrap();
    fs::write(root.join("src/duplicate.ts"),"export function duplicate(value?: {name: string}): string {\n  const first = value.name;\n  const second = value.name;\n  return first + second;\n}\n").unwrap();
    let (sender, mut events) = tokio::sync::mpsc::unbounded_channel();
    let report = review(
        request(root, profile.clone()),
        ProcessSupervisor::default(),
        CancellationToken::new(),
        Some(sender),
    )
    .await
    .unwrap();
    assert!(
        report
            .findings
            .iter()
            .any(|finding| finding.location.path == "src/caller.ts" && finding.state == State::New),
        "{:#?}",
        report.checks
    );
    assert!(
        report
            .findings
            .iter()
            .any(|finding| finding.location.path == "src/existing.ts"
                && finding.state == State::PreExisting)
    );
    let duplicate = report
        .findings
        .iter()
        .find(|finding| finding.location.path == "src/duplicate.ts")
        .unwrap();
    assert_eq!(duplicate.state, State::Worsened);
    assert!(
        duplicate
            .locations
            .iter()
            .any(|location| location.occurrence_state == OccurrenceState::New)
    );
    assert!(
        duplicate
            .locations
            .iter()
            .any(|location| location.occurrence_state == OccurrenceState::PreExisting)
    );
    assert_eq!(
        exit_code(
            &report,
            &profile.profile.fail_on.compile().unwrap(),
            ExitContext::default()
        ),
        1
    );
    assert_eq!(
        report
            .deferred
            .iter()
            .map(|step| step.step.as_str())
            .collect::<Vec<_>>(),
        ["triage", "agents", "verify"]
    );
    assert!(
        report
            .footer
            .notes
            .iter()
            .any(|note| note.contains("not network-isolated"))
    );
    let mut received = Vec::new();
    while let Some(event) = events.recv().await {
        received.push(event);
    }
    assert!(matches!(received.first(),Some(ReviewEvent::StepStarted {step}) if step=="prepare"));
    assert!(matches!(received.last(), Some(ReviewEvent::Done { .. })));
    let schema: serde_json::Value =
        serde_json::from_str(include_str!("../../../schemas/report-v1.json")).unwrap();
    let validator = jsonschema::validator_for(&schema).unwrap();
    let document = serde_json::to_value(&report).unwrap();
    assert!(
        validator.is_valid(&document),
        "{:?}",
        validator
            .iter_errors(&document)
            .map(|error| error.to_string())
            .collect::<Vec<_>>()
    );
    let second = review(
        request(root, profile),
        ProcessSupervisor::default(),
        CancellationToken::new(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(report.review.id, second.review.id);
    assert_ne!(report.review.run_id, second.review.run_id);
    assert!(
        second
            .checks
            .iter()
            .any(|check| check.version == Version::Base && check.cached)
    );
    assert!(
        second
            .footer
            .notes
            .iter()
            .any(|note| note.contains("baseline cached"))
    );
    let directory = root.join(".rio/cache").join(report.review.id.unwrap());
    assert_eq!(fs::read_dir(directory.join("runs")).unwrap().count(), 2);
    assert!(directory.join("latest").exists());
}

#[cfg(unix)]
fn slow_fixture(root: &Path, budget: &str) -> ResolvedProfile {
    use std::os::unix::fs::PermissionsExt;
    fs::write(
        root.join("package.json"),
        r#"{"name":"fake","version":"1.0.0","dependencies":{}}"#,
    )
    .unwrap();
    let lock =
        r#"{"name":"fake","lockfileVersion":3,"packages":{"":{"name":"fake","version":"1.0.0"}}}"#;
    fs::write(root.join("package-lock.json"), lock).unwrap();
    fs::create_dir_all(root.join("node_modules/.bin")).unwrap();
    fs::write(root.join("node_modules/.package-lock.json"), lock).unwrap();
    let code = format!(
        "#!/usr/bin/python3\nimport sys,subprocess,time,pathlib\nif '--version' in sys.argv:\n print('Version 5.7.3');sys.exit(0)\nchild=subprocess.Popen([sys.executable,'-c','import time;time.sleep(3600)'])\npathlib.Path({:?}).write_text(str(child.pid))\ntime.sleep(3600)\n",
        root.join("worker.pid").to_str().unwrap()
    );
    fs::write(root.join("node_modules/.bin/tsc"), code).unwrap();
    fs::set_permissions(
        root.join("node_modules/.bin/tsc"),
        fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    fs::write(root.join("tsconfig.json"), "{}").unwrap();
    fs::write(root.join("a.ts"), "export const value = 1;\n").unwrap();
    fs::write(
        root.join(".gitignore"),
        "node_modules/\n.rio/cache/\nworker.pid\n",
    )
    .unwrap();
    init(root);
    let profile = profile(root, budget, false);
    git(root, &["add", "."]);
    git(root, &["commit", "-m", "base"]);
    fs::write(root.join("a.ts"), "export const value = 2;\n").unwrap();
    profile
}

#[cfg(unix)]
#[tokio::test]
async fn timeout_terminates_workers_keeps_other_checks_and_marks_incomplete() {
    let temp = tempfile::tempdir().unwrap();
    let profile = slow_fixture(temp.path(), "10s");
    let report = review(
        request(temp.path(), profile.clone()),
        ProcessSupervisor::default(),
        CancellationToken::new(),
        None,
    )
    .await
    .unwrap();
    assert!(
        report.checks.iter().any(|check| matches!(
            check.outcome,
            CheckOutcome::Cancelled {
                reason: CancellationReason::Timeout,
                ..
            }
        )),
        "{:#?}",
        report.checks
    );
    assert!(
        report
            .checks
            .iter()
            .any(|check| check.kind == CheckKind::Secrets
                && matches!(check.outcome, CheckOutcome::Passed { .. })),
        "{:#?}",
        report.checks
    );
    assert_eq!(
        exit_code(
            &report,
            &profile.profile.fail_on.compile().unwrap(),
            ExitContext::default()
        ),
        4
    );
    let pid: u32 = fs::read_to_string(temp.path().join("worker.pid"))
        .unwrap()
        .parse()
        .unwrap();
    assert!(!Path::new("/proc").join(pid.to_string()).exists());
}

#[cfg(unix)]
#[tokio::test]
async fn cancellation_records_interrupted_checks_and_returns_a_partial_report() {
    let temp = tempfile::tempdir().unwrap();
    let profile = slow_fixture(temp.path(), "60s");
    let cancellation = CancellationToken::new();
    let signal = cancellation.clone();
    let input = request(temp.path(), profile.clone());
    let path = temp.path().join("worker.pid");
    let cancel = tokio::spawn(async move {
        tokio::time::timeout(Duration::from_secs(10), async {
            while !path.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        signal.cancel();
    });
    let report = review(input, ProcessSupervisor::default(), cancellation, None)
        .await
        .unwrap();
    cancel.await.unwrap();
    assert_eq!(report.status, ReportStatus::Partial);
    assert!(report.checks.iter().any(|check| matches!(
        check.outcome,
        CheckOutcome::Cancelled {
            reason: CancellationReason::Interrupted,
            ..
        }
    )));
    assert_eq!(
        exit_code(
            &report,
            &profile.profile.fail_on.compile().unwrap(),
            ExitContext::default()
        ),
        4
    );
    let pid: u32 = fs::read_to_string(temp.path().join("worker.pid"))
        .unwrap()
        .parse()
        .unwrap();
    assert!(!Path::new("/proc").join(pid.to_string()).exists());
}

#[cfg(unix)]
fn diagnostic_fixture(root: &Path, lint: bool) -> ResolvedProfile {
    use std::os::unix::fs::PermissionsExt;
    fs::create_dir_all(root.join("node_modules/.bin")).unwrap();
    fs::write(root.join("node_modules/.bin/tsc"),"#!/bin/sh\nif [ \"$1\" = --version ]; then echo 'Version 5.7.3'; exit 0; fi\necho \"a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\"\nexit 2\n").unwrap();
    fs::write(root.join("node_modules/.bin/eslint"),"#!/usr/bin/python3\nimport sys,json,os\nif '--version' in sys.argv: print('v9.18.0');sys.exit(0)\nprint(json.dumps([dict(filePath=os.path.abspath(path),messages=[dict(ruleId='no-unused-vars',severity=2,message='unused value',line=1,column=7)]) for path in sys.argv[1:] if path.endswith('.ts')]))\nsys.exit(1)\n").unwrap();
    for tool in ["tsc", "eslint"] {
        fs::set_permissions(
            root.join("node_modules/.bin").join(tool),
            fs::Permissions::from_mode(0o755),
        )
        .unwrap();
    }
    let package = r#"{"name":"fixture","version":"1.0.0","dependencies":{"example":"1.0.0"}}"#;
    let lock = r#"{"lockfileVersion":3,"packages":{"":{"name":"fixture","version":"1.0.0","dependencies":{"example":"1.0.0"}},"node_modules/example":{"name":"example","version":"1.0.0"}}}"#;
    fs::write(root.join("package.json"), package).unwrap();
    fs::write(root.join("package-lock.json"), lock).unwrap();
    fs::write(root.join("node_modules/.package-lock.json"), lock).unwrap();
    fs::create_dir_all(root.join("node_modules/example")).unwrap();
    fs::write(
        root.join("node_modules/example/package.json"),
        "{\"name\":\"example\",\"version\":\"1.0.0\"}",
    )
    .unwrap();
    fs::write(root.join("tsconfig.json"), "{}").unwrap();
    fs::write(root.join("eslint.config.js"), "export default [];").unwrap();
    for path in ["a.ts", "b.ts"] {
        fs::write(root.join(path), "const x:number='a';\n").unwrap();
    }
    fs::write(root.join(".gitignore"), "node_modules/\n.rio/cache/\n").unwrap();
    init(root);
    let mut profile = profile(root, "60s", true);
    let step = profile
        .profile
        .steps
        .iter_mut()
        .find(|s| s.id == "checks")
        .unwrap();
    step.options["typecheck"] = serde_json::json!(!lint);
    step.options["lint"] = serde_json::json!(lint);
    git(root, &["add", "."]);
    git(root, &["commit", "-m", "base"]);
    profile
}
#[cfg(unix)]
#[tokio::test]
async fn lint_baseline_cache_is_specific_to_changed_targets() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let profile = diagnostic_fixture(root, true);
    fs::write(root.join("a.ts"), "const x:number='b';\n").unwrap();
    let first = review(
        request(root, profile.clone()),
        ProcessSupervisor::default(),
        CancellationToken::new(),
        None,
    )
    .await
    .unwrap();
    assert!(
        first
            .checks
            .iter()
            .any(|c| c.kind == CheckKind::Lint && c.version == Version::Base && !c.cached)
    );
    git(root, &["checkout", "--", "a.ts"]);
    fs::write(root.join("b.ts"), "const x:number='b';\n").unwrap();
    let second = review(
        request(root, profile.clone()),
        ProcessSupervisor::default(),
        CancellationToken::new(),
        None,
    )
    .await
    .unwrap();
    let baseline = second
        .checks
        .iter()
        .find(|c| c.kind == CheckKind::Lint && c.version == Version::Base)
        .unwrap();
    assert!(!baseline.cached);
    assert!(
        baseline
            .outcome
            .details()
            .findings
            .iter()
            .all(|f| f.location.path == "b.ts")
    );
    let third = review(
        request(root, profile),
        ProcessSupervisor::default(),
        CancellationToken::new(),
        None,
    )
    .await
    .unwrap();
    assert!(
        third
            .checks
            .iter()
            .any(|c| c.kind == CheckKind::Lint && c.version == Version::Base && c.cached)
    );
}
#[cfg(unix)]
#[tokio::test]
async fn changed_lockfile_disables_baseline_classification() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let profile = diagnostic_fixture(root, false);
    fs::write(root.join("a.ts"), "const x:number='b';\n").unwrap();
    // Model a lockfile update followed by a matching installation. The base needs v1.
    for path in [
        "package.json",
        "package-lock.json",
        "node_modules/.package-lock.json",
        "node_modules/example/package.json",
    ] {
        let content = fs::read_to_string(root.join(path))
            .unwrap()
            .replace("1.0.0", "2.0.0");
        fs::write(root.join(path), content).unwrap();
    }
    let report = review(
        request(root, profile),
        ProcessSupervisor::default(),
        CancellationToken::new(),
        None,
    )
    .await
    .unwrap();
    let finding = report
        .findings
        .iter()
        .find(|f| f.rule_id == "typecheck/tsc/TS2322")
        .unwrap_or_else(|| panic!("{:#?}", report.checks));
    assert_eq!(finding.state, State::Unclassified);
    assert!(
        report
            .footer
            .notes
            .iter()
            .any(|note| note.contains("baseline_failed"))
    );
    assert!(!report.checks.iter().any(|c| c.version == Version::Base));
}
#[cfg(unix)]
#[tokio::test]
async fn concurrent_reviews_keep_separate_records_and_build_one_baseline() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let profile = diagnostic_fixture(root, false);
    fs::write(root.join("a.ts"), "const x:number='b';\n").unwrap();
    let first = request(root, profile.clone());
    let second = request(root, profile);
    let (first, second) = tokio::join!(
        review(
            first,
            ProcessSupervisor::default(),
            CancellationToken::new(),
            None
        ),
        review(
            second,
            ProcessSupervisor::default(),
            CancellationToken::new(),
            None
        )
    );
    let first = first.unwrap();
    let second = second.unwrap();
    assert_eq!(first.review.id, second.review.id);
    assert_ne!(first.review.run_id, second.review.run_id);
    let bases: Vec<_> = first
        .checks
        .iter()
        .chain(&second.checks)
        .filter(|check| check.version == Version::Base)
        .collect();
    assert_eq!(bases.len(), 2);
    assert_eq!(bases.iter().filter(|check| check.cached).count(), 1);
    for report in [&first, &second] {
        let path = root
            .join(".rio/cache")
            .join(report.review.id.as_ref().unwrap())
            .join("runs")
            .join(report.review.run_id.as_ref().unwrap());
        let persisted: Report =
            serde_json::from_slice(&fs::read(path.join("report.json")).unwrap()).unwrap();
        assert_eq!(&persisted, report);
    }
}

#[cfg(unix)]
#[tokio::test]
async fn linked_workspace_source_edit_remaps_the_importing_roots_baseline() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let profile = diagnostic_fixture(root, false);
    let lock=serde_json::json!({"lockfileVersion":3,"packages":{"":{"dependencies":{"shared":"file:packages/shared"}},"packages/shared":{"name":"shared","version":"1.0.0"},"node_modules/shared":{"resolved":"packages/shared","link":true}}}).to_string();
    fs::write(root.join("package-lock.json"), &lock).unwrap();
    fs::write(root.join("node_modules/.package-lock.json"), &lock).unwrap();
    fs::write(
        root.join("package.json"),
        "{\"dependencies\":{\"shared\":\"file:packages/shared\"}}",
    )
    .unwrap();
    fs::remove_dir_all(root.join("node_modules/example")).unwrap();
    fs::create_dir_all(root.join("packages/shared/src")).unwrap();
    fs::write(
        root.join("packages/shared/package.json"),
        "{\"name\":\"shared\",\"version\":\"1.0.0\"}",
    )
    .unwrap();
    fs::write(
        root.join("packages/shared/src/shared.ts"),
        "export const a=1;\n",
    )
    .unwrap();
    std::os::unix::fs::symlink("../packages/shared", root.join("node_modules/shared")).unwrap();
    git(root, &["add", "."]);
    git(root, &["commit", "-m", "workspace link"]);
    fs::write(
        root.join("packages/shared/src/shared.ts"),
        "export const a=2;\n",
    )
    .unwrap();
    fs::write(root.join("a.ts"), "const x:number='b';\n").unwrap();
    let report = review(
        request(root, profile),
        ProcessSupervisor::default(),
        CancellationToken::new(),
        None,
    )
    .await
    .unwrap();
    assert!(
        report
            .findings
            .iter()
            .any(|f| f.rule_id == "typecheck/tsc/TS2322" && f.state == State::PreExisting),
        "{:#?}",
        report.checks
    );
    let base = report
        .checks
        .iter()
        .find(|c| c.version == Version::Base)
        .unwrap();
    assert!(
        base.outcome
            .details()
            .hint
            .as_ref()
            .unwrap()
            .contains("baseline: 1 linked packages remapped to base")
    );
    assert!(
        !report
            .footer
            .notes
            .iter()
            .any(|note| note.contains("baseline_failed"))
    );
}

#[cfg(unix)]
#[tokio::test]
async fn raw_output_retention_can_be_disabled_without_losing_findings_or_offline_notice() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let profile = diagnostic_fixture(root, false);
    fs::write(root.join("a.ts"), "const x:number='b';\n").unwrap();
    let mut input = request(root, profile);
    input.cache.retain_raw_output = false;
    let report = review(
        input,
        ProcessSupervisor::default(),
        CancellationToken::new(),
        None,
    )
    .await
    .unwrap();
    assert!(!report.findings.is_empty());
    assert!(
        report
            .footer
            .notes
            .iter()
            .any(|note| note.contains("not network-isolated"))
    );
    let path = root
        .join(".rio/cache")
        .join(report.review.id.unwrap())
        .join("runs")
        .join(report.review.run_id.unwrap())
        .join("checks/typecheck/%2E/head");
    assert!(path.join("findings.json").exists());
    assert!(!path.join("stdout.txt").exists());
    assert!(!path.join("stderr.txt").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn trusted_dependencies_classify_new_and_pre_existing_with_verified_or_unverified_base() {
    for unverified_base in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let mut profile = diagnostic_fixture(root, false);
        if unverified_base {
            fs::remove_file(root.join("package-lock.json")).unwrap();
            git(root, &["add", "-u"]);
            git(root, &["commit", "-m", "remove lockfile"]);
        } else {
            fs::remove_file(root.join("package-lock.json")).unwrap();
        }
        profile
            .profile
            .steps
            .iter_mut()
            .find(|s| s.id == "checks")
            .unwrap()
            .options["trust_installed_dependencies"] = serde_json::json!(true);
        fs::write(
            root.join("node_modules/.bin/tsc"),
            r#"#!/bin/sh
if [ "$1" = --version ]; then echo 'Version 5.7.3'; exit 0; fi
echo "a.ts(1,7): error TS2322: Existing error."
if grep -q regression b.ts; then echo "b.ts(1,7): error TS2345: New error."; fi
exit 2
"#,
        )
        .unwrap();
        fs::write(root.join("b.ts"), "const regression = true;\n").unwrap();
        let report = review(
            request(root, profile.clone()),
            ProcessSupervisor::default(),
            CancellationToken::new(),
            None,
        )
        .await
        .unwrap();
        assert!(report.checks.iter().any(|c| c.version == Version::Base));
        for (path, state) in [("a.ts", State::PreExisting), ("b.ts", State::New)] {
            assert!(
                report
                    .findings
                    .iter()
                    .any(|f| f.location.path == path && f.state == state),
                "{report:#?}"
            );
        }
        assert!(
            report
                .footer
                .notes
                .iter()
                .any(|n| n.contains("dependencies_trusted: results use unverified dependencies"))
        );
        let repeated = review(
            request(root, profile),
            ProcessSupervisor::default(),
            CancellationToken::new(),
            None,
        )
        .await
        .unwrap();
        assert!(
            repeated
                .checks
                .iter()
                .filter(|c| c.version == Version::Base)
                .all(|c| !c.cached)
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn unavailable_baseline_scopes_occurrences_to_changed_hunks_and_context() {
    for failed_run in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let mut profile = diagnostic_fixture(root, false);
        let original = "const line = 1;\n".repeat(24);
        fs::write(root.join("a.ts"), &original).unwrap();
        git(root, &["add", "a.ts"]);
        git(root, &["commit", "-m", "multiline source"]);
        profile
            .profile
            .steps
            .iter_mut()
            .find(|s| s.id == "checks")
            .unwrap()
            .options["baseline"] = serde_json::json!(failed_run);
        fs::write(
            root.join("node_modules/.bin/tsc"),
            r#"#!/bin/sh
if [ "$1" = --version ]; then echo 'Version 5.7.3'; exit 0; fi
if ! grep -q changed a.ts; then exit 77; fi
for line in 6 7 10 13 14; do echo "a.ts($line,1): error TS2322: Same error."; done
echo "b.ts(1,1): error TS2345: Unchanged file."
exit 2
"#,
        )
        .unwrap();
        let mut lines: Vec<_> = original.lines().collect();
        lines[9] = "const changed = 2;";
        fs::write(root.join("a.ts"), lines.join("\n") + "\n").unwrap();
        let report = review(
            request(root, profile),
            ProcessSupervisor::default(),
            CancellationToken::new(),
            None,
        )
        .await
        .unwrap();
        let changed = report
            .findings
            .iter()
            .find(|f| f.location.path == "a.ts")
            .unwrap();
        assert_eq!(changed.state, State::Unclassified);
        assert_eq!(changed.location.line_start, 7);
        for location in &changed.locations {
            assert_eq!(
                location.occurrence_state,
                if [7, 10, 13].contains(&location.line_start) {
                    OccurrenceState::Unclassified
                } else {
                    OccurrenceState::PreExisting
                }
            );
        }
        let unchanged = report
            .findings
            .iter()
            .find(|f| f.location.path == "b.ts")
            .unwrap();
        assert_eq!(unchanged.state, State::PreExisting);
        assert!(
            unchanged
                .evidence
                .iter()
                .any(|e| e.contains("outside changed hunks, baseline unavailable"))
        );
        assert!(changed.evidence.iter().any(|e| e.contains("a.ts:14")));
        let default = render_markdown(&report, &RenderOptions::default());
        assert!(!default.contains("Unchanged file."));
        assert!(!default.contains("a.ts:6"));
        assert!(!default.contains("a.ts:14"));
        let expanded = render_markdown(
            &report,
            &RenderOptions {
                show_pre_existing: true,
                ..Default::default()
            },
        );
        assert!(expanded.contains("Unchanged file."));
        assert!(expanded.contains("a.ts:6"));
        assert!(expanded.contains("a.ts:14"));
        assert!(
            report
                .footer
                .notes
                .iter()
                .any(|n| n.contains(if failed_run {
                    "baseline_failed"
                } else {
                    "baseline disabled"
                }))
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn committed_workspace_change_classifies_errors_in_dependent_package() {
    let tsc = fixture("ts-sample").join("node_modules/.bin/tsc");
    if !require_tool(tsc.exists(), "tsc") {
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    init(root);
    for directory in [
        "node_modules/.bin",
        "packages/a/src",
        "packages/b/src",
        "packages/b/node_modules",
    ] {
        fs::create_dir_all(root.join(directory)).unwrap();
    }
    fs::write(root.join(".gitignore"), "node_modules/\n.rio/cache/\n").unwrap();
    fs::write(
        root.join("package.json"),
        r#"{"name":"workspace","version":"1.0.0","workspaces":["packages/*"]}"#,
    )
    .unwrap();
    fs::write(
        root.join("packages/a/package.json"),
        r#"{"name":"a","version":"1.0.0","types":"src/index.ts"}"#,
    )
    .unwrap();
    fs::write(
        root.join("packages/b/package.json"),
        r#"{"name":"b","version":"1.0.0","dependencies":{"a":"*"}}"#,
    )
    .unwrap();
    for package in ["a", "b"] {
        fs::write(root.join(format!("packages/{package}/tsconfig.json")), r#"{"compilerOptions":{"strict":true,"skipLibCheck":true,"module":"commonjs"},"include":["src"]}"#).unwrap();
    }
    fs::write(
        root.join("packages/a/src/index.ts"),
        "export const value: number = 1;\n",
    )
    .unwrap();
    fs::write(
        root.join("packages/b/src/caller.ts"),
        "import {value} from 'a';\nexport const result: number = value;\n",
    )
    .unwrap();
    fs::write(
        root.join("packages/b/src/existing.ts"),
        "export const old: number = 'old';\n",
    )
    .unwrap();
    std::os::unix::fs::symlink(&tsc, root.join("node_modules/.bin/tsc")).unwrap();
    std::os::unix::fs::symlink("../packages/a", root.join("node_modules/a")).unwrap();
    std::os::unix::fs::symlink("../packages/b", root.join("node_modules/b")).unwrap();
    std::os::unix::fs::symlink("../../a", root.join("packages/b/node_modules/a")).unwrap();
    let lock = serde_json::json!({"lockfileVersion":3,"packages":{
        "":{"name":"workspace","version":"1.0.0"},
        "packages/a":{"name":"a","version":"1.0.0"},
        "packages/b":{"name":"b","version":"1.0.0","dependencies":{"a":"*"}},
        "node_modules/a":{"resolved":"packages/a","link":true},
        "node_modules/b":{"resolved":"packages/b","link":true}
    }})
    .to_string();
    fs::write(root.join("package-lock.json"), &lock).unwrap();
    fs::write(root.join("node_modules/.package-lock.json"), &lock).unwrap();
    let profile = profile(root, "60s", true);
    git(root, &["add", "."]);
    git(root, &["commit", "-m", "base workspace"]);
    fs::write(
        root.join("packages/a/src/index.ts"),
        "export const value: string = 'new';\n",
    )
    .unwrap();
    git(root, &["add", "."]);
    git(root, &["commit", "-m", "change dependency API"]);
    let mut input = request(root, profile);
    input.changes = select(
        &GixRepo::discover(root).unwrap(),
        Selection::Branch {
            reference: "HEAD~1".into(),
        },
    )
    .unwrap();
    let report = review(
        input,
        ProcessSupervisor::default(),
        CancellationToken::new(),
        None,
    )
    .await
    .unwrap();
    assert!(
        report
            .findings
            .iter()
            .any(|f| f.location.path == "packages/b/src/caller.ts" && f.state == State::New),
        "{:#?}",
        report
    );
    assert!(
        report
            .findings
            .iter()
            .any(|f| f.location.path == "packages/b/src/existing.ts"
                && f.state == State::PreExisting),
        "{:#?}",
        report
    );
    assert!(report.checks.iter().any(|c| c.root == "packages/b"
        && c.version == Version::Base
        && c.scheduled_as == ScheduledAs::Dependent));
    assert!(
        !report
            .footer
            .notes
            .iter()
            .any(|note| note.contains("baseline_failed")),
        "{:?}",
        report.footer
    );
    assert_eq!(
        fs::read_link(root.join("packages/b/node_modules/a")).unwrap(),
        Path::new("../../a")
    );
}

#[cfg(unix)]
#[tokio::test]
async fn committed_python_editables_resolve_base_source_without_changing_head() {
    use std::os::unix::fs::PermissionsExt;
    for finder in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        init(root);
        let status = std::process::Command::new("python3")
            .args(["-m", "venv", "--without-pip"])
            .arg(root.join(".venv"))
            .status()
            .unwrap();
        assert!(status.success());
        let site = fs::read_dir(root.join(".venv/lib"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path()
            .join("site-packages");
        fs::create_dir_all(root.join("src/shared")).unwrap();
        fs::write(root.join("src/shared/__init__.py"), "value = 1\n").unwrap();
        fs::write(
            root.join("caller.py"),
            "from shared import value\nresult: int = value\n",
        )
        .unwrap();
        fs::write(root.join("existing.py"), "old: int = 'old'\n").unwrap();
        fs::write(root.join("pyproject.toml"), "[project]\nname='shared'\nversion='1.0.0'\n[tool.mypy]\nfiles=['caller.py','existing.py']\n").unwrap();
        fs::write(root.join("requirements.txt"), "shared==1.0.0\n").unwrap();
        fs::write(
            root.join(".gitignore"),
            ".venv/\n.rio/cache/\n__pycache__/\n",
        )
        .unwrap();
        fs::create_dir_all(site.join("shared-1.0.0.dist-info")).unwrap();
        fs::write(
            site.join("shared-1.0.0.dist-info/METADATA"),
            "Name: shared\nVersion: 1.0.0\n",
        )
        .unwrap();
        fs::write(site.join("shared-1.0.0.dist-info/direct_url.json"), serde_json::json!({"url":format!("file://{}",root.display()),"dir_info":{"editable":true}}).to_string()).unwrap();
        if finder {
            fs::write(
                site.join("shared.pth"),
                "import __editable__shared; __editable__shared.install()\n",
            )
            .unwrap();
            fs::write(site.join("__editable__shared.py"), format!(r#"import sys, importlib.abc, importlib.util
MAPPING = {{'shared': {:?}}}
class Finder(importlib.abc.MetaPathFinder):
    @classmethod
    def find_spec(cls, fullname, path=None, target=None):
        if fullname in MAPPING:
            return importlib.util.spec_from_file_location(fullname, MAPPING[fullname] + '/__init__.py')
def install():
    sys.meta_path.append(Finder)
"#, root.join("src/shared").to_str().unwrap())).unwrap();
        } else {
            fs::write(
                site.join("shared.pth"),
                format!("{}\n", root.join("src").display()),
            )
            .unwrap();
        }
        // This checker imports the editable package with the actual venv
        // interpreter, so head leakage changes the diagnostic set and fails.
        let checker = root.join(".venv/bin/mypy");
        fs::write(&checker, format!(r#"#!{}/.venv/bin/python
import sys, json
if '--version' in sys.argv:
    print('mypy 1.14.1'); sys.exit(0)
import shared
def error(file, message):
    print(json.dumps(dict(file=file, line=2, column=0, end_line=2, end_column=10, message=message, code='assignment', severity='error')))
error('existing.py', 'pre-existing error')
if isinstance(shared.value, str):
    error('caller.py', 'dependency changed to string')
sys.exit(1)
"#, root.display())).unwrap();
        fs::set_permissions(&checker, fs::Permissions::from_mode(0o755)).unwrap();
        let profile = profile(root, "60s", true);
        git(root, &["add", "."]);
        git(root, &["commit", "-m", "base editable"]);
        fs::write(root.join("src/shared/__init__.py"), "value = 'new'\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-m", "change editable API"]);
        let original = fs::read(site.join("shared.pth")).unwrap();
        let mut input = request(root, profile);
        input.changes = select(
            &GixRepo::discover(root).unwrap(),
            Selection::Branch {
                reference: "HEAD~1".into(),
            },
        )
        .unwrap();
        let report = review(
            input,
            ProcessSupervisor::default(),
            CancellationToken::new(),
            None,
        )
        .await
        .unwrap();
        assert!(
            report
                .findings
                .iter()
                .any(|f| f.location.path == "caller.py" && f.state == State::New),
            "{report:#?}"
        );
        assert!(
            report
                .findings
                .iter()
                .any(|f| f.location.path == "existing.py" && f.state == State::PreExisting),
            "{report:#?}"
        );
        assert!(
            report.checks.iter().any(|c| c.version == Version::Base
                && c.outcome
                    .details()
                    .hint
                    .as_ref()
                    .is_some_and(|hint| hint.contains("linked packages remapped to base"))),
            "{report:#?}"
        );
        assert_eq!(fs::read(site.join("shared.pth")).unwrap(), original);
    }
}

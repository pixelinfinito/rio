use rio_engine::{SubmissionOptions, build_submission, review_owner_guidance};
use rio_git::{ChangeSet, Diff, Selection, Tree, TreeEntry};
use rio_profile::ProfileLoader;
use std::time::Duration;

fn tree() -> Tree {
    [
        ("REVIEW.md", "Keep entered data on retry."),
        ("checkout/REVIEW.md", "Allow guest checkout."),
        ("admin/REVIEW.md", "Admin requires sign-in."),
    ]
    .into_iter()
    .map(|(path, text)| {
        (
            path.into(),
            TreeEntry {
                object_id: String::new(),
                content: text.as_bytes().to_vec(),
                mode: 0o100644,
            },
        )
    })
    .collect()
}
#[test]
fn qa_preparation_captures_unchanged_guidance_for_later_route_scoping() {
    let mut head = tree();
    head.insert(
        "symlink/REVIEW.md".into(),
        TreeEntry {
            object_id: String::new(),
            content: b"../secret".to_vec(),
            mode: 0o120000,
        },
    );
    let catalog =
        serde_json::to_value(review_owner_guidance(&head, &Diff::default(), true)).unwrap();
    assert_eq!(catalog.as_array().unwrap().len(), 3);
    assert_eq!(catalog[1]["path"], "admin/REVIEW.md");
    assert!(review_owner_guidance(&head, &Diff::default(), false).is_empty());
    head.get_mut("REVIEW.md").unwrap().content = b"Changed working copy".to_vec();
    assert_eq!(catalog[0]["lines"][0], "Keep entered data on retry.");
}
#[test]
fn enabled_qa_can_prepare_an_empty_diff_without_changing_base_profile_behavior() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let loader = ProfileLoader::new(Some(root.into()), root.join("config"), root.into());
    let changes = ChangeSet {
        base: tree(),
        head: tree(),
        base_id: "base".into(),
        head_id: "head".into(),
        selection: Selection::WorkingTree,
    };
    let options = SubmissionOptions {
        graph_budget: Duration::from_secs(5),
        deep: false,
        fork: false,
        nightly: false,
        repository: None,
        run_id: "qa-empty-diff".into(),
    };
    let qa = loader.load(Some("rio/qa")).unwrap();
    let submission = build_submission(&changes, &qa, &options).unwrap().unwrap();
    assert_eq!(submission.guidance.len(), 3);
    assert_eq!(submission.submission["changed"], serde_json::json!([]));
    let base = loader.load(Some("rio/base")).unwrap();
    assert!(
        build_submission(&changes, &base, &options)
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn offline_qa_is_deferred_without_starting_a_model_or_app() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    assert!(
        std::process::Command::new("git")
            .args(["init", "--quiet"])
            .arg(root)
            .status()
            .unwrap()
            .success()
    );
    let profile = ProfileLoader::new(Some(root.into()), root.join("config"), root.into())
        .load(Some("rio/qa"))
        .unwrap();
    let request = rio_engine::ReviewRequest {
        worktree: root.into(),
        working: tree(),
        changes: ChangeSet {
            base: tree(),
            head: tree(),
            base_id: "base".into(),
            head_id: "head".into(),
            selection: Selection::WorkingTree,
        },
        profile,
        cache: rio_engine::CacheOptions::for_repository(root),
        parallelism: 1,
        output_limit: 1024 * 1024,
        offline: true,
    };
    let report = rio_engine::review(
        request,
        rio_adapters::ProcessSupervisor::default(),
        tokio_util::sync::CancellationToken::new(),
        None,
    )
    .await
    .unwrap();
    assert!(
        report
            .deferred
            .iter()
            .any(|step| step.step == "qa" && step.reason == rio_core::DeferredReason::NoEndpoint)
    );
    let rendered = rio_core::render_json(&report).unwrap();
    assert!(String::from_utf8(rendered).unwrap().contains("no_endpoint"));
}

use std::{fs, path::Path, time::Duration};

use rio_profile::{ProfileLoader, QA_VERIFICATION_RESERVE};
use serde_json::{Value, json};

fn loader(root: &Path) -> ProfileLoader {
    ProfileLoader::new(Some(root.into()), root.join("config"), root.into())
}
fn source() -> Value {
    serde_yaml::from_str(include_str!("../../../modules/profiles/qa.yaml")).unwrap()
}
fn write(root: &Path, source: &Value) {
    fs::write(
        root.join("profile.yaml"),
        serde_yaml::to_string(source).unwrap(),
    )
    .unwrap();
}

#[test]
fn qa_defaults_and_deadlines_are_resolved_for_both_modes() {
    let root = tempfile::tempdir().unwrap();
    let qa = loader(root.path()).load(Some("rio/qa")).unwrap();
    assert!(qa.profile.qa_enabled());
    assert_eq!(qa.profile.budget.fast.tokens, Some(500_000));
    assert_eq!(qa.profile.budget.fast.verify_tokens, Some(60_000));
    assert_eq!(
        qa.profile.budget.deep.as_ref().unwrap().tokens,
        Some(1_000_000)
    );
    assert_eq!(
        qa.profile.budget.deep.as_ref().unwrap().verify_tokens,
        Some(120_000)
    );
    let fast = qa.profile.budget.fast.qa.as_ref().unwrap();
    assert_eq!(fast.wall, "30m");
    assert_eq!(fast.cell_wall, "8m");
    assert_eq!(fast.tokens, 150_000);
    assert_eq!(fast.evidence_bytes, 512 * 1024 * 1024);
    assert_eq!(fast.replay_wall, "5m");
    let deep = qa
        .profile
        .budget
        .deep
        .as_ref()
        .unwrap()
        .qa
        .as_ref()
        .unwrap();
    assert_eq!(deep.wall, "90m");
    assert_eq!(deep.cell_wall, "15m");
    assert_eq!(deep.tokens, 300_000);
    assert_eq!(deep.evidence_bytes, 1024 * 1024 * 1024);
    assert_eq!(deep.replay_wall, "10m");
    assert_eq!(
        qa.profile
            .review_wall(false, QA_VERIFICATION_RESERVE)
            .unwrap(),
        Duration::from_secs(39 * 60)
    );
    let deadline = &qa.qa_deadlines.as_ref().unwrap()["fast"];
    assert_eq!(deadline.review_wall_ms, 4 * 60_000);
    assert_eq!(deadline.qa_wall_ms, 30 * 60_000);
    assert_eq!(deadline.verification_reserve_ms, 5 * 60_000);
    assert_eq!(deadline.total_ms, 39 * 60_000);
    assert_eq!(
        qa.profile.step("rio/qa").unwrap().options["max_recommendations"],
        5
    );
    assert!(
        qa.profile
            .step("rio/verify")
            .unwrap()
            .needs
            .contains(&"qa".to_string())
    );
    assert!(
        qa.profile
            .step("rio/report")
            .unwrap()
            .needs
            .contains(&"qa".to_string())
    );
    let base = loader(root.path()).load(Some("rio/base")).unwrap();
    assert!(!base.profile.qa_enabled());
    assert_eq!(base.profile.budget.fast.tokens, Some(2_400_000));
    assert!(base.qa_deadlines.is_none());
    assert_eq!(
        base.profile
            .review_wall(false, QA_VERIFICATION_RESERVE)
            .unwrap(),
        Duration::from_secs(10 * 60)
    );
}

#[test]
fn partial_qa_budgets_keep_mode_defaults_and_independent_caps() {
    let root = tempfile::tempdir().unwrap();
    let mut profile = source();
    profile["budget"]["deep"] = json!({"qa":{"tokens":1234}});
    profile["max_defects"] = json!(3);
    let qa = profile["steps"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|s| s["id"] == "qa")
        .unwrap();
    qa["with"]["max_defects"] = json!(10);
    qa["with"]["max_recommendations"] = json!(0);
    write(root.path(), &profile);
    let profile = loader(root.path()).load(Some("profile.yaml")).unwrap();
    assert_eq!(profile.profile.max_defects, 3);
    assert_eq!(
        profile.profile.step("rio/qa").unwrap().options["max_defects"],
        10
    );
    assert_eq!(
        profile.profile.step("rio/qa").unwrap().options["max_recommendations"],
        0
    );
    let qa = profile.profile.budget.deep.unwrap().qa.unwrap();
    assert_eq!(qa.tokens, 1234);
    assert_eq!(qa.wall, "90m");
    assert_eq!(qa.replay_wall, "10m");
}

#[test]
fn invalid_qa_options_and_unknown_budget_fields_are_rejected() {
    let root = tempfile::tempdir().unwrap();
    for (key, value) in [
        ("harness", json!("claude")),
        ("viewports", json!(["desktop", "wide"])),
        ("max_recommendations", json!(-1)),
    ] {
        let mut profile = source();
        let qa = profile["steps"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|s| s["id"] == "qa")
            .unwrap();
        qa["with"][key] = value;
        write(root.path(), &profile);
        assert!(
            loader(root.path()).load(Some("profile.yaml")).is_err(),
            "{key}"
        );
    }
    for (key, value) in [
        ("journeys", json!(3)),
        ("tokens", json!(0)),
        ("wall", json!("0m")),
        ("evidence_bytes", json!(-1)),
    ] {
        let mut profile = source();
        profile["budget"]["fast"]["qa"] = json!({key:value});
        write(root.path(), &profile);
        assert!(
            loader(root.path()).load(Some("profile.yaml")).is_err(),
            "{key}"
        );
    }
}

#[test]
fn enabled_qa_requires_a_dependent_verifier() {
    let root = tempfile::tempdir().unwrap();
    let mut profile = source();
    for step in profile["steps"].as_array_mut().unwrap() {
        if step["id"] == "verify" {
            step["needs"] = json!(["agents", "security"]);
        }
    }
    write(root.path(), &profile);
    let error = loader(root.path()).load(Some("profile.yaml")).unwrap_err();
    assert!(error.to_string().contains("verifier step is mandatory"));
}

#[test]
fn qa_verifier_spending_can_be_explicitly_overridden_without_changing_cell_allowances() {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        &json!({"version":1,"name":"project/qa","extends":"rio/qa",
        "budget":{"fast":{"tokens":90000,"verify_tokens":12000},
            "deep":{"tokens":180000,"verify_tokens":24000}}}),
    );
    let profile = loader(root.path())
        .load(Some("profile.yaml"))
        .unwrap()
        .profile;
    assert_eq!(profile.budget.fast.tokens, Some(90_000));
    assert_eq!(profile.budget.fast.verify_tokens, Some(12_000));
    assert_eq!(profile.budget.fast.qa.as_ref().unwrap().tokens, 150_000);
    let deep = profile.budget.deep.unwrap();
    assert_eq!(deep.tokens, Some(180_000));
    assert_eq!(deep.verify_tokens, Some(24_000));
    assert_eq!(deep.qa.unwrap().tokens, 300_000);
}

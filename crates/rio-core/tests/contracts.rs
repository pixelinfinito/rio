use std::{fs, path::Path};

use serde_json::{Value, json};

fn schema(name: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../schemas/{name}-v1.json"));
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn example_findings_and_reports_validate() {
    let finding_validator = jsonschema::validator_for(&schema("finding")).unwrap();
    let report_validator = jsonschema::validator_for(&schema("report")).unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    for entry in fs::read_dir(root).unwrap() {
        let path = entry.unwrap().path();
        let value: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let validator = if path.file_name().unwrap() == "finding.json" {
            &finding_validator
        } else {
            &report_validator
        };
        let errors: Vec<_> = validator
            .iter_errors(&value)
            .map(|e| e.to_string())
            .collect();
        assert!(errors.is_empty(), "{}: {errors:?}", path.display());
    }
}

#[test]
fn malformed_reports_and_dependency_findings_are_rejected() {
    let validator = jsonschema::validator_for(&schema("report")).unwrap();
    let mut report: Value = serde_json::from_str(include_str!("fixtures/error.json")).unwrap();
    report.as_object_mut().unwrap().remove("error");
    assert!(!validator.is_valid(&report));
    report = serde_json::from_str(include_str!("fixtures/complete.json")).unwrap();
    report["error"] = json!({"code": "unexpected", "message": "wrong status", "details": []});
    assert!(!validator.is_valid(&report));
    let validator = jsonschema::validator_for(&schema("finding")).unwrap();
    let mut finding: Value = serde_json::from_str(include_str!("fixtures/finding.json")).unwrap();
    finding["rule_id"] = json!("dependency/vulnerable_dependency");
    assert!(!validator.is_valid(&finding));
    finding["advisory"] = json!({"id": "GHSA-example", "aliases": [], "severity": "unknown",
        "fixed_version": "unknown", "url": "https://osv.dev/vulnerability/GHSA-example"});
    assert!(validator.is_valid(&finding));
    finding["confidence"] = json!(0.95);
    assert!(!validator.is_valid(&finding));
}

#[test]
fn typed_finding_and_check_round_trip_against_the_schemas() {
    let value: Value = serde_json::from_str(include_str!("fixtures/finding.json")).unwrap();
    let finding: rio_core::Finding = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(&finding).unwrap(), value);
    assert_eq!(finding.state, rio_core::State::Worsened);
    assert!(rio_core::EvidenceLevel::Reproduced > rio_core::EvidenceLevel::StaticProven);
    assert!(rio_core::EvidenceLevel::StaticProven > rio_core::EvidenceLevel::Plausible);
    assert!(rio_core::EvidenceLevel::Plausible > rio_core::EvidenceLevel::Refuted);

    let schema = schema("report");
    let check_schema = json!({"$ref": "#/$defs/check", "$defs": schema["$defs"]});
    let validator = jsonschema::validator_for(&check_schema).unwrap();
    for fixture in [
        include_str!("fixtures/complete.json"),
        include_str!("fixtures/partial.json"),
    ] {
        let report: Value = serde_json::from_str(fixture).unwrap();
        let check: rio_core::CheckEntry =
            serde_json::from_value(report["checks"][0].clone()).unwrap();
        let serialized = serde_json::to_value(&check).unwrap();
        assert_eq!(serialized, report["checks"][0]);
        assert!(validator.is_valid(&serialized));
        assert!(!check.outcome.details().findings.is_empty());
    }
}

#[test]
fn reports_and_events_round_trip() {
    use rio_core::{Report, ReviewEvent};
    let validator = jsonschema::validator_for(&schema("report")).unwrap();
    for fixture in [
        include_str!("fixtures/complete.json"),
        include_str!("fixtures/incomplete.json"),
        include_str!("fixtures/partial.json"),
        include_str!("fixtures/no_changes.json"),
        include_str!("fixtures/error.json"),
    ] {
        let value: Value = serde_json::from_str(fixture).unwrap();
        let report: Report = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(&report).unwrap(), value);
        assert!(validator.is_valid(&serde_json::to_value(&report).unwrap()));
        let event = ReviewEvent::Done {
            report: Box::new(report),
        };
        let serialized = serde_json::to_value(&event).unwrap();
        assert_eq!(serialized["event"], "review:done");
        assert_eq!(
            serde_json::from_value::<ReviewEvent>(serialized).unwrap(),
            event
        );
    }
}

#[test]
fn reserved_finding_feedback_is_optional_and_validated_in_reports_too() {
    let finding_schema = schema("finding");
    let validator = jsonschema::validator_for(&finding_schema).unwrap();
    let report_validator = jsonschema::validator_for(&schema("report")).unwrap();
    let mut finding: Value = serde_json::from_str(include_str!("fixtures/finding.json")).unwrap();
    assert!(validator.is_valid(&finding));
    finding["round"] = json!(2);
    finding["first_posted_in"] = json!("3f2a");
    for reason in ["fixed", "wrong", "intentional", "irrelevant", "style"] {
        finding["author_response"] =
            json!({"reason": reason, "actor": "octocat", "at": "2026-11-05T10:00:00Z"});
        assert!(validator.is_valid(&finding));
        let mut report: Value =
            serde_json::from_str(include_str!("fixtures/complete.json")).unwrap();
        report["findings"] = json!([finding.clone()]);
        assert!(report_validator.is_valid(&report));
    }
    for (key, invalid) in [
        ("round", json!(0)),
        ("first_posted_in", json!(false)),
        (
            "author_response",
            json!({"reason":"known","actor":"octocat","at":"2026-11-05T10:00:00Z"}),
        ),
    ] {
        let mut invalid_finding = finding.clone();
        invalid_finding[key] = invalid;
        assert!(!validator.is_valid(&invalid_finding), "{key}");
        let mut report: Value =
            serde_json::from_str(include_str!("fixtures/complete.json")).unwrap();
        report["findings"] = json!([invalid_finding]);
        assert!(!report_validator.is_valid(&report), "embedded {key}");
    }
}

#[test]
fn report_risk_tier_is_nullable_and_has_a_strict_contract() {
    let validator = jsonschema::validator_for(&schema("report")).unwrap();
    let mut report: Value = serde_json::from_str(include_str!("fixtures/complete.json")).unwrap();
    assert!(validator.is_valid(&report));
    for tier in ["low", "medium", "high"] {
        for source in ["always_human", "triage"] {
            report["risk_tier"] =
                json!({"tier":tier,"reasons":["always_human: scripts/**"],"source":source});
            assert!(validator.is_valid(&report));
            let typed: rio_core::Report = serde_json::from_value(report.clone()).unwrap();
            assert_eq!(serde_json::to_value(typed).unwrap(), report);
        }
    }
    for invalid in [
        json!({"tier":"critical","reasons":[],"source":"triage"}),
        json!({"tier":"high","source":"always_human"}),
        json!({"tier":"high","reasons":[],"source":"approval"}),
    ] {
        report["risk_tier"] = invalid;
        assert!(!validator.is_valid(&report));
    }
}

#[test]
fn verification_and_security_are_optional_but_counts_are_checked() {
    let original: Value = serde_json::from_str(include_str!("fixtures/finding.json")).unwrap();
    let mut value = original.clone();
    value["category"] = json!("security");
    value["verification"] =
        json!({"voters":3,"agreeing":2,"blind_match":["same","related","none"],"split":true});
    let finding: rio_core::Finding = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(finding).unwrap(), value);
    assert!(
        jsonschema::validator_for(&schema("finding"))
            .unwrap()
            .is_valid(&value)
    );
    for invalid in [
        json!({"voters":0,"agreeing":0,"blind_match":[],"split":false}),
        json!({"voters":1,"agreeing":2,"blind_match":["same"],"split":false}),
        json!({"voters":2,"agreeing":1,"blind_match":["none"],"split":false}),
        json!({"voters":1,"agreeing":1,"blind_match":["unknown"],"split":false}),
    ] {
        value["verification"] = invalid;
        assert!(serde_json::from_value::<rio_core::Finding>(value.clone()).is_err());
    }
    let report: rio_core::Report =
        serde_json::from_str(include_str!("fixtures/complete.json")).unwrap();
    assert!(
        serde_json::to_value(report)
            .unwrap()
            .get("security")
            .is_none()
    );
}

fn lineage_finding() -> Value {
    let mut finding: Value = serde_json::from_str(include_str!("fixtures/finding.json")).unwrap();
    finding["state"] = json!("new");
    finding["round"] = json!(2);
    finding["first_posted_in"] = json!("3f2a");
    finding["status"] = json!("dismissed");
    finding["resolution"] = json!({"note": "did not reproduce"});
    finding["author_response"] = json!({"reason": "wrong", "actor": "octocat",
        "at": "2026-11-05T10:00:00Z", "note": "guarded upstream"});
    finding
}

fn lineage() -> Value {
    json!({"repository":"github.com/pixelinfinito/rio","kind":"branch","ref":"feature/x",
        "generation":1,"round":4,"cap":3,"capped":true,"diff_only":true,
        "previous_head":"snap-3","held_back":2,"rounds_to_pass":null,
        "author_response_ratio":0.6,
        "reconsider":{"unresolved":2,"top":[{"id":"a1","title":"Missing guard",
            "path":"src/a.ts","line_start":3}],"split":["parser","renderer"]}})
}

#[test]
fn lineage_finding_fields_round_trip_typed_and_validate_with_or_without_them() {
    let finding_validator = jsonschema::validator_for(&schema("finding")).unwrap();
    let report_validator = jsonschema::validator_for(&schema("report")).unwrap();
    let plain: Value = serde_json::from_str(include_str!("fixtures/finding.json")).unwrap();
    let typed: rio_core::Finding = serde_json::from_value(plain.clone()).unwrap();
    assert!(typed.round.is_none() && typed.status.is_none() && typed.author_response.is_none());
    // Absent lineage fields are not serialized.
    assert_eq!(serde_json::to_value(&typed).unwrap(), plain);

    let value = lineage_finding();
    assert!(finding_validator.is_valid(&value));
    let typed: rio_core::Finding = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(typed.state, rio_core::State::New);
    assert_eq!(typed.status, Some(rio_core::LifecycleStatus::Dismissed));
    assert_eq!(
        typed.author_response.as_ref().unwrap().reason,
        rio_core::ResponseReason::Wrong
    );
    assert_eq!(serde_json::to_value(&typed).unwrap(), value);
    for status in ["open", "fixed", "dismissed"] {
        let mut value = value.clone();
        value["status"] = json!(status);
        assert!(finding_validator.is_valid(&value));
        assert!(serde_json::from_value::<rio_core::Finding>(value).is_ok());
    }
    let mut report: Value = serde_json::from_str(include_str!("fixtures/complete.json")).unwrap();
    report["findings"] = json!([value.clone()]);
    report["lineage"] = lineage();
    assert!(report_validator.is_valid(&report));
    let typed: rio_core::Report = serde_json::from_value(report.clone()).unwrap();
    assert_eq!(serde_json::to_value(&typed).unwrap(), report);
    assert!(rio_core::render_json(&typed).is_ok());
}

#[test]
fn lifecycle_values_cannot_leak_into_state_and_unknown_reasons_are_rejected() {
    let finding_validator = jsonschema::validator_for(&schema("finding")).unwrap();
    let report_validator = jsonschema::validator_for(&schema("report")).unwrap();
    let mut invalid = Vec::new();
    let mut value = lineage_finding();
    value["state"] = json!("dismissed");
    invalid.push(value);
    for reason in ["known", "false_positive"] {
        let mut value = lineage_finding();
        value["author_response"]["reason"] = json!(reason);
        invalid.push(value);
    }
    let mut value = lineage_finding();
    value["status"] = json!("resolved");
    invalid.push(value);
    let mut value = lineage_finding();
    value["resolution"] = json!({"fixed_in": "abc", "by": "bot"});
    invalid.push(value);
    for value in invalid {
        assert!(!finding_validator.is_valid(&value), "{value}");
        assert!(
            serde_json::from_value::<rio_core::Finding>(value.clone()).is_err(),
            "{value}"
        );
        let mut report: Value =
            serde_json::from_str(include_str!("fixtures/complete.json")).unwrap();
        report["findings"] = json!([value]);
        assert!(!report_validator.is_valid(&report));
    }
    for (key, bad) in [
        ("author_response_ratio", json!(1.5)),
        ("kind", json!("tag")),
        ("round", json!(0)),
    ] {
        let mut report: Value =
            serde_json::from_str(include_str!("fixtures/complete.json")).unwrap();
        report["lineage"] = lineage();
        report["lineage"][key] = bad;
        assert!(!report_validator.is_valid(&report), "{key}");
    }
    let mut report: Value = serde_json::from_str(include_str!("fixtures/complete.json")).unwrap();
    report["lineage"] = lineage();
    report["lineage"]["author_response_ratio"] = json!(1.5);
    assert!(serde_json::from_value::<rio_core::Report>(report).is_err());
}

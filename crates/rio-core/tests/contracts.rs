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

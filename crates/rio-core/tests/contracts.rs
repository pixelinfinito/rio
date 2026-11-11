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

fn history() -> Value {
    json!({"first_seen": "rev-1", "last_seen": "rev-2", "seen_count": 2,
        "previous_status": "dismissed", "dismissed_in": "github.com/o/r#41",
        "previous_response": {"reason": "wrong", "actor": "octocat", "at": "2026-11-05T10:00:00Z"}})
}

fn v03_objects() -> [(&'static str, Value); 4] {
    [
        (
            "publication",
            json!({"policy": "auto", "posted": 4, "edited": 1, "resolved": 0, "failed": 0,
                "unanchored": 1, "check_run_url": "https://github.com/o/r/runs/1",
                "summary_comment_url": null}),
        ),
        (
            "cache",
            json!({"lookups": 4, "hits": 2, "hit_rate": 0.5, "tokens_saved_estimate": 1200}),
        ),
        (
            "suppression_proposals",
            json!([{"id": "p1", "entry": {"rule": "lint/eslint/no-console"}, "evidence_count": 3,
                "since": "2026-10-01T00:00:00Z"},
                {"id": "p2", "entry": {"path": "src/generated/**"}, "evidence_count": 4,
                "since": "2026-10-02T00:00:00Z"}]),
        ),
        (
            "security_coverage",
            json!({"catalog": "asvs-5.0",
                "assessed": [{"item": "V1.2", "title": "Injection Prevention", "findings": []}],
                "unassessed": [{"item": "V8.3", "title": "Operation Level Authorization",
                    "reason": "budget"}],
                "not_applicable": [{"item": "V17.1", "title": "TURN Server"}]}),
        ),
    ]
}

#[test]
fn v03_finding_and_report_keys_are_optional_typed_and_validated() {
    let finding_validator = jsonschema::validator_for(&schema("finding")).unwrap();
    let report_validator = jsonschema::validator_for(&schema("report")).unwrap();
    let mut finding = lineage_finding();
    finding["source"] = json!({"agent": "security", "cached": true});
    finding["history"] = history();
    assert!(finding_validator.is_valid(&finding));
    let typed: rio_core::Finding = serde_json::from_value(finding.clone()).unwrap();
    assert_eq!(
        typed.history.as_ref().unwrap().previous_status,
        rio_core::LifecycleStatus::Dismissed
    );
    assert_eq!(serde_json::to_value(&typed).unwrap(), finding);
    // Without the new keys the documents are unchanged and still valid.
    let plain: Value = serde_json::from_str(include_str!("fixtures/finding.json")).unwrap();
    let typed: rio_core::Finding = serde_json::from_value(plain.clone()).unwrap();
    assert!(typed.history.is_none());
    assert_eq!(serde_json::to_value(&typed).unwrap(), plain);

    let plain: Value = serde_json::from_str(include_str!("fixtures/complete.json")).unwrap();
    assert!(report_validator.is_valid(&plain));
    let mut report = plain.clone();
    report["findings"] = json!([finding]);
    for (key, value) in v03_objects() {
        report[key] = value;
    }
    let errors: Vec<_> = report_validator
        .iter_errors(&report)
        .map(|e| e.to_string())
        .collect();
    assert!(errors.is_empty(), "{errors:?}");
    let typed: rio_core::Report = serde_json::from_value(report.clone()).unwrap();
    assert_eq!(serde_json::to_value(&typed).unwrap(), report);
    assert!(rio_core::render_json(&typed).is_ok());
    let typed: rio_core::Report = serde_json::from_value(plain.clone()).unwrap();
    assert!(typed.publication.is_none() && typed.security_coverage.is_none());
    assert_eq!(serde_json::to_value(&typed).unwrap(), plain);
}

#[test]
fn v03_history_reasons_and_report_objects_are_strict() {
    let finding_validator = jsonschema::validator_for(&schema("finding")).unwrap();
    let report_validator = jsonschema::validator_for(&schema("report")).unwrap();
    let mut invalid = Vec::new();
    for reason in ["known", "false_positive", "duplicate"] {
        let mut finding = lineage_finding();
        finding["history"] = history();
        finding["history"]["previous_response"]["reason"] = json!(reason);
        invalid.push(finding);
    }
    let mut finding = lineage_finding();
    finding["history"] = history();
    finding["history"]["seen_count"] = json!(0);
    invalid.push(finding);
    let mut finding = lineage_finding();
    finding["history"] = history();
    finding["history"]["previous_status"] = json!("resolved");
    invalid.push(finding);
    let mut finding = lineage_finding();
    finding["source"] = json!({"tool": "tsc", "version": "5", "cached": true});
    invalid.push(finding);
    for value in invalid {
        assert!(!finding_validator.is_valid(&value), "{value}");
        let mut report: Value =
            serde_json::from_str(include_str!("fixtures/complete.json")).unwrap();
        report["findings"] = json!([value]);
        assert!(!report_validator.is_valid(&report));
    }
    let mut finding = lineage_finding();
    finding["history"] = history();
    finding["history"]["previous_response"]["reason"] = json!("known");
    assert!(serde_json::from_value::<rio_core::Finding>(finding).is_err());
    // The typed model rejects every enum and shape error; counts are bounded by the schema.
    for (key, pointer, bad, typed) in [
        ("publication", "/policy", json!("always"), true),
        ("cache", "/hit_rate", json!(1.5), true),
        (
            "suppression_proposals",
            "/0/entry",
            json!({"finding": "abc"}),
            true,
        ),
        (
            "suppression_proposals",
            "/0/evidence_count",
            json!(0),
            false,
        ),
        ("security_coverage", "/catalog", json!("internal"), true),
        (
            "security_coverage",
            "/unassessed/0/reason",
            json!("skipped"),
            true,
        ),
    ] {
        let mut report: Value =
            serde_json::from_str(include_str!("fixtures/complete.json")).unwrap();
        let (_, mut value) = v03_objects().into_iter().find(|(k, _)| *k == key).unwrap();
        *value.pointer_mut(pointer).unwrap() = bad;
        report[key] = value;
        assert!(!report_validator.is_valid(&report), "{key}{pointer}");
        assert_eq!(
            serde_json::from_value::<rio_core::Report>(report).is_err(),
            typed,
            "{key}{pointer}"
        );
    }
}

#[test]
fn stage3_history_fixed_in_and_remembered_list_are_optional_and_strict() {
    let finding_validator = jsonschema::validator_for(&schema("finding")).unwrap();
    let report_validator = jsonschema::validator_for(&schema("report")).unwrap();
    let mut regression = lineage_finding();
    regression["history"] = json!({"first_seen": "rev-1", "last_seen": "rev-1", "seen_count": 1,
        "previous_status": "fixed", "fixed_in": "rev-2"});
    assert!(finding_validator.is_valid(&regression));
    let typed: rio_core::Finding = serde_json::from_value(regression.clone()).unwrap();
    assert_eq!(
        typed.history.as_ref().unwrap().fixed_in.as_deref(),
        Some("rev-2")
    );
    assert_eq!(serde_json::to_value(&typed).unwrap(), regression);
    let mut remembered = lineage_finding();
    remembered["history"] = history();
    remembered["history"]["previous_response"]["reason"] = json!("intentional");
    let plain: Value = serde_json::from_str(include_str!("fixtures/complete.json")).unwrap();
    let mut report = plain.clone();
    report["findings"] = json!([regression]);
    report["remembered"] = json!([remembered]);
    let errors: Vec<_> = report_validator
        .iter_errors(&report)
        .map(|e| e.to_string())
        .collect();
    assert!(errors.is_empty(), "{errors:?}");
    let typed: rio_core::Report = serde_json::from_value(report.clone()).unwrap();
    assert_eq!(typed.remembered.len(), 1);
    assert_eq!(serde_json::to_value(&typed).unwrap(), report);
    // Without the list nothing is serialized.
    let typed: rio_core::Report = serde_json::from_value(plain.clone()).unwrap();
    assert!(typed.remembered.is_empty());
    assert!(
        serde_json::to_value(&typed)
            .unwrap()
            .get("remembered")
            .is_none()
    );
    // Remembered entries are findings: an unknown history key is rejected.
    report["remembered"][0]["history"]["fixed_by"] = json!("rev-3");
    assert!(!report_validator.is_valid(&report));
    report["remembered"] = json!([{"id": "x"}]);
    assert!(!report_validator.is_valid(&report));
}

#[test]
fn council_assessment_examples_validate_and_malformed_ones_do_not() {
    let validator = jsonschema::validator_for(&schema("council-assessment")).unwrap();
    let round_one = json!({"member": "tester", "round": 1, "real": "yes",
        "introduced_by_change": "unknown", "impact": "Anonymous read of another account.",
        "basis": "static_path", "evidence_refs": ["graph-1"],
        "experiment_request": {"command": ["npm", "test", "--", "auth"], "version": "head",
            "expect": "fails"}});
    let mut round_two = round_one.clone();
    round_two
        .as_object_mut()
        .unwrap()
        .remove("experiment_request");
    round_two["round"] = json!(2);
    round_two["real"] = json!("no");
    round_two["changed_from"] = json!({"real": "yes"});
    round_two["changed_to"] = json!({"real": "no"});
    round_two["cites"] = json!({"kind": "assessment", "ref": "B",
        "reason_code": "missing_protection"});
    assert!(validator.is_valid(&round_one));
    assert!(validator.is_valid(&round_two));
    for (pointer, value) in [
        ("/evidence_refs", json!([])),
        ("/round", json!(3)),
        ("/cites/reason_code", json!("vibes")),
        ("/member", json!("judge")),
    ] {
        let mut invalid = round_two.clone();
        *invalid.pointer_mut(pointer).unwrap() = value;
        assert!(!validator.is_valid(&invalid), "{pointer}");
    }
    let mut prose = round_one.clone();
    prose["reasoning"] = json!("because");
    assert!(!validator.is_valid(&prose));
    let mut changed_in_round_one = round_two.clone();
    changed_in_round_one["round"] = json!(1);
    assert!(!validator.is_valid(&changed_in_round_one));
}

fn council_block() -> Value {
    json!({"decision": "reproduced", "tier": "experiment",
        "members": [{"role": "skeptic", "abstained": false},
            {"role": "exploit-author", "abstained": false},
            {"role": "code-owner", "abstained": false},
            {"role": "maintainer", "abstained": true, "cause": "timeout"},
            {"role": "tester", "abstained": true, "cause": "timeout"}],
        "experiments": [{"command": ["npm", "test", "--", "auth"], "version": "both",
            "expect": "fails", "run": true, "outcome": {"base": "passed", "head": "failed"},
            "artifact": "exp-1"}],
        "note": "Three members answered; an experiment failed on head and passed on base.",
        "partial": true, "answered": 3, "total": 5,
        "author_family": {"status": "not_applicable"}})
}

#[test]
fn council_block_is_optional_typed_and_never_numeric() {
    let finding_validator = jsonschema::validator_for(&schema("finding")).unwrap();
    let report_validator = jsonschema::validator_for(&schema("report")).unwrap();
    let plain: Value = serde_json::from_str(include_str!("fixtures/finding.json")).unwrap();
    assert!(finding_validator.is_valid(&plain));
    let typed: rio_core::Finding = serde_json::from_value(plain.clone()).unwrap();
    assert!(typed.council.is_none());
    assert_eq!(serde_json::to_value(&typed).unwrap(), plain);

    let mut councilled = plain.clone();
    councilled["council"] = council_block();
    assert!(finding_validator.is_valid(&councilled));
    let typed: rio_core::Finding = serde_json::from_value(councilled.clone()).unwrap();
    let council = typed.council.as_ref().unwrap();
    assert_eq!(
        council.decision,
        Some(rio_core::CouncilDecision::Reproduced)
    );
    assert_eq!(
        (council.partial, council.answered, council.total),
        (true, 3, 5)
    );
    assert_eq!(serde_json::to_value(&typed).unwrap(), councilled);

    let mut skipped = plain.clone();
    skipped["council"] = json!({"members": [{"role": "skeptic", "abstained": false}],
        "experiments": [], "partial": false, "skipped": true, "answered": 1, "total": 5});
    assert!(finding_validator.is_valid(&skipped));
    skipped["council"]["skipped"] = json!(false);
    assert!(
        !finding_validator.is_valid(&skipped),
        "a decided council needs a decision"
    );

    let mut numeric = councilled.clone();
    numeric["council"]["confidence"] = json!(0.8);
    assert!(!finding_validator.is_valid(&numeric));
    assert!(serde_json::from_value::<rio_core::Finding>(numeric).is_err());

    let mut report: Value = serde_json::from_str(include_str!("fixtures/complete.json")).unwrap();
    assert!(report_validator.is_valid(&report));
    report["risks"] = json!([councilled]);
    let cost = json!({"members": 5, "rounds": 2, "experiments": 1,
        "tokens": {"openai": 12000, "anthropic": 9000}, "runner_seconds": 14});
    report["council"] = json!({"councilled": 1, "not_councilled": 2, "total": cost,
        "findings": [{"id": councilled["id"], "status": "partial", "answered": 3, "total": 5,
            "cost": cost}]});
    let errors: Vec<_> = report_validator
        .iter_errors(&report)
        .map(|e| e.to_string())
        .collect();
    assert!(errors.is_empty(), "{errors:?}");
    let typed: rio_core::Report = serde_json::from_value(report.clone()).unwrap();
    assert_eq!(typed.council.as_ref().unwrap().not_councilled, 2);
    report["council"]["total"]["confidence"] = json!(1);
    assert!(!report_validator.is_valid(&report));
}

#[test]
fn machine_applicable_fix_is_optional_typed_and_strict() {
    let finding_validator = jsonschema::validator_for(&schema("finding")).unwrap();
    let report_validator = jsonschema::validator_for(&schema("report")).unwrap();
    let plain: Value = serde_json::from_str(include_str!("fixtures/finding.json")).unwrap();
    assert!(
        finding_validator.is_valid(&plain),
        "historical findings carry no fix"
    );
    let typed: rio_core::Finding = serde_json::from_value(plain.clone()).unwrap();
    assert!(typed.fix.is_none());

    let mut fixed = plain.clone();
    fixed["fix"] = json!({"line_start": 42, "line_end": 42,
        "replacement": "  const [type, params] = (ctype ?? DEFAULT_CTYPE).split(';')"});
    assert!(finding_validator.is_valid(&fixed));
    let typed: rio_core::Finding = serde_json::from_value(fixed.clone()).unwrap();
    assert!(typed.fix.as_ref().unwrap().is_valid());
    assert_eq!(serde_json::to_value(&typed).unwrap(), fixed);

    let mut report: Value = serde_json::from_str(include_str!("fixtures/complete.json")).unwrap();
    report["findings"] = json!([fixed]);
    assert!(report_validator.is_valid(&report));

    for bad in [
        json!({"line_start": 0, "line_end": 1, "replacement": ""}),
        json!({"line_start": 1, "replacement": ""}),
        json!({"line_start": 1, "line_end": 1, "replacement": "", "path": "x"}),
    ] {
        let mut malformed = plain.clone();
        malformed["fix"] = bad;
        assert!(!finding_validator.is_valid(&malformed));
    }
    // The schema cannot order two fields; the verifier drops inverted ranges.
    let inverted: rio_core::Fix =
        serde_json::from_value(json!({"line_start": 50, "line_end": 42, "replacement": ""}))
            .unwrap();
    assert!(!inverted.is_valid());

    assert_eq!(
        schema("hypothesis")["properties"]["fix"],
        schema("finding")["properties"]["fix"],
        "agents emit the same fix shape the finding carries"
    );
}

#[test]
fn council_member_detail_and_security_trace_are_optional_typed_and_strict() {
    let finding_validator = jsonschema::validator_for(&schema("finding")).unwrap();
    let plain: Value = serde_json::from_str(include_str!("fixtures/finding.json")).unwrap();
    let mut councilled = plain.clone();
    councilled["council"] = council_block();
    councilled["council"]["members"][0]["family"] = json!("claude");
    councilled["council"]["members"][0]["rounds"] =
        json!([{"round": 1, "real": "no"}, {"round": 2, "real": "yes", "changed": true}]);
    assert!(finding_validator.is_valid(&councilled));
    let typed: rio_core::Finding = serde_json::from_value(councilled.clone()).unwrap();
    let member = &typed.council.as_ref().unwrap().members[0];
    assert_eq!(member.family.as_deref(), Some("claude"));
    assert!(member.rounds[1].changed);
    assert_eq!(serde_json::to_value(&typed).unwrap(), councilled);

    let mut both = councilled.clone();
    both["council"]["members"][0]["rounds"] =
        json!([{"round": 1, "real": "no", "cause": "timeout"}]);
    assert!(
        !finding_validator.is_valid(&both),
        "an answer or an abstention, not both"
    );
    let mut numeric = councilled.clone();
    numeric["council"]["members"][0]["rounds"] = json!([{"round": 1, "confidence": 0.9}]);
    assert!(!finding_validator.is_valid(&numeric));

    let mut traced = plain.clone();
    traced["trace"] = json!({"catalog_item": "A01", "change": "removed", "steps": [
        {"role": "source", "path": "api/orders.ts", "line_start": 52},
        {"role": "step", "path": "api/orders.ts", "line_start": 53, "missing": true},
        {"role": "sink", "path": "api/orders.ts", "line_start": 57}]});
    assert!(finding_validator.is_valid(&traced));
    let typed: rio_core::Finding = serde_json::from_value(traced.clone()).unwrap();
    assert!(typed.trace.as_ref().unwrap().steps[1].missing);
    assert_eq!(serde_json::to_value(&typed).unwrap(), traced);
    traced["trace"]["change"] = json!("added");
    assert!(!finding_validator.is_valid(&traced));
}

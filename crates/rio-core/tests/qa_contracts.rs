use serde_json::{Value, json};

fn report() -> Value {
    serde_json::from_str(include_str!("qa-fixtures/report.json")).unwrap()
}
fn validator(schema: &str) -> jsonschema::Validator {
    jsonschema::validator_for(&serde_json::from_str::<Value>(schema).unwrap()).unwrap()
}

#[test]
fn qa_report_preserves_cell_evidence_and_separates_recommendations() {
    let report = report();
    let validator = validator(include_str!("../../../schemas/report-v1.json"));
    let errors: Vec<_> = validator
        .iter_errors(&report)
        .map(|e| e.to_string())
        .collect();
    assert!(errors.is_empty(), "{errors:?}");
    assert_eq!(
        report["findings"][0]["locations"].as_array().unwrap().len(),
        2
    );
    assert_eq!(report["qa"]["recommendations"].as_array().unwrap().len(), 1);
    insta::assert_json_snapshot!("qa_schema_contract", report["qa"]);
}

#[test]
fn ux_findings_require_qa_and_non_ux_findings_reject_it() {
    let validator = validator(include_str!("../../../schemas/finding-v1.json"));
    let mut finding = report()["findings"][0].clone();
    assert!(validator.is_valid(&finding));
    finding["category"] = json!("defect");
    assert!(!validator.is_valid(&finding));
    finding["category"] = json!("ux");
    finding.as_object_mut().unwrap().remove("qa");
    assert!(!validator.is_valid(&finding));
    for key in ["cell", "evidence"] {
        finding = report()["findings"][0].clone();
        finding["locations"][0].as_object_mut().unwrap().remove(key);
        assert!(!validator.is_valid(&finding), "missing {key}");
    }
}

#[test]
fn recommendation_schema_requires_grounding_and_cannot_impersonate_a_defect() {
    let validator = validator(include_str!("../../../schemas/report-v1.json"));
    for key in [
        "observed_friction",
        "evidence",
        "basis",
        "expected_benefit",
        "trade_offs",
        "verification_status",
    ] {
        let mut report = report();
        report["qa"]["recommendations"][0]
            .as_object_mut()
            .unwrap()
            .remove(key);
        assert!(!validator.is_valid(&report), "missing {key}");
    }
    let mut report = report();
    report["qa"]["recommendations"][0]["evidence"] = json!([]);
    assert!(!validator.is_valid(&report));
    report["qa"]["recommendations"][0]["evidence"] = json!(["screenshot"]);
    report["qa"]["recommendations"][0]["severity"] = json!("error");
    assert!(!validator.is_valid(&report));
    report["qa"]["recommendations"][0]
        .as_object_mut()
        .unwrap()
        .remove("severity");
    report["qa"]["recommendations"][0]["verification_status"] = json!("reproduced");
    assert!(!validator.is_valid(&report));
}

#[test]
fn skipped_assessment_requires_a_reason_and_assessed_requires_evidence() {
    let validator = validator(include_str!("../../../schemas/report-v1.json"));
    let mut report = report();
    report["qa"]["assessment"][0]["status"] = json!("not_assessed");
    assert!(!validator.is_valid(&report));
    report["qa"]["assessment"][0]["reason"] = json!("budget");
    assert!(validator.is_valid(&report));
    report["qa"]["assessment"][0]["status"] = json!("assessed");
    report["qa"]["assessment"][0]["evidence"] = json!([]);
    assert!(!validator.is_valid(&report));
}

#[test]
fn typed_qa_finding_keeps_optional_occurrence_fields_including_an_empty_evidence_list() {
    let mut original = report()["findings"][0].clone();
    original["locations"][0]["evidence"] = json!([]);
    let finding: rio_core::Finding = serde_json::from_value(original.clone()).unwrap();
    let roundtrip = serde_json::to_value(finding).unwrap();
    assert_eq!(roundtrip, original);
    assert!(validator(include_str!("../../../schemas/finding-v1.json")).is_valid(&roundtrip));
}

#[test]
fn real_report_round_trip_and_rendering_keep_ux_advice_and_cell_outcomes() {
    let mut document = report();
    document["qa"]["recommendations"][0]["verification_status"] = json!("unverified");
    document["qa"]["guidance"] = json!([{"path":"src/checkout/REVIEW.md","hash":"a".repeat(64),"start_line":1,"end_line":3}]);
    document["qa"]["assessment"].as_array_mut().unwrap().push(json!({"rule_id":"ux/error-recovery","journey":"checkout","cell":{"viewport":"mobile","color_scheme":"light"},"status":"not_assessed","reason":"budget","evidence":[]}));
    let report: rio_core::Report = serde_json::from_value(document.clone()).unwrap();
    let encoded: Value = serde_json::from_slice(&rio_core::render_json(&report).unwrap()).unwrap();
    assert_eq!(encoded["qa"], document["qa"]);
    let options = rio_core::RenderOptions {
        width: 180,
        ..Default::default()
    };
    for rendered in [
        rio_core::render_markdown(&report, &options),
        rio_core::render_terminal(&report, &options),
    ] {
        assert!(rendered.contains("QA results"));
        assert!(rendered.contains("UX recommendations"));
        assert!(rendered.contains("unverified; priority medium; confidence high"));
        assert!(rendered.contains("User re-enters the same address for billing"));
        assert!(rendered.contains("Shipping and billing addresses can differ"));
        assert!(rendered.contains("Expected benefit (untested)"));
        assert!(rendered.contains("not_assessed: 1"));
        assert!(rendered.contains("src/checkout/REVIEW.md"));
        assert!(rendered.contains("budget"));
        assert!(
            rendered.find("QA results").unwrap() < rendered.find("UX recommendations").unwrap()
        );
    }
    assert!(
        rio_core::render_markdown(&report, &options).contains("| mobile | light | failed | 4 |")
    );
}

#[test]
fn qa_evidence_links_render_local_hosted_and_expired_artifacts_without_unsafe_markdown() {
    let mut document = report();
    let id = document["qa"]["journeys"][0]["cells"][0]["evidence"][0]
        .as_str()
        .unwrap()
        .to_owned();
    let future = 4_102_444_800_000_u64;
    document["qa"]["evidence"]["artifacts"] = json!([{ "id":id,"kind":"screenshot", "link":"https://qa.example/evidence?expires=4102444800000&signature=abc", "expires_at":future,"link_expires_at":future }]);
    let mut value: rio_core::Report = serde_json::from_value(document).unwrap();
    assert!(rio_core::render_json(&value).is_ok());
    let options = rio_core::RenderOptions {
        width: 1000,
        ..Default::default()
    };
    assert!(
        rio_core::render_markdown(&value, &options)
            .contains("](<https://qa.example/evidence?expires=4102444800000&signature=abc>)")
    );
    assert!(
        rio_core::render_terminal(&value, &options)
            .contains("https://qa.example/evidence?expires=")
    );
    value.qa.as_mut().unwrap()["evidence"]["artifacts"][0]["expires_at"] = json!(1);
    let expired: Value = serde_json::from_slice(&rio_core::render_json(&value).unwrap()).unwrap();
    assert_eq!(expired["qa"]["evidence"]["artifacts"][0]["expired"], true);
    assert!(
        expired["qa"]["evidence"]["artifacts"][0]
            .get("link")
            .is_none()
    );
    for rendered in [
        rio_core::render_markdown(&value, &options),
        rio_core::render_terminal(&value, &options),
    ] {
        assert!(rendered.contains("expired 1970-01-01"));
        assert!(!rendered.contains("signature=abc"));
    }
    value.qa.as_mut().unwrap()["evidence"] = json!({"storage":"local","expires_at":null,"bytes":10,"artifacts":[{"id":id,"link":"/private/QA evidence/shot.png"}]});
    assert!(
        rio_core::render_markdown(&value, &options)
            .contains("](</private/QA%20evidence/shot.png>)")
    );
    assert!(rio_core::render_terminal(&value, &options).contains("/private/QA evidence/shot.png"));
    value.qa.as_mut().unwrap()["evidence"]["artifacts"][0]["link"] = json!("javascript:alert(1)");
    assert!(!rio_core::render_markdown(&value, &options).contains("](<javascript:"));
}

#[test]
fn qa_footer_keeps_audit_and_labels_unknown_cost_without_claiming_zero() {
    let mut document = report();
    document["qa"]["audit"] = json!({"notes":["QA selected checkout: guidance: REVIEW.md.", "QA evidence evidence_unsanitized: checkout (mobile/dark)."],
        "harness_auth":"gateway","egress":"host_firewall_pinned","quota_bytes":10000,"quota_reached":true});
    document["qa"]["seed"] = json!({"status":"restored","duration_ms":2100,"fingerprint":"abc123"});
    document["qa"]["cost"] = json!({"wall_time_ms":12400,"tokens":3400,"usd":null});
    let mut report: rio_core::Report = serde_json::from_value(document).unwrap();
    assert!(rio_core::render_json(&report).is_ok());
    let options = rio_core::RenderOptions {
        width: 1000,
        ..Default::default()
    };
    for rendered in [
        rio_core::render_markdown(&report, &options),
        rio_core::render_terminal(&report, &options),
    ] {
        for expected in [
            "QA selected checkout: guidance: REVIEW.md",
            "evidence_unsanitized: checkout (mobile/dark)",
            "harness: codex (gateway)",
            "egress: host_firewall_pinned",
            "seed: restored (2.1 s)",
            "fingerprint: abc123",
            "quota: 10000 bytes (reached)",
            "wall time: 12.4 s; tokens: 3400; cost: unknown",
        ] {
            assert!(
                rendered.contains(expected),
                "missing {expected}: {rendered}"
            );
        }
    }
    insta::assert_snapshot!(
        "qa_report_with_audit",
        rio_core::render_markdown(&report, &options)
    );
    report.qa.as_mut().unwrap()["audit"]["harness_auth"] = json!("subscription");
    report.qa.as_mut().unwrap()["cost"]["tokens"] = json!(null);
    assert!(rio_core::render_terminal(&report, &options).contains("unmetered (subscription)"));
}

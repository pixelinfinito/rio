use rio_qa::*;
use serde_json::{Value, json};
use std::collections::BTreeSet;

fn fixture() -> Value {
    serde_json::from_str(include_str!("../../rio-core/tests/qa-fixtures/report.json")).unwrap()
}

#[test]
fn local_report_preserves_success_and_evidence_without_promoting_recommendations() {
    let mut report = fixture();
    let recommendation = report["qa"]["recommendations"][0].clone();
    let mut second = recommendation.clone();
    second["steps"] = json!([3]);
    second["evidence"] = json!(["extra-evidence"]);
    let result = json!({"harness":"pi","tokens":"unmetered","plan":{"selected":{"checkout":["full"]}},
        "journey_outcomes":[{"journey":"checkout","cell":{"viewport":"mobile","color_scheme":"light"},
            "outcome":"passed","steps":[{"step":1},{"step":3}],"evidence":["original-evidence"],"dropped":{"generic_advice":2,"invalid_recommendation_source":3,"unknown_observation_rule":4}}],
        "qa_recommendations":[recommendation,second],"ux_assessment":report["qa"]["assessment"],
        "guidance":report["qa"]["guidance"],"hypotheses":[],"evidence":{"bytes":123,"artifacts":[{"id":"original-evidence","kind":"screenshot","link":"/private/qa/checkout.png"}]}});
    let qa = local_qa_report(&result, &json!({"mode":"full"})).unwrap();
    assert_eq!(qa["journeys"][0]["outcome"], "passed");
    assert_eq!(
        qa["evidence"]["artifacts"][0]["link"],
        "/private/qa/checkout.png"
    );
    assert_eq!(qa["journeys"][0]["cells"][0]["step_reached"], 3);
    assert_eq!(qa["recommendations"].as_array().unwrap().len(), 1);
    assert_eq!(qa["recommendations_dropped"], 5);
    assert_eq!(
        qa["recommendations"][0]["verification_status"],
        "unverified"
    );
    assert!(
        qa["recommendations"][0]["evidence"]
            .as_array()
            .unwrap()
            .contains(&json!("extra-evidence"))
    );
    assert!(qa["cost"]["tokens"].is_null());
    report["qa"] = qa;
    let validator = jsonschema::validator_for(
        &serde_json::from_str::<Value>(include_str!("../../../schemas/report-v1.json")).unwrap(),
    )
    .unwrap();
    let errors: Vec<_> = validator
        .iter_errors(&report)
        .map(|e| e.to_string())
        .collect();
    assert!(errors.is_empty(), "{errors:?}");
    let capped = local_qa_report(&result, &json!({"max_recommendations":0})).unwrap();
    assert_eq!(capped["recommendations_held_back"], 1);
    assert!(capped["recommendations"].as_array().unwrap().is_empty());
    assert_eq!(
        runtime_records(&result)["recommendations.json"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn baseline_needs_probe_assessment_not_only_a_passing_journey() {
    let finding = fixture()["findings"][0].clone();
    let mut head =
        json!({"outcome":"complete","findings":[finding],"evidence":{"artifacts":[],"bytes":12}});
    let mut base = json!({"outcome":"complete","findings":[],"journey_outcomes":[{"journey":"checkout","outcome":"passed"}]});
    compare_runtime_results(&mut head, &base, &BTreeSet::new()).unwrap();
    assert_eq!(head["findings"][0]["state"], "unclassified");
    base["probe_assessments"] = json!(finding["locations"].as_array().unwrap().iter().map(|location|
        json!({"rule_id":finding["rule_id"],"journey":finding["qa"]["journey"],"step":finding["qa"]["step"],"cell":location["cell"]})).collect::<Vec<_>>());
    compare_runtime_results(&mut head, &base, &BTreeSet::new()).unwrap();
    assert_eq!(head["findings"][0]["state"], "new");
    base["outcome"] = json!("partial");
    compare_runtime_results(&mut head, &base, &BTreeSet::new()).unwrap();
    assert_eq!(head["outcome"], "partial");
}

#[test]
fn baseline_cost_is_known_only_when_both_executions_are_metered() {
    for (base_tokens, expected) in [
        (json!(30), json!(80)),
        (Value::Null, Value::Null),
        (json!("unmetered"), Value::Null),
    ] {
        let mut head = json!({"outcome":"complete","tokens":50,"findings":[],"journey_outcomes":[],"evidence":{"artifacts":[],"bytes":0}});
        let base = json!({"outcome":"partial","tokens":base_tokens,"findings":[]});
        compare_runtime_results(&mut head, &base, &BTreeSet::new()).unwrap();
        assert_eq!(head["tokens"], expected);
        assert_eq!(
            local_qa_report(&head, &json!({})).unwrap()["cost"]["tokens"],
            expected
        );
        assert_eq!(head["baseline"]["tokens"], base_tokens);
    }
    let mut head = json!({"outcome":"complete","tokens":"unmetered","findings":[],"journey_outcomes":[],"evidence":{"artifacts":[],"bytes":0}});
    compare_runtime_results(&mut head, &json!({"outcome":"partial"}), &BTreeSet::new()).unwrap();
    assert_eq!(
        head["tokens"], "unmetered",
        "Subscription usage remains explicitly unmetered in the run record"
    );
    assert!(local_qa_report(&head, &json!({})).unwrap()["cost"]["tokens"].is_null());
}

#[test]
fn observed_candidates_keep_host_identity_and_attribution_outside_findings() {
    let mut files = QaSnapshot::new();
    files.insert(".rio/qa.yaml".into(), serde_json::to_vec(&json!({"version":1,"app":{"packaging":"static","directory":"dist","url":"http://app:4173","ready":{"path":"/","status":200}},"personas":[{"name":"shopper","description":"Shopper"}]})).unwrap());
    files.insert(".rio/qa/journeys/checkout.yaml".into(), serde_json::to_vec(&json!({"version":1,"name":"checkout","title":"Checkout","persona":"shopper","tags":["smoke"],"covers":{"paths":["src/**"],"routes":["/checkout"]},"preconditions":[],"steps":[{"do":"Pay","expect":"Confirmation"}],"success":["Order confirmed"]})).unwrap());
    files.insert("src/checkout.ts".into(), b"<button>Pay</button>".to_vec());
    let project = QaProject::load(&files).unwrap();
    let plan = project
        .plan(&files, &files, &SelectionInput::default())
        .unwrap();
    let cell = json!({"viewport":"mobile","color_scheme":"light"});
    let mut result = json!({"network_events":[{"kind":"blocked_egress","host":"api.payments.test"}],"journey_outcomes":[{"journey":"checkout","dropped":{"unknown_observation_rule":2}}],"evidence":{"artifacts":[{"id":"shot","kind":"screenshot","journey":"checkout","step":1,"cell":cell,"sanitized":true}]},
        "qa_findings":[{"rule_id":"ui/no-feedback","journey":"checkout","step":1,"route_pattern":"/checkout","cell":cell,"kind":"ux","severity":"warning",
        "trigger":{"kind":"observation","targets":[{"tag":"html","role":"document","name":""}],"expected":{"confirmation":true},"observed":{"confirmation":false}},"message":"Missing confirmation","element_paths":["button"],"evidence":["shot"],"attribution":{"annotations":[{"path":"src/checkout.ts","line":1}]}}]});
    result["evidence"]["notes"] = json!([{"reason":"unresolved_expectation","journey":"checkout",
        "journey_path":".rio/qa/journeys/checkout.yaml","step":1,"cell":cell,
        "committed_step":{"expect":"Account required"},
        "guidance_refs":[{"path":"REVIEW.md","hash":"a".repeat(64),"start_line":2,"end_line":3}],
        "conflict":"Owner guidance requires guest checkout", "observed":"An account is requested", "evidence":["shot"]}]);
    annotate_runtime_result(
        &mut result,
        &project,
        &files,
        &plan,
        &BTreeSet::from(["src/checkout.ts".into()]),
    )
    .unwrap();
    let mut before = result["evidence"]["artifacts"][0].clone();
    before["id"] = json!("before");
    before["step"] = json!(0);
    result["evidence"]["artifacts"]
        .as_array_mut()
        .unwrap()
        .push(before);
    result["qa_findings"][0]["evidence"] = json!(["before", "shot"]);
    let mut invalid = result["qa_findings"][0].clone();
    invalid["evidence"] = json!(["invented"]);
    result["qa_findings"].as_array_mut().unwrap().push(invalid);
    result["qa_findings"]
        .as_array_mut()
        .unwrap()
        .push(json!({"invalid":true}));
    annotate_runtime_result(
        &mut result,
        &project,
        &files,
        &plan,
        &BTreeSet::from(["src/checkout.ts".into()]),
    )
    .unwrap();
    assert_eq!(
        result["observation_candidates"].as_array().unwrap().len(),
        1
    );
    assert_eq!(
        result["observation_candidates"][0]["finding"]["evidence"],
        json!(["before", "shot"])
    );
    assert_eq!(
        result["candidate_drops"],
        json!({"invalid_candidate":1,"missing_or_invalid_evidence":1})
    );
    let notes = result["audit_notes"].to_string();
    assert!(notes.contains("missing_or_invalid_evidence: 1"));
    assert!(notes.contains("QA selected checkout:"));
    assert!(notes.contains("unknown_observation_rule: 2"));
    assert!(notes.contains("api.payments.test (blocked_egress, app)"));
    assert!(notes.contains("QA rules disabled: none; adopted: none; added: none"));
    assert!(notes.contains("Unresolved QA expectation: .rio/qa/journeys/checkout.yaml step 1"));
    assert!(notes.contains("Account required"));
    assert!(notes.contains("REVIEW.md:2–3"));
    assert!(notes.contains("Owner guidance requires guest checkout"));
    assert!(notes.contains("An account is requested"));
    assert!(notes.contains("this conflict alone is not a product defect"));
    assert_eq!(result["findings"], json!([]));
    let candidate = &result["observation_candidates"][0];
    assert_eq!(candidate["finding"]["qa"]["attribution"], "source");
    assert_eq!(candidate["finding"]["state"], "new");
    assert_eq!(candidate["finding"]["evidence_level"], "plausible");
    assert_eq!(candidate["expected"], json!({"confirmation":true}));
    assert_eq!(candidate["finding"]["id"].as_str().unwrap().len(), 64);
    assert_eq!(
        runtime_records(&result)["observation-candidates.json"],
        result["observation_candidates"]
    );
}

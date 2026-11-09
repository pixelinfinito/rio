use rio_core::{EvidenceLevel, QaAttribution, QaCell, QaKind, Severity, State};
use rio_qa::*;
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};

fn candidate(viewport: &str) -> QaCandidate {
    QaCandidate {
        rule_id: "mobile/tap-target".into(),
        journey: "checkout".into(),
        step: 2,
        route_pattern: "/checkout?session=ignored".into(),
        cell: QaCell {
            viewport: viewport.into(),
            color_scheme: "light".into(),
        },
        kind: QaKind::Accessibility,
        severity: Severity::Warning,
        trigger: QaTrigger::Probe {
            predicate: "mobile/tap-target".into(),
            role_signature: json!({"tag":"button","role":"button","name":"Pay"}),
        },
        message: "Small pay target".into(),
        suggested_fix: None,
        element_paths: vec!["main > button".into()],
        measurements: serde_json::from_value(json!({"width":28,"box":{"width":28,"height":28}}))
            .unwrap(),
        evidence: vec![format!("{viewport}-screenshot"), format!("{viewport}-dom")],
        attribution: AttributionHints::default(),
    }
}
fn snapshot() -> QaSnapshot {
    BTreeMap::from([
        ("src/Card.tsx".into(), b"<button>Save</button>\n".to_vec()),
        ("src/Billing.tsx".into(), b"<button>Save</button>\n<button>Pay</button>\n".to_vec()),
        ("src/Settings.tsx".into(), b"<button>Save</button>\n".to_vec()),
        (".rio/qa/journeys/checkout.yaml".into(), b"steps:\n  - do: Review address\n    expect: Correct\n  - do: Pay\n    expect: Confirmed\n".to_vec()),
    ])
}
fn artifacts(candidate: &QaCandidate) -> BTreeMap<String, QaArtifactRef> {
    candidate
        .evidence
        .iter()
        .zip(["screenshot", "dom"])
        .map(|(id, kind)| {
            (
                id.clone(),
                QaArtifactRef {
                    id: id.clone(),
                    journey: candidate.journey.clone(),
                    step: Some(candidate.step),
                    cell: candidate.cell.clone(),
                    kind: kind.into(),
                    sanitized: true,
                },
            )
        })
        .collect()
}
fn build(candidate: &QaCandidate) -> rio_core::Finding {
    construct_qa_finding(
        candidate,
        &artifacts(candidate),
        &snapshot(),
        &BTreeSet::new(),
    )
    .unwrap()
}
fn assessed(candidate: &QaCandidate) -> QaAssessmentKey {
    QaAssessmentKey {
        rule_id: candidate.rule_id.clone(),
        journey: candidate.journey.clone(),
        step: candidate.step,
        cell: candidate.cell.clone(),
    }
}

#[test]
fn identities_ignore_measurements_cells_lines_and_prose_but_preserve_structured_semantics() {
    let first = candidate("mobile");
    let mut second = candidate("desktop");
    second.measurements.insert("width".into(), json!(30));
    second.message = "Different summary".into();
    second.route_pattern = "https://app/checkout#anchor".into();
    assert_eq!(
        qa_finding_id(&first, &snapshot()),
        qa_finding_id(&second, &snapshot())
    );
    second.trigger = QaTrigger::Probe {
        predicate: second.rule_id.clone(),
        role_signature: json!({"tag":"button","role":"button","name":"Cancel"}),
    };
    assert_ne!(
        qa_finding_id(&first, &snapshot()),
        qa_finding_id(&second, &snapshot())
    );
    second.trigger = QaTrigger::Observation {
        expected: json!({"state":"confirmed"}),
        observed: json!({"state":"empty"}),
        targets: vec![json!({"tag":"section","role":"region","name":"Order result"})],
    };
    let id = qa_finding_id(&second, &snapshot());
    second.message = "Yet another summary".into();
    assert_eq!(id, qa_finding_id(&second, &snapshot()));
    second.trigger = QaTrigger::Observation {
        expected: json!({"state":"confirmed"}),
        observed: json!({"state":"loading"}),
        targets: vec![json!({"tag":"section","role":"region","name":"Order result"})],
    };
    assert_eq!(
        id,
        qa_finding_id(&second, &snapshot()),
        "Model descriptions do not define identity"
    );
    let mut changed = snapshot();
    changed.insert(
        ".rio/qa/journeys/checkout.yaml".into(),
        b"steps:\n  - do: Review address\n    expect: Correct\n  - do: Pay\n    expect: Pending\n"
            .to_vec(),
    );
    assert_ne!(id, qa_finding_id(&second, &changed));
    if let QaTrigger::Observation { targets, .. } = &mut second.trigger {
        *targets = vec![json!({"tag":"section","role":"region","name":"Delivery result"})];
    }
    assert_ne!(id, qa_finding_id(&second, &snapshot()));
}

#[test]
fn observation_identity_merges_cells_with_different_model_descriptions() {
    let mut mobile = candidate("mobile");
    mobile.trigger = QaTrigger::Observation {
        expected: json!({"result":"An order confirmation"}),
        observed: json!({"result":"An empty region after paying"}),
        targets: vec![json!({"tag":"section","role":"region","name":"Order result"})],
    };
    let mut desktop = mobile.clone();
    desktop.cell.viewport = "desktop".into();
    desktop.message = "Payment did not acknowledge success".into();
    desktop.element_paths = vec!["main section".into()];
    if let QaTrigger::Observation {
        expected, observed, ..
    } = &mut desktop.trigger
    {
        *expected = json!({"owner_requirement":"Clear confirmation after payment"});
        *observed = json!({"wait":"No feedback after ten seconds"});
    }
    let findings = classify_qa_findings(
        None,
        vec![build(&mobile), build(&desktop)],
        &BTreeSet::new(),
        &BTreeSet::new(),
        &BTreeSet::new(),
    )
    .unwrap();
    assert_eq!(findings.len(), 1);
    assert_eq!(findings[0].locations.len(), 2);
    if let QaTrigger::Observation { targets, .. } = &mut desktop.trigger {
        targets.clear();
    }
    assert_eq!(
        construct_qa_finding(
            &desktop,
            &artifacts(&desktop),
            &snapshot(),
            &BTreeSet::new()
        )
        .unwrap_err(),
        "missing_observation_target"
    );
    assert_eq!(
        construct_qa_finding(
            &mobile,
            &artifacts(&mobile),
            &QaSnapshot::new(),
            &BTreeSet::new()
        )
        .unwrap_err(),
        "missing_observation_requirement"
    );
}

#[test]
fn attribution_uses_annotations_then_unique_stack_then_unique_changed_text() {
    let mut item = candidate("mobile");
    let snapshot = snapshot();
    let changed = snapshot
        .keys()
        .filter(|path| path.starts_with("src/"))
        .cloned()
        .collect();
    item.attribution.text = vec!["Save".into()];
    let (where_, how) = attribute_qa(&item, &snapshot, &changed);
    assert_eq!(how, QaAttribution::Journey);
    assert_eq!(where_.line_start, 4);
    item.attribution.stack = vec![SourceHint {
        path: "http://app:4173/src/Billing.tsx".into(),
        line: 2,
    }];
    let (where_, how) = attribute_qa(&item, &snapshot, &changed);
    assert_eq!(how, QaAttribution::Source);
    assert_eq!(where_.path, "src/Billing.tsx");
    assert_eq!(where_.line_start, 2);
    item.attribution.annotations = vec![SourceHint {
        path: "/workspace/src/Card.tsx".into(),
        line: 1,
    }];
    assert_eq!(
        attribute_qa(&item, &snapshot, &changed).0.path,
        "src/Card.tsx"
    );
    item.attribution.annotations.push(SourceHint {
        path: "src/Settings.tsx".into(),
        line: 1,
    });
    assert_eq!(
        attribute_qa(&item, &snapshot, &changed).0.path,
        "src/Billing.tsx"
    );
    item.attribution.annotations.clear();
    item.attribution.stack = vec![SourceHint {
        path: "../../etc/passwd".into(),
        line: 1,
    }];
    item.attribution.text = vec!["Pay".into()];
    assert_eq!(
        attribute_qa(&item, &snapshot, &changed).0.path,
        "src/Billing.tsx"
    );
}

#[test]
fn artifact_validation_drops_unsupported_observations_and_requires_probe_screenshot_and_dom() {
    let mut item = candidate("mobile");
    let mut refs = artifacts(&item);
    refs.get_mut("mobile-dom").unwrap().sanitized = false;
    assert_eq!(
        construct_qa_finding(&item, &refs, &snapshot(), &BTreeSet::new()).unwrap_err(),
        "missing_or_invalid_evidence"
    );
    item.evidence.pop();
    assert_eq!(
        construct_qa_finding(&item, &artifacts(&item), &snapshot(), &BTreeSet::new()).unwrap_err(),
        "invalid_probe_evidence"
    );
    item.trigger = QaTrigger::Observation {
        expected: json!({"confirmation":true}),
        observed: json!({"confirmation":false}),
        targets: vec![json!({"tag":"section","role":"region","name":"Order result"})],
    };
    assert_eq!(build(&item).evidence_level, EvidenceLevel::Plausible);
    item.evidence.clear();
    assert_eq!(
        construct_qa_finding(&item, &BTreeMap::new(), &snapshot(), &BTreeSet::new()).unwrap_err(),
        "missing_or_invalid_evidence"
    );
}

#[test]
fn observations_accept_before_after_evidence_but_require_current_step_and_scope() {
    let mut item = candidate("mobile");
    item.trigger = QaTrigger::Observation {
        expected: json!({"confirmation":true}),
        observed: json!({"confirmation":false}),
        targets: vec![json!({"tag":"section","role":"region","name":"Order result"})],
    };
    let mut refs = artifacts(&item);
    let mut before = refs["mobile-screenshot"].clone();
    before.id = "before".into();
    before.step = Some(1);
    refs.insert(before.id.clone(), before);
    item.evidence.push("before".into());
    let finding = construct_qa_finding(&item, &refs, &snapshot(), &BTreeSet::new()).unwrap();
    assert_eq!(finding.evidence, item.evidence);
    assert_eq!(finding.evidence_level, EvidenceLevel::Plausible);
    for invalid in [
        QaArtifactRef {
            step: Some(0),
            ..refs["before"].clone()
        },
        QaArtifactRef {
            step: Some(3),
            ..refs["before"].clone()
        },
        QaArtifactRef {
            journey: "another".into(),
            ..refs["before"].clone()
        },
        QaArtifactRef {
            cell: candidate("desktop").cell,
            ..refs["before"].clone()
        },
        QaArtifactRef {
            sanitized: false,
            ..refs["before"].clone()
        },
    ] {
        let mut invalid_refs = refs.clone();
        invalid_refs.insert("before".into(), invalid);
        assert_eq!(
            construct_qa_finding(&item, &invalid_refs, &snapshot(), &BTreeSet::new()).unwrap_err(),
            "missing_or_invalid_evidence"
        );
    }
    let mut before_only = item.clone();
    before_only.evidence = vec!["before".into()];
    assert_eq!(
        construct_qa_finding(&before_only, &refs, &snapshot(), &BTreeSet::new()).unwrap_err(),
        "missing_or_invalid_evidence"
    );
    refs.get_mut("before").unwrap().step = None;
    refs.get_mut("before").unwrap().kind = "trace".into();
    assert_eq!(
        construct_qa_finding(&before_only, &refs, &snapshot(), &BTreeSet::new()).unwrap_err(),
        "missing_or_invalid_evidence"
    );
    refs.get_mut("before").unwrap().step = Some(1);
    item.trigger = candidate("mobile").trigger;
    assert_eq!(
        construct_qa_finding(&item, &refs, &snapshot(), &BTreeSet::new()).unwrap_err(),
        "missing_or_invalid_evidence"
    );
}

#[test]
fn cells_merge_and_worsened_fixed_and_incomplete_baselines_are_distinct() {
    let mobile = candidate("mobile");
    let desktop = candidate("desktop");
    let all = BTreeSet::from([assessed(&mobile), assessed(&desktop)]);
    let result = classify_qa_findings(
        Some(vec![build(&mobile)]),
        vec![build(&mobile), build(&desktop), build(&desktop)],
        &all,
        &all,
        &BTreeSet::new(),
    )
    .unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].locations.len(), 2);
    assert_eq!(result[0].state, State::Worsened);
    assert_eq!(result[0].evidence.len(), 4);
    assert!(result[0].location.cell.is_none());
    let schema: serde_json::Value =
        serde_json::from_str(include_str!("../../../schemas/finding-v1.json")).unwrap();
    let validator = jsonschema::validator_for(&schema).unwrap();
    let value = serde_json::to_value(&result[0]).unwrap();
    assert!(
        validator.is_valid(&value),
        "{:?}",
        validator
            .iter_errors(&value)
            .map(|error| error.to_string())
            .collect::<Vec<_>>()
    );
    let result = classify_qa_findings(
        Some(vec![build(&mobile)]),
        vec![build(&mobile), build(&desktop)],
        &BTreeSet::new(),
        &all,
        &BTreeSet::new(),
    )
    .unwrap();
    assert_eq!(result[0].state, State::Unclassified);
    let fixed = classify_qa_findings(
        Some(vec![build(&mobile)]),
        vec![],
        &all,
        &all,
        &BTreeSet::new(),
    )
    .unwrap();
    assert_eq!(fixed[0].state, State::Fixed);
    let missing = classify_qa_findings(
        Some(vec![build(&mobile)]),
        vec![],
        &all,
        &BTreeSet::new(),
        &BTreeSet::new(),
    )
    .unwrap();
    assert_eq!(missing[0].state, State::Unclassified);
}

#[test]
fn without_baseline_only_attributed_changed_source_is_new() {
    let mut item = candidate("mobile");
    let changed = BTreeSet::from([
        "src/Billing.tsx".into(),
        ".rio/qa/journeys/checkout.yaml".into(),
    ]);
    let result = classify_qa_findings(
        None,
        vec![build(&item)],
        &BTreeSet::new(),
        &BTreeSet::new(),
        &changed,
    )
    .unwrap();
    assert_eq!(result[0].state, State::Unclassified);
    item.attribution.annotations = vec![SourceHint {
        path: "src/Billing.tsx".into(),
        line: 2,
    }];
    let result = classify_qa_findings(
        None,
        vec![build(&item)],
        &BTreeSet::new(),
        &BTreeSet::new(),
        &changed,
    )
    .unwrap();
    assert_eq!(result[0].state, State::New);
    let roundtrip: rio_core::Finding =
        serde_json::from_value(serde_json::to_value(&result[0]).unwrap()).unwrap();
    assert_eq!(roundtrip.qa, result[0].qa);
    assert_eq!(roundtrip.locations, result[0].locations);
}

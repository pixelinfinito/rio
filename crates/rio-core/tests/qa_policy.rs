use rio_core::*;
use serde_json::json;

fn report() -> Report {
    let mut report: Report = serde_json::from_str(include_str!("qa-fixtures/report.json")).unwrap();
    report.status = ReportStatus::Complete;
    report.checks.clear();
    report.risks.clear();
    report.security.clear();
    report.qa.as_mut().unwrap()["observations_unverified"] = json!([]);
    report.findings[0].state = State::New;
    report.findings[0].severity = Severity::Warning;
    report
}
fn general() -> CompiledFailOn {
    FailOn {
        incomplete: false,
        ..Default::default()
    }
    .compile()
    .unwrap()
}

#[test]
fn qa_cap_is_independent_and_policy_sees_findings_held_back_from_display() {
    let mut report = report();
    let template = report.findings[0].clone();
    report.findings = (0..12)
        .map(|index| {
            let mut finding = template.clone();
            finding.id = format!("{index:064x}");
            finding
        })
        .collect();
    let ordinary: Finding = serde_json::from_str(include_str!("fixtures/finding.json")).unwrap();
    report.findings.extend((0..3).map(|_| ordinary.clone()));
    apply_qa_policy(&mut report, &json!({"max_defects":10}), false).unwrap();
    assert_eq!(
        report
            .findings
            .iter()
            .filter(|finding| finding.category == Category::Ux)
            .count(),
        10
    );
    assert_eq!(
        report
            .findings
            .iter()
            .filter(|finding| finding.category != Category::Ux)
            .count(),
        3
    );
    let audit = report.agent_audit.as_ref().unwrap();
    assert_eq!(audit["qa"]["held_back"].as_array().unwrap().len(), 2);
    assert_eq!(audit["qa"]["policy_matches"].as_array().unwrap().len(), 12);
    assert_eq!(exit_code(&report, &general(), ExitContext::default()), 1);
}

#[test]
fn info_unclassified_and_recommendations_are_neutral_but_adopted_warnings_fail() {
    for (severity, state) in [
        (Severity::Info, State::New),
        (Severity::Warning, State::Unclassified),
    ] {
        let mut report = report();
        report.findings[0].severity = severity;
        report.findings[0].state = state;
        report.qa.as_mut().unwrap()["recommendations"][0]["verification_status"] =
            json!("supported");
        apply_qa_policy(&mut report, &json!({}), false).unwrap();
        assert_eq!(exit_code(&report, &general(), ExitContext::default()), 0);
    }
    let mut adopted = report();
    adopted.findings[0].qa.as_mut().unwrap().kind = QaKind::Style;
    apply_qa_policy(&mut adopted, &json!({}), false).unwrap();
    assert_eq!(exit_code(&adopted, &general(), ExitContext::default()), 1);
    let mut informational = report().findings.remove(0);
    informational.severity = Severity::Info;
    assert!(
        !FailOn {
            rules: vec!["*".into()],
            ..Default::default()
        }
        .compile()
        .unwrap()
        .matches(&informational)
    );
}

#[test]
fn qa_suppressions_and_incomplete_policy_are_independent() {
    let mut suppressed = report();
    suppressed.findings[0].severity = Severity::Info;
    let id = suppressed.findings[0].id.clone();
    apply_suppressions(&mut suppressed, &[Suppression::Finding { finding: id }]).unwrap();
    assert!(suppressed.findings.is_empty());
    apply_qa_policy(&mut suppressed, &json!({}), false).unwrap();
    assert_eq!(
        exit_code(&suppressed, &general(), ExitContext::default()),
        0
    );
    let mut partial = report();
    partial.findings.clear();
    apply_qa_policy(&mut partial, &json!({}), true).unwrap();
    assert_eq!(exit_code(&partial, &general(), ExitContext::default()), 4);
    apply_qa_policy(&mut partial, &json!({"fail_on":{"incomplete":false}}), true).unwrap();
    assert_eq!(exit_code(&partial, &general(), ExitContext::default()), 0);
}

#[test]
fn local_deferred_verification_is_neutral_but_hosted_missing_verification_is_incomplete() {
    for (storage, expected) in [("local", 0), ("hosted", 4)] {
        let mut report = report();
        report.findings.clear();
        let qa = report.qa.as_mut().unwrap();
        qa["evidence"]["storage"] = json!(storage);
        qa["observations_unverified"] = json!([{"rule_id":"ui/no-feedback"}]);
        apply_qa_policy(&mut report, &json!({}), false).unwrap();
        assert_eq!(
            exit_code(&report, &general(), ExitContext::default()),
            expected
        );
    }
}

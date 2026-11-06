use rio_core::*;

fn report() -> Report {
    let mut report: Report = serde_json::from_str(include_str!("fixtures/complete.json")).unwrap();
    report.findings.clear();
    report.checks.clear();
    report
}

fn check(outcome: CheckOutcome) -> CheckEntry {
    CheckEntry {
        kind: CheckKind::Typecheck,
        language: "typescript".into(),
        root: ".".into(),
        version: Version::Head,
        scheduled_as: ScheduledAs::Changed,
        outcome,
        wall_time_ms: 0,
        cached: false,
    }
}

fn finding() -> Finding {
    let mut finding: Finding = serde_json::from_str(include_str!("fixtures/finding.json")).unwrap();
    finding.state = State::New;
    finding
}

#[test]
fn all_suppression_types_remove_every_copy_and_attribute_counts() {
    let f = finding();
    for suppression in [
        Suppression::Path {
            path: "src/**".into(),
        },
        Suppression::Rule {
            rule: "typecheck/tsc/*".into(),
        },
        Suppression::Finding {
            finding: f.id.clone(),
        },
    ] {
        let mut report = report();
        report.findings.push(f.clone());
        report.checks.push(check(CheckOutcome::Findings {
            details: CheckDetails {
                findings: vec![f.clone()],
                ..Default::default()
            },
        }));
        apply_suppressions(&mut report, &[suppression]).unwrap();
        assert!(report.findings.is_empty());
        assert!(report.checks[0].outcome.details().findings.is_empty());
        assert_eq!(report.summary.suppressed, 1);
        assert_eq!(
            report.footer.suppressions,
            vec![SuppressionCount { entry: 0, count: 1 }]
        );
    }
}

#[test]
fn default_policy_distinguishes_regressions_from_risks_and_existing_findings() {
    let policy = FailOn::default().compile().unwrap();
    let mut f = finding();
    assert!(policy.matches(&f));
    f.state = State::Worsened;
    assert!(policy.matches(&f));
    f.state = State::PreExisting;
    assert!(!policy.matches(&f));
    f.state = State::New;
    f.evidence_level = EvidenceLevel::Plausible;
    assert!(!policy.matches(&f));
    f.evidence_level = EvidenceLevel::StaticProven;
    f.category = Category::Risk;
    assert!(!policy.matches(&f));
    f.rule_id = "coverage/untested_change".into();
    assert!(
        FailOn {
            rules: vec!["coverage/*".into()],
            ..Default::default()
        }
        .compile()
        .unwrap()
        .matches(&f)
    );
}

#[test]
fn failed_and_required_skipped_checks_affect_exit_independently_of_report_status() {
    let mut r = report();
    let policy = FailOn::default().compile().unwrap();
    r.checks.push(check(CheckOutcome::Failed {
        reason: FailureReason::ToolCrashed,
        details: CheckDetails::default(),
    }));
    derive_report_status(&mut r);
    assert_eq!(r.status, ReportStatus::Incomplete);
    assert_eq!(exit_code(&r, &policy, ExitContext::default()), 4);
    assert_eq!(
        exit_code(
            &r,
            &FailOn {
                incomplete: false,
                ..Default::default()
            }
            .compile()
            .unwrap(),
            ExitContext::default()
        ),
        0
    );
    r.checks[0].outcome = CheckOutcome::Skipped {
        reason: SkipReason::ToolMissing,
        details: CheckDetails::default(),
    };
    derive_report_status(&mut r);
    assert_eq!(r.status, ReportStatus::Incomplete);
    assert_eq!(exit_code(&r, &policy, ExitContext::default()), 0);
    assert_eq!(
        exit_code(
            &r,
            &FailOn {
                required_checks: vec![CheckKind::Typecheck],
                ..Default::default()
            }
            .compile()
            .unwrap(),
            ExitContext::default()
        ),
        4
    );
    r.checks[0].outcome = CheckOutcome::Skipped {
        reason: SkipReason::Disabled,
        details: CheckDetails::default(),
    };
    derive_report_status(&mut r);
    assert_eq!(r.status, ReportStatus::Complete);
    assert_eq!(r.incomplete.len(), 1);
}
#[test]
fn incomplete_remote_votes_respect_the_incomplete_exit_policy() {
    let mut r = report();
    r.status = ReportStatus::Incomplete;
    // Skipped optional local checks preserve the existing exit policy.
    assert_eq!(
        exit_code(
            &r,
            &FailOn::default().compile().unwrap(),
            ExitContext::default()
        ),
        0
    );
    r.agent_audit = Some(serde_json::json!({
        "policy_failed": false, "policy_matches": [], "incomplete_votes": 3
    }));
    assert!(r.checks.is_empty());
    assert_eq!(
        exit_code(
            &r,
            &FailOn::default().compile().unwrap(),
            ExitContext::default()
        ),
        4
    );
    assert_eq!(
        exit_code(
            &r,
            &FailOn {
                incomplete: false,
                ..Default::default()
            }
            .compile()
            .unwrap(),
            ExitContext::default()
        ),
        0
    );
}

#[test]
fn precedence_and_partial_status_are_preserved() {
    let mut r = report();
    r.status = ReportStatus::Partial;
    r.findings.push(finding());
    r.checks.push(check(CheckOutcome::Cancelled {
        reason: CancellationReason::Interrupted,
        details: CheckDetails::default(),
    }));
    derive_report_status(&mut r);
    assert_eq!(r.status, ReportStatus::Partial);
    let policy = FailOn::default().compile().unwrap();
    assert_eq!(exit_code(&r, &policy, ExitContext::default()), 1);
    assert_eq!(
        exit_code(
            &r,
            &policy,
            ExitContext {
                second_interrupt: true,
                error: None
            }
        ),
        130
    );
    assert_eq!(
        exit_code(
            &r,
            &policy,
            ExitContext {
                second_interrupt: true,
                error: Some(StartError::UsageOrConfiguration)
            }
        ),
        2
    );
    assert_eq!(
        exit_code(
            &r,
            &policy,
            ExitContext {
                second_interrupt: true,
                error: Some(StartError::RepositoryOrInternal)
            }
        ),
        3
    );
    r.findings.clear();
    assert_eq!(exit_code(&r, &policy, ExitContext::default()), 4);
}

#[test]
fn partial_reports_respect_incomplete_policy_and_malformed_audits_fail_closed() {
    let mut r = report();
    r.status = ReportStatus::Partial;
    let lenient = FailOn {
        incomplete: false,
        ..Default::default()
    }
    .compile()
    .unwrap();
    let strict = FailOn::default().compile().unwrap();
    assert_eq!(exit_code(&r, &strict, ExitContext::default()), 4);
    assert_eq!(exit_code(&r, &lenient, ExitContext::default()), 0);
    r.status = ReportStatus::Complete;
    // A renamed or mistyped policy field must not read as a pass.
    r.agent_audit = Some(serde_json::json!({"policy_fail": true, "policy_matches": []}));
    assert_eq!(exit_code(&r, &lenient, ExitContext::default()), 4);
    r.agent_audit = Some(serde_json::json!({"policy_failed": "yes", "policy_matches": []}));
    assert_eq!(exit_code(&r, &lenient, ExitContext::default()), 4);
    r.agent_audit = Some(serde_json::json!({"policy_failed": true, "policy_matches": []}));
    assert_eq!(exit_code(&r, &lenient, ExitContext::default()), 1);
}

#[test]
fn lifecycle_status_and_responses_never_change_fail_on_or_exit_codes() {
    let policy = FailOn::default().compile().unwrap();
    for state in [State::New, State::PreExisting] {
        let mut base = report();
        let mut f = finding();
        f.state = state;
        base.findings.push(f);
        let expected_match = policy.matches(&base.findings[0]);
        let expected_exit = exit_code(&base, &policy, ExitContext::default());
        assert_eq!(expected_exit, if state == State::New { 1 } else { 0 });
        for status in [
            LifecycleStatus::Open,
            LifecycleStatus::Fixed,
            LifecycleStatus::Dismissed,
        ] {
            for reason in ResponseReason::ALL {
                let mut report = base.clone();
                let f = &mut report.findings[0];
                f.round = Some(3);
                f.first_posted_in = Some("snap-1".into());
                f.status = Some(status);
                f.resolution = Some(Resolution {
                    fixed_in: Some("snap-3".into()),
                    note: None,
                });
                f.author_response = Some(AuthorResponse {
                    reason,
                    actor: "octocat".into(),
                    at: "2026-11-05T10:00:00Z".into(),
                    note: None,
                });
                assert_eq!(policy.matches(&report.findings[0]), expected_match);
                assert_eq!(
                    exit_code(&report, &policy, ExitContext::default()),
                    expected_exit
                );
            }
        }
    }
}

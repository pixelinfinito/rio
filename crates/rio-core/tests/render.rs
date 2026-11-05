use rio_core::*;
fn fixture(name: &str) -> Report {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(format!("{name}.json"));
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}
#[test]
fn terminal_and_markdown_snapshots() {
    let policy = FailOn::default().compile().unwrap();
    for name in ["complete", "incomplete", "partial", "no_changes", "error"] {
        let mut report = fixture(name);
        if name == "incomplete" {
            report.findings.clear();
            report.risks.clear();
        }
        for width in [80, 120] {
            let options = RenderOptions {
                width,
                show_pre_existing: true,
                policy: Some(&policy),
                ..Default::default()
            };
            let output = render_terminal(&report, &options);
            assert!(output.lines().all(|line| line.chars().count() <= width));
            insta::assert_snapshot!(format!("{name}_{width}"), output);
        }
        insta::assert_snapshot!(
            format!("{name}_markdown"),
            render_markdown(&report, &RenderOptions::default())
        );
    }
}
#[test]
fn json_validates_all_statuses_and_rejects_invalid_reports_before_output() {
    for name in ["complete", "incomplete", "partial", "no_changes", "error"] {
        let report = fixture(name);
        let output = render_json(&report).unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&output).unwrap();
        assert!(parsed["metrics"]["wall_time_ms"].is_number());
        for check in parsed["checks"].as_array().unwrap() {
            assert!(check["wall_time_ms"].is_number());
        }
    }
    assert!(render_json(&Report::empty(ReportStatus::Error)).is_err());
}
#[test]
fn every_renderer_redacts_credentials_and_uses_stable_headings() {
    let mut report = fixture("complete");
    report
        .footer
        .notes
        .push("token = ghp_abcdefghijklmnopqrstuvwxyz1234567890".into());
    for output in [
        render_terminal(&report, &RenderOptions::default()),
        render_markdown(&report, &RenderOptions::default()),
        String::from_utf8(render_json(&report).unwrap()).unwrap(),
    ] {
        assert!(!output.contains("abcdefghijklmnopqrstuvwxyz"));
        assert!(output.contains("[REDACTED]"));
        assert!(!output.contains('\x1b'));
    }
    let first = render_markdown(&report, &RenderOptions::default());
    let second = render_markdown(&fixture("partial"), &RenderOptions::default());
    for heading in ["## Deterministic results", "## Findings", "## Footer"] {
        assert!(first.contains(heading));
        assert!(second.contains(heading));
    }
}
#[test]
fn progress_reports_completed_outcomes() {
    assert!(
        render_progress(&ReviewEvent::CheckFinished {
            kind: CheckKind::Coverage,
            root: "pkg".into(),
            findings: 0,
            skipped: false,
            outcome: CheckOutcome::Cancelled {
                reason: CancellationReason::Timeout,
                details: CheckDetails::default()
            }
        })
        .unwrap()
        .contains("cancelled (timeout)")
    );
}

#[test]
fn dependency_and_baseline_headers_count_unclassified_findings_and_name_a_remedy() {
    for (reason, hint, note, expected) in [
        (
            Some(SkipReason::DependencyMismatch),
            "installed example differs",
            "",
            "0 unclassified: dependency_mismatch; install from lockfile.",
        ),
        (
            Some(SkipReason::DependencyMismatch),
            "no lockfile (set trust_installed_dependencies to run anyway)",
            "",
            "0 unclassified: dependency_mismatch; set trust_installed_dependencies.",
        ),
        (
            None,
            "",
            "baseline_failed: base dependencies differ",
            "1 unclassified: baseline_failed; check base tools; install from base lockfile.",
        ),
        (
            None,
            "",
            "baseline disabled in the profile",
            "1 unclassified: baseline disabled; enable baseline in profile.",
        ),
        (
            None,
            "",
            "",
            "1 unclassified: baseline unavailable; check baseline hint in footer.",
        ),
    ] {
        let mut report = fixture("complete");
        report.risks.clear();
        report.findings.truncate(1);
        report.findings[0].state = if reason.is_some() {
            State::PreExisting
        } else {
            State::Unclassified
        };
        report.checks.truncate(1);
        report.incomplete.clear();
        report.footer.notes = if note.is_empty() {
            Vec::new()
        } else {
            vec![note.into()]
        };
        if let Some(reason) = reason {
            report.checks[0].outcome = CheckOutcome::Skipped {
                reason,
                details: CheckDetails {
                    hint: Some(hint.into()),
                    ..Default::default()
                },
            };
        }
        for output in [
            render_terminal(&report, &RenderOptions::default()),
            render_markdown(&report, &RenderOptions::default()),
        ] {
            assert!(
                output.lines().take(8).any(|line| line.trim() == expected),
                "{output}"
            );
        }
    }
}

#[test]
fn trusted_results_with_a_baseline_do_not_claim_to_be_unclassified() {
    let mut report = fixture("complete");
    report
        .findings
        .iter_mut()
        .for_each(|f| f.state = State::New);
    report.risks.clear();
    report
        .footer
        .notes
        .push("dependencies_trusted: results use unverified dependencies".into());
    for output in [
        render_terminal(&report, &RenderOptions::default()),
        render_markdown(&report, &RenderOptions::default()),
    ] {
        assert!(!output.contains("unclassified:"));
        assert!(output.contains("dependencies_trusted"));
    }
}

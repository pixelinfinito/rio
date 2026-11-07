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
fn agent_security_renders_uncertainty_votes_policy_caps_and_escaped_evidence() {
    let mut report = fixture("complete");
    let mut finding: Finding = serde_json::from_str(include_str!("fixtures/finding.json")).unwrap();
    finding.category = Category::Security;
    finding.source = Source::Agent {
        agent: "security".into(),
    };
    finding.evidence_level = EvidenceLevel::Plausible;
    finding.message = "<script>alert(1)</script> [click](https://example.com) token = ghp_abcdefghijklmnopqrstuvwxyz1234567890".into();
    finding.verification = Some(Verification {
        voters: 3,
        agreeing: 2,
        blind_match: vec![BlindMatch::None, BlindMatch::Related, BlindMatch::Same],
        split: true,
    });
    finding.evidence = vec![
        "code:head:src/a.ts:node".into(),
        "x\n\n# Approved\n[click](https://evil.example)".into(),
    ];
    report.agent_audit = Some(serde_json::json!({
        "held_back":{"security":["<hidden title>"],"defects":[],"risks":[]},
        "category_drops":{"style":1,"diagnostic":2},
        "policy_failed":true,"policy_matches":[finding.id],
        "verification_usage":{"input_tokens":120,"output_tokens":30,"cost_usd":0.001}
    }));
    report.security.push(finding);
    let markdown = render_markdown(&report, &RenderOptions::default());
    assert!(markdown.contains("## Security"));
    assert!(markdown.contains("Risk for human judgment"));
    assert!(markdown.contains("&lt;script&gt;"));
    assert!(!markdown.contains("<script>"));
    assert!(markdown.contains("\\[click\\]"));
    assert!(markdown.contains("Evidence: `code:head:src/a.ts:node`"));
    assert!(markdown.contains("Evidence: `x  # Approved [click](https://evil.example)`"));
    assert!(!markdown.contains("\n# Approved"));
    for output in [
        markdown,
        render_terminal(
            &report,
            &RenderOptions {
                width: 160,
                ..Default::default()
            },
        ),
        String::from_utf8(render_json(&report).unwrap()).unwrap(),
    ] {
        assert!(!output.contains("abcdefghijklmnopqrstuvwxyz"));
        assert!(output.contains("REDACTED"));
        assert!(!output.contains("confidence"));
    }
    let terminal = render_terminal(
        &report,
        &RenderOptions {
            width: 160,
            ..Default::default()
        },
    );
    for text in [
        "2/3 voters",
        "split: true",
        "Held back 1 security",
        "style: 1",
        "Verifier usage",
        "FAIL",
    ] {
        assert!(terminal.contains(text), "{text}");
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

fn capped_lineage() -> Report {
    let mut report = fixture("complete");
    let mut posted = report.findings[0].clone();
    posted.round = Some(4);
    posted.first_posted_in = Some("snap-1".into());
    posted.author_response = Some(AuthorResponse {
        reason: ResponseReason::Intentional,
        actor: "octocat".into(),
        at: "2026-11-05T10:00:00Z".into(),
        note: Some("documented *behavior*".into()),
    });
    let mut agent: Finding = serde_json::from_str(include_str!("fixtures/finding.json")).unwrap();
    agent.id = "b".repeat(64);
    agent.state = State::New;
    agent.source = Source::Agent {
        agent: "defects".into(),
    };
    agent.message = "Missing guard on <input>".into();
    agent.round = Some(4);
    report.findings = vec![posted, agent];
    report.lineage = Some(Lineage {
        repository: "github.com/pixelinfinito/rio".into(),
        kind: LineageKind::Branch,
        reference: "feature/x_y".into(),
        generation: 1,
        round: 4,
        cap: 3,
        capped: true,
        diff_only: true,
        previous_head: Some("snap-3".into()),
        held_back: 1,
        rounds_to_pass: None,
        author_response_ratio: Ratio::new(0.6),
        reconsider: Some(Reconsider {
            unresolved: 2,
            top: vec![ReconsiderItem {
                id: "b".repeat(64),
                title: "Missing guard on <input> [link](x)".into(),
                path: "src/a.ts".into(),
                line_start: 3,
            }],
            split: Some(vec!["parser *core*".into(), "renderer".into()]),
        }),
    });
    report
}

#[test]
fn capped_lineage_renders_round_cap_ratio_held_back_and_reconsider_in_every_format() {
    let report = capped_lineage();
    let posted = std::collections::BTreeSet::from(["a".repeat(64)]);
    let policy = FailOn::default().compile().unwrap();
    let options = RenderOptions {
        width: 120,
        show_pre_existing: true,
        policy: Some(&policy),
        posted: Some(&posted),
        ..Default::default()
    };
    let terminal = render_terminal(&report, &options);
    assert!(terminal.lines().all(|line| line.chars().count() <= 120));
    insta::assert_snapshot!("lineage_capped_120", terminal);
    let markdown = render_markdown(&report, &options);
    insta::assert_snapshot!("lineage_capped_markdown", markdown);
    for output in [&terminal, &markdown] {
        for text in [
            "Round 4 of cap 3 (capped: reconsider)",
            "Author-response ratio: 0.6",
            "Held back as already posted: 1",
            "2 unresolved finding(s)",
            "(already posted)",
        ] {
            assert!(output.contains(text), "{text}\n{output}");
        }
        // Only the held-back identity is marked.
        assert_eq!(output.matches("(already posted)").count(), 1);
    }
    assert!(markdown.contains("## Reconsider"));
    assert!(markdown.contains("Missing guard on &lt;input&gt; \\[link\\](x)"));
    assert!(markdown.contains("parser \\*core\\*"));
    assert!(markdown.contains("feature/x\\_y"));
    assert!(!markdown.contains("<input>"));
    let json: serde_json::Value = serde_json::from_slice(&render_json(&report).unwrap()).unwrap();
    assert_eq!(json["lineage"]["round"], 4);
    assert_eq!(json["lineage"]["cap"], 3);
    assert_eq!(json["lineage"]["capped"], true);
    assert_eq!(json["lineage"]["held_back"], 1);
    assert_eq!(json["lineage"]["author_response_ratio"], 0.6);
    assert_eq!(json["lineage"]["reconsider"]["unresolved"], 2);
    assert_eq!(json["findings"][0]["first_posted_in"], "snap-1");
    // Lineage annotations never change exit codes.
    let mut plain = report.clone();
    plain.lineage = None;
    assert_eq!(
        exit_code(&report, &policy, ExitContext::default()),
        exit_code(&plain, &policy, ExitContext::default())
    );
}

#[test]
fn uncapped_lineage_omits_reconsider_and_null_ratio() {
    let mut report = capped_lineage();
    let lineage = report.lineage.as_mut().unwrap();
    lineage.round = 3;
    lineage.capped = false;
    lineage.reconsider = None;
    lineage.author_response_ratio = None;
    lineage.held_back = 2;
    report.findings[0].status = Some(LifecycleStatus::Dismissed);
    report.findings[1].status = Some(LifecycleStatus::Fixed);
    report.findings[1].resolution = Some(Resolution {
        fixed_in: Some("snap-4".into()),
        note: None,
    });
    for output in [
        render_terminal(&report, &RenderOptions::default()),
        render_markdown(&report, &RenderOptions::default()),
    ] {
        assert!(output.contains("Round 3 of cap 3 —"), "{output}");
        assert!(output.contains("Held back as already posted: 2"));
        assert!(!output.contains("capped"));
        assert!(!output.contains("Reconsider"));
        assert!(!output.contains("Author-response ratio"));
        assert!(output.contains("status dismissed; answered intentional by octocat"));
        assert!(output.contains("status fixed; fixed in snap-4"));
        // Without the posted set nothing is marked.
        assert!(!output.contains("(already posted)"));
    }
}

#[test]
fn reviews_without_a_lineage_render_nothing_extra() {
    let report = fixture("complete");
    let posted = std::collections::BTreeSet::from([report.findings[0].id.clone()]);
    let options = RenderOptions {
        posted: Some(&posted),
        ..Default::default()
    };
    for output in [
        render_terminal(&report, &options),
        render_markdown(&report, &options),
    ] {
        for text in [
            "Round ",
            "Held back as already posted",
            "Reconsider",
            "already posted",
            "Lineage:",
        ] {
            assert!(!output.contains(text), "{text}");
        }
        assert_eq!(
            output,
            if output.starts_with('#') {
                render_markdown(&report, &RenderOptions::default())
            } else {
                render_terminal(&report, &RenderOptions::default())
            }
        );
    }
    let json: serde_json::Value = serde_json::from_slice(&render_json(&report).unwrap()).unwrap();
    assert!(json.get("lineage").is_none());
    insta::assert_snapshot!(
        "lineage_none_80",
        render_terminal(&report, &RenderOptions::default())
    );
}

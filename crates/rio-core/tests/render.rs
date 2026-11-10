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
        cached: None,
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
        cached: None,
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

fn security_run() -> Report {
    // The SARIF fixture's review has security findings and catalog coverage.
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/sarif/risks-and-plausible/report.json");
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

#[test]
fn security_catalog_coverage_renders_in_section_and_footer_of_every_format() {
    let assessed = security_run();
    let mut unassessed = fixture("complete");
    unassessed.security_coverage = Some(SecurityCoverage {
        catalog: SecurityCatalog::Asvs5_0,
        assessed: vec![AssessedItem {
            item: "V1.2".into(),
            title: "Injection Prevention".into(),
            findings: vec![],
        }],
        unassessed: vec![
            UnassessedItem {
                item: "V8.3".into(),
                title: "Operation Level Authorization".into(),
                reason: UnassessedReason::Budget,
            },
            UnassessedItem {
                item: "V2.2".into(),
                title: "Input Validation".into(),
                reason: UnassessedReason::NoEvidence,
            },
        ],
        not_applicable: vec![CatalogItemRef {
            item: "V3.6".into(),
            title: "External Resource Integrity".into(),
        }],
    });
    let none = fixture("complete");
    for (name, report) in [
        ("security_assessed", &assessed),
        ("security_unassessed", &unassessed),
    ] {
        let terminal = render_terminal(report, &RenderOptions::default());
        let markdown = render_markdown(report, &RenderOptions::default());
        for output in [&terminal, &markdown] {
            assert!(output.contains("Security"), "{name}");
            assert!(output.contains("Not a passed security review"), "{name}");
            assert!(
                !output.contains("security review was not performed"),
                "{name}"
            );
        }
        insta::assert_snapshot!(format!("{name}_120"), {
            let options = RenderOptions {
                width: 120,
                ..Default::default()
            };
            render_terminal(report, &options)
        });
        insta::assert_snapshot!(format!("{name}_markdown"), markdown);
        let json: serde_json::Value =
            serde_json::from_slice(&render_json(report).unwrap()).unwrap();
        assert_eq!(
            json["security_coverage"],
            serde_json::to_value(report.security_coverage.as_ref().unwrap()).unwrap()
        );
    }
    // Zero security findings with unassessed items is not presented as clean.
    let wide = RenderOptions {
        width: 200,
        ..Default::default()
    };
    let terminal = render_terminal(&unassessed, &wide);
    assert!(terminal.contains("No security finding was produced."));
    assert!(terminal.contains("V8.3 (budget), V2.2 (no_evidence)"));
    // A review without the security step renders neither the section nor the footer line.
    for output in [
        render_terminal(&none, &RenderOptions::default()),
        render_markdown(&none, &RenderOptions::default()),
    ] {
        assert!(!output.contains("\nSecurity\n") && !output.contains("## Security"));
        assert!(!output.contains("Security catalog"));
    }
    let json: serde_json::Value = serde_json::from_slice(&render_json(&none).unwrap()).unwrap();
    assert!(json.get("security_coverage").is_none());
}

/// A review with a recurring `wrong` finding, a regression of a fixed finding,
/// two remembered dismissals, one open proposal and agent cache use.
fn history_run() -> Report {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/sarif/lineage-history/report.json");
    let mut report: Report = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    report.lineage = None;
    let mut regression = report.findings[0].clone();
    regression.id = "6".repeat(64);
    regression.rule_id = "correctness/stale-read".into();
    regression.status = None;
    regression.round = None;
    regression.first_posted_in = None;
    regression.history = Some(FindingHistory {
        first_seen: "rev-1".into(),
        last_seen: "rev-1".into(),
        seen_count: 1,
        previous_status: LifecycleStatus::Fixed,
        previous_response: None,
        dismissed_in: None,
        fixed_in: Some("rev-2".into()),
    });
    let mut remembered = report.findings.remove(1);
    remembered.status = None;
    remembered.author_response = None;
    remembered.round = None;
    remembered.first_posted_in = None;
    remembered.history = Some(FindingHistory {
        first_seen: "rev-1".into(),
        last_seen: "rev-2".into(),
        seen_count: 2,
        previous_status: LifecycleStatus::Dismissed,
        previous_response: Some(AuthorResponse {
            reason: ResponseReason::Intentional,
            actor: "maintainer".into(),
            at: "2026-11-01T09:00:00Z".into(),
            note: None,
        }),
        dismissed_in: Some("github.com/acme/api#41".into()),
        fixed_in: None,
    });
    let mut second = remembered.clone();
    second.id = "7".repeat(64);
    second.location.line_start = 30;
    second.location.line_end = 30;
    second.locations = vec![second.location.clone()];
    report.findings.push(regression);
    report.remembered = vec![remembered, second];
    report.suppression_proposals = Some(vec![SuppressionProposal {
        id: "sp-3f2a9c1b7d4e".into(),
        entry: ProposalEntry::Rule {
            rule: "lint/eslint/max-len".into(),
        },
        evidence_count: 3,
        since: "2026-11-05T10:00:00Z".into(),
    }]);
    report.cache = Some(CacheStats {
        lookups: 8,
        hits: 4,
        hit_rate: Ratio::new(0.5),
        tokens_saved_estimate: 5200,
    });
    report
}

#[test]
fn history_remembered_proposals_and_cache_render_in_every_format() {
    let report = history_run();
    let policy = FailOn::default().compile().unwrap();
    let wide = |show_remembered| RenderOptions {
        width: 200,
        show_remembered,
        policy: Some(&policy),
        ..Default::default()
    };
    for (name, show) in [
        ("history_default", false),
        ("history_show_remembered", true),
    ] {
        let terminal = render_terminal(&report, &wide(show));
        let markdown = render_markdown(&report, &wide(show));
        // Markdown escapes `#` and `_`; compare its text unescaped.
        for output in [&terminal, &markdown.replace('\\', "")] {
            assert!(output.contains(
                "Remembered: 2 finding(s) dismissed earlier on unchanged code and not re-reported (2 intentional in github.com/acme/api#41)"
            ));
            assert!(output.contains("Suppression proposal sp-3f2a9c1b7d4e: rule lint/eslint/max-len (3 dismissal(s) since 2026-11-05T10:00:00Z)"));
            assert!(output.contains(
                "Agent cache: 4 of 8 lookup(s) served from cache (hit rate 0.5); about 5200 tokens saved"
            ));
            assert!(output.contains(
                "answered wrong by octocat (guarded by the lock) in github.com/acme/api#37"
            ));
            assert!(output.contains("regression of a finding fixed in rev-2"));
            // The remembered findings are listed only on request.
            assert_eq!(output.contains("Remembered findings"), show, "{name}");
            assert_eq!(
                output.contains(&"7".repeat(8)) || output.contains(":30"),
                show,
                "{name}"
            );
        }
        insta::assert_snapshot!(format!("{name}_200"), terminal);
        insta::assert_snapshot!(format!("{name}_markdown"), markdown);
    }
    // The flag changes neither the exit code nor any FAIL marker on remembered findings.
    let shown = render_terminal(&report, &wide(true));
    let section =
        &shown[shown.find("\nRemembered findings").unwrap()..shown.find("\nFooter").unwrap()];
    assert!(!section.contains("FAIL"), "{section}");
    let mut without = report.clone();
    without.remembered.clear();
    assert_eq!(
        exit_code(&report, &policy, ExitContext::default()),
        exit_code(&without, &policy, ExitContext::default())
    );
    // JSON carries the remembered list and its history blocks; it validates.
    let json: serde_json::Value = serde_json::from_slice(&render_json(&report).unwrap()).unwrap();
    assert_eq!(json["remembered"].as_array().unwrap().len(), 2);
    assert_eq!(
        json["remembered"][0]["history"]["previous_response"]["reason"],
        "intentional"
    );
    assert_eq!(json["findings"][1]["history"]["fixed_in"], "rev-2");
    assert_eq!(json["cache"]["hits"], 4);
    // Without the objects there are no lines.
    let plain = fixture("complete");
    for output in [
        render_terminal(&plain, &RenderOptions::default()),
        render_markdown(&plain, &RenderOptions::default()),
    ] {
        assert!(
            !output.contains("Remembered")
                && !output.contains("Agent cache")
                && !output.contains("Suppression proposal")
        );
    }
}

/// The recorded PR-mode round 1 (worker/tests/pr-mode.test.ts) under three
/// publication outcomes: published, partly failed, and `ask` on a webhook.
#[test]
fn pull_request_header_and_publication_render_in_every_format() {
    let recorded: Report = serde_json::from_str(include_str!(
        "../../../tests/fixtures/sarif/pr-lineage/report.json"
    ))
    .unwrap();
    let policy = FailOn::default().compile().unwrap();
    let options = RenderOptions {
        width: 200,
        policy: Some(&policy),
        ..Default::default()
    };
    let mut failed = recorded.clone();
    let publication = failed.publication.as_mut().unwrap();
    publication.posted = 1;
    publication.failed = 1;
    publication.failures = vec![PublicationFailure {
        id: recorded.findings[1].id.clone(),
        kind: PublicationKind::Finding,
        error: "GitHub /repos/acme/shop/pulls/7/comments returned HTTP 422: Validation Failed"
            .into(),
    }];
    let mut ask = recorded.clone();
    ask.publication = Some(Publication {
        policy: PublishPolicy::Ask,
        posted: 0,
        edited: 0,
        resolved: 0,
        failed: 0,
        unanchored: 0,
        check_run_url: Some("https://github.com/acme/shop/runs/1007".into()),
        summary_comment_url: None,
        reason: Some(UnpublishedReason::AskWithoutConsent),
        failures: Vec::new(),
    });
    for (name, report, line) in [
        (
            "publication_published",
            &recorded,
            "Publication (auto): 2 posted, 0 edited, 0 resolved, 0 unanchored (in the summary), 0 failed",
        ),
        (
            "publication_failed",
            &failed,
            "Publication failed for finding",
        ),
        (
            "publication_ask_webhook",
            &ask,
            "Publication (ask): check run only; comments require `publish: auto` or `rio review --pr <n> --publish`",
        ),
    ] {
        let terminal = render_terminal(report, &options);
        let markdown = render_markdown(report, &options);
        assert!(
            terminal.contains("Pull request: acme/shop#7  Head: "),
            "{name}"
        );
        // Markdown escapes `#`, `_`, `<` and `>`; compare its text unescaped.
        let unescaped = markdown
            .replace('\\', "")
            .replace("&lt;", "<")
            .replace("&gt;", ">");
        for output in [&terminal, &unescaped] {
            assert!(output.contains(line), "{name}: {output}");
        }
        insta::assert_snapshot!(format!("{name}_200"), terminal);
        insta::assert_snapshot!(format!("{name}_markdown"), markdown);
        // JSON carries the object as is and validates.
        let json: serde_json::Value =
            serde_json::from_slice(&render_json(report).unwrap()).unwrap();
        assert_eq!(
            json["publication"],
            serde_json::to_value(report.publication.as_ref().unwrap()).unwrap()
        );
        assert_eq!(json["review"]["pull_request"]["number"], 7);
    }
    assert!(render_markdown(&failed, &options).contains("retried on the next round"));
    // A failed publication after a clean review exits 5; a policy match still wins.
    let mut clean = failed.clone();
    clean.findings.clear();
    clean.agent_audit.as_mut().unwrap()["policy_failed"] = serde_json::json!(false);
    assert_eq!(exit_code(&clean, &policy, ExitContext::default()), 5);
    assert_eq!(exit_code(&failed, &policy, ExitContext::default()), 1);
    assert_eq!(exit_code(&recorded, &policy, ExitContext::default()), 1);
}

fn council_member(role: &str, cause: Option<&str>) -> CouncilMember {
    CouncilMember {
        role: role.into(),
        abstained: cause.is_some(),
        cause: cause.map(Into::into),
    }
}

fn council_members(abstaining: &[(&str, &str)]) -> Vec<CouncilMember> {
    [
        "skeptic",
        "exploit-author",
        "code-owner",
        "maintainer",
        "tester",
    ]
    .into_iter()
    .map(|role| {
        council_member(
            role,
            abstaining.iter().find(|(r, _)| *r == role).map(|(_, c)| *c),
        )
    })
    .collect()
}

fn council_cost(experiments: u32) -> CouncilCost {
    CouncilCost {
        members: 5,
        rounds: 2,
        experiments,
        tokens: [
            ("anthropic".to_string(), 4200),
            ("openai".to_string(), 3900),
        ]
        .into(),
        runner_seconds: if experiments > 0 { 14 } else { 0 },
    }
}

/// Four councils: reproduced by an experiment, refuted by a protection,
/// plausible with a note, and a partial council.
fn council_run() -> Report {
    let mut report = security_run();
    let reproduced = CouncilReview {
        decision: Some(CouncilDecision::Reproduced),
        tier: Some(CouncilTier::Experiment),
        members: council_members(&[]),
        experiments: vec![CouncilExperiment {
            command: vec!["npm".into(), "test".into(), "--".into(), "routes".into()],
            version: "both".into(),
            expect: "fails".into(),
            run: true,
            reason: None,
            outcome: Some(ExperimentOutcome {
                base: Some("passed".into()),
                head: Some("failed".into()),
            }),
            artifact: Some("exp-1".into()),
        }],
        note: Some("Real: most of the weight answers yes (static_path; tester, maintainer). No experiment disagreed.".into()),
        protection: None,
        partial: false,
        skipped: false,
        answered: 5,
        total: 5,
        static_only: false,
        weight_category: None,
        author_family: Some(AuthorFamily {
            status: "not_applicable".into(),
            family: None,
            substituted: vec![],
            dropped: vec![],
        }),
        excluded: vec![],
    };
    report.risks[0].evidence_level = EvidenceLevel::Reproduced;
    report.risks[0].council = Some(reproduced);
    let plausible = CouncilReview {
        decision: Some(CouncilDecision::Plausible),
        tier: Some(CouncilTier::Judgment),
        members: council_members(&[]),
        experiments: vec![],
        note: Some("Real: about half of the weight answers yes (static_path; exploit-author); about half of the weight answers no (contract; skeptic). No experiment ran.".into()),
        protection: None,
        partial: false,
        skipped: false,
        answered: 5,
        total: 5,
        static_only: false,
        weight_category: None,
        author_family: Some(AuthorFamily {
            status: "applied".into(),
            family: Some("claude".into()),
            substituted: vec![Substitution {
                role: "code-owner".into(),
                vendor: "google".into(),
                family: "gemini".into(),
            }],
            dropped: vec![],
        }),
        excluded: vec![],
    };
    report.security[0].council = Some(plausible);
    let partial = CouncilReview {
        decision: Some(CouncilDecision::Plausible),
        tier: Some(CouncilTier::Judgment),
        members: council_members(&[("tester", "excluded")]),
        experiments: vec![CouncilExperiment {
            command: vec!["make".into(), "check".into()],
            version: "head".into(),
            expect: "fails".into(),
            run: false,
            reason: Some("cap".into()),
            outcome: None,
            artifact: None,
        }],
        note: Some("No member cited evidence: every answer had basis none.".into()),
        protection: None,
        partial: true,
        skipped: false,
        answered: 4,
        total: 5,
        static_only: false,
        weight_category: None,
        author_family: None,
        excluded: vec![CouncilExclusion {
            role: "tester".into(),
            vendor: "google".into(),
            denied_by: "repository".into(),
        }],
    };
    report.security[1].council = Some(partial);
    let mut refuted = report.findings[0].clone();
    refuted.id = "e".repeat(64);
    refuted.rule_id = "correctness/null-dereference".into();
    refuted.evidence_level = EvidenceLevel::Refuted;
    refuted.council = Some(CouncilReview {
        decision: Some(CouncilDecision::Refuted),
        tier: Some(CouncilTier::Protection),
        members: council_members(&[("maintainer", "timeout")]),
        experiments: vec![],
        note: Some(
            "Real: most of the weight answers no (protection_found; skeptic, code-owner).".into(),
        ),
        protection: Some("head-2".into()),
        partial: true,
        skipped: false,
        answered: 4,
        total: 5,
        static_only: false,
        weight_category: None,
        author_family: None,
        excluded: vec![],
    });
    let finding = |f: &Finding, status: &str, answered: u32, experiments: u32| CouncilFindingCost {
        id: f.id.clone(),
        status: status.into(),
        answered,
        total: 5,
        cost: council_cost(experiments),
    };
    report.council = Some(CouncilMetrics {
        councilled: 4,
        not_councilled: 2,
        findings: vec![
            finding(&report.risks[0], "complete", 5, 1),
            finding(&refuted, "partial", 4, 0),
            finding(&report.security[0], "complete", 5, 0),
            finding(&report.security[1], "partial", 4, 0),
        ],
        total: CouncilCost {
            members: 20,
            rounds: 8,
            experiments: 1,
            tokens: [
                ("anthropic".to_string(), 16800),
                ("openai".to_string(), 15600),
            ]
            .into(),
            runner_seconds: 14,
        },
        refuted: vec![refuted],
        held: vec![],
    });
    report
}

#[test]
fn council_section_and_footer_render_in_every_format() {
    let report = council_run();
    let wide = RenderOptions {
        width: 200,
        ..Default::default()
    };
    let terminal = render_terminal(&report, &wide);
    let markdown = render_markdown(&report, &RenderOptions::default());
    for output in [&terminal, &markdown] {
        // Order: security, then council, then the footer.
        let security = output.find("Security").unwrap();
        let council = output.find("Council\n").unwrap();
        let footer = output.find("Footer").unwrap();
        assert!(security < council && council < footer, "{output}");
        assert!(output.contains("reproduced (tier experiment)"));
        assert!(output.contains("refuted (tier protection)"));
        assert!(output.contains("Protection cited: head-2"));
        assert!(output.contains("plausible (tier judgment)"));
        assert!(output.contains("partial (4/5)"));
        assert!(output.contains("Excluded: google (tester), denied by the repository allowlist"));
        assert!(output.contains("Author-family rule: not applicable"));
        assert!(output.contains("2 selected not councilled because of max_findings"));
        assert!(output.contains("5 members × 2 rounds × 1 experiments"));
        assert!(!output.contains('%'));
    }
    // A reproduced risk stays in the risks section.
    let risks = terminal.find("\nRisks").unwrap();
    let security = terminal.find("\nSecurity").unwrap();
    let route = terminal.find("contracts/route/removed [").unwrap();
    assert!(risks < route && route < security);
    insta::assert_snapshot!("council_200", terminal);
    insta::assert_snapshot!("council_markdown", markdown);
    let json: serde_json::Value = serde_json::from_slice(&render_json(&report).unwrap()).unwrap();
    assert_eq!(json["council"]["councilled"], 4);
    assert_eq!(
        json["council"]["refuted"][0]["council"]["decision"],
        "refuted"
    );
    assert_eq!(json["risks"][0]["council"]["tier"], "experiment");
    assert!(json["findings"][0].get("council").is_none());
    // Without the council step: no section, no footer lines, no JSON object.
    let none = security_run();
    for output in [
        render_terminal(&none, &wide),
        render_markdown(&none, &RenderOptions::default()),
    ] {
        assert!(!output.contains("Council"));
    }
    let json: serde_json::Value = serde_json::from_slice(&render_json(&none).unwrap()).unwrap();
    assert!(json.get("council").is_none());
}

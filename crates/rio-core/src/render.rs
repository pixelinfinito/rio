use std::{cmp::Reverse, sync::LazyLock};

use crate::*;
use serde::Serialize;

pub struct RenderOptions<'a> {
    pub width: usize,
    pub color: bool,
    pub show_pre_existing: bool,
    pub policy: Option<&'a CompiledFailOn>,
}
impl Default for RenderOptions<'_> {
    fn default() -> Self {
        Self {
            width: 80,
            color: false,
            show_pre_existing: false,
            policy: None,
        }
    }
}
impl RenderOptions<'_> {
    pub fn color_enabled(&self) -> bool {
        self.color && std::env::var_os("NO_COLOR").is_none()
    }
}
pub fn label(value: &impl Serialize) -> String {
    serde_json::to_value(value)
        .expect("model serialization")
        .as_str()
        .unwrap_or("")
        .into()
}
pub fn outcome_label(outcome: &CheckOutcome) -> String {
    let value = serde_json::to_value(outcome).expect("outcome serialization");
    match value["reason"].as_str() {
        Some(reason) => format!("{} ({reason})", value["outcome"].as_str().unwrap()),
        None => value["outcome"].as_str().unwrap().into(),
    }
}
fn scrub(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(text) => *text = redact(text),
        serde_json::Value::Array(items) => items.iter_mut().for_each(scrub),
        serde_json::Value::Object(items) => items.values_mut().for_each(scrub),
        _ => {}
    }
}
/// Validate in memory before returning any bytes to the caller.
pub fn render_json(report: &Report) -> Result<Vec<u8>, String> {
    static VALIDATOR: LazyLock<jsonschema::Validator> = LazyLock::new(|| {
        let schema = serde_json::from_str(include_str!("../../../schemas/report-v1.json")).unwrap();
        jsonschema::validator_for(&schema).expect("embedded report schema")
    });
    let mut document = serde_json::to_value(report).map_err(|error| error.to_string())?;
    scrub(&mut document);
    let errors: Vec<_> = VALIDATOR
        .iter_errors(&document)
        .map(|error| error.to_string())
        .collect();
    if !errors.is_empty() {
        return Err(errors.join("\n"));
    }
    let mut output = serde_json::to_vec_pretty(&document).map_err(|error| error.to_string())?;
    output.push(b'\n');
    Ok(output)
}
fn safe(text: &str) -> String {
    redact(text)
        .chars()
        .map(|ch| {
            if ch.is_control() && ch != '\n' {
                ' '
            } else {
                ch
            }
        })
        .collect()
}
fn table(text: &str) -> String {
    safe(text).replace('|', "\\|").replace('\n', "<br>")
}
fn code(text: &str) -> String {
    format!("`{}`", safe(text).replace('`', "\\`"))
}
fn ordered(findings: &[Finding]) -> Vec<&Finding> {
    let mut findings: Vec<_> = findings.iter().collect();
    findings.sort_by_key(|f| {
        (
            f.severity,
            Reverse(f.evidence_level),
            &f.location.path,
            f.location.line_start,
        )
    });
    findings
}
fn visible(finding: &Finding) -> bool {
    !matches!(finding.state, State::PreExisting | State::Fixed)
}
fn statement(report: &Report) -> String {
    let count = report
        .findings
        .iter()
        .filter(|finding| visible(finding))
        .count();
    let risks = report
        .risks
        .iter()
        .filter(|finding| visible(finding))
        .count();
    let mut text = if count == 0 {
        "No findings were produced".into()
    } else {
        format!("{count} finding(s)")
    };
    if risks > 0 {
        text.push_str(&format!("; {risks} risk(s)"));
    }
    if matches!(
        report.status,
        ReportStatus::Incomplete | ReportStatus::Partial
    ) {
        let checks: Vec<_> = report
            .incomplete
            .iter()
            .filter(|c| {
                !matches!(
                    c.outcome,
                    CheckOutcome::Skipped {
                        reason: SkipReason::Disabled | SkipReason::NothingToAudit,
                        ..
                    }
                )
            })
            .map(|c| {
                format!(
                    "{} {}: {}",
                    label(&c.kind),
                    c.root,
                    outcome_label(&c.outcome)
                )
            })
            .collect();
        text.push_str(&format!(
            ". Review {}: {} did not complete",
            label(&report.status),
            checks.join(", ")
        ));
    }
    text.push('.');
    text
}
fn location(location: &Location) -> String {
    let mut text = format!("{}:{}", location.path, location.line_start);
    if !location.symbol_path.is_empty() {
        text.push_str(&format!(" ({})", location.symbol_path));
    }
    text
}
fn footer(report: &Report) -> Vec<String> {
    let mut lines = Vec::new();
    for check in &report.incomplete {
        lines.push(format!(
            "{} {} {}: {}{}",
            label(&check.kind),
            check.root,
            label(&check.version),
            outcome_label(&check.outcome),
            check
                .outcome
                .details()
                .hint
                .as_ref()
                .map(|hint| format!(" — {hint}"))
                .unwrap_or_default()
        ));
    }
    for step in &report.deferred {
        lines.push(format!("{} deferred: no_endpoint", step.step));
    }
    for file in &report.excluded {
        lines.push(format!("{}: {}", file.path, file.reason));
    }
    lines.extend(report.footer.notes.iter().cloned());
    for suppression in &report.footer.suppressions {
        lines.push(format!(
            "Suppression {}: {} finding(s)",
            suppression.entry, suppression.count
        ));
    }
    for (tool, version) in &report.footer.tool_versions {
        lines.push(format!("{tool}: {version}"));
    }
    lines.push(format!("Total: {} ms", report.metrics.wall_time_ms));
    lines
}
fn title(report: &Report) -> String {
    format!(
        "Rio {} — {}",
        report.review.rio_version,
        label(&report.status)
    )
}
fn classification_summary(report: &Report) -> Option<String> {
    let count = report
        .findings
        .iter()
        .chain(&report.risks)
        .filter(|finding| finding.state == State::Unclassified)
        .count();
    let mismatches: Vec<_> = report
        .checks
        .iter()
        .chain(&report.incomplete)
        .filter(|check| {
            matches!(
                check.outcome,
                CheckOutcome::Skipped {
                    reason: SkipReason::DependencyMismatch,
                    ..
                }
            )
        })
        .collect();
    let baseline_failed = report
        .footer
        .notes
        .iter()
        .any(|note| note.contains("baseline_failed"));
    let baseline_disabled = report
        .footer
        .notes
        .iter()
        .any(|note| note.contains("baseline disabled"));
    let (reason, action) = if !mismatches.is_empty() {
        // Trust is appropriate only for unverifiable metadata. Never recommend
        // bypassing a known mismatch; its remedy is a matching installation.
        let unverified_only = mismatches.iter().all(|check| {
            check
                .outcome
                .details()
                .hint
                .as_deref()
                .is_some_and(|hint| hint.contains("set trust_installed_dependencies"))
        });
        (
            "dependency_mismatch",
            if unverified_only {
                "set trust_installed_dependencies"
            } else {
                "install from lockfile"
            },
        )
    } else if baseline_failed {
        (
            "baseline_failed",
            "check base tools; install from base lockfile",
        )
    } else if baseline_disabled {
        ("baseline disabled", "enable baseline in profile")
    } else if count > 0 {
        ("baseline unavailable", "check baseline hint in footer")
    } else {
        return None;
    };
    Some(format!("{count} unclassified: {reason}; {action}."))
}

fn header(report: &Report) -> Vec<String> {
    let h = &report.review;
    let mut lines = vec![format!(
        "Review: {}  Run: {}",
        h.id.as_deref().unwrap_or("—"),
        h.run_id.as_deref().unwrap_or("—")
    )];
    if let Some(mode) = h.mode {
        lines.push(format!(
            "Mode: {}  Base: {}  Head: {}",
            label(&mode),
            h.base.as_deref().unwrap_or("—"),
            h.head.as_deref().unwrap_or("—")
        ));
    }
    if let Some(profile) = &h.profile {
        lines.push(format!(
            "Profile: {profile}  Chain: {}",
            h.chain.as_deref().unwrap_or_default().join(" -> ")
        ));
    }
    if let Some(summary) = classification_summary(report) {
        lines.push(summary);
    }
    lines
}
fn groups<'a>(
    report: &'a Report,
    options: &RenderOptions<'_>,
) -> Vec<(&'static str, Vec<&'a Finding>)> {
    let mut groups = vec![
        (
            "Findings",
            ordered(&report.findings)
                .into_iter()
                .filter(|f| visible(f))
                .collect(),
        ),
        (
            "Risks",
            ordered(&report.risks)
                .into_iter()
                .filter(|f| visible(f))
                .collect(),
        ),
    ];
    if options.show_pre_existing {
        groups.push((
            "Pre-existing findings",
            ordered(&report.findings)
                .into_iter()
                .chain(ordered(&report.risks))
                .filter(|f| f.state == State::PreExisting)
                .collect(),
        ));
    }
    groups
}
pub fn render_markdown(report: &Report, options: &RenderOptions<'_>) -> String {
    if report.status == ReportStatus::NoChanges {
        return "No changes to review\n".into();
    }
    let mut out = format!(
        "# {}\n\n{}\n",
        safe(&title(report)),
        header(report)
            .iter()
            .map(|line| format!("{}  \n", safe(line)))
            .collect::<String>()
    );
    if let Some(error) = &report.error {
        out.push_str(&format!(
            "\n{}: {}\n",
            safe(&error.code),
            safe(&error.message)
        ));
    }
    if !report.checks.is_empty() {
        out.push_str("\n## Deterministic results\n");
        for kind in [
            CheckKind::Typecheck,
            CheckKind::Lint,
            CheckKind::Secrets,
            CheckKind::Coverage,
            CheckKind::Dependencies,
        ] {
            let checks: Vec<_> = report
                .checks
                .iter()
                .filter(|check| check.kind == kind)
                .collect();
            if checks.is_empty() {
                continue;
            }
            out.push_str(&format!("\n### {}\n\n| Root | Language | Version | Scheduled as | Outcome | Time (ms) |\n| --- | --- | --- | --- | --- | ---: |\n", label(&kind)));
            for check in checks {
                out.push_str(&format!(
                    "| {} | {} | {} | {} | {}{} | {} |\n",
                    table(&check.root),
                    table(&check.language),
                    label(&check.version),
                    label(&check.scheduled_as),
                    table(&outcome_label(&check.outcome)),
                    if check.cached { " (cached)" } else { "" },
                    check.wall_time_ms
                ));
            }
        }
    }
    if !report.impact.symbols.is_empty() {
        out.push_str("\n## Impact\n\n");
        for symbol in &report.impact.symbols {
            out.push_str(&format!(
                "- {}: references per hop {:?}; test reference {}; unresolved {}\n",
                code(&format!("{}:{}", symbol.path, symbol.symbol_path)),
                symbol.references_per_hop,
                symbol.test_referenced,
                symbol.unresolved
            ));
        }
    }
    for (name, findings) in groups(report, options) {
        if name != "Findings" && findings.is_empty() {
            continue;
        }
        out.push_str(&format!("\n## {name}\n\n"));
        if name == "Findings" {
            out.push_str(&format!("{}\n\n", safe(&statement(report))));
        }
        for finding in findings {
            let failing = options.policy.is_some_and(|policy| policy.matches(finding));
            out.push_str(&format!(
                "- **{}** [{}; {}; {}]{} — {}\n",
                safe(&finding.rule_id),
                label(&finding.state),
                label(&finding.severity),
                label(&finding.evidence_level),
                if failing { " **FAIL**" } else { "" },
                safe(&finding.message)
            ));
            for loc in finding.locations.iter().filter(|loc| {
                options.show_pre_existing
                    || finding.state != State::Unclassified
                    || loc.occurrence_state != OccurrenceState::PreExisting
            }) {
                out.push_str(&format!(
                    "  - {} [{}]\n",
                    code(&location(loc)),
                    label(&loc.occurrence_state)
                ));
            }
            if !finding.trigger.is_empty() {
                out.push_str(&format!("  - Trigger: {}\n", safe(&finding.trigger)));
            }
            if let Some(fix) = &finding.suggested_fix {
                out.push_str(&format!("  - Suggested fix: {}\n", safe(fix)));
            }
        }
    }
    if report.summary != Summary::default() {
        out.push_str(&format!(
            "\n## Summary\n\nPre-existing: {}; fixed: {}; suppressed: {}.\n",
            report.summary.pre_existing, report.summary.fixed, report.summary.suppressed
        ));
    }
    out.push_str("\n## Footer\n\n");
    for line in footer(report) {
        out.push_str(&format!("- {}\n", safe(&line)));
    }
    out
}
fn fit(line: &str, width: usize) -> String {
    if line.chars().count() <= width {
        line.into()
    } else {
        format!(
            "{}…",
            line.chars()
                .take(width.saturating_sub(1))
                .collect::<String>()
        )
    }
}
pub fn render_terminal(report: &Report, options: &RenderOptions<'_>) -> String {
    if report.status == ReportStatus::NoChanges {
        return "No changes to review\n".into();
    }
    let mut lines = vec![title(report)];
    lines.extend(header(report));
    if let Some(error) = &report.error {
        lines.push(format!("{}: {}", error.code, error.message));
        lines.extend(error.details.iter().cloned());
    }
    if !report.checks.is_empty() {
        lines.push("\nDeterministic results".into());
        for kind in [
            CheckKind::Typecheck,
            CheckKind::Lint,
            CheckKind::Secrets,
            CheckKind::Coverage,
            CheckKind::Dependencies,
        ] {
            for check in report.checks.iter().filter(|check| check.kind == kind) {
                lines.push(format!(
                    "  {} {} ({}, {}, {}): {}{} — {} ms",
                    label(&check.kind),
                    check.root,
                    check.language,
                    label(&check.version),
                    label(&check.scheduled_as),
                    outcome_label(&check.outcome),
                    if check.cached { " cached" } else { "" },
                    check.wall_time_ms
                ));
            }
        }
    }
    if !report.impact.symbols.is_empty() {
        lines.push("\nImpact".into());
        for symbol in &report.impact.symbols {
            lines.push(format!(
                "  {} {}: {:?} references; test {}",
                symbol.path, symbol.symbol_path, symbol.references_per_hop, symbol.test_referenced
            ));
        }
    }
    for (name, findings) in groups(report, options) {
        if name != "Findings" && findings.is_empty() {
            continue;
        }
        lines.push(format!("\n{name}"));
        if name == "Findings" {
            lines.push(statement(report));
        }
        for finding in findings {
            lines.push(format!(
                "  {} [{}; {}; {}]{}",
                finding.rule_id,
                label(&finding.state),
                label(&finding.severity),
                label(&finding.evidence_level),
                if options.policy.is_some_and(|p| p.matches(finding)) {
                    " FAIL"
                } else {
                    ""
                }
            ));
            // Locations get their own lines so messages never wrap paths.
            for loc in finding.locations.iter().filter(|loc| {
                options.show_pre_existing
                    || finding.state != State::Unclassified
                    || loc.occurrence_state != OccurrenceState::PreExisting
            }) {
                lines.push(format!(
                    "    {} [{}]",
                    location(loc),
                    label(&loc.occurrence_state)
                ));
            }
            lines.push(format!("    {}", finding.message));
            if !finding.trigger.is_empty() {
                lines.push(format!("    Trigger: {}", finding.trigger));
            }
            if let Some(fix) = &finding.suggested_fix {
                lines.push(format!("    Suggested fix: {fix}"));
            }
        }
    }
    if report.summary != Summary::default() {
        lines.push(format!(
            "\nSummary: {} pre-existing; {} fixed; {} suppressed",
            report.summary.pre_existing, report.summary.fixed, report.summary.suppressed
        ));
    }
    lines.push("\nFooter".into());
    lines.extend(footer(report));
    let text = lines
        .into_iter()
        .flat_map(|line| {
            safe(&line)
                .split('\n')
                .flat_map(|part| {
                    if part.starts_with("    ") {
                        vec![fit(part, options.width.max(1))]
                    } else {
                        textwrap::wrap(part, options.width.max(1))
                            .into_iter()
                            .map(|line| line.into_owned())
                            .collect()
                    }
                })
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    if options.color_enabled() {
        format!(
            "\x1b[1m{}\x1b[0m{}",
            text.lines().next().unwrap_or(""),
            &text[text.find('\n').unwrap_or(text.len())..]
        )
    } else {
        text
    }
}
/// Live event text is also used on stderr by machine-readable formats.
pub fn render_progress(event: &ReviewEvent) -> Option<String> {
    Some(safe(&match event {
        ReviewEvent::StepStarted { step } => format!("Running {step}…"),
        ReviewEvent::StepFinished { step } => format!("Finished {step}"),
        ReviewEvent::CheckFinished {
            kind,
            root,
            outcome,
            ..
        } => format!("{} {}: {}", label(kind), root, outcome_label(outcome)),
        _ => return None,
    }))
}

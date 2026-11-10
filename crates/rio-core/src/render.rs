use std::{cmp::Reverse, collections::BTreeSet, sync::LazyLock};

use crate::*;
use serde::Serialize;

pub struct RenderOptions<'a> {
    pub width: usize,
    pub color: bool,
    pub show_pre_existing: bool,
    /// `--show-remembered`: list remembered dismissals in their own section.
    pub show_remembered: bool,
    pub policy: Option<&'a CompiledFailOn>,
    /// Finding identities the review's lineage had already posted before this
    /// review. Only consulted for reports that carry `lineage`.
    pub posted: Option<&'a BTreeSet<String>>,
}
impl Default for RenderOptions<'_> {
    fn default() -> Self {
        Self {
            width: 80,
            color: false,
            show_pre_existing: false,
            show_remembered: false,
            policy: None,
            posted: None,
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
    for finding in report
        .findings
        .iter()
        .chain(&report.risks)
        .chain(&report.security)
        .chain(
            report
                .council
                .iter()
                .flat_map(|c| c.refuted.iter().chain(&c.held)),
        )
        .chain(
            report
                .checks
                .iter()
                .flat_map(|c| &c.outcome.details().findings),
        )
    {
        if let Some(v) = &finding.verification
            && (v.voters == 0 || v.agreeing > v.voters || v.blind_match.len() != v.voters as usize)
        {
            return Err("invalid verification counts".into());
        }
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    if let Some(artifacts) = document
        .pointer_mut("/qa/evidence/artifacts")
        .and_then(serde_json::Value::as_array_mut)
    {
        for artifact in artifacts {
            let expired = artifact["expired"] == true
                || artifact["expires_at"]
                    .as_u64()
                    .is_some_and(|at| u128::from(at) <= now);
            let link_expired = artifact["link_expires_at"]
                .as_u64()
                .is_some_and(|at| u128::from(at) <= now);
            if let Some(fields) = artifact.as_object_mut() {
                if expired
                    || link_expired
                    || fields.get("unavailable") == Some(&serde_json::Value::Bool(true))
                {
                    fields.remove("link");
                }
                if expired {
                    fields.insert("expired".into(), serde_json::Value::Bool(true));
                }
            }
        }
    }
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
    // Inline code cannot span a blank line; a newline would end the span and let
    // the remaining text render as live Markdown.
    let text = safe(text).replace('\n', " ");
    let longest = text.split(|ch| ch != '`').map(str::len).max().unwrap_or(0);
    let delimiter = "`".repeat(longest + 1);
    let padding = if text.starts_with('`') || text.ends_with('`') {
        " "
    } else {
        ""
    };
    format!("{delimiter}{padding}{text}{padding}{delimiter}")
}
fn markdown_text(text: &str) -> String {
    let mut output = String::new();
    for ch in safe(text).chars() {
        match ch {
            '&' => output.push_str("&amp;"),
            '<' => output.push_str("&lt;"),
            '>' => output.push_str("&gt;"),
            '\n' => output.push_str("<br>"),
            '\\' | '`' | '*' | '_' | '[' | ']' | '#' | '|' => {
                output.push('\\');
                output.push(ch);
            }
            _ => output.push(ch),
        }
    }
    output
}
fn finding_text(finding: &Finding, text: &str) -> String {
    if matches!(finding.source, Source::Agent { .. }) {
        markdown_text(text)
    } else {
        safe(text)
    }
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
fn item_list(items: &[(&str, &str)]) -> String {
    items
        .iter()
        .map(|(item, title)| format!("{item} {title}"))
        .collect::<Vec<_>>()
        .join("; ")
}
/// The security section's statement: what the catalog run assessed. A run with
/// unassessed items is never presented as a passed security review.
fn security_statement(report: &Report) -> Vec<String> {
    let Some(coverage) = &report.security_coverage else {
        return Vec::new();
    };
    let mut lines = Vec::new();
    if report.security.iter().all(|f| !visible(f)) {
        lines.push("No security finding was produced.".to_string());
    }
    lines.push(format!(
        "Catalog {}: {} assessed, {} unassessed, {} not applicable.",
        label(&coverage.catalog),
        coverage.assessed.len(),
        coverage.unassessed.len(),
        coverage.not_applicable.len()
    ));
    if !coverage.unassessed.is_empty() {
        lines.push(format!(
            "Not a passed security review: {} applicable item(s) were not assessed.",
            coverage.unassessed.len()
        ));
    }
    if !coverage.assessed.is_empty() {
        lines.push(format!(
            "Assessed: {}",
            coverage
                .assessed
                .iter()
                .map(|a| match a.findings.len() {
                    0 => format!("{} {}", a.item, a.title),
                    n => format!("{} {} ({n} finding(s))", a.item, a.title),
                })
                .collect::<Vec<_>>()
                .join("; ")
        ));
    }
    if !coverage.unassessed.is_empty() {
        lines.push(format!(
            "Unassessed: {}",
            coverage
                .unassessed
                .iter()
                .map(|u| format!("{} {} ({})", u.item, u.title, label(&u.reason)))
                .collect::<Vec<_>>()
                .join("; ")
        ));
    }
    if !coverage.not_applicable.is_empty() {
        let items: Vec<_> = coverage
            .not_applicable
            .iter()
            .map(|n| (n.item.as_str(), n.title.as_str()))
            .collect();
        lines.push(format!("Not applicable: {}", item_list(&items)));
    }
    lines
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
                .filter(|hint| !hint.is_empty())
                .map(|hint| format!(" — {hint}"))
                .unwrap_or_default()
        ));
    }
    for step in &report.deferred {
        lines.push(format!("{} deferred: {}", step.step, label(&step.reason)));
    }
    for file in &report.excluded {
        lines.push(format!("{}: {}", file.path, file.reason));
    }
    lines.extend(report.footer.notes.iter().cloned());
    if let Some(qa) = &report.qa {
        lines.extend(qa_footer(qa));
    }
    if let Some(audit) = &report.agent_audit {
        if let Some(pools) = audit["held_back"].as_object() {
            for (pool, titles) in pools {
                if let Some(titles) = titles.as_array().filter(|t| !t.is_empty()) {
                    lines.push(format!(
                        "Held back {} {}: {}. Run --deep or raise max_defects.",
                        titles.len(),
                        pool,
                        titles
                            .iter()
                            .filter_map(|t| t.as_str())
                            .collect::<Vec<_>>()
                            .join("; ")
                    ));
                }
            }
        }
        if let Some(drops) = audit["category_drops"].as_object() {
            for (category, count) in drops {
                lines.push(format!("Dropped by category floor: {category}: {count}"));
            }
        }
        if let Some(usage) = audit.get("verification_usage") {
            lines.push(format!(
                "Verifier usage: {} input tokens, {} output tokens; cost USD {}",
                usage["input_tokens"], usage["output_tokens"], usage["cost_usd"]
            ));
        }
        if AuditSignals::of(report)
            .ok()
            .flatten()
            .is_some_and(|audit| audit.policy_failed)
        {
            lines.push(
                "Security fail policy matched, including findings held back by presentation caps."
                    .into(),
            );
        }
    }
    if let Some(coverage) = &report.security_coverage {
        let assessed: Vec<_> = coverage.assessed.iter().map(|a| a.item.as_str()).collect();
        let mut line = format!(
            "Security catalog {}: {} item(s) assessed{}",
            label(&coverage.catalog),
            assessed.len(),
            if assessed.is_empty() {
                String::new()
            } else {
                format!(" ({})", assessed.join(", "))
            }
        );
        if coverage.unassessed.is_empty() {
            line.push_str("; every applicable item was assessed.");
        } else {
            line.push_str(&format!(
                "; {} not assessed: {}.",
                coverage.unassessed.len(),
                coverage
                    .unassessed
                    .iter()
                    .map(|u| format!("{} ({})", u.item, label(&u.reason)))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        lines.push(line);
    }
    lines.extend(remembered_footer(report));
    for proposal in report.suppression_proposals.iter().flatten() {
        lines.push(format!(
            "Suppression proposal {}: {} ({} dismissal(s) since {}); apply with `rio suppressions apply {}`",
            proposal.id,
            proposal_entry(&proposal.entry),
            proposal.evidence_count,
            proposal.since,
            proposal.id
        ));
    }
    if let Some(cache) = report.cache.as_ref().filter(|c| c.lookups > 0) {
        lines.push(format!(
            "Agent cache: {} of {} lookup(s) served from cache (hit rate {}); about {} tokens saved",
            cache.hits,
            cache.lookups,
            cache.hit_rate.map_or_else(|| "n/a".into(), ratio),
            cache.tokens_saved_estimate
        ));
    }
    lines.extend(publication_footer(report));
    lines.extend(council_footer(report));
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
/// The publication outcome (pr-publishing): what reached the pull request.
fn qa_footer(qa: &serde_json::Value) -> Vec<String> {
    let text = |value: &serde_json::Value| value.as_str().unwrap_or("unknown").to_owned();
    let audit = &qa["audit"];
    let mut lines: Vec<_> = audit["notes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|note| note.as_str().map(str::to_owned))
        .collect();
    lines.push(format!(
        "QA harness: {} ({}); isolation: {}; egress: {}.",
        text(&qa["harness"]),
        text(&audit["harness_auth"]),
        text(&qa["isolation"]),
        text(&audit["egress"])
    ));
    lines.push(format!(
        "QA seed: {} ({:.1} s); fingerprint: {}.",
        text(&qa["seed"]["status"]),
        qa["seed"]["duration_ms"].as_u64().unwrap_or(0) as f64 / 1000.0,
        text(&qa["seed"]["fingerprint"])
    ));
    let quota = audit["quota_bytes"]
        .as_u64()
        .map(|bytes| bytes.to_string())
        .unwrap_or_else(|| "unknown".into());
    lines.push(format!(
        "QA evidence: {}; {} bytes; quota: {} bytes{}; expiry: {}.",
        text(&qa["evidence"]["storage"]),
        qa["evidence"]["bytes"].as_u64().unwrap_or(0),
        quota,
        if audit["quota_reached"] == true {
            " (reached)"
        } else {
            ""
        },
        qa["evidence"]["expires_at"]
            .as_str()
            .unwrap_or(if qa["evidence"]["storage"] == "local" {
                "with run-record pruning"
            } else {
                "unknown"
            })
    ));
    let tokens = qa["cost"]["tokens"]
        .as_u64()
        .map(|tokens| tokens.to_string())
        .unwrap_or_else(|| {
            if audit["harness_auth"] == "subscription" {
                "unmetered (subscription)".into()
            } else {
                "unknown".into()
            }
        });
    let cost = qa["cost"]["usd"]
        .as_f64()
        .map(|usd| format!("${usd:.6}"))
        .unwrap_or_else(|| "unknown".into());
    lines.push(format!(
        "QA wall time: {:.1} s; tokens: {tokens}; cost: {cost}.",
        qa["cost"]["wall_time_ms"].as_u64().unwrap_or(0) as f64 / 1000.0
    ));
    lines
}

/// Councilled findings in the council's selection order, refuted ones included.
fn councilled(report: &Report) -> Vec<&Finding> {
    let Some(council) = &report.council else {
        return Vec::new();
    };
    let all: Vec<&Finding> = report
        .findings
        .iter()
        .chain(&report.risks)
        .chain(&report.security)
        .chain(&report.remembered)
        .chain(&council.refuted)
        .chain(&council.held)
        .filter(|f| f.council.is_some())
        .collect();
    let mut ordered: Vec<&Finding> = council
        .findings
        .iter()
        .filter_map(|cost| all.iter().find(|f| f.id == cost.id).copied())
        .collect();
    for finding in all {
        if !ordered.iter().any(|f| f.id == finding.id) {
            ordered.push(finding);
        }
    }
    ordered
}

fn marker(review: &CouncilReview) -> String {
    format!(
        "{} ({}/{})",
        if review.skipped {
            "skipped"
        } else if review.partial {
            "partial"
        } else {
            "complete"
        },
        review.answered,
        review.total
    )
}

fn denied_by(list: &str) -> &str {
    match list {
        "profile" => "the profile's vendors_allowed",
        "repository" => "the repository allowlist",
        "runner" => "no runner model endpoint",
        other => other,
    }
}

/// The council section: per councilled finding a heading and its details.
fn council_section(report: &Report) -> Vec<(String, Vec<String>)> {
    councilled(report)
        .into_iter()
        .map(|finding| {
            let review = finding.council.as_ref().unwrap();
            let heading = format!(
                "{} at {} — {}",
                finding.rule_id,
                location(&finding.location),
                match (&review.decision, &review.tier) {
                    (Some(decision), Some(tier)) if !review.skipped =>
                        format!("{} (tier {})", label(decision), label(tier)),
                    _ => "no decision; the verifier result stands".into(),
                }
            );
            let mut lines = vec![format!(
                "Council: {}; evidence {}",
                marker(review),
                label(&finding.evidence_level)
            )];
            if report
                .council
                .as_ref()
                .is_some_and(|c| c.held.iter().any(|f| f.id == finding.id))
            {
                lines.push(
                    "Not in the findings lists: below the profile's presentation floors or caps"
                        .into(),
                );
            }
            let answered: Vec<_> = review
                .members
                .iter()
                .filter(|m| !m.abstained)
                .map(|m| m.role.as_str())
                .collect();
            let abstained: Vec<_> = review
                .members
                .iter()
                .filter(|m| m.abstained)
                .map(|m| match &m.cause {
                    Some(cause) => format!("{} ({})", m.role, cause.replace('_', " ")),
                    None => m.role.clone(),
                })
                .collect();
            lines.push(format!(
                "Members: {}{}",
                if answered.is_empty() {
                    "none answered".to_string()
                } else {
                    answered.join(", ")
                },
                if abstained.is_empty() {
                    String::new()
                } else {
                    format!("; abstained: {}", abstained.join(", "))
                }
            ));
            if review.experiments.is_empty() {
                lines.push("Experiments: none requested".into());
            }
            for experiment in &review.experiments {
                let command = experiment.command.join(" ");
                lines.push(if experiment.run {
                    let outcome = experiment
                        .outcome
                        .as_ref()
                        .map(|o| {
                            [("base", &o.base), ("head", &o.head)]
                                .into_iter()
                                .filter_map(|(v, r)| r.as_ref().map(|r| format!("{r} on {v}")))
                                .collect::<Vec<_>>()
                                .join(", ")
                        })
                        .unwrap_or_default();
                    format!(
                        "Experiment {}: `{command}` on {}: {outcome}",
                        experiment.artifact.as_deref().unwrap_or("-"),
                        experiment.version
                    )
                } else {
                    format!(
                        "Experiment `{command}` on {} not run: {}",
                        experiment.version,
                        match experiment.reason.as_deref() {
                            Some("fork") => "fork pull request",
                            Some("cap") => "max_experiments reached",
                            Some(other) => other,
                            None => "not selected",
                        }
                    )
                });
            }
            if let Some(protection) = &review.protection {
                lines.push(format!("Protection cited: {protection}"));
            }
            if let Some(note) = &review.note {
                lines.push(format!("Note: {note}"));
            }
            if review.static_only {
                lines.push(
                    "Static-only: fork pull request; no runnable artifacts and no experiments"
                        .into(),
                );
            }
            match &review.author_family {
                Some(rule) if rule.status == "not_applicable" => lines.push(
                    "Author-family rule: not applicable (no agent attribution in pull request metadata)"
                        .into(),
                ),
                Some(rule) => {
                    let mut parts = Vec::new();
                    for s in &rule.substituted {
                        parts.push(format!("{} served by {} ({})", s.role, s.vendor, s.family));
                    }
                    for role in &rule.dropped {
                        parts.push(format!("{role} dropped"));
                    }
                    lines.push(format!(
                        "Author-family rule: applied for {}{}",
                        rule.family.as_deref().unwrap_or("unknown"),
                        if parts.is_empty() {
                            String::new()
                        } else {
                            format!("; {}", parts.join("; "))
                        }
                    ));
                }
                None => {}
            }
            for exclusion in &review.excluded {
                lines.push(format!(
                    "Excluded: {} ({}), denied by {}",
                    exclusion.vendor,
                    exclusion.role,
                    denied_by(&exclusion.denied_by)
                ));
            }
            (heading, lines)
        })
        .collect()
}

fn cost_text(cost: &CouncilCost) -> String {
    let tokens = if cost.tokens.is_empty() {
        "no tokens".to_string()
    } else {
        cost.tokens
            .iter()
            .map(|(vendor, n)| format!("{vendor} {n}"))
            .collect::<Vec<_>>()
            .join(", ")
    };
    format!(
        "{} members × {} rounds × {} experiments; tokens {tokens}; runner {} s",
        cost.members, cost.rounds, cost.experiments, cost.runner_seconds
    )
}

/// Footer lines when the council step ran; none otherwise.
fn council_footer(report: &Report) -> Vec<String> {
    let Some(council) = &report.council else {
        return Vec::new();
    };
    let mut lines = vec![format!(
        "Council: {} councilled; {} selected not councilled because of max_findings",
        council.councilled, council.not_councilled
    )];
    let findings = councilled(report);
    for cost in &council.findings {
        let name = findings
            .iter()
            .find(|f| f.id == cost.id)
            .map(|f| format!("{} at {}", f.rule_id, location(&f.location)))
            .unwrap_or_else(|| cost.id.chars().take(12).collect());
        if cost.status != "complete" {
            lines.push(format!(
                "council: {} ({}/{}) for {name}",
                cost.status, cost.answered, cost.total
            ));
        }
        lines.push(format!(
            "Council cost for {name}: {}",
            cost_text(&cost.cost)
        ));
    }
    lines.push(format!("Council total: {}", cost_text(&council.total)));
    lines
}

fn publication_footer(report: &Report) -> Vec<String> {
    let Some(p) = &report.publication else {
        return Vec::new();
    };
    let mut lines = Vec::new();
    match p.reason {
        Some(UnpublishedReason::PolicyNever) => lines.push(format!(
            "Publication ({}): nothing published; the profile's publish policy is never",
            label(&p.policy)
        )),
        Some(UnpublishedReason::AskWithoutConsent) => lines.push(format!(
            "Publication ({}): {}; comments require `publish: auto` or `rio review --pr <n> --publish`",
            label(&p.policy),
            if p.check_run_url.is_some() {
                "check run only"
            } else {
                "nothing published without consent"
            }
        )),
        Some(UnpublishedReason::ForkNotEscalated) => lines.push(format!(
            "Publication ({}): nothing published; a fork pull request needs a maintainer `/rio review`",
            label(&p.policy)
        )),
        Some(UnpublishedReason::NoInstallation) => lines.push(format!(
            "Publication ({}): nothing published; no GitHub App installation covers the repository",
            label(&p.policy)
        )),
        None => lines.push(format!(
            "Publication ({}): {} posted, {} edited, {} resolved, {} unanchored (in the summary), {} failed",
            label(&p.policy),
            p.posted,
            p.edited,
            p.resolved,
            p.unanchored,
            p.failed
        )),
    }
    for failure in &p.failures {
        lines.push(format!(
            "Publication failed for {} {}: {}; retried on the next round",
            label(&failure.kind),
            failure.id,
            failure.error
        ));
    }
    lines
}
fn proposal_entry(entry: &ProposalEntry) -> String {
    match entry {
        ProposalEntry::Rule { rule } => format!("rule {rule}"),
        ProposalEntry::Path { path } => format!("path {path}"),
    }
}
/// Where and why a remembered finding was dismissed: `intentional in github.com/o/r#41`.
fn remembered_reason(finding: &Finding) -> String {
    let history = finding.history.as_ref();
    let reason = history
        .and_then(|h| h.previous_response.as_ref())
        .map_or("dismissed", |r| r.reason.as_str());
    match history.and_then(|h| h.dismissed_in.as_deref()) {
        Some(origin) => format!("{reason} in {origin}"),
        None => reason.to_owned(),
    }
}
/// The remembered count by reason and origin; the findings themselves are
/// listed only with `--show-remembered`.
fn remembered_footer(report: &Report) -> Vec<String> {
    if report.remembered.is_empty() {
        return Vec::new();
    }
    let mut groups: Vec<(String, usize)> = Vec::new();
    for finding in &report.remembered {
        let key = remembered_reason(finding);
        match groups.iter_mut().find(|(k, _)| *k == key) {
            Some((_, count)) => *count += 1,
            None => groups.push((key, 1)),
        }
    }
    vec![format!(
        "Remembered: {} finding(s) dismissed earlier on unchanged code and not re-reported ({}); run with --show-remembered to list them",
        report.remembered.len(),
        groups
            .iter()
            .map(|(key, count)| format!("{count} {key}"))
            .collect::<Vec<_>>()
            .join("; ")
    )]
}
/// The finding's earlier registry record: recurrence, earlier answer, regression.
fn history_line(finding: &Finding) -> Option<String> {
    let history = finding.history.as_ref()?;
    let mut parts = vec![format!(
        "seen in {} earlier review(s) since {}, last {}",
        history.seen_count, history.first_seen, history.last_seen
    )];
    if history.previous_status == LifecycleStatus::Fixed {
        parts.push(format!(
            "regression of a finding fixed in {}",
            history.fixed_in.as_deref().unwrap_or(&history.last_seen)
        ));
    } else {
        parts.push(format!("previously {}", label(&history.previous_status)));
    }
    if let Some(response) = &history.previous_response {
        parts.push(format!(
            "answered {} by {}{}{}",
            response.reason.as_str(),
            response.actor,
            response
                .note
                .as_ref()
                .map(|note| format!(" ({note})"))
                .unwrap_or_default(),
            history
                .dismissed_in
                .as_ref()
                .map(|origin| format!(" in {origin}"))
                .unwrap_or_default()
        ));
    }
    Some(format!("History: {}", parts.join("; ")))
}
fn ratio(value: Ratio) -> String {
    let text = format!("{:.2}", value.get());
    text.trim_end_matches('0').trim_end_matches('.').into()
}
/// Footer lines for lineage reviews; empty without a lineage.
fn lineage_footer(report: &Report) -> Vec<String> {
    let Some(lineage) = &report.lineage else {
        return Vec::new();
    };
    let mut lines = vec![format!(
        "Round {} of cap {}{} — {} lineage {}, generation {}",
        lineage.round,
        lineage.cap,
        if lineage.capped {
            " (capped: reconsider)"
        } else {
            ""
        },
        label(&lineage.kind),
        lineage.reference,
        lineage.generation
    )];
    if lineage.diff_only {
        lines.push(format!(
            "Diff-only re-review since {}",
            lineage
                .previous_head
                .as_deref()
                .unwrap_or("the previous head")
        ));
    }
    if let Some(value) = lineage.author_response_ratio {
        lines.push(format!("Author-response ratio: {}", ratio(value)));
    }
    lines.push(format!(
        "Held back as already posted: {}",
        lineage.held_back
    ));
    if let Some(rounds) = lineage.rounds_to_pass {
        lines.push(format!("Rounds to pass: {rounds}"));
    }
    lines
}
/// The capped-round summary: statement, top findings as (title, location), split.
type ReconsiderView<'a> = (String, Vec<(&'a str, String)>, Option<&'a [String]>);
fn reconsider(report: &Report) -> Option<ReconsiderView<'_>> {
    let lineage = report.lineage.as_ref().filter(|l| l.capped)?;
    let reconsider = lineage.reconsider.as_ref()?;
    let split = reconsider
        .split
        .as_deref()
        .filter(|parts| !parts.is_empty());
    Some((
        format!(
            "Round {} exceeds the cap of {}: {} unresolved finding(s). {}",
            lineage.round,
            lineage.cap,
            reconsider.unresolved,
            if split.is_some() {
                "Reconsider the approach or split the change along the parts below."
            } else {
                "Reconsider the approach or split the change."
            }
        ),
        reconsider
            .top
            .iter()
            .map(|item| {
                (
                    item.title.as_str(),
                    format!("{}:{}", item.path, item.line_start),
                )
            })
            .collect(),
        split,
    ))
}
fn already_posted(report: &Report, finding: &Finding, options: &RenderOptions<'_>) -> bool {
    report.lineage.is_some()
        && options
            .posted
            .is_some_and(|posted| posted.contains(&finding.id))
}
fn lifecycle(finding: &Finding) -> Option<String> {
    let mut parts = Vec::new();
    if let Some(round) = finding.round {
        parts.push(format!("round {round}"));
    }
    if let Some(status) = finding.status {
        parts.push(format!("status {}", label(&status)));
    }
    if let Some(response) = &finding.author_response {
        parts.push(format!(
            "answered {} by {}{}",
            response.reason.as_str(),
            response.actor,
            response
                .note
                .as_ref()
                .map(|note| format!(" ({note})"))
                .unwrap_or_default()
        ));
    }
    if let Some(resolution) = &finding.resolution {
        if let Some(head) = &resolution.fixed_in {
            parts.push(format!("fixed in {head}"));
        }
        if let Some(note) = &resolution.note {
            parts.push(note.clone());
        }
    }
    if let Some(snapshot) = &finding.first_posted_in {
        parts.push(format!("first posted in {snapshot}"));
    }
    (!parts.is_empty()).then(|| format!("Lineage: {}", parts.join("; ")))
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
        .chain(&report.security)
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
    if let Some(pr) = &h.pull_request {
        lines.push(format!(
            "Pull request: {}#{}  Head: {}  Author: {} ({}){}{}",
            pr.repository,
            pr.number,
            pr.head_sha,
            pr.author.login,
            label(&pr.author.kind),
            if pr.fork { "  Fork" } else { "" },
            pr.agent
                .as_ref()
                .map(|a| format!("  Agent: {} ({})", a.name, label(&a.source)))
                .unwrap_or_default()
        ));
    }
    if let Some(profile) = &h.profile {
        lines.push(format!(
            "Profile: {profile}  Chain: {}",
            h.chain.as_deref().unwrap_or_default().join(" -> ")
        ));
    }
    if let Some(risk) = &report.risk_tier {
        lines.push(format!(
            "Risk tier: {} ({})",
            label(&risk.tier),
            risk.reasons.join("; ")
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
                .filter(|f| visible(f) && (report.qa.is_none() || f.category != Category::Ux))
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
    if !report.security.is_empty() || report.security_coverage.is_some() {
        groups.push((
            "Security",
            ordered(&report.security)
                .into_iter()
                .filter(|f| visible(f))
                .collect(),
        ));
    }
    if options.show_remembered && !report.remembered.is_empty() {
        groups.push(("Remembered findings", ordered(&report.remembered)));
    }
    if options.show_pre_existing {
        groups.push((
            "Pre-existing findings",
            ordered(&report.findings)
                .into_iter()
                .chain(ordered(&report.risks))
                .chain(ordered(&report.security))
                .filter(|f| {
                    f.state == State::PreExisting
                        && (report.qa.is_none() || f.category != Category::Ux)
                })
                .collect(),
        ));
    }
    groups
}
fn qa_evidence_link(qa: &serde_json::Value, id: &str, markdown: bool) -> String {
    let label = if markdown {
        markdown_text(id)
    } else {
        id.to_owned()
    };
    let Some(artifact) = qa["evidence"]["artifacts"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["id"] == id))
    else {
        return label;
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let expires = artifact["expires_at"].as_u64();
    let date = expires
        .and_then(|time| i64::try_from(time).ok())
        .and_then(|time| jiff::Timestamp::from_millisecond(time).ok())
        .map(|time| time.to_string());
    if artifact["expired"] == true || expires.is_some_and(|at| u128::from(at) <= now) {
        return format!(
            "{label} (expired{})",
            date.map(|date| format!(" {date}")).unwrap_or_default()
        );
    }
    if artifact["unavailable"] == true {
        return format!("{label} (unavailable)");
    }
    if artifact["link_expires_at"]
        .as_u64()
        .is_some_and(|at| u128::from(at) <= now)
    {
        return format!("{label} (download link expired; refresh from endpoint)");
    }
    let Some(link) = artifact["link"].as_str() else {
        return label;
    };
    if markdown
        && (link.starts_with("https://")
            || link.starts_with("http://")
            || std::path::Path::new(link).is_absolute())
    {
        let target: String = link
            .chars()
            .map(|character| match character {
                '<' => "%3C".into(),
                '>' => "%3E".into(),
                '\\' => "%5C".into(),
                '|' => "%7C".into(),
                ' ' => "%20".into(),
                '\n' => "%0A".into(),
                '\r' => "%0D".into(),
                c => c.to_string(),
            })
            .collect();
        format!("[{label}](<{target}>)")
    } else if markdown {
        format!("{label} ({})", markdown_text(link))
    } else {
        format!("{label}: {link}")
    }
}

fn render_qa(report: &Report, options: &RenderOptions<'_>, markdown: bool) -> String {
    let Some(qa) = &report.qa else {
        return String::new();
    };
    let text = |value: &serde_json::Value| {
        let raw = value
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| value.to_string());
        if markdown { markdown_text(&raw) } else { raw }
    };
    let rows = |value: &serde_json::Value| value.as_array().cloned().unwrap_or_default();
    let evidence_link = |value: &serde_json::Value| {
        qa_evidence_link(qa, value.as_str().unwrap_or("unknown"), markdown)
    };
    let mut out = if markdown {
        "\n## QA results\n\n"
    } else {
        "\nQA results\n"
    }
    .to_owned();
    for journey in rows(&qa["journeys"]) {
        out.push_str(&format!(
            "{}: {}\n\n",
            text(&journey["name"]),
            text(&journey["outcome"])
        ));
        if markdown {
            out.push_str("| Viewport | Scheme | Outcome | Step | Reason | Evidence |\n| --- | --- | --- | --- | --- | --- |\n");
        }
        for cell in rows(&journey["cells"]) {
            let evidence = rows(&cell["evidence"])
                .iter()
                .map(&evidence_link)
                .collect::<Vec<_>>()
                .join(", ");
            let reason = cell.get("reason").map(text).unwrap_or_default();
            if markdown {
                out.push_str(&format!(
                    "| {} | {} | {} | {} | {} | {} |\n",
                    text(&cell["viewport"]),
                    text(&cell["color_scheme"]),
                    text(&cell["outcome"]),
                    text(&cell["step_reached"]),
                    reason,
                    evidence
                ));
            } else {
                out.push_str(&format!(
                    "  {}/{}: {}; step {}{}\n",
                    text(&cell["viewport"]),
                    text(&cell["color_scheme"]),
                    text(&cell["outcome"]),
                    text(&cell["step_reached"]),
                    if reason.is_empty() {
                        String::new()
                    } else {
                        format!(" ({reason})")
                    }
                ));
                if !evidence.is_empty() {
                    out.push_str(&format!("  Evidence: {evidence}\n"));
                }
            }
        }
        out.push('\n');
    }
    for finding in ordered(&report.findings).into_iter().filter(|finding| {
        finding.category == Category::Ux
            && (visible(finding)
                || (options.show_pre_existing && finding.state == State::PreExisting))
    }) {
        out.push_str(&format!(
            "- {} [{}; {}; {}]: {}\n",
            if markdown {
                markdown_text(&finding.rule_id)
            } else {
                finding.rule_id.clone()
            },
            label(&finding.state),
            label(&finding.severity),
            label(&finding.evidence_level),
            if markdown {
                markdown_text(&finding.message)
            } else {
                finding.message.clone()
            }
        ));
        for occurrence in &finding.locations {
            if let Some(cell) = &occurrence.cell {
                let label = format!(
                    "{}/{}: {}",
                    cell.viewport,
                    cell.color_scheme,
                    location(occurrence)
                );
                out.push_str(&format!(
                    "  {}\n",
                    if markdown {
                        markdown_text(&label)
                    } else {
                        label
                    }
                ));
                if let Some(evidence) = &occurrence.evidence
                    && !evidence.is_empty()
                {
                    out.push_str(&format!(
                        "  Evidence: {}\n",
                        evidence
                            .iter()
                            .map(|id| qa_evidence_link(qa, id, markdown))
                            .collect::<Vec<_>>()
                            .join(", ")
                    ));
                }
            }
        }
    }
    let observations = rows(&qa["observations_unverified"]);
    if !observations.is_empty() {
        out.push_str(if markdown {
            "\n### Unverified observations\n\n"
        } else {
            "\nUnverified observations\n"
        });
        for observation in observations {
            out.push_str(&format!(
                "- {}: {} step {} — expected {}; observed {}. Evidence: {}\n",
                text(&observation["rule_id"]),
                text(&observation["journey"]),
                text(&observation["step"]),
                text(&observation["expected"]),
                text(&observation["observed"]),
                rows(&observation["evidence"])
                    .iter()
                    .map(&evidence_link)
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
    }
    let recommendations = rows(&qa["recommendations"]);
    if !recommendations.is_empty() {
        out.push_str(if markdown {
            "\n### UX recommendations\n\n"
        } else {
            "\nUX recommendations\n"
        });
        for recommendation in recommendations
            .iter()
            .filter(|row| row["verification_status"] != "rejected")
        {
            out.push_str(&format!(
                "- {} [{}; priority {}; confidence {}]\n",
                text(&recommendation["rule_id"]),
                text(&recommendation["verification_status"]),
                text(&recommendation["priority"]),
                text(&recommendation["confidence"])
            ));
            for (label, field) in [
                ("Persona", "persona"),
                ("Goal", "goal"),
                ("Observed friction", "observed_friction"),
                ("Proposed improvement", "proposed_improvement"),
                ("Expected benefit (untested)", "expected_benefit"),
                ("Verification rationale", "rationale"),
            ] {
                out.push_str(&format!("  {label}: {}\n", text(&recommendation[field])));
            }
            out.push_str(&format!(
                "  Journey: {}; steps {}\n",
                text(&recommendation["journey"]),
                rows(&recommendation["steps"])
                    .iter()
                    .map(&text)
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
            if let Some(heuristic) = recommendation["basis"].get("heuristic") {
                out.push_str(&format!(
                    "  Basis: {} ({}) — {}\n",
                    text(&heuristic["source"]),
                    text(&heuristic["version"]),
                    text(&heuristic["reference"])
                ));
            }
            for reference in rows(&recommendation["basis"]["guidance"]) {
                out.push_str(&format!(
                    "  Requirement: {}:{}–{}\n",
                    text(&reference["path"]),
                    text(&reference["start_line"]),
                    text(&reference["end_line"])
                ));
            }
            out.push_str(&format!(
                "  Trade-offs: {}\n  Evidence: {}\n",
                rows(&recommendation["trade_offs"])
                    .iter()
                    .map(&text)
                    .collect::<Vec<_>>()
                    .join("; "),
                rows(&recommendation["evidence"])
                    .iter()
                    .map(&evidence_link)
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
    }
    out.push_str(&format!(
        "\nUX assessment ({})\n",
        text(&qa["rubric_version"])
    ));
    for status in ["assessed", "not_applicable", "not_assessed"] {
        let assessment = rows(&qa["assessment"]);
        out.push_str(&format!(
            "  {status}: {}\n",
            assessment
                .iter()
                .filter(|row| row["status"] == status)
                .count()
        ));
    }
    for assessment in rows(&qa["assessment"])
        .iter()
        .filter(|row| row["status"] != "assessed")
    {
        out.push_str(&format!(
            "  {} / {}: {} ({})\n",
            text(&assessment["journey"]),
            text(&assessment["rule_id"]),
            text(&assessment["status"]),
            text(&assessment["reason"])
        ));
    }
    for guidance in rows(&qa["guidance"]) {
        out.push_str(&format!(
            "  Guidance: {}:{}–{} (hash {})\n",
            text(&guidance["path"]),
            text(&guidance["start_line"]),
            text(&guidance["end_line"]),
            text(&guidance["hash"])
        ));
    }
    out.push_str(&format!(
        "  Recommendations held back: {}; dropped: {}\n",
        text(&qa["recommendations_held_back"]),
        text(&qa["recommendations_dropped"])
    ));
    out
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
    if let Some((statement, top, split)) = reconsider(report) {
        out.push_str(&format!("\n## Reconsider\n\n{}\n\n", safe(&statement)));
        for (title, at) in top {
            out.push_str(&format!("- {} — {}\n", markdown_text(title), code(&at)));
        }
        if let Some(parts) = split {
            out.push_str(&format!(
                "- Proposed split: {}\n",
                parts
                    .iter()
                    .map(|part| markdown_text(part))
                    .collect::<Vec<_>>()
                    .join("; ")
            ));
        }
    }
    let council_markdown = |out: &mut String| {
        let section = council_section(report);
        if section.is_empty() {
            return;
        }
        out.push_str("\n## Council\n\n");
        for (heading, lines) in section {
            out.push_str(&format!("- **{}**\n", markdown_text(&heading)));
            for line in lines {
                out.push_str(&format!("  - {}\n", markdown_text(&line)));
            }
        }
    };
    let mut council_done = false;
    for (name, findings) in groups(report, options) {
        // The council section follows security and precedes everything else.
        if !council_done && !matches!(name, "Findings" | "Risks" | "Security") {
            council_markdown(&mut out);
            council_done = true;
        }
        let coverage = if name == "Security" {
            security_statement(report)
        } else {
            Vec::new()
        };
        if name != "Findings" && findings.is_empty() && coverage.is_empty() {
            continue;
        }
        out.push_str(&format!("\n## {name}\n\n"));
        if name == "Findings" {
            out.push_str(&format!("{}\n\n", safe(&statement(report))));
        }
        for line in &coverage {
            out.push_str(&format!("{}  \n", markdown_text(line)));
        }
        if !coverage.is_empty() {
            out.push('\n');
        }
        for finding in findings {
            // Remembered findings are never evaluated by fail policies.
            let failing = name != "Remembered findings"
                && (options.policy.is_some_and(|policy| policy.matches(finding))
                    || AuditSignals::matches(report, &finding.id));
            out.push_str(&format!(
                "- **{}** [{}; {}; {}]{}{} — {}\n",
                safe(&finding.rule_id),
                label(&finding.state),
                label(&finding.severity),
                label(&finding.evidence_level),
                if failing { " **FAIL**" } else { "" },
                if already_posted(report, finding, options) {
                    " (already posted)"
                } else {
                    ""
                },
                finding_text(
                    finding,
                    &format!(
                        "{}{}",
                        if finding.category == Category::Security
                            && finding.evidence_level == EvidenceLevel::Plausible
                        {
                            "Risk for human judgment: "
                        } else {
                            ""
                        },
                        finding.message
                    )
                )
            ));
            if finding.locations.is_empty() {
                out.push_str(&format!("  - {}\n", code(&location(&finding.location))));
            }
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
            if let Some(v) = &finding.verification {
                out.push_str(&format!(
                    "  - Verification: {}/{} voters; blind: {:?}; split: {}\n",
                    v.agreeing, v.voters, v.blind_match, v.split
                ));
            }
            if name == "Remembered findings" {
                out.push_str(&format!(
                    "  - Remembered: {}\n",
                    markdown_text(&remembered_reason(finding))
                ));
            }
            if let Some(text) = lifecycle(finding) {
                out.push_str(&format!("  - {}\n", markdown_text(&text)));
            }
            if let Some(text) = history_line(finding) {
                out.push_str(&format!("  - {}\n", markdown_text(&text)));
            }
            if !finding.trigger.is_empty() {
                out.push_str(&format!(
                    "  - Trigger: {}\n",
                    finding_text(finding, &finding.trigger)
                ));
            }
            if let Some(fix) = &finding.suggested_fix {
                out.push_str(&format!(
                    "  - Suggested fix: {}\n",
                    finding_text(finding, fix)
                ));
            }
            if matches!(finding.source, Source::Agent { .. }) {
                for artifact in &finding.evidence {
                    out.push_str(&format!("  - Evidence: {}\n", code(artifact)));
                }
            }
        }
    }
    if !council_done {
        council_markdown(&mut out);
    }
    out.push_str(&render_qa(report, options, true));
    if report.summary != Summary::default() {
        out.push_str(&format!(
            "\n## Summary\n\nPre-existing: {}; fixed: {}; suppressed: {}.\n",
            report.summary.pre_existing, report.summary.fixed, report.summary.suppressed
        ));
    }
    out.push_str("\n## Footer\n\n");
    for line in lineage_footer(report) {
        out.push_str(&format!("- {}\n", markdown_text(&line)));
    }
    for line in footer(report) {
        out.push_str(&format!(
            "- {}\n",
            if report.agent_audit.is_some() {
                markdown_text(&line)
            } else {
                safe(&line)
            }
        ));
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
    if let Some((statement, top, split)) = reconsider(report) {
        lines.push("\nReconsider".into());
        lines.push(statement);
        for (title, at) in top {
            lines.push(format!("  {title} — {at}"));
        }
        if let Some(parts) = split {
            lines.push(format!("  Proposed split: {}", parts.join("; ")));
        }
    }
    let council_terminal = |lines: &mut Vec<String>| {
        let section = council_section(report);
        if section.is_empty() {
            return;
        }
        lines.push("\nCouncil".into());
        for (heading, details) in section {
            lines.push(format!("  {heading}"));
            lines.extend(details.into_iter().map(|line| format!("    {line}")));
        }
    };
    let mut council_done = false;
    for (name, findings) in groups(report, options) {
        if !council_done && !matches!(name, "Findings" | "Risks" | "Security") {
            council_terminal(&mut lines);
            council_done = true;
        }
        let coverage = if name == "Security" {
            security_statement(report)
        } else {
            Vec::new()
        };
        if name != "Findings" && findings.is_empty() && coverage.is_empty() {
            continue;
        }
        lines.push(format!("\n{name}"));
        if name == "Findings" {
            lines.push(statement(report));
        }
        lines.extend(coverage);
        for finding in findings {
            lines.push(format!(
                "  {} [{}; {}; {}]{}{}",
                finding.rule_id,
                label(&finding.state),
                label(&finding.severity),
                label(&finding.evidence_level),
                if name != "Remembered findings"
                    && (options.policy.is_some_and(|p| p.matches(finding))
                        || AuditSignals::matches(report, &finding.id))
                {
                    " FAIL"
                } else {
                    ""
                },
                if already_posted(report, finding, options) {
                    " (already posted)"
                } else {
                    ""
                }
            ));
            // Locations get their own lines so messages never wrap paths.
            if finding.locations.is_empty() {
                lines.push(format!("    {}", location(&finding.location)));
            }
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
            lines.push(format!(
                "    {}{}",
                if finding.category == Category::Security
                    && finding.evidence_level == EvidenceLevel::Plausible
                {
                    "Risk for human judgment: "
                } else {
                    ""
                },
                finding.message
            ));
            if let Some(v) = &finding.verification {
                lines.push(format!(
                    "    Verification: {}/{} voters; blind: {:?}; split: {}",
                    v.agreeing, v.voters, v.blind_match, v.split
                ));
            }
            if name == "Remembered findings" {
                lines.push(format!("    Remembered: {}", remembered_reason(finding)));
            }
            if let Some(text) = lifecycle(finding) {
                lines.push(format!("    {text}"));
            }
            if let Some(text) = history_line(finding) {
                lines.push(format!("    {text}"));
            }
            if !finding.trigger.is_empty() {
                lines.push(format!("    Trigger: {}", finding.trigger));
            }
            if let Some(fix) = &finding.suggested_fix {
                lines.push(format!("    Suggested fix: {fix}"));
            }
        }
    }
    if !council_done {
        council_terminal(&mut lines);
    }
    lines.extend(render_qa(report, options, false).lines().map(str::to_owned));
    if report.summary != Summary::default() {
        lines.push(format!(
            "\nSummary: {} pre-existing; {} fixed; {} suppressed",
            report.summary.pre_existing, report.summary.fixed, report.summary.suppressed
        ));
    }
    lines.push("\nFooter".into());
    lines.extend(lineage_footer(report));
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

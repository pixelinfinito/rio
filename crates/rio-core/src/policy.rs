use std::collections::BTreeSet;

use globset::{Glob, GlobBuilder, GlobMatcher};
use serde::{Deserialize, Serialize};

use crate::{
    Category, CheckKind, CheckOutcome, EvidenceLevel, Finding, Report, ReportStatus, SkipReason,
    State, SuppressionCount,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Suppression {
    Path { path: String },
    Rule { rule: String },
    Finding { finding: String },
}

pub enum CompiledSuppression {
    Path(GlobMatcher),
    Rule(GlobMatcher),
    Finding(String),
}

impl Suppression {
    pub fn compile(&self) -> Result<CompiledSuppression, globset::Error> {
        Ok(match self {
            Self::Path { path } => CompiledSuppression::Path(
                GlobBuilder::new(path)
                    .literal_separator(true)
                    .build()?
                    .compile_matcher(),
            ),
            Self::Rule { rule } => CompiledSuppression::Rule(Glob::new(rule)?.compile_matcher()),
            Self::Finding { finding } => CompiledSuppression::Finding(finding.clone()),
        })
    }
}

impl CompiledSuppression {
    pub fn matches(&self, finding: &Finding) -> bool {
        match self {
            Self::Path(glob) => {
                glob.is_match(&finding.location.path)
                    || finding.locations.iter().any(|l| glob.is_match(&l.path))
            }
            Self::Rule(glob) => glob.is_match(&finding.rule_id),
            Self::Finding(id) => finding.id == *id,
        }
    }
}

/// Apply suppressions to every serialized copy of a finding. Attribute a finding
/// to the first matching entry, so overlapping entries do not inflate totals.
pub fn apply_suppressions(
    report: &mut Report,
    suppressions: &[Suppression],
) -> Result<(), globset::Error> {
    let compiled: Vec<_> = suppressions
        .iter()
        .map(Suppression::compile)
        .collect::<Result<_, _>>()?;
    let mut counts = vec![0; compiled.len()];
    let mut suppressed = BTreeSet::new();
    for finding in report
        .findings
        .iter()
        .chain(&report.risks)
        .chain(&report.security)
    {
        if let Some(index) = compiled.iter().position(|s| s.matches(finding))
            && suppressed.insert(finding.id.clone())
        {
            counts[index] += 1;
        }
    }
    report.findings.retain(|f| !suppressed.contains(&f.id));
    report.risks.retain(|f| !suppressed.contains(&f.id));
    report.security.retain(|f| !suppressed.contains(&f.id));
    for check in report.checks.iter_mut().chain(&mut report.incomplete) {
        check
            .outcome
            .details_mut()
            .findings
            .retain(|f| !suppressed.contains(&f.id));
    }
    report.summary.suppressed = suppressed.len();
    report.footer.suppressions = counts
        .into_iter()
        .enumerate()
        .filter_map(|(entry, count)| (count > 0).then_some(SuppressionCount { entry, count }))
        .collect();
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct FailOn {
    pub evidence: EvidenceLevel,
    pub categories: Vec<Category>,
    pub states: Vec<State>,
    pub rules: Vec<String>,
    pub incomplete: bool,
    pub required_checks: Vec<CheckKind>,
}

impl Default for FailOn {
    fn default() -> Self {
        Self {
            evidence: EvidenceLevel::StaticProven,
            categories: vec![Category::Defect],
            states: vec![State::New, State::Worsened],
            rules: Vec::new(),
            incomplete: true,
            required_checks: Vec::new(),
        }
    }
}

pub struct CompiledFailOn {
    policy: FailOn,
    rules: Vec<GlobMatcher>,
}

impl FailOn {
    pub fn compile(&self) -> Result<CompiledFailOn, globset::Error> {
        Ok(CompiledFailOn {
            policy: self.clone(),
            rules: self
                .rules
                .iter()
                .map(|rule| Glob::new(rule).map(|g| g.compile_matcher()))
                .collect::<Result<_, _>>()?,
        })
    }
}

impl CompiledFailOn {
    pub fn matches(&self, finding: &Finding) -> bool {
        if finding.category == Category::Ux
            && (finding.severity == crate::Severity::Info
                || finding.evidence_level == EvidenceLevel::Refuted)
        {
            return false;
        }
        self.rules
            .iter()
            .any(|rule| rule.is_match(&finding.rule_id))
            || (finding.evidence_level >= self.policy.evidence
                && self.policy.categories.contains(&finding.category)
                && self.policy.states.contains(&finding.state))
    }

    pub fn is_incomplete(&self, report: &Report) -> bool {
        self.policy.incomplete
            && (report.status == ReportStatus::Partial
                || AuditSignals::of(report)
                    .ok()
                    .flatten()
                    .is_some_and(|audit| audit.incomplete_votes > 0)
                || report.checks.iter().any(|check| match check.outcome {
                    CheckOutcome::Failed { .. } | CheckOutcome::Cancelled { .. } => true,
                    CheckOutcome::Skipped { .. } => {
                        self.policy.required_checks.contains(&check.kind)
                    }
                    _ => false,
                }))
    }
}

pub fn derive_report_status(report: &mut Report) {
    report.incomplete = report
        .checks
        .iter()
        .filter(|c| {
            matches!(
                c.outcome,
                CheckOutcome::Failed { .. }
                    | CheckOutcome::Skipped { .. }
                    | CheckOutcome::Cancelled { .. }
            )
        })
        .cloned()
        .collect();
    if matches!(
        report.status,
        ReportStatus::Partial | ReportStatus::NoChanges | ReportStatus::Error
    ) {
        return;
    }
    report.status = if report.checks.iter().any(|c| match c.outcome {
        CheckOutcome::Failed { .. } | CheckOutcome::Cancelled { .. } => true,
        CheckOutcome::Skipped { reason, .. } => {
            !matches!(reason, SkipReason::Disabled | SkipReason::NothingToAudit)
        }
        _ => false,
    }) {
        ReportStatus::Incomplete
    } else {
        ReportStatus::Complete
    };
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartError {
    UsageOrConfiguration,
    RepositoryOrInternal,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ExitContext {
    pub error: Option<StartError>,
    pub second_interrupt: bool,
}

/// Precedence: usage/configuration or repository/internal errors, then a second
/// interrupt, policy-matching findings, incomplete required analysis (including
/// partial reports and missing votes, per `fail_on.incomplete`), a failed
/// publication, success.
pub fn exit_code(report: &Report, policy: &CompiledFailOn, context: ExitContext) -> u8 {
    if let Some(error) = context.error {
        return match error {
            StartError::UsageOrConfiguration => 2,
            StartError::RepositoryOrInternal => 3,
        };
    }
    if report.status == ReportStatus::Error {
        return 3;
    }
    if context.second_interrupt {
        return 130;
    }
    if report
        .findings
        .iter()
        .chain(&report.risks)
        .chain(&report.security)
        .any(|f| {
            (f.category != Category::Ux
                || report
                    .agent_audit
                    .as_ref()
                    .is_none_or(|audit| audit.get("qa").is_none()))
                && policy.matches(f)
        })
    {
        return 1;
    }
    let audit = AuditSignals::of(report);
    if audit
        .as_ref()
        .is_ok_and(|audit| audit.as_ref().is_some_and(|a| a.policy_failed))
    {
        return 1;
    }
    // An unreadable verifier outcome could hide a policy failure; never report success.
    if audit.is_err()
        || audit
            .as_ref()
            .is_ok_and(|audit| audit.as_ref().is_some_and(|a| a.qa_incomplete))
        || policy.is_incomplete(report)
    {
        return 4;
    }
    // Publication was attempted and the host rejected part of it; the report stands.
    if report.publication.as_ref().is_some_and(|p| p.failed > 0) {
        return 5;
    }
    0
}

/// Verifier outcomes the endpoint records in `agent_audit`. `policy_failed` and
/// `policy_matches` are always emitted, so their absence is a protocol error rather
/// than a silent pass.
#[derive(Debug, Default, Deserialize)]
pub struct AuditSignals {
    pub policy_failed: bool,
    pub policy_matches: Vec<String>,
    #[serde(default)]
    pub incomplete_votes: u64,
    #[serde(default)]
    pub qa_incomplete: bool,
}
impl AuditSignals {
    pub fn of(report: &Report) -> Result<Option<Self>, serde_json::Error> {
        report
            .agent_audit
            .as_ref()
            .map(Self::deserialize)
            .transpose()
    }
    pub fn matches(report: &Report, id: &str) -> bool {
        Self::of(report)
            .ok()
            .flatten()
            .is_some_and(|audit| audit.policy_matches.iter().any(|m| m == id))
    }
}

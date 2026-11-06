use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::{CheckEntry, CheckKind, Finding, Version};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportStatus {
    Complete,
    Incomplete,
    Partial,
    NoChanges,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReviewMode {
    WorkingTree,
    Staged,
    Branch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewHeader {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<ReviewMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chain: Option<Vec<String>>,
    pub rio_version: String,
}

impl Default for ReviewHeader {
    fn default() -> Self {
        Self {
            id: None,
            run_id: None,
            mode: None,
            base: None,
            head: None,
            profile: None,
            chain: None,
            rio_version: option_env!("RIO_BUILD_VERSION")
                .unwrap_or(env!("CARGO_PKG_VERSION"))
                .into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SymbolImpact {
    pub path: String,
    pub symbol_path: String,
    pub references_per_hop: Vec<usize>,
    pub test_referenced: bool,
    pub unresolved: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImpactSummary {
    pub symbols: Vec<SymbolImpact>,
    pub unresolved: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeferredReason {
    NoEndpoint,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeferredStep {
    pub step: String,
    pub reason: DeferredReason,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExcludedFile {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Summary {
    pub pre_existing: usize,
    pub fixed: usize,
    pub suppressed: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SuppressionCount {
    pub entry: usize,
    pub count: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Footer {
    pub notes: Vec<String>,
    pub suppressions: Vec<SuppressionCount>,
    pub tool_versions: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckMetric {
    pub kind: CheckKind,
    pub root: String,
    pub version: Version,
    pub wall_time_ms: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Metrics {
    pub wall_time_ms: u64,
    pub checks: Vec<CheckMetric>,
    pub tool_versions: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReportError {
    pub code: String,
    pub message: String,
    pub details: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RiskLevel {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RiskSource {
    AlwaysHuman,
    Triage,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RiskTier {
    pub tier: RiskLevel,
    pub reasons: Vec<String>,
    pub source: RiskSource,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Report {
    pub schema: String,
    pub status: ReportStatus,
    pub review: ReviewHeader,
    #[serde(default)]
    pub risk_tier: Option<RiskTier>,
    pub checks: Vec<CheckEntry>,
    pub impact: ImpactSummary,
    pub findings: Vec<Finding>,
    pub risks: Vec<Finding>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub security: Vec<Finding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_audit: Option<serde_json::Value>,
    pub incomplete: Vec<CheckEntry>,
    pub deferred: Vec<DeferredStep>,
    pub excluded: Vec<ExcludedFile>,
    pub summary: Summary,
    pub footer: Footer,
    pub metrics: Metrics,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ReportError>,
}

impl Report {
    pub fn empty(status: ReportStatus) -> Self {
        Self {
            schema: "rio-report-v1".into(),
            status,
            review: ReviewHeader::default(),
            risk_tier: None,
            checks: Vec::new(),
            impact: ImpactSummary::default(),
            findings: Vec::new(),
            risks: Vec::new(),
            security: Vec::new(),
            agent_audit: None,
            incomplete: Vec::new(),
            deferred: Vec::new(),
            excluded: Vec::new(),
            summary: Summary::default(),
            footer: Footer::default(),
            metrics: Metrics::default(),
            error: None,
        }
    }
}

/// Events shared by the local engine and the future SSE transport.
/// The TRD's step started/finished, finding verified and done events use:
/// ```
/// use rio_core::ReviewEvent;
/// assert_eq!(ReviewEvent::SSE_EVENTS, [
///     "step:started", "step:finished", "check:finished", "graph:ready",
///     "finding:verified", "review:done", "review:partial",
/// ]);
/// ```
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "event")]
pub enum ReviewEvent {
    #[serde(rename = "step:started")]
    StepStarted { step: String },
    #[serde(rename = "step:finished")]
    StepFinished { step: String },
    #[serde(rename = "check:finished")]
    CheckFinished {
        kind: CheckKind,
        root: String,
        findings: usize,
        skipped: bool,
        outcome: crate::CheckOutcome,
    },
    #[serde(rename = "graph:ready")]
    GraphReady { impact: ImpactSummary },
    /// Reserved for v0.2; never emitted by local deterministic checks.
    #[serde(rename = "finding:verified")]
    FindingVerified { finding: Box<Finding> },
    #[serde(rename = "review:done")]
    Done { report: Box<Report> },
    #[serde(rename = "review:partial")]
    Partial { report: Box<Report> },
}

impl ReviewEvent {
    pub const SSE_EVENTS: [&'static str; 7] = [
        "step:started",
        "step:finished",
        "check:finished",
        "graph:ready",
        "finding:verified",
        "review:done",
        "review:partial",
    ];
}

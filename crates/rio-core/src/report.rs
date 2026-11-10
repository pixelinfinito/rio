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
    /// PR-mode metadata recorded by the endpoint.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pull_request: Option<PullRequestMeta>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PullRequestMeta {
    pub repository: String,
    pub number: u64,
    pub base_sha: String,
    pub head_sha: String,
    pub author: PullRequestAuthor,
    pub fork: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentAttribution>,
    pub trigger: PublishTrigger,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PullRequestAuthor {
    pub login: String,
    #[serde(rename = "type")]
    pub kind: AuthorKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthorKind {
    User,
    Bot,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentAttribution {
    pub name: String,
    pub source: AgentSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentSource {
    BotAuthor,
    CommitTrailer,
}

/// What started a PR-mode review; publication under `ask` depends on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PublishTrigger {
    Webhook,
    Cli,
    Command,
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
            pull_request: None,
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
    NoRuntime,
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
    /// Browser journeys, evidence-backed recommendations and assessment coverage.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub qa: Option<serde_json::Value>,
    pub incomplete: Vec<CheckEntry>,
    pub deferred: Vec<DeferredStep>,
    pub excluded: Vec<ExcludedFile>,
    pub summary: Summary,
    pub footer: Footer,
    pub metrics: Metrics,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ReportError>,
    /// Present only for reviews that belong to a lineage (PR or `--since-last`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lineage: Option<Lineage>,
    /// Present when a publication step ran.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publication: Option<Publication>,
    /// Agent result cache use; present when the agents step ran.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache: Option<CacheStats>,
    /// Open suppression proposals for the repository.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suppression_proposals: Option<Vec<SuppressionProposal>>,
    /// Findings removed from the main sections as remembered dismissals; each
    /// carries its `history`. Never consulted by fail policies.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub remembered: Vec<Finding>,
    /// Catalog coverage; present when the security step ran.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub security_coverage: Option<SecurityCoverage>,
    /// Council coverage and cost; present only when the council step ran.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub council: Option<CouncilMetrics>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PublishPolicy {
    Never,
    Ask,
    Auto,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Publication {
    pub policy: PublishPolicy,
    pub posted: u32,
    pub edited: u32,
    pub resolved: u32,
    pub failed: u32,
    pub unanchored: u32,
    pub check_run_url: Option<String>,
    pub summary_comment_url: Option<String>,
    /// Why nothing, or only the check run, was published.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<UnpublishedReason>,
    /// Items the host rejected; retried on the next round.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub failures: Vec<PublicationFailure>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnpublishedReason {
    PolicyNever,
    AskWithoutConsent,
    ForkNotEscalated,
    NoInstallation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicationFailure {
    pub id: String,
    pub kind: PublicationKind,
    pub error: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PublicationKind {
    Finding,
    Summary,
    CheckRun,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CacheStats {
    pub lookups: u64,
    pub hits: u64,
    pub hit_rate: Option<Ratio>,
    pub tokens_saved_estimate: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SuppressionProposal {
    pub id: String,
    pub entry: ProposalEntry,
    pub evidence_count: u32,
    pub since: String,
}

/// A proposed profile `suppress` entry: a rule or a directory glob.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ProposalEntry {
    Rule { rule: String },
    Path { path: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SecurityCatalog {
    #[serde(rename = "owasp-top10-2025")]
    OwaspTop10_2025,
    #[serde(rename = "asvs-5.0")]
    Asvs5_0,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnassessedReason {
    Budget,
    NoEvidence,
    ToolsUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AssessedItem {
    pub item: String,
    pub title: String,
    /// Identities of the reported findings that cite the item.
    pub findings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UnassessedItem {
    pub item: String,
    pub title: String,
    pub reason: UnassessedReason,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CatalogItemRef {
    pub item: String,
    pub title: String,
}

/// Which catalog items the security step assessed. A run with unassessed
/// items is never a passed security review.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SecurityCoverage {
    pub catalog: SecurityCatalog,
    pub assessed: Vec<AssessedItem>,
    pub unassessed: Vec<UnassessedItem>,
    pub not_applicable: Vec<CatalogItemRef>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LineageKind {
    Pr,
    Branch,
}

/// A ratio in `[0, 1]`. Finite by construction, so equality is total.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "f64", into = "f64")]
pub struct Ratio(f64);
impl Eq for Ratio {}
impl Ratio {
    pub fn new(value: f64) -> Option<Self> {
        (value.is_finite() && (0.0..=1.0).contains(&value)).then_some(Self(value))
    }
    pub fn get(self) -> f64 {
        self.0
    }
}
impl TryFrom<f64> for Ratio {
    type Error = String;
    fn try_from(value: f64) -> Result<Self, Self::Error> {
        Self::new(value).ok_or_else(|| format!("ratio {value} is outside [0, 1]"))
    }
}
impl From<Ratio> for f64 {
    fn from(value: Ratio) -> Self {
        value.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReconsiderItem {
    pub id: String,
    pub title: String,
    pub path: String,
    pub line_start: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Reconsider {
    pub unresolved: u32,
    pub top: Vec<ReconsiderItem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub split: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Lineage {
    pub repository: String,
    pub kind: LineageKind,
    #[serde(rename = "ref")]
    pub reference: String,
    pub generation: u32,
    pub round: u32,
    pub cap: u32,
    pub capped: bool,
    pub diff_only: bool,
    pub previous_head: Option<String>,
    pub held_back: u32,
    pub rounds_to_pass: Option<u32>,
    pub author_response_ratio: Option<Ratio>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reconsider: Option<Reconsider>,
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
            qa: None,
            incomplete: Vec::new(),
            deferred: Vec::new(),
            excluded: Vec::new(),
            summary: Summary::default(),
            footer: Footer::default(),
            metrics: Metrics::default(),
            error: None,
            lineage: None,
            publication: None,
            cache: None,
            suppression_proposals: None,
            remembered: Vec::new(),
            security_coverage: None,
            council: None,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CouncilMetrics {
    pub councilled: u32,
    pub not_councilled: u32,
    pub findings: Vec<CouncilFindingCost>,
    pub total: CouncilCost,
    /// Councilled findings the council refuted, with the cited protection.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub refuted: Vec<Finding>,
    /// Councilled findings that presentation floors or caps keep out of the
    /// findings lists; never evaluated by fail policies.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub held: Vec<Finding>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CouncilFindingCost {
    pub id: String,
    pub status: String,
    pub answered: u32,
    pub total: u32,
    pub cost: CouncilCost,
}

/// Members × rounds × experiments, with model tokens by vendor and runner seconds.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CouncilCost {
    pub members: u32,
    pub rounds: u32,
    pub experiments: u32,
    pub tokens: std::collections::BTreeMap<String, u64>,
    pub runner_seconds: u64,
}

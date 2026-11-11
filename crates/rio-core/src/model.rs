use serde::{Deserialize, Serialize};

/// Evidence is ordered from weakest to strongest; no numeric confidence is used.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceLevel {
    Refuted,
    Plausible,
    StaticProven,
    Reproduced,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    Defect,
    Risk,
    Security,
    Ux,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
    Info,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum State {
    New,
    Worsened,
    PreExisting,
    Fixed,
    Unclassified,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OccurrenceState {
    New,
    PreExisting,
    Fixed,
    Unclassified,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Location {
    pub path: String,
    pub line_start: u32,
    pub line_end: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<u32>,
    pub symbol_path: String,
    pub occurrence_state: OccurrenceState,
    /// Instance identity when this location belongs to a class-level finding.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cell: Option<QaCell>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct QaCell {
    pub viewport: String,
    pub color_scheme: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QaKind {
    Functional,
    Ux,
    Style,
    Accessibility,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QaAttribution {
    Source,
    Journey,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QaFinding {
    pub journey: String,
    pub step: u32,
    pub kind: QaKind,
    pub route: String,
    pub element_paths: Vec<String>,
    pub attribution: QaAttribution,
    #[serde(default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub measurements: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AdvisorySeverity {
    Critical,
    High,
    Moderate,
    Low,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Advisory {
    pub id: String,
    pub aliases: Vec<String>,
    pub severity: AdvisorySeverity,
    /// "unknown" when the advisory has no applicable fixed version.
    pub fixed_version: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Source {
    Tool {
        tool: String,
        version: String,
    },
    Agent {
        agent: String,
        /// True when the hypotheses were replayed from the agent result cache.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cached: Option<bool>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Finding {
    pub id: String,
    pub rule_id: String,
    pub category: Category,
    pub evidence_level: EvidenceLevel,
    pub severity: Severity,
    pub state: State,
    pub location: Location,
    pub message: String,
    pub trigger: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub impact: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_fix: Option<String>,
    /// Machine-applicable replacement of a line range on the primary file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fix: Option<Fix>,
    pub evidence: Vec<String>,
    pub source: Source,
    pub locations: Vec<Location>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub advisory: Option<Advisory>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verification: Option<Verification>,
    /// Review round within a lineage that produced the finding.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub round: Option<u32>,
    /// Snapshot id of the lineage round that first posted this identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_posted_in: Option<String>,
    /// Lifecycle of a posted lineage finding; independent of regression `state`
    /// and never consulted by `fail_on`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<LifecycleStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolution: Option<Resolution>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_response: Option<AuthorResponse>,
    /// Earlier record of this identity in the repository registry; never
    /// consulted by `state`, `status` or fail policies.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history: Option<FindingHistory>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub qa: Option<QaFinding>,
    /// Present only when the council reviewed the finding.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub council: Option<CouncilReview>,
    /// Security findings only: the cited path from source to sink.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace: Option<SecurityTrace>,
}

/// Inclusive, 1-based line range on the primary location's file in the head
/// version, and the full text that replaces those lines.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Fix {
    pub line_start: u32,
    pub line_end: u32,
    pub replacement: String,
}

impl Fix {
    /// A fix is usable only when its range is ordered and starts at line 1 or later.
    pub fn is_valid(&self) -> bool {
        self.line_start >= 1 && self.line_end >= self.line_start
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FindingHistory {
    pub first_seen: String,
    pub last_seen: String,
    pub seen_count: u32,
    pub previous_status: LifecycleStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_response: Option<AuthorResponse>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dismissed_in: Option<String>,
    /// Review that recorded the identity fixed; a recurrence is a regression.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fixed_in: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LifecycleStatus {
    Open,
    Fixed,
    Dismissed,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Resolution {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fixed_in: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// The only accepted answers to a finding (`finding-feedback`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResponseReason {
    Fixed,
    Wrong,
    Intentional,
    Irrelevant,
    Style,
}
impl ResponseReason {
    pub const ALL: [Self; 5] = [
        Self::Fixed,
        Self::Wrong,
        Self::Intentional,
        Self::Irrelevant,
        Self::Style,
    ];
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fixed => "fixed",
            Self::Wrong => "wrong",
            Self::Intentional => "intentional",
            Self::Irrelevant => "irrelevant",
            Self::Style => "style",
        }
    }
}
impl std::str::FromStr for ResponseReason {
    type Err = String;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|reason| reason.as_str() == value)
            .ok_or_else(|| {
                format!(
                    "unknown reason {value:?}; accepted reasons: {}",
                    Self::ALL.map(Self::as_str).join(", ")
                )
            })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthorResponse {
    pub reason: ResponseReason,
    pub actor: String,
    pub at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckKind {
    Typecheck,
    Lint,
    Secrets,
    Coverage,
    Dependencies,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Version {
    Base,
    Head,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScheduledAs {
    Changed,
    Dependent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DependencyState {
    Verified,
    Trusted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureReason {
    SpawnFailed,
    ToolCrashed,
    ToolConfigError,
    UnparseableOutput,
    OutputLimit,
    DiskFull,
    TestsFailed,
    NetworkError,
    PartialData,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkipReason {
    ToolMissing,
    NoProjectConfig,
    NotSupportedByAdapter,
    Disabled,
    Offline,
    DependencyMismatch,
    NoTests,
    NothingToAudit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CancellationReason {
    Timeout,
    Interrupted,
}

/// Results remain available even when a check fails or is cancelled.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckDetails {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dependency_state: Option<DependencyState>,
    pub findings: Vec<Finding>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "lowercase")]
pub enum CheckOutcome {
    Passed {
        #[serde(flatten)]
        details: CheckDetails,
    },
    Findings {
        #[serde(flatten)]
        details: CheckDetails,
    },
    Failed {
        reason: FailureReason,
        #[serde(flatten)]
        details: CheckDetails,
    },
    Skipped {
        reason: SkipReason,
        #[serde(flatten)]
        details: CheckDetails,
    },
    Cancelled {
        reason: CancellationReason,
        #[serde(flatten)]
        details: CheckDetails,
    },
}

impl CheckOutcome {
    pub fn details(&self) -> &CheckDetails {
        match self {
            Self::Passed { details }
            | Self::Findings { details }
            | Self::Failed { details, .. }
            | Self::Skipped { details, .. }
            | Self::Cancelled { details, .. } => details,
        }
    }

    pub fn details_mut(&mut self) -> &mut CheckDetails {
        match self {
            Self::Passed { details }
            | Self::Findings { details }
            | Self::Failed { details, .. }
            | Self::Skipped { details, .. }
            | Self::Cancelled { details, .. } => details,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckEntry {
    pub kind: CheckKind,
    pub language: String,
    pub root: String,
    pub version: Version,
    pub scheduled_as: ScheduledAs,
    #[serde(flatten)]
    pub outcome: CheckOutcome,
    pub wall_time_ms: u64,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub cached: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BlindMatch {
    Same,
    Related,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "VerificationWire")]
pub struct Verification {
    pub voters: u32,
    pub agreeing: u32,
    pub blind_match: Vec<BlindMatch>,
    pub split: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VerificationWire {
    voters: u32,
    agreeing: u32,
    blind_match: Vec<BlindMatch>,
    split: bool,
}
impl TryFrom<VerificationWire> for Verification {
    type Error = String;
    fn try_from(v: VerificationWire) -> Result<Self, Self::Error> {
        if v.voters == 0 || v.agreeing > v.voters || v.blind_match.len() != v.voters as usize {
            return Err("invalid verification counts or per-voter blind matches".into());
        }
        Ok(Self {
            voters: v.voters,
            agreeing: v.agreeing,
            blind_match: v.blind_match,
            split: v.split,
        })
    }
}

/// The council's review of one finding (`council` in finding-v1). Carries
/// decisions and evidence references, never a numeric confidence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CouncilReview {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision: Option<CouncilDecision>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tier: Option<CouncilTier>,
    pub members: Vec<CouncilMember>,
    pub experiments: Vec<CouncilExperiment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protection: Option<String>,
    pub partial: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub skipped: bool,
    pub answered: u32,
    pub total: u32,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub static_only: bool,
    /// The category member weights were looked up under.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weight_category: Option<Category>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_family: Option<AuthorFamily>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub excluded: Vec<CouncilExclusion>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CouncilDecision {
    Reproduced,
    Refuted,
    Plausible,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CouncilTier {
    Experiment,
    Protection,
    Judgment,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CouncilMember {
    pub role: String,
    pub abstained: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cause: Option<String>,
    /// Model family, for presentation; absent in older council blocks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
    /// The member's answer per round it was asked.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rounds: Vec<CouncilRound>,
}

/// One member's round: its `real` answer, or the cause it abstained.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CouncilRound {
    pub round: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub real: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cause: Option<String>,
    /// Round 2 changed position citing evidence.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub changed: bool,
}

/// A security finding's path from source to sink as the agent cited it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SecurityTrace {
    pub catalog_item: String,
    /// `introduced`, `removed` or `weakened`.
    pub change: String,
    pub steps: Vec<TraceStep>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TraceStep {
    /// `source`, `step` or `sink`.
    pub role: String,
    pub path: String,
    pub line_start: u32,
    /// The change removed this step; its location is in base.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub missing: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CouncilExperiment {
    pub command: Vec<String>,
    pub version: String,
    pub expect: String,
    pub run: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<ExperimentOutcome>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExperimentOutcome {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthorFamily {
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub substituted: Vec<Substitution>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dropped: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Substitution {
    pub role: String,
    pub vendor: String,
    pub family: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CouncilExclusion {
    pub role: String,
    pub vendor: String,
    pub denied_by: String,
}

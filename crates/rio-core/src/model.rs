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
    Tool { tool: String, version: String },
    Agent { agent: String },
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
    pub evidence: Vec<String>,
    pub source: Source,
    pub locations: Vec<Location>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub advisory: Option<Advisory>,
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

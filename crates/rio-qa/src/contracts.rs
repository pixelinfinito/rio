use std::{collections::BTreeMap, sync::LazyLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy)]
pub enum DocumentKind {
    Journey,
    Config,
    Seed,
    Fixtures,
    Replay,
}

impl DocumentKind {
    fn index(self) -> usize {
        self as usize
    }
}

static VALIDATORS: LazyLock<Vec<jsonschema::Validator>> = LazyLock::new(|| {
    [
        include_str!("../../../schemas/journey-v1.json"),
        include_str!("../../../schemas/qa-config-v1.json"),
        include_str!("../../../schemas/qa-seed-v1.json"),
        include_str!("../../../schemas/qa-fixtures-v1.json"),
        include_str!("../../../schemas/qa-replay-v1.json"),
    ]
    .iter()
    .map(|schema| {
        let schema: Value = serde_json::from_str(schema).expect("embedded QA schema is JSON");
        jsonschema::validator_for(&schema).expect("embedded QA schema is valid")
    })
    .collect()
});

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct QaDiagnostic {
    pub source: String,
    pub path: String,
    pub message: String,
}

impl std::fmt::Display for QaDiagnostic {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}:{}: {}", self.source, self.path, self.message)
    }
}

#[derive(Debug, thiserror::Error)]
#[error("QA validation failed: {0}")]
pub struct QaErrors(pub String);

pub fn validate_document(kind: DocumentKind, source: &str, value: &Value) -> Vec<QaDiagnostic> {
    VALIDATORS[kind.index()]
        .iter_errors(value)
        .map(|error| QaDiagnostic {
            source: source.into(),
            path: yaml_path(error.instance_path.as_str()),
            // Validation errors may contain literal credentials; never echo the instance.
            message: match &error.kind {
                jsonschema::error::ValidationErrorKind::AdditionalProperties { unexpected } => {
                    format!("unknown keys: {}", unexpected.join(", "))
                }
                jsonschema::error::ValidationErrorKind::Enum { options } => {
                    format!("expected one of {options}")
                }
                _ => format!("does not satisfy schema constraint {}", error.schema_path),
            },
        })
        .collect()
}

fn yaml_path(pointer: &str) -> String {
    let mut result = String::from("$");
    for part in pointer.split('/').skip(1) {
        let part = part.replace("~1", "/").replace("~0", "~");
        if part.parse::<usize>().is_ok() {
            result.push_str(&format!("[{part}]"));
        } else {
            result.push('.');
            result.push_str(&part);
        }
    }
    result
}

pub fn parse_document<T: serde::de::DeserializeOwned>(
    kind: DocumentKind,
    source: &str,
    bytes: &[u8],
) -> Result<T, QaErrors> {
    let value: Value = serde_yaml::from_slice(bytes).map_err(|error| {
        let location = error
            .location()
            .map(|l| format!(" at line {} column {}", l.line(), l.column()))
            .unwrap_or_default();
        QaErrors(format!("{source}: invalid YAML{location}"))
    })?;
    let errors = validate_document(kind, source, &value);
    if !errors.is_empty() {
        return Err(QaErrors(
            errors
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        ));
    }
    serde_json::from_value(value)
        .map_err(|_| QaErrors(format!("{source}: document does not match the QA model")))
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Coverage {
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default)]
    pub routes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JourneyStep {
    #[serde(rename = "do")]
    pub action: String,
    pub at: Option<String>,
    pub hint: Option<String>,
    pub expect: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GuidanceReference {
    pub path: String,
    pub hash: String,
    pub start_line: usize,
    pub end_line: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Context {
    pub time: Option<String>,
    pub timezone: Option<String>,
    pub locale: Option<String>,
    pub geolocation: Option<Geolocation>,
    pub network: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Geolocation {
    pub latitude: f64,
    pub longitude: f64,
    pub accuracy: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Journey {
    pub version: u32,
    pub name: String,
    pub title: String,
    pub persona: String,
    pub tags: Vec<String>,
    pub covers: Coverage,
    pub preconditions: Vec<String>,
    pub steps: Vec<JourneyStep>,
    pub success: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub after: Vec<String>,
    #[serde(default)]
    pub resets: bool,
    pub viewports: Option<Vec<String>>,
    #[serde(default)]
    pub desktop_only: bool,
    pub reason: Option<String>,
    #[serde(default)]
    pub context: Context,
    pub sync_reason: Option<String>,
    pub goal: Option<String>,
    #[serde(default)]
    pub guidance_refs: Vec<GuidanceReference>,
    #[serde(default)]
    pub ux_criteria: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Persona {
    pub name: String,
    pub description: String,
    pub username_env: Option<String>,
    pub password_env: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct App {
    pub packaging: String,
    pub dockerfile: Option<String>,
    pub directory: Option<String>,
    pub start: Option<String>,
    pub url: String,
    pub ready: Value,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    pub seed: Option<String>,
    pub workdir: Option<String>,
    pub routes_from: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ViewportDefinition {
    Preset(String),
    Custom(Viewport),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Viewport {
    pub name: String,
    pub width: u32,
    pub height: u32,
    #[serde(default = "one")]
    pub device_scale_factor: f64,
    pub mobile: bool,
    pub touch: bool,
    pub user_agent: Option<String>,
    pub orientation: Option<String>,
}

fn one() -> f64 {
    1.0
}

impl ViewportDefinition {
    pub fn resolve(&self) -> Result<Viewport, QaErrors> {
        let Self::Preset(name) = self else {
            let Self::Custom(viewport) = self else {
                unreachable!()
            };
            return Ok(viewport.clone());
        };
        let (width, height, mobile, touch, scale) = match name.as_str() {
            "mobile-small" => (320, 568, true, true, 2.0),
            "mobile" => (390, 844, true, true, 3.0),
            "mobile-landscape" => (844, 390, true, true, 3.0),
            "tablet" => (768, 1024, true, true, 2.0),
            "tablet-landscape" => (1024, 768, true, true, 2.0),
            "desktop" => (1440, 900, false, false, 1.0),
            "wide" => (1920, 1080, false, false, 1.0),
            _ => return Err(QaErrors(format!("unknown viewport preset {name}"))),
        };
        Ok(Viewport {
            name: name.clone(),
            width,
            height,
            mobile,
            touch,
            device_scale_factor: scale,
            user_agent: None,
            orientation: Some(
                if width > height {
                    "landscape"
                } else {
                    "portrait"
                }
                .into(),
            ),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Browser {
    pub viewports: Vec<ViewportDefinition>,
    pub color_schemes: Vec<String>,
}

impl Default for Browser {
    fn default() -> Self {
        Self {
            viewports: ["mobile", "desktop"]
                .map(|s| ViewportDefinition::Preset(s.into()))
                .into(),
            color_schemes: vec!["light".into(), "dark".into()],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct HarnessConfig {
    pub default: String,
    pub auth: String,
    pub model: Option<String>,
}
impl Default for HarnessConfig {
    fn default() -> Self {
        Self {
            default: "codex".into(),
            auth: "auto".into(),
            model: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct EvidenceConfig {
    pub video: bool,
    pub retention_days: u64,
}
impl Default for EvidenceConfig {
    fn default() -> Self {
        Self {
            video: false,
            retention_days: 30,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RulesConfig {
    #[serde(default)]
    pub disable: Vec<String>,
    #[serde(default)]
    pub adopt: Vec<String>,
    #[serde(default)]
    pub add: Vec<Value>,
    #[serde(default)]
    pub ignore_console: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SeedConfig {
    pub manifest: String,
    pub migrations: Vec<String>,
    pub max_size: Value,
    pub fallback_rebuild: bool,
    pub cache_version: Value,
}
impl Default for SeedConfig {
    fn default() -> Self {
        Self {
            manifest: ".rio/qa/seed/seed.yaml".into(),
            migrations: vec![],
            max_size: Value::String("2 GiB".into()),
            fallback_rebuild: false,
            cache_version: Value::String("1".into()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QaConfig {
    pub version: u32,
    pub app: App,
    pub personas: Vec<Persona>,
    #[serde(default)]
    pub browser: Browser,
    #[serde(default)]
    pub harness: HarnessConfig,
    #[serde(default)]
    pub rules: RulesConfig,
    #[serde(default)]
    pub evidence: EvidenceConfig,
    #[serde(default)]
    pub seed: SeedConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Datastore {
    pub name: String,
    pub kind: String,
    pub connection_env: Option<String>,
    pub start: Option<String>,
    pub ready: Option<String>,
    pub capture: Option<String>,
    pub restore: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeedStep {
    pub command: Option<String>,
    pub file: Option<String>,
    pub applies_to: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeedUser {
    pub persona: String,
    pub apply: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeedManifest {
    pub version: u32,
    pub datastores: Vec<Datastore>,
    pub steps: Vec<SeedStep>,
    pub users: Vec<SeedUser>,
    pub paths: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UploadFixture {
    pub name: String,
    pub path: Option<String>,
    pub generate: Option<Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceFixture {
    pub name: String,
    pub kind: String,
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub claims: Vec<String>,
    pub recordings: Option<String>,
    #[serde(default)]
    pub behaviors: Vec<String>,
    pub default_behavior: Option<String>,
    pub start: Option<String>,
    pub ready: Option<String>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Captures {
    #[serde(default)]
    pub mail: bool,
    #[serde(default)]
    pub sms: bool,
    #[serde(default)]
    pub webhooks: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FixtureManifest {
    pub version: u32,
    #[serde(default)]
    pub files: Vec<UploadFixture>,
    #[serde(default)]
    pub services: Vec<ServiceFixture>,
    #[serde(default)]
    pub capture: Captures,
    #[serde(default)]
    pub defaults: Context,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplayEvent {
    pub version: u32,
    pub sequence: u64,
    pub journey: String,
    pub step: u32,
    pub cell: Cell,
    pub action: String,
    pub arguments: Value,
}
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Cell {
    pub viewport: String,
    pub color_scheme: String,
}

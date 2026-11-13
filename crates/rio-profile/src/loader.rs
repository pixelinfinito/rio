use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    sync::LazyLock,
    time::Duration,
};

use rio_core::{EvidenceLevel, FailOn, Severity, Suppression};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    Council, Diagnostic, ModuleKind, ProfileErrors, ProfileLoader, ProfileSource, ResolvedMember,
    Rule, configured_vendors, council_status, parse_action, parse_expression, resolve_members,
    resolve_module, yaml_path,
};

/// Review token defaults. A voter's two turns cost tens of thousands of
/// tokens, so its allowance is a fixed amount, not a share of an agent's.
const DEFAULT_TOKENS: u64 = 2_400_000;
const DEFAULT_DEEP_TOKENS: u64 = 4_800_000;
const DEFAULT_VERIFY_TOKENS: u64 = 320_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct BudgetLimit {
    pub wall_time: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agents_max: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verify_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub qa: Option<QaBudget>,
}
impl Default for BudgetLimit {
    fn default() -> Self {
        Self {
            wall_time: "10m".into(),
            tokens: None,
            agents_max: None,
            verify_tokens: None,
            qa: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QaBudget {
    pub wall: String,
    pub cell_wall: String,
    pub tokens: u64,
    pub evidence_bytes: u64,
    pub replay_wall: String,
}

impl QaBudget {
    pub fn defaults(deep: bool) -> Self {
        Self {
            wall: if deep { "90m" } else { "30m" }.into(),
            cell_wall: if deep { "15m" } else { "8m" }.into(),
            tokens: if deep { 300_000 } else { 150_000 },
            evidence_bytes: if deep {
                1024 * 1024 * 1024
            } else {
                512 * 1024 * 1024
            },
            replay_wall: if deep { "10m" } else { "5m" }.into(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Budget {
    pub fast: BudgetLimit,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deep: Option<BudgetLimit>,
}

fn empty_object() -> Value {
    json!({})
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Step {
    pub id: String,
    pub uses: String,
    #[serde(default)]
    pub needs: Vec<String>,
    #[serde(default)]
    pub parallel: bool,
    #[serde(default = "empty_object", rename = "with")]
    pub options: Value,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rules: Vec<Rule>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agents: Vec<BTreeMap<String, Value>>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Publish {
    #[default]
    Never,
    Ask,
    Auto,
}

fn default_evidence() -> EvidenceLevel {
    EvidenceLevel::Plausible
}
fn default_max_lines() -> u64 {
    1500
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Posture {
    CriticalOnly,
    #[default]
    Balanced,
    Thorough,
}

impl Posture {
    fn defaults(self) -> (EvidenceLevel, u64, Severity, bool) {
        match self {
            Self::CriticalOnly => (EvidenceLevel::Reproduced, 3, Severity::Error, false),
            Self::Balanced => (EvidenceLevel::StaticProven, 5, Severity::Warning, true),
            Self::Thorough => (EvidenceLevel::Plausible, 15, Severity::Info, true),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Rounds {
    pub cap: u64,
    pub diff_only_after: u64,
}

impl Default for Rounds {
    fn default() -> Self {
        Self {
            cap: 3,
            diff_only_after: 1,
        }
    }
}

/// Reserved agent policy; deterministic findings never use these limits.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PosturePolicy {
    pub defect_severity_floor: Severity,
    pub render_plausible_risks: bool,
    pub plausible_risk_limit: Option<u64>,
}

fn default_max_defects() -> u64 {
    5
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub version: u32,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extends: Option<String>,
    #[serde(default)]
    pub budget: Budget,
    #[serde(default)]
    pub models: BTreeMap<String, String>,
    #[serde(default)]
    pub steps: Vec<Step>,
    #[serde(default)]
    pub suppress: Vec<Suppression>,
    #[serde(default)]
    pub publish: Publish,
    #[serde(default)]
    pub fail_on: FailOn,
    #[serde(default = "default_evidence")]
    pub min_evidence: EvidenceLevel,
    #[serde(default = "default_max_lines")]
    pub max_lines: u64,
    #[serde(default)]
    pub posture: Posture,
    #[serde(default = "default_max_defects")]
    pub max_defects: u64,
    #[serde(default)]
    pub rounds: Rounds,
    #[serde(default)]
    pub always_human: Vec<String>,
    #[serde(default)]
    pub verify: Verify,
    /// Present when the profile has a council step or a `council` block.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub council: Option<Council>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Verify {
    pub voters: u32,
    pub quorum: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Voters for a hypothesis its agent classed as a risk; `voters` when absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub risk_voters: Option<u32>,
}
impl Default for Verify {
    fn default() -> Self {
        Self {
            voters: 3,
            quorum: 2,
            model: None,
            risk_voters: None,
        }
    }
}

impl Profile {
    pub fn qa_enabled(&self) -> bool {
        self.steps.iter().any(|step| {
            step.uses.split('@').next() == Some("rio/qa")
                && step.options["enabled"].as_bool() == Some(true)
        })
    }

    /// Compose the review deadline while preserving the configured verifier reserve.
    pub fn review_wall(
        &self,
        deep: bool,
        verification_reserve: Duration,
    ) -> Result<Duration, String> {
        let budget = if deep {
            self.budget.deep.as_ref().unwrap_or(&self.budget.fast)
        } else {
            &self.budget.fast
        };
        let wall = parse_duration(&budget.wall_time)?;
        if !self.qa_enabled() {
            return Ok(wall);
        }
        let defaults = QaBudget::defaults(deep);
        let qa = budget.qa.as_ref().unwrap_or(&defaults);
        wall.checked_add(parse_duration(&qa.wall)?)
            .and_then(|wall| wall.checked_add(verification_reserve))
            .ok_or_else(|| "review deadline exceeds supported duration".into())
    }

    pub fn step(&self, module: &str) -> Option<&Step> {
        self.steps
            .iter()
            .find(|step| step.uses.split('@').next() == Some(module))
    }
    /// Whether a step is enabled; steps without an `enabled` option always are.
    pub fn enabled(step: &Step) -> bool {
        step.options.get("enabled").and_then(Value::as_bool) != Some(false)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedProfile {
    #[serde(flatten)]
    pub profile: Profile,
    pub chain: Vec<String>,
    pub modules: BTreeMap<String, String>,
    pub engine_version: String,
    pub posture_policy: PosturePolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub qa_deadlines: Option<BTreeMap<String, QaDeadline>>,
    /// Runtime command selection, outside the repository profile schema.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub qa_standalone: bool,
    /// The council's member modules with the profile's overrides applied.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub council_members: Vec<ResolvedMember>,
    #[serde(skip)]
    pub sources: Vec<ProfileSource>,
    #[serde(skip)]
    pub warnings: Vec<Diagnostic>,
}

pub const QA_VERIFICATION_RESERVE: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QaDeadline {
    pub review_wall_ms: u64,
    pub qa_wall_ms: u64,
    pub verification_reserve_ms: u64,
    pub total_ms: u64,
}

fn qa_deadlines(profile: &Profile) -> Result<Option<BTreeMap<String, QaDeadline>>, ProfileErrors> {
    if !profile.qa_enabled() {
        return Ok(None);
    }
    let mut result = BTreeMap::new();
    for (name, deep) in [("fast", false), ("deep", true)] {
        let budget = if deep {
            profile.budget.deep.as_ref().unwrap_or(&profile.budget.fast)
        } else {
            &profile.budget.fast
        };
        let defaults = QaBudget::defaults(deep);
        let qa = budget.qa.as_ref().unwrap_or(&defaults);
        let durations = (|| -> Result<QaDeadline, String> {
            let millis = |duration: Duration| {
                u64::try_from(duration.as_millis())
                    .map_err(|_| "deadline is out of range".to_string())
            };
            Ok(QaDeadline {
                review_wall_ms: millis(parse_duration(&budget.wall_time)?)?,
                qa_wall_ms: millis(parse_duration(&qa.wall)?)?,
                verification_reserve_ms: millis(QA_VERIFICATION_RESERVE)?,
                total_ms: millis(profile.review_wall(deep, QA_VERIFICATION_RESERVE)?)?,
            })
        })()
        .map_err(|message| {
            ProfileErrors::one(&profile.name, format!("$.budget.{name}.qa"), message)
        })?;
        result.insert(name.into(), durations);
    }
    Ok(Some(result))
}

impl ResolvedProfile {
    pub fn to_yaml(&self) -> Result<String, ProfileErrors> {
        serde_yaml::to_string(self)
            .map_err(|error| ProfileErrors::one(&self.profile.name, "$", error.to_string()))
    }
    pub fn hash(&self) -> Result<String, ProfileErrors> {
        Ok(blake3::hash(self.to_yaml()?.as_bytes())
            .to_hex()
            .to_string())
    }
    pub fn write(&self, path: &Path) -> Result<(), ProfileErrors> {
        std::fs::write(path, self.to_yaml()?)
            .map_err(|error| ProfileErrors::one(path.display().to_string(), "$", error.to_string()))
    }
}

struct Document {
    value: Value,
    chain: Vec<String>,
    sources: Vec<ProfileSource>,
    origins: BTreeMap<String, String>,
}

static SCHEMA: LazyLock<Result<jsonschema::Validator, String>> = LazyLock::new(|| {
    let schema: Value = serde_json::from_str(include_str!("../../../schemas/profile-v1.json"))
        .map_err(|e| e.to_string())?;
    jsonschema::validator_for(&schema).map_err(|e| e.to_string())
});

/// Deep-merge mappings; arrays and scalars are replaced wholesale by the child.
pub fn deep_merge(parent: &mut Value, child: Value) {
    match (parent, child) {
        (Value::Object(parent), Value::Object(child)) => {
            for (key, value) in child {
                deep_merge(parent.entry(key).or_insert(Value::Null), value);
            }
        }
        (parent, child) => *parent = child,
    }
}

pub fn parse_duration(input: &str) -> Result<Duration, String> {
    let unit_at = input
        .find(|c: char| c.is_ascii_alphabetic())
        .ok_or("duration needs a unit (ms, s, m, h, d)")?;
    let value: f64 = input[..unit_at]
        .parse()
        .map_err(|_| "invalid duration number")?;
    let multiplier = match &input[unit_at..] {
        "ms" => 0.001,
        "s" => 1.0,
        "m" => 60.0,
        "h" => 3600.0,
        "d" => 86400.0,
        _ => return Err("unknown duration unit".into()),
    };
    let duration =
        Duration::try_from_secs_f64(value * multiplier).map_err(|_| "duration is out of range")?;
    if duration.is_zero() {
        return Err("budget must be positive".into());
    }
    Ok(duration)
}

fn pointer_component(value: &str) -> String {
    value.replace('~', "~0").replace('/', "~1")
}
fn origins(value: &Value, pointer: &str, source: &str, result: &mut BTreeMap<String, String>) {
    result.insert(pointer.into(), source.into());
    match value {
        Value::Object(map) => {
            for (key, value) in map {
                origins(
                    value,
                    &format!("{pointer}/{}", pointer_component(key)),
                    source,
                    result,
                );
            }
        }
        Value::Array(array) => {
            for (index, value) in array.iter().enumerate() {
                origins(value, &format!("{pointer}/{index}"), source, result);
            }
        }
        _ => {}
    }
}

fn schema_errors(
    validator: &jsonschema::Validator,
    value: &Value,
    source: &str,
    prefix: &str,
) -> Vec<Diagnostic> {
    validator
        .iter_errors(value)
        .flat_map(|error| {
            let pointer = format!("{prefix}{}", error.instance_path);
            match &error.kind {
                jsonschema::error::ValidationErrorKind::AdditionalProperties { unexpected } => {
                    unexpected
                        .iter()
                        .map(|name| Diagnostic {
                            source: source.into(),
                            path: yaml_path(&format!("{pointer}/{}", pointer_component(name))),
                            message: format!("unknown key {name:?}"),
                        })
                        .collect()
                }
                _ => vec![Diagnostic {
                    source: source.into(),
                    path: yaml_path(&pointer),
                    message: if pointer == "/version" {
                        "only profile version 1 is supported".into()
                    } else {
                        error.to_string()
                    },
                }],
            }
        })
        .collect()
}

impl ProfileLoader {
    fn document(
        &self,
        source: ProfileSource,
        stack: &mut Vec<String>,
    ) -> Result<Document, ProfileErrors> {
        let identity = source.identity();
        if let Some(start) = stack.iter().position(|entry| entry == &identity) {
            let mut cycle = stack[start..].to_vec();
            cycle.push(identity);
            return Err(ProfileErrors::one(
                source.label(),
                "$.extends",
                format!("inheritance cycle: {}", cycle.join(" -> ")),
            ));
        }
        let value: Value = serde_yaml::from_str(&source.read()?)
            .map_err(|error| ProfileErrors::one(source.label(), "$", error.to_string()))?;
        let validator = SCHEMA
            .as_ref()
            .map_err(|error| ProfileErrors::one("profile schema", "$", error))?;
        let diagnostics = schema_errors(validator, &value, &source.label(), "");
        if !diagnostics.is_empty() {
            return Err(ProfileErrors { diagnostics });
        }
        stack.push(identity);
        let mut own_origins = BTreeMap::new();
        origins(&value, "", &source.label(), &mut own_origins);
        let mut document = if let Some(parent) = value["extends"].as_str() {
            self.document(self.parent_source(&source, parent)?, stack)?
        } else {
            Document {
                value: json!({}),
                chain: Vec::new(),
                sources: Vec::new(),
                origins: BTreeMap::new(),
            }
        };
        stack.pop();
        document
            .chain
            .insert(0, value["name"].as_str().unwrap().into());
        document.sources.insert(0, source);
        deep_merge(&mut document.value, value);
        document.origins.extend(own_origins);
        Ok(document)
    }

    pub fn load(&self, reference: Option<&str>) -> Result<ResolvedProfile, ProfileErrors> {
        self.load_with_preset(reference, None)
    }
    pub fn load_with_preset(
        &self,
        reference: Option<&str>,
        preset: Option<Posture>,
    ) -> Result<ResolvedProfile, ProfileErrors> {
        let source = self.discover(reference)?;
        let mut document = self.document(source, &mut Vec::new())?;
        document.value.as_object_mut().unwrap().remove("extends");
        if let Some(posture) = preset {
            document.value["posture"] = json!(posture);
        }
        let posture: Posture = serde_json::from_value(
            document
                .value
                .get("posture")
                .cloned()
                .unwrap_or(json!("balanced")),
        )
        .expect("posture was schema validated");
        let (evidence, max_defects, severity_floor, render_risks) = posture.defaults();
        let values = document.value.as_object_mut().unwrap();
        values.entry("min_evidence").or_insert(json!(evidence));
        values.entry("max_defects").or_insert(json!(max_defects));
        let verify = values
            .entry("verify")
            .or_insert(json!({}))
            .as_object_mut()
            .unwrap();
        let voters = verify.entry("voters").or_insert(json!(3)).as_u64().unwrap();
        verify
            .entry("quorum")
            .or_insert(json!(if voters == 1 { 1 } else { 2 }));
        let has_council_step = values
            .get("steps")
            .and_then(Value::as_array)
            .is_some_and(|steps| {
                steps.iter().any(|step| {
                    step["uses"]
                        .as_str()
                        .is_some_and(|uses| uses.split('@').next() == Some("rio/council"))
                })
            });
        if has_council_step || values.contains_key("council") {
            let mut council = Council::defaults();
            deep_merge(&mut council, values.remove("council").unwrap_or(json!({})));
            values.insert("council".into(), council);
        }
        let mut diagnostics = Vec::new();
        let mut warnings = Vec::new();
        let mut modules = BTreeMap::new();
        let source_for = |pointer: &str| {
            let mut pointer = pointer.to_owned();
            loop {
                if let Some(source) = document.origins.get(&pointer) {
                    return source.clone();
                }
                if let Some(last) = pointer.rfind('/') {
                    pointer.truncate(last);
                } else {
                    return document.sources[0].label();
                }
            }
        };
        if let Some(steps) = document
            .value
            .get_mut("steps")
            .and_then(Value::as_array_mut)
        {
            for (index, step) in steps.iter_mut().enumerate() {
                let pointer = format!("/steps/{index}");
                match resolve_module(step["uses"].as_str().unwrap()) {
                    Ok(module) if module.kind == ModuleKind::Step => {
                        modules.insert(module.name.clone(), module.version.clone());
                        let options = step
                            .as_object_mut()
                            .unwrap()
                            .entry("with")
                            .or_insert_with(empty_object);
                        let validator = jsonschema::validator_for(&module.schema).map_err(|e| {
                            ProfileErrors::one(&module.name, "$.schema", e.to_string())
                        })?;
                        diagnostics.extend(schema_errors(
                            &validator,
                            options,
                            &source_for(&format!("{pointer}/with")),
                            &format!("{pointer}/with"),
                        ));
                        if let Some(properties) = module.schema["properties"].as_object() {
                            for (name, schema) in properties {
                                if let Some(default) = schema.get("default") {
                                    options
                                        .as_object_mut()
                                        .unwrap()
                                        .entry(name.clone())
                                        .or_insert_with(|| default.clone());
                                }
                            }
                        }
                        let enabled = options["enabled"].as_bool() != Some(false);
                        step["uses"] = Value::String(format!("{}@{}", module.name, module.version));
                        if !module.local && enabled {
                            warnings.push(Diagnostic {
                                source: source_for(&pointer),
                                path: yaml_path(&pointer),
                                message: format!(
                                    "{} is deferred locally: no_endpoint",
                                    module.name
                                ),
                            });
                        }
                    }
                    Ok(_) => diagnostics.push(Diagnostic {
                        source: source_for(&pointer),
                        path: yaml_path(&format!("{pointer}/uses")),
                        message: "uses must reference a step module".into(),
                    }),
                    Err(error) => diagnostics.push(Diagnostic {
                        source: source_for(&pointer),
                        path: yaml_path(&format!("{pointer}/uses")),
                        message: format!(
                            "step {:?}: {}",
                            step["id"].as_str().unwrap(),
                            error.diagnostics[0].message
                        ),
                    }),
                }
            }
        }
        if !diagnostics.is_empty() {
            return Err(ProfileErrors { diagnostics });
        }
        let qa_enabled = document.value["steps"].as_array().is_some_and(|steps| {
            steps.iter().any(|step| {
                step["uses"]
                    .as_str()
                    .is_some_and(|name| name.starts_with("rio/qa@"))
                    && step["with"]["enabled"].as_bool() == Some(true)
            })
        });
        for (name, deep) in [("fast", false), ("deep", true)] {
            if qa_enabled || document.value["budget"][name].get("qa").is_some() {
                let mut defaults = serde_json::to_value(QaBudget::defaults(deep)).unwrap();
                if let Some(overrides) = document.value["budget"][name].get("qa") {
                    deep_merge(&mut defaults, overrides.clone());
                }
                let mut mode_defaults = if deep {
                    json!({"wall_time":"10m","tokens":DEFAULT_DEEP_TOKENS,"agents_max":5,"verify_tokens":DEFAULT_VERIFY_TOKENS})
                } else {
                    json!({"wall_time":"10m"})
                };
                if document.value["budget"][name].is_object() {
                    deep_merge(&mut mode_defaults, document.value["budget"][name].clone());
                }
                document.value["budget"][name] = mode_defaults;
                document.value["budget"][name]["qa"] = defaults;
            }
        }
        let mut profile: Profile = serde_json::from_value(document.value).map_err(|error| {
            ProfileErrors::one(document.sources[0].label(), "$", error.to_string())
        })?;
        for budget in
            std::iter::once(&mut profile.budget.fast).chain(profile.budget.deep.iter_mut())
        {
            budget.tokens.get_or_insert(DEFAULT_TOKENS);
            budget.agents_max.get_or_insert(3);
            budget.verify_tokens.get_or_insert(DEFAULT_VERIFY_TOKENS);
        }
        for step in &mut profile.steps {
            if step.uses.starts_with("rio/security@") {
                let posture = step.options["posture"].as_str().unwrap_or("thorough");
                let cap = match posture {
                    "critical-only" => 3,
                    "balanced" => 5,
                    _ => 15,
                };
                step.options
                    .as_object_mut()
                    .unwrap()
                    .entry("max_defects")
                    .or_insert(json!(cap));
            }
        }
        if profile.budget.deep.is_none() {
            profile.budget.deep = Some(BudgetLimit {
                wall_time: "10m".into(),
                tokens: Some(DEFAULT_DEEP_TOKENS),
                agents_max: Some(5),
                verify_tokens: Some(DEFAULT_VERIFY_TOKENS),
                qa: None,
            });
        }
        let mut add = |pointer: &str, message: String| {
            diagnostics.push(Diagnostic {
                source: source_for(pointer),
                path: yaml_path(pointer),
                message,
            })
        };
        let alias =
            profile
                .verify
                .model
                .as_deref()
                .unwrap_or(if profile.models.contains_key("verifier") {
                    "verifier"
                } else {
                    "default"
                });
        if profile.verify.quorum > profile.verify.voters {
            add("/verify/quorum", "quorum must not exceed voters".into());
        }
        if profile.verify.model.is_some() && !profile.models.contains_key(alias) {
            add("/verify/model", "unknown model alias".into());
        }
        if profile
            .verify
            .risk_voters
            .is_some_and(|voters| voters > profile.verify.voters)
        {
            add(
                "/verify/risk_voters",
                "risk_voters must not exceed voters".into(),
            );
        }
        if (profile.verify.voters == 1 || profile.verify.risk_voters == Some(1))
            && profile
                .models
                .get("default")
                .is_some_and(|model| profile.models.get(alias) == Some(model))
        {
            add(
                "/models/verifier",
                "verifier alias must differ from the default for one voter".into(),
            );
        }
        if profile.min_evidence < EvidenceLevel::Plausible {
            add(
                "/min_evidence",
                "min_evidence must be at least plausible".into(),
            );
        }
        if profile.rounds.diff_only_after >= profile.rounds.cap {
            add(
                "/rounds/diff_only_after",
                "diff_only_after must be below rounds.cap".into(),
            );
        }
        for (index, pattern) in profile.always_human.iter().enumerate() {
            if let Err(error) = globset::Glob::new(pattern) {
                add(&format!("/always_human/{index}"), error.to_string());
            }
        }
        for (name, budget) in [
            ("fast", Some(&profile.budget.fast)),
            ("deep", profile.budget.deep.as_ref()),
        ] {
            if let Some(budget) = budget
                && let Err(message) = parse_duration(&budget.wall_time)
            {
                add(&format!("/budget/{name}/wall_time"), message);
            }
            if let Some(qa) = budget.and_then(|budget| budget.qa.as_ref()) {
                for (field, value) in [
                    ("wall", &qa.wall),
                    ("cell_wall", &qa.cell_wall),
                    ("replay_wall", &qa.replay_wall),
                ] {
                    if let Err(message) = parse_duration(value) {
                        add(&format!("/budget/{name}/qa/{field}"), message);
                    }
                }
            }
        }
        if let Err(error) = execution_order(&profile.steps) {
            add("/steps", error);
        }
        for (index, step) in profile.steps.iter().enumerate() {
            if step.uses.starts_with("rio/triage@")
                && let Some(patterns) = step.options["sensitive_paths"].as_array()
            {
                for (i, pattern) in patterns.iter().enumerate() {
                    if let Err(error) = globset::Glob::new(pattern.as_str().unwrap()) {
                        add(
                            &format!("/steps/{index}/with/sensitive_paths/{i}"),
                            error.to_string(),
                        );
                    }
                }
            }
            if step.uses.starts_with("rio/security@") || step.uses.starts_with("rio/qa@") {
                let policy: FailOn =
                    serde_json::from_value(step.options["fail_on"].clone()).unwrap_or_default();
                if let Err(error) = policy.compile() {
                    add(&format!("/steps/{index}/with/fail_on"), error.to_string());
                }
            }
            let council_step = step.uses.starts_with("rio/council@");
            for (rule_index, rule) in step.rules.iter().enumerate() {
                let pointer = format!("/steps/{index}/rules/{rule_index}");
                match parse_expression(&rule.when) {
                    Err(error) => add(&format!("{pointer}/when"), error.to_string()),
                    Ok(expression) => {
                        if let Some(predicate) = expression.finding_predicate()
                            && !council_step
                        {
                            add(
                                &format!("{pointer}/when"),
                                format!(
                                    "{predicate} is a predicate allowed only in the council step's rules"
                                ),
                            );
                        }
                    }
                }
                match (&rule.then, council_step) {
                    (Some(_), true) => add(
                        &format!("{pointer}/then"),
                        "council rules select findings and carry no action".into(),
                    ),
                    (None, false) => add(&pointer, "rule needs an action in then".into()),
                    (Some(then), false) => match parse_action(then) {
                        Ok(
                            crate::Action::Disable(ref agent) | crate::Action::Enable(ref agent),
                        ) if matches!(agent.as_str(), "verify" | "verifier" | "rio/verify") => add(
                            &format!("{pointer}/then"),
                            "triage cannot disable or replace verification".into(),
                        ),
                        Ok(_) => {}
                        Err(error) => add(&format!("{pointer}/then"), error.to_string()),
                    },
                    (None, true) => {}
                }
            }
            if council_step
                && !profile.steps.iter().any(|candidate| {
                    candidate.uses.starts_with("rio/verify@")
                        && depends_on(
                            &profile.steps,
                            &step.id,
                            &candidate.id,
                            &mut BTreeSet::new(),
                        )
                })
            {
                add(
                    &format!("/steps/{index}/needs"),
                    "the council step requires the verify step in its needs".into(),
                );
            }
            if (step.uses.starts_with("rio/agents@")
                || step.uses.starts_with("rio/security@")
                || step.uses.starts_with("rio/qa@"))
                && step.options.get("enabled").and_then(Value::as_bool) != Some(false)
                && !profile.steps.iter().any(|candidate| {
                    candidate.uses.starts_with("rio/verify@")
                        && candidate.options.get("enabled").and_then(Value::as_bool) != Some(false)
                        && depends_on(
                            &profile.steps,
                            &candidate.id,
                            &step.id,
                            &mut BTreeSet::new(),
                        )
                })
            {
                add(
                    &format!("/steps/{index}"),
                    "verifier step is mandatory and must depend on every enabled agents, security or QA step".into(),
                );
            }
            if step.uses.starts_with("rio/prepare@")
                && let Some(excludes) = step.options["exclude"].as_array()
            {
                for (glob_index, pattern) in excludes.iter().enumerate() {
                    if let Err(error) = globset::Glob::new(pattern.as_str().unwrap()) {
                        add(
                            &format!("/steps/{index}/with/exclude/{glob_index}"),
                            error.to_string(),
                        );
                    }
                }
            }
        }
        for (index, suppression) in profile.suppress.iter().enumerate() {
            if let Err(error) = suppression.compile() {
                add(&format!("/suppress/{index}"), error.to_string());
            }
        }
        if let Err(error) = profile.fail_on.compile() {
            add("/fail_on/rules", error.to_string());
        }
        let mut council_members = Vec::new();
        if let Some(council) = &profile.council {
            let vendors = configured_vendors(&self.config_dir).unwrap_or_else(|error| {
                warnings.push(Diagnostic {
                    source: self.config_dir.join("config.toml").display().to_string(),
                    path: "$.deployment.council_vendors".into(),
                    message: format!("council allowlist ignored: {error}"),
                });
                Vec::new()
            });
            let enabled = profile.step("rio/council").is_some_and(Profile::enabled);
            match resolve_members(council, &vendors, enabled) {
                Ok(members) => council_members = members,
                Err(errors) => {
                    for (pointer, message) in errors {
                        add(&pointer, message);
                    }
                }
            }
        }
        if !diagnostics.is_empty() {
            return Err(ProfileErrors { diagnostics });
        }
        if let (Some(council), Some(step)) = (&profile.council, profile.step("rio/council"))
            && Profile::enabled(step)
        {
            for message in council_status(council, &council_members) {
                warnings.push(Diagnostic {
                    source: source_for("/council"),
                    path: "$.council".into(),
                    message,
                });
            }
        }
        warnings.push(Diagnostic {
            source: document.sources[0].label(),
            path: "$.posture".into(),
            message: "posture, max_defects and rounds are recorded for deferred agent steps; deterministic findings are never capped".into(),
        });
        let posture_policy = PosturePolicy {
            defect_severity_floor: severity_floor,
            render_plausible_risks: render_risks,
            plausible_risk_limit: match posture {
                Posture::CriticalOnly => Some(0),
                Posture::Balanced => Some(profile.max_defects),
                Posture::Thorough => None,
            },
        };
        let qa_deadlines = qa_deadlines(&profile)?;
        Ok(ResolvedProfile {
            profile,
            chain: document.chain,
            sources: document.sources,
            modules,
            engine_version: env!("CARGO_PKG_VERSION").into(),
            posture_policy,
            qa_deadlines,
            qa_standalone: false,
            council_members,
            warnings,
        })
    }
}

pub fn execution_order(steps: &[Step]) -> Result<Vec<usize>, String> {
    let mut ids = BTreeSet::new();
    for step in steps {
        if !ids.insert(&step.id) {
            return Err(format!("step ids must be unique: {:?}", step.id));
        }
    }
    for step in steps {
        for needed in &step.needs {
            if !ids.contains(needed) {
                return Err(format!("step {:?} needs unknown step {needed:?}", step.id));
            }
        }
    }
    let mut completed = BTreeSet::new();
    let mut order = Vec::new();
    while order.len() < steps.len() {
        let Some((index, step)) = steps.iter().enumerate().find(|(_, step)| {
            !completed.contains(&step.id)
                && step.needs.iter().all(|needed| completed.contains(needed))
        }) else {
            return Err(format!(
                "step dependency cycle: {}",
                steps
                    .iter()
                    .filter(|step| !completed.contains(&step.id))
                    .map(|s| s.id.as_str())
                    .collect::<Vec<_>>()
                    .join(" -> ")
            ));
        };
        completed.insert(&step.id);
        order.push(index);
    }
    Ok(order)
}

fn depends_on(steps: &[Step], from: &str, target: &str, visited: &mut BTreeSet<String>) -> bool {
    if !visited.insert(from.into()) {
        return false;
    }
    steps
        .iter()
        .find(|step| step.id == from)
        .is_some_and(|step| {
            step.needs
                .iter()
                .any(|needed| needed == target || depends_on(steps, needed, target, visited))
        })
}

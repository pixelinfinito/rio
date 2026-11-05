use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    sync::LazyLock,
    time::Duration,
};

use rio_core::{EvidenceLevel, FailOn, Suppression};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    Diagnostic, ModuleKind, ProfileErrors, ProfileLoader, ProfileSource, Rule, parse_action,
    parse_expression, resolve_module, yaml_path,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct BudgetLimit {
    pub wall_time: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agents_max: Option<u64>,
}
impl Default for BudgetLimit {
    fn default() -> Self {
        Self {
            wall_time: "4m".into(),
            tokens: None,
            agents_max: None,
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
}

impl Profile {
    pub fn step(&self, module: &str) -> Option<&Step> {
        self.steps
            .iter()
            .find(|step| step.uses.split('@').next() == Some(module))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedProfile {
    #[serde(flatten)]
    pub profile: Profile,
    pub chain: Vec<String>,
    pub modules: BTreeMap<String, String>,
    pub engine_version: String,
    #[serde(skip)]
    pub sources: Vec<ProfileSource>,
    #[serde(skip)]
    pub warnings: Vec<Diagnostic>,
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
        let source = self.discover(reference)?;
        let mut document = self.document(source, &mut Vec::new())?;
        document.value.as_object_mut().unwrap().remove("extends");
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
        if let Some(steps) = document.value["steps"].as_array_mut() {
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
                        step["uses"] = Value::String(format!("{}@{}", module.name, module.version));
                        if !module.local {
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
        let profile: Profile = serde_json::from_value(document.value).map_err(|error| {
            ProfileErrors::one(document.sources[0].label(), "$", error.to_string())
        })?;
        let mut add = |pointer: &str, message: String| {
            diagnostics.push(Diagnostic {
                source: source_for(pointer),
                path: yaml_path(pointer),
                message,
            })
        };
        if profile
            .models
            .get("default")
            .is_some_and(|default| profile.models.get("verifier") == Some(default))
        {
            add(
                "/models/verifier",
                "verifier alias must differ from the default".into(),
            );
        }
        if profile.min_evidence < EvidenceLevel::Plausible {
            add(
                "/min_evidence",
                "min_evidence must be at least plausible".into(),
            );
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
        }
        if let Err(error) = execution_order(&profile.steps) {
            add("/steps", error);
        }
        for (index, step) in profile.steps.iter().enumerate() {
            for (rule_index, rule) in step.rules.iter().enumerate() {
                if let Err(error) = parse_expression(&rule.when) {
                    add(
                        &format!("/steps/{index}/rules/{rule_index}/when"),
                        error.to_string(),
                    );
                }
                if let Err(error) = parse_action(&rule.then) {
                    add(
                        &format!("/steps/{index}/rules/{rule_index}/then"),
                        error.to_string(),
                    );
                }
            }
            if step.uses.starts_with("rio/agents@")
                && !profile.steps.iter().any(|candidate| {
                    candidate.uses.starts_with("rio/verify@")
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
                    "verifier step is mandatory and must depend on every agents step".into(),
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
        if !diagnostics.is_empty() {
            return Err(ProfileErrors { diagnostics });
        }
        Ok(ResolvedProfile {
            profile,
            chain: document.chain,
            sources: document.sources,
            modules,
            engine_version: env!("CARGO_PKG_VERSION").into(),
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

use std::{collections::BTreeMap, sync::LazyLock};

use include_dir::Dir;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{BUILT_INS, ProfileErrors};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModuleKind {
    Step,
    Adapter,
    Ruleset,
    Member,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModuleManifest {
    pub kind: ModuleKind,
    pub name: String,
    pub version: String,
    pub description: String,
    #[serde(default)]
    pub schema: Value,
    #[serde(default)]
    pub local: bool,
    #[serde(default)]
    pub inputs: Vec<String>,
    #[serde(default)]
    pub outputs: Vec<String>,
    #[serde(default)]
    pub languages: Vec<String>,
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub tools: BTreeMap<String, Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rules: Vec<Value>,
    /// Council member fields (`kind: member`).
    #[serde(flatten, skip_serializing_if = "Option::is_none")]
    pub member: Option<MemberFields>,
}

/// The member-specific manifest fields; `vendor` is derived from `provider`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemberFields {
    pub provider: String,
    pub model: String,
    pub prompt: String,
    pub context_pack: String,
    pub role: String,
    pub weight: f64,
    pub family: String,
    #[serde(default)]
    pub self_hosted: bool,
}

fn collect(
    directory: &Dir<'_>,
    modules: &mut BTreeMap<String, ModuleManifest>,
) -> Result<(), String> {
    for file in directory.files() {
        if file
            .path()
            .file_name()
            .is_some_and(|name| name == "module.yaml")
            || (file.path().starts_with("qa/rules")
                && file
                    .path()
                    .extension()
                    .is_some_and(|extension| extension == "yaml"))
        {
            let value: Value =
                serde_yaml::from_slice(file.contents()).map_err(|error| error.to_string())?;
            if value["kind"] == "member" {
                validate_member_manifest(&value, &file.path().display().to_string())
                    .map_err(|error| error.to_string())?;
            }
            let manifest: ModuleManifest =
                serde_json::from_value(value).map_err(|error| error.to_string())?;
            if manifest.kind == ModuleKind::Ruleset {
                let mut ids = std::collections::BTreeSet::new();
                for rule in &manifest.rules {
                    let id = rule["id"].as_str().ok_or("ruleset rule needs an id")?;
                    if !ids.insert(id) {
                        return Err(format!("duplicate rule id {id} in {}", manifest.name));
                    }
                }
            }
            if modules.insert(manifest.name.clone(), manifest).is_some() {
                return Err("duplicate embedded module name".into());
            }
        }
    }
    for subdirectory in directory.dirs() {
        collect(subdirectory, modules)?;
    }
    Ok(())
}

static MODULE_SCHEMA: LazyLock<Result<jsonschema::Validator, String>> = LazyLock::new(|| {
    let schema: Value = serde_json::from_str(include_str!("../../../schemas/module-v1.json"))
        .map_err(|e| e.to_string())?;
    jsonschema::validator_for(&schema).map_err(|e| e.to_string())
});

const MEMBER_KEYS: [&str; 12] = [
    "kind",
    "name",
    "version",
    "description",
    "provider",
    "model",
    "prompt",
    "context_pack",
    "role",
    "weight",
    "family",
    "self_hosted",
];

/// Validate a `kind: member` manifest against module-v1, naming the offending
/// field and, for enumerations, the accepted values.
pub fn validate_member_manifest(value: &Value, source: &str) -> Result<(), ProfileErrors> {
    let validator = MODULE_SCHEMA
        .as_ref()
        .map_err(|error| ProfileErrors::one("module schema", "$", error))?;
    let mut diagnostics = Vec::new();
    let diagnostic = |pointer: &str, message: String| crate::Diagnostic {
        source: source.into(),
        path: crate::yaml_path(pointer),
        message,
    };
    if let Some(object) = value.as_object() {
        for key in object.keys() {
            if !MEMBER_KEYS.contains(&key.as_str()) {
                diagnostics.push(diagnostic(
                    &format!("/{key}"),
                    format!("unknown key {key:?} in a member manifest"),
                ));
            }
        }
    }
    for (field, accepted) in [
        (
            "role",
            &[
                "skeptic",
                "exploit-author",
                "code-owner",
                "maintainer",
                "tester",
            ][..],
        ),
        (
            "context_pack",
            &["diff-only", "graph-heavy", "execution"][..],
        ),
    ] {
        if let Some(found) = value.get(field)
            && !found
                .as_str()
                .is_some_and(|found| accepted.contains(&found))
        {
            diagnostics.push(diagnostic(
                &format!("/{field}"),
                format!(
                    "{field} {found} is not accepted; accepted values: {}",
                    accepted.join(", ")
                ),
            ));
        }
    }
    if diagnostics.is_empty() {
        for error in validator.iter_errors(value) {
            diagnostics.push(diagnostic(
                &error.instance_path.to_string(),
                error.to_string(),
            ));
        }
    }
    if diagnostics.is_empty() {
        Ok(())
    } else {
        Err(ProfileErrors { diagnostics })
    }
}

static MODULES: LazyLock<Result<BTreeMap<String, ModuleManifest>, String>> = LazyLock::new(|| {
    let mut modules = BTreeMap::new();
    collect(&BUILT_INS, &mut modules)?;
    Ok(modules)
});

pub fn builtin_modules() -> Result<&'static BTreeMap<String, ModuleManifest>, ProfileErrors> {
    MODULES
        .as_ref()
        .map_err(|error| ProfileErrors::one("built-ins", "$", error))
}

pub fn resolve_module(reference: &str) -> Result<&'static ModuleManifest, ProfileErrors> {
    let (name, version) = reference
        .split_once('@')
        .map_or((reference, None), |(name, version)| (name, Some(version)));
    if !name.starts_with("rio/") {
        return Err(ProfileErrors::one(
            reference,
            "$",
            "third-party modules are not supported in this version",
        ));
    }
    let module = builtin_modules()?
        .get(name)
        .ok_or_else(|| ProfileErrors::one(reference, "$", "unknown built-in module"))?;
    if version.is_some_and(|version| version != module.version) {
        return Err(ProfileErrors::one(
            reference,
            "$",
            format!(
                "built-in module version is unavailable; supported version is {}",
                module.version
            ),
        ));
    }
    Ok(module)
}

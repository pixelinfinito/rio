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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModuleManifest {
    pub kind: ModuleKind,
    pub name: String,
    pub version: String,
    pub description: String,
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
        {
            let manifest: ModuleManifest =
                serde_yaml::from_slice(file.contents()).map_err(|error| error.to_string())?;
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

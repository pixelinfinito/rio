use std::{
    fs,
    path::{Path, PathBuf},
};

use include_dir::{Dir, include_dir};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ProfileErrors;

pub static BUILT_INS: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../../modules");

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "path", rename_all = "kebab-case")]
pub enum ProfileSource {
    BuiltIn(String),
    Repo(PathBuf),
    Personal(PathBuf),
    File(PathBuf),
}

impl ProfileSource {
    pub fn label(&self) -> String {
        match self {
            Self::BuiltIn(name) => name.clone(),
            Self::Repo(p) | Self::Personal(p) | Self::File(p) => p.display().to_string(),
        }
    }

    pub fn path(&self) -> Option<&Path> {
        match self {
            Self::BuiltIn(_) => None,
            Self::Repo(p) | Self::Personal(p) | Self::File(p) => Some(p),
        }
    }

    pub fn read(&self) -> Result<String, ProfileErrors> {
        match self {
            Self::BuiltIn(name) => BUILT_INS
                .get_file(format!(
                    "profiles/{}.yaml",
                    name.strip_prefix("rio/").unwrap_or(name)
                ))
                .and_then(|file| file.contents_utf8())
                .map(str::to_owned)
                .ok_or_else(|| ProfileErrors::one(name, "$", "built-in profile not found")),
            Self::Repo(path) | Self::Personal(path) | Self::File(path) => fs::read_to_string(path)
                .map_err(|error| ProfileErrors::one(self.label(), "$", error.to_string())),
        }
    }

    pub(crate) fn identity(&self) -> String {
        match self {
            Self::BuiltIn(name) => format!("builtin:{name}"),
            _ => self.label(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ProfileSummary {
    pub name: String,
    pub source: ProfileSource,
    pub extends: Option<String>,
    pub is_default: bool,
}

pub struct ProfileLoader {
    pub repository_root: Option<PathBuf>,
    pub config_dir: PathBuf,
    pub current_dir: PathBuf,
}

impl ProfileLoader {
    pub fn new(
        repository_root: Option<PathBuf>,
        config_dir: PathBuf,
        current_dir: PathBuf,
    ) -> Self {
        Self {
            repository_root,
            config_dir,
            current_dir,
        }
    }

    pub fn discover(&self, reference: Option<&str>) -> Result<ProfileSource, ProfileErrors> {
        let Some(reference) = reference else {
            if let Some(root) = &self.repository_root {
                let path = root.join(".rio/profiles/default.yaml");
                if path.is_file() {
                    return self.file_source(path);
                }
            }
            let path = self.config_dir.join("profiles/default.yaml");
            if path.is_file() {
                return self.file_source(path);
            }
            return Ok(ProfileSource::BuiltIn("rio/base".into()));
        };
        let path = self.current_dir.join(reference);
        if path.is_file() {
            return self.file_source(path);
        }
        if !reference.starts_with("rio/") {
            if let Some(root) = &self.repository_root {
                let path = root.join(".rio/profiles").join(format!("{reference}.yaml"));
                if path.is_file() {
                    return self.file_source(path);
                }
            }
            let path = self
                .config_dir
                .join("profiles")
                .join(format!("{reference}.yaml"));
            if path.is_file() {
                return self.file_source(path);
            }
        }
        let builtin = reference.strip_prefix("rio/").unwrap_or(reference);
        let (name, version) = builtin
            .split_once('@')
            .map_or((builtin, None), |(name, version)| (name, Some(version)));
        if version.is_none_or(|version| version == env!("CARGO_PKG_VERSION"))
            && BUILT_INS
                .get_file(format!("profiles/{name}.yaml"))
                .is_some()
        {
            return Ok(ProfileSource::BuiltIn(format!("rio/{name}")));
        }
        Err(ProfileErrors::one(
            reference,
            "$",
            "profile not found in the given path, repository, personal directory, or built-ins",
        ))
    }

    pub(crate) fn file_source(&self, path: PathBuf) -> Result<ProfileSource, ProfileErrors> {
        let path = path.canonicalize().map_err(|error| {
            ProfileErrors::one(path.display().to_string(), "$", error.to_string())
        })?;
        if let Some(root) = &self.repository_root
            && root
                .join(".rio/profiles")
                .canonicalize()
                .is_ok_and(|root| path.starts_with(root))
        {
            return Ok(ProfileSource::Repo(path));
        }
        if self
            .config_dir
            .join("profiles")
            .canonicalize()
            .is_ok_and(|root| path.starts_with(root))
        {
            return Ok(ProfileSource::Personal(path));
        }
        Ok(ProfileSource::File(path))
    }

    pub(crate) fn parent_source(
        &self,
        declaring: &ProfileSource,
        reference: &str,
    ) -> Result<ProfileSource, ProfileErrors> {
        if let Some(declaring_path) = declaring.path() {
            let candidate = declaring_path.parent().unwrap().join(reference);
            if candidate.is_file() {
                return self.file_source(candidate);
            }
            if reference.starts_with('.')
                || Path::new(reference).is_absolute()
                || reference.ends_with(".yaml")
                || reference.ends_with(".yml")
            {
                return Err(ProfileErrors::one(
                    declaring.label(),
                    "$.extends",
                    format!("parent profile not found: {}", candidate.display()),
                ));
            }
        }
        self.discover(Some(reference))
    }

    pub fn list(&self) -> Result<Vec<ProfileSummary>, ProfileErrors> {
        let default = self.discover(None)?.identity();
        let mut sources = Vec::new();
        if let Some(root) = &self.repository_root {
            self.list_files(&root.join(".rio/profiles"), &mut sources)?;
        }
        self.list_files(&self.config_dir.join("profiles"), &mut sources)?;
        if let Some(profiles) = BUILT_INS.get_dir("profiles") {
            for file in profiles.files() {
                if let Some(name) = file.path().file_stem().and_then(|p| p.to_str()) {
                    sources.push(ProfileSource::BuiltIn(format!("rio/{name}")));
                }
            }
        }
        let mut profiles = Vec::new();
        for source in sources {
            let value: Value = serde_yaml::from_str(&source.read()?)
                .map_err(|error| ProfileErrors::one(source.label(), "$", error.to_string()))?;
            let name = value["name"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    source
                        .path()
                        .and_then(|p| p.file_stem())
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned()
                });
            profiles.push(ProfileSummary {
                name,
                extends: value["extends"].as_str().map(str::to_owned),
                is_default: source.identity() == default,
                source,
            });
        }
        Ok(profiles)
    }

    fn list_files(
        &self,
        directory: &Path,
        sources: &mut Vec<ProfileSource>,
    ) -> Result<(), ProfileErrors> {
        let entries = match fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                return Err(ProfileErrors::one(
                    directory.display().to_string(),
                    "$",
                    error.to_string(),
                ));
            }
        };
        let mut paths = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|error| {
                ProfileErrors::one(directory.display().to_string(), "$", error.to_string())
            })?;
            let file_type = entry.file_type().map_err(|error| {
                ProfileErrors::one(entry.path().display().to_string(), "$", error.to_string())
            })?;
            // Do not recurse through directory links or cycle through profile trees.
            if file_type.is_dir() {
                self.list_files(&entry.path(), sources)?;
            } else if entry
                .path()
                .extension()
                .is_some_and(|ext| ext == "yaml" || ext == "yml")
            {
                paths.push(entry.path());
            }
        }
        paths.sort();
        for path in paths {
            sources.push(self.file_source(path)?);
        }
        Ok(())
    }
}

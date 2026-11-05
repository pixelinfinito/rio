use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{Context, Result};
use rio_core::{CheckDetails, CheckOutcome, FailureReason, Finding, SkipReason};
use rio_profile::ModuleManifest;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::{ProcessResult, ProcessSupervisor, Termination, ToolCommand, redact};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Capability {
    Parse,
    Typecheck,
    Lint,
    Test,
    Coverage,
    Scan,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ExitCodeContract {
    pub clean: Vec<i32>,
    pub diagnostics: Vec<i32>,
    #[serde(default)]
    pub failed: BTreeMap<i32, FailureReason>,
    #[serde(default)]
    pub skipped: BTreeMap<i32, SkipReason>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolSpec {
    pub name: String,
    pub command: Vec<String>,
    pub network: Vec<String>,
    pub exit_codes: ExitCodeContract,
}

/// Adapters describe and parse tool execution. The engine owns scheduling,
/// compatibility checks, disposable trees, supervision and baseline comparison.
pub trait Adapter: Send + Sync {
    fn manifest(&self) -> &'static ModuleManifest;
    fn language(&self) -> &'static str;
    fn parse_output(
        &self,
        tool: &str,
        stdout: &[u8],
        stderr: &[u8],
        context: &DiagnosticContext<'_>,
    ) -> Result<Vec<Finding>>;
    fn tools(&self, capability: Capability) -> Result<Vec<ToolSpec>> {
        let key = serde_json::to_value(capability)?
            .as_str()
            .unwrap()
            .to_owned();
        match self.manifest().tools.get(&key) {
            Some(value) => Ok(serde_json::from_value(value.clone())?),
            None => Ok(Vec::new()),
        }
    }
    fn supports(&self, capability: Capability) -> bool {
        serde_json::to_value(capability)
            .ok()
            .and_then(|value| value.as_str().map(str::to_owned))
            .is_some_and(|name| self.manifest().capabilities.contains(&name))
    }
}

pub struct DiagnosticContext<'a> {
    pub repository_root: &'a Path,
    pub project_root: &'a str,
    pub tool_version: &'a str,
    pub worktree_root: Option<&'a Path>,
    pub sources: Option<&'a rio_git::Tree>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedTool {
    pub name: String,
    pub path: PathBuf,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_hint: Option<String>,
}

pub struct ToolResolver {
    pub repository_root: PathBuf,
    pub search_path: Vec<PathBuf>,
    pub virtual_env: Option<PathBuf>,
}

impl ToolResolver {
    pub fn from_environment(repository_root: PathBuf) -> Self {
        Self {
            repository_root,
            search_path: std::env::var_os("PATH")
                .map(|path| std::env::split_paths(&path).collect())
                .unwrap_or_default(),
            virtual_env: std::env::var_os("VIRTUAL_ENV").map(PathBuf::from),
        }
    }
    fn candidates(directory: &Path, name: &str) -> Vec<PathBuf> {
        #[cfg(windows)]
        {
            ["exe", "cmd", "bat"]
                .into_iter()
                .map(|extension| directory.join(format!("{name}.{extension}")))
                .chain(std::iter::once(directory.join(name)))
                .collect()
        }
        #[cfg(not(windows))]
        {
            vec![directory.join(name)]
        }
    }
    /// Existing local tools win even when they cannot execute, so the run
    /// reports `spawn_failed` instead of silently invoking an unrelated PATH tool.
    pub fn locate(&self, name: &str, project_root: &str, language: &str) -> Option<PathBuf> {
        let root = self.repository_root.join(project_root);
        let mut directories = Vec::new();
        for directory in root
            .ancestors()
            .take_while(|directory| directory.starts_with(&self.repository_root))
        {
            if language == "typescript" {
                directories.push(directory.join("node_modules/.bin"));
            } else {
                let bin = if cfg!(windows) { "Scripts" } else { "bin" };
                directories.extend([
                    directory.join(".venv").join(bin),
                    directory.join("venv").join(bin),
                ]);
            }
        }
        if language == "python"
            && let Some(environment) = &self.virtual_env
        {
            directories.push(environment.join(if cfg!(windows) { "Scripts" } else { "bin" }));
        }
        directories.extend(self.search_path.clone());
        directories
            .into_iter()
            .flat_map(|directory| Self::candidates(&directory, name))
            .find(|path| path.is_file())
    }
    pub async fn resolve(
        &self,
        name: &str,
        project_root: &str,
        language: &str,
        supervisor: &ProcessSupervisor,
        cancellation: CancellationToken,
    ) -> Option<ResolvedTool> {
        let path = self.locate(name, project_root, language)?;
        let probe_tree = match tempfile::tempdir() {
            Ok(directory) => directory,
            Err(error) => {
                return Some(ResolvedTool {
                    name: name.into(),
                    path,
                    version: "unknown".into(),
                    version_hint: Some(format!(
                        "could not create disposable version-probe directory: {error}"
                    )),
                });
            }
        };
        let mut command = ToolCommand::new(path.clone(), probe_tree.path().into());
        command.args = vec!["--version".into()];
        command.timeout = Duration::from_secs(10);
        command.output_limit = 64 * 1024;
        let result = supervisor.run(command, cancellation).await;
        let output = if result.stdout.is_empty() {
            &result.stderr
        } else {
            &result.stdout
        };
        let version = String::from_utf8_lossy(output)
            .lines()
            .find(|line| !line.trim().is_empty())
            .map(str::trim)
            .map(str::to_owned);
        let (mut version, mut version_hint) = match (&result.termination, version) {
            (Termination::Exited { code: Some(0) }, Some(version)) if result.cleanup_confirmed => {
                (redact(&version), None)
            }
            _ => (
                "unknown".into(),
                Some(format!(
                    "{} version could not be captured: {:?}",
                    path.display(),
                    result.termination
                )),
            ),
        };
        // Package metadata is authoritative for JS CLIs; launcher output may
        // include platform text or belong to a workspace shim.
        if language == "typescript"
            && let Some(installed) =
                installed_package_version(&path, &self.repository_root.join(project_root), name)
        {
            version = installed;
        }
        if !result.cleanup_confirmed {
            let preserved = probe_tree.keep();
            version_hint = Some(format!(
                "{}; version-probe directory retained at {} because cleanup could not be confirmed: {}",
                version_hint.unwrap_or_default(),
                preserved.display(),
                result.survivors.join("; ")
            ));
        }
        Some(ResolvedTool {
            name: name.into(),
            path,
            version,
            version_hint,
        })
    }
}

pub fn evaluate_exit(
    result: &ProcessResult,
    contract: &ExitCodeContract,
    parsed: Result<Vec<Finding>>,
) -> CheckOutcome {
    let (findings, parse_error) = match parsed {
        Ok(findings) => (findings, None),
        Err(error) => (Vec::new(), Some(redact(&error.to_string()))),
    };
    let mut details = CheckDetails {
        findings,
        ..Default::default()
    };
    if !result.survivors.is_empty() {
        details.hint = Some(result.survivors.join("; "));
    }
    match &result.termination {
        Termination::Cancelled { reason } => {
            return CheckOutcome::Cancelled {
                reason: *reason,
                details,
            };
        }
        Termination::Failed { reason, hint } => {
            details.hint = Some(redact(hint));
            return CheckOutcome::Failed {
                reason: *reason,
                details,
            };
        }
        Termination::Exited { .. } => {}
    }
    let Termination::Exited { code: Some(code) } = result.termination else {
        details.hint = Some("tool terminated by a signal".into());
        return CheckOutcome::Failed {
            reason: FailureReason::ToolCrashed,
            details,
        };
    };
    if let Some(reason) = contract.failed.get(&code) {
        if *reason == FailureReason::ToolConfigError {
            details.findings.clear();
        }
        details.hint = Some(format!("tool exited with code {code}"));
        return CheckOutcome::Failed {
            reason: *reason,
            details,
        };
    }
    if let Some(reason) = contract.skipped.get(&code) {
        return CheckOutcome::Skipped {
            reason: *reason,
            details,
        };
    }
    if !contract.clean.contains(&code) && !contract.diagnostics.contains(&code) {
        details.hint = Some(format!("tool exited with undeclared code {code}"));
        return CheckOutcome::Failed {
            reason: FailureReason::ToolCrashed,
            details,
        };
    }
    if let Some(error) = parse_error {
        details.hint = Some(error);
        return CheckOutcome::Failed {
            reason: FailureReason::UnparseableOutput,
            details,
        };
    }
    if contract.diagnostics.contains(&code) && details.findings.is_empty() {
        details.hint = Some(format!(
            "tool exited with diagnostics code {code} but no diagnostics could be parsed"
        ));
        return CheckOutcome::Failed {
            reason: FailureReason::UnparseableOutput,
            details,
        };
    }
    if !result.cleanup_confirmed {
        details.hint.get_or_insert_with(|| {
            "tool process cleanup could not be confirmed; disposable tree retained".into()
        });
        return CheckOutcome::Failed {
            reason: FailureReason::ToolCrashed,
            details,
        };
    }
    if details.findings.is_empty() {
        CheckOutcome::Passed { details }
    } else {
        CheckOutcome::Findings { details }
    }
}

pub fn tool_contract(module: &str, capability: &str, tool: &str) -> Result<ToolSpec> {
    let manifest = rio_profile::resolve_module(module)?;
    let tools: Vec<ToolSpec> = serde_json::from_value(
        manifest
            .tools
            .get(capability)
            .context("capability has no tool declarations")?
            .clone(),
    )?;
    tools
        .into_iter()
        .find(|spec| spec.name == tool)
        .context("tool is not declared by the adapter")
}

fn installed_package_version(executable: &Path, project: &Path, name: &str) -> Option<String> {
    let canonical = executable.canonicalize().ok();
    let direct = canonical
        .as_deref()
        .into_iter()
        .flat_map(Path::ancestors)
        .map(|directory| directory.join("package.json"));
    let local = project.ancestors().map(|directory| {
        directory
            .join("node_modules")
            .join(name)
            .join("package.json")
    });
    direct.chain(local).find_map(|manifest| {
        let value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(manifest).ok()?).ok()?;
        (value["name"].as_str() == Some(name))
            .then(|| value["version"].as_str().map(str::to_owned))
            .flatten()
    })
}

use crate::{
    Compatibility, ExitCodeContract, ProcessResult, ProcessSupervisor, ResolvedTool, Termination,
    ToolCommand, ToolResolver,
};
use anyhow::{Context, Result};
use rio_core::{CheckDetails, CheckKind, CheckOutcome, FailureReason, Finding};
use rio_git::{SafeTreeWriter, Tree, resolve_file};
use serde_json::Value;
use std::{path::Path, time::Duration};
use tokio_util::sync::CancellationToken;

/// The pinned channel, read through in-tree links as rustup would. A file that
/// does not parse is an error the planner reports as a skipped Rust check.
pub fn rust_toolchain(tree: &Tree, root: &str) -> Result<Option<String>> {
    let Some(path) = crate::ancestor_config(tree, root, &["rust-toolchain.toml", "rust-toolchain"])
    else {
        return Ok(None);
    };
    let entry = resolve_file(tree, &path).context("toolchain file vanished")?;
    let value =
        std::str::from_utf8(&entry.content).with_context(|| format!("cannot read {path}"))?;
    if path.ends_with(".toml") {
        let value: toml::Value =
            toml::from_str(value).with_context(|| format!("cannot parse {path}"))?;
        Ok(value
            .get("toolchain")
            .and_then(|value| value.get("channel"))
            .and_then(toml::Value::as_str)
            .map(str::to_owned))
    } else {
        Ok(Some(value.trim().into()))
    }
}

pub fn configure_cargo(
    command: &mut ToolCommand,
    tree: &Tree,
    root: &str,
    selected_toolchain: Option<&str>,
) -> Result<()> {
    command.env.insert("RUSTUP_AUTO_INSTALL".into(), "0".into());
    command
        .env
        .insert("CARGO_TERM_COLOR".into(), "never".into());
    if let Some(channel) = rust_toolchain(tree, root)?
        .as_deref()
        .or(selected_toolchain)
    {
        command
            .env
            .insert("RUSTUP_TOOLCHAIN".into(), channel.into());
    }
    Ok(())
}

pub async fn rust_cargo(
    resolver: &ToolResolver,
    tree: &Tree,
    root: &str,
    supervisor: &ProcessSupervisor,
    cancellation: CancellationToken,
) -> Result<Option<ResolvedTool>> {
    // An unreadable toolchain file leaves cargo unresolved; rustup would reject it too.
    let Ok(mut toolchain) = rust_toolchain(tree, root) else {
        return Ok(None);
    };
    let temp = tempfile::tempdir()?;
    let path = if let Some(rustup) = resolver.locate("rustup", root, "rust") {
        if toolchain.is_none() {
            // Only this read-only selection query needs the original directory:
            // rustup directory overrides do not follow us into disposable trees.
            let mut command = ToolCommand::new(rustup.clone(), resolver.repository_root.join(root));
            command.args = vec!["show".into(), "active-toolchain".into()];
            command.env.insert("RUSTUP_AUTO_INSTALL".into(), "0".into());
            command.timeout = Duration::from_secs(10);
            command.output_limit = 65536;
            let result = supervisor.run(command, cancellation.clone()).await;
            if !result.cleanup_confirmed {
                let _ = temp.keep();
                return Ok(None);
            }
            if !matches!(result.termination, Termination::Exited { code: Some(0) }) {
                return Ok(None);
            }
            toolchain = std::str::from_utf8(&result.stdout)?
                .lines()
                .next()
                .map(|line| line.rsplit_once(" (").map_or(line, |(name, _)| name).trim())
                .filter(|name| !name.is_empty())
                .map(str::to_owned);
            if toolchain.is_none() {
                return Ok(None);
            }
        }
        let mut command = ToolCommand::new(rustup, temp.path().into());
        command.args = vec!["which".into(), "cargo".into()];
        if let Some(channel) = &toolchain {
            command.args.extend(["--toolchain".into(), channel.into()]);
        }
        command.env.insert("RUSTUP_AUTO_INSTALL".into(), "0".into());
        command.timeout = Duration::from_secs(10);
        let result = supervisor.run(command, cancellation.clone()).await;
        if !result.cleanup_confirmed {
            let _ = temp.keep();
            return Ok(None);
        }
        if !matches!(result.termination, Termination::Exited { code: Some(0) }) {
            return Ok(None);
        }
        std::path::PathBuf::from(std::str::from_utf8(&result.stdout)?.trim())
    } else {
        let Some(path) = resolver.locate("cargo", root, "rust") else {
            return Ok(None);
        };
        path
    };
    let mut command = ToolCommand::new(path.clone(), temp.path().into());
    command.args = vec!["--version".into()];
    configure_cargo(&mut command, tree, root, toolchain.as_deref())?;
    let result = supervisor.run(command, cancellation.clone()).await;
    if !result.cleanup_confirmed {
        let _ = temp.keep();
        return Ok(None);
    }
    Ok(
        matches!(result.termination, Termination::Exited { code: Some(0) }).then(|| ResolvedTool {
            name: "cargo-check".into(),
            path,
            version: String::from_utf8_lossy(&result.stdout).trim().into(),
            version_hint: None,
            rustup_toolchain: toolchain,
        }),
    )
}

pub async fn rust_subcommand(
    cargo: &ResolvedTool,
    name: &str,
    tree: &Tree,
    root: &str,
    supervisor: &ProcessSupervisor,
    cancellation: CancellationToken,
) -> Result<Option<ResolvedTool>> {
    if name == "cargo-check" {
        return Ok(Some(cargo.clone()));
    }
    let temp = tempfile::tempdir()?;
    let mut command = ToolCommand::new(cargo.path.clone(), temp.path().into());
    command.args = vec![name.trim_start_matches("cargo-").into(), "--version".into()];
    configure_cargo(&mut command, tree, root, cargo.rustup_toolchain.as_deref())?;
    command.timeout = Duration::from_secs(10);
    let result = supervisor.run(command, cancellation.clone()).await;
    if !result.cleanup_confirmed {
        let _ = temp.keep();
        return Ok(None);
    }
    if name == "cargo-llvm-cov" {
        let external = ["LLVM_COV", "LLVM_PROFDATA"]
            .iter()
            .all(|key| std::env::var_os(key).is_some_and(|path| Path::new(&path).is_file()));
        if !external {
            let rustc = cargo
                .path
                .with_file_name(format!("rustc{}", std::env::consts::EXE_SUFFIX));
            let mut probe = ToolCommand::new(rustc, temp.path().into());
            probe.args = vec!["--print".into(), "target-libdir".into()];
            probe.timeout = Duration::from_secs(10);
            probe.output_limit = 65536;
            configure_cargo(&mut probe, tree, root, cargo.rustup_toolchain.as_deref())?;
            let probe = supervisor.run(probe, cancellation).await;
            if !probe.cleanup_confirmed {
                let _ = temp.keep();
                return Ok(None);
            }
            let libdir = String::from_utf8_lossy(&probe.stdout);
            let Some(parent) = Path::new(libdir.trim()).parent() else {
                return Ok(None);
            };
            if !matches!(probe.termination, Termination::Exited { code: Some(0) })
                || !["llvm-cov", "llvm-profdata"].iter().all(|name| {
                    parent
                        .join("bin")
                        .join(format!("{name}{}", std::env::consts::EXE_SUFFIX))
                        .is_file()
                })
            {
                return Ok(None);
            }
        }
    }
    Ok(
        matches!(result.termination, Termination::Exited { code: Some(0) }).then(|| ResolvedTool {
            name: name.into(),
            path: cargo.path.clone(),
            version: String::from_utf8_lossy(&result.stdout).trim().into(),
            version_hint: None,
            rustup_toolchain: cargo.rustup_toolchain.clone(),
        }),
    )
}

pub fn rust_selection(tree: &Tree, root: &str) -> Result<Vec<String>> {
    let manifest = if root == "." {
        "Cargo.toml".into()
    } else {
        format!("{root}/Cargo.toml")
    };
    let value: toml::Value = toml::from_str(std::str::from_utf8(
        &tree
            .get(&manifest)
            .context("Rust project has no Cargo.toml")?
            .content,
    )?)?;
    if value.get("workspace").is_some() && value.get("package").is_none() {
        Ok(vec!["--workspace".into()])
    } else {
        Ok(vec![
            "-p".into(),
            value["package"]["name"]
                .as_str()
                .context("Rust package missing name")?
                .into(),
        ])
    }
}

pub fn rust_has_lockfile(tree: &Tree, root: &str) -> bool {
    crate::ancestor_config(tree, root, &["Cargo.lock"]).is_some()
}

pub fn rust_selection_scoped(tree: &Tree, root: &str, workspace_wide: bool) -> Result<Vec<String>> {
    if workspace_wide {
        Ok(vec!["--workspace".into()])
    } else {
        rust_selection(tree, root)
    }
}

pub fn rust_workspace_root(tree: &Tree, root: &str) -> String {
    for directory in Path::new(if root == "." { "" } else { root }).ancestors() {
        let path = directory
            .join("Cargo.toml")
            .to_string_lossy()
            .replace('\\', "/");
        if resolve_file(tree, &path)
            .and_then(|entry| std::str::from_utf8(&entry.content).ok())
            .and_then(|text| toml::from_str::<toml::Value>(text).ok())
            .is_some_and(|value| value.get("workspace").is_some())
        {
            return if directory.as_os_str().is_empty() {
                ".".into()
            } else {
                directory.to_string_lossy().replace('\\', "/")
            };
        }
    }
    root.into()
}

pub fn rust_diagnostic_command(
    tool: &ResolvedTool,
    tree: &Tree,
    tool_tree: &Path,
    root: &str,
    workspace_wide: bool,
) -> Result<ToolCommand> {
    let mut command = ToolCommand::new(
        tool.path.clone(),
        tool_tree.join(rust_workspace_root(tree, root)),
    );
    let subcommand = tool.name.trim_start_matches("cargo-");
    let mut args = vec![subcommand.into()];
    if subcommand == "fmt" {
        args.push("--check".into());
    } else {
        args.extend(["--message-format=json".into(), "--all-targets".into()]);
        if rust_has_lockfile(tree, root) {
            args.push("--locked".into());
        }
    }
    // cargo fmt spells workspace selection --all, unlike cargo check/clippy.
    let mut selection = rust_selection_scoped(tree, root, workspace_wide)?;
    if subcommand == "fmt" && selection == ["--workspace"] {
        selection = vec!["--all".into()];
    }
    args.extend(selection);
    command.args = args.into_iter().map(Into::into).collect();
    configure_cargo(&mut command, tree, root, tool.rustup_toolchain.as_deref())?;
    Ok(command)
}

pub fn rust_lint_tools(tree: &Tree, root: &str) -> Vec<&'static str> {
    let mut result = Vec::new();
    let clippy = crate::ancestor_config(tree, root, &["clippy.toml", ".clippy.toml"]).is_some()
        || Path::new(if root == "." { "" } else { root })
            .ancestors()
            .any(|directory| {
                let path = directory
                    .join("Cargo.toml")
                    .to_string_lossy()
                    .replace('\\', "/");
                resolve_file(tree, &path)
                    .and_then(|entry| std::str::from_utf8(&entry.content).ok())
                    .and_then(|text| toml::from_str::<toml::Value>(text).ok())
                    .is_some_and(|value| {
                        value.get("lints").is_some()
                            || value
                                .get("workspace")
                                .and_then(|value| value.get("lints"))
                                .is_some()
                    })
            });
    if clippy {
        result.push("cargo-clippy");
    }
    if crate::ancestor_config(tree, root, &["rustfmt.toml", ".rustfmt.toml"]).is_some() {
        result.push("cargo-fmt");
    }
    result
}

/// Cargo metadata is read from the selected source, under process supervision.
/// --no-deps avoids resolution/downloads; path edges still describe consumers.
pub async fn rust_metadata(
    tree: &Tree,
    root: &str,
    cargo: &ResolvedTool,
    supervisor: &ProcessSupervisor,
    cancellation: CancellationToken,
) -> Result<Value> {
    let temporary = tempfile::tempdir()?;
    SafeTreeWriter::new(temporary.path())?.write_tree(tree)?;
    let mut command = ToolCommand::new(cargo.path.clone(), temporary.path().join(root));
    command.args = vec![
        "metadata".into(),
        "--no-deps".into(),
        "--format-version=1".into(),
        "--offline".into(),
    ];
    configure_cargo(&mut command, tree, root, cargo.rustup_toolchain.as_deref())?;
    command.timeout = Duration::from_secs(20);
    command.output_limit = 16 * 1024 * 1024;
    let result = supervisor.run(command, cancellation.clone()).await;
    if !result.cleanup_confirmed {
        let retained = temporary.keep();
        anyhow::bail!(
            "metadata processes survived; source tree retained at {}",
            retained.display()
        );
    }
    anyhow::ensure!(
        matches!(result.termination, Termination::Exited { code: Some(0) }),
        "cargo metadata failed: {}",
        crate::redact(&String::from_utf8_lossy(&result.stderr))
    );
    let mut metadata: Value = serde_json::from_slice(&result.stdout)?;
    // Normalize all paths while the disposable prefix is known.
    fn normalize(value: &mut Value, prefix: &str) {
        match value {
            Value::String(text) => {
                let input = text.replace('\\', "/");
                if let Some(relative) = input.strip_prefix(&format!("{prefix}/")) {
                    *text = relative.into();
                }
            }
            Value::Array(values) => values.iter_mut().for_each(|value| normalize(value, prefix)),
            Value::Object(values) => values
                .values_mut()
                .for_each(|value| normalize(value, prefix)),
            _ => {}
        }
    }
    normalize(
        &mut metadata,
        &temporary
            .path()
            .canonicalize()?
            .to_string_lossy()
            .replace('\\', "/"),
    );
    Ok(metadata)
}

pub fn apply_rust_metadata(layout: &mut crate::RepositoryLayout, metadata: &Value) {
    let members: std::collections::BTreeSet<_> = metadata["workspace_members"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    for package in metadata["packages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|package| {
            package["id"]
                .as_str()
                .is_some_and(|id| members.contains(id))
        })
    {
        let Some(manifest) = package["manifest_path"].as_str() else {
            continue;
        };
        let path = manifest.strip_suffix("/Cargo.toml").unwrap_or(".");
        let workspace = metadata["workspace_root"]
            .as_str()
            .filter(|path| !Path::new(path).is_absolute())
            .unwrap_or(".");
        let project = crate::ProjectRoot {
            path: path.into(),
            language: "rust".into(),
            workspace: (workspace != path).then(|| workspace.into()),
            manifest: Some(manifest.into()),
            name: package["name"].as_str().map(str::to_owned),
        };
        if let Some(current) = layout
            .roots
            .iter_mut()
            .find(|root| root.language == "rust" && root.path == path)
        {
            *current = project;
        } else {
            layout.roots.push(project);
        }
        for dependency in package["dependencies"].as_array().into_iter().flatten() {
            if let Some(dependency) = dependency["path"]
                .as_str()
                .filter(|path| !Path::new(path).is_absolute())
            {
                layout
                    .dependencies
                    .entry(path.into())
                    .or_default()
                    .insert(dependency.into());
            }
        }
    }
}

pub fn evaluate_cargo_exit(
    result: &ProcessResult,
    kind: CheckKind,
    parsed: Result<Vec<Finding>>,
) -> CheckOutcome {
    let mut contract = ExitCodeContract {
        clean: vec![0],
        diagnostics: vec![101],
        ..Default::default()
    };
    if matches!(result.termination, Termination::Exited { code: Some(101) })
        && parsed.as_ref().is_ok_and(|findings| {
            !findings
                .iter()
                .any(|finding| finding.severity == rio_core::Severity::Error)
        })
    {
        contract.failed.insert(101, FailureReason::ToolCrashed);
    }
    let _ = kind;
    crate::evaluate_exit(result, &contract, parsed)
}

pub fn aggregate_rust_outcomes(outcomes: Vec<CheckOutcome>) -> CheckOutcome {
    let rank = |outcome: &CheckOutcome| match outcome {
        CheckOutcome::Cancelled { .. } => 5,
        CheckOutcome::Failed { .. } => 4,
        CheckOutcome::Skipped { .. } => 3,
        CheckOutcome::Findings { .. } => 2,
        CheckOutcome::Passed { .. } => 1,
    };
    let mut combined = CheckOutcome::Passed {
        details: CheckDetails::default(),
    };
    let mut findings = Vec::new();
    let mut hints = Vec::new();
    for mut outcome in outcomes {
        findings.append(&mut outcome.details_mut().findings);
        if let Some(hint) = outcome.details_mut().hint.take() {
            hints.push(hint);
        }
        if rank(&outcome) > rank(&combined) {
            combined = outcome;
        }
    }
    combined.details_mut().findings = findings;
    combined.details_mut().hint = (!hints.is_empty()).then(|| hints.join("; "));
    combined
}

pub fn rust_compatibility_hint(compatibility: &Compatibility) -> String {
    compatibility
        .hint()
        .unwrap_or("Rust dependencies verified")
        .into()
}

pub struct RustAdapter;
impl crate::Adapter for RustAdapter {
    fn manifest(&self) -> &'static rio_profile::ModuleManifest {
        rio_profile::resolve_module("rio/adapter-rust").expect("built-in adapter is present")
    }
    fn language(&self) -> &'static str {
        "rust"
    }
    fn parse_output(
        &self,
        tool: &str,
        stdout: &[u8],
        _stderr: &[u8],
        context: &crate::DiagnosticContext<'_>,
    ) -> Result<Vec<Finding>> {
        match tool {
            "cargo-check" | "cargo-clippy" => Ok(crate::parse_cargo(stdout, context)?.findings),
            "cargo-fmt" => crate::parse_rustfmt(stdout, context),
            _ => anyhow::bail!("unsupported Rust diagnostic tool {tool}"),
        }
    }
}

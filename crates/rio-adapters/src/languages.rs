use crate::{
    Adapter, DiagnosticContext, parse_eslint, parse_mypy, parse_pyright, parse_ruff, parse_tsc,
};
use crate::{ResolvedTool, ToolCommand};
use anyhow::{Context, Result, bail};
use rio_core::Finding;
use rio_core::{CheckDetails, CheckKind, CheckOutcome, SkipReason};
use rio_git::Tree;
use rio_profile::ModuleManifest;
use std::path::Path;

/// A command is prepared only after compatibility and tool resolution by the
/// shared planner. Its working directory must be in a disposable tool tree.
pub fn diagnostic_command(
    tool: &ResolvedTool,
    tree: &Tree,
    tool_tree: &Path,
    root: &str,
    targets: &[String],
) -> Result<ToolCommand> {
    // Use one spelling for the cwd and targets. Node tools may otherwise treat
    // /var/... targets as outside a cwd resolved to /private/var/... on macOS.
    let canonical_tree = tool_tree
        .canonicalize()
        .context("cannot resolve disposable tool tree")?;
    let tool_tree = canonical_tree.as_path();
    let mut command = ToolCommand::new(tool.path.clone(), tool_tree.join(root));
    let args: Vec<String> = match tool.name.as_str() {
        "tsc" => {
            let mut args = vec!["--noEmit".into(), "--pretty".into(), "false".into()];
            let config = if root == "." {
                "tsconfig.json".into()
            } else {
                format!("{root}/tsconfig.json")
            };
            if tree.contains_key(&config) {
                args.extend(["-p".into(), ".".into()]);
            } else {
                args.extend(
                    tree.keys()
                        .filter(|path| {
                            crate::language_for_path(path) == Some("typescript")
                                && (root == "." || path.starts_with(&format!("{root}/")))
                        })
                        .map(|path| tool_tree.join(path).to_string_lossy().into_owned()),
                );
            }
            args
        }
        "eslint" => vec!["-f".into(), "json".into()],
        "ruff" => vec!["check".into(), "--output-format".into(), "json".into()],
        "pyright" => vec!["--outputjson".into()],
        "mypy" => {
            let mut args = if mypy_supports_json(&tool.version) {
                vec!["--output".into(), "json".into()]
            } else {
                vec![
                    "--show-column-numbers".into(),
                    "--show-error-codes".into(),
                    "--no-error-summary".into(),
                    "--no-pretty".into(),
                ]
            };
            let config = crate::python_targets::mypy_config(tree, root);
            if let Some((path, _)) = &config {
                args.extend([
                    "--config-file".into(),
                    tool_tree.join(path).to_string_lossy().into_owned(),
                ]);
            }
            if !config.is_some_and(|(_, explicit)| explicit) {
                args.extend(crate::python_targets::python_package_targets(tree, root));
            }
            args
        }
        _ => bail!("unsupported diagnostic tool {}", tool.name),
    };
    command.args = args.into_iter().map(Into::into).collect();
    if matches!(tool.name.as_str(), "eslint" | "ruff") {
        command.args.push("--".into());
        command.args.extend(
            targets
                .iter()
                .map(|path| tool_tree.join(path).into_os_string()),
        );
    }
    Ok(command)
}

pub fn mypy_supports_json(version: &str) -> bool {
    let version = version.strip_prefix("mypy ").unwrap_or(version);
    let mut numbers = version
        .split('.')
        .filter_map(|part| part.parse::<u64>().ok());
    matches!((numbers.next(), numbers.next()), (Some(major), Some(minor)) if major > 1 || major == 1 && minor >= 11)
}

pub fn diagnostic_config_skip(
    kind: CheckKind,
    language: &str,
    tree: &Tree,
    root: &str,
) -> Option<CheckOutcome> {
    if kind == CheckKind::Lint
        && if language == "typescript" {
            eslint_config(tree, root).is_none()
        } else {
            ruff_config(tree, root).is_none()
        }
    {
        Some(CheckOutcome::Skipped { reason: SkipReason::NoProjectConfig, details: CheckDetails { hint: Some("lint runs only against the project's own rules; add an ESLint or Ruff configuration".into()), ..Default::default() } })
    } else {
        None
    }
}

pub struct TypeScriptAdapter;
impl Adapter for TypeScriptAdapter {
    fn manifest(&self) -> &'static ModuleManifest {
        rio_profile::resolve_module("rio/adapter-typescript").expect("built-in adapter is present")
    }
    fn language(&self) -> &'static str {
        "typescript"
    }
    fn parse_output(
        &self,
        tool: &str,
        stdout: &[u8],
        _stderr: &[u8],
        context: &DiagnosticContext<'_>,
    ) -> Result<Vec<Finding>> {
        match tool {
            "tsc" => parse_tsc(stdout, context),
            "eslint" => parse_eslint(stdout, context),
            _ => bail!("unsupported TypeScript diagnostic tool {tool}"),
        }
    }
}

pub struct PythonAdapter;
impl Adapter for PythonAdapter {
    fn manifest(&self) -> &'static ModuleManifest {
        rio_profile::resolve_module("rio/adapter-python").expect("built-in adapter is present")
    }
    fn language(&self) -> &'static str {
        "python"
    }
    fn parse_output(
        &self,
        tool: &str,
        stdout: &[u8],
        _stderr: &[u8],
        context: &DiagnosticContext<'_>,
    ) -> Result<Vec<Finding>> {
        match tool {
            "pyright" => parse_pyright(stdout, context),
            "mypy" => parse_mypy(stdout, context),
            "ruff" => parse_ruff(stdout, context),
            _ => bail!("unsupported Python diagnostic tool {tool}"),
        }
    }
}

pub fn ancestor_config(tree: &Tree, project_root: &str, names: &[&str]) -> Option<String> {
    let mut directory = if project_root == "." {
        ""
    } else {
        project_root
    };
    loop {
        for name in names {
            let path = if directory.is_empty() {
                (*name).into()
            } else {
                format!("{directory}/{name}")
            };
            if tree.contains_key(&path) {
                return Some(path);
            }
        }
        if directory.is_empty() {
            return None;
        }
        directory = directory.rsplit_once('/').map_or("", |(parent, _)| parent);
    }
}

pub fn eslint_config(tree: &Tree, root: &str) -> Option<String> {
    if let Some(config) = ancestor_config(
        tree,
        root,
        &[
            "eslint.config.js",
            "eslint.config.mjs",
            "eslint.config.cjs",
            "eslint.config.ts",
            "eslint.config.mts",
            "eslint.config.cts",
            ".eslintrc",
            ".eslintrc.js",
            ".eslintrc.cjs",
            ".eslintrc.json",
            ".eslintrc.yaml",
            ".eslintrc.yml",
        ],
    ) {
        return Some(config);
    }
    let mut root = if root == "." { "" } else { root };
    loop {
        let path = if root.is_empty() {
            "package.json".into()
        } else {
            format!("{root}/package.json")
        };
        if let Some(entry) = tree.get(&path)
            && serde_json::from_slice::<serde_json::Value>(&entry.content)
                .is_ok_and(|value| value.get("eslintConfig").is_some())
        {
            return Some(path);
        }
        if root.is_empty() {
            return None;
        }
        root = root.rsplit_once('/').map_or("", |(parent, _)| parent);
    }
}

fn toml_has(tree: &Tree, path: &str, tool: &str) -> bool {
    tree.get(path)
        .and_then(|entry| std::str::from_utf8(&entry.content).ok())
        .and_then(|text| toml::from_str::<toml::Value>(text).ok())
        .is_some_and(|value| {
            value
                .get("tool")
                .and_then(|value| value.get(tool))
                .is_some()
        })
}

pub fn ruff_config(tree: &Tree, root: &str) -> Option<String> {
    let mut root = if root == "." { "" } else { root };
    loop {
        for name in ["ruff.toml", ".ruff.toml", "pyproject.toml"] {
            let path = if root.is_empty() {
                name.into()
            } else {
                format!("{root}/{name}")
            };
            if tree.contains_key(&path)
                && (name != "pyproject.toml" || toml_has(tree, &path, "ruff"))
            {
                return Some(path);
            }
        }
        if root.is_empty() {
            return None;
        }
        root = root.rsplit_once('/').map_or("", |(parent, _)| parent);
    }
}

pub fn python_typechecker(
    tree: &Tree,
    root: &str,
    available: impl Fn(&str) -> bool,
) -> Option<&'static str> {
    if ancestor_config(tree, root, &["pyrightconfig.json"]).is_some() {
        return Some("pyright");
    }
    if ancestor_config(tree, root, &["mypy.ini", ".mypy.ini"]).is_some() {
        return Some("mypy");
    }
    let mut directory = if root == "." { "" } else { root };
    loop {
        let pyproject = if directory.is_empty() {
            "pyproject.toml".into()
        } else {
            format!("{directory}/pyproject.toml")
        };
        if toml_has(tree, &pyproject, "mypy") {
            return Some("mypy");
        }
        if toml_has(tree, &pyproject, "pyright") {
            return Some("pyright");
        }
        let setup = if directory.is_empty() {
            "setup.cfg".into()
        } else {
            format!("{directory}/setup.cfg")
        };
        if tree.get(&setup).is_some_and(|entry| {
            String::from_utf8_lossy(&entry.content)
                .lines()
                .any(|line| line.trim() == "[mypy]")
        }) {
            return Some("mypy");
        }
        if directory.is_empty() {
            break;
        }
        directory = directory.rsplit_once('/').map_or("", |(parent, _)| parent);
    }
    if available("pyright") {
        Some("pyright")
    } else if available("mypy") {
        Some("mypy")
    } else {
        None
    }
}

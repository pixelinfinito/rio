use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    str::FromStr,
};

use super::{DependencyEdge, DependencyGraph, PackageFlags, PackageNode};
use anyhow::{Context, Result};
use pep508_rs::{ExtraName, MarkerEnvironment, MarkerTree};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone)]
pub struct DependencyEnvironment {
    pub os: String,
    pub cpu: String,
    pub libc: String,
    pub python: Option<MarkerEnvironment>,
    pub omit_dev: bool,
    pub groups: BTreeSet<String>,
    pub extras: BTreeSet<String>,
}

impl Default for DependencyEnvironment {
    fn default() -> Self {
        Self {
            os: match std::env::consts::OS {
                "windows" => "win32",
                "macos" => "darwin",
                other => other,
            }
            .into(),
            cpu: match std::env::consts::ARCH {
                "x86_64" => "x64",
                "aarch64" => "arm64",
                "x86" => "ia32",
                other => other,
            }
            .into(),
            libc: if cfg!(target_env = "musl") {
                "musl"
            } else {
                "glibc"
            }
            .into(),
            python: None,
            omit_dev: false,
            groups: ["main".into(), "default".into()].into(),
            extras: BTreeSet::new(),
        }
    }
}

fn platform_list(constraints: &[String], actual: &str) -> bool {
    !constraints
        .iter()
        .any(|value| value.strip_prefix('!') == Some(actual))
        && (constraints.iter().all(|value| value.starts_with('!'))
            || constraints
                .iter()
                .any(|value| value == actual || value == "any"))
}

fn marker_applies(marker: Option<&str>, environment: &DependencyEnvironment) -> Result<bool> {
    let Some(marker) = marker.filter(|marker| !marker.is_empty()) else {
        return Ok(true);
    };
    let tree = MarkerTree::from_str(marker)
        .with_context(|| format!("unsupported environment marker {marker}"))?;
    let python = environment
        .python
        .as_ref()
        .context("Python interpreter environment markers could not be established")?;
    let extras: Vec<_> = environment
        .extras
        .iter()
        .map(|extra| ExtraName::from_str(extra))
        .collect::<Result<_, _>>()?;
    Ok(tree.evaluate(python, &extras))
}

fn flags_apply(flags: &PackageFlags, environment: &DependencyEnvironment) -> Result<bool> {
    if !platform_list(&flags.os, &environment.os)
        || !platform_list(&flags.cpu, &environment.cpu)
        || !platform_list(&flags.libc, &environment.libc)
    {
        return Ok(false);
    }
    if let Some(python) = &flags.python {
        let version = environment
            .python
            .as_ref()
            .context("Python interpreter version could not be established")?
            .python_full_version()
            .to_string();
        let version = pep440_rs::Version::from_str(&version)?;
        let specifiers = super::python::poetry_specifiers(python)
            .with_context(|| format!("unsupported Python version constraint {python}"))?;
        if !specifiers
            .iter()
            .any(|specifiers| specifiers.contains(&version))
        {
            return Ok(false);
        }
    }
    if !flags.group_markers.is_empty() {
        let mut applies = false;
        for (group, marker) in &flags.group_markers {
            if environment.groups.contains(group)
                || group == "main"
                || (group == "dev" && !environment.omit_dev)
            {
                applies |= marker_applies(Some(marker), environment)?;
            }
        }
        if !applies {
            return Ok(false);
        }
    }
    marker_applies(flags.markers.as_deref(), environment)
}

fn node_required(node: &PackageNode, environment: &DependencyEnvironment) -> bool {
    (!node.flags.optional || !node.flags.extras.is_disjoint(&environment.extras))
        && !(node.flags.dev && environment.omit_dev)
        && (node.flags.groups.is_empty()
            || node.flags.groups.iter().any(|group| {
                environment.groups.contains(group)
                    || group == "main"
                    || (group == "dev" && !environment.omit_dev)
            }))
        && (node.flags.extras.is_empty() || !node.flags.extras.is_disjoint(&environment.extras))
}

fn edge_required(edge: &DependencyEdge, environment: &DependencyEnvironment) -> Result<bool> {
    Ok((!edge.optional
        || edge
            .extra
            .as_ref()
            .is_some_and(|extra| environment.extras.contains(extra)))
        && !(edge.dev && environment.omit_dev)
        && edge.group.as_ref().is_none_or(|group| {
            environment.groups.contains(group)
                || group == "main"
                || (group == "dev" && !environment.omit_dev)
        })
        && edge
            .extra
            .as_ref()
            .is_none_or(|extra| environment.extras.contains(extra))
        && marker_applies(edge.marker.as_deref(), environment)?)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EffectiveNode {
    pub package: PackageNode,
    pub required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EffectiveGraph {
    pub nodes: BTreeMap<String, EffectiveNode>,
    pub importer: String,
    pub complete: bool,
    pub notes: Vec<String>,
}

impl DependencyGraph {
    /// Follow only the requested importer's resolution graph. Optional and
    /// omitted nodes remain represented for checking conflicting installations.
    pub fn effective(
        &self,
        importer: &str,
        environment: &DependencyEnvironment,
    ) -> Result<EffectiveGraph> {
        let importer = if importer.is_empty() { "." } else { importer };
        let root = self
            .importers
            .get(importer)
            .with_context(|| format!("lockfile has no importer for {importer}"))?;
        let mut nodes: BTreeMap<String, EffectiveNode> = BTreeMap::new();
        let mut queue = VecDeque::new();
        let mut visited = BTreeSet::new();
        for edge in &root.dependencies {
            queue.push_back((
                edge.target.clone(),
                edge_required(edge, environment)?,
                edge.requested_extras.clone(),
            ));
        }
        while let Some((location, required, extras)) = queue.pop_front() {
            if !visited.insert((location.clone(), required, extras.clone())) {
                continue;
            }
            let node = self
                .nodes
                .get(&location)
                .with_context(|| format!("unresolved dependency at {location}"))?;
            if !flags_apply(&node.flags, environment)? {
                continue;
            }
            let required = required && node_required(node, environment);
            if let Some(existing) = nodes.get_mut(&location) {
                existing.required |= required;
            } else {
                nodes.insert(
                    location,
                    EffectiveNode {
                        package: node.clone(),
                        required,
                    },
                );
            }
            let mut dependency_environment = environment.clone();
            dependency_environment.extras = extras;
            for edge in &node.dependencies {
                queue.push_back((
                    edge.target.clone(),
                    required && edge_required(edge, &dependency_environment)?,
                    edge.requested_extras.clone(),
                ));
            }
        }
        Ok(EffectiveGraph {
            nodes,
            importer: importer.into(),
            complete: self.complete,
            notes: self.notes.clone(),
        })
    }
}

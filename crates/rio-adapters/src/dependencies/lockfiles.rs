use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Ecosystem {
    #[serde(rename = "npm")]
    Npm,
    #[serde(rename = "PyPI")]
    PyPi,
    #[serde(rename = "crates.io")]
    CratesIo,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackageFlags {
    pub dev: bool,
    pub optional: bool,
    pub peer: bool,
    pub os: Vec<String>,
    pub cpu: Vec<String>,
    pub libc: Vec<String>,
    pub markers: Option<String>,
    pub group_markers: BTreeMap<String, String>,
    pub python: Option<String>,
    pub groups: BTreeSet<String>,
    pub extras: BTreeSet<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DependencyEdge {
    pub name: String,
    pub target: String,
    pub optional: bool,
    pub dev: bool,
    pub peer: bool,
    pub marker: Option<String>,
    pub group: Option<String>,
    pub extra: Option<String>,
    pub requested_extras: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackageNode {
    pub location: String,
    pub ecosystem: Ecosystem,
    pub name: String,
    pub version: String,
    pub flags: PackageFlags,
    pub dependencies: Vec<DependencyEdge>,
    /// Repository-relative source for a workspace/path/editable dependency.
    pub link: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Importer {
    pub dependencies: Vec<DependencyEdge>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DependencyGraph {
    pub format: String,
    pub nodes: BTreeMap<String, PackageNode>,
    pub importers: BTreeMap<String, Importer>,
    pub selectors: BTreeMap<String, String>,
    /// False when ranges, unsupported resolutions, or missing edges prevent an
    /// exact comparison. Such a graph never establishes verified compatibility.
    pub complete: bool,
    pub notes: Vec<String>,
}

impl DependencyGraph {
    /// Classify dev-only packages by reachability, including transitive
    /// dependencies of uv groups and pnpm importers whose nodes lack dev flags.
    pub fn annotate_dev_reachability(&mut self) {
        let mut queue = std::collections::VecDeque::new();
        let mut seen = BTreeSet::new();
        for importer in self.importers.values() {
            for edge in &importer.dependencies {
                queue.push_back((
                    edge.target.clone(),
                    edge.dev || edge.group.as_deref() == Some("dev"),
                ));
            }
        }
        while let Some((location, dev)) = queue.pop_front() {
            if !seen.insert((location.clone(), dev)) {
                continue;
            }
            if let Some(node) = self.nodes.get(&location) {
                for edge in &node.dependencies {
                    queue.push_back((
                        edge.target.clone(),
                        dev || edge.dev || edge.group.as_deref() == Some("dev"),
                    ));
                }
            }
        }
        for (location, node) in &mut self.nodes {
            if seen.contains(&(location.clone(), true))
                && !seen.contains(&(location.clone(), false))
            {
                node.flags.dev = true;
            }
        }
        let mut queue = std::collections::VecDeque::new();
        let mut groups = BTreeMap::<String, BTreeSet<String>>::new();
        for importer in self.importers.values() {
            for edge in &importer.dependencies {
                queue.push_back((
                    edge.target.clone(),
                    edge.group
                        .clone()
                        .unwrap_or_else(|| if edge.dev { "dev" } else { "main" }.into()),
                ));
            }
        }
        while let Some((location, group)) = queue.pop_front() {
            if !groups
                .entry(location.clone())
                .or_default()
                .insert(group.clone())
            {
                continue;
            }
            if let Some(node) = self.nodes.get(&location) {
                for edge in &node.dependencies {
                    queue.push_back((
                        edge.target.clone(),
                        edge.group.clone().unwrap_or_else(|| group.clone()),
                    ));
                }
            }
        }
        for (location, node) in &mut self.nodes {
            if node.flags.groups.is_empty() {
                node.flags.groups = groups.remove(location).unwrap_or_default();
            }
        }
    }
    pub fn new(format: &str) -> Self {
        Self {
            format: format.into(),
            nodes: BTreeMap::new(),
            importers: BTreeMap::new(),
            selectors: BTreeMap::new(),
            complete: true,
            notes: Vec::new(),
        }
    }
    pub fn unverified(&mut self, message: impl Into<String>) {
        self.complete = false;
        self.notes.push(message.into());
    }
    pub fn flattened(&self) -> BTreeSet<(Ecosystem, String, String)> {
        self.nodes
            .values()
            .filter(|node| node.link.is_none() && !node.version.is_empty())
            .map(|node| (node.ecosystem, node.name.clone(), node.version.clone()))
            .collect()
    }
    pub fn hash(&self) -> Result<String> {
        Ok(blake3::hash(&serde_json::to_vec(self)?)
            .to_hex()
            .to_string())
    }
    pub fn changed_packages(&self, base: &Self) -> BTreeSet<(Ecosystem, String, String)> {
        self.flattened()
            .difference(&base.flattened())
            .cloned()
            .collect()
    }
}

pub fn normalize_python_name(name: &str) -> String {
    let mut result = String::new();
    for c in name.chars() {
        if matches!(c, '-' | '_' | '.') {
            if !result.ends_with('-') {
                result.push('-');
            }
        } else {
            result.push(c.to_ascii_lowercase());
        }
    }
    result
}

pub fn parse_lockfile(filename: &str, content: &str) -> Result<DependencyGraph> {
    let name = filename.rsplit('/').next().unwrap_or(filename);
    let mut graph = match name {
        "package-lock.json" | "npm-shrinkwrap.json" | ".package-lock.json" => {
            super::npm::parse(content)
        }
        "pnpm-lock.yaml" => super::pnpm::parse(content),
        "yarn.lock" => super::yarn::parse(content),
        "Cargo.lock" => super::cargo::parse(content),
        "uv.lock" | "poetry.lock" | "Pipfile.lock" => super::python::parse(name, content),
        name if name.starts_with("requirements") && name.ends_with(".txt") => {
            super::python::requirements(content)
        }
        _ => bail!("unsupported lockfile: {filename}"),
    }?;
    graph.annotate_dev_reachability();
    Ok(graph)
}

pub(super) fn strings(value: &Value) -> Vec<String> {
    match value {
        Value::Array(values) => values
            .iter()
            .filter_map(|value| value.as_str().map(str::to_owned))
            .collect(),
        Value::String(value) => vec![value.clone()],
        _ => Vec::new(),
    }
}

pub(super) fn node(
    location: String,
    name: String,
    version: String,
    ecosystem: Ecosystem,
) -> PackageNode {
    PackageNode {
        location,
        ecosystem,
        name,
        version,
        flags: PackageFlags::default(),
        dependencies: Vec::new(),
        link: None,
    }
}

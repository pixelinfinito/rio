use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    path::Path,
};

use super::{
    DependencyEdge, DependencyEnvironment, DependencyGraph, Ecosystem, EffectiveGraph, Importer,
    Installation, installation::join, npm::resolve_location, parse_lockfile,
};
use anyhow::{Context, Result};
use rio_core::DependencyState;
use rio_git::{Tree, changed_paths, dependency_state_hash};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Compatibility {
    Verified { hash: String },
    Trusted { hash: String, hint: String },
    Mismatch { hint: String },
    Unverified { hint: String },
}

impl Compatibility {
    pub fn dependency_state(&self) -> Option<DependencyState> {
        match self {
            Self::Verified { .. } => Some(DependencyState::Verified),
            Self::Trusted { .. } => Some(DependencyState::Trusted),
            _ => None,
        }
    }
    pub fn can_run(&self) -> bool {
        self.dependency_state().is_some()
    }
    pub fn can_classify_baseline(&self) -> bool {
        matches!(self, Self::Verified { .. })
    }
    pub fn hint(&self) -> Option<&str> {
        match self {
            Self::Verified { .. } => None,
            Self::Trusted { hint, .. } | Self::Mismatch { hint } | Self::Unverified { hint } => {
                Some(hint)
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct GoverningLockfile {
    pub path: String,
    pub root: String,
    pub importer: String,
    pub graph: DependencyGraph,
}

/// The caller supplies workspace membership discovered from project manifests.
/// Merely being an ancestor never makes an unrelated project govern a root.
pub fn governing_lockfile(
    tree: &Tree,
    root: &str,
    workspace: Option<&str>,
    ecosystem: Ecosystem,
) -> Result<Option<GoverningLockfile>> {
    for directory in std::iter::once(root).chain(workspace.filter(|workspace| *workspace != root)) {
        let mut names = match ecosystem {
            Ecosystem::Npm => vec![
                "npm-shrinkwrap.json".to_owned(),
                "package-lock.json".to_owned(),
                "pnpm-lock.yaml".to_owned(),
                "yarn.lock".to_owned(),
            ],
            Ecosystem::PyPi => vec![
                "uv.lock".to_owned(),
                "poetry.lock".to_owned(),
                "Pipfile.lock".to_owned(),
            ],
        };
        if ecosystem == Ecosystem::Npm {
            if let Some(manifest) = tree.get(&join(directory, "package.json")) {
                let value: Value = serde_json::from_slice(&manifest.content)?;
                if let Some(manager) = value["packageManager"].as_str() {
                    let preferred = if manager.starts_with("pnpm@") {
                        "pnpm-lock.yaml"
                    } else if manager.starts_with("yarn@") {
                        "yarn.lock"
                    } else {
                        "package-lock.json"
                    };
                    names.sort_by_key(|name| name != preferred);
                }
            }
        } else {
            let prefix = if directory.is_empty() || directory == "." {
                String::new()
            } else {
                format!("{directory}/")
            };
            names.extend(
                tree.keys()
                    .filter_map(|path| path.strip_prefix(&prefix))
                    .filter(|path| {
                        !path.contains('/')
                            && path.starts_with("requirements")
                            && path.ends_with(".txt")
                    })
                    .map(str::to_owned),
            );
        }
        for name in names {
            let path = join(directory, &name);
            if let Some(entry) = tree.get(&path) {
                let text = std::str::from_utf8(&entry.content)?;
                let mut graph =
                    parse_lockfile(&name, text).with_context(|| format!("cannot parse {path}"))?;
                if graph.format == "poetry"
                    && let Some(manifest) = tree.get(&join(directory, "pyproject.toml"))
                {
                    let manifest: toml::Value =
                        toml::from_str(std::str::from_utf8(&manifest.content)?)?;
                    super::python::poetry_importer(&mut graph, &serde_json::to_value(manifest)?)?;
                }
                if graph.format.starts_with("yarn") {
                    graph.add_yarn_importers(tree, directory)?;
                }
                let importer = if root == directory {
                    ".".into()
                } else {
                    root.strip_prefix(&format!("{directory}/"))
                        .unwrap_or(root)
                        .into()
                };
                return Ok(Some(GoverningLockfile {
                    path,
                    root: directory.into(),
                    importer,
                    graph,
                }));
            }
        }
    }
    Ok(None)
}

impl DependencyGraph {
    /// Yarn classic records selectors, not workspace roots; Berry also needs the
    /// manifests to distinguish production, development and optional requests.
    pub fn add_yarn_importers(&mut self, tree: &Tree, workspace_root: &str) -> Result<()> {
        let prefix = if workspace_root == "." || workspace_root.is_empty() {
            String::new()
        } else {
            format!("{workspace_root}/")
        };
        let mut workspace_patterns = globset::GlobSetBuilder::new();
        if let Some(root_manifest) = tree.get(&join(workspace_root, "package.json")) {
            let value: Value = serde_json::from_slice(&root_manifest.content)?;
            let members = value["workspaces"]
                .as_array()
                .or_else(|| value["workspaces"]["packages"].as_array());
            if let Some(members) = members {
                for member in members.iter().filter_map(Value::as_str) {
                    workspace_patterns.add(globset::Glob::new(member)?);
                }
            }
        }
        let workspace_patterns = workspace_patterns.build()?;
        let mut manifests = Vec::new();
        for (path, entry) in tree.iter().filter(|(path, _)| {
            (path.as_str() == "package.json" || path.ends_with("/package.json"))
                && path.starts_with(&prefix)
                && !path.split('/').any(|part| part == "node_modules")
        }) {
            let root = path.strip_suffix("/package.json").unwrap_or(".");
            let importer = root.strip_prefix(&prefix).unwrap_or(root);
            if importer != "." && !workspace_patterns.is_match(importer) {
                continue;
            }
            let value: Value = serde_json::from_slice(&entry.content)?;
            if let Some(name) = value["name"].as_str() {
                let existing = self
                    .nodes
                    .values()
                    .find(|node| node.name == name && node.link.as_deref() == Some(importer))
                    .map(|node| node.location.clone());
                if existing.is_none() {
                    let location = format!("{name}@workspace:{importer}");
                    let mut node = super::lockfiles::node(
                        location.clone(),
                        name.into(),
                        value["version"].as_str().unwrap_or_default().into(),
                        Ecosystem::Npm,
                    );
                    node.link = Some(importer.into());
                    self.nodes.insert(location, node);
                }
            }
            manifests.push((root.to_owned(), importer.to_owned(), value));
        }
        for (root, importer, value) in manifests {
            let mut dependencies = Vec::new();
            for (kind, dev, optional) in [
                ("dependencies", false, false),
                ("devDependencies", true, false),
                ("optionalDependencies", false, true),
            ] {
                if let Some(requests) = value[kind].as_object() {
                    for (name, request) in requests {
                        let request = request
                            .as_str()
                            .context("dependency range must be a string")?;
                        let selector = format!("{name}@{request}");
                        let target = self
                            .selectors
                            .get(&selector)
                            .or_else(|| self.selectors.get(&format!("{name}@npm:{request}")))
                            .cloned()
                            .or_else(|| {
                                self.nodes
                                    .values()
                                    .find(|node| {
                                        node.name == *name
                                            && node.link.is_some()
                                            && (request.starts_with("workspace:")
                                                || node_semver::Range::parse(request)
                                                    .ok()
                                                    .zip(
                                                        node_semver::Version::parse(&node.version)
                                                            .ok(),
                                                    )
                                                    .is_some_and(|(range, version)| {
                                                        range.satisfies(&version)
                                                    }))
                                    })
                                    .map(|node| node.location.clone())
                            });
                        if let Some(target) = target {
                            dependencies.push(DependencyEdge {
                                name: name.clone(),
                                target,
                                dev,
                                optional,
                                ..Default::default()
                            });
                        } else if !optional {
                            self.unverified(format!(
                                "unresolved yarn request {selector} in {root}"
                            ));
                        }
                    }
                }
            }
            self.importers.insert(importer, Importer { dependencies });
        }
        let links: Vec<_> = self
            .nodes
            .iter()
            .filter_map(|(location, node)| {
                node.link
                    .as_ref()
                    .map(|source| (location.clone(), source.clone()))
            })
            .collect();
        for (location, source) in links {
            if let Some(importer) = self.importers.get(&source) {
                self.nodes.get_mut(&location).unwrap().dependencies = importer
                    .dependencies
                    .iter()
                    .filter(|edge| !edge.dev)
                    .cloned()
                    .collect();
            }
        }
        self.annotate_dev_reachability();
        Ok(())
    }
}

fn compare_yarn(
    graph: &DependencyGraph,
    effective: &EffectiveGraph,
    installation: &Installation,
    importer_path: &str,
) -> Option<String> {
    let mut queue = VecDeque::new();
    for edge in &graph.importers[&effective.importer].dependencies {
        queue.push_back((
            edge.target.clone(),
            edge.name.clone(),
            importer_path.to_owned(),
        ));
    }
    let mut visited = BTreeSet::new();
    while let Some((target, name, from)) = queue.pop_front() {
        if !visited.insert((target.clone(), name.clone(), from.clone())) {
            continue;
        }
        let Some(expected) = effective.nodes.get(&target) else {
            continue;
        };
        let Some(location) = resolve_location(&installation.nodes, &from, &name) else {
            if expected.required && installation.absence_known {
                return Some(format!(
                    "missing {name} required by {from}; run the project's package manager install command"
                ));
            }
            continue;
        };
        let actual = &installation.nodes[&location];
        if actual.name != expected.package.name
            || (expected.package.link.is_none() && actual.version != expected.package.version)
        {
            return Some(format!(
                "{location}: expected {}@{}, installed {}@{}; reinstall dependencies",
                expected.package.name, expected.package.version, actual.name, actual.version
            ));
        }
        for edge in &expected.package.dependencies {
            queue.push_back((edge.target.clone(), edge.name.clone(), location.clone()));
        }
    }
    None
}

pub struct CompatibilityRequest<'a> {
    pub worktree: &'a Path,
    pub working: &'a Tree,
    pub selected: &'a Tree,
    pub project_root: &'a str,
    pub lockfile: Option<&'a GoverningLockfile>,
    pub installation: &'a Installation,
    pub environment: &'a DependencyEnvironment,
    pub trust: bool,
}

pub fn check_compatibility(request: CompatibilityRequest<'_>) -> Compatibility {
    compatibility(request, false)
}

/// Base source links are redirected into the disposable base tree before tools
/// run. Installation graph mismatches still prevent classification.
pub fn check_base_compatibility(request: CompatibilityRequest<'_>) -> Compatibility {
    compatibility(request, true)
}

fn compatibility(request: CompatibilityRequest<'_>, remap: bool) -> Compatibility {
    let mut inputs = request.installation.fingerprints.clone();
    let mut unverified = Vec::new();
    let hash = |inputs: &BTreeMap<String, Vec<u8>>| dependency_state_hash(inputs);
    let unknown = |reason: String, inputs: &BTreeMap<String, Vec<u8>>| {
        let hint = format!(
            "{reason}; installed dependencies cannot be verified (set trust_installed_dependencies to run anyway)"
        );
        if request.trust {
            Compatibility::Trusted {
                hash: hash(inputs),
                hint,
            }
        } else {
            Compatibility::Unverified { hint }
        }
    };
    let Some(lockfile) = request.lockfile else {
        return unknown("no lockfile in the selected tree".into(), &inputs);
    };
    let mut environment = request.environment.clone();
    environment.omit_dev |= request.installation.omit_dev;
    environment
        .groups
        .extend(request.installation.groups.clone());
    environment
        .extras
        .extend(request.installation.extras.clone());
    inputs.insert("platform".into(), format!("{environment:?}").into_bytes());
    let effective = match lockfile.graph.effective(&lockfile.importer, &environment) {
        Ok(effective) => effective,
        Err(error) => return unknown(format!("{}: {error}", lockfile.path), &inputs),
    };
    // Linked source differences are known mismatches even if other installation
    // metadata is absent. Trust must never mask them.
    let canonical_worktree = request
        .worktree
        .canonicalize()
        .unwrap_or_else(|_| request.worktree.to_path_buf());
    for (name, target) in &request.installation.links {
        let Ok(relative) = target.strip_prefix(&canonical_worktree) else {
            continue;
        };
        let relative = relative.to_string_lossy().replace('\\', "/");
        let linked_name = super::npm::install_name(name);
        let expected = effective
            .nodes
            .values()
            .find(|node| node.package.location == *name || node.package.name == linked_name);
        let own_root = relative
            == if request.project_root == "." {
                ""
            } else {
                request.project_root
            }
            || (relative.is_empty() && request.project_root == ".");
        if expected.is_none()
            && !own_root
            && !name.ends_with(".pth")
            && !name.ends_with(".egg-link")
        {
            continue;
        }
        if let Some(expected_source) = expected.and_then(|node| node.package.link.as_deref()) {
            let expected_source =
                super::python::normalize_relative(&lockfile.root, expected_source);
            let actual_source = if relative.is_empty() { "." } else { &relative };
            if actual_source != expected_source {
                return Compatibility::Mismatch {
                    hint: format!(
                        "linked dependency {name}: expected {expected_source}, installed link targets {actual_source}"
                    ),
                };
            }
        }
        let prefix = if relative.is_empty() {
            String::new()
        } else {
            format!("{relative}/")
        };
        if let Some(path) = changed_paths(request.working, request.selected)
            .into_iter()
            .find(|path| path.starts_with(&prefix))
        {
            if !remap {
                return Compatibility::Mismatch {
                    hint: format!(
                        "linked dependency {name} points at changed source {relative}: {path}; make the installed source match the selected head"
                    ),
                };
            }
            if let Some(hint) = missing_build_output(request.selected, &relative, name) {
                return Compatibility::Mismatch { hint };
            }
        }
        for (path, entry) in request
            .selected
            .iter()
            .filter(|(path, _)| path.starts_with(&prefix))
        {
            let mut content = entry.mode.to_le_bytes().to_vec();
            content.extend(&entry.content);
            inputs.insert(format!("linked/{path}"), content);
        }
    }
    // Yarn checks actual Node resolution for every edge, including nested
    // packages. npm and pnpm lockfiles already encode resolution locations.
    let mismatch = if lockfile.graph.format.starts_with("yarn") {
        compare_yarn(
            &lockfile.graph,
            &effective,
            request.installation,
            request.project_root,
        )
    } else {
        let mut mismatch = None;
        for (location, expected) in &effective.nodes {
            let key = if expected.package.ecosystem == Ecosystem::PyPi {
                expected.package.name.clone()
            } else if lockfile.graph.format == "npm" {
                join(&lockfile.root, location)
            } else {
                location.clone()
            };
            match request.installation.nodes.get(&key) {
                Some(actual)
                    if actual.name != expected.package.name
                        || (expected.package.link.is_none()
                            && actual.version != expected.package.version) =>
                {
                    mismatch = Some(format!(
                        "{key}: expected {}@{}, installed {}@{}; reinstall dependencies (npm install, pnpm install or the Python environment sync command)",
                        expected.package.name,
                        expected.package.version,
                        actual.name,
                        actual.version
                    ));
                    break;
                }
                None if expected.required && request.installation.absence_known => {
                    mismatch = Some(format!(
                        "missing {} at {key}; reinstall dependencies",
                        expected.package.name
                    ));
                    break;
                }
                _ => {}
            }
        }
        if mismatch.is_none()
            && lockfile.graph.format == "pnpm"
            && let Some(installed) = request.installation.resolutions.get(&lockfile.importer)
        {
            for edge in &lockfile.graph.importers[&lockfile.importer].dependencies {
                if installed
                    .get(&edge.name)
                    .is_some_and(|target| target != &edge.target)
                {
                    mismatch = Some(format!(
                        "pnpm importer {} resolves {} differently; run pnpm install",
                        lockfile.importer, edge.name
                    ));
                    break;
                }
            }
        }
        mismatch
    };
    if let Some(hint) = mismatch {
        return Compatibility::Mismatch {
            hint: format!("{}: {hint}", lockfile.path),
        };
    }
    inputs.insert(
        "effective-graph".into(),
        serde_json::to_vec(&effective).expect("effective graph contains only serializable values"),
    );
    if !effective.complete {
        unverified.extend(effective.notes);
    }
    if !request.installation.complete {
        unverified.extend(request.installation.notes.clone());
    }
    if !unverified.is_empty() {
        return unknown(unverified.join("; "), &inputs);
    }
    Compatibility::Verified {
        hash: hash(&inputs),
    }
}

// Entry points can be conditional exports or arrays, as well as main/types.
pub(super) fn missing_build_output(tree: &Tree, root: &str, name: &str) -> Option<String> {
    let manifest = tree.get(&join(root, "package.json"))?;
    let manifest: Value = serde_json::from_slice(&manifest.content).ok()?;
    fn strings(value: &Value, result: &mut Vec<String>) {
        match value {
            Value::String(value) => result.push(value.clone()),
            Value::Array(values) => values.iter().for_each(|value| strings(value, result)),
            Value::Object(values) => values.values().for_each(|value| strings(value, result)),
            _ => {}
        }
    }
    let mut entries = Vec::new();
    for key in [
        "main",
        "module",
        "types",
        "typings",
        "exports",
        "typesVersions",
    ] {
        strings(&manifest[key], &mut entries);
    }
    for entry in entries {
        let entry = entry.trim_start_matches("./");
        let directory = entry.split('/').next()?;
        if !entry.contains('/') || directory == "src" || directory == ".." {
            continue;
        }
        let prefix = format!("{}/", join(root, directory));
        if !tree.keys().any(|path| path.starts_with(&prefix)) {
            return Some(format!(
                "linked package {name} is consumed through build output {directory}/ that is not in the tree; run the build in the base or configure source entry points"
            ));
        }
    }
    None
}

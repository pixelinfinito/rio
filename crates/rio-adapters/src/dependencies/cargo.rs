use super::{
    Compatibility, DependencyEdge, DependencyGraph, Ecosystem, GoverningLockfile, Importer,
};
use anyhow::{Context, Result, ensure};
use rio_git::Tree;
use std::collections::{BTreeMap, BTreeSet, VecDeque};

pub(super) fn parse(content: &str) -> Result<DependencyGraph> {
    let value: toml::Value = toml::from_str(content)?;
    ensure!(
        matches!(
            value.get("version").and_then(toml::Value::as_integer),
            Some(3 | 4)
        ),
        "Cargo.lock must use version 3 or 4"
    );
    let packages = value
        .get("package")
        .and_then(toml::Value::as_array)
        .context("Cargo.lock has no package array")?;
    let mut graph = DependencyGraph::new("cargo");
    let mut records = Vec::new();
    for package in packages {
        let name = package
            .get("name")
            .and_then(toml::Value::as_str)
            .context("Cargo package missing name")?;
        let version = package
            .get("version")
            .and_then(toml::Value::as_str)
            .context("Cargo package missing version")?;
        let source = package.get("source").and_then(toml::Value::as_str);
        let location = format!("{name} {version} ({})", source.unwrap_or("path"));
        let mut node = super::lockfiles::node(
            location.clone(),
            name.into(),
            version.into(),
            Ecosystem::CratesIo,
        );
        if source != Some("registry+https://github.com/rust-lang/crates.io-index")
            && source != Some("sparse+https://index.crates.io/")
        {
            let reason = if source.is_none() {
                "path_source"
            } else if source.is_some_and(|source| source.starts_with("git+")) {
                "git_source"
            } else {
                "registry_source"
            };
            node.link = Some(source.unwrap_or("path").into());
            graph
                .notes
                .push(format!("unauditable: {name}@{version}: {reason}"));
        }
        ensure!(
            graph.nodes.insert(location.clone(), node).is_none(),
            "duplicate Cargo package"
        );
        records.push((location, package));
    }
    for (location, package) in records {
        let mut edges = Vec::new();
        for dependency in package
            .get("dependencies")
            .and_then(toml::Value::as_array)
            .into_iter()
            .flatten()
        {
            let dependency = dependency
                .as_str()
                .context("Cargo dependency must be a string")?;
            let mut parts = dependency.splitn(3, ' ');
            let name = parts.next().unwrap();
            let version = parts.next();
            let source = parts.next().map(|value| value.trim_matches(['(', ')']));
            let candidates: Vec<_> = graph
                .nodes
                .values()
                .filter(|node| {
                    node.name == name
                        && version.is_none_or(|version| node.version == version)
                        && source
                            .is_none_or(|source| node.location.ends_with(&format!("({source})")))
                })
                .collect();
            ensure!(
                candidates.len() == 1,
                "Cargo dependency {dependency} is missing or ambiguous"
            );
            edges.push(DependencyEdge {
                name: name.into(),
                target: candidates[0].location.clone(),
                ..Default::default()
            });
        }
        graph.nodes.get_mut(&location).unwrap().dependencies = edges;
    }
    Ok(graph)
}

/// Cargo.lock records resolution; manifests supply dev and optional edge flags.
pub fn annotate_cargo_manifests(
    graph: &mut DependencyGraph,
    tree: &Tree,
    lock_root: &str,
) -> Result<()> {
    let prefix = if lock_root == "." {
        String::new()
    } else {
        format!("{lock_root}/")
    };
    let workspace_manifest = if lock_root == "." {
        "Cargo.toml".into()
    } else {
        format!("{lock_root}/Cargo.toml")
    };
    let workspace: toml::Value = tree
        .get(&workspace_manifest)
        .map(|entry| -> Result<toml::Value> {
            Ok(toml::from_str(std::str::from_utf8(&entry.content)?)?)
        })
        .transpose()?
        .unwrap_or(toml::Value::Table(Default::default()));
    for (path, entry) in tree.iter().filter(|(path, _)| {
        (path.as_str() == "Cargo.toml" || path.ends_with("/Cargo.toml"))
            && path.starts_with(&prefix)
    }) {
        // Repositories carry invalid manifests as test fixtures; they are not path
        // dependencies and must not fail the whole dependency analysis.
        let Some(value) = std::str::from_utf8(&entry.content)
            .ok()
            .and_then(|text| toml::from_str::<toml::Value>(text).ok())
        else {
            continue;
        };
        let Some(name) = value
            .get("package")
            .and_then(|package| package.get("name"))
            .and_then(toml::Value::as_str)
        else {
            continue;
        };
        let Some(location) = graph
            .nodes
            .values()
            .find(|node| node.name == name && node.link.as_deref() == Some("path"))
            .map(|node| node.location.clone())
        else {
            continue;
        };
        let root = path.strip_suffix("/Cargo.toml").unwrap_or(".");
        let importer = if root == lock_root {
            "."
        } else {
            root.strip_prefix(&prefix).unwrap_or(root)
        };
        let mut flags = BTreeMap::<String, (bool, bool)>::new();
        let mut declarations = vec![&value];
        declarations.extend(
            value
                .get("target")
                .and_then(toml::Value::as_table)
                .into_iter()
                .flat_map(|targets| targets.values()),
        );
        for declaration in declarations {
            for (key, dev) in [
                ("dependencies", false),
                ("dev-dependencies", true),
                ("build-dependencies", false),
            ] {
                for (alias, requirement) in declaration
                    .get(key)
                    .and_then(toml::Value::as_table)
                    .into_iter()
                    .flatten()
                {
                    let inherited =
                        requirement.get("workspace").and_then(toml::Value::as_bool) == Some(true);
                    let effective = if inherited {
                        workspace
                            .get("workspace")
                            .and_then(|value| value.get("dependencies"))
                            .and_then(|value| value.get(alias))
                            .unwrap_or(requirement)
                    } else {
                        requirement
                    };
                    let package = effective
                        .get("package")
                        .and_then(toml::Value::as_str)
                        .unwrap_or(alias);
                    let optional = requirement
                        .get("optional")
                        .and_then(toml::Value::as_bool)
                        .unwrap_or(false);
                    flags
                        .entry(package.into())
                        .and_modify(|flags| {
                            flags.0 &= dev;
                            flags.1 &= optional;
                        })
                        .or_insert((dev, optional));
                }
            }
        }
        let node = graph.nodes.get_mut(&location).unwrap();
        node.link = Some(root.into());
        for edge in &mut node.dependencies {
            if let Some((dev, optional)) = flags.get(&edge.name) {
                edge.dev = *dev;
                edge.optional = *optional;
            }
        }
        graph.importers.insert(
            importer.into(),
            Importer {
                dependencies: vec![DependencyEdge {
                    name: name.into(),
                    target: location,
                    ..Default::default()
                }],
            },
        );
    }
    // A virtual workspace root reviews the union of member closures.
    if !graph.importers.contains_key(".") {
        let dependencies = graph
            .importers
            .values()
            .flat_map(|importer| importer.dependencies.clone())
            .collect();
        graph
            .importers
            .insert(".".into(), Importer { dependencies });
    }
    for node in graph.nodes.values().cloned().collect::<Vec<_>>() {
        for edge in node.dependencies {
            if let Some(target) = graph.nodes.get_mut(&edge.target) {
                target.flags.optional |= edge.optional;
            }
        }
    }
    graph.annotate_dev_reachability();
    Ok(())
}

pub fn cargo_closure(lock: &GoverningLockfile) -> Result<BTreeMap<String, String>> {
    ensure!(lock.graph.complete, "Cargo.lock graph is incomplete");
    let importer = lock
        .graph
        .importers
        .get(&lock.importer)
        .context("Cargo.lock has no matching workspace member")?;
    let mut queue: VecDeque<_> = importer
        .dependencies
        .iter()
        .map(|edge| edge.target.clone())
        .collect();
    let mut seen = BTreeSet::new();
    let mut result = BTreeMap::new();
    while let Some(location) = queue.pop_front() {
        if !seen.insert(location.clone()) {
            continue;
        }
        let node = lock
            .graph
            .nodes
            .get(&location)
            .context("missing Cargo dependency node")?;
        // Global reachability flags can change through an unrelated importer.
        // Only this member's resolved nodes and edges establish compatibility.
        let mut resolved = node.clone();
        resolved.flags = Default::default();
        result.insert(location.clone(), serde_json::to_string(&resolved)?);
        queue.extend(node.dependencies.iter().map(|edge| edge.target.clone()));
    }
    Ok(result)
}

pub fn cargo_compatibility(
    head: Option<&GoverningLockfile>,
    base: Option<&GoverningLockfile>,
    toolchain_installed: bool,
    channel: &str,
    trust: bool,
) -> (Compatibility, Compatibility) {
    let graph = head.map(cargo_closure).transpose();
    let problem = if !toolchain_installed {
        Some(format!(
            "Rust toolchain {channel} is not installed; run rustup toolchain install {channel}"
        ))
    } else {
        match &graph {
            Ok(Some(_)) => None,
            Ok(None) => Some("no Cargo.lock; Rust dependencies cannot be verified".into()),
            Err(error) => Some(format!("cannot verify Cargo.lock: {error:#}")),
        }
    };
    let current = graph.ok().flatten().unwrap_or_default();
    let hash = blake3::hash(&serde_json::to_vec(&current).unwrap())
        .to_hex()
        .to_string();
    let head = match problem {
        None => Compatibility::Verified { hash: hash.clone() },
        Some(hint) if trust => Compatibility::Trusted {
            hash: hash.clone(),
            hint: format!("{hint}; dependencies_trusted"),
        },
        Some(hint) => Compatibility::Unverified {
            hint: format!("{hint}; set trust_installed_dependencies to run anyway"),
        },
    };
    let previous = base.map(cargo_closure).transpose();
    let base = match previous {
        Ok(Some(previous)) if previous == current && head.can_run() => {
            Compatibility::Verified { hash }
        }
        Ok(Some(previous)) => {
            let changed = current
                .keys()
                .chain(previous.keys())
                .find(|key| current.get(*key) != previous.get(*key))
                .cloned()
                .unwrap_or_else(|| "toolchain".into());
            Compatibility::Mismatch {
                hint: format!("Cargo.lock dependency changed: {changed}"),
            }
        }
        Ok(None) => Compatibility::Unverified {
            hint: "base has no Cargo.lock".into(),
        },
        Err(error) => Compatibility::Unverified {
            hint: format!("cannot verify base Cargo.lock: {error:#}"),
        },
    };
    (head, base)
}

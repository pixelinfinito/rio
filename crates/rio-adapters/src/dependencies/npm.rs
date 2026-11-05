use super::{
    DependencyEdge, DependencyGraph, Ecosystem, Importer,
    lockfiles::{node, strings},
};
use anyhow::{Context, Result, ensure};
use serde_json::Value;
use std::collections::BTreeMap;

pub(super) fn install_name(location: &str) -> &str {
    location
        .rsplit_once("node_modules/")
        .map_or(location, |(_, name)| name)
}

pub(super) fn resolve_location(
    nodes: &BTreeMap<String, super::PackageNode>,
    from: &str,
    name: &str,
) -> Option<String> {
    let mut directory = from;
    loop {
        let candidate = if directory.is_empty() {
            format!("node_modules/{name}")
        } else {
            format!("{directory}/node_modules/{name}")
        };
        if nodes.contains_key(&candidate) {
            return Some(candidate);
        }
        if directory.is_empty() {
            return None;
        }
        directory = directory.rsplit_once('/').map_or("", |(parent, _)| parent);
        if directory.ends_with("node_modules") {
            directory = directory.rsplit_once('/').map_or("", |(parent, _)| parent);
        }
    }
}

pub(super) fn parse(content: &str) -> Result<DependencyGraph> {
    let value: Value = serde_json::from_str(content)?;
    ensure!(
        matches!(value["lockfileVersion"].as_u64(), Some(2 | 3)),
        "only npm lockfile versions 2 and 3 are supported"
    );
    let packages = value["packages"]
        .as_object()
        .context("npm lockfile has no packages table")?;
    let mut graph = DependencyGraph::new("npm");
    for (location, package) in packages {
        if location.is_empty() || !location.split('/').any(|p| p == "node_modules") {
            continue;
        }
        let mut entry = node(
            location.clone(),
            package["name"]
                .as_str()
                .unwrap_or(install_name(location))
                .into(),
            package["version"].as_str().unwrap_or_default().into(),
            Ecosystem::Npm,
        );
        entry.flags.dev = package["dev"].as_bool().unwrap_or(false);
        entry.flags.optional = package["optional"].as_bool().unwrap_or(false)
            || package["devOptional"].as_bool().unwrap_or(false);
        entry.flags.peer = package["peer"].as_bool().unwrap_or(false);
        entry.flags.os = strings(&package["os"]);
        entry.flags.cpu = strings(&package["cpu"]);
        entry.flags.libc = strings(&package["libc"]);
        if package["link"].as_bool() == Some(true) {
            entry.link = package["resolved"].as_str().map(str::to_owned);
            if let Some(link) = &entry.link
                && let Some(linked) = packages.get(link)
            {
                entry.version = linked["version"].as_str().unwrap_or_default().into();
                entry.name = linked["name"].as_str().unwrap_or(&entry.name).into();
            }
        } else if entry.version.is_empty() {
            graph.unverified(format!("missing installed version at {location}"));
        }
        graph.nodes.insert(location.clone(), entry);
    }
    for (location, package) in packages {
        if package["link"].as_bool() == Some(true) {
            continue;
        }
        let mut dependencies = Vec::new();
        for (kind, dev, optional, peer) in [
            ("dependencies", false, false, false),
            ("devDependencies", true, false, false),
            ("optionalDependencies", false, true, false),
            ("peerDependencies", false, false, true),
        ] {
            // A package's dev dependencies are not installed; importers' are.
            if dev && graph.nodes.contains_key(location) {
                continue;
            }
            if let Some(entries) = package[kind].as_object() {
                for (name, _) in entries {
                    let target = resolve_location(&graph.nodes, location, name);
                    let optional = optional
                        || (peer
                            && package["peerDependenciesMeta"][name]["optional"].as_bool()
                                == Some(true));
                    if target.is_none() && !optional {
                        graph.unverified(format!("unresolved {name} from {location}"));
                    }
                    if let Some(target) = target {
                        dependencies.push(DependencyEdge {
                            name: name.clone(),
                            target,
                            dev,
                            optional,
                            peer,
                            ..Default::default()
                        });
                    }
                }
            }
        }
        // optionalDependencies replaces the matching regular dependency.
        let optional_names: Vec<_> = dependencies
            .iter()
            .filter(|edge| edge.optional)
            .map(|edge| edge.name.clone())
            .collect();
        dependencies.retain(|edge| edge.optional || !optional_names.contains(&edge.name));
        if let Some(entry) = graph.nodes.get_mut(location) {
            entry.dependencies = dependencies;
        } else {
            graph.importers.insert(
                if location.is_empty() {
                    ".".into()
                } else {
                    location.clone()
                },
                Importer { dependencies },
            );
        }
    }
    // A workspace link resolves dependencies in its actual source directory.
    let links: Vec<_> = graph
        .nodes
        .iter()
        .filter_map(|(key, node)| {
            node.link
                .as_ref()
                .map(|target| (key.clone(), target.clone()))
        })
        .collect();
    for (key, target) in links {
        if let Some(importer) = graph.importers.get(&target) {
            graph.nodes.get_mut(&key).unwrap().dependencies = importer
                .dependencies
                .iter()
                .filter(|edge| !edge.dev)
                .cloned()
                .collect();
        }
    }
    Ok(graph)
}

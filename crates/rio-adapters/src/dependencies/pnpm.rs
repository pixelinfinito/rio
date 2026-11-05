use super::{
    DependencyEdge, DependencyGraph, Ecosystem, Importer,
    lockfiles::{node, strings},
};
use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::Value;

fn split_key(key: &str) -> Option<(String, String)> {
    let key = key.trim_start_matches('/').split('(').next()?;
    let at = key
        .rfind('@')
        .filter(|&index| index > 0 && !key[..index].contains('('));
    if let Some(at) = at {
        return Some((key[..at].into(), key[at + 1..].split('(').next()?.into()));
    }
    let (name, version) = key.rsplit_once('/')?;
    Some((name.into(), version.split('_').next()?.into()))
}

fn target(graph: &mut DependencyGraph, importer: &str, name: &str, raw: &Value) -> Option<String> {
    let version = raw.as_str().or_else(|| raw["version"].as_str())?;
    if let Some(relative) = version
        .strip_prefix("link:")
        .or_else(|| version.strip_prefix("workspace:"))
    {
        let key = format!("{importer}::{name}");
        let mut entry = node(key.clone(), name.into(), String::new(), Ecosystem::Npm);
        entry.link = Some(super::python::normalize_relative(importer, relative));
        graph.nodes.insert(key.clone(), entry);
        return Some(key);
    }
    let candidates = [
        format!("{name}@{version}"),
        format!("/{name}@{version}"),
        format!("/{name}/{version}"),
        version.to_owned(),
    ];
    candidates
        .into_iter()
        .find(|key| graph.nodes.contains_key(key))
}

pub(super) fn parse(content: &str) -> Result<DependencyGraph> {
    // pnpm 11/12 prepend an environment/bootstrap lock; the second
    // document is the project graph (pnpm lockfile yaml_documents.rs).
    let mut documents = serde_yaml::Deserializer::from_str(content.trim_start_matches('\u{feff}'));
    let first = documents.next().context("empty pnpm lockfile")?;
    let first = Value::deserialize(first)?;
    let value = match documents.next() {
        Some(main) => Value::deserialize(main)?,
        None => first,
    };
    value
        .get("lockfileVersion")
        .context("pnpm lockfile has no version")?;
    let mut graph = DependencyGraph::new("pnpm");
    let packages = value["packages"].as_object();
    let snapshots = value["snapshots"].as_object().or(packages);
    if let Some(snapshots) = snapshots {
        for (key, snapshot) in snapshots {
            let Some((name, version)) = split_key(key) else {
                graph.unverified(format!("unsupported pnpm snapshot {key}"));
                continue;
            };
            let mut entry = node(key.clone(), name, version, Ecosystem::Npm);
            let metadata = packages
                .and_then(|packages| {
                    packages
                        .get(key)
                        .or_else(|| packages.get(key.split('(').next().unwrap()))
                })
                .unwrap_or(snapshot);
            entry.flags.dev = metadata["dev"].as_bool().unwrap_or(false);
            entry.flags.optional = metadata["optional"].as_bool().unwrap_or(false);
            entry.flags.os = strings(&metadata["os"]);
            entry.flags.cpu = strings(&metadata["cpu"]);
            entry.flags.libc = strings(&metadata["libc"]);
            graph.nodes.insert(key.clone(), entry);
        }
        for (key, snapshot) in snapshots {
            let mut edges = Vec::new();
            for (kind, optional) in [("dependencies", false), ("optionalDependencies", true)] {
                if let Some(dependencies) = snapshot[kind].as_object() {
                    for (name, version) in dependencies {
                        match target(&mut graph, ".", name, version) {
                            Some(target) => edges.push(DependencyEdge {
                                name: name.clone(),
                                target,
                                optional,
                                ..Default::default()
                            }),
                            None if !optional => graph
                                .unverified(format!("unresolved pnpm dependency {name} in {key}")),
                            None => {}
                        }
                    }
                }
            }
            if let Some(entry) = graph.nodes.get_mut(key) {
                entry.dependencies = edges;
            }
        }
    }
    let importers = value["importers"]
        .as_object()
        .cloned()
        .unwrap_or_else(|| [(".".into(), value.clone())].into_iter().collect());
    for (path, importer) in &importers {
        let mut edges = Vec::new();
        for (kind, dev, optional) in [
            ("dependencies", false, false),
            ("devDependencies", true, false),
            ("optionalDependencies", false, true),
        ] {
            if let Some(dependencies) = importer[kind].as_object() {
                for (name, version) in dependencies {
                    match target(&mut graph, path, name, version) {
                        Some(target) => edges.push(DependencyEdge {
                            name: name.clone(),
                            target,
                            dev,
                            optional,
                            ..Default::default()
                        }),
                        None if !optional => {
                            graph.unverified(format!("unresolved pnpm importer {path}: {name}"))
                        }
                        None => {}
                    }
                }
            }
        }
        graph.importers.insert(
            path.clone(),
            Importer {
                dependencies: edges,
            },
        );
    }
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
/// pnpm 10.12.1 packages/dependency-path and pnpm 12.4.1 deps-path use
/// this escaping and SHA-256 prefix (not Rust's platform-dependent hashing).
pub(super) fn dep_path_to_filename(key: &str, max_length: usize) -> String {
    use sha2::{Digest, Sha256};
    let mut filename = key
        .strip_prefix('/')
        .unwrap_or(key)
        .replace(['\\', '/', ':', '*', '?', '"', '<', '>', '|', '#'], "+");
    if filename.contains('(') {
        if filename.ends_with(')') {
            filename.pop();
        }
        filename = filename.replace(")(", "_").replace(['(', ')'], "_");
    }
    if filename.len() > max_length
        || (filename != filename.to_lowercase() && !filename.starts_with("file+"))
    {
        let hash: String = Sha256::digest(filename.as_bytes())
            .iter()
            .take(16)
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let prefix: String = filename
            .chars()
            .take(max_length.saturating_sub(33))
            .collect();
        return format!("{prefix}_{}", &hash[..32]);
    }
    filename
}

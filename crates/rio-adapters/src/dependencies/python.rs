use std::{collections::BTreeSet, str::FromStr};

use super::{
    DependencyEdge, DependencyGraph, Ecosystem, Importer,
    lockfiles::{node, strings},
    normalize_python_name,
};
use anyhow::{Context, Result};
use pep508_rs::{Requirement, VersionOrUrl};
use serde_json::Value;

pub(super) fn normalize_relative(base: &str, relative: &str) -> String {
    let mut parts = Vec::new();
    for part in base.split('/').chain(relative.split('/')) {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    if parts.is_empty() {
        ".".into()
    } else {
        parts.join("/")
    }
}

fn marker(value: &Value) -> Option<String> {
    value["marker"]
        .as_str()
        .or_else(|| value["markers"].as_str())
        .map(str::to_owned)
}

/// Poetry's caret/tilde ranges are converted to PEP 440 bounds before matching
/// lockfile alternatives. Ordinary PEP 440 clauses and unions are preserved.
pub(super) fn poetry_specifiers(input: &str) -> Result<Vec<pep440_rs::VersionSpecifiers>> {
    input
        .split("||")
        .map(|branch| {
            let branch = branch.trim();
            let converted = if branch == "*" {
                String::new()
            } else if branch.starts_with(['^', '~']) && !branch.starts_with("~=") {
                let parts: Vec<u64> = branch[1..]
                    .split('.')
                    .map(str::parse)
                    .collect::<std::result::Result<_, _>>()?;
                let mut upper = parts.clone();
                let index = if branch.starts_with('^') {
                    parts
                        .iter()
                        .position(|&part| part != 0)
                        .unwrap_or(parts.len().saturating_sub(1))
                } else {
                    if parts.len() > 1 { 1 } else { 0 }
                };
                upper[index] = upper[index]
                    .checked_add(1)
                    .context("Poetry version bound is out of range")?;
                for part in &mut upper[index + 1..] {
                    *part = 0;
                }
                format!(
                    ">={},<{}",
                    &branch[1..],
                    upper
                        .iter()
                        .map(ToString::to_string)
                        .collect::<Vec<_>>()
                        .join(".")
                )
            } else if branch.starts_with(|c: char| c.is_ascii_digit()) {
                format!("=={branch}")
            } else {
                branch.into()
            };
            Ok(pep440_rs::VersionSpecifiers::from_str(&converted)?)
        })
        .collect()
}

fn location(name: &str, version: &str, count: usize) -> String {
    if count > 1 {
        format!("{name}=={version}")
    } else {
        name.into()
    }
}

fn find_targets(graph: &DependencyGraph, name: &str, exact: Option<&str>) -> Vec<String> {
    let name = normalize_python_name(name);
    graph
        .nodes
        .values()
        .filter(|node| node.name == name && exact.is_none_or(|version| version == node.version))
        .map(|node| node.location.clone())
        .collect()
}

fn uv_edges(
    graph: &mut DependencyGraph,
    dependencies: &Value,
    group: Option<&str>,
    extra: Option<&str>,
) -> Vec<DependencyEdge> {
    let mut edges = Vec::new();
    if let Some(dependencies) = dependencies.as_array() {
        for dependency in dependencies {
            let Some(name) = dependency["name"].as_str() else {
                graph.unverified("uv dependency has no name");
                continue;
            };
            let targets = find_targets(graph, name, dependency["version"].as_str());
            if targets.is_empty() {
                graph.unverified(format!("unresolved uv dependency {name}"));
            }
            for target in targets {
                edges.push(DependencyEdge {
                    name: normalize_python_name(name),
                    target,
                    marker: marker(dependency),
                    requested_extras: strings(&dependency["extra"]).into_iter().collect(),
                    group: group.map(str::to_owned),
                    extra: extra.map(str::to_owned),
                    dev: group == Some("dev"),
                    optional: extra.is_some(),
                    ..Default::default()
                });
            }
        }
    }
    edges
}

fn uv(value: &Value) -> Result<DependencyGraph> {
    let packages = value["package"]
        .as_array()
        .context("uv.lock has no package entries")?;
    let mut graph = DependencyGraph::new("uv");
    for package in packages {
        let name =
            normalize_python_name(package["name"].as_str().context("uv package has no name")?);
        let version = package["version"].as_str().unwrap_or_default();
        let count = packages
            .iter()
            .filter(|other| {
                other["name"]
                    .as_str()
                    .is_some_and(|other| normalize_python_name(other) == name)
            })
            .count();
        let key = location(&name, version, count);
        let mut entry = node(key.clone(), name, version.into(), Ecosystem::PyPi);
        entry.flags.markers = match package["resolution-markers"].as_array() {
            Some(markers) => Some(
                markers
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|marker| format!("({marker})"))
                    .collect::<Vec<_>>()
                    .join(" or "),
            ),
            None => marker(package),
        };
        entry.link = package["source"]["editable"]
            .as_str()
            .or_else(|| package["source"]["virtual"].as_str())
            .or_else(|| package["source"]["directory"].as_str())
            .map(str::to_owned);
        graph.nodes.insert(key, entry);
    }
    for package in packages {
        let name = normalize_python_name(package["name"].as_str().unwrap());
        let key = find_targets(&graph, &name, package["version"].as_str())[0].clone();
        let mut edges = uv_edges(&mut graph, &package["dependencies"], None, None);
        for (field, extras) in [("dev-dependencies", false), ("optional-dependencies", true)] {
            if let Some(groups) = package[field].as_object() {
                for (group, dependencies) in groups {
                    edges.extend(uv_edges(
                        &mut graph,
                        dependencies,
                        (!extras).then_some(group.as_str()),
                        extras.then_some(group.as_str()),
                    ));
                }
            }
        }
        let entry = graph.nodes.get_mut(&key).unwrap();
        entry.dependencies = edges
            .iter()
            .filter(|edge| edge.group.is_none())
            .cloned()
            .collect();
        if let Some(root) = &entry.link {
            graph.importers.insert(
                root.clone(),
                Importer {
                    dependencies: edges,
                },
            );
        }
    }
    // Without a project package (an environment lock), every package is a root.
    if graph.importers.is_empty() {
        graph.importers.insert(
            ".".into(),
            Importer {
                dependencies: graph
                    .nodes
                    .values()
                    .map(|node| DependencyEdge {
                        name: node.name.clone(),
                        target: node.location.clone(),
                        ..Default::default()
                    })
                    .collect(),
            },
        );
    }
    Ok(graph)
}

fn poetry(value: &Value) -> Result<DependencyGraph> {
    let packages = value["package"]
        .as_array()
        .context("poetry.lock has no packages")?;
    let mut graph = DependencyGraph::new("poetry");
    for package in packages {
        let name = normalize_python_name(
            package["name"]
                .as_str()
                .context("poetry package has no name")?,
        );
        let version = package["version"]
            .as_str()
            .context("poetry package has no version")?;
        let count = packages
            .iter()
            .filter(|other| {
                other["name"]
                    .as_str()
                    .is_some_and(|other| normalize_python_name(other) == name)
            })
            .count();
        let key = location(&name, version, count);
        let mut entry = node(key.clone(), name, version.into(), Ecosystem::PyPi);
        entry.flags.optional = package["optional"].as_bool().unwrap_or(false);
        entry.flags.groups = strings(&package["groups"]).into_iter().collect();
        if entry.flags.groups.is_empty() {
            entry
                .flags
                .groups
                .insert(package["category"].as_str().unwrap_or("main").into());
        }
        entry.flags.dev = entry.flags.groups.len() == 1 && entry.flags.groups.contains("dev");
        entry.flags.markers = marker(package);
        if let Some(markers) = package["markers"].as_object() {
            for (group, marker) in markers {
                entry.flags.group_markers.insert(
                    group.clone(),
                    marker
                        .as_str()
                        .context("Poetry group marker is not a string")?
                        .into(),
                );
            }
        }
        entry.flags.python = package["python-versions"]
            .as_str()
            .filter(|&version| version != "*")
            .map(str::to_owned);
        if package["source"]["type"].as_str() == Some("directory") {
            entry.link = package["source"]["url"].as_str().map(str::to_owned);
        }
        graph.nodes.insert(key, entry);
    }
    for package in packages {
        let key = find_targets(
            &graph,
            package["name"].as_str().unwrap(),
            package["version"].as_str(),
        )[0]
        .clone();
        let mut edges = Vec::new();
        if let Some(dependencies) = package["dependencies"].as_object() {
            for (name, requirement) in dependencies {
                let variants = requirement
                    .as_array()
                    .cloned()
                    .unwrap_or_else(|| vec![requirement.clone()]);
                for variant in variants {
                    let version = variant
                        .as_str()
                        .or_else(|| variant["version"].as_str())
                        .unwrap_or("*");
                    let constraints = poetry_specifiers(version)?;
                    let targets = find_targets(&graph, name, None)
                        .into_iter()
                        .filter(|location| {
                            pep440_rs::Version::from_str(&graph.nodes[location].version).is_ok_and(
                                |version| {
                                    constraints
                                        .iter()
                                        .any(|specifiers| specifiers.contains(&version))
                                },
                            )
                        })
                        .collect::<Vec<_>>();
                    if targets.is_empty() {
                        graph.unverified(format!("unresolved poetry dependency {name}"));
                    }
                    for target in targets {
                        edges.push(DependencyEdge {
                            name: normalize_python_name(name),
                            target,
                            optional: variant["optional"].as_bool().unwrap_or(false),
                            marker: marker(&variant),
                            requested_extras: strings(&variant["extras"]).into_iter().collect(),
                            ..Default::default()
                        });
                    }
                }
            }
        }
        graph.nodes.get_mut(&key).unwrap().dependencies = edges;
    }
    if let Some(extras) = value["extras"].as_object() {
        for (extra, names) in extras {
            for name in strings(names) {
                let name = name.split_whitespace().next().unwrap_or_default();
                for target in find_targets(&graph, name, None) {
                    graph
                        .nodes
                        .get_mut(&target)
                        .unwrap()
                        .flags
                        .extras
                        .insert(extra.clone());
                }
            }
        }
    }
    graph.importers.insert(
        ".".into(),
        Importer {
            dependencies: graph
                .nodes
                .values()
                .map(|node| DependencyEdge {
                    name: node.name.clone(),
                    target: node.location.clone(),
                    optional: node.flags.optional,
                    dev: node.flags.dev,
                    ..Default::default()
                })
                .collect(),
        },
    );
    Ok(graph)
}

fn pipfile(value: &Value) -> Result<DependencyGraph> {
    let mut graph = DependencyGraph::new("pipfile");
    let mut edges = Vec::new();
    for (section, dev) in [("default", false), ("develop", true)] {
        if let Some(packages) = value[section].as_object() {
            for (name, package) in packages {
                let name = normalize_python_name(name);
                let mut entry = node(name.clone(), name.clone(), String::new(), Ecosystem::PyPi);
                if let Some(version) = package["version"]
                    .as_str()
                    .and_then(|value| value.strip_prefix("=="))
                {
                    if version.contains('*') {
                        graph.unverified(format!("{name} has no exact pin"));
                    } else {
                        entry.version = version.into();
                    }
                } else {
                    graph.unverified(format!("{name} has no exact pin"));
                }
                entry.flags.dev = dev;
                entry
                    .flags
                    .groups
                    .insert(if dev { "dev".into() } else { "main".into() });
                entry.flags.markers = marker(package);

                entry.link = package["path"].as_str().map(str::to_owned);
                edges.push(DependencyEdge {
                    name: name.clone(),
                    target: name.clone(),
                    dev,
                    requested_extras: strings(&package["extras"]).into_iter().collect(),
                    ..Default::default()
                });
                graph.nodes.insert(name, entry);
            }
        }
    }
    graph.importers.insert(
        ".".into(),
        Importer {
            dependencies: edges,
        },
    );
    Ok(graph)
}

pub(super) fn requirements(content: &str) -> Result<DependencyGraph> {
    let mut graph = DependencyGraph::new("requirements");
    let mut edges = Vec::new();
    let content = content.replace("\\\r\n", " ").replace("\\\n", " ");
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // Hashes and comments are not part of a PEP 508 requirement.
        let text = line
            .split(" --hash=")
            .next()
            .unwrap()
            .split(" #")
            .next()
            .unwrap()
            .trim();
        if text.starts_with('-') {
            graph.unverified(format!("unsupported requirements directive {text}"));
            continue;
        }
        let requirement: Requirement =
            Requirement::from_str(text).with_context(|| format!("invalid requirement {text}"))?;
        let name = requirement.name.to_string();
        let version = match &requirement.version_or_url {
            Some(VersionOrUrl::VersionSpecifier(specifiers)) => {
                let specifiers = specifiers.to_string();
                specifiers
                    .strip_prefix("==")
                    .filter(|version| !version.contains(['*', ',']))
                    .map(str::to_owned)
            }
            _ => None,
        };
        let Some(version) = version else {
            graph.unverified(format!("{name} has no exact pin"));
            continue;
        };
        let mut entry = node(name.clone(), name.clone(), version, Ecosystem::PyPi);
        entry.flags.markers = requirement.marker.contents().map(|value| value.to_string());
        let requested_extras = requirement
            .extras
            .iter()
            .map(ToString::to_string)
            .collect::<BTreeSet<_>>();
        graph.nodes.insert(name.clone(), entry);
        edges.push(DependencyEdge {
            name: name.clone(),
            target: name,
            requested_extras,
            ..Default::default()
        });
    }
    graph.importers.insert(
        ".".into(),
        Importer {
            dependencies: edges,
        },
    );
    Ok(graph)
}

pub(super) fn parse(name: &str, content: &str) -> Result<DependencyGraph> {
    let value: Value = if name == "Pipfile.lock" {
        serde_json::from_str(content)?
    } else {
        serde_json::to_value(toml::from_str::<toml::Value>(content)?)?
    };
    match name {
        "uv.lock" => uv(&value),
        "poetry.lock" => poetry(&value),
        "Pipfile.lock" => pipfile(&value),
        _ => unreachable!(),
    }
}

/// Poetry lockfiles record all resolved packages, while the project's manifest
/// determines which packages are direct requests and how alternatives are used.
pub(super) fn poetry_importer(graph: &mut DependencyGraph, manifest: &Value) -> Result<()> {
    let mut edges = Vec::new();
    let mut has_declarations = false;
    let mut add_requirement = |text: &str,
                               group: Option<&str>,
                               extra: Option<&str>|
     -> Result<()> {
        let requirement: Requirement = Requirement::from_str(text)?;
        let targets = find_targets(graph, requirement.name.as_ref(), None);
        for target in targets {
            let matches = match &requirement.version_or_url {
                Some(VersionOrUrl::VersionSpecifier(specifiers)) => {
                    pep440_rs::Version::from_str(&graph.nodes[&target].version)
                        .is_ok_and(|version| specifiers.contains(&version))
                }
                _ => true,
            };
            if matches {
                edges.push(DependencyEdge {
                    name: requirement.name.to_string(),
                    target,
                    dev: group == Some("dev"),
                    group: group.map(str::to_owned),
                    extra: extra.map(str::to_owned),
                    optional: extra.is_some(),
                    marker: requirement
                        .marker
                        .contents()
                        .map(|marker| marker.to_string()),
                    requested_extras: requirement.extras.iter().map(ToString::to_string).collect(),
                    ..Default::default()
                });
            }
        }
        Ok(())
    };
    if let Some(dependencies) = manifest["project"]["dependencies"].as_array() {
        has_declarations = true;
        for requirement in dependencies {
            add_requirement(
                requirement
                    .as_str()
                    .context("project dependency must be a string")?,
                None,
                None,
            )?;
        }
    }
    if let Some(extras) = manifest["project"]["optional-dependencies"].as_object() {
        for (extra, requirements) in extras {
            for requirement in requirements
                .as_array()
                .context("optional dependencies must be a list")?
            {
                add_requirement(
                    requirement
                        .as_str()
                        .context("optional dependency must be a string")?,
                    None,
                    Some(extra),
                )?;
            }
        }
    }
    if let Some(groups) = manifest["dependency-groups"].as_object() {
        has_declarations = true;
        for (group, requirements) in groups {
            for requirement in requirements
                .as_array()
                .context("dependency group must be a list")?
            {
                if let Some(text) = requirement.as_str() {
                    add_requirement(text, Some(group), None)?;
                }
            }
        }
    }
    // Legacy Poetry syntax is a mapping with Poetry version constraints.
    let mut maps = Vec::new();
    if let Some(dependencies) = manifest["tool"]["poetry"]["dependencies"].as_object() {
        has_declarations = true;
        maps.push((None, dependencies));
    }
    if let Some(dependencies) = manifest["tool"]["poetry"]["dev-dependencies"].as_object() {
        maps.push((Some("dev"), dependencies));
    }
    if let Some(groups) = manifest["tool"]["poetry"]["group"].as_object() {
        for (group, value) in groups {
            if let Some(dependencies) = value["dependencies"].as_object() {
                maps.push((Some(group.as_str()), dependencies));
            }
        }
    }
    for (group, dependencies) in maps {
        for (name, requirement) in dependencies {
            if name == "python" {
                continue;
            }
            let range = requirement
                .as_str()
                .or_else(|| requirement["version"].as_str())
                .unwrap_or("*");
            let specifiers = poetry_specifiers(range)?;
            for target in find_targets(graph, name, None) {
                if graph.nodes[&target].link.is_some()
                    || pep440_rs::Version::from_str(&graph.nodes[&target].version).is_ok_and(
                        |version| {
                            specifiers
                                .iter()
                                .any(|specifier| specifier.contains(&version))
                        },
                    )
                {
                    edges.push(DependencyEdge {
                        name: normalize_python_name(name),
                        target,
                        group: group.map(str::to_owned),
                        dev: group == Some("dev"),
                        optional: requirement["optional"].as_bool() == Some(true),
                        marker: marker(requirement),
                        requested_extras: strings(&requirement["extras"]).into_iter().collect(),
                        ..Default::default()
                    });
                }
            }
        }
    }
    if has_declarations {
        graph.importers.insert(
            ".".into(),
            Importer {
                dependencies: edges,
            },
        );
    }
    Ok(())
}

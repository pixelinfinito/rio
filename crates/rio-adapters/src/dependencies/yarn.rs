use std::collections::BTreeMap;

use super::{DependencyEdge, DependencyGraph, Ecosystem, Importer, lockfiles::node};
use anyhow::{Context, Result};
use regex::Regex;
use serde_json::{Value, json};

fn unquote(value: &str) -> String {
    let value = value.trim();
    if value.starts_with('"') {
        serde_json::from_str(value).unwrap_or_else(|_| value.trim_matches('"').into())
    } else {
        value.trim_matches('\'').into()
    }
}

fn descriptors(header: &str) -> Vec<String> {
    // Descriptor commas inside a quoted selector are not separators in classic.
    let mut parts = Vec::new();
    let mut start = 0;
    let mut quoted = false;
    let mut escaped = false;
    for (at, c) in header.char_indices() {
        if c == '"' && !escaped {
            quoted = !quoted;
        }
        if c == ',' && !quoted {
            parts.push(unquote(&header[start..at]));
            start = at + 1;
        }
        escaped = c == '\\' && !escaped;
    }
    parts.push(unquote(&header[start..]));
    parts
}

fn classic(content: &str) -> Result<Value> {
    let field = Regex::new(r#"^\s+(?:"([^"]+)"|([^\s]+))\s+(.+)$"#)?;
    let mut result = serde_json::Map::new();
    let mut header = None::<String>;
    let mut record = json!({});
    let mut section = None::<String>;
    for line in content.lines() {
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        if !line.starts_with(char::is_whitespace) && line.ends_with(':') {
            if let Some(previous) = header.take() {
                result.insert(previous, record);
            }
            header = Some(line.trim_end_matches(':').to_owned());
            record = json!({});
            section = None;
        } else if line.starts_with("  ") && !line.starts_with("    ") && line.ends_with(':') {
            let key = line.trim().trim_end_matches(':');
            record[key] = json!({});
            section = Some(key.into());
        } else if let Some(captures) = field.captures(line) {
            let name = captures
                .get(1)
                .or_else(|| captures.get(2))
                .unwrap()
                .as_str();
            let value = unquote(&captures[3]);
            if line.starts_with("    ") {
                if let Some(section) = &section {
                    record[section][name] = Value::String(value);
                }
            } else {
                record[name] = Value::String(value);
                section = None;
            }
        } else {
            anyhow::bail!("unrecognized yarn classic lockfile line: {line}");
        }
    }
    if let Some(header) = header {
        result.insert(header, record);
    }
    Ok(Value::Object(result))
}

pub(super) fn parse(content: &str) -> Result<DependencyGraph> {
    let berry = content.lines().any(|line| line.starts_with("__metadata:"));
    let value: Value = if berry {
        serde_yaml::from_str(content)?
    } else {
        classic(content)?
    };
    let records = value
        .as_object()
        .context("yarn lockfile must be a mapping")?;
    let mut graph = DependencyGraph::new(if berry { "yarn-berry" } else { "yarn-classic" });
    let mut selectors = BTreeMap::new();
    for (header, record) in records {
        if header == "__metadata" {
            continue;
        }
        let names = if berry {
            unquote(header)
                .split(", ")
                .map(str::to_owned)
                .collect::<Vec<_>>()
        } else {
            descriptors(header)
        };
        let first = names.first().context("empty yarn descriptor")?;
        let at = first[1..]
            .find('@')
            .map(|at| at + 1)
            .context("yarn descriptor has no selector")?;
        let name = &first[..at];
        let version = record["version"]
            .as_str()
            .context("yarn package has no version")?;
        let key = record["resolution"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| format!("{name}@{version}"));
        let mut entry = node(key.clone(), name.into(), version.into(), Ecosystem::Npm);
        if let Some((_, target)) = key.split_once("@workspace:") {
            entry.link = Some(target.into());
        }
        if let Some(conditions) = record["conditions"].as_str() {
            for condition in conditions.split(" & ") {
                if let Some((kind, value)) = condition.split_once('=') {
                    match kind {
                        "os" => entry.flags.os.push(value.into()),
                        "cpu" => entry.flags.cpu.push(value.into()),
                        "libc" => entry.flags.libc.push(value.into()),
                        _ => graph.unverified(format!("unknown yarn condition: {condition}")),
                    }
                }
            }
        }
        graph.nodes.insert(key.clone(), entry);
        for selector in names {
            selectors.insert(selector, key.clone());
        }
    }
    for (header, record) in records {
        if header == "__metadata" {
            continue;
        }
        let first = if berry {
            unquote(header).split(", ").next().unwrap().to_owned()
        } else {
            descriptors(header)[0].clone()
        };
        let key = selectors[&first].clone();
        let mut edges = Vec::new();
        for (kind, optional) in [
            ("dependencies", false),
            ("optionalDependencies", true),
            ("peerDependencies", true),
        ] {
            if let Some(dependencies) = record[kind].as_object() {
                for (name, range) in dependencies {
                    let range = range
                        .as_str()
                        .context("yarn dependency selector must be a string")?;
                    let selector = format!("{name}@{range}");
                    let alternate = format!("{name}@npm:{range}");
                    let target = selectors
                        .get(&selector)
                        .or_else(|| selectors.get(&alternate));
                    let optional = optional
                        || record["dependenciesMeta"][name]["optional"].as_bool() == Some(true);
                    if let Some(target) = target {
                        edges.push(DependencyEdge {
                            name: name.clone(),
                            target: target.clone(),
                            optional,
                            peer: kind == "peerDependencies",
                            ..Default::default()
                        });
                    } else if !optional {
                        graph.unverified(format!("unresolved yarn selector: {selector}"));
                    }
                }
            }
        }
        let entry = graph.nodes.get_mut(&key).unwrap();
        entry.dependencies = edges.clone();
        if let Some(link) = &entry.link {
            graph.importers.insert(
                link.clone(),
                Importer {
                    dependencies: edges,
                },
            );
        }
    }
    // Classic lockfiles don't encode workspace importers or physical locations;
    // manifests supply the importers before checking the installed resolution.
    graph.selectors = selectors;
    Ok(graph)
}

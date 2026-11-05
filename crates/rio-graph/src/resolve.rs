use crate::{Confidence, GraphNode};
use rio_adapters::{Identifier, SyntaxTable};
use rio_git::Tree;

fn parent(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(parent, _)| parent)
}
fn normalize(path: &str) -> Option<String> {
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            _ => parts.push(part),
        }
    }
    Some(parts.join("/"))
}
fn locate(tree: &Tree, path: &str, python: bool) -> Option<String> {
    let path = normalize(path)?;
    let mut candidates = vec![path.clone()];
    if python {
        candidates.extend([
            format!("{path}.py"),
            format!("{path}/__init__.py"),
            format!("{path}.pyi"),
        ]);
    } else {
        let stem = path
            .strip_suffix(".js")
            .or_else(|| path.strip_suffix(".mjs"))
            .or_else(|| path.strip_suffix(".cjs"))
            .unwrap_or(&path);
        for extension in ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"] {
            candidates.extend([
                format!("{stem}.{extension}"),
                format!("{path}/index.{extension}"),
            ]);
        }
    }
    candidates
        .into_iter()
        .find(|candidate| tree.contains_key(candidate))
}

pub fn resolve_import(tree: &Tree, path: &str, module: &str) -> Option<String> {
    if rio_adapters::language_for_path(path) == Some("rust") {
        return resolve_rust(tree, path, module);
    }
    let python = rio_adapters::language_for_path(path) == Some("python");
    if !python {
        if module.starts_with('.') {
            return locate(tree, &format!("{}/{module}", parent(path)), false);
        }
        if let Some(config) = rio_adapters::ancestor_config(tree, parent(path), &["tsconfig.json"])
            && let Ok(value) = json5::from_str::<serde_json::Value>(
                std::str::from_utf8(&tree[&config].content).ok()?,
            )
        {
            let options = &value["compilerOptions"];
            let config_root = parent(&config);
            let base = options["baseUrl"].as_str().unwrap_or(".");
            for (pattern, targets) in options["paths"].as_object().into_iter().flatten() {
                let wildcard = if let Some((prefix, suffix)) = pattern.split_once('*') {
                    module
                        .strip_prefix(prefix)
                        .and_then(|value| value.strip_suffix(suffix))
                } else {
                    (module == pattern).then_some("")
                };
                if let Some(wildcard) = wildcard {
                    for target in targets
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(serde_json::Value::as_str)
                    {
                        if let Some(path) = locate(
                            tree,
                            &format!("{config_root}/{base}/{}", target.replace('*', wildcard)),
                            false,
                        ) {
                            return Some(path);
                        }
                    }
                }
            }
            if options["baseUrl"].is_string() {
                return locate(tree, &format!("{config_root}/{base}/{module}"), false);
            }
        }
        return None;
    }
    let dots = module
        .chars()
        .take_while(|&character| character == '.')
        .count();
    let module = module.trim_start_matches('.').replace('.', "/");
    if dots > 0 {
        let mut directory = parent(path);
        for _ in 1..dots {
            directory = parent(directory);
        }
        return locate(tree, &format!("{directory}/{module}"), true);
    }
    let mut directories = vec!["".to_owned(), "src".into()];
    let mut directory = parent(path);
    loop {
        directories.extend([directory.into(), format!("{directory}/src")]);
        if directory.is_empty() {
            break;
        }
        directory = parent(directory);
    }
    for directory in directories {
        if let Some(path) = locate(tree, &format!("{directory}/{module}"), true) {
            return Some(path);
        }
    }
    None
}

/// Imported aliases have a known target. Unresolved imports remain explicitly
/// uncertain, and imports resolving to another definition are not connected.
pub fn reference(
    path: &str,
    table: &SyntaxTable,
    identifier: &Identifier,
    target: &GraphNode,
    resolved_imports: &std::collections::BTreeMap<String, Option<String>>,
) -> Option<Confidence> {
    if identifier.shadowed {
        return None;
    }
    for import in &table.imports {
        let imported = import.names.get(&identifier.name);
        let relevant = target.symbol_path.is_empty() && imported.is_some()
            || imported
                .is_some_and(|name| name == &target.name || name == "default" || name == "*")
            || identifier.name == target.name && import.names.values().any(|name| name == "*");
        if !relevant {
            continue;
        }
        match resolved_imports
            .get(&import.module)
            .and_then(Option::as_ref)
        {
            Some(definition) if definition == &target.path => return Some(Confidence::Resolved),
            Some(_) => return None,
            None if target.name.chars().count() >= 3
                && (imported.is_some_and(|name| name == &target.name)
                    || identifier.name == target.name
                    || import.module.rsplit(['/', '.']).next()
                        == target
                            .path
                            .rsplit('/')
                            .next()
                            .and_then(|name| name.split('.').next())) =>
            {
                return Some(Confidence::Unresolved);
            }
            None => return None,
        }
    }
    if identifier.name != target.name {
        return None;
    }
    if path == target.path {
        Some(Confidence::Resolved)
    } else if target.name.chars().count() >= 3 {
        Some(Confidence::Probable)
    } else {
        None
    }
}

fn resolve_rust(tree: &Tree, path: &str, module: &str) -> Option<String> {
    use std::collections::{BTreeMap, BTreeSet, VecDeque};
    let manifest = rio_adapters::ancestor_config(tree, parent(path), &["Cargo.toml"])?;
    let manifest_value: toml::Value =
        toml::from_str(std::str::from_utf8(&tree[&manifest].content).ok()?).ok()?;
    let manifest_root = parent(&manifest);
    let mut pieces: Vec<_> = module
        .trim_end_matches("::*")
        .split("::")
        .filter(|part| !part.is_empty())
        .collect();
    let first = *pieces.first()?;
    let mut selected_manifest = manifest.clone();
    if !matches!(first, "crate" | "self" | "super") {
        let dependency = ["dependencies", "dev-dependencies", "build-dependencies"]
            .into_iter()
            .find_map(|key| manifest_value.get(key).and_then(|value| value.get(first)));
        let package_name = dependency
            .and_then(|value| value.get("package"))
            .and_then(toml::Value::as_str)
            .unwrap_or(first);
        let dependency_path = dependency
            .and_then(|value| value.get("path"))
            .and_then(toml::Value::as_str)
            .and_then(|path| normalize(&format!("{manifest_root}/{path}/Cargo.toml")));
        if let Some(candidate) = dependency_path.filter(|path| tree.contains_key(path)) {
            selected_manifest = candidate;
            pieces.remove(0);
        } else if let Some(candidate) = tree
            .iter()
            .filter(|(path, _)| path.as_str() == "Cargo.toml" || path.ends_with("/Cargo.toml"))
            .find_map(|(path, entry)| {
                let value: toml::Value =
                    toml::from_str(std::str::from_utf8(&entry.content).ok()?).ok()?;
                let name = value
                    .get("lib")
                    .and_then(|value| value.get("name"))
                    .or_else(|| value.get("package").and_then(|value| value.get("name")))?
                    .as_str()?;
                (name.replace('-', "_") == package_name.replace('-', "_")).then(|| path.clone())
            })
        {
            selected_manifest = candidate;
            pieces.remove(0);
        }
    }
    let value: toml::Value =
        toml::from_str(std::str::from_utf8(&tree[&selected_manifest].content).ok()?).ok()?;
    let root = parent(&selected_manifest);
    let entry = value
        .get("lib")
        .and_then(|value| value.get("path"))
        .and_then(toml::Value::as_str)
        .unwrap_or("src/lib.rs");
    let entry = normalize(&format!("{root}/{entry}"))?;
    let entry = if tree.contains_key(&entry) {
        entry
    } else {
        normalize(&format!("{root}/src/main.rs"))?
    };
    let mut modules = BTreeMap::new();
    let mut queue = VecDeque::from([(String::new(), entry.clone(), parent(&entry).to_owned())]);
    let mut seen = BTreeSet::new();
    while let Some((prefix, file, directory)) = queue.pop_front() {
        if !seen.insert((prefix.clone(), file.clone())) {
            continue;
        }
        modules.insert(prefix.clone(), file.clone());
        let source = &tree.get(&file)?.content;
        let parsed = rio_adapters::parse_source(&file, source).ok()?;
        fn declarations(
            node: tree_sitter::Node<'_>,
            source: &[u8],
            scope: (&str, &str, &str),
            tree: &Tree,
            modules: &mut BTreeMap<String, String>,
            queue: &mut VecDeque<(String, String, String)>,
        ) {
            let (prefix, file, directory) = scope;
            let mut cursor = node.walk();
            for child in node.named_children(&mut cursor) {
                if child.kind() == "mod_item" {
                    let Some(name) = child
                        .child_by_field_name("name")
                        .and_then(|name| std::str::from_utf8(&source[name.byte_range()]).ok())
                    else {
                        continue;
                    };
                    let name = if prefix.is_empty() {
                        name.into()
                    } else {
                        format!("{prefix}::{name}")
                    };
                    let directory = format!("{directory}/{}", name.rsplit("::").next().unwrap());
                    if let Some(body) = child.child_by_field_name("body") {
                        modules.insert(name.clone(), file.into());
                        declarations(
                            body,
                            source,
                            (&name, file, &directory),
                            tree,
                            modules,
                            queue,
                        );
                    } else if let Some(path) =
                        [format!("{directory}.rs"), format!("{directory}/mod.rs")]
                            .into_iter()
                            .find(|path| tree.contains_key(path))
                    {
                        queue.push_back((name, path, directory));
                    }
                }
            }
        }
        declarations(
            parsed.root_node(),
            source,
            (&prefix, &file, &directory),
            tree,
            &mut modules,
            &mut queue,
        );
    }
    let mut prefix = Vec::<String>::new();
    if matches!(first, "self" | "super") && selected_manifest == manifest {
        prefix = modules
            .iter()
            .filter(|(_, file)| file.as_str() == path)
            .min_by_key(|(name, _)| name.len())
            .map(|(name, _)| {
                name.split("::")
                    .filter(|name| !name.is_empty())
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
    }
    while let Some(piece) = pieces.first().copied() {
        match piece {
            "crate" => {
                prefix.clear();
                pieces.remove(0);
            }
            "self" => {
                pieces.remove(0);
            }
            "super" => {
                prefix.pop();
                pieces.remove(0);
            }
            _ => break,
        }
    }
    prefix.extend(pieces.into_iter().map(str::to_owned));
    // A use path may end in a module or in an item of a declared module.
    // Dropping further segments would resolve unknown modules to the crate root.
    if let Some(file) = modules.get(&prefix.join("::")) {
        return Some(file.clone());
    }
    prefix.pop()?;
    modules.get(&prefix.join("::")).cloned()
}

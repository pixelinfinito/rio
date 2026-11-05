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

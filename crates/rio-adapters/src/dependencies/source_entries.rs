//! Source resolution and conservative artifact reuse for linked Node packages.
use std::{
    collections::BTreeMap,
    fs,
    path::{Component, Path, PathBuf},
};

use anyhow::{Context, Result, bail, ensure};
use rio_git::{Tree, dependency_state_hash};
use serde_json::Value;

use super::remap::BaseDependencyRemap;
use crate::ToolCommand;

fn strings<'a>(value: &'a Value, result: &mut Vec<&'a str>) {
    match value {
        Value::String(value) => result.push(value),
        Value::Array(values) => values.iter().for_each(|value| strings(value, result)),
        Value::Object(values) => values.values().for_each(|value| strings(value, result)),
        _ => {}
    }
}

fn local(entry: &str) -> Option<&str> {
    let entry = entry.strip_prefix("./").unwrap_or(entry);
    (!entry.is_empty()
        && Path::new(entry)
            .components()
            .all(|part| matches!(part, Component::Normal(_))))
    .then_some(entry)
}

fn present(tree: &Tree, root: &str, entry: &str) -> bool {
    let path = format!("{root}{entry}");
    if path.contains('*') {
        globset::Glob::new(&path).ok().is_some_and(|glob| {
            let matcher = glob.compile_matcher();
            tree.keys().any(|path| matcher.is_match(path))
        })
    } else {
        tree.get(&path)
            .is_some_and(|entry| entry.mode == 0o100644 || entry.mode == 0o100755)
    }
}

fn source(tree: &Tree, root: &str, value: &Value) -> Option<String> {
    let mut candidates = Vec::new();
    // Prefer explicit source/development conditions, including custom conditions
    // such as @tanstack/custom-condition when their value names tracked source.
    for key in ["source", "development"] {
        strings(&value[key], &mut candidates);
    }
    strings(value, &mut candidates);
    candidates
        .into_iter()
        .filter_map(local)
        .find(|entry| {
            (entry.starts_with("src/") || crate::language_for_path(entry) == Some("typescript"))
                && ![".d.ts", ".d.mts", ".d.cts"]
                    .iter()
                    .any(|suffix| entry.ends_with(suffix))
                && present(tree, root, entry)
        })
        .map(str::to_owned)
}

fn conventional_source(tree: &Tree, root: &str, name: &str) -> Option<String> {
    [format!("src/{name}.ts"), format!("src/{name}/index.ts")]
        .into_iter()
        .find(|entry| present(tree, root, entry))
}

fn root_export(exports: &Value) -> &Value {
    if exports.get(".").is_some() {
        &exports["."]
    } else if exports
        .as_object()
        .is_some_and(|entries| entries.keys().any(|key| key.starts_with('.')))
    {
        &Value::Null
    } else {
        exports
    }
}

fn unresolved_entries<'a>(tree: &Tree, prefix: &str, value: &'a Value) -> Vec<&'a str> {
    let mut entries = Vec::new();
    strings(value, &mut entries);
    let entries: Vec<_> = entries.into_iter().filter_map(local).collect();
    if entries.iter().any(|entry| present(tree, prefix, entry)) {
        Vec::new()
    } else {
        entries
    }
}

/// Hash all tracked package inputs, including manifests, config and deletions.
/// This is deliberately stricter than comparing only files under src/.
fn package_hash(tree: &Tree, prefix: &str) -> String {
    dependency_state_hash(
        &tree
            .iter()
            .filter(|(path, _)| path.starts_with(prefix))
            .map(|(path, entry)| {
                let mut bytes = entry.mode.to_le_bytes().to_vec();
                bytes.extend(&entry.content);
                (path.clone(), bytes)
            })
            .collect(),
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn prepare_package(
    worktree: &Path,
    destination: &Path,
    relative: &Path,
    working: &Tree,
    base: &Tree,
    resolution: &mut BaseDependencyRemap,
    stop: &dyn Fn() -> bool,
) -> Result<()> {
    let prefix = relative.to_string_lossy().replace('\\', "/");
    let prefix = if prefix.is_empty() {
        prefix
    } else {
        format!("{prefix}/")
    };
    let Some(manifest) = base.get(&format!("{prefix}package.json")) else {
        return Ok(());
    };
    let manifest: Value = serde_json::from_slice(&manifest.content)?;
    let Some(name) = manifest["name"].as_str() else {
        return Ok(());
    };
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
    let missing: Vec<_> = entries
        .into_iter()
        .filter_map(local)
        .filter(|entry| !present(base, &prefix, entry))
        .collect();
    if missing.is_empty() {
        return Ok(());
    }

    let mut aliases = BTreeMap::new();
    let exports = &manifest["exports"];
    let published = &manifest["publishConfig"];
    let root_allowed = !exports.as_object().is_some_and(|entries| {
        entries.keys().any(|key| key.starts_with('.'))
            && entries.get(".").is_none_or(Value::is_null)
    });
    let root_source = source(base, &prefix, &manifest["source"])
        .or_else(|| source(base, &prefix, &manifest["development"]))
        .or_else(|| source(base, &prefix, root_export(exports)))
        .or_else(|| source(base, &prefix, &published["source"]))
        .or_else(|| source(base, &prefix, &published["development"]))
        .or_else(|| source(base, &prefix, root_export(&published["exports"])))
        .or_else(|| conventional_source(base, &prefix, "index"));
    if root_allowed && let Some(entry) = root_source {
        aliases.insert(name.to_owned(), entry);
    }
    for exports in [exports, &published["exports"]]
        .into_iter()
        .filter_map(Value::as_object)
    {
        for (subpath, conditions) in exports {
            if let Some(subpath) = subpath.strip_prefix("./")
                && !conditions.is_null()
                && let Some(entry) = source(base, &prefix, conditions)
                    .or_else(|| conventional_source(base, &prefix, subpath))
            {
                aliases.insert(format!("{name}/{subpath}"), entry);
            }
        }
    }
    // A root alias does not satisfy a separate public subpath. Reuse artifacts
    // or refuse that subpath when no tracked source can represent it.
    let mut required = Vec::new();
    if root_allowed && !aliases.contains_key(name) {
        let root = root_export(exports);
        if root.is_null() {
            for key in ["types", "typings", "main", "module", "typesVersions"] {
                required.extend(unresolved_entries(base, &prefix, &manifest[key]));
            }
        } else {
            required.extend(unresolved_entries(base, &prefix, root));
        }
    }
    if let Some(exports) = exports.as_object() {
        for (subpath, conditions) in exports {
            if let Some(subpath) = subpath.strip_prefix("./")
                && !aliases.contains_key(&format!("{name}/{subpath}"))
            {
                required.extend(unresolved_entries(base, &prefix, conditions));
            }
        }
    }
    for (name, entry) in aliases {
        resolution.source_paths.insert(
            name,
            vec![
                destination
                    .join(relative)
                    .join(entry)
                    .to_string_lossy()
                    .into_owned(),
            ],
        );
    }
    required.sort_unstable();
    required.dedup();
    if required.is_empty() {
        return Ok(());
    }

    let unchanged = package_hash(working, &prefix) == package_hash(base, &prefix);
    let package_root = if relative.as_os_str().is_empty() {
        ".".into()
    } else {
        relative.display().to_string()
    };
    let mut outputs = std::collections::BTreeSet::new();
    for entry in &required {
        // Copy a whole output directory: declarations/JS can import siblings.
        let output = entry.split('/').next().unwrap();
        if unchanged
            && output != "src"
            && !output.contains('*')
            && worktree.join(relative).join(output).exists()
        {
            outputs.insert(output.to_owned());
        } else {
            resolution.unavailable.push(format!(
                "linked package {}::{name} cannot resolve base entry {entry}: no tracked source entry (source/development export or src/index.ts); HEAD build output {}. Configure a source entry point or commit base build output; an external base build is not read by Rio",
                package_root, if unchanged { "is unavailable" } else { "cannot be reused because tracked package inputs changed" }
            ));
        }
    }
    let mut artifacts = Vec::new();
    for output in outputs {
        copy_output(
            &worktree.join(relative).join(&output),
            &destination.join(relative).join(&output),
            stop,
            &mut artifacts,
        )?;
    }
    // An existing but empty output directory is not a usable build. In
    // particular, never classify TS2307 from an incomplete copy as a baseline.
    for entry in required {
        let path = destination.join(relative).join(entry);
        let present = if entry.contains('*') {
            globset::Glob::new(&path.to_string_lossy()).is_ok_and(|glob| {
                let matcher = glob.compile_matcher();
                artifacts.iter().any(|path| matcher.is_match(path))
            })
        } else {
            path.is_file()
        };
        if resolution.unavailable.is_empty() && !present {
            resolution.unavailable.push(format!("linked package {package_root}::{name} base build entry {entry} is missing from HEAD output; build the package with unchanged tracked inputs or configure source entry points"));
        }
    }
    Ok(())
}

// Never link writable artifacts back into HEAD, overwrite tracked base files,
// follow output symlinks, or copy a dependency installation recursively.
fn copy_output(
    source: &Path,
    destination: &Path,
    stop: &dyn Fn() -> bool,
    artifacts: &mut Vec<PathBuf>,
) -> Result<()> {
    ensure!(!stop(), "timeout: copying linked build output stopped");
    let metadata = fs::symlink_metadata(source)?;
    if let Ok(metadata) = fs::symlink_metadata(destination) {
        ensure!(
            !metadata.file_type().is_symlink(),
            "base build output {} is a symlink; cannot copy artifacts through it",
            destination.display()
        );
    }
    ensure!(
        !metadata.file_type().is_symlink(),
        "linked build output {} is a symlink; configure source entry points",
        source.display()
    );
    if metadata.is_dir() {
        if destination.exists() {
            ensure!(
                fs::symlink_metadata(destination)?.is_dir(),
                "base output directory is not a private directory"
            );
        } else {
            fs::create_dir_all(destination)?;
        }
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            ensure!(
                entry.file_name() != "node_modules",
                "linked build output contains node_modules; configure source entry points"
            );
            copy_output(
                &entry.path(),
                &destination.join(entry.file_name()),
                stop,
                artifacts,
            )?;
        }
    } else if !destination.try_exists()? {
        ensure!(
            metadata.is_file(),
            "linked build output is not a regular file"
        );
        fs::copy(source, destination)?;
    }
    if metadata.is_file() {
        artifacts.push(destination.into());
    }
    Ok(())
}

/// Read only the inherited options needed to merge paths. Everything else is
/// inherited by TypeScript itself from the generated config's `extends`.
#[derive(Default)]
struct InheritedOptions {
    base_url: Option<PathBuf>,
    paths: Option<(PathBuf, Value)>,
    composite: Option<bool>,
    declaration: Option<bool>,
}

fn inherited_options(config: &Path, seen: &mut Vec<PathBuf>) -> Result<InheritedOptions> {
    let config = config
        .canonicalize()
        .context("resolve base TypeScript config")?;
    ensure!(!seen.contains(&config), "cyclic TypeScript config extends");
    seen.push(config.clone());
    let value: Value = json5::from_str(&fs::read_to_string(&config)?)?;
    let directory = config.parent().unwrap();
    let mut result = InheritedOptions::default();
    let parents: Vec<_> = match &value["extends"] {
        Value::String(parent) => vec![parent.as_str()],
        Value::Array(parents) => parents.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    };
    for parent in parents {
        let path = resolve_config(directory, parent)?;
        let parent = inherited_options(&path, seen)?;
        if parent.base_url.is_some() {
            result.base_url = parent.base_url;
        }
        if parent.paths.is_some() {
            result.paths = parent.paths;
        }
        if parent.composite.is_some() {
            result.composite = parent.composite;
        }
        if parent.declaration.is_some() {
            result.declaration = parent.declaration;
        }
    }
    if let Some(base_url) = value["compilerOptions"]["baseUrl"].as_str() {
        result.base_url = Some(directory.join(base_url));
    }
    if value["compilerOptions"]["paths"].is_object() {
        result.paths = Some((directory.into(), value["compilerOptions"]["paths"].clone()));
    }
    if let Some(composite) = value["compilerOptions"]["composite"].as_bool() {
        result.composite = Some(composite);
    }
    if let Some(declaration) = value["compilerOptions"]["declaration"].as_bool() {
        result.declaration = Some(declaration);
    }
    seen.pop();
    Ok(result)
}

fn resolve_config(directory: &Path, name: &str) -> Result<PathBuf> {
    let candidates: Vec<_> = if name.starts_with('.') || Path::new(name).is_absolute() {
        vec![directory.join(name)]
    } else {
        directory
            .ancestors()
            .map(|parent| parent.join("node_modules").join(name))
            .collect()
    };
    for candidate in candidates {
        let mut json = candidate.as_os_str().to_owned();
        json.push(".json");
        for path in [
            candidate.clone(),
            PathBuf::from(json),
            candidate.join("tsconfig.json"),
        ] {
            if path.is_file() {
                return Ok(path);
            }
        }
        if let Ok(manifest) = fs::read(candidate.join("package.json"))
            && let Ok(manifest) = serde_json::from_slice::<Value>(&manifest)
            && let Some(config) = manifest["tsconfig"].as_str()
        {
            return Ok(candidate.join(config));
        }
    }
    bail!(
        "cannot resolve TypeScript config extends {name}; configure source entry points in the project paths"
    )
}

pub(super) fn configure_typescript(
    command: &mut ToolCommand,
    aliases: &BTreeMap<String, Vec<String>>,
    source_root: &Path,
) -> Result<()> {
    if aliases.is_empty() {
        return Ok(());
    }
    let index = command
        .args
        .iter()
        .position(|arg| arg == "-p")
        .context("TypeScript command has no project config")?
        + 1;
    let config = PathBuf::from(&command.args[index]);
    let inherited = inherited_options(&config, &mut Vec::new())?;
    let mut paths = serde_json::Map::new();
    if let Some((directory, inherited_paths)) = inherited.paths {
        let origin = inherited.base_url.as_deref().unwrap_or(&directory);
        for (name, entries) in inherited_paths.as_object().unwrap() {
            let entries = entries
                .as_array()
                .context("TypeScript paths entry must be an array")?;
            let absolute: Vec<_> = entries
                .iter()
                .map(|entry| {
                    entry
                        .as_str()
                        .context("TypeScript paths target must be a string")
                        .map(|entry| origin.join(entry))
                })
                .collect::<Result<_>>()?;
            paths.insert(name.clone(), serde_json::to_value(absolute)?);
        }
    }
    // Keep unrelated project aliases; these linked package entries must resolve
    // to base sources even if an inherited alias names ignored build output.
    for (name, entries) in aliases {
        paths.insert(name.clone(), serde_json::to_value(entries)?);
    }
    // Imported package source now belongs to this no-emit check. Project-local
    // rootDir/composite file-list restrictions describe its published build,
    // and must not reject sibling source merely because it replaces a .d.ts.
    let mut value = serde_json::json!({"extends": config, "compilerOptions": {"paths": paths, "rootDir": source_root, "composite": false}});
    if inherited.composite == Some(true) && inherited.declaration.is_none() {
        // Preserve composite's implicit declaration setting, notably when a
        // project enables declarationMap without spelling out declaration.
        value["compilerOptions"]["declaration"] = true.into();
    }
    // TypeScript does not inherit references via extends. Preserve explicit
    // references using the original config directory as their path origin.
    let original: Value = json5::from_str(&fs::read_to_string(&config)?)?;
    if let Some(references) = original["references"].as_array() {
        let mut references = references.clone();
        for reference in &mut references {
            let path = reference["path"]
                .as_str()
                .context("TypeScript reference has no path")?;
            reference["path"] = serde_json::to_value(config.parent().unwrap().join(path))?;
        }
        value["references"] = Value::Array(references);
    }
    let file = tempfile::Builder::new()
        .prefix(".rio-base-tsconfig-")
        .suffix(".json")
        .tempfile_in(&command.cwd)?;
    serde_json::to_writer(&file, &value)?;
    command.args[index] = file.keep()?.1.into_os_string();
    Ok(())
}

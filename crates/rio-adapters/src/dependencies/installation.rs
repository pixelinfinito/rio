use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

use super::{
    DependencyGraph, Ecosystem, PackageNode, lockfiles::node, normalize_python_name, parse_lockfile,
};
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Installation {
    pub nodes: BTreeMap<String, PackageNode>,
    /// pnpm records importer resolutions separately from package snapshots.
    pub resolutions: BTreeMap<String, BTreeMap<String, String>>,
    pub links: BTreeMap<String, PathBuf>,
    pub fingerprints: BTreeMap<String, Vec<u8>>,
    pub complete: bool,
    pub absence_known: bool,
    pub notes: Vec<String>,
    pub omit_dev: bool,
    pub groups: BTreeSet<String>,
    pub extras: BTreeSet<String>,
}

impl Default for Installation {
    fn default() -> Self {
        Self {
            nodes: BTreeMap::new(),
            resolutions: BTreeMap::new(),
            links: BTreeMap::new(),
            fingerprints: BTreeMap::new(),
            complete: true,
            absence_known: false,
            notes: Vec::new(),
            omit_dev: false,
            groups: BTreeSet::new(),
            extras: BTreeSet::new(),
        }
    }
}

fn read_metadata(root: &Path, path: &str, installation: &mut Installation) -> Result<String> {
    let bytes = fs::read(root.join(path))
        .with_context(|| format!("installation metadata {path} is missing or unreadable"))?;
    let text = String::from_utf8(bytes.clone())?;
    installation.fingerprints.insert(path.into(), bytes);
    Ok(text)
}

fn record_link(worktree: &Path, path: &Path, installation: &mut Installation) -> Result<()> {
    if fs::symlink_metadata(path)?.file_type().is_symlink() {
        let target = path.canonicalize()?;
        let canonical_worktree = worktree.canonicalize()?;
        if target.starts_with(&canonical_worktree)
            && !target
                .strip_prefix(&canonical_worktree)?
                .components()
                .any(|component| {
                    matches!(
                        component.as_os_str().to_str(),
                        Some("node_modules" | ".venv" | "venv")
                    )
                })
        {
            installation.links.insert(
                path.strip_prefix(worktree)?
                    .to_string_lossy()
                    .replace('\\', "/"),
                target,
            );
        }
    }
    Ok(())
}

fn scan_node_modules(
    worktree: &Path,
    directory: &Path,
    installation: &mut Installation,
) -> Result<()> {
    if !directory.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        if name.starts_with('@') && entry.file_type()?.is_dir() {
            scan_scope(worktree, &path, installation)?;
        } else {
            scan_package(worktree, &path, installation)?;
        }
    }
    Ok(())
}

fn scan_scope(worktree: &Path, directory: &Path, installation: &mut Installation) -> Result<()> {
    for entry in fs::read_dir(directory)? {
        scan_package(worktree, &entry?.path(), installation)?;
    }
    Ok(())
}

fn scan_package(worktree: &Path, path: &Path, installation: &mut Installation) -> Result<()> {
    if !path.is_dir() {
        return Ok(());
    }
    record_link(worktree, path, installation)?;
    let manifest = path.join("package.json");
    if !manifest.is_file() {
        return Ok(());
    }
    let value: Value = serde_json::from_slice(&fs::read(&manifest)?)?;
    let location = path
        .strip_prefix(worktree)?
        .to_string_lossy()
        .replace('\\', "/");
    let name = value["name"]
        .as_str()
        .context("installed package has no name")?;
    let version = value["version"]
        .as_str()
        .context("installed package has no version")?;
    installation.fingerprints.insert(format!("{location}/package.json"), serde_json::to_vec(&serde_json::json!({"name": name, "version": version, "dependencies": value["dependencies"]}))?);
    installation.nodes.insert(
        location.clone(),
        node(location, name.into(), version.into(), Ecosystem::Npm),
    );
    if !fs::symlink_metadata(path)?.file_type().is_symlink() {
        scan_node_modules(worktree, &path.join("node_modules"), installation)?;
    }
    Ok(())
}

fn npm(worktree: &Path, installation_root: &str, installation: &mut Installation) -> Result<()> {
    let relative = join(installation_root, "node_modules/.package-lock.json");
    let text = read_metadata(worktree, &relative, installation)?;
    let metadata = parse_lockfile(".package-lock.json", &text)?;
    installation.complete &= metadata.complete;
    installation.notes.extend(metadata.notes);
    for (location, mut entry) in metadata.nodes {
        let path = join(installation_root, &location);
        if !worktree.join(&path).is_dir() {
            installation.complete = false;
            installation
                .notes
                .push(format!("installation metadata refers to absent {path}"));
            continue;
        }
        record_link(worktree, &worktree.join(&path), installation)?;
        entry.location = path.clone();
        installation.nodes.insert(path, entry);
    }
    // Hidden npm lockfiles may omit workspace links. Inspect these separately.
    let mut actual = Installation::default();
    scan_node_modules(
        worktree,
        &worktree.join(join(installation_root, "node_modules")),
        &mut actual,
    )?;
    for (location, entry) in actual.nodes {
        if let Some(recorded) = installation.nodes.get(&location) {
            if entry.name != recorded.name || entry.version != recorded.version {
                installation.nodes.insert(location, entry);
            }
        } else {
            installation.nodes.insert(location, entry);
        }
    }
    installation.links.extend(actual.links);
    installation.fingerprints.extend(actual.fingerprints);
    Ok(())
}

fn pnpm(worktree: &Path, installation_root: &str, installation: &mut Installation) -> Result<()> {
    let text = read_metadata(
        worktree,
        &join(installation_root, "node_modules/.pnpm/lock.yaml"),
        installation,
    )?;
    let graph = parse_lockfile("pnpm-lock.yaml", &text)?;
    installation.complete &= graph.complete;
    installation.notes.extend(graph.notes);
    for (importer, root) in graph.importers {
        installation.resolutions.insert(
            importer,
            root.dependencies
                .into_iter()
                .map(|edge| (edge.name, edge.target))
                .collect(),
        );
    }
    for (key, entry) in graph.nodes {
        if let Some(link) = &entry.link {
            let target = worktree.join(join(installation_root, link));
            if target.is_dir() {
                installation
                    .links
                    .insert(key.clone(), target.canonicalize()?);
                installation.nodes.insert(key, entry);
            }
        } else {
            let directory = key
                .trim_start_matches('/')
                .replace('/', "+")
                .replace('(', "_")
                .replace(')', "");
            let package = worktree.join(join(
                installation_root,
                &format!(
                    "node_modules/.pnpm/{directory}/node_modules/{name}",
                    name = entry.name
                ),
            ));
            if package.is_dir() {
                let actual: Value =
                    serde_json::from_slice(&fs::read(package.join("package.json"))?)?;
                let mut installed = entry;
                installed.name = actual["name"]
                    .as_str()
                    .context("pnpm installed package has no name")?
                    .into();
                installed.version = actual["version"]
                    .as_str()
                    .context("pnpm installed package has no version")?
                    .into();
                installation.nodes.insert(key, installed);
            }
        }
    }
    if let Ok(text) = read_metadata(
        worktree,
        &join(installation_root, "node_modules/.modules.yaml"),
        installation,
    ) {
        let modules: Value = serde_yaml::from_str(&text)?;
        installation.omit_dev = modules["included"]["devDependencies"].as_bool() == Some(false);
    }
    Ok(())
}

fn yarn(
    worktree: &Path,
    installation_root: &str,
    berry: bool,
    installation: &mut Installation,
) -> Result<()> {
    let metadata = join(
        installation_root,
        if berry {
            "node_modules/.yarn-state.yml"
        } else {
            "node_modules/.yarn-integrity"
        },
    );
    let text = read_metadata(worktree, &metadata, installation)?;
    if berry {
        let _: Value = serde_yaml::from_str(&text)?;
    } else {
        let value: Value = serde_json::from_str(&text)?;
        installation.omit_dev = value["flags"]
            .as_array()
            .is_some_and(|flags| flags.iter().any(|flag| flag.as_str() == Some("production")));
    }
    scan_node_modules(
        worktree,
        &worktree.join(join(installation_root, "node_modules")),
        installation,
    )
}

fn python(worktree: &Path, installation_root: &str, installation: &mut Installation) -> Result<()> {
    let canonical_worktree = worktree.canonicalize()?;
    let root = worktree.join(installation_root);
    let environment = [root.join(".venv"), root.join("venv")]
        .into_iter()
        .chain(std::env::var_os("VIRTUAL_ENV").map(PathBuf::from))
        .find(|path| path.is_dir())
        .context("no .venv or venv installation metadata")?;
    let mut sites = Vec::new();
    let windows = environment.join("Lib/site-packages");
    if windows.is_dir() {
        sites.push(windows);
    }
    if let Ok(versions) = fs::read_dir(environment.join("lib")) {
        for version in versions {
            let path = version?.path().join("site-packages");
            if path.is_dir() {
                sites.push(path);
            }
        }
    }
    if sites.is_empty() {
        bail!("Python environment has no site-packages metadata");
    }
    for site in sites {
        for entry in fs::read_dir(&site)? {
            let path = entry?.path();
            let filename = path.file_name().unwrap_or_default().to_string_lossy();
            if (filename.starts_with("__editable__") || filename.starts_with("_editable_impl_"))
                && filename.ends_with(".py")
            {
                let key = path
                    .strip_prefix(worktree)?
                    .to_string_lossy()
                    .replace('\\', "/");
                installation.fingerprints.insert(
                    key,
                    fs::read_to_string(&path)?
                        .replace(
                            canonical_worktree.to_string_lossy().as_ref(),
                            "<repository>",
                        )
                        .into_bytes(),
                );
            }
            if path
                .extension()
                .is_some_and(|extension| extension == "pth" || extension == "egg-link")
            {
                let text = fs::read_to_string(&path)?;
                let key = path
                    .strip_prefix(worktree)?
                    .to_string_lossy()
                    .replace('\\', "/");
                installation.fingerprints.insert(
                    key,
                    text.replace(
                        canonical_worktree.to_string_lossy().as_ref(),
                        "<repository>",
                    )
                    .into_bytes(),
                );
                for (line_number, line) in text
                    .lines()
                    .map(str::trim)
                    .filter(|line| !line.is_empty() && !line.starts_with('#'))
                    .enumerate()
                {
                    if path
                        .extension()
                        .is_some_and(|extension| extension == "egg-link")
                        && line_number > 0
                    {
                        break;
                    }
                    if line.starts_with("import ") || line.starts_with("import\t") {
                        // A finder may not ship direct_url.json. Conservatively
                        // scope it to the repository until its literal source
                        // paths can be proven in the private base overlay.
                        if line.contains("__editable__") || line.contains("_editable_impl_") {
                            installation.links.insert(
                                path.strip_prefix(worktree)?
                                    .to_string_lossy()
                                    .replace('\\', "/"),
                                canonical_worktree.clone(),
                            );
                        }
                        if !line.contains("__editable__") && !line.contains("_editable_impl_") {
                            installation.complete = false;
                            installation.notes.push(format!(
                                "executable .pth cannot be verified: {}",
                                path.display()
                            ));
                        }
                    } else {
                        let target = site.join(line);
                        if target.is_dir() {
                            let target = target.canonicalize()?;
                            if target.starts_with(&canonical_worktree) {
                                let key = path
                                    .strip_prefix(worktree)?
                                    .to_string_lossy()
                                    .replace('\\', "/");
                                let key = if line_number == 0 {
                                    key
                                } else {
                                    format!("{key}#{line_number}.pth")
                                };
                                installation.links.insert(key, target);
                            }
                        }
                    }
                }
            }
            if !path
                .file_name()
                .is_some_and(|name| name.to_string_lossy().ends_with(".dist-info"))
            {
                continue;
            }
            let text = fs::read_to_string(path.join("METADATA"))?;
            let name = text
                .lines()
                .find_map(|line| line.strip_prefix("Name: "))
                .map(normalize_python_name)
                .context("distribution metadata has no name")?;
            let version = text
                .lines()
                .find_map(|line| line.strip_prefix("Version: "))
                .context("distribution metadata has no version")?;
            let mut entry = node(name.clone(), name.clone(), version.into(), Ecosystem::PyPi);
            let fingerprint = path
                .strip_prefix(worktree)?
                .to_string_lossy()
                .replace('\\', "/");
            installation
                .fingerprints
                .insert(format!("{fingerprint}/METADATA"), text.as_bytes().to_vec());
            if let Ok(text) = fs::read_to_string(path.join("direct_url.json")) {
                let direct: Value = serde_json::from_str(&text)?;
                installation.fingerprints.insert(
                    format!("{fingerprint}/direct_url.json"),
                    text.replace(worktree.to_string_lossy().as_ref(), "<repository>")
                        .into_bytes(),
                );
                if let Some(url) = direct["url"]
                    .as_str()
                    .filter(|url| url.starts_with("file:"))
                {
                    let target = pep508_rs::VerbatimUrl::parse_url(url)?
                        .to_url()
                        .to_file_path()
                        .map_err(|_| anyhow::anyhow!("invalid editable file URL"))?;
                    if target.is_dir() {
                        let target = target.canonicalize()?;
                        if target.starts_with(&canonical_worktree) {
                            entry.link = Some(
                                target
                                    .strip_prefix(&canonical_worktree)?
                                    .to_string_lossy()
                                    .replace('\\', "/"),
                            );
                            installation.links.insert(name.clone(), target);
                        }
                    }
                }
            }
            installation.nodes.insert(name, entry);
        }
    }
    Ok(())
}

pub(super) fn join(root: &str, path: &str) -> String {
    if root.is_empty() || root == "." {
        path.into()
    } else {
        format!("{root}/{path}")
    }
}

pub fn read_installation(
    worktree: &Path,
    installation_root: &str,
    graph: &DependencyGraph,
) -> Installation {
    let mut installation = Installation::default();
    let result = match graph.format.as_str() {
        "npm" => npm(worktree, installation_root, &mut installation),
        "pnpm" => pnpm(worktree, installation_root, &mut installation),
        "yarn-classic" => yarn(worktree, installation_root, false, &mut installation),
        "yarn-berry" => yarn(worktree, installation_root, true, &mut installation),
        _ => python(worktree, installation_root, &mut installation),
    };
    installation.absence_known = result.is_ok();
    if let Err(error) = result {
        installation.complete = false;
        installation.notes.push(error.to_string());
    }
    // Absence of all dev-only packages establishes an omitted-dev installation
    // for formats (notably npm's hidden lockfile) without an explicit omit flag.
    let dev: Vec<_> = graph.nodes.values().filter(|node| node.flags.dev).collect();
    if !dev.is_empty()
        && dev.iter().all(|node| {
            !installation
                .nodes
                .values()
                .any(|installed| installed.name == node.name)
        })
    {
        installation.omit_dev = true;
    }
    for node in graph
        .nodes
        .values()
        .filter(|node| !node.flags.groups.contains("main"))
    {
        if installation
            .nodes
            .values()
            .any(|installed| installed.name == node.name)
        {
            installation.groups.extend(node.flags.groups.clone());
        }
    }
    installation
}

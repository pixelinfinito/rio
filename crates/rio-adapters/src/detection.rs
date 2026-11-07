use std::collections::{BTreeMap, BTreeSet, VecDeque};

use anyhow::Result;
use globset::GlobBuilder;
use rio_core::{CheckKind, ScheduledAs};
use rio_git::{Diff, Exclusions, Tree};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectRoot {
    pub path: String,
    pub language: String,
    pub workspace: Option<String>,
    pub manifest: Option<String>,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RepositoryLayout {
    pub roots: Vec<ProjectRoot>,
    /// Consumer root -> dependency roots, all repository-relative.
    pub dependencies: BTreeMap<String, BTreeSet<String>>,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScheduledRoot {
    pub project: ProjectRoot,
    pub scheduled_as: ScheduledAs,
    pub changed_files: Vec<String>,
    #[serde(default)]
    pub workspace_wide: bool,
}

impl ScheduledRoot {
    pub fn checks(&self) -> Vec<CheckKind> {
        if self.scheduled_as == ScheduledAs::Changed {
            vec![CheckKind::Typecheck, CheckKind::Lint, CheckKind::Coverage]
        } else {
            vec![CheckKind::Typecheck, CheckKind::Coverage]
        }
    }
}

pub fn language_for_path(path: &str) -> Option<&'static str> {
    match path.rsplit('.').next()? {
        "ts" | "tsx" | "mts" | "cts" | "js" | "jsx" | "mjs" | "cjs" => Some("typescript"),
        "py" | "pyi" => Some("python"),
        "rs" => Some("rust"),
        _ => None,
    }
}

fn parent(path: &str) -> &str {
    path.rsplit_once('/').map_or(".", |(parent, _)| parent)
}

fn join(root: &str, path: &str) -> String {
    if root == "." {
        path.into()
    } else {
        format!("{root}/{path}")
    }
}

fn under(path: &str, root: &str) -> bool {
    root == "." || path == root || path.starts_with(&format!("{root}/"))
}

fn relative(root: &str, path: &str) -> Option<String> {
    let mut parts: Vec<_> = if root == "." {
        Vec::new()
    } else {
        root.split('/').collect()
    };
    for part in path.split('/') {
        match part {
            "." | "" => {}
            ".." => {
                parts.pop()?;
            }
            _ => parts.push(part),
        }
    }
    Some(if parts.is_empty() {
        ".".into()
    } else {
        parts.join("/")
    })
}

/// Manifests that do not parse (test fixtures of invalid `Cargo.toml` or
/// `tsconfig.json` files are common) are skipped with a note rather than
/// failing the analysis of the whole repository.
fn skipped(path: &str, notes: &mut Vec<String>) -> Option<Value> {
    let note = format!("Skipped unparsable manifest {path}");
    if !notes.contains(&note) {
        notes.push(note);
    }
    None
}

fn json(tree: &Tree, path: &str, notes: &mut Vec<String>) -> Option<Value> {
    let entry = tree.get(path)?;
    let parsed = std::str::from_utf8(&entry.content).ok().and_then(|text| {
        if path.ends_with("tsconfig.json") {
            json5::from_str(text).ok()
        } else {
            serde_json::from_str(text).ok()
        }
    });
    parsed.or_else(|| skipped(path, notes))
}

fn toml_json(tree: &Tree, path: &str, notes: &mut Vec<String>) -> Option<Value> {
    let entry = tree.get(path)?;
    std::str::from_utf8(&entry.content)
        .ok()
        .and_then(|text| toml::from_str::<toml::Value>(text).ok())
        .and_then(|document| serde_json::to_value(document).ok())
        .or_else(|| skipped(path, notes))
}

fn yaml_json(tree: &Tree, path: &str, notes: &mut Vec<String>) -> Option<Value> {
    let entry = tree.get(path)?;
    serde_yaml::from_slice(&entry.content)
        .ok()
        .or_else(|| skipped(path, notes))
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn matches_patterns(path: &str, patterns: &[String]) -> Result<bool> {
    let mut included = false;
    for pattern in patterns {
        let (negative, pattern) = pattern
            .strip_prefix('!')
            .map_or((false, pattern.as_str()), |p| (true, p));
        let matcher = GlobBuilder::new(pattern.trim_end_matches('/'))
            .literal_separator(true)
            .build()?
            .compile_matcher();
        if matcher.is_match(path) {
            included = !negative;
        }
    }
    Ok(included)
}

/// Discovery uses the immutable selected tree, so staged and branch reviews do
/// not accidentally read manifests from the current worktree.
pub fn detect_repository(tree: &Tree, diff: &Diff) -> Result<RepositoryLayout> {
    let exclusions = Exclusions::new(tree, &[])?;
    let mut notes = Vec::new();
    let mut roots = BTreeMap::<(String, String), ProjectRoot>::new();
    for (path, entry) in tree {
        if exclusions
            .reason(path, entry, true)
            .is_some_and(|reason| reason != "lockfile")
        {
            continue;
        }
        let name = path.rsplit('/').next().unwrap();
        let language = match name {
            "package.json" | "tsconfig.json" => "typescript",
            "Cargo.toml" => "rust",
            "pyproject.toml" | "setup.py" | "setup.cfg" | "Pipfile" => "python",
            name if name.starts_with("requirements") && name.ends_with(".txt") => "python",
            _ => continue,
        };
        let directory = parent(path).to_owned();
        let key = (directory.clone(), language.into());
        let project = roots.entry(key).or_insert(ProjectRoot {
            path: directory,
            language: language.into(),
            workspace: None,
            manifest: Some(path.clone()),
            name: None,
        });
        if name == "package.json" {
            if let Some(value) = json(tree, path, &mut notes) {
                project.name = value["name"].as_str().map(str::to_owned);
            }
            project.manifest = Some(path.clone());
        } else if name == "Cargo.toml" {
            if let Some(value) = toml_json(tree, path, &mut notes) {
                project.name = value["package"]["name"].as_str().map(str::to_owned);
            }
            project.manifest = Some(path.clone());
        } else if name == "pyproject.toml" {
            if let Some(value) = toml_json(tree, path, &mut notes) {
                project.name = value["project"]["name"]
                    .as_str()
                    .or_else(|| value["tool"]["poetry"]["name"].as_str())
                    .map(str::to_owned);
            }
            project.manifest = Some(path.clone());
        }
    }
    let mut workspaces = Vec::<(String, String, Vec<String>, Vec<String>)>::new();
    for path in tree.keys() {
        let directory = parent(path);
        if path.ends_with("package.json") {
            let Some(value) = json(tree, path, &mut notes) else {
                continue;
            };
            let patterns = if value["workspaces"].is_array() {
                strings(&value["workspaces"])
            } else {
                strings(&value["workspaces"]["packages"])
            };
            if !patterns.is_empty() {
                workspaces.push((directory.into(), "typescript".into(), patterns, Vec::new()));
            }
        } else if path.ends_with("pnpm-workspace.yaml") {
            let Some(value) = yaml_json(tree, path, &mut notes) else {
                continue;
            };
            workspaces.push((
                directory.into(),
                "typescript".into(),
                strings(&value["packages"]),
                Vec::new(),
            ));
        } else if path.ends_with("Cargo.toml") {
            let Some(value) = toml_json(tree, path, &mut notes) else {
                continue;
            };
            if value["workspace"].is_object() {
                workspaces.push((
                    directory.into(),
                    "rust".into(),
                    strings(&value["workspace"]["members"]),
                    strings(&value["workspace"]["exclude"]),
                ));
            }
        } else if path.ends_with("pyproject.toml") {
            let Some(value) = toml_json(tree, path, &mut notes) else {
                continue;
            };
            let workspace = &value["tool"]["uv"]["workspace"];
            if workspace.is_object() {
                workspaces.push((
                    directory.into(),
                    "python".into(),
                    strings(&workspace["members"]),
                    strings(&workspace["exclude"]),
                ));
            }
        }
    }
    // The nearest workspace wins for nested workspaces.
    workspaces.sort_by_key(|(root, _, _, _)| root.len());
    for project in roots.values_mut() {
        for (workspace, language, members, excludes) in &workspaces {
            if &project.language != language
                || project.path == *workspace
                || !under(&project.path, workspace)
            {
                continue;
            }
            let member = if workspace == "." {
                project.path.as_str()
            } else {
                project.path.strip_prefix(&format!("{workspace}/")).unwrap()
            };
            if matches_patterns(member, members)? && !matches_patterns(member, excludes)? {
                project.workspace = Some(workspace.clone());
            }
        }
    }
    let mut layout = RepositoryLayout {
        notes,
        ..RepositoryLayout::default()
    };
    for file in &diff.files {
        if file.excluded.is_some() || file.binary {
            continue;
        }
        if let Some(language) = language_for_path(&file.path)
            && !roots
                .values()
                .any(|root| root.language == language && under(&file.path, &root.path))
        {
            roots
                .entry((".".into(), language.into()))
                .or_insert_with(|| {
                    layout.notes.push(format!(
                        "{language}: no manifest found; using repository root"
                    ));
                    ProjectRoot {
                        path: ".".into(),
                        language: language.into(),
                        workspace: None,
                        manifest: None,
                        name: None,
                    }
                });
        }
    }
    let projects: Vec<_> = roots.into_values().collect();
    for project in &projects {
        let mut dependency_paths = BTreeSet::new();
        if project.language == "typescript" {
            if let Some(value) = json(
                tree,
                &join(&project.path, "package.json"),
                &mut layout.notes,
            ) {
                for key in [
                    "dependencies",
                    "devDependencies",
                    "optionalDependencies",
                    "peerDependencies",
                ] {
                    for (name, requirement) in value[key].as_object().into_iter().flatten() {
                        let requirement = requirement.as_str().unwrap_or_default();
                        for candidate in &projects {
                            if candidate.name.as_deref() == Some(name)
                                && candidate.language == project.language
                                && (candidate.workspace == project.workspace
                                    && project.workspace.is_some()
                                    || requirement.starts_with("workspace:"))
                            {
                                dependency_paths.insert(candidate.path.clone());
                            }
                        }
                        if let Some(path) = requirement
                            .strip_prefix("file:")
                            .or_else(|| requirement.strip_prefix("link:"))
                            && let Some(path) = relative(&project.path, path)
                        {
                            dependency_paths.insert(path);
                        }
                    }
                }
            }
            if let Some(value) = json(
                tree,
                &join(&project.path, "tsconfig.json"),
                &mut layout.notes,
            ) {
                for reference in value["references"].as_array().into_iter().flatten() {
                    if let Some(path) = reference["path"]
                        .as_str()
                        .and_then(|path| relative(&project.path, path))
                    {
                        dependency_paths.insert(if path.ends_with(".json") {
                            parent(&path).into()
                        } else {
                            path
                        });
                    }
                }
            }
        } else if project.language == "rust" {
            if let Some(value) =
                toml_json(tree, &join(&project.path, "Cargo.toml"), &mut layout.notes)
            {
                let workspace = project.workspace.as_deref().unwrap_or(&project.path);
                let workspace_value =
                    toml_json(tree, &join(workspace, "Cargo.toml"), &mut layout.notes)
                        .unwrap_or(Value::Null);
                let mut declarations = vec![&value];
                declarations.extend(
                    value["target"]
                        .as_object()
                        .into_iter()
                        .flat_map(|targets| targets.values()),
                );
                for declaration in declarations {
                    for key in ["dependencies", "dev-dependencies", "build-dependencies"] {
                        for (name, dependency) in declaration[key].as_object().into_iter().flatten()
                        {
                            let (declaration_root, dependency) = if dependency["workspace"] == true
                            {
                                (
                                    workspace,
                                    &workspace_value["workspace"]["dependencies"][name],
                                )
                            } else {
                                (project.path.as_str(), dependency)
                            };
                            if let Some(path) = dependency["path"]
                                .as_str()
                                .and_then(|path| relative(declaration_root, path))
                            {
                                dependency_paths.insert(path);
                            }
                        }
                    }
                }
            }
        } else if let Some(value) = toml_json(
            tree,
            &join(&project.path, "pyproject.toml"),
            &mut layout.notes,
        ) {
            for (_, source) in value["tool"]["uv"]["sources"]
                .as_object()
                .into_iter()
                .flatten()
            {
                for source in source
                    .as_array()
                    .map(Vec::as_slice)
                    .unwrap_or(std::slice::from_ref(source))
                {
                    if let Some(path) = source["path"]
                        .as_str()
                        .and_then(|path| relative(&project.path, path))
                    {
                        dependency_paths.insert(path);
                    }
                }
            }
            for (name, source) in value["tool"]["uv"]["sources"]
                .as_object()
                .into_iter()
                .flatten()
            {
                if source["workspace"] == true {
                    dependency_paths.extend(
                        projects
                            .iter()
                            .filter(|candidate| {
                                candidate.name.as_deref() == Some(name)
                                    && candidate.workspace == project.workspace
                            })
                            .map(|candidate| candidate.path.clone()),
                    );
                }
            }
            for (_, source) in value["tool"]["poetry"]["dependencies"]
                .as_object()
                .into_iter()
                .flatten()
            {
                if let Some(path) = source["path"]
                    .as_str()
                    .and_then(|path| relative(&project.path, path))
                {
                    dependency_paths.insert(path);
                }
            }
            for requirement in strings(&value["project"]["dependencies"]) {
                if let Some((_, path)) = requirement.split_once(" @ file:")
                    && let Some(path) = relative(&project.path, path)
                {
                    dependency_paths.insert(path);
                }
            }
        }
        if project.language == "python" {
            for (path, entry) in tree.iter().filter(|(path, _)| {
                parent(path) == project.path
                    && path.rsplit('/').next().is_some_and(|name| {
                        name.starts_with("requirements") && name.ends_with(".txt")
                    })
            }) {
                let Ok(text) = std::str::from_utf8(&entry.content) else {
                    skipped(path, &mut layout.notes);
                    continue;
                };
                for line in text.lines() {
                    let line = line.trim();
                    if let Some(path) = line
                        .strip_prefix("-e ")
                        .or_else(|| line.strip_prefix("--editable "))
                        && let Some(path) = relative(&project.path, path.trim())
                    {
                        dependency_paths.insert(path);
                    }
                }
            }
        }
        dependency_paths.retain(|path| {
            path != &project.path
                && projects
                    .iter()
                    .any(|other| other.path == *path && other.language == project.language)
        });
        layout
            .dependencies
            .entry(project.path.clone())
            .or_default()
            .extend(dependency_paths);
    }
    layout.roots = projects;
    Ok(layout)
}

impl RepositoryLayout {
    pub fn root_for(&self, path: &str, language: &str) -> Option<&ProjectRoot> {
        self.roots
            .iter()
            .filter(|root| root.language == language && under(path, &root.path))
            .max_by_key(|root| root.path.len())
    }

    pub fn schedule(&self, diff: &Diff) -> Vec<ScheduledRoot> {
        let mut scheduled = BTreeMap::new();
        for file in &diff.files {
            if file.binary {
                continue;
            }
            let name = file.path.rsplit('/').next().unwrap_or(&file.path);
            if name == "Cargo.lock" {
                let governing = parent(&file.path);
                for project in self.roots.iter().filter(|project| {
                    project.language == "rust"
                        && project.name.is_some()
                        && (project.path == governing
                            || project.workspace.as_deref() == Some(governing))
                }) {
                    scheduled
                        .entry((project.path.clone(), project.language.clone()))
                        .or_insert_with(|| ScheduledRoot {
                            project: project.clone(),
                            scheduled_as: ScheduledAs::Changed,
                            changed_files: Vec::new(),
                            workspace_wide: false,
                        });
                }
                continue;
            }
            if file.excluded.is_some() {
                continue;
            }
            if matches!(name, "rust-toolchain.toml" | "rust-toolchain")
                && let Some(project) = self.root_for(&file.path, "rust")
            {
                scheduled
                    .entry((project.path.clone(), project.language.clone()))
                    .or_insert_with(|| ScheduledRoot {
                        project: project.clone(),
                        scheduled_as: ScheduledAs::Changed,
                        changed_files: Vec::new(),
                        workspace_wide: false,
                    });
            }
            let languages: Vec<_> = language_for_path(&file.path)
                .map(|language| vec![language])
                .unwrap_or_else(|| {
                    self.roots
                        .iter()
                        .filter(|root| root.manifest.as_deref() == Some(&file.path))
                        .map(|root| root.language.as_str())
                        .collect()
                });
            for language in languages {
                if let Some(project) = self.root_for(&file.path, language) {
                    let root = scheduled
                        .entry((project.path.clone(), project.language.clone()))
                        .or_insert_with(|| ScheduledRoot {
                            project: project.clone(),
                            scheduled_as: ScheduledAs::Changed,
                            changed_files: Vec::new(),
                            workspace_wide: false,
                        });
                    root.changed_files.push(file.path.clone());
                }
            }
        }
        let mut queue: VecDeque<_> = scheduled.keys().cloned().collect();
        while let Some((dependency, language)) = queue.pop_front() {
            for project in &self.roots {
                if project.language == language
                    && self
                        .dependencies
                        .get(&project.path)
                        .is_some_and(|dependencies| dependencies.contains(&dependency))
                {
                    let key = (project.path.clone(), project.language.clone());
                    if let std::collections::btree_map::Entry::Vacant(entry) =
                        scheduled.entry(key.clone())
                    {
                        entry.insert(ScheduledRoot {
                            project: project.clone(),
                            scheduled_as: ScheduledAs::Dependent,
                            changed_files: Vec::new(),
                            workspace_wide: false,
                        });
                        queue.push_back(key);
                    }
                }
            }
        }
        for root in scheduled
            .values_mut()
            .filter(|root| root.project.language == "rust")
        {
            let has_members = self
                .roots
                .iter()
                .any(|member| member.workspace.as_deref() == Some(&root.project.path));
            root.workspace_wide = has_members
                && (root.project.name.is_none()
                    || diff.files.iter().any(|file| {
                        root.project.manifest.as_deref() == Some(&file.path)
                            || (parent(&file.path) == root.project.path
                                && matches!(
                                    file.path.rsplit('/').next(),
                                    Some("rust-toolchain.toml" | "rust-toolchain")
                                ))
                    }));
        }
        let workspace_runs: BTreeSet<_> = scheduled
            .values()
            .filter(|root| root.project.language == "rust" && root.workspace_wide)
            .map(|root| root.project.path.clone())
            .collect();
        scheduled
            .into_values()
            .filter(|root| {
                root.project.language != "rust"
                    || !root
                        .project
                        .workspace
                        .as_ref()
                        .is_some_and(|workspace| workspace_runs.contains(workspace))
            })
            .collect()
    }
}

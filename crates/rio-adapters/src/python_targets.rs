//! Infer mypy's scope only when the project has not configured its own targets.
use std::collections::BTreeSet;

use rio_git::Tree;
use toml::Value;

use crate::ancestor_config;

fn text<'a>(tree: &'a Tree, path: &str) -> Option<&'a str> {
    std::str::from_utf8(&tree.get(path)?.content).ok()
}

fn at<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().try_fold(value, |value, key| value.get(key))
}

fn strings(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::String(value)) => vec![value.clone()],
        Some(Value::Array(values)) => values
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        _ => Vec::new(),
    }
}

fn ini_has(section_text: &str, key: Option<&str>) -> bool {
    let mut in_mypy = false;
    for line in section_text.lines().map(str::trim) {
        if line.starts_with('[') {
            in_mypy = line == "[mypy]";
            if in_mypy && key.is_none() {
                return true;
            }
        } else if in_mypy
            && !line.starts_with(['#', ';'])
            && let Some((name, _)) = line.split_once('=')
            && Some(name.trim()) == key
        {
            return true;
        }
    }
    false
}

/// Use mypy's own parser for explicit files/packages/modules and exclude rules.
/// Pin the discovered configuration so ancestor config is also used in a tool tree.
pub(crate) fn mypy_config(tree: &Tree, root: &str) -> Option<(String, bool)> {
    let mut directory = if root == "." { "" } else { root };
    loop {
        for name in ["mypy.ini", ".mypy.ini", "pyproject.toml", "setup.cfg"] {
            let path = if directory.is_empty() {
                name.into()
            } else {
                format!("{directory}/{name}")
            };
            let Some(content) = text(tree, &path) else {
                continue;
            };
            let targets = if name == "pyproject.toml" {
                let Some(value) = toml::from_str::<Value>(content).ok() else {
                    continue;
                };
                let Some(mypy) = at(&value, &["tool", "mypy"]) else {
                    continue;
                };
                ["files", "packages", "modules"]
                    .iter()
                    .any(|key| mypy.get(key).is_some())
            } else {
                if !ini_has(content, None) {
                    continue;
                }
                ["files", "packages", "modules"]
                    .iter()
                    .any(|key| ini_has(content, Some(key)))
            };
            return Some((path, targets));
        }
        if directory.is_empty() {
            return None;
        }
        directory = directory.rsplit_once('/').map_or("", |(parent, _)| parent);
    }
}

fn matches(pattern: &str, path: &str) -> bool {
    globset::Glob::new(pattern).is_ok_and(|glob| glob.compile_matcher().is_match(path))
}

fn join(parent: &str, child: &str) -> String {
    if parent.is_empty() || parent == "." {
        child.into()
    } else {
        format!("{parent}/{child}")
    }
}

pub(crate) fn python_package_targets(tree: &Tree, root: &str) -> Vec<String> {
    let prefix = if root == "." {
        String::new()
    } else {
        format!("{root}/")
    };
    let files: BTreeSet<_> = tree
        .keys()
        .filter_map(|path| path.strip_prefix(&prefix))
        .collect();
    let mut directories = BTreeSet::new();
    for file in &files {
        if !(file.ends_with(".py") || file.ends_with(".pyi")) {
            continue;
        }
        let mut directory = file.rsplit_once('/').map(|(parent, _)| parent);
        while let Some(path) = directory {
            directories.insert(path.to_owned());
            directory = path.rsplit_once('/').map(|(parent, _)| parent);
        }
    }
    let exists = |path: &str| directories.contains(path) || files.contains(path);
    let module_paths = |name: &str, parent: &str| {
        let path = join(parent, &name.replace('.', "/"));
        [path.clone(), format!("{path}.py"), format!("{path}.pyi")]
            .into_iter()
            .filter(|path| exists(path))
            .collect::<Vec<_>>()
    };
    let pyproject = ancestor_config(tree, root, &["pyproject.toml"])
        .filter(|path| path == &format!("{prefix}pyproject.toml"))
        .and_then(|path| text(tree, &path))
        .and_then(|content| toml::from_str::<Value>(content).ok());
    let mut targets = Vec::new();
    if let Some(project) = pyproject {
        if let Some(setuptools) = at(&project, &["tool", "setuptools"]) {
            let package_dirs = setuptools.get("package-dir");
            for package in strings(setuptools.get("packages")) {
                if let Some(path) = package_dirs
                    .and_then(|dirs| dirs.get(&package))
                    .and_then(Value::as_str)
                {
                    if exists(path) {
                        targets.push(path.into());
                    }
                } else {
                    let parent = package_dirs
                        .and_then(|dirs| dirs.get(""))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    targets.extend(module_paths(&package, parent));
                }
            }
            if let Some(find) = at(setuptools, &["packages", "find"]) {
                let mut wheres = strings(find.get("where"));
                if wheres.is_empty() {
                    wheres.push(".".into());
                }
                let mut includes = strings(find.get("include"));
                if includes.is_empty() {
                    includes.push("*".into());
                }
                let excludes = strings(find.get("exclude"));
                for directory in &directories {
                    for parent in &wheres {
                        let name = if parent == "." {
                            Some(directory.as_str())
                        } else {
                            directory.strip_prefix(&format!("{parent}/"))
                        };
                        if let Some(name) = name {
                            let name = name.replace('/', ".");
                            if includes.iter().any(|pattern| matches(pattern, &name))
                                && !excludes.iter().any(|pattern| matches(pattern, &name))
                            {
                                targets.push(directory.clone());
                            }
                        }
                    }
                }
            }
        }
        for package in strings(at(
            &project,
            &["tool", "hatch", "build", "targets", "wheel", "packages"],
        )) {
            if exists(&package) {
                targets.push(package);
            }
        }
        if let Some(packages) =
            at(&project, &["tool", "poetry", "packages"]).and_then(Value::as_array)
        {
            for package in packages {
                if let Some(include) = package.get("include").and_then(Value::as_str) {
                    let parent = package.get("from").and_then(Value::as_str).unwrap_or("");
                    let pattern = join(parent, include);
                    targets.extend(
                        directories
                            .iter()
                            .filter(|path| matches(&pattern, path))
                            .cloned(),
                    );
                    targets.extend(
                        files
                            .iter()
                            .filter(|path| matches(&pattern, path))
                            .map(|path| (*path).to_owned()),
                    );
                }
            }
        }
        if let Some(name) =
            at(&project, &["tool", "flit", "module", "name"]).and_then(Value::as_str)
        {
            for parent in ["", "src"] {
                let paths = module_paths(name, parent);
                if !paths.is_empty() {
                    targets.extend(paths);
                    break;
                }
            }
        }
        // Backend declarations take precedence over the distribution name.
        if targets.is_empty()
            && let Some(name) = at(&project, &["project", "name"]).and_then(Value::as_str)
        {
            let name = name.replace(['-', '.'], "_");
            for parent in ["", "src"] {
                let paths = module_paths(&name, parent);
                if !paths.is_empty() {
                    targets.extend(paths);
                    break;
                }
            }
        }
    }
    if targets.is_empty() {
        for directory in &directories {
            if !directory.contains('/')
                && !directory.starts_with('.')
                && ![
                    "tests",
                    "test",
                    "docs",
                    "examples",
                    "scripts",
                    "benchmarks",
                    "build",
                    "dist",
                    "vendor",
                    "venv",
                    "node_modules",
                    "target",
                    "__pycache__",
                ]
                .contains(&directory.as_str())
                && files.contains(format!("{directory}/__init__.py").as_str())
            {
                targets.push(directory.clone());
            }
        }
    }
    targets.sort();
    targets.dedup();
    let parents = targets.clone();
    targets.retain(|target| {
        !parents
            .iter()
            .any(|parent| parent != target && target.starts_with(&format!("{parent}/")))
    });
    if targets.is_empty() {
        targets.push(".".into());
    }
    targets
}

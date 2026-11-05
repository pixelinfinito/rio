use crate::{CoverageSettings, ancestor_config, parse_source, vitest_supports_all};
use anyhow::{Context, Result};
use rio_git::Tree;
use serde_json::Value;
use tree_sitter::Node;

fn source_text<'a>(node: Node<'_>, source: &'a [u8]) -> &'a str {
    std::str::from_utf8(&source[node.byte_range()]).unwrap_or_default()
}

fn property<'a>(object: Node<'a>, key: &str, source: &[u8]) -> Option<Node<'a>> {
    let mut cursor = object.walk();
    object.named_children(&mut cursor).find_map(|pair| {
        let name = pair.child_by_field_name("key")?;
        let name = source_text(name, source).trim_matches(['\'', '"']);
        if name == key {
            pair.child_by_field_name("value")
        } else {
            None
        }
    })
}

fn has_spread(node: Node<'_>) -> bool {
    let mut cursor = node.walk();
    node.named_children(&mut cursor)
        .any(|child| child.kind() == "spread_element")
}

fn array(node: Node<'_>, source: &[u8]) -> Option<Vec<String>> {
    if node.kind() != "array" {
        return None;
    }
    let mut cursor = node.walk();
    node.named_children(&mut cursor)
        .filter(|child| child.kind() != "comment")
        .map(|child| {
            if child.kind() == "string" {
                json5::from_str(source_text(child, source)).ok()
            } else {
                None
            }
        })
        .collect()
}

/// Read the exported config object and static string arrays without executing
/// project JavaScript. Calls other than defineConfig, spreads and computed
/// values leave absent files unattributed.
fn exported_object<'a>(node: Node<'a>, source: &[u8]) -> Option<Node<'a>> {
    if node.kind() == "export_statement" {
        let value = node
            .child_by_field_name("value")
            .or_else(|| node.child_by_field_name("declaration"))?;
        return config_value(value, source);
    }
    if node.kind() == "assignment_expression"
        && node
            .child_by_field_name("left")
            .is_some_and(|left| source_text(left, source) == "module.exports")
    {
        return node
            .child_by_field_name("right")
            .and_then(|value| config_value(value, source));
    }
    let mut cursor = node.walk();
    node.named_children(&mut cursor)
        .find_map(|child| exported_object(child, source))
}

fn config_value<'a>(value: Node<'a>, source: &[u8]) -> Option<Node<'a>> {
    if value.kind() == "object" {
        return Some(value);
    }
    if value.kind() == "call_expression"
        && value
            .child_by_field_name("function")
            .is_some_and(|function| source_text(function, source) == "defineConfig")
    {
        let arguments = value.child_by_field_name("arguments")?;
        let mut cursor = arguments.walk();
        return arguments
            .named_children(&mut cursor)
            .next()
            .and_then(|node| (node.kind() == "object").then_some(node));
    }
    None
}

pub fn typescript_test_runner(tree: &Tree, root: &str) -> Option<&'static str> {
    let mut directory = root.to_owned();
    loop {
        if let Some(path) = ancestor_config(tree, &directory, &["package.json"])
            && let Some(value) = tree
                .get(&path)
                .and_then(|entry| serde_json::from_slice::<Value>(&entry.content).ok())
        {
            for runner in ["vitest", "jest"] {
                if ["dependencies", "devDependencies"]
                    .iter()
                    .any(|key| value[*key].get(runner).is_some())
                    || value["scripts"].as_object().is_some_and(|scripts| {
                        scripts.values().any(|script| {
                            script.as_str().is_some_and(|script| {
                                script.split_whitespace().any(|word| word == runner)
                            })
                        })
                    })
                {
                    return Some(runner);
                }
            }
            let parent = path.rsplit_once('/').map_or("", |(dir, _)| dir);
            if parent.is_empty() {
                break;
            }
            directory = parent
                .rsplit_once('/')
                .map_or(".", |(dir, _)| dir)
                .to_owned();
        } else {
            break;
        }
    }
    if ancestor_config(tree, root, VITEST_CONFIGS).is_some() {
        Some("vitest")
    } else if ancestor_config(
        tree,
        root,
        &[
            "jest.config.ts",
            "jest.config.js",
            "jest.config.mjs",
            "jest.config.cjs",
            "jest.config.json",
        ],
    )
    .is_some()
    {
        Some("jest")
    } else {
        None
    }
}

pub fn typescript_coverage_settings(
    tree: &Tree,
    root: &str,
    runner: &str,
    version: &str,
) -> Result<CoverageSettings> {
    let mut settings = CoverageSettings {
        root: root.into(),
        language: "typescript".into(),
        static_known: true,
        ..Default::default()
    };
    let names = if runner == "vitest" {
        VITEST_CONFIGS.to_vec()
    } else {
        vec![
            "jest.config.ts",
            "jest.config.js",
            "jest.config.mjs",
            "jest.config.cjs",
            "jest.config.json",
        ]
    };
    if let Some(config) = ancestor_config(tree, root, &names) {
        let entry = &tree[&config];
        if config.ends_with(".json") {
            let value: Value = serde_json::from_slice(&entry.content)?;
            settings.include = value
                .get("collectCoverageFrom")
                .and_then(|value| serde_json::from_value(value.clone()).ok());
            settings.static_known =
                value.get("collectCoverageFrom").is_none() || settings.include.is_some();
        } else {
            let syntax = parse_source(&config, &entry.content)?;
            let object = exported_object(syntax.root_node(), &entry.content);
            if let Some(object) =
                object.filter(|object| !has_spread(*object) && !syntax.root_node().has_error())
            {
                let coverage = if runner == "vitest" {
                    property(object, "test", &entry.content)
                        .and_then(|test| property(test, "coverage", &entry.content))
                } else {
                    Some(object)
                };
                if let Some(coverage) = coverage {
                    if coverage.kind() != "object" || has_spread(coverage) {
                        settings.static_known = false;
                    } else {
                        for (key, target) in [
                            (
                                if runner == "jest" {
                                    "collectCoverageFrom"
                                } else {
                                    "include"
                                },
                                true,
                            ),
                            (
                                if runner == "jest" {
                                    "coveragePathIgnorePatterns"
                                } else {
                                    "exclude"
                                },
                                false,
                            ),
                        ] {
                            if let Some(value) = property(coverage, key, &entry.content) {
                                if let Some(patterns) = array(value, &entry.content) {
                                    if target {
                                        settings.include = Some(patterns);
                                    } else if runner == "vitest" {
                                        settings.exclude = patterns;
                                    } else {
                                        settings.static_known = false;
                                    } // Jest ignore patterns are regexes, not globs.
                                } else {
                                    settings.static_known = false;
                                }
                            }
                        }
                    }
                } else if runner == "vitest"
                    && property(object, "test", &entry.content)
                        .is_some_and(|test| test.kind() != "object" || has_spread(test))
                {
                    settings.static_known = false;
                }
            } else {
                settings.static_known = false;
            }
        }
        settings
            .notes
            .push(format!("coverage configuration: {config}"));
    } else if runner == "jest"
        && let Some(path) = ancestor_config(tree, root, &["package.json"])
    {
        let value: Value = serde_json::from_slice(&tree[&path].content)?;
        settings.include = value["jest"]
            .get("collectCoverageFrom")
            .and_then(|value| serde_json::from_value(value.clone()).ok());
    }
    if runner == "vitest" {
        let (cwd, args) = vitest_execution(tree, root);
        settings.invocation_root = Some(cwd);
        settings.runner_args = args;
    }
    settings.reports_unloaded = settings.static_known
        && if runner == "vitest" {
            vitest_supports_all(version) || settings.include.is_some()
        } else {
            settings.include.is_some()
        };
    Ok(settings)
}

fn list(value: &Value) -> Option<Vec<String>> {
    value
        .as_str()
        .map(|value| {
            value
                .split([',', '\n'])
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .or_else(|| {
            value.as_array().and_then(|values| {
                values
                    .iter()
                    .map(|value| value.as_str().map(str::to_owned))
                    .collect()
            })
        })
}

pub fn python_coverage_settings(tree: &Tree, root: &str) -> Result<CoverageSettings> {
    let mut settings = CoverageSettings {
        root: root.into(),
        language: "python".into(),
        static_known: true,
        reports_unloaded: true,
        ..Default::default()
    };
    let mut values = Value::Object(Default::default());
    if let Some(config) = ancestor_config(
        tree,
        root,
        &[".coveragerc", "pyproject.toml", "setup.cfg", "tox.ini"],
    ) {
        let text = std::str::from_utf8(&tree[&config].content)?;
        if config.ends_with(".toml") {
            let document: toml::Value =
                toml::from_str(text).with_context(|| format!("invalid {config}"))?;
            values = serde_json::to_value(document)?["tool"]["coverage"]["run"].clone();
        } else {
            let mut in_run = false;
            let mut key = String::new();
            for line in text.lines() {
                let trimmed = line.trim();
                if trimmed.starts_with('[') {
                    in_run = matches!(trimmed, "[run]" | "[coverage:run]");
                    key.clear();
                    continue;
                }
                if !in_run || trimmed.is_empty() || trimmed.starts_with(['#', ';']) {
                    continue;
                }
                if let Some((name, value)) = trimmed.split_once('=') {
                    key = name.trim().into();
                    values[&key] = Value::String(value.trim().into());
                } else if line.starts_with(char::is_whitespace)
                    && let Some(value) = values
                        .get_mut(&key)
                        .and_then(|value| value.as_str().map(str::to_owned))
                {
                    values[&key] = Value::String(format!("{value}\n{trimmed}"));
                }
            }
        }
        settings
            .notes
            .push(format!("coverage configuration: {config}"));
    }
    settings.python_parallel = values["parallel"].as_bool().unwrap_or_else(|| {
        values["parallel"].as_str().is_some_and(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "true" | "yes" | "on" | "1"
            )
        })
    });
    settings.exclude = list(&values["omit"]).unwrap_or_default();
    settings.include = list(&values["include"]);
    let sources = list(&values["source"]);
    settings.add_python_source = sources.is_none() && settings.include.is_none();
    if let Some(sources) = sources {
        let mut include = Vec::new();
        for source in sources {
            let module = source.replace('.', "/");
            let prefix = if root == "." {
                String::new()
            } else {
                format!("{root}/")
            };
            let mut found = false;
            for candidate in [&source, &module, &format!("src/{module}")] {
                if tree
                    .keys()
                    .any(|path| path.starts_with(&format!("{prefix}{candidate}/")))
                {
                    include.push(format!("{candidate}/**"));
                    found = true;
                } else if tree.contains_key(&format!("{prefix}{candidate}.py")) {
                    include.push(format!("{candidate}.py"));
                    found = true;
                }
            }
            if !found {
                settings.static_known = false;
            }
        }
        if settings.static_known {
            settings.include = Some(include);
        }
    }
    if values.to_string().contains('$') {
        settings.static_known = false;
        settings.reports_unloaded = false;
    }
    Ok(settings)
}

const VITEST_CONFIGS: &[&str] = &[
    "vitest.config.ts",
    "vitest.config.js",
    "vitest.config.mts",
    "vitest.config.mjs",
    "vitest.config.cts",
    "vitest.config.cjs",
    "vite.config.ts",
    "vite.config.js",
    "vite.config.mts",
    "vite.config.mjs",
    "vite.config.cts",
    "vite.config.cjs",
    "vitest.workspace.ts",
    "vitest.workspace.js",
    "vitest.workspace.mts",
    "vitest.workspace.mjs",
    "vitest.workspace.cts",
    "vitest.workspace.cjs",
    "vitest.workspace.json",
];

/// Keep workspace imports and relative project paths anchored to their config.
/// File filters limit a root workspace run when no static project name exists.
pub fn vitest_execution(tree: &Tree, root: &str) -> (String, Vec<String>) {
    let workspace = ancestor_config(
        tree,
        root,
        &VITEST_CONFIGS
            .iter()
            .copied()
            .filter(|name| name.starts_with("vitest.workspace"))
            .collect::<Vec<_>>(),
    );
    let mut directory = root.to_owned();
    let mut projects = None;
    loop {
        if let Some(config) = ancestor_config(tree, &directory, VITEST_CONFIGS) {
            let entry = &tree[&config];
            if let Ok(syntax) = parse_source(&config, &entry.content)
                && let Some(object) = exported_object(syntax.root_node(), &entry.content)
                && property(object, "test", &entry.content)
                    .is_some_and(|test| property(test, "projects", &entry.content).is_some())
            {
                projects = Some(config.clone());
                break;
            }
            let parent = config.rsplit_once('/').map_or("", |(dir, _)| dir);
            if parent.is_empty() {
                break;
            }
            directory = parent
                .rsplit_once('/')
                .map_or(".", |(dir, _)| dir)
                .to_owned();
        } else {
            break;
        }
    }
    let config = projects
        .or(workspace)
        .or_else(|| ancestor_config(tree, root, VITEST_CONFIGS));
    let Some(config) = config else {
        return (root.into(), Vec::new());
    };
    let cwd = config
        .rsplit_once('/')
        .map_or(".", |(parent, _)| parent)
        .to_owned();
    let mut args = Vec::new();
    if !config.contains("vitest.workspace.") {
        args.extend(["--config".into(), config.rsplit('/').next().unwrap().into()]);
    }
    if cwd != root && root != "." {
        args.push(root.strip_prefix(&format!("{cwd}/")).unwrap_or(root).into());
    }
    (cwd, args)
}

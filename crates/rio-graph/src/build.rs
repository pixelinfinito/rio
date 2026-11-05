use crate::{EdgeKind, EdgeSource, GraphEdge, GraphNode, GraphSlice, GraphSlices, NodeKind};
use aho_corasick::AhoCorasick;
use anyhow::{Result, ensure};
use rio_adapters::{Symbol, SymbolKind, SyntaxCache, SyntaxTable, is_test_path, language_for_path};
use rio_core::Version;
use rio_git::{ChangeSet, Diff, Exclusions, Tree};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

#[derive(Debug, Clone)]
pub struct GraphOptions {
    pub hops: usize,
    pub max_nodes: usize,
    pub exclude: Vec<String>,
}
impl Default for GraphOptions {
    fn default() -> Self {
        Self {
            hops: 2,
            max_nodes: 2000,
            exclude: Vec::new(),
        }
    }
}

fn graph_node(
    path: &str,
    symbol: Option<&Symbol>,
    source: &[u8],
    version: Version,
    seed: bool,
    hop: usize,
) -> GraphNode {
    let symbol_path = symbol
        .map(|symbol| symbol.symbol_path.clone())
        .unwrap_or_default();
    let id = blake3::hash(format!("{version:?}:{path}::{symbol_path}").as_bytes())
        .to_hex()
        .to_string();
    let kind = if is_test_path(path) {
        NodeKind::Test
    } else {
        match symbol.map(|symbol| symbol.kind) {
            Some(SymbolKind::Function) => NodeKind::Function,
            Some(SymbolKind::Method) => NodeKind::Method,
            Some(SymbolKind::Test) => NodeKind::Test,
            Some(SymbolKind::Class | SymbolKind::Interface | SymbolKind::Enum) => NodeKind::Class,
            _ => NodeKind::File,
        }
    };
    let content = symbol
        .map(|symbol| &source[symbol.byte_start..symbol.byte_end])
        .unwrap_or(source);
    GraphNode {
        id,
        kind,
        path: path.into(),
        symbol_path,
        name: symbol
            .map(|symbol| symbol.name.clone())
            .unwrap_or_else(|| path.rsplit('/').next().unwrap_or(path).into()),
        line_start: symbol.map_or(1, |symbol| symbol.line_start),
        line_end: symbol.map_or_else(
            || source.split(|&byte| byte == b'\n').count() as u32,
            |symbol| symbol.line_end,
        ),
        version,
        seed,
        hop,
        content_hash: blake3::hash(content).to_hex().to_string(),
    }
}

fn ignored(tree: &Tree, path: &str) -> Result<bool> {
    let mut files: Vec<_> = tree
        .iter()
        .filter(|(name, _)| name.rsplit('/').next() == Some(".gitignore"))
        .collect();
    files.sort_by_key(|(name, _)| name.len());
    let mut ignored = false;
    for (name, entry) in files {
        let directory = name.rsplit_once('/').map_or("", |(directory, _)| directory);
        let relative = if directory.is_empty() {
            path
        } else if let Some(path) = path.strip_prefix(&format!("{directory}/")) {
            path
        } else {
            continue;
        };
        let mut builder = ignore::gitignore::GitignoreBuilder::new("");
        for line in std::str::from_utf8(&entry.content)?.lines() {
            builder.add_line(None, line)?;
        }
        match builder
            .build()?
            .matched_path_or_any_parents(relative, false)
        {
            ignore::Match::Ignore(_) => ignored = true,
            ignore::Match::Whitelist(_) => ignored = false,
            ignore::Match::None => {}
        }
    }
    Ok(ignored)
}

#[derive(Default)]
pub struct GraphBuilder {
    pub syntax: SyntaxCache,
}
impl GraphBuilder {
    pub fn build(
        &self,
        changes: &ChangeSet,
        diff: &Diff,
        options: &GraphOptions,
    ) -> Result<GraphSlices> {
        self.build_until(changes, diff, options, &|| false)
    }
    pub fn build_until(
        &self,
        changes: &ChangeSet,
        diff: &Diff,
        options: &GraphOptions,
        stop: &dyn Fn() -> bool,
    ) -> Result<GraphSlices> {
        ensure!(options.max_nodes > 0, "graph max_nodes must be positive");
        let base = self.slice(&changes.base, diff, Version::Base, options, stop)?;
        let head = self.slice(&changes.head, diff, Version::Head, options, stop)?;
        Ok(GraphSlices::new(base, head))
    }
    fn slice(
        &self,
        tree: &Tree,
        diff: &Diff,
        version: Version,
        options: &GraphOptions,
        stop: &dyn Fn() -> bool,
    ) -> Result<GraphSlice> {
        let exclusions = Exclusions::new(tree, &options.exclude)?;
        let mut slice = GraphSlice::default();
        let mut nodes = BTreeMap::new();
        let mut queue = VecDeque::new();
        let mut tables = BTreeMap::<String, SyntaxTable>::new();
        for file in &diff.files {
            if stop() {
                slice.truncated = true;
                break;
            }
            if file.binary || file.excluded.is_some() {
                continue;
            }
            let path = if version == Version::Base {
                file.old_path.as_deref().unwrap_or(&file.path)
            } else {
                &file.path
            };
            let Some(entry) = tree.get(path) else {
                continue;
            };
            if language_for_path(path).is_none() {
                continue;
            }
            let table = self.syntax.analyze(path, &entry.content)?;
            let mut seeds = BTreeSet::new();
            for hunk in &file.hunks {
                let range = if version == Version::Base {
                    hunk.base
                } else {
                    hunk.head
                };
                for line in range.start..range.start + range.count {
                    seeds.insert(
                        table
                            .enclosing(line)
                            .map(|symbol| symbol.symbol_path.clone()),
                    );
                }
            }
            if file.hunks.is_empty() {
                seeds.insert(None);
            }
            for seed in seeds {
                let symbol = seed.as_ref().and_then(|seed| {
                    table
                        .symbols
                        .iter()
                        .find(|symbol| &symbol.symbol_path == seed)
                });
                let node = graph_node(path, symbol, &entry.content, version, true, 0);
                if nodes.contains_key(&node.id) {
                    continue;
                }
                if nodes.len() >= options.max_nodes {
                    slice.truncated = true;
                    break;
                }
                queue.push_back(node.id.clone());
                nodes.insert(node.id.clone(), node);
            }
            tables.insert(path.into(), table);
        }
        let candidates: Vec<_> = tree
            .iter()
            .filter(|(path, entry)| {
                language_for_path(path).is_some()
                    && entry.mode != 0o120000
                    && exclusions.reason(path, entry, true).is_none()
            })
            .filter_map(|(path, entry)| match ignored(tree, path) {
                Ok(false) => Some(Ok((path, entry))),
                Ok(true) => None,
                Err(error) => Some(Err(error)),
            })
            .collect::<Result<_>>()?;
        let mut edges = BTreeMap::new();
        let mut imports = BTreeMap::<String, BTreeMap<String, Option<String>>>::new();
        'expand: while let Some(id) = queue.pop_front() {
            if stop() {
                slice.truncated = true;
                break;
            }
            let target = nodes[&id].clone();
            if target.hop >= options.hops {
                continue;
            }
            // Import declarations keep aliased references in the candidate set.
            // Parsing then discards matches in comments and strings.
            let module = target
                .path
                .rsplit('/')
                .next()
                .unwrap_or(&target.path)
                .split('.')
                .next()
                .unwrap_or(&target.name);
            let search = AhoCorasick::new([target.name.as_str(), module])?;
            for (path, entry) in &candidates {
                if stop() {
                    slice.truncated = true;
                    break;
                }
                if !search.is_match(&entry.content) {
                    continue;
                }
                if !tables.contains_key(*path) {
                    tables.insert((*path).clone(), self.syntax.analyze(path, &entry.content)?);
                }
                let table = &tables[*path];
                let resolved_imports = imports.entry((*path).clone()).or_insert_with(|| {
                    table
                        .imports
                        .iter()
                        .map(|import| {
                            (
                                import.module.clone(),
                                crate::resolve::resolve_import(tree, path, &import.module),
                            )
                        })
                        .collect()
                });
                let mut names = BTreeSet::from([target.name.as_str()]);
                for import in &table.imports {
                    for (alias, name) in &import.names {
                        if target.symbol_path.is_empty()
                            || name == &target.name
                            || name == "default"
                            || name == "*"
                        {
                            names.insert(alias);
                        }
                    }
                }
                for identifier in &table.identifiers {
                    if stop() {
                        slice.truncated = true;
                        break;
                    }
                    if !names.contains(identifier.name.as_str()) {
                        continue;
                    }
                    let Some(confidence) = crate::resolve::reference(
                        path,
                        table,
                        identifier,
                        &target,
                        resolved_imports,
                    ) else {
                        continue;
                    };
                    let symbol = table.enclosing_byte(identifier.byte_start);
                    let node =
                        graph_node(path, symbol, &entry.content, version, false, target.hop + 1);
                    if node.id == target.id {
                        continue;
                    }
                    if !nodes.contains_key(&node.id) {
                        if nodes.len() >= options.max_nodes {
                            slice.truncated = true;
                            break 'expand;
                        }
                        queue.push_back(node.id.clone());
                        nodes.insert(node.id.clone(), node.clone());
                    }
                    let kind = if is_test_path(path)
                        || symbol.is_some_and(|symbol| symbol.kind == SymbolKind::Test)
                    {
                        EdgeKind::Tests
                    } else if identifier.call {
                        EdgeKind::Calls
                    } else {
                        EdgeKind::References
                    };
                    edges
                        .entry((node.id.clone(), target.id.clone(), kind))
                        .or_insert(GraphEdge {
                            from: node.id,
                            to: target.id.clone(),
                            kind,
                            source: EdgeSource::TreeSitter,
                            confidence,
                            version,
                        });
                }
            }
        }
        slice.nodes = nodes.into_values().collect();
        slice
            .nodes
            .sort_by(|a, b| (&a.path, &a.symbol_path).cmp(&(&b.path, &b.symbol_path)));
        slice.edges = edges.into_values().collect();
        Ok(slice)
    }
}

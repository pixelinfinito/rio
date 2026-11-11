use crate::{EdgeKind, EdgeSource, GraphEdge, GraphNode, GraphSlice, GraphSlices, NodeKind};
use anyhow::{Result, ensure};
use rio_adapters::{Symbol, SymbolKind, SyntaxCache, SyntaxTable, is_test_path, language_for_path};
use rio_core::Version;
use rio_git::{ChangeSet, Diff, Exclusions, Tree};
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};

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

pub(crate) fn graph_node(
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

/// The tree's `.gitignore` rules, each compiled at most once, applied as
/// `ignored` applies them: shallowest first, the last match winning.
struct IgnoreRules<'a> {
    // (directory, rules text, rules compiled on first use)
    files: Vec<(&'a str, &'a [u8], CompiledRules)>,
}
type CompiledRules = std::cell::OnceCell<Result<ignore::gitignore::Gitignore, String>>;
impl<'a> IgnoreRules<'a> {
    fn new(tree: &'a Tree) -> Self {
        let mut files: Vec<_> = tree
            .iter()
            .filter(|(name, _)| name.rsplit('/').next() == Some(".gitignore"))
            .map(|(name, entry)| {
                (
                    name.rsplit_once('/').map_or("", |(directory, _)| directory),
                    entry.content.as_slice(),
                    std::cell::OnceCell::new(),
                )
            })
            .collect();
        // The directory is the name minus "/.gitignore", so this is the same order.
        files.sort_by_key(|(directory, _, _)| directory.len());
        Self { files }
    }
    fn ignored(&self, path: &str) -> Result<bool> {
        let mut ignored = false;
        for (directory, content, compiled) in &self.files {
            let relative = if directory.is_empty() {
                path
            } else if let Some(path) = path
                .strip_prefix(*directory)
                .and_then(|rest| rest.strip_prefix('/'))
            {
                path
            } else {
                continue;
            };
            let matcher = compiled
                .get_or_init(|| {
                    let build = || -> Result<ignore::gitignore::Gitignore> {
                        let mut builder = ignore::gitignore::GitignoreBuilder::new("");
                        for line in std::str::from_utf8(content)?.lines() {
                            builder.add_line(None, line)?;
                        }
                        Ok(builder.build()?)
                    };
                    build().map_err(|error| format!("{error:#}"))
                })
                .as_ref()
                .map_err(|error| anyhow::anyhow!("{error}"))?;
            match matcher.matched_path_or_any_parents(relative, false) {
                ignore::Match::Ignore(_) => ignored = true,
                ignore::Match::Whitelist(_) => ignored = false,
                ignore::Match::None => {}
            }
        }
        Ok(ignored)
    }
}

#[derive(Default)]
pub struct GraphBuilder {
    pub syntax: SyntaxCache,
    /// Parsing threads; `None` uses `RIO_GRAPH_THREADS`, else at most four of
    /// the available cores. The slices are identical for every value.
    pub threads: Option<usize>,
}
/// `RIO_GRAPH_THREADS`, else the available parallelism capped at four, so a
/// review leaves the machine's other cores to concurrent work.
pub fn default_threads() -> usize {
    std::env::var("RIO_GRAPH_THREADS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|&n| n > 0)
        .unwrap_or_else(|| {
            std::thread::available_parallelism()
                .map_or(1, usize::from)
                .min(4)
        })
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
        stop: &(dyn Fn() -> bool + Sync),
    ) -> Result<GraphSlices> {
        ensure!(options.max_nodes > 0, "graph max_nodes must be positive");
        let base = self.slice(
            &changes.base,
            &changes.head,
            diff,
            Version::Base,
            options,
            stop,
        )?;
        let head = self.slice(
            &changes.head,
            &changes.base,
            diff,
            Version::Head,
            options,
            stop,
        )?;
        Ok(GraphSlices::new(base, head))
    }
    fn slice(
        &self,
        tree: &Tree,
        other_tree: &Tree,
        diff: &Diff,
        version: Version,
        options: &GraphOptions,
        stop: &(dyn Fn() -> bool + Sync),
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
            // Parsed lazily, once per file: only pure insertions/deletions need it.
            let mut other_table = None;
            for hunk in &file.hunks {
                let range = if version == Version::Base {
                    hunk.base
                } else {
                    hunk.head
                };
                if range.count == 0 {
                    // A pure deletion/insertion can still change the enclosing symbol.
                    // Match its identity in the other snapshot, rather than incorrectly
                    // seeding an unrelated symbol adjacent to the empty hunk.
                    let other_path = if version == Version::Base {
                        &file.path
                    } else {
                        file.old_path.as_deref().unwrap_or(&file.path)
                    };
                    if other_table.is_none() {
                        // A rename can change the language; an unsupported or missing
                        // counterpart only supports a file-level seed.
                        other_table = Some(
                            other_tree
                                .get(other_path)
                                .filter(|_| language_for_path(other_path).is_some())
                                .map(|other| self.syntax.analyze(other_path, &other.content))
                                .transpose()?,
                        );
                    }
                    let other_range = if version == Version::Base {
                        hunk.head
                    } else {
                        hunk.base
                    };
                    match other_table.as_ref().expect("parsed above") {
                        Some(other_table) => {
                            for line in other_range.start..other_range.start + other_range.count {
                                seeds.insert(shared_enclosing(other_table, &table, line));
                            }
                        }
                        None => {
                            seeds.insert(None);
                        }
                    }
                }
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
        let rules = IgnoreRules::new(tree);
        let candidates: Vec<_> = tree
            .iter()
            .filter(|(path, entry)| {
                language_for_path(path).is_some()
                    && entry.mode != 0o120000
                    && exclusions.reason(path, entry, true).is_none()
            })
            .filter_map(|(path, entry)| match rules.ignored(path) {
                Ok(false) => Some(Ok((path, entry))),
                Ok(true) => None,
                Err(error) => Some(Err(error)),
            })
            .collect::<Result<_>>()?;
        let mut edges = BTreeMap::new();
        let mut imports = BTreeMap::<String, BTreeMap<String, Option<String>>>::new();
        let resolver = crate::resolve::Resolver::new(tree);
        let mut occurrences = HashMap::<String, HashMap<String, Vec<usize>>>::new();
        let mut index = crate::index::TokenIndex::new(
            candidates
                .iter()
                .map(|(_, entry)| entry.content.as_slice())
                .collect(),
            stop,
        );
        // An index cut by the deadline cannot answer which files mention a node.
        if !index.complete() {
            slice.truncated = true;
            queue.clear();
        }
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
            // Only files containing the name or module stem, in candidate order.
            let matching = index.any(&[target.name.as_str(), module])?;
            self.prefetch(
                matching
                    .iter()
                    .map(|&file| candidates[file as usize])
                    .filter(|(path, _)| !tables.contains_key(*path)),
                stop,
            );
            for file in matching {
                let (path, entry) = &candidates[file as usize];
                if stop() {
                    slice.truncated = true;
                    break;
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
                                resolver.resolve_import(path, &import.module),
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
                // Only occurrences of the wanted names, still in source order.
                let by_name = occurrences.entry((*path).clone()).or_insert_with(|| {
                    let mut by_name = HashMap::<String, Vec<usize>>::new();
                    for (index, identifier) in table.identifiers.iter().enumerate() {
                        by_name
                            .entry(identifier.name.clone())
                            .or_default()
                            .push(index);
                    }
                    by_name
                });
                let mut hits: Vec<usize> = names
                    .iter()
                    .filter_map(|name| by_name.get(*name))
                    .flatten()
                    .copied()
                    .collect();
                hits.sort_unstable();
                for identifier in hits.into_iter().map(|index| &table.identifiers[index]) {
                    if stop() {
                        slice.truncated = true;
                        break;
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
impl GraphBuilder {
    /// Parses files into the syntax cache in parallel. Results depend only on path
    /// and content, so the slice is the same for any thread count; failures are left
    /// for the sequential pass to report at the same point as before.
    /// Stops taking files once `stop` is true, so the deadline also bounds parsing.
    fn prefetch<'t>(
        &self,
        files: impl Iterator<Item = (&'t String, &'t rio_git::TreeEntry)>,
        stop: &(dyn Fn() -> bool + Sync),
    ) {
        let files: Vec<_> = files.collect();
        let threads = self.threads.unwrap_or_else(default_threads).max(1);
        if threads == 1 || files.len() < 2 {
            return;
        }
        let next = std::sync::atomic::AtomicUsize::new(0);
        std::thread::scope(|scope| {
            for _ in 0..threads.min(files.len()) {
                scope.spawn(|| {
                    while !stop() {
                        let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        let Some((path, entry)) = files.get(i) else {
                            break;
                        };
                        let _ = self.syntax.analyze(path, &entry.content);
                    }
                });
            }
        });
    }
}
/// The innermost symbol enclosing `line` in `other` that also exists in `table`.
/// Newly added nested symbols fall back to their nearest shared ancestor, and
/// then to the file itself.
pub(crate) fn shared_enclosing(
    other: &SyntaxTable,
    table: &SyntaxTable,
    line: u32,
) -> Option<String> {
    let mut enclosing: Vec<_> = other
        .symbols
        .iter()
        .filter(|symbol| symbol.line_start <= line && line <= symbol.line_end)
        .collect();
    enclosing.sort_by_key(|symbol| symbol.byte_end - symbol.byte_start);
    enclosing
        .into_iter()
        .find(|symbol| {
            table
                .symbols
                .iter()
                .any(|s| s.symbol_path == symbol.symbol_path)
        })
        .map(|symbol| symbol.symbol_path.clone())
}

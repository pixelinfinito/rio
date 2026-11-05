use anyhow::Result;
use rio_core::{ImpactSummary, SymbolImpact, Version};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    io::Write,
    path::Path,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    File,
    Function,
    Method,
    Class,
    Test,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphNode {
    pub id: String,
    pub kind: NodeKind,
    pub path: String,
    pub symbol_path: String,
    pub name: String,
    pub line_start: u32,
    pub line_end: u32,
    pub version: Version,
    pub seed: bool,
    pub hop: usize,
    pub content_hash: String,
}
impl GraphNode {
    pub fn key(&self) -> String {
        format!("{}::{}", self.path, self.symbol_path)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EdgeKind {
    Calls,
    Imports,
    References,
    Defines,
    Tests,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Confidence {
    Resolved,
    Probable,
    Unresolved,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EdgeSource {
    #[serde(rename = "tree-sitter")]
    TreeSitter,
    #[serde(rename = "text")]
    Text,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphEdge {
    pub from: String,
    pub to: String,
    pub kind: EdgeKind,
    pub source: EdgeSource,
    pub confidence: Confidence,
    pub version: Version,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphSlice {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphDelta {
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub changed: Vec<String>,
    pub edges_added: Vec<String>,
    pub edges_removed: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphSlices {
    pub base: GraphSlice,
    pub head: GraphSlice,
    pub delta: GraphDelta,
}
impl GraphSlices {
    pub fn new(base: GraphSlice, head: GraphSlice) -> Self {
        let base_nodes: BTreeMap<_, _> = base.nodes.iter().map(|node| (node.key(), node)).collect();
        let head_nodes: BTreeMap<_, _> = head.nodes.iter().map(|node| (node.key(), node)).collect();
        let keys = |slice: &GraphSlice| -> BTreeSet<String> {
            let nodes: BTreeMap<_, _> = slice
                .nodes
                .iter()
                .map(|node| (node.id.as_str(), node.key()))
                .collect();
            slice
                .edges
                .iter()
                .filter_map(|edge| {
                    Some(format!(
                        "{} -> {} ({:?}, {:?})",
                        nodes.get(edge.from.as_str())?,
                        nodes.get(edge.to.as_str())?,
                        edge.kind,
                        edge.confidence
                    ))
                })
                .collect()
        };
        let base_edges = keys(&base);
        let head_edges = keys(&head);
        let delta = GraphDelta {
            added: head_nodes
                .keys()
                .filter(|key| !base_nodes.contains_key(*key))
                .cloned()
                .collect(),
            removed: base_nodes
                .keys()
                .filter(|key| !head_nodes.contains_key(*key))
                .cloned()
                .collect(),
            changed: head_nodes
                .iter()
                .filter(|(key, node)| {
                    base_nodes
                        .get(*key)
                        .is_some_and(|base| base.content_hash != node.content_hash)
                })
                .map(|(key, _)| key.clone())
                .collect(),
            edges_added: head_edges.difference(&base_edges).cloned().collect(),
            edges_removed: base_edges.difference(&head_edges).cloned().collect(),
        };
        Self { base, head, delta }
    }
    pub fn write(&self, run: &Path) -> Result<()> {
        let directory = run.join("graph");
        rio_git::private_directory(&directory)?;
        for (name, value) in [
            ("base", serde_json::to_vec(&self.base)?),
            ("head", serde_json::to_vec(&self.head)?),
            ("delta", serde_json::to_vec(&self.delta)?),
        ] {
            let mut temporary = tempfile::NamedTempFile::new_in(&directory)?;
            temporary.write_all(&value)?;
            temporary.as_file().sync_all()?;
            temporary
                .persist(directory.join(format!("{name}.json")))
                .map_err(|error| error.error)?;
        }
        rio_git::sync_directory(&directory)?;
        Ok(())
    }
    pub fn impact(&self, hops: usize) -> ImpactSummary {
        let mut symbols = Vec::new();
        let mut seen = BTreeSet::new();
        for slice in [&self.head, &self.base] {
            let nodes: BTreeMap<_, _> = slice.nodes.iter().map(|node| (&node.id, node)).collect();
            for seed in slice.nodes.iter().filter(|node| node.seed) {
                if !seen.insert(seed.key()) {
                    continue;
                }
                let mut references_per_hop = vec![0; hops];
                let mut visited: BTreeSet<_> = [seed.id.clone()].into();
                let mut queue: VecDeque<_> = [(seed.id.clone(), 0)].into();
                let mut test_referenced = false;
                let mut unresolved = 0;
                while let Some((target, hop)) = queue.pop_front() {
                    if hop >= hops {
                        continue;
                    }
                    for edge in slice.edges.iter().filter(|edge| edge.to == target) {
                        unresolved += usize::from(edge.confidence == Confidence::Unresolved);
                        test_referenced |= edge.kind == EdgeKind::Tests
                            || nodes
                                .get(&edge.from)
                                .is_some_and(|node| node.kind == NodeKind::Test);
                        if visited.insert(edge.from.clone()) {
                            references_per_hop[hop] += 1;
                            queue.push_back((edge.from.clone(), hop + 1));
                        }
                    }
                }
                symbols.push(SymbolImpact {
                    path: seed.path.clone(),
                    symbol_path: seed.symbol_path.clone(),
                    references_per_hop,
                    test_referenced,
                    unresolved,
                });
            }
        }
        symbols.sort_by(|a, b| (&a.path, &a.symbol_path).cmp(&(&b.path, &b.symbol_path)));
        ImpactSummary {
            unresolved: symbols.iter().map(|symbol| symbol.unresolved).sum(),
            symbols,
            truncated: self.base.truncated || self.head.truncated,
        }
    }
}

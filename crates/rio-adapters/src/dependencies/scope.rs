use super::{DependencyGraph, Installation};
use std::{
    collections::{BTreeSet, VecDeque},
    path::Path,
};

/// Filtered pnpm installs can omit unrelated importers and their snapshots.
/// Ignore only unresolved importer requests with no installed node_modules,
/// outside all scheduled roots and the workspace packages they depend on.
/// Unresolved package edges, installed importers and scheduled roots stay strict.
pub fn scope_pnpm_importers(
    graph: &mut DependencyGraph,
    installation: Option<&mut Installation>,
    worktree: &Path,
    installation_root: &str,
    scheduled_roots: &[String],
) {
    if graph.format != "pnpm" {
        return;
    }
    let required: BTreeSet<_> = scheduled_roots
        .iter()
        .filter_map(|root| {
            if installation_root == "." || installation_root.is_empty() {
                Some(root.clone())
            } else if root == installation_root {
                Some(".".into())
            } else {
                root.strip_prefix(&format!("{installation_root}/"))
                    .map(str::to_owned)
            }
        })
        .collect();
    let mut required = required;
    let mut queue: VecDeque<_> = required
        .iter()
        .filter_map(|root| graph.importers.get(root))
        .flat_map(|importer| importer.dependencies.iter().map(|edge| edge.target.clone()))
        .collect();
    let mut seen = BTreeSet::new();
    while let Some(key) = queue.pop_front() {
        if !seen.insert(key.clone()) {
            continue;
        }
        if let Some(node) = graph.nodes.get(&key) {
            if let Some(source) = &node.link {
                required.insert(source.clone());
            }
            queue.extend(node.dependencies.iter().map(|edge| edge.target.clone()));
        }
    }
    let keep = |note: &String| {
        let Some(importer) = note
            .strip_prefix("unresolved pnpm importer ")
            .and_then(|note| note.split_once(": "))
            .map(|(importer, _)| importer)
        else {
            return true;
        };
        required.contains(importer)
            || worktree
                .join(installation_root)
                .join(importer)
                .join("node_modules")
                .exists()
    };
    let previous = graph.notes.len();
    graph.notes.retain(keep);
    if graph.notes.len() < previous && graph.notes.is_empty() {
        graph.complete = true;
    }
    if let Some(installation) = installation {
        let previous = installation.notes.len();
        installation.notes.retain(keep);
        if installation.notes.len() < previous && installation.notes.is_empty() {
            installation.complete = true;
        }
    }
}

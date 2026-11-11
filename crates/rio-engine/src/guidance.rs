use std::{collections::BTreeSet, path::Path};

use anyhow::Result;
use rio_core::{RiskLevel, RiskSource, RiskTier};
use rio_git::{Diff, Tree};
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct OwnerGuidance {
    path: String,
    scope_dir: String,
    content_hash: String,
    lines: Vec<String>,
}

/// Read the selected immutable head as data, never as engine instructions.
/// Only regular UTF-8 files count: the endpoint reproduces guidance from the
/// snapshot and refuses links (often CLAUDE.md -> AGENTS.md, read on its own).
pub fn owner_guidance(head: &Tree, diff: &Diff) -> Vec<OwnerGuidance> {
    let mut paths = BTreeSet::new();
    for file in &diff.files {
        let mut directory = Path::new(&file.path).parent();
        while let Some(scope) = directory {
            for name in ["REVIEW.md", "CLAUDE.md", "AGENTS.md"] {
                let path = scope.join(name).to_string_lossy().replace('\\', "/");
                if head.get(&path).is_some_and(|entry| {
                    matches!(entry.mode, 0o100644 | 0o100755)
                        && std::str::from_utf8(&entry.content).is_ok()
                }) {
                    paths.insert(path);
                }
            }
            directory = scope.parent();
        }
    }
    read_guidance(head, paths)
}

fn read_guidance(head: &Tree, paths: BTreeSet<String>) -> Vec<OwnerGuidance> {
    paths
        .into_iter()
        .map(|path| {
            let content = &head[&path].content;
            OwnerGuidance {
                scope_dir: Path::new(&path)
                    .parent()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                content_hash: blake3::hash(content).to_hex().to_string(),
                lines: String::from_utf8_lossy(content)
                    .lines()
                    .map(str::to_owned)
                    .collect(),
                path,
            }
        })
        .collect()
}

/// QA may discover a route after preparation, before a journey file exists.
/// Capture the guidance documents now; the QA consumer narrows this immutable
/// catalog to each journey/visited route before constructing either prompt.
/// This does not grant broader tools or execution permissions.
pub fn review_owner_guidance(head: &Tree, diff: &Diff, qa_enabled: bool) -> Vec<OwnerGuidance> {
    if !qa_enabled {
        return owner_guidance(head, diff);
    }
    let paths = head
        .iter()
        .filter(|(path, entry)| {
            [0o100644, 0o100755].contains(&entry.mode)
                && ["REVIEW.md", "AGENTS.md", "CLAUDE.md"]
                    .contains(&path.rsplit('/').next().unwrap_or(path))
        })
        .map(|(path, _)| path.clone())
        .collect();
    read_guidance(head, paths)
}

pub(crate) fn risk_tier(patterns: &[String], diff: &Diff) -> Result<Option<RiskTier>> {
    let mut reasons = Vec::new();
    for pattern in patterns {
        let matcher = globset::Glob::new(pattern)?.compile_matcher();
        if diff.files.iter().any(|file| {
            matcher.is_match(&file.path)
                || file
                    .old_path
                    .as_ref()
                    .is_some_and(|path| matcher.is_match(path))
        }) {
            reasons.push(format!("always_human: {pattern}"));
        }
    }
    reasons.sort();
    reasons.dedup();
    Ok((!reasons.is_empty()).then_some(RiskTier {
        tier: RiskLevel::High,
        reasons,
        source: RiskSource::AlwaysHuman,
    }))
}

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
pub fn owner_guidance(head: &Tree, diff: &Diff) -> Vec<OwnerGuidance> {
    let mut paths = BTreeSet::new();
    for file in &diff.files {
        let mut directory = Path::new(&file.path).parent();
        while let Some(scope) = directory {
            for name in ["REVIEW.md", "CLAUDE.md", "AGENTS.md"] {
                let path = scope.join(name).to_string_lossy().replace('\\', "/");
                if head.contains_key(&path) {
                    paths.insert(path);
                }
            }
            directory = scope.parent();
        }
    }
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

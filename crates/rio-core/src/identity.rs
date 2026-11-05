use std::{collections::BTreeMap, sync::LazyLock};

use regex::Regex;
use thiserror::Error;

use crate::{Finding, Location, OccurrenceState, Source, State};

static LINE_COLUMN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\(\d+,\s*\d+\)").unwrap());
static LINE_REFERENCE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\bline \d+\b").unwrap());
static COLUMN_REFERENCE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\bcolumn \d+\b").unwrap());
static TOOL_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b[A-Za-z]+_[0-9a-f]{6,}\b").unwrap());
static ABSOLUTE_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?:[A-Za-z]:/|/)(?:[^\s\"'():,<>/]+/)+"#).unwrap());

pub fn normalized_location(path: &str, symbol_path: &str, repository_root: &str) -> String {
    let path = path.replace('\\', "/");
    let root = repository_root.replace('\\', "/");
    let relative = path
        .strip_prefix(&format!("{}/", root.trim_end_matches('/')))
        .unwrap_or(&path);
    let mut components = Vec::new();
    for component in relative.split('/') {
        match component {
            "." | "" => {}
            ".." if components.last().is_some_and(|last| *last != "..") => {
                components.pop();
            }
            other => components.push(other),
        }
    }
    format!("{}::{symbol_path}", components.join("/"))
}

/// Normalize only volatile coordinates, root prefixes and tool-generated ids.
/// Numeric literals, type names and letter case are preserved.
pub fn normalized_message(message: &str, repository_root: &str) -> String {
    let mut message = message.replace('\\', "/");
    let root = repository_root.replace('\\', "/");
    if !root.is_empty() {
        message = message.replace(&format!("{}/", root.trim_end_matches('/')), "");
    }
    let message = ABSOLUTE_PREFIX.replace_all(&message, "");
    let message = LINE_COLUMN.replace_all(&message, "(line,column)");
    let message = LINE_REFERENCE.replace_all(&message, "line <n>");
    let message = COLUMN_REFERENCE.replace_all(&message, "column <n>");
    TOOL_ID.replace_all(&message, "<tool-id>").into_owned()
}

pub fn finding_id(
    rule_id: &str,
    path: &str,
    symbol_path: &str,
    message: &str,
    repository_root: &str,
) -> String {
    let location = normalized_location(path, symbol_path, repository_root);
    let trigger_hash = blake3::hash(normalized_message(message, repository_root).as_bytes());
    blake3::hash(format!("{rule_id}|{location}|{trigger_hash}").as_bytes())
        .to_hex()
        .to_string()
}

#[derive(Debug, Error)]
pub enum IdentityError {
    #[error(
        "finding identity {0} is shared by different sources; rule ids must identify their source"
    )]
    ConflictingSources(String),
}

#[derive(Default)]
struct Occurrences {
    base: Vec<Finding>,
    head: Vec<Finding>,
}

/// Classify raw (ungrouped) diagnostics, then group locations by root cause.
/// `map_line` maps a base path/line to its unchanged head line, or returns None.
/// A missing baseline always yields unclassified head results.
pub fn classify_and_group(
    base: Option<Vec<Finding>>,
    head: Vec<Finding>,
    map_line: impl Fn(&str, u32) -> Option<u32>,
) -> Result<Vec<Finding>, IdentityError> {
    classify_and_group_scoped(base, head, map_line, |_| true)
}

/// With no baseline, changed-line scope is an annotation only. Every head
/// occurrence remains unclassified, including diagnostics in unchanged files.
pub fn classify_and_group_scoped(
    base: Option<Vec<Finding>>,
    head: Vec<Finding>,
    map_line: impl Fn(&str, u32) -> Option<u32>,
    in_changed_scope: impl Fn(&Location) -> bool,
) -> Result<Vec<Finding>, IdentityError> {
    let baseline_obtained = base.is_some();
    let mut identities: BTreeMap<String, Occurrences> = BTreeMap::new();
    for finding in base.into_iter().flatten() {
        identities
            .entry(finding.id.clone())
            .or_default()
            .base
            .push(finding);
    }
    for finding in head {
        identities
            .entry(finding.id.clone())
            .or_default()
            .head
            .push(finding);
    }
    identities
        .into_iter()
        .map(|(id, mut occurrences)| {
            let source: &Source = &occurrences
                .head
                .first()
                .or(occurrences.base.first())
                .unwrap()
                .source;
            if occurrences
                .base
                .iter()
                .chain(&occurrences.head)
                .any(|f| &f.source != source)
            {
                return Err(IdentityError::ConflictingSources(id));
            }
            occurrences
                .base
                .sort_by_key(|f| (f.location.path.clone(), f.location.line_start));
            occurrences
                .head
                .sort_by_key(|f| (f.location.path.clone(), f.location.line_start));
            let mut used_base = vec![false; occurrences.base.len()];
            let mut used_head = vec![false; occurrences.head.len()];
            if baseline_obtained {
                // Preserve exact unchanged-line matches before pairing moved occurrences.
                for (base_index, base) in occurrences.base.iter().enumerate() {
                    if let Some(mapped) = map_line(&base.location.path, base.location.line_start)
                        && let Some(head_index) =
                            occurrences.head.iter().enumerate().position(|(i, head)| {
                                !used_head[i] && head.location.line_start == mapped
                            })
                    {
                        used_base[base_index] = true;
                        used_head[head_index] = true;
                    }
                }
                let remaining_base: Vec<_> = used_base
                    .iter()
                    .enumerate()
                    .filter_map(|(i, used)| (!used).then_some(i))
                    .collect();
                let remaining_head: Vec<_> = used_head
                    .iter()
                    .enumerate()
                    .filter_map(|(i, used)| (!used).then_some(i))
                    .collect();
                for (base_index, head_index) in remaining_base.into_iter().zip(remaining_head) {
                    used_base[base_index] = true;
                    used_head[head_index] = true;
                }
            }
            let mut grouped = occurrences
                .head
                .first()
                .or(occurrences.base.first())
                .unwrap()
                .clone();
            grouped.locations.clear();
            for (index, head) in occurrences.head.iter().enumerate() {
                let mut location = head.location.clone();
                location.occurrence_state = if !baseline_obtained {
                    if !in_changed_scope(&location) {
                        grouped.evidence.push(format!(
                            "unclassified: outside changed hunks, baseline unavailable ({}:{})",
                            location.path, location.line_start
                        ));
                    }
                    OccurrenceState::Unclassified
                } else if used_head[index] {
                    OccurrenceState::PreExisting
                } else {
                    OccurrenceState::New
                };
                grouped.locations.push(location);
            }
            for (index, base) in occurrences.base.iter().enumerate() {
                if !used_base[index] {
                    let mut location = base.location.clone();
                    location.occurrence_state = OccurrenceState::Fixed;
                    grouped.locations.push(location);
                }
            }
            let any_new = grouped
                .locations
                .iter()
                .any(|l| l.occurrence_state == OccurrenceState::New);
            let any_existing = grouped
                .locations
                .iter()
                .any(|l| l.occurrence_state == OccurrenceState::PreExisting);
            grouped.state = if grouped
                .locations
                .iter()
                .any(|l| l.occurrence_state == OccurrenceState::Unclassified)
            {
                State::Unclassified
            } else if any_new && any_existing {
                State::Worsened
            } else if any_new {
                State::New
            } else if any_existing {
                State::PreExisting
            } else {
                State::Fixed
            };
            grouped.location = grouped
                .locations
                .iter()
                .find(|l| {
                    matches!(
                        l.occurrence_state,
                        OccurrenceState::New | OccurrenceState::Unclassified
                    )
                })
                .or_else(|| {
                    grouped
                        .locations
                        .iter()
                        .find(|l| l.occurrence_state != OccurrenceState::Fixed)
                })
                .unwrap_or(&grouped.locations[0])
                .clone();
            Ok(grouped)
        })
        .collect()
}

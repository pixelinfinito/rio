//! Host-side QA identity, attribution and cell-aware regression classification.
//! Browser hints are data and only resolve to files in the immutable snapshot.
use std::collections::{BTreeMap, BTreeSet};

use rio_core::{
    Category, EvidenceLevel, Finding, Location, OccurrenceState, QaAttribution, QaCell, QaFinding,
    QaKind, Severity, Source, State,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::QaSnapshot;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum QaTrigger {
    Probe {
        predicate: String,
        role_signature: Value,
    },
    Observation {
        expected: Value,
        observed: Value,
        #[serde(default)]
        targets: Vec<Value>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QaCandidate {
    pub rule_id: String,
    pub journey: String,
    pub step: u32,
    pub route_pattern: String,
    pub cell: QaCell,
    pub kind: QaKind,
    pub severity: Severity,
    pub trigger: QaTrigger,
    pub message: String,
    pub suggested_fix: Option<String>,
    pub element_paths: Vec<String>,
    #[serde(default)]
    pub measurements: Map<String, Value>,
    pub evidence: Vec<String>,
    #[serde(default)]
    pub attribution: AttributionHints,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AttributionHints {
    /// React/Vue development metadata and Svelte/Vite inspector attributes.
    #[serde(default)]
    pub annotations: Vec<SourceHint>,
    #[serde(default)]
    pub stack: Vec<SourceHint>,
    #[serde(default)]
    pub text: Vec<String>,
    #[serde(default)]
    pub classes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceHint {
    pub path: String,
    pub line: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QaArtifactRef {
    pub id: String,
    pub journey: String,
    pub step: Option<u32>,
    pub cell: QaCell,
    pub kind: String,
    pub sanitized: bool,
}

pub fn qa_route_pattern(route: &str) -> String {
    let route = route.split_once("://").map_or(route, |(_, rest)| {
        rest.find('/').map_or("/", |index| &rest[index..])
    });
    let route = route.split(['?', '#']).next().unwrap_or("/");
    format!(
        "/{}",
        route
            .split('/')
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("/")
    )
}

pub fn qa_finding_id(candidate: &QaCandidate, snapshot: &QaSnapshot) -> String {
    // serde_json's map representation canonicalizes object keys. Measured
    // values, prose, source lines and the viewport never enter this identity.
    let trigger = match &candidate.trigger {
        QaTrigger::Probe {
            predicate,
            role_signature,
        } => serde_json::json!([predicate, role_signature]),
        QaTrigger::Observation { targets, .. } => {
            // Requirement text comes from the immutable snapshot, never model prose.
            let path = format!(".rio/qa/journeys/{}.yaml", candidate.journey);
            let journey: Value = snapshot
                .get(&path)
                .and_then(|bytes| serde_yaml::from_slice(bytes).ok())
                .unwrap_or(Value::Null);
            let step = &journey["steps"][candidate.step.saturating_sub(1) as usize];
            let mut targets = targets
                .iter()
                .map(|target| canonical(target.clone()).to_string())
                .collect::<Vec<_>>();
            targets.sort();
            targets.dedup();
            serde_json::json!(["observation-v2", {"do":step["do"], "expect":step["expect"]}, targets])
        }
    };
    fn canonical(value: Value) -> Value {
        match value {
            Value::Object(object) => {
                let sorted: BTreeMap<_, _> = object
                    .into_iter()
                    .map(|(key, value)| (key, canonical(value)))
                    .collect();
                Value::Object(sorted.into_iter().collect())
            }
            Value::Array(values) => Value::Array(values.into_iter().map(canonical).collect()),
            value => value,
        }
    }
    let trigger_hash = blake3::hash(canonical(trigger).to_string().as_bytes());
    blake3::hash(
        format!(
            "{}|qa|{}|{}|{}|{}",
            candidate.rule_id,
            candidate.journey,
            candidate.step,
            qa_route_pattern(&candidate.route_pattern),
            trigger_hash
        )
        .as_bytes(),
    )
    .to_hex()
    .to_string()
}

fn location(path: String, line: u32) -> Location {
    Location {
        path,
        line_start: line,
        line_end: line,
        column: None,
        symbol_path: String::new(),
        occurrence_state: OccurrenceState::Unclassified,
        id: None,
        cell: None,
        evidence: None,
    }
}

fn valid_hint(snapshot: &QaSnapshot, hint: &SourceHint) -> Option<Location> {
    let raw = hint.path.replace('\\', "/");
    let raw = raw
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .trim_start_matches("./");
    if raw.split('/').any(|part| part == "..") || hint.line == 0 {
        return None;
    }
    let candidates: Vec<_> = snapshot
        .keys()
        .filter(|path| raw == path.as_str() || raw.ends_with(&format!("/{path}")))
        .collect();
    if candidates.len() != 1 {
        return None;
    }
    let path = candidates[0].clone();
    let bytes = snapshot.get(&path)?;
    let lines = std::str::from_utf8(bytes).ok()?.lines().count().max(1);
    (hint.line as usize <= lines).then(|| location(path, hint.line))
}

fn unique_file(snapshot: &QaSnapshot, hints: &[SourceHint]) -> Option<Location> {
    let mut locations = BTreeMap::new();
    for hint in hints {
        if let Some(found) = valid_hint(snapshot, hint) {
            locations.entry(found.path.clone()).or_insert(found);
        }
    }
    (locations.len() == 1).then(|| locations.into_values().next().unwrap())
}

fn step_line(snapshot: &QaSnapshot, journey: &str, step: u32) -> u32 {
    let path = format!(".rio/qa/journeys/{journey}.yaml");
    let Some(bytes) = snapshot.get(&path) else {
        return 1;
    };
    let Ok(text) = std::str::from_utf8(bytes) else {
        return 1;
    };
    let mut index = 0;
    for (line, text) in text.lines().enumerate() {
        let trimmed = text.trim_start().trim_start_matches('-').trim_start();
        let matches = if trimmed.starts_with("do:") {
            1
        } else {
            text.matches("\"do\":").count()
        };
        index += matches;
        if index >= step as usize {
            return line as u32 + 1;
        }
    }
    1
}

pub fn attribute_qa(
    candidate: &QaCandidate,
    snapshot: &QaSnapshot,
    changed: &BTreeSet<String>,
) -> (Location, QaAttribution) {
    for hints in [
        &candidate.attribution.annotations,
        &candidate.attribution.stack,
    ] {
        if let Some(found) = unique_file(snapshot, hints) {
            return (found, QaAttribution::Source);
        }
    }
    let mut matches = BTreeMap::new();
    for path in changed {
        let Some(text) = snapshot
            .get(path)
            .and_then(|bytes| std::str::from_utf8(bytes).ok())
        else {
            continue;
        };
        for (line, text) in text.lines().enumerate() {
            if candidate
                .attribution
                .text
                .iter()
                .chain(&candidate.attribution.classes)
                .any(|needle| !needle.trim().is_empty() && text.contains(needle))
            {
                matches
                    .entry(path.clone())
                    .or_insert_with(|| location(path.clone(), line as u32 + 1));
            }
        }
    }
    if matches.len() == 1 {
        return (matches.into_values().next().unwrap(), QaAttribution::Source);
    }
    (
        location(
            format!(".rio/qa/journeys/{}.yaml", candidate.journey),
            step_line(snapshot, &candidate.journey, candidate.step),
        ),
        QaAttribution::Journey,
    )
}

/// Return a counted drop reason to the run assembler instead of manufacturing
/// an evidence level from agent prose or a non-existent artifact identifier.
pub fn construct_qa_finding(
    candidate: &QaCandidate,
    artifacts: &BTreeMap<String, QaArtifactRef>,
    snapshot: &QaSnapshot,
    changed: &BTreeSet<String>,
) -> Result<Finding, &'static str> {
    if candidate.step == 0
        || candidate.journey.is_empty()
        || !candidate
            .journey
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        || !["light", "dark"].contains(&candidate.cell.color_scheme.as_str())
        || candidate.cell.viewport.is_empty()
    {
        return Err("invalid_candidate");
    }
    let mut kinds = BTreeSet::new();
    let observation = matches!(candidate.trigger, QaTrigger::Observation { .. });
    let mut current_step_evidence = false;
    if candidate.evidence.is_empty() {
        return Err("missing_or_invalid_evidence");
    }
    for id in &candidate.evidence {
        let Some(artifact) = artifacts.get(id) else {
            return Err("missing_or_invalid_evidence");
        };
        if !artifact.sanitized
            || artifact.journey != candidate.journey
            || artifact.cell != candidate.cell
            || artifact.step.is_some_and(|step| {
                step != candidate.step && !(observation && step == candidate.step - 1)
            })
            || ![
                "screenshot",
                "dom",
                "accessibility",
                "network",
                "console",
                "trace",
                "capture",
                "probe",
            ]
            .contains(&artifact.kind.as_str())
        {
            return Err("missing_or_invalid_evidence");
        }
        kinds.insert(artifact.kind.as_str());
        current_step_evidence |= artifact.step == Some(candidate.step);
    }
    // Before/after evidence is valid for observations, but a preceding capture
    // or a cell-wide trace alone cannot establish the claimed step's behavior.
    if observation && !current_step_evidence {
        return Err("missing_or_invalid_evidence");
    }
    let (evidence_level, source, trigger) = match &candidate.trigger {
        QaTrigger::Probe {
            predicate,
            role_signature,
        } => {
            if predicate != &candidate.rule_id
                || !role_signature.is_object()
                || !kinds.contains("screenshot")
                || !kinds.contains("dom")
            {
                return Err("invalid_probe_evidence");
            }
            (
                EvidenceLevel::StaticProven,
                Source::Tool {
                    tool: "rio/qa".into(),
                    version: "0.1.0".into(),
                },
                format!("{predicate}: {role_signature}"),
            )
        }
        QaTrigger::Observation {
            expected,
            observed,
            targets,
        } => {
            let path = format!(".rio/qa/journeys/{}.yaml", candidate.journey);
            let journey: Value = snapshot
                .get(&path)
                .and_then(|bytes| serde_yaml::from_slice(bytes).ok())
                .unwrap_or(Value::Null);
            if !journey["steps"][candidate.step as usize - 1].is_object() {
                return Err("missing_observation_requirement");
            }
            if targets.is_empty()
                || targets.iter().any(|target| {
                    !target.is_object()
                        || ["tag", "role", "name"]
                            .iter()
                            .any(|key| !target[key].is_string())
                })
            {
                return Err("missing_observation_target");
            }
            if !expected.is_object() || !observed.is_object() {
                return Err("invalid_observation");
            }
            (
                EvidenceLevel::Plausible,
                Source::Agent {
                    agent: "qa".into(),
                    cached: None,
                },
                format!("Expected {expected}; observed {observed}"),
            )
        }
    };
    let (location, attribution) = attribute_qa(candidate, snapshot, changed);
    let mut occurrence = location.clone();
    occurrence.cell = Some(candidate.cell.clone());
    occurrence.evidence = Some(candidate.evidence.clone());
    // Preserve nested measurements losslessly as JSON strings within the
    // finding-v1 scalar measurement map; the probe artifact retains full shape.
    let measurements = candidate
        .measurements
        .iter()
        .map(|(key, value)| {
            (
                key.clone(),
                match value {
                    Value::Number(_) | Value::String(_) | Value::Bool(_) => value.clone(),
                    Value::Array(items) if items.iter().all(Value::is_string) => value.clone(),
                    _ => Value::String(value.to_string()),
                },
            )
        })
        .collect();
    Ok(Finding {
        id: qa_finding_id(candidate, snapshot),
        rule_id: candidate.rule_id.clone(),
        category: Category::Ux,
        evidence_level,
        severity: candidate.severity,
        state: State::Unclassified,
        location,
        message: candidate.message.clone(),
        trigger,
        impact: None,
        suggested_fix: candidate.suggested_fix.clone(),
        evidence: candidate.evidence.clone(),
        source,
        locations: vec![occurrence],
        advisory: None,
        verification: None,
        round: None,
        first_posted_in: None,
        status: None,
        resolution: None,
        author_response: None,
        history: None,
        council: None,
        qa: Some(QaFinding {
            journey: candidate.journey.clone(),
            step: candidate.step,
            kind: candidate.kind,
            route: qa_route_pattern(&candidate.route_pattern),
            element_paths: candidate.element_paths.clone(),
            attribution,
            measurements,
        }),
    })
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct QaAssessmentKey {
    pub rule_id: String,
    pub journey: String,
    pub step: u32,
    pub cell: QaCell,
}
fn key(finding: &Finding, cell: &QaCell) -> QaAssessmentKey {
    let qa = finding.qa.as_ref().expect("QA finding");
    QaAssessmentKey {
        rule_id: finding.rule_id.clone(),
        journey: qa.journey.clone(),
        step: qa.step,
        cell: cell.clone(),
    }
}

/// Only completed assessments permit absence to mean new/fixed. Incomplete
/// baseline cells remain unclassified, including an otherwise successful run.
pub fn classify_qa_findings(
    base: Option<Vec<Finding>>,
    head: Vec<Finding>,
    base_assessed: &BTreeSet<QaAssessmentKey>,
    head_assessed: &BTreeSet<QaAssessmentKey>,
    changed: &BTreeSet<String>,
) -> Result<Vec<Finding>, &'static str> {
    let baseline = base.is_some();
    let mut groups: BTreeMap<String, (Vec<Finding>, Vec<Finding>)> = BTreeMap::new();
    for (side, findings) in [(false, base.unwrap_or_default()), (true, head)] {
        for finding in findings {
            if finding.category != Category::Ux
                || finding.qa.is_none()
                || finding.locations.is_empty()
                || finding.locations.iter().any(|location| {
                    location.cell.is_none() || location.evidence.as_ref().is_none_or(Vec::is_empty)
                })
            {
                return Err("invalid_qa_finding");
            }
            let group = groups.entry(finding.id.clone()).or_default();
            if side {
                group.1.push(finding);
            } else {
                group.0.push(finding);
            }
        }
    }
    let mut output = Vec::new();
    for (_, (base, head)) in groups {
        let mut finding = head.first().or(base.first()).unwrap().clone();
        let attribution_for = |location: &Location| {
            head.iter()
                .chain(&base)
                .find(|row| {
                    row.locations
                        .iter()
                        .any(|other| other.cell == location.cell && other.path == location.path)
                })
                .and_then(|row| row.qa.as_ref())
                .map_or(QaAttribution::Journey, |qa| qa.attribution)
        };
        let mut base_cells = BTreeMap::new();
        let mut head_cells = BTreeMap::new();
        for (rows, cells) in [(&base, &mut base_cells), (&head, &mut head_cells)] {
            for row in rows {
                for occurrence in &row.locations {
                    let cell = occurrence.cell.as_ref().unwrap().clone();
                    let existing = cells.entry(cell).or_insert_with(|| occurrence.clone());
                    let evidence = existing.evidence.as_mut().unwrap();
                    evidence.extend(occurrence.evidence.as_ref().unwrap().iter().cloned());
                    evidence.sort();
                    evidence.dedup();
                }
            }
        }
        finding.locations.clear();
        for (cell, mut occurrence) in head_cells.clone() {
            occurrence.occurrence_state = if !baseline {
                if attribution_for(&occurrence) == QaAttribution::Source
                    && changed.contains(&occurrence.path)
                {
                    OccurrenceState::New
                } else {
                    OccurrenceState::Unclassified
                }
            } else if base_cells.contains_key(&cell) {
                OccurrenceState::PreExisting
            } else if base_assessed.contains(&key(&finding, &cell)) {
                OccurrenceState::New
            } else {
                OccurrenceState::Unclassified
            };
            finding.locations.push(occurrence);
        }
        for (cell, mut occurrence) in base_cells {
            if head_cells.contains_key(&cell) {
                continue;
            }
            occurrence.occurrence_state = if head_assessed.contains(&key(&finding, &cell)) {
                OccurrenceState::Fixed
            } else {
                OccurrenceState::Unclassified
            };
            finding.locations.push(occurrence);
        }
        let states: Vec<_> = finding
            .locations
            .iter()
            .map(|location| location.occurrence_state)
            .collect();
        finding.state = if states.contains(&OccurrenceState::Unclassified) {
            State::Unclassified
        } else if states.contains(&OccurrenceState::New)
            && states.contains(&OccurrenceState::PreExisting)
        {
            State::Worsened
        } else if states.contains(&OccurrenceState::New) {
            State::New
        } else if states.contains(&OccurrenceState::PreExisting) {
            State::PreExisting
        } else {
            State::Fixed
        };
        finding.evidence = finding
            .locations
            .iter()
            .flat_map(|location| location.evidence.clone().unwrap_or_default())
            .collect();
        finding.evidence.sort();
        finding.evidence.dedup();
        finding.location = finding
            .locations
            .iter()
            .find(|location| {
                matches!(
                    location.occurrence_state,
                    OccurrenceState::New | OccurrenceState::Unclassified
                )
            })
            .unwrap_or(&finding.locations[0])
            .clone();
        finding.qa.as_mut().unwrap().attribution = attribution_for(&finding.location);
        finding.location.cell = None;
        finding.location.evidence = None;
        finding.location.id = None;
        let paths: BTreeSet<_> = base
            .iter()
            .chain(&head)
            .flat_map(|row| row.qa.as_ref().unwrap().element_paths.clone())
            .collect();
        finding.qa.as_mut().unwrap().element_paths = paths.into_iter().collect();
        output.push(finding);
    }
    Ok(output)
}

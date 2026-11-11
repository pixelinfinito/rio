//! Shared host-side composition for local and runner execution.
use crate::*;
use anyhow::{Context, Result};
use serde_json::{Value, json};

pub fn empty_runtime_result(plan: &QaPlan, harness: &str) -> Value {
    json!({"outcome":"complete","harness":harness,"harness_auth":"not_used","plan":plan,
        "journey_outcomes":[],"findings":[],"hypotheses":[],"qa_recommendations":[],
        "ux_assessment":[],"guidance":[],"probe_assessments":[],
        "seed":{"status":"not_run","duration_ms":0},"tokens":0,"wall_time_ms":0,
        "evidence":{"version":1,"hash_algorithm":"blake3","bytes":0,"artifacts":[],"notes":[]}})
}
use std::collections::{BTreeMap, BTreeSet};

pub fn runtime_project(snapshot: &QaSnapshot, options: &Value) -> Result<QaProject> {
    let mut project = QaProject::load(snapshot)?;
    if let Some(names) = options["viewports"].as_array() {
        project.config.browser.viewports = names
            .iter()
            .map(|name| {
                let name = name.as_str().context("invalid viewport override")?;
                Ok(project
                    .viewports
                    .get(name)
                    .cloned()
                    .map(ViewportDefinition::Custom)
                    .unwrap_or_else(|| ViewportDefinition::Preset(name.into())))
            })
            .collect::<Result<_>>()?;
    }
    for (key, destination) in [
        ("disable", &mut project.config.rules.disable),
        ("adopt", &mut project.config.rules.adopt),
        ("ignore_console", &mut project.config.rules.ignore_console),
    ] {
        destination.extend(
            options["rules"][key]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned),
        );
    }
    project.config.rules.add.extend(
        options["rules"]["add"]
            .as_array()
            .into_iter()
            .flatten()
            .cloned(),
    );
    let mut effective = snapshot.clone();
    let mut config = serde_json::to_value(&project.config)?;
    omit_nulls(&mut config);
    effective.insert(".rio/qa.yaml".into(), serde_json::to_vec(&config)?);
    // Profile overrides must obey the same dependency matrix validation.
    Ok(QaProject::load(&effective)?)
}

/// Narrow `plan` to the QA step's `cell` option, when it names one (a rerun
/// of one cell of the matrix).
pub fn restrict_to_cell(
    plan: &mut QaPlan,
    project: &QaProject,
    options: &Value,
    cell_wall_seconds: u64,
) -> Result<()> {
    if options["cell"].is_null() {
        return Ok(());
    }
    let cell: crate::Cell =
        serde_json::from_value(options["cell"].clone()).context("invalid QA cell option")?;
    Ok(plan.only_cell(project, &cell, cell_wall_seconds)?)
}

pub fn annotate_runtime_result(
    result: &mut Value,
    project: &QaProject,
    snapshot: &QaSnapshot,
    plan: &QaPlan,
    changed: &BTreeSet<String>,
) -> Result<()> {
    // Exploration is host-authored rather than committed; bind its identity to
    // the exact planned requirement using the same snapshot-based constructor.
    let mut identity_snapshot = snapshot.clone();
    if let Some(journey) = project.journeys.get("exploratory") {
        identity_snapshot
            .entry(".rio/qa/journeys/exploratory.yaml".into())
            .or_insert(serde_json::to_vec(journey)?);
    }
    let artifacts = result["evidence"]["artifacts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|value| serde_json::from_value::<QaArtifactRef>(value.clone()).ok())
        .map(|artifact| (artifact.id.clone(), artifact))
        .collect();
    let mut findings = Vec::new();
    let mut observations = Vec::new();
    let mut dropped = BTreeMap::<String, u64>::new();
    for value in result["qa_findings"].as_array().into_iter().flatten() {
        let candidate = match serde_json::from_value::<QaCandidate>(value.clone()) {
            Ok(candidate) => candidate,
            Err(_) => {
                *dropped.entry("invalid_candidate".into()).or_default() += 1;
                continue;
            }
        };
        let finding =
            match construct_qa_finding(&candidate, &artifacts, &identity_snapshot, changed) {
                Ok(finding) => finding,
                Err(reason) => {
                    *dropped.entry(reason.into()).or_default() += 1;
                    continue;
                }
            };
        match &candidate.trigger {
            QaTrigger::Probe { .. } => findings.push(finding),
            QaTrigger::Observation {
                expected, observed, ..
            } => {
                // Keep attribution/identity under host authority, without
                // promoting observations before independent verification.
                let finding = classify_qa_findings(
                    None,
                    vec![finding],
                    &BTreeSet::new(),
                    &BTreeSet::new(),
                    changed,
                )
                .map_err(anyhow::Error::msg)?
                .pop()
                .context("missing QA observation")?;
                observations.push(json!({"finding":finding,"expected":expected,
                    "observed":observed,"cell":candidate.cell}));
            }
        }
    }
    result["findings"] = serde_json::to_value(
        classify_qa_findings(None, findings, &BTreeSet::new(), &BTreeSet::new(), changed)
            .map_err(anyhow::Error::msg)?,
    )?;
    result["observation_candidates"] = json!(observations);
    result["candidate_drops"] = json!(dropped);
    let mut guidance = BTreeMap::new();
    for name in plan.selected.keys() {
        for document in journey_guidance(snapshot, &project.config, &project.journeys[name]) {
            if !document.lines.is_empty() {
                guidance.insert(
                    document.path.clone(),
                    json!({"path":document.path,"hash":document.content_hash,
                    "start_line":1,"end_line":document.lines.len()}),
                );
            }
        }
    }
    result["guidance"] = json!(guidance.into_values().collect::<Vec<_>>());
    result["plan"] = serde_json::to_value(plan)?;
    result["audit_notes"] = json!(runtime_audit_notes(result, project, plan));
    let outcomes = result["journey_outcomes"]
        .as_array_mut()
        .context("invalid QA outcomes")?;
    for name in plan.held_back.keys() {
        if outcomes.iter().any(|row| row["journey"] == *name) {
            continue;
        }
        for cell in &plan.cells {
            if project.journeys[name]
                .viewports
                .as_ref()
                .is_none_or(|viewports| viewports.contains(&cell.viewport))
            {
                outcomes.push(json!({"journey":name,"cell":cell,"outcome":"skipped","reason":"held_back","evidence":[],"steps":[]}));
            }
        }
    }
    Ok(())
}

pub fn selection_notes(plan: &QaPlan) -> Vec<String> {
    let mut notes = vec![format!(
        "QA planned {} cells; estimated wall time: {} seconds.",
        plan.cell_count, plan.estimated_wall_seconds
    )];
    for (journey, reasons) in &plan.selected {
        notes.push(format!("QA selected {journey}: {}.", reasons.join(", ")));
    }
    for (journey, reasons) in &plan.stale_journeys {
        notes.push(format!("QA journeys possibly stale: {journey} ({}). Run rio qa sync to reconcile expectations.", reasons.join(", ")));
    }
    if plan.no_coverage_match {
        notes.push("No committed journey covers the change; smoke journeys and changed-route exploration remain eligible.".into());
    }
    if !plan.held_back.is_empty() {
        notes.push(format!(
            "QA held back {} journeys at the chain selection cap: {}.",
            plan.held_back.len(),
            plan.held_back
                .keys()
                .cloned()
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if plan
        .selected
        .values()
        .any(|reasons| reasons.iter().any(|reason| reason == "explicit"))
    {
        notes.push("QA journey selection was explicit (including required dependencies).".into());
    }
    notes
}

/// Compose audit facts from the captured contract and trusted controller output.
/// Both local and hosted reports retain these independently of finding caps.
pub fn runtime_audit_notes(result: &Value, project: &QaProject, plan: &QaPlan) -> Vec<String> {
    let mut notes = selection_notes(plan);
    let list = |values: &[String]| {
        if values.is_empty() {
            "none".into()
        } else {
            values.join(", ")
        }
    };
    let rules = &project.config.rules;
    let added: Vec<_> = rules
        .add
        .iter()
        .filter_map(|rule| rule["id"].as_str().map(str::to_owned))
        .collect();
    notes.push(format!(
        "QA rules disabled: {}; adopted: {}; added: {}.",
        list(&rules.disable),
        list(&rules.adopt),
        list(&added)
    ));
    let mut dropped = BTreeMap::<String, u64>::new();
    for (reason, count) in result["candidate_drops"].as_object().into_iter().flatten() {
        *dropped.entry(reason.clone()).or_default() += count.as_u64().unwrap_or(0);
    }
    for row in result["journey_outcomes"].as_array().into_iter().flatten() {
        if let Some(counts) = row["dropped"].as_object() {
            for (reason, count) in counts {
                *dropped.entry(reason.clone()).or_default() += count.as_u64().unwrap_or(0);
            }
        } else {
            for drop in row["dropped"].as_array().into_iter().flatten() {
                if let Some(reason) = drop["reason"].as_str() {
                    *dropped.entry(reason.into()).or_default() += 1;
                }
            }
        }
    }
    notes.push(format!(
        "QA dropped observations/candidates: {}.",
        if dropped.is_empty() {
            "none".into()
        } else {
            dropped
                .iter()
                .map(|(reason, count)| format!("{reason}: {count}"))
                .collect::<Vec<_>>()
                .join(", ")
        }
    ));
    for note in result["evidence"]["notes"].as_array().into_iter().flatten() {
        if note["reason"] == "unresolved_expectation" {
            let references = note["guidance_refs"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|reference| {
                    format!(
                        "{}:{}–{} (hash {})",
                        reference["path"].as_str().unwrap_or(""),
                        reference["start_line"],
                        reference["end_line"],
                        reference["hash"].as_str().unwrap_or("")
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            notes.push(format!("Unresolved QA expectation: {} step {} ({}/{}), committed expectation: {}. Guidance: {}. Conflict: {}. Observed: {}. Evidence: {}. Reconcile requirements with rio qa sync; this conflict alone is not a product defect.",
                note["journey_path"].as_str().unwrap_or(""), note["step"],
                note["cell"]["viewport"].as_str().unwrap_or(""), note["cell"]["color_scheme"].as_str().unwrap_or(""),
                note["committed_step"]["expect"].as_str().unwrap_or("not specified"), references,
                note["conflict"].as_str().unwrap_or(""), note["observed"].as_str().unwrap_or(""), note["evidence"]));
            continue;
        }
        if let Some(reason) = note["reason"].as_str() {
            notes.push(format!(
                "QA evidence {reason}: {} ({}/{}).",
                note["journey"].as_str().unwrap_or("run"),
                note["cell"]["viewport"].as_str().unwrap_or("all"),
                note["cell"]["color_scheme"].as_str().unwrap_or("all")
            ));
        }
    }
    let dependencies: BTreeSet<_> = result["network_events"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|event| {
            matches!(
                event["kind"].as_str(),
                Some("blocked_egress" | "tls_pinned")
            )
        })
        .map(|event| {
            format!(
                "{} ({}, {})",
                event["host"].as_str().unwrap_or("unidentified destination"),
                event["kind"].as_str().unwrap(),
                event["source"].as_str().unwrap_or("app")
            )
        })
        .collect();
    notes.push(format!(
        "QA undoubled or blocked dependencies: {}{}.",
        if dependencies.is_empty() {
            "none observed".into()
        } else {
            dependencies.into_iter().collect::<Vec<_>>().join(", ")
        },
        if result["network_events_unavailable"] == true {
            "; app diagnostics unavailable"
        } else {
            ""
        }
    ));
    notes
}

pub fn runtime_records(result: &Value) -> BTreeMap<&'static str, Value> {
    let mut records: BTreeMap<_, _> = [
        ("plan.json", "plan"),
        ("outcomes.json", "journey_outcomes"),
        ("manifest.json", "evidence"),
        ("recommendations.json", "qa_recommendations"),
        ("assessment.json", "ux_assessment"),
        ("observations.json", "hypotheses"),
        ("observation-candidates.json", "observation_candidates"),
        ("audit.json", "audit_notes"),
    ]
    .into_iter()
    .map(|(file, key)| (file, result[key].clone()))
    .collect();
    if let Some(baseline) = result.get("baseline") {
        records.insert("baseline.json", baseline.clone());
    }
    records
}

/// Absence is meaningful only where the trusted probes recorded a completed
/// assessment. Journey success alone cannot prove a probe ran successfully.
pub fn compare_runtime_results(
    head: &mut Value,
    base: &Value,
    changed: &BTreeSet<String>,
) -> Result<()> {
    let assessed = |result: &Value| -> BTreeSet<QaAssessmentKey> {
        result["probe_assessments"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|row| {
                Some(QaAssessmentKey {
                    rule_id: row["rule_id"].as_str()?.into(),
                    journey: row["journey"].as_str()?.into(),
                    step: u32::try_from(row["step"].as_u64()?).ok()?,
                    cell: serde_json::from_value(row["cell"].clone()).ok()?,
                })
            })
            .collect()
    };
    let findings = |result: &Value| -> Result<Vec<rio_core::Finding>> {
        Ok(serde_json::from_value(
            result.get("findings").cloned().unwrap_or(json!([])),
        )?)
    };
    head["findings"] = serde_json::to_value(
        classify_qa_findings(
            Some(findings(base)?),
            findings(head)?,
            &assessed(base),
            &assessed(head),
            changed,
        )
        .map_err(anyhow::Error::msg)?,
    )?;
    head["baseline"] = base.clone();
    if head.get("head_evidence").is_none() {
        head["head_evidence"] = head["evidence"].clone();
    }
    let mut notes = head["audit_notes"].as_array().cloned().unwrap_or_default();
    notes.extend(
        base["audit_notes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|note| note.as_str().map(|note| json!(format!("Baseline: {note}")))),
    );
    head["audit_notes"] = json!(notes);
    head["evidence"]["quota_reached"] = json!(
        head["evidence"]["quota_reached"] == true || base["evidence"]["quota_reached"] == true
    );
    // Fixed/pre-existing occurrences may cite base artifacts. Retain both
    // manifests. Identical content can share an artifact id across snapshots;
    // the nested baseline manifest retains its own storage receipt.
    let mut artifacts = head["evidence"]["artifacts"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    artifacts.extend(
        base["evidence"]["artifacts"]
            .as_array()
            .into_iter()
            .flatten()
            .cloned(),
    );
    head["evidence"]["artifacts"] = json!(artifacts);
    head["evidence"]["bytes"] = json!(
        head["evidence"]["bytes"]
            .as_u64()
            .unwrap_or(0)
            .saturating_add(base["evidence"]["bytes"].as_u64().unwrap_or(0))
    );
    // A failed or unmetered baseline must not turn the head's known usage into
    // a purported total for both runs. Match the hosted report's unknown cost.
    head["tokens"] = match (head["tokens"].as_u64(), base["tokens"].as_u64()) {
        (Some(head_tokens), Some(base_tokens)) => json!(head_tokens.saturating_add(base_tokens)),
        _ if head["tokens"] == "unmetered" => json!("unmetered"),
        _ => Value::Null,
    };
    if base["outcome"] != "complete" {
        head["outcome"] = json!("partial");
    }
    Ok(())
}

/// Local candidates have no endpoint quorum. Never trust model-supplied
/// verification or lifecycle decisions, even when a journey itself passed.
pub fn local_qa_report(result: &Value, options: &Value) -> Result<Value> {
    let outcomes = result["journey_outcomes"]
        .as_array()
        .context("invalid QA outcomes")?;
    let states = ["failed", "cancelled", "not_run", "skipped", "passed"];
    let mut groups: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for outcome in outcomes {
        let name = outcome["journey"].as_str().context("invalid QA journey")?;
        let mut cell = outcome["cell"].clone();
        cell["outcome"] = outcome["outcome"].clone();
        if let Some(reason) = outcome.get("reason") {
            cell["reason"] = reason.clone();
        }
        cell["step_reached"] = json!(outcome["failed_step"].as_u64().unwrap_or_else(|| {
            outcome["steps"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|step| step["step"].as_u64())
                .chain(
                    result["evidence"]["artifacts"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|artifact| {
                            artifact["sanitized"] == true
                                && artifact["journey"] == outcome["journey"]
                                && artifact["cell"] == outcome["cell"]
                                && outcome["evidence"]
                                    .as_array()
                                    .is_some_and(|ids| ids.contains(&artifact["id"]))
                        })
                        .filter_map(|artifact| artifact["step"].as_u64()),
                )
                .max()
                .unwrap_or(0)
        }));
        cell["evidence"] = outcome.get("evidence").cloned().unwrap_or(json!([]));
        groups.entry(name.into()).or_default().push(cell);
    }
    let mut recommendations: BTreeMap<String, Value> = BTreeMap::new();
    for raw in result["qa_recommendations"]
        .as_array()
        .into_iter()
        .flatten()
    {
        let mut candidate = raw.clone();
        candidate["verification_status"] = json!("unverified");
        candidate["rationale"] =
            json!("Verification deferred: no endpoint. Expected benefit has not been tested.");
        let map = candidate
            .as_object_mut()
            .context("invalid recommendation")?;
        map.remove("dismissal");
        map.remove("related_finding_id");
        let id = candidate["id"]
            .as_str()
            .context("recommendation identity missing")?
            .to_owned();
        if let Some(previous) = recommendations.get_mut(&id) {
            for field in ["steps", "cells", "evidence"] {
                for value in candidate[field].as_array().into_iter().flatten() {
                    let rows = previous[field]
                        .as_array_mut()
                        .context("invalid recommendation records")?;
                    if !rows.contains(value) {
                        rows.push(value.clone());
                    }
                }
            }
        } else {
            recommendations.insert(id, candidate);
        }
    }
    let rank = |value: &Value| match value.as_str() {
        Some("high") => 0,
        Some("medium") => 1,
        _ => 2,
    };
    let mut recommendations: Vec<_> = recommendations.into_values().collect();
    recommendations.sort_by_key(|row| {
        (
            rank(&row["priority"]),
            rank(&row["confidence"]),
            row["id"].as_str().unwrap_or("").to_owned(),
        )
    });
    let max = options["max_recommendations"].as_u64().unwrap_or(5) as usize;
    let held = recommendations.len().saturating_sub(max);
    recommendations.truncate(max);
    let observations: Vec<_> = result["hypotheses"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|row| {
            let map = [
                "rule_id",
                "kind",
                "journey",
                "step",
                "cell",
                "route",
                "expected",
                "observed",
                "evidence",
                "suggested_fix",
            ]
            .into_iter()
            .filter_map(|key| row.get(key).map(|value| (key.into(), value.clone())))
            .collect();
            Value::Object(map)
        })
        .collect();
    let recommendation_drop =
        |reason: &str| reason.contains("recommendation") || reason.contains("advice");
    let dropped: u64 = outcomes
        .iter()
        .map(|row| {
            if let Some(counts) = row["dropped"].as_object() {
                counts
                    .iter()
                    .filter(|(reason, _)| recommendation_drop(reason))
                    .map(|(_, count)| count.as_u64().unwrap_or(0))
                    .sum::<u64>()
            } else {
                row["dropped"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|row| row["reason"].as_str().is_some_and(recommendation_drop))
                    .count() as u64
            }
        })
        .sum();
    Ok(
        json!({"mode":options["mode"].as_str().unwrap_or("changed"),"harness":result["harness"],"isolation":"pod",
        "audit":{"notes":result.get("audit_notes").cloned().unwrap_or(json!([])),
          "harness_auth":result["harness_auth"].as_str().unwrap_or("unknown"),
          "egress":result["policy"]["egress"].as_str().unwrap_or("not_run"),
          "quota_bytes":result["evidence"]["quota_bytes"].as_u64(),
          "quota_reached":result["evidence"]["quota_reached"].as_bool().unwrap_or(false)},
        "selection":result["plan"]["selected"].as_object().into_iter().flatten().map(|(journey,reasons)| json!({"journey":journey,"reasons":reasons})).collect::<Vec<_>>(),
        "journeys":groups.into_iter().map(|(name,cells)| json!({"name":name,"outcome":states.iter().find(|state| cells.iter().any(|cell| cell["outcome"] == **state)),"cells":cells})).collect::<Vec<_>>(),
        "observations_unverified":observations,"recommendations":recommendations,
        "assessment":result.get("ux_assessment").cloned().unwrap_or(json!([])),
        "guidance":result.get("guidance").cloned().unwrap_or(json!([])),"rubric_version":"rio/ui-v1@0.1.0",
        "recommendations_held_back":held,"recommendations_dropped":dropped,
        "seed":result.get("seed").cloned().unwrap_or(json!({"status":"not_run","duration_ms":0})),
        "evidence":{"storage":"local","expires_at":null,"bytes":result["evidence"]["bytes"].as_u64().unwrap_or(0),
          "artifacts":result["evidence"]["artifacts"].as_array().into_iter().flatten().map(|artifact| {
              let mut link = json!({"id":artifact["id"],"kind":artifact["kind"]});
              if let Some(path) = artifact["link"].as_str() { link["link"] = json!(path); }
              link
          }).collect::<Vec<_>>()},
        "cost":{"wall_time_ms":result["wall_time_ms"].as_u64().unwrap_or(0),"tokens":result["tokens"].as_u64(),"usd":null}}),
    )
}

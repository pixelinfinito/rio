//! QA has its own presentation cap and fail policy. Recommendation records are
//! deliberately outside the finding pool, even after positive verification.
use crate::{Category, EvidenceLevel, FailOn, Report, Severity};
use serde_json::{Value, json};
use std::collections::BTreeSet;

pub fn apply_qa_policy(
    report: &mut Report,
    options: &Value,
    runtime_incomplete: bool,
) -> Result<(), String> {
    if report.qa.is_none() && !runtime_incomplete {
        return Ok(());
    }
    let mut policy = json!({"evidence":"plausible","categories":["ux"],"states":["new","worsened"],
        "rules":[],"incomplete":true,"required_checks":[]});
    if let Some(overrides) = options["fail_on"].as_object() {
        policy.as_object_mut().unwrap().extend(overrides.clone());
    }
    let resolved: FailOn =
        serde_json::from_value(policy.clone()).map_err(|error| error.to_string())?;
    let compiled = resolved.compile().map_err(|error| error.to_string())?;
    let mut pool = Vec::new();
    report.findings.retain(|finding| {
        if finding.category == Category::Ux {
            pool.push(finding.clone());
            false
        } else {
            true
        }
    });
    pool.retain(|finding| finding.evidence_level != EvidenceLevel::Refuted);
    pool.sort_by(|a, b| {
        a.severity
            .cmp(&b.severity)
            .then(b.evidence_level.cmp(&a.evidence_level))
            .then(a.location.path.cmp(&b.location.path))
            .then(a.location.line_start.cmp(&b.location.line_start))
            .then(a.id.cmp(&b.id))
    });
    let matches: Vec<_> = pool
        .iter()
        .filter(|finding| finding.severity != Severity::Info && compiled.matches(finding))
        .map(|finding| finding.id.clone())
        .collect();
    let cap = options["max_defects"].as_u64().unwrap_or(15) as usize;
    let held_back: Vec<_> = pool
        .iter()
        .skip(cap)
        .map(|finding| json!({"id":finding.id,"title":finding.message}))
        .collect();
    let incomplete = resolved.incomplete
        && (runtime_incomplete
            || report.qa.as_ref().is_some_and(|qa| {
                qa["isolation"] == "none"
                    || (qa["evidence"]["storage"] != "local"
                        && qa["observations_unverified"]
                            .as_array()
                            .is_some_and(|rows| !rows.is_empty()))
                    || qa["journeys"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|journey| {
                            matches!(journey["outcome"].as_str(), Some("cancelled" | "not_run"))
                        })
            }));
    let audit = report
        .agent_audit
        .get_or_insert_with(|| json!({"policy_failed":false,"policy_matches":[]}));
    let previous: BTreeSet<_> = audit["qa"]["policy_matches"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    let mut all: BTreeSet<_> = audit["policy_matches"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|id| !previous.contains(*id))
        .map(str::to_owned)
        .collect();
    all.extend(matches.iter().cloned());
    audit["policy_failed"] = json!(!all.is_empty());
    audit["policy_matches"] = json!(all);
    audit["qa_incomplete"] = json!(incomplete);
    audit["qa"] = json!({"fail_on":policy,"max_defects":cap,"policy_failed":!matches.is_empty(),
        "policy_matches":matches,"held_back":held_back,"incomplete":incomplete,"eligible":pool.len()});
    if !held_back.is_empty() {
        report.footer.notes.push(format!("QA held back {} findings at max_defects={cap}: {}. Raise the QA step's max_defects to display them.",
            held_back.len(), held_back.iter().filter_map(|row| row["title"].as_str()).collect::<Vec<_>>().join("; ")));
    }
    report.findings.extend(pool.into_iter().take(cap));
    Ok(())
}

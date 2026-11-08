//! SARIF 2.1.0 rendering per `docs/sarif-mapping.md`. The Worker implements the
//! same mapping in `worker/src/sarif.ts`; both are tested against
//! `tests/fixtures/sarif/`, so changes here must be mirrored there.
use serde_json::{Map, Value, json};

use crate::{Report, ReportStatus, outcome_label, redact};

pub const SARIF_SCHEMA: &str = "https://json.schemastore.org/sarif-2.1.0.json";
const INFORMATION_URI: &str = "https://github.com/pixelinfinito/rio";
const RISK_PREFIX: &str = "Risk for human judgment: ";

/// Renderer inputs that are not part of the report document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SarifInputs {
    pub start_time_utc: String,
    pub end_time_utc: String,
    /// The CLI's exit code; `None` when rendered by the endpoint.
    pub exit_code: Option<u8>,
    /// `--show-pre-existing`; the endpoint always uses false.
    pub include_pre_existing: bool,
}

fn scrub(value: &mut Value) {
    match value {
        Value::String(text) => *text = redact(text),
        Value::Array(items) => items.iter_mut().for_each(scrub),
        Value::Object(items) => items.values_mut().for_each(scrub),
        _ => {}
    }
}

fn region(location: &Value) -> Value {
    let mut region = json!({
        "startLine": location["line_start"],
        "endLine": location["line_end"],
    });
    if let Some(column) = location.get("column").filter(|c| !c.is_null()) {
        region["startColumn"] = column.clone();
    }
    region
}

fn result(entry: &Value, risk: bool, rule_index: usize) -> Value {
    let plausible = entry["evidence_level"] == "plausible";
    let note = risk || plausible;
    let level = if note {
        "note"
    } else {
        match entry["severity"].as_str() {
            Some("error") => "error",
            Some("warning") => "warning",
            _ => "note",
        }
    };
    let mut text = format!(
        "{}{}",
        if note { RISK_PREFIX } else { "" },
        entry["message"].as_str().unwrap_or_default()
    );
    if let Some(trigger) = entry["trigger"].as_str().filter(|t| !t.is_empty()) {
        text.push_str(&format!("\nTrigger: {trigger}"));
    }
    let listed = entry["locations"].as_array().filter(|l| !l.is_empty());
    let locations: Vec<Value> = listed
        .cloned()
        .unwrap_or_else(|| vec![entry["location"].clone()])
        .iter()
        .map(|location| {
            json!({"physicalLocation": {
                "artifactLocation": {"uri": location["path"], "uriBaseId": "SRCROOT"},
                "region": region(location),
            }})
        })
        .collect();
    let mut properties = Map::new();
    properties.insert("evidence_level".into(), entry["evidence_level"].clone());
    properties.insert(
        "category".into(),
        if risk {
            json!("risk")
        } else {
            entry["category"].clone()
        },
    );
    properties.insert("state".into(), entry["state"].clone());
    properties.insert("severity".into(), entry["severity"].clone());
    for key in [
        "status",
        "verification",
        "round",
        "author_response",
        "history",
    ] {
        if let Some(value) = entry.get(key).filter(|v| !v.is_null()) {
            properties.insert(key.into(), value.clone());
        }
    }
    let mut result = json!({
        "ruleId": entry["rule_id"],
        "ruleIndex": rule_index,
        "level": level,
        "message": {"text": text},
        "locations": locations,
        "partialFingerprints": {"rioFindingId/v1": entry["id"]},
        "properties": properties,
    });
    let baseline = match entry["state"].as_str() {
        Some("new" | "worsened") => Some("new"),
        Some("pre-existing") => Some("unchanged"),
        Some("fixed") => Some("absent"),
        _ => None,
    };
    if let Some(baseline) = baseline {
        result["baselineState"] = json!(baseline);
    }
    result
}

/// Renders the review as one SARIF 2.1.0 log.
pub fn render_sarif(report: &Report, inputs: &SarifInputs) -> Result<Vec<u8>, String> {
    let document = serde_json::to_value(report).map_err(|error| error.to_string())?;
    let mut rules: Vec<Value> = Vec::new();
    let mut results = Vec::new();
    if report.status != ReportStatus::Error {
        let lists = [("findings", false), ("risks", true), ("security", false)];
        for (list, risk) in lists {
            for entry in document[list].as_array().into_iter().flatten() {
                if entry["state"] == "pre-existing" && !inputs.include_pre_existing {
                    continue;
                }
                let rule_id = &entry["rule_id"];
                let index = match rules.iter().position(|rule| &rule["id"] == rule_id) {
                    Some(index) => index,
                    None => {
                        rules.push(json!({
                            "id": rule_id,
                            "shortDescription": {"text": entry["message"]},
                            "properties": {
                                "category": if risk { json!("risk") } else { entry["category"].clone() }
                            },
                        }));
                        rules.len() - 1
                    }
                };
                results.push(result(entry, risk, index));
            }
        }
    }
    let mut invocation = json!({
        "executionSuccessful": report.status != ReportStatus::Error,
        "startTimeUtc": inputs.start_time_utc,
        "endTimeUtc": inputs.end_time_utc,
    });
    if let Some(code) = inputs.exit_code {
        invocation["exitCode"] = json!(code);
    }
    if !report.incomplete.is_empty() {
        invocation["toolExecutionNotifications"] = report
            .incomplete
            .iter()
            .map(|check| {
                let kind = crate::label(&check.kind);
                json!({
                    "level": "warning",
                    "descriptor": {"id": kind},
                    "message": {"text": format!(
                        "{kind} {} {}: {}{}",
                        check.root,
                        crate::label(&check.version),
                        outcome_label(&check.outcome),
                        check.outcome.details().hint.as_ref().filter(|hint| !hint.is_empty()).map(|hint| format!(" — {hint}")).unwrap_or_default()
                    )},
                })
            })
            .collect();
    }
    if report.status == ReportStatus::Error
        && let Some(error) = &report.error
    {
        invocation["properties"] = json!({"error": {"code": error.code, "message": error.message}});
    }
    let mut properties = json!({
        "rio.status": document["status"],
        "rio.risk_tier": document["risk_tier"],
        "rio.review_id": report.review.id,
    });
    if let Some(lineage) = document.get("lineage").filter(|l| !l.is_null()) {
        properties["rio.lineage"] = lineage.clone();
    }
    let mut log = json!({
        "$schema": SARIF_SCHEMA,
        "version": "2.1.0",
        "runs": [{
            "tool": {"driver": {
                "name": "rio",
                "version": report.review.rio_version,
                "informationUri": INFORMATION_URI,
                "rules": rules,
            }},
            "originalUriBaseIds": {"SRCROOT": {"description": {"text": "Repository root"}}},
            "results": results,
            "invocations": [invocation],
            "properties": properties,
        }],
    });
    scrub(&mut log);
    let mut output = serde_json::to_vec_pretty(&log).map_err(|error| error.to_string())?;
    output.push(b'\n');
    Ok(output)
}

//! The SARIF renderer against the shared fixtures in `tests/fixtures/sarif/`
//! (the Worker's renderer is tested against the same files) and the official
//! SARIF 2.1.0 schema.
use rio_core::{Report, SarifInputs, render_sarif};
use serde_json::Value;
use std::{fs, path::PathBuf};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}
fn json(path: PathBuf) -> Value {
    serde_json::from_str(&fs::read_to_string(&path).unwrap())
        .unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}
pub fn inputs(render: &Value) -> SarifInputs {
    SarifInputs {
        start_time_utc: render["start_time_utc"].as_str().unwrap().into(),
        end_time_utc: render["end_time_utc"].as_str().unwrap().into(),
        exit_code: render["exit_code"].as_u64().map(|c| c as u8),
        include_pre_existing: render["include_pre_existing"].as_bool().unwrap_or(false),
    }
}
fn validator() -> jsonschema::Validator {
    let schema = json(root().join("tests/fixtures/sarif-schema/sarif-schema-2.1.0.json"));
    jsonschema::validator_for(&schema).unwrap()
}
fn cases() -> Vec<PathBuf> {
    let mut cases: Vec<_> = fs::read_dir(root().join("tests/fixtures/sarif"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    cases.sort();
    assert_eq!(cases.len(), 4);
    cases
}

#[test]
fn fixtures_render_to_their_expected_sarif_and_validate_against_the_official_schema() {
    let validator = validator();
    for case in cases() {
        let report: Report = serde_json::from_value(json(case.join("report.json"))).unwrap();
        let rendered = render_sarif(&report, &inputs(&json(case.join("render.json")))).unwrap();
        let rendered: Value = serde_json::from_slice(&rendered).unwrap();
        // serde_json maps compare by key, which is the canonical ordering.
        assert_eq!(
            rendered,
            json(case.join("expected.sarif")),
            "{}",
            case.display()
        );
        let errors: Vec<_> = validator
            .iter_errors(&rendered)
            .map(|e| format!("{} at {}", e, e.instance_path))
            .collect();
        assert!(errors.is_empty(), "{}: {errors:?}", case.display());
    }
    // The schema is not vacuous: an invalid level and a missing version fail.
    let mut log = json(root().join("tests/fixtures/sarif/complete-review/expected.sarif"));
    log["runs"][0]["results"][0]["level"] = "fatal".into();
    assert!(!validator.is_valid(&log));
    let mut log = json(root().join("tests/fixtures/sarif/error-status/expected.sarif"));
    log.as_object_mut().unwrap().remove("version");
    assert!(!validator.is_valid(&log));
}

#[test]
fn pre_existing_entries_appear_as_unchanged_only_on_request() {
    let case = root().join("tests/fixtures/sarif/complete-review");
    let report: Report = serde_json::from_value(json(case.join("report.json"))).unwrap();
    let mut options = inputs(&json(case.join("render.json")));
    let pre_existing: Vec<_> = report
        .findings
        .iter()
        .filter(|f| f.state == rio_core::State::PreExisting)
        .map(|f| f.id.clone())
        .collect();
    assert!(!pre_existing.is_empty());
    let ids = |options: &SarifInputs| -> Vec<(String, Value)> {
        let log: Value = serde_json::from_slice(&render_sarif(&report, options).unwrap()).unwrap();
        log["runs"][0]["results"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| {
                (
                    r["partialFingerprints"]["rioFindingId/v1"]
                        .as_str()
                        .unwrap()
                        .to_owned(),
                    r["baselineState"].clone(),
                )
            })
            .collect()
    };
    assert!(
        ids(&options)
            .iter()
            .all(|(id, _)| !pre_existing.contains(id))
    );
    options.include_pre_existing = true;
    let shown = ids(&options);
    for id in &pre_existing {
        assert!(
            shown.contains(&(id.clone(), Value::from("unchanged"))),
            "{id}"
        );
    }
    assert!(
        validator()
            .validate(&serde_json::from_slice(&render_sarif(&report, &options).unwrap()).unwrap())
            .is_ok()
    );
}

#[test]
fn remembered_and_suppressed_findings_are_never_results() {
    let case = root().join("tests/fixtures/sarif/lineage-history");
    let mut report: Report = serde_json::from_value(json(case.join("report.json"))).unwrap();
    let remembered = report.findings.remove(1);
    report.remembered.push(remembered.clone());
    report.summary.suppressed = 1;
    let log: Value = serde_json::from_slice(
        &render_sarif(&report, &inputs(&json(case.join("render.json")))).unwrap(),
    )
    .unwrap();
    let text = log.to_string();
    assert!(!text.contains(&remembered.id));
    assert_eq!(log["runs"][0]["results"].as_array().unwrap().len(), 1);
    assert_eq!(
        log["runs"][0]["tool"]["driver"]["rules"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

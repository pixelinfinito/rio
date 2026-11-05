use std::{fs, path::Path};

use serde_json::{Value, json};

fn schema(name: &str) -> Value {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../schemas");
    serde_json::from_str(&fs::read_to_string(root.join(format!("{name}-v1.json"))).unwrap())
        .unwrap()
}

#[test]
fn profile_fixtures() {
    let validator = jsonschema::validator_for(&schema("profile")).unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    for (directory, valid) in [("valid", true), ("invalid", false)] {
        for entry in fs::read_dir(root.join(directory)).unwrap() {
            let path = entry.unwrap().path();
            let value: Value = serde_yaml::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            let errors: Vec<_> = validator
                .iter_errors(&value)
                .map(|e| e.to_string())
                .collect();
            assert_eq!(errors.is_empty(), valid, "{}: {errors:?}", path.display());
        }
    }
}

#[test]
fn module_contract_requires_exit_codes_and_kind_specific_fields() {
    let validator = jsonschema::validator_for(&schema("module")).unwrap();
    let mut module = json!({
        "kind": "adapter", "name": "rio/adapter-example", "version": "0.1.0",
        "description": "Example adapter", "schema": {"type": "object"},
        "languages": ["example"], "files": ["*.example"], "capabilities": ["typecheck"],
        "tools": {"typecheck": [{"name": "example", "command": ["example"], "network": [],
            "exit_codes": {"clean": [0], "diagnostics": [1], "failed": {"2": "tool_config_error"}}}]}
    });
    assert!(validator.is_valid(&module));
    module["tools"]["typecheck"][0]
        .as_object_mut()
        .unwrap()
        .remove("exit_codes");
    assert!(!validator.is_valid(&module));
    module["tools"]["typecheck"] = json!([]);
    module.as_object_mut().unwrap().remove("languages");
    assert!(!validator.is_valid(&module));
}

#[test]
fn built_in_manifests_and_base_profile_validate() {
    let validator = jsonschema::validator_for(&schema("module")).unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../modules");
    let paths = [
        "adapters/typescript",
        "adapters/python",
        "steps/prepare",
        "steps/checks",
        "steps/graph",
        "steps/triage",
        "steps/agents",
        "steps/verify",
        "steps/report",
    ];
    for path in paths {
        let manifest: Value =
            serde_yaml::from_str(&fs::read_to_string(root.join(path).join("module.yaml")).unwrap())
                .unwrap();
        let errors: Vec<_> = validator
            .iter_errors(&manifest)
            .map(|e| e.to_string())
            .collect();
        assert!(errors.is_empty(), "{path}: {errors:?}");
        jsonschema::validator_for(&manifest["schema"]).unwrap();
    }
    let profile: Value =
        serde_yaml::from_str(&fs::read_to_string(root.join("profiles/base.yaml")).unwrap())
            .unwrap();
    assert!(
        jsonschema::validator_for(&schema("profile"))
            .unwrap()
            .is_valid(&profile)
    );
    for step in profile["steps"].as_array().unwrap() {
        let name = step["uses"]
            .as_str()
            .unwrap()
            .strip_prefix("rio/")
            .unwrap()
            .split('@')
            .next()
            .unwrap();
        let manifest: Value = serde_yaml::from_str(
            &fs::read_to_string(root.join(format!("steps/{name}/module.yaml"))).unwrap(),
        )
        .unwrap();
        let validator = jsonschema::validator_for(&manifest["schema"]).unwrap();
        assert!(
            validator.is_valid(step.get("with").unwrap_or(&json!({}))),
            "{name}"
        );
    }
}

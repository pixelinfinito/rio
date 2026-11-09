use std::{fs, path::Path};

use serde_json::{Value, json};

fn validator() -> jsonschema::Validator {
    let schema: Value =
        serde_json::from_str(include_str!("../../../schemas/module-v1.json")).unwrap();
    jsonschema::validator_for(&schema).unwrap()
}

fn ruleset() -> Value {
    json!({
        "kind": "ruleset", "name": "rio/ui-v1", "version": "0.1.0",
        "description": "UI measurements and contextual usability criteria",
        "rules": [
            {
                "id": "mobile/tap-target", "kind": "probe", "category": "accessibility",
                "severity": "warning", "description": "Measure interactive target size",
                "eligible": "button, a[href]", "measure": "bounding box in CSS pixels",
                "threshold": {"min": 44, "unit": "CSS px"}, "exclude": [], "scope": "step"
            },
            {
                "id": "ux/error-recovery", "kind": "judged", "category": "ux",
                "severity": "warning", "description": "Assess recovery after failed input",
                "source": {
                    "title": "Nielsen usability heuristics", "version": "1994",
                    "url": "https://www.nngroup.com/articles/ten-usability-heuristics/"
                },
                "applicability": "A user encounters an error during a task",
                "required_evidence": ["Before and after screenshots", "Recorded interaction"],
                "examples": ["Preserve entered values after payment is declined"]
            }
        ]
    })
}

#[test]
fn qa_rules_require_kind_specific_evidence_and_predicates() {
    let validator = validator();
    let original = ruleset();
    assert!(validator.is_valid(&original));
    for (index, required) in [
        (
            0,
            vec!["eligible", "measure", "threshold", "exclude", "scope"],
        ),
        (
            1,
            vec!["source", "applicability", "required_evidence", "examples"],
        ),
    ] {
        for key in required {
            let mut value = original.clone();
            value["rules"][index].as_object_mut().unwrap().remove(key);
            assert!(!validator.is_valid(&value), "missing {key} in rule {index}");
        }
    }
    for key in ["title", "version", "url"] {
        let mut value = original.clone();
        value["rules"][1]["source"]
            .as_object_mut()
            .unwrap()
            .remove(key);
        assert!(!validator.is_valid(&value), "missing source {key}");
    }
    let mut crossed = original.clone();
    crossed["rules"][1]["eligible"] = json!("button");
    assert!(!validator.is_valid(&crossed));
    let mut crossed = original.clone();
    crossed["rules"][0]["source"] = original["rules"][1]["source"].clone();
    assert!(!validator.is_valid(&crossed));
}

#[test]
fn qa_rules_reject_unknown_fields_and_invalid_thresholds() {
    let validator = validator();
    for (key, invalid) in [
        ("id", json!("arbitrary/tap-target")),
        ("id", json!("ux/measured-preference")),
        ("kind", json!("script")),
        ("category", json!("taste")),
        ("severity", json!("critical")),
        ("scope", json!("page")),
        ("threshold", json!({"ratio": 1.1})),
        ("threshold", json!({"ratio": -0.1})),
        ("threshold", json!({"ratio": 0.2, "min_sample": 0})),
        ("threshold", json!({"minimum_typo": 44})),
        ("threshold", json!({"unit": "px"})),
        ("execute", json!("repository script")),
    ] {
        let mut value = ruleset();
        value["rules"][0][key] = invalid;
        assert!(!validator.is_valid(&value), "accepted invalid {key}");
    }
    let mut value = ruleset();
    value["rules"][0]["threshold"] = json!({"ratio": 0.2, "min_sample": 5});
    assert!(validator.is_valid(&value));
    value["rules"][0]["threshold"] = json!(0.1);
    assert!(validator.is_valid(&value));
    value["rules"][1]["required_evidence"] = json!([]);
    assert!(!validator.is_valid(&value));
}

#[test]
fn rulesets_cannot_carry_executable_module_fields() {
    let validator = validator();
    for (key, value) in [
        ("schema", json!({})),
        ("inputs", json!([])),
        ("outputs", json!([])),
        ("local", json!(true)),
        ("tools", json!({})),
        ("languages", json!(["typescript"])),
        ("items", json!([])),
    ] {
        let mut module = ruleset();
        module[key] = value;
        assert!(!validator.is_valid(&module), "ruleset accepted {key}");
    }
    let mut module = ruleset();
    module.as_object_mut().unwrap().remove("rules");
    assert!(!validator.is_valid(&module));
    module["rules"] = json!([]);
    assert!(!validator.is_valid(&module));
}

#[test]
fn ruleset_extension_preserves_all_existing_module_manifests() {
    fn visit(path: &Path, validator: &jsonschema::Validator, count: &mut usize) {
        for entry in fs::read_dir(path).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                visit(&path, validator, count);
            } else if path
                .extension()
                .is_some_and(|extension| extension == "yaml")
            {
                let value: Value =
                    serde_yaml::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
                if value.get("kind").is_some() {
                    let errors: Vec<_> = validator
                        .iter_errors(&value)
                        .map(|e| e.to_string())
                        .collect();
                    assert!(errors.is_empty(), "{}: {errors:?}", path.display());
                    *count += 1;
                    if value["kind"] != "ruleset" {
                        let mut with_rules = value;
                        with_rules["rules"] = ruleset()["rules"].clone();
                        assert!(
                            !validator.is_valid(&with_rules),
                            "{} accepts ruleset fields",
                            path.display()
                        );
                    }
                }
            }
        }
    }
    let mut count = 0;
    visit(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("../../modules"),
        &validator(),
        &mut count,
    );
    assert!(count >= 13, "expected adapters, steps and catalogs");
}

#[test]
fn shipped_rules_cover_every_spec_predicate_and_skill_reference() {
    let ruleset = rio_profile::resolve_module("rio/ui-v1@0.1.0").unwrap();
    assert_eq!(ruleset.kind, rio_profile::ModuleKind::Ruleset);
    let ids: std::collections::BTreeSet<_> = ruleset
        .rules
        .iter()
        .map(|r| r["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids.len(), ruleset.rules.len());
    assert_eq!(ids.len(), 34);
    let references = regex::Regex::new(r"`((?:ui|mobile|ux)/[a-z][a-z0-9-]*)`").unwrap();
    for document in [
        include_str!("../../../openspec/changes/rio-v0-3-qa/specs/ui-quality-rules/spec.md"),
        include_str!("../../../modules/qa/skill/SKILL.md"),
    ] {
        for reference in references.captures_iter(document) {
            assert!(
                ids.contains(&reference[1]),
                "missing rule {}",
                &reference[1]
            );
        }
    }
    let skill = include_str!("../../../modules/qa/skill/SKILL.md");
    assert!(skill.contains("Skill version: 0.1.0"));
    for rule in &ruleset.rules {
        let id = rule["id"].as_str().unwrap();
        if id.starts_with("ux/") {
            assert!(skill.contains(id));
            assert_eq!(rule["kind"], "judged");
            assert!(
                rule["source"]["url"]
                    .as_str()
                    .unwrap()
                    .starts_with("https://")
            );
            assert!(!rule["required_evidence"].as_array().unwrap().is_empty());
        }
    }
}

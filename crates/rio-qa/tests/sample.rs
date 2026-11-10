use rio_qa::{QaProject, QaSnapshot};
use std::{fs, path::Path};
fn read(directory: &Path, root: &Path, snapshot: &mut QaSnapshot) {
    for entry in fs::read_dir(directory).unwrap() {
        let entry = entry.unwrap();
        let path = entry.path();
        if entry.file_type().unwrap().is_dir() {
            if ![
                "node_modules",
                "dist",
                "data",
                "test-results",
                "playwright-report",
            ]
            .contains(&entry.file_name().to_str().unwrap())
            {
                read(&path, root, snapshot);
            }
        } else {
            snapshot.insert(
                path.strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                fs::read(path).unwrap(),
            );
        }
    }
}
#[test]
fn sample_contracts_validate_with_checkout_state_and_recovery_guidance() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/qa-sample");
    let mut files = QaSnapshot::new();
    read(&root, &root, &mut files);
    let project = QaProject::load(&files).unwrap();
    assert!(project.warnings.is_empty(), "{:?}", project.warnings);
    assert!(project.journeys["add-to-cart"].resets);
    assert_eq!(project.journeys["checkout"].after, ["add-to-cart"]);
    assert!(!project.journeys["checkout"].resets);
    let rules: serde_json::Value =
        serde_yaml::from_str(include_str!("../../../modules/qa/rules/ui-v1.yaml")).unwrap();
    for journey in project.journeys.values() {
        for criterion in &journey.ux_criteria {
            assert!(
                rules["rules"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|r| r["id"] == *criterion),
                "{criterion}"
            );
        }
    }
}

#[test]
fn documented_seed_and_fixture_examples_validate_with_the_sample_application() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/qa-sample");
    let mut files = QaSnapshot::new();
    read(&root, &root, &mut files);
    let docs = include_str!("../../../docs/qa.md");
    let examples: Vec<_> = docs
        .split("```yaml\n")
        .skip(1)
        .map(|block| block.split("```").next().unwrap())
        .collect();
    assert_eq!(examples.len(), 2);
    files.insert(
        ".rio/qa/seed/seed.yaml".into(),
        examples[0].as_bytes().to_vec(),
    );
    files.insert(
        ".rio/qa/fixtures/fixtures.yaml".into(),
        examples[1].as_bytes().to_vec(),
    );
    // The documented postgres and sqlite variants use the same logical seed.
    for kind in ["postgres", "sqlite"] {
        files.insert(
            ".rio/qa/seed/seed.yaml".into(),
            examples[0]
                .replace("kind: postgres", &format!("kind: {kind}"))
                .into_bytes(),
        );
        let project = QaProject::load(&files).unwrap();
        assert_eq!(project.seed.unwrap().datastores[0].kind, kind);
        assert_eq!(project.fixtures.unwrap().services.len(), 2);
    }
}

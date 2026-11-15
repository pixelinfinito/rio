#[test]
fn documented_adapter_manifest_validates() {
    let document = include_str!("../../../docs/adapters.md");
    let example = document
        .split("```yaml\n")
        .nth(1)
        .unwrap()
        .split("```")
        .next()
        .unwrap();
    let value: serde_json::Value = serde_yaml::from_str(example).unwrap();
    let schema: serde_json::Value =
        serde_json::from_str(include_str!("../../../schemas/module-v1.json")).unwrap();
    let validator = jsonschema::validator_for(&schema).unwrap();
    let errors: Vec<_> = validator
        .iter_errors(&value)
        .map(|error| error.to_string())
        .collect();
    assert!(errors.is_empty(), "{errors:?}");
}

/// The Profiles page's YAML example that turns coverage off.
fn coverage_example(document: &str) -> &str {
    let examples: Vec<&str> = document
        .split("```yaml\n")
        .skip(1)
        .map(|block| block.split("```").next().unwrap())
        .filter(|example| example.contains("coverage:"))
        .collect();
    assert_eq!(examples.len(), 1, "expected one coverage example");
    examples[0]
}

#[test]
fn wiki_profile_examples_are_valid() {
    for document in [
        include_str!("../../../docs/wiki/en/profiles.md"),
        include_str!("../../../docs/wiki/pt-BR/profiles.md"),
    ] {
        profile_example_disables_coverage(coverage_example(document));
    }
}

fn profile_example_disables_coverage(example: &str) {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("profile.yaml");
    std::fs::write(&path, example).unwrap();
    let profile = rio_profile::ProfileLoader::new(
        Some(root.path().into()),
        root.path().join("config"),
        root.path().into(),
    )
    .load(Some(path.to_str().unwrap()))
    .unwrap();
    assert!(
        !profile.profile.step("rio/checks").unwrap().options["coverage"]
            .as_bool()
            .unwrap()
    );
}

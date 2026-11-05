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

#[test]
fn readme_profile_example_is_valid() {
    let document = include_str!("../../../README.md");
    let example = document
        .split("```yaml\n")
        .nth(1)
        .unwrap()
        .split("```")
        .next()
        .unwrap();
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

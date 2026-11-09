use rio_profile::{ProfileLoader, ProfileSource};
use std::{fs, path::Path};

fn write(root: &Path, path: &str, name: &str) {
    let path = root.join(path);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        path,
        format!("version: 1\nname: {name}\nextends: rio/base\n"),
    )
    .unwrap();
}

#[test]
fn discovery_resolves_explicit_repo_personal_and_embedded_profiles() {
    let root = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let loader = ProfileLoader::new(
        Some(root.path().into()),
        config.path().into(),
        root.path().into(),
    );
    assert_eq!(
        loader.discover(None).unwrap(),
        ProfileSource::BuiltIn("rio/base".into())
    );
    assert_eq!(
        loader.discover(Some("base")).unwrap(),
        ProfileSource::BuiltIn("rio/base".into())
    );
    write(config.path(), "profiles/default.yaml", "personal-default");
    assert!(matches!(
        loader.discover(None).unwrap(),
        ProfileSource::Personal(_)
    ));
    write(root.path(), ".rio/profiles/default.yaml", "repo-default");
    assert!(matches!(
        loader.discover(None).unwrap(),
        ProfileSource::Repo(_)
    ));
    write(root.path(), ".rio/profiles/base.yaml", "repo-base");
    assert!(matches!(
        loader.discover(Some("base")).unwrap(),
        ProfileSource::Repo(_)
    ));
    write(config.path(), "profiles/security.yaml", "personal-security");
    assert!(matches!(
        loader.discover(Some("security")).unwrap(),
        ProfileSource::Personal(_)
    ));
    write(root.path(), ".rio/profiles/security.yaml", "repo-security");
    assert!(matches!(
        loader.discover(Some("security")).unwrap(),
        ProfileSource::Repo(_)
    ));
    write(root.path(), "custom.yaml", "explicit");
    assert!(matches!(
        loader.discover(Some("custom.yaml")).unwrap(),
        ProfileSource::File(_)
    ));
    assert!(loader.discover(Some("nonexistent")).is_err());
    assert!(loader.discover(Some("rio/base@999.0.0")).is_err());
}

#[test]
fn listing_keeps_shadowed_profiles_and_marks_only_the_actual_default() {
    let root = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let loader = ProfileLoader::new(
        Some(root.path().into()),
        config.path().into(),
        root.path().into(),
    );
    let initial = loader.list().unwrap();
    let names: Vec<_> = initial.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(
        names,
        ["rio/base", "rio/critical", "rio/openrouter", "rio/security"]
    );
    assert!(initial[0].is_default);
    assert!(initial[1..].iter().all(|p| !p.is_default));
    write(root.path(), ".rio/profiles/default.yaml", "default");
    write(config.path(), "profiles/default.yaml", "default");
    let listed = loader.list().unwrap();
    assert_eq!(listed.len(), 6);
    assert_eq!(listed.iter().filter(|p| p.is_default).count(), 1);
    assert!(
        listed
            .iter()
            .any(|p| p.is_default && matches!(p.source, ProfileSource::Repo(_)))
    );
    assert!(
        listed
            .iter()
            .all(|p| p.extends.as_deref().is_some_and(|p| p == "rio/base")
                || p.name == "rio/base"
                || p.name == "rio/critical" && p.extends.as_deref() == Some("rio/security"))
    );
}

#[test]
fn profiles_work_without_a_repository_and_builtin_assets_are_embedded() {
    let root = tempfile::tempdir().unwrap();
    let loader = ProfileLoader::new(None, root.path().join("config"), root.path().into());
    let source = loader.discover(None).unwrap();
    assert!(source.read().unwrap().contains("name: rio/base"));
    assert!(
        rio_profile::BUILT_INS
            .get_file("adapters/typescript/module.yaml")
            .is_some()
    );
    assert!(
        rio_profile::BUILT_INS
            .get_file("steps/verify/module.yaml")
            .is_some()
    );
}

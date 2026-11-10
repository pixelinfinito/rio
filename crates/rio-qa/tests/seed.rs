use rio_qa::{QaProject, QaSnapshot, SeedFingerprint};
use serde_json::json;

fn snapshot() -> QaSnapshot {
    QaSnapshot::from([
        (".rio/qa.yaml".into(), serde_json::to_vec(&json!({
            "version": 1,
            "app": {"packaging":"static","directory":"dist","url":"http://app:4173","ready":{"path":"/","status":200}},
            "personas": [{"name":"shopper","description":"Synthetic shopper","password_env":"QA_PASSWORD"}],
            "seed": {"migrations":["db/migrations/*.sql"],"cache_version":"v1"}
        })).unwrap()),
        (".rio/qa/seed/seed.yaml".into(), serde_json::to_vec(&json!({
            "version":1,"datastores":[{"name":"shop","kind":"sqlite","connection_env":"DATABASE_URL"}],
            "steps":[{"file":"schema.sql","applies_to":["shop"]}],
            "users":[{"persona":"shopper","apply":"node scripts/credentials.mjs"}],"paths":[]
        })).unwrap()),
        (".rio/qa/seed/schema.sql".into(), b"CREATE TABLE orders (id INTEGER);".to_vec()),
        ("db/migrations/001.sql".into(), b"CREATE TABLE orders (id INTEGER);".to_vec()),
        ("scripts/credentials.mjs".into(), b"// Apply the runtime password after restore".to_vec()),
        ("src/app.js".into(), b"// Application source".to_vec()),
    ])
}

fn fingerprint(files: &QaSnapshot) -> SeedFingerprint {
    SeedFingerprint::build(
        &QaProject::load(files).unwrap(),
        files,
        &format!("sha256:{}", "a".repeat(64)),
    )
    .unwrap()
}

fn cached_seed(root: &std::path::Path, id: &str, created: u64, part: &str) {
    let mut fingerprint = fingerprint(&snapshot());
    fingerprint.fingerprint = id.to_owned();
    let manifest = json!({"version":1,"fingerprint":fingerprint,"created_at_ms":created,
        "archives":[{"name":"shop","kind":"sqlite","hash":part,"bytes":4,"parts":[{"hash":part,"bytes":4}]}]});
    std::fs::create_dir_all(root.join(id)).unwrap();
    std::fs::create_dir_all(root.join("objects")).unwrap();
    std::fs::write(
        root.join(id).join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    std::fs::write(root.join("objects").join(part), b"seed").unwrap();
}

#[test]
fn pruning_keeps_newest_and_leased_snapshots_and_inflight_parts() {
    let root = tempfile::tempdir().unwrap();
    let ids: Vec<_> = ["1", "2", "3", "4"].map(|name| name.repeat(64)).into();
    let shared = "a".repeat(64);
    let orphan = "b".repeat(64);
    let inflight = "c".repeat(64);
    for (index, id) in ids.iter().enumerate() {
        cached_seed(root.path(), id, index as u64, &shared);
    }
    std::fs::write(root.path().join("objects").join(&orphan), b"unused").unwrap();
    std::fs::write(root.path().join("objects").join(&inflight), b"uploading").unwrap();
    std::fs::create_dir(root.path().join("leases")).unwrap();
    std::fs::write(
        root.path().join("leases/live.json"),
        serde_json::to_vec(
            &json!({"fingerprint":ids[0],"parts":[inflight],"expires_at_ms":9000000000000_u64}),
        )
        .unwrap(),
    )
    .unwrap();
    std::fs::write(
        root.path().join("leases/expired.json"),
        serde_json::to_vec(&json!({"fingerprint":ids[1],"parts":[],"expires_at_ms":1})).unwrap(),
    )
    .unwrap();
    assert_eq!(
        rio_qa::prune_seed_cache(root.path(), 1).unwrap(),
        vec![ids[2].clone(), ids[1].clone()]
    );
    assert!(root.path().join(&ids[0]).exists());
    assert!(root.path().join(&ids[3]).exists());
    assert!(root.path().join("objects").join(&shared).exists());
    assert!(root.path().join("objects").join(&inflight).exists());
    assert!(!root.path().join("objects").join(&orphan).exists());
    assert!(!root.path().join("leases/expired.json").exists());
    assert_eq!(
        rio_qa::prune_seed_cache(root.path(), 0).unwrap(),
        vec![ids[3].clone()]
    );
    std::fs::remove_file(root.path().join("leases/live.json")).unwrap();
    assert_eq!(
        rio_qa::prune_seed_cache(root.path(), 0).unwrap(),
        vec![ids[0].clone()]
    );
    assert_eq!(
        std::fs::read_dir(root.path().join("objects"))
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn corrupt_manifest_stops_pruning_before_any_snapshot_is_removed() {
    let root = tempfile::tempdir().unwrap();
    let id = "a".repeat(64);
    cached_seed(root.path(), &id, 1, &"b".repeat(64));
    std::fs::create_dir(root.path().join("c".repeat(64))).unwrap();
    std::fs::write(
        root.path().join("c".repeat(64)).join("manifest.json"),
        b"broken",
    )
    .unwrap();
    assert!(rio_qa::prune_seed_cache(root.path(), 0).is_err());
    assert!(root.path().join(id).join("manifest.json").exists());
}

#[cfg(unix)]
#[test]
fn pruning_refuses_symlinked_cache_ancestors_and_lease_files() {
    use std::os::unix::fs::symlink;
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let id = "a".repeat(64);
    cached_seed(outside.path(), &id, 1, &"b".repeat(64));
    symlink(outside.path(), root.path().join("linked")).unwrap();
    assert!(rio_qa::prune_seed_cache(&root.path().join("linked"), 0).is_err());
    std::fs::create_dir(outside.path().join("leases")).unwrap();
    symlink(
        outside.path().join(&id).join("manifest.json"),
        outside.path().join("leases/fake.json"),
    )
    .unwrap();
    assert!(rio_qa::prune_seed_cache(outside.path(), 0).is_err());
    assert!(outside.path().join(id).exists());
}

#[test]
fn pruning_waits_for_an_inflight_host_transfer() {
    use fs4::fs_std::FileExt;
    let root = tempfile::tempdir().unwrap();
    let id = "a".repeat(64);
    cached_seed(root.path(), &id, 1, &"b".repeat(64));
    let lock = std::fs::File::create(root.path().join(".lock")).unwrap();
    FileExt::lock_exclusive(&lock).unwrap();
    let path = root.path().to_owned();
    let (send, receive) = std::sync::mpsc::channel();
    let thread = std::thread::spawn(move || {
        send.send(rio_qa::prune_seed_cache(&path, 0)).unwrap();
    });
    assert!(
        receive
            .recv_timeout(std::time::Duration::from_millis(50))
            .is_err()
    );
    assert!(root.path().join(id).exists());
    drop(lock);
    assert_eq!(
        receive
            .recv_timeout(std::time::Duration::from_secs(10))
            .unwrap()
            .unwrap()
            .len(),
        1
    );
    thread.join().unwrap();
}

#[test]
fn fingerprint_reuses_immutable_seed_and_has_no_runtime_credentials() {
    let files = snapshot();
    let initial = fingerprint(&files);
    assert_eq!(initial, fingerprint(&files));
    assert_eq!(initial.rebuild_reason(Some(&initial)), None);
    assert_eq!(initial.rebuild_reason(None), Some("no cached snapshot"));
    let mut project = QaProject::load(&files).unwrap();
    // Changing the environment that will apply credentials cannot change the
    // key. The fingerprint function never accepts the runtime secret catalog.
    project
        .config
        .app
        .env
        .insert("QA_PASSWORD".into(), "rotated-synthetic-value".into());
    let rotated = SeedFingerprint::build(&project, &files, &initial.image_digest).unwrap();
    assert_eq!(rotated, initial);
    assert!(
        !serde_json::to_string(&rotated)
            .unwrap()
            .contains("rotated-synthetic-value")
    );
    let mut source = files.clone();
    source.insert("src/app.js".into(), b"// Changed UI".to_vec());
    assert_eq!(fingerprint(&source), initial);
}

#[test]
fn added_modified_and_deleted_migrations_invalidate_the_seed() {
    let files = snapshot();
    let initial = fingerprint(&files);
    for (path, bytes) in [
        (
            "db/migrations/002.sql",
            Some(b"ALTER TABLE orders ADD total REAL;".to_vec()),
        ),
        (
            "db/migrations/001.sql",
            Some(b"CREATE TABLE changed (id INTEGER);".to_vec()),
        ),
        ("db/migrations/001.sql", None),
    ] {
        let mut changed = files.clone();
        if let Some(bytes) = bytes {
            changed.insert(path.into(), bytes);
        } else {
            changed.remove(path);
        }
        let next = fingerprint(&changed);
        assert_ne!(next.fingerprint, initial.fingerprint);
        assert_eq!(
            next.rebuild_reason(Some(&initial)),
            Some("migrations changed")
        );
    }
}

#[test]
fn cache_version_seed_definitions_datastore_kind_and_image_invalidate() {
    let files = snapshot();
    let initial = fingerprint(&files);
    let mut project = QaProject::load(&files).unwrap();
    project.config.seed.cache_version = json!("v2");
    let next = SeedFingerprint::build(&project, &files, &initial.image_digest).unwrap();
    assert_eq!(
        next.rebuild_reason(Some(&initial)),
        Some("seed.cache_version changed")
    );
    project.config.seed.cache_version = json!("v1");
    project.seed.as_mut().unwrap().datastores[0].kind = "postgres".into();
    let next = SeedFingerprint::build(&project, &files, &initial.image_digest).unwrap();
    assert_eq!(
        next.rebuild_reason(Some(&initial)),
        Some("datastore kinds changed")
    );
    let mut changed = files.clone();
    changed.insert(
        ".rio/qa/seed/schema.sql".into(),
        b"CREATE TABLE products(id INTEGER);".to_vec(),
    );
    assert_eq!(
        fingerprint(&changed).rebuild_reason(Some(&initial)),
        Some("seed files changed")
    );
    let next =
        SeedFingerprint::build(&project, &files, &format!("sha256:{}", "b".repeat(64))).unwrap();
    assert_eq!(
        next.rebuild_reason(Some(&initial)),
        Some("app image changed")
    );
    assert!(SeedFingerprint::build(&project, &files, "rio-sample:latest").is_err());
}

#[test]
fn command_seed_loaders_include_indirect_source_dependencies() {
    let mut files = snapshot();
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&files[".rio/qa/seed/seed.yaml"]).unwrap();
    manifest["steps"] = json!([{"command":"npm run qa:seed","applies_to":["shop"]}]);
    files.insert(
        ".rio/qa/seed/seed.yaml".into(),
        serde_json::to_vec(&manifest).unwrap(),
    );
    files.insert(
        "src/loaders/products.js".into(),
        b"// Transitive seed import".to_vec(),
    );
    let initial = fingerprint(&files);
    files.insert(
        "src/loaders/products.js".into(),
        b"// New initial products".to_vec(),
    );
    let next = fingerprint(&files);
    assert_eq!(
        next.rebuild_reason(Some(&initial)),
        Some("seed command source changed")
    );
}

#[test]
fn fixture_manifest_recordings_and_uploads_invalidate_even_without_command_loaders() {
    let mut files = snapshot();
    files.insert(
        ".rio/qa/fixtures/fixtures.yaml".into(),
        serde_json::to_vec(&json!({"version":1,"defaults":{"timezone":"Europe/Lisbon"}})).unwrap(),
    );
    files.insert(
        ".rio/qa/fixtures/files/avatar.txt".into(),
        b"synthetic avatar".to_vec(),
    );
    files.insert(
        ".rio/qa/fixtures/recordings/payment.json".into(),
        b"{}".to_vec(),
    );
    let initial = fingerprint(&files);
    for path in [
        ".rio/qa/fixtures/fixtures.yaml",
        ".rio/qa/fixtures/files/avatar.txt",
        ".rio/qa/fixtures/recordings/payment.json",
    ] {
        let mut changed = files.clone();
        if path.ends_with("fixtures.yaml") {
            changed.insert(
                path.into(),
                serde_json::to_vec(&json!({"version":1,"defaults":{"timezone":"UTC"}})).unwrap(),
            );
        } else {
            changed.insert(path.into(), b"changed fixture".to_vec());
        }
        let next = fingerprint(&changed);
        assert_ne!(initial.fingerprint, next.fingerprint);
        assert_eq!(
            next.rebuild_reason(Some(&initial)),
            Some("fixture definitions or files changed")
        );
        changed.remove(path);
        assert_ne!(fingerprint(&changed).fingerprint, initial.fingerprint);
    }
}

#[test]
fn cache_status_requires_a_committed_manifest_and_explains_migration_changes() {
    use rio_qa::{SeedArchive, SeedPart, SeedSnapshotManifest, seed_cache_status};
    let root = tempfile::tempdir().unwrap();
    let original = fingerprint(&snapshot());
    assert_eq!(
        seed_cache_status(root.path(), &original, 1024).unwrap()["next"],
        "build"
    );
    let directory = root.path().join(&original.fingerprint);
    std::fs::create_dir(&directory).unwrap();
    std::fs::write(directory.join("unfinished-part"), "partial").unwrap();
    assert_eq!(
        seed_cache_status(root.path(), &original, 1024).unwrap()["next"],
        "build"
    );
    let manifest = SeedSnapshotManifest {
        version: 1,
        fingerprint: original.clone(),
        created_at_ms: 1,
        archives: vec![SeedArchive {
            name: "shop".into(),
            kind: "sqlite".into(),
            hash: "a".repeat(64),
            bytes: 10,
            parts: vec![SeedPart {
                hash: "a".repeat(64),
                bytes: 10,
            }],
        }],
    };
    std::fs::write(
        directory.join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    let status = seed_cache_status(root.path(), &original, 1024).unwrap();
    assert_eq!(status["next"], "restore");
    assert_eq!(status["bytes"], 10);
    let mut files = snapshot();
    files.insert(
        "db/migrations/002.sql".into(),
        b"ALTER TABLE orders ADD amount INTEGER;".to_vec(),
    );
    let updated = fingerprint(&files);
    let status = seed_cache_status(root.path(), &updated, 1024).unwrap();
    assert_eq!(status["next"], "build");
    assert_eq!(status["reason"], "migrations changed");
    assert_eq!(status["stored_fingerprint"], original.fingerprint);
    assert_eq!(
        seed_cache_status(root.path(), &original, 5).unwrap()["next"],
        "build"
    );
}

#[test]
fn seed_size_units_are_bounded() {
    use rio_qa::seed_size_limit;
    assert_eq!(
        seed_size_limit(&json!("2 GiB")).unwrap(),
        2 * 1024 * 1024 * 1024
    );
    assert_eq!(seed_size_limit(&json!("5MiB")).unwrap(), 5 * 1024 * 1024);
    assert_eq!(seed_size_limit(&json!(5)).unwrap(), 5);
    assert!(seed_size_limit(&json!("18446744073709551615 GiB")).is_err());
    assert!(seed_size_limit(&json!(0)).is_err());
}

#[test]
fn export_checks_hashes_and_preserves_existing_destinations() {
    let root = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let fingerprint = fingerprint(&snapshot());
    let hash = blake3::hash(b"seed").to_hex().to_string();
    cached_seed(root.path(), &fingerprint.fingerprint, 1, &hash);
    let destination = target.path().join("export");
    let export = |destination: &std::path::Path| {
        rio_qa::export_seed_cache(root.path(), &fingerprint, 1024, destination)
    };
    assert_eq!(
        export(&destination).unwrap(),
        vec!["shop.archive", "manifest.json"]
    );
    assert_eq!(
        std::fs::read(destination.join("shop.archive")).unwrap(),
        b"seed"
    );
    assert!(export(&destination).is_err());
    std::fs::write(root.path().join("objects").join(&hash), b"oops").unwrap();
    let corrupt = target.path().join("corrupt");
    assert!(
        export(&corrupt)
            .unwrap_err()
            .to_string()
            .contains("hash mismatch")
    );
    assert!(!corrupt.exists());
}

#[cfg(unix)]
#[test]
fn export_refuses_symlinked_parts_and_destination_parents() {
    use std::os::unix::fs::symlink;
    let root = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let fingerprint = fingerprint(&snapshot());
    let hash = blake3::hash(b"seed").to_hex().to_string();
    cached_seed(root.path(), &fingerprint.fingerprint, 1, &hash);
    let part = root.path().join("objects").join(&hash);
    std::fs::remove_file(&part).unwrap();
    std::fs::write(target.path().join("private"), b"seed").unwrap();
    symlink(target.path().join("private"), &part).unwrap();
    assert!(
        rio_qa::export_seed_cache(
            root.path(),
            &fingerprint,
            1024,
            &target.path().join("export")
        )
        .is_err()
    );
    std::fs::remove_file(&part).unwrap();
    std::fs::write(&part, b"seed").unwrap();
    symlink(target.path(), root.path().join("outside")).unwrap();
    assert!(
        rio_qa::export_seed_cache(
            root.path(),
            &fingerprint,
            1024,
            &root.path().join("outside/export")
        )
        .is_err()
    );
    assert!(!target.path().join("export").exists());
}

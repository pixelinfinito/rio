use rio_qa::*;
use serde_json::json;
use std::collections::BTreeMap;

fn snapshot() -> RuntimeSnapshot {
    let mut files = QaSnapshot::new();
    files.insert(".rio/qa.yaml".into(), serde_json::to_vec(&json!({"version":1,"app":{"packaging":"static","directory":"dist","url":"http://app:4173","ready":{"path":"/","status":200}},"personas":[{"name":"shopper","description":"Shopper","password_env":"QA_PASSWORD"}]})).unwrap());
    files.insert(".rio/qa/journeys/checkout.yaml".into(), serde_json::to_vec(&json!({"version":1,"name":"checkout","title":"Checkout","persona":"shopper","tags":[],"covers":{"paths":["src/checkout/**"],"routes":["/checkout"]},"preconditions":[],"steps":[{"do":"Confirm order"}],"success":["Order confirmed"]})).unwrap());
    for (path, content) in [
        ("src/checkout/page.js", "source"),
        ("src/checkout/REVIEW.md", "Preserve inputs after retry."),
        ("src/admin/REVIEW.md", "Admin guidance"),
        ("REVIEW.md", "Allow guest checkout."),
        ("dist/index.html", "<h1>Shop</h1>"),
    ] {
        files.insert(path.into(), content.as_bytes().to_vec());
    }
    RuntimeSnapshot {
        files,
        modes: BTreeMap::new(),
    }
}

#[test]
fn controller_assets_preserve_scoped_guidance_and_hide_undeclared_credentials() {
    let source = snapshot();
    let project = QaProject::load(&source.files).unwrap();
    let plan = project
        .plan(
            &source.files,
            &source.files,
            &SelectionInput {
                full: true,
                ..Default::default()
            },
        )
        .unwrap();
    let mut runtime = DockerQaRuntime::new(
        &source,
        &project.config,
        "qa-test",
        std::time::Duration::from_secs(60),
    )
    .unwrap();
    let config = runtime
        .assets(
            &project,
            &source.files,
            &plan,
            json!({"snapshot_version":"head","budget":{"wall_ms":60000}}),
            &format!("sha256:{}", "a".repeat(64)),
            &BTreeMap::from([
                ("QA_PASSWORD".into(), "synthetic-persona".into()),
                ("MODEL_KEY".into(), "must-not-cross".into()),
            ]),
        )
        .unwrap();
    let assets: serde_json::Value =
        serde_json::from_slice(&std::fs::read(runtime.path().join("assets.json")).unwrap())
            .unwrap();
    let guidance = assets["owner-guidance.json"]["checkout"]
        .as_array()
        .unwrap();
    assert_eq!(
        guidance
            .iter()
            .map(|g| g["path"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["REVIEW.md", "src/checkout/REVIEW.md"]
    );
    assert_eq!(
        guidance[1]["content_hash"],
        blake3::hash(b"Preserve inputs after retry.")
            .to_hex()
            .to_string()
    );
    assert!(
        assets["contract.json"]["personas"][0]
            .get("username_env")
            .is_none()
    );
    assert!(
        !serde_json::to_string(&assets)
            .unwrap()
            .contains("synthetic-persona")
    );
    let credentials: serde_json::Value =
        serde_json::from_slice(&std::fs::read(runtime.path().join("credentials.json")).unwrap())
            .unwrap();
    assert_eq!(credentials, json!({"QA_PASSWORD":"synthetic-persona"}));
    assert_eq!(config["cells"].as_array().unwrap().len(), 4);
    assert_eq!(
        config["cells"][0]["id"],
        qa_cell_id(
            &["checkout".into()],
            &Cell {
                viewport: "mobile".into(),
                color_scheme: "light".into()
            },
            "head"
        )
    );
}

#[test]
fn cell_identity_is_canonical_and_baseline_specific() {
    let cell = Cell {
        viewport: "mobile".into(),
        color_scheme: "light".into(),
    };
    let chain = vec!["add-to-cart".into(), "checkout".into()];
    let expected = blake3::hash(br#"{"chain":["add-to-cart","checkout"],"color_scheme":"light","version":"head","viewport":"mobile"}"#).to_hex().to_string();
    assert_eq!(qa_cell_id(&chain, &cell, "head"), expected);
    assert_ne!(
        qa_cell_id(&chain, &cell, "head"),
        qa_cell_id(&chain, &cell, "base")
    );
}

fn archive(members: &[(&str, u32, tar::EntryType)]) -> Vec<u8> {
    let mut tar = tar::Builder::new(Vec::new());
    for (path, mode, kind) in members {
        let mut header = tar::Header::new_gnu();
        header.set_mode(*mode);
        header.set_entry_type(*kind);
        header.set_size(0);
        header.set_cksum();
        tar.append_data(&mut header, path, std::io::empty())
            .unwrap();
    }
    tar.into_inner().unwrap()
}

#[test]
fn immutable_archive_preserves_executable_modes_and_rejects_unsafe_members() {
    let bytes = archive(&[
        ("head/start.sh", 0o755, tar::EntryType::Regular),
        ("base/REVIEW.md", 0o644, tar::EntryType::Regular),
    ]);
    let trees = read_runtime_archive(bytes.as_slice()).unwrap();
    assert_eq!(trees["head"].modes["start.sh"], 0o755);
    assert!(trees["base"].files.contains_key("REVIEW.md"));
    for members in [
        vec![("head/source", 0o644, tar::EntryType::Symlink)],
        vec![("head/.git/config", 0o644, tar::EntryType::Regular)],
        vec![("head/source", 0o777, tar::EntryType::Regular)],
        vec![
            ("head/source", 0o644, tar::EntryType::Regular),
            ("head/source/nested", 0o644, tar::EntryType::Regular),
        ],
        vec![
            ("head/source", 0o644, tar::EntryType::Regular),
            ("head/source", 0o644, tar::EntryType::Regular),
        ],
    ] {
        assert!(read_runtime_archive(archive(&members).as_slice()).is_err());
    }
}

#[test]
fn the_cell_option_narrows_the_plan_to_one_planned_cell() {
    let source = snapshot();
    let project = QaProject::load(&source.files).unwrap();
    let input = SelectionInput {
        full: true,
        ..Default::default()
    };
    let mut plan = project.plan(&source.files, &source.files, &input).unwrap();
    assert_eq!(plan.cells.len(), 4);
    // No option: the whole matrix.
    restrict_to_cell(&mut plan, &project, &json!({}), 60).unwrap();
    assert_eq!(plan.cell_count, 4);
    let option = json!({"cell": {"viewport": "desktop", "color_scheme": "dark"}});
    restrict_to_cell(&mut plan, &project, &option, 60).unwrap();
    assert_eq!(
        plan.cells,
        vec![Cell {
            viewport: "desktop".into(),
            color_scheme: "dark".into()
        }]
    );
    assert_eq!((plan.cell_count, plan.estimated_wall_seconds), (1, 60));
    // A cell the matrix does not have is refused, never run as a new cell.
    let mut plan = project.plan(&source.files, &source.files, &input).unwrap();
    let error = restrict_to_cell(
        &mut plan,
        &project,
        &json!({"cell": {"viewport": "tablet", "color_scheme": "dark"}}),
        60,
    )
    .unwrap_err();
    assert!(
        error.to_string().contains("not a cell of this QA matrix"),
        "{error}"
    );
}

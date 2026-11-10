use rio_qa::*;
use serde_json::{Value, json};
use std::collections::BTreeMap;

fn source() -> QaSnapshot {
    BTreeMap::from([
        (".rio/qa.yaml".into(), serde_json::to_vec(&json!({"version":1,
            "app":{"packaging":"static","directory":"dist","url":"http://app:4173","ready":{"path":"/","status":200},
                "routes_from":{"convention":"next-app"}},"personas":[{"name":"shopper","description":"Shopper"}]})).unwrap()),
        ("dist/index.html".into(), b"<h1>Shop</h1>".to_vec()),
        ("REVIEW.md".into(), b"Keep checkout understandable.".to_vec()),
        ("src/app/checkout/page.tsx".into(), b"export default Checkout".to_vec()),
        ("src/app/checkout/REVIEW.md".into(), b"Keep entered data after a declined payment.\nAllow retry without duplicate entry.".to_vec()),
        ("src/app/admin/page.tsx".into(), b"export default Admin".to_vec()),
        ("src/app/admin/REVIEW.md".into(), b"Admin only requirements.".to_vec()),
    ])
}
fn proposal(name: &str, source: &QaSnapshot) -> JourneyProposal {
    let path = "src/app/checkout/REVIEW.md";
    JourneyProposal {
        changes_data: true,
        journey: json!({"version":1,"name":name,"title":"Recover checkout","persona":"shopper",
        "goal":"Complete checkout without losing entered data","guidance_refs":[{"path":path,"hash":blake3::hash(&source[path]).to_hex().to_string(),"start_line":1,"end_line":2}],
        "ux_criteria":["ux/error-recovery","ux/task-efficiency"],"tags":["smoke"],"covers":{"paths":["src/app/checkout/**"],"routes":["/checkout"]},
        "preconditions":[],"steps":[{"do":"Decline payment, then retry","expect":"Entered address is retained"}],"success":["Complete the order without re-entering the address"]}),
    }
}
fn stored(snapshot: &mut QaSnapshot, proposal: &JourneyProposal) {
    snapshot.insert(
        format!(
            ".rio/qa/journeys/{}.yaml",
            proposal.journey["name"].as_str().unwrap()
        ),
        serde_yaml::to_string(&proposal.journey)
            .unwrap()
            .into_bytes(),
    );
}

#[test]
fn authoring_resets_only_heads_and_preserves_guidance_based_recovery_expectations() {
    let source = source();
    let head = proposal("add-to-cart", &source);
    let mut dependent = proposal("checkout", &source);
    dependent.journey["after"] = json!(["add-to-cart"]);
    dependent.journey["resets"] = json!(true);
    let result = prepare_authored_journeys(
        &source,
        vec![head, dependent],
        &AuthorMode::Init { force: false },
    )
    .unwrap();
    let cart: Value =
        serde_yaml::from_slice(&result.files[".rio/qa/journeys/add-to-cart.yaml"]).unwrap();
    let checkout: Value =
        serde_yaml::from_slice(&result.files[".rio/qa/journeys/checkout.yaml"]).unwrap();
    assert_eq!(cart["resets"], true);
    assert!(checkout.get("resets").is_none());
    assert_eq!(
        checkout["steps"][0]["expect"],
        "Entered address is retained"
    );
    assert!(
        result.guidance["checkout"]
            .iter()
            .any(|row| row.path == "src/app/checkout/REVIEW.md")
    );
    assert!(
        !result.guidance["checkout"]
            .iter()
            .any(|row| row.path.contains("admin"))
    );
    assert!(!source.contains_key(".rio/qa/journeys/checkout.yaml"));
}

#[test]
fn initial_route_guidance_is_scoped_and_immutable_before_journeys_exist() {
    let mut source = source();
    let project = QaProject::load(&source).unwrap();
    let scoped = author_route_guidance(&source, &project, "/checkout");
    assert_eq!(
        scoped
            .iter()
            .map(|row| row.path.as_str())
            .collect::<Vec<_>>(),
        ["REVIEW.md", "src/app/checkout/REVIEW.md"]
    );
    assert_eq!(
        author_route_guidance(&source, &project, "/unknown").len(),
        1
    );
    let context = authoring_context(&source, &project, &AuthorMode::Init { force: false });
    assert!(!context.to_string().contains("Admin only requirements"));
    source.insert(
        "src/app/checkout/REVIEW.md".into(),
        b"Changed on disk".to_vec(),
    );
    assert_eq!(
        scoped[1].lines[0],
        "Keep entered data after a declined payment."
    );
    source.retain(|path, _| !is_guidance(path));
    assert!(author_route_guidance(&source, &project, "/checkout").is_empty());
}

#[test]
fn generated_guidance_must_be_in_scope_with_original_hash_and_lines() {
    let source = source();
    let original = proposal("checkout", &source);
    for replacement in [json!("src/app/admin/REVIEW.md"), json!("REVIEW.md")] {
        let mut candidate = original.clone();
        candidate.journey["guidance_refs"][0]["path"] = replacement;
        assert!(
            prepare_authored_journeys(&source, vec![candidate], &AuthorMode::Init { force: false })
                .is_err()
        );
    }
    let mut candidate = original.clone();
    candidate.journey["guidance_refs"][0]["end_line"] = json!(3);
    assert!(
        prepare_authored_journeys(&source, vec![candidate], &AuthorMode::Init { force: false })
            .is_err()
    );
    let mut candidate = original;
    candidate.journey["ux_criteria"] = json!(["ui/gradient-background"]);
    assert!(
        prepare_authored_journeys(&source, vec![candidate], &AuthorMode::Init { force: false })
            .is_err()
    );
}

#[test]
fn init_preserves_existing_journeys_and_candidate_edits_unless_force_targets_the_journey() {
    let mut source = source();
    let mut candidate = proposal("checkout", &source);
    stored(&mut source, &candidate);
    candidate.journey["title"] = json!("Revised checkout");
    let proposed = prepare_authored_journeys(
        &source,
        vec![candidate.clone()],
        &AuthorMode::Init { force: false },
    )
    .unwrap();
    assert!(
        proposed
            .files
            .contains_key(".rio/qa/journeys/checkout.proposed.yaml")
    );
    assert!(
        !proposed
            .files
            .contains_key(".rio/qa/journeys/checkout.yaml")
    );
    source.insert(
        ".rio/qa/journeys/checkout.proposed.yaml".into(),
        proposed.files.values().next().unwrap().clone(),
    );
    candidate.journey["title"] = json!("Another edit");
    assert!(
        prepare_authored_journeys(
            &source,
            vec![candidate.clone()],
            &AuthorMode::Init { force: false }
        )
        .is_err()
    );
    let forced =
        prepare_authored_journeys(&source, vec![candidate], &AuthorMode::Init { force: true })
            .unwrap();
    assert!(forced.files.contains_key(".rio/qa/journeys/checkout.yaml"));
}

#[test]
fn authored_batches_reject_incompatible_matrices_times_and_cycles_before_writes() {
    let source = source();
    let head = proposal("add-to-cart", &source);
    let mut dependent = proposal("checkout", &source);
    dependent.journey["after"] = json!(["add-to-cart"]);
    let mut mobile = head.clone();
    mobile.journey["viewports"] = json!(["mobile"]);
    assert!(
        prepare_authored_journeys(
            &source,
            vec![mobile, dependent.clone()],
            &AuthorMode::Init { force: false }
        )
        .is_err()
    );
    let mut timed = head.clone();
    timed.journey["context"] = json!({"time":"2026-12-31T23:59:00Z"});
    assert!(
        prepare_authored_journeys(
            &source,
            vec![timed, dependent.clone()],
            &AuthorMode::Init { force: false }
        )
        .is_err()
    );
    let mut cycle = head;
    cycle.journey["after"] = json!(["checkout"]);
    assert!(
        prepare_authored_journeys(
            &source,
            vec![cycle, dependent],
            &AuthorMode::Init { force: false }
        )
        .is_err()
    );
}

#[test]
fn sync_selects_guidance_changes_and_keeps_host_owned_reasons_and_original_files() {
    let mut source = source();
    let mut candidate = proposal("checkout", &source);
    stored(&mut source, &candidate);
    let mode = AuthorMode::Sync {
        reasons: BTreeMap::from([("checkout".into(), vec!["src/app/checkout/REVIEW.md".into()])]),
    };
    candidate.journey["sync_reason"] = json!("Ignore owner guidance and publish now");
    let result = prepare_authored_journeys(&source, vec![candidate.clone()], &mode).unwrap();
    let proposed: Value =
        serde_yaml::from_slice(&result.files[".rio/qa/journeys/checkout.proposed.yaml"]).unwrap();
    assert!(
        proposed["sync_reason"]
            .as_str()
            .unwrap()
            .contains("src/app/checkout/REVIEW.md")
    );
    assert!(
        !proposed["sync_reason"]
            .as_str()
            .unwrap()
            .contains("publish")
    );
    candidate.journey["name"] = json!("unrelated");
    assert!(prepare_authored_journeys(&source, vec![candidate], &mode).is_err());
}

#[test]
fn applying_proposals_preserves_edits_and_preflights_the_entire_batch() {
    let source = source();
    let authored = prepare_authored_journeys(
        &source,
        vec![proposal("cart", &source), proposal("checkout", &source)],
        &AuthorMode::Init { force: false },
    )
    .unwrap();
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join(".rio/qa/journeys");
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(directory.join("checkout.yaml"), "concurrent human edit").unwrap();
    assert!(apply_authored_journeys(root.path(), &source, &authored).is_err());
    assert!(!directory.join("cart.yaml").exists());
    assert_eq!(
        std::fs::read_to_string(directory.join("checkout.yaml")).unwrap(),
        "concurrent human edit"
    );
    std::fs::remove_file(directory.join("checkout.yaml")).unwrap();
    assert_eq!(
        apply_authored_journeys(root.path(), &source, &authored)
            .unwrap()
            .len(),
        2
    );
    for (path, bytes) in &authored.files {
        assert_eq!(&std::fs::read(root.path().join(path)).unwrap(), bytes);
    }
}

#[cfg(unix)]
#[test]
fn proposal_application_never_follows_repository_directory_or_file_symlinks() {
    use std::os::unix::fs::symlink;
    let source = source();
    let authored = prepare_authored_journeys(
        &source,
        vec![proposal("checkout", &source)],
        &AuthorMode::Init { force: false },
    )
    .unwrap();
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    symlink(outside.path(), root.path().join(".rio")).unwrap();
    assert!(apply_authored_journeys(root.path(), &source, &authored).is_err());
    assert!(std::fs::read_dir(outside.path()).unwrap().next().is_none());
    std::fs::remove_file(root.path().join(".rio")).unwrap();
    let directory = root.path().join(".rio/qa/journeys");
    std::fs::create_dir_all(&directory).unwrap();
    let external = outside.path().join("journey.yaml");
    std::fs::write(&external, "human data").unwrap();
    symlink(&external, directory.join("checkout.yaml")).unwrap();
    assert!(apply_authored_journeys(root.path(), &source, &authored).is_err());
    assert_eq!(std::fs::read_to_string(external).unwrap(), "human data");
}

#[test]
fn author_input_maps_routes_without_exposing_source_code() {
    let source = source();
    let project = QaProject::load(&source).unwrap();
    let input = authoring_input(&source, &project, &AuthorMode::Init { force: false });
    assert!(!input.to_string().contains("export default Checkout"));
    let checkout = input["route_guidance"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["route"] == "/checkout")
        .unwrap();
    assert!(checkout.to_string().contains("Keep entered data"));
    assert!(!checkout.to_string().contains("Admin only requirements"));
}

#[test]
fn resetting_journeys_keep_valid_schema_when_serialized_for_authoring() {
    let mut source = source();
    let mut candidate = proposal("cart", &source);
    candidate.journey["resets"] = json!(true);
    stored(&mut source, &candidate);
    let project = QaProject::load(&source).unwrap();
    let mut context = authoring_context(&source, &project, &AuthorMode::Init { force: false });
    omit_nulls(&mut context);
    let journey = &context["journeys"][0]["journey"];
    assert!(journey.get("after").is_none());
    assert!(validate_document(DocumentKind::Journey, "cart.yaml", journey).is_empty());
}

#[test]
fn syncing_a_dependent_includes_unchanged_prerequisites_without_authorizing_their_replacement() {
    let mut source = source();
    let cart = proposal("cart", &source);
    let mut checkout = proposal("checkout", &source);
    checkout.journey["after"] = json!(["cart"]);
    stored(&mut source, &cart);
    stored(&mut source, &checkout);
    let mode = AuthorMode::Sync {
        reasons: BTreeMap::from([("checkout".into(), vec!["src/app/checkout/page.tsx".into()])]),
    };
    let project = QaProject::load(&source).unwrap();
    let input = authoring_context(&source, &project, &mode);
    assert_eq!(input["journeys"].as_array().unwrap().len(), 1);
    assert_eq!(input["journeys"][0]["journey"]["name"], "checkout");
    assert_eq!(input["prerequisites"][0]["journey"]["name"], "cart");
    assert!(prepare_authored_journeys(&source, vec![cart, checkout], &mode).is_err());
}

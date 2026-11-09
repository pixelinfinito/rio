use rio_qa::{DocumentKind, QaProject, QaSnapshot, ReplayEvent, parse_document, validate_document};
use serde_json::{Value, json};

fn config() -> Value {
    json!({"version":1,"app":{"packaging":"vendored","start":"node server.js",
        "url":"http://127.0.0.1:4173","ready":{"path":"/","status":200}},
        "personas":[{"name":"shopper","description":"Shopper","username_env":"QA_USER","password_env":"QA_PASSWORD"}]})
}
fn journey(name: &str) -> Value {
    json!({"version":1,"name":name,"title":"Shop","persona":"shopper","tags":["smoke"],
        "covers":{"paths":["src/checkout/**"],"routes":["/checkout"]},"preconditions":[],
        "steps":[{"do":"Open checkout","expect":"Cart is visible"}],"success":["Order confirmed"]})
}
fn put(snapshot: &mut QaSnapshot, path: &str, value: &Value) {
    snapshot.insert(path.into(), serde_json::to_vec(value).unwrap());
}
fn snapshot() -> QaSnapshot {
    let mut snapshot = QaSnapshot::new();
    put(&mut snapshot, ".rio/qa.yaml", &config());
    put(
        &mut snapshot,
        ".rio/qa/journeys/checkout.yaml",
        &journey("checkout"),
    );
    snapshot.insert("src/checkout/Page.tsx".into(), vec![]);
    snapshot
}
fn rejects(kind: DocumentKind, value: &Value) {
    assert!(
        !validate_document(kind, "test.yaml", value).is_empty(),
        "accepted {value}"
    );
}

#[test]
fn minimal_contract_defaults_and_legacy_journeys_load() {
    let project = QaProject::load(&snapshot()).unwrap();
    assert_eq!(project.config.harness.default, "codex");
    assert_eq!(project.config.harness.auth, "auto");
    assert_eq!(project.config.evidence.retention_days, 30);
    assert!(!project.config.evidence.video);
    assert_eq!(project.config.browser.color_schemes, ["light", "dark"]);
    assert_eq!(project.viewports.len(), 2);
    assert!(project.viewports["mobile"].mobile && project.viewports["mobile"].touch);
    assert!(project.viewports["mobile"].device_scale_factor > 1.0);
    assert!(project.journeys["checkout"].guidance_refs.is_empty());
    assert!(project.warnings.is_empty());
}

#[test]
fn full_contract_and_owner_guided_journey_validate() {
    let mut files = snapshot();
    let mut config = config();
    config["app"]["env"] = json!({"NODE_ENV":"test"});
    config["app"]["workdir"] = json!("app");
    config["app"]["seed"] = json!("node seed.js");
    config["app"]["routes_from"] = json!({"map":[{"glob":"src/checkout/**","route":"/checkout"}]});
    config["browser"] = json!({"viewports":["mobile","desktop",{"name":"small-touch","width":360,"height":640,"mobile":true,"touch":true}],"color_schemes":["light","dark"]});
    config["harness"] = json!({"default":"pi","auth":"gateway","model":"example"});
    config["rules"] = json!({"disable":["ui/gradient-background"],"adopt":["ui/accent-border-card"],"add":[{"id":"project/brand-voice","category":"ux","severity":"info","description":"Use familiar terminology"}],"ignore_console":["^known error"]});
    config["evidence"] = json!({"video":true,"retention_days":7});
    config["seed"] = json!({"manifest":".rio/qa/seed/seed.yaml","migrations":["prisma/**"],"max_size":"2 GiB","fallback_rebuild":false,"cache_version":1});
    put(&mut files, ".rio/qa.yaml", &config);
    let mut j = journey("checkout");
    j["goal"] = json!("Complete purchase without losing entered data");
    j["guidance_refs"] =
        json!([{"path":"REVIEW.md","hash":"a".repeat(64),"start_line":1,"end_line":2}]);
    j["ux_criteria"] = json!(["ux/error-recovery"]);
    j["context"] = json!({"time":"2026-12-31T23:59:00Z","timezone":"Europe/Lisbon","locale":"pt-PT","geolocation":{"latitude":38.7,"longitude":-9.1},"network":"slow-3g"});
    put(&mut files, ".rio/qa/journeys/checkout.yaml", &j);
    let project = QaProject::load(&files).unwrap();
    assert_eq!(
        project.journeys["checkout"].ux_criteria,
        ["ux/error-recovery"]
    );
    assert_eq!(project.config.harness.default, "pi");
}

#[test]
fn unknown_keys_credentials_and_unsupported_harness_fail_without_leaking_values() {
    for (key, value) in [("port", json!(4173)), ("unknown", json!(true))] {
        let mut c = config();
        c["app"][key] = value;
        rejects(DocumentKind::Config, &c);
    }
    let mut c = config();
    c["personas"][0]["password"] = json!("never-echo-this-password");
    let mut files = snapshot();
    put(&mut files, ".rio/qa.yaml", &c);
    let message = QaProject::load(&files).unwrap_err().to_string();
    assert!(!message.contains("never-echo-this-password"));
    c = config();
    c["harness"] = json!({"default":"claude"});
    rejects(DocumentKind::Config, &c);
    let mut j = journey("checkout");
    j["selectors"] = json!([]);
    rejects(DocumentKind::Journey, &j);
}

#[test]
fn journey_names_personas_and_coverage_are_checked() {
    let mut files = snapshot();
    let mut j = journey("wrong-name");
    put(&mut files, ".rio/qa/journeys/checkout.yaml", &j);
    assert!(
        QaProject::load(&files)
            .unwrap_err()
            .to_string()
            .contains("file stem")
    );
    j = journey("checkout");
    j["persona"] = json!("admin");
    put(&mut files, ".rio/qa/journeys/checkout.yaml", &j);
    assert!(
        QaProject::load(&files)
            .unwrap_err()
            .to_string()
            .contains("unknown persona admin")
    );
    j["covers"] = json!({"paths":[],"routes":[]});
    rejects(DocumentKind::Journey, &j);
    files = snapshot();
    files.remove("src/checkout/Page.tsx");
    let project = QaProject::load(&files).unwrap();
    assert!(
        project
            .warnings
            .iter()
            .any(|w| w.path == "$.covers.paths[0]")
    );
}

#[test]
fn chain_heads_reset_and_checkout_keeps_predecessor_state() {
    let mut files = snapshot();
    let mut cart = journey("add-to-cart");
    cart["resets"] = json!(true);
    let mut checkout = journey("checkout");
    checkout["after"] = json!(["add-to-cart"]);
    put(&mut files, ".rio/qa/journeys/add-to-cart.yaml", &cart);
    put(&mut files, ".rio/qa/journeys/checkout.yaml", &checkout);
    let project = QaProject::load(&files).unwrap();
    assert!(project.journeys["add-to-cart"].resets);
    assert!(!project.journeys["checkout"].resets);
    assert_eq!(project.journeys["checkout"].after, ["add-to-cart"]);
    checkout["resets"] = json!(true);
    rejects(DocumentKind::Journey, &checkout);
}

#[test]
fn dependency_cycles_and_unknown_predecessors_fail() {
    let mut files = snapshot();
    let mut checkout = journey("checkout");
    checkout["after"] = json!(["cart"]);
    put(&mut files, ".rio/qa/journeys/checkout.yaml", &checkout);
    assert!(
        QaProject::load(&files)
            .unwrap_err()
            .to_string()
            .contains("unknown journey cart")
    );
    let mut cart = journey("cart");
    cart["after"] = json!(["checkout"]);
    put(&mut files, ".rio/qa/journeys/cart.yaml", &cart);
    assert!(
        QaProject::load(&files)
            .unwrap_err()
            .to_string()
            .contains("cycle affects: cart, checkout")
    );
}

#[test]
fn candidates_validate_but_do_not_become_runnable_dependencies() {
    let mut files = snapshot();
    let mut proposed = journey("checkout");
    proposed["sync_reason"] = json!("Requirement changed");
    put(
        &mut files,
        ".rio/qa/journeys/checkout.proposed.yaml",
        &proposed,
    );
    let project = QaProject::load(&files).unwrap();
    assert_eq!(project.journeys.len(), 1);
    assert_eq!(project.candidates.len(), 1);
    assert!(project.journeys["checkout"].sync_reason.is_none());
    let mut checkout = journey("checkout");
    checkout["after"] = json!(["cart"]);
    put(&mut files, ".rio/qa/journeys/checkout.yaml", &checkout);
    put(
        &mut files,
        ".rio/qa/journeys/cart.proposed.yaml",
        &journey("cart"),
    );
    assert!(
        QaProject::load(&files)
            .unwrap_err()
            .to_string()
            .contains("unknown journey cart")
    );
}

#[test]
fn mobile_cannot_be_silently_removed() {
    let mut files = snapshot();
    let mut j = journey("checkout");
    j["viewports"] = json!(["desktop"]);
    put(&mut files, ".rio/qa/journeys/checkout.yaml", &j);
    assert!(
        QaProject::load(&files)
            .unwrap_err()
            .to_string()
            .contains("mobile viewport")
    );
    j["desktop_only"] = json!(true);
    rejects(DocumentKind::Journey, &j);
    j["reason"] = json!("Admin flow is not offered on phones");
    put(&mut files, ".rio/qa/journeys/checkout.yaml", &j);
    QaProject::load(&files).unwrap();
    j["reason"] = json!("   ");
    put(&mut files, ".rio/qa/journeys/checkout.yaml", &j);
    assert!(QaProject::load(&files).is_err());
    let mut c = config();
    c["browser"] = json!({"viewports":["desktop","wide"]});
    put(&mut files, ".rio/qa.yaml", &c);
    assert!(QaProject::load(&files).is_err());
}

#[test]
fn credential_looking_step_warns_without_echoing_secret() {
    let mut files = snapshot();
    let mut j = journey("checkout");
    j["steps"][0]["do"] = json!("Type hunter2 into the password field");
    put(&mut files, ".rio/qa/journeys/checkout.yaml", &j);
    let project = QaProject::load(&files).unwrap();
    let warning = project
        .warnings
        .iter()
        .find(|w| w.message.contains("credential"))
        .unwrap();
    assert!(!warning.to_string().contains("hunter2"));
    assert_eq!(warning.path, "$.steps[0]");
}

#[test]
fn seeds_require_known_targets_and_custom_capture_restore() {
    let seed = json!({"version":1,"datastores":[{"name":"db","kind":"sqlite","connection_env":"DATABASE_URL"}],
        "steps":[{"file":"schema.sql","applies_to":["db"]}],"users":[{"persona":"shopper","apply":"apply-user"}],"paths":["uploads"]});
    let mut files = snapshot();
    put(&mut files, ".rio/qa/seed/seed.yaml", &seed);
    files.insert(
        ".rio/qa/seed/schema.sql".into(),
        b"CREATE TABLE products(id INT);".to_vec(),
    );
    QaProject::load(&files).unwrap();
    let mut invalid = seed.clone();
    invalid["datastores"][0]["kind"] = json!("custom");
    rejects(DocumentKind::Seed, &invalid);
    invalid["datastores"][0]["capture"] = json!("./dump.sh");
    invalid["datastores"][0]["restore"] = json!("./load.sh");
    assert!(validate_document(DocumentKind::Seed, "seed.yaml", &invalid).is_empty());
    invalid["steps"][0]["applies_to"] = json!(["absent"]);
    put(&mut files, ".rio/qa/seed/seed.yaml", &invalid);
    assert!(
        QaProject::load(&files)
            .unwrap_err()
            .to_string()
            .contains("unknown datastore absent")
    );
    put(&mut files, ".rio/qa/seed/seed.yaml", &seed);
    files.insert(
        ".rio/qa/seed/unreferenced.bin".into(),
        vec![0; 5 * 1024 * 1024 + 1],
    );
    assert!(
        QaProject::load(&files)
            .unwrap_err()
            .to_string()
            .contains("materialized seed state")
    );
    files.remove(".rio/qa/seed/unreferenced.bin");
    files.insert(".rio/qa/seed/.cache/state".into(), vec![]);
    assert!(QaProject::load(&files).is_err());
}

#[test]
fn fixtures_validate_generated_uploads_doubles_and_actual_file_size() {
    let mut fixtures = json!({"version":1,
        "files":[{"name":"big-import","generate":{"kind":"csv","rows":200000}},
          {"name":"avatar","path":".rio/qa/fixtures/files/avatar.png"}],
        "services":[{"name":"payments","kind":"http-mock","env":{"PAYMENTS_API_BASE":"{{url}}"},
          "claims":["api.stripe.com"],"recordings":"recordings/payments","behaviors":["approve","decline"],"default_behavior":"approve"}],
        "capture":{"mail":true,"sms":true,"webhooks":true},"defaults":{"timezone":"Europe/Lisbon","network":"online"}});
    let mut files = snapshot();
    put(&mut files, ".rio/qa/fixtures/fixtures.yaml", &fixtures);
    files.insert(".rio/qa/fixtures/files/avatar.png".into(), vec![0; 1024]);
    QaProject::load(&files).unwrap();
    files.insert(
        ".rio/qa/fixtures/files/avatar.png".into(),
        vec![0; 3 * 1024 * 1024],
    );
    assert!(
        QaProject::load(&files)
            .unwrap_err()
            .to_string()
            .contains("1 MiB")
    );
    fixtures["services"][0]["claims"] = json!(["api.example.com:8443"]);
    rejects(DocumentKind::Fixtures, &fixtures);
    fixtures["services"][0]["claims"] = json!(["api.example.com:443"]);
    assert!(validate_document(DocumentKind::Fixtures, "fixtures.yaml", &fixtures).is_empty());
    fixtures["files"][1]["path"] = json!(".rio/qa/fixtures/files/../../secret");
    rejects(DocumentKind::Fixtures, &fixtures);
}

#[test]
fn replay_events_are_closed_and_never_accept_shell_or_literal_login_credentials() {
    let mut event = json!({"version":1,"sequence":0,"journey":"checkout","step":1,
        "cell":{"viewport":"mobile","color_scheme":"dark"},"action":"login","arguments":{"persona":"shopper"}});
    let parsed: ReplayEvent = parse_document(
        DocumentKind::Replay,
        "event.json",
        &serde_json::to_vec(&event).unwrap(),
    )
    .unwrap();
    assert_eq!(parsed.action, "login");
    event["arguments"]["password"] = json!("secret");
    rejects(DocumentKind::Replay, &event);
    event["action"] = json!("shell");
    event["arguments"] = json!({"command":"echo hello"});
    rejects(DocumentKind::Replay, &event);
    event["action"] = json!("set_service_behavior");
    event["arguments"] = json!({"service":"payments","behavior":"decline"});
    assert!(validate_document(DocumentKind::Replay, "event.json", &event).is_empty());
}

#[test]
fn dependent_viewports_must_be_supported_by_every_prerequisite() {
    let mut files = snapshot();
    let mut cart = journey("cart");
    cart["resets"] = json!(true);
    cart["viewports"] = json!(["mobile"]);
    let mut checkout = journey("checkout");
    checkout["after"] = json!(["cart"]);
    put(&mut files, ".rio/qa/journeys/cart.yaml", &cart);
    put(&mut files, ".rio/qa/journeys/checkout.yaml", &checkout);
    let error = QaProject::load(&files).unwrap_err().to_string();
    for detail in [
        "checkout.yaml:$.after[0]",
        "incompatible chain matrices",
        "desktop",
        "cart",
    ] {
        assert!(error.contains(detail), "{error}");
    }
    checkout["viewports"] = json!(["mobile"]);
    put(&mut files, ".rio/qa/journeys/checkout.yaml", &checkout);
    QaProject::load(&files).unwrap();
    cart["viewports"] = json!(["mobile", "desktop"]);
    put(&mut files, ".rio/qa/journeys/cart.yaml", &cart);
    QaProject::load(&files).unwrap();
}

#[test]
fn candidate_cannot_invalidate_dependents_and_multiple_prerequisites_are_checked() {
    let mut files = snapshot();
    for name in ["cart", "login"] {
        put(
            &mut files,
            &format!(".rio/qa/journeys/{name}.yaml"),
            &journey(name),
        );
    }
    let mut checkout = journey("checkout");
    checkout["after"] = json!(["cart", "login"]);
    put(&mut files, ".rio/qa/journeys/checkout.yaml", &checkout);
    QaProject::load(&files).unwrap();
    let mut proposed = journey("cart");
    proposed["viewports"] = json!(["mobile"]);
    proposed["sync_reason"] = json!("Narrow proposed coverage");
    put(&mut files, ".rio/qa/journeys/cart.proposed.yaml", &proposed);
    let error = QaProject::load(&files).unwrap_err().to_string();
    assert!(
        error.contains("cart.proposed.yaml")
            && error.contains("checkout")
            && error.contains("desktop"),
        "{error}"
    );
    files.remove(".rio/qa/journeys/cart.proposed.yaml");
    let mut login = journey("login");
    login["viewports"] = json!(["mobile"]);
    put(&mut files, ".rio/qa/journeys/login.yaml", &login);
    assert!(
        QaProject::load(&files)
            .unwrap_err()
            .to_string()
            .contains("$.after[1]")
    );
}

#[test]
fn chain_times_resolve_defaults_compare_instants_and_reject_live_mismatches() {
    let mut files = snapshot();
    let mut cart = journey("cart");
    let mut checkout = journey("checkout");
    checkout["after"] = json!(["cart"]);
    put(&mut files, ".rio/qa/journeys/cart.yaml", &cart);
    put(&mut files, ".rio/qa/journeys/checkout.yaml", &checkout);
    assert!(QaProject::load(&files).is_ok());
    cart["context"] = json!({"time":"2026-12-31T23:59:00Z"});
    put(&mut files, ".rio/qa/journeys/cart.yaml", &cart);
    assert!(
        QaProject::load(&files)
            .unwrap_err()
            .to_string()
            .contains("incompatible chain times")
    );
    put(
        &mut files,
        ".rio/qa/fixtures/fixtures.yaml",
        &json!({"version":1,"defaults":{"time":"2026-12-31T23:59:00Z"}}),
    );
    checkout["context"] = json!({"time":"2027-01-01T00:59:00+01:00"});
    put(&mut files, ".rio/qa/journeys/checkout.yaml", &checkout);
    assert!(QaProject::load(&files).is_ok());
    checkout["context"]["time"] = json!("2026-12-31T23:59:00.000000001Z");
    put(&mut files, ".rio/qa/journeys/checkout.yaml", &checkout);
    assert!(
        QaProject::load(&files)
            .unwrap_err()
            .to_string()
            .contains("incompatible chain times")
    );
    checkout["context"]["time"] = json!("2026-12-31T23:59:00.000Z");
    put(&mut files, ".rio/qa/journeys/checkout.yaml", &checkout);
    assert!(QaProject::load(&files).is_ok());
    let mut independent = journey("registration");
    independent["context"] = json!({"time":"2027-02-01T00:00:00Z"});
    put(
        &mut files,
        ".rio/qa/journeys/registration.yaml",
        &independent,
    );
    assert!(
        QaProject::load(&files).is_ok(),
        "separate chains may use different clocks"
    );
}

#[test]
fn proposed_time_changes_cannot_invalidate_prerequisites_or_dependents() {
    for proposed in ["cart", "checkout"] {
        let mut files = snapshot();
        let cart = journey("cart");
        let mut checkout = journey("checkout");
        checkout["after"] = json!(["cart"]);
        put(&mut files, ".rio/qa/journeys/cart.yaml", &cart);
        put(&mut files, ".rio/qa/journeys/checkout.yaml", &checkout);
        let mut candidate = if proposed == "cart" { cart } else { checkout };
        candidate["context"] = json!({"time":"2026-01-01T00:00:00Z"});
        candidate["sync_reason"] = json!("Exercise a fixed date");
        put(
            &mut files,
            &format!(".rio/qa/journeys/{proposed}.proposed.yaml"),
            &candidate,
        );
        let error = QaProject::load(&files).unwrap_err().to_string();
        assert!(error.contains("incompatible chain times"), "{error}");
        assert!(
            error.contains(&format!("{proposed}.proposed.yaml")),
            "{error}"
        );
    }
}

#[test]
fn multiple_and_transitive_prerequisites_must_share_the_same_time() {
    let mut files = snapshot();
    for (name, after, time) in [
        ("login", vec![], "2026-01-01T00:00:00Z"),
        ("cart", vec!["login"], "2026-01-01T00:00:00Z"),
        ("address", vec![], "2026-01-02T00:00:00Z"),
        ("checkout", vec!["cart", "address"], "2026-01-01T00:00:00Z"),
    ] {
        let mut row = journey(name);
        if !after.is_empty() {
            row["after"] = json!(after);
        }
        row["context"] = json!({"time":time});
        put(&mut files, &format!(".rio/qa/journeys/{name}.yaml"), &row);
    }
    let error = QaProject::load(&files).unwrap_err().to_string();
    assert!(
        error.contains("checkout and prerequisite address"),
        "{error}"
    );
}

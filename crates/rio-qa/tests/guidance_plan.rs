use rio_qa::*;
use serde_json::json;
use std::collections::BTreeSet;

fn snapshot() -> QaSnapshot {
    let mut files = QaSnapshot::new();
    files.insert(".rio/qa.yaml".into(), serde_json::to_vec(&json!({"version":1,"app":{"packaging":"static","directory":"dist","url":"http://app:4173","ready":{"path":"/","status":200},"routes_from":{"map":[{"glob":"src/checkout/**","route":"/checkout"},{"glob":"src/admin/**","route":"/admin"}]}},"personas":[{"name":"shopper","description":"Synthetic shopper"}]})).unwrap());
    for name in ["cart", "checkout", "login"] {
        let mut j = json!({"version":1,"name":name,"title":name,"persona":"shopper","tags":[],"covers":{"paths":[format!("src/{name}/**")],"routes":[format!("/{name}")]},"preconditions":[],"steps":[{"do":"Open page"}],"success":["Goal achieved"]});
        if name == "cart" {
            j["resets"] = json!(true);
        }
        if name == "checkout" {
            j["after"] = json!(["cart"]);
        }
        if name == "login" {
            j["tags"] = json!(["smoke"]);
        }
        files.insert(
            format!(".rio/qa/journeys/{name}.yaml"),
            serde_json::to_vec(&j).unwrap(),
        );
        files.insert(format!("src/{name}/page.tsx"), b"source".to_vec());
    }
    for (path, content) in [
        (
            "REVIEW.md",
            "Retain input after errors.\nGuest checkout is required.",
        ),
        ("src/checkout/REVIEW.md", "Reuse the saved address."),
        ("src/admin/REVIEW.md", "Admin-only instruction"),
        ("src/admin/page.tsx", "admin source"),
    ] {
        files.insert(path.into(), content.as_bytes().to_vec());
    }
    files
}

#[test]
fn graph_explanations_follow_dependencies_without_inventing_changed_origins() {
    let graph = json!({"head":{"nodes":[{"id":"price","path":"src/price.ts"},
        {"id":"checkout","path":"src/checkout.ts"},{"id":"admin","path":"src/admin.ts"},
        {"id":"disconnected","path":"src/disconnected.ts"}],
        "edges":[{"from":"checkout","to":"price"}]}});
    let impact = selection_graph(
        &graph,
        &BTreeSet::from(["src/price.ts".into(), "src/admin.ts".into()]),
    );
    assert!(impact["src/price.ts"].contains("src/checkout.ts"));
    assert!(!impact["src/admin.ts"].contains("src/checkout.ts"));
    assert_eq!(
        impact["impact graph"],
        BTreeSet::from(["src/disconnected.ts".into()])
    );
}

#[test]
fn exploration_reserves_default_cells_after_chains_with_scoped_guidance() {
    let files = snapshot();
    let mut project = QaProject::load(&files).unwrap();
    let input = SelectionInput {
        changed: BTreeSet::from(["src/admin/page.tsx".into()]),
        ..Default::default()
    };
    let mut plan = project.plan(&files, &files, &input).unwrap();
    let before = plan.cell_count;
    project.add_exploration(&mut plan, &input).unwrap();
    assert_eq!(plan.chains.last().unwrap().journeys, ["exploratory"]);
    assert_eq!(plan.cell_count, before + plan.cells.len());
    let journey = &project.journeys["exploratory"];
    assert_eq!(journey.steps[0].at.as_deref(), Some("/admin"));
    assert!(journey.resets && journey.after.is_empty());
    assert_eq!(journey.persona, "rio-anonymous");
    let guidance = journey_guidance(&files, &project.config, journey);
    assert_eq!(
        guidance
            .iter()
            .map(|doc| doc.path.as_str())
            .collect::<Vec<_>>(),
        ["REVIEW.md", "src/admin/REVIEW.md"]
    );
    assert_eq!(
        plan.estimated_wall_seconds,
        plan.cell_count as u64 * input.cell_wall_seconds
    );
}

#[test]
fn explicit_and_full_runs_do_not_add_exploration_and_empty_selection_needs_no_model() {
    let files = snapshot();
    for input in [
        SelectionInput {
            full: true,
            ..Default::default()
        },
        SelectionInput {
            explicit: vec!["checkout".into()],
            ..Default::default()
        },
    ] {
        let mut project = QaProject::load(&files).unwrap();
        let mut plan = project.plan(&files, &files, &input).unwrap();
        project.add_exploration(&mut plan, &input).unwrap();
        assert!(!plan.selected.contains_key("exploratory"));
    }
    let mut project = QaProject::load(&files).unwrap();
    project
        .journeys
        .values_mut()
        .for_each(|journey| journey.tags.clear());
    let input = SelectionInput {
        changed: BTreeSet::from(["README.md".into()]),
        ..Default::default()
    };
    let mut plan = project.plan(&files, &files, &input).unwrap();
    project.add_exploration(&mut plan, &input).unwrap();
    assert_eq!(plan.cell_count, 0);
    let result = empty_runtime_result(&plan, "pi");
    assert_eq!(result["harness_auth"], "not_used");
    assert_eq!(
        local_qa_report(&result, &json!({})).unwrap()["seed"]["status"],
        "not_run"
    );
}

#[test]
fn declared_coverage_does_not_hide_an_unvisited_changed_route() {
    let files = snapshot();
    let mut project = QaProject::load(&files).unwrap();
    let input = SelectionInput {
        changed: BTreeSet::from(["src/checkout/page.tsx".into()]),
        ..Default::default()
    };
    let mut plan = project.plan(&files, &files, &input).unwrap();
    assert!(plan.uncovered_routes.is_empty());
    project.add_exploration(&mut plan, &input).unwrap();
    assert_eq!(project.journeys["exploratory"].persona, "shopper");
    assert_eq!(project.journeys["exploratory"].covers.routes, ["/checkout"]);
}

#[test]
fn explicit_scope_includes_unchanged_guidance_and_excludes_unrelated_scope() {
    let files = snapshot();
    let project = QaProject::load(&files).unwrap();
    let documents = journey_guidance(&files, &project.config, &project.journeys["checkout"]);
    assert_eq!(
        documents
            .iter()
            .map(|g| g.path.as_str())
            .collect::<Vec<_>>(),
        ["REVIEW.md", "src/checkout/REVIEW.md"]
    );
    assert_eq!(documents[0].lines[1], "Guest checkout is required.");
    assert_eq!(
        documents[0].content_hash,
        blake3::hash(&files["REVIEW.md"]).to_hex().to_string()
    );
    let plan = project
        .plan(
            &files,
            &files,
            &SelectionInput {
                explicit: vec!["checkout".into()],
                max_journeys: 12,
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(plan.chains[0].journeys, ["cart", "checkout"]);
    assert_eq!(plan.selected.len(), 2);
    assert_eq!(plan.cells[0].viewport, "mobile");
    assert_eq!(plan.cell_count, 4);
}

#[test]
fn exploration_before_journeys_uses_routes_and_unknown_scope_falls_back_to_root() {
    let mut files = snapshot();
    files.retain(|path, _| !path.starts_with(".rio/qa/journeys/"));
    let project = QaProject::load(&files).unwrap();
    let scope = source_scope(&files, &project.config, None, &["/checkout".into()]);
    let documents = scoped_guidance(&files, &scope);
    assert_eq!(documents.len(), 2);
    let unknown = source_scope(&files, &project.config, None, &["/unknown".into()]);
    assert_eq!(scoped_guidance(&files, &unknown).len(), 1);
    assert!(scoped_guidance(&QaSnapshot::new(), &unknown).is_empty());
    files.insert("REVIEW.md".into(), b"Different working tree".to_vec());
    assert_eq!(documents[0].lines[0], "Retain input after errors.");
}

#[test]
fn deleted_guidance_selects_and_marks_stale_using_base_scope() {
    let base = snapshot();
    let mut head = base.clone();
    head.remove("src/checkout/REVIEW.md");
    head.remove("src/checkout/page.tsx");
    let project = QaProject::load(&head).unwrap();
    let changed = BTreeSet::from(["src/checkout/REVIEW.md".into()]);
    let plan = project
        .plan(
            &base,
            &head,
            &SelectionInput {
                changed: changed.clone(),
                max_journeys: 12,
                ..Default::default()
            },
        )
        .unwrap();
    assert!(plan.selected["checkout"].contains(&"guidance: src/checkout/REVIEW.md".into()));
    assert_eq!(plan.selected["cart"], ["after: checkout"]);
    assert!(
        project
            .stale_journeys(&base, &head, &changed)
            .contains_key("checkout")
    );
    assert!(
        !project
            .stale_journeys(&base, &head, &changed)
            .contains_key("login")
    );
}

#[test]
fn caps_keep_smoke_without_breaking_chains_and_graph_expands_selection() {
    let files = snapshot();
    let project = QaProject::load(&files).unwrap();
    let input = SelectionInput {
        graph: [(
            "src/price.ts".into(),
            ["src/checkout/page.tsx".into()].into(),
        )]
        .into(),
        max_journeys: 2,
        cell_wall_seconds: 30,
        ..Default::default()
    };
    let plan = project.plan(&files, &files, &input).unwrap();
    assert_eq!(plan.selected.keys().collect::<Vec<_>>(), ["login"]);
    assert_eq!(plan.held_back.len(), 2);
    assert!(
        plan.held_back["checkout"].contains(&"graph: src/price.ts -> src/checkout/page.tsx".into())
    );
    assert_eq!(plan.cell_count, 4);
    assert_eq!(plan.estimated_wall_seconds, 120);
    let mut result = empty_runtime_result(&plan, "pi");
    annotate_runtime_result(&mut result, &project, &files, &plan, &input.changed).unwrap();
    assert_eq!(result["journey_outcomes"].as_array().unwrap().len(), 8);
    assert!(
        result["journey_outcomes"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["reason"] == "held_back")
    );
    assert!(
        selection_notes(&plan)
            .iter()
            .any(|note| note.contains("held back 2 journeys"))
    );
}

#[test]
fn unknown_explicit_journey_fails_and_full_and_nothing_matching_are_distinct() {
    let files = snapshot();
    let project = QaProject::load(&files).unwrap();
    let mut input = SelectionInput {
        max_journeys: 12,
        ..Default::default()
    };
    let plan = project.plan(&files, &files, &input).unwrap();
    assert!(plan.no_coverage_match);
    assert_eq!(plan.selected.len(), 1);
    input.full = true;
    assert_eq!(
        project.plan(&files, &files, &input).unwrap().selected.len(),
        3
    );
    input.explicit = vec!["missing".into()];
    assert!(project.plan(&files, &files, &input).is_err());
}

mod common;
use common::*;
use rio_adapters::*;
use rio_core::{CheckKind, ScheduledAs};
use rio_git::{Tree, diff};

#[test]
fn shared_package_schedules_consumers_and_uses_workspace_lock() {
    let base = read_tree(&fixture("monorepo-sample"));
    let mut head = base.clone();
    head.get_mut("packages/shared/src/index.ts")
        .unwrap()
        .content
        .extend(b"\nexport const added = true;\n");
    let changes = changes(base, head);
    let diff = diff(&changes, &[]).unwrap();
    let layout = detect_repository(&changes.head, &diff).unwrap();
    let scheduled = layout.schedule(&diff);
    assert_eq!(
        scheduled
            .iter()
            .map(|root| root.project.path.as_str())
            .collect::<Vec<_>>(),
        ["packages/api", "packages/shared"]
    );
    assert_eq!(scheduled[0].scheduled_as, ScheduledAs::Dependent);
    assert!(!scheduled[0].checks().contains(&CheckKind::Lint));
    assert_eq!(scheduled[1].scheduled_as, ScheduledAs::Changed);
    assert!(scheduled[1].checks().contains(&CheckKind::Lint));
    assert_eq!(scheduled[0].project.workspace.as_deref(), Some("."));
    let lock = governing_lockfile(&changes.head, "packages/api", Some("."), Ecosystem::Npm)
        .unwrap()
        .unwrap();
    assert_eq!(lock.path, "pnpm-lock.yaml");
    assert_eq!(lock.importer, "packages/api");
}

#[test]
fn nearest_manifests_fallbacks_and_transitive_references_are_detected() {
    let head: Tree = [
        ("a/tsconfig.json".into(), entry(r#"{}"#)),
        (
            "b/tsconfig.json".into(),
            entry(r#"{"references":[{"path":"../a/tsconfig.json"}]}"#),
        ),
        (
            "c/tsconfig.json".into(),
            entry(r#"{"references":[{"path":"../b"}]}"#),
        ),
        ("a/new.ts".into(), entry("export const foo = 1")),
        ("scripts/new.py".into(), entry("print(1)")),
    ]
    .into_iter()
    .collect();
    let mut base = head.clone();
    base.remove("a/new.ts");
    base.remove("scripts/new.py");
    let changes = changes(base, head);
    let diff = diff(&changes, &[]).unwrap();
    let layout = detect_repository(&changes.head, &diff).unwrap();
    assert_eq!(layout.root_for("a/new.ts", "typescript").unwrap().path, "a");
    assert_eq!(
        layout.root_for("scripts/new.py", "python").unwrap().path,
        "."
    );
    assert!(layout.notes.iter().any(|note| note.contains("no manifest")));
    assert_eq!(layout.schedule(&diff).len(), 4);
}

#[test]
fn uv_poetry_and_editable_path_edges_propagate_changes() {
    let head: Tree = [
        ("pyproject.toml".into(), entry("[tool.uv.workspace]\nmembers=['packages/*']\nexclude=['packages/ignored']")),
        ("packages/shared/pyproject.toml".into(), entry("[project]\nname='shared'")),
        ("packages/api/pyproject.toml".into(), entry("[project]\nname='api'\ndependencies=['shared']\n[tool.uv.sources]\nshared={workspace=true}")),
        ("packages/cli/pyproject.toml".into(), entry("[project]\nname='cli'\n[tool.poetry.dependencies]\napi={path='../api',editable=true}")),
        ("legacy/requirements.txt".into(), entry("-e ../packages/cli\n")),
        ("packages/ignored/pyproject.toml".into(), entry("[project]\nname='ignored'")),
        ("packages/shared/new.py".into(), entry("def f(): return 1")),
    ].into_iter().collect();
    let mut base = head.clone();
    base.remove("packages/shared/new.py");
    let changes = changes(base, head);
    let diff = diff(&changes, &[]).unwrap();
    let layout = detect_repository(&changes.head, &diff).unwrap();
    assert_eq!(
        layout
            .schedule(&diff)
            .iter()
            .map(|root| root.project.path.as_str())
            .collect::<Vec<_>>(),
        ["legacy", "packages/api", "packages/cli", "packages/shared"]
    );
    assert!(
        layout
            .roots
            .iter()
            .find(|root| root.path == "packages/ignored")
            .unwrap()
            .workspace
            .is_none()
    );
}

#[test]
fn unparsable_manifests_are_skipped_with_a_note_instead_of_failing_detection() {
    let head: Tree = [
        (
            "Cargo.toml".into(),
            entry("[workspace]\nmembers=['crates/*']\n"),
        ),
        (
            "crates/app/Cargo.toml".into(),
            entry("[package]\nname='app'\n"),
        ),
        ("crates/app/src/lib.rs".into(), entry("pub fn f() {}\n")),
        (
            "tests/fixtures/invalid/Cargo.toml".into(),
            entry("[package]\nkey = invalid-value\n"),
        ),
        ("tests/fixtures/invalid/tsconfig.json".into(), entry("}\n")),
        ("tests/fixtures/invalid/package.json".into(), entry("{\n")),
        (
            "tests/fixtures/invalid/pyproject.toml".into(),
            entry("[project\n"),
        ),
        (
            "tests/fixtures/invalid/pnpm-workspace.yaml".into(),
            entry("packages: [\n"),
        ),
    ]
    .into_iter()
    .collect();
    let mut base = head.clone();
    base.get_mut("crates/app/src/lib.rs").unwrap().content = b"pub fn f() { }\n".to_vec();
    let changes = changes(base, head);
    let diff = diff(&changes, &[]).unwrap();
    let layout = detect_repository(&changes.head, &diff).unwrap();
    assert_eq!(
        layout
            .root_for("crates/app/src/lib.rs", "rust")
            .unwrap()
            .path,
        "crates/app"
    );
    assert_eq!(
        layout
            .root_for("crates/app/src/lib.rs", "rust")
            .unwrap()
            .workspace
            .as_deref(),
        Some(".")
    );
    for path in [
        "tests/fixtures/invalid/Cargo.toml",
        "tests/fixtures/invalid/tsconfig.json",
        "tests/fixtures/invalid/package.json",
        "tests/fixtures/invalid/pyproject.toml",
        "tests/fixtures/invalid/pnpm-workspace.yaml",
    ] {
        assert!(
            layout
                .notes
                .contains(&format!("Skipped unparsable manifest {path}")),
            "{:?}",
            layout.notes
        );
    }
    // The invalid fixtures still register as roots by file name, without a name.
    let fixture = layout
        .roots
        .iter()
        .find(|root| root.path == "tests/fixtures/invalid" && root.language == "rust")
        .unwrap();
    assert_eq!(fixture.name, None);
}

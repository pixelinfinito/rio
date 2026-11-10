use rio_qa::{QaSnapshot, SetupFile, SetupProposal, apply_setup, prepare_setup, setup_context};
use serde_json::json;
use std::{collections::BTreeMap, fs};

fn snapshot() -> QaSnapshot {
    BTreeMap::from([(".rio/qa.yaml".into(), serde_json::to_vec(&json!({"version":1,
        "app":{"packaging":"static","directory":"public","url":"http://app.test:4173","ready":{"path":"/","status":200}},
        "personas":[{"name":"shopper","description":"Shopper","username_env":"QA_SHOPPER_EMAIL","password_env":"QA_SHOPPER_PASSWORD"},
        {"name":"admin","description":"Administrator","username_env":"QA_ADMIN_EMAIL","password_env":"QA_ADMIN_PASSWORD"}]})).unwrap()),
        ("prisma/schema.prisma".into(), b"model User {\n id Int @id\n email String @unique\n password String\n}\n".to_vec()),
        ("src/payments.ts".into(), b"import Stripe from 'stripe';\nconst stripe = new Stripe(process.env.STRIPE_SECRET_KEY);".to_vec())])
}
fn proposal() -> SetupProposal {
    SetupProposal { files: vec![
        SetupFile { path: ".rio/qa/seed/seed.yaml".into(), content: serde_json::to_string(&json!({"version":1,"datastores":[{"name":"db","kind":"sqlite","connection_env":"DATABASE_URL"}],
            "steps":[{"file":"schema.sql","applies_to":["db"]}],"users":[{"persona":"shopper","apply":"node .rio/qa/seed/users.mjs shopper"},{"persona":"admin","apply":"node .rio/qa/seed/users.mjs admin"}],"paths":[]})).unwrap() },
        SetupFile { path: ".rio/qa/seed/schema.sql".into(), content: "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);".into() },
        SetupFile { path: ".rio/qa/seed/users.mjs".into(), content: "// Runtime-only synthetic account credential application".into() },
        SetupFile { path: ".rio/qa/fixtures/stripe/approve.json".into(), content: serde_json::to_string(&json!({"behavior":"approve","request":{"method":"POST","path":"/v1/charges"},"response":{"status":200,"body":{"paid":true}}})).unwrap() },
        SetupFile { path: ".rio/qa/fixtures/fixtures.yaml".into(), content: serde_json::to_string(&json!({"version":1,"services":[{"name":"stripe","kind":"http-mock","claims":["api.stripe.com"],"recordings":"stripe","behaviors":["approve"],"env":{"STRIPE_API_BASE":"{{url}}"}}]})).unwrap() },
    ] }
}
#[test]
fn setup_metadata_has_models_and_sdk_detection_without_a_checkout_or_env_values() {
    let mut source = snapshot();
    source.insert(
        ".env".into(),
        b"STRIPE_SECRET_KEY=production-secret-value".to_vec(),
    );
    source.insert(
        "src/admin/REVIEW.md".into(),
        b"Unrelated admin requirements".to_vec(),
    );
    source.insert(
        "REVIEW.md".into(),
        b"Preserve entered data after payment declines".to_vec(),
    );
    let context = setup_context(&source, "definitions").unwrap();
    assert!(context["schema_models"].to_string().contains("model User"));
    assert!(context["dependencies"].to_string().contains("sdk:stripe"));
    assert!(
        context["dependencies"]
            .to_string()
            .contains("env:STRIPE_SECRET_KEY")
    );
    assert!(!context.to_string().contains("production-secret-value"));
    assert!(!context.to_string().contains("Unrelated admin"));
    assert!(!context.to_string().contains("new Stripe"));
}
#[test]
fn setup_batch_validates_personas_and_references_before_any_write() {
    let source = snapshot();
    let files = prepare_setup(&source, proposal(), "definitions").unwrap();
    let root = tempfile::tempdir().unwrap();
    assert_eq!(apply_setup(root.path(), &files).unwrap().len(), 5);
    assert!(apply_setup(root.path(), &files).is_err());
    for invalid in [
        "../../source.ts",
        ".rio/qa/seed/../source.ts",
        ".rio/qa/seed/.cache/rows",
        ".rio/qa/journeys/new.yaml",
    ] {
        let mut data = proposal();
        data.files[1].path = invalid.into();
        assert!(
            prepare_setup(&source, data, "definitions").is_err(),
            "{invalid}"
        );
    }
    let mut missing = proposal();
    missing.files.remove(1);
    assert!(prepare_setup(&source, missing, "definitions").is_err());
    let mut missing_user = proposal();
    missing_user.files[0].content = missing_user.files[0]
        .content
        .replace("\"persona\":\"admin\"", "\"persona\":\"shopper\"");
    assert!(prepare_setup(&source, missing_user, "definitions").is_err());
    let mut existing = source.clone();
    existing.insert(".rio/qa/seed/schema.sql".into(), b"human edit".to_vec());
    assert!(prepare_setup(&existing, proposal(), "definitions").is_err());
}
#[test]
fn setup_publication_preserves_concurrent_files_and_symlinked_parents() {
    let files = prepare_setup(&snapshot(), proposal(), "definitions").unwrap();
    let root = tempfile::tempdir().unwrap();
    fs::create_dir_all(root.path().join(".rio/qa/seed")).unwrap();
    fs::write(
        root.path().join(".rio/qa/seed/users.mjs"),
        "concurrent edit",
    )
    .unwrap();
    assert!(apply_setup(root.path(), &files).is_err());
    assert!(!root.path().join(".rio/qa/fixtures/fixtures.yaml").exists());
    assert!(!root.path().join(".rio/qa/seed/seed.yaml").exists());
    #[cfg(unix)]
    {
        let root = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(elsewhere.path(), root.path().join(".rio")).unwrap();
        assert!(apply_setup(root.path(), &files).is_err());
        assert_eq!(fs::read_dir(elsewhere.path()).unwrap().count(), 0);
    }
}
#[test]
fn fallback_contract_cannot_write_definitions_or_replace_a_contract() {
    let bytes = snapshot().remove(".rio/qa.yaml").unwrap();
    let make = || SetupProposal {
        files: vec![SetupFile {
            path: ".rio/qa.yaml".into(),
            content: String::from_utf8(bytes.clone()).unwrap(),
        }],
    };
    assert!(prepare_setup(&BTreeMap::new(), make(), "contract").is_ok());
    assert!(prepare_setup(&snapshot(), make(), "contract").is_err());
    assert!(prepare_setup(&BTreeMap::new(), proposal(), "contract").is_err());
}

#[test]
fn discovered_doubles_append_without_rewriting_owner_fixtures_and_require_recordings() {
    use rio_qa::{apply_dependency_setup, prepare_dependency_setup};
    let mut source = snapshot();
    source.extend(prepare_setup(&source, proposal(), "definitions").unwrap());
    let path = ".rio/qa/fixtures/fixtures.yaml";
    let previous: serde_json::Value = serde_json::from_slice(&source[path]).unwrap();
    let make = || {
        let mut manifest = previous.clone();
        manifest["services"].as_array_mut().unwrap().push(
            json!({"name":"catalog","kind":"http-mock","claims":["catalog.example.test"],
            "env":{},"recordings":"catalog","behaviors":["available"]}),
        );
        SetupProposal { files: vec![SetupFile { path:path.into(),content:serde_json::to_string(&manifest).unwrap() },
            SetupFile { path:".rio/qa/fixtures/catalog/available.json".into(), content:serde_json::to_string(&json!({"behavior":"available","request":{"method":"GET","path":"/catalog"},"response":{"status":200,"body":{"products":[]}}})).unwrap() }] }
    };
    let blocked = vec!["catalog.example.test".into()];
    let files = prepare_dependency_setup(&source, make(), &blocked).unwrap();
    let root = tempfile::tempdir().unwrap();
    for (path, bytes) in &source {
        let target = root.path().join(path);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(target, bytes).unwrap();
    }
    fs::write(root.path().join(path), "concurrent edit").unwrap();
    assert!(apply_dependency_setup(root.path(), &source, &files).is_err());
    assert!(
        !root
            .path()
            .join(".rio/qa/fixtures/catalog/available.json")
            .exists()
    );
    fs::write(root.path().join(path), &source[path]).unwrap();
    assert_eq!(
        apply_dependency_setup(root.path(), &source, &files)
            .unwrap()
            .last()
            .unwrap(),
        path
    );
    let applied: serde_json::Value =
        serde_json::from_slice(&fs::read(root.path().join(path)).unwrap()).unwrap();
    assert_eq!(applied["services"][0], previous["services"][0]);
    assert!(prepare_dependency_setup(&source, make(), &["unclaimed.example.test".into()]).is_err());
    let mut changed = make();
    changed.files[0].content = changed.files[0]
        .content
        .replace("api.stripe.com", "rewritten.example.test");
    assert!(prepare_dependency_setup(&source, changed, &blocked).is_err());
    let mut missing = make();
    missing.files.pop();
    assert!(prepare_dependency_setup(&source, missing, &blocked).is_err());
}

#[test]
fn dependency_summary_distinguishes_doubled_hosts_local_routes_and_unresolved_sdk_hints() {
    use rio_qa::{QaProject, setup_undoubled_dependencies};
    let mut source = snapshot();
    source.extend(prepare_setup(&source, proposal(), "definitions").unwrap());
    source.insert("src/service.mjs".into(), b"import mail from 'nodemailer';\nconst base=process.env.CATALOG_API_BASE;\nfetch('http://catalog.example.test/v1/products');\nfetch('http://app.test:4173/login');".to_vec());
    source.insert(
        "tests/example.js".into(),
        b"fetch('https://ignored.example.test/');".to_vec(),
    );
    let project = QaProject::load(&source).unwrap();
    assert_eq!(
        setup_undoubled_dependencies(&source, &project).unwrap(),
        vec![
            "catalog.example.test",
            "env:CATALOG_API_BASE",
            "sdk:nodemailer"
        ]
    );
}

#[test]
fn migration_metadata_includes_unquoted_columns_but_excludes_data_rows() {
    let mut source = snapshot();
    source.insert("migrations/001.sql".into(), b"-- schema\nCREATE TABLE products (\n id INTEGER PRIMARY KEY,\n title TEXT NOT NULL\n);\nINSERT INTO products VALUES (1, 'Production customer value');".to_vec());
    source.insert(
        "src/config.py".into(),
        b"base = os.environ.get('CATALOG_API_BASE')\nother = os.getenv('MAIL_ENDPOINT')".to_vec(),
    );
    source.insert(
        "src/config.js".into(),
        b"const base=process.env['PAYMENTS_API_BASE'];".to_vec(),
    );
    let context = setup_context(&source, "definitions").unwrap();
    assert!(
        context["schema_models"]
            .to_string()
            .contains("title TEXT NOT NULL")
    );
    assert!(!context.to_string().contains("Production customer"));
    for name in ["CATALOG_API_BASE", "MAIL_ENDPOINT", "PAYMENTS_API_BASE"] {
        assert!(context["dependencies"].to_string().contains(name), "{name}");
    }
}

#[test]
fn source_sdk_and_env_hints_require_matching_new_doubles() {
    use rio_qa::prepare_dependency_setup;
    let mut source = snapshot();
    source.extend(prepare_setup(&source, proposal(), "definitions").unwrap());
    let path = ".rio/qa/fixtures/fixtures.yaml";
    let mut fixtures: serde_json::Value = serde_json::from_slice(&source[path]).unwrap();
    fixtures["services"].as_array_mut().unwrap().extend([
        json!({"name":"mail","kind":"smtp-capture","env":{"SMTP_HOST":"127.0.0.1","SMTP_PORT":"{{port}}"}}),
        json!({"name":"objects","kind":"s3","env":{"OBJECTS_ENDPOINT":"{{url}}"}}),
    ]);
    let make = || SetupProposal {
        files: vec![SetupFile {
            path: path.into(),
            content: serde_json::to_string(&fixtures).unwrap(),
        }],
    };
    assert!(
        prepare_dependency_setup(
            &source,
            make(),
            &[
                "sdk:nodemailer".into(),
                "sdk:boto3".into(),
                "env:OBJECTS_ENDPOINT".into()
            ]
        )
        .is_ok()
    );
    assert!(
        prepare_dependency_setup(&source, make(), &["env:UNCONFIGURED_API_BASE".into()]).is_err()
    );
}

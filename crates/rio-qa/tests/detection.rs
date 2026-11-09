use rio_qa::{
    DocumentKind, EnvironmentDetection, QaConfig, QaSnapshot, apply_environment_detection,
    detect_environment, parse_document,
};
use serde_json::json;

fn detected(files: &QaSnapshot) -> serde_json::Value {
    let EnvironmentDetection::Detected { contract, .. } = detect_environment(files) else {
        panic!("Expected a detected contract")
    };
    let _: QaConfig = parse_document(
        DocumentKind::Config,
        "detected",
        &serde_json::to_vec(&contract).unwrap(),
    )
    .unwrap();
    contract
}
#[test]
fn dockerfile_precedes_scripts_and_literal_tcp_ports_are_required() {
    let mut files = QaSnapshot::from([
        (
            "Dockerfile".into(),
            b"FROM node:22\nEXPOSE 3000/tcp # app\n".to_vec(),
        ),
        (
            "package.json".into(),
            serde_json::to_vec(&json!({"scripts":{"dev":"vite"}})).unwrap(),
        ),
    ]);
    let value = detected(&files);
    assert_eq!(value["app"]["packaging"], "image");
    assert_eq!(value["app"]["url"], "http://127.0.0.1:3000");
    files.insert("Dockerfile".into(), b"EXPOSE $PORT\n".to_vec());
    assert!(matches!(
        detect_environment(&files),
        EnvironmentDetection::NeedsHarness { .. }
    ));
}
#[test]
fn vite_detection_never_installs_missing_dependencies() {
    let mut files = QaSnapshot::from([
        (
            "package.json".into(),
            serde_json::to_vec(&json!({"scripts":{"dev":"vite","start":"other"}})).unwrap(),
        ),
        ("package-lock.json".into(), b"{}".to_vec()),
    ]);
    assert!(matches!(
        detect_environment(&files),
        EnvironmentDetection::NeedsHarness { .. }
    ));
    files.insert("node_modules/vite/package.json".into(), b"{}".to_vec());
    let value = detected(&files);
    assert_eq!(value["app"]["packaging"], "vendored");
    assert_eq!(
        value["app"]["start"],
        "npm run dev -- --host 0.0.0.0 --port 4173"
    );
    assert_eq!(value["app"]["url"], "http://127.0.0.1:4173");
}
#[test]
fn python_entrypoints_and_compose_only_have_explicit_outcomes() {
    for (path, source, port) in [
        ("manage.py", "", 8000),
        ("main.py", "app = FastAPI()", 8000),
        ("app.py", "app = Flask(__name__)", 5000),
    ] {
        let value = detected(&QaSnapshot::from([(
            path.into(),
            source.as_bytes().to_vec(),
        )]));
        assert_eq!(value["app"]["url"], format!("http://127.0.0.1:{port}"));
    }
    let root = tempfile::tempdir().unwrap();
    let proposal = detect_environment(&QaSnapshot::from([(
        "compose.yaml".into(),
        b"services: {}".to_vec(),
    )]));
    assert!(matches!(
        proposal,
        EnvironmentDetection::UnsupportedTopology { .. }
    ));
    assert_eq!(
        apply_environment_detection(root.path(), &proposal).unwrap(),
        "Dockerfile.qa.proposed"
    );
    assert!(!root.path().join(".rio/qa.yaml").exists());
    assert!(apply_environment_detection(root.path(), &proposal).is_err());
}
#[test]
fn contract_creation_is_exclusive_and_validated_before_writing() {
    let root = tempfile::tempdir().unwrap();
    let proposal = detect_environment(&QaSnapshot::from([(
        "Dockerfile".into(),
        b"EXPOSE 3000".to_vec(),
    )]));
    apply_environment_detection(root.path(), &proposal).unwrap();
    let original = std::fs::read(root.path().join(".rio/qa.yaml")).unwrap();
    assert!(apply_environment_detection(root.path(), &proposal).is_err());
    assert_eq!(
        std::fs::read(root.path().join(".rio/qa.yaml")).unwrap(),
        original
    );
    #[cfg(unix)]
    {
        let other = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), other.path().join(".rio")).unwrap();
        assert!(apply_environment_detection(other.path(), &proposal).is_err());
        assert!(!outside.path().join("qa.yaml").exists());
    }
}

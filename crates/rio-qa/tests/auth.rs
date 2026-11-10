use rio_qa::{QaBackend, resolve_authentication, subscription_file_available};
use serde_json::json;

#[test]
fn local_subscription_reuse_is_limited_to_codex_on_docker_and_never_serializes_credentials() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("auth.json");
    std::fs::write(&path, json!({"auth_mode":"chatgpt", "OPENAI_API_KEY":null,"tokens":{"access_token":"sensitive-token"}}).to_string()).unwrap();
    for requested in ["auto", "subscription"] {
        let auth =
            resolve_authentication(requested, "codex", QaBackend::Docker, false, Some(&path))
                .unwrap();
        assert_eq!(auth.harness_auth, "subscription");
        assert_eq!(auth.subscription_file.as_deref(), Some(path.as_path()));
        let diagnostic = serde_json::to_string(&auth).unwrap();
        assert!(diagnostic.contains("unmetered"));
        assert!(!diagnostic.contains("sensitive-token"));
        assert!(!diagnostic.contains("auth.json"));
    }
    for (backend, hosted, harness) in [
        (QaBackend::Docker, true, "codex"),
        (QaBackend::Sandbox, false, "codex"),
        (QaBackend::Docker, false, "pi"),
    ] {
        assert!(
            resolve_authentication("subscription", harness, backend, hosted, Some(&path)).is_err()
        );
        let auth = resolve_authentication("auto", harness, backend, hosted, Some(&path)).unwrap();
        assert_eq!(auth.harness_auth, "gateway");
        assert!(auth.subscription_file.is_none());
    }
    assert!(
        resolve_authentication("gateway", "codex", QaBackend::Docker, false, Some(&path))
            .unwrap()
            .subscription_file
            .is_none()
    );
}

#[test]
fn api_keys_invalid_files_and_missing_subscriptions_cannot_be_mounted() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("auth.json");
    for text in [
        "{}".into(),
        "invalid".into(),
        json!({"OPENAI_API_KEY":"provider-secret","tokens":{"access_token":"subscription"}})
            .to_string(),
        json!({"auth_mode":"apikey","tokens":{"access_token":"subscription"}}).to_string(),
    ] {
        std::fs::write(&path, text).unwrap();
        assert!(!subscription_file_available(&path));
        assert!(
            resolve_authentication(
                "subscription",
                "codex",
                QaBackend::Docker,
                false,
                Some(&path)
            )
            .is_err()
        );
        assert_eq!(
            resolve_authentication("auto", "codex", QaBackend::Docker, false, Some(&path))
                .unwrap()
                .harness_auth,
            "gateway"
        );
    }
    assert!(!subscription_file_available(dir.path()));
    assert!(
        resolve_authentication("subscription", "codex", QaBackend::Docker, false, None).is_err()
    );
}

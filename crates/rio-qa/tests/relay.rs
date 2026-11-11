#[cfg(unix)]
#[tokio::test]
async fn keychain_backed_host_relay_exposes_only_a_run_capability_and_socket() {
    use rio_qa::{LocalModelRelay, LocalModelRoute};
    use std::io::{Read, Write};
    struct SavedKeychain;
    impl keyring::credential::CredentialBuilderApi for SavedKeychain {
        fn build(
            &self,
            target: Option<&str>,
            service: &str,
            user: &str,
        ) -> keyring::Result<Box<keyring::credential::Credential>> {
            assert_eq!((service, user), ("rio-qa-test", "provider"));
            let credential =
                keyring::mock::default_credential_builder().build(target, service, user)?;
            credential.set_password(r#"{"OPENAI_API_KEY":"synthetic-provider-secret"}"#)?;
            Ok(credential)
        }
        fn as_any(&self) -> &dyn std::any::Any {
            self
        }
        fn persistence(&self) -> keyring::credential::CredentialPersistence {
            keyring::credential::CredentialPersistence::UntilDelete
        }
    }
    keyring::set_default_credential_builder(Box::new(SavedKeychain));
    let relay = LocalModelRelay::start(
        LocalModelRoute {
            url: "https://api.openai.com/v1/chat/completions".into(),
            protocol: "openai".into(),
            model: "openai/test".into(),
            provider_model: "test".into(),
            keychain_service: "rio-qa-test".into(),
            keychain_account: "provider".into(),
            keychain_field: Some("OPENAI_API_KEY".into()),
            authentication: None,
            prompt_cache: vec![],
        },
        "local-run",
        1000,
    )
    .await
    .unwrap();
    assert_eq!(relay.capability().len(), 64);
    assert!(!relay.capability().contains("synthetic"));
    let socket = relay.socket_path();
    let token = relay.capability().to_owned();
    let result = tokio::task::spawn_blocking(move || {
        let mut stream = std::os::unix::net::UnixStream::connect(&socket).unwrap();
        let body = r#"{"model":"not-the-selected-model"}"#;
        write!(stream, "POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        let mut response = String::new(); stream.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 400"));
        assert!(!response.contains("synthetic-provider-secret"));
        for file in std::fs::read_dir(socket.parent().unwrap()).unwrap() {
            let file = file.unwrap();
            if file.file_type().unwrap().is_file() {
                assert!(!std::fs::read_to_string(file.path()).unwrap().contains("synthetic-provider-secret"));
            }
        }
    }).await;
    let directory = relay.socket_path().parent().unwrap().to_path_buf();
    let records = relay.close().await.unwrap();
    result.unwrap();
    assert!(records.is_empty());
    assert!(!directory.exists());
}

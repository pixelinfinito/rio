use rio_adapters::{redact, retained_raw, scan_secrets, shannon_entropy};
use rio_core::{EvidenceLevel, State, secret_matches_for_path};
use rio_git::{ChangeSet, Selection, Tree, TreeEntry, diff};

fn cases() -> Vec<(&'static str, String, &'static str)> {
    vec![
        (
            "aws-access-key",
            format!("AKIA{}", "A1B2C3D4E5F6G7H8"),
            "AKIA123",
        ),
        (
            "github-token",
            format!("ghp_{}", "Ab1".repeat(12)),
            "ghp_short",
        ),
        (
            "gitlab-token",
            format!("glpat-{}", "a1b2C".repeat(4)),
            "glpat-short",
        ),
        (
            "slack-token",
            format!("xoxb-{}", "1234567890-abcdefghijk"),
            "xoxb-short",
        ),
        (
            "stripe-key",
            format!("sk_live_{}", "Ab1".repeat(8)),
            "sk_test_1234",
        ),
        (
            "private-key",
            "-----BEGIN PRIVATE KEY-----\nYXNkZmdoaWprbG1ub3BxcnN0dXY=\n-----END PRIVATE KEY-----"
                .into(),
            "-----BEGIN PUBLIC KEY-----\npublic\n-----END PUBLIC KEY-----",
        ),
        (
            "connection-string",
            "postgresql://user:reallysecret@example.invalid/db".into(),
            "postgresql://user@example.invalid/db",
        ),
    ]
}

fn changes(base: &str, head: &str) -> ChangeSet {
    let tree = |text: &str| {
        Tree::from([(
            "a.ts".into(),
            TreeEntry {
                mode: 0o100644,
                object_id: String::new(),
                content: text.as_bytes().to_vec(),
            },
        )])
    };
    ChangeSet {
        selection: Selection::WorkingTree,
        base_id: "base".into(),
        head_id: "head".into(),
        base: tree(base),
        head: tree(head),
    }
}

#[test]
fn every_catalog_pattern_has_positive_negative_and_redaction_checks() {
    for (pattern, value, negative) in cases() {
        let changes = changes("", &value);
        let diff = diff(&changes, &[]).unwrap();
        let findings = scan_secrets(&diff, &changes.head).unwrap();
        assert_eq!(findings.len(), 1, "{pattern}");
        assert_eq!(findings[0].rule_id, format!("secret/{pattern}"));
        assert_eq!(findings[0].evidence_level, EvidenceLevel::StaticProven);
        assert_eq!(findings[0].state, State::New);
        let serialized = serde_json::to_string(&findings).unwrap();
        assert!(!serialized.contains(&value), "{pattern}");
        assert!(!redact(&value).contains(&value), "{pattern}");
        assert_eq!(redact(negative), negative, "{pattern}");
    }
}

#[test]
fn entropy_requires_a_secret_name_and_sufficient_entropy() {
    let value = "aB3dE5gH7jK9mN1pQ4sT6vW8xY0zR2";
    assert!(shannon_entropy(value) > 3.5);
    assert_eq!(shannon_entropy("aaaaaaaaaaaaaaaaaaaa"), 0.0);
    assert_eq!(shannon_entropy(""), 0.0);
    for name in ["api_key", "SECRET", "password", "access_token"] {
        let text = format!("\"{name}\": \"{value}\"");
        assert!(!redact(&text).contains(value), "{name}");
    }
    for separator in ["=", ":"] {
        let text = format!("api_key {separator} {value}");
        assert_eq!(secret_matches_for_path(&text, ".env").len(), 1);
        assert_eq!(redact(&text), text);
    }
    for text in [
        format!("ordinary = '{value}'"),
        "secret = 'aaaaaaaaaaaaaaaaaaaaaaaa'".into(),
        "token = 'short'".into(),
        "file_secret_settings: PydanticBaseSettingsSource".into(),
        "thread_token = _ASYNC_CALLING_THREAD.set(1)".into(),
        "scs_token = _ASYNC_CALLING_STACK.set(frame)".into(),
        "access_token = SOME_EXTERNAL_TOKEN_VALUE".into(),
    ] {
        assert_eq!(redact(&text), text);
    }
}

#[test]
fn hunk_membership_distinguishes_new_and_pre_existing_credentials() {
    let first = cases()[0].1.clone();
    let second = cases()[1].1.clone();
    let changes = changes(
        &format!("old='{first}'\nunchanged\n"),
        &format!("old='{first}'\nunchanged\nnew='{second}'\n"),
    );
    let findings = scan_secrets(&diff(&changes, &[]).unwrap(), &changes.head).unwrap();
    assert_eq!(findings.len(), 2);
    assert_eq!(findings[0].state, State::PreExisting);
    assert_eq!(findings[1].state, State::New);
    assert_eq!(findings[1].location.line_start, 3);
}

#[test]
fn raw_output_is_redacted_before_head_and_tail_truncation_including_multiline_keys() {
    let values = cases();
    let raw = values
        .iter()
        .map(|(_, value, _)| value.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let stored = String::from_utf8(retained_raw(raw.as_bytes(), 100000)).unwrap();
    for (_, value, _) in &values {
        assert!(!stored.contains(value));
    }
    let padded = format!("{}\n{}\n{}", "あ".repeat(100), raw, "え".repeat(100));
    let stored = retained_raw(padded.as_bytes(), 128);
    assert!(stored.len() <= 128);
    let stored = String::from_utf8(stored).unwrap();
    assert!(stored.contains("truncated"));
    for (_, value, _) in &values {
        assert!(!stored.contains(value));
    }
}

#[test]
fn output_stopped_mid_credential_is_still_redacted() {
    let token = "ghp_abcdefghijk";
    let key = "-----BEGIN PRIVATE KEY-----\nsensitive-key-body-without-an-end-marker";
    let retained = String::from_utf8(retained_raw(key.as_bytes(), 100000)).unwrap();
    assert!(!retained.contains("sensitive-key-body"));
    let retained = String::from_utf8(retained_raw(token.as_bytes(), 100000)).unwrap();
    assert_eq!(retained, "ghp_[REDACTED]");
}

#[test]
fn structlog_contextvar_identifiers_are_not_credentials() {
    // The expression guards landed in 8ea5d63. Keep the annotated ContextVar
    // shape from the acceptance evaluation covered in scanning and redaction.
    let source = r#"from contextvars import ContextVar
_CONTEXT_TOKEN: ContextVar[dict[str, Token[Any]]] = ContextVar("structlog_context_tokens")
_ASYNC_CALLING_STACK: ContextVar[tuple[FrameType, ...]] = ContextVar("structlog_async_calling_stack")
structlog_context_token = ContextVar("structlog_context_tokens")
"#;
    assert_eq!(redact(source), source);
    let changes = changes("", source);
    assert!(
        scan_secrets(&diff(&changes, &[]).unwrap(), &changes.head)
            .unwrap()
            .is_empty()
    );
    let secret = "aB3dE5gH7jK9mN1pQ4sT6vW8xY0zR2";
    let literal = format!("_CONTEXT_TOKEN = '{secret}'");
    assert!(!redact(&literal).contains(secret));
}

#[test]
fn entropy_rejects_source_expressions_in_assignments_kwargs_and_properties() {
    for source in [
        "privatekey=self.default_privatekey,",
        "privatekey=self.x,",
        "token=get_token()",
        "token=retrieve_a_credential_with_a_long_name()",
        "password: config.password",
        "apiKey: process.env.KEY",
        "password = dynamically_created_password",
        "{'privatekey': self.default_privatekey}",
        "{apiKey: process.env.VERY_LONG_CREDENTIAL_NAME}",
        "password = \"aB3dE5gH7jK9mN1pQ4sT6vW8xY0zR2\" + suffix",
        "password = 'aB3dE5gH7jK9mN1pQ4sT6vW8xY0zR2'.strip()",
        "password = \"aB3dE5gH7jK9mN1pQ4sT6vW8xY0zR2'",
    ] {
        let change = changes("", source);
        assert!(
            scan_secrets(&diff(&change, &[]).unwrap(), &change.head)
                .unwrap()
                .is_empty(),
            "{source}"
        );
        assert_eq!(redact(source), source);
    }
    let value = "aB3dE5gH7jK9mN1pQ4sT6vW8xY0zR2";
    for source in [
        format!("password = \"{value}\""),
        format!("connect(privatekey='{value}', token=None)"),
        format!("{{'token': '{value}'}}"),
        format!("{{apiKey: \"{value}\"}}"),
    ] {
        let change = changes("", &source);
        assert_eq!(
            scan_secrets(&diff(&change, &[]).unwrap(), &change.head)
                .unwrap()
                .len(),
            1,
            "{source}"
        );
    }
}

#[test]
fn bare_entropy_values_require_configuration_files_and_complete_values() {
    let value = "aB3dE5gH7jK9mN1pQ4sT6vW8xY0zR2";
    for path in [
        ".env",
        ".env.local",
        "settings.ini",
        "settings.yaml",
        "settings.yml",
    ] {
        let source = format!("password = {value}");
        let mut change = changes("", &source);
        let entry = change.head.remove("a.ts").unwrap();
        change.head.insert(path.into(), entry);
        assert_eq!(
            scan_secrets(&diff(&change, &[]).unwrap(), &change.head)
                .unwrap()
                .len(),
            1,
            "{path}"
        );
    }
    for source in [
        format!("call(password={value})"),
        format!("password = {value} + other"),
    ] {
        assert!(
            secret_matches_for_path(&source, ".env").is_empty(),
            "{source}"
        );
    }
}

//! Host-owned authentication selection. Repository configuration may request a
//! mode but cannot select a credential file or relax backend isolation.
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QaBackend {
    Docker,
    Sandbox,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct QaAuthentication {
    pub harness: String,
    pub harness_auth: String,
    pub tokens: String,
    pub wall_bounded: bool,
    pub credential_source: String,
    #[serde(skip)]
    pub subscription_file: Option<PathBuf>,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct QaAuthError(pub &'static str);

/// Inspect only the host-selected auth file; values never enter diagnostics.
/// API-key login is deliberately not subscription reuse: provider keys must
/// remain on the host and use the budgeted model relay instead.
pub fn subscription_file_available(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() || metadata.len() > 1024 * 1024 {
        return false;
    }
    let Ok(bytes) = std::fs::read(path) else {
        return false;
    };
    let Ok(document) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return false;
    };
    document
        .get("OPENAI_API_KEY")
        .is_none_or(|key| key.is_null())
        && document["auth_mode"]
            .as_str()
            .is_none_or(|mode| mode == "chatgpt")
        && document["tokens"]["access_token"]
            .as_str()
            .is_some_and(|token| !token.trim().is_empty())
}

pub fn resolve_authentication(
    requested: &str,
    harness: &str,
    backend: QaBackend,
    hosted: bool,
    host_subscription_file: Option<&Path>,
) -> Result<QaAuthentication, QaAuthError> {
    if !matches!(requested, "auto" | "gateway" | "subscription")
        || !matches!(harness, "codex" | "pi")
    {
        return Err(QaAuthError(
            "Invalid QA harness authentication configuration",
        ));
    }
    let eligible = !hosted && backend == QaBackend::Docker && harness == "codex";
    if requested == "subscription" && !eligible {
        return Err(QaAuthError(
            "QA subscription authentication requires local Docker and the codex harness; hosted and Sandbox runs require gateway",
        ));
    }
    let file = if requested != "gateway" && eligible {
        host_subscription_file.filter(|path| subscription_file_available(path))
    } else {
        None
    };
    if requested == "subscription" && file.is_none() {
        return Err(QaAuthError(
            "QA subscription credentials are unavailable; sign in to Codex with a subscription or select gateway authentication",
        ));
    }
    Ok(if let Some(file) = file {
        QaAuthentication {
            harness: harness.into(),
            harness_auth: "subscription".into(),
            tokens: "unmetered".into(),
            wall_bounded: true,
            credential_source: "read-only controller mount".into(),
            subscription_file: Some(file.to_path_buf()),
        }
    } else {
        QaAuthentication {
            harness: harness.into(),
            harness_auth: "gateway".into(),
            tokens: "per-cell budget".into(),
            wall_bounded: true,
            credential_source: if hosted {
                "run-scoped token"
            } else {
                "host keychain relay"
            }
            .into(),
            subscription_file: None,
        }
    })
}

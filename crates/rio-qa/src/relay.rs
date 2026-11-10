//! Local provider keys remain on the trusted host. A run capability and one
//! Unix socket are exposed to the controller, never to app or browser.
use anyhow::{Context, Result, ensure};
use serde_json::json;
use std::{path::PathBuf, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    task::JoinHandle,
};

/// All fields are operator configuration, not repository or harness inputs.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocalModelRoute {
    pub url: String,
    pub protocol: String,
    pub model: String,
    pub provider_model: String,
    pub keychain_service: String,
    pub keychain_account: String,
    /// A key inside a saved JSON keychain entry, e.g. deployment credentials.
    pub keychain_field: Option<String>,
    /// `ai_gateway` sends the keychain token only in cf-aig-authorization.
    pub authentication: Option<String>,
    /// Prompt-cache hint classes for this route (`anthropic`, `openai`,
    /// `openrouter`); none by default.
    #[serde(default)]
    pub prompt_cache: Vec<String>,
}

pub struct LocalModelRelay {
    child: Child,
    input: Option<ChildStdin>,
    reader: JoinHandle<Vec<serde_json::Value>>,
    directory: tempfile::TempDir,
    token: String,
}
impl LocalModelRelay {
    pub async fn start(route: LocalModelRoute, run_id: &str, tokens: u64) -> Result<Self> {
        ensure!(
            cfg!(unix),
            "Local QA model relay requires Unix sockets on the Docker host"
        );
        let secret = tokio::task::spawn_blocking(move || -> Result<(LocalModelRoute, String)> {
            let value = keyring::Entry::new(&route.keychain_service, &route.keychain_account)
                .map_err(|_| anyhow::anyhow!("Could not open QA provider keychain entry"))?
                .get_password().map_err(|_| anyhow::anyhow!("QA provider key unavailable; unlock the host keychain and store a provider credential"))?;
            let key = if let Some(field) = &route.keychain_field {
                serde_json::from_str::<serde_json::Value>(&value).ok()
                    .and_then(|document| document.get(field).and_then(|value| value.as_str()).map(str::to_owned))
                    .context("Provider key is absent from the host keychain entry")?
            } else { value };
            ensure!(!key.trim().is_empty(), "Provider key is empty in the host keychain");
            Ok((route, key))
        }).await??;
        Self::launch(secret.0, secret.1, run_id, tokens).await
    }
    async fn launch(
        route: LocalModelRoute,
        key: String,
        run_id: &str,
        tokens: u64,
    ) -> Result<Self> {
        ensure!(
            matches!(
                route.authentication.as_deref(),
                None | Some("provider" | "ai_gateway")
            ),
            "Invalid QA route authentication; expected provider or ai_gateway"
        );
        ensure!(
            tokens > 0 && tokens <= 9_007_199_254_740_991,
            "Invalid QA relay token budget"
        );
        ensure!(
            route
                .prompt_cache
                .iter()
                .all(|class| matches!(class.as_str(), "anthropic" | "openai" | "openrouter")),
            "Invalid QA route prompt_cache; expected anthropic, openai or openrouter"
        );
        let directory = tempfile::Builder::new().prefix("rio-qa-host-").tempdir()?;
        for (name, content) in [
            (
                "host-relay.mjs",
                include_str!("../controller/src/host-relay.mjs"),
            ),
            (
                "model-proxy.mjs",
                include_str!("../controller/src/model-proxy.mjs"),
            ),
            (
                "provider-transport.mjs",
                include_str!("../controller/src/provider-transport.mjs"),
            ),
            ("usage.mjs", include_str!("../controller/src/usage.mjs")),
        ] {
            std::fs::write(directory.path().join(name), content)?;
        }
        let mut command = Command::new("node");
        command
            .arg(directory.path().join("host-relay.mjs"))
            .env_clear();
        for name in ["PATH", "LANG", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .context("QA local gateway needs Node.js on the trusted Docker host")?;
        let mut input = child.stdin.take().context("Missing QA relay input pipe")?;
        // Secret transport uses the child pipe only; never a config/cache file.
        let config = json!({"socket":directory.path().join("model.sock"),"key":key,"url":route.url,"protocol":route.protocol,
            "model":route.model,"provider_model":route.provider_model,"authentication":route.authentication,"prompt_cache":route.prompt_cache,"run_id":run_id,"tokens":tokens});
        input.write_all(format!("{config}\n").as_bytes()).await?;
        let stdout = child
            .stdout
            .take()
            .context("Missing QA relay output pipe")?;
        let mut lines = BufReader::new(stdout).lines();
        let ready = tokio::time::timeout(Duration::from_secs(10), lines.next_line())
            .await
            .context("QA host relay startup timed out")??
            .context("QA host relay failed to start")?;
        let ready: serde_json::Value =
            serde_json::from_str(&ready).context("Invalid QA relay handshake")?;
        ensure!(ready["kind"] == "ready", "Invalid QA relay handshake");
        let token = ready["token"]
            .as_str()
            .filter(|value| value.len() == 64 && value.bytes().all(|c| c.is_ascii_hexdigit()))
            .context("Invalid QA relay capability")?
            .to_owned();
        let reader = tokio::spawn(async move {
            let mut usage = Vec::new();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Ok(entry) = serde_json::from_str::<serde_json::Value>(&line)
                    && entry["kind"] == "usage"
                    && usage.len() < 100_000
                {
                    usage.push(entry);
                }
            }
            usage
        });
        Ok(Self {
            child,
            input: Some(input),
            reader,
            directory,
            token,
        })
    }
    pub fn socket_path(&self) -> PathBuf {
        self.directory.path().join("model.sock")
    }
    /// Pass only to the controller's private runtime config, never a run record.
    pub fn capability(&self) -> &str {
        &self.token
    }
    pub async fn close(mut self) -> Result<Vec<serde_json::Value>> {
        if let Some(mut input) = self.input.take() {
            let _ = input.write_all(b"stop\n").await;
        }
        if tokio::time::timeout(Duration::from_secs(5), self.child.wait())
            .await
            .is_err()
        {
            self.child.kill().await?;
        }
        self.child.wait().await?;
        Ok(self.reader.await?)
    }
}

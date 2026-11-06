//! Account-local deployment. Authentication is borrowed from cf, never embedded or persisted.
use anyhow::{Context, Result, bail, ensure};
use clap::{Args, ValueEnum};
use reqwest::{Client, Method, multipart};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io::{self, IsTerminal, Write},
    path::{Path, PathBuf},
    time::Duration,
};

const BUNDLE: &str = include_str!("../../../worker/bundle/worker.mjs");
const API: &str = "https://api.cloudflare.com/client/v4";
const GATEWAY_RUN: &str = "644535f4ed854494a59cb289d634b257";

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, ValueEnum, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Runner {
    #[default]
    Sandbox,
    SelfHosted,
}
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, ValueEnum, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum CredentialStore {
    #[default]
    Keychain,
    File,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Deployment {
    pub account_id: Option<String>,
    pub name: String,
    pub cf_profile: String,
    pub runner: Runner,
    pub runner_image: Option<String>,
    pub workers_subdomain: Option<String>,
    pub credential_store: CredentialStore,
}
impl Default for Deployment {
    fn default() -> Self {
        Self {
            account_id: None,
            name: "rio".into(),
            cf_profile: "default".into(),
            runner: Runner::Sandbox,
            runner_image: None,
            workers_subdomain: None,
            credential_store: CredentialStore::Keychain,
        }
    }
}
impl Deployment {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            (3..=48).contains(&self.name.len())
                && self.name.starts_with(|c: char| c.is_ascii_lowercase())
                && self
                    .name
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-'),
            "deployment.name must be 3–48 lowercase letters, digits or hyphens, starting with a letter"
        );
        if let Some(account) = &self.account_id {
            ensure!(
                account.len() == 32 && account.bytes().all(|c| c.is_ascii_hexdigit()),
                "deployment.account_id must be a 32-character Cloudflare account ID"
            );
        }
        ensure!(
            !self.cf_profile.is_empty()
                && self
                    .cf_profile
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-'),
            "invalid Cloudflare profile name"
        );
        if let Some(image) = &self.runner_image {
            ensure!(
                !image.is_empty()
                    && !image.starts_with('-')
                    && !image.chars().any(char::is_whitespace),
                "invalid runner image reference"
            );
        }
        if let Some(subdomain) = &self.workers_subdomain {
            ensure!(
                !subdomain.is_empty()
                    && subdomain.len() <= 63
                    && !subdomain.starts_with('-')
                    && !subdomain.ends_with('-')
                    && subdomain
                        .bytes()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-'),
                "invalid workers.dev subdomain"
            );
        }
        Ok(())
    }
}
#[derive(Args, Default)]
pub struct DeployArgs {
    /// Reproduce deployment choices from a Rio user config (contains no secrets).
    #[arg(long)]
    pub from: Option<PathBuf>,
    #[arg(long)]
    pub account: Option<String>,
    #[arg(long)]
    pub name: Option<String>,
    #[arg(long)]
    pub cf_profile: Option<String>,
    #[arg(long, value_enum)]
    pub runner: Option<Runner>,
    /// Local Docker image, public image, or an existing registry.cloudflare.com reference.
    #[arg(long)]
    pub runner_image: Option<String>,
    /// Account subdomain to register if the account has none; existing subdomains are reused.
    #[arg(long)]
    pub workers_subdomain: Option<String>,
    /// Default: OS keychain. Use file explicitly on a headless host.
    #[arg(long, value_enum)]
    pub credential_store: Option<CredentialStore>,
    /// Private JSON file containing model provider keys or AI_GATEWAY_TOKEN; never copied to config.
    #[arg(long)]
    pub secrets_file: Option<PathBuf>,
    /// Print an offline plan without authentication, credential writes or account mutations.
    #[arg(long)]
    pub dry_run: bool,
}
fn configured_url(value: &toml::Value) -> Option<&str> {
    value
        .get("endpoint")
        .and_then(|e| e.get("url"))
        .and_then(toml::Value::as_str)
}
fn document(path: &Path) -> Result<toml::Value> {
    match std::fs::read_to_string(path) {
        Ok(text) => toml::from_str(&text)
            .with_context(|| format!("invalid configuration {}", path.display())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            Ok(toml::Value::Table(Default::default()))
        }
        Err(error) => Err(error.into()),
    }
}
pub fn choices(args: &DeployArgs, directory: &Path) -> Result<Deployment> {
    let path = args
        .from
        .clone()
        .unwrap_or_else(|| directory.join("config.toml"));
    if args.from.is_some() {
        ensure!(path.is_file(), "--from configuration does not exist");
    }
    let value = document(&path)?;
    if args.from.is_some() {
        ensure!(
            value.get("deployment").is_some(),
            "--from configuration must contain a [deployment] section"
        );
    }
    let mut deployment: Deployment = value
        .get("deployment")
        .cloned()
        .map(toml::Value::try_into)
        .transpose()?
        .unwrap_or_default();
    if let Some(account) = &args.account {
        deployment.account_id = Some(account.clone());
    }
    if deployment.account_id.is_none() {
        deployment.account_id = std::env::var("CLOUDFLARE_ACCOUNT_ID").ok();
    }
    if let Some(name) = &args.name {
        deployment.name = name.clone();
    }
    if let Some(profile) = &args.cf_profile {
        deployment.cf_profile = profile.clone();
    }
    if let Some(runner) = args.runner {
        deployment.runner = runner;
    }
    if let Some(image) = &args.runner_image {
        deployment.runner_image = Some(image.clone());
    }
    if let Some(subdomain) = &args.workers_subdomain {
        deployment.workers_subdomain = Some(subdomain.clone());
    }
    if let Some(store) = args.credential_store {
        deployment.credential_store = store;
    }
    deployment.validate()?;
    Ok(deployment)
}
#[derive(Default, Serialize, Deserialize)]
#[serde(transparent)]
struct Secrets(BTreeMap<String, String>);
impl Secrets {
    fn entry(deployment: &Deployment) -> Result<keyring::Entry> {
        keyring::Entry::new(
            "rio-deployment",
            &format!(
                "{}/{}",
                deployment
                    .account_id
                    .as_deref()
                    .context("missing account")?,
                deployment.name
            ),
        )
        .map_err(Into::into)
    }
    fn path(directory: &Path, deployment: &Deployment) -> PathBuf {
        directory.join(format!(
            "secrets-{}-{}.json",
            deployment.account_id.as_deref().unwrap_or("unknown"),
            deployment.name
        ))
    }
    fn load(directory: &Path, deployment: &Deployment) -> Result<Self> {
        let text = match deployment.credential_store {
            CredentialStore::Keychain => match Self::entry(deployment)?.get_password() {
                Ok(text) => Some(text),
                Err(keyring::Error::NoEntry) => None,
                Err(_) => bail!(
                    "OS keychain unavailable; unlock it, or explicitly choose --credential-store file on a headless host"
                ),
            },
            CredentialStore::File => {
                match std::fs::read_to_string(Self::path(directory, deployment)) {
                    Ok(text) => Some(text),
                    Err(error) if error.kind() == io::ErrorKind::NotFound => None,
                    Err(error) => return Err(error.into()),
                }
            }
        };
        text.map(|text| serde_json::from_str(&text).context("invalid saved deployment credentials"))
            .transpose()
            .map(Option::unwrap_or_default)
    }
    fn save(&self, directory: &Path, deployment: &Deployment) -> Result<()> {
        let text = serde_json::to_string(self)?;
        match deployment.credential_store {
            CredentialStore::Keychain => Self::entry(deployment)?
                .set_password(&text)
                .context("could not save deployment secrets to OS keychain"),
            CredentialStore::File => {
                rio_engine::atomic_write(&Self::path(directory, deployment), text.as_bytes())
            }
        }
    }
    fn collect(&mut self, file: Option<&Path>) -> Result<()> {
        const ALLOWED: &[&str] = &[
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "OPENROUTER_API_KEY",
            "AI_GATEWAY_TOKEN",
        ];
        if let Some(file) = file {
            let values: BTreeMap<String, String> = serde_json::from_slice(&std::fs::read(file)?)
                .map_err(|_| {
                    anyhow::anyhow!(
                        "--secrets-file must contain a JSON object of secret names to strings"
                    )
                })?;
            for (key, value) in values {
                ensure!(
                    ALLOWED.contains(&key.as_str()),
                    "unsupported name in --secrets-file"
                );
                ensure!(!value.trim().is_empty(), "empty value in --secrets-file");
                self.0.insert(key, value.trim().into());
            }
        }
        for key in ALLOWED {
            if let Ok(value) = std::env::var(key) {
                ensure!(
                    !value.trim().is_empty(),
                    "empty secret environment variable {key}"
                );
                self.0.insert((*key).into(), value.trim().into());
            }
        }
        if !["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"]
            .iter()
            .any(|key| self.0.contains_key(*key))
            && io::stdin().is_terminal()
        {
            eprintln!("Model provider: 1. OpenRouter (default)  2. OpenAI  3. Anthropic");
            eprint!("Select provider [1]: ");
            io::stderr().flush()?;
            let mut selection = String::new();
            io::stdin().read_line(&mut selection)?;
            let key = match selection.trim() {
                "" | "1" => "OPENROUTER_API_KEY",
                "2" => "OPENAI_API_KEY",
                "3" => "ANTHROPIC_API_KEY",
                _ => bail!("invalid provider selection"),
            };
            let value = rpassword::prompt_password("Provider API key (hidden): ")?;
            ensure!(!value.trim().is_empty(), "provider key cannot be empty");
            self.0.insert(key.into(), value.trim().into());
        }
        for key in ["RIO_API_TOKEN", "RUNNER_SECRET"] {
            if !self.0.contains_key(key) {
                let mut bytes = [0u8; 32];
                getrandom::fill(&mut bytes)
                    .map_err(|_| anyhow::anyhow!("OS random generator unavailable"))?;
                self.0.insert(
                    key.into(),
                    bytes.iter().map(|b| format!("{b:02x}")).collect(),
                );
            }
        }
        ensure!(
            ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"]
                .iter()
                .any(|key| self.0.contains_key(*key)),
            "provide a model key using OPENROUTER_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY or --secrets-file"
        );
        Ok(())
    }
}
pub fn endpoint_token(directory: &Path, endpoint: &str) -> Result<Option<String>> {
    let value = document(&directory.join("config.toml"))?;
    if configured_url(&value) != Some(endpoint) {
        return Ok(None);
    }
    let Some(deployment) = value.get("deployment") else {
        // `rio init --endpoint --token-stdin` stores the client token beside the
        // configuration and removes it when the endpoint changes, so it belongs
        // to exactly this URL.
        return Ok(std::fs::read_to_string(directory.join("credentials")).ok());
    };
    let deployment: Deployment = deployment.clone().try_into()?;
    Ok(Secrets::load(directory, &deployment)?
        .0
        .remove("RIO_API_TOKEN"))
}

struct Cloudflare {
    client: Client,
    base: String,
    token: String,
}
impl Cloudflare {
    fn new(token: String) -> Result<Self> {
        Ok(Self {
            client: Client::builder()
                .timeout(Duration::from_secs(90))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            base: API.into(),
            token,
        })
    }
    async fn request(&self, method: Method, path: &str, body: Option<Value>) -> Result<Value> {
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.base))
            .bearer_auth(&self.token);
        if let Some(body) = body {
            request = request.json(&body);
        }
        self.response(
            request.send().await.context("Cloudflare request failed")?,
            path,
        )
        .await
    }
    async fn optional(&self, path: &str) -> Result<Option<Value>> {
        let response = self
            .client
            .get(format!("{}{path}", self.base))
            .bearer_auth(&self.token)
            .send()
            .await?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        self.response(response, path).await.map(Some)
    }
    async fn response(&self, response: reqwest::Response, path: &str) -> Result<Value> {
        let status = response.status();
        let body: Value = response
            .json()
            .await
            .context("Cloudflare returned an invalid response")?;
        // Never print remote messages/bodies: secret and upload errors can echo credentials.
        ensure!(
            status.is_success() && body.get("success").and_then(Value::as_bool) != Some(false),
            "Cloudflare {path} failed (HTTP {}, API codes: {})",
            status.as_u16(),
            body.get("errors")
                .and_then(Value::as_array)
                .map(|errors| errors
                    .iter()
                    .filter_map(|e| e.get("code").and_then(Value::as_i64))
                    .map(|v| v.to_string())
                    .collect::<Vec<_>>()
                    .join(","))
                .unwrap_or_default()
        );
        Ok(body.get("result").cloned().unwrap_or(Value::Null))
    }
    async fn list(&self, path: &str) -> Result<Vec<Value>> {
        let mut values = Vec::new();
        for page in 1..=100 {
            let separator = if path.contains('?') { '&' } else { '?' };
            let result = self
                .request(
                    Method::GET,
                    &format!("{path}{separator}page={page}&per_page=100"),
                    None,
                )
                .await?;
            let items = result
                .as_array()
                .context("Cloudflare list response was not an array")?;
            values.extend(items.iter().cloned());
            if items.len() < 100 {
                return Ok(values);
            }
        }
        bail!("too many Cloudflare resources to enumerate safely")
    }
    async fn named(&self, path: &str, field: &str, name: &str, body: Value) -> Result<Value> {
        if let Some(value) = self
            .list(path)
            .await?
            .into_iter()
            .find(|v| v[field] == name)
        {
            return Ok(value);
        }
        // A failed create is not retried blindly; rerunning rio discovers any successful creation.
        self.request(Method::POST, path, Some(body)).await
    }
}
async fn authentication(profile: &str) -> Result<String> {
    if let Ok(token) = std::env::var("CLOUDFLARE_API_TOKEN") {
        ensure!(!token.is_empty(), "empty CLOUDFLARE_API_TOKEN");
        return Ok(token);
    }
    let mut result = tokio::process::Command::new("cf")
        .args(["--profile", profile, "auth", "whoami"])
        .output()
        .await
        .context("install Cloudflare cf CLI and run cf auth login, or set CLOUDFLARE_API_TOKEN")?;
    ensure!(
        result.status.success(),
        "Cloudflare authentication failed; run cf auth login"
    );
    let mut value: Value =
        serde_json::from_slice(&result.stdout).context("cf auth whoami did not return JSON")?;
    if (value["authenticated"] != true || value["tokenValid"] == false) && io::stdin().is_terminal()
    {
        ensure!(
            tokio::process::Command::new("cf")
                .args(["--profile", profile, "auth", "login"])
                .status()
                .await?
                .success(),
            "Cloudflare login failed"
        );
        result = tokio::process::Command::new("cf")
            .args(["--profile", profile, "auth", "whoami"])
            .output()
            .await?;
        value =
            serde_json::from_slice(&result.stdout).context("cf auth whoami did not return JSON")?;
    }
    ensure!(
        value["authenticated"] == true && value["tokenValid"] != false,
        "Cloudflare login is unavailable or expired; run cf auth login"
    );
    // whoami resolves directory/profile bindings and refreshes OAuth before we borrow it.
    let source = value["authSource"]
        .as_str()
        .and_then(|s| s.strip_prefix("OAuth token from "))
        .context("cf did not report its OAuth configuration path; use CLOUDFLARE_API_TOKEN")?;
    let config: Value =
        serde_json::from_slice(&std::fs::read(source).context("reading cf OAuth configuration")?)
            .context("invalid cf OAuth configuration")?;
    config["oauth_token"]
        .as_str()
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
        .context("cf OAuth token missing; run cf auth login")
}
fn select_account(accounts: &[Value], requested: Option<&str>) -> Result<String> {
    if let Some(requested) = requested {
        ensure!(
            accounts.iter().any(|a| a["id"] == requested),
            "selected account is not accessible with this Cloudflare login"
        );
        return Ok(requested.into());
    }
    if accounts.len() == 1 {
        return Ok(string(&accounts[0], "id")?.into());
    }
    if !io::stdin().is_terminal() {
        bail!(
            "Cloudflare login has {} accounts; select one with --account ACCOUNT_ID",
            accounts.len()
        );
    }
    ensure!(!accounts.is_empty(), "no accessible Cloudflare account");
    for (i, account) in accounts.iter().enumerate() {
        eprintln!(
            "{}. {} ({})",
            i + 1,
            account["name"].as_str().unwrap_or("Cloudflare account"),
            string(account, "id")?
        );
    }
    eprint!("Select Cloudflare account: ");
    io::stderr().flush()?;
    let mut line = String::new();
    io::stdin().read_line(&mut line)?;
    let choice = line
        .trim()
        .parse::<usize>()
        .context("expected account number")?;
    ensure!(
        choice > 0 && choice <= accounts.len(),
        "invalid account selection"
    );
    Ok(string(&accounts[choice - 1], "id")?.into())
}
fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .with_context(|| format!("Cloudflare response missing {key}"))
}
fn metadata(
    deployment: &Deployment,
    db: &str,
    queue: &str,
    secrets: &Secrets,
    migration_tag: Option<&str>,
) -> Value {
    let account = deployment.account_id.as_deref().unwrap();
    let name = &deployment.name;
    let mut bindings = vec![
        json!({"type":"d1","name":"DB","id":db}),
        json!({"type":"r2_bucket","name":"ARTIFACTS","bucket_name":format!("{name}-artifacts")}),
        json!({"type":"queue","name":"JOBS","queue_name":format!("{name}-jobs")}),
        json!({"type":"durable_object_namespace","name":"SANDBOX","class_name":"Sandbox"}),
        json!({"type":"workflow","name":"REVIEWS","workflow_name":format!("{name}-review"),"class_name":"ReviewWorkflow"}),
        json!({"type":"workflow","name":"MIGRATIONS","workflow_name":format!("{name}-migrate"),"class_name":"MigrationWorkflow"}),
        json!({"type":"plain_text","name":"RIO_VERSION","text":env!("RIO_VERSION")}),
        json!({"type":"plain_text","name":"RUNNER_BACKEND","text":if deployment.runner == Runner::Sandbox {"sandbox"} else {"self-hosted"}}),
        json!({"type":"plain_text","name":"AI_GATEWAY_URL","text":format!("https://gateway.ai.cloudflare.com/v1/{account}/{name}")}),
    ];
    for (name, text) in &secrets.0 {
        bindings.push(json!({"type":"secret_text","name":name,"text":text}));
    }
    let _ = queue; // Queue binding uses the account-local name; consumer setup uses its ID.
    let mut value = json!({"main_module":"worker.mjs","compatibility_date":"2026-11-01","compatibility_flags":["nodejs_compat"],"bindings":bindings});
    value["limits"] = json!({"cpu_ms":30000});
    value["tags"] = json!(["rio-managed"]);
    value["keep_bindings"] = json!(["plain_text", "json", "secret_text"]);
    if deployment.runner == Runner::Sandbox {
        value["containers"] = json!([{"class_name":"Sandbox"}]);
    }
    if migration_tag != Some("v1") {
        value["migrations"] = json!({"old_tag":migration_tag.unwrap_or(""),"new_tag":"v1","steps":[{"new_sqlite_classes":["Sandbox"]}]});
    }
    value
}
async fn runner_image(cf: &Cloudflare, deployment: &Deployment) -> Result<String> {
    let account = deployment.account_id.as_deref().unwrap();
    let image = deployment
        .runner_image
        .clone()
        .unwrap_or_else(|| format!("ghcr.io/pixelinfinito/rio-runner:{}", env!("RIO_VERSION")));
    if image.starts_with(&format!("registry.cloudflare.com/{account}/")) {
        return Ok(image);
    }
    let inspected = tokio::process::Command::new("docker").args(["image", "inspect", &image]).output().await.context("Sandbox deployment requires Docker to copy its released runner image; install/start Docker or choose --runner self-hosted")?;
    if !inspected.status.success() {
        eprintln!("Pulling released runner image…");
        let output = tokio::process::Command::new("docker")
            .args(["pull", "--platform", "linux/amd64", &image])
            .output()
            .await?;
        ensure!(
            output.status.success(),
            "runner image unavailable; release maintainers must publish the paired image, or supply --runner-image with an image you built"
        );
    }
    let tag = format!("{}-runner:{}", deployment.name, env!("RIO_VERSION"));
    ensure!(
        tokio::process::Command::new("docker")
            .args(["tag", &image, &tag])
            .output()
            .await?
            .status
            .success(),
        "could not tag runner image"
    );
    eprintln!("Copying runner image to your Cloudflare registry…");
    let mut pushed = false;
    for attempt in 1..=3 {
        let output = tokio::process::Command::new("cf")
            .args([
                "--profile",
                &deployment.cf_profile,
                "containers",
                "push",
                "--tag",
                &tag,
            ])
            .env("CLOUDFLARE_API_TOKEN", &cf.token)
            .env("CLOUDFLARE_ACCOUNT_ID", account)
            .output()
            .await
            .context("cf containers push requires the authenticated Cloudflare CLI")?;
        if output.status.success() {
            pushed = true;
            break;
        }
        if attempt < 3 {
            eprintln!("Registry push interrupted; retrying ({}/3)…", attempt + 1);
        }
    }
    ensure!(
        pushed,
        "cf containers push failed; check registry permissions and Docker authentication"
    );
    let remote = format!("registry.cloudflare.com/{account}/{tag}");
    let inspected = tokio::process::Command::new("docker")
        .args(["image", "inspect", &remote])
        .output()
        .await?;
    ensure!(
        inspected.status.success(),
        "could not inspect pushed runner image"
    );
    let images: Value =
        serde_json::from_slice(&inspected.stdout).context("invalid Docker image metadata")?;
    let prefix = format!(
        "registry.cloudflare.com/{account}/{}-runner@sha256:",
        deployment.name
    );
    images[0]["RepoDigests"]
        .as_array()
        .and_then(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .find(|s| s.starts_with(&prefix))
        })
        .map(str::to_owned)
        .context("Docker did not report the pushed image digest")
}

pub async fn run(args: DeployArgs) -> Result<()> {
    let directory = crate::config::config_directory()?;
    let mut deployment = choices(&args, &directory)?;
    if args.dry_run {
        println!(
            "{}",
            serde_json::to_string_pretty(
                &json!({"deployment":deployment,"worker_version":env!("RIO_VERSION"),"bundle_hash":blake3::hash(BUNDLE.as_bytes()).to_hex().to_string(),"resources":["Worker", "ReviewWorkflow", "MigrationWorkflow", "D1", "R2", "Queue", "AI Gateway"],"sandbox":deployment.runner == Runner::Sandbox,"mutations":false})
            )?
        );
        return Ok(());
    }
    let cf = Cloudflare::new(authentication(&deployment.cf_profile).await?)?;
    deployment.account_id = Some(select_account(
        &cf.list("/accounts").await?,
        deployment.account_id.as_deref(),
    )?);
    deployment.validate()?;
    rio_git::private_directory(&directory)?;
    let mut secrets = Secrets::load(&directory, &deployment)?;
    secrets.collect(args.secrets_file.as_deref())?;
    // Persist generated credentials before any resource mutation so a partial deployment is recoverable.
    secrets.save(&directory, &deployment)?;
    save_choices(&directory, &deployment, None)?;
    provision(&cf, &directory, &deployment, &mut secrets).await
}
fn save_choices(directory: &Path, deployment: &Deployment, endpoint: Option<&str>) -> Result<()> {
    let file = directory.join("config.toml");
    let mut value = document(&file)?;
    let table = value
        .as_table_mut()
        .context("configuration must be a TOML table")?;
    table.insert("deployment".into(), toml::Value::try_from(deployment)?);
    if let Some(endpoint) = endpoint {
        table.insert(
            "endpoint".into(),
            toml::Value::Table(
                [("url".into(), toml::Value::String(endpoint.into()))]
                    .into_iter()
                    .collect(),
            ),
        );
    }
    rio_engine::atomic_write(&file, toml::to_string_pretty(&value)?.as_bytes())
}
async fn provision(
    cf: &Cloudflare,
    directory: &Path,
    deployment: &Deployment,
    secrets: &mut Secrets,
) -> Result<()> {
    let account = deployment.account_id.as_deref().unwrap();
    let name = &deployment.name;
    let base = format!("/accounts/{account}");
    eprintln!("Deploying {name} to Cloudflare account {account}…");
    let image = if deployment.runner == Runner::Sandbox {
        Some(runner_image(cf, deployment).await?)
    } else {
        None
    };
    let db = cf
        .named(
            &format!("{base}/d1/database"),
            "name",
            name,
            json!({"name":name}),
        )
        .await?;
    let db_id = string(&db, "uuid")?;
    let buckets = cf
        .request(Method::GET, &format!("{base}/r2/buckets"), None)
        .await?;
    let bucket_name = format!("{name}-artifacts");
    if !buckets["buckets"]
        .as_array()
        .context("missing bucket list")?
        .iter()
        .any(|b| b["name"] == bucket_name)
    {
        cf.request(
            Method::POST,
            &format!("{base}/r2/buckets"),
            Some(json!({"name":bucket_name})),
        )
        .await?;
    }
    let queue = cf
        .named(
            &format!("{base}/queues"),
            "queue_name",
            &format!("{name}-jobs"),
            json!({"queue_name":format!("{name}-jobs")}),
        )
        .await?;
    let queue_id = string(&queue, "queue_id")?;
    let gateway = cf.named(&format!("{base}/ai-gateway/gateways"), "id", name, json!({"id":name,"authentication":true,"byok_only":true,"cache_invalidate_on_update":true,"cache_ttl":0,"collect_logs":false,"rate_limiting_interval":60,"rate_limiting_limit":120,"rate_limiting_technique":"fixed"})).await?;
    if gateway["authentication"] != true
        || gateway["collect_logs"] != false
        || gateway["cache_ttl"] != 0
    {
        cf.request(Method::PUT, &format!("{base}/ai-gateway/gateways/{name}"), Some(json!({"authentication":true,"byok_only":true,"cache_invalidate_on_update":true,"cache_ttl":0,"collect_logs":false,"rate_limiting_interval":60,"rate_limiting_limit":120,"rate_limiting_technique":"fixed"}))).await?;
    }
    if !secrets.0.contains_key("AI_GATEWAY_TOKEN") {
        let token = cf.request(Method::POST, &format!("{base}/tokens"), Some(json!({"name":format!("{name} AI Gateway inference"),"policies":[{"effect":"allow","resources":{format!("com.cloudflare.api.account.{account}"):"*"},"permission_groups":[{"id":GATEWAY_RUN}]}]}))).await?;
        secrets
            .0
            .insert("AI_GATEWAY_TOKEN".into(), string(&token, "value")?.into());
        secrets.save(directory, deployment)?;
    }
    let scripts = cf.list(&format!("{base}/workers/scripts")).await?;
    let existing = scripts.iter().find(|s| s["id"] == *name);
    if let Some(existing) = existing {
        ensure!(
            existing["tags"]
                .as_array()
                .is_some_and(|tags| tags.iter().any(|tag| tag == "rio-managed")),
            "Worker name already exists outside Rio; select an unused --name instead"
        );
    }
    let migration_tag = existing.and_then(|s| s["migration_tag"].as_str());
    ensure!(
        migration_tag.is_none() || migration_tag == Some("v1"),
        "Worker has an unsupported Durable Object migration tag; upgrade rather than downgrade"
    );
    for (suffix, class) in [
        ("review", "ReviewWorkflow"),
        ("migrate", "MigrationWorkflow"),
    ] {
        let workflows = cf.list(&format!("{base}/workflows")).await?;
        if let Some(existing) = workflows
            .iter()
            .find(|w| w["name"] == format!("{name}-{suffix}"))
        {
            ensure!(
                existing["script_name"] == *name && existing["class_name"] == class,
                "Workflow name belongs to another Worker"
            );
        }
    }
    let upload_path = format!("{base}/workers/scripts/{name}");
    let meta = metadata(deployment, db_id, queue_id, secrets, migration_tag);
    let form = multipart::Form::new()
        .text("metadata", serde_json::to_string(&meta)?)
        .part(
            "worker.mjs",
            multipart::Part::text(BUNDLE)
                .file_name("worker.mjs")
                .mime_str("application/javascript+module")?,
        );
    cf.response(
        cf.client
            .put(format!("{}{upload_path}", cf.base))
            .bearer_auth(&cf.token)
            .multipart(form)
            .send()
            .await
            .context("Worker upload failed")?,
        &upload_path,
    )
    .await?;
    for (suffix, class) in [
        ("review", "ReviewWorkflow"),
        ("migrate", "MigrationWorkflow"),
    ] {
        cf.request(
            Method::PUT,
            &format!("{base}/workflows/{name}-{suffix}"),
            Some(json!({"script_name":name,"class_name":class})),
        )
        .await?;
    }
    migrate(cf, &base, name).await?;
    let consumers_path = format!("{base}/queues/{queue_id}/consumers");
    let consumers = cf.list(&consumers_path).await?;
    let consumer = consumers
        .iter()
        .find(|c| c["script"] == *name || c["script_name"] == *name);
    ensure!(
        consumers.is_empty() || consumer.is_some(),
        "queue already has a consumer belonging to another Worker"
    );
    let body =
        json!({"type":"worker","script_name":name,"settings":{"batch_size":1,"max_retries":2}});
    if let Some(consumer) = consumer {
        cf.request(
            Method::PUT,
            &format!("{consumers_path}/{}", string(consumer, "consumer_id")?),
            Some(body),
        )
        .await?;
    } else {
        cf.request(Method::POST, &consumers_path, Some(body))
            .await?;
    }
    if let Some(image) = image {
        configure_container(cf, &base, name, &image).await?;
    }
    let subdomain_path = format!("{base}/workers/subdomain");
    let subdomain = cf
        .optional(&subdomain_path)
        .await?
        .and_then(|s| s["subdomain"].as_str().map(str::to_owned))
        .filter(|s| !s.is_empty());
    let subdomain = match subdomain {
        Some(subdomain) => subdomain,
        None => {
            let selected = deployment
                .workers_subdomain
                .clone()
                .unwrap_or_else(|| format!("rio-{}", &account[..12]));
            cf.request(
                Method::PUT,
                &subdomain_path,
                Some(json!({"subdomain":selected})),
            )
            .await?;
            selected
        }
    };
    cf.request(
        Method::POST,
        &format!("{upload_path}/subdomain"),
        Some(json!({"enabled":true,"previews_enabled":false})),
    )
    .await?;
    let endpoint = format!("https://{name}.{subdomain}.workers.dev");
    save_choices(directory, deployment, Some(&endpoint))?;
    let profiles = directory.join("profiles");
    let default_profile = profiles.join("default.yaml");
    if !default_profile.exists() {
        rio_git::private_directory(&profiles)?;
        let profile = if secrets.0.contains_key("OPENROUTER_API_KEY") {
            "version: 1\nname: rio-default\nextends: rio/openrouter\n".to_owned()
        } else {
            let model = if secrets.0.contains_key("OPENAI_API_KEY") {
                "openai/gpt-4.1-mini"
            } else {
                "anthropic/claude-haiku-4-5-20251001"
            };
            include_str!("../../../modules/profiles/openrouter.yaml")
                .replace("name: rio/openrouter", "name: rio-default")
                .replace("openrouter/anthropic/claude-sonnet-5.5", model)
                .replace("openrouter/openai/gpt-6.1-sol", model)
        };
        rio_engine::atomic_write(&default_profile, profile.as_bytes())?;
    }
    eprintln!(
        "Rio deployed: {endpoint}\nSaved account and resource choices in {}",
        directory.join("config.toml").display()
    );
    Ok(())
}
async fn migrate(cf: &Cloudflare, base: &str, name: &str) -> Result<()> {
    let release = format!("deploy-{}", &blake3::hash(BUNDLE.as_bytes()).to_hex()[..24]);
    let path = format!("{base}/workflows/{name}-migrate/instances");
    // Each release resumes its latest attempt. A failed attempt is final in Cloudflare,
    // so rerunning starts the next one; the migration ledger makes reruns idempotent.
    let existing = cf.list(&path).await?;
    let latest = existing
        .iter()
        .filter_map(|i| migration_attempt(&release, i["id"].as_str()?))
        .max();
    let attempt = match latest {
        Some(n) => {
            let status = cf
                .request(
                    Method::GET,
                    &format!("{path}/{}", attempt_id(&release, n)),
                    None,
                )
                .await?;
            if matches!(status["status"].as_str(), Some("errored" | "terminated")) {
                n + 1
            } else {
                n
            }
        }
        None => 0,
    };
    let instance = attempt_id(&release, attempt);
    if latest != Some(attempt) {
        cf.request(
            Method::POST,
            &path,
            Some(json!({"instance_id":instance,"params":{}})),
        )
        .await?;
    }
    for _ in 0..90 {
        let status = cf
            .request(Method::GET, &format!("{path}/{instance}"), None)
            .await?;
        match status["status"].as_str() {
            Some("complete") => return Ok(()),
            Some("errored" | "terminated") => bail!(
                "migration Workflow {instance} failed; inspect it in Cloudflare, then rerun rio deploy to retry"
            ),
            _ => tokio::time::sleep(Duration::from_secs(2)).await,
        }
    }
    bail!("migration Workflow still running; rerun rio deploy to resume")
}
/// Attempt 0 keeps the original `deploy-<hash>` ID so earlier deployments resume.
fn attempt_id(release: &str, attempt: u32) -> String {
    if attempt == 0 {
        release.to_owned()
    } else {
        format!("{release}-r{attempt}")
    }
}
fn migration_attempt(release: &str, id: &str) -> Option<u32> {
    match id.strip_prefix(release)? {
        "" => Some(0),
        rest => rest.strip_prefix("-r")?.parse().ok().filter(|n| *n > 0),
    }
}
async fn configure_container(cf: &Cloudflare, base: &str, name: &str, image: &str) -> Result<()> {
    let namespaces = cf
        .list(&format!("{base}/workers/durable_objects/namespaces"))
        .await?;
    let namespace = namespaces
        .iter()
        .find(|n| n["script"] == name && n["class"] == "Sandbox")
        .context("deployed Sandbox namespace missing")?;
    let namespace_id = string(namespace, "id")?;
    let path = format!("{base}/containers/applications");
    let apps = cf.list(&path).await?;
    let app_name = format!("{name}-sandbox");
    let existing = apps.iter().find(|a| a["name"] == app_name);
    // Cloudflare requires at least 3 GiB per vCPU. Sandbox jobs declare the
    // standard-3 ceiling (2 vCPUs / 8 GiB); Docker jobs retain their 2 GiB ceiling.
    let config = json!({"image":image,"instance_type":"standard-3"});
    if let Some(existing) = existing {
        ensure!(
            existing["durable_objects"]["namespace_id"] == namespace_id,
            "Sandbox application belongs to another Durable Object"
        );
        if existing["configuration"]["image"] != image {
            cf.request(
                Method::PATCH,
                &format!("{path}/{}", string(existing, "id")?),
                Some(json!({"configuration":config,"max_instances":5})),
            )
            .await?;
            cf.request(
                Method::POST,
                &format!("{path}/{}/rollouts", string(existing, "id")?),
                Some(json!({"description":"Rio runner upgrade","strategy":"rolling","kind":"full_auto","step_percentage":100,"target_configuration":config})),
            )
            .await?;
        }
    } else {
        cf.request(Method::POST, &path, Some(json!({"name":app_name,"scheduling_policy":"default","configuration":config,"instances":0,"max_instances":5,"durable_objects":{"namespace_id":namespace_id}}))).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::{
            Arc, Mutex,
            atomic::{AtomicBool, Ordering},
        },
    };

    #[test]
    fn account_selection_never_substitutes_another_account() {
        let accounts = vec![json!({"id":"a"}), json!({"id":"b"})];
        assert_eq!(select_account(&accounts, Some("b")).unwrap(), "b");
        assert!(select_account(&accounts, Some("unknown")).is_err());
        assert_eq!(select_account(&accounts[..1], None).unwrap(), "a");
    }
    #[test]
    fn copied_choices_allow_account_override_and_reject_invalid_names() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("input.toml");
        std::fs::write(&config, "[deployment]\naccount_id='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'\nname='rio-team'\nrunner='self-hosted'\ncredential_store='file'\n").unwrap();
        let args = DeployArgs {
            from: Some(config),
            account: Some("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into()),
            ..Default::default()
        };
        let deployment = choices(&args, dir.path()).unwrap();
        assert_eq!(
            deployment.account_id.as_deref(),
            Some("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
        );
        assert_eq!(deployment.name, "rio-team");
        assert_eq!(deployment.runner, Runner::SelfHosted);
        let mut bad = deployment;
        bad.name = "../outside".into();
        assert!(bad.validate().is_err());
    }
    #[test]
    fn credentials_are_private_and_separate_for_each_account() {
        let dir = tempfile::tempdir().unwrap();
        let a = Deployment {
            account_id: Some("a".repeat(32)),
            credential_store: CredentialStore::File,
            ..Default::default()
        };
        let b = Deployment {
            account_id: Some("b".repeat(32)),
            ..a.clone()
        };
        let secrets = Secrets(
            [("RIO_API_TOKEN".into(), "private-test-value".into())]
                .into_iter()
                .collect(),
        );
        secrets.save(dir.path(), &a).unwrap();
        assert!(Secrets::load(dir.path(), &b).unwrap().0.is_empty());
        assert_eq!(
            Secrets::load(dir.path(), &a).unwrap().0["RIO_API_TOKEN"],
            "private-test-value"
        );
        save_choices(dir.path(), &a, Some("https://rio.example.com")).unwrap();
        assert!(
            !std::fs::read_to_string(dir.path().join("config.toml"))
                .unwrap()
                .contains("private-test-value")
        );
        assert!(
            endpoint_token(dir.path(), "https://another.example.com")
                .unwrap()
                .is_none()
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(Secrets::path(dir.path(), &a))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
    #[test]
    fn failed_migration_attempts_get_new_instance_ids() {
        let release = "deploy-abc";
        assert_eq!(migration_attempt(release, "deploy-abc"), Some(0));
        assert_eq!(migration_attempt(release, "deploy-abc-r2"), Some(2));
        assert_eq!(migration_attempt(release, "deploy-abc-r0"), None);
        assert_eq!(migration_attempt(release, "deploy-abcd"), None);
        assert_eq!(migration_attempt(release, "deploy-other"), None);
        assert_eq!(attempt_id(release, 0), "deploy-abc");
        assert_eq!(attempt_id(release, 3), "deploy-abc-r3");
    }
    #[test]
    fn saved_client_token_is_sent_only_to_its_configured_endpoint() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("config.toml"),
            "[endpoint]\nurl = \"https://a.example.com\"\n",
        )
        .unwrap();
        std::fs::write(dir.path().join("credentials"), "token-for-endpoint-a").unwrap();
        assert_eq!(
            endpoint_token(dir.path(), "https://a.example.com")
                .unwrap()
                .as_deref(),
            Some("token-for-endpoint-a")
        );
        assert!(
            endpoint_token(dir.path(), "https://b.example.com")
                .unwrap()
                .is_none()
        );
    }
    #[test]
    fn sandbox_upload_enables_container_runtime_and_upgrade_preserves_migrations() {
        let deployment = Deployment {
            account_id: Some("a".repeat(32)),
            ..Default::default()
        };
        let value = metadata(&deployment, "db", "queue", &Secrets::default(), Some("v1"));
        assert_eq!(value["containers"][0]["class_name"], "Sandbox");
        assert!(value.get("migrations").is_none());
        assert_eq!(value["limits"]["cpu_ms"], 30000);
    }
    struct Mock {
        url: String,
        requests: Arc<Mutex<Vec<(String, String, String)>>>,
        stop: Arc<AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }
    impl Drop for Mock {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            self.thread.take().unwrap().join().unwrap();
        }
    }
    impl Mock {
        fn start(existing: bool, fail: bool) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let requests = Arc::new(Mutex::new(Vec::new()));
            let records = requests.clone();
            let stop = Arc::new(AtomicBool::new(false));
            let stopped = stop.clone();
            let thread = std::thread::spawn(move || {
                while !stopped.load(Ordering::Relaxed) {
                    let (mut stream, _) = match listener.accept() {
                        Ok(v) => v,
                        Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(5));
                            continue;
                        }
                        Err(e) => panic!("{e}"),
                    };
                    stream
                        .set_read_timeout(Some(Duration::from_secs(5)))
                        .unwrap();
                    let mut bytes = Vec::new();
                    let mut buf = [0; 4096];
                    let end = loop {
                        let n = stream.read(&mut buf).unwrap();
                        assert!(n > 0);
                        bytes.extend_from_slice(&buf[..n]);
                        if let Some(i) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                            break i + 4;
                        }
                    };
                    let header = String::from_utf8_lossy(&bytes[..end]).into_owned();
                    let length = header
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .map(str::to_owned)
                        })
                        .map(|v| v.parse::<usize>().unwrap())
                        .unwrap_or(0);
                    while bytes.len() < end + length {
                        let n = stream.read(&mut buf).unwrap();
                        assert!(n > 0);
                        bytes.extend_from_slice(&buf[..n]);
                    }
                    let mut parts = header.lines().next().unwrap().split_whitespace();
                    let method = parts.next().unwrap();
                    let path = parts.next().unwrap().split('?').next().unwrap();
                    let body = String::from_utf8_lossy(&bytes[end..]).into_owned();
                    records
                        .lock()
                        .unwrap()
                        .push((method.into(), path.into(), body));
                    let result = if path.ends_with("/d1/database") {
                        if method == "GET" {
                            if existing {
                                json!([{"name":"rio","uuid":"db-test"}])
                            } else {
                                json!([])
                            }
                        } else {
                            json!({"uuid":"db-test"})
                        }
                    } else if path.ends_with("/r2/buckets") {
                        json!({"buckets":if existing {json!([{"name":"rio-artifacts"}])} else {json!([])}})
                    } else if path.ends_with("/queues") {
                        if method == "GET" {
                            if existing {
                                json!([{"queue_name":"rio-jobs","queue_id":"queue-test"}])
                            } else {
                                json!([])
                            }
                        } else {
                            json!({"queue_id":"queue-test"})
                        }
                    } else if path.ends_with("/ai-gateway/gateways") {
                        if method == "GET" {
                            if existing {
                                json!([{"id":"rio","authentication":true,"cache_ttl":0,"collect_logs":false}])
                            } else {
                                json!([])
                            }
                        } else {
                            json!({"id":"rio","authentication":true,"cache_ttl":0,"collect_logs":false})
                        }
                    } else if path.ends_with("/tokens") {
                        json!({"value":"gateway-secret-value"})
                    } else if path.ends_with("/workers/scripts") {
                        if existing {
                            json!([{"id":"rio","migration_tag":"v1","tags":["rio-managed"]}])
                        } else {
                            json!([])
                        }
                    } else if path.ends_with("/workflows") {
                        json!([])
                    } else if path.ends_with("/instances") {
                        if method == "GET" {
                            json!([])
                        } else {
                            json!({"id":"migration"})
                        }
                    } else if path.contains("/instances/") {
                        json!({"status":"complete"})
                    } else if path.ends_with("/consumers") {
                        if method == "GET" {
                            if existing {
                                json!([{"script":"rio","consumer_id":"consumer"}])
                            } else {
                                json!([])
                            }
                        } else {
                            json!({})
                        }
                    } else if path.ends_with("/workers/subdomain") {
                        json!({"subdomain":"account-test"})
                    } else {
                        json!({})
                    };
                    let response = if fail {
                        json!({"success":false,"errors":[{"code":123,"message":"secret-echo-must-never-appear"}]})
                    } else {
                        json!({"success":true,"result":result})
                    };
                    let text = response.to_string();
                    write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", text.len(), text).unwrap();
                }
            });
            Self {
                url,
                requests,
                stop,
                thread: Some(thread),
            }
        }
    }
    #[tokio::test]
    async fn fresh_and_repeat_deployments_use_only_selected_account() {
        for existing in [false, true] {
            let mock = Mock::start(existing, false);
            let cf = Cloudflare {
                base: mock.url.clone(),
                ..Cloudflare::new("deployment-secret".into()).unwrap()
            };
            let directory = tempfile::tempdir().unwrap();
            let deployment = Deployment {
                account_id: Some("b".repeat(32)),
                runner: Runner::SelfHosted,
                credential_store: CredentialStore::File,
                ..Default::default()
            };
            let mut secrets = Secrets(
                [
                    ("RIO_API_TOKEN".into(), "api-secret".into()),
                    ("RUNNER_SECRET".into(), "runner-secret".into()),
                    ("OPENROUTER_API_KEY".into(), "provider-secret".into()),
                ]
                .into_iter()
                .collect(),
            );
            provision(&cf, directory.path(), &deployment, &mut secrets)
                .await
                .unwrap();
            let records = mock.requests.lock().unwrap();
            assert!(
                records
                    .iter()
                    .all(|(_, p, _)| p.starts_with(&format!("/accounts/{}/", "b".repeat(32))))
            );
            let creates = records
                .iter()
                .filter(|(m, p, _)| {
                    m == "POST"
                        && [
                            "/d1/database",
                            "/r2/buckets",
                            "/queues",
                            "/ai-gateway/gateways",
                        ]
                        .iter()
                        .any(|s| p.ends_with(s))
                })
                .count();
            assert_eq!(creates, if existing { 0 } else { 4 });
            let upload = records
                .iter()
                .find(|(m, p, _)| m == "PUT" && p.ends_with("/workers/scripts/rio"))
                .unwrap();
            assert!(
                upload.2.contains("provider-secret") && upload.2.contains("gateway-secret-value")
            );
            assert_eq!(upload.2.contains("new_sqlite_classes"), !existing);
            let saved = std::fs::read_to_string(directory.path().join("config.toml")).unwrap();
            assert!(saved.contains("rio.account-test.workers.dev"));
            assert!(!saved.contains("secret"));
        }
    }
    #[tokio::test]
    async fn api_errors_never_echo_remote_credentials() {
        let mock = Mock::start(false, true);
        let cf = Cloudflare {
            base: mock.url.clone(),
            ..Cloudflare::new("deployment-secret".into()).unwrap()
        };
        let error = cf
            .request(
                Method::POST,
                "/accounts/test/tokens",
                Some(json!({"secret":"local-secret"})),
            )
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("123"));
        assert!(!error.contains("secret-echo"));
        assert!(!error.contains("local-secret"));
    }
}

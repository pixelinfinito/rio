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

use crate::providers::{self, CustomProvider, DynamicRoute, ModelPrice, ProfileModels};

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
    /// Custom OpenAI-compatible or Anthropic endpoints in the AI Gateway.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub custom_providers: Vec<CustomProvider>,
    /// Explicit model prices in USD per million tokens (the Worker's MODEL_PRICES).
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub model_prices: BTreeMap<String, ModelPrice>,
    /// Gateway dynamic routes, called as `dynamic/<name>`.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub dynamic_routes: Vec<DynamicRoute>,
    /// The GitHub App step was chosen (`rio init --github-app`); replayed by `--from`.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub github_app: bool,
    /// Organization that owns the GitHub App, when not the user.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub github_org: Option<String>,
    /// The council allowlist (`rio init` council step): the endpoint's
    /// `COUNCIL_VENDORS` and the entries that fill placeholder members. Empty
    /// means no council. Keys are never stored here.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub council_vendors: Vec<rio_profile::VendorEntry>,
    /// The step a stopped deployment resumes at; cleared when it finishes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending: Option<String>,
    /// Prompt-cache hint classes and layout features: the Worker's
    /// `PROMPT_CACHE` and `PROMPT_LAYOUT`. Unset settings leave them unset.
    #[serde(skip_serializing_if = "PromptSettings::is_empty")]
    pub prompt: PromptSettings,
}
/// `[deployment.prompt]`: comma lists, validated with the Worker's value sets.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct PromptSettings {
    /// `off`, or hint classes from `anthropic`, `openai`, `openrouter`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache: Option<String>,
    /// Layout features from `agent-order`, `verifier-system`, `compaction`,
    /// `council-order`, `qa-order`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layout: Option<String>,
}
pub const HINT_CLASSES: [&str; 3] = ["anthropic", "openai", "openrouter"];
pub const LAYOUT_FEATURES: [&str; 5] = [
    "agent-order",
    "verifier-system",
    "compaction",
    "council-order",
    "qa-order",
];
impl PromptSettings {
    fn is_empty(&self) -> bool {
        self.cache.is_none() && self.layout.is_none()
    }
    /// Rejects an unknown value, naming it, as the Worker would at submission.
    pub fn validate(&self) -> Result<()> {
        let values = |list: &str| -> Vec<String> {
            list.split(',')
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
                .collect()
        };
        if let Some(cache) = &self.cache {
            let cache = values(cache);
            if cache != ["off"] {
                for value in &cache {
                    ensure!(
                        HINT_CLASSES.contains(&value.as_str()),
                        "deployment.prompt.cache: unknown hint class {value} (use off or a comma list of {})",
                        HINT_CLASSES.join(", ")
                    );
                }
            }
        }
        for value in values(self.layout.as_deref().unwrap_or_default()) {
            ensure!(
                LAYOUT_FEATURES.contains(&value.as_str()),
                "deployment.prompt.layout: unknown layout feature {value} (use a comma list of {})",
                LAYOUT_FEATURES.join(", ")
            );
        }
        Ok(())
    }
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
            custom_providers: Vec::new(),
            model_prices: BTreeMap::new(),
            dynamic_routes: Vec::new(),
            github_app: false,
            github_org: None,
            council_vendors: Vec::new(),
            pending: None,
            prompt: PromptSettings::default(),
        }
    }
}
/// Constant-time string equality for secrets and one-time values.
pub fn constant_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |n, (x, y)| n | (x ^ y)) == 0
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
        providers::validate(
            &self.custom_providers,
            &self.model_prices,
            &self.dynamic_routes,
        )?;
        self.prompt.validate()?;
        for entry in &self.council_vendors {
            entry
                .validate()
                .map_err(|message| anyhow::anyhow!("deployment.council_vendors: {message}"))?;
            let provider = entry.model.split('/').next().unwrap_or_default();
            if let Some(slug) = provider.strip_prefix("custom-") {
                ensure!(
                    self.custom_providers.iter().any(|p| p.slug == slug),
                    "deployment.council_vendors: route {} names custom provider {slug}, which is not configured",
                    entry.model
                );
            } else {
                ensure!(
                    matches!(
                        provider,
                        "openai" | "anthropic" | "openrouter" | "compat" | "dynamic"
                    ),
                    "deployment.council_vendors: route {} must start with openai/, anthropic/, openrouter/, custom-SLUG/, compat/ or dynamic/",
                    entry.model
                );
            }
        }
        Ok(())
    }
    /// The Worker key a council route needs, when it is a built-in provider's.
    fn council_keys(&self) -> Vec<&'static str> {
        let mut keys: Vec<_> = self
            .council_vendors
            .iter()
            .filter_map(|e| match e.model.split('/').next() {
                Some("openai") => Some("OPENAI_API_KEY"),
                Some("anthropic") => Some("ANTHROPIC_API_KEY"),
                Some("openrouter") => Some("OPENROUTER_API_KEY"),
                _ => None,
            })
            .collect();
        keys.sort_unstable();
        keys.dedup();
        keys
    }
}
/// Parse `VENDOR:FAMILY:ROUTE` from `--council-vendor`.
pub fn council_vendor(spec: &str) -> Result<rio_profile::VendorEntry> {
    let mut parts = spec.splitn(3, ':');
    let (Some(vendor), Some(family), Some(model)) = (parts.next(), parts.next(), parts.next())
    else {
        bail!(
            "--council-vendor must be VENDOR:FAMILY:ROUTE, for example google:gemini:compat/google-ai-studio/gemini-3-pro"
        );
    };
    let entry = rio_profile::VendorEntry {
        vendor: vendor.trim().into(),
        family: family.trim().into(),
        model: model.trim().into(),
    };
    entry
        .validate()
        .map_err(|message| anyhow::anyhow!("--council-vendor: {message}"))?;
    Ok(entry)
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
    /// Private JSON file containing model provider keys, AI_GATEWAY_TOKEN or
    /// AI_GATEWAY_PROVIDER_KEY_<SLUG> custom provider keys; never copied to config.
    #[arg(long)]
    pub secrets_file: Option<PathBuf>,
    /// Add or replace a custom AI Gateway provider: SLUG:PROTOCOL:BASE_URL, where
    /// PROTOCOL is openai or anthropic and BASE_URL is the API root that
    /// /chat/completions or /messages is appended to. Repeatable.
    #[arg(long = "custom-provider", value_name = "SLUG:PROTOCOL:BASE_URL")]
    pub custom_providers: Vec<String>,
    /// Generation model for a newly written personal default profile, e.g.
    /// custom-SLUG/MODEL; required with custom providers when that profile is absent.
    #[arg(long, value_name = "MODEL")]
    pub default_model: Option<String>,
    /// Verification model for a newly written personal default profile
    /// (defaults to --default-model).
    #[arg(long, value_name = "MODEL", requires = "default_model")]
    pub verifier_model: Option<String>,
    /// Print an offline plan without authentication, credential writes or account mutations.
    #[arg(long)]
    pub dry_run: bool,
    /// Allow a council vendor: VENDOR:FAMILY:ROUTE, where ROUTE is a model route
    /// such as anthropic/claude-sonnet-5.5 or custom-SLUG/MODEL. Repeatable;
    /// replaces the saved council allowlist. Built-in provider routes need that
    /// provider's key from the environment or --secrets-file.
    #[arg(
        long = "council-vendor",
        value_name = "VENDOR:FAMILY:ROUTE",
        conflicts_with = "no_council"
    )]
    pub council_vendors: Vec<String>,
    /// Skip the council step and clear any saved council allowlist.
    #[arg(long)]
    pub no_council: bool,
}
impl DeployArgs {
    /// Choices were given on the command line (the non-interactive init).
    pub fn chosen(&self) -> bool {
        self.from.is_some()
            || self.account.is_some()
            || self.name.is_some()
            || self.cf_profile.is_some()
            || self.runner.is_some()
            || self.runner_image.is_some()
            || self.workers_subdomain.is_some()
            || self.credential_store.is_some()
            || self.secrets_file.is_some()
            || !self.custom_providers.is_empty()
            || self.default_model.is_some()
            || self.verifier_model.is_some()
            || self.dry_run
            || !self.council_vendors.is_empty()
            || self.no_council
    }
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
    for provider in &mut deployment.custom_providers {
        provider.normalize();
    }
    // Route element files in an imported configuration are relative to that
    // file; keep them valid for later deployments from the user configuration.
    if let Some(source) = args.from.as_deref().and_then(Path::parent) {
        for route in &mut deployment.dynamic_routes {
            if route.elements_file.is_relative() {
                route.elements_file = std::path::absolute(source.join(&route.elements_file))?;
            }
        }
    }
    for spec in &args.custom_providers {
        let provider = CustomProvider::parse(spec)?;
        deployment
            .custom_providers
            .retain(|p| p.slug != provider.slug);
        deployment.custom_providers.push(provider);
    }
    if args.no_council {
        deployment.council_vendors.clear();
    } else if !args.council_vendors.is_empty() {
        deployment.council_vendors = args
            .council_vendors
            .iter()
            .map(|spec| council_vendor(spec))
            .collect::<Result<_>>()?;
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
    fn collect(&mut self, file: Option<&Path>, custom: &[CustomProvider]) -> Result<()> {
        const ALLOWED: &[&str] = &[
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "OPENROUTER_API_KEY",
            "AI_GATEWAY_TOKEN",
        ];
        let keys: Vec<String> = custom.iter().map(CustomProvider::key_name).collect();
        let allowed = |name: &str| ALLOWED.contains(&name) || keys.iter().any(|k| k == name);
        if let Some(file) = file {
            let values: BTreeMap<String, String> = serde_json::from_slice(&std::fs::read(file)?)
                .map_err(|_| {
                    anyhow::anyhow!(
                        "--secrets-file must contain a JSON object of secret names to strings"
                    )
                })?;
            for (key, value) in values {
                ensure!(
                    allowed(&key),
                    "unsupported name in --secrets-file (custom provider keys must name a configured provider)"
                );
                ensure!(!value.trim().is_empty(), "empty value in --secrets-file");
                self.0.insert(key, value.trim().into());
            }
        }
        for key in ALLOWED.iter().map(|k| k.to_string()).chain(keys) {
            if let Ok(value) = std::env::var(&key) {
                ensure!(
                    !value.trim().is_empty(),
                    "empty secret environment variable {key}"
                );
                self.0.insert(key, value.trim().into());
            }
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
        Ok(())
    }
    fn has_builtin_key(&self) -> bool {
        BUILTIN_KEYS.iter().any(|key| self.0.contains_key(*key))
    }
    /// Interactive provider choice when no model access is configured yet.
    fn prompt_provider(&mut self, deployment: &mut Deployment) -> Result<Option<ProfileModels>> {
        eprintln!(
            "Model provider: 1. OpenRouter (default)  2. OpenAI  3. Anthropic  4. Custom endpoint via AI Gateway (OpenAI-compatible or Anthropic)"
        );
        eprint!("Select provider [1]: ");
        io::stderr().flush()?;
        let mut selection = String::new();
        io::stdin().read_line(&mut selection)?;
        let key = match selection.trim() {
            "" | "1" => "OPENROUTER_API_KEY",
            "2" => "OPENAI_API_KEY",
            "3" => "ANTHROPIC_API_KEY",
            "4" => {
                let (provider, key, models) = providers::prompt()?;
                self.0.insert(provider.key_name(), key);
                deployment
                    .custom_providers
                    .retain(|p| p.slug != provider.slug);
                deployment.custom_providers.push(provider);
                deployment.validate()?;
                return Ok(Some(models));
            }
            _ => bail!("invalid provider selection"),
        };
        let value = rpassword::prompt_password("Provider API key (hidden): ")?;
        ensure!(!value.trim().is_empty(), "provider key cannot be empty");
        self.0.insert(key.into(), value.trim().into());
        Ok(None)
    }
    /// The opt-in council step after the primary provider: default no council.
    fn prompt_council(&mut self, deployment: &mut Deployment) -> Result<()> {
        eprint!(
            "Council: review unsettled findings with models from other vendors? Evidence packs go to every vendor you add. [y/N]: "
        );
        io::stderr().flush()?;
        let mut answer = String::new();
        io::stdin().read_line(&mut answer)?;
        if !matches!(answer.trim(), "y" | "Y" | "yes") {
            return Ok(());
        }
        loop {
            eprint!(
                "Council vendor as VENDOR:FAMILY:ROUTE (e.g. anthropic:claude:anthropic/claude-sonnet-5.5), empty to finish: "
            );
            io::stderr().flush()?;
            let mut line = String::new();
            io::stdin().read_line(&mut line)?;
            if line.trim().is_empty() {
                break;
            }
            let entry = council_vendor(line.trim())?;
            deployment.council_vendors.retain(|e| e != &entry);
            deployment.council_vendors.push(entry);
            deployment.validate()?;
        }
        for key in deployment.council_keys() {
            if !self.0.contains_key(key) {
                let value = rpassword::prompt_password(format!("{key} (hidden): "))?;
                ensure!(!value.trim().is_empty(), "provider key cannot be empty");
                self.0.insert(key.into(), value.trim().into());
            }
        }
        Ok(())
    }
    /// Secrets uploaded to the Worker: custom provider keys stay in the gateway.
    fn worker(&self) -> impl Iterator<Item = (&String, &String)> {
        self.0.iter().filter(|(name, _)| {
            !name.starts_with(providers::KEY_PREFIX)
                && !name.starts_with(providers::APPLIED_PREFIX)
                && !name.starts_with(providers::STATE_PREFIX)
        })
    }
}
const BUILTIN_KEYS: [&str; 3] = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"];
/// The default profile's models for the primary provider keys, chosen as the
/// default profile would choose them from those keys alone.
fn primary_models(primary: &[&str]) -> Option<ProfileModels> {
    let (default, verifier) = if primary.contains(&"OPENROUTER_API_KEY") {
        (
            "openrouter/anthropic/claude-sonnet-5.5",
            "openrouter/openai/gpt-6.1-sol",
        )
    } else if primary.contains(&"OPENAI_API_KEY") {
        ("openai/gpt-4.1-mini", "openai/gpt-4.1-mini")
    } else if primary.contains(&"ANTHROPIC_API_KEY") {
        (
            "anthropic/claude-haiku-4-5-20251001",
            "anthropic/claude-haiku-4-5-20251001",
        )
    } else {
        return None;
    };
    Some(ProfileModels {
        default: default.into(),
        verifier: verifier.into(),
    })
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

pub(crate) struct Cloudflare {
    client: Client,
    base: String,
    token: String,
}
impl Cloudflare {
    /// A client for another API root (recorded tests).
    #[cfg(test)]
    pub(crate) fn at(base: &str, token: &str) -> Result<Self> {
        Ok(Self {
            base: base.into(),
            ..Self::new(token.into())?
        })
    }
    pub(crate) fn new(token: String) -> Result<Self> {
        Ok(Self {
            client: Client::builder()
                .timeout(Duration::from_secs(90))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            base: API.into(),
            token,
        })
    }
    pub(crate) async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value> {
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
        // Some AI Gateway endpoints answer with `data` instead of `result`.
        Ok(body
            .get("result")
            .or_else(|| body.get("data"))
            .cloned()
            .unwrap_or(Value::Null))
    }
    pub(crate) async fn list(&self, path: &str) -> Result<Vec<Value>> {
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
    /// The resource named `name`, created when missing; `true` when it existed.
    async fn named_or_created(
        &self,
        path: &str,
        field: &str,
        name: &str,
        body: Value,
    ) -> Result<(Value, bool)> {
        if let Some(value) = self
            .list(path)
            .await?
            .into_iter()
            .find(|v| v[field] == name)
        {
            return Ok((value, true));
        }
        // A failed create is not retried blindly; rerunning rio discovers any successful creation.
        Ok((self.request(Method::POST, path, Some(body)).await?, false))
    }
}
pub(crate) async fn authentication(profile: &str) -> Result<String> {
    authenticate_with(profile, io::stdin().is_terminal()).await
}
/// The Cloudflare token: `CLOUDFLARE_API_TOKEN`, else the cf login, which is
/// renewed with `cf auth login` only when `interactive`.
async fn authenticate_with(profile: &str, interactive: bool) -> Result<String> {
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
    if (value["authenticated"] != true || value["tokenValid"] == false) && interactive {
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
fn select_account(
    accounts: &[Value],
    requested: Option<&str>,
    interactive: bool,
) -> Result<String> {
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
    if !interactive {
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
/// Requests one review's workflow may make to storage and the network
/// (Cloudflare's `limits.subrequests`; its default is 10,000). The platform
/// ends an instance at the limit with no report, so the Worker counts a
/// review's requests against this number and gives up searches, then model
/// turns, before it: the number is headroom for large trees, the count is what
/// bounds the work.
const SUBREQUEST_LIMIT: u64 = 50_000;
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
    // Always written, so removing every custom provider clears it.
    bindings.push(json!({"type":"plain_text","name":"AI_GATEWAY_PROVIDERS","text":providers::runtime(&deployment.custom_providers)}));
    // Always written, so skipping the council step clears the allowlist.
    bindings.push(json!({"type":"plain_text","name":"COUNCIL_VENDORS","text":serde_json::to_string(&deployment.council_vendors).unwrap()}));
    // Written only when configured; the Worker is uploaded whole, so removing a
    // setting leaves the variable unset (no hints, no layout feature).
    if let Some(cache) = &deployment.prompt.cache {
        bindings.push(json!({"type":"plain_text","name":"PROMPT_CACHE","text":cache}));
    }
    if let Some(layout) = &deployment.prompt.layout {
        bindings.push(json!({"type":"plain_text","name":"PROMPT_LAYOUT","text":layout}));
    }
    if !deployment.model_prices.is_empty() || secrets.0.contains_key(providers::PRICES_MARKER) {
        bindings.push(json!({"type":"plain_text","name":"MODEL_PRICES","text":providers::prices(&deployment.model_prices)}));
    }
    for (name, text) in secrets.worker() {
        bindings.push(json!({"type":"secret_text","name":name,"text":text}));
    }
    // The Worker budgets a review's storage requests against the limit it is told.
    bindings.push(
        json!({"type":"plain_text","name":"SUBREQUEST_LIMIT","text":SUBREQUEST_LIMIT.to_string()}),
    );
    let _ = queue; // Queue binding uses the account-local name; consumer setup uses its ID.
    let mut value = json!({"main_module":"worker.mjs","compatibility_date":"2026-11-01","compatibility_flags":["nodejs_compat"],"bindings":bindings});
    // Workers' maximum: a review step's CPU allowance (bounded work, not a fix for unbounded work).
    value["limits"] = json!({"cpu_ms":300000,"subrequests":SUBREQUEST_LIMIT});
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
/// The deployment's named steps, in order. Each is idempotent: it reuses what
/// exists and creates or updates only what is missing or different, so a
/// stopped deployment resumes at any step. The interactive UI shows these ids
/// (`rio_tui::init::STEPS`).
pub const STEPS: [&str; 16] = [
    "authenticate",
    "account",
    "secrets",
    "runner-image",
    "registry-copy",
    "d1",
    "r2",
    "queue",
    "ai-gateway",
    "gateway-token",
    "worker-upload",
    "workflows",
    "migrations",
    "queue-consumer",
    "sandbox-rollout",
    "workers-dev",
];
/// The steps only the Cloudflare Sandbox runner has.
const SANDBOX_STEPS: [&str; 3] = ["runner-image", "registry-copy", "sandbox-rollout"];
fn step_index(step: &str) -> usize {
    STEPS.iter().position(|s| *s == step).unwrap_or(0)
}

/// The state a step reports.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StepState {
    Running,
    Done,
    Reused,
    Skipped,
    Failed,
}

/// One progress update of a step, in the shape the interactive UI's
/// `"init:step"` value takes. Never carries a secret value: secrets are named only.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Progress {
    pub step: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<StepState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log: Option<String>,
    /// `info`, `warn` or `error`.
    pub level: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elapsed: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub migration: Option<Value>,
}

/// Receives every progress update.
pub type Reporter = std::sync::Arc<dyn Fn(Progress) + Send + Sync>;

/// A deployment stopped at `step`.
#[derive(Debug)]
pub struct Stopped {
    pub step: &'static str,
    pub error: anyhow::Error,
}

/// What a finished step did.
enum Outcome {
    Done(String),
    Reused(String),
    Skipped(String),
}

/// The deployment as named steps run in order, with the state they hand on
/// (the borrowed token, the account, secrets, resource ids). A stopped
/// deployment keeps that state, so a retry resumes at the stopped step
/// without repeating the ones before it.
pub struct Deployer {
    args: DeployArgs,
    directory: PathBuf,
    /// Prompts may read standard input (the terminal path without the UI).
    interactive: bool,
    /// Progress lines are printed on standard error (the path without the UI).
    echo: bool,
    /// Secrets typed into the interactive UI, by environment name.
    supplied: BTreeMap<String, String>,
    report: Reporter,
    /// Stop before the next step (Ctrl-C in the interactive UI).
    pub cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
    pub deployment: Deployment,
    fresh: bool,
    /// A token to use instead of the cf login, and another API root (tests).
    token: Option<String>,
    api: Option<String>,
    cf: Option<Cloudflare>,
    secrets: Secrets,
    models: Option<ProfileModels>,
    image: Option<String>,
    db_id: String,
    queue_id: String,
    migration_tag: Option<String>,
    endpoint: Option<String>,
    /// Resources created or reused so far: `(kind, name, reused)`.
    pub resources: Vec<(String, String, bool)>,
    /// Retries during the deployment (registry pushes).
    pub retries: u32,
    /// Whether the default profile was written.
    pub profile_written: bool,
    /// The next step to run.
    next: usize,
}

impl Deployer {
    /// A deployment of the choices `args` and the user config resolve.
    pub fn new(args: DeployArgs, interactive: bool, echo: bool, report: Reporter) -> Result<Self> {
        Self::at(
            crate::config::config_directory()?,
            args,
            interactive,
            echo,
            report,
        )
    }

    pub(crate) fn at(
        directory: PathBuf,
        args: DeployArgs,
        interactive: bool,
        echo: bool,
        report: Reporter,
    ) -> Result<Self> {
        let saved = document(&directory.join("config.toml"))?;
        // The council question is asked once, on a first deployment: one that
        // never finished counts as first.
        let fresh = match saved.get("deployment") {
            None => true,
            Some(deployment) => {
                deployment.get("pending").is_some() && configured_url(&saved).is_none()
            }
        };
        let mut deployment = choices(&args, &directory)?;
        deployment.pending = None;
        Ok(Self {
            args,
            directory,
            interactive,
            echo,
            supplied: BTreeMap::new(),
            report,
            cancel: Default::default(),
            deployment,
            fresh,
            token: None,
            api: None,
            cf: None,
            secrets: Secrets::default(),
            models: None,
            image: None,
            db_id: String::new(),
            queue_id: String::new(),
            migration_tag: None,
            endpoint: None,
            resources: Vec::new(),
            retries: 0,
            profile_written: false,
            next: 0,
        })
    }

    /// Supply a secret typed into the interactive UI (a provider key).
    pub fn supply(&mut self, name: &str, value: String) -> Result<()> {
        ensure!(
            BUILTIN_KEYS.contains(&name) || name == "AI_GATEWAY_TOKEN",
            "unsupported secret name"
        );
        ensure!(!value.trim().is_empty(), "provider key cannot be empty");
        self.supplied.insert(name.into(), value.trim().into());
        Ok(())
    }

    /// A secret of that name is held (never its value).
    pub fn has_secret(&self, name: &str) -> bool {
        self.secrets.0.contains_key(name) || self.supplied.contains_key(name)
    }

    /// The step a retry starts at (the stopped one).
    pub fn next_step(&self) -> &'static str {
        STEPS[self.next.min(STEPS.len() - 1)]
    }

    /// The deployed endpoint, once the last step ran.
    pub fn endpoint(&self) -> Option<&str> {
        self.endpoint.as_deref()
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }

    /// Continue with the self-hosted runner: the Sandbox steps are skipped, and
    /// a Worker uploaded with the Sandbox declaration is uploaded again.
    pub fn switch_to_self_hosted(&mut self) -> Result<()> {
        self.deployment.runner = Runner::SelfHosted;
        self.image = None;
        self.next = self.next.min(step_index("worker-upload"));
        if self.next > step_index("secrets") {
            self.save_pending()?;
        }
        Ok(())
    }

    fn progress(&self, step: &'static str, update: Progress) {
        (self.report)(Progress { step, ..update });
    }

    /// A line of the deployment log, also printed on standard error without the UI.
    fn say(&self, step: &'static str, level: &'static str, text: String) {
        if self.echo {
            eprintln!("{text}");
        }
        self.progress(
            step,
            Progress {
                log: Some(text),
                level,
                ..Progress::default()
            },
        );
    }

    fn resource(&mut self, step: &'static str, kind: &str, name: &str, id: &str, reused: bool) {
        self.resources.push((kind.into(), name.into(), reused));
        self.progress(
            step,
            Progress {
                resource: Some(json!({"kind": kind, "name": name, "id": id,
                    "state": if reused { "reused" } else { "done" }})),
                level: "info",
                ..Progress::default()
            },
        );
    }

    /// Record the step a stopped deployment resumes at, with the choices.
    fn save_pending(&mut self) -> Result<()> {
        self.deployment.pending = Some(self.next_step().into());
        save_choices(&self.directory, &self.deployment, None)
    }

    /// Run the steps from the next one to the last. On failure the deployment
    /// keeps its state and `deployment.pending` names the stopped step.
    pub async fn run(&mut self) -> Result<(), Stopped> {
        if self.next == 0 {
            // The chosen configuration and the pending step are written before
            // the first remote step, so `rio init` can offer to resume.
            let written = rio_git::private_directory(&self.directory)
                .map_err(anyhow::Error::from)
                .and_then(|()| self.save_pending());
            if let Err(error) = written {
                return Err(Stopped {
                    step: STEPS[0],
                    error,
                });
            }
        }
        while self.next < STEPS.len() {
            let step = STEPS[self.next];
            if self.cancel.load(std::sync::atomic::Ordering::Relaxed) {
                return Err(Stopped {
                    step,
                    error: anyhow::anyhow!("interrupted; rio deploy resumes it"),
                });
            }
            if self.next > 0
                && let Err(error) = self.save_pending()
            {
                return Err(Stopped { step, error });
            }
            let started = std::time::Instant::now();
            self.progress(
                step,
                Progress {
                    state: Some(StepState::Running),
                    level: "info",
                    ..Progress::default()
                },
            );
            match self.step(step).await {
                Ok(outcome) => {
                    let (state, detail) = match outcome {
                        Outcome::Done(detail) => (StepState::Done, detail),
                        Outcome::Reused(detail) => (StepState::Reused, detail),
                        Outcome::Skipped(detail) => (StepState::Skipped, detail),
                    };
                    self.progress(
                        step,
                        Progress {
                            state: Some(state),
                            detail: Some(detail),
                            elapsed: Some(started.elapsed().as_secs_f64()),
                            level: "info",
                            ..Progress::default()
                        },
                    );
                    self.next += 1;
                }
                Err(error) => {
                    self.progress(
                        step,
                        Progress {
                            state: Some(StepState::Failed),
                            log: Some(rio_core::redact(&format!("{error:#}"))),
                            level: "error",
                            elapsed: Some(started.elapsed().as_secs_f64()),
                            ..Progress::default()
                        },
                    );
                    return Err(Stopped { step, error });
                }
            }
        }
        // Finished: nothing to resume.
        self.deployment.pending = None;
        save_choices(&self.directory, &self.deployment, None).map_err(|error| Stopped {
            step: STEPS[STEPS.len() - 1],
            error,
        })?;
        Ok(())
    }

    fn cf(&self) -> Result<&Cloudflare> {
        self.cf.as_ref().context("not authenticated")
    }

    fn base(&self) -> String {
        format!(
            "/accounts/{}",
            self.deployment.account_id.as_deref().unwrap_or_default()
        )
    }

    async fn step(&mut self, step: &'static str) -> Result<Outcome> {
        if SANDBOX_STEPS.contains(&step) && self.deployment.runner != Runner::Sandbox {
            if step == "runner-image" {
                self.preflight()?;
            }
            return Ok(Outcome::Skipped("self-hosted runner".into()));
        }
        match step {
            "authenticate" => self.authenticate().await,
            "account" => self.account().await,
            "secrets" => self.collect_secrets(),
            "runner-image" => {
                self.preflight()?;
                self.runner_image().await
            }
            "registry-copy" => self.registry_copy().await,
            "d1" => self.d1().await,
            "r2" => self.r2().await,
            "queue" => self.queue().await,
            "ai-gateway" => self.ai_gateway().await,
            "gateway-token" => self.gateway_token().await,
            "worker-upload" => self.worker_upload().await,
            "workflows" => self.workflows().await,
            "migrations" => self.migrations().await,
            "queue-consumer" => self.queue_consumer().await,
            "sandbox-rollout" => self.sandbox_rollout().await,
            "workers-dev" => self.workers_dev().await,
            other => bail!("unknown deployment step {other}"),
        }
    }

    async fn authenticate(&mut self) -> Result<Outcome> {
        let (token, how) = match self.token.take() {
            Some(token) => (token, "supplied token"),
            None if std::env::var_os("CLOUDFLARE_API_TOKEN").is_some() => (
                authenticate_with(&self.deployment.cf_profile, self.interactive).await?,
                "CLOUDFLARE_API_TOKEN",
            ),
            None => (
                authenticate_with(&self.deployment.cf_profile, self.interactive).await?,
                "cf OAuth",
            ),
        };
        let mut cf = Cloudflare::new(token)?;
        if let Some(api) = &self.api {
            cf.base = api.clone();
        }
        self.cf = Some(cf);
        Ok(Outcome::Done(how.into()))
    }

    async fn account(&mut self) -> Result<Outcome> {
        let accounts = self.cf()?.list("/accounts").await?;
        let id = select_account(
            &accounts,
            self.deployment.account_id.as_deref(),
            self.interactive,
        )?;
        let name = accounts
            .iter()
            .find(|a| a["id"] == id)
            .and_then(|a| a["name"].as_str())
            .unwrap_or("Cloudflare account")
            .to_owned();
        self.deployment.account_id = Some(id);
        self.deployment.validate()?;
        rio_git::private_directory(&self.directory)?;
        Ok(Outcome::Done(name))
    }

    fn collect_secrets(&mut self) -> Result<Outcome> {
        let directory = self.directory.clone();
        let mut secrets = Secrets::load(&directory, &self.deployment)?;
        secrets.collect(
            self.args.secrets_file.as_deref(),
            &self.deployment.custom_providers,
        )?;
        for (name, value) in &self.supplied {
            secrets.0.insert(name.clone(), value.clone());
        }
        let mut models = self
            .args
            .default_model
            .as_ref()
            .map(|default| ProfileModels {
                default: default.clone(),
                verifier: self
                    .args
                    .verifier_model
                    .clone()
                    .unwrap_or_else(|| default.clone()),
            });
        if !secrets.has_builtin_key()
            && self.deployment.custom_providers.is_empty()
            && self.interactive
        {
            models = secrets.prompt_provider(&mut self.deployment)?.or(models);
        }
        ensure!(
            secrets.has_builtin_key() || !self.deployment.custom_providers.is_empty(),
            "provide a model key using OPENROUTER_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY or --secrets-file, or configure a custom provider with --custom-provider"
        );
        if self.fresh
            && self.args.from.is_none()
            && self.args.council_vendors.is_empty()
            && !self.args.no_council
            && self.interactive
        {
            // Council keys must not change which provider ordinary reviews use.
            let primary: Vec<_> = BUILTIN_KEYS
                .iter()
                .filter(|key| secrets.0.contains_key(**key))
                .copied()
                .collect();
            secrets.prompt_council(&mut self.deployment)?;
            if models.is_none()
                && BUILTIN_KEYS
                    .iter()
                    .any(|k| secrets.0.contains_key(*k) && !primary.contains(k))
            {
                ensure!(
                    !primary.is_empty() || directory.join("profiles/default.yaml").exists(),
                    "with only custom providers, pass --default-model custom-SLUG/MODEL; council keys never choose the default profile's models"
                );
                models = primary_models(&primary);
            }
        }
        // The default council members need three families to run.
        let families: std::collections::BTreeSet<_> = self
            .deployment
            .council_vendors
            .iter()
            .map(|entry| entry.family.as_str())
            .collect();
        if !families.is_empty() && families.len() < 3 {
            self.say(
                "secrets",
                "warn",
                format!(
                    "Warning: the council allowlist spans {} model {}; rio/security and rio/critical need at least three",
                    families.len(),
                    if families.len() == 1 {
                        "family"
                    } else {
                        "families"
                    }
                ),
            );
        }
        let missing: Vec<_> = self
            .deployment
            .council_keys()
            .into_iter()
            .filter(|key| !secrets.0.contains_key(*key))
            .collect();
        ensure!(
            missing.is_empty(),
            "council routes need {} from the environment or --secrets-file",
            missing.join(", ")
        );
        let profile_needed = !directory.join("profiles/default.yaml").exists();
        ensure!(
            !profile_needed || models.is_some() || secrets.has_builtin_key(),
            "with only custom providers, pass --default-model custom-SLUG/MODEL (and optionally --verifier-model) so the default profile can be written, or create {} first",
            directory.join("profiles/default.yaml").display()
        );
        // Persist generated credentials before any resource mutation so a partial deployment is recoverable.
        secrets.save(&directory, &self.deployment)?;
        save_choices(&directory, &self.deployment, None)?;
        for name in secrets
            .worker()
            .map(|(name, _)| name.clone())
            .collect::<Vec<_>>()
        {
            self.progress(
                "secrets",
                Progress {
                    secret: Some(json!({"name": name, "done": true})),
                    level: "info",
                    ..Progress::default()
                },
            );
        }
        self.secrets = secrets;
        self.models = models;
        Ok(Outcome::Done(match self.deployment.credential_store {
            CredentialStore::Keychain => "saved in the OS keychain".into(),
            CredentialStore::File => "saved in a private file".into(),
        }))
    }

    /// Unreadable route definitions fail before anything is created or changed.
    fn preflight(&self) -> Result<()> {
        providers::check_routes(&self.directory, &self.deployment.dynamic_routes)?;
        self.say(
            "runner-image",
            "info",
            format!(
                "Deploying {} to Cloudflare account {}…",
                self.deployment.name,
                self.deployment.account_id.as_deref().unwrap_or_default()
            ),
        );
        Ok(())
    }

    /// The released (or supplied) runner image, pulled when Docker lacks it.
    async fn runner_image(&mut self) -> Result<Outcome> {
        let account = self.deployment.account_id.clone().unwrap_or_default();
        let image =
            self.deployment.runner_image.clone().unwrap_or_else(|| {
                format!("ghcr.io/pixelinfinito/rio-runner:{}", env!("RIO_VERSION"))
            });
        if image.starts_with(&format!("registry.cloudflare.com/{account}/")) {
            self.image = Some(image);
            return Ok(Outcome::Reused("already in your registry".into()));
        }
        let inspected = tokio::process::Command::new("docker").args(["image", "inspect", &image]).output().await.context("Sandbox deployment requires Docker to copy its released runner image; install/start Docker or choose --runner self-hosted")?;
        if !inspected.status.success() {
            self.say(
                "runner-image",
                "info",
                "Pulling released runner image…".into(),
            );
            let output = tokio::process::Command::new("docker")
                .args(["pull", "--platform", "linux/amd64", &image])
                .output()
                .await?;
            ensure!(
                output.status.success(),
                "runner image unavailable; release maintainers must publish the paired image, or supply --runner-image with an image you built"
            );
        }
        self.image = None;
        Ok(Outcome::Done(image))
    }

    /// The runner image copied to the account's registry, by digest.
    async fn registry_copy(&mut self) -> Result<Outcome> {
        if let Some(image) = &self.image {
            return Ok(Outcome::Reused(image.clone()));
        }
        let token = self.cf()?.token.clone();
        let deployment = self.deployment.clone();
        let account = deployment.account_id.as_deref().unwrap_or_default();
        let image = deployment
            .runner_image
            .clone()
            .unwrap_or_else(|| format!("ghcr.io/pixelinfinito/rio-runner:{}", env!("RIO_VERSION")));
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
        self.say(
            "registry-copy",
            "info",
            "Copying runner image to your Cloudflare registry…".into(),
        );
        let mut pushed = false;
        let mut retries = 0;
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
                .env("CLOUDFLARE_API_TOKEN", &token)
                .env("CLOUDFLARE_ACCOUNT_ID", account)
                .output()
                .await
                .context("cf containers push requires the authenticated Cloudflare CLI")?;
            if output.status.success() {
                pushed = true;
                break;
            }
            if attempt < 3 {
                retries += 1;
                self.say(
                    "registry-copy",
                    "warn",
                    format!("Registry push interrupted; retrying ({}/3)…", attempt + 1),
                );
            }
        }
        self.retries += retries;
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
        let digest = images[0]["RepoDigests"]
            .as_array()
            .and_then(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .find(|s| s.starts_with(&prefix))
            })
            .map(str::to_owned)
            .context("Docker did not report the pushed image digest")?;
        let name = format!("{}-runner", deployment.name);
        self.image = Some(digest.clone());
        self.resource("registry-copy", "Registry", &name, &digest, false);
        Ok(Outcome::Done(digest))
    }

    async fn d1(&mut self) -> Result<Outcome> {
        let name = self.deployment.name.clone();
        let (db, reused) = self
            .cf()?
            .named_or_created(
                &format!("{}/d1/database", self.base()),
                "name",
                &name,
                json!({"name":name}),
            )
            .await?;
        self.db_id = string(&db, "uuid")?.to_owned();
        let id = self.db_id.clone();
        self.resource("d1", "D1", &name, &id, reused);
        Ok(found(reused, name))
    }

    async fn r2(&mut self) -> Result<Outcome> {
        let base = self.base();
        let cf = self.cf()?;
        let buckets = cf
            .request(Method::GET, &format!("{base}/r2/buckets"), None)
            .await?;
        let bucket_name = format!("{}-artifacts", self.deployment.name);
        let reused = buckets["buckets"]
            .as_array()
            .context("missing bucket list")?
            .iter()
            .any(|b| b["name"] == bucket_name);
        if !reused {
            cf.request(
                Method::POST,
                &format!("{base}/r2/buckets"),
                Some(json!({"name":bucket_name})),
            )
            .await?;
        }
        self.resource("r2", "R2", &bucket_name, "—", reused);
        Ok(found(reused, bucket_name))
    }

    async fn queue(&mut self) -> Result<Outcome> {
        let queue_name = format!("{}-jobs", self.deployment.name);
        let (queue, reused) = self
            .cf()?
            .named_or_created(
                &format!("{}/queues", self.base()),
                "queue_name",
                &queue_name,
                json!({"queue_name":queue_name}),
            )
            .await?;
        self.queue_id = string(&queue, "queue_id")?.to_owned();
        let id = self.queue_id.clone();
        self.resource("queue", "Queue", &queue_name, &id, reused);
        Ok(found(reused, queue_name))
    }

    async fn ai_gateway(&mut self) -> Result<Outcome> {
        let base = self.base();
        let name = self.deployment.name.clone();
        let cf = self.cf()?;
        let (gateway, reused) = cf.named_or_created(&format!("{base}/ai-gateway/gateways"), "id", &name, json!({"id":name,"authentication":true,"byok_only":true,"cache_invalidate_on_update":true,"cache_ttl":0,"collect_logs":false,"rate_limiting_interval":60,"rate_limiting_limit":120,"rate_limiting_technique":"fixed"})).await?;
        if gateway["authentication"] != true
            || gateway["collect_logs"] != false
            || gateway["cache_ttl"] != 0
        {
            cf.request(Method::PUT, &format!("{base}/ai-gateway/gateways/{name}"), Some(json!({"authentication":true,"byok_only":true,"cache_invalidate_on_update":true,"cache_ttl":0,"collect_logs":false,"rate_limiting_interval":60,"rate_limiting_limit":120,"rate_limiting_technique":"fixed"}))).await?;
        }
        self.resource("ai-gateway", "Gateway", &name, &name, reused);
        Ok(found(reused, format!("{name} · auth on · logs off")))
    }

    async fn gateway_token(&mut self) -> Result<Outcome> {
        let base = self.base();
        let account = self.deployment.account_id.clone().unwrap_or_default();
        let name = self.deployment.name.clone();
        let cf = self.cf.as_ref().context("not authenticated")?;
        let mut reused = true;
        if !self.secrets.0.contains_key("AI_GATEWAY_TOKEN") {
            let token = cf.request(Method::POST, &format!("{base}/tokens"), Some(json!({"name":format!("{name} AI Gateway inference"),"policies":[{"effect":"allow","resources":{format!("com.cloudflare.api.account.{account}"):"*"},"permission_groups":[{"id":GATEWAY_RUN}]}]}))).await?;
            self.secrets
                .0
                .insert("AI_GATEWAY_TOKEN".into(), string(&token, "value")?.into());
            self.secrets.save(&self.directory, &self.deployment)?;
            reused = false;
        }
        if providers::reconcile_providers(
            cf,
            &base,
            &name,
            &self.deployment.custom_providers,
            &mut self.secrets.0,
        )
        .await?
        {
            self.secrets.save(&self.directory, &self.deployment)?;
        }
        providers::reconcile_routes(
            cf,
            &format!("{base}/ai-gateway/gateways/{name}"),
            &self.directory,
            &self.deployment.dynamic_routes,
        )
        .await?;
        Ok(found(reused, "AI Gateway Run · account".into()))
    }

    async fn worker_upload(&mut self) -> Result<Outcome> {
        let base = self.base();
        let name = self.deployment.name.clone();
        let cf = self.cf.as_ref().context("not authenticated")?;
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
        let migration_tag = existing
            .and_then(|s| s["migration_tag"].as_str())
            .map(str::to_owned);
        ensure!(
            migration_tag.is_none() || migration_tag.as_deref() == Some("v1"),
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
        if !self.deployment.model_prices.is_empty()
            && !self.secrets.0.contains_key(providers::PRICES_MARKER)
        {
            self.secrets
                .0
                .insert(providers::PRICES_MARKER.into(), "1".into());
            self.secrets.save(&self.directory, &self.deployment)?;
        }
        let meta = metadata(
            &self.deployment,
            &self.db_id,
            &self.queue_id,
            &self.secrets,
            migration_tag.as_deref(),
        );
        let form = multipart::Form::new()
            .text("metadata", serde_json::to_string(&meta)?)
            .part(
                "worker.mjs",
                multipart::Part::text(BUNDLE)
                    .file_name("worker.mjs")
                    .mime_str("application/javascript+module")?,
            );
        let uploaded = cf
            .response(
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
        // The empty MODEL_PRICES just uploaded replaced Rio's earlier prices.
        if self.deployment.model_prices.is_empty()
            && self.secrets.0.remove(providers::PRICES_MARKER).is_some()
        {
            self.secrets.save(&self.directory, &self.deployment)?;
        }
        let reused = existing.is_some();
        self.migration_tag = migration_tag;
        let version = uploaded["id"]
            .as_str()
            .or(uploaded["etag"].as_str())
            .unwrap_or("—")
            .to_owned();
        self.resource("worker-upload", "Worker", &name, &version, reused);
        Ok(Outcome::Done(if reused {
            "bundle · bindings · updated".into()
        } else {
            "bundle · bindings".into()
        }))
    }

    async fn workflows(&mut self) -> Result<Outcome> {
        let base = self.base();
        let name = self.deployment.name.clone();
        for (suffix, class) in [
            ("review", "ReviewWorkflow"),
            ("migrate", "MigrationWorkflow"),
        ] {
            self.cf()?
                .request(
                    Method::PUT,
                    &format!("{base}/workflows/{name}-{suffix}"),
                    Some(json!({"script_name":name,"class_name":class})),
                )
                .await?;
        }
        self.resource(
            "workflows",
            "Workflows",
            &format!("{name}-review"),
            "—",
            false,
        );
        self.resource("workflows", "", &format!("{name}-migrate"), "—", false);
        Ok(Outcome::Done(format!("{name}-review · {name}-migrate")))
    }

    async fn migrations(&mut self) -> Result<Outcome> {
        let base = self.base();
        let name = self.deployment.name.clone();
        let cf = self.cf()?;
        migrate(cf, &base, &name).await?;
        // Expiries are per run, not bucket-wide. Register the bounded evidence
        // sweep after migrations; the Worker only needs its existing R2 binding.
        cf.request(
            Method::PUT,
            &format!("{base}/workers/scripts/{name}/schedules"),
            Some(json!([{"cron":"* * * * *"}])),
        )
        .await?;
        Ok(Outcome::Done("D1 schema · evidence sweep".into()))
    }

    async fn queue_consumer(&mut self) -> Result<Outcome> {
        let base = self.base();
        let name = self.deployment.name.clone();
        let cf = self.cf()?;
        let consumers_path = format!("{base}/queues/{}/consumers", self.queue_id);
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
        let reused = consumer.is_some();
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
        Ok(found(reused, format!("{name}-jobs → {name}")))
    }

    async fn sandbox_rollout(&mut self) -> Result<Outcome> {
        let image = self
            .image
            .clone()
            .context("the runner image was not copied; retry from the registry copy")?;
        let name = self.deployment.name.clone();
        configure_container(self.cf()?, &self.base(), &name, &image).await?;
        self.resource("sandbox-rollout", "Sandbox", SANDBOX_INSTANCE, "—", false);
        Ok(Outcome::Done(format!("{SANDBOX_INSTANCE} · rolling")))
    }

    async fn workers_dev(&mut self) -> Result<Outcome> {
        let base = self.base();
        let account = self.deployment.account_id.clone().unwrap_or_default();
        let name = self.deployment.name.clone();
        let cf = self.cf()?;
        let subdomain_path = format!("{base}/workers/subdomain");
        let subdomain = cf
            .optional(&subdomain_path)
            .await?
            .and_then(|s| s["subdomain"].as_str().map(str::to_owned))
            .filter(|s| !s.is_empty());
        let subdomain = match subdomain {
            Some(subdomain) => subdomain,
            None => {
                let selected = self
                    .deployment
                    .workers_subdomain
                    .clone()
                    .unwrap_or_else(|| format!("rio-{}", &account[..12.min(account.len())]));
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
            &format!("{base}/workers/scripts/{name}/subdomain"),
            Some(json!({"enabled":true,"previews_enabled":false})),
        )
        .await?;
        let endpoint = format!("https://{name}.{subdomain}.workers.dev");
        save_choices(&self.directory, &self.deployment, Some(&endpoint))?;
        let profiles = self.directory.join("profiles");
        let default_profile = profiles.join("default.yaml");
        if !default_profile.exists() {
            rio_git::private_directory(&profiles)?;
            let secrets = &self.secrets;
            let profile = if let Some(models) = &self.models {
                include_str!("../../../modules/profiles/openrouter.yaml")
                    .replace("name: rio/openrouter", "name: rio-default")
                    .replace("openrouter/anthropic/claude-sonnet-5.5", &models.default)
                    .replace("openrouter/openai/gpt-6.1-sol", &models.verifier)
            } else if secrets.0.contains_key("OPENROUTER_API_KEY") {
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
            self.profile_written = true;
        }
        self.say(
            "workers-dev",
            "info",
            format!(
                "Rio deployed: {endpoint}\nSaved account and resource choices in {}",
                self.directory.join("config.toml").display()
            ),
        );
        self.endpoint = Some(endpoint.clone());
        Ok(Outcome::Done(
            endpoint.trim_start_matches("https://").into(),
        ))
    }
}

fn found(reused: bool, detail: String) -> Outcome {
    if reused {
        Outcome::Reused(format!("{detail} · reused"))
    } else {
        Outcome::Done(detail)
    }
}

/// The offline plan `--dry-run` prints: no authentication, credential writes
/// or account mutations.
pub fn plan(args: &DeployArgs) -> Result<Value> {
    let directory = crate::config::config_directory()?;
    let mut deployment = choices(args, &directory)?;
    deployment.pending = None;
    Ok(
        json!({"deployment":deployment,"worker_version":env!("RIO_VERSION"),"bundle_hash":blake3::hash(BUNDLE.as_bytes()).to_hex().to_string(),"resources":["Worker", "ReviewWorkflow", "MigrationWorkflow", "D1", "R2", "Queue", "AI Gateway"],"sandbox":deployment.runner == Runner::Sandbox,"mutations":false}),
    )
}

/// The accounts the Cloudflare login reaches as `(id, name)`, read without
/// logging in again (the interactive UI's account choice).
pub async fn accounts(profile: &str) -> Result<Vec<(String, String)>> {
    let cf = Cloudflare::new(authenticate_with(profile, false).await?)?;
    Ok(cf
        .list("/accounts")
        .await?
        .iter()
        .filter_map(|a| {
            Some((
                a["id"].as_str()?.to_owned(),
                a["name"]
                    .as_str()
                    .unwrap_or("Cloudflare account")
                    .to_owned(),
            ))
        })
        .collect())
}

/// The step a stopped deployment recorded in the user config, if any.
pub fn pending() -> Option<String> {
    let directory = crate::config::config_directory().ok()?;
    document(&directory.join("config.toml"))
        .ok()?
        .get("deployment")?
        .get("pending")?
        .as_str()
        .map(str::to_owned)
}

pub async fn run(args: DeployArgs) -> Result<()> {
    if args.dry_run {
        println!("{}", serde_json::to_string_pretty(&plan(&args)?)?);
        return Ok(());
    }
    if let Some(step) = pending() {
        eprintln!(
            "A previous deployment stopped at {step}; resuming with the saved choices (completed resources are reused)."
        );
    }
    let mut deployer = Deployer::new(
        args,
        io::stdin().is_terminal(),
        true,
        std::sync::Arc::new(|_| {}),
    )?;
    deployer.run().await.map_err(|stopped| {
        stopped.error.context(format!(
            "stopped at {}; rio deploy resumes it",
            stopped.step
        ))
    })
}
/// Records deployment choices (no secrets) without touching the endpoint URL.
pub fn save_deployment(directory: &Path, deployment: &Deployment) -> Result<()> {
    save_choices(directory, deployment, None)
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
/// The steps after the secrets, with the given state (tests and callers that
/// already hold a token and secrets).
#[cfg(test)]
async fn provision(
    cf: &Cloudflare,
    directory: &Path,
    deployment: &Deployment,
    secrets: &mut Secrets,
    models: Option<ProfileModels>,
) -> Result<()> {
    let mut deployer = Deployer::at(
        directory.into(),
        DeployArgs::default(),
        false,
        false,
        std::sync::Arc::new(|_| {}),
    )?;
    deployer.deployment = deployment.clone();
    deployer.cf = Some(Cloudflare {
        client: cf.client.clone(),
        base: cf.base.clone(),
        token: cf.token.clone(),
    });
    deployer.secrets = Secrets(std::mem::take(&mut secrets.0));
    deployer.models = models;
    deployer.next = step_index("runner-image");
    let result = deployer.run().await;
    secrets.0 = std::mem::take(&mut deployer.secrets.0);
    result.map_err(|stopped| stopped.error)
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
/// The Sandbox's instance size; Worker jobs declare its ceiling (`SANDBOX_CPUS`).
const SANDBOX_INSTANCE: &str = "standard-4";
/// Containers at once: two concurrent reviews' analysis jobs, their run
/// commands and retries, with room to spare.
const SANDBOX_MAX_INSTANCES: u64 = 10;
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
    // standard-4 ceiling (4 vCPUs / 12 GiB); Docker jobs retain their 2 GiB ceiling.
    let config = json!({"image":image,"instance_type":SANDBOX_INSTANCE});
    if let Some(existing) = existing {
        ensure!(
            existing["durable_objects"]["namespace_id"] == namespace_id,
            "Sandbox application belongs to another Durable Object"
        );
        // A size or capacity change rolls out like an image change.
        if existing["configuration"]["image"] != image
            || existing["configuration"]["instance_type"] != SANDBOX_INSTANCE
            || existing["max_instances"] != SANDBOX_MAX_INSTANCES
        {
            cf.request(
                Method::PATCH,
                &format!("{path}/{}", string(existing, "id")?),
                Some(json!({"configuration":config,"max_instances":SANDBOX_MAX_INSTANCES})),
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
        cf.request(Method::POST, &path, Some(json!({"name":app_name,"scheduling_policy":"default","configuration":config,"instances":0,"max_instances":SANDBOX_MAX_INSTANCES,"durable_objects":{"namespace_id":namespace_id}}))).await?;
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
        assert_eq!(select_account(&accounts, Some("b"), false).unwrap(), "b");
        assert!(select_account(&accounts, Some("unknown"), false).is_err());
        assert_eq!(select_account(&accounts[..1], None, false).unwrap(), "a");
        assert!(select_account(&accounts, None, false).is_err());
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
        assert_eq!(value["limits"]["cpu_ms"], 300000);
        // The limit the platform enforces is the one the Worker counts against.
        assert_eq!(value["limits"]["subrequests"], SUBREQUEST_LIMIT);
        let told = value["bindings"]
            .as_array()
            .unwrap()
            .iter()
            .find(|binding| binding["name"] == "SUBREQUEST_LIMIT")
            .unwrap();
        assert_eq!(told["type"], "plain_text");
        assert_eq!(told["text"], SUBREQUEST_LIMIT.to_string());
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
    /// Answers a request before the default fixtures: `(method, path, body)`.
    type Handler = Arc<dyn Fn(&str, &str, &str) -> Option<Value> + Send + Sync>;
    impl Mock {
        fn start(existing: bool, fail: bool) -> Self {
            Self::start_with(existing, fail, Arc::new(|_, _, _| None))
        }
        fn start_with(existing: bool, fail: bool, handler: Handler) -> Self {
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
                    // Accepted sockets inherit non-blocking mode on macOS and BSD.
                    stream.set_nonblocking(false).unwrap();
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
                    let target = parts.next().unwrap();
                    let path = target.split('?').next().unwrap();
                    let body = String::from_utf8_lossy(&bytes[end..]).into_owned();
                    records
                        .lock()
                        .unwrap()
                        .push((method.into(), path.into(), body.clone()));
                    let result = if let Some(result) = handler(method, target, &body) {
                        result
                    } else if path.ends_with("/d1/database") {
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
                    // A handler answers `{"__data": …}` for endpoints that use `data`.
                    let response = if let Some(data) = result.get("__data") {
                        json!({"success":true,"data":data})
                    } else if fail {
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
    async fn a_failure_at_the_secrets_step_resumes_there_without_repeating_earlier_steps() {
        let dir = tempfile::tempdir().unwrap();
        let account = "b".repeat(32);
        let id = account.clone();
        let mock = Mock::start_with(
            false,
            false,
            Arc::new(move |method, target, _| {
                (method == "GET" && target.split('?').next() == Some("/accounts"))
                    .then(|| json!([{"id": id, "name": "Test account"}]))
            }),
        );
        let updates: Arc<Mutex<Vec<Progress>>> = Arc::default();
        let seen = updates.clone();
        let args = DeployArgs {
            account: Some(account.clone()),
            runner: Some(Runner::SelfHosted),
            credential_store: Some(CredentialStore::File),
            ..Default::default()
        };
        let mut deployer = Deployer::at(
            dir.path().into(),
            args,
            false,
            false,
            Arc::new(move |p| seen.lock().unwrap().push(p)),
        )
        .unwrap();
        deployer.token = Some("deployment-secret".into());
        deployer.api = Some(mock.url.clone());
        // Saved credentials that cannot be read stop the secrets step.
        let saved = Secrets::path(dir.path(), &deployer.deployment);
        std::fs::write(&saved, "not json").unwrap();
        let stopped = deployer.run().await.unwrap_err();
        assert_eq!(stopped.step, "secrets");
        let config = || std::fs::read_to_string(dir.path().join("config.toml")).unwrap();
        // The choices and the stopped step were written before the first remote step.
        let written: toml::Value = toml::from_str(&config()).unwrap();
        assert_eq!(written["deployment"]["pending"].as_str(), Some("secrets"));
        assert_eq!(
            written["deployment"]["account_id"].as_str(),
            Some(account.as_str())
        );
        assert!(written.get("endpoint").is_none());
        assert!(
            mock.requests
                .lock()
                .unwrap()
                .iter()
                .all(|(m, _, _)| m == "GET"),
            "nothing is created before the secrets are saved"
        );
        // Fixed, the retry starts at the secrets step.
        std::fs::remove_file(&saved).unwrap();
        deployer
            .supply("OPENROUTER_API_KEY", "provider-secret".into())
            .unwrap();
        deployer.run().await.unwrap();
        let started = |step: &str| {
            updates
                .lock()
                .unwrap()
                .iter()
                .filter(|p| p.step == step && p.state == Some(StepState::Running))
                .count()
        };
        assert_eq!(started("authenticate"), 1);
        assert_eq!(started("account"), 1);
        assert_eq!(started("secrets"), 2);
        assert_eq!(started("d1"), 1);
        assert_eq!(started("workers-dev"), 1);
        let records = mock.requests.lock().unwrap();
        assert_eq!(
            records
                .iter()
                .filter(|(m, p, _)| m == "GET" && p == "/accounts")
                .count(),
            1
        );
        let finished: toml::Value = toml::from_str(&config()).unwrap();
        assert!(finished["deployment"].get("pending").is_none());
        assert_eq!(
            finished["endpoint"]["url"].as_str(),
            Some("https://rio.account-test.workers.dev")
        );
        // Every update is an `"init:step"` value the UI applies.
        for update in updates.lock().unwrap().iter() {
            let value = serde_json::to_value(update).unwrap();
            let parsed: rio_tui::init::StepUpdate = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(parsed.step, update.step, "{value}");
        }
        // Progress names secrets and never carries their values.
        let progress = serde_json::to_string(&*updates.lock().unwrap()).unwrap();
        assert!(progress.contains("OPENROUTER_API_KEY"));
        assert!(!progress.contains("provider-secret") && !progress.contains("deployment-secret"));
        assert!(!config().contains("provider-secret"));
    }
    #[test]
    fn council_keys_never_change_the_primary_provider_models() {
        let models = primary_models(&["ANTHROPIC_API_KEY"]).unwrap();
        assert_eq!(models.default, "anthropic/claude-haiku-4-5-20251001");
        assert_eq!(models.verifier, models.default);
        assert!(primary_models(&[]).is_none());
        assert!(
            primary_models(&["OPENAI_API_KEY", "OPENROUTER_API_KEY"])
                .unwrap()
                .default
                .starts_with("openrouter/")
        );
    }
    #[tokio::test]
    async fn council_step_is_chosen_skipped_and_replayed_without_storing_keys() {
        let dir = tempfile::tempdir().unwrap();
        let base = Deployment {
            account_id: Some("b".repeat(32)),
            runner: Runner::SelfHosted,
            credential_store: CredentialStore::File,
            ..Default::default()
        };
        save_choices(dir.path(), &base, None).unwrap();
        // Chosen: two vendors from flags; the anthropic route needs its key.
        let chosen = choices(
            &DeployArgs {
                council_vendors: vec![
                    "anthropic:claude:anthropic/claude-sonnet-5.5".into(),
                    "google:gemini:compat/google-ai-studio/gemini-3-pro".into(),
                ],
                ..Default::default()
            },
            dir.path(),
        )
        .unwrap();
        assert_eq!(chosen.council_vendors.len(), 2);
        assert_eq!(chosen.council_keys(), ["ANTHROPIC_API_KEY"]);
        save_choices(dir.path(), &chosen, None).unwrap();
        let config = std::fs::read_to_string(dir.path().join("config.toml")).unwrap();
        assert!(
            config.contains("[[deployment.council_vendors]]"),
            "{config}"
        );
        assert!(!config.contains("council-secret"));
        // The profile loader fills placeholder members from the saved allowlist.
        assert_eq!(
            rio_profile::configured_vendors(dir.path()).unwrap(),
            chosen.council_vendors
        );
        let mock = Mock::start(false, false);
        let cf = Cloudflare {
            base: mock.url.clone(),
            ..Cloudflare::new("deployment-secret".into()).unwrap()
        };
        let mut secrets = Secrets(
            [
                ("RIO_API_TOKEN".into(), "api-secret".into()),
                ("RUNNER_SECRET".into(), "runner-secret".into()),
                ("OPENROUTER_API_KEY".into(), "provider-secret".into()),
                ("ANTHROPIC_API_KEY".into(), "council-secret".into()),
            ]
            .into_iter()
            .collect(),
        );
        provision(&cf, dir.path(), &chosen, &mut secrets, None)
            .await
            .unwrap();
        let upload = |records: &Records| {
            records
                .iter()
                .find(|(m, p, _)| m == "PUT" && p.ends_with("/workers/scripts/rio"))
                .unwrap()
                .2
                .clone()
        };
        let body = upload(&mock.requests.lock().unwrap());
        assert!(body.contains(r#""name":"COUNCIL_VENDORS""#));
        assert!(body.contains(r#"compat/google-ai-studio/gemini-3-pro"#));
        assert!(
            body.contains("council-secret"),
            "the council key is a Worker secret"
        );
        let saved = std::fs::read_to_string(dir.path().join("config.toml")).unwrap();
        assert!(!saved.contains("secret"));
        // Replayed: `--from` reproduces the allowlist with no prompt and no keys.
        let replayed = choices(
            &DeployArgs {
                from: Some(dir.path().join("config.toml")),
                ..Default::default()
            },
            dir.path(),
        )
        .unwrap();
        assert_eq!(replayed.council_vendors, chosen.council_vendors);
        // Skipped: no vendors, an empty endpoint allowlist, no council key needed.
        let skipped = choices(
            &DeployArgs {
                no_council: true,
                ..Default::default()
            },
            dir.path(),
        )
        .unwrap();
        assert!(skipped.council_vendors.is_empty() && skipped.council_keys().is_empty());
        let meta = metadata(&skipped, "db", "queue", &Secrets::default(), Some("v1"));
        let binding = meta["bindings"]
            .as_array()
            .unwrap()
            .iter()
            .find(|b| b["name"] == "COUNCIL_VENDORS")
            .unwrap();
        assert_eq!(binding["text"], "[]");
        // Routes must name a configured provider.
        for spec in [
            "acme:acme:custom-missing/model",
            "acme:acme:elsewhere/model",
            "Acme:acme:openai/gpt",
            "acme:acme:no-route",
        ] {
            assert!(
                choices(
                    &DeployArgs {
                        council_vendors: vec![spec.into()],
                        ..Default::default()
                    },
                    dir.path(),
                )
                .is_err(),
                "{spec}"
            );
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
            provision(&cf, directory.path(), &deployment, &mut secrets, None)
                .await
                .unwrap();
            let records = mock.requests.lock().unwrap();
            assert!(records.iter().any(|(method, path, body)| {
                method == "PUT"
                    && path.ends_with("/workers/scripts/rio/schedules")
                    && serde_json::from_str::<Value>(body)
                        .is_ok_and(|value| value == json!([{"cron":"* * * * *"}]))
            }));
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
            // The uploaded Worker embeds every D1 migration, and the deployment
            // starts the migration Workflow that applies them after the upload.
            for name in [
                "0001_core.sql",
                "0002_convergence.sql",
                "0003_snapshot_contents.sql",
                "0004_pr_mode.sql",
                "0005_registry_integrity.sql",
            ] {
                assert!(upload.2.contains(name), "{name}");
            }
            assert!(
                upload
                    .2
                    .contains("CREATE TABLE IF NOT EXISTS finding_history")
            );
            let position =
                |f: &dyn Fn(&(String, String, String)) -> bool| records.iter().position(f).unwrap();
            assert!(
                position(&|(m, p, _)| m == "PUT" && p.ends_with("/workers/scripts/rio"))
                    < position(
                        &|(m, p, _)| m == "POST" && p.ends_with("/workflows/rio-migrate/instances")
                    )
            );
            let saved = std::fs::read_to_string(directory.path().join("config.toml")).unwrap();
            assert!(saved.contains("rio.account-test.workers.dev"));
            assert!(!saved.contains("secret"));
        }
    }
    /// Account-level custom providers and gateway routes, as Cloudflare keeps them.
    #[derive(Default)]
    struct Gateway {
        providers: Vec<Value>,
        routes: Vec<Value>,
        versions: u32,
        /// Route lists come in pages of 100 under `data.routes`, as the AI
        /// Gateway API answers; `bad_routes` answers an unknown shape instead.
        bad_routes: bool,
    }
    fn gateway_handler(state: Arc<Mutex<Gateway>>) -> Handler {
        Arc::new(move |method, target, body| {
            let (path, query) = target.split_once('?').unwrap_or((target, ""));
            let mut state = state.lock().unwrap();
            let body: Value = serde_json::from_str(body).unwrap_or(Value::Null);
            if path.ends_with("/ai-gateway/custom-providers") {
                return Some(if method == "POST" {
                    let mut created = body.clone();
                    created["id"] = json!(format!("id-{}", body["slug"].as_str().unwrap()));
                    created.as_object_mut().unwrap().remove("headers");
                    state.providers.push(created.clone());
                    created
                } else {
                    json!(state.providers)
                });
            }
            if let Some(id) = path
                .split("/ai-gateway/custom-providers/")
                .nth(1)
                .filter(|_| method == "PATCH")
            {
                let provider = state.providers.iter_mut().find(|p| p["id"] == id).unwrap();
                if let Some(base) = body.get("base_url") {
                    provider["base_url"] = base.clone();
                }
                return Some(provider.clone());
            }
            if path.ends_with("/routes") {
                return Some(if method == "POST" {
                    let created =
                        json!({"id":"route-1","name":body["name"],"elements":body["elements"]});
                    state.routes.push(created.clone());
                    created
                } else if state.bad_routes {
                    json!({"items": []})
                } else {
                    let page: usize = query
                        .split('&')
                        .find_map(|p| p.strip_prefix("page="))
                        .map_or(1, |p| p.parse().unwrap());
                    let routes: Vec<_> = state
                        .routes
                        .iter()
                        .skip((page - 1) * 100)
                        .take(100)
                        .collect();
                    json!({"__data": {"routes": routes, "page": page, "per_page": 100}})
                });
            }
            let route = state.routes.iter().position(|r| r["id"] == "route-1");
            if path.ends_with("/routes/route-1") {
                return Some(state.routes[route.unwrap()].clone());
            }
            if path.ends_with("/routes/route-1/versions") {
                state.versions += 1;
                state.routes[route.unwrap()]["elements"] = body["elements"].clone();
                return Some(json!({"id": format!("version-{}", state.versions)}));
            }
            if path.ends_with("/routes/route-1/deployments") {
                return Some(json!({"version_id": body["version_id"]}));
            }
            None
        })
    }
    fn custom_deployment(directory: &Path) -> Deployment {
        std::fs::write(
            directory.join("support.json"),
            r#"[{"id":"start","type":"start","outputs":{"next":{"elementId":"m"}}}]"#,
        )
        .unwrap();
        Deployment {
            account_id: Some("c".repeat(32)),
            runner: Runner::SelfHosted,
            credential_store: CredentialStore::File,
            custom_providers: vec![
                CustomProvider::parse("node-openai:openai:https://api.llm.example/v1").unwrap(),
                CustomProvider::parse("node-anthropic:anthropic:https://api.llm.example/v1")
                    .unwrap(),
            ],
            model_prices: [(
                "custom-node-openai/gpt-6.1-sol".to_owned(),
                ModelPrice {
                    input: 1.25,
                    output: 10.0,
                    cache_read: None,
                    cache_write: None,
                },
            )]
            .into_iter()
            .collect(),
            dynamic_routes: vec![DynamicRoute {
                name: "support".into(),
                elements_file: "support.json".into(),
            }],
            ..Default::default()
        }
    }
    fn custom_secrets() -> Secrets {
        Secrets(
            [
                ("RIO_API_TOKEN", "api-secret"),
                ("RUNNER_SECRET", "runner-secret"),
                ("AI_GATEWAY_TOKEN", "gateway-secret-value"),
                ("AI_GATEWAY_PROVIDER_KEY_NODE_OPENAI", "upstream-key-openai"),
                (
                    "AI_GATEWAY_PROVIDER_KEY_NODE_ANTHROPIC",
                    "upstream-key-anthropic",
                ),
            ]
            .into_iter()
            .map(|(k, v)| (k.into(), v.into()))
            .collect(),
        )
    }
    type Records = Vec<(String, String, String)>;
    async fn deploy(
        state: &Arc<Mutex<Gateway>>,
        deployment: &Deployment,
        directory: &Path,
        secrets: &mut Secrets,
    ) -> Records {
        let mock = Mock::start_with(true, false, gateway_handler(state.clone()));
        let cf = Cloudflare {
            base: mock.url.clone(),
            ..Cloudflare::new("deployment-secret".into()).unwrap()
        };
        let models = Some(ProfileModels {
            default: "custom-node-anthropic/claude-sonnet-5-5".into(),
            verifier: "custom-node-openai/gpt-6.1-sol".into(),
        });
        provision(&cf, directory, deployment, secrets, models)
            .await
            .unwrap();
        mock.requests.lock().unwrap().clone()
    }
    fn gateway_writes(records: &Records) -> Vec<(String, String, Value)> {
        records
            .iter()
            .filter(|(m, p, _)| {
                m != "GET" && (p.contains("/ai-gateway/custom-providers") || p.contains("/routes"))
            })
            .map(|(m, p, b)| {
                let at = p.find("/ai-gateway/").unwrap();
                (
                    m.clone(),
                    p[at..].to_owned(),
                    serde_json::from_str(b).unwrap_or(Value::Null),
                )
            })
            .collect()
    }
    #[tokio::test]
    async fn custom_providers_and_routes_are_provisioned_once_and_keys_stay_in_the_gateway() {
        let directory = tempfile::tempdir().unwrap();
        let deployment = custom_deployment(directory.path());
        let state = Arc::new(Mutex::new(Gateway::default()));
        let mut secrets = custom_secrets();
        let records = deploy(&state, &deployment, directory.path(), &mut secrets).await;
        let writes = gateway_writes(&records);
        assert_eq!(writes.len(), 3, "{writes:?}");
        for (slug, protocol_header) in [
            ("node-openai", "Authorization"),
            ("node-anthropic", "x-api-key"),
        ] {
            let (_, _, body) = writes
                .iter()
                .find(|(m, p, b)| {
                    m == "POST" && p.ends_with("/custom-providers") && b["slug"] == slug
                })
                .unwrap();
            assert_eq!(body["base_url"], "https://api.llm.example/v1");
            assert_eq!(body["enable"], true);
            // Cloudflare takes headers as a JSON-encoded string, not an object.
            let headers: Value = serde_json::from_str(body["headers"].as_str().unwrap()).unwrap();
            assert!(
                headers[protocol_header]
                    .as_str()
                    .unwrap()
                    .contains("upstream-key")
            );
        }
        let (_, path, route) = &writes[2];
        assert!(path.ends_with("/gateways/rio/routes"));
        assert_eq!(route["name"], "support");
        assert_eq!(route["elements"][0]["type"], "start");
        // The Worker gets protocols, prices and its own secrets; never upstream keys.
        let upload = records
            .iter()
            .find(|(m, p, _)| m == "PUT" && p.ends_with("/workers/scripts/rio"))
            .unwrap();
        assert!(!upload.2.contains("upstream-key"));
        assert!(
            !upload.2.contains("AI_GATEWAY_PROVIDER_KEY")
                && !upload.2.contains("AI_GATEWAY_PROVIDER_APPLIED")
        );
        let meta = metadata(&deployment, "db", "queue", &secrets, Some("v1"));
        let binding = |name: &str| {
            meta["bindings"]
                .as_array()
                .unwrap()
                .iter()
                .find(|b| b["name"] == name)
                .cloned()
        };
        assert_eq!(
            serde_json::from_str::<Value>(
                binding("AI_GATEWAY_PROVIDERS").unwrap()["text"]
                    .as_str()
                    .unwrap()
            )
            .unwrap(),
            json!({"node-anthropic":{"protocol":"anthropic"},"node-openai":{"protocol":"openai"}})
        );
        assert_eq!(
            serde_json::from_str::<Value>(
                binding("MODEL_PRICES").unwrap()["text"].as_str().unwrap()
            )
            .unwrap(),
            json!({"custom-node-openai/gpt-6.1-sol":{"input":1.25,"output":10.0}})
        );
        assert!(
            binding("AI_GATEWAY_URL").unwrap()["text"]
                .as_str()
                .unwrap()
                .ends_with(&format!("{}/rio", "c".repeat(32)))
        );
        // Fingerprints of the applied headers are saved; the keys are not in config.
        let saved = Secrets::load(directory.path(), &deployment).unwrap();
        assert!(
            saved
                .0
                .contains_key("AI_GATEWAY_PROVIDER_APPLIED_NODE_OPENAI")
        );
        let config = std::fs::read_to_string(directory.path().join("config.toml")).unwrap();
        assert!(!config.contains("upstream-key"));
        let profile =
            std::fs::read_to_string(directory.path().join("profiles/default.yaml")).unwrap();
        assert!(profile.contains("default: custom-node-anthropic/claude-sonnet-5-5"));
        assert!(profile.contains("verifier: custom-node-openai/gpt-6.1-sol"));
        assert!(!profile.contains("upstream-key"));

        // Redeploying the same choices changes nothing in the gateway.
        let mut secrets = saved;
        let records = deploy(&state, &deployment, directory.path(), &mut secrets).await;
        assert_eq!(gateway_writes(&records), vec![]);
        // A rotated key rewrites only that provider's headers.
        secrets.0.insert(
            "AI_GATEWAY_PROVIDER_KEY_NODE_OPENAI".into(),
            "rotated-upstream-key".into(),
        );
        let records = deploy(&state, &deployment, directory.path(), &mut secrets).await;
        let writes = gateway_writes(&records);
        assert_eq!(writes.len(), 1, "{writes:?}");
        assert_eq!(writes[0].0, "PATCH");
        assert!(writes[0].1.ends_with("/custom-providers/id-node-openai"));
        assert!(
            writes[0].2["headers"]
                .as_str()
                .unwrap()
                .contains("rotated-upstream-key")
        );
        assert!(writes[0].2.get("base_url").is_none());
        // Edited route elements deploy one new version.
        std::fs::write(
            directory.path().join("support.json"),
            r#"[{"id":"start","type":"start","outputs":{"next":{"elementId":"other"}}}]"#,
        )
        .unwrap();
        let records = deploy(&state, &deployment, directory.path(), &mut secrets).await;
        let writes = gateway_writes(&records);
        assert_eq!(
            writes
                .iter()
                .map(|(m, p, _)| (m.as_str(), p.rsplit('/').next().unwrap()))
                .collect::<Vec<_>>(),
            vec![("POST", "versions"), ("POST", "deployments")]
        );
        assert_eq!(writes[1].2["version_id"], "version-1");
    }
    #[tokio::test]
    async fn existing_custom_providers_are_adopted_without_a_key_and_missing_ones_need_one() {
        let directory = tempfile::tempdir().unwrap();
        let mut deployment = custom_deployment(directory.path());
        deployment.dynamic_routes.clear();
        // Created by hand earlier: same slugs, one with an outdated base URL.
        let state = Arc::new(Mutex::new(Gateway {
            providers: vec![
                json!({"id":"db0f","slug":"node-openai","base_url":"https://api.llm.example/v1","enable":true}),
                json!({"id":"bf23","slug":"node-anthropic","base_url":"https://old.example/v1","enable":true}),
            ],
            ..Default::default()
        }));
        let mut secrets = custom_secrets();
        secrets
            .0
            .retain(|k, _| !k.starts_with(providers::KEY_PREFIX));
        let records = deploy(&state, &deployment, directory.path(), &mut secrets).await;
        assert_eq!(
            gateway_writes(&records),
            vec![(
                "PATCH".into(),
                "/ai-gateway/custom-providers/bf23".into(),
                json!({"base_url":"https://api.llm.example/v1"})
            )]
        );
        // A provider the account does not have cannot be created without its key.
        let mut fresh = custom_deployment(directory.path());
        fresh
            .custom_providers
            .push(CustomProvider::parse("other:openai:https://other.example/v1").unwrap());
        fresh.dynamic_routes.clear();
        let mock = Mock::start_with(true, false, gateway_handler(state.clone()));
        let cf = Cloudflare {
            base: mock.url.clone(),
            ..Cloudflare::new("deployment-secret".into()).unwrap()
        };
        let error = provision(&cf, directory.path(), &fresh, &mut secrets, None)
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("AI_GATEWAY_PROVIDER_KEY_OTHER"), "{error}");
        assert!(!error.contains("gateway-secret-value"));
    }
    #[test]
    fn prompt_settings_are_validated_before_account_access_and_uploaded() {
        let dir = tempfile::tempdir().unwrap();
        let from = |prompt: &str| {
            let config = dir.path().join("prompt.toml");
            std::fs::write(
                &config,
                format!("[deployment]\naccount_id='{}'\n{prompt}", "a".repeat(32)),
            )
            .unwrap();
            choices(
                &DeployArgs {
                    from: Some(config),
                    ..Default::default()
                },
                dir.path(),
            )
        };
        let names = |deployment: &Deployment| -> Vec<(String, String)> {
            metadata(deployment, "db", "queue", &Secrets::default(), None)["bindings"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|b| b["name"].as_str().unwrap().starts_with("PROMPT_"))
                .map(|b| {
                    (
                        b["name"].as_str().unwrap().into(),
                        b["text"].as_str().unwrap().into(),
                    )
                })
                .collect()
        };
        let deployment =
            from("[deployment.prompt]\ncache='anthropic,openai'\nlayout='verifier-system'\n")
                .unwrap();
        assert_eq!(
            names(&deployment),
            vec![
                ("PROMPT_CACHE".into(), "anthropic,openai".into()),
                ("PROMPT_LAYOUT".into(), "verifier-system".into())
            ]
        );
        // Saved and replayed by `--from`.
        save_choices(dir.path(), &deployment, None).unwrap();
        let replayed = choices(
            &DeployArgs {
                from: Some(dir.path().join("config.toml")),
                ..Default::default()
            },
            dir.path(),
        )
        .unwrap();
        assert_eq!(replayed.prompt, deployment.prompt);
        // Omitted settings leave both variables unset.
        assert!(names(&from("").unwrap()).is_empty());
        assert_eq!(
            names(&from("[deployment.prompt]\ncache='off'\n").unwrap()).len(),
            1
        );
        // Unknown values fail while choices are read, before any Cloudflare request.
        for (prompt, value) in [
            ("[deployment.prompt]\ncache='anthropic,gemini'\n", "gemini"),
            ("[deployment.prompt]\nlayout='agent-order,fast'\n", "fast"),
            ("[deployment.prompt]\ncache='off,openai'\n", "off"),
        ] {
            let error = from(prompt).err().unwrap().to_string();
            assert!(error.contains(value), "{error}");
        }
    }
    #[test]
    fn custom_provider_choices_replay_from_config_and_keys_come_only_from_secrets() {
        let dir = tempfile::tempdir().unwrap();
        let deployment = custom_deployment(dir.path());
        save_choices(dir.path(), &deployment, None).unwrap();
        let config = std::fs::read_to_string(dir.path().join("config.toml")).unwrap();
        assert!(config.contains("[[deployment.custom_providers]]"));
        assert!(!config.contains("upstream-key"));
        let replayed = choices(
            &DeployArgs {
                from: Some(dir.path().join("config.toml")),
                ..Default::default()
            },
            dir.path(),
        )
        .unwrap();
        assert_eq!(replayed.custom_providers, deployment.custom_providers);
        assert_eq!(replayed.model_prices, deployment.model_prices);
        // Route files of an imported configuration resolve against its directory.
        assert_eq!(replayed.dynamic_routes[0].name, "support");
        assert_eq!(
            replayed.dynamic_routes[0].elements_file,
            std::path::absolute(dir.path().join("support.json")).unwrap()
        );
        // A flag replaces a provider by slug and adds new ones.
        let changed = choices(
            &DeployArgs {
                from: Some(dir.path().join("config.toml")),
                custom_providers: vec![
                    "node-openai:openai:https://api.other.example/v1/".into(),
                    "extra:anthropic:https://extra.example/v1".into(),
                ],
                ..Default::default()
            },
            dir.path(),
        )
        .unwrap();
        assert_eq!(changed.custom_providers.len(), 3);
        assert_eq!(
            changed
                .custom_providers
                .iter()
                .find(|p| p.slug == "node-openai")
                .unwrap()
                .base_url,
            "https://api.other.example/v1"
        );
        // A deployment without custom choices keeps its earlier config shape.
        let plain = toml::to_string(&Deployment::default()).unwrap();
        assert!(!plain.contains("custom_providers") && !plain.contains("model_prices"));
        // Keys are accepted from a secrets file only for configured providers.
        let file = dir.path().join("secrets.json");
        std::fs::write(
            &file,
            r#"{"AI_GATEWAY_PROVIDER_KEY_NODE_OPENAI":" key-from-file "}"#,
        )
        .unwrap();
        let mut secrets = Secrets::default();
        secrets
            .collect(Some(&file), &deployment.custom_providers)
            .unwrap();
        assert_eq!(
            secrets.0["AI_GATEWAY_PROVIDER_KEY_NODE_OPENAI"],
            "key-from-file"
        );
        assert!(!secrets.has_builtin_key());
        assert!(
            secrets
                .worker()
                .all(|(k, _)| !k.starts_with("AI_GATEWAY_PROVIDER"))
        );
        std::fs::write(&file, r#"{"AI_GATEWAY_PROVIDER_KEY_UNKNOWN":"x"}"#).unwrap();
        assert!(
            Secrets::default()
                .collect(Some(&file), &deployment.custom_providers)
                .is_err()
        );
    }
    #[test]
    fn sandbox_metadata_keeps_its_bindings_and_container_declaration_with_custom_providers() {
        let directory = tempfile::tempdir().unwrap();
        let mut deployment = custom_deployment(directory.path());
        deployment.runner = Runner::Sandbox;
        let plain = Deployment {
            runner: Runner::Sandbox,
            account_id: deployment.account_id.clone(),
            ..Default::default()
        };
        let secrets = custom_secrets();
        let with = metadata(&deployment, "db", "queue", &secrets, Some("v1"));
        let without = metadata(&plain, "db", "queue", &secrets, Some("v1"));
        let names = |m: &Value| {
            m["bindings"]
                .as_array()
                .unwrap()
                .iter()
                .map(|b| b["name"].as_str().unwrap().to_owned())
                .collect::<std::collections::BTreeSet<_>>()
        };
        // Custom providers add MODEL_PRICES only; every other binding is shared.
        let added: Vec<_> = names(&with).difference(&names(&without)).cloned().collect();
        assert_eq!(added, vec!["MODEL_PRICES".to_owned()]);
        assert!(names(&without).contains("AI_GATEWAY_PROVIDERS"));
        let sandbox = with["bindings"]
            .as_array()
            .unwrap()
            .iter()
            .find(|b| b["name"] == "SANDBOX")
            .unwrap();
        assert_eq!(
            sandbox,
            &json!({"type":"durable_object_namespace","name":"SANDBOX","class_name":"Sandbox"})
        );
        assert_eq!(with["containers"], json!([{"class_name":"Sandbox"}]));
        assert_eq!(
            with["keep_bindings"],
            json!(["plain_text", "json", "secret_text"])
        );
        for name in ["RIO_API_TOKEN", "RUNNER_SECRET", "AI_GATEWAY_TOKEN"] {
            assert!(names(&with).contains(name), "{name}");
        }
        assert!(
            names(&with)
                .iter()
                .all(|n| !n.starts_with("AI_GATEWAY_PROVIDER_KEY"))
        );
    }
    #[tokio::test]
    async fn routes_are_found_on_later_pages_and_unknown_list_shapes_stop_the_deployment() {
        let directory = tempfile::tempdir().unwrap();
        let mut deployment = custom_deployment(directory.path());
        let elements: Value = serde_json::from_str(
            &std::fs::read_to_string(directory.path().join("support.json")).unwrap(),
        )
        .unwrap();
        // 150 routes; the configured one is on the second page.
        let mut routes: Vec<Value> = (0..149)
            .map(|i| json!({"id":format!("other-{i}"),"name":format!("other-{i}")}))
            .collect();
        routes.push(json!({"id":"route-1","name":"support","elements":elements}));
        let state = Arc::new(Mutex::new(Gateway {
            providers: vec![
                json!({"id":"a","slug":"node-openai","base_url":"https://api.llm.example/v1","enable":true}),
                json!({"id":"b","slug":"node-anthropic","base_url":"https://api.llm.example/v1","enable":true}),
            ],
            routes,
            ..Default::default()
        }));
        let mut secrets = custom_secrets();
        secrets
            .0
            .retain(|k, _| !k.starts_with(providers::KEY_PREFIX));
        let records = deploy(&state, &deployment, directory.path(), &mut secrets).await;
        assert_eq!(gateway_writes(&records), vec![]);
        // An unknown list shape is an error, never "no routes".
        state.lock().unwrap().bad_routes = true;
        let mock = Mock::start_with(true, false, gateway_handler(state.clone()));
        let cf = Cloudflare {
            base: mock.url.clone(),
            ..Cloudflare::new("deployment-secret".into()).unwrap()
        };
        let error = provision(&cf, directory.path(), &deployment, &mut secrets, None)
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("unexpected dynamic route list"), "{error}");
        assert!(gateway_writes(&mock.requests.lock().unwrap()).is_empty());
        drop(mock);
        // Unreadable route elements fail before any Cloudflare request.
        deployment.dynamic_routes[0].elements_file = "missing.json".into();
        let mock = Mock::start_with(true, false, gateway_handler(state.clone()));
        let cf = Cloudflare {
            base: mock.url.clone(),
            ..Cloudflare::new("deployment-secret".into()).unwrap()
        };
        let error = provision(&cf, directory.path(), &deployment, &mut secrets, None)
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("missing.json"), "{error}");
        assert!(mock.requests.lock().unwrap().is_empty());
    }
    #[test]
    fn imported_route_files_resolve_against_the_imported_configuration() {
        let source = tempfile::tempdir().unwrap();
        let destination = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(source.path().join("routes")).unwrap();
        std::fs::write(
            source.path().join("routes/support.json"),
            "[{\"id\":\"start\"}]",
        )
        .unwrap();
        std::fs::write(
            source.path().join("config.toml"),
            "[deployment]\n[[deployment.dynamic_routes]]\nname = 'support'\nelements_file = 'routes/support.json'\n",
        )
        .unwrap();
        let deployment = choices(
            &DeployArgs {
                from: Some(source.path().join("config.toml")),
                ..Default::default()
            },
            destination.path(),
        )
        .unwrap();
        let file = &deployment.dynamic_routes[0].elements_file;
        assert!(file.is_absolute());
        assert_eq!(
            std::fs::canonicalize(file).unwrap(),
            std::fs::canonicalize(source.path().join("routes/support.json")).unwrap()
        );
        // The saved destination configuration keeps a path that still works.
        providers::check_routes(destination.path(), &deployment.dynamic_routes).unwrap();
        save_choices(destination.path(), &deployment, None).unwrap();
        let again = choices(&DeployArgs::default(), destination.path()).unwrap();
        providers::check_routes(destination.path(), &again.dynamic_routes).unwrap();
    }
    #[tokio::test]
    async fn removing_every_price_clears_rio_prices_and_keeps_hand_set_ones() {
        let directory = tempfile::tempdir().unwrap();
        let mut deployment = custom_deployment(directory.path());
        deployment.dynamic_routes.clear();
        let state = Arc::new(Mutex::new(Gateway::default()));
        let mut secrets = custom_secrets();
        let prices_in = |records: &Records| {
            let upload = &records
                .iter()
                .find(|(m, p, _)| m == "PUT" && p.ends_with("/workers/scripts/rio"))
                .unwrap()
                .2;
            let start = upload.find('{').unwrap();
            let meta: Value = serde_json::Deserializer::from_str(&upload[start..])
                .into_iter::<Value>()
                .next()
                .unwrap()
                .unwrap();
            meta["bindings"]
                .as_array()
                .unwrap()
                .iter()
                .find(|b| b["name"] == "MODEL_PRICES")
                .map(|b| b["text"].as_str().unwrap().to_owned())
        };
        let records = deploy(&state, &deployment, directory.path(), &mut secrets).await;
        assert!(prices_in(&records).unwrap().contains("gpt-6.1-sol"));
        assert!(secrets.0.contains_key(providers::PRICES_MARKER));
        assert!(
            !records
                .iter()
                .any(|(_, _, b)| b.contains(providers::PRICES_MARKER))
        );
        // The last price removed: the binding is cleared once.
        deployment.model_prices.clear();
        let records = deploy(&state, &deployment, directory.path(), &mut secrets).await;
        assert_eq!(prices_in(&records).as_deref(), Some("{}"));
        assert!(!secrets.0.contains_key(providers::PRICES_MARKER));
        assert!(
            !Secrets::load(directory.path(), &deployment)
                .unwrap()
                .0
                .contains_key(providers::PRICES_MARKER)
        );
        // Then left alone, so a value set by hand is kept by keep_bindings.
        let records = deploy(&state, &deployment, directory.path(), &mut secrets).await;
        assert_eq!(prices_in(&records), None);
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

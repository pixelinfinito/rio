//! Custom model providers and dynamic routes in the deployment's AI Gateway.
//!
//! A custom provider is an OpenAI-compatible or Anthropic Messages endpoint that
//! the gateway reaches as `custom-<slug>`. Its definition (slug, protocol, base
//! URL) is a non-secret deployment choice saved in `config.toml`; its key lives
//! in the deployment's credential store and in the gateway provider's
//! write-only `headers`, never in the Worker, repository files or profiles.
use anyhow::{Context, Result, bail, ensure};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io::{self, Write},
    path::{Path, PathBuf},
};

use crate::deployment::Cloudflare;

/// Credential-store names of provider keys; never uploaded as Worker secrets.
pub const KEY_PREFIX: &str = "AI_GATEWAY_PROVIDER_KEY_";
/// Fingerprint of the base URL and headers last applied to a provider, so a
/// redeployment rewrites the write-only headers only when the key changed.
pub const APPLIED_PREFIX: &str = "AI_GATEWAY_PROVIDER_APPLIED_";
/// Deployment state kept with the credentials and never uploaded.
pub const STATE_PREFIX: &str = "RIO_DEPLOY_STATE_";
/// Set once Rio uploaded `MODEL_PRICES`, so removing every price clears the
/// binding instead of leaving stale prices, while a hand-set value is kept.
pub const PRICES_MARKER: &str = "RIO_DEPLOY_STATE_MODEL_PRICES";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, clap::ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    /// OpenAI chat completions (`/chat/completions`).
    Openai,
    /// Anthropic Messages (`/messages`).
    Anthropic,
}
impl Protocol {
    fn label(self) -> &'static str {
        match self {
            Self::Openai => "openai",
            Self::Anthropic => "anthropic",
        }
    }
}
/// How the gateway presents the upstream key.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AuthHeader {
    /// `Authorization: Bearer KEY` (OpenAI-compatible default).
    Authorization,
    /// `x-api-key: KEY` (Anthropic default).
    XApiKey,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CustomProvider {
    /// Gateway slug; requests use `custom-<slug>`.
    pub slug: String,
    pub protocol: Protocol,
    /// The API root that `chat/completions` or `messages` is appended to, for
    /// example `https://api.example.com/v1`.
    pub base_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_header: Option<AuthHeader>,
    /// `breakpoints`: the Anthropic-protocol endpoint accepts `cache_control`
    /// blocks, so the Worker may send prompt-cache breakpoints to it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_cache: Option<PromptCache>,
}
/// A custom provider's declared prompt-cache support.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PromptCache {
    Breakpoints,
}
impl CustomProvider {
    /// `SLUG:PROTOCOL:BASE_URL`, for example `node:openai:https://api.example.com/v1`.
    /// `PROTOCOL+breakpoints` declares prompt-cache breakpoint support, which
    /// only the `anthropic` protocol accepts.
    pub fn parse(spec: &str) -> Result<Self> {
        let mut parts = spec.splitn(3, ':');
        let (Some(slug), Some(protocol), Some(base_url)) =
            (parts.next(), parts.next(), parts.next())
        else {
            bail!("--custom-provider expects SLUG:PROTOCOL:BASE_URL");
        };
        let (protocol, prompt_cache) = match protocol.split_once('+') {
            Some((protocol, "breakpoints")) => (protocol, Some(PromptCache::Breakpoints)),
            Some(_) => bail!("custom provider protocol suffix must be +breakpoints"),
            None => (protocol, None),
        };
        let protocol = match protocol {
            "openai" => Protocol::Openai,
            "anthropic" => Protocol::Anthropic,
            _ => bail!("custom provider protocol must be openai or anthropic"),
        };
        let mut provider = Self {
            slug: slug.into(),
            protocol,
            base_url: base_url.into(),
            name: None,
            auth_header: None,
            prompt_cache,
        };
        provider.normalize();
        provider.validate()?;
        Ok(provider)
    }
    pub fn normalize(&mut self) {
        self.base_url = self.base_url.trim().trim_end_matches('/').to_owned();
    }
    pub fn validate(&self) -> Result<()> {
        let slug = &self.slug;
        ensure!(
            (1..=63).contains(&slug.len())
                && slug
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
                && !slug.starts_with('-')
                && !slug.ends_with('-'),
            "custom provider slug must be 1–63 lowercase letters, digits or hyphens"
        );
        ensure!(
            !slug.starts_with("custom-"),
            "custom provider slug {slug}: omit the custom- prefix; the gateway adds it"
        );
        let url = reqwest::Url::parse(&self.base_url)
            .with_context(|| format!("custom provider {slug}: base_url is not a URL"))?;
        ensure!(
            url.scheme() == "https"
                && url.host_str().is_some_and(|h| !h.is_empty())
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none(),
            "custom provider {slug}: base_url must be an https URL without credentials, query or fragment"
        );
        let path = url.path().trim_end_matches('/');
        ensure!(
            !path.ends_with("/chat/completions") && !path.ends_with("/messages"),
            "custom provider {slug}: base_url is the API root that /chat/completions or /messages is appended to (for example https://api.example.com/v1), not the endpoint itself"
        );
        if let Some(name) = &self.name {
            ensure!(
                !name.trim().is_empty() && name.len() <= 100,
                "custom provider {slug}: name must be 1–100 characters"
            );
        }
        ensure!(
            self.prompt_cache.is_none() || self.protocol == Protocol::Anthropic,
            "custom provider {slug}: prompt_cache = \"breakpoints\" requires protocol anthropic"
        );
        Ok(())
    }
    pub fn auth_header(&self) -> AuthHeader {
        self.auth_header.unwrap_or(match self.protocol {
            Protocol::Openai => AuthHeader::Authorization,
            Protocol::Anthropic => AuthHeader::XApiKey,
        })
    }
    /// Credential-store and environment name of the provider's key.
    pub fn key_name(&self) -> String {
        format!(
            "{KEY_PREFIX}{}",
            self.slug.to_ascii_uppercase().replace('-', "_")
        )
    }
    fn applied_name(&self) -> String {
        format!(
            "{APPLIED_PREFIX}{}",
            self.slug.to_ascii_uppercase().replace('-', "_")
        )
    }
    /// The gateway's `headers` field: a JSON-encoded string, not an object.
    pub fn headers(&self, key: &str) -> String {
        let headers = match self.auth_header() {
            AuthHeader::Authorization => json!({"Authorization": format!("Bearer {key}")}),
            AuthHeader::XApiKey => json!({"x-api-key": key}),
        };
        headers.to_string()
    }
    fn fingerprint(&self, key: &str) -> String {
        blake3::hash(format!("{}\0{}", self.base_url, self.headers(key)).as_bytes())
            .to_hex()
            .to_string()
    }
}

/// Explicit prices in USD per million tokens, keyed by the full profile model.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModelPrice {
    pub input: f64,
    pub output: f64,
    /// Cache reads and (5-minute) cache writes; without them the Worker
    /// records the cost of a call that used the cache as unknown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write: Option<f64>,
}

/// A gateway dynamic route; profiles call it as `dynamic/<name>`.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DynamicRoute {
    pub name: String,
    /// JSON array of route elements, relative to the configuration directory.
    pub elements_file: PathBuf,
}

/// Validates the gateway choices of a deployment.
pub fn validate(
    providers: &[CustomProvider],
    prices: &BTreeMap<String, ModelPrice>,
    routes: &[DynamicRoute],
) -> Result<()> {
    let mut slugs = std::collections::BTreeSet::new();
    for provider in providers {
        provider.validate()?;
        ensure!(
            slugs.insert(&provider.slug),
            "custom provider {} is configured twice",
            provider.slug
        );
    }
    for (model, price) in prices {
        ensure!(
            model.contains('/') && !model.starts_with('/') && !model.ends_with('/'),
            "model_prices keys are full profile models such as custom-SLUG/MODEL"
        );
        for (name, rate) in [
            ("input", Some(price.input)),
            ("output", Some(price.output)),
            ("cache_read", price.cache_read),
            ("cache_write", price.cache_write),
        ] {
            ensure!(
                rate.is_none_or(|r| r.is_finite() && r >= 0.0),
                "model_prices for {model}: {name} must be non-negative USD per million tokens"
            );
        }
    }
    let mut names = std::collections::BTreeSet::new();
    for route in routes {
        ensure!(
            (1..=64).contains(&route.name.len())
                && route
                    .name
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
                && names.insert(&route.name),
            "dynamic route names must be unique 1–64 letters, digits, hyphens or underscores"
        );
    }
    Ok(())
}

/// The Worker's `AI_GATEWAY_PROVIDERS`: protocols by slug, nothing secret.
pub fn runtime(providers: &[CustomProvider]) -> String {
    let map: BTreeMap<_, _> = providers
        .iter()
        .map(|p| {
            let mut value = json!({"protocol": p.protocol.label()});
            if p.prompt_cache == Some(PromptCache::Breakpoints) {
                value["prompt_cache"] = json!("breakpoints");
            }
            (p.slug.clone(), value)
        })
        .collect();
    serde_json::to_string(&map).expect("provider map serializes")
}
/// The Worker's `MODEL_PRICES`.
pub fn prices(prices: &BTreeMap<String, ModelPrice>) -> String {
    serde_json::to_string(prices).expect("prices serialize")
}

/// Models chosen during setup for a newly written personal default profile.
#[derive(Clone, Debug, PartialEq)]
pub struct ProfileModels {
    pub default: String,
    pub verifier: String,
}

fn ask(input: &mut dyn io::BufRead, prompt: &str, default: Option<&str>) -> Result<String> {
    match default {
        Some(default) => eprint!("{prompt} [{default}]: "),
        None => eprint!("{prompt}: "),
    }
    io::stderr().flush()?;
    let mut line = String::new();
    input.read_line(&mut line)?;
    let value = line.trim();
    Ok(match (value.is_empty(), default) {
        (true, Some(default)) => default.to_owned(),
        _ => value.to_owned(),
    })
}

/// Interactive custom provider setup: definition, hidden key and the models of
/// the personal default profile. Returns the provider, its key and the models.
pub fn prompt() -> Result<(CustomProvider, String, ProfileModels)> {
    prompt_with(&mut io::stdin().lock(), &|| {
        rpassword::prompt_password("Provider API key (hidden): ").map_err(Into::into)
    })
}
/// `prompt` with its line input and hidden-key reader supplied (for tests).
pub fn prompt_with(
    input: &mut dyn io::BufRead,
    secret: &dyn Fn() -> Result<String>,
) -> Result<(CustomProvider, String, ProfileModels)> {
    eprintln!(
        "Custom endpoint through your AI Gateway. Rio stores its key in the deployment credential store and in the gateway provider; the Worker never receives it."
    );
    let slug = ask(
        input,
        "Provider slug (lowercase letters, digits, hyphens)",
        Some("custom"),
    )?;
    let (protocol, prompt_cache) = match ask(
        input,
        "Protocol: 1. OpenAI-compatible  2. Anthropic Messages  3. Anthropic Messages accepting prompt-cache breakpoints",
        Some("1"),
    )?
    .as_str()
    {
        "1" | "openai" => (Protocol::Openai, None),
        "2" | "anthropic" => (Protocol::Anthropic, None),
        "3" => (Protocol::Anthropic, Some(PromptCache::Breakpoints)),
        _ => bail!("invalid protocol selection"),
    };
    let base_url = ask(
        input,
        "Base URL (the API root that /chat/completions or /messages is appended to, e.g. https://api.example.com/v1)",
        None,
    )?;
    let mut provider = CustomProvider {
        slug,
        protocol,
        base_url,
        name: None,
        auth_header: None,
        prompt_cache,
    };
    provider.normalize();
    provider.validate()?;
    let key = secret()?;
    ensure!(!key.trim().is_empty(), "provider key cannot be empty");
    let model = ask(
        input,
        "Model for generation (as the provider names it)",
        None,
    )?;
    ensure!(!model.is_empty(), "a model is required");
    let verifier = ask(input, "Model for verification", Some(&model))?;
    let models = ProfileModels {
        default: format!("custom-{}/{model}", provider.slug),
        verifier: format!("custom-{}/{verifier}", provider.slug),
    };
    Ok((provider, key.trim().to_owned(), models))
}

/// Creates or updates the deployment's custom providers. A provider that
/// already exists is adopted; its base URL is corrected and its headers are
/// rewritten only when Rio holds a key whose fingerprint differs from the last
/// applied one. Returns whether `secrets` changed and must be saved.
pub async fn reconcile_providers(
    cf: &Cloudflare,
    base: &str,
    deployment: &str,
    providers: &[CustomProvider],
    secrets: &mut BTreeMap<String, String>,
) -> Result<bool> {
    if providers.is_empty() {
        return Ok(false);
    }
    let path = format!("{base}/ai-gateway/custom-providers");
    let existing = cf.list(&path).await?;
    let mut changed = false;
    for provider in providers {
        let key = secrets.get(&provider.key_name()).cloned();
        let fingerprint = key.as_deref().map(|k| provider.fingerprint(k));
        let remote = existing
            .iter()
            .find(|p| p["slug"] == provider.slug.as_str());
        match remote {
            None => {
                let key = key.with_context(|| {
                    format!(
                        "custom provider {} does not exist in the account yet; provide its key as {} (environment or --secrets-file)",
                        provider.slug,
                        provider.key_name()
                    )
                })?;
                cf.request(
                    Method::POST,
                    &path,
                    Some(json!({
                        "name": provider.name.clone().unwrap_or_else(|| provider.slug.clone()),
                        "slug": provider.slug,
                        "base_url": provider.base_url,
                        "description": format!("Managed by Rio deployment {deployment}"),
                        "enable": true,
                        "headers": provider.headers(&key),
                    })),
                )
                .await?;
            }
            Some(remote) => {
                let id = remote
                    .get("id")
                    .and_then(Value::as_str)
                    .context("Cloudflare custom provider without id")?;
                let mut patch = serde_json::Map::new();
                if remote["base_url"].as_str().map(|u| u.trim_end_matches('/'))
                    != Some(provider.base_url.as_str())
                {
                    patch.insert("base_url".into(), json!(provider.base_url));
                }
                if remote["enable"] != true {
                    patch.insert("enable".into(), json!(true));
                }
                if let (Some(key), Some(fingerprint)) = (&key, &fingerprint)
                    && secrets.get(&provider.applied_name()) != Some(fingerprint)
                {
                    patch.insert("headers".into(), json!(provider.headers(key)));
                }
                if !patch.is_empty() {
                    cf.request(
                        Method::PATCH,
                        &format!("{path}/{id}"),
                        Some(Value::Object(patch)),
                    )
                    .await?;
                }
            }
        }
        if let Some(fingerprint) = fingerprint
            && secrets.get(&provider.applied_name()) != Some(&fingerprint)
        {
            secrets.insert(provider.applied_name(), fingerprint);
            changed = true;
        }
    }
    Ok(changed)
}

/// One page of routes: a bare array or `{ "routes": [...] }`. Any other shape is
/// an error, never an empty list, so an unreadable response cannot recreate
/// routes that exist.
fn routes_of(value: &Value) -> Result<Vec<Value>> {
    value
        .as_array()
        .or_else(|| value.get("routes").and_then(Value::as_array))
        .cloned()
        .context("Cloudflare returned an unexpected dynamic route list")
}
/// Every dynamic route of the gateway, across pages.
async fn list_routes(cf: &Cloudflare, path: &str) -> Result<Vec<Value>> {
    let mut routes = Vec::new();
    for page in 1..=100 {
        let items = routes_of(
            &cf.request(
                Method::GET,
                &format!("{path}?page={page}&per_page=100"),
                None,
            )
            .await?,
        )?;
        let last = items.len() < 100;
        routes.extend(items);
        if last {
            return Ok(routes);
        }
    }
    bail!("too many dynamic routes to enumerate safely")
}
/// Reads and checks every route's elements before anything is changed.
pub fn check_routes(directory: &Path, routes: &[DynamicRoute]) -> Result<()> {
    for route in routes {
        elements(directory, route)?;
    }
    Ok(())
}
fn elements(directory: &Path, route: &DynamicRoute) -> Result<Value> {
    let path = directory.join(&route.elements_file);
    let value: Value = serde_json::from_slice(
        &std::fs::read(&path)
            .with_context(|| format!("reading dynamic route elements {}", path.display()))?,
    )
    .with_context(|| format!("dynamic route {}: elements are not JSON", route.name))?;
    ensure!(
        value.as_array().is_some_and(|a| !a.is_empty()),
        "dynamic route {}: elements must be a non-empty JSON array",
        route.name
    );
    Ok(value)
}
/// Creates missing dynamic routes, and deploys a new version of a route whose
/// elements differ from the local definition.
pub async fn reconcile_routes(
    cf: &Cloudflare,
    gateway: &str,
    directory: &Path,
    routes: &[DynamicRoute],
) -> Result<()> {
    if routes.is_empty() {
        return Ok(());
    }
    let path = format!("{gateway}/routes");
    let existing = list_routes(cf, &path).await?;
    for route in routes {
        let local = elements(directory, route)?;
        match existing.iter().find(|r| r["name"] == route.name.as_str()) {
            None => {
                cf.request(
                    Method::POST,
                    &path,
                    Some(json!({"name": route.name, "elements": local})),
                )
                .await?;
            }
            Some(remote) => {
                let id = remote["id"]
                    .as_str()
                    .context("Cloudflare dynamic route without id")?;
                let current = cf
                    .request(Method::GET, &format!("{path}/{id}"), None)
                    .await?;
                if current["elements"] == local {
                    continue;
                }
                let version = cf
                    .request(
                        Method::POST,
                        &format!("{path}/{id}/versions"),
                        Some(json!({"elements": local})),
                    )
                    .await?;
                let version = version["id"]
                    .as_str()
                    .or_else(|| version["version_id"].as_str())
                    .context("Cloudflare returned a dynamic route version without id")?;
                cf.request(
                    Method::POST,
                    &format!("{path}/{id}/deployments"),
                    Some(json!({"version_id": version})),
                )
                .await?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn interactive_setup_reads_definition_hidden_key_and_profile_models() {
        let mut input = io::Cursor::new(
            "node-anthropic\n2\nhttps://api.llm.example/v1/\nclaude-sonnet-5-5\n\n",
        );
        let (provider, key, models) =
            prompt_with(&mut input, &|| Ok(" hidden-key ".into())).unwrap();
        assert_eq!(provider.slug, "node-anthropic");
        assert_eq!(provider.protocol, Protocol::Anthropic);
        assert_eq!(provider.base_url, "https://api.llm.example/v1");
        assert_eq!(key, "hidden-key");
        assert_eq!(
            models,
            ProfileModels {
                default: "custom-node-anthropic/claude-sonnet-5-5".into(),
                verifier: "custom-node-anthropic/claude-sonnet-5-5".into(),
            }
        );
        // Defaults: slug custom, OpenAI-compatible; a separate verifier model.
        let mut input = io::Cursor::new("\n\nhttps://a.example/v1\ngen\nverify\n");
        let (provider, _, models) = prompt_with(&mut input, &|| Ok("k".into())).unwrap();
        assert_eq!(
            (provider.slug.as_str(), provider.protocol),
            ("custom", Protocol::Openai)
        );
        assert_eq!(models.verifier, "custom-custom/verify");
        // Invalid answers stop before the key is read.
        for bad in ["x\n9\n", "x\n1\nhttps://a.example/v1/chat/completions\n"] {
            let asked = std::cell::Cell::new(false);
            let result = prompt_with(&mut io::Cursor::new(bad), &|| {
                asked.set(true);
                Ok("k".into())
            });
            assert!(result.is_err() && !asked.get(), "{bad}");
        }
        assert!(
            prompt_with(
                &mut io::Cursor::new("x\n1\nhttps://a.example/v1\n"),
                &|| Ok(" ".into())
            )
            .is_err()
        );
    }
    #[test]
    fn the_applied_fingerprint_follows_the_base_url_and_the_rendered_headers() {
        let p = CustomProvider::parse("node-openai:openai:https://api.llm.example/v1").unwrap();
        let fingerprint = p.fingerprint("key-1");
        assert_eq!(fingerprint, p.fingerprint("key-1"));
        assert_ne!(fingerprint, p.fingerprint("key-2"));
        // Another authentication header renders other headers for the same key.
        let header = CustomProvider {
            auth_header: Some(AuthHeader::XApiKey),
            ..p.clone()
        };
        assert_ne!(fingerprint, header.fingerprint("key-1"));
        let moved = CustomProvider {
            base_url: "https://other.llm.example/v1".into(),
            ..p
        };
        assert_ne!(fingerprint, moved.fingerprint("key-1"));
    }
    #[test]
    fn prompt_cache_breakpoints_are_declared_only_for_anthropic_providers() {
        let p = CustomProvider::parse("node:anthropic+breakpoints:https://a.example/v1").unwrap();
        assert_eq!(p.prompt_cache, Some(PromptCache::Breakpoints));
        assert_eq!(
            serde_json::from_str::<Value>(&runtime(std::slice::from_ref(&p))).unwrap(),
            json!({"node":{"protocol":"anthropic","prompt_cache":"breakpoints"}})
        );
        let error = CustomProvider::parse("node:openai+breakpoints:https://a.example/v1")
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("node") && error.contains("requires protocol anthropic"),
            "{error}"
        );
        assert!(CustomProvider::parse("node:anthropic+always:https://a.example/v1").is_err());
        // config.toml form, replayed by `rio deploy --from`.
        let toml: CustomProvider = toml::from_str(
            "slug = \"node\"\nprotocol = \"openai\"\nbase_url = \"https://a.example/v1\"\nprompt_cache = \"breakpoints\"\n",
        )
        .unwrap();
        assert!(validate(&[toml], &BTreeMap::new(), &[]).is_err());
        let mut input = io::Cursor::new("node\n3\nhttps://a.example/v1\nm\n\n");
        let (provider, _, _) = prompt_with(&mut input, &|| Ok("k".into())).unwrap();
        assert_eq!(
            (provider.protocol, provider.prompt_cache),
            (Protocol::Anthropic, Some(PromptCache::Breakpoints))
        );
    }
    #[test]
    fn provider_specs_normalize_and_reject_endpoint_urls_and_bad_slugs() {
        let p = CustomProvider::parse("node-openai:openai:https://api.llm.example/v1/").unwrap();
        assert_eq!(p.base_url, "https://api.llm.example/v1");
        assert_eq!(p.key_name(), "AI_GATEWAY_PROVIDER_KEY_NODE_OPENAI");
        assert_eq!(p.auth_header(), AuthHeader::Authorization);
        let a =
            CustomProvider::parse("node-anthropic:anthropic:https://api.llm.example/v1").unwrap();
        assert_eq!(a.auth_header(), AuthHeader::XApiKey);
        for bad in [
            "custom-node:openai:https://a.example/v1",
            "Node:openai:https://a.example/v1",
            "node:grpc:https://a.example/v1",
            "node:openai:http://a.example/v1",
            "node:openai:https://user:pw@a.example/v1",
            "node:openai:https://a.example/v1?x=1",
            "node:openai:https://a.example/v1/chat/completions",
            "node:anthropic:https://a.example/v1/messages",
            "node:openai",
        ] {
            assert!(CustomProvider::parse(bad).is_err(), "{bad}");
        }
    }
    #[test]
    fn headers_are_a_json_string_and_runtime_config_carries_no_secret() {
        let p = CustomProvider::parse("node:openai:https://a.example/v1").unwrap();
        let headers = p.headers("upstream-key");
        assert!(headers.starts_with('{'));
        let parsed: Value = serde_json::from_str(&headers).unwrap();
        assert_eq!(parsed["Authorization"], "Bearer upstream-key");
        let a = CustomProvider::parse("claude:anthropic:https://a.example/v1").unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&a.headers("k")).unwrap(),
            json!({"x-api-key":"k"})
        );
        let runtime = runtime(&[p.clone(), a]);
        assert_eq!(
            serde_json::from_str::<Value>(&runtime).unwrap(),
            json!({"claude":{"protocol":"anthropic"},"node":{"protocol":"openai"}})
        );
        assert!(!runtime.contains("upstream-key"));
        // The fingerprint changes with the key and the base URL only.
        assert_eq!(p.fingerprint("k1"), p.fingerprint("k1"));
        assert_ne!(p.fingerprint("k1"), p.fingerprint("k2"));
        assert!(!p.fingerprint("upstream-key").contains("upstream-key"));
    }
    #[test]
    fn gateway_choices_validate_prices_routes_and_duplicates() {
        let p = CustomProvider::parse("node:openai:https://a.example/v1").unwrap();
        let price = |input, output| ModelPrice {
            input,
            output,
            cache_read: None,
            cache_write: None,
        };
        let route = |name: &str| DynamicRoute {
            name: name.into(),
            elements_file: "r.json".into(),
        };
        assert!(
            validate(
                std::slice::from_ref(&p),
                &BTreeMap::new(),
                &[route("support")]
            )
            .is_ok()
        );
        assert!(validate(&[p.clone(), p.clone()], &BTreeMap::new(), &[]).is_err());
        for bad in [price(-1.0, 1.0), price(f64::NAN, 1.0)] {
            let prices = [("custom-node/m".to_owned(), bad)].into_iter().collect();
            assert!(validate(&[], &prices, &[]).is_err());
        }
        let prices = [("model".to_owned(), price(1.0, 1.0))]
            .into_iter()
            .collect();
        assert!(validate(&[], &prices, &[]).is_err());
        // Cache rates are optional and, when given, non-negative.
        let cached = ModelPrice {
            cache_read: Some(0.15),
            cache_write: Some(3.75),
            ..price(3.0, 15.0)
        };
        let prices: BTreeMap<_, _> = [("anthropic/claude-sonnet-5-5".to_owned(), cached)]
            .into_iter()
            .collect();
        assert!(validate(&[], &prices, &[]).is_ok());
        assert_eq!(
            serde_json::from_str::<Value>(&super::prices(&prices)).unwrap(),
            json!({"anthropic/claude-sonnet-5-5": {"input": 3.0, "output": 15.0, "cache_read": 0.15, "cache_write": 3.75}})
        );
        let old: BTreeMap<String, ModelPrice> =
            serde_json::from_str(r#"{"custom-node/m":{"input":1,"output":2}}"#).unwrap();
        assert_eq!(
            super::prices(&old),
            r#"{"custom-node/m":{"input":1.0,"output":2.0}}"#
        );
        for bad in [Some(-1.0), Some(f64::INFINITY)] {
            let prices = [(
                "custom-node/m".to_owned(),
                ModelPrice {
                    cache_read: bad,
                    ..price(1.0, 1.0)
                },
            )]
            .into_iter()
            .collect();
            let error = validate(&[], &prices, &[]).unwrap_err().to_string();
            assert!(error.contains("cache_read"), "{error}");
        }
        assert!(validate(&[], &BTreeMap::new(), &[route("a b")]).is_err());
        assert!(validate(&[], &BTreeMap::new(), &[route("a"), route("a")]).is_err());
    }
}

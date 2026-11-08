//! The GitHub App for PR mode (docs/github-app.md): registration through
//! GitHub's manifest flow during `rio init`, the Worker secrets it creates,
//! webhook secret rotation for `rio doctor --rotate`, and the doctor lines.
//! The private key and webhook secret go from GitHub straight to the Worker's
//! secrets; they are held in memory only and never written to disk.
use anyhow::{Context, Result, bail, ensure};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    net::TcpListener,
    path::Path,
    time::{Duration, Instant},
};

use crate::deployment::{Cloudflare, Deployment};

/// Exactly the permissions the app needs; `docs/github-app.md` lists the same.
pub const PERMISSIONS: [(&str, &str); 5] = [
    ("contents", "read"),
    ("pull_requests", "write"),
    ("checks", "write"),
    ("metadata", "read"),
    ("members", "read"),
];
pub const EVENTS: [&str; 2] = ["pull_request", "issue_comment"];
/// GitHub limits app names to 34 characters.
const NAME_LIMIT: usize = 34;
const FLOW_TIMEOUT: Duration = Duration::from_secs(600);

/// What `config.toml` records about the app: identifiers only, no secrets.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AppRecord {
    pub app_id: u64,
    pub slug: String,
    pub installation_url: String,
}

pub fn web_base() -> String {
    std::env::var("RIO_GITHUB_URL").unwrap_or_else(|_| "https://github.com".into())
}
pub fn api_base() -> String {
    std::env::var("RIO_GITHUB_API_URL").unwrap_or_else(|_| "https://api.github.com".into())
}

/// The app manifest for an endpoint (docs/github-app.md, "The manifest").
pub fn manifest(endpoint: &str, redirect: &str) -> Value {
    let host = endpoint
        .split("://")
        .nth(1)
        .unwrap_or(endpoint)
        .trim_end_matches('/')
        .trim_end_matches(".workers.dev");
    let name: String = format!("Rio review {host}")
        .chars()
        .take(NAME_LIMIT)
        .collect();
    json!({
        "name": name.trim_end(),
        "url": "https://github.com/pixelinfinito/rio",
        "hook_attributes": {"url": format!("{}/v1/hooks/github", endpoint.trim_end_matches('/')), "active": true},
        "redirect_url": redirect,
        "public": false,
        "default_permissions": PERMISSIONS.iter().map(|(k, v)| (k.to_string(), json!(v))).collect::<serde_json::Map<_, _>>(),
        "default_events": EVENTS,
    })
}

fn html_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
fn random_hex(bytes: usize) -> Result<String> {
    let mut buffer = vec![0u8; bytes];
    getrandom::fill(&mut buffer).map_err(|_| anyhow::anyhow!("OS random generator unavailable"))?;
    Ok(buffer.iter().map(|b| format!("{b:02x}")).collect())
}
fn respond(stream: &mut std::net::TcpStream, status: &str, body: &str) {
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
}

/// Serves the loopback page that posts the manifest to GitHub and waits for
/// GitHub's redirect with the temporary code. A mismatched `state` is refused.
pub fn manifest_code(
    endpoint: &str,
    organization: Option<&str>,
    open: &dyn Fn(&str),
    timeout: Duration,
) -> Result<String> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    let state = random_hex(16)?;
    let redirect = format!("http://127.0.0.1:{port}/github-app/callback");
    let manifest = manifest(endpoint, &redirect);
    let action = match organization {
        Some(org) => {
            ensure!(
                !org.is_empty() && org.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'),
                "invalid GitHub organization"
            );
            format!(
                "{}/organizations/{org}/settings/apps/new?state={state}",
                web_base()
            )
        }
        None => format!("{}/settings/apps/new?state={state}", web_base()),
    };
    let page = format!(
        "<!doctype html><title>Register the Rio GitHub App</title><p>Registering the Rio GitHub App on GitHub…</p><form id=\"m\" method=\"post\" action=\"{}\"><input type=\"hidden\" name=\"manifest\" value=\"{}\"><button>Continue to GitHub</button></form><script>document.getElementById('m').submit()</script>",
        html_escape(&action),
        html_escape(&manifest.to_string())
    );
    open(&format!("http://127.0.0.1:{port}/"));
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        let (mut stream, _) = match listener.accept() {
            Ok(connection) => connection,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(20));
                continue;
            }
            Err(error) => return Err(error.into()),
        };
        stream.set_nonblocking(false)?;
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        let mut line = String::new();
        if BufReader::new(&stream).read_line(&mut line).is_err() {
            continue;
        }
        let target = line.split_whitespace().nth(1).unwrap_or("/").to_owned();
        let (path, query) = target.split_once('?').unwrap_or((&target, ""));
        if path == "/" {
            respond(&mut stream, "200 OK", &page);
            continue;
        }
        if path != "/github-app/callback" {
            respond(&mut stream, "404 Not Found", "Not found");
            continue;
        }
        let parameter = |name: &str| {
            query
                .split('&')
                .find_map(|pair| pair.strip_prefix(&format!("{name}=")))
                .map(str::to_owned)
        };
        let returned = parameter("state").unwrap_or_default();
        if !crate::deployment::constant_eq(&returned, &state) {
            respond(
                &mut stream,
                "400 Bad Request",
                "The GitHub App registration did not match this request; nothing was stored.",
            );
            continue;
        }
        let Some(code) = parameter("code").filter(|c| {
            !c.is_empty()
                && c.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        }) else {
            respond(
                &mut stream,
                "400 Bad Request",
                "GitHub returned no registration code.",
            );
            continue;
        };
        respond(
            &mut stream,
            "200 OK",
            "<!doctype html><p>The Rio GitHub App is registered. You can close this window and return to the terminal.</p>",
        );
        return Ok(code);
    }
    bail!(
        "the GitHub App registration did not complete within {} minutes",
        timeout.as_secs() / 60
    )
}

/// The app's credentials as GitHub returns them from the manifest conversion.
pub struct Conversion {
    pub id: u64,
    pub slug: String,
    pub pem: String,
    pub webhook_secret: String,
}
pub async fn convert(code: &str) -> Result<Conversion> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let response = client
        .post(format!(
            "{}/app-manifests/{code}/conversions",
            api_base().trim_end_matches('/')
        ))
        .header("accept", "application/vnd.github+json")
        .header("user-agent", "rio-cli")
        .send()
        .await
        .context("contacting GitHub")?;
    // The body holds the private key; it is never printed.
    ensure!(
        response.status().is_success(),
        "GitHub refused the app registration code (HTTP {})",
        response.status().as_u16()
    );
    let value: Value = response
        .json()
        .await
        .context("GitHub returned an invalid app")?;
    Ok(Conversion {
        id: value["id"].as_u64().context("GitHub returned no app id")?,
        slug: value["slug"]
            .as_str()
            .context("GitHub returned no app slug")?
            .to_owned(),
        pem: value["pem"]
            .as_str()
            .context("GitHub returned no private key")?
            .to_owned(),
        webhook_secret: value["webhook_secret"]
            .as_str()
            .filter(|s| !s.is_empty())
            .context("GitHub returned no webhook secret")?
            .to_owned(),
    })
}

/// Writes one Worker secret through the Cloudflare API.
pub async fn put_secret(
    cf: &Cloudflare,
    deployment: &Deployment,
    name: &str,
    text: &str,
) -> Result<()> {
    let account = deployment
        .account_id
        .as_deref()
        .context("missing account")?;
    cf.request(
        Method::PUT,
        &format!(
            "/accounts/{account}/workers/scripts/{}/secrets",
            deployment.name
        ),
        Some(json!({"name": name, "text": text, "type": "secret_text"})),
    )
    .await
    .map(|_| ())
}
pub async fn delete_secret(cf: &Cloudflare, deployment: &Deployment, name: &str) -> Result<()> {
    let account = deployment
        .account_id
        .as_deref()
        .context("missing account")?;
    cf.request(
        Method::DELETE,
        &format!(
            "/accounts/{account}/workers/scripts/{}/secrets/{name}",
            deployment.name
        ),
        None,
    )
    .await
    .map(|_| ())
}

/// Registers the app and stores its secrets on the Worker; returns what
/// `config.toml` records.
pub async fn register(
    cf: &Cloudflare,
    deployment: &Deployment,
    endpoint: &str,
    organization: Option<&str>,
    open: &(dyn Fn(&str) + Sync),
) -> Result<AppRecord> {
    let endpoint_owned = endpoint.to_owned();
    let organization = organization.map(str::to_owned);
    let code = tokio::task::block_in_place(|| {
        manifest_code(&endpoint_owned, organization.as_deref(), open, FLOW_TIMEOUT)
    })?;
    let app = convert(&code).await?;
    for (name, text) in [
        ("GITHUB_APP_ID", app.id.to_string()),
        ("GITHUB_APP_PRIVATE_KEY", app.pem.clone()),
        ("GITHUB_WEBHOOK_SECRET", app.webhook_secret.clone()),
    ] {
        put_secret(cf, deployment, name, &text)
            .await
            .with_context(|| format!("storing {name} on the endpoint"))?;
    }
    Ok(AppRecord {
        app_id: app.id,
        installation_url: format!("{}/apps/{}/installations/new", web_base(), app.slug),
        slug: app.slug,
    })
}

/// Records the app (identifiers only) in `config.toml`.
pub fn save_record(directory: &Path, record: &AppRecord) -> Result<()> {
    let file = directory.join("config.toml");
    let mut value: toml::Value = match std::fs::read_to_string(&file) {
        Ok(text) => toml::from_str(&text)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            toml::Value::Table(Default::default())
        }
        Err(error) => return Err(error.into()),
    };
    value
        .as_table_mut()
        .context("configuration must be a TOML table")?
        .insert("github_app".into(), toml::Value::try_from(record)?);
    rio_engine::atomic_write(&file, toml::to_string_pretty(&value)?.as_bytes())
}

/// Opens a URL in the user's browser, best effort; the URL is always printed.
pub fn open_browser(url: &str) {
    eprintln!("Open {url} to register the Rio GitHub App (the page continues to GitHub).");
    let command = if cfg!(target_os = "macos") {
        Some(("open", vec![url]))
    } else if cfg!(windows) {
        Some(("cmd", vec!["/c", "start", "", url]))
    } else {
        Some(("xdg-open", vec![url]))
    };
    if let Some((program, args)) = command {
        let _ = std::process::Command::new(program)
            .args(args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
    }
}

/// A webhook delivery signed like GitHub's, for verifying the endpoint's secret.
pub fn signature(secret: &str, body: &[u8]) -> String {
    use hmac::{Hmac, Mac};
    let mut mac = Hmac::<sha2::Sha256>::new_from_slice(secret.as_bytes()).expect("any key length");
    mac.update(body);
    format!(
        "sha256={}",
        mac.finalize()
            .into_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    )
}

/// Sends a signed `ping` until the endpoint accepts it (204) or a deadline passes;
/// a new Worker secret takes a few seconds to reach every location.
pub async fn ping(endpoint: &str, secret: &str, wait: Duration) -> Result<()> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()?;
    let body = br#"{"zen":"Rio webhook secret rotation","hook_id":0}"#;
    let deadline = Instant::now() + wait;
    loop {
        let status = client
            .post(format!(
                "{}/v1/hooks/github",
                endpoint.trim_end_matches('/')
            ))
            .header("x-github-event", "ping")
            .header(
                "x-github-delivery",
                format!("rio-rotate-{}", random_hex(8)?),
            )
            .header("x-hub-signature-256", signature(secret, body))
            .header("content-type", "application/json")
            .body(body.to_vec())
            .send()
            .await
            .map(|r| r.status().as_u16());
        if matches!(status, Ok(204)) {
            return Ok(());
        }
        if Instant::now() >= deadline {
            bail!(
                "the endpoint did not accept a ping signed with the new secret ({})",
                match status {
                    Ok(code) => format!("HTTP {code}"),
                    Err(error) => format!("{error}"),
                }
            );
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

/// `rio doctor --rotate`. The new secret is first accepted beside the current
/// one, verified, then set on the app, then made the only secret. Each failure
/// leaves the previous secret in effect on both sides and names its step.
pub async fn rotate(
    cf: &Cloudflare,
    deployment: &Deployment,
    endpoint: &str,
    client: &rio_client::Client,
    wait: Duration,
) -> std::result::Result<(), (String, anyhow::Error)> {
    let fresh = random_hex(32).map_err(|e| ("generating a secret".to_owned(), e))?;
    let step = |name: &str| name.to_owned();
    put_secret(cf, deployment, "GITHUB_WEBHOOK_SECRET_NEXT", &fresh)
        .await
        .map_err(|e| (step("endpoint secret update"), e))?;
    let undo_next = || async {
        let _ = delete_secret(cf, deployment, "GITHUB_WEBHOOK_SECRET_NEXT").await;
    };
    if let Err(error) = ping(endpoint, &fresh, wait).await {
        undo_next().await;
        return Err((step("ping verification"), error));
    }
    if let Err(error) = client.hook_config(&json!({"secret": fresh})).await {
        undo_next().await;
        return Err((step("GitHub App webhook update"), error));
    }
    if let Err(error) = put_secret(cf, deployment, "GITHUB_WEBHOOK_SECRET", &fresh).await {
        // The endpoint still holds the previous secret; put it back on the app.
        let _ = client.hook_config(&json!({"restore": true})).await;
        undo_next().await;
        return Err((step("endpoint secret update"), error));
    }
    if let Err(error) = delete_secret(cf, deployment, "GITHUB_WEBHOOK_SECRET_NEXT").await {
        eprintln!(
            "Warning: the temporary GITHUB_WEBHOOK_SECRET_NEXT could not be removed ({error:#}); it equals the new secret"
        );
    }
    ping(endpoint, &fresh, wait)
        .await
        .map_err(|e| (step("ping verification"), e))
}

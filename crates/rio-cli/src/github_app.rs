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
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use crate::deployment::{Cloudflare, Deployment};

/// Exactly the permissions the app needs; `docs/github-app.md` lists the same.
pub const PERMISSIONS: [(&str, &str); 6] = [
    ("contents", "write"),
    ("pull_requests", "write"),
    ("checks", "write"),
    ("metadata", "read"),
    ("members", "read"),
    ("issues", "read"),
];
pub const EVENTS: [&str; 2] = ["pull_request", "issue_comment"];
/// The app's description on GitHub (the manifest sets it; GitHub has no API for the logo).
pub const DESCRIPTION: &str = "Rio reviews pull requests on an endpoint you run. Deterministic checks and an impact graph come first; model agents propose findings and independent verifiers must prove them from the code before anything is posted.\n\n- Inline comments for proven findings and one summary comment per pull request\n- A `rio/review` check run that shows progress and is always neutral: it never blocks a merge\n- Comment `/rio review` to re-run, or `/rio dismiss <id> <reason>` to answer a finding\n\nSource and documentation: https://github.com/pixelinfinito/rio";
/// The app logo `rio init` saves for upload (docs/assets/rio-app-logo.png).
pub const LOGO: &[u8] = include_bytes!("../../../docs/assets/rio-app-logo.png");
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
        "description": DESCRIPTION,
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
    web: &str,
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
                web.trim_end_matches('/')
            )
        }
        None => format!(
            "{}/settings/apps/new?state={state}",
            web.trim_end_matches('/')
        ),
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
pub async fn convert(api: &str, code: &str) -> Result<Conversion> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let response = client
        .post(format!(
            "{}/app-manifests/{code}/conversions",
            api.trim_end_matches('/')
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
pub struct GitHubUrls {
    pub web: String,
    pub api: String,
}
impl GitHubUrls {
    pub fn from_environment() -> Self {
        Self {
            web: web_base(),
            api: api_base(),
        }
    }
}
pub async fn register(
    cf: &Cloudflare,
    deployment: &Deployment,
    endpoint: &str,
    organization: Option<&str>,
    urls: &GitHubUrls,
    open: &(dyn Fn(&str) + Sync),
) -> Result<AppRecord> {
    let code = tokio::task::block_in_place(|| {
        manifest_code(endpoint, organization, &urls.web, open, FLOW_TIMEOUT)
    })?;
    let app = convert(&urls.api, &code).await?;
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
        installation_url: format!("{}/apps/{}/installations/new", urls.web, app.slug),
        slug: app.slug,
    })
}

/// Whether `rio init` runs the GitHub App step: chosen by flag, replayed from
/// `config.toml`, or accepted at the prompt when nothing is registered yet.
pub fn wanted(
    flag: bool,
    replay: bool,
    chosen_before: bool,
    registered: bool,
    interactive: bool,
    ask: impl FnOnce() -> bool,
) -> bool {
    flag || (replay && chosen_before) || (!replay && !registered && interactive && ask())
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

/// Saves the logo next to `config.toml` and returns the app settings page to
/// upload it on: GitHub accepts an app logo only through its web interface.
pub fn save_logo(
    directory: &Path,
    slug: &str,
    organization: Option<&str>,
) -> Result<(PathBuf, String)> {
    let path = directory.join("rio-app-logo.png");
    rio_engine::atomic_write(&path, LOGO)?;
    let base = web_base();
    let settings = match organization {
        Some(org) => format!(
            "{}/organizations/{org}/settings/apps/{slug}",
            base.trim_end_matches('/')
        ),
        None => format!("{}/settings/apps/{slug}", base.trim_end_matches('/')),
    };
    Ok((path, settings))
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
    // Both sides already hold the new secret; only its verification is left.
    ping(endpoint, &fresh, wait)
        .await
        .map_err(|e| (step(FINAL_PING), e))
}
/// The last rotation step, after which the new secret is in effect everywhere.
pub const FINAL_PING: &str = "final ping verification";

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::BTreeMap,
        io::Read,
        sync::{Arc, Mutex},
    };

    type Handler =
        Arc<dyn Fn(&str, &str, &BTreeMap<String, String>, &[u8]) -> (u16, String) + Send + Sync>;
    /// A loopback HTTP double; `handler(method, path, headers, body)` answers.
    struct Double {
        url: String,
        stop: Arc<std::sync::atomic::AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }
    impl Double {
        fn start(handler: Handler) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let halt = stop.clone();
            let thread = std::thread::spawn(move || {
                while !halt.load(std::sync::atomic::Ordering::SeqCst) {
                    let mut stream = match listener.accept() {
                        Ok((stream, _)) => stream,
                        Err(_) => {
                            std::thread::sleep(Duration::from_millis(5));
                            continue;
                        }
                    };
                    stream.set_nonblocking(false).unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(5)))
                        .unwrap();
                    let mut bytes = Vec::new();
                    let mut chunk = [0; 65536];
                    let (end, head) = loop {
                        let Ok(n) = stream.read(&mut chunk) else {
                            break (0, String::new());
                        };
                        if n == 0 {
                            break (0, String::new());
                        }
                        bytes.extend_from_slice(&chunk[..n]);
                        if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                            let head = String::from_utf8_lossy(&bytes[..end]).to_string();
                            let length = head
                                .lines()
                                .find_map(|l| {
                                    l.to_lowercase()
                                        .strip_prefix("content-length: ")
                                        .map(str::to_owned)
                                })
                                .and_then(|l| l.parse::<usize>().ok())
                                .unwrap_or(0);
                            if bytes.len() >= end + 4 + length {
                                break (end, head);
                            }
                        }
                    };
                    if head.is_empty() {
                        continue;
                    }
                    let mut lines = head.lines();
                    let mut first = lines.next().unwrap().split_whitespace();
                    let (method, path) = (
                        first.next().unwrap().to_owned(),
                        first.next().unwrap().to_owned(),
                    );
                    let headers: BTreeMap<String, String> = lines
                        .filter_map(|l| l.split_once(": "))
                        .map(|(k, v)| (k.to_lowercase(), v.to_owned()))
                        .collect();
                    let (status, body) = handler(&method, &path, &headers, &bytes[end + 4..]);
                    let _ = write!(
                        stream,
                        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                }
            });
            Self {
                url,
                stop,
                thread: Some(thread),
            }
        }
    }
    impl Drop for Double {
        fn drop(&mut self) {
            self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
            let _ = self.thread.take().unwrap().join();
        }
    }
    fn deployment() -> Deployment {
        Deployment {
            account_id: Some("c".repeat(32)),
            ..Default::default()
        }
    }
    /// A plain HTTP GET, as the browser makes it.
    fn get(url: &str) -> (u16, String) {
        let rest = url.strip_prefix("http://").unwrap();
        let (authority, path) = rest
            .split_once('/')
            .map_or((rest, "/".to_owned()), |(a, p)| (a, format!("/{p}")));
        let mut stream = std::net::TcpStream::connect(authority).unwrap();
        write!(
            stream,
            "GET {path} HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\n\r\n"
        )
        .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        let status = response.split_whitespace().nth(1).unwrap().parse().unwrap();
        let body = response
            .split_once("\r\n\r\n")
            .map(|(_, b)| b.to_owned())
            .unwrap_or_default();
        (status, body)
    }

    #[test]
    fn the_manifest_declares_exactly_the_documented_permissions_and_events() {
        let doc = include_str!("../../../docs/github-app.md");
        let start = doc.find("The manifest `rio init` submits:").unwrap();
        let block = &doc[start..];
        let json_start = block.find("```json\n").unwrap() + 8;
        let json_end = block[json_start..].find("```").unwrap();
        let documented: Value =
            serde_json::from_str(&block[json_start..json_start + json_end]).unwrap();
        let manifest = manifest(
            "https://rio.rio-210f84d0a5c4.workers.dev",
            "http://127.0.0.1:1/github-app/callback",
        );
        assert_eq!(
            manifest["default_permissions"],
            documented["default_permissions"]
        );
        assert_eq!(manifest["default_events"], documented["default_events"]);
        assert_eq!(manifest["public"], false);
        assert_eq!(manifest["description"], DESCRIPTION);
        assert_eq!(
            manifest["hook_attributes"],
            json!({"url": "https://rio.rio-210f84d0a5c4.workers.dev/v1/hooks/github", "active": true})
        );
        assert_eq!(manifest["name"], "Rio review rio.rio-210f84d0a5c4");
        assert!(manifest["name"].as_str().unwrap().len() <= NAME_LIMIT);
        // The documentation's permission table lists the same six.
        for (name, access) in PERMISSIONS {
            assert!(
                doc.contains(&format!("| `{name}` | `{access}` |")),
                "{name}"
            );
        }
    }

    #[test]
    fn the_logo_is_saved_for_upload_with_the_app_settings_page() {
        let directory = tempfile::tempdir().unwrap();
        let (path, settings) = save_logo(directory.path(), "rio-review", None).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), LOGO);
        assert!(LOGO.starts_with(b"\x89PNG"));
        assert!(settings.ends_with("/settings/apps/rio-review"));
        let (_, org) = save_logo(directory.path(), "rio-review", Some("acme")).unwrap();
        assert!(org.ends_with("/organizations/acme/settings/apps/rio-review"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn registration_stores_the_secrets_on_the_worker_and_nothing_secret_on_disk() {
        const PEM: &str =
            "-----BEGIN RSA PRIVATE KEY-----\nMIIEtestkeymaterial\n-----END RSA PRIVATE KEY-----\n";
        const HOOK: &str = "webhook-secret-from-github-0123456789";
        let secrets = Arc::new(Mutex::new(Vec::<(String, Value)>::new()));
        let recorded = secrets.clone();
        let double = Double::start(Arc::new(move |method, path, _, body| {
            if method == "POST" && path == "/app-manifests/temporary-code/conversions" {
                return (201, json!({"id": 4242, "slug": "rio-review-test", "pem": PEM, "webhook_secret": HOOK,
                                    "client_id": "Iv1.x", "client_secret": "client-secret-discarded", "html_url": "https://github.com/apps/rio-review-test"}).to_string());
            }
            if method == "PUT" && path.ends_with("/workers/scripts/rio/secrets") {
                recorded
                    .lock()
                    .unwrap()
                    .push((path.to_owned(), serde_json::from_slice(body).unwrap()));
                return (200, json!({"success": true, "result": {}}).to_string());
            }
            (404, "{}".into())
        }));
        let cf = Cloudflare::at(&double.url, "cloudflare-token").unwrap();
        let urls = GitHubUrls {
            web: "https://github.test".into(),
            api: double.url.clone(),
        };
        let pages = Arc::new(Mutex::new(Vec::<String>::new()));
        let seen = pages.clone();
        // The browser: load the local page, then return through GitHub's redirect.
        let browser = move |url: &str| {
            let url = url.to_owned();
            let seen = seen.clone();
            std::thread::spawn(move || {
                let (_, page) = get(&url);
                let action = page
                    .split("action=\"")
                    .nth(1)
                    .unwrap()
                    .split('"')
                    .next()
                    .unwrap()
                    .replace("&amp;", "&");
                let state = action.split("state=").nth(1).unwrap().to_owned();
                seen.lock().unwrap().push(page);
                assert_eq!(
                    get(&format!(
                        "{url}github-app/callback?code=temporary-code&state=forged"
                    ))
                    .0,
                    400
                );
                assert_eq!(
                    get(&format!(
                        "{url}github-app/callback?code=temporary-code&state={state}"
                    ))
                    .0,
                    200
                );
            });
        };
        let record = register(
            &cf,
            &deployment(),
            "https://rio.example.workers.dev",
            None,
            &urls,
            &browser,
        )
        .await
        .unwrap();
        assert_eq!(
            record,
            AppRecord {
                app_id: 4242,
                slug: "rio-review-test".into(),
                installation_url: "https://github.test/apps/rio-review-test/installations/new"
                    .into(),
            }
        );
        let page = pages.lock().unwrap()[0].clone();
        assert!(page.contains("action=\"https://github.test/settings/apps/new?state="));
        assert!(page.contains("&quot;pull_requests&quot;:&quot;write&quot;"));
        let secrets = secrets.lock().unwrap();
        assert_eq!(
            secrets
                .iter()
                .map(|(_, b)| b["name"].as_str().unwrap())
                .collect::<Vec<_>>(),
            [
                "GITHUB_APP_ID",
                "GITHUB_APP_PRIVATE_KEY",
                "GITHUB_WEBHOOK_SECRET"
            ]
        );
        assert_eq!(secrets[1].1["text"], PEM);
        assert_eq!(secrets[2].1["text"], HOOK);
        assert!(secrets.iter().all(|(path, b)| path
            == &format!("/accounts/{}/workers/scripts/rio/secrets", "c".repeat(32))
            && b["type"] == "secret_text"));
        // config.toml records identifiers only; no file holds a secret.
        let directory = tempfile::tempdir().unwrap();
        save_record(directory.path(), &record).unwrap();
        let config = std::fs::read_to_string(directory.path().join("config.toml")).unwrap();
        assert!(config.contains("app_id = 4242") && config.contains("slug = \"rio-review-test\""));
        for entry in walk(directory.path()) {
            let text = String::from_utf8_lossy(&std::fs::read(entry).unwrap()).to_string();
            assert!(
                !text.contains("PRIVATE KEY")
                    && !text.contains(HOOK)
                    && !text.contains("client-secret")
            );
        }
    }
    fn walk(root: &Path) -> Vec<std::path::PathBuf> {
        let mut files = Vec::new();
        for entry in std::fs::read_dir(root).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                files.extend(walk(&path));
            } else {
                files.push(path);
            }
        }
        files
    }

    #[test]
    fn the_step_runs_when_chosen_replayed_or_accepted_and_never_otherwise() {
        let never = || -> bool { panic!("must not prompt") };
        assert!(wanted(true, false, false, false, false, never));
        // Declined at the prompt: nothing happens.
        assert!(!wanted(false, false, false, false, true, || false));
        assert!(wanted(false, false, false, false, true, || true));
        // Non-interactive without the flag, or with an app already registered: no prompt.
        assert!(!wanted(false, false, false, false, false, never));
        assert!(!wanted(false, false, false, true, true, never));
        // `rio init --from config.toml` replays the recorded choice.
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("config.toml");
        std::fs::write(
            &file,
            format!("[deployment]\naccount_id = \"{}\"\nname = \"rio\"\ngithub_app = true\ngithub_org = \"acme\"\n", "d".repeat(32)),
        )
        .unwrap();
        let args = crate::deployment::DeployArgs {
            from: Some(file.clone()),
            ..Default::default()
        };
        let chosen = crate::deployment::choices(&args, directory.path()).unwrap();
        assert!(chosen.github_app);
        assert_eq!(chosen.github_org.as_deref(), Some("acme"));
        assert!(wanted(false, true, chosen.github_app, true, false, never));
        std::fs::write(
            &file,
            format!(
                "[deployment]\naccount_id = \"{}\"\nname = \"rio\"\n",
                "d".repeat(32)
            ),
        )
        .unwrap();
        let chosen = crate::deployment::choices(&args, directory.path()).unwrap();
        assert!(!wanted(false, true, chosen.github_app, false, false, never));
        // The saved choices round-trip without secrets.
        let saved = toml::to_string(&Deployment {
            github_app: true,
            ..deployment()
        })
        .unwrap();
        assert!(saved.contains("github_app = true"));
    }

    /// The endpoint, Cloudflare and GitHub as rotation sees them: Worker
    /// secrets set through Cloudflare decide which signatures the webhook
    /// accepts; the endpoint sets the app's secret with its App JWT.
    struct Rotation {
        main: String,
        next: Option<String>,
        app: String,
        fail_app_update: bool,
        fail_main_update: bool,
        pings: Vec<bool>,
    }
    fn rotation_double(state: Arc<Mutex<Rotation>>) -> Double {
        Double::start(Arc::new(move |method, path, headers, body| {
            let mut s = state.lock().unwrap();
            let ok = json!({"success": true, "result": {}}).to_string();
            if path.ends_with("/workers/scripts/rio/secrets") && method == "PUT" {
                let body: Value = serde_json::from_slice(body).unwrap();
                let text = body["text"].as_str().unwrap().to_owned();
                match body["name"].as_str().unwrap() {
                    "GITHUB_WEBHOOK_SECRET_NEXT" => s.next = Some(text),
                    "GITHUB_WEBHOOK_SECRET" if s.fail_main_update => {
                        return (
                            500,
                            json!({"success": false, "errors": [{"code": 10000}]}).to_string(),
                        );
                    }
                    "GITHUB_WEBHOOK_SECRET" => s.main = text,
                    _ => {}
                }
                return (200, ok);
            }
            if path.ends_with("/secrets/GITHUB_WEBHOOK_SECRET_NEXT") && method == "DELETE" {
                s.next = None;
                return (200, ok);
            }
            if path == "/v1/hooks/github" {
                let header = headers
                    .get("x-hub-signature-256")
                    .cloned()
                    .unwrap_or_default();
                let accepted = [Some(s.main.clone()), s.next.clone()]
                    .into_iter()
                    .flatten()
                    .any(|secret| signature(&secret, body) == header);
                s.pings.push(accepted);
                return (if accepted { 204 } else { 401 }, String::new());
            }
            if path == "/v1/github/hook-config" {
                assert_eq!(
                    headers.get("authorization").map(String::as_str),
                    Some("Bearer rotation-owner-token-32-characters")
                );
                if s.fail_app_update {
                    return (
                        502,
                        json!({"error": "GitHub rejected the app webhook update"}).to_string(),
                    );
                }
                let body: Value = serde_json::from_slice(body).unwrap();
                s.app = if body["restore"] == true {
                    s.main.clone()
                } else {
                    body["secret"].as_str().unwrap().to_owned()
                };
                return (200, json!({"updated": true}).to_string());
            }
            (404, "{}".into())
        }))
    }
    async fn run_rotation(
        state: Arc<Mutex<Rotation>>,
    ) -> std::result::Result<(), (String, anyhow::Error)> {
        let double = rotation_double(state);
        let cf = Cloudflare::at(&double.url, "cloudflare-token").unwrap();
        let client =
            rio_client::Client::new(&double.url, "rotation-owner-token-32-characters".into())
                .unwrap();
        rotate(
            &cf,
            &deployment(),
            &double.url,
            &client,
            Duration::from_millis(500),
        )
        .await
    }
    fn state(fail_app_update: bool, fail_main_update: bool) -> Arc<Mutex<Rotation>> {
        Arc::new(Mutex::new(Rotation {
            main: "old-secret".into(),
            next: None,
            app: "old-secret".into(),
            fail_app_update,
            fail_main_update,
            pings: Vec::new(),
        }))
    }

    #[tokio::test]
    async fn rotation_moves_both_sides_to_a_verified_new_secret() {
        let s = state(false, false);
        run_rotation(s.clone()).await.unwrap();
        let s = s.lock().unwrap();
        assert_ne!(s.main, "old-secret");
        assert_eq!(s.app, s.main);
        assert_eq!(s.next, None);
        assert_eq!(s.pings, [true, true]);
    }

    #[tokio::test]
    async fn a_failed_final_ping_is_reported_as_its_own_step() {
        let s = state(false, false);
        let double = rotation_double(s.clone());
        let cf = Cloudflare::at(&double.url, "cloudflare-token").unwrap();
        let client =
            rio_client::Client::new(&double.url, "rotation-owner-token-32-characters".into())
                .unwrap();
        // Every second ping fails: the first verifies the new secret, the final one does not.
        let pings = Arc::new(Mutex::new(0));
        let failing = Double::start({
            let pings = pings.clone();
            Arc::new(move |_, _, _, _| {
                let mut n = pings.lock().unwrap();
                *n += 1;
                (if *n == 1 { 204 } else { 503 }, String::new())
            })
        });
        let (step, _) = rotate(
            &cf,
            &deployment(),
            &failing.url,
            &client,
            Duration::from_millis(300),
        )
        .await
        .unwrap_err();
        assert_eq!(step, FINAL_PING);
        let s = s.lock().unwrap();
        assert_ne!(s.main, "old-secret");
        assert_eq!(s.app, s.main);
    }

    #[tokio::test]
    async fn a_rejected_app_update_keeps_the_previous_secret_on_both_sides() {
        let s = state(true, false);
        let (step, _) = run_rotation(s.clone()).await.unwrap_err();
        assert_eq!(step, "GitHub App webhook update");
        let s = s.lock().unwrap();
        assert_eq!(
            (s.main.as_str(), s.app.as_str(), s.next.as_ref()),
            ("old-secret", "old-secret", None)
        );
    }

    #[tokio::test]
    async fn a_failed_endpoint_update_puts_the_previous_secret_back_on_the_app() {
        let s = state(false, true);
        let (step, _) = run_rotation(s.clone()).await.unwrap_err();
        assert_eq!(step, "endpoint secret update");
        let s = s.lock().unwrap();
        assert_eq!(
            (s.main.as_str(), s.app.as_str(), s.next.as_ref()),
            ("old-secret", "old-secret", None)
        );
    }
}

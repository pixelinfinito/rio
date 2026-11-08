//! The `prepare` job of a pull request review on the Docker backend
//! (git-host-integration, "Hosted preparation job"). Three phases:
//!
//! 1. clone: a container with network and the installation token fetches the
//!    base and head commits, then revokes the token;
//! 2. analysis: a container on the `none` network, without the token, runs
//!    `rio prepare --output` over the clone, which is bind-mounted;
//! 3. upload: this trusted process uploads the prepared trees through the
//!    content-addressed protocol and submits with the single-use credential.
use anyhow::{Context, Result, bail, ensure};
use rio_adapters::{ProcessSupervisor, Termination, ToolCommand};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path, process::Stdio, time::Duration};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

use crate::{CleanupUnconfirmed, failure, load_tree};

/// The clone phase has its own bound inside the job's wall limit.
const CLONE_TIMEOUT: Duration = Duration::from_secs(300);

/// Secrets the endpoint hands out with a prepare claim; never written anywhere.
pub struct PrepareSecrets {
    pub github_token: String,
    pub credential: String,
}

fn sha(value: &Value) -> Result<&str> {
    let text = value.as_str().context("missing commit")?;
    ensure!(
        text.len() == 40 && text.bytes().all(|b| b.is_ascii_hexdigit()),
        "invalid commit"
    );
    Ok(text)
}

/// Common hardening for both containers; the network is chosen per phase.
fn hardened(name: &str, network: &str, work: &Path, image: &str) -> Vec<String> {
    [
        "run",
        "-i",
        "--name",
        name,
        "--network",
        network,
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "256",
        "--memory",
        "2048m",
        "--cpus",
        "2",
        "--user",
        "10001:10001",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=3g,mode=1777",
        "-v",
    ]
    .into_iter()
    .map(String::from)
    .chain([format!("{}:/work", work.display())])
    .chain([image.to_owned()])
    .collect()
}

async fn remove(name: &str, directory: &Path) -> Result<()> {
    let mut cleanup = ToolCommand::new("docker".into(), directory.into());
    cleanup.args = vec!["rm".into(), "--force".into(), name.into()];
    cleanup.timeout = Duration::from_secs(10);
    let removed = ProcessSupervisor::default()
        .run(cleanup, CancellationToken::new())
        .await;
    if removed.cleanup_confirmed
        && matches!(removed.termination, Termination::Exited { code: Some(0) })
    {
        Ok(())
    } else {
        Err(CleanupUnconfirmed.into())
    }
}

/// Runs one phase: the spec on standard input, JSON on standard output.
async fn phase(
    args: Vec<String>,
    env: &[(&str, &str)],
    input: &Value,
    timeout: Duration,
    name: &str,
    directory: &Path,
) -> Result<(bool, Value, String)> {
    let mut command = tokio::process::Command::new("docker");
    command
        .args(&args)
        .current_dir(directory)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Only these variables reach `docker run -e NAME`; their values never touch argv.
    for (key, value) in env {
        command.env(key, value);
    }
    let mut child = command.spawn()?;
    let mut stdin = child.stdin.take().context("missing Docker stdin")?;
    stdin.write_all(&serde_json::to_vec(input)?).await?;
    stdin.shutdown().await?;
    drop(stdin);
    let output = tokio::time::timeout(timeout, child.wait_with_output()).await;
    remove(name, directory).await?;
    let output = match output {
        Ok(output) => output?,
        Err(_) => return Ok((false, Value::Null, "timed out".into())),
    };
    let stderr = String::from_utf8_lossy(&output.stderr)
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .chars()
        .take(300)
        .collect::<String>();
    let value = serde_json::from_slice(&output.stdout).unwrap_or(Value::Null);
    Ok((output.status.success(), value, stderr))
}

/// Revokes the installation token from the host as well; the clone container
/// already did unless it failed first. Errors only mean it is already gone.
async fn revoke(client: &reqwest::Client, api: &str, token: &str) {
    let _ = client
        .delete(format!("{}/installation/token", api.trim_end_matches('/')))
        .bearer_auth(token)
        .header("accept", "application/vnd.github+json")
        .header("user-agent", "rio-runner")
        .timeout(Duration::from_secs(10))
        .send()
        .await;
}

pub async fn run(
    client: &reqwest::Client,
    endpoint: &reqwest::Url,
    job: &Value,
    secrets: PrepareSecrets,
    image: &str,
) -> Result<Value> {
    let spec = &job["prepare"];
    let (base, head) = (sha(&spec["base_sha"])?, sha(&spec["head_sha"])?);
    let clone_url = spec["clone_url"].as_str().context("missing clone URL")?;
    let id = job["job_id"].as_str().context("missing job id")?;
    let api =
        std::env::var("RIO_GITHUB_API_URL").unwrap_or_else(|_| "https://api.github.com".into());
    let temporary = tempfile::tempdir()?;
    let work = temporary.path().join("work");
    std::fs::create_dir(&work)?;
    // The containers run as uid 10001; the work directory is private to this job.
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&work, std::fs::Permissions::from_mode(0o777))?;
    }
    let wall = Duration::from_millis(job["limits"]["wall_ms"].as_u64().unwrap_or(600000));
    let started = std::time::Instant::now();
    // Phase 1: the only networked phase, and the only one with the token. An
    // operator may pick the Docker network (an egress-filtered one, a proxy's).
    let network = std::env::var("RIO_RUNNER_CLONE_NETWORK").unwrap_or_else(|_| "bridge".into());
    ensure!(
        !network.is_empty()
            && network != "host"
            && network != "none"
            && network
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b)),
        "invalid RIO_RUNNER_CLONE_NETWORK"
    );
    let mut clone = hardened(&format!("rio-{id}-clone"), &network, &work, image);
    clone.splice(
        clone.len() - 1..clone.len() - 1,
        ["-e", "RIO_GITHUB_TOKEN", "-e", "RIO_GITHUB_API_URL"].map(String::from),
    );
    let mut ca = None;
    if let Ok(path) = std::env::var("RIO_RUNNER_GIT_CA") {
        // A private CA (GitHub Enterprise) is mounted read-only for git.
        let pem = std::fs::read(&path).context("reading RIO_RUNNER_GIT_CA")?;
        let copy = temporary.path().join("ca.pem");
        std::fs::write(&copy, pem)?;
        clone.splice(
            clone.len() - 1..clone.len() - 1,
            [
                "-v".into(),
                format!("{}:/etc/rio/ca.pem:ro", copy.display()),
            ],
        );
        ca = Some(copy);
    }
    clone.extend(["/usr/bin/python3", "/opt/rio/execute.py", "clone"].map(String::from));
    let (ok, _, error) = phase(
        clone,
        &[
            ("RIO_GITHUB_TOKEN", secrets.github_token.as_str()),
            ("RIO_GITHUB_API_URL", api.as_str()),
        ],
        &json!({"clone_url": clone_url, "base_sha": base, "head_sha": head, "ca": ca.is_some()}),
        CLONE_TIMEOUT.min(wall),
        &format!("rio-{id}-clone"),
        temporary.path(),
    )
    .await?;
    revoke(client, &api, &secrets.github_token).await;
    drop(secrets.github_token);
    if !ok {
        return Ok(failure_exited(job, &format!("clone failed: {error}")));
    }
    // Phase 2: no network, no token; the clone is bind-mounted.
    let mut analysis = hardened(&format!("rio-{id}-analysis"), "none", &work, image);
    analysis.extend(["/usr/bin/python3", "/opt/rio/execute.py", "prepare"].map(String::from));
    let remaining = wall.saturating_sub(started.elapsed());
    let (ok, isolation, error) = phase(
        analysis,
        &[],
        &json!({"base_sha": base, "head_sha": head}),
        remaining,
        &format!("rio-{id}-analysis"),
        temporary.path(),
    )
    .await?;
    if !ok {
        return Ok(failure_exited(job, &format!("analysis failed: {error}")));
    }
    // Phase 3: upload and submit from this trusted process.
    let out = work.join("out");
    let links: BTreeMap<String, BTreeMap<String, String>> =
        serde_json::from_slice(&std::fs::read(out.join("links.json"))?)?;
    let base_tree = load_tree(
        &out.join("base"),
        links.get("base").unwrap_or(&BTreeMap::new()),
    )?;
    let head_tree = load_tree(
        &out.join("head"),
        links.get("head").unwrap_or(&BTreeMap::new()),
    )?;
    let mut submission: Value =
        serde_json::from_slice(&std::fs::read(out.join("submission.json"))?)?;
    let rio = rio_client::Client::new(endpoint.as_str(), secrets.credential)?;
    let upload = rio.upload_snapshot(&base_tree, &head_tree).await?;
    submission["snapshot_id"] = json!(upload.id);
    let review = match rio.submit(&submission).await {
        Ok(review) => review,
        Err(error) => bail!("submission rejected: {error:#}"),
    };
    Ok(
        json!({"outcome":"exited","job_id":job["job_id"],"attempt":job["attempt"],"version":job["version"],"exit_code":0,"stdout":review,"stderr":"","timed_out":false,"truncated":false,"artifact":{"isolation":isolation["isolation"].clone()}}),
    )
}

/// A phase that ran and failed: the job failed, the runner did not.
fn failure_exited(job: &Value, message: &str) -> Value {
    let mut result = failure(job, 1, &rio_core::redact(message), false);
    result["outcome"] = json!("exited");
    result
}

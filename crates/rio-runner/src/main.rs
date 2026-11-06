use anyhow::{Context, Result, ensure};
use clap::{Parser, Subcommand};
use hmac::{Hmac, Mac};
use rio_adapters::{ProcessSupervisor, Termination, ToolCommand};
use rio_client::{WireFile, decode_tree};
use rio_engine::{CacheOptions, ReviewRequest};
use rio_git::{ChangeSet, Selection};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::Sha256;
use std::{collections::BTreeMap, io::Read, path::PathBuf, time::Duration};
use tokio_util::sync::CancellationToken;
/// Maximum completion body accepted by the worker. Executor output is capped at 1 MiB
/// per stream, but JSON escaping (up to 6x) and the parsed artifact copy can expand it.
const COMPLETION_LIMIT: usize = 16 * 1024 * 1024;
#[derive(Parser)]
struct Args {
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    Serve {
        #[arg(long, env = "RIO_ENDPOINT_URL")]
        endpoint: String,
        #[arg(long, default_value = "rio-runner:0.2.0")]
        image: String,
        #[arg(long)]
        once: bool,
    },
    /// Container-only entry point; never invokes untrusted code on the host.
    Inside { kind: String, root: PathBuf },
}
#[derive(Deserialize)]
struct Snapshot {
    base: BTreeMap<String, WireFile>,
    head: BTreeMap<String, WireFile>,
}
#[derive(Deserialize)]
struct JobContext {
    profile: rio_profile::ResolvedProfile,
    snapshot: Snapshot,
}
#[tokio::main(worker_threads = 2)]
async fn main() -> Result<()> {
    match Args::parse().command {
        Command::Serve {
            endpoint,
            image,
            once,
        } => serve(endpoint, image, once).await,
        Command::Inside { kind, root } => inside(kind, root).await,
    }
}
async fn inside(kind: String, root: PathBuf) -> Result<()> {
    ensure!(
        std::env::var_os("RIO_CONTAINER").is_some(),
        "inside is available only in the runner container"
    );
    ensure!(
        kind == "checks" || kind == "graph" || kind == "static",
        "unknown analysis kind"
    );
    let mut input = String::new();
    std::io::stdin()
        .take(80 * 1024 * 1024)
        .read_to_string(&mut input)?;
    let value: Value = serde_json::from_str(&input)?;
    let context: JobContext = serde_json::from_value(value["context"].clone())?;
    let base = decode_tree(context.snapshot.base)?;
    let head = decode_tree(context.snapshot.head)?;
    let base_id = blake3::hash(&serde_json::to_vec(&base)?)
        .to_hex()
        .to_string();
    let head_id = blake3::hash(&serde_json::to_vec(&head)?)
        .to_hex()
        .to_string();
    if kind == "static" || kind == "graph" {
        let changes = ChangeSet {
            selection: Selection::WorkingTree,
            base_id,
            head_id,
            base,
            head,
        };
        let delta = rio_git::diff(&changes, &rio_engine::profile_excludes(&context.profile))?;
        let graphs = rio_graph::GraphBuilder::default().build(
            &changes,
            &delta,
            &rio_graph::GraphOptions::default(),
        )?;
        let mut report = rio_core::Report::empty(rio_core::ReportStatus::Complete);
        report.impact = graphs.impact(2);
        if kind == "graph" {
            println!("{}", json!({"report":report,"graphs":graphs}));
            return Ok(());
        }
        report.findings = rio_adapters::scan_secrets(&delta, &changes.head)?;
        let findings = report.findings.clone();
        report.checks.push(rio_core::CheckEntry {
            kind: rio_core::CheckKind::Secrets,
            language: "all".into(),
            root: ".".into(),
            version: rio_core::Version::Head,
            scheduled_as: rio_core::ScheduledAs::Changed,
            outcome: if findings.is_empty() {
                rio_core::CheckOutcome::Passed {
                    details: Default::default(),
                }
            } else {
                rio_core::CheckOutcome::Findings {
                    details: rio_core::CheckDetails {
                        findings,
                        ..Default::default()
                    },
                }
            },
            wall_time_ms: 0,
            cached: false,
        });
        for kind in [
            rio_core::CheckKind::Typecheck,
            rio_core::CheckKind::Lint,
            rio_core::CheckKind::Coverage,
            rio_core::CheckKind::Dependencies,
        ] {
            report.checks.push(rio_core::CheckEntry {
                kind,
                language: "all".into(),
                root: ".".into(),
                version: rio_core::Version::Head,
                scheduled_as: rio_core::ScheduledAs::Changed,
                outcome: rio_core::CheckOutcome::Skipped {
                    reason: rio_core::SkipReason::Disabled,
                    details: rio_core::CheckDetails {
                        hint: Some("Fork PR: execution-dependent checks disabled".into()),
                        ..Default::default()
                    },
                },
                wall_time_ms: 0,
                cached: false,
            });
        }
        report.footer.notes.push(
            "Fork PR: static-only parsing and secrets scan; repository commands were not executed."
                .into(),
        );
        println!("{}", json!({"report":report,"graphs":graphs}));
        return Ok(());
    }
    // Snapshots have no .git directory. The deterministic engine's ignored-installation
    // discovery needs repository metadata; create an empty trusted repository without
    // a checkout, hooks, remotes or repository-supplied Git configuration.
    gix::init(&root)?;
    let cache = CacheOptions::for_repository(&root);
    let cache_dir = cache.dir.clone();
    let report = rio_engine::review(
        ReviewRequest {
            worktree: root,
            working: head.clone(),
            changes: ChangeSet {
                selection: Selection::WorkingTree,
                base_id,
                head_id,
                base,
                head,
            },
            profile: context.profile,
            cache,
            parallelism: 2,
            output_limit: 1048576,
            offline: true,
        },
        ProcessSupervisor::default(),
        CancellationToken::new(),
        None,
    )
    .await?;
    let run = cache_dir
        .join(report.review.id.as_deref().context("missing review id")?)
        .join("runs")
        .join(report.review.run_id.as_deref().context("missing run id")?);
    let mut graphs = json!({});
    for version in ["base", "head"] {
        graphs[version] = serde_json::from_slice(&std::fs::read(
            run.join("graph").join(format!("{version}.json")),
        )?)?;
    }
    println!("{}", json!({"report":report,"graphs":graphs}));
    Ok(())
}
async fn serve(endpoint: String, image: String, once: bool) -> Result<()> {
    let secret = std::env::var("RIO_RUNNER_SECRET")
        .context("set RIO_RUNNER_SECRET in the runner environment")?;
    ensure!(
        secret.len() >= 32,
        "runner secret must contain at least 32 characters"
    );
    let mut base = reqwest::Url::parse(&endpoint)?;
    ensure!(
        base.scheme() == "https"
            || (base.scheme() == "http"
                && matches!(base.host_str(), Some("localhost" | "127.0.0.1"))),
        "runner endpoint requires TLS"
    );
    ensure!(
        base.username().is_empty()
            && base.password().is_none()
            && base.query().is_none()
            && base.fragment().is_none(),
        "invalid runner endpoint"
    );
    if !base.path().ends_with('/') {
        base.set_path(&format!("{}/", base.path()));
    }
    ensure!(
        !image.starts_with('-') && !image.contains(char::is_whitespace),
        "invalid Docker image"
    );
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    loop {
        // A single job or transient endpoint failure must not stop the daemon; only
        // unconfirmed container cleanup is fatal, because isolation is then unknown.
        match next_job(&client, &base, &secret, &image).await {
            Ok(Served::Idle) if !once => tokio::time::sleep(Duration::from_secs(2)).await,
            Ok(_) if once => return Ok(()),
            Ok(_) => {}
            Err(error) if once || error.is::<CleanupUnconfirmed>() => return Err(error),
            Err(error) => {
                eprintln!("rio-runner: {error:#}");
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        }
    }
}
enum Served {
    Idle,
    Job,
}
#[derive(Debug)]
struct CleanupUnconfirmed;
impl std::fmt::Display for CleanupUnconfirmed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Docker cleanup could not be confirmed")
    }
}
impl std::error::Error for CleanupUnconfirmed {}
async fn next_job(
    client: &reqwest::Client,
    base: &reqwest::Url,
    secret: &str,
    image: &str,
) -> Result<Served> {
    let response = client
        .post(base.join("v1/runner/claim")?)
        .bearer_auth(secret)
        .send()
        .await?;
    ensure!(
        response.status().is_success(),
        "runner claim returned HTTP {}",
        response.status()
    );
    let claim: Value = response.json().await?;
    if claim["job"].is_null() {
        return Ok(Served::Idle);
    }
    let job = &claim["job"];
    let token = claim["token"].as_str().context("missing job capability")?;
    let id = job["job_id"].as_str().context("missing job id")?;
    let review = job["review_id"].as_str().context("missing review id")?;
    ensure!(
        [id, review]
            .iter()
            .all(|id| id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')),
        "invalid job identity"
    );
    let attempt = job["attempt"].as_u64().context("missing attempt")?;
    let valid = job["network"] == false
        && job["limits"]["wall_ms"]
            .as_u64()
            .is_some_and(|n| n <= 120000);
    // Rejected and failed jobs are still completed so they are not left leased.
    let (result, fatal) = if valid {
        match run_docker(job, image).await {
            Ok(result) => (result, None),
            Err(error) => {
                let message = if error.is::<CleanupUnconfirmed>() {
                    "runner could not confirm container cleanup"
                } else {
                    "runner executor failed"
                };
                eprintln!("rio-runner: job {id}: {error:#}");
                (failure(job, 125, message, false), Some(error))
            }
        }
    } else {
        (failure(job, 125, "runner rejected job limits", false), None)
    };
    complete(client, base, token, review, id, attempt, &result).await?;
    match fatal {
        Some(error) if error.is::<CleanupUnconfirmed>() => Err(error),
        _ => Ok(Served::Job),
    }
}
/// Host-side failures are marked `runner_failed` so verification never treats their
/// nonzero exit codes as a reproduced failure.
fn failure(job: &Value, exit_code: i32, message: &str, timed_out: bool) -> Value {
    json!({"outcome":"runner_failed","job_id":job["job_id"],"attempt":job["attempt"],"version":job["version"],"exit_code":exit_code,"stdout":"","stderr":message,"timed_out":timed_out,"truncated":false})
}
async fn complete(
    client: &reqwest::Client,
    base: &reqwest::Url,
    token: &str,
    review: &str,
    id: &str,
    attempt: u64,
    result: &Value,
) -> Result<()> {
    let bytes = serde_json::to_vec(result)?;
    // The worker verifies these exact bytes; it never re-serializes before checking.
    let mut mac = Hmac::<Sha256>::new_from_slice(token.as_bytes())?;
    mac.update(&bytes);
    let signature: String = mac
        .finalize()
        .into_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let url = base.join(&format!("v1/runner/{review}/{id}/{attempt}/complete"))?;
    let response = client
        .post(url)
        .bearer_auth(token)
        .header("rio-signature", signature)
        .header("content-type", "application/json")
        .body(bytes)
        .send()
        .await?;
    ensure!(
        response.status().is_success(),
        "completion returned HTTP {}",
        response.status()
    );
    Ok(())
}
async fn run_docker(job: &Value, image: &str) -> Result<Value> {
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;
    let name = format!("rio-{}", job["job_id"].as_str().context("missing job id")?);
    let temporary = tempfile::tempdir()?;
    // Pipe payload to Docker, never interpolate command or repository content into a shell.
    let mut child = tokio::process::Command::new("docker")
        .args([
            "run",
            "-i",
            "--name",
            &name,
            "--network",
            "none",
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--pids-limit",
            "128",
            "--memory",
            "2048m",
            "--cpus",
            "2",
            "--user",
            "10001:10001",
            "--tmpfs",
            "/tmp:rw,nosuid,nodev,size=1g,mode=1777",
            image,
            "/usr/bin/python3",
            "/opt/rio/execute.py",
        ])
        .current_dir(temporary.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let mut input = child.stdin.take().context("missing Docker stdin")?;
    let bytes = serde_json::to_vec(job)?;
    let writer = tokio::spawn(async move {
        input.write_all(&bytes).await?;
        input.shutdown().await
    });
    let stdout = child.stdout.take().context("missing Docker stdout")?;
    let read = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut output = Vec::new();
        let mut stdout = stdout;
        (&mut stdout)
            .take(COMPLETION_LIMIT as u64 + 1)
            .read_to_end(&mut output)
            .await?;
        // Keep draining so an oversized executor cannot block on a full pipe.
        tokio::io::copy(&mut stdout, &mut tokio::io::sink()).await?;
        Ok::<_, std::io::Error>(output)
    });
    let timeout =
        Duration::from_millis(job["limits"]["wall_ms"].as_u64().unwrap_or(120000) + 15000);
    let status = tokio::time::timeout(timeout, child.wait()).await;
    // Removing the container also kills descendants when Docker's client is interrupted.
    let mut cleanup = ToolCommand::new("docker".into(), temporary.path().into());
    cleanup.args = vec!["rm".into(), "--force".into(), name.into()];
    cleanup.timeout = Duration::from_secs(10);
    let removed = ProcessSupervisor::default()
        .run(cleanup, CancellationToken::new())
        .await;
    if !(removed.cleanup_confirmed
        && matches!(removed.termination, Termination::Exited { code: Some(0) }))
    {
        return Err(CleanupUnconfirmed.into());
    }
    if status.is_err() {
        writer.abort();
        read.abort();
        return Ok(failure(job, 124, "runner wall deadline exceeded", true));
    }
    let _ = writer.await?;
    let output = read.await??;
    ensure!(status??.success(), "container executor failed");
    if output.len() > COMPLETION_LIMIT {
        let mut result = failure(job, 125, "runner result exceeded transport limit", false);
        result["truncated"] = json!(true);
        return Ok(result);
    }
    Ok(serde_json::from_slice(&output)?)
}

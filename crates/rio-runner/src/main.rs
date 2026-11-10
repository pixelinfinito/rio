use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use clap::{Parser, Subcommand};
use hmac::{Hmac, Mac};
use rio_adapters::{ProcessSupervisor, Termination, ToolCommand};
use rio_engine::{CacheOptions, ReviewRequest};
use rio_git::{ChangeSet, Selection, Tree, TreeEntry};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::Sha256;
use std::{
    collections::BTreeMap,
    io::Read,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio_util::sync::CancellationToken;
mod model;
mod prepare;
mod qa;
mod qa_sandbox;
/// Maximum completion body accepted by the worker. Executor output is capped at 1 MiB
/// per stream, but JSON escaping (up to 6x) and the parsed artifact copy can expand it.
const COMPLETION_LIMIT: usize = 16 * 1024 * 1024;
/// JSON bytes per graph version in the analysis artifact. The Worker accepts a
/// 12 MiB artifact and kills a job whose artifact grows past it; two-hop slices of
/// large repositories reach that through their edges, so the nearest nodes are kept.
const ARTIFACT_GRAPH_BYTES: usize = 4 * 1024 * 1024;
/// Maximum job header line, matching the container executor.
const HEADER_LIMIT: usize = 16 * 1024 * 1024;
/// Time allowed for a job archive (up to about 1 GiB) to reach the container before
/// the job's own wall clock starts.
const ARCHIVE_TIMEOUT: Duration = Duration::from_secs(600);
#[derive(Parser)]
struct Args {
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    /// Verify the QA image with a bundled browser interaction and no network egress.
    #[command(subcommand_negates_reqs = true)]
    Qa {
        #[command(subcommand)]
        command: Option<QaCommand>,
        #[arg(
            long,
            required_unless_present = "pod_self_test",
            conflicts_with = "pod_self_test"
        )]
        self_test: bool,
        /// Verify all three containers, host firewall rules and remote Chromium.
        #[arg(long)]
        pod_self_test: bool,
        #[arg(long, env = "RIO_QA_IMAGE", default_value = "rio-qa:0.1.0")]
        image: String,
    },
    Serve {
        #[arg(long, env = "RIO_ENDPOINT_URL")]
        endpoint: String,
        #[arg(long, default_value = "rio-runner:0.3.0")]
        image: String,
        #[arg(long)]
        once: bool,
        /// OpenAI-compatible endpoint (for example http://127.0.0.1:8080/v1) that
        /// serves self-hosted council members; advertised to the Worker on every
        /// claim. `RIO_MODEL_API_KEY` is sent as its bearer token when set.
        #[arg(long, env = "RIO_MODEL_ENDPOINT")]
        model_endpoint: Option<String>,
    },
    /// Container-only entry point; never invokes untrusted code on the host.
    Inside {
        kind: String,
        #[arg(long)]
        base: PathBuf,
        #[arg(long)]
        head: PathBuf,
    },
}
#[derive(Subcommand)]
enum QaCommand {
    #[command(hide = true)]
    Sandbox {
        #[arg(value_parser = ["plan", "finish"])]
        stage: String,
        #[arg(long, default_value = "/run/rio-sandbox")]
        directory: PathBuf,
    },
    /// Replay retained events in a fresh seeded pod, without a model or harness.
    Replay {
        /// Immutable tar snapshot with head/ or base/ paths, as in runner archives.
        #[arg(long)]
        archive: PathBuf,
        /// Sanitized qa-replay-v1 JSONL from the original chain and cell.
        #[arg(long)]
        events: PathBuf,
        /// Original evidence manifest with boundary content hashes.
        #[arg(long)]
        manifest: PathBuf,
        #[arg(long, value_parser = qa::parse_until)]
        until: String,
        #[arg(long, default_value = "head", value_parser = ["base", "head"])]
        version: String,
        #[arg(long)]
        cache_dir: PathBuf,
        #[arg(long, default_value_t = 300, value_parser = clap::value_parser!(u64).range(1..))]
        wall_seconds: u64,
    },
}
#[derive(Deserialize)]
struct JobContext {
    profile: rio_profile::ResolvedProfile,
}
#[derive(Deserialize)]
struct Limits {
    wall_ms: u64,
}
#[derive(Deserialize)]
struct Header {
    // Absent for prepare jobs, which resolve the profile at the base commit.
    context: Option<JobContext>,
    limits: Limits,
    #[serde(default)]
    prepare: Option<Value>,
    #[serde(default)]
    links: BTreeMap<String, BTreeMap<String, String>>,
}
#[tokio::main(worker_threads = 2)]
async fn main() -> Result<()> {
    match Args::parse().command {
        Command::Qa {
            command,
            self_test: _,
            pod_self_test,
            image,
        } => {
            if let Some(QaCommand::Sandbox { stage, directory }) = &command {
                return qa_sandbox::execute(stage, directory);
            }
            if let Some(QaCommand::Replay {
                archive,
                events,
                manifest,
                until,
                version,
                cache_dir,
                wall_seconds,
            }) = command
            {
                qa::replay(
                    archive,
                    events,
                    manifest,
                    until,
                    version,
                    cache_dir,
                    wall_seconds,
                    image,
                )
                .await
            } else if pod_self_test {
                qa::pod_self_test(image).await
            } else {
                qa::self_test(image).await
            }
        }
        Command::Serve {
            endpoint,
            image,
            once,
            model_endpoint,
        } => serve(endpoint, image, once, model_endpoint).await,
        Command::Inside { kind, base, head } => inside(kind, base, head).await,
    }
}
/// Reads an extracted archive tree; `links` (path to base64 target) restores the
/// symbolic links the archive never materializes.
fn load_tree(directory: &Path, links: &BTreeMap<String, String>) -> Result<Tree> {
    fn walk(root: &Path, directory: &Path, tree: &mut Tree) -> Result<()> {
        for entry in std::fs::read_dir(directory)? {
            let path = entry?.path();
            let name = path
                .strip_prefix(root)?
                .to_str()
                .context("archive path is not UTF-8")?
                .to_owned();
            rio_git::validate_tree_path(&name)?;
            let metadata = std::fs::symlink_metadata(&path)?;
            if metadata.is_dir() {
                walk(root, &path, tree)?;
                continue;
            }
            ensure!(metadata.is_file(), "unsupported archive entry {name}");
            let executable = {
                use std::os::unix::fs::PermissionsExt;
                metadata.permissions().mode() & 0o111 != 0
            };
            tree.insert(
                name,
                TreeEntry {
                    mode: if executable { 0o100755 } else { 0o100644 },
                    object_id: String::new(),
                    content: std::fs::read(&path)?,
                },
            );
        }
        Ok(())
    }
    let mut tree = Tree::new();
    walk(directory, directory, &mut tree)?;
    for (path, target) in links {
        rio_git::validate_tree_path(path)?;
        let entry = TreeEntry {
            mode: 0o120000,
            object_id: String::new(),
            content: STANDARD.decode(target)?,
        };
        ensure!(
            tree.insert(path.clone(), entry).is_none(),
            "symbolic link {path} duplicates an archive file"
        );
    }
    Ok(tree)
}
/// The impact graph must leave the rest of the job time to finish within its wall
/// limit, which also covers reading the archive and writing the result: 15 s, or a
/// quarter of a shorter limit.
fn graph_deadline(start: std::time::Instant, wall_ms: u64) -> std::time::Instant {
    start + Duration::from_millis(wall_ms - (wall_ms / 4).min(15000))
}
async fn inside(kind: String, base_dir: PathBuf, root: PathBuf) -> Result<()> {
    let start = std::time::Instant::now();
    ensure!(
        std::env::var_os("RIO_CONTAINER").is_some(),
        "inside is available only in the runner container"
    );
    ensure!(
        ["checks", "graph", "static", "prepare"].contains(&kind.as_str()),
        "unknown analysis kind"
    );
    let mut input = Vec::new();
    std::io::stdin()
        .take(HEADER_LIMIT as u64 + 1)
        .read_to_end(&mut input)?;
    ensure!(input.len() <= HEADER_LIMIT, "job header exceeds limit");
    let mut header: Header = serde_json::from_slice(&input)?;
    ensure!(
        header.links.keys().all(|v| v == "base" || v == "head"),
        "unknown link version"
    );
    // Both trees are read before the head directory gains any repository metadata.
    let base = load_tree(&base_dir, &header.links.remove("base").unwrap_or_default())?;
    let head = load_tree(&root, &header.links.remove("head").unwrap_or_default())?;
    if kind == "prepare" {
        // Sandbox preparation: the Worker fetched both commits; nothing here has network.
        let spec = header
            .prepare
            .context("prepare job without its pull request")?;
        let commit = |key: &str| -> Result<String> {
            let value = spec[key].as_str().context("missing commit")?;
            ensure!(
                value.len() == 40 && value.bytes().all(|b| b.is_ascii_hexdigit()),
                "invalid commit"
            );
            Ok(value.to_owned())
        };
        let changes = ChangeSet {
            selection: Selection::Branch {
                reference: commit("base_sha")?,
            },
            base_id: commit("base_sha")?,
            head_id: commit("head_sha")?,
            base,
            head,
        };
        let profile = rio_engine::base_profile(&changes.base)?;
        let snapshot = rio_git::Snapshot::from_changes(&changes);
        let deadline = graph_deadline(start, header.limits.wall_ms);
        let prepared = rio_engine::build_submission(
            &changes,
            &profile,
            &rio_engine::SubmissionOptions {
                graph_budget: deadline.saturating_duration_since(std::time::Instant::now()),
                deep: false,
                fork: false,
                nightly: false,
                repository: None,
                run_id: format!("prepare-{}", &snapshot.key[..16]),
            },
        )?
        .context("the pull request changes nothing reviewable")?;
        println!("{}", json!({"submission": prepared.submission}));
        return Ok(());
    }
    let context = header.context.context("analysis job without its profile")?;
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
        let deadline = graph_deadline(start, header.limits.wall_ms);
        let graphs = rio_graph::GraphBuilder::default().build_until(
            &changes,
            &delta,
            &rio_graph::GraphOptions::default(),
            &|| std::time::Instant::now() >= deadline,
        )?;
        let mut report = rio_core::Report::empty(rio_core::ReportStatus::Complete);
        report.impact = graphs.impact(2);
        if let Some(note) = graphs.truncation_note(
            false,
            std::time::Instant::now() >= deadline,
            "the job deadline",
        ) {
            report.footer.notes.push(note);
        }
        if kind == "graph" {
            println!("{}", artifact(&mut report, serde_json::to_value(&graphs)?)?);
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
        println!("{}", artifact(&mut report, serde_json::to_value(&graphs)?)?);
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
    let mut report = report;
    println!("{}", artifact(&mut report, graphs)?);
    Ok(())
}
/// The analysis artifact: the report and both graphs, each graph bounded to
/// `ARTIFACT_GRAPH_BYTES` with a report note when anything was dropped.
fn artifact(report: &mut rio_core::Report, mut graphs: Value) -> Result<Value> {
    let mut bounded = false;
    for version in ["base", "head"] {
        let mut slice: rio_graph::GraphSlice = serde_json::from_value(graphs[version].take())?;
        bounded |= slice.bound(ARTIFACT_GRAPH_BYTES);
        graphs[version] = serde_json::to_value(&slice)?;
    }
    if bounded {
        report.footer.notes.push(format!(
            "Runner impact graph bounded to {} MiB per version",
            ARTIFACT_GRAPH_BYTES / (1024 * 1024)
        ));
    }
    Ok(json!({"report": report, "graphs": graphs}))
}
async fn serve(
    endpoint: String,
    image: String,
    once: bool,
    model_endpoint: Option<String>,
) -> Result<()> {
    let model_endpoint = model_endpoint.as_deref().map(model::endpoint).transpose()?;
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
        match next_job(&client, &base, &secret, &image, model_endpoint.as_ref()).await {
            Ok(Served::Stopped) => return Ok(()),
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
    Stopped,
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
#[derive(Debug)]
struct ArchiveUnavailable;
impl std::fmt::Display for ArchiveUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("job archive could not be transferred")
    }
}
async fn next_job(
    client: &reqwest::Client,
    base: &reqwest::Url,
    secret: &str,
    image: &str,
    model_endpoint: Option<&reqwest::Url>,
) -> Result<Served> {
    let response = client
        .post(base.join("v1/runner/claim")?)
        .bearer_auth(secret)
        .json(&json!({"capabilities": {"model_endpoint": model_endpoint.is_some()}}))
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
    if job["kind"] == "prepare" && job["network"] == "clone" {
        return serve_prepare(client, base, &claim, token, review, id, attempt, image).await;
    }
    if job["kind"] == "qa" {
        return qa::serve(client, base, &claim).await;
    }
    if job["kind"] == "model" {
        let result = model::serve(model_endpoint, job).await;
        complete(client, base, token, review, id, attempt, &result).await?;
        return Ok(Served::Job);
    }
    // Trees arrive only as the job archive; an embedded snapshot is an older protocol.
    let valid = job["network"] == false
        && job["limits"]["wall_ms"]
            .as_u64()
            .is_some_and(|n| n <= 120000)
        && job["snapshot_id"].is_string()
        && job.get("snapshot").is_none()
        && job["context"].get("snapshot").is_none();
    // Rejected and failed jobs are still completed so they are not left leased.
    let (result, fatal) = if valid {
        let archive = base.join(&format!("v1/runner/{review}/{id}/{attempt}/archive"))?;
        match run_docker(client, archive, token, job, image).await {
            Ok(result) => (result, None),
            Err(error) => {
                let message = if error.is::<CleanupUnconfirmed>() {
                    "runner could not confirm container cleanup"
                } else if error.is::<ArchiveUnavailable>() {
                    "runner could not download the job archive"
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
/// A self-hosted prepare job: its secrets arrive with the claim and live in memory only.
#[allow(clippy::too_many_arguments)]
async fn serve_prepare(
    client: &reqwest::Client,
    base: &reqwest::Url,
    claim: &Value,
    token: &str,
    review: &str,
    id: &str,
    attempt: u64,
    image: &str,
) -> Result<Served> {
    let job = &claim["job"];
    let secrets = match (
        claim["prepare"]["github_token"].as_str(),
        claim["prepare"]["credential"].as_str(),
    ) {
        (Some(github_token), Some(credential)) => Some(prepare::PrepareSecrets {
            github_token: github_token.to_owned(),
            credential: credential.to_owned(),
        }),
        _ => None,
    };
    let valid = job["limits"]["wall_ms"]
        .as_u64()
        .is_some_and(|n| n <= PREPARE_WALL_MS)
        && job["prepare"].is_object()
        && job["context"].is_null();
    let (result, fatal) = match secrets {
        Some(secrets) if valid => match prepare::run(client, base, job, secrets, image).await {
            Ok(result) => (result, None),
            Err(error) => {
                eprintln!("rio-runner: prepare job {id}: {error:#}");
                let message = if error.is::<CleanupUnconfirmed>() {
                    "runner could not confirm container cleanup".to_owned()
                } else {
                    rio_core::redact(&format!("runner prepare failed: {error:#}"))
                        .chars()
                        .take(300)
                        .collect()
                };
                (failure(job, 125, &message, false), Some(error))
            }
        },
        _ => (
            failure(job, 125, "runner rejected prepare job", false),
            None,
        ),
    };
    complete(client, base, token, review, id, attempt, &result).await?;
    match fatal {
        Some(error) if error.is::<CleanupUnconfirmed>() => Err(error),
        _ => Ok(Served::Job),
    }
}
/// Wall limit of a prepare job (clone, snapshot, graph and upload).
const PREPARE_WALL_MS: u64 = 600000;
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
/// Requests the job's executor input (header line, then tar archive) and checks that the
/// header describes the claimed job. Returns the bytes read so far and the open response;
/// the archive itself is streamed later and never buffered.
async fn open_archive(
    client: &reqwest::Client,
    url: reqwest::Url,
    token: &str,
    job: &Value,
) -> Result<(Vec<u8>, reqwest::Response)> {
    let mut response = client
        .get(url)
        .bearer_auth(token)
        .timeout(ARCHIVE_TIMEOUT)
        .send()
        .await?;
    ensure!(
        response.status().is_success(),
        "job archive returned HTTP {}",
        response.status()
    );
    let mut prefix = Vec::new();
    let end = loop {
        if let Some(end) = prefix.iter().position(|&b| b == b'\n') {
            break end;
        }
        ensure!(prefix.len() <= HEADER_LIMIT, "job header exceeds limit");
        let chunk = response
            .chunk()
            .await?
            .context("job archive ended before its header")?;
        prefix.extend_from_slice(&chunk);
    };
    let header: Value = serde_json::from_slice(&prefix[..end])?;
    for key in [
        "review_id",
        "job_id",
        "attempt",
        "kind",
        "version",
        "limits",
        "network",
    ] {
        ensure!(
            header[key] == job[key],
            "job archive header differs in {key}"
        );
    }
    Ok((prefix, response))
}
async fn run_docker(
    client: &reqwest::Client,
    archive: reqwest::Url,
    token: &str,
    job: &Value,
    image: &str,
) -> Result<Value> {
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;
    // No container is started unless the archive is available and matches the claim.
    let (prefix, mut response) = open_archive(client, archive, token, job)
        .await
        .context(ArchiveUnavailable)?;
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
            "/tmp:rw,nosuid,nodev,size=3g,mode=1777",
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
    // Stream the archive straight into Docker; it can approach 1 GiB.
    let mut writer = tokio::spawn(async move {
        input.write_all(&prefix).await?;
        while let Some(chunk) = response.chunk().await.context(ArchiveUnavailable)? {
            input.write_all(&chunk).await?;
        }
        input.shutdown().await?;
        Ok::<_, anyhow::Error>(())
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
    // The executor's wall clock starts once the archive is extracted, so the transfer has
    // its own deadline. A container that exits early ends the transfer with a write error.
    let transfer = tokio::time::timeout(ARCHIVE_TIMEOUT, &mut writer).await;
    let timeout =
        Duration::from_millis(job["limits"]["wall_ms"].as_u64().unwrap_or(120000) + 15000);
    let status = if transfer.is_ok() {
        tokio::time::timeout(timeout, child.wait()).await
    } else {
        writer.abort();
        let _ = child.start_kill();
        Ok(child.wait().await)
    };
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
        read.abort();
        return Ok(failure(job, 124, "runner wall deadline exceeded", true));
    }
    // A write error alone means the container stopped reading; its exit status decides.
    match transfer {
        Err(_) => {
            return Err(anyhow::anyhow!("archive transfer timed out").context(ArchiveUnavailable));
        }
        Ok(written) => match written? {
            Err(error) if error.is::<ArchiveUnavailable>() => return Err(error),
            _ => {}
        },
    }
    let output = read.await??;
    ensure!(status??.success(), "container executor failed");
    if output.len() > COMPLETION_LIMIT {
        let mut result = failure(job, 125, "runner result exceeded transport limit", false);
        result["truncated"] = json!(true);
        return Ok(result);
    }
    Ok(serde_json::from_slice(&output)?)
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    #[test]
    fn qa_replay_cli_requires_retained_inputs_and_a_valid_target() {
        let args = [
            "rio-runner",
            "qa",
            "replay",
            "--archive",
            "snapshot.tar",
            "--events",
            "replay.jsonl",
            "--manifest",
            "manifest.json",
            "--cache-dir",
            "cache",
            "--until",
            "checkout:4",
        ];
        assert!(matches!(
            Args::try_parse_from(args).unwrap().command,
            Command::Qa {
                command: Some(QaCommand::Replay { .. }),
                ..
            }
        ));
        for target in ["checkout", "checkout:0", "../checkout:1", "checkout:1:2"] {
            let mut invalid = args;
            invalid[args.len() - 1] = target;
            assert!(Args::try_parse_from(invalid).is_err(), "{target}");
        }
        assert!(Args::try_parse_from(["rio-runner", "qa"]).is_err());
        assert!(Args::try_parse_from(["rio-runner", "qa", "--self-test"]).is_ok());
    }
    #[test]
    fn artifact_graphs_are_bounded_to_the_artifact_budget_with_a_report_note() {
        let node = |id: &str, hop: usize, seed: bool| {
            json!({"id": id, "kind": "function", "path": "src/a.rs", "symbol_path": id, "name": id,
                   "line_start": 1, "line_end": 2, "version": "head", "seed": seed, "hop": hop,
                   "content_hash": "0".repeat(64)})
        };
        let edge = |from: &str, to: &str| {
            json!({"from": from, "to": to, "kind": "calls", "source": "tree-sitter",
                   "confidence": "resolved", "version": "head"})
        };
        let mut nodes = vec![node("seed", 0, true)];
        let mut edges = Vec::new();
        for i in 0..40_000 {
            let id = format!("n{i:05}");
            nodes.push(node(&id, 2, false));
            edges.push(edge(&id, "seed"));
        }
        let big = json!({"nodes": nodes, "edges": edges, "truncated": false});
        let small = json!({"nodes": [node("seed", 0, true)], "edges": [], "truncated": false});
        let mut report = rio_core::Report::empty(rio_core::ReportStatus::Complete);
        let out = artifact(&mut report, json!({"base": small, "head": big})).unwrap();
        let head = serde_json::to_vec(&out["graphs"]["head"]).unwrap().len();
        assert!(head <= ARTIFACT_GRAPH_BYTES, "{head}");
        assert_eq!(out["graphs"]["head"]["truncated"], true);
        assert_eq!(out["graphs"]["head"]["nodes"][0]["id"], "seed");
        assert_eq!(out["graphs"]["base"]["truncated"], false);
        assert!(
            report
                .footer
                .notes
                .iter()
                .any(|n| n == "Runner impact graph bounded to 4 MiB per version")
        );
        let mut untouched = rio_core::Report::empty(rio_core::ReportStatus::Complete);
        artifact(&mut untouched, json!({"base": small, "head": small})).unwrap();
        assert!(untouched.footer.notes.is_empty());
    }
    #[test]
    fn graph_deadline_leaves_a_margin_of_the_job_wall_limit() {
        let start = std::time::Instant::now();
        assert_eq!(
            graph_deadline(start, 120000),
            start + Duration::from_secs(105)
        );
        // A short wall limit keeps a quarter of it for the rest of the job.
        assert_eq!(
            graph_deadline(start, 10000),
            start + Duration::from_millis(7500)
        );
        // The header carries the job's limits next to its other fields.
        let limits: Limits =
            serde_json::from_value(json!({"wall_ms": 60000, "memory_mb": 2048})).unwrap();
        assert_eq!(limits.wall_ms, 60000);
    }
    #[test]
    fn load_tree_reads_files_modes_and_links() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        std::fs::create_dir_all(root.join("src/ünï")).unwrap();
        std::fs::write(root.join("src/ünï/a.rs"), b"fn a() {}\n").unwrap();
        std::fs::write(root.join("run.sh"), b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(root.join("run.sh"), std::fs::Permissions::from_mode(0o755))
            .unwrap();
        std::fs::write(root.join("owner-exec"), [0, 159, 255]).unwrap();
        std::fs::set_permissions(
            root.join("owner-exec"),
            std::fs::Permissions::from_mode(0o744),
        )
        .unwrap();
        let links = BTreeMap::from([("src/link".to_string(), STANDARD.encode("../run.sh"))]);
        let tree = load_tree(root, &links).unwrap();
        let summary: Vec<_> = tree
            .iter()
            .map(|(path, entry)| (path.as_str(), entry.mode, entry.content.as_slice()))
            .collect();
        assert_eq!(
            summary,
            [
                ("owner-exec", 0o100755, &[0, 159, 255][..]),
                ("run.sh", 0o100755, b"#!/bin/sh\n"),
                ("src/link", 0o120000, b"../run.sh"),
                ("src/ünï/a.rs", 0o100644, b"fn a() {}\n"),
            ]
        );
        assert!(load_tree(&root.join("missing"), &BTreeMap::new()).is_err());
    }
    #[test]
    fn load_tree_rejects_unsafe_links_and_disk_entries() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        std::fs::write(root.join("a"), b"a").unwrap();
        for (path, target) in [
            ("a", "Yg=="),
            ("../escape", "Yg=="),
            ("/abs", "Yg=="),
            ("b", "not base64!"),
        ] {
            let links = BTreeMap::from([(path.to_string(), target.to_string())]);
            assert!(load_tree(root, &links).is_err(), "{path}");
        }
        std::os::unix::fs::symlink("/etc/passwd", root.join("link")).unwrap();
        assert!(load_tree(root, &BTreeMap::new()).is_err());
    }
}

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
/// Maximum completion body accepted by the worker. Executor output is capped at 1 MiB
/// per stream, but JSON escaping (up to 6x) and the parsed artifact copy can expand it.
const COMPLETION_LIMIT: usize = 16 * 1024 * 1024;
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
    Serve {
        #[arg(long, env = "RIO_ENDPOINT_URL")]
        endpoint: String,
        #[arg(long, default_value = "rio-runner:0.2.0")]
        image: String,
        #[arg(long)]
        once: bool,
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
#[derive(Deserialize)]
struct JobContext {
    profile: rio_profile::ResolvedProfile,
}
#[derive(Deserialize)]
struct Header {
    context: JobContext,
    #[serde(default)]
    links: BTreeMap<String, BTreeMap<String, String>>,
}
#[tokio::main(worker_threads = 2)]
async fn main() -> Result<()> {
    match Args::parse().command {
        Command::Serve {
            endpoint,
            image,
            once,
        } => serve(endpoint, image, once).await,
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
async fn inside(kind: String, base_dir: PathBuf, root: PathBuf) -> Result<()> {
    ensure!(
        std::env::var_os("RIO_CONTAINER").is_some(),
        "inside is available only in the runner container"
    );
    ensure!(
        kind == "checks" || kind == "graph" || kind == "static",
        "unknown analysis kind"
    );
    let mut input = Vec::new();
    std::io::stdin()
        .take(HEADER_LIMIT as u64 + 1)
        .read_to_end(&mut input)?;
    ensure!(input.len() <= HEADER_LIMIT, "job header exceeds limit");
    let mut header: Header = serde_json::from_slice(&input)?;
    let context = header.context;
    ensure!(
        header.links.keys().all(|v| v == "base" || v == "head"),
        "unknown link version"
    );
    // Both trees are read before the head directory gains any repository metadata.
    let base = load_tree(&base_dir, &header.links.remove("base").unwrap_or_default())?;
    let head = load_tree(&root, &header.links.remove("head").unwrap_or_default())?;
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

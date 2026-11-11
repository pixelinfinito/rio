use anyhow::{Context, Result, ensure};
use rio_adapters::{ProcessSupervisor, Termination, ToolCommand};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

/// Exercise the same host-side pod backend that will dispatch QA jobs. A second
/// cleanup process runs even if cancellation killed the first process group.
pub async fn pod_self_test(image: String) -> Result<()> {
    let directory = tempfile::tempdir()?;
    std::fs::write(
        directory.path().join("pod.py"),
        include_str!("../../../worker/qa/pod.py"),
    )?;
    std::fs::write(
        directory.path().join("test_pod.py"),
        include_str!("../../../worker/qa/test_pod.py"),
    )?;
    let run_id =
        blake3::hash(directory.path().to_string_lossy().as_bytes()).to_hex()[..16].to_string();
    let cancellation = CancellationToken::new();
    let signal = cancellation.clone();
    let interrupt = tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            signal.cancel();
        }
    });
    let mut request = ToolCommand::new("python3".into(), directory.path().into());
    request.args = vec!["test_pod.py".into(), "-v".into()];
    request.env.insert("RIO_QA_IMAGE".into(), image.into());
    request.env.insert("RIO_TEST_QA_DOCKER".into(), "1".into());
    request
        .env
        .insert("RIO_QA_TEST_RUN_ID".into(), run_id.clone().into());
    request.timeout = Duration::from_secs(180);
    request.output_limit = 1024 * 1024;
    let supervisor = ProcessSupervisor::default();
    let result = supervisor.run(request, cancellation).await;
    let mut cleanup = ToolCommand::new("python3".into(), directory.path().into());
    cleanup.args = vec!["pod.py".into(), "--cleanup".into(), run_id.into()];
    cleanup.timeout = Duration::from_secs(90);
    cleanup.output_limit = 1024 * 1024;
    let removed = supervisor.run(cleanup, CancellationToken::new()).await;
    interrupt.abort();
    ensure!(
        matches!(removed.termination, Termination::Exited { code: Some(0) }),
        "QA pod cleanup could not be confirmed; check Docker and host firewall access"
    );
    ensure!(
        matches!(result.termination, Termination::Exited { code: Some(0) }),
        "QA pod self-test failed or was interrupted: {}",
        String::from_utf8_lossy(&result.raw_stderr)
    );
    println!(
        "{}",
        serde_json::json!({"status":"passed", "containers":3,"egress":"host_firewall_pinned","remote_browser":true,"cleanup":"confirmed"})
    );
    Ok(())
}

/// Smoke-test the provisioned image without repository code, model credentials
/// or external network access. Container deletion is awaited on every exit path.
pub async fn self_test(image: String) -> Result<()> {
    ensure!(
        !image.is_empty() && !image.starts_with('-') && !image.chars().any(char::is_whitespace),
        "invalid QA image name"
    );
    let temporary = tempfile::tempdir()?;
    let name = format!(
        "rio-qa-self-test-{}",
        temporary
            .path()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .replace('.', "")
    );
    let cancellation = CancellationToken::new();
    let signal = cancellation.clone();
    let interrupt = tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            signal.cancel();
        }
    });
    let supervisor = ProcessSupervisor::default();
    let mut create = ToolCommand::new("docker".into(), temporary.path().into());
    create.args = [
        "create",
        "--name",
        &name,
        "--network",
        "none",
        "--init",
        "--user",
        "1000:1000",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "256",
        "--memory",
        "2g",
        "--shm-size",
        "256m",
        &image,
        "node",
        "/opt/rio-qa/src/self-test.mjs",
    ]
    .map(std::ffi::OsString::from)
    .into();
    create.output_limit = 1024 * 1024;
    create.timeout = Duration::from_secs(30);
    let created = supervisor.run(create, cancellation.clone()).await;
    let result = async {
        ensure!(matches!(created.termination, Termination::Exited { code: Some(0) }), "QA image is unavailable; build it with docker build -f worker/Dockerfile.qa -t {image} .");
        let mut start = ToolCommand::new("docker".into(), temporary.path().into());
        start.args = vec!["start".into(), "--attach".into(), name.clone().into()];
        start.output_limit = 1024 * 1024;
        start.timeout = Duration::from_secs(90);
        let output = supervisor.run(start, cancellation.clone()).await;
        ensure!(matches!(output.termination, Termination::Exited { code: Some(0) }), "QA self-test failed or was interrupted");
        let value: serde_json::Value = serde_json::from_slice(&output.stdout).context("invalid QA self-test result")?;
        ensure!(value["status"] == "passed" && value["steps"] == 1 && value["uid"].as_u64().is_some_and(|uid| uid != 0), "QA self-test did not pass as an unprivileged user");
        println!("{value}");
        Ok(())
    }.await;
    let mut remove = ToolCommand::new("docker".into(), temporary.path().into());
    remove.args = vec!["rm".into(), "--force".into(), name.into()];
    remove.output_limit = 1024 * 1024;
    remove.timeout = Duration::from_secs(15);
    let removed = supervisor.run(remove, CancellationToken::new()).await;
    interrupt.abort();
    if matches!(created.termination, Termination::Exited { code: Some(0) }) {
        ensure!(
            matches!(removed.termination, Termination::Exited { code: Some(0) }),
            "QA self-test container cleanup could not be confirmed"
        );
    }
    result
}

/// QA uses a heartbeat lease throughout download, image preparation and pod
/// execution. A failed renewal fences local work instead of running on a stale
/// capability; cancellation still retains the controller's last checkpoint.
pub async fn serve(
    client: &reqwest::Client,
    base: &reqwest::Url,
    claim: &serde_json::Value,
) -> Result<super::Served> {
    use serde_json::json;
    let job = &claim["job"];
    let token = claim["token"]
        .as_str()
        .context("missing QA job capability")?;
    let review = job["review_id"].as_str().context("missing review")?;
    let id = job["job_id"].as_str().context("missing job")?;
    let attempt = job["attempt"].as_u64().context("missing attempt")?;
    let cancellation = CancellationToken::new();
    let done = CancellationToken::new();
    let interrupted = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let heartbeat_url = base.join(&format!("v1/runner/{review}/{id}/{attempt}/heartbeat"))?;
    let heartbeat = tokio::spawn({
        let client = client.clone();
        let token = token.to_owned();
        let cancellation = cancellation.clone();
        let done = done.clone();
        let interrupted = interrupted.clone();
        async move {
            loop {
                let renewal = client
                    .post(heartbeat_url.clone())
                    .bearer_auth(&token)
                    .timeout(Duration::from_secs(30))
                    .send()
                    .await;
                let active = match renewal {
                    Ok(response) if response.status().is_success() => response
                        .json::<serde_json::Value>()
                        .await
                        .is_ok_and(|value| value["cancelled"] == false),
                    _ => false,
                };
                if !active {
                    cancellation.cancel();
                    return;
                }
                tokio::select! {
                    _ = done.cancelled() => return,
                    _ = tokio::signal::ctrl_c() => { interrupted.store(true, std::sync::atomic::Ordering::SeqCst); cancellation.cancel(); return; },
                    _ = tokio::time::sleep(Duration::from_secs(60)) => {}
                }
            }
        }
    });
    let result = run_job(client, base, claim, cancellation.clone()).await;
    done.cancel();
    heartbeat.abort();
    let (result, cleanup_failed) = match result {
        Ok(artifact) => (
            json!({"outcome":"exited","kind":"qa","job_id":id,"attempt":attempt,
            "version":job["version"],"exit_code":0,"stdout":"","stderr":"", "timed_out":false,
            "truncated":false,"artifact":artifact}),
            false,
        ),
        Err(error) => {
            // Raw build output, credentials and archive data never enter logs.
            let cleanup = error.is::<rio_qa::QaCleanupUnconfirmed>();
            (
                super::failure(
                    job,
                    125,
                    if cleanup {
                        "QA cleanup could not be confirmed"
                    } else {
                        "QA runtime failed"
                    },
                    false,
                ),
                cleanup,
            )
        }
    };
    let completion = super::complete(client, base, token, review, id, attempt, &result).await;
    if cleanup_failed {
        return Err(super::CleanupUnconfirmed.into());
    }
    completion?;
    Ok(if interrupted.load(std::sync::atomic::Ordering::SeqCst) {
        super::Served::Stopped
    } else {
        super::Served::Job
    })
}

async fn run_job(
    client: &reqwest::Client,
    base: &reqwest::Url,
    claim: &serde_json::Value,
    cancellation: CancellationToken,
) -> Result<serde_json::Value> {
    use serde_json::{Value, json};
    use std::collections::{BTreeMap, BTreeSet};
    use tokio::io::AsyncWriteExt;
    let job = &claim["job"];
    let qa = &job["qa"];
    let token = claim["token"].as_str().context("missing QA capability")?;
    let version = job["version"]
        .as_str()
        .context("missing QA snapshot version")?;
    let wall_ms = job["limits"]["wall_ms"]
        .as_u64()
        .filter(|value| *value > 0)
        .context("invalid QA wall budget")?;
    let started = std::time::Instant::now();
    ensure!(
        job["network"] == "qa"
            && ["base", "head"].contains(&version)
            && qa["harness_auth"] == "gateway"
            && ["codex", "pi"].contains(&qa["harness"].as_str().unwrap_or(""))
            && qa["budget"]["wall_ms"]
                .as_u64()
                .is_some_and(|value| value > 0 && value <= wall_ms)
            && claim["qa"]["run_id"] == qa["run_id"]
            && claim["qa"]["capability"].is_string()
            && claim["qa"]["tenant"].is_string()
            && job.get("snapshot").is_none()
            && job["context"].get("snapshot").is_none(),
        "runner rejected QA job"
    );
    let remaining = || Duration::from_millis(wall_ms).saturating_sub(started.elapsed());
    let url = base.join(&format!(
        "v1/runner/{}/{}/{}/archive",
        job["review_id"].as_str().unwrap(),
        job["job_id"].as_str().unwrap(),
        job["attempt"]
    ))?;
    let download = async {
        let (prefix, mut response) = super::open_archive(client, url, token, job).await?;
        let split = prefix
            .iter()
            .position(|&byte| byte == b'\n')
            .context("missing archive header")?;
        let header: Value = serde_json::from_slice(&prefix[..split])?;
        ensure!(header["qa"] == *qa, "QA archive differs from claimed job");
        let archive = tempfile::tempfile()?;
        let mut output = tokio::fs::File::from_std(archive.try_clone()?);
        output.write_all(&prefix[split + 1..]).await?;
        let mut bytes = (prefix.len() - split - 1) as u64;
        while let Some(chunk) = response.chunk().await? {
            bytes += chunk.len() as u64;
            ensure!(bytes <= 1152 * 1024 * 1024, "QA archive too large");
            output.write_all(&chunk).await?;
        }
        output.flush().await?;
        drop(output);
        use std::io::{Seek, SeekFrom};
        let mut archive = archive;
        archive.seek(SeekFrom::Start(0))?;
        rio_qa::read_runtime_archive(archive)
    };
    let mut trees = tokio::select! {
        _ = cancellation.cancelled() => anyhow::bail!("QA cancelled"),
        value = tokio::time::timeout(remaining(), download) => value??,
    };
    let snapshot = trees.remove(version).context("QA snapshot is missing")?;
    let other = trees
        .remove(if version == "head" { "base" } else { "head" })
        .unwrap_or_default();
    let options = &qa["options"];
    let mut project = rio_qa::runtime_project(&snapshot.files, options)?;
    let changed: BTreeSet<String> = qa["changed"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|file| {
            [file["path"].as_str(), file["old_path"].as_str()]
                .into_iter()
                .flatten()
        })
        .map(str::to_owned)
        .collect();
    let graph = rio_qa::selection_graph(&qa["graphs"], &changed);
    let input = rio_qa::SelectionInput {
        full: options["mode"] == "full",
        explicit: options["journeys"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        changed,
        graph,
        max_journeys: options["max_journeys"].as_u64().unwrap_or(12) as usize,
        cell_wall_seconds: qa["budget"]["cell_wall_ms"]
            .as_u64()
            .context("missing QA cell budget")?
            / 1000,
    };
    let (base_snapshot, head_snapshot) = if version == "head" {
        (&other.files, &snapshot.files)
    } else {
        (&snapshot.files, &other.files)
    };
    let mut planning = rio_qa::runtime_project(head_snapshot, options)?;
    let mut plan = planning.plan(base_snapshot, head_snapshot, &input)?;
    planning.add_exploration(&mut plan, &input)?;
    rio_qa::restrict_to_cell(&mut plan, &planning, options, input.cell_wall_seconds)?;
    if plan.cell_count == 0 {
        let mut result = rio_qa::empty_runtime_result(&plan, qa["harness"].as_str().unwrap());
        rio_qa::annotate_runtime_result(
            &mut result,
            &planning,
            &snapshot.files,
            &plan,
            &input.changed,
        )?;
        return Ok(result);
    }
    project.journeys = planning.journeys.clone();
    project.viewports = planning.viewports.clone();
    for persona in &planning.config.personas {
        if !project
            .config
            .personas
            .iter()
            .any(|existing| existing.name == persona.name)
        {
            project.config.personas.push(persona.clone());
        }
    }
    let image = std::env::var("RIO_QA_IMAGE").unwrap_or_else(|_| "rio-qa:0.1.0".into());
    ensure!(
        !remaining().is_zero() && !cancellation.is_cancelled(),
        "QA budget exhausted"
    );
    let mut runtime =
        rio_qa::DockerQaRuntime::new(&snapshot, &project.config, &image, remaining())?;
    let digest = runtime.prepare_image(cancellation.clone()).await?;
    ensure!(
        !remaining().is_zero() && !cancellation.is_cancelled(),
        "QA budget exhausted"
    );
    let mut budget = qa["budget"].clone();
    budget["wall_ms"] = json!(remaining().as_millis() as u64);
    let endpoint = base.as_str().trim_end_matches('/');
    let run = json!({"version":1,"snapshot_version":version,"review_id":job["review_id"],"run_id":qa["run_id"],"replay":qa.get("replay"),
        "harness":qa["harness"],"auth":"gateway","model":qa["model"],"budget":budget,"prompt":qa.get("prompt"),
        "storage":{"kind":"hosted","endpoint":endpoint,"tenant":claim["qa"]["tenant"],"capability":claim["qa"]["capability"]},
        "gateway":{"url":format!("{endpoint}/v1/qa/model"),"capability":claim["qa"]["capability"]}});
    // The operator supplies a separate QA-only credential map. Never expose the
    // runner's environment (which may contain provider or runner credentials).
    let credentials: BTreeMap<String, String> = match std::env::var_os("RIO_QA_CREDENTIALS_FILE") {
        Some(path) => {
            ensure!(
                std::fs::metadata(&path)?.len() <= 1024 * 1024,
                "QA credential file too large"
            );
            serde_json::from_slice(&std::fs::read(path)?)?
        }
        None => BTreeMap::new(),
    };
    runtime.set_transport(&[endpoint.to_owned()], None, None)?;
    let configuration =
        runtime.assets(&project, &snapshot.files, &plan, run, &digest, &credentials)?;
    if let Some(expected) = qa["replay"].get("seed_fingerprint") {
        ensure!(
            *expected == configuration["seed_fingerprints"][0],
            "replay seed identity changed"
        );
    }
    let configure = base.join(&format!(
        "v1/runner/{}/{}/{}/qa-configure",
        job["review_id"].as_str().unwrap(),
        job["job_id"].as_str().unwrap(),
        job["attempt"]
    ))?;
    let response = client
        .post(configure)
        .bearer_auth(token)
        .json(&configuration)
        .send()
        .await?;
    ensure!(response.status().is_success(), "QA configuration rejected");
    let mut result = runtime.execute(cancellation).await?;
    if qa.get("replay").is_none() {
        rio_qa::annotate_runtime_result(
            &mut result,
            &project,
            &snapshot.files,
            &plan,
            &input.changed,
        )?;
    }
    result["harness"] = qa["harness"].clone();
    result["plan"] = serde_json::to_value(plan)?;
    result["seed_fingerprint"] = configuration["seed_fingerprints"][0].clone();
    result["harness_auth"] = json!("gateway");
    Ok(result)
}

pub fn parse_until(value: &str) -> std::result::Result<String, String> {
    let Some((journey, step)) = value.split_once(':') else {
        return Err("expected journey:step".into());
    };
    if journey.is_empty()
        || !journey.starts_with(|c: char| c.is_ascii_lowercase())
        || !journey
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        || !step.parse::<u32>().is_ok_and(|step| step > 0)
    {
        return Err("expected a journey name and a positive step, e.g. checkout:4".into());
    }
    Ok(value.into())
}

/// This offline replay path never needs a provider/subscription credential.
/// Only the named persona credentials are passed into the fresh pod.
#[allow(clippy::too_many_arguments)]
pub async fn replay(
    archive: std::path::PathBuf,
    events: std::path::PathBuf,
    manifest: std::path::PathBuf,
    until: String,
    version: String,
    cache_dir: std::path::PathBuf,
    wall_seconds: u64,
    image: String,
) -> Result<()> {
    use serde_json::{Value, json};
    use std::collections::BTreeMap;
    let read = |path: &std::path::Path, max| -> Result<Vec<u8>> {
        let file = std::fs::File::open(path)?;
        ensure!(
            file.metadata()?.is_file() && file.metadata()?.len() <= max,
            "replay input exceeds limit"
        );
        use std::io::Read;
        let mut bytes = Vec::new();
        file.take(max + 1).read_to_end(&mut bytes)?;
        ensure!(bytes.len() as u64 <= max, "replay input exceeds limit");
        Ok(bytes)
    };
    parse_until(&until).map_err(anyhow::Error::msg)?;
    let (journey, step) = until.split_once(':').unwrap();
    let events: Vec<Value> = std::str::from_utf8(&read(&events, 8 * 1024 * 1024)?)?
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(serde_json::from_str)
        .collect::<std::result::Result<_, _>>()?;
    ensure!(!events.is_empty(), "replay log is empty");
    let manifest: Value = serde_json::from_slice(&read(&manifest, 8 * 1024 * 1024)?)?;
    ensure!(
        manifest["version"] == 1 && manifest["artifacts"].is_array(),
        "invalid evidence manifest"
    );
    let snapshot = rio_qa::read_runtime_archive(std::fs::File::open(archive)?)?
        .remove(&version)
        .context("replay snapshot is missing")?;
    let project = rio_qa::runtime_project(&snapshot.files, &json!({}))?;
    let input = rio_qa::SelectionInput {
        explicit: vec![journey.into()],
        max_journeys: usize::MAX,
        ..Default::default()
    };
    let mut plan = project.plan(&snapshot.files, &snapshot.files, &input)?;
    let cell: rio_qa::Cell = serde_json::from_value(events[0]["cell"].clone())?;
    ensure!(
        plan.cells.contains(&cell),
        "replay cell is outside the committed matrix"
    );
    plan.cells = vec![cell];
    plan.cell_count = plan.chains.iter().map(|chain| chain.journeys.len()).sum();
    let wall = Duration::from_secs(wall_seconds);
    let started = std::time::Instant::now();
    let cancellation = CancellationToken::new();
    let signal = cancellation.clone();
    let interrupt = tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            signal.cancel();
        }
    });
    let result = async {
        let mut runtime = rio_qa::DockerQaRuntime::new(&snapshot, &project.config, &image, wall)?;
        let digest = runtime.prepare_image(cancellation.clone()).await?;
        let remaining = wall.saturating_sub(started.elapsed());
        ensure!(!remaining.is_zero(), "replay budget exhausted during preparation");
        std::fs::create_dir_all(&cache_dir)?;
        runtime.set_local_cache(&std::fs::canonicalize(cache_dir)?, rio_qa::seed_size_limit(&project.config.seed.max_size)?)?;
        runtime.set_transport(&[], None, None)?;
        let credentials: BTreeMap<String, String> = match std::env::var_os("RIO_QA_CREDENTIALS_FILE") {
            Some(path) => serde_json::from_slice(&read(std::path::Path::new(&path), 1024 * 1024)?)?,
            None => BTreeMap::new(),
        };
        let run = json!({"version":1,"snapshot_version":version,"review_id":"replay","run_id":runtime.pod_id,
            "harness":"codex","auth":"gateway","model":"unused-replay",
            "budget":{"wall_ms":remaining.as_millis() as u64,"cell_wall_ms":remaining.as_millis() as u64,"tokens":1,"evidence_bytes":512 * 1024 * 1024},
            "storage":{"kind":"local"},"replay":{"events":events,"artifacts":manifest["artifacts"],"until":{"journey":journey,"step":step.parse::<u32>()?}}});
        runtime.assets(&project, &snapshot.files, &plan, run, &digest, &credentials)?;
        let mut result = runtime.execute(cancellation).await?;
        result["seed_fingerprint"] = serde_json::to_value(rio_qa::SeedFingerprint::build(&project, &snapshot.files, &digest)?)?;
        println!("{}", serde_json::to_string_pretty(&result)?);
        Ok(())
    }.await;
    interrupt.abort();
    result
}

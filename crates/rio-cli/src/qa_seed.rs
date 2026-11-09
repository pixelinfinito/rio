//! Seed commands use the isolated app runtime without starting a model session.
use anyhow::{Result, ensure};
use rio_qa::*;
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path, time::Instant};
use tokio_util::sync::CancellationToken;

pub async fn run(
    root: &Path,
    snapshot: RuntimeSnapshot,
    force: bool,
    export: Option<&Path>,
) -> Result<Value> {
    let project = QaProject::load(&snapshot.files)?;
    let config = crate::config::MachineConfig::load(root)?;
    let limits = rio_profile::QaBudget::defaults(false);
    let wall = rio_profile::parse_duration(&limits.wall).map_err(anyhow::Error::msg)?;
    let started = Instant::now();
    let image = std::env::var("RIO_QA_IMAGE").unwrap_or_else(|_| "rio-qa:0.1.0".into());
    ensure!(
        !image.is_empty() && !image.starts_with('-') && !image.chars().any(char::is_whitespace),
        "Invalid QA image name"
    );
    let mut runtime = DockerQaRuntime::new(&snapshot, &project.config, &image, wall)?;
    let cancellation = CancellationToken::new();
    let cancelled = cancellation.clone();
    let signal = tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            cancelled.cancel();
        }
    });
    let result = async {
        let digest = runtime.prepare_image(cancellation.clone()).await?;
        let fingerprint = SeedFingerprint::build(&project, &snapshot.files, &digest)?;
        let max_size = seed_size_limit(&project.config.seed.max_size)?;
        let cache = config.cache.dir.join("qa-seeds");
        if let Some(destination) = export {
            let files = export_seed_cache(&cache, &fingerprint, max_size, destination)?;
            return Ok(json!({"fingerprint":fingerprint.fingerprint,"storage":"local","exported":files,"destination":destination}));
        }
        ensure!(!cancellation.is_cancelled() && started.elapsed() < wall, "Seed build interrupted before startup");
        let mut plan = project.plan(&QaSnapshot::new(), &snapshot.files, &SelectionInput { full: true, ..Default::default() })?;
        plan.chains.clear(); plan.selected.clear(); plan.cell_count = 0;
        runtime.set_transport(&[], None, None)?;
        std::fs::create_dir_all(&config.cache.dir)?;
        runtime.set_local_cache(&std::fs::canonicalize(&config.cache.dir)?, max_size)?;
        let credentials: BTreeMap<_, _> = project.config.personas.iter()
            .flat_map(|persona| [persona.username_env.as_ref(), persona.password_env.as_ref()].into_iter().flatten())
            .filter_map(|name| std::env::var(name).ok().map(|value| (name.clone(), value))).collect();
        let run_id = format!("seed-{}", runtime.pod_id);
        let run = json!({"version":1,"snapshot_version":"head","review_id":run_id,"run_id":run_id,
            "harness":"codex","auth":"gateway","storage":{"kind":"local"},"seed_build":true,"seed_force":force,
            "budget":{"wall_ms":wall.saturating_sub(started.elapsed()).as_millis() as u64,"cell_wall_ms":1,
                "tokens":1,"evidence_bytes":limits.evidence_bytes}});
        runtime.assets(&project, &snapshot.files, &plan, run, &digest, &credentials)?;
        let result = runtime.execute(cancellation.clone()).await?;
        ensure!(result["outcome"] == "complete" && !cancellation.is_cancelled(),
            "Seed build did not complete ({}); diagnostic evidence remains in the QA cache", result["runtime_reason"].as_str().or(result["controller_error"].as_str()).unwrap_or("startup failed"));
        let status = seed_cache_status(&cache, &fingerprint, max_size)?;
        ensure!(status["next"] == "restore", "Seed build finished without a published snapshot");
        Ok(json!({"seed":result["seed"],"cache":status,"review_id":run_id}))
    }.await;
    signal.abort();
    result
}

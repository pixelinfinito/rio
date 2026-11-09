//! Local QA uses only captured trees and host-owned credential configuration.
use crate::{ReviewRequest, RunCache};
use anyhow::{Context, Result, ensure};
use rio_adapters::{ProcessSupervisor, Termination, ToolCommand};
use rio_core::{DeferredReason, DeferredStep, Report, ReportStatus};
use rio_qa::*;
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

fn snapshot(tree: &rio_git::Tree) -> RuntimeSnapshot {
    RuntimeSnapshot {
        files: tree
            .iter()
            .filter(|(_, entry)| matches!(entry.mode, 0o100644 | 0o100755))
            .map(|(path, entry)| (path.clone(), entry.content.clone()))
            .collect(),
        modes: tree
            .iter()
            .filter(|(_, entry)| matches!(entry.mode, 0o100644 | 0o100755))
            .map(|(path, entry)| (path.clone(), entry.mode & 0o777))
            .collect(),
    }
}

pub(crate) async fn execute(
    request: &ReviewRequest,
    diff: &rio_git::Diff,
    step: &rio_profile::Step,
    cache: &RunCache,
    report: &mut Report,
    cancellation: CancellationToken,
    deadline: Instant,
) -> Result<bool> {
    if request.offline {
        report.deferred.push(DeferredStep {
            step: step.id.clone(),
            reason: DeferredReason::NoEndpoint,
        });
        report.footer.notes.push("QA requires model access; run without --offline to use subscription or the host keychain relay.".into());
        return Ok(false);
    }
    let mut docker = ToolCommand::new("docker".into(), request.worktree.clone());
    docker.args = vec![
        "info".into(),
        "--format".into(),
        "{{.ServerVersion}}".into(),
    ];
    docker.timeout = Duration::from_secs(5).min(deadline.saturating_duration_since(Instant::now()));
    docker.output_limit = 1024;
    if !matches!(
        ProcessSupervisor::default()
            .run(docker, cancellation.clone())
            .await
            .termination,
        Termination::Exited { code: Some(0) }
    ) {
        report.deferred.push(DeferredStep {
            step: step.id.clone(),
            reason: DeferredReason::NoRuntime,
        });
        report
            .footer
            .notes
            .push("QA needs a reachable Docker daemon. Start Docker and run rio doctor.".into());
        return Ok(false);
    }
    let image = std::env::var("RIO_QA_IMAGE").unwrap_or_else(|_| "rio-qa:0.1.0".into());
    ensure!(
        !image.starts_with('-') && !image.chars().any(char::is_whitespace),
        "Invalid QA image name"
    );
    let mut inspect = ToolCommand::new("docker".into(), request.worktree.clone());
    inspect.args = vec![
        "image".into(),
        "inspect".into(),
        "--format".into(),
        "{{.Id}}".into(),
        image.clone().into(),
    ];
    inspect.timeout =
        Duration::from_secs(5).min(deadline.saturating_duration_since(Instant::now()));
    inspect.output_limit = 1024;
    if !matches!(
        ProcessSupervisor::default()
            .run(inspect, cancellation.clone())
            .await
            .termination,
        Termination::Exited { code: Some(0) }
    ) {
        report.deferred.push(DeferredStep {
            step: step.id.clone(),
            reason: DeferredReason::NoRuntime,
        });
        report.footer.notes.push("QA needs its paired runner image. Build it with docker build -f worker/Dockerfile.qa -t rio-qa:0.1.0 . and run rio doctor.".into());
        return Ok(false);
    }
    let started = Instant::now();
    let defaults = rio_profile::QaBudget::defaults(false);
    let limits = request
        .profile
        .profile
        .budget
        .fast
        .qa
        .as_ref()
        .unwrap_or(&defaults);
    let duration = |value: &str| rio_profile::parse_duration(value).map_err(anyhow::Error::msg);
    let wall = duration(&limits.wall)?.min(deadline.saturating_duration_since(started));
    let remaining = || wall.saturating_sub(started.elapsed());
    let head = snapshot(&request.changes.head);
    let base = snapshot(&request.changes.base);
    let mut project = runtime_project(&head.files, &step.options)?;
    let changed: BTreeSet<_> = diff
        .files
        .iter()
        .filter(|file| file.excluded.is_none())
        .flat_map(|file| [Some(file.path.clone()), file.old_path.clone()])
        .flatten()
        .collect();
    let mut graphs = json!({});
    for version in ["base", "head"] {
        let path = cache.path.join("graph").join(format!("{version}.json"));
        if let Ok(bytes) = std::fs::read(path) {
            graphs[version] = serde_json::from_slice(&bytes)?;
        }
    }
    let graph = selection_graph(&graphs, &changed);
    let selection = SelectionInput {
        full: step.options["mode"] == "full",
        explicit: step.options["journeys"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        changed,
        graph,
        max_journeys: step.options["max_journeys"].as_u64().unwrap_or(12) as usize,
        cell_wall_seconds: duration(&limits.cell_wall)?.as_secs(),
    };
    let mut plan = project.plan(&base.files, &head.files, &selection)?;
    project.add_exploration(&mut plan, &selection)?;
    cache.write("qa/plan.json", &serde_json::to_vec_pretty(&plan)?)?;
    let harness = step.options["harness"]
        .as_str()
        .unwrap_or(&project.config.harness.default);
    if plan.cell_count == 0 {
        let mut result = empty_runtime_result(&plan, harness);
        annotate_runtime_result(
            &mut result,
            &project,
            &head.files,
            &plan,
            &selection.changed,
        )?;
        for (file, record) in runtime_records(&result) {
            cache.write(&format!("qa/{file}"), &serde_json::to_vec_pretty(&record)?)?;
        }
        report.qa = Some(local_qa_report(&result, &step.options)?);
        report
            .footer
            .notes
            .push("QA selected no journeys; no app or model was started.".into());
        return Ok(false);
    }
    let subscription = std::env::var_os("CODEX_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| std::path::PathBuf::from(home).join(".codex"))
        })
        .map(|home| home.join("auth.json"));
    let auth = resolve_authentication(
        &project.config.harness.auth,
        harness,
        QaBackend::Docker,
        false,
        subscription.as_deref(),
    )?;
    cache.write("qa/authentication.json", &serde_json::to_vec_pretty(&auth)?)?;
    // Host-selected route metadata names a keychain entry; no provider secret
    // is accepted from repository config, arguments, or container environment.
    let route = if auth.harness_auth == "gateway" {
        let path = std::env::var_os("RIO_QA_MODEL_ROUTE").context("Local QA gateway needs RIO_QA_MODEL_ROUTE naming a host model route JSON file with keychain metadata")?;
        ensure!(
            std::fs::metadata(&path)?.len() <= 1024 * 1024,
            "QA model route is too large"
        );
        Some(serde_json::from_slice::<LocalModelRoute>(&std::fs::read(
            path,
        )?)?)
    } else {
        None
    };
    let model = route
        .as_ref()
        .map(|route| route.model.clone())
        .or_else(|| project.config.harness.model.clone())
        .unwrap_or_else(|| "gpt-5.4".into());
    let mut runtime = DockerQaRuntime::new(&head, &project.config, &image, remaining())?;
    let digest = runtime.prepare_image(cancellation.clone()).await?;
    ensure!(
        !remaining().is_zero() && !cancellation.is_cancelled(),
        "QA budget exhausted before browser startup"
    );
    let relay = if let Some(route) = route {
        // Each controller cell enforces its own cap. The host also limits total
        // spending to the number of selected cells, including one retry each.
        let versions = if step.options["baseline"] == true {
            2
        } else {
            1
        };
        let tokens = limits
            .tokens
            .checked_mul((plan.cell_count.max(1) as u64).saturating_mul(versions))
            .context("QA token budget overflow")?;
        Some(LocalModelRelay::start(route, &cache.run_id, tokens).await?)
    } else {
        None
    };
    let socket = relay.as_ref().map(LocalModelRelay::socket_path);
    runtime.set_transport(&[], socket.as_deref(), auth.subscription_file.as_deref())?;
    cache.reference("qa-seeds")?;
    runtime.set_local_cache(
        &std::fs::canonicalize(&cache.options.dir)?,
        seed_size_limit(&project.config.seed.max_size)?,
    )?;
    let credentials = project
        .config
        .personas
        .iter()
        .flat_map(|persona| {
            [persona.username_env.as_ref(), persona.password_env.as_ref()]
                .into_iter()
                .flatten()
        })
        .filter_map(|name| std::env::var(name).ok().map(|value| (name.clone(), value)))
        .collect();
    let run = json!({"version":1,"snapshot_version":"head","review_id":cache.review_id,"run_id":cache.run_id,
        "harness":harness,"auth":auth.harness_auth,"model":model,"storage":{"kind":"local"},
        "relay_token":relay.as_ref().map(LocalModelRelay::capability),
        "budget":{"wall_ms":remaining().as_millis() as u64,"cell_wall_ms":duration(&limits.cell_wall)?.as_millis() as u64,
            "tokens":limits.tokens,"evidence_bytes":limits.evidence_bytes}});
    runtime.assets(&project, &head.files, &plan, run, &digest, &credentials)?;
    let result = runtime.execute(cancellation.clone()).await;
    let mut result = result?;
    annotate_runtime_result(
        &mut result,
        &project,
        &head.files,
        &plan,
        &selection.changed,
    )?;
    if step.options["baseline"] == true {
        let baseline = async {
            ensure!(!remaining().is_zero() && !cancellation.is_cancelled(), "QA baseline budget exhausted");
            let mut base_project = runtime_project(&base.files, &step.options)?;
            // Use the same selected journey definitions and matrix on both
            // snapshots; only application, seed and fixture inputs change.
            base_project.journeys = project.journeys.clone();
            base_project.viewports = project.viewports.clone();
            for persona in &project.config.personas {
                if !base_project.config.personas.iter().any(|existing| existing.name == persona.name) {
                    base_project.config.personas.push(persona.clone());
                }
            }
            let mut baseline = DockerQaRuntime::new(&base, &base_project.config, &image, remaining())?;
            let base_image = baseline.prepare_image(cancellation.clone()).await?;
            ensure!(!remaining().is_zero(), "QA baseline budget exhausted");
            baseline.set_transport(&[], socket.as_deref(), auth.subscription_file.as_deref())?;
            baseline.set_local_cache(&std::fs::canonicalize(&cache.options.dir)?, seed_size_limit(&base_project.config.seed.max_size)?)?;
            let run = json!({"version":1,"snapshot_version":"base","review_id":cache.review_id,"run_id":format!("{}-base",cache.run_id),"record_run_id":cache.run_id,
                "harness":harness,"auth":auth.harness_auth,"model":model,"storage":{"kind":"local"},
                "relay_token":relay.as_ref().map(LocalModelRelay::capability),
                "budget":{"wall_ms":remaining().as_millis() as u64,"cell_wall_ms":duration(&limits.cell_wall)?.as_millis() as u64,
                    "tokens":limits.tokens,"evidence_bytes":limits.evidence_bytes.saturating_sub(result["evidence"]["bytes"].as_u64().unwrap_or(0)).max(1)}});
            baseline.assets(&base_project, &base.files, &plan, run, &base_image, &credentials)?;
            let mut base_result = baseline.execute(cancellation.clone()).await?;
            annotate_runtime_result(&mut base_result, &base_project, &base.files, &plan, &selection.changed)?;
            Ok::<_, anyhow::Error>(base_result)
        }.await;
        let baseline = match baseline {
            Ok(value) => value,
            Err(error) if error.is::<QaCleanupUnconfirmed>() => return Err(error),
            Err(_) => {
                json!({"outcome":"partial","reason":"baseline_unavailable","findings":[],"journey_outcomes":[]})
            }
        };
        cache.write("qa/baseline.json", &serde_json::to_vec_pretty(&baseline)?)?;
        compare_runtime_results(&mut result, &baseline, &selection.changed)?;
    }
    if let Some(relay) = relay {
        let usage = relay.close().await?;
        cache.write("qa/model-usage.json", &serde_json::to_vec_pretty(&usage)?)?;
    }
    result["harness"] = json!(harness);
    result["harness_auth"] = json!(auth.harness_auth);
    result["wall_time_ms"] = json!(started.elapsed().as_millis() as u64);
    for (file, record) in runtime_records(&result) {
        cache.write(&format!("qa/{file}"), &serde_json::to_vec_pretty(&record)?)?;
    }
    cache.write("qa/result.json", &serde_json::to_vec_pretty(&result)?)?;
    // Endpoint verification is deliberately deferred locally. Unverified
    // observations remain visible, but deferral alone is not a runtime failure.
    let incomplete = result["outcome"] != "complete";
    if incomplete {
        report.status = ReportStatus::Partial;
    }
    report
        .findings
        .extend(serde_json::from_value::<Vec<rio_core::Finding>>(
            result["findings"].clone(),
        )?);
    report.qa = Some(local_qa_report(&result, &step.options)?);
    report
        .footer
        .notes
        .push("QA UX observations and recommendations await endpoint verification.".into());
    Ok(incomplete)
}

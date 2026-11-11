//! Host-owned Docker orchestration. No application command executes on the host.
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Read,
    path::Path,
    sync::Mutex,
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use rio_adapters::{ProcessSupervisor, Termination, ToolCommand};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::{QaPlan, QaProject, QaSnapshot, SeedFingerprint, journey_guidance, seed_size_limit};

/// Same canonical BLAKE3 identity checked by the Worker and used by the controller.
pub fn qa_cell_id(chain: &[String], cell: &crate::Cell, version: &str) -> String {
    blake3::hash(
        serde_json::to_string(&json!({"chain":chain,"color_scheme":cell.color_scheme,
        "version":version,"viewport":cell.viewport}))
        .unwrap()
        .as_bytes(),
    )
    .to_hex()
    .to_string()
}

/// One journey in one cell of the matrix (viewport × color scheme).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct QaCellRef {
    pub journey: String,
    pub viewport: String,
    pub color_scheme: String,
}

/// The host's live requests to a running QA run: a paused queue finishes the
/// running cell and starts no other until resumed; a cancelled cell stops (or
/// never starts) and is recorded `cancelled` with reason `user`.
#[derive(Debug, Default)]
pub struct QaControl {
    state: Mutex<(bool, BTreeSet<QaCellRef>)>,
    detached: std::sync::atomic::AtomicBool,
}

impl QaControl {
    /// The run went elsewhere (an endpoint), where these requests cannot reach.
    pub fn detach(&self) {
        self.detached
            .store(true, std::sync::atomic::Ordering::Relaxed);
    }

    pub fn detached(&self) -> bool {
        self.detached.load(std::sync::atomic::Ordering::Relaxed)
    }

    pub fn set_paused(&self, paused: bool) {
        self.state.lock().unwrap().0 = paused;
    }

    pub fn paused(&self) -> bool {
        self.state.lock().unwrap().0
    }

    pub fn cancel(&self, cell: QaCellRef) {
        self.state.lock().unwrap().1.insert(cell);
    }

    /// The controller's `qa-control.json`.
    fn document(&self) -> Vec<u8> {
        let state = self.state.lock().unwrap();
        serde_json::to_vec(&json!({"paused": state.0, "cancel": state.1})).unwrap()
    }
}

/// A cell started, reached a step or ended (`running`, `passed`, `failed`,
/// `skipped`, `cancelled` or `not_run`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct QaProgress {
    pub seq: u64,
    pub journey: String,
    pub viewport: String,
    pub color_scheme: String,
    pub step: u32,
    pub outcome: String,
}

/// JSON sent to JavaScript omits optional values, matching the source schemas.
/// In particular `null` must not override browser defaults or fixture options.
pub fn omit_nulls(value: &mut Value) {
    match value {
        Value::Object(map) => {
            map.retain(|_, value| !value.is_null());
            map.values_mut().for_each(omit_nulls);
        }
        Value::Array(values) => values.iter_mut().for_each(omit_nulls),
        _ => {}
    }
}

#[derive(Default)]
pub struct RuntimeSnapshot {
    pub files: QaSnapshot,
    pub modes: BTreeMap<String, u32>,
}

fn safe_path(path: &str) -> bool {
    !path.is_empty()
        && !path.contains(['\\', '\0', ':'])
        && path.split('/').all(|part| {
            !part.is_empty() && part != "." && part != ".." && !part.eq_ignore_ascii_case(".git")
        })
}

/// Decode the runner archive without extracting any source onto the host.
pub fn read_runtime_archive(reader: impl Read) -> Result<BTreeMap<String, RuntimeSnapshot>> {
    let mut trees: BTreeMap<String, RuntimeSnapshot> = BTreeMap::new();
    let mut total = 0_u64;
    for entry in tar::Archive::new(reader).entries()? {
        let mut entry = entry?;
        let path = entry
            .path()?
            .to_str()
            .context("snapshot path is not UTF-8")?
            .to_owned();
        let (version, path) = path.split_once('/').context("snapshot version missing")?;
        let mode = entry.header().mode()?;
        ensure!(
            ["base", "head"].contains(&version)
                && safe_path(path)
                && entry.header().entry_type().is_file()
                && [0o644, 0o755].contains(&mode)
                && entry.size() <= 64 * 1024 * 1024,
            "invalid QA snapshot member"
        );
        total = total
            .checked_add(entry.size())
            .context("snapshot too large")?;
        ensure!(total <= 1024 * 1024 * 1024, "snapshot too large");
        let tree = trees.entry(version.into()).or_default();
        ensure!(
            !tree.files.contains_key(path)
                && !tree
                    .files
                    .keys()
                    .any(|name| name.starts_with(&format!("{path}/"))
                        || path.starts_with(&format!("{name}/"))),
            "conflicting snapshot paths"
        );
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes)?;
        tree.files.insert(path.into(), bytes);
        tree.modes.insert(path.into(), mode);
    }
    Ok(trees)
}

#[derive(Debug, thiserror::Error)]
#[error("QA pod cleanup could not be confirmed")]
pub struct QaCleanupUnconfirmed;

/// Private inputs and partial results outlive the supervised child, allowing an
/// independent cleanup process to retain checkpoints after interruption.
pub struct DockerQaRuntime {
    directory: tempfile::TempDir,
    pub pod_id: String,
    wall: Duration,
    configuration: Value,
}

impl DockerQaRuntime {
    pub fn new(
        snapshot: &RuntimeSnapshot,
        contract: &crate::QaConfig,
        qa_image: &str,
        wall: Duration,
    ) -> Result<Self> {
        let directory = tempfile::tempdir()?;
        let root = directory.path();
        let pod_id = blake3::hash(root.to_string_lossy().as_bytes()).to_hex()[..16].to_string();
        for (name, source) in [
            ("pod.py", include_str!("../../../worker/qa/pod.py")),
            ("runtime.py", include_str!("../../../worker/qa/runtime.py")),
            (
                "entrypoint.py",
                include_str!("../../../worker/qa/entrypoint.py"),
            ),
        ] {
            std::fs::write(root.join(name), source)?;
        }
        std::fs::create_dir(root.join("hooks"))?;
        macro_rules! hook {
            ($name:literal) => {
                std::fs::write(
                    root.join("hooks").join($name),
                    include_bytes!(concat!("../controller/src/", $name)),
                )?;
            };
        }
        hook!("app-entrypoint.mjs");
        hook!("app-runtime.mjs");
        hook!("seed-runtime.mjs");
        hook!("seed-transfer.mjs");
        hook!("datastores.mjs");
        hook!("seed-archive.py");
        hook!("context.mjs");
        hook!("static-server.mjs");
        hook!("fixture-services.mjs");
        hook!("fixture-providers.mjs");
        hook!("fixture-files.mjs");
        hook!("tcp-relay.mjs");
        let mut archive = tar::Builder::new(std::fs::File::create(root.join("snapshot.tar"))?);
        for (path, bytes) in &snapshot.files {
            ensure!(safe_path(path), "invalid QA snapshot path");
            let mut header = tar::Header::new_gnu();
            header.set_size(bytes.len() as u64);
            header.set_mode(*snapshot.modes.get(path).unwrap_or(&0o644));
            header.set_cksum();
            archive.append_data(&mut header, path, bytes.as_slice())?;
        }
        archive.finish()?;
        let mut configuration = json!({"pod_id":pod_id,"parent_pid":std::process::id(),"contract":contract,"qa_image":qa_image,"wall_ms":wall.as_millis() as u64});
        omit_nulls(&mut configuration);
        std::fs::write(
            root.join("runtime.json"),
            serde_json::to_vec(&configuration)?,
        )?;
        Ok(Self {
            directory,
            pod_id,
            wall,
            configuration,
        })
    }

    pub fn path(&self) -> &Path {
        self.directory.path()
    }

    async fn stage(&self, stage: &str, timeout: Duration, cancel: CancellationToken) -> Result<()> {
        let mut command = ToolCommand::new("python3".into(), self.path().into());
        command.args = vec!["runtime.py".into(), stage.into()];
        command.timeout = timeout;
        command.output_limit = 64 * 1024;
        let result = ProcessSupervisor::default().run(command, cancel).await;
        ensure!(
            matches!(result.termination, Termination::Exited { code: Some(0) }),
            "QA runtime {stage} failed"
        );
        Ok(())
    }

    pub async fn prepare_image(&self, cancel: CancellationToken) -> Result<String> {
        self.stage("prepare", self.wall, cancel).await?;
        let image: Value = serde_json::from_slice(&std::fs::read(self.path().join("image.json"))?)?;
        Ok(image["image"]
            .as_str()
            .context("missing image digest")?
            .into())
    }

    /// Host-only transport settings. They cannot originate in repository files.
    pub fn set_transport(
        &mut self,
        urls: &[String],
        socket: Option<&Path>,
        subscription: Option<&Path>,
    ) -> Result<()> {
        self.configuration["egress_urls"] = json!(urls);
        if let Some(path) = socket {
            self.configuration["model_socket"] = json!(path);
        }
        if let Some(path) = subscription {
            self.configuration["subscription_file"] = json!(path);
        }
        std::fs::write(
            self.path().join("runtime.json"),
            serde_json::to_vec(&self.configuration)?,
        )?;
        Ok(())
    }

    pub fn set_local_cache(&mut self, root: &Path, seed_bytes: u64) -> Result<()> {
        ensure!(root.is_absolute(), "QA cache root must be absolute");
        self.configuration["local_cache"] = json!(root);
        self.configuration["seed_cache_bytes"] = json!(
            seed_bytes
                .checked_mul(4)
                .context("seed cache limit overflow")?
        );
        std::fs::write(
            self.path().join("runtime.json"),
            serde_json::to_vec(&self.configuration)?,
        )?;
        Ok(())
    }

    pub fn assets(
        &mut self,
        project: &QaProject,
        snapshot: &QaSnapshot,
        plan: &QaPlan,
        mut run: Value,
        image: &str,
        credentials: &BTreeMap<String, String>,
    ) -> Result<Value> {
        self.wall = Duration::from_millis(
            run["budget"]["wall_ms"]
                .as_u64()
                .context("invalid run wall budget")?,
        );
        self.configuration["wall_ms"] = json!(self.wall.as_millis() as u64);
        std::fs::write(
            self.path().join("runtime.json"),
            serde_json::to_vec(&self.configuration)?,
        )?;
        let fingerprint = SeedFingerprint::build(project, snapshot, image)?;
        run["seed_fingerprint"] = serde_json::to_value(&fingerprint)?;
        run["viewports"] = serde_json::to_value(&project.viewports)?;
        run["seed"] = project
            .seed
            .as_ref()
            .map(serde_json::to_value)
            .transpose()?
            .unwrap_or_else(
                || json!({"version":1,"datastores":[],"steps":[],"users":[],"paths":[]}),
            );
        let journeys: BTreeMap<_, _> = project
            .journeys
            .iter()
            .filter(|(name, _)| plan.selected.contains_key(*name))
            .map(|(name, journey)| (name.clone(), journey))
            .collect();
        let mut guidance: BTreeMap<_, _> = journeys
            .iter()
            .map(|(name, journey)| {
                (
                    name.clone(),
                    journey_guidance(snapshot, &project.config, journey),
                )
            })
            .collect();
        if let Some(exploratory) = journeys.get("exploratory") {
            for route in &plan.exploration_routes {
                let mut scoped = (*exploratory).clone();
                scoped.covers.routes = vec![route.clone()];
                guidance.insert(
                    format!("exploratory@{route}"),
                    journey_guidance(snapshot, &project.config, &scoped),
                );
            }
        }
        let version = run["snapshot_version"].as_str().unwrap_or("head");
        ensure!(
            ["base", "head"].contains(&version),
            "invalid snapshot version"
        );
        let mut cells = Vec::new();
        for chain in &plan.chains {
            for cell in &plan.cells {
                if !chain.journeys.iter().any(|name| {
                    project.journeys[name]
                        .viewports
                        .as_ref()
                        .is_none_or(|names| names.contains(&cell.viewport))
                }) {
                    continue;
                }
                cells.push(json!({"id":qa_cell_id(&chain.journeys, cell, version),"chain":chain.journeys,"viewport":cell.viewport,"color_scheme":cell.color_scheme}));
            }
        }
        let config = json!({"cells":cells,"seed_fingerprints":[fingerprint.fingerprint],
            "seed_max_size":seed_size_limit(&project.config.seed.max_size)?,"evidence_retention_days":project.config.evidence.retention_days});
        let mut assets = json!({"contract.json":project.config,"journeys.json":journeys,
            "fixtures.json":project.fixtures.as_ref().map(serde_json::to_value).transpose()?.unwrap_or_else(|| json!({})),
            "owner-guidance.json":guidance,"plan.json":plan,"run.json":run});
        omit_nulls(&mut assets);
        std::fs::write(
            self.path().join("assets.json"),
            serde_json::to_vec(&assets)?,
        )?;
        // Copy only declared persona names. Provider credentials never enter app.
        let allowed: std::collections::BTreeSet<_> = project
            .config
            .personas
            .iter()
            .flat_map(|persona| {
                [persona.username_env.as_ref(), persona.password_env.as_ref()]
                    .into_iter()
                    .flatten()
            })
            .collect();
        let credentials: BTreeMap<_, _> = credentials
            .iter()
            .filter(|(name, _)| allowed.contains(name))
            .collect();
        std::fs::write(
            self.path().join("credentials.json"),
            serde_json::to_vec(&credentials)?,
        )?;
        Ok(config)
    }

    pub async fn execute(&self, cancellation: CancellationToken) -> Result<Value> {
        self.execute_live(cancellation, None, &mut |_| {}).await
    }

    /// [`Self::execute`], taking the host's `control` requests to the running
    /// controller and passing each cell's `progress` back as it is reported.
    pub async fn execute_live(
        &self,
        cancellation: CancellationToken,
        control: Option<&QaControl>,
        progress: &mut (dyn FnMut(QaProgress) + Send),
    ) -> Result<Value> {
        // A marker requests graceful shutdown without killing Docker's copy
        // process. A hard supervisor deadline and independent recovery follow.
        let hard_stop = CancellationToken::new();
        let execution = self.stage(
            "run",
            self.wall + Duration::from_secs(120),
            hard_stop.clone(),
        );
        tokio::pin!(execution);
        let mut live = LiveFiles::default();
        let mut tick = tokio::time::interval(Duration::from_millis(500));
        let result = loop {
            tokio::select! {
                value = &mut execution => break value,
                _ = cancellation.cancelled() => {
                    std::fs::write(self.path().join("cancel"), b"interrupted")?;
                    break match tokio::time::timeout(Duration::from_secs(45), &mut execution).await {
                        Ok(value) => value,
                        Err(_) => { hard_stop.cancel(); execution.await }
                    };
                }
                _ = tick.tick() => live.sync(self.path(), control, progress),
            }
        };
        live.sync(self.path(), None, progress);
        if self
            .stage(
                "recover",
                Duration::from_secs(120),
                CancellationToken::new(),
            )
            .await
            .is_err()
        {
            return Err(QaCleanupUnconfirmed.into());
        }
        let path = self.path().join("result.json");
        if path.exists() {
            ensure!(
                std::fs::metadata(&path)?.len() <= 12 * 1024 * 1024,
                "QA result exceeds limit"
            );
            return Ok(serde_json::from_slice(&std::fs::read(path)?)?);
        }
        result?;
        anyhow::bail!("QA result unavailable")
    }
}

/// The run directory's live files: `control.json` written for the runtime to
/// copy into the controller, and `progress.json` copied out of it.
#[derive(Default)]
struct LiveFiles {
    sent: Option<Vec<u8>>,
    seen: u64,
}

impl LiveFiles {
    fn sync(
        &mut self,
        root: &Path,
        control: Option<&QaControl>,
        progress: &mut (dyn FnMut(QaProgress) + Send),
    ) {
        if let Some(document) = control.map(QaControl::document)
            && self.sent.as_ref() != Some(&document)
        {
            let pending = root.join("control.pending");
            if std::fs::write(&pending, &document).is_ok()
                && std::fs::rename(&pending, root.join("control.json")).is_ok()
            {
                self.sent = Some(document);
            }
        }
        #[derive(Deserialize)]
        struct Progress {
            events: Vec<Value>,
        }
        let Ok(bytes) = std::fs::read(root.join("progress.json")) else {
            return;
        };
        let Ok(Progress { events }) = serde_json::from_slice(&bytes) else {
            return;
        };
        for event in events {
            if let Ok(event) = serde_json::from_value::<QaProgress>(event)
                && event.seq > self.seen
            {
                self.seen = event.seq;
                progress(event);
            }
        }
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;

    #[test]
    fn control_is_written_once_per_change_and_progress_read_once() {
        let root = tempfile::tempdir().unwrap();
        let control = QaControl::default();
        let mut live = LiveFiles::default();
        let mut seen = Vec::new();
        live.sync(root.path(), Some(&control), &mut |p| seen.push(p));
        let read = || -> Value {
            serde_json::from_slice(&std::fs::read(root.path().join("control.json")).unwrap())
                .unwrap()
        };
        assert_eq!(read(), json!({"paused": false, "cancel": []}));
        control.set_paused(true);
        control.cancel(QaCellRef {
            journey: "checkout".into(),
            viewport: "mobile".into(),
            color_scheme: "dark".into(),
        });
        std::fs::write(
            root.path().join("progress.json"),
            r#"{"events":[{"seq":1,"journey":"checkout","viewport":"mobile","color_scheme":"dark","step":0,"outcome":"running"},{"seq":2}]}"#,
        )
        .unwrap();
        live.sync(root.path(), Some(&control), &mut |p| seen.push(p));
        live.sync(root.path(), Some(&control), &mut |p| seen.push(p));
        assert_eq!(
            read(),
            json!({"paused": true, "cancel": [{"journey":"checkout","viewport":"mobile","color_scheme":"dark"}]})
        );
        assert_eq!(seen.len(), 1);
        assert_eq!((seen[0].seq, seen[0].outcome.as_str()), (1, "running"));
    }
}

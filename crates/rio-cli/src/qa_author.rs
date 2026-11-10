//! Local authoring uses the same isolated pod and spending limits as QA.
use anyhow::{Context, Result, ensure};
use rio_qa::*;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::Path,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

pub struct AuthorBudget {
    started: Instant,
    wall: Duration,
    limits: rio_profile::QaBudget,
    spent_tokens: u64,
    evidence_bytes: u64,
}
impl AuthorBudget {
    pub fn new() -> Result<Self> {
        let limits = rio_profile::QaBudget::defaults(false);
        let wall = rio_profile::parse_duration(&limits.wall).map_err(anyhow::Error::msg)?;
        Ok(Self {
            started: Instant::now(),
            wall,
            limits,
            spent_tokens: 0,
            evidence_bytes: 0,
        })
    }
    fn remaining_wall(&self) -> Duration {
        self.wall.saturating_sub(self.started.elapsed())
    }
    fn remaining(&self) -> Result<rio_profile::QaBudget> {
        let mut limits = self.limits.clone();
        limits.tokens = limits.tokens.saturating_sub(self.spent_tokens);
        limits.evidence_bytes = limits.evidence_bytes.saturating_sub(self.evidence_bytes);
        ensure!(
            !self.remaining_wall().is_zero() && limits.tokens > 0 && limits.evidence_bytes > 0,
            "QA authoring budget exhausted"
        );
        Ok(limits)
    }
    fn charge(&mut self, result: &Value, auth: &str) -> Result<()> {
        if auth != "subscription" {
            let tokens = result["tokens"]
                .as_u64()
                .context("Authoring token accounting unavailable")?;
            self.spent_tokens = self.spent_tokens.saturating_add(tokens);
        }
        self.evidence_bytes = self
            .evidence_bytes
            .saturating_add(result["evidence"]["bytes"].as_u64().unwrap_or(0));
        ensure!(
            self.spent_tokens <= self.limits.tokens
                && self.evidence_bytes <= self.limits.evidence_bytes,
            "QA authoring exceeded its shared budget"
        );
        Ok(())
    }
}

pub async fn run(root: &Path, snapshot: RuntimeSnapshot, mode: AuthorMode) -> Result<Value> {
    run_journeys(root, &snapshot, mode, &mut AuthorBudget::new()?, false).await
}

pub async fn run_journeys(
    root: &Path,
    snapshot: &RuntimeSnapshot,
    mode: AuthorMode,
    budget: &mut AuthorBudget,
    discover: bool,
) -> Result<Value> {
    let result = session(root, snapshot, Some(&mode), None, budget, discover).await?;
    if result["reason"] == "setup_required" {
        return Ok(result);
    }
    let proposals = serde_json::from_value::<Vec<JourneyProposal>>(result["proposals"].clone())?;
    let authored = prepare_authored_journeys(&snapshot.files, proposals, &mode)?;
    let files = apply_authored_journeys(root, &snapshot.files, &authored)?;
    Ok(
        json!({"written":files,"warnings":authored.warnings,"review_id":result["review_id"],
        "evidence":result["evidence"],"undoubled_dependencies":result["undoubled_dependencies"],"committed":false}),
    )
}

pub async fn setup(
    root: &Path,
    snapshot: &RuntimeSnapshot,
    stage: &str,
    budget: &mut AuthorBudget,
    blocked: &[String],
) -> Result<Value> {
    let mut input = setup_context(&snapshot.files, stage)?;
    input["missing_dependencies"] = json!(blocked);
    // Setup never starts repository code and receives only bounded metadata.
    // Its otherwise empty pod uses the trusted static runtime and no personas.
    let mut contract = json!({"version":1,"app":{"packaging":"static","directory":"public","url":"http://app.test:4173","ready":{"path":"/","status":200}},
        "personas":[{"name":"guest","description":"Setup authoring"}]});
    if let Some(harness) = input.get("contract").and_then(|value| value.get("harness")) {
        contract["harness"] = harness.clone();
    }
    let mut bootstrap = RuntimeSnapshot::default();
    bootstrap
        .files
        .insert(".rio/qa.yaml".into(), serde_json::to_vec(&contract)?);
    bootstrap.files.insert(
        "public/index.html".into(),
        b"<!doctype html><title>QA setup</title>".to_vec(),
    );
    session(root, &bootstrap, None, Some(input), budget, false).await
}

async fn session(
    root: &Path,
    snapshot: &RuntimeSnapshot,
    mode: Option<&AuthorMode>,
    setup: Option<Value>,
    budget: &mut AuthorBudget,
    discover: bool,
) -> Result<Value> {
    let project = QaProject::load(&snapshot.files)?;
    let config = crate::config::MachineConfig::load(root)?;
    let limits = budget.remaining()?;
    let duration = |value: &str| rio_profile::parse_duration(value).map_err(anyhow::Error::msg);
    let wall = budget.remaining_wall();
    let started = Instant::now();
    let remaining = || wall.saturating_sub(started.elapsed());
    let image = std::env::var("RIO_QA_IMAGE").unwrap_or_else(|_| "rio-qa:0.1.0".into());
    ensure!(
        !image.is_empty() && !image.starts_with('-') && !image.chars().any(char::is_whitespace),
        "Invalid QA image name"
    );
    let subscription = std::env::var_os("CODEX_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| std::path::PathBuf::from(home).join(".codex"))
        })
        .map(|home| home.join("auth.json"));
    let auth = resolve_authentication(
        &project.config.harness.auth,
        &project.config.harness.default,
        QaBackend::Docker,
        false,
        subscription.as_deref(),
    )?;
    let route = if auth.harness_auth == "gateway" {
        let path = std::env::var_os("RIO_QA_MODEL_ROUTE").context("QA authoring needs a codex subscription or RIO_QA_MODEL_ROUTE naming a host model route with keychain metadata")?;
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
    let mut plan = project.plan(
        &QaSnapshot::new(),
        &snapshot.files,
        &SelectionInput {
            full: true,
            ..Default::default()
        },
    )?;
    // One bounded exploration session, with real mobile emulation. The harness
    // may rotate or switch viewports through the existing restricted tools.
    plan.cells.truncate(1);
    ensure!(
        !plan.cells.is_empty(),
        "Authoring needs a configured mobile viewport"
    );
    plan.chains.clear();
    plan.selected.clear();
    plan.cell_count = 1;
    plan.estimated_wall_seconds = wall.as_secs();
    let mut runtime = DockerQaRuntime::new(snapshot, &project.config, &image, wall)?;
    let cancellation = CancellationToken::new();
    let cancelled = cancellation.clone();
    let signal = tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            cancelled.cancel();
        }
    });
    let result = async {
        let digest = runtime.prepare_image(cancellation.clone()).await
            .context("QA authoring requires Docker and the paired QA image; run rio doctor")?;
        ensure!(!remaining().is_zero() && !cancellation.is_cancelled(), "Authoring stopped before browser startup");
        let run_id = format!("author-{}", runtime.pod_id);
        let relay = if let Some(route) = route {
            Some(LocalModelRelay::start(route, &run_id, limits.tokens).await?)
        } else { None };
        let socket = relay.as_ref().map(LocalModelRelay::socket_path);
        runtime.set_transport(&[], socket.as_deref(), auth.subscription_file.as_deref())?;
        std::fs::create_dir_all(&config.cache.dir)?;
        runtime.set_local_cache(&std::fs::canonicalize(&config.cache.dir)?, seed_size_limit(&project.config.seed.max_size)?)?;
        let credentials: BTreeMap<_, _> = project.config.personas.iter()
            .flat_map(|persona| [persona.username_env.as_ref(), persona.password_env.as_ref()].into_iter().flatten())
            .filter_map(|name| std::env::var(name).ok().map(|value| (name.clone(), value))).collect();
        let run = json!({"version":1,"snapshot_version":"head","review_id":run_id,"run_id":run_id,
            "harness":project.config.harness.default,"auth":auth.harness_auth,"model":model,"storage":{"kind":"local"},
            "relay_token":relay.as_ref().map(LocalModelRelay::capability),
            "author":mode.map(|mode| {
                let mut input = authoring_input(&snapshot.files, &project, mode);
                input["discover_dependencies"] = json!(discover); input["detected_dependencies"] = json!(setup_undoubled_dependencies(&snapshot.files, &project)?); Ok::<_, anyhow::Error>(input)
            }).transpose()?, "setup":setup,
            "budget":{"wall_ms":remaining().as_millis() as u64,"cell_wall_ms":duration(&limits.cell_wall)?.as_millis() as u64,
                "tokens":limits.tokens,"evidence_bytes":limits.evidence_bytes}});
        runtime.assets(&project, &snapshot.files, &plan, run, &digest, &credentials)?;
        let result = runtime.execute(cancellation.clone()).await;
        if let Some(relay) = relay { relay.close().await?; }
        let mut result = result?;
        budget.charge(&result, &auth.harness_auth)?;
        ensure!((result["outcome"] == "complete" || discover && result["reason"] == "setup_required") && !cancellation.is_cancelled(),
            "Authoring did not complete ({}); no journey files were written. Evidence remains in the QA cache.",
            result["reason"].as_str().unwrap_or("runtime failed"));
        result["review_id"] = json!(run_id);
        Ok(result)
    }.await;
    signal.abort();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authoring_phases_share_tokens_evidence_and_wall_budget() {
        let mut budget = AuthorBudget::new().unwrap();
        let initial = budget.remaining().unwrap();
        for _ in 0..2 {
            budget
                .charge(
                    &json!({"tokens":10000,"evidence":{"bytes":4096}}),
                    "gateway",
                )
                .unwrap();
        }
        let left = budget.remaining().unwrap();
        assert_eq!(left.tokens, initial.tokens - 20000);
        assert_eq!(left.evidence_bytes, initial.evidence_bytes - 8192);
        budget.started = Instant::now() - budget.wall;
        assert!(budget.remaining().is_err());
    }

    #[test]
    fn missing_or_excess_usage_cannot_fund_another_authoring_phase() {
        let mut budget = AuthorBudget::new().unwrap();
        assert!(
            budget
                .charge(&json!({"tokens":"unmetered"}), "gateway")
                .is_err()
        );
        let excess = budget.limits.tokens + 1;
        assert!(budget.charge(&json!({"tokens":excess}), "gateway").is_err());
        assert!(budget.remaining().is_err());
    }
}

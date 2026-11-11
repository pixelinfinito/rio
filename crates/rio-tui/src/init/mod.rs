//! The `init` flow: I1 choose mode → I2 configure → I3 deploying → I4 failed,
//! resumable or I5 deployed, and I6 connect an existing endpoint.
//!
//! The screens never deploy anything themselves. Everything that runs is an
//! [`Effect`] the host performs, and progress comes back as values.
//!
//! # Effects the screens emit
//!
//! | effect | from | the host does |
//! |---|---|---|
//! | `Step("init:plan")` | I1 `p`, I2 `p` | runs `rio <Handoff::args> --dry-run` (no login, no changes) and answers `Value("init:plan", plan)` |
//! | `Start(["init", …flags])` | I2 `⏎` | runs the deployment exactly as `rio init` with those flags; the typed provider key is in [`Handoff::take_secret`] under its environment name (`OPENROUTER_API_KEY`, …), never in the arguments. Then it reports progress with the values below |
//! | `Step("init:save-choices")` | I2 `s` | writes the choices of [`Handoff::args`] to the user config (as `deployment::save_deployment`), for `rio init --from` |
//! | `Step("init:retry")` | I4 `r` | resumes the deployment at the failed step; completed steps are idempotent and are not repeated |
//! | `Step("init:self-hosted")` | I4 `s` | resumes with `--runner self-hosted` (the Sandbox steps are skipped) |
//! | `Open(url)` | I4 `o` | opens the provider's dashboard |
//! | `Quit` | I4 `q` | leaves, keeping `deployment.pending` so a later `rio init` offers to resume |
//! | `Step("init:first-review")` | I5 `⏎` | hands off to the review flow's start screen |
//! | `Copy(text)` | I5 `t` `c` `u` `p` `e` | copies the teammate command, the URL or the shown command |
//! | `Step("init:local")` | I1 `⏎` on local only | leaves init with nothing written: reviews run with `--offline` |
//! | `Start(["init", "--endpoint", url, "--token-stdin"])` | I6 `⏎` | runs `rio init --endpoint <url> --token-stdin`, writing the token from [`Handoff::take_secret`] (named `stdin`) to its standard input. With the `RIO_API_TOKEN` source the arguments are `["init", "--endpoint", url]` and no token is stored |
//!
//! # Values the screens accept (`Msg::Done(Outcome::Value(name, json))`)
//!
//! - `"init:plan"` (I2): a [`Plan`]: `{"bundle": "7c21a9e4", "worker_version":
//!   "0.2.0", "changes": false, "resources": [{"kind": "Worker", "name": "rio",
//!   "action": "create|reuse|update"}], "bindings": ["DB", …]}`. The
//!   `rio deploy --dry-run` document is accepted as is (`bundle_hash`, and
//!   `resources` as plain kind names).
//! - `"init:step"` (I3): [`StepUpdate`]: `{"step": "<id>", "state":
//!   "pending|running|done|reused|skipped|failed", "detail": "…", "log": "…",
//!   "level": "info|warn|error", "elapsed": 0.4}` plus optional
//!   `"resource": {"kind", "name", "id", "state"}`, `"migration": {"version",
//!   "applied", "total"}` and `"secret": {"name", "done"}` updating the
//!   right-hand panes. `step` is a [`STEPS`] id (or its label).
//! - `"init:failed"` (I3 → I4): [`FailureUpdate`]: `{"step": "<id>", "error":
//!   "…" or {"title", "request", "message"}, "created": ["Worker", …],
//!   "fixes": [{"key": "o", "title": "…", "hint": "…"}], "dashboard": "<url>"}`.
//! - `"init:deployed"` (I3 → I5): [`DeployedUpdate`]: `{"endpoint": "…",
//!   "artifacts": [{"label", "path", "note"}], "resources": [{"kind", "name",
//!   "reused"}], "provider": "OpenRouter", "retries": 1}`.
//!
//! Secrets are never drawn: masked fields show only bullets.

mod configure;
mod connect;
mod deployed;
mod deploying;
mod mode;
mod widgets;

use std::sync::{Arc, Mutex};

use serde::Deserialize;

pub use configure::Configure;
pub use connect::ConnectExisting;
pub use deployed::Deployed;
pub use deploying::{Deploying, Failed};
pub use mode::ChooseMode;

use crate::Screen;

/// I1, the first screen of `rio init` in a terminal.
pub fn choose_mode(data: InitData) -> Box<dyn Screen> {
    Box::new(ChooseMode::new(data))
}

/// The deployment phases of `deployment.rs` (`run` and `provision`), in order,
/// as `(id, label)`. The host reports progress per id with `"init:step"`.
///
/// | id | phase in `deployment.rs` |
/// |---|---|
/// | `authenticate` | `authentication(cf_profile)`: the cf OAuth token |
/// | `account` | `select_account` over `GET /accounts` |
/// | `secrets` | `Secrets::load` + `collect` + provider key, `secrets.save`, `save_choices` |
/// | `runner-image` | `runner_image`: `docker image inspect` / `docker pull` (Sandbox only) |
/// | `registry-copy` | `runner_image`: `cf containers push` with retries, digest check (Sandbox only) |
/// | `d1` | D1 database create-or-reuse (`named …/d1/database`) |
/// | `r2` | R2 bucket `<name>-artifacts` create-or-reuse |
/// | `queue` | Queue `<name>-jobs` create-or-reuse |
/// | `ai-gateway` | AI Gateway create-or-reuse, settings reconciled (auth on, logs off) |
/// | `gateway-token` | AI Gateway Run token (`POST …/tokens`), custom providers and routes |
/// | `worker-upload` | Worker ownership checks, metadata and bundle upload |
/// | `workflows` | `PUT …/workflows/<name>-review` and `-migrate` |
/// | `migrations` | `migrate`: the migration Workflow, then the cron schedule |
/// | `queue-consumer` | Queue consumer attached to the Worker |
/// | `sandbox-rollout` | `configure_container`: Containers application and rollout (Sandbox only) |
/// | `workers-dev` | workers.dev subdomain, route, endpoint saved, default profile written |
pub const STEPS: [(&str, &str); 16] = [
    ("authenticate", "authenticate"),
    ("account", "account"),
    ("secrets", "secrets"),
    ("runner-image", "runner image"),
    ("registry-copy", "registry copy"),
    ("d1", "D1 database"),
    ("r2", "R2 bucket"),
    ("queue", "Queue"),
    ("ai-gateway", "AI Gateway"),
    ("gateway-token", "gateway token"),
    ("worker-upload", "Worker upload"),
    ("workflows", "workflows"),
    ("migrations", "migrations"),
    ("queue-consumer", "queue consumer"),
    ("sandbox-rollout", "sandbox rollout"),
    ("workers-dev", "workers.dev"),
];

/// The steps only the Cloudflare Sandbox runner has.
pub const SANDBOX_STEPS: [&str; 3] = ["runner-image", "registry-copy", "sandbox-rollout"];

/// Everything the flow shows before deploying.
#[derive(Debug, Clone)]
pub struct InitData {
    /// The Rio version, shown in the header (`0.2.0`).
    pub version: String,
    /// The user config directory as shown (`~/.config/rio`).
    pub config_dir: String,
    /// The local preflight: cf, docker, keychain, environment.
    pub preflight: Vec<Check>,
    /// What the user config already holds (`no deployment yet`).
    pub existing: String,
    /// The step a stopped deployment recorded (`deployment.pending`), if any.
    pub pending: Option<String>,
    /// The deploy form's choices and dry-run plan (I2).
    pub configure: ConfigureData,
    /// The connect-existing form (I6).
    pub connect: ConnectData,
    /// Where the screens leave arguments and secrets for the host.
    pub handoff: Handoff,
}

impl InitData {
    /// The user config file (`~/.config/rio/config.toml`).
    pub fn config_file(&self) -> String {
        format!("{}/config.toml", self.config_dir)
    }
}

/// One line of the local preflight.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Check {
    /// Present and usable, missing (asked later), or failing.
    pub state: CheckState,
    /// What was checked (`docker daemon running`).
    pub text: String,
    /// What happens about it, drawn below (`key will be asked, echo off`).
    pub hint: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckState {
    Ok,
    Missing,
    Failed,
}

/// A Cloudflare account from `cf auth`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Account {
    /// The account's display name.
    pub name: String,
    /// The 32-character account id (drawn shortened).
    pub id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Runner {
    Sandbox,
    SelfHosted,
}

impl Runner {
    pub fn flag(self) -> &'static str {
        match self {
            Runner::Sandbox => "sandbox",
            Runner::SelfHosted => "self-hosted",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    OpenRouter,
    OpenAi,
    Anthropic,
}

impl Provider {
    pub const ALL: [Provider; 3] = [Provider::OpenRouter, Provider::OpenAi, Provider::Anthropic];

    pub fn name(self) -> &'static str {
        match self {
            Provider::OpenRouter => "OpenRouter",
            Provider::OpenAi => "OpenAI",
            Provider::Anthropic => "Anthropic",
        }
    }

    /// The environment name the key is supplied under (as `rio init` reads it).
    pub fn key_name(self) -> &'static str {
        match self {
            Provider::OpenRouter => "OPENROUTER_API_KEY",
            Provider::OpenAi => "OPENAI_API_KEY",
            Provider::Anthropic => "ANTHROPIC_API_KEY",
        }
    }

    /// The default profile's models for this key (`primary_models`).
    pub fn models(self) -> &'static str {
        match self {
            Provider::OpenRouter => "rio/openrouter: sonnet-5.5 writes, gpt-6.1-sol verifies",
            Provider::OpenAi => "rio-default: gpt-4.1-mini writes and verifies",
            Provider::Anthropic => "rio-default: claude-haiku-4-5 writes and verifies",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialStore {
    Keychain,
    File,
}

impl CredentialStore {
    pub fn flag(self) -> &'static str {
        match self {
            CredentialStore::Keychain => "keychain",
            CredentialStore::File => "file",
        }
    }
}

/// The deploy form (I2): defaults from the user config and `cf auth`.
#[derive(Debug, Clone)]
pub struct ConfigureData {
    /// Accounts the cf login can deploy to.
    pub accounts: Vec<Account>,
    /// The chosen account (index into `accounts`).
    pub account: usize,
    /// The deployment name (`rio`), the prefix of every resource.
    pub name: String,
    pub runner: Runner,
    /// The released runner image (`ghcr.io/pixelinfinito/rio-runner:0.2.0`).
    pub runner_image: String,
    pub provider: Provider,
    /// Provider key names already set in the environment (no key asked then).
    pub env_keys: Vec<String>,
    pub credential_store: CredentialStore,
    /// The account's workers.dev subdomain (`pixel-labs`), if it has one.
    pub subdomain: Option<String>,
    /// The token scopes `cf auth scopes` reports.
    pub scopes: Vec<String>,
    /// The last dry-run plan, if one was made.
    pub plan: Option<Plan>,
}

/// The dry-run plan (`rio deploy --dry-run`): what deploying would create.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct Plan {
    /// The Worker bundle hash (drawn as its first 8 characters).
    #[serde(alias = "bundle_hash")]
    pub bundle: String,
    pub worker_version: String,
    /// The plan was made against the account and would change it.
    #[serde(alias = "mutations")]
    pub changes: bool,
    pub resources: Vec<PlanResource>,
    /// Worker bindings (`DB`, `ARTIFACTS`, …).
    pub bindings: Vec<String>,
}

/// One planned resource.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(from = "RawPlanResource")]
pub struct PlanResource {
    /// `Worker`, `D1 database`, …
    pub kind: String,
    /// Its name and settings (`rio · auth, no logs`).
    pub name: String,
    /// `create`, `reuse` or `update`.
    pub action: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum RawPlanResource {
    Kind(String),
    Full {
        kind: String,
        #[serde(default)]
        name: String,
        #[serde(default)]
        action: Option<String>,
    },
}

impl From<RawPlanResource> for PlanResource {
    fn from(raw: RawPlanResource) -> Self {
        match raw {
            RawPlanResource::Kind(kind) => Self {
                kind,
                name: String::new(),
                action: "create".into(),
            },
            RawPlanResource::Full { kind, name, action } => Self {
                kind,
                name,
                action: action.unwrap_or_else(|| "create".into()),
            },
        }
    }
}

/// Where the API token of an existing endpoint comes from (I6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenSource {
    /// `--token-stdin`: stored privately in the config directory.
    Stdin,
    /// `RIO_API_TOKEN` at run time; nothing stored.
    Env,
}

/// The connect-existing form (I6).
#[derive(Debug, Clone)]
pub struct ConnectData {
    /// The endpoint URL typed so far.
    pub url: String,
    pub source: TokenSource,
    /// `RIO_API_TOKEN` is set in the environment.
    pub env_token: bool,
}

/// What the screens leave for the host: the `rio init` arguments of the last
/// plan or deploy request, and a typed secret. Shared between the host and
/// the screens; its `Debug` never prints the secret.
#[derive(Clone, Default)]
pub struct Handoff(Arc<Mutex<HandoffInner>>);

#[derive(Default)]
struct HandoffInner {
    args: Vec<String>,
    secret: Option<(String, String)>,
}

impl std::fmt::Debug for Handoff {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let inner = self.lock();
        f.debug_struct("Handoff")
            .field("args", &inner.args)
            .field("secret", &inner.secret.as_ref().map(|(name, _)| name))
            .finish()
    }
}

impl Handoff {
    fn lock(&self) -> std::sync::MutexGuard<'_, HandoffInner> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The `rio` arguments (`["init", "--account", …]`) of the last request.
    pub fn args(&self) -> Vec<String> {
        self.lock().args.clone()
    }

    pub(crate) fn set_args(&self, args: Vec<String>) {
        self.lock().args = args;
    }

    /// The secret typed for the last request as `(name, value)`, once: the
    /// provider key's environment name, or `stdin` for an endpoint token.
    pub fn take_secret(&self) -> Option<(String, String)> {
        self.lock().secret.take()
    }

    /// The secret's name, if one is waiting.
    pub fn secret_name(&self) -> Option<String> {
        self.lock().secret.as_ref().map(|(name, _)| name.clone())
    }

    pub(crate) fn set_secret(&self, secret: Option<(String, String)>) {
        self.lock().secret = secret;
    }
}

/// The state of a deployment step or resource.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StepState {
    Pending,
    Running,
    Done,
    /// Found and reused (create-or-reuse), drawn `↺`.
    Reused,
    Skipped,
    Failed,
}

impl StepState {
    /// Finished: counts towards progress and stays done on retry.
    pub fn finished(self) -> bool {
        matches!(
            self,
            StepState::Done | StepState::Reused | StepState::Skipped
        )
    }
}

/// One deployment step (I3, I4).
#[derive(Debug, Clone, PartialEq)]
pub struct StepRow {
    /// The [`STEPS`] id.
    pub id: String,
    /// The label drawn (`D1 database`).
    pub label: String,
    pub state: StepState,
    /// What it did or will do (`rio · reused`).
    pub detail: String,
    /// Seconds it took, once finished.
    pub elapsed: Option<f64>,
    /// Its log lines.
    pub log: Vec<LogLine>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    #[default]
    Info,
    Warn,
    Error,
}

/// A line of deployment output (stderr of `rio init`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogLine {
    pub level: Level,
    pub text: String,
}

impl LogLine {
    pub fn info(text: impl Into<String>) -> Self {
        Self {
            level: Level::Info,
            text: text.into(),
        }
    }
    pub fn warn(text: impl Into<String>) -> Self {
        Self {
            level: Level::Warn,
            text: text.into(),
        }
    }
    pub fn error(text: impl Into<String>) -> Self {
        Self {
            level: Level::Error,
            text: text.into(),
        }
    }
}

/// A resource in I3's resource map.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ResourceRow {
    pub state: StepState,
    /// `D1`, `Queue`, … (empty continues the row above).
    #[serde(default)]
    pub kind: String,
    pub name: String,
    /// The provider's id or version (`9a1e4c…`), `—` when none.
    #[serde(default)]
    pub id: String,
}

/// The D1 schema migration (I3).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Migration {
    /// The schema version (`v1`).
    pub version: String,
    /// Statements applied so far.
    pub applied: u32,
    pub total: u32,
}

/// The runner image copy (I3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunnerImage {
    /// The released image (`ghcr.io/pixelinfinito/rio-runner`).
    pub source: String,
    /// The account registry it is copied to.
    pub destination: String,
    /// Size, retries, digest check.
    pub note: String,
}

/// A secret the Worker receives (I3), by name only.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct SecretRow {
    pub name: String,
    #[serde(default)]
    pub done: bool,
}

/// A running deployment (I3), also kept by I4 and I5.
#[derive(Debug, Clone)]
pub struct DeployingData {
    /// The account's display name.
    pub account_name: String,
    /// The account id (drawn shortened).
    pub account_id: String,
    /// The deployment name (`rio`).
    pub name: String,
    pub steps: Vec<StepRow>,
    pub resources: Vec<ResourceRow>,
    pub migration: Option<Migration>,
    pub runner_image: Option<RunnerImage>,
    pub secrets: Vec<SecretRow>,
    /// Where the Worker secrets are kept (`Worker secrets · keychain copy`).
    pub secrets_note: String,
    /// The whole deployment log.
    pub log: Vec<LogLine>,
    /// Seconds since the deployment started.
    pub elapsed: u64,
}

impl DeployingData {
    /// The 16 steps of a fresh deployment, all pending, with what each will do.
    pub fn new(account: &Account, name: &str, runner: Runner, subdomain: Option<&str>) -> Self {
        let host = match subdomain {
            Some(sub) => format!("{name}.{sub}.workers.dev"),
            None => format!("{name}.workers.dev"),
        };
        let planned = |id: &str| -> String {
            match id {
                "authenticate" => "cf OAuth".into(),
                "account" => account.name.clone(),
                "secrets" => "provider key · generated secrets".into(),
                "runner-image" => "released rio-runner".into(),
                "registry-copy" => "to your Cloudflare registry".into(),
                "d1" => name.into(),
                "r2" => format!("{name}-artifacts"),
                "queue" => format!("{name}-jobs"),
                "ai-gateway" => format!("{name} · auth on · logs off"),
                "gateway-token" => "AI Gateway Run · account".into(),
                "worker-upload" => "bundle · bindings".into(),
                "workflows" => format!("{name}-review · {name}-migrate"),
                "migrations" => "D1 schema".into(),
                "queue-consumer" => format!("{name}-jobs → {name}"),
                "sandbox-rollout" => "standard-4 · rolling".into(),
                _ => host.clone(),
            }
        };
        let steps = STEPS
            .iter()
            .map(|(id, label)| {
                let skipped = runner == Runner::SelfHosted && SANDBOX_STEPS.contains(id);
                StepRow {
                    id: (*id).into(),
                    label: (*label).into(),
                    state: if skipped {
                        StepState::Skipped
                    } else {
                        StepState::Pending
                    },
                    detail: if skipped {
                        "self-hosted runner".into()
                    } else {
                        planned(id)
                    },
                    elapsed: None,
                    log: Vec::new(),
                }
            })
            .collect();
        let pending = |kind: &str, name: String| ResourceRow {
            state: StepState::Pending,
            kind: kind.into(),
            name,
            id: "pending".into(),
        };
        let mut resources = vec![
            pending("D1", name.into()),
            pending("R2", format!("{name}-artifacts")),
            pending("Queue", format!("{name}-jobs")),
            pending("Gateway", name.into()),
            pending("Worker", name.into()),
            pending("Workflows", format!("{name}-review")),
            pending("", format!("{name}-migrate")),
        ];
        if runner == Runner::Sandbox {
            resources.push(pending("Registry", format!("{name}-runner")));
            resources.push(pending("Sandbox", "standard-4".into()));
        }
        Self {
            account_name: account.name.clone(),
            account_id: account.id.clone(),
            name: name.into(),
            steps,
            resources,
            migration: None,
            runner_image: None,
            secrets: Vec::new(),
            secrets_note: String::new(),
            log: Vec::new(),
            elapsed: 0,
        }
    }

    /// Steps finished (done, reused or skipped).
    pub fn finished(&self) -> usize {
        self.steps.iter().filter(|s| s.state.finished()).count()
    }

    fn step_index(&self, step: &str) -> Option<usize> {
        self.steps
            .iter()
            .position(|s| s.id == step || s.label.eq_ignore_ascii_case(step))
    }

    /// Apply an `"init:step"` value.
    pub fn apply(&mut self, update: StepUpdate) {
        if let Some(i) = self.step_index(&update.step) {
            let step = &mut self.steps[i];
            if let Some(state) = update.state {
                step.state = state;
            }
            if let Some(detail) = update.detail {
                step.detail = detail;
            }
            if update.elapsed.is_some() {
                step.elapsed = update.elapsed;
            }
            if let Some(text) = &update.log {
                step.log.push(LogLine {
                    level: update.level,
                    text: text.clone(),
                });
            }
        }
        if let Some(text) = update.log {
            self.log.push(LogLine {
                level: update.level,
                text,
            });
        }
        if let Some(resource) = update.resource {
            match self.resources.iter_mut().find(|r| {
                r.name == resource.name && (resource.kind.is_empty() || r.kind == resource.kind)
            }) {
                Some(row) => {
                    row.state = resource.state;
                    if !resource.id.is_empty() {
                        row.id = resource.id;
                    }
                }
                None => self.resources.push(resource),
            }
        }
        if update.migration.is_some() {
            self.migration = update.migration;
        }
        if let Some(secret) = update.secret {
            match self.secrets.iter_mut().find(|s| s.name == secret.name) {
                Some(row) => row.done = secret.done,
                None => self.secrets.push(secret),
            }
        }
    }
}

/// The `"init:step"` value.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct StepUpdate {
    /// The step id (or label).
    pub step: String,
    pub state: Option<StepState>,
    pub detail: Option<String>,
    /// A log line to append.
    pub log: Option<String>,
    pub level: Level,
    /// Seconds the step took.
    pub elapsed: Option<f64>,
    pub resource: Option<ResourceRow>,
    pub migration: Option<Migration>,
    pub secret: Option<SecretRow>,
}

/// The provider's error (I4).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct ProviderError {
    /// One line (`Containers unavailable`).
    pub title: String,
    /// The request that failed (`POST …/containers/applications`).
    pub request: String,
    /// The provider's explanation.
    pub message: String,
}

/// A way to fix a failure (I4).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Fix {
    /// The key that does it on I4 (`o`, `s`), if any.
    #[serde(default)]
    pub key: Option<char>,
    pub title: String,
    /// The command or place it involves.
    #[serde(default)]
    pub hint: String,
}

/// A stopped deployment (I4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FailureData {
    /// The failed step's id.
    pub step: String,
    pub error: ProviderError,
    /// What already exists and is kept (`Worker`, `D1`, …).
    pub created: Vec<String>,
    pub fixes: Vec<Fix>,
    /// The provider dashboard `o` opens.
    pub dashboard: String,
}

/// The `"init:failed"` value.
#[derive(Debug, Clone, Deserialize)]
pub struct FailureUpdate {
    pub step: String,
    pub error: RawError,
    #[serde(default)]
    pub created: Vec<String>,
    #[serde(default)]
    pub fixes: Vec<Fix>,
    #[serde(default)]
    pub dashboard: Option<String>,
}

/// An error as a plain message or a [`ProviderError`].
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum RawError {
    Text(String),
    Full(ProviderError),
}

impl From<FailureUpdate> for FailureData {
    fn from(update: FailureUpdate) -> Self {
        let error = match update.error {
            RawError::Text(text) => ProviderError {
                title: text,
                ..ProviderError::default()
            },
            RawError::Full(error) => error,
        };
        Self {
            step: update.step,
            error,
            created: update.created,
            fixes: update.fixes,
            dashboard: update
                .dashboard
                .unwrap_or_else(|| "https://dash.cloudflare.com".into()),
        }
    }
}

/// A file or keychain entry the deployment saved (I5); never a secret value.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Artifact {
    /// `config`, `keychain`, `profile`.
    pub label: String,
    /// Where it is (`~/.config/rio/config.toml`).
    pub path: String,
    /// What it holds (`choices only · no secrets`).
    #[serde(default)]
    pub note: String,
}

/// A deployed resource (I5).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct DeployedResource {
    pub kind: String,
    pub name: String,
    /// It existed and was reused.
    #[serde(default)]
    pub reused: bool,
}

/// A finished deployment (I5): the `"init:deployed"` value.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct DeployedData {
    /// The endpoint URL.
    pub endpoint: String,
    #[serde(default)]
    pub artifacts: Vec<Artifact>,
    #[serde(default)]
    pub resources: Vec<DeployedResource>,
    /// The model provider that bills usage (`OpenRouter`).
    #[serde(default)]
    pub provider: String,
    /// Retries during the deployment (registry pushes, …).
    #[serde(default)]
    pub retries: u32,
}

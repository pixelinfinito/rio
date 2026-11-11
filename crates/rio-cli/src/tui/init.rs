//! The host of `rio init` in the interactive UI: I1's data from this machine
//! and the user config, and the effects the init screens ask for. Every step
//! runs the same code as the command without the UI: the dry-run plan, the
//! named deployment steps of `deployment.rs`, and `rio init --endpoint`.

use std::{
    path::Path,
    sync::{Arc, Mutex, atomic::Ordering, mpsc::Sender},
};

use clap::Parser;
use rio_tui::{
    Effect, Msg, Outcome,
    init::{
        Account, Check, CheckState, ConfigureData, ConnectData, CredentialStore, Handoff, InitData,
        Provider, Runner, TokenSource,
    },
};
use serde_json::{Value, json};

use crate::{
    Cli, Command,
    deployment::{self, DeployArgs, Deployer, Stopped},
};

/// How the session ended, for the summary printed after the UI closes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum Ended {
    /// Nothing ran or was written.
    #[default]
    Nothing,
    /// Deployed: the endpoint.
    Deployed(String),
    /// A deployment stopped at the step, with the error.
    Stopped(String, String),
    /// Connected to an existing endpoint: the config file written.
    Connected(String),
    /// Connecting failed: the error.
    ConnectFailed(String),
    /// Local only: nothing written.
    Local,
}

/// I1's data: the preflight, what the user config holds, the deploy form's
/// defaults (saved choices, `cf` accounts) and the connect form.
pub async fn init_data() -> InitData {
    let directory = crate::config::config_directory().unwrap_or_default();
    let saved = deployment::choices(&DeployArgs::default(), &directory).unwrap_or_default();
    let config = std::fs::read_to_string(directory.join("config.toml"))
        .ok()
        .and_then(|text| toml::from_str::<toml::Value>(&text).ok());
    let endpoint = config
        .as_ref()
        .and_then(|c| c.get("endpoint")?.get("url")?.as_str().map(str::to_owned));
    let has_deployment = config
        .as_ref()
        .is_some_and(|c| c.get("deployment").is_some());
    let env_keys: Vec<String> = [Provider::OpenRouter, Provider::OpenAi, Provider::Anthropic]
        .iter()
        .map(|p| p.key_name().to_owned())
        .filter(|key| std::env::var_os(key).is_some_and(|v| !v.is_empty()))
        .collect();
    let docker = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        tokio::process::Command::new("docker")
            .args(["info", "--format", "{{.ServerVersion}}"])
            .stdin(std::process::Stdio::null())
            .output(),
    )
    .await
    .ok()
    .and_then(Result::ok)
    .is_some_and(|out| out.status.success());
    let token = std::env::var_os("CLOUDFLARE_API_TOKEN").is_some();
    let cf = on_path("cf");
    let mut preflight = vec![if token {
        check(CheckState::Ok, "CLOUDFLARE_API_TOKEN set", None)
    } else if cf {
        check(CheckState::Ok, "cf CLI found", None)
    } else {
        check(
            CheckState::Missing,
            "cf CLI not found",
            Some("install cf and run cf auth login, or set CLOUDFLARE_API_TOKEN"),
        )
    }];
    preflight.push(if docker {
        check(CheckState::Ok, "docker daemon running", None)
    } else {
        check(
            CheckState::Missing,
            "docker not running",
            Some("the Sandbox runner copies its image with Docker"),
        )
    });
    preflight.push(match env_keys.first() {
        Some(key) => check(CheckState::Ok, &format!("{key} set"), None),
        None => check(
            CheckState::Missing,
            "no model key in the environment",
            Some("key will be asked, echo off"),
        ),
    });
    // Accounts the cf login reaches, read without logging in again.
    let mut accounts: Vec<Account> = if token || cf {
        tokio::time::timeout(
            std::time::Duration::from_secs(15),
            deployment::accounts(&saved.cf_profile),
        )
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_default()
        .into_iter()
        .map(|(id, name)| Account { name, id })
        .collect()
    } else {
        Vec::new()
    };
    if let Some(id) = &saved.account_id
        && !accounts.iter().any(|a| &a.id == id)
    {
        accounts.insert(
            0,
            Account {
                name: "saved account".into(),
                id: id.clone(),
            },
        );
    }
    let account = saved
        .account_id
        .as_ref()
        .and_then(|id| accounts.iter().position(|a| &a.id == id))
        .unwrap_or(0);
    let provider = match env_keys.first().map(String::as_str) {
        Some("OPENAI_API_KEY") => Provider::OpenAi,
        Some("ANTHROPIC_API_KEY") => Provider::Anthropic,
        _ => Provider::OpenRouter,
    };
    let existing = match (&endpoint, has_deployment) {
        (Some(url), true) => format!("deployment {} · {url}", saved.name),
        (Some(url), false) => format!("endpoint {url}"),
        (None, true) => format!("deployment {} · not finished", saved.name),
        (None, false) => "no deployment yet".into(),
    };
    InitData {
        version: env!("CARGO_PKG_VERSION").into(),
        config_dir: shown_path(&directory),
        preflight,
        existing,
        pending: deployment::pending(),
        configure: ConfigureData {
            accounts,
            account,
            name: saved.name.clone(),
            runner: match saved.runner {
                deployment::Runner::Sandbox => Runner::Sandbox,
                deployment::Runner::SelfHosted => Runner::SelfHosted,
            },
            runner_image: saved.runner_image.clone().unwrap_or_else(|| {
                format!("ghcr.io/pixelinfinito/rio-runner:{}", env!("RIO_VERSION"))
            }),
            provider,
            env_keys,
            credential_store: match saved.credential_store {
                deployment::CredentialStore::Keychain => CredentialStore::Keychain,
                deployment::CredentialStore::File => CredentialStore::File,
            },
            subdomain: saved.workers_subdomain.clone(),
            scopes: Vec::new(),
            plan: None,
        },
        connect: ConnectData {
            url: String::new(),
            source: TokenSource::Stdin,
            env_token: std::env::var_os("RIO_API_TOKEN").is_some(),
        },
        handoff: Handoff::default(),
    }
}

fn check(state: CheckState, text: &str, hint: Option<&str>) -> Check {
    Check {
        state,
        text: text.into(),
        hint: hint.map(str::to_owned),
    }
}

fn on_path(program: &str) -> bool {
    std::env::var_os("PATH")
        .is_some_and(|paths| std::env::split_paths(&paths).any(|dir| dir.join(program).is_file()))
}

/// A path with the home directory shown as `~`.
fn shown_path(path: &Path) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let shown = path.display().to_string();
    match shown.strip_prefix(&home) {
        Some(rest) if !home.is_empty() => format!("~{rest}"),
        _ => shown,
    }
}

/// The deployment arguments of `rio init …` as the screens left them.
fn deploy_args(args: &[String]) -> Result<DeployArgs, String> {
    match Cli::try_parse_from(std::iter::once("rio".to_owned()).chain(args.iter().cloned())) {
        Ok(Cli {
            command:
                Command::Init {
                    endpoint: None,
                    deployment,
                    ..
                },
        }) => Ok(deployment),
        Ok(_) => Err("only rio init deploys from here".into()),
        Err(error) => Err(error.to_string()),
    }
}

/// Runs the init flow's effects.
pub struct InitHost {
    /// The user config directory `rio init --endpoint` writes to.
    directory: std::path::PathBuf,
    runtime: tokio::runtime::Handle,
    reply: Sender<Msg>,
    handoff: Handoff,
    /// The deployment, kept between a stop and a retry.
    deployer: Arc<Mutex<Option<Deployer>>>,
    /// Stops a running deployment before its next step.
    cancel: Option<Arc<std::sync::atomic::AtomicBool>>,
    thread: Option<std::thread::JoinHandle<()>>,
    pub ended: Arc<Mutex<Ended>>,
    /// The session ended itself (`init:first-review`, `init:local`).
    done: bool,
    /// `init:first-review` was chosen.
    pub first_review: bool,
    /// The second Ctrl-C ended the session (exit 130).
    pub killed: bool,
}

impl InitHost {
    pub fn new(runtime: tokio::runtime::Handle, reply: Sender<Msg>, handoff: Handoff) -> Self {
        Self {
            directory: crate::config::config_directory().unwrap_or_default(),
            runtime,
            reply,
            handoff,
            deployer: Arc::default(),
            cancel: None,
            thread: None,
            ended: Arc::default(),
            done: false,
            first_review: false,
            killed: false,
        }
    }

    fn send(&self, outcome: Outcome) {
        let _ = self.reply.send(Msg::Done(outcome));
    }

    fn plan(&self) {
        let outcome = deploy_args(&self.handoff.args()).and_then(|args| {
            deployment::plan(&args).map_err(|e| rio_core::redact(&format!("{e:#}")))
        });
        self.send(match outcome {
            Ok(plan) => Outcome::Value("init:plan".into(), plan),
            Err(error) => Outcome::Failed(error),
        });
    }

    fn save_choices(&self) {
        let outcome = deploy_args(&self.handoff.args()).and_then(|args| {
            (|| {
                let directory = crate::config::config_directory()?;
                rio_git::private_directory(&directory)?;
                let choices = deployment::choices(&args, &directory)?;
                deployment::save_deployment(&directory, &choices)?;
                anyhow::Ok(directory.join("config.toml"))
            })()
            .map_err(|e| rio_core::redact(&format!("{e:#}")))
        });
        self.send(match outcome {
            Ok(file) => Outcome::Ok(format!(
                "choices saved in {} · rio init --from replays them",
                shown_path(&file)
            )),
            Err(error) => Outcome::Failed(error),
        });
    }

    /// `rio init --endpoint <url> [--token-stdin]`, the token from the handoff.
    fn connect(&self, args: &[String]) {
        let url = args
            .iter()
            .position(|a| a == "--endpoint")
            .and_then(|i| args.get(i + 1))
            .cloned()
            .unwrap_or_default();
        let token = if args.iter().any(|a| a == "--token-stdin") {
            match self.handoff.take_secret() {
                Some((name, value)) if name == "stdin" => Some(value),
                _ => return self.send(Outcome::Failed("paste the API token first".into())),
            }
        } else {
            None
        };
        let outcome = crate::connect_endpoint_in(&self.directory, url.clone(), token);
        let mut ended = self.ended.lock().unwrap_or_else(|e| e.into_inner());
        match outcome {
            Ok(file) => {
                *ended = Ended::Connected(file.display().to_string());
                drop(ended);
                self.send(Outcome::Ok(format!(
                    "connected to {} · {} written",
                    rio_core::redact(&url),
                    shown_path(&file)
                )));
            }
            Err(error) => {
                let error = rio_core::redact(&format!("{error:#}"));
                *ended = Ended::ConnectFailed(error.clone());
                drop(ended);
                self.send(Outcome::Failed(error));
            }
        }
    }

    /// Start a deployment of the screens' choices: the same steps as `rio init`.
    fn deploy(&mut self, args: &[String]) {
        if self.thread.as_ref().is_some_and(|t| !t.is_finished()) {
            return self.send(Outcome::Failed("a deployment is running".into()));
        }
        let args = match deploy_args(args) {
            Ok(args) => args,
            Err(error) => return self.fail_start(error),
        };
        let reply = self.reply.clone();
        let reporter: deployment::Reporter = Arc::new(move |progress| {
            if let Ok(value) = serde_json::to_value(&progress) {
                let _ = reply.send(Msg::Done(Outcome::Value("init:step".into(), value)));
            }
        });
        let mut deployer = match Deployer::new(args, false, false, reporter) {
            Ok(deployer) => deployer,
            Err(error) => return self.fail_start(rio_core::redact(&format!("{error:#}"))),
        };
        // The typed key goes to the secrets step only, never into arguments or logs.
        if let Some((name, value)) = self.handoff.take_secret()
            && let Err(error) = deployer.supply(&name, value)
        {
            return self.fail_start(error.to_string());
        }
        self.spawn(deployer);
    }

    /// A deployment that could not start, shown on I4 at the first step.
    fn fail_start(&self, error: String) {
        self.send(Outcome::Value(
            "init:failed".into(),
            json!({"step": deployment::STEPS[0], "error": error}),
        ));
    }

    /// Resume a stopped deployment at its stopped step.
    fn resume(&mut self, self_hosted: bool) {
        if self.thread.as_ref().is_some_and(|t| !t.is_finished()) {
            return self.send(Outcome::Failed("a deployment is running".into()));
        }
        let taken = self
            .deployer
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        let Some(mut deployer) = taken else {
            return self.send(Outcome::Failed(
                "nothing to resume here; rio deploy resumes a stopped deployment".into(),
            ));
        };
        if self_hosted && let Err(error) = deployer.switch_to_self_hosted() {
            let message = rio_core::redact(&format!("{error:#}"));
            *self.deployer.lock().unwrap_or_else(|e| e.into_inner()) = Some(deployer);
            return self.send(Outcome::Failed(message));
        }
        deployer.cancel.store(false, Ordering::Relaxed);
        self.spawn(deployer);
    }

    fn spawn(&mut self, mut deployer: Deployer) {
        self.cancel = Some(deployer.cancel.clone());
        let reply = self.reply.clone();
        let slot = self.deployer.clone();
        let ended = self.ended.clone();
        let runtime = self.runtime.clone();
        self.thread = Some(std::thread::spawn(move || {
            let result = runtime.block_on(deployer.run());
            let (value, end) = match result {
                Ok(()) => {
                    let endpoint = deployer.endpoint().unwrap_or_default().to_owned();
                    (
                        Outcome::Value("init:deployed".into(), deployed(&deployer)),
                        Ended::Deployed(endpoint),
                    )
                }
                Err(stopped) => {
                    let value = failed(&deployer, &stopped);
                    let end = Ended::Stopped(
                        stopped.step.into(),
                        rio_core::redact(&format!("{:#}", stopped.error)),
                    );
                    (Outcome::Value("init:failed".into(), value), end)
                }
            };
            *ended.lock().unwrap_or_else(|e| e.into_inner()) = end;
            *slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(deployer);
            let _ = reply.send(Msg::Done(value));
        }));
    }

    /// Wait for a running deployment (it stops before its next step once cancelled).
    pub fn stop(&mut self) {
        if let Some(cancel) = &self.cancel {
            cancel.store(true, Ordering::Relaxed);
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// The `"init:deployed"` value: the endpoint, what was saved, and the resources.
fn deployed(deployer: &Deployer) -> Value {
    let d = &deployer.deployment;
    let directory = deployer.directory();
    let secrets = match d.credential_store {
        deployment::CredentialStore::Keychain => json!({"label": "keychain",
            "path": format!("rio-deployment/{}/{}", d.account_id.as_deref().unwrap_or(""), d.name),
            "note": "Worker secrets copy"}),
        deployment::CredentialStore::File => json!({"label": "secrets",
            "path": shown_path(&directory.join(format!("secrets-{}-{}.json",
                d.account_id.as_deref().unwrap_or("unknown"), d.name))),
            "note": "private file · 0600"}),
    };
    let profile = directory.join("profiles/default.yaml");
    let provider = [
        ("OPENROUTER_API_KEY", "OpenRouter"),
        ("OPENAI_API_KEY", "OpenAI"),
        ("ANTHROPIC_API_KEY", "Anthropic"),
    ]
    .iter()
    .find(|(key, _)| deployer.has_secret(key))
    .map(|(_, name)| *name)
    .unwrap_or("custom provider");
    json!({
        "endpoint": deployer.endpoint().unwrap_or_default(),
        "artifacts": [
            {"label": "config", "path": shown_path(&directory.join("config.toml")),
             "note": "choices only · no secrets"},
            secrets,
            {"label": "profile", "path": shown_path(&profile),
             "note": if deployer.profile_written { "written" } else { "kept" }},
        ],
        "resources": deployer.resources.iter()
            .filter(|(kind, _, _)| !kind.is_empty())
            .map(|(kind, name, reused)| json!({"kind": kind, "name": name, "reused": reused}))
            .collect::<Vec<_>>(),
        "provider": provider,
        "retries": deployer.retries,
    })
}

/// The `"init:failed"` value: the stopped step, the provider's error, what is
/// kept, and the ways on.
fn failed(deployer: &Deployer, stopped: &Stopped) -> Value {
    let message = rio_core::redact(&format!("{:#}", stopped.error));
    let title = rio_core::redact(&stopped.error.to_string());
    // `Cloudflare <path> failed (HTTP …)` names the request.
    let request = title
        .strip_prefix("Cloudflare ")
        .and_then(|rest| rest.split_once(" failed"))
        .map(|(path, _)| path.to_owned())
        .unwrap_or_default();
    let account = deployer.deployment.account_id.clone().unwrap_or_default();
    let dashboard = if account.is_empty() {
        "https://dash.cloudflare.com".to_owned()
    } else {
        format!("https://dash.cloudflare.com/{account}")
    };
    let mut fixes = vec![
        json!({"key": "r", "title": format!("retry from {}", stopped.step),
        "hint": "completed steps are kept and not repeated"}),
    ];
    if ["runner-image", "registry-copy", "sandbox-rollout"].contains(&stopped.step) {
        fixes.push(
            json!({"key": "s", "title": "continue with the self-hosted runner",
            "hint": "rio init --runner self-hosted"}),
        );
    }
    fixes.push(json!({"key": "o", "title": "open the Cloudflare dashboard", "hint": dashboard}));
    fixes.push(json!({"key": "q", "title": "resume later", "hint": "rio deploy resumes it"}));
    let mut created: Vec<String> = Vec::new();
    for (kind, _, _) in &deployer.resources {
        if !kind.is_empty() && !created.contains(kind) {
            created.push(kind.clone());
        }
    }
    json!({
        "step": stopped.step,
        "error": {"title": title, "request": request, "message": message},
        "created": created,
        "fixes": fixes,
        "dashboard": dashboard,
    })
}

impl rio_tui::terminal::Host for InitHost {
    fn run(&mut self, effect: Effect, _reply: &Sender<Msg>) {
        match effect {
            Effect::Step(name) => match name.as_str() {
                "init:plan" => self.plan(),
                "init:save-choices" => self.save_choices(),
                "init:retry" => self.resume(false),
                "init:self-hosted" => self.resume(true),
                // The review flow has its own host: init closes and the summary
                // tells the user to run `rio review`.
                "init:first-review" => {
                    self.first_review = true;
                    self.done = true;
                }
                "init:local" => {
                    *self.ended.lock().unwrap_or_else(|e| e.into_inner()) = Ended::Local;
                    self.done = true;
                }
                other => self.send(Outcome::Failed(format!("{other} is not part of rio init"))),
            },
            Effect::Start(args) if args.iter().any(|a| a == "--endpoint") => self.connect(&args),
            Effect::Start(args) => self.deploy(&args),
            Effect::Open(target) => {
                let opener = if cfg!(target_os = "macos") {
                    "open"
                } else {
                    "xdg-open"
                };
                match std::process::Command::new(opener)
                    .arg(&target)
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                {
                    Ok(_) => self.send(Outcome::Ok(format!("opened {target}"))),
                    Err(error) => self.send(Outcome::Failed(format!("{opener}: {error}"))),
                }
            }
            Effect::Copy(text) => {
                super::review::copy(&text);
                self.send(Outcome::Ok("copied to the clipboard".into()));
            }
            // First Ctrl-C: the deployment stops before its next step; the
            // stopped step stays recorded for `rio deploy`.
            Effect::Cancel => {
                if let Some(cancel) = &self.cancel {
                    cancel.store(true, Ordering::Relaxed);
                }
            }
            Effect::Kill => self.killed = true,
            // `deployment.pending` stays recorded, so a later `rio init` offers to resume.
            Effect::Quit => {}
            other => self.send(Outcome::Failed(format!(
                "{} is not part of rio init",
                match other {
                    Effect::Export { .. } => "export",
                    Effect::Feedback { .. } => "feedback",
                    Effect::Edit { .. } => "editing",
                    _ => "this action",
                }
            ))),
        }
    }

    fn finished(&mut self) -> bool {
        self.done
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deploy_arguments_parse_as_rio_init_does() {
        let args: Vec<String> = [
            "init",
            "--account",
            &"a".repeat(32),
            "--name",
            "rio",
            "--runner",
            "self-hosted",
            "--credential-store",
            "file",
        ]
        .map(String::from)
        .into();
        let parsed = deploy_args(&args).unwrap();
        assert_eq!(parsed.name.as_deref(), Some("rio"));
        assert_eq!(parsed.runner, Some(deployment::Runner::SelfHosted));
        assert!(deploy_args(&["review".to_owned()]).is_err());
    }

    #[test]
    fn failure_and_result_values_are_what_the_screens_read() {
        let dir = tempfile::tempdir().unwrap();
        let deployer = Deployer::at(
            dir.path().into(),
            DeployArgs::default(),
            false,
            false,
            Arc::new(|_| {}),
        )
        .unwrap();
        let stopped = Stopped {
            step: "sandbox-rollout",
            error: anyhow::anyhow!(
                "Cloudflare /accounts/a/containers/applications failed (HTTP 400, API codes: 1)"
            ),
        };
        let update: rio_tui::init::FailureUpdate =
            serde_json::from_value(failed(&deployer, &stopped)).unwrap();
        let failure = rio_tui::init::FailureData::from(update);
        assert_eq!(failure.step, "sandbox-rollout");
        assert_eq!(failure.error.request, "/accounts/a/containers/applications");
        assert!(failure.fixes.iter().any(|f| f.key == Some('s')));
        let done: rio_tui::init::DeployedData =
            serde_json::from_value(deployed(&deployer)).unwrap();
        assert_eq!(done.artifacts[0].label, "config");
    }

    fn data() -> InitData {
        InitData {
            version: "0.1.0".into(),
            config_dir: "~/.config/rio".into(),
            preflight: Vec::new(),
            existing: "no deployment yet".into(),
            pending: None,
            configure: ConfigureData {
                accounts: Vec::new(),
                account: 0,
                name: "rio".into(),
                runner: Runner::SelfHosted,
                runner_image: String::new(),
                provider: Provider::OpenRouter,
                env_keys: Vec::new(),
                credential_store: CredentialStore::File,
                subdomain: None,
                scopes: Vec::new(),
                plan: None,
            },
            connect: ConnectData {
                url: String::new(),
                source: TokenSource::Stdin,
                env_token: false,
            },
            handoff: Handoff::default(),
        }
    }

    #[test]
    fn connecting_from_the_screen_writes_what_rio_init_endpoint_token_stdin_writes() {
        use ratatui::crossterm::event::{KeyCode, KeyEvent};
        let (ui, cli) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let (url, token) = ("https://rio.example.test", "tok-0123456789abcdef0123456789");
        let data = data();
        let mut app = rio_tui::App::new(
            Box::new(rio_tui::init::ConnectExisting::new(data.clone())),
            rio_tui::Theme::select(true, true),
        );
        let mut press = |code| app.update(Msg::Key(KeyEvent::from(code)));
        for ch in url.chars() {
            press(KeyCode::Char(ch));
        }
        press(KeyCode::Tab);
        press(KeyCode::Tab);
        for ch in token.chars() {
            press(KeyCode::Char(ch));
        }
        let effects = press(KeyCode::Enter);
        assert_eq!(
            effects,
            vec![Effect::Start(
                ["init", "--endpoint", url, "--token-stdin"]
                    .map(String::from)
                    .into()
            )]
        );
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let (reply, messages) = std::sync::mpsc::channel();
        let mut host = InitHost::new(
            runtime.handle().clone(),
            reply.clone(),
            data.handoff.clone(),
        );
        host.directory = ui.path().into();
        for effect in effects {
            rio_tui::terminal::Host::run(&mut host, effect, &reply);
        }
        let Msg::Done(Outcome::Ok(text)) = messages.recv().unwrap() else {
            panic!("connected");
        };
        assert!(!text.contains(token));
        assert!(
            data.handoff.secret_name().is_none(),
            "the token is taken once"
        );
        crate::connect_endpoint_in(cli.path(), url.into(), Some(token.into())).unwrap();
        for file in ["config.toml", "credentials"] {
            assert_eq!(
                std::fs::read(ui.path().join(file)).unwrap(),
                std::fs::read(cli.path().join(file)).unwrap(),
                "{file}"
            );
        }
        assert_eq!(
            *host.ended.lock().unwrap(),
            Ended::Connected(ui.path().join("config.toml").display().to_string())
        );
    }
}

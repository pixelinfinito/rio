mod config;
mod deployment;
mod endpoint;
use clap::{Args, Parser, Subcommand, ValueEnum};
use config::MachineConfig;
use rio_adapters::{ProcessSupervisor, ToolResolver};
use rio_core::*;
use rio_engine::{PlanRequest, ReviewRequest, plan_review_with_progress, profile_excludes, review};
use rio_git::{GixRepo, Repo, Selection, diff, select};
use rio_profile::{ProfileLoader, ProfileSource};
use serde_json::json;
use std::{
    io::{self, IsTerminal, Write},
    path::PathBuf,
    process::ExitCode,
};
use tokio_util::sync::CancellationToken;

#[derive(Parser)]
#[command(name="rio", about="Review local code changes with deterministic evidence", version=concat!(env!("RIO_VERSION"), " ", env!("RIO_TARGET"), " ", env!("RIO_COMMIT")))]
struct Cli {
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    Review(ReviewArgs),
    Profile {
        #[command(subcommand)]
        command: ProfileCommand,
    },
    Doctor(DoctorArgs),
    Init {
        #[arg(long, conflicts_with_all = ["from", "account", "name", "cf_profile", "runner", "runner_image", "workers_subdomain", "credential_store", "secrets_file", "dry_run"])]
        endpoint: Option<String>,
        #[arg(long, requires = "endpoint")]
        token_stdin: bool,
        #[command(flatten)]
        deployment: deployment::DeployArgs,
    },
    Deploy(deployment::DeployArgs),
}
#[derive(Clone, Copy, Default, ValueEnum, PartialEq, Eq)]
enum Format {
    #[default]
    Terminal,
    Json,
    Md,
}
#[derive(Args, Default)]
struct SelectionArgs {
    #[arg(
        long,
        conflicts_with = "base",
        help = "Review only staged changes; selection flags are mutually exclusive"
    )]
    staged: bool,
    #[arg(
        long,
        value_name = "REF",
        help = "Review HEAD against its merge base with REF"
    )]
    base: Option<String>,
}
impl SelectionArgs {
    fn selection(&self) -> Selection {
        if self.staged {
            Selection::Staged
        } else if let Some(reference) = &self.base {
            Selection::Branch {
                reference: reference.clone(),
            }
        } else {
            Selection::WorkingTree
        }
    }
}
#[derive(Args)]
struct ReviewArgs {
    #[command(flatten)]
    selection: SelectionArgs,
    #[arg(long)]
    profile: Option<String>,
    #[arg(long, value_enum, default_value = "terminal")]
    format: Format,
    #[arg(long)]
    offline: bool,
    #[arg(long)]
    no_color: bool,
    #[arg(long)]
    show_pre_existing: bool,
    #[arg(long)]
    pr: Option<String>,
    #[arg(long)]
    deep: bool,
    #[arg(long, value_enum, conflicts_with = "deep")]
    preset: Option<Preset>,
    #[arg(long)]
    fork: bool,
    #[arg(long)]
    publish: bool,
    #[arg(long)]
    since_last: bool,
}
#[derive(Clone, Copy, ValueEnum)]
enum Preset {
    Quick,
    Standard,
    Deep,
}
#[derive(Subcommand)]
enum ProfileCommand {
    List,
    Show {
        reference: String,
        #[arg(long)]
        raw: bool,
    },
    Validate {
        reference: Option<String>,
    },
}
#[derive(Args)]
struct DoctorArgs {
    /// Inspect every detected project, including roots outside the current diff.
    #[arg(long)]
    all_roots: bool,
    #[command(flatten)]
    selection: SelectionArgs,
    #[arg(long, value_enum, default_value = "terminal")]
    format: DoctorFormat,
}
#[derive(Clone, Copy, ValueEnum, PartialEq, Eq)]
enum DoctorFormat {
    Terminal,
    Json,
}
// The coordinator awaits external tools; avoid one runtime worker per host CPU
// when many reviews or worktrees run concurrently.
#[tokio::main(worker_threads = 2)]
async fn main() -> ExitCode {
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(error) => {
            let code = if error.use_stderr() { 2 } else { 0 };
            let _ = error.print();
            return ExitCode::from(code);
        }
    };
    let code = match cli.command {
        Command::Review(args) => run_review(args).await,
        Command::Profile { command } => run_profile(command),
        Command::Doctor(args) => run_doctor(args).await,
        Command::Init {
            endpoint,
            token_stdin,
            deployment,
        } => {
            if let Some(endpoint) = endpoint {
                run_init(endpoint, token_stdin)
            } else {
                run_deploy(deployment).await
            }
        }
        Command::Deploy(args) => run_deploy(args).await,
    };
    ExitCode::from(code)
}
async fn run_deploy(args: deployment::DeployArgs) -> u8 {
    match deployment::run(args).await {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("Deployment failed: {error:#}");
            3
        }
    }
}
fn write_stdout(bytes: &[u8]) -> io::Result<()> {
    let stdout = io::stdout();
    let mut output = stdout.lock();
    output.write_all(bytes)?;
    output.flush()
}
fn error_report(format: Format, code: u8, name: &str, message: String, details: Vec<String>) -> u8 {
    eprintln!("{}", redact(&message));
    if format == Format::Json {
        let mut report = Report::empty(ReportStatus::Error);
        report.error = Some(ReportError {
            code: name.into(),
            message,
            details,
        });
        match render_json(&report) {
            Ok(bytes) => {
                if let Err(error) = write_stdout(&bytes) {
                    eprintln!("{error}");
                }
            }
            Err(error) => eprintln!("Could not render error report: {error}"),
        }
    }
    code
}
fn current_dir() -> anyhow::Result<PathBuf> {
    Ok(std::env::current_dir()?)
}
fn loader(root: Option<PathBuf>, config: &MachineConfig, cwd: PathBuf) -> ProfileLoader {
    ProfileLoader::new(root, config.config_dir.clone(), cwd)
}
async fn run_review(args: ReviewArgs) -> u8 {
    for (flag, present) in [
        ("--pr", args.pr.is_some()),
        ("--publish", args.publish),
        ("--since-last", args.since_last),
    ] {
        if present {
            return error_report(
                args.format,
                2,
                "endpoint_required",
                format!("{flag} is not implemented by the current endpoint protocol"),
                Vec::new(),
            );
        }
    }
    let cwd = match current_dir() {
        Ok(cwd) => cwd,
        Err(error) => {
            return error_report(
                args.format,
                3,
                "internal_error",
                error.to_string(),
                Vec::new(),
            );
        }
    };
    // Resolve user-only machine configuration before touching repository inputs.
    let preliminary = match MachineConfig::load(&cwd) {
        Ok(config) => config,
        Err(error) => {
            return error_report(
                args.format,
                2,
                "invalid_configuration",
                format!("{error:#}"),
                Vec::new(),
            );
        }
    };
    let repo = match GixRepo::discover(&cwd) {
        Ok(repo) => repo,
        Err(error) => {
            return error_report(
                args.format,
                3,
                "not_a_repository",
                format!("{error:#}"),
                Vec::new(),
            );
        }
    };
    let config = match MachineConfig::load(repo.root()) {
        Ok(config) => config,
        Err(error) => {
            return error_report(
                args.format,
                2,
                "invalid_configuration",
                format!("{error:#}"),
                Vec::new(),
            );
        }
    };
    drop(preliminary);
    for notice in &config.notices {
        eprintln!("{notice}");
    }
    let preset = if args.deep {
        Some(rio_profile::Posture::Thorough)
    } else {
        args.preset.map(|preset| match preset {
            Preset::Quick => rio_profile::Posture::CriticalOnly,
            Preset::Standard => rio_profile::Posture::Balanced,
            Preset::Deep => rio_profile::Posture::Thorough,
        })
    };
    if (args.deep || args.preset.is_some()) && (config.endpoint_url.is_none() || args.offline) {
        return error_report(
            args.format,
            2,
            "endpoint_required",
            "--deep/--preset require a configured endpoint and online mode".into(),
            Vec::new(),
        );
    }
    // Local reviews execute repository commands on the host; refuse rather than
    // silently run untrusted fork code.
    if args.fork && (config.endpoint_url.is_none() || args.offline) {
        return error_report(
            args.format,
            2,
            "endpoint_required",
            "--fork requires a configured endpoint and online mode; local reviews execute repository commands".into(),
            Vec::new(),
        );
    }
    let profile = match loader(Some(repo.root().into()), &config, cwd)
        .load_with_preset(args.profile.as_deref(), preset)
    {
        Ok(profile) => profile,
        Err(error) => {
            return error_report(
                args.format,
                2,
                "invalid_profile",
                error.to_string(),
                error.to_string().lines().map(str::to_owned).collect(),
            );
        }
    };
    for warning in &profile.warnings {
        if config.endpoint_url.is_some()
            && !args.offline
            && (warning.message.contains("no_endpoint")
                || warning.message.starts_with("posture, max_defects"))
        {
            continue;
        }
        eprintln!("Warning: {warning}");
    }
    let changes = match select(&repo, args.selection.selection()) {
        Ok(changes) => changes,
        Err(error) => {
            let message = format!("{error:#}");
            let name = message
                .split(':')
                .next()
                .unwrap_or("repository_error")
                .to_owned();
            return error_report(args.format, 3, &name, message, Vec::new());
        }
    };
    let remote_request = if !args.offline {
        config
            .endpoint_url
            .as_ref()
            .map(|url| endpoint::EndpointRequest {
                url,
                config_dir: &config.config_dir,
                changes: changes.clone(),
                profile: profile.clone(),
                cache: config.cache.clone(),
                deep: args.deep || matches!(args.preset, Some(Preset::Deep)),
                fork: args.fork,
            })
    } else {
        None
    };
    let working = match repo.working_tree() {
        Ok(tree) => tree,
        Err(error) => {
            return error_report(
                args.format,
                3,
                "repository_error",
                format!("{error:#}"),
                Vec::new(),
            );
        }
    };
    let policy = profile
        .profile
        .fail_on
        .compile()
        .expect("validated fail_on");
    let supervisor = ProcessSupervisor::default();
    let cancellation = CancellationToken::new();
    let signal_cancel = cancellation.clone();
    let signal_supervisor = supervisor.clone();
    let signals = tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            signal_cancel.cancel();
            eprintln!("Interrupted; stopping checks and preserving partial results…");
            if tokio::signal::ctrl_c().await.is_ok() {
                signal_supervisor.kill_all();
                std::process::exit(130);
            }
        }
    });
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    let format = args.format;
    let progress = tokio::spawn(async move {
        while let Some(event) = receiver.recv().await {
            if let Some(text) = render_progress(&event) {
                if format == Format::Terminal {
                    let _ = write_stdout(format!("{text}\n").as_bytes());
                } else {
                    eprintln!("{text}");
                }
            }
        }
    });
    let result = if let Some(request) = remote_request {
        endpoint::review(request, cancellation.clone()).await
    } else {
        review(
            ReviewRequest {
                worktree: repo.root().into(),
                working,
                changes,
                profile,
                cache: config.cache,
                parallelism: config.parallelism,
                output_limit: config.output_limit,
                offline: args.offline,
            },
            supervisor,
            cancellation,
            Some(sender.clone()),
        )
        .await
    };
    drop(sender);
    let _ = progress.await;
    let report = match result {
        Ok(report) => report,
        Err(error) => {
            signals.abort();
            return error_report(
                args.format,
                3,
                "internal_error",
                format!("{error:#}"),
                Vec::new(),
            );
        }
    };
    if report.status == ReportStatus::NoChanges && args.format == Format::Json {
        eprintln!("No changes to review");
    }
    let width = std::env::var("COLUMNS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(80);
    let options = RenderOptions {
        width,
        color: io::stdout().is_terminal() && !args.no_color,
        show_pre_existing: args.show_pre_existing,
        policy: Some(&policy),
    };
    let output = match args.format {
        Format::Json => render_json(&report),
        Format::Md => Ok(render_markdown(&report, &options).into_bytes()),
        Format::Terminal => Ok(render_terminal(&report, &options).into_bytes()),
    };
    let code = match output {
        Ok(bytes) => match write_stdout(&bytes) {
            Ok(()) => exit_code(&report, &policy, ExitContext::default()),
            Err(error) => {
                eprintln!("{error}");
                3
            }
        },
        Err(error) => error_report(args.format, 3, "invalid_report", error, Vec::new()),
    };
    signals.abort();
    code
}
fn run_profile(command: ProfileCommand) -> u8 {
    let result = (|| -> anyhow::Result<()> {
        let cwd = current_dir()?;
        let root = GixRepo::discover(&cwd)
            .ok()
            .map(|repo| repo.root().to_owned());
        let config = MachineConfig::load(root.as_deref().unwrap_or(&cwd))?;
        let loader = loader(root, &config, cwd);
        match command {
            ProfileCommand::List => {
                for profile in loader.list()? {
                    let source = match &profile.source {
                        ProfileSource::BuiltIn(_) => "built-in",
                        ProfileSource::Repo(_) => "repo",
                        ProfileSource::Personal(_) => "personal",
                        ProfileSource::File(_) => "file",
                    };
                    println!(
                        "{}{} [{}] {}{}",
                        if profile.is_default { "* " } else { "  " },
                        profile.name,
                        source,
                        profile.source.label(),
                        profile
                            .extends
                            .map(|parent| format!(" extends {parent}"))
                            .unwrap_or_default()
                    );
                }
            }
            ProfileCommand::Show { reference, raw } => {
                let profile = loader.load(Some(&reference))?;
                println!(
                    "# Source: {}\n# Chain: {}",
                    profile
                        .sources
                        .first()
                        .map(|s| s.label())
                        .unwrap_or_default(),
                    profile.chain.join(" -> ")
                );
                if raw {
                    print!("{}", loader.discover(Some(&reference))?.read()?);
                } else {
                    print!("{}", profile.to_yaml()?);
                }
            }
            ProfileCommand::Validate { reference } => {
                let profile = loader.load(reference.as_deref())?;
                println!("Valid: {}", profile.profile.name);
                for warning in profile.warnings {
                    eprintln!("Warning: {warning}");
                }
            }
        }
        Ok(())
    })();
    match result {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("{}", redact(&format!("{error:#}")));
            2
        }
    }
}
async fn run_doctor(args: DoctorArgs) -> u8 {
    let mut problems = Vec::<String>::new();
    let mut warnings = Vec::<String>::new();
    let mut document = json!({"repository":null,"head":null,"profile":null,"configuration":null,"cache":null,"plan":null});
    let cwd = match current_dir() {
        Ok(cwd) => cwd,
        Err(error) => {
            eprintln!("{error}");
            return 1;
        }
    };
    let repo = match GixRepo::discover(&cwd) {
        Ok(repo) => Some(repo),
        Err(error) => {
            problems.push(format!("{error:#}"));
            None
        }
    };
    let root = repo.as_ref().map(|r| r.root()).unwrap_or(&cwd);
    let config = match MachineConfig::load(root) {
        Ok(config) => Some(config),
        Err(error) => {
            problems.push(format!("{error:#}"));
            None
        }
    };
    if let Some(config) = &config {
        document["configuration"] = serde_json::to_value(config).unwrap();
        warnings.extend(config.notices.clone());
        let cache_result = (|| -> anyhow::Result<u64> {
            rio_git::private_directory(&config.cache.dir)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                anyhow::ensure!(
                    std::fs::metadata(&config.cache.dir)?.permissions().mode() & 0o222 != 0,
                    "cache directory has no write permissions"
                );
            }
            let mut file = tempfile::tempfile_in(&config.cache.dir)?;
            file.write_all(b"rio doctor")?;
            file.sync_all()?;
            Ok(fs4::available_space(&config.cache.dir)?)
        })();
        match cache_result {
            Ok(space) => {
                document["cache"] =
                    json!({"path":config.cache.dir,"writable":true,"free_space":space})
            }
            Err(error) => {
                let message = format!(
                    "Cache {} is not writable: {error:#}",
                    config.cache.dir.display()
                );
                problems.push(message.clone());
                document["cache"] =
                    json!({"path":config.cache.dir,"writable":false,"error":message});
            }
        }
        match loader(repo.as_ref().map(|r| r.root().into()), config, cwd.clone()).load(None) {
            Err(error) => problems.push(error.to_string()),
            Ok(profile) => {
                document["profile"] =
                    json!({"name":profile.profile.name,"valid":true,"chain":profile.chain});
                warnings.extend(profile.warnings.iter().map(ToString::to_string));
                if let Some(repo) = &repo {
                    document["repository"] = json!(repo.root());
                    document["head"] = json!(repo.head_id().ok().flatten());
                    let result = async {
                        let changes = select(repo, args.selection.selection())?;
                        // Full-repository readiness probes are explicitly opt-in.
                        let delta = if args.all_roots {
                            // Use an empty base only to discover every head root.
                            // Dependency planning must retain the selected real base.
                            let mut discovery = changes.clone();
                            discovery.base = rio_git::Tree::new();
                            diff(&discovery, &profile_excludes(&profile))?
                        } else {
                            diff(&changes, &profile_excludes(&profile))?
                        };
                        let working = repo.working_tree()?;
                        let resolver = ToolResolver::from_environment(repo.root().into());
                        plan_review_with_progress(
                            PlanRequest {
                                worktree: repo.root(),
                                working: &working,
                                changes: &changes,
                                diff: &delta,
                                profile: &profile,
                                resolver: &resolver,
                            },
                            &ProcessSupervisor::default(),
                            CancellationToken::new(),
                            &|root| eprintln!("Checking root {root}..."),
                        )
                        .await
                    }
                    .await;
                    match result {
                        Ok(plan) => {
                            for check in &plan.checks {
                                if let Some(outcome) = &check.skip
                                    && !matches!(
                                        outcome,
                                        CheckOutcome::Skipped {
                                            reason: SkipReason::Disabled,
                                            ..
                                        }
                                    )
                                {
                                    warnings.push(format!(
                                        "{} {} would skip: {} — {}",
                                        label(&check.kind),
                                        check.root,
                                        outcome_label(outcome),
                                        outcome.details().hint.as_deref().unwrap_or("")
                                    ));
                                }
                            }
                            document["plan"] = serde_json::to_value(plan).unwrap();
                        }
                        Err(error) => problems.push(format!("{error:#}")),
                    }
                }
            }
        }
    }
    document["endpoint"] = json!(config.as_ref().and_then(|c| c.endpoint_url.as_ref()));
    document["blocking_problems"] = json!(problems);
    document["warnings"] = json!(warnings);
    if args.format == DoctorFormat::Json {
        println!(
            "{}",
            redact(&serde_json::to_string_pretty(&document).unwrap())
        );
    } else {
        println!(
            "Rio doctor\n{}",
            redact(&serde_json::to_string_pretty(&document).unwrap())
        );
    }
    if problems.is_empty() { 0 } else { 1 }
}

fn run_init(endpoint: String, token_stdin: bool) -> u8 {
    let result = (|| -> anyhow::Result<()> {
        use std::io::Read;
        let directory = config::config_directory()?;
        rio_git::private_directory(&directory)?;
        let file = directory.join("config.toml");
        let mut document: toml::Value = match std::fs::read_to_string(&file) {
            Ok(text) => toml::from_str(&text)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                toml::Value::Table(Default::default())
            }
            Err(error) => return Err(error.into()),
        };
        let token = if token_stdin {
            let mut value = String::new();
            std::io::stdin().take(65536).read_to_string(&mut value)?;
            Some(value.trim().to_owned())
        } else {
            None
        };
        let previous_endpoint = document
            .get("endpoint")
            .and_then(|e| e.get("url"))
            .and_then(toml::Value::as_str)
            .map(str::to_owned);
        let _ = rio_client::Client::new(
            &endpoint,
            token
                .clone()
                .unwrap_or_else(|| "validation-token-for-endpoint-only".into()),
        )?;
        document
            .as_table_mut()
            .ok_or_else(|| anyhow::anyhow!("configuration must be a TOML table"))?
            .insert(
                "endpoint".into(),
                toml::Value::Table(
                    [(String::from("url"), toml::Value::String(endpoint))]
                        .into_iter()
                        .collect(),
                ),
            );
        // Explicit endpoint connection uses the supplied client credential, rather
        // than a keychain secret associated with a previously managed deployment.
        document.as_table_mut().unwrap().remove("deployment");
        if previous_endpoint.as_deref()
            != document
                .get("endpoint")
                .and_then(|e| e.get("url"))
                .and_then(toml::Value::as_str)
        {
            match std::fs::remove_file(directory.join("credentials")) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        rio_engine::atomic_write(&file, toml::to_string_pretty(&document)?.as_bytes())?;
        if let Some(token) = token {
            rio_engine::atomic_write(&directory.join("credentials"), token.as_bytes())?;
        }
        eprintln!("Rio endpoint configured in {}", file.display());
        Ok(())
    })();
    match result {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("{error:#}");
            2
        }
    }
}

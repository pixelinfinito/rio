mod config;
mod deployment;
mod endpoint;
mod github_app;
mod lineage;
mod prepare;
mod providers;
mod pull;
mod registry;
use anyhow::Context;
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
        #[arg(long, conflicts_with_all = ["from", "account", "name", "cf_profile", "runner", "runner_image", "workers_subdomain", "credential_store", "secrets_file", "custom_providers", "default_model", "verifier_model", "dry_run", "github_app", "github_org", "replace_private_key"])]
        endpoint: Option<String>,
        #[arg(long, requires = "endpoint")]
        token_stdin: bool,
        /// Register a GitHub App for PR mode after deploying (skippable; replayed by --from).
        #[arg(long)]
        github_app: bool,
        /// Register the app under this GitHub organization instead of your account.
        #[arg(long, value_name = "ORG")]
        github_org: Option<String>,
        /// Store a new private key (PEM file) for the registered app on the endpoint.
        #[arg(long, value_name = "PEM")]
        replace_private_key: Option<PathBuf>,
        #[command(flatten)]
        deployment: deployment::DeployArgs,
    },
    Deploy(deployment::DeployArgs),
    /// Answer a posted finding through the configured endpoint.
    Feedback(FeedbackArgs),
    /// List the repository's finding registry held by the endpoint.
    Findings(registry::FindingsArgs),
    /// List, apply or decline suppression proposals from repeated dismissals.
    Suppressions {
        #[command(subcommand)]
        command: registry::SuppressionsCommand,
    },
    /// Internal: hosted preparation of a pull request review (runner only).
    #[command(hide = true)]
    Prepare(prepare::PrepareArgs),
    /// Run the evaluation harness (requires python3 and Rio's `eval/` directory).
    Eval {
        #[command(subcommand)]
        command: EvalCommand,
    },
}
#[derive(Subcommand)]
enum EvalCommand {
    /// Review known-clean PRs and write noise adjudication skeletons and a summary.
    Noise {
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
    /// Turn a PR and the PR that fixed it into a labeled incident case.
    ImportIncident {
        pr: String,
        fix_pr: String,
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
}
#[derive(Args)]
struct FeedbackArgs {
    /// Finding id (as shown in the report).
    id: String,
    /// Dismiss the finding with a reason: fixed, wrong, intentional, irrelevant or style.
    #[arg(long, value_name = "REASON")]
    dismiss: String,
    /// Free-text note recorded with the response.
    #[arg(long, value_name = "TEXT")]
    note: Option<String>,
}
#[derive(Clone, Copy, Default, ValueEnum, PartialEq, Eq)]
enum Format {
    #[default]
    Terminal,
    Json,
    Md,
    Sarif,
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
    /// List findings remembered as dismissed on unchanged code in their own section.
    #[arg(long)]
    show_remembered: bool,
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
    /// Review the current branch as a lineage held by the endpoint.
    #[arg(long)]
    since_last: bool,
    /// Start a new lineage generation at round 1 (requires --since-last).
    #[arg(long, requires = "since_last")]
    reset_lineage: bool,
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
    /// Rotate the GitHub App webhook secret on the app and the endpoint.
    #[arg(long)]
    rotate: bool,
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
            github_app,
            github_org,
            replace_private_key,
            deployment,
        } => {
            if let Some(endpoint) = endpoint {
                run_init(endpoint, token_stdin)
            } else {
                let dry_run = deployment.dry_run;
                let replay = deployment.from.is_some();
                match run_deploy(deployment).await {
                    0 if !dry_run => {
                        run_github_app_step(github_app, github_org, replace_private_key, replay)
                            .await
                    }
                    code => code,
                }
            }
        }
        Command::Deploy(args) => run_deploy(args).await,
        Command::Feedback(args) => run_feedback(args).await,
        Command::Findings(args) => registry::findings(args).await,
        Command::Suppressions { command } => registry::suppressions(command).await,
        Command::Prepare(args) => prepare::run(args).await,
        Command::Eval { command } => run_eval(command),
    };
    ExitCode::from(code)
}
/// The harness is Python in Rio's source tree. `RIO_EVAL_DIR` points at it;
/// otherwise the current repository's `eval/` is used when it is Rio's harness.
fn eval_dir() -> Option<PathBuf> {
    std::env::var_os("RIO_EVAL_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            let cwd = std::env::current_dir().ok()?;
            let root = GixRepo::discover(&cwd).ok()?.root().to_path_buf();
            Some(root.join("eval"))
        })
        .filter(|dir| dir.join("noise.py").is_file() && dir.join("incident.py").is_file())
}
fn run_eval(command: EvalCommand) -> u8 {
    let Some(dir) = eval_dir() else {
        eprintln!(
            "rio eval requires Rio's evaluation harness: run it inside the Rio source tree or set RIO_EVAL_DIR to its eval/ directory"
        );
        return 2;
    };
    let (script, args) = match command {
        EvalCommand::Noise { args } => ("noise.py", [vec!["run".into()], args].concat()),
        EvalCommand::ImportIncident { pr, fix_pr, args } => {
            ("incident.py", [vec![pr, fix_pr], args].concat())
        }
    };
    // Isolated mode: the harness never imports modules from the working directory.
    match std::process::Command::new("python3")
        .arg("-I")
        .arg(dir.join(script))
        .args(args)
        .status()
    {
        Ok(status) => status.code().map_or(3, |code| code.clamp(0, 255) as u8),
        Err(error) => {
            eprintln!("could not start python3: {error}");
            3
        }
    }
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
pub(crate) fn write_stdout(bytes: &[u8]) -> io::Result<()> {
    let stdout = io::stdout();
    let mut output = stdout.lock();
    output.write_all(bytes)?;
    output.flush()
}
/// RFC 3339 UTC time with second precision, as SARIF invocations record it.
fn utc_now() -> String {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs()) as i64;
    let (days, time) = (seconds.div_euclid(86400), seconds.rem_euclid(86400));
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        time / 3600,
        time % 3600 / 60,
        time % 60
    )
}
fn sarif_inputs(start: String, exit_code: u8, include_pre_existing: bool) -> SarifInputs {
    SarifInputs {
        start_time_utc: start,
        end_time_utc: utc_now(),
        exit_code: Some(exit_code),
        include_pre_existing,
    }
}
fn error_report(format: Format, code: u8, name: &str, message: String, details: Vec<String>) -> u8 {
    eprintln!("{}", redact(&message));
    if matches!(format, Format::Json | Format::Sarif) {
        let mut report = Report::empty(ReportStatus::Error);
        report.error = Some(ReportError {
            code: name.into(),
            message,
            details,
        });
        let now = utc_now();
        let rendered = if format == Format::Sarif {
            render_sarif(&report, &sarif_inputs(now, code, false))
        } else {
            render_json(&report)
        };
        match rendered {
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
    let started = utc_now();
    // A pull request is prepared and reviewed by the endpoint, never locally.
    if args.pr.is_some() || args.publish {
        return pull::review(args, started).await;
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
    if args.since_last && (config.endpoint_url.is_none() || args.offline) {
        return error_report(
            args.format,
            2,
            "endpoint_required",
            "--since-last requires a configured endpoint and online mode; the endpoint holds the lineage".into(),
            Vec::new(),
        );
    }
    let lineage = if args.since_last {
        let branch = match repo.branch() {
            Ok(Some(branch)) => branch,
            Ok(None) => {
                return error_report(
                    args.format,
                    2,
                    "branch_required",
                    "--since-last reviews a branch lineage: a branch is required, but HEAD is detached".into(),
                    Vec::new(),
                );
            }
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
        match lineage::repository_key(repo.root(), repo.remote_url("origin").as_deref()) {
            Ok(repository) => Some(lineage::BranchLineage {
                repository,
                branch,
                reset: args.reset_lineage,
            }),
            Err(error) => {
                return error_report(
                    args.format,
                    3,
                    "repository_error",
                    format!("{error:#}"),
                    Vec::new(),
                );
            }
        }
    } else {
        None
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
                repository: match &lineage {
                    Some(lineage) => Some(lineage.repository.clone()),
                    None => {
                        lineage::repository_key(repo.root(), repo.remote_url("origin").as_deref())
                            .ok()
                    }
                },
                lineage: lineage.clone(),
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
    let mut posted = None;
    let result = if let Some(request) = remote_request {
        endpoint::review(request, cancellation.clone())
            .await
            .map(|outcome| {
                posted = outcome.posted;
                outcome.report
            })
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
    if report.status == ReportStatus::NoChanges
        && matches!(args.format, Format::Json | Format::Sarif)
    {
        eprintln!("No changes to review");
    }
    let code = render(report, &args, started, &policy, posted.as_ref());
    signals.abort();
    code
}
/// Renders a finished review in the requested format; returns the exit code.
fn render_and_exit(
    report: Report,
    args: &ReviewArgs,
    started: String,
    policy: &CompiledFailOn,
) -> u8 {
    render(report, args, started, policy, None)
}
fn render(
    report: Report,
    args: &ReviewArgs,
    started: String,
    policy: &CompiledFailOn,
    posted: Option<&std::collections::BTreeSet<String>>,
) -> u8 {
    let width = std::env::var("COLUMNS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(80);
    let options = RenderOptions {
        width,
        color: io::stdout().is_terminal() && !args.no_color,
        show_pre_existing: args.show_pre_existing,
        show_remembered: args.show_remembered,
        policy: Some(policy),
        posted,
    };
    // SARIF records the exit code, so it is decided before rendering.
    let exit = exit_code(&report, policy, ExitContext::default());
    let output = match args.format {
        Format::Json => render_json(&report),
        Format::Sarif => render_sarif(
            &report,
            &sarif_inputs(started, exit, args.show_pre_existing),
        ),
        Format::Md => Ok(render_markdown(&report, &options).into_bytes()),
        Format::Terminal => Ok(render_terminal(&report, &options).into_bytes()),
    };
    match output {
        Ok(bytes) => match write_stdout(&bytes) {
            Ok(()) => exit,
            Err(error) => {
                eprintln!("{error}");
                3
            }
        },
        Err(error) => error_report(args.format, 3, "invalid_report", error, Vec::new()),
    }
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
/// `rio init`'s GitHub App step (docs/github-app.md): register through the
/// manifest flow, or replace the private key of the registered app.
async fn run_github_app_step(
    flag: bool,
    organization: Option<String>,
    replace_key: Option<PathBuf>,
    replay: bool,
) -> u8 {
    let result = async {
        let directory = config::config_directory()?;
        let mut deployment =
            deployment::choices(&deployment::DeployArgs::default(), &directory)?;
        let config = MachineConfig::load(&directory)?;
        let endpoint = config
            .endpoint_url
            .clone()
            .context("the deployment did not record an endpoint")?;
        let wanted = replace_key.is_some()
            || github_app::wanted(
                flag,
                replay,
                deployment.github_app,
                config.github_app.is_some(),
                io::stdin().is_terminal(),
                || {
                    eprint!("Register a GitHub App for pull request reviews (PR mode)? [y/N] ");
                    let _ = io::stderr().flush();
                    let mut answer = String::new();
                    io::stdin().read_line(&mut answer).is_ok()
                        && matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes")
                },
            );
        if !wanted {
            eprintln!("GitHub App step skipped; CLI reviews work without it (rio init --github-app adds it later).");
            return Ok(());
        }
        let cf = deployment::Cloudflare::new(deployment::authentication(&deployment.cf_profile).await?)?;
        if let Some(path) = replace_key {
            let pem = std::fs::read_to_string(&path)
                .with_context(|| format!("reading {}", path.display()))?;
            anyhow::ensure!(
                pem.contains("PRIVATE KEY-----"),
                "{} is not a PEM private key",
                path.display()
            );
            github_app::put_secret(&cf, &deployment, "GITHUB_APP_PRIVATE_KEY", pem.trim()).await?;
            eprintln!("Stored the new GitHub App private key on the endpoint; confirm with rio doctor, then delete the old key on GitHub.");
            return Ok(());
        }
        if let Some(record) = &config.github_app {
            // A replay on a new machine keeps the registered app and its secrets.
            let client = endpoint::client(&endpoint, &config.config_dir)?;
            let status = client.github_installation("github.com/rio/probe").await;
            if status.is_ok_and(|s| s["configured"] == true) {
                eprintln!(
                    "GitHub App {} is already registered and configured on the endpoint; install it at {}",
                    record.slug, record.installation_url
                );
                return Ok(());
            }
        }
        let record = github_app::register(
            &cf,
            &deployment,
            &endpoint,
            organization.as_deref().or(deployment.github_org.as_deref()),
            &github_app::GitHubUrls::from_environment(),
            &github_app::open_browser,
        )
        .await?;
        github_app::save_record(&directory, &record)?;
        deployment.github_app = true;
        if organization.is_some() {
            deployment.github_org = organization;
        }
        deployment::save_deployment(&directory, &deployment)?;
        eprintln!(
            "GitHub App {} registered (id {}); its secrets are stored on the endpoint only.\nInstall it on your repositories: {}",
            record.slug, record.app_id, record.installation_url
        );
        anyhow::Ok(())
    }
    .await;
    match result {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("GitHub App step failed: {}", redact(&format!("{error:#}")));
            3
        }
    }
}
/// The endpoint's GitHub App state for doctor; warnings never change the exit code.
async fn endpoint_diagnostics(
    config: &MachineConfig,
    url: &str,
    repository: Option<String>,
    publish: Option<String>,
    warnings: &mut Vec<String>,
) -> serde_json::Value {
    let mut section = json!({"url": url, "publish_policy": publish});
    let client = match endpoint::client(url, &config.config_dir) {
        Ok(client) => client,
        Err(error) => {
            warnings.push(format!("Endpoint credentials unavailable: {error:#}"));
            return section;
        }
    };
    match client.health().await {
        Ok(health) => {
            section["version"] = health["version"].clone();
            section["paired"] = json!(health["protocol"] == 1);
            if health["protocol"] != 1 {
                warnings.push(
                    "The endpoint speaks another protocol version; redeploy it with rio deploy"
                        .into(),
                );
            }
        }
        Err(error) => warnings.push(format!("Endpoint unreachable: {error:#}")),
    }
    let Some(repository) = repository.filter(|r| r.starts_with("github.com/")) else {
        return section;
    };
    match client.github_installation(&repository).await {
        Ok(status) => {
            section["github_app"] = json!({"configured": status["configured"], "installed": status["installed"], "repository": repository});
            if status["configured"] != true {
                warnings.push("No GitHub App is configured on the endpoint; PR mode needs rio init --github-app".into());
            } else if status["installed"] != true {
                let url = config
                    .github_app
                    .as_ref()
                    .map(|app| app.installation_url.clone())
                    .unwrap_or_else(|| "https://github.com/settings/installations".into());
                warnings.push(format!(
                    "The GitHub App is not installed on {repository}; install it at {url}"
                ));
            }
        }
        Err(error) if rio_client::http_status(&error) == Some(404) => {
            section["github_app"] =
                json!({"configured": null, "installed": null, "repository": repository});
            warnings.push(
                "The endpoint does not report GitHub App state; redeploy it with rio deploy".into(),
            );
        }
        Err(error) => warnings.push(format!("GitHub App state unavailable: {error:#}")),
    }
    section
}
async fn run_rotate() -> u8 {
    let result = async {
        let directory = config::config_directory()?;
        let deployment = deployment::choices(&deployment::DeployArgs::default(), &directory)?;
        let config = MachineConfig::load(&directory)?;
        let url = config
            .endpoint_url
            .clone()
            .context("rio doctor --rotate needs a configured endpoint")?;
        anyhow::ensure!(
            deployment.account_id.is_some(),
            "rio doctor --rotate needs a deployment made with rio init (the Worker's secrets are set through Cloudflare)"
        );
        let client = endpoint::client(&url, &config.config_dir)?;
        let cf = deployment::Cloudflare::new(deployment::authentication(&deployment.cf_profile).await?)?;
        anyhow::Ok((cf, deployment, url, client))
    }
    .await;
    let (cf, deployment, url, client) = match result {
        Ok(values) => values,
        Err(error) => {
            eprintln!("{}", redact(&format!("{error:#}")));
            return 2;
        }
    };
    match github_app::rotate(
        &cf,
        &deployment,
        &url,
        &client,
        std::time::Duration::from_secs(60),
    )
    .await
    {
        Ok(()) => {
            eprintln!(
                "Webhook secret rotated: the GitHub App and the endpoint share the new secret, and a signed ping verified."
            );
            0
        }
        Err((step, error)) if step == github_app::FINAL_PING => {
            eprintln!(
                "Rotation failed at the {step} step: {}; the new secret is in effect on the app and the endpoint but the endpoint did not accept a ping signed with it. Run rio doctor --rotate again once the endpoint answers.",
                redact(&format!("{error:#}"))
            );
            1
        }
        Err((step, error)) => {
            eprintln!(
                "Rotation failed at the {step} step: {}; the previous secret stays in effect on the app and the endpoint.",
                redact(&format!("{error:#}"))
            );
            1
        }
    }
}
async fn run_doctor(args: DoctorArgs) -> u8 {
    if args.rotate {
        return run_rotate().await;
    }
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
    if let Some(config) = &config
        && let Some(url) = &config.endpoint_url
    {
        let repository = repo.as_ref().and_then(|repo| {
            lineage::repository_key(repo.root(), repo.remote_url("origin").as_deref()).ok()
        });
        let publish = loader(repo.as_ref().map(|r| r.root().into()), config, cwd.clone())
            .load(None)
            .ok()
            .and_then(|p| serde_json::to_value(p.profile.publish).ok())
            .and_then(|v| v.as_str().map(str::to_owned));
        // `endpoint` stays the URL; the readiness details are additive.
        document["endpoint_status"] =
            endpoint_diagnostics(config, url, repository, publish, &mut warnings).await;
    }
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

/// Exit codes: 0 recorded, 2 invalid reason or no endpoint, 3 rejected or unknown.
async fn run_feedback(args: FeedbackArgs) -> u8 {
    let reason: ResponseReason = match args.dismiss.parse() {
        Ok(reason) => reason,
        Err(message) => {
            eprintln!("{}", redact(&message));
            return 2;
        }
    };
    if args.id.is_empty()
        || !args
            .id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        eprintln!("invalid finding id {:?}", redact(&args.id));
        return 2;
    }
    let cwd = match current_dir() {
        Ok(cwd) => cwd,
        Err(error) => {
            eprintln!("{error}");
            return 3;
        }
    };
    let root = GixRepo::discover(&cwd)
        .ok()
        .map(|repo| repo.root().to_owned());
    let config = match MachineConfig::load(root.as_deref().unwrap_or(&cwd)) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("{}", redact(&format!("{error:#}")));
            return 2;
        }
    };
    let Some(url) = config.endpoint_url.as_deref() else {
        eprintln!(
            "endpoint_required: rio feedback requires a configured endpoint (rio init --endpoint URL)"
        );
        return 2;
    };
    let client = match endpoint::client(url, &config.config_dir) {
        Ok(client) => client,
        Err(error) => {
            eprintln!("endpoint_required: {}", redact(&format!("{error:#}")));
            return 2;
        }
    };
    let mut body = json!({"reason": reason.as_str()});
    if let Some(note) = &args.note {
        body["note"] = json!(note);
    }
    if let Some(actor) = git_user_email(root.as_deref().unwrap_or(&cwd)) {
        body["actor"] = json!(actor);
    }
    match client.feedback(&args.id, &body).await {
        Ok(response) => {
            println!(
                "Finding {} {} ({})",
                redact(response["id"].as_str().unwrap_or(&args.id)),
                redact(response["status"].as_str().unwrap_or("dismissed")),
                reason.as_str()
            );
            0
        }
        Err(error) => {
            let message = match rio_client::http_status(&error) {
                Some(404) => format!("finding {} was not found by the endpoint", args.id),
                Some(_) => format!("the endpoint rejected the response: {error:#}"),
                None => format!("could not record the response: {error:#}"),
            };
            eprintln!("{}", redact(&message));
            3
        }
    }
}
/// `git config user.email`, if git and the setting are available.
fn git_user_email(directory: &std::path::Path) -> Option<String> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(directory)
        .args(["config", "user.email"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    let email = String::from_utf8(output.stdout).ok()?.trim().to_owned();
    (output.status.success() && !email.is_empty()).then_some(email)
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

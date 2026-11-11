use anyhow::{Context, Result};
use clap::Subcommand;
use rio_git::{GixRepo, Repo, Tree, select};
use rio_qa::{QaProject, QaSnapshot};
use serde_json::{Value, json};
use std::collections::BTreeSet;

#[path = "qa_author.rs"]
mod author;
#[path = "qa_init.rs"]
mod init;
#[path = "qa_seed.rs"]
mod seed;

#[derive(clap::Args, Default)]
pub struct QaRunArgs {
    #[command(flatten)]
    selection: crate::SelectionArgs,
    #[arg(long)]
    profile: Option<String>,
    /// Output format; without it a terminal session opens the interactive UI.
    #[arg(long, value_enum)]
    format: Option<crate::Format>,
    /// Stream plain output instead of opening the interactive UI (also `RIO_TUI=0`).
    #[arg(long)]
    no_tui: bool,
    #[arg(long)]
    no_color: bool,
    /// Draw only ASCII characters (also `RIO_ASCII=1`).
    #[arg(long)]
    ascii: bool,
    #[arg(long)]
    publish: bool,
    #[command(flatten)]
    options: QaRunOptions,
}

#[derive(clap::Args, Default)]
pub struct QaRunOptions {
    #[arg(long, conflicts_with = "journey")]
    full: bool,
    #[arg(long)]
    journey: Vec<String>,
    #[arg(long)]
    baseline: bool,
    #[arg(long, value_parser = ["codex", "pi"])]
    harness: Option<String>,
    /// Run only this cell of the matrix, as `<viewport>/<color-scheme>`
    /// (with --journey, one cell run again).
    #[arg(long, value_name = "VIEWPORT/SCHEME")]
    cell: Option<String>,
}

pub fn configure_run(
    profile: &mut rio_profile::ResolvedProfile,
    options: &QaRunOptions,
) -> Result<()> {
    anyhow::ensure!(
        profile.profile.qa_enabled(),
        "rio qa requires a profile with QA enabled; use --profile rio/qa or enable QA in the chosen profile"
    );
    let step = profile
        .profile
        .steps
        .iter_mut()
        .find(|step| step.uses.starts_with("rio/qa@"))
        .context("QA step is missing")?;
    if options.full {
        step.options["mode"] = json!("full");
    }
    if options.baseline {
        step.options["baseline"] = json!(true);
    }
    if let Some(harness) = &options.harness {
        step.options["harness"] = json!(harness);
    }
    if let Some(cell) = &options.cell {
        let name = |part: &str| {
            !part.is_empty()
                && part.starts_with(|c: char| c.is_ascii_lowercase())
                && part
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        };
        let (viewport, color_scheme) = cell
            .split_once('/')
            .filter(|(v, s)| name(v) && name(s))
            .context("--cell takes <viewport>/<color-scheme>, like mobile/dark")?;
        step.options["cell"] = json!({"viewport": viewport, "color_scheme": color_scheme});
    }
    if !options.journey.is_empty() {
        let names: BTreeSet<_> = options.journey.iter().cloned().collect();
        anyhow::ensure!(
            names.iter().all(|name| !name.is_empty()
                && name
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')),
            "Invalid journey name"
        );
        step.options["journeys"] = json!(names);
    }
    profile.qa_standalone = true;
    Ok(())
}

impl QaRunArgs {
    /// The review `rio qa` runs: the QA profile (`rio/qa` unless `--profile`)
    /// with the journey options.
    pub fn review_args(self) -> crate::ReviewArgs {
        crate::ReviewArgs {
            qa: Some(self.options),
            selection: self.selection,
            profile: Some(self.profile.unwrap_or_else(|| "rio/qa".into())),
            format: self.format,
            no_color: self.no_color,
            ascii: self.ascii,
            no_tui: self.no_tui,
            offline: false,
            show_pre_existing: false,
            show_remembered: false,
            pr: None,
            deep: false,
            preset: None,
            fork: false,
            nightly: false,
            publish: false,
            since_last: false,
            reset_lineage: false,
        }
    }
}

/// The flags of a review that `rio qa` arguments do not carry: the change
/// selection, the profile and the harness, as command-line arguments.
pub fn carried_flags(args: &crate::ReviewArgs) -> Vec<String> {
    let mut flags = Vec::new();
    if args.selection.staged {
        flags.push("--staged".into());
    }
    if let Some(base) = &args.selection.base {
        flags.extend(["--base".into(), base.clone()]);
    }
    if let Some(profile) = args.profile.as_ref().filter(|p| *p != "rio/qa") {
        flags.extend(["--profile".into(), profile.clone()]);
    }
    if let Some(harness) = args.qa.as_ref().and_then(|qa| qa.harness.clone()) {
        flags.extend(["--harness".into(), harness]);
    }
    flags
}

/// The options of a `rio qa` run, for the interactive UI's preselection.
pub fn run_options(args: &crate::ReviewArgs) -> (bool, Vec<String>, bool) {
    args.qa
        .as_ref()
        .map(|qa| (qa.full, qa.journey.clone(), qa.baseline))
        .unwrap_or_default()
}

pub const PUBLISH_NOTICE: &str = "QA report retained. Publication requires the GitHub App pull request transport; use rio review --pr URL with a QA-enabled profile.";

pub async fn run_journeys(args: QaRunArgs) -> u8 {
    let publish = args.publish;
    let review = args.review_args();
    let code = if crate::tui::interactive(review.format.is_some(), review.no_tui) {
        crate::tui::qa(review).await
    } else {
        crate::run_review(review).await
    };
    if publish {
        eprintln!("{PUBLISH_NOTICE}");
        return 2;
    }
    code
}

#[derive(Subcommand)]
pub enum QaCommand {
    /// Generate owner-guided journeys against the configured, seeded application.
    Init {
        /// Replace existing committed journeys after validating the generated batch.
        #[arg(long)]
        force: bool,
        /// Accept the reviewed .rio/qa.proposed.yaml from a previous init.
        #[arg(long)]
        accept_contract: bool,
    },
    /// Validate committed journeys and proposed replacements without starting an app.
    Validate,
    /// List runnable journeys, their dependencies and separate proposed candidates.
    List,
    /// Show the resolved environment contract, or one validated journey, as JSON.
    Show { name: Option<String> },
    /// Inspect named uploads, service doubles and captured-message fixtures.
    Fixtures {
        #[command(subcommand)]
        command: FixturesCommand,
    },
    /// Print the versioned UI probes and UX assessment rubric.
    Rules,
    /// Inspect the seed definitions and locally published snapshot.
    Seed {
        #[command(subcommand)]
        command: SeedCommand,
    },
    /// Manage retained browser evidence.
    Evidence {
        #[command(subcommand)]
        command: EvidenceCommand,
    },
    /// Check whether source or owner guidance changes require journey reconciliation.
    Sync {
        #[arg(long)]
        check: bool,
        #[command(flatten)]
        selection: crate::SelectionArgs,
    },
}

#[derive(Subcommand)]
pub enum FixturesCommand {
    Status,
}

#[derive(Subcommand)]
pub enum EvidenceCommand {
    /// Delete hosted evidence for one review and revoke its download links.
    Prune {
        #[arg(long)]
        review: String,
    },
}

#[derive(Subcommand)]
pub enum SeedCommand {
    /// Build the seed in the isolated app pod, or restore a matching snapshot.
    Build {
        #[arg(long)]
        force: bool,
    },
    /// Export verified seed archives from the local cache for inspection.
    Export { directory: std::path::PathBuf },
    /// Keep the newest snapshots and any snapshots leased by running jobs.
    Prune {
        #[arg(long, default_value_t = 3)]
        keep: usize,
    },
    /// Show the current fingerprint, cached snapshot and rebuild reason.
    Status {
        /// A provisioned app image to inspect without building it.
        #[arg(long)]
        image: Option<String>,
    },
}

pub(crate) fn snapshot(tree: Tree) -> Result<QaSnapshot> {
    tree.into_iter()
        .filter_map(|(name, entry)| {
            if entry.mode == 0o120000 {
                if name.starts_with(".rio/qa/") || name == ".rio/qa.yaml" {
                    return Some(Err(anyhow::anyhow!(
                        "{name}: QA definitions must be regular files"
                    )));
                }
                return None;
            }
            Some(Ok((name, entry.content)))
        })
        .collect()
}

async fn execute(command: QaCommand) -> Result<u8> {
    if matches!(command, QaCommand::Rules) {
        print!("{}", include_str!("../../../modules/qa/rules/ui-v1.yaml"));
        return Ok(0);
    }
    let (result, status) = evaluate(command).await?;
    println!(
        "{}",
        rio_core::redact(&serde_json::to_string_pretty(&result)?)
    );
    Ok(status)
}

/// Runs a `rio qa` subcommand and returns the JSON document it prints and its
/// exit status, printing nothing to standard output (the interactive UI runs
/// these too). `Rules` prints a YAML file and is handled by `execute`.
pub(crate) async fn evaluate(command: QaCommand) -> Result<(Value, u8)> {
    if let QaCommand::Seed {
        command: SeedCommand::Prune { keep },
    } = &command
    {
        let cwd = std::env::current_dir()?;
        let repo = GixRepo::discover(&cwd).ok();
        let config = crate::config::MachineConfig::load(
            repo.as_ref().map_or(cwd.as_path(), |repo| repo.root()),
        )?;
        let removed = rio_qa::prune_seed_cache(&config.cache.dir.join("qa-seeds"), *keep)?;
        return Ok((json!({"storage":"local","removed":removed,"keep":keep}), 0));
    }
    anyhow::ensure!(
        !matches!(command, QaCommand::Rules),
        "rio qa rules prints a file"
    );
    if let QaCommand::Evidence {
        command: EvidenceCommand::Prune { review },
    } = &command
    {
        let config = crate::config::MachineConfig::load(&std::env::current_dir()?)?;
        let endpoint = config.endpoint_url.as_deref().context(
            "hosted evidence pruning requires an endpoint; set RIO_ENDPOINT_URL or run rio init",
        )?;
        let result = crate::endpoint::client(endpoint, &config.config_dir)?
            .prune_qa_evidence(review)
            .await?;
        return Ok((result, 0));
    }
    let repo = GixRepo::discover(&std::env::current_dir()?)?;
    let (head_tree, base) = if let QaCommand::Sync { selection, .. } = &command {
        let changes = select(&repo, selection.selection())?;
        (changes.head, snapshot(changes.base)?)
    } else {
        (repo.working_tree()?, QaSnapshot::new())
    };
    let modes = head_tree
        .iter()
        .map(|(path, entry)| (path.clone(), entry.mode & 0o777))
        .collect();
    let head = snapshot(head_tree)?;
    if let QaCommand::Init {
        force,
        accept_contract,
    } = command
    {
        let result = init::run(
            repo.root(),
            rio_qa::RuntimeSnapshot { files: head, modes },
            force,
            accept_contract,
        )
        .await?;
        return Ok((result, 0));
    }
    let project = QaProject::load(&head)?;
    for warning in &project.warnings {
        eprintln!("warning: {}", rio_core::redact(&warning.to_string()));
    }
    let (result, status) = match command {
        QaCommand::Validate => (
            json!({"valid":true,"journeys":project.journeys.len(),"candidates":project.candidates.len(),"warnings":project.warnings}),
            0,
        ),
        QaCommand::List => (
            json!({"journeys":project.journeys.values().collect::<Vec<_>>(),"candidates":project.candidates.values().collect::<Vec<_>>()}),
            0,
        ),
        QaCommand::Show { name: None } => (serde_json::to_value(&project.config)?, 0),
        QaCommand::Show { name: Some(name) } => (
            serde_json::to_value(
                project
                    .journeys
                    .get(&name)
                    .with_context(|| format!("unknown journey {name}"))?,
            )?,
            0,
        ),
        QaCommand::Fixtures {
            command: FixturesCommand::Status,
        } => {
            let fixtures = serde_json::to_value(&project.fixtures)?;
            let files: Vec<_> = fixtures["files"].as_array().into_iter().flatten().map(|file| json!({
                "name":file["name"],"source":if file["path"].is_string() { "committed" } else { "generated" },
                "definition":file
            })).collect();
            let services: Vec<_> = fixtures["services"].as_array().into_iter().flatten().map(|service| json!({
                "name":service["name"],"kind":service["kind"],"claims":service["claims"],
                "source":if matches!(service["kind"].as_str(), Some("smtp-capture" | "sms-capture" | "webhook-sink")) { "captured" } else { "double" }
            })).collect();
            (
                json!({"files":files,"services":services,"capture":fixtures["capture"],"defaults":fixtures["defaults"],"runtime_started":false}),
                0,
            )
        }
        QaCommand::Sync { check, .. } => {
            let changed: BTreeSet<_> = base
                .keys()
                .chain(head.keys())
                .filter(|path| base.get(*path) != head.get(*path))
                .cloned()
                .collect();
            let stale = project.stale_journeys(&base, &head, &changed);
            if !check && !stale.is_empty() {
                let result = author::run(
                    repo.root(),
                    rio_qa::RuntimeSnapshot { files: head, modes },
                    rio_qa::AuthorMode::Sync { reasons: stale },
                )
                .await?;
                return Ok((result, 0));
            }
            let status = u8::from(!stale.is_empty());
            (
                json!({"possibly_stale":stale,"checked_without_runtime":true}),
                status,
            )
        }
        QaCommand::Seed {
            command: SeedCommand::Build { force },
        } => (
            seed::run(
                repo.root(),
                rio_qa::RuntimeSnapshot { files: head, modes },
                force,
                None,
            )
            .await?,
            0,
        ),
        QaCommand::Seed {
            command: SeedCommand::Export { directory },
        } => (
            seed::run(
                repo.root(),
                rio_qa::RuntimeSnapshot { files: head, modes },
                false,
                Some(&directory),
            )
            .await?,
            0,
        ),
        QaCommand::Seed {
            command: SeedCommand::Status { image },
        } => {
            let config = crate::config::MachineConfig::load(repo.root())?;
            let selected_image = image
                .or_else(|| std::env::var("RIO_QA_APP_IMAGE").ok())
                .or_else(|| {
                    (project.config.app.packaging != "image").then(|| {
                        std::env::var("RIO_QA_IMAGE").unwrap_or_else(|_| "rio-qa:0.1.0".into())
                    })
                });
            let mut result = json!({"datastores":project.seed.as_ref().map(|seed| &seed.datastores),
                "steps":project.seed.as_ref().map(|seed| &seed.steps),"users":project.seed.as_ref().map(|seed| &seed.users),
                "paths":project.seed.as_ref().map(|seed| &seed.paths),"storage":"local","next":"build","reason":"app image digest unavailable"});
            if let Some(image) = selected_image {
                anyhow::ensure!(
                    !image.is_empty()
                        && !image.starts_with('-')
                        && !image.chars().any(char::is_whitespace),
                    "Invalid QA app image name"
                );
                let mut command =
                    rio_adapters::ToolCommand::new("docker".into(), repo.root().into());
                command.args = vec![
                    "image".into(),
                    "inspect".into(),
                    "--format".into(),
                    "{{.Id}}".into(),
                    image.clone().into(),
                ];
                command.timeout = std::time::Duration::from_secs(10);
                command.output_limit = 1024;
                let output = rio_adapters::ProcessSupervisor::default()
                    .run(command, tokio_util::sync::CancellationToken::new())
                    .await;
                if matches!(
                    output.termination,
                    rio_adapters::Termination::Exited { code: Some(0) }
                ) {
                    let fingerprint = rio_qa::SeedFingerprint::build(
                        &project,
                        &head,
                        String::from_utf8_lossy(&output.stdout).trim(),
                    )?;
                    let status = rio_qa::seed_cache_status(
                        &config.cache.dir.join("qa-seeds"),
                        &fingerprint,
                        rio_qa::seed_size_limit(&project.config.seed.max_size)?,
                    )?;
                    result
                        .as_object_mut()
                        .unwrap()
                        .extend(status.as_object().unwrap().clone());
                }
                result["image"] = json!(image);
            }
            if result.get("fingerprint").is_none() {
                result["hint"] = json!(
                    "Build the application's provisioned image, then pass --image NAME or set RIO_QA_APP_IMAGE."
                );
            }
            (result, 0)
        }
        QaCommand::Init { .. }
        | QaCommand::Rules
        | QaCommand::Evidence { .. }
        | QaCommand::Seed {
            command: SeedCommand::Prune { .. },
        } => unreachable!(),
    };
    Ok((result, status))
}

pub async fn run(command: QaCommand) -> u8 {
    match execute(command).await {
        Ok(status) => status,
        Err(error) => {
            eprintln!("{}", rio_core::redact(&format!("{error:#}")));
            2
        }
    }
}

/// Diagnostic output describes the resolved path, never credential contents.
pub async fn doctor(repo: &GixRepo, hosted: bool) -> Result<serde_json::Value> {
    let head = snapshot(repo.working_tree()?)?;
    if !head.contains_key(".rio/qa.yaml") {
        return Ok(json!({"configured":false}));
    }
    let project = QaProject::load(&head)?;
    let auth_path = std::env::var_os("CODEX_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| std::path::PathBuf::from(home).join(".codex"))
        })
        .map(|home| home.join("auth.json"));
    let auth = rio_qa::resolve_authentication(
        &project.config.harness.auth,
        &project.config.harness.default,
        rio_qa::QaBackend::Docker,
        hosted,
        auth_path.as_deref(),
    )?;
    if hosted {
        return Ok(
            json!({"configured":true,"backend":"endpoint runner","authentication":auth,"runtime":"checked by endpoint; Sandbox requires explicit opt-in"}),
        );
    }
    let image = std::env::var("RIO_QA_IMAGE").unwrap_or_else(|_| "rio-qa:0.1.0".into());
    let mut command = rio_adapters::ToolCommand::new("docker".into(), repo.root().into());
    command.args = vec![
        "info".into(),
        "--format".into(),
        "{{.ServerVersion}}".into(),
    ];
    command.timeout = std::time::Duration::from_secs(5);
    command.output_limit = 1024;
    let supervisor = rio_adapters::ProcessSupervisor::default();
    let docker = supervisor
        .run(command, tokio_util::sync::CancellationToken::new())
        .await;
    let available = matches!(
        docker.termination,
        rio_adapters::Termination::Exited { code: Some(0) }
    );
    let mut image_available = false;
    if available && !image.starts_with('-') && !image.chars().any(char::is_whitespace) {
        let mut command = rio_adapters::ToolCommand::new("docker".into(), repo.root().into());
        command.args = vec![
            "image".into(),
            "inspect".into(),
            "--format".into(),
            "{{.Id}}".into(),
            image.clone().into(),
        ];
        command.timeout = std::time::Duration::from_secs(5);
        command.output_limit = 1024;
        image_available = matches!(
            supervisor
                .run(command, tokio_util::sync::CancellationToken::new())
                .await
                .termination,
            rio_adapters::Termination::Exited { code: Some(0) }
        );
    }
    Ok(
        json!({"configured":true,"backend":"docker","docker_available":available,"image":image,"image_available":image_available,"authentication":auth,
        "runtime": if available && image_available { "available" } else { "no_runtime" },
        "hint": if !available { "Start a Docker daemon with host firewall control." } else if !image_available { "Build the paired image with docker build -f worker/Dockerfile.qa -t rio-qa:0.1.0 ." } else { "Run rio-runner qa --pod-self-test to check host egress enforcement." }}),
    )
}

#[cfg(test)]
mod cell_tests {
    use super::*;

    fn profile() -> rio_profile::ResolvedProfile {
        let root = tempfile::tempdir().unwrap();
        rio_profile::ProfileLoader::new(
            Some(root.path().into()),
            root.path().join("config"),
            root.path().into(),
        )
        .load(Some("rio/qa"))
        .unwrap()
    }

    #[test]
    fn cell_runs_one_cell_and_rejects_anything_else() {
        let mut qa = profile();
        let options = QaRunOptions {
            journey: vec!["checkout".into()],
            cell: Some("mobile/dark".into()),
            ..QaRunOptions::default()
        };
        configure_run(&mut qa, &options).unwrap();
        assert_eq!(
            qa.profile.step("rio/qa").unwrap().options["cell"],
            json!({"viewport": "mobile", "color_scheme": "dark"})
        );
        for bad in ["mobile", "mobile/", "/dark", "Mobile/dark", "mobile/dark/x"] {
            let options = QaRunOptions {
                cell: Some(bad.into()),
                ..QaRunOptions::default()
            };
            assert!(configure_run(&mut profile(), &options).is_err(), "{bad}");
        }
    }
}

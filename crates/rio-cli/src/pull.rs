//! `rio review --pr <n>` (cli/review, "Pull request review"): the endpoint
//! prepares and reviews the pull request head; nothing is built from the local
//! checkout. `--publish` is the `ask` policy's consent.
use crate::{ReviewArgs, config::MachineConfig, error_report, lineage, loader};
use rio_core::*;
use rio_git::{GixRepo, Repo};
use std::{
    io::{self, IsTerminal, Write},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

/// How long the endpoint may spend preparing before the review itself starts.
const PREPARE_ALLOWANCE: Duration = Duration::from_secs(15 * 60);

pub const NO_INSTALLATION: &str = "no_installation";

pub async fn review(args: ReviewArgs, started: String) -> u8 {
    let format = args.format;
    let usage =
        |message: &str| error_report(format, 2, "usage_error", message.to_owned(), Vec::new());
    if args.selection.staged || args.selection.base.is_some() || args.since_last {
        return usage(
            "--pr cannot be combined with selection flags (--staged, --base, --since-last): the endpoint reviews the pull request's own base and head",
        );
    }
    let flag = if args.pr.is_some() {
        "--pr"
    } else {
        "--publish"
    };
    let cwd = match std::env::current_dir() {
        Ok(cwd) => cwd,
        Err(error) => {
            return error_report(format, 3, "internal_error", error.to_string(), Vec::new());
        }
    };
    let preliminary = match MachineConfig::load(&cwd) {
        Ok(config) => config,
        Err(error) => {
            return error_report(
                format,
                2,
                "invalid_configuration",
                format!("{error:#}"),
                Vec::new(),
            );
        }
    };
    if preliminary.endpoint_url.is_none() || args.offline {
        return error_report(
            format,
            2,
            "endpoint_required",
            format!(
                "{flag} requires a configured endpoint and online mode: the endpoint prepares, reviews and publishes the pull request (rio init)"
            ),
            Vec::new(),
        );
    }
    let Some(number) = args.pr.as_deref() else {
        return usage("--publish requires --pr: it publishes a pull request review");
    };
    let Some(number) = number
        .parse::<u64>()
        .ok()
        .filter(|n| (1..=u64::from(u32::MAX)).contains(n))
    else {
        return usage("--pr expects a pull request number");
    };
    let repo = match GixRepo::discover(&cwd) {
        Ok(repo) => repo,
        Err(error) => {
            return error_report(
                format,
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
                format,
                2,
                "invalid_configuration",
                format!("{error:#}"),
                Vec::new(),
            );
        }
    };
    let Some(url) = config.endpoint_url.clone() else {
        return error_report(
            format,
            2,
            "endpoint_required",
            "--pr requires a configured endpoint and online mode (rio init)".into(),
            Vec::new(),
        );
    };
    let profile = match loader(Some(repo.root().into()), &config, cwd).load(args.profile.as_deref())
    {
        Ok(profile) => profile,
        Err(error) => {
            return error_report(
                format,
                2,
                "invalid_profile",
                error.to_string(),
                error.to_string().lines().map(str::to_owned).collect(),
            );
        }
    };
    let repository = lineage::repository_key(repo.root(), repo.remote_url("origin").as_deref())
        .ok()
        .filter(|key| key.starts_with("github.com/") && key.matches('/').count() == 2);
    let Some(repository) = repository else {
        return error_report(
            format,
            2,
            "usage_error",
            "--pr reviews a GitHub pull request: the repository's origin remote must be a github.com repository".into(),
            Vec::new(),
        );
    };
    let client = match crate::endpoint::client(&url, &config.config_dir) {
        Ok(client) => client,
        Err(error) => {
            return error_report(
                format,
                2,
                "endpoint_required",
                format!("{error:#}"),
                Vec::new(),
            );
        }
    };
    let missing = || {
        error_report(
            format,
            2,
            NO_INSTALLATION,
            format!(
                "--pr needs the endpoint's GitHub App installed on {repository}: run `rio init --github-app` (the GitHub App step) and install the app on the repository"
            ),
            Vec::new(),
        )
    };
    match client.github_installation(&repository).await {
        Ok(status) if status["configured"] == true && status["installed"] == true => {}
        Ok(_) => return missing(),
        Err(error) if rio_client::http_status(&error) == Some(404) => return missing(),
        Err(error) => {
            return error_report(
                format,
                3,
                "internal_error",
                format!("{error:#}"),
                Vec::new(),
            );
        }
    }
    let policy = profile
        .profile
        .fail_on
        .compile()
        .expect("validated fail_on");
    let cancellation = CancellationToken::new();
    let signal = cancellation.clone();
    let signals = tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            signal.cancel();
            eprintln!("Interrupted; cancelling the endpoint review…");
        }
    });
    let id = match client.pull_review(&repository, number, args.publish).await {
        Ok(id) => id,
        Err(error) => {
            signals.abort();
            return error_report(
                format,
                3,
                "internal_error",
                format!("{error:#}"),
                Vec::new(),
            );
        }
    };
    eprintln!(
        "Endpoint pull request review: {id} ({repository}#{number}); the endpoint prepares the PR head"
    );
    let timeout = crate::endpoint::review_timeout(&profile).unwrap_or_default() + PREPARE_ALLOWANCE;
    let mut report = match client.wait(&id, cancellation, timeout).await {
        Ok(report) => report,
        Err(error) => {
            signals.abort();
            return error_report(
                format,
                3,
                "internal_error",
                format!("{error:#}"),
                Vec::new(),
            );
        }
    };
    signals.abort();
    let reason = report.publication.as_ref().and_then(|p| p.reason);
    if args.publish && reason == Some(UnpublishedReason::PolicyNever) {
        eprintln!("The profile forbids publication (publish: never); nothing was published.");
    }
    // Under `ask` without --publish, an interactive user is asked once.
    if !args.publish
        && reason == Some(UnpublishedReason::AskWithoutConsent)
        && io::stdin().is_terminal()
        && io::stderr().is_terminal()
        && confirm(&format!(
            "Publish this review to {repository}#{number}? [y/N] "
        ))
    {
        match publish(&client, &id).await {
            Ok(published) => report = published,
            Err(error) => {
                eprintln!("Publication failed: {error:#}");
                if let Some(publication) = report.publication.as_mut() {
                    publication.failed += 1;
                }
            }
        }
    }
    crate::render_and_exit(report, &args, started, &policy)
}

fn confirm(prompt: &str) -> bool {
    eprint!("{prompt}");
    let _ = io::stderr().flush();
    let mut answer = String::new();
    io::stdin().read_line(&mut answer).is_ok()
        && matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes")
}

/// Records consent and waits for the endpoint to publish the finished review.
async fn publish(client: &rio_client::Client, id: &str) -> anyhow::Result<Report> {
    client.publish(id).await?;
    for _ in 0..120 {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let report = client.report(id).await?;
        if report
            .publication
            .as_ref()
            .is_some_and(|p| p.reason != Some(UnpublishedReason::AskWithoutConsent))
        {
            return Ok(report);
        }
    }
    anyhow::bail!("the endpoint did not publish within two minutes")
}

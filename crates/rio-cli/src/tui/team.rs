//! The team screens from the review flow: P1 (security finding and council),
//! P2 (publish preview), P3 (finding history) and P4 (suppression proposals).
//! Their data comes from the report; their effects call the endpoint exactly
//! as `rio findings`, `rio suppressions` and `rio review --pr --publish` do.

use std::{rc::Rc, sync::mpsc::Sender};

use rio_core::{Category, Finding, PublishPolicy, Report, redact};
use rio_tui::{
    Action, Effect, Msg, Outcome,
    review::{Open, Opener},
    team::{
        CodeLine, HistoryData, ProposalsData, PublishData, SecurityData, SecurityEntry,
        SecurityScreen, StepText, history, proposals, publish,
    },
};

use crate::{config::MachineConfig, registry};

/// What the team effects need to know about the review on screen.
#[derive(Clone, Default)]
pub struct TeamContext {
    /// The review ran offline (no endpoint calls).
    pub offline: bool,
    /// The endpoint's id of the review, when the endpoint ran it.
    pub review_id: Option<String>,
    /// The pull request a `--pr` review reviewed.
    pub pr: Option<u64>,
}

/// Why the registry and publishing are out of reach, if they are.
fn unavailable(ctx: &TeamContext) -> Option<String> {
    let cwd = std::env::current_dir().unwrap_or_default();
    let configured = MachineConfig::load(&cwd)
        .ok()
        .is_some_and(|c| c.endpoint_url.is_some());
    if ctx.offline {
        Some(
            "this review ran --offline: the registry, the audit and publishing need the endpoint"
                .into(),
        )
    } else if !configured {
        Some("no endpoint is configured (rio init): the registry, the audit and publishing live there".into())
    } else {
        None
    }
}

fn client() -> anyhow::Result<rio_client::Client> {
    let cwd = std::env::current_dir()?;
    let config = MachineConfig::load(&cwd)?;
    let url = config
        .endpoint_url
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("no endpoint is configured (rio init)"))?;
    crate::endpoint::client(url, &config.config_dir)
}

/// Runs a team effect on the runtime and answers with the value the team
/// screens expect, or `Failed`. `published` receives the report after `y`.
pub fn run(
    effect: Effect,
    ctx: &TeamContext,
    runtime: &tokio::runtime::Handle,
    reply: &Sender<Msg>,
    published: Box<dyn FnOnce(Report) + Send>,
) {
    let send = {
        let reply = reply.clone();
        move |outcome: Outcome| {
            let _ = reply.send(Msg::Done(outcome));
        }
    };
    if let Some(reason) = unavailable(ctx) {
        return send(Outcome::Failed(reason));
    }
    let failed = |error: anyhow::Error| Outcome::Failed(redact(&format!("{error:#}")));
    let ctx = ctx.clone();
    let reply = reply.clone();
    runtime.spawn(async move {
        let send = move |outcome: Outcome| {
            let _ = reply.send(Msg::Done(outcome));
        };
        match effect {
            Effect::Fetch(name) if name == "findings" => match registry::scope("rio findings") {
                Ok(scope) => send(match registry::records(&scope).await {
                    Ok(value) => Outcome::Value("findings".into(), value),
                    Err(error) => failed(error),
                }),
                Err(error) => send(Outcome::Failed(error)),
            },
            Effect::Fetch(name) if name == "suppressions" => {
                match registry::scope("rio suppressions") {
                    Ok(scope) => send(match registry::proposals(&scope).await {
                        Ok(value) => Outcome::Value("suppressions".into(), value),
                        Err(error) => failed(error),
                    }),
                    Err(error) => send(Outcome::Failed(error)),
                }
            }
            Effect::Fetch(name) if name == "audit" => {
                let Some(id) = ctx.review_id else {
                    return send(Outcome::Failed(
                        "the endpoint holds no audit for this review (it ran locally)".into(),
                    ));
                };
                send(match client() {
                    Ok(client) => match client.audit(&id).await {
                        Ok(value) => Outcome::Value("audit".into(), value),
                        Err(error) => failed(error),
                    },
                    Err(error) => failed(error),
                });
            }
            Effect::Fetch(other) => send(Outcome::Failed(format!("unknown resource {other}"))),
            Effect::PreviewPublish | Effect::Publish if ctx.pr.is_none() => {
                send(Outcome::Failed(
                    "publishing needs a pull request review: rio review --pr <number>".into(),
                ));
            }
            Effect::PreviewPublish => {
                let Some(id) = ctx.review_id else {
                    return send(Outcome::Failed("the review has no endpoint id".into()));
                };
                send(match client() {
                    Ok(client) => match client.publish_preview(&id).await {
                        Ok(value) => Outcome::Value("publish:preview".into(), value),
                        Err(error) => failed(error),
                    },
                    Err(error) => failed(error),
                });
            }
            Effect::Publish => {
                let Some(id) = ctx.review_id else {
                    return send(Outcome::Failed("the review has no endpoint id".into()));
                };
                let result = match client() {
                    Ok(client) => crate::pull::publish(&client, &id).await,
                    Err(error) => Err(error),
                };
                match result {
                    Ok(report) => {
                        let posted = report.publication.as_ref().map_or(0, |p| p.posted);
                        published(report);
                        send(Outcome::Ok(format!("published · {posted} comments posted")));
                    }
                    Err(error) => send(failed(error)),
                }
            }
            Effect::ApplyProposal(id) => match registry::scope("rio suppressions") {
                Ok(scope) => {
                    send(match registry::apply_consented(&scope, &id).await {
                        Ok(message) => Outcome::Ok(message),
                        Err(error) => Outcome::Failed(error),
                    });
                    if let Ok(value) = registry::proposals(&scope).await {
                        send(Outcome::Value("suppressions".into(), value));
                    }
                }
                Err(error) => send(Outcome::Failed(error)),
            },
            Effect::DeclineProposal { id, reason } => match registry::scope("rio suppressions") {
                Ok(scope) => {
                    send(match registry::decline(&scope, &id, Some(reason)).await {
                        Ok(message) => Outcome::Ok(message),
                        Err(error) => Outcome::Failed(error),
                    });
                    if let Ok(value) = registry::proposals(&scope).await {
                        send(Outcome::Value("suppressions".into(), value));
                    }
                }
                Err(error) => send(Outcome::Failed(error)),
            },
            _ => send(Outcome::Failed("not a team action".into())),
        }
    });
}

/// The repository as `owner/name` and its registry key.
fn repository() -> (String, String) {
    let cwd = std::env::current_dir().unwrap_or_default();
    let key = rio_git::GixRepo::discover(&cwd)
        .ok()
        .and_then(|repo| {
            use rio_git::Repo;
            crate::lineage::repository_key(repo.root(), repo.remote_url("origin").as_deref()).ok()
        })
        .unwrap_or_default();
    let shown = key
        .split_once('/')
        .map(|(_, rest)| rest.to_owned())
        .unwrap_or_else(|| key.clone());
    (shown, key)
}

/// The working tree's copy of a repository path (as findings cite them,
/// relative to the repository root, wherever rio runs from). Other paths are
/// not read.
fn read_in(root: &std::path::Path, path: &str) -> Option<String> {
    let relative = std::path::Path::new(path);
    let plain = relative
        .components()
        .all(|c| matches!(c, std::path::Component::Normal(_)));
    plain
        .then(|| std::fs::read_to_string(root.join(relative)).ok())
        .flatten()
}

/// The repository's root, else the current directory.
fn repository_root() -> std::path::PathBuf {
    let cwd = std::env::current_dir().unwrap_or_default();
    rio_git::GixRepo::discover(&cwd)
        .map(|repo| {
            use rio_git::Repo;
            repo.root().to_owned()
        })
        .unwrap_or(cwd)
}

/// Lines `line - 3 ..= line + 3` of the working tree's copy of a file.
fn excerpt(root: &std::path::Path, finding: &Finding, changed: &[u32]) -> Vec<CodeLine> {
    let Some(text) = read_in(root, &finding.location.path) else {
        return Vec::new();
    };
    let line = finding.location.line_start.max(1);
    text.lines()
        .enumerate()
        .map(|(i, t)| (i as u32 + 1, t))
        .filter(|(n, _)| n + 3 >= line && *n <= finding.location.line_end.max(line) + 3)
        .map(|(n, t)| CodeLine {
            line: n,
            text: t.to_owned(),
            changed: changed.contains(&n),
        })
        .collect()
}

/// The cited code and stage of each trace step.
fn steps(root: &std::path::Path, finding: &Finding) -> Vec<StepText> {
    let Some(trace) = &finding.trace else {
        return Vec::new();
    };
    trace
        .steps
        .iter()
        .map(|step| {
            let code = read_in(root, &step.path)
                .filter(|_| !step.missing)
                .and_then(|text| {
                    text.lines()
                        .nth(step.line_start.saturating_sub(1) as usize)
                        .map(|l| l.trim().to_owned())
                })
                .unwrap_or_else(|| step.path.rsplit('/').next().unwrap_or("").to_owned());
            StepText {
                code,
                stage: match step.role.as_str() {
                    "source" => "input".into(),
                    "sink" => "sensitive operation".into(),
                    _ => "check".into(),
                },
                note: step.missing.then(|| "removed by the change".to_owned()),
            }
        })
        .collect()
}

/// Builds the team screens for the findings hub of `report`.
pub fn opener(
    report: &Report,
    context: &str,
    endpoint: bool,
    failing: &[String],
    changed: &std::collections::BTreeMap<String, Vec<u32>>,
    posted: Option<&std::collections::BTreeSet<String>>,
    pr: Option<u64>,
) -> Opener {
    let (shown, key) = repository();
    let proposals_data = ProposalsData {
        repository: shown.clone(),
        ..ProposalsData::default()
    };
    let history_data = HistoryData {
        repository: shown.clone(),
        origin: key,
        endpoint,
        since_days: 90,
        proposals: proposals_data.clone(),
        ..HistoryData::default()
    };
    let all: Vec<&Finding> = report
        .findings
        .iter()
        .chain(&report.risks)
        .chain(&report.security)
        .collect();
    let publish_data = PublishData {
        repository: report
            .review
            .pull_request
            .as_ref()
            .map(|p| p.repository.clone())
            .unwrap_or_else(|| shown.clone()),
        pr: pr.unwrap_or(0),
        head: report.review.head.clone().unwrap_or_default(),
        base: report.review.base.clone().unwrap_or_default(),
        author: report
            .review
            .pull_request
            .as_ref()
            .map(|p| p.author.login.clone())
            .unwrap_or_default(),
        fork: report.review.pull_request.as_ref().is_some_and(|p| p.fork),
        you: String::new(),
        lineage: "pr".into(),
        round: report.lineage.as_ref().map_or(1, |l| l.round),
        cap: report.lineage.as_ref().map_or(1, |l| l.cap),
        policy: report
            .publication
            .as_ref()
            .map_or(PublishPolicy::Ask, |p| p.policy),
        findings: all.iter().map(|f| (*f).clone()).collect(),
        posted: posted
            .map(|p| p.iter().cloned().collect())
            .unwrap_or_default(),
        ..PublishData::default()
    };
    let root = repository_root();
    let security = SecurityData {
        context: format!("review · {context}"),
        scope: match pr {
            Some(n) => format!("PR #{n}"),
            None => "this change".into(),
        },
        entries: all
            .iter()
            .filter(|f| f.category == Category::Security)
            .map(|f| {
                let mut entry = SecurityEntry::new((*f).clone());
                entry.fails = failing.contains(&f.id);
                entry.code = excerpt(&root, f, changed.get(&f.id).map_or(&[], Vec::as_slice));
                entry.steps = steps(&root, f);
                entry
            })
            .collect(),
        coverage: report.security_coverage.clone(),
        endpoint,
        publish: publish_data.clone(),
        history: history_data.clone(),
        ..SecurityData::default()
    };
    Rc::new(move |open: Open, finding: Option<&Finding>| match open {
        Open::Security => Action::Push(Box::new(
            SecurityScreen::new(security.clone()).focused_on(finding.map_or("", |f| &f.id)),
        )),
        Open::History => Action::Many(vec![
            Action::Push(history(history_data.clone())),
            Action::Effect(Effect::Fetch("findings".into())),
        ]),
        Open::Proposals => Action::Many(vec![
            Action::Push(proposals(proposals_data.clone())),
            Action::Effect(Effect::Fetch("suppressions".into())),
        ]),
        Open::Publish => Action::Many(vec![
            Action::Push(publish(publish_data.clone())),
            Action::Effect(Effect::PreviewPublish),
        ]),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cited_files_are_read_from_the_repository_root_only() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("src")).unwrap();
        std::fs::write(root.path().join("src/a.rs"), "fn a() {}\n").unwrap();
        assert_eq!(
            read_in(root.path(), "src/a.rs").as_deref(),
            Some("fn a() {}\n")
        );
        for path in ["../a.rs", "/etc/hostname", "src/../../a.rs", "./src/a.rs"] {
            assert_eq!(read_in(root.path(), path), None, "{path}");
        }
    }
}

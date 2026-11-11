//! The host of `rio qa` in the interactive UI: Q1's data from the QA config,
//! its journeys and the change, and the `qa:*` steps the screens ask for.
//! The run itself goes through [`super::review::ReviewHost`], which parses
//! `rio qa …` arguments as well as `rio review …` ones.

use std::{
    collections::{BTreeMap, BTreeSet},
    sync::mpsc::Sender,
};

use rio_git::{GixRepo, Repo, select};
use rio_qa::{QaProject, QaSnapshot, SelectionInput};
use rio_tui::{
    Msg, Outcome,
    qa::{
        Budget, CellId, ChangedFile, Harness, Journey, JourneyStep, JourneysData, Persona,
        Proposed, ProposedItem, Seed, SyncItem, SyncStatus, UxData, Why,
    },
    review::SelectionKind,
};
use serde_json::Value;

use crate::{ReviewArgs, config::MachineConfig, qa};

/// The file name Q4's `x` exports to; the host writes only the UX
/// recommendations there, never the report.
pub const UX_EXPORT: &str = "ux-recommendations.md";

/// Q1's data: the QA config, the journeys with the default selection for the
/// change, proposed candidates and the sync check. `Err` when the repository
/// or the QA config cannot be read (the streaming path reports why).
pub fn journeys_data(args: &ReviewArgs) -> Result<JourneysData, ()> {
    let cwd = std::env::current_dir().map_err(|_| ())?;
    let repo = GixRepo::discover(&cwd).map_err(|_| ())?;
    let changes = select(&repo, args.selection.selection()).map_err(|_| ())?;
    let base = qa::snapshot(changes.base.clone()).map_err(|_| ())?;
    let head = qa::snapshot(changes.head.clone()).map_err(|_| ())?;
    let project = QaProject::load(&head).map_err(|_| ())?;
    let changed: BTreeSet<String> = base
        .keys()
        .chain(head.keys())
        .filter(|path| base.get(*path) != head.get(*path))
        .cloned()
        .collect();
    let (full, explicit, _) = qa::run_options(args);
    let input = SelectionInput {
        full,
        explicit,
        changed: changed.clone(),
        ..SelectionInput::default()
    };
    let plan = project.plan(&base, &head, &input).ok();
    let config = MachineConfig::load(repo.root()).map_err(|_| ())?;
    let profile = crate::loader(Some(repo.root().into()), &config, cwd)
        .load(args.profile.as_deref())
        .ok();

    let mut journeys = Vec::new();
    // A dependency of a selected journey runs whenever that one runs.
    let mut chained_by: BTreeMap<String, String> = BTreeMap::new();
    let mut chains: BTreeMap<String, Vec<String>> = BTreeMap::new();
    if let Some(plan) = &plan {
        for chain in &plan.chains {
            if let Some(last) = chain.journeys.last() {
                for name in &chain.journeys[..chain.journeys.len() - 1] {
                    chained_by.entry(name.clone()).or_insert(last.clone());
                }
                chains.insert(last.clone(), chain.journeys.clone());
            }
        }
    }
    let guidance = |reason: &str| reason.strip_prefix("guidance: ").map(str::to_owned);
    for (name, journey) in &project.journeys {
        let selected = plan
            .as_ref()
            .and_then(|p| p.selected.get(name))
            .filter(|_| !chained_by.contains_key(name) || chains.contains_key(name));
        let held = plan.as_ref().and_then(|p| p.held_back.get(name));
        let why = if let Some(reasons) = selected {
            reasons
                .iter()
                .find_map(|r| {
                    if r == "smoke" {
                        Some(Why::Smoke)
                    } else if let Some(path) = r.strip_prefix("path: ") {
                        // The covered glob when there is one, else the changed path.
                        Some(Why::Covers(match journey.covers.paths.as_slice() {
                            [glob] => glob.clone(),
                            _ => path.to_owned(),
                        }))
                    } else {
                        guidance(r).map(Why::Guidance)
                    }
                })
                .unwrap_or_else(|| {
                    Why::Covers(reasons.first().cloned().unwrap_or_else(|| "change".into()))
                })
        } else if let Some(reasons) = held {
            Why::Held(
                reasons
                    .iter()
                    .find(|r| !r.contains(": "))
                    .cloned()
                    .unwrap_or_else(|| "cap".into()),
            )
        } else if let Some(by) = chained_by.get(name) {
            Why::ChainedBy(by.clone())
        } else {
            Why::NotCovered
        };
        let viewports = match &journey.viewports {
            Some(viewports) => viewports.clone(),
            None if journey.desktop_only => vec!["desktop".into()],
            None => Vec::new(),
        };
        journeys.push(Journey {
            name: name.clone(),
            title: journey
                .goal
                .clone()
                .unwrap_or_else(|| journey.title.clone()),
            persona: journey.persona.clone(),
            tags: journey.tags.clone(),
            selected: selected.is_some(),
            why,
            chain: chains.get(name).cloned().unwrap_or_else(|| {
                journey
                    .after
                    .iter()
                    .cloned()
                    .chain([name.clone()])
                    .collect()
            }),
            paths: journey.covers.paths.clone(),
            routes: journey.covers.routes.clone(),
            preconditions: journey.preconditions.clone(),
            steps: journey
                .steps
                .iter()
                .map(|step| JourneyStep {
                    title: step.action.clone(),
                    route: step.at.clone().unwrap_or_default(),
                    expect: step.expect.clone().unwrap_or_default(),
                })
                .collect(),
            success: journey.success.clone(),
            viewports,
            baseline: None,
        });
    }
    // Selected journeys first, then chained, held and uncovered ones.
    journeys.sort_by_key(|j| match j.why {
        Why::Smoke | Why::Covers(_) | Why::Guidance(_) | Why::Drift => 0,
        Why::ChainedBy(_) => 1,
        Why::Held(_) => 2,
        Why::NotCovered => 3,
    });

    let viewports: Vec<String> = project
        .config
        .browser
        .viewports
        .iter()
        .filter_map(|v| v.resolve().ok().map(|v| v.name))
        .collect();
    let cells = viewports
        .iter()
        .flat_map(|v| {
            project
                .config
                .browser
                .color_schemes
                .iter()
                .map(move |scheme| CellId::new(v.as_str(), scheme.as_str()))
        })
        .collect();
    let personas = project
        .config
        .personas
        .iter()
        .map(|p| {
            let missing: Vec<&str> = [&p.username_env, &p.password_env]
                .into_iter()
                .flatten()
                .filter(|name| std::env::var_os(name).is_none())
                .map(String::as_str)
                .collect();
            let login = p.username_env.is_some() || p.password_env.is_some();
            Persona {
                name: p.name.clone(),
                ready: missing.is_empty(),
                note: if !missing.is_empty() {
                    format!("missing {}", missing.join(", "))
                } else if login {
                    "creds ok".into()
                } else {
                    "no login".into()
                },
            }
        })
        .collect();
    let shown = super::review::shown(SelectionKind::WorkingTree, String::new(), &changes);
    let changed_files = shown
        .listed
        .iter()
        .map(|f| ChangedFile {
            status: f.status,
            path: f.path.clone(),
            added: f.added as u32,
            note: (f.path.ends_with("REVIEW.md") || f.path.starts_with(".rio/qa/"))
                .then(|| "guidance edited".to_owned()),
        })
        .collect();
    let candidates: Vec<ProposedItem> = project
        .candidates
        .keys()
        .map(|name| ProposedItem {
            new: !project.journeys.contains_key(name),
            journey: name.clone(),
            note: project.candidates[name]
                .sync_reason
                .clone()
                .unwrap_or_else(|| "proposed".into()),
        })
        .collect();
    let stale = project.stale_journeys(&base, &head, &changed);
    let budget = profile
        .as_ref()
        .map(|p| Budget {
            tokens: p.profile.budget.fast.tokens.unwrap_or(0),
            per_voter: p.profile.budget.fast.verify_tokens.unwrap_or(0),
            preset: "fast".into(),
        })
        .unwrap_or_default();
    let home = repo
        .root()
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(JourneysData {
        project: home,
        config: ".rio/qa.yaml".into(),
        mode: if full { "full" } else { "changed" }.into(),
        runtime: format!("{} · pod", project.config.app.packaging),
        personas,
        cells,
        changed: changed_files,
        cap: input.max_journeys as u32,
        journeys,
        proposed: (!candidates.is_empty()).then(|| Proposed {
            file: ".rio/qa/journeys/*.proposed.yaml".into(),
            items: candidates,
        }),
        sync: SyncStatus {
            command: "rio qa sync --check".into(),
            exit: i32::from(!stale.is_empty()),
            items: stale
                .into_iter()
                .map(|(journey, reasons)| SyncItem {
                    journey,
                    reason: reasons.join(", "),
                })
                .collect(),
        },
        seed: Seed {
            cached: false,
            fingerprint: "?".into(),
            note: "rio qa seed status checks the snapshot".into(),
        },
        harness: Harness {
            name: project.config.harness.default.clone(),
            via: if config.endpoint_url.is_some() {
                "gateway".into()
            } else {
                "local".into()
            },
            egress: "deny-all".into(),
            doubles: project
                .fixtures
                .as_ref()
                .map(|f| f.services.iter().map(|s| s.name.clone()).collect())
                .unwrap_or_default(),
        },
        budget,
        ms_per_cell: (input.cell_wall_seconds * 1000) as u32,
    })
}

/// The cell address of a `qa:cancel:` or `qa:rerun:` step, for messages.
fn cell_of(step: &str) -> &str {
    step.splitn(3, ':').nth(2).unwrap_or(step)
}

/// The `rio qa` arguments that run one cell again, from `qa:rerun:<journey>/<viewport>/<scheme>`.
pub fn rerun_args(step: &str) -> Option<Vec<String>> {
    let cell = step.strip_prefix("qa:rerun:")?;
    let (journey, rest) = cell.split_once('/')?;
    rest.contains('/').then(|| {
        ["qa", "--journey", journey, "--cell", rest]
            .map(str::to_owned)
            .to_vec()
    })
}

/// A request to the running QA queue: `qa:pause`, `qa:resume`, `qa:cancel:…`.
pub fn is_control(step: &str) -> bool {
    matches!(step, "qa:pause" | "qa:resume") || step.starts_with("qa:cancel:")
}

/// Applies a [`is_control`] step to the running review's QA queue. A run on
/// an endpoint, or no run, cannot take it, and the screen shows the queue as
/// it was.
pub fn control(step: &str, control: Option<&rio_qa::QaControl>) -> Outcome {
    let Some(control) = control else {
        return Outcome::Failed("no QA run is in progress".into());
    };
    if control.detached() {
        return Outcome::Failed(
            "this QA run is on the endpoint, which runs its queue to the end; ^C stops it and keeps a partial report".into(),
        );
    }
    match step {
        "qa:pause" => {
            control.set_paused(true);
            Outcome::Ok(
                "paused: the running cell finishes, then the queue waits (p resumes); the run's time budget keeps counting".into(),
            )
        }
        "qa:resume" => {
            control.set_paused(false);
            Outcome::Ok("resumed".into())
        }
        _ => {
            let cell = cell_of(step);
            let mut parts = cell.rsplitn(3, '/');
            let (Some(color_scheme), Some(viewport), Some(journey)) =
                (parts.next(), parts.next(), parts.next())
            else {
                return Outcome::Failed(format!("{cell} is not a journey/viewport/scheme cell"));
            };
            control.cancel(rio_qa::QaCellRef {
                journey: journey.into(),
                viewport: viewport.into(),
                color_scheme: color_scheme.into(),
            });
            Outcome::Ok(format!("cancelling {cell}; it is recorded cancelled"))
        }
    }
}

/// Runs a `qa:*` step. Steps that run a `rio qa` subcommand do it on a thread
/// of their own (repository handles stay on one thread) and answer with a
/// short text; nothing is printed to the screen.
pub fn step(
    name: &str,
    staged: bool,
    base: Option<String>,
    runtime: &tokio::runtime::Handle,
    reply: &Sender<Msg>,
) -> bool {
    let selection = || crate::SelectionArgs {
        staged,
        base: base.clone(),
    };
    let command = match name {
        "qa:sync" => qa::QaCommand::Sync {
            check: true,
            selection: selection(),
        },
        "qa:validate" => qa::QaCommand::Validate,
        "qa:init" => qa::QaCommand::Init {
            force: false,
            accept_contract: false,
        },
        "qa:diff" => {
            let _ = reply.send(Msg::Done(match proposed_diff() {
                Ok(text) => Outcome::Ok(text),
                Err(error) => Outcome::Failed(rio_core::redact(&format!("{error:#}"))),
            }));
            return true;
        }
        "qa:accept" => {
            return unsupported(
                reply,
                "accepting proposed journeys is not supported yet: review each \
                 .rio/qa/journeys/<name>.proposed.yaml and rename it to <name>.yaml",
            );
        }
        _ => return false,
    };
    let label = name.trim_start_matches("qa:").to_owned();
    let reply = reply.clone();
    let runtime = runtime.clone();
    std::thread::spawn(move || {
        let outcome = runtime.block_on(qa::evaluate(command));
        let _ = reply.send(Msg::Done(match outcome {
            Ok((value, status)) => {
                let text = summary(&label, &value, status);
                if status == 0 {
                    Outcome::Ok(text)
                } else {
                    Outcome::Failed(text)
                }
            }
            Err(error) => Outcome::Failed(format!(
                "rio qa {label}: {}",
                rio_core::redact(&format!("{error:#}"))
            )),
        }));
    });
    true
}

fn unsupported(reply: &Sender<Msg>, message: &str) -> bool {
    let _ = reply.send(Msg::Done(Outcome::Failed(message.into())));
    true
}

/// One line for the footer from a `rio qa` subcommand's document.
fn summary(label: &str, value: &Value, status: u8) -> String {
    let text = match label {
        "sync" => {
            let stale: Vec<&String> = value["possibly_stale"]
                .as_object()
                .map(|o| o.keys().collect())
                .unwrap_or_default();
            if stale.is_empty() {
                "sync: clean".to_owned()
            } else {
                format!(
                    "sync: {} need review ({}); rio qa sync reconciles them",
                    stale.len(),
                    stale
                        .iter()
                        .map(|s| s.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            }
        }
        "validate" => format!(
            "valid · {} journeys · {} candidates · {} warnings",
            value["journeys"],
            value["candidates"],
            value["warnings"].as_array().map_or(0, Vec::len)
        ),
        _ => {
            let next = value["next"].as_str().or(value["status"].as_str());
            match next {
                Some(next) => format!("rio qa {label}: {next}"),
                None => format!("rio qa {label} finished (exit {status})"),
            }
        }
    };
    rio_core::redact(&text)
}

/// Proposed journeys against the committed ones: new or how many lines change.
fn proposed_diff() -> anyhow::Result<String> {
    let cwd = std::env::current_dir()?;
    let repo = GixRepo::discover(&cwd)?;
    let head: QaSnapshot = qa::snapshot(repo.working_tree()?)?;
    let mut parts = Vec::new();
    for (path, bytes) in &head {
        let Some(name) = path
            .strip_prefix(".rio/qa/journeys/")
            .and_then(|p| p.strip_suffix(".proposed.yaml"))
        else {
            continue;
        };
        let committed = head.get(&format!(".rio/qa/journeys/{name}.yaml"));
        match committed {
            None => parts.push(format!("+ {name} (new)")),
            Some(old) => {
                let (old, new) = (
                    String::from_utf8_lossy(old).into_owned(),
                    String::from_utf8_lossy(bytes).into_owned(),
                );
                let changed = similar::TextDiff::from_lines(&old, &new)
                    .iter_all_changes()
                    .filter(|c| c.tag() != similar::ChangeTag::Equal)
                    .count();
                parts.push(format!("~ {name} ({changed} lines)"));
            }
        }
    }
    anyhow::ensure!(!parts.is_empty(), "no proposed journeys to diff");
    Ok(parts.join(" · "))
}

/// The UX recommendations of a QA report as Markdown, advice only.
pub fn ux_markdown(report: &rio_core::Report) -> Option<String> {
    let ux = UxData::from_qa(report.qa.as_ref()?)?;
    let mut md = String::from(
        "# UX recommendations\n\nAdvice from rio qa: none of these changes the review's status or exit code.\n",
    );
    for rec in &ux.recommendations {
        md.push('\n');
        md.push_str(&rec.markdown());
    }
    Some(md)
}

/// One line after the UI closes: the cells by outcome and the advice count.
pub fn cells_line(report: &rio_core::Report) -> Option<String> {
    let qa = report.qa.as_ref()?;
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut journeys = 0;
    for journey in qa["journeys"].as_array().into_iter().flatten() {
        journeys += 1;
        for cell in journey["cells"].as_array().into_iter().flatten() {
            *counts
                .entry(
                    cell["outcome"]
                        .as_str()
                        .unwrap_or("unknown")
                        .replace('_', " "),
                )
                .or_default() += 1;
        }
    }
    let cells: Vec<String> = counts.iter().map(|(k, n)| format!("{n} {k}")).collect();
    let advice = UxData::from_qa(qa).map_or(0, |ux| ux.recommendations.len());
    Some(format!(
        "qa · {journeys} journeys · {} · {advice} UX recommendations (advice)\n",
        if cells.is_empty() {
            "no cells ran".to_owned()
        } else {
            cells.join(" · ")
        }
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pause_and_cancel_reach_a_local_run_and_are_refused_elsewhere() {
        assert!(
            is_control("qa:pause")
                && is_control("qa:cancel:a/b/c")
                && !is_control("qa:rerun:a/b/c")
        );
        assert!(matches!(control("qa:pause", None), Outcome::Failed(m) if m.contains("no QA run")));
        let local = rio_qa::QaControl::default();
        assert!(matches!(control("qa:pause", Some(&local)), Outcome::Ok(_)));
        assert!(local.paused());
        assert!(matches!(control("qa:resume", Some(&local)), Outcome::Ok(_)));
        assert!(!local.paused());
        assert!(matches!(
            control("qa:cancel:checkout/mobile/dark", Some(&local)),
            Outcome::Ok(m) if m.contains("checkout/mobile/dark")
        ));
        assert!(matches!(
            control("qa:cancel:checkout", Some(&local)),
            Outcome::Failed(_)
        ));
        let endpoint = rio_qa::QaControl::default();
        endpoint.detach();
        assert!(
            matches!(control("qa:pause", Some(&endpoint)), Outcome::Failed(m) if m.contains("endpoint"))
        );
        assert!(!endpoint.paused());
    }

    #[test]
    fn a_rerun_runs_the_journey_on_its_one_cell() {
        assert_eq!(
            rerun_args("qa:rerun:checkout/mobile/dark").unwrap(),
            ["qa", "--journey", "checkout", "--cell", "mobile/dark"]
        );
        assert_eq!(rerun_args("qa:rerun:checkout"), None);
        assert_eq!(rerun_args("qa:rerun:checkout/mobile"), None);
    }
}

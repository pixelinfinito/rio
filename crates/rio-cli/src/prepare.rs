//! `rio prepare` (internal): the hosted preparation of a pull request review.
//! It runs in a clone that holds both commits and builds the submission that
//! `rio review` would build for the same trees. Policy comes from the profile
//! at the PR's base commit, never from the head the PR proposes.
use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use clap::Args;
use rio_git::{ChangeSet, GixRepo, Repo, Selection, Tree};
use serde_json::json;
use std::{collections::BTreeMap, path::Path};

#[derive(Args)]
pub struct PrepareArgs {
    /// Base commit (the pull request's merge base).
    #[arg(long, value_name = "SHA")]
    base: String,
    /// Head commit of the pull request.
    #[arg(long, value_name = "SHA")]
    head: String,
    /// Repository key for the finding registry (the endpoint sets its own for PRs).
    #[arg(long)]
    repository: Option<String>,
    /// Upload the snapshot and submit with RIO_ENDPOINT_URL and RIO_API_TOKEN.
    #[arg(long, conflicts_with = "output", required_unless_present = "output")]
    submit: bool,
    /// Write the submission and both trees for a networked uploader instead.
    #[arg(long, value_name = "DIR")]
    output: Option<std::path::PathBuf>,
}

fn commit(value: &str) -> Result<&str> {
    ensure!(
        value.len() == 40 && value.bytes().all(|b| b.is_ascii_hexdigit()),
        "expected a 40-character commit SHA"
    );
    Ok(value)
}

pub fn changes(repo: &GixRepo, base: &str, head: &str) -> Result<ChangeSet> {
    Ok(ChangeSet {
        selection: Selection::Branch {
            reference: base.to_owned(),
        },
        base_id: base.to_owned(),
        head_id: head.to_owned(),
        base: repo.read_tree(base)?,
        head: repo.read_tree(head)?,
    })
}

/// Writes a tree as plain files; links go to `links` as base64 targets, as the
/// runner's `load_tree` reads them back. Submodule entries are not content.
fn write_tree(directory: &Path, tree: &Tree, links: &mut BTreeMap<String, String>) -> Result<()> {
    std::fs::create_dir_all(directory)?;
    for (path, entry) in tree {
        rio_git::validate_tree_path(path)?;
        match entry.mode {
            0o120000 => {
                links.insert(path.clone(), STANDARD.encode(&entry.content));
            }
            0o100644 | 0o100755 => {
                let target = directory.join(path);
                std::fs::create_dir_all(target.parent().context("tree path")?)?;
                std::fs::write(&target, &entry.content)?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(
                        &target,
                        std::fs::Permissions::from_mode(if entry.mode == 0o100755 {
                            0o755
                        } else {
                            0o644
                        }),
                    )?;
                }
            }
            _ => {}
        }
    }
    Ok(())
}

pub async fn run(args: PrepareArgs) -> u8 {
    match prepare(args).await {
        Ok(()) => 0,
        Err(error) => {
            eprintln!(
                "prepare failed: {}",
                rio_core::redact(&format!("{error:#}"))
            );
            1
        }
    }
}

async fn prepare(args: PrepareArgs) -> Result<()> {
    let (base, head) = (commit(&args.base)?, commit(&args.head)?);
    let repo = GixRepo::discover(std::env::current_dir()?)?;
    let changes = changes(&repo, base, head)?;
    let profile = rio_engine::base_profile(&changes.base)?;
    let snapshot = rio_git::Snapshot::from_changes(&changes);
    let run_id = format!("prepare-{}", &snapshot.key[..16]);
    let prepared = rio_engine::build_submission(
        &changes,
        &profile,
        &rio_engine::SubmissionOptions {
            graph_budget: crate::endpoint::graph_budget(),
            deep: false,
            fork: false,
            nightly: false,
            repository: args.repository.clone(),
            run_id,
        },
    )?
    .context("the pull request changes nothing reviewable")?;
    if let Some(output) = args.output {
        std::fs::create_dir_all(&output)?;
        let mut links = json!({});
        for (version, tree) in [("base", &changes.base), ("head", &changes.head)] {
            let mut map = BTreeMap::new();
            write_tree(&output.join(version), tree, &mut map)?;
            links[version] = json!(map);
        }
        std::fs::write(output.join("links.json"), serde_json::to_vec(&links)?)?;
        std::fs::write(
            output.join("submission.json"),
            serde_json::to_vec(&prepared.submission)?,
        )?;
        eprintln!("prepared submission written to {}", output.display());
        return Ok(());
    }
    ensure!(args.submit, "choose --submit or --output");
    let url = std::env::var("RIO_ENDPOINT_URL").context("set RIO_ENDPOINT_URL")?;
    let token = std::env::var("RIO_API_TOKEN").context("set RIO_API_TOKEN")?;
    let client = rio_client::Client::new(&url, token)?;
    let upload = client.upload_snapshot(&changes.base, &changes.head).await?;
    let mut submission = prepared.submission;
    submission["snapshot_id"] = json!(upload.id);
    let id = client.submit(&submission).await?;
    println!("{}", json!({"id": id}));
    Ok(())
}

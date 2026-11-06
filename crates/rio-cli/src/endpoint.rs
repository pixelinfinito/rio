use anyhow::{Context, Result, ensure};
use rio_core::{Report, ReportStatus, ReviewHeader, ReviewMode};
use rio_engine::{CacheOptions, RunCache, profile_excludes};
use rio_git::{ChangeSet, Selection, Snapshot, diff};
use rio_graph::{GraphBuilder, GraphOptions};
use rio_profile::ResolvedProfile;
use serde_json::json;
use std::{collections::BTreeSet, path::Path, time::Duration};

use crate::lineage::{BranchLineage, LocalLineage};
use tokio_util::sync::CancellationToken;

pub struct EndpointRequest<'a> {
    pub url: &'a str,
    pub config_dir: &'a Path,
    pub changes: ChangeSet,
    pub profile: ResolvedProfile,
    pub cache: CacheOptions,
    pub deep: bool,
    pub fork: bool,
    /// `--since-last` branch lineage, with the reset request.
    pub lineage: Option<BranchLineage>,
}
pub struct EndpointOutcome {
    pub report: Report,
    /// Identities the lineage had posted before this review (for marking
    /// held-back findings); `None` outside lineages.
    pub posted: Option<BTreeSet<String>>,
}
/// Saved tokens are bound to the configured URL; never send them elsewhere.
pub fn client(url: &str, config_dir: &Path) -> Result<rio_client::Client> {
    let token = match std::env::var("RIO_API_TOKEN").ok() {
        Some(token) => Some(token),
        None => crate::deployment::endpoint_token(config_dir, url)?,
    }
    .context("set RIO_API_TOKEN or run rio init --token-stdin")?;
    rio_client::Client::new(url, token.trim().into())
}
/// The lineage state before this review: the local copy, else the endpoint's
/// state (stored as the new local copy). A missing copy is never a reset.
async fn lineage_before(
    client: &rio_client::Client,
    cache: &CacheOptions,
    lineage: &BranchLineage,
) -> Result<Option<LocalLineage>> {
    if lineage.reset {
        return Ok(None);
    }
    if let Some(copy) = LocalLineage::load(cache, lineage) {
        return Ok(Some(copy));
    }
    let Some(state) = client
        .lineage(&lineage.repository, "branch", &lineage.branch)
        .await?
    else {
        return Ok(None);
    };
    let copy = LocalLineage::from_endpoint(lineage, state)?;
    copy.save(cache)?;
    Ok(Some(copy))
}
pub async fn review(
    request: EndpointRequest<'_>,
    cancellation: CancellationToken,
) -> Result<EndpointOutcome> {
    let EndpointRequest {
        url,
        config_dir,
        changes,
        profile,
        cache,
        deep,
        fork,
        lineage,
    } = request;
    let client = client(url, config_dir)?;
    let delta = diff(&changes, &profile_excludes(&profile))?;
    if delta.files.is_empty() {
        return Ok(EndpointOutcome {
            report: Report::empty(ReportStatus::NoChanges),
            posted: None,
        });
    }
    let snapshot = Snapshot::from_changes(&changes);
    let id = blake3::hash(format!("{}|{}", snapshot.key, profile.hash()?).as_bytes()).to_hex()
        [..16]
        .to_owned();
    let cache = RunCache::begin(cache, id.clone())?;
    cache.reference(&format!("snapshots/{}.tar.zst", snapshot.key))?;
    snapshot.write(&cache.options.dir)?;
    cache.write("profile.resolved.yaml", profile.to_yaml()?.as_bytes())?;
    let guidance = rio_engine::owner_guidance(&changes.head, &delta);
    cache.write(
        "owner_guidance.json",
        &serde_json::to_vec_pretty(&guidance)?,
    )?;
    let graph_step = profile.profile.step("rio/graph");
    let options = GraphOptions {
        hops: graph_step
            .and_then(|s| s.options["hops"].as_u64())
            .unwrap_or(2) as usize,
        max_nodes: graph_step
            .and_then(|s| s.options["max_nodes"].as_u64())
            .unwrap_or(2000) as usize,
        exclude: profile_excludes(&profile),
    };
    // Snapshot parsing only. Repository commands run exclusively in the remote runner.
    let graph = GraphBuilder::default().build(&changes, &delta, &options)?;
    graph.write(&cache.path)?;
    let mut report = Report::empty(ReportStatus::Complete);
    report.review = ReviewHeader {
        id: Some(id),
        run_id: Some(cache.run_id.clone()),
        mode: Some(match changes.selection {
            Selection::WorkingTree => ReviewMode::WorkingTree,
            Selection::Staged => ReviewMode::Staged,
            Selection::Branch { .. } => ReviewMode::Branch,
        }),
        base: Some(changes.base_id.clone()),
        head: Some(changes.head_id.clone()),
        profile: Some(profile.profile.name.clone()),
        chain: Some(profile.chain.clone()),
        ..Default::default()
    };
    report.impact = graph.impact(options.hops);
    let snapshot_id = client.upload_snapshot(&changes.base, &changes.head).await?;
    let changed:Vec<_>=delta.files.iter().filter(|f|f.excluded.is_none()).map(|f|json!({"path":f.path,"old_path":f.old_path,"lines_changed":f.hunks.iter().map(|h|h.base.count.max(h.head.count) as u64).sum::<u64>()})).collect();
    let before = match &lineage {
        Some(lineage) => Some(lineage_before(&client, &cache.options, lineage).await?),
        None => None,
    };
    let mut submission = json!({"protocol":1,"snapshot_id":snapshot_id,"profile":profile,"report":report,"changed":changed,"graphs":{"base":graph.base,"head":graph.head},"owner_guidance":guidance,"intent":format!("Review the change from {} to {}",changes.base_id,changes.head_id),"fork":fork,"mode":if deep{"deep"}else{"fast"}});
    if let Some(lineage) = &lineage {
        submission["lineage"] = lineage.submission();
    }
    let remote_id = client.submit(&submission).await?;
    eprintln!("Endpoint review: {remote_id}");
    cache.write(
        "endpoint.json",
        &serde_json::to_vec(&json!({"id":remote_id,"url":url}))?,
    )?;
    // Triage can select either budget after submission. Allow the longest configured deadline.
    let timeout = [&profile.profile.budget.fast]
        .into_iter()
        .chain(profile.profile.budget.deep.as_ref())
        .map(|budget| rio_profile::parse_duration(&budget.wall_time).map_err(anyhow::Error::msg))
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .max()
        .unwrap_or_default()
        + Duration::from_secs(60);
    let mut report = client.wait(&remote_id, cancellation, timeout).await?;
    ensure!(
        report.review.id
            == submission["report"]["review"]["id"]
                .as_str()
                .map(str::to_owned),
        "endpoint returned a different review"
    );
    let audit = client.audit(&remote_id).await?;
    cache.write(
        "verification/audit.json",
        &serde_json::to_vec_pretty(&audit)?,
    )?;
    report = serde_json::from_slice(&rio_core::render_json(&report).map_err(anyhow::Error::msg)?)?;
    cache.finish(&report)?;
    let posted = match (&lineage, before) {
        (Some(lineage), before) => {
            let before = before.flatten();
            match LocalLineage::after_review(before.as_ref(), lineage, &report, &snapshot_id)? {
                Some(copy) => copy.save(&cache.options)?,
                None => eprintln!(
                    "Warning: the endpoint returned no lineage state for --since-last; the local lineage copy was not updated"
                ),
            }
            Some(before.map(|copy| copy.posted).unwrap_or_default())
        }
        (None, _) => None,
    };
    // Endpoint-only users never run the local engine, which otherwise prunes;
    // keep lineage copies and run records within the cache's age and size rules.
    if let Err(error) = rio_engine::prune_cache(&cache.options, None) {
        eprintln!("Warning: cache pruning failed: {error:#}");
    }
    Ok(EndpointOutcome { report, posted })
}

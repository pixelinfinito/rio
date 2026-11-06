use anyhow::{Context, Result, ensure};
use rio_core::{Report, ReportStatus, ReviewHeader, ReviewMode};
use rio_engine::{CacheOptions, RunCache, profile_excludes};
use rio_git::{ChangeSet, Selection, Snapshot, diff};
use rio_graph::{GraphBuilder, GraphOptions};
use rio_profile::ResolvedProfile;
use serde_json::json;
use std::{path::Path, time::Duration};
use tokio_util::sync::CancellationToken;

pub struct EndpointRequest<'a> {
    pub url: &'a str,
    pub config_dir: &'a Path,
    pub changes: ChangeSet,
    pub profile: ResolvedProfile,
    pub cache: CacheOptions,
    pub deep: bool,
    pub fork: bool,
}
pub async fn review(
    request: EndpointRequest<'_>,
    cancellation: CancellationToken,
) -> Result<Report> {
    let EndpointRequest {
        url,
        config_dir,
        changes,
        profile,
        cache,
        deep,
        fork,
    } = request;
    let token = std::env::var("RIO_API_TOKEN").ok();
    let token = match token {
        Some(token) => Some(token),
        // Saved tokens are bound to the configured URL; never send them elsewhere.
        None => crate::deployment::endpoint_token(config_dir, url)?,
    }
    .context("set RIO_API_TOKEN or run rio init --token-stdin")?;
    let client = rio_client::Client::new(url, token.trim().into())?;
    let delta = diff(&changes, &profile_excludes(&profile))?;
    if delta.files.is_empty() {
        return Ok(Report::empty(ReportStatus::NoChanges));
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
    let submission = json!({"protocol":1,"snapshot_id":snapshot_id,"profile":profile,"report":report,"changed":changed,"graphs":{"base":graph.base,"head":graph.head},"owner_guidance":guidance,"intent":format!("Review the change from {} to {}",changes.base_id,changes.head_id),"fork":fork,"mode":if deep{"deep"}else{"fast"}});
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
    Ok(report)
}

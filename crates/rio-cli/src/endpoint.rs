use anyhow::{Context, Result, ensure};
use rio_core::{Report, ReportStatus};
use rio_engine::{CacheOptions, RunCache, profile_excludes};
use rio_git::{ChangeSet, Snapshot, diff};
use rio_profile::ResolvedProfile;
use serde_json::json;
use std::{collections::BTreeSet, path::Path, time::Duration};

use crate::lineage::{BranchLineage, LocalLineage};
use tokio_util::sync::CancellationToken;
/// Wall-time budget for building the impact graph before an endpoint review.
pub const GRAPH_BUDGET: std::time::Duration = std::time::Duration::from_secs(120);

pub struct EndpointRequest<'a> {
    pub url: &'a str,
    pub config_dir: &'a Path,
    pub changes: ChangeSet,
    pub profile: ResolvedProfile,
    pub cache: CacheOptions,
    pub deep: bool,
    pub fork: bool,
    pub nightly: bool,
    /// Repository key for the finding registry (`origin`, else the directory name).
    pub repository: Option<String>,
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
        nightly,
        repository,
        lineage,
    } = request;
    let client = client(url, config_dir)?;
    if diff(&changes, &profile_excludes(&profile))?
        .files
        .is_empty()
    {
        return Ok(EndpointOutcome {
            report: Report::empty(ReportStatus::NoChanges),
            posted: None,
        });
    }
    let snapshot = Snapshot::from_changes(&changes);
    let id = rio_engine::review_id(&snapshot.key, &profile)?;
    // Triage can select either budget after submission. Allow the longest configured deadline.
    let timeout = review_timeout(&profile)?;
    let cache = RunCache::begin(cache, id.clone())?;
    // Snapshot parsing only. Repository commands run exclusively in the remote runner.
    let Some(prepared) = rio_engine::build_submission(
        &changes,
        &profile,
        &rio_engine::SubmissionOptions {
            graph_budget: graph_budget(),
            deep,
            fork,
            nightly,
            repository: repository.clone(),
            run_id: cache.run_id.clone(),
        },
    )?
    else {
        return Ok(EndpointOutcome {
            report: Report::empty(ReportStatus::NoChanges),
            posted: None,
        });
    };
    cache.reference(&format!("snapshots/{}.tar.zst", snapshot.key))?;
    snapshot.write(&cache.options.dir)?;
    cache.write("profile.resolved.yaml", profile.to_yaml()?.as_bytes())?;
    cache.write(
        "owner_guidance.json",
        &serde_json::to_vec_pretty(&prepared.guidance)?,
    )?;
    prepared.graphs.write(&cache.path)?;
    let upload = client.upload_snapshot(&changes.base, &changes.head).await?;
    eprintln!(
        "snapshot: uploaded {} in {} new contents ({} in {} distinct contents, {} files total)",
        rio_client::format_bytes(upload.uploaded_bytes),
        rio_client::format_count(upload.uploaded_contents as u64),
        rio_client::format_bytes(upload.bytes),
        rio_client::format_count(upload.contents as u64),
        rio_client::format_count(upload.files as u64)
    );
    let snapshot_id = upload.id;
    let before = match &lineage {
        Some(lineage) => Some(lineage_before(&client, &cache.options, lineage).await?),
        None => None,
    };
    let mut submission = prepared.submission;
    submission["snapshot_id"] = json!(snapshot_id);
    if let Some(lineage) = &lineage {
        submission["lineage"] = lineage.submission();
    }
    let remote_id = client.submit(&submission).await?;
    eprintln!("Endpoint review: {remote_id}");
    cache.write(
        "endpoint.json",
        &serde_json::to_vec(&json!({"id":remote_id,"url":url}))?,
    )?;
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
    cache_qa_records(&cache, &audit)?;
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

fn cache_qa_records(cache: &RunCache, audit: &serde_json::Value) -> Result<()> {
    // Fixed record names only. The endpoint cannot choose a local output path,
    // and artifact keys remain metadata rather than triggering downloads.
    for name in [
        "plan.json",
        "outcomes.json",
        "manifest.json",
        "recommendations.json",
        "assessment.json",
        "observations.json",
        "observation-candidates.json",
        "baseline.json",
        "audit.json",
        "verification.json",
        "recommendation-history.json",
        "policy.json",
    ] {
        if let Some(record) = audit["qa_records"].get(name) {
            cache.write(&format!("qa/{name}"), &serde_json::to_vec_pretty(record)?)?;
        }
    }
    Ok(())
}

/// The longest configured review deadline plus a minute: triage can select
/// either budget after submission.
pub fn review_timeout(profile: &ResolvedProfile) -> Result<Duration> {
    Ok([false, true]
        .into_iter()
        .map(|deep| {
            profile
                .profile
                .review_wall(deep, rio_profile::QA_VERIFICATION_RESERVE)
                .map_err(anyhow::Error::msg)
        })
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .max()
        .unwrap_or_default()
        + Duration::from_secs(60))
}

/// The graph budget, overridable with `RIO_GRAPH_BUDGET_SECS`.
pub fn graph_budget() -> Duration {
    std::env::var("RIO_GRAPH_BUDGET_SECS")
        .ok()
        .and_then(|value| value.parse().ok())
        .map_or(GRAPH_BUDGET, Duration::from_secs)
}

#[cfg(test)]
mod qa_record_tests {
    use super::*;
    #[test]
    fn hosted_records_keep_keys_under_the_run_without_downloading_evidence() {
        let root = tempfile::tempdir().unwrap();
        let cache =
            RunCache::begin(CacheOptions::for_repository(root.path()), "a".repeat(16)).unwrap();
        let manifest = json!({"artifacts":[{"id":"shot","key":"qa/tenant/review/run/shot.png","expires_at":1800000000000_u64}]});
        cache_qa_records(&cache, &json!({"qa_records":{"manifest.json":manifest,"plan.json":{"selected":{"checkout":["explicit"]}},
            "outcomes.json":[],"../../escape.json":true,"shot.png":"must not be materialized"}})).unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(
                &std::fs::read(cache.path.join("qa/manifest.json")).unwrap()
            )
            .unwrap(),
            manifest
        );
        assert!(cache.path.join("qa/plan.json").is_file());
        assert!(cache.path.join("qa/outcomes.json").is_file());
        assert!(!cache.path.join("qa/shot.png").exists());
        assert!(!cache.path.parent().unwrap().join("escape.json").exists());
    }
}

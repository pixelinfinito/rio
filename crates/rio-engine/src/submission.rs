//! The endpoint submission (`POST /v1/reviews`), built identically by
//! `rio review` against an endpoint and by the hosted `rio prepare` of a pull
//! request: the same changed files, report header, owner guidance, graphs and
//! intent for the same trees and profile.
use anyhow::Result;
use rio_core::{Report, ReportStatus, ReviewHeader, ReviewMode};
use rio_git::{ChangeSet, Selection, diff};
use rio_graph::{GraphBuilder, GraphOptions, GraphSlices};
use rio_profile::{ProfileLoader, ResolvedProfile};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

use crate::{profile_excludes, review_owner_guidance};

/// JSON bytes per graph version in the submission. Edges dominate large slices
/// (tens of thousands at two hops in big repositories), and the endpoint caps the
/// submission body; the runner rebuilds the complete graph from the snapshot.
pub const SUBMITTED_GRAPH_BYTES: usize = 2 * 1024 * 1024;

pub struct SubmissionOptions {
    /// Wall time allowed for building the impact graph.
    pub graph_budget: Duration,
    pub deep: bool,
    pub fork: bool,
    /// Started by the nightly evaluation job (the council's `nightly` trigger).
    pub nightly: bool,
    /// Repository key for the finding registry.
    pub repository: Option<String>,
    /// The local run id (`report.review.run_id`).
    pub run_id: String,
}

pub struct Prepared {
    /// The submission without `snapshot_id`, which the upload decides.
    pub submission: Value,
    /// The complete graphs before the submission bound.
    pub graphs: GraphSlices,
    pub guidance: Vec<crate::OwnerGuidance>,
}

/// The profile resolved from a tree's `.rio/` with no personal configuration.
/// A pull request is reviewed under the profile of its base commit, so the
/// change under review cannot change its own policy.
pub fn base_profile(base: &rio_git::Tree) -> Result<ResolvedProfile> {
    let root = tempfile::tempdir()?;
    let config = tempfile::tempdir()?;
    for (path, entry) in base.range(".rio/".to_owned()..".rio0".to_owned()) {
        // Symbolic links and submodules never reach the profile loader.
        if entry.mode != 0o100644 && entry.mode != 0o100755 {
            continue;
        }
        rio_git::validate_tree_path(path)?;
        let target = root.path().join(path);
        std::fs::create_dir_all(target.parent().expect("profile paths have a parent"))?;
        std::fs::write(target, &entry.content)?;
    }
    ProfileLoader::new(
        Some(root.path().to_owned()),
        config.path().to_owned(),
        root.path().to_owned(),
    )
    .load(None)
    .map_err(|error| anyhow::anyhow!("invalid profile at the base commit: {error}"))
}

/// The review id the CLI and the endpoint agree on for a snapshot and profile.
pub fn review_id(snapshot_key: &str, profile: &ResolvedProfile) -> Result<String> {
    Ok(
        blake3::hash(format!("{snapshot_key}|{}", profile.hash()?).as_bytes()).to_hex()[..16]
            .to_owned(),
    )
}

/// Builds the submission, or `None` when the change set is empty after the
/// profile's exclusions.
pub fn build_submission(
    changes: &ChangeSet,
    profile: &ResolvedProfile,
    options: &SubmissionOptions,
) -> Result<Option<Prepared>> {
    let delta = diff(changes, &profile_excludes(profile))?;
    if delta.files.is_empty() && !profile.profile.qa_enabled() {
        return Ok(None);
    }
    let snapshot = rio_git::Snapshot::from_changes(changes);
    let id = review_id(&snapshot.key, profile)?;
    let guidance = review_owner_guidance(&changes.head, &delta, profile.profile.qa_enabled());
    let graph_step = profile.profile.step("rio/graph");
    let graph_options = GraphOptions {
        hops: graph_step
            .and_then(|s| s.options["hops"].as_u64())
            .unwrap_or(2) as usize,
        max_nodes: graph_step
            .and_then(|s| s.options["max_nodes"].as_u64())
            .unwrap_or(2000) as usize,
        exclude: profile_excludes(profile),
    };
    // Snapshot parsing only; repository commands run exclusively in the runner.
    // The graph has a budget so a large repository yields a truncated graph, not a hang.
    let deadline = Instant::now() + options.graph_budget;
    let graphs = GraphBuilder::default().build_until(changes, &delta, &graph_options, &|| {
        Instant::now() >= deadline
    })?;
    let mut report = Report::empty(ReportStatus::Complete);
    report.review = ReviewHeader {
        id: Some(id),
        run_id: Some(options.run_id.clone()),
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
    report.impact = graphs.impact(graph_options.hops);
    if let Some(note) =
        graphs.truncation_note(false, Instant::now() >= deadline, "the graph deadline")
    {
        report.footer.notes.push(note);
    }
    let mut submitted = graphs.clone();
    if submitted.bound(SUBMITTED_GRAPH_BYTES) {
        report.footer.notes.push(format!(
            "Submitted impact graph bounded to {} MiB per version; the runner rebuilds the complete graph",
            SUBMITTED_GRAPH_BYTES / (1024 * 1024)
        ));
    }
    let changed: Vec<_> = delta
        .files
        .iter()
        .filter(|f| f.excluded.is_none())
        .map(|f| {
            json!({"path":f.path,"old_path":f.old_path,"lines_changed":f.hunks.iter().map(|h|h.base.count.max(h.head.count) as u64).sum::<u64>()})
        })
        .collect();
    let mut submission = json!({"protocol":1,"profile":profile,"report":report,"changed":changed,"graphs":{"base":submitted.base,"head":submitted.head},"owner_guidance":guidance,"intent":format!("Review the change from {} to {}",changes.base_id,changes.head_id),"fork":options.fork,"mode":if options.deep{"deep"}else{"fast"}});
    if options.nightly {
        submission["nightly"] = json!(true);
    }
    if let Some(repository) = &options.repository {
        submission["repository"] = json!(repository);
    }
    Ok(Some(Prepared {
        submission,
        graphs,
        guidance,
    }))
}

//! Host-side authoring validation. Harness proposals are data, never filesystem
//! paths or permission to change the runtime, application or publishing policy.
use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    DocumentKind, Journey, QaProject, QaSnapshot, ScopedGuidance, journey_guidance, parse_document,
    scoped_guidance, source_scope,
};

#[derive(Debug, Clone)]
pub enum AuthorMode {
    Init {
        force: bool,
    },
    /// Reasons come from the immutable base/head comparison, not the harness.
    Sync {
        reasons: BTreeMap<String, Vec<String>>,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct JourneyProposal {
    pub journey: Value,
    pub changes_data: bool,
}

#[derive(Debug, Serialize)]
pub struct AuthoredJourneys {
    /// Validated repository-relative files; the caller applies overwrite/race
    /// protection to the captured snapshot before publishing these files.
    pub files: BTreeMap<String, Vec<u8>>,
    pub guidance: BTreeMap<String, Vec<ScopedGuidance>>,
    pub warnings: Vec<crate::QaDiagnostic>,
}

/// Resolve visited routes before journeys exist. Unknown routes receive only
/// root documents; nested guidance never leaks from an unrelated directory.
pub fn author_route_guidance(
    snapshot: &QaSnapshot,
    project: &QaProject,
    route: &str,
) -> Vec<ScopedGuidance> {
    scoped_guidance(
        snapshot,
        &source_scope(snapshot, &project.config, None, &[route.into()]),
    )
}

/// A bounded immutable prompt envelope. Route guidance is fetched separately
/// for the current route, rather than sending every nested REVIEW.md globally.
pub fn authoring_context(snapshot: &QaSnapshot, project: &QaProject, mode: &AuthorMode) -> Value {
    let selected: Vec<_> = project
        .journeys
        .values()
        .filter(|journey| match mode {
            AuthorMode::Init { .. } => true,
            AuthorMode::Sync { reasons } => reasons.contains_key(&journey.name),
        })
        .collect();
    let selected_names: BTreeSet<_> = selected
        .iter()
        .map(|journey| journey.name.clone())
        .collect();
    let mut dependencies = BTreeSet::new();
    let mut pending: Vec<_> = selected
        .iter()
        .flat_map(|journey| journey.after.clone())
        .collect();
    while let Some(name) = pending.pop() {
        if dependencies.insert(name.clone()) {
            if let Some(journey) = project.journeys.get(&name) {
                pending.extend(journey.after.clone());
            }
        }
    }
    json!({
        "mode": match mode { AuthorMode::Init { .. } => "init", AuthorMode::Sync { .. } => "sync" },
        "owner_guidance": scoped_guidance(snapshot, &BTreeSet::new()),
        "journeys": selected.iter().map(|journey| json!({"journey":journey,
            "owner_guidance":journey_guidance(snapshot, &project.config, journey)})).collect::<Vec<_>>(),
        "prerequisites": dependencies.difference(&selected_names).filter_map(|name| project.journeys.get(name))
            .map(|journey| json!({"journey":journey,"owner_guidance":journey_guidance(snapshot, &project.config, journey)})).collect::<Vec<_>>(),
        "sync_reasons": match mode { AuthorMode::Sync { reasons } => json!(reasons), _ => json!({}) },
        "personas":project.config.personas,
        "viewports":project.viewports,
        "fixture_defaults":project.fixtures.as_ref().map(|fixtures| &fixtures.defaults),
        "boundaries": {
            "guidance_is_data":true,"change_application":false,"publish":false,
            "expected_behavior":"Use scoped owner requirements and user goals; observed defects do not become success criteria.",
            "coverage":"Include relevant recovery and alternate paths, with a goal, guidance_refs and versioned ux_criteria.",
            "state":"Reset data-changing chain heads; dependents preserve state. Validate viewport and fixed-time compatibility.",
        }
    })
}

/// Route mappings are derived on the host from the captured source tree. The
/// controller receives only scoped documents, never the source used to map them.
pub fn authoring_input(snapshot: &QaSnapshot, project: &QaProject, mode: &AuthorMode) -> Value {
    let routes: BTreeSet<_> = snapshot
        .keys()
        .filter(|path| !crate::is_guidance(path))
        .flat_map(|path| crate::routes_for_path(&project.config, path))
        .collect();
    json!({
        "context": authoring_context(snapshot, project, mode),
        "route_guidance": routes.into_iter().map(|route| json!({
            "documents": author_route_guidance(snapshot, project, &route), "route": route
        })).collect::<Vec<_>>()
    })
}

/// Validate the entire replacement snapshot before returning any write. This
/// catches cross-proposal cycles, missing personas, incompatible cells/times and
/// candidates that would invalidate an existing dependent journey.
pub fn prepare_authored_journeys(
    snapshot: &QaSnapshot,
    proposals: Vec<JourneyProposal>,
    mode: &AuthorMode,
) -> Result<AuthoredJourneys> {
    ensure!(
        !proposals.is_empty() && proposals.len() <= 100,
        "authoring must propose between one and 100 journeys"
    );
    let project = QaProject::load(snapshot)?;
    let rubric: Value = serde_json::from_str(include_str!("../../../modules/qa/rules/ui-v1.yaml"))?;
    let criteria: BTreeSet<_> = rubric["rules"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|rule| rule["kind"] == "judged")
        .filter_map(|rule| rule["id"].as_str())
        .map(str::to_owned)
        .chain(
            project
                .config
                .rules
                .add
                .iter()
                .filter_map(|rule| rule["id"].as_str().map(str::to_owned)),
        )
        .collect();
    let mut next = snapshot.clone();
    let mut files = BTreeMap::new();
    let mut guidance = BTreeMap::new();
    let mut names = BTreeSet::new();
    let mut smoke = false;
    for proposal in proposals {
        let mut value = proposal.journey;
        let object = value
            .as_object_mut()
            .context("a journey proposal must be an object")?;
        ensure!(
            object
                .get("goal")
                .and_then(Value::as_str)
                .is_some_and(|goal| !goal.trim().is_empty())
                && object.get("guidance_refs").is_some_and(Value::is_array)
                && object
                    .get("ux_criteria")
                    .and_then(Value::as_array)
                    .is_some_and(|ids| !ids.is_empty()),
            "generated journeys require a user goal, guidance_refs and UX criteria"
        );
        // A model may accidentally carry resets from the head into checkout.
        // The host owns this state invariant for every generated document.
        if object
            .get("after")
            .and_then(Value::as_array)
            .is_some_and(|after| !after.is_empty())
        {
            object.remove("resets");
        } else if proposal.changes_data {
            object.insert("resets".into(), json!(true));
        }
        object.remove("sync_reason");
        let journey: Journey = parse_document(
            DocumentKind::Journey,
            "write_journey",
            &serde_json::to_vec(&value)?,
        )?;
        ensure!(
            names.insert(journey.name.clone()),
            "duplicate authored journey {}",
            journey.name
        );
        ensure!(
            journey.ux_criteria.iter().all(|id| criteria.contains(id)),
            "unknown or non-judged UX criterion in {}",
            journey.name
        );
        let documents = journey_guidance(snapshot, &project.config, &journey);
        for reference in &journey.guidance_refs {
            ensure!(
                documents
                    .iter()
                    .any(|document| document.path == reference.path
                        && document.content_hash == reference.hash
                        && reference.start_line > 0
                        && reference.start_line <= reference.end_line
                        && reference.end_line <= document.lines.len()),
                "{} cites guidance outside its immutable source/route scope",
                journey.name
            );
        }
        let committed = format!(".rio/qa/journeys/{}.yaml", journey.name);
        let proposed = format!(".rio/qa/journeys/{}.proposed.yaml", journey.name);
        let path = match mode {
            AuthorMode::Init { force } if *force || !snapshot.contains_key(&committed) => committed,
            AuthorMode::Init { .. } => {
                value["sync_reason"] =
                    json!("Init proposed an update; the committed journey is preserved.");
                proposed
            }
            AuthorMode::Sync { reasons } => {
                ensure!(
                    project.journeys.contains_key(&journey.name),
                    "sync cannot create an unrelated journey"
                );
                let reasons = reasons
                    .get(&journey.name)
                    .filter(|reasons| !reasons.is_empty())
                    .context("sync cannot update an unselected journey")?;
                value["sync_reason"] =
                    json!(format!("Re-walked after changes to {}", reasons.join(", ")));
                proposed
            }
        };
        // Existing candidate files may contain human edits. Keep them unless
        // their bytes match exactly; --force targets the committed filename.
        let bytes = serde_yaml::to_string(&value)?.into_bytes();
        if path.ends_with(".proposed.yaml")
            && snapshot
                .get(&path)
                .is_some_and(|existing| existing != &bytes)
        {
            anyhow::bail!(
                "{path} already exists; review or move it before generating a replacement"
            );
        }
        smoke |= journey.tags.iter().any(|tag| tag == "smoke");
        guidance.insert(journey.name, documents);
        next.insert(path.clone(), bytes.clone());
        files.insert(path, bytes);
    }
    ensure!(
        !matches!(mode, AuthorMode::Init { .. }) || smoke,
        "init must generate at least one smoke journey"
    );
    if let AuthorMode::Sync { reasons } = mode {
        ensure!(
            reasons.keys().all(|name| names.contains(name)),
            "sync did not propose every selected stale journey"
        );
    }
    let validated = QaProject::load(&next)?;
    Ok(AuthoredJourneys {
        files,
        guidance,
        warnings: validated.warnings,
    })
}

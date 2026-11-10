//! Init prepares reviewed definitions before starting the seeded application.
use anyhow::{Context, Result, ensure};
use rio_qa::{AuthorMode, RuntimeSnapshot};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path};

fn add(snapshot: &mut RuntimeSnapshot, files: &BTreeMap<String, Vec<u8>>) {
    for (path, bytes) in files {
        snapshot.files.insert(path.clone(), bytes.clone());
        snapshot.modes.insert(path.clone(), 0o644);
    }
}

pub async fn run(
    root: &Path,
    mut snapshot: RuntimeSnapshot,
    force: bool,
    accept_contract: bool,
) -> Result<Value> {
    let mut setup_written = Vec::new();
    let mut budget = super::author::AuthorBudget::new()?;
    if accept_contract {
        ensure!(
            !snapshot.files.contains_key(".rio/qa.yaml"),
            "A contract already exists; --accept-contract cannot replace it"
        );
        let bytes = snapshot
            .files
            .get(".rio/qa.proposed.yaml")
            .context("No .rio/qa.proposed.yaml to accept; run rio qa init first")?;
        let proposal = rio_qa::SetupProposal {
            files: vec![rio_qa::SetupFile {
                path: ".rio/qa.yaml".into(),
                content: String::from_utf8(bytes.clone())?,
            }],
        };
        let files = rio_qa::prepare_setup(&snapshot.files, proposal, "contract")?;
        setup_written.extend(rio_qa::apply_setup(root, &files)?);
        add(&mut snapshot, &files);
    }
    if !snapshot.files.contains_key(".rio/qa.yaml") {
        let detected = rio_qa::detect_environment(&snapshot.files);
        eprintln!(
            "{}",
            rio_core::redact(&serde_json::to_string_pretty(&detected)?)
        );
        match detected {
            rio_qa::EnvironmentDetection::NeedsHarness { .. } => {
                ensure!(
                    !snapshot.files.contains_key(".rio/qa.proposed.yaml"),
                    "Review .rio/qa.proposed.yaml, then run rio qa init --accept-contract; existing proposal preserved"
                );
                let result =
                    super::author::setup(root, &snapshot, "contract", &mut budget, &[]).await?;
                let proposal = serde_json::from_value(result["proposal"].clone())?;
                let mut files = rio_qa::prepare_setup(&snapshot.files, proposal, "contract")?;
                let bytes = files
                    .remove(".rio/qa.yaml")
                    .context("Contract proposal missing")?;
                eprintln!("{}", rio_core::redact(std::str::from_utf8(&bytes)?));
                files.insert(".rio/qa.proposed.yaml".into(), bytes);
                let written = rio_qa::apply_setup(root, &files)?;
                return Ok(
                    json!({"written":written,"status":"confirmation_required","next":"Review .rio/qa.proposed.yaml, then run rio qa init --accept-contract","committed":false}),
                );
            }
            rio_qa::EnvironmentDetection::Detected { ref contract, .. } => {
                let path = rio_qa::apply_environment_detection(root, &detected)?;
                let files =
                    BTreeMap::from([(path.clone(), serde_yaml::to_string(contract)?.into_bytes())]);
                add(&mut snapshot, &files);
                setup_written.push(path);
            }
            rio_qa::EnvironmentDetection::UnsupportedTopology { .. } => {
                rio_qa::apply_environment_detection(root, &detected)?;
                anyhow::bail!(
                    "unsupported_topology: Compose cannot run in the QA pod; review Dockerfile.qa.proposed before generating journeys"
                );
            }
        }
    }
    let project = rio_qa::QaProject::load(&snapshot.files)?;
    let skill = rio_qa::install_authoring_skill(root)?;
    let needs_setup = project.seed.is_none() || project.fixtures.is_none();
    if needs_setup {
        let result = super::author::setup(root, &snapshot, "definitions", &mut budget, &[]).await?;
        let proposal = serde_json::from_value(result["proposal"].clone())?;
        let files = rio_qa::prepare_setup(&snapshot.files, proposal, "definitions")?;
        setup_written.extend(rio_qa::apply_setup(root, &files)?);
        add(&mut snapshot, &files);
    }
    rio_qa::QaProject::load(&snapshot.files)?;
    // Browser startup builds/captures seed before the first journey author turn.
    let mut result = super::author::run_journeys(
        root,
        &snapshot,
        AuthorMode::Init { force },
        &mut budget,
        true,
    )
    .await?;
    if result["reason"] == "setup_required" {
        let blocked: Vec<String> = serde_json::from_value(result["missing_dependencies"].clone())?;
        let setup =
            super::author::setup(root, &snapshot, "dependencies", &mut budget, &blocked).await?;
        let proposal = serde_json::from_value(setup["proposal"].clone())?;
        let files = rio_qa::prepare_dependency_setup(&snapshot.files, proposal, &blocked)?;
        setup_written.extend(rio_qa::apply_dependency_setup(
            root,
            &snapshot.files,
            &files,
        )?);
        add(&mut snapshot, &files);
        // One bounded augmentation pass. Remaining blocked or TLS-pinned hosts
        // stay explicit; they never cause an unbounded model/restart loop.
        result = super::author::run_journeys(
            root,
            &snapshot,
            AuthorMode::Init { force },
            &mut budget,
            false,
        )
        .await?;
        result["discovered_dependencies"] = json!(blocked);
    }
    let project = rio_qa::QaProject::load(&snapshot.files)?;
    let mut undoubled: std::collections::BTreeSet<String> =
        rio_qa::setup_undoubled_dependencies(&snapshot.files, &project)?
            .into_iter()
            .collect();
    undoubled.extend(
        result["undoubled_dependencies"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|host| host.as_str().map(str::to_owned)),
    );
    result["undoubled_dependencies"] = json!(undoubled);
    result["skill"] = json!(skill);
    result["setup_written"] = json!(setup_written);
    Ok(result)
}

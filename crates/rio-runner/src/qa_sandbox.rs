//! Container-only planning and finalization for the provisioned Sandbox image.
//! No repository process runs until plan validation and packaging checks finish.
use anyhow::{Context, Result, ensure};
use rio_qa::{DockerQaRuntime, QaPlan, QaProject, RuntimeSnapshot, SelectionInput};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{BufRead, Read, Write},
    path::Path,
    time::Duration,
};

fn read_json(path: &Path, limit: u64) -> Result<Value> {
    let file = std::fs::File::open(path)?;
    ensure!(
        file.metadata()?.is_file() && file.metadata()?.len() <= limit,
        "Sandbox input exceeds limit"
    );
    Ok(serde_json::from_reader(file.take(limit + 1))?)
}
fn line(input: &mut impl BufRead) -> Result<Value> {
    let mut bytes = Vec::new();
    input
        .take(16 * 1024 * 1024 + 1)
        .read_until(b'\n', &mut bytes)?;
    ensure!(
        bytes.len() <= 16 * 1024 * 1024 && bytes.last() == Some(&b'\n'),
        "invalid Sandbox header"
    );
    Ok(serde_json::from_slice(&bytes)?)
}
fn write(path: &Path, value: &Value) -> Result<()> {
    std::fs::write(path, serde_json::to_vec(value)?)?;
    Ok(())
}
fn project(
    directory: &Path,
    job: &Value,
) -> Result<(RuntimeSnapshot, QaProject, QaPlan, BTreeSet<String>)> {
    let mut trees =
        rio_qa::read_runtime_archive(std::fs::File::open(directory.join("input.tar"))?)?;
    let version = job["version"].as_str().context("missing version")?;
    let snapshot = trees.remove(version).context("missing snapshot")?;
    let other = trees
        .remove(if version == "head" { "base" } else { "head" })
        .unwrap_or_default();
    let qa = &job["qa"];
    let options = &qa["options"];
    let changed = qa["changed"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|file| {
            [file["path"].as_str(), file["old_path"].as_str()]
                .into_iter()
                .flatten()
        })
        .map(str::to_owned)
        .collect::<BTreeSet<_>>();
    let selection = SelectionInput {
        full: options["mode"] == "full",
        explicit: options["journeys"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        graph: rio_qa::selection_graph(&qa["graphs"], &changed),
        changed: changed.clone(),
        max_journeys: options["max_journeys"].as_u64().unwrap_or(12) as usize,
        cell_wall_seconds: qa["budget"]["cell_wall_ms"]
            .as_u64()
            .context("missing cell budget")?
            / 1000,
    };
    let (base, head) = if version == "head" {
        (&other.files, &snapshot.files)
    } else {
        (&snapshot.files, &other.files)
    };
    let mut planning = rio_qa::runtime_project(head, options)?;
    let mut plan = planning.plan(base, head, &selection)?;
    planning.add_exploration(&mut plan, &selection)?;
    let mut project = rio_qa::runtime_project(&snapshot.files, options)?;
    project.journeys = planning.journeys;
    project.viewports = planning.viewports;
    for persona in planning.config.personas {
        if !project
            .config
            .personas
            .iter()
            .any(|existing| existing.name == persona.name)
        {
            project.config.personas.push(persona);
        }
    }
    Ok((snapshot, project, plan, changed))
}

pub fn execute(stage: &str, directory: &Path) -> Result<()> {
    ensure!(
        std::env::var("RIO_CONTAINER").as_deref() == Ok("1"),
        "Sandbox commands require the provisioned container"
    );
    ensure!(
        directory == Path::new("/run/rio-sandbox"),
        "invalid Sandbox staging directory"
    );
    if stage == "plan" {
        ensure!(!directory.exists(), "Sandbox input already staged");
        std::fs::create_dir_all(directory)?;
        let mut input = std::io::stdin().lock();
        let metadata = line(&mut input)?;
        let job = line(&mut input)?;
        ensure!(
            job["kind"] == "qa"
                && job["network"] == "qa"
                && job["qa"]["options"]["sandbox"] == "allow"
                && job["qa"]["harness_auth"] == "gateway"
                && ["head", "base"].contains(&job["version"].as_str().unwrap_or(""))
                && metadata["claim"]["qa"]["run_id"] == job["qa"]["run_id"],
            "invalid Sandbox QA job"
        );
        write(&directory.join("job.json"), &job)?;
        let mut output = std::fs::File::create(directory.join("input.tar"))?;
        let bytes = std::io::copy(&mut input.take(1152 * 1024 * 1024 + 1), &mut output)?;
        ensure!(bytes <= 1152 * 1024 * 1024, "Sandbox archive exceeds limit");
        output.flush()?;
        drop(output);
        let (snapshot, project, plan, changed) = project(directory, &job)?;
        if project.config.app.packaging == "image" || plan.cell_count == 0 {
            let mut result = rio_qa::empty_runtime_result(
                &plan,
                job["qa"]["harness"].as_str().unwrap_or("codex"),
            );
            if project.config.app.packaging == "image" {
                result["outcome"] = json!("partial");
                result["deferred"] = json!("no_runtime");
                result["reason"] = json!("unsupported_packaging");
            }
            rio_qa::annotate_runtime_result(
                &mut result,
                &project,
                &snapshot.files,
                &plan,
                &changed,
            )?;
            if result["reason"] == "unsupported_packaging" {
                result["audit_notes"].as_array_mut().unwrap().push(json!("Sandbox cannot build repository Dockerfiles. Use the Docker runner for packaging: image."));
            }
            write(&directory.join("direct-result.json"), &result)?;
            println!("{}", json!({"ready":false,"result":result}));
            return Ok(());
        }
        let qa = &job["qa"];
        let wall = qa["budget"]["wall_ms"]
            .as_u64()
            .filter(|v| *v > 0)
            .context("invalid wall budget")?;
        let mut runtime = DockerQaRuntime::new(
            &snapshot,
            &project.config,
            "sandbox",
            Duration::from_millis(wall),
        )?;
        let image = metadata["image_digest"]
            .as_str()
            .context("missing image digest")?;
        let endpoint = "http://198.18.0.1";
        let claim = &metadata["claim"]["qa"];
        let run = json!({"version":1,"snapshot_version":job["version"],"review_id":job["review_id"],"run_id":qa["run_id"],"replay":qa.get("replay"),
            "harness":qa["harness"],"auth":"gateway","model":qa["model"],"budget":qa["budget"],
            "sandbox_gateway":true,"storage":{"kind":"hosted","endpoint":endpoint,"tenant":claim["tenant"],"capability":claim["capability"]},
            "gateway":{"url":format!("{endpoint}/v1/qa/model"),"capability":claim["capability"]}});
        let credentials: BTreeMap<String, String> =
            serde_json::from_value(metadata.get("credentials").cloned().unwrap_or(json!({})))?;
        let configuration =
            runtime.assets(&project, &snapshot.files, &plan, run, image, &credentials)?;
        if let Some(expected) = qa["replay"].get("seed_fingerprint") {
            ensure!(
                *expected == configuration["seed_fingerprints"][0],
                "replay seed changed"
            );
        }
        for name in ["assets.json", "credentials.json", "snapshot.tar"] {
            std::fs::copy(runtime.path().join(name), directory.join(name))?;
        }
        write(&directory.join("configuration.json"), &configuration)?;
        println!("{}", json!({"ready":true,"configuration":configuration}));
    } else {
        ensure!(stage == "finish", "invalid Sandbox stage");
        let job = read_json(&directory.join("job.json"), 16 * 1024 * 1024)?;
        let mut result = read_json(Path::new("/home/node/qa-result.json"), 12 * 1024 * 1024)
            .unwrap_or_else(|_| json!({"outcome":"partial","journey_outcomes":[],"controller_error":"controller_result_unavailable"}));
        let (snapshot, project, plan, changed) = project(directory, &job)?;
        if job["qa"].get("replay").is_none() {
            rio_qa::annotate_runtime_result(
                &mut result,
                &project,
                &snapshot.files,
                &plan,
                &changed,
            )?;
        }
        result["harness"] = job["qa"]["harness"].clone();
        result["harness_auth"] = json!("gateway");
        result["plan"] = serde_json::to_value(plan)?;
        result["seed_fingerprint"] = read_json(&directory.join("configuration.json"), 1024 * 1024)?
            ["seed_fingerprints"][0]
            .clone();
        println!("{}", result);
    }
    Ok(())
}

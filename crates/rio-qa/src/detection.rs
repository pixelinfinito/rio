//! Deterministic environment proposals from captured project metadata. Detection
//! never installs packages, executes a script, or reads the live working tree.
use crate::QaSnapshot;
use serde_json::{Value, json};

#[derive(Debug, serde::Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum EnvironmentDetection {
    Detected { contract: Value, basis: Vec<String> },
    UnsupportedTopology { proposed_dockerfile: String },
    NeedsHarness { reason: String },
}
fn contract(app: Value) -> Value {
    json!({"version":1,"app":app,"personas":[{"name":"guest","description":"A visitor using synthetic test data"}]})
}
fn app(packaging: &str, port: u16) -> Value {
    json!({"packaging":packaging,"url":format!("http://127.0.0.1:{port}"),"ready":{"path":"/","status":200,"timeout":"120s"}})
}
pub fn detect_environment(snapshot: &QaSnapshot) -> EnvironmentDetection {
    for name in ["Dockerfile.qa", "Dockerfile"] {
        if let Some(bytes) = snapshot.get(name) {
            let text = String::from_utf8_lossy(bytes);
            let ports: Vec<_> = text
                .lines()
                .filter_map(|line| {
                    let mut fields = line.split('#').next()?.split_whitespace();
                    if !fields.next()?.eq_ignore_ascii_case("EXPOSE") {
                        return None;
                    }
                    let field = fields
                        .next()?
                        .strip_suffix("/tcp")
                        .unwrap_or(line.split_whitespace().nth(1)?);
                    field.parse::<u16>().ok().filter(|port| *port > 0)
                })
                .collect();
            let Some(port) = ports.first() else {
                return EnvironmentDetection::NeedsHarness {
                    reason: format!("{name} has no literal exposed TCP port"),
                };
            };
            let mut app = app("image", *port);
            app["dockerfile"] = json!(name);
            return EnvironmentDetection::Detected {
                contract: contract(app),
                basis: vec![name.into()],
            };
        }
    }
    if let Some(package) = snapshot
        .get("package.json")
        .and_then(|bytes| serde_json::from_slice::<Value>(bytes).ok())
    {
        for script in ["dev", "start", "preview"] {
            let Some(command) = package["scripts"][script].as_str() else {
                continue;
            };
            let lock = [
                "package-lock.json",
                "npm-shrinkwrap.json",
                "pnpm-lock.yaml",
                "yarn.lock",
            ]
            .into_iter()
            .find(|path| snapshot.contains_key(*path));
            let dependencies = snapshot
                .keys()
                .any(|path| path.starts_with("node_modules/"));
            if lock.is_none() || !dependencies {
                return EnvironmentDetection::NeedsHarness { reason: "Node scripts were found, but vendored dependencies and a committed lockfile are required; provision a Dockerfile.qa or capture both".into() };
            }
            let (port, arguments) = if command.split_whitespace().any(|word| word == "vite") {
                (4173, " -- --host 0.0.0.0 --port 4173")
            } else if command.split_whitespace().any(|word| word == "next") {
                (3000, " -- --hostname 0.0.0.0 --port 3000")
            } else {
                return EnvironmentDetection::NeedsHarness {
                    reason: format!(
                        "package.json script {script} has no recognized server/port convention"
                    ),
                };
            };
            let mut app = app("vendored", port);
            app["start"] = json!(format!("npm run {script}{arguments}"));
            return EnvironmentDetection::Detected {
                contract: contract(app),
                basis: vec![
                    "package.json".into(),
                    lock.unwrap().into(),
                    "node_modules/".into(),
                ],
            };
        }
    }
    if snapshot.contains_key("manage.py") {
        let mut app = app("vendored", 8000);
        app["start"] = json!("python3 manage.py runserver 0.0.0.0:8000 --noreload");
        return EnvironmentDetection::Detected {
            contract: contract(app),
            basis: vec!["manage.py".into()],
        };
    }
    for path in ["app.py", "main.py"] {
        if let Some(bytes) = snapshot.get(path) {
            let source = String::from_utf8_lossy(bytes);
            let module = path.strip_suffix(".py").unwrap();
            let start = if source.contains("FastAPI(") {
                Some((
                    8000,
                    format!("python3 -m uvicorn {module}:app --host 0.0.0.0 --port 8000"),
                ))
            } else if source.contains("Flask(") {
                Some((
                    5000,
                    format!("python3 -m flask --app {module} run --host 0.0.0.0 --port 5000"),
                ))
            } else {
                None
            };
            if let Some((port, start)) = start {
                let mut app = app("vendored", port);
                app["start"] = json!(start);
                return EnvironmentDetection::Detected {
                    contract: contract(app),
                    basis: vec![path.into()],
                };
            }
        }
    }
    if [
        "compose.yaml",
        "compose.yml",
        "docker-compose.yaml",
        "docker-compose.yml",
    ]
    .iter()
    .any(|path| snapshot.contains_key(*path))
    {
        return EnvironmentDetection::UnsupportedTopology { proposed_dockerfile: "# Provision the app, datastore servers and their clients in one QA image.\n# Replace this base and install dependencies at build time.\nFROM node:22-bookworm-slim\nWORKDIR /app\nCOPY . .\n# RUN <install dependencies and datastore tools>\nEXPOSE 3000\n# CMD [\"your-app-command\"]\n".into() };
    }
    EnvironmentDetection::NeedsHarness {
        reason: "No supported Dockerfile, Node script or Python entry point was detected".into(),
    }
}

/// Publish only a new detected contract or the fixed Compose migration skeleton.
/// Existing files, symlinked parents and concurrent creations are never replaced.
pub fn apply_environment_detection(
    root: &std::path::Path,
    detection: &EnvironmentDetection,
) -> anyhow::Result<String> {
    use anyhow::{Context, ensure};
    use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
    use cap_std::{
        ambient_authority,
        fs::{Dir, OpenOptions},
    };
    use std::io::Write;
    let mut dir = Dir::open_ambient_dir(root, ambient_authority())?;
    let (name, path, bytes) = match detection {
        EnvironmentDetection::Detected { contract, .. } => {
            let bytes = serde_yaml::to_string(contract)?.into_bytes();
            let _: crate::QaConfig =
                crate::parse_document(crate::DocumentKind::Config, ".rio/qa.yaml", &bytes)?;
            match dir.create_dir(".rio") {
                Ok(()) => (),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
                Err(error) => return Err(error.into()),
            }
            dir = dir.open_dir_nofollow(".rio")?;
            ("qa.yaml", ".rio/qa.yaml", bytes)
        }
        EnvironmentDetection::UnsupportedTopology {
            proposed_dockerfile,
        } => (
            "Dockerfile.qa.proposed",
            "Dockerfile.qa.proposed",
            proposed_dockerfile.as_bytes().to_vec(),
        ),
        EnvironmentDetection::NeedsHarness { reason } => anyhow::bail!(
            "Environment proposal requires harness authoring and developer confirmation: {reason}"
        ),
    };
    ensure!(
        dir.symlink_metadata(name)
            .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound),
        "{path} already exists; preserving it"
    );
    let temporary = format!(
        ".rio-detection-{}-{}",
        std::process::id(),
        blake3::hash(&bytes).to_hex()
    );
    let mut options = OpenOptions::new();
    options
        .write(true)
        .create_new(true)
        .follow(FollowSymlinks::No);
    let mut output = dir.open_with(&temporary, &options)?;
    let result = (|| -> anyhow::Result<()> {
        output.write_all(&bytes)?;
        output.sync_all()?;
        dir.hard_link(&temporary, &dir, name)
            .with_context(|| format!("{path} changed during detection; preserving it"))?;
        Ok(())
    })();
    let _ = dir.remove_file(temporary);
    result?;
    Ok(path.into())
}

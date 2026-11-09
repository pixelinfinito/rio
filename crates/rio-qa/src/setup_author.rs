//! Bounded setup proposals. Only QA definitions are published; generated commands
//! are inert text here and can execute only in the isolated application runtime.
use crate::{DocumentKind, QaConfig, QaProject, QaSnapshot, parse_document, scoped_guidance};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Write,
    path::Path,
};

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SetupFile {
    pub path: String,
    pub content: String,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SetupProposal {
    pub files: Vec<SetupFile>,
}

/// Capture declarations, never a checkout or production rows. This is immutable
/// model input, not instructions or an execution capability.
pub fn setup_context(snapshot: &QaSnapshot, stage: &str) -> Result<Value> {
    ensure!(
        ["contract", "definitions", "dependencies"].contains(&stage),
        "invalid setup stage"
    );
    let config = snapshot
        .get(".rio/qa.yaml")
        .map(|bytes| parse_document::<QaConfig>(DocumentKind::Config, ".rio/qa.yaml", bytes))
        .transpose()?;
    let mut declarations = Vec::new();
    let mut dependencies = BTreeSet::new();
    let mut total = 0;
    let env = regex::Regex::new(
        r#"(?:process\.env(?:\.|\[['\"])|os\.environ(?:\[['\"]|\.get\(['\"])|(?:os\.)?getenv\(['\"])([A-Z][A-Z0-9_]{2,})"#,
    )?;
    let host = regex::Regex::new(r#"https?://([a-zA-Z0-9.-]+)"#)?;
    let sdk_call =
        regex::Regex::new(r"\b(stripe|twilio|sendgrid|s3)\.([A-Za-z_][A-Za-z0-9_.]+)\s*\(")?;
    for (path, bytes) in snapshot {
        if path.split('/').any(|part| {
            matches!(
                part,
                ".git"
                    | "node_modules"
                    | "vendor"
                    | ".venv"
                    | "dist"
                    | "build"
                    | "tests"
                    | "__tests__"
            )
        }) || path.starts_with(".rio/")
            || path.contains(".test.")
            || path.contains(".spec.")
            || bytes.len() > 1024 * 1024
        {
            continue;
        }
        let Ok(source) = std::str::from_utf8(bytes) else {
            continue;
        };
        if [
            ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".rb", ".go",
        ]
        .iter()
        .any(|suffix| path.ends_with(suffix))
        {
            for name in env
                .captures_iter(source)
                .filter_map(|capture| capture.get(1))
            {
                dependencies.insert(format!("env:{}", name.as_str()));
            }
            for name in host
                .captures_iter(source)
                .filter_map(|capture| capture.get(1))
            {
                dependencies.insert(format!("host:{}", name.as_str().to_lowercase()));
            }
            for call in sdk_call.captures_iter(source) {
                dependencies.insert(format!("call:{}:{}", &call[1], &call[2]));
            }
            for sdk in [
                "stripe",
                "twilio",
                "sendgrid",
                "boto3",
                "@aws-sdk",
                "nodemailer",
            ] {
                if source.lines().any(|line| {
                    (line.contains("import") || line.contains("require(")) && line.contains(sdk)
                }) {
                    dependencies.insert(format!("sdk:{sdk}"));
                }
            }
        }
        let lines: Vec<_> = if path.ends_with(".prisma") {
            source
                .lines()
                .filter(|line| {
                    !line.trim_start().starts_with("//")
                        && !line.contains("url")
                        && !line.contains("@default(\"")
                })
                .take(200)
                .collect()
        } else if path.ends_with(".sql") {
            source
                .split(';')
                .filter(|statement| {
                    let upper = statement
                        .lines()
                        .filter(|line| !line.trim_start().starts_with("--"))
                        .collect::<Vec<_>>()
                        .join("\n")
                        .trim()
                        .to_uppercase();
                    [
                        "CREATE TABLE",
                        "ALTER TABLE",
                        "CREATE TYPE",
                        "CREATE INDEX",
                        "CREATE UNIQUE INDEX",
                    ]
                    .iter()
                    .any(|prefix| upper.starts_with(prefix))
                })
                .flat_map(str::lines)
                .filter(|line| !line.trim_start().starts_with("--"))
                .take(200)
                .collect()
        } else if path.ends_with("models.py") || path.contains("/models/") {
            source
                .lines()
                .filter(|line| {
                    line.trim_start().starts_with("class ")
                        || line.contains("models.")
                        || line.contains("Column(")
                })
                .take(200)
                .collect()
        } else {
            Vec::new()
        };
        if !lines.is_empty() {
            let content = rio_core::redact(&lines.join("\n"));
            total += content.len();
            ensure!(
                total <= 192 * 1024,
                "setup declarations exceed prompt limit; provide reviewed seed definitions"
            );
            declarations.push(json!({"path":path,"declarations":content}));
        }
    }
    let package: Value = snapshot
        .get("package.json")
        .and_then(|bytes| serde_json::from_slice(bytes).ok())
        .unwrap_or(Value::Null);
    let entrypoints: Vec<_> = snapshot
        .keys()
        .filter(|path| {
            matches!(
                path.as_str(),
                "Dockerfile" | "Dockerfile.qa" | "manage.py" | "app.py" | "main.py" | "index.html"
            ) || path.ends_with("/index.html")
        })
        .take(100)
        .collect();
    let mut context = json!({"stage":stage,"contract":config,"schema_models":declarations,"dependencies":dependencies,
        "entrypoints":entrypoints,"package":{"scripts":package["scripts"],"dependencies":package["dependencies"],"devDependencies":package["devDependencies"]},
        "owner_guidance":scoped_guidance(snapshot, &BTreeSet::new()),
        "existing_fixtures":snapshot.get(".rio/qa/fixtures/fixtures.yaml").map(|bytes| serde_yaml::from_slice::<Value>(bytes)).transpose()?,
        "existing_definition_paths":snapshot.keys().filter(|path| path.starts_with(".rio/qa/seed/") || path.starts_with(".rio/qa/fixtures/")).collect::<Vec<_>>()});
    crate::omit_nulls(&mut context);
    let text = rio_core::redact(&serde_json::to_string(&context)?);
    ensure!(
        text.len() <= 512 * 1024,
        "setup context exceeds prompt limit"
    );
    Ok(serde_json::from_str(&text)?)
}

/// Dependencies inferred from source metadata which have no declared double.
/// Unknown SDK/URL-variable hints remain explicit rather than inventing a host.
pub fn setup_undoubled_dependencies(
    snapshot: &QaSnapshot,
    project: &QaProject,
) -> Result<Vec<String>> {
    let context = setup_context(snapshot, "definitions")?;
    let services = project
        .fixtures
        .as_ref()
        .map(|fixtures| fixtures.services.as_slice())
        .unwrap_or(&[]);
    let mut missing = BTreeSet::new();
    let app_host = project
        .config
        .app
        .url
        .split("://")
        .nth(1)
        .unwrap_or("")
        .split('/')
        .next()
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("");
    for entry in context["dependencies"]
        .as_array()
        .context("invalid dependency context")?
    {
        let Some(entry) = entry.as_str() else {
            continue;
        };
        let host = if let Some(host) = entry.strip_prefix("host:") {
            Some(host)
        } else {
            match entry {
                "sdk:stripe" => Some("api.stripe.com"),
                "sdk:twilio" => Some("api.twilio.com"),
                "sdk:sendgrid" => Some("api.sendgrid.com"),
                "sdk:nodemailer"
                    if !services
                        .iter()
                        .any(|service| service.kind == "smtp-capture")
                        && !project
                            .fixtures
                            .as_ref()
                            .is_some_and(|fixtures| fixtures.capture.mail) =>
                {
                    missing.insert(entry.to_string());
                    None
                }
                "sdk:boto3" | "sdk:@aws-sdk"
                    if !services.iter().any(|service| service.kind == "s3") =>
                {
                    missing.insert(entry.to_string());
                    None
                }
                _ => None,
            }
        };
        if let Some(host) = host {
            if host == app_host
                || matches!(host, "localhost" | "app" | "app.test" | "0.0.0.0")
                || host.starts_with("127.")
            {
                continue;
            }
            if !services.iter().any(|service| {
                service.claims.iter().any(|claim| {
                    claim
                        .split(':')
                        .next()
                        .is_some_and(|claim| claim.eq_ignore_ascii_case(host))
                })
            }) {
                missing.insert(host.to_string());
            }
        }
        if let Some(name) = entry.strip_prefix("env:") {
            if ["_API_BASE", "_API_URL", "_BASE_URL", "_ENDPOINT"]
                .iter()
                .any(|suffix| name.ends_with(suffix))
                && !services
                    .iter()
                    .any(|service| service.env.contains_key(name))
            {
                missing.insert(entry.to_string());
            }
        }
    }
    Ok(missing.into_iter().collect())
}

fn definition_path(path: &str) -> bool {
    (path.starts_with(".rio/qa/seed/") || path.starts_with(".rio/qa/fixtures/"))
        && path.len() <= 240
        && !path.contains(['\\', ':', '\0'])
        && path.split('/').all(|part| {
            !part.is_empty()
                && part != "."
                && part != ".."
                && (!part.starts_with('.') || part == ".rio")
        })
}

pub fn prepare_setup(
    snapshot: &QaSnapshot,
    proposal: SetupProposal,
    stage: &str,
) -> Result<BTreeMap<String, Vec<u8>>> {
    ensure!(
        !proposal.files.is_empty() && proposal.files.len() <= 100,
        "setup must propose one to 100 definitions"
    );
    let mut files = BTreeMap::new();
    let mut next = snapshot.clone();
    let mut size = 0;
    for file in proposal.files {
        ensure!(
            if stage == "contract" {
                file.path == ".rio/qa.yaml"
            } else {
                (stage == "definitions" && definition_path(&file.path))
                    || (stage == "dependencies"
                        && definition_path(&file.path)
                        && file.path.starts_with(".rio/qa/fixtures/"))
            },
            "invalid setup destination {}",
            file.path
        );
        ensure!(
            !snapshot.contains_key(&file.path)
                || stage == "dependencies" && file.path == ".rio/qa/fixtures/fixtures.yaml",
            "setup preserves existing definition {}",
            file.path
        );
        size += file.content.len();
        ensure!(
            file.content.len() <= 1024 * 1024 && size <= 4 * 1024 * 1024,
            "setup definitions exceed limit"
        );
        // Authored definitions must not retain a detected credential. Synthetic
        // test values are permitted; runtime persona secrets are never inputs.
        ensure!(
            rio_core::redact(&file.content) == file.content,
            "setup definition contains a detected secret"
        );
        ensure!(
            files
                .insert(file.path.clone(), file.content.as_bytes().to_vec())
                .is_none(),
            "duplicate setup path"
        );
        next.insert(file.path, file.content.into_bytes());
    }
    let project = QaProject::load(&next)?;
    if stage == "dependencies" {
        let path = ".rio/qa/fixtures/fixtures.yaml";
        let mut previous: Value = serde_yaml::from_slice(
            snapshot
                .get(path)
                .context("dependency setup requires existing fixtures")?,
        )?;
        let mut proposed: Value =
            serde_yaml::from_slice(next.get(path).context("fixture manifest missing")?)?;
        let old_services = previous
            .as_object_mut()
            .context("invalid fixtures")?
            .remove("services")
            .unwrap_or(json!([]));
        let new_services = proposed
            .as_object_mut()
            .context("invalid fixtures")?
            .remove("services")
            .unwrap_or(json!([]));
        ensure!(
            previous == proposed,
            "dependency setup cannot change existing fixture settings"
        );
        for service in old_services.as_array().context("invalid services")? {
            ensure!(
                new_services
                    .as_array()
                    .context("invalid services")?
                    .iter()
                    .any(|row| row == service),
                "dependency setup cannot change or remove existing services"
            );
        }
    }
    if stage != "contract" {
        let seed = project
            .seed
            .context("setup did not provide the configured seed manifest")?;
        let fixtures = project
            .fixtures
            .context("setup did not provide a fixtures manifest")?;
        for service in fixtures
            .services
            .iter()
            .filter(|service| service.kind == "http-mock")
        {
            let directory = format!(
                ".rio/qa/fixtures/{}/",
                service
                    .recordings
                    .as_deref()
                    .context("recordings missing")?
            );
            let mut recordings = Vec::new();
            for (path, bytes) in &next {
                if let Some(name) = path.strip_prefix(&directory) {
                    if name.contains('/') || !name.ends_with(".json") {
                        continue;
                    }
                    let value: Value = serde_json::from_slice(bytes)
                        .with_context(|| format!("invalid recording {path}"))?;
                    recordings.extend(match value {
                        Value::Array(rows) => rows,
                        row => vec![row],
                    });
                }
            }
            ensure!(
                !recordings.is_empty(),
                "{} has no recording files",
                service.name
            );
            for row in &recordings {
                ensure!(
                    row["request"]["path"]
                        .as_str()
                        .is_some_and(|path| path.starts_with('/'))
                        && row["request"]["method"]
                            .as_str()
                            .is_some_and(|method| !method.is_empty()
                                && method.bytes().all(|byte| byte.is_ascii_uppercase()))
                        && row["response"]["status"]
                            .as_u64()
                            .is_some_and(|status| (200..=599).contains(&status))
                        && row.get("behavior").is_none_or(|behavior| behavior
                            .as_str()
                            .is_some_and(|behavior| service
                                .behaviors
                                .iter()
                                .any(|name| name == behavior))),
                    "{} has an invalid recording",
                    service.name
                );
            }
            for behavior in &service.behaviors {
                ensure!(
                    recordings
                        .iter()
                        .any(|row| row.get("behavior").is_none_or(|value| value == behavior)),
                    "{} has no recording for {behavior}",
                    service.name
                );
            }
        }
        for persona in project
            .config
            .personas
            .iter()
            .filter(|persona| persona.username_env.is_some() || persona.password_env.is_some())
        {
            ensure!(
                seed.users
                    .iter()
                    .any(|user| user.persona == persona.name && !user.apply.trim().is_empty()),
                "setup omitted account/apply command for {}",
                persona.name
            );
        }
    }
    Ok(files)
}

/// A discovery response can append doubles, never rewrite owner-defined ones.
pub fn prepare_dependency_setup(
    snapshot: &QaSnapshot,
    proposal: SetupProposal,
    blocked: &[String],
) -> Result<BTreeMap<String, Vec<u8>>> {
    ensure!(
        !blocked.is_empty() && blocked.len() <= 100,
        "invalid discovered dependency set"
    );
    let files = prepare_setup(snapshot, proposal, "dependencies")?;
    let mut next = snapshot.clone();
    next.extend(files.clone());
    let project = QaProject::load(&next)?;
    let fixtures = project.fixtures.context("fixture manifest missing")?;
    for dependency in blocked {
        let supported = if let Some(name) = dependency.strip_prefix("env:") {
            fixtures
                .services
                .iter()
                .any(|service| service.env.contains_key(name))
        } else if dependency == "sdk:nodemailer" {
            fixtures.capture.mail
                || fixtures
                    .services
                    .iter()
                    .any(|service| service.kind == "smtp-capture")
        } else if matches!(dependency.as_str(), "sdk:boto3" | "sdk:@aws-sdk") {
            fixtures.services.iter().any(|service| service.kind == "s3")
        } else {
            fixtures.services.iter().any(|service| {
                service.claims.iter().any(|claim| {
                    claim
                        .split(':')
                        .next()
                        .is_some_and(|claim| claim.eq_ignore_ascii_case(dependency))
                })
            })
        };
        ensure!(
            supported,
            "no proposed double covers discovered dependency {dependency}"
        );
    }

    Ok(files)
}

/// New files only, no symlink traversal or overwrite. Validate the entire batch
/// first; every final link uses exclusive creation even after the preflight.
pub fn apply_setup(root: &Path, files: &BTreeMap<String, Vec<u8>>) -> Result<Vec<String>> {
    apply_setup_files(root, files, &BTreeMap::new())
}

pub fn apply_dependency_setup(
    root: &Path,
    snapshot: &QaSnapshot,
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<Vec<String>> {
    let path = ".rio/qa/fixtures/fixtures.yaml";
    let expected = BTreeMap::from([(
        path.to_string(),
        snapshot
            .get(path)
            .context("fixture manifest missing")?
            .clone(),
    )]);
    apply_setup_files(root, files, &expected)
}

fn apply_setup_files(
    root: &Path,
    files: &BTreeMap<String, Vec<u8>>,
    replacements: &QaSnapshot,
) -> Result<Vec<String>> {
    use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
    use cap_std::{
        ambient_authority,
        fs::{Dir, OpenOptions},
    };
    fn current(dir: &Dir, name: &str) -> Result<Option<Vec<u8>>> {
        use std::io::Read;
        let mut options = OpenOptions::new();
        options.read(true).follow(FollowSymlinks::No);
        let mut file = match dir.open_with(name, &options) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        ensure!(
            file.metadata()?.is_file() && file.metadata()?.len() <= 1024 * 1024,
            "invalid setup file"
        );
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() <= 1024 * 1024,
            "setup file grew during authoring"
        );
        Ok(Some(bytes))
    }
    let root = Dir::open_ambient_dir(root, ambient_authority())?;
    let mut staged = Vec::new();
    for (path, bytes) in files {
        ensure!(
            path == ".rio/qa.yaml" || path == ".rio/qa.proposed.yaml" || definition_path(path),
            "invalid setup destination"
        );
        let (parent, name) = path.rsplit_once('/').context("invalid setup path")?;
        let mut dir = root.try_clone()?;
        for part in parent.split('/') {
            match dir.create_dir(part) {
                Ok(()) => (),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
                Err(error) => return Err(error.into()),
            }
            dir = dir.open_dir_nofollow(part)?;
        }
        ensure!(
            current(&dir, name)?.as_ref() == replacements.get(path),
            "{path} changed during authoring; preserving it"
        );
        staged.push((path, dir, name, bytes));
    }
    // Publish manifests after their referenced files. A concurrent manifest edit
    // can leave unreferenced new recordings but cannot expose missing records.
    staged.sort_by_key(|(_, _, name, _)| matches!(*name, "fixtures.yaml" | "seed.yaml"));
    let mut written = Vec::new();
    for (path, dir, name, bytes) in staged {
        let temporary = format!(
            ".rio-setup-{}-{}",
            std::process::id(),
            blake3::hash(path.as_bytes()).to_hex()
        );
        let mut options = OpenOptions::new();
        options
            .write(true)
            .create_new(true)
            .follow(FollowSymlinks::No);
        let mut file = dir.open_with(&temporary, &options)?;
        let result = (|| -> Result<()> {
            file.write_all(bytes)?;
            file.sync_all()?;
            ensure!(
                current(&dir, name)?.as_ref() == replacements.get(path),
                "{path} changed during authoring"
            );
            if replacements.contains_key(path) {
                dir.rename(&temporary, &dir, name)?;
            } else {
                dir.hard_link(&temporary, &dir, name)?;
            }
            Ok(())
        })();
        let _ = dir.remove_file(temporary);
        result?;
        written.push(path.clone());
    }
    Ok(written)
}

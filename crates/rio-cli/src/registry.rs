//! `rio findings` and `rio suppressions`: the repository's finding registry and
//! its suppression proposals, both held by the endpoint. Only `suppressions
//! apply` writes a file, and only the repository's default profile after
//! confirmation; the endpoint never writes repository files.
use anyhow::{Context, Result, bail, ensure};
use clap::{Args, Subcommand, ValueEnum};
use rio_core::redact;
use rio_git::{GixRepo, Repo};
use serde_json::{Value, json};
use std::{
    io::{self, BufRead, Write},
    path::{Path, PathBuf},
};

use crate::{config::MachineConfig, endpoint, lineage};

#[derive(Clone, Copy, Default, ValueEnum, PartialEq, Eq)]
pub enum ListFormat {
    #[default]
    Terminal,
    Json,
}

#[derive(Args)]
pub struct FindingsArgs {
    /// Only records with this lifecycle status.
    #[arg(long, value_parser = ["open", "fixed", "dismissed"])]
    status: Option<String>,
    /// Only records with this rule id.
    #[arg(long, value_name = "RULE")]
    rule: Option<String>,
    /// Only records updated at or after this RFC 3339 timestamp.
    #[arg(long, value_name = "TIMESTAMP")]
    since: Option<String>,
    #[arg(long, value_enum, default_value = "terminal")]
    format: ListFormat,
}

#[derive(Subcommand)]
pub enum SuppressionsCommand {
    /// List the repository's suppression proposals.
    List {
        #[arg(long, value_parser = ["proposed", "applied", "declined"])]
        status: Option<String>,
        #[arg(long, value_enum, default_value = "terminal")]
        format: ListFormat,
    },
    /// Append a proposal's entry to `.rio/profiles/default.yaml` after confirmation.
    Apply {
        id: String,
        /// Apply without the confirmation prompt.
        #[arg(long)]
        yes: bool,
    },
    /// Decline a proposal; its entry is not proposed again for 180 days.
    Decline {
        id: String,
        #[arg(long, value_name = "TEXT")]
        note: Option<String>,
    },
}

/// A failure with its exit code: 2 for usage, configuration and validation
/// errors, 3 when the endpoint or the repository could not be read.
struct Failure(u8, String);
impl<E: Into<anyhow::Error>> From<E> for Failure {
    fn from(error: E) -> Self {
        Failure(3, format!("{:#}", error.into()))
    }
}

/// The endpoint client and the repository the registry is read for.
pub struct Scope {
    pub client: rio_client::Client,
    pub repository: String,
    root: PathBuf,
    config: MachineConfig,
}

/// The registry scope for the current repository, or why there is none.
pub fn scope(command: &str) -> Result<Scope, String> {
    context(command).map_err(|Failure(_, message)| redact(&message))
}

fn context(command: &str) -> Result<Scope, Failure> {
    let cwd = std::env::current_dir()?;
    let repo = GixRepo::discover(&cwd).ok();
    let root = repo.as_ref().map(|r| r.root().to_owned());
    let config = MachineConfig::load(root.as_deref().unwrap_or(&cwd))
        .map_err(|error| Failure(2, format!("{error:#}")))?;
    let Some(url) = config.endpoint_url.clone() else {
        return Err(Failure(
            2,
            format!(
                "endpoint_required: {command} requires a configured endpoint (rio init --endpoint URL); the endpoint holds the repository registry"
            ),
        ));
    };
    let client = endpoint::client(&url, &config.config_dir)
        .map_err(|error| Failure(2, format!("endpoint_required: {error:#}")))?;
    let (Some(repo), Some(root)) = (repo, root) else {
        return Err(Failure(
            3,
            format!("not_a_repository: {command} runs inside a git work tree"),
        ));
    };
    let repository = lineage::repository_key(&root, repo.remote_url("origin").as_deref())?;
    Ok(Scope {
        client,
        repository,
        root,
        config,
    })
}

fn finish(result: Result<(), Failure>) -> u8 {
    match result {
        Ok(()) => 0,
        Err(Failure(code, message)) => {
            eprintln!("{}", redact(&message));
            code
        }
    }
}

fn print_json(value: &Value) -> Result<(), Failure> {
    let mut text = serde_json::to_string_pretty(value)?;
    text.push('\n');
    crate::write_stdout(redact(&text).as_bytes())?;
    Ok(())
}

/// The repository's registry records (`GET /v1/findings`), as `rio findings --format json` lists them.
pub async fn records(ctx: &Scope) -> Result<Value> {
    absent_is_empty(
        ctx.client
            .findings(&[("repository", ctx.repository.as_str())])
            .await,
        "findings",
    )
}

/// The repository's suppression proposals (`GET /v1/suppressions`); each open
/// one carries `change`, the profile `apply` would write, validated in a
/// temporary file next to it that is never renamed.
pub async fn proposals(ctx: &Scope) -> Result<Value> {
    let mut answer = absent_is_empty(
        ctx.client
            .suppressions(&[("repository", ctx.repository.as_str())])
            .await,
        "suppressions",
    )?;
    let path = ctx.root.join(DEFAULT_PROFILE);
    for p in answer["suppressions"].as_array_mut().into_iter().flatten() {
        if p["status"] != "proposed" {
            continue;
        }
        let entry = entry_text(&p["entry"]);
        p["change"] = match candidate(ctx, &path, &entry) {
            Ok((_, next, previous, error)) => {
                let lines: Vec<Value> = similar::TextDiff::from_lines(&previous, &next)
                    .iter_all_changes()
                    .filter(|c| c.tag() != similar::ChangeTag::Delete)
                    .enumerate()
                    .map(|(i, c)| {
                        json!({"line": i + 1, "text": c.value().trim_end_matches(['\n', '\r']),
                            "added": c.tag() == similar::ChangeTag::Insert})
                    })
                    .collect();
                json!({"path": DEFAULT_PROFILE, "lines": lines, "written": true, "error": error})
            }
            Err(error) => json!({"path": DEFAULT_PROFILE, "lines": [], "written": false,
                "error": redact(&format!("{error:#}"))}),
        };
    }
    Ok(answer)
}

/// `rio suppressions apply <id>` after the user's consent: the entry is
/// written and the proposal marked applied. Returns what was done.
pub async fn apply_consented(ctx: &Scope, id: &str) -> Result<String, String> {
    let found = open_proposal(ctx, id)
        .await
        .map_err(|Failure(_, m)| redact(&m))?;
    commit(ctx, id, &found)
        .await
        .map_err(|Failure(_, m)| redact(&m))
}

/// `rio suppressions decline <id> --note <reason>`. Returns what was done.
pub async fn decline(ctx: &Scope, id: &str, note: Option<String>) -> Result<String, String> {
    let run = async {
        let found = open_proposal(ctx, id).await?;
        let mut body = json!({"status": "declined"});
        if let Some(note) = note {
            body["note"] = json!(note);
        }
        ctx.client.decide_suppression(id, &body).await?;
        Ok::<_, Failure>(format!(
            "Declined {id} ({}); it is not proposed again for 180 days",
            redact(&entry_text(&found["entry"]))
        ))
    };
    run.await.map_err(|Failure(_, m)| redact(&m))
}

/// The default profile suppression entries are written to.
const DEFAULT_PROFILE: &str = ".rio/profiles/default.yaml";

/// The endpoint answers 404 when the tenant has no record for the repository.
fn absent_is_empty(result: Result<Value>, key: &str) -> Result<Value> {
    match result {
        Err(error) if rio_client::http_status(&error) == Some(404) => Ok(json!({ key: [] })),
        other => other,
    }
}

pub async fn findings(args: FindingsArgs) -> u8 {
    finish(
        async {
            let ctx = context("rio findings")?;
            let mut query = vec![("repository", ctx.repository.as_str())];
            for (key, value) in [
                ("status", &args.status),
                ("rule", &args.rule),
                ("since", &args.since),
            ] {
                if let Some(value) = value {
                    query.push((key, value.as_str()));
                }
            }
            let answer = absent_is_empty(ctx.client.findings(&query).await, "findings")?;
            let records = answer["findings"]
                .as_array()
                .context("the endpoint returned no findings list")?;
            if args.format == ListFormat::Json {
                return print_json(&json!({"repository": ctx.repository, "findings": records}));
            }
            let mut out = format!(
                "Finding registry for {}: {} record(s)\n",
                ctx.repository,
                records.len()
            );
            for r in records {
                let location = &r["location"];
                out.push_str(&format!(
                    "  {}  {}  {}:{}  {}{}  last seen {} ({} review(s))\n",
                    rio_core::display_id(r["identity"].as_str().unwrap_or("")),
                    r["rule_id"].as_str().unwrap_or(""),
                    location["path"].as_str().unwrap_or("?"),
                    location["line_start"],
                    r["status"].as_str().unwrap_or(""),
                    r["author_response"]["reason"]
                        .as_str()
                        .map(|reason| format!(" ({reason})"))
                        .unwrap_or_default(),
                    r["last_seen"].as_str().unwrap_or(""),
                    r["seen_count"],
                ));
            }
            crate::write_stdout(redact(&out).as_bytes())?;
            Ok(())
        }
        .await,
    )
}

fn entry_text(entry: &Value) -> String {
    match (entry["rule"].as_str(), entry["path"].as_str()) {
        (Some(rule), _) => format!("rule: {}", json!(rule)),
        (_, Some(path)) => format!("path: {}", json!(path)),
        _ => entry.to_string(),
    }
}

async fn proposal(ctx: &Scope, id: &str) -> Result<Value, Failure> {
    let answer = absent_is_empty(
        ctx.client
            .suppressions(&[("repository", ctx.repository.as_str())])
            .await,
        "suppressions",
    )?;
    answer["suppressions"]
        .as_array()
        .and_then(|list| list.iter().find(|p| p["id"] == id).cloned())
        .ok_or_else(|| {
            Failure(
                3,
                format!(
                    "suppression proposal {id} was not found for {}",
                    ctx.repository
                ),
            )
        })
}

pub async fn suppressions(command: SuppressionsCommand) -> u8 {
    finish(
        async {
            let ctx = context("rio suppressions")?;
            match command {
                SuppressionsCommand::List { status, format } => {
                    let mut query = vec![("repository", ctx.repository.as_str())];
                    if let Some(status) = &status {
                        query.push(("status", status.as_str()));
                    }
                    let answer =
                        absent_is_empty(ctx.client.suppressions(&query).await, "suppressions")?;
                    let list = answer["suppressions"]
                        .as_array()
                        .context("the endpoint returned no suppressions list")?;
                    if format == ListFormat::Json {
                        return print_json(
                            &json!({"repository": ctx.repository, "suppressions": list}),
                        );
                    }
                    let mut out = format!(
                        "Suppression proposals for {}: {}\n",
                        ctx.repository,
                        list.len()
                    );
                    for p in list {
                        out.push_str(&format!(
                            "  {}  {}  {}  {} piece(s) of evidence\n",
                            p["id"].as_str().unwrap_or(""),
                            entry_text(&p["entry"]),
                            p["status"].as_str().unwrap_or(""),
                            p["evidence_count"]
                        ));
                    }
                    crate::write_stdout(redact(&out).as_bytes())?;
                    Ok(())
                }
                SuppressionsCommand::Apply { id, yes } => apply(&ctx, &id, yes).await,
                SuppressionsCommand::Decline { id, note } => {
                    let found = open_proposal(&ctx, &id).await?;
                    let mut body = json!({"status": "declined"});
                    if let Some(note) = note {
                        body["note"] = json!(note);
                    }
                    ctx.client.decide_suppression(&id, &body).await?;
                    println!(
                        "Declined {id} ({}); it is not proposed again for 180 days",
                        redact(&entry_text(&found["entry"]))
                    );
                    Ok(())
                }
            }
        }
        .await,
    )
}

/// The proposal, which must still be open.
async fn open_proposal(ctx: &Scope, id: &str) -> Result<Value, Failure> {
    let found = proposal(ctx, id).await?;
    if found["status"] != "proposed" {
        return Err(Failure(
            2,
            format!(
                "suppression proposal {id} is {}, not proposed",
                found["status"].as_str().unwrap_or("unknown")
            ),
        ));
    }
    Ok(found)
}

async fn apply(ctx: &Scope, id: &str, yes: bool) -> Result<(), Failure> {
    let found = open_proposal(ctx, id).await?;
    let entry = entry_text(&found["entry"]);
    let mut out = format!(
        "Proposal {id}: suppress\n  - {entry}\nEvidence ({}):\n",
        found["evidence_count"]
    );
    for e in found["evidence"].as_array().into_iter().flatten() {
        out.push_str(&format!(
            "  {} {} by {} at {}\n",
            rio_core::display_id(e["finding"].as_str().unwrap_or("")),
            e["reason"].as_str().unwrap_or(""),
            e["actor"].as_str().unwrap_or("unknown"),
            e["at"].as_str().unwrap_or("")
        ));
    }
    crate::write_stdout(redact(&out).as_bytes())?;
    let path = ctx.root.join(DEFAULT_PROFILE);
    if !yes {
        eprint!(
            "Append this entry to {}? [y/N] ",
            path.strip_prefix(&ctx.root).unwrap_or(&path).display()
        );
        io::stderr().flush()?;
        // A closed or non-interactive stdin reads as no.
        let mut answer = String::new();
        io::stdin().lock().read_line(&mut answer)?;
        if !matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes") {
            return Err(Failure(
                1,
                format!(
                    "Not applied: no confirmation. The file is unchanged and {id} stays proposed; pass --yes to apply without the prompt."
                ),
            ));
        }
    }
    println!("{}", commit(ctx, id, &found).await?);
    Ok(())
}

/// Writes a consented proposal's entry and marks it applied.
async fn commit(ctx: &Scope, id: &str, found: &Value) -> Result<String, Failure> {
    let entry = entry_text(&found["entry"]);
    let path = ctx.root.join(DEFAULT_PROFILE);
    write_entry(ctx, &path, &entry).map_err(|error| Failure(2, format!("{error:#}")))?;
    ctx.client
        .decide_suppression(id, &json!({"status": "applied"}))
        .await
        .map_err(|error| {
            Failure(
                3,
                format!(
                    "the entry was written to {} and the profile validates, but the endpoint did not mark {id} applied: {error:#}",
                    path.display()
                ),
            )
        })?;
    Ok(format!(
        "Applied {id}: {} now suppresses {entry}; commit it with your change",
        path.strip_prefix(&ctx.root).unwrap_or(&path).display()
    ))
}

/// Writes the appended profile to a sibling temporary file, validates it there
/// and only then renames it over the default profile, so the original is never
/// truncated: a failed write or validation leaves it byte for byte unchanged.
/// The original's permissions are kept; a new file gets 0644 on Unix.
fn write_entry(ctx: &Scope, path: &Path, entry: &str) -> Result<()> {
    let (candidate, _, _, error) = candidate(ctx, path, entry)?;
    if let Some(error) = error {
        bail!(
            "the profile does not validate with the entry, so {} was left unchanged: {error}",
            path.display()
        );
    }
    candidate.persist(path).map_err(|error| error.error)?;
    Ok(())
}

/// The profile with the entry appended, written to a sibling temporary file
/// and validated there: the file, its text, the original's text, and the
/// validation error if any. The profile itself is not touched.
fn candidate(
    ctx: &Scope,
    path: &Path,
    entry: &str,
) -> Result<(tempfile::NamedTempFile, String, String, Option<String>)> {
    let previous = match std::fs::read(path) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    let next = match &previous {
        Some(bytes) => append_suppression(
            std::str::from_utf8(bytes).context("the default profile is not UTF-8")?,
            entry,
        )?,
        None => format!(
            "# Created by `rio suppressions apply`.\nversion: 1\nname: default\nextends: rio/base\nsuppress:\n  - {entry}\n"
        ),
    };
    let parent = path.parent().context("the profile path has no directory")?;
    std::fs::create_dir_all(parent)?;
    let mut candidate = tempfile::Builder::new()
        .prefix(".default.rio-apply-")
        .suffix(".yaml")
        .tempfile_in(parent)?;
    candidate.write_all(next.as_bytes())?;
    candidate.as_file().sync_all()?;
    match std::fs::metadata(path) {
        Ok(metadata) => candidate
            .as_file()
            .set_permissions(metadata.permissions())?,
        #[cfg(unix)]
        Err(_) => {
            use std::os::unix::fs::PermissionsExt;
            candidate
                .as_file()
                .set_permissions(std::fs::Permissions::from_mode(0o644))?
        }
        #[cfg(not(unix))]
        Err(_) => {}
    }
    let loader = rio_profile::ProfileLoader::new(
        Some(ctx.root.clone()),
        ctx.config.config_dir.clone(),
        ctx.root.clone(),
    );
    let error = loader
        .load(Some(&candidate.path().to_string_lossy()))
        .err()
        .map(|error| error.to_string());
    let previous = previous
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default();
    Ok((candidate, next, previous, error))
}

/// Appends `- <entry>` to the top-level `suppress` block list of a profile,
/// keeping every other byte. A missing key is added at the end.
pub fn append_suppression(text: &str, entry: &str) -> Result<String> {
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let key = lines.iter().position(|line| {
        line.strip_prefix("suppress:").is_some_and(|rest| {
            rest.trim().is_empty() || rest.trim_start().starts_with('#') || rest.trim() == "[]"
        })
    });
    let mut out = String::new();
    let Some(key) = key else {
        ensure!(
            !lines.iter().any(|line| line.starts_with("suppress:")),
            "the profile's suppress list is written inline; add the entry by hand"
        );
        out.push_str(text);
        if !text.is_empty() && !text.ends_with('\n') {
            out.push('\n');
        }
        out.push_str(&format!("suppress:\n  - {entry}\n"));
        return Ok(out);
    };
    if lines[key].trim_end() == "suppress: []" {
        for (i, line) in lines.iter().enumerate() {
            if i == key {
                out.push_str(&format!("suppress:\n  - {entry}\n"));
            } else {
                out.push_str(line);
            }
        }
        return Ok(out);
    }
    // The block runs while lines are indented, comments, blank, or `- ` items
    // written at column 0.
    let mut last = key;
    let mut indent: Option<String> = None;
    for (i, line) in lines.iter().enumerate().skip(key + 1) {
        let trimmed = line.trim_start();
        let item = trimmed.starts_with("- ") || trimmed.trim_end() == "-";
        if line.trim().is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if line.starts_with(' ') || line.starts_with('\t') || item {
            if item && indent.is_none() {
                indent = Some(line[..line.len() - trimmed.len()].to_owned());
            }
            last = i;
            continue;
        }
        break;
    }
    let indent = indent.unwrap_or_else(|| "  ".into());
    for (i, line) in lines.iter().enumerate() {
        out.push_str(line);
        if i == last {
            if !line.ends_with('\n') {
                out.push('\n');
            }
            out.push_str(&format!("{indent}- {entry}\n"));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::append_suppression;
    #[test]
    fn appends_to_block_lists_and_keeps_every_other_byte() {
        let entry = r#"rule: "lint/eslint/no-console""#;
        assert_eq!(
            append_suppression("version: 1\nname: d\n", entry).unwrap(),
            "version: 1\nname: d\nsuppress:\n  - rule: \"lint/eslint/no-console\"\n"
        );
        assert_eq!(
            append_suppression("version: 1\nname: d", entry).unwrap(),
            "version: 1\nname: d\nsuppress:\n  - rule: \"lint/eslint/no-console\"\n"
        );
        assert_eq!(
            append_suppression("name: d\nsuppress: []\nposture: balanced\n", entry).unwrap(),
            "name: d\nsuppress:\n  - rule: \"lint/eslint/no-console\"\nposture: balanced\n"
        );
        let text = "# team profile\nname: d\nsuppress:\n    # generated code\n    - path: \"gen/**\"\n\n    - rule: a\nposture: balanced\n";
        assert_eq!(
            append_suppression(text, entry).unwrap(),
            "# team profile\nname: d\nsuppress:\n    # generated code\n    - path: \"gen/**\"\n\n    - rule: a\n    - rule: \"lint/eslint/no-console\"\nposture: balanced\n"
        );
        let text = "name: d\nsuppress:\n- rule: a\nfail_on: {}\n";
        assert_eq!(
            append_suppression(text, entry).unwrap(),
            "name: d\nsuppress:\n- rule: a\n- rule: \"lint/eslint/no-console\"\nfail_on: {}\n"
        );
        assert!(append_suppression("name: d\nsuppress: [{rule: a}]\n", entry).is_err());
    }
}

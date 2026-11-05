use std::{collections::BTreeMap, sync::LazyLock};

use crate::{DiagnosticContext, redact};
use anyhow::{Context, Result, bail, ensure};
use regex::Regex;
use rio_core::{
    Category, EvidenceLevel, Finding, Location, OccurrenceState, Severity, Source, State,
    finding_id,
};
use serde_json::Value;

pub(crate) fn normalized_path(path: &str, context: &DiagnosticContext<'_>) -> Result<String> {
    fn lexical(path: &str) -> Result<String> {
        let absolute = path.starts_with('/');
        let mut parts = Vec::new();
        for part in path.split('/') {
            match part {
                "" | "." => {}
                ".." => {
                    ensure!(
                        parts.pop().is_some(),
                        "diagnostic path escapes the repository"
                    );
                }
                _ => parts.push(part),
            }
        }
        Ok(format!(
            "{}{}",
            if absolute { "/" } else { "" },
            parts.join("/")
        ))
    }
    let path = path.replace('\\', "/");
    let repository = lexical(&context.repository_root.to_string_lossy().replace('\\', "/"))?;
    let absolute = path.starts_with('/') || path.as_bytes().get(1) == Some(&b':');
    let path = lexical(&if absolute {
        path
    } else {
        format!("{repository}/{}/{path}", context.project_root)
    })?;
    for root in std::iter::once(context.repository_root).chain(context.worktree_root) {
        // Tools may report a canonical cwd while the disposable directory uses
        // an alias (notably /var -> /private/var on macOS). Resolve only the
        // trusted roots, never a diagnostic's potentially escaping leaf path.
        let canonical = root.canonicalize().ok();
        for root in std::iter::once(root).chain(canonical.as_deref()) {
            let root = lexical(&root.to_string_lossy().replace('\\', "/"))?;
            if let Some(relative) = path.strip_prefix(&format!("{}/", root.trim_end_matches('/'))) {
                ensure!(!relative.is_empty(), "diagnostic path is empty");
                return Ok(relative.to_owned());
            }
        }
    }
    bail!("diagnostic path is outside the repository: {path}")
}

struct Diagnostic<'a> {
    tool: &'a str,
    kind: &'a str,
    code: &'a str,
    path: &'a str,
    line: u32,
    end: u32,
    column: Option<u32>,
    message: &'a str,
    severity: Severity,
}
fn finding(
    diagnostic: Diagnostic<'_>,
    context: &DiagnosticContext<'_>,
    syntax: &mut BTreeMap<String, Option<crate::SyntaxTable>>,
) -> Result<Finding> {
    let path = normalized_path(diagnostic.path, context)?;
    let rule_id = format!(
        "{}/{}/{}",
        diagnostic.kind, diagnostic.tool, diagnostic.code
    );
    let message = redact(diagnostic.message);
    let symbol_path = syntax
        .entry(path.clone())
        .or_insert_with(|| {
            context
                .sources
                .and_then(|tree| tree.get(&path))
                .and_then(|entry| crate::analyze_source(&path, &entry.content).ok())
        })
        .as_ref()
        .and_then(|table| table.enclosing(diagnostic.line))
        .map(|symbol| symbol.symbol_path.clone())
        .unwrap_or_default();
    let location = Location {
        path: path.clone(),
        line_start: diagnostic.line,
        line_end: diagnostic.end.max(diagnostic.line),
        column: diagnostic.column,
        symbol_path: symbol_path.clone(),
        occurrence_state: OccurrenceState::Unclassified,
    };
    Ok(Finding {
        id: finding_id(
            &rule_id,
            &path,
            &symbol_path,
            diagnostic.message,
            &context.repository_root.to_string_lossy(),
        ),
        rule_id,
        category: Category::Defect,
        evidence_level: EvidenceLevel::StaticProven,
        severity: diagnostic.severity,
        state: State::Unclassified,
        location: location.clone(),
        message,
        trigger: String::new(),
        impact: None,
        suggested_fix: None,
        evidence: vec![format!("{} diagnostic", diagnostic.tool)],
        source: Source::Tool {
            tool: diagnostic.tool.into(),
            version: context.tool_version.into(),
        },
        locations: vec![location],
        advisory: None,
    })
}
fn number(value: &Value, default: u32) -> Result<u32> {
    match value.as_u64() {
        Some(number) => Ok(u32::try_from(number)?.max(1)),
        None if value.is_null() => Ok(default),
        None => bail!("diagnostic coordinate is not an integer"),
    }
}

pub fn parse_tsc(stdout: &[u8], context: &DiagnosticContext<'_>) -> Result<Vec<Finding>> {
    let mut syntax = BTreeMap::new();
    static DIAGNOSTIC: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^(.*)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$").unwrap()
    });
    static GLOBAL: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^(error|warning) (TS\d+): (.*)$").unwrap());
    let text = std::str::from_utf8(stdout)?;
    let mut parsed: Vec<(String, u32, u32, String, String, Severity)> = Vec::new();
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        if let Some(captures) = DIAGNOSTIC.captures(line) {
            parsed.push((
                captures[1].into(),
                captures[2].parse()?,
                captures[3].parse()?,
                captures[5].into(),
                captures[6].into(),
                if &captures[4] == "error" {
                    Severity::Error
                } else {
                    Severity::Warning
                },
            ));
        } else if let Some(captures) = GLOBAL.captures(line) {
            parsed.push((
                "tsconfig.json".into(),
                1,
                1,
                captures[2].into(),
                captures[3].into(),
                if &captures[1] == "error" {
                    Severity::Error
                } else {
                    Severity::Warning
                },
            ));
        } else if line.starts_with(char::is_whitespace) && !parsed.is_empty() {
            let message = &mut parsed.last_mut().unwrap().4;
            message.push('\n');
            message.push_str(line.trim());
        }
        // traceResolution, listFiles, watch banners and summaries are not
        // diagnostics. Exit-code validation still rejects failing runs with
        // no parsed diagnostic.
    }
    parsed
        .iter()
        .map(|(path, line, column, code, message, severity)| {
            finding(
                Diagnostic {
                    tool: "tsc",
                    kind: "typecheck",
                    code,
                    path,
                    line: *line,
                    end: *line,
                    column: Some(*column),
                    message,
                    severity: *severity,
                },
                context,
                &mut syntax,
            )
        })
        .collect()
}

pub fn parse_eslint(stdout: &[u8], context: &DiagnosticContext<'_>) -> Result<Vec<Finding>> {
    let mut syntax = BTreeMap::new();
    let files: Value = serde_json::from_slice(stdout)?;
    let mut findings = Vec::new();
    for file in files.as_array().context("eslint output is not an array")? {
        let path = file["filePath"]
            .as_str()
            .context("eslint result has no filePath")?;
        for message in file["messages"]
            .as_array()
            .context("eslint result has no messages array")?
        {
            let severity = message["severity"]
                .as_u64()
                .context("eslint diagnostic has no severity")?;
            if severity == 0 {
                continue;
            }
            findings.push(finding(
                Diagnostic {
                    tool: "eslint",
                    kind: "lint",
                    code: message["ruleId"].as_str().unwrap_or("parse-error"),
                    path,
                    line: number(&message["line"], 1)?,
                    end: number(&message["endLine"], number(&message["line"], 1)?)?,
                    column: Some(number(&message["column"], 1)?),
                    message: message["message"]
                        .as_str()
                        .context("eslint diagnostic has no message")?,
                    severity: if severity >= 2 {
                        Severity::Error
                    } else {
                        Severity::Warning
                    },
                },
                context,
                &mut syntax,
            )?);
        }
    }
    Ok(findings)
}

pub fn parse_pyright(stdout: &[u8], context: &DiagnosticContext<'_>) -> Result<Vec<Finding>> {
    let mut syntax = BTreeMap::new();
    let value: Value = serde_json::from_slice(stdout)?;
    let mut findings = Vec::new();
    for message in value["generalDiagnostics"]
        .as_array()
        .context("pyright output has no generalDiagnostics")?
    {
        let severity = match message["severity"].as_str() {
            Some("error") => Severity::Error,
            Some("warning") => Severity::Warning,
            Some("information") => Severity::Info,
            _ => bail!("unknown pyright severity"),
        };
        let start = message["range"]["start"]["line"]
            .as_u64()
            .context("pyright diagnostic has no start line")?;
        let end = message["range"]["end"]["line"].as_u64().unwrap_or(start);
        let column = message["range"]["start"]["character"].as_u64().unwrap_or(0);
        findings.push(finding(
            Diagnostic {
                tool: "pyright",
                kind: "typecheck",
                code: message["rule"].as_str().unwrap_or("type-error"),
                path: message["file"]
                    .as_str()
                    .context("pyright diagnostic has no file")?,
                line: u32::try_from(start)?
                    .checked_add(1)
                    .context("line out of range")?,
                end: u32::try_from(end)?
                    .checked_add(1)
                    .context("line out of range")?,
                column: Some(
                    u32::try_from(column)?
                        .checked_add(1)
                        .context("column out of range")?,
                ),
                message: message["message"]
                    .as_str()
                    .context("pyright diagnostic has no message")?,
                severity,
            },
            context,
            &mut syntax,
        )?);
    }
    Ok(findings)
}

pub fn parse_mypy(stdout: &[u8], context: &DiagnosticContext<'_>) -> Result<Vec<Finding>> {
    let mut syntax = BTreeMap::new();
    static LINE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^(.*?):(\d+)(?::(\d+))?: (error|warning|note): (.*?)(?:  \[([^\]]+)\])?$")
            .unwrap()
    });
    let text = std::str::from_utf8(stdout)?;
    let mut findings = Vec::new();
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if line.starts_with('{') {
            let message: Value = serde_json::from_str(line)?;
            if message["severity"].as_str() == Some("note") {
                continue;
            }
            let severity = match message["severity"].as_str() {
                Some("error") => Severity::Error,
                Some("warning") => Severity::Warning,
                _ => bail!("unknown mypy severity"),
            };
            findings.push(finding(
                Diagnostic {
                    tool: "mypy",
                    kind: "typecheck",
                    code: message["code"].as_str().unwrap_or("type-error"),
                    path: message["file"]
                        .as_str()
                        .context("mypy diagnostic has no file")?,
                    line: number(&message["line"], 1)?,
                    end: number(&message["line"], 1)?,
                    column: message["column"]
                        .as_i64()
                        .filter(|&value| value >= 0)
                        .map(|value| u32::try_from(value).map(|value| value.saturating_add(1)))
                        .transpose()?,
                    message: message["message"]
                        .as_str()
                        .context("mypy diagnostic has no message")?,
                    severity,
                },
                context,
                &mut syntax,
            )?);
        } else if let Some(captures) = LINE.captures(line) {
            if &captures[4] == "note" {
                continue;
            }
            let line = captures[2].parse()?;
            findings.push(finding(
                Diagnostic {
                    tool: "mypy",
                    kind: "typecheck",
                    code: captures.get(6).map_or("type-error", |value| value.as_str()),
                    path: &captures[1],
                    line,
                    end: line,
                    column: captures
                        .get(3)
                        .map(|value| value.as_str().parse())
                        .transpose()?,
                    message: &captures[5],
                    severity: if &captures[4] == "error" {
                        Severity::Error
                    } else {
                        Severity::Warning
                    },
                },
                context,
                &mut syntax,
            )?);
        } else if !(line.starts_with("Success: no issues found")
            || (line.starts_with("Found ") && line.contains(" error")))
        {
            bail!("unrecognized mypy output: {}", redact(line));
        }
    }
    Ok(findings)
}

pub fn parse_ruff(stdout: &[u8], context: &DiagnosticContext<'_>) -> Result<Vec<Finding>> {
    let mut syntax = BTreeMap::new();
    let messages: Value = serde_json::from_slice(stdout)?;
    messages
        .as_array()
        .context("ruff output is not an array")?
        .iter()
        .map(|message| {
            finding(
                Diagnostic {
                    tool: "ruff",
                    kind: "lint",
                    code: message["code"].as_str().unwrap_or("parse-error"),
                    path: message["filename"]
                        .as_str()
                        .context("ruff diagnostic has no filename")?,
                    line: number(&message["location"]["row"], 1)?,
                    end: number(
                        &message["end_location"]["row"],
                        number(&message["location"]["row"], 1)?,
                    )?,
                    column: Some(number(&message["location"]["column"], 1)?),
                    message: message["message"]
                        .as_str()
                        .context("ruff diagnostic has no message")?,
                    severity: Severity::Error,
                },
                context,
                &mut syntax,
            )
        })
        .collect()
}

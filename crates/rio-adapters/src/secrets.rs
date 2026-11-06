use anyhow::Result;
use rio_core::{
    Category, EvidenceLevel, Finding, Location, OccurrenceState, Severity, Source, State,
    finding_id, secret_matches_for_path,
};
pub use rio_core::{redact, redact_value, retained_raw, shannon_entropy};
use rio_git::{Diff, Tree};

pub fn scan_secrets(diff: &Diff, head: &Tree) -> Result<Vec<Finding>> {
    let mut findings = Vec::new();
    for file in &diff.files {
        if file.binary
            || file
                .excluded
                .as_deref()
                .is_some_and(|reason| reason != "lockfile")
        {
            continue;
        }
        let Some(entry) = head.get(&file.path) else {
            continue;
        };
        let Ok(content) = std::str::from_utf8(&entry.content) else {
            continue;
        };
        for found in secret_matches_for_path(content, &file.path) {
            let line_start = content[..found.start]
                .bytes()
                .filter(|&byte| byte == b'\n')
                .count() as u32
                + 1;
            let line_end = line_start
                + content[found.start..found.end]
                    .bytes()
                    .filter(|&byte| byte == b'\n')
                    .count() as u32;
            let new = file.hunks.iter().any(|hunk| {
                hunk.head.count > 0
                    && hunk.head.start <= line_end
                    && hunk.head.start.saturating_add(hunk.head.count) > line_start
            });
            let occurrence_state = if new {
                OccurrenceState::New
            } else {
                OccurrenceState::PreExisting
            };
            let location = Location {
                path: file.path.clone(),
                line_start,
                line_end,
                column: Some(
                    content[..found.start]
                        .rsplit('\n')
                        .next()
                        .unwrap()
                        .chars()
                        .count() as u32
                        + 1,
                ),
                symbol_path: String::new(),
                occurrence_state,
            };
            let rule_id = format!("secret/{}", found.pattern);
            let trigger = redact_value(&content[found.start..found.end]);
            let message = format!("Potential {} credential: {trigger}", found.pattern);
            findings.push(Finding {
                id: finding_id(&rule_id, &file.path, "", &message, ""),
                rule_id,
                category: Category::Defect,
                evidence_level: EvidenceLevel::StaticProven,
                severity: Severity::Error,
                state: if new { State::New } else { State::PreExisting },
                location: location.clone(),
                message,
                trigger,
                impact: Some("A credential may be exposed by this change".into()),
                suggested_fix: Some("Remove the credential and rotate it if it was active".into()),
                evidence: vec![format!("Built-in credential pattern {}", found.pattern)],
                source: Source::Tool {
                    tool: "rio-secrets".into(),
                    version: env!("CARGO_PKG_VERSION").into(),
                },
                locations: vec![location],
                advisory: None,
                verification: None,
            });
        }
    }
    Ok(findings)
}

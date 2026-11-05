use crate::{Ecosystem, parse_lockfile};
use anyhow::{Context, Result, bail, ensure};
use fs4::fs_std::FileExt;
use rio_core::{
    Advisory, AdvisorySeverity, Category, CheckDetails, CheckOutcome, EvidenceLevel, FailureReason,
    Finding, Location, OccurrenceState, Severity, SkipReason, Source, State, finding_id,
};
use rio_git::{Diff, Tree, private_directory, private_file, sync_directory};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Write,
    path::PathBuf,
    str::FromStr,
    time::Duration,
};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct AuditPackage {
    pub ecosystem: Ecosystem,
    pub name: String,
    pub version: String,
    pub path: String,
}

#[derive(Default)]
pub struct AuditPlan {
    pub packages: Vec<AuditPackage>,
    pub notes: Vec<String>,
}

pub fn dependency_audit_plan(base: &Tree, head: &Tree, diff: &Diff) -> Result<AuditPlan> {
    let mut plan = AuditPlan::default();
    for file in &diff.files {
        let name = file.path.rsplit('/').next().unwrap();
        if !matches!(
            name,
            "package-lock.json"
                | "npm-shrinkwrap.json"
                | "pnpm-lock.yaml"
                | "yarn.lock"
                | "uv.lock"
                | "poetry.lock"
                | "Pipfile.lock"
                | "Cargo.lock"
        ) && !(name.starts_with("requirements") && name.ends_with(".txt"))
        {
            continue;
        }
        let Some(entry) = head.get(&file.path) else {
            continue;
        };
        let graph = parse_lockfile(name, std::str::from_utf8(&entry.content)?)?;
        plan.notes.extend(
            graph
                .notes
                .iter()
                .map(|note| format!("{}: {note}", file.path)),
        );
        let previous = base
            .get(file.old_path.as_deref().unwrap_or(&file.path))
            .map(|entry| parse_lockfile(name, std::str::from_utf8(&entry.content)?))
            .transpose()?;
        let versions = previous.map(|graph| graph.flattened()).unwrap_or_default();
        for (ecosystem, name, version) in graph.flattened().difference(&versions) {
            plan.packages.push(AuditPackage {
                ecosystem: *ecosystem,
                name: name.clone(),
                version: version.clone(),
                path: file.path.clone(),
            });
        }
    }
    plan.packages.sort();
    plan.packages
        .dedup_by(|a, b| a.ecosystem == b.ecosystem && a.name == b.name && a.version == b.version);
    Ok(plan)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedAdvisory {
    modified: String,
    record: Value,
}

#[derive(Clone)]
pub struct OsvClient {
    client: reqwest::Client,
    base: String,
    cache: PathBuf,
    retry_delay: Duration,
    lock_timeout: Duration,
    used: std::sync::Arc<std::sync::Mutex<BTreeSet<String>>>,
}

impl OsvClient {
    pub fn new(cache: PathBuf) -> Result<Self> {
        Self::with_base(cache, "https://api.osv.dev".into())
    }
    /// A configurable base permits local mock servers; the CLI uses `new`.
    pub fn with_base(cache: PathBuf, base: String) -> Result<Self> {
        Ok(Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            base: base.trim_end_matches('/').into(),
            cache,
            retry_delay: Duration::from_millis(200),
            lock_timeout: Duration::from_secs(10),
            used: std::sync::Arc::new(std::sync::Mutex::new(BTreeSet::new())),
        })
    }

    pub fn used_cache_entries(&self) -> Vec<String> {
        self.used.lock().unwrap().iter().cloned().collect()
    }

    async fn request(
        &self,
        path: &str,
        body: Option<&Value>,
        cancellation: &CancellationToken,
    ) -> Result<Value> {
        let mut last_error = String::new();
        'attempts: for attempt in 0..3 {
            if attempt > 0 {
                tokio::select! { _ = cancellation.cancelled() => bail!("interrupted"), _ = tokio::time::sleep(self.retry_delay * (1 << (attempt - 1))) => {} }
            }
            let request = if let Some(body) = body {
                self.client.post(format!("{}{path}", self.base)).json(body)
            } else {
                self.client.get(format!("{}{path}", self.base))
            };
            let response = tokio::select! { _ = cancellation.cancelled() => bail!("interrupted"), response = request.send() => response };
            match response {
                Ok(mut response) if response.status().is_success() => {
                    let mut bytes = Vec::new();
                    loop {
                        let chunk = tokio::select! { _ = cancellation.cancelled() => bail!("interrupted"), chunk = response.chunk() => chunk };
                        let chunk = match chunk {
                            Ok(chunk) => chunk,
                            Err(error) => {
                                last_error = error.to_string();
                                continue 'attempts;
                            }
                        };
                        let Some(chunk) = chunk else {
                            break;
                        };
                        ensure!(
                            bytes.len() + chunk.len() <= 16 * 1024 * 1024,
                            "OSV response exceeds 16 MiB"
                        );
                        bytes.extend_from_slice(&chunk);
                    }
                    return serde_json::from_slice(&bytes).context("invalid OSV JSON response");
                }
                Ok(response) => {
                    let status = response.status();
                    last_error = format!("OSV request {path}: HTTP {status}");
                    if status.as_u16() != 429 && !status.is_server_error() {
                        break;
                    }
                }
                Err(error) => {
                    last_error = error.to_string();
                }
            }
        }
        bail!("{last_error}")
    }

    async fn detail(
        &self,
        id: &str,
        modified: &str,
        cancellation: &CancellationToken,
    ) -> Result<Value> {
        ensure!(
            !id.is_empty()
                && id.len() < 256
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
                && id != "."
                && id != "..",
            "unsafe advisory id"
        );
        self.used.lock().unwrap().insert(format!("osv/{id}.json"));
        let directory = self.cache.join("osv");
        private_directory(&directory)?;
        let destination = directory.join(format!("{id}.json"));
        let lock = private_file(&directory.join(format!("{id}.lock")), false)?;
        let started = tokio::time::Instant::now();
        while !FileExt::try_lock_exclusive(&lock)? {
            ensure!(
                started.elapsed() < self.lock_timeout,
                "OSV cache lock timed out"
            );
            tokio::select! { _ = cancellation.cancelled() => bail!("interrupted"), _ = tokio::time::sleep(Duration::from_millis(10)) => {} }
        }
        if !modified.is_empty()
            && let Ok(bytes) = std::fs::read(&destination)
            && let Ok(cached) = serde_json::from_slice::<CachedAdvisory>(&bytes)
            && cached.modified == modified
        {
            return Ok(cached.record);
        }
        let record = self
            .request(&format!("/v1/vulns/{id}"), None, cancellation)
            .await?;
        ensure!(
            record["id"].as_str() == Some(id),
            "OSV advisory id mismatch"
        );
        let mut temporary = tempfile::Builder::new()
            .prefix(&format!("{id}.tmp-"))
            .tempfile_in(&directory)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            temporary
                .as_file()
                .set_permissions(std::fs::Permissions::from_mode(0o600))?;
        }
        temporary.write_all(&serde_json::to_vec(&CachedAdvisory {
            modified: modified.into(),
            record: record.clone(),
        })?)?;
        temporary.as_file().sync_all()?;
        temporary
            .persist(&destination)
            .map_err(|error| error.error)?;
        sync_directory(&directory)?;
        Ok(record)
    }

    pub async fn audit(
        &self,
        packages: &[AuditPackage],
        offline: bool,
        cancellation: CancellationToken,
    ) -> CheckOutcome {
        if offline {
            return skipped(SkipReason::Offline, "Dependency audit needs api.osv.dev");
        }
        if packages.is_empty() {
            return skipped(
                SkipReason::NothingToAudit,
                "No added or changed pinned dependency versions",
            );
        }
        let mut ids = vec![BTreeSet::<String>::new(); packages.len()];
        let mut modified = BTreeMap::<String, String>::new();
        for start in (0..packages.len()).step_by(1000) {
            let mut pending: Vec<_> = (start..(start + 1000).min(packages.len()))
                .map(|index| (index, String::new()))
                .collect();
            let mut seen = BTreeSet::new();
            while !pending.is_empty() {
                let queries: Vec<_> = pending.iter().map(|(index, token)| {
                    let package = &packages[*index]; let mut query = json!({"package":{"ecosystem":package.ecosystem,"name":package.name},"version":package.version});
                    if !token.is_empty() { query["page_token"] = token.clone().into(); } query
                }).collect();
                let response = match self
                    .request(
                        "/v1/querybatch",
                        Some(&json!({"queries":queries})),
                        &cancellation,
                    )
                    .await
                {
                    Ok(response) => response,
                    Err(error) => {
                        return audit_failure(
                            &cancellation,
                            FailureReason::NetworkError,
                            error.to_string(),
                            Vec::new(),
                        );
                    }
                };
                let Some(results) = response["results"]
                    .as_array()
                    .filter(|results| results.len() == pending.len())
                else {
                    return audit_failure(
                        &cancellation,
                        FailureReason::NetworkError,
                        "OSV batch result count mismatch".into(),
                        Vec::new(),
                    );
                };
                let mut next = Vec::new();
                for ((index, _), result) in pending.iter().zip(results) {
                    if !result.is_object() {
                        return audit_failure(
                            &cancellation,
                            FailureReason::NetworkError,
                            "invalid OSV batch result".into(),
                            Vec::new(),
                        );
                    }
                    for advisory in result["vulns"].as_array().into_iter().flatten() {
                        let Some(id) = advisory["id"].as_str() else {
                            return audit_failure(
                                &cancellation,
                                FailureReason::NetworkError,
                                "OSV advisory missing id".into(),
                                Vec::new(),
                            );
                        };
                        ids[*index].insert(id.into());
                        modified.insert(
                            id.into(),
                            advisory["modified"].as_str().unwrap_or_default().into(),
                        );
                    }
                    if let Some(token) = result["next_page_token"]
                        .as_str()
                        .filter(|token| !token.is_empty())
                    {
                        if !seen.insert((*index, token.to_owned())) {
                            return audit_failure(
                                &cancellation,
                                FailureReason::NetworkError,
                                "OSV repeated pagination token".into(),
                                Vec::new(),
                            );
                        }
                        next.push((*index, token.to_owned()));
                    }
                }
                pending = next;
            }
        }
        let mut tasks = JoinSet::new();
        let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(8));
        for (id, modified) in modified {
            let client = self.clone();
            let cancellation = cancellation.clone();
            let semaphore = semaphore.clone();
            tasks.spawn(async move {
                let _permit = semaphore.acquire_owned().await.expect("open semaphore");
                let record = client.detail(&id, &modified, &cancellation).await;
                (id, record)
            });
        }
        let mut records = BTreeMap::new();
        let mut errors = Vec::new();
        while let Some(result) = tasks.join_next().await {
            match result {
                Ok((id, Ok(record))) => {
                    records.insert(id, record);
                }
                Ok((id, Err(error))) => {
                    errors.push(format!("{id}: {error}"));
                    records.insert(id.clone(), json!({"id": id}));
                }
                Err(error) => errors.push(error.to_string()),
            }
        }
        let findings = packages
            .iter()
            .zip(ids)
            .flat_map(|(package, ids)| {
                advisory_findings(
                    package,
                    ids.iter()
                        .filter_map(|id| records.get(id))
                        .cloned()
                        .collect(),
                )
            })
            .collect::<Vec<_>>();
        if !errors.is_empty() || cancellation.is_cancelled() {
            audit_failure(
                &cancellation,
                FailureReason::PartialData,
                errors.join("; "),
                findings,
            )
        } else if findings.is_empty() {
            CheckOutcome::Passed {
                details: CheckDetails::default(),
            }
        } else {
            CheckOutcome::Findings {
                details: CheckDetails {
                    findings,
                    ..Default::default()
                },
            }
        }
    }
}

fn skipped(reason: SkipReason, hint: &str) -> CheckOutcome {
    CheckOutcome::Skipped {
        reason,
        details: CheckDetails {
            hint: Some(hint.into()),
            ..Default::default()
        },
    }
}
fn audit_failure(
    cancellation: &CancellationToken,
    reason: FailureReason,
    hint: String,
    findings: Vec<Finding>,
) -> CheckOutcome {
    let details = CheckDetails {
        hint: Some(crate::redact(&hint)),
        findings,
        ..Default::default()
    };
    if cancellation.is_cancelled() {
        CheckOutcome::Cancelled {
            reason: rio_core::CancellationReason::Interrupted,
            details,
        }
    } else {
        CheckOutcome::Failed { reason, details }
    }
}

pub fn advisory_severity(record: &Value) -> AdvisorySeverity {
    if let Some(severity) = record["database_specific"]["severity"].as_str() {
        match severity.to_ascii_lowercase().as_str() {
            "critical" => return AdvisorySeverity::Critical,
            "high" => return AdvisorySeverity::High,
            "moderate" | "medium" => return AdvisorySeverity::Moderate,
            "low" => return AdvisorySeverity::Low,
            _ => {}
        }
    }
    let score = record["severity"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|severity| matches!(severity["type"].as_str(), Some("CVSS_V3" | "CVSS_V4")))
        .filter_map(|severity| severity["score"].as_str())
        .filter_map(|score| {
            // OSV severity uses the base score, independent of optional threat,
            // temporal and environmental metrics present in the vector.
            let base: Vec<_> = score
                .split('/')
                .filter(|part| {
                    let metric = part.split(':').next().unwrap_or_default();
                    matches!(
                        metric,
                        "CVSS"
                            | "AV"
                            | "AC"
                            | "AT"
                            | "PR"
                            | "UI"
                            | "S"
                            | "C"
                            | "I"
                            | "A"
                            | "VC"
                            | "VI"
                            | "VA"
                            | "SC"
                            | "SI"
                            | "SA"
                    )
                })
                .collect();
            cvss::Cvss::from_str(&base.join("/")).ok()
        })
        .map(|score| score.score())
        .max_by(f64::total_cmp);
    match score {
        Some(score) if score >= 9.0 => AdvisorySeverity::Critical,
        Some(score) if score >= 7.0 => AdvisorySeverity::High,
        Some(score) if score >= 4.0 => AdvisorySeverity::Moderate,
        Some(_) => AdvisorySeverity::Low,
        None => AdvisorySeverity::Unknown,
    }
}

fn greater(ecosystem: Ecosystem, a: &str, b: &str) -> Option<bool> {
    match ecosystem {
        Ecosystem::Npm | Ecosystem::CratesIo => {
            Some(node_semver::Version::parse(a).ok()? > node_semver::Version::parse(b).ok()?)
        }
        Ecosystem::PyPi => {
            Some(pep440_rs::Version::from_str(a).ok()? > pep440_rs::Version::from_str(b).ok()?)
        }
    }
}

pub fn advisory_fixed_version(record: &Value, package: &AuditPackage) -> String {
    let mut fixed = Vec::<String>::new();
    for affected in record["affected"].as_array().into_iter().flatten() {
        if affected["package"]["name"].as_str() != Some(package.name.as_str())
            || serde_json::from_value::<Ecosystem>(affected["package"]["ecosystem"].clone()).ok()
                != Some(package.ecosystem)
        {
            continue;
        }
        for range in affected["ranges"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|range| matches!(range["type"].as_str(), Some("SEMVER" | "ECOSYSTEM")))
        {
            let mut applicable = false;
            for event in range["events"].as_array().into_iter().flatten() {
                if let Some(introduced) = event["introduced"].as_str() {
                    applicable = introduced == "0"
                        || introduced == package.version
                        || greater(package.ecosystem, &package.version, introduced) == Some(true);
                }
                if let Some(version) = event["fixed"].as_str() {
                    if applicable
                        && greater(package.ecosystem, version, &package.version) == Some(true)
                    {
                        fixed.push(version.into());
                    }
                    applicable = false;
                }
                if let Some(last) = event["last_affected"].as_str()
                    && greater(package.ecosystem, &package.version, last) == Some(true)
                {
                    applicable = false;
                }
                if let Some(limit) = event["limit"].as_str()
                    && greater(package.ecosystem, limit, &package.version) != Some(true)
                {
                    applicable = false;
                }
            }
        }
    }
    fixed.sort_by(|a, b| {
        if greater(package.ecosystem, a, b) == Some(true) {
            std::cmp::Ordering::Greater
        } else if greater(package.ecosystem, b, a) == Some(true) {
            std::cmp::Ordering::Less
        } else {
            a.cmp(b)
        }
    });
    fixed.into_iter().next().unwrap_or_else(|| "unknown".into())
}

fn advisory_findings(package: &AuditPackage, mut records: Vec<Value>) -> Vec<Finding> {
    let mut findings = Vec::new();
    while let Some(record) = records.pop() {
        let mut group = vec![record];
        let mut aliases = BTreeSet::new();
        loop {
            for record in &group {
                if let Some(id) = record["id"].as_str() {
                    aliases.insert(id.to_owned());
                }
                aliases.extend(
                    record["aliases"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .map(str::to_owned),
                );
            }
            let mut moved = false;
            let mut remaining = Vec::new();
            for record in records {
                if record["id"].as_str().is_some_and(|id| aliases.contains(id))
                    || record["aliases"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .any(|id| aliases.contains(id))
                {
                    group.push(record);
                    moved = true;
                } else {
                    remaining.push(record);
                }
            }
            records = remaining;
            if !moved {
                break;
            }
        }
        let id = group
            .iter()
            .filter_map(|record| record["id"].as_str())
            .min()
            .unwrap_or_default()
            .to_owned();
        aliases.remove(&id);
        let severity = group
            .iter()
            .map(advisory_severity)
            .min_by_key(|severity| match severity {
                AdvisorySeverity::Critical => 0,
                AdvisorySeverity::High => 1,
                AdvisorySeverity::Moderate => 2,
                AdvisorySeverity::Low => 3,
                AdvisorySeverity::Unknown => 4,
            })
            .unwrap_or(AdvisorySeverity::Unknown);
        let fixed_version = group
            .iter()
            .map(|record| advisory_fixed_version(record, package))
            .filter(|version| version != "unknown")
            .min_by(|a, b| {
                if greater(package.ecosystem, a, b) == Some(true) {
                    std::cmp::Ordering::Greater
                } else if greater(package.ecosystem, b, a) == Some(true) {
                    std::cmp::Ordering::Less
                } else {
                    a.cmp(b)
                }
            })
            .unwrap_or_else(|| "unknown".into());
        let trigger = format!("{}@{}:{id}", package.name, package.version);
        let location = Location {
            path: package.path.clone(),
            line_start: 1,
            line_end: 1,
            column: None,
            symbol_path: format!("{}@{}", package.name, package.version),
            occurrence_state: OccurrenceState::New,
        };
        findings.push(Finding {
            id: finding_id(
                "dependency/vulnerable_dependency",
                &package.path,
                &location.symbol_path,
                &trigger,
                "",
            ),
            rule_id: "dependency/vulnerable_dependency".into(),
            category: Category::Defect,
            evidence_level: EvidenceLevel::StaticProven,
            severity: Severity::Error,
            state: State::New,
            location: location.clone(),
            locations: vec![location],
            message: format!("{}@{} is affected by {id}", package.name, package.version),
            trigger,
            impact: None,
            suggested_fix: (fixed_version != "unknown")
                .then(|| format!("Upgrade to {fixed_version}")),
            evidence: vec![format!("osv/{id}.json")],
            source: Source::Tool {
                tool: "OSV".into(),
                version: "v1".into(),
            },
            advisory: Some(Advisory {
                url: format!("https://osv.dev/vulnerability/{id}"),
                id,
                aliases: aliases.into_iter().collect(),
                severity,
                fixed_version,
            }),
        });
    }
    findings.sort_by(|a, b| a.id.cmp(&b.id));
    findings
}

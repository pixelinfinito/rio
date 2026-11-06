//! Local `--since-last` branch lineages. The endpoint is the single authority for
//! lineage state; this module only keeps a versioned, prunable cache of it under
//! `<cache>/lineages/`.
use anyhow::{Context, Result, ensure};
use rio_core::{LineageKind, Report};
use rio_engine::{CacheOptions, LINEAGES, write_cache_file};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::BTreeSet, fs, path::Path};

/// Format version of the local copy. Copies with another version are refetched.
pub const VERSION: u32 = 1;

/// A branch lineage reference as submitted to the endpoint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BranchLineage {
    pub repository: String,
    pub branch: String,
    pub reset: bool,
}
impl BranchLineage {
    pub fn key(&self) -> String {
        blake3::hash(format!("{}|{}", self.repository, self.branch).as_bytes())
            .to_hex()
            .to_string()
    }
    pub fn relative_path(&self) -> String {
        format!("{LINEAGES}/{}.json", self.key())
    }
    /// The `lineage` object of `POST /v1/reviews`.
    pub fn submission(&self) -> Value {
        json!({"repository":self.repository,"kind":"branch","ref":self.branch,"reset":self.reset})
    }
}

/// Removes scheme, credentials, port and `.git` suffix so that HTTPS and SSH
/// remotes of the same repository share one key, e.g.
/// `git@github.com:o/r.git` and `https://user:x@github.com/o/r` both give
/// `github.com/o/r`.
pub fn normalize_remote(url: &str) -> Option<String> {
    let url = url.trim();
    let (authority, path) = if let Some((_, rest)) = url.split_once("://") {
        match rest.split_once('/') {
            Some((authority, path)) => (authority, path),
            None => (rest, ""),
        }
    } else if let Some((authority, path)) = url.split_once(':')
        && !authority.contains('/')
        && !authority.is_empty()
    {
        // scp-like `[user@]host:path`
        (authority, path)
    } else {
        // A local path remote.
        ("", url)
    };
    let host = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    let host = if host.starts_with('[') {
        host.split_inclusive(']').next().unwrap_or(host)
    } else {
        host.split(':').next().unwrap_or(host)
    }
    .to_ascii_lowercase();
    let path = path.trim_matches('/');
    let path = path
        .strip_suffix(".git")
        .unwrap_or(path)
        .trim_end_matches('/');
    let key = match (host.is_empty(), path.is_empty()) {
        (true, true) => return None,
        (true, false) => path.to_owned(),
        (false, true) => host,
        (false, false) => format!("{host}/{path}"),
    };
    Some(key)
}

/// The contract's repository key: the normalized `origin` URL, else the
/// repository directory name.
pub fn repository_key(root: &Path, origin: Option<&str>) -> Result<String> {
    if let Some(key) = origin.and_then(normalize_remote) {
        return Ok(key);
    }
    root.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .context("cannot derive a repository key: no origin remote and no directory name")
}

/// Versioned local copy of the endpoint's lineage state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalLineage {
    pub version: u32,
    pub repository: String,
    pub kind: LineageKind,
    #[serde(rename = "ref")]
    pub reference: String,
    pub generation: u32,
    pub round: u32,
    pub previous_head: Option<String>,
    pub posted: BTreeSet<String>,
    pub rounds_to_pass: Option<u32>,
}

/// `GET /v1/lineages` response body.
#[derive(Deserialize)]
struct EndpointLineage {
    repository: String,
    kind: LineageKind,
    #[serde(rename = "ref")]
    reference: String,
    generation: u32,
    round: u32,
    previous_head: Option<String>,
    #[serde(default)]
    posted: BTreeSet<String>,
    rounds_to_pass: Option<u32>,
}

impl LocalLineage {
    fn matches(&self, lineage: &BranchLineage) -> bool {
        self.version == VERSION
            && self.kind == LineageKind::Branch
            && self.repository == lineage.repository
            && self.reference == lineage.branch
    }
    /// Reads the local copy. A missing, unreadable, foreign or other-version copy
    /// is `None`, which callers must refetch rather than treat as a reset.
    pub fn load(cache: &CacheOptions, lineage: &BranchLineage) -> Option<Self> {
        let bytes = fs::read(cache.dir.join(lineage.relative_path())).ok()?;
        serde_json::from_slice::<Self>(&bytes)
            .ok()
            .filter(|copy| copy.matches(lineage))
    }
    pub fn save(&self, cache: &CacheOptions) -> Result<()> {
        let lineage = BranchLineage {
            repository: self.repository.clone(),
            branch: self.reference.clone(),
            reset: false,
        };
        write_cache_file(
            cache,
            &lineage.relative_path(),
            &serde_json::to_vec_pretty(self)?,
        )
    }
    pub fn from_endpoint(lineage: &BranchLineage, value: Value) -> Result<Self> {
        let state: EndpointLineage =
            serde_json::from_value(value).context("invalid lineage state from endpoint")?;
        ensure!(
            state.kind == LineageKind::Branch
                && state.repository == lineage.repository
                && state.reference == lineage.branch,
            "endpoint returned a different lineage"
        );
        Ok(Self {
            version: VERSION,
            repository: state.repository,
            kind: state.kind,
            reference: state.reference,
            generation: state.generation,
            round: state.round,
            previous_head: state.previous_head,
            posted: state.posted,
            rounds_to_pass: state.rounds_to_pass,
        })
    }
    /// The copy after a finished review: round, generation and convergence come
    /// from `report.lineage`; identities the report shows as posted are added to
    /// those of the same generation; `snapshot` becomes the previous head.
    pub fn after_review(
        previous: Option<&Self>,
        lineage: &BranchLineage,
        report: &Report,
        snapshot: &str,
    ) -> Result<Option<Self>> {
        let Some(state) = &report.lineage else {
            return Ok(None);
        };
        ensure!(
            state.kind == LineageKind::Branch
                && state.repository == lineage.repository
                && state.reference == lineage.branch,
            "endpoint returned a report for a different lineage"
        );
        let mut posted = previous
            .filter(|copy| copy.generation == state.generation)
            .map(|copy| copy.posted.clone())
            .unwrap_or_default();
        posted.extend(
            report
                .findings
                .iter()
                .chain(&report.risks)
                .chain(&report.security)
                .filter(|finding| finding.first_posted_in.is_some())
                .map(|finding| finding.id.clone()),
        );
        Ok(Some(Self {
            version: VERSION,
            repository: lineage.repository.clone(),
            kind: LineageKind::Branch,
            reference: lineage.branch.clone(),
            generation: state.generation,
            round: state.round,
            previous_head: Some(snapshot.to_owned()),
            posted,
            rounds_to_pass: state.rounds_to_pass,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rio_core::{Lineage, ReportStatus};

    fn branch(reset: bool) -> BranchLineage {
        BranchLineage {
            repository: "github.com/pixelinfinito/rio".into(),
            branch: "feature/x".into(),
            reset,
        }
    }

    #[test]
    fn remotes_normalize_to_one_repository_key() {
        for url in [
            "https://github.com/pixelinfinito/rio.git",
            "https://user:secret@GitHub.com/pixelinfinito/rio",
            "http://github.com:443/pixelinfinito/rio/",
            "ssh://git@github.com:22/pixelinfinito/rio.git",
            "git@github.com:pixelinfinito/rio.git",
            "github.com:pixelinfinito/rio",
        ] {
            assert_eq!(
                normalize_remote(url).as_deref(),
                Some("github.com/pixelinfinito/rio"),
                "{url}"
            );
        }
        assert_eq!(
            normalize_remote("/srv/git/rio.git").as_deref(),
            Some("srv/git/rio")
        );
        assert_eq!(
            normalize_remote("file:///srv/git/rio.git").as_deref(),
            Some("srv/git/rio")
        );
        assert_eq!(normalize_remote("  "), None);
        assert_eq!(repository_key(Path::new("/work/rio"), None).unwrap(), "rio");
        assert_eq!(
            repository_key(Path::new("/work/rio"), Some("git@host:o/r.git")).unwrap(),
            "host/o/r"
        );
    }

    #[test]
    fn submission_follows_the_wire_contract() {
        assert_eq!(
            branch(true).submission(),
            json!({"repository":"github.com/pixelinfinito/rio","kind":"branch","ref":"feature/x","reset":true})
        );
        assert_eq!(branch(false).submission()["reset"], false);
        assert_eq!(branch(false).key(), branch(true).key());
        assert_eq!(
            branch(false).relative_path(),
            format!(
                "lineages/{}.json",
                blake3::hash(b"github.com/pixelinfinito/rio|feature/x").to_hex()
            )
        );
    }

    #[test]
    fn local_copy_round_trips_and_invalid_copies_read_as_missing() {
        let temp = tempfile::tempdir().unwrap();
        let cache = CacheOptions::for_repository(temp.path());
        let lineage = branch(false);
        assert_eq!(LocalLineage::load(&cache, &lineage), None);
        let copy = LocalLineage::from_endpoint(
            &lineage,
            json!({"repository":"github.com/pixelinfinito/rio","kind":"branch","ref":"feature/x",
                "generation":1,"round":2,"previous_head":"snap-2","posted":["a"],"rounds_to_pass":null}),
        )
        .unwrap();
        copy.save(&cache).unwrap();
        let path = cache.dir.join(lineage.relative_path());
        assert!(path.is_file());
        assert_eq!(LocalLineage::load(&cache, &lineage), Some(copy.clone()));
        // Another version or another branch's file is not this lineage.
        let mut other = serde_json::to_value(&copy).unwrap();
        other["version"] = json!(VERSION + 1);
        fs::write(&path, serde_json::to_vec(&other).unwrap()).unwrap();
        assert_eq!(LocalLineage::load(&cache, &lineage), None);
        fs::write(&path, b"not json").unwrap();
        assert_eq!(LocalLineage::load(&cache, &lineage), None);
        assert!(
            LocalLineage::from_endpoint(
                &lineage,
                json!({"repository":"other","kind":"branch","ref":"feature/x","generation":1,
                    "round":1,"previous_head":null,"rounds_to_pass":null}),
            )
            .is_err()
        );
    }

    #[test]
    fn copy_after_review_accumulates_posted_identities_per_generation() {
        let lineage = branch(false);
        let previous = LocalLineage {
            version: VERSION,
            repository: lineage.repository.clone(),
            kind: LineageKind::Branch,
            reference: lineage.branch.clone(),
            generation: 1,
            round: 1,
            previous_head: Some("snap-1".into()),
            posted: BTreeSet::from(["old".into()]),
            rounds_to_pass: None,
        };
        let mut report = Report::empty(ReportStatus::Complete);
        assert_eq!(
            LocalLineage::after_review(Some(&previous), &lineage, &report, "snap-2").unwrap(),
            None
        );
        let mut finding: rio_core::Finding =
            serde_json::from_str(include_str!("../../rio-core/tests/fixtures/finding.json"))
                .unwrap();
        finding.id = "new".into();
        finding.first_posted_in = Some("snap-2".into());
        let mut unposted = finding.clone();
        unposted.id = "capped".into();
        unposted.first_posted_in = None;
        report.findings = vec![finding, unposted];
        report.lineage = Some(Lineage {
            repository: lineage.repository.clone(),
            kind: LineageKind::Branch,
            reference: lineage.branch.clone(),
            generation: 1,
            round: 2,
            cap: 3,
            capped: false,
            diff_only: true,
            previous_head: Some("snap-1".into()),
            held_back: 0,
            rounds_to_pass: None,
            author_response_ratio: None,
            reconsider: None,
        });
        let next = LocalLineage::after_review(Some(&previous), &lineage, &report, "snap-2")
            .unwrap()
            .unwrap();
        assert_eq!(next.round, 2);
        assert_eq!(next.previous_head.as_deref(), Some("snap-2"));
        assert_eq!(next.posted, BTreeSet::from(["old".into(), "new".into()]));
        // A new generation (reset) drops the previous generation's identities.
        report.lineage.as_mut().unwrap().generation = 2;
        report.lineage.as_mut().unwrap().round = 1;
        let reset = LocalLineage::after_review(Some(&previous), &lineage, &report, "snap-3")
            .unwrap()
            .unwrap();
        assert_eq!(reset.round, 1);
        assert_eq!(reset.posted, BTreeSet::from(["new".into()]));
        // A report for another lineage is refused.
        report.lineage.as_mut().unwrap().reference = "main".into();
        assert!(LocalLineage::after_review(None, &lineage, &report, "snap-3").is_err());
    }
}

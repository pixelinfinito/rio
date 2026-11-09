use std::collections::BTreeMap;

use globset::Glob;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{QaErrors, QaProject, QaSnapshot};

/// Only immutable, non-secret inputs enter the cache key. Runtime environment
/// and persona credential values are deliberately absent from this interface.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SeedFingerprint {
    pub version: u32,
    pub fingerprint: String,
    pub manifest: String,
    pub seed_files: BTreeMap<String, String>,
    #[serde(default)]
    pub fixture_files: BTreeMap<String, String>,
    pub migrations: BTreeMap<String, String>,
    pub command_sources: BTreeMap<String, String>,
    pub datastores: BTreeMap<String, String>,
    pub cache_version: Value,
    pub image_digest: String,
}

impl SeedFingerprint {
    pub fn build(
        project: &QaProject,
        snapshot: &QaSnapshot,
        image_digest: &str,
    ) -> Result<Self, QaErrors> {
        let digest = image_digest.strip_prefix("sha256:").unwrap_or("");
        if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(QaErrors(
                "seed fingerprint requires a resolved app image digest (sha256), not an image tag"
                    .into(),
            ));
        }
        let manifest_path = &project.config.seed.manifest;
        let directory = manifest_path.rsplit_once('/').map_or("", |(dir, _)| dir);
        let prefix = if directory.is_empty() {
            String::new()
        } else {
            format!("{directory}/")
        };
        let mut seed_files = BTreeMap::new();
        for (path, bytes) in snapshot {
            if path != manifest_path && path.starts_with(&prefix) {
                seed_files.insert(path.clone(), hash(bytes));
            }
        }
        if let Some(seed) = &project.seed {
            for step in &seed.steps {
                if let Some(file) = &step.file {
                    let path = format!("{prefix}{file}");
                    let bytes = snapshot.get(&path).ok_or_else(|| {
                        QaErrors(format!("{path}: referenced seed file is absent"))
                    })?;
                    seed_files.insert(path, hash(bytes));
                }
            }
        }
        let patterns = project
            .config
            .seed
            .migrations
            .iter()
            .map(|pattern| {
                Glob::new(pattern)
                    .map(|glob| glob.compile_matcher())
                    .map_err(|_| QaErrors(format!("invalid migration glob {pattern}")))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let migrations = snapshot
            .iter()
            .filter(|(path, _)| patterns.iter().any(|pattern| pattern.is_match(path)))
            .map(|(path, bytes)| (path.clone(), hash(bytes)))
            .collect();
        // Shell commands can load files indirectly (npm scripts, imports, glob
        // expansion). A static token parser cannot discover that dependency
        // graph reliably. Include all captured source when seed-building
        // commands exist, so an edited loader can never reuse stale data.
        // Credential-apply commands run after restore and do not need this.
        let command_sources = if project
            .seed
            .as_ref()
            .is_some_and(|seed| seed.steps.iter().any(|step| step.command.is_some()))
        {
            snapshot
                .iter()
                .filter(|(path, _)| *path != ".rio/qa.yaml" && *path != manifest_path)
                .map(|(path, bytes)| (path.clone(), hash(bytes)))
                .collect()
        } else {
            BTreeMap::new()
        };
        let mut result = Self {
            version: 2,
            fingerprint: String::new(),
            manifest: snapshot
                .get(manifest_path)
                .map_or_else(|| hash(b"no-seed-manifest"), |bytes| hash(bytes)),
            seed_files,
            fixture_files: snapshot
                .iter()
                .filter(|(path, _)| path.starts_with(".rio/qa/fixtures/"))
                .map(|(path, bytes)| (path.clone(), hash(bytes)))
                .collect(),
            migrations,
            command_sources,
            datastores: project
                .seed
                .as_ref()
                .map(|seed| {
                    seed.datastores
                        .iter()
                        .map(|store| (store.name.clone(), store.kind.clone()))
                        .collect()
                })
                .unwrap_or_default(),
            cache_version: project.config.seed.cache_version.clone(),
            image_digest: image_digest.to_ascii_lowercase(),
        };
        // BTreeMap and a versioned struct make encoding order deterministic.
        result.fingerprint = hash(
            &serde_json::to_vec(&result)
                .map_err(|_| QaErrors("could not encode seed fingerprint".into()))?,
        );
        Ok(result)
    }

    pub fn rebuild_reason(&self, stored: Option<&Self>) -> Option<&'static str> {
        let Some(stored) = stored else {
            return Some("no cached snapshot");
        };
        if self.version != stored.version {
            Some("fingerprint version changed")
        } else if self.image_digest != stored.image_digest {
            Some("app image changed")
        } else if self.migrations != stored.migrations {
            Some("migrations changed")
        } else if self.cache_version != stored.cache_version {
            Some("seed.cache_version changed")
        } else if self.datastores != stored.datastores {
            Some("datastore kinds changed")
        } else if self.manifest != stored.manifest {
            Some("seed manifest changed")
        } else if self.seed_files != stored.seed_files {
            Some("seed files changed")
        } else if self.fixture_files != stored.fixture_files {
            Some("fixture definitions or files changed")
        } else if self.command_sources != stored.command_sources {
            Some("seed command source changed")
        } else if self.fingerprint != stored.fingerprint {
            Some("cached fingerprint mismatch")
        } else {
            None
        }
    }
}

fn hash(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

/// The manifest is the commit point of the separate seed object protocol.
/// Parts are content addressed and shared across fingerprints; a manifest may
/// be published only after every referenced part has been verified.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SeedPart {
    pub hash: String,
    pub bytes: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SeedArchive {
    pub name: String,
    pub kind: String,
    pub hash: String,
    pub bytes: u64,
    pub parts: Vec<SeedPart>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SeedSnapshotManifest {
    pub version: u32,
    pub fingerprint: SeedFingerprint,
    pub created_at_ms: u64,
    pub archives: Vec<SeedArchive>,
}
impl SeedSnapshotManifest {
    pub fn valid(&self, max_size: u64) -> bool {
        let digest =
            |value: &str| value.len() == 64 && value.bytes().all(|c| c.is_ascii_hexdigit());
        let mut total = 0_u64;
        let mut names = std::collections::BTreeSet::new();
        self.version == 1
            && digest(&self.fingerprint.fingerprint)
            && self.fingerprint.datastores.iter().all(|(name, kind)| {
                self.archives
                    .iter()
                    .any(|archive| archive.name == *name && archive.kind == *kind)
            })
            && self.archives.len() <= 1024
            && self.archives.iter().all(|archive| {
                let Some(size) = total.checked_add(archive.bytes) else {
                    return false;
                };
                total = size;
                let valid_name = !archive.name.is_empty()
                    && archive
                        .name
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'-');
                let sum = archive
                    .parts
                    .iter()
                    .try_fold(0_u64, |sum, part| sum.checked_add(part.bytes));
                valid_name
                    && names.insert(&archive.name)
                    && digest(&archive.hash)
                    && matches!(
                        archive.kind.as_str(),
                        "sqlite" | "postgres" | "mysql" | "redis" | "files" | "custom"
                    )
                    && !archive.parts.is_empty()
                    && archive.parts.iter().enumerate().all(|(index, part)| {
                        digest(&part.hash)
                            && part.bytes <= 8 * 1024 * 1024
                            && (index + 1 == archive.parts.len() || part.bytes == 8 * 1024 * 1024)
                    })
                    && sum == Some(archive.bytes)
                    && total <= max_size
            })
    }
}

/// Read-only seed diagnostics. A directory or uncommitted part alone is never a
/// cache hit. Restore still verifies hashes before trusting a published entry.
pub fn seed_cache_status(
    cache: &std::path::Path,
    fingerprint: &SeedFingerprint,
    max_size: u64,
) -> Result<Value, QaErrors> {
    let mut manifests = Vec::new();
    if cache.exists() {
        for entry in std::fs::read_dir(cache)
            .map_err(|_| QaErrors("Could not read QA seed cache".into()))?
            .take(10000)
        {
            let entry = entry.map_err(|_| QaErrors("Could not read QA seed cache entry".into()))?;
            if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.len() != 64 || !name.bytes().all(|c| c.is_ascii_hexdigit()) {
                continue;
            }
            let path = entry.path().join("manifest.json");
            if !std::fs::symlink_metadata(&path).is_ok_and(|metadata| {
                metadata.file_type().is_file() && metadata.len() <= 16 * 1024 * 1024
            }) {
                continue;
            }
            if let Some(manifest) = std::fs::read(path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<SeedSnapshotManifest>(&bytes).ok())
                && manifest.valid(max_size)
                && manifest.fingerprint.fingerprint == name
            {
                manifests.push(manifest);
            }
        }
    }
    let matching = manifests
        .iter()
        .find(|manifest| manifest.fingerprint == *fingerprint);
    let stored = matching.or_else(|| {
        manifests
            .iter()
            .max_by_key(|manifest| manifest.created_at_ms)
    });
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    Ok(serde_json::json!({"fingerprint":fingerprint.fingerprint,
        "stored_fingerprint":stored.map(|manifest| &manifest.fingerprint.fingerprint),
        "next":if matching.is_some() {"restore"} else {"build"},
        "reason":fingerprint.rebuild_reason(stored.map(|manifest| &manifest.fingerprint)),
        "bytes":stored.map(|manifest| manifest.archives.iter().map(|archive| archive.bytes).sum::<u64>()),
        "age_ms":stored.map(|manifest| now.saturating_sub(manifest.created_at_ms)),"storage":"local","path":cache}))
}

pub fn seed_size_limit(value: &Value) -> Result<u64, QaErrors> {
    let invalid = || QaErrors("Invalid or overflowing seed.max_size".into());
    if let Some(bytes) = value.as_u64().filter(|n| *n > 0) {
        return Ok(bytes);
    }
    let text = value.as_str().ok_or_else(invalid)?;
    for (unit, scale) in [
        ("GiB", 1024_u64.pow(3)),
        ("MiB", 1024_u64.pow(2)),
        ("KiB", 1024_u64),
        ("B", 1),
    ] {
        if let Some(number) = text.strip_suffix(unit) {
            return number
                .trim_end()
                .parse::<u64>()
                .ok()
                .filter(|n| *n > 0)
                .and_then(|n| n.checked_mul(scale))
                .ok_or_else(invalid);
        }
    }
    Err(invalid())
}

/// Prune the shared content-addressed store under the controller/host transfer
/// lock. A leased fingerprint or in-flight part survives even with keep=0.
pub fn prune_seed_cache(cache: &std::path::Path, keep: usize) -> anyhow::Result<Vec<String>> {
    use anyhow::{Context, ensure};
    use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
    use cap_std::{
        ambient_authority,
        fs::{Dir, OpenOptions},
    };
    use fs4::fs_std::FileExt;
    use std::{collections::BTreeSet, io::Read};
    fn digest(value: &str) -> bool {
        value.len() == 64
            && value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }
    fn read(dir: &Dir, name: &str) -> anyhow::Result<Vec<u8>> {
        let mut options = OpenOptions::new();
        options.read(true).follow(FollowSymlinks::No);
        let mut file = dir.open_with(name, &options)?;
        let info = file.metadata()?;
        ensure!(
            info.is_file() && info.len() <= 16 * 1024 * 1024,
            "Invalid seed cache record"
        );
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        Ok(bytes)
    }
    if !cache.try_exists()? {
        return Ok(Vec::new());
    }
    let absolute = std::path::absolute(cache)?;
    let root = absolute
        .ancestors()
        .last()
        .context("Invalid seed cache path")?;
    let mut directory = Dir::open_ambient_dir(root, ambient_authority())?;
    for component in absolute.strip_prefix(root)?.components() {
        directory = directory.open_dir_nofollow(component.as_os_str())?;
    }
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(true)
        .create(true)
        .follow(FollowSymlinks::No);
    let lock = directory.open_with(".lock", &options)?.into_std();
    ensure!(lock.metadata()?.is_file(), "Invalid seed cache lock");
    FileExt::lock_exclusive(&lock)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis() as u64;
    let mut leased = BTreeSet::new();
    let mut parts = BTreeSet::new();
    let mut expired = Vec::new();
    let leases = match directory.open_dir_nofollow("leases") {
        Ok(value) => Some(value),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    if let Some(leases) = &leases {
        for entry in leases.entries()? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".json") {
                continue;
            }
            let lease: Value = serde_json::from_slice(&read(leases, &name)?)?;
            let fingerprint = lease["fingerprint"]
                .as_str()
                .filter(|value| digest(value))
                .context("Invalid seed lease fingerprint")?;
            let expiry = lease["expires_at_ms"]
                .as_u64()
                .context("Invalid seed lease expiry")?;
            if expiry > now {
                leased.insert(fingerprint.to_owned());
                for part in lease["parts"]
                    .as_array()
                    .context("Invalid seed lease parts")?
                {
                    parts.insert(
                        part.as_str()
                            .filter(|value| digest(value))
                            .context("Invalid seed lease part")?
                            .to_owned(),
                    );
                }
            } else {
                expired.push(name);
            }
        }
    }
    let mut manifests = Vec::new();
    for entry in directory.entries()? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !digest(&name) {
            continue;
        }
        let snapshot = directory.open_dir_nofollow(&name)?;
        let bytes = match read(&snapshot, "manifest.json") {
            Ok(bytes) => bytes,
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
            {
                continue;
            }
            Err(error) => return Err(error),
        };
        let manifest: SeedSnapshotManifest = serde_json::from_slice(&bytes)?;
        ensure!(
            manifest.valid(u64::MAX) && manifest.fingerprint.fingerprint == name,
            "Invalid seed manifest; pruning refused"
        );
        manifests.push(manifest);
    }
    manifests.sort_by(|a, b| {
        b.created_at_ms
            .cmp(&a.created_at_ms)
            .then_with(|| a.fingerprint.fingerprint.cmp(&b.fingerprint.fingerprint))
    });
    let mut removed = Vec::new();
    for (index, manifest) in manifests.iter().enumerate() {
        let id = &manifest.fingerprint.fingerprint;
        if index < keep || leased.contains(id) {
            parts.extend(
                manifest
                    .archives
                    .iter()
                    .flat_map(|archive| archive.parts.iter().map(|part| part.hash.clone())),
            );
        } else {
            removed.push(id.clone());
        }
    }
    // All manifests and leases are parsed before deletion. Corruption cannot
    // turn a referenced part into an apparently unreachable object.
    for id in &removed {
        directory.remove_dir_all(id)?;
    }
    match directory.open_dir_nofollow("objects") {
        Ok(objects) => {
            for entry in objects.entries()? {
                let entry = entry?;
                let name = entry.file_name().to_string_lossy().into_owned();
                if digest(&name) && !parts.contains(&name) {
                    objects.remove_file(name)?;
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(error) => return Err(error.into()),
    }
    if let Some(leases) = leases {
        for name in expired {
            leases.remove_file(name)?;
        }
    }
    Ok(removed)
}

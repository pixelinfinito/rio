use std::{
    collections::BTreeSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail, ensure};
use fs4::fs_std::FileExt;
use serde::{Deserialize, Serialize};

use crate::{
    ChangeSet, SafeTreeWriter, Tree, TreeEntry, changed_paths, validate_case_collisions,
    validate_tree_path,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SnapshotFile {
    pub path: String,
    pub mode: u32,
    pub size: u64,
    pub hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SnapshotManifest {
    pub schema: String,
    pub base: String,
    pub deleted: Vec<String>,
    pub files: Vec<SnapshotFile>,
}

#[derive(Debug, Clone)]
pub struct Snapshot {
    pub key: String,
    pub manifest: SnapshotManifest,
    pub files: Tree,
}

fn hash_part(hasher: &mut blake3::Hasher, value: &[u8]) {
    hasher.update(&(value.len() as u64).to_le_bytes());
    hasher.update(value);
}

fn key_for(base: &str, deleted: &[String], files: &Tree) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"rio-snapshot-v1\0");
    hash_part(&mut hasher, base.as_bytes());
    let mut paths: Vec<_> = deleted
        .iter()
        .map(|p| (p.as_str(), None))
        .chain(files.iter().map(|(p, e)| (p.as_str(), Some(e))))
        .collect();
    paths.sort_by_key(|(path, _)| *path);
    for (path, entry) in paths {
        hash_part(&mut hasher, path.as_bytes());
        match entry {
            Some(entry) => {
                hasher.update(b"file\0");
                hasher.update(&entry.mode.to_le_bytes());
                hash_part(&mut hasher, &entry.content);
            }
            None => {
                hasher.update(b"deleted\0");
            }
        }
    }
    hasher.finalize().to_hex().to_string()
}

impl Snapshot {
    pub fn from_changes(changes: &ChangeSet) -> Self {
        let mut files = Tree::new();
        let mut deleted = Vec::new();
        for path in changed_paths(&changes.base, &changes.head) {
            if let Some(entry) = changes.head.get(&path) {
                files.insert(path, entry.clone());
            } else {
                deleted.push(path);
            }
        }
        let key = key_for(&changes.base_id, &deleted, &files);
        let manifest = SnapshotManifest {
            schema: "rio-snapshot-v1".into(),
            base: changes.base_id.clone(),
            deleted,
            files: files
                .iter()
                .map(|(path, entry)| SnapshotFile {
                    path: path.clone(),
                    mode: entry.mode,
                    size: entry.content.len() as u64,
                    hash: blake3::hash(&entry.content).to_hex().to_string(),
                })
                .collect(),
        };
        Self {
            key,
            manifest,
            files,
        }
    }

    pub fn write(&self, cache: &Path) -> Result<PathBuf> {
        self.write_with_timeout(cache, std::time::Duration::from_secs(30))
    }

    pub fn write_with_timeout(
        &self,
        cache: &Path,
        timeout: std::time::Duration,
    ) -> Result<PathBuf> {
        let directory = cache.join("snapshots");
        fs::create_dir_all(&directory)?;
        let destination = directory.join(format!("{}.tar.zst", self.key));
        let lock = private_file(&directory.join(format!("{}.lock", self.key)), false)?;
        let started = std::time::Instant::now();
        while !FileExt::try_lock_exclusive(&lock)? {
            ensure!(
                started.elapsed() < timeout,
                "timeout waiting for snapshot cache entry"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        if destination.exists() {
            return Ok(destination);
        }
        let mut temporary = tempfile::Builder::new()
            .prefix(&format!("{}.tmp-", self.key))
            .tempfile_in(&directory)?;
        let encoder = zstd::Encoder::new(temporary.as_file_mut(), 3)?;
        let mut archive = tar::Builder::new(encoder);
        append(
            &mut archive,
            "manifest.json",
            &serde_json::to_vec(&self.manifest)?,
            0o600,
        )?;
        for (path, entry) in &self.files {
            validate_tree_path(path)?;
            // The manifest carries Git's mode; archive members are data only.
            append(
                &mut archive,
                &format!("files/{path}"),
                &entry.content,
                0o600,
            )?;
        }
        archive.into_inner()?.finish()?.flush()?;
        temporary.as_file().sync_all()?;
        temporary
            .persist_noclobber(&destination)
            .map_err(|e| e.error)?;
        sync_directory(&directory)?;
        Ok(destination)
    }

    pub fn read(path: &Path) -> Result<Self> {
        let decoder = zstd::Decoder::new(File::open(path)?)?;
        let mut archive = tar::Archive::new(decoder);
        let mut entries = archive.entries()?;
        let mut first = entries.next().context("snapshot has no manifest")??;
        ensure!(
            first.path_bytes().as_ref() == b"manifest.json"
                && first.header().entry_type().is_file(),
            "snapshot manifest must be the first regular member"
        );
        let manifest: SnapshotManifest = serde_json::from_reader(&mut first)?;
        drop(first);
        ensure!(
            manifest.schema == "rio-snapshot-v1",
            "unsupported snapshot schema"
        );
        let mut seen = BTreeSet::new();
        for file in &manifest.files {
            validate_tree_path(&file.path)?;
            ensure!(
                seen.insert(file.path.clone()),
                "duplicate snapshot path {}",
                file.path
            );
            ensure!(
                matches!(file.mode, 0o100644 | 0o100755 | 0o120000 | 0o160000),
                "unsupported snapshot file mode"
            );
        }
        for path in &manifest.deleted {
            validate_tree_path(path)?;
            ensure!(
                seen.insert(path.clone()),
                "duplicate or overlapping snapshot deletion {path}"
            );
        }
        let mut files = Tree::new();
        for entry in entries {
            let mut entry = entry?;
            ensure!(
                entry.header().entry_type().is_file(),
                "snapshot archive contains a non-regular member"
            );
            let raw = entry.path_bytes();
            let name = std::str::from_utf8(&raw)?
                .strip_prefix("files/")
                .context("unexpected snapshot archive member")?
                .to_owned();
            validate_tree_path(&name)?;
            let expected = manifest
                .files
                .iter()
                .find(|f| f.path == name)
                .context("snapshot contains an undeclared file")?;
            ensure!(
                !files.contains_key(&name),
                "duplicate snapshot archive member"
            );
            ensure!(
                entry.size() == expected.size,
                "snapshot size mismatch for {name}"
            );
            let mut content = Vec::new();
            entry.read_to_end(&mut content)?;
            ensure!(
                blake3::hash(&content).to_hex().as_str() == expected.hash,
                "snapshot content hash mismatch for {name}"
            );
            files.insert(
                name,
                TreeEntry {
                    mode: expected.mode,
                    object_id: format!("blake3:{}", expected.hash),
                    content,
                },
            );
        }
        ensure!(
            files.len() == manifest.files.len(),
            "snapshot is missing declared files"
        );
        let key = key_for(&manifest.base, &manifest.deleted, &files);
        Ok(Self {
            key,
            manifest,
            files,
        })
    }

    pub fn apply(&self, destination: &Path) -> Result<Vec<String>> {
        self.apply_until(destination, &|| false)
    }

    pub fn apply_until(&self, destination: &Path, stop: &dyn Fn() -> bool) -> Result<Vec<String>> {
        let mut writer = SafeTreeWriter::new(destination)?;
        // Validate the complete operation before modifying any path.
        for path in &self.manifest.deleted {
            validate_tree_path(path)?;
        }
        validate_case_collisions(
            self.files.keys().map(String::as_str),
            writer.case_insensitive()?,
        )?;
        writer.precheck_space(self.files.values().map(|f| f.content.len() as u64).sum())?;
        // Deletions precede writes, including the old half of a case-only rename.
        for path in &self.manifest.deleted {
            ensure!(!stop(), "timeout: snapshot application stopped");
            writer.remove(path)?;
        }
        for (path, entry) in &self.files {
            ensure!(!stop(), "timeout: snapshot application stopped");
            writer.write(path, entry)?;
        }
        Ok(writer.notes)
    }
}

fn append<W: Write>(
    archive: &mut tar::Builder<W>,
    path: &str,
    content: &[u8],
    mode: u32,
) -> Result<()> {
    let mut header = tar::Header::new_gnu();
    header.set_size(content.len() as u64);
    header.set_mode(mode);
    header.set_mtime(0);
    header.set_uid(0);
    header.set_gid(0);
    header.set_cksum();
    archive.append_data(&mut header, path, content)?;
    Ok(())
}

pub fn private_file(path: &Path, truncate: bool) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options
        .create(true)
        .read(true)
        .write(true)
        .truncate(truncate);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

pub fn sync_directory(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    File::open(path)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// Read only after checking that the archive's canonical input key is the one requested.
pub fn read_snapshot(path: &Path, expected_key: &str) -> Result<Snapshot> {
    let snapshot = Snapshot::read(path)?;
    if snapshot.key != expected_key {
        bail!("snapshot key mismatch");
    }
    Ok(snapshot)
}

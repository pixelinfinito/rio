//! Apply host-validated proposals without following repository symlinks.
use std::{
    io::{Read, Write},
    path::Path,
};

use anyhow::{Context, Result, ensure};
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};

use crate::{AuthoredJourneys, QaSnapshot};

fn read(dir: &Dir, name: &str) -> Result<Option<Vec<u8>>> {
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let mut file = match dir.open_with(name, &options) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file() && metadata.len() <= 1024 * 1024,
        "{name}: expected a bounded regular journey file"
    );
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= 1024 * 1024,
        "{name}: journey file grew during authoring"
    );
    Ok(Some(bytes))
}

/// Check every destination against the input snapshot before applying the batch.
/// New files use a no-clobber link; replacements require --force at preparation
/// time and a second unchanged-file check immediately before atomic rename.
pub fn apply_authored_journeys(
    root: &Path,
    snapshot: &QaSnapshot,
    authored: &AuthoredJourneys,
) -> Result<Vec<String>> {
    let mut dir = Dir::open_ambient_dir(root, ambient_authority())?;
    for component in [".rio", "qa", "journeys"] {
        match dir.create_dir(component) {
            Ok(()) => (),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(error) => return Err(error.into()),
        }
        dir = dir.open_dir_nofollow(component)?;
    }
    let mut entries = Vec::new();
    for (path, bytes) in &authored.files {
        let name = path
            .strip_prefix(".rio/qa/journeys/")
            .context("invalid journey destination")?;
        ensure!(
            !name.is_empty() && !name.contains(['/', '\\']) && name.ends_with(".yaml"),
            "invalid journey destination"
        );
        let current = read(&dir, name)?;
        ensure!(
            current.as_ref() == snapshot.get(path),
            "{path} changed during authoring; no proposals were applied"
        );
        entries.push((path, name, bytes, current));
    }
    let mut applied = Vec::new();
    for (path, name, bytes, expected) in entries {
        if expected.as_ref() == Some(bytes) {
            continue;
        }
        let temporary = format!(
            ".rio-author-{}-{}",
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
                read(&dir, name)? == expected,
                "{path} changed during authoring; stopped applying proposals"
            );
            if expected.is_some() {
                dir.rename(&temporary, &dir, name)?;
            } else {
                dir.hard_link(&temporary, &dir, name)?;
            }
            Ok(())
        })();
        let _ = dir.remove_file(&temporary);
        result?;
        applied.push(path.clone());
    }
    Ok(applied)
}

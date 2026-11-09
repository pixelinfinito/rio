//! Export opaque datastore archives; never unpack repository-controlled files on the host.
use crate::{SeedFingerprint, SeedSnapshotManifest};
use anyhow::{Context, Result, ensure};
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};
use fs4::fs_std::FileExt;
use std::{
    io::{Read, Write},
    path::Path,
};

fn directory(path: &Path) -> Result<Dir> {
    let absolute = std::path::absolute(path)?;
    let root = absolute
        .ancestors()
        .last()
        .context("Invalid seed export path")?;
    let mut dir = Dir::open_ambient_dir(root, ambient_authority())?;
    for component in absolute.strip_prefix(root)?.components() {
        dir = dir.open_dir_nofollow(component.as_os_str())?;
    }
    Ok(dir)
}
fn read(dir: &Dir, name: &str, maximum: u64) -> Result<Vec<u8>> {
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let mut file = dir.open_with(name, &options)?;
    let info = file.metadata()?;
    ensure!(
        info.is_file() && info.len() <= maximum,
        "Invalid seed cache object"
    );
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(maximum + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= maximum,
        "Seed cache object exceeds limit"
    );
    Ok(bytes)
}

pub fn export_seed_cache(
    cache: &Path,
    fingerprint: &SeedFingerprint,
    max_size: u64,
    destination: &Path,
) -> Result<Vec<String>> {
    ensure!(
        fingerprint.fingerprint.len() == 64
            && fingerprint
                .fingerprint
                .bytes()
                .all(|b| b.is_ascii_hexdigit()),
        "Invalid seed fingerprint"
    );
    let cache = directory(cache).context("No local seed cache; run rio qa seed build")?;
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(true)
        .create(true)
        .follow(FollowSymlinks::No);
    let lock = cache.open_with(".lock", &options)?.into_std();
    ensure!(lock.metadata()?.is_file(), "Invalid seed cache lock");
    FileExt::lock_exclusive(&lock)?;
    let snapshot = cache
        .open_dir_nofollow(&fingerprint.fingerprint)
        .context("No matching snapshot; run rio qa seed build")?;
    let bytes = read(&snapshot, "manifest.json", 16 * 1024 * 1024)?;
    let manifest: SeedSnapshotManifest = serde_json::from_slice(&bytes)?;
    ensure!(
        manifest.valid(max_size) && manifest.fingerprint == *fingerprint,
        "Invalid seed snapshot manifest"
    );
    let objects = if manifest.archives.is_empty() {
        None
    } else {
        Some(cache.open_dir_nofollow("objects")?)
    };
    // Verify into a private staging directory before creating the destination.
    let staging = tempfile::tempdir()?;
    let mut names = Vec::new();
    for archive in &manifest.archives {
        let name = format!("{}.archive", archive.name);
        let mut output = std::fs::File::create(staging.path().join(&name))?;
        let mut full = blake3::Hasher::new();
        for part in &archive.parts {
            let bytes = read(objects.as_ref().unwrap(), &part.hash, 8 * 1024 * 1024)?;
            ensure!(
                bytes.len() as u64 == part.bytes
                    && blake3::hash(&bytes).to_hex().as_str() == part.hash,
                "Seed part hash mismatch"
            );
            full.update(&bytes);
            output.write_all(&bytes)?;
        }
        ensure!(
            full.finalize().to_hex().as_str() == archive.hash,
            "Seed archive hash mismatch"
        );
        output.sync_all()?;
        names.push(name);
    }
    std::fs::write(staging.path().join("manifest.json"), bytes)?;
    names.push("manifest.json".into());
    let destination = std::path::absolute(destination)?;
    let parent = directory(destination.parent().context("Invalid export destination")?)?;
    let name = destination
        .file_name()
        .context("Invalid export destination")?;
    // Exclusive mkdir preserves any existing destination, including symlinks.
    parent
        .create_dir(name)
        .context("Seed export destination must not exist")?;
    let target = parent.open_dir_nofollow(name)?;
    for name in &names {
        let mut options = OpenOptions::new();
        options
            .write(true)
            .create_new(true)
            .follow(FollowSymlinks::No);
        #[cfg(unix)]
        {
            use cap_std::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut output = target.open_with(name, &options)?;
        std::io::copy(
            &mut std::fs::File::open(staging.path().join(name))?,
            &mut output,
        )?;
        output.sync_all()?;
    }
    Ok(names)
}

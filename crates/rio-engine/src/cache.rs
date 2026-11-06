use anyhow::{Context, Result, ensure};
use fs4::fs_std::FileExt;
use rio_git::{private_directory, private_file, sync_directory};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs::{self, File},
    io::Write,
    path::{Component, Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant, SystemTime},
};
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheOptions {
    pub dir: PathBuf,
    pub max_age: Duration,
    pub max_size: u64,
    pub retain_raw_output: bool,
}
impl CacheOptions {
    pub fn for_repository(root: &Path) -> Self {
        Self {
            dir: root.join(".rio/cache"),
            max_age: Duration::from_secs(30 * 86400),
            max_size: 5 * 1024 * 1024 * 1024,
            retain_raw_output: true,
        }
    }
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().context("cache path has no parent")?;
    private_directory(parent)?;
    let mut temporary = tempfile::Builder::new()
        .prefix(&format!(
            "{}.tmp-",
            path.file_name().unwrap().to_string_lossy()
        ))
        .tempfile_in(parent)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    temporary.write_all(bytes)?;
    temporary.as_file().sync_all()?;
    temporary.persist(path).map_err(|error| error.error)?;
    sync_directory(parent)?;
    Ok(())
}

/// Directory of versioned local lineage copies, pruned by age and size with the
/// rest of the review cache.
pub const LINEAGES: &str = "lineages";

/// Writes a cache file that belongs to no run (for example `lineages/<key>.json`)
/// under the shared prune lock, so pruning cannot remove it mid-write.
pub fn write_cache_file(options: &CacheOptions, relative: &str, bytes: &[u8]) -> Result<()> {
    ensure!(
        !relative.is_empty()
            && Path::new(relative)
                .components()
                .all(|part| matches!(part, Component::Normal(_))),
        "unsafe cache path"
    );
    private_directory(&options.dir)?;
    let prune = private_file(&options.dir.join("prune.lock"), false)?;
    FileExt::lock_shared(&prune)?;
    if !options.dir.join(".gitignore").exists() {
        atomic_write(&options.dir.join(".gitignore"), b"*\n")?;
    }
    atomic_write(&options.dir.join(relative), bytes)
}

pub struct RunCache {
    pub options: CacheOptions,
    pub review_id: String,
    pub run_id: String,
    pub path: PathBuf,
    _live: File,
    refs: Mutex<BTreeSet<String>>,
}
impl RunCache {
    pub fn begin(options: CacheOptions, review_id: String) -> Result<Self> {
        ensure!(
            review_id.len() == 16 && review_id.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "invalid review id"
        );
        private_directory(&options.dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&options.dir, fs::Permissions::from_mode(0o700))?;
        }
        let prune = private_file(&options.dir.join("prune.lock"), false)?;
        FileExt::lock_shared(&prune)?;
        atomic_write(&options.dir.join(".gitignore"), b"*\n")?;
        let run_id = ulid::Ulid::new().to_string();
        private_directory(&options.dir.join("active"))?;
        let live = private_file(
            &options.dir.join("active").join(format!("{run_id}.lock")),
            false,
        )?;
        FileExt::lock_exclusive(&live)?;
        atomic_write(
            &options.dir.join("active").join(format!("{run_id}.refs")),
            b"[]",
        )?;
        let path = options.dir.join(&review_id).join("runs").join(&run_id);
        private_directory(&path)?;
        drop(prune);
        Ok(Self {
            options,
            review_id,
            run_id,
            path,
            _live: live,
            refs: Mutex::new(BTreeSet::new()),
        })
    }
    pub fn reference(&self, relative: &str) -> Result<()> {
        ensure!(
            !relative.is_empty()
                && Path::new(relative)
                    .components()
                    .all(|part| matches!(part, Component::Normal(_))),
            "unsafe cache reference"
        );
        let prune = private_file(&self.options.dir.join("prune.lock"), false)?;
        FileExt::lock_shared(&prune)?;
        let mut refs = self.refs.lock().unwrap();
        refs.insert(relative.into());
        let bytes = serde_json::to_vec(&*refs)?;
        atomic_write(
            &self
                .options
                .dir
                .join("active")
                .join(format!("{}.refs", self.run_id)),
            &bytes,
        )?;
        atomic_write(&self.path.join("shared.refs.json"), &bytes)?;
        let used = self.options.dir.join(format!("{relative}.used"));
        atomic_write(
            &used,
            &SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)?
                .as_secs()
                .to_string()
                .into_bytes(),
        )?;
        Ok(())
    }
    pub fn unreference(&self, relative: &str) -> Result<()> {
        let prune = private_file(&self.options.dir.join("prune.lock"), false)?;
        FileExt::lock_shared(&prune)?;
        let mut refs = self.refs.lock().unwrap();
        refs.remove(relative);
        let bytes = serde_json::to_vec(&*refs)?;
        atomic_write(
            &self
                .options
                .dir
                .join("active")
                .join(format!("{}.refs", self.run_id)),
            &bytes,
        )?;
        atomic_write(&self.path.join("shared.refs.json"), &bytes)
    }

    pub fn write(&self, relative: &str, bytes: &[u8]) -> Result<()> {
        ensure!(
            Path::new(relative)
                .components()
                .all(|part| matches!(part, Component::Normal(_))),
            "unsafe run path"
        );
        let prune = private_file(&self.options.dir.join("prune.lock"), false)?;
        FileExt::lock_shared(&prune)?;
        atomic_write(&self.path.join(relative), bytes)
    }
    pub fn finish(&self, report: &rio_core::Report) -> Result<()> {
        self.write("report.json", &serde_json::to_vec(report)?)?;
        let prune = private_file(&self.options.dir.join("prune.lock"), false)?;
        FileExt::lock_shared(&prune)?;
        atomic_write(
            &self.options.dir.join(&self.review_id).join("latest"),
            self.run_id.as_bytes(),
        )
    }
    pub async fn entry_lock(
        &self,
        relative: &str,
        timeout: Duration,
        cancellation: &CancellationToken,
    ) -> Result<File> {
        self.reference(relative)?;
        let path = self.options.dir.join(format!("{relative}.lock"));
        private_directory(path.parent().unwrap())?;
        let lock = private_file(&path, false)?;
        let start = Instant::now();
        while !FileExt::try_lock_exclusive(&lock)? {
            ensure!(
                start.elapsed() < timeout,
                "timeout waiting for cache entry {relative}"
            );
            tokio::select! {_=cancellation.cancelled()=>anyhow::bail!("interrupted"),_=tokio::time::sleep(Duration::from_millis(10))=>{}}
        }
        Ok(lock)
    }
}
impl Drop for RunCache {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self._live);
        let _ = fs::remove_file(
            self.options
                .dir
                .join("active")
                .join(format!("{}.lock", self.run_id)),
        );
        let _ = fs::remove_file(
            self.options
                .dir
                .join("active")
                .join(format!("{}.refs", self.run_id)),
        );
    }
}

fn list(directory: &Path) -> Vec<PathBuf> {
    fs::read_dir(directory)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .collect()
}
fn size(path: &Path, deadline: Instant) -> u64 {
    if Instant::now() >= deadline {
        return 0;
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => {
            list(path).iter().map(|path| size(path, deadline)).sum()
        }
        Ok(metadata) => metadata.len(),
        Err(_) => 0,
    }
}
fn used(path: &Path) -> SystemTime {
    fs::metadata(format!("{}.used", path.display()))
        .and_then(|metadata| metadata.modified())
        .or_else(|_| fs::metadata(path).and_then(|metadata| metadata.modified()))
        .unwrap_or(SystemTime::UNIX_EPOCH)
}
fn remove(path: &Path) {
    if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir()) {
        let _ = fs::remove_dir_all(path);
    } else {
        let _ = fs::remove_file(path);
    }
    let _ = fs::remove_file(format!("{}.used", path.display()));
}
fn repair_latest(review: &Path) -> Result<()> {
    let latest = review.join("latest");
    let current = fs::read_to_string(&latest).ok();
    if current.as_ref().is_some_and(|id| {
        !id.is_empty()
            && Path::new(id)
                .components()
                .all(|part| matches!(part, Component::Normal(_)))
            && review.join("runs").join(id).join("report.json").is_file()
    }) {
        return Ok(());
    }
    let newest = list(&review.join("runs"))
        .into_iter()
        .filter(|run| run.join("report.json").is_file())
        .max_by_key(|run| used(&run.join("report.json")));
    if let Some(run) = newest {
        atomic_write(&latest, run.file_name().unwrap().as_encoded_bytes())?;
    } else if latest.exists() {
        fs::remove_file(latest)?;
    }
    Ok(())
}

fn referenced(path: &Path, cache: &Path, refs: &BTreeSet<String>) -> bool {
    path.strip_prefix(cache).ok().is_some_and(|relative| {
        refs.iter().any(|reference| {
            let reference = Path::new(reference);
            relative.starts_with(reference) || reference.starts_with(relative)
        })
    })
}

/// `reachable_bases = None` preserves baselines when reachability could not be
/// established. Deletion is bounded and never follows source/dependency links.
pub fn prune_cache(
    options: &CacheOptions,
    reachable_bases: Option<&BTreeSet<String>>,
) -> Result<()> {
    if !options.dir.exists() {
        return Ok(());
    }
    let prune = private_file(&options.dir.join("prune.lock"), false)?;
    if !FileExt::try_lock_exclusive(&prune)? {
        return Ok(());
    }
    let start = Instant::now();
    let now = SystemTime::now();
    let mut live_refs = BTreeSet::new();
    let mut live_ids = BTreeSet::new();
    for marker in list(&options.dir.join("active"))
        .into_iter()
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "lock")
        })
    {
        let id = marker.file_stem().unwrap().to_string_lossy().into_owned();
        let lock = private_file(&marker, false)?;
        if !FileExt::try_lock_exclusive(&lock)? {
            live_ids.insert(id);
            if let Ok(bytes) = fs::read(marker.with_extension("refs"))
                && let Ok(refs) = serde_json::from_slice::<BTreeSet<String>>(&bytes)
            {
                live_refs.extend(refs);
            }
        } else {
            drop(lock);
            remove(&marker);
            remove(&marker.with_extension("refs"));
        }
    }
    let mut persistent_refs = BTreeSet::new();
    let mut entries = Vec::new();
    for review in list(&options.dir).into_iter().filter(|path| {
        path.file_name().is_some_and(|name| {
            name.len() == 16
                && name
                    .to_string_lossy()
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
        })
    }) {
        for run in list(&review.join("runs")) {
            let live = run
                .file_name()
                .is_some_and(|name| live_ids.contains(name.to_string_lossy().as_ref()));
            if !live && now.duration_since(used(&run)).unwrap_or_default() > options.max_age {
                remove(&run);
                continue;
            }
            if let Ok(bytes) = fs::read(run.join("shared.refs.json"))
                && let Ok(refs) = serde_json::from_slice::<BTreeSet<String>>(&bytes)
            {
                persistent_refs.extend(refs);
            }
            entries.push(run);
        }
        if list(&review.join("runs")).is_empty() {
            remove(&review);
        } else {
            repair_latest(&review)?;
        }
        if start.elapsed() > Duration::from_secs(1) {
            return Ok(());
        }
    }
    fn recover(directory: &Path, live: &BTreeSet<String>, start: Instant) {
        for path in list(directory) {
            if start.elapsed() > Duration::from_secs(1) {
                return;
            }
            let name = path.file_name().unwrap().to_string_lossy();
            if live.contains(name.as_ref()) {
                continue;
            }
            if let Some((entry, _)) = name.split_once(".tmp-") {
                if live.iter().any(|id| name.ends_with(id)) {
                    continue;
                }
                let lock_path = path.parent().unwrap().join(format!("{entry}.lock"));
                let lock = File::open(lock_path).ok();
                if lock
                    .as_ref()
                    .is_some_and(|lock| !FileExt::try_lock_exclusive(lock).unwrap_or(false))
                {
                    continue;
                }
                remove(&path);
            } else if fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.is_dir())
                && name != "tree"
            {
                recover(&path, live, start);
            }
        }
    }
    recover(&options.dir, &live_ids, start);
    // Local lineage copies are caches of endpoint state: expire them by age and
    // let them compete for space with every other entry.
    for entry in list(&options.dir.join(LINEAGES)) {
        if start.elapsed() > Duration::from_secs(1) {
            return Ok(());
        }
        let filename = entry.file_name().unwrap().to_string_lossy();
        if filename.ends_with(".lock") || filename.ends_with(".used") || filename.contains(".tmp-")
        {
            continue;
        }
        if now.duration_since(used(&entry)).unwrap_or_default() > options.max_age {
            remove(&entry);
        } else {
            entries.push(entry);
        }
    }
    for namespace in ["snapshots", "heads", "osv", "baselines"] {
        for entry in list(&options.dir.join(namespace)) {
            if start.elapsed() > Duration::from_secs(1) {
                return Ok(());
            }
            let filename = entry.file_name().unwrap().to_string_lossy();
            if filename.ends_with(".lock")
                || filename.ends_with(".used")
                || filename.contains(".tmp-")
            {
                continue;
            }
            let retained = referenced(&entry, &options.dir, &live_refs);
            let unreachable = namespace == "baselines"
                && reachable_bases.is_some_and(|bases| !bases.contains(filename.as_ref()));
            let unreferenced =
                namespace != "baselines" && !referenced(&entry, &options.dir, &persistent_refs);
            if !retained && (unreachable || unreferenced) {
                remove(&entry);
            } else {
                entries.push(entry);
            }
        }
    }
    let mut total = size(&options.dir, start + Duration::from_secs(1));
    entries.sort_by_key(|entry| used(entry));
    for entry in entries {
        if total <= options.max_size || start.elapsed() > Duration::from_secs(1) {
            break;
        }
        if referenced(&entry, &options.dir, &live_refs)
            || entry
                .file_name()
                .is_some_and(|name| live_ids.contains(name.to_string_lossy().as_ref()))
        {
            continue;
        }
        let bytes = size(&entry, start + Duration::from_secs(1));
        remove(&entry);
        total = total.saturating_sub(bytes);
        if entry
            .parent()
            .is_some_and(|parent| parent.file_name().is_some_and(|name| name == "runs"))
        {
            repair_latest(entry.parent().unwrap().parent().unwrap())?;
        }
    }
    Ok(())
}

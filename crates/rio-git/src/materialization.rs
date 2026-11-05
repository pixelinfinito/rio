use std::{
    collections::BTreeMap,
    fs, io,
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail, ensure};
use fs4::fs_std::FileExt;
use serde::{Deserialize, Serialize};

use crate::{
    ChangeSet, SafeTreeWriter, Snapshot, Tree, TreeEntry, private_file, sync_directory,
    validate_case_collisions, validate_tree_path,
};

/// Shared trees contain repository content only. Never run a tool in this path.
#[derive(Debug, Clone)]
pub struct CachedTree {
    pub path: PathBuf,
    pub reused: bool,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Materializations {
    pub base: CachedTree,
    pub head: CachedTree,
    pub snapshot_key: String,
}

pub struct MaterializationCache {
    root: PathBuf,
    lock_timeout: Duration,
}

impl MaterializationCache {
    pub fn new(root: PathBuf, lock_timeout: Duration) -> Self {
        Self { root, lock_timeout }
    }

    pub fn materialize(&self, changes: &ChangeSet) -> Result<Materializations> {
        self.materialize_until(changes, &|| false)
    }

    pub fn materialize_until(
        &self,
        changes: &ChangeSet,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Materializations> {
        let deadline = Instant::now() + self.lock_timeout;
        let stop = || cancelled() || Instant::now() >= deadline;
        ensure!(!stop(), "timeout: source tree preparation stopped");
        private_directory(&self.root)?;
        let snapshot = Snapshot::from_changes(changes);
        snapshot.write_with_timeout(
            &self.root,
            deadline.saturating_duration_since(Instant::now()),
        )?;
        let base = self.publish("baselines", &changes.base_id, &stop, |destination| {
            let mut writer = SafeTreeWriter::new(destination)?;
            writer.write_tree_until(&changes.base, &stop)?;
            Ok(writer.notes)
        })?;
        let head = self.publish("heads", &snapshot.key, &stop, |destination| {
            // Validate the final tree, including unchanged paths, before any writes.
            let writer = SafeTreeWriter::new(destination)?;
            validate_case_collisions(
                changes.head.keys().map(String::as_str),
                writer.case_insensitive()?,
            )?;
            let mut notes = copy_source_tree(&base.path, destination, &stop)?;
            notes.extend(snapshot.apply_until(destination, &stop)?);
            Ok(notes)
        })?;
        Ok(Materializations {
            base,
            head,
            snapshot_key: snapshot.key,
        })
    }

    fn publish(
        &self,
        namespace: &str,
        key: &str,
        stop: &dyn Fn() -> bool,
        build: impl FnOnce(&Path) -> Result<Vec<String>>,
    ) -> Result<CachedTree> {
        ensure!(
            !key.is_empty() && key.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-'),
            "unsafe cache key"
        );
        let directory = self.root.join(namespace).join(key);
        private_directory(&directory)?;
        let lock = private_file(&directory.join("tree.lock"), false)?;
        let deadline = Instant::now() + self.lock_timeout;
        loop {
            ensure!(!stop(), "timeout: waiting for materialization lock");
            match FileExt::try_lock_exclusive(&lock) {
                Ok(true) => break,
                Ok(false) => {
                    ensure!(
                        Instant::now() < deadline,
                        "timeout: waiting for materialization lock"
                    );
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => return Err(error.into()),
            }
        }
        let destination = directory.join("tree");
        if destination.try_exists()? {
            ensure!(
                fs::symlink_metadata(&destination)?.is_dir(),
                "invalid cached source tree"
            );
            let notes = fs::read(directory.join("tree.notes.json"))
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                .unwrap_or_default();
            return Ok(CachedTree {
                path: destination,
                reused: true,
                notes,
            });
        }
        let temporary = tempfile::Builder::new()
            .prefix("tree.tmp-")
            .tempdir_in(&directory)?;
        let notes = build(temporary.path())?;
        ensure!(!stop(), "timeout: source tree preparation stopped");
        sync_tree(temporary.path(), stop)?;
        let notes_file = private_file(&directory.join("tree.notes.json"), true)?;
        serde_json::to_writer(&notes_file, &notes)?;
        notes_file.sync_all()?;
        fs::rename(temporary.path(), &destination)?;
        sync_directory(&directory)?;
        Ok(CachedTree {
            path: destination,
            reused: false,
            notes,
        })
    }
}

pub fn private_directory(path: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}

fn sync_tree(path: &Path, stop: &dyn Fn() -> bool) -> io::Result<()> {
    for entry in fs::read_dir(path)? {
        if stop() {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "source tree preparation stopped",
            ));
        }
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            sync_tree(&entry.path(), stop)?;
        }
    }
    sync_directory(path)
}

fn read_source_tree(
    root: &Path,
    directory: &Path,
    tree: &mut Tree,
    stop: &dyn Fn() -> bool,
) -> Result<()> {
    for entry in fs::read_dir(directory)? {
        ensure!(!stop(), "timeout: source tree preparation stopped");
        let entry = entry?;
        let path = entry.path();
        let name = path
            .strip_prefix(root)?
            .to_str()
            .context("source path is not UTF-8")?
            .replace('\\', "/");
        validate_tree_path(&name)?;
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.is_dir() {
            if fs::read_dir(&path)?.next().is_none() {
                tree.insert(
                    name,
                    TreeEntry {
                        mode: 0o160000,
                        object_id: String::new(),
                        content: Vec::new(),
                    },
                );
            } else {
                read_source_tree(root, &path, tree, stop)?;
            }
        } else {
            let (mode, content) = if metadata.file_type().is_symlink() {
                let target = fs::read_link(&path)?;
                #[cfg(unix)]
                let bytes = {
                    use std::os::unix::ffi::OsStrExt;
                    target.as_os_str().as_bytes().to_vec()
                };
                #[cfg(not(unix))]
                let bytes = target.to_string_lossy().as_bytes().to_vec();
                (0o120000, bytes)
            } else if metadata.is_file() {
                #[cfg(unix)]
                let executable = {
                    use std::os::unix::fs::PermissionsExt;
                    metadata.permissions().mode() & 0o111 != 0
                };
                #[cfg(not(unix))]
                let executable = false;
                (
                    if executable { 0o100755 } else { 0o100644 },
                    fs::read(&path)?,
                )
            } else {
                bail!("unsupported source tree entry: {name}");
            };
            tree.insert(
                name,
                TreeEntry {
                    mode,
                    object_id: String::new(),
                    content,
                },
            );
        }
    }
    Ok(())
}

/// An independent full copy. Symlinks are copied as links, never traversed;
/// regular files are newly created, so in-place writes cannot affect the cache.
fn copy_source_tree(
    source: &Path,
    destination: &Path,
    stop: &dyn Fn() -> bool,
) -> Result<Vec<String>> {
    let mut tree = Tree::new();
    read_source_tree(source, source, &mut tree, stop)?;
    let mut writer = SafeTreeWriter::new(destination)?;
    writer.write_tree_until(&tree, stop)?;
    Ok(writer.notes)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DependencyLink {
    pub path: String,
    pub target: PathBuf,
}

/// Find ignored installations only at known project/workspace roots. Callers
/// must establish graph and linked-source compatibility before using these links.
pub fn discover_dependency_links(worktree: &Path, roots: &[String]) -> Result<Vec<DependencyLink>> {
    let repository = gix::discover(worktree)?;
    let index = repository.index_or_empty()?;
    let mut excludes = repository.excludes(
        &index,
        None,
        gix::worktree::stack::state::ignore::Source::WorktreeThenIdMappingIfNotSkipped,
    )?;
    let tracked: Vec<_> = index
        .entries()
        .iter()
        .map(|entry| entry.path(&index).to_vec())
        .collect();
    let mut links = BTreeMap::new();
    for root in roots {
        if !root.is_empty() && root != "." {
            validate_tree_path(root)?;
        }
        for name in ["node_modules", ".venv", "venv"] {
            let path = if root.is_empty() || root == "." {
                name.to_owned()
            } else {
                format!("{root}/{name}")
            };
            let full = worktree.join(&path);
            if !full.is_dir() {
                continue;
            }
            // Ignore rules do not override tracked content.
            let prefix = format!("{path}/");
            if tracked
                .iter()
                .any(|entry| entry == path.as_bytes() || entry.starts_with(prefix.as_bytes()))
            {
                continue;
            }
            if excludes
                .at_path(&path, Some(gix::index::entry::Mode::DIR))?
                .is_excluded()
            {
                links.insert(
                    path.clone(),
                    DependencyLink {
                        path,
                        target: full.canonicalize()?,
                    },
                );
            }
        }
    }
    Ok(links.into_values().collect())
}

/// Kept alive until the supervisor has confirmed all tool processes exited.
/// Cleanup never follows dependency links into the user's installation.
pub struct ToolTree {
    directory: tempfile::TempDir,
    pub notes: Vec<String>,
}

impl ToolTree {
    pub fn path(&self) -> &Path {
        self.directory.path()
    }

    /// Preserve source and tool output when a surviving process prevents safe cleanup.
    pub fn preserve(self) -> PathBuf {
        self.directory.keep()
    }

    /// `links` must belong to this run and have passed dependency compatibility.
    pub fn create(source: &CachedTree, parent: &Path, links: &[DependencyLink]) -> Result<Self> {
        Self::create_until(source, parent, links, &|| false)
    }

    pub fn create_until(
        source: &CachedTree,
        parent: &Path,
        links: &[DependencyLink],
        stop: &dyn Fn() -> bool,
    ) -> Result<Self> {
        private_directory(parent)?;
        let directory = tempfile::Builder::new()
            .prefix("tool.tmp-")
            .tempdir_in(parent)?;
        let mut notes = copy_source_tree(&source.path, directory.path(), stop)?;
        let writer = SafeTreeWriter::new(directory.path())?;
        for link in links {
            writer.link_dependency(&link.path, &link.target)?;
        }
        notes.extend(source.notes.clone());
        Ok(Self { directory, notes })
    }
}

/// Canonical dependency input hash: effective graph/installation metadata,
/// platform and linked-source content are supplied under stable relative keys.
/// No worktree path or modification time participates in cache identity.
pub fn dependency_state_hash(inputs: &BTreeMap<String, Vec<u8>>) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"rio-dependencies-v1\0");
    for (name, content) in inputs {
        for bytes in [name.as_bytes(), content.as_slice()] {
            hasher.update(&(bytes.len() as u64).to_le_bytes());
            hasher.update(bytes);
        }
    }
    hasher.finalize().to_hex().to_string()
}

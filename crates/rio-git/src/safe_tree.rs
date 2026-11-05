use std::{
    collections::BTreeMap,
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};
use thiserror::Error;

use crate::{Tree, TreeEntry};

#[derive(Debug, Error)]
pub enum TreeError {
    #[error("unsafe_path: {0}")]
    UnsafePath(String),
    #[error("symlink_parent: refusing to traverse {0}")]
    SymlinkParent(String),
    #[error("case_collision: {0:?} and {1:?} map to the same path")]
    CaseCollision(String, String),
    #[error("disk_full: insufficient space for materialization")]
    DiskFull,
    #[error("timeout: source tree preparation interrupted or exceeded its deadline")]
    PreparationStopped,
    #[error(transparent)]
    Io(io::Error),
}

impl From<io::Error> for TreeError {
    fn from(error: io::Error) -> Self {
        if error.kind() == io::ErrorKind::StorageFull {
            Self::DiskFull
        } else {
            Self::Io(error)
        }
    }
}

pub fn validate_tree_path(path: &str) -> Result<(), TreeError> {
    if path.is_empty()
        || path.starts_with('/')
        || path.contains('\\')
        || path.as_bytes().get(1) == Some(&b':')
        || path.contains('\0')
        || path
            .split('/')
            .any(|p| p.is_empty() || matches!(p, "." | "..") || p.eq_ignore_ascii_case(".git"))
    {
        return Err(TreeError::UnsafePath(path.into()));
    }
    if cfg!(windows) {
        for part in path.split('/') {
            let name = part.split('.').next().unwrap().to_ascii_uppercase();
            let reserved = matches!(name.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                || name
                    .strip_prefix("COM")
                    .or_else(|| name.strip_prefix("LPT"))
                    .is_some_and(|n| {
                        matches!(n, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
                    });
            if reserved
                || part.ends_with(['.', ' '])
                || part.contains(['<', '>', ':', '"', '|', '?', '*'])
                || part.chars().any(|c| c.is_control())
            {
                return Err(TreeError::UnsafePath(path.into()));
            }
        }
    }
    Ok(())
}

pub fn validate_case_collisions<'a>(
    paths: impl IntoIterator<Item = &'a str>,
    case_insensitive: bool,
) -> Result<(), TreeError> {
    let mut names = BTreeMap::new();
    for path in paths {
        validate_tree_path(path)?;
        if case_insensitive {
            // Check directory components too: A/x and a/y alias one directory.
            let mut prefix = String::new();
            for component in path.split('/') {
                if !prefix.is_empty() {
                    prefix.push('/');
                }
                prefix.push_str(component);
                let folded = prefix.to_lowercase();
                if let Some(previous) = names.insert(folded, prefix.clone())
                    && previous != prefix
                {
                    return Err(TreeError::CaseCollision(previous, prefix));
                }
            }
        }
    }
    Ok(())
}

pub struct SafeTreeWriter {
    root: Dir,
    root_path: PathBuf,
    pub notes: Vec<String>,
    #[cfg(test)]
    fail_after_bytes: Option<usize>,
}

impl SafeTreeWriter {
    pub fn new(path: &Path) -> Result<Self, TreeError> {
        if fs::symlink_metadata(path)?.file_type().is_symlink() {
            return Err(TreeError::SymlinkParent(path.display().to_string()));
        }
        let root = Dir::open_ambient_dir(
            path.parent()
                .ok_or_else(|| TreeError::UnsafePath(path.display().to_string()))?,
            ambient_authority(),
        )?
        .open_dir_nofollow(
            path.file_name()
                .ok_or_else(|| TreeError::UnsafePath(path.display().to_string()))?,
        )?;
        Ok(Self {
            root,
            root_path: path.to_path_buf(),
            notes: Vec::new(),
            #[cfg(test)]
            fail_after_bytes: None,
        })
    }

    pub fn precheck_space(&self, bytes: u64) -> Result<(), TreeError> {
        let required = bytes.saturating_add(bytes.div_ceil(10));
        if fs4::available_space(&self.root_path)? < required {
            return Err(TreeError::DiskFull);
        }
        Ok(())
    }

    pub fn case_insensitive(&self) -> Result<bool, TreeError> {
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let name = format!(
            ".rio-case-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        );
        let mut options = OpenOptions::new();
        options
            .write(true)
            .create_new(true)
            .follow(FollowSymlinks::No);
        self.root.open_with(&name, &options)?;
        let insensitive = self.root.symlink_metadata(name.to_uppercase()).is_ok();
        self.root.remove_file(&name)?;
        Ok(insensitive)
    }

    fn parent(&self, path: &str, create: bool) -> Result<(Dir, String), TreeError> {
        validate_tree_path(path)?;
        let mut parts = path.split('/').peekable();
        let mut directory = self.root.try_clone()?;
        while let Some(part) = parts.next() {
            if parts.peek().is_none() {
                return Ok((directory, part.into()));
            }
            if create {
                match directory.create_dir(part) {
                    Ok(()) => {}
                    Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(e) => return Err(e.into()),
                }
            }
            directory = directory.open_dir_nofollow(part).map_err(|error| {
                if directory
                    .symlink_metadata(part)
                    .is_ok_and(|m| m.file_type().is_symlink())
                {
                    TreeError::SymlinkParent(path.into())
                } else {
                    error.into()
                }
            })?;
        }
        Err(TreeError::UnsafePath(path.into()))
    }

    pub fn remove(&self, path: &str) -> Result<(), TreeError> {
        let (parent, name) = match self.parent(path, false) {
            Ok(value) => value,
            Err(TreeError::Io(error)) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        match parent.symlink_metadata(&name) {
            Ok(metadata) if metadata.is_dir() => parent.remove_dir_all(name)?,
            Ok(_) => parent.remove_file_or_symlink(name)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        Ok(())
    }

    /// Add a validated installation link only after cloning the pure source.
    /// A tracked entry always wins, and no parent symlink is traversed.
    pub fn link_dependency(&self, path: &str, target: &Path) -> Result<(), TreeError> {
        let (parent, name) = self.parent(path, true)?;
        match parent.symlink_metadata(&name) {
            Ok(_) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        #[cfg(unix)]
        parent.symlink_contents(target, name)?;
        #[cfg(windows)]
        parent.symlink_dir(target, name)?;
        #[cfg(not(any(unix, windows)))]
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "dependency symlinks unavailable",
        )
        .into());
        Ok(())
    }

    pub fn write(&mut self, path: &str, entry: &TreeEntry) -> Result<(), TreeError> {
        let (parent, name) = self.parent(path, true)?;
        // Remove a leaf link rather than following it. Parent handles never follow links.
        match parent.symlink_metadata(&name) {
            Ok(metadata) if metadata.is_dir() => parent.remove_dir_all(&name)?,
            Ok(_) => parent.remove_file_or_symlink(&name)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        if entry.mode == 0o160000 {
            parent.create_dir(name)?;
            return Ok(());
        }
        if entry.mode == 0o120000 {
            #[cfg(unix)]
            let target = {
                use std::os::unix::ffi::OsStrExt;
                Path::new(std::ffi::OsStr::from_bytes(&entry.content)).to_path_buf()
            };
            #[cfg(not(unix))]
            let target = PathBuf::from(String::from_utf8_lossy(&entry.content).as_ref());
            // symlink_contents permits absolute or escaping targets, stored as links;
            // no later operation follows them.
            #[cfg(unix)]
            let linked = parent.symlink_contents(&target, &name);
            #[cfg(windows)]
            let linked = parent.symlink_file(&target, &name);
            #[cfg(not(any(unix, windows)))]
            let linked: io::Result<()> = Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "symlinks unavailable",
            ));
            if linked.is_ok() {
                return Ok(());
            }
            self.notes
                .push(format!("symlink_fallback: {path} stored as a regular file"));
        }
        let mut options = OpenOptions::new();
        options
            .write(true)
            .create_new(true)
            .follow(FollowSymlinks::No);
        #[cfg(unix)]
        {
            use cap_std::fs::OpenOptionsExt;
            options.mode(if entry.mode == 0o100755 { 0o700 } else { 0o600 });
        }
        let mut file = parent.open_with(&name, &options)?;
        let result = (|| -> io::Result<()> {
            #[cfg(test)]
            if let Some(limit) = self.fail_after_bytes {
                file.write_all(&entry.content[..entry.content.len().min(limit)])?;
                return Err(io::Error::from_raw_os_error(28));
            }
            file.write_all(&entry.content)?;
            file.sync_all()
        })();
        drop(file);
        if let Err(error) = result {
            let _ = parent.remove_file_or_symlink(&name);
            return Err(error.into());
        }
        Ok(())
    }

    pub fn write_tree(&mut self, tree: &Tree) -> Result<(), TreeError> {
        self.write_tree_until(tree, &|| false)
    }

    pub fn write_tree_until(
        &mut self,
        tree: &Tree,
        stop: &dyn Fn() -> bool,
    ) -> Result<(), TreeError> {
        validate_case_collisions(tree.keys().map(String::as_str), self.case_insensitive()?)?;
        self.precheck_space(tree.values().map(|entry| entry.content.len() as u64).sum())?;
        for (path, entry) in tree {
            if stop() {
                return Err(TreeError::PreparationStopped);
            }
            self.write(path, entry)?;
        }
        #[cfg(unix)]
        self.root
            .open_with(".", OpenOptions::new().read(true))?
            .sync_all()?;
        Ok(())
    }
}

/// Materialize privately and publish only a fully written directory. Entry
/// locking and cache reuse are handled by the cache layer.
pub fn materialize_tree(destination: &Path, tree: &Tree) -> Result<Vec<String>, TreeError> {
    let parent = destination
        .parent()
        .ok_or_else(|| TreeError::UnsafePath(destination.display().to_string()))?;
    fs::create_dir_all(parent)?;
    let temporary = tempfile::Builder::new()
        .prefix(".rio-tree.tmp-")
        .tempdir_in(parent)?;
    let mut writer = SafeTreeWriter::new(temporary.path())?;
    writer.write_tree(tree)?;
    if destination.try_exists()? {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "materialization already exists",
        )
        .into());
    }
    fs::rename(temporary.path(), destination)?;
    Ok(writer.notes)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn entry(content: &[u8]) -> TreeEntry {
        TreeEntry {
            mode: 0o100644,
            object_id: String::new(),
            content: content.to_vec(),
        }
    }

    #[test]
    fn rejects_escaping_paths_and_case_collisions() {
        for path in [
            "../outside.txt",
            "/absolute",
            "a/../outside",
            ".GIT/config",
            "a/.GiT/config",
            "C:/outside",
            "a\\..\\outside",
        ] {
            assert!(validate_tree_path(path).is_err(), "{path}");
        }
        assert!(matches!(
            validate_case_collisions(["A.ts", "a.ts"], true),
            Err(TreeError::CaseCollision(..))
        ));
        assert!(matches!(
            validate_case_collisions(["A/x.ts", "a/y.ts"], true),
            Err(TreeError::CaseCollision(..))
        ));
        validate_case_collisions(["A.ts", "a.ts"], false).unwrap();
    }

    #[test]
    fn disk_full_removes_the_partial_file() {
        let directory = tempfile::tempdir().unwrap();
        let mut writer = SafeTreeWriter::new(directory.path()).unwrap();
        writer.fail_after_bytes = Some(2);
        assert!(matches!(
            writer.write("a.ts", &entry(b"partial data")),
            Err(TreeError::DiskFull)
        ));
        assert!(!directory.path().join("a.ts").exists());
        assert!(matches!(
            writer.precheck_space(u64::MAX),
            Err(TreeError::DiskFull)
        ));
    }

    #[test]
    fn failed_tree_never_publishes_a_partial_entry() {
        let directory = tempfile::tempdir().unwrap();
        let tree = [
            ("valid.ts".into(), entry(b"valid")),
            ("../outside.txt".into(), entry(b"invalid")),
        ]
        .into_iter()
        .collect();
        assert!(materialize_tree(&directory.path().join("tree"), &tree).is_err());
        assert!(!directory.path().join("tree").exists());
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn never_writes_through_a_symlink_parent_but_recreates_leaf_links() {
        let directory = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), directory.path().join("link")).unwrap();
        let mut writer = SafeTreeWriter::new(directory.path()).unwrap();
        assert!(matches!(
            writer.write("link/outside.txt", &entry(b"no")),
            Err(TreeError::SymlinkParent(_))
        ));
        assert!(!outside.path().join("outside.txt").exists());
        writer
            .write(
                "file-link",
                &TreeEntry {
                    mode: 0o120000,
                    object_id: String::new(),
                    content: b"target.ts".to_vec(),
                },
            )
            .unwrap();
        assert_eq!(
            fs::read_link(directory.path().join("file-link")).unwrap(),
            Path::new("target.ts")
        );
    }
}

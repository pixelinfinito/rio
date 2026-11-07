use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail};
use gix::bstr::ByteSlice;
use serde::{Deserialize, Serialize};

pub type Tree = BTreeMap<String, TreeEntry>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TreeEntry {
    pub mode: u32,
    pub object_id: String,
    pub content: Vec<u8>,
}

impl TreeEntry {
    pub fn same_content(&self, other: &Self) -> bool {
        self.mode == other.mode && self.content == other.content
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IndexEntry {
    pub path: String,
    pub object_id: String,
    pub mode: u32,
    pub stage: u8,
    pub skip_worktree: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RepoStatus {
    pub staged: Vec<String>,
    pub worktree: Vec<String>,
    pub untracked: Vec<String>,
    pub conflicted: Vec<String>,
}

/// Git access stays behind this interface; production never invokes git.
pub trait Repo {
    fn root(&self) -> &Path;
    fn head_id(&self) -> Result<Option<String>>;
    fn resolve_ref(&self, reference: &str) -> Result<String>;
    fn merge_base(&self, one: &str, two: &str) -> Result<Option<String>>;
    fn read_tree(&self, revision: &str) -> Result<Tree>;
    fn read_blob(&self, id: &str) -> Result<Vec<u8>>;
    fn index_entries(&self) -> Result<Vec<IndexEntry>>;
    fn untracked(&self) -> Result<Vec<String>>;
    fn is_shallow(&self) -> Result<bool>;
    fn working_tree(&self) -> Result<Tree>;
    fn status(&self) -> Result<RepoStatus>;
}

pub struct GixRepo {
    repository: gix::Repository,
    root: PathBuf,
}

impl GixRepo {
    pub fn discover(path: impl AsRef<Path>) -> Result<Self> {
        let repository = gix::discover(path.as_ref())
            .context("not_a_repository: a git work tree is required")?;
        let root = repository
            .workdir()
            .context("not_a_repository: a git work tree is required (bare repository)")?
            .canonicalize()?;
        Ok(Self { repository, root })
    }

    fn collect_tree(&self, tree: gix::Tree<'_>, prefix: &str, result: &mut Tree) -> Result<()> {
        for entry in tree.iter() {
            let entry = entry?;
            let name = entry
                .filename()
                .to_str()
                .context("git path is not valid UTF-8")?;
            let path = if prefix.is_empty() {
                name.to_owned()
            } else {
                format!("{prefix}/{name}")
            };
            if entry.mode().is_tree() {
                self.collect_tree(entry.object()?.try_into_tree()?, &path, result)?;
            } else {
                let object_id = entry.object_id().to_string();
                let content = if entry.mode().is_commit() {
                    object_id.as_bytes().to_vec()
                } else {
                    self.read_blob(&object_id)?
                };
                result.insert(
                    path,
                    TreeEntry {
                        mode: u32::from(entry.mode().value()),
                        object_id,
                        content,
                    },
                );
            }
        }
        Ok(())
    }

    /// Returns None if history cannot be established within the pruning budget.
    pub fn reachable_commits(
        &self,
        budget: std::time::Duration,
    ) -> Result<Option<BTreeSet<String>>> {
        let started = std::time::Instant::now();
        let mut tips = Vec::new();
        for reference in self.repository.references()?.all()?.peeled()? {
            let mut reference = reference?;
            tips.push(reference.peel_to_id()?.detach());
            if started.elapsed() >= budget {
                return Ok(None);
            }
        }
        if let Some(head) = self.head_id()? {
            tips.push(gix::ObjectId::from_hex(head.as_bytes())?);
        }
        let mut reachable = BTreeSet::from(["empty".into()]);
        for commit in self.repository.rev_walk(tips).all()? {
            if started.elapsed() >= budget {
                return Ok(None);
            }
            reachable.insert(commit?.id.to_string());
        }
        Ok(Some(reachable))
    }

    pub fn index_tree(&self) -> Result<Tree> {
        index_tree(self)
    }

    /// The checked-out local branch, or `None` on a detached HEAD.
    pub fn branch(&self) -> Result<Option<String>> {
        use gix::bstr::ByteSlice;
        Ok(self.repository.head_name()?.and_then(|name| {
            name.as_bstr()
                .to_str()
                .ok()
                .and_then(|name| name.strip_prefix("refs/heads/"))
                .filter(|name| !name.is_empty())
                .map(str::to_owned)
        }))
    }

    /// The configured URL of a remote, if any.
    pub fn remote_url(&self, remote: &str) -> Option<String> {
        self.repository
            .config_snapshot()
            .string(format!("remote.{remote}.url").as_str())
            .map(|value| value.to_string())
            .filter(|value| !value.trim().is_empty())
    }
}

pub fn index_tree(repo: &impl Repo) -> Result<Tree> {
    let mut tree = Tree::new();
    for entry in repo.index_entries()?.into_iter().filter(|e| e.stage == 0) {
        let content = if entry.mode == 0o160000 {
            entry.object_id.as_bytes().to_vec()
        } else {
            repo.read_blob(&entry.object_id)?
        };
        tree.insert(
            entry.path,
            TreeEntry {
                mode: entry.mode,
                object_id: entry.object_id,
                content,
            },
        );
    }
    Ok(tree)
}

impl Repo for GixRepo {
    fn root(&self) -> &Path {
        &self.root
    }

    fn head_id(&self) -> Result<Option<String>> {
        if self.repository.head()?.is_unborn() {
            return Ok(None);
        }
        Ok(Some(self.repository.head_id()?.to_string()))
    }

    fn resolve_ref(&self, reference: &str) -> Result<String> {
        let object = self
            .repository
            .rev_parse_single(reference)
            .with_context(|| format!("unknown_ref: unknown ref {reference:?}"))?
            .object()?;
        Ok(object
            .peel_to_kind(gix::object::Kind::Commit)?
            .id
            .to_string())
    }

    fn merge_base(&self, one: &str, two: &str) -> Result<Option<String>> {
        let one = gix::ObjectId::from_hex(one.as_bytes())?;
        let two = gix::ObjectId::from_hex(two.as_bytes())?;
        Ok(self
            .repository
            .merge_base(one, two)?
            .map(|id| id.to_string()))
    }

    fn read_tree(&self, revision: &str) -> Result<Tree> {
        if revision == "empty" {
            return Ok(Tree::new());
        }
        let object = self.repository.rev_parse_single(revision)?.object()?;
        let tree = object
            .peel_to_kind(gix::object::Kind::Tree)?
            .try_into_tree()?;
        let mut result = Tree::new();
        self.collect_tree(tree, "", &mut result)?;
        Ok(result)
    }

    fn read_blob(&self, id: &str) -> Result<Vec<u8>> {
        let id = gix::ObjectId::from_hex(id.as_bytes())?;
        Ok(self
            .repository
            .find_object(id)?
            .try_into_blob()?
            .data
            .to_vec())
    }

    fn index_entries(&self) -> Result<Vec<IndexEntry>> {
        let index = self.repository.index_or_empty()?;
        index
            .entries()
            .iter()
            .map(|entry| {
                Ok(IndexEntry {
                    path: entry
                        .path(&index)
                        .to_str()
                        .context("git index path is not valid UTF-8")?
                        .to_owned(),
                    object_id: entry.id.to_string(),
                    mode: entry.mode.bits(),
                    stage: entry.stage_raw() as u8,
                    skip_worktree: entry
                        .flags
                        .contains(gix::index::entry::Flags::SKIP_WORKTREE),
                })
            })
            .collect()
    }

    fn untracked(&self) -> Result<Vec<String>> {
        let index = self.index_entries()?;
        let tracked: BTreeSet<_> = index.iter().map(|e| e.path.as_str()).collect();
        let submodules: Vec<_> = index
            .iter()
            .filter(|e| e.mode == 0o160000)
            .map(|e| self.root.join(&e.path))
            .collect();
        let root = self.root.clone();
        let mut paths = Vec::new();
        let walk = ignore::WalkBuilder::new(&self.root)
            .hidden(false)
            .follow_links(false)
            .filter_entry(move |entry| {
                entry.file_name() != ".git"
                    && entry.path() != root.join(".rio/cache")
                    && !submodules.iter().any(|path| entry.path().starts_with(path))
            })
            .build();
        for entry in walk {
            let entry = entry?;
            if entry
                .file_type()
                .is_some_and(|t| t.is_file() || t.is_symlink())
            {
                let path = entry
                    .path()
                    .strip_prefix(&self.root)?
                    .to_str()
                    .context("work tree path is not valid UTF-8")?
                    .replace('\\', "/");
                if !tracked.contains(path.as_str()) {
                    paths.push(path);
                }
            }
        }
        paths.sort();
        Ok(paths)
    }

    fn is_shallow(&self) -> Result<bool> {
        Ok(self.repository.is_shallow()?)
    }

    fn working_tree(&self) -> Result<Tree> {
        let index = self.index_entries()?;
        let mut tree = self.index_tree()?;
        for entry in index
            .into_iter()
            .filter(|e| e.stage == 0 && !e.skip_worktree)
        {
            let path = self.root.join(&entry.path);
            if entry.mode == 0o160000 {
                if let Ok(submodule) = gix::open(&path)
                    && let Ok(head) = submodule.head_id()
                {
                    tree.insert(
                        entry.path,
                        TreeEntry {
                            mode: entry.mode,
                            object_id: head.to_string(),
                            content: head.to_string().into_bytes(),
                        },
                    );
                }
                continue;
            }
            match read_worktree_entry(&path) {
                Ok(content) => {
                    tree.insert(entry.path, content);
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    tree.remove(&entry.path);
                }
                Err(error) => {
                    return Err(error).with_context(|| format!("reading {}", path.display()));
                }
            }
        }
        for path in self.untracked()? {
            tree.insert(path.clone(), read_worktree_entry(&self.root.join(&path))?);
        }
        Ok(tree)
    }

    fn status(&self) -> Result<RepoStatus> {
        let entries = self.index_entries()?;
        let conflicted = entries
            .iter()
            .filter(|e| e.stage != 0)
            .map(|e| e.path.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let base = self.read_tree(self.head_id()?.as_deref().unwrap_or("empty"))?;
        let index = self.index_tree()?;
        let work = self.working_tree()?;
        Ok(RepoStatus {
            staged: changed_paths(&base, &index),
            worktree: changed_paths(&index, &work),
            untracked: self.untracked()?,
            conflicted,
        })
    }
}

fn read_worktree_entry(path: &Path) -> std::io::Result<TreeEntry> {
    let metadata = fs::symlink_metadata(path)?;
    let (mode, content) = if metadata.file_type().is_symlink() {
        (
            0o120000,
            fs::read_link(path)?.as_os_str().as_encoded_bytes().to_vec(),
        )
    } else {
        if !metadata.is_file() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "tracked file replaced by a directory",
            ));
        }
        #[cfg(unix)]
        let mode = {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o111 != 0 {
                0o100755
            } else {
                0o100644
            }
        };
        #[cfg(not(unix))]
        let mode = 0o100644;
        (mode, fs::read(path)?)
    };
    Ok(TreeEntry {
        mode,
        object_id: format!("blake3:{}", blake3::hash(&content)),
        content,
    })
}

pub fn changed_paths(base: &Tree, head: &Tree) -> Vec<String> {
    base.keys()
        .chain(head.keys())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .filter(|path| match (base.get(*path), head.get(*path)) {
            (Some(base), Some(head)) => !base.same_content(head),
            _ => true,
        })
        .cloned()
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Selection {
    WorkingTree,
    Staged,
    Branch { reference: String },
}

#[derive(Debug, Clone)]
pub struct ChangeSet {
    pub selection: Selection,
    pub base_id: String,
    pub head_id: String,
    pub base: Tree,
    pub head: Tree,
}

pub fn select(repo: &impl Repo, selection: Selection) -> Result<ChangeSet> {
    if !matches!(selection, Selection::Branch { .. }) {
        let conflicted: BTreeSet<_> = repo
            .index_entries()?
            .into_iter()
            .filter(|e| e.stage != 0)
            .map(|e| e.path)
            .collect();
        if !conflicted.is_empty() {
            bail!(
                "conflicted_index: unmerged index entries: {}",
                conflicted.into_iter().collect::<Vec<_>>().join(", ")
            );
        }
    }
    let head_commit = repo.head_id()?;
    let (base_id, head_id, base, head) = match &selection {
        Selection::WorkingTree | Selection::Staged => {
            let base_id = head_commit.unwrap_or_else(|| "empty".into());
            let base = repo.read_tree(&base_id)?;
            let head = if matches!(selection, Selection::Staged) {
                index_tree(repo)?
            } else {
                repo.working_tree()?
            };
            // The snapshot layer replaces this with its immutable content key.
            (base_id, "snapshot:pending".into(), base, head)
        }
        Selection::Branch { reference } => {
            let head_id = head_commit.context("unborn_head: branch review requires a commit")?;
            let reference_id = repo.resolve_ref(reference)?;
            let base_id = match repo.merge_base(&reference_id, &head_id)? {
                Some(id) => id,
                None if repo.is_shallow()? => bail!(
                    "shallow_history: history is truncated; run git fetch --unshallow or git fetch --deepen <n>"
                ),
                None => bail!("no_merge_base: no merge base between {reference} and HEAD"),
            };
            let base = repo.read_tree(&base_id)?;
            let head = repo.read_tree(&head_id)?;
            (base_id, head_id, base, head)
        }
    };
    let mut changes = ChangeSet {
        selection,
        base_id,
        head_id,
        base,
        head,
    };
    if !matches!(changes.selection, Selection::Branch { .. }) {
        changes.head_id = format!("snapshot:{}", crate::Snapshot::from_changes(&changes).key);
    }
    Ok(changes)
}

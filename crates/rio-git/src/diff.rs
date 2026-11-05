use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

use anyhow::Result;
use gix::bstr::ByteSlice;
use gix_attributes::{
    Search, StateRef,
    glob::pattern::Case,
    search::{MetadataCollection, Outcome},
};
use globset::{GlobBuilder, GlobMatcher};
use serde::{Deserialize, Serialize};
use similar::{DiffTag, TextDiff};

use crate::{ChangeSet, Tree, TreeEntry, changed_paths};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Submodule,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct LineRange {
    pub start: u32,
    pub count: u32,
}

impl LineRange {
    pub fn contains(&self, line: u32) -> bool {
        self.count > 0 && line >= self.start && line < self.start + self.count
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hunk {
    pub base: LineRange,
    pub head: LineRange,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileDiff {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub status: FileStatus,
    pub binary: bool,
    pub hunks: Vec<Hunk>,
    pub unchanged_lines: BTreeMap<u32, u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub excluded: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_commit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_commit: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Diff {
    pub files: Vec<FileDiff>,
}

impl Diff {
    pub fn map_line(&self, path: &str, line: u32) -> Option<u32> {
        match self
            .files
            .iter()
            .find(|f| f.old_path.as_deref().unwrap_or(&f.path) == path)
        {
            Some(file) => file.unchanged_lines.get(&line).copied(),
            None => Some(line),
        }
    }

    pub fn changed_line_count(&self) -> u64 {
        self.files
            .iter()
            .flat_map(|f| &f.hunks)
            .map(|h| u64::from(h.base.count.max(h.head.count)))
            .sum()
    }
}

pub struct Exclusions {
    globs: Vec<GlobMatcher>,
    attributes: Search,
    metadata: MetadataCollection,
}

impl Exclusions {
    pub fn new(tree: &Tree, excludes: &[String]) -> Result<Self> {
        let globs = excludes
            .iter()
            .map(|pattern| {
                GlobBuilder::new(pattern)
                    .literal_separator(true)
                    .build()
                    .map(|g| g.compile_matcher())
            })
            .collect::<Result<_, _>>()?;
        let mut attributes = Search::default();
        let mut metadata = MetadataCollection::default();
        let root = Path::new("rio-attribute-root");
        let mut files: Vec<_> = tree
            .iter()
            .filter(|(path, _)| {
                Path::new(path)
                    .file_name()
                    .is_some_and(|n| n == ".gitattributes")
            })
            .collect();
        files.sort_by_key(|(path, _)| (path.matches('/').count(), *path));
        for (path, entry) in files {
            attributes.add_patterns_buffer(
                &entry.content,
                root.join(path),
                Some(root),
                &mut metadata,
                !path.contains('/'),
            )?;
        }
        Ok(Self {
            globs,
            attributes,
            metadata,
        })
    }

    /// Vendored build directories may contain deliberately tracked source.
    /// Actual dependency installations remain excluded even if tracked.
    pub fn reason(&self, path: &str, entry: &TreeEntry, tracked_source: bool) -> Option<String> {
        if entry.mode == 0o160000 {
            return Some("submodule_not_reviewed".into());
        }
        if self.globs.iter().any(|glob| glob.is_match(path)) {
            return Some("profile_exclude".into());
        }
        let components: Vec<_> = path.split('/').collect();
        if components
            .iter()
            .any(|p| matches!(*p, "node_modules" | ".venv" | "venv" | "__pycache__"))
            || (!tracked_source
                && components
                    .iter()
                    .any(|p| matches!(*p, "vendor" | "dist" | "build")))
        {
            return Some("vendored".into());
        }
        let name = Path::new(path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(path);
        if matches!(
            name,
            "package-lock.json"
                | "npm-shrinkwrap.json"
                | "pnpm-lock.yaml"
                | "yarn.lock"
                | "uv.lock"
                | "poetry.lock"
                | "Pipfile.lock"
        ) || (name.starts_with("requirements") && name.ends_with(".txt"))
        {
            return Some("lockfile".into());
        }
        let mut out = Outcome::default();
        out.initialize_with_selection(&self.metadata, ["linguist-generated", "filter"]);
        self.attributes.pattern_matching_relative_path(
            path.as_bytes().as_bstr(),
            Case::Sensitive,
            Some(false),
            &mut out,
        );
        let mut generated = false;
        let mut lfs = entry
            .content
            .starts_with(b"version https://git-lfs.github.com/spec/v1\n")
            || entry
                .content
                .starts_with(b"version https://git-lfs.github.com/spec/v1\r\n");
        for matched in out.iter_selected() {
            match (matched.assignment.name.as_str(), matched.assignment.state) {
                ("linguist-generated", StateRef::Set) => generated = true,
                ("linguist-generated", StateRef::Value(value)) => {
                    generated = value.as_bstr() == "true"
                }
                ("filter", StateRef::Value(value)) if value.as_bstr() == "lfs" => lfs = true,
                _ => {}
            }
        }
        if lfs {
            Some("lfs".into())
        } else if generated {
            Some("generated".into())
        } else {
            None
        }
    }
}

fn is_binary(entry: Option<&TreeEntry>) -> bool {
    entry.is_some_and(|e| e.content.contains(&0) || std::str::from_utf8(&e.content).is_err())
}

fn similarity(base: &TreeEntry, head: &TreeEntry) -> f64 {
    if base.mode != head.mode {
        return 0.0;
    }
    if base.content == head.content {
        return 1.0;
    }
    if is_binary(Some(base)) || is_binary(Some(head)) {
        return 0.0;
    }
    TextDiff::from_lines(
        std::str::from_utf8(&base.content).unwrap(),
        std::str::from_utf8(&head.content).unwrap(),
    )
    .ratio() as f64
}

pub fn diff(changes: &ChangeSet, excludes: &[String]) -> Result<Diff> {
    let head_exclusions = Exclusions::new(&changes.head, excludes)?;
    let base_exclusions = Exclusions::new(&changes.base, excludes)?;
    let paths = changed_paths(&changes.base, &changes.head);
    let added: Vec<_> = paths
        .iter()
        .filter(|p| !changes.base.contains_key(*p))
        .collect();
    let deleted: Vec<_> = paths
        .iter()
        .filter(|p| !changes.head.contains_key(*p))
        .collect();
    let mut candidates = Vec::new();
    for old in &deleted {
        for new in &added {
            let score = if old.to_lowercase() == new.to_lowercase() {
                2.0
            } else {
                similarity(&changes.base[*old], &changes.head[*new])
            };
            if score >= 0.5 {
                candidates.push((score, (*old).clone(), (*new).clone()));
            }
        }
    }
    candidates.sort_by(|a, b| {
        b.0.total_cmp(&a.0)
            .then_with(|| (&a.1, &a.2).cmp(&(&b.1, &b.2)))
    });
    let mut used_old = BTreeSet::new();
    let mut used_new = BTreeSet::new();
    let mut renames = BTreeMap::new();
    for (_, old, new) in candidates {
        if !used_old.contains(&old) && !used_new.contains(&new) {
            used_old.insert(old.clone());
            used_new.insert(new.clone());
            renames.insert(new, old);
        }
    }
    let mut files = Vec::new();
    for path in paths {
        if used_old.contains(&path) {
            continue;
        }
        let old_path = renames.get(&path).cloned();
        let base = changes.base.get(old_path.as_ref().unwrap_or(&path));
        let head = changes.head.get(&path);
        let entry = head.or(base).unwrap();
        let submodule =
            base.is_some_and(|e| e.mode == 0o160000) || head.is_some_and(|e| e.mode == 0o160000);
        let status = if submodule {
            FileStatus::Submodule
        } else if old_path.is_some() {
            FileStatus::Renamed
        } else if base.is_none() {
            FileStatus::Added
        } else if head.is_none() {
            FileStatus::Deleted
        } else {
            FileStatus::Modified
        };
        let binary = is_binary(base) || is_binary(head);
        let mut file = FileDiff {
            path: path.clone(),
            old_path,
            status,
            binary,
            hunks: Vec::new(),
            unchanged_lines: BTreeMap::new(),
            excluded: if head.is_some() {
                head_exclusions.reason(&path, entry, changes.base.contains_key(&path))
            } else {
                base_exclusions.reason(&path, entry, true)
            },
            old_commit: base
                .filter(|e| e.mode == 0o160000)
                .map(|e| e.object_id.clone()),
            new_commit: head
                .filter(|e| e.mode == 0o160000)
                .map(|e| e.object_id.clone()),
        };
        if !binary && !submodule {
            let old = base
                .map(|e| std::str::from_utf8(&e.content).unwrap())
                .unwrap_or("");
            let new = head
                .map(|e| std::str::from_utf8(&e.content).unwrap())
                .unwrap_or("");
            let text_diff = TextDiff::from_lines(old, new);
            for op in text_diff.ops() {
                let old = op.old_range();
                let new = op.new_range();
                if op.tag() == DiffTag::Equal {
                    for (old, new) in old.zip(new) {
                        file.unchanged_lines.insert(old as u32 + 1, new as u32 + 1);
                    }
                } else {
                    file.hunks.push(Hunk {
                        base: LineRange {
                            start: old.start as u32 + u32::from(!old.is_empty()),
                            count: old.len() as u32,
                        },
                        head: LineRange {
                            start: new.start as u32 + u32::from(!new.is_empty()),
                            count: new.len() as u32,
                        },
                    });
                }
            }
        }
        files.push(file);
    }
    Ok(Diff { files })
}

## Purpose

Change resolution turns a selection mode into an immutable pair of code versions, a diff with precise hunk ranges, and a content-addressed snapshot, so every review is reproducible and both versions of any file are available to later steps.

## ADDED Requirements

### Requirement: Base and head resolution
The system SHALL resolve a base and a head for each mode. Working-tree mode: base is the `HEAD` tree, head is the working tree including untracked files not ignored by git. Staged mode: base is the `HEAD` tree, head is the index. Branch mode: base is the merge base of the given ref and `HEAD`, head is the `HEAD` commit. An unknown ref or a pair with no merge base SHALL be an error that stops the review with exit code 3.

#### Scenario: Unknown base ref
- **WHEN** branch mode is requested with a ref that does not exist
- **THEN** the system reports the ref as unknown and exits with code 3

#### Scenario: Repository with no commits
- **WHEN** working-tree mode is run in a repository whose `HEAD` is unborn
- **THEN** the base is treated as an empty tree and every file is reported as added

### Requirement: Diff with hunk ranges
The system SHALL produce, for each changed file, its status (`added`, `modified`, `deleted`, `renamed` with the old path), and for text files the list of hunks with base and head line ranges, so later steps can map any line to "added", "modified", "removed" or "context". Binary files SHALL be listed with status but no hunks. Files under excluded paths (vendored directories, files marked generated, lockfiles) SHALL be listed with an `excluded` reason and SHALL NOT be sent to checks other than the dependency audit.

#### Scenario: Rename with edit
- **WHEN** a file is renamed and one line inside it is changed
- **THEN** the diff lists one entry with status `renamed`, both paths, and a single hunk covering the edited line

#### Scenario: Lockfile excluded from code checks
- **WHEN** `package-lock.json` is modified
- **THEN** it is listed as excluded with reason `lockfile` and is available to the dependency audit only

### Requirement: Content-addressed snapshot
The system SHALL compute a snapshot key as the BLAKE3 hash over a canonical encoding of the base identifier plus one entry per changed path, sorted by path: for a path present in the head, its path, mode and head content; for a path absent from the head (a deleted file, or the old path of a rename), its path and an explicit deletion marker. Identical inputs SHALL yield identical keys regardless of when or where the review runs. The snapshot archive SHALL be written under the review cache as `snapshots/<key>.tar.zst` and SHALL contain the changed files' head content and a manifest naming the base commit and listing every deleted path, so that applying the archive to the base tree reconstructs the head tree exactly. Application SHALL remove deleted paths before writing head content, so a case-only rename reconstructs correctly on a case-insensitive file system.

#### Scenario: Same content, same key
- **WHEN** the same staged change is snapshotted twice on two machines with the same repository state
- **THEN** both produce the same snapshot key

#### Scenario: Whitespace-only edit changes the key
- **WHEN** a single trailing space is added to one changed file
- **THEN** the snapshot key changes

#### Scenario: Deletion-only changes are distinct
- **WHEN** one change deletes `a.ts` and another change on the same base deletes `b.ts`
- **THEN** the two snapshot keys differ, and each archive's manifest lists its deleted path

#### Scenario: Head reconstruction drops deleted files
- **WHEN** a snapshot whose change deletes `a.ts` and renames `b.ts` to `c.ts` is applied to the base tree
- **THEN** the reconstructed head tree contains `c.ts` and contains neither `a.ts` nor `b.ts`

### Requirement: Repository states and git features
The system SHALL handle the following repository states and git features explicitly, never by producing silently wrong results:
- **Conflicted index** (unmerged entries): working-tree and staged modes SHALL stop with exit code 3, naming the conflicted paths. Branch mode reads only commits and is unaffected.
- **Shallow clone**: when branch mode cannot find a merge base and the repository is shallow, the error SHALL say the history is truncated and suggest `git fetch --unshallow` or `git fetch --deepen`, instead of reporting that no merge base exists.
- **Submodules**: a changed gitlink SHALL be listed with status `submodule` and its old and new commits. It SHALL NOT be recursed into or checked, and the footer SHALL note `submodule_not_reviewed`. Materializations SHALL contain an empty directory at submodule paths.
- **Git LFS**: a file with the `filter=lfs` attribute, or whose blob is an LFS pointer, SHALL be listed as excluded with reason `lfs`. Materializations SHALL contain the pointer as stored in git, and the footer SHALL say so.
- **Sparse checkout**: index entries with the skip-worktree bit SHALL be treated as unchanged and never as deleted. Their content SHALL be read from the index or the object store.
- **Symbolic links**: a tracked symlink's snapshot content SHALL be its target string. Materializations SHALL recreate it as a symlink. Where that fails (Windows without symlink rights), the system SHALL write a regular file holding the target, and the footer SHALL note the degradation.
- **Case-only renames and case collisions**: a case-only rename SHALL be reported as `renamed`. When materializing a tree on a case-insensitive file system would map two tracked paths to the same name, that materialization SHALL fail with reason `case_collision`, naming both paths, and the checks that need it SHALL report this reason.

#### Scenario: Staged review during a merge conflict
- **WHEN** `rio review --staged` runs while the index has unmerged entries for `src/a.ts`
- **THEN** the command exits 3 and names `src/a.ts` as conflicted

#### Scenario: Shallow clone without the merge base
- **WHEN** `rio review --base origin/main` runs in a depth-1 clone whose history does not reach the merge base
- **THEN** the command exits 3, says the clone is shallow, and suggests fetching more history

#### Scenario: Submodule pointer change
- **WHEN** a change moves the gitlink `vendor/lib` to a new commit
- **THEN** the diff lists `vendor/lib` with status `submodule` and both commits, no check runs inside it, and the footer notes `submodule_not_reviewed`

#### Scenario: Sparse checkout is not a deletion
- **WHEN** working-tree mode runs in a sparse checkout where `services/billing/` is outside the sparse cone
- **THEN** no file under `services/billing/` is reported as deleted

#### Scenario: Case-only rename on macOS
- **WHEN** a change renames `src/Util.ts` to `src/util.ts` and the head tree is materialized on a case-insensitive APFS volume
- **THEN** the diff reports the rename and the materialized head contains `src/util.ts` and no `src/Util.ts`

### Requirement: Safe materialization
Writing a materialization or extracting a snapshot archive SHALL reject any entry whose path is absolute, contains a `..` component, contains a `.git` component in any letter case, or (on Windows) uses a reserved device name or an invalid character. It SHALL never write through a symbolic link: an entry whose parent path resolves through a symlink SHALL be rejected. Before materializing a tree, the system SHALL check that the free space on the cache's file system exceeds the tree's blob size plus a margin. When it does not, or when a write fails because the disk is full, the materialization SHALL fail with reason `disk_full`, its temporary files SHALL be removed, and no partial entry SHALL be published to the cache.

#### Scenario: Archive entry escaping the tree
- **WHEN** a snapshot archive contains an entry named `../outside.txt`
- **THEN** extraction rejects the archive and writes nothing outside the target directory

#### Scenario: Disk full during materialization
- **WHEN** the file system fills up while the base tree is being written
- **THEN** the base materialization fails with `disk_full`, the partial directory is removed, typecheck and lint findings are `unclassified` with a hint naming the disk, and the review continues

### Requirement: Both versions available
The system SHALL be able to supply the base and head content of any changed file, and a materialization of the whole base tree and of the whole head tree on demand, outside the work tree. The base tree SHALL be cached by base identifier; the head tree SHALL be the base tree with the snapshot applied and SHALL be cached by snapshot key. Every check that executes a tool (type check, lint, tests and coverage) SHALL run against these materializations and never in the user's work tree, so the head that is checked is exactly the selected, immutable head: in staged mode it excludes unstaged edits, and in branch mode it excludes uncommitted changes. Materializations SHALL never modify the user's working tree or index, and tool writes inside a materialization SHALL not alter the cached tree used by later reviews. Tools SHALL run in a copy-on-write clone or an independent copy of a cached tree, never in a hard-linked one. Cached source trees SHALL contain only repository content and SHALL NOT contain links to worktree-specific installed dependencies. Dependency directory symlinks SHALL be added only to each disposable tool tree and SHALL target the current run's worktree installation, after its compatibility has been checked.

#### Scenario: Multiple worktrees share pure cached source trees
- **WHEN** two worktrees with different dependency installation directories share a cache and review the same commit or snapshot
- **THEN** they reuse the same cached source tree, each disposable tool tree links only to its own worktree's installation, and neither run adds dependency links to or otherwise modifies the cached source tree

#### Scenario: Tool writes do not reach the cache
- **WHEN** a tool run rewrites an existing file in its tree in place
- **THEN** the same file in the cached materialization is unchanged afterwards

#### Scenario: Base tree materialized without touching the work tree
- **WHEN** a check requests the full base tree in working-tree mode
- **THEN** a copy of the base tree is provided outside the work tree, and `git status` in the user's repository is unchanged afterwards

#### Scenario: Staged review checks the index, not the work tree
- **WHEN** `rio review --staged` runs while a staged file is type-correct and the same file has an unstaged edit that introduces a type error
- **THEN** the type check runs on the materialized head tree built from the index and reports no error for that file

#### Scenario: Branch review ignores uncommitted changes
- **WHEN** `rio review --base main` runs with an uncommitted edit in the work tree
- **THEN** checks run on the materialized `HEAD` commit tree and no finding refers to the uncommitted edit

### Requirement: Large diffs are flagged, not partitioned
When the total changed line count exceeds the profile's `max_lines`, the system SHALL continue the review and SHALL add a note to the report footer stating the size and recommending a split. Partitioning into logical parts is out of scope for this version.

#### Scenario: Oversized change
- **WHEN** a change touches 2,400 lines and the profile sets `max_lines: 1500`
- **THEN** the review runs and the footer notes that the change exceeds the configured size

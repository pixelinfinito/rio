//! Install authoring assets without following repository symlinks or replacing edits.
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};
use serde::{Deserialize, Serialize};
use std::{
    io::{self, Read, Write},
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
};

pub const AUTHORING_SKILL: &str = include_str!("../../../modules/qa/skill/SKILL.md");
const START: &str = "<!-- rio-qa:start -->";
const END: &str = "<!-- rio-qa:end -->";
const SECTION: &str = "<!-- rio-qa:start -->\nFor QA journey, seed and fixture authoring, follow [.rio/qa/skills/rio-qa/SKILL.md](.rio/qa/skills/rio-qa/SKILL.md).\n<!-- rio-qa:end -->";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillInstall {
    Installed,
    Refreshed,
    Unchanged,
    Proposed,
}
#[derive(Deserialize, Serialize)]
struct Generation {
    version: String,
    hash: String,
}
fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
fn version(text: &str) -> Option<[u64; 3]> {
    let value = text
        .lines()
        .find_map(|line| line.strip_prefix("Skill version: "))?;
    let components: Vec<_> = value
        .trim()
        .split('.')
        .map(str::parse)
        .collect::<Result<_, _>>()
        .ok()?;
    components.try_into().ok()
}
fn directory(parent: &Dir, names: &[&str]) -> io::Result<Dir> {
    let mut dir = parent.try_clone()?;
    for name in names {
        match dir.create_dir(name) {
            Ok(()) => (),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (),
            Err(error) => return Err(error),
        }
        dir = dir.open_dir_nofollow(name)?;
    }
    Ok(dir)
}
fn read(dir: &Dir, name: &str) -> io::Result<Option<String>> {
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let mut file = match dir.open_with(name, &options) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if !file.metadata()?.is_file() || file.metadata()?.len() > 1024 * 1024 {
        return Err(invalid(
            "skill installation expects bounded regular text files",
        ));
    }
    let mut content = String::new();
    file.read_to_string(&mut content)?;
    Ok(Some(content))
}
fn write(dir: &Dir, name: &str, content: &str) -> io::Result<()> {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let temporary = format!(
        ".rio-skill-{}-{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    let mut options = OpenOptions::new();
    options
        .write(true)
        .create_new(true)
        .follow(FollowSymlinks::No);
    let mut file = dir.open_with(&temporary, &options)?;
    let result = (|| {
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        dir.rename(&temporary, dir, name)
    })();
    if result.is_err() {
        let _ = dir.remove_file(&temporary);
    }
    result
}
fn agents_section(content: &str) -> io::Result<String> {
    match (content.matches(START).count(), content.matches(END).count()) {
        (0, 0) => Ok(format!(
            "{content}{}{SECTION}\n",
            if content.is_empty() || content.ends_with('\n') {
                ""
            } else {
                "\n"
            }
        )),
        (1, 1) => {
            let start = content.find(START).unwrap();
            let end = content.find(END).unwrap();
            if end < start {
                return Err(invalid("AGENTS.md has reversed rio-qa markers"));
            }
            Ok(format!(
                "{}{SECTION}{}",
                &content[..start],
                &content[end + END.len()..]
            ))
        }
        _ => Err(invalid(
            "AGENTS.md has incomplete or duplicate rio-qa markers",
        )),
    }
}

pub fn install_authoring_skill(root: &Path) -> io::Result<SkillInstall> {
    install_skill_version(root, AUTHORING_SKILL)
}

/// Also used when installing an explicitly versioned distribution asset.
pub fn install_skill_version(root: &Path, builtin: &str) -> io::Result<SkillInstall> {
    let next_version =
        version(builtin).ok_or_else(|| invalid("built-in skill has no valid version marker"))?;
    let root = Dir::open_ambient_dir(root, ambient_authority())?;
    let agents = read(&root, "AGENTS.md")?.unwrap_or_default();
    let updated_agents = agents_section(&agents)?;
    let target = directory(&root, &[".rio", "qa", "skills", "rio-qa"])?;
    let claude = directory(&root, &[".claude", "skills"])?;
    let current = read(&target, "SKILL.md")?;
    let generation = read(&target, ".generated.json")?
        .and_then(|text| serde_json::from_str::<Generation>(&text).ok());
    let next = match &current {
        None => SkillInstall::Installed,
        Some(text) if text == builtin || version(text).is_some_and(|v| v >= next_version) => {
            SkillInstall::Unchanged
        }
        Some(text)
            if generation
                .as_ref()
                .is_some_and(|g| g.hash == blake3::hash(text.as_bytes()).to_hex().as_str()) =>
        {
            SkillInstall::Refreshed
        }
        Some(_) => SkillInstall::Proposed,
    };
    // Do not replace an unrelated existing harness skill, even with --force on journeys.
    #[cfg(unix)]
    {
        match claude.symlink_metadata("rio-qa") {
            Ok(meta)
                if meta.file_type().is_symlink()
                    && claude.read_link_contents("rio-qa")?
                        == Path::new("../../.rio/qa/skills/rio-qa") => {}
            Ok(_) => {
                return Err(invalid(
                    ".claude/skills/rio-qa already exists and is not the Rio skill link",
                ));
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            Err(error) => return Err(error),
        }
    }
    #[cfg(not(unix))]
    let claude_copy = directory(&claude, &["rio-qa"])?;
    #[cfg(not(unix))]
    if let Some(copy) = read(&claude_copy, "SKILL.md")?
        && current.as_ref() != Some(&copy)
        && copy != builtin
    {
        return Err(invalid(
            ".claude/skills/rio-qa contains an edited skill; preserve or reconcile it first",
        ));
    }
    match next {
        SkillInstall::Installed | SkillInstall::Refreshed => {
            write(&target, "SKILL.md", builtin)?;
            let generation = Generation {
                version: next_version
                    .iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
                    .join("."),
                hash: blake3::hash(builtin.as_bytes()).to_hex().to_string(),
            };
            write(
                &target,
                ".generated.json",
                &serde_json::to_string(&generation)?,
            )?;
        }
        SkillInstall::Proposed => {
            // Never clobber a user-edited proposal from an earlier invocation.
            if read(&target, "SKILL.proposed.md")?.is_some_and(|proposal| proposal != builtin) {
                return Err(invalid(
                    "SKILL.proposed.md already contains another proposal",
                ));
            }
            write(&target, "SKILL.proposed.md", builtin)?;
        }
        SkillInstall::Unchanged => (),
    }
    #[cfg(unix)]
    if claude.symlink_metadata("rio-qa").is_err() {
        claude.symlink_contents("../../.rio/qa/skills/rio-qa", "rio-qa")?;
    }
    #[cfg(not(unix))]
    write(
        &claude_copy,
        "SKILL.md",
        if matches!(next, SkillInstall::Installed | SkillInstall::Refreshed) {
            builtin
        } else {
            current.as_deref().unwrap_or(builtin)
        },
    )?;
    if updated_agents != agents {
        write(&root, "AGENTS.md", &updated_agents)?;
    }
    Ok(next)
}

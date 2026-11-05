//! Private dependency overlays for base runs. Never write through an installation link.
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail, ensure};
use rio_git::{DependencyLink, Tree, changed_paths};

use crate::ToolCommand;

/// Resolution changes owned by one disposable base tree.
#[derive(Debug, Default)]
pub struct BaseDependencyRemap {
    pub packages: usize,
    pub source_paths: BTreeMap<String, Vec<String>>,
    pub unavailable: Vec<String>,
    source_root: PathBuf,
}

impl BaseDependencyRemap {
    /// Source aliases affect TypeScript only. Linters retain their normal
    /// configuration and never execute a source file in place of built JS.
    pub fn configure_typescript(&self, command: &mut ToolCommand) -> Result<()> {
        ensure!(
            self.unavailable.is_empty(),
            "{}",
            self.unavailable.join("; ")
        );
        super::source_entries::configure_typescript(command, &self.source_paths, &self.source_root)
    }
}

/// Overlay installation directories inside an already disposable source tree.
/// The installation's files remain shared, but directory entries and editable
/// metadata belong exclusively to this invocation.
pub fn remap_base_dependencies(
    worktree: &Path,
    destination: &Path,
    links: &[DependencyLink],
    working: &Tree,
    base: &Tree,
    stop: &dyn Fn() -> bool,
) -> Result<BaseDependencyRemap> {
    let worktree = worktree.canonicalize()?;
    // Symlink targets are canonical below; compare installation roots using
    // the same spelling so aliases such as /var -> /private/var still match.
    let links = links
        .iter()
        .map(|link| {
            Ok(DependencyLink {
                path: link.path.clone(),
                target: link.target.canonicalize()?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let changed = changed_paths(working, base);
    let mut overlay = Overlay {
        worktree: &worktree,
        destination,
        links: &links,
        changed: &changed,
        remapped: BTreeSet::new(),
        prepared: BTreeSet::new(),
        mapped_sources: BTreeSet::new(),
        required_editables: BTreeSet::new(),
        base,
        working,
        resolution: BaseDependencyRemap {
            source_root: destination.canonicalize()?,
            ..Default::default()
        },
        stop,
    };
    for link in &links {
        let path = destination.join(&link.path);
        // Tracked dependency directories take precedence, as in ToolTree.
        if !fs::symlink_metadata(&path)?.file_type().is_symlink() {
            continue;
        }
        remove_link(&path)?;
        overlay.directory(&link.target, &path)?;
    }
    for target in &overlay.required_editables {
        ensure!(
            overlay
                .mapped_sources
                .iter()
                .any(|mapped| mapped.starts_with(target) || target.starts_with(mapped)),
            "linked dependency points at changed source {}; editable finder cannot be remapped",
            target.display()
        );
    }
    overlay.resolution.packages = overlay.remapped.len();
    Ok(overlay.resolution)
}

struct Overlay<'a> {
    worktree: &'a Path,
    destination: &'a Path,
    links: &'a [DependencyLink],
    changed: &'a [String],
    remapped: BTreeSet<PathBuf>,
    prepared: BTreeSet<PathBuf>,
    mapped_sources: BTreeSet<PathBuf>,
    required_editables: BTreeSet<PathBuf>,
    base: &'a Tree,
    working: &'a Tree,
    resolution: BaseDependencyRemap,
    stop: &'a dyn Fn() -> bool,
}

impl Overlay<'_> {
    fn target(&mut self, target: &Path) -> Result<PathBuf> {
        if !target.starts_with(self.worktree) {
            return Ok(target.into());
        }
        // Links within the installation (pnpm virtual store, .bin) must resolve
        // through the overlay as well, including nested node_modules entries.
        for link in self.links {
            if let Ok(relative) = target.strip_prefix(&link.target) {
                return Ok(self.destination.join(&link.path).join(relative));
            }
        }
        let Ok(relative) = target.strip_prefix(self.worktree) else {
            return Ok(target.into());
        };
        // editables.map_module can name __init__.py rather than its
        // package directory. Any sibling module change affects that package.
        let scope = if target.is_file() {
            relative.parent().unwrap_or(relative)
        } else {
            relative
        };
        self.mapped_sources.insert(scope.into());
        let prefix = scope.to_string_lossy().replace('\\', "/");
        let prefix = if prefix.is_empty() {
            prefix
        } else {
            format!("{prefix}/")
        };
        if self.changed.iter().any(|path| path.starts_with(&prefix)) {
            ensure!(
                self.destination.join(relative).exists(),
                "linked dependency points at changed source {} that is absent from the base tree; cannot remap",
                relative.display()
            );
            self.remapped.insert(scope.into());
        }
        if target.is_dir() && self.prepared.insert(relative.into()) {
            self.remapped.insert(relative.into());
            super::source_entries::prepare_package(
                self.worktree,
                self.destination,
                relative,
                self.working,
                self.base,
                &mut self.resolution,
                self.stop,
            )?;
        }
        Ok(self.destination.join(relative))
    }

    fn metadata(&mut self, source: &Path, destination: &Path) -> Result<bool> {
        let name = source.file_name().unwrap_or_default().to_string_lossy();
        let editable = name.ends_with(".pth")
            || name.ends_with(".egg-link")
            || ((name.starts_with("__editable__") || name.starts_with("_editable_impl_"))
                && name.ends_with(".py"));
        if name == "direct_url.json" {
            let direct: serde_json::Value = serde_json::from_slice(&fs::read(source)?)?;
            if direct["dir_info"]["editable"].as_bool() == Some(true)
                && let Some(url) = direct["url"]
                    .as_str()
                    .filter(|url| url.starts_with("file:"))
            {
                let target = pep508_rs::VerbatimUrl::parse_url(url)?
                    .to_url()
                    .to_file_path()
                    .map_err(|_| anyhow::anyhow!("invalid editable file URL"))?
                    .canonicalize()?;
                if let Ok(relative) = target.strip_prefix(self.worktree) {
                    let prefix = relative.to_string_lossy().replace('\\', "/");
                    let prefix = if prefix.is_empty() {
                        prefix
                    } else {
                        format!("{prefix}/")
                    };
                    if self.changed.iter().any(|path| path.starts_with(&prefix)) {
                        self.required_editables.insert(relative.into());
                    }
                }
            }
        }
        if !editable && name != "pyvenv.cfg" {
            return Ok(false);
        }
        let text = fs::read_to_string(source)?;
        let mut rewritten = text.clone();
        if name.ends_with(".pth") || name.ends_with(".egg-link") {
            let editable_modules =
                regex::Regex::new(r"\b(?:__editable__|_editable_impl_)[A-Za-z0-9_]*\b")?;
            let mut lines = Vec::new();
            for (line_number, line) in text.lines().enumerate() {
                if name.ends_with(".egg-link") && line_number > 0 {
                    lines.push(line.to_owned());
                    continue;
                }
                let trimmed = line.trim();
                if trimmed.starts_with("import ") || trimmed.starts_with("import\t") {
                    // A compiled or missing finder cannot be rewritten. Do not
                    // let missing direct_url.json turn that into a silent pass.
                    for module in editable_modules.find_iter(trimmed) {
                        ensure!(
                            source
                                .parent()
                                .unwrap()
                                .join(format!("{}.py", module.as_str()))
                                .is_file(),
                            "linked dependency points at changed source; editable finder cannot be remapped: {}",
                            module.as_str()
                        );
                    }
                }
                if trimmed.is_empty()
                    || trimmed.starts_with('#')
                    || trimmed.starts_with("import ")
                    || trimmed.starts_with("import\t")
                {
                    lines.push(line.to_owned());
                } else {
                    let target = source.parent().unwrap().join(trimmed);
                    if target.exists() {
                        lines.push(
                            self.target(&target.canonicalize()?)?
                                .to_string_lossy()
                                .into_owned(),
                        );
                    } else {
                        lines.push(line.to_owned());
                    }
                }
            }
            rewritten = format!("{}\n", lines.join("\n"));
            if name.ends_with(".egg-link")
                && let Some(path) = lines.first()
            {
                fs::write(
                    destination.with_extension("rio-base.pth"),
                    format!("{path}\n"),
                )?;
            }
        } else if editable {
            // Supported PEP 660 finders store absolute paths as ordinary string
            // literals (setuptools MAPPING/NAMESPACES and editables map_module).
            // Rewrite literals only; never execute or interpret finder code.
            let literals = regex::Regex::new(r#"['\"]([^'\"\r\n]+)['\"]"#)?;
            let mut supported = false;
            for capture in literals.captures_iter(&text) {
                let literal = &capture[1];
                let path = Path::new(literal);
                if path.is_absolute() && path.exists() {
                    supported = true;
                    let mapped = self.target(&path.canonicalize()?)?;
                    rewritten =
                        rewritten.replace(&capture[0], &format!("{:?}", mapped.to_string_lossy()));
                }
            }
            ensure!(
                supported || self.changed.is_empty(),
                "linked dependency points at changed source; editable finder cannot be remapped: {}",
                source.display()
            );
            if rewritten
                .replace(self.destination.to_string_lossy().as_ref(), "<base>")
                .contains(self.worktree.to_string_lossy().as_ref())
            {
                bail!(
                    "linked dependency points at changed source; editable finder {} cannot be remapped",
                    source.display()
                );
            }
        }
        fs::write(destination, rewritten)?;
        Ok(true)
    }

    fn directory(&mut self, source: &Path, destination: &Path) -> Result<()> {
        fs::create_dir_all(destination)?;
        for entry in fs::read_dir(source)? {
            ensure!(!(self.stop)(), "timeout: dependency remapping stopped");
            let entry = entry?;
            let from = entry.path();
            let to = destination.join(entry.file_name());
            let kind = entry.file_type()?;
            if kind.is_symlink() && from.is_file() && self.metadata(&from, &to)? {
                continue;
            }
            if kind.is_symlink() {
                let raw = fs::read_link(&from)?;
                let target = match from.canonicalize() {
                    Ok(target) => self.target(&target)?,
                    Err(_) => {
                        if raw.is_absolute() {
                            raw
                        } else {
                            source.join(raw)
                        }
                    }
                };
                symlink(&target, &to)?;
            } else if kind.is_dir() {
                if entry.file_name() == "__pycache__" {
                    continue;
                }
                self.directory(&from, &to)?;
            } else if kind.is_file() && !self.metadata(&from, &to)? {
                symlink(&from, &to)?;
            }
        }
        Ok(())
    }
}

/// Console scripts have an absolute shebang pointing to the original venv.
/// Execute them with the private venv's interpreter so site processing reads
/// only its rewritten editable metadata. Node keeps overlay module paths.
pub fn configure_base_command(
    command: &mut ToolCommand,
    worktree: &Path,
    destination: &Path,
    links: &[DependencyLink],
    tool_name: &str,
) -> Result<()> {
    let worktree = worktree.canonicalize()?;
    let destination = destination.canonicalize()?;
    let cwd = command.cwd.canonicalize()?;
    // Resolve the directory, preserving the executable leaf: a venv's Python
    // may itself link to a global interpreter but still needs its venv path.
    let program = command
        .program
        .parent()
        .and_then(|parent| parent.canonicalize().ok())
        .zip(command.program.file_name())
        .map_or_else(
            || command.program.clone(),
            |(parent, name)| parent.join(name),
        );
    let python_checker = matches!(tool_name, "mypy" | "pyright");
    let is_environment = |link: &&DependencyLink| {
        matches!(
            Path::new(&link.path)
                .file_name()
                .and_then(|name| name.to_str()),
            Some(".venv" | "venv")
        )
    };
    let environment_link = links
        .iter()
        .filter(is_environment)
        .find(|link| program.starts_with(&link.target))
        .or_else(|| {
            python_checker
                .then(|| {
                    links
                        .iter()
                        .filter(is_environment)
                        .filter(|link| {
                            destination
                                .join(&link.path)
                                .parent()
                                .is_some_and(|parent| cwd.starts_with(parent))
                        })
                        .max_by_key(|link| link.path.len())
                })
                .flatten()
        });
    if let Some(link) = environment_link {
        let original = &link.target;
        let environment = destination.join(&link.path);
        let interpreter = environment.join(if cfg!(windows) {
            "Scripts/python.exe"
        } else {
            "bin/python"
        });
        command
            .env
            .insert("VIRTUAL_ENV".into(), environment.clone().into_os_string());
        let paths =
            std::iter::once(environment.join(if cfg!(windows) { "Scripts" } else { "bin" })).chain(
                std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
                    .collect::<Vec<_>>(),
            );
        command
            .env
            .insert("PATH".into(), std::env::join_paths(paths)?);
        if let Some(paths) = std::env::var_os("PYTHONPATH") {
            let paths = std::env::split_paths(&paths).map(|path| {
                let resolved = path.canonicalize().unwrap_or_else(|_| path.clone());
                resolved
                    .strip_prefix(&worktree)
                    .map_or(path, |relative| destination.join(relative))
            });
            command
                .env
                .insert("PYTHONPATH".into(), std::env::join_paths(paths)?);
        }
        if let Ok(relative) = program.strip_prefix(original) {
            let program = environment.join(relative);
            if fs::read(&command.program).is_ok_and(|bytes| bytes.starts_with(b"#!")) {
                ensure!(
                    interpreter.exists(),
                    "editable installation interpreter cannot be remapped"
                );
                command.args.insert(0, program.into_os_string());
                command.program = interpreter.clone();
            } else {
                command.program = program;
            }
        }
        if python_checker {
            ensure!(
                interpreter.exists(),
                "editable installation interpreter cannot be remapped"
            );
            command.args.extend([
                if tool_name == "mypy" {
                    "--python-executable"
                } else {
                    "--pythonpath"
                }
                .into(),
                interpreter.into_os_string(),
            ]);
        }
    } else {
        ensure!(
            !python_checker,
            "linked dependency points at changed source; Python checker has no private environment for editable remapping"
        );
    }
    let options = std::env::var("NODE_OPTIONS").unwrap_or_default();
    command.env.insert(
        "NODE_OPTIONS".into(),
        format!("{options} --preserve-symlinks").into(),
    );
    Ok(())
}

fn symlink(target: &Path, destination: &Path) -> Result<()> {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, destination)?;
    #[cfg(windows)]
    if target.is_dir() {
        std::os::windows::fs::symlink_dir(target, destination)?;
    } else {
        std::os::windows::fs::symlink_file(target, destination)?;
    }
    Ok(())
}
fn remove_link(path: &Path) -> Result<()> {
    #[cfg(windows)]
    if path.is_dir() {
        return fs::remove_dir(path).context("remove dependency link");
    }
    fs::remove_file(path).context("remove dependency link")
}

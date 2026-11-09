use rio_qa::{SkillInstall, install_skill_version};
use std::fs;
const OLD: &str = "# QA\nSkill version: 0.1.0\nOld text\n";
const NEW: &str = "# QA\nSkill version: 0.2.0\nNew text\n";
#[test]
fn installs_registers_and_refreshes_without_touching_owner_text() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("AGENTS.md"), "Owner text before\n").unwrap();
    assert_eq!(
        install_skill_version(root.path(), OLD).unwrap(),
        SkillInstall::Installed
    );
    let main = root.path().join(".rio/qa/skills/rio-qa/SKILL.md");
    assert_eq!(fs::read_to_string(&main).unwrap(), OLD);
    assert_eq!(
        fs::read_to_string(root.path().join(".claude/skills/rio-qa/SKILL.md")).unwrap(),
        OLD
    );
    let agents = root.path().join("AGENTS.md");
    let original = fs::read_to_string(&agents).unwrap() + "Owner text after\n";
    fs::write(&agents, &original).unwrap();
    assert_eq!(
        install_skill_version(root.path(), NEW).unwrap(),
        SkillInstall::Refreshed
    );
    assert_eq!(fs::read_to_string(&main).unwrap(), NEW);
    assert_eq!(fs::read_to_string(&agents).unwrap(), original);
    assert_eq!(
        install_skill_version(root.path(), OLD).unwrap(),
        SkillInstall::Unchanged
    );
    assert_eq!(fs::read_to_string(&main).unwrap(), NEW);
}
#[test]
fn edited_skill_is_kept_and_newer_version_is_proposed() {
    let root = tempfile::tempdir().unwrap();
    install_skill_version(root.path(), OLD).unwrap();
    let main = root.path().join(".rio/qa/skills/rio-qa/SKILL.md");
    let edited = format!("{OLD}Owner addition\n");
    fs::write(&main, &edited).unwrap();
    assert_eq!(
        install_skill_version(root.path(), NEW).unwrap(),
        SkillInstall::Proposed
    );
    assert_eq!(fs::read_to_string(&main).unwrap(), edited);
    assert_eq!(
        fs::read_to_string(main.with_file_name("SKILL.proposed.md")).unwrap(),
        NEW
    );
    assert_eq!(
        fs::read_to_string(root.path().join(".claude/skills/rio-qa/SKILL.md")).unwrap(),
        edited
    );
}
#[test]
fn malformed_fences_and_existing_harness_skills_are_preserved() {
    let root = tempfile::tempdir().unwrap();
    let agents = root.path().join("AGENTS.md");
    fs::write(&agents, "<!-- rio-qa:start -->\nUser text").unwrap();
    assert!(install_skill_version(root.path(), OLD).is_err());
    assert_eq!(
        fs::read_to_string(&agents).unwrap(),
        "<!-- rio-qa:start -->\nUser text"
    );
}
#[cfg(unix)]
#[test]
fn repository_symlinks_cannot_redirect_skill_installation() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(outside.path(), root.path().join(".rio")).unwrap();
    assert!(install_skill_version(root.path(), OLD).is_err());
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
}

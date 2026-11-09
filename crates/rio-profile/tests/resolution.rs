use std::{fs, path::Path};

use proptest::prelude::*;
use rio_profile::{ProfileLoader, deep_merge, execution_order, parse_duration};
use serde_json::json;

fn loader(root: &Path) -> ProfileLoader {
    ProfileLoader::new(Some(root.into()), root.join("config"), root.into())
}

fn write(root: &Path, path: &str, text: &str) {
    let path = root.join(path);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

#[test]
fn nested_mappings_merge_but_all_lists_replace() {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        "parent.yaml",
        "version: 1\nname: parent\nextends: rio/base\nbudget:\n  fast: {wall_time: 4m, tokens: 200000}\nsuppress: [{path: 'a/**'}, {rule: 'lint/*'}, {finding: abc}]\n",
    );
    write(
        root.path(),
        "child.yaml",
        "version: 1\nname: child\nextends: parent.yaml\nbudget:\n  fast: {wall_time: 2m}\nsuppress: [{rule: 'typecheck/*'}]\nsteps: [{id: report, uses: rio/report}]\n",
    );
    let resolved = loader(root.path()).load(Some("child.yaml")).unwrap();
    assert_eq!(resolved.chain, ["child", "parent", "rio/base"]);
    assert_eq!(resolved.profile.budget.fast.wall_time, "2m");
    assert_eq!(resolved.profile.budget.fast.tokens, Some(200000));
    assert_eq!(resolved.profile.suppress.len(), 1);
    assert_eq!(resolved.profile.steps.len(), 1);
    assert_eq!(resolved.profile.steps[0].uses, "rio/report@0.1.0");
}

#[test]
fn relative_inheritance_uses_declaring_file_even_from_a_subdirectory() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("src")).unwrap();
    write(
        root.path(),
        ".rio/profiles/shared.yaml",
        "version: 1\nname: shared\nextends: rio/base\nmax_lines: 123\n",
    );
    write(
        root.path(),
        ".rio/profiles/team/strict.yaml",
        "version: 1\nname: strict\nextends: ../shared.yaml\n",
    );
    let loader = ProfileLoader::new(
        Some(root.path().into()),
        root.path().join("config"),
        root.path().join("src"),
    );
    let resolved = loader
        .load(Some("../.rio/profiles/team/strict.yaml"))
        .unwrap();
    assert_eq!(resolved.chain, ["strict", "shared", "rio/base"]);
    assert_eq!(resolved.profile.max_lines, 123);
}

#[test]
fn inheritance_cycles_are_canonicalized_and_name_the_cycle() {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        "a.yaml",
        "version: 1\nname: A\nextends: ./b.yaml\n",
    );
    write(
        root.path(),
        "b.yaml",
        "version: 1\nname: B\nextends: ./a.yaml\n",
    );
    let error = loader(root.path())
        .load(Some("a.yaml"))
        .unwrap_err()
        .to_string();
    assert!(error.contains("inheritance cycle"), "{error}");
    assert!(error.contains("a.yaml") && error.contains("b.yaml"));
}

#[test]
fn resolved_base_has_pinned_modules_stable_hash_and_writes_exact_document() {
    let root = tempfile::tempdir().unwrap();
    let loader = loader(root.path());
    let resolved = loader.load(Some("rio/base")).unwrap();
    assert_eq!(resolved.warnings.len(), 4);
    assert_eq!(resolved.modules.len(), 9);
    assert!(
        resolved
            .profile
            .steps
            .iter()
            .all(|s| s.uses.ends_with("@0.1.0") || s.uses == "rio/security@0.2.0")
    );
    assert_eq!(
        execution_order(&resolved.profile.steps).unwrap(),
        [0, 1, 2, 3, 4, 5, 6, 7, 8]
    );
    insta::assert_snapshot!("resolved_base", resolved.to_yaml().unwrap());
    let path = root.path().join("profile.resolved.yaml");
    resolved.write(&path).unwrap();
    assert_eq!(
        fs::read_to_string(path).unwrap(),
        resolved.to_yaml().unwrap()
    );
    write(
        root.path(),
        "custom.yaml",
        "version: 1\nname: rio/base\nextends: rio/base\nsuppress: [{rule: 'lint/*'}]\n",
    );
    let changed = loader.load(Some("custom.yaml")).unwrap();
    assert_ne!(changed.hash().unwrap(), resolved.hash().unwrap());
    let mut moved = resolved.clone();
    moved.sources.clear();
    moved.warnings.clear();
    assert_eq!(moved.hash().unwrap(), resolved.hash().unwrap());
}

#[test]
fn semantic_and_schema_diagnostics_point_to_the_declaring_file_and_yaml_path() {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        "parent.yaml",
        "version: 1\nname: parent\nextends: rio/base\nmodels: {default: same, verifier: same}\nverify: {voters: 1}\nmin_evidence: refuted\n",
    );
    write(
        root.path(),
        "child.yaml",
        "version: 1\nname: child\nextends: parent.yaml\n",
    );
    let errors = loader(root.path()).load(Some("child.yaml")).unwrap_err();
    assert_eq!(errors.diagnostics.len(), 2);
    assert!(
        errors
            .diagnostics
            .iter()
            .all(|d| d.source.ends_with("parent.yaml"))
    );
    assert!(
        errors
            .diagnostics
            .iter()
            .any(|d| d.path == "$.models.verifier")
    );
    assert!(
        errors
            .diagnostics
            .iter()
            .any(|d| d.path == "$.min_evidence")
    );
    write(
        root.path(),
        "bad.yaml",
        "version: 2\nname: bad\nagents: []\n",
    );
    let error = loader(root.path())
        .load(Some("bad.yaml"))
        .unwrap_err()
        .to_string();
    assert!(error.contains("$.agents: unknown key"), "{error}");
    assert!(error.contains("only profile version 1"));
}

#[test]
fn every_validation_rule_rejects_its_failing_fixture() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/semantic");
    let loader = loader(&root);
    for (fixture, expected) in [
        ("duplicate", "step ids must be unique"),
        ("unknown-needs", "needs unknown step"),
        ("cycle", "step dependency cycle"),
        (
            "third-party",
            "third-party modules are not supported in this version",
        ),
        ("unknown-module", "unknown built-in module"),
        ("wrong-kind", "uses must reference a step module"),
        ("wrong-version", "supported version is 0.1.0"),
        ("options", "$.steps[0].with.coverage"),
        ("budget", "budget must be positive"),
        ("models", "verifier alias must differ"),
        ("evidence", "min_evidence must be at least plausible"),
        ("verifier", "verifier step is mandatory"),
        (
            "verifier-order",
            "must depend on every enabled agents, security or QA step",
        ),
        ("required-check", "$.fail_on.required_checks[0]"),
        ("rule", "unknown predicate"),
        ("action", "unknown action"),
        ("glob", "$.steps[0].with.exclude[0]"),
        ("rounds", "diff_only_after must be below rounds.cap"),
        ("always-human", "$.always_human[0]"),
    ] {
        let error = loader
            .load(Some(&format!("{fixture}.yaml")))
            .unwrap_err()
            .to_string();
        assert!(
            error.contains(expected),
            "{fixture}: expected {expected:?} in {error}"
        );
    }
}

#[test]
fn posture_derives_reserved_policy_and_explicit_resolved_values_win() {
    use rio_core::{EvidenceLevel, Severity};
    let root = tempfile::tempdir().unwrap();
    for (posture, evidence, maximum, severity, render, limit) in [
        (
            "critical-only",
            EvidenceLevel::Reproduced,
            3,
            Severity::Error,
            false,
            Some(0),
        ),
        (
            "balanced",
            EvidenceLevel::StaticProven,
            5,
            Severity::Warning,
            true,
            Some(5),
        ),
        (
            "thorough",
            EvidenceLevel::Plausible,
            15,
            Severity::Info,
            true,
            None,
        ),
    ] {
        write(
            root.path(),
            "profile.yaml",
            &format!("version: 1\nname: test\nposture: {posture}\n"),
        );
        let resolved = loader(root.path()).load(Some("profile.yaml")).unwrap();
        assert_eq!(resolved.profile.min_evidence, evidence);
        assert_eq!(resolved.profile.max_defects, maximum);
        assert_eq!(resolved.posture_policy.defect_severity_floor, severity);
        assert_eq!(resolved.posture_policy.render_plausible_risks, render);
        assert_eq!(resolved.posture_policy.plausible_risk_limit, limit);
        assert_eq!(resolved.profile.rounds.cap, 3);
        assert_eq!(resolved.profile.rounds.diff_only_after, 1);
        let yaml = resolved.to_yaml().unwrap();
        assert!(yaml.contains("posture_policy:"));
        assert!(yaml.contains("max_defects:"));
    }
    write(
        root.path(),
        "parent.yaml",
        "version: 1\nname: parent\nmin_evidence: plausible\nmax_defects: 8\n",
    );
    write(
        root.path(),
        "child.yaml",
        "version: 1\nname: child\nextends: parent.yaml\nposture: critical-only\n",
    );
    let resolved = loader(root.path()).load(Some("child.yaml")).unwrap();
    assert_eq!(resolved.profile.min_evidence, EvidenceLevel::Plausible);
    assert_eq!(resolved.profile.max_defects, 8);
    let before = resolved.hash().unwrap();
    write(
        root.path(),
        "child.yaml",
        "version: 1\nname: child\nextends: parent.yaml\nposture: thorough\n",
    );
    assert_ne!(
        before,
        loader(root.path())
            .load(Some("child.yaml"))
            .unwrap()
            .hash()
            .unwrap()
    );
}

#[test]
fn duration_units_are_positive_and_overflow_is_rejected() {
    for (input, millis) in [
        ("1ms", 1),
        ("0.5s", 500),
        ("2m", 120000),
        ("1h", 3600000),
        ("1d", 86400000),
    ] {
        assert_eq!(parse_duration(input).unwrap().as_millis(), millis);
    }
    for input in ["0s", "-2s", "1", "1w", "NaNs", "1e999s"] {
        assert!(parse_duration(input).is_err(), "{input}");
    }
}

proptest! {
    #[test]
    fn merging_an_empty_child_preserves_any_parent_mapping(entries in prop::collection::btree_map("[a-z]{1,10}", any::<i64>(), 0..20)) {
        let mut parent = json!({"nested": entries, "list": [1, 2], "value": true});
        let original = parent.clone();
        deep_merge(&mut parent, json!({}));
        prop_assert_eq!(parent, original);
    }
}

#[test]
fn verifier_defaults_budgets_aliases_and_guardrails() {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        "p.yaml",
        "version: 1\nname: test\nmodels: {default: openai/a, verifier: openai/b}\nbudget:\n  fast: {tokens: 10003, agents_max: 2, wall_time: 1m}\n",
    );
    let p = loader(root.path()).load(Some("p.yaml")).unwrap();
    assert_eq!((p.profile.verify.voters, p.profile.verify.quorum), (3, 2));
    assert_eq!(p.profile.budget.fast.verify_tokens, Some(1000));
    assert!(!p.to_yaml().unwrap().contains("model: null"));
    let hash = p.hash().unwrap();
    for (settings, valid) in [
        ("verify: {voters: 1}", true),
        (
            "verify: {voters: 3}\nmodels: {default: openai/a, verifier: openai/a}",
            true,
        ),
        (
            "verify: {voters: 1, model: other}\nmodels: {default: openai/a, other: openai/a}",
            false,
        ),
        ("verify: {voters: 2, quorum: 3}", false),
        ("verify: {model: absent}", false),
        ("verify: {voters: 0}", false),
        ("budget: {fast: {verify_tokens: 0}}", false),
    ] {
        write(
            root.path(),
            "child.yaml",
            &format!("version: 1\nname: child\nextends: p.yaml\n{settings}\n"),
        );
        let result = loader(root.path()).load(Some("child.yaml"));
        assert_eq!(result.is_ok(), valid, "{settings}: {result:?}");
        if let Ok(p) = result {
            if p.profile.verify.voters == 1 {
                assert_eq!(p.profile.verify.quorum, 1);
            }
            assert_ne!(p.hash().unwrap(), hash);
        }
    }
    write(
        root.path(),
        "child.yaml",
        "version: 1\nname: child\nextends: rio/base\nsteps: [{id: security, uses: rio/security, with: {enabled: true}}]\n",
    );
    assert!(
        loader(root.path())
            .load(Some("child.yaml"))
            .unwrap_err()
            .to_string()
            .contains("verifier step is mandatory")
    );
}

#[test]
fn presets_resolve_posture_and_preserve_explicit_caps() {
    use rio_core::EvidenceLevel;
    use rio_profile::Posture;
    let root = tempfile::tempdir().unwrap();
    for (posture, evidence, cap) in [
        (Posture::CriticalOnly, EvidenceLevel::Reproduced, 3),
        (Posture::Balanced, EvidenceLevel::StaticProven, 5),
        (Posture::Thorough, EvidenceLevel::Plausible, 15),
    ] {
        let p = loader(root.path())
            .load_with_preset(Some("rio/base"), Some(posture))
            .unwrap();
        assert_eq!(p.profile.posture, posture);
        assert_eq!(p.profile.min_evidence, evidence);
        assert_eq!(p.profile.max_defects, cap);
        assert!(p.profile.budget.deep.is_some());
    }
    write(
        root.path(),
        "p.yaml",
        "version: 1\nname: explicit\nextends: rio/base\nmin_evidence: static_proven\nmax_defects: 8\n",
    );
    let p = loader(root.path())
        .load_with_preset(Some("p.yaml"), Some(Posture::Thorough))
        .unwrap();
    assert_eq!(p.profile.max_defects, 8);
    assert_eq!(p.profile.min_evidence, EvidenceLevel::StaticProven);
}

#[test]
fn security_and_triage_options_have_strict_schemas_and_verifier_dependencies() {
    let root = tempfile::tempdir().unwrap();
    for options in [
        "{enabled: false, catalog: owasp-top10-2025, posture: thorough, max_defects: 2, fail_on: {evidence: plausible, categories: [security]}}",
        "{enabled: false, catalog: asvs-5.0}",
    ] {
        write(
            root.path(),
            "p.yaml",
            &format!(
                "version: 1\nname: test\nextends: rio/base\nsteps: [{{id: security, uses: rio/security, with: {options}}}]\n"
            ),
        );
        assert!(
            loader(root.path()).load(Some("p.yaml")).is_ok(),
            "{options}"
        );
    }
    for options in [
        "{catalog: unknown}",
        "{max_defects: -1}",
        "{posture: extreme}",
        "{fail_on: {evidence: certain}}",
        "{fail_on: {rules: ['[']}}",
    ] {
        write(
            root.path(),
            "p.yaml",
            &format!(
                "version: 1\nname: test\nextends: rio/base\nsteps: [{{id: security, uses: rio/security, with: {options}}}]\n"
            ),
        );
        assert!(
            loader(root.path()).load(Some("p.yaml")).is_err(),
            "{options}"
        );
    }
    write(
        root.path(),
        "p.yaml",
        "version: 1\nname: test\nextends: rio/base\nsteps: [{id: triage, uses: rio/triage, with: {fan_out_high: 0}}]\n",
    );
    assert!(loader(root.path()).load(Some("p.yaml")).is_err());
}

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
    assert_eq!(resolved.modules.len(), 10);
    assert!(
        resolved
            .profile
            .steps
            .iter()
            .all(|s| s.uses.ends_with("@0.1.0") || s.uses == "rio/security@0.2.0")
    );
    assert_eq!(
        execution_order(&resolved.profile.steps).unwrap(),
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
    );
    // The council step is present and disabled: no warning, no council call.
    let council = resolved.profile.step("rio/council").unwrap();
    assert_eq!(council.options["enabled"], false);
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
        ("missing-then", "rule needs an action in then"),
        (
            "finding-predicate",
            "$.steps[0].rules[0].when: evidence is a predicate allowed only in the council step's rules",
        ),
        (
            "council-needs",
            "$.steps[2].needs: the council step requires the verify step",
        ),
        (
            "council-then",
            "$.steps[2].rules[0].then: council rules select findings and carry no action",
        ),
        (
            "council-min-members",
            "$.council.min_members: min_members 5 exceeds the council's 4 members",
        ),
        (
            "council-families",
            "council members span 2 model families (claude, gpt); at least three are required",
        ),
        (
            "council-member-kind",
            "$.council.members[0].uses: uses must reference a council member module",
        ),
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
            10,
            Severity::Warning,
            true,
            Some(10),
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
    // A voter's allowance is not a share of the review budget.
    assert_eq!(p.profile.budget.fast.verify_tokens, Some(320_000));
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
        // Risks may be verified by fewer voters, under the one-voter rule.
        ("verify: {risk_voters: 1}", true),
        ("verify: {risk_voters: 3}", true),
        ("verify: {risk_voters: 4}", false),
        ("verify: {risk_voters: 0}", false),
        (
            "verify: {risk_voters: 2}\nmodels: {default: openai/a, verifier: openai/a}",
            true,
        ),
        (
            "verify: {risk_voters: 1}\nmodels: {default: openai/a, verifier: openai/a}",
            false,
        ),
        ("budget: {fast: {verify_tokens: 0}}", false),
        // An agent may review under several models; one voter is none of them,
        // and an alias the profile does not define is not a model.
        (
            "steps: [{id: agents, uses: rio/agents, agents: [{correctness: {models: [default, second]}}]}, {id: verify, uses: rio/verify, needs: [agents]}]\nmodels: {second: openai/c}\nverify: {risk_voters: 1}",
            true,
        ),
        (
            "steps: [{id: agents, uses: rio/agents, agents: [{correctness: {models: [default, second]}}]}, {id: verify, uses: rio/verify, needs: [agents]}]\nmodels: {second: openai/b}\nverify: {risk_voters: 1}",
            false,
        ),
        (
            "steps: [{id: agents, uses: rio/agents, agents: [{correctness: {models: [default, second]}}]}, {id: verify, uses: rio/verify, needs: [agents]}]\nmodels: {second: openai/b}",
            true,
        ),
        (
            "steps: [{id: agents, uses: rio/agents, agents: [{correctness: {models: [default, second]}}]}, {id: verify, uses: rio/verify, needs: [agents]}]\nverify: {risk_voters: 1}",
            true,
        ),
        (
            "steps: [{id: agents, uses: rio/agents, agents: [{correctness: {run: true}}]}, {id: verify, uses: rio/verify, needs: [agents]}]",
            false,
        ),
        (
            "steps: [{id: agents, uses: rio/agents, agents: [{correctness: {models: []}}]}, {id: verify, uses: rio/verify, needs: [agents]}]",
            false,
        ),
        (
            "steps: [{id: agents, uses: rio/agents, agents: [{correctness: {models: [default, default]}}]}, {id: verify, uses: rio/verify, needs: [agents]}]",
            false,
        ),
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
        (Posture::Balanced, EvidenceLevel::StaticProven, 10),
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

const COUNCIL_STEPS: &str = "steps:\n  - {id: agents, uses: rio/agents}\n  - {id: verify, uses: rio/verify, needs: [agents]}\n  - {id: council, uses: rio/council, needs: [verify], with: {enabled: true}, rules: [{when: verify.split}]}\n";

#[test]
fn legacy_profiles_have_no_council_and_a_council_step_gets_the_defaults() {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        "legacy.yaml",
        "version: 1\nname: legacy\nsteps: [{id: agents, uses: rio/agents}, {id: verify, uses: rio/verify, needs: [agents]}]\n",
    );
    let legacy = loader(root.path()).load(Some("legacy.yaml")).unwrap();
    assert!(legacy.profile.council.is_none());
    assert!(legacy.council_members.is_empty());
    assert!(!legacy.to_yaml().unwrap().contains("council"));

    write(
        root.path(),
        "council.yaml",
        &format!("version: 1\nname: council\n{COUNCIL_STEPS}"),
    );
    let resolved = loader(root.path()).load(Some("council.yaml")).unwrap();
    let council = resolved.profile.council.as_ref().unwrap();
    assert_eq!(
        (
            council.max_findings,
            council.max_experiments,
            council.max_rounds,
            council.min_members,
            council.timeout.as_str(),
        ),
        (5, 2, 2, 3, "90s")
    );
    assert!(council.vendors_allowed.is_empty());
    let roles: Vec<_> = resolved
        .council_members
        .iter()
        .map(|m| (m.role.as_str(), m.context_pack.as_str(), m.vendor.as_str()))
        .collect();
    assert_eq!(
        roles,
        [
            ("skeptic", "diff-only", "placeholder"),
            ("exploit-author", "execution", "placeholder"),
            ("code-owner", "graph-heavy", "placeholder"),
            ("maintainer", "graph-heavy", "placeholder"),
            ("tester", "execution", "placeholder"),
        ]
    );
    assert_eq!(resolved.profile.steps[2].rules[0].then, None);
}

#[test]
fn a_third_round_is_rejected_at_its_location_naming_the_maximum() {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        "rounds.yaml",
        &format!("version: 1\nname: rounds\n{COUNCIL_STEPS}council: {{max_rounds: 3}}\n"),
    );
    let error = loader(root.path())
        .load(Some("rounds.yaml"))
        .unwrap_err()
        .to_string();
    assert!(error.contains("$.council.max_rounds"), "{error}");
    assert!(error.contains("maximum of 2"), "{error}");
}

#[test]
fn placeholders_are_unconfigured_warnings_and_a_configured_council_has_none() {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        "placeholders.yaml",
        &format!("version: 1\nname: placeholders\n{COUNCIL_STEPS}"),
    );
    let resolved = loader(root.path()).load(Some("placeholders.yaml")).unwrap();
    let warnings: Vec<_> = resolved
        .warnings
        .iter()
        .map(|w| w.message.as_str())
        .filter(|m| m.contains("council"))
        .collect();
    assert_eq!(
        warnings
            .iter()
            .filter(|m| m.contains("is unconfigured; run `rio init`"))
            .count(),
        5
    );
    assert!(warnings.iter().any(|m| m.contains("will be skipped")));

    write(
        root.path(),
        "configured.yaml",
        &format!(
            "version: 1\nname: configured\n{COUNCIL_STEPS}council:\n  vendors_allowed: [anthropic, openai, google]\n  members:\n    - {{uses: rio/council-skeptic, provider: anthropic, model: claude-sonnet-5.5, family: claude}}\n    - {{uses: rio/council-tester, provider: openai, model: gpt-6.1, family: gpt}}\n    - {{uses: rio/council-maintainer, provider: google, model: gemini-3-pro, family: gemini}}\n"
        ),
    );
    let resolved = loader(root.path()).load(Some("configured.yaml")).unwrap();
    assert!(resolved.warnings.iter().all(|w| w.path != "$.council"));
    assert_eq!(resolved.council_members.len(), 3);
    assert_eq!(resolved.council_members[2].vendor, "google");
}

#[test]
fn a_disabled_council_is_never_rejected_for_its_families() {
    // `rio init` accepts two vendors; rio/base's disabled council must still load.
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        "config/config.toml",
        "[deployment]\n[[deployment.council_vendors]]\nvendor = \"anthropic\"\nfamily = \"claude\"\nmodel = \"anthropic/claude-sonnet-5.5\"\n[[deployment.council_vendors]]\nvendor = \"openai\"\nfamily = \"gpt\"\nmodel = \"openai/gpt-6.1\"\n",
    );
    let loader = loader(root.path());
    let base = loader.load(Some("rio/base")).unwrap();
    assert_eq!(base.council_members[0].family, "claude");
    assert_eq!(
        base.council_members[1].route.as_deref(),
        Some("openai/gpt-6.1")
    );
    let error = loader.load(Some("rio/security")).unwrap_err().to_string();
    assert!(
        error.contains("council members span 2 model families"),
        "{error}"
    );
}

#[test]
fn a_council_role_may_appear_only_once() {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        "twice.yaml",
        &format!(
            "version: 1\nname: twice\n{COUNCIL_STEPS}council:\n  members: [{{uses: rio/council-skeptic}}, {{uses: rio/council-tester}}, {{uses: rio/council-skeptic}}]\n"
        ),
    );
    let error = loader(root.path())
        .load(Some("twice.yaml"))
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("$.council.members[2].uses: council role skeptic appears more than once"),
        "{error}"
    );
}

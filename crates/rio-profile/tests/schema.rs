use std::{fs, path::Path};

use serde_json::{Value, json};

fn schema(name: &str) -> Value {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../schemas");
    serde_json::from_str(&fs::read_to_string(root.join(format!("{name}-v1.json"))).unwrap())
        .unwrap()
}

#[test]
fn profile_fixtures() {
    let validator = jsonschema::validator_for(&schema("profile")).unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    for (directory, valid) in [("valid", true), ("invalid", false)] {
        for entry in fs::read_dir(root.join(directory)).unwrap() {
            let path = entry.unwrap().path();
            let value: Value = serde_yaml::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            let errors: Vec<_> = validator
                .iter_errors(&value)
                .map(|e| e.to_string())
                .collect();
            assert_eq!(errors.is_empty(), valid, "{}: {errors:?}", path.display());
        }
    }
}

#[test]
fn module_contract_requires_exit_codes_and_kind_specific_fields() {
    let validator = jsonschema::validator_for(&schema("module")).unwrap();
    let mut module = json!({
        "kind": "adapter", "name": "rio/adapter-example", "version": "0.1.0",
        "description": "Example adapter", "schema": {"type": "object"},
        "languages": ["example"], "files": ["*.example"], "capabilities": ["typecheck"],
        "tools": {"typecheck": [{"name": "example", "command": ["example"], "network": [],
            "exit_codes": {"clean": [0], "diagnostics": [1], "failed": {"2": "tool_config_error"}}}]}
    });
    assert!(validator.is_valid(&module));
    module["tools"]["typecheck"][0]
        .as_object_mut()
        .unwrap()
        .remove("exit_codes");
    assert!(!validator.is_valid(&module));
    module["tools"]["typecheck"] = json!([]);
    module.as_object_mut().unwrap().remove("languages");
    assert!(!validator.is_valid(&module));
}

#[test]
fn built_in_manifests_and_base_profile_validate() {
    let validator = jsonschema::validator_for(&schema("module")).unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../modules");
    let paths = [
        "adapters/typescript",
        "adapters/python",
        "adapters/rust",
        "steps/prepare",
        "steps/checks",
        "steps/graph",
        "steps/triage",
        "steps/agents",
        "steps/verify",
        "steps/report",
        "steps/council",
        "members/skeptic",
        "members/exploit-author",
        "members/code-owner",
        "members/maintainer",
        "members/tester",
    ];
    for path in paths {
        let manifest: Value =
            serde_yaml::from_str(&fs::read_to_string(root.join(path).join("module.yaml")).unwrap())
                .unwrap();
        let errors: Vec<_> = validator
            .iter_errors(&manifest)
            .map(|e| e.to_string())
            .collect();
        assert!(errors.is_empty(), "{path}: {errors:?}");
        if manifest["kind"] != "member" {
            jsonschema::validator_for(&manifest["schema"]).unwrap();
        }
    }
    let profile: Value =
        serde_yaml::from_str(&fs::read_to_string(root.join("profiles/base.yaml")).unwrap())
            .unwrap();
    assert!(
        jsonschema::validator_for(&schema("profile"))
            .unwrap()
            .is_valid(&profile)
    );
    for step in profile["steps"].as_array().unwrap() {
        let name = step["uses"]
            .as_str()
            .unwrap()
            .strip_prefix("rio/")
            .unwrap()
            .split('@')
            .next()
            .unwrap();
        let manifest: Value = serde_yaml::from_str(
            &fs::read_to_string(root.join(format!("steps/{name}/module.yaml"))).unwrap(),
        )
        .unwrap();
        let validator = jsonschema::validator_for(&manifest["schema"]).unwrap();
        assert!(
            validator.is_valid(step.get("with").unwrap_or(&json!({}))),
            "{name}"
        );
    }
}

#[test]
fn shipped_catalogs_validate_with_unique_official_ids_and_attribution() {
    let validator = jsonschema::validator_for(&schema("module")).unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../modules/catalogs");
    let mut names: Vec<_> = fs::read_dir(&root)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert_eq!(names, ["asvs-5.0.yaml", "owasp-top10-2025.yaml"]);
    for (file, id_pattern, count) in [
        ("owasp-top10-2025.yaml", r"^A(0[1-9]|10):2025$", 10),
        ("asvs-5.0.yaml", r"^V(1[0-7]|[1-9])\.[1-9]$", 69),
    ] {
        let catalog: Value =
            serde_yaml::from_str(&fs::read_to_string(root.join(file)).unwrap()).unwrap();
        let errors: Vec<_> = validator
            .iter_errors(&catalog)
            .map(|e| e.to_string())
            .collect();
        assert!(errors.is_empty(), "{file}: {errors:?}");
        assert_eq!(catalog["kind"], "catalog");
        assert_eq!(
            catalog["name"],
            format!("rio/{}", file.trim_end_matches(".yaml"))
        );
        let notice = catalog["attribution"]["notice"].as_str().unwrap();
        assert!(notice.contains("OWASP Foundation") && notice.contains("ShareAlike 4.0"));
        assert_eq!(catalog["attribution"]["license"], "CC BY-SA 4.0");
        let pattern = regex::Regex::new(id_pattern).unwrap();
        let items = catalog["items"].as_array().unwrap();
        assert_eq!(items.len(), count, "{file}");
        let mut ids = std::collections::BTreeSet::new();
        for item in items {
            let id = item["id"].as_str().unwrap();
            assert!(pattern.is_match(id), "{file}: {id}");
            assert!(ids.insert(id), "{file}: duplicate {id}");
            for key in ["title", "summary", "url"] {
                assert!(!item[key].as_str().unwrap().trim().is_empty(), "{id} {key}");
            }
        }
    }
    // Every predicate and trace name is closed by the schema.
    let mut catalog: Value =
        serde_yaml::from_str(&fs::read_to_string(root.join("owasp-top10-2025.yaml")).unwrap())
            .unwrap();
    catalog["items"][0]["applies_when"] = json!({"any": [{"runtime": ["node"]}]});
    assert!(!validator.is_valid(&catalog));
    catalog["items"][0]["applies_when"] = json!({"any": [{"node_kind": ["route"]}]});
    assert!(!validator.is_valid(&catalog));
    catalog["items"][0]["applies_when"] = json!({"any": [{"always": true}]});
    catalog["items"][0]["trace"]["sinks"] = json!(["eval"]);
    assert!(!validator.is_valid(&catalog));
    // A catalog cannot carry step or adapter fields, and steps keep strict names.
    catalog["items"][0]["trace"]["sinks"] = json!(["sql_query"]);
    assert!(validator.is_valid(&catalog));
    catalog["schema"] = json!({"type": "object"});
    assert!(!validator.is_valid(&catalog));
    let step = json!({"kind": "step", "name": "rio/agents.v2", "version": "0.1.0",
        "description": "x", "schema": {}, "inputs": [], "outputs": [], "local": false});
    assert!(!validator.is_valid(&step));
}

#[test]
fn agent_manifests_validate_and_declare_v03_roles() {
    let validator = jsonschema::validator_for(&schema("agent")).unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../modules/agents");
    for entry in fs::read_dir(&root).unwrap() {
        let directory = entry.unwrap().path();
        let manifest: Value =
            serde_json::from_str(&fs::read_to_string(directory.join("manifest.json")).unwrap())
                .unwrap();
        let errors: Vec<_> = validator
            .iter_errors(&manifest)
            .map(|e| e.to_string())
            .collect();
        assert!(errors.is_empty(), "{}: {errors:?}", directory.display());
        let name = manifest["name"].as_str().unwrap();
        // Only the contracts agent answers triage's public_contracts signal.
        assert_eq!(manifest["contracts"] == json!(true), name == "contracts");
        // Agents with their own instructions ship them as prompt.md.
        assert_eq!(
            directory.join("prompt.md").is_file(),
            ["contracts", "security"].contains(&name),
            "{name}"
        );
    }
    let security: Value =
        serde_json::from_str(&fs::read_to_string(root.join("security/manifest.json")).unwrap())
            .unwrap();
    assert_eq!(security["available"], true);
    assert_eq!(security["run"], true);
}

fn member() -> Value {
    json!({"kind": "member", "name": "rio/council-example", "version": "0.1.0",
        "description": "Example member", "provider": "openai", "model": "gpt-5",
        "prompt": "prompt.md", "context_pack": "diff-only", "role": "skeptic", "weight": 1,
        "family": "gpt"})
}

#[test]
fn member_manifests_validate_each_field_and_name_the_offender() {
    use rio_profile::validate_member_manifest;
    assert!(validate_member_manifest(&member(), "example").is_ok());
    let error = |pointer: &str, value: Value| {
        let mut manifest = member();
        if value.is_null() {
            manifest
                .as_object_mut()
                .unwrap()
                .remove(pointer.trim_start_matches('/'));
        } else {
            manifest[pointer.trim_start_matches('/')] = value;
        }
        validate_member_manifest(&manifest, "example")
            .unwrap_err()
            .to_string()
    };
    let role = error("/role", json!("judge"));
    assert!(role.contains("$.role"), "{role}");
    assert!(
        role.contains("skeptic, exploit-author, code-owner, maintainer, tester"),
        "{role}"
    );
    let pack = error("/context_pack", json!("everything"));
    assert!(pack.contains("$.context_pack"), "{pack}");
    assert!(pack.contains("diff-only, graph-heavy, execution"), "{pack}");
    let extra = error("/reasoning", json!(true));
    assert!(extra.contains("$.reasoning"), "{extra}");
    for (field, value) in [
        ("weight", json!(0)),
        ("weight", json!("heavy")),
        ("provider", json!("Open AI")),
        ("family", json!("")),
        ("prompt", json!("../prompt.md")),
        ("self_hosted", json!("yes")),
        ("model", json!("")),
    ] {
        let message = error(field, value);
        assert!(
            message.contains(&format!("$.{field}")),
            "{field}: {message}"
        );
    }
    for field in [
        "provider",
        "model",
        "prompt",
        "context_pack",
        "role",
        "weight",
        "family",
    ] {
        let message = error(field, Value::Null);
        assert!(message.contains(field), "{field}: {message}");
    }
    // Member fields are confined to the member kind.
    let validator = jsonschema::validator_for(&schema("module")).unwrap();
    let mut step = json!({"kind": "step", "name": "rio/example", "version": "0.1.0",
        "description": "Example", "schema": {"type": "object"}, "inputs": [], "outputs": [],
        "local": false});
    assert!(validator.is_valid(&step));
    step["role"] = json!("skeptic");
    assert!(!validator.is_valid(&step));
}

#[test]
fn the_five_built_in_members_load_with_unique_roles_and_prompts() {
    let modules = rio_profile::builtin_modules().unwrap();
    let members: Vec<_> = modules
        .values()
        .filter(|module| module.kind == rio_profile::ModuleKind::Member)
        .collect();
    assert_eq!(members.len(), 5);
    let mut roles: Vec<_> = members
        .iter()
        .map(|module| {
            let fields = module.member.as_ref().unwrap();
            assert!(fields.weight > 0.0);
            assert_eq!(fields.provider, rio_profile::PLACEHOLDER);
            let prompt = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../modules/members")
                .join(&fields.role)
                .join(&fields.prompt);
            let text = fs::read_to_string(&prompt).unwrap();
            assert!(
                text.contains("`repository_data` blocks"),
                "{}",
                prompt.display()
            );
            (fields.role.as_str(), fields.context_pack.as_str())
        })
        .collect();
    roles.sort();
    assert_eq!(
        roles,
        [
            ("code-owner", "graph-heavy"),
            ("exploit-author", "execution"),
            ("maintainer", "graph-heavy"),
            ("skeptic", "diff-only"),
            ("tester", "execution"),
        ]
    );
}

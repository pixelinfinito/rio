//! Documentation tests: the SARIF mapping against its fixtures, and the
//! composition of spec deltas that modify the same main-spec requirements.

use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

use serde_json::Value;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn read(path: impl AsRef<Path>) -> String {
    let path = root().join(path);
    fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

fn keys(value: &Value, into: &mut BTreeSet<String>) {
    match value {
        Value::Object(map) => {
            for (key, value) in map {
                into.insert(key.clone());
                keys(value, into);
            }
        }
        Value::Array(items) => items.iter().for_each(|item| keys(item, into)),
        _ => {}
    }
}

/// Backticked names in the first column of every `| SARIF property |` table.
fn mapped_properties(document: &str) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    let mut in_table = false;
    for line in document.lines() {
        if line.starts_with("| SARIF property |") {
            in_table = true;
            continue;
        }
        if !line.starts_with('|') {
            in_table = false;
            continue;
        }
        if !in_table || line.starts_with("| ---") {
            continue;
        }
        let cell = line.split('|').nth(1).unwrap().trim();
        let name = cell.trim_matches('`');
        assert!(
            cell.starts_with('`') && cell.ends_with('`') && !name.contains('`'),
            "first column must be one backticked property name: {line}"
        );
        names.insert(name.to_string());
    }
    names
}

#[test]
fn every_sarif_mapping_property_appears_in_the_fixtures() {
    let document = read("docs/sarif-mapping.md");
    let properties = mapped_properties(&document);
    assert!(properties.len() > 40, "{properties:?}");
    let report_schema: Value = serde_json::from_str(&read("schemas/report-v1.json")).unwrap();
    let report_validator = jsonschema::validator_for(&report_schema).unwrap();
    let mut cases = Vec::new();
    let mut found = BTreeSet::new();
    for entry in fs::read_dir(root().join("tests/fixtures/sarif")).unwrap() {
        let directory = entry.unwrap().path();
        let name = directory.file_name().unwrap().to_string_lossy().to_string();
        let report: Value = serde_json::from_str(&read(directory.join("report.json"))).unwrap();
        let errors: Vec<_> = report_validator
            .iter_errors(&report)
            .map(|e| e.to_string())
            .collect();
        assert!(errors.is_empty(), "{name}: {errors:?}");
        serde_json::from_value::<rio_core::Report>(report).unwrap();
        let inputs: Value = serde_json::from_str(&read(directory.join("render.json"))).unwrap();
        let input_keys: BTreeSet<_> = inputs.as_object().unwrap().keys().cloned().collect();
        assert_eq!(
            input_keys,
            ["end_time_utc", "exit_code", "start_time_utc"]
                .map(String::from)
                .into(),
            "{name}"
        );
        let sarif: Value = serde_json::from_str(&read(directory.join("expected.sarif"))).unwrap();
        assert_eq!(sarif["version"], "2.1.0", "{name}");
        assert_eq!(sarif["runs"].as_array().unwrap().len(), 1, "{name}");
        keys(&sarif, &mut found);
        assert!(
            document.contains(&format!("| `{name}` |")),
            "{name} is not documented"
        );
        cases.push(name);
    }
    cases.sort();
    assert_eq!(
        cases,
        [
            "complete-review",
            "error-status",
            "lineage-history",
            "pr-lineage",
            "risks-and-plausible"
        ]
    );
    let missing: Vec<_> = properties.difference(&found).collect();
    assert!(
        missing.is_empty(),
        "mapped properties absent from every fixture: {missing:?}"
    );
}

// ---------------------------------------------------------------------------
// Delta composition (rio-v0-3-core task 0.5, rio-v0-3-council task 0.7).
//
// `openspec archive` writes a MODIFIED requirement whole, so the change that
// archives last must carry every addition made by the earlier ones
// (docs/v0.3-sequence.md, "Spec deltas that overlap").

struct Requirement {
    name: &'static str,
    main: &'static str,
    delta: &'static str,
    /// Changes that modify the requirement, in archive order.
    changes: &'static [&'static str],
    /// Compare the backticked names (predicates, actions) rather than clauses,
    /// for a requirement whose additions extend one list in place.
    by_names: bool,
}

const REQUIREMENTS: [Requirement; 5] = [
    Requirement {
        name: "Built-in step options",
        main: "openspec/specs/review-profiles/spec.md",
        delta: "specs/review-profiles/spec.md",
        changes: &["rio-v0-3-core", "rio-v0-3-qa"],
        by_names: false,
    },
    Requirement {
        name: "Rule expressions are validated syntactically",
        main: "openspec/specs/review-profiles/spec.md",
        delta: "specs/review-profiles/spec.md",
        changes: &["rio-v0-3-council"],
        by_names: true,
    },
    Requirement {
        name: "Section order",
        main: "openspec/specs/review-report/spec.md",
        delta: "specs/review-report/spec.md",
        changes: &["rio-v0-3-qa", "rio-v0-3-council"],
        by_names: false,
    },
    Requirement {
        name: "Footer content",
        main: "openspec/specs/review-report/spec.md",
        delta: "specs/review-report/spec.md",
        changes: &[
            "rio-v0-2-review-convergence",
            "rio-v0-3-core",
            "rio-v0-3-qa",
        ],
        by_names: false,
    },
    Requirement {
        name: "Finding model",
        main: "openspec/specs/findings/spec.md",
        delta: "specs/findings/spec.md",
        changes: &["rio-v0-2-review-convergence", "rio-v0-3-qa"],
        by_names: false,
    },
];

/// The change directory, active or archived (`archive/<date>-<name>`).
fn change(name: &str) -> (PathBuf, bool) {
    let active = root().join("openspec/changes").join(name);
    if active.is_dir() {
        return (active, false);
    }
    let archive = root().join("openspec/changes/archive");
    let archived = fs::read_dir(&archive)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .ends_with(&format!("-{name}"))
        })
        .unwrap_or_else(|| panic!("change {name} not found"));
    (archived, true)
}

/// The requirement body: from its heading to its first scenario.
fn body(document: &str, name: &str) -> Option<String> {
    let start = document.find(&format!("### Requirement: {name}\n"))?;
    let rest = &document[start..];
    let rest = &rest[rest.find('\n').unwrap() + 1..];
    let end = rest.find("\n#### Scenario").unwrap_or(rest.len());
    Some(rest[..end].trim().to_string())
}

fn backticked(text: &str) -> BTreeSet<String> {
    text.split('`')
        .skip(1)
        .step_by(2)
        .map(String::from)
        .collect()
}

fn normalize(clause: &str) -> String {
    let mut text = clause.trim().to_lowercase();
    for prefix in [
        "the footer shall always list:",
        "it shall also list:",
        "and,",
        "and ",
    ] {
        if let Some(rest) = text.strip_prefix(prefix) {
            text = rest.trim().to_string();
        }
    }
    text.trim_end_matches('.')
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Items an archive must not lose: one per step bullet (keyed by the step,
/// holding its backticked option names) or one per footer clause.
#[derive(Debug)]
enum Item {
    Step(String, BTreeSet<String>),
    Clause(String),
    ModelSentence(Vec<String>),
    Name(String),
}

fn model_words(sentence: &str) -> Vec<String> {
    sentence
        .split(|c: char| !c.is_alphanumeric() && c != '_' && c != '/')
        .filter(|word| !word.is_empty() && *word != "or")
        .map(str::to_lowercase)
        .collect()
}

fn items_of(requirement: &Requirement, body: &str) -> Vec<Item> {
    if requirement.by_names {
        backticked(body).into_iter().map(Item::Name).collect()
    } else {
        items(body)
    }
}

fn items(body: &str) -> Vec<Item> {
    if body.starts_with("A finding SHALL have:") {
        body.split(". ")
            .map(|sentence| Item::ModelSentence(model_words(sentence)))
            .collect()
    } else if body.contains("\n- `rio/") {
        body.lines()
            .filter(|line| line.starts_with("- `"))
            .map(|line| {
                let step = line.split('`').nth(1).unwrap().to_string();
                (step, backticked(line))
            })
            .map(|(step, names)| Item::Step(step, names))
            .collect()
    } else {
        body.replace("It SHALL also list:", ";")
            .split(';')
            .map(normalize)
            .filter(|clause| !clause.is_empty())
            .map(Item::Clause)
            .collect()
    }
}

/// Whether `later` still carries `item`. A later text may extend a clause or a
/// step's option list; it may not drop either.
fn carried(item: &Item, later: &[Item]) -> bool {
    match item {
        Item::ModelSentence(words) => later.iter().any(|other| {
            let Item::ModelSentence(candidate) = other else {
                return false;
            };
            let mut remaining = candidate.iter();
            words.iter().all(|word| remaining.any(|next| next == word))
        }),
        Item::Step(step, names) => later
            .iter()
            .any(|other| matches!(other, Item::Step(s, n) if s == step && n.is_superset(names))),
        Item::Clause(clause) => later
            .iter()
            .any(|other| matches!(other, Item::Clause(c) if c.starts_with(clause.as_str()))),
        Item::Name(name) => later
            .iter()
            .any(|other| matches!(other, Item::Name(n) if n == name)),
    }
}

fn lost(earlier: &[Item], later: &[Item]) -> Vec<String> {
    earlier
        .iter()
        .filter(|item| !carried(item, later))
        .map(|item| format!("{item:?}"))
        .collect()
}

/// A change's own composition task, while open, owns a known gap.
fn composition_task_open(directory: &Path) -> bool {
    fs::read_to_string(directory.join("tasks.md"))
        .unwrap_or_default()
        .lines()
        .any(|line| line.starts_with("- [ ] ") && line.contains("Compose"))
}

#[test]
fn composition_check_detects_dropped_additions() {
    let main = "The footer SHALL always list: each check; excluded files with reasons; and, for lineage reviews, the round number.";
    let extended =
        format!("{main} It SHALL also list: the agent cache hit rate when the agents step ran.");
    let dropped = "The footer SHALL always list: each check; and, for lineage reviews, the round number; the agent cache hit rate when the agents step ran.";
    assert!(lost(&items(main), &items(&extended)).is_empty());
    assert_eq!(
        lost(&items(&extended), &items(dropped)),
        ["Clause(\"excluded files with reasons\")"]
    );
    let model = "A finding SHALL have: `category` (`defect` or `risk`). An optional `status` SHALL be emitted for posted findings; it is independent of `state`.";
    let added = model.replace("`risk`", "`risk` or `ux`");
    assert!(lost(&items(model), &items(&added)).is_empty());
    assert_eq!(lost(&items(&added), &items(model)).len(), 1);
    let dropped = added.replace("; it is independent of `state`", "");
    assert_eq!(lost(&items(model), &items(&dropped)).len(), 1);
    let steps = "Options:\n- `rio/report`: `class_threshold` and `proposal_threshold`;\n- `rio/graph`: `hops`.";
    let narrowed =
        "Options:\n- `rio/report`: `class_threshold`;\n- `rio/graph`: `hops` and `max_nodes`.";
    assert_eq!(lost(&items(steps), &items(narrowed)).len(), 1);
    assert!(lost(&items(narrowed), &items(steps)).len() == 1);
    // Council additions: a predicate dropped from the rule language, a section
    // dropped from the order.
    let rules = &REQUIREMENTS[1];
    let main = "predicates `touches(glob)`, `risk >= level` and actions `require_human()`.";
    let council = "predicates `touches(glob)`, `risk >= level`, `verify.split` and actions `require_human()`.";
    assert!(lost(&items_of(rules, main), &items_of(rules, council)).is_empty());
    assert_eq!(
        lost(&items_of(rules, council), &items_of(rules, main)),
        ["Name(\"verify.split\")"]
    );
    let order = "header (review id); risks; security findings when present; council results when present (decision, tier); footer (timings).";
    let without = "header (review id); risks; security findings when present; QA results when present; footer (timings).";
    assert_eq!(
        lost(&items(order), &items(without)),
        ["Clause(\"council results when present (decision, tier)\")"]
    );
}

#[test]
fn overlapping_deltas_carry_every_earlier_addition() {
    let sequence = read("docs/v0.3-sequence.md");
    let mut pending = Vec::new();
    for requirement in &REQUIREMENTS {
        let main = items_of(
            requirement,
            &body(&read(requirement.main), requirement.name).unwrap(),
        );
        assert!(main.len() > 3, "{}: {main:?}", requirement.name);
        let deltas: Vec<_> = requirement
            .changes
            .iter()
            .filter_map(|name| {
                let (directory, archived) = change(name);
                let text = fs::read_to_string(directory.join(requirement.delta)).ok()?;
                Some((
                    *name,
                    directory,
                    archived,
                    items_of(requirement, &body(&text, requirement.name)?),
                ))
            })
            .collect();
        assert_eq!(
            deltas.len(),
            requirement.changes.len(),
            "{}: every listed change modifies the requirement",
            requirement.name
        );
        for (name, _, archived, delta) in &deltas {
            if *archived {
                // The archive kept everything the change added.
                let missing = lost(delta, &main);
                assert!(
                    missing.is_empty(),
                    "{}: main spec lost {name}'s {missing:?}",
                    requirement.name
                );
            } else {
                // An active change carries what earlier archives put in the main spec.
                let missing = lost(&main, delta);
                assert!(
                    missing.is_empty(),
                    "{}: {name} would drop {missing:?} from the main spec",
                    requirement.name
                );
            }
        }
        // Each later active change carries every earlier change's additions.
        for (i, (earlier, _, _, early)) in deltas.iter().enumerate() {
            for (later, directory, archived, late) in &deltas[i + 1..] {
                if *archived {
                    continue;
                }
                let missing = lost(early, late);
                if missing.is_empty() {
                    continue;
                }
                assert!(
                    composition_task_open(directory),
                    "{}: {later} archives after {earlier} but drops {missing:?}",
                    requirement.name
                );
                pending.push(format!(
                    "{}: {later} must still carry {earlier}'s {missing:?}",
                    requirement.name
                ));
            }
        }
        assert!(
            sequence.contains(&format!("/ {} |", requirement.name)),
            "{} is not in the overlap table of docs/v0.3-sequence.md",
            requirement.name
        );
    }
    // Open gaps are owned by the later change's composition task; print them so
    // the task's implementer sees exactly what to carry.
    for line in pending {
        eprintln!("pending composition: {line}");
    }
}

#[path = "../../rio-adapters/tests/common/mod.rs"]
mod common;
use common::*;
use rio_git::{Tree, diff};
use rio_graph::*;

fn graph(base: Tree, head: Tree, options: GraphOptions) -> GraphSlices {
    let changes = changes(base, head);
    let diff = diff(&changes, &options.exclude).unwrap();
    GraphBuilder::default()
        .build(&changes, &diff, &options)
        .unwrap()
}
fn example() -> (Tree, Tree) {
    let base:Tree=[
        ("src/math.ts".into(),entry("export function format(value: number) {\n  return value.toFixed(1);\n}\n")),
        ("src/caller.ts".into(),entry("import {format as render} from './math';\nexport function caller() { return render(1); }\n")),
        ("src/outer.ts".into(),entry("import {caller} from './caller';\nexport function outer() { return caller(); }\n")),
        ("tests/math.test.ts".into(),entry("import {format} from '../src/math';\nexport function test_format() { return format(1); }\n")),
        ("src/comments.ts".into(),entry("// format(1)\nconst text = 'format(1)';\n")),
        ("src/shadow.ts".into(),entry("export function shadow(format: () => string) { return format(); }\n")),
        ("ignored/consumer.ts".into(),entry("format(1);\n")),
        (".gitignore".into(),entry("ignored/\n")),
    ].into();
    let mut head = base.clone();
    head.insert(
        "src/math.ts".into(),
        entry("export function format(value: number) {\n  return value.toFixed(2);\n}\n"),
    );
    (base, head)
}

#[test]
fn imports_aliases_scope_filtering_two_hop_expansion_and_test_references() {
    let (base, head) = example();
    let slices = graph(base, head, GraphOptions::default());
    let nodes = &slices.head.nodes;
    assert!(
        nodes
            .iter()
            .any(|node| node.symbol_path == "math.format" && node.seed)
    );
    assert!(
        nodes
            .iter()
            .any(|node| node.symbol_path == "caller.caller" && node.hop == 1)
    );
    assert!(
        nodes
            .iter()
            .any(|node| node.symbol_path == "outer.outer" && node.hop == 2)
    );
    assert!(nodes.iter().any(|node| node.kind == NodeKind::Test));
    assert!(!nodes.iter().any(|node| node.path.contains("comments")
        || node.path.contains("shadow")
        || node.path.starts_with("ignored/")));
    assert!(
        slices
            .head
            .edges
            .iter()
            .all(|edge| edge.confidence == Confidence::Resolved)
    );
    assert!(
        slices
            .head
            .edges
            .iter()
            .any(|edge| edge.kind == EdgeKind::Tests)
    );
    assert_eq!(slices.delta.changed, ["src/math.ts::math.format"]);
    let impact = slices.impact(2);
    let symbol = impact
        .symbols
        .iter()
        .find(|symbol| symbol.symbol_path == "math.format")
        .unwrap();
    assert_eq!(symbol.references_per_hop, [2, 1]);
    assert!(symbol.test_referenced);
    assert_eq!(symbol.unresolved, 0);
    insta::assert_json_snapshot!("base_slice", slices.base);
    insta::assert_json_snapshot!("head_slice", slices.head);
    insta::assert_json_snapshot!("delta_slice", slices.delta);
    let run = tempfile::tempdir().unwrap();
    slices.write(run.path()).unwrap();
    assert_eq!(
        serde_json::from_slice::<GraphSlice>(
            &std::fs::read(run.path().join("graph/head.json")).unwrap()
        )
        .unwrap(),
        slices.head
    );
}

#[test]
fn deleted_symbols_stay_in_base_file_level_seeds_and_node_caps_are_explicit() {
    let base: Tree = [(
        "a.py".into(),
        entry("def deleted():\n    return 1\n\ndef kept():\n    return 2\n"),
    )]
    .into();
    let head: Tree = [
        ("a.py".into(), entry("def kept():\n    return 2\n")),
        ("notes.ts".into(), entry("// outside any symbol\n")),
    ]
    .into();
    let slices = graph(base, head, GraphOptions::default());
    assert!(
        slices
            .base
            .nodes
            .iter()
            .any(|node| node.symbol_path == "a.deleted" && node.seed)
    );
    assert!(
        !slices
            .head
            .nodes
            .iter()
            .any(|node| node.symbol_path == "a.deleted")
    );
    assert!(slices.delta.removed.contains(&"a.py::a.deleted".into()));
    assert!(
        slices
            .head
            .nodes
            .iter()
            .any(|node| node.path == "notes.ts" && node.kind == NodeKind::File && node.seed)
    );
    let (base, head) = example();
    let slices = graph(
        base,
        head,
        GraphOptions {
            max_nodes: 1,
            ..Default::default()
        },
    );
    assert!(slices.head.truncated);
    assert_eq!(slices.head.nodes.len(), 1);
    assert!(slices.impact(2).truncated);
}

#[test]
fn python_relative_imports_typescript_path_mappings_and_unresolved_confidence() {
    let base:Tree=[
        ("pkg/math.py".into(),entry("def format_value(value):\n    return value\n")),
        ("pkg/caller.py".into(),entry("from .math import format_value as render\ndef caller():\n    return render(1)\n")),
        ("src/math.ts".into(),entry("export function calculate() { return 1; }\n")),
        ("src/caller.ts".into(),entry("import {calculate} from '@lib/math';\nexport function caller() {return calculate();}\n")),
        ("src/uncertain.ts".into(),entry("import {calculate} from 'unavailable';\nexport function uncertain() {return calculate();}\n")),
        ("tsconfig.json".into(),entry("{ // JSONC\n compilerOptions:{baseUrl:'.',paths:{'@lib/*':['src/*']}}, }")),
    ].into();
    let mut head = base.clone();
    head.get_mut("pkg/math.py").unwrap().content =
        b"def format_value(value):\n    return value + 1\n".to_vec();
    head.get_mut("src/math.ts").unwrap().content =
        b"export function calculate() { return 2; }\n".to_vec();
    let slices = graph(base, head, GraphOptions::default());
    for path in ["pkg/caller.py", "src/caller.ts"] {
        let node = slices
            .head
            .nodes
            .iter()
            .find(|node| node.path == path)
            .unwrap();
        assert!(
            slices
                .head
                .edges
                .iter()
                .any(|edge| edge.from == node.id && edge.confidence == Confidence::Resolved)
        );
    }
    assert!(
        slices
            .head
            .edges
            .iter()
            .any(|edge| edge.confidence == Confidence::Unresolved)
    );
    assert!(slices.impact(2).unresolved > 0);
}

#[test]
fn real_fixture_diffs_seed_both_languages_with_nested_symbol_paths() {
    for (name, path) in [
        ("ts-sample", "src/math.ts"),
        ("py-sample", "src/sample/math.py"),
    ] {
        let base = read_tree(&fixture(name));
        let mut head = base.clone();
        head.get_mut(path).unwrap().content = String::from_utf8(head[path].content.clone())
            .unwrap()
            .replace("toFixed(2)", "toFixed(3)")
            .replace(".2f", ".3f")
            .into_bytes();
        let slices = graph(base, head, GraphOptions::default());
        assert!(!slices.base.nodes.is_empty());
        assert!(!slices.head.nodes.is_empty());
    }
}

#[test]
fn unrelated_unresolved_default_and_namespace_imports_do_not_connect_every_symbol() {
    let (mut base, mut head) = example();
    let source = entry(
        "import unrelated from 'external-package';\nimport * as external from 'another-package';\nexport function consumer() { unrelated(); external.call(); }\n",
    );
    base.insert("src/external.ts".into(), source.clone());
    head.insert("src/external.ts".into(), source);
    let slices = graph(base, head, GraphOptions::default());
    assert!(
        !slices
            .head
            .nodes
            .iter()
            .any(|node| node.path == "src/external.ts")
    );
}

#[test]
fn rust_module_imports_workspace_crates_macros_and_inline_tests_resolve() {
    let mut base = read_tree(&fixture("rs-sample"));
    base.get_mut("core/src/lib.rs")
        .unwrap()
        .content
        .extend_from_slice(b"\npub mod util;\n");
    base.insert("core/src/util.rs".into(),entry("pub fn helper() -> u32 {\n    1\n}\n\n#[cfg(test)]\nmod tests {\n    use super::helper;\n    #[test]\n    fn calls_helper() { assert_eq!(helper(), 1); }\n}\n"));
    base.insert(
        "core/src/nested/mod.rs".into(),
        entry("use super::util::helper;\npub fn nested_call() { helper(); }\n"),
    );
    base.get_mut("core/src/lib.rs").unwrap().content.extend_from_slice(b"pub mod nested;\nmacro_rules! greeting { () => { println!(\"hi\"); } }\npub fn invokes_macro() { greeting!(); }\n");
    base.insert(
        "cli/src/main.rs".into(),
        entry(
            "use sample_core::util::helper as render;\nfn main() { println!(\"{}\", render()); }\n",
        ),
    );
    let mut head = base.clone();
    head.insert("core/src/util.rs".into(),entry("pub fn helper() -> u32 {\n    2\n}\n\n#[cfg(test)]\nmod tests {\n    use super::helper;\n    #[test]\n    fn calls_helper() { assert_eq!(helper(), 1); }\n}\n"));
    let slices = graph(base, head, GraphOptions::default());
    let seed = slices
        .head
        .nodes
        .iter()
        .find(|node| node.name == "helper" && node.seed)
        .unwrap();
    let incoming: Vec<_> = slices
        .head
        .edges
        .iter()
        .filter(|edge| edge.to == seed.id)
        .collect();
    assert!(
        incoming
            .iter()
            .any(|edge| edge.kind == EdgeKind::Tests && edge.confidence == Confidence::Resolved),
        "{incoming:?}"
    );
    assert!(incoming.iter().any(|edge| {
        edge.confidence == Confidence::Resolved
            && slices
                .head
                .nodes
                .iter()
                .find(|node| node.id == edge.from)
                .unwrap()
                .path
                == "cli/src/main.rs"
    }));
    insta::assert_json_snapshot!("rust_impact", slices.head);
}

#[test]
fn rust_macro_invocations_are_references_and_grouped_imports_resolve() {
    let base: Tree = [
        ("Cargo.toml".into(), entry("[package]\nname = 'macro-sample'\nversion = '0.1.0'\n")),
        ("src/lib.rs".into(), entry("pub mod util;\nmacro_rules! greeting { () => { 1 } }\npub fn invoke() {\n    let _ = greeting!();\n}\nuse crate::{util::{helper as render}};\npub fn grouped() { render(); }\nuse crate::missing::greeting as unknown;\npub fn unresolved() { unknown!(); }\n")),
        ("src/util.rs".into(), entry("pub fn helper() {\n    println!(\"hello\");\n}\n")),
    ].into();
    let mut head = base.clone();
    head.insert(
        "src/lib.rs".into(),
        entry(
            &String::from_utf8(base["src/lib.rs"].content.clone())
                .unwrap()
                .replace("() => { 1 }", "() => { 2 }"),
        ),
    );
    head.insert(
        "src/util.rs".into(),
        entry("pub fn helper() {\n    println!(\"new\");\n}\n"),
    );
    let slices = graph(base, head, GraphOptions::default());
    for (from, to) in [("invoke", "greeting"), ("grouped", "helper")] {
        let from = slices
            .head
            .nodes
            .iter()
            .find(|node| node.name == from)
            .unwrap();
        let to = slices
            .head
            .nodes
            .iter()
            .find(|node| node.name == to)
            .unwrap();
        assert!(
            slices.head.edges.iter().any(|edge| edge.from == from.id
                && edge.to == to.id
                && edge.confidence == Confidence::Resolved),
            "{slices:#?}"
        );
    }
    assert!(!slices.head.edges.iter().any(|edge| {
        edge.confidence == Confidence::Resolved
            && slices
                .head
                .nodes
                .iter()
                .any(|node| node.id == edge.from && node.name == "unresolved")
    }));
}

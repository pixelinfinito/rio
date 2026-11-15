#[path = "../../rio-adapters/tests/common/mod.rs"]
mod common;
use common::*;
use rio_git::{Tree, diff};
use rio_graph::*;

fn graph(base: Tree, head: Tree, options: GraphOptions) -> GraphSlices {
    let changes = changes(base, head);
    let diff = diff(&changes, &options.exclude).unwrap();
    build_graph(&changes, &diff, &options)
}
fn build_graph(
    changes: &rio_git::ChangeSet,
    diff: &rio_git::Diff,
    options: &GraphOptions,
) -> GraphSlices {
    GraphBuilder::default()
        .build(changes, diff, options)
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
fn deleting_a_guard_keeps_the_surviving_symbol_in_both_graphs() {
    let base = [("a.py".into(), entry("def average(total, count):\n    if count == 0:\n        return 0\n    return total / count\n"))].into();
    let head = [(
        "a.py".into(),
        entry("def average(total, count):\n    return total / count\n"),
    )]
    .into();
    let slices = graph(base, head, GraphOptions::default());
    for slice in [&slices.base, &slices.head] {
        assert!(
            slice
                .nodes
                .iter()
                .any(|n| n.symbol_path == "a.average" && n.seed)
        );
    }
    assert_eq!(slices.delta.changed, ["a.py::a.average"]);
    assert!(slices.delta.added.is_empty() && slices.delta.removed.is_empty());
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

#[test]
fn renames_across_languages_with_pure_hunks_seed_the_file() {
    let lines: String = (0..30).map(|n| format!("value_{n} = {n}\n")).collect();
    let base: Tree = [("a.py".into(), entry(&lines))].into();
    let head: Tree = [("a.txt".into(), entry(&format!("{lines}extra = 1\n")))].into();
    let options = GraphOptions::default();
    let changes = changes(base, head);
    let delta = diff(&changes, &options.exclude).unwrap();
    let file = &delta.files[0];
    assert_eq!(file.old_path.as_deref(), Some("a.py"));
    assert!(file.hunks.iter().any(|hunk| hunk.base.count == 0));
    let slices = build_graph(&changes, &delta, &options);
    assert!(slices.base.nodes.iter().any(|n| n.path == "a.py" && n.seed));
}

#[test]
fn inserted_nested_symbols_seed_their_nearest_shared_ancestor() {
    let base: Tree = [(
        "a.py".into(),
        entry("class Foo:\n    def first(self):\n        return 1\n\n\ndef caller():\n    return Foo()\n"),
    )]
    .into();
    let head: Tree = [(
        "a.py".into(),
        entry("class Foo:\n    def first(self):\n        return 1\n\n    def second(self):\n        return 2\n\n\ndef caller():\n    return Foo()\n"),
    )]
    .into();
    let slices = graph(base, head, GraphOptions::default());
    assert!(
        slices
            .base
            .nodes
            .iter()
            .any(|n| n.symbol_path == "a.Foo" && n.seed)
    );
}

#[test]
fn nested_gitignore_re_include_rules_apply_in_depth_order() {
    let base: Tree = [
        (".gitignore".into(), entry("gen/\n*.log\n")),
        ("gen/.gitignore".into(), entry("!keep.ts\n")),
        ("src/core.ts".into(), entry("export function core() {\n  return 1;\n}\n")),
        ("gen/keep.ts".into(), entry("import {core} from '../src/core';\nexport function kept() { return core(); }\n")),
        ("gen/other.ts".into(), entry("import {core} from '../src/core';\nexport function dropped() { return core(); }\n")),
        ("deep/a/.gitignore".into(), entry("skip.ts\n")),
        ("deep/a/skip.ts".into(), entry("import {core} from '../../src/core';\nexport function skipped() { return core(); }\n")),
        ("deep/a/use.ts".into(), entry("import {core} from '../../src/core';\nexport function used() { return core(); }\n")),
    ]
    .into();
    let mut head = base.clone();
    head.insert(
        "src/core.ts".into(),
        entry("export function core() {\n  return 2;\n}\n"),
    );
    let slices = graph(base, head, GraphOptions::default());
    let paths: Vec<_> = slices.head.nodes.iter().map(|n| n.path.as_str()).collect();
    assert!(paths.contains(&"gen/keep.ts"));
    assert!(paths.contains(&"deep/a/use.ts"));
    assert!(!paths.contains(&"gen/other.ts"));
    assert!(!paths.contains(&"deep/a/skip.ts"));
}

/// A repository of `files` TypeScript and Python files around a changed `args`
/// module: aliased and plain imports, chained callers, test files, look-alike
/// names (`myargs`, `parse_args`) and mentions in comments and strings.
pub fn generated(files: usize) -> (Tree, Tree) {
    let mut base = Tree::new();
    base.insert(
        "src/args.ts".into(),
        entry("export function args(x: number) {\n  return x + 1;\n}\nexport function other() { return 0; }\n"),
    );
    base.insert(
        "pkg/args.py".into(),
        entry("def parse_args(value):\n    return value\n"),
    );
    base.insert(".gitignore".into(), entry("vendor/\n"));
    for i in 0..files {
        let (path, content) = match i % 8 {
            0 => (
                format!("src/m{i}.ts"),
                format!(
                    "import {{args as a{i}}} from './args';\nexport function f{i}() {{ return a{i}({i}); }}\n"
                ),
            ),
            1 => (
                format!("src/m{i}.ts"),
                format!(
                    "import {{f{}}} from './m{}';\nexport function g{i}() {{ return f{}(); }}\n",
                    i - 1,
                    i - 1,
                    i - 1
                ),
            ),
            2 => (
                format!("tests/m{i}.test.ts"),
                format!(
                    "import {{args}} from '../src/args';\nexport function test_{i}() {{ return args({i}); }}\n"
                ),
            ),
            3 => (
                format!("src/m{i}.ts"),
                format!(
                    "// args({i}) in a comment\nconst myargs{i} = 'args({i})';\nexport function h{i}() {{ return myargs{i}; }}\n"
                ),
            ),
            4 => (
                format!("pkg/m{i}.py"),
                format!(
                    "from pkg.args import parse_args\n\ndef p{i}():\n    return parse_args({i})\n"
                ),
            ),
            5 => (
                format!("pkg/m{i}.py"),
                format!(
                    "from .args import parse_args as pa{i}\n\ndef q{i}():\n    return pa{i}({i})\n"
                ),
            ),
            6 => (
                format!("vendor/m{i}.ts"),
                format!(
                    "import {{args}} from '../src/args';\nexport function v{i}() {{ return args(1); }}\n"
                ),
            ),
            _ => (
                format!("src/sub{}/m{i}.ts", i % 13),
                format!(
                    "import * as all{i} from '../args';\nexport function s{i}() {{ return all{i}.args(2); }}\n"
                ),
            ),
        };
        base.insert(path, entry(&content));
    }
    let mut head = base.clone();
    head.insert(
        "src/args.ts".into(),
        entry("export function args(x: number) {\n  return x + 2;\n}\nexport function other() { return 0; }\n"),
    );
    head.insert(
        "pkg/args.py".into(),
        entry("def parse_args(value):\n    return value * 2\n"),
    );
    (base, head)
}

#[test]
fn generated_repository_builds_a_large_two_hop_graph() {
    let (base, head) = generated(2000);
    let slices = graph(base, head, GraphOptions::default());
    assert!(
        slices.head.nodes.len() > 1000,
        "{}",
        slices.head.nodes.len()
    );
    assert!(slices.head.edges.iter().any(|e| e.kind == EdgeKind::Tests));
}

#[test]
fn parsing_threads_do_not_change_the_slices() {
    let (base, head) = generated(2000);
    let changes = changes(base, head);
    let options = GraphOptions::default();
    let delta = diff(&changes, &options.exclude).unwrap();
    let build = |threads| {
        let builder = GraphBuilder {
            threads: Some(threads),
            ..GraphBuilder::default()
        };
        let graph = builder.build(&changes, &delta, &options).unwrap();
        (
            serde_json::to_string(&graph).unwrap(),
            builder.syntax.parsed(),
        )
    };
    let (one, parsed_one) = build(1);
    let (eight, parsed_eight) = build(8);
    assert_eq!(one, eight);
    assert_eq!(parsed_one, parsed_eight);
}

#[test]
fn bounding_keeps_the_nodes_nearest_the_change_within_the_byte_budget() {
    let (base, head) = example();
    let full = graph(base, head, GraphOptions::default());
    let mut unchanged = full.clone();
    assert!(!unchanged.bound(usize::MAX));
    assert_eq!(unchanged, full);
    let mut bounded = full.clone();
    let budget = serde_json::to_vec(&full.head).unwrap().len() / 2;
    assert!(bounded.bound(budget));
    assert!(bounded.head.truncated);
    assert!(serde_json::to_vec(&bounded.head).unwrap().len() <= budget);
    assert!(bounded.head.nodes.len() < full.head.nodes.len());
    // Seeds survive, farther hops go first, and no edge dangles.
    assert!(
        bounded
            .head
            .nodes
            .iter()
            .all(|node| node.seed || node.hop <= 1)
    );
    assert!(bounded.head.nodes.iter().any(|node| node.seed));
    let kept: std::collections::BTreeSet<_> =
        bounded.head.nodes.iter().map(|n| n.id.as_str()).collect();
    assert!(
        bounded
            .head
            .edges
            .iter()
            .all(|e| kept.contains(e.from.as_str()) && kept.contains(e.to.as_str()))
    );
    // The original order is preserved.
    let order: Vec<_> = full
        .head
        .nodes
        .iter()
        .filter(|n| kept.contains(n.id.as_str()))
        .map(|n| &n.id)
        .collect();
    assert_eq!(
        bounded.head.nodes.iter().map(|n| &n.id).collect::<Vec<_>>(),
        order
    );
    // A budget below a single node leaves an empty, truncated slice.
    let mut empty = full.clone();
    assert!(empty.bound(1));
    assert!(empty.head.nodes.is_empty() && empty.head.truncated);
}
#[test]
fn a_deadline_during_indexing_truncates_instead_of_expanding() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let (base, head) = example();
    let changes = changes(base, head);
    let options = GraphOptions::default();
    let delta = diff(&changes, &options.exclude).unwrap();
    // True from the third check on: the base slice seeds its one changed file
    // (first check), indexes one candidate (second) and stops before the next.
    let calls = AtomicUsize::new(0);
    let stop = || calls.fetch_add(1, Ordering::Relaxed) >= 2;
    let slices = GraphBuilder::default()
        .build_until(&changes, &delta, &options, &stop)
        .unwrap();
    assert!(slices.base.truncated && slices.head.truncated);
    // Seeds only: nothing referencing `format` was expanded from a partial index.
    assert!(!slices.base.nodes.is_empty());
    assert!(slices.base.nodes.iter().all(|n| n.seed));
    assert!(slices.base.edges.is_empty());
}
#[test]
fn a_deadline_inside_one_file_truncates_instead_of_overrunning() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let wide = |body: u32| {
        entry(
            &(0..4000)
                .map(|i| {
                    let argument = if i == 0 { body } else { 0 };
                    format!("export function value{i}() {{ return other{i}({argument}); }}\n")
                })
                .collect::<String>(),
        )
    };
    let base: Tree = [("src/wide.ts".to_owned(), wide(1))].into();
    let head: Tree = [("src/wide.ts".to_owned(), wide(2))].into();
    let changes = changes(base, head);
    let options = GraphOptions::default();
    let delta = diff(&changes, &options.exclude).unwrap();
    let complete = build_graph(&changes, &delta, &options);
    assert!(!complete.head.truncated && !complete.head.nodes.is_empty());
    // How often an unhurried build asks: far more than once per file, so the
    // deadline is seen inside the one file rather than only after it.
    let calls = AtomicUsize::new(0);
    let count = || {
        calls.fetch_add(1, Ordering::Relaxed);
        false
    };
    GraphBuilder::default()
        .build_until(&changes, &delta, &options, &count)
        .unwrap();
    assert!(calls.load(Ordering::Relaxed) > 16);
    // True from the second check on: the first lets the changed file start, the
    // rest arrive while it is being parsed.
    let calls = AtomicUsize::new(0);
    let stop = || calls.fetch_add(1, Ordering::Relaxed) >= 1;
    let slices = GraphBuilder::default()
        .build_until(&changes, &delta, &options, &stop)
        .unwrap();
    assert!(slices.base.truncated && slices.head.truncated);
    assert!(slices.base.nodes.is_empty() && slices.head.nodes.is_empty());
    // The builder stopped asking almost at once instead of finishing the file.
    assert!(calls.load(Ordering::Relaxed) < 16);
}

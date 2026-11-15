mod common;
use rio_adapters::*;

#[test]
fn symbols_have_nested_paths_and_only_runtime_statements_are_executable() {
    let source = b"export interface User {name: string}\nexport type Id = string;\nexport class Order {\n  save() {\n    // no runtime statement on this line\n    return 42;\n  }\n}\n";
    let table = analyze_source("src/order.ts", source).unwrap();
    assert!(!table.parse_errors);
    let save = table
        .symbols
        .iter()
        .find(|symbol| symbol.name == "save")
        .unwrap();
    assert_eq!(save.symbol_path, "order.Order.save");
    assert_eq!(save.kind, SymbolKind::Method);
    assert_eq!(table.enclosing(6).unwrap().name, "save");
    assert!(!table.executable_lines.contains(&1));
    assert!(!table.executable_lines.contains(&2));
    assert!(!table.executable_lines.contains(&5));
    assert!(table.executable_lines.contains(&6));
    assert!(
        analyze_source("src/stub.d.ts", b"declare function run(): number;")
            .unwrap()
            .executable_lines
            .is_empty()
    );
    assert!(
        analyze_source("src/stub.pyi", b"def run() -> int: ...")
            .unwrap()
            .executable_lines
            .is_empty()
    );
}

#[test]
fn python_methods_nested_functions_and_module_assignments_are_parsed() {
    let table = analyze_source("pkg/order.py", b"VALUE = 1\nclass Order:\n    def save(self):\n        def nested():\n            return 1\n        # ignored\n        return nested()\n").unwrap();
    assert!(!table.parse_errors);
    assert!(
        table
            .symbols
            .iter()
            .any(|symbol| symbol.symbol_path == "order.VALUE")
    );
    assert!(table.symbols.iter().any(
        |symbol| symbol.symbol_path == "order.Order.save" && symbol.kind == SymbolKind::Method
    ));
    assert!(
        table
            .symbols
            .iter()
            .any(|symbol| symbol.symbol_path == "order.Order.save.nested")
    );
    assert!(!table.executable_lines.contains(&6));
}

#[test]
fn references_ignore_strings_comments_and_declaration_names_but_keep_import_aliases() {
    let table = analyze_source("caller.ts", b"import {save as persist} from './order';\n// persist()\nconst message = 'persist()';\nexport function caller() { return persist(); }\n").unwrap();
    assert_eq!(
        table
            .identifiers
            .iter()
            .filter(|identifier| identifier.name == "persist")
            .count(),
        1
    );
    assert_eq!(table.imports[0].module, "./order");
    assert_eq!(table.imports[0].names["persist"], "save");
    assert!(
        !table
            .identifiers
            .iter()
            .any(|identifier| identifier.name == "caller")
    );
    let table = analyze_source("caller.py", b"from pkg.order import save as persist\nimport pkg.other as other\ndef caller():\n    return persist()\n").unwrap();
    assert_eq!(table.imports.len(), 2);
    assert_eq!(table.imports[0].names["persist"], "save");
    assert_eq!(table.imports[1].module, "pkg.other");
}

#[test]
fn fixture_symbol_tables_are_stable_across_cached_reads() {
    let cache = SyntaxCache::default();
    for (fixture, path) in [
        ("ts-sample", "src/math.ts"),
        ("py-sample", "src/sample/math.py"),
    ] {
        let source = std::fs::read(common::fixture(fixture).join(path)).unwrap();
        let table = cache.analyze(path, &source).unwrap();
        assert_eq!(table, cache.analyze(path, &source).unwrap());
        assert_eq!(table.symbols.len(), 1);
        assert!(!table.executable_lines.is_empty());
        insta::assert_json_snapshot!(format!("symbols_{fixture}"), table.symbols);
    }
}

#[test]
fn xml_named_like_typescript_is_not_analyzed_as_code() {
    // Qt Linguist translations are XML files with a `.ts` extension.
    let qt = "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<!DOCTYPE TS>\n<TS version=\"2.1\" language=\"de\">\n<context>\n    <name>App</name>\n    <message>\n        <source>Open</source>\n        <translation>format(1)</translation>\n    </message>\n</context>\n</TS>\n";
    for source in [
        qt.to_owned(),
        format!("\u{feff}\n  {qt}"),
        qt.replacen("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n", "", 1),
    ] {
        assert!(is_markup(source.as_bytes()));
        let table = analyze_source("i18n/App_de.ts", source.as_bytes()).unwrap();
        assert!(table.parse_errors);
        assert!(table.symbols.is_empty() && table.identifiers.is_empty());
        assert!(table.imports.is_empty() && table.executable_lines.is_empty());
    }
    // Code that merely starts with an angle bracket is still code.
    let generic = b"<T>(value: T) => value;\nexport function id() { return 1; }\n";
    assert!(!is_markup(generic));
    assert_eq!(
        analyze_source("src/id.ts", generic).unwrap().symbols.len(),
        1
    );
    // The path still has to name a supported language.
    assert!(analyze_source("i18n/App_de.xml", qt.as_bytes()).is_err());
}

#[test]
fn an_interrupted_analysis_gives_nothing_instead_of_a_partial_table() {
    use std::cell::Cell;
    let lines = 4000;
    let sources = [
        (
            "src/wide.ts",
            (0..lines)
                .map(|i| {
                    format!(
                        "export function value{i}(input: number) {{ return other{i}(input); }}\n"
                    )
                })
                .collect::<String>(),
        ),
        (
            "pkg/wide.py",
            (0..lines)
                .map(|i| format!("def value{i}(input):\n    return other{i}(input)\n"))
                .collect::<String>(),
        ),
        (
            "src/wide.rs",
            (0..lines)
                .map(|i| format!("pub fn value{i}(input: u32) -> u32 {{ other{i}(input) }}\n"))
                .collect::<String>(),
        ),
    ];
    for (path, source) in &sources {
        let full = analyze_source(path, source.as_bytes()).unwrap();
        assert_eq!(full.symbols.len(), lines);
        let calls = Cell::new(0usize);
        let count = || {
            calls.set(calls.get() + 1);
            false
        };
        assert_eq!(
            analyze_source_until(path, source.as_bytes(), &count).unwrap(),
            Some(full.clone())
        );
        // The deadline is asked during the parse and during every later walk.
        let asked = calls.get();
        assert!(asked >= 8, "{path}: asked {asked} times");
        // Stopping at any of those points ends the analysis without a table.
        for limit in (0..16).map(|step| step * (asked - 1) / 15) {
            let calls = Cell::new(0usize);
            let stop = || {
                calls.set(calls.get() + 1);
                calls.get() > limit
            };
            assert_eq!(
                analyze_source_until(path, source.as_bytes(), &stop).unwrap(),
                None,
                "{path}: stopped at check {limit} of {asked}"
            );
            // It also ends promptly: at most one more question after the yes.
            assert!(calls.get() <= limit + 2, "{path}: {} checks", calls.get());
        }
        // A file the cache gave up on is analyzed again in full later.
        let cache = SyntaxCache::default();
        assert_eq!(
            cache
                .analyze_until(path, source.as_bytes(), &|| true)
                .unwrap(),
            None
        );
        assert_eq!(cache.analyze(path, source.as_bytes()).unwrap(), full);
    }
}

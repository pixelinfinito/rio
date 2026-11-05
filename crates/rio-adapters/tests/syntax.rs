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

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Mutex,
};
use streaming_iterator::StreamingIterator;
use tree_sitter::{Language, Node, Parser, Query, QueryCursor};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SymbolKind {
    File,
    Function,
    Method,
    Class,
    Interface,
    TypeAlias,
    Enum,
    Variable,
    Test,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Symbol {
    pub name: String,
    pub symbol_path: String,
    pub kind: SymbolKind,
    pub line_start: u32,
    pub line_end: u32,
    pub byte_start: usize,
    pub byte_end: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Identifier {
    pub name: String,
    pub line: u32,
    pub byte_start: usize,
    pub byte_end: usize,
    pub call: bool,
    pub shadowed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Import {
    pub module: String,
    /// Local name -> imported name (`*` for a namespace import).
    pub names: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyntaxTable {
    pub symbols: Vec<Symbol>,
    pub identifiers: Vec<Identifier>,
    pub imports: Vec<Import>,
    pub executable_lines: BTreeSet<u32>,
    pub parse_errors: bool,
}

impl SyntaxTable {
    pub fn enclosing_byte(&self, byte: usize) -> Option<&Symbol> {
        self.symbols
            .iter()
            .filter(|symbol| symbol.byte_start <= byte && byte < symbol.byte_end)
            .min_by_key(|symbol| symbol.byte_end - symbol.byte_start)
    }
    pub fn enclosing(&self, line: u32) -> Option<&Symbol> {
        self.symbols
            .iter()
            .filter(|symbol| symbol.line_start <= line && line <= symbol.line_end)
            .min_by_key(|symbol| symbol.byte_end - symbol.byte_start)
    }
}

pub fn syntax_language(path: &str) -> Result<Language> {
    Ok(match crate::language_for_path(path) {
        Some("python") => tree_sitter_python::LANGUAGE.into(),
        Some("rust") => tree_sitter_rust::LANGUAGE.into(),
        Some("typescript") if path.ends_with(".tsx") || path.ends_with(".jsx") => {
            tree_sitter_typescript::LANGUAGE_TSX.into()
        }
        Some("typescript") => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        _ => bail!("unsupported source file {path}"),
    })
}

pub fn parse_source(path: &str, source: &[u8]) -> Result<tree_sitter::Tree> {
    let mut parser = Parser::new();
    parser.set_language(&syntax_language(path)?)?;
    parser
        .parse(source, None)
        .context("parser did not return a tree")
}

fn text<'a>(node: Node<'_>, source: &'a [u8]) -> &'a str {
    std::str::from_utf8(&source[node.byte_range()]).unwrap_or_default()
}

fn ignored_type(node: Node<'_>) -> bool {
    matches!(
        node.kind(),
        "ambient_declaration"
            | "interface_declaration"
            | "type_alias_declaration"
            | "type_annotation"
            | "type_arguments"
            | "type_parameters"
    )
}

fn executable_tokens(node: Node<'_>, source: &[u8], lines: &mut BTreeSet<u32>) {
    if ignored_type(node) || node.kind().contains("comment") {
        return;
    }
    if node.child_count() == 0 {
        let value = text(node, source).trim();
        if !value.is_empty() && !matches!(value, "{" | "}" | ";" | "," | ":" | "(" | ")") {
            lines.insert(node.start_position().row as u32 + 1);
        }
    } else {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            executable_tokens(child, source, lines);
        }
    }
}

fn inside_type(mut node: Node<'_>) -> bool {
    loop {
        if ignored_type(node) {
            return true;
        }
        match node.parent() {
            Some(parent) => node = parent,
            None => return false,
        }
    }
}

fn symbol_kind(node: Node<'_>) -> SymbolKind {
    match node.kind() {
        "function_declaration" | "generator_function_declaration" | "function_definition" => {
            if node.parent().is_some_and(|parent| {
                parent.kind() == "block"
                    && parent
                        .parent()
                        .is_some_and(|parent| parent.kind() == "class_definition")
            }) {
                SymbolKind::Method
            } else {
                SymbolKind::Function
            }
        }
        "method_definition" => SymbolKind::Method,
        "class_declaration" | "class_definition" => SymbolKind::Class,
        "interface_declaration" => SymbolKind::Interface,
        "type_alias_declaration" => SymbolKind::TypeAlias,
        "enum_declaration" => SymbolKind::Enum,
        "variable_declarator" => {
            if node.child_by_field_name("value").is_some_and(|value| {
                matches!(value.kind(), "arrow_function" | "function_expression")
            }) {
                SymbolKind::Function
            } else {
                SymbolKind::Variable
            }
        }
        _ => SymbolKind::Variable,
    }
}

fn declaration_ancestor(node: Node<'_>) -> bool {
    matches!(
        node.kind(),
        "function_declaration"
            | "generator_function_declaration"
            | "function_definition"
            | "method_definition"
            | "class_declaration"
            | "class_definition"
            | "interface_declaration"
            | "enum_declaration"
    ) || node.kind() == "variable_declarator"
        && node
            .child_by_field_name("value")
            .is_some_and(|value| matches!(value.kind(), "arrow_function" | "function_expression"))
}

fn unquote(value: &str) -> String {
    value.trim_matches(['\'', '"']).to_owned()
}

fn collect_import(node: Node<'_>, source: &[u8], imports: &mut Vec<Import>) {
    if node.kind() == "import_statement"
        && let Some(module) = node.child_by_field_name("source")
    {
        let mut import = Import {
            module: unquote(text(module, source)),
            names: BTreeMap::new(),
        };
        fn names(node: Node<'_>, source: &[u8], result: &mut BTreeMap<String, String>) {
            if node.kind() == "import_specifier" {
                if let Some(name) = node.child_by_field_name("name") {
                    let alias = node.child_by_field_name("alias").unwrap_or(name);
                    result.insert(text(alias, source).into(), text(name, source).into());
                }
                return;
            }
            if node.kind() == "namespace_import" {
                let mut cursor = node.walk();
                if let Some(name) = node
                    .named_children(&mut cursor)
                    .find(|child| child.kind() == "identifier")
                {
                    result.insert(text(name, source).into(), "*".into());
                }
                return;
            }
            if node.kind() == "identifier"
                && node
                    .parent()
                    .is_some_and(|parent| parent.kind() == "import_clause")
            {
                result.insert(text(node, source).into(), "default".into());
            }
            let mut cursor = node.walk();
            for child in node.named_children(&mut cursor) {
                names(child, source, result);
            }
        }
        names(node, source, &mut import.names);
        imports.push(import);
    } else if node.kind() == "import_from_statement" {
        let module = node
            .child_by_field_name("module_name")
            .map(|module| text(module, source).to_owned())
            .unwrap_or_default();
        let mut import = Import {
            module,
            names: BTreeMap::new(),
        };
        let mut cursor = node.walk();
        for child in node.named_children(&mut cursor) {
            if child.kind() == "aliased_import" {
                if let Some(name) = child.child_by_field_name("name") {
                    let alias = child.child_by_field_name("alias").unwrap_or(name);
                    import
                        .names
                        .insert(text(alias, source).into(), text(name, source).into());
                }
            } else if child.kind() == "dotted_name"
                && Some(child.id())
                    != node
                        .child_by_field_name("module_name")
                        .map(|node| node.id())
            {
                let name = text(child, source);
                import.names.insert(name.into(), name.into());
            }
        }
        imports.push(import);
    } else if node.kind() == "import_statement" {
        let mut cursor = node.walk();
        for child in node.named_children(&mut cursor) {
            let name = child.child_by_field_name("name").unwrap_or(child);
            let module = text(name, source).to_owned();
            let alias = child
                .child_by_field_name("alias")
                .map(|alias| text(alias, source))
                .unwrap_or_else(|| module.split('.').next().unwrap_or_default());
            imports.push(Import {
                module: module.clone(),
                names: [(alias.into(), "*".into())].into(),
            });
        }
    }
}

fn identifiers(node: Node<'_>, source: &[u8], result: &mut SyntaxTable) {
    if matches!(
        node.kind(),
        "comment" | "string" | "string_fragment" | "template_string"
    ) {
        return;
    }
    if matches!(node.kind(), "import_statement" | "import_from_statement") {
        collect_import(node, source, &mut result.imports);
        return;
    }
    if matches!(
        node.kind(),
        "identifier" | "property_identifier" | "type_identifier"
    ) {
        let parent = node.parent();
        let definition = parent.is_some_and(|parent| {
            (declaration_ancestor(parent)
                || matches!(
                    parent.kind(),
                    "variable_declarator" | "assignment" | "type_alias_declaration"
                ))
                && (parent
                    .child_by_field_name("name")
                    .or_else(|| parent.child_by_field_name("left")))
                .is_some_and(|name| name.id() == node.id())
        });
        if !definition {
            result.identifiers.push(Identifier {
                name: text(node, source).into(),
                line: node.start_position().row as u32 + 1,
                byte_start: node.start_byte(),
                byte_end: node.end_byte(),
                call: parent.is_some_and(|parent| {
                    matches!(
                        parent.kind(),
                        "call_expression" | "call" | "member_expression" | "attribute"
                    )
                }),
                shadowed: parameter_binding(node, source),
            });
        }
    }
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        identifiers(child, source, result);
    }
}

pub(crate) fn parameter_binding(node: Node<'_>, source: &[u8]) -> bool {
    if node.kind() == "property_identifier"
        || node.parent().is_some_and(|parent| {
            parent.kind() == "attribute"
                && parent
                    .child_by_field_name("attribute")
                    .is_some_and(|attribute| attribute.id() == node.id())
        })
    {
        return false;
    }
    fn contains_name(node: Node<'_>, name: &str, source: &[u8]) -> bool {
        if node.kind() == "type_annotation" || node.kind() == "type" {
            return false;
        }
        if node.kind() == "identifier" {
            return text(node, source) == name;
        }
        let binding = node
            .child_by_field_name("pattern")
            .or_else(|| node.child_by_field_name("name"))
            .or_else(|| node.child_by_field_name("left"));
        if let Some(binding) = binding {
            return contains_name(binding, name, source);
        }
        let mut cursor = node.walk();
        node.named_children(&mut cursor)
            .any(|child| contains_name(child, name, source))
    }
    let mut ancestor = node.parent();
    while let Some(parent) = ancestor {
        if let Some(parameters) = parent.child_by_field_name("parameters")
            && contains_name(parameters, text(node, source), source)
        {
            return true;
        }
        ancestor = parent.parent();
    }
    false
}

pub fn analyze_source(path: &str, source: &[u8]) -> Result<SyntaxTable> {
    if crate::language_for_path(path) == Some("rust") {
        return crate::rust_syntax::analyze_rust(path, source);
    }
    let tree = parse_source(path, source)?;
    let language = syntax_language(path)?;
    let python = crate::language_for_path(path) == Some("python");
    let symbols_query = if python {
        include_str!("../../../modules/adapters/python/queries/symbols.scm")
    } else {
        include_str!("../../../modules/adapters/typescript/queries/symbols.scm")
    };
    let query = Query::new(&language, symbols_query)?;
    let mut result = SyntaxTable {
        parse_errors: tree.root_node().has_error(),
        ..Default::default()
    };
    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(&query, tree.root_node(), source);
    let stem = path
        .rsplit('/')
        .next()
        .unwrap_or(path)
        .rsplit_once('.')
        .map_or(path, |(stem, _)| stem);
    while let Some(matched) = matches.next() {
        let capture = |name| {
            matched
                .captures
                .iter()
                .find(|capture| query.capture_names()[capture.index as usize] == name)
                .map(|capture| capture.node)
        };
        let (Some(node), Some(name)) = (capture("symbol"), capture("name")) else {
            continue;
        };
        if node.kind() == "variable_declarator" && symbol_kind(node) == SymbolKind::Variable {
            let mut ancestor = node.parent();
            let mut exported = false;
            while let Some(parent) = ancestor {
                if parent.kind() == "export_statement" {
                    exported = true;
                    break;
                }
                if matches!(parent.kind(), "program" | "statement_block") {
                    break;
                }
                ancestor = parent.parent();
            }
            if !exported {
                continue;
            }
        }
        if node.kind() == "assignment"
            && node.parent().is_some_and(|parent| {
                parent.kind() != "expression_statement"
                    || parent
                        .parent()
                        .is_none_or(|parent| parent.kind() != "module")
            })
        {
            continue;
        }
        let mut names = vec![text(name, source).to_owned()];
        let mut ancestor = node.parent();
        while let Some(parent) = ancestor {
            if declaration_ancestor(parent)
                && let Some(name) = parent.child_by_field_name("name")
            {
                names.push(text(name, source).into());
            }
            ancestor = parent.parent();
        }
        names.push(stem.into());
        names.reverse();
        result.symbols.push(Symbol {
            name: text(name, source).into(),
            symbol_path: names.join("."),
            kind: symbol_kind(node),
            line_start: node.start_position().row as u32 + 1,
            line_end: node.end_position().row as u32 + 1,
            byte_start: node.start_byte(),
            byte_end: node.end_byte(),
        });
    }
    result
        .symbols
        .sort_by_key(|symbol| (symbol.byte_start, symbol.byte_end));
    identifiers(tree.root_node(), source, &mut result);
    if !path.ends_with(".d.ts")
        && !path.ends_with(".d.mts")
        && !path.ends_with(".d.cts")
        && !path.ends_with(".pyi")
    {
        let query = Query::new(
            &language,
            if python {
                include_str!("../../../modules/adapters/python/queries/executable.scm")
            } else {
                include_str!("../../../modules/adapters/typescript/queries/executable.scm")
            },
        )?;
        let mut cursor = QueryCursor::new();
        let mut matches = cursor.matches(&query, tree.root_node(), source);
        while let Some(matched) = matches.next() {
            for capture in matched.captures {
                if !inside_type(capture.node) {
                    executable_tokens(capture.node, source, &mut result.executable_lines);
                }
            }
        }
    }
    Ok(result)
}

/// The content hash and grammar select a table; paths contribute only their
/// module stem, which is part of every symbol path.
#[derive(Default)]
pub struct SyntaxCache {
    tables: Mutex<BTreeMap<String, SyntaxTable>>,
}
impl SyntaxCache {
    pub fn analyze(&self, path: &str, source: &[u8]) -> Result<SyntaxTable> {
        let key = format!("{path}:{}", blake3::hash(source));
        if let Some(table) = self.tables.lock().unwrap().get(&key) {
            return Ok(table.clone());
        }
        let table = analyze_source(path, source)?;
        self.tables.lock().unwrap().insert(key, table.clone());
        Ok(table)
    }
}

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::{
    cell::Cell,
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    sync::Mutex,
};
use streaming_iterator::StreamingIterator;
use tree_sitter::{
    Language, Node, ParseOptions, Parser, Query, QueryCursor, QueryCursorOptions, QueryMatch,
};

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

/// A compiled query, shared per language and query text: compiling is far more
/// expensive than running a query on one file.
pub(crate) fn cached_query(
    language: &Language,
    text: &'static str,
) -> Result<std::sync::Arc<Query>> {
    type Queries = Mutex<std::collections::HashMap<(usize, usize), std::sync::Arc<Query>>>;
    static QUERIES: std::sync::OnceLock<Queries> = std::sync::OnceLock::new();
    let key = (language.clone().into_raw() as usize, text.as_ptr() as usize);
    let queries = QUERIES.get_or_init(Mutex::default);
    if let Some(query) = queries.lock().unwrap().get(&key) {
        return Ok(query.clone());
    }
    let query = std::sync::Arc::new(Query::new(language, text)?);
    queries.lock().unwrap().insert(key, query.clone());
    Ok(query)
}

pub fn parse_source(path: &str, source: &[u8]) -> Result<tree_sitter::Tree> {
    let mut parser = Parser::new();
    parser.set_language(&syntax_language(path)?)?;
    parser
        .parse(source, None)
        .context("parser did not return a tree")
}

/// `parse_source` that gives up, with `None`, once `stop` is true.
pub(crate) fn parse_source_until(
    path: &str,
    source: &[u8],
    stop: &dyn Fn() -> bool,
) -> Result<Option<tree_sitter::Tree>> {
    let mut parser = Parser::new();
    parser.set_language(&syntax_language(path)?)?;
    let mut progress = |_: &tree_sitter::ParseState| stop();
    let tree = parser.parse_with_options(
        &mut |offset, _| &source[offset.min(source.len())..],
        None,
        Some(ParseOptions::new().progress_callback(&mut progress)),
    );
    match tree {
        Some(tree) => Ok(Some(tree)),
        None if stop() => Ok(None),
        None => bail!("parser did not return a tree"),
    }
}

/// Whether the content is an XML document. Qt Linguist translations are XML
/// files named `.ts`; parsed as TypeScript they are megabytes of error nodes
/// and say nothing about the code.
pub fn is_markup(source: &[u8]) -> bool {
    let source = source.strip_prefix(b"\xef\xbb\xbf").unwrap_or(source);
    let start = source
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())
        .unwrap_or(source.len());
    let source = &source[start..];
    source.starts_with(b"<?xml") || source.starts_with(b"<!DOCTYPE")
}

/// Ends a long analysis: `hit` asks `stop` once every 1024 calls and stays true
/// after the first yes.
pub(crate) struct Budget<'a> {
    stop: &'a dyn Fn() -> bool,
    calls: Cell<u32>,
    stopped: Cell<bool>,
}
impl<'a> Budget<'a> {
    pub(crate) fn new(stop: &'a dyn Fn() -> bool) -> Self {
        Self {
            stop,
            calls: Cell::new(0),
            stopped: Cell::new(false),
        }
    }
    pub(crate) fn hit(&self) -> bool {
        if self.stopped.get() {
            return true;
        }
        let calls = self.calls.get().wrapping_add(1);
        self.calls.set(calls);
        if calls.is_multiple_of(1024) && (self.stop)() {
            self.stopped.set(true);
        }
        self.stopped.get()
    }
    pub(crate) fn stop(&self) -> &'a dyn Fn() -> bool {
        self.stop
    }
    /// Whether a walk was cut short, which leaves its result incomplete.
    pub(crate) fn stopped(&self) -> bool {
        self.stopped.get()
    }
}

/// Walks the tree once and hands each wanted node its ancestors, outermost
/// first. `Node::parent` searches down from the root through every sibling on
/// the way, so asking it per node is quadratic on the wide trees of generated
/// or misparsed files.
pub(crate) fn with_ancestors<'t>(
    root: Node<'t>,
    wanted: &HashSet<usize>,
    budget: &Budget,
    mut visit: impl FnMut(Node<'t>, &[Node<'t>]),
) {
    let mut cursor = root.walk();
    let mut stack: Vec<Node<'t>> = Vec::new();
    let mut left = wanted.len();
    while left > 0 && !budget.hit() {
        let node = cursor.node();
        if wanted.contains(&node.id()) {
            visit(node, &stack);
            left -= 1;
        }
        if cursor.goto_first_child() {
            stack.push(node);
            continue;
        }
        loop {
            if cursor.goto_next_sibling() {
                break;
            }
            if !cursor.goto_parent() {
                return;
            }
            stack.pop();
        }
    }
}

/// Hands each match of `query` in the tree to `each`; false when the budget
/// ended it. The cursor asks the budget while it scans, so a large tree with
/// few matches cannot outlive a deadline between two of them.
pub(crate) fn query_matches<'t>(
    query: &Query,
    root: Node<'t>,
    source: &[u8],
    budget: &Budget,
    mut each: impl FnMut(&QueryMatch<'_, 't>),
) -> bool {
    let mut progress = |_: &tree_sitter::QueryCursorState| budget.hit();
    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches_with_options(
        query,
        root,
        source,
        QueryCursorOptions::new().progress_callback(&mut progress),
    );
    while let Some(matched) = matches.next() {
        if budget.hit() {
            break;
        }
        each(matched);
    }
    !budget.stopped()
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

fn executable_tokens(node: Node<'_>, source: &[u8], lines: &mut BTreeSet<u32>, budget: &Budget) {
    if budget.hit() || ignored_type(node) || node.kind().contains("comment") {
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
            if budget.stopped() {
                break;
            }
            executable_tokens(child, source, lines, budget);
        }
    }
}

/// `ancestors` are the node's, outermost first.
fn symbol_kind(node: Node<'_>, ancestors: &[Node<'_>]) -> SymbolKind {
    match node.kind() {
        "function_declaration" | "generator_function_declaration" | "function_definition" => {
            let mut outer = ancestors.iter().rev();
            if outer.next().is_some_and(|parent| parent.kind() == "block")
                && outer
                    .next()
                    .is_some_and(|parent| parent.kind() == "class_definition")
            {
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
        fn names(
            node: Node<'_>,
            parent: &str,
            source: &[u8],
            result: &mut BTreeMap<String, String>,
        ) {
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
            if node.kind() == "identifier" && parent == "import_clause" {
                result.insert(text(node, source).into(), "default".into());
            }
            let mut cursor = node.walk();
            for child in node.named_children(&mut cursor) {
                names(child, node.kind(), source, result);
            }
        }
        names(node, "", source, &mut import.names);
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

/// `ancestors` are the node's, outermost first; the walk keeps them so that no
/// identifier asks the tree for its parent.
fn identifiers<'t>(
    node: Node<'t>,
    ancestors: &mut Vec<Node<'t>>,
    source: &[u8],
    result: &mut SyntaxTable,
    budget: &Budget,
) {
    if budget.hit()
        || matches!(
            node.kind(),
            "comment" | "string" | "string_fragment" | "template_string"
        )
    {
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
        let parent = ancestors.last().copied();
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
                shadowed: parameter_binding(node, ancestors, source),
            });
        }
    }
    ancestors.push(node);
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        if budget.stopped() {
            break;
        }
        identifiers(child, ancestors, source, result, budget);
    }
    ancestors.pop();
}

/// `ancestors` are the node's, outermost first.
pub(crate) fn parameter_binding(node: Node<'_>, ancestors: &[Node<'_>], source: &[u8]) -> bool {
    if node.kind() == "property_identifier"
        || ancestors.last().is_some_and(|parent| {
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
    ancestors.iter().rev().any(|parent| {
        parent
            .child_by_field_name("parameters")
            .is_some_and(|parameters| contains_name(parameters, text(node, source), source))
    })
}

pub fn analyze_source(path: &str, source: &[u8]) -> Result<SyntaxTable> {
    Ok(analyze_source_until(path, source, &|| false)?.expect("an analysis without a stop ends"))
}

/// `analyze_source` that gives up, with `None`, once `stop` is true: parsing and
/// every walk ask it, so one pathological file cannot outlive a deadline.
pub fn analyze_source_until(
    path: &str,
    source: &[u8],
    stop: &dyn Fn() -> bool,
) -> Result<Option<SyntaxTable>> {
    if is_markup(source) {
        syntax_language(path)?;
        return Ok(Some(SyntaxTable {
            parse_errors: true,
            ..Default::default()
        }));
    }
    let budget = Budget::new(stop);
    let table = if crate::language_for_path(path) == Some("rust") {
        crate::rust_syntax::analyze_rust(path, source, &budget)?
    } else {
        analyze_script(path, source, &budget)?
    };
    Ok(table)
}

fn analyze_script(path: &str, source: &[u8], budget: &Budget) -> Result<Option<SyntaxTable>> {
    let Some(tree) = parse_source_until(path, source, budget.stop)? else {
        return Ok(None);
    };
    let language = syntax_language(path)?;
    let python = crate::language_for_path(path) == Some("python");
    let symbols_query = if python {
        include_str!("../../../modules/adapters/python/queries/symbols.scm")
    } else {
        include_str!("../../../modules/adapters/typescript/queries/symbols.scm")
    };
    let query = cached_query(&language, symbols_query)?;
    let mut result = SyntaxTable {
        parse_errors: tree.root_node().has_error(),
        ..Default::default()
    };
    let stem = path
        .rsplit('/')
        .next()
        .unwrap_or(path)
        .rsplit_once('.')
        .map_or(path, |(stem, _)| stem);
    let mut found = Vec::new();
    if !query_matches(&query, tree.root_node(), source, budget, |matched| {
        let capture = |name| {
            matched
                .captures
                .iter()
                .find(|capture| query.capture_names()[capture.index as usize] == name)
                .map(|capture| capture.node)
        };
        if let (Some(node), Some(name)) = (capture("symbol"), capture("name")) {
            found.push((node, name));
        }
    }) {
        return Ok(None);
    }
    // What each symbol's ancestors say about it: None for one that is not a
    // symbol after all, else its kind and the names of its enclosing declarations.
    let mut placed = HashMap::<usize, Option<(SymbolKind, Vec<String>)>>::new();
    with_ancestors(
        tree.root_node(),
        &found.iter().map(|(node, _)| node.id()).collect(),
        budget,
        |node, ancestors| {
            let kind = symbol_kind(node, ancestors);
            let mut outer = ancestors.iter().rev();
            let unexported = node.kind() == "variable_declarator"
                && kind == SymbolKind::Variable
                && outer
                    .clone()
                    .find(|parent| {
                        matches!(
                            parent.kind(),
                            "export_statement" | "program" | "statement_block"
                        )
                    })
                    .is_none_or(|parent| parent.kind() != "export_statement");
            let nested_assignment = node.kind() == "assignment"
                && outer.next().is_some_and(|parent| {
                    parent.kind() != "expression_statement"
                        || outer.next().is_none_or(|parent| parent.kind() != "module")
                });
            let names = ancestors
                .iter()
                .filter(|parent| declaration_ancestor(**parent))
                .filter_map(|parent| parent.child_by_field_name("name"))
                .map(|name| text(name, source).to_owned())
                .collect();
            placed.insert(
                node.id(),
                (!unexported && !nested_assignment).then_some((kind, names)),
            );
        },
    );
    if budget.stopped() {
        return Ok(None);
    }
    for (node, name) in found {
        let Some(Some((kind, outer))) = placed.get(&node.id()) else {
            continue;
        };
        let mut names = vec![stem.to_owned()];
        names.extend(outer.iter().cloned());
        names.push(text(name, source).to_owned());
        result.symbols.push(Symbol {
            name: text(name, source).into(),
            symbol_path: names.join("."),
            kind: *kind,
            line_start: node.start_position().row as u32 + 1,
            line_end: node.end_position().row as u32 + 1,
            byte_start: node.start_byte(),
            byte_end: node.end_byte(),
        });
    }
    result
        .symbols
        .sort_by_key(|symbol| (symbol.byte_start, symbol.byte_end));
    identifiers(
        tree.root_node(),
        &mut Vec::new(),
        source,
        &mut result,
        budget,
    );
    if !path.ends_with(".d.ts")
        && !path.ends_with(".d.mts")
        && !path.ends_with(".d.cts")
        && !path.ends_with(".pyi")
    {
        let query = cached_query(
            &language,
            if python {
                include_str!("../../../modules/adapters/python/queries/executable.scm")
            } else {
                include_str!("../../../modules/adapters/typescript/queries/executable.scm")
            },
        )?;
        let mut captured = HashSet::new();
        if !query_matches(&query, tree.root_node(), source, budget, |matched| {
            captured.extend(matched.captures.iter().map(|capture| capture.node.id()));
        }) {
            return Ok(None);
        }
        let lines = &mut result.executable_lines;
        with_ancestors(tree.root_node(), &captured, budget, |node, ancestors| {
            if !ancestors.iter().any(|parent| ignored_type(*parent)) {
                executable_tokens(node, source, lines, budget);
            }
        });
    }
    Ok((!budget.stopped()).then_some(result))
}

/// The content hash and grammar select a table; paths contribute only their
/// module stem, which is part of every symbol path.
#[derive(Default)]
pub struct SyntaxCache {
    tables: Mutex<BTreeMap<String, SyntaxTable>>,
    // Files and bytes actually parsed (cache misses), for graph measurements.
    parsed: Mutex<(usize, u64)>,
}
impl SyntaxCache {
    pub fn analyze(&self, path: &str, source: &[u8]) -> Result<SyntaxTable> {
        Ok(self
            .analyze_until(path, source, &|| false)?
            .expect("an analysis without a stop ends"))
    }
    /// `analyze` that gives up, with `None`, once `stop` is true; nothing is
    /// cached for a file it gave up on.
    pub fn analyze_until(
        &self,
        path: &str,
        source: &[u8],
        stop: &dyn Fn() -> bool,
    ) -> Result<Option<SyntaxTable>> {
        let key = format!("{path}:{}", blake3::hash(source));
        if let Some(table) = self.tables.lock().unwrap().get(&key) {
            return Ok(Some(table.clone()));
        }
        let Some(table) = analyze_source_until(path, source, stop)? else {
            return Ok(None);
        };
        let mut parsed = self.parsed.lock().unwrap();
        parsed.0 += 1;
        parsed.1 += source.len() as u64;
        self.tables.lock().unwrap().insert(key, table.clone());
        Ok(Some(table))
    }
    /// Files and bytes parsed so far.
    pub fn parsed(&self) -> (usize, u64) {
        *self.parsed.lock().unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_query_asks_the_budget_while_it_scans_a_tree_without_matches() {
        // Statements only: nothing here is a symbol, so the query yields no match
        // at which its caller could ask.
        let path = "wide.ts";
        let source = "1;\n".repeat(200_000);
        let tree = parse_source(path, source.as_bytes()).unwrap();
        let query = cached_query(
            &syntax_language(path).unwrap(),
            include_str!("../../../modules/adapters/typescript/queries/symbols.scm"),
        )
        .unwrap();
        let run = |stop: &dyn Fn() -> bool| {
            let mut found = 0;
            let ended = query_matches(
                &query,
                tree.root_node(),
                source.as_bytes(),
                &Budget::new(stop),
                |_| found += 1,
            );
            (ended, found)
        };
        let asked = Cell::new(0);
        assert_eq!(
            run(&|| {
                asked.set(asked.get() + 1);
                false
            }),
            (true, 0)
        );
        assert!(asked.get() > 0, "the scan never asked");
        // A yes ends the scan there: nothing is asked again.
        let asked = Cell::new(0);
        assert_eq!(
            run(&|| {
                asked.set(asked.get() + 1);
                true
            }),
            (false, 0)
        );
        assert_eq!(asked.get(), 1);
    }
}

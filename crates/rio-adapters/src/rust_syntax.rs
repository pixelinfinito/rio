use crate::syntax::{Budget, parse_source_until, with_ancestors};
use crate::{Identifier, Import, Symbol, SymbolKind, SyntaxTable};
use anyhow::Result;
use std::collections::{BTreeMap, HashMap};
use streaming_iterator::StreamingIterator;
use tree_sitter::{Node, QueryCursor};

fn text<'a>(node: Node<'_>, source: &'a [u8]) -> &'a str {
    std::str::from_utf8(&source[node.byte_range()]).unwrap_or_default()
}
/// `ancestors` are the node's, outermost first.
fn test_item(node: Node<'_>, ancestors: &[Node<'_>], source: &[u8]) -> bool {
    for node in std::iter::once(&node).chain(ancestors.iter().rev()) {
        let mut sibling = node.prev_named_sibling();
        while let Some(attribute) = sibling {
            if attribute.kind() != "attribute_item" {
                break;
            }
            let value = text(attribute, source);
            if value.contains("cfg(test)") || value.contains("#[test]") {
                return true;
            }
            sibling = attribute.prev_named_sibling();
        }
    }
    false
}
fn kind(node: Node<'_>, ancestors: &[Node<'_>], source: &[u8]) -> SymbolKind {
    if test_item(node, ancestors, source) {
        return SymbolKind::Test;
    }
    match node.kind() {
        "function_item" | "function_signature_item" => {
            if ancestors
                .iter()
                .any(|node| matches!(node.kind(), "impl_item" | "trait_item"))
            {
                SymbolKind::Method
            } else {
                SymbolKind::Function
            }
        }
        "struct_item" => SymbolKind::Class,
        "trait_item" => SymbolKind::Interface,
        "enum_item" | "enum_variant" => SymbolKind::Enum,
        "type_item" => SymbolKind::TypeAlias,
        _ => SymbolKind::Variable,
    }
}
fn imports(prefix: &str, input: &str, result: &mut Vec<Import>) {
    let input = input.trim();
    if let Some((path, list)) = input.split_once('{') {
        let prefix = format!("{prefix}{}", path.trim());
        let list = list.trim_end_matches('}');
        let mut start = 0;
        let mut depth = 0usize;
        for (index, ch) in list.char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => depth -= 1,
                ',' if depth == 0 => {
                    imports(&prefix, &list[start..index], result);
                    start = index + 1;
                }
                _ => {}
            }
        }
        imports(&prefix, &list[start..], result);
    } else if !input.is_empty() {
        let (path, alias) = input
            .split_once(" as ")
            .map_or((input, None), |(path, alias)| {
                (path.trim(), Some(alias.trim()))
            });
        let path = format!("{prefix}{path}");
        let name = path.rsplit("::").next().unwrap_or(&path);
        let module = path.strip_suffix("::self").unwrap_or(&path).to_owned();
        let local = alias.unwrap_or(name).to_owned();
        result.push(Import {
            module,
            names: BTreeMap::from([(local, name.to_owned())]),
        });
    }
}
/// `ancestors` are the node's, outermost first.
fn walk<'t>(
    node: Node<'t>,
    ancestors: &mut Vec<Node<'t>>,
    source: &[u8],
    result: &mut SyntaxTable,
    budget: &Budget,
) {
    if budget.hit()
        || node.kind().contains("comment")
        || node.kind().contains("string_literal")
        || node.kind() == "char_literal"
    {
        return;
    }
    if node.kind() == "use_declaration"
        && let Some(argument) = node.child_by_field_name("argument")
    {
        let mut scoped = Vec::new();
        imports("", text(argument, source), &mut scoped);
        let inline: Vec<_> = ancestors
            .iter()
            .filter(|parent| parent.kind() == "mod_item")
            .filter_map(|parent| parent.child_by_field_name("name"))
            .map(|name| text(name, source))
            .collect();
        for import in &mut scoped {
            let mut module = import.module.as_str();
            let mut scope = inline.clone();
            while let Some(rest) = module.strip_prefix("super::") {
                if scope.pop().is_none() {
                    break;
                }
                module = rest;
            }
            if module != import.module {
                import.module = if scope.is_empty() {
                    format!("self::{module}")
                } else {
                    format!("self::{}::{module}", scope.join("::"))
                };
            } else if let Some(rest) = module.strip_prefix("self::")
                && !scope.is_empty()
            {
                import.module = format!("self::{}::{rest}", scope.join("::"));
            }
        }
        result.imports.extend(scoped);
    }
    if matches!(node.kind(), "identifier" | "type_identifier") {
        let parent = ancestors.last().copied();
        let definition = parent.is_some_and(|parent| {
            parent
                .child_by_field_name("name")
                .is_some_and(|name| name.id() == node.id())
        });
        if !definition {
            result.identifiers.push(Identifier {
                name: text(node, source).into(),
                line: node.start_position().row as u32 + 1,
                byte_start: node.start_byte(),
                byte_end: node.end_byte(),
                call: parent.is_some_and(|parent| {
                    matches!(parent.kind(), "call_expression" | "macro_invocation")
                }),
                shadowed: crate::syntax::parameter_binding(node, ancestors, source),
            });
        }
    }
    ancestors.push(node);
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        walk(child, ancestors, source, result, budget);
    }
    ancestors.pop();
}
fn runtime_tokens(node: Node<'_>, source: &[u8], result: &mut SyntaxTable, budget: &Budget) {
    if budget.hit()
        || node.kind().contains("comment")
        || matches!(
            node.kind(),
            "struct_item"
                | "enum_item"
                | "trait_item"
                | "type_item"
                | "use_declaration"
                | "attribute_item"
        )
    {
        return;
    }
    if node.child_count() == 0 {
        let value = text(node, source).trim();
        if !value.is_empty() && !matches!(value, "{" | "}" | ";" | "," | ":" | "(" | ")") {
            result
                .executable_lines
                .insert(node.start_position().row as u32 + 1);
        }
    } else {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            runtime_tokens(child, source, result, budget);
        }
    }
}
pub(crate) fn analyze_rust(
    path: &str,
    source: &[u8],
    budget: &Budget,
) -> Result<Option<SyntaxTable>> {
    let Some(tree) = parse_source_until(path, source, budget.stop())? else {
        return Ok(None);
    };
    let language = tree_sitter_rust::LANGUAGE.into();
    // Validate and use all three shipped query contracts.
    crate::syntax::cached_query(
        &language,
        include_str!("../../../modules/adapters/rust/queries/references.scm"),
    )?;
    let query = crate::syntax::cached_query(
        &language,
        include_str!("../../../modules/adapters/rust/queries/symbols.scm"),
    )?;
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
        .trim_end_matches(".rs");
    let mut found = Vec::new();
    while let Some(matched) = matches.next() {
        if budget.hit() {
            return Ok(None);
        }
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
    }
    // Each symbol's kind and the names of its enclosing items, outermost first.
    let mut placed = HashMap::<usize, (SymbolKind, Vec<String>)>::new();
    with_ancestors(
        tree.root_node(),
        &found.iter().map(|(node, _)| node.id()).collect(),
        budget,
        |node, ancestors| {
            let names = ancestors
                .iter()
                .filter_map(|parent| {
                    if parent.kind() == "impl_item" {
                        parent.child_by_field_name("type")
                    } else if matches!(
                        parent.kind(),
                        "function_item" | "mod_item" | "trait_item" | "enum_item"
                    ) {
                        parent.child_by_field_name("name")
                    } else {
                        None
                    }
                })
                .map(|name| text(name, source).to_owned())
                .collect();
            placed.insert(node.id(), (kind(node, ancestors, source), names));
        },
    );
    if budget.stopped() {
        return Ok(None);
    }
    for (node, name) in found {
        let Some((kind, outer)) = placed.get(&node.id()) else {
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
    walk(
        tree.root_node(),
        &mut Vec::new(),
        source,
        &mut result,
        budget,
    );
    let query = crate::syntax::cached_query(
        &language,
        include_str!("../../../modules/adapters/rust/queries/executable.scm"),
    )?;
    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(&query, tree.root_node(), source);
    while let Some(matched) = matches.next() {
        for capture in matched.captures {
            runtime_tokens(capture.node, source, &mut result, budget);
        }
    }
    Ok((!budget.stopped()).then_some(result))
}

use crate::{Identifier, Import, Symbol, SymbolKind, SyntaxTable, parse_source};
use anyhow::Result;
use std::collections::BTreeMap;
use streaming_iterator::StreamingIterator;
use tree_sitter::{Node, Query, QueryCursor};

fn text<'a>(node: Node<'_>, source: &'a [u8]) -> &'a str {
    std::str::from_utf8(&source[node.byte_range()]).unwrap_or_default()
}
fn test_item(mut node: Node<'_>, source: &[u8]) -> bool {
    loop {
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
        match node.parent() {
            Some(parent) => node = parent,
            None => return false,
        }
    }
}
fn kind(node: Node<'_>, source: &[u8]) -> SymbolKind {
    if test_item(node, source) {
        return SymbolKind::Test;
    }
    match node.kind() {
        "function_item" | "function_signature_item" => {
            let mut parent = node.parent();
            while let Some(node) = parent {
                if matches!(node.kind(), "impl_item" | "trait_item") {
                    return SymbolKind::Method;
                }
                parent = node.parent();
            }
            SymbolKind::Function
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
fn walk(node: Node<'_>, source: &[u8], result: &mut SyntaxTable) {
    if node.kind().contains("comment")
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
        let mut inline = Vec::new();
        let mut ancestor = node.parent();
        while let Some(parent) = ancestor {
            if parent.kind() == "mod_item"
                && let Some(name) = parent.child_by_field_name("name")
            {
                inline.push(text(name, source));
            }
            ancestor = parent.parent();
        }
        inline.reverse();
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
        let definition = node.parent().is_some_and(|parent| {
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
                call: node.parent().is_some_and(|parent| {
                    matches!(parent.kind(), "call_expression" | "macro_invocation")
                }),
                shadowed: crate::syntax::parameter_binding(node, source),
            });
        }
    }
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        walk(child, source, result);
    }
}
fn runtime_tokens(node: Node<'_>, source: &[u8], result: &mut SyntaxTable) {
    if node.kind().contains("comment")
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
            runtime_tokens(child, source, result);
        }
    }
}
pub(crate) fn analyze_rust(path: &str, source: &[u8]) -> Result<SyntaxTable> {
    let tree = parse_source(path, source)?;
    let language = tree_sitter_rust::LANGUAGE.into();
    // Validate and use all three shipped query contracts.
    Query::new(
        &language,
        include_str!("../../../modules/adapters/rust/queries/references.scm"),
    )?;
    let query = Query::new(
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
        let mut names = vec![text(name, source).to_owned()];
        let mut ancestor = node.parent();
        while let Some(parent) = ancestor {
            let name = if parent.kind() == "impl_item" {
                parent.child_by_field_name("type")
            } else if matches!(
                parent.kind(),
                "function_item" | "mod_item" | "trait_item" | "enum_item"
            ) {
                parent.child_by_field_name("name")
            } else {
                None
            };
            if let Some(name) = name {
                names.push(text(name, source).to_owned());
            }
            ancestor = parent.parent();
        }
        names.push(stem.into());
        names.reverse();
        result.symbols.push(Symbol {
            name: text(name, source).into(),
            symbol_path: names.join("."),
            kind: kind(node, source),
            line_start: node.start_position().row as u32 + 1,
            line_end: node.end_position().row as u32 + 1,
            byte_start: node.start_byte(),
            byte_end: node.end_byte(),
        });
    }
    result
        .symbols
        .sort_by_key(|symbol| (symbol.byte_start, symbol.byte_end));
    walk(tree.root_node(), source, &mut result);
    let query = Query::new(
        &language,
        include_str!("../../../modules/adapters/rust/queries/executable.scm"),
    )?;
    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(&query, tree.root_node(), source);
    while let Some(matched) = matches.next() {
        for capture in matched.captures {
            runtime_tokens(capture.node, source, &mut result);
        }
    }
    Ok(result)
}

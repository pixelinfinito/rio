//! Owner guidance is snapshot data. It never changes execution permissions.
use std::collections::BTreeSet;

use globset::Glob;
use serde::{Deserialize, Serialize};

use crate::{Journey, QaConfig, QaSnapshot};

pub const GUIDANCE_NAMES: [&str; 3] = ["REVIEW.md", "AGENTS.md", "CLAUDE.md"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScopedGuidance {
    pub path: String,
    pub scope_dir: String,
    pub content_hash: String,
    /// Original, one-based line positions are retained by consumers.
    pub lines: Vec<String>,
}

pub fn is_guidance(path: &str) -> bool {
    GUIDANCE_NAMES.contains(&path.rsplit('/').next().unwrap_or(path))
}

pub fn path_in_scope(path: &str, scope: &str) -> bool {
    scope.is_empty() || path.strip_prefix(scope).is_some_and(|s| s.starts_with('/'))
}

pub(crate) fn glob_matches(pattern: &str, path: &str) -> bool {
    Glob::new(pattern).is_ok_and(|glob| glob.compile_matcher().is_match(path))
}

/// Framework route derivation does not inspect or execute application code.
pub fn routes_for_path(config: &QaConfig, path: &str) -> BTreeSet<String> {
    let Some(mapping) = &config.app.routes_from else {
        return BTreeSet::new();
    };
    if let Some(entries) = mapping["map"].as_array() {
        return entries
            .iter()
            .filter(|entry| {
                entry["glob"]
                    .as_str()
                    .is_some_and(|glob| glob_matches(glob, path))
            })
            .filter_map(|entry| entry["route"].as_str().map(str::to_owned))
            .collect();
    }
    let convention = mapping["convention"].as_str().unwrap_or("none");
    let path = path.strip_prefix("src/").unwrap_or(path);
    let (prefix, page) = match convention {
        "next-app" => ("app/", "page"),
        "next-pages" | "nuxt" | "astro" => ("pages/", "index"),
        "sveltekit" => ("routes/", "+page"),
        "remix" => ("app/routes/", "_index"),
        _ => return BTreeSet::new(),
    };
    let Some(path) = path.strip_prefix(prefix) else {
        return BTreeSet::new();
    };
    let Some((stem, extension)) = path.rsplit_once('.') else {
        return BTreeSet::new();
    };
    if ![
        "js", "jsx", "ts", "tsx", "vue", "svelte", "astro", "md", "mdx",
    ]
    .contains(&extension)
    {
        return BTreeSet::new();
    }
    let mut parts: Vec<_> = stem
        .split('/')
        .filter(|s| !s.starts_with('('))
        .map(str::to_owned)
        .collect();
    if ["next-app", "sveltekit"].contains(&convention) && parts.last().is_none_or(|s| s != page) {
        return BTreeSet::new();
    }
    if parts.last().is_some_and(|s| s == page) {
        parts.pop();
    }
    if convention == "next-pages"
        && parts
            .first()
            .is_some_and(|s| s == "api" || s.starts_with('_'))
    {
        return BTreeSet::new();
    }
    if convention == "remix" {
        parts = parts
            .join("/")
            .split('.')
            .filter(|s| *s != "_index")
            .map(str::to_owned)
            .collect();
    }
    [format!("/{}", parts.join("/"))].into()
}

/// Match committed route patterns, including framework dynamic segments.
pub fn route_matches(pattern: &str, route: &str) -> bool {
    if pattern == route || glob_matches(pattern, route) {
        return true;
    }
    let mut expression = String::from("^");
    for (i, part) in pattern.split('/').enumerate() {
        if i > 0 {
            expression.push('/');
        }
        if part.starts_with("[...") || part.starts_with("[[...") || part == "*" {
            expression.push_str(".*");
        } else if part.starts_with('[') || part.starts_with(':') || part.starts_with('$') {
            expression.push_str("[^/]+");
        } else {
            expression.push_str(&regex::escape(part));
        }
    }
    expression.push('$');
    regex::Regex::new(&expression).is_ok_and(|re| re.is_match(route))
}

/// Sources covered by a journey or visited route, including unchanged files.
pub fn source_scope(
    snapshot: &QaSnapshot,
    config: &QaConfig,
    journey: Option<&Journey>,
    visited_routes: &[String],
) -> BTreeSet<String> {
    let mut routes = visited_routes.to_vec();
    if let Some(journey) = journey {
        routes.extend(journey.covers.routes.clone());
    }
    snapshot
        .keys()
        .filter(|path| {
            !is_guidance(path)
                && (journey
                    .is_some_and(|j| j.covers.paths.iter().any(|glob| glob_matches(glob, path)))
                    || routes_for_path(config, path).iter().any(|mapped| {
                        routes.iter().any(|route| {
                            route_matches(route, mapped) || route_matches(mapped, route)
                        })
                    }))
        })
        .cloned()
        .collect()
}

/// Root guidance is always available, including before journey generation.
/// Nested documents are included only when a covered source is in their scope.
pub fn scoped_guidance(snapshot: &QaSnapshot, sources: &BTreeSet<String>) -> Vec<ScopedGuidance> {
    let mut guidance: Vec<_> = snapshot
        .iter()
        .filter_map(|(path, content)| {
            if !is_guidance(path) {
                return None;
            }
            let scope = path.rsplit_once('/').map_or("", |(scope, _)| scope);
            if !scope.is_empty() && !sources.iter().any(|source| path_in_scope(source, scope)) {
                return None;
            }
            Some(ScopedGuidance {
                path: path.clone(),
                scope_dir: scope.into(),
                content_hash: blake3::hash(content).to_hex().to_string(),
                lines: String::from_utf8_lossy(content)
                    .lines()
                    .map(str::to_owned)
                    .collect(),
            })
        })
        .collect();
    // Ancestors first, so refinements can be interpreted with the original citations.
    guidance.sort_by_key(|g| {
        (
            g.scope_dir.matches('/').count() + usize::from(!g.scope_dir.is_empty()),
            g.path.clone(),
        )
    });
    guidance
}

pub fn journey_guidance(
    snapshot: &QaSnapshot,
    config: &QaConfig,
    journey: &Journey,
) -> Vec<ScopedGuidance> {
    scoped_guidance(
        snapshot,
        &source_scope(snapshot, config, Some(journey), &[]),
    )
}

/// Resolve both snapshots so a removed guidance file or covered source still
/// selects a journey. This only selects work; it cannot override runtime policy.
pub fn changed_guidance(
    base: &QaSnapshot,
    head: &QaSnapshot,
    config: &QaConfig,
    journey: &Journey,
) -> Vec<String> {
    let mut paths: BTreeSet<_> = journey_guidance(base, config, journey)
        .into_iter()
        .map(|g| g.path)
        .collect();
    paths.extend(
        journey_guidance(head, config, journey)
            .into_iter()
            .map(|g| g.path),
    );
    paths
        .into_iter()
        .filter(|path| base.get(path) != head.get(path))
        .collect()
}

//! Deterministic selection; no application or harness execution occurs here.
use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

/// Preserve a changed-file explanation only when graph edges establish it.
/// Truncated/disconnected impact nodes still select coverage, with an explicit
/// graph-level reason rather than an invented relationship to every change.
pub fn selection_graph(
    graphs: &serde_json::Value,
    changed: &BTreeSet<String>,
) -> BTreeMap<String, BTreeSet<String>> {
    let mut result: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for version in ["base", "head"] {
        let graph = &graphs[version];
        let nodes: BTreeMap<_, _> = graph["nodes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|node| Some((node["id"].as_str()?, node["path"].as_str()?)))
            .collect();
        let mut explained = BTreeSet::new();
        for origin in changed {
            let mut pending: Vec<_> = nodes
                .iter()
                .filter(|(_, path)| **path == origin)
                .map(|(id, _)| *id)
                .collect();
            let mut seen = BTreeSet::new();
            while let Some(id) = pending.pop() {
                if !seen.insert(id) {
                    continue;
                }
                if let Some(path) = nodes.get(id) {
                    result
                        .entry(origin.clone())
                        .or_default()
                        .insert((*path).into());
                    explained.insert(*path);
                }
                for edge in graph["edges"].as_array().into_iter().flatten() {
                    if edge["to"].as_str() == Some(id)
                        && let Some(from) = edge["from"].as_str()
                    {
                        pending.push(from);
                    }
                }
            }
        }
        for path in nodes.values() {
            if !explained.contains(path) {
                result
                    .entry("impact graph".into())
                    .or_default()
                    .insert((*path).into());
            }
        }
    }
    result
}

use crate::guidance::glob_matches;
use crate::{
    Cell, Journey, QaErrors, QaProject, QaSnapshot, changed_guidance, route_matches,
    routes_for_path,
};

#[derive(Debug)]
pub struct SelectionInput {
    pub full: bool,
    pub explicit: Vec<String>,
    pub changed: BTreeSet<String>,
    /// Impact source -> dependent source paths, retained for plan explanations.
    pub graph: BTreeMap<String, BTreeSet<String>>,
    pub max_journeys: usize,
    pub cell_wall_seconds: u64,
}

impl Default for SelectionInput {
    fn default() -> Self {
        Self {
            full: false,
            explicit: Vec::new(),
            changed: BTreeSet::new(),
            graph: BTreeMap::new(),
            max_journeys: 12,
            cell_wall_seconds: 480,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Chain {
    pub journeys: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct QaPlan {
    pub stale_journeys: BTreeMap<String, Vec<String>>,
    pub selected: BTreeMap<String, Vec<String>>,
    pub held_back: BTreeMap<String, Vec<String>>,
    pub chains: Vec<Chain>,
    pub cells: Vec<Cell>,
    pub cell_count: usize,
    pub estimated_wall_seconds: u64,
    pub uncovered_routes: BTreeSet<String>,
    /// All changed routes are reserved up front; execution omits routes that
    /// committed journeys actually visited in each viewport/scheme cell.
    pub exploration_routes: BTreeSet<String>,
    pub no_coverage_match: bool,
}

fn matches_path(journey: &Journey, path: &str) -> bool {
    journey
        .covers
        .paths
        .iter()
        .any(|glob| glob_matches(glob, path))
}

impl QaProject {
    /// Add the bounded, host-authored exploratory pass after committed chains.
    /// It has no dependency state and therefore starts from a restored seed.
    pub fn add_exploration(
        &mut self,
        plan: &mut QaPlan,
        input: &SelectionInput,
    ) -> Result<(), QaErrors> {
        if input.full || !input.explicit.is_empty() || plan.exploration_routes.is_empty() {
            return Ok(());
        }
        if self.journeys.contains_key("exploratory") {
            return Err(QaErrors(
                "journey name exploratory conflicts with the QA exploratory pass".into(),
            ));
        }
        let routes: Vec<_> = plan.exploration_routes.iter().cloned().collect();
        let score = |journey: &Journey| {
            journey
                .covers
                .routes
                .iter()
                .flat_map(|candidate| {
                    routes.iter().map(move |route| {
                        candidate
                            .split('/')
                            .filter(|part| !part.is_empty())
                            .zip(route.split('/').filter(|part| !part.is_empty()))
                            .take_while(|(a, b)| a == b)
                            .count()
                    })
                })
                .max()
                .unwrap_or(0)
        };
        let nearest = self
            .journeys
            .values()
            .filter(|journey| score(journey) > 0)
            .max_by(|a, b| score(a).cmp(&score(b)).then_with(|| b.name.cmp(&a.name)));
        let persona = if let Some(journey) = nearest {
            journey.persona.clone()
        } else {
            let mut name = "rio-anonymous".to_owned();
            while self
                .config
                .personas
                .iter()
                .any(|persona| persona.name == name)
            {
                name.push_str("-anonymous");
            }
            self.config.personas.push(crate::Persona {
                name: name.clone(),
                description: "Anonymous exploratory visitor".into(),
                username_env: None,
                password_env: None,
            });
            name
        };
        let journey: Journey = serde_json::from_value(serde_json::json!({"version":1,"name":"exploratory","title":"Explore changed routes",
            "persona":persona,"tags":[],"covers":{"paths":[],"routes":routes},"preconditions":[],"resets":true,
            "goal":"Assess changed screens against scoped owner requirements and the UX rubric",
            "steps":routes.iter().map(|route| serde_json::json!({"do":format!("Visit {route}. Assess the next actions, feedback, recovery and keyboard interaction using applicable owner guidance and the UX rubric."),"at":route})).collect::<Vec<_>>(),
            "success":["Record visited routes, evidence, assessed criteria and any unassessed criteria with reasons. Do not infer product requirements solely from observed behavior."]
        })).map_err(|_| QaErrors("could not compose exploratory journey".into()))?;
        self.journeys.insert("exploratory".into(), journey);
        plan.selected.insert(
            "exploratory".into(),
            vec!["exploratory: changed routes not visited in each cell".into()],
        );
        plan.chains.push(Chain {
            journeys: vec!["exploratory".into()],
        });
        plan.cell_count += plan.cells.len();
        plan.estimated_wall_seconds =
            (plan.cell_count as u64).saturating_mul(input.cell_wall_seconds);
        Ok(())
    }

    pub fn plan(
        &self,
        base: &QaSnapshot,
        head: &QaSnapshot,
        input: &SelectionInput,
    ) -> Result<QaPlan, QaErrors> {
        let mut selected: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for name in &input.explicit {
            if !self.journeys.contains_key(name) {
                return Err(QaErrors(format!("unknown journey {name}")));
            }
        }
        let base_config = base.get(".rio/qa.yaml").and_then(|bytes| {
            crate::parse_document::<crate::QaConfig>(
                crate::DocumentKind::Config,
                ".rio/qa.yaml",
                bytes,
            )
            .ok()
        });
        let mut routes = BTreeSet::new();
        for path in &input.changed {
            routes.extend(routes_for_path(&self.config, path));
        }
        let mut coverage_match = false;
        for (name, journey) in &self.journeys {
            let mut reasons = Vec::new();
            if !input.explicit.is_empty() {
                if input.explicit.contains(name) {
                    reasons.push("explicit".into());
                }
            } else if input.full {
                reasons.push("full".into());
            } else {
                if journey.tags.iter().any(|tag| tag == "smoke") {
                    reasons.push("smoke".into());
                }
                for path in &input.changed {
                    if matches_path(journey, path) {
                        reasons.push(format!("path: {path}"));
                        coverage_match = true;
                    }
                }
                for (origin, dependents) in &input.graph {
                    for dependent in dependents {
                        if matches_path(journey, dependent) {
                            reasons.push(format!("graph: {origin} -> {dependent}"));
                            coverage_match = true;
                        }
                    }
                }
                for route in &routes {
                    if journey
                        .covers
                        .routes
                        .iter()
                        .any(|pattern| route_matches(pattern, route))
                    {
                        reasons.push(format!("route: {route}"));
                        coverage_match = true;
                    }
                }
                let mut guidance: BTreeSet<_> = changed_guidance(base, head, &self.config, journey)
                    .into_iter()
                    .collect();
                if let Some(config) = &base_config {
                    guidance.extend(changed_guidance(base, head, config, journey));
                }
                for path in guidance {
                    reasons.push(format!("guidance: {path}"));
                    coverage_match = true;
                }
            }
            if !reasons.is_empty() {
                selected.insert(name.clone(), reasons);
            }
        }
        // Pull prerequisites transitively, retaining both direct and dependency reasons.
        let mut pending: Vec<_> = selected.keys().cloned().collect();
        while let Some(name) = pending.pop() {
            for dependency in &self.journeys[&name].after {
                if !selected.contains_key(dependency) {
                    pending.push(dependency.clone());
                }
                let reasons = selected.entry(dependency.clone()).or_default();
                let reason = format!("after: {name}");
                if !reasons.contains(&reason) {
                    reasons.push(reason);
                }
            }
        }
        let mut remaining: BTreeSet<_> = selected.keys().cloned().collect();
        let mut chains = Vec::new();
        // Connected dependency components cannot be split by the selection cap.
        while let Some(first) = remaining.first().cloned() {
            let mut component = BTreeSet::from([first]);
            loop {
                let before = component.len();
                for name in &remaining {
                    let journey = &self.journeys[name];
                    if component.contains(name)
                        || journey.after.iter().any(|d| component.contains(d))
                    {
                        component.insert(name.clone());
                        component.extend(journey.after.iter().cloned());
                    }
                }
                if component.len() == before {
                    break;
                }
            }
            let mut ordered = Vec::new();
            while ordered.len() < component.len() {
                let next = component.iter().find(|name| {
                    !ordered.contains(name)
                        && self.journeys[*name]
                            .after
                            .iter()
                            .all(|d| ordered.contains(&d))
                });
                let Some(next) = next else {
                    return Err(QaErrors("cyclic chain".into()));
                };
                ordered.push(next);
            }
            for name in &component {
                remaining.remove(name);
            }
            chains.push(Chain {
                journeys: ordered.into_iter().cloned().collect(),
            });
        }
        chains.sort_by_key(|chain| {
            let smoke = chain
                .journeys
                .iter()
                .any(|name| self.journeys[name].tags.iter().any(|tag| tag == "smoke"));
            let matches = input
                .changed
                .iter()
                .filter(|path| {
                    chain
                        .journeys
                        .iter()
                        .any(|name| matches_path(&self.journeys[name], path))
                })
                .count();
            (!smoke, std::cmp::Reverse(matches), chain.journeys.clone())
        });
        let mut held_back = BTreeMap::new();
        let mut count = 0;
        chains.retain(|chain| {
            if count + chain.journeys.len() <= input.max_journeys {
                count += chain.journeys.len();
                true
            } else {
                for name in &chain.journeys {
                    held_back.insert(name.clone(), selected.remove(name).unwrap());
                }
                false
            }
        });
        let mut viewports: Vec<_> = self.viewports.values().collect();
        viewports.sort_by_key(|viewport| {
            (
                !viewport.mobile,
                !viewport.touch,
                viewport.width,
                viewport.name.clone(),
            )
        });
        let cells: Vec<_> = viewports
            .iter()
            .flat_map(|viewport| {
                self.config.browser.color_schemes.iter().map(|scheme| Cell {
                    viewport: viewport.name.clone(),
                    color_scheme: scheme.clone(),
                })
            })
            .collect();
        let exploration_routes = if !input.full && input.explicit.is_empty() {
            routes.clone()
        } else {
            BTreeSet::new()
        };
        let uncovered_routes = routes
            .into_iter()
            .filter(|route| {
                !selected.keys().any(|name| {
                    self.journeys[name]
                        .covers
                        .routes
                        .iter()
                        .any(|pattern| route_matches(pattern, route))
                })
            })
            .collect();
        let cell_count = chains
            .iter()
            .map(|chain| {
                cells
                    .iter()
                    .filter(|cell| {
                        chain.journeys.iter().any(|name| {
                            self.journeys[name]
                                .viewports
                                .as_ref()
                                .is_none_or(|v| v.contains(&cell.viewport))
                        })
                    })
                    .count()
            })
            .sum::<usize>();
        let estimated_wall_seconds = (cell_count as u64).saturating_mul(input.cell_wall_seconds);
        Ok(QaPlan {
            stale_journeys: self.stale_journeys(base, head, &input.changed),
            selected,
            held_back,
            chains,
            cells,
            cell_count,
            estimated_wall_seconds,
            uncovered_routes,
            exploration_routes,
            no_coverage_match: !coverage_match && !input.full && input.explicit.is_empty(),
        })
    }

    /// A sync check is advisory: it never edits a committed journey.
    pub fn stale_journeys(
        &self,
        base: &QaSnapshot,
        head: &QaSnapshot,
        changed: &BTreeSet<String>,
    ) -> BTreeMap<String, Vec<String>> {
        self.journeys
            .iter()
            .filter_map(|(name, journey)| {
                let journey_path = format!(".rio/qa/journeys/{name}.yaml");
                if base.get(&journey_path) != head.get(&journey_path) {
                    return None;
                }
                let mut reasons: Vec<_> = changed
                    .iter()
                    .filter(|path| matches_path(journey, path))
                    .cloned()
                    .collect();
                reasons.extend(changed_guidance(base, head, &self.config, journey));
                reasons.sort();
                reasons.dedup();
                (!reasons.is_empty()).then_some((name.clone(), reasons))
            })
            .collect()
    }
}

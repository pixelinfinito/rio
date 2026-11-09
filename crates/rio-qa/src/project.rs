use std::{
    collections::{BTreeMap, BTreeSet},
    sync::LazyLock,
};

use globset::Glob;
use regex::Regex;

use crate::*;

/// Files captured from the selected immutable repository snapshot.
pub type QaSnapshot = BTreeMap<String, Vec<u8>>;

#[derive(Debug)]
pub struct QaProject {
    pub config: QaConfig,
    pub journeys: BTreeMap<String, Journey>,
    pub candidates: BTreeMap<String, Journey>,
    pub seed: Option<SeedManifest>,
    pub fixtures: Option<FixtureManifest>,
    pub viewports: BTreeMap<String, Viewport>,
    pub warnings: Vec<QaDiagnostic>,
}

fn diagnostic(source: &str, path: &str, message: impl Into<String>) -> QaDiagnostic {
    QaDiagnostic {
        source: source.into(),
        path: path.into(),
        message: message.into(),
    }
}

fn fail(errors: Vec<QaDiagnostic>) -> Result<(), QaErrors> {
    if errors.is_empty() {
        Ok(())
    } else {
        Err(QaErrors(
            errors
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        ))
    }
}

impl QaProject {
    pub fn load(snapshot: &QaSnapshot) -> Result<Self, QaErrors> {
        let config_file = ".rio/qa.yaml";
        let bytes = snapshot
            .get(config_file)
            .ok_or_else(|| QaErrors(format!("{config_file}: launch contract is missing")))?;
        let config: QaConfig = parse_document(DocumentKind::Config, config_file, bytes)?;
        let mut errors = Vec::new();
        let mut warnings = Vec::new();
        let mut personas = BTreeSet::new();
        for persona in &config.personas {
            if !personas.insert(persona.name.clone()) {
                errors.push(diagnostic(
                    config_file,
                    "$.personas",
                    format!("duplicate persona {}", persona.name),
                ));
            }
        }
        let mut viewports = BTreeMap::new();
        for definition in &config.browser.viewports {
            match definition.resolve() {
                Ok(viewport) => {
                    let name = viewport.name.clone();
                    if viewports.insert(name.clone(), viewport).is_some() {
                        errors.push(diagnostic(
                            config_file,
                            "$.browser.viewports",
                            format!("duplicate viewport {name}"),
                        ));
                    }
                }
                Err(error) => errors.push(diagnostic(
                    config_file,
                    "$.browser.viewports",
                    error.to_string(),
                )),
            }
        }
        if !viewports.values().any(|v| v.mobile) {
            errors.push(diagnostic(
                config_file,
                "$.browser.viewports",
                "at least one mobile viewport is required",
            ));
        }
        for pattern in &config.rules.ignore_console {
            if Regex::new(pattern).is_err() {
                errors.push(diagnostic(
                    config_file,
                    "$.rules.ignore_console",
                    "invalid console filter expression",
                ));
            }
        }
        for pattern in config.rules.disable.iter().chain(&config.seed.migrations) {
            if Glob::new(pattern).is_err() {
                errors.push(diagnostic(
                    config_file,
                    "$",
                    format!("invalid glob {pattern}"),
                ));
            }
        }
        if config.harness.default == "pi" && config.harness.auth == "subscription" {
            errors.push(diagnostic(
                config_file,
                "$.harness.auth",
                "subscription authentication requires codex",
            ));
        }
        let mut journeys = BTreeMap::new();
        let mut candidates = BTreeMap::new();
        for (path, bytes) in snapshot {
            let Some(file) = path.strip_prefix(".rio/qa/journeys/") else {
                continue;
            };
            if file.contains('/') || !file.ends_with(".yaml") {
                continue;
            }
            let candidate = file.ends_with(".proposed.yaml");
            let stem = file
                .strip_suffix(if candidate { ".proposed.yaml" } else { ".yaml" })
                .unwrap();
            let journey: Journey = parse_document(DocumentKind::Journey, path, bytes)?;
            if journey.name != stem {
                errors.push(diagnostic(
                    path,
                    "$.name",
                    "journey name must equal the file stem",
                ));
            }
            if !candidate && journey.sync_reason.is_some() {
                errors.push(diagnostic(
                    path,
                    "$.sync_reason",
                    "sync_reason is allowed only on proposed journeys",
                ));
            }
            validate_journey(
                &journey,
                path,
                &personas,
                &viewports,
                snapshot,
                &mut errors,
                &mut warnings,
            );
            if candidate {
                candidates.insert(journey.name.clone(), journey);
            } else {
                journeys.insert(journey.name.clone(), journey);
            }
        }
        validate_graph(&journeys, ".rio/qa/journeys", &mut errors);
        validate_chain_viewports(&journeys, &viewports, None, &mut errors);
        // Each candidate is checked as a prospective replacement, but never enters
        // the runnable set or satisfies a committed journey's dependency.
        for (name, candidate) in &candidates {
            let mut proposed = journeys.clone();
            proposed.insert(name.clone(), candidate.clone());
            validate_chain_viewports(&proposed, &viewports, Some(name), &mut errors);
            validate_graph(
                &proposed,
                &format!(".rio/qa/journeys/{name}.proposed.yaml"),
                &mut errors,
            );
        }
        let seed = snapshot
            .get(&config.seed.manifest)
            .map(|bytes| {
                parse_document::<SeedManifest>(DocumentKind::Seed, &config.seed.manifest, bytes)
            })
            .transpose()?;
        if let Some(seed) = &seed {
            validate_seed(
                seed,
                &config.seed.manifest,
                &personas,
                snapshot,
                &mut errors,
            );
        }
        let fixtures_file = ".rio/qa/fixtures/fixtures.yaml";
        let fixtures = snapshot
            .get(fixtures_file)
            .map(|bytes| {
                parse_document::<FixtureManifest>(DocumentKind::Fixtures, fixtures_file, bytes)
            })
            .transpose()?;
        if let Some(fixtures) = &fixtures {
            validate_fixtures(fixtures, fixtures_file, snapshot, &mut errors);
        }
        let default_time = fixtures
            .as_ref()
            .and_then(|fixtures| fixtures.defaults.time.as_deref());
        validate_chain_times(&journeys, default_time, None, &mut errors);
        for (name, candidate) in &candidates {
            let mut proposed = journeys.clone();
            proposed.insert(name.clone(), candidate.clone());
            validate_chain_times(&proposed, default_time, Some(name), &mut errors);
        }
        fail(errors)?;
        Ok(Self {
            config,
            journeys,
            candidates,
            seed,
            fixtures,
            viewports,
            warnings,
        })
    }
}

/// Equality on every dependency edge enforces one instant across the whole
/// connected chain, including branching chains and multiple prerequisites.
fn validate_chain_times(
    journeys: &BTreeMap<String, Journey>,
    default_time: Option<&str>,
    candidate: Option<&String>,
    errors: &mut Vec<QaDiagnostic>,
) {
    static FIXED_TIME: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^\d{4}-\d\d-\d\d[Tt]\d\d:\d\d:[0-5]\d(?:\.\d{1,9})?(?:[Zz]|[+-]\d\d:\d\d)$")
            .unwrap()
    });
    let parse = |value: &str| {
        if !FIXED_TIME.is_match(value) {
            return Err(());
        }
        value.parse::<jiff::Timestamp>().map_err(|_| ())
    };
    if default_time.is_some_and(|value| parse(value).is_err()) {
        errors.push(diagnostic(
            ".rio/qa/fixtures/fixtures.yaml",
            "$.defaults.time",
            "invalid fixed instant",
        ));
        return;
    }
    let mut times = BTreeMap::new();
    for (name, journey) in journeys {
        let value = journey.context.time.as_deref().or(default_time);
        let parsed = value.map(parse).transpose();
        match parsed {
            Ok(time) => {
                times.insert(name, time);
            }
            Err(_) => errors.push(diagnostic(
                &format!(
                    ".rio/qa/journeys/{name}{}.yaml",
                    if candidate == Some(name) {
                        ".proposed"
                    } else {
                        ""
                    }
                ),
                "$.context.time",
                "invalid fixed instant in journey context or fixture defaults",
            )),
        }
    }
    for (name, journey) in journeys {
        for (index, dependency) in journey.after.iter().enumerate() {
            if let (Some(time), Some(predecessor)) = (times.get(name), times.get(dependency))
                && time != predecessor
            {
                errors.push(diagnostic(
                    &format!(".rio/qa/journeys/{name}{}.yaml", if candidate == Some(name) { ".proposed" } else { "" }),
                    &format!("$.after[{index}]"),
                    format!("incompatible chain times: {name} and prerequisite {dependency} must resolve to the same fixed instant (or both use live time); journey context overrides fixture defaults; changing app time would require a restart")
                        + &candidate.map_or_else(String::new, |name| format!(" (proposed replacement: {name}.proposed.yaml)")),
                ));
            }
        }
    }
}

/// A dependent must be runnable in the same cell as every prerequisite. Extra
/// prerequisite viewports are allowed; silently expanding either declaration is not.
fn validate_chain_viewports(
    journeys: &BTreeMap<String, Journey>,
    viewports: &BTreeMap<String, Viewport>,
    candidate: Option<&String>,
    errors: &mut Vec<QaDiagnostic>,
) {
    let resolved = |journey: &Journey| -> BTreeSet<String> {
        journey
            .viewports
            .clone()
            .unwrap_or_else(|| viewports.keys().cloned().collect())
            .into_iter()
            .collect()
    };
    for (name, journey) in journeys {
        for (index, dependency) in journey.after.iter().enumerate() {
            let Some(prerequisite) = journeys.get(dependency) else {
                continue;
            };
            let missing: Vec<_> = resolved(journey)
                .difference(&resolved(prerequisite))
                .cloned()
                .collect();
            if !missing.is_empty() {
                let source = candidate
                    .filter(|candidate| *candidate == name)
                    .map_or_else(
                        || format!(".rio/qa/journeys/{name}.yaml"),
                        |name| format!(".rio/qa/journeys/{name}.proposed.yaml"),
                    );
                errors.push(diagnostic(&source, &format!("$.after[{index}]"), format!(
                    "incompatible chain matrices: {name} requires viewport(s) {} excluded by prerequisite {dependency}; narrow the dependent or expand the prerequisite explicitly",
                    missing.join(", ")
                ) + &candidate.map_or_else(String::new, |candidate| format!(" (proposed replacement: {candidate}.proposed.yaml)"))));
            }
        }
    }
}

fn validate_journey(
    journey: &Journey,
    source: &str,
    personas: &BTreeSet<String>,
    viewports: &BTreeMap<String, Viewport>,
    snapshot: &QaSnapshot,
    errors: &mut Vec<QaDiagnostic>,
    warnings: &mut Vec<QaDiagnostic>,
) {
    if !personas.contains(&journey.persona) {
        errors.push(diagnostic(
            source,
            "$.persona",
            format!(
                "unknown persona {}; declare it in .rio/qa.yaml",
                journey.persona
            ),
        ));
    }
    let selected = journey
        .viewports
        .clone()
        .unwrap_or_else(|| viewports.keys().cloned().collect());
    for name in &selected {
        if !viewports.contains_key(name) {
            errors.push(diagnostic(
                source,
                "$.viewports",
                format!("unknown viewport {name} in .rio/qa.yaml"),
            ));
        }
    }
    if !selected
        .iter()
        .any(|name| viewports.get(name).is_some_and(|v| v.mobile))
        && !(journey.desktop_only
            && journey
                .reason
                .as_ref()
                .is_some_and(|s| !s.trim().is_empty()))
    {
        errors.push(diagnostic(
            source,
            "$.viewports",
            "a mobile viewport is required unless desktop_only has a reason",
        ));
    }
    for (index, glob) in journey.covers.paths.iter().enumerate() {
        let path = format!("$.covers.paths[{index}]");
        match Glob::new(glob) {
            Ok(glob) => {
                let matcher = glob.compile_matcher();
                if !snapshot.keys().any(|file| matcher.is_match(file)) {
                    warnings.push(diagnostic(
                        source,
                        &path,
                        "coverage glob matches no file in the head snapshot",
                    ));
                }
            }
            Err(_) => errors.push(diagnostic(source, &path, "invalid coverage glob")),
        }
    }
    static CREDENTIAL: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(
        r"(?i)(?:\b(?:type|enter|paste)\s+\S+.*\b(?:password|token|secret|credential)\b|\b(?:password|token|secret)\s*[:=]\s*\S+)"
    ).unwrap()
    });
    for (index, step) in journey.steps.iter().enumerate() {
        if [&Some(step.action.clone()), &step.hint, &step.expect]
            .iter()
            .any(|text| text.as_ref().is_some_and(|text| CREDENTIAL.is_match(text)))
        {
            warnings.push(diagnostic(
                source,
                &format!("$.steps[{index}]"),
                "step may contain a credential; use the persona login tool",
            ));
        }
    }
    for (index, reference) in journey.guidance_refs.iter().enumerate() {
        if reference.end_line < reference.start_line {
            errors.push(diagnostic(
                source,
                &format!("$.guidance_refs[{index}]"),
                "guidance line range is reversed",
            ));
        }
    }
}

fn validate_graph(
    journeys: &BTreeMap<String, Journey>,
    source: &str,
    errors: &mut Vec<QaDiagnostic>,
) {
    for journey in journeys.values() {
        for dependency in &journey.after {
            if !journeys.contains_key(dependency) {
                errors.push(diagnostic(
                    source,
                    "$.after",
                    format!("{} references unknown journey {dependency}", journey.name),
                ));
            }
        }
    }
    let mut remaining: BTreeSet<_> = journeys.keys().cloned().collect();
    loop {
        let ready: Vec<_> = remaining
            .iter()
            .filter(|name| {
                journeys[*name]
                    .after
                    .iter()
                    .all(|dep| !remaining.contains(dep))
            })
            .cloned()
            .collect();
        if ready.is_empty() {
            break;
        }
        for name in ready {
            remaining.remove(&name);
        }
    }
    if !remaining.is_empty() {
        errors.push(diagnostic(
            source,
            "$.after",
            format!(
                "journey dependency cycle affects: {}",
                remaining.into_iter().collect::<Vec<_>>().join(", ")
            ),
        ));
    }
}

fn manifest_path(source: &str, file: &str) -> String {
    if file.starts_with(".rio/") {
        file.into()
    } else {
        format!(
            "{}/{file}",
            source.rsplit_once('/').map_or("", |(parent, _)| parent)
        )
    }
}

fn validate_seed(
    seed: &SeedManifest,
    source: &str,
    personas: &BTreeSet<String>,
    snapshot: &QaSnapshot,
    errors: &mut Vec<QaDiagnostic>,
) {
    let mut names = BTreeSet::new();
    for datastore in &seed.datastores {
        if !names.insert(datastore.name.clone()) {
            errors.push(diagnostic(
                source,
                "$.datastores",
                format!("duplicate datastore {}", datastore.name),
            ));
        }
    }
    let mut referenced = BTreeSet::new();
    for (index, step) in seed.steps.iter().enumerate() {
        for target in &step.applies_to {
            if !names.contains(target) {
                errors.push(diagnostic(
                    source,
                    &format!("$.steps[{index}].applies_to"),
                    format!("unknown datastore {target}"),
                ));
            }
        }
        if let Some(file) = &step.file {
            let path = manifest_path(source, file);
            if !snapshot.contains_key(&path) {
                errors.push(diagnostic(
                    source,
                    &format!("$.steps[{index}].file"),
                    format!("missing seed file {path}"),
                ));
            }
            referenced.insert(path);
        }
    }
    let mut users = BTreeSet::new();
    for user in &seed.users {
        if !personas.contains(&user.persona) || !users.insert(&user.persona) {
            errors.push(diagnostic(
                source,
                "$.users",
                format!("unknown or duplicate persona {}", user.persona),
            ));
        }
    }
    for (path, data) in snapshot {
        if path.starts_with(".rio/qa/seed/")
            && (path.starts_with(".rio/qa/seed/.cache/")
                || (data.len() > 5 * 1024 * 1024 && !referenced.contains(path)))
        {
            errors.push(diagnostic(
                path,
                "$",
                "materialized seed state belongs in the cache, not the repository",
            ));
        }
    }
}

fn validate_fixtures(
    fixtures: &FixtureManifest,
    source: &str,
    snapshot: &QaSnapshot,
    errors: &mut Vec<QaDiagnostic>,
) {
    let mut names = BTreeSet::new();
    for (index, file) in fixtures.files.iter().enumerate() {
        if !names.insert(&file.name) {
            errors.push(diagnostic(
                source,
                "$.files",
                format!("duplicate fixture {}", file.name),
            ));
        }
        if let Some(path) = &file.path {
            match snapshot.get(path) {
                None => errors.push(diagnostic(
                    source,
                    &format!("$.files[{index}].path"),
                    format!("missing fixture {path}"),
                )),
                Some(bytes) if bytes.len() > 1024 * 1024 => errors.push(diagnostic(
                    source,
                    &format!("$.files[{index}].path"),
                    "committed fixtures are limited to 1 MiB; use generate",
                )),
                _ => (),
            }
        }
    }
    let mut names = BTreeSet::new();
    let mut claims = BTreeSet::new();
    for service in &fixtures.services {
        if !names.insert(&service.name) {
            errors.push(diagnostic(
                source,
                "$.services",
                format!("duplicate service {}", service.name),
            ));
        }
        if let Some(behavior) = &service.default_behavior
            && !service.behaviors.contains(behavior)
        {
            errors.push(diagnostic(
                source,
                "$.services.default_behavior",
                "default behavior is not declared",
            ));
        }
        for claim in &service.claims {
            // A hostname without a port claims both HTTP and HTTPS.
            let (host, ports) = match claim.rsplit_once(':') {
                Some((host, port)) => (host.to_ascii_lowercase(), vec![port]),
                None => (claim.to_ascii_lowercase(), vec!["80", "443"]),
            };
            for port in ports {
                if !claims.insert((host.clone(), port.to_string())) {
                    errors.push(diagnostic(
                        source,
                        "$.services.claims",
                        "multiple services claim the same host and port",
                    ));
                }
            }
        }
    }
}

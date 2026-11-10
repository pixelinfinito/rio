use crate::diagnostics::normalized_path;
use crate::{
    DiagnosticContext, ProcessResult, ProcessSupervisor, ResolvedTool, Termination, ToolCommand,
    analyze_source, evaluate_exit, tool_contract,
};
use anyhow::{Context, Result, ensure};
use rio_core::{
    Category, CheckDetails, CheckOutcome, EvidenceLevel, ExcludedFile, FailureReason, Finding,
    Location, OccurrenceState, Severity, Source, State, finding_id,
};
use rio_git::{Diff, FileDiff, LineRange, Tree};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileCoverage {
    pub instrumented: BTreeSet<u32>,
    pub executed: BTreeSet<u32>,
    pub excluded: BTreeSet<u32>,
}
pub type CoverageData = BTreeMap<String, FileCoverage>;

/// A run that excludes a line cannot erase another run's instrumentation or
/// execution of that line. This matters for coverage from dependent roots.
pub fn merge_coverage(destination: &mut CoverageData, source: CoverageData) {
    for (path, coverage) in source {
        let merged = destination.entry(path).or_default();
        merged.instrumented.extend(coverage.instrumented);
        merged.executed.extend(coverage.executed);
        merged.excluded.extend(coverage.excluded);
    }
}

pub fn parse_lcov(bytes: &[u8], context: &DiagnosticContext<'_>) -> Result<CoverageData> {
    let mut result = CoverageData::new();
    let mut path = None;
    let mut coverage = FileCoverage::default();
    for line in std::str::from_utf8(bytes)?.lines().map(str::trim) {
        if let Some(file) = line.strip_prefix("SF:") {
            ensure!(path.is_none(), "LCOV file missing end_of_record");
            path = Some(normalized_path(file, context)?);
        } else if let Some(record) = line.strip_prefix("DA:") {
            ensure!(path.is_some(), "LCOV DA without a file");
            let mut parts = record.split(',');
            let line: u32 = parts.next().context("LCOV line missing")?.parse()?;
            ensure!(line > 0, "LCOV line is zero");
            let count: u64 = parts.next().context("LCOV hit count missing")?.parse()?;
            coverage.instrumented.insert(line);
            if count > 0 {
                coverage.executed.insert(line);
            }
        } else if line == "end_of_record" {
            let file = path.take().context("LCOV end_of_record without a file")?;
            merge_coverage(&mut result, [(file, std::mem::take(&mut coverage))].into());
        }
    }
    ensure!(path.is_none(), "incomplete LCOV record");
    ensure!(!result.is_empty(), "coverage output has no LCOV records");
    Ok(result)
}

fn lines(value: &Value) -> Result<BTreeSet<u32>> {
    value
        .as_array()
        .context("coverage line list is not an array")?
        .iter()
        .filter(|line| line.as_u64() != Some(0)) // coverage.py uses 0 for an empty module.
        .map(|line| {
            Ok(u32::try_from(
                line.as_u64().context("coverage line is not an integer")?,
            )?)
        })
        .collect()
}

pub fn parse_python_coverage(
    bytes: &[u8],
    context: &DiagnosticContext<'_>,
) -> Result<CoverageData> {
    let value: Value = serde_json::from_slice(bytes)?;
    let mut result = CoverageData::new();
    for (path, file) in value["files"]
        .as_object()
        .context("coverage.py output has no files mapping")?
    {
        let executed = lines(&file["executed_lines"])?;
        let mut instrumented = executed.clone();
        instrumented.extend(lines(&file["missing_lines"])?);
        let excluded = lines(&file["excluded_lines"])?;
        instrumented.retain(|line| !excluded.contains(line));
        result.insert(
            normalized_path(path, context)?,
            FileCoverage {
                instrumented,
                executed,
                excluded,
            },
        );
    }
    Ok(result)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CoverageSettings {
    pub root: String,
    pub language: String,
    #[serde(default)]
    pub invocation_root: Option<String>,
    #[serde(default)]
    pub runner_args: Vec<String>,
    #[serde(default)]
    pub vitest_browser_mode: bool,
    pub include: Option<Vec<String>>,
    pub exclude: Vec<String>,
    /// False when configuration uses computed expressions we cannot evaluate.
    pub static_known: bool,
    pub reports_unloaded: bool,
    pub add_python_source: bool,
    #[serde(default)]
    pub python_parallel: bool,
    pub notes: Vec<String>,
}

impl CoverageSettings {
    pub fn excludes(&self, path: &str) -> Result<bool> {
        let path = if self.root == "." {
            path
        } else {
            path.strip_prefix(&format!("{}/", self.root))
                .unwrap_or(path)
        };
        fn matches(path: &str, patterns: &[String]) -> Result<bool> {
            let mut matched = false;
            for pattern in patterns {
                let (negative, pattern) = pattern
                    .strip_prefix('!')
                    .map_or((false, pattern.as_str()), |pattern| (true, pattern));
                let glob = globset::GlobBuilder::new(pattern)
                    .literal_separator(false)
                    .build()?
                    .compile_matcher();
                if glob.is_match(path) {
                    matched = !negative;
                }
            }
            Ok(matched)
        }
        let outside_include = match &self.include {
            Some(patterns) => !matches(path, patterns)?,
            None => false,
        };
        Ok(matches(path, &self.exclude)? || outside_include)
    }
}

pub fn is_test_path(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    path.split('/')
        .any(|part| matches!(part, "tests" | "test" | "__tests__"))
        || name.starts_with("test_")
        || name.contains(".test.")
        || name.contains(".spec.")
        || name.ends_with("_test.py")
        || name == "conftest.py"
}

#[derive(Default)]
pub struct CoverageFindings {
    pub findings: Vec<Finding>,
    pub excluded: Vec<ExcludedFile>,
}

// Remove only parsed type nodes. Preserve the remaining source text, including
// newlines: an unchanged token sequence can still change automatic semicolons.
struct TypeErasure<'a> {
    source: &'a [u8],
    line_starts: Vec<usize>,
    ranges: Vec<std::ops::Range<usize>>,
}

impl TypeErasure<'_> {
    fn byte_range(&self, lines: LineRange) -> std::ops::Range<usize> {
        if lines.count == 0 {
            return 0..0;
        }
        let start = lines.start.saturating_sub(1) as usize;
        self.line_starts
            .get(start)
            .copied()
            .unwrap_or(self.source.len())
            ..self
                .line_starts
                .get(start + lines.count as usize)
                .copied()
                .unwrap_or(self.source.len())
    }

    fn contains_type(&self, range: &std::ops::Range<usize>) -> bool {
        self.ranges
            .iter()
            .any(|erased| erased.start < range.end && range.start < erased.end)
    }

    fn runtime_text(&self, range: std::ops::Range<usize>) -> String {
        let mut output = Vec::new();
        let mut cursor = range.start;
        for erased in &self.ranges {
            if erased.end <= range.start || erased.start >= range.end {
                continue;
            }
            let start = erased.start.max(range.start);
            output.extend_from_slice(&self.source[cursor..start]);
            cursor = erased.end.min(range.end);
        }
        output.extend_from_slice(&self.source[cursor..range.end]);
        String::from_utf8(output)
            .expect("type and line boundaries preserve UTF-8")
            .trim()
            .to_owned()
    }
}

fn typescript_type_erasure<'a>(path: &str, source: &'a [u8]) -> Result<Option<TypeErasure<'a>>> {
    let parsed = crate::parse_source(path, source)?;
    if parsed.root_node().has_error() {
        return Ok(None);
    }
    fn collect(node: tree_sitter::Node<'_>, ranges: &mut Vec<std::ops::Range<usize>>) {
        let mut cursor = node.walk();
        let erased = matches!(
            node.kind(),
            "type_annotation"
                | "type_arguments"
                | "type_parameters"
                | "interface_declaration"
                | "type_alias_declaration"
                | "ambient_declaration"
        ) || matches!(node.kind(), "import_statement" | "export_statement")
            && node.children(&mut cursor).any(|child| {
                child.kind() == "type"
                    || matches!(
                        child.kind(),
                        "interface_declaration" | "type_alias_declaration"
                    )
            });
        if erased {
            ranges.push(node.byte_range());
        } else {
            for child in node.children(&mut cursor) {
                collect(child, ranges);
            }
        }
    }
    let mut ranges = Vec::new();
    collect(parsed.root_node(), &mut ranges);
    Ok(Some(TypeErasure {
        source,
        line_starts: std::iter::once(0)
            .chain(
                source
                    .iter()
                    .enumerate()
                    .filter(|(_, byte)| **byte == b'\n')
                    .map(|(index, _)| index + 1),
            )
            .collect(),
        ranges,
    }))
}

fn type_only_changes(base: &Tree, tree: &Tree, file: &FileDiff) -> Result<BTreeSet<u32>> {
    let mut ignored = BTreeSet::new();
    if !matches!(
        file.path.rsplit('.').next(),
        Some("ts" | "tsx" | "mts" | "cts")
    ) {
        return Ok(ignored);
    }
    let old_path = file.old_path.as_deref().unwrap_or(&file.path);
    let before = base
        .get(old_path)
        .map_or(&[][..], |entry| entry.content.as_slice());
    let after = &tree[&file.path].content;
    let (Some(before), Some(after)) = (
        typescript_type_erasure(&file.path, before)?,
        typescript_type_erasure(&file.path, after)?,
    ) else {
        return Ok(ignored);
    };
    for hunk in &file.hunks {
        let old = before.byte_range(hunk.base);
        let new = after.byte_range(hunk.head);
        let has_types = before.contains_type(&old) || after.contains_type(&new);
        if has_types && before.runtime_text(old) == after.runtime_text(new) {
            ignored.extend(hunk.head.start..hunk.head.start + hunk.head.count);
        }
    }
    Ok(ignored)
}

/// Merge every root's data before calling this function. Otherwise a shared
/// package covered by its consumer can be incorrectly reported as untested.
pub fn diff_coverage(
    base: &Tree,
    tree: &Tree,
    diff: &Diff,
    data: &CoverageData,
    settings: &[CoverageSettings],
) -> Result<CoverageFindings> {
    let mut result = CoverageFindings::default();
    for file in &diff.files {
        if file.binary
            || file.excluded.is_some()
            || is_test_path(&file.path)
            || crate::language_for_path(&file.path).is_none()
        {
            continue;
        }
        let Some(source) = tree.get(&file.path) else {
            continue;
        };
        let syntax = analyze_source(&file.path, &source.content)?;
        let added: BTreeSet<_> = file
            .hunks
            .iter()
            .flat_map(|hunk| hunk.head.start..hunk.head.start + hunk.head.count)
            .collect();
        let type_only = type_only_changes(base, tree, file)?;
        let instrumented = if let Some(coverage) = data.get(&file.path) {
            coverage
                .instrumented
                .difference(&coverage.executed)
                .filter(|line| !coverage.excluded.contains(line))
                .copied()
                .collect::<BTreeSet<_>>()
        } else {
            if syntax.executable_lines.is_disjoint(&added) {
                continue;
            }
            let relevant: Vec<_> = settings
                .iter()
                .filter(|settings| {
                    crate::language_for_path(&file.path) == Some(settings.language.as_str())
                        && (settings.root == "."
                            || file.path.starts_with(&format!("{}/", settings.root)))
                })
                .collect();
            if !relevant.is_empty()
                && relevant
                    .iter()
                    .all(|settings| settings.excludes(&file.path).unwrap_or(false))
            {
                result.excluded.push(ExcludedFile {
                    path: file.path.clone(),
                    reason: "coverage_excluded".into(),
                });
                continue;
            }
            // A source heuristic cannot prove that a line was instrumented.
            // Only report entries establish executable lines for diff coverage.
            result.excluded.push(ExcludedFile {
                path: file.path.clone(),
                reason: "coverage_not_instrumented".into(),
            });
            continue;
        };
        let mut groups = BTreeMap::<String, BTreeSet<u32>>::new();
        for line in instrumented.intersection(&added) {
            if type_only.contains(line) {
                continue;
            }
            let symbol = syntax
                .symbols
                .iter()
                .filter(|symbol| {
                    matches!(
                        symbol.kind,
                        crate::SymbolKind::Function | crate::SymbolKind::Method
                    ) && symbol.line_start <= *line
                        && *line <= symbol.line_end
                })
                .min_by_key(|symbol| symbol.byte_end - symbol.byte_start)
                .map(|symbol| symbol.symbol_path.clone())
                .unwrap_or_default();
            groups.entry(symbol).or_default().insert(*line);
        }
        for (symbol, lines) in groups {
            let mut ranges: Vec<(u32, u32)> = Vec::new();
            for line in lines {
                if let Some((_, end)) = ranges.last_mut()
                    && *end + 1 == line
                {
                    *end = line;
                } else {
                    ranges.push((line, line));
                }
            }
            let locations: Vec<_> = ranges
                .iter()
                .map(|(start, end)| Location {
                    cell: None,
                    evidence: None,
                    path: file.path.clone(),
                    line_start: *start,
                    line_end: *end,
                    column: None,
                    symbol_path: symbol.clone(),
                    occurrence_state: OccurrenceState::New,
                    id: None,
                })
                .collect();
            let range_text = ranges
                .iter()
                .map(|(start, end)| {
                    if start == end {
                        start.to_string()
                    } else {
                        format!("{start}-{end}")
                    }
                })
                .collect::<Vec<_>>()
                .join(", ");
            let message =
                format!("Changed executable lines are not covered by tests: {range_text}");
            result.findings.push(Finding {
                qa: None,
                id: finding_id(
                    "coverage/untested_change",
                    &file.path,
                    &symbol,
                    "changed executable lines not covered",
                    "",
                ),
                rule_id: "coverage/untested_change".into(),
                category: Category::Risk,
                evidence_level: EvidenceLevel::StaticProven,
                severity: Severity::Warning,
                state: State::New,
                location: locations[0].clone(),
                locations,
                message,
                trigger: "execution reaches the changed lines".into(),
                impact: None,
                suggested_fix: Some("Add a test that executes the changed behavior".into()),
                evidence: vec!["merged coverage".into()],
                source: Source::Tool {
                    tool: "coverage".into(),
                    version: "merged".into(),
                },
                advisory: None,
                verification: None,
                round: None,
                first_posted_in: None,
                status: None,
                resolution: None,
                author_response: None,
                history: None,
                council: None,
            });
        }
    }
    Ok(result)
}

pub struct CoverageRun {
    pub data: CoverageData,
    pub outcome: CheckOutcome,
    pub processes: Vec<ProcessResult>,
}

pub struct CoverageRequest<'a> {
    pub tool: &'a ResolvedTool,
    pub settings: &'a CoverageSettings,
    pub tool_tree: &'a Path,
    pub worktree_root: Option<&'a Path>,
    pub timeout: Duration,
    pub output_limit: usize,
}

pub async fn run_coverage(
    request: CoverageRequest<'_>,
    supervisor: &ProcessSupervisor,
    cancellation: CancellationToken,
) -> CoverageRun {
    if request.tool.name == "cargo-llvm-cov" {
        return crate::rust_coverage::run(request, supervisor, cancellation).await;
    }
    let started = Instant::now();
    let tool = request.tool;
    let execution_root = request
        .settings
        .invocation_root
        .as_deref()
        .unwrap_or(&request.settings.root);
    let root = request.tool_tree.join(execution_root);
    let output = root.join(".rio-coverage");
    let mut provider = None;
    if tool.name == "vitest" {
        let unavailable = if request.settings.vitest_browser_mode {
            Some((
                rio_core::SkipReason::NotSupportedByAdapter,
                "coverage_unavailable: browser mode requires a browser environment",
            ))
        } else {
            let providers = vitest_coverage_providers(&root, &tool.version);
            match providers.as_slice() {
                [] => Some((
                    rio_core::SkipReason::ToolMissing,
                    "coverage_unavailable: no installed Vitest coverage provider is resolvable from the execution root",
                )),
                [installed] => {
                    provider = Some(*installed);
                    None
                }
                _ => None, // Preserve the project's choice when both are available.
            }
        };
        if let Some((reason, hint)) = unavailable {
            return CoverageRun {
                data: CoverageData::new(),
                outcome: CheckOutcome::Skipped {
                    reason,
                    details: CheckDetails {
                        hint: Some(hint.into()),
                        ..Default::default()
                    },
                },
                processes: Vec::new(),
            };
        }
    }
    let failure = |message: String, processes| CoverageRun {
        data: CoverageData::new(),
        outcome: CheckOutcome::Failed {
            reason: FailureReason::UnparseableOutput,
            details: CheckDetails {
                hint: Some(crate::redact(&message)),
                ..Default::default()
            },
        },
        processes,
    };
    if let Err(error) = std::fs::create_dir_all(&output) {
        return CoverageRun {
            data: CoverageData::new(),
            outcome: CheckOutcome::Failed {
                reason: if error.raw_os_error() == Some(28) {
                    FailureReason::DiskFull
                } else {
                    FailureReason::SpawnFailed
                },
                details: CheckDetails {
                    hint: Some(error.to_string()),
                    ..Default::default()
                },
            },
            processes: Vec::new(),
        };
    }
    let mut command = ToolCommand::new(tool.path.clone(), root.clone());
    let (module, report_path) = match tool.name.as_str() {
        "vitest" => {
            command = vitest_coverage_command(tool, &root, &output);
            command
                .args
                .extend(request.settings.runner_args.iter().map(Into::into));
            if let Some(provider) = provider {
                command
                    .args
                    .push(format!("--coverage.provider={provider}").into());
            }
            ("rio/adapter-typescript", output.join("lcov.info"))
        }
        "jest" => {
            command.args = vec![
                "--coverage".into(),
                "--coverageReporters=lcov".into(),
                format!("--coverageDirectory={}", output.display()).into(),
                "--maxWorkers=2".into(),
            ];
            ("rio/adapter-typescript", output.join("lcov.info"))
        }
        "coverage" => {
            command.args.push("run".into());
            if request.settings.add_python_source {
                command
                    .args
                    .push(format!("--source={}", root.display()).into());
            }
            command
                .args
                .extend(["-m".into(), "pytest".into(), "-q".into()]);
            command.env.insert(
                "COVERAGE_FILE".into(),
                output.join(".coverage").into_os_string(),
            );
            ("rio/adapter-python", output.join("coverage.json"))
        }
        _ => {
            return failure(
                format!("unsupported coverage tool {}", tool.name),
                Vec::new(),
            );
        }
    };
    command.timeout = request.timeout;
    command.output_limit = request.output_limit;
    command.env.insert("CI".into(), "1".into());
    let result = supervisor.run(command, cancellation.clone()).await;
    if tool.name != "coverage"
        && result.cleanup_confirmed
        && matches!(
            result.termination,
            Termination::Exited { code: Some(0 | 1) }
        )
        && [
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr),
        ]
        .iter()
        .any(|text| text.contains("No test files found") || text.contains("No tests found"))
    {
        return CoverageRun {
            data: CoverageData::new(),
            outcome: CheckOutcome::Skipped {
                reason: rio_core::SkipReason::NoTests,
                details: CheckDetails {
                    hint: Some("The project's test runner found no tests".into()),
                    ..Default::default()
                },
            },
            processes: vec![result],
        };
    }
    let spec = tool_contract(module, "coverage", &tool.name).expect("built-in coverage contract");
    let mut outcome = evaluate_exit(&result, &spec.exit_codes, Ok(Vec::new()));
    let may_export = result.cleanup_confirmed
        && matches!(
            result.termination,
            Termination::Exited { code: Some(0 | 1) }
        );
    let mut processes = vec![result];
    if tool.name == "coverage" && may_export {
        if request.settings.python_parallel {
            let mut command = ToolCommand::new(tool.path.clone(), root.clone());
            command.args = vec!["combine".into(), "--keep".into()];
            command.env.insert(
                "COVERAGE_FILE".into(),
                output.join(".coverage").into_os_string(),
            );
            command.timeout = request.timeout.saturating_sub(started.elapsed());
            command.output_limit = request.output_limit;
            let result = supervisor.run(command, cancellation.clone()).await;
            let succeeded = matches!(result.termination, Termination::Exited { code: Some(0) });
            let combine_outcome = evaluate_exit(
                &result,
                &crate::ExitCodeContract {
                    clean: vec![0],
                    ..Default::default()
                },
                Ok(Vec::new()),
            );
            processes.push(result);
            if !succeeded {
                return CoverageRun {
                    data: CoverageData::new(),
                    outcome: combine_outcome,
                    processes,
                };
            }
        }
        let mut command = ToolCommand::new(tool.path.clone(), root);
        command.args = vec![
            "json".into(),
            "-o".into(),
            report_path.clone().into_os_string(),
        ];
        command.env.insert(
            "COVERAGE_FILE".into(),
            output.join(".coverage").into_os_string(),
        );
        command.timeout = request.timeout.saturating_sub(started.elapsed());
        command.output_limit = request.output_limit;
        let result = supervisor.run(command, cancellation).await;
        if !matches!(result.termination, Termination::Exited { code: Some(0) }) {
            let export_contract = crate::ExitCodeContract {
                clean: vec![0],
                ..Default::default()
            };
            outcome = evaluate_exit(&result, &export_contract, Ok(Vec::new()));
        }
        processes.push(result);
    }
    let context = DiagnosticContext {
        repository_root: request.tool_tree,
        project_root: execution_root,
        tool_version: &tool.version,
        worktree_root: request.worktree_root,
        sources: None,
    };
    let data = std::fs::read(report_path)
        .map_err(anyhow::Error::from)
        .and_then(|bytes| {
            if tool.name == "coverage" {
                parse_python_coverage(&bytes, &context)
            } else {
                parse_lcov(&bytes, &context)
            }
        });
    let data = match data {
        Ok(data) => data,
        Err(error) if matches!(outcome, CheckOutcome::Passed { .. }) => {
            return failure(error.to_string(), processes);
        }
        Err(_) => CoverageData::new(),
    };
    let has_coverage = data.values().any(|file| !file.instrumented.is_empty());
    let runner_exit = processes
        .first()
        .and_then(|process| match process.termination {
            Termination::Exited { code: Some(code) } if code != 0 => Some(code),
            _ => None,
        });
    if !has_coverage && let Some(code) = runner_exit {
        let stderr = String::from_utf8_lossy(&processes[0].stderr);
        let first_line = stderr.lines().map(str::trim).find(|line| !line.is_empty());
        outcome.details_mut().hint = Some(crate::redact(&format!(
            "Test runner exited with code {code} without producing usable coverage{}",
            first_line.map_or_else(String::new, |line| format!(": {line}"))
        )));
    } else if has_coverage
        && matches!(
            outcome,
            CheckOutcome::Failed {
                reason: FailureReason::TestsFailed,
                ..
            }
        )
    {
        let count = processes.first().and_then(|process| {
            let text = String::from_utf8_lossy(&process.stdout);
            regex::Regex::new(r"(\d+) failed")
                .unwrap()
                .captures(&text)
                .and_then(|captures| captures[1].parse::<usize>().ok())
        });
        outcome.details_mut().hint = Some(format!(
            "{}; usable coverage from the incomplete run is retained",
            count.map_or_else(
                || "Tests failed (see raw output for details)".into(),
                |count| format!("{count} tests failed")
            )
        ));
    }
    CoverageRun {
        data,
        outcome,
        processes,
    }
}

pub fn vitest_supports_all(version: &str) -> bool {
    version
        .trim_start_matches("vitest/")
        .split('.')
        .next()
        .and_then(|part| part.parse::<u64>().ok())
        .is_some_and(|major| major < 4)
}

/// Follow Node's ancestor node_modules lookup, including workspace symlinks.
/// Do not infer availability from declarations or unrelated pnpm store entries.
fn vitest_coverage_providers(root: &std::path::Path, version: &str) -> Vec<&'static str> {
    let mut parts = version.trim_start_matches("vitest/").split('.');
    let legacy = parts.next() == Some("0")
        && parts
            .next()
            .and_then(|minor| minor.parse::<u64>().ok())
            .is_some_and(|minor| minor < 32);
    let default = if legacy { "c8" } else { "v8" };
    [default, "istanbul"]
        .into_iter()
        .filter(|provider| {
            let name = format!("@vitest/coverage-{provider}");
            root.ancestors().any(|directory| {
                let manifest = directory
                    .join("node_modules")
                    .join(&name)
                    .join("package.json");
                std::fs::read(manifest)
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
                    .is_some_and(|value| value["name"].as_str() == Some(&name))
            })
        })
        .collect()
}

/// Version-specific argv is kept together so unsupported flags never reach CAC.
pub fn vitest_coverage_command(
    tool: &crate::ResolvedTool,
    root: &std::path::Path,
    output: &std::path::Path,
) -> ToolCommand {
    let mut command = ToolCommand::new(tool.path.clone(), root.into());
    command.args = vec![
        "run".into(),
        "--coverage.enabled".into(),
        "--coverage.reporter=lcov".into(),
        format!("--coverage.reportsDirectory={}", output.display()).into(),
    ];
    if vitest_supports_all(&tool.version) {
        command.args.push("--coverage.all".into());
    }
    let major = tool
        .version
        .trim_start_matches("vitest/")
        .split('.')
        .next()
        .and_then(|part| part.parse::<u64>().ok());
    if major == Some(1) {
        for (name, value) in [
            ("VITEST_MAX_THREADS", "2"),
            ("VITEST_MIN_THREADS", "1"),
            ("VITEST_MAX_FORKS", "2"),
            ("VITEST_MIN_FORKS", "1"),
        ] {
            command.env.insert(name.into(), value.into());
        }
    } else {
        command.args.push("--maxWorkers=2".into());
        if matches!(major, Some(2 | 3)) {
            command.args.push("--minWorkers=1".into());
        }
    }
    command
}

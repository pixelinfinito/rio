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

// Compare parsed tokens rather than deleting `: ...` or `<...>` with a regex:
// object properties, comparisons and string contents must remain runtime code.
struct RuntimeTokens<'a> {
    tokens: Vec<(LineRange, &'a str)>,
    types: Vec<LineRange>,
}

fn typescript_runtime_tokens<'a>(
    path: &str,
    source: &'a [u8],
) -> Result<Option<RuntimeTokens<'a>>> {
    let parsed = crate::parse_source(path, source)?;
    if parsed.root_node().has_error() {
        return Ok(None);
    }
    fn collect<'a>(node: tree_sitter::Node<'_>, source: &'a [u8], result: &mut RuntimeTokens<'a>) {
        let range = LineRange {
            start: node.start_position().row as u32 + 1,
            count: (node.end_position().row - node.start_position().row) as u32 + 1,
        };
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
            result.types.push(range);
        } else if node.kind().contains("comment") {
            // Comments do not change runtime behavior.
        } else if node.child_count() == 0 {
            result.tokens.push((
                range,
                std::str::from_utf8(&source[node.byte_range()]).unwrap_or_default(),
            ));
        } else {
            for child in node.children(&mut cursor) {
                collect(child, source, result);
            }
        }
    }
    let mut result = RuntimeTokens {
        tokens: Vec::new(),
        types: Vec::new(),
    };
    collect(parsed.root_node(), source, &mut result);
    Ok(Some(result))
}

fn overlaps(left: LineRange, right: LineRange) -> bool {
    left.count > 0
        && right.count > 0
        && left.start < right.start + right.count
        && right.start < left.start + left.count
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
        typescript_runtime_tokens(old_path, before)?,
        typescript_runtime_tokens(&file.path, after)?,
    ) else {
        return Ok(ignored);
    };
    for hunk in &file.hunks {
        let has_types = before.types.iter().any(|range| overlaps(*range, hunk.base))
            || after.types.iter().any(|range| overlaps(*range, hunk.head));
        fn tokens<'a>(tokens: &RuntimeTokens<'a>, range: LineRange) -> Vec<&'a str> {
            tokens
                .tokens
                .iter()
                .filter(|(lines, _)| overlaps(*lines, range))
                .map(|(_, text)| *text)
                .collect::<Vec<_>>()
        }
        if has_types && tokens(&before, hunk.base) == tokens(&after, hunk.head) {
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
                    path: file.path.clone(),
                    line_start: *start,
                    line_end: *end,
                    column: None,
                    symbol_path: symbol.clone(),
                    occurrence_state: OccurrenceState::New,
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
    let started = Instant::now();
    let tool = request.tool;
    let root = request.tool_tree.join(&request.settings.root);
    let output = root.join(".rio-coverage");
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
            command.args = vec![
                "run".into(),
                "--coverage".into(),
                "--coverage.reporter=lcov".into(),
                format!("--coverage.reportsDirectory={}", output.display()).into(),
            ];
            if vitest_supports_all(&tool.version) {
                command.args.push("--coverage.all".into());
            }
            // Leave room for concurrent checks and prevent unbounded worker
            // creation on hosts with many cores.
            command
                .args
                .extend(["--maxWorkers=2".into(), "--minWorkers=1".into()]);
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
        project_root: &request.settings.root,
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

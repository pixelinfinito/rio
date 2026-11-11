#![cfg(feature = "review")]
//! The `review` flow: start, live, findings, dismissal, graph, export, exit.

mod common;

use std::collections::BTreeMap;

use ratatui::{buffer::Buffer, crossterm::event::KeyCode, layout::Rect};
use rio_core::{
    BlindMatch, Category, CheckDetails, CheckEntry, CheckKind, CheckOutcome, EvidenceLevel,
    Finding, LifecycleStatus, Lineage, LineageKind, Location, OccurrenceState, Ratio, Reconsider,
    ReconsiderItem, Report, ReportStatus, ReviewEvent, Severity, SkipReason, Source, State,
    Verification, Version,
};
use rio_tui::{
    App, Effect, Msg, Outcome, Screen, Session, Theme, Token,
    app::press,
    canvas::Canvas,
    review::{
        self, AgentCount, ChangeSet, ChangedFile, CheckRow, DoctorRoot, DoctorTool, ExitData,
        ExitFinding, ExportOptions, FindingCounts, FindingLabel, FindingsData, GraphData,
        GraphEdge, GraphFinding, GraphNode, Hunk, HunkLine, HunkLineKind, ItemState,
        LineageFinding, LineageHistory, LineageRound, LiveData, LiveState, MachineCheck,
        MachineState, NextStep, NodeKind, NodeState, PresetInfo, RootRow, SavedReport,
        SelectionKind, StartData, Usage,
    },
};

// ---------------------------------------------------------------- sample data

const BRANCH: &str = "feature/parser-guards";
const CONTEXT: &str = "feature/parser-guards → origin/main · rio/openrouter · standard";

fn ident(prefix: &str) -> String {
    format!("{prefix}{}", "0".repeat(64 - prefix.len()))
}

fn file(status: char, path: &str, added: usize, removed: usize) -> ChangedFile {
    ChangedFile {
        status,
        path: path.into(),
        added,
        removed,
    }
}

fn start_data() -> StartData {
    let preset = |name: &str, description: &str, agents: &[&str], quorum| PresetInfo {
        name: name.into(),
        description: description.into(),
        agents: agents.iter().map(|a| a.to_string()).collect(),
        quorum,
    };
    let tool = |name: &str, version: Option<&str>, role: &str| DoctorTool {
        name: name.into(),
        version: version.map(str::to_owned),
        role: role.into(),
    };
    StartData {
        repository: "~/code/web-app".into(),
        branch: BRANCH.into(),
        version: "0.2.0".into(),
        base: "origin/main".into(),
        changes: vec![
            ChangeSet {
                kind: SelectionKind::Branch,
                description: "vs merge base of origin/main".into(),
                files: 12,
                added: 184,
                removed: 41,
                listed: vec![
                    file('M', "src/parser/header.ts", 38, 12),
                    file('M', "src/parser/body.ts", 51, 9),
                    file('A', "src/parser/index.ts", 44, 0),
                    file('M', "src/router.ts", 6, 4),
                    file('M', "api/handlers/upload.py", 27, 10),
                    file('A', "test/parser.spec.ts", 18, 0),
                ],
            },
            ChangeSet {
                kind: SelectionKind::WorkingTree,
                description: "tree + staged + untracked vs HEAD".into(),
                files: 3,
                added: 22,
                removed: 5,
                listed: vec![file('M', "src/router.ts", 22, 5)],
            },
            ChangeSet {
                kind: SelectionKind::Staged,
                description: "index vs HEAD".into(),
                files: 1,
                added: 4,
                removed: 1,
                listed: vec![file('M', "src/router.ts", 4, 1)],
            },
        ],
        selection: SelectionKind::Branch,
        profiles: vec!["rio/openrouter".into(), "rio/anthropic".into()],
        profile: "rio/openrouter".into(),
        profile_source: ".rio/profiles/default.yaml".into(),
        presets: vec![
            preset(
                "quick",
                "triage + 2 agents + quorum 1",
                &["correctness", "security"],
                1,
            ),
            preset(
                "standard",
                "triage + 5 agents + quorum 3",
                &[
                    "correctness",
                    "security",
                    "performance",
                    "tests",
                    "contracts",
                ],
                3,
            ),
            preset(
                "deep",
                "triage + 7 agents + quorum 5",
                &[
                    "correctness",
                    "security",
                    "performance",
                    "tests",
                    "contracts",
                    "concurrency",
                    "api",
                ],
                5,
            ),
        ],
        preset: "standard".into(),
        since_last: true,
        since_last_note: "continue lineage · next is round 4 of cap 3".into(),
        since_last_capped: true,
        offline: false,
        show_pre_existing: false,
        roots: vec![
            DoctorRoot {
                root: "web/".into(),
                language: "typescript".into(),
                lockfile: Some("pnpm-lock.yaml".into()),
                tools: vec![
                    tool("tsc", Some("5.6"), "typecheck"),
                    tool("eslint", Some("9.12"), "lint"),
                    tool("vitest", Some("2.1"), "coverage"),
                ],
                lockfile_matches: Some(true),
            },
            DoctorRoot {
                root: "api/".into(),
                language: "python".into(),
                lockfile: Some("uv.lock".into()),
                tools: vec![
                    tool("pyright", Some("1.1"), "typecheck"),
                    tool("ruff", Some("0.7"), "lint"),
                    tool("pytest", None, "coverage"),
                ],
                lockfile_matches: Some(true),
            },
        ],
        machine: vec![
            MachineCheck {
                state: MachineState::Ok,
                text: "cache .rio/cache · 41 GB free".into(),
            },
            MachineCheck {
                state: MachineState::Ok,
                text: "endpoint · paired worker".into(),
            },
            MachineCheck {
                state: MachineState::Info,
                text: "budget $2.00 · parallelism 4".into(),
            },
        ],
        warnings: vec![
            "api/ coverage will be skipped: the review completes, marked incomplete".into(),
        ],
        live_note: "hops 2 · max 2000 nodes · tools not network-isolated".into(),
    }
}

#[allow(clippy::too_many_arguments)]
fn finding(
    prefix: &str,
    rule: &str,
    category: Category,
    severity: Severity,
    evidence: EvidenceLevel,
    state: State,
    path: &str,
    line: u32,
    message: &str,
) -> Finding {
    Finding {
        id: ident(prefix),
        rule_id: rule.into(),
        category,
        evidence_level: evidence,
        severity,
        state,
        location: Location {
            path: path.into(),
            line_start: line,
            line_end: line,
            column: None,
            symbol_path: String::new(),
            occurrence_state: OccurrenceState::New,
            id: None,
            cell: None,
            evidence: None,
        },
        message: message.into(),
        trigger: String::new(),
        impact: None,
        suggested_fix: None,
        fix: None,
        evidence: Vec::new(),
        source: Source::Agent {
            agent: "correctness".into(),
            cached: None,
        },
        locations: Vec::new(),
        advisory: None,
        verification: None,
        round: None,
        first_posted_in: None,
        status: None,
        resolution: None,
        author_response: None,
        history: None,
        qa: None,
        council: None,
        trace: None,
    }
}

fn findings_list() -> (Vec<Finding>, Vec<Finding>) {
    use Category::*;
    use EvidenceLevel::*;
    use Severity::*;
    let mut null_deref = finding(
        "8c1e4a9b",
        "correctness/null-deref",
        Defect,
        Error,
        StaticProven,
        State::New,
        "src/parser/header.ts",
        42,
        "Possible null dereference in parseHeader",
    );
    null_deref.location.symbol_path = "parseHeader".into();
    null_deref.trigger = "request without content-type".into();
    null_deref.impact = Some("3 callers".into());
    null_deref.evidence = vec!["code:head:header.ts:n41,n42".into()];
    null_deref.verification = Some(Verification {
        voters: 3,
        agreeing: 2,
        blind_match: vec![BlindMatch::Same, BlindMatch::Related, BlindMatch::None],
        split: false,
    });
    let findings = vec![
        null_deref,
        finding(
            "3a90c2d1",
            "typecheck/tsc/TS2322",
            Defect,
            Error,
            StaticProven,
            State::New,
            "src/a.ts",
            12,
            "Type 'string' is not assignable to type 'number'.",
        ),
        finding(
            "b41c7e02",
            "coverage/drop",
            Defect,
            Warning,
            Reproduced,
            State::Worsened,
            "src/parser/body.ts",
            0,
            "coverage 81% → 64%",
        ),
        finding(
            "0d6a5f13",
            "lint/eslint/no-floating-promises",
            Defect,
            Warning,
            StaticProven,
            State::New,
            "src/queue.ts",
            17,
            "no-floating-promises",
        ),
        finding(
            "e2195b84",
            "tests/missing-case",
            Risk,
            Info,
            Plausible,
            State::Unclassified,
            "src/parser/index.ts",
            9,
            "no test for empty input",
        ),
        finding(
            "77ab0c35",
            "lint/eslint/no-unused-vars",
            Defect,
            Info,
            StaticProven,
            State::PreExisting,
            "src/util.ts",
            3,
            "unused import",
        ),
        finding(
            "99aa0000",
            "correctness/refuted",
            Defect,
            Error,
            Refuted,
            State::New,
            "src/x.ts",
            1,
            "refuted hypothesis",
        ),
    ];
    let security = vec![finding(
        "f7d26a40",
        "security/secret-in-log",
        Security,
        Error,
        Plausible,
        State::New,
        "src/api/client.ts",
        88,
        "token logged on retry",
    )];
    (findings, security)
}

fn check(kind: CheckKind, root: &str, outcome: CheckOutcome, wall_time_ms: u64) -> CheckEntry {
    CheckEntry {
        kind,
        language: "typescript".into(),
        root: root.into(),
        version: Version::Head,
        scheduled_as: rio_core::ScheduledAs::Changed,
        outcome,
        wall_time_ms,
        cached: false,
    }
}

fn passed() -> CheckOutcome {
    CheckOutcome::Passed {
        details: CheckDetails::default(),
    }
}

fn flagged(severity: Severity) -> CheckOutcome {
    let mut f = finding(
        "11110000",
        "lint/x",
        Category::Defect,
        severity,
        EvidenceLevel::StaticProven,
        State::New,
        "src/x.ts",
        1,
        "x",
    );
    let mut g = f.clone();
    g.id = ident("22220000");
    f.severity = Severity::Warning;
    CheckOutcome::Findings {
        details: CheckDetails {
            hint: None,
            dependency_state: None,
            findings: vec![f, g],
        },
    }
}

fn skipped(reason: SkipReason) -> CheckOutcome {
    CheckOutcome::Skipped {
        reason,
        details: CheckDetails::default(),
    }
}

fn report() -> Report {
    let mut report = Report::empty(ReportStatus::Complete);
    let (findings, security) = findings_list();
    report.findings = findings;
    report.security = security;
    report.summary.pre_existing = 2;
    report.review.id = Some("1234567890ab".into());
    report.review.run_id = Some("01J9ZK4Q".into());
    report.review.rio_version = "0.2.0".into();
    report.metrics.wall_time_ms = 134_000;
    report.checks = vec![
        check(CheckKind::Typecheck, "web/", passed(), 1800),
        check(CheckKind::Lint, "web/", flagged(Severity::Error), 900),
        check(CheckKind::Coverage, "web/", passed(), 4200),
        check(CheckKind::Secrets, ".", passed(), 200),
        check(
            CheckKind::Dependencies,
            ".",
            skipped(SkipReason::Offline),
            0,
        ),
    ];
    report.lineage = Some(Lineage {
        repository: "github.com/pixelinfinito/rio".into(),
        kind: LineageKind::Branch,
        reference: BRANCH.into(),
        generation: 1,
        round: 4,
        cap: 3,
        capped: true,
        diff_only: true,
        previous_head: None,
        held_back: 1,
        rounds_to_pass: None,
        author_response_ratio: Ratio::new(0.5),
        reconsider: Some(Reconsider {
            unresolved: 2,
            top: vec![
                ReconsiderItem {
                    id: ident("8c1e4a9b"),
                    title: "Possible null dereference in parseHeader".into(),
                    path: "src/parser/header.ts".into(),
                    line_start: 42,
                },
                ReconsiderItem {
                    id: ident("3a90c2d1"),
                    title: "TS2322".into(),
                    path: "src/a.ts".into(),
                    line_start: 12,
                },
            ],
            split: Some(vec!["parser/core.ts".into(), "parser/render.ts".into()]),
        }),
    });
    report
}

fn labels() -> BTreeMap<String, FindingLabel> {
    let label = |title: &str, place: &str| FindingLabel {
        title: title.into(),
        place: place.into(),
    };
    BTreeMap::from([
        (
            ident("8c1e4a9b"),
            label("null deref in parseHeader", "header.ts:42"),
        ),
        (
            ident("3a90c2d1"),
            label("TS2322 string → number", "src/a.ts:12"),
        ),
        (
            ident("f7d26a40"),
            label("token logged on retry", "client.ts:88"),
        ),
    ])
}

fn hunk() -> Hunk {
    let line = |number, kind, text: &str| HunkLine {
        number,
        kind,
        text: text.into(),
    };
    use HunkLineKind::*;
    Hunk {
        path: "src/parser/header.ts".into(),
        header: "@@ -38,7 +38,9 @@".into(),
        lines: vec![
            line(38, Context, "function parseHeader(raw: Raw): Header {"),
            line(39, Context, "  const fields = splitFields(raw)"),
            line(40, Removed, "  const type = fields.get('ctype') ?? DEFAULT"),
            line(40, Added, "  const type = fields.get('ctype')"),
            line(41, Added, "  const charset = type.params.charset"),
            line(42, Added, "  return { type, cs: charset.toLowerCase() }"),
            line(43, Context, "}"),
        ],
        cited: vec![41, 42],
        note: Some("type may be undefined; line 41 reads .params".into()),
    }
}

fn graph_data() -> GraphData {
    let node = |id: &str, kind, place: &str, path: &str, line, state| GraphNode {
        id: id.into(),
        label: id.into(),
        kind,
        path: path.into(),
        line,
        line_end: line,
        place: place.into(),
        hop: 1,
        state,
        in_head: true,
        in_base: true,
        untested: false,
        delta: None,
        findings: Vec::new(),
    };
    use NodeKind::*;
    use NodeState::*;
    let mut seed = node(
        "parseHeader",
        Function,
        "header.ts:38",
        "src/parser/header.ts",
        38,
        Changed,
    );
    seed.line_end = 46;
    seed.hop = 0;
    seed.delta = Some("a3f9 → 7c21".into());
    seed.findings = vec![GraphFinding {
        id: ident("8c1e4a9b"),
        title: "null deref".into(),
        failing: true,
    }];
    let mut accept = node(
        "acceptUpload",
        Function,
        "upload.ts:21",
        "src/upload.ts",
        21,
        Dependent,
    );
    accept.untested = true;
    let mut split = node(
        "splitFields",
        Function,
        "header.ts:12",
        "src/parser/header.ts",
        12,
        Changed,
    );
    split.hop = 0;
    let edge = |from: &str, to: &str, kind: &str, probable| GraphEdge {
        from: from.into(),
        to: to.into(),
        kind: kind.into(),
        probable,
        in_head: true,
        in_base: false,
    };
    GraphData {
        context: "feature/parser-guards → origin/main".into(),
        seed: "parseHeader".into(),
        nodes: vec![
            seed,
            node(
                "handleRequest",
                Function,
                "router.ts:54",
                "src/router.ts",
                54,
                Dependent,
            ),
            accept,
            node(
                "Proxy.forward",
                Method,
                "proxy.ts:88",
                "src/proxy.ts",
                88,
                Dependent,
            ),
            node(
                "parser.spec",
                Test,
                "parser.spec.ts",
                "test/parser.spec.ts",
                1,
                Dependent,
            ),
            node(
                "createServer",
                Function,
                "server.ts:10",
                "src/server.ts",
                10,
                Dependent,
            ),
            node(
                "uploadRoute",
                Function,
                "routes/upload.ts:7",
                "src/routes/upload.ts",
                7,
                Dependent,
            ),
            node(
                "legacy.js",
                Unresolved,
                "plugins · text",
                "plugins/legacy.js",
                1,
                Unchanged,
            ),
            split,
            node(
                "parseBody",
                Function,
                "body.ts:30",
                "src/parser/body.ts",
                30,
                Dependent,
            ),
            node(
                "body.spec",
                Test,
                "body.spec.ts",
                "test/body.spec.ts",
                1,
                Dependent,
            ),
        ],
        edges: vec![
            edge("handleRequest", "parseHeader", "calls", false),
            edge("acceptUpload", "parseHeader", "calls", false),
            edge("Proxy.forward", "parseHeader", "calls", false),
            edge("parser.spec", "parseHeader", "tests", false),
            edge("createServer", "handleRequest", "calls", false),
            edge("uploadRoute", "acceptUpload", "calls", false),
            edge("legacy.js", "Proxy.forward", "refs", true),
            edge("parseHeader", "splitFields", "calls", false),
            edge("parseBody", "splitFields", "calls", false),
            edge("body.spec", "parseBody", "tests", false),
        ],
        total_nodes: 41,
        total_edges: 63,
        max_nodes: 2000,
        complete: true,
        hops: 2,
        kinds: "all kinds".into(),
    }
}

fn findings_data() -> FindingsData {
    let mut data = FindingsData::new(report(), CONTEXT);
    data.exit_code = Some(1);
    data.failing = vec![ident("8c1e4a9b"), ident("3a90c2d1")];
    data.policy = "new defects with static_proven or stronger evidence".into();
    data.labels = labels();
    data.hunks = BTreeMap::from([(ident("8c1e4a9b"), hunk())]);
    data.agents = [
        ("correctness", 2),
        ("security", 1),
        ("performance", 0),
        ("tests", 1),
        ("contracts", 0),
    ]
    .into_iter()
    .map(|(name, findings)| AgentCount {
        name: name.into(),
        findings,
    })
    .collect();
    data.refuted = 3;
    data.cost = "$0.41 · 182k in / 21k out".into();
    data.graphs = BTreeMap::from([(ident("8c1e4a9b"), graph_data())]);
    let round = |round, findings, note: &str, snapshot: &str| LineageRound {
        round,
        findings,
        note: note.into(),
        snapshot: snapshot.into(),
    };
    let lf = |prefix: &str, status, note: &str| LineageFinding {
        id: ident(prefix),
        status,
        note: note.into(),
    };
    data.lineage = Some(LineageHistory {
        rounds: vec![
            round(1, 5, "full review", "3e1a"),
            round(2, 3, "diff only", "7b20"),
            round(3, 2, "diff only", "c4d8"),
            round(4, 2, "diff only", "7c21"),
        ],
        findings: vec![
            lf("8c1e4a9b", LifecycleStatus::Open, "first posted R1"),
            lf("3a90c2d1", LifecycleStatus::Open, "first posted R1"),
            lf("b41c7e02", LifecycleStatus::Fixed, "fixed in R3"),
            lf("e2195b84", LifecycleStatus::Dismissed, "intentional"),
        ],
    });
    data.endpoint = true;
    data.actor = "you@example.com (git config user.email)".into();
    data.export = ExportOptions {
        context: "feature/parser-guards → origin/main · standard · round 4".into(),
        path: "./rio-review-parser-guards.md".into(),
        kept: ".rio/cache/1234567890ab/runs/01J9ZK4Q/ (latest)".into(),
        copy: true,
        include_pre_existing: false,
        open_editor: false,
    };
    data
}

fn live_data() -> LiveData {
    let mut state = LiveState::new(
        [
            "correctness",
            "security",
            "performance",
            "tests",
            "contracts",
        ]
        .map(String::from)
        .to_vec(),
    );
    let set_step = |state: &mut LiveState, name: &str, s, note: &str, started, elapsed| {
        let row = state.steps.iter_mut().find(|r| r.name == name).unwrap();
        row.state = s;
        row.note = note.into();
        row.started_ms = started;
        row.elapsed_ms = elapsed;
    };
    use ItemState::*;
    set_step(
        &mut state,
        "prepare",
        Passed,
        "snapshot a41f…c09",
        Some(0),
        Some(400),
    );
    set_step(&mut state, "checks", Running, "", Some(33_800), None);
    set_step(
        &mut state,
        "graph",
        Passed,
        "41 nodes · 63 edges",
        Some(0),
        Some(700),
    );
    set_step(
        &mut state,
        "triage",
        Passed,
        "6 hypotheses",
        Some(0),
        Some(3100),
    );
    set_step(&mut state, "agents", Running, "", None, None);
    set_step(
        &mut state,
        "verify",
        Queued,
        "quorum 2 of 3 · waiting",
        None,
        None,
    );
    state.steps[4].progress = Some((3, 5));
    state.roots = vec![
        RootRow {
            root: "web/".into(),
            language: "typescript".into(),
        },
        RootRow {
            root: "api/".into(),
            language: "python".into(),
        },
    ];
    let check = |root: &str, kind, label: &str, tool: &str, s, note: &str, started, elapsed| {
        let mut row = CheckRow::new(root, kind, label, tool);
        row.state = s;
        row.note = note.into();
        row.started_ms = started;
        row.elapsed_ms = elapsed;
        row
    };
    use CheckKind::*;
    state.checks = vec![
        check(
            "web/",
            Typecheck,
            "typecheck",
            "tsc",
            Passed,
            "",
            None,
            Some(1800),
        ),
        check(
            "web/",
            Lint,
            "lint",
            "eslint",
            Flagged,
            "eslint · 2 findings",
            None,
            Some(900),
        ),
        check(
            "web/",
            Coverage,
            "coverage",
            "vitest",
            Running,
            "",
            Some(36_000),
            None,
        ),
        check(
            "api/",
            Typecheck,
            "typecheck",
            "pyright",
            Passed,
            "",
            None,
            Some(2300),
        ),
        check("api/", Lint, "lint", "ruff", Passed, "", None, Some(100)),
        check(
            "api/",
            Coverage,
            "coverage",
            "pytest",
            Skipped,
            "skipped: pytest missing",
            None,
            None,
        ),
        check(
            ".",
            Secrets,
            "secrets",
            "secrets",
            Passed,
            "0 found",
            None,
            Some(200),
        ),
        check(
            ".",
            Dependencies,
            "audit",
            "osv",
            Running,
            "osv.dev · 3 packages",
            None,
            None,
        ),
    ];
    let agent = |state: &mut LiveState, i: usize, s, note: &str, elapsed| {
        let row = &mut state.agents[i];
        row.state = s;
        row.note = note.into();
        row.elapsed_ms = elapsed;
    };
    agent(&mut state, 0, Passed, "2 hypotheses", Some(9800));
    agent(&mut state, 1, Passed, "1 hypothesis", Some(7200));
    agent(&mut state, 2, Running, "reading graph slice…", None);
    agent(&mut state, 3, Running, "vitest job 7…", None);
    state.quorum = 3;
    state.counts = FindingCounts {
        new: 3,
        worsened: 1,
        security: 1,
        pre_existing: 2,
    };
    state.usage = Some(Usage {
        tokens_in: 141_000,
        tokens_out: 16_000,
        cost_cents: 32,
        budget_cents: 200,
    });
    state.eta_ms = Some(80_000);
    for (at, source, line) in [
        (41, "vitest", "✓ parser.spec.ts · 14 tests · 812ms"),
        (42, "eslint", "src/queue.ts:17 no-floating-promises"),
        (44, "agents", "correctness → 2 hypotheses to verify"),
        (45, "osv", "querybatch 3 packages · cache hit 2"),
        (46, "agents", "tests → spawned job 7 (vitest)"),
        (47, "vitest", "◐ body.spec.ts running…"),
        (48, "agents", "performance → graph slice parseHeader"),
    ] {
        state.push_log(at * 1000, source, line);
    }
    let mut data = LiveData::new(
        CONTEXT.into(),
        "rio review --base origin/main --preset standard --profile rio/openrouter --since-last"
            .into(),
        format!("Reviewing {BRANCH}"),
        state,
    );
    data.note = "hops 2 · max 2000 nodes · tools not network-isolated".into();
    data
}

fn exit_data() -> ExitData {
    let (findings, _) = findings_list();
    ExitData {
        version: "0.2.0".into(),
        status: "complete".into(),
        branch: BRANCH.into(),
        base: Some("origin/main".into()),
        preset: "standard".into(),
        policy: "policy failed: 2 findings match fail_on".into(),
        failed: true,
        failing: vec![
            ExitFinding::from_finding(&findings[0], Some("null deref in parseHeader")),
            ExitFinding::from_finding(&findings[1], Some("TS2322 string → number")),
        ],
        counts: "7 findings · 3 new · 1 worsened · 1 security · 2 pre-existing hidden".into(),
        lineage: Some(
            "1 dismissed (intentional) · round 4 of cap 3 → reconsider: split parser core / renderer"
                .into(),
        ),
        lineage_warn: true,
        saved: Some(SavedReport {
            path: "./rio-review-parser-guards.md".into(),
            size: "14.2 KB".into(),
            copied: true,
        }),
        kept: Some(".rio/cache/1234567890ab/runs/01J9ZK4Q/".into()),
        next: Some(NextStep {
            before: "fix, then".into(),
            command: "rio review --since-last".into(),
            after: "(round 5, diff only)".into(),
        }),
    }
}

// ---------------------------------------------------------------- helpers

fn open(screen: Box<dyn Screen>) -> App {
    App::new(screen, Theme::default())
}

fn keys(app: &mut App, codes: &[KeyCode]) -> Vec<Effect> {
    codes.iter().flat_map(|c| app.update(press(*c))).collect()
}

fn typed(app: &mut App, text: &str) -> Vec<Effect> {
    text.chars()
        .flat_map(|c| app.update(press(KeyCode::Char(c))))
        .collect()
}

/// Render the top screen of `app` with its session.
fn draw(app: &App, cols: u16, rows: u16, theme: Theme) -> Buffer {
    let area = Rect::new(0, 0, cols, rows);
    let mut buf = Buffer::empty(area);
    let mut c = Canvas::new(&mut buf, area, theme);
    app.top().draw(&mut c, &app.session);
    buf
}

fn text(buf: &Buffer) -> String {
    common::lines(buf)
}

fn assert_fits(buf: &Buffer) {
    let width = buf.area.width as usize;
    for line in common::lines(buf).lines() {
        assert_eq!(unicode_width::UnicodeWidthStr::width(line), width, "{line}");
    }
}

fn findings_app() -> App {
    let mut app = open(review::findings(findings_data()));
    app.session.report = Some(report());
    // The design focuses parseHeader's finding. In the spec's order (severity,
    // evidence, then path and line) `src/a.ts` comes first, so it is second.
    keys(&mut app, &[KeyCode::Down]);
    app
}

fn live_app() -> App {
    let mut app = open(review::live(live_data()));
    app.session.ticks = 192;
    // The cursor on the tests agent, as the design shows.
    keys(&mut app, &[KeyCode::Down; 16]);
    app
}

fn dismiss_app() -> App {
    let mut app = findings_app();
    keys(
        &mut app,
        &[
            KeyCode::Char('d'),
            KeyCode::Down,
            KeyCode::Down,
            KeyCode::Tab,
        ],
    );
    typed(&mut app, "documented behavior");
    app
}

fn graph_app() -> App {
    let mut app = findings_app();
    keys(
        &mut app,
        &[KeyCode::Char('g'), KeyCode::Char('v'), KeyCode::Char('v')],
    );
    app
}

fn export_app() -> App {
    let mut data = findings_data();
    data.report.checks = vec![
        check(CheckKind::Typecheck, "web/", passed(), 1800),
        check(CheckKind::Lint, "web/", flagged(Severity::Error), 900),
        check(
            CheckKind::Coverage,
            "web/",
            flagged(Severity::Warning),
            4200,
        ),
        check(CheckKind::Typecheck, "api/", passed(), 2300),
        check(CheckKind::Lint, "api/", passed(), 100),
        check(
            CheckKind::Coverage,
            "api/",
            skipped(SkipReason::ToolMissing),
            0,
        ),
        check(CheckKind::Secrets, ".", passed(), 200),
    ];
    data.report.footer.notes = vec!["1 finding was dismissed, and 1 was fixed".into()];
    let mut app = open(review::findings(data));
    app.session.report = Some(report());
    keys(&mut app, &[KeyCode::Char('x'), KeyCode::Tab]);
    app
}

fn exit_buffer() -> Buffer {
    let area = Rect::new(0, 0, 120, 40);
    let mut buf = Buffer::empty(area);
    let mut c = Canvas::new(&mut buf, area, Theme::default());
    c.clear(Token::Bg);
    for (i, row) in review::exit_summary(&exit_data()).iter().enumerate() {
        c.row(1 + i as u16, row, Token::Bg);
    }
    buf
}

// ---------------------------------------------------------------- goldens

#[test]
fn start_matches_its_design() {
    let buf = common::render(review::start(start_data()), Session::default(), 120, 40);
    common::assert_screen("review-00-start", &buf);
}

#[test]
fn live_matches_its_design() {
    let app = live_app();
    common::assert_screen(
        "review-01-live-review",
        &draw(&app, 120, 40, Theme::default()),
    );
}

#[test]
fn findings_match_their_design() {
    let app = findings_app();
    common::assert_screen("review-02-findings", &draw(&app, 120, 40, Theme::default()));
}

#[test]
fn dismissal_matches_its_design() {
    let app = dismiss_app();
    common::assert_screen(
        "review-03-lineage-feedback",
        &draw(&app, 120, 40, Theme::default()),
    );
}

#[test]
fn graph_matches_its_design() {
    let app = graph_app();
    common::assert_screen(
        "review-04-impact-graph",
        &draw(&app, 120, 40, Theme::default()),
    );
}

#[test]
fn export_matches_its_design() {
    let app = export_app();
    common::assert_screen(
        "review-05-summary-export",
        &draw(&app, 120, 40, Theme::default()),
    );
}

#[test]
fn exit_summary_matches_its_design() {
    common::assert_rows("review-06-exit", &exit_buffer(), 1..=13);
    let text = review::exit_text(&exit_data());
    assert!(text.starts_with(" ⋯ interactive session closed · terminal restored\n"));
    assert!(text.contains("● 8c1e4a9b  null deref in parseHea…  src/parser/header.ts:42"));
    assert_eq!(text.lines().count(), 13);
}

// ---------------------------------------------------------------- start

#[test]
fn flags_preselect_the_start_form_and_its_command_line() {
    let mut data = start_data();
    data.selection = SelectionKind::Branch;
    data.preset = "deep".into();
    data.since_last = false;
    let mut app = open(review::start(data));
    let screen = text(&draw(&app, 120, 40, Theme::default()));
    assert!(screen.contains("(•) branch vs base"), "{screen}");
    assert!(
        screen.contains("$ rio review --base origin/main --preset deep"),
        "{screen}"
    );
    assert!(screen.contains("triage + 7 agents + quorum 5"));
    assert_eq!(
        keys(&mut app, &[KeyCode::Char('c')]),
        vec![Effect::Copy(
            "rio review --base origin/main --preset deep --profile rio/openrouter".into()
        )]
    );

    // Staged and offline from the command line.
    let mut data = start_data();
    data.selection = SelectionKind::Staged;
    data.offline = true;
    data.since_last = false;
    let mut app = open(review::start(data));
    assert_eq!(
        keys(&mut app, &[KeyCode::Char('c')]),
        vec![Effect::Copy(
            "rio review --staged --preset standard --profile rio/openrouter --offline".into()
        )]
    );
}

#[test]
fn the_command_line_follows_the_choices() {
    let mut app = open(review::start(start_data()));
    // Working tree, the deep preset, then show pre-existing on and since-last off.
    keys(
        &mut app,
        &[
            KeyCode::Down,
            KeyCode::Right,
            KeyCode::Tab,
            KeyCode::Tab,
            KeyCode::Char(' '),
            KeyCode::Down,
            KeyCode::Down,
            KeyCode::Char(' '),
        ],
    );
    let screen = text(&draw(&app, 120, 40, Theme::default()));
    assert!(screen.contains("(•) working tree"), "{screen}");
    assert!(
        screen.contains("$ rio review --preset deep --profile rio/openrouter"),
        "{screen}"
    );
    assert!(screen.contains("--show-pre-existing"), "{screen}");
    assert!(!screen.contains("--since-last"), "{screen}");
    assert!(screen.contains("CHANGES · 3 FILES"), "{screen}");
    assert_eq!(
        keys(&mut app, &[KeyCode::Char('d')]),
        vec![Effect::Step("review:doctor".into())]
    );
}

#[test]
fn copy_copies_the_shown_command() {
    let mut app = open(review::start(start_data()));
    assert_eq!(
        keys(&mut app, &[KeyCode::Char('c')]),
        vec![Effect::Copy(
            "rio review --base origin/main --preset standard --profile rio/openrouter --since-last"
                .into()
        )]
    );
}

#[test]
fn enter_starts_with_the_shown_arguments_and_opens_the_live_screen() {
    let mut app = open(review::start(start_data()));
    let effects = keys(&mut app, &[KeyCode::Enter]);
    assert_eq!(
        effects,
        vec![Effect::Start(
            [
                "review",
                "--base",
                "origin/main",
                "--preset",
                "standard",
                "--profile",
                "rio/openrouter",
                "--since-last"
            ]
            .map(String::from)
            .to_vec()
        )]
    );
    assert_eq!(app.top().title(), "Live review");
    assert_eq!(app.stack.len(), 1, "the start screen replaced itself");
    let screen = text(&draw(&app, 120, 40, Theme::default()));
    assert!(screen.contains("Reviewing feature/parser-guards"));
    assert!(
        screen.contains("· - coverage      skipped: pytest missing"),
        "{screen}"
    );
    assert!(screen.contains("○ contracts"), "{screen}");
}

// ---------------------------------------------------------------- live

#[test]
fn live_turns_events_into_step_states_and_opens_findings_on_done() {
    let mut app = open(review::start(start_data()));
    keys(&mut app, &[KeyCode::Enter]);
    let event = |e: ReviewEvent| Msg::Review(e);
    for _ in 0..4 {
        app.update(Msg::Tick);
    }
    app.update(event(ReviewEvent::StepStarted {
        step: "prepare".into(),
    }));
    for _ in 0..2 {
        app.update(Msg::Tick);
    }
    app.update(event(ReviewEvent::StepFinished {
        step: "prepare".into(),
    }));
    app.update(event(ReviewEvent::StepStarted {
        step: "checks".into(),
    }));
    for _ in 0..6 {
        app.update(Msg::Tick);
    }
    app.update(event(ReviewEvent::CheckFinished {
        kind: CheckKind::Lint,
        root: "web/".into(),
        findings: 2,
        skipped: false,
        outcome: flagged(Severity::Error),
    }));
    app.update(event(ReviewEvent::Log {
        source: "eslint".into(),
        line: "src/queue.ts:17 no-floating-promises".into(),
    }));
    app.update(event(ReviewEvent::Log {
        source: "tsc".into(),
        line: "tsc --noEmit".into(),
    }));
    app.update(event(ReviewEvent::StepStarted {
        step: "agents".into(),
    }));
    app.update(event(ReviewEvent::AgentStarted {
        agent: "correctness".into(),
    }));
    app.update(Msg::Tick);
    app.update(event(ReviewEvent::AgentFinished {
        agent: "correctness".into(),
        hypotheses: 2,
    }));
    app.update(event(ReviewEvent::VerifyProgress { done: 1, total: 3 }));
    let screen = text(&draw(&app, 120, 40, Theme::default()));
    assert!(screen.contains("✓ prepare"), "{screen}");
    assert!(screen.contains("0.5s"), "{screen}");
    assert!(
        screen.contains("✕ lint          eslint · 2 findings       1.5s"),
        "{screen}"
    );
    assert!(screen.contains("◐ typecheck     tsc · running"), "{screen}");
    assert!(
        screen.contains("✓ correctness      2 hypotheses"),
        "{screen}"
    );
    assert!(screen.contains("1 of 5"), "{screen}");
    assert!(screen.contains("quorum 2 of 3 · 1/3 done"), "{screen}");
    assert!(screen.contains("◐ running · verify 1/3"), "{screen}");
    assert!(
        screen.contains("eslint  src/queue.ts:17 no-floating-promises"),
        "{screen}"
    );

    // ⏎ on the lint check shows its log only.
    keys(
        &mut app,
        &[KeyCode::Down, KeyCode::Down, KeyCode::Down, KeyCode::Enter],
    );
    let screen = text(&draw(&app, 120, 40, Theme::default()));
    assert!(screen.contains("LOG · ESLINT"), "{screen}");
    assert!(!screen.contains("tsc --noEmit"), "{screen}");
    app.update(event(ReviewEvent::Log {
        source: "eslint".into(),
        line: "src/b.ts:3 no-console".into(),
    }));
    assert!(text(&draw(&app, 120, 40, Theme::default())).contains("src/b.ts:3 no-console"));

    // Done opens the findings with an unsaved report.
    let effects = app.update(event(ReviewEvent::Done {
        report: Box::new(report()),
    }));
    assert!(effects.is_empty());
    assert_eq!(app.top().title(), "Findings");
    assert!(app.session.report.is_some());
    assert!(!app.session.saved);
}

#[test]
fn live_keeps_at_most_500_lines_per_source() {
    let mut state = LiveState::new(vec![]);
    for i in 0..600 {
        state.push_log(i, "vitest", &format!("line {i}"));
    }
    state.push_log(600, "tsc", "one");
    assert_eq!(state.by_source["vitest"].len(), review::LOG_LINES);
    assert_eq!(state.by_source["vitest"].front().unwrap().line, "line 100");
    assert_eq!(state.by_source["tsc"].len(), 1);
}

#[test]
fn interrupt_says_a_partial_report_follows_and_partial_opens_findings() {
    let mut app = live_app();
    assert_eq!(app.update(rio_tui::app::ctrl('c')), vec![Effect::Cancel]);
    let screen = text(&draw(&app, 120, 40, Theme::default()));
    assert!(
        screen.contains("◐ stopping · partial report follows"),
        "{screen}"
    );
    assert!(
        screen.contains("stopping · a partial report follows"),
        "{screen}"
    );
    let mut partial = report();
    partial.status = ReportStatus::Partial;
    app.update(Msg::Review(ReviewEvent::Partial {
        report: Box::new(partial),
    }));
    assert_eq!(app.top().title(), "Findings");
    assert!(!app.session.saved);
    let screen = text(&draw(&app, 120, 40, Theme::default()));
    assert!(screen.contains("◐ partial"), "{screen}");
}

// ---------------------------------------------------------------- findings

#[test]
fn findings_never_show_refuted_findings_or_percentages() {
    let app = findings_app();
    let screen = text(&draw(&app, 120, 40, Theme::default()));
    assert!(!screen.contains("refuted hypothesis"));
    assert!(screen.contains("refuted           3"));
    assert!(!screen.contains('%') || !screen.contains("confidence"));
}

#[test]
fn y_copies_the_eight_character_id_and_e_opens_the_editor() {
    let mut app = findings_app();
    assert_eq!(
        keys(&mut app, &[KeyCode::Char('y')]),
        vec![Effect::Copy("8c1e4a9b".into())]
    );
    assert_eq!(
        keys(&mut app, &[KeyCode::Char('e')]),
        vec![Effect::Edit {
            path: "src/parser/header.ts".into(),
            line: 42
        }]
    );
    let screen = text(&draw(&app, 120, 40, Theme::default()));
    assert!(screen.contains("8c1e4a9b Possible null dereference in parseHeader"));
}

#[test]
fn f_cycles_the_filters() {
    let mut app = findings_app();
    keys(
        &mut app,
        &[KeyCode::Char('f'), KeyCode::Char('f'), KeyCode::Char('f')],
    );
    let screen = text(&draw(&app, 120, 40, Theme::default()));
    assert!(screen.contains("Findings 1"), "{screen}");
    assert!(screen.contains("f7d26a40"), "{screen}");
    assert!(!screen.contains("3a90c2d1"), "{screen}");
}

#[test]
fn q_on_the_findings_offers_to_save() {
    let mut app = findings_app();
    assert!(keys(&mut app, &[KeyCode::Char('q')]).is_empty());
    assert_eq!(app.top().title(), "Quit");
}

// ---------------------------------------------------------------- dismissal

#[test]
fn dismissal_records_reason_and_note_with_the_full_identity() {
    let mut app = findings_app();
    keys(
        &mut app,
        &[
            KeyCode::Char('d'),
            KeyCode::Down,
            KeyCode::Down,
            KeyCode::Tab,
        ],
    );
    assert_eq!(app.top().title(), "Dismiss finding");
    // `q` in the focused note is text, not quit.
    assert!(typed(&mut app, "quirk on purpose").is_empty());
    assert!(!app.done);
    assert_eq!(app.top().title(), "Dismiss finding");
    let effects = keys(&mut app, &[KeyCode::Enter]);
    assert_eq!(
        effects,
        vec![Effect::Feedback {
            id: ident("8c1e4a9b"),
            reason: "intentional".into(),
            note: Some("quirk on purpose".into()),
        }]
    );
    // A failure is shown and the dialog stays.
    app.update(Msg::Done(Outcome::Failed("endpoint returned 409".into())));
    assert_eq!(app.top().title(), "Dismiss finding");
    assert!(text(&draw(&app, 120, 40, Theme::default())).contains("✕ endpoint returned 409"));
    // Retry; success closes the dialog and the list marks the finding dismissed.
    assert_eq!(keys(&mut app, &[KeyCode::Enter]).len(), 1);
    app.update(Msg::Done(Outcome::Ok("recorded".into())));
    assert_eq!(app.top().title(), "Findings");
    let screen = text(&draw(&app, 120, 40, Theme::default()));
    assert!(screen.contains("dismissed"), "{screen}");
}

#[test]
fn dismissal_without_an_endpoint_records_nothing() {
    let mut data = findings_data();
    data.endpoint = false;
    let mut app = open(review::findings(data));
    keys(&mut app, &[KeyCode::Char('d')]);
    let screen = text(&draw(&app, 120, 40, Theme::default()));
    assert!(screen.contains("dismissals need an endpoint"), "{screen}");
    assert!(keys(&mut app, &[KeyCode::Down, KeyCode::Enter]).is_empty());
    assert_eq!(app.top().title(), "Dismiss finding");
    keys(&mut app, &[KeyCode::Esc]);
    assert_eq!(app.top().title(), "Findings");
}

// ---------------------------------------------------------------- graph

#[test]
fn graph_views_and_hops() {
    let mut app = findings_app();
    keys(&mut app, &[KeyCode::Char('g')]);
    assert_eq!(app.top().title(), "Impact graph");
    // Base: none of the slice's edges exist in base, so only the changed nodes remain.
    keys(&mut app, &[KeyCode::Char('v')]);
    let screen = text(&draw(&app, 120, 40, Theme::default()));
    assert!(!screen.contains("handleRequest"), "{screen}");
    assert!(screen.contains("parseHeader"));
    // Delta: every edge differs.
    keys(&mut app, &[KeyCode::Char('v')]);
    let screen = text(&draw(&app, 120, 40, Theme::default()));
    assert!(screen.contains("createServer"), "{screen}");
    // One hop hides the transitive column.
    keys(&mut app, &[KeyCode::Char('-')]);
    let screen = text(&draw(&app, 120, 40, Theme::default()));
    assert!(!screen.contains("createServer"), "{screen}");
    assert!(screen.contains("hops 1"), "{screen}");
    keys(&mut app, &[KeyCode::Char('+')]);
    // Move to the nearest dependent, focus it, open it.
    keys(&mut app, &[KeyCode::Right, KeyCode::Enter]);
    let screen = text(&draw(&app, 120, 40, Theme::default()));
    assert!(screen.contains("ƒ acceptUpload"), "{screen}");
    assert!(
        screen.contains("function · head · seed · hop 0"),
        "{screen}"
    );
    assert_eq!(
        keys(&mut app, &[KeyCode::Char('o')]),
        vec![Effect::Edit {
            path: "src/upload.ts".into(),
            line: 21
        }]
    );
    keys(&mut app, &[KeyCode::Esc]);
    assert_eq!(app.top().title(), "Findings");
}

// ---------------------------------------------------------------- export

#[test]
fn export_emits_export_and_done_marks_the_report_saved() {
    let mut app = findings_app();
    keys(&mut app, &[KeyCode::Char('x'), KeyCode::Down]);
    let effects = keys(&mut app, &[KeyCode::Enter]);
    assert_eq!(
        effects,
        vec![
            Effect::Export {
                format: "json".into(),
                path: "./rio-review-parser-guards.json".into()
            },
            Effect::Step("review:export-copy".into()),
        ]
    );
    assert!(!app.session.saved);
    app.update(Msg::Done(Outcome::Ok("saved".into())));
    assert!(app.session.saved);
    assert_eq!(app.top().title(), "Findings");
    // Saved: q quits without asking.
    assert_eq!(keys(&mut app, &[KeyCode::Char('q')]), vec![Effect::Quit]);
}

#[test]
fn export_destination_is_a_text_field() {
    let mut app = findings_app();
    keys(
        &mut app,
        &[
            KeyCode::Char('x'),
            KeyCode::Down,
            KeyCode::Down,
            KeyCode::Tab,
        ],
    );
    for _ in 0.."./rio-review-parser-guards.sarif".len() {
        app.update(press(KeyCode::Backspace));
    }
    assert!(typed(&mut app, "q.sarif").is_empty());
    assert!(!app.done);
    keys(&mut app, &[KeyCode::Tab, KeyCode::Down, KeyCode::Char(' ')]);
    assert_eq!(
        keys(&mut app, &[KeyCode::Enter]),
        vec![
            Effect::Step("review:export-include-pre-existing".into()),
            Effect::Export {
                format: "sarif".into(),
                path: "q.sarif".into()
            },
            Effect::Step("review:export-copy".into()),
        ]
    );
}

// ---------------------------------------------------------------- 80×24 and NO_COLOR

#[test]
fn every_screen_reads_at_80_by_24() {
    let start = open(review::start(start_data()));
    let cases: Vec<(&str, App)> = vec![
        ("review-00-start", start),
        ("review-01-live-review", live_app()),
        ("review-02-findings", findings_app()),
        ("review-03-lineage-feedback", dismiss_app()),
        ("review-04-impact-graph", graph_app()),
        ("review-05-summary-export", export_app()),
    ];
    for (slug, app) in cases {
        let buf = draw(&app, 80, 24, Theme::default());
        assert_fits(&buf);
        insta::assert_snapshot!(format!("{slug}_80x24"), common::lines(&buf));
    }
}

#[test]
fn no_color_findings_still_read_by_glyph_and_cursor() {
    let theme = Theme {
        color: false,
        ..Theme::default()
    };
    let app = findings_app();
    let buf = draw(&app, 120, 40, theme);
    for cell in buf.content() {
        assert_eq!(cell.style().fg, Some(ratatui::style::Color::Reset));
    }
    let screen = text(&buf);
    for glyph in [
        "● 8c1e4a9b",
        "▲ b41c7e02",
        "◆ f7d26a40",
        "○ 77ab0c35",
        "▌ ● 8c1e4a9b",
    ] {
        assert!(screen.contains(glyph), "{glyph}\n{screen}");
    }
    // The cursor rows are reverse video.
    let reversed = |y: u16| {
        buf[(30, y)]
            .style()
            .add_modifier
            .contains(ratatui::style::Modifier::REVERSED)
    };
    // The focused finding is the second in the list (rows 7 and 8).
    assert!(reversed(7) && reversed(8) && !reversed(4));
    insta::assert_snapshot!("review-02-findings_no_color", screen);
}

#[test]
fn every_glyph_drawn_is_in_the_handoff_glyph_set() {
    let glyphs: serde_json::Value = serde_json::from_str(include_str!(
        "../../../docs/design/tui-pr-comments/tui/glyphs.json"
    ))
    .unwrap();
    let known = glyphs["non_ascii"].as_object().unwrap();
    let mut live_events = open(review::start(start_data()));
    keys(&mut live_events, &[KeyCode::Enter]);
    let screens: Vec<(&str, App)> = vec![
        ("start", open(review::start(start_data()))),
        ("live", live_app()),
        ("live from start", live_events),
        ("findings", findings_app()),
        ("dismissal", dismiss_app()),
        ("graph", graph_app()),
        ("export", export_app()),
    ];
    for (name, app) in screens {
        for size in [(120, 40), (80, 24)] {
            let screen = text(&draw(&app, size.0, size.1, Theme::default()));
            for c in screen.chars().filter(|c| !c.is_ascii()) {
                assert!(
                    known.contains_key(&c.to_string()),
                    "{name}: {c} is not in glyphs.json"
                );
            }
        }
    }
    for c in review::exit_text(&exit_data())
        .chars()
        .filter(|c| !c.is_ascii())
    {
        assert!(known.contains_key(&c.to_string()), "exit: {c}");
    }
}

#[test]
fn ascii_glyphs_keep_the_findings_grid() {
    let theme = Theme {
        glyphs: rio_core::glyphs::GlyphSet::Ascii,
        ..Theme::default()
    };
    let app = findings_app();
    let screen = text(&draw(&app, 120, 40, theme));
    assert!(screen.is_ascii());
    assert!(screen.lines().all(|line| line.len() == 120));
    assert!(screen.contains("> @ 8c1e4a9b"), "{screen}");
}

#[test]
fn the_hub_opens_the_team_screens_the_host_builds() {
    let mut data = findings_data();
    let first = data.listed()[0].id.clone();
    let second = data.listed()[1].id.clone();
    for f in data
        .report
        .findings
        .iter_mut()
        .chain(&mut data.report.risks)
    {
        if f.id == first {
            f.category = Category::Security;
            f.trace = Some(rio_core::SecurityTrace {
                catalog_item: "A01".into(),
                change: "removed".into(),
                steps: Vec::new(),
            });
        }
    }
    // The host's screens, named as effects so the test can read them.
    data.open = Some(std::rc::Rc::new(|open, f: Option<&Finding>| {
        rio_tui::Action::Effect(Effect::Step(format!(
            "{open:?}:{}",
            f.map_or("", |f| f.id.as_str())
        )))
    }));
    let mut app = open(review::findings(data));
    // The first ⏎ opens the detail as before; the second opens P1 for a
    // security finding with a trace.
    assert!(keys(&mut app, &[KeyCode::Enter]).is_empty());
    assert_eq!(
        keys(&mut app, &[KeyCode::Enter]),
        vec![Effect::Step(format!("Security:{first}"))]
    );
    // Not for a finding without a trace or a council.
    assert!(keys(&mut app, &[KeyCode::Down, KeyCode::Enter]).is_empty());
    for (key, name) in [('F', "History"), ('S', "Proposals"), ('P', "Publish")] {
        assert_eq!(
            keys(&mut app, &[KeyCode::Char(key)]),
            vec![Effect::Step(format!("{name}:{second}"))]
        );
    }
    // The key bar is unchanged; the palette lists the team keys as actions.
    assert_eq!(app.top().keys().len(), 9);
    assert!(
        app.top()
            .palette_keys()
            .iter()
            .any(|k| k.key == "F" && k.label == "finding history")
    );
    // Without a host opener the keys do nothing.
    let mut plain = findings_app();
    assert!(keys(&mut plain, &[KeyCode::Char('F'), KeyCode::Char('P')]).is_empty());
    assert_eq!(plain.top().palette_keys().len(), 9);
}

/// Forty findings of one rule in forty files, in shuffled report order.
fn many_findings_app() -> App {
    let mut report = report();
    let template = report.findings[0].clone();
    report.findings = (0..40u32)
        .map(|i| {
            let n = (i * 17) % 40 + 1;
            let mut f = template.clone();
            f.id = format!("{n:08x}{}", "0".repeat(56));
            f.location.path = format!("src/module{n:02}.ts");
            f.location.line_start = 1;
            f.locations = vec![f.location.clone()];
            f
        })
        .collect();
    report.security.clear();
    report.risks.clear();
    report.summary.pre_existing = 0;
    let mut data = findings_data();
    data.report = report.clone();
    data.labels.clear();
    data.failing.clear();
    let mut app = open(review::findings(data));
    app.session.report = Some(report);
    app
}

fn list_text(app: &App) -> String {
    common::lines(&draw(app, 120, 40, Theme::default()))
}

#[test]
fn a_long_list_keeps_its_place_shows_what_is_out_of_view_and_pages() {
    let mut app = many_findings_app();
    let screen = list_text(&app);
    // Path order, the position and what lies below.
    assert!(screen.contains("src/module01.ts:1"), "{screen}");
    assert!(screen.contains(" · 1/40"), "{screen}");
    assert!(screen.contains("↓ 29 more"), "{screen}");
    assert!(
        !screen.contains(" ↑ 1") && !screen.contains(" ↑ 2"),
        "{screen}"
    );
    // Down past the window scrolls by one item at a time.
    keys(&mut app, &[KeyCode::Down; 12]);
    let screen = list_text(&app);
    assert!(
        screen.contains(" · 13/40") && screen.contains("↑ 2 more"),
        "{screen}"
    );
    // Up moves the cursor inside the window; the window stays.
    keys(&mut app, &[KeyCode::Up; 3]);
    let screen = list_text(&app);
    assert!(
        screen.contains(" · 10/40") && screen.contains("↑ 2 more"),
        "{screen}"
    );
    // PageDown moves by a window, End and Home to the ends.
    keys(&mut app, &[KeyCode::PageDown]);
    assert!(list_text(&app).contains(" · 21/40"));
    keys(&mut app, &[KeyCode::End]);
    let screen = list_text(&app);
    assert!(
        screen.contains(" · 40/40")
            && screen.contains("↑ 29 more")
            && screen.matches(" more ").count() == 1,
        "{screen}"
    );
    assert!(screen.contains("src/module40.ts:1"), "{screen}");
    keys(&mut app, &[KeyCode::Home]);
    let screen = list_text(&app);
    assert!(
        screen.contains(" · 1/40") && screen.contains("↓ 29 more") && !screen.contains("↑ 2"),
        "{screen}"
    );
    // The focused item is always drawn, never in the blank space above the list.
    for _ in 0..39 {
        keys(&mut app, &[KeyCode::Down]);
        let buf = draw(&app, 120, 40, Theme::default());
        let rows: Vec<String> = common::lines(&buf).lines().map(str::to_owned).collect();
        assert!(
            rows[4].contains('●'),
            "the first list row is never blank:\n{}",
            rows.join("\n")
        );
    }
}

#[test]
fn a_long_list_reads_at_80_by_24() {
    let mut app = many_findings_app();
    keys(&mut app, &[KeyCode::Down; 20]);
    insta::assert_snapshot!(
        "review-02-findings_40_80x24",
        common::lines(&draw(&app, 80, 24, Theme::default()))
    );
}

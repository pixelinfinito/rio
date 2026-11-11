#![cfg(feature = "team")]
//! The team flow (P1–P4) against the design handoff, and its consent rules.

mod common;

use ratatui::crossterm::event::KeyCode;
use rio_core::{
    AssessedItem, CatalogItemRef, Finding, PublishPolicy, SecurityCatalog, SecurityCoverage,
};
use rio_tui::{
    App, Effect, Msg, Outcome, Session, Theme,
    app::press,
    chrome::{quiet, status},
    team::{
        CheckPreview, CodeLine, Entry, Evidence, ExperimentNote, HistoryData, Observation, Preview,
        PreviewComment, ProfileChange, ProfileLine, Proposal, ProposalHint, ProposalsData,
        PublishData, RegistryRecord, SecurityData, SecurityEntry, StepText, history, proposals,
        publish, security,
    },
    theme::Token,
};
use serde_json::{Value, json};

const A7F3: &str = "a7f3e2c1d4b5a6f70011223344556677";
const C8C1E: &str = "8c1e4a9b00112233";
const F51FD: &str = "51fd7c2e00112233";
const C90B: &str = "c90b3d1a00112233";
const F3A10: &str = "3a10b2c400112233";

fn finding(value: Value) -> Finding {
    let mut base = json!({
        "rule_id": "rule",
        "category": "defect",
        "evidence_level": "static_proven",
        "severity": "error",
        "state": "new",
        "message": "",
        "trigger": "",
        "evidence": [],
        "source": {"agent": "rio/security"},
        "locations": [],
    });
    for (k, v) in value.as_object().unwrap() {
        base[k] = v.clone();
    }
    serde_json::from_value(base).unwrap()
}

fn location(path: &str, line: u32, symbol: &str) -> Value {
    json!({
        "path": path, "line_start": line, "line_end": line,
        "symbol_path": symbol, "occurrence_state": "new"
    })
}

fn findings() -> Vec<Finding> {
    let guest = finding(json!({
        "id": A7F3,
        "rule_id": "authz/owner-check",
        "category": "security",
        "evidence_level": "reproduced",
        "message": "Guest session can read any order",
        "location": location("api/orders.ts", 57, "getOrder()"),
        "verification": {"voters": 3, "agreeing": 1, "blind_match": ["same", "none", "related"], "split": true},
        "trace": {
            "catalog_item": "A01",
            "change": "removed",
            "steps": [
                {"role": "source", "path": "api/orders.ts", "line_start": 52},
                {"role": "step", "path": "api/orders.ts", "line_start": 53},
                {"role": "step", "path": "api/orders.ts", "line_start": 54, "missing": true},
                {"role": "sink", "path": "api/orders.ts", "line_start": 57}
            ]
        },
        "council": {
            "decision": "reproduced",
            "tier": "experiment",
            "partial": true,
            "answered": 4,
            "total": 5,
            "members": [
                {"role": "skeptic", "family": "claude", "abstained": false, "rounds": [
                    {"round": 1, "real": "no"}, {"round": 2, "real": "yes", "changed": true}]},
                {"role": "exploit-author", "family": "gpt", "abstained": false, "rounds": [
                    {"round": 1, "real": "yes"}, {"round": 2, "real": "yes"}]},
                {"role": "code-owner", "family": "gemini", "abstained": false, "rounds": [
                    {"round": 1, "cause": "insufficient_context"}, {"round": 2, "real": "yes", "changed": true}]},
                {"role": "maintainer", "family": "mistral", "abstained": false, "rounds": [
                    {"round": 1, "real": "yes"}, {"round": 2, "real": "yes"}]},
                {"role": "tester", "family": "qwen·self", "abstained": true, "cause": "timeout", "rounds": [
                    {"round": 1, "cause": "timeout"}]}
            ],
            "experiments": [{
                "command": ["GET", "/api/orders/1042", "as", "guest", "session", "B"],
                "version": "head", "expect": "fails", "run": true,
                "outcome": {"base": "passed", "head": "failed"},
                "artifact": "exp-1"
            }]
        }
    }));
    vec![
        guest,
        finding(json!({
            "id": C8C1E, "rule_id": "ts/null-deref",
            "message": "Null dereference of the content-type header",
            "location": location("parser/header.ts", 41, "readHeader()"),
        })),
        finding(json!({
            "id": F51FD, "rule_id": "unhandled-reject", "category": "security",
            "message": "Unhandled promise rejection ends the request",
            "location": location("parser/body.ts", 17, "parseBody()"),
        })),
        finding(json!({
            "id": C90B, "rule_id": "sql/concat", "category": "risk", "severity": "warning",
            "evidence_level": "plausible",
            "message": "SQL built by string concatenation",
            "location": location("db/raw.ts", 12, "rawQuery()"),
        })),
        finding(json!({
            "id": F3A10, "rule_id": "ts/unused-await", "category": "security", "state": "fixed",
            "message": "Cart total trusted from the client",
            "location": location("api/cart.ts", 30, "total()"),
        })),
    ]
}

fn coverage() -> SecurityCoverage {
    let assessed = |item: &str, title: &str, ids: &[&str]| AssessedItem {
        item: item.into(),
        title: title.into(),
        findings: ids.iter().map(|s| (*s).to_owned()).collect(),
    };
    SecurityCoverage {
        catalog: SecurityCatalog::OwaspTop10_2025,
        assessed: vec![
            assessed("A01", "Broken Access Control", &[A7F3]),
            assessed("A02", "Security Misconfiguration", &[]),
            assessed("A03", "Software Supply Chain Failures", &[]),
            assessed("A05", "Injection", &[C90B]),
            assessed("A06", "Insecure Design", &[]),
            assessed("A07", "Authentication Failures", &[]),
            assessed("A09", "Logging & Alerting Failures", &[]),
            assessed("A10", "Mishandling of Exceptional Conditions", &[F51FD]),
        ],
        unassessed: vec![],
        not_applicable: vec![
            CatalogItemRef {
                item: "A04".into(),
                title: "Cryptographic Failures".into(),
            },
            CatalogItemRef {
                item: "A08".into(),
                title: "Software or Data Integrity Failures".into(),
            },
        ],
    }
}

const BODY: &str = "Guest session can read any order
error · security · reproduced · A01

A guest session reaches
db.orders.get(id) with no owner check.

Evidence  exp-1: head 200, base 404
Council   reproduced · partial 4/5

Reply /rio dismiss a7f3 <reason>
fixed · wrong · intentional ·
irrelevant · style

<!-- rio:finding a7f3 pr-142 r2 -->
By the marker, next round edits,
this; no reposts";

fn preview(policy: &str) -> Value {
    let comment = |id: &str, path: &str, line: u32, body: &str| PreviewComment {
        id: id.into(),
        path: path.into(),
        line,
        start_line: None,
        body: body.into(),
    };
    let p = Preview {
        policy: serde_json::from_value(json!(policy)).unwrap(),
        reason: None,
        comments: vec![
            comment(A7F3, "api/orders.ts", 57, BODY),
            comment(
                C8C1E,
                "parser/header.ts",
                41,
                "Null dereference of the content-type header",
            ),
            comment(
                F51FD,
                "parser/body.ts",
                17,
                "Unhandled promise rejection ends the request",
            ),
        ],
        unanchored: vec![C90B.into()],
        summary: Some("rio review · PR #142 · round 2 of 3\n\n3 inline · 1 in summary".into()),
        check: Some(CheckPreview {
            title: "risk high · 3 fail · 1 risk".into(),
            summary: "QA 1 failed cell\nnever blocks".into(),
            name: Some("rio/review".into()),
            conclusion: Some("neutral".into()),
        }),
    };
    serde_json::to_value(p).unwrap()
}

fn publish_data() -> PublishData {
    PublishData {
        repository: "pixelinfinito/rio".into(),
        pr: 142,
        head: "parser-guards".into(),
        base: "main".into(),
        author: "ana".into(),
        fork: false,
        you: "maintainer (GitHub)".into(),
        app: "rio[bot]".into(),
        installed: true,
        lineage: "pr".into(),
        round: 2,
        cap: 3,
        policy: PublishPolicy::Ask,
        findings: findings(),
        posted: vec![F51FD.into()],
        summary_comment: Some(2189),
        resolved: 2,
        preview: None,
    }
}

/// One registry record.
fn record(id: &str, status: &str, rule: &str, path: &str, extra: Value) -> RegistryRecord {
    let mut v = json!({
        "identity": format!("{id}0c3e5a7b9d1f2a4c"),
        "repository": "github.com/pixelinfinito/rio",
        "rule_id": rule,
        "status": status,
        "first_seen": "#128 r1",
        "last_seen": "#142 r2",
        "seen_count": 2,
        "location": {"path": path, "line_start": 10, "symbol_path": "main()"},
        "updated_at": "2026-11-09T10:00:00.000Z",
    });
    for (k, x) in extra.as_object().unwrap() {
        v[k] = x.clone();
    }
    serde_json::from_value(v).unwrap()
}

fn dismissed(reason: &str, actor: &str) -> Value {
    json!({"author_response": {"reason": reason, "actor": actor, "at": "2026-10-01T09:00:00Z"}})
}

fn records() -> Vec<RegistryRecord> {
    let mut list = vec![
        record(
            "a7f3",
            "open",
            "authz/owner-check",
            "api/orders.ts",
            json!({}),
        ),
        record(
            "8c1e",
            "open",
            "ts/null-deref",
            "parser/header.ts",
            json!({}),
        ),
        record(
            "51fd",
            "open",
            "unhandled-reject",
            "parser/body.ts",
            json!({}),
        ),
        record(
            "77ab",
            "open",
            "ts/null-deref",
            "lib/cache.ts",
            json!({
                "location": {"path": "lib/cache.ts", "line_start": 88, "symbol_path": "getCached()"},
                "seen_count": 3,
                "author_response": {"reason": "fixed", "actor": "ana", "at": "#128 r2"},
                "fixed_in": "#131 r1",
                "message": "null deref in getCached",
                "symbol_changed": true,
                "came_back": "#142 removed the guard added\nin #131 (cache.ts:86)"
            }),
        ),
        {
            let mut r = record(
                "6d2c",
                "dismissed",
                "legacy-endpoint",
                "api/legacy.ts",
                dismissed("intentional", "rui"),
            );
            r.remembered = true;
            r
        },
        {
            let mut v = dismissed("style", "ana");
            v["dismissed_in"] = json!("#139");
            let mut r = record(
                "2e90",
                "dismissed",
                "ui/spacing-scale",
                "src/legacy/grid",
                v,
            );
            r.remembered = true;
            r
        },
        {
            let mut v = dismissed("style", "rui");
            v["dismissed_in"] = json!("#138");
            let mut r = record(
                "41c7",
                "dismissed",
                "ui/spacing-scale",
                "src/legacy/form",
                v,
            );
            r.remembered = true;
            r
        },
        {
            let mut v = dismissed("irrelevant", "ana");
            v["dismissed_in"] = json!("#136");
            v["author_response"]["note"] = json!("legacy screens use the old 6 px grid");
            let mut r = record("9bd2", "dismissed", "ui/spacing-scale", "src/legacy/nav", v);
            r.remembered = true;
            r
        },
        record(
            "b13c",
            "dismissed",
            "sql/concat",
            "parser/util.ts",
            dismissed("wrong", "ana"),
        ),
        record("3a10", "fixed", "ts/unused-await", "api/cart.ts", json!({})),
        record(
            "e81f",
            "fixed",
            "lint/no-floating",
            "worker/job.ts",
            json!({}),
        ),
        record("0c55", "fixed", "coverage/diff", "lib/money.ts", json!({})),
    ];
    // 29 more: 6 open, 15 fixed and 8 dismissed (4 fixed, 2 wrong, 2 intentional).
    for i in 0..29 {
        let id = format!("f{i:03}");
        let r = match i {
            0..6 => record(&id, "open", "lint/no-console", "src/app.ts", json!({})),
            6..21 => record(&id, "fixed", "lint/no-console", "src/app.ts", json!({})),
            21..25 => record(
                &id,
                "dismissed",
                "lint/no-console",
                "src/app.ts",
                dismissed("fixed", "ana"),
            ),
            25..27 => record(
                &id,
                "dismissed",
                "lint/no-console",
                "src/app.ts",
                dismissed("wrong", "ana"),
            ),
            _ => {
                let mut r = record(
                    &id,
                    "dismissed",
                    "lint/no-console",
                    "src/app.ts",
                    dismissed("intentional", "rui"),
                );
                r.remembered = true;
                r
            }
        };
        list.push(r);
    }
    list
}

fn evidence(id: &str, actor: &str) -> Evidence {
    Evidence {
        finding: format!("{id}0c3e5a7b9d1f2a4c"),
        reason: "style".into(),
        actor: Some(actor.into()),
        at: "2026-10-01T09:00:00Z".into(),
    }
}

fn proposal_list() -> Vec<Proposal> {
    let line = |n: u32, text: &str, added: bool| ProfileLine {
        line: n,
        text: text.into(),
        added,
    };
    let proposal = |id: &str, rule: &str, path: Option<&str>, status: &str| Proposal {
        id: id.into(),
        repository: "github.com/pixelinfinito/rio".into(),
        entry: Entry {
            rule: Some(rule.into()),
            path: path.map(str::to_owned),
        },
        status: status.into(),
        evidence_count: 0,
        evidence: vec![],
        note: None,
        created_at: "2026-11-01T09:00:00.000Z".into(),
        decided_at: None,
        change: None,
        extra: Default::default(),
    };
    let mut first = proposal(
        "sp-3f2a",
        "ui/spacing-scale",
        Some("src/legacy/**"),
        "proposed",
    );
    first.evidence = vec![
        evidence("9bd2", "ana"),
        evidence("41c7", "rui"),
        evidence("2e90", "ana"),
    ];
    first.evidence_count = 3;
    first.change = Some(ProfileChange {
        path: ".rio/profiles/default.yaml".into(),
        lines: vec![
            line(1, "version: 1", false),
            line(2, "name: default", false),
            line(3, "extends: rio/base", false),
            line(4, "suppress:", true),
            line(5, "  - rule: ui/spacing-scale", true),
            line(6, "    paths: [\"src/legacy/**\"]", true),
            line(7, "    reason: style · proposal sp-3f2a", true),
        ],
        written: true,
        error: None,
    });
    let mut second = proposal("sp-9c01", "lint/max-params", Some("scripts/**"), "proposed");
    second.evidence = (0..4)
        .map(|i| Evidence {
            reason: "irrelevant".into(),
            ..evidence(&format!("e{i:03}"), "ana")
        })
        .collect();
    second.evidence_count = 4;
    let mut third = proposal("sp-77de", "coverage/diff", None, "declined");
    third.decided_at = Some("2026-11-10T08:00:00.000Z".into());
    vec![first, second, third]
}

fn proposals_data() -> ProposalsData {
    ProposalsData {
        repository: "pixelinfinito/rio".into(),
        proposals: Some(proposal_list()),
        records: records(),
        threshold: 3,
        window_days: 90,
    }
}

fn history_data() -> HistoryData {
    HistoryData {
        repository: "pixelinfinito/rio".into(),
        origin: "github.com/pixelinfinito/rio".into(),
        endpoint: true,
        records: Some(records()),
        since_days: 90,
        response_ratio: Some(0.62),
        scope: Some("across 9 PRs and 3 branches".into()),
        hint: Some(ProposalHint {
            summary: "3 style dismissals of ui/spacing-scale under src/legacy/**".into(),
            id: "sp-3f2a".into(),
        }),
        proposals: ProposalsData {
            proposals: None,
            ..proposals_data()
        },
    }
}

fn security_data() -> SecurityData {
    let mut entries: Vec<SecurityEntry> = findings().into_iter().map(SecurityEntry::new).collect();
    let labels = [
        "guest reads order",
        "null deref header",
        "unhandled reject",
        "sql built by concat",
        "cart total",
    ];
    for (e, label) in entries.iter_mut().zip(labels) {
        e.label = Some(label.into());
    }
    let guest = &mut entries[0];
    guest.fails = true;
    guest.code = vec![
        CodeLine {
            line: 55,
            text: "const id = Number(req.params.id)".into(),
            changed: false,
        },
        CodeLine {
            line: 56,
            text: "if (!(id > 0)) return res.sendStatus(400)".into(),
            changed: false,
        },
        CodeLine {
            line: 57,
            text: "const order = await db.orders.get(id)".into(),
            changed: true,
        },
        CodeLine {
            line: 58,
            text: "return res.json(order)".into(),
            changed: false,
        },
    ];
    let step = |code: &str, stage: &str, note: Option<&str>| StepText {
        code: code.into(),
        stage: stage.into(),
        note: note.map(str::to_owned),
    };
    guest.steps = vec![
        step("req.params.id", "input", None),
        step("Number(id) > 0", "validation", None),
        step(
            "no owner check",
            "authorization",
            Some("session.user may be guest; owner never compared"),
        ),
        step("db.orders.get(id)", "sensitive read", None),
    ];
    guest.experiments = vec![ExperimentNote {
        requested_by: Some("exploit-author".into()),
        head: Some(Observation {
            result: "200".into(),
            detail: "returns shopper A's order".into(),
        }),
        base: Some(Observation {
            result: "404".into(),
            detail: "order not visible".into(),
        }),
    }];
    guest.council_trigger = Some("verify.split".into());
    guest.cost = Some("$0.21".into());
    guest.audit = Some("au-77f1".into());
    SecurityData {
        context: "review · PR #142 · rio/security · deep".into(),
        status: vec![
            status("✕ exit 1 · 3 fail", Token::Fail),
            status("risk high", Token::Warn),
            quiet("4m02s"),
        ],
        scope: "PR #142".into(),
        entries,
        coverage: Some(coverage()),
        notes: [
            ("A03", "osv"),
            ("A04", "no crypto touched"),
            ("A08", "no serialized input"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect(),
        posture: Some("thorough".into()),
        endpoint: true,
        publish: publish_data(),
        history: history_data(),
    }
}

fn loaded_publish(policy: &str) -> PublishData {
    PublishData {
        preview: Some(serde_json::from_value(preview(policy)).unwrap()),
        ..publish_data()
    }
}

fn text(app: &App, cols: u16, rows: u16) -> String {
    let area = ratatui::layout::Rect::new(0, 0, cols, rows);
    let mut buf = ratatui::buffer::Buffer::empty(area);
    app.draw(&mut buf, area);
    common::lines(&buf)
}

fn type_text(app: &mut App, s: &str) -> Vec<Effect> {
    s.chars()
        .flat_map(|ch| app.update(press(KeyCode::Char(ch))))
        .collect()
}

// Golden conformance at 120×40.

#[test]
fn p1_security_council_matches_its_design() {
    let buf = common::render(security(security_data()), Session::default(), 120, 40);
    common::assert_screen("team-p1-security-council", &buf);
}

#[test]
fn p2_publish_preview_matches_its_design() {
    let buf = common::render(publish(loaded_publish("ask")), Session::default(), 120, 40);
    common::assert_screen("team-p2-publish-preview", &buf);
}

#[test]
fn p3_finding_history_matches_its_design() {
    let buf = common::render(history(history_data()), Session::default(), 120, 40);
    common::assert_screen("team-p3-finding-history", &buf);
}

#[test]
fn p4_suppression_proposals_matches_its_design() {
    let buf = common::render(proposals(proposals_data()), Session::default(), 120, 40);
    common::assert_screen("team-p4-suppression-proposals", &buf);
}

// P1.

#[test]
fn p1_never_shows_a_percentage() {
    for (cols, rows) in [(120, 40), (80, 24)] {
        let mut app = App::new(security(security_data()), Theme::default());
        for view in ['c', 't'] {
            app.update(press(KeyCode::Char(view)));
            let screen = text(&app, cols, rows);
            assert!(!screen.contains('%'), "{cols}×{rows}:\n{screen}");
        }
    }
}

#[test]
fn p1_dismiss_records_reason_and_note_with_the_full_identity() {
    let mut app = App::new(security(security_data()), Theme::default());
    assert!(app.update(press(KeyCode::Char('d'))).is_empty());
    assert!(!app.top().wants_text());
    app.update(press(KeyCode::Down));
    app.update(press(KeyCode::Down));
    app.update(press(KeyCode::Tab));
    assert!(app.top().wants_text());
    // q goes into the note; the UI does not quit.
    assert!(type_text(&mut app, "legacy q").is_empty());
    assert!(!app.done);
    assert_eq!(
        app.update(press(KeyCode::Enter)),
        vec![Effect::Feedback {
            id: A7F3.into(),
            reason: "intentional".into(),
            note: Some("legacy q".into()),
        }]
    );
    // Recorded only once the endpoint confirms it; a failure changes nothing.
    assert!(!text(&app, 120, 40).contains("dismissed: int"));
    let short = &A7F3[..8];
    app.update(Msg::Done(Outcome::Failed(format!("{short}: HTTP 409"))));
    assert!(!text(&app, 120, 40).contains("dismissed: int"));
    app.update(press(KeyCode::Char('d')));
    app.update(press(KeyCode::Down));
    app.update(press(KeyCode::Down));
    app.update(press(KeyCode::Enter));
    app.update(Msg::Done(Outcome::Ok(format!(
        "{short} dismissed (intentional)"
    ))));
    assert!(text(&app, 120, 40).contains("dismissed: int"));
}

#[test]
fn p1_dismiss_without_an_endpoint_records_nothing() {
    let data = SecurityData {
        endpoint: false,
        ..security_data()
    };
    let mut app = App::new(security(data), Theme::default());
    app.update(press(KeyCode::Char('d')));
    assert!(text(&app, 120, 40).contains("Dismissals need an endpoint."));
    assert!(app.update(press(KeyCode::Enter)).is_empty());
    // esc in the dialog closes it, not the screen.
    app.update(press(KeyCode::Char('d')));
    app.update(press(KeyCode::Esc));
    assert_eq!(app.stack.len(), 1);
}

#[test]
fn p1_audit_fetches_and_shows_the_record() {
    let mut app = App::new(security(security_data()), Theme::default());
    assert_eq!(
        app.update(press(KeyCode::Char('a'))),
        vec![Effect::Fetch("audit".into())]
    );
    assert!(text(&app, 120, 40).contains("loading the audit record"));
    app.update(Msg::Done(Outcome::Value(
        "audit".into(),
        json!({"council": [{"finding_id": A7F3, "member": "skeptic", "round": 1,
            "vendor": "anthropic", "model": "claude", "pack_bytes": 2048, "rendering_bytes": 512,
            "abstained": 0}], "usage": [{}, {}]}),
    )));
    let screen = text(&app, 120, 40);
    assert!(screen.contains("anthropic/claude"), "{screen}");
    assert!(screen.contains("pack 2048 B"), "{screen}");
    app.update(press(KeyCode::Char('c')));
    assert!(text(&app, 120, 40).contains("COUNCIL"));
}

#[test]
fn p1_publish_and_history_open_their_screens_and_ask_the_host() {
    let mut app = App::new(security(security_data()), Theme::default());
    assert_eq!(
        app.update(press(KeyCode::Char('P'))),
        vec![Effect::PreviewPublish]
    );
    assert_eq!(app.top().title(), "Publish preview");
    app.update(press(KeyCode::Esc));
    assert_eq!(app.top().title(), "Security finding and council");
    assert_eq!(
        app.update(press(KeyCode::Char('F'))),
        vec![Effect::Fetch("findings".into())]
    );
    assert_eq!(app.top().title(), "Finding history");
}

// P2.

#[test]
fn p2_n_posts_nothing_and_goes_back() {
    let mut app = App::new(security(security_data()), Theme::default());
    app.update(press(KeyCode::Char('P')));
    app.update(Msg::Done(Outcome::Value(
        "publish:preview".into(),
        preview("ask"),
    )));
    assert!(app.update(press(KeyCode::Char('n'))).is_empty());
    assert_eq!(app.stack.len(), 1);
    assert!(matches!(&app.session.notice, Some(Outcome::Ok(t)) if t.starts_with("nothing posted")));
}

#[test]
fn p2_y_before_the_preview_loads_posts_nothing() {
    let mut app = App::new(publish(publish_data()), Theme::default());
    assert!(app.update(press(KeyCode::Char('y'))).is_empty());
    assert!(text(&app, 120, 40).contains("loading preview"));
}

#[test]
fn p2_y_on_an_ask_preview_publishes_once() {
    let mut app = App::new(publish(publish_data()), Theme::default());
    app.update(Msg::Done(Outcome::Value(
        "publish:preview".into(),
        preview("ask"),
    )));
    assert_eq!(app.update(press(KeyCode::Char('y'))), vec![Effect::Publish]);
    assert!(
        app.update(press(KeyCode::Char('y'))).is_empty(),
        "never posts twice"
    );
}

#[test]
fn p2_never_policy_states_it_and_y_does_nothing() {
    let mut app = App::new(publish(publish_data()), Theme::default());
    app.update(Msg::Done(Outcome::Value(
        "publish:preview".into(),
        preview("never"),
    )));
    assert!(app.update(press(KeyCode::Char('y'))).is_empty());
    let screen = text(&app, 120, 40);
    assert!(
        screen.contains("The profile's policy forbids publishing."),
        "{screen}"
    );
    assert!(!app.top().keys().iter().any(|k| k.key == "y"));
}

#[test]
fn p2_e_explains_that_publishing_posts_the_whole_preview() {
    let mut app = App::new(publish(loaded_publish("ask")), Theme::default());
    assert!(app.update(press(KeyCode::Char('e'))).is_empty());
    let screen = text(&app, 120, 40);
    assert!(
        screen.contains("publishing posts every item shown here"),
        "{screen}"
    );
    assert!(!screen.contains("Publish to pixelinfinito/rio#142?"));
    app.update(press(KeyCode::Down));
    assert!(text(&app, 120, 40).contains("PREVIEW  rio[bot] on parser/header.ts:41"));
}

// P3.

#[test]
fn p3_json_copies_the_focused_record_and_filters_narrow_the_list() {
    let mut app = App::new(history(history_data()), Theme::default());
    let effects = app.update(press(KeyCode::Char('j')));
    let [Effect::Copy(json)] = effects.as_slice() else {
        panic!("{effects:?}");
    };
    let copied: Value = serde_json::from_str(json).unwrap();
    assert!(copied["identity"].as_str().unwrap().starts_with("77ab"));
    assert_eq!(copied["fixed_in"], "#131 r1");
    // f: open → regression.
    app.update(press(KeyCode::Char('f')));
    assert!(text(&app, 120, 40).contains("rio findings --status open"));
    app.update(press(KeyCode::Char('f')));
    let screen = text(&app, 120, 40);
    assert!(screen.contains("77ab0c3e"));
    assert!(!screen.contains("a7f30c3e"));
    // r: the focused rule.
    app.update(press(KeyCode::Char('r')));
    assert!(text(&app, 120, 40).contains("--rule ts/nu"));
}

#[test]
fn p3_dismiss_and_proposals() {
    let mut app = App::new(history(history_data()), Theme::default());
    app.update(press(KeyCode::Char('d')));
    app.update(press(KeyCode::Down));
    let effects = app.update(press(KeyCode::Enter));
    assert_eq!(
        effects,
        vec![Effect::Feedback {
            id: "77ab0c3e5a7b9d1f2a4c".into(),
            reason: "wrong".into(),
            note: None
        }]
    );
    assert_eq!(
        app.update(press(KeyCode::Char('S'))),
        vec![Effect::Fetch("suppressions".into())]
    );
    assert_eq!(app.top().title(), "Suppression proposals");
    app.update(Msg::Done(Outcome::Value(
        "suppressions".into(),
        json!({"suppressions": serde_json::to_value(proposal_list()).unwrap()}),
    )));
    assert!(text(&app, 120, 40).contains("Apply sp-3f2a to .rio/profiles/default.yaml?"));
    app.update(press(KeyCode::Esc));
    assert_eq!(app.top().title(), "Finding history");
}

#[test]
fn p3_loads_the_registry_from_the_endpoint_answer() {
    let data = HistoryData {
        records: None,
        ..history_data()
    };
    let mut app = App::new(history(data), Theme::default());
    assert!(text(&app, 120, 40).contains("asking the endpoint"));
    let body = json!({"findings": serde_json::to_value(records()).unwrap()});
    app.update(Msg::Done(Outcome::Value("findings".into(), body)));
    assert!(text(&app, 120, 40).contains("null deref in getCached"));
}

// P4.

#[test]
fn p4_n_leaves_everything_unchanged() {
    let mut app = App::new(proposals(proposals_data()), Theme::default());
    assert!(app.update(press(KeyCode::Char('N'))).is_empty());
    assert!(text(&app, 120, 40).contains("left unchanged"));
}

#[test]
fn p4_y_applies_the_focused_proposal_only() {
    let mut app = App::new(proposals(proposals_data()), Theme::default());
    app.update(press(KeyCode::Down));
    assert_eq!(
        app.update(press(KeyCode::Char('y'))),
        vec![Effect::ApplyProposal("sp-9c01".into())]
    );
    // A declined proposal has nothing to apply.
    app.update(Msg::Done(Outcome::Ok("applied".into())));
    app.update(press(KeyCode::Down));
    assert!(app.update(press(KeyCode::Char('y'))).is_empty());
}

#[test]
fn p4_x_declines_with_a_typed_reason() {
    let mut app = App::new(proposals(proposals_data()), Theme::default());
    assert!(app.update(press(KeyCode::Char('x'))).is_empty());
    assert!(app.top().wants_text());
    // An empty reason declines nothing.
    assert!(app.update(press(KeyCode::Enter)).is_empty());
    assert!(type_text(&mut app, "we want these, q included").is_empty());
    assert!(!app.done);
    assert_eq!(
        app.update(press(KeyCode::Enter)),
        vec![Effect::DeclineProposal {
            id: "sp-3f2a".into(),
            reason: "we want these, q included".into()
        }]
    );
    assert!(!app.top().wants_text());
    // esc while typing cancels the decline, not the screen.
    let mut app = App::new(proposals(proposals_data()), Theme::default());
    app.stack.insert(0, history(history_data()));
    app.update(press(KeyCode::Char('x')));
    assert!(app.update(press(KeyCode::Esc)).is_empty());
    assert_eq!(app.stack.len(), 2);
}

// Robustness.

fn screens() -> Vec<(&'static str, Box<dyn rio_tui::Screen>)> {
    vec![
        ("team-p1-security-council", security(security_data())),
        ("team-p2-publish-preview", publish(loaded_publish("ask"))),
        ("team-p3-finding-history", history(history_data())),
        ("team-p4-suppression-proposals", proposals(proposals_data())),
    ]
}

#[test]
fn every_screen_fits_80_by_24() {
    for (slug, screen) in screens() {
        let buf = common::render(screen, Session::default(), 80, 24);
        let lines = common::lines(&buf);
        assert!(
            lines
                .lines()
                .all(|l| unicode_width::UnicodeWidthStr::width(l) == 80)
        );
        let name = format!("{}_80x24", slug.replace('-', "_"));
        insta::assert_snapshot!(name, lines);
    }
}

#[test]
fn every_screen_reads_without_color() {
    let theme = Theme {
        color: false,
        ..Theme::default()
    };
    for (slug, screen) in screens() {
        let buf = common::render_with(screen, Session::default(), 120, 40, theme);
        for cell in buf.content() {
            assert_eq!(
                cell.style().bg,
                Some(ratatui::style::Color::Reset),
                "{slug}"
            );
        }
        // The focused row is marked by its glyph and reverse video.
        let reversed = buf.content().iter().any(|c| {
            c.style()
                .add_modifier
                .contains(ratatui::style::Modifier::REVERSED)
        });
        assert!(reversed, "{slug} marks its cursor");
        let text = common::lines(&buf);
        assert!(text.contains('▌'), "{slug}");
    }
    // States read by glyph: open, regression, fixed and dismissed records.
    let buf = common::render_with(history(history_data()), Session::default(), 120, 40, theme);
    let text = common::lines(&buf);
    for glyph in ["● open", "▲ regression", "✓ fixed", "◆ style", "◆ wrong"] {
        assert!(text.contains(glyph), "{glyph}");
    }
}

#[test]
fn short_data_never_panics() {
    let empty: Vec<Box<dyn rio_tui::Screen>> = vec![
        security(SecurityData::default()),
        publish(PublishData::default()),
        history(HistoryData::default()),
        proposals(ProposalsData::default()),
    ];
    for screen in empty {
        let mut app = App::new(screen, Theme::default());
        for code in [
            KeyCode::Up,
            KeyCode::Down,
            KeyCode::Enter,
            KeyCode::Char('y'),
            KeyCode::Char('d'),
        ] {
            app.update(press(code));
        }
        for (c, r) in [(80, 24), (120, 40), (200, 60)] {
            text(&app, c, r);
        }
    }
}

/// Forty items in a list, the cursor on the last one: it is on screen.
fn assert_last_visible(app: &App, marker: &str, what: &str) {
    let text = common::lines(&common_draw(app));
    assert!(
        text.contains(marker),
        "{what}: the last item is out of view\n{text}"
    );
}

fn common_draw(app: &App) -> ratatui::buffer::Buffer {
    let area = ratatui::layout::Rect::new(0, 0, 120, 40);
    let mut buf = ratatui::buffer::Buffer::empty(area);
    app.draw(&mut buf, area);
    buf
}

#[test]
fn long_team_lists_keep_the_cursor_in_view() {
    // Finding history.
    let mut data = history_data();
    let template = records()[0].clone();
    data.records = Some(
        (0..40)
            .map(|i| RegistryRecord {
                identity: format!("{i:02}{}", "e".repeat(62)),
                ..template.clone()
            })
            .collect(),
    );
    let mut app = App::new(history(data), Theme::default());
    for _ in 0..39 {
        app.update(rio_tui::app::press(KeyCode::Down));
    }
    assert_last_visible(&app, "39eeeeee", "finding history");

    // Suppression proposals.
    let mut data = proposals_data();
    let template = proposal_list()[0].clone();
    data.proposals = Some(
        (0..40)
            .map(|i| Proposal {
                id: format!("sp-{i:04}"),
                ..template.clone()
            })
            .collect(),
    );
    let mut app = App::new(proposals(data), Theme::default());
    for _ in 0..39 {
        app.update(rio_tui::app::press(KeyCode::Down));
    }
    assert_last_visible(&app, "sp-0039", "suppression proposals");

    // Security findings.
    let mut data = security_data();
    let template = data.entries[0].clone();
    data.entries = (0..40)
        .map(|i| {
            let mut e = template.clone();
            e.finding.id = format!("{i:02}{}", "a".repeat(62));
            e
        })
        .collect();
    let mut app = App::new(security(data), Theme::default());
    for _ in 0..39 {
        app.update(rio_tui::app::press(KeyCode::Down));
    }
    assert_last_visible(&app, "39aaaaaa", "security findings");
}

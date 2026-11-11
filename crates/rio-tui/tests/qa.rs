#![cfg(feature = "qa")]
//! The `qa` flow: Q1 journeys, Q2 live matrix, Q3 cell detail, Q4 UX
//! recommendations, against the handoff's sample data.

mod common;

use ratatui::{buffer::Buffer, crossterm::event::KeyCode, layout::Rect};
use rio_core::{Report, ReviewEvent};
use rio_tui::{
    App, Effect, Msg, Outcome, Session, Theme,
    app::press,
    qa::{
        self, Base, Baseline, Budget, CellDetail, CellFinding, CellId, CellOutcome, ChangedFile,
        Citation, Criterion, CriterionStatus, DiffLine, EnvStep, EvidenceFile, GuidanceUse,
        Harness, Ink, Journey, JourneyStep, JourneysData, LogEntry, MatrixCell, MatrixData,
        MatrixJourney, Meter, Observation, Persona, ProbeCount, Proposed, ProposedItem, RecStatus,
        Recommendation, Screenshot, Seed, SourceDiff, StepResult, SyncItem, SyncStatus, Tone,
        UxData, Why,
    },
};

fn s(text: &str) -> String {
    text.to_owned()
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|t| s(t)).collect()
}

fn cells() -> Vec<CellId> {
    vec![
        CellId::new("mobile", "light"),
        CellId::new("mobile", "dark"),
        CellId::new("desktop", "light"),
        CellId::new("desktop", "dark"),
    ]
}

const CHECKOUT_STEPS: [&str; 5] = [
    "Open the cart",
    "Proceed to checkout",
    "Pay with the test card",
    "Confirm the order",
    "View the confirmation",
];

fn journey(name: &str, persona: &str, selected: bool, why: Why) -> Journey {
    Journey {
        name: s(name),
        title: String::new(),
        persona: s(persona),
        tags: vec![],
        selected,
        why,
        chain: vec![],
        paths: vec![],
        routes: vec![],
        preconditions: vec![],
        steps: vec![],
        success: vec![],
        viewports: vec![],
        baseline: None,
    }
}

fn journeys_data() -> JourneysData {
    let step = |title: &str, route: &str, expect: &str| JourneyStep {
        title: s(title),
        route: s(route),
        expect: s(expect),
    };
    let checkout = Journey {
        title: s("Checkout with saved address"),
        tags: strings(&["smoke", "money"]),
        chain: strings(&["login", "add-to-cart", "checkout"]),
        paths: strings(&["src/**", "server.mjs"]),
        routes: strings(&["/cart", "/checkout", "/order/:id"]),
        preconditions: strings(&[
            "Synthetic products and persona accounts seeded",
            "Cart holds a Canvas bag (from add-to-cart)",
        ]),
        steps: vec![
            step("Open the cart", "/cart", "Canvas bag and total are visible"),
            step(
                "Proceed to checkout",
                "/checkout",
                "Saved address is preselected",
            ),
            step(
                "Pay with the test card",
                "/checkout",
                "Card form accepts the 4242 card",
            ),
            step(
                "Confirm the order",
                "/checkout",
                "Pay is reachable, order is placed",
            ),
            step(
                "View the confirmation",
                "/order/:id",
                "Order number and receipt mail",
            ),
        ],
        success: strings(&[
            "Order row exists for shopper",
            "One receipt captured by the mail double",
        ]),
        baseline: Some(Baseline {
            branch: s("main"),
            age: s("2h ago"),
            cells: cells()
                .into_iter()
                .map(|c| (c, CellOutcome::Passed))
                .collect(),
        }),
        ..journey("checkout", "shopper", true, Why::Covers(s("src/**")))
    };
    JourneysData {
        project: s("shop-demo"),
        config: s(".rio/qa.yaml"),
        mode: s("changed"),
        runtime: s("docker · pod"),
        personas: vec![
            Persona {
                name: s("shopper"),
                ready: true,
                note: s("creds ok"),
            },
            Persona {
                name: s("admin"),
                ready: true,
                note: s("creds ok"),
            },
            Persona {
                name: s("guest"),
                ready: false,
                note: s("no login"),
            },
        ],
        cells: cells(),
        changed: vec![
            ChangedFile {
                status: 'M',
                path: s("src/main.js"),
                added: 14,
                note: None,
            },
            ChangedFile {
                status: 'M',
                path: s("src/style.css"),
                added: 6,
                note: None,
            },
            ChangedFile {
                status: 'M',
                path: s("REVIEW.md"),
                added: 2,
                note: Some(s("guidance edited")),
            },
        ],
        cap: 5,
        journeys: vec![
            checkout,
            journey("add-to-cart", "shopper", true, Why::Covers(s("src/**"))),
            journey(
                "payment-recovery",
                "shopper",
                true,
                Why::Guidance(s("Recovery")),
            ),
            Journey {
                viewports: strings(&["desktop"]),
                ..journey(
                    "keyboard-shopping",
                    "shopper",
                    true,
                    Why::Covers(s("src/**")),
                )
            },
            journey("profile-address", "shopper", true, Why::Drift),
            journey("login", "shopper", false, Why::ChainedBy(s("checkout"))),
            journey("registration", "guest", false, Why::Held(s("cap"))),
            journey("admin-import", "admin", false, Why::NotCovered),
        ],
        proposed: Some(Proposed {
            file: s(".rio/qa.proposed.yaml"),
            items: vec![
                ProposedItem {
                    new: true,
                    journey: s("guest-checkout"),
                    note: s("from §Goals"),
                },
                ProposedItem {
                    new: false,
                    journey: s("payment-recovery"),
                    note: s("step 3 rewritten"),
                },
            ],
        }),
        sync: SyncStatus {
            command: s("rio qa sync --check"),
            exit: 1,
            items: vec![
                SyncItem {
                    journey: s("profile-address"),
                    reason: s("server.mjs changed"),
                },
                SyncItem {
                    journey: s("payment-recovery"),
                    reason: s("guidance edited"),
                },
            ],
        },
        seed: Seed {
            cached: true,
            fingerprint: s("9f3a·c21"),
            note: s("restore ~2.1 s"),
        },
        harness: Harness {
            name: s("codex"),
            via: s("gateway"),
            egress: s("deny-all"),
            doubles: strings(&["stripe", "mail"]),
        },
        budget: Budget {
            tokens: 500_000,
            per_voter: 60_000,
            preset: s("fast"),
        },
        ms_per_cell: 18_500,
    }
}

fn cell(outcome: CellOutcome, step: u32, secs: Option<u32>) -> MatrixCell {
    MatrixCell {
        step,
        secs,
        ..MatrixCell::new(outcome)
    }
}

fn passed(step: u32, secs: u32) -> MatrixCell {
    cell(CellOutcome::Passed, step, Some(secs))
}

fn running(step: u32) -> MatrixCell {
    cell(CellOutcome::Running, step, None)
}

fn queued() -> MatrixCell {
    cell(CellOutcome::Queued, 0, None)
}

fn row(name: &str, steps: usize, cells: Vec<MatrixCell>) -> MatrixJourney {
    let titles = if name == "checkout" {
        strings(&CHECKOUT_STEPS)
    } else {
        (1..=steps).map(|i| format!("Step {i}")).collect()
    };
    MatrixJourney {
        name: s(name),
        chained: false,
        steps: titles,
        cells,
    }
}

fn log(line: &str) -> LogEntry {
    LogEntry::parse(line)
}

fn env(label: &str, time: &str, note: Option<&str>) -> EnvStep {
    EnvStep {
        label: s(label),
        outcome: CellOutcome::Passed,
        time: s(time),
        note: note.map(s),
    }
}

fn matrix_data() -> MatrixData {
    let na = || cell(CellOutcome::NotApplicable(s("desktop only")), 0, None);
    MatrixData {
        harness: s("codex"),
        via: s("gateway"),
        isolation: s("pod"),
        cells: cells(),
        journeys: vec![
            MatrixJourney {
                chained: true,
                ..row(
                    "login",
                    2,
                    vec![passed(2, 14), passed(2, 13), passed(2, 11), passed(2, 12)],
                )
            },
            row(
                "checkout",
                5,
                vec![
                    passed(5, 58),
                    cell(CellOutcome::Failed, 4, None),
                    passed(5, 49),
                    running(3),
                ],
            ),
            row(
                "add-to-cart",
                3,
                vec![passed(3, 31), passed(3, 30), passed(3, 27), passed(3, 28)],
            ),
            row(
                "payment-recovery",
                4,
                vec![running(2), queued(), running(4), queued()],
            ),
            row(
                "keyboard-shopping",
                6,
                vec![na(), na(), running(5), queued()],
            ),
            row(
                "profile-address",
                4,
                vec![queued(), queued(), queued(), queued()],
            ),
        ],
        planned: 20,
        environment: vec![
            env("image built", "48 s", None),
            env("seed restored", "2.1", None),
            env("app ready", "1.4", Some("GET /api/health 200")),
            env("egress deny-all", "", None),
            env("doubles stripe, mail", "", None),
            env("clock frozen 09:00", "", None),
        ],
        budget_preset: s("fast"),
        tokens: Meter {
            used: 212_000,
            limit: 500_000,
        },
        voter: Meter {
            used: 31_000,
            limit: 60_000,
        },
        elapsed_secs: 192,
        remaining_secs: Some(170),
        usd: 0.17,
        probes: vec![
            ProbeCount {
                rule: s("ui/low-contrast"),
                hits: 2,
                checked: Some(41),
                severity: Tone::Warn,
            },
            ProbeCount {
                rule: s("mobile/fixed-overlap"),
                hits: 1,
                checked: Some(9),
                severity: Tone::Fail,
            },
            ProbeCount {
                rule: s("ui/console-error"),
                hits: 0,
                checked: None,
                severity: Tone::Fail,
            },
            ProbeCount {
                rule: s("mobile/tap-target"),
                hits: 0,
                checked: Some(63),
                severity: Tone::Warn,
            },
            ProbeCount {
                rule: s("ui/layout-shift"),
                hits: 0,
                checked: None,
                severity: Tone::Warn,
            },
        ],
        logs: vec![(
            s("checkout/desktop/dark"),
            vec![
                log("09:00:41 goto http://app.test:4173/checkout"),
                log("09:00:43 snapshot dom 1,214 nodes · screenshot masked"),
                log("09:00:44 fill #card-number  •••• •••• •••• 4242"),
                log("09:00:45 fill #card-exp  12/30"),
                log("09:00:46 expect Card form accepts the 4242 card"),
                log("09:00:47 stripe double · POST /v1/payment_intents → 200"),
                log("09:00:48 click button  Pay €38.00"),
                log("09:00:48 waiting navigation …"),
            ],
        )],
        live: Some(s("checkout/desktop/dark")),
        details: vec![cell_detail()],
        ux: Some(ux_data()),
    }
}

fn ink(segments: &[(Ink, &str)]) -> Vec<(Ink, String)> {
    segments.iter().map(|(i, t)| (*i, s(t))).collect()
}

fn screenshot() -> Screenshot {
    use Ink::*;
    let boxed = |inner: Ink, text: &str| ink(&[(Overlay, " │ "), (inner, text), (Overlay, " │ ")]);
    Screenshot {
        step: 4,
        size: s("390×844"),
        rows: vec![
            ink(&[(Chrome, " 09:00              ▂▄▆  ▮▮▮  ")]),
            ink(&[(Accent, " ◂  "), (Strong, "Checkout")]),
            vec![],
            ink(&[(Chrome, "  Ship to")]),
            ink(&[(Masked, "  ████████ ██████")]),
            ink(&[(Masked, "  ███ ████████ ██ ████")]),
            vec![],
            ink(&[(Chrome, "  Card   "), (Text, "•••• 4242      12/30")]),
            vec![],
            ink(&[(Chrome, "  Subtotal            "), (Text, "€34.00")]),
            ink(&[(Chrome, "  Shipping             "), (Text, "€4.00")]),
            ink(&[(Strong, "  Total               €38.00")]),
            vec![],
            vec![],
            ink(&[(Overlay, " ┌──────────────────────────┐ ")]),
            boxed(OverlayText, "We use cookies to keep  "),
            boxed(OverlayText, "your cart. Learn more   "),
            boxed(OverlayStrong, "[ Accept ]  [ Settings ]"),
            boxed(OverlayText, "                        "),
            ink(&[(Overlay, " └──────────────────────────┘ ")]),
            ink(&[(Chrome, " ░░░░░░  Pay €38.00  ░░░░░░░  ")]),
        ],
        verdict: strings(&["Pay ∩ #cookie-bar = 100 %", "tap at (195, 790) hit the bar"]),
    }
}

fn step_result(title: &str, outcome: CellOutcome, secs: Option<u32>) -> StepResult {
    StepResult {
        title: s(title),
        outcome,
        secs,
        expect: String::new(),
        saw: None,
    }
}

fn evidence(name: &str, note: &str, tone: Tone) -> EvidenceFile {
    EvidenceFile {
        name: s(name),
        path: format!(".rio/cache/qa/checkout/mobile-dark/{name}"),
        note: s(note),
        tone,
    }
}

fn cell_detail() -> CellDetail {
    let diff_line = |number: u32, sign: char, text: &str| DiffLine {
        number,
        sign,
        text: s(text),
    };
    CellDetail {
        journey: s("checkout"),
        cell: CellId::new("mobile", "dark"),
        outcome: CellOutcome::Failed,
        step: 4,
        base: Some(Base {
            branch: s("main"),
            outcome: CellOutcome::Passed,
        }),
        steps: vec![
            step_result("Open the cart", CellOutcome::Passed, Some(6)),
            step_result("Proceed to checkout", CellOutcome::Passed, Some(9)),
            step_result("Pay with test card", CellOutcome::Passed, Some(14)),
            StepResult {
                expect: s("Pay reachable, order placed"),
                saw: Some(s("Pay under the cookie bar, y 780")),
                ..step_result("Confirm the order", CellOutcome::Failed, Some(21))
            },
            step_result("View confirmation", CellOutcome::NotRun, None),
        ],
        screenshot: Some(screenshot()),
        base_screenshot: Some(Screenshot {
            verdict: strings(&["Pay is clear of #cookie-bar"]),
            ..screenshot()
        }),
        others: vec![
            (CellId::new("mobile", "light"), CellOutcome::Passed),
            (CellId::new("desktop", "light"), CellOutcome::Passed),
            (CellId::new("desktop", "dark"), CellOutcome::Running),
        ],
        delta: Some((CellId::new("mobile", "light"), s("cookie bar 64 → 112 px"))),
        evidence: vec![
            evidence("step-4.png", "masked", Tone::Faint),
            evidence("step-4.dom.html", "", Tone::Faint),
            evidence("trace.zip", "1.8 MB", Tone::Faint),
            evidence("console.log", "0 err", Tone::Pass),
        ],
        evidence_store: s(".rio/cache/qa · 7 d"),
        finding: Some(CellFinding {
            id: s("q-41d0a7c2e95b"),
            state: s("new"),
            severity: s("error"),
            category: s("defect"),
            evidence_level: s("static_proven"),
            fails: true,
            title: s("Pay is covered by the cookie bar"),
            rule: s("mobile/fixed-overlap"),
            kind: s("probe"),
            route: s("/checkout"),
            element: s("button#pay"),
            source: Some((s("src/style.css"), 212)),
            attribution: s("attributed"),
            cells: vec![CellId::new("mobile", "dark")],
            cells_total: 4,
        }),
        diff: Some(SourceDiff {
            path: s("src/style.css"),
            added: 6,
            removed: 0,
            lines: vec![
                diff_line(209, ' ', ".cookie-bar {"),
                diff_line(210, ' ', "  position: fixed; bottom: 0;"),
                diff_line(211, '+', "  padding: var(--space-6);"),
                diff_line(212, '+', "  line-height: 2.4;"),
                diff_line(213, ' ', "}"),
            ],
            attributed: 212,
            note: strings(&["bar grows to 112 px in dark", "(font fallback is taller)"]),
        }),
        observations: vec![Observation {
            text: s("Total shifts 8 px after card entry"),
            notes: strings(&[
                "below ui/layout-shift threshold",
                "shown, never counted as a finding",
            ]),
        }],
        proof: strings(&[
            "probe measured it: static_proven",
            "no model judged this finding",
            "PR comment anchors on style.css:212",
        ]),
    }
}

fn criterion(name: &str, status: CriterionStatus) -> Criterion {
    Criterion {
        name: s(name),
        status,
    }
}

fn rec(rule: &str, status: RecStatus, observed: bool) -> Recommendation {
    Recommendation {
        rule: s(rule),
        title: s(rule),
        status,
        observed,
        held: None,
        journey: s("checkout"),
        cell: None,
        step: None,
        evidence: vec![],
        notes: vec![],
        guidance: None,
        proposal: s("Make it better."),
        benefit: s("rio did not run the changed flow"),
        voters: None,
        voter_note: String::new(),
        publish: s("PR summary only, never inline"),
    }
}

fn ux_data() -> UxData {
    use CriterionStatus::{Assessed, NotAssessed};
    UxData {
        rubric: s("rio/ui-v1"),
        version: s("0.1.0"),
        scope: s("ux/*"),
        criteria: vec![
            criterion("task-clarity", Assessed),
            criterion("system-feedback", Assessed),
            criterion("error-prevention", Assessed),
            criterion("error-recovery", Assessed),
            criterion("user-control", NotAssessed(s("no journey reached undo"))),
            criterion("consistency", Assessed),
            criterion("recognition", Assessed),
            criterion("task-efficiency", Assessed),
            criterion(
                "inclusive-interaction",
                NotAssessed(s("keyboard journey cancelled (budget)")),
            ),
        ],
        recommendations: vec![
            Recommendation {
                title: s("A declined card leaves no way to retry without retyping the address"),
                journey: s("payment-recovery"),
                cell: Some(CellId::new("desktop", "light")),
                step: Some(3),
                evidence: vec![
                    EvidenceFile {
                        name: s("step-3.png"),
                        path: s(".rio/cache/qa/payment-recovery/desktop-light/step-3.png"),
                        note: String::new(),
                        tone: Tone::Faint,
                    },
                    EvidenceFile {
                        name: s("step-3b.png"),
                        path: s(".rio/cache/qa/payment-recovery/desktop-light/step-3b.png"),
                        note: s("+3 s"),
                        tone: Tone::Faint,
                    },
                ],
                notes: strings(&[
                    "error toast disappears after 3 s",
                    "the form clears both card and address",
                    "agent needed 4 extra steps to retry",
                ]),
                guidance: Some(Citation {
                    file: s("REVIEW.md"),
                    section: s("Recovery"),
                    line: 18,
                    quote: s(
                        "A shopper must be able to retry a declined card without re-entering the address.",
                    ),
                }),
                proposal: s(
                    "Keep the address; show the decline inline next to the card field and move focus there.",
                ),
                voters: Some((2, 3)),
                voter_note: s("voters saw the screenshots and §Recovery"),
                ..rec("ux/error-recovery", RecStatus::Supported, true)
            },
            rec("ux/system-feedback", RecStatus::Supported, true),
            rec("ux/task-efficiency", RecStatus::Unverified, false),
            Recommendation {
                held: Some(s("dense grid is intentional")),
                guidance: Some(Citation {
                    file: s("REVIEW.md"),
                    section: s("Intentional"),
                    line: 42,
                    quote: s("The product grid is dense on purpose."),
                }),
                ..rec("ux/consistency", RecStatus::Held, true)
            },
        ],
        guidance_file: s("REVIEW.md"),
        guidance: vec![
            GuidanceUse {
                section: s("Goals"),
                used: 3,
                held: 0,
            },
            GuidanceUse {
                section: s("Recovery"),
                used: 1,
                held: 0,
            },
            GuidanceUse {
                section: s("Accessibility"),
                used: 2,
                held: 0,
            },
            GuidanceUse {
                section: s("Intentional"),
                used: 0,
                held: 1,
            },
        ],
        verification: s("hosted"),
    }
}

fn q3() -> Box<dyn rio_tui::Screen> {
    let mut light = CellDetail::basic(
        "checkout",
        CellId::new("mobile", "light"),
        &strings(&CHECKOUT_STEPS),
        CellOutcome::Passed,
        5,
    );
    light.others = vec![(CellId::new("mobile", "dark"), CellOutcome::Failed)];
    qa::cell_detail(vec![light, cell_detail()], 1, Some(ux_data()))
}

fn draw(app: &App, cols: u16, rows: u16) -> Buffer {
    let area = Rect::new(0, 0, cols, rows);
    let mut buf = Buffer::empty(area);
    app.draw(&mut buf, area);
    buf
}

fn text(app: &App) -> String {
    common::lines(&draw(app, 120, 40))
}

// Golden conformance.

#[test]
fn q1_journeys_matches_its_design() {
    let buf = common::render(qa::journeys(journeys_data()), Session::default(), 120, 40);
    common::assert_screen("qa-q1-journeys", &buf);
}

#[test]
fn q2_matrix_matches_its_design() {
    let buf = common::render(qa::matrix(matrix_data()), Session::default(), 120, 40);
    common::assert_screen("qa-q2-matrix-live", &buf);
}

#[test]
fn q3_cell_detail_matches_its_design() {
    let buf = common::render(q3(), Session::default(), 120, 40);
    common::assert_screen("qa-q3-cell-detail", &buf);
}

#[test]
fn q4_ux_recommendations_matches_its_design() {
    let buf = common::render(
        qa::ux_recommendations(ux_data()),
        Session::default(),
        120,
        40,
    );
    common::assert_screen("qa-q4-ux-recommendations", &buf);
}

// Q1.

fn start_args(effects: &[Effect]) -> Vec<String> {
    effects
        .iter()
        .find_map(|e| match e {
            Effect::Start(args) => Some(args.clone()),
            _ => None,
        })
        .expect("a Start effect")
}

fn args(items: &[&str]) -> Vec<String> {
    strings(items)
}

#[test]
fn q1_runs_the_selected_journeys_and_opens_the_matrix() {
    let mut app = App::new(qa::journeys(journeys_data()), Theme::default());
    let effects = app.update(press(KeyCode::Enter));
    assert_eq!(
        start_args(&effects),
        args(&[
            "qa",
            "--journey",
            "checkout",
            "--journey",
            "add-to-cart",
            "--journey",
            "payment-recovery",
            "--journey",
            "keyboard-shopping",
            "--journey",
            "profile-address",
        ])
    );
    assert_eq!(app.top().title(), "QA matrix");
    let screen = text(&app);
    // The plan: the chained dependency first, every cell queued, n/a where limited.
    assert!(screen.contains("↳ login"), "{screen}");
    assert!(screen.contains("· queued"), "{screen}");
    assert!(screen.contains("– desktop only"), "{screen}");
    // Every cell shown counts: the chained login row too, not the n/a cells.
    assert!(screen.contains("0 of 22 cells done"), "{screen}");
}

#[test]
fn q1_space_selects_and_toggles_set_full_and_baseline() {
    let mut app = App::new(qa::journeys(journeys_data()), Theme::default());
    // Deselect checkout, select registration (held by the cap).
    app.update(press(KeyCode::Char(' ')));
    for _ in 0..6 {
        app.update(press(KeyCode::Down));
    }
    app.update(press(KeyCode::Char(' ')));
    // A chained journey cannot be toggled on its own.
    app.update(press(KeyCode::Up));
    app.update(press(KeyCode::Char(' ')));
    app.update(press(KeyCode::Char('b')));
    let effects = app.update(press(KeyCode::Enter));
    assert_eq!(
        start_args(&effects),
        args(&[
            "qa",
            "--journey",
            "add-to-cart",
            "--journey",
            "payment-recovery",
            "--journey",
            "keyboard-shopping",
            "--journey",
            "profile-address",
            "--journey",
            "registration",
            "--baseline",
        ])
    );

    let mut app = App::new(qa::journeys(journeys_data()), Theme::default());
    app.update(press(KeyCode::Char('a')));
    assert!(text(&app).contains("full mode"));
    assert_eq!(
        start_args(&app.update(press(KeyCode::Enter))),
        args(&["qa", "--full"])
    );

    // `a` twice is back to the selection.
    let mut app = App::new(qa::journeys(journeys_data()), Theme::default());
    app.update(press(KeyCode::Char('a')));
    app.update(press(KeyCode::Char('a')));
    assert_eq!(start_args(&app.update(press(KeyCode::Enter))).len(), 11);
}

#[test]
fn q1_sync_init_and_validate_are_steps() {
    let mut app = App::new(qa::journeys(journeys_data()), Theme::default());
    for (key, step) in [('s', "qa:sync"), ('i', "qa:init"), ('v', "qa:validate")] {
        assert_eq!(
            app.update(press(KeyCode::Char(key))),
            vec![Effect::Step(s(step))]
        );
    }
    assert_eq!(app.stack.len(), 1);
}

// Q2.

fn qa_cell(journey: &str, viewport: &str, scheme: &str, step: u32, outcome: &str) -> Msg {
    Msg::Review(ReviewEvent::QaCell {
        journey: s(journey),
        viewport: s(viewport),
        color_scheme: s(scheme),
        step,
        outcome: s(outcome),
    })
}

#[test]
fn q2_applies_qa_cell_events_and_a_failure_stops_nothing() {
    let mut app = App::new(qa::matrix(matrix_data()), Theme::default());
    app.update(qa_cell("profile-address", "mobile", "light", 1, "running"));
    assert!(text(&app).contains("profile-address     ◐ step 1"));
    for _ in 0..8 {
        app.update(Msg::Tick);
    }
    app.update(qa_cell("profile-address", "mobile", "light", 4, "passed"));
    let screen = text(&app);
    assert!(screen.contains("profile-address     ✓ 4/4  2s"), "{screen}");
    assert!(screen.contains("12 of 20 cells done"), "{screen}");
    // Another failure: counted, the other cells still run.
    app.update(qa_cell("payment-recovery", "mobile", "light", 2, "failed"));
    let screen = text(&app);
    assert!(screen.contains("✕ 2 failed"), "{screen}");
    assert!(screen.contains("◐ step 4"), "{screen}");
    // The first failure stays the one shown.
    assert!(screen.contains("first failure: checkout × mobile·dark at step 4"));
    // The live log follows the cell that most recently reported a step.
    assert!(text(&app).contains("LIVE · profile-address × mobile·light"));
    app.update(qa_cell("checkout", "desktop", "dark", 4, "running"));
    assert!(text(&app).contains("LIVE · checkout × desktop·dark"));
    // Log lines of the followed cell appear.
    app.update(Msg::Review(ReviewEvent::Log {
        source: s("qa:checkout/desktop/dark"),
        line: s("09:00:50 expect Order is placed"),
    }));
    assert!(text(&app).contains("✓ expect     Order is placed"));
}

#[test]
fn q2_undoes_a_cancel_or_pause_the_runner_refused() {
    let mut app = App::new(qa::matrix(matrix_data()), Theme::default());
    app.update(press(KeyCode::Right));
    app.update(press(KeyCode::Right));
    let before = text(&app);
    assert_eq!(
        app.update(press(KeyCode::Char('c'))),
        vec![Effect::Step(s("qa:cancel:checkout/desktop/dark"))]
    );
    assert!(text(&app).contains("■ cancelled"));
    app.update(Msg::Done(Outcome::Failed(s(
        "not supported by this runner yet",
    ))));
    assert!(!text(&app).contains("■ cancelled"));
    assert_eq!(text(&app).lines().nth(6), before.lines().nth(6));
    app.update(press(KeyCode::Char('p')));
    assert!(text(&app).contains("■ queue paused"));
    app.update(Msg::Done(Outcome::Failed(s(
        "not supported by this runner yet",
    ))));
    assert!(!text(&app).contains("queue paused"));
}

#[test]
fn q2_c_cancels_the_focused_cell_and_p_pauses_the_queue() {
    let mut app = App::new(qa::matrix(matrix_data()), Theme::default());
    // Focus starts on the first failure; a finished cell cannot be cancelled.
    assert!(app.update(press(KeyCode::Char('c'))).is_empty());
    app.update(press(KeyCode::Right));
    app.update(press(KeyCode::Right));
    assert_eq!(
        app.update(press(KeyCode::Char('c'))),
        vec![Effect::Step(s("qa:cancel:checkout/desktop/dark"))]
    );
    let screen = text(&app);
    assert!(screen.contains("■ cancelled"), "{screen}");
    // A late `running` event does not resurrect it.
    app.update(qa_cell("checkout", "desktop", "dark", 4, "running"));
    assert!(text(&app).contains("■ cancelled"));

    assert_eq!(
        app.update(press(KeyCode::Char('p'))),
        vec![Effect::Step(s("qa:pause"))]
    );
    assert!(text(&app).contains("■ queue paused"));
    assert_eq!(
        app.update(press(KeyCode::Char('p'))),
        vec![Effect::Step(s("qa:resume"))]
    );
    assert!(!text(&app).contains("queue paused"));
}

#[test]
fn q2_enter_opens_the_focused_cell() {
    let mut app = App::new(qa::matrix(matrix_data()), Theme::default());
    assert!(app.update(press(KeyCode::Enter)).is_empty());
    assert_eq!(app.top().title(), "QA cell");
    let screen = text(&app);
    assert!(screen.contains("qa · checkout × mobile·dark"), "{screen}");
    assert!(screen.contains("✕ failed at step 4"));
    // esc is back on the matrix.
    app.update(press(KeyCode::Esc));
    assert_eq!(app.top().title(), "QA matrix");
    // A cell without detail data opens from its matrix state.
    app.update(press(KeyCode::Up));
    app.update(press(KeyCode::Enter));
    let screen = text(&app);
    assert!(screen.contains("qa · login × mobile·dark"), "{screen}");
    assert!(screen.contains("✓ passed · 2 steps"), "{screen}");
    // A not-applicable cell does not open.
    app.update(press(KeyCode::Esc));
    for _ in 0..4 {
        app.update(press(KeyCode::Down));
    }
    app.update(press(KeyCode::Left));
    app.update(press(KeyCode::Enter));
    assert_eq!(app.top().title(), "QA matrix");
}

#[test]
fn q2_l_follows_the_focused_cell() {
    let mut app = App::new(qa::matrix(matrix_data()), Theme::default());
    assert!(text(&app).contains("LIVE · checkout × desktop·dark"));
    app.update(press(KeyCode::Char('l')));
    assert!(text(&app).contains("LOG · checkout × mobile·dark"));
    app.update(press(KeyCode::Char('l')));
    assert!(text(&app).contains("LIVE · checkout × desktop·dark"));
}

fn fixture_report() -> Report {
    serde_json::from_str(include_str!("../../rio-core/tests/qa-fixtures/report.json")).unwrap()
}

/// The fixture's report as a run of one cell again: `checkout` on
/// mobile·light now passes, under another run id.
fn rerun_report() -> Report {
    let mut report = fixture_report();
    report.review.run_id = Some(s("01J00000000000000000000099"));
    let qa = report.qa.as_mut().unwrap();
    let journey = &mut qa["journeys"][0];
    let cell = journey["cells"][0].clone();
    journey["cells"] = serde_json::json!([cell]);
    journey["cells"][0]["outcome"] = serde_json::json!("passed");
    journey["cells"][0]["step_reached"] = serde_json::json!(5);
    report
}

#[test]
fn q2_a_run_that_ends_while_a_cell_is_open_reaches_the_matrix() {
    let mut app = App::new(qa::matrix(matrix_data()), Theme::default());
    app.update(press(KeyCode::Enter));
    assert_eq!(app.top().title(), "QA cell");
    app.update(qa_cell("profile-address", "mobile", "light", 4, "passed"));
    app.update(Msg::Review(ReviewEvent::Done {
        report: Box::new(fixture_report()),
    }));
    // The open detail took the report; the matrix catches up on esc.
    assert!(app.session.report.is_some());
    app.update(press(KeyCode::Esc));
    let screen = text(&app);
    assert!(screen.contains("✓ run finished"), "{screen}");
    assert!(screen.contains("profile-address     ✓ 4/4"), "{screen}");
}

#[test]
fn q2_a_cell_run_again_replaces_its_outcome_and_keeps_the_first_report() {
    let mut app = App::new(qa::matrix(matrix_data()), Theme::default());
    app.update(Msg::Review(ReviewEvent::Done {
        report: Box::new(fixture_report()),
    }));
    let first = app.session.report.clone().unwrap().review.run_id;
    assert!(text(&app).contains("checkout            ✕ step 4"));
    // `r` in the detail started the rerun; its events and report arrive there.
    app.update(press(KeyCode::Enter));
    app.update(qa_cell("checkout", "mobile", "light", 1, "running"));
    app.update(Msg::Review(ReviewEvent::Done {
        report: Box::new(rerun_report()),
    }));
    assert_eq!(app.session.reruns.len(), 1);
    assert_eq!(app.session.report.as_ref().unwrap().review.run_id, first);
    let holder = app
        .session
        .report_for("checkout", "mobile", "light")
        .unwrap();
    assert_eq!(
        holder.review.run_id.as_deref(),
        Some("01J00000000000000000000099")
    );
    let holder = app
        .session
        .report_for("checkout", "desktop", "light")
        .unwrap();
    assert_eq!(holder.review.run_id, first);
    app.update(press(KeyCode::Esc));
    // The matrix merged the same rerun once.
    assert_eq!(app.session.reruns.len(), 1);
    let mut app2 = App::new(qa::matrix(matrix_data()), Theme::default());
    app2.update(Msg::Review(ReviewEvent::Done {
        report: Box::new(fixture_report()),
    }));
    app2.update(Msg::Review(ReviewEvent::Done {
        report: Box::new(rerun_report()),
    }));
    assert_eq!(app2.session.reruns.len(), 1);
    assert_eq!(app2.session.report.as_ref().unwrap().review.run_id, first);
    let screen = text(&app2);
    assert!(screen.contains("checkout            ✓ 5/5"), "{screen}");
}

#[test]
fn q2_done_and_partial_keep_the_report_and_the_matrix() {
    let report: Report =
        serde_json::from_str(include_str!("../../rio-core/tests/qa-fixtures/report.json")).unwrap();
    let mut app = App::new(qa::matrix(matrix_data()), Theme::default());
    app.update(Msg::Review(ReviewEvent::Partial {
        report: Box::new(report.clone()),
    }));
    assert!(app.session.report.is_some());
    assert_eq!(app.session.exit_code, None);
    let screen = text(&app);
    // Running and queued cells were cancelled; the report's outcomes applied.
    assert!(screen.contains("■ cancelled"), "{screen}");
    assert!(!screen.contains("◐ step"), "{screen}");
    assert!(screen.contains("✓ run finished"), "{screen}");
    assert_eq!(app.top().title(), "QA matrix");

    let mut app = App::new(qa::matrix(matrix_data()), Theme::default());
    app.update(Msg::Review(ReviewEvent::Done {
        report: Box::new(report),
    }));
    assert!(app.session.report.is_some());
    assert!(text(&app).contains("checkout × mobile·dark"));
}

// Q3.

#[test]
fn q3_moves_between_cells_and_steps() {
    let mut app = App::new(q3(), Theme::default());
    assert!(text(&app).contains("qa · checkout × mobile·dark"));
    app.update(press(KeyCode::Char('[')));
    assert!(text(&app).contains("qa · checkout × mobile·light"));
    app.update(press(KeyCode::Char('[')));
    assert!(text(&app).contains("qa · checkout × mobile·light"));
    app.update(press(KeyCode::Char(']')));
    assert!(text(&app).contains("qa · checkout × mobile·dark"));
    // ←: the focused step moves, its expectation shows under it.
    assert!(text(&app).contains("saw    Pay under the"));
    app.update(press(KeyCode::Left));
    let screen = text(&app);
    assert!(!screen.contains("saw    Pay under the"), "{screen}");
}

#[test]
fn q3_b_compares_with_base_and_e_r_o_are_effects() {
    let mut app = App::new(q3(), Theme::default());
    assert!(text(&app).contains("SCREENSHOT step 4"));
    app.update(press(KeyCode::Char('b')));
    let screen = text(&app);
    assert!(screen.contains("BASE main step 4"), "{screen}");
    assert!(screen.contains("Pay is clear of #cookie-bar"));
    app.update(press(KeyCode::Char('b')));
    assert!(text(&app).contains("SCREENSHOT step 4"));
    assert_eq!(
        app.update(press(KeyCode::Char('e'))),
        vec![Effect::Edit {
            path: s("src/style.css"),
            line: 212
        }]
    );
    // A cell runs again only once the run has finished.
    assert!(app.update(press(KeyCode::Char('r'))).is_empty());
    assert!(matches!(&app.session.notice, Some(Outcome::Failed(m)) if m.contains("still going")));
    app.session.report = Some(fixture_report());
    assert_eq!(
        app.update(press(KeyCode::Char('r'))),
        vec![Effect::Step(s("qa:rerun:checkout/mobile/dark"))]
    );
    assert_eq!(
        app.update(press(KeyCode::Char('o'))),
        vec![Effect::Open(s(
            ".rio/cache/qa/checkout/mobile-dark/step-4.png"
        ))]
    );
}

#[test]
fn q3_4_opens_ux_and_esc_there_returns_to_the_matrix() {
    let mut app = App::new(qa::matrix(matrix_data()), Theme::default());
    app.update(press(KeyCode::Enter));
    app.update(press(KeyCode::Char('4')));
    assert_eq!(app.top().title(), "QA UX recommendations");
    app.update(press(KeyCode::Esc));
    assert_eq!(app.top().title(), "QA matrix");
    assert_eq!(app.stack.len(), 1);
}

// Q4.

#[test]
fn q4_actions_never_change_the_exit_code() {
    let mut app = App::new(qa::ux_recommendations(ux_data()), Theme::default());
    app.session.exit_code = Some(0);
    let mut effects = Vec::new();
    for code in [
        KeyCode::Down,
        KeyCode::Enter,
        KeyCode::Char('g'),
        KeyCode::Char('o'),
        KeyCode::Char('y'),
        KeyCode::Char('x'),
        KeyCode::Up,
        KeyCode::Enter,
        KeyCode::Char('g'),
        KeyCode::Char('o'),
        KeyCode::Char('y'),
    ] {
        effects.extend(app.update(press(code)));
        assert_eq!(app.session.exit_code, Some(0));
    }
    assert!(effects.iter().all(|e| matches!(
        e,
        Effect::Copy(_) | Effect::Open(_) | Effect::Edit { .. } | Effect::Export { .. }
    )));
    assert!(effects.contains(&Effect::Export {
        format: s("md"),
        path: s("ux-recommendations.md")
    }));
    assert!(effects.contains(&Effect::Edit {
        path: s("REVIEW.md"),
        line: 18
    }));
    assert!(effects.contains(&Effect::Open(s(
        ".rio/cache/qa/payment-recovery/desktop-light/step-3.png"
    ))));
    let copied = effects
        .iter()
        .find_map(|e| match e {
            Effect::Copy(md) if md.contains("declined card") => Some(md.clone()),
            _ => None,
        })
        .expect("R1 copied as an issue");
    assert!(copied.starts_with("### UX: A declined card"));
    assert!(copied.contains("advice, never fails the review"));
    assert!(copied.contains("**Recommendation.** Keep the address"));
}

#[test]
fn q4_enter_expands_the_recommendation() {
    let mut app = App::new(qa::ux_recommendations(ux_data()), Theme::default());
    app.update(press(KeyCode::Down));
    app.update(press(KeyCode::Enter));
    assert!(text(&app).contains("       Make it better."));
}

// From Report.qa.

#[test]
fn data_builds_from_report_qa() {
    let report: Report =
        serde_json::from_str(include_str!("../../rio-core/tests/qa-fixtures/report.json")).unwrap();
    let qa_json = report.qa.as_ref().unwrap();
    let matrix = MatrixData::from_qa(qa_json);
    assert_eq!(matrix.harness, "codex");
    assert_eq!(matrix.journeys.len(), 1);
    assert_eq!(matrix.cells.len(), 2);
    assert_eq!(matrix.journeys[0].cells[0].outcome, CellOutcome::Failed);
    assert_eq!(matrix.journeys[0].cells[0].step, 4);
    let ux = UxData::from_qa(qa_json).unwrap();
    assert_eq!(ux.rubric, "rio/ui-v1");
    assert_eq!(ux.version, "0.1.0");
    assert_eq!(ux.recommendations[0].status, RecStatus::Supported);
    assert_eq!(ux.criteria[0].name, "task-efficiency");
    let seed = Seed::from_qa(qa_json).unwrap();
    assert!(seed.cached);
    let detail =
        CellDetail::from_report(&report, "checkout", &CellId::new("mobile", "light")).unwrap();
    assert_eq!(detail.outcome, CellOutcome::Failed);
    assert_eq!(detail.evidence[0].name, "4.png");
    let finding = detail.finding.unwrap();
    assert_eq!(finding.rule, "ui/no-feedback");
    assert_eq!(finding.cells.len(), 2);
    // Every screen renders from report data alone.
    let mut app = App::new(qa::matrix(matrix), Theme::default());
    let screen = text(&app);
    assert!(screen.contains("checkout"), "{screen}");
    app.update(press(KeyCode::Enter));
    assert_eq!(app.top().title(), "QA cell");
    common::render(qa::ux_recommendations(ux), Session::default(), 120, 40);
}

// Robustness.

fn screens() -> Vec<(&'static str, Box<dyn rio_tui::Screen>)> {
    vec![
        ("qa-q1-journeys", qa::journeys(journeys_data())),
        ("qa-q2-matrix-live", qa::matrix(matrix_data())),
        ("qa-q3-cell-detail", q3()),
        (
            "qa-q4-ux-recommendations",
            qa::ux_recommendations(ux_data()),
        ),
    ]
}

#[test]
fn q3_v_shows_the_screenshot_on_a_narrow_terminal() {
    let mut app = App::new(q3(), Theme::default());
    let narrow = |app: &App| common::lines(&draw(app, 100, 30));
    let details = narrow(&app);
    assert!(details.contains("FINDING"), "{details}");
    assert!(!details.contains("SCREENSHOT step 4"), "{details}");
    assert!(details.contains("v screenshot"), "{details}");
    app.update(press(KeyCode::Char('v')));
    let shot = narrow(&app);
    assert!(shot.contains("SCREENSHOT step 4"), "{shot}");
    assert!(!shot.contains("FINDING"), "{shot}");
    assert!(shot.contains("v details"), "{shot}");
    for line in shot.lines() {
        assert_eq!(unicode_width::UnicodeWidthStr::width(line), 100, "{line}");
    }
    // At 120 columns both panes show, and `v` changes nothing.
    let wide = text(&app);
    assert!(wide.contains("SCREENSHOT step 4") && wide.contains("FINDING"));
    assert!(!wide.contains("v details"));
}

#[test]
fn every_screen_fits_80_by_24() {
    for (slug, screen) in screens() {
        let buf = common::render(screen, Session::default(), 80, 24);
        let lines = common::lines(&buf);
        for line in lines.lines() {
            assert_eq!(
                unicode_width::UnicodeWidthStr::width(line),
                80,
                "{slug}: {line}"
            );
        }
        insta::assert_snapshot!(format!("{slug}_80x24"), lines);
    }
}

#[test]
fn without_color_every_state_reads_by_glyph() {
    let theme = Theme {
        color: false,
        ..Theme::default()
    };
    for (slug, screen) in screens() {
        let buf = common::render_with(screen, Session::default(), 120, 40, theme);
        for cell in buf.content() {
            assert_eq!(
                cell.style().fg,
                Some(ratatui::style::Color::Reset),
                "{slug}"
            );
            assert_eq!(
                cell.style().bg,
                Some(ratatui::style::Color::Reset),
                "{slug}"
            );
        }
        let text = common::lines(&buf);
        // The focused row or cell is marked by reverse video.
        assert!(
            buf.content().iter().any(|c| c
                .style()
                .add_modifier
                .contains(ratatui::style::Modifier::REVERSED)),
            "{slug}: no cursor"
        );
        match slug {
            "qa-q2-matrix-live" => {
                for state in [
                    "✓ 5/5",
                    "✕ step 4",
                    "◐ step 3",
                    "· queued",
                    "– desktop only",
                ] {
                    assert!(text.contains(state), "{slug}: {state}");
                }
            }
            "qa-q3-cell-detail" => {
                for state in ["✕ 4 Confirm", "✓ 1 Open", "· 5 View", "+ 212", "[FAIL]"] {
                    assert!(text.contains(state), "{slug}: {state}");
                }
            }
            "qa-q4-ux-recommendations" => {
                for state in ["supported", "unverified", "held", "advice · never fails"] {
                    assert!(text.contains(state), "{slug}: {state}");
                }
            }
            _ => {
                for state in ["● checkout", "○ registration", "↳ login", "◐ drift"] {
                    assert!(text.contains(state), "{slug}: {state}");
                }
            }
        }
    }
}

#[test]
fn ascii_glyphs_keep_every_qa_row_the_terminal_width() {
    let theme = Theme {
        glyphs: rio_core::glyphs::GlyphSet::Ascii,
        ..Theme::default()
    };
    for (slug, screen) in screens() {
        let text = common::lines(&common::render_with(
            screen,
            Session::default(),
            120,
            40,
            theme,
        ));
        assert!(text.is_ascii(), "{slug}: {text}");
        assert!(text.lines().all(|l| l.len() == 120), "{slug}");
    }
}

#[test]
fn long_qa_lists_keep_the_cursor_in_view() {
    let visible = |app: &App, marker: &str, what: &str| {
        let text = common::lines(&draw(app, 120, 40));
        assert!(
            text.contains(marker),
            "{what}: the last item is out of view\n{text}"
        );
    };
    // Journeys.
    let mut data = journeys_data();
    let template = data.journeys[0].clone();
    data.journeys = (0..40)
        .map(|i| Journey {
            name: format!("journey-{i:02}"),
            ..template.clone()
        })
        .collect();
    let mut app = App::new(rio_tui::qa::journeys(data), Theme::default());
    for _ in 0..39 {
        app.update(rio_tui::app::press(KeyCode::Down));
    }
    visible(&app, "journey-39", "journeys");

    // The live matrix.
    let mut data = matrix_data();
    let template = data.journeys[0].clone();
    data.journeys = (0..40)
        .map(|i| MatrixJourney {
            name: format!("journey-{i:02}"),
            chained: false,
            ..template.clone()
        })
        .collect();
    let mut app = App::new(rio_tui::qa::matrix(data), Theme::default());
    for _ in 0..39 {
        app.update(rio_tui::app::press(KeyCode::Down));
    }
    visible(&app, "journey-39", "matrix");

    // UX recommendations.
    let mut data = ux_data();
    let template = data.recommendations[0].clone();
    data.recommendations = (0..40)
        .map(|i| Recommendation {
            title: format!("friction number {i:02}"),
            ..template.clone()
        })
        .collect();
    let mut app = App::new(rio_tui::qa::ux_recommendations(data), Theme::default());
    for _ in 0..39 {
        app.update(rio_tui::app::press(KeyCode::Down));
    }
    visible(&app, "friction number 39", "ux recommendations");
    // The list itself (the middle pane) shows the last item, a sign for those
    // above, and still the legend under it.
    let text = common::lines(&draw(&app, 120, 40));
    assert!(text.contains("R40"), "{text}");
    assert!(text.contains("↑ ") && text.contains(" more"), "{text}");
    assert!(text.contains("Advice never fails a review."), "{text}");
    for _ in 0..39 {
        app.update(rio_tui::app::press(KeyCode::Up));
    }
    let text = common::lines(&draw(&app, 120, 40));
    assert!(text.contains("R1 ") && text.contains("↓ "), "{text}");
}

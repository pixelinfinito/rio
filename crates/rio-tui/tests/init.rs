#![cfg(feature = "init")]
//! The `init` flow: I1–I6 against the handoff, and their behavior.

mod common;

use ratatui::crossterm::event::KeyCode;
use rio_tui::{
    App, Effect, Msg, Outcome, Screen, Session, Theme,
    app::press,
    init::{
        Account, Artifact, Check, CheckState, ChooseMode, Configure, ConfigureData, ConnectData,
        ConnectExisting, CredentialStore, DeployedData, DeployedResource, Deploying, DeployingData,
        Handoff, InitData, LogLine, Migration, Plan, PlanResource, Provider, ResourceRow, Runner,
        RunnerImage, SecretRow, StepState, TokenSource, choose_mode,
    },
};
use serde_json::json;

const ACCOUNT_ID: &str = "3f9c0b5e7d214c8a9e6f1b2d3c4aa21e";
const KEY: &str = "sk-or-v1-q7Zr3x9PmK2wLs8YtB4nH"; // 30 characters
const TOKEN: &str = "rio_tok_q1W2e3R4t5Y6u7I8o9P0aSd"; // 31 characters
const URL: &str = "https://rio.pixel-labs.workers.dev";

fn pixel() -> Account {
    Account {
        name: "Pixel Infinito".into(),
        id: ACCOUNT_ID.into(),
    }
}

fn plan() -> Plan {
    let r = |kind: &str, name: &str| PlanResource {
        kind: kind.into(),
        name: name.into(),
        action: "create".into(),
    };
    Plan {
        bundle: "7c21a9e4f0b2d6c8".into(),
        worker_version: "0.2.0".into(),
        changes: false,
        resources: vec![
            r("Worker", "rio"),
            r("ReviewWorkflow", "rio-review"),
            r("MigrationWorkflow", "rio-migrate"),
            r("D1 database", "rio"),
            r("R2 bucket", "rio-artifacts"),
            r("Queue", "rio-jobs"),
            r("AI Gateway", "rio · auth, no logs"),
            r("Gateway token", "AI Gateway Run"),
            r("Sandbox app", "rio · standard-3"),
            r("workers.dev route", "rio.pixel-labs"),
        ],
        bindings: [
            "DB",
            "ARTIFACTS",
            "REVIEWS",
            "MIGRATIONS",
            "JOBS",
            "SANDBOX",
        ]
        .map(String::from)
        .to_vec(),
    }
}

fn data() -> InitData {
    let check = |state, text: &str, hint: Option<&str>| Check {
        state,
        text: text.into(),
        hint: hint.map(String::from),
    };
    InitData {
        version: "0.2.0".into(),
        config_dir: "~/.config/rio".into(),
        preflight: vec![
            check(CheckState::Ok, "cf 1.4 installed", None),
            check(CheckState::Ok, "cf logged in · profile default", None),
            check(CheckState::Ok, "docker daemon running", None),
            check(CheckState::Ok, "OS keychain unlocked", None),
            check(CheckState::Missing, "CLOUDFLARE_API_TOKEN not set", None),
            check(
                CheckState::Missing,
                "OPENROUTER_API_KEY not set",
                Some("key will be asked, echo off"),
            ),
        ],
        existing: "no deployment yet".into(),
        pending: None,
        configure: ConfigureData {
            accounts: vec![
                pixel(),
                Account {
                    name: "Personal".into(),
                    id: "88b04e1f2a3b4c5d6e7f8091a2b319cd".into(),
                },
            ],
            account: 0,
            name: "rio".into(),
            runner: Runner::Sandbox,
            runner_image: "ghcr.io/pixelinfinito/rio-runner:0.2.0".into(),
            provider: Provider::OpenRouter,
            env_keys: vec![],
            credential_store: CredentialStore::Keychain,
            subdomain: Some("pixel-labs".into()),
            scopes: [
                "account read",
                "Workers Scripts · Durable Objects",
                "D1 · R2 · Queues · Workflows edit",
                "AI Gateway · Containers / registry",
                "account API tokens",
            ]
            .map(String::from)
            .to_vec(),
            plan: Some(plan()),
        },
        connect: ConnectData {
            url: String::new(),
            source: TokenSource::Stdin,
            env_token: false,
        },
        handoff: Handoff::default(),
    }
}

fn set(d: &mut DeployingData, id: &str, state: StepState, detail: &str, secs: Option<f64>) {
    let step = d.steps.iter_mut().find(|s| s.id == id).unwrap();
    step.state = state;
    step.detail = detail.into();
    step.elapsed = secs;
}

/// I3's sample: twelve steps finished, migrations running.
fn deploying() -> DeployingData {
    let mut d = DeployingData::new(&pixel(), "rio", Runner::Sandbox, Some("pixel-labs"));
    use StepState::*;
    for (id, state, detail, secs) in [
        ("authenticate", Done, "cf OAuth · profile default", 0.3),
        ("account", Done, "Pixel Infinito", 0.1),
        ("secrets", Done, "OpenRouter key · keychain", 0.2),
        ("runner-image", Done, "pulled rio-runner:0.2.0", 18.4),
        ("registry-copy", Done, "676 MB · sha256:9b2f…e1", 41.0),
        ("d1", Reused, "rio · reused", 0.6),
        ("r2", Done, "rio-artifacts · created", 0.4),
        ("queue", Done, "rio-jobs · created", 0.5),
        ("ai-gateway", Done, "rio · auth on · logs off", 0.7),
        ("gateway-token", Done, "AI Gateway Run · account", 0.9),
        ("worker-upload", Done, "bundle 7c21a9e4 · 6 bindings", 3.2),
        ("workflows", Done, "rio-review · rio-migrate", 1.1),
    ] {
        set(&mut d, id, state, detail, Some(secs));
    }
    set(
        &mut d,
        "migrations",
        Running,
        "D1 schema v1 · lock held",
        None,
    );
    let row = |state, kind: &str, name: &str, id: &str| ResourceRow {
        state,
        kind: kind.into(),
        name: name.into(),
        id: id.into(),
    };
    d.resources = vec![
        row(Reused, "D1", "rio", "9a1e4c7f20b3"),
        row(Done, "R2", "rio-artifacts", ""),
        row(Done, "Queue", "rio-jobs", "4b7d02e91c"),
        row(Done, "Gateway", "rio", ""),
        row(Done, "Worker", "rio", "v 0.2.0"),
        row(Done, "Workflows", "rio-review", ""),
        row(Done, "", "rio-migrate", ""),
        row(Done, "Registry", "rio-runner", "0.2.0"),
        row(Pending, "Sandbox", "standard-3", "pending"),
    ];
    d.migration = Some(Migration {
        version: "v1".into(),
        applied: 9,
        total: 14,
    });
    d.runner_image = Some(RunnerImage {
        source: "ghcr.io/pixelinfinito/rio-runner".into(),
        destination: "registry.cloudflare.com/3f9c…".into(),
        note: "676 MB · 1 retry · verified digest".into(),
    });
    d.secrets = [
        "api secret · generated",
        "runner secret · generated",
        "OPENROUTER_API_KEY",
        "AI_GATEWAY_TOKEN",
    ]
    .map(|name| SecretRow {
        name: name.into(),
        done: true,
    })
    .to_vec();
    d.secrets_note = "Worker secrets · keychain copy".into();
    d.log = vec![
        LogLine::info("Deploying rio to Cloudflare account 3f9c…a21e…"),
        LogLine::info("Pulling released runner image…"),
        LogLine::info("Copying runner image to your Cloudflare registry…"),
        LogLine::warn("Registry push interrupted; retrying (1/3)…"),
        LogLine::info("D1 rio reused · R2 rio-artifacts created"),
        LogLine::info("Uploading Worker bundle 7c21a9e4 · 6 bindings"),
        LogLine::info("Migration deploy-7c21a9e4f0b2 started"),
    ];
    d.elapsed = 108;
    d
}

/// I4's sample before the failure: fourteen steps finished, the rollout running.
fn before_failure() -> DeployingData {
    let mut d = deploying();
    set(
        &mut d,
        "migrations",
        StepState::Done,
        "D1 schema v1",
        Some(9.8),
    );
    set(
        &mut d,
        "queue-consumer",
        StepState::Done,
        "rio-jobs → rio",
        Some(0.4),
    );
    set(
        &mut d,
        "sandbox-rollout",
        StepState::Running,
        "standard-3 · rolling",
        None,
    );
    d.log = vec![
        LogLine::info("Migration deploy-7c21a9e4f0b2 applied (v1)"),
        LogLine::info("Queue consumer rio-jobs → rio attached"),
        LogLine::info("Rolling out Sandbox application rio…"),
        LogLine::error("error: Containers is not enabled for this account"),
    ];
    d.elapsed = 122;
    d
}

fn failure() -> serde_json::Value {
    json!({
        "step": "sandbox-rollout",
        "error": {
            "title": "Containers unavailable",
            "request": "POST …/containers/applications",
            "message": "The account has no Containers access. The Sandbox runner needs Workers Paid with Containers on."
        },
        "created": ["Worker", "D1", "R2", "Queue", "Gateway", "workflows", "schema v1", "secrets"],
        "fixes": [
            {"key": "o", "title": "enable Containers", "hint": "opens dash.cloudflare.com"},
            {"key": "s", "title": "use self-hosted runner", "hint": "--runner self-hosted"},
            {"title": "check token scopes", "hint": "cf auth scopes"}
        ],
        "dashboard": "https://dash.cloudflare.com/3f9c0b5e7d214c8a9e6f1b2d3c4aa21e/workers/containers"
    })
}

fn deployed_value() -> serde_json::Value {
    json!({
        "endpoint": URL,
        "artifacts": [
            {"label": "config", "path": "~/.config/rio/config.toml", "note": "choices only · no secrets"},
            {"label": "keychain", "path": "rio / 3f9c…a21e / rio", "note": "api · runner · provider · gateway"},
            {"label": "profile", "path": "~/.config/rio/profiles/default.yaml", "note": "rio-default · OpenRouter"}
        ],
        "resources": [
            {"kind": "Worker", "name": "rio"},
            {"kind": "D1", "name": "rio", "reused": true},
            {"kind": "R2", "name": "rio-artifacts"},
            {"kind": "Queue", "name": "rio-jobs"},
            {"kind": "AI Gateway", "name": "rio"},
            {"kind": "Workflows", "name": "review · migrate"},
            {"kind": "Sandbox", "name": "standard-3"},
            {"kind": "Schema", "name": "v1 applied"}
        ],
        "provider": "OpenRouter",
        "retries": 1
    })
}

/// I5's sample: all sixteen steps finished.
fn finished() -> DeployingData {
    let mut d = before_failure();
    set(
        &mut d,
        "sandbox-rollout",
        StepState::Done,
        "standard-3",
        Some(12.0),
    );
    set(
        &mut d,
        "workers-dev",
        StepState::Done,
        "rio.pixel-labs.workers.dev",
        Some(1.0),
    );
    d.elapsed = 151;
    d
}

fn value(name: &str, json: serde_json::Value) -> Msg {
    Msg::Done(Outcome::Value(name.into(), json))
}

fn type_text(app: &mut App, text: &str) -> Vec<Effect> {
    text.chars()
        .flat_map(|ch| app.update(press(KeyCode::Char(ch))))
        .collect()
}

fn draw(app: &App, cols: u16, rows: u16) -> ratatui::buffer::Buffer {
    let area = ratatui::layout::Rect::new(0, 0, cols, rows);
    let mut buf = ratatui::buffer::Buffer::empty(area);
    app.draw(&mut buf, area);
    buf
}

/// I2 with the sample key typed and focus back on the account list.
fn configured(theme: Theme) -> App {
    let mut app = App::new(Box::new(Configure::new(data())), theme);
    for _ in 0..4 {
        app.update(press(KeyCode::Tab));
    }
    type_text(&mut app, KEY);
    app.update(press(KeyCode::Tab));
    app.update(press(KeyCode::Tab));
    app
}

/// I6 with the sample URL and token typed and focus on the token source.
fn connecting(theme: Theme) -> App {
    let mut app = App::new(Box::new(ConnectExisting::new(data())), theme);
    type_text(&mut app, URL);
    app.update(press(KeyCode::Tab));
    app.update(press(KeyCode::Tab));
    type_text(&mut app, TOKEN);
    app.update(press(KeyCode::Tab));
    app.update(press(KeyCode::Tab));
    app
}

fn failed(theme: Theme) -> App {
    let mut app = App::new(Box::new(Deploying::new(before_failure())), theme);
    app.update(value("init:failed", failure()));
    app
}

fn deployed(theme: Theme) -> App {
    let mut app = App::new(Box::new(Deploying::new(finished())), theme);
    app.update(value("init:deployed", deployed_value()));
    app
}

/// Every screen of the flow, in its sample state.
fn screens(theme: Theme) -> Vec<(&'static str, App)> {
    vec![
        ("init-i1-choose-mode", App::new(choose_mode(data()), theme)),
        ("init-i2-configure", configured(theme)),
        (
            "init-i3-deploying",
            App::new(Box::new(Deploying::new(deploying())), theme),
        ),
        ("init-i4-failed-resumable", failed(theme)),
        ("init-i5-deployed", deployed(theme)),
        ("init-i6-connect-existing", connecting(theme)),
    ]
}

#[test]
fn i1_choose_mode_matches_its_design() {
    let buf = common::render(choose_mode(data()), Session::default(), 120, 40);
    common::assert_screen("init-i1-choose-mode", &buf);
}

#[test]
fn i2_configure_matches_its_design() {
    let app = configured(Theme::default());
    assert_eq!(app.top().title(), "Configure");
    common::assert_screen("init-i2-configure", &draw(&app, 120, 40));
}

#[test]
fn i3_deploying_matches_its_design() {
    let buf = common::render(
        Box::new(Deploying::new(deploying())),
        Session::default(),
        120,
        40,
    );
    common::assert_screen("init-i3-deploying", &buf);
}

#[test]
fn i4_failed_matches_its_design() {
    let app = failed(Theme::default());
    assert_eq!(app.top().title(), "Deployment stopped");
    common::assert_screen("init-i4-failed-resumable", &draw(&app, 120, 40));
}

#[test]
fn i5_deployed_matches_its_design() {
    let app = deployed(Theme::default());
    assert_eq!(app.top().title(), "Deployed");
    common::assert_screen("init-i5-deployed", &draw(&app, 120, 40));
}

#[test]
fn i6_connect_existing_matches_its_design() {
    let app = connecting(Theme::default());
    common::assert_screen("init-i6-connect-existing", &draw(&app, 120, 40));
}

#[test]
fn every_screen_fits_80_by_24() {
    for (slug, app) in screens(Theme::default()) {
        let buf = draw(&app, 80, 24);
        for line in common::lines(&buf).lines() {
            assert!(
                unicode_width::UnicodeWidthStr::width(line) <= 80,
                "{slug}: a row is wider than 80"
            );
        }
        let name = format!("{}_80x24", slug.trim_start_matches("init-"));
        insta::assert_snapshot!(name, common::lines(&buf));
    }
    // The form scrolls to keep the focused section in view.
    let mut app = configured(Theme::default());
    app.update(press(KeyCode::BackTab));
    let text = common::lines(&draw(&app, 80, 24));
    assert!(text.contains("CREDENTIALS") && text.contains("▌ (•) OS keychain"));
    insta::assert_snapshot!("i2-configure-credentials_80x24", text);
}

#[test]
fn without_color_every_state_still_reads() {
    let theme = Theme {
        color: false,
        ..Theme::default()
    };
    for (slug, app) in screens(theme) {
        let buf = draw(&app, 120, 40);
        for y in 0..40 {
            for x in 0..120 {
                let style = buf[(x, y)].style();
                assert!(
                    style.fg.is_none_or(|c| c == ratatui::style::Color::Reset)
                        && style.bg.is_none_or(|c| c == ratatui::style::Color::Reset),
                    "{slug}: color at {x},{y}"
                );
            }
        }
        let text = common::lines(&buf);
        match slug {
            // The focused mode carries the cursor glyph and reverse video.
            "init-i1-choose-mode" => {
                assert!(text.contains("▌ (•) Deploy to my Cloudflare account"));
                assert!(text.contains("  ( ) Connect an existing endpoint"));
                let cell = &buf[(10, 11)];
                assert!(
                    cell.style()
                        .add_modifier
                        .contains(ratatui::style::Modifier::REVERSED)
                );
            }
            // The chosen segment is bracketed when it can't be colored.
            "init-i2-configure" => {
                assert!(text.contains("[Cloudflare Sandbox]  Self-hosted Docker "));
                assert!(text.contains("[OpenRouter]  OpenAI "));
            }
            "init-i3-deploying" => {
                for glyph in [
                    "✓ authenticate",
                    "↺ D1 database",
                    "◐ migrations",
                    "○ queue consumer",
                ] {
                    assert!(text.contains(glyph), "{glyph}");
                }
                assert!(text.contains("▌ 13 ◐ migrations"));
            }
            "init-i4-failed-resumable" => {
                assert!(text.contains("▌ 15 ✕ sandbox rollout  Containers unavailable"));
                assert!(text.contains("16 – workers.dev      skipped"));
            }
            "init-i5-deployed" => assert!(text.contains("✓ D1         rio ↺")),
            "init-i6-connect-existing" => {
                assert!(text.contains("▌ (•) read from stdin"));
                assert!(text.contains("  ( ) RIO_API_TOKEN"));
            }
            _ => unreachable!(),
        }
    }
}

#[test]
fn ascii_glyphs_keep_every_row_the_terminal_width() {
    let theme = Theme {
        glyphs: rio_core::glyphs::GlyphSet::Ascii,
        ..Theme::default()
    };
    for (slug, app) in screens(theme) {
        for line in common::lines(&draw(&app, 120, 40)).lines() {
            assert!(line.is_ascii(), "{slug}: {line}");
            assert_eq!(line.len(), 120, "{slug}: {line}");
        }
    }
}

#[test]
fn i1_continues_to_configure_or_connect() {
    let mut app = App::new(choose_mode(data()), Theme::default());
    assert!(app.update(press(KeyCode::Enter)).is_empty());
    assert_eq!(app.top().title(), "Configure");
    // esc goes back to the modes.
    app.update(press(KeyCode::Esc));
    assert_eq!(app.top().title(), "Choose mode");

    app.update(press(KeyCode::Down));
    assert!(app.update(press(KeyCode::Enter)).is_empty());
    assert_eq!(app.top().title(), "Connect existing");
    app.update(press(KeyCode::Esc));
    assert_eq!(app.top().title(), "Choose mode");

    app.update(press(KeyCode::Down));
    assert_eq!(
        app.update(press(KeyCode::Enter)),
        vec![Effect::Step("init:local".into())]
    );

    // q is the app's: no report, so it quits.
    assert_eq!(app.update(press(KeyCode::Char('q'))), vec![Effect::Quit]);
}

#[test]
fn p_asks_for_the_plan_and_the_plan_value_is_shown() {
    let mut d = data();
    d.configure.plan = None;
    let handoff = d.handoff.clone();

    // From I1: the plan step, and the configure screen shows it.
    let mut app = App::new(choose_mode(d.clone()), Theme::default());
    assert_eq!(
        app.update(press(KeyCode::Char('p'))),
        vec![Effect::Step("init:plan".into())]
    );
    assert_eq!(app.top().title(), "Configure");
    assert_eq!(handoff.args()[..3], ["init", "--account", ACCOUNT_ID]);

    let mut app = App::new(Box::new(Configure::new(d)), Theme::default());
    let before = common::lines(&draw(&app, 120, 40));
    assert!(before.contains("p makes the plan · no login, no changes"));
    assert!(!before.contains("ReviewWorkflow"));
    assert_eq!(
        app.update(press(KeyCode::Char('p'))),
        vec![Effect::Step("init:plan".into())]
    );
    // The `rio deploy --dry-run` document as the CLI prints it.
    app.update(value(
        "init:plan",
        json!({
            "deployment": {"name": "rio"},
            "worker_version": "0.2.0",
            "bundle_hash": "7c21a9e4f0b2d6c8e1",
            "resources": ["Worker", "ReviewWorkflow", "MigrationWorkflow", "D1", "R2", "Queue", "AI Gateway"],
            "sandbox": true,
            "mutations": false
        }),
    ));
    let after = common::lines(&draw(&app, 120, 40));
    assert!(after.contains("bundle 7c21a9e4 · worker 0.2.0 · no changes yet"));
    assert!(after.contains("+ ReviewWorkflow"));
    assert!(after.contains("+ AI Gateway"));
}

#[test]
fn deploy_starts_rio_init_with_the_chosen_options() {
    let d = data();
    let handoff = d.handoff.clone();
    let mut app = App::new(Box::new(Configure::new(d)), Theme::default());
    // Another account.
    app.update(press(KeyCode::Down));
    // Name: rio-team (typing q and p goes into the field).
    app.update(press(KeyCode::Tab));
    assert!(type_text(&mut app, "-team").is_empty());
    // Self-hosted runner, Anthropic, a key, the file store.
    app.update(press(KeyCode::Tab));
    app.update(press(KeyCode::Right));
    app.update(press(KeyCode::Tab));
    app.update(press(KeyCode::Right));
    app.update(press(KeyCode::Right));
    app.update(press(KeyCode::Tab));
    assert!(type_text(&mut app, "sk-ant-qp").is_empty());
    app.update(press(KeyCode::Tab));
    app.update(press(KeyCode::Down));

    let effects = app.update(press(KeyCode::Enter));
    let args: Vec<String> = [
        "init",
        "--account",
        "88b04e1f2a3b4c5d6e7f8091a2b319cd",
        "--name",
        "rio-team",
        "--runner",
        "self-hosted",
        "--credential-store",
        "file",
    ]
    .map(String::from)
    .to_vec();
    assert_eq!(effects, vec![Effect::Start(args.clone())]);
    assert_eq!(handoff.args(), args);
    // The key is never an argument: it waits under its environment name.
    assert!(!format!("{handoff:?}").contains("sk-ant"));
    assert_eq!(
        handoff.take_secret(),
        Some(("ANTHROPIC_API_KEY".into(), "sk-ant-qp".into()))
    );
    assert_eq!(app.top().title(), "Deploying");
    let text = common::lines(&draw(&app, 120, 40));
    assert!(text.contains("Deploying rio-team to Personal"));
    // Self-hosted: the Sandbox steps are skipped from the start.
    assert!(text.contains(" 4 – runner image     self-hosted runner"));
}

#[test]
fn deploy_needs_a_key_and_a_valid_name() {
    let mut app = App::new(Box::new(Configure::new(data())), Theme::default());
    assert!(app.update(press(KeyCode::Enter)).is_empty());
    assert_eq!(app.top().title(), "Configure");
    assert!(common::lines(&draw(&app, 120, 40)).contains("✕ OpenRouter key needed"));

    // A key in the environment is enough.
    let mut d = data();
    d.configure.env_keys = vec!["OPENROUTER_API_KEY".into()];
    let mut app = App::new(Box::new(Configure::new(d)), Theme::default());
    assert!(common::lines(&draw(&app, 120, 40)).contains("key  from OPENROUTER_API_KEY"));
    assert!(matches!(
        app.update(press(KeyCode::Enter))[..],
        [Effect::Start(_)]
    ));
}

#[test]
fn step_values_update_the_deployment() {
    let mut app = App::new(Box::new(Deploying::new(deploying())), Theme::default());
    app.update(value(
        "init:step",
        json!({"step": "migrations", "state": "running", "migration": {"version": "v1", "applied": 14, "total": 14},
               "log": "Migration deploy-7c21a9e4f0b2 applied (v1)"}),
    ));
    app.update(value(
        "init:step",
        json!({"step": "migrations", "state": "done", "detail": "D1 schema v1", "elapsed": 9.8}),
    ));
    app.update(value(
        "init:step",
        json!({"step": "queue-consumer", "state": "running", "log": "Queue consumer rio-jobs → rio attached"}),
    ));
    let text = common::lines(&draw(&app, 120, 40));
    assert!(text.contains("13 ✓ migrations       D1 schema v1"));
    assert!(text.contains("9.8s"));
    // The cursor follows the running step.
    assert!(text.contains("▌ 14 ◐ queue consumer"));
    assert!(text.contains("│ Queue consumer rio-jobs → rio attached"));
    assert!(text.contains("◐ deploying · 13 of 16"));
    assert!(text.contains("14 of 14 statements"));

    // ⏎ opens the step's log, esc closes it and the screen stays.
    app.update(press(KeyCode::Up));
    app.update(press(KeyCode::Enter));
    let log = common::lines(&draw(&app, 120, 40));
    assert!(log.contains("LOG · 13 migrations"));
    assert!(log.contains("Migration deploy-7c21a9e4f0b2 applied (v1)"));
    assert!(!log.contains("Queue consumer rio-jobs"));
    app.update(press(KeyCode::Esc));
    assert_eq!(app.top().title(), "Deploying");
    // l opens the full log.
    app.update(press(KeyCode::Char('l')));
    assert!(common::lines(&draw(&app, 120, 40)).contains("LOG · deployment"));
    app.update(press(KeyCode::Esc));
    assert_eq!(app.top().title(), "Deploying");

    // esc does not leave a running deployment.
    app.update(press(KeyCode::Esc));
    assert_eq!(app.top().title(), "Deploying");
    // Ctrl-C is the app's: stop safely.
    assert_eq!(app.update(rio_tui::app::ctrl('c')), vec![Effect::Cancel]);
}

#[test]
fn retry_resumes_at_the_failed_step() {
    let mut app = failed(Theme::default());
    assert_eq!(app.top().title(), "Deployment stopped");
    let text = common::lines(&draw(&app, 120, 40));
    assert!(text.contains("✕ stopped at step 15 of 16"));
    assert!(text.contains(" r retry step 15"));

    assert_eq!(
        app.update(press(KeyCode::Char('o'))),
        vec![Effect::Open(
            "https://dash.cloudflare.com/3f9c0b5e7d214c8a9e6f1b2d3c4aa21e/workers/containers"
                .into()
        )]
    );
    assert_eq!(
        app.update(press(KeyCode::Char('r'))),
        vec![Effect::Step("init:retry".into())]
    );
    assert_eq!(app.top().title(), "Deploying");
    let text = common::lines(&draw(&app, 120, 40));
    // Completed steps stay done; the failed step runs again, under the cursor.
    assert!(text.contains(" 1 ✓ authenticate"));
    assert!(text.contains(" 6 ↺ D1 database"));
    assert!(text.contains("14 ✓ queue consumer"));
    assert!(text.contains("▌ 15 ◐ sandbox rollout  retrying"));
    assert!(text.contains("16 ○ workers.dev"));
    assert!(text.contains("◐ deploying · 14 of 16"));

    // Failing again opens I4 again; s switches to the self-hosted runner.
    app.update(value("init:failed", failure()));
    assert_eq!(
        app.update(press(KeyCode::Char('s'))),
        vec![Effect::Step("init:self-hosted".into())]
    );
    let text = common::lines(&draw(&app, 120, 40));
    assert!(text.contains("15 – sandbox rollout  self-hosted runner"));
    assert!(text.contains("▌ 16 ◐ workers.dev"));
}

#[test]
fn quitting_a_failed_deployment_needs_no_save_dialog() {
    let mut app = failed(Theme::default());
    // Even with an unsaved report in the session, q means "resume later".
    app.session.report = Some(
        serde_json::from_str(include_str!("../../rio-core/tests/fixtures/complete.json")).unwrap(),
    );
    assert_eq!(app.update(press(KeyCode::Char('q'))), vec![Effect::Quit]);
    assert!(app.done);
    assert_eq!(app.top().title(), "Deployment stopped");
}

#[test]
fn deployed_offers_the_first_review_and_copies() {
    let mut app = deployed(Theme::default());
    assert_eq!(
        app.update(press(KeyCode::Enter)),
        vec![Effect::Step("init:first-review".into())]
    );
    assert_eq!(
        app.update(press(KeyCode::Char('t'))),
        vec![Effect::Copy(format!(
            "rio init --endpoint {URL} --token-stdin"
        ))]
    );
    assert_eq!(
        app.update(press(KeyCode::Char('c'))),
        vec![Effect::Copy(URL.into())]
    );
    assert_eq!(
        app.update(press(KeyCode::Char('e'))),
        vec![Effect::Copy(
            "rio init --from ~/.config/rio/config.toml".into()
        )]
    );
    app.update(press(KeyCode::Char('l')));
    let log = common::lines(&draw(&app, 120, 40));
    assert!(log.contains("LOG · deployment"));
    assert!(log.contains("error: Containers is not enabled"));
}

#[test]
fn connect_types_a_url_with_q_and_connects() {
    let d = data();
    let handoff = d.handoff.clone();
    let mut app = App::new(Box::new(ConnectExisting::new(d)), Theme::default());
    let url = "https://rio-qa.quill.workers.dev";
    assert!(type_text(&mut app, url).is_empty());
    assert!(!app.done);
    // No token yet: ⏎ asks for it.
    assert!(app.update(press(KeyCode::Enter)).is_empty());
    assert!(common::lines(&draw(&app, 120, 40)).contains("✕ paste the API token first"));
    assert!(type_text(&mut app, "tok-q").is_empty());
    assert_eq!(
        app.update(press(KeyCode::Enter)),
        vec![Effect::Start(
            ["init", "--endpoint", url, "--token-stdin"]
                .map(String::from)
                .to_vec()
        )]
    );
    assert_eq!(
        handoff.take_secret(),
        Some(("stdin".into(), "tok-q".into()))
    );

    // The environment source stores no token.
    app.update(press(KeyCode::Down));
    assert_eq!(
        app.update(press(KeyCode::Enter)),
        vec![Effect::Start(
            ["init", "--endpoint", url].map(String::from).to_vec()
        )]
    );
    assert_eq!(handoff.take_secret(), None);

    // Plain http is refused except on loopback.
    let mut app = App::new(Box::new(ConnectExisting::new(data())), Theme::default());
    type_text(&mut app, "http://rio.example.com");
    app.update(press(KeyCode::Down));
    assert!(app.update(press(KeyCode::Enter)).is_empty());
}

#[test]
fn secrets_are_never_drawn() {
    let app = configured(Theme::default());
    let text = common::lines(&draw(&app, 120, 40));
    assert!(text.contains(&"•".repeat(30)));
    let app = connecting(Theme::default());
    let text6 = common::lines(&draw(&app, 120, 40));
    assert!(text6.contains(&"•".repeat(31)));
    for (secret, text) in [(KEY, &text), (TOKEN, &text6)] {
        let chars: Vec<char> = secret.chars().collect();
        for piece in chars.windows(4) {
            let piece: String = piece.iter().collect();
            assert!(!text.contains(&piece), "{piece} drawn");
        }
    }
    // While typing, at 80 columns and in the field's focus too.
    let mut app = App::new(Box::new(Configure::new(data())), Theme::default());
    for _ in 0..4 {
        app.update(press(KeyCode::Tab));
    }
    type_text(&mut app, "zq9-hidden");
    for (cols, rows) in [(120, 40), (80, 24)] {
        let text = common::lines(&draw(&app, cols, rows));
        assert!(!text.contains("hidden") && !text.contains("zq9"));
    }
}

#[test]
fn screens_open_directly_for_the_host() {
    // The public entry points and data the host fills.
    let screen: Box<dyn Screen> = Box::new(ChooseMode::new(data()));
    assert_eq!(screen.title(), "Choose mode");
    let done: DeployedData = serde_json::from_value(deployed_value()).unwrap();
    assert_eq!(
        done.artifacts[0],
        Artifact {
            label: "config".into(),
            path: "~/.config/rio/config.toml".into(),
            note: "choices only · no secrets".into()
        }
    );
    assert_eq!(
        done.resources[1],
        DeployedResource {
            kind: "D1".into(),
            name: "rio".into(),
            reused: true
        }
    );
    // A pending deployment is offered on I1.
    let mut d = data();
    d.pending = Some("sandbox rollout".into());
    let buf = common::render(choose_mode(d), Session::default(), 120, 40);
    let text = common::lines(&buf);
    assert!(text.contains("◐ stopped at sandbox rollout"));
    assert!(text.contains("rio deploy resumes it"));
}

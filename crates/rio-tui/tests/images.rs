#![cfg(feature = "qa")]
//! QA screenshots in the cell detail, drawn from a real masked screenshot of
//! the QA sample (`docs/evaluation/qa-evidence/missing-cancel.png`).

mod common;

use std::path::Path;

use ratatui::{buffer::Buffer, crossterm::event::KeyCode, layout::Rect, style::Color};
use rio_core::{Report, ReportStatus};
use rio_tui::{
    App, Effect, Msg, Outcome, Theme,
    app::press,
    images::Images,
    qa::{CellDetail, CellId, CellOutcome},
};
use serde_json::json;

const SHOT: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../docs/evaluation/qa-evidence/missing-cancel.png"
);

fn cell() -> CellId {
    CellId {
        viewport: "mobile".into(),
        color_scheme: "light".into(),
    }
}

/// A finished run of `checkout` that failed at step 4 in mobile/light.
fn report(evidence: serde_json::Value, ids: &[&str]) -> Report {
    let mut report = Report::empty(ReportStatus::Complete);
    report.review.id = Some("1234567890ab".into());
    report.review.run_id = Some("01M70AGJ".into());
    report.qa = Some(json!({
        "journeys": [{"name": "checkout", "outcome": "failed", "cells": [
            {"viewport": "mobile", "color_scheme": "light", "outcome": "failed", "step_reached": 4, "evidence": ids}
        ]}],
        "evidence": evidence,
    }));
    report
}

/// Q3 on the failed cell, its focused step the failed one.
fn app(report: Report, images: Images) -> App {
    let titles: Vec<String> = ["open cart", "checkout", "pay", "declined"]
        .map(String::from)
        .into();
    let detail = CellDetail::basic("checkout", cell(), &titles, CellOutcome::Failed, 4);
    let mut app = App::new(
        rio_tui::qa::cell_detail(vec![detail], 0, None),
        Theme::default(),
    );
    app.session.report = Some(report);
    app.session.images = images;
    app
}

fn draw(app: &App) -> Buffer {
    let area = Rect::new(0, 0, 120, 40);
    let mut buf = Buffer::empty(area);
    app.draw(&mut buf, area);
    buf
}

/// The screenshot pane's colors: those of the page drawn in it.
fn pane_colors(buf: &Buffer) -> Vec<(u8, u8, u8)> {
    let mut colors = Vec::new();
    for y in 4..37 {
        for x in 33..68 {
            for color in [buf[(x, y)].fg, buf[(x, y)].bg] {
                if let Color::Rgb(r, g, b) = color {
                    colors.push((r, g, b));
                }
            }
        }
    }
    colors
}

/// A local run: the evidence manifest under the run cache, as the runtime exports it.
fn local_run() -> (tempfile::TempDir, Report) {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("1234567890ab/runs/01M70AGJ/qa");
    std::fs::create_dir_all(dir.join("checkout")).unwrap();
    let file = dir.join("checkout/mobile-light-4.png");
    std::fs::copy(SHOT, &file).unwrap();
    let manifest = json!({"artifacts": [
        {"id": "s4", "kind": "screenshot", "journey": "checkout", "step": 4,
         "cell": {"viewport": "mobile", "color_scheme": "light"}, "link": file}
    ]});
    std::fs::write(dir.join("manifest.json"), manifest.to_string()).unwrap();
    (
        root,
        report(json!({"storage": "local", "artifacts": []}), &["s4"]),
    )
}

#[test]
fn a_local_screenshot_is_drawn_in_the_pane() {
    let (root, report) = local_run();
    let mut images = Images::halfblocks();
    images.set_local_root(root.path().into());
    let mut app = app(report, images);
    // Q3 opens on the failed step: step 4.
    let buf = draw(&app);
    let text = common::lines(&buf);
    assert!(
        text.contains("SCREENSHOT step 4 · light · masked"),
        "{text}"
    );
    let colors = pane_colors(&buf);
    // The page's near-white background and the blue Pay button.
    let near = |c: &(u8, u8, u8), t: (u8, u8, u8)| {
        (c.0 as i32 - t.0 as i32).abs()
            + (c.1 as i32 - t.1 as i32).abs()
            + (c.2 as i32 - t.2 as i32).abs()
            < 60
    };
    assert!(
        colors.iter().filter(|c| near(c, (248, 249, 251))).count() > 200,
        "no page background"
    );
    assert!(
        colors.iter().any(|c| near(c, (27, 77, 155))),
        "no Pay button blue"
    );
    // Nothing is drawn outside the pane.
    for y in 4..37 {
        assert!(!matches!(buf[(29, y)].bg, Color::Rgb(248, 249, 251)));
        assert!(!matches!(buf[(71, y)].bg, Color::Rgb(248, 249, 251)));
    }
    // `o` opens that very file.
    let effects = app.update(press(KeyCode::Char('o')));
    assert!(matches!(&effects[..], [Effect::Open(path)] if path.ends_with("mobile-light-4.png")));
}

#[test]
fn without_images_the_pane_names_the_file() {
    let (root, report) = local_run();
    let mut images = Images::disabled();
    images.set_local_root(root.path().into());
    let app = app(report, images);
    let buf = draw(&app);
    let text = common::lines(&buf);
    assert!(
        text.contains("mobile-light-4.png") || text.contains("mobile-light-4.p"),
        "{text}"
    );
    assert!(text.contains("o opens it"), "{text}");
    assert!(
        pane_colors(&buf)
            .iter()
            .all(|c| !matches!(c, (248, 249, 251)))
    );
}

#[test]
fn an_endpoint_screenshot_is_downloaded_once_then_drawn_or_reported() {
    let url = "https://evidence.example/run/checkout/mobile-light/4.png?sig=abc";
    let evidence = json!({"storage": "r2", "artifacts": [
        {"id": "qa/checkout/mobile-light/4.png", "kind": "screenshot", "link": url}
    ]});
    let mut app = app(
        report(evidence.clone(), &["qa/checkout/mobile-light/4.png"]),
        Images::halfblocks(),
    );
    assert!(common::lines(&draw(&app)).contains("downloading the screenshot"));
    assert_eq!(
        app.update(Msg::Tick),
        vec![Effect::Fetch(format!("qa-image:{url}"))]
    );
    assert!(app.update(Msg::Tick).is_empty(), "requested once");
    app.update(Msg::Done(Outcome::Value(
        "qa-image".into(),
        json!({"url": url, "path": SHOT}),
    )));
    assert!(
        pane_colors(&draw(&app)).len() > 400,
        "the downloaded screenshot is drawn"
    );

    let mut expired = app_with(evidence, url);
    expired.update(Msg::Tick);
    expired.update(Msg::Done(Outcome::Value(
        "qa-image".into(),
        json!({"url": url, "error": "the evidence link expired on 17 Nov"}),
    )));
    let text = common::lines(&draw(&expired));
    assert!(text.contains("✕ the evidence link expired on 17"), "{text}");
    assert!(text.contains("Nov"), "{text}");
}

fn app_with(evidence: serde_json::Value, _url: &str) -> App {
    app(
        report(evidence, &["qa/checkout/mobile-light/4.png"]),
        Images::halfblocks(),
    )
}

#[test]
fn a_step_without_a_screenshot_says_so() {
    let (root, report) = local_run();
    let mut images = Images::halfblocks();
    images.set_local_root(root.path().into());
    let mut app = app(report, images);
    // Step 1 kept no screenshot in this manifest.
    for _ in 0..3 {
        app.update(press(KeyCode::Left));
    }
    let text = common::lines(&draw(&app));
    assert!(text.contains("no screenshot for this step"), "{text}");
    assert!(Path::new(SHOT).is_file());
}

#[test]
fn no_color_and_ascii_never_query_the_terminal_for_images() {
    let plain = Theme {
        color: false,
        ..Theme::default()
    };
    assert!(!Images::detect(&plain).enabled());
    let ascii = Theme {
        glyphs: rio_core::glyphs::GlyphSet::Ascii,
        ..Theme::default()
    };
    assert!(!Images::detect(&ascii).enabled());
    assert!(Images::halfblocks().enabled());
}

#[test]
fn endpoint_screenshots_are_found_by_step_metadata_or_real_names() {
    // The Worker's links carry journey, step and cell.
    let tagged = "https://evidence.example/o/1f2e?sig=a";
    let evidence = json!({"storage": "hosted", "artifacts": [
        {"id": "1f2e", "kind": "screenshot", "journey": "checkout", "step": 3,
         "cell": {"viewport": "mobile", "color_scheme": "light"}, "link": "https://evidence.example/o/0000?sig=a"},
        {"id": "9a9a", "kind": "screenshot", "journey": "checkout", "step": 4,
         "cell": {"viewport": "mobile", "color_scheme": "light"}, "link": tagged}
    ]});
    let mut hosted = app(report(evidence, &[]), Images::halfblocks());
    assert_eq!(
        hosted.update(Msg::Tick),
        vec![Effect::Fetch(format!("qa-image:{tagged}"))]
    );

    // Older reports: the cell's evidence, named as the runtime names it.
    let named =
        "https://evidence.example/r/checkout/mobile-light/step-0004-screenshot-b0e787db.png?sig=b";
    let evidence = json!({"storage": "hosted", "artifacts": [
        {"id": "a1", "kind": "screenshot", "link": "https://evidence.example/r/checkout/mobile-light/step-0003-screenshot-90dc.png?sig=b"},
        {"id": "a2", "kind": "screenshot", "link": named}
    ]});
    let mut older = app(report(evidence, &["a1", "a2"]), Images::halfblocks());
    assert_eq!(
        older.update(Msg::Tick),
        vec![Effect::Fetch(format!("qa-image:{named}"))]
    );
}

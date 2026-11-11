//! Open the QA cell detail (Q3) on a finished run's report, with screenshots
//! from its run cache: `cargo run --example qa_cell -- REPORT CACHE JOURNEY
//! VIEWPORT COLOR_SCHEME`. `q` quits. For checking how screenshots draw in a
//! terminal without running QA.

use std::sync::mpsc::{Sender, channel};

use rio_core::Report;
use rio_tui::{
    App, Effect, Msg, Theme,
    images::Images,
    qa::{CellDetail, CellId},
    terminal::{Guard, Host, run},
};

struct Viewer;

impl Host for Viewer {
    fn run(&mut self, _effect: Effect, _reply: &Sender<Msg>) {}
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [report, cache, journey, viewport, color_scheme] = args.as_slice() else {
        return Err("usage: qa_cell REPORT CACHE JOURNEY VIEWPORT COLOR_SCHEME".into());
    };
    let report: Report = serde_json::from_slice(&std::fs::read(report)?)?;
    let cell = CellId {
        viewport: viewport.clone(),
        color_scheme: color_scheme.clone(),
    };
    let detail =
        CellDetail::from_report(&report, journey, &cell).ok_or("no such cell in the report")?;
    let theme = Theme::select(false, false);
    let mut app = App::new(rio_tui::qa::cell_detail(vec![detail], 0, None), theme);
    app.session.report = Some(report);
    let mut guard = Guard::enter()?;
    app.session.images = Images::detect(&theme);
    app.session
        .images
        .set_local_root(std::fs::canonicalize(cache)?);
    let (reply, messages) = channel();
    run(&mut guard, &mut app, &messages, &reply, &mut Viewer)?;
    Ok(())
}

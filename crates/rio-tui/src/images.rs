//! QA screenshots drawn in the terminal (terminal-ui "QA screenshots in the
//! cell detail").
//!
//! The host picks how images are drawn once per session: an image protocol
//! the terminal answers to (kitty, iTerm2, sixel), half-block characters
//! otherwise, or nothing at all with `NO_COLOR` or the ASCII glyph set. A
//! screenshot is found in the run's evidence manifest for local runs, or is a
//! signed URL the host downloads when its cell is opened.

use std::{
    cell::RefCell,
    collections::HashMap,
    path::{Path, PathBuf},
};

use image::DynamicImage;
use ratatui::layout::{Rect, Size};
use ratatui_image::{Image, Resize, picker::Picker, protocol::Protocol};
use rio_core::Report;
use serde_json::Value;

use crate::canvas::Canvas;

/// Where a step's screenshot is, as far as the session knows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Shot {
    /// The run kept no screenshot for this step.
    Missing,
    /// A signed URL not downloaded yet.
    Remote(String),
    /// Downloading.
    Loading,
    /// A local file.
    Local(String),
    /// It could not be found, read or downloaded.
    Failed(String),
}

/// One screenshot to find: a journey, a cell, a step, head or base.
#[derive(Debug, Clone, Copy)]
pub struct Query<'a> {
    pub journey: &'a str,
    pub viewport: &'a str,
    pub color_scheme: &'a str,
    pub step: u32,
    pub base: bool,
}

/// How this session draws screenshots, and what it has loaded.
#[derive(Default)]
pub struct Images {
    picker: Option<Picker>,
    /// The run cache root for local runs (`.rio/cache`).
    local_root: Option<PathBuf>,
    manifests: RefCell<HashMap<PathBuf, Option<Vec<Value>>>>,
    /// Downloads by URL: `None` while pending, then the file or the error.
    downloads: RefCell<HashMap<String, Option<Result<String, String>>>>,
    decoded: RefCell<HashMap<String, Result<DynamicImage, String>>>,
    protocols: RefCell<HashMap<(String, u16, u16), Protocol>>,
}

impl Images {
    /// No images: the pane names the screenshot's file instead.
    pub fn disabled() -> Self {
        Self::default()
    }

    /// Images drawn with `picker`.
    pub fn with(picker: Picker) -> Self {
        Self {
            picker: Some(picker),
            ..Self::default()
        }
    }

    /// Half-block characters, which every color terminal draws.
    pub fn halfblocks() -> Self {
        Self::with(Picker::halfblocks())
    }

    /// Ask the terminal which image protocol it speaks (call once, in the
    /// alternate screen, before reading keys). No color or ASCII glyphs mean
    /// no images; a terminal that does not answer gets half-blocks.
    pub fn detect(theme: &crate::Theme) -> Self {
        if !theme.color || theme.glyphs == rio_core::glyphs::GlyphSet::Ascii {
            return Self::disabled();
        }
        Self::with(Picker::from_query_stdio().unwrap_or_else(|_| Picker::halfblocks()))
    }

    /// Images are drawn (not only named).
    pub fn enabled(&self) -> bool {
        self.picker.is_some()
    }

    /// The local run cache, where local runs keep their evidence.
    pub fn set_local_root(&mut self, root: PathBuf) {
        self.local_root = Some(root);
    }

    /// The screenshot of `query` in `report`'s run.
    pub fn locate(&self, report: &Report, query: Query<'_>) -> Shot {
        if let Some(found) = self.local(report, query) {
            return found;
        }
        match remote(report, query) {
            Some(url) => match self.downloads.borrow().get(&url) {
                None => Shot::Remote(url),
                Some(None) => Shot::Loading,
                Some(Some(Ok(path))) => Shot::Local(path.clone()),
                Some(Some(Err(error))) => Shot::Failed(error.clone()),
            },
            None => Shot::Missing,
        }
    }

    /// The local evidence manifest's screenshot, when this run kept one.
    fn local(&self, report: &Report, query: Query<'_>) -> Option<Shot> {
        let root = self.local_root.as_ref()?;
        let review = report.review.id.as_deref()?;
        let run = report.review.run_id.as_deref()?;
        let safe = |s: &str| {
            !s.is_empty()
                && s != "."
                && s != ".."
                && s.chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
        };
        if !safe(review) || !safe(run) {
            return None;
        }
        let mut dir = root.join(review).join("runs").join(run).join("qa");
        if query.base {
            dir = dir.join("baseline");
        }
        let manifest = dir.join("manifest.json");
        let mut manifests = self.manifests.borrow_mut();
        let artifacts = manifests
            .entry(manifest.clone())
            .or_insert_with(|| {
                let value: Value = serde_json::from_slice(&std::fs::read(&manifest).ok()?).ok()?;
                value["artifacts"].as_array().cloned()
            })
            .as_ref()?;
        let found = artifacts.iter().find(|a| {
            a["kind"] == "screenshot"
                && a["journey"] == query.journey
                && a["step"].as_u64() == Some(u64::from(query.step))
                && a["cell"]["viewport"] == query.viewport
                && a["cell"]["color_scheme"] == query.color_scheme
        });
        Some(match found.and_then(|a| a["link"].as_str()) {
            // Only files inside the run's evidence directory are read.
            Some(link) if Path::new(link).starts_with(&dir) => Shot::Local(link.to_owned()),
            Some(_) => Shot::Failed("the screenshot is outside the run's evidence".into()),
            None => Shot::Missing,
        })
    }

    /// Mark a URL as being downloaded; `false` when it already was.
    pub fn request(&self, url: &str) -> bool {
        let mut downloads = self.downloads.borrow_mut();
        if downloads.contains_key(url) {
            return false;
        }
        downloads.insert(url.to_owned(), None);
        true
    }

    /// The host's answer to a download: the local file, or why it failed.
    pub fn downloaded(&self, url: &str, result: Result<String, String>) {
        self.downloads
            .borrow_mut()
            .insert(url.to_owned(), Some(result));
    }

    /// Draw the PNG at `path` fitted into `area` (canvas cells).
    pub fn draw(&self, c: &mut Canvas<'_>, area: Rect, path: &str) -> Result<(), String> {
        let picker = self.picker.as_ref().ok_or("images are off")?;
        if area.width == 0 || area.height == 0 {
            return Ok(());
        }
        let key = (path.to_owned(), area.width, area.height);
        let mut protocols = self.protocols.borrow_mut();
        if !protocols.contains_key(&key) {
            let mut decoded = self.decoded.borrow_mut();
            let image = decoded
                .entry(path.to_owned())
                .or_insert_with(|| {
                    image::ImageReader::open(path)
                        .map_err(|e| e.to_string())?
                        .with_guessed_format()
                        .map_err(|e| e.to_string())?
                        .decode()
                        .map_err(|e| format!("not a readable PNG: {e}"))
                })
                .clone()?;
            let protocol = picker
                .new_protocol(image, Size::new(area.width, area.height), Resize::Fit(None))
                .map_err(|e| e.to_string())?;
            protocols.insert(key.clone(), protocol);
        }
        let protocol = &protocols[&key];
        let absolute = Rect::new(
            c.area.x + area.x,
            c.area.y + area.y,
            area.width,
            area.height,
        );
        ratatui::widgets::Widget::render(Image::new(protocol), absolute, c.buf);
        Ok(())
    }
}

/// A signed URL of the step's screenshot in an endpoint run: the screenshot
/// artifact recorded for this journey, step and cell, or, for reports without
/// that metadata, the cell's screenshot whose name carries the step.
fn remote(report: &Report, query: Query<'_>) -> Option<String> {
    // Endpoint reports do not tell base screenshots apart yet.
    if query.base {
        return None;
    }
    let qa = report.qa.as_ref()?;
    let artifacts = qa["evidence"]["artifacts"].as_array()?;
    let screenshots = artifacts.iter().filter(|a| a["kind"] == "screenshot");
    let tagged = screenshots.clone().find(|a| {
        a["journey"] == query.journey
            && a["step"].as_u64() == Some(u64::from(query.step))
            && a["cell"]["viewport"] == query.viewport
            && a["cell"]["color_scheme"] == query.color_scheme
    });
    let found = tagged.or_else(|| {
        let cell = qa["journeys"]
            .as_array()?
            .iter()
            .find(|j| j["name"] == query.journey)?["cells"]
            .as_array()?
            .iter()
            .find(|c| c["viewport"] == query.viewport && c["color_scheme"] == query.color_scheme)?;
        let ids: Vec<&str> = cell["evidence"]
            .as_array()?
            .iter()
            .filter_map(Value::as_str)
            .collect();
        let names = [
            format!("step-{:04}-screenshot", query.step),
            format!("/{}.png", query.step),
        ];
        screenshots
            .filter(|a| a["id"].as_str().is_some_and(|id| ids.contains(&id)))
            .find(|a| {
                [
                    a["id"].as_str(),
                    a["link"]
                        .as_str()
                        .map(|l| l.split('?').next().unwrap_or("")),
                ]
                .into_iter()
                .flatten()
                .any(|name| {
                    names.iter().any(|n| {
                        name.contains(n.as_str())
                            && (n.starts_with("step-") || name.ends_with(n.as_str()))
                    })
                })
            })
    })?;
    found["link"]
        .as_str()
        .filter(|link| link.starts_with("https://"))
        .map(str::to_owned)
}

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
    /// alternate screen and raw mode, before reading keys). No color or ASCII
    /// glyphs mean no images; a terminal that does not answer, or a
    /// multiplexer between rio and the terminal, gets half-blocks.
    pub fn detect(theme: &crate::Theme) -> Self {
        if !theme.color || theme.glyphs == rio_core::glyphs::GlyphSet::Ascii {
            return Self::disabled();
        }
        // Inside tmux or screen, queries reach the outer terminal only through
        // passthrough, which is often off; what answers is the multiplexer.
        let multiplexed = std::env::var_os("TMUX").is_some()
            || std::env::var("TERM")
                .is_ok_and(|t| t.starts_with("screen") || t.starts_with("tmux"));
        if multiplexed {
            return Self::halfblocks();
        }
        let iterm2 = std::env::var("TERM_PROGRAM")
            .is_ok_and(|p| p == "iTerm.app" || p == "WezTerm")
            || std::env::var("LC_TERMINAL").is_ok_and(|t| t == "iTerm2");
        let replies = query_terminal(std::time::Duration::from_millis(300));
        match replies.and_then(|r| Some((r.protocol(iterm2)?, r.cell?))) {
            Some((protocol, (width, height))) => {
                // The cell size was asked here, not by ratatui-image's own
                // query (whose reader thread outlives an unanswered query).
                #[allow(deprecated)]
                let mut picker = Picker::from_fontsize(ratatui_image::FontSize::new(width, height));
                picker.set_protocol_type(protocol);
                Self::with(picker)
            }
            None => Self::halfblocks(),
        }
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
/// artifact recorded for this journey, step, cell and run (base or head), or,
/// for head screenshots of reports without that metadata, the cell's
/// screenshot whose name carries the step.
fn remote(report: &Report, query: Query<'_>) -> Option<String> {
    let qa = report.qa.as_ref()?;
    let artifacts = qa["evidence"]["artifacts"].as_array()?;
    // Artifacts of the base run say so; any other is the head run's.
    let screenshots = artifacts
        .iter()
        .filter(|a| a["kind"] == "screenshot" && (a["version"] == "base") == query.base);
    let tagged = screenshots.clone().find(|a| {
        a["journey"] == query.journey
            && a["step"].as_u64() == Some(u64::from(query.step))
            && a["cell"]["viewport"] == query.viewport
            && a["cell"]["color_scheme"] == query.color_scheme
    });
    let found = tagged.or_else(|| {
        if query.base {
            return None;
        }
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

/// What a terminal answered to rio's queries: kitty graphics, the device
/// attributes (sixel is attribute 4) and the cell size in pixels.
#[derive(Debug, Default, PartialEq, Eq)]
struct Replies {
    kitty: bool,
    sixel: bool,
    cell: Option<(u16, u16)>,
    /// The device attributes reply, sent last, arrived.
    done: bool,
}

impl Replies {
    /// Parse what the terminal sent back (`ESC _ G i=31;OK ESC \`,
    /// `CSI 6 ; h ; w t`, `CSI ? … c`).
    #[cfg_attr(not(unix), allow(dead_code))]
    fn parse(bytes: &[u8]) -> Self {
        let text = String::from_utf8_lossy(bytes);
        let mut replies = Self {
            kitty: text.contains("\x1b_Gi=31;OK"),
            ..Self::default()
        };
        for part in text.split("\x1b[").skip(1) {
            if let Some(attributes) = part.strip_prefix('?').and_then(|p| p.split_once('c')) {
                replies.done = true;
                replies.sixel = attributes.0.split(';').any(|a| a == "4");
            } else if let Some(size) = part.strip_prefix("6;").and_then(|p| p.split_once('t')) {
                let mut numbers = size.0.split(';').map(str::parse::<u16>);
                if let (Some(Ok(height)), Some(Ok(width))) = (numbers.next(), numbers.next())
                    && width > 0
                    && height > 0
                {
                    replies.cell = Some((width, height));
                }
            }
        }
        replies
    }

    /// The protocol to draw with, or `None` for half-blocks.
    fn protocol(&self, iterm2: bool) -> Option<ratatui_image::picker::ProtocolType> {
        use ratatui_image::picker::ProtocolType;
        if self.kitty {
            Some(ProtocolType::Kitty)
        } else if iterm2 {
            Some(ProtocolType::Iterm2)
        } else if self.sixel {
            Some(ProtocolType::Sixel)
        } else {
            None
        }
    }
}

/// Ask the terminal for kitty graphics support, its cell size and its device
/// attributes, and read the replies for at most `wait`. Device attributes go
/// last and every terminal answers them, so their reply ends the wait. Needs
/// raw mode; replies are read here and never reach the UI as keys.
#[cfg(unix)]
fn query_terminal(wait: std::time::Duration) -> Option<Replies> {
    use std::io::Write;
    let mut out = std::io::stdout();
    out.write_all(b"\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\\x1b[16t\x1b[c")
        .and_then(|()| out.flush())
        .ok()?;
    let deadline = std::time::Instant::now() + wait;
    let mut seen = Vec::new();
    loop {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        let mut fd = libc::pollfd {
            fd: libc::STDIN_FILENO,
            events: libc::POLLIN,
            revents: 0,
        };
        let millis = i32::try_from(left.as_millis()).unwrap_or(i32::MAX);
        // SAFETY: one valid pollfd for the length given.
        if left.is_zero() || unsafe { libc::poll(&mut fd, 1, millis) } <= 0 {
            return None;
        }
        let mut buf = [0u8; 256];
        // SAFETY: reads at most buf.len() bytes into buf.
        let read = unsafe { libc::read(libc::STDIN_FILENO, buf.as_mut_ptr().cast(), buf.len()) };
        match usize::try_from(read) {
            Ok(0) | Err(_) => return None,
            Ok(read) => seen.extend_from_slice(&buf[..read]),
        }
        let replies = Replies::parse(&seen);
        if replies.done {
            return Some(replies);
        }
    }
}

/// Without a way to wait on the console, no terminal is asked.
#[cfg(not(unix))]
fn query_terminal(_wait: std::time::Duration) -> Option<Replies> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui_image::picker::ProtocolType;

    #[test]
    fn replies_name_the_protocol_and_the_cell_size() {
        let kitty = Replies::parse(b"\x1b_Gi=31;OK\x1b\\\x1b[6;20;10t\x1b[?62;22c");
        assert_eq!(
            (kitty.protocol(false), kitty.cell, kitty.done),
            (Some(ProtocolType::Kitty), Some((10, 20)), true)
        );
        let sixel = Replies::parse(b"\x1b[6;16;8t\x1b[?62;4;22c");
        assert_eq!(sixel.protocol(false), Some(ProtocolType::Sixel));
        assert_eq!(sixel.protocol(true), Some(ProtocolType::Iterm2));
        // Only device attributes: half-blocks, and no cell size to scale by.
        let plain = Replies::parse(b"\x1b[?1;2c");
        assert_eq!(
            (plain.protocol(false), plain.cell, plain.done),
            (None, None, true)
        );
        // Still waiting for the device attributes.
        assert!(!Replies::parse(b"\x1b_Gi=31;OK\x1b\\").done);
    }
}

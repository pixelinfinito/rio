//! Rio's interactive terminal UI (the `terminal-ui` capability): ratatui on
//! crossterm, drawn on the design handoff's cell grid.
//!
//! # Writing a screen
//!
//! A screen implements [`app::Screen`]: it draws itself on a [`canvas::Canvas`]
//! (styled runs at exact cells, colors only as [`theme::Token`]s), names its
//! keys for the key bar (`chrome::keybar`) and the help screen, and turns keys
//! and messages into [`app::Action`]s. Anything that runs, writes or calls the
//! endpoint is an [`app::Effect`] the host performs; outcomes come back as
//! `Msg::Done`. Screens hold their own state and read the shared
//! [`app::Session`]. Each flow is a module whose screens render from plain data
//! the CLI fills in, so tests render them from the handoff's sample data and
//! compare them with `docs/design/tui-pr-comments/tui/screens/<slug>/`.

pub mod app;
pub mod canvas;
pub mod chrome;
pub mod images;
pub mod terminal;
pub mod theme;

#[cfg(feature = "guide")]
pub mod guide;
#[cfg(feature = "init")]
pub mod init;
#[cfg(feature = "qa")]
pub mod qa;
#[cfg(feature = "review")]
pub mod review;
#[cfg(feature = "team")]
pub mod team;

pub use app::{Action, App, Effect, Msg, Outcome, Screen, Session};
pub use theme::{Theme, Token};

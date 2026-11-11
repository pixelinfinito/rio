//! The `guide` flow: the command palette (`:`, G1) and the help and view map
//! (`?`, G2) every screen reaches through [`app::Globals`].
//!
//! Both read static tables: the palette's [`catalogue`] of `rio` commands
//! (from the CLI's clap definitions) and the help's [`KEYMAP`] (the same
//! [`Key`] values the key bars draw), so neither can drift from what the views
//! actually offer.

mod help;
mod palette;

pub use help::{GLOBAL_KEYS, Help, HelpData, KEYMAP, KeySection};
pub use palette::{Command, Palette, PaletteData, catalogue};

use crate::{
    app::{self, Screen},
    chrome::Key,
};

/// The help screen for the view titled `title` with key bar `keys`.
pub fn help(title: &'static str, keys: &'static [Key]) -> Box<dyn Screen> {
    Box::new(Help::new(HelpData::new(title, keys)))
}

/// The command palette for the view titled `title` with key bar `keys`,
/// listing every `rio` command of the [`catalogue`].
pub fn palette(title: &'static str, keys: &'static [Key]) -> Box<dyn Screen> {
    Box::new(Palette::new(PaletteData {
        view: title,
        view_keys: keys,
        commands: catalogue(),
    }))
}

/// The global screens for [`app::App::globals`].
pub fn globals() -> app::Globals {
    app::Globals { help, palette }
}

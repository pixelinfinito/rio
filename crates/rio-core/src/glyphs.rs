//! Glyph sets shared by the streaming renderer and the interactive UI.
//!
//! Every non-ASCII glyph the designs draw is one cell wide but East Asian
//! *ambiguous*, so terminals configured for CJK may draw it two cells wide and
//! break the grid. The ASCII set maps each glyph to one ASCII character with
//! the same meaning, so layouts stay cell-for-cell identical.

use std::borrow::Cow;

use unicode_width::UnicodeWidthChar;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum GlyphSet {
    #[default]
    Unicode,
    Ascii,
}

impl GlyphSet {
    /// `--ascii`, or `RIO_ASCII=1` in the environment.
    pub fn select(flag: bool) -> Self {
        if flag || std::env::var("RIO_ASCII").is_ok_and(|value| value == "1") {
            Self::Ascii
        } else {
            Self::Unicode
        }
    }

    /// The text as drawn with this set; Unicode text is returned unchanged.
    pub fn apply<'a>(&self, text: &'a str) -> Cow<'a, str> {
        match self {
            Self::Ascii if !text.is_ascii() => Cow::Owned(asciify(text)),
            _ => Cow::Borrowed(text),
        }
    }
}

/// Unicode glyph → ASCII replacement, one cell each.
pub const ASCII: &[(char, char)] = &[
    // Punctuation and symbols.
    ('§', 'S'),
    ('·', '.'),
    ('×', 'x'),
    ('ƒ', 'f'),
    ('Δ', 'D'),
    ('–', '-'),
    ('—', '-'),
    ('•', '*'),
    ('…', '~'),
    ('€', 'E'),
    ('−', '-'),
    ('∩', 'n'),
    ('⋯', '~'),
    // Arrows and keys.
    ('←', '<'),
    ('↑', '^'),
    ('→', '>'),
    ('↓', 'v'),
    ('↳', 'L'),
    ('↺', 'r'),
    ('⏎', '<'),
    ('①', '1'),
    ('②', '2'),
    ('③', '3'),
    ('④', '4'),
    // Box drawing.
    ('─', '-'),
    ('━', '='),
    ('═', '='),
    ('┄', '.'),
    ('│', '|'),
    ('┃', '|'),
    ('║', '|'),
    ('┌', '+'),
    ('┏', '+'),
    ('┐', '+'),
    ('┓', '+'),
    ('└', '+'),
    ('┗', '+'),
    ('┘', '+'),
    ('┛', '+'),
    ('├', '+'),
    ('┤', '+'),
    ('╔', '+'),
    ('╗', '+'),
    ('╚', '+'),
    ('╝', '+'),
    ('╭', '+'),
    ('╮', '+'),
    ('╯', '+'),
    ('╰', '+'),
    // Block elements: sparklines, gauges and the cursor bar.
    ('▁', '_'),
    ('▂', '_'),
    ('▃', '-'),
    ('▄', '-'),
    ('▅', '='),
    ('▆', '='),
    ('▇', '#'),
    ('█', '#'),
    ('▌', '>'),
    ('▏', '|'),
    ('░', '.'),
    // Geometric shapes carry states; each keeps a distinct character.
    ('■', '#'),
    ('▣', '#'),
    ('▤', '='),
    ('▮', '#'),
    ('▲', '^'),
    ('▶', '>'),
    ('▸', '>'),
    ('▼', 'v'),
    ('▾', 'v'),
    ('◂', '<'),
    ('◆', '*'),
    ('◇', '%'),
    ('○', 'o'),
    ('◎', '0'),
    ('●', '@'),
    ('◐', 'c'),
    ('✓', '+'),
    ('✕', 'x'),
    // Spinner frames.
    ('⠏', '|'),
    ('⠦', '/'),
    ('⠧', '-'),
    ('⠼', '\\'),
];

/// The ASCII replacement of one glyph, if the set defines one.
pub fn ascii(glyph: char) -> Option<char> {
    ASCII
        .iter()
        .find(|(unicode, _)| *unicode == glyph)
        .map(|(_, ascii)| *ascii)
}

/// Replace every non-ASCII character: known glyphs by their ASCII form, any
/// other text (from tools, messages or paths) by `?` repeated to its width.
pub fn asciify(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if c.is_ascii() {
            out.push(c);
        } else if let Some(replacement) = ascii(c) {
            out.push(replacement);
        } else {
            for _ in 0..c.width().unwrap_or(0) {
                out.push('?');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replacements_keep_widths_and_are_ascii() {
        for (unicode, replacement) in ASCII {
            assert_eq!(unicode.width(), Some(1), "{unicode} is one cell");
            assert!(replacement.is_ascii_graphic(), "{unicode} -> {replacement}");
        }
    }

    #[test]
    fn states_stay_distinguishable() {
        let states = ['●', '▲', '◆', '○', '◐', '✓', '✕'];
        let mapped: std::collections::BTreeSet<_> =
            states.iter().map(|c| ascii(*c).unwrap()).collect();
        assert_eq!(mapped.len(), states.len());
    }

    #[test]
    fn unknown_text_keeps_its_width() {
        assert_eq!(asciify("✓ 型 ok…"), "+ ?? ok~");
        assert_eq!(GlyphSet::Unicode.apply("✓"), "✓");
        assert_eq!(GlyphSet::Ascii.apply("plain"), "plain");
    }
}

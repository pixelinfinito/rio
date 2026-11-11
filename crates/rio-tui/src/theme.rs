//! Color tokens of the design handoff (`docs/design/tui-pr-comments/tui/tokens.json`).
//!
//! Every color on screen is a token, so outcome colors mean the same on every
//! screen: `fail` failed or error, `warn` warning, `pass` passed or fixed, `sec`
//! security. Without color (`NO_COLOR`, `--no-color`) every token is the
//! terminal default and the cursor row is drawn in reverse video.

use ratatui::style::{Color, Modifier, Style};
use rio_core::glyphs::GlyphSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Token {
    Bg,
    Panel,
    Raise,
    Rule,
    Fg,
    Dim,
    Faint,
    Signal,
    Fail,
    Warn,
    Pass,
    Sec,
    FailTint,
    PassTint,
    WarnTint,
    SecTint,
    Canvas,
    Black,
}

impl Token {
    pub const ALL: [Token; 18] = [
        Token::Bg,
        Token::Panel,
        Token::Raise,
        Token::Rule,
        Token::Fg,
        Token::Dim,
        Token::Faint,
        Token::Signal,
        Token::Fail,
        Token::Warn,
        Token::Pass,
        Token::Sec,
        Token::FailTint,
        Token::PassTint,
        Token::WarnTint,
        Token::SecTint,
        Token::Canvas,
        Token::Black,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Token::Bg => "bg",
            Token::Panel => "panel",
            Token::Raise => "raise",
            Token::Rule => "rule",
            Token::Fg => "fg",
            Token::Dim => "dim",
            Token::Faint => "faint",
            Token::Signal => "signal",
            Token::Fail => "fail",
            Token::Warn => "warn",
            Token::Pass => "pass",
            Token::Sec => "sec",
            Token::FailTint => "fail-tint",
            Token::PassTint => "pass-tint",
            Token::WarnTint => "warn-tint",
            Token::SecTint => "sec-tint",
            Token::Canvas => "canvas",
            Token::Black => "black",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|token| token.name() == name)
    }

    pub fn rgb(self) -> (u8, u8, u8) {
        match self {
            Token::Bg => (0x0E, 0x0F, 0x11),
            Token::Panel => (0x15, 0x17, 0x1A),
            Token::Raise => (0x1C, 0x1F, 0x23),
            Token::Rule => (0x2A, 0x2E, 0x34),
            Token::Fg => (0xE8, 0xE9, 0xEC),
            Token::Dim => (0x8A, 0x8F, 0x98),
            Token::Faint => (0x5A, 0x5F, 0x68),
            Token::Signal => (0x6B, 0x8B, 0xFF),
            Token::Fail => (0xFF, 0x6B, 0x5B),
            Token::Warn => (0xE8, 0xB3, 0x41),
            Token::Pass => (0x45, 0xD1, 0x8F),
            Token::Sec => (0xC7, 0x7D, 0xFF),
            Token::FailTint => (0x30, 0x1C, 0x1B),
            Token::PassTint => (0x15, 0x26, 0x20),
            Token::WarnTint => (0x2B, 0x24, 0x14),
            Token::SecTint => (0x25, 0x1B, 0x30),
            Token::Canvas => (0x08, 0x09, 0x0A),
            Token::Black => (0x0B, 0x0C, 0x0E),
        }
    }

    pub fn color(self) -> Color {
        let (r, g, b) = self.rgb();
        Color::Rgb(r, g, b)
    }

    /// The token drawn as `color`, for tests that read a rendered buffer.
    pub fn of(color: Color) -> Option<Self> {
        Self::ALL.into_iter().find(|token| token.color() == color)
    }
}

/// How the UI draws: with or without color, and with which glyph set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Theme {
    pub color: bool,
    pub glyphs: GlyphSet,
}

impl Default for Theme {
    fn default() -> Self {
        Self {
            color: true,
            glyphs: GlyphSet::Unicode,
        }
    }
}

impl Theme {
    /// Color unless `NO_COLOR` is set or `no_color` was asked for; the ASCII
    /// set for `--ascii` or `RIO_ASCII=1`.
    pub fn select(no_color: bool, ascii: bool) -> Self {
        Self {
            color: !no_color && std::env::var_os("NO_COLOR").is_none(),
            glyphs: GlyphSet::select(ascii),
        }
    }

    pub fn style(&self, fg: Token, bg: Token, bold: bool) -> Style {
        let style = if self.color {
            Style::new().fg(fg.color()).bg(bg.color())
        } else {
            Style::new().fg(Color::Reset).bg(Color::Reset)
        };
        if bold {
            style.add_modifier(Modifier::BOLD)
        } else {
            style
        }
    }

    /// The focused row: a raised background, or reverse video without color.
    pub fn cursor(&self, style: Style) -> Style {
        if self.color {
            style
        } else {
            style.add_modifier(Modifier::REVERSED)
        }
    }
}

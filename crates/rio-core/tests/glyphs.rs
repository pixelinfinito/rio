//! The ASCII set covers every glyph the design handoff draws.

use rio_core::glyphs::{ASCII, ascii};
use serde_json::Value;
use unicode_width::UnicodeWidthStr;

#[test]
fn every_design_glyph_has_an_ascii_form_of_equal_width() {
    let glyphs: Value = serde_json::from_str(include_str!(
        "../../../docs/design/tui-pr-comments/tui/glyphs.json"
    ))
    .unwrap();
    for (glyph, _) in glyphs["non_ascii"].as_object().unwrap() {
        let c = glyph.chars().next().unwrap();
        let replacement = ascii(c).unwrap_or_else(|| panic!("no ASCII form for {glyph}"));
        assert_eq!(glyph.width(), replacement.to_string().width(), "{glyph}");
    }
    assert!(ASCII.len() >= glyphs["non_ascii"].as_object().unwrap().len());
}

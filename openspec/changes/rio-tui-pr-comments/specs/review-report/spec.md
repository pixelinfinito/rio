# Spec Delta

## MODIFIED Requirements

### Requirement: Terminal renderer
The terminal renderer SHALL stream check results as they complete. It SHALL use color only when standard output is a terminal, `NO_COLOR` is unset and `--no-color` is absent. It SHALL fit within the terminal width without wrapping finding locations. With the ASCII glyph set selected, it SHALL emit only ASCII characters.

#### Scenario: Narrow terminal
- **WHEN** the terminal is 80 columns wide
- **THEN** every location line is at most 80 columns, truncating the message rather than the path

#### Scenario: ASCII glyph set
- **WHEN** the report is rendered with `RIO_ASCII=1`
- **THEN** every glyph is replaced by its ASCII equivalent, and every state stays distinguishable

## ADDED Requirements

### Requirement: Displayed finding ids
The terminal and Markdown renderers SHALL display a finding's identity as its first eight characters wherever they show an id or a command that takes one. JSON and SARIF SHALL keep the full identity.

#### Scenario: Markdown id
- **WHEN** a finding with identity `8c1e4a9b7f…` is rendered as Markdown
- **THEN** the document shows `8c1e4a9b`, and the JSON rendering of the same report carries the full identity

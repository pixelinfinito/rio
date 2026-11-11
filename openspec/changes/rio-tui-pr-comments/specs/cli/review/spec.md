# Spec Delta

## MODIFIED Requirements

### Requirement: Feedback command
`rio feedback <id> --dismiss <reason> [--note TEXT]` SHALL record a response on a finding through the configured endpoint, accepting only `fixed`, `wrong`, `intentional`, `irrelevant` or `style`. `<id>` SHALL be the full identity or a prefix of at least eight characters that matches exactly one finding. It SHALL exit 0 on success, 2 for an invalid reason, a prefix shorter than eight characters, or a missing endpoint, and 3 when the endpoint rejects the response, cannot find the finding, or finds the prefix ambiguous.

#### Scenario: Invalid reason
- **WHEN** `rio feedback 8c1e4a9b --dismiss known` is run
- **THEN** the command exits with code 2 and lists the accepted reasons without contacting the endpoint

#### Scenario: Short prefix
- **WHEN** `rio feedback 8c1e --dismiss style` is run
- **THEN** the command exits with code 2 stating that ids need at least eight characters, without contacting the endpoint

#### Scenario: Ambiguous prefix
- **WHEN** `rio feedback 8c1e4a9b --dismiss style` matches two findings
- **THEN** the command exits with code 3, lists the matching identities, and records nothing

## ADDED Requirements

### Requirement: Interactive mode flags
`rio review` and `rio qa` SHALL accept the following flags:
- `--no-tui`, which disables the interactive UI. `rio init` SHALL accept it too.
- `--ascii`, which selects the ASCII glyph set for both the interactive UI and the streaming renderer.

Without the interactive UI, `--format` defaults to `terminal` as before. The interactive UI is opened only under the conditions of the terminal-ui capability.

#### Scenario: Script unaffected
- **WHEN** a CI job runs `rio review --base origin/main` with `CI=true`
- **THEN** the streaming terminal report is written exactly as before this change

#### Scenario: ASCII streaming
- **WHEN** `rio review --no-tui --ascii` runs
- **THEN** the streaming report contains only ASCII characters

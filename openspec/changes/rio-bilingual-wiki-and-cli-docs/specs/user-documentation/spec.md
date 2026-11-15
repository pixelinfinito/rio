# User Documentation

## Purpose

Give Rio users an accessible, complete English and Brazilian Portuguese Wiki that explains supported workflows, configuration choices, and recovery steps with accurate examples and visuals.

## ADDED Requirements

### Requirement: Bilingual entry and navigation
The Wiki SHALL provide English and pt-BR entry pages, a language chooser, a grouped sidebar, guide/reference/troubleshooting indexes, and a language switch to each page's equivalent. Every published content page SHALL be reachable from its language's indexes and link to related or next steps.

#### Scenario: Start a first review in Portuguese
- **WHEN** a reader selects Português (Brasil) from Home
- **THEN** they can reach the first local review guide directly from the localized start page and continue through Portuguese prerequisites, instructions, and result explanations

#### Scenario: Switch a reference page's language
- **WHEN** a reader switches language on the profiles page
- **THEN** the equivalent profiles page opens, rather than the other language's home page

### Requirement: Complete public feature coverage
The Wiki SHALL cover every public command, nested subcommand, and user-facing option, plus installation, supported modes/platforms, configuration, profiles, providers, TUI, reports, security, council, PR workflows, feedback, QA, CI, cache, and evaluation. Internal commands SHALL be identified separately and SHALL NOT be presented as normal user workflows.

#### Scenario: Detect missing command coverage
- **WHEN** a public QA subcommand or option exists without an entry in either language's documentation coverage map
- **THEN** documentation validation fails and names the undocumented command or option

#### Scenario: Find advanced functionality
- **WHEN** a reader needs suppression proposals, QA seed export, custom providers, or the evaluation harness
- **THEN** the localized feature/reference index leads to instructions including prerequisites, examples, and limitations for that functionality

### Requirement: Outcome-oriented guides
Guides SHALL state the intended outcome, prerequisites, execution mode, ordered commands, expected results, interpretation, common failures and recovery, and next steps. The Wiki SHALL include complete paths for first local review, AI review, team PR review, browser QA, and configuring review behavior.

#### Scenario: First local review without hosting
- **WHEN** a new user follows the first local review guide with a supported project and installed project tools
- **THEN** they can select changes, run diagnostics and review, and interpret findings or skipped checks without configuring a hosted endpoint

#### Scenario: QA setup has additional prerequisites
- **WHEN** a reader opens the first browser QA guide
- **THEN** it states the supported host/runtime, image, model authentication, app contracts, fixtures, and seed prerequisites before the first run command

### Requirement: Actionable configuration reference
Configuration documentation SHALL distinguish machine settings from repository profiles, state locations and precedence, and explain defaults, valid values, effects, and validation. It SHALL include recipes for coverage, exclusions, failure policy, suppressions, provider/model selection, spending limits, cache retention, and parallelism.

#### Scenario: Disable coverage without losing desired steps
- **WHEN** a user follows the disable-coverage recipe
- **THEN** the example states the target profile path, explains inherited list replacement, preserves the intended steps, and includes a profile validation command

#### Scenario: Diagnose an overridden setting
- **WHEN** a reader consults a machine configuration option
- **THEN** its file key, environment equivalent, applicable command flag, default, precedence, and diagnostic method are documented

### Requirement: Accurate prerequisites and availability
Documentation SHALL distinguish local, hosted, and offline behavior; platform/tool requirements; implemented features; and pending validation or release gates. It SHALL explain command-specific exit codes, incomplete analysis, publication side effects, and the limits of offline execution without changing existing product behavior.

#### Scenario: Offline limits remain explicit
- **WHEN** a user reads the offline review guide
- **THEN** it explains that Rio avoids its own network requests while project tools/tests are not network-isolated, and identifies hosted-only features

#### Scenario: Zero findings does not imply complete analysis
- **WHEN** a guide shows a review with missing or failed checks and zero findings
- **THEN** it explains the check statuses and relevant failure policy instead of calling the review clean

#### Scenario: Pending acceptance is not advertised as passed
- **WHEN** a documented feature is implemented but its recorded acceptance gate remains pending
- **THEN** both languages identify that status and distinguish source availability from verified release availability

### Requirement: Authentic and accessible visual guides
The Wiki SHALL include screenshots from the actual CLI or current TUI renderer for core review, setup, configuration, team, and QA flows. Each image SHALL have localized alt text and an explanatory caption, a text equivalent, and recorded capture provenance. Synthetic fixture screens SHALL be labeled as demo data; design mockups SHALL NOT be represented as actual product captures.

#### Scenario: Read a findings walkthrough without images
- **WHEN** images cannot load or a reader uses assistive technology
- **THEN** the walkthrough still explains findings, relevant keys, and the next action through text and localized descriptions

#### Scenario: Hosted screen uses a fixture
- **WHEN** a publish-preview screenshot is generated from a synthetic session through the actual TUI renderer
- **THEN** the page labels the data as a demo and the capture record names its fixture, source version/commit, dimensions, and rendering tools

#### Scenario: Publish sanitized screenshots
- **WHEN** screenshot assets are prepared for publication
- **THEN** they contain no real credentials, private repository content, or personal paths and their transcripts match the captured output

### Requirement: Translation completeness and freshness
English and pt-BR documentation SHALL provide equivalent feature coverage, examples, constraints, navigation, captions, and troubleshooting. Commands, flags, keys, and identifiers SHALL retain their actual spelling. Validation SHALL detect missing counterparts and require a translation review record when corresponding source content changes.

#### Scenario: English prerequisites change
- **WHEN** an English guide gains a new prerequisite without updating or reviewing the pt-BR counterpart
- **THEN** the documentation check fails with the affected page and stale translation record

#### Scenario: Portuguese text preserves executable syntax
- **WHEN** a translated guide explains `rio profile validate` or a `fail_on` setting
- **THEN** prose is Portuguese while executable syntax and configuration keys remain unchanged

### Requirement: Valid examples and navigable output
Documentation checks SHALL validate generated facts, command coverage, configuration examples, page/anchor links, images, and localization relationships in source and rendered Wiki output. Harmless guide examples SHALL be exercised against disposable fixtures. Examples that provision services or publish changes SHALL be validated without performing those actions in documentation CI.

#### Scenario: Wiki rendering breaks a link
- **WHEN** a valid source link becomes an invalid page, anchor, or asset URL after rendering
- **THEN** the rendered-documentation check fails before publication

#### Scenario: Invalid profile example
- **WHEN** a guide's purportedly valid profile example fails Rio's profile validation
- **THEN** documentation validation fails and names the example

### Requirement: Versioned reproducible publication
The Wiki SHALL be reproducibly publishable from reviewed main-repository sources with source commit, documentation revision, and applicable Rio version visible. Publishing SHALL preserve unrelated Wiki content, detect conflicting edits, avoid force pushes, and document rollback. A locally generated artifact alone SHALL NOT count as a published Wiki.

#### Scenario: Publication credentials are unavailable
- **WHEN** publication lacks Wiki write access or the Wiki repository is uninitialized
- **THEN** publication fails with an actionable explanation, preserves the generated artifact, exposes no secret, and reports that remote publication remains incomplete

#### Scenario: Concurrent Wiki edits
- **WHEN** the remote Wiki changes after the publisher reads its base or an owned file differs from the expected generated revision
- **THEN** the publisher stops without overwriting those changes and identifies the conflict

#### Scenario: Repeat an unchanged publication
- **WHEN** the same documentation revision is published twice with no external changes
- **THEN** the second run changes no Wiki files and creates no content commit

#### Scenario: Complete the first Wiki launch
- **WHEN** the initial documentation release is declared published
- **THEN** the remote Home, both language entry pages, sidebar, representative language switches, and screenshot URLs have been verified and the maintainer has rollback instructions

### Requirement: Existing reference continuity
Existing repository documentation links SHALL remain usable during migration. The README and retained technical references SHALL point readers to the appropriate bilingual Wiki entry points, and the README SHALL explain how to discover documentation embedded in the CLI.

#### Scenario: Follow an older profile reference link
- **WHEN** a user opens the existing `docs/profiles.md` link after Wiki publication
- **THEN** the reference remains available and provides navigation to its Wiki topic

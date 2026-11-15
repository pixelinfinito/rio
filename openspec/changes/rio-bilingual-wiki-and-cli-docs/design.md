# Design

## Context

See `proposal.md` for the motivation. Exploration established these integration points:

- `crates/rio-cli/src/main.rs` owns the Clap command tree and dispatch. Configuration and Git discovery happen inside handlers, so a docs handler can bypass both. Public commands include `review`, `qa`, `profile`, `doctor`, `init`, `deploy`, `feedback`, `findings`, `suppressions`, and `eval`; `prepare` is intentionally hidden and runner-only.
- `qa.rs`, `deployment.rs`, and `registry.rs` define additional nested commands and options. Coverage cannot be checked from top-level help alone.
- `docs/profiles.md` contains a generated schema table maintained by `scripts/generate-profile-reference.py`; `schemas/`, `modules/profiles/`, and the configuration loader are authoritative sources for reference facts.
- The README and `docs/{adapters,cloudflare,github-app,qa,finding-history,sarif-mapping,verifier-contracts}.md` contain useful detail. They lack a unified learning path and Portuguese equivalents.
- The Wiki is enabled on `pixelinfinito/rio` (read-only GitHub check during exploration). Its separate Git repository and publication credentials have not been verified.
- `docs/design/tui-pr-comments/tui/` is a design handoff, not a capture of the released CLI. `crates/rio-tui/tests/` already exercises the actual renderer with fixtures and records deviations from those designs.
- Main `cli/review` specifications still describe older output modes, while source and completed `rio-v0-3-core` and `rio-tui-pr-comments` changes include SARIF and interactive behavior. Council implementation exists, but its change still has final validation and live A/B tasks open. Documentation must not equate implementation with a passed release gate.
- `crates/rio-cli/build.rs` supplies binary version, target, and commit. CI already checks generated profile reference drift and builds on Linux, macOS, and Windows.

## Goals / Non-Goals

**Goals:** Make the first successful workflow easy to find; give every public feature a documented home in both languages; keep commands/configuration accurate; deliver useful agent answers with small, predictable output; maintain documentation through normal pull requests.

**Non-Goals:** Translate CLI/TUI strings, redesign Rio workflows, change report/profile schemas, resolve unrelated OpenSpec drift, build a hosted documentation service, add semantic/LLM search or MCP, or bundle the illustrated Wiki into the binary. Agents receive English content initially; the human Wiki has full English and pt-BR parity.

## Decisions

### 1. Repository-owned content with two purpose-built renderings

Store human pages in `docs/wiki/en/` and `docs/wiki/pt-BR/`, concise agent topics in `docs/agent/`, and shared coverage/navigation metadata in `docs/documentation-manifest.json`. The manifest maps stable topic IDs to locale pages, agent entries, public command paths, configuration/schema sources, availability, and relevant screenshots. It records translation source hashes and reviewed source paths so CI can identify stale counterparts.

Generate command/option inventories from the Clap tree and schema facts from their existing sources. Do not introduce a second handwritten list of flags. Reuse/extend the profile reference generator instead of editing its generated table. A topic can own several Wiki pages or agent subtopics when a budget requires splitting; mapping is explicit.

Human explanations and agent summaries remain separately authored because mechanically trimming a tutorial discards prerequisites and error semantics. Shared IDs, executable examples, and source coverage checks constrain drift. Direct editing only in the Wiki repository would bypass these controls; rendering the entire Wiki into the binary would waste context and binary size.

Preserve existing technical references and inbound links. Add navigation links to their canonical Wiki topics and keep generated or contributor references in the repository. The main README becomes a short entry point with EN/pt-BR links and `rio docs` discovery; detailed material is moved only after equivalent coverage exists.

### 2. Navigation starts with user goals

`Home` offers English / Português (Brasil), a one-paragraph explanation of Rio, and five entry paths: first local review; AI review; review a PR with a team; browser QA; configure/tune Rio. Each localized start page links directly to these paths. Use a compact bilingual `_Sidebar` linking each language's start, guides, reference, and troubleshooting indexes; GitHub Wiki has one global sidebar. Each page has a language switch to the equivalent page, local table of contents when needed, breadcrumb/category link, and next/related steps.

Publish flat, unique Wiki page names (`EN-First-Review`, `PT-BR-First-Review`, etc.) generated from stable IDs, with translated display titles. Local source links are resolved into Wiki page links by the renderer and checked after rendering. Assets are published with the Wiki and linked through its supported asset URLs; no links depend on a developer checkout or a mutable source branch.

The initial content map is a completeness checklist, not a request for one giant page:

| Group | Topics and required outcomes |
| --- | --- |
| Start | What Rio does; local vs hosted prerequisites; install, verify, upgrade, uninstall on Linux/macOS/Windows; first local review; terminology and availability |
| Everyday review | Working tree/staged/branch selection; TypeScript/Python/Rust tools and monorepos; TUI walkthrough and key reference; findings/evidence/status/exit codes; JSON/Markdown/SARIF exports |
| AI and hosting | Connect existing endpoint; deploy/upgrade/resume; Cloudflare vs self-hosted runner; provider credentials, custom endpoints, dynamic routes; presets, verification, budgets and prompt caching |
| Teams and security | GitHub App/PR review and publishing; repeat rounds; feedback/history/remembered findings; suppression proposals; security catalogs; council opt-in, vendors and pending acceptance status |
| Browser QA | Prerequisites and Docker image; first QA run; journeys and sync; seed/service/file fixtures; viewports/baselines; screenshots/DOM/traces; owner guidance and UX; verification and publication |
| Tune and automate | Profile selection/inheritance; complete profile/step/rule/module references; machine config and environment variables; coverage/exclusions/suppressions/failure policies; CI recipes and code scanning; cache retention and performance |
| Reference and support | Every public command/subcommand/flag including `eval`; output schemas and command-specific exit codes; data flow/privacy/offline limits; supported Git states/platform caveats; symptom-based troubleshooting; glossary/FAQ; contribution and docs maintenance |

Guides use: outcome, prerequisites and mode, smallest working example, expected output, interpretation, common failure/recovery, and next step. Explain terms before relying on them. Configuration recipes state file location, precedence, default, change, validation, and consequence; for example disabling coverage must explain list replacement when overriding `steps`. Distinguish machine settings from repository profiles. Reference pages can be dense; beginner guides cannot assume a deployed endpoint.

Critical facts to retain include optional-tool skips versus a complete review, `doctor` exit codes differing from review, hosted-only flags, `--offline` not isolating child processes, QA platform prerequisites, explicit publication/profile-write confirmation, and incomplete/experimental acceptance status. A mode/feature matrix in each language includes those boundaries without claiming a currently downloadable stable release that has not been verified.

### 3. Screenshots show actual behavior and remain accessible

Create a documented capture harness using synthetic repositories and the actual Rio CLI/TUI. Reuse the real renderer and fixture states already exercised by `rio-tui` tests for hosted screens that would otherwise need paid accounts. Label those images "demo data" in both languages; do not imply that a hosted run was executed. Capture at least installation/version/help, doctor, streaming review, TUI selection/live/findings/export, profile inspection, setup, PR publish preview/history/suppressions, and QA journeys/matrix/evidence.

Store PNGs, readable plain-text transcripts, capture commands or fixture IDs, source commit/version, terminal dimensions, font/theme/tool versions, and asset hashes under `docs/wiki/assets/`. Fix viewport and fixture values; strip credentials, personal paths, real repository data, and transient timestamps. Build screenshots from current rendered cells/output, not from old `screen@2x.png` mockups. A renderer change affecting a screenshot requires regeneration or a recorded verification against unchanged output.

Both locales share screenshots of Rio's English UI and provide localized alt text, captions, and surrounding instructions. Captions explain what to notice. Long terminal output gets a focused image plus the complete relevant text, so images are never the only source of instructions. Capture tools remain development dependencies and are not needed for a normal Rust build.

### 4. A small, independent `rio docs` command

Proposed interface:

```sh
rio docs                              # compact topic index and retrieval syntax
rio docs list                         # same index
rio docs review                       # one compact topic
rio docs profiles --section inheritance
rio docs search "dependency mismatch" # at most five topic/section hits
rio docs search "coverage" --limit 3 --format json
rio docs review --format json
```

`--format text|json` is accepted on all docs forms; text is default even in a terminal. `--section` is valid only with a topic. Reserve `list` and `search` as command words. Topic/section IDs use a fixed lowercase ASCII kebab-case grammar; arguments identify embedded entries, never filesystem paths. IDs are stable within the documentation schema; renamed IDs retain aliases when practical. `rio --help` advertises docs and the agent-oriented retrieval flow.

Embed a validated manifest and topic text using compile-time assets in a dedicated CLI docs module. Dispatch before any machine configuration, Git/profile/cache/keychain/provider loading. Use the existing binary version/commit constants. Normal Cargo builds work with checked-in assets, without Python, a tokenizer, screenshot tools, GitHub, or network access. Include all embedded assets in source packaging.

Index entries contain an ID and short purpose. A topic contains its purpose, prerequisites, exact commands, important flags/defaults, side effects, output/exit interpretation, and related topic IDs. It is not limited to help text: an agent must learn when to use a command and what to do after failure. Large areas such as QA, deployment, providers, and profiles are split into task-sized topics. Complete compact coverage is required for all public commands and consequential configuration concepts; the Wiki is never needed to finish a documented CLI task.

Section retrieval returns the requested section plus topic identity and prerequisites/side-effect constraints necessary to use it safely. Links are optional navigation to other embedded IDs, never a replacement for the requested explanation. No TUI, pager, ANSI sequences, progress chatter, telemetry, automatic fetch, or whole-corpus `--all` option.

### 5. Explicit output budgets and deterministic search

Hard limits apply to complete UTF-8 stdout, including metadata and newlines: index/list 4 KiB, whole topic 8 KiB, section 4 KiB, search 4 KiB; JSON for any operation at most 12 KiB. CI measures the actual rendered text with a pinned development-only tokenizer (`o200k_base`): index/search at most 800 tokens, topic at most 1,800, section at most 800; JSON at most 3,000. These are measurements for that encoding, not guarantees about every model's tokenizer. The full embedded documentation payload is at most 512 KiB, excluding code and debug symbols.

Reject oversized authored entries during validation/build preparation; split them into related topics rather than clipping instructions. Index growth is managed by concise summaries and a bounded topic hierarchy. Do not add opaque compressed abbreviations just to hit the budget. Include a human quality check that prerequisites and recovery advice survived compression.

Search runs locally over IDs, titles, keywords, section names, and concise content. Use deterministic case-insensitive term matching, with ID/title matches ranked ahead of keyword/section matches and body matches; tie-break by topic then section ID. Return only IDs, titles, and one short match explanation, never full topic bodies. Default limit is 5, accepted range 1–10, and the response names whether more hits exist. Empty/whitespace-only or over-256-byte queries and invalid limits are usage errors; a nonempty query with no matches succeeds with an empty result. Every possible ten-hit result respects the output cap through bounded metadata fields.

### 6. Stable JSON and failure behavior

Define `schemas/docs-v1.json`, separate from review reports. Success envelopes contain `schema_version: 1`, `rio_version`, `rio_commit`, `docs_revision` (content hash), `kind` (`index`, `topic`, `section`, `search`), and operation-specific data. Emit compact JSON, fixed ordering, and one trailing newline. No runtime timestamp, local path, or environment-dependent detail. `kind: error` uses a bounded `error` with stable code, message, and optional suggested IDs.

Exit 0 for successful retrieval and zero search matches; 2 for unknown topic/section, invalid query/limit or option combinations; 3 for an output/internal failure. Text errors go to stderr with empty stdout. After successful argument parsing, semantic errors requested as JSON produce exactly one JSON error envelope on stdout with no unrelated content. Parser errors follow existing Clap behavior (stderr, exit 2); broken stdout cannot guarantee a JSON document. Keep suggestions short and never dump a topic on a miss. Tests cover both pre-parse and post-parse failures so consumers can distinguish them.

### 7. Documentation quality and publication are repeatable

Add a focused documentation check that validates source and rendered links/anchors/assets, identical locale IDs/required sections, translation review hashes, command/flag coverage (excluding hidden/internal commands with explicit rationale), schema/environment references, YAML examples, screenshot provenance, embedded output schema and budgets, and generated-file drift. Validate syntax without executing provisioning, publication, or suppression mutation examples. Run harmless tutorial steps in disposable fixtures; use mocked hosted examples and label them.

Publish the Wiki as generated output of a reviewed main-repository commit. A renderer produces a staging directory and owned-file manifest for inspection; it never pushes. A separate publisher takes that directory and an explicit Wiki target, verifies credentials and repository availability, then makes an ordinary non-force Git commit/push. It updates/deletes only paths recorded as generated by this system, preserves unrelated pages, detects unexpected edits to previously generated content, and aborts on concurrent remote changes. No-op content creates no commit. Record source commit, docs revision and supported binary version on Wiki pages/footer.

Provide a manual publication command and a manually dispatched publishing workflow, separate from read-only PR validation. Use a repository-scoped credential capable of writing the Wiki; do not assume `GITHUB_TOKEN` works. If the Wiki Git repository has never been initialized, the runbook explains the one-time GitHub setup. Missing credentials/initialization fail with a clear remedy, without losing the built artifact or exposing secrets. Publishing and rollback instructions are bilingual maintenance pages; revert a generated Wiki commit or republish a previous source commit to roll back.

The first implementation includes actual publication and verification of landing pages, language switches, sidebar, links, and image URLs; staging files alone are not a completed Wiki. If external access blocks that last step, report the exact blocker and keep the task open. No publishing or workflow edits occur in this planning phase.

## Risks / Trade-offs

- Two languages and two content styles drift → shared IDs, translation review hashes, generated facts, coverage tests, and a contributor checklist; hash parity alone does not prove translation quality, so review representative complete journeys in pt-BR.
- A Wiki can describe newer source than an installed binary → clear source/version labels and version-matched embedded docs; pending release gates remain visible in both languages.
- Existing mockups differ from implementation → capture the current renderer, record provenance, and label synthetic fixture data.
- A technically complete manual can remain difficult to use → validate five beginner paths end to end; each starts at Home and reaches a useful outcome without unexplained prerequisites.
- Tight output caps can hide essential constraints → topic splitting and section prerequisites, with no silent truncation and concrete token checks.
- GitHub authentication or uninitialized Wiki delays launch → build/validate locally first, preserve a publishable artifact, and provide exact setup/retry instructions.
- New docs might be inferred as changing old specs → all existing workflow behavior remains unchanged; record source/spec discrepancies and route actual behavior changes to their owning changes.

## Migration Plan

1. Establish manifests, page templates, renderer, and coverage checks; map all existing public features and material source/spec discrepancies.
2. Author the complete EN/pt-BR Wiki, compact agent corpus, tested examples, and current screenshots. Retain existing reference URLs.
3. Add the embedded command and its schema/tests; include standalone binary smoke checks on supported platforms. Record payload and token measurements.
4. Render and validate the Wiki staging artifact, review navigation and bilingual journeys, then publish it and verify the remote pages/assets.
5. Update README/reference entry links and maintenance/release checklists. Roll back a problematic publication through Git; the CLI addition can be reverted independently without changing existing commands or cached data.

# Proposal

## Why

Rio's functionality has outgrown a long README and scattered technical references: users lack a clear path from installation to choosing workflows, interpreting results, and adjusting behavior. Agents also need accurate documentation for the installed version without fetching a website or loading the whole manual into their context.

## What Changes

- Publish a complete GitHub Wiki in English and Brazilian Portuguese, with a language chooser, matched page navigation, task-oriented guides, searchable reference indexes, troubleshooting, a glossary, and clear local/hosted/platform prerequisites.
- Cover the public CLI and its nested commands, installation and upgrades, deterministic and AI review, TUI controls, profiles and configuration, providers and budgets, security and council, GitHub integration, finding history and suppressions, browser QA, reports, CI, cache/privacy, and evaluation tooling.
- Add accessible screenshots of the running CLI and actual TUI renderer, using reproducible sanitized fixtures, translated captions, text equivalents, and capture/version metadata. Existing design mockups are not evidence of shipped behavior.
- Add `rio docs`, `rio docs <topic>`, section retrieval, local search, and optional versioned JSON output. Embed concise English documentation in the binary; work offline outside a repository, without loading configuration, contacting an endpoint, or requiring auxiliary files.
- Make progressive retrieval and output budgets part of the command contract. Return an index by default, retrieve only requested content, and omit screenshots, long narratives, and bulk dumps from the agent corpus.
- Maintain both surfaces in the main repository with shared topic IDs and coverage metadata, validated examples, translation parity, generated command/schema facts, documentation checks, and a reproducible Wiki publication process.

## Capabilities

### New Capabilities

- `user-documentation`: bilingual Wiki navigation, practical guides and reference coverage, truthful screenshots, localization parity, version provenance, and publication.
- `cli/docs`: embedded documentation discovery, bounded topic/section retrieval and search, deterministic machine output, offline independence, and installed-version fidelity.

### Modified Capabilities

None. Existing review, profile, deployment, QA, and distribution behavior is documented without changing its contract. The new CLI command is additive.

## Impact

- `docs/wiki/`, `docs/agent/`, shared documentation metadata, screenshot assets and capture recipes; README navigation and existing reference entry points.
- `crates/rio-cli/src/main.rs`, a dedicated documentation module and embedded assets, CLI tests, and a documentation JSON schema. Existing build version/commit metadata is reused.
- Documentation generation/check/publication scripts, focused CI checks, release smoke checks, and the separate `pixelinfinito/rio.wiki.git` repository. Publication credentials are needed only by maintainers or the publishing job, never by `rio docs`.
- No new runtime service, model invocation, runtime tokenizer, external documentation download, or change to report/profile schemas. Capture and token measurement tools are development-only.

The user confirmed pt-BR. Compact English agent content is the proposed default. This change plans the documentation and command; implementation and Wiki publication follow the apply workflow. Release readiness must remain honest: implemented features and pending acceptance gates are distinct.

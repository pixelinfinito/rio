# Tasks

## 1. Documentation structure and shared coverage

- [x] 1.1 Create `docs/documentation-manifest.json` and its validator, mapping the design's content groups to stable topic IDs, EN/pt-BR pages, embedded topics, command/configuration sources, and screenshots. Verify duplicate IDs, missing locale mappings, and broken related-topic references fail focused validator tests.
- [x] 1.2 Add a development-only command inventory export from Rio's Clap tree, including nested QA/profile/suppression/evaluation commands and public flags; record the hidden `prepare` exclusion. Verify an unmapped public command/flag fails coverage and generated facts match parser help without invoking handlers.
- [x] 1.3 Define human guide/reference and compact agent templates, localization glossary, source-review hashes, and documentation contribution instructions. Verify sample EN/pt-BR pages satisfy required sections and an English edit invalidates its translation review record.
- [x] 1.4 Map schema/configuration facts from `schemas/`, `modules/profiles/`, `config.rs`, `deployment.rs`, and existing reference generation into the coverage manifest. Record known main-spec/source discrepancies and pending release gates without editing unrelated specs; verify each documented fact has a concrete source and availability designation.
- [x] 1.5 Implement the Wiki staging renderer with flat locale-prefixed pages, Home, `_Sidebar`, language switches, anchors, asset links, provenance footer, and owned-file manifest. Verify deterministic output and source/rendered link checks using small bilingual fixtures, including translated headings and duplicate-heading anchors.

## 2. English and pt-BR getting started and review guides

- [x] 2.1 Write both localized start pages, overview, glossary, feature/mode/platform matrix, and guide/reference/troubleshooting indexes. Verify all five primary learning paths are reachable directly from each localized start page and every page has its counterpart link.
- [x] 2.2 Write installation, verification, source build, upgrade, and uninstall guides for Linux/macOS/Windows, including checksum/provenance, PATH, version pinning, and release availability caveats. Verify commands against installer interfaces and distinguish tested source behavior from unverified downloadable versions.
- [x] 2.3 Write first local review, staged/branch selection, language tools/monorepos, diagnostics, and supported Git-state guides in both languages. Run harmless examples in disposable fixtures and record expected outputs including missing-tool and dependency-mismatch recovery.
- [x] 2.4 Write TUI navigation, findings/evidence, incomplete/partial results, command-specific exit codes, and terminal/JSON/Markdown/SARIF export guides in both languages. Verify keys against current UI handlers and output explanations against existing CLI/report tests.
- [x] 2.5 Write profiles/inheritance, complete configuration/environment reference, and recipes for coverage, exclusions, required checks, suppressions, cache, and parallelism in both languages. Reuse generated schema facts; validate all profile examples and verify list replacement and machine-versus-repository precedence are explained.

## 3. Hosted review, teams, and advanced guides

- [x] 3.1 Write bilingual AI review and endpoint setup guides covering existing endpoint connection, Cloudflare deployment/resume/upgrade, self-hosted runners, credentials and data flow. Verify command syntax through the parser and deployment mocks without provisioning resources.
- [x] 3.2 Write bilingual provider/custom endpoint/dynamic route, preset/verification, model budget/cost, and prompt caching guides. Validate profile examples and verify prerequisites, available configuration keys, and cost/usage meanings against source and existing contracts.
- [x] 3.3 Write bilingual GitHub App, PR review, publish preview/policy, CI, and SARIF code-scanning guides. Verify examples and permissions against GitHub/CLI implementation, keep publication effects explicit, and validate workflow examples without publishing comments.
- [x] 3.4 Write bilingual lineage, feedback, finding history, remembered dismissal/regression, and suppression proposal guides. Verify all reasons, identifiers, endpoint requirements, confirmation paths, and mutation effects against registry/feedback tests.
- [x] 3.5 Write bilingual security catalogs and council guides including opt-in, vendor allowlists, evidence tiers, partial results, audit records, and pending evaluation gates. Validate examples and ensure neither locale represents pending acceptance as passed.
- [x] 3.6 Write bilingual cache/privacy/offline, troubleshooting/FAQ, and evaluation/contributor reference pages. Verify troubleshooting maps symptoms to a diagnostic command and recovery step, and that `eval` prerequisites and every remaining public command/flag are covered.

## 4. Browser QA documentation

- [x] 4.1 Write bilingual QA prerequisites, image/setup, first run, journeys, selection, baseline, and sync guides using `tests/fixtures/qa-sample`. Validate contracts and documented CLI syntax; explicitly identify supported runtime/platform and model authentication requirements.
- [x] 4.2 Write bilingual seed build/export/status/prune, service/file fixtures, app startup, viewports, and owner guidance/UX guides. Validate sample contracts and compare examples to existing QA fixtures/tests without silently requiring production data.
- [x] 4.3 Write bilingual QA evidence/status/prune, screenshot/DOM/trace interpretation, verification, publication, and failure-recovery reference pages. Verify all nested QA commands are mapped and the documentation distinguishes local unverified results from hosted verification.

## 5. Current CLI and TUI screenshots

- [x] 5.1 Add documented reproducible capture tooling using the actual CLI output and `rio-tui` renderer with sanitized fixtures; record version/commit, commands/fixture IDs, dimensions, fonts/theme/tool versions, and hashes. Verify repeat captures preserve expected text/cells and do not rely on design mockups.
- [x] 5.2 Capture version/help, doctor, streaming review, profile inspection, and TUI start/live/findings/export screens. Deliver PNGs and text transcripts; verify legibility, source provenance, absence of secrets/private paths, and localized captions/alt text in the matching guides.
- [x] 5.3 Capture setup, publish preview, history, suppression proposals, and QA journeys/matrix/evidence screens through current fixture-backed rendering. Verify demo labels in both languages and match transcripts to current rendering and known design deviations.
- [x] 5.4 Add asset existence/provenance/freshness checks and capture maintenance instructions. Verify a missing PNG, absent translated caption, or stale affected-renderer review record is reported before publication.

## 6. Embedded agent documentation and CLI behavior

- [x] 6.1 Author compact English topics in `docs/agent/` for review/doctor/results, profiles/configuration, and installation/discovery, including exact commands, prerequisites, side effects, errors, recovery, and related IDs. Verify source coverage, executable examples, and absence of image/external-fetch dependencies.
- [x] 6.2 Author compact English topics for hosting/providers/budgets, GitHub/feedback/suppressions, security/council, QA, cache/offline, and evaluation; split large areas into related topics. Verify every public command/subcommand and consequential configuration concept has usable embedded guidance.
- [x] 6.3 Add a checked-in embedded asset registry/content revision and CLI docs handler in `crates/rio-cli`, wired into main dispatch and top-level help. Implement default/list, topic, and section text output; test reserved words, available section IDs, prerequisite retention, and unknown/path-like IDs.
- [x] 6.4 Implement deterministic local search with ranking, stable ties, query validation, limits, bounded match metadata, and more-results indication. Verify exact/title/body matches, case handling, empty and oversized queries, no results, and worst-case ten-hit output.
- [x] 6.5 Add `schemas/docs-v1.json`, compact JSON rendering, version/commit/docs-revision metadata, and documented error codes/exit behavior. Validate all success and semantic-error forms against the schema; test clean stdout, parser errors, invalid section combinations, and output failures.
- [x] 6.6 Add binary integration tests for docs outside a repository with malformed configuration, missing source assets/tools, unavailable network, and unwritable config/cache locations. Verify no subprocess/network/config/cache/keychain work occurs and output stays identical across TTY/pipe, locale, CI, and color settings.
- [x] 6.7 Add complete-output byte/token budget checks using a pinned development-only `o200k_base` tokenizer and record per-operation measurements plus embedded payload size. Verify all topics/sections, index, errors, and maximum-size search responses meet the design limits; reject oversized entries without truncation.
- [x] 6.8 Add bilingual Wiki instructions for agent use (`index -> search/topic -> section`), including JSON/error examples, reference-token caveat, and installed-version behavior. Verify the examples run against the implemented command and normal source builds need no documentation tooling.

## 7. Quality gates and Wiki delivery

- [x] 7.1 Integrate documentation validation into CI for locale parity/freshness, generated fact coverage, links/anchors/assets, examples, provenance, schema, and token/payload limits. Verify representative invalid fixtures fail without executing provisioning, external publication, or repository mutation examples.
- [x] 7.2 Add a separate Wiki publisher and manual-dispatch workflow consuming validated staging output; document scoped credentials, first-time initialization, generated-file ownership, conflict detection, and rollback in both languages. Test idempotency, unrelated-page preservation, managed-file conflicts, concurrent pushes, deletions, and rollback against disposable Git remotes.
- [x] 7.3 Add documentation smoke checks to existing Linux/macOS/Windows build/release validation, including running a copied binary with no source docs. Verify version metadata and index/topic/JSON output from the packaged artifact and record any platform check that could not be run locally.
- [x] 7.4 Add README and existing-reference links to both Wiki entry points and `rio docs`; preserve old reference URLs. Verify complete local link checks and ensure no reference material is removed before equivalent Wiki coverage exists.
- [x] 7.5 Perform end-to-end content acceptance for the five primary paths in English and pt-BR, including screenshots and failure recovery. Record outcomes, verify full coverage/parity and generated Wiki links, and fix unclear instructions before publication.
- [x] 7.6 Run `cargo fmt --all --check`, `cargo clippy --workspace --all-targets --locked`, relevant `rio-cli`/`rio-tui` tests, documentation checks, and `openspec validate rio-bilingual-wiki-and-cli-docs --strict`. Verify normal CI regression checks and record concrete results without claiming unavailable hosted/platform checks passed.
- [x] 7.7 Publish the reviewed Wiki artifact to `pixelinfinito/rio.wiki.git` and verify remote Home, EN/pt-BR indexes, sidebar, language switching, and representative images/anchors. Record source and Wiki commit IDs and published URLs; if credentials or initialization block publication, report the blocker and leave this task incomplete.

## 8. Wiki usability review follow-up

- [x] 8.1 Replace Home with validated authored EN/pt-BR landing content: prominent real TUI captures, local/staged/branch/PR commands, accurate prerequisites and clear next steps. Preserve existing URLs.
- [x] 8.2 Improve localized sidebar/breadcrumbs, reference lookup, guide descriptions, schema navigation and collapsible command tables; use command-specific option descriptions.
- [x] 8.3 Correct the actual TUI never-policy label and refresh its rendering expectations/captures; clarify version tags and polish both languages.
- [x] 8.4 Validate content, rendering, source/translation freshness, focused tests and embedded budgets; push the updated PR, republish and verify public Home/navigation/images.

# Documentation acceptance record

This record describes validation on Linux for `rio-bilingual-wiki-and-cli-docs`. The human Wiki covers 37 matched topics (74 localized pages plus Home/sidebar), 25 actual CLI/TUI captures with transcripts, and all 35 public parser command paths. Hidden runner-only `prepare` is deliberately excluded. Check the inventory for the exact current count.

## Five learning paths, English and Brazilian Portuguese

| Path | Acceptance evidence |
| --- | --- |
| First local review | Both Start pages link installation → review → results. Disposable Git examples exercise clean/changed offline JSON review and doctor. Existing CLI regressions cover missing tools and dependency mismatch. Captures show actual help, version, doctor and review. |
| AI review | Both hosting guides distinguish connection, account provisioning and self-hosted execution. Includes exact Docker/runner launch, credentials, cost effects and recovery. Parser examples and deployment mocks validate syntax/behavior without provisioning. |
| Team PR review | Both GitHub guides explain App installation, merge-base policy, ask/auto/never, forks, preview, comments and publication failure. Current renderer fixtures show preview/history/suppression proposals. Existing endpoint and registry tests validate publication and feedback behavior. |
| Browser QA | Both guides link setup → journeys → seeds → evidence. YAML examples validate against schemas; sample contracts pass CLI validate/list/show. Linux Docker, authentication and local-unverified limits are explicit. Actual fixture captures illustrate journeys/matrix/cell/UX. |
| Configure Rio | Both profile guides explain defaults, precedence, list replacement, required checks and complete coverage-disable pipeline. Examples pass profile validation. Generated schema/module facts cover configuration keys, constraints and union variants. |

All pages have counterpart navigation; longer pages have contents links. Render validation checks local links and anchors. Translated screenshot descriptions link text equivalents. Source and translation hashes require explicit review when content changes. All 25 PNG/transcript pairs reproduced byte-for-byte after normalizing synthetic commit/run identities, timing and free disk space. The known preview-fixture `never` discrepancy is explained in both languages; endpoint behavior is authoritative.

## Automated evidence

- Documentation suite: 16 passing checks, including bilingual/source freshness, invalid metadata/flag/caption/capture fixtures, YAML/profile examples, deterministic rendering, terminal/pipe identity and safe tutorial execution.
- Publisher tests use disposable remotes: initial adoption, no-op, unrelated-page preservation, edit conflict, concurrent push, owned deletions, rollback, tampering and symlink-parent rejection.
- Embedded docs integration: all topics/sections, JSON schema, error forms, deterministic search, no-source/no-tools copied binary and locale/color independence. Output-write failure has a unit test.
- Pinned `o200k_base` measurement records are in `documentation-budgets.json`; index/search/section ≤800 reference tokens, topics ≤1800, JSON ≤3000. Conservative bounds cover any ten-hit search metadata. No runtime tokenizer or external fetch.
- Workflow YAML parses. Unix installer suite: 10 passed. Release suite: 9 passed. Linux copied-binary smoke passes with malformed config and empty PATH.
- Strict OpenSpec validation passes. Rust format and workspace/all-targets Clippy pass. CLI/TUI regression suite: 261 passed, 0 failed, 1 intentionally ignored inventory exporter; the exporter is run explicitly in documentation CI. The final docs integration rerun passed all 5 checks, including unusable config/cache paths.

## Limits of this validation

macOS and Windows were not available locally; CI and native release installers now run the copied-binary smoke there. ARM Linux release validation runs installed docs under QEMU. These checks are configured, not claimed as already passed remotely. No paid model calls, Cloudflare provisioning, Docker browser run or GitHub comments were triggered for documentation acceptance. Hosted screenshots use clearly labeled synthetic fixture states. Existing live acceptance/council A/B gates remain pending.

CodeRabbit reported authenticated status but rejected review startup with `reauthentication_required`; no CodeRabbit review completed. Local source review and automated checks supply the evidence here.

## Publication

The user initialized the Wiki with a placeholder Home. First publication explicitly adopts only `Home.md`; the publisher preserves unrelated pages and never force-pushes. Publication completed and public HTTP verification passed.

- Published source: `c773cde4e53c931250ee6fd115db2f0f331bb662`.
- Wiki commit: `1765394e810fff3a8096dd32b89d6fa9636632d6`.
- Verified Home, EN/pt-BR Start, Hosting and GitHub pages (HTTP 200), bilingual sidebar/language links, English and accented Portuguese heading IDs, and two representative PNG assets (HTTP 200 and valid PNG signatures).
- [English](https://github.com/pixelinfinito/rio/wiki/EN-Start) · [Português (Brasil)](https://github.com/pixelinfinito/rio/wiki/PT-BR-Start).

## Usability review follow-up

Applied the user's accepted Opus review: Home now renders the reviewed English start source with a prominent findings screenshot and Portuguese counterpart. Both pages explain local CLI review first, list working-tree/staged/branch/PR commands, and distinguish optional AI/browser setup. The sidebar has localized task links. Reference now provides command/file/environment/exit-code lookup; full command tables collapse in guides, and ambiguous flags have command-specific descriptions. Human schema navigation points to complete tables; previous compact-page URLs remain accessible. Published URLs are preserved.

Corrected the real TUI `never` policy label to `no publication`, updated the documented rendering deviation and recaptured actual screens. The old explanatory caveat was removed. Local runner build examples now use the explicitly explained `local` image tag, avoiding an unrelated release number.

Follow-up validation: 18 documentation/publisher tests, 24 team-renderer tests, 21 capture-fixture tests and 5 embedded-doc integration tests passed. Format and Clippy for both affected crates/all targets passed; strict OpenSpec, schema drift, source/rendered links and translation/capture freshness passed. All 292 measured outputs remain within their byte/token budgets (71,016-byte embedded payload). Terminal transcript trailing spaces intentionally preserve the rendered cell grid.

Published source `1428a76f4c6557f404d36b9fd5b4748c7a34250f`; Wiki commit `614af91e7a5f5a252d49eb694a51964647f171f8`. Public HTTP checks passed for Home, EN/pt-BR Start, Reference and Review pages, localized sidebar/switch links, command anchors and expandable option tables. The findings, start-screen and corrected publish-preview PNGs returned HTTP 200 and matched local SHA-256 hashes.

## README introduction follow-up

Replaced the long implementation reference with a product introduction: own your AI review pipeline; an open-source alternative to CodeRabbit and Greptile; local review, optional hosted AI, team workflows and browser QA. Retained the original header image line byte-for-byte, added a star invitation and the existing real TUI screenshot, and linked detailed setup/reference content to both Wiki entry points. The quick start uses a source build because GitHub currently lists no published releases; the evaluation limitation remains linked near the end.

Validated README local paths/anchors and Wiki destinations, checked command syntax without running review/provisioning handlers, exercised the three read-only embedded-doc examples, and passed documentation freshness/render checks and strict OpenSpec validation. This prose-only change required no new runtime tests.

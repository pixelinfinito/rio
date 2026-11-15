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

The user initialized the Wiki with a placeholder Home. First publication explicitly adopts only `Home.md`; the publisher preserves unrelated pages and never force-pushes. Publication source/Wiki commits and HTTP verification results will be appended after delivery.

# Give an agent documentation through the CLI

## Outcome

Retrieve just enough version-matched information for the next task, without a website or a large manual in context.

## Prerequisites

Only the Rio binary. These commands work offline, outside a repository, without configuration, credentials, helper tools or a cache. They do not run a review or mutate anything.

## Steps

```sh
rio docs
rio docs search "dependency mismatch"
rio docs review
rio docs profiles --section inheritance
rio docs review --format json
```

Start with the short index. Search returns topic/section references with brief reasons, not complete documents. Retrieve the relevant topic, or one section with its prerequisites and effects. `rio docs list` is the index alias. Search accepts `--limit 1..10` (default 5); quote multiple words. Empty/over-256-byte queries are usage errors, while no matches is a successful empty result.

## Expected results

Compact English content is embedded in the binary. JSON uses `schema_version: 1`, `rio_version`, `rio_commit`, `docs_revision`, `kind` and `data`. Text and JSON have no ANSI, progress, pager or TUI. The same binary/arguments produce the same output, regardless of locale/current directory.

Complete text limits: index/search/section 4 KiB and 800 reference tokens; whole topic 8 KiB and 1,800 tokens. JSON is at most 12 KiB/3,000 reference tokens. Measurements use pinned `o200k_base`; other tokenizers differ. Oversized authored topics fail checks instead of being silently cut. There is no full-corpus dump option.

## Troubleshooting

Exit 0 means success; 2 means usage or unknown topic/section; 3 means internal/output failure. Text errors use stderr. Semantic errors after parsing return one JSON error envelope when requested; parser errors remain stderr and cannot promise JSON. Unknown sections list valid IDs instead of dumping the topic. IDs never address files or URLs.

An older binary keeps its own docs even after the Wiki changes. Check version metadata rather than fetching a newer manual and assuming every flag exists.

## Next steps

For agent instructions, use: “Run `rio docs`, retrieve only relevant topics/sections, and use `--format json` for structured documentation.” Continue with [review](review.md) or [profiles](profiles.md).

<!-- commands:start -->

## Command reference

### `rio docs`

| Argument | Meaning | Default / choices |
| --- | --- | --- |
| `<topic>` | Embedded topic ID, list, or search. | `—` |
| `<query>` | Quoted documentation search terms; nonempty, at most 256 UTF-8 bytes. | `—` |
| `--section` | Retrieve one embedded topic section with its prerequisites. | `—` |
| `--limit` | Maximum documentation search hits, 1–10; default 5. | `—` |
| `--format` | Choose the output format; supported values are listed. | `text, json` |
| `--help` | Show command syntax and supported options. | `—` |

<!-- commands:end -->

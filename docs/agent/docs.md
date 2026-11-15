# Read embedded documentation

No repository, configuration, credentials, tools or network required. Documentation is embedded with the binary and read-only; English content is compact for agents. The human Wiki is also available in pt-BR, but retrieval never fetches it.

## retrieve
`rio docs` or `rio docs list` returns a short index. `rio docs review` returns one topic. `rio docs profiles --section inheritance` returns one section plus required context. Available section and related topic IDs appear in responses. No full-manual dump is offered.
`rio docs search "dependency mismatch"` returns references, not full bodies; --limit 1..10 (default 5). Empty or over-256-byte queries fail; no matches succeeds. Topic/section IDs address embedded content, never filesystem paths/URLs.

## output
All forms accept --format text|json. JSON schema_version 1 includes rio_version, rio_commit, docs_revision, kind and data. No ANSI, pager, TUI or progress. Exit 0 success; 2 usage/unknown topic/section; 3 internal/output failure. Semantic errors after parsing produce JSON kind:error when requested; parser errors go to stderr instead. Text errors go to stderr with empty stdout.

## budgets
Complete text: index/search/section <=4KiB and <=800 reference tokens; topic <=8KiB and <=1800 tokens. JSON <=12KiB and <=3000 tokens. Reference tokenizer: pinned o200k_base; other models count differently. Oversized authored topics fail checks and must be split, never silently clipped. Query only the topics needed for the task. Binary version controls documentation; a newer Wiki does not change it.

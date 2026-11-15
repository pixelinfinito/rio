# Understand data, cache and offline behavior

## Outcome

Know where source/evidence goes and choose retention settings appropriate to your project.

## Prerequisites

Access to your machine configuration and an understanding of whether the review is local or hosted. Cache files should receive the same protection as source code.

## Steps

Use `rio doctor --format json` to inspect the effective cache path, free space and settings. Defaults: `.rio/cache`, 30 days, 5 GiB, raw tool output retained. Change `cache.dir`, `max_age`, `max_size`, `retain_raw_output` in user `config.toml` or the corresponding `RIO_CACHE_*` environment variables.

Local caches contain immutable snapshots, extracted trees, profiles, findings, graph slices and redacted outputs. Each tool executes in its own disposable source copy, so source-rewriting tools do not modify the cache. Dependencies may be linked from the worktree's installation. Concurrent runs use locks and separate run directories.

Hosted review uploads selected base/head snapshots to your endpoint. Configured model routes and allowlisted council vendors receive bounded context/evidence. Changed dependency auditing sends package names, versions and ecosystems to OSV. Source snapshots themselves may include secrets even though raw output is redacted.

## Expected results

Unix cache directories/files use 0700/0600; Windows inherits containing ACLs. Raw streams retain bounded head/tail, capped at 16 MiB each. Setting `retain_raw_output = false` prevents new raw streams but does not erase snapshots or existing records. Age/size/reachability rules prune eligible entries while protecting active references.

`--offline` disables Rio network requests. It does not network-isolate linters/plugins/tests. To block all traffic, use external isolation or disable subprocess checks deliberately. Hosted-only flags fail in offline mode rather than quietly switching semantics.

## Troubleshooting

Full disk: inspect effective path and active runs, then adjust retention or remove unneeded caches deliberately. Uninstall does not search repositories for caches. Missing local lineage copies are refetched from the endpoint, not treated as resets. Agent hypothesis caching skips repeat model generation for matching context, but verification still runs; `cache: false` on rio/agents disables that cache only.

## Next steps

[Change machine settings](configuration.md), [manage QA evidence](qa-evidence.md), or [review locally](review.md).

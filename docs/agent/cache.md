# Cache, privacy and offline limits

Caches contain source snapshots and evidence and must be protected like the repository. Rio's --offline guarantee applies to Rio requests, not project subprocesses. Use external isolation when all network must be blocked.

## data
Local review uses selected immutable snapshots, extracted source trees, profiles, findings, graph and redacted tool output. Source snapshots can still contain committed secrets. Each tool uses a disposable copy; cached source is not a writable hard-linked tool directory. Dependencies can be linked from worktree installations. Hosted mode uploads base/head snapshots to your endpoint; allowlisted model providers receive bounded context/evidence. OSV auditing sends changed package identities/versions to api.osv.dev.

## retention
Default .rio/cache, age 30d, size 5GiB; override user config cache.dir/max_age/max_size or corresponding RIO_CACHE_* variables. Raw streams are redacted and capped at 16MiB each (head/tail); cache.retain_raw_output=false disables them. Unix directories/files use 0700/0600; Windows inherits ACLs. Run records are per execution; locks/leases protect concurrent runs and pruning.

## recovery
Full disk: inspect doctor effective cache path and free space; lower limits or deliberately remove unneeded repository caches after active runs finish. Missing lineage cache refetches endpoint state; only --reset-lineage resets generation. Uninstall removes binaries, optionally config, but does not find/delete every repository cache. Agent hypothesis cache can replay unchanged context; verification still runs. Set cache:false on rio/agents with to disable it while preserving other desired steps.

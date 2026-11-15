# Configure your machine

## Outcome

Choose resource limits, cache paths and endpoint settings without letting a cloned repository control your machine configuration.

## Prerequisites

Find the user config directory: `RIO_CONFIG_DIR`, otherwise `$XDG_CONFIG_HOME/rio`, otherwise `~/.config/rio` on Linux/macOS. Windows uses `%APPDATA%\rio`, with `%USERPROFILE%\.config\rio` as fallback. The file is `config.toml`. Never place secrets in a repository profile.

## Steps

Create or edit the user file, preserving deployment/App sections already written by setup:

```toml
[cache]
max_age = "7d"
max_size = "2GiB"
retain_raw_output = false
[run]
parallelism = 2
output_limit = "128MiB"
```

Run `rio doctor --format json` to see effective values and their sources. Matching flags override environment, which overrides file, which overrides defaults. Invalid file values are rejected even if an environment variable would override them.

| File key | Environment | Default |
| --- | --- | --- |
| `endpoint.url` | `RIO_ENDPOINT_URL` | Unset |
| `cache.dir` | `RIO_CACHE_DIR` | Repository `.rio/cache` |
| `cache.max_age` | `RIO_CACHE_MAX_AGE` | `30d` |
| `cache.max_size` | `RIO_CACHE_MAX_SIZE` | `5GiB` |
| `cache.retain_raw_output` | `RIO_CACHE_RETAIN_RAW_OUTPUT` | `true` |
| `run.parallelism` | `RIO_PARALLELISM` | Physical cores, at most 4 |
| `run.output_limit` | `RIO_OUTPUT_LIMIT` | `256MiB` per tool stream |

`RIO_TUI=0`, `RIO_ASCII=1` and `NO_COLOR` control presentation. `RIO_API_TOKEN` supplies endpoint authentication. Provider keys and deployment tokens use their documented private environment/secret-store inputs; [hosting](hosting.md) explains setup. `[deployment]` stores replayable choices and `[github_app]` stores App identifiers. These are distinct from repository review policy.

## Expected results

Doctor names the selected source of each effective value. Cache retention changes apply to pruning; disabling raw output does not erase source snapshots or old artifacts automatically.

## Troubleshooting

An unknown TOML key exits with a named configuration error. Use positive parallelism and supported byte/duration units. A repository `.rio/config.toml` cannot override machine settings. If a headless keychain is unavailable, explicitly choose the file credential store during deployment rather than putting keys in TOML.

## Next steps

[Adjust review policy](profiles.md), [understand cache privacy](cache.md), or [connect an endpoint](hosting.md).

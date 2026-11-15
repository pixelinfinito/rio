# Machine configuration

Machine configuration is user-owned; Rio never reads these settings from a cloned repository. Invalid keys/values are errors even when another source overrides them. Do not store secrets in repository profiles.

## paths
Config directory: RIO_CONFIG_DIR; else XDG_CONFIG_HOME/rio; else ~/.config/rio (Linux/macOS), or APPDATA/rio on Windows with USERPROFILE/.config/rio fallback. File: config.toml; personal profiles: profiles/. Flags override matching environment values, then file, then defaults. `rio doctor --format json` shows effective values/sources.

## settings
endpoint.url / RIO_ENDPOINT_URL: unset by default. cache.dir / RIO_CACHE_DIR: repository .rio/cache. cache.max_age / RIO_CACHE_MAX_AGE: 30d. cache.max_size / RIO_CACHE_MAX_SIZE: 5GiB. cache.retain_raw_output / RIO_CACHE_RETAIN_RAW_OUTPUT: true. run.parallelism / RIO_PARALLELISM: physical cores capped at 4. run.output_limit / RIO_OUTPUT_LIMIT: 256MiB per tool stream.
Example config.toml: `[cache]` with `max_age = "7d"`, `max_size = "2GiB"`, `retain_raw_output = false`; `[run]` with `parallelism = 2`, `output_limit = "128MiB"`. Positive parallelism required. Sizes accept byte counts or units; ages accept durations/days.

## credentials
Endpoint API token: RIO_API_TOKEN or configured credential store; connect with `rio init --endpoint URL --token-stdin` using secret-manager stdin. Deployment choices are under [deployment], GitHub App identifiers under [github_app]. `rio deploy --dry-run` inspects deployment without mutation. Provider keys use environment/private secrets files or keychain, not arguments. `NO_COLOR`, RIO_ASCII and RIO_TUI control terminal display; see tui. For a bad config, correct the named file/key and rerun doctor.

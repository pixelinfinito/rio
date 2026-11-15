# Review changes

Requires a Git working tree, project dependencies and installed toolchains. Review executes project tools/tests and writes snapshots/reports to the cache. Hosted mode sends selected source to the configured endpoint; use --offline to keep Rio local.

## selection
`rio review --format json` reviews tracked/staged changes and untracked nonignored files against HEAD. `--staged` selects only the index. `--base origin/main` selects committed HEAD against the merge base, not local edits. Selection flags conflict. `--profile NAME_OR_PATH` chooses a profile. No endpoint: deterministic checks/graph run; agents/verifiers are deferred (`no_endpoint`).
`--offline` prevents Rio network calls, not network from tools/tests. Install dependencies yourself; Rio does not install them. To avoid terminal UI use `--no-tui`, `RIO_TUI=0`, or an explicit `--format terminal|json|md|sarif`. `--no-color`, `NO_COLOR`, and redirects disable color; `--ascii`/`RIO_ASCII=1` use ASCII glyphs.

## hosted
Configured endpoint and online mode required for `--pr NUMBER`, `--preset quick|standard|deep`, `--deep`, `--publish`, `--since-last`, `--fork`. `--deep` conflicts with `--preset`. `--nightly` marks a nightly evaluation run for council triggers. `--fork` marks the local submission; PR mode derives fork status at the endpoint.
`rio review --since-last` continues branch lineage; `--reset-lineage` requires it and starts a new generation. Detached HEAD is invalid for lineage. See github for PR publishing and feedback for rounds.

## interpret
`--show-pre-existing` reveals baseline findings; `--show-remembered` lists remembered dismissals without changing policy. Exit 0: no policy failure, possibly skipped optional checks; 1: policy finding; 2: usage/config; 3: repository/internal; 4: incomplete/required-check failure; 5: PR publication failure after a passing review; 130: second interrupt. Inspect check statuses even on 0. First Ctrl-C preserves partial results; second stops processes and emits no JSON document.

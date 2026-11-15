# Use Rio in CI and code scanning

## Outcome

Keep a machine-readable report while preserving the review's actual failure status.

## Prerequisites

A checkout with enough Git history, project dependencies/tools installed, and chosen policy. Hosted mode also needs endpoint credentials. Do not expose credentials to untrusted fork jobs. Rio can execute project code.

## Steps

Fetch the comparison branch and sufficient history, then use an explicit format:

```sh
rio doctor --base origin/main --format json
rio review --base origin/main --format json > rio-report.json
```

CI disables the TUI; explicit output also works outside CI. For shell automation that must upload after failure, preserve the exit code:

```sh
status=0
rio review --base origin/main --format sarif > rio.sarif || status=$?
# Upload the file if present and valid, then preserve the review outcome.
exit "$status"
```

In GitHub Actions, upload SARIF with the code-scanning upload action and `security-events: write` where supported. Run upload even when the review step fails, but do not turn the final gate into `|| true`. An argument error or second interrupt may leave no valid document; validate before upload. JSON/Markdown are useful artifacts even without code scanning.

## Expected results

SARIF is version 2.1.0; invocation errors represent review exits 2/3 without findings. The review policy determines gating. Set `fail_on.required_checks: [typecheck, lint]` if missing tools should fail, because optional skips can accompany exit 0. App-managed GitHub checks are neutral and are not a replacement for CLI policy gating.

## Troubleshooting

Shallow history: deepen/fetch before comparing merge bases. Partial clones: hydrate required objects. Hosted dependency mismatch: provision compatible dependencies into the runner inputs; Rio does not install them. For local offline review add `--offline`, and use external network isolation when project subprocesses must also be blocked. Keep secrets separate from PR-controlled commands.

## Next steps

[Interpret exit codes](results.md), [adjust failure policy](profiles.md), or [set up the GitHub App](github.md).

# Troubleshooting and frequently asked questions

Start with `rio doctor --format json`, then inspect the review's status and check reasons.

| Symptom | What to do |
| --- | --- |
| No changes | Check selection: branch mode ignores local edits; staged mode needs indexed changes |
| Tool missing | Install project dependencies/pinned tools; Rio does not install them |
| Dependency mismatch | Synchronize installation to selected lockfile; trust cannot override known mismatch |
| No AI findings / `no_endpoint` | Connect endpoint and select a profile with models; local deterministic review is still useful |
| Invalid profile | `rio profile validate`; inspect YAML paths, inheritance and replaced lists |
| Exit 0 with skips | Optional tools can be skipped; inspect completeness or require them in fail_on |
| Exit 4 | Failed/cancelled analysis or required skipped checks; inspect reasons before changing policy |
| Exit 5 in PR mode | Publication failed; inspect report.publication and existing comments |
| TUI missing | Pipes, CI, explicit --format, --no-tui or RIO_TUI=0 disable it |
| Broken terminal glyphs | Use --ascii / RIO_ASCII=1; enlarge to at least 80×24 |
| Shallow/partial Git history | Fetch enough history/hydrate objects before selecting base |
| QA precondition_failed | Inspect app readiness, seed, blocked hosts and service doubles |
| QA sync exits 1 | Review changed source/guidance and update stale journeys |
| Invalid endpoint protocol | Upgrade paired CLI/Worker/runner versions |
| Cache permission/space | Inspect effective cache path in doctor; adjust user config |

## Does offline mean no process can use the network?

No. It prevents Rio requests, not project tools/plugins/tests. Use external isolation for that guarantee.

## Does an AI majority prove a bug?

No. Evidence tiers and actual artifacts govern conclusions. Council agreement does not promote an unsupported hypothesis.

## Why is my profile missing steps?

Lists replace inherited lists. Repeat every step you want to keep and validate dependencies.

## Can I use just the binary for documentation?

Yes: `rio docs`, `rio docs search "topic"`, then one topic/section. Evaluation harness scripts, unlike documentation, require the source checkout.

Continue with [Guides](guides.md), [Reference](reference.md), or [results](results.md).

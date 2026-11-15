# Start with Rio

Rio reviews Git changes and explains potential problems with evidence. It can run type checks, linters, tests for changed-code coverage, secret scanning and dependency checks on your machine. With your own endpoint, it can add AI review, independent verification, and PR integration. Browser QA runs with its own Docker and model prerequisites.

## Choose your first task

- [Review my local changes](review.md): the shortest path; no cloud account needed.
- [Add AI review](hosting.md): connect an existing endpoint or deploy one in your account.
- [Review a pull request with my team](github.md): install the GitHub App and choose publication policy.
- [Test an application in a browser](qa.md): configure synthetic data and user journeys.
- [Adjust what Rio checks](profiles.md): change coverage, exclusions, failure rules and budgets.

New machine? Begin with [installation](installation.md). Something failed? Use [troubleshooting](troubleshooting.md). Find every guide in [Guides](guides.md), and exact commands/settings in [Reference](reference.md).

## What runs where?

| Capability | Local CLI | Configured endpoint |
| --- | --- | --- |
| Typecheck, lint, secrets, coverage, graph | Yes, with project tools/dependencies | Isolated runner; missing dependencies may skip checks |
| Dependency vulnerability audit | OSV network access; cached records | May be skipped when analysis has no network |
| AI hypotheses and independent verification | Deferred without endpoint | Configured model routes and budgets |
| PR comments, history, suppression proposals | Endpoint required | GitHub App and appropriate policy |
| Browser QA | Docker/runtime/model prerequisites | Hosted verification and evidence transport |
| Embedded agent documentation | Always offline, no repository needed | Not needed |

`--offline` prevents Rio's own requests. It does **not** isolate project tools/tests from the network. [Privacy and cache](cache.md) explains data movement.

## Supported systems and current status

Release targets cover Linux (musl), macOS and Windows on x64/arm64. TypeScript, Python and Rust have built-in adapters. Browser QA requires a Docker host with firewall control; a Windows CLI binary does not imply every QA host configuration works. Consult each guide's prerequisites.

These pages describe the source revision shown below. Existing acceptance records do not establish a stable release pass; council's live A/B gate is still pending. Source implementation, published release availability and validated quality are different things. Check your `rio --version`; [embedded docs](docs.md) match that installed binary.

## Learn the vocabulary

A **profile** is review policy, an **endpoint** is your hosted coordinator, a **finding** is a reported issue, and **evidence** describes how strongly it was established. [Glossary](glossary.md) explains the rest.

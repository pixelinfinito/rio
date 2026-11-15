# Guides by task

Choose a task, then follow its prerequisites and next steps.

## Start

- [Install, update and remove Rio](installation.md) — Local setup: install, verify, update or remove Rio.
- [Your first local review](review.md) — Local: choose your changes and run a first review without an account.
- [Diagnose tools and readiness](doctor.md) — Local diagnostics, plus endpoint checks when configured.
- [Understand findings and reports](results.md) — All workflows: read evidence, incomplete checks and exit codes.
- [Use the interactive terminal](tui.md) — Terminal controls for selecting, inspecting and exporting results.

## Configure

- [Adjust checks with profiles](profiles.md) — Local configuration: select checks, inheritance and failure policy.
- [Configure your machine](configuration.md) — Machine settings, environment variables and precedence.
- [Steps, rules, adapters and schema fields](modules.md) — Reference: pipeline modules, adapters and complete schema tables.
- [Tune depth, time and model usage](budgets.md) — AI review: control depth, verification and model resource limits.
- [Choose model providers and routes](providers.md) — Needs an endpoint: configure provider credentials and model routes.

## Host and collaborate

- [Add AI review: connect or deploy](hosting.md) — AI setup: connect a team endpoint or deploy in your account.
- [Review pull requests with your team](github.md) — Needs endpoint + App: automatic PR reviews or a review from the CLI.
- [Respond to findings and follow history](feedback.md) — Needs endpoint: record feedback and follow findings across rounds.
- [Apply or decline suppression proposals](suppressions.md) — Needs endpoint: review proposals before writing repository policy.
- [Review security with evidence](security.md) — Hosted AI: select security catalogs and interpret evidence tiers.
- [Use the independent council](council.md) — Optional hosted AI: configure independent vendors and read partial results.

## Browser QA

- [Your first browser QA run](qa.md) — Needs Linux Docker + model access: prepare and run browser journeys.
- [Maintain journeys and owner guidance](qa-journeys.md) — QA: author, validate and synchronize user journeys and guidance.
- [Prepare synthetic data and service fixtures](qa-seeds.md) — QA: create synthetic data and restore isolated services/files.
- [Inspect QA evidence and UX recommendations](qa-evidence.md) — QA: inspect screenshots, DOM, traces and verification status.

## Operate and automate

- [Use Rio in CI and code scanning](ci.md) — Automation: choose formats, exit policy and code-scanning uploads.
- [Understand data, cache and offline behavior](cache.md) — All workflows: understand stored data and the limits of offline mode.
- [Give an agent documentation through the CLI](docs.md) — Always offline: give agents small, version-matched answers from the binary.
- [Evaluate Rio with labeled cases](evaluation.md) — Contributors: run labeled evaluations and understand pending quality gates.
- [Troubleshooting and frequently asked questions](troubleshooting.md) — Find the symptom, run a diagnostic, and choose a recovery step.
- [Glossary](glossary.md) — Explain profiles, endpoints, findings, evidence and other terms.
- [Maintain and publish documentation](maintenance.md) — Contributors: edit, translate, validate, capture and publish documentation.

Command option tables are generated from the CLI parser on each owning guide. Schema and module fields are under [Modules](modules.md). Internal `rio prepare` is runner-only and is not a normal user command.

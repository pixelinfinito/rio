# Proposal

## Why

Rio reviews code, so it cannot see the class of defects that only exist in a running interface: a form that submits but shows no confirmation, a modal that cannot be closed on a phone, a button with no hover or focus state, a regression that only appears after a redirect, or styling that reads as machine-generated (gradient hero backgrounds, cards with a colored left border, unstyled primitives beside a design system). Those defects ship through every static review today. This change adds a QA engine: Rio runs the application, an agent walks committed user journeys in a browser as the intended user on phone and desktop screens, and the result is evidence-backed findings about the changed part of the product or the whole product. It implements a new PRD requirement R32.

**Scope assumption.** Depends on the v0.2 endpoint, snapshot protocol, verifier quorum and self-hosted runner. Local runs and hosted runs both need a Docker host: locally the developer's daemon, hosted the self-hosted runner. The Cloudflare Sandbox backend cannot isolate the app from the model route and is opt-in with a visible label. The step is off in `rio/base` and on in a new `rio/qa` built-in profile. PR publishing depends on the GitHub App change (PRD R14); this change specifies only the QA-specific comment, check-run and convergence behavior. The finding-model and footer requirements compose with the in-flight convergence change.

## What Changes

- **Journeys are repository artifacts.** `.rio/qa/journeys/<name>.yaml` documents, validated by a new `schemas/journey-v1.json`, describe one end-to-end journey each: persona, preconditions, natural-language steps with expectations, success criteria, the routes and source globs it covers, and optionally the journeys it runs `after` or whether it `resets` to a clean seed. `rio qa init` generates the first set with the agent; `rio qa sync` proposes updates; both write files for the developer to review and commit.
- **A shipped agent skill.** `rio qa init` writes `.rio/qa/skills/rio-qa/SKILL.md`, registers it for Claude Code and for Codex through `AGENTS.md`, so any coding agent working in the repository can author or update journeys, seeds and fixtures in the format Rio executes.
- **A launch contract.** `.rio/qa.yaml` declares the app's packaging (a repository Dockerfile, a static directory or a vendored Node or Python app), start command, base URL, readiness probe, personas whose credentials are environment variable names, viewports, color schemes, harness and evidence settings. `rio qa init` detects defaults and asks the agent to fill gaps once. Rio never installs dependencies; Compose topologies are rejected with a named failure.
- **Seed data defined once, materialized once, restored before every chain.** `.rio/qa/seed/` holds a manifest, SQL and loader files, persona accounts and data paths; `rio qa init` has the agent author it, builds it, and captures the datastores and files as a content-addressed snapshot keyed by a fingerprint of definitions, migrations and image. Later runs restore it; persona credentials are re-applied after each restore so they never live in the snapshot.
- **Run fixtures beyond data.** `.rio/qa/fixtures/` declares upload files, doubles for external services (HTTP mocks with recordings and switchable behaviors, SMTP and SMS capture, webhook sinks, an OAuth provider, S3) including hostname claims with a run-generated certificate authority, and controlled time, timezone, locale, geolocation and network. Since the app has no egress, every dependency is doubled or reported as undoubled.
- **Every journey runs on several screen sizes, mobile first.** A named viewport matrix with real device emulation defaults to `mobile` and `desktop`, with `tablet` and others as presets; at least one mobile viewport is mandatory and a journey opts out only with a stated reason. The unit of execution is a chain of journeys in one cell, each cell starting from a restored seed. A journey passes only when it passes in every cell, and a `mobile/` probe family checks tap targets, viewport meta, input zoom, fixed overlays, offscreen content, truncation and hover-only affordances.
- **An enforced three-container pod.** Each run is `app` (repository code, datastores, doubles; no network), `browser` (Chromium; pod network only) and `controller` (Rio controller, Playwright MCP bridge, the harness, a budgeted model proxy and the evidence sink; the only container with an egress route, and it holds no repository checkout). Codex is the default harness with the developer's subscription locally or the Rio AI Gateway; pi is optional.
- **New step `rio/qa`** with options `enabled`, `mode`, `harness`, `baseline`, `max_journeys`, `max_defects`, `viewports`, `rules`, `sandbox` and its own `fail_on`, a `budget.<mode>.qa` block, verifier guardrails extended to QA, and `rio qa` as a standalone command running the QA subgraph.
- **Built-in UI quality ruleset** `modules/qa/rules/ui-v1.yaml` with written predicates for every probe, run-end minority tests for style probes, `info` severity unless a project adopts a rule, and agent-judged rules that always go through the verifier.
- **Evidence sanitized and stored outside the repository.** Traces are unpacked, redacted member by member and dropped when that fails; screenshots and video are masked at the DOM level; captured messages are redacted. Local runs store evidence in the cache; hosted runs stream it from the controller to the tenant's private store with signed one-object URLs and lifecycle expiry.
- **Findings use `finding-v1`** with category `ux`, a `qa` block, matrix cells as occurrences, a QA identity that ignores measurements and cells, and `new`, `pre-existing`, `fixed` and `worsened` derived cell by cell when `baseline` is on. Probe hits are `static_proven`; observations are hypotheses the verifier settles against artifacts, with a blind first turn and an optional deterministic replay whose non-recurrence is inconclusive.
- **Runner changes.** A `qa` job class with heartbeat leases, a QA base image, a separate seed object protocol and the pod on the Docker backend.
- **Report and PR publishing.** A QA section with a per-cell grid; inline comments on attributed lines, one edited summary comment, a neutral `rio/qa` check run, and auto-resolution that requires the cell to be re-run and the code to change.
- **Metrics in `eval/`:** precision and recall on a fixture app with seeded defects, noise on the clean fixture, cost and wall time per cell.

Nothing is breaking. profile-v1 gains the `rio/qa` step options and the `qa` budget block; finding-v1 gains category `ux`, the `qa` block and the `cell` occurrence key; report-v1 gains the `qa` object; module-v1 gains kind `ruleset`; `journey-v1`, `qa-config-v1`, `qa-seed-v1`, `qa-fixtures-v1` and `qa-replay-v1` are new.

## Capabilities

### New Capabilities
- `qa-journeys`: the journey document, chains, candidates, coverage declarations, generation and update commands, and the shipped agent skill.
- `qa-environment`: the launch contract, packaging, start order, personas, the three-container pod, egress policy, backend eligibility and harness credentials.
- `qa-seed-data`: seed definitions, datastores, fingerprint and reuse, credential re-apply, the snapshot storage protocol, safe extraction, generation on init and the seed commands.
- `qa-fixtures`: upload files, service doubles with host claims and TLS, captured messages, controlled context, per-step behaviors and fixture authoring on init.
- `qa-execution`: the step and command, selection, chains and cells, the matrix rule, the browser contract and tool set, outcomes, hypotheses, budgets, degradation, baseline and fork restriction.
- `qa-evidence`: evidence kinds, storage, text and trace sanitization, visual masking, linking and retention.
- `ui-quality-rules`: the ruleset module, probe collection and finalization, written predicates, the minority test, severity and adoption, judged rules and project overrides.
- `qa-publishing`: inline anchoring, the summary comment, embedded evidence, the check run, convergence with a QA re-assessment condition, and drift reporting.

### Modified Capabilities
- `review-profiles`: `rio/qa` options, the local execution subset, guardrails extended to QA, the `qa` budget block and the `rio/qa` built-in profile.
- `findings`: category `ux`, the `qa` block, cell occurrences, QA identity and attribution; composed with the convergence change.
- `review-report`: the QA section and grid, the footer, the run record and JSON; composed with the convergence change.
- `verifier-quorum`: browser artifacts as evidence, replay outcomes, the blind turn and the evidence pack for QA hypotheses.

## Impact

- **Code**: `rio-cli` (`rio qa` commands, `rio doctor`), `rio-core` (category, `qa` block, cells, renderers, publishable mapping), `rio-profile` (options, budgets, guardrail, built-in profile), `rio-engine` (local pod orchestration, DAG), new crate `rio-qa` (models, selection, probes, harness drivers, replay, evidence), `rio-runner` (`qa` job class, pod, heartbeats, seed protocol, replay), `worker/` (QA workflow step, run-scoped tokens, seed and evidence stores, signed URLs, D1 `qa_runs`), `worker/Dockerfile.qa`, `modules/steps/qa`, `modules/qa/rules`, `modules/qa/skill`, `modules/profiles/qa.yaml`, `eval/qa`, `tests/fixtures/qa-sample`.
- **Contracts**: new `schemas/journey-v1.json`, `qa-config-v1.json`, `qa-seed-v1.json`, `qa-fixtures-v1.json`, `qa-replay-v1.json`; additive changes to profile-v1, finding-v1, report-v1 and module-v1.
- **Network and data**: only the controller has egress, to the gateway and the upload endpoints; the app reaches nothing. Test credentials are environment variables named in the repository and supplied at run time. Evidence and seeds hold synthetic application data and live in the private cache or tenant store.
- **Cost**: bounded per cell and per run by the `qa` budget block, with the cell count and an estimate in the plan; a changed-mode run on a typical PR runs the smoke chain plus the chains the change touches in two viewports.

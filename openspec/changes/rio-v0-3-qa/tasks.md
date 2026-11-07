# Tasks

## 0. Contracts and schemas

- [ ] 0.1 Add `schemas/journey-v1.json`, `qa-config-v1.json`, `qa-seed-v1.json`, `qa-fixtures-v1.json` and `qa-replay-v1.json`; verify schema tests that every valid example in the spec scenarios passes and the unknown-key, literal-credential, missing-coverage, `after` cycle and oversized-file cases fail
- [ ] 0.2 Extend `schemas/module-v1.json` with kind `ruleset` (rule `id`, `kind`, `category`, `severity`, `eligible`, `measure`, `threshold`, `exclude`, `scope`); verify existing manifests still validate
- [ ] 0.3 Extend `schemas/finding-v1.json` with category `ux`, the `qa` block bound to `ux`, and the `cell` and `evidence` keys on occurrences; extend `schemas/report-v1.json` with the `qa` object and cell schema; verify snapshot tests on existing fixtures and a new QA fixture, including rejection of `ux` without `qa` and `defect` with `qa`
- [ ] 0.4 Extend `schemas/profile-v1.json` with `budget.<mode>.qa` and `rio-profile` with its defaults, the deadline composition and the guardrail for `rio/qa`; verify tests for "Deadline extended by QA", "Unknown QA budget key rejected" and "QA requires verification"
- [ ] 0.5 Compose the finding-model and footer replacements with the convergence change: whichever change archives second carries both; verify a documentation test diffs both deltas against the main spec and fails if either loses the other's additions
- [ ] 0.6 Add `modules/steps/qa/module.yaml` (`rio/qa@0.1.0`, needs `graph`, inputs and outputs per the qa-execution spec, option schema per the review-profiles delta); verify `rio profile validate` rejects `harness: claude` and `viewports: [desktop, wide]`
- [ ] 0.7 Add `modules/qa/rules/ui-v1.yaml` with every probe and judged rule, predicates, thresholds and scopes; verify it loads as a `ruleset` with unique ids and every predicate named in the spec is present
- [ ] 0.8 Add `modules/qa/skill/SKILL.md` with a version marker; verify a test checks every rule id it mentions exists in the ruleset
- [ ] 0.9 Add `modules/profiles/qa.yaml` and the disabled `rio/qa` step with its wiring to `modules/profiles/base.yaml`; verify `rio profile show rio/qa` shows `verify` needing `qa` and `rio/base` shows QA disabled; regenerate `docs/profiles.md`

## 1. Fixture app, controller skeleton and images

- [ ] 1.1 Add `tests/fixtures/qa-sample`: a Vite app with a SQLite-backed API, `Dockerfile.qa` provisioning it, a committed `.rio/qa.yaml`, `.rio/qa/seed/` (schema, shopper and admin accounts with apply commands, products, one saved address), `.rio/qa/fixtures/` (payments `http-mock` with `approve` and `decline` and a claim on a fake provider host, mail capture, one generated CSV upload), journeys for login, registration with email verification (`resets: true`), add-to-cart and checkout (`after`), and a `defects.json` toggle for seeded defects (disabled save button, missing confirmation, gradient hero, accent-border cards, raw primitive, low contrast in dark mode, console error, fixed banner over the pay button on phones, 28 px icon buttons, 14 px email input, hover-only menu); verify the image builds and the clean build serves every flow
- [ ] 1.2 Add `worker/Dockerfile.qa` (QA base image: Chromium via Playwright, `@playwright/mcp`, codex CLI, pi, datastore client tools, the entrypoint that writes host claims and the run CA before dropping privileges); verify it builds in CI and `rio-runner qa --self-test` serves a bundled static page and runs one step
- [ ] 1.3 Add the Node controller package under `crates/rio-qa/controller/` with Chromium launch (tracing, console, network, CDP), the restricted `@playwright/mcp` bridge and Rio's MCP server stubs; verify a Playwright test against the fixture app that each tool is listed and no shell tool exists
- [ ] 1.4 Create `crates/rio-qa` with the journey, contract, seed and fixture models, loading and semantic validation (persona exists, stale globs, credential-looking steps, `after` cycles, mobile mandatory, `desktop_only` reason); verify unit tests for every validation scenario in qa-journeys and qa-environment

## 2. Pod runtime and isolation

- [ ] 2.1 Implement the pod on the Docker backend in `rio-runner`: three containers, internal network for `app` and `browser`, controller network with host-enforced egress to the gateway and upload hosts, snapshot materialization into `app`, teardown on timeout and interruption; verify integration tests for "Repository code cannot reach the model route", "App egress blocked behaviorally", "Controller egress limited", "Harness container holds no source" and "Interrupted run"
- [ ] 2.2 Implement the model proxy in the controller with run-scoped token, per-cell token budget and usage records, plus the local keychain-backed variant; verify tests that the budget cuts off a cell and no provider key appears in any container environment
- [ ] 2.3 Implement `harness.auth` resolution (`auto`, `subscription` Docker-only read-only mount into `controller`, `gateway`) and `rio doctor` lines; verify tests for "Local subscription reuse" and that `subscription` is refused hosted and in the Sandbox
- [ ] 2.4 Implement the `qa` job class: protocol fields, heartbeat leases every 60 s replacing the bounded wait, evidence and seed sinks, the Sandbox `sandbox: allow` path with its labels and `no_runtime` deferral otherwise; verify Worker tests for lease renewal, "Sandbox without opt-in" and "Sandbox with opt-in"
- [ ] 2.5 Implement start order inside `app` (datastores with `ready`, seed restore, credential apply, doubles, app, readiness, `app.seed` hook) with named failures; verify tests for "App never listens", "Datastore never ready" and "Compose rejected"
- [ ] 2.6 Implement the local no-endpoint path in `rio-engine` (image verification, pod, `no_runtime`); verify "QA runs locally with Docker" and "Docker unavailable locally"
- [ ] 2.7 Document the pod, egress policy, backend eligibility and self-hosted setup in `docs/cloudflare.md`; verify the documented commands run against the fixture app

## 3. Seed data and fixtures

- [ ] 3.1 Implement the fingerprint, `rio qa seed status`, datastore adapters (`sqlite`, `postgres`, `mysql`, `redis`, `files`, `custom`) with start, ready, capture and restore; verify round-trip tests per kind in the fixture image and "Missing server binary"
- [ ] 3.2 Implement credential re-apply after restore and `seed.cache_version`; verify "Password rotated"
- [ ] 3.3 Implement the seed object protocol: per-archive parts with hashes, atomic manifest, quotas, safe extraction, leased pruning, local and hosted stores; verify "One datastore changes", "Size cap", "Interrupted upload", "Hash mismatch" and that an unchanged archive is not re-uploaded
- [ ] 3.4 Implement restore before every chain and `resets` as chain heads; verify "Registration in every cell" and "Shared state in order"
- [ ] 3.5 Implement generated upload files, `http-mock` with recordings and behaviors, `smtp-capture`, `sms-capture`, `webhook-sink`, `oauth-provider`, `s3`, `custom`, host claims with the run CA, `blocked_egress` and `tls_pinned` logging; verify "Payment double by URL", "Hard-coded provider host", "Pinned certificate", "Undoubled dependency", "Registration verification link" and "Decline then approve"
- [ ] 3.6 Implement controlled context (clock, timezone, locale, geolocation, network) as replay events; verify "Offline step" and "Fixed time"
- [ ] 3.7 Document seeds and fixtures in `docs/qa.md` with Postgres, SQLite, payments-double and mail-capture examples; verify the examples validate and run against the fixture app

## 4. Browser recorder, matrix, probes and evidence

- [ ] 4.1 Implement step-boundary capture, the replay event log (`qa-replay-v1`) covering Playwright actions and Rio tools, and `rio-runner qa replay --until` with outcomes `recurred`, `not_recurred`, `prerequisites_failed`; verify a replay of the fixture checkout chain reproduces the seeded defect and a broken prerequisite yields `prerequisites_failed`
- [ ] 4.2 Implement the viewport matrix: presets, custom entries, device-emulated contexts per cell, mobile-first ordering, chain × cell execution, orientation switch; verify "Mobile emulation is real emulation", "Mobile runs first", "Orientation change in a step" and "Mobile-only failure"
- [ ] 4.3 Implement the probe script with every written predicate, candidate collection, step and run scopes, the minority test with ratio and `min_sample`, mobile gating, and severity by adoption; verify fixture pages trigger each probe exactly as the ui-quality-rules scenarios state, including "Consistent gradients", "Too few elements", "Run-scoped probe finalized once" and "Not adopted"
- [ ] 4.4 Implement text sanitization, member-level trace sanitization with fail-closed drop, DOM-level masking, the evidence manifest and the `evidence_bytes` quota; verify "Token in a response body", "Trace member redacted", "Unparseable member", "Masked video", "Evidence quota" and a seeded-secret scan of a full bundle
- [ ] 4.5 Implement finding construction: QA identity, cell occurrences, state derivation including `worsened`, attribution order, hypotheses with structured fields and evidence-required drop; verify "QA identity ignores measurements and cells", "Two cells, one finding", "Worsened across cells", "Ambiguous text match", "Stack trace wins over text" and "Unsupported observation dropped"

## 5. Harness drivers and authoring

- [ ] 5.1 Implement the `Harness` trait, the codex driver and the pi driver with per-run configuration, MCP wiring and transcript normalization; verify a stub-MCP test for each that the config holds no secret and "Same evidence for both harnesses"
- [ ] 5.2 Implement the Rio MCP tools (`login`, viewport and scheme, `upload_fixture`, `read_mail`, `read_sms`, `read_webhooks`, `set_service_behavior`, `set_network`, `set_geolocation`, `step_done`, `observe`) and per-cell retry on harness crash; verify "Credentials outside the prompt", "Fixture upload", "Shell tool denied" and "Harness crash"
- [ ] 5.3 Implement author mode for `rio qa init` (contract detection, seed and fixture authoring with dependency detection, seed build, journey generation with `write_journey`, `resets` inference, candidates, `--force`) and `rio qa sync`; verify "Init builds the seed first", "Stripe detected", "First generation", "Existing journey preserved", "Proposed update" and "Check mode in CI" with a scripted harness stub
- [ ] 5.4 Implement skill installation and refresh; verify "Skill registered for two harnesses", "Edited skill preserved" and "User text outside the fence survives"

## 6. Worker, verifier and selection

- [ ] 6.1 Add the QA workflow step: run-scoped token mint and revoke, presigned evidence and seed targets, dispatch, consume outcomes, `qa_runs` migration; verify Worker tests for token scope, budget, revocation and partial results after cancellation
- [ ] 6.2 Implement signed one-object read URLs, the lifecycle rule from `evidence.retention_days` in `rio init`, and `rio qa evidence prune`; verify "Markdown with hosted evidence", "Expired evidence" and prune
- [ ] 6.3 Extend `rio/verify` with the QA blind turn and blind match, the second-turn evidence pack, browser artifacts as `reproduced`, probe results as `static_proven`, replay on request with one-per-hypothesis and `replay_wall`, non-recurrence as inconclusive, refutation from original evidence; verify "Blind rediscovery on a journey-attributed finding", "Browser trace supports reproduced", "Non-recurrence is not a refutation", "Refutation from the original evidence", "Replay recurs", "Prerequisites fail", "Second replay refused" and "Transcript prose excluded"
- [ ] 6.4 Implement changed-mode selection (diff, graph delta, `routes_from` conventions and map, `after` pull-in), the cap by chains, cell count and estimate, and the exploratory pass; verify "Graph expansion selects a journey", "Dependency pulled in", "Nothing matches", "Cap keeps smoke" and "New page without a journey"
- [ ] 6.5 Implement the QA fail policy pool with severity floor and adoption; verify "QA policy independent of general cap", "Adopted" and that `unclassified` or `info` QA findings do not match the default policy

## 7. CLI and report

- [ ] 7.1 Add `rio qa` with subcommands `init`, `sync`, `list`, `validate`, `show`, `rules`, `seed`, `fixtures`, `evidence prune` and the run form with its flags and the standalone subgraph; verify `assert_cmd` tests for each and "Standalone run on a working tree"
- [ ] 7.2 Add the QA section with the per-cell grid, unverified observations, footer lines, run record files and the JSON `qa` object to `rio-core` renderers; verify snapshot tests for "QA section with a failed journey", "Unverified observations labeled", "QA footer", "Local record is complete", "Hosted record carries keys only" and "JSON validates with QA"
- [ ] 7.3 Implement `baseline: true` as a second pod on base with cell-by-cell matching; verify "Regression classified", "Worsened across cells" and "Attribution without baseline"
- [ ] 7.4 Update `README.md` with the QA quick start and `docs/PRD.md` with requirement R32; verify the README commands run as written

## 7a. PR publishing (gated on the GitHub App change)

- [ ] 7a.1 Implement the publishable mapping (inline at line, first hunk, summary for unchanged files and journey attribution, one comment per finding with cells); verify "Attributed to a changed line", "Attributed outside the diff hunks", "Attributed to an unchanged file" and "Journey-only attribution"
- [ ] 7a.2 Implement the summary comment body and edit-in-place keying; verify a snapshot and "Second round edits the summary"
- [ ] 7a.3 Implement the `rio/qa` check run; verify "Journeys failed, policy not matched" and "Policy matched"
- [ ] 7a.4 Wire QA identities into lineage, never-re-post, the QA re-assessment condition for auto-resolution and `/rio dismiss`; verify "Journey fixed on the next round", "Cell not re-run", "Passed but unchanged code" and "Dismissed as intentional"
- [ ] 7a.5 Return the transport error for `rio qa --publish` until the GitHub App change lands and document publishing in `docs/qa.md`; verify "No PR transport"

## 8. Evaluation and integration

- [ ] 8.1 Add `eval/qa/` with labeled cases per seeded defect, a clean-run noise case and metrics (precision, recall, cost and wall time per cell); verify `python3 eval/qa/run.py --local` reports the seeded defects found and the clean run's noise count
- [ ] 8.2 Run the fixture app end to end locally with codex and with pi and record results in `docs/evaluation/v0.3-qa-local.md`; verify the document lists every seeded defect with its finding id or a stated miss
- [ ] 8.3 Run `cargo test --workspace`, the Worker test suite and the controller tests; verify all pass
- [ ] 8.4 Run `rio review --profile rio/qa` on the fixture repository with a change that breaks the checkout confirmation, with and without an endpoint; verify the hosted report has a verified `reproduced` finding with two cell occurrences and the local report lists the same observation as unverified

## Workflow follow-up

- Archive the change after the project's review requirements are satisfied, composing with the convergence change per task 0.5.
- Verify the archived result.

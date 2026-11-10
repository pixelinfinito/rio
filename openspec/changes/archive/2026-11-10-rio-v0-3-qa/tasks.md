# Tasks

The owner-guided UX work in section 8a is part of the core implementation. Complete 8a.1 with section 0, 8a.2–8a.5 with authoring and execution, 8a.6 with verification, 8a.7 with reporting and publishing, and 8a.8 before the final evaluation in section 8.

## 0. Contracts and schemas

- [x] 0.1 Add `schemas/journey-v1.json`, `qa-config-v1.json`, `qa-seed-v1.json`, `qa-fixtures-v1.json` and `qa-replay-v1.json`; verify schema tests that every valid example in the spec scenarios passes and the unknown-key, literal-credential, missing-coverage, `after` cycle and oversized-file cases fail
- [x] 0.2 Extend `schemas/module-v1.json` with kind `ruleset` (rule `id`, `kind`, `category`, `severity`, `eligible`, `measure`, `threshold`, `exclude`, `scope`, plus judged-criterion source/version, applicability, required evidence and examples); verify existing manifests still validate
- [x] 0.3 Extend `schemas/finding-v1.json` with category `ux`, the `qa` block bound to `ux`, and the `cell` and `evidence` keys on occurrences; extend `schemas/report-v1.json` with the `qa` object and cell schema; verify snapshot tests on existing fixtures and a new QA fixture, including rejection of `ux` without `qa` and `defect` with `qa`
- [x] 0.4 Extend `schemas/profile-v1.json` with `budget.<mode>.qa` and `rio-profile` with its defaults, the deadline composition and the guardrail for `rio/qa`; verify tests for "Deadline extended by QA", "Unknown QA budget key rejected" and "QA requires verification"
- [x] 0.5 Compose the finding-model and footer replacements with the convergence change: whichever change archives second carries both; verify a documentation test diffs both deltas against the main spec and fails if either loses the other's additions
- [x] 0.6 Add `modules/steps/qa/module.yaml` (`rio/qa@0.1.0`, needs `graph`, inputs and outputs per the qa-execution spec, option schema per the review-profiles delta); verify `rio profile validate` rejects `harness: claude` and `viewports: [desktop, wide]`
- [x] 0.7 Add `modules/qa/rules/ui-v1.yaml` with every probe and judged rule, predicates, thresholds and scopes; verify it loads as a `ruleset` with unique ids and every predicate named in the spec is present
- [x] 0.8 Add `modules/qa/skill/SKILL.md` with a version marker; verify a test checks every rule id it mentions exists in the ruleset
- [x] 0.9 Add `modules/profiles/qa.yaml` and the disabled `rio/qa` step with its wiring to `modules/profiles/base.yaml`; verify `rio profile show rio/qa` shows `verify` needing `qa` and `rio/base` shows QA disabled; regenerate `docs/profiles.md`

## 1. Fixture app, controller skeleton and images

- [x] 1.1 Add `tests/fixtures/qa-sample`: a Vite app with a SQLite-backed API, `Dockerfile.qa` provisioning it, a committed `.rio/qa.yaml`, `.rio/qa/seed/` (schema, shopper and admin accounts with apply commands, products, one saved address), `.rio/qa/fixtures/` (payments `http-mock` with `approve` and `decline` and a claim on a fake provider host, mail capture, one generated CSV upload), journeys for login, registration with email verification (`resets: true`), add-to-cart and checkout (`after`), and a `defects.json` toggle for seeded defects (disabled save button, missing confirmation, gradient hero, accent-border cards, raw primitive, low contrast in dark mode, console error, fixed banner over the pay button on phones, 28 px icon buttons, 14 px email input, hover-only menu); verify the image builds and the clean build serves every flow
- [x] 1.2 Add `worker/Dockerfile.qa` (QA base image: Chromium via Playwright, `@playwright/mcp`, codex CLI, pi, datastore client tools, the entrypoint that writes host claims and the run CA before dropping privileges); verify it builds in CI and `rio-runner qa --self-test` serves a bundled static page and runs one step
- [x] 1.3 Add the Node controller package under `crates/rio-qa/controller/` with Chromium launch (tracing, console, network, CDP), the restricted `@playwright/mcp` bridge and Rio's MCP server stubs; verify a Playwright test against the fixture app that each tool is listed and no shell tool exists
- [x] 1.4 Create `crates/rio-qa` with the journey, contract, seed and fixture models, loading and semantic validation (persona exists, stale globs, credential-looking steps, `after` cycles, mobile mandatory, `desktop_only` reason); verify unit tests for every validation scenario in qa-journeys and qa-environment

## 2. Pod runtime and isolation

- [x] 2.1 Implement the pod on the Docker backend in `rio-runner`: three containers, internal network for `app` and `browser`, controller network with host-enforced egress to the gateway and upload hosts, snapshot materialization into `app`, teardown on timeout and interruption; verify integration tests for "Repository code cannot reach the model route", "App egress blocked behaviorally", "Controller egress limited", "Harness container holds no source" and "Interrupted run"
- [x] 2.2 Implement the model proxy in the controller with run-scoped token, per-cell token budget and usage records, plus the local keychain-backed variant; verify tests that the budget cuts off a cell and no provider key appears in any container environment
- [x] 2.3 Implement `harness.auth` resolution (`auto`, `subscription` Docker-only read-only mount into `controller`, `gateway`) and `rio doctor` lines; verify tests for "Local subscription reuse" and that `subscription` is refused hosted and in the Sandbox
- [x] 2.4 Implement the `qa` job class: protocol fields, heartbeat leases every 60 s replacing the bounded wait, evidence and seed sinks, the Sandbox `sandbox: allow` path for provisioned static/vendored apps with its labels, `no_runtime`/`unsupported_packaging` deferral for Dockerfile apps, and `no_runtime` without opt-in; verify Worker tests for lease renewal, "Sandbox without opt-in" and "Sandbox with opt-in"
  - Verified: Worker authorization/lease/cancellation tests and five deployment-image integration tests for static and vendored browser execution, Dockerfile deferral, missing dependencies, and cancellation with descendant cleanup. Platform networking is covered by the Worker interceptor tests; local runtime tests use an isolated storage double.
- [x] 2.5 Implement start order inside `app` (datastores with `ready`, seed restore, credential apply, doubles, app, readiness, `app.seed` hook) with named failures; verify tests for "App never listens", "Datastore never ready" and "Compose rejected"
- [x] 2.6 Implement the local no-endpoint path in `rio-engine` (image verification, pod, `no_runtime`); verify "QA runs locally with Docker" and "Docker unavailable locally"
- [x] 2.7 Document the pod, egress policy, backend eligibility and self-hosted setup in `docs/cloudflare.md`; verify the documented commands run against the fixture app

## 3. Seed data and fixtures

- [x] 3.1 Implement the fingerprint, `rio qa seed status`, datastore adapters (`sqlite`, `postgres`, `mysql`, `redis`, `files`, `custom`) with start, ready, capture and restore; verify round-trip tests per kind in the fixture image and "Missing server binary"
- [x] 3.2 Implement credential re-apply after restore and `seed.cache_version`; verify "Password rotated"
- [x] 3.3 Implement the seed object protocol: per-archive parts with hashes, atomic manifest, quotas, safe extraction, leased pruning, local and hosted stores; verify "One datastore changes", "Size cap", "Interrupted upload", "Hash mismatch" and that an unchanged archive is not re-uploaded
- [x] 3.4 Implement restore before every chain and `resets` as chain heads; verify "Registration in every cell" and "Shared state in order"
- [x] 3.5 Implement generated upload files, `http-mock` with recordings and behaviors, `smtp-capture`, `sms-capture`, `webhook-sink`, `oauth-provider`, `s3`, `custom`, host claims with the run CA, `blocked_egress` and `tls_pinned` logging; verify "Payment double by URL", "Hard-coded provider host", "Pinned certificate", "Undoubled dependency", "Registration verification link" and "Decline then approve"
- [x] 3.6 Implement controlled context (clock, timezone, locale, geolocation, network) as replay events; verify "Offline step" and "Fixed time"
- [x] 3.7 Document seeds and fixtures in `docs/qa.md` with Postgres, SQLite, payments-double and mail-capture examples; verify the examples validate and run against the fixture app

## 4. Browser recorder, matrix, probes and evidence

- [x] 4.1 Implement step-boundary capture, the replay event log (`qa-replay-v1`) covering Playwright actions and Rio tools, and `rio-runner qa replay --until` with outcomes `recurred`, `not_recurred`, `prerequisites_failed`; verify a replay of the fixture checkout chain reproduces the seeded defect and a broken prerequisite yields `prerequisites_failed`
- [x] 4.2 Implement the viewport matrix: presets, custom entries, device-emulated contexts per cell, mobile-first ordering, chain × cell execution, orientation switch; verify "Mobile emulation is real emulation", "Mobile runs first", "Orientation change in a step" and "Mobile-only failure"
- [x] 4.3 Implement the probe script with every written predicate, candidate collection, step and run scopes, the minority test with ratio and `min_sample`, mobile gating, and severity by adoption; verify fixture pages trigger each probe exactly as the ui-quality-rules scenarios state, including "Consistent gradients", "Too few elements", "Run-scoped probe finalized once" and "Not adopted"
- [x] 4.4 Implement text sanitization, member-level trace sanitization with fail-closed drop, DOM-level masking, the evidence manifest and the `evidence_bytes` quota; verify "Token in a response body", "Trace member redacted", "Unparseable member", "Masked video", "Evidence quota" and a seeded-secret scan of a full bundle
- [x] 4.5 Implement finding construction: QA identity, cell occurrences, state derivation including `worsened`, attribution order, hypotheses with structured fields and evidence-required drop; verify "QA identity ignores measurements and cells", "Two cells, one finding", "Worsened across cells", "Ambiguous text match", "Stack trace wins over text" and "Unsupported observation dropped"

## 5. Harness drivers and authoring

- [x] 5.1 Implement the `Harness` trait, the codex driver and the pi driver with per-run configuration, MCP wiring and transcript normalization; verify a stub-MCP test for each that the config holds no secret and "Same evidence for both harnesses"
- [x] 5.2 Implement the Rio MCP tools (`login`, viewport and scheme, `upload_fixture`, `read_mail`, `read_sms`, `read_webhooks`, `set_service_behavior`, `set_network`, `set_geolocation`, `step_done`, `observe`) and per-cell retry on harness crash; verify "Credentials outside the prompt", "Fixture upload", "Shell tool denied" and "Harness crash"
- [x] 5.3 Implement author mode for `rio qa init` (contract detection, seed and fixture authoring with dependency detection, seed build, journey generation with `write_journey`, `resets` inference, candidates, `--force`) and `rio qa sync`; verify "Init builds the seed first", "Stripe detected", "First generation", "Existing journey preserved", "Proposed update" and "Check mode in CI" with a scripted harness stub
  - Verified: scripted Docker acceptance covers metadata-based seed/fixture generation, two personas, preserved/forced journeys, fallback-contract confirmation, and failed-first-start dependency recovery before journey generation. Shared budgets, append-only service updates, concurrent edits, and remaining undoubled summaries have targeted coverage.
- [x] 5.4 Implement skill installation and refresh; verify "Skill registered for two harnesses", "Edited skill preserved" and "User text outside the fence survives"

## 6. Worker, verifier and selection

- [x] 6.1 Add the QA workflow step: run-scoped token mint and revoke, presigned evidence and seed targets, dispatch, consume outcomes, `qa_runs` migration; verify Worker tests for token scope, budget, revocation and partial results after cancellation
- [x] 6.2 Implement signed one-object read URLs, scheduled deletion at each run's `evidence.retention_days` expiry with schedule registration in `rio init` and `rio deploy`, and `rio qa evidence prune`; verify "Markdown with hosted evidence", "Expired evidence" and prune
- [x] 6.3 Extend `rio/verify` with the QA blind turn and blind match, the second-turn evidence pack, browser artifacts as `reproduced`, probe results as `static_proven`, replay on request with one-per-hypothesis and `replay_wall`, non-recurrence as inconclusive, refutation from original evidence; verify "Blind rediscovery on a journey-attributed finding", "Browser trace supports reproduced", "Non-recurrence is not a refutation", "Refutation from the original evidence", "Replay recurs", "Prerequisites fail", "Second replay refused" and "Transcript prose excluded"
- [x] 6.4 Implement changed-mode selection (diff, graph delta, `routes_from` conventions and map, `after` pull-in), the cap by chains, cell count and estimate, and the exploratory pass; verify "Graph expansion selects a journey", "Dependency pulled in", "Nothing matches", "Cap keeps smoke" and "New page without a journey"
- [x] 6.5 Implement the QA fail policy pool with severity floor and adoption; verify "QA policy independent of general cap", "Adopted" and that `unclassified` or `info` QA findings do not match the default policy

## 7. CLI and report

- [x] 7.1 Add `rio qa` with subcommands `init`, `sync`, `list`, `validate`, `show`, `rules`, `seed`, `fixtures`, `evidence prune` and the run form with its flags and the standalone subgraph; verify `assert_cmd` tests for each and "Standalone run on a working tree"
- [x] 7.2 Add the QA section with the per-cell grid, unverified observations, footer lines, run record files and the JSON `qa` object to `rio-core` renderers; verify snapshot tests for "QA section with a failed journey", "Unverified observations labeled", "QA footer", "Local record is complete", "Hosted record carries keys only" and "JSON validates with QA"
- [x] 7.3 Implement `baseline: true` as a second pod on base with cell-by-cell matching; verify "Regression classified", "Worsened across cells" and "Attribution without baseline"
- [x] 7.4 Update `README.md` with the QA quick start and `docs/PRD.md` with requirement R32; verify the README commands run as written
  - Verified: real Docker CLI acceptance executes validate, seed build, init, full QA, checkout baseline comparison and sync check; the intentionally changed covered source correctly produces sync exit 1.

## 7a. PR publishing (gated on the GitHub App change)

- [x] 7a.1 Implement the publishable mapping (inline at line, first hunk, summary for unchanged files and journey attribution, one comment per finding with cells); verify "Attributed to a changed line", "Attributed outside the diff hunks", "Attributed to an unchanged file" and "Journey-only attribution"
- [x] 7a.2 Implement the summary comment body and edit-in-place keying; verify a snapshot and "Second round edits the summary"
- [x] 7a.3 Implement the `rio/qa` check run; verify "Journeys failed, policy not matched" and "Policy matched"
- [x] 7a.4 Wire QA identities into lineage, never-re-post, the QA re-assessment condition for auto-resolution and `/rio dismiss`; verify "Journey fixed on the next round", "Cell not re-run", "Passed but unchanged code" and "Dismissed as intentional"
- [x] 7a.5 Return the transport error for `rio qa --publish` until the GitHub App change lands and document publishing in `docs/qa.md`; verify "No PR transport"

## 8. Evaluation and integration

- [x] 8.1 Add `eval/qa/` with labeled cases per seeded defect, a clean-run noise case and metrics (precision, recall, cost and wall time per cell); verify `python3 eval/qa/run.py --local` reports the seeded defects found and the clean run's noise count
- [x] 8.2 Run the fixture app end to end locally with codex and with pi and record results in `docs/evaluation/v0.3-qa-local.md`; verify the document lists every seeded defect with its finding id or a stated miss
  - Verified: all 18 cases were attempted with both harnesses; 36 selected reports and their hashes, coverage, findings/misses and per-chain/cell costs are recorded in `docs/evaluation/v0.3-qa-matrix-summary.json`. All broad reports are partial: Codex matched 1/11 seeded defect cases and Pi 4/11; clean-flow noise was 0/3 with only 4/1 completed journey/cells. Five reports have zero completed outcomes. These tasks complete evaluation and documentation, not a full-matrix quality pass. All 107 evaluation tests and final report/metric consistency checks passed. Focused UX and hosted/local acceptance remain separately scoped below.
- [x] 8.3 Run `cargo test --workspace`, the Worker test suite and the controller tests; verify all pass
- [x] 8.4 Run `rio review --profile rio/qa` on the fixture repository with a change that breaks the checkout confirmation, with and without an endpoint; verify the hosted report has a verified `reproduced` finding with two cell occurrences and the local report lists the same observation as unverified

  - Verified: hosted review `5f51198a-ac1e-4b7a-b188-ecbdbfe287f4` merged the checkout failure into one reproduced finding with mobile/light and desktop/light occurrences; all six QA votes reproduced it. Local run `01M709S7NR6NYPHC43TJHX6WGX` on the same snapshot retains the identical host ID as two unverified observations. The overall hosted report separately records an offline dependency audit. See `docs/evaluation/v0.3-qa-hosted-summary.json`.

## 8a. Owner-guided UX acceptance

- [x] 8a.1 Extend journey, report and profile contracts for goal, guidance references, UX criteria, recommendations, assessment coverage and `max_recommendations`; keep old journeys valid and test recommendation/defect separation and independent caps
- [x] 8a.2 Extend immutable guidance collection and delivery to init, sync, execution and both verifier turns using journey source coverage and route mappings; test nested scope, unrelated exclusion, empty-diff full/explicit runs, initial generation without journeys, exploratory route scope, unknown-route root fallback, absent guidance, deletion and snapshot immutability
- [x] 8a.3 Implement guidance-based selection and stale-journey checks; test guidance-only changes, incompatible expectations and preservation of tool, budget and publishing boundaries
- [x] 8a.4 Extend the built-in ruleset and shipped authoring skill with the versioned UX rubric, evidence requirements, principle references and exceptions; test guidance-driven recovery journeys and that observed behavior does not become the sole expected behavior
- [x] 8a.5 Implement assessment coverage and structured recommendation candidates during passing and failing journeys; test duplicate-entry friction, evidence-free advice rejection, coverage under budget exhaustion and no automatic journey failure from a recommendation
- [x] 8a.6 Implement recommendation verification, stable identity, ranking, deduplication with findings and persistent dismissal; test supported/rejected/inconclusive/unverified outcomes, split and failed votes, supported-first capacity, and that verified friction does not prove proposed benefit
- [x] 8a.7 Extend terminal, Markdown, JSON, run records and the existing PR summary with recommendations and coverage; test local unverified labels, recommendation-only neutral checks, held-back counts and no inline defect annotations for recommendations
- [x] 8a.8 Extend fixture evaluation with successful but cumbersome checkout, ambiguous next actions, recoverable error with lost input, missing cancel/undo, keyboard/focus barriers, intentional brand styling and a clean flow; assess guidance adherence, recommendation relevance/actionability and unsupported-benefit claims independently of defect precision/recall

  - Verified: all seven UX scenarios ran in focused mobile/light acceptance; both emitted recommendations have owner labels (2/2/2, no unsupported-benefit claim), recorded by immutable run/id. Clean and intentional-brand each retain seven informational spacing findings as noise. Full-matrix Codex/Pi results remain tracked separately by 8.1–8.2. See `docs/evaluation/v0.3-qa-focused-ux-summary.json`.

## Workflow follow-up

- Archive the change after the project's review requirements are satisfied, composing with the convergence change per task 0.5.
- Verify the archived result.

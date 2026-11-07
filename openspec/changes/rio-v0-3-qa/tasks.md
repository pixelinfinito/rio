# Tasks

## 1. Contracts and schemas

- [ ] 1.1 Add `schemas/journey-v1.json` and `schemas/qa-config-v1.json` with the keys from the qa-journeys and qa-environment specs; verify with schema tests that the valid examples in the spec scenarios pass and the unknown-key, literal-credential and missing-coverage cases fail
- [ ] 1.2 Extend `schemas/module-v1.json` with kind `ruleset` (rule `id`, `kind`, `category`, `severity`, `description`, probe `predicate` and `threshold`) and verify the existing adapter and step manifests still validate
- [ ] 1.3 Extend `schemas/finding-v1.json` with category `ux` and the optional `qa` block, and `schemas/report-v1.json` with the optional `qa` object; verify with the schema snapshot tests that existing report fixtures still validate and a QA fixture validates
- [ ] 1.4 Add `modules/steps/qa/module.yaml` (`rio/qa@0.1.0`, `local: true`, inputs snapshot, graph, journeys, qa_config; outputs journey_outcomes, hypotheses, evidence) with the option schema from the review-profiles delta, and verify `rio profile validate` rejects `harness: claude` naming the allowed values
- [ ] 1.5 Add `modules/qa/rules/ui-v1.yaml` with every probe and judged rule named in the ui-quality-rules spec, thresholds and minority ratios; verify it loads as a `ruleset` module with unique ids
- [ ] 1.6 Add `modules/qa/skill/SKILL.md` (journey schema, coverage rules, evidence expectations, rule ids, `write_journey` usage) with a version marker; verify a documentation test checks every rule id it mentions exists in the ruleset
- [ ] 1.7 Add `modules/profiles/qa.yaml` extending `rio/base`, and add the disabled `rio/qa` step to `modules/profiles/base.yaml`; verify `rio profile show rio/qa` resolves the budgets and `rio profile show rio/base` shows QA disabled; regenerate `docs/profiles.md`

## 2. rio-qa crate: journeys, contract and selection

- [ ] 2.1 Create `crates/rio-qa` with the journey and contract models, YAML loading, schema validation and semantic checks (persona exists, stale globs warn, credential-looking step text warns); verify with unit tests for each scenario in qa-journeys "Journey documents", "Journey steps" and "Coverage declarations"
- [ ] 2.2 Implement framework route derivation (Next.js app and pages, SvelteKit, Remix and React Router file routes, Nuxt, Astro) with an `app.routes_from` override; verify with fixture trees that each convention maps a changed file to the expected route
- [ ] 2.3 Implement changed-mode selection from the diff, the graph delta and the derived routes, plus the `max_journeys` cap and plan reasons; verify unit tests cover "Graph expansion selects a journey", "Nothing matches", "Cap keeps smoke" and explicit `--journey` selection
- [ ] 2.4 Implement `rio qa sync --check` on top of selection without a container; verify a CLI test exits non-zero naming the stale journey
- [ ] 2.5 Implement the environment contract detection order (Compose, Dockerfile, `package.json` scripts, framework defaults); verify unit tests for the Vite and Compose scenarios and the "nothing detected" fallback marker
- [ ] 2.6 Document journeys, the contract and the skill in `docs/qa.md`; verify every YAML example in the document validates against the schemas in a documentation test

## 3. rio-qa crate: browser recorder, probes and evidence

- [ ] 3.1 Add the Node controller package under `crates/rio-qa/controller/` that launches Chromium through Playwright with tracing, console and network capture and a CDP endpoint, starts `@playwright/mcp` against it with the restricted capability set, and runs Rio's MCP server (`login`, `set_viewport`, `set_color_scheme`, `upload_fixture`, `step_done`, `observe`); verify with a Playwright test against the fixture app that each tool works and no shell tool is listed
- [ ] 3.2 Implement step-boundary capture (screenshot, DOM and accessibility snapshot, console and network log flush) and the action recorder for replay; verify a test replays a recorded three-step journey headlessly to the same final URL and DOM hash
- [ ] 3.2a Implement the viewport matrix: built-in presets, custom entries, validation that at least one mobile viewport remains at contract, profile and journey level (`desktop_only` with reason), fresh device-emulated context per viewport and scheme, mobile-first ordering and in-step orientation switch; verify tests for "Mobile emulation is real emulation", "Desktop-only matrix rejected", "Silent mobile removal rejected", "Mobile runs first" and "Orientation change in a step"
- [ ] 3.2b Implement the `mobile/` probe family gated on mobile or touch contexts; verify fixture pages trigger "Pay button under a fixed footer" and "Small tap targets" in `mobile` and nothing in `desktop`
- [ ] 3.3 Implement the probe script for every probe in the ruleset with the minority-pattern thresholds; verify fixture pages trigger each probe exactly as the ui-quality-rules scenarios state, including the "Consistent gradients" non-firing case
- [ ] 3.4 Implement the evidence manifest, naming scheme, redaction of text artifacts, header and body limits for the network log, and masking of password and `data-rio-mask` elements; verify tests cover "Manifest lists everything" and "Token in a response body"
- [ ] 3.5 Implement persona login from environment variables inside the controller so values never reach the harness; verify the transcript fixture shows `login(persona)` with no value and the login-form screenshot is masked
- [ ] 3.6 Implement finding construction: probe hits at `static_proven`, hypotheses from `observe` with evidence refs required, identity from journey, step, rule and route, merge across viewports, attribution order; verify unit tests for "Stable across viewports", "Unsupported observation dropped", "Ambiguous text match" and "Stack trace wins over text"

## 4. Harness drivers

- [ ] 4.1 Implement the `Harness` trait and the codex driver (per-run `config.toml` with MCP servers, `model_providers.rio` for the gateway path, read-only sandbox, non-interactive exec, transcript normalization to jsonl); verify with a stub MCP server test that the generated config contains no secret value and the transcript normalizes
- [ ] 4.2 Implement the pi driver on the same trait; verify the same stub test passes and the journey evidence layout is identical to codex ("Same evidence for both harnesses")
- [ ] 4.3 Implement `harness_auth` resolution: subscription (local only, read-only mount) and gateway (run-scoped token); verify `rio doctor` prints the resolved path and the run record never contains a credential value
- [ ] 4.4 Implement author mode (`rio qa init` and `rio qa sync`) with the `write_journey` tool writing to staging, validation, `*.proposed.yaml` handling and `--force`; verify CLI tests for "First generation", "Existing journey preserved" and "Proposed update" with a scripted harness stub
- [ ] 4.5 Implement skill installation and refresh (`.rio/qa/skills/rio-qa`, `.claude/skills/rio-qa` symlink or copy, fenced `AGENTS.md` section, `SKILL.proposed.md`); verify tests for "Skill registered for two harnesses", "User text outside the fence survives" and "Edited skill preserved"

## 5. Runner image and job class

- [ ] 5.1 Add `worker/Dockerfile.qa` extending the runner image with Playwright Chromium, `@playwright/mcp`, the codex CLI and pi at pinned versions, and a `rio-runner qa` entry point; verify the image builds in CI and `rio-runner qa --self-test` runs a one-step journey against a bundled static page
- [ ] 5.2 Extend the job protocol with `class: qa`, `network: egress_model`, QA wall limits and the `evidence_sink`; update `worker/src/step-schemas.json`, validators and `rio-runner`; verify protocol tests reject a `qa` job with `network: false` or with wall above the class ceiling
- [ ] 5.3 Implement the Docker backend for `qa` jobs: fresh container, materialized snapshot, no app egress, harness egress through a sidecar whose only route is the gateway, teardown on timeout and interruption; verify integration tests cover "Working tree not mounted", "Interrupted run" and that a curl from the app process fails
- [ ] 5.4 Implement the Sandbox backend for `qa` jobs with `enableInternet: true`, the provider-pinned harness and the `egress: provider_pinned (sandbox)` job record; verify the Worker test asserts the record and the report footer text
- [ ] 5.5 Implement the local Docker path in `rio-engine` for no-endpoint runs, including the loopback model proxy with budget enforcement, image tag verification and `no_runtime` deferral; verify tests for "QA runs locally with Docker" and "Docker unavailable"
- [ ] 5.6 Implement replay (`rio-runner qa replay --until <step>`) from recorded actions in a fresh container; verify a test replays the fixture journey and produces the artifacts named in the verifier-quorum delta
- [ ] 5.7 Document the QA image, job class, egress policy and self-hosted setup in `docs/cloudflare.md`; verify the documented commands run as written against the fixture app

## 6. Worker: workflow step, evidence and verifier

- [ ] 6.1 Add the QA workflow step: mint the run-scoped gateway token, issue presigned multipart upload targets, dispatch the `qa` job, consume outcomes and hypotheses, revoke the token; add D1 migration `qa_runs`; verify Worker tests for token scope, budget and revocation at run end
- [ ] 6.2 Implement signed read URLs scoped to one object with the configured expiry, the `qa.evidence_retention` lifecycle rule in `rio init`, and `rio qa evidence prune --review ID`; verify tests for "Markdown with hosted evidence", "Expired evidence" and prune
- [ ] 6.3 Extend `rio/verify` with the QA evidence pack (screenshots, DOM, log excerpts, attributed base and head file, journey file, tool calls only), browser-trace support for `reproduced`, probe results as `static_proven`, replay-backed refutation and the one-replay-per-hypothesis rule; verify quorum tests for "Browser trace supports reproduced", "Screenshot alone cannot refute", "Replay recurs", "Second replay refused" and "Transcript prose excluded"
- [ ] 6.4 Implement the QA `fail_on` policy and cap as a separate pool like security; verify tests for "QA policy independent of general cap" and that `unclassified` QA findings do not match the default policy

## 7. CLI and report

- [ ] 7.1 Add `rio qa` with subcommands `init`, `sync`, `list`, `validate`, `show`, `rules`, `evidence prune` and the bare run form with `--full`, `--journey`, `--baseline`, `--harness` and the review selection flags; verify `assert_cmd` tests for each and that `rio qa` runs prepare, graph, qa, verify and report
- [ ] 7.2 Extend `rio doctor` with Docker reachability, the paired QA image tag, harness binaries and the auth path; verify a doctor test shows each line
- [ ] 7.3 Add the `qa` block to `rio-core` findings, the QA section to the terminal, Markdown and JSON renderers (journeys, step reached, evidence links, probe versus verified versus unverified observations), the footer lines and the run record files; verify snapshot tests for "QA section with a failed journey", "Per-viewport grid", "Unverified observations labeled", "QA footer", "Hosted record carries keys only" and "JSON validates with QA"
- [ ] 7.4 Implement `baseline: true` (second container on base, outcome diff per rule, journey and step) and the no-baseline state rule; verify tests for "Regression classified" and "Attribution without baseline"
- [ ] 7.5 Update `README.md` with the QA quick start and `docs/PRD.md` with requirement R32; verify the README commands run as written

## 7a. PR publishing (gated on the GitHub App change)

- [ ] 7a.1 Implement the QA publishable mapping in `rio-core` (inline at attributed line in the diff, first hunk otherwise, summary for journey attribution, one comment per rule and route with viewports); verify unit tests for "Attributed to a changed line", "Attributed outside the diff" and "Journey-only attribution"
- [ ] 7a.2 Implement the `rio/qa` summary comment body (journeys, outcomes, step reached, evidence links and expiry, held-back and skipped, stale journeys from `sync --check`) and its edit-in-place keying by lineage; verify snapshot tests for the body and a publisher-stub test for "Second round edits the summary"
- [ ] 7a.3 Implement the `rio/qa` check run (neutral by default, failure on QA policy match, annotations for inline-anchored findings); verify publisher-stub tests for "Journeys failed, policy not matched" and "Policy matched"
- [ ] 7a.4 Wire QA identities into lineage, never-re-post, auto-resolution on a passing journey and `/rio dismiss`; verify tests for "Journey fixed on the next round" and "Dismissed as intentional"
- [ ] 7a.5 Make `rio qa --publish` return the existing transport error until the GitHub App change lands, and document publishing in `docs/qa.md`; verify the CLI test for "No PR transport"

## 8. Fixture app and evaluation

- [ ] 8.1 Add `tests/fixtures/qa-sample`, a small Vite app with a login, a registration flow, a checkout flow and switchable seeded defects (disabled save button, missing confirmation, gradient hero, accent-border cards, a raw primitive, low contrast in dark mode, a console error, a fixed banner covering the pay button only on phones, 28 px icon buttons, a 14 px email input, a hover-only menu); verify `npm run build` passes and a toggle file selects which defects are present
- [ ] 8.2 Add `eval/qa/` with labeled cases per seeded defect, a clean-run noise case and the metrics (precision, recall, cost and wall time per journey); verify `python3 eval/qa/run.py --local` reports the seeded defects found and the clean run's noise count
- [ ] 8.3 Run the fixture app end to end locally with codex and with pi, record the results in `docs/evaluation/v0.3-qa-local.md`; verify the document lists every seeded defect with its finding id or a stated miss

## 9. Integration

- [ ] 9.1 Run `cargo test --workspace`, the Worker test suite and the controller tests; verify all pass
- [ ] 9.2 Run `rio review --profile rio/qa` on the fixture repository with a change that breaks the checkout confirmation, with and without an endpoint; verify the hosted report has a verified `reproduced` finding and the local report lists the same observation as unverified

## Workflow follow-up

- Archive the change after the project's review requirements are satisfied.
- Verify the archived result.

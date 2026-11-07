# Design

## Context

See proposal.md for motivation. What shapes the approach today:

- The runner contract (`worker/runner/execute.py`, `worker/src/sandbox.ts`, `rio-runner serve`) is built for short, offline, non-interactive jobs: network off, 120 s wall, one Python entry point streaming a tree archive and returning a JSON result. A QA run is the opposite: minutes long, needs model egress, runs a server and a browser, and produces megabytes of binary evidence.
- The runner image (`worker/Dockerfile`) ships Rust, Python and Node; no browser, no harness.
- Steps are modules with a `with` schema (`modules/steps/*`), validated by `rio-profile`; `rio-engine` runs the local subset and defers the rest with `no_endpoint`. The security step shows the pattern for a step with its own posture, cap and `fail_on`.
- Findings carry `evidence[]` as string references into the run record; the verifier only counts artifact-backed evidence; `rio/verify` is hosted-only.
- Skills already live in `.claude/skills/` in this repository and `AGENTS.md` is read by Codex.

## Goals / Non-Goals

**Goals:**
- One execution path for local Docker and hosted runners: the same QA image, the same in-container controller, the same evidence layout.
- Harness-independent evidence: Rio owns the browser; the harness only drives it through tools.
- Deterministic probes that prove styling defects without a model, and agent judgment that is always gated by the verifier.
- Journeys that a human can read and a coding agent can write, with enough declared coverage to select them for a diff.

**Non-Goals:**
- Pixel-diff visual regression baselines.
- Native mobile apps, Electron, or multi-browser matrices (Chromium only).
- Cloudflare Browser Rendering as a backend (see Open Questions).
- Load, performance or security testing of the running app.
- Running QA on fork PRs.

## Decisions

### D1. A `rio-qa` crate and an in-container controller
A new crate `rio-qa` holds the journey model and schema, the environment contract, selection, the browser recorder, the probe engine, harness drivers and the evidence manifest. It is linked into `rio-cli` (for `rio qa init|sync|list|validate` and local orchestration) and into `rio-runner`, which gains a `qa` subcommand that is the in-container controller: materialize the snapshot, start the app, wait for readiness, launch Chromium, start the MCP bridge, run the harness per journey, run probes at step boundaries, write evidence, emit outcomes and hypotheses.

Alternative rejected: driving Playwright from the Worker through Browser Rendering. The app would then have to be reachable from Cloudflare's network, which breaks "the app has no network" and the local path.

### D2. Rio owns the browser; the harness gets tools over MCP
The controller launches Chromium through Playwright (Node, inside the image) with `tracing`, `recordVideo` (optional) and a CDP endpoint, then starts `@playwright/mcp` with `--cdp-endpoint` and a restricted capability set. Codex and pi both attach to MCP servers from their configuration, so one bridge serves both. Rio adds its own small MCP server beside it with `login(persona)`, `set_viewport(name)`, `set_color_scheme(scheme)`, `upload_fixture(name)`, `step_done(index, outcome, note)` and `observe(rule_id, kind, evidence_refs, observed, expected, fix)`. Step boundaries come from `step_done`; the controller takes the screenshot, DOM and accessibility snapshot, flushes console and network logs, and runs the probes there, independent of what the harness does.

Alternative rejected: Rio's own agent loop with Playwright tools. It would take the most work, duplicate what the harnesses already do well, and the user asked for codex/pi.

### D3. Harness drivers: codex default, pi optional
A `Harness` trait has `prepare(workdir, auth, mcp_servers, model) -> Config`, `run(journey_prompt) -> Transcript` and `cancel()`. The codex driver writes a per-run `config.toml` (MCP servers, `model_provider`, sandbox read-only, approval never) and runs `codex exec` with the journey prompt and the skill; the pi driver does the same with pi's settings. Transcripts are normalized to `jsonl` events (tool call, tool result, text) so the evidence pack and the verifier see one format.

Authentication: `harness_auth` resolves to `subscription` (local only, `~/.codex/auth.json` mounted read-only into the container at the harness home) or `gateway` (codex `model_providers.rio` with `base_url` at the Rio AI Gateway OpenAI-compatible route and a run-scoped bearer in `env_key`; pi configured with the same base URL as an OpenAI-compatible provider). The run-scoped token is minted by the Worker with a token budget and expiry and is revoked at run end; the local path mints it through the endpoint when configured, otherwise uses the provider key from the user's keychain through a loopback proxy with the same budget enforcement, so no raw provider key enters the container.

### D4. A second runner image and a `qa` job class
`worker/Dockerfile.qa` extends the runner image with Chromium (Playwright's bundled build), `@playwright/mcp`, the codex CLI and pi, pinned by version. The job protocol gains `class: qa` with `network: egress_model` (only the model endpoint), `limits.wall_ms` up to 1 800 000 (deep: 5 400 000), `limits.output_bytes` for the result only, and an `evidence_sink` (local directory or presigned R2 multipart targets). The Docker backend enforces egress with a sidecar network namespace whose only route is the gateway host; the Sandbox backend sets `enableInternet: true` and the controller pins the harness to the gateway URL, which the job record and the report state as `egress: provider_pinned (sandbox)`. Jobs of class `qa` run the controller instead of `execute.py` and keep the existing non-root user, read-only root and tmpfs.

Alternative rejected: reusing the 120 s job with one job per step. The app would have to restart per step and the browser state would be lost.

### D5. Journey format
`journey-v1`: natural-language `do`/`expect` steps with optional `at` and `hint`, persona, preconditions and success criteria, plus `covers.paths` and `covers.routes`. Steps are intentionally not a selector script: the agent interprets them, which is what makes the test resilient to markup changes and lets it notice what a script would not. Determinism comes from the recorded actions, which the replay uses. `hint` gives the agent a selector or accessible name when the natural-language target is ambiguous.

### D6. Selection
Changed files come from the snapshot diff; the graph delta adds dependent files. `covers.paths` are matched with the same glob engine as `always_human`. Routes are derived from changed files by framework conventions (Next.js `app/` and `pages/`, SvelteKit `src/routes`, Remix and React Router file routes, Nuxt `pages/`, Astro `src/pages`) and compared with `covers.routes`; `app.routes_from` in the contract can override the convention. The plan records each journey with `smoke`, `path: <glob> <- <file>`, `graph: <changed> -> <dependent>` or `route: <pattern> <- <file>`. The exploratory pass takes derived routes not visited by a selected journey.

### D7. Probes as a versioned module
`modules/qa/rules/ui-v1.yaml` is a `ruleset` module (module-v1 gains the kind). Each probe is a named predicate implemented in the probe script injected at step boundaries (computed styles, bounding boxes, contrast from colors, layout shift from `PerformanceObserver`, console errors from the recorder, broken images from `naturalWidth`). The YAML carries thresholds and the "minority pattern" ratio, not code, so a project can see what fires and why; new predicates need a Rio release. Judged rules are rendered into the harness prompt as named criteria with the required evidence per criterion.

### D8. Evidence pipeline
The controller writes artifacts to a run directory and appends to `manifest.json` as each is complete. The sink streams finished files: locally into the cache run record; hosted, through presigned multipart uploads issued with the job, so the Worker never proxies bytes and an interrupted job keeps what was uploaded. Text artifacts pass the redaction catalog in the controller before the sink. Signed read URLs are minted by the Worker when a report is rendered, scoped to one key, default 7 days.

### D9. Findings, identity and state
Probe hits become `static_proven` findings in the controller. Observations become hypotheses with `qa` metadata and go to `rio/verify`, which gains the QA evidence pack and the replay request (D10). Identity uses journey, step, rule and route (not element paths) so ids survive DOM reshuffles. State: with `baseline: true` the same selected journeys run on base in a second container and outcomes are diffed per rule/journey/step; otherwise `new` when attributed to a changed file, `unclassified` otherwise. Attribution reads development source annotations first (React `__source`, Vue `__file`, Svelte `data-svelte-h`, Vite's `data-v-inspector` when present), then console stack traces, then a unique text or class match in changed files.

### D10. Replay for the verifier
The recorder stores every harness action as a Playwright-replayable event (selector, action, value, viewport, scheme). A voter's replay request runs `rio-runner qa replay --until <step>` in a fresh container without the harness, at most once per hypothesis, and stores the artifacts beside the hypothesis. This keeps "reproduced" tied to an execution Rio performed, not to the agent's claim.

### D11. Local orchestration
With no endpoint, `rio-engine` runs `rio/qa` by invoking the local Docker path in `rio-qa`: pull or verify the paired image tag, create a container with `--network none` for the app plus a loopback model proxy published only to the container, stream the snapshot in with the same archive format, and collect the evidence sink into the cache. `rio/verify` stays deferred, so observations render as unverified. `rio doctor` reports Docker, the image tag, the harness binaries and the auth path.

### D12. Journey generation and sync
`rio qa init` runs the controller in `author` mode: the harness gets the skill, the contract and a `write_journey(yaml)` tool that validates before writing to a staging directory; Rio then copies valid files into `.rio/qa/journeys/` (or `*.proposed.yaml`). `rio qa sync` runs the same mode seeded with the stale journeys and the diff. `--check` is pure selection logic with no container.

### D13. PR publishing reuses the publisher, adds anchoring and a check run
The GitHub App change owns the publisher (posting, editing, threads, `/rio` commands). QA contributes a `Publishable` mapping in `rio-core`: a QA finding with `qa.attribution: source` maps to an inline comment at the attributed line when it is in the diff, else the file's first hunk; `journey` attribution maps to the summary comment. The summary comment is one edited comment keyed by lineage and `rio/qa`, like the round-cap message. Evidence images use the same signed URLs the report uses; GitHub caches images through its proxy, so expiry is stated in the comment and never re-signed on read. The `rio/qa` check run is produced by the same code path as the review check with `neutral` by default and `failure` only on a QA policy match. Convergence identity for QA findings is the journey, step, rule and route tuple from D9, so a journey passing on a later head auto-resolves its findings as `fixed`.

Alternative rejected: a separate QA bot or comment format. It would duplicate the never-re-post and dismissal rules and give authors two places to respond.

### D14. Viewport matrix as browser contexts, mobile first
Each viewport and color scheme pair is a fresh Playwright browser context created from a preset device descriptor (viewport, `deviceScaleFactor`, `isMobile`, `hasTouch`, user agent, `colorScheme`), so the matrix is a loop around the journey, not a journey variation. Mobile contexts run first so budget exhaustion keeps the phone result. `mobile/` probes are part of the same injected probe script, gated on the context's `isMobile` or `hasTouch`. Orientation changes inside a step swap to the matching landscape descriptor in the same context. The per-viewport evidence directory from D8 already separates artifacts, and the finding identity from D9 excludes the viewport so one finding lists every viewport it fired in.

Alternative rejected: one context resized between viewports. Resizing keeps session state and layout caches that a real device switch would not, and hides first-render problems.

### D15. Seed snapshots reuse the content-addressed snapshot store
Seed definitions are small and committed; materialized state is big and cached. The controller computes the fingerprint (manifest, referenced files, migration globs, datastore kinds, image version) before starting the app. On a hit it restores each datastore archive through the kind's restore path (`sqlite` copy, `pg_restore`, `mysql`, `redis-server --dbfilename`, `tar` for `files`, the custom command otherwise) before `app.start`; on a miss it starts the app's datastores, runs the steps, captures one archive per datastore and path, and registers them under the fingerprint. Storage reuses the content-addressed hosted snapshot store from the v0.2 snapshot change for the hosted path and `<cache>/qa-seeds/` locally, so an unchanged archive is never re-uploaded and pruning follows the cache rules. `resets: true` restores from the already-downloaded archives, which is a local copy, not a network round trip. The datastore client tools ship in the QA image, so the same restore works in Docker and in the Sandbox.

Alternative rejected: snapshotting the whole container filesystem or a Docker volume. It is not portable to the Sandbox backend, ties the snapshot to the image layer and cannot be split per datastore.

Alternative rejected: re-running the seed every run with caching left to the project. That is the status quo the user flagged as too costly for large data sets.

## Risks / Trade-offs

- [Seed snapshots hold synthetic but realistic data and can be large] → private cache or tenant store only, size cap, prune keeping the newest three, the skill forbids production data and validation warns on personal-data patterns.
- [Fingerprint misses a dependency and a stale seed is restored] → migrations globs are explicit in the contract, `rio qa seed status` shows both fingerprints, and `seed build --force` is one command.

- [The matrix multiplies cost by viewports × schemes] → defaults are three viewports and two schemes; `max_journeys` counts journeys; profiles can narrow to one mobile and one desktop viewport; the footer shows cost per viewport.

- [GitHub's image proxy may cache screenshots beyond the signed URL expiry] → the summary states expiry; screenshots are redacted and masked before upload; publishing stays opt-in through `publish`.

- [Harness nondeterminism makes journey outcomes flaky] → every outcome is tied to recorded evidence; the verifier replays deterministically; `smoke` journeys are expected to be short and stable; flaky journeys are reported with their last three outcomes in the footer once convergence data exists.
- [Model egress from a container running repository code] → the app has no network; only the harness process gets the proxy; the token is run-scoped and budgeted; the Docker backend enforces egress at the network level; the Sandbox backend's weaker guarantee is stated in the report.
- [Evidence contains application data] → private cache or private R2 only, redaction before storage, masked fields, 30-day lifecycle, signed one-object URLs.
- [Style probes flag intentional design] → minority-pattern thresholds, per-project disable list, `unclassified` state does not match the default fail policy.
- [Cost of a full run] → caps on journeys and wall time, `changed` mode by default, baseline off by default, cost in the footer.
- [Image size and release pairing] → the QA image is separate so the review image stays small; both are version-paired with the CLI and verified by tag.
- [Subscription auth inside a container] → local only, mounted read-only, never copied; hosted runs use the gateway only.

## Migration Plan

Additive. Profiles without the QA step are unaffected; `rio/base` carries it disabled. Deploying the QA image is a `rio deploy` step that is skipped when no profile enables QA. D1 migration `qa_runs` is forward-only like the others. Rollback is removing the step from profiles; evidence expires by lifecycle.

## Open Questions

- Whether Cloudflare Browser Rendering can replace the in-container Chromium for hosted runs once the app is reachable only inside the container; evaluated after the first hosted release, no spec impact.
- Whether a GitHub Actions runner (PRD R21) can host QA jobs with the same image; depends on that change.

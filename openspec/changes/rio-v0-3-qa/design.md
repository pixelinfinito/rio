# Design

## Context

See proposal.md for motivation. What shapes the approach today:

- The runner contract (`worker/runner/execute.py`, `worker/src/sandbox.ts`, `rio-runner serve`) is built for short, offline, non-interactive jobs: network off, 120 s wall, one entry point streaming a tree archive and returning a JSON result, leases renewed by a single bounded wait. A QA run is the opposite: minutes long, needs model egress for one process only, runs a server, datastores and a browser, and produces megabytes of binary evidence.
- The runner image (`worker/Dockerfile`) ships Rust, Python and Node; no browser, no harness, no datastore servers. Project dependencies must already be in a deliberately provisioned image; Rio never installs them.
- The snapshot protocol stores distinct content per tenant with 64 MiB per file, 1 GiB per review and 8 MiB parts.
- Steps are modules with a `with` schema; `rio-engine` runs the local subset and defers the rest with `no_endpoint`. Guardrails require `rio/verify` to depend on every enabled `rio/agents` or `rio/security` step.
- The in-flight convergence change replaces the finding-model and footer requirements and defines auto-resolution; this change composes with it rather than overriding it.
- Findings carry `evidence[]` references into the run record; the verifier counts only artifact-backed evidence and runs a blind first turn.

## Goals / Non-Goals

**Goals:**
- Enforced, not declared, boundaries: repository code never shares a network namespace or a filesystem with model credentials or the model route.
- One controller and one evidence layout for the Docker backend locally and hosted, with the Sandbox backend admitted only where its boundary is good enough and labeled where it is not.
- Reproducible state for every matrix cell and for replay.
- Deterministic probes with written predicates; agent judgment always gated by the verifier.
- Journeys a human can read and a coding agent can write, with declared coverage for diff selection.

**Non-Goals:**
- Pixel-diff visual regression baselines.
- Native mobile, Electron, non-Chromium browsers.
- Cloudflare Browser Rendering as a backend (Open Questions).
- Load, performance or security testing of the running app.
- Docker Compose topologies in this version (rejected with a named failure; init proposes a Dockerfile instead).
- QA on fork PRs.

## Decisions

### D1. A `rio-qa` crate and a three-container pod per run
`rio-qa` holds the journey, contract, seed and fixture models, selection, the probe engine, harness drivers, the replay event model and the evidence manifest. A QA job is a pod of three containers on one private network created per run by the Docker backend (`rio-runner` locally and self-hosted):

| Container | Runs | Filesystem | Network |
| --- | --- | --- | --- |
| `app` | the app, datastores, service doubles, the probe injector target | materialized head snapshot, seed restore | pod network only; no egress; no route to the controller's gateway interface |
| `browser` | Chromium with CDP | none of the repository | pod network only: reaches `app`, exposes CDP to `controller` |
| `controller` | the Rio controller, the Playwright MCP bridge, the harness (codex or pi), the model proxy, the evidence sink | skill, journeys, contract, fixtures manifest; **no repository checkout**; harness credentials | pod network plus one egress route limited to the gateway host (or the loopback proxy locally) and the evidence upload endpoint |

Repository code runs only in `app`. Model credentials and the model route exist only in `controller`, where no repository code runs; the harness's own shell sandbox, if any, sees only the harness home. The controller container is the only one that can upload, so evidence and seed uploads never require giving `app` a network.

Alternative rejected: one container with per-process rules. Non-root containers cannot install packet filters, so a single container cannot separate app traffic from harness traffic.

### D2. Backend eligibility: Docker enforces, Sandbox is labeled and opt-in
The Docker backend implements the pod with Docker networks: an internal network for `app` and `browser`, and a second network for `controller` with egress filtered to the gateway host by the runner host (the host already holds the runner secret and is trusted). The Sandbox backend runs one container and cannot build the pod, so hosted QA defaults to the self-hosted Docker runner. A profile may set `rio/qa` `with.sandbox: allow` to run QA in the Sandbox; then subscription credentials are refused, the harness uses only a run-scoped gateway token, the job record and report state `egress: provider_pinned (sandbox), app isolation: none`, and the fail policy treats the run as `partial` for isolation. Without `sandbox: allow`, a Sandbox-only deployment defers QA with reason `no_runtime`.

### D3. Rio owns the browser; the harness gets tools over MCP
The controller launches Chromium in `browser` with tracing, screenshot, console and network capture and attaches `@playwright/mcp` over CDP with a restricted capability set. Rio's own MCP server adds `login(persona)`, `set_viewport`, `set_color_scheme`, `upload_fixture(name)`, `read_mail`, `read_sms`, `read_webhooks`, `set_service_behavior`, `set_network`, `set_geolocation`, `step_done` and `observe`. Step boundaries come from `step_done`; the controller captures evidence and runs probes there regardless of harness. Every tool call is appended to the replay event log (D10).

### D4. Harness drivers and authentication
A `Harness` trait with codex (default) and pi drivers, both configured per run with the MCP servers, a read-only sandbox and non-interactive execution; transcripts normalize to jsonl. `harness_auth` resolves to `subscription` (local Docker only; the developer's codex auth file is mounted read-only into `controller`, never into `app`) or `gateway` (an OpenAI-compatible provider pointed at the model proxy). The proxy runs in `controller`, holds the run-scoped token minted by the Worker (or, locally without an endpoint, the provider key from the keychain), enforces the per-cell token budget and records usage. Subscription mode cannot meter tokens; it is wall-bounded only and the footer says so.

### D5. Application packaging and provisioning
The contract's `app.packaging` is one of:
- `image`: a Dockerfile in the repository that starts `FROM` the Rio QA base image (or any image into which the runner injects the controller's probe assets through a mounted volume). Project dependencies, datastore servers and tools are provisioned there, matching Rio's existing rule that Rio never installs dependencies. This is what `rio qa init` proposes when it finds a Dockerfile or any server-side runtime.
- `static`: a committed or built directory served by the controller's static server, for SPAs without a server.
- `vendored`: a Node or Python app whose dependencies are present in the snapshot.
Compose files produce the named failure `unsupported_topology` with a hint, and init offers a Dockerfile skeleton. Datastores declare `start` and `ready` probes (built-in defaults for the supported kinds when their server binaries are present; `missing_tool` otherwise). Start order inside `app` is: datastores, seed restore, credential apply, service doubles, app, readiness probe, `app.seed` hook.

### D6. Viewport matrix, chains and state per cell
A matrix cell is one viewport and color scheme. Journeys may declare `after: [journey]` to share state; the plan groups journeys into chains (a journey with no `after` is a chain of one). The unit of execution is chain × cell: for each cell, the seed snapshot is restored, the chain runs in order in a fresh browser context, and a journey with `resets: true` is always a chain head. The default matrix is `mobile` and `desktop`; `tablet` is a preset to opt into. Mobile cells run first.

Alternative rejected: reset once per journey across cells. The review showed it breaks any journey that creates records.

### D7. Selection
Changed files from the diff; graph delta adds dependents; `covers.paths` matched with the `always_human` glob engine; routes derived by framework conventions with an `app.routes_from` override (`convention: next-app | next-pages | sveltekit | remix | nuxt | astro | none`, or `map: [{ glob, route }]`). Plan reasons: `smoke`, `path`, `graph`, `route`, `explicit`.

### D8. Probes and the minority computation
`modules/qa/rules/ui-v1.yaml` is a `ruleset` module; each probe has a written predicate (eligible elements, measurements, tolerances, exclusions) in the spec and in the YAML. Probe candidates are collected at every step boundary; run-wide decisions (the minority test) are finalized at run end, so a probe finding is emitted once per run after all cells complete. Style probes default to severity `info`; a project lists rules in `rules.adopt[]` to raise them to `warning` and make them eligible for `fail_on`. Mobile probes run only in mobile or touch cells.

### D9. Evidence sanitization, fail closed
The controller never stores a raw Playwright trace. It unpacks the trace, applies the secrets catalog and the header and query-parameter redaction to every member (network entries, action arguments, URLs, DOM snapshot files), drops response bodies, and repacks it; any member it cannot parse causes the whole trace to be dropped with a `evidence_unsanitized` footer entry. Screenshots and video are masked at the DOM level before capture: an injected stylesheet applies `-webkit-text-security: disc` and a blur to password inputs and `data-rio-mask` elements for the life of the context, so continuous video is masked at the source. Captured mail, SMS and webhooks pass the same redaction. Artifacts are hashed after sanitization; a test seeds secrets through every channel and scans the whole bundle.

### D10. Replay event model
Every action is recorded as a `qa-replay-v1` event: Playwright actions (selector, action, value, viewport, scheme) and Rio tool calls (`login` by persona name, `set_service_behavior`, `set_network`, `set_geolocation`, clock changes, `upload_fixture` by name). A voter's replay runs `rio-runner qa replay --until <journey>:<step>` in a fresh pod: seed restore, the chain's prerequisite journeys from their events, then the target up to the step, without the harness. Outcomes: `recurred` (supports `reproduced`), `not_recurred` (inconclusive, recorded) and `prerequisites_failed` (inconclusive). Replay is never a refutation on its own.

### D11. Budgets
profile-v1 gains `budget.<mode>.qa` with `wall` (run, default 30 min fast and 90 min deep), `cell_wall` (per chain per cell, default 8 and 15 min), `tokens` (per cell, default 150 000), `evidence_bytes` (default 512 MiB) and `replay_wall` (default 5 min). When QA is enabled, the review deadline is `wall_time + qa.wall + verify reserve`; the Worker leases `qa` jobs with a 60 s heartbeat instead of one bounded wait. Baseline runs share `qa.wall`. Replay draws on `replay_wall` and the voter's `verify_tokens`.

### D12. Seed snapshots: a separate object protocol
Seed archives are stored under a tenant-scoped `seeds/` namespace, uploaded from `controller` in 8 MiB parts reusing the packs protocol, with per-archive and total quotas from `seed.max_size`, hash verification per part, and a manifest published atomically only after every part is verified. Extraction enforces a bounded expansion ratio, regular files only, no symlinks. Pruning never deletes a snapshot leased by a running job. Persona credentials are never in the snapshot: `users[].apply` commands re-apply them from environment variables after every restore, and `seed.cache_version` is a non-secret fingerprint input for other runtime-dependent state.

### D13. Service doubles and host claims
Doubles run in `app` on loopback ports; the manifest's `env` templates their URLs into `app.start`. Host claims (`claims: [api.stripe.com]`) are written to the container's hosts file by the image entrypoint before dropping to the unprivileged user, and doubles serve HTTPS with a run-generated CA installed into the container trust store and exported through `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` and `REQUESTS_CA_BUNDLE`. Apps with certificate pinning or hard-coded ports that cannot be claimed are listed as undoubled; journeys depending on them skip with `precondition_failed`.

### D14. Findings, identity and state
Canonical QA identity: `blake3(rule_id | "qa" | journey | step | route_pattern | trigger_hash)`, where `trigger_hash` for probes is the predicate id plus an element-role signature (tag, role, accessible name), never measured values, and for observations is the hash of the structured `expected` and `observed` fields, never free text. Occurrences are matrix cells carried in `locations[]` with a `cell` and their own `evidence[]`; presentation grouping across journeys is report-level and does not touch identity. With `baseline: true`, cells are matched one to one between head and base: `new`, `pre-existing`, `fixed`, `worsened` when at least one cell is new and one pre-existing, and `unclassified` for any cell the base run did not complete. Without baseline: `new` when attributed to a changed file, `unclassified` otherwise.

### D15. Step wiring and verification
`rio/qa` needs `graph`, outputs `qa_findings`, `hypotheses`, `journey_outcomes` and `evidence`; `rio/verify` needs `agents`, `security` and `qa`; `rio/report` consumes `qa_findings` and `journey_outcomes`. The guardrail extends to `rio/qa`: an enabled QA step without a verifier depending on it is rejected. `rio qa` standalone runs the subgraph `prepare, graph, qa, verify, report` and records the other steps as `skipped: standalone`. The verifier's blind first turn for a QA hypothesis gives voters the step evidence pack without the hypothesis text and asks what they observe; blind match is computed on rule, journey, step and route instead of symbol.

### D16. PR publishing
The GitHub App change owns the publisher. QA adds a mapping: source-attributed findings become inline comments when the file is in the diff (at the line if in a hunk, else the first hunk), otherwise the summary; one summary comment per lineage edited in place; the `rio/qa` check run is neutral unless the QA policy matches. Auto-resolution is the convergence rule with a QA re-assessment condition: the same cell of the same journey completed on the later head, the identity is absent, and the attributed code (or the journey file and its covered paths) changed.

### D17. Journey generation and sync
`rio qa init` runs the controller in author mode: contract detection first, then seed and fixture authoring, seed build, then journeys against the seeded app through a `write_journey` tool that validates into staging. `rio qa sync` reuses author mode seeded with stale journeys; `--check` is selection only.

## Configuration reference

| Key | Location | Default |
| --- | --- | --- |
| `app.packaging`, `app.start`, `app.url`, `app.ready`, `app.routes_from`, `app.seed` | `.rio/qa.yaml` | detected |
| `personas[]` | `.rio/qa.yaml` | required |
| `browser.viewports`, `browser.color_schemes` | `.rio/qa.yaml` | `[mobile, desktop]`, `[light, dark]` |
| `harness.default`, `harness.model`, `harness.auth` | `.rio/qa.yaml` | `codex`, provider default, `auto` |
| `rules.disable`, `rules.add`, `rules.adopt` | `.rio/qa.yaml`, overridable by the step | `[]` |
| `evidence.video`, `evidence.retention_days` | `.rio/qa.yaml` | `false`, `30` |
| `seed.manifest`, `seed.migrations`, `seed.max_size`, `seed.fallback_rebuild`, `seed.cache_version` | `.rio/qa.yaml` | `.rio/qa/seed/seed.yaml`, detected, `2 GiB`, `false`, `1` |
| `with.enabled`, `mode`, `harness`, `baseline`, `max_journeys`, `max_defects`, `viewports`, `rules`, `fail_on`, `sandbox` | `rio/qa` step | `false`, `changed`, `codex`, `false`, `12`, `15`, all, `{}`, QA policy, `deny` |
| `budget.<mode>.qa.wall`, `cell_wall`, `tokens`, `evidence_bytes`, `replay_wall` | profile | `30m/90m`, `8m/15m`, `150000`, `512 MiB`, `5m` |

## Risks / Trade-offs

- [Pod model needs a Docker host] → hosted QA defaults to the self-hosted runner; Sandbox is opt-in and labeled; local runs need Docker, which `rio doctor` checks.
- [Harness nondeterminism] → every outcome is tied to recorded evidence; replay from events; non-recurrence is inconclusive, never a refutation.
- [Evidence contains application data] → DOM-level masking, member-level trace sanitization, fail-closed drops, private storage, lifecycle expiry, one-object signed URLs.
- [Style probes flag intentional design] → minority test over the run, `info` severity unless adopted, project disable list.
- [Cost of matrix × chains] → default two viewports, `max_journeys` counts journeys, evidence byte quota, plan-time cell count and estimate in the footer.
- [Seed snapshots are large] → separate quota and namespace, chunked upload, prune keeping three, credentials re-applied after restore.
- [Canned provider responses drift] → recordings are reviewed repository files; the skill flags provider-exact journeys as human-maintained.
- [GitHub's image proxy caches screenshots] → expiry stated in the comment; screenshots are masked before upload.

## Migration Plan

Additive. `rio/base` carries QA disabled; profiles without the step are unaffected. `rio deploy` builds and registers the QA base image only when a profile enables QA. D1 migration `qa_runs` is forward-only. The finding-model and footer replacements compose with the convergence change: whichever archives second must carry both sets of additions, which task 0.5 verifies.

## Open Questions

- Whether Cloudflare Browser Rendering can serve as the `browser` container for Sandbox runs once a pod-equivalent exists there; no spec impact now.
- Whether a GitHub Actions runner (PRD R21) can host the pod; depends on that change.

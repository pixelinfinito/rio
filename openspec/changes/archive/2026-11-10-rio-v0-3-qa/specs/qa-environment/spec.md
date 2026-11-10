# Spec Delta

## Purpose

The environment contract tells Rio how the application is packaged and started, when it is ready, which personas can use it, and in which isolated runtime the app, the browser and the agent harness run, locally or hosted.

## ADDED Requirements

### Requirement: Environment contract
`.rio/qa.yaml` SHALL declare `version: 1`, `app`, `personas[]` and the optional blocks `browser`, `harness`, `rules`, `evidence` (`video`, `retention_days`) and `seed` (`manifest`, `migrations[]`, `max_size`, `fallback_rebuild`, `cache_version`). The schema SHALL be published as `schemas/qa-config-v1.json`; unknown keys SHALL be rejected.

#### Scenario: Full contract validates
- **WHEN** the file declares `app` (`packaging`, `start`, `url`, `ready` with `path`, `status`, `timeout`, plus `env`, `seed`, `workdir`, `routes_from`), two personas with `name`, `description`, `username_env` and `password_env`, `browser.viewports`, `browser.color_schemes`, `harness.default`, `harness.model`, `harness.auth`, `rules.disable`, `rules.add`, `rules.adopt`, `evidence.video`, `evidence.retention_days` and the `seed` block
- **THEN** `rio qa validate` accepts it and `rio qa show` prints the resolved contract

#### Scenario: Unknown key rejected
- **WHEN** the file contains `app.port`
- **THEN** validation fails naming the key and its YAML path

#### Scenario: Defaults applied
- **WHEN** `.rio/qa.yaml` declares only `app` and one persona
- **THEN** the resolved contract has viewports `mobile` and `desktop`, color schemes `light` and `dark`, harness `codex` with auth `auto`, video off and evidence retention of 30 days

### Requirement: Application packaging
`app.packaging` SHALL be `image` (a repository Dockerfile that provisions dependencies, datastore servers and tools), `static` (a directory served by Rio) or `vendored` (a Node or Python app whose dependencies are present in the snapshot). Rio SHALL NOT install dependencies. A Compose file SHALL be rejected with reason `unsupported_topology` and a hint to write a Dockerfile.

#### Scenario: Image packaging
- **WHEN** `app.packaging: image` names `Dockerfile.qa`
- **THEN** the run builds or pulls that image, verifies it contains the Rio controller hooks, and starts the app inside it

#### Scenario: Vendored dependencies missing
- **WHEN** `app.packaging: vendored` and `node_modules` is absent from the snapshot
- **THEN** the step ends `failed` with reason `dependencies_unavailable` naming the packaging alternatives

#### Scenario: Compose rejected
- **WHEN** `rio qa init` finds only a `compose.yaml`
- **THEN** it reports `unsupported_topology`, writes a Dockerfile skeleton as `Dockerfile.qa.proposed`, and does not generate journeys

### Requirement: Credentials are named, never stored
Persona credentials SHALL be given only as environment variable names; a literal username or password value in the contract SHALL be rejected by validation.

#### Scenario: Literal password rejected
- **WHEN** a persona declares `password: hunter2`
- **THEN** validation fails stating that credentials are named by environment variable only

### Requirement: Detection on init
`rio qa init` SHALL propose `app` defaults by inspecting, in order, a Dockerfile, `package.json` scripts (`dev`, `start`, `preview`), a Python entry point and framework conventions for the base URL and readiness path. The proposal SHALL be shown and written to `.rio/qa.yaml` before seed, fixture or journey generation. When detection finds nothing, the command SHALL ask the harness to propose a contract and SHALL still require the developer to confirm.

#### Scenario: Vite project
- **WHEN** `rio qa init` runs in a project whose `package.json` has a `dev` script running `vite` and a committed lockfile with `node_modules` present
- **THEN** the proposed contract uses `packaging: vendored`, starts `npm run dev -- --host 0.0.0.0 --port 4173`, uses `http://127.0.0.1:4173` and probes `/` for status 200

#### Scenario: Dockerfile project
- **WHEN** the repository has a `Dockerfile` exposing port 3000
- **THEN** the proposed contract uses `packaging: image` with that Dockerfile and `http://127.0.0.1:3000`

### Requirement: Start order and readiness
A run SHALL start the app container's stages in a fixed order, waiting for each stage's readiness, and SHALL end the step `failed` with a reason naming the stage (`datastore_not_ready`, `seed_failed`, `app_not_ready`) when a stage fails, keeping that stage's output as evidence. The app readiness wait SHALL be at most `ready.timeout` (default 120 s).

#### Scenario: Stage order
- **WHEN** a run starts
- **THEN** the stages run as: datastores with their `ready` probes, seed restore or build, persona credential apply, service doubles, `app.start`, the readiness probe, then the `app.seed` hook

#### Scenario: App never listens
- **WHEN** `app.start` exits before the probe succeeds
- **THEN** the step outcome is `failed` with reason `app_not_ready`, the process output is stored as evidence, and the report shows every selected journey as `not_run`

#### Scenario: Datastore never ready
- **WHEN** the `postgres` datastore's `ready` probe fails for its timeout
- **THEN** the step outcome is `failed` with reason `datastore_not_ready` naming the datastore and nothing later starts

### Requirement: Personas and credentials
Each persona SHALL be usable by the agent through a login tool that reads the named environment variables at run time inside the controller, so the credential value never enters the prompt, the journey, the transcript or a screenshot. Password fields SHALL be masked in screenshots and video. When a journey's persona needs credentials and the variables are unset, the journey SHALL be `skipped` with reason `missing_credentials`.

#### Scenario: Credentials outside the prompt
- **WHEN** the agent logs in as persona `shopper`
- **THEN** the transcript records a `login(persona: shopper)` tool call with no credential value, and the screenshot of the login form shows the password field masked

#### Scenario: Missing credentials skip
- **WHEN** persona `admin` names `QA_ADMIN_PASSWORD` and the variable is unset
- **THEN** every journey using `admin` is `skipped` with reason `missing_credentials` and the run continues

### Requirement: Runtime pod
A QA run SHALL execute as three containers on a private per-run network: `app` (repository code, datastores, doubles), `browser` (Chromium) and `controller` (Rio controller, MCP bridge, harness, model proxy, evidence sink). Repository code SHALL run only in `app`. Model credentials and the model route SHALL exist only in `controller`, which SHALL hold no repository checkout.

#### Scenario: Repository code cannot reach the model route
- **WHEN** a test process inside `app` attempts to connect to the controller's proxy port or the gateway host
- **THEN** the connection is refused and the attempt appears in the run record as `blocked_egress`

#### Scenario: Harness container holds no source
- **WHEN** the harness lists its working directory
- **THEN** it contains only the supplied skill, journeys, contract, fixtures manifest and immutable scoped owner-guidance artifact, with no repository checkout or additional source files

### Requirement: Egress policy
`app` and `browser` SHALL have no egress. `controller` SHALL have egress only to the model gateway host (or the local loopback proxy) and the evidence and seed upload endpoint. The policy SHALL be enforced by the runner host's network configuration, not by harness configuration, and the job record SHALL state the policy that applied.

#### Scenario: App egress blocked behaviorally
- **WHEN** the app process runs `curl https://example.com` during a journey
- **THEN** the request fails, the network log records `blocked_egress: example.com`, and the footer lists the host

#### Scenario: Controller egress limited
- **WHEN** the harness attempts to reach a host other than the gateway
- **THEN** the connection is refused and the transcript records the rejection

### Requirement: Backend eligibility
Hosted QA SHALL use the self-hosted Docker runner by default. Cloudflare Sandbox SHALL require `sandbox: allow`; without it, a Sandbox-only deployment SHALL defer QA with `no_runtime`.

#### Scenario: Sandbox without opt-in
- **WHEN** the endpoint's runner backend is `sandbox` and the profile does not set `sandbox: allow`
- **THEN** the QA step is deferred with reason `no_runtime` and the footer explains that QA needs the Docker runner or `sandbox: allow`

### Requirement: Sandbox isolation disclosure
Sandbox QA SHALL refuse subscription credentials and use only a run-scoped gateway token. The report SHALL state `app isolation: none (sandbox)` and mark the run `partial` for isolation.

#### Scenario: Sandbox with opt-in
- **WHEN** `sandbox: allow` is set and a static or vendored app is provisioned in the configured Sandbox image or snapshot
- **THEN** QA runs, the job record carries `egress: provider_pinned (sandbox)` and `app_isolation: none`, and the report header status is `partial`

### Requirement: Sandbox provisioned packaging
Sandbox SHALL run only `static` or `vendored` apps with runtime, tools and dependencies provisioned in the configured image or snapshot. It SHALL NOT build repository Dockerfiles, install dependencies or provision cloud images during a run. For `packaging: image`, it SHALL defer QA with `no_runtime`, record `unsupported_packaging`, and direct the operator to Docker.

#### Scenario: Sandbox Dockerfile packaging deferred
- **WHEN** `sandbox: allow` is set but the contract uses `packaging: image`
- **THEN** QA is deferred with `no_runtime` and an `unsupported_packaging` explanation requiring the Docker runner; no repository Dockerfile is built and no app or harness starts

#### Scenario: Sandbox missing provisioning
- **WHEN** a static or vendored app requires a dependency or tool absent from both the configured Sandbox image and snapshot
- **THEN** QA reports `dependencies_unavailable` or `missing_tool`, retains stage diagnostics, and installs nothing

### Requirement: Snapshot materialization and teardown
Repository contents SHALL be materialized inside `app` from the snapshot, never bind-mounted from the developer's working tree. Every container of the pod SHALL be destroyed when the run ends, including after a timeout or an interruption.

#### Scenario: Working tree not mounted
- **WHEN** a local run starts
- **THEN** `app` has no bind mount of the repository and the app runs from the materialized head snapshot

#### Scenario: Interrupted run
- **WHEN** the developer presses Ctrl-C during a journey
- **THEN** all three containers are removed, evidence captured so far stays in the cache, and the report is partial

### Requirement: Harness credentials
`harness.auth` SHALL be `auto`, `subscription` or `gateway`. `subscription` (codex only) SHALL be allowed only on the Docker backend, mounting the developer's codex auth file read-only into `controller`. `gateway` SHALL configure the harness against the controller's model proxy, which holds the run-scoped token and enforces the token budget. Hosted runs SHALL use `gateway`. The resolved path SHALL be shown by `rio doctor` and recorded in the run record without secret values.

#### Scenario: Hosted codex uses the gateway
- **WHEN** a hosted QA run uses harness `codex`
- **THEN** the harness is configured with the proxy base URL, the proxy holds a token scoped to the run's budget, and no subscription credential is present in any container

#### Scenario: Local subscription reuse
- **WHEN** a local Docker run resolves `harness.auth` to `subscription`
- **THEN** the auth file is mounted read-only into `controller` only, the run record notes `harness_auth: subscription` and `tokens: unmetered`, and no value is copied into the cache

#### Scenario: Docker unavailable locally
- **WHEN** `rio qa` runs with no endpoint and no reachable Docker daemon
- **THEN** the command exits with an actionable message, and `rio review` marks the QA step as deferred with reason `no_runtime` rather than failing

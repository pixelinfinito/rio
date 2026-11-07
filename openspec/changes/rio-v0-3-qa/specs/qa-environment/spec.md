# Spec Delta

## Purpose

The environment contract tells Rio how to start the application, when it is ready, which personas can use it and in which runtime the app, the browser and the agent harness run, locally or hosted.

## ADDED Requirements

### Requirement: Environment contract
`.rio/qa.yaml` SHALL declare `version: 1`, `app`, `personas[]` and the optional blocks `browser`, `harness`, `rules`, `evidence` and `seed` (`manifest` path, default `.rio/qa/seed/seed.yaml`; `migrations[]` globs; `max_size`; `fallback_rebuild`). The schema SHALL be published as `schemas/qa-config-v1.json`; unknown keys SHALL be rejected.

#### Scenario: Full contract validates
- **WHEN** the file declares `app` (`start`, `url`, `ready` with `path`, `status`, `timeout`, plus `env`, `seed`, `teardown`, `workdir`), two personas with `name`, `description`, `username_env` and `password_env`, `browser.viewports`, `browser.color_schemes`, `harness.default`, `harness.model`, `rules.disable`, `rules.add`, `evidence.video` and `evidence.trace`
- **THEN** `rio qa validate` accepts it and `rio qa show` prints the resolved contract

#### Scenario: Unknown key rejected
- **WHEN** the file contains `app.port`
- **THEN** validation fails naming the key and its YAML path

#### Scenario: Defaults applied
- **WHEN** `.rio/qa.yaml` declares only `app` and one persona
- **THEN** the resolved contract has viewports `mobile`, `tablet` and `desktop`, color schemes `light` and `dark`, harness `codex`, trace on and video off

### Requirement: Viewport matrix
`browser.viewports[]` SHALL name entries from the built-in presets or declare custom ones with `name`, `width`, `height`, `device_scale_factor`, `mobile` (touch events and a mobile user agent) and optional `orientation`. The default matrix SHALL be `mobile`, `tablet` and `desktop`.

#### Scenario: Built-in presets
- **WHEN** `rio qa show --viewports` is run
- **THEN** it lists `mobile-small` (360×740, scale 3, mobile), `mobile` (390×844, scale 3, mobile), `mobile-landscape` (844×390, scale 3, mobile), `tablet` (820×1180, scale 2, touch), `desktop` (1280×800, scale 1) and `wide` (1920×1080, scale 1)

#### Scenario: Custom viewport
- **WHEN** the contract declares `{ name: kiosk, width: 1080, height: 1920, device_scale_factor: 1, mobile: false }`
- **THEN** validation passes and journeys run in that viewport in addition to the named presets

#### Scenario: Mobile emulation is real emulation
- **WHEN** a journey runs in the `mobile` preset
- **THEN** the page sees a 390×844 layout viewport, a device pixel ratio of 3, touch events, a mobile user agent, and `pointer: coarse` media queries match

### Requirement: Mobile is mandatory
The resolved matrix SHALL contain at least one viewport with `mobile: true`. A contract or profile that removes every mobile viewport SHALL be rejected by validation, so no QA run reports a journey as passing without having run it on a phone-sized screen.

#### Scenario: Desktop-only matrix rejected
- **WHEN** `browser.viewports: [desktop, wide]` is declared
- **THEN** validation fails stating that at least one mobile viewport is required and naming the presets that qualify

### Requirement: Credentials are named, never stored
Persona credentials SHALL be given only as environment variable names; a literal username or password value in the contract SHALL be rejected by validation.

#### Scenario: Literal password rejected
- **WHEN** a persona declares `password: hunter2`
- **THEN** validation fails stating that credentials are named by environment variable only

### Requirement: Detection on init
`rio qa init` SHALL propose `app` defaults by inspecting, in order, a Compose file, a Dockerfile, `package.json` scripts (`dev`, `start`, `preview`) and framework conventions for the base URL and readiness path. The proposal SHALL be shown and written to `.rio/qa.yaml` before any journey generation. When detection finds nothing, the command SHALL ask the harness to propose a contract and SHALL still require the developer to confirm.

#### Scenario: Vite project
- **WHEN** `rio qa init` runs in a project whose `package.json` has a `dev` script running `vite`
- **THEN** the proposed contract starts `npm run dev -- --host 0.0.0.0 --port 4173`, uses `http://127.0.0.1:4173` and probes `/` for status 200

#### Scenario: Compose project
- **WHEN** a `compose.yaml` exposes a `web` service on port 3000
- **THEN** the proposed contract starts the Compose project and uses `http://127.0.0.1:3000`

### Requirement: Readiness and failure to start
A run SHALL restore or build the seed snapshot, start the app with `app.start`, run `app.seed` (a per-run hook for state the snapshot cannot hold, such as cache warmups) once the readiness probe succeeds, and wait at most `ready.timeout` (default 120 s). If the probe never succeeds, the QA step SHALL end `failed` with reason `app_not_ready`, keep the captured stdout and stderr as evidence, and SHALL NOT report any journey as passed.

#### Scenario: App never listens
- **WHEN** `app.start` exits before the probe succeeds
- **THEN** the step outcome is `failed` with reason `app_not_ready`, the process output is stored as evidence, and the report shows every selected journey as `not_run`

### Requirement: Personas and credentials
Each persona SHALL be usable by the agent through a login tool that reads the named environment variables at run time, so the credential value never enters the prompt, the journey, the transcript or a screenshot. Password fields SHALL be masked in screenshots and video. When a journey's persona needs credentials and the variables are unset, the journey SHALL be `skipped` with reason `missing_credentials`.

#### Scenario: Credentials outside the prompt
- **WHEN** the agent logs in as persona `shopper`
- **THEN** the transcript records a `login(persona: shopper)` tool call with no credential value, and the screenshot of the login form shows the password field masked

#### Scenario: Missing credentials skip
- **WHEN** persona `admin` names `QA_ADMIN_PASSWORD` and the variable is unset
- **THEN** every journey using `admin` is `skipped` with reason `missing_credentials` and the run continues

### Requirement: Runtime isolation
The app, the browser and the harness SHALL run inside one fresh container per run from the paired QA runner image: local Docker when no endpoint is configured, otherwise the configured hosted runner. The app SHALL have no network egress; the harness SHALL reach only the model endpoint it is configured with.

#### Scenario: Local run without an endpoint
- **WHEN** `rio qa` runs with no endpoint and Docker available
- **THEN** the run uses the local QA runner image and the app receives no outbound network

#### Scenario: Docker unavailable
- **WHEN** `rio qa` runs with no endpoint and no reachable Docker daemon
- **THEN** the command exits with an actionable message, and `rio review` marks the QA step as deferred with reason `no_runtime` rather than failing

### Requirement: Snapshot materialization and teardown
Repository contents SHALL be materialized inside the container from the snapshot, never bind-mounted from the developer's working tree. The container SHALL be destroyed when the run ends, including after a timeout or an interruption.

#### Scenario: Working tree not mounted
- **WHEN** a local run starts
- **THEN** the container has no bind mount of the repository and the app runs from the materialized head snapshot

#### Scenario: Interrupted run
- **WHEN** the developer presses Ctrl-C during a journey
- **THEN** the container is removed, evidence captured so far stays in the cache, and the report is partial

### Requirement: Harness credentials
The codex harness SHALL authenticate either with the developer's own subscription credentials mounted read-only in a local run, or with the Rio AI Gateway through an OpenAI-compatible provider configuration and a run-scoped token; the pi harness SHALL use the gateway. Hosted runs SHALL use the gateway path only. The configured path SHALL be shown by `rio doctor` and recorded in the run record without secret values.

#### Scenario: Hosted codex uses the gateway
- **WHEN** a hosted QA run uses harness `codex`
- **THEN** the harness is configured with the gateway base URL and a token scoped to the run's budget, and no subscription credential is present in the container

#### Scenario: Local subscription reuse
- **WHEN** a local run uses harness `codex` and the developer's codex credentials are present
- **THEN** they are mounted read-only, the run record notes `harness_auth: subscription`, and no value is copied into the cache

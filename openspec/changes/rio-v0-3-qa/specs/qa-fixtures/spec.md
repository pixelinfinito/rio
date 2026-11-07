# Spec Delta

## Purpose

Run fixtures are everything a journey needs besides stored data: files to upload, doubles for the external services the app calls, captured outbound mail, SMS and webhooks, and controlled time, locale, geolocation and network conditions, defined once and reused across runs.

## ADDED Requirements

### Requirement: Fixture manifest
Fixtures SHALL be declared in `.rio/qa/fixtures/fixtures.yaml` with `version: 1` and the optional blocks `files[]`, `services[]`, `capture` and `defaults` (time, timezone, locale, geolocation, network). The schema SHALL be published as `schemas/qa-fixtures-v1.json`; unknown keys SHALL be rejected. The manifest and small committed files SHALL be part of the seed fingerprint, so generated fixtures are cached with the seed snapshot.

#### Scenario: Manifest validates
- **WHEN** `fixtures.yaml` declares two upload files, an `http-mock` service for payments, an `smtp-capture` mailbox and `defaults.timezone: Europe/Lisbon`
- **THEN** `rio qa validate` accepts it and `rio qa fixtures status` lists each entry and whether it is committed, generated or captured

### Requirement: Upload files
`files[]` SHALL declare `name`, and either `path` (a committed file under `.rio/qa/fixtures/files/`, at most 1 MiB) or `generate` (`kind` from `image`, `pdf`, `csv`, `json`, `text`, `binary`, with `size`, dimensions or rows). Generated files SHALL be produced at seed build, stored in the seed snapshot and restored with it. The harness `upload_fixture(name)` tool SHALL resolve names from this list only.

#### Scenario: Large generated file
- **WHEN** `files[]` declares `{ name: big-import, generate: { kind: csv, rows: 200000 } }`
- **THEN** the file is generated once at seed build, restored on later runs, and `upload_fixture(big-import)` attaches it without a host path

#### Scenario: Oversized committed file rejected
- **WHEN** `path` points to a 3 MiB image
- **THEN** validation fails stating the limit and suggesting `generate`

### Requirement: Service doubles
`services[]` SHALL declare `name`, `kind` (`http-mock`, `smtp-capture`, `sms-capture`, `webhook-sink`, `oauth-provider`, `s3`, `custom`), the `env` variables that point the app at the double, and for `http-mock` a `recordings` directory of request matchers with canned responses and named `behaviors`. Doubles SHALL start inside the container before the app and SHALL be the only reachable hosts for the app.

#### Scenario: Payment double
- **WHEN** a service declares `kind: http-mock`, `env: { PAYMENTS_API_BASE: "{{url}}" }`, recordings for `POST /v1/charges` and behaviors `approve` and `decline`
- **THEN** the app's charge call is answered from the recording, and the harness can switch the behavior to `decline` for a step

#### Scenario: Undoubled dependency
- **WHEN** the app attempts to reach `api.example.com` and no service double claims that host
- **THEN** the connection is refused, the step's network log records `blocked_egress: api.example.com`, and the footer lists the host under `undoubled dependencies`

### Requirement: Captured outbound messages
`capture` SHALL be able to enable `mail` (SMTP), `sms` and `webhooks`. Captured messages SHALL be stored as evidence per step and exposed to the harness through `read_mail(persona)`, `read_sms(persona)` and `read_webhooks(service)`, which return the latest messages with links extracted, so journeys can follow verification and reset links.

#### Scenario: Registration verification link
- **WHEN** a registration step says to open the verification email
- **THEN** the harness calls `read_mail(shopper)`, receives the captured message with its link, navigates to it, and the message is stored as evidence for the step

### Requirement: Controlled context
`defaults` and a journey's `context` SHALL be able to set `time` (a fixed instant, applied to the browser clock and offered to the app through `QA_FAKE_TIME`), `timezone`, `locale`, `geolocation` and `network` (`online`, `slow-3g`, `offline`). Journey `context` SHALL override `defaults`, and the harness SHALL be able to change `network` and `geolocation` within a step.

#### Scenario: Offline step
- **WHEN** a step says to go offline and retry the save
- **THEN** the harness sets `network: offline`, the app's request fails in the network log, and the step evidence records the condition

#### Scenario: Fixed time
- **WHEN** a journey declares `context.time: 2026-12-31T23:59:00Z`
- **THEN** the browser clock and `QA_FAKE_TIME` report that instant and the app's countdown renders accordingly

### Requirement: Service behaviors per step
The harness SHALL have a `set_service_behavior(service, behavior)` tool limited to behaviors declared in the manifest. Behavior changes SHALL be recorded in the transcript and reset at the start of each journey.

#### Scenario: Decline then approve
- **WHEN** a journey sets `payments` to `decline`, observes the error, then sets `approve` and retries
- **THEN** both behaviors are visible in the transcript and the next journey starts with the manifest's default behavior

### Requirement: Fixture authoring on init
`rio qa init` SHALL detect external dependencies from environment variables, SDK imports and outbound hosts seen during the first app start, propose a double for each with recordings written from the SDK's documented response shapes, and write the manifest for the developer to review. Doubles SHALL never be authored with real credentials, and a detected dependency left undoubled SHALL be listed in the init summary.

#### Scenario: Stripe detected
- **WHEN** the app imports the Stripe SDK and reads `STRIPE_SECRET_KEY`
- **THEN** init proposes an `http-mock` named `stripe` with recordings for the calls the app makes and an `env` override for the API base, and the summary lists any remaining undoubled dependency

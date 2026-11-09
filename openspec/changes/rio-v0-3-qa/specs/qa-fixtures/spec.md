# Spec Delta

## Purpose

Run fixtures are everything a journey needs besides stored data: files to upload, doubles for the external services the app calls, captured outbound mail, SMS and webhooks, and controlled time, locale, geolocation and network conditions, defined once and reused across runs.

## ADDED Requirements

### Requirement: Fixture manifest
Fixtures SHALL be declared in `.rio/qa/fixtures/fixtures.yaml` with `version: 1` and the optional blocks `files[]`, `services[]`, `capture` and `defaults` (time, timezone, locale, geolocation, network). The schema SHALL be published as `schemas/qa-fixtures-v1.json`; unknown keys SHALL be rejected. The manifest and committed fixture files SHALL be part of the seed fingerprint.

#### Scenario: Manifest validates
- **WHEN** `fixtures.yaml` declares two upload files, an `http-mock` service for payments, an `smtp-capture` mailbox and `defaults.timezone: Europe/Lisbon`
- **THEN** `rio qa validate` accepts it and `rio qa fixtures status` lists each entry and whether it is committed, generated or captured

### Requirement: Upload files
`files[]` SHALL declare `name`, and either `path` (a committed file under `.rio/qa/fixtures/files/`, at most 1 MiB) or `generate` (`kind` from `image`, `pdf`, `csv`, `json`, `text`, `binary`, with `size`, dimensions or rows). Generated files SHALL be produced at seed build, stored in the seed snapshot under the `files` kind and restored with it. `upload_fixture(name)` SHALL resolve names from this list only.

#### Scenario: Large generated file
- **WHEN** `files[]` declares `{ name: big-import, generate: { kind: csv, rows: 200000 } }`
- **THEN** the file is generated once at seed build, restored on later runs, and `upload_fixture(big-import)` attaches it without a host path

#### Scenario: Oversized committed file rejected
- **WHEN** `path` points to a 3 MiB image
- **THEN** validation fails stating the limit and suggesting `generate`

### Requirement: Service doubles
`services[]` SHALL declare `name`, `kind` (`http-mock`, `smtp-capture`, `sms-capture`, `webhook-sink`, `oauth-provider`, `s3`, `custom`), the `env` variables that point the app at the double, optional `claims[]` (hostnames the double answers for), and for `http-mock` a `recordings` directory of request matchers with canned responses and named `behaviors`. Doubles SHALL start inside the app container before the app.

#### Scenario: Payment double by URL
- **WHEN** a service declares `kind: http-mock`, `env: { PAYMENTS_API_BASE: "{{url}}" }`, recordings for `POST /v1/charges` and behaviors `approve` and `decline`
- **THEN** the app's charge call is answered from the recording, and the harness can switch the behavior to `decline` for a step

#### Scenario: Undoubled dependency
- **WHEN** the app attempts to reach `api.example.com` and no double claims that host
- **THEN** the connection is refused, the step's network log records `blocked_egress: api.example.com`, and the footer lists the host under `undoubled dependencies`

### Requirement: Host claims and TLS
A double with `claims[]` SHALL answer for those hostnames: the app image entrypoint SHALL write the hosts mapping before dropping privileges, and the double SHALL serve HTTPS with a run-generated certificate authority installed in the container trust store and exported through `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` and `REQUESTS_CA_BUNDLE`. Claims on ports other than 443 and 80 SHALL be rejected by validation. Apps that pin certificates SHALL be reported as undoubled.

#### Scenario: Hard-coded provider host
- **WHEN** a service declares `claims: [api.stripe.com]`
- **THEN** the app's HTTPS call to `https://api.stripe.com/v1/charges` reaches the double with a trusted certificate

#### Scenario: Pinned certificate
- **WHEN** the app rejects the run certificate authority for a claimed host
- **THEN** the network log records `tls_pinned: api.example.com`, the footer lists the host as undoubled, and journeys depending on it skip with `precondition_failed`

### Requirement: Captured outbound messages
`capture` SHALL be able to enable `mail` (SMTP), `sms` and `webhooks`. Captured messages SHALL be stored as sanitized step evidence and exposed to the harness during the run through `read_mail(persona)`, `read_sms(persona)` and `read_webhooks(service)`, which return the latest messages with links extracted, so journeys can follow verification and reset links.

#### Scenario: Registration verification link
- **WHEN** a registration step says to open the verification email
- **THEN** the harness calls `read_mail(shopper)`, receives the captured message with its link, navigates to it, and the message is stored as evidence for the step

### Requirement: Controlled context
`defaults` and a journey's `context` SHALL be able to set `time` (a fixed instant applied to the browser clock and offered to the app through `QA_FAKE_TIME`), `timezone`, `locale`, `geolocation` and `network` (`online`, `slow-3g`, `offline`). Journey `context` SHALL override `defaults`, and the harness SHALL be able to change `network` and `geolocation` within a step; every change SHALL be a replay event.

#### Scenario: Offline step
- **WHEN** a step says to go offline and retry the save
- **THEN** the harness sets `network: offline`, the app's request fails in the network log, and the step evidence records the condition

#### Scenario: Fixed time
- **WHEN** a journey declares `context.time: 2026-12-31T23:59:00Z`
- **THEN** the browser clock and `QA_FAKE_TIME` report that instant and the app's countdown renders accordingly


### Requirement: Chain time compatibility
Each journey SHALL resolve time against fixture defaults independently of its predecessors. Every chain member SHALL resolve to the same instant or all leave time unset. Validation SHALL compare normalized instants, accept equivalent UTC offsets, and reject different instants or fixed/live mismatches, including proposed replacements.

#### Scenario: Different fixed times in a chain
- **WHEN** checkout follows add-to-cart and their effective fixed times differ
- **THEN** validation rejects the chain before application startup, naming the incompatible dependency

#### Scenario: Shared default and equivalent instants
- **WHEN** fixtures default to `2026-12-31T23:59:00Z`, add-to-cart inherits that time, and checkout overrides it with `2027-01-01T00:59:00+01:00`
- **THEN** the chain validates and both browser and app use the same fixed instant without restarting between journeys

#### Scenario: Fixed and live time cannot share a chain
- **WHEN** no fixture time is set, the chain head fixes its time, and a dependent leaves its time unset
- **THEN** validation rejects the mismatch; an omitted time does not inherit the predecessor's override

#### Scenario: Proposed replacement invalidates chain time
- **WHEN** a proposed replacement changes the effective time of a journey while its dependency or dependent keeps a different time
- **THEN** validation rejects the proposal and identifies the affected chain relationship

### Requirement: Service behaviors per step
The harness SHALL have a `set_service_behavior(service, behavior)` tool limited to behaviors declared in the manifest. Behavior changes SHALL be replay events, recorded in the transcript, and reset to the manifest default at the start of each chain.

#### Scenario: Decline then approve
- **WHEN** a journey sets `payments` to `decline`, observes the error, then sets `approve` and retries
- **THEN** both behaviors are visible in the transcript and replay log, and the next chain starts with the default behavior

### Requirement: Fixture authoring on init
`rio qa init` SHALL detect external dependencies from environment variables, SDK imports and outbound hosts blocked during the first app start, propose a double for each with recordings written from the SDK's documented response shapes, and write the manifest for the developer to review. Doubles SHALL never be authored with real credentials, and a detected dependency left undoubled SHALL be listed in the init summary.

#### Scenario: Stripe detected
- **WHEN** the app imports the Stripe SDK and reads `STRIPE_SECRET_KEY`
- **THEN** init proposes an `http-mock` named `stripe` with `claims: [api.stripe.com]`, recordings for the calls the app makes, and the summary lists any remaining undoubled dependency

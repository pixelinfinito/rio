# qa-evidence Specification

## Purpose

QA evidence is the set of browser artifacts that make a journey outcome and a QA finding inspectable, sanitized before storage, stored outside tracked paths, linked from the report and retained for a bounded time.

## Requirements

### Requirement: Evidence kinds
Each cell run SHALL produce per-step artifacts (screenshot, DOM and accessibility snapshot, console log, network log, captured messages) and per-cell artifacts (sanitized trace, replay event log, harness transcript), all listed in a manifest with content hash, size, kind, journey, step, viewport and color scheme. Video SHALL be produced only when `evidence.video` is on.

#### Scenario: Artifact formats
- **WHEN** a cell completes
- **THEN** screenshots are `png`, DOM snapshots `json`, console, network, replay and transcript logs `jsonl`, the trace `zip`, video `webm` and the manifest `json`

#### Scenario: Manifest lists everything
- **WHEN** a journey with five steps completes in two cells
- **THEN** the manifest lists ten step screenshots plus an initial screenshot for each journey in each cell, ten DOM snapshots, ten console logs, ten network logs, two traces, two replay logs and two transcripts, each with a content hash

### Requirement: Storage location
Local runs SHALL store evidence under `<cache>/<review-id>/runs/<run-id>/qa/<journey>/<viewport>-<scheme>/`, inheriting the cache's permissions, pruning and size limits. Hosted runs SHALL stream evidence from the controller container to the hosted store under `qa/<tenant>/<review-id>/<run-id>/` as it is produced, so an interrupted run keeps the evidence captured before interruption. Evidence SHALL be written only under the git-ignored cache directory or the hosted store, never to a tracked path.

#### Scenario: Interrupted hosted run
- **WHEN** a hosted run is cancelled after two chains
- **THEN** the artifacts of those chains are present in the store and referenced by the partial report

#### Scenario: Local evidence stays out of git
- **WHEN** `rio qa` runs locally
- **THEN** `git status` shows no new files and every artifact lives under the cache directory

### Requirement: Sanitization of text artifacts
The secrets catalog and the report's redaction SHALL be applied to transcripts, replay logs, console logs, network logs, DOM snapshots and captured messages before storage. Network entries SHALL have request and response bodies truncated to 16 KiB, `authorization`, `cookie`, `set-cookie` and `x-api-key` headers replaced by `[redacted]`, and query parameters named like secrets or tokens replaced by `[redacted]`.

#### Scenario: Token in a response body
- **WHEN** a login response body contains a bearer token
- **THEN** the stored network log shows the token redacted

#### Scenario: Verification link in captured mail
- **WHEN** a captured email contains a one-time link
- **THEN** the stored message keeps the link path but redacts the token query parameter, while the harness tool returned the full link during the run

### Requirement: Trace sanitization fails closed
Rio SHALL NOT store a raw trace. It SHALL unpack the trace, apply the text sanitization to every member (network entries, action arguments, URLs, embedded DOM snapshots), drop response bodies, repack it and hash the result. If any member cannot be parsed and sanitized, the trace SHALL be dropped and the footer SHALL record `evidence_unsanitized` for that cell.

#### Scenario: Trace member redacted
- **WHEN** the agent typed a one-time code into a field during a step
- **THEN** the stored trace's action entry shows the typed value redacted

#### Scenario: Unparseable member
- **WHEN** a trace member has an unknown format
- **THEN** no trace is stored for that cell, the step screenshots and DOM snapshots remain, and the footer lists `evidence_unsanitized`

#### Scenario: Modified stylesheet captured in a trace
- **WHEN** a recognized Playwright frame snapshot references a modified CSS stylesheet resource
- **THEN** Rio decodes and sanitizes that CSS text, preserves the snapshot reference, drops network response-body references, and still drops the trace for an unknown resource format, missing referenced stylesheet, or invalid text encoding

### Requirement: Visual masking at the source
Password fields and elements marked `data-rio-mask` SHALL be masked by a stylesheet injected into every browser context for its whole life, so screenshots and continuous video are masked at capture time. A seeded-secret test SHALL scan the whole evidence bundle, including video frames sampled per second, before the bundle is accepted.

#### Scenario: Masked video
- **WHEN** video is on and the agent types a password
- **THEN** no sampled frame contains the password characters and the field renders as discs

### Requirement: Linking from the report
Each cell outcome and QA finding occurrence SHALL reference its evidence by artifact id. Terminal and Markdown renderers SHALL show local paths for local runs and time-limited signed URLs (default 7 days) for hosted runs; JSON SHALL carry the artifact ids, the storage kind and the link. A signed URL SHALL grant read access to one object only.

#### Scenario: Markdown with hosted evidence
- **WHEN** a hosted QA finding is rendered as Markdown
- **THEN** its screenshot and trace are links to signed URLs that expire, each scoped to one object

### Requirement: Retention
Hosted evidence SHALL record an immutable expiry for each run from `evidence.retention_days` in `.rio/qa.yaml` (default 30), measured from run creation. Signed reads and uploads SHALL stop at expiry, and the run record SHALL state the expiry date. Local evidence SHALL follow review cache pruning rules. `rio qa evidence prune --review ID` SHALL delete hosted evidence for one review on demand.

#### Scenario: Expired evidence
- **WHEN** a report older than the retention period is rendered from the cache
- **THEN** evidence links are rendered as expired with the expiry date instead of a signed URL

#### Scenario: Different run retention periods
- **WHEN** two runs configure retention of 2 and 30 days
- **THEN** scheduled deletion removes only expired objects, each run retains its original expiry, and failed deletions are retried with reads still denied

### Requirement: Scheduled expiry deletion
The Worker SHALL run scheduled deletion every minute, removing expired objects in bounded batches and retrying failed deletions without starving later expiries. Deletion MAY complete after expiry while reads remain denied. `rio init` and `rio deploy` SHALL install this schedule using existing Worker and R2 data bindings without bucket-management credentials.

#### Scenario: Deletion retry
- **WHEN** R2 deletion fails for an expired artifact
- **THEN** reads remain denied and a subsequent scheduled sweep retries its deletion without blocking other expired objects

### Requirement: Report evidence link mapping
The report's `qa.evidence.artifacts[]` SHALL map artifact ids to display links and optional expiry timestamps in epoch milliseconds. Authenticated hosted report reads SHALL refresh links from tenant/review-owned stored objects. Cached renderers SHALL omit expired links and distinguish artifact expiry from link expiry.

#### Scenario: Retained artifact with an expired download link
- **WHEN** a cached signed link has expired but the artifact is still retained
- **THEN** the renderer labels the download link expired and directs the user to refresh it from the endpoint

# Spec Delta

## Purpose

QA evidence is the set of browser artifacts that make a journey outcome and a QA finding inspectable, stored outside the repository, redacted, linked from the report and retained for a bounded time.

## ADDED Requirements

### Requirement: Evidence kinds
Each journey run SHALL produce, per step: a screenshot (`png`), a DOM and accessibility snapshot (`json`), the console log and the network log since the previous step (`jsonl`); per journey: a Playwright trace (`zip`), the harness transcript (`jsonl`) and a run manifest (`json`) listing every artifact with its content hash, size, kind, journey, step, viewport and color scheme. Video (`webm`) SHALL be produced only when `evidence.video` is on.

#### Scenario: Manifest lists everything
- **WHEN** a journey with five steps completes in two viewports
- **THEN** the manifest lists ten screenshots, ten DOM snapshots, ten console logs, ten network logs, two traces and one transcript, each with a content hash

### Requirement: Storage location
Local runs SHALL store evidence under `<cache>/<review-id>/runs/<run-id>/qa/<journey>/<viewport>-<scheme>/`, inheriting the cache's permissions, pruning and size limits. Hosted runs SHALL stream evidence to R2 under `qa/<tenant>/<review-id>/<run-id>/` as it is produced, so an interrupted run keeps the evidence captured before interruption. Evidence SHALL be written only under the git-ignored cache directory or the hosted store, never to a tracked path.

#### Scenario: Interrupted hosted run
- **WHEN** a hosted run is cancelled after two journeys
- **THEN** the artifacts of those two journeys are present in R2 and referenced by the partial report

#### Scenario: Local evidence stays out of git
- **WHEN** `rio qa` runs locally
- **THEN** `git status` shows no new files and every artifact lives under the cache directory

### Requirement: Redaction before storage
The secrets catalog and the report's redaction SHALL be applied to transcripts, console logs, network logs and DOM snapshots before storage. Request and response bodies in the network log SHALL be truncated to 16 KiB and headers named `authorization`, `cookie` and `set-cookie` SHALL be replaced by `[redacted]`. Screenshots and video SHALL mask password fields and elements marked `data-rio-mask`.

#### Scenario: Token in a response body
- **WHEN** a login response body contains a bearer token
- **THEN** the stored network log shows the token redacted and the trace is stored without response bodies

### Requirement: Linking from the report
Each journey outcome and QA finding SHALL reference its evidence by artifact id. Terminal and Markdown renderers SHALL show local paths for local runs and time-limited signed URLs (default 7 days) for hosted runs; JSON SHALL carry the artifact ids, the storage kind and the link. A signed URL SHALL grant read access to one object only.

#### Scenario: Markdown with hosted evidence
- **WHEN** a hosted QA finding is rendered as Markdown
- **THEN** its screenshot and trace are links to signed URLs that expire, each scoped to one object

### Requirement: Retention
Hosted evidence SHALL be deleted by a bucket lifecycle rule after `evidence.retention_days` from `.rio/qa.yaml` (default 30), and the run record SHALL state the expiry date. Local evidence SHALL follow the review cache pruning rules. `rio qa evidence prune --review ID` SHALL delete hosted evidence for one review on demand.

#### Scenario: Expired evidence
- **WHEN** a report older than the retention period is rendered from the cache
- **THEN** evidence links are rendered as expired with the expiry date instead of a signed URL

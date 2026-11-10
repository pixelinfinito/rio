# review-report Specification

## Purpose

The report is the product: the ordered, evidence-first presentation of a review in the terminal, in Markdown and in JSON, together with the on-disk record that makes a run inspectable and reproducible.

## Requirements

### Requirement: Section order
Every format SHALL present sections in this order: header (review id, run id, mode, base and head identifiers, profile name and chain, Rio version, status `complete`, `incomplete` or `partial`); deterministic results grouped by check kind, with each root's outcome; impact summary; findings (new, worsened and unclassified defects); risks; security findings when present; QA results when the QA step ran or was selected (a per-cell grid per journey with outcome, step reached and evidence links, then QA findings ordered like other findings, with probe findings and verified observations distinguished from unverified observations, followed by UX recommendations and assessment coverage); summary counts (pre-existing, fixed, suppressed); footer (skipped checks, deferred steps, excluded files, size notes, tool versions, timings). Sections with nothing to show SHALL be omitted except the header, the findings statement and the footer.

#### Scenario: No findings
- **WHEN** a review produces no findings and no risks
- **THEN** the report contains the header, a line stating that no findings were produced, and the footer

#### Scenario: No findings but incomplete
- **WHEN** a review produces no findings and the coverage check ended `cancelled` with reason `timeout`
- **THEN** the header status is `incomplete`, and the findings statement says that no findings were produced and that coverage did not complete

#### Scenario: QA section with a failed journey
- **WHEN** QA ran three journeys in two cells, one failed at step 4 in `mobile` `dark`, and two probe findings fired
- **THEN** the QA section shows a grid per journey with one cell per viewport and scheme, names step 4 in the failed cell with its evidence links, and lists the two findings as `static_proven`

#### Scenario: Unverified observations labeled
- **WHEN** QA ran locally without an endpoint and the agent reported two observations
- **THEN** the QA section shows them under an `unverified observations` heading, never as findings, with their evidence links

### Requirement: Finding ordering
Within the findings section, findings SHALL be ordered by severity, then evidence level, then path and line. Agent findings SHALL be selected for presentation by impact and evidence before the section is rendered, with stable tie-breaking. Deterministic ordering SHALL remain unchanged. Findings matching either the profile or applicable security `fail_on` policy SHALL be marked as such.

#### Scenario: Errors before warnings
- **WHEN** a review has a lint warning in `a.ts` and a type error in `z.ts`
- **THEN** the type error is listed first

### Requirement: Finding presentation
Each rendered finding SHALL show rule id, state, evidence level, location with enclosing symbol, message, trigger when known, and suggested fix when present. Verified agent findings SHALL additionally show agreeing versus configured voters, the per-voter blind-match summary, and any split flag without a numeric confidence score. Secret values SHALL appear redacted. Pre-existing findings SHALL be available in full through `--show-pre-existing`.

#### Scenario: Pre-existing on request
- **WHEN** `rio review --show-pre-existing` is run on a change with pre-existing type errors
- **THEN** those errors are listed in a dedicated section after the risks

### Requirement: Terminal renderer
The terminal renderer SHALL stream check results as they complete, use color only when standard output is a terminal and `NO_COLOR` is unset and `--no-color` is absent, and SHALL fit within the terminal width without wrapping finding locations.

#### Scenario: Narrow terminal
- **WHEN** the terminal is 80 columns wide
- **THEN** every location line is at most 80 columns, truncating the message rather than the path

### Requirement: Markdown renderer
The Markdown renderer SHALL produce a document with stable headings for each section, one table or list per check kind, and findings as list items with code-formatted locations, suitable for pasting into a pull request description.

#### Scenario: Stable headings
- **WHEN** two reviews are rendered as Markdown
- **THEN** both use the same heading text for the same sections

### Requirement: JSON renderer
The JSON renderer SHALL emit a single document `{ "schema": "rio-report-v1", "status": "...", "review": {...}, "risk_tier": {...} | null, "checks": [...], "impact": {...}, "findings": [...], "risks": [...], "security": [...], "incomplete": [...], "deferred": [...], "excluded": [...], "metrics": {...}, "error": {...} }` that validates against `schemas/report-v1.json`. `risk_tier` is `{ tier: low | medium | high, reasons: [string], source: always_human | triage }`; it is populated by endpoint triage when available, or by a local `always_human` match, and it is never an approval. `status` takes the values defined by the review CLI capability, and `error` is present only when `status` is `error`. Each `checks` entry SHALL carry kind, language, root, version, whether the root was scheduled as `changed` or `dependent`, outcome, reason, hint, `dependency_state` (`verified` or `trusted`) and wall time. `incomplete` lists the checks whose outcome is `failed`, `skipped` or `cancelled`. Findings use the finding-v1 form, and `metrics` includes per-check wall time and tool versions plus separately accounted verification usage and cost when available. The new security collection SHALL be optional for historical documents and omitted when unused. For `no_changes` and `error`, the existing required arrays SHALL be present and empty when nothing ran; security remains optional.

#### Scenario: Risk tier from an always-human path
- **WHEN** a change edits a file matching the profile's `always_human` globs and the review is rendered as JSON
- **THEN** `risk_tier.tier` is `high`, `risk_tier.source` is `always_human`, and the terminal header shows the tier with its reason

#### Scenario: Metrics present
- **WHEN** a review is rendered as JSON
- **THEN** `metrics` contains the wall time of each check that ran and the total wall time

### Requirement: Footer content
The footer SHALL always list: each `failed`, `skipped` or `cancelled` check with its outcome, reason and hint; a statement when any result used trusted dependencies; coverage files listed as `coverage_excluded` or `coverage_not_instrumented`; each deferred step with the reason `no_endpoint` or `no_runtime`; excluded files with reasons; a size note when `max_lines` is exceeded; graph truncation when it occurred; the counts of suppressed findings per suppression entry; category-floor drops by category; held-back agent counts and titles by pool with guidance to run `--deep` or raise `max_defects`; fork static-only restrictions; deferred board coordination when applicable; for lineage reviews, the round number, the lineage's cap state, the repository's author-response ratio when any response exists, and the count of findings held back as already posted; and, when QA was selected, the journeys selected with reasons, the cell count and estimate, journeys held back, dropped observations, disabled, adopted and added rules, the harness and authentication path, the isolation and egress policy, seed restored or built with durations, undoubled dependencies, evidence storage, quota and expiry, cells with `evidence_unsanitized`, and QA wall time and cost. It SHALL also list: the count of remembered findings with their reasons and the review or pull request that dismissed them; open suppression proposals with their entries and evidence counts; the agent cache hit rate when the agents step ran; the publication outcome (policy, posted, edited, resolved and unanchored counts, failures with a note that they are retried on the next round, or the note that an `ask` policy on a webhook-triggered review posted the check run only); and, when the security step ran, the catalog items assessed and the unassessed items with their reasons.


#### Scenario: Deferred steps explained
- **WHEN** a review runs with no endpoint
- **THEN** the footer lists `triage`, `agents` and `verify` as deferred with reason `no_endpoint`

#### Scenario: Lineage footer
- **WHEN** the third round of a lineage holds back two already-posted findings in a repository with author-response ratio 0.6
- **THEN** the footer shows round 3 of cap 3, the ratio 0.6 and two held-back findings

#### Scenario: QA footer
- **WHEN** QA ran in changed mode with harness `codex` through the gateway on the Docker runner with a restored seed
- **THEN** the footer lists each selected journey with its reason, the cell count, `harness: codex (gateway)`, `isolation: pod`, `seed: restored (2.1 s)`, the evidence location and expiry, and the QA wall time and cost

### Requirement: Review cache
Each run SHALL write its record to `<cache>/<review-id>/runs/<run-id>/`. The record contains `report.json`, `profile.resolved.yaml`, `graph/{base,head,delta}.json`, `owner_guidance.json` (every `REVIEW.md`, `CLAUDE.md` and `AGENTS.md` between the repository root and each changed file's directory, as `[{path, scope_dir, content_hash, lines[]}]`, stored as data and consumed by agent and verifier prompts when the endpoint runtime is available), per-hypothesis blind answers, vote results, verification artifact references and token/cost records when verification runs, and `checks/<kind>/<root>/`, which holds the raw tool output and the parsed findings. When the run finishes, it SHALL atomically replace `<cache>/<review-id>/latest` so that the file names the newest finished run. `<cache>` is the configured cache directory (default `.rio/cache`). Snapshots SHALL be stored under `<cache>/snapshots/`, base materializations and baseline results under `<cache>/baselines/`, head materializations under `<cache>/heads/`, and OSV advisory records under `<cache>/osv/`. The system SHALL create `<cache>/.gitignore` containing `*` so the cache is never committed.

The cache SHALL be safe under concurrent runs and interruption:
- every entry is written under a temporary name in the same directory and published by an atomic rename. A reader never sees a partially written entry. When a content-addressed entry already exists, the run discards its own copy and uses the existing one;
- building a shared entry (snapshot, materialization, baseline result, advisory record) takes an exclusive advisory lock on that entry, so concurrent runs build it once and the others wait for it, bounded by the check's timeout;
- each live run holds a lock on its own run marker and records the shared entries it uses;
- pruning takes a single prune lock and is skipped when another run holds it. It never removes an entry that a live run references or a temporary file that belongs to a live run. It removes temporary files and run markers left by runs whose lock is no longer held, which recovers from interrupted writes.

Pruning SHALL run at the start of a run and remove: run records older than `cache.max_age` (default 30 days); review directories left with no runs; snapshots, head materializations and advisory records that no remaining run references; and baselines whose base commit is unreachable from every local ref. It SHALL then evict the least recently used entries until the cache is within `cache.max_size`.

Cached evidence holds copies of source code and tool output, so the cache directory SHALL be created readable only by the current user (mode `0700` on Unix, with files `0600`). Before raw tool output is stored, the secrets catalog SHALL be applied to it with the report's redaction. With `cache.retain_raw_output: false`, raw output SHALL not be stored at all. Retained raw output SHALL be truncated to 16 MiB per stream, keeping its head and its tail with a truncation marker. Parsers read the full stream up to `run.output_limit`, beyond which the check ends `failed` with reason `output_limit`. A failed write due to a full disk SHALL end the affected check `failed` with reason `disk_full`, or stop the review with exit 3 when the run record itself cannot be written.

#### Scenario: Cache ignored by git
- **WHEN** the first review runs in a repository
- **THEN** `.rio/cache/.gitignore` exists with content `*`, `git status` shows no cache files, and the cache directory is readable only by the current user

#### Scenario: Concurrent runs keep separate records
- **WHEN** two runs of the same review id finish at nearly the same time
- **THEN** both run directories exist with complete `report.json` files, and `latest` names one of them

#### Scenario: Pruning spares a live run
- **WHEN** a run starts pruning while another run is still using an expired head materialization
- **THEN** that materialization is not removed

#### Scenario: Recovery after a crash
- **WHEN** a run is killed while writing a baseline result, and a later run starts
- **THEN** the later run never reads the incomplete result, and pruning removes the leftover temporary file

#### Scenario: Secret in raw tool output
- **WHEN** a test prints a value that matches the AWS access key pattern
- **THEN** the stored raw output shows only the value's first four characters

#### Scenario: Owner guidance recorded
- **WHEN** the repository has a root `AGENTS.md` and `crates/core/REVIEW.md`, and a change edits `crates/core/src/lib.rs`
- **THEN** the run's `owner_guidance.json` lists both files in path order with their content hashes, and guidance content cannot directly alter policy or exclusions; only verified guidance hypotheses can become findings

#### Scenario: Raw output retained
- **WHEN** a type check runs
- **THEN** its standard output and standard error are stored under `checks/typecheck/<root>/` in the run's directory

### Requirement: Triage risk tier
Endpoint triage SHALL derive `risk_tier: { tier, reasons, source: triage }` deterministically from configured thresholds for sensitive paths, public-contract changes, dependency changes, missing coverage on changed logic and graph fan-out. Reasons SHALL identify the triggering signals. The tier SHALL feed agent and budget rules and be present in the JSON report. Existing local no-triage behavior SHALL remain available.

#### Scenario: Configured fan-out threshold
- **WHEN** graph fan-out crosses a configured high-risk threshold
- **THEN** triage emits high risk with the fan-out reason and risk rules observe that tier

#### Scenario: Deterministic triage output
- **WHEN** selected snapshots, signals and resolved risk thresholds are unchanged
- **THEN** repeated triage yields the same tier and reasons

### Requirement: Human-review override
A changed path matching `always_human` SHALL force high risk with source `always_human`, retain reasons identifying matching globs, and require human review even when other triage signals suggest lower risk. Rename matches SHALL consider both old and new paths.

#### Scenario: Override survives low-risk triage
- **WHEN** a changed installer matches `always_human` and triage would otherwise select low risk
- **THEN** the final tier is high with source always_human and the plan requires human review

#### Scenario: Renamed sensitive file
- **WHEN** a changed file's old path matches an always-human glob but its new path does not
- **THEN** the review still requires human review and records the matching glob

### Requirement: Security presentation and policy transparency
Verified security findings SHALL render in a separate security section with their evidence level and applicable policy match. Plausible entries SHALL be labeled as risks for human judgment. JSON SHALL preserve category security. Held-back counts SHALL identify the general or security pool and SHALL NOT be conflated with suppressions or category drops.

#### Scenario: Separate security section
- **WHEN** a report contains a deterministic defect, a general risk and a plausible security finding
- **THEN** each appears in its respective section and the security entry is visibly uncertain

### Requirement: Risk is not approval
Rio SHALL NOT turn a risk tier into an approval or a successful PR check conclusion. When publishing is available, the tier SHALL be exposed with a neutral conclusion and machine-readable reasons. SARIF field integration SHALL use the same tier contract when SARIF ships; implementing SARIF is outside this change.

#### Scenario: Low risk does not approve
- **WHEN** a published review has low triage risk and no open findings
- **THEN** Rio exposes the tier without creating an approval or a success conclusion

### Requirement: Auditable verification omissions
Report evidence SHALL retain enough information to distinguish refuted, split, invalid, failed and budget-exhausted verification outcomes. Failed or missing votes SHALL NOT be represented as successful verification. Footer notes SHALL identify verification limitations while preserving the existing report completeness policy.

#### Scenario: Voter timeout visible
- **WHEN** a voter times out and the remaining votes do not establish quorum
- **THEN** the audit records the timeout and the report does not claim a proven or refuted quorum

### Requirement: QA evidence in the run record
When the QA step runs, the run record SHALL additionally contain `qa/plan.json`, `qa/outcomes.json` and `qa/manifest.json`, plus the artifacts themselves for local runs. Hosted runs SHALL store artifact keys and expiry in the manifest instead of the artifacts. The record SHALL be pruned with the rest of the run record.

#### Scenario: Local record is complete
- **WHEN** a local QA run finishes
- **THEN** `qa/plan.json` lists selection reasons and cells, `qa/outcomes.json` has one entry per journey and cell, and every artifact in `qa/manifest.json` exists under `qa/<journey>/<viewport>-<scheme>/`

#### Scenario: Hosted record carries keys only
- **WHEN** a hosted QA run finishes
- **THEN** `qa/manifest.json` lists store keys and the expiry date and no screenshot is stored in the local cache

### Requirement: QA in JSON output
`report-v1` SHALL gain an optional `qa` object describing the run, with one entry per journey and one entry per cell within it. Verified QA findings SHALL appear in the report's `findings` array with category `ux`. The object's absence SHALL be valid when QA did not run.

#### Scenario: QA object shape
- **WHEN** the `qa` object is present
- **THEN** it carries `mode`, `harness`, `isolation`, `selection[]`, `journeys[]` (name, aggregate outcome, reason, `cells[]` with `viewport`, `color_scheme`, `outcome`, `reason`, `step_reached`, `evidence[]`), `observations_unverified[]`, `recommendations[]`, `assessment[]`, `guidance[]`, `seed` (`status`, `fingerprint`, `duration_ms`), `evidence` (`storage`, `expires_at`, `bytes`) and `cost`

#### Scenario: JSON validates with QA
- **WHEN** a review with QA is rendered as JSON
- **THEN** the document validates against `schemas/report-v1.json`, `qa.journeys[].cells` has one entry per cell, and QA findings are in `findings` with `category: ux`

### Requirement: UX recommendations and assessment coverage
Terminal, Markdown and JSON SHALL show UX recommendations separately from QA defects and journey outcomes, including passed journeys. Supported recommendations SHALL be distinguished from unverified and inconclusive candidates; rejected candidates SHALL remain only in the audit record. Reports SHALL show applicable guidance citations, rubric version, assessment coverage and held-back recommendation counts.

#### Scenario: Passed journey with improvement advice
- **WHEN** all journeys pass and one supported UX recommendation exists
- **THEN** the report shows the passes and the recommendation's observed friction, evidence, proposed improvement, expected benefit, trade-offs, priority and confidence without calling it a failed test

#### Scenario: Local recommendation is unverified
- **WHEN** QA produces a recommendation with no endpoint
- **THEN** the report labels it unverified, preserves its evidence, and notes deferred verification

### Requirement: Recommendation records in JSON and run cache
The JSON `qa` object SHALL additionally carry `recommendations[]`, `assessment[]` and `guidance[]`. Recommendation records SHALL preserve all candidate fields, verification status, rationale and any related finding id. The run record SHALL retain candidates and verification decisions in `qa/recommendations.json` and criterion coverage in `qa/assessment.json`, subject to the existing sanitization and retention rules.

#### Scenario: Structured output retains UX evidence
- **WHEN** a run has one supported and one rejected recommendation
- **THEN** JSON exposes the supported recommendation and assessment coverage while the audit record preserves both candidates and their decisions

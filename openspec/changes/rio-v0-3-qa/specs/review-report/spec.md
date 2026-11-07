# Spec Delta

## MODIFIED Requirements

### Requirement: Section order
Every format SHALL present sections in this order: header (review id, run id, mode, base and head identifiers, profile name and chain, Rio version, status `complete`, `incomplete` or `partial`); deterministic results grouped by check kind, with each root's outcome; impact summary; findings (new, worsened and unclassified defects); risks; security findings when present; QA results when the QA step ran or was selected (journeys with outcome, viewports, step reached and evidence links, then QA findings ordered like other findings, with probe findings and verified observations distinguished from unverified observations); summary counts (pre-existing, fixed, suppressed); footer (skipped checks, deferred steps, excluded files, size notes, tool versions, timings). Sections with nothing to show SHALL be omitted except the header, the findings statement and the footer.

#### Scenario: No findings
- **WHEN** a review produces no findings and no risks
- **THEN** the report contains the header, a line stating that no findings were produced, and the footer

#### Scenario: No findings but incomplete
- **WHEN** a review produces no findings and the coverage check ended `cancelled` with reason `timeout`
- **THEN** the header status is `incomplete`, and the findings statement says that no findings were produced and that coverage did not complete

#### Scenario: QA section with a failed journey
- **WHEN** QA ran three journeys, one failed at step 4 on mobile and two probe findings fired
- **THEN** the QA section lists the three journeys with outcomes and evidence links, names step 4 for the failed one, and lists the two findings as `static_proven`

#### Scenario: Unverified observations labeled
- **WHEN** QA ran locally without an endpoint and the agent reported two observations
- **THEN** the QA section shows them under an `unverified observations` heading, never as findings, with their evidence links

### Requirement: Footer content
The footer SHALL always list: each `failed`, `skipped` or `cancelled` check with its outcome, reason and hint; a statement when any result used trusted dependencies; coverage files listed as `coverage_excluded` or `coverage_not_instrumented`; each deferred step with the reason `no_endpoint` or `no_runtime`; excluded files with reasons; a size note when `max_lines` is exceeded; graph truncation when it occurred; the counts of suppressed findings per suppression entry; category-floor drops by category; held-back agent counts and titles by pool with guidance to run `--deep` or raise `max_defects`; fork static-only restrictions; deferred board coordination when applicable; and, when QA was selected, the journeys selected and the reason for each, journeys held back by `max_journeys`, dropped observations without evidence, disabled and project-added rules, the harness and authentication path used, the egress policy, evidence storage kind and expiry, and QA wall time and cost.

#### Scenario: Deferred steps explained
- **WHEN** a review runs with no endpoint
- **THEN** the footer lists `triage`, `agents` and `verify` as deferred with reason `no_endpoint`

#### Scenario: QA footer
- **WHEN** QA ran in changed mode with harness `codex` through the gateway
- **THEN** the footer lists each selected journey with its selection reason, `harness: codex (gateway)`, the evidence location and expiry, and the QA wall time and cost

## ADDED Requirements

### Requirement: QA evidence in the run record
When the QA step runs, the run record SHALL additionally contain `qa/plan.json`, `qa/outcomes.json` and `qa/manifest.json`, plus the artifacts themselves for local runs. Hosted runs SHALL store artifact keys and expiry in the manifest instead of the artifacts. The record SHALL be pruned with the rest of the run record.

#### Scenario: Local record is complete
- **WHEN** a local QA run finishes
- **THEN** `qa/plan.json` lists selection reasons, `qa/outcomes.json` has one entry per journey, viewport and color scheme, and every artifact in `qa/manifest.json` exists under `qa/<journey>/<viewport>-<scheme>/`

#### Scenario: Hosted record carries keys only
- **WHEN** a hosted QA run finishes
- **THEN** `qa/manifest.json` lists R2 keys and the expiry date and no screenshot is stored in the local cache

### Requirement: QA in JSON output
`report-v1` SHALL gain an optional `qa` object with `mode`, `harness`, `selection[]`, `journeys[]` (name, outcome, reason, viewports, step_reached, evidence ids), `observations_unverified[]`, `evidence` (`storage`, `expires_at`) and `cost`. Its absence SHALL be valid when QA did not run.

#### Scenario: JSON validates with QA
- **WHEN** a review with QA is rendered as JSON
- **THEN** the document validates against `schemas/report-v1.json` and `qa.journeys` has one entry per selected journey

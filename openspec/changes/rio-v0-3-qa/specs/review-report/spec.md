# Spec Delta

## MODIFIED Requirements

### Requirement: Section order
Every format SHALL present sections in this order: header (review id, run id, mode, base and head identifiers, profile name and chain, Rio version, status `complete`, `incomplete` or `partial`); deterministic results grouped by check kind, with each root's outcome; impact summary; findings (new, worsened and unclassified defects); risks; security findings when present; QA results when the QA step ran or was selected (a per-cell grid per journey with outcome, step reached and evidence links, then QA findings ordered like other findings, with probe findings and verified observations distinguished from unverified observations); summary counts (pre-existing, fixed, suppressed); footer (skipped checks, deferred steps, excluded files, size notes, tool versions, timings). Sections with nothing to show SHALL be omitted except the header, the findings statement and the footer.

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

### Requirement: Footer content
The footer SHALL always list: each `failed`, `skipped` or `cancelled` check with its outcome, reason and hint; a statement when any result used trusted dependencies; coverage files listed as `coverage_excluded` or `coverage_not_instrumented`; each deferred step with the reason `no_endpoint` or `no_runtime`; excluded files with reasons; a size note when `max_lines` is exceeded; graph truncation when it occurred; the counts of suppressed findings per suppression entry; category-floor drops by category; held-back agent counts and titles by pool with guidance to run `--deep` or raise `max_defects`; fork static-only restrictions; deferred board coordination when applicable; for lineage reviews, the round number, the lineage's cap state, the repository's author-response ratio when any response exists, and the count of findings held back as already posted; and, when QA was selected, the journeys selected with reasons, the cell count and estimate, journeys held back, dropped observations, disabled, adopted and added rules, the harness and authentication path, the isolation and egress policy, seed restored or built with durations, undoubled dependencies, evidence storage, quota and expiry, cells with `evidence_unsanitized`, and QA wall time and cost.

#### Scenario: Deferred steps explained
- **WHEN** a review runs with no endpoint
- **THEN** the footer lists `triage`, `agents` and `verify` as deferred with reason `no_endpoint`

#### Scenario: Lineage footer
- **WHEN** the third round of a lineage holds back two already-posted findings in a repository with author-response ratio 0.6
- **THEN** the footer shows round 3 of cap 3, the ratio 0.6 and two held-back findings

#### Scenario: QA footer
- **WHEN** QA ran in changed mode with harness `codex` through the gateway on the Docker runner with a restored seed
- **THEN** the footer lists each selected journey with its reason, the cell count, `harness: codex (gateway)`, `isolation: pod`, `seed: restored (2.1 s)`, the evidence location and expiry, and the QA wall time and cost

## ADDED Requirements

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
- **THEN** it carries `mode`, `harness`, `isolation`, `selection[]`, `journeys[]` (name, aggregate outcome, reason, `cells[]` with `viewport`, `color_scheme`, `outcome`, `reason`, `step_reached`, `evidence[]`), `observations_unverified[]`, `seed` (`status`, `fingerprint`, `duration_ms`), `evidence` (`storage`, `expires_at`, `bytes`) and `cost`

#### Scenario: JSON validates with QA
- **WHEN** a review with QA is rendered as JSON
- **THEN** the document validates against `schemas/report-v1.json`, `qa.journeys[].cells` has one entry per cell, and QA findings are in `findings` with `category: ux`

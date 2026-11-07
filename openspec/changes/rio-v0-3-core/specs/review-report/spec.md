# Spec Delta

## MODIFIED Requirements

### Requirement: JSON renderer
The JSON renderer SHALL emit a single document `{ "schema": "rio-report-v1", "status": "...", "review": {...}, "risk_tier": {...} | null, "checks": [...], "impact": {...}, "findings": [...], "risks": [...], "security": [...], "incomplete": [...], "deferred": [...], "excluded": [...], "metrics": {...}, "error": {...}, "publication": {...}, "cache": {...}, "suppression_proposals": [...] }` that validates against `schemas/report-v1.json`. `risk_tier` is `{ tier: low | medium | high, reasons: [string], source: always_human | triage }`; it is populated by endpoint triage when available, or by a local `always_human` match, and it is never an approval. `status` takes the values defined by the review CLI capability, and `error` is present only when `status` is `error`. Each `checks` entry SHALL carry kind, language, root, version, whether the root was scheduled as `changed` or `dependent`, outcome, reason, hint, `dependency_state` (`verified` or `trusted`) and wall time. `incomplete` lists the checks whose outcome is `failed`, `skipped` or `cancelled`. Findings use the finding-v1 form, and `metrics` includes per-check wall time and tool versions plus separately accounted verification usage and cost when available. The new security collection SHALL be optional for historical documents and omitted when unused. For `no_changes` and `error`, the existing required arrays SHALL be present and empty when nothing ran; security remains optional. The optional objects are: `publication` `{ policy, posted, edited, resolved, failed, unanchored, check_run_url, summary_comment_url }`, present when a publication step ran; `cache` `{ lookups, hits, hit_rate, tokens_saved_estimate }`, present when the agents step ran; and `suppression_proposals`, a list of `{ id, entry, evidence_count, since }` for the repository's open proposals. Each SHALL be omitted when unused.

#### Scenario: Risk tier from an always-human path
- **WHEN** a change edits a file matching the profile's `always_human` globs and the review is rendered as JSON
- **THEN** `risk_tier.tier` is `high`, `risk_tier.source` is `always_human`, and the terminal header shows the tier with its reason

#### Scenario: Metrics present
- **WHEN** a review is rendered as JSON
- **THEN** `metrics` contains the wall time of each check that ran and the total wall time

#### Scenario: Publication and cache objects
- **WHEN** a pull request review published under policy `auto` with two cache hits out of four lookups is rendered as JSON
- **THEN** `publication.policy` is `auto` with its counts and URLs, `cache.hits` is 2 and `cache.lookups` is 4, and a local review without publication or agents omits both objects

### Requirement: Footer content
The footer SHALL always list: each `failed`, `skipped` or `cancelled` check with its outcome, reason and hint; a statement when any result used trusted dependencies; coverage files listed as `coverage_excluded` or `coverage_not_instrumented`; each deferred step with the reason `no_endpoint`; excluded files with reasons; a size note when `max_lines` is exceeded; graph truncation when it occurred; the counts of suppressed findings per suppression entry; category-floor drops by category; held-back agent counts and titles by pool with guidance to run `--deep` or raise `max_defects`; fork static-only restrictions; deferred board coordination when applicable; and, for lineage reviews, the round number, the lineage's cap state, the repository's author-response ratio when any response exists, and the count of findings held back as already posted. It SHALL also list: the count of remembered findings with their reasons and the review or pull request that dismissed them; open suppression proposals with their entries and evidence counts; the agent cache hit rate when the agents step ran; the publication outcome (policy, posted, edited, resolved and unanchored counts, failures with a note that they are retried on the next round, or the note that an `ask` policy on a webhook-triggered review posted the check run only); and, when the security step ran, the catalog items assessed and the unassessed items with their reasons.

#### Scenario: Deferred steps explained
- **WHEN** a review runs with no endpoint
- **THEN** the footer lists `triage`, `agents` and `verify` as deferred with reason `no_endpoint`

#### Scenario: Lineage footer
- **WHEN** the third round of a lineage holds back two already-posted findings in a repository with author-response ratio 0.6
- **THEN** the footer shows round 3 of cap 3, the ratio 0.6 and two held-back findings

#### Scenario: Remembered findings and proposals listed
- **WHEN** a review has two remembered findings dismissed `intentional` in pull request 41 and one open suppression proposal with three pieces of evidence
- **THEN** the footer lists two remembered findings with reason `intentional` and pull request 41, and the proposal's entry with an evidence count of three

#### Scenario: Publication failure noted
- **WHEN** publication posted four comments and failed to anchor one
- **THEN** the footer shows four posted, one unanchored, and the note that the failure is retried on the next round

#### Scenario: Catalog coverage listed
- **WHEN** the security step assessed six applicable catalog items and left one unassessed for reason `budget`
- **THEN** the footer lists six assessed items and the unassessed item with reason `budget`

## ADDED Requirements

### Requirement: SARIF format availability
`sarif` SHALL be an accepted report format in the CLI and in the endpoint report query, rendering the same report document as the JSON format under the mapping owned by the sarif-output capability.

#### Scenario: SARIF requested from the endpoint
- **WHEN** a finished review's report is requested with format `sarif`
- **THEN** a SARIF document for the same findings as the JSON report is returned

## MODIFIED Requirements

### Requirement: Footer content
The footer SHALL always list: each `failed`, `skipped` or `cancelled` check with its outcome, reason and hint; a statement when any result used trusted dependencies; coverage files listed as `coverage_excluded` or `coverage_not_instrumented`; each deferred step with the reason `no_endpoint`; excluded files with reasons; a size note when `max_lines` is exceeded; graph truncation when it occurred; the counts of suppressed findings per suppression entry; category-floor drops by category; held-back agent counts and titles by pool with guidance to run `--deep` or raise `max_defects`; fork static-only restrictions; deferred board coordination when applicable; and, for lineage reviews, the round number, the lineage's cap state, the repository's author-response ratio when any response exists, and the count of findings held back as already posted.

#### Scenario: Deferred steps explained
- **WHEN** a review runs with no endpoint
- **THEN** the footer lists `triage`, `agents` and `verify` as deferred with reason `no_endpoint`

#### Scenario: Lineage footer
- **WHEN** the third round of a lineage holds back two already-posted findings in a repository with author-response ratio 0.6
- **THEN** the footer shows round 3 of cap 3, the ratio 0.6 and two held-back findings

# Spec Delta

## MODIFIED Requirements

### Requirement: Report evidence link mapping
The report's `qa.evidence.artifacts[]` SHALL map artifact ids to display links and optional expiry timestamps in epoch milliseconds. Authenticated hosted report reads SHALL refresh links from tenant/review-owned stored objects. Cached renderers SHALL omit expired links and distinguish artifact expiry from link expiry. Each refreshed artifact SHALL also carry where it belongs: its `journey`, its `step` when it has one, its `cell` (viewport and color scheme) and the `version` of the run that stored it (`base` or `head`). A base run's artifact SHALL keep an entry of its own even when its content, and so its id, equals a head artifact's.

#### Scenario: Retained artifact with an expired download link
- **WHEN** a cached signed link has expired but the artifact is still retained
- **THEN** the renderer labels the download link expired and directs the user to refresh it from the endpoint

#### Scenario: Base and head screenshots of one step
- **WHEN** a hosted review ran a QA baseline and both runs stored a screenshot of `checkout` step 4 on mobile/dark
- **THEN** the refreshed report lists both, each with journey, step and cell, one with `version: base` and one with `version: head`

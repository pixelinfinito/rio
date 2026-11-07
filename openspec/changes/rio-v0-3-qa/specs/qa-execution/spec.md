# Spec Delta

## Purpose

QA execution runs selected journeys in a browser through an agent harness, against the application started from the change under review, in every cell of a viewport matrix, and turns what the agent observes into evidence-backed hypotheses for the verifier.

## ADDED Requirements

### Requirement: The rio/qa step
`rio/qa` SHALL be a step that needs `graph`, consumes the snapshot, the graph delta, the environment contract, the seed and fixture manifests and the journeys, and outputs `qa_findings` (deterministic probe findings), `hypotheses`, `journey_outcomes` and `evidence`. `rio/verify` SHALL need it when it is enabled, and `rio/report` SHALL consume `qa_findings` and `journey_outcomes`.

#### Scenario: Full profile DAG
- **WHEN** the `rio/qa` built-in profile is resolved
- **THEN** `qa` needs `graph`, `verify` needs `agents`, `security` and `qa`, and `report` needs `checks`, `graph`, `verify` and `qa`

#### Scenario: QA without a verifier rejected
- **WHEN** a child profile enables `rio/qa` and redeclares `steps` without a `rio/verify` step depending on it
- **THEN** validation fails stating that the verifier step is mandatory when QA is enabled

### Requirement: The rio qa command
`rio qa [--full] [--journey NAME]... [--baseline] [--harness codex|pi] [--format terminal|md|json]` SHALL run the subgraph `prepare`, `graph`, `qa`, `verify`, `report` of the resolved profile and record every other step as `skipped` with reason `standalone`. Selection flags of `rio review` SHALL apply.

#### Scenario: Standalone run on a working tree
- **WHEN** `rio qa` runs with uncommitted changes and an endpoint configured
- **THEN** the head snapshot includes the working tree, the QA step runs in changed mode, verify runs on its hypotheses, and the footer lists `checks`, `triage`, `agents` and `security` as skipped with reason `standalone`

#### Scenario: Explicit journey
- **WHEN** `rio qa --journey checkout --journey login` runs
- **THEN** exactly those two journeys run regardless of coverage, and the footer states that selection was explicit

### Requirement: Changed-mode selection
In `changed` mode the step SHALL select every journey tagged `smoke`, every journey whose `covers.paths` matches a changed file or a file of a node in the impact graph delta, and every journey whose `covers.routes` matches a route derived from a changed file by `app.routes_from`. Selecting a journey SHALL also select the journeys it declares `after`. The selection and the reason for each journey SHALL be recorded in the plan. `full` mode SHALL select every journey.

#### Scenario: Graph expansion selects a journey
- **WHEN** a change edits `src/lib/price.ts`, the graph delta includes `src/pages/checkout/Summary.tsx` as a dependent, and journey `checkout` covers `src/pages/checkout/**`
- **THEN** `checkout` is selected with reason `graph: src/lib/price.ts -> src/pages/checkout/Summary.tsx`

#### Scenario: Dependency pulled in
- **WHEN** `checkout` declares `after: [add-to-cart]` and only `checkout` matches the change
- **THEN** both are selected and `add-to-cart` carries reason `after: checkout`

#### Scenario: Nothing matches
- **WHEN** a change edits only `README.md` and one journey is tagged `smoke`
- **THEN** only the smoke journey runs and the footer states that no journey covers the change

### Requirement: Selection cap
Selection SHALL be capped by `max_journeys`, keeping `smoke` journeys first, then whole chains ordered by the number of changed files they match. Journeys beyond the cap SHALL be reported as `held_back`. The plan SHALL state the number of cells (chains × viewports × schemes) and an estimated wall time.

#### Scenario: Cap keeps smoke
- **WHEN** `max_journeys` is 3, two journeys are `smoke` and four others match the change
- **THEN** the two smoke journeys and the one with the most matching files run, and the footer lists the three not run as `held_back`

### Requirement: Chains and cells
Journeys MAY declare `after: [journey]` to run on the state left by those journeys; the plan SHALL group them into chains. The unit of execution SHALL be one chain in one cell (viewport and color scheme): the seed snapshot is restored, the chain's journeys run in order in a fresh browser context, mobile cells first. Journeys with `resets: true` SHALL be chain heads.

#### Scenario: Registration in every cell
- **WHEN** `account-registration` declares `resets: true` and the matrix has two viewports and two schemes
- **THEN** the seed is restored four times and the registration succeeds in each cell

#### Scenario: Shared state in order
- **WHEN** `checkout` declares `after: [add-to-cart]`
- **THEN** in each cell `add-to-cart` runs first and `checkout` sees the cart it created

### Requirement: Every journey runs across the matrix
Each selected journey SHALL run in every cell of its resolved matrix. A journey SHALL be `passed` only when it passed in every cell; a pass in `desktop` with a failure in `mobile` SHALL be `failed` with the mobile step named. The exploratory pass SHALL visit each derived route in every cell of the default matrix.

#### Scenario: Mobile-only failure
- **WHEN** `checkout` passes in `desktop` but the pay button is below a fixed footer in `mobile`
- **THEN** the journey is `failed` at that step in viewport `mobile`, the desktop pass is recorded, and the report shows the per-cell grid

#### Scenario: Mobile runs first
- **WHEN** the run budget ends after the first cell of the last chain
- **THEN** the recorded outcome for that chain is its `mobile` result and the other cells are `cancelled` with reason `budget`

#### Scenario: Orientation change in a step
- **WHEN** a step says to rotate the phone
- **THEN** the harness switches to the matching landscape preset, the step boundary captures evidence in that orientation, and the journey continues

### Requirement: Exploratory pass over changed screens
After the selected journeys, in `changed` mode the agent SHALL make one bounded exploratory pass over routes derived from changed files that no selected journey visited, using the persona of the nearest journey or an anonymous session, and SHALL record what it visited. The pass SHALL be limited to one cell budget per cell and reported as the pseudo-journey `exploratory`.

#### Scenario: New page without a journey
- **WHEN** a change adds `src/pages/settings/Billing.tsx` and no journey covers it
- **THEN** the exploratory pass opens the derived `/settings/billing` route in each cell and its observations appear under `exploratory`

### Requirement: Browser contract
Rio SHALL launch Chromium in the `browser` container with tracing, screenshot, console and network capture, and expose it to the harness through a Playwright MCP server connected over CDP from `controller`. Every step boundary SHALL produce a screenshot and a DOM snapshot regardless of harness, and every action SHALL be appended to the replay event log.

#### Scenario: Same evidence for both harnesses
- **WHEN** the same journey runs once with `codex` and once with `pi`
- **THEN** both runs produce a screenshot and a DOM snapshot per step and a sanitized trace per cell, named by the same scheme

### Requirement: Harness tool set
The harness SHALL receive tools to navigate, inspect the accessibility tree, click, type, select, upload a fixture file, wait, log in as a persona, switch viewport and color scheme, read captured mail, SMS and webhooks, set a service behavior, set network and geolocation, mark a step outcome and record an observation. The harness SHALL NOT receive shell, file system or network tools, and SHALL NOT have the repository checkout.

#### Scenario: Fixture upload
- **WHEN** a step says to upload a profile picture
- **THEN** the harness calls `upload_fixture` with a fixture name declared in the manifest and no host path

#### Scenario: Shell tool denied
- **WHEN** the harness attempts to run a shell command
- **THEN** no shell tool exists in its tool set and the attempt is recorded in the transcript as rejected

### Requirement: Journey outcomes
Each selected journey SHALL end `passed`, `failed`, `skipped` (reason `missing_credentials`, `precondition_failed` or `held_back`), `not_run` (environment failure) or `cancelled` (reason `budget`, `harness_error` or `interrupted`), with one outcome per cell and the aggregate as defined above. `failed` SHALL name the first step whose expectation or success criterion did not hold and carry that step's evidence references.

#### Scenario: Failed step named
- **WHEN** step 4 of `checkout` expects an order confirmation and the page shows a blank panel in `mobile` `dark`
- **THEN** that cell is `failed` at step 4 with the step's screenshot, DOM snapshot and trace referenced, and the journey aggregate is `failed`

#### Scenario: Budget exhaustion in a cell
- **WHEN** the cell wall budget ends during step 2
- **THEN** the cell is `cancelled` with reason `budget`, steps 1 and 2 keep their evidence, and later cells still run within the run budget

### Requirement: Hypotheses from observations
The agent SHALL report observations as hypotheses with `rule_id`, kind (`functional`, `ux`, `style`, `accessibility`), journey, step, cell, route, structured `expected` and `observed` fields, the evidence references supporting it, and a suggested fix. Hypotheses without at least one evidence reference SHALL be dropped and counted in the footer. Hypotheses SHALL pass through `rio/verify` before reporting.

#### Scenario: Unsupported observation dropped
- **WHEN** the agent reports that a tooltip is confusing without referencing a screenshot
- **THEN** the hypothesis is not verified or rendered, and the footer counts one dropped observation

#### Scenario: Observation verified
- **WHEN** the agent reports that the save button stays disabled after a valid form entry, citing the step screenshot and DOM snapshot
- **THEN** the hypothesis reaches the verifier with those artifacts

### Requirement: Budgets
The step SHALL enforce `budget.<mode>.qa.wall` per run, `qa.cell_wall` per chain per cell, `qa.tokens` per cell through the model proxy, and `qa.evidence_bytes` per run. When QA is enabled the review deadline SHALL be the profile wall time plus `qa.wall` plus the verification reserve. `max_journeys` SHALL count journeys, not cells. In subscription mode tokens SHALL be unmetered and the footer SHALL say so.

#### Scenario: Cap counts journeys, not cells
- **WHEN** `max_journeys` is 4 and the matrix has two viewports and two schemes
- **THEN** four journeys run, each in all four cells

#### Scenario: Evidence quota
- **WHEN** evidence written in a run reaches `qa.evidence_bytes`
- **THEN** later cells keep screenshots and DOM snapshots but drop traces and video, and the footer reports `evidence quota reached`

### Requirement: Degradation
When the run budget ends, remaining cells SHALL be `cancelled` with reason `budget`, recorded outcomes SHALL be kept, and the step SHALL end `partial`. A harness crash SHALL retry the current cell once from a restored seed and fresh context, then mark it `cancelled` with reason `harness_error`.

#### Scenario: Run budget ends mid-run
- **WHEN** three of five chains finished in every cell when the run budget ends
- **THEN** their outcomes are reported, the remaining cells are `cancelled` with reason `budget`, and the step outcome is `partial`

#### Scenario: Harness crash
- **WHEN** the harness process exits unexpectedly during `login` in `mobile` `light`
- **THEN** that cell is retried once from a restored seed, and a second failure marks it `cancelled` with reason `harness_error`

### Requirement: Baseline comparison
With `baseline: true` the selected chains SHALL also run against the base snapshot in a separate pod within the same `qa.wall`, and occurrences SHALL be matched cell by cell between head and base to derive `new`, `pre-existing`, `fixed` and `worsened`, with `unclassified` for any cell the base run did not complete. Without it, QA findings SHALL be `new` when attributed to a changed file and `unclassified` otherwise.

#### Scenario: Regression classified
- **WHEN** `baseline: true` and `checkout` passes on base and fails at step 4 on head in every cell
- **THEN** the resulting finding is `new` with every occurrence `new`

#### Scenario: Worsened across cells
- **WHEN** a probe fires in `mobile` on both base and head and in `desktop` only on head
- **THEN** the finding is `worsened` with the mobile occurrence `pre-existing` and the desktop occurrence `new`

#### Scenario: Attribution without baseline
- **WHEN** `baseline` is off and a style probe fires on an element attributed to an unchanged file
- **THEN** the finding is `unclassified` and rendered in the QA section without matching the default fail policy

### Requirement: Fork restriction
QA SHALL NOT run for fork PRs; the step SHALL be skipped with reason `fork` and the footer SHALL say so.

#### Scenario: Fork PR
- **WHEN** a QA-enabled profile reviews a fork PR
- **THEN** the step is skipped with reason `fork` and no pod is started

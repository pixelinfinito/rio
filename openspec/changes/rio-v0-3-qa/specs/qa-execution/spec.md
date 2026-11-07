# Spec Delta

## Purpose

QA execution runs selected journeys in a browser through an agent harness, against the application started from the change under review, and turns what the agent observes into evidence-backed hypotheses for the verifier.

## ADDED Requirements

### Requirement: The rio/qa step and the rio qa command
`rio/qa` SHALL be a step consuming the snapshot, the impact graph delta, the environment contract and the journeys, and producing journey outcomes, evidence references and hypotheses for `rio/verify`. `rio qa [--full] [--journey NAME]... [--baseline] [--harness codex|pi] [--format terminal|md|json]` SHALL run prepare, graph, qa, verify and report with the resolved profile. Selection flags of `rio review` SHALL apply to `rio qa`.

#### Scenario: Standalone run on a working tree
- **WHEN** `rio qa` runs with uncommitted changes and an endpoint configured
- **THEN** the head snapshot includes the working tree, the QA step runs in changed mode, and the report contains the QA section and footer

#### Scenario: Explicit journey
- **WHEN** `rio qa --journey checkout --journey login` runs
- **THEN** exactly those two journeys run regardless of coverage, and the footer states that selection was explicit

### Requirement: Changed-mode selection
In `changed` mode the step SHALL select every journey tagged `smoke`, every journey whose `covers.paths` matches a changed file or a file of a node in the impact graph delta, and every journey whose `covers.routes` matches a route derived from a changed file by the framework route conventions declared or detected in the environment contract. The selection and the reason for each journey SHALL be recorded in the plan. `full` mode SHALL select every journey.

#### Scenario: Graph expansion selects a journey
- **WHEN** a change edits `src/lib/price.ts`, the graph delta includes `src/pages/checkout/Summary.tsx` as a dependent, and journey `checkout` covers `src/pages/checkout/**`
- **THEN** `checkout` is selected with reason `graph: src/lib/price.ts -> src/pages/checkout/Summary.tsx`

#### Scenario: Nothing matches
- **WHEN** a change edits only `README.md` and one journey is tagged `smoke`
- **THEN** only the smoke journey runs and the footer states that no journey covers the change

### Requirement: Selection cap
Selection SHALL be capped by `max_journeys`, keeping `smoke` journeys first and then journeys ordered by the number of changed files they match. Journeys beyond the cap SHALL be reported as `held_back`.

#### Scenario: Cap keeps smoke
- **WHEN** `max_journeys` is 3, two journeys are `smoke` and four others match the change
- **THEN** the two smoke journeys and the one with the most matching files run, and the footer lists the three not run as `held_back`

### Requirement: Exploratory pass over changed screens
After the selected journeys, in `changed` mode the agent SHALL make one bounded exploratory pass over routes derived from changed files that no selected journey visited, using the persona of the nearest journey or an anonymous session, and SHALL record what it visited. The pass SHALL be limited to the per-journey budget and SHALL be reported as the pseudo-journey `exploratory`.

#### Scenario: New page without a journey
- **WHEN** a change adds `src/pages/settings/Billing.tsx` and no journey covers it
- **THEN** the exploratory pass opens the derived `/settings/billing` route in each viewport and its observations appear under `exploratory`

### Requirement: Browser contract
Rio SHALL launch Chromium itself with tracing, screenshot, console and network capture, and expose it to the harness through a Playwright MCP server connected over CDP. Every step boundary SHALL produce a screenshot and a DOM snapshot regardless of harness.

#### Scenario: Same evidence for both harnesses
- **WHEN** the same journey runs once with `codex` and once with `pi`
- **THEN** both runs produce a screenshot and a DOM snapshot per step and a trace per journey, named by the same scheme

### Requirement: Harness tool set
The harness SHALL receive tools to navigate, inspect the accessibility tree, click, type, select, upload a fixture file, wait, log in as a persona, switch viewport and color scheme, mark a step outcome and record an observation. The harness SHALL NOT receive shell, file system or network tools.

#### Scenario: Fixture upload
- **WHEN** a step says to upload a profile picture
- **THEN** the harness calls `upload_fixture` with a fixture name declared in the contract and no host path

#### Scenario: Shell tool denied
- **WHEN** the harness attempts to run a shell command
- **THEN** no shell tool exists in its tool set and the attempt is recorded in the transcript as rejected

### Requirement: Every journey runs across the viewport matrix
Each selected journey SHALL run once per viewport in its resolved matrix and per color scheme, in a fresh browser context each time, mobile viewports first. A run SHALL NOT report a journey as `passed` until it passed in every viewport of its matrix; a pass on desktop with a failure on mobile SHALL be `failed` with the mobile step named. The exploratory pass SHALL also visit each derived route in every viewport of the default matrix.

#### Scenario: Mobile-only failure
- **WHEN** `checkout` passes in `desktop` and `tablet` but the pay button is below a fixed footer in `mobile`
- **THEN** the journey is `failed` at that step in viewport `mobile`, the desktop and tablet passes are recorded, and the report shows the per-viewport grid

#### Scenario: Mobile runs first
- **WHEN** the run budget ends after the first viewport of the last journey
- **THEN** the recorded outcome for that journey is its `mobile` result and the other viewports are `cancelled` with reason `budget`

#### Scenario: Orientation change in a step
- **WHEN** a step says to rotate the phone
- **THEN** the harness switches to the matching landscape preset, the step boundary captures evidence in that orientation, and the journey continues

### Requirement: Journey outcomes
Each selected journey SHALL end `passed`, `failed`, `skipped` (reason `missing_credentials`, `precondition_failed` or `held_back`), `not_run` (app not ready) or `cancelled` (budget or interruption). `failed` SHALL name the first step whose expectation or success criterion did not hold and SHALL carry the evidence references for that step. A journey SHALL be marked for each viewport and color scheme it ran in.

#### Scenario: Failed step named
- **WHEN** step 4 of `checkout` expects an order confirmation and the page shows a blank panel
- **THEN** the journey is `failed` at step 4 in viewport `mobile`, with the step's screenshot, DOM snapshot and trace referenced

#### Scenario: Budget exhaustion
- **WHEN** the per-journey wall budget ends during step 2
- **THEN** the journey is `cancelled` with reason `budget`, steps 1 and 2 keep their evidence, and later journeys still run within the run budget

### Requirement: Hypotheses from observations
The agent SHALL report observations as hypotheses carrying `rule_id`, kind (`functional`, `ux`, `style`, `accessibility`), the journey, step, viewport and color scheme, the evidence references supporting it, the observed and expected behavior, and a suggested fix. Hypotheses without at least one evidence reference SHALL be dropped and counted in the footer. Hypotheses SHALL pass through `rio/verify` before reporting.

#### Scenario: Unsupported observation dropped
- **WHEN** the agent reports that a tooltip is confusing without referencing a screenshot
- **THEN** the hypothesis is not verified or rendered, and the footer counts one dropped observation

#### Scenario: Observation verified
- **WHEN** the agent reports that the save button stays disabled after a valid form entry, citing the step screenshot and DOM snapshot
- **THEN** the hypothesis reaches the verifier with those artifacts

### Requirement: Budgets and degradation
The step SHALL enforce `budget.<mode>.qa_wall` per run (default 30 min), `qa_journey_wall` per journey per viewport and color scheme (default 8 min) and `qa_tokens` per journey per viewport and color scheme. When the run budget ends, remaining journeys SHALL be `cancelled` with reason `budget`, outcomes already recorded SHALL be kept, and the step SHALL end `partial`. A harness crash SHALL retry the current journey once and then mark it `cancelled` with reason `harness_error`.

#### Scenario: Cap counts journeys, not viewport runs
- **WHEN** `max_journeys` is 4 and the matrix has three viewports and two schemes
- **THEN** four journeys run, each in all six viewport and scheme combinations

#### Scenario: Run budget ends mid-run
- **WHEN** three of five journeys finished when the run budget ends
- **THEN** the three outcomes are reported, the two remaining are `cancelled` with reason `budget`, and the step outcome is `partial`

#### Scenario: Harness crash
- **WHEN** the harness process exits unexpectedly during `login`
- **THEN** `login` is retried once from a fresh browser context, and a second failure marks it `cancelled` with reason `harness_error`

### Requirement: Baseline comparison
With `baseline: true` the selected journeys SHALL also run against the base snapshot in a separate container, and findings SHALL be classified `new`, `pre-existing` or `fixed` by comparing head and base outcomes per rule, journey and step. Without it, QA findings SHALL be `new` when their attributed location is in a changed file and `unclassified` otherwise.

#### Scenario: Regression classified
- **WHEN** `baseline: true` and `checkout` passes on base and fails at step 4 on head
- **THEN** the resulting finding is `new`

#### Scenario: Attribution without baseline
- **WHEN** `baseline` is off and a style probe fires on an element attributed to an unchanged file
- **THEN** the finding is `unclassified` and rendered in the QA section without matching the default fail policy

### Requirement: Fork and hosted restrictions
QA SHALL NOT run for fork PRs. Hosted QA SHALL run as a `qa` job class on the configured runner with network egress limited to the model endpoint; the Sandbox runner SHALL declare that limit in its job record and the report SHALL state the egress policy that applied.

#### Scenario: Fork PR
- **WHEN** a QA-enabled profile reviews a fork PR
- **THEN** the step is skipped with reason `fork` and the footer says so

# Spec Delta

## MODIFIED Requirements

### Requirement: The rio qa command
`rio qa [--full] [--journey NAME]... [--cell VIEWPORT/SCHEME] [--baseline] [--harness codex|pi] [--format terminal|md|json]` SHALL run the subgraph `prepare`, `graph`, `qa`, `verify`, `report` of the resolved profile and record every other step as `skipped` with reason `standalone`. Selection flags of `rio review` SHALL apply. `--cell` SHALL run only that cell of the matrix; a cell the matrix does not have SHALL be an error, never a new cell.

#### Scenario: Standalone run on a working tree
- **WHEN** `rio qa` runs with uncommitted changes and an endpoint configured
- **THEN** the head snapshot includes the working tree, the QA step runs in changed mode, verify runs on its hypotheses, and the footer lists `checks`, `triage`, `agents` and `security` as skipped with reason `standalone`

#### Scenario: Explicit journey
- **WHEN** `rio qa --journey checkout --journey login` runs
- **THEN** exactly those two journeys run regardless of coverage, and the footer states that selection was explicit

#### Scenario: One cell
- **WHEN** `rio qa --journey checkout --cell desktop/dark` runs on a matrix of mobile and desktop in light and dark
- **THEN** only the desktop/dark cell of `checkout` runs and the plan counts one cell

## ADDED Requirements

### Requirement: Live control of a local run
A local QA run SHALL take the host's pause and cancel requests while it runs. The runtime SHALL copy the host's requests into the controller at least once a second; a failed copy SHALL never fail the run. A paused queue SHALL finish the running cell and start no other until resumed. A cancelled cell SHALL stop if it runs and never start if queued, and be recorded `cancelled` with reason `user`.

#### Scenario: Cancel the running cell
- **WHEN** the host cancels `checkout` on mobile/dark while that cell runs
- **THEN** the cell's journeys are recorded `cancelled` with reason `user`, the run is `partial`, and the next cell runs

#### Scenario: Paused queue
- **WHEN** the host pauses the queue while the first cell runs
- **THEN** that cell completes, its result is reported, and the second cell starts only after the host resumes

### Requirement: Cell progress of a local run
A local QA run SHALL report each cell's progress to the host while it runs: the journey, the cell, the step reached and the outcome (`running` as a cell starts and at each step, then its result). The runtime SHALL copy the controller's progress out at least once a second.

#### Scenario: Steps reach the host
- **WHEN** the `checkout` journey on mobile/dark completes step 2
- **THEN** the host receives `checkout`, mobile/dark, step 2, `running`, and receives the cell's outcome when it ends

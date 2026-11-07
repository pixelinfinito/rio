# Spec Delta

## Purpose

Journeys are versioned repository documents that describe end-to-end user flows and their success criteria, so a QA agent can execute them as the intended user and so any coding agent can author or update them in one shared format.

## ADDED Requirements

### Requirement: Journey documents
A journey SHALL be one YAML file at `.rio/qa/journeys/<name>.yaml` declaring `version: 1`, `name` (equal to the file stem), `title`, `persona` (declared in `.rio/qa.yaml`), `tags` (`smoke` is reserved), `covers` (`routes[]` patterns and `paths[]` repository-relative globs), `preconditions[]`, `steps[]` and `success[]`. The schema SHALL be published as `schemas/journey-v1.json`; unknown keys SHALL be rejected.

#### Scenario: Valid journey loads
- **WHEN** `.rio/qa/journeys/account-registration.yaml` declares `version: 1`, `name: account-registration`, a persona present in `.rio/qa.yaml`, two covered routes, five steps and two success criteria
- **THEN** `rio qa list` shows the journey with its tags and coverage, and `rio qa validate` reports no errors

#### Scenario: Unknown key rejected
- **WHEN** a journey contains a top-level `selectors:` key
- **THEN** validation fails naming the key and its file and YAML path

#### Scenario: Unknown persona rejected
- **WHEN** a journey declares `persona: admin` and `.rio/qa.yaml` declares no persona named `admin`
- **THEN** validation fails naming the journey, the persona and the config file

### Requirement: Journey viewport override
A journey MAY declare `viewports[]` to narrow the matrix it runs in, naming viewports from the resolved contract. The override SHALL NOT remove every mobile viewport unless the journey also declares `desktop_only: true` with a `reason`, which the report SHALL show beside the journey.

#### Scenario: Admin console is desktop only
- **WHEN** journey `admin-audit` declares `desktop_only: true`, `reason: "The admin console is not offered on phones"` and `viewports: [desktop, wide]`
- **THEN** validation passes, the journey runs only in those viewports, and the report shows the reason beside its outcomes

#### Scenario: Silent mobile removal rejected
- **WHEN** a journey declares `viewports: [desktop]` without `desktop_only`
- **THEN** validation fails naming the journey and stating that a mobile viewport is required unless `desktop_only` is declared with a reason

### Requirement: Journey steps
Each step SHALL have `do` (a natural-language action) and MAY have `at` (route pattern), `hint` (selector or accessible name) and `expect` (natural-language expectation). Steps SHALL NOT contain executable code or credential values.

#### Scenario: Step with hint
- **WHEN** a step declares `do: Open the account menu`, `hint: button[aria-label="Account"]` and `expect: The menu lists Profile and Sign out`
- **THEN** validation passes and the hint is given to the agent as a disambiguation aid

#### Scenario: Credential in a step rejected
- **WHEN** a step declares `do: Type hunter2 into the password field`
- **THEN** validation warns that the step appears to contain a credential and recommends the persona login tool

### Requirement: Coverage declarations select journeys
`covers.paths` globs and `covers.routes` patterns SHALL be the data from which changed-mode selection is computed. Validation SHALL reject journeys whose `covers.paths` is empty when `covers.routes` is also empty, and SHALL warn when a glob matches no file in the head snapshot.

#### Scenario: Stale glob warns
- **WHEN** a journey covers `src/pages/checkout/**` and the head snapshot has no such directory
- **THEN** validation warns that the glob matches nothing and names the journey

#### Scenario: Journey without coverage rejected
- **WHEN** a journey declares neither `covers.paths` nor `covers.routes`
- **THEN** validation fails stating that a journey needs at least one covered path or route

### Requirement: Generation with the agent
`rio qa init` SHALL start the app under the environment contract, run the configured harness with the shipped skill to explore it, and write candidate journeys to `.rio/qa/journeys/`. It SHALL write at least one `smoke` journey. It SHALL NOT overwrite an existing journey file unless `--force` is given; new candidates for an existing name SHALL be written as `<name>.proposed.yaml`. Generated files SHALL validate before they are written.

#### Scenario: First generation
- **WHEN** `rio qa init` runs in a repository with `.rio/qa.yaml` and no journeys
- **THEN** `.rio/qa/journeys/` contains one or more valid journeys, one of which is tagged `smoke`, and nothing is committed

#### Scenario: Existing journey preserved
- **WHEN** `rio qa init` runs and `.rio/qa/journeys/login.yaml` exists
- **THEN** the existing file is unchanged and a different candidate for the same flow is written as `login.proposed.yaml`

### Requirement: Synchronizing journeys with the app
`rio qa sync` SHALL compare journeys with the current snapshot: journeys whose covered paths changed in the selected diff SHALL be re-walked by the agent, and the agent's proposed edits SHALL be written as `<name>.proposed.yaml` with a `sync_reason`. `rio qa sync --check` SHALL exit non-zero listing journeys whose covered paths changed and whose file did not, without starting the app.

#### Scenario: Check mode in CI
- **WHEN** a change edits `src/pages/checkout/Summary.tsx`, journey `checkout` covers `src/pages/checkout/**`, and `rio qa sync --check` runs
- **THEN** the command exits non-zero naming `checkout` as possibly stale

#### Scenario: Proposed update
- **WHEN** `rio qa sync` runs after a change renamed the checkout confirmation button
- **THEN** `checkout.proposed.yaml` contains the updated step and a `sync_reason` naming the changed file, and `checkout.yaml` is unchanged

### Requirement: Shipped agent skill
`rio qa init` SHALL write `.rio/qa/skills/rio-qa/SKILL.md` from the built-in `modules/qa/skill`, register it as `.claude/skills/rio-qa` (a symlink on Unix, a copy on Windows) and append or update a fenced `rio-qa` section in the repository root `AGENTS.md` pointing at the skill. The skill SHALL state the journey schema, the coverage rules, the evidence expectations and the rule ids a journey may reference.

#### Scenario: Skill registered for two harnesses
- **WHEN** `rio qa init` completes on Linux
- **THEN** `.rio/qa/skills/rio-qa/SKILL.md` exists, `.claude/skills/rio-qa` resolves to it, and `AGENTS.md` contains a fenced `rio-qa` section with a relative path to the skill

### Requirement: Skill refresh
`rio qa init` SHALL refresh the skill when the built-in version is newer than the repository copy and SHALL leave user edits outside the fenced `AGENTS.md` section untouched. A repository skill edited by the user SHALL be kept and the new version written as `SKILL.proposed.md`.

#### Scenario: Edited skill preserved
- **WHEN** the repository skill differs from the version it was generated from and a newer built-in exists
- **THEN** `SKILL.md` is unchanged and `SKILL.proposed.md` holds the new version

#### Scenario: User text outside the fence survives
- **WHEN** `AGENTS.md` has a paragraph before the fenced section and `rio qa init` runs again with a newer skill
- **THEN** the paragraph is unchanged and only the fenced section is rewritten

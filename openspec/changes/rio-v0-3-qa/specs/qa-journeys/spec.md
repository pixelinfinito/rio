# Spec Delta

## Purpose

Journeys are versioned repository documents that describe end-to-end user flows and their success criteria, so a QA agent can execute them as the intended user and so any coding agent can author or update them in one shared format.

## ADDED Requirements

### Requirement: Journey documents
A journey SHALL be one YAML file at `.rio/qa/journeys/<name>.yaml` declaring `version: 1`, `name` (equal to the file stem), `title`, `persona` (declared in `.rio/qa.yaml`), `tags` (`smoke` is reserved), `covers`, `preconditions[]`, `steps[]` and `success[]`. The schema SHALL be published as `schemas/journey-v1.json`; unknown keys SHALL be rejected.

#### Scenario: Optional keys
- **WHEN** a journey declares `after[]`, `resets`, `viewports[]`, `desktop_only`, `reason` and `context` in addition to the required keys
- **THEN** validation passes and each key takes effect as defined by the requirements below

#### Scenario: Valid journey loads
- **WHEN** `.rio/qa/journeys/account-registration.yaml` declares `version: 1`, `name: account-registration`, a persona present in `.rio/qa.yaml`, two covered routes, five steps and two success criteria
- **THEN** `rio qa list` shows the journey with its tags and coverage, and `rio qa validate` reports no errors

#### Scenario: Unknown key rejected
- **WHEN** a journey contains a top-level `selectors:` key
- **THEN** validation fails naming the key and its file and YAML path

#### Scenario: Unknown persona rejected
- **WHEN** a journey declares `persona: admin` and `.rio/qa.yaml` declares no persona named `admin`
- **THEN** validation fails naming the journey, the persona and the config file

### Requirement: Candidate files
A file ending in `.proposed.yaml` SHALL be a candidate: validated like a journey with `name` equal to the stem before `.proposed`, allowed to carry `sync_reason`, and never loaded for a run or counted by selection until renamed. `rio qa list` SHALL show candidates separately.

#### Scenario: Candidate is not run
- **WHEN** `.rio/qa/journeys/` contains `checkout.yaml` and `checkout.proposed.yaml`
- **THEN** `rio qa` runs only `checkout`, and `rio qa list` shows the candidate with its `sync_reason`

### Requirement: Journey steps
Each step SHALL have `do` (a natural-language action) and MAY have `at` (route pattern), `hint` (selector or accessible name) and `expect` (natural-language expectation). Steps SHALL NOT contain executable code or credential values.

#### Scenario: Step with hint
- **WHEN** a step declares `do: Open the account menu`, `hint: button[aria-label="Account"]` and `expect: The menu lists Profile and Sign out`
- **THEN** validation passes and the hint is given to the agent as a disambiguation aid

#### Scenario: Credential in a step rejected
- **WHEN** a step declares `do: Type hunter2 into the password field`
- **THEN** validation warns that the step appears to contain a credential and recommends the persona login tool

### Requirement: Compatible chain clocks
Validation SHALL reject incompatible effective times within a chain after applying fixture defaults. Equivalent instants with different UTC offsets SHALL be accepted; fixed and live time SHALL NOT be mixed. Proposed replacements SHALL satisfy the same rule for all affected dependencies.

#### Scenario: Proposed clock change breaks a dependent
- **WHEN** a proposed add-to-cart replacement uses a different effective time from its checkout dependent
- **THEN** validation rejects the proposal and names the affected dependency

### Requirement: Journey data preconditions and chains
`preconditions[]` SHALL be natural-language statements about seeded state that the agent checks before step 1. `after[]` SHALL name journeys whose final state this journey starts from; `resets: true` SHALL mean the journey starts from a freshly restored seed and SHALL NOT be combined with `after`. Validation SHALL reject unknown names and cycles in `after`. A precondition that does not hold SHALL end the journey `skipped` with reason `precondition_failed` and the evidence of the check.

#### Scenario: Chain declared
- **WHEN** `checkout` declares `after: [add-to-cart]` and `add-to-cart` exists
- **THEN** validation passes and `rio qa list` shows `checkout` as part of the chain `add-to-cart -> checkout`

#### Scenario: Cycle rejected
- **WHEN** `a` declares `after: [b]` and `b` declares `after: [a]`
- **THEN** validation fails naming the cycle

#### Scenario: Precondition fails
- **WHEN** a journey's precondition says the shopper has one saved address and the seeded account has none
- **THEN** the journey is `skipped` with reason `precondition_failed` and the check's screenshot is attached

### Requirement: Journey viewport override
A journey MAY declare `viewports[]` to narrow the matrix it runs in, naming viewports from the resolved contract. The override SHALL NOT remove every mobile viewport unless the journey also declares `desktop_only: true` with a `reason`, which the report SHALL show beside the journey. Each dependent journey’s resolved viewport set SHALL be a subset of every direct prerequisite’s set; validation SHALL reject incompatible matrices, including proposed replacements.

#### Scenario: Incompatible prerequisite viewports rejected
- **WHEN** `checkout` declares `after: [add-to-cart]` and includes desktop, but `add-to-cart` declares only mobile
- **THEN** validation fails naming both journeys and the unsupported desktop viewport; no pod starts, no viewport override is expanded, and no dependent cell is silently skipped

#### Scenario: Narrower dependent matrix accepted
- **WHEN** `add-to-cart` runs in mobile and desktop while its dependent checkout declares only mobile
- **THEN** validation passes and checkout retains the cart in its declared mobile cells

#### Scenario: Admin console is desktop only
- **WHEN** journey `admin-audit` declares `desktop_only: true`, `reason: "The admin console is not offered on phones"` and `viewports: [desktop, wide]`
- **THEN** validation passes, the journey runs only in those viewports, and the report shows the reason beside its outcomes

#### Scenario: Silent mobile removal rejected
- **WHEN** a journey declares `viewports: [desktop]` without `desktop_only`
- **THEN** validation fails naming the journey and stating that a mobile viewport is required unless `desktop_only` is declared with a reason

### Requirement: Coverage declarations select journeys
`covers.paths` globs and `covers.routes` patterns SHALL be the data from which changed-mode selection is computed. Validation SHALL reject journeys whose `covers.paths` is empty when `covers.routes` is also empty, and SHALL warn when a glob matches no file in the head snapshot.

#### Scenario: Stale glob warns
- **WHEN** a journey covers `src/pages/checkout/**` and the head snapshot has no such directory
- **THEN** validation warns that the glob matches nothing and names the journey

#### Scenario: Journey without coverage rejected
- **WHEN** a journey declares neither `covers.paths` nor `covers.routes`
- **THEN** validation fails stating that a journey needs at least one covered path or route

### Requirement: Generation with the agent
`rio qa init` SHALL start the app under the environment contract after the seed is built, run the configured harness with the shipped skill to explore it, and write journeys to `.rio/qa/journeys/` that validate before they are written. It SHALL write at least one `smoke` journey. Generated journeys that create or delete records SHALL set `resets: true` only when they have no `after` dependencies; dependent journeys SHALL retain predecessor state.

#### Scenario: First generation
- **WHEN** `rio qa init` runs in a repository with `.rio/qa.yaml`, a built seed and no journeys
- **THEN** `.rio/qa/journeys/` contains one or more valid journeys, one of which is tagged `smoke`, and nothing is committed

#### Scenario: Generated checkout preserves the cart
- **WHEN** init generates add-to-cart followed by checkout that creates an order
- **THEN** add-to-cart sets `resets: true`, checkout declares `after: [add-to-cart]` without `resets: true`, both validate, and each cell restores the seed before the chain rather than between its journeys

### Requirement: Overwrite protection
`rio qa init` SHALL NOT overwrite an existing journey file unless `--force` is given; a new candidate for an existing name SHALL be written as `<name>.proposed.yaml`.

#### Scenario: Existing journey preserved
- **WHEN** `rio qa init` runs and `.rio/qa/journeys/login.yaml` exists
- **THEN** the existing file is unchanged and a different candidate for the same flow is written as `login.proposed.yaml`

### Requirement: Synchronizing journeys with the app
`rio qa sync` SHALL compare journeys with the current snapshot: journeys whose covered paths or applicable owner guidance changed in the selected diff SHALL be re-walked by the agent, and the agent's proposed edits SHALL be written as `<name>.proposed.yaml` with a `sync_reason`. `rio qa sync --check` SHALL exit non-zero listing journeys whose covered paths or applicable owner guidance changed and whose file did not, without starting a pod.

#### Scenario: Check mode in CI
- **WHEN** a change edits `src/pages/checkout/Summary.tsx`, journey `checkout` covers `src/pages/checkout/**`, and `rio qa sync --check` runs
- **THEN** the command exits non-zero naming `checkout` as possibly stale

#### Scenario: Proposed update
- **WHEN** `rio qa sync` runs after a change renamed the checkout confirmation button
- **THEN** `checkout.proposed.yaml` contains the updated step and a `sync_reason` naming the changed file, and `checkout.yaml` is unchanged

### Requirement: Shipped agent skill
`rio qa init` SHALL write `.rio/qa/skills/rio-qa/SKILL.md` from the built-in `modules/qa/skill`, register it as `.claude/skills/rio-qa` (a symlink on Unix, a copy on Windows) and append or update a fenced `rio-qa` section in the repository root `AGENTS.md` pointing at the skill. The skill SHALL state the journey, seed and fixture schemas, the coverage and chain rules, the evidence expectations, the synthetic-data rule and the rule ids a journey may reference.

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

### Requirement: Author journeys from user goals and guidance
Init, sync and the shipped skill SHALL use applicable owner guidance to author goals and success criteria rather than copying current behavior as the expected behavior. Journey documents SHALL accept optional `goal`, `guidance_refs[]` (path, hash, original line range) and `ux_criteria[]` (rule ids). Generated journeys SHALL include these fields and propose coverage of relevant recovery and alternate paths.

#### Scenario: Generation exposes a missing experience
- **WHEN** `REVIEW.md` requires preserving entered data after a payment decline but the running app clears it
- **THEN** the proposed journey expects preservation, cites the requirement and exercises decline then retry rather than recording data loss as success

#### Scenario: Existing journeys remain valid
- **WHEN** a committed version-1 journey lacks the new optional fields
- **THEN** it remains valid and QA still resolves its applicable guidance and default UX rubric

#### Scenario: Guidance-only sync
- **WHEN** applicable guidance changes but covered source files do not
- **THEN** sync re-evaluates the affected journey and writes a candidate with guidance citations, and sync check names it as possibly stale without starting a pod

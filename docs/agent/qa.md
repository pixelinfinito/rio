# Browser QA

Requires Git repository, Linux Docker host with firewall control, paired QA image, app launch contract, synthetic fixtures/seed, journeys, and Codex subscription or host keychain model route (codex/pi harness). QA executes the app/browser in isolated containers and stores evidence; init writes contracts/proposals/journeys. Local judgments are unverified without an endpoint.

## setup
From Rio source build `docker build -f worker/Dockerfile.qa -t rio-qa:0.1.0 .`. In the application repository define .rio/qa.yaml, seed/fixture definitions and REVIEW.md guidance. tests/fixtures/qa-sample is the complete reference app. Prefer http://app.test:PORT for container HTTP; bare app may trigger Chromium HSTS.
`rio qa validate`; `rio qa seed build`; `rio qa init`; `rio qa list`; `rio qa --full`. Init can propose missing setup and write .rio/qa.proposed.yaml; review it before `rio qa init --accept-contract`. --force replaces validated journeys, not arbitrary existing environment/seed definitions, and protects concurrent edits. Unknown/Compose-only topology can need a reviewed Dockerfile.qa.

## run
`rio qa` selects changed coverage; --full all journeys; --journey NAME repeatable, conflicts with --full. --baseline compares base/head. --cell mobile/dark selects one valid cell. --staged/--base REF select source snapshots. --harness codex|pi chooses driver; --profile requires QA enabled (default rio/qa). --format terminal|json|md|sarif selects output; --no-tui streams, --no-color/--ascii control display. --publish requests publication under the existing transport/policy.

## inspect
`rio qa show` resolved contract; `rio qa show NAME` journey JSON; `rio qa rules` rubric/probes; `rio qa fixtures status` available fixtures. Invalid contracts exit 2 before startup. No endpoint: judged findings/recommendations stay unverified. UX recommendations distinguish observed friction from proposed benefit and cannot fail the review. Check missing-image, authentication, blocked-host and readiness diagnostics before increasing budgets.

<!-- schema-options:start -->
## option-fields
rio/qa@0.1.0:
enabled: boolean; default=false
mode: enum; enum=["changed","full"]; default="changed"
harness: enum; enum=["codex","pi"]; default="codex"
baseline: boolean; default=false
max_journeys: integer; default=12; minimum=1
max_defects: integer; default=15; minimum=1
max_recommendations: integer; default=5; minimum=0
cell: object; extra=false
cell.viewport: string *; pattern="^[a-z][a-z0-9-]*$"
cell.color_scheme: string *; pattern="^[a-z][a-z0-9-]*$"
viewports: array; minItems=1; uniqueItems=true
viewports[]: string
rules: object; default={}; extra=false
rules.disable: array; minItems=0; uniqueItems=true
rules.disable[]: string
rules.adopt: array; minItems=0; uniqueItems=true
rules.adopt[]: string
rules.add: array; minItems=0
rules.add[].id: string *; pattern="^project/[a-z][a-z0-9-]*$"
rules.add[].category: enum *; enum=["functional","ux","style","accessibility"]
rules.add[].severity: enum *; enum=["error","warning","info"]
rules.add[].description: string *; minLength=1
rules.ignore_console: array; minItems=0; uniqueItems=true
rules.ignore_console[]: string
sandbox: enum; enum=["deny","allow"]; default="deny"
fail_on: object; default={"evidence":"plausible","categories":["ux"],"states":["new","worsened"],"rules":[],"incomplete":true,"required_checks":[]}; extra=false
fail_on.evidence: enum; enum=["reproduced","static_proven","plausible","refuted"]
fail_on.categories: array; uniqueItems=true
fail_on.categories[]: enum=["defect","risk","security","ux"]
fail_on.states: array; uniqueItems=true
fail_on.states[]: enum=["new","worsened","pre-existing","fixed","unclassified"]
fail_on.rules: array
fail_on.rules[]: string
fail_on.incomplete: boolean
fail_on.required_checks: array; uniqueItems=true
fail_on.required_checks[]: enum=["typecheck","lint","secrets","coverage","dependencies"]
journeys: array; minItems=1; uniqueItems=true
journeys[]: string

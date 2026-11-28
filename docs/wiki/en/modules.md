# Steps, rules, adapters and schema fields

## Outcome

Understand the pipeline and find the exact supported configuration fields.

## Prerequisites

A profile to inspect or edit. Built-in modules are embedded and versioned; third-party modules are not supported. Changing a step list replaces the inherited list.

## Steps

Use `rio profile show rio/base` to inspect the resolved graph. Prepare selects/snapshots source; checks runs deterministic tools; graph traces bounded impact; triage routes risk; agents propose hypotheses; security applies catalogs; QA exercises journeys; verify independently tests claims; council assesses residual uncertainty; report applies policy and renders.

Step IDs must be unique, `needs` must reference existing steps without cycles, and `with` must satisfy that module's schema. Hypothesis producers need a dependent verifier. The generated reference below lists field types/defaults/allowed values from the same schemas as implementation.

`rio/agents` `parts` (1–8, default 1) reviews a change longer than one prompt in up to that many parts, one conversation each at the same time; parts share the agent's token allowance and are not cached. An agent declaration names one model alias (`model`) or up to four (`models: [default, second]`); the agent reviews the same code under each, and what they raise is combined before verification. An alias the profile does not define is skipped. `rio/prepare` `omit` removes paths from the snapshot, while `exclude` only keeps them out of the reviewed change; see [profiles](profiles.md).

TypeScript adapters use tsc/ESLint/Vitest or Jest; Python uses Pyright or mypy/Ruff/pytest and coverage.py; Rust uses Cargo checks and configured Clippy/rustfmt/llvm-cov. Project-local tools precede PATH. Workspaces schedule changed roots and dependents. Known lockfile/install mismatch cannot be overridden by dependency trust.

## Expected results

`rio profile validate` catches invalid modules, rule expressions, options and dependencies before review. Local mode defers hosted steps. Default graph bounds are two hops/2,000 nodes. Disabled checks are `skipped: disabled`. Trusting an installation with unknown compatibility leaves diagnostics unclassified; it cannot override a known mismatch.

Posture controls agent floors/caps, while deterministic findings remain uncapped. Rules use supported predicates/actions, not arbitrary code. `always_human` marks risky paths but grants no approval. Owner files (`REVIEW.md`, `CLAUDE.md`, `AGENTS.md`) are scoped guidance data; they cannot enable tools or override budgets/suppressions/publication.

## Troubleshooting

Compare authored and resolved YAML with `profile show --raw` and normal `show`. Validate after every change. An empty child mapping keeps parent values; an empty list removes inherited entries. Unknown fields should be fixed, not ignored.

## Next steps

[Profile recipes](profiles.md), [resource limits](budgets.md), [security](security.md), and [QA](qa.md).

<!-- profile-schema:start -->

## Profile fields

Generated from `schemas/profile-v1.json`. `*` means required. `extra=false` rejects unknown keys. Semantic validation still applies.

| Field | Type / constraints |
| --- | --- |
| `version` | `value *; const=1` |
| `name` | `string *; minLength=1` |
| `extends` | `string; minLength=1` |
| `budget` | `object; extra=false` |
| `budget.prepare` | `string; pattern="^[1-9][0-9]*(s\|m)$"` |
| `budget.fast` | `object; extra=false` |
| `budget.fast.wall_time` | `string; pattern="^([0-9]+(\\.[0-9]+)?)(ms\|s\|m\|h\|d)$"` |
| `budget.fast.tokens` | `integer; minimum=1` |
| `budget.fast.agents_max` | `integer; minimum=1` |
| `budget.fast.verify_tokens` | `integer; minimum=1` |
| `budget.fast.qa` | `object; extra=false` |
| `budget.fast.qa.wall` | `string; pattern="^[1-9][0-9]*(ms\|s\|m\|h)$"` |
| `budget.fast.qa.cell_wall` | `string; pattern="^[1-9][0-9]*(ms\|s\|m\|h)$"` |
| `budget.fast.qa.tokens` | `integer; minimum=1` |
| `budget.fast.qa.evidence_bytes` | `integer; minimum=1` |
| `budget.fast.qa.replay_wall` | `string; pattern="^[1-9][0-9]*(ms\|s\|m\|h)$"` |
| `budget.deep` | `object; extra=false` |
| `budget.deep.wall_time` | `string; pattern="^([0-9]+(\\.[0-9]+)?)(ms\|s\|m\|h\|d)$"` |
| `budget.deep.tokens` | `integer; minimum=1` |
| `budget.deep.agents_max` | `integer; minimum=1` |
| `budget.deep.verify_tokens` | `integer; minimum=1` |
| `budget.deep.qa` | `object; extra=false` |
| `budget.deep.qa.wall` | `string; pattern="^[1-9][0-9]*(ms\|s\|m\|h)$"` |
| `budget.deep.qa.cell_wall` | `string; pattern="^[1-9][0-9]*(ms\|s\|m\|h)$"` |
| `budget.deep.qa.tokens` | `integer; minimum=1` |
| `budget.deep.qa.evidence_bytes` | `integer; minimum=1` |
| `budget.deep.qa.replay_wall` | `string; pattern="^[1-9][0-9]*(ms\|s\|m\|h)$"` |
| `models` | `object` |
| `steps` | `array` |
| `steps[].id` | `string *; minLength=1` |
| `steps[].uses` | `string *; minLength=1` |
| `steps[].needs` | `array; uniqueItems=true` |
| `steps[].needs[]` | `string` |
| `steps[].parallel` | `boolean` |
| `steps[].with` | `object` |
| `steps[].rules` | `array` |
| `steps[].rules[].when` | `string *; minLength=1` |
| `steps[].rules[].then` | `string; minLength=1` |
| `steps[].agents` | `array` |
| `steps[].agents[]` | `object` |
| `suppress` | `array` |
| `publish` | `enum; enum=["never","ask","auto"]` |
| `fail_on` | `object; extra=false` |
| `fail_on.evidence` | `enum; enum=["reproduced","static_proven","plausible","refuted"]` |
| `fail_on.categories` | `array; uniqueItems=true` |
| `fail_on.categories[]` | `enum=["defect","risk","security","ux"]` |
| `fail_on.states` | `array; uniqueItems=true` |
| `fail_on.states[]` | `enum=["new","worsened","pre-existing","fixed","unclassified"]` |
| `fail_on.rules` | `array` |
| `fail_on.rules[]` | `string` |
| `fail_on.incomplete` | `boolean` |
| `fail_on.required_checks` | `array; uniqueItems=true` |
| `fail_on.required_checks[]` | `enum=["typecheck","lint","secrets","coverage","dependencies"]` |
| `min_evidence` | `enum; enum=["reproduced","static_proven","plausible","refuted"]` |
| `max_lines` | `integer; minimum=1` |
| `posture` | `enum; enum=["critical-only","balanced","thorough"]; default="balanced"` |
| `max_defects` | `integer; default=10; minimum=1` |
| `rounds` | `object; default={"cap":3,"diff_only_after":1}; extra=false` |
| `rounds.cap` | `integer; default=3; minimum=1` |
| `rounds.diff_only_after` | `integer; default=1; minimum=0` |
| `always_human` | `array; default=[]` |
| `always_human[]` | `string` |
| `verify` | `object; extra=false` |
| `verify.voters` | `integer; default=3; minimum=1` |
| `verify.quorum` | `integer; minimum=1` |
| `verify.model` | `string; minLength=1` |
| `verify.fallback_model` | `string; minLength=1` |
| `verify.blind_mode` | `enum; enum=["full","defects_only","off"]` |
| `verify.risk_voters` | `integer; minimum=1` |
| `council` | `object; extra=false` |
| `council.members` | `array; minItems=1; maxItems=9` |
| `council.members[].uses` | `string *; pattern="^rio/[a-z][a-z0-9-]*(@[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?)?$"` |
| `council.members[].provider` | `string; pattern="^[a-z][a-z0-9-]*$"` |
| `council.members[].model` | `string; minLength=1` |
| `council.members[].family` | `string; pattern="^[a-z][a-z0-9-]*$"` |
| `council.members[].self_hosted` | `boolean` |
| `council.max_findings` | `integer; default=5; minimum=1` |
| `council.max_experiments` | `integer; default=2; minimum=0` |
| `council.max_rounds` | `integer; default=2; minimum=1; maximum=2` |
| `council.min_members` | `integer; default=3; minimum=1` |
| `council.timeout` | `string; default="90s"; pattern="^([0-9]+(\\.[0-9]+)?)(ms\|s\|m\|h\|d)$"` |
| `council.vendors_allowed` | `array; default=[]; uniqueItems=true` |
| `council.vendors_allowed[]` | `string` |

<!-- profile-schema:end -->

<!-- qa-config-schema:start -->

## QA environment fields

Generated from `schemas/qa-config-v1.json`. `*` means required. `extra=false` rejects unknown keys. Semantic validation still applies.

| Field | Type / constraints |
| --- | --- |
| `version` | `value *; const=1` |
| `app` | `object *; extra=false` |
| `app.packaging` | `enum *; enum=["image","static","vendored"]` |
| `app.dockerfile` | `string; pattern="^(?!/)(?![A-Za-z]:)(?!.*(?:^\|/)\\.\\.(?:/\|$))(?!.*\\\\).+$"; minLength=1` |
| `app.directory` | `string; pattern="^(?!/)(?![A-Za-z]:)(?!.*(?:^\|/)\\.\\.(?:/\|$))(?!.*\\\\).+$"; minLength=1` |
| `app.start` | `string; minLength=1` |
| `app.url` | `string *; pattern="^https?://[^ ]+$"` |
| `app.ready` | `object *; extra=false` |
| `app.ready.path` | `string *; minLength=1` |
| `app.ready.status` | `integer *; minimum=100; maximum=599` |
| `app.ready.timeout` | `value; oneOf=[{"type":"integer","minimum":1},{"type":"string","pattern":"^[1-9][0-9]*(ms\|s\|m\|h)$"}]` |
| `app.env` | `object` |
| `app.seed` | `string; minLength=1` |
| `app.workdir` | `string; pattern="^(?!/)(?![A-Za-z]:)(?!.*(?:^\|/)\\.\\.(?:/\|$))(?!.*\\\\).+$"; minLength=1` |
| `app.routes_from` | `value; oneOf=[{"type":"object","properties":{"convention":{"enum":["next-app","next-pages","sveltekit","remix","nuxt","astro","none"]}},"required":["convention"],"additionalProperties":false},{"type":"object","properties":{"map":{"type":"array","items":{"type":"object","properties":{"glob":{"type":"string","minLength":1},"route":{"type":"string","minLength":1}},"required":["glob","route"],"additionalProperties":false},"minItems":1}},"required":["map"],"additionalProperties":false}]` |
| `personas` | `array *; minItems=1` |
| `personas[].name` | `string *; pattern="^[a-z][a-z0-9-]*$"` |
| `personas[].description` | `string *; minLength=1` |
| `personas[].username_env` | `string; pattern="^[A-Za-z_][A-Za-z0-9_]*$"` |
| `personas[].password_env` | `string; pattern="^[A-Za-z_][A-Za-z0-9_]*$"` |
| `browser` | `object; extra=false` |
| `browser.viewports` | `array; minItems=1; uniqueItems=true` |
| `browser.color_schemes` | `array; minItems=1; uniqueItems=true` |
| `browser.color_schemes[]` | `enum=["light","dark"]` |
| `harness` | `object; extra=false` |
| `harness.default` | `enum; enum=["codex","pi"]` |
| `harness.model` | `string; minLength=1` |
| `harness.auth` | `enum; enum=["auto","subscription","gateway"]` |
| `rules` | `object; extra=false` |
| `rules.disable` | `array; minItems=0; uniqueItems=true` |
| `rules.disable[]` | `string` |
| `rules.adopt` | `array; minItems=0; uniqueItems=true` |
| `rules.adopt[]` | `string` |
| `rules.add` | `array; minItems=0` |
| `rules.add[].id` | `string *; pattern="^project/[a-z][a-z0-9-]*$"` |
| `rules.add[].category` | `enum *; enum=["functional","ux","style","accessibility"]` |
| `rules.add[].severity` | `enum *; enum=["error","warning","info"]` |
| `rules.add[].description` | `string *; minLength=1` |
| `rules.ignore_console` | `array; minItems=0; uniqueItems=true` |
| `rules.ignore_console[]` | `string` |
| `evidence` | `object; extra=false` |
| `evidence.video` | `boolean` |
| `evidence.retention_days` | `integer; minimum=1` |
| `seed` | `object; extra=false` |
| `seed.manifest` | `string; pattern="^(?!/)(?![A-Za-z]:)(?!.*(?:^\|/)\\.\\.(?:/\|$))(?!.*\\\\).+$"; minLength=1` |
| `seed.migrations` | `array; minItems=0; uniqueItems=true` |
| `seed.migrations[]` | `string` |
| `seed.max_size` | `value; oneOf=[{"type":"integer","minimum":1},{"type":"string","pattern":"^[1-9][0-9]* ?(B\|KiB\|MiB\|GiB)$"}]` |
| `seed.fallback_rebuild` | `boolean` |
| `seed.cache_version` | `value; oneOf=[{"type":"string","minLength":1},{"type":"integer","minimum":0}]` |

<!-- qa-config-schema:end -->

<!-- qa-journey-schema:start -->

## Journey fields

Generated from `schemas/journey-v1.json`. `*` means required. `extra=false` rejects unknown keys. Semantic validation still applies.

| Field | Type / constraints |
| --- | --- |
| `version` | `value *; const=1` |
| `name` | `string *; pattern="^[a-z][a-z0-9-]*$"` |
| `title` | `string *; minLength=1` |
| `persona` | `string *; pattern="^[a-z][a-z0-9-]*$"` |
| `tags` | `array *; minItems=0; uniqueItems=true` |
| `tags[]` | `string` |
| `covers` | `object *; extra=false; anyOf=[{"required":["paths"],"properties":{"paths":{"minItems":1}}},{"required":["routes"],"properties":{"routes":{"minItems":1}}}]` |
| `covers.paths` | `array; minItems=0; uniqueItems=true` |
| `covers.paths[]` | `string` |
| `covers.routes` | `array; minItems=0; uniqueItems=true` |
| `covers.routes[]` | `string` |
| `preconditions` | `array *; minItems=0` |
| `preconditions[]` | `string` |
| `steps` | `array *; minItems=1` |
| `steps[].do` | `string *; minLength=1` |
| `steps[].at` | `string; minLength=1` |
| `steps[].hint` | `string; minLength=1` |
| `steps[].expect` | `string; minLength=1` |
| `success` | `array *; minItems=1` |
| `success[]` | `string` |
| `after` | `array; minItems=1; uniqueItems=true` |
| `after[]` | `string` |
| `resets` | `boolean` |
| `viewports` | `array; minItems=1; uniqueItems=true` |
| `viewports[]` | `string` |
| `desktop_only` | `boolean` |
| `reason` | `string; minLength=1` |
| `context` | `object; extra=false` |
| `context.time` | `string; format="date-time"` |
| `context.timezone` | `string; minLength=1` |
| `context.locale` | `string; minLength=1` |
| `context.geolocation` | `object; extra=false` |
| `context.geolocation.latitude` | `number *; minimum=-90; maximum=90` |
| `context.geolocation.longitude` | `number *; minimum=-180; maximum=180` |
| `context.geolocation.accuracy` | `number; minimum=0` |
| `context.network` | `enum; enum=["online","slow-3g","offline"]` |
| `sync_reason` | `string; minLength=1` |
| `goal` | `string; minLength=1` |
| `guidance_refs` | `array; minItems=0` |
| `guidance_refs[].path` | `string *; pattern="^(?!/)(?![A-Za-z]:)(?!.*(?:^\|/)\\.\\.(?:/\|$))(?!.*\\\\).+$"; minLength=1` |
| `guidance_refs[].hash` | `string *; pattern="^[a-f0-9]{64}$"` |
| `guidance_refs[].start_line` | `integer *; minimum=1` |
| `guidance_refs[].end_line` | `integer *; minimum=1` |
| `ux_criteria` | `array; minItems=0; uniqueItems=true` |
| `ux_criteria[]` | `string` |

<!-- qa-journey-schema:end -->

<!-- qa-seed-schema:start -->

## Seed fields

Generated from `schemas/qa-seed-v1.json`. `*` means required. `extra=false` rejects unknown keys. Semantic validation still applies.

| Field | Type / constraints |
| --- | --- |
| `version` | `value *; const=1` |
| `datastores` | `array *; minItems=0` |
| `datastores[].name` | `string *; pattern="^[a-z][a-z0-9-]*$"` |
| `datastores[].kind` | `enum *; enum=["sqlite","postgres","mysql","redis","files","custom"]` |
| `datastores[].connection_env` | `string; pattern="^[A-Za-z_][A-Za-z0-9_]*$"` |
| `datastores[].start` | `string; minLength=1` |
| `datastores[].ready` | `string; minLength=1` |
| `datastores[].capture` | `string; minLength=1` |
| `datastores[].restore` | `string; minLength=1` |
| `steps` | `array *; minItems=0` |
| `steps[].command` | `string; minLength=1` |
| `steps[].file` | `string; pattern="^(?!/)(?![A-Za-z]:)(?!.*(?:^\|/)\\.\\.(?:/\|$))(?!.*\\\\).+$"; minLength=1` |
| `steps[].applies_to` | `array *; minItems=1; uniqueItems=true` |
| `steps[].applies_to[]` | `string` |
| `users` | `array *; minItems=0` |
| `users[].persona` | `string *; pattern="^[a-z][a-z0-9-]*$"` |
| `users[].apply` | `string *; minLength=1` |
| `paths` | `array *; minItems=0; uniqueItems=true` |
| `paths[]` | `string` |

<!-- qa-seed-schema:end -->

<!-- qa-fixtures-schema:start -->

## Fixture fields

Generated from `schemas/qa-fixtures-v1.json`. `*` means required. `extra=false` rejects unknown keys. Semantic validation still applies.

| Field | Type / constraints |
| --- | --- |
| `version` | `value *; const=1` |
| `files` | `array; minItems=0` |
| `files[].name` | `string *; pattern="^[a-z][a-z0-9-]*$"` |
| `files[].path` | `string; pattern="^\\.rio/qa/fixtures/files/(?!.*(?:^\|/)\\.\\.(?:/\|$))[^\\\\]+$"` |
| `files[].generate` | `object; extra=false` |
| `files[].generate.kind` | `enum *; enum=["image","pdf","csv","json","text","binary"]` |
| `files[].generate.size` | `integer; minimum=1` |
| `files[].generate.width` | `integer; minimum=1` |
| `files[].generate.height` | `integer; minimum=1` |
| `files[].generate.rows` | `integer; minimum=1` |
| `services` | `array; minItems=0` |
| `services[].name` | `string *; pattern="^[a-z][a-z0-9-]*$"` |
| `services[].kind` | `enum *; enum=["http-mock","smtp-capture","sms-capture","webhook-sink","oauth-provider","s3","custom"]` |
| `services[].env` | `object *` |
| `services[].claims` | `array; minItems=0; uniqueItems=true` |
| `services[].claims[]` | `string` |
| `services[].recordings` | `string; pattern="^(?!/)(?![A-Za-z]:)(?!.*(?:^\|/)\\.\\.(?:/\|$))(?!.*\\\\).+$"; minLength=1` |
| `services[].behaviors` | `array; minItems=0; uniqueItems=true` |
| `services[].behaviors[]` | `string` |
| `services[].default_behavior` | `string; pattern="^[a-z][a-z0-9-]*$"` |
| `services[].start` | `string; minLength=1` |
| `services[].ready` | `string; minLength=1` |
| `capture` | `object; extra=false` |
| `capture.mail` | `boolean` |
| `capture.sms` | `boolean` |
| `capture.webhooks` | `boolean` |
| `defaults` | `object; extra=false` |
| `defaults.time` | `string; format="date-time"` |
| `defaults.timezone` | `string; minLength=1` |
| `defaults.locale` | `string; minLength=1` |
| `defaults.geolocation` | `object; extra=false` |
| `defaults.geolocation.latitude` | `number *; minimum=-90; maximum=90` |
| `defaults.geolocation.longitude` | `number *; minimum=-180; maximum=180` |
| `defaults.geolocation.accuracy` | `number; minimum=0` |
| `defaults.network` | `enum; enum=["online","slow-3g","offline"]` |

<!-- qa-fixtures-schema:end -->

<!-- module-options:start -->

## Built-in module options

### `rio/adapter-python@0.1.0` (adapter)

Source: `modules/adapters/python/module.yaml`

No configurable options.

### `rio/adapter-rust@0.1.0` (adapter)

Source: `modules/adapters/rust/module.yaml`

No configurable options.

### `rio/adapter-typescript@0.1.0` (adapter)

Source: `modules/adapters/typescript/module.yaml`

No configurable options.

### `rio/council-code-owner@0.1.0` (member)

Source: `modules/members/code-owner/module.yaml`

No configurable options.

### `rio/council-exploit-author@0.1.0` (member)

Source: `modules/members/exploit-author/module.yaml`

No configurable options.

### `rio/council-maintainer@0.1.0` (member)

Source: `modules/members/maintainer/module.yaml`

No configurable options.

### `rio/council-skeptic@0.1.0` (member)

Source: `modules/members/skeptic/module.yaml`

No configurable options.

### `rio/council-tester@0.1.0` (member)

Source: `modules/members/tester/module.yaml`

No configurable options.

### `rio/agents@0.1.0` (step)

Source: `modules/steps/agents/module.yaml`

```text
cache: boolean; default=true
parts: integer; default=1; minimum=1; maximum=8
```

### `rio/checks@0.1.0` (step)

Source: `modules/steps/checks/module.yaml`

```text
typecheck: boolean; default=true
lint: boolean; default=true
secrets: boolean; default=true
coverage: boolean; default=true
dependencies: boolean; default=true
baseline: boolean; default=true
trust_installed_dependencies: boolean; default=false
```

### `rio/council@0.1.0` (step)

Source: `modules/steps/council/module.yaml`

```text
enabled: boolean; default=false
```

### `rio/graph@0.1.0` (step)

Source: `modules/steps/graph/module.yaml`

```text
hops: integer; default=2; minimum=0
max_nodes: integer; default=2000; minimum=1
```

### `rio/prepare@0.1.0` (step)

Source: `modules/steps/prepare/module.yaml`

```text
exclude: array; default=[]
exclude[]: string
omit: array; default=[]
omit[]: string
```

### `rio/qa@0.1.0` (step)

Source: `modules/steps/qa/module.yaml`

```text
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
```

### `rio/report@0.1.0` (step)

Source: `modules/steps/report/module.yaml`

```text
class_threshold: integer; default=3; minimum=1
proposal_threshold: integer; default=3; minimum=1
```

### `rio/security@0.2.0` (step)

Source: `modules/steps/security/module.yaml`

```text
enabled: boolean; default=false
posture: enum; enum=["critical-only","balanced","thorough"]; default="thorough"
follow_up: boolean; default=true
challenge: enum; enum=["auto","always","never"]; default="auto"
max_defects: integer; minimum=1
catalog: enum; enum=["owasp-top10-2025","asvs-5.0"]; default="owasp-top10-2025"
fail_on: object; default={"evidence":"plausible","categories":["security"],"states":["new","worsened"],"rules":[],"incomplete":true,"required_checks":[]}; extra=false
fail_on.evidence: enum; enum=["reproduced","static_proven","plausible","refuted"]
fail_on.categories: array; uniqueItems=true
fail_on.categories[]: enum=["defect","risk","security"]
fail_on.states: array; uniqueItems=true
fail_on.states[]: enum=["new","worsened","pre-existing","fixed","unclassified"]
fail_on.rules: array
fail_on.rules[]: string
fail_on.incomplete: boolean
fail_on.required_checks: array; uniqueItems=true
fail_on.required_checks[]: enum=["typecheck","lint","secrets","coverage","dependencies"]
```

### `rio/triage@0.1.0` (step)

Source: `modules/steps/triage/module.yaml`

```text
sensitive_paths: array; default=[]
sensitive_paths[]: string
public_contracts: boolean; default=true
dependency_changes: boolean; default=true
missing_coverage: boolean; default=true
fan_out_high: integer; default=20; minimum=1
```

### `rio/verify@0.1.0` (step)

Source: `modules/steps/verify/module.yaml`

```text
run: boolean; default=true
```

<!-- module-options:end -->

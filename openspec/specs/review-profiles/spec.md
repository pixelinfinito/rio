# review-profiles Specification

## Purpose

Review profiles are versioned YAML documents that declare what a review runs, with what budgets and policies; the engine interprets them, so review behavior is configurable and shareable rather than hard-coded.

## Requirements

### Requirement: Profile discovery order
A profile given as an existing file path SHALL be loaded from that path. A profile given by name SHALL be searched in order in `.rio/profiles/<name>.yaml`, `~/.config/rio/profiles/<name>.yaml`, then the built-in set as `rio/<name>`. When no profile is given, the default SHALL be the first of `.rio/profiles/default.yaml`, `~/.config/rio/profiles/default.yaml`, `rio/base`.

#### Scenario: Name resolves to the repo copy first
- **WHEN** `--profile security` is given and both `.rio/profiles/security.yaml` and a built-in `rio/security` exist
- **THEN** the repo file is used

### Requirement: Schema version 1
A profile SHALL declare `version: 1`. The top-level keys SHALL be `version`, `name`, `extends`, `budget`, `models`, `steps`, `suppress`, `publish`, `fail_on`, `min_evidence`, `max_lines`, `posture`, `max_defects`, `rounds`, `always_human`, `verify`. Unknown top-level keys SHALL be rejected. `posture`, `max_defects`, `rounds`, `always_human` and `verify` are optional with defaults, so a document without them validates. The schema SHALL be published as `schemas/profile-v1.json` and the engine's validation SHALL accept exactly the documents that schema accepts, plus the semantic rules below.

#### Scenario: Unknown key rejected
- **WHEN** a profile contains a top-level `agents:` key
- **THEN** validation fails naming the key and its location

#### Scenario: Wrong version rejected
- **WHEN** a profile declares `version: 2`
- **THEN** validation fails stating that only version 1 is supported

### Requirement: Posture and reserved convergence keys
`posture` SHALL be one of `critical-only`, `balanced` (default), `thorough`. Resolution SHALL derive from it, in this order of precedence (explicit key in the same resolved document first, then posture, then schema default): `min_evidence` (`reproduced`, `static_proven`, `plausible`), `max_defects` (3, 10, 15), the severity floor for defects (`error`, `warning`, `info`) and whether `plausible` risks render (no; yes up to `max_defects`; yes uncapped). An explicit `max_defects` SHALL be a positive integer, default 10. `rounds` SHALL have `cap` (positive integer, default 3) and `diff_only_after` (non-negative integer below `cap`, default 1). `always_human` SHALL be a list of globs relative to the repository root, default `[]`. The derived values SHALL be written to the resolved profile so they are part of the review id. After verification, agent findings SHALL consume the resolved posture and caps. When a changed file matches an `always_human` glob, the report's `risk_tier` SHALL be `high` with a reason naming the glob. `max_defects` and the severity floor SHALL never apply to deterministic findings, and the footer SHALL distinguish deferred policy from policy actually applied. `rounds` behavior remains owned by the review-convergence change.

#### Scenario: Posture derives the evidence floor
- **WHEN** a profile sets `posture: critical-only` and no `min_evidence`
- **THEN** the resolved profile has `min_evidence: reproduced`, `max_defects: 3`, and `plausible` risks are marked as not rendered

#### Scenario: Explicit key wins over posture
- **WHEN** a profile sets `posture: critical-only` and `max_defects: 8`
- **THEN** the resolved profile has `max_defects: 8` and `min_evidence: reproduced`

#### Scenario: Posture cannot breach the floor
- **WHEN** a profile sets `posture: thorough`
- **THEN** the resolved `min_evidence` is `plausible`, which is the floor; no posture value or explicit key resolves below it

#### Scenario: Always-human path sets the risk tier
- **WHEN** a profile sets `always_human: [".github/workflows/**", "scripts/install.*"]` and a change edits `.github/workflows/release.yml`
- **THEN** the report's `risk_tier` is `{ tier: high, reasons: ["always_human: .github/workflows/**"], source: always_human }`

#### Scenario: Deterministic findings are never capped
- **WHEN** `max_defects` is 3 and the type check reports seven new errors
- **THEN** all seven findings are rendered

### Requirement: Single inheritance
A profile MAY declare one `extends` referencing another profile by name or path. A relative path SHALL be resolved against the directory of the file that declares it, not against the current directory. A name SHALL be resolved with the discovery order. Resolution SHALL deep-merge mappings, child over parent, and SHALL replace lists wholesale when the child declares them. Inheritance cycles SHALL be rejected. The resolved profile SHALL record the full chain.

#### Scenario: Child overrides a nested budget value
- **WHEN** the parent sets `budget.fast.wall_time: 4m` and `budget.fast.tokens: 200000`, and the child sets only `budget.fast.wall_time: 2m`
- **THEN** the resolved profile has `wall_time: 2m` and `tokens: 200000`

#### Scenario: Child list replaces the parent list
- **WHEN** the parent declares three `suppress` entries and the child declares one
- **THEN** the resolved profile has exactly the child's one entry

#### Scenario: Relative extends resolved from the declaring file
- **WHEN** `.rio/profiles/team/strict.yaml` declares `extends: ../shared.yaml` and `rio review --profile ../.rio/profiles/team/strict.yaml` runs from the `src/` directory
- **THEN** the parent loaded is `.rio/profiles/shared.yaml`

#### Scenario: Inheritance cycle
- **WHEN** profile A extends B and B extends A
- **THEN** validation fails and names the cycle

### Requirement: Semantic validation
Beyond the schema, validation SHALL reject: step ids that are not unique; `needs` referencing unknown steps or forming a cycle; `uses` references that do not resolve to a built-in `rio/*` module (third-party refs are rejected with a message saying they are not supported in this version); `with` blocks that fail the referenced module's own schema; non-positive budgets; the resolved verification model equal to `models.default` when `verify.voters` is 1; invalid verifier counts or unresolved explicit model aliases; rule expressions that do not parse; `min_evidence` below `plausible`; `posture` outside its enum; non-positive `max_defects` or `rounds.cap`; `rounds.diff_only_after` not below `rounds.cap`; and `always_human` entries that are not valid globs.

#### Scenario: Verifier model must differ
- **WHEN** a profile sets `models.default: anthropic/claude-sonnet-5-5` and `models.verifier: anthropic/claude-sonnet-5-5`, with `verify.voters: 1`
- **THEN** validation fails stating the verifier alias must differ from the default

#### Scenario: Module option fails its schema
- **WHEN** a step uses `rio/checks` with `with: { coverage: "yes" }`
- **THEN** validation fails naming the step, the option, and the expected type

#### Scenario: Quorum permits the same model
- **WHEN** a profile sets the same default and verifier model with `verify.voters: 3`
- **THEN** validation accepts that model configuration

#### Scenario: Explicit alias cannot bypass independence
- **WHEN** `verify.voters` is 1 and `verify.model` resolves to the same provider/model as `models.default`, even through a differently named alias
- **THEN** validation rejects the single-voter configuration

### Requirement: Guardrails cannot be overridden
A resolved profile that contains any enabled step using `rio/agents`, `rio/security` or `rio/qa` SHALL also contain a step using `rio/verify` that depends on it; removing or disabling the verifier through inheritance or triage SHALL be rejected. `min_evidence` SHALL never resolve below `plausible`.

#### Scenario: Dropping the verifier is rejected
- **WHEN** a child profile redeclares `steps` with the agents step but no `rio/verify` step
- **THEN** validation fails stating the verifier step is mandatory when agents are configured

#### Scenario: Security requires verification
- **WHEN** a profile enables `rio/security` but no verifier depends on it
- **THEN** validation rejects the unverified security pipeline

#### Scenario: QA requires verification
- **WHEN** a profile enables `rio/qa` but no verifier depends on it
- **THEN** validation rejects the unverified QA pipeline

### Requirement: Rule expressions are validated syntactically
`rules` entries SHALL use the expression language with predicates `touches(glob)`, `adds_dependency()`, `lines_changed > n`, `risk >= level`, `language == x` combined with `and`, `or`, `not`, and actions `enable(agent)`, `disable(agent)`, `budget(fast|deep)`, `require_human()`. Validation SHALL reject unknown predicates or actions. When the endpoint runtime is available, triage SHALL evaluate rules using the computed risk tier. Without that runtime, rules SHALL remain deferred and the footer SHALL explain why.

#### Scenario: Unknown predicate
- **WHEN** a rule reads `when: owns("src/**")`
- **THEN** validation fails naming `owns` as an unknown predicate

#### Scenario: Human override reaches triage rules
- **WHEN** an `always_human` path matches and a rule tests `risk >= high`
- **THEN** the rule observes high risk and the execution plan includes `require_human()`

### Requirement: Built-in step options
The `with` schemas of the built-in steps SHALL define the review settings that this version supports. Each option SHALL be validated against the step's schema:
- `rio/prepare`: `exclude` (list of globs relative to the repository root, default `[]`);
- `rio/checks`: `typecheck`, `lint`, `secrets`, `coverage`, `dependencies`, `baseline` (booleans, default `true`), and `trust_installed_dependencies` (boolean, default `false`);
- `rio/graph`: `hops` (default 2) and `max_nodes` (default 2000);
- `rio/agents`: `cache` (boolean, default `true`) controlling the agent result cache;
- `rio/security`: `enabled` (default false in base), `posture`, `fail_on`, `max_defects`, and `catalog` with the security-step contract;
- `rio/report`: `class_threshold` (integer, default 3, consumed by review convergence) and `proposal_threshold` (integer of at least 1, default 3, the dismissal count that yields a suppression proposal);
- `rio/qa`: `enabled` (default false in base), `mode` (`changed` default, `full`), `harness` (`codex` default, `pi`), `baseline` (default false), `max_journeys` (default 12), `max_defects` (default 15), `max_recommendations` (default 5), `viewports` (names from the contract, default all), `rules` (`disable[]`, `add[]`, `adopt[]`, merged over the contract), `sandbox` (`deny` default, `allow`) and `fail_on` with the same shape as the security policy, defaulting to category `ux` at evidence `plausible` for `new` and `worsened` findings of severity `warning` or above;
- `rio/triage`: explicit risk thresholds for sensitive-path globs, public-contract changes, dependency changes, missing coverage and graph fan-out.

#### Scenario: Exclusion glob from the profile
- **WHEN** the `rio/prepare` step sets `with: { exclude: ["docs/generated/**"] }` and a change modifies `docs/generated/api.ts`
- **THEN** the file is excluded from checks and the graph, and the footer lists it with reason `profile_exclude`

#### Scenario: Agent cache disabled
- **WHEN** the `rio/agents` step sets `with: { cache: false }`
- **THEN** the profile validates, no agent cache lookup is made during the review, and the report records zero cache lookups

#### Scenario: Invalid proposal threshold
- **WHEN** the `rio/report` step sets `with: { proposal_threshold: 0 }`
- **THEN** validation fails at that option's location naming the minimum of 1

#### Scenario: QA option fails its schema
- **WHEN** a profile sets `rio/qa` with `with: { harness: claude }`
- **THEN** validation fails naming the step, the option and the allowed values `codex` and `pi`

#### Scenario: Profile narrows the matrix but keeps mobile
- **WHEN** a profile sets the qa step's `viewports: [mobile-small, mobile, desktop]`
- **THEN** the resolved profile runs those three viewports; `viewports: [desktop, wide]` is rejected because no mobile viewport remains

#### Scenario: QA policy independent of general cap
- **WHEN** a profile has `max_defects: 3` and the QA step sets `max_defects: 10`
- **THEN** QA findings resolve their cap to ten and the general cap remains three

### Requirement: Local execution subset
When no endpoint is configured, the engine SHALL execute steps whose module is locally executable (`rio/prepare` without its intent agent, `rio/checks`, `rio/graph`, `rio/report`, and enabled `rio/qa` when a Docker daemon and the paired QA runner image are available) in `needs` order, and SHALL mark every other step (`rio/triage`, `rio/agents`, `rio/verify` and enabled `rio/security`) as deferred in the report without failing the run. When `rio/qa` is enabled but no runtime is available, it SHALL be deferred with reason `no_runtime`. Locally executed QA observations SHALL be reported as unverified in the QA section because `rio/verify` is deferred; probe findings SHALL render normally.

#### Scenario: Base profile runs locally
- **WHEN** `rio/base` is used with no endpoint
- **THEN** prepare, checks, graph and report execute, and triage, agents and verify appear in the footer as deferred

#### Scenario: Disabled security is not executed
- **WHEN** the base profile contains security with `with.enabled: false`
- **THEN** no security model call is made and the local deterministic subset still works

#### Scenario: QA runs locally with Docker
- **WHEN** the `rio/qa` built-in profile is used with no endpoint and Docker available
- **THEN** prepare, graph, qa and report execute; probe findings render at `static_proven`; agent observations render as unverified in the QA section; and verify is listed as deferred

### Requirement: Suppressions
`suppress` entries SHALL be one of `{ path: <glob> }`, `{ rule: <glob over rule ids> }`, `{ finding: <finding id> }`. Findings matching any entry SHALL be removed from the report and counted in the footer as suppressed.

#### Scenario: Rule glob suppresses a whole family
- **WHEN** the profile has `suppress: [ { rule: "lint/eslint/*" } ]`
- **THEN** no `lint/eslint/...` finding appears and the footer shows the suppressed count

### Requirement: Fail policy
`fail_on` SHALL have:
- `evidence`: the minimum evidence level that fails, default `static_proven`;
- `categories`: default `[defect]`;
- `states`: default `[new, worsened]`;
- `rules`: optional globs over rule ids that fail regardless of the other criteria;
- `incomplete`: default `true`. When it is true, the review is incomplete if any check ended `failed` or `cancelled`, or if a kind listed in `required_checks` has a scheduled root whose outcome is `skipped`;
- `required_checks`: kinds that must complete on every scheduled root, default `[]`. With the default, a skipped check (for example a missing tool) stays a warning.

The review exit code SHALL follow this policy as defined by the review CLI capability.

#### Scenario: Risks do not fail by default
- **WHEN** the only findings are `coverage/untested_change` risks and `fail_on` is not customized
- **THEN** the review exits 0

#### Scenario: Required check that could not run
- **WHEN** `fail_on.required_checks` is `[typecheck]` and `tsc` is not installed
- **THEN** the review exits 4 and names the skipped type check

#### Scenario: Incompleteness tolerated on request
- **WHEN** `fail_on.incomplete` is `false`, the coverage check times out and no finding matches `fail_on`
- **THEN** the review exits 0 and the footer still lists coverage as `cancelled` with reason `timeout`

#### Scenario: Explicit rule fails regardless of category
- **WHEN** `fail_on.rules` contains `coverage/*` and an `untested_change` risk is present
- **THEN** the review exits 1

### Requirement: Resolved profile stored with the review
The resolved profile, including the chain, the pinned versions of every referenced built-in module, and the engine version, SHALL be written to `profile.resolved.yaml` in the review cache, and its hash SHALL be part of the review id.

#### Scenario: Changing a suppression changes the review id
- **WHEN** a suppression is added to the profile and the same change is reviewed again
- **THEN** the review id differs from the previous run

### Requirement: An agent under several models
A step's agent declaration SHALL accept `models`, a list of one to four distinct model aliases, in place of or besides `model`; a declaration with neither SHALL be rejected. The agent SHALL review the same code once under each listed alias the profile defines, skipping an alias the profile does not define and an alias that resolves to a model already listed; with no listed alias defined it SHALL review once as without the list. The hypotheses of the reviews SHALL be combined before verification in the order of the list: a hypothesis SHALL be dropped when an earlier model raised a hypothesis with the same id, or one in the same file on overlapping lines with the same catalog item that shares at least three in ten of the words of the shorter statement. Two hypotheses of one model SHALL NOT be combined. The report's `agent_audit.raised_under` SHALL name, per hypothesis id, the aliases that raised it. Where one voter settles a hypothesis (`voters` or `risk_voters` of one), the resolved verification model SHALL differ from every model the lists resolve to.

#### Scenario: Two models find the same issue
- **WHEN** an agent declared with `models: [default, second]` raises the same issue on the same lines under both models
- **THEN** the issue is verified and reported once, in the words of `default`, and `agent_audit.raised_under` names both aliases for it

#### Scenario: Second model not defined
- **WHEN** a profile declares `models: [default, second]` for an agent and defines no `second` alias
- **THEN** the profile is valid and the agent reviews once under `default`

#### Scenario: One model's review fails
- **WHEN** one of an agent's two reviews fails
- **THEN** the report is partial, names the agent and the alias that failed, and carries what the other review raised

#### Scenario: One voter and a listed model
- **WHEN** a profile sets `verify: { risk_voters: 1 }` and an agent's `models` lists an alias of the verification model
- **THEN** validation rejects the profile at `/models/verifier`

#### Scenario: Security coverage of two reviews
- **WHEN** the security agent reviews under two models and each assesses different catalog items
- **THEN** the coverage lists an item as assessed when either review assessed it

### Requirement: Verification settings
Profiles SHALL accept optional `verify: { voters, quorum, model, risk_voters }`. Defaults SHALL be three voters, quorum two, and the `verifier` model alias when present, otherwise `default`. Voters and quorum SHALL be positive integers with quorum no greater than voters. An omitted quorum for one voter SHALL resolve to one. An explicit model alias SHALL resolve through `models`. `risk_voters` SHALL be a positive integer no greater than voters, SHALL default to voters, and when it is one the resolved verification model SHALL differ from `models.default`, as for one voter.

#### Scenario: Legacy profile remains valid
- **WHEN** a profile valid in v0.1 omits `verify`
- **THEN** it remains valid and resolves to three voters and quorum two

#### Scenario: Single verifier shorthand
- **WHEN** a profile declares `verify: { voters: 1 }` with a distinct verifier model
- **THEN** quorum resolves to one

#### Scenario: Impossible quorum rejected
- **WHEN** a profile sets `verify: { voters: 2, quorum: 3 }`
- **THEN** validation rejects the quorum with its configuration location

#### Scenario: Fewer voters for risks
- **WHEN** a profile with a distinct verifier model declares `verify: { risk_voters: 1 }`
- **THEN** it is valid and keeps three voters and quorum two for every other hypothesis

#### Scenario: Risk voters above voters rejected
- **WHEN** a profile sets `verify: { voters: 3, risk_voters: 4 }`
- **THEN** validation rejects `risk_voters` with its configuration location

#### Scenario: Explicit model takes precedence
- **WHEN** `verify.model` names an existing alias in a profile also defining `models.verifier`
- **THEN** verification uses the explicitly selected alias

#### Scenario: Unknown model alias rejected
- **WHEN** `verify.model` names an alias absent from `models`
- **THEN** validation rejects that explicit alias

### Requirement: Verifier budget configuration
Both `budget.fast` and `budget.deep` SHALL accept a positive integer `verify_tokens` bounding a voter's complete verification of one hypothesis. Resolution SHALL retain this limit or default it to 320,000 tokens, include it in the resolved profile and review identity, and preserve the overall review budget limits. A missing `budget.fast.tokens` SHALL resolve to 2,400,000 and a missing `budget.deep` to 4,800,000 tokens. A missing `budget.fast.wall_time` SHALL resolve to 10 minutes.

#### Scenario: Deep verification budget
- **WHEN** a deep review resolves `budget.deep.verify_tokens: 4000`
- **THEN** each voter has at most 4000 tokens per hypothesis across both turns, within the overall review budget

#### Scenario: Default token budgets
- **WHEN** a profile sets only `budget.fast.wall_time: 4m`
- **THEN** fast resolves to `tokens: 2400000`, `agents_max: 3`, `verify_tokens: 320000` and deep to `wall_time: 10m`, `tokens: 4800000`, `agents_max: 5`, `verify_tokens: 320000`

### Requirement: Review presets
Quick SHALL select `critical-only` posture and fast budget; Standard SHALL select `balanced` and fast budget; Deep SHALL select `thorough` and deep budget. Explicit evidence and defect-cap overrides SHALL retain their existing precedence. Deterministic findings SHALL remain outside agent posture and caps.

#### Scenario: Deep preset
- **WHEN** a user selects Deep without explicit evidence or cap overrides
- **THEN** the review uses thorough posture, deep budget, evidence floor plausible and defect cap fifteen

### Requirement: Security policy defaults
An enabled security step SHALL resolve its own posture, evidence floor and defect cap separately from the profile-level policy. Its default posture SHALL be thorough, with a default cap of fifteen and a fail policy selecting category security at evidence plausible for new or worsened findings. Explicit security options SHALL override only the security policy.

#### Scenario: Security ignores general cap
- **WHEN** a profile has `max_defects: 3` and security specifies `max_defects: 8`
- **THEN** security resolves its cap to eight and the general cap remains three

### Requirement: Security community profile
Rio SHALL ship a built-in profile named `rio/security` that extends `rio/base` and enables the security step with `posture: thorough` and `catalog: asvs-5.0`. It SHALL validate without an endpoint, and its resolution SHALL show the security step enabled.

#### Scenario: Community profile validates offline
- **WHEN** `rio profile validate rio/security` runs with no endpoint configured
- **THEN** validation passes and `rio profile show rio/security` shows the security step enabled with thorough posture and catalog `asvs-5.0`

### Requirement: QA budget block
`budget.<mode>` SHALL accept an optional `qa` object with `wall`, `cell_wall`, `tokens`, `evidence_bytes` and `replay_wall`; profile-v1 SHALL publish it and validation SHALL reject non-positive values. When a profile enables `rio/qa`, the review deadline SHALL be `wall_time` plus `qa.wall` plus the verification reserve, and the resolved values SHALL be written to the resolved profile.

#### Scenario: QA budget defaults
- **WHEN** a profile enables `rio/qa` without a `qa` budget object
- **THEN** fast resolves to `wall: 30m`, `cell_wall: 8m`, `tokens: 150000`, `evidence_bytes: 512 MiB`, `replay_wall: 5m` and deep to `90m`, `15m`, `300000`, `1 GiB`, `10m`

#### Scenario: Deadline extended by QA
- **WHEN** `budget.fast.wall_time` is `4m`, QA is enabled with default `qa.wall` and the verification reserve is 5 minutes
- **THEN** the resolved review deadline is 39 minutes and the resolved profile records all three parts

#### Scenario: Unknown QA budget key rejected
- **WHEN** a profile sets `budget.fast.qa.journeys: 3`
- **THEN** validation fails naming the key

### Requirement: QA built-in profile
A built-in profile `rio/qa` SHALL extend `rio/base`, enable `rio/qa` in `changed` mode with `needs: [graph]`, add `qa` to the verifier's and the report's `needs`, and keep every other step as in base. `rio/base` SHALL carry `rio/qa` disabled with the same wiring so a document extending it can enable QA by setting one option.

#### Scenario: Enable with one key
- **WHEN** a repository profile extends `rio/base` and sets the qa step's `with.enabled: true`
- **THEN** the resolved profile runs QA in changed mode with the default budgets and policy and `verify` depends on `qa`

#### Scenario: Base makes no QA calls
- **WHEN** `rio/base` is reviewed
- **THEN** no pod is started for QA and no QA model call is made

#### Scenario: Standalone selection remains explicit in the resolved run
- **WHEN** `rio qa --journey checkout` uses an enabled QA profile
- **THEN** resolved run metadata records `qa_standalone: true`, the QA step carries `journeys: [checkout]`, and local and hosted execution skip steps outside prepare, graph, QA, verify and report with reason `standalone`; verifier requirements and configured spending limits remain enforced

### Requirement: Recommendation capacity and policy
The QA step SHALL accept `max_recommendations` (non-negative integer, default 5) independently of `max_defects`. Recommendations SHALL NOT match `fail_on`, regardless of priority or verification status. Ranking SHALL use evidenced user impact, task criticality and confidence, with stable-id tie-breaking. Zero SHALL suppress recommendation presentation while retaining assessment coverage and held-back counts.

#### Scenario: Defect cap does not hide UX recommendations
- **WHEN** the defect cap is exhausted and two supported recommendations are within the recommendation cap
- **THEN** both remain visible without changing the check conclusion

#### Scenario: Supported recommendations receive presentation priority
- **WHEN** supported and unverified or inconclusive candidates compete for the recommendation cap
- **THEN** supported recommendations are selected first, remaining slots may show labeled candidates locally, rejected and dismissed candidates are excluded, and publishing includes only supported recommendations

#### Scenario: Recommendation cap exhausted
- **WHEN** seven supported recommendations exist and the cap is five
- **THEN** five are shown in ranked order, two are counted as held back, and the full records remain in the run record

### Requirement: QA profile verification budgets
The `rio/qa` profile SHALL allocate 500 000 review tokens with 60 000 per verifier voter in fast mode and 1 000 000 review tokens with 120 000 per voter in deep mode. Both voter turns SHALL share that allowance and remain subject to the shared review ledger. User budget overrides SHALL remain supported.

#### Scenario: Screenshot and guidance allowance
- **WHEN** the built-in QA profile resolves without overrides
- **THEN** its fast and deep verifier budgets use the explicit allowances above rather than the inherited text-only defaults

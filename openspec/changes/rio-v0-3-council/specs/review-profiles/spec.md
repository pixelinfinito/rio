# Spec Delta

## MODIFIED Requirements

### Requirement: Rule expressions are validated syntactically
`rules` entries SHALL use the expression language with predicates `touches(glob)`, `adds_dependency()`, `lines_changed > n`, `risk >= level`, `language == x`, `risk_tier == tier`, `mode == fast|deep`, `nightly`, and the finding-level predicates `evidence == level`, `severity >= level` (on the finding severity scale `info` < `warning` < `error`) and `verify.split`, combined with `and`, `or`, `not`, and actions `enable(agent)`, `disable(agent)`, `budget(fast|deep)`, `require_human()`. The finding-level predicates SHALL be valid only in the council step's `rules` and SHALL be rejected in any other step's rules. A council step's rules select findings and carry only `when`; every other step's rules SHALL carry `then`. Validation SHALL reject unknown predicates or actions. When the endpoint runtime is available, triage SHALL evaluate rules using the computed risk tier. Without that runtime, rules SHALL remain deferred and the footer SHALL explain why.

#### Scenario: Unknown predicate
- **WHEN** a rule reads `when: owns("src/**")`
- **THEN** validation fails naming `owns` as an unknown predicate

#### Scenario: Human override reaches triage rules
- **WHEN** an `always_human` path matches and a rule tests `risk >= high`
- **THEN** the rule observes high risk and the execution plan includes `require_human()`

#### Scenario: Council rule on a split verdict
- **WHEN** the council step declares `rules: [ { when: "verify.split" } ]` and a hypothesis ends `plausible` with `verify.split`
- **THEN** validation accepts the rule and that finding is selected for the council

#### Scenario: Finding-level predicate outside the council step
- **WHEN** a triage rule reads `when: evidence == plausible`
- **THEN** validation fails naming `evidence` as a predicate allowed only in the council step's rules, with the rule's location

## ADDED Requirements

### Requirement: Council settings
Profiles SHALL accept an optional `council: { members, max_findings, max_experiments, max_rounds, min_members, timeout, vendors_allowed }` block. Defaults SHALL be five members, `max_findings` 5, `max_experiments` 2, `max_rounds` 2, `min_members` 3, `timeout` 90 s and `vendors_allowed` empty. Validation SHALL reject `max_rounds` above 2 and `min_members` above the member count. A v1 profile without `council` SHALL remain valid.

#### Scenario: Legacy profile without council
- **WHEN** a profile valid in v0.2 omits `council`
- **THEN** it remains valid and no council step runs

#### Scenario: Third round rejected
- **WHEN** a profile sets `council: { max_rounds: 3 }`
- **THEN** validation rejects the value at its configuration location and names 2 as the maximum

#### Scenario: Minimum exceeds member count
- **WHEN** a profile declares four members and `min_members: 5`
- **THEN** validation rejects `min_members` naming the member count

### Requirement: Council step in built-in profiles
`rio/base` SHALL carry no enabled council step. The `security` and `critical` built-in profiles SHALL enable the council step with the five default trigger rules (`evidence == plausible and severity >= error`, `verify.split`, `risk_tier == high`, `mode == deep`, `nightly`) and placeholder member providers, and `rio profile show` SHALL report placeholder providers as unconfigured until the vendor allowlist is written.

#### Scenario: Security profile before configuration
- **WHEN** `rio profile show rio/security` runs before any council vendor is configured
- **THEN** the council step is shown enabled with its five trigger rules and each placeholder member is marked unconfigured

#### Scenario: Base profile makes no council calls
- **WHEN** a review runs with `rio/base`
- **THEN** no council step runs and no member model call is made

### Requirement: Council guardrail
A council step SHALL declare `needs` including the verify step, so the council can only follow verification and never replaces it. Validation SHALL reject a council step whose `needs` omits verification.

#### Scenario: Council without verify rejected
- **WHEN** a profile declares a council step with `needs: [agents]`
- **THEN** validation fails at that step stating that the council requires the verify step

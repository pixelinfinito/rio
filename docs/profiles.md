# Profile schema v1

Profiles describe a review. Machine settings such as the cache path and parallelism belong in user `config.toml`. The authoritative schema is [`schemas/profile-v1.json`](../schemas/profile-v1.json); this table is generated with `python3 scripts/generate-profile-reference.py`.

<!-- schema:start -->

| Key | Type | Required |
| --- | --- | --- |
| `version` | `one of the schema alternatives` | yes |
| `name` | `string` | yes |
| `extends` | `string` | no |
| `budget` | `object` | no |
| `budget.fast` | `object` | no |
| `budget.fast.wall_time` | `string` | no |
| `budget.fast.tokens` | `integer` | no |
| `budget.fast.agents_max` | `integer` | no |
| `budget.fast.verify_tokens` | `integer` | no |
| `budget.fast.qa` | `object` | no |
| `budget.fast.qa.wall` | `string` | no |
| `budget.fast.qa.cell_wall` | `string` | no |
| `budget.fast.qa.tokens` | `integer` | no |
| `budget.fast.qa.evidence_bytes` | `integer` | no |
| `budget.fast.qa.replay_wall` | `string` | no |
| `budget.deep` | `object` | no |
| `budget.deep.wall_time` | `string` | no |
| `budget.deep.tokens` | `integer` | no |
| `budget.deep.agents_max` | `integer` | no |
| `budget.deep.verify_tokens` | `integer` | no |
| `budget.deep.qa` | `object` | no |
| `budget.deep.qa.wall` | `string` | no |
| `budget.deep.qa.cell_wall` | `string` | no |
| `budget.deep.qa.tokens` | `integer` | no |
| `budget.deep.qa.evidence_bytes` | `integer` | no |
| `budget.deep.qa.replay_wall` | `string` | no |
| `models` | `object` | no |
| `steps` | `array` | no |
| `steps[].id` | `string` | yes |
| `steps[].uses` | `string` | yes |
| `steps[].needs` | `array` | no |
| `steps[].parallel` | `boolean` | no |
| `steps[].with` | `object` | no |
| `steps[].rules` | `array` | no |
| `steps[].rules[].when` | `string` | yes |
| `steps[].rules[].then` | `string` | no |
| `steps[].agents` | `array` | no |
| `suppress` | `array` | no |
| `publish` | `one of the schema alternatives` | no |
| `fail_on` | `object` | no |
| `fail_on.evidence` | `one of the schema alternatives` | no |
| `fail_on.categories` | `array` | no |
| `fail_on.states` | `array` | no |
| `fail_on.rules` | `array` | no |
| `fail_on.incomplete` | `boolean` | no |
| `fail_on.required_checks` | `array` | no |
| `min_evidence` | `one of the schema alternatives` | no |
| `max_lines` | `integer` | no |
| `posture` | `one of the schema alternatives` | no |
| `max_defects` | `integer` | no |
| `rounds` | `object` | no |
| `rounds.cap` | `integer` | no |
| `rounds.diff_only_after` | `integer` | no |
| `always_human` | `array` | no |
| `verify` | `object` | no |
| `verify.voters` | `integer` | no |
| `verify.quorum` | `integer` | no |
| `verify.model` | `string` | no |
| `verify.risk_voters` | `integer` | no |
| `council` | `object` | no |
| `council.members` | `array` | no |
| `council.members[].uses` | `string` | yes |
| `council.members[].provider` | `string` | no |
| `council.members[].model` | `string` | no |
| `council.members[].family` | `string` | no |
| `council.members[].self_hosted` | `boolean` | no |
| `council.max_findings` | `integer` | no |
| `council.max_experiments` | `integer` | no |
| `council.max_rounds` | `integer` | no |
| `council.min_members` | `integer` | no |
| `council.timeout` | `string` | no |
| `council.vendors_allowed` | `array` | no |

<!-- schema:end -->

`version: 1` and a nonempty `name` are required. Unknown keys are rejected. Run `rio profile validate [name-or-path]` to see every schema and semantic error, with file and YAML path. `rio profile show name` prints the merged profile with module versions, source and inheritance chain; `--raw` shows the original document. `rio profile list` includes built-ins, personal and repository profiles and marks the default.

## Discovery and inheritance

An explicit existing file is resolved relative to the current directory. Otherwise a name is searched in `.rio/profiles/<name>.yaml`, the configuration directory's `profiles/<name>.yaml`, then built-ins. With no selection, `.rio/profiles/default.yaml` wins over personal `profiles/default.yaml`, then `rio/base`.

`extends` selects one parent. Relative paths are resolved against the declaring file, including parents of parents. Mappings merge recursively, scalar values replace, and lists replace in full. An empty child mapping preserves its parent. Inheritance cycles are errors. The resolved chain and pinned built-in module versions are persisted with the review.

## Local steps

Steps need unique `id` values. `needs` names existing steps and must form a DAG. `uses` names an embedded module, optionally pinned with `@0.1.0`. Third-party modules are rejected in v0.1. Each `with` block is checked against the module's own schema.

| Module | Options | Local behavior |
| --- | --- | --- |
| `rio/prepare` | `exclude: [glob, ...]` | Detection, exclusions and size notes |
| `rio/checks` | `typecheck`, `lint`, `secrets`, `coverage`, `dependencies`, `baseline` (all default true); `trust_installed_dependencies` (default false) | Bounded deterministic checks and baseline comparison |
| `rio/graph` | `hops: 2`, `max_nodes: 2000` | Base/head/delta graph and impact summary |
| `rio/report` | `class_threshold` (default 3); `proposal_threshold` (integer of at least 1, default 3; dismissals that yield a suppression proposal) | Suppressions, policy, summary and persistence |
| `rio/agents` | `cache` (default true; agent result cache) | Deferred locally with `no_endpoint` |
| `rio/triage`, `rio/verify` | reserved module-defined options | Deferred locally with `no_endpoint` |

Disabled checks have outcome `skipped`, reason `disabled`. Trust allows an unverifiable installation, never a known mismatch, and disables baseline classification. Trusted diagnostics remain unclassified. `baseline: false` also leaves diagnostic state unclassified.

`budget.fast.wall_time` is a positive duration such as `30s`, `4m` or `1h`. Check budgets are bounded by the remaining run budget: 40% for typecheck/lint, 60% for coverage and 10% for secrets/audit. `budget.deep` and token/agent limits are reserved for endpoint execution. `max_lines` triggers a size note. `min_evidence` cannot be below the supported floor. A single-voter verifier must resolve to a different model from the default. Enabled hypothesis producers require a dependent verifier step.

## Agent policy and human review

`posture` accepts `critical-only`, `balanced` (default), or `thorough`. When the merged document does not explicitly set `min_evidence` or `max_defects`, posture supplies their values:

| Posture | Evidence floor | Maximum agent defects | Agent defect severity floor | Plausible agent risks |
| --- | --- | --- | --- | --- |
| `critical-only` | `reproduced` | 3 | `error` | Hidden |
| `balanced` | `static_proven` | 10 | `warning` | Up to `max_defects` |
| `thorough` | `plausible` | 15 | `info` | Uncapped |

Explicit values in the merged document, including inherited values, win over posture defaults. `max_defects` must be positive. `rounds` defaults to `{cap: 3, diff_only_after: 1}`; `cap` must be positive and `diff_only_after` must be nonnegative and less than `cap`. Resolved profiles store these values and `posture_policy` (the derived `defect_severity_floor`, `render_plausible_risks`, and nullable `plausible_risk_limit`), so policy changes affect the review id.

Endpoint consolidation applies these limits after verification and the category floor. Deterministic findings and risks remain uncapped. Local reviews explain that model policy is deferred without an endpoint.

`always_human` is a list of repository-relative globs, default `[]`. A matching changed path sets `risk_tier` to `{tier: high, reasons: ["always_human: <glob>"], source: always_human}`. Endpoint triage otherwise derives the tier deterministically; local review leaves it `null`. This tier flags a need for human review; it grants no approval.

The prepare step records `REVIEW.md`, `CLAUDE.md`, and `AGENTS.md` from the repository root through each changed file's directory in `owner_guidance.json`. Entries are sorted by path and include `path`, `scope_dir` (empty for the repository root), a BLAKE3 `content_hash`, and `lines`. Content comes from the selected head, including in staged and branch modes. Endpoint agents and voters consume it as scoped, escaped data. Injection-pattern lines are replaced without shifting line coordinates. Guidance never enables tools or changes budgets, suppressions or publication. `guidance/contradiction` and `guidance/stale` risks require valid line citations and code evidence.

## Failure policy

```yaml
version: 1
name: strict
extends: rio/base
fail_on:
  evidence: static_proven
  categories: [defect]
  states: [new, worsened]
  rules: ['secret/*']
  incomplete: true
  required_checks: [typecheck, lint]
```

Evidence is ordered `refuted < plausible < static_proven < reproduced`. A finding matches when its evidence reaches the floor and its category and state are selected, or its rule matches an explicit rule glob. The default categories are `[defect]` and states `[new, worsened]`. Risks and pre-existing findings are visible without failing by default.

`incomplete: true` makes failed or cancelled checks cause exit 4. `required_checks` adds skipped kinds that must also cause exit 4. Supported kinds are `typecheck`, `lint`, `secrets`, `coverage`, `dependencies`. `incomplete: false` disables exit 4. A finding matching policy produces exit 1 before incompleteness is considered.

## Suppressions

```yaml
suppress:
  - path: 'generated/**'
  - rule: 'lint/eslint/no-unused-vars'
  - finding: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
```

Path globs, rule globs and exact finding IDs suppress grouped findings, including every serialized occurrence. The footer counts matches per entry; overlapping entries attribute each finding to its first matching suppression. Suppressed findings do not fail policy.

## Rules and agents

Step `rules` contain syntax-validated expressions/actions, and step `agents` hold endpoint agent declarations. Predicates and boolean operators are validated even in local mode. `publish` accepts `never`, `ask` or `auto`; local mode never publishes. Without an endpoint these declarations remain deferred. See [Cloudflare setup](cloudflare.md).

## Verifier quorum and presets

`verify: { voters: 3, quorum: 2 }` is the default. Omitted quorum becomes one for
one voter. `verify.model` resolves an explicit model alias, then falls back to
`verifier` if present, otherwise `default`. Single-voter independence compares
actual provider/model values, so another alias for the default cannot bypass it.
`verify.risk_voters` sets how many of the voters examine a hypothesis its agent
classed as a `risk` (a hazard it could not settle, or an improvement): such a
hypothesis is never reported as a defect, and its quorum is `quorum` or
`risk_voters`, whichever is smaller. It defaults to `voters`, may not exceed it,
and `risk_voters: 1` falls under the same single-voter independence rule.
`rio/openrouter`, whose verifier is another model than its agent's, sets
`risk_voters: 1`; a child profile restores the full panel with `risk_voters: 3`.
Both budget modes accept `verify_tokens`. Each voter's entire two-turn allowance
is 320,000 tokens unless overridden, whatever the review token budget. Agent tokens
are the active review token budget divided by `agents_max`. Resolution records the
defaults in the hashed profile. Defaults are fast 2,400,000 tokens / three agents
and deep 4,800,000 / five, with four- and ten-minute wall budgets. These are
ceilings on spend, not estimates of it. Every model call reserves from the
review-wide ledger, so a voter never spends more than the review has left; failed
calls retain unknown-usage reservations.

The `rio/qa` profile explicitly sets the review token limit to 500,000 in fast
mode and 1,000,000 in deep mode, with 60,000 and 120,000 tokens per verifier voter
respectively. Screenshots and scoped `REVIEW.md` guidance consume these allowances.
Both voter turns share one allowance; user profile overrides remain supported.

Quick selects critical-only/fast; Standard balanced/fast; Deep thorough/deep.
Use `--preset quick|standard|deep` or `--deep`. Explicit profile evidence/cap values
retain precedence. Presets require an online endpoint.

Each voter sees location, both versions, direct callers, intent and guidance before
the hypothesis is disclosed. Code computes `same` (rule + normalized trigger hash),
`related` (same symbol) or `none`. All-none does not lower artifact-backed evidence.
Only recorded executions and actual head graph paths support proof/refutation;
missing, exhausted or malformed votes cannot lower quorum. Separate positive and
refutation quorums yield a plausible split when both or neither reach quorum.

Style/diagnostic hypotheses stay in the audit footer. Eligible defects are ranked
by severity weight times evidence strength, then path, line and stable ID. General
defects and plausible risks have independent caps; thorough risks are uncapped.
Suppressions run before caps. Held-back titles stay in the audit/footer with cap
recovery guidance. Deterministic findings never consume those slots.

## Security policy

`rio/security@0.2.0` is disabled in `rio/base` and joins `rio/verify` independently
of correctness. Its options are `enabled`, `posture` (default thorough),
`max_defects` (posture default 3/5/15), `catalog` (`owasp-top10-2025`, the default,
or `asvs-5.0`; no other value or path is accepted) and `fail_on` (category security,
plausible, new/worsened by default). Security presentation has its own pool/cap.
Either general or security fail policy can fail an unsuppressed security finding
before presentation caps. Plausible security entries are risks for human judgment.

An enabled step runs the security agent with the resolved catalog. The catalogs
ship as `catalog` modules under `modules/catalogs/` (OWASP Top 10:2025 by category,
ASVS 5.0 by section, with the CC BY-SA 4.0 attribution OWASP requires). The step
gives the agent only the items whose `applies_when` predicates match the change
(languages, detected frameworks, touched endpoints, tables, events and
configuration, the triage `sensitive_paths`, and sinks found in the changed code),
plus a taint map of the items' sources and sinks in both versions. Every
security hypothesis carries the catalog item it relates to and goes through the
shared verifier. The report's security section and footer list the assessed,
unassessed (with reason `budget`, `no_evidence` or `tools_unavailable`) and
not-applicable items; a run with unassessed items is never presented as a passed
security review. On fork pull requests the agent is static-only.

The built-in `rio/security` community profile extends `rio/base` and only enables
the step with `posture: thorough` and `catalog: asvs-5.0`; every other base setting
is unchanged. Select it with `--profile rio/security` or `extends: rio/security`.

## Council

`rio/council@0.1.0` runs after `rio/verify` and before `rio/report` on the
findings the verifier leaves unsettled. It is present and disabled in `rio/base`,
and enabled in `rio/security` and `rio/critical` with five triggers in the step's
`rules`, which select findings and carry only `when`:
`evidence == plausible and severity >= error`, `verify.split`,
`risk_tier == high`, `mode == deep` and `nightly`. The finding-level predicates
(`evidence`, `severity` on the scale `info` < `warning` < `error`, `verify.split`)
are accepted only in the council step's rules; `risk_tier`, `mode` and `nightly`
are accepted in every rule. A council step must have the verify step in its
`needs`.

The `council` block sets `members` (default: the five built-in members
`rio/council-skeptic`, `-exploit-author`, `-code-owner`, `-maintainer` and
`-tester`, each with optional `provider`, `model`, `family` and `self_hosted`
overrides), `max_findings` (5), `max_experiments` (2), `max_rounds` (2, the
maximum), `min_members` (3, at most the member count), `timeout` (`90s`) and
`vendors_allowed` (empty). A fully configured council must span at least three
model families. Members whose provider is still `placeholder` are reported as
unconfigured by `rio profile validate` and `rio profile show` until `rio init`
writes the council allowlist; the profile stays valid. `rio/security` and
`rio/critical` allow the vendors Rio knows (`anthropic`, `openai`, `google`,
`mistral`, `xai`, `deepseek`, and `openrouter`, which forwards each pack to the
vendor that serves the model); the repository allowlist, empty by default, is
the opt-in, and a member runs only when both lists allow its vendor.
`rio/critical` extends `rio/security`, fails on security findings as well as
defects, and raises `max_findings` to 10 and `max_experiments` to 3.

Members get one identical evidence pack per finding and no tools; the decision is
deterministic (an experiment failing on head and passing on base reproduces the
finding, a protection the graph places on the path refutes it when members
holding at least half of the weight cite it and answer `real: no`, anything else
stays plausible with a council note), and agreement is never evidence. A council
never changes a finding's category and never fails or blocks a review: with
fewer than `min_members` answers it is skipped and the verifier's result stands.

`rio/triage` options are `sensitive_paths` (globs), `public_contracts`,
`dependency_changes`, `missing_coverage` (booleans), and `fan_out_high` (positive
integer, default 20). Sensitive paths/public contracts/fan-out produce high risk;
dependency changes/uncovered logic produce medium. `always_human` checks old and
new paths last and forces high plus `require_human()`. Risk rules select agents or
fast/deep budgets, never disable verification. Low risk never means approval.

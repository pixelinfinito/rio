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
| `budget.deep` | `object` | no |
| `budget.deep.wall_time` | `string` | no |
| `budget.deep.tokens` | `integer` | no |
| `budget.deep.agents_max` | `integer` | no |
| `models` | `object` | no |
| `steps` | `array` | no |
| `steps[].id` | `string` | yes |
| `steps[].uses` | `string` | yes |
| `steps[].needs` | `array` | no |
| `steps[].parallel` | `boolean` | no |
| `steps[].with` | `object` | no |
| `steps[].rules` | `array` | no |
| `steps[].rules[].when` | `string` | yes |
| `steps[].rules[].then` | `string` | yes |
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
| `rio/report` | none | Suppressions, policy, summary and persistence |
| `rio/triage`, `rio/agents`, `rio/verify` | reserved module-defined options | Deferred locally with `no_endpoint` |

Disabled checks have outcome `skipped`, reason `disabled`. Trust allows an unverifiable installation, never a known mismatch, and disables baseline classification. Trusted diagnostics remain unclassified. `baseline: false` also leaves diagnostic state unclassified.

`budget.fast.wall_time` is a positive duration such as `30s`, `4m` or `1h`. Check budgets are bounded by the remaining run budget: 40% for typecheck/lint, 60% for coverage and 10% for secrets/audit. `budget.deep` and token/agent limits are reserved for endpoint execution. `max_lines` triggers a size note. `min_evidence` cannot be below the supported floor. A verifier model must differ from the default model, and enabled agents require a verifier step.

## Reserved agent policy and human review

`posture` accepts `critical-only`, `balanced` (default), or `thorough`. When the merged document does not explicitly set `min_evidence` or `max_defects`, posture supplies their values:

| Posture | Evidence floor | Maximum agent defects | Agent defect severity floor | Plausible agent risks |
| --- | --- | --- | --- | --- |
| `critical-only` | `reproduced` | 3 | `error` | Hidden |
| `balanced` | `static_proven` | 5 | `warning` | Up to `max_defects` |
| `thorough` | `plausible` | 15 | `info` | Uncapped |

Explicit values in the merged document, including inherited values, win over posture defaults. For example, `rio/base` explicitly sets `min_evidence: plausible`. `max_defects` must be positive. `rounds` defaults to `{cap: 3, diff_only_after: 1}`; `cap` must be positive and `diff_only_after` must be nonnegative and less than `cap`. Resolved profiles store these values and `posture_policy` (the derived `defect_severity_floor`, `render_plausible_risks`, and nullable `plausible_risk_limit`), so policy changes affect the review id.

These limits are reserved for deferred agent steps in v0.1. Deterministic findings and risks remain uncapped, and profile validation and the report footer explain the deferral.

`always_human` is a list of repository-relative globs, default `[]`. A matching changed path sets `risk_tier` to `{tier: high, reasons: ["always_human: <glob>"], source: always_human}`. Otherwise it is `null`. This tier flags a need for human review; it grants no approval.

The prepare step records `REVIEW.md`, `CLAUDE.md`, and `AGENTS.md` from the repository root through each changed file's directory in `owner_guidance.json`. Entries are sorted by path and include `path`, `scope_dir` (empty for the repository root), a BLAKE3 `content_hash`, and `lines`. Content comes from the selected head, including in staged and branch modes. v0.1 stores it as data without interpreting it.

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

Step `rules` contain syntax-validated expressions/actions, and step `agents` hold endpoint agent declarations. Predicates and boolean operators are validated even in local mode. `publish` accepts `never`, `ask` or `auto`; local mode never publishes. These declarations do not enable remote execution in v0.1.

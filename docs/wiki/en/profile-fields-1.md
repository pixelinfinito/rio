# Profile fields 1

Use these exact keys with the [profile guide](profiles.md) or [QA guide](qa.md). See [Modules](modules.md) for complete schema tables and semantic rules. `*` marks required fields. Commands and keys are intentionally untranslated.

```text
version: value *; const=1
name: string *; minLength=1
extends: string; minLength=1
budget: object; extra=false
budget.prepare: string; pattern="^[1-9][0-9]*(s|m)$"
budget.fast: object; extra=false
budget.fast.wall_time: string; pattern="^([0-9]+(\\.[0-9]+)?)(ms|s|m|h|d)$"
budget.fast.tokens: integer; minimum=1
budget.fast.agents_max: integer; minimum=1
budget.fast.verify_tokens: integer; minimum=1
budget.fast.qa: object; extra=false
budget.fast.qa.wall: string; pattern="^[1-9][0-9]*(ms|s|m|h)$"
budget.fast.qa.cell_wall: string; pattern="^[1-9][0-9]*(ms|s|m|h)$"
budget.fast.qa.tokens: integer; minimum=1
budget.fast.qa.evidence_bytes: integer; minimum=1
budget.fast.qa.replay_wall: string; pattern="^[1-9][0-9]*(ms|s|m|h)$"
budget.deep: object; extra=false
budget.deep.wall_time: string; pattern="^([0-9]+(\\.[0-9]+)?)(ms|s|m|h|d)$"
budget.deep.tokens: integer; minimum=1
budget.deep.agents_max: integer; minimum=1
budget.deep.verify_tokens: integer; minimum=1
budget.deep.qa: object; extra=false
budget.deep.qa.wall: string; pattern="^[1-9][0-9]*(ms|s|m|h)$"
budget.deep.qa.cell_wall: string; pattern="^[1-9][0-9]*(ms|s|m|h)$"
budget.deep.qa.tokens: integer; minimum=1
budget.deep.qa.evidence_bytes: integer; minimum=1
budget.deep.qa.replay_wall: string; pattern="^[1-9][0-9]*(ms|s|m|h)$"
models: object
steps: array
steps[].id: string *; minLength=1
steps[].uses: string *; minLength=1
steps[].needs: array; uniqueItems=true
steps[].needs[]: string
steps[].parallel: boolean
steps[].with: object
steps[].rules: array
steps[].rules[].when: string *; minLength=1
steps[].rules[].then: string; minLength=1
steps[].agents: array
steps[].agents[]: object
suppress: array
publish: enum; enum=["never","ask","auto"]
fail_on: object; extra=false
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
min_evidence: enum; enum=["reproduced","static_proven","plausible","refuted"]
max_lines: integer; minimum=1
```

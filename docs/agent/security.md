# Security review

Security agent execution requires hosted AI configuration. Secrets scanning also runs locally. Security profiles may enable council; vendors and credentials need separate opt-in. Source/evidence can reach configured providers.

## run
`rio review --profile rio/security` selects the security profile; inspect it first with `rio profile show rio/security`. The rio/security step uses catalog owasp-top10-2025 or asvs-5.0. rio/security built-in uses thorough posture and ASVS, and declares its security agent with models: [default, second] (a child defining a second alias gets two security reviews, verified once; otherwise one under default); rio/base includes the step disabled. Copy all desired steps if customizing the list.

## findings
Reports show assessed, unassessed and not-applicable catalog items, with security findings and evidence. Trace roles identify source, intermediary steps and sink; a missing guard is distinct from proof of exploitation. Review severity and evidence_level separately. A plausible issue is not a reproduced exploit, and a catalog review is not a certification.

## policy
The rio/security step’s with.fail_on sets evidence, categories, states and rules; its default fails new/worsened security findings at plausible or stronger. validate against the installed schema/profile. Default general fail_on categories do not automatically make every security hypothesis fail. Budget/time/model failures remain visible as incomplete work. Inspect the profile's security policy before using results as a CI gate. Pending live evaluation gates remain pending even when the code is implemented.

<!-- schema-options:start -->
## option-fields
rio/security@0.2.0:
enabled: boolean; default=false
posture: enum; enum=["critical-only","balanced","thorough"]; default="thorough"
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

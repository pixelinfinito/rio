# Profile fields 2

Schema reference for profile. Edit the corresponding YAML intentionally; validate with rio profile validate or rio qa validate. * means required; extra=false rejects unknown keys. Semantic constraints and prerequisites are in the related guide.

## fields-1
max_defects: integer; default=10; minimum=1
rounds: object; default={"cap":3,"diff_only_after":1}; extra=false
rounds.cap: integer; default=3; minimum=1
rounds.diff_only_after: integer; default=1; minimum=0
always_human: array; default=[]
always_human[]: string
verify: object; extra=false
verify.voters: integer; default=3; minimum=1
verify.quorum: integer; minimum=1
verify.model: string; minLength=1

## fields-2
verify.risk_voters: integer; minimum=1
council: object; extra=false
council.members: array; minItems=1; maxItems=9
council.members[].uses: string *; pattern="^rio/[a-z][a-z0-9-]*(@[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?)?$"
council.members[].provider: string; pattern="^[a-z][a-z0-9-]*$"
council.members[].model: string; minLength=1
council.members[].family: string; pattern="^[a-z][a-z0-9-]*$"
council.members[].self_hosted: boolean
council.max_findings: integer; default=5; minimum=1
council.max_experiments: integer; default=2; minimum=0

## fields-3
council.max_rounds: integer; default=2; minimum=1; maximum=2
council.min_members: integer; default=3; minimum=1
council.timeout: string; default="90s"; pattern="^([0-9]+(\\.[0-9]+)?)(ms|s|m|h|d)$"
council.vendors_allowed: array; default=[]; uniqueItems=true
council.vendors_allowed[]: string

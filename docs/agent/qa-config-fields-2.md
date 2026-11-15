# QA environment fields 2

Schema reference for qa-config. Edit the corresponding YAML intentionally; validate with rio profile validate or rio qa validate. * means required; extra=false rejects unknown keys. Semantic constraints and prerequisites are in the related guide.

## fields-1
rules.ignore_console: array; minItems=0; uniqueItems=true
rules.ignore_console[]: string
evidence: object; extra=false
evidence.video: boolean
evidence.retention_days: integer; minimum=1
seed: object; extra=false
seed.manifest: string; pattern="^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\).+$"; minLength=1
seed.migrations: array; minItems=0; uniqueItems=true
seed.migrations[]: string
seed.max_size: value; oneOf=[{"type":"integer","minimum":1},{"type":"string","pattern":"^[1-9][0-9]* ?(B|KiB|MiB|GiB)$"}]

## fields-2
seed.fallback_rebuild: boolean
seed.cache_version: value; oneOf=[{"type":"string","minLength":1},{"type":"integer","minimum":0}]

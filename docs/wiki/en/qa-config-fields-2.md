# QA environment fields 2

Use these exact keys with the [profile guide](profiles.md) or [QA guide](qa.md). See [Modules](modules.md) for complete schema tables and semantic rules. `*` marks required fields. Commands and keys are intentionally untranslated.

```text
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
seed.fallback_rebuild: boolean
seed.cache_version: value; oneOf=[{"type":"string","minLength":1},{"type":"integer","minimum":0}]
```

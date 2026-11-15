# Journey fields 1

Use these exact keys with the [profile guide](profiles.md) or [QA guide](qa.md). See [Modules](modules.md) for complete schema tables and semantic rules. `*` marks required fields. Commands and keys are intentionally untranslated.

```text
version: value *; const=1
name: string *; pattern="^[a-z][a-z0-9-]*$"
title: string *; minLength=1
persona: string *; pattern="^[a-z][a-z0-9-]*$"
tags: array *; minItems=0; uniqueItems=true
tags[]: string
covers: object *; extra=false; anyOf=[{"required":["paths"],"properties":{"paths":{"minItems":1}}},{"required":["routes"],"properties":{"routes":{"minItems":1}}}]
covers.paths: array; minItems=0; uniqueItems=true
covers.paths[]: string
covers.routes: array; minItems=0; uniqueItems=true
covers.routes[]: string
preconditions: array *; minItems=0
preconditions[]: string
steps: array *; minItems=1
steps[].do: string *; minLength=1
steps[].at: string; minLength=1
steps[].hint: string; minLength=1
steps[].expect: string; minLength=1
success: array *; minItems=1
success[]: string
after: array; minItems=1; uniqueItems=true
after[]: string
resets: boolean
viewports: array; minItems=1; uniqueItems=true
viewports[]: string
desktop_only: boolean
reason: string; minLength=1
context: object; extra=false
context.time: string; format="date-time"
context.timezone: string; minLength=1
context.locale: string; minLength=1
context.geolocation: object; extra=false
context.geolocation.latitude: number *; minimum=-90; maximum=90
context.geolocation.longitude: number *; minimum=-180; maximum=180
context.geolocation.accuracy: number; minimum=0
context.network: enum; enum=["online","slow-3g","offline"]
sync_reason: string; minLength=1
goal: string; minLength=1
guidance_refs: array; minItems=0
guidance_refs[].path: string *; pattern="^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\).+$"; minLength=1
guidance_refs[].hash: string *; pattern="^[a-f0-9]{64}$"
guidance_refs[].start_line: integer *; minimum=1
guidance_refs[].end_line: integer *; minimum=1
ux_criteria: array; minItems=0; uniqueItems=true
ux_criteria[]: string
```

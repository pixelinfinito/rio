# Seed fields 1

Schema reference for qa-seed. Edit the corresponding YAML intentionally; validate with rio profile validate or rio qa validate. * means required; extra=false rejects unknown keys. Semantic constraints and prerequisites are in the related guide.

## fields-1
version: value *; const=1
datastores: array *; minItems=0
datastores[].name: string *; pattern="^[a-z][a-z0-9-]*$"
datastores[].kind: enum *; enum=["sqlite","postgres","mysql","redis","files","custom"]
datastores[].connection_env: string; pattern="^[A-Za-z_][A-Za-z0-9_]*$"
datastores[].start: string; minLength=1
datastores[].ready: string; minLength=1
datastores[].capture: string; minLength=1
datastores[].restore: string; minLength=1
steps: array *; minItems=0

## fields-2
steps[].command: string; minLength=1
steps[].file: string; pattern="^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\).+$"; minLength=1
steps[].applies_to: array *; minItems=1; uniqueItems=true
steps[].applies_to[]: string
users: array *; minItems=0
users[].persona: string *; pattern="^[a-z][a-z0-9-]*$"
users[].apply: string *; minLength=1
paths: array *; minItems=0; uniqueItems=true
paths[]: string

# Campos de dados iniciais 1

Use estas chaves exatas com o [guia de perfis](profiles.md) ou [guia QA](qa.md). Veja [Módulos](modules.md) para tabelas completas e regras semânticas. `*` marca campos obrigatórios. Comandos e chaves preservam a grafia original.

```text
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
steps[].command: string; minLength=1
steps[].file: string; pattern="^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\).+$"; minLength=1
steps[].applies_to: array *; minItems=1; uniqueItems=true
steps[].applies_to[]: string
users: array *; minItems=0
users[].persona: string *; pattern="^[a-z][a-z0-9-]*$"
users[].apply: string *; minLength=1
paths: array *; minItems=0; uniqueItems=true
paths[]: string
```

# Campos do ambiente QA 1

Use estas chaves exatas com o [guia de perfis](profiles.md) ou [guia QA](qa.md). Veja [Módulos](modules.md) para tabelas completas e regras semânticas. `*` marca campos obrigatórios. Comandos e chaves preservam a grafia original.

```text
version: value *; const=1
app: object *; extra=false
app.packaging: enum *; enum=["image","static","vendored"]
app.dockerfile: string; pattern="^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\).+$"; minLength=1
app.directory: string; pattern="^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\).+$"; minLength=1
app.start: string; minLength=1
app.url: string *; pattern="^https?://[^ ]+$"
app.ready: object *; extra=false
app.ready.path: string *; minLength=1
app.ready.status: integer *; minimum=100; maximum=599
app.ready.timeout: value; oneOf=[{"type":"integer","minimum":1},{"type":"string","pattern":"^[1-9][0-9]*(ms|s|m|h)$"}]
app.env: object
app.seed: string; minLength=1
app.workdir: string; pattern="^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\).+$"; minLength=1
app.routes_from: value; oneOf=[{"type":"object","properties":{"convention":{"enum":["next-app","next-pages","sveltekit","remix","nuxt","astro","none"]}},"required":["convention"],"additionalProperties":false},{"type":"object","properties":{"map":{"type":"array","items":{"type":"object","properties":{"glob":{"type":"string","minLength":1},"route":{"type":"string","minLength":1}},"required":["glob","route"],"additionalProperties":false},"minItems":1}},"required":["map"],"additionalProperties":false}]
personas: array *; minItems=1
personas[].name: string *; pattern="^[a-z][a-z0-9-]*$"
personas[].description: string *; minLength=1
personas[].username_env: string; pattern="^[A-Za-z_][A-Za-z0-9_]*$"
personas[].password_env: string; pattern="^[A-Za-z_][A-Za-z0-9_]*$"
browser: object; extra=false
browser.viewports: array; minItems=1; uniqueItems=true
browser.color_schemes: array; minItems=1; uniqueItems=true
browser.color_schemes[]: enum=["light","dark"]
harness: object; extra=false
harness.default: enum; enum=["codex","pi"]
harness.model: string; minLength=1
harness.auth: enum; enum=["auto","subscription","gateway"]
rules: object; extra=false
rules.disable: array; minItems=0; uniqueItems=true
rules.disable[]: string
rules.adopt: array; minItems=0; uniqueItems=true
rules.adopt[]: string
rules.add: array; minItems=0
rules.add[].id: string *; pattern="^project/[a-z][a-z0-9-]*$"
rules.add[].category: enum *; enum=["functional","ux","style","accessibility"]
rules.add[].severity: enum *; enum=["error","warning","info"]
rules.add[].description: string *; minLength=1
```

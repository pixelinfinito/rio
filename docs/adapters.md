# Adapter contract

Adapters connect repository detection and syntax to deterministic tool output. Rio embeds TypeScript/JavaScript and Python adapters; third-party module loading is rejected in v0.1. To add a language, extend the embedded adapter registry, detection/root scheduling, syntax tables, tool invocation and parsers, then add recorded-output and real-tool fixtures before enabling it in a profile.

An adapter supplies file matching, project roots, source parsing, enclosing symbols, identifiers/imports, executable-line decisions and the capabilities `parse`, `typecheck`, `lint`, `test`, `coverage`, `scan`. Native tools run through `ProcessSupervisor`, which applies working-directory isolation, deadlines, output bounds and process-tree cleanup. Every tool executes in a disposable source tree. Shared cached trees remain pure; ignored dependency installations are linked into each tool tree from the current worktree. Tests may execute arbitrary project code.

## Module manifest v1

The authoritative schema is [`schemas/module-v1.json`](../schemas/module-v1.json). A minimal built-in adapter declaration looks like this (the example is validated by the test suite):

```yaml
kind: adapter
name: rio/adapter-example
version: 0.1.0
description: Example static adapter
languages: [example]
files: ['*.example']
capabilities: [typecheck]
schema:
  type: object
  additionalProperties: false
tools:
  typecheck:
    - name: example-check
      command: [example-check, '--json', '{root}']
      network: []
      exit_codes:
        clean: [0]
        diagnostics: [1]
        failed:
          '2': tool_config_error
```

`command` contains argument-vector elements, not a shell string. `{root}`, `{files}` and `{output}` describe invocation substitutions. Each tool declares expected clean, diagnostic and failed exit codes. Unspecified nonzero exits are crashes; an exit code alone is never proof of findings. Output must parse successfully under the tool's supported format. A diagnostic exit with no valid diagnostics is `failed/unparseable_output`. An unknown tool version is recorded with a hint and does not suppress valid diagnostics.

## Built-in tools

| Language | Capability | Invocation and contract |
| --- | --- | --- |
| TypeScript/JavaScript | Typecheck | `tsc --noEmit --pretty false -p <root>`; 0 clean; 1/2 diagnostics |
| TypeScript/JavaScript | Lint | ESLint JSON over changed files; 0 clean; 1 diagnostics; 2 configuration failure. With `biome.json`/`biome.jsonc` and no ESLint config, `biome lint --reporter=json --max-diagnostics=none <files>`; 0 clean/warnings; 1 diagnostics |
| TypeScript/JavaScript | Coverage | Vitest or Jest with LCOV output; failed tests retain usable coverage |
| Python | Typecheck | Pyright JSON when configured/available, otherwise mypy without pretty output and with error codes; 0 clean; 1 diagnostics; mypy 2 is configuration failure |
| Python | Lint | Ruff JSON over changed files; 0 clean; 1 diagnostics; 2 configuration failure |
| Python | Coverage | `coverage run -m pytest`, then JSON export; pytest 5 is `no_tests`, failed tests retain usable coverage |

Mypy preserves explicit `files`, `packages` and `modules` from its project configuration, including INI `files` and `exclude` rules. Otherwise Rio targets build-backend packages (setuptools, Hatch, Poetry or Flit), then a package matching `project.name`, then top-level Python packages excluding tests, docs, examples, scripts, benchmarks and build directories. Only projects with no inferred package fall back to `.`. Pyright retains its native `include`/`exclude` selection.

Tools resolve from project and ancestor installations (`node_modules/.bin`, `.venv`/`venv`), then `VIRTUAL_ENV` for Python, then PATH. Runtime resolution never downloads tools. Version probes also use disposable directories and supervision. Missing tools become skips with install hints. Project configuration is read from the selected immutable source, including governing workspace lockfiles; an absent supported configuration becomes `no_project_config`.

Diagnostic parsers normalize temporary absolute paths and workspace links back to repository paths. Each finding identifies its rule, tool/version, normalized message, source symbol and locations. Identity is computed before redaction. Baseline typecheck/lint findings are mapped through the diff at occurrence level; extra identical occurrences yield a grouped `worsened` finding. Failed or incompatible baselines retain `unclassified` diagnostics only within changed hunks and three lines of context; other occurrences become pre-existing, with evidence naming the fallback. The footer explains why the baseline is unavailable. Trusted dependencies permit baseline classification in the same installed environment unless the base has a known mismatch.

## Coverage and syntax

Tree-sitter grammars and embedded queries produce symbols, imports, identifiers and executable-line tables. Comments, strings and imports do not become reference edges; type-only TypeScript declarations, Python annotations and stubs do not become uncovered executable lines. Syntax does not imply language-server resolution; graph edges retain `resolved`, `probable` or `unresolved` confidence.

Coverage settings come from static Vitest/Jest configuration or coverage.py configuration. Rio does not execute JavaScript configuration to inspect it. Computed instrumentation settings yield `coverage_not_instrumented`. Coverage exclusions are shown explicitly. Usable line data from all scheduled roots is merged by repository path before diff coverage is computed, so consumer tests may cover shared workspace code. Failed test runs can contribute partial data while the check remains failed. When a runner exits nonzero without usable coverage, its check hint includes the first nonempty stderr line (redacted); retention is claimed only when executable-line data actually exists.

Before running Vitest coverage, Rio checks the execution root and its ancestor `node_modules` directories for installed `@vitest/coverage-v8` and `@vitest/coverage-istanbul` package metadata (including workspace symlinks). Vitest before 0.32 uses `coverage-c8` in place of `coverage-v8`. When exactly one provider is available, Rio passes `--coverage.provider=<provider>` to override an unavailable configured/default provider. When both are available, the project's selection remains in effect. When neither is available, coverage is skipped as `tool_missing` with a `coverage_unavailable` note. Manifest declarations and unlinked pnpm store packages do not establish availability. Existing version-specific coverage and worker flags remain in effect, including omission of `--coverage.all` for Vitest 4+.

Static `test.browser: true` or `test.browser.enabled: true` configuration skips Vitest coverage as `not_supported_by_adapter` with a `coverage_unavailable: browser mode` note. Rio does not evaluate computed configuration, imported settings or browser launches inside test code; those runs may still fail and retain their normal error details.

Only changed lines explicitly listed as executable by a coverage report can produce `coverage/untested_change`: LCOV `DA` entries or coverage.py's executed/missing line arrays. A missing line is not an uncovered line, and a missing file is reported as `coverage_not_instrumented` (or `coverage_excluded` when configured); syntax never invents zero-hit counters.

For TypeScript, Rio compares each changed hunk in the immutable base and head after removing parsed type annotations, type arguments/parameters, interfaces, aliases, ambient declarations and type-only imports/exports. Identical remaining runtime text establishes a type-only change even when instrumentation maps a synthetic counter to the line (including zero hits in both versions). This syntactic proof does not require running baseline tests or assuming coverage hit counts imply equivalent behavior. Parse errors prevent this exemption; object properties, comparison operators, runtime imports, enums and string contents remain runtime text. Internal whitespace and comments are preserved so newline changes affecting automatic semicolon insertion cannot qualify.

## Dependencies and secrets

npm, pnpm, yarn classic/node-modules and Python uv/Poetry/exact requirements lockfiles feed the effective dependency graph. Installation metadata, location/version resolution, platform markers, omitted groups and in-repository links control compatibility. This graph is shared by planner, baseline identity and changed-version OSV auditing. A known mismatch is never bypassed by trust.

pnpm virtual-store path verification accepts positive integer or quoted-string `virtualStoreDirMaxLength` values. The installed `node_modules/.modules.yaml` value takes precedence, followed by the installation root's `.npmrc` (`virtual-store-dir-max-length` or `virtualStoreDirMaxLength`), then `pnpm-workspace.yaml`, then the 120-character default. Configuration files used for this fallback are included in installation fingerprints.

Secret scanning uses [`modules/adapters/common/secrets.toml`](../modules/adapters/common/secrets.toml) and high-entropy assignments. Renderers and retained tool streams share that catalog's redactor. Source snapshots retain source verbatim. Raw retained streams are capped at 16MiB per stream, preserving head and tail after redaction; parser input is bounded separately by `run.output_limit`.

## Secret value shapes

The complete catalog is audited below. Provider-specific formats can be recognized anywhere; only the generic entropy rule infers credentials from assignments. A sensitive-looking identifier or type name is never enough.

| Rule (`secret/…`) | Required value shape |
| --- | --- |
| `aws-access-key` | `AKIA` or `ASIA` followed by exactly 16 uppercase letters/digits, with word boundaries |
| `github-token` | `gh[pousr]_` plus at least 36 alphanumeric characters, or `github_pat_` plus at least 22 alphanumeric/underscore characters |
| `gitlab-token` | `glpat-` plus at least 20 letters/digits/underscores/hyphens |
| `slack-token` | `xox[baprs]-` plus at least 10 letters/digits/hyphens |
| `stripe-key` | `sk_live_` plus at least 24 alphanumeric characters |
| `private-key` | A complete PEM private-key block (generic, RSA, EC, OPENSSH or DSA), including matching begin/end marker shapes |
| `connection-string` | A postgres/postgresql, mysql, mongodb/mongodb+srv or redis URL containing both username and password before `@` |
| `high-entropy` | A secret/token/password/passwd/API-key/private-key assignment with a complete single- or double-quoted string value, at least 20 bytes and Shannon entropy at least 3.5 bits/byte |

Entropy scanning accepts quoted values in assignments, keyword arguments, dictionary entries and object properties. It rejects identifiers, attribute access, calls, annotations (including `ContextVar[...]`), concatenations and other expressions. Bare values are accepted only as complete configuration entries in `.env`, `.env.*`, `*.env`, `*.ini`, `*.cfg`, `*.conf`, `*.yaml`, `*.yml` and `*.properties` files; optional `export` or YAML list prefixes and trailing comments are supported. Streams without a filename use the quoted-value rule. Provider formats remain detectable in either context.

Placeholder values are suppressed entirely for `high-entropy` and `connection-string`. The case-insensitive exact value list is `user`, `username`, `password`, `pass`, `pwd`, `secret`, `test`, `example`, `changeme`, `dummy`, `placeholder`, three or more `x` characters, and three or more `*` characters. A complete nonempty `<…>`, `${…}` or `{{…}}` wrapper is also a placeholder (no nested brackets/braces or line breaks). Prefixes, suffixes and substring matches do not qualify.

A connection URL is suppressed only when **both** username and password are placeholders and the exact host is `localhost`, `127.0.0.1`, `[::1]`, `example.com`, `example.org`, `example.net`, `db`, `postgres`, `mysql`, `mongodb` or `redis`; an optional port is allowed. Real-looking credentials on these hosts still fire, as do placeholder credentials on other hosts. Provider-specific tokens and PEM keys are never allow-listed. Test/fixture paths alone neither suppress nor reduce severity: real credentials in tests still require attention.

## Verification

Add offline recorded-output cases for every supported tool/version and snapshots for syntax/executability. Real-tool tests should confirm cwd isolation, dependency linking, baseline classification, failed-test coverage and process cleanup. Tests call the common `require_tool` helper: a missing tool prints its reason, and `RIO_REQUIRE_TOOLS=1` turns that skip into a failure. No fixture should require credentials or a live OSV service; OSV protocol tests use a local mock server.

Biome 1.x and 2.x JSON diagnostics use byte spans and embedded source text; Rio converts them to repository locations and rules such as `lint/biome/correctness/noUnusedVariables`. Warnings remain findings even when Biome exits 0. Biome uses the same changed-file targeting, disposable trees and baseline classification as ESLint. When both configurations exist, ESLint takes precedence.

If Biome exits 1 with no findings and reports `No files were processed` (on stderr or as the sole JSON diagnostic), Rio records a `disabled` skip with a note explaining that project configuration may ignore the targets. Malformed JSON, other diagnostics, configuration errors and incomplete process cleanup still use the normal failure handling.

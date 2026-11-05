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
| TypeScript/JavaScript | Lint | ESLint JSON over changed files; 0 clean; 1 diagnostics; 2 configuration failure |
| TypeScript/JavaScript | Coverage | Vitest or Jest with LCOV output; failed tests retain usable coverage |
| Python | Typecheck | Pyright JSON when configured/available, otherwise mypy without pretty output and with error codes; 0 clean; 1 diagnostics; mypy 2 is configuration failure |
| Python | Lint | Ruff JSON over changed files; 0 clean; 1 diagnostics; 2 configuration failure |
| Python | Coverage | `coverage run -m pytest`, then JSON export; pytest 5 is `no_tests`, failed tests retain usable coverage |

Mypy preserves explicit `files`, `packages` and `modules` from its project configuration, including INI `files` and `exclude` rules. Otherwise Rio targets build-backend packages (setuptools, Hatch, Poetry or Flit), then a package matching `project.name`, then top-level Python packages excluding tests, docs, examples, scripts, benchmarks and build directories. Only projects with no inferred package fall back to `.`. Pyright retains its native `include`/`exclude` selection.

Tools resolve from project and ancestor installations (`node_modules/.bin`, `.venv`/`venv`), then `VIRTUAL_ENV` for Python, then PATH. Runtime resolution never downloads tools. Version probes also use disposable directories and supervision. Missing tools become skips with install hints. Project configuration is read from the selected immutable source, including governing workspace lockfiles; an absent supported configuration becomes `no_project_config`.

Diagnostic parsers normalize temporary absolute paths and workspace links back to repository paths. Each finding identifies its rule, tool/version, normalized message, source symbol and locations. Identity is computed before redaction. Baseline typecheck/lint findings are mapped through the diff at occurrence level; extra identical occurrences yield a grouped `worsened` finding. Failed or incompatible baselines retain `unclassified` diagnostics only within changed hunks and three lines of context; other occurrences become pre-existing, with evidence naming the fallback. The footer explains why the baseline is unavailable. Trusted dependencies permit baseline classification in the same installed environment unless the base has a known mismatch.

## Coverage and syntax

Tree-sitter grammars and embedded queries produce symbols, imports, identifiers and executable-line tables. Comments, strings and imports do not become reference edges; type-only TypeScript declarations, Python annotations and stubs do not become uncovered executable lines. Syntax does not imply language-server resolution; graph edges retain `resolved`, `probable` or `unresolved` confidence.

Coverage settings come from static Vitest/Jest configuration or coverage.py configuration. Rio does not execute JavaScript configuration to inspect it. Computed instrumentation settings yield `coverage_not_instrumented`. Coverage exclusions are shown explicitly. Usable line data from all scheduled roots is merged by repository path before diff coverage is computed, so consumer tests may cover shared workspace code. Failed test runs can contribute partial data while the check remains failed.

## Dependencies and secrets

npm, pnpm, yarn classic/node-modules and Python uv/Poetry/exact requirements lockfiles feed the effective dependency graph. Installation metadata, location/version resolution, platform markers, omitted groups and in-repository links control compatibility. This graph is shared by planner, baseline identity and changed-version OSV auditing. A known mismatch is never bypassed by trust.

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

## Verification

Add offline recorded-output cases for every supported tool/version and snapshots for syntax/executability. Real-tool tests should confirm cwd isolation, dependency linking, baseline classification, failed-test coverage and process cleanup. Tests call the common `require_tool` helper: a missing tool prints its reason, and `RIO_REQUIRE_TOOLS=1` turns that skip into a failure. No fixture should require credentials or a live OSV service; OSV protocol tests use a local mock server.

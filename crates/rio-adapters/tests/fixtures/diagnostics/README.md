The `*.stdout` and `*.stderr` files were captured by running installed tools
against disposable copies of `tests/fixtures/ts-sample` and `py-sample`:

- TypeScript 5.7.3: `tsc --noEmit --pretty false -p .` (exit 2).
- ESLint 9.18.0: `eslint -f json src/lint.ts` (exit 1).
- mypy 1.14.1: `mypy --output json` (exit 1).
- Ruff 0.9.3: `ruff check --output-format json src/sample/lint.py` (exit 1).

Absolute disposable paths are normalized to `/recorded/repo`. Pyright JSON,
older mypy line output and malformed output are representative inline parser
examples in `tests/diagnostics.rs`.

- Biome 1.9.4 and 2.0.0: `biome lint --reporter=json sample.ts`, with `correctness.noUnusedVariables` enabled at warning severity. Paths and durations normalized; warning exit 0 retained.
- `tsc-trace-global.stdout`: reduced traceResolution and file-less TS6504 formats from `eval/runs/zod-6085-evidence/` plus a location diagnostic to verify traces do not suppress findings.

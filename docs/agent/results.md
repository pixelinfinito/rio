# Read review results

Read the report's status, checks and evidence, not only its finding count. Report/cache files can contain source; handle them like repository data.

## evidence
Findings have category, severity, evidence_level, state, location and identity. Categories distinguish defects/security/risks; evidence distinguishes plausible from static_proven/reproduced. Pre-existing findings differ from new/worsened. Default fail_on targets new/worsened defects at static_proven or stronger, not every suggestion. A failed check, a skipped tool and a passing check are different outcomes. Zero findings with incomplete checks is not a clean result.

## output
`rio review --format json > report.json` emits one rio-report-v1 document; progress goes to stderr. Status: complete, incomplete, partial, no_changes, error. After parsing, config/repository errors also emit JSON; parser errors and second interrupt do not. `--format md > report.md` produces Markdown; exits 2/3 emit no Markdown document. `--format sarif > rio.sarif` emits SARIF 2.1.0, including invocation errors on exits 2/3. `--format terminal` streams without TUI.
Review ID identifies snapshot/profile inputs; run ID identifies an execution. Artifacts live under `<cache>/<review-id>/runs/<run-id>/`; latest identifies the most recently finished run.

## policy
0 no policy failure (optional skips possible); 1 matching finding; 2 usage/configuration; 3 repository/internal/persistence error; 4 incomplete/cancelled/required check per policy; 130 second interrupt. PR publication can add exit 5 after an otherwise passing review. A failing finding takes precedence over incomplete exit 4. `fail_on.incomplete: false` changes incomplete handling; `fail_on.required_checks: [typecheck, lint]` makes missing required checks fail. Doctor and QA sync have separate meanings.

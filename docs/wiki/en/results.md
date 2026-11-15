# Understand findings and reports

## Outcome

Separate proven problems, hypotheses and incomplete work, and export a report that another tool can consume.

## Prerequisites

A review result. Treat report/cache files like source code: they can contain snippets and sensitive project information.

## Steps

Read in this order: selected source/profile; overall status; each check's outcome; findings and evidence; policy/exit code. A finding's **severity** describes impact; **evidence level** describes support. `plausible` is a hypothesis, `static_proven` has static support, and `reproduced` has execution evidence. `refuted` means disproved. Categories and states further distinguish defects/security/risks and new/worsened/pre-existing/fixed/unclassified results.

```sh
rio review --format json > report.json
rio review --format md > report.md
rio review --format sarif > rio.sarif
```

Use `--show-pre-existing` to inspect baseline findings and `--show-remembered` for remembered dismissals. Neither is a substitute for changing the actual failure policy.

## Expected results

JSON emits one `rio-report-v1` document with status `complete`, `incomplete`, `partial`, `no_changes` or `error`; progress is stderr. Config/repository errors after parsing also produce JSON. Parser errors and second interrupt are exceptions. Markdown emits no report on exits 2/3. SARIF 2.1.0 includes an invocation error and no results for exits 2/3.

| Review exit | Meaning |
| --- | --- |
| 0 | No policy failure; optional checks may still be skipped |
| 1 | A finding matches general or security failure policy |
| 2 | Usage/configuration/profile error |
| 3 | Repository/internal/persistence failure |
| 4 | Incomplete/cancelled work or a required check under policy |
| 5 | PR publication failed after an otherwise passing review |
| 130 | Second interrupt; no final document |

A matching finding takes precedence over exit 4. The default general policy selects new/worsened defects at `static_proven` or stronger. Security has its own step policy. Review IDs identify inputs; unique run IDs identify attempts. Saved runs live under `<cache>/<review-id>/runs/<run-id>/`.

## Troubleshooting

Zero findings plus failed/skipped checks means incomplete information. Read each reason and run [doctor](doctor.md). `fail_on.incomplete: false` changes exit policy, not the completeness of the analysis. Require important tools with `fail_on.required_checks`.

## Next steps

[Change policy](profiles.md), [use reports in CI](ci.md), or [respond to findings](feedback.md).

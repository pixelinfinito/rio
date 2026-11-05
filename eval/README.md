# Reusable deterministic evaluation

Use [METHODOLOGY.md](METHODOLOGY.md) for verdict definitions, root-cause scoring,
baseline eligibility, sample sizes, and the go/no-go rule. Register controls with
[positive-controls.md](positive-controls.md). The scripts use Python 3's standard
library; no packages are required. Run commands from the repository root.

1. Capture a public PR with the [runner procedure](runner/README.md) and
   [runner.py](runner.py). Pin commits, binary, profile, dependencies, and tools.
2. Edit its `verdicts.json`: replace every `TODO`, supply independent evidence,
   scope misses, and register expected positive-control bugs. A clean result needs
   an explicit independent clean assessment. Skeletons are intentionally unscored.
3. Build a validated per-PR record, then aggregate and render a cohort:

```sh
python3 eval/evaluate.py record \
  --report eval/runs/CASE/report.json --verdicts eval/runs/CASE/verdicts.json \
  --out eval/runs/CASE/record.json
python3 eval/evaluate.py aggregate eval/runs/*/record.json \
  --out docs/evaluation/VERSION-summary.json
python3 eval/evaluate.py render eval/runs/*/record.json --version VERSION \
  --out docs/evaluation/VERSION.md
python3 eval/evaluate.py validate eval/runs/CASE/record.json
python3 -m unittest discover -s eval/tests -v
```

Keep raw reports and final records in durable versioned evidence storage before
publishing Markdown; links are relative to the output document. Gzipped JSON
reports are accepted. `render --narrative PATH.md` embeds a separately maintained
interpretation before the generated statistics. It recomputes the summary from
validated records rather than trusting a hand-edited aggregate. Rendering has one
row per distinct cause, occurrence counts, and links to raw records.

[Per-PR schema](schema/record-v1.json) and [summary schema](schema/summary-v1.json)
are JSON Schema 2020-12. Findings embed the exact fields in
[Rio's finding schema](../schemas/finding-v1.json) and `rio-core::Finding`, including
`state`, `location`, `locations`, `source`, and optional `advisory`; adjudications
are sibling fields, not invented Rio fields. Environment checks preserve outcome
metadata with nested finding copies removed (`findings: []`); top-level findings
and risks are adjudicated once. Runtime validation resolves local schema refs
offline and supports the validation keywords used in these schemas, rejecting
unknown keywords. It also checks dedupe consistency, control ID matches,
usefulness, and environment evidence. Arbitrary external schemas are not supported.

Verdicts format (one entry for **each** top-level finding/risk ID):

```json
{
  "repository": "OWNER/REPO",
  "pr": "https://github.com/OWNER/REPO/pull/123",
  "case_id": "123",
  "languages": ["typescript"],
  "reviewer": "independent reviewer identity",
  "verdict_source": "automated",
  "commands": [],
  "notes": [],
  "independently_clean": false,
  "positive_control": {
    "kind": "real-pr",
    "expected": [{
      "id": "introduced-type-error",
      "mechanism": "type-error",
      "evidence": "oracle command and pinned base/head results",
      "finding_ids": ["RIO_FINDING_ID"]
    }]
  },
  "findings": {
    "RIO_FINDING_ID": {
      "verdict": "true-positive",
      "reason": "independent evidence showing the introduced error"
    }
  },
  "misses": []
}
```

Use control `kind: none` and `expected: []` for negative/ordinary PRs, or
`kind: seeded-mutation` with a unique case ID for a mutation. Empty expected
`finding_ids` means missed; the record builder adds a deterministic miss when
one has not already been supplied for that expectation. Finding annotations can optionally specify
`message_template`, `file_set`, and explanatory `family`; document any merges in
`reason`. Default normalization only collapses whitespace and ignores line/symbol
positions. Conflicting verdicts within a key, missing or extra finding verdicts,
and duplicate cases are errors. Same-cause repetitions within a PR do not weight
precision. The aggregate reports per-PR cause totals and globally unique
`(repository, key)` counts separately. Language breakdowns overlap for mixed PRs.

Miss entries require `id`, `scope_class` (`deterministic` or `agent-layer`),
`description`, and `evidence`. Deterministic misses also need `mechanism`, one of
`type-error`, `lint-rule`, `uncovered-lines`, `leaked-secret`, or
`vulnerable-dependency`; in a control they also need `expectation_id` matching an
undetected expectation. Semantic misses go to the agent-layer backlog.

The original [v0.1 record](../docs/evaluation/v0.1.md) is preserved. The
[v0.1 rescoring](../docs/evaluation/v0.1-rescored.md) applies this protocol without
claiming that historical environment failures are eligible measurements. Rebuild
it with `python3 eval/rescore_v01.py`. The old
`scripts/aggregate-evaluation.py` remains a historical formatter using the old
rubric; use `eval/evaluate.py` for new cohorts.

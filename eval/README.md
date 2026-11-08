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

[Per-PR schema](schema/record-v2.json) and [summary schema](schema/summary-v2.json)
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
and duplicate cases are errors by default. Same-cause repetitions within a PR do not weight
precision. Aggregate and render accept `--select latest`, `--select eligible-only`, or
`--select PATH.json`. Latest uses Rio's time-ordered run ID (path breaks ties),
including failed attempts. Eligible-only drops excluded attempts and requires a
single eligible attempt per case. A manifest is a JSON array of record paths
relative to the manifest, selecting exactly the runs you intend to publish; it
may select a subset. Real PR URLs identify duplicate cases even when an attempt
has a different case ID; seeded mutations use their declared case IDs. Errors
list conflicting paths. The summary preserves selected and omitted paths.

Profiles may differ within a cohort. V2 records capture binary and resolved
profile SHA-256 from the report's sibling `commands.json`; absent hashes stay
`null` and the summary marks incomplete binary identity. Different version/hash
identities require `--allow-mixed-versions` on aggregate/render and are prominently
labelled mixed. This compares every selected record, including exclusions.
Both metric views and real/seeded recall are rendered. Original v1 records remain
valid historical artifacts; aggregate/render rescore their raw finding/check
copies under v2 without overwriting them. Rebuild with `record` from the raw
report and verdicts to persist a v2 record.

The aggregate reports per-PR cause totals and globally unique
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


The [v0.1 rerun worked example](../docs/evaluation/v0.1-rerun.md) includes both
metric views, a canonical selection manifest, blocked monorepos, and a comparison
with the historical hand summary. Rebuild its records and run aggregate/render
with the generated narrative using `python3 eval/rerun_v01.py`.

## v0.2 verifier comparison (pinned acceptance)

`python3 -I eval/verifier.py MANIFEST.json --out COMPARISON.json [--markdown SUMMARY.md]`
compares single-verifier and quorum reports on identical pinned base/head snapshots.
The manifest ([schema](schema/verifier-manifest-v1.json)) uses schema
`rio-verifier-eval-v1`, `execution: live-model` (or `recorded` for harness tests)
and nonempty `cases`. Each case pins `id`, `generator_model`, `voter_model`,
`profile_hash`, `high_controls` (known high-severity control IDs, empty for clean
controls), `independently_clean`, and `single`/`quorum` arms. Each arm names
`report`, `audit`, `verdicts` paths relative to the manifest plus their
`report_sha256`, `audit_sha256`, `verdicts_sha256` pins.

Verdicts contain an independent `reviewer` and per-finding entries with `verdict`
(true-positive/false-positive), artifact-backed `evidence`, and optional
`control_id` naming the high-severity control a true positive detects. The report
holds the actual finding contracts and the audit comes from the authenticated
endpoint (`votes`, `usage`). The comparison ([schema](schema/verifier-comparison-v1.json))
records, per case and per arm, verdict counts, blind-match buckets, precision by
evidence level, verification tokens and cost, and detected controls, plus arm
totals and high-severity recall.

Acceptance (`accepted: true`) requires every gate: a reference set with known
high-severity issues and independently clean controls; quorum precision >= 0.80;
no high-severity control detected by the single-verifier baseline but missed by
the quorum; complete data (every case scored, verification cost known); and
`execution: live-model`. A case is scorable when its review finished: status
`complete`, or `incomplete` only because deterministic checks were skipped for a
missing tool or no network (`tool_missing`, `offline`), which the hosted runner
does for every project; failed or cancelled checks, missing verifier votes and
partial reviews are not scorable (owner decision of 2026-11-08). A failing or unusable comparison is still written, with
the quorum false positives (`quorum_false_positives`), the lost controls
(`lost_high_controls`, as `case/control`) and unscorable cases (`errors`) named,
and the command exits 1. Recorded test fixtures never establish acceptance.

The live measurement is a separate, paid step that this harness does not run. It
needs: a deployed endpoint with the pinned `rio/openrouter` profile hash; a
reference set of real PRs with registered high-severity controls and
independently clean controls; for each case and arm (`verify.voters: 1` versus the
quorum profile) the `report.json`, the endpoint audit (`votes`, `usage` with
`cost_usd`) and independent verdicts; and a manifest pinning their SHA-256 values
with `execution: live-model`. Write the outcome with `--markdown
docs/evaluation/v0.2-verifier.md` and keep a failing comparison as evidence.

## Eval cases and incidents

Cases follow the internal [schemas/eval-case-v1.json](../schemas/eval-case-v1.json):
`label` (`incident | historical | mutation`), `input` (PR, base and head refs with
full SHAs, changed files), `expected` findings (locations with `path`, line range,
enclosing `symbol_path` and `symbol_line`; editable `trigger` and its source),
`counterfactual_catch` (`ci | human | none`, required for incidents) and
`provenance` (source, time, tool, and for incidents the fix PR and the file
overlap). Validate with `python3 -I eval/cases.py validate eval/cases`.

The `rio eval` subcommands run these scripts with `python3 -I`. They need
`python3` and this harness: run them inside the Rio source tree, or set
`RIO_EVAL_DIR` to this `eval/` directory; otherwise they exit 2.

`rio eval import-incident <pr> <fix-pr> [--caught-by ci|human|none]` runs
`python3 -I eval/incident.py <pr> <fix-pr> [--caught-by ...] [--repo PATH]
[--gh-repo OWNER/REPO] [--repository NAME] [--trigger TEXT] [--force]`. It fetches
both PRs through `gh pr view --json` and `gh pr diff` (file contents through local
`git show`, else `gh api`), refuses with an overlap report (exit 1) when the fix
changes no file the PR changed, and otherwise writes
`<repo>/eval/cases/incident-<pr>-<fix-pr>.json`. The expected location is the set of
symbols enclosing the fix hunks in overlapping files: from each hunk's first old
line, the nearest preceding `def`/`fn`/`function`/`class` line in the fix's base file,
falling back to a file-level location; lines are in the fix base's coordinates. The
trigger is the fix description's first paragraph (else its title) and is meant to
be edited. Without `--caught-by` the command asks on a terminal and fails (exit 2)
otherwise. Nothing leaves the repository; contributing a case to a shared set is a
separate step.

## Noise measurement

`rio eval noise ARGS` runs `python3 -I eval/noise.py run ARGS` (`--repo`, `--branch`,
`--rio`, `--profile`, `--limit`, `--since`, `--pr`, `--exclude N=REASON`,
`--window-days 90`, `--date`, `--out-root eval/runs/noise`, `--recorded DIR`). It
selects known-clean PRs from the local clone's default branch: GitHub merge commits
(`Merge pull request #N`) and squash commits (`... (#N)`), excluding any PR later
reverted (`This reverts commit` or `Revert "<title>"`), any PR whose changed line
ranges a later first-parent commit edits or inserts next to within 90 days (ranges
are carried through intervening commits), and PRs whose window has not elapsed.
`python3 -I eval/noise.py select` prints the selection without reviewing. Each
selected PR is reviewed with `rio review --base <base> --format json [--profile P]`
in a temporary worktree at the PR head; `eval/runs/noise/<date>/` then holds
`selection.json`, `run.json`, `<case>/report.json`, `<case>/adjudication.json` and
`summary.json`.

Adjudication ([schema](schema/noise-adjudication-v1.json)) starts with every
finding's `label`, `adjudicator` and `rationale` null. A human sets `label` to
`harmful` (acting on it would introduce a bug or remove intended behavior),
`neutral` or `useful` with the adjudicator and a rationale (the same definition is
`$defs/noise_adjudication` in the [record schema](schema/record-v2.json)); the
harness never infers labels. `python3 -I eval/noise.py validate RUN-DIR` lists
unadjudicated findings, and `summarize RUN-DIR` rewrites `summary.json`
([schema](schema/noise-summary-v1.json)): the harmful count is a lower bound and
unlabeled findings are counted as unadjudicated, never neutral.

Release check: `python3 -I eval/noise.py check --candidate RUN-DIR|summary.json
(--previous RUN-DIR|summary.json | --first-release)` fails (exit 1) when any finding
is unadjudicated, any PR failed to run, the provider profile differs from the
previous release's, or the harmful count exceeds the previous release's; failing
findings are named.

The noise measurement runs nightly on the maintainer's machine, never in public
CI: no endpoint URL, API token or provider key is stored in the repository or on
GitHub. `python3 -I eval/nightly.py run` calls `rio eval noise` with the pinned
`rio/openrouter` profile; Rio reads the endpoint and token already saved in
`~/.config/rio`. Configure it in `~/.config/rio/noise.json`, which holds no secrets:

```json
{"repo": "/path/to/reference/clone", "repository": "owner/name",
 "profile": "rio/openrouter", "limit": 10, "rio": "/path/to/rio"}
```

Each run is written privately (mode 0700) to `~/.local/share/rio/noise/<date>/`
with its log under `logs/`. Every run is scanned with `eval/credscan.py` for the
exact and base64 values of every saved credential (`secrets-*.json` and the client
`credentials` file) plus common token shapes; a match quarantines the run as
`<date>.quarantined-<time>` and exits 1 without printing the value. Runs older than
90 days (`retention_days`) are pruned. Schedule it with
`python3 -I eval/nightly.py install --enable` (a systemd user timer at 03:00, with
`loginctl enable-linger` so it fires while logged out) or
`install --print-cron` for a crontab line. The unit and the cron line record the
absolute path of the `eval/nightly.py` that ran `install`, so install from a stable
checkout (for example the main clone), not from a temporary worktree. Check the
schedule with `systemctl --user list-timers rio-noise.timer`. Adjudicate a run
directory and run the release check against the previous release's summary.

## Author responses, rounds to pass and the regression gate

`python3 -I eval/convergence.py summarize REPORT.json... [--repository NAME] --out
SUMMARY.json` aggregates lineage reports per repository
([schema](schema/convergence-summary-v1.json)): the author-response ratio
`fixed / (fixed + wrong + intentional + irrelevant + style)` over responded
findings (for example 6 fixed, 2 wrong, 1 intentional, 1 style gives 0.6), `wrong`
per agent and evidence level, `intentional` per agent, `irrelevant`/`style` per rule
and per category, and `rounds_to_pass` per lineage with its distribution. Each
finding identity counts once per lineage generation (its latest round). Responses
are never aggregated per user, and suppressions suggested from them still need
approval.

Every prompt, tool or model change is scored on incidents, historical PRs and
mutations together. `python3 -I eval/gate.py scorecard --summary EVAL-SUMMARY.json
--cases eval/cases --reports RUN-DIR --label NAME --out CARD.json` combines the
adjudicated harness summary (precision and positive-control recall from
`evaluate.py aggregate`) with case recall from `RUN-DIR/<case-id>/report.json`
([schema](schema/scorecard-v1.json)). `python3 -I eval/gate.py gate --baseline
BASE.json --candidate CARD.json` exits 1 when precision, recall or incident recall
falls, a measured metric or case report is missing, or a previously caught
incident is missed (named in the output); otherwise it exits 0.

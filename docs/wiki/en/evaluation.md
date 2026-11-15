# Evaluate Rio with labeled cases

## Outcome

Measure noise and prepare incident cases without confusing a passing test suite with demonstrated review quality.

## Prerequisites

Python 3 and Rio's `eval/` source directory. Run in the Rio checkout or set `RIO_EVAL_DIR` to that harness. The standalone binary does not bundle evaluation scripts. Live reviews/models may incur costs and write results; use dedicated cases/accounts.

## Steps

```sh
rio eval noise --help
rio eval import-incident PR_URL FIX_PR_URL --help
```

Replace URLs for actual imports and read the forwarded harness options first. Noise runs review known-clean PRs and produce adjudication skeletons/summary. Incident import pairs a change with the PR fixing its defect to form a labeled case. Preserve baseline classification, case identity, model route, timing and budget in records. Independently adjudicate rather than accepting every model claim.

## Expected results

Rio delegates to isolated Python scripts and propagates their exit status. Missing harness exits 2 with setup guidance; inability to start Python exits 3. Outputs belong to the harness's selected destinations. The [evaluation reference](../../../eval/README.md) explains datasets and interpretation.

## Troubleshooting

A binary installed outside the Rio source needs `RIO_EVAL_DIR`; a similarly named directory without `noise.py` and `incident.py` is not accepted. Missing baselines invalidate some quality conclusions. Current repository records do not establish stable release acceptance, and council live A/B remains a separate gate. Record skipped/unavailable live checks explicitly.

## Next steps

[Interpret report evidence](results.md) and [maintain documentation](maintenance.md) when behavior changes.

<!-- commands:start -->

## Command reference

### `rio eval`

| Argument | Meaning | Default / choices |
| --- | --- | --- |
| `--help` | Show command syntax and supported options. | `—` |
### `rio eval noise`

| Argument | Meaning | Default / choices |
| --- | --- | --- |
| `<args>` | Forward remaining arguments to the evaluation harness. | `—` |
| `--help` | Show command syntax and supported options. | `—` |
### `rio eval import-incident`

| Argument | Meaning | Default / choices |
| --- | --- | --- |
| `<pr>` | Pull request number for review, or incident PR URL in eval. | `—` |
| `<fix_pr>` | URL of the pull request that fixed the incident. | `—` |
| `<args>` | Forward remaining arguments to the evaluation harness. | `—` |
| `--help` | Show command syntax and supported options. | `—` |

<!-- commands:end -->

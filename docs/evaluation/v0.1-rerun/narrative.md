## Worked rerun and comparison with the hand summary

This is a reproducible v2 rescoring of the original raw reports, not a new Rio
execution. [The selection manifest](../../eval/runs/v0.1-rerun-selection.json)
chooses the NOTES files' final/scored attempts, one per case. It retains canonical
excluded cases to show the blocked repositories; earlier retries stay in the
attempt ledger under `eval/runs/`. Run `python3 eval/rerun_v01.py` from the repo
root to rebuild the v2 records, aggregate, narrative, and rendered document.
Original `record.json` files and NOTES remain historical v1 observations.

| Record-derived comparison | Historical v1 eligible | V2 verified only | V2 all eligible |
| --- | ---: | ---: | ---: |
| Eligible cases | 11 | 11 | 16 |
| Detected / expected controls | 5/5 | 5/5 | 6/7 |
| TP causes per PR | 5 | 5 | 6 |
| FP causes per PR | 4 | 1 | 1 |
| Useful cases | 6 | 10 | 14 |

The historical eligible view reproduces the control detections and FP cause count
in [the hand summary](v0.1-rerun-summary.md). Those historical FP totals are
distinct causes **within each PR**, with 3
unique repository/cause keys because the pydantic-settings connection-string
alert recurs in separate PRs. V2 re-derives visibility from the raw state:
3 formerly adjudicated FP findings are `pre-existing` and
become informational `pre-existing-hidden`. These are the mitmproxy dummy secret
and both pydantic-settings connection-string alerts. Their independent defect
reasons remain in the records, but Rio hides these diagnostics by default.
The remaining scored FP is Hono's generated Deno mirror coverage alert.
Unique eligible FP repository/cause keys now total
1. This is why precision and FP counts differ from the
hand summary rather than reproducing its visible-noise assumptions.

The v2 verified-only usefulness count increases for 4 cases:
mitmproxy/mitmproxy / 8473, pydantic/pydantic / 14213, pydantic/pydantic-settings / 1097, pydantic/pydantic-settings / 1109.
Pydantic #14213 has 11 hidden findings and is independently clean: its new
verdict is `useful`. The other newly useful cases have only hidden
false alerts. Raw reports and adjudicator reasons are unchanged.

All-eligible recall differs from the hand summary because trusted baselines now
admit 5 cases. ky #578 contributes
1 independently established browser-config
expectation, 0
detections and a deterministic miss; Rio's default tsc configuration passes both
sides. The structlog seed contributes a detected `new` type error. Real control
recall is 2/3; seeded recall is
4/4. These remain small, correlated samples.
The seeded cap and missing control-count/per-language requirements prevent a go.

### Trusted-mode observations

5 trusted cases have successful applicable base/head check pairs and
are now explicitly eligible: sindresorhus/ky / 578, sindresorhus/ky / 881, hynek/structlog / 805, hynek/structlog / 811, hynek/structlog / 811-seeded-assignment.
The structlog seed demonstrates classification of a nonempty diagnostic as `new`;
empty ky reports establish executed pairs, not successful detection of the browser
configuration bug. Trust is an environment choice, not verified dependencies.
The stricter metric view excludes these cases.

### Blocked monorepos and repository accounting

5 repositories retain linked-workspace baseline failures:
TanStack/query, colinhacks/zod, pydantic/pydantic-ai, trpc/trpc, vuejs/core. They receive no release metric credit. Independent oracles
may establish real defects in these excluded cases without establishing a working
Rio baseline. Setup also exposed lockfile/tool/configuration limitations documented
in the corresponding NOTES files. Fatal tRPC #7903 JSON lacks review metadata and
has no normalizable record; its raw attempts remain outside this aggregate.

The selected evidence spans 12 distinct
repositories, with 7
having eligible cases (5
verified-only). The repository total differs from the hand summary because Hono
and mitmproxy substitutes are counted alongside the failed original tRPC and
pydantic-ai assignments. Selected canonical cases are not the number of all
capture attempts.

The generated decision is **insufficient-evidence**, rather than the hand
summary's no-go: this rubric reserves no-go for an adequate sample. The measured
quality metrics also change with the visibility rule; the generated statistics
and decision reasons retain every computed gate.
Neither this rescoring nor the extra trusted observations establishes readiness.

## Rerun2: fresh execution on binary f6e4f87e4c65

This is a new Rio execution of the preregistered v0.1 cases, not a rescoring.
Every case keeps its PR, base/head commits, install plan, profile and seeded
mutation from the previous rerun; only the binary changed (`f6e4f87e4c65`,
the merge of the workspace-baseline, false-positive, tooling-compat and
evaluator-v2 fix branches). Twelve automated reviewers each owned one
repository; their dated "Rerun2" sections in `eval/runs/*-NOTES.md` carry the
evidence, every attempt directory is retained, and
[the selection manifest](../../eval/runs/v0.1-rerun2-selection.json) picks one
final attempt per case. tRPC #7903 is new to the cohort: it was prepared last
time but had no normalizable record.

| Record-derived comparison | Previous rerun, verified only | Rerun2, verified only | Rerun2, all eligible |
| --- | ---: | ---: | ---: |
| Eligible cases | 11 | 14 | 19 |
| Detected / expected controls | 5/5 | 6/6 | 7/8 |
| Distinct TP causes | 5 | 9 | 10 |
| Distinct FP causes | 1 | 0 | 0 |
| Precision by cause | 83 % | 100 % | 100 % |
| Useful cases | 10 | 14 | 18 |

What changed for the better:

- Hono's generated Deno-mirror coverage alert, the only scored false positive
  last time, is gone. No false positive remains anywhere in the cohort.
- The hidden pre-existing secret alerts (mitmproxy dummy secret, both
  pydantic-settings connection strings) no longer appear in raw output at all.
- Trusted-mode cases (ky, structlog) are now classified against a baseline and
  count as eligible; the structlog seed is still reported as `new`.
- TanStack/query leaf packages (#11392, seeded #11522) now baseline with
  verified dependencies; the old "points at changed source" guard is gone from
  every repository.
- pydantic-ai's graph root now remaps four editable packages into the base
  tree and runs lint and mypy baselines.

What is still blocked. Five monorepo cases remain ineligible for a new, more
specific reason: a linked workspace package is consumed through untracked build
output (`dist/`, `build/`, `index.cjs`) that Rio cannot materialize into the base
tree. This hits zod (#6085, #6527), vuejs/core (#12701, #15328), TanStack/query
#11293 and tRPC #5819. In those runs the head checks still execute and the real
controls are visible (zod Biome control, Vue TS2322, one of two tRPC SSE
errors), but there is no baseline, so Rio labels most diagnostics `pre-existing`
heuristically and hides them. pydantic-ai is still blocked by uv lock variant
rejection (`burner-redis`) on roots other than graph. ky #578 is the one real
control missed, as before: the bug only appears under a browser compiler
configuration that Rio's default tsc invocation does not use.

Defects observed this run, in priority order:

1. Build-output consumption of linked packages blocks baselines in four
   monorepos (new guard text: "consumed through build output ... that is not in
   the tree; run the build in the base or configure source entry points").
2. Without a baseline, Rio still emits `pre-existing` states from a heuristic;
   tRPC #5819 hides three independently proven introduced type errors this way.
3. pnpm `virtualStoreDirMaxLength` written as the string `"250"` is read as
   absent; TanStack/query needed directory aliases to verify dependencies.
4. Coverage runs in roots whose Vitest config selects the V8 provider when only
   Istanbul is installed (`Cannot find dependency '@vitest/coverage-v8'`),
   failing the check instead of skipping it (TanStack examples, tRPC #7903).
5. `rio doctor --all-roots --base` reports "no lockfile in the selected tree"
   for a base that has `uv.lock` and disables baselines that the real review
   then runs (litestar); `doctor --base` without `--all-roots` is correct.
6. Biome targets that the repository config ignores produce
   `unparseable_output` instead of a skip (zod treeshake directory).
7. Dependent Vue coverage selects browser tests and fails on missing Chrome.

Decision. The rubric still returns insufficient-evidence for the same three
reasons as before: fewer than ten eligible positive controls after the seeded
cap, seeded controls above half of control cases, and fewer than five controls
per language. Quality gates (precision, false positives per PR, usefulness)
now pass on every eligible case. Machine note: all twelve reviewers ran
concurrently on one host under heavy I/O pressure, so wall times in the NOTES
are observations, not measurements, and several first attempts timed out and
were retried with identical inputs.

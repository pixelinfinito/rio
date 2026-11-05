# ky evaluation — Rio b15dc8ff5001

Reviewer: sub-agent eval-ky (automated). Verdict source: automated.
Started 2026-11-05 UTC. This evaluation uses the prebuilt binary at
`/home/ubuntu/rio/target/release/rio`; it was not rebuilt. No changes to `crates/`
or existing `eval/*.py` are part of this evaluation.

## Selection and preregistration

The repository deliberately ignores `package-lock.json` and sets
`package-lock=false` in `.npmrc`. The public package-lock history query in
`ky-setup/lockfile-history.json` is empty. All ky executions use
`trust_installed_dependencies: true`, as explicitly requested. The evaluator's
verified-only eligibility policy remains intact: trusted runs are observations,
not eligible release-quality measurements.

- Positive candidate: https://github.com/sindresorhus/ky/pull/578, introducing head
  `ebfc6f4dad3764086ab4be39ec48f7b83058b7dd` against merge base
  `2d56baf6739a49655cbbe74b5083c0350511bbed`. Adds
  `NodeJS.ArrayBufferView` to exported request types, introducing a dependency on
  ambient Node types in browser applications. Issue #622 reports this; fix #623
  replaces it with the browser-global `ArrayBufferView`. We review #578, not #623.
  Expected mechanism: type-error. The independent oracle removes automatic Node
  ambient types with `compilerOptions.types: []`, retaining the repository's
  compiler options and entire `source` inclusion. This is a browser consumer
  configuration, not the repository's default config. Rio's default config may
  miss it; detection is not assumed. Oracle outputs must establish the bug before
  running Rio.
- Negative candidate: https://github.com/sindresorhus/ky/pull/881, maintainer
  Sindre Sorhus, merged 2026-08-28. Changes actual progress handling in
  `source/utils/body.ts`, public option documentation and Node/browser tests.
  Pinned SHAs and original API metadata are under `ky-881-oracle/`.

Candidates considered and rejected:

- #883: recent maintainer change with substantial timeout/stack handling and
  tests; #881 offers a more focused behavioral change for a negative control.
- #880: public introducing head changes mostly option documentation; the later
  squash includes the implementation. Its actual PR head is too insubstantial
  for the requested substantive-source negative control.
- #559 / fix #565: the exact-optional-properties regression is not exposed by
  #559's original compiler config (the fix enables that option). #578 offers a
  directly traceable exported-type regression with a dedicated issue and fix.
- #540 / follow-up c0a4dfa: imports a missing published dependency, but the
  development install can supply it transitively through Node typings; not
  selected over the clearer browser-ambient regression.
- #619 / fix #623: #619 changes JSON generics but blame shows the offending
  `NodeJS.ArrayBufferView` was introduced by #578. Reviewing #619 would attribute
  the regression to the wrong PR.
- #384: fixes compiler behavior after a TypeScript 4.4 upgrade, not evidence of
  a new error introduced by the preceding PR under a shared compiler version.
- Standalone de66c16 “Fix linting”: upgrades XO and TypeScript alongside broad
  cleanup, so it does not establish an introducing PR under unchanged rules.
- Coverage control: ky uses AVA, unsupported by Rio's Jest/Vitest coverage
  adapter. No uncovered-line expectation is registered without instrumentation.

## Setup and scope

Node 18.20.8 is pinned for #578 (upstream CI Node 18); Node 22.20.0 for #881
(upstream CI includes Node 22). Exact runtime archive hashes and official
SHASUMS are retained. Resolution-only temporary package edits pin #578's compiler
and Node typings to TypeScript 5.4.5 / @types/node 20.12.7, both within upstream
ranges. Original tracked manifests are restored before oracle/review runs.
External frozen npm lockfiles preserve the resolved installations; they are not
represented as upstream committed locks. The runner install plan attaches an
existing frozen npm installation by symlink after verifying original manifest
and hidden installed-lock SHA-256 hashes. Both sides of each PR have identical
manifests. This intentionally shares the same controlled tool versions; it does
not claim two independent dependency resolutions. No generated lock enters the
reviewed Git trees. `ky-setup/attach-dependencies.py` and the saved locks document
replay. Disposable clones and installations remain outside this worktree in
`/tmp/rio-ky-eval`; they are not committed.

The selected profile enables typecheck, baseline, secrets and offline dependency
audit. Lint and coverage are disabled explicitly: ky's XO package configuration
and AVA runner are unsupported by the respective Rio adapters. Independent XO
and test commands assess the upstream change. Offline dependency audit cannot
establish vulnerability safety, and this evaluation registers no audit control.

Setup and harness observations:

- `eval/evaluate.py:environment` defines `baseline_classification_ran` using
  `dependency_state == verified`, while Rio supports shared trusted baselines.
  The runner therefore exits 1 even if successful trusted head/base checks prove
  baseline execution. No harness files are changed; final records retain its
  conservative ineligibility and do not score trusted observations.
- A setup npm command was accidentally issued in the Rio worktree; it created
  an untracked empty package-lock. It was removed immediately. No tracked files
  changed. The log is retained as `ky-setup/incorrect-cwd-install.log`.

Additional setup problems, all retained:

- The #578 resolution-only npm install initially ran under machine Node 26.13.0 /
  npm 12.2.1 because the Node 18 archive was still extracting. Corrected before
  Rio by replaying the frozen lock with Node 18.20.8 / npm 10.8.2 `npm ci
  --ignore-scripts --package-lock=true --no-audit --no-fund --prefer-offline`.
  Repeated both compiler oracles after this reinstall; results are unchanged.
  Current Playwright 1.64.1 emits Node >=20 engine warnings in that historical
  dependency graph. This does not affect the pure TypeScript compiler control;
  no #578 browser/runtime execution is claimed.
- First #881 XO base/head runs shared `node_modules/.cache/xo-linter` and raced,
  causing 24 parsing errors in the base. Cleared the cache and ran lint
  sequentially. Repaired base full lint and the original valid head full lint
  each show the same single error in unchanged `test/http-error.ts:218`,
  `@typescript-eslint/no-meaningless-void-operator`, plus 10 warnings. No change
  is attributed to that error. Both changed-file lint commands exit 0.
- Initial #881 Node test runs had cold-start/exit timeouts and an unchanged
  hanging-hook failure with an unhandled rejection. Increasing AVA's timeout to
  2m yielded a successful head run; the first base retry still had the unchanged
  hanging-hook failure, and the next unchanged base run passed. Do not interpret
  these flaky observations as a PR regression or a Rio diagnostic. Every log is
  retained. Final results are base 557 / head 559 passed, each with 2 declared
  known failures. Focused stream tests pass base 17 / head 19.
- Concurrent invocations of the evaluation-local `oracle.py` initially replaced
  one another's base command ledger entries. Recovered the initial base Node
  test and clean-status entries from the tool's exact completion output (1 /
  162075 ms and 0 / 131 ms); retained that completion text separately. The helper
  now also writes command-specific metadata and merges the disk ledger. This is
  an evaluation setup error, not a Rio or upstream harness bug.

## Results and independent adjudication

All three raw reports have zero top-level findings and zero risks. Consequently
**every finding verdict class has raw and cause count 0**: true-positive,
false-positive, pre-existing-shown, environment-failure, out-of-scope. There are
no emitted finding IDs to list, and no false credential alerts or crashes were
observed. Overall record verdicts are `environment-failure` because the unchanged
methodology excludes this dependency state; that is distinct from a finding
being adjudicated environment-failure.

Positive #578 (`ky-578/record.json`, kind `real-pr`):

- Expected ID `ky-578-browser-node-namespace`, mechanism `type-error`,
  preregistered in `ky-578-oracle/positive-control-register.json` before Rio.
- Original default-config `tsc --noEmit --pretty false -p .` passes at both SHAs.
  Independent browser-only config extends it with `types: []` and
  `skipLibCheck: false`, retaining all source files. That oracle passes at base
  and fails at introducing head with exactly
  `source/types/request.ts(19,4): error TS2503: Cannot find namespace 'NodeJS'.`
- Reinstalled-tool confirmation gives the same results. Applying only the later
  #623 `NodeJS.ArrayBufferView` -> `ArrayBufferView` change to the introducing
  head makes the browser oracle pass; restored original source afterward.
- Rio's original default-config head/base typechecks both pass with dependency
  state `trusted`. No matching finding was emitted: expected finding IDs `[]`,
  **0 detected / 1 missed**, recorded as deterministic miss
  `miss/ky-578-browser-node-namespace`. This tests consumer configuration coverage;
  it does not assert that Rio failed to parse a diagnostic its chosen `tsc`
  invocation actually emitted. It does not enter eligible recall denominators.

Negative #881 (`ky-881/record.json`, kind `none`):

- Reviewed source diff and the matching tests; source flush logic now emits the
  empty final chunk exactly once and maintains transferred/total counts.
- Root and browser-only TypeScript, build and test-d checks pass at both SHAs;
  changed-file XO passes on both sides. Final non-browser suites and focused
  stream tests pass with the counts above, including both added empty-body tests.
- `ky-881-oracle/clean-assessment.json` is an explicit independent clean-change
  assessment, including pre-existing lint errors, retained flaky test attempts,
  and lack of local browser engines/coverage. Public head CI success supports
  the assessment but is not presented as locally executed browser tests.
- No expected bugs and no independently established change-specific misses.

`ky-881-attempt1/record.json` is the separately identified capability probe of
#881 with lint and coverage enabled. It is excluded and not an additional
independent PR sample. The final scoped run uses a new directory as requested.

## Baselines, exclusions, and observed defects/limitations

- Every run has successful executed head **and base** `typecheck .` entries,
  both `dependency_state: trusted`, and no `baseline_failed` note. Corresponding
  `baseline-observation.json` files retain the distinction between successful
  trusted check pairs and the verified-only harness flag. Zero findings mean
  that classification of a nonempty diagnostic set was not tested.
- All runner exits are 1; all schema-derived
  `baseline_classification_ran` values remain false, `baseline_ran` true, and
  `eligible` false. There are **zero eligible/scored PRs**. These are fully
  adjudicated schema-valid observational records, not a release score or proof
  of precision/recall. No harness flags or raw reports were rewritten.
- Harness defect/limitation (no finding ID): `eval/evaluate.py:environment`
  requires `verified` for each diagnostic pair and also counts a deliberately
  disabled lint head as an applicable root requiring a base. Reproduce with the
  pinned runner commands in `ky-578/commands.json` or `ky-881/commands.json`, then
  inspect the passing trusted typecheck entries and computed environment reasons.
  The trusted exclusion itself is methodology policy; conflating that exclusion
  and disabled checks with execution/classification failure is confusing metadata.
  Workaround: retain original ineligible records and separate check-pair evidence.
  A setup rerun cannot make these runs verified without changing the requested
  trust mode/upstream trees or the protected evaluator. Identical policy-only
  reruns would not repair that condition.
- Rio capability gap (no finding ID): #881 probe's lint check is skipped with
  `no_project_config`, despite ky's enabled XO package configuration. Coverage is
  skipped with `tool_missing`, hint “Install vitest or jest”, although AVA is
  installed. Reproduce using `trusted-capability-probe.yaml` and the #881 probe
  command ledger. Final profile explicitly disables the unsupported adapters;
  independent upstream commands cover the clean-change assessment. No lint or
  coverage detection is credited.
- Rio deterministic configuration coverage miss: #578 expected
  `ky-578-browser-node-namespace` above. There is no emitted finding ID; the
  explicit miss ID supplies the durable reference. Reproduction uses the pinned
  base/head, frozen compiler and `browser-tsconfig.json` in `ky-setup/`.
- Reports have status `incomplete`; `incomplete` lists offline dependency audit
  and disabled/unsupported checks. This status is preserved, not treated as a
  crash or a clean complete review. Offline audit is a declared capability
  limitation and no vulnerability safety claim is made. Deferred no-endpoint
  inference/agents are not scored as deterministic defects.

## Wall times and durable artifacts

Exact per-command durations, environments and exit codes are in runner
`commands.json` and oracle `base/head-commands.json`. Resolution logs report
rounded npm wall times: #881 16m, #578 initial resolution 14m, corrected #578
Node 18 frozen reinstall 4m. These installations overlapped; summing them is not
elapsed session time. Initial IO and extraction on this shared machine were slow.


- `ky-578`: runner 122.761s (2026-11-05T02:48:37.834778+00:00 to 2026-11-05T02:50:40.595807+00:00); Rio 77.993s. Typecheck head/base 13.591/7.484s.
- `ky-881-attempt1`: runner 156.342s (2026-11-05T02:48:13.677881+00:00 to 2026-11-05T02:50:50.020272+00:00); Rio 124.976s. Typecheck head/base 18.898/7.707s.
- `ky-881`: runner 44.818s (2026-11-05T02:51:18.955612+00:00 to 2026-11-05T02:52:03.773342+00:00); Rio 33.483s. Typecheck head/base 7.401/7.903s.

No report exceeds 5 MB, so report compression is unnecessary. Artifacts include
all attempts, original API metadata, pinned SHAs/diffs, official runtime hashes,
external frozen locks, resolved profiles, independent oracle outputs, complete
verdicts and records. No disposable clone, dependency tree, binary, or source
implementation change is committed. Records were generated by the existing
`eval/evaluate.py record` and checked with `eval/evaluate.py validate`.

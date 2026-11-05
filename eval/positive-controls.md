# Positive-control selection

Fill this register in evaluation threads **before** running Rio. Use the checked candidate register below to avoid repeating completed searches. Review the PR that **introduced** the problem:
its introducing head against its base, not the later fix. A correct maintainer
fix is usually a negative control, unless independent evidence shows it also
introduced an in-scope regression.

Good candidates include a type error fixed in a later PR, a violation of the
repository's enabled lint rules, instrumented new code without executed tests,
a committed credential, or a dependency bump to a known vulnerable resolved
version. A semantic bug is not a positive control for this layer just because a
later test reproduces it. Never use a live secret for a mutation; use an inert
recognized test credential and redact evidence.

Seeded controls must preserve a known-good base and commit exactly the mutation
as the reviewed head. Pin the patch, seed, parent PR, lockfiles, tool versions,
profile, expected mechanism, and independent oracle command/output. Show that
the oracle passes at base and catches the change at head. Confirm that Rio's
configured adapter supports the tool/rule. For coverage, confirm instrumentation
of the changed file; for offline dependency auditing, pin and populate the cache
and verify an executed audit. Never accept an offline skip as a detected control.

The minimum is 10 eligible controls: 5 per language across 3 repositories, within
a cohort covering at least 5 repositories and 10 eligible real PRs. Seeded cases
do not count as real PRs and may supply at most **50% of positive-control cases**
in go/no-go: count `real + min(seeded, real)` toward ten and require
`seeded <= real` for sample adequacy. Retain all observations and report real vs
seeded recall separately; never drop missed controls to meet this cap. Include clean negative controls too. Do not select only
cases that Rio already catches. Keep failed setups in the attempt ledger and
repair them. Expected bugs, rather than diagnostic multiplicity, form recall's
denominator.

Copy for each candidate:

```text
Control ID:
Repository / public introducing PR URL (or parent PR for mutation):
Language:
Base SHA / introducing head SHA:
Kind: real-pr | seeded-mutation
Mutation patch path, SHA-256, and seed (if seeded):
Bug description and deterministic mechanism:
Expected bug ID(s), deduplicated by underlying bug:
Independent oracle command, base result, head result, evidence paths:
Lockfile installer, runtime/tool versions, profile and profile hash:
Offline advisory-cache provenance (if applicable):
Independent reviewer and verdict source: human | automated
Selection rationale (recorded before Rio execution):
Raw report / verdicts / normalized record paths:
Baseline and dependency verification evidence:
Detected finding IDs per expected bug (fill after run; [] = missed):
Setup failures and rerun history:
```

Represent expectations in the verdicts file's `positive_control.expected` list.
Every item contains `id`, `mechanism`, `evidence`, and `finding_ids`. Use the same
ID in any corresponding miss's `expectation_id`. The harness validates matching
IDs and rejects credit from findings that were not adjudicated true-positive.

## Checked real introducing candidates from the November 2026 rerun

These statuses describe the pinned heads investigated during this run, not a new
preregistration. Reuse their evidence and pin a fresh selection before the next
cohort. “Blocked” means an independently established bug remains excluded from
release metrics; it does not mean Rio detected it. Follow-up fixes are provenance,
not substitute positive heads.

- [x] **Accepted: [ky #578](https://github.com/sindresorhus/ky/pull/578), type-error.**
  Introduces `NodeJS.ArrayBufferView` into browser request types. Browser consumer
  `tsc` with `types: []`, `skipLibCheck: false` passes at base and fails at head
  with TS2503; applying only #623's global `ArrayBufferView` fix passes. Rio's
  default config passes both and **misses** the expectation; trusted baselines
  now qualify. [Pins, commands and rejected alternatives](runs/ky-NOTES.md#selection-and-preregistration),
  [preregistered oracle](runs/ky-578-oracle/positive-control-register.json).
- [x] **Accepted: [pydantic-settings #708](https://github.com/pydantic/pydantic-settings/pull/708), uncovered-lines.**
  Adds AWS `version_id` branch without tests; instrumented line 66 and branch
  65→66 are unexecuted at head, base has no missing statements in that file.
  Later #963 adds `test_version_id`. **Detected**, verified baseline.
  [Oracle and pins](runs/pydantic-settings-NOTES.md#independent-oracles-and-control),
  [register](runs/pydantic-settings-evidence/positive-control-register.json).
- [x] **Accepted: [pydantic #14199](https://github.com/pydantic/pydantic/pull/14199), uncovered-lines.**
  New `_contextlib.py` context manager error/suppression paths are instrumented
  but unexecuted; the module is absent at base. Later #14202 excludes those paths.
  **Detected**, verified baseline; scoped full oracle and wheel installation
  workaround are essential. [Pins and final scope](runs/pydantic-NOTES.md),
  [register](runs/pydantic-evidence/control-register.json).
- [x] **Accepted, blocked: [Vue #12701](https://github.com/vuejs/core/pull/12701), type-error.**
  Assigns nullable source-map column to `number`; root `pnpm check` passes at base
  and fails at original head with TS2322, later #13366 adds `!`. Linked workspace
  baseline guard and package-local fallback prevent scoring. [Evidence](runs/vue-core-NOTES.md).
- [x] **Accepted, blocked/unsupported: [Zod #6085](https://github.com/colinhacks/zod/pull/6085), lint-rule.**
  Adds unused `catch (e)` in `scripts/compile-fuzz.ts`; enabled Biome
  `lint/correctness/noUnusedVariables` warns at head (base file absent), with
  `--error-on-warnings` producing the head failure. #6504 removes the binding.
  Rio lacks Biome support and the linked baseline is blocked. [Evidence](runs/zod-NOTES.md).
- [x] **Accepted, blocked: [tRPC #5819](https://github.com/trpc/trpc/pull/5819), type-error.**
  Numeric SSE IDs and unknown resume data cause TS2322/TS2345 in server tests;
  frozen package `tsc` passes base, fails head. #5841 fixes IDs. Two underlying
  expectations were registered; linked workspace baseline prevents scoring.
  [Evidence and pins](runs/trpc-NOTES.md#candidate-selection-and-independent-evidence).
- [x] **Rejected: [pydantic-ai #8641](https://github.com/pydantic/pydantic-ai/pull/8641), consumer typing.**
  Loses generic `OutputSpec[T]` forwarding; only an added external fixture gives
  base-pass/head-fail (`no-any-return`). Configured repository mypy/Ruff pass
  both. Requires a declared consumer scope, not a claimed default adapter miss.
  [Evidence](runs/pydantic-ai-NOTES.md#selection-before-rio).
- [x] **Rejected: [ky #559](https://github.com/sindresorhus/ky/pull/559), exact optional properties.**
  #565 enables the compiler option that exposes the problem; no failure under
  the original config. #619 was also rejected because blame assigns the
  `NodeJS` regression to #578. [Evidence](runs/ky-NOTES.md).
- [x] **Rejected: [pydantic-settings #1089](https://github.com/pydantic/pydantic-settings/pull/1089), semantic decoding.**
  #1097 reproduces a runtime regression without an in-scope deterministic
  oracle. #982 is a Windows-target typing fix without a demonstrated Linux
  introducing-head oracle; #931/#950 enable new lint rules rather than expose
  violations of previously enabled rules. [Evidence](runs/pydantic-settings-NOTES.md).
- [x] **Rejected: [pydantic #14176](https://github.com/pydantic/pydantic/pull/14176), ByteSize boundary.**
  Semantic reproduction only. #14186 changes Ruff/toolchain/lockfile, and #14202
  is the later coverage exclusion, not the introduction. [Evidence](runs/pydantic-NOTES.md).
- [x] **Rejected: [Litestar #4419](https://github.com/litestar-org/litestar/pull/4419), UUID return annotation.**
  Wrong type is also explicitly cast and the file is excluded by Pyright;
  no introducing oracle. #4689 enables a previously misspelled check, #5104's
  tool file is outside configured scope, and #4402 upgrades Ruff.
  [Full search ledger](runs/litestar-NOTES.md#pr-search-and-rejected-candidates).
- [x] **Rejected: [structlog #786](https://github.com/hynek/structlog/pull/786), typing/coverage search.**
  Pinned source/API mypy and Ruff pass both, 910→924 tests pass with 20 skips;
  no unexecuted added statement. #741/#627 repair errors inside the PR before
  its final head; #794's optional-dependency coverage needs the full matrix.
  [Pins and search ledger](runs/structlog-NOTES.md).
- [x] **Rejected: [TanStack/query #10593](https://github.com/TanStack/query/pull/10593) and [#10510](https://github.com/TanStack/query/pull/10510), consumer inference.**
  No existing-tree `tsc` introducing-head failure established. #8875/#8885's
  later async lint fixes do not establish an enabled rule at introduction.
  A seeded control was used instead. [Evidence](runs/tanstack-query-NOTES.md).

The corresponding NOTES files retain further rejected candidates, failed setups,
preregistration timing and exact evidence paths. A rejection here is a reason
not to repeat the same selection under the same scope, not proof the PR is clean.

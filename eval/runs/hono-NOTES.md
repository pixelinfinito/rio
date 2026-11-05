# Hono evaluation notes

## Rerun2 (binary f6e4f87e4c65)

Date: **2026-11-05 (UTC)**. Reviewer: **sub-agent rerun2-hono (automated)**;
verdict source: **automated**. Read the evaluation methodology, control register,
runner instructions, `trpc-NOTES.md`, and `hono-evidence/REPRODUCE.md` before running.

Verified `/home/ubuntu/rio/target/release/rio --version` before the runs and again
afterward: `rio 0.1.0 x86_64-unknown-linux-gnu f6e4f87e4c65`. Binary SHA-256:
`3e28a47f9460af1ae2ad9572d065f4eb03314ee56cdc851c8f185d9bb57572c7`.
No rebuild, changes to `crates/` or `eval/*.py`, push, or PR.

### Frozen setup and selection

Both cases reuse their original `attempt-01/install-plan.json` and `profile.yaml`.
Input install-plan SHA-256:
`1b02b60912f4b5a3268b8ae44ee746ca5476dfeddcbec5e1e87a1eeea17b5598`;
input profile SHA-256:
`6fc8403032b9ed8c47cbe10b8c4e8140350c4a92367eb7db34086daf4925a7d4`.
Each ledger also captures its resolved profile hash. Dependency trust is false.
Node **20.10.0**, Corepack **0.36.0**, Yarn **1.22.22** were verified first;
`COREPACK_ENABLE_AUTO_PIN=0`, `NO_COLOR` unset, `TMPDIR=/dev/shm/hono-rerun2`.
Reports identify TypeScript **5.3.3**, ESLint **8.55.0**, Vitest **1.1.0**.
Original Vitest package entry and historical launcher shim hashes are printed by
the unchanged install plan in every successful installation's stdout log.

The original positive expectation and independent clean assessment were reused
before reviewing new output; see [registration](hono-rerun2-evidence/registration.json).
The optional #3856 and #3859 seed were **not rerun**: the prior notes explicitly
describe them as excluded, with no working baseline, rather than completed
scorable cases. No replacement cases or new mutations were selected.

The canonical selection is [selection.json](hono-rerun2-evidence/selection.json).
It selects one successful-installer retry per case; earlier attempts are retained
as correlated attempts, not additional PRs. Full timings, states, verdict counts,
check outcomes, and comparison data are in [summary.json](hono-rerun2-evidence/summary.json).

### #2081: clean real PR

- Base: `4ec3a9bf41ec3de004836e84757c07ec2b7b4156`.
- Head: `310c8733dbde15f6b279863798e740953a4341dd`.
- Canonical record: [hono-2081-rerun2-attempt2/record.json](hono-2081-rerun2-attempt2/record.json).
- Baseline ran **yes**; baseline classification **yes**; dependency state
  **verified**; eligible **yes**. Both independent frozen installs succeeded;
  runner exit 0. Head/base root typecheck and lint passed; coverage and secrets
  passed. OSV audit was explicitly skipped offline.
- Raw findings and distinct causes: **TP 0, FP 0, pre-existing-shown 0,
  pre-existing-hidden 0, environment-failure 0, out-of-scope 0**. No raw finding
  states, no risks, no established deterministic misses. Positive expectations:
  **0** (negative control).
- The prior false-positive ID
  `8209408388ac70a93c3b324ac9d336488c03bae27b3ccfb971f0369f406803a8`,
  `coverage/untested_change` at `deno_dist/helper/factory/index.ts:273`, is
  **absent in both rerun reports while coverage executes successfully**.
  `hono-2081-oracle/coverage-false-positive-proof.json` and
  `emitted-javascript-equivalence.json` still apply to these exact pins: only
  erased generic type arguments change; source and Deno emitted JavaScript are
  byte-identical. The independent oracle passed tsc/lint at both pins and all
  1009 default tests with 1 skipped at each. This supports the clean assessment.
- Previous attempt had one FP and no TP; canonical rerun has no findings.
  Runner wall time **147.876 s**, Rio subprocess **39.705 s**.

### #2085: exact seeded type control

- Public parent PR: `https://github.com/honojs/hono/pull/2085`; this is a
  **seeded mutation**, not the public PR's real head.
- Base: `b23cf8d65d851de9726d6388b45dda39e6fdb9ab`.
- Synthetic head: `94d2dcbf315dd3ac969d321b532fb0049b1a7c36`.
- Case ID: `2085-seeded-type-error-20261105`.
- Same sole mutation in `src/utils/url.ts:267`:
  `export const rioEvalTypeControl: number = 'rio-eval-trpc-20261105'`.
  Patch SHA-256:
  `8f8a2a9bf2defa96158c9b3102ce8b35f64a9996428174e73d5ba367dd4d7b6b`.
  Verified both the historical transport's diff and the reconstructed bundle's
  diff against the preserved patch; neither the seed nor synthetic commit changed.
- Canonical record: [hono-2085-rerun2-attempt3/record.json](hono-2085-rerun2-attempt3/record.json).
- Baseline ran **yes**; baseline classification **yes**; dependency state
  **verified**; eligible **yes**. Both independent frozen installs succeeded;
  runner exit 0, Rio exit 1 for the expected finding. Base typecheck passed,
  head typecheck returned findings, both lint checks passed, coverage and secrets
  passed. OSV audit was explicitly skipped offline.
- Raw findings and distinct causes: **TP 1, FP 0, pre-existing-shown 0,
  pre-existing-hidden 0, environment-failure 0, out-of-scope 0**. Raw state:
  **new 1**. No risks or established additional deterministic misses.
- Expected **1**, detected **1**, missed **0**:
  `seeded-url-export-type-mismatch` matches finding
  `61519345c86a98b40bcf228e8c5bcea888770a6b79ee55a392217a938457659c`,
  `typecheck/tsc/TS2322`, line 267:14, string not assignable to number, state new.
  Rechecked this exact output and the verified base/head pair.
  `hono-2085-seed-oracle/commands.json` and typecheck logs independently establish
  base exit 0/head exit 2 with exactly this diagnostic; lint and 15 instrumented
  URL tests passed both. The earlier evidence is reusable because pins and patch
  are unchanged.
- Previous attempt and canonical rerun both detect the same one control with
  the same finding ID. Runner wall time **143.825 s**, Rio subprocess **42.866 s**.

### Retained setup attempts and observed limitations

| Attempt | Runner seconds | Rio subprocess seconds | Baseline classification | Installs base/head | Report eligibility |
| --- | ---: | ---: | --- | --- | --- |
| hono-2081-rerun2 | 1708.117 | 55.191 | yes | failed / succeeded | yes, verified |
| hono-2081-rerun2-attempt2 | 147.876 | 39.705 | yes | succeeded / succeeded | yes, verified; selected |
| hono-2085-rerun2 | 1711.367 | 58.462 | yes | failed / succeeded | yes, verified |
| hono-2085-rerun2-attempt2 | 0.514 | unavailable | no | not run | unavailable; no report |
| hono-2085-rerun2-attempt3 | 143.825 | 42.866 | yes | succeeded / succeeded | yes, verified; selected |

The two initial base installers reached Yarn's linking/building phases and timed
out (exit 124; recorded subprocess times 1353.722 s and 1358.710 s) under heavy
shared I/O contention. At 11:04 UTC the observed load average was 99.56 and
`/proc/pressure/io` full avg10 was 93.28%; `/dev/shm` free space had dropped from
5.9 GB to 1.4 GB. Both head installs subsequently succeeded. Contrary to the
short-hand assumption that runner exit 1 always means no baseline, these initial
ledgers correctly show **baseline classification true and eligible true**: Rio
used its own base snapshot against the verified head installation. The separate
base install timeout still caused runner exit 1. These are setup failures, not
Rio diagnostic false positives; their report-derived verdict counts are exactly
the same as the canonical retries. Both reports were normalized and validated.

Retries use the same install plan/profile with only the command timeout increased
from 1200 to 1800 seconds. The #2085 second attempt failed at clone with exit 128:
the historical `/dev/shm/trpc-eval/hono-2081-seed` file transport no longer existed.
No Rio report or verdict skeleton was produced, so no record was fabricated.
The third attempt cloned the public history and fetched
`hono-evidence/2085-seed.bundle` into `/dev/shm/hono-rerun2/seed-transport`, retaining
the exact synthetic head. The process-local Git `url.file://...insteadOf`
override, reconstruction commands, and patch hash are recorded in
[setup-retries.json](hono-rerun2-evidence/setup-retries.json).
Both failures have complete retained command/stderr evidence and no finding IDs.

**No remaining Rio diagnostic defect was observed in these cases.** The former
Deno erased-type coverage false positive is resolved in the measured output.
The unchanged install plan still installs the historical Vitest compatibility
launcher, so successful coverage does not independently prove the new native
version-aware invocation works without it. Exact Rio child argv remains absent
from the report/runner evidence (the footer now does identify tool versions).
No new claim is made about native CLI compatibility. Neither case preregisters
a secret or vulnerability control; the literal-only entropy change is not
positively tested here, and the offline OSV skip provides no audit result.
Report status `incomplete` includes deferred agents (`no_endpoint`) and offline
audit, while all applicable deterministic baseline pairs succeed.

All four available reports have complete automated verdicts, were processed by
unmodified `eval/evaluate.py record`, and passed `eval/evaluate.py validate`.
The fatal clone attempt is retained without inventing missing report metadata.
Runs overlapped; their wall times must not be summed as elapsed evaluation time.
This two-case rerun does not establish cohort-level release acceptance.

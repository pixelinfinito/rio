# Deterministic evaluation methodology v2

This protocol supersedes the per-finding acceptance method in the original
[v0.1 evaluation](../docs/evaluation/v0.1.md) and the release-acceptance bullet in
[the design](../openspec/changes/rio-v0-1-local-cli/design.md#d14-testing-strategy).
Preserve historical reports and verdicts; publish rescoring separately. Freeze this
protocol, sample, tool versions, profile, and control expectations before a run.
Profile changes may share a cohort when the binary hash matches; publish every
profile hash and each record’s profile. Different binaries require separate cohorts
unless explicitly labelled mixed with `--allow-mixed-versions`. Verdicts must
identify their reviewer and whether they are human or automated. Automated
results do not claim to meet the PRD's human confirmation requirement.

## Eligibility and environment

A PR contributes to release metrics only when baseline classification worked for
**every applicable typecheck and lint root**: matching successful head and base
check entries (`passed` or `findings`), each with `dependency_state` in
`{verified, trusted}`. Disabled checks and `no_project_config` skips are
inapplicable; missing tools, dependency mismatches,
and failed/cancelled checks still block eligibility. Every root appearing on either
side needs the matching other side.
A successful cached base counts. A baseline that ran but failed does not count.
The harness records both `baseline_ran` (any base execution/cache result) and
`baseline_classification_ran` (all applicable pairs succeeded). No applicable
pairs is insufficient evidence of a working baseline.

Missing tools, failed checks, unavailable dependencies, lockfile mismatch,
disabled baseline, or absent baseline evidence make the PR an
`environment-failure`. Exclude it from precision, recall, false-positive rate,
and usefulness denominators. Preserve its findings and defects as observations;
fix setup and rerun the same pinned change. Do not silently replace hard cases.
List every exclusion and its reason. Repeated failures in one repository are
correlated evidence, not independent product-quality measurements.

Predeclare applicable checks. A skipped dependency audit in an offline cohort is
an explicit capability limitation, not proof of safety. An offline audit control
needs a pinned populated advisory cache and evidence that the audit actually ran;
otherwise it is an environment failure. Coverage controls require instrumentation
and successful test execution. Trust is an explicit environment choice, not
dependency verification. Publish all-eligible metrics alongside verified-only
metrics, excluding any pair with a
trusted or unavailable dependency state from the latter. Record the combined
diagnostic dependency state (`verified`, `trusted`, `mixed`, or `unavailable`);
`mixed` pairs qualify only when every entry is verified or trusted. Rio currently
reuses the head installation for its base materialization; installing a separate base checkout does not by itself fix
incompatible base/head lockfiles.

## Finding verdicts

Every emitted top-level `findings` and `risks` entry receives exactly one verdict
and an evidence-backed reason. Do not count nested copies in `checks` again.

| Class | Meaning |
| --- | --- |
| `true-positive` | Correct, change-specific, actionable deterministic issue; an independent reviewer would act on it. |
| `false-positive` | Visible incorrect claim, such as an identifier or dummy fixture reported as a leaked credential. Being pre-existing does not make an incorrect claim correct; hidden states use the informational class below. |
| `pre-existing-shown` | Valid diagnostic already present on the base but visible by default (`new`, `worsened`, or `unclassified`); unwanted in this review. Confirm with base evidence; unclassified alone is not proof. |
| `pre-existing-hidden` | Raw state is `pre-existing` or `fixed`; informational and excluded from precision and usefulness. |
| `environment-failure` | Diagnostic attributable to broken setup, or analysis impossible because a check/baseline was unavailable. Skips usually live in environment records rather than synthetic findings. |
| `out-of-scope` | Requires semantic/agent reasoning beyond the deterministic checks. |

Visibility is derived from the raw finding state, including risks, using the
same rule as `rio-core/src/render.rs::visible()`: only `pre-existing` and `fixed`
are hidden. A hidden raw state overrides the adjudicator’s label; a visible state
cannot be labelled `pre-existing-hidden`. Preserve the raw finding and evidence
reason. V2 records and summaries use `deterministic-v2`; v1 artifacts remain
valid historical evidence and are rescored in memory when aggregated.

`noise` is not a verdict. Check failures must not be relabelled as product false
positives. Conversely, dependency trust does not excuse an independently proven
false credential alert.

## Unit of scoring and deduplication

Score distinct root causes within each PR, using SHA-256 of the canonical JSON
tuple **[rule_id, message_template, sorted unique file_set]**. Default template:
collapse whitespace only. Default file set: union of `location.path` and
`locations[*].path`. Line numbers and symbol paths do not enter the key. A
reviewer may supply a shared template and file set for diagnostics from one
proven cause; document why. Do not erase differing types, rules, or independent
problems merely to reduce counts. Identical visible keys must have identical
verdicts. Hidden occurrences are grouped separately under the same cause hash
so they cannot conflict with or
add weight to a visible cause.

Retain every original Rio finding unchanged in its record. Report raw finding
counts, raw location occurrences (unique locations per finding), and distinct
causes per class. Multiple findings from one cause count once for precision.
The same cause recurring in several PRs counts once in each PR's metrics; also
report unique `(repository, root_cause_key)` counts across the cohort. A broader
`family` is explanatory only: several rules can share one setup/configuration
failure but cannot become one scoring key. Render one row per key, with raw
counts and a record link, rather than one row per diagnostic.

## Misses, controls, and usefulness

Record independently established misses with scope `deterministic` or
`agent-layer`. Deterministic misses must name a plausible mechanism: type error,
enabled lint rule, uncovered changed lines, leaked secret, or vulnerable resolved
dependency. A failing semantic reproduction is not enough to assert that a
typechecker, linter, or coverage report could detect it. Put semantic misses in
the **agent-layer backlog**; they never reduce deterministic recall.

Register positive controls before inspecting Rio output. Each expectation has a
stable ID, mechanism, independent evidence, and matching Rio finding IDs (empty
means missed). Only `true-positive` findings satisfy expectations. A finding may
match multiple expectations only when the independent oracle establishes each
one; reviewers must check this. Dedupe expectations at the underlying bug level,
not one per changed line. Every deterministic miss in a positive-control PR must
have an expectation ID. Additional discovered misses must be recorded even if
they are outside the preregistered recall denominator.

A PR is **useful** if a reviewer would act on at least one true-positive cause,
OR the report correctly confirms a clean change with working baseline, no false
positives, no visible unwanted pre-existing diagnostics, and no deterministic misses.
The clean branch requires an independent clean-change assessment, not merely
zero output. An environment failure cannot earn useful or not-useful status.
Semantic backlog items do not turn a deterministically clean result into a miss.

## Sample and decision rule

Use at least **10 eligible real PRs, 5 independent repositories, both TypeScript
and Python**, and **N = 10 eligible positive-control changes**, at least 5 per
language across at least 3 repositories. Controls can be real introducing PRs or
seeded mutations; mutations are additional cases and do not replace the 10 real
PRs. Seeded cases are capped at **50% of positive-control cases** for go/no-go:
count `real + min(seeded, real)` toward the required ten, and require
`seeded <= real` before the sample can be adequate. Do not cherry-pick successful
seeds to enforce the cap. All observed recall remains reported; exceeding the cap
makes the decision insufficient-evidence, even with perfect pooled recall.
Report real-PR and seeded recall separately (expected underlying bugs remain each
recall denominator), alongside pooled recall in both dependency views.
Include independently confirmed clean changes as negative controls. Record
all attempts, seeds, parent PRs, and repeated environments; report by repository
and language as well as pooled totals. Do not imply that ten mutations in one
repository are ten independent repositories. See [control selection](positive-controls.md).

For eligible records, with TP and FP measured in **per-PR distinct causes**:

- Precision = TP / (TP + FP), targeting **≥ 0.80**, consistent with the
  [PRD](../docs/PRD.md#success-metrics). No denominator means `null`, never 100%.
- Positive-control recall = detected expected bugs / registered expected bugs,
  targeting **≥ 0.80**. This is an explicit deterministic-layer acceptance floor,
  not a claim to exceed the PRD's later baseline-tools target. Report the oracle
  tool outcomes with the controls; agent comparison belongs to a later cohort.
- False-positive-per-PR rate = FP causes / eligible PRs, targeting **< 0.15**.
  This is a separately defined operational threshold, not the PRD's per-agent
  dismissal fraction. Also report the fraction of PRs with any FP.
- Demonstrate **at least 10 useful real PRs**, retaining the v0.1 exit criterion.

**Go** requires every sample requirement, defined precision and recall, all three
quality thresholds, and the usefulness requirement. **No-go** means a quality
threshold failed in an adequate sample. **Insufficient-evidence** means sample
or denominators are missing; this never authorizes release. Environment failures
must be repaired before counting their PRs; publish them even if the remaining
sample suffices. Report uncertainty and correlated cases rather than treating
these minimum sample sizes as statistical confidence guarantees. Performance
acceptance (cold/warm p50/p95 over ten runs each) remains a separate gate.


## Cohort selection and provenance

Different profiles (including budgets, trust choices, and scopes) may be pooled
under one binary hash; retain the resolved profile hashes and each record's
profile. Missing captured hashes are explicitly unavailable, never inferred from
a profile name or a release version. Mixed version/hash identities require
`--allow-mixed-versions` and a prominent mixed label, including excluded attempts.
The all-eligible view drives the decision; verified-only is a stricter sensitivity
view with the same metric formulas.

Default duplicate detection lists every conflicting record. `--select latest`
chooses the greatest Rio run ULID, with record path breaking ties;
`--select eligible-only` drops excluded attempts but still rejects multiple
eligible attempts. `--select MANIFEST.json` explicitly lists one path per case,
relative to the manifest. A real case is a repository/PR URL; synthetic controls
use repository/case ID. Keep an attempt ledger and explain canonical selections
in the cohort narrative instead of treating retries as independent PRs.

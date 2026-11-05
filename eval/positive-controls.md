# Positive-control selection

Fill this register in evaluation threads **before** running Rio. Concrete PRs
are deliberately left open. Review the PR that **introduced** the problem:
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
do not count as real PRs. Include clean negative controls too. Do not select only
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

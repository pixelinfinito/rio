# Evaluation records

New runs follow [the reusable harness](../../eval/README.md) and
[deterministic-v1 methodology](../../eval/METHODOLOGY.md): verified baseline
classification, distinct-cause verdicts, independent clean controls, and registered
positive controls across at least five repositories and both languages.

The original automated [v0.1 evaluation](v0.1.md) and [JSON](v0.1.json) are
historical evidence. Their per-finding `noise` rubric is superseded. The
[v0.1 rescoring](v0.1-rescored.md) preserves that evidence, records all ten PRs as
environment failures, and separates the two semantic misses from deterministic
recall. Its conclusion is insufficient evidence; stable release remains blocked.
The original automated reviewer identities are preserved; no human verdicts are
claimed.

Normalized records and their aggregate live in [v0.1-rescored/](v0.1-rescored/).
Rebuild them with `python3 eval/rescore_v01.py`. Raw artifacts are documented in
[evidence/README.md](evidence/README.md). Compressed JSON uses deterministic gzip;
`eval/evaluate.py` accepts it directly.

The existing `scripts/check-acceptance.py` and stable-release CI still read the
original v0.1 acceptance format. `--record-only` verifies historical completeness;
the stable gate remains blocked by its no-go conclusion. Migrating release CI to
a new scored cohort is separate work: do not change the old conclusion to go or
present the rescoring as passing acceptance. New quality measurements must be
generated with `eval/evaluate.py`, not the old `scripts/aggregate-evaluation.py`.

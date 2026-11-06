# Verification artifacts and report extensions

Existing finding-v1 and report-v1 documents remain valid without the new optional
fields. Published finding categories are `defect`, `risk`, `security`; `style` and
`diagnostic` exist only in hypothesis/vote audit artifacts.

```json
{
  "voters": 3,
  "agreeing": 2,
  "blind_match": ["same", "related", "none"],
  "split": false
}
```

This optional `finding.verification` summary contains no confidence score.
`agreeing <= voters`, `voters > 0`, and one blind comparison per configured voter
are semantic invariants checked by typed deserialization and runtime validation.
JSON Schema describes the scalar/list shape; standard JSON Schema cannot compare
two arbitrary integer properties. Report JSON validation additionally runs Rio's
count checks before emitting bytes. Existing `round`, `first_posted_in` and
`author_response` convergence keys remain accepted by the schemas.

Report-v1 optionally adds `security` and `agent_audit`. Empty security data is
omitted. `agent_audit` records `held_back` titles by `defects`/`risks`/`security`
pool, `category_drops`, `refuted`, `suppressed`, `policy_failed`, `policy_matches`,
`require_human`, `board_deferred`, and `verification_usage` (input/output tokens,
nullable USD cost). `policy_failed` and `policy_matches` are required whenever
`agent_audit` is present; the CLI exits 4 rather than 0 if they are missing or mistyped.
When votes fail, `incomplete_votes` records their count, the report is incomplete,
and `fail_on.incomplete` controls exit 4, as it does for partial reports. Skipped optional deterministic checks
retain their existing exit policy.
Plausible security findings retain category security and render as risks for human
judgment. Presentation caps never weaken security failure policy. Footer summaries
identify held-back findings separately from suppression/category counts.

Each hypothesis is stored in D1's `hypotheses` audit index with an atomic private R2
object. Voter audit objects contain `voter`, `status`, `blind`, `blind_match`, an
optional structured `answer`, artifact-validated `validated_level`, `validation_note`
when a claimed level lacks supporting artifacts, and `error` on
failure. Status distinguishes `completed`, `failed`, `cancelled`, `exhausted` and
`malformed`. An unfinished second turn is persisted before disclosure. Each vote
is keyed by review, hypothesis and voter identity; another voter cannot contribute
twice to quorum.

An answer contains `evidence_level`, `evidence` references, and optional downward
`category` plus `reclassification_reason`. Code references identify selected
version, path and graph node IDs; execution references identify a recorded job and
version. `demonstrates` distinguishes `regression` from `protection`. Invalid
references cannot support proof or refutation. Blind comparison is computed from
normalized rule/trigger identity or symbol, never accepted from model output.
Failed votes supply no support and configured quorum stays fixed. Identical repeated
provider JSON documents are accepted once, and only the parsed protocol document
is retained in conversation history. Raw output remains in the private audit;
its complete provider-reported usage is still charged. Different concatenated
answers remain malformed.

Published agent `evidence` strings contain validated `code:head:PATH:NODE_IDS` or
`execution:VERSION:JOB_ID` references. The audit returns `hypothesis_id` on every
vote and the completed execution records. Analysis/check summaries, failed spawns,
timeouts and truncated executions cannot establish reproduction or refutation.
All blind matches may remain `none` while runner-backed evidence is reproduced.

The correctness prompt emits `guidance/contradiction` and `guidance/stale` as risks,
citing `guidance: {path, line}` and changed code. Verification requires an existing,
applicable immutable guidance line and actual code evidence. Guidance alone cannot
prove the finding or alter policy.

Review usage reservations are atomic across agents/voters. Separate phase records
identify generation, blind verification and disclosed verification. A failed call
retains its reservation when actual provider usage is unknown. A provider's missing
usage or malformed result is a failure, never free verification. The initial
per-voter budget is one fifth of active agent tokens, rounded down with a minimum
of one. Profile `verify_tokens` overrides it within the review-wide limit.
Risk-selected budgets update the overall ledger and a deadline measured from review
creation. Already consumed/reserved tokens remain charged. Runner results use
content-addressed R2 keys and conditional D1 publication; conflicting completions
cannot overwrite the winning artifact. Results completed after cancellation remain
in audit without resuming model work.

The authenticated `/v1/reviews/:id/audit` endpoint returns the audit. The CLI stores
it under the run's `verification/audit.json`, using the existing private atomic
cache. Output is redacted before persistence. Repository source snapshots remain
private immutable source, so they are not rewritten by output redaction.
Risk status is always neutral advisory data; it is not approval. No SARIF or PR
publisher ships in this change. See [Cloudflare operations](cloudflare.md).

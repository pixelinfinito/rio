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

## Review lineages and rounds

A review joins a lineage when its submission names one. The optional
`lineage` member of `POST /v1/reviews` is:

```json
{
  "lineage": {
    "repository": "github.com/pixelinfinito/rio",
    "kind": "branch",
    "ref": "feature/x",
    "reset": false
  }
}
```

`repository` (1-1024 characters, no control characters) is a client-chosen key
scoped to the tenant; `kind` is `pr` (with the PR number as `ref`) or `branch`
(with the branch name). Unknown members are rejected with HTTP 400. The
endpoint holds lineage state, keyed by tenant, repository, kind and ref and
independent of commit ancestry, so a rebased or force-pushed head stays in the
same lineage. `reset: true` starts a new generation at round 1; resetting a
generation that has no review yet is a no-op. Reviews submitted without
`lineage` have no round, no `report.lineage` and no lifecycle keys, and write no
finding rows.

Rounds. A review's `round` is one plus the number of earlier reviews in its
generation that listed at least one finding (any category, including risks,
held-back and capped ones); a review that lists none does not consume a round.
The round is assigned when the review's workflow starts and stamped on every
finding (`findings`, `risks`, `security` and each check's `findings`). The
previous reviewed head is the snapshot of the most recent earlier review of the
generation that finished its workflow; failed reviews do not advance it.
Lineage reviews are expected to run one at a time.

`rounds_to_pass` is the round of the first `complete` review of the generation
with no open defect: no unanswered `defect` among its findings and no earlier
defect that is still `open` (not fixed and not dismissed). It is null while
defects remain open and never changes afterwards within the generation.

Report. Lineage reviews add `report.lineage` with `repository`, `kind`, `ref`,
`generation`, `round`, `cap` (profile `rounds.cap`, default 3), `capped`
(`round > cap`), `diff_only`, `previous_head`, `held_back`, `rounds_to_pass`
(after this review) and `author_response_ratio` (`fixed` share of answered
findings in the tenant's repository, null when there is none). Findings carry
`round`; posted findings also carry `first_posted_in` (snapshot id of the
round that first posted the identity) and lifecycle `status`, plus
`author_response` once answered. `report.agent_audit.already_posted` lists the
held-back identities (renderers mark them as already posted), and
`agent_audit.lineage_updates` lists `{id, status, resolution}` for earlier
open findings that this review did not produce.

- Never re-post: an identity already posted in the generation is held back.
  It stays in the report's lists (so `fail_on` sees it), keeps its original
  `first_posted_in` and counts in `held_back`.
- Round cap: when `capped`, the report still lists every finding, deterministic
  (`source.tool`) findings are still posted, and agent findings not posted
  before are summarized by `reconsider`: `unresolved` (open agent findings),
  `top` (up to three, by severity then evidence level, with `id`, `title`,
  `path`, `line_start`) and, when the change exceeded `max_lines` (the
  resolved profile's `max_lines` against the summed `lines_changed`, or the
  prepare step's footer note), `split`: changed files grouped by their deepest
  check root, otherwise by top-level directory, as `"<part> (N files, M lines)"`.
- Diff-only re-review: for `round > rounds.diff_only_after` (default 1) with a
  previous head, agents receive the previous-head to new-head change as the
  changed code, the generation's earlier findings with their current states,
  and the intent of the generation's first review. Checks and the graph still
  run on base to head. The verifier re-verifies only new hypotheses in files of
  that incremental change and earlier open agent findings whose location moved
  or whose code changed; an open finding on unchanged code keeps its earlier
  verification and is not dispatched to voters. The plan is recorded in
  `agent_audit.diff_only` (`reverified`, `carried`, `not_reverified`).
- Class findings: agent findings with equal category, `rule_id` and trigger
  hash (`blake3` of the whitespace-normalized trigger, the same hash used by the
  blind comparison) across different symbols merge when their count exceeds the
  consolidation `class_threshold` (default 3). The class finding's id is
  `blake3(rule_id | "class" | trigger_hash)`, its `locations` list every
  instance and its message reads `N occurrences of <message>; fix the pattern,
  for example at <path>:<line>`. `agent_audit.classes` maps each class id to its
  instance ids. A suppression or response on the class applies to every instance.

Lifecycle. A posted finding starts `open`. When a later `complete` review of
the generation re-assessed its location (for deterministic findings, the
check that produced it, or every check covering its path, ran with outcome
`passed` or `findings`; for agent findings, a verify step finished without
incomplete votes), no longer produces its identity, and the code at its
location changed or was removed, it becomes `fixed` with
`resolution.fixed_in` set to the new snapshot id. Otherwise it stays `open`
with `resolution.note` `not re-assessed` or `did not reproduce` (unchanged
code). `status` never changes regression `state` or `fail_on`.

Storage. Migration `0002_convergence.sql` adds `lineages` (generation, current
round, previous head, posted identities, `rounds_to_pass`, carried intent),
`lineage_reviews`, `findings` (one row per tenant, lineage generation and
identity, written when a lineage review finishes) and `feedback`, whose
`reason` accepts only `fixed | wrong | intentional | irrelevant | style`
(draft `false_positive` and `known` rows convert to `wrong` and
`intentional`).

`GET /v1/lineages?repository=…&kind=…&ref=…` (scope `reviews:read`) returns the
current generation (`round` is the round of its latest finished review, 0
before the first) or HTTP 404. `POST /v1/findings/{id}/feedback` (scope
`reviews:write`) answers a posted finding with
`{ reason, note?, actor?, lineage? }`; `actor` defaults to the token's tenant.
It returns `{ id, status: "dismissed", author_response }`, HTTP 400 for any
other reason and HTTP 404 when the tenant has no posted finding with that id.
It writes the finding row and a `feedback` record only. See
[convergence contracts](convergence-contracts.md).

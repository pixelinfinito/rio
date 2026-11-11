# Finding history, suppression proposals, SARIF and the agent cache

These endpoint features are specified by the `finding-history`, `suppression-proposals`, `sarif-output` and `agent-result-cache` capabilities of `openspec/changes/rio-v0-3-core`. All of them work with the CLI and a configured endpoint; none needs the GitHub App. Pull request publication (stage 4) will feed the same registry with `/rio dismiss` answers and name the dismissing pull request.

## Repository key

The registry, the proposals and remembered dismissals are per tenant and repository. The CLI sends the repository key with every endpoint review: the lineage's repository for `--since-last`, otherwise the normalized `origin` URL (for example `github.com/acme/api`) or the repository directory name without an `origin`. A submission without a key (an older CLI) is reviewed normally and the footer says that finding history was not consulted.

## Finding registry

Every finished review updates one `finding_history` row per produced identity: first and last review, the number of reviews that produced it, the latest lifecycle status (`open`, `fixed`, `dismissed`), the latest author response, the last location, and two code hashes: the one at the head where the status was last set (`code_hash`) and the one at the last sighting (`seen_code_hash`). A code hash is the blake3 hash of the enclosing symbol's text (the smallest head graph node containing the location, else the location's own lines); only trailing whitespace, line endings and blank lines are normalized, since indentation and whitespace inside a line can change behavior. A class finding hashes every instance location, so a new or changed occurrence is new code.

The writes are idempotent and order-independent: each review's sighting is recorded once in `finding_sightings`, so a replayed Workflow step never counts twice, and the first and last review follow the reviews' creation times rather than the order in which they finish. They run in their own durable step before the review is marked finished. The status, answer, origin and dismissal hash are written only when nobody set the status since the review read the record (`status_at`), so an answer given while a review runs is never overwritten.

During consolidation, after the profile's suppressions:

| Registry record | Current code hash | Result |
| --- | --- | --- |
| none | — | reported; no `history` |
| `open` | any | reported with `history` |
| `dismissed` `intentional`, `irrelevant` or `style` | equal | removed from findings, risks and security; listed in `report.remembered` with `history`; counted in the footer by reason and origin |
| `dismissed` `intentional`, `irrelevant` or `style` | different | reported with `history` naming the earlier answer |
| `dismissed` `wrong` (or `fixed`) | any | reported with `history`; `wrong` is never remembered |
| `fixed` | any | reported with `history.previous_status: fixed` and `history.fixed_in`: a regression of that fix |

`history` is `{ first_seen, last_seen, seen_count, previous_status, previous_response?, dismissed_in?, fixed_in? }`, where `seen_count` counts the earlier reviews. It never changes `state`, `status` or fail policies, and remembered findings are removed from the agent audit's policy matches. An identity answered inside the review's own lineage follows the lineage rules (status `dismissed` with its `author_response`) rather than being remembered. `rio review --show-remembered` lists remembered findings in their own section; the footer and the exit code do not change.

`POST /v1/findings/{id}/feedback` also updates the registry, and the dismissal takes the code hash of the code last seen, so a finding re-reported on changed code and dismissed again is remembered on that code (and no longer on the earlier one). Without a posted lineage finding it answers the identity's latest registry record, so findings of plain endpoint reviews can be dismissed too; it is HTTP 404 only when neither exists. `{id}` is the full identity or a prefix of at least 8 characters (the id `rio findings`, the reports and PR comments show); a shorter one is HTTP 400, and a prefix matching several posted findings or registry records is HTTP 409 with `candidates` listing their identities, so nothing is recorded until the id is unambiguous. The dismissal origin is `<repository>#<number>` for pull request lineages and the review id otherwise, and the feedback row records its repository.

`GET /v1/findings?repository=&status=&rule=&since=` (scope `reviews:read`) lists the caller's records, newest first, at most 1000:

```json
{ "findings": [ { "identity": "…", "repository": "github.com/acme/api", "rule_id": "lint/eslint/no-unused-vars",
  "status": "dismissed", "first_seen": "<review>", "last_seen": "<review>", "seen_count": 3,
  "location": { "path": "src/a.ts", "line_start": 3, "line_end": 3, "symbol_path": "a", "occurrence_state": "new" },
  "author_response": { "reason": "style", "actor": "dev@example.com", "at": "…" },
  "dismissed_in": "github.com/acme/api#41", "updated_at": "…" } ] }
```

`status` is `open`, `fixed` or `dismissed`; `since` is an RFC 3339 timestamp compared with the record's last update. A `repository` the tenant has no record for is HTTP 404 with no records, so another tenant's repository is indistinguishable from an unknown one. `rio findings [--status S] [--rule R] [--since T] [--format json]` renders it for the current repository.

## Suppression proposals

When a review finishes, the endpoint reads the repository's responses of the last 90 days (a response counts only for the repository it was given in; responses recorded before migration 0005 have no repository and are matched by identity), keeps the latest response per finding, and counts only `irrelevant` and `style`. At least `proposal_threshold` (option of `rio/report`, default 3) such responses on one rule id give a `{ rule }` proposal; as many on findings under one directory with differing rule ids give a `{ path: "<dir>/**" }` proposal. Proposals are stored with an id, status (`proposed`, `applied`, `declined`) and their evidence (finding identity, reason, actor and date of each response). A declined entry is not proposed again for 180 days; an applied one never. The report's `suppression_proposals` lists the open ones and the footer shows each with its evidence count.

A proposal suppresses nothing. The endpoint never writes repository files; only `rio suppressions apply <id>` appends the entry to `.rio/profiles/default.yaml` after you confirm it.

- `GET /v1/suppressions?repository=&status=` (scope `reviews:read`): `{ "suppressions": [ { "id", "repository", "entry", "status", "evidence_count", "evidence": [ { "finding", "reason", "actor", "at" } ], "note"?, "created_at", "decided_at"? } ] }`, the caller's tenant only.
- `POST /v1/suppressions/{id}` (scope `reviews:write`) with `{ "status": "applied" | "declined", "note"? }` records the decision. HTTP 404 for an unknown or foreign id, 409 when the proposal is no longer `proposed`.

## SARIF

`GET /v1/reviews/{id}/report?format=sarif` returns the stored report as a SARIF 2.1.0 log (`content-type: application/sarif+json`) following [the SARIF mapping](sarif-mapping.md); `format=json` (the default) returns report-v1. The invocation spans the review's creation and its final event, and has no exit code. `rio review --format sarif` renders the same mapping in the CLI with its exit code; both renderers are tested against `tests/fixtures/sarif/`.

## Agent result cache

The `rio/agents` step keys each agent's hypotheses by changed hunk. `hunk_hash` is the blake3 hash of the path and the hunk's removed and added lines (trailing whitespace trimmed, no context lines). `context_hash` covers the agent name, its manifest version, its prompt, the resolved model identifier, the agent's resolved options, the Worker version (the generic agent instructions are Worker code), the base and head text and line range of the graph symbols enclosing the hunk and of their one-hop neighbours (the whole file where no symbol encloses it, and the whole base file in diff-only lineage rounds), so a moved symbol misses instead of replaying old line numbers, and the content hashes of the owner guidance in scope. Entries are `cache/<tenant>/<hunk_hash>/<context_hash>.json` in R2 with an `agent_cache` index row.

- A hunk whose entry exists replays its hypotheses with `source.cached: true`; they are verified fresh like any hypothesis. When every hunk of an agent hits, the agent makes no model call. Otherwise the agent reviews the files with missed hunks.
- After an agent run that completed within budget, its accepted hypotheses are attributed by primary location to the hunks of the change, hits included (the hunk containing the location, else the nearest hunk of the same file); each missed hunk gets an entry with its own hypotheses, possibly empty, and hypotheses attributed to a hit hunk are not stored. A missed hunk whose hypotheses cite a location outside the symbols or files its context hash fixes gets no entry, and a run with a hypothesis in no changed file writes nothing, so a replay can never return what the key does not cover. A failed, timed-out or budget-cut run writes nothing.
- Entries are per tenant. Fork reviews, the `rio/security` step (whose result is catalog coverage) and `rio/agents` with `cache: false` neither look up nor write.
- Entries expire with the repository's evidence retention, 90 days (the TRD default; not yet configurable per repository): an expired entry misses and is removed, and each finished review removes up to 100 of the tenant's expired entries.
- The report's `cache` object is `{ lookups, hits, hit_rate, tokens_saved_estimate }` whenever the agents step ran; the estimate sums the stored per-hunk share of the original run's tokens. The footer states the hit rate when at least one lookup was made.

An edit to an agent's `prompt.md` must bump its manifest `version` and record the new prompt hash in `worker/tests/prompt-versions.json`; a Worker test fails otherwise.

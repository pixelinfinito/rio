# Finding history, suppression proposals, SARIF and the agent cache

These endpoint features are specified by the `finding-history`, `suppression-proposals`, `sarif-output` and `agent-result-cache` capabilities of `openspec/changes/rio-v0-3-core`. All of them work with the CLI and a configured endpoint; none needs the GitHub App. Pull request publication (stage 4) will feed the same registry with `/rio dismiss` answers and name the dismissing pull request.

## Repository key

The registry, the proposals and remembered dismissals are per tenant and repository. The CLI sends the repository key with every endpoint review: the lineage's repository for `--since-last`, otherwise the normalized `origin` URL (for example `github.com/acme/api`) or the repository directory name without an `origin`. A submission without a key (an older CLI) is reviewed normally and the footer says that finding history was not consulted.

## Finding registry

Every finished review updates one `finding_history` row per produced identity: first and last review, the number of reviews that produced it, the latest lifecycle status (`open`, `fixed`, `dismissed`), the latest author response, the last location, and a code hash. The code hash is the blake3 hash of the enclosing symbol's text (the smallest head graph node containing the location, else the location's own lines) with whitespace collapsed and blank lines dropped, taken at the head where the status was last set.

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

`POST /v1/findings/{id}/feedback` also updates the registry. Without a posted lineage finding it answers the identity's latest registry record, so findings of plain endpoint reviews can be dismissed too; it is HTTP 404 only when neither exists. The dismissal origin is `<repository>#<number>` for pull request lineages and the review id otherwise.

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

When a review finishes, the endpoint reads the repository's responses of the last 90 days, keeps the latest response per finding, and counts only `irrelevant` and `style`. At least `proposal_threshold` (option of `rio/report`, default 3) such responses on one rule id give a `{ rule }` proposal; as many on findings under one directory with differing rule ids give a `{ path: "<dir>/**" }` proposal. Proposals are stored with an id, status (`proposed`, `applied`, `declined`) and their evidence (finding identity, reason, actor and date of each response). A declined entry is not proposed again for 180 days; an applied one never. The report's `suppression_proposals` lists the open ones and the footer shows each with its evidence count.

A proposal suppresses nothing. The endpoint never writes repository files; only `rio suppressions apply <id>` appends the entry to `.rio/profiles/default.yaml` after you confirm it.

- `GET /v1/suppressions?repository=&status=` (scope `reviews:read`): `{ "suppressions": [ { "id", "repository", "entry", "status", "evidence_count", "evidence": [ { "finding", "reason", "actor", "at" } ], "note"?, "created_at", "decided_at"? } ] }`, the caller's tenant only.
- `POST /v1/suppressions/{id}` (scope `reviews:write`) with `{ "status": "applied" | "declined", "note"? }` records the decision. HTTP 404 for an unknown or foreign id, 409 when the proposal is no longer `proposed`.

## SARIF

`GET /v1/reviews/{id}/report?format=sarif` returns the stored report as a SARIF 2.1.0 log (`content-type: application/sarif+json`) following [the SARIF mapping](sarif-mapping.md); `format=json` (the default) returns report-v1. The invocation spans the review's creation and its final event, and has no exit code. `rio review --format sarif` renders the same mapping in the CLI with its exit code; both renderers are tested against `tests/fixtures/sarif/`.

## Agent result cache

The `rio/agents` step keys each agent's hypotheses by changed hunk. `hunk_hash` is the blake3 hash of the path and the hunk's removed and added lines (trailing whitespace trimmed, no context lines). `context_hash` covers the agent name, its manifest version, its prompt, the resolved model identifier, the agent's resolved options, the Worker version (the generic agent instructions are Worker code), the base and head text of the graph symbols enclosing the hunk and of their one-hop neighbours (the whole file where no symbol encloses it, and the whole base file in diff-only lineage rounds), and the content hashes of the owner guidance in scope. Entries are `cache/<tenant>/<hunk_hash>/<context_hash>.json` in R2 with an `agent_cache` index row.

- A hunk whose entry exists replays its hypotheses with `source.cached: true`; they are verified fresh like any hypothesis. When every hunk of an agent hits, the agent makes no model call. Otherwise the agent reviews the files with missed hunks.
- After an agent run that completed within budget, its accepted hypotheses are sliced by primary location into the missed hunks (the hunk containing the location, else the nearest hunk of the same file, else the first), so every missed hunk gets an entry, possibly empty. A failed, timed-out or budget-cut run writes nothing.
- Entries are per tenant. Fork reviews, the `rio/security` step (whose result is catalog coverage) and `rio/agents` with `cache: false` neither look up nor write.
- Entries expire with the repository's evidence retention, 90 days (the TRD default; not yet configurable per repository): an expired entry misses and is removed, and each finished review removes up to 100 of the tenant's expired entries.
- The report's `cache` object is `{ lookups, hits, hit_rate, tokens_saved_estimate }` whenever the agents step ran; the estimate sums the stored per-hunk share of the original run's tokens. The footer states the hit rate when at least one lookup was made.

An edit to an agent's `prompt.md` must bump its manifest `version` and record the new prompt hash in `worker/tests/prompt-versions.json`; a Worker test fails otherwise.

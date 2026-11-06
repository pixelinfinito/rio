# Review convergence contracts

Shared wire contracts for review lineages, rounds and finding feedback
(`openspec/changes/rio-v0-2-review-convergence`). The endpoint is the single
authority for lineage state; clients keep only caches.

## Submission

`POST /v1/reviews` accepts an optional `lineage` object:

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

- `repository` is a client-chosen stable key, scoped to the tenant. The CLI uses
  the normalized `origin` remote URL (scheme, credentials and `.git` suffix
  removed), or the repository directory name when there is no `origin`.
- `kind` is `pr` (with the PR number as `ref`) or `branch` (branch name).
- `reset: true` starts a new lineage generation at round 1. Losing a client
  cache never implies a reset.
- Without `lineage` the review has no round and no `report.lineage`.
- Any other member, a `kind` outside `pr | branch`, a non-numeric `pr` ref or an
  empty or over-long (more than 1024 characters) `repository`/`ref` is HTTP 400.

## Report

Lineage reviews add `report.lineage` (see `schemas/report-v1.json`):
`repository`, `kind`, `ref`, `generation`, `round`, `cap`, `capped`,
`diff_only`, `previous_head` (previous reviewed snapshot id or null),
`held_back`, `rounds_to_pass`, `author_response_ratio` and, when capped,
`reconsider` (`unresolved`, up to three `top` findings with `id`, `title`,
`path`, `line_start`, and an optional `split` list of logical parts when
`max_lines` was exceeded).

Findings in lineage reviews carry `round`, `first_posted_in` (snapshot id of the
round that first posted the identity), lifecycle `status`
(`open | fixed | dismissed`), optional `resolution` (`fixed_in`, `note`) and,
once answered, `author_response`. Regression `state` is unchanged by `status`.

Held-back findings (identities already posted in the lineage) remain in the
report's finding lists so `fail_on` sees them; `report.lineage.held_back`
counts them and renderers mark them as already posted. The held-back ids are
listed in `report.agent_audit.already_posted` (a held-back finding is also
recognizable by `first_posted_in` differing from the reviewed snapshot).
Earlier open findings that a review did not produce are reported in
`report.agent_audit.lineage_updates` as `{ id, status, resolution }` (`fixed`
with `fixed_in`, or `open` with note `not re-assessed` / `did not reproduce`);
they are not added to the finding lists. When `capped` is true,
agent findings are summarized by `reconsider` for publication; the report still
lists every finding.

## Lineage state

`GET /v1/lineages?repository=…&kind=…&ref=…` (scope `reviews:read`) returns
the current generation:

```json
{
  "repository": "github.com/pixelinfinito/rio",
  "kind": "branch",
  "ref": "feature/x",
  "generation": 1,
  "round": 2,
  "previous_head": "<snapshot id>",
  "posted": ["<finding id>", "…"],
  "rounds_to_pass": null
}
```

`round` is the round of the generation's latest finished review (0 before the
first one finishes). The next review gets `round + 1` when that latest review
listed at least one finding (or none has finished yet), otherwise `round`.
It returns HTTP 404 when no lineage exists for the tenant.

## Finding feedback

`POST /v1/findings/{id}/feedback` (scope `reviews:write`):

```json
{ "reason": "intentional", "note": "documented behavior", "actor": "dev@example.com",
  "lineage": { "repository": "…", "kind": "branch", "ref": "feature/x" } }
```

- `reason` is one of `fixed | wrong | intentional | irrelevant | style`;
  anything else is HTTP 400.
- `lineage` is optional; without it the most recent posted finding with that id
  for the tenant is answered. No match is HTTP 404.
- The response is `{ "id", "status": "dismissed", "author_response" }`, where
  `author_response` is `{ reason, actor, at, note? }`. A dismissal never changes
  posture, budgets, rules or suppressions.
- `actor` is optional and defaults to the token's tenant; `note` is at most 4000
  characters. Only posted findings (with `first_posted_in`) can be answered; a
  finding of another tenant is HTTP 404. A later review that reproduces a
  dismissed identity keeps it `dismissed` with its `author_response`.

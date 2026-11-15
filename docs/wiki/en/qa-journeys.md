# Maintain journeys and owner guidance

## Outcome

Keep browser checks connected to real user goals and detect when source changes make journeys stale.

## Prerequisites

A valid QA environment and synthetic seed/fixtures. Authoring starts the isolated app/browser and uses model authentication. Journeys are committed under `.rio/qa/journeys/`.

## Steps

Write `REVIEW.md` in the relevant source directories. Describe who the user is, the goal, expected recovery from errors, accessibility needs and intentional trade-offs. Guidance informs judgments but does not grant tools or override budgets/policies.

A journey describes persona, coverage, preconditions, steps and success. For example:

```yaml
version: 1
name: visit-home
title: Visit the home page
persona: guest
tags: [smoke]
covers:
  paths: ['src/**']
  routes: ['/']
preconditions: []
steps:
  - do: Open the home page
    at: /
    expect: The main navigation is visible
success:
  - The visitor can identify the next action
```

Adapt expectations to your application, then run `rio qa validate` and `rio qa show visit-home`. `rio qa init` explores the seeded app to author journeys; existing ones get `.proposed.yaml` candidates. Review proposals before committing replacements.

## Expected results

`rio qa sync --check` exits 1 when covered source or applicable guidance changes without a journey update. It is read-only. `rio qa sync` re-walks stale journeys and writes validated proposals while preserving committed files/concurrent edits. Incomplete authoring writes no proposals.

Use `after` for dependency chains that share state, such as login → cart → checkout. A chain head can use `resets: true`; combining it with `after` is invalid. A dependent's viewports must be a subset of every prerequisite's. Every chain starts with restored seed and a fresh browser context per cell. Members must resolve to the same `context.time` or all use live time; omitted time inherits fixture defaults.

## Troubleshooting

A dependency-cycle or viewport mismatch is a contract error, not a browser failure. Review both committed journeys and proposed candidates. `--force` permits validated journey replacement during init, but does not overwrite edits made concurrently. `sync --staged`/`--base REF` select the intended comparison.

## Next steps

[Manage fixtures](qa-seeds.md) and [read cell evidence](qa-evidence.md).

<!-- commands:start -->

## Command reference

### `rio qa sync`

| Argument | Meaning | Default / choices |
| --- | --- | --- |
| `--check` | Report stale journey coverage without writing proposals. | `false` |
| `--staged` | Select only the index against HEAD; conflicts with --base. | `false` |
| `--base` | Compare committed HEAD against the merge base with this ref. | `—` |
| `--help` | Show command syntax and supported options. | `—` |

<!-- commands:end -->

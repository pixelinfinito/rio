# Journeys and owner guidance

Journeys live under .rio/qa/journeys and depend on a valid .rio/qa.yaml. Writing/accepting generated proposals changes repository files. Browser authoring requires the isolated QA runtime and model authentication.

## author
Write REVIEW.md with user goals, recovery, accessibility and intentional design choices. `rio qa init` generates journeys from the seeded application using scoped guidance. Existing journeys get .proposed.yaml candidates; --force permits validated replacement but not concurrent edit loss. `rio qa list` distinguishes runnable and proposed journeys. Validate before committing.
Journey contracts define persona, coverage paths/routes, preconditions, steps, success criteria, viewports and dependency chains. `rio qa show checkout` shows the resolved contract. Use the paired schema and sample app rather than inventing step keys.

## chains
`after` dependencies retain predecessor state; a chain head can use `resets: true`. Combining after with resets is invalid. Dependent viewport sets must be subsets of all prerequisites. Each chain gets restored seed/fresh browser context per viewport/color cell. Members must use the same resolved context.time (or all live); missing time inherits fixture defaults, not predecessor values.

## sync
`rio qa sync --check` is read-only reconciliation: exits 1 when covered source or applicable REVIEW.md changed without journey updates. --staged/--base REF selects comparison. `rio qa sync` re-walks stale journeys and writes validated proposed replacements, preserving committed journeys and concurrent edits. Review proposals, update committed journeys deliberately, validate, then rerun --check. Incomplete authoring writes no proposals.

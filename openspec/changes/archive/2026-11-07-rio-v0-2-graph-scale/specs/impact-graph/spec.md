## MODIFIED Requirements

### Requirement: Bounded expansion
From the seed set the graph SHALL expand outward by `hops` (profile option, default 2) following references. References SHALL be found by identifier search across the repository, honoring git ignore rules and excluded paths, and filtered by parse-level scope so that occurrences inside strings and comments are discarded. Import resolution for TypeScript (relative paths and `tsconfig` path mappings) and Python (module paths) SHALL raise an edge's confidence to `resolved`; otherwise edges are `probable`, and references whose target cannot be located are `unresolved`. Expansion SHALL stop when the node cap (`max_nodes`, default 2000) is reached, or when the build's deadline passes, and the slice SHALL then be marked truncated. Every graph build SHALL have a deadline: the review deadline for local reviews, a fixed graph budget when the CLI builds the graph for an endpoint review, and the job's wall limit when a runner builds it. The report SHALL say whether truncation came from the node cap, the deadline or an interruption.

#### Scenario: Two-hop caller
- **WHEN** `a()` is changed, `b()` calls `a()`, and `c()` calls `b()`
- **THEN** with `hops: 2` both `b` and `c` are in the head slice and `c` is at distance 2

#### Scenario: Occurrence in a comment ignored
- **WHEN** the only mention of a changed function name in some file is inside a comment
- **THEN** no edge is created from that file

#### Scenario: Endpoint review graph stops at its deadline
- **WHEN** the CLI builds the graph for an endpoint review and the graph budget runs out before expansion finishes
- **THEN** the review continues with the partial graph, the slice is marked truncated, and the report notes that the impact graph was truncated at its deadline

## ADDED Requirements

### Requirement: Deterministic expansion at repository scale
For a given repository, change, options and version, the graph SHALL be the same regardless of thread count, machine speed or the order in which files are parsed, provided its deadline is not reached. Expansion SHALL find a node's references without rescanning every repository file for each node: its cost SHALL grow with the size of the repository plus the references actually found, not with the number of nodes times the size of the repository.

#### Scenario: Same graph with one or many threads
- **WHEN** the graph for the same change is built with one parsing thread and with many
- **THEN** both builds produce identical base and head slices

#### Scenario: Large repository within budget
- **WHEN** an endpoint review of evaluation case HS-RS-04 (astral-sh/ruff, base `2a959ef3f212`, head `5b475b45aa02`, about 10,000 paths per tree) builds its graph with default options
- **THEN** expansion finishes before the endpoint graph budget runs out (stopping at the node cap is allowed, stopping at the deadline is not), and the runner's `graph` job for the same snapshot completes within its wall limit

## Why

Building the impact graph does not finish on large repositories. The live review of evaluation case HS-RS-04 (astral-sh/ruff, about 10,000 paths per tree and 72 MiB of distinct content) was still building the graph locally after 30 minutes and again after 2 hours, before uploading anything. Reaching ruff-sized repositories was the point of `rio-v0-2-large-snapshots` and of the v0.2 acceptance measurement, so this blocks task 5.2 of that change and task 1.1 of `rio-v0-2-review-convergence`.

The cost is in reference expansion (`crates/rio-graph/src/build.rs`). Each queued graph node (up to `max_nodes`, default 2,000):
- scans the full text of every candidate file for the node's name and its module's file stem (for example `args`, which appears in nearly every Rust file);
- for each matching file, walks every identifier occurrence in the file again;
- parses newly matched files one at a time.

Ignore rules are also rebuilt from every `.gitignore` for each candidate path. In addition, endpoint mode (`rio review` with an endpoint) and the runner container's `graph` and `static` jobs build the graph with no deadline at all.

## What Changes

- **Index once per version.** Each version's searchable files get one identifier index (name → files), built from the text once. Each parsed file gets one identifier index (name → occurrences). A queued node then looks up only the files and occurrences that can reference it, instead of rescanning everything.
- **Parse in parallel.** Files that a hop needs are parsed in parallel and then processed in a fixed order, so the graph is identical whatever the thread count or timing.
- **Ignore rules compiled once per tree** instead of once per candidate path.
- **Every graph build has a deadline.** Endpoint mode and the runner's `graph` and `static` jobs now stop at a deadline like local reviews already do. The slice is marked truncated, and the report says the graph was cut at its deadline.
- **Same output.** For a given repository, change and options, the graph is identical to today's whenever the deadline is not reached. The existing graph tests stay unchanged.
- **Measured on ruff.** A local measurement command reports graph build time and work counts for any repository and base/head pair. The ruff case must build its graph without reaching the deadline, on the development machine and in the runner container. Stopping at the node cap is still allowed.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `impact-graph`: "Bounded expansion" gains a deadline that applies to every graph build and records why a slice was truncated. A new requirement covers deterministic output, repository-scale cost, and the ruff acceptance case.

## Impact

- **Code**:
  - `crates/rio-graph/src/build.rs`: expansion, indexes, parallel parsing, ignore matching.
  - `crates/rio-adapters/src/syntax.rs`: `SyntaxCache` usage and any per-file identifier index.
  - `crates/rio-cli/src/endpoint.rs` and `crates/rio-runner/src/main.rs`: call the graph builder with a deadline and record truncation.
  - `crates/rio-engine/src/execute.rs`: shares the truncation note.
- **Dependencies**: a thread pool for parsing, either the workspace's existing Tokio/Rayon or scoped `std::thread`. No new external service.
- **Profiles and reports**: no schema change. Truncation uses the existing `impact.truncated` flag and footer notes.
- **Unblocks**: task 5.2 of `rio-v0-2-large-snapshots` and task 1.1 of `rio-v0-2-review-convergence`.

## Context

`GraphBuilder::slice` (`crates/rio-graph/src/build.rs`) seeds nodes from the changed hunks, then expands breadth-first. For each queued node it:
- builds an Aho-Corasick searcher for the node's name and its file stem (`module`);
- runs it over the full content of every candidate file;
- parses each newly matching file through `SyntaxCache::analyze`, single-threaded and cached by path and content hash;
- walks every identifier occurrence in each matching file to find names equal to the target or to an import alias.

The candidate list is built once per slice, but `ignored()` rebuilds a gitignore matcher from every `.gitignore` in the tree for each candidate path.

The cost is therefore roughly nodes × repository bytes for text scanning, plus nodes × matching files × identifiers for the occurrence walks. With `max_nodes` 2,000 and a module stem such as `args`, the ruff case touches nearly every file thousands of times.

There are three callers:
- `rio-engine` (local reviews) passes a deadline through `build_until`.
- `rio-cli` endpoint mode calls `build` with no deadline.
- `rio-runner inside` (`graph` and `static` jobs, 2 vCPU, 120 s wall limit) also calls `build` with no deadline.

## Goals / Non-Goals

**Goals:**
- Expansion cost of order repository size plus references found; the ruff case well inside 120 s on 2 cores.
- Byte-for-byte identical slices to today's builder when not truncated, independent of thread count.
- A deadline on every caller, with the truncation reason reported.

**Non-Goals:**
- Changing reference semantics, confidence rules, `hops`/`max_nodes` defaults, or the profile schema.
- Caching graphs or indexes across runs.
- Language-server resolution.

## Decisions

### D1. Per-version token index replaces per-node text scans
Once per slice, every candidate file's content is split into identifier-like tokens (maximal runs of ASCII alphanumerics, `_` and `$`, plus non-ASCII letters). The result is an index from token to the sorted list of candidate files containing it.

To find a node's candidate files, the builder looks for every vocabulary token that contains the node's `name` or `module` as a substring, using one Aho-Corasick pass over the vocabulary. It then unions those tokens' file lists. This is exactly today's substring test whenever the term is itself a single token. When a term contains characters that end a token (for example a stem like `my-mod`), that term falls back to today's full-content scan, so the output stays identical.

Alternative rejected: exact-token matching only. It is faster, but drops today's substring matches and so changes edges.

### D2. Per-file occurrence index
Each parsed file's identifiers are grouped by name once, and the file's resolved imports are cached as today. For a target, the builder visits only the occurrences whose name is in the target's `names` set, in their original source order. This keeps edge and node insertion order identical to today's full walk.

### D3. Parallel parsing, sequential processing
When a node's candidate files include files not yet parsed, those files are parsed together in parallel: scoped `std::thread`, up to `available_parallelism`, through the existing `SyntaxCache`. Expansion then proceeds exactly as before, in queue order and path order. Parse results are pure functions of path and content, so thread count cannot change the slice. Rayon is not added: the workspace does not use it, and scoped threads are enough here.

### D4. Ignore rules compiled once
The tree's `.gitignore` files are compiled into matchers once per slice and applied to each path in parent-to-child order. This preserves today's last-match semantics.

### D5. Deadlines for every caller and a reported reason
- **Endpoint mode:** `rio-cli` uses `build_until` with a 120 s graph budget.
- **Runner:** `rio-runner inside` uses the job's `limits.wall_ms` minus a margin for the rest of the job: 15 s, or a quarter of a shorter limit, so a job near its review's deadline still builds part of a graph. The header carries `limits`.
- **Notes:** the `rio-engine` truncation notes are shared, so all three callers report "truncated at max_nodes", "truncated at the review deadline" (or "at its deadline") or "after interruption".

A deadline that is reached marks the slice truncated and the review continues; it never fails the review. The budget is a constant, not a profile option, so the profile schema is unchanged.

### D7. Rust module maps resolved once per crate
Measured in task 1.1: the dominant cost on Rust repositories is `resolve_rust`. Each `use` import it resolves re-parses the crate's whole module tree, starting at `lib.rs`. To find a dependency's crate, it also re-reads and re-parses every `Cargo.toml` in the tree.

A per-slice resolver now caches three things:
- parsed manifests by path;
- the list of crate names in tree order, so the first match is the same as today's `find_map`;
- each crate entry file's module map, including today's "no map" outcome when a module file is missing or fails to parse.

Resolution results are therefore identical to today's, and each crate is parsed once per slice. The public `resolve_import` keeps its signature by using a fresh resolver.

### D6. Measurement and equivalence harness
A `graph-bench` example in `rio-graph` takes a git repository, base and head. It prints build time, files parsed, bytes parsed, nodes, edges and truncation. It can also build with one thread and with N threads and compare the serialized slices.

The equivalence tests compare the new builder against the current implementation on the existing graph fixtures and a generated many-file repository. The current implementation is kept test-only, as `legacy_slice`, until this change is archived.

## Risks / Trade-offs

- **The ruff case may still truncate on 2 vCPU if parsing dominates.** Mitigation: the bench measures parse time separately. If it does not fit, the fallback is to raise the runner job's wall limit for `graph` jobs, which is within Sandbox limits. Changing semantics is not a fallback.
- **Memory for the token index (~72 MiB of source).** The vocabulary is shared, and each file list stores small integer file ids. The estimate is tens of MiB, acceptable for the CLI and the 2 GiB or 8 GiB runners.
- **Exact equivalence is subtle (substring rule, alias names, ordering).** Mitigation: the legacy-comparison tests in D6 cover fixtures plus a randomized many-file repository.

## Migration Plan

This is a pure implementation change with no data or protocol migration. Ship the CLI and runner image together through the usual `rio deploy` with a rebuilt runner image. To roll back, redeploy the previous release.

## Why

Hosted reviews upload the complete base and head trees as one JSON document, and the endpoint rejects anything over 32 MiB of content or 100,000 files; every Worker step, Durable Object and runner then holds the whole snapshot in memory (128 MB in Workers and Durable Objects). Ordinary repositories already exceed this: 8 of the 24 approved v0.2 verifier evaluation cases cannot be reviewed (fastapi 54.6 MiB, astro 107 MiB, cargo about 32.5 MiB, uv 46 MiB and ruff 144.5 MiB for base plus head), including every Rust positive control. This blocks the v0.2 acceptance measurement (task 1.1 of `rio-v0-2-review-convergence`) and makes hosted review unusable on mid-sized repositories.

## What Changes

- **Content-addressed, packed snapshots.** The CLI stores each distinct file content once (deduplicated across base and head, and across reviews of the same tenant) in packs of bounded size uploaded in separate requests, and then registers a snapshot manifest that maps every path in both trees to its content. Only contents the endpoint does not already hold are uploaded.
- **Streaming everywhere on the endpoint.** Agent and verifier tools, triage, quorum evidence checks, guidance validation and graph validation read individual files on demand instead of loading the whole snapshot. Literal search streams through the packs within the existing output limit.
- **Runner archives.** Runner jobs no longer embed snapshots. The Cloudflare Container receives the selected trees as a streamed archive; the self-hosted runner downloads the same archive with its job capability. Neither the Worker nor the Durable Object buffers a whole tree.
- **New limits.** A snapshot pair may hold up to 1 GiB of distinct content and 300,000 paths per tree, with individual files up to 64 MiB. The CLI checks these before uploading and names the limit that was exceeded.
- **BREAKING (endpoint protocol, pre-release):** `POST /v1/snapshots` with inline trees is replaced by the pack upload and manifest registration endpoints; the CLI and Worker ship together, and no released client uses the old form. Runner job payloads change shape accordingly.
- Snapshot content and packs are tenant-scoped and remain subject to the existing tenant isolation and R2 lifecycle.

## Capabilities

### New Capabilities
- `hosted-snapshots`: how a hosted review's base and head trees are uploaded, deduplicated, stored, bounded and read by endpoint steps, tools and runners.

### Modified Capabilities
None. Agent tool semantics (`verifier-quorum` "Repository-wide tools"), review reports and the local change snapshot (`change-snapshot`) are unchanged; only the transport and storage of hosted snapshots change.

## Impact

- **Code**: `crates/rio-client` (packing, missing-content negotiation, batched uploads, limits), `crates/rio-cli/src/endpoint.rs`, `crates/rio-runner` (archive download and extraction), `worker/src` (`index.ts` upload endpoints, a snapshot reader replacing in-memory `Snapshot` use in `workflow.ts`, `tools.ts`, `triage.ts`, `quorum.ts`, `verifier.ts`, `jobs.ts`, `sandbox.ts`, `validation.ts`), `worker/runner/execute.py` (archive input).
- **Storage**: R2 objects `snapshots/<tenant>/packs/<pack>` and `snapshots/<tenant>/manifests/<id>`; D1 table for content-to-pack locations per tenant (migration `0003`).
- **APIs**: new pack negotiation/upload and manifest registration endpoints; runner archive endpoint; job payload shape. Documented in `docs/cloudflare.md`.
- **Unblocks**: task 1.1 of `rio-v0-2-review-convergence` with the approved case set unchanged.

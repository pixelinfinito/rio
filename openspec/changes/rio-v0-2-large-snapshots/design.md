## Context

Today `crates/rio-client` sends `{"base": tree, "head": tree}` (text inline, binaries base64) to `POST /v1/snapshots`. `worker/src/index.ts` reads up to 40 MiB, `validateSnapshot` caps content at 32 MiB and 100,000 files, and the whole document is stored as one R2 object. Every consumer then materializes it: `workflow.ts` loads it once per run and passes the `Snapshot` object to `triage`, `changedCode`, `Tools` (`read_file` and `search` index into it), `verifyHypothesis` and quorum evidence checks; `createJob` copies the job's tree plus the full `{profile, snapshot}` context into every job payload in R2; the `Sandbox` Durable Object `JSON.stringify`s the payload into the container's stdin; `execute.py` writes the tree and pipes the context JSON to `rio-runner inside`, which deserializes both trees; the self-hosted runner reads that JSON with an 80 MiB cap. Workers and Durable Objects have 128 MB of memory, so raising the numeric limits alone cannot work.

Constraints: one deployment per user account, D1 + R2 + Workflows + Containers already provisioned; Workers subrequest and CPU limits per step invocation; no released client depends on the inline protocol.

## Goals / Non-Goals

**Goals:**
- Review repositories with up to 1 GiB of distinct content and 300,000 paths per tree, with bounded memory in every Worker step and the Durable Object.
- Upload each distinct content once per tenant, so lineage re-reviews send only new contents.
- Keep agent tool results, report contents and review semantics identical.

**Non-Goals:**
- Shallow or partial snapshots (uploading only changed or graph-reachable files): remote checks and reproductions need the whole repository.
- Retention or garbage collection of stored contents; R2/D1 have no lifecycle today and this change does not add one.
- Compression on the wire beyond what HTTP already does.

## Decisions

### D1. Contents and packs

A content is identified by `blake3(bytes)` (hex). The CLI groups contents the tenant lacks into packs of at most 8 MiB; a content larger than 8 MiB (up to the 64 MiB file limit) is sent alone in a sequence of 8 MiB parts and assembled with an R2 multipart upload. A pack request is `PUT /v1/packs` whose body is a 4-byte big-endian index length, the index JSON `[{hash, size}]` (at most 2,000 entries) and the concatenated bytes; the index travels in the body because a header cannot carry thousands of entries. The Worker verifies every hash and size before writing the pack to `snapshots/<tenant>/packs/<pack-hash>` and recording each content's `(pack, offset, size)` in D1 `contents(tenant, hash, pack, offset, size)` (migration `0003`). Negotiation is `POST /v1/contents/missing` with at most 10,000 hashes per request. Alternatives: one R2 object per content (ruff would be ~20,000 PUTs and as many reads for search, past subrequest limits); tar/zstd archives per snapshot (no cross-review deduplication, and reads need an index anyway).

### D2. Chunked manifests

A manifest lists `(version, path, hash, mode, size)` sorted by version then path, as NDJSON. The CLI uploads it in chunks of at most 8 MiB to `PUT /v1/manifests/<id>/chunks/<n>` and seals it with `POST /v1/manifests/<id>/seal`, where `<id>` is `blake3` of the canonical NDJSON. Sealing streams the chunks once: it recomputes the id, checks every hash exists for the tenant in `contents` (batched `IN` queries), checks limits and path rules, and writes a small index object (the first path of each chunk, entry counts, totals). Re-sealing an existing id is a no-op, so identical snapshots cost nothing. The returned snapshot id is what `POST /v1/reviews` references, unchanged in shape. Alternative: rows per path in D1 (600,000 inserts per review for a large repository).

### D3. Snapshot reader

`worker/src/snapshot.ts` provides `SnapshotReader` with `stat(version, path)`, `read(version, path)` (one manifest-chunk lookup through the index, one ranged R2 GET on the pack), `list(version)` (streams manifest chunks) and `scan(version, visit)` (streams entries grouped by pack, reading each needed pack once with ranged GETs, skipping binary and symlink entries). A per-step LRU caches decoded files up to 16 MiB. `workflow.ts`, `tools.ts`, `triage.ts`, `verifier.ts`, `quorum.ts` and `index.ts` (guidance and graph validation) switch from `Snapshot` to the reader; synchronous evidence checks receive a precomputed `stat` map for the paths they cite. `search` keeps its pattern rules and the existing 24,000-character output limit and stops scanning as soon as that limit is reached.

### D4. Job archives

Job payloads carry `{snapshot_id, version, needs: ["base","head"]?}` instead of trees. The archive is a POSIX tar stream with entries `base/<path>` and `head/<path>` for the trees a job needs, regular files only, with modes `0644`/`0755`; it is produced by streaming manifest chunks and pack ranges, never buffering a tree. The `Sandbox` Durable Object writes one JSON header line (the job without snapshot) and then the archive to the container's stdin. `execute.py` reads the header, extracts the tar with `tarfile` in stream mode into a temporary directory (rejecting links, absolute or `..` paths and non-regular members), runs `run` jobs in the job's version tree, and passes `--base DIR --head DIR` to `rio-runner inside`, which reads trees from directories instead of JSON. The self-hosted runner downloads the same archive from `GET /v1/runner/:review/:job/:attempt/archive` authorized by the job capability, and pipes header plus archive into Docker stdin. Alternative: let containers fetch from R2 directly (needs network or bindings inside an isolated, offline container).

### D5. Limits and errors

Shared constants: 300,000 paths per tree, 64 MiB per file, 1 GiB distinct content per snapshot pair, 8 MiB per request body. The CLI computes them before any upload and fails with the limit, the measured value and, for the file limit, the path. The Worker enforces the same at pack upload and seal. Upload requests retry idempotently (packs and chunks are content-addressed).

### D6. Protocol transition

The inline `POST /v1/snapshots` is removed in the same release; CLI and Worker ship together and no released client uses it. `docs/cloudflare.md` documents the new endpoints. Existing stored snapshots from earlier test deployments are not migrated; a review always references a snapshot registered by the same CLI version.

## Risks / Trade-offs

- [Search over a 1 GiB snapshot is slow or exceeds per-step CPU] → `scan` reads each pack once, stops at the output limit, and runs inside the tool's step; a step that still exceeds its budget fails the tool call, not the review, as tool errors already do.
- [Many small R2 range reads for `read_file` bursts] → per-step LRU and pack-grouped `scan`; ranged GETs stay within subrequest limits for normal tool budgets.
- [Upload time for a first large review] → contents are deduplicated across base/head and across reviews; packs upload in parallel (four at a time) with retries.
- [Unbounded storage growth without retention] → recorded as a known gap; a later change adds lifecycle and reference counting.
- [Stream extraction safety in the container] → only regular files under `base/` or `head/` with validated relative paths are written; anything else aborts the job as an executor failure.

## Migration Plan

Deploy Worker (with migration `0003` adding `contents`) and CLI together with `rio deploy`; rebuild the runner image for the new `execute.py` and `rio-runner inside`. Rollback is redeploying the previous release; reviews submitted by a mismatched CLI fail at upload with a protocol error.

## Open Questions

None.

# Tasks

## 1. Storage and upload endpoints

- [x] 1.1 Add Worker migration `0003_snapshot_contents.sql` with `contents(tenant, hash, pack, offset, size)` (primary key tenant+hash) and shared limit constants (300,000 paths per tree, 64 MiB per file, 1 GiB distinct content, 8 MiB per request). Verify `migrate.test.ts` applies it on fresh and upgraded databases.
- [x] 1.2 Implement `POST /v1/contents/missing` (at most 10,000 hashes, tenant-scoped) and `PUT /v1/packs` (8 MiB body with a length-prefixed index, every hash and size verified before the pack is written and indexed; idempotent re-upload), plus multipart assembly for contents over 8 MiB. Verify API tests for deduplication, a tampered pack, an oversized body, a cross-tenant hash reported missing, and a 20 MiB content uploaded in parts.
- [x] 1.3 Implement chunked manifests: `PUT /v1/manifests/<id>/chunks/<n>` and `POST /v1/manifests/<id>/seal` (recompute id, check path rules, modes, limits and that every hash exists for the tenant, write the chunk index; re-seal is a no-op), and remove the inline `POST /v1/snapshots`. Verify API tests for a valid seal, a wrong id, a missing content, a path traversal, each limit and idempotent re-seal.

## 2. On-demand reads in the Worker

- [x] 2.1 Add `worker/src/snapshot.ts` (`SnapshotReader`: `stat`, `read`, `list`, `scan` with pack-grouped ranged reads and a 16 MiB per-step LRU). Verify unit tests for reads across chunk boundaries, binary and symlink entries, missing paths, and that `scan` reads each pack at most once.
- [x] 2.2 Switch `workflow.ts`, `tools.ts` (`read_file`, `search` with early stop at the output limit), `triage.ts`, `verifier.ts`, `quorum.ts` (precomputed `stat` map) and `index.ts` (guidance and graph validation) to the reader. Verify the existing Worker suite passes unchanged in expectations, and a tools test on a generated 150 MiB snapshot returns the same `read_file`/`search` results as on a small one within the output limit.

## 3. Runner archives

- [x] 3.1 Replace embedded trees in job payloads with `{snapshot_id, version, needs}` and stream a POSIX tar (`base/…`, `head/…`, regular files, exact modes) from the reader; the `Sandbox` Durable Object writes the JSON header line then the archive to the container stdin. Verify a Worker test that the streamed archive reproduces a snapshot byte for byte and mode for mode, and that no job payload contains file contents.
- [x] 3.2 Add `GET /v1/runner/:review/:job/:attempt/archive` authorized by the job capability. Verify API tests for a valid capability, a missing one and another job's capability.
- [ ] 3.3 Update `worker/runner/execute.py` to read the header line and stream-extract the archive with strict member checks (regular files under `base/` or `head/`, safe relative paths), and `rio-runner inside` to take `--base DIR --head DIR`; update the self-hosted runner to download the archive and pipe header plus archive into Docker. Verify executor tests for extraction, rejected link/absolute/`..`/device members, and `RIO_TEST_DOCKER=1` runner tests with the rebuilt image.

## 4. CLI upload

- [ ] 4.1 In `rio-client`, hash contents, deduplicate across trees, check the limits before any upload (naming limit, value and, for files, the path), negotiate missing contents, upload packs (four in parallel, idempotent retries) and large contents in parts, upload manifest chunks and seal; `rio-cli` uses it for endpoint reviews. Verify unit tests for packing, limits, retries and manifest id stability, and the CLI mock-endpoint tests updated to the new protocol.
- [ ] 4.2 Document the snapshot protocol, limits and deduplication in `docs/cloudflare.md` and `docs/convergence-contracts.md` where it references snapshot ids. Verify the documented endpoints match the API tests.

## 5. Integration

- [ ] 5.1 Run the full local suites (`cargo fmt --all --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings`, `cargo test --workspace --locked`, Worker `npm run check` and `npx vitest run`, `python3 -m unittest discover -s eval/tests`, `RIO_TEST_DOCKER=1` runner tests), redeploy with `rio deploy` and the rebuilt runner image, and push so hosted CI runs. Verify all pass, including the Linux/macOS/Windows matrix.
- [ ] 5.2 Live check on the deployed endpoint with the largest approved evaluation case (HS-RS-04, astral-sh/ruff, 144.5 MiB base+head) and one Python case: the review completes with checks executed in the container, and a second review of the same repository uploads only new contents. Verify by the review reports, the upload byte counts printed by the CLI, and that the eight previously oversized cases now pass the CLI limit check.

## Workflow follow-up

- Resume task 1.1 of `rio-v0-2-review-convergence` with the approved case set unchanged once this change is applied.
- Archive this change after its tasks are complete.

# AACR-Bench runtime limits: root causes and fix proposal

Status: implemented (2026-11-11), see section 7. The paused run
`aacr-bench-final-20261111` (source CLI 0cf005f, runner 0.3.5) is the evidence; it
stays untouched and must not be resumed. Line numbers in sections 1–2 refer to
`main` at 0cf005f.

## 1. What failed

14 terminal attempts before the stop: 1 failed, 7 partial, 6 incomplete. Every
partial or failed case maps to one of five distinct causes. Incomplete cases come
from policy and environment, not from limits (section 1.6).

| Cause | Cases | Kind of limit |
|---|---|---|
| A. Worker CPU in `cache-lookup` | vllm@134705b, vllm@075f1b5 | Rio code cost; Workers CPU cap is configurable (30 s set, 5 min max) |
| B. Runner job never returns in time → `WorkflowTimeoutError ... 240000ms` | elastic@a6a4623, @e38d20c, @5e604e4, FreeCAD@82fef4a; elastic@2adcb2d (executor failure) | Rio's own caps (120 s job, 240 s wait), retries of deterministic failures |
| C. Worker memory (128 MiB isolate) on workflow replay | lvgl@4a57db3 | Provider hard limit; Rio's replay state is too large |
| D. Orphaned review: status never becomes terminal, and the CLI gives up on one reset | lvgl@4a57db3 | Rio has no reconciliation, sweeper or poll retry |
| E. Local CLI graph build ignores its deadline and uses every core | FreeCAD@82fef4a, @ec3da2e | Rio code |

### 1.1 A. CPU limit in `cache-lookup-agents-correctness-1`

Evidence: `cases/vllm-project__vllm@134705b/cloudflare-workflow-instance.json`. All six
attempts ended in `Worker exceeded CPU time limit.` after 46–50 s of wall time each,
spread over 15 minutes of backoff. vllm@075f1b5 shows the same pattern (6 attempts,
537 s). The report then carried zero model calls.

Measured reproduction (`eval/diagnostics/cache-lookup.ts`): it runs the Worker's own
`changeHunks` + `context()` on the pinned trees. The staged tree for 134705b is
`d3d51c58`, verified. The graphs are the real graph-job artifacts fetched read-only
from R2. D1/R2 I/O is excluded. Run on this VM's Xeon (Skylake), node 26:

| Case | Hunks | Current CPU | Text decoded | With memo | Keys identical |
|---|---|---|---|---|---|
| vllm@134705b | 402 | 14.4 s | 750 MB from a 25 MB snapshot | 1.7 s | yes |
| vllm@075f1b5 | 1,347 | 29.4 s | 1,347 MB | 3.0 s | yes |

The 30 s cap also covers the code replayed before the step in the same invocation:
loading the submission and graphs, `materialize`, and triage. So 075f1b5 is over the
limit even on this core. CPU profile of the current code:

- About 55% goes to `@noble/hashes` BLAKE3 in pure JS (`validation.ts:108`, 22.5 MiB/s
  measured; native `crypto.subtle` SHA-256 does 132 MiB/s). It re-hashes the same
  symbol bodies once per hunk (`cache.ts:184`).
- 16% is garbage collection.
- About 13% is re-decoding and re-splitting whole files per hunk (`cache.ts:176`; the
  `texts` map is per call).
- Only about 5% is the edge scan.

The snapshot LRU did not thrash (about 1,280 misses), so R2 refetches are not the cause.

Second defect, at `cache.ts:169-172`: the "one-hop neighbours" loop adds to `ids`
while it iterates the edge list, so expansion chains transitively depending on edge
order. On 134705b the neighbourhood is p90 982 nodes, against p90 5 for a true one-hop
set; the total is 105,047 against 13,619. That inflates CPU and makes cache keys depend
on distant symbols, which lowers the hit rate. The graphs have hub nodes of ~1,000
edges and are truncated at `max_nodes: 2000`.

Retry waste: the step uses the default retries (5, exponential), and a CPU overrun is
deterministic. The step also fails closed: the cache only saves model calls, but its
failure made the whole agents step partial.

### 1.2 B. Runner jobs exceed the workflow's 240 s wait

Evidence: D1 `jobs` rows (read-only), R2 job results and instance histories. Every
`wait-*` step that timed out did so at exactly 240.0 s (`workflow.ts:477`,
`Math.min(240, remaining)`). The jobs themselves completed 215–448 s after creation.
The last delivery of each failing job ran about 137 s, which is the Durable Object's
`AbortSignal.timeout(wall_ms + 15000)` (`sandbox.ts:46`). Its result is
`runner_failed: sandbox executor failed:` with empty stderr. Before that, 1–2 earlier
deliveries failed the same way (created → last lease 150–310 s).

Chain of cause:

1. Analysis jobs (`checks`, `graph`) stream **both full trees** as a tar through the
   Durable Object into the container's stdin (`archive.ts:80`, `execute.py:89`). Elastic
   is 64k files, 322 MiB distinct, so the tar is roughly 600 MB.
2. The 120 s job wall (`jobs.ts:40`, `sandbox.ts:24`, `execute.py:74`) is a Rio choice.
   The executor starts its deadline only after extraction (`execute.py:114`), but the
   Durable Object's abort covers transfer + extract + run.
3. The abort kills the executor and is reported as an executor failure, not as
   `timed_out`. The queue then redelivers a deterministic failure (`max_retries: 2`,
   `deployment.rs:1866`; 10 s delay, `index.ts:1059`). After that the workflow's own
   `RUNNER_ATTEMPTS = 2` (`workflow.ts:290`) dispatches it again.
4. The 240 s wait is shorter than one delivery plus one retry. Its timeout throws
   (`WorkflowTimeoutError`) and the review becomes partial, although the CLI already
   submitted a usable graph (`submission.graphs`). A failed `checks`/`graph` job also
   throws (`workflow.ts:1149`).
5. "Network connection lost." (a6a4623, 2adcb2d) is the Durable Object losing its
   container connection mid-job. With concurrency 2 × (checks + graph) plus
   redeliveries, Rio's `max_instances: 5` (`deployment.rs:2185`) is close to saturated.
   This is plausible, not proven.

### 1.3 C. Memory limit on workflow replay (lvgl@4a57db3)

The instance `errored` at 11:59:16 with `WorkflowFatalError: ... repeatedly exceeded
CPU or memory limits outside of a step`, after a verifier model step failed with
`Worker exceeded memory limit.`. Each replay rebuilds, **outside any step**:

- `materialize` of every changed file, base and head (`workflow.ts:332-341`). For lvgl
  that is 336 files, 26.7 MB base and 11.6 MB head. It includes a 16.4 MB `.otf`, which
  `fileOf` base64-encodes (about 22 MB string plus transient copies).
- The submission, both graphs, and `structuredClone(report)`.
- Every prior model response, because `call()` fetches it from R2 after the step
  (`workflow.ts:407`).
- The snapshot LRUs (16 + 4 MiB).
- Concurrent verifier conversations on top of all of that.

128 MiB per isolate is a hard platform limit. The exact peak consumer was not isolated
here; a diagnostic is proposed in section 3.

### 1.4 D. Orphaned review and CLI transport

- The fatal error skips the `failed` step, so D1 stayed `running` at 12:25, 26 minutes
  after the instance died and past the 25-minute budget.
- `GET /v1/reviews/:id` returns the D1 row only (`index.ts:370-373`).
- `scheduled()` only expires QA evidence (`index.ts:979-981`).
- The review deadline is enforced cooperatively inside steps only.
- CLI: in `wait_observed`, a single failed status GET (`rio-client/src/lib.rs:197`, `?`)
  aborts the wait. There is no retry, and the remote review is not cancelled. Polling
  is 2 requests/s (status + events) for up to 45 minutes. The upload path already has
  `send_retrying` (`snapshot.rs:280`); polling does not use it.

### 1.5 E. Local graph construction

`GraphBuilder::slice` checks `stop()` per queue item and per file. It does not check
it during `TokenIndex::new` over every candidate file (`build.rs:302`), or during
`prefetch` (`build.rs:329`, `449-471`). `prefetch` parses every matching file on
`available_parallelism()` threads (20 here). Short names match nearly every C++ file,
so one prefetch can run for minutes past the 120 s `GRAPH_BUDGET` (`endpoint.rs:12`).
The runner then rebuilds the graph anyway.

### 1.6 Incomplete (not a limit)

Most incomplete cases come from `dependencies: offline` (no egress to `api.osv.dev`)
and `dependency_mismatch` (no lockfile with `trust_installed_dependencies: false`).
Some add `no_project_config` or `tool_missing`. These are profile and egress policy.
The Sandbox supports per-host allowlists, so OSV can be enabled deliberately.

## 2. Limits: hard versus configurable

| Limit | Value | Who sets it |
|---|---|---|
| Workers/Workflows CPU per invocation/step | 30 s default, **5 min max** | Configurable to 300,000 ms; Rio hardcodes 30,000 at `deployment.rs:922` |
| Worker isolate memory | **128 MiB** | Hard |
| Subrequests per invocation | 10,000 default (paid, raisable) | Configurable; per-hunk D1/R2 calls in `lookup()` scale toward it |
| Simultaneous outgoing connections | **6** | Hard |
| Workflow step result | **1 MiB** | Hard (Rio already returns R2 keys) |
| Steps per workflow | 10,000 default, 25,000 max | Configurable |
| Workflow step wall time, container run time | No documented limit | — |
| Container instance size | up to standard-4 (4 vCPU, 12 GiB, 20 GB disk) | Rio uses standard-3 |
| Container count | `max_instances: 5` | Rio's choice |
| Job wall 120 s, wait 240 s, lease 180 s, 3 deliveries, 2 runner attempts, local graph 120 s | — | All Rio's choices |

## 3. Proposal

The principle: every unit of work is bounded by construction (chunked or streamed),
not by a hopeful timeout. Optional work (the cache) fails open. A failed analysis
phase degrades that phase only and records it as incomplete. Deadlines and terminal
status are enforced by the endpoint, not by the client.

### P1. Cache lookup: cheap, bounded, fail-open (Worker)

1. **Included in this branch:** `ContextMemo` (`cache.ts`). It hashes each file and
   symbol once per change and indexes nodes by path. Keys are byte-identical
   (verified on both vllm cases and by the new test in `tests/cache.test.ts`).
   Measured 8–10× less CPU.
2. **Included:** the lookup step is fail-open, with `retries: { limit: 1 }` and
   `timeout: "5 minutes"`. On failure the agent runs uncached and the footer says why
   (`workflow.ts`).
3. Next, with a cache-key version bump (old entries simply miss):
   - Make the neighbourhood a true one hop using a prebuilt adjacency map. This is
     7.7× fewer key parts.
   - Hash key material with native `crypto.subtle` SHA-256 instead of pure-JS BLAKE3,
     and only for the cache key.
4. Chunk the lookup into deterministic steps of at most 250 hunks
   (`cache-lookup-<step>-<agent>-<n>`). Each chunk writes its keys to R2. Then
   `lookup()` uses `DB.batch` of `IN (...)` queries instead of one sequential query per
   hunk. That also cuts the 74 s and 205 s wall times seen in lvgl's lookup and store
   steps, and keeps subrequests flat. `cache-store` gets the same batching.
5. Raise `cpu_ms` to 300,000 in `deployment.rs:922` as headroom, not as the fix.

### P2. Runner jobs: size-aware, honest timeouts, graceful degradation (Worker + runner image)

1. Derive the job wall from the review: `min(remaining budget − reserve, per-kind cap)`,
   not a fixed 120 s. Give transfer its own budget, proportional to the input bytes
   that `jobInput` already knows, so the Durable Object abort is
   `transfer + wall + grace`. The runner's `build_until` deadline is the job wall minus
   a reserve, so a large repository yields a truncated graph, not a killed job.
2. Report an abort as `timed_out` with a phase (`transfer | extract | command`).
   Redeliver only infrastructure errors (container start, lost connection), with
   jitter; never a timeout. `RUNNER_ATTEMPTS` retries only `runner_failed` causes that
   are marked transient.
3. The wait timeout comes from the dispatched job (`wall + transfer + queue slack`,
   capped by the remaining budget), as QA already does (`workflow.ts:1009`). On a wait
   timeout or a failed analysis job, mark the job `abandoned` in D1 so a late result
   is ignored. Add `incomplete: [{kind: "graph"|"checks", reason: "timed_out"}]` and
   continue: agents use `submission.graphs` from the CLI. Do not throw.
4. Stop shipping both full trees per job. Use one container per review (named by
   review, not by job), kept for its checks/graph/run jobs. It pulls packs directly
   from R2 through an outbound handler with ranged, parallel reads, and materializes
   each version once. A graph job only needs language files. This removes the 600 MB
   stdin pipe, which is the dominant cost on Elasticsearch.
5. Container sizing: standard-4 for analysis jobs, and `max_instances` set to at least
   reviews × 2 + 2 for the benchmark concurrency. These are configuration choices with
   linear cost (see section 5).

### P3. Replay state below 128 MiB (Worker)

1. Run triage inside a step that returns the plan. Keep `changedFiles` lazy, text
   files only and size-capped. Never base64 binaries for triage.
2. `call()` returns the R2 key; callers load a model response only when they consume
   it, and drop it afterwards.
3. Load graphs once into a compact form, or read them from R2 inside the steps that
   need them.
4. Bound verifier fan-out by memory as well as by quorum.
5. Diagnostic before landing: in a `vitest-pool-workers` test, replay the lvgl
   submission and log `performance.measureUserAgentSpecificMemory` (or the workerd
   heap stats) per phase.

### P4. Terminal status, deadline and orphan recovery (Worker + CLI)

1. When the status endpoint sees a `running` row, it asks `env.REVIEWS.get(id).status()`.
   For `errored` or `terminated` it finalises the row as `error` with the instance's
   error name, and keeps any partial report.
2. Add a cron sweeper (every minute) for reviews past `deadline + 2 min`. It terminates
   the workflow instance, marks pending jobs `abandoned`, writes a partial report with
   `reason: deadline`, and emits `review:partial`. The deadline becomes hard.
3. CLI `wait_observed`:
   - Retry status, report and event GETs on transient errors with capped backoff
     (reuse `retryable`/`send_retrying`).
   - Poll status every 2–5 s.
   - Give up only at its own deadline, and then cancel the remote review best-effort.

### P5. Local graph (CLI)

1. Pass `stop` into `prefetch` and into `TokenIndex::new`, checking per file.
2. Cap threads with `RIO_GRAPH_THREADS`, defaulting to `min(4, cores)`. The benchmark
   sets `concurrency × threads ≤ cores`.
3. When submitting to an endpoint that rebuilds the graph, use a short local budget
   (for example 30 s), since the CLI graph is only a fallback.

### P6. Scoring and reporting

- The adapter currently writes `results/<case>.json` for partial reports
  (`adapter.py`, status in `{complete, incomplete, partial}`). Infrastructure partials
  with 0 comments are therefore scored as real reviews.
- Add `infra_failure: cpu_limit | memory_limit | job_timeout | executor | transport | none`,
  derived from footer notes and the instance error.
- Report the primary metric over all selected cases (failures score as empty reviews),
  plus a secondary metric over cases without infrastructure failure, with the failure
  table. Never drop cases silently.

## 4. Deployment order

1. Worker-only: P1.1–P1.2 (this branch), P1.4 batching, P4.1–P4.2 status
   reconciliation and sweeper, P3. Then `cpu_ms` (P1.5). These are compatible with the
   current CLI and runner.
2. Worker + runner image together: P2. The image changes `execute.py` and the runner,
   so rebuild and retag the image, and deploy both in one `rio deploy`.
3. CLI: P4.3 and P5.
4. Cache-key version bump: P1.3. Expect one cold-cache run.

Each stage must pass `npm run check`, `vitest`, the Rust workspace tests
(`DEBUG=0`, `-j 2`) and the canaries below before the next stage.

## 5. Costs and tradeoffs

- **CPU:** the memo is a pure saving. Raising `cpu_ms` costs only what is actually
  used (Workers Standard bills CPU-ms beyond the included allowance).
- **Cache-key bump:** each case misses the cache once.
- **Containers:** standard-4 instead of standard-3, and more instances. The cost scales
  with instance-seconds. Pulling packs directly and keeping one container per review
  should cut instance-seconds on large repositories, because transfer is paid once,
  not 3–6 times.
- **Degrading instead of failing:** a review whose runner graph timed out completes
  with the CLI graph and an `incomplete` entry. That is more honest than `partial`
  with no agent output, but it is not "complete". Score it as incomplete.
- **Hard deadline:** a slow but useful review is cut at its budget, and keeps its
  partial evidence.

## 6. Validation and rerun

Reproduction (no endpoint needed): fetch the pinned commits blobless and
`git archive` both into `<dir>/{base,head}`. Write `git diff --name-status -M` to
`changed.txt`. Fetch the graph job result from R2. The key is the `wait-<graph job>`
step output in the instance history; read it with `cf r2 objects get --bucket-name
rio-artifacts`. Then run `eval/diagnostics/cache-lookup.ts` (see its header).
Acceptance: `identical_keys=true` and memo CPU under 10% of the cap on both vllm cases.

Canary (a fresh directory, never the paused run): `eval/runs/aacr-bench-fix1-<date>/`
with
- its own `manifest.json`, pinning the CLI sha256, the Worker `versionId` (from
  `endpoint-deployments-start.json`), the runner image tag and digest, and the
  profile hash;
- the same exact staged-tree selection and verification as before;
- the cases: vllm@134705b, vllm@075f1b5, elastic@a6a4623, @e38d20c, @5e604e4,
  @2adcb2d, @a9973f6, FreeCAD@82fef4a, @ec3da2e, lvgl@4a57db3.

Pass: no `Worker exceeded`, no `WorkflowTimeoutError`, no orphaned `running` row, CLI
rc in {0, 1, 4}, and every report pinned.

Cache isolation: `RIO_VERSION` is `0.1.0` on every build, so the `engine` key
component does not separate configurations. A fixed Worker with identical keys would
replay entries written by the degraded run. For the canary and the full rerun, use a
fresh tenant/token, or land the P1.3 key bump first, and record cache hits per case.
Better: make `engine` the bundle's commit.

Full rerun: all 196 PRs / 1506 annotations in a new directory, only after the canary
passes, at the canary's concurrency. Never resume `aacr-bench-final-20261111`; it
stays as the baseline evidence for this document.

## 7. What was implemented

| Item | Change | Where |
|---|---|---|
| P1.1 | `ContextMemo`: each file and symbol is read and digested once per lookup | `worker/src/cache.ts` |
| P1.2 | Lookup fails open (one retry, 5-minute step timeout); the agent runs uncached with a footer note | `worker/src/workflow.ts` |
| P1.3 | True one-hop neighbourhood from a prebuilt adjacency map; native SHA-256 for the key; `CONTEXT_KEY_VERSION = 2` (old entries miss once) | `worker/src/cache.ts` |
| P1.4 | Hunks computed once, keys and hits in steps of 250 hunks; `lookup` queries 90 hunk hashes at a time; `store` and last-hit updates use `DB.batch` | `worker/src/workflow.ts`, `worker/src/cache.ts` |
| P1.5 | `cpu_ms` 300,000 | `crates/rio-cli/src/deployment.rs` |
| P2.1 | Analysis jobs: up to 8 minutes of command wall, at most 40% of the remaining review time; run commands keep 2 minutes. Archive transfer gets its own allowance (1 minute + 4 MiB/s, at most 4 minutes), staying inside the queue consumer's 15-minute invocation | `worker/src/jobs.ts`, `worker/src/archive.ts`, `worker/runner/execute.py`, `crates/rio-runner/src/main.rs` |
| P2.2 | The Sandbox reports a deadline as a `timed_out` result naming the phase (`transfer` or `command`), so the queue never redelivers it; infrastructure errors are redelivered with 10–30 s jitter; self-hosted leases and completion tokens outlast the job | `worker/src/sandbox.ts`, `worker/src/index.ts` |
| P2.3 | The workflow waits for the job's own deadlines plus a minute, within the review's remaining time. On a timeout the job is withdrawn (`failed`) and late results are ignored. A failed or timed-out checks/graph job makes the review incomplete (checks recorded as `cancelled`/`timeout` or `failed`/`tool_crashed`) and the agents use the submitted graph | `worker/src/workflow.ts`, `worker/src/jobs.ts` |
| P2.5 | Sandbox on `standard-4` (4 vCPU, 12 GiB), `max_instances` 10; a size or capacity change rolls out like an image change | `crates/rio-cli/src/deployment.rs`, TUI labels |
| P3.1 | Triage runs inside `plan-*` steps on the changed text files only (binaries are never base64-encoded); replays keep only the plan | `worker/src/workflow.ts` |
| P4.1–2 | `reconcile`: a queued or running review whose instance errored or was terminated, or that is 2 minutes past its deadline, becomes partial with the submitted report; open jobs are withdrawn and an overdue instance is terminated. It runs on `GET /v1/reviews/:id` and on the minute cron | `worker/src/reconcile.ts`, `worker/src/index.ts` |
| P4.3 | The CLI rides out resets, timeouts, 429 and 5xx while polling (backoff up to 15 s, until its own deadline), polls every 2 s, and cancels the remote review when it gives up | `crates/rio-client/src/lib.rs` |
| P5 | Graph prefetch and token indexing stop at the deadline; parse threads default to `RIO_GRAPH_THREADS`, else at most 4; the endpoint-mode local graph budget is 60 s | `crates/rio-graph/src/build.rs`, `crates/rio-graph/src/index.rs`, `crates/rio-cli/src/endpoint.rs` |
| P6 | Each case records `infra_failure` (`cpu_limit`, `memory_limit`, `deadline`, `executor`, `job_timeout`, `transport`); the run summary counts them; scoring adds `excluding_infra_failures` beside the all-cases scores | `eval/aacr_bench.py` |

Measured with `eval/diagnostics/cache-lookup.ts` on the final code: the whole
lookup takes 0.8 s for vllm@134705b (was 14.4 s) and 1.5 s for vllm@075f1b5 (was
29.4 s) on this VM, and each 250-hunk step takes a fraction of that.

Deferred in that round and taken up in section 8: P2.4 (the transfer) and
P3.2/P3.3 (replay memory).

Review follow-ups:

- The Sandbox command deadline is the wall plus 75 s, so the executor can finish
  extracting the archive's tail. The container lifetime, the leases and the
  workflow wait include that grace.
- `reconcile` writes its report to `report-reconciled.json`, so a workflow that
  finishes first keeps its own report.
- Cache entries are indexed batch by batch as they are written.
- The cron runs QA cleanup and the review sweep independently.
- Client polls end at the deadline or on cancellation, even mid-request.
- The self-hosted runner's archive timeout matches the 4-minute transfer cap.
- Token indexing also checks the deadline inside large files.
- The adapter ignores recovered `; retried` notes, separates timeouts from other
  runner failures, and classifies status files written before `infra_failure`
  existed from their saved report and stderr.

## 8. Second round: what the first canary still broke

The canary of the section 7 build (`aacr-bench-rerun-20261111T181340Z`, ten cases:
three failed, four incomplete, three partial) showed six remaining causes. Each
row is what was found and what bounds it now.

| Cause | Found | Change | Where |
|---|---|---|---|
| Transfer (P2.4) | FreeCAD's two trees (790 MiB, 2 × 395 MiB) hit the 4-minute transfer cap; the graph job then died with no phase | A job that needs both trees gets head whole and, of base, only the files that differ: files equal in path, content and mode are named in `same/base` members and copied inside the container. The stream is coalesced into 1 MiB chunks. A result carries `phase` and `timing` (`transfer_ms`, `archive_bytes`, `storage_ms`, `extract_ms`, `command_ms`), and the footer note of a missing analysis says which phase ran out and how long each took | `worker/src/archive.ts`, `worker/src/sandbox.ts`, `worker/runner/execute.py`, `worker/src/workflow.ts` |
| Worker memory (P3.2/P3.3) | Three verifier steps of FreeCAD ended at 128 MiB. A voter's `search` decoded and split every file of the tree, each voter held its own scan, and every replay ran the conversation's searches again | Scans read a few MiB at a time (`BATCH_BYTES`), one batch per snapshot at once, and match on bytes before decoding. A turn's snapshot tool calls are one recorded step, so a replay reads their results instead of scanning again. Triage and the contract inventory read a change within 32 MiB, smallest files first, one change per isolate at a time, and report what was left out | `worker/src/snapshot.ts`, `worker/src/tools.ts`, `worker/src/gateway.ts`, `worker/src/verifier.ts`, `worker/src/contracts.ts`, `worker/src/workflow.ts` |
| Cache store | `cache-store-agents-correctness` made one R2 write per finding context plus reads, passed the per-invocation request limit and was retried with the same error until the review was cancelled | Entries are written as packs of at most 256 entries and 2 MiB (`cache/<tenant>/packs/<digest>.json`), in steps of at most 1,024 entries; a store step that fails is retried once and then leaves a footer note, because the cache is optional | `worker/src/cache.ts`, `worker/src/workflow.ts`, migration `0016` |
| Cancellation | A cancelled review kept its workflow: the store step above retried for as long as the instance lived, and leased jobs kept their containers | Cancel stops the containers of the review's running jobs, withdraws its idle ones and wakes the workflow's waits. The workflow ends the review as `partial` with what it found (`Review cancelled before it finished.`). A workflow that has not done so 5 minutes after the cancel (3 until section 10) is terminated by the minute sweep, which writes the partial report. Every terminal write is conditional on the review being open, so a late result or a late workflow revives nothing; a late result of a withdrawn job is dropped, one of a running job is kept for the audit only | `worker/src/index.ts`, `worker/src/jobs.ts`, `worker/src/reconcile.ts`, `worker/src/workflow.ts`, migration `0017` |
| Client deadline | The CLI left a minute after the review's deadline, before the endpoint's own two-minute grace and sweep, cancelled the review and printed an error with no report | The CLI waits 4 minutes past the longest deadline, so it receives the endpoint's partial report. If it still has to leave, the error says whether the user interrupted or the wait ran out, and for how long it waited | `crates/rio-cli/src/endpoint.rs`, `crates/rio-client/src/lib.rs` |
| Adapter labels | An error envelope (no review identity) was reported as `Report commit pins differ from dataset` with no cause | The adapter reports Rio's own error first and checks the identity of usable reports only, exactly as before. Causes gain `subrequest_limit` and `workflow_internal`, cancellations and client deadlines count as `deadline`, and failures that only the audit records (votes that did not complete, analysis jobs that never ran) count too. A status keeps every cause (`infra_failures`) and the first (`infra_failure`); saved evidence is classified under the current rules | `eval/aacr_bench.py` |

Local preparation was the other 17 minutes of the FreeCAD case, before the
endpoint had a review: the syntax pass re-parsed files per query and the graph
build ignored its deadline inside one file. After the change the same
preparation takes about 44 s on this VM (was 950 s); the CLI prints the time of
each local phase before `Endpoint review:`, so local time is not read as remote
time.

What stays as it was, on purpose:

- One container per job. Sharing what both trees hold removes about half of the
  bytes of an analysis job, which is where the time went; a container per review
  would also remove the second and third transfers, at the cost of a container
  that outlives its job and of commands of one job seeing the files of another.
  The timings each result now carries say whether that is still needed.
- `CONTEXT_KEY_VERSION` is 3: entries written by the first canary's build miss
  once, so the second canary runs every agent and writes every entry itself.
- Worker limits (`cpu_ms`, subrequests) are unchanged. The work is bounded
  instead: a step reads and writes a bounded number of objects. (Section 10
  declares a subrequest limit: a step was bounded, a review was not.)

## 9. Third round: what the second canary broke

The canary of the section 8 build (`aacr-bench-fix2-20261111T230153Z`, commit
`d2b6b9c`) was stopped after its first two cases failed (FreeCAD@82fef4a and
lvgl@4a57db3, both after about 290 s). Both ended on the same answer to a
status poll: HTTP 400, `D1_ERROR: D1 DB is overloaded. Too many resources
consumed within a 10 second window.` The analysis jobs of all four reviews that
had started were complete by then, with no CPU, memory or subrequest error.

| Cause | Found | Change | Where |
|---|---|---|---|
| Cache store query | The store's lookup of objects its entries replace joined `agent_cache` to the pack's members. With the index migration `0016` added, the planner led with the table (`SEARCH a USING INDEX agent_cache_object (tenant=?)`) and read the tenant's whole index once per pack: 11.3 million rows in two calls, 5.3 s each, on a table of 22,208 rows. That is what overloaded the database for every other request | The members lead the join (`json_each(?) j CROSS JOIN agent_cache a`), so each member is one search of the primary key. A test stores and looks up two packs for a tenant with 4,000 other entries and bounds the rows the database reads; it fails on the old query (2,122,563 rows) and passes on the new (1,027) | `worker/src/cache.ts`, `worker/tests/cache.test.ts` |
| Storage faults as bad requests | The endpoint answered every uncaught error with 400, so the CLI took a passing database fault for a refusal and ended the case | Passing D1 faults (overloaded, reset, storage timeout, connection lost) are answered with 503 and `retry-after`, which the CLI's polls and uploads already retry until their deadline. Anything else stays 400 | `worker/src/index.ts` |
| Cancel under load | The CLI cancels a review it stops waiting for with one request; under the overload that request failed too, and two reviews ran on (one to completion) | `cancel` retries transient failures with backoff for up to 25 s (inside the 30 s the adapter gives an interrupted CLI) | `crates/rio-client/src/lib.rs` |
| Stopped CLI | `systemctl stop` sends SIGTERM, which the CLI did not handle: two more reviews ran on until they were cancelled by hand | `rio review` treats SIGTERM as an interrupt: checks stop, the endpoint's review is cancelled, a second signal exits at once | `crates/rio-cli/src/main.rs`, `crates/rio-cli/src/pull.rs` |
| Stopped job's row | The job of a container stopped by a cancel stayed `leased` until its lease ended, although its container was gone | A job whose container answered the stop is withdrawn at once, as is a cancelled review's job when the queue delivers it; the stop itself ends the execution's wait, whatever the destroyed container's streams do. A late result of a withdrawn job is dropped, as before | `worker/src/jobs.ts`, `worker/src/index.ts`, `worker/src/sandbox.ts` |
| Labels | The cases had no cause (`infra_failures: []`), and a cancelled review's error read `runtime did not complete` | The adapter has a `storage` cause for D1 errors. A review ended by a cancel says `cancelled`, in its error and its announcement | `eval/aacr_bench.py`, `worker/src/workflow.ts` |

Measured in that canary, on the section 8 build: transfer time is storage
time. FreeCAD's 426 MB archive took 42 s for checks (36 s reading R2) and 35 s
for the graph (34 s); lvgl's 167 MB took 16 s and 25 s; Elasticsearch's 374 MB
took 48 s (43 s). The 4-minute cap is therefore five times the largest
transfer seen, and compressing the stream would not help: the container side is
a few seconds. The one 138 s transfer of the earlier probe followed a new image
rollout directly (a cold container). Local preparation took 12 s for FreeCAD
and 52 s for lvgl.

`CONTEXT_KEY_VERSION` is 4: the 175 entries the stopped canary wrote (and the
probe's before it) miss once, so the third canary runs every agent itself.

Seen in the database's query statistics and left as it is: queries by
`review_id` on `usage` and `jobs`, and the sweep's on `reviews`, scan their
tables (11,000, 2,600 and 660 rows a call, 4 to 20 ms). They grow with history,
not with a review, and an index for each is the obvious change; it was not made
in this round because the last index added is what moved the planner off the
primary key above, and these scans are three orders of magnitude below what
overloaded the database.

## 10. Fourth round: what the full run broke

The canary of the section 9 build (`aacr-bench-fix3-20261112T004450Z`, commit
`cdc2788`) passed and the full run started on the same deployment. Of its
first 37 cases, five large-tree reviews (FreeCAD@290bdc7 and @699b45c,
elasticsearch@4d9b96f, @5e318eb and @a9973f6) ended `partial` with no comment
and the reason `runtime stopped: Error`, and one (elasticsearch@e38d20c) lost
an agent to a model call cut off at 90 s. The workflow histories of all five
say what `Error` was: `Too many API requests by single Worker invocation`,
after 10 to 24 whole-tree searches each.

What the limit is, measured with a scratch Workflow
(`diagnostics/subrequest-limit-probe.py` in the evidence directory):

- It counts the storage and network requests of one Workflow **instance**,
  across its steps. A `step.sleep` between steps does not start a new count.
  Step limits and retries therefore bound nothing here: section 8 bounded each
  step, and a review of many steps still reached it.
- At the limit the instance ends `errored`, where it stands, and no step sees
  an error it could report. The default is 10,000.
- A declared `limits.subrequests` is the one enforced for Workflows: with
  20,000 declared, an instance made 15,030 requests and completed.

What spent it, measured on the manifest of elasticsearch@a9973f6 (32,155 head
paths, 318 MiB, 54 packs): one unscoped `search` cost 390 pack reads, because
the scan went in path order and neighbours in path order lie in different
packs; the models asked for 20 such searches; four passes over the change's
text cost about 500 each. A turn may ask for 8 searches and a conversation has
16 turns, so nothing but the platform bounded the cost.

| Cause | Change | Where |
|---|---|---|
| Reads per scan | A search reads the tree in storage order (`sweep`): within a window of kept entries (2,048, then 16,384), contents are read pack by pack, neighbours within 1 MiB joined into reads of at most 8 MiB. The same tree costs about 75 reads instead of 390. A filter is asked again before each read, so a search that has its answer stops the reading. Looking up many paths is one pass over the manifest instead of a lookup each | `worker/src/snapshot.ts` |
| Scans per review | One pass over a version of a snapshot runs at a time and answers every search asked before it began, so the searches of a turn (started together inside the turn's recorded step) and of the three voters share it. An answer is remembered for the snapshot (128 answers) and an identical search costs nothing. The output is what the search in path order gave, byte for byte, which a test checks against that search | `worker/src/tools.ts`, `worker/src/gateway.ts` |
| No bound per review | The workflow counts its own D1 and R2 requests and model calls (`Requests`; the environment it passes on is metered). Counts are recorded with every step's result (`recording` wraps the workflow's steps, the plain ones included), so a run of the workflow code after an interruption continues from them. Past 60% of the limit a search is not run and its answer says so (`read_file` and `graph_query` still work); past 80% no model turn starts, and its agent or vote ends with `review request budget exhausted`; a council member's call is such a turn, counted when it starts and answered as a `budget` abstention when it does not. The last fifth is for consolidation, the report and what is not counted. Both refusals are step results, so a replay meets the same ones | `worker/src/requests.ts`, `worker/src/workflow.ts` |
| Silent loss | A review that refused anything is `incomplete` (or `partial`), with a footer note that counts the searches not run and the model turns not started, and the audit carries the counts (`agent_audit.requests`: limit, used, scans, searches, remembered, refused, stopped) | `worker/src/workflow.ts` |
| The limit itself | `rio deploy` declares `limits.subrequests` 50,000 and tells the Worker in `SUBREQUEST_LIMIT`; a Worker told nothing budgets against 10,000. The number is headroom for large trees; the count is what bounds a review | `crates/rio-cli/src/deployment.rs`, `worker/src/types.ts` |
| `runtime stopped: Error` | The sweep reports the platform's message (`runtime stopped: Too many API requests by single Worker invocation`, `… Worker exceeded memory limit`), redacted and cut to 200 characters: every platform limit is an `Error` by name | `worker/src/reconcile.ts` |
| Model call cut off | One call may take 180 s (`MODEL_CALL_MS`; a reply of the full output allowance takes about that at 90 tokens a second), still never longer than the review has left. Its step may take 4 minutes, and a cancelled workflow has 5 minutes before the sweep terminates it, so the step under way can end | `worker/src/gateway.ts`, `worker/src/workflow.ts`, `worker/src/reconcile.ts` |
| Labels | The adapter reads the budget's notes and errors as `subrequest_limit` and a cut-off model call as `model_timeout`. The five cases above could only be read as `deadline`: the limit's text was not in their reports | `eval/aacr_bench.py` |

`CONTEXT_KEY_VERSION` is 5: the entries the stopped full run wrote miss once,
so the next canary runs every agent, and with it every search, itself.

What stays as it was: the pass over a change's text (triage, plans, contract
inventory, cache hunks) still reads in path order. It is bounded by the change
(32 MiB, section 8), runs a fixed number of times, and is counted like
everything else.

## 11. Stopping the full run: a stop that signals twice

Stopping the full stage (`systemctl --user stop`) left its two reviews in
flight `running` on the endpoint, not cancelled; they were cancelled by hand.
Both CLIs had printed that they were interrupted and then left with status 130.

Measured with a scratch unit: systemd signals every process of a stopped unit
twice within about 2 ms (the unit's processes when the stop begins, and what is
left when its main process has gone). The CLI took the second signal for a
second Ctrl-C, which leaves at once, before the cancellation begun by the first
had reached the endpoint. The cancellation probe of section 9 sent one signal
to the CLI directly and could not see this.

| Cause | Change | Where |
|---|---|---|
| A second interrupt left while the endpoint review ran | The CLI marks the endpoint review as its own from before the submission until the wait for it has ended (which cancels on an interrupt). A second interrupt still ends the CLI with 130 and no document, but first waits, at most 30 s, until that mark is gone. The interactive UI's second Ctrl-C does the same | `crates/rio-cli/src/endpoint.rs`, `crates/rio-cli/src/main.rs`, `crates/rio-cli/src/tui/` |
| An interrupt before the submission still submitted | The snapshot upload ends at the interrupt, and nothing is submitted after one | `crates/rio-cli/src/endpoint.rs` |
| A terminated adapter left its CLIs to the service manager | The adapter treats a request to terminate as an interrupt: it stops its reviews (each CLI cancels its endpoint review) and leaves the cases resumable. It acts on the first signal only, so a repeated one, or the interrupt a supervisor relays, does not cut that short | `eval/aacr_bench.py` |

The next canary's cancellation probe stops a real service unit that runs a
review, and passes only if the endpoint review ends cancelled with its workflow
ended and no job open.

## 12. A submission that outlasted the client's wait

One case of the stopped full run (typescript-go@892b4a3) never became a
review: the CLI's `POST /v1/reviews` had no answer within the client's 60 s, and
the endpoint created nothing. The same submission, replayed, took 23 to 38 s
on that build.

The request validates the submitted graphs against the snapshot before it
answers, which needs the line count of every file a graph node names: here
1,211 base and 1,216 head files (6 MiB each) of a tree of 120,008 files in 55
packs. Measured from a scratch Worker reading the same snapshot:

- A ranged read of a pack takes about 200 ms before its first byte, whatever
  its length; the bytes then arrive at 40 MiB/s or more. What such a pass costs
  is its number of reads, not their size.
- In path order with a 256 KiB gap (section 9's scan) one version took 209
  reads and 13.7 s, three reads in flight. Section 10's sweep (1 MiB gap) takes
  87 reads and 6 s, and the request did it once for each version.
- 692 of the 1,216 head files are the base's bytes at the same place in the
  same pack. Both versions' files together are the same 87 reads: 7.4 s with
  three in flight, 3.4 s with six.

| Cause | Change | Where |
|---|---|---|
| A pass per version | The line counts of both versions are one pass: each manifest is listed once (the two at the same time, each ended at the last path wanted) and the contents are read together, so a file the change left alone is read once | `worker/src/snapshot.ts`, `worker/src/reviews.ts` |
| Reads held in memory, three at a time | The pass streams (`pour`): a run of a pack is counted as it arrives and nothing of it is kept, so six runs may be in flight (what one invocation may have open) and a run needs no length limit, where a held read was limited to 8 MiB and three in flight for the isolate's memory. Large contents are part of the same runs | `worker/src/snapshot.ts` |
| A manifest body left open | A listing that its consumer ends early cancels the rest of its body, so it does not keep one of the invocation's connections while the contents are read | `worker/src/snapshot.ts` |

A stream that ends before the bytes the manifest promises is an error
(`snapshot content missing`), not a shorter count. What the pass holds is the
manifest entries of the files the graphs name. The request's body bounds
those: 8 MiB of submission names at most some 120,000 nodes, a few tens of MiB
of entries, and the CLI's graphs have 2,000 nodes each.

The client's 60 s stays: a submission is not repeated on a timeout (it is not
idempotent), and the wait was not what was wrong. What remains outside this
bound is the request's own body (3 MiB for this case) and the store's writes,
3 to 9 s in the replays whatever the tree.

## 13. Review of the change

The change's review found paths the benchmark had not reached. Each is a
bound or an end the sections above state and the code did not keep:

| Cause | Change | Where |
|---|---|---|
| A review cancelled while it was being prepared stayed `cancelled` for good: it has no workflow to end it, and the sweep ends only reviews that were handed over | The cancel ends it there (`error`, `cancelled`), fails its pull request record, settles its announcement, and stops its prepare job, which is a job with a container like the others | `worker/src/pulls.ts`, `worker/src/index.ts`, `worker/src/jobs.ts` |
| A job that completed just before a cancel was no longer open when the cancel read the open jobs, and its completion sent no result to a cancelled review: the wait had neither event | The cancel reads the open jobs in the batch that cancels; a completion reads the cancellation in the batch that records it, and ends its own wait when the cancel could not have. One event that fails no longer leaves the other waits without theirs | `worker/src/index.ts`, `worker/src/jobs.ts` |
| Open reviews with earlier deadlines filled the sweep's batch, and cancelled ones past their grace waited behind them | The cancelled reviews are a batch of their own | `worker/src/reconcile.ts` |
| A job message delivered again started a second execution in the same runner object, which destroyed the first one's container; a stop during the storage reads before the container started was not seen; a stop answered by an earlier object was forgotten | A second delivery joins the execution in flight; a stop ends every wait from the first read on; the job's row (`failed` once withdrawn) is read before the container starts, and the queue leases no job of a review that ended | `worker/src/sandbox.ts`, `worker/src/index.ts` |
| A review cancelled during its last step published its findings; one cancelled after its report was written had a `partial` status and a `complete` report | A review cancelled by request publishes nothing, and its check run says so (a review that ran out of time still publishes what it has). The finish step writes the status it gave the review into the report and the final event | `worker/src/publish.ts`, `worker/src/workflow.ts` |
| Only model and tool steps recorded the request counts, so a replay knew less than the run before it, and a council member's call was not counted or refused | Every step's result carries the counts (`recording`); a council member's call is a model turn | `worker/src/requests.ts`, `worker/src/workflow.ts` |
| An agent's prompt excerpt read each changed file whole, whatever its size | A file over 8 MiB is named with its size and not read | `worker/src/workflow.ts` |
| A rename over the change text budget was left out while a file that took its old name was read, so the rename looked like a deletion | Records that share a path are read or left out together | `worker/src/snapshot.ts` |
| A `pour` whose storage request failed left the other reads to take every remaining run | A refused request ends the scheduling as a short content does | `worker/src/snapshot.ts` |
| A file over 1 MiB went to the container as one write of its size | A large part passes a chunk at a time, still uncopied | `worker/src/archive.ts` |
| A cache pack's size was counted in UTF-16 units, after the entry that crossed the bound was in | A pack is bounded by the UTF-8 bytes of its object; the entry that would cross starts the next pack, and one larger than a pack is stored alone | `worker/src/cache.ts` |
| The byte search tried every start in full: a pattern of 499 `a` and a `b` over 8 MiB of `a` is four billion comparisons | Knuth-Morris-Pratt, with the native skip to the next candidate kept | `worker/src/tools.ts` |
| A symbol query over a large tree with few matches asked its deadline only at a match | The query's cursor asks the budget while it scans | `crates/rio-adapters/src/syntax.rs` |
| After a pull request review the CLI's signal listeners stayed in place with nothing behind them: `kill -TERM` at the publication prompt did nothing. The interactive UI did not see a request to terminate, and a signal between two waits was lost | An interrupt after the review ends the CLI (130); the UI ends as on quit; one listener receives every signal in order. A cancellation no longer waits for a progress poll in flight | `crates/rio-cli/src/pull.rs`, `crates/rio-cli/src/main.rs`, `crates/rio-cli/src/tui/review.rs`, `crates/rio-client/src/lib.rs` |
| The adapter counted a stopped workflow's note as a deadline whatever the platform's reason, took the last listed execution for the last attempt, joined its error texts into one (one cause for all), and failed on a report that was not an object | The platform's reason is the cause where it names one; the highest attempt is the last; each text has its cause; only an object is a report | `eval/aacr_bench.py` |
| The object store failed one write inside the platform while a snapshot was uploaded (`put: We encountered an internal connectivity issue. Please try again. (10001)`), and the endpoint answered 400: the CLI retries an upload's requests on 503, not on a bad request, so the case failed (`FreeCAD__FreeCAD@a050e42` in the run of section 12's build), and the adapter gave it no cause | The object store's passing faults (internal error, unavailable, too many requests) are answered 503 with `retry-after`, as the database's are; the adapter counts them as `storage` | `worker/src/index.ts`, `eval/aacr_bench.py` |

A second reading of the change, after those, found what they had left:

| Cause | Change | Where |
|---|---|---|
| A job delivery read its review uncancelled, the cancel committed and looked for containers to stop, and the delivery then leased the job: the cancel's withdrawal leaves a leased job alone, so a container started after the cancel | The lease itself refuses a job of a cancelled review, in the statement that takes it | `worker/src/index.ts` |
| A completion read its review open, the cancel committed (and no longer found the job open), and the completion then read the review cancelled and sent nothing: the wait had neither event | The completion reads the review once. What it read decides: a result for an open review, the cancellation for one cancelled before the read, nothing for one past its deadline (it is not told it was cancelled) | `worker/src/jobs.ts` |
| A cancel that arrived while a publication was under way did not stop it: only the read before the first write asked | Every write to the host renews the publication's lease, and the same statement refuses once the review is cancelled. What was written stays, as with a lost lease, and the check run says the publication stopped | `worker/src/publish.ts` |
| A cancelled preparation whose event could not be written ended the cancel before its container was stopped, and no later cancel found the review to end | The pull request record, the container, the job and the event are each tried whatever became of the one before; a repeated cancel finds the review it ended and finishes the rest, writing the event once | `worker/src/pulls.ts` |
| A cancel that arrived while the check run of a prepared review was being created found none to complete, and the one then created stayed in progress | The preparation reads the review again after announcing it, and completes the check run of one that ended meanwhile; it prepares nothing for it | `worker/src/pulls.ts` |
| The finish step marked the report it holds `partial` before the write that stores it: an attempt after a failed write found nothing to write, and the stored report stayed `complete` | The report is stored first, and the one held says so after | `worker/src/workflow.ts` |
| The submission that creates a review is the one request no client repeats, so the object store's passing fault still ended it, now with a 503 | A request's handler tries a read, a listing, or a write whose body can be sent again twice more (0.2 s, 0.8 s) when the store failed it in passing. A streamed body is not sent again: the client repeats that request on the 503 | `worker/src/storage.ts`, `worker/src/index.ts` |
| A stop that was answered withdraws its job, and a runner object that forgot the stop reads that record. When the withdrawal could not be written the job still read as leased, and a delivery already holding its lease started a container for a cancelled review | The runner object reads the review with the job, and starts nothing for one that ended or was cancelled: what the queue's lease refuses | `worker/src/sandbox.ts` |
| The adapter took a command's highest attempt for its last, over all calls of that command: the retry of one call hid the timeout that had ended another | A timeout ends its call whatever its number (only a runner's failure is tried again) and counts, as does a command that could not be spawned; a runner's failure was recovered when as many executions of the command are numbered one higher. The audit names no call, so fewer retries than failures count them all | `eval/aacr_bench.py` |

Found by that reading and not changed:

- **A submission interrupted before it answers.** The endpoint names a review
  in its answer to the request that creates it. A CLI told to stop while that
  request is pending has no name to cancel by, and a service manager that
  ends it before the answer leaves a review that runs to its own deadline.
  Closing this needs the client to name the review (a protocol change and a
  migration), which is not part of this change.
- **Request counts of failed attempts across a restart.** A step records its
  counts with its result. The counter in memory keeps a failed attempt's
  requests through the retries that follow in the same run of the instance;
  one that restarts between a failed attempt and its retry counts that
  attempt's requests as not made. The loss is bounded by one step's attempts
  and falls into the fifth of the platform's limit the budget leaves unused
  (section 10). Recording on the failure path needs a write that fails for
  the reasons the attempt did.

None of this was deployed while the benchmark of section 12's build ran: that
run measures the build it started with. The object store's fault was found by
that run and its handling is not validated by it, nor is any row of the
second table.

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

Not implemented, with the reason:

- **P2.4, one container per review pulling packs from R2.** This is a larger
  protocol change (container lifetime across jobs, an outbound handler with
  credential injection). The transfer allowance and honest timeouts bound the
  current pipe instead. Revisit if canary transfers approach the 4-minute cap.
- **P3.2 and P3.3, lazy model responses and compact graphs.** A replay must re-read
  each prior model response to rebuild its conversation, so responses cannot be
  dropped. Verifier fan-out is already bounded at 4 voters. Triage was the
  measured large replay allocation; the canary checks whether memory is still
  reached.

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

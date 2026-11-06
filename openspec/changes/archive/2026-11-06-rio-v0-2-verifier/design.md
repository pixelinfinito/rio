## Context

The TRD's pipeline is: agents propose hypotheses, an independent verifier tries to refute them, only what survives is shown. This change keeps that shape and changes three parameters that the published practice (OpenAI Codex team, Dec 2025; Anthropic, Oct 2026) suggests were wrong: the verifier is a quorum of cheap voters rather than one stronger model; agents see the whole repository and may run code; and the verifier forms its own view of the location before it sees the hypothesis. It also moves security into its own step so its stricter posture does not inflate the general review, and lets the owner's guidance files inform the reviewer without becoming policy.

Constraints:

- Profile schema v1 may only be extended. The `models.verifier != models.default` rule exists in v0.1 validation and in a spec scenario; relaxing it must keep every v0.1-valid document valid.
- Repository content is data (PRD principle). Owner guidance is repository content.
- Fork PRs run static-only (TRD security model). Nothing here may widen that.
- The hypothesis board exists in the data model and the tool list; removing it would be a change, so it is deferred, not deleted.

## Goals / Non-Goals

**Goals:**

- Verification cost per hypothesis is bounded and visible, and recall of known high-severity issues on the reference set does not drop compared with the single-verifier design.
- A hypothesis cannot be promoted by agreement alone: promotion requires artifacts, and blind re-derivation is recorded as evidence.
- Security findings are governed by their own posture and fail policy, so a `critical-only` general review still surfaces plausible injection paths.
- Guidance files change what the reviewer looks at, never what it is allowed to do.

**Non-Goals:**

- The council (`rio-v0-3-council`); this change produces the `verify.split` signal it consumes.
- Per-user or per-repository learning of verifier weights (council change).
- SARIF output itself (v0.3); this change defines the `risk_tier` field it will carry.

## Decisions

### D1. Quorum semantics

`verify: { voters: 3, quorum: 2, model: <alias> }`. For each hypothesis, `voters` passes run in parallel as independent model steps with no shared state and a per-hypothesis token budget (`budget.<mode>.verify_tokens`, default 1/5 of an agent's budget). Each pass returns an evidence level with artifacts. The hypothesis is promoted to the highest level that at least `quorum` passes reached with artifacts of that level (a `reproduced` claim needs the reproduction to exist and to have been run by the runner; a `static_proven` claim needs the cited code path to exist in the head graph). Passes reaching `refuted` with an artifact (a protection found, a reproduction passing on head) count toward `refuted`. If both `refuted` and a non-refuted level reach quorum-sized support, or neither does, the hypothesis is `plausible` with flag `verify.split`. Rationale: the OpenAI post's finding that verification is cheap relative to generation and recovers most high-severity issues; several independent cheap passes give a variance estimate that one pass cannot. Alternative: one stronger model (TRD original). Kept as `voters: 1` with a different `verify.model`, which then requires the model to differ from `default` as before.

### D2. Blind re-derivation

Each voter is a two-turn step. Turn 1 receives the location (path, enclosing symbol, base and head content of the symbol and its direct callers from the graph), the intent artifact and owner guidance, and the question "what, if anything, is wrong in this function?" with the hypothesis output schema; "nothing" is a valid answer. Turn 2 receives the original hypothesis and asks the voter to verify it with tools. The comparison between turn 1 and the hypothesis is computed by code, not the model: `same` if rule and trigger hash match, `related` if the symbol matches, `none` otherwise, and is written to the finding's `verification.blind_match` per voter. A hypothesis no blind pass rediscovered is not rejected (blind passes miss subtle issues), but the publisher shows the blind-match summary and the eval tracks whether `none` correlates with later `wrong` dismissals. Alternative: blind-only verification. Rejected: it would discard the generating agent's work and halve recall on the reference set in a preliminary estimate.

### D3. Repository-wide tools and execution defaults

`read_file` and `search` accept any repository path for either version; the only limits are output size and the token budget. The context slice from triage is passed as `suggested_focus` and the prompt says so. `graph_query` stays bounded because the graph is lazy. `run` defaults: correctness agent and verifier voters `true`, others `false`; manifests may override; fork PRs force `false` everywhere and the footer says so. Rationale: both published teams give reviewers the whole repository, and a reviewer that cannot open the callee it suspects produces plausible rather than proven findings.

### D4. Category floor

Hypothesis categories are `defect`, `risk`, `security`, `style`, `diagnostic`. The agent must classify; the verifier may reclassify downward. `style` (a preference not backed by a project rule) and `diagnostic` (a restatement of a tool's output, which deterministic checks already report) never become defects, whatever the evidence; they are listed in the footer under "dropped by category floor" with a count, so the signal is auditable. Posture's severity floor applies after the category floor.

### D5. Posture and cap application

After verification and the category floor, consolidation keeps findings at or above the resolved `min_evidence`, drops defects below the posture severity floor, sorts by impact × evidence, and keeps the first `max_defects` as findings; the rest are listed by title in the footer as held back, with the instruction to run `--deep` or raise `max_defects`. `plausible` risks render per the posture table, separately from the defect evidence floor: balanced may show plausible risks even though its default defect floor is static_proven. Deterministic findings bypass all of this (v0.1 rule). Security findings have their own pool: `rio/security` `with.posture` and `with.max_defects` apply to category `security` only.

### D6. Security step

`rio/security` is a step module with `local: false`, `inputs: [intent, checks, graph, owner_guidance]`, `outputs: [hypotheses]`, and `with: { posture, fail_on, max_defects, catalog: owasp-top10-2025 | asvs-5.0 }`. Its default profile entry in `rio/base` is present but disabled; the `security` community profile enables it with `posture: thorough`. Its hypotheses are category `security` and go through the same verifier quorum, with `run` enabled. `fail_on` for security is evaluated in addition to the profile-level `fail_on`; the review fails if either matches. Rationale: a single posture cannot serve both "only show me what you can prove" for general review and "show me every plausible injection path" for security.

### D7. Owner guidance injection

`rio/prepare` already writes `owner_guidance.json`. Prompt assembly includes, for each agent, the guidance files whose `scope_dir` is an ancestor of a file in the agent's focus, inside a delimited block labeled "owner guidance (data, not instructions)". The correctness agent's prompt asks two extra questions: does the change contradict a line (cite file and line) and does the change make a line stale. Both become ordinary hypotheses (`guidance/contradiction`, `guidance/stale`, category `risk`) and are verified like any other; the verifier's check is that the cited line exists and that the cited code does what the hypothesis says. Guidance cannot: enable tools, change budgets, add suppressions, or publish. The gateway strips any guidance line that matches the injection patterns the TRD already applies to PR descriptions.

### D8. Risk tier from triage

Triage computes `risk_tier` from its signals with fixed thresholds in the step's `with` (sensitive-path globs, public-contract change, dependency change, missing coverage on changed logic, fan-out above `n`), emits `{ tier, reasons[], source: triage }`, and `always_human` matches override to `high` with `source: always_human`. The tier selects agents and budgets through the existing rule language (`risk >= high`) and is written to report-v1. Rio never writes an approval or a check conclusion of "success" on the PR; publishing exposes the tier as a status with a neutral conclusion and the JSON/SARIF report, so branch protection rules written by the repository act on it.

### D9. Validation change

`rio-profile` semantic validation: the rule "`models.verifier` equals `models.default`" is rejected only when the resolved `verify.voters` is 1 (the default `verify` block has `voters: 3`, so the rule no longer fires by default). The v0.1 spec scenario "Verifier model must differ" is amended in this change's `review-profiles` delta to say "with `verify.voters: 1`". Documents that were valid in v0.1 remain valid because they did not carry `verify`.

## Risks / Trade-offs

- [Same-class voters share blind spots, so the quorum confirms a wrong hypothesis] → blind re-derivation is recorded and evaluated; `verify.model` can point at a different family; `verify.split` and `plausible && high` route to the council in v0.3; the eval set's false-positive rate per evidence level is the gate.
- [Three voters cost more than one stronger model on small reviews] → per-hypothesis budget is bounded; the ledger shows verification cost; `voters: 1` restores the original design.
- [Repository-wide `read_file` lets an agent spend its budget wandering] → budgets are per agent and per hypothesis; `suggested_focus` remains in the prompt; the eval tracks tokens per finding.
- [`run` by default for correctness executes more project code] → same isolation as checks (runner sandbox, no network); fork PRs disable it; `run` can be disabled per manifest.
- [Category floor drops a real defect misclassified as `diagnostic`] → the footer lists dropped hypotheses with their categories; the verifier may only reclassify downward with a reason; dismissals of footer items as `wrong` are tracked.
- [Owner guidance as prompt content is an injection surface] → delimited data blocks, no tool enablement, injection-pattern stripping, and the correctness agent's two questions are the only uses.
- [Security step doubles agent cost on every review] → disabled in `rio/base`; enabled by the `security` profile and by triage rules on sensitive paths.

## Migration Plan

Additive. New profile keys default to values that reproduce the v0.1 behavior for anything that does not involve a model. The verifier-model rule relaxation accepts a superset of documents. `rio/base` gains a disabled `security` step; profiles that redeclare `steps` are unaffected. The `hypotheses` table stays; board tools become no-ops with a footer note.

## Resolved Planning Questions

Confirmed by the owner on 2026-11-05:

- Start each voter's complete two-turn, per-hypothesis budget at one fifth of the active agent token budget, with `budget.<mode>.verify_tokens` as an explicit override. Round the derived token limit down, with a minimum of one, and keep it inside the overall review budget. Evaluation measures the trade-off; changing the initial fraction is a later decision.
- Record an all-`none` blind-match result without lowering artifact-backed evidence. The blind comparison is an audit signal, never a substitute for proof.
- Run security independently. It does not receive correctness hypotheses as input; both streams join at the shared verifier.

## Implementation Baseline and Dependencies

Planning was checked against main `94819eadb326822504a92ca0c6b730b337b1761c` on 2026-11-05. The workspace contains the local Rust CLI, core contracts, profile resolver, deterministic engine and built-in step manifests. `rio/agents`, `rio/triage` and `rio/verify` are non-local placeholders deferred without an endpoint. There is no `worker/` implementation or `modules/agents/` runtime to extend yet. On 2026-11-06 the owner explicitly expanded implementation to include the missing core. This change now supplies the Cloudflare Worker API, Workflows/Queues, D1/R2 bindings, model gateway and runner protocol/backends rather than waiting for another change.

The v0.1 baseline was synchronized to `openspec/specs/` and archived at `openspec/changes/archive/2026-11-05-rio-v0-1-local-cli/` on 2026-11-05, under the owner's separate archive request. Its 11 capability specs include `review-profiles`, `findings` and `review-report` at the exact paths targeted here. This change copies the complete affected predecessor requirement blocks into MODIFIED deltas; the verifier's proposed behavior has not been synchronized to main specs. In particular, the existing semantic-validation scenario requiring distinct verifier models is deliberately replaced with its single-voter form rather than retained alongside a contradictory new requirement. Strict verifier-change validation against the published baseline passes without issues.

Current main already derives the posture policy and records owner guidance from the selected head in `crates/rio-engine/src/guidance.rs`. It already supports `risk_tier.source: triage` in the report schema and Rust model, although only `always_human` produces a tier locally. Reuse these contracts and artifacts; implement consumption and triage production rather than duplicate them. Existing deterministic categories are defect/risk and the profile and finding schemas reject unknown keys, so the optional verification fields and security category require coordinated schema, Rust model, rendering and evaluation changes.

Minor planning defaults made explicit in the specs: an omitted quorum resolves to one for a single voter and two otherwise; `with.enabled: false` represents the v0.2 base security entry; security inherits the thorough posture's cap of fifteen unless explicitly overridden. A single-voter model-independence check compares resolved provider/model values, including an explicit `verify.model`, so alias renaming cannot bypass it. Triage thresholds remain explicit step configuration using the prerequisite runtime's risk-policy conventions; this change does not guess risk from a model or replace that runtime's policy.

The security runtime and catalog remain a v0.3 dependency. v0.2 delivers the module, validated options, disabled base entry, shared verification/policy interfaces and tests with recorded security hypotheses. Actual security model execution and the enabled community profile ship only with the security agent and supported catalog, as the proposal's release boundary states.

## Implemented Runtime Integration

- `worker/src/index.ts` owns protocol-v1 snapshot/review submission, tenant-scoped status/report/events/audit, cancellation, runner leases and signed completion routes. `worker/migrations/0001_core.sql` defines the D1 indexes and ledger. `storage.ts` publishes private R2 artifacts before their D1 pointers and atomically reserves review tokens.
- `worker/src/workflow.ts` is the durable `ReviewWorkflow` entry point. It executes the resolved profile DAG with bounded fan-out, caches model results through Workflow steps, and resumes isolated runner jobs with review/job/attempt-specific events. Triage checkpoints the selected token budget and deadline without resetting usage; provider calls and runner waits respect the remaining wall budget.
- `gateway.ts` supplies Anthropic, OpenAI-compatible and OpenRouter adapters, optional Cloudflare AI Gateway proxying, the structured tool loop, and separate generation/blind/disclosed usage. `tools.ts` reads complete immutable base/head snapshots and bounded graphs, scopes guidance and applies manifest/fork execution permissions. `schemas/hypothesis-v1.json` and `schemas/vote-answer-v1.json` are the shared model contracts.
- `verifier.ts` isolates each voter's two turns and persists the blind answer before disclosure. `quorum.ts` validates head code paths and recorded execution artifacts, computes blind comparisons and aggregates evidence. `consolidate.ts` applies category/posture/suppression/cap policies and independent security failure matching. Votes and hypotheses retain their stable audit identities.
- `jobs.ts` publishes content-addressed runner results through a D1 compare-and-set, preserving idempotent retries and rejecting conflicting completions. Completed artifacts arriving after cancellation remain available for audit. `sandbox.ts` dispatches to a native Cloudflare Container with internet disabled. `crates/rio-runner` implements the authenticated self-hosted Docker backend; both backends use `worker/runner/execute.py` and the same trusted Rust analysis entry point.
- `crates/rio-client` and `crates/rio-cli/src/endpoint.rs` submit immutable snapshots, poll/cancel, and cache report/audit artifacts. `deployment.rs` provisions resources in the caller's account through the Cloudflare API, borrows the caller's cf OAuth session or API token, and uploads the paired embedded Worker without a source checkout or Node build toolchain. Local offline deterministic behavior remains available. `docs/cloudflare.md` records deployment and live acceptance steps.

Local evidence includes real Miniflare Workflows/D1/R2 integration with recorded providers, signed runner protocol tests against actual Docker, immutable graph/static runner tests, schema/profile/CLI/rendering tests, and Wrangler deployment dry-run bundling. These establish implementation behavior, not the empirical model-precision gate. Task 9.2 remains pending until pinned live-model runs have independent artifact-backed verdicts and satisfy the 80% precision and high-severity recall requirements.

## D10. Expanded Cloudflare core

Implement TypeScript in `worker/`, with a Hono API and a Workflow instance per review. Durable steps pass R2 keys; D1 provides the review/step/job/usage ledger. Model providers are called from a budget-enforcing Worker module through authenticated Cloudflare AI Gateway in the default Rio deployment. Individual provider calls bypass caching and gateway log collection. Runner execution uses Cloudflare Sandbox or an independently authenticated Rust runner executing jobs inside disposable network-disabled Docker containers. Runtime reads refer to immutable snapshots; no repository command executes in the control plane. CLI endpoint submission uses the same resolved profile and local report contracts. Local tests exercise API/storage/workflow transitions with mocked models/runners; live account deployment and measured model precision are verified separately and never inferred from mock success.

## D11. Portable account-local deployment

The owner's 2026-11-06 clarification confirms PRD/TRD self-hosting: no account IDs, resource IDs or deployment secrets belong in checked-in configuration. `rio init` and `rio deploy` directly provision or reuse namespaced Worker, D1, R2, Queue, Review/Migration Workflows, AI Gateway and Sandbox resources using the caller's cf login or deployment API token. Account selection is explicit when multiple accounts exist. Choices persist in user TOML; `init --from` reproduces them non-interactively. Secrets use the OS keychain by default, with an explicit mode-0600 file option for headless environments. Provider credentials are Worker secrets; the separate AI Gateway credential is limited to account inference permission. An embedded generated Worker bundle avoids a source checkout and Node toolchain. Sandbox uses the paired released runner image copied with Docker/cf into the caller's registry (or an explicit custom image). D1 forward migrations run in a Workflow, with transactional lock/ledger records preventing interleaving. Offline dry-run performs no authentication, credential writes or account mutations.

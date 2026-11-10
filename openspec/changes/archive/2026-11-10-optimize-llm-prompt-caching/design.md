# Design

## Context

See proposal.md (Why) for the problems. This section records the current state the decisions rely on. The Worker paths were read at `a467ffd` and rechecked on main at `2ac7b22` (PR #16), which shifted `workflow.ts` by about 13 lines, so code is cited by symbol rather than line. Provider facts come from official documentation checked on 2026-11-09.

### Three caches, kept apart

| Cache | Where | What it reuses | This change |
|---|---|---|---|
| Agent result cache | `worker/src/cache.ts`, R2 + D1, per tenant | Whole hypotheses per hunk; skips the model call | Prompt hash gains the layout version and enabled layout features (D5) |
| AI Gateway response cache | Cloudflare, keyed on the full request body | A whole response to an identical request | Stays bypassed: `cf-aig-skip-cache: true` on every gateway request (`route()` in `gateway.ts`) |
| Provider prompt (KV) cache | Anthropic, OpenAI, OpenRouter upstreams, self-hosted servers | Computed attention state for a byte-identical prefix; the generation stays fresh | The subject of this change |

### Production model-call inventory

| # | Path | Entry | Phase / actor | Shape | Retries |
|---|---|---|---|---|---|
| 1 | Specialist generation (`rio/agents`, `rio/security`; agents incl. `contracts`, `security`) | `ReviewWorkflow` agents step (the "Review the change independently for ${agent}" prompt) → `converse` | `generation` / `${step}-${agent}` | Multi-turn JSON tool loop, ≤16 turns, ≤8 tools per turn | Gateway: one retry on 429/5xx/missing content or usage, same body (`ProviderGateway.complete`). Workflow step `model-${actor}-${phase}-${turn}`: no retry, result memoized in R2 so replays never re-call |
| 2 | Blind verifier inspection | `verifyHypothesis` (`verifier.ts`) → `converse`, phase `verify-blind` | `verify-blind` / `${hypothesis}-${voter}` | Multi-turn; voters in concurrent batches of 4, hypotheses sequential | as 1 |
| 3 | Disclosed verification | `verifyHypothesis` → `converse`, phase `verify-disclosed`, same `messages` array | `verify-disclosed` | Appends one user message after `o.save(vote)` | as 1 |
| 4 | Malformed-reply repair | inside `converse` | same as caller | Appends raw reply excerpt (≤4000 chars) + `REPAIR` | n/a |
| 5 | Council vendor member | `ReviewWorkflow` council step → `gateway.complete` | `council` / `council-${role}` | Single-shot per round (`memberRequest`, `council-pack.ts`), rounds 1 and 2. Its record is written by the council audit, not by the `call` wrapper | Step retries 0; no `converse` |
| 6 | Council self-hosted member | `ReviewWorkflow` council step → model job → `crates/rio-runner/src/model.rs` | `council` | Single-shot OpenAI-compatible request on the runner's endpoint | none |

**QA call paths.** `rio-v0-3-qa` is implemented on branch `t3/review-qa-ux-specs`, open as PR #17 at `56c81c3` (synced 2026-11-10). On that branch the change is archived (`d5cd74b`, `openspec/changes/archive/2026-11-10-rio-v0-3-qa`) and its specs are synced into `openspec/specs`. The synced specs modify `verifier-quorum` but not "Two-turn blind verification", and do not touch `model-providers` "Unknown cost stays unknown", so this change's MODIFIED requirements still apply. Three QA behaviours matter here:
- `step_done` returns a viewport screenshot to the harness, so harness conversations carry images.
- `responseRequest` (`provider-transport.mjs`) moves images out of tool results into one user message, `Screenshots returned by the preceding tool results.`, after the consecutive tool results. A tool result left without content becomes `Screenshot follows.`.
- `dropStaleImages` (`model-proxy.mjs`) runs on the Responses body before the transport and replaces every image except the newest with the text part `[earlier screenshot omitted]`. `responseRequest` then sees no image in that tool result: the tool message gains the placeholder text and the follow-up user message disappears. So when a new screenshot arrives, the previous one's turn is re-rendered in a different shape, not just a different image. D16 fixes this before any QA hint is added.

The paths exist only once PR #17 merges, so D16 and task group 10 are sequenced after it.

| # | Path | Entry | Request built by | Sent through | Shape | Usage today |
|---|---|---|---|---|---|---|
| 7 | QA journey harness (Codex by default, pi optional) | `controller.mjs`: one `ModelProxy` per chain × cell; prompt from `prompt()` in `session.mjs` plus the origins suffix in `cell.mjs` | Harness (base instructions, tool schemas, history); Rio supplies the user prompt | Hosted: proxy → Worker `qa-model.ts` → `providerTransport` (`provider-transport.mjs`), which rewrites Responses into Chat Completions or Anthropic Messages. Local: proxy → host relay → `providerTransport` with the developer's key. Subscription (local Codex): straight to OpenAI | Multi-turn tool loop; a fresh harness per journey; journeys strictly sequential; one whole-cell retry after a harness crash | `responseResult` reads Anthropic `input_tokens` alone and reports `cached_tokens: 0`; `qa-model.ts` prices input × `input` only |
| 8 | QA authoring (`rio qa author`, setup author; local) | `author.mjs`, `setup-author.mjs` | Harness; Rio supplies instructions, `SKILL.md`, context, criteria (author) or setup data then schemas (setup) | as 7, local | One multi-turn session | as 7 |
| 9 | QA hypothesis verification | `qa-review.ts` → `verifyQaCandidate` (`qa-verifier.ts`) → `converse` | Rio | Worker gateway | System is the fixed `SYSTEM` for both turns; blind message `"Assess the ${version} snapshot.\n" + qaBlindPrompt(pack)` (instructions, then data blocks) plus screenshots as images; disclosed turn appended to the same messages; up to 4 voters concurrent; packs memoized per journey, step, cell and version | as 1 |
| 10 | QA recommendation verification | `qa-verifier.ts` recommendation voters (their blind prompt is derived from the hypothesis prompt by `.replace`), `qa-review.ts` | Rio | Worker gateway | as 9 | as 1 |

`providerTransport` rebuilds every request from a whitelist of fields, so any `prompt_cache_key` or cache field a harness sends is dropped today. It also runs on both hosted and local routes, which makes it the single place for QA hints. Subscription mode never reaches Rio and stays out of scope.

**Scope.** This change covers paths 1–10: every request Rio builds, plus the requests QA harnesses send through Rio's QA transport. Rio cannot reorder what a harness owns (its base instructions, tool schemas, compaction and any context items it adds), so for paths 7–8 only Rio's own prompt text, the transport's rendering and hints, and the usage normalization are in scope.

Routes (`route()`, `gateway.ts`): `anthropic/`, `openai/`, `openrouter/` (direct, or through the gateway's provider endpoints), `custom-SLUG/` (gateway custom provider, protocol from `AI_GATEWAY_PROVIDERS`), `compat/P/M`, `dynamic/R`, and `openai/custom-*` or `openai/dynamic/*` with a gateway (all three through the unified `/compat/chat/completions` endpoint). Wire today: Anthropic gets `system` as a string, string message contents and no cache fields. OpenAI-protocol gets a `system` message first, string contents, `response_format: json_object`, and on OpenRouter also `provider.require_parameters: true`.

### Prefix reuse today (question 1)

| Content | Size today | Identical across | Reused today? |
|---|---|---|---|
| `SYSTEM` + hypothesis item schema | 4,411 bytes (`SYSTEM` alone 1,748) | every generation and blind call on one model, across agents, reviews and tenants of a deployment | Only by automatic-caching providers, and only where it is long enough |
| `SYSTEM` + vote schema | 2,593 bytes | disclosed calls only | Breaks the voter's prefix right after `SYSTEM`, at ≈1.75 KB (problem 1) |
| Generic agent instructions | ≈1.2 KB | all agents, but placed after the agent name | No (problem 2) |
| Review context: intent, graph excerpt ≤2×16 KB, checks, changed code, guidance, lineage round | typically 20–80 KB | agents of one review with the same model and scope | No (problem 2) |
| Agent prompt and agent data (contract inventory; catalog + taint map) | 2–3 KB + data | one agent | n/a (assignment) |
| Blind context: location, symbol code capped at 2×24k characters (UTF-16 length, not bytes), callers, intent, guidance | not bounded in bytes; typically tens of KB | all voters of one hypothesis (deterministic, `blindContext`) | Automatic providers only, and only after the first batch's cold writes |
| Conversation turns | grows to 160 KB | turn to turn within one conversation | Automatic providers only; Anthropic never |
| Council system: `COUNCIL_SYSTEM` + role prompt | ≈3.2 KB | one role across findings and reviews | Below most minimums on its own |
| Council rendering | pack-dependent | one member across rounds | No (problem 3) |

Deterministic already: `dataBlock` (`JSON.stringify` of insertion-ordered objects, then escaping), `scrub` (pure regex), `promptGraph` (ranks nodes to select them, then emits the selected nodes in their original graph order, which is itself deterministic), tool-result serialization, the repair excerpt. Assistant replies are stored as `JSON.stringify(parsed)`, which differs from the raw reply bytes. That does not hurt reuse: a reply is never part of a prefix until the next request sends it, and it stays fixed from then on.

### Prefix breaks (question 2)

1. Verifier system prompt changes per phase (the phase-specific schema in `converse`).
2. Agent name and the result-format sentence come before the shared review context (the agents step prompt in `ReviewWorkflow`).
3. Council round header comes before the rendering (`memberRequest`).
4. Elision rewrites history in place, possibly every turn near the limit (`elideOldToolResults`).
5. Scope narrowing by result-cache hits changes the review context per agent. That is legitimate: the content really differs.

No timestamps, nonces, review ids or voter indices appear in the shared layers. Volatile identifiers do appear later: tool results and council renderings carry job ids, and the disclosed hypothesis carries its id. They sit in a conversation's own suffix or in content that is identical for every call that reuses it (one member's rendering across rounds), so they do not break a reusable prefix.

### Discarded usage (question 4)

`ProviderGateway.complete` keeps only `input_tokens`/`output_tokens` (Anthropic) or `prompt_tokens`/`completion_tokens` (OpenAI). It drops `cache_read_input_tokens`, `cache_creation_input_tokens` and `cache_creation.*` (Anthropic), and `prompt_tokens_details.cached_tokens` and `cache_write_tokens` (OpenAI, OpenRouter). It also drops OpenRouter's `cache_discount`. `converse` copies only `input_tokens`, `output_tokens` and `cost_usd` into `ledger.settle`, and the council paths in `ReviewWorkflow` do the same: vendor settlement after `gateway.complete`, self-hosted settlement after the model job (which checks only `Number.isInteger` on the runner's totals) and the zero refund of an undispatched self-hosted call. The runner reads usage with `as_u64`, which silently turns a negative or fractional count into an absent one. The runner keeps only `prompt_tokens` and `completion_tokens`. The D1 `usage` table has no cache columns. The `ModelResponse` type has no cache fields.

### Provider facts used (question 3)

- **Anthropic Messages.** Opt-in through `cache_control: {"type":"ephemeral"}` on blocks, or a top-level field for automatic mode. At most 4 breakpoints. Prefix order is `tools` → `system` → `messages`. A breakpoint finds an earlier entry only within 20 blocks before it. Minimum cacheable length is 512–4096 tokens depending on model; shorter prefixes are silently uncached. Default TTL 5 min, refreshed on use; `ttl: "1h"` optional. Writes cost 1.25× (5 min) or 2× (1 h); reads 0.1× (0.05× on Opus/Sonnet 5.5, 0.025× on Fable/Mythos 5.1). `input_tokens` excludes cache reads and writes, so total = `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. A cache entry is available only after the first response starts. Isolation is per organization, and per workspace on the Claude API.
- **OpenAI Chat Completions.** Caching is automatic from 1024 tokens. `prompt_cache_key` is a routing hint: around 15 RPM per key before GPT-5.6; on GPT-5.6+ it separates cache accounting and prevents cross-user probing. On GPT-5.6+ the automatic breakpoint sits at the end of the latest user message, so a reusable prefix must end at a message boundary unless an explicit content-part `prompt_cache_breakpoint` is sent. `prompt_cache_retention` is deprecated in favour of `prompt_cache_options` (GPT-5.6+). Usage reports `prompt_tokens_details.cached_tokens` and `cache_write_tokens`, both inside `prompt_tokens`. Writes are free before GPT-5.6 and 1.25× on GPT-5.6+ (30 min). Isolation is per organization.
- **OpenRouter.** Automatic for OpenAI, DeepSeek, Grok, Groq, Moonshot, and Gemini 2.5+ implicit. Anthropic needs `cache_control`, on content parts in OpenAI-format messages or at top level; Gemini explicit caching uses only the last marker. Sticky provider routing is best effort: it hashes the first system message and the first non-system message, applies only after a request has been served, and is disabled by `provider.order`. Usage reports `prompt_tokens_details.cached_tokens` and `cache_write_tokens`, plus `cache_discount`. `usage.cost` is the billed amount.
- **Cloudflare AI Gateway.** Response caching is keyed on the full body and controlled by the `cf-aig-*` headers; it is unrelated to provider prompt caching. Provider endpoints pass the provider's native body through. The documentation does not say whether `/compat` translates `cache_control` or reports cache usage.

### Overlap with specs and changes (question 6)

- `openspec/specs/model-providers` (routing; "Unknown cost stays unknown"): modified by this change. No active change touches it.
- `openspec/specs/verifier-quorum` "Two-turn blind verification": modified here. QA's synced specs change other `verifier-quorum` requirements and add QA blind-turn requirements that stay compatible, since this change touches only the generic transition. QA voters already keep one system prompt across both turns.
- `rio-v0-3-qa` (PR #17, archived on its branch): its migrations `0007_qa_seeds.sql`–`0011_qa_retention.sql` collide with main's `0007_council.sql` and `0008_announce.sql`, so QA must renumber when it rebases. `qa_model_usage` is created by its `0008_qa_runs.sql`. This change's Worker migration takes the next free number on main when it is written and touches only tables on main; the QA columns get a separate migration in group 10 (task 10.1), written after PR #17 has merged. PR #17 also edits `gateway.ts` (images, a `system` override, `validateResult`), the file this change edits most; whichever lands second rebases.
- `rio-v0-3-council` (27/29 tasks; 7.3 A/B pending) owns the council specs, which are not archived. This change does not modify them. Its council layout requirement lives in `prompt-layout`. Because the tenant partition and Anthropic breakpoints would also change council text and cost, task 7.3 runs on a pinned build from before this change (D15), and the council layout task is sequenced after 7.3.
- `rio-v0-3-core` `agent-result-cache` (not archived): "prompt hash" already belongs in the key. This change only widens what the hash covers (D5), so no delta is needed.
- `review-report` JSON renderer: `agent_audit` allows extra properties. The new metrics are specified in `model-usage` to avoid a third MODIFIED copy of a requirement that core, council and qa already modify.

## Goals / Non-Goals

**Goals:** stable, deterministic prefixes aligned with actual reuse; explicit, minimal cache hints only where a route is known to accept them; usage and cost accounting that is correct with and without caching; tenant partitioning of private prefixes; replay-stable prompts; enough telemetry to measure the effect later; every behaviour change switchable on its own, so each can wait for its gate.

**Non-Goals (design level):** no new runtime dependency; no streaming (time to first token is measured only by the live procedure, outside the Worker); no change to `MAX_OUTPUT_TOKENS`, turn limits, tool limits or the reservation formula; no per-tenant provider keys or workspaces; no change to harness-owned prompt parts or to QA subscription mode (see Scope).

## Decisions

### D1. A prompt builder that emits parts, and a renderer per capability

`worker/src/prompt.ts` builds requests from `PromptPart = {text, layer, cache?: true}`. `system` and each message `content` become `string | PromptPart[]`. Parts carry their own separators, so `parts.map(p => p.text).join("")` is exactly the text sent on a `none` route. That makes the no-capability wire byte-identical to a plain-string rendering of the same text, and gives one place to test determinism. `converse` keeps owning the conversation loop. `verifier.ts`, the agent step and `memberRequest` call builder functions (`generationRequest`, `blindRequest`, `disclosureMessage`, `councilRequest`) instead of concatenating template strings.

*Alternatives:* keep string templates and insert sentinel markers that the gateway splits (fragile, and markers could collide with repository data); one universal builder with every specialist's instructions in the system prompt (rejected: large prompts for every call, and the system prompt would then change whenever any agent prompt changes).

### D2. Layer boundaries follow measured reuse scope

| Layer | Generation | Blind verify | Disclosed verify | Council |
|---|---|---|---|---|
| 1 Shared protocol + schema (system, `cache`) | `SYSTEM` + hypothesis item schema | same text (`verifier-system`) | same text (`verifier-system`) | `COUNCIL_SYSTEM` + role prompt (`cache`) |
| 2 Stable instructions | generic generation instructions | blind question | — | — |
| 3 Tenant partition (D14) | partition line | partition line | — | partition line |
| 4 Immutable review context (`cache` at end) | round context, intent, graph excerpt, checks, changed code, scoped guidance | location, code and callers, intent, scoped guidance | — | rendering (`cache` at end) |
| 5 Assignment | agent name, agent instructions, agent data, suggested focus, result shape | — | disclosure instructions + vote schema + hypothesis | round header (+ round-2 blocks) |
| 6 Conversation (`cache` on last message) | replies, tool results, repairs | same | same | — |

Owner guidance is folded into the review context (D3). At most three markers are used per request (system, end of review context, tail), under Anthropic's limit of four. The tail marker moves to the last message on every request; the previous request's tail entry is one turn (two or three blocks) back, well within the 20-block lookback.

Without `agent-order` the generation request keeps today's order (agent name and result shape first), with the partition line inserted before the review context. Without `verifier-system` each verifier phase keeps today's system prompt, so layer 1 then differs between the blind and disclosed turns. Without `council-order` the council content keeps today's order (round header, then rendering), with the partition line at the start of the user content.

### D3. Owner guidance is not a separate project layer

Guidance is scoped to the reviewed paths (`scopedGuidance`) on purpose, so it is review-dependent, not project-stable. A project-wide layer would need unscoped guidance (more tokens, weaker focus) and would pay off only when two reviews of one project share a full prefix within the 5-minute TTL, which is rare. It stays inside the review context, still as data. Revisit only if the live procedure shows frequent same-project bursts (for example PR `synchronize` storms).

### D4. Verifier: one system prompt, schema with the disclosure (`verifier-system`)

Both verifier phases use the generation system prompt (`SYSTEM` + hypothesis item schema), which the blind phase already needs. The vote-answer schema moves into the disclosure message, which is built only after `o.save(vote)` returns. The disclosed request is then the blind conversation plus one message. As a side effect, verifier calls share layer 1 with generation calls on the same model.

The disclosed turn then also carries the hypothesis schema, about 1.8 KB more of the voter's byte-bounded reservation. At the default fast budget a voter's allowance is about 6.6k tokens (`tokens / agents_max / 5`), so this alone could exhaust voters that complete today. Before the disclosed turn the voter therefore checks whether the shared form fits its remaining allowance (the same bound `converse` enforces); if not, it sends the disclosure exactly as with the feature off. The feature never exhausts a voter's first disclosed turn that would fit without it; the layer hashes in the call records show which form each voter used.

This changes where the vote schema reaches the model, so it is a layout feature with its own quality gate (D15): verifier agreement with the reference labels, and the rates of exhausted, malformed and incomplete votes, must not degrade beyond the gate margins.

*Alternative:* both schemas in the system prompt for both phases. That adds ≈1.6 KB to every generation call, ties the generator's system prompt to the verifier's schema, and tells blind voters that a verification turn follows. Rejected.

### D5. Agent prompt reorder is a prompt-version change (`agent-order`)

Shared instructions → partition → review context → assignment. The text does not change, only its position. The agent-specific result-format sentence ("Return {result:hypotheses[]}") moves into the assignment. Because order can affect model behaviour, this is treated as a prompt change:
- `cache.ts` adds a `PROMPT_LAYOUT_VERSION` constant (bumped for the partition line) and the sorted set of enabled layout features to the hashed prompt input, so result-cache entries made under another layout are not replayed. The partition value is not hashed: the result cache is already keyed per tenant, and hashing it would only make a partition reset discard that tenant's results;
- the feature ships off by default; its gate is the eval comparison (D15).

### D6. Council rendering before the round header (`council-order`)

`memberRequest` returns content = rendering + round header (+ round-2 blocks), with `cache` after the rendering. The audit's `rendering_hash` continues to hash exactly what was sent. Sequenced after `rio-v0-3-council` 7.3, and off by default until the council gate passes (D15).

### D7. Explicit breakpoints with the default TTL; mark only what is reused

All `breakpoints` and `parts` routes use explicit block markers. Top-level automatic mode is not used: one scheme then serves direct Anthropic, gateway Anthropic, custom Anthropic and OpenRouter, the slot count stays predictable, and legacy Bedrock integrations that reject the top-level field are avoided. No `ttl` is sent (5 min). Agents run sequentially and verifier turns follow within seconds, so 5 minutes covers the observed reuse. 1-hour writes cost 2× and are left for the measurement to justify.

Write premium: on Anthropic a cold breakpoint costs 1.25× on the newly written tokens, and pays back at the first read (0.1× or less). Markers are therefore placed only where a reread is expected: the system prompt (every call), the review or blind context (turn 2 of the same conversation already rereads it), the tail (the next turn), and the council rendering (round 2). Not marked: the tail of a single-shot council call and of round 2. The unavoidable waste is the last turn's tail write, 0.25× of one turn's delta. Whether this nets out cheaper is the billed-cost gate (D15); until then Anthropic hints are off by default.

### D8. Voters: concurrent and cold by default

With 3 voters started together, each pays a cold write of the blind context: about 3 × 1.25 = 3.75 units, against 1.25 + 2 × 0.1 = 1.45 if voters 2 and 3 waited for voter 1's first response to start. Waiting adds one time-to-first-token of latency to verification. Rio keeps the current concurrent fan-out (the `Independent generations` requirement). The live procedure measures the staggered variant, and any adoption would be a separate change with its own cost and latency evidence.

### D9. Route-specific fields

- `key` (OpenAI built-in, direct or gateway `openai/` endpoint): `prompt_cache_key = sha256("rio-pck\0" + tenant + "\0" + review + "\0" + root)`, truncated to 32 hex characters. The root is the literal `generation` for every generation call of the review (agents share review context), `verify:` + hypothesis id for that hypothesis's voters, and `council:` + finding id + `:` + member role for one council member, stable across its two rounds. This keeps each key's request rate near OpenAI's guidance and separates tenants. A long multi-turn generation phase could still exceed about 15 requests a minute on the one `generation` key, which is why the live procedure compares key and no key before the class can become a default (task 8.1). Not sent with `OPENAI_BASE_URL`, since arbitrary compatible servers may reject unknown fields.
  What it buys is limited and stated as such. Within one conversation and across the voters of one hypothesis, each reusable prefix ends at a message boundary (the previous request's last message, or the identical blind-context message), so automatic caching can reuse it. Across agents it cannot on GPT-5.6+: the shared review context and the agent's assignment sit in one user message, and the automatic breakpoint is at that message's end. Rio does not claim cross-agent reuse on OpenAI. Explicit `prompt_cache_breakpoint` parts would fix that but need model-version detection; they stay a non-goal until the live procedure shows the gain is worth it.
- `parts` (OpenRouter `anthropic/*`, `google/gemini*`): content-part `cache_control`. No `prompt_cache_key` or `session_id`: neither is needed for correctness, and their effect through OpenRouter is unverified. Provider stickiness is best effort (it applies only after a first request is served, so it does not help concurrent cold voters), and the live procedure measures how often a conversation stays on one upstream.
- `none`: the body today's renderer would send for the same text. The capability comes from static tables in `route()`, never from probing, and is never adjusted by retrying with fields removed: a 400 is a configuration error and surfaces as today.

### D10. Usage normalization; budgets on total tokens

`ModelResponse` and `Usage` gain `cache_read_input_tokens` and `cache_write_input_tokens` (`number | null`) and `usage_convention`; `input_tokens` becomes total input on every protocol. `null` means the provider did not report a usable value for that field. Normalization:
- Anthropic: total = `input_tokens + (cache_read_input_tokens ?? 0) + (cache_creation_input_tokens ?? 0)`; each cache field is reported if present.
- OpenAI protocol: total = `prompt_tokens`; read = `prompt_tokens_details.cached_tokens`; write = `prompt_tokens_details.cache_write_tokens`.
- **Conventions.** Whether cache counts are inside `prompt_tokens` is a property of the upstream, and the inequality reads + writes ≤ `prompt_tokens` cannot prove it. A static table in `route()` marks a usage convention as `verified` only where official documentation and recorded fixtures agree: the Anthropic Messages protocol, and built-in OpenAI without `OPENAI_BASE_URL`. Every other OpenAI-protocol route (OpenRouter, `compat/`, `dynamic/`, custom, `OPENAI_BASE_URL`) and every self-hosted endpoint is `unverified`: Rio charges `prompt_tokens` exactly as it does today, records the reported cache counts, does not apply the inequality, and leaves those calls out of cache ratios. A route class becomes verified through a follow-up after the live check (task 8.3) confirms its convention; for OpenRouter that check is also the `openrouter` hint gate.
- **Invalid fields.** A present cache field that is negative, fractional or not a safe integer, or, on a verified route, cache counts that break the inequality, is invalid.
  - On a verified route an invalid field fails the call with "provider reported invalid cache usage". Unlike a reply without content or usage, a reply with valid input and output counts was a real, billed generation; retrying it under the same reservation could let two generations settle as one. The error is outside the retry rule, and the call keeps its whole reservation, as every failed call does today. The reservation is an upper bound on the attempt's input plus output, so the budget is never under-charged. Total input on Anthropic depends on these fields, which is why failing is the only safe choice there.
  - On an unverified route the call succeeds as today: input is charged as `prompt_tokens`, which does not depend on the cache fields, and the invalid fields are recorded as `null` with convention `invalid`. So no route charges less or fails more often than today because of this change, whatever its hints.

`converse`, council vendor settlement and self-hosted settlement pass the new fields through to `ledger.settle`; the undispatched refund settles zeros with null cache fields. Self-hosted counts follow the unverified rule: the runner passes the endpoint's `cached_tokens` through as the raw JSON value, and the Worker records it as a cache read only if it is a safe integer between 0 and the reported input, otherwise as `null` with convention `invalid`; the member call itself is unaffected. The ledger charges total input + output, exactly as the reservation bound assumes. Caching lowers money and latency, never budget consumption. A review's outcome does not depend on cache state, budgets stay comparable across providers, and enabling Anthropic caching cannot silently under-charge.

### D11. Cost

Priority order: OpenRouter `usage.cost` (`provider`), then `MODEL_PRICES` (`estimate`), then `null` (`unknown`). Self-hosted calls are 0 (`self-hosted`). `MODEL_PRICES` entries gain optional `cache_read` and `cache_write`. The Rust `ModelPrice` gains two `Option<f64>` fields, so `deny_unknown_fields` still accepts old configurations. When cache tokens are non-zero and a rate is missing, the cost is unknown. Rio does not fall back to the input rate (that would overstate reads 10–40×) or to the provider's multipliers (prices change per model and over time). Anthropic writes are priced with one rate because Rio writes only 5-minute entries. Cloudflare's `cf-aig-custom-cost` header is not used: it changes the gateway's own analytics, not what Rio records.

### D12. Compaction hysteresis (`compaction`)

`elideOldToolResults(messages, high = 160 KB, low = 96 KB)`: no-op at or below `high`. Above it, elide oldest-first until ≤ `low` or only the two most recent results remain, and return the count, which `converse` adds to the call audit as `{turn, elided}`. A conversation near the limit then pays one prefix break per checkpoint, not one per turn. The cost is that the model loses older tool results sooner and may call the tools again; the 16-turn limit and the token allowance still bound this. Because that can change outcomes, the feature ships off (today's elide-to-160 KB stays) and its gate (D15) compares turn counts, exhausted and incomplete rates, and accuracy. The low-water mark is a constant tuned by measurement, not a profile option.

### D13. Telemetry

- D1 `usage`: new nullable columns `cache_read_tokens`, `cache_write_tokens`, `usage_convention` (`verified`, `unverified`, `invalid`) and `cost_source`.
- Model-call record (`reviews/{id}/models/{name}.json`, written by the `call` wrapper): `layers: [{layer, sha256, bytes}]`, computed over the rendered text. No text, keys or headers. Council vendor calls are not written by the `call` wrapper, so the council audit entry gets the same `layers` field beside its existing `rendering_hash`.
- Report: `agent_audit.prompt_cache` per phase (`model-usage` spec), plus the enabled layout features and hint classes. Calls with an `unverified` or `invalid` convention are counted separately and excluded from ratios. `verification_usage` is unchanged in meaning.
- Council self-hosted: the runner adds `cached_input_tokens` to its artifact when the endpoint reports it.

### D14. Tenant partition before private content

Provider caches are isolated per organization (Anthropic also per workspace on the Claude API). A Rio deployment uses one key per provider, so its tenants share that organization's cache. If two tenants' prefixes could match through repository content, a tenant able to guess another tenant's likely content (an open-source diff, a public dependency) could learn from latency or cache usage whether that content was reviewed recently. This exists today on automatic-caching routes, independent of any hint.

Every request therefore carries a tenant partition element between the shared layers (1–2) and the first repository-derived content: `<review_partition id="P"/>`.

- **Per-tenant random value.** A D1 table `prompt_partitions(tenant PRIMARY KEY, secret)` holds 32 random bytes per tenant. The review's prompt-configuration step (D15) creates the row with `INSERT OR IGNORE` and reads it back, so two first reviews of one tenant racing each other agree on one value. The row is never updated.
- **Per-provider value.** `P = hex(HMAC-SHA256(secret, provider))[0..32]`, where `provider` is the route's provider identity (`anthropic`, `openai`, `openrouter`, `custom-SLUG`, `compat`, `dynamic`, or the self-hosted endpoint's host). One tenant's requests to one provider share `P`, which is what reuse needs; different providers see unrelated values, so the pseudonym cannot be correlated across providers, and none can be computed from another without the secret.
- **What it is.** The partition only has to differ between tenants: Rio inserts it, so no tenant can choose or forge another's. `P` is a pseudonym, not a credential: each provider sees a stable value per tenant, as it already sees a stable API key. The secret itself is never sent to a provider and never written to records, reports, logs or Workflow step state; it is readable only by operators with D1 access. No deployment secret, `rio deploy` step or rotation procedure is needed. Deleting a tenant's row gives it a new pseudonym from its next review; its result-cache entries are unaffected (D5).
- **Echo.** A model may repeat `P` in its reply. Before reply text is persisted as a hypothesis, vote rationale, council assessment or any report or check-run text, every occurrence of the review's partition values is replaced with `[partition]`. Raw model-call records stay operator-only, as today.

*Alternative considered and dropped:* deriving `P` from a deployment secret (`PROMPT_PARTITION_KEY`) through an HMAC seed per review. It needed a generated Worker secret, a seed memoized in Workflow state, a missing-key failure and rotation rules, and its secrecy bought nothing, because the value only needs to be distinct and Rio-controlled.

Layers 1–2 stay identical across tenants and keep their cross-tenant reuse, which is public text anyway; repository context, blind context and council renderings become per-tenant prefixes. The cross-tenant reuse that is lost was negligible: it needed byte-identical private content.

The element is always on, on every route, because it closes a leak rather than adding a hint. It is a fixed data element with no instruction. Because it is the one model-visible change at the defaults, it reaches main only with a passed partition gate (D15). The OpenAI tenant-scoped `prompt_cache_key` is defence in depth on top. Hard isolation (separate provider workspaces or keys per tenant) stays outside this change.

### D15. Switches, validation, gates and milestones

Two Worker variables control every behaviour change; everything else (builder, partition, normalization, cost sources, persistence, metrics, response-cache bypass) is always on.

| Variable | Values | Default in this change | Gate before the default changes |
|---|---|---|---|
| `PROMPT_CACHE` | `off`, or a comma list of `anthropic`, `openai`, `openrouter` | `off` | `openai`: on the live procedure, key versus no key, the median cache-read ratio per phase is not lower with the key and the median billed cost is not higher. `anthropic`: median billed cost per phase is not higher with hints than without. `openrouter`: OpenRouter's usage convention for Anthropic and Gemini upstreams is confirmed against the fixtures, and the `anthropic` cost check passes |
| `PROMPT_LAYOUT` | comma list of `agent-order`, `verifier-system`, `compaction`, `council-order`, `qa-order` | empty | `agent-order`: per-agent precision and recall on the `eval/` reference set. `verifier-system`: verifier agreement and exhausted/malformed/incomplete vote rates. `compaction`: turn counts, exhausted and incomplete rates and accuracy on long conversations. `council-order`: the council A/B metrics from `rio-v0-3-council` 7.3. `qa-order`: on the QA reference fixtures, journey completion, step coverage, `not_assessed` rate and QA finding precision and recall |

Every hint class ships off, including `openai`: one `generation` key per review may exceed OpenAI's per-key rate and route worse than no key, so it gets the same evidence rule as the rest.

**Validation and per-review configuration.** An unknown value in either variable is rejected three times over, each before any model work: `rio deploy` validates both from `config.toml` before any account access and uploads them as Worker variables; review submission (`reviews.ts`, beside `checkProfileModels`) rejects the review naming the value; and the review's prompt-configuration step rechecks them in case a variable changed after submission, failing before any reservation. That step is a memoized Workflow step at review start. It returns the normalized settings and ensures the tenant's partition row exists (D14). Every later step uses its output, so a replay after a restart or a variable change rebuilds byte-identical requests, and a change applies from the next review on. Reviews in flight when this Worker is first deployed have no such step: they run it on their next replay, and only their calls not yet made use the new layout, because finished model steps are memoized. The replay guarantee covers reviews started on this Worker.

**Gate procedure.** Each quality gate compares three arms: the pinned pre-change build (the last commit before this change's first code commit), the new build with all features off, and the new build with the one feature under test on. Each arm runs the full reference set 3 times; metrics are means over the runs. A feature passes when it is non-inferior to the all-off arm, and the partition passes when the all-off arm is non-inferior to the pinned build, within these margins:
- precision, recall, verifier agreement, journey completion and step coverage: no lower than 2 percentage points below;
- exhausted, malformed, incomplete and `not_assessed` rates: no more than 1 percentage point above;
- median turns per conversation (`compaction`): no more than 1 turn above.

Cost gates use 5 repetitions per arm and compare medians. Council 7.3 runs on the pinned pre-change build, so neither this change's partition line nor Anthropic hints move its baseline.

**Enforcement.** Gate results are recorded in `docs/evaluation/prompt-caching-gates.json` (gate, build commit, arms, per-run metrics, verdict). A Worker unit test reads the default switch values and fails when a default enables a feature or class without a passed record, and fails when partition insertion exists without either a passed `partition` record or an explicit `partition` entry in the file's `pending` list. Only the partition may be pending: it is the one model-visible change that is always on, and a suite that stays red until a paid run would hide every other failure. The pending entry is the release blocker, visible in reviewed source: the commit adding the partition (task 2.4) merges to main only after the follow-up replaces it with a passed record; groups 0–1, which change no model-visible text, can merge before it.

**Milestones.** **Implemented** (this change): every feature exists, is tested deterministically, and has its switch. **Released**: main carries the partition only after its gate passed, as enforced above; if it fails, the element's form or position is revised and the gate rerun, and tenant separation itself is not made optional. **Approved as default** (follow-up, one per feature or class): the gate passed on the live procedure or eval, and a small change flips the default with its record. A failed gate leaves that feature off without affecting the others.

### D16. QA call paths

QA gets the same rules, applied where Rio controls the request.

- **Usage first.** `responseResult` in `provider-transport.mjs` uses the shared normalizer (D10, including conventions and the no-retry failure for invalid fields on verified routes). It reports total input in `input_tokens` and the provider's cache reads in `input_tokens_details.cached_tokens`, instead of Anthropic's uncached remainder and a hard-coded 0. The controller `ModelProxy` already settles `total_tokens`, so cell budgets charge total tokens once the total is right. `qa-model.ts` records cache reads, writes, convention and cost source in `qa_model_usage` and prices through the shared cost function (D11). The columns come from a QA-specific migration written after PR #17 merges, not from this change's Worker migration.
- **Shape-stable screenshot replacement.** Before any hint is added, `dropStaleImages` and `responseRequest` are changed so that a replaced screenshot keeps the message and position the screenshot had: the transport routes the placeholder in a tool result the same way as an image, into the follow-up `Screenshots returned…` user message. The tool message and that user message keep their text, and only the image part becomes `[earlier screenshot omitted]`. Everything before the replaced image is then byte-identical to the earlier request. This also helps OpenAI's automatic caching with no hint at all.
- **Hints in the transport.** `providerTransport` takes an optional `cache` argument `{capability, key}` computed by its caller. In the Worker (`qa-model.ts`) it comes from `route()` and the run's prompt configuration (D15). On the local relay it comes from the route and the configured classes; local runs use the developer's own key. Rendering follows D7 and D9:
  - Anthropic: up to four markers, in this priority. (1) The last system block, which also covers the tools before it. (2) The last block of the request, which the next request rereads whenever no new screenshot arrived in between. (3) The block before the newest image, an entry later requests read once that image has been replaced. (4) The block before the most recent placeholder, placed exactly where marker (3) sat when that screenshot was newest, so the read never depends on the 20-block lookback, however many tool turns passed between screenshots; without a placeholder, the end of the run-stable part of the first user message when the boundary line (below) is present. So a turn without a new screenshot rereads everything up to the previous tail, and a turn after one rereads everything up to the previous screenshot.
  - OpenAI built-in: `prompt_cache_key = sha256("rio-pck\0" + tenant + "\0" + run + "\0qa\0" + cell)`, one key per cell so each key's rate stays near one sequential harness. The local host relay serves one run and never sees which cell a request came from, so locally the key is `sha256("rio-pck\0local\0" + run + "\0qa")`; the local route's optional `prompt_cache` list names the enabled classes, and the endpoint URL (not the model alias) decides the capability and the usage convention.
  - OpenRouter: content parts as in D9, under `openrouter`.
  - Harness-supplied cache fields stay dropped: the transport owns hints, so a harness cannot pick another tenant's key.
- **Boundary line instead of message splitting.** A harness sends Rio's prompt as one text part, so the transport cannot see layers. Rio's prompt therefore puts a fixed line, `Journey task (changes per journey):`, between the run-stable data and the journey data. The transport splits the first user text at its first occurrence to place the marker. The concatenated text never changes, so a split at a wrong place (for example if owner guidance contains the line) only moves the marker. It is never a correctness or security issue, which is why a sentinel is acceptable here when D1 rejects sentinels for Rio-built requests.
- **`qa-order` layout feature (journey prompt only).** The session prompt becomes: fixed instructions → tenant partition (hosted) → run-stable data (judged criteria, owner guidance and application origins, each only if identical for every journey of the run; otherwise it moves to the journey block) → boundary line → journey data (`journey`, `cell`, journey-scoped guidance). The origins move from the `cell.mjs` suffix into the stable block when run-stable. Journeys of one run then share everything through the boundary; today they diverge at the start of the JSON because `cell` and `journey` come first. Like every layout feature, `qa-order` ships off and has its own gate (D15). QA voters and the setup author are not reordered: voters already put their instructions before their data, and what voters of different candidates or versions could share is below every provider's minimum cacheable length; the setup author runs once per local session.
- **Partition.** Hosted runs get the partition value for the run's provider from the Worker in the QA job specification, and `session.mjs` inserts it. QA verification runs in the Worker and always carries it: `qaBlindPrompt` inserts it after its instructions and before the first data block, which also covers the recommendation prompt derived from it. Local and subscription runs send no partition, because no other tenant shares the developer's key.
- **What Rio does not touch.** Codex or pi base instructions, tool-schema order (the transport's `rio_tool_${i}` aliases are already deterministic), harness compaction and truncation, harness-added context items, and subscription mode.
- **Images.** The builder's parts gain an image variant so QA verifier requests keep screenshots after the blind text. The blind-context marker goes on the last image block, so screenshots are inside the cached prefix that later turns and the disclosed turn reread.

## Testing strategy

**Deterministic contract tests** (vitest with a capturing `transport`; no network, run in CI). Fixtures come in two kinds. *Pre-change fixtures* (task 0.1) are today's bodies. *Intended-change snapshots* record each deliberate change on its own: the partition line, and each layout feature. A snapshot test asserts that the diff from the previous fixture is exactly the intended change. Equivalence tests compare renderers on identical logical text, so a prompt change never makes a wire test fail.

1. Builder determinism: the same inputs built twice, and built after a simulated Workflow replay, give byte-identical bodies on every capability.
2. Layer order and suffix-only change (with `agent-order`): correctness vs tests with the same scope share the logical prefix up to the assignment; contracts and security add their data only in the assignment; a narrowed scope diverges at the first changed review-context block.
3. Tenant partition: two tenants with identical content have identical layers 1–2 and diverge at the partition line; one tenant's calls to one provider share the same value and different providers get different values; the value does not contain the tenant id or the secret; two concurrent first reviews of a tenant get the same value; the secret appears in no request, record, report, log or step output; a reply echoing the value is persisted with `[partition]`; the result-cache hash does not depend on the value.
4. Tool follow-up, repair and retry: each request's logical content (system text and the ordered role and text of each message) begins with the previous request's logical content. Cache markers, content-part splitting and request fields such as `max_tokens` are excluded from this comparison. Only a transient retry must be byte-identical to its first attempt.
5. Blind→disclosed (with `verifier-system`): the system text is equal across phases; the disclosed logical messages start with all blind messages; no blind request contains the vote schema, hypothesis id, rule id or trigger; disclosure is never built if `save` throws. Without the feature, today's per-phase system prompts are kept and blindness tests pass unchanged.
6. Compaction (with `compaction`): no rewrite below `high`; one checkpoint down to `low`; the logical prefix is preserved up to the first elided message; no churn on the next turn; audit entry recorded. Without the feature, today's elision behaviour and test are unchanged.
7. Request bodies per route, including `prompt_cache_key` roots for generation, verification and both council rounds: Anthropic direct and gateway, custom Anthropic with and without the declaration, OpenAI direct and gateway, `OPENAI_BASE_URL`, OpenRouter Anthropic, Gemini and DeepSeek, `compat/`, `dynamic/`, `openai/dynamic/*`, custom OpenAI, each `PROMPT_CACHE` value. Checks: marker count ≤ 4, no TTL, key present only on `key` routes, concatenated block text equal to the `none` rendering of the same text, `none` bodies equal to the plain-string rendering, gateway headers.
8. Usage normalization: Anthropic, OpenAI and OpenRouter fixtures × {no cache fields, read, write, both, invalid}; absent fields recorded as null per field; budget settle and allowance use total; on verified routes invalid cache usage fails without a second transport call and keeps the reservation; missing usage still retries once; on unverified routes (with every `PROMPT_CACHE` value, including `off`) the charge equals `prompt_tokens`, no call fails because of cache fields, and the call is marked `unverified`, or `invalid` with null cache fields when they are malformed.
9. Usage pass-through: `converse`, council vendor settlement and self-hosted settlement hand cache fields, convention and cost source to the ledger; the undispatched refund settles null cache fields; self-hosted cached counts that are negative, fractional, oversized or above the input are recorded as null with convention `invalid`, and the member call completes as it would today.
10. Cost: provider, estimate (with and without cache rates), unknown, self-hosted; the "Unknown cost stays unknown" scenarios.
11. Voter independence: three byte-identical first requests produce three transport calls with `cf-aig-skip-cache`; voter conversations never contain another voter's reply; batch timing is unchanged.
12. Switches: unknown values are rejected by `rio deploy` before account access, at submission, and by the configuration step before any reservation; each feature off reproduces the all-off body; the result-cache context hash changes with the feature set; the gate-record test fails for a default without a passed record.
13. Switch matrix: every combination of layout features against the qualified `prompt-layout` requirements.
14. Regression: existing suites for review, security coverage, contracts, verifier quorum, council (aggregation, degradation, audit hashes), failure policy (partial reports, exhausted, malformed and cancelled votes), result cache and routes all pass with every switch at its default.
15. QA paths (after PR #17 merges): `responseResult` normalization for Anthropic, OpenAI and OpenRouter shapes, including the harness-visible `cached_tokens`; cell budgets charged total tokens; shape-stable replacement (a request after a new screenshot equals the previous request up to the replaced image, with the same tool and follow-up message text); transport hint rendering per capability with and without the boundary line, with harness-supplied cache fields dropped; a scripted conversation with three screenshots and more than 20 blocks between them, in which every request after the first carries a marker at exactly the end of an earlier request's marker with identical content before it; the concatenated text unchanged by any split; `qa-order` journey prompts sharing text through the boundary; QA verifier blind requests with images keeping the marker after the last image; hosted partition present and local partition absent.

**Opt-in live measurement procedure** (documented in `docs/evaluation/prompt-caching.md`; never run in CI or by this change): see tasks 8.x. It needs explicit keys, a spend cap, and an environment variable gate. It produces the evidence the D15 gates need.

## Risks / Trade-offs

- [Prompt reorder, verifier schema move or compaction changes review quality] → each is a separate default-off feature with its own gate and margins (D15) and can be withheld without the others.
- [The partition line affects quality] → it is a fixed data element without instructions, and it reaches main only with a passed partition gate (D15).
- [A model echoes the partition value] → replaced with `[partition]` before persistence; the value is a per-provider pseudonym, not a secret.
- [The partition secret leaks from D1] → an attacker learns only the pseudonym the providers already see; it grants no access, and deleting the row issues a new one.
- [Anthropic write premium exceeds read savings for short or single-shot calls] → mark only layers with an expected reread (D7); prefixes below the model minimum cost nothing extra; hints stay off by default until the billed-cost gate passes.
- [One OpenAI key per review's generation exceeds the per-key rate] → `openai` ships off and its gate compares key and no key (D15).
- [An upstream rejects cache fields] → static capabilities, conservative `none` defaults for custom, compat, dynamic and base-URL routes, the `PROMPT_CACHE` switch, and no silent field-stripping retry (it would double-call).
- [OpenRouter or another OpenAI-compatible upstream reports cache writes outside `prompt_tokens`] → unverified routes keep today's charge and are excluded from ratios (D10); `openrouter` hints stay off until the live check confirms the convention.
- [Invalid cache fields from a flaky verified upstream fail calls that a retry might have saved] → accepted: a retry could under-charge; the failure is visible, and the call's reservation stays charged. Unverified routes record them as `invalid` and continue.
- [Concurrent cold voters each pay a write] → accepted (D8) to keep latency and independence; measured.
- [Earlier compaction makes the model re-read files] → bounded by the turn and token limits; behind its own gate.
- [Cross-tenant cache-membership probe through a shared organization cache] → tenant partition before private content (D14); public layers stay shared.
- [OpenAI reuses less than Anthropic] → stated (D9); no cross-agent claim on OpenAI.
- [Composition with active changes] → no MODIFIED overlap with core, council or qa; council 7.3 runs on a pinned pre-change build; QA work is sequenced after PR #17 merges, with its own migration.
- [Adding Anthropic hints to the QA transport before its usage is normalized would under-charge cells] → task 10.1 (normalization) must land before 10.3 (hints).
- [The proxy's stale-screenshot replacement rewrites history] → shape-stable replacement plus a marker at the replaced screenshot's position (D16); task 10.3 tests it over three screenshots with more than 20 blocks between them.
- [A harness puts volatile content before Rio's prompt] → task 10.2 captures real harness bodies with a recording stub; anything found is recorded as a limitation, since Rio cannot reorder it.
- [Four concurrent QA voters with screenshots each pay a cold write] → as D8: measured, not staggered by default.
- [Paid gate runs delay merging the partition] → groups 0–1 merge independently; the gate is one eval run of three arms.

## Migration Plan

1. Apply the D1 migration `NNNN_prompt_cache.sql` (the next free number on main at implementation time), which adds nullable columns to `usage` and creates `prompt_partitions`, before deploying the Worker. Old Workers ignore both.
2. Deploy the Worker with `rio deploy`, which validates and uploads `PROMPT_CACHE` and `PROMPT_LAYOUT`. Defaults: both off. The partition is on main only with its passed gate (D15). Model-visible text changes only by the partition line; result-cache entries from before the deploy miss once, because the layout version changed.
3. `rio deploy` replays optional price and provider fields. Old `config.toml` files stay valid.
4. After each gate passes (follow-ups, not this change), enable its feature or class, first through the variable on a test deployment, then by changing the default with its gate record.
5. Rollback: remove a feature from its variable, set `PROMPT_CACHE=off`, or redeploy the previous Worker. The columns and table stay and are ignored, and result-cache entries under the new layout are simply not hit by the old Worker's hash.
6. QA (after PR #17 merges): a separate migration adds the cache columns to `qa_model_usage` (task 10.1).

## Open Questions

These are answered by the live procedure and do not change the specs or tasks:
- Does the gateway `/compat` endpoint report `cached_tokens` for Anthropic upstreams? (Only reporting is affected; `compat` stays `none`.)
- Does OpenRouter honour `cache_control` parts for every Anthropic upstream it routes to (Anthropic, Vertex, Bedrock) in the same way, and where does it report their writes?
- Is the 96 KB low-water mark the right balance between reuse and re-reads?
- Is cross-agent reuse on OpenAI GPT-5.6+ worth explicit `prompt_cache_breakpoint` parts?
- Does council round 2 start within the 5-minute TTL of round 1? If not, `council-order` saves nothing on Anthropic and a 1-hour write for the rendering would need its own evidence (recorded by 8.1, decided in a follow-up).

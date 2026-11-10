# Prompt caching: baseline, measurement procedure and gates

This document belongs to the `optimize-llm-prompt-caching` change. It records the pinned baseline, the opt-in live measurement procedure and the gates that decide when each prompt-caching feature may become a default. Nothing here runs in CI.

## Pinned baseline

The pinned pre-change build is commit `2ac7b22` (main after PR #16). It is the last commit before this change's first code commit. Every quality gate compares against it. `rio-v0-3-council` task 7.3 ran on `e3d8092`, an ancestor of this commit, so neither the partition line nor any hint moved it.

Pre-change request bodies are recorded under `worker/tests/fixtures/wire/pre/`, one file per route class, for:
- one generation conversation: two tool turns and one repair;
- one voter: the blind turn and the disclosed turn;
- one council round.

The inputs are in `worker/tests/fixtures/wire/inputs.json`. The pinned generation template is in `worker/tests/wire/pre-template.ts`, and the scenarios are in `worker/tests/wire/scenarios.ts`. `node worker/scripts/capture-wire.mjs <dir> '<options>'` writes a fixture directory with a capturing transport and makes no network call. `worker/tests/wire.test.ts` regenerates every directory and compares it byte for byte.

| Directory | Options | What it records |
| --- | --- | --- |
| `pre/` | `{"frozen":true}` | the pinned baseline |
| `partition/` | `{"partition":true}` | the tenant partition line, the only model-visible change at the defaults in Worker requests (QA harness requests also move a replaced screenshot's placeholder into the screenshot message; see design D16) |
| `verifier-system/`, `agent-order/`, `council-order/` | `{"partition":true,"layout":["<feature>"]}` | one layout feature each; only its own scenario differs from `partition/` |
| `hints/` | `{"partition":true,"cache":["anthropic","openai","openrouter"]}` | every hint class; the logical text equals `partition/` |

## QA harness requests

`crates/rio-qa/controller/tests/capture-harness.mjs` runs Codex and pi in the provisioned QA image (`rio-qa:0.1.0`, no network) through the controller proxy against a recording stub, for two journeys in two cells, with the journey prompt exactly as `cell.mjs` passes it. The bodies are stored in `crates/rio-qa/controller/tests/fixtures/harness-captures.json`, and `harness-captures.test.mjs` checks the findings below against them.

Harness-owned content before Rio's prompt:
- Codex: four tools (three MCP resource tools and `step_done`), then a developer message with its QA instructions (321 bytes), a developer message listing skills (about 2.5 KB), and a user `environment_context` message (about 0.6 KB). Rio's prompt is the fourth input item, at about 3.2 KB of the transported request.
- pi: one tool (`step_done`) and a system message (about 1.5 KB). Rio's prompt is the second input item, at about 1.6 KB.

Volatile items found:

| Item | Where | Reaches the provider? | Effect |
| --- | --- | --- | --- |
| Private harness directory `/tmp/rio-private-harness-XXXXXX` (random per journey, from `mkdtemp` in `harness.mjs`) | Codex skill roots and `environment_context` (`cwd`, workspace root); the last line of pi's system prompt | Yes | Requests of different journeys diverge before Rio's prompt: Codex at byte 675 of the transported body, pi at byte 1,534 |
| Current date | Codex `environment_context`; pi's system prompt | Yes | Changes once a day |
| Session, thread, turn and installation ids, `client_metadata` | Codex request fields | No: the transport rebuilds requests from a whitelist | None |
| Message ids (`msg_…`) | Codex input items | No | None |
| The harness's own `prompt_cache_key` (its session id) | Both | No: the transport drops it and sets its own (D16) | None |

Within one journey both harnesses only append, so a request's prefix is the previous request. Across journeys, nothing after the private directory is shared, so `qa-order` cannot produce reuse between journeys until that path is stable per cell. A stable path is a change to the harness sandbox and is left to a follow-up.

## Live measurement procedure

The procedure sends real, billed requests. It is run by a maintainer only when explicitly authorized, on a test account, never in CI and never by this change. `scripts/measure-prompt-cache.mjs` implements it, and it refuses to start, before any network call, unless all of these hold:
- `RIO_LIVE_PROMPT_CACHE=1` is set;
- `--spend-cap` is a positive amount in USD;
- every route's key is present (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, or `AI_GATEWAY_URL` and `AI_GATEWAY_TOKEN` for gateway routes).

Every call's cost must be known, from OpenRouter's `usage.cost` or from `MODEL_PRICES` including `cache_read` and `cache_write`. Otherwise the run stops, because the cap could not be enforced.

```sh
RIO_LIVE_PROMPT_CACHE=1 ANTHROPIC_API_KEY=... OPENAI_API_KEY=... OPENROUTER_API_KEY=... \
MODEL_PRICES='{"anthropic/claude-sonnet-5-5":{"input":3,"output":15,"cache_read":0.15,"cache_write":3.75}, ...}' \
node scripts/measure-prompt-cache.mjs \
  --routes anthropic/claude-sonnet-5-5,openai/gpt-5.6,openrouter/anthropic/claude-sonnet-5-5,openrouter/deepseek/deepseek-v4 \
  --repetitions 5 --spend-cap 10 --out prompt-cache-2026-mm-dd.json
```

Route classes are Anthropic direct and through the gateway, OpenAI direct, OpenRouter Anthropic, OpenRouter with automatic caching, and `compat/` through the gateway. Run the script once per gateway configuration.

### Measurements

| # | Measurement | How | Pass criterion (recorded, not a default change) |
| --- | --- | --- | --- |
| a | Cold then warm | Two identical requests 30 s apart, with a measurement-only salt in layer 1 forcing a cold start | The warm request reports cache reads covering the marked prefix |
| b | Tool conversation | A 3-turn conversation | Each turn reads the previous turn's prefix |
| c | Blind → disclosed | One voter with `verifier-system` | The disclosed turn reads the whole blind conversation |
| d | Voters | Three concurrent cold voters, then three staggered after the first response | Write and read totals, latency and cost of each variant (design D8) |
| e | Compaction | A conversation crossing 160 KB with `compaction` | One rewrite at the checkpoint, reads on the following turns |
| f | Two agents | Two agents of one review with `agent-order` | The second reads the shared context; on OpenAI no claim is made (design D9) |
| g | OpenRouter stickiness | The `upstream` field of every OpenRouter record | Share of conversations served by one upstream |
| h | OpenAI key | One warm request repeated with and without `prompt_cache_key` | Read ratio and billed cost per variant |
| i | Council round gap | `node scripts/measure-prompt-cache.mjs --council-audit reviews/<id>/council/audit.json` on recorded reviews (no network) | Share of members whose round 2 started within the 5-minute lifetime |

### QA measurements

QA requests are sent by a harness, so they are measured from real QA runs rather than by the script. Run `rio qa` (local, with a `RIO_QA_MODEL_ROUTE` that lists the class in `prompt_cache`) or a hosted review with QA enabled, on a test application, once per route class, with the same budget rules (`RIO_LIVE_PROMPT_CACHE=1`, a spend cap enforced by the QA cell budget, and explicit authorization).

| # | Measurement | How | Pass criterion (recorded, not a default change) |
| --- | --- | --- | --- |
| j | QA journeys | One run of two journeys in two cells, with `qa-order` off and then on. Read `qa_model_usage` (hosted) or the relay's usage records (local) | Cache reads on every request after a journey's first; the share of each journey's first request read from the cell's previous journey (expected to be near zero until the harness directory is stable, see "QA harness requests") |
| k | QA voters | QA voters of one candidate with screenshots, concurrent (as today) and staggered after the first response | Write and read totals, latency and cost of each variant; the disclosed turn reads the blind message including its screenshots |

The `qa-order` gate (below) uses the QA reference fixtures, not these measurements.

The script records, per request, cache-read and cache-write tokens, total input, output, latency, Rio's recorded cost and cost source, and the OpenRouter upstream. Compare Rio's recorded cost with the provider-billed cost: OpenRouter's generation endpoint, and the provider usage exports for Anthropic and OpenAI. Report medians over the 5 repetitions.

Record format (`--out`):

```json
{"at": "ISO time", "plan": {"routes": [], "repetitions": 5, "spendCapUsd": 10},
 "records": [{"measurement": "a-cold-warm", "route": "...", "variant": "warm", "repetition": 0, "request": 1,
              "ms": 812, "input_tokens": 9050, "cache_read_input_tokens": 9000, "cache_write_input_tokens": 0,
              "output_tokens": 12, "usage_convention": "verified", "cost_usd": 0.0019, "cost_source": "estimate",
              "upstream": null}]}
```

Store records under `docs/evaluation/prompt-caching/` after `eval/credscan.py` passes on them.

## Gates

Each gate decides one default, or one usage convention. A gate's result is recorded in `docs/evaluation/prompt-caching-gates.json`. The default switch values (`PROMPT_DEFAULTS` in `worker/src/prompt-config.ts`) may enable only features and classes that have a passed record there, and `worker/tests/gates.test.ts` enforces this. The file's `pending` list may name only the `partition` gate: while it does, the partition commit must not merge to main. The follow-up that records the passed partition gate removes the entry, and the test rejects a pending entry beside a passed record.

### Quality gates (reference set)

There are three arms:
1. The pinned build `2ac7b22`.
2. The new build with every feature off.
3. The new build with one feature on.

Each arm runs the full `eval/` reference set 3 times, and metrics are means over the runs.
- A feature passes when arm 3 is non-inferior to arm 2.
- The partition passes when arm 2 is non-inferior to arm 1.

Margins:
- precision, recall, verifier agreement, journey completion and step coverage: at most 2 percentage points lower;
- exhausted, malformed, incomplete and `not_assessed` rates: at most 1 percentage point higher;
- median turns per conversation: at most 1 turn higher.

| Gate | Arms compared | Metrics |
| --- | --- | --- |
| `partition` (first, before the partition reaches main) | 2 against 1 | per-agent precision and recall, verifier agreement, exhausted and incomplete vote rates |
| `agent-order` | 3 against 2 | per-agent precision and recall |
| `verifier-system` | 3 against 2 | verifier agreement with reference labels; exhausted, malformed and incomplete vote rates. The shared form adds the hypothesis schema (about 1.8 KB) to the disclosed turn; a voter whose allowance cannot cover it falls back to the separate form, so also report the share of voters that fell back (their disclosed system-layer hash equals the feature-off one) |
| `compaction` | 3 against 2 | turn counts, exhausted and incomplete rates, accuracy on long conversations |
| `council-order` | 3 against 2 | the `rio-v0-3-council` 7.3 metrics: disagreement rate, accuracy against verifier-only, cost per finding |
| `qa-order` | 3 against 2 on the QA reference fixtures, two journeys in two cells per fixture | journey completion, step coverage, `not_assessed` rate, QA finding precision and recall, with the margins above; also report measurement j's reads, which decide whether the reorder pays off before the harness directory is stable |

On failure:
- The partition element's form or position is revised and the gate is rerun. Tenant separation itself is never made optional.
- A failed feature stays off; the others are unaffected.

### Cost gates (live procedure, 5 repetitions, medians)

| Gate | Passes when |
| --- | --- |
| `openai` | With the key, the cache-read ratio per phase is not lower and the billed cost is not higher than without it (measurement h) |
| `anthropic` | Billed cost per phase is not higher with hints than with the class disabled |
| `openrouter` | OpenRouter's usage convention for Anthropic and Gemini upstreams matches `worker/tests/fixtures/usage/usage.json`, and the `anthropic` cost check passes on OpenRouter Anthropic |

### Usage-convention promotion

A route class moves from `unverified` to `verified`, beginning with OpenRouter, when the live records show cache reads plus writes inside `prompt_tokens` for every upstream measured. The provider's documentation must agree.

Defaults and conventions change only through a small follow-up change that adds the gate record and links this evidence.

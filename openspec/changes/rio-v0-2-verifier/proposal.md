## Why

The TRD's original verifier was "a stronger, different model" that re-examines each hypothesis. Two published accounts argue for a different shape. "A Practical Approach to Verifying Code at Scale" (OpenAI Codex team, Dec 2025) reports that verification recovers most known high-severity issues at a fraction of the generation budget, which makes several cheap independent verifier passes a better buy than one expensive judge, and that reviewers need the whole repository and the ability to run code, not a context slice. "How the Claude Code team does code review" (Anthropic, Oct 2026) runs reviewers independently and dedupes by voting rather than through shared state. This change reshapes the agent runtime and the verifier accordingly, adds blind re-derivation so a verifier cannot simply be led by the hypothesis, and gives security its own step with its own posture and fail policy. It implements PRD R6, R7 (as reworded), R24, R26 and R29.

**Expanded scope (owner authorized 2026-11-06).** This change now implements the v0.2 Cloudflare core as well as the verifier: Worker API, durable Workflows and Queues, D1/R2 persistence, model gateway, repository tools, Sandbox and self-hosted runner integration, and the CLI client/setup path. The existing local deterministic engine is reused. Cloudflare AI Gateway is an optional provider proxy; Rio's Worker gateway still enforces its own budgets and structured tool protocol. Security agent/catalog execution remains a v0.3 release gate, with the validated security step disabled in the v0.2 base profile.

## What Changes

- **Repository-wide context for agents.** `read_file(path, version)` and `search(pattern, scope)` are not restricted to the triage context slice; the slice is a hint that seeds the agent's attention. `graph_query` remains bounded by `hops` and `max_nodes`.
- **Execution by default where it pays.** `run(command)` is on by default for the correctness agent and for verifier voters, off by default for the other agents; a manifest may change either default, and fork PRs disable it everywhere (TRD security model, unchanged).
- **Verifier quorum.** New profile block `verify: { voters, quorum, model }` (defaults 3, 2, the `verifier` alias when set, else `default`). Each hypothesis is verified by `voters` independent passes of the same model class at a small per-hypothesis budget; it is promoted to the evidence level that at least `quorum` voters reach. Voters that split across the `refuted` boundary mark the hypothesis `verify.split`. A different model remains an option through `verify.model`.
- **Validation relaxed, not broken.** The v0.1 rule that `models.verifier` must differ from `models.default` is required only when `verify.voters` is 1. Every profile valid under v0.1 stays valid.
- **Blind re-derivation.** Each voter first receives the location (file, symbol, both versions) without the hypothesis and answers "what, if anything, is wrong in this function?" in the hypothesis schema; then it receives the hypothesis and compares. The blind answer is recorded as evidence (`blind_match: same | related | none`) and weighs in the quorum.
- **Category floor.** Hypotheses whose category is `style` or `diagnostic` are dropped from defects regardless of evidence level and are at most listed in the footer. This complements the evidence floor.
- **Hypothesis board deferred.** `board_read` and `board_write` are no-ops in this change; agents run independently and the quorum dedupes. The `hypotheses` table stays for audit.
- **Posture consumed.** `posture` and `max_defects` (reserved in v0.1) now apply to agent findings after verification: evidence floor, severity floor, whether `plausible` risks render, and the cap in impact × evidence order with a footer count of held-back findings. The Quick/Standard/Deep presets map onto posture and budget as the TRD describes.
- **Owner guidance consumed.** The `owner_guidance` artifact that `rio/prepare` writes (from `REVIEW.md`, `CLAUDE.md`, `AGENTS.md` per directory) is injected into agent and verifier prompts as data in delimited blocks. The correctness agent flags code that contradicts a guidance line (`guidance/contradiction`) and changes that make a line stale (`guidance/stale`); both go through the verifier like any hypothesis.
- **Security as its own step.** `rio/security` is a step module, not one agent in the agents step. It has its own `with: { posture, fail_on }` (defaults `thorough` and `evidence: plausible`), its own triage rules, and its hypotheses carry category `security` so `max_defects` and the category floor apply separately. Its findings go through the same verifier quorum.
- **Risk tier from triage.** Triage emits `risk_tier: { tier, reasons[], source: triage }` from its signals; `always_human` globs (reserved in v0.1) force `high` and `require_human()`. Rio never approves; the tier is exposed in JSON and SARIF.

Nothing is breaking. profile-v1 gains the optional `verify` block and the `rio/security` step's `with` schema; finding-v1 gains the optional `verification` block (`voters`, `agreeing`, per-voter `blind_match`, `split`) and category `security`; report-v1 gains optional security results and verification/presentation audit data. The existing `risk_tier.source: triage` contract is consumed by endpoint triage.

## Capabilities

### New Capabilities
- `verifier-quorum`: voters, quorum, per-hypothesis budget, blind re-derivation, `verify.split`, evidence promotion, and the `verification` block on findings.
- `security-step`: the `rio/security` step module, its posture and fail policy, its triage rules, and category-scoped caps.
- `owner-guidance`: injection of the prepare artifact into prompts as data, the `guidance/contradiction` and `guidance/stale` hypotheses, and the prohibition on guidance acting as policy.

### Modified Capabilities
- `review-profiles`: `verify` block; verifier-model rule relaxed when `voters > 1`; `posture` and `max_defects` consumed; `rio/security` step options.
- `findings`: `verification` block; category floor; `max_defects` application.
- `review-report`: held-back count, `risk_tier` from triage, security findings sectioned separately.

## Impact

- **Code**: `worker/` (verifier fan-out, blind pass, quorum aggregation, security step, prompt assembly with guidance blocks), `modules/steps/verify`, `modules/steps/security`, `modules/agents/*` manifests (`run` defaults, tool scopes), `rio-profile` (new keys, relaxed rule), `rio-core` (category floor, cap, `verification` block).
- **Contracts**: profile-v1 `verify` (`voters`, `quorum`, `model`) and `rio/security` `with` (`posture`, `fail_on`); finding-v1 optional `verification` and the security category; report-v1 optional security/audit data and consumption of the existing `risk_tier.source: triage`. Existing v1 documents remain valid; recorded in the v0.1 proposal's contract paragraph.
- **Cost**: `voters` × per-hypothesis budget replaces one large verifier call; the TRD's cost ledger shows verification cost separately so the trade is visible per review.
- **Dependencies on other changes**: v0.2 core (endpoint, agents, runner); `rio-v0-2-review-convergence` consumes the same posture and reserved keys independently.

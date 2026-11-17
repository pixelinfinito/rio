# Depth and spending

Hosted presets require an endpoint and model configuration. More agents/voters consume more resources. Limits belong in the selected profile; exact defaults are version-specific and visible with rio profile show.

## presets
`rio review --preset quick|standard|deep`; `--deep` is the deep shorthand and conflicts with --preset. Quick narrows agent/verification work; standard is the everyday option; deep spends more on high-risk analysis. A preset does not install dependencies or configure credentials. Start with standard on a small diff, inspect usage and incomplete steps before increasing depth.

## profile
budget.fast and budget.deep can set wall_time, tokens, verify_tokens and agents_max. verify_tokens is per voter; tokens is the review ceiling. rio/openrouter allows 12000000 tokens and 40m in fast and deep (sized for a change reviewed in eight parts) and sets verify.risk_voters: 1 because its verifier differs from its reviewer; set risk_voters: 3 when one model does both. For example extend rio/base and set `budget: {fast: {wall_time: 5m, tokens: 100000, verify_tokens: 20000}}`, then validate. Preserve intended steps when overriding lists. budget.prepare (1m to 60m, default 15m) is the time a hosted PR review may spend being prepared before it starts.
QA's built-in fast budget is 4m/500000 review tokens/60000 per voter; deep 10m/1000000/120000. QA screenshots consume vision tokens. The budget clock continues during local queue pause. Raising a limit is a policy decision, not a fix for missing prerequisites.

## accounting
Reports distinguish requested/configured limits, measured provider usage, cache read/write tokens, estimated prices, and unavailable costs. Do not infer zero cost from absent pricing. Exhausted budgets produce explicit partial/skipped/cancelled work; inspect outcomes and report status. Review result caching can avoid repeated hypotheses, but verification still runs. Council adds bounded members, rounds and experiments; it is opt-in.

<!-- schema-options:start -->
## option-fields
rio/verify@0.1.0:
run: boolean; default=true

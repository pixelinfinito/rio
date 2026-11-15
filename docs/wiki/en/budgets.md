# Tune depth, time and model usage

## Outcome

Choose review depth and cap resource use without treating an incomplete run as a clean one.

## Prerequisites

Presets require a configured online endpoint. Inspect the resolved profile and current provider pricing before increasing limits.

## Steps

Use `rio review --preset standard` for balanced everyday review. Quick selects critical-only/fast; Standard balanced/fast; Deep thorough/deep. `--deep` is a shorthand and conflicts with `--preset`. Explicit profile evidence/cap values retain precedence.

A profile can bound time and tokens:

```yaml
version: 1
name: bounded
extends: rio/base
budget:
  fast:
    wall_time: 5m
    tokens: 100000
    verify_tokens: 20000
    agents_max: 3
```

Save as a profile, run `rio profile validate PATH`, and inspect it with `rio profile show PATH`. This example changes limits; it does not add provider models. `verify_tokens` is a voter's whole two-turn allowance; `tokens` is review-wide. Nested `budget.fast.qa`/`budget.deep.qa` controls QA wall/cell/replay time, tokens and evidence bytes. The generated schema reference lists exact fields.

## Expected results

Reports expose usage, cache reads/writes, price provenance and incomplete work. Missing cost data does not mean zero cost. These limits are ceilings, not expected spend. The schema has no `cost_usd` budget field; control time/tokens/agents and inspect measured cost.

Built-in QA sets fast review tokens to 500,000 and per-voter tokens to 60,000; deep uses 1,000,000 and 120,000. Screenshots consume vision tokens. General resolved defaults and explicit profile overrides can differ; use `profile show` for your installed version.

## Troubleshooting

If a budget expires, inspect which steps/cells were cancelled before raising it. Local QA queue pause does not pause the clock. Failed calls with unknown usage can retain reservations. Replayed agent hypotheses are still verified; disabling their cache does not disable all caches. Council adds members/rounds/experiments under separate limits.

## Next steps

[Choose providers](providers.md), [adjust profiles](profiles.md), or [inspect council](council.md).

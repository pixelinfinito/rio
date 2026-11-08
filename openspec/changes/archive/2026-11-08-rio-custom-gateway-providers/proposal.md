# Proposal

## Why

`rio init` offers OpenRouter, OpenAI and Anthropic keys only. Teams with their own OpenAI-compatible or Anthropic Messages endpoints had to create AI Gateway custom providers by hand and point the Worker's `OPENAI_BASE_URL` at the gateway's `/compat` endpoint with a blank `AI_GATEWAY_URL`. An ordinary `rio deploy` overwrites that manual runtime configuration, and the setup cannot be replayed from `config.toml`.

## What Changes

- `rio init` and `rio deploy` accept custom AI Gateway providers (slug, protocol `openai` or `anthropic`, base URL), interactively (provider 4) or with `--custom-provider SLUG:PROTOCOL:BASE_URL`, keys from `AI_GATEWAY_PROVIDER_KEY_<SLUG>` (environment or `--secrets-file`), and `--default-model`/`--verifier-model` for a new personal default profile.
- The definitions, optional `model_prices` and `dynamic_routes` are saved in `config.toml` and reconciled idempotently on every deployment: custom providers are created or adopted, their write-only headers (a JSON-encoded string) are rewritten only when the key changed, and dynamic routes get a new deployed version only when their elements changed.
- Upstream keys stay in the deployment credential store and the gateway provider; the Worker receives `AI_GATEWAY_PROVIDERS` (protocols only) and `MODEL_PRICES`.
- The Worker routes `custom-SLUG/MODEL` to the provider's native gateway endpoint in its protocol, `compat/PROVIDER/MODEL` and `dynamic/ROUTE` to the unified endpoint, joins URLs without duplicating `/v1`, and keeps `openai/custom-…` profiles from the manual setup working. Unroutable model aliases are rejected at submission.
- Unknown cost stays unknown; explicit `model_prices` price custom models.

## Capabilities

### New Capabilities
- `model-providers`: provider configuration at setup, gateway reconciliation, model identifier routing and cost.

## Impact

- `crates/rio-cli` (`deployment.rs`, new `providers.rs`), `worker/src/gateway.ts`, `worker/src/index.ts`, `worker/src/types.ts`, `docs/cloudflare.md`, `README.md`. No schema or migration changes; existing profiles, flags and OpenRouter defaults are unchanged.

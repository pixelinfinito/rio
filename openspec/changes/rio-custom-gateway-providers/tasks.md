# Tasks

## 1. Setup and configuration

- [x] 1.1 Add `custom_providers`, `model_prices` and `dynamic_routes` to the deployment choices with validation (slug, protocol, HTTPS API-root base URL, prices, route names), `--custom-provider SLUG:PROTOCOL:BASE_URL`, `--default-model` and `--verifier-model`. Verify unit tests for parsing, normalization and rejection, and a CLI dry-run test for flags, `--from` replay and invalid specs
- [x] 1.2 Add provider 4 (custom endpoint) to the interactive `rio init` provider prompt, reading the key with echo disabled, and write the personal default profile with the chosen `custom-SLUG/MODEL` models. Verify a prompt test with scripted input (definition, defaults, rejection before the key is read, empty key)
- [x] 1.3 Read keys as `AI_GATEWAY_PROVIDER_KEY_<SLUG>` from the environment or `--secrets-file`, only for configured providers, and keep them and the applied fingerprints out of Worker bindings and configuration. Verify the replay test and the provisioning test's upload and config assertions

## 2. Gateway reconciliation

- [x] 2.1 Create or adopt custom providers; send the key as JSON-encoded string headers; rewrite headers only on a fingerprint change; correct the base URL of adopted providers; fail for a missing provider without a key. Verify mock-Cloudflare tests for first deployment, unchanged redeployment, key rotation, adoption without a key and the missing-key error
- [x] 2.2 Create missing dynamic routes and deploy one new version when elements differ. Verify the provisioning test's route creation, unchanged redeployment and element change
- [x] 2.3 Upload `AI_GATEWAY_PROVIDERS` and `MODEL_PRICES` with the whole Worker, keeping every binding, the `SANDBOX` declaration without `namespace_id` and the Container declaration. Verify the metadata test

## 3. Worker routing

- [x] 3.1 Route `custom-SLUG/MODEL`, `compat/PROVIDER/MODEL`, `dynamic/ROUTE` and the built-in providers with one URL join rule and gateway authentication; keep `openai/custom-…` and `OPENAI_BASE_URL` setups working. Verify route tests for every form, the manual setup, error cases without credentials in messages, protocol bodies and unknown cost
- [x] 3.2 Reject submissions whose default, verifier or agent model cannot be routed. Verify an API test for rejection and acceptance with a configured gateway

## 4. Documentation

- [x] 4.1 Document setup, replay, reconciliation, model identifiers, cost and manual-setup compatibility in `docs/cloudflare.md` and `README.md`

## Validation record (2026-11-08)

Local checks: `cargo fmt --all --check` and `cargo clippy --workspace --all-targets --locked` passed; `cargo test --workspace --locked --no-fail-fast` passed 336 tests. Worker `npm run generate`, `npm run bundle` and `npm run check` passed and 182 tests (run alone) passed. The eval harness passed 98 tests, `python3 -I scripts/generate-profile-reference.py` left `docs/profiles.md` unchanged, and `openspec validate --specs` and `openspec validate rio-custom-gateway-providers --strict` passed.

Not done here, by instruction: no deployment, no Cloudflare mutation and no live model call; the live Gateway and Worker, the running 24-case evaluation and the personal profiles were left untouched (only read-only listings of the gateway's provider keys and dynamic routes were made). The routes match the endpoints verified on the live gateway by hand (`/custom-SLUG/chat/completions`, `/custom-SLUG/messages`, `/compat/chat/completions`).

Limitations:

- A custom provider's headers are write-only in Cloudflare. Rio's own writes are idempotent through the fingerprint, but a key changed outside Rio is not detected; adopting an existing provider without a key leaves its headers untouched.
- The upstream header style defaults to `Authorization: Bearer` for OpenAI-compatible and `x-api-key` for Anthropic providers (`auth_header` overrides it). The headers of the hand-made providers could not be read back to confirm which style they use.
- `compat/openai/…` and other built-in providers through the unified endpoint rely on keys stored in the gateway (BYOK); the Worker sends no provider key there. Gateway BYOK provider configs are not created.
- Dynamic route comparison assumes Cloudflare returns the elements it was given; a normalized echo would create a version on each deployment.
- A deployment always sets `AI_GATEWAY_URL`. A manual setup with a blank `AI_GATEWAY_URL` and `OPENAI_BASE_URL` at `/compat` keeps working through the `openai/custom-…` compatibility route; the leftover `OPENAI_BASE_URL` secret is then unused.
- The interactive prompt adds one provider; more are added with `--custom-provider` or in `config.toml`.

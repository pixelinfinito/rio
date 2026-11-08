# model-providers Specification

## Purpose

Let a deployment use its own OpenAI-compatible or Anthropic Messages endpoints through AI Gateway, configured at setup, reproduced by every deployment and routed by the Worker, without exposing upstream keys.

## Requirements

### Requirement: Custom provider setup
`rio init` and `rio deploy` SHALL accept custom AI Gateway providers, each with a slug, a protocol (`openai` or `anthropic`) and a base URL that is the API root the endpoint path is appended to, interactively or with `--custom-provider SLUG:PROTOCOL:BASE_URL`. A base URL that is not HTTPS, carries credentials, a query or a fragment, or ends in `/chat/completions` or `/messages` SHALL be rejected before any account access.

#### Scenario: Non-interactive setup
- **WHEN** `rio init --custom-provider node:openai:https://api.example.com/v1/ --default-model custom-node/m` runs with `AI_GATEWAY_PROVIDER_KEY_NODE` in the environment
- **THEN** the saved deployment choices list provider `node` with base URL `https://api.example.com/v1`, and no key appears in the configuration or the output

#### Scenario: Endpoint given as base URL
- **WHEN** a provider's base URL ends in `/chat/completions`
- **THEN** the command fails naming the base URL rule and makes no Cloudflare request

### Requirement: Configuration replay
The provider definitions, explicit model prices and dynamic routes SHALL be saved in the deployment section of `config.toml` and reproduced by every later `rio deploy` and by `rio deploy --from`. Keys SHALL come only from the credential store, the environment or `--secrets-file`.

#### Scenario: Replay from a configuration file
- **WHEN** `rio deploy --from config.toml` runs with a configuration that lists two custom providers and a model price
- **THEN** the deployment plan contains both providers and the price

### Requirement: Idempotent gateway reconciliation
A deployment SHALL create missing custom providers with their key as the provider's JSON-encoded headers, adopt existing providers with the same slug, correct their base URL, and rewrite their headers only when the key or base URL changed since Rio last applied them. A missing provider without a key SHALL fail naming its key variable. Dynamic routes SHALL be created when missing and get one new deployed version when their elements differ.

#### Scenario: Unchanged redeployment
- **WHEN** a deployment is repeated with the same providers, keys and routes
- **THEN** no custom provider or route is created or modified

#### Scenario: Rotated key
- **WHEN** one provider's key changes and the deployment runs again
- **THEN** only that provider's headers are updated

### Requirement: Keys never reach the Worker
Upstream keys of custom providers SHALL NOT be uploaded as Worker bindings, written to configuration or profiles, or printed. The Worker SHALL receive each provider's protocol only, and the deployment SHALL upload the Worker with all of its bindings and its Container declaration.

#### Scenario: Worker upload
- **WHEN** a deployment with custom providers uploads the Worker
- **THEN** the upload contains `AI_GATEWAY_PROVIDERS` with the protocols, the usual bindings and the Sandbox declaration, and no upstream key

### Requirement: Model routing
The Worker SHALL send `custom-SLUG/MODEL` to the gateway's `custom-SLUG` endpoint in the provider's protocol, `compat/PROVIDER/MODEL` and `dynamic/ROUTE` to the gateway's unified chat completions endpoint, and built-in providers as before, authenticating to the gateway with its token and joining URLs without duplicate slashes or path segments.

#### Scenario: Native custom route
- **WHEN** a profile model is `custom-node-anthropic/claude-sonnet-5-5` and the provider's protocol is `anthropic`
- **THEN** the request goes to `GATEWAY/custom-node-anthropic/messages` with model `claude-sonnet-5-5` and no upstream key

#### Scenario: Dynamic route
- **WHEN** a profile model is `dynamic/support`
- **THEN** the request goes to `GATEWAY/compat/chat/completions` with model `dynamic/support`

### Requirement: Manual setup compatibility
With a gateway configured, `openai/custom-SLUG/MODEL` and `openai/dynamic/ROUTE` SHALL be sent to the unified endpoint, so profiles written for an `OPENAI_BASE_URL` pointed at the gateway's `/compat` endpoint keep working after a deployment; without a gateway `OPENAI_BASE_URL` SHALL be used as before.

#### Scenario: Redeployed manual setup
- **WHEN** a profile model is `openai/custom-node-anthropic/claude-sonnet-5-5` and `AI_GATEWAY_URL` is set
- **THEN** the request goes to `GATEWAY/compat/chat/completions` with model `custom-node-anthropic/claude-sonnet-5-5`

### Requirement: Routable models at submission
A submission whose default, verifier or agent model cannot be routed SHALL be rejected before the review starts, naming the alias and without exposing credentials.

#### Scenario: Unroutable alias
- **WHEN** a submission's default model is `custom-node/m` and the Worker has no gateway configured
- **THEN** the submission is rejected with HTTP 400 naming alias `default`

### Requirement: Unknown cost stays unknown
A custom route's cost SHALL be `null` unless an explicit model price names the profile model, in which case it SHALL be computed from the reported token usage.

#### Scenario: Unpriced custom model
- **WHEN** a custom route reports usage with a `cost` field and no model price is configured
- **THEN** the recorded cost is `null`

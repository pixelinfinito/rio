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
A deployment SHALL create missing custom providers with their key as the provider's JSON-encoded headers, adopt existing providers with the same slug, correct their base URL, and rewrite their headers only when the base URL or the rendered headers (the key and its authentication header) changed since Rio last applied them. A missing provider without a key SHALL fail naming its key variable. Dynamic routes SHALL be created when missing and get one new deployed version when their elements differ.

#### Scenario: Unchanged redeployment
- **WHEN** a deployment is repeated with the same providers, keys and routes
- **THEN** no custom provider or route is created or modified

#### Scenario: Rotated key
- **WHEN** one provider's key changes and the deployment runs again
- **THEN** only that provider's headers are updated

#### Scenario: Authentication header changed
- **WHEN** one provider's `auth_header` changes while its key and base URL stay the same, and the deployment runs again
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
A custom route's cost SHALL be `null` unless an explicit model price names the profile model, in which case it SHALL be computed from the reported token usage. Cache reads and writes SHALL be priced only by the price's `cache_read` and `cache_write` rates. When a call reports non-zero cache reads or writes that the price has no rate for, the cost SHALL be `null`.

#### Scenario: Unpriced custom model
- **WHEN** a custom route reports usage with a `cost` field and no model price is configured
- **THEN** the recorded cost is `null`

#### Scenario: Priced model with unpriced cache reads
- **WHEN** a model price has only `input` and `output` rates and a call reports cache-read tokens
- **THEN** the recorded cost is `null`

### Requirement: Prompt-cache capability per route
The Worker SHALL derive each route's prompt-cache capability from the route and the enabled hint classes, never by probing. With its class enabled, a built-in Anthropic route (direct or through the gateway) or a custom Anthropic-protocol provider that declares it uses `breakpoints`; a built-in OpenAI route without `OPENAI_BASE_URL` uses `key`; an OpenRouter `anthropic/` or `google/gemini` model uses `parts`. Every other route, and every route whose class is not enabled, uses `none`.

#### Scenario: Capability table
- **WHEN** `PROMPT_CACHE` is `anthropic,openai,openrouter` and routes are resolved for `anthropic/claude-sonnet-5-5`, `openai/gpt-5.6`, `openrouter/anthropic/claude-sonnet-5-5`, `openrouter/deepseek/deepseek-v4`, `compat/custom-node/m`, `dynamic/support` and an undeclared `custom-node/m`
- **THEN** their capabilities are `breakpoints`, `key`, `parts`, `none`, `none`, `none` and `none`

### Requirement: Prompt-cache hint classes
The `PROMPT_CACHE` Worker variable SHALL be `off` or a comma list of hint classes from `anthropic`, `openai` and `openrouter`. Unset SHALL mean `off`. An unknown value SHALL be rejected naming it by `rio deploy` before any account access, at review submission, and by the review's configuration step before any reservation.

#### Scenario: Default classes
- **WHEN** `PROMPT_CACHE` is unset and routes are resolved for `anthropic/claude-sonnet-5-5`, `openai/gpt-5.6` and `openrouter/anthropic/claude-sonnet-5-5`
- **THEN** all three capabilities are `none`

#### Scenario: Base URL override
- **WHEN** `PROMPT_CACHE` is `openai`, `OPENAI_BASE_URL` is set and no gateway is configured, and a profile model is `openai/local-model`
- **THEN** the route's capability is `none`

#### Scenario: Operator switch
- **WHEN** the Worker variable `PROMPT_CACHE` is `off`
- **THEN** every route's capability is `none`, while the prompt layout, tenant partition and usage normalization stay in effect

#### Scenario: Unknown hint class
- **WHEN** the Worker's `PROMPT_CACHE` is `anthropic,gemini` and a review is submitted
- **THEN** the submission is rejected with a configuration error naming `gemini`, and no review starts

### Requirement: Anthropic cache breakpoints
On a `breakpoints` route the request SHALL send `system` as a text block marked `cache_control: {"type":"ephemeral"}`. It SHALL mark the end of the reusable part of the first user message the same way, and in multi-turn conversations the end of the last message too. It SHALL use at most four breakpoints, no TTL field and no top-level `cache_control`.

#### Scenario: Generation request on Anthropic
- **WHEN** a generation request is sent on a `breakpoints` route
- **THEN** the body has `system` as one text block with `cache_control`, the first user message as text blocks with `cache_control` on the block ending the review context, the last message's final block marked, and at most four `cache_control` markers in total

#### Scenario: Concatenated text unchanged
- **WHEN** the text blocks of each message in that body are concatenated
- **THEN** the result equals the text the same request would carry on a `none` route

#### Scenario: Prefix below the provider minimum
- **WHEN** a marked prefix is shorter than the model's minimum cacheable length
- **THEN** the request is still sent unchanged, the provider reports no cache use, and Rio records the call as reporting zero cache reads and writes

### Requirement: OpenAI cache key
On a `key` route the request SHALL carry `prompt_cache_key` set to a hash of the tenant, review and conversation root. The root is `generation` for every generation call of the review, the hypothesis for its voters, and the finding and member role for a council member across both rounds. The key SHALL NOT contain a readable identifier and SHALL NOT be sent on any other route. No retention, options or content-part breakpoint field SHALL be sent.

#### Scenario: Voters share a key
- **WHEN** three voters verify one hypothesis on `openai/gpt-5.6`
- **THEN** their requests carry the same `prompt_cache_key`, a different hypothesis carries a different key, and no request carries `prompt_cache_retention` or `prompt_cache_options`

#### Scenario: Reuse limited to message boundaries
- **WHEN** two agents of one review send generation requests on `openai/gpt-5.6`
- **THEN** each request is a single first user message holding review context and assignment, no `prompt_cache_breakpoint` is sent, and Rio's audit makes no claim of reuse between the two beyond what the provider reports

#### Scenario: Council member key across rounds
- **WHEN** the skeptic member on `openai/gpt-5.6` answers rounds 1 and 2 of one finding
- **THEN** both requests carry the same key, which differs from another member's and from the generation key

#### Scenario: Tenants never share a key
- **WHEN** two tenants review identical content on the same model
- **THEN** their requests carry different `prompt_cache_key` values

### Requirement: OpenRouter cache hints
On a `parts` route the message content at each breakpoint position SHALL be sent as an array of text parts, with `cache_control: {"type":"ephemeral"}` on the part ending each reusable layer. OpenRouter requests SHALL keep `provider.require_parameters` and SHALL NOT carry `prompt_cache_key` or `session_id`.

#### Scenario: OpenRouter Anthropic model
- **WHEN** `PROMPT_CACHE` includes `openrouter` and a verifier request is sent to `openrouter/anthropic/claude-sonnet-5-5`
- **THEN** the system message and the blind-context message are arrays of text parts with `cache_control` on their last parts, and `provider` is `{"require_parameters": true}`

#### Scenario: OpenRouter model with automatic caching
- **WHEN** a request is sent to `openrouter/deepseek/deepseek-v4`
- **THEN** every message content is a plain string exactly as before this change

### Requirement: QA transport cache hints
Rio's QA transport SHALL apply the route's capability to harness requests, hosted or local, and drop any harness cache field. On `breakpoints` routes it SHALL mark, within four markers, the last system block, the last block, the block before the newest image, and the block before the latest replaced screenshot, else before the QA boundary line. On `key` routes the key SHALL be scoped to tenant, QA run and cell. Marker splits SHALL NOT change the joined text.

#### Scenario: First request of a journey
- **WHEN** a harness request on a `breakpoints` route has no image and a first user text containing the QA boundary line
- **THEN** the system, the run-stable part and the last block carry markers, and joining the first user message's text blocks reproduces the harness text exactly

#### Scenario: Turn without a new screenshot
- **WHEN** a harness request follows one that carried the same newest screenshot
- **THEN** its content matches the previous request up to the previous request's last-block marker

#### Scenario: Screenshot replaced on the next turn
- **WHEN** request N ends with a tool result and a screenshot, and request N+1 carries a newer screenshot, so N's screenshot is replaced by the omitted-screenshot text
- **THEN** N+1 has the same tool message and follow-up message text as N, with only the image part replaced, and N+1 carries a marker exactly where N's marker before that screenshot was, with identical content before it

#### Scenario: Many tool turns between screenshots
- **WHEN** more than 20 content blocks are added between two screenshots
- **THEN** the request after the second screenshot still carries a marker at the position of the first screenshot's marker, so its reuse does not depend on Anthropic's 20-block lookback

#### Scenario: Boundary line missing
- **WHEN** the first user text has no boundary line and the request has no replaced screenshot
- **THEN** only the system, newest-image and last-block markers are sent

#### Scenario: Harness-supplied key
- **WHEN** a harness request carries its own `prompt_cache_key`
- **THEN** the forwarded request carries Rio's key for the run and cell instead

### Requirement: Shape-stable screenshot replacement
Independent of every switch and route capability, when the QA proxy replaces an earlier screenshot, the QA transport SHALL route the omitted-screenshot text from a tool result the same way as an image, into the follow-up user message for screenshots, so the replaced screenshot keeps its message and position. Only the image part SHALL change. Everything before it SHALL stay byte-identical to the earlier request.

#### Scenario: Replacement with every switch off
- **WHEN** a QA harness request on a `none` route carries a replaced screenshot from an earlier tool result
- **THEN** the omitted-screenshot text sits in the follow-up user message where the image was, and the tool message keeps its text

### Requirement: Local QA transport hints
A local host relay SHALL send QA hints only for the classes listed in the local route's `prompt_cache`, deciding the capability and usage convention from the route's endpoint URL rather than its model alias. Because it serves one run and cannot see the cell, its OpenAI key SHALL be scoped to the run.

#### Scenario: Local route without classes
- **WHEN** a local route has no `prompt_cache` list
- **THEN** its requests carry no cache field, key or marker, and the harness still receives the provider's cached-token count

#### Scenario: Local OpenAI key
- **WHEN** a local route to OpenAI's API lists `openai`
- **THEN** each request carries Rio's per-run key instead of any key the harness sent

### Requirement: Routes without cache support
On a `none` route the request body SHALL be the plain-string rendering of its prompt text, in the same body format and with the same fields as before this change. No cache field, key or content-part array SHALL be added. Cache usage the upstream reports anyway SHALL still be normalized and recorded.

#### Scenario: Unified endpoint
- **WHEN** a request is sent to `compat/custom-node/m`
- **THEN** the body has `model`, string `messages`, `max_tokens` and `response_format` only, and a `prompt_tokens_details.cached_tokens` in the reply is recorded as reported with convention `unverified`, or as `null` with convention `invalid` when malformed

### Requirement: Declared cache support for custom providers
A custom provider in `AI_GATEWAY_PROVIDERS` and in the deployment configuration MAY declare `prompt_cache = "breakpoints"`, valid only with protocol `anthropic`. `rio init` and `rio deploy` SHALL save it and replay it, and SHALL reject it for protocol `openai` before any account access. Without the declaration the provider's capability is `none`.

#### Scenario: Declared Anthropic-compatible provider
- **WHEN** provider `node` has protocol `anthropic` and `prompt_cache = "breakpoints"`, a profile model is `custom-node/claude-sonnet-5-5`, and `PROMPT_CACHE` includes `anthropic`
- **THEN** requests to `GATEWAY/custom-node/messages` carry Anthropic cache breakpoints

#### Scenario: Declaration on an OpenAI-protocol provider
- **WHEN** `rio deploy` reads a provider with protocol `openai` and `prompt_cache = "breakpoints"`
- **THEN** the command fails naming the provider and the rule, and makes no Cloudflare request

### Requirement: Cache price configuration
An explicit model price SHALL accept optional non-negative `cache_read` and `cache_write` rates in USD per million tokens beside `input` and `output`. Prices are saved, replayed by `rio deploy` and uploaded in `MODEL_PRICES`. Configurations without the new rates SHALL remain valid.

#### Scenario: Price with cache rates
- **WHEN** `config.toml` lists price `anthropic/claude-sonnet-5-5 = {input = 3, output = 15, cache_read = 0.15, cache_write = 3.75}` and `rio deploy` runs
- **THEN** `MODEL_PRICES` contains all four rates for that model

#### Scenario: Negative rate
- **WHEN** a price has `cache_read = -1`
- **THEN** the deployment is rejected naming the model and the rate before any account access

### Requirement: Response cache bypass
Every request through AI Gateway SHALL carry `cf-aig-skip-cache: true` and `cf-aig-collect-log: false` and SHALL NOT carry `cf-aig-cache-key` or `cf-aig-cache-ttl`, whatever the route's prompt-cache capability. Provider prompt caching SHALL NOT be implemented through gateway response caching.

#### Scenario: Gateway request with cache breakpoints
- **WHEN** an Anthropic request with cache breakpoints is sent through the gateway
- **THEN** it carries `cf-aig-skip-cache: true` and no gateway cache key or TTL header

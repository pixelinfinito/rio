# model-usage Specification

## Purpose
Defines how Rio turns provider-reported token usage, including prompt-cache reads and writes, into budget charges, costs and audit metrics, so caching is measurable and never weakens budget enforcement or invents prices.

## Requirements

### Requirement: Normalized usage
Every model response SHALL be normalized to `input_tokens` (total input), `cache_read_input_tokens`, `cache_write_input_tokens` and `output_tokens`, with uncached input equal to total input minus reads and writes. Anthropic total input SHALL be `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. OpenAI-protocol total input SHALL be `prompt_tokens`, which already includes `prompt_tokens_details.cached_tokens` and `cache_write_tokens`.

#### Scenario: Anthropic cache read
- **WHEN** an Anthropic-protocol response reports `input_tokens` 50, `cache_read_input_tokens` 100000, `cache_creation_input_tokens` 0 and `output_tokens` 300
- **THEN** the normalized usage is total input 100050, cache read 100000, cache write 0, uncached 50, output 300

#### Scenario: Anthropic cache write
- **WHEN** an Anthropic-protocol response reports `input_tokens` 20, `cache_read_input_tokens` 0 and `cache_creation_input_tokens` 9000
- **THEN** the normalized usage is total input 9020, cache read 0, cache write 9000, uncached 20

#### Scenario: OpenAI cached tokens
- **WHEN** an OpenAI-protocol response reports `prompt_tokens` 12000 and `prompt_tokens_details.cached_tokens` 10240
- **THEN** the normalized usage is total input 12000, cache read 10240, cache write not reported (null), uncached 1760, and the read is not added to the total a second time

#### Scenario: No cache fields
- **WHEN** a response reports no cache fields
- **THEN** total input equals the reported input, and cache read and cache write are recorded as not reported (null), not as zero

#### Scenario: Usage reaches the ledger
- **WHEN** a `converse` turn, a council vendor call or a self-hosted member call settles its reservation
- **THEN** the settled usage carries the cache read, cache write, usage convention and cost source of the response, alongside total input and output

### Requirement: Usage convention per route
A static table SHALL mark a route's usage convention as `verified` only for the Anthropic Messages protocol and built-in OpenAI without `OPENAI_BASE_URL`. Every other OpenAI-protocol route and every self-hosted endpoint is `unverified`: input SHALL be charged as `prompt_tokens`, as before this change, reported cache counts SHALL be recorded with that convention, and the reads-plus-writes check SHALL NOT apply. This holds whatever `PROMPT_CACHE` is.

#### Scenario: Unverified route reports writes
- **WHEN** an `openrouter/` route with `PROMPT_CACHE=off` reports `prompt_tokens` 1000, `cached_tokens` 800 and `cache_write_tokens` 600
- **THEN** the call succeeds, 1000 input tokens are charged, both counts are recorded with convention `unverified`, and the call is left out of cache ratios

#### Scenario: Verified route
- **WHEN** a built-in `openai/` route reports `prompt_tokens` 1000 and `cached_tokens` 800
- **THEN** the counts are recorded with convention `verified` and the call counts toward cache ratios

### Requirement: Invalid cache usage
A cache field that is present but negative or not a safe integer, or verified-route counts whose reads and writes exceed `prompt_tokens`, are invalid. On a verified route the call SHALL fail with an invalid-cache-usage error, without retry, keeping its whole reservation. On an unverified route the call SHALL succeed as before this change, with those fields recorded as `null` and convention `invalid`. Its cost SHALL be the provider-reported cost when there is one, else `null` with source `unknown`, since whether the cache was used is not known. A response missing content or input and output usage keeps today's single transient retry.

#### Scenario: Reads exceed prompt tokens
- **WHEN** a built-in OpenAI response reports `prompt_tokens` 100, `completion_tokens` 40 and `cached_tokens` 500
- **THEN** the call fails with invalid cache usage after one transport call, and its reservation is charged in full

#### Scenario: Negative cache write
- **WHEN** an Anthropic-protocol response reports valid input and output tokens and `cache_creation_input_tokens` -3
- **THEN** the call fails without a second transport call and settles nothing less than its reservation

#### Scenario: Unverified route reports a malformed count
- **WHEN** an `openrouter/` response reports `prompt_tokens` 1000, `completion_tokens` 40 and `cached_tokens` -5
- **THEN** the call succeeds after one transport call, 1000 input tokens are charged, cache read and write are `null`, the convention is `invalid`, and without a reported cost the cost is `null` with source `unknown`

#### Scenario: Missing usage still retries
- **WHEN** a response has content but no usage object
- **THEN** the gateway retries once with the identical body, as before this change

### Requirement: Budgets charge total tokens
Reservations, settlements, per-agent and per-voter allowances and the "provider exceeded token allowance" check SHALL use total input plus output tokens. Cache reads and writes SHALL NOT reduce what a call is charged against a token budget. Whether a review fits its token limit SHALL NOT depend on cache state.

#### Scenario: Warm cache does not stretch the budget
- **WHEN** a voter's second turn reads 30000 of its 31000 input tokens from cache
- **THEN** 31000 input tokens plus the output are subtracted from the voter's allowance and the review's token budget

#### Scenario: Reservation bound unchanged
- **WHEN** a request is reserved before sending
- **THEN** the reservation is computed from the UTF-8 size of the full request as before, regardless of expected cache reads

### Requirement: Cost source
Each recorded call SHALL carry `cost_usd` and a `cost_source` of `provider`, `estimate`, `self-hosted` or `unknown`. Provider-reported cost (OpenRouter `usage.cost`) SHALL be preferred. Otherwise an explicit model price SHALL produce an estimate. Otherwise cost SHALL be `null` with source `unknown`. Self-hosted calls keep cost 0 with source `self-hosted`.

#### Scenario: OpenRouter reports cost with cache reads
- **WHEN** an OpenRouter response reports `usage.cost` 0.0123 and `cached_tokens` 8000
- **THEN** the recorded cost is 0.0123 with source `provider`, and no local price adjusts it

#### Scenario: Unpriced route
- **WHEN** a `compat/` route reports usage and no price names the profile model
- **THEN** the recorded cost is `null` with source `unknown`

### Requirement: Cache-aware cost estimate
An estimate SHALL equal uncached input × `input` + cache reads × `cache_read` + cache writes × `cache_write` + output × `output`, with rates in USD per million tokens. When a call has non-zero cache reads or writes and the price lacks the matching rate, the cost SHALL be `null` with source `unknown`. Reads and writes are never priced at the plain input rate.

#### Scenario: Full cache price
- **WHEN** a price is `{input: 4, output: 20, cache_read: 0.2, cache_write: 5}` and usage is uncached 1000, read 100000, write 0, output 500
- **THEN** the estimate is (1000×4 + 100000×0.2 + 500×20) / 1e6 = 0.034 USD with source `estimate`

#### Scenario: Missing cache-read rate
- **WHEN** a price is `{input: 4, output: 20}` and the call reports 100000 cache-read tokens
- **THEN** the recorded cost is `null` with source `unknown`

#### Scenario: Missing rate with no cache use
- **WHEN** a price is `{input: 4, output: 20}` and the call reports zero cache reads and zero writes
- **THEN** the estimate uses the input and output rates as before, with source `estimate`

### Requirement: Usage persistence
The usage ledger and `GET /v1/reviews/{id}/audit` SHALL expose per call: total input, cache read, cache write, usage convention, output, cost and cost source. A `null` cache field SHALL mean the provider reported no usable value. Rows written before this change SHALL read as not reported.

#### Scenario: Audit of a cached call
- **WHEN** a review's audit is fetched after an Anthropic call with cache reads
- **THEN** its usage row shows total input, cache read, cache write, convention `verified`, output, cost and cost source

#### Scenario: Historical review
- **WHEN** the audit of a review recorded before this change is fetched
- **THEN** its usage rows have `null` cache fields, convention and cost source, and existing fields are unchanged

### Requirement: Prompt-cache report metrics
The report's `agent_audit.prompt_cache` SHALL give per phase: calls, verified calls reporting cache fields, unverified or invalid calls, total input, cache read, cache write, output and cost totals by source, plus the review's hint classes and layout features. A ratio SHALL be computed only over verified calls reporting cache fields, else `null`. No savings figure SHALL be reported.

#### Scenario: Mixed reporting
- **WHEN** a phase has four calls, two reporting cache fields with 9000 reads of 10000 input, and two reporting none
- **THEN** the phase shows calls 4, calls reporting cache 2, cache read 9000, and a read ratio of 0.9 computed over the 10000 input of the reporting calls only

#### Scenario: Nothing reported
- **WHEN** no call in a phase reports cache fields
- **THEN** the phase's cache read and cache write are `null` and its read ratio is `null`

#### Scenario: Verification usage stays compatible
- **WHEN** the report is produced
- **THEN** `agent_audit.verification_usage` keeps its existing fields and meaning, with input still counting total input

### Requirement: Cache metadata without secrets
Model-call records and council audit entries SHALL carry a hash and byte length for each prompt layer, never prompt text. Usage records, audit records and logs SHALL NOT contain prompt cache keys, credentials, tenant identifiers in clear text or provider response bodies.

#### Scenario: Model-call record
- **WHEN** a model call's result is stored
- **THEN** the record carries the content, normalized usage, cost, cost source and layer hashes and byte lengths, and no `prompt_cache_key` value, tenant partition secret or request headers

#### Scenario: Council audit entry
- **WHEN** a council vendor member's call is recorded
- **THEN** its audit entry carries layer hashes and byte lengths beside `rendering_hash`, and no prompt text

### Requirement: QA transport usage
Responses passed back to a QA harness through Rio's QA transport SHALL report normalized usage: total input in `input_tokens`, the provider's cache reads in `input_tokens_details.cached_tokens`, and output. QA cell budgets SHALL be charged total input plus output. Each QA usage record SHALL carry cache read, cache write, usage convention, cost and cost source, priced as for other calls. Invalid cache fields follow the invalid-cache-usage rule.

#### Scenario: Anthropic cache read through the QA transport
- **WHEN** an Anthropic upstream answers a QA harness request with `input_tokens` 50, `cache_read_input_tokens` 100000 and `output_tokens` 300
- **THEN** the harness receives `input_tokens` 100050 and `cached_tokens` 100000, and the cell is charged 100350 tokens

#### Scenario: OpenAI cached tokens reach the harness
- **WHEN** an OpenAI upstream reports `prompt_tokens` 12000 with `cached_tokens` 10240 for a QA request
- **THEN** the harness receives `cached_tokens` 10240 instead of 0, and the usage record shows cache read 10240

### Requirement: Self-hosted cache usage
A self-hosted council member's model job SHALL pass through `prompt_tokens_details.cached_tokens` unchanged as a raw JSON value when the endpoint reports it. The Worker SHALL record it as a cache read with convention `unverified` only if it is a safe integer from 0 to the reported input, and otherwise as `null` with convention `invalid`, without failing the member call. When absent it is not reported. Budget charging stays total input plus output.

#### Scenario: vLLM reports cached tokens
- **WHEN** a self-hosted endpoint reports `prompt_tokens` 5000 and `cached_tokens` 4096
- **THEN** the council usage row records total input 5000 and cache read 4096, with cost 0 and source `self-hosted`

#### Scenario: Invalid self-hosted count
- **WHEN** a self-hosted endpoint reports `prompt_tokens` 5000 and `cached_tokens` 6000, -1 or 12.5
- **THEN** the member call completes and settles as it would today, with cache read `null` and convention `invalid`

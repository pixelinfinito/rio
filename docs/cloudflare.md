# Cloudflare endpoint and runners

The v0.2 control plane is a TypeScript Worker API, one `ReviewWorkflow` per review,
Queues for runner dispatch, D1 for ownership/state/budgets, and private R2 objects
for immutable snapshots and evidence. Workflow step results contain R2 keys rather
than source bundles. Execution runs in a Cloudflare Container behind the Sandbox
Durable Object, or an authenticated self-hosted Docker runner. These are the TRD's
two runner backends; the Workflows isolate itself never executes repository code.

Rio's model gateway is a Worker module with Anthropic, OpenAI-compatible and
OpenRouter adapters. Rio deployment provisions an authenticated Cloudflare AI Gateway provider proxy. It does
not replace Rio's token ledger, tool permissions or evidence validation.

## Account setup and deployment

Install the released Rio binary and Cloudflare's `cf` CLI, then authenticate in
your own account. Rio has no shared service or maintainer account dependency.
Sandbox deployment also needs Docker with a running daemon to copy the paired
released Linux runner image into **your** Cloudflare registry. Self-hosted runner
deployment does not need Docker on the deploying machine. Enable Workers Paid,
D1, R2, Queues and Containers in the account as appropriate for your runner.

```sh
cf auth login
# Supply OPENROUTER_API_KEY using your private environment/secret manager.
rio init
rio review --profile rio/openrouter --preset standard
rio deploy
```

`rio init` embeds its paired, precompiled Worker and calls Cloudflare APIs for
Worker upload, D1/R2/Queue creation or reuse, Workflows, AI Gateway, secrets and
Sandbox registration. It needs no source checkout, npm, Wrangler build or Node
build toolchain. `cf` handles OAuth refresh; `CLOUDFLARE_API_TOKEN` is also supported.
When more than one account is accessible, use `--account ACCOUNT_ID` (or choose
interactively). `--cf-profile PROFILE` selects a cf authentication profile.
No account ID or provisioned resource ID is written to the repository.

The default resource prefix is `rio`; use `--name rio-team` for an independent
installation. Rio refuses to reassign another Worker's Workflow, queue consumer
or Sandbox namespace. Bindings are `DB`, `ARTIFACTS`, `REVIEWS`, `MIGRATIONS`,
`JOBS` and `SANDBOX`. The migration Workflow records forward-only schema versions
and applies each version in a D1 transaction with a deployment lock.

```sh
rio init --runner self-hosted --account ACCOUNT_ID
rio init --from /path/to/saved-config.toml
rio deploy --dry-run
```

Choices persist in `~/.config/rio/config.toml` (`RIO_CONFIG_DIR` overrides this).
`--from` reads this same format, so deployment can run non-interactively in CI.
An explicit `--account` overrides the copied account; resources are resolved in
that account rather than copying resource IDs. `rio deploy` reuses those choices
and secrets. A partial deployment can be resumed with the same command. Dry-run
prints the offline plan and embedded bundle hash without logging in, writing
credentials, building images or changing account resources.

The OS keychain stores API, runner, provider and AI Gateway credentials by default.
On a headless host without an unlocked keychain, explicitly select
`--credential-store file`: secrets then live in a private user directory, with
mode 0600 on Unix, separated by account and deployment name. The API and runner
secrets are independent generated random values. Interactive setup prompts for a provider key with terminal echo disabled.
Non-interactive model keys come from
`OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or a private JSON file
passed with `--secrets-file`; values never appear in command arguments or the
saved configuration. Updating a model key and running `rio deploy` installs it as
a Worker secret. Deployments create an account-scoped **AI Gateway Run** token;
provide `AI_GATEWAY_TOKEN` if your deployment credentials cannot create account
tokens. The broad cf deployment OAuth token is never installed in the Worker.
Gateway caching and prompt log collection are disabled; voters also explicitly
bypass the cache on each call. Provider billing remains with your OpenRouter or
other model provider account.

Deployment credentials need account read, Workers Scripts/Durable Objects/Queues/
Workflows, D1 and R2 edit, AI Gateway configuration, Containers/registry permissions
for Sandbox, and account-token creation unless a gateway token is supplied. Use
the account selector to restrict deployment to the intended account. `cf auth
scopes` diagnoses OAuth scope availability. Cloudflare feature/billing activation
are account prerequisites. Rio reuses an existing workers.dev subdomain or
registers an account-derived one when absent; `--workers-subdomain NAME` chooses
the name to register for an account that has none.

Release maintainers publish the paired public
`ghcr.io/pixelinfinito/rio-runner:VERSION` image with each CLI release. The GHCR
package must be public. Rio copies it into the deploying account's registry.
For a development build or a custom image, use:

```sh
docker build -f worker/Dockerfile -t my-rio-runner:dev .
rio init --runner-image my-rio-runner:dev
```

An existing `registry.cloudflare.com/ACCOUNT/IMAGE:TAG` can also be passed to
`--runner-image` to avoid a local Docker copy. The checked-in `wrangler.jsonc`
is a development template with placeholders; manual Wrangler deployment is
available for contributors and is not required for released Rio installations.
Run `npm ci`, `npm run generate`, `npm run bundle` and `npm run check` in `worker/`
after runtime changes. The generated validators and embedded bundle are committed
and checked for drift in CI. No runtime schema compilation is used in Workers. Successful setup creates a
personal default model profile if none exists, while preserving existing profiles.

## Client setup

```sh
rio init --endpoint https://rio.YOUR-SUBDOMAIN.workers.dev
# Configure RIO_API_TOKEN in your shell's private secret environment, or:
# your-secret-manager read rio-api-token | rio init --endpoint https://... --token-stdin
rio review --preset standard --format json
rio review --preset quick
rio review --deep
```

`rio init --endpoint` connects an existing endpoint and writes user configuration, preserving other machine settings. Optional
`--token-stdin` stores the API credential in the user configuration directory with
mode 0600 on Unix, inside a private directory. `RIO_API_TOKEN` takes precedence.
`RIO_ENDPOINT_URL` overrides the configured endpoint. HTTPS is required except
for loopback development. Redirects are disabled so bearer credentials cannot be
forwarded to another origin.

Endpoint mode captures selected base/head snapshots, the graph and owner guidance
without running repository commands on the developer's machine. Deterministic
checks run in the selected remote runner using the existing Rust engine.
The impact graph is built locally with a 120 s budget (`RIO_GRAPH_BUDGET_SECS`
overrides it); on a very large change the review continues with a truncated graph
and says so in the report. The submitted graph is bounded to 2 MiB of JSON per
version, keeping the nodes nearest the change (seeds, then ascending hop) and the
edges among them, because large repositories reach tens of thousands of edges at
two hops; the runner rebuilds the complete graph from the snapshot. Agents receive
one excerpt of at most 16 KiB in their prompt: each changed symbol with the code
that uses it (path, symbol and line range, base and head merged), code outside the
change first. They query the rest through `graph_query`, by path and symbol.
Submodule entries are omitted from snapshots; the diff lists them as
`submodule_not_reviewed`. `--offline`, or no endpoint, retains the local deterministic review.
`--fork` forces a static-only review; model execution is denied after manifest
overrides. `--since-last` reviews the branch as a lineage held by the endpoint.
`rio review --pr <n>` asks the endpoint to prepare and review pull request `n` of the
repository's GitHub `origin` (the endpoint needs the GitHub App, see
[GitHub App](github-app.md)); nothing is built from the local checkout, and
`--publish` is the consent a `publish: ask` profile requires.

Models belong in the review profile, for example:

```yaml
version: 1
name: endpoint
extends: rio/base
models:
  default: openai/YOUR_MODEL
  verifier: anthropic/YOUR_OTHER_MODEL
verify: { voters: 3, quorum: 2 }
```

Use provider model identifiers available in your account. `verify.model` selects
an alias; otherwise `verifier` wins over `default`. A single voter must resolve to
a different provider/model from the generating default. Multiple voters may use
the same model. Unknown explicit aliases fail validation.

Optional Worker variables: `OPENAI_BASE_URL` for an OpenAI-compatible HTTPS API
(used without a gateway);
`AI_GATEWAY_URL=https://gateway.ai.cloudflare.com/v1/ACCOUNT/GATEWAY` and secret
`AI_GATEWAY_TOKEN` for manual gateway configuration (Rio sets these automatically); `MODEL_PRICES` as JSON mapping a full
provider/model to `{ "input": USD_PER_MILLION, "output": USD_PER_MILLION }`.
OpenRouter charges use its reported usage cost; other unknown prices are reported as null rather than fabricated zero cost.

The built-in `rio/openrouter` profile uses `anthropic/claude-sonnet-5.5` for generation and
`openai/gpt-6.1-sol` for verification, both through OpenRouter. Override
these aliases in a child profile to select other OpenRouter models. The requested
Sonnet 5.5 and GPT-6.1 Sol identifiers were verified against OpenRouter's model
catalog on 2026-11-06; GPT-6.1 Sol also supports structured text outputs in
[its official model documentation](https://developers.openai.com/api/docs/models/gpt-6.1-sol).

## Custom endpoints through AI Gateway

Besides OpenRouter, OpenAI and Anthropic keys, `rio init` and `rio deploy` can
register your own OpenAI-compatible or Anthropic Messages endpoints as AI Gateway
[custom providers](https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/).
Interactively, choose provider 4 and answer the slug, protocol, base URL, hidden
key and the generation and verification models. Non-interactively:

```sh
# The key comes from the environment or --secrets-file, never from arguments.
export AI_GATEWAY_PROVIDER_KEY_NODE_OPENAI=...      # slug upper-cased, - becomes _
export AI_GATEWAY_PROVIDER_KEY_NODE_ANTHROPIC=...
rio init \
  --custom-provider node-openai:openai:https://api.llm.example/v1 \
  --custom-provider node-anthropic:anthropic:https://api.llm.example/v1 \
  --default-model custom-node-anthropic/claude-sonnet-5-5 \
  --verifier-model custom-node-openai/gpt-6.1-sol
```

The base URL is the API root that `chat/completions` (OpenAI protocol) or
`messages` (Anthropic protocol) is appended to, usually ending in `/v1`; Rio
rejects a base URL that already ends in an endpoint path, so no `/v1` is ever
duplicated. The definitions are saved in `config.toml` and replayed by every
`rio deploy` and by `rio deploy --from config.toml`:

```toml
[[deployment.custom_providers]]
slug = "node-openai"
protocol = "openai"               # or "anthropic"
base_url = "https://api.llm.example/v1"
# auth_header = "authorization"   # default for openai; "x-api-key" for anthropic
# prompt_cache = "breakpoints"    # anthropic only: the endpoint accepts cache_control

[deployment.model_prices."custom-node-openai/gpt-6.1-sol"]
input = 1.25                      # optional, USD per million tokens
output = 10.0
# cache_read = 0.125              # optional: cached input reads
# cache_write = 1.5625            # optional: cache writes (5-minute entries)

[[deployment.dynamic_routes]]
name = "support"
elements_file = "routes/support.json"   # relative to this file's directory
```

What a deployment does with them, idempotently:

- Each provider is created as an account-level custom provider with
  `enable: true`. Its key is sent once as the provider's `headers`, a
  JSON-encoded string (`{"Authorization":"Bearer …"}` or `{"x-api-key":"…"}`),
  and kept in the deployment credential store with a fingerprint of what was
  applied; a later deployment rewrites the headers only when the base URL or the
  rendered headers (the key or its `auth_header`) changed. A provider that already exists with the same slug is adopted: its base
  URL is corrected, and its headers are left alone unless Rio holds its key. A
  provider that does not exist needs `AI_GATEWAY_PROVIDER_KEY_<SLUG>`.
- Upstream keys never reach the Worker, `config.toml`, profiles or command output.
  The Worker receives `AI_GATEWAY_PROVIDERS` (each slug's protocol only), the
  gateway URL and its `AI_GATEWAY_TOKEN`, and `MODEL_PRICES` when prices are
  configured.
- Dynamic routes are created from their element files; a route whose deployed
  elements differ from the file gets a new version, which is deployed. Every page
  of the gateway's routes is read, and an unreadable element file or an unknown
  route list stops the deployment before anything is changed. With `--from`,
  relative element files resolve against the imported file and are saved as
  absolute paths.
- `MODEL_PRICES` is uploaded while prices are configured; after the last price is
  removed it is cleared once. A `MODEL_PRICES` set by hand and never managed by Rio
  is left as it is.
- The Worker is uploaded whole with all of its bindings, the `SANDBOX` Durable
  Object declaration (`class_name` only) and the Container declaration, as for any
  deployment; Worker settings are never patched separately.

Profile model identifiers:

| Model | Request |
| --- | --- |
| `openrouter/…`, `openai/…`, `anthropic/…` | the provider through its gateway endpoint, with the Worker's provider key |
| `custom-SLUG/MODEL` | `GATEWAY/custom-SLUG/chat/completions` or `GATEWAY/custom-SLUG/messages`, in the provider's protocol; the gateway adds the upstream key |
| `compat/PROVIDER/MODEL` | `GATEWAY/compat/chat/completions` with model `PROVIDER/MODEL` (OpenAI request shape), e.g. `compat/custom-SLUG/MODEL` |
| `dynamic/ROUTE` | `GATEWAY/compat/chat/completions` with model `dynamic/ROUTE` |

Gateway requests authenticate with `cf-aig-authorization: Bearer AI_GATEWAY_TOKEN`
and bypass the cache. Use the model names your endpoint serves; they may differ
from OpenRouter's (for example `claude-sonnet-5-5` rather than
`claude-sonnet-5.5`). A submission whose default, verifier or agent model cannot
be routed is rejected before the review starts, naming the alias. Only aliases a
review can call are checked, resolved as the Workflow does: an agent's step
declaration `model`, else the alias named after the agent, else `default`; the
verifier's `verify.model`, else `verifier`, else `default`.

Profiles written for a manual setup, where `OPENAI_BASE_URL` pointed at the
gateway's `/compat` endpoint and `AI_GATEWAY_URL` was blank, keep working: with
the gateway configured, `openai/custom-SLUG/MODEL` and `openai/dynamic/ROUTE` are
sent to the unified endpoint. Without `AI_GATEWAY_URL`, `OPENAI_BASE_URL` is used
as before. Custom endpoints usually report no price, so their cost stays unknown
(`null`) unless `model_prices` names the model; a usage `cost` field is trusted for
OpenRouter's own endpoint only.

### Prompt caching and layout switches

Two Worker variables control how Rio asks providers to reuse prompt prefixes.
Set them in `config.toml`; `rio deploy` validates both before any account access,
uploads them, and replays them with `--from`. An omitted setting leaves its
variable unset. A review is also rejected at submission while a variable holds
an unknown value.

```toml
[deployment.prompt]
cache = "anthropic,openai"        # PROMPT_CACHE: off, or anthropic, openai, openrouter
layout = "verifier-system"        # PROMPT_LAYOUT: agent-order, verifier-system, compaction, council-order, qa-order
```

| `PROMPT_CACHE` class | Routes | What is sent |
| --- | --- | --- |
| `anthropic` | `anthropic/…`, and `custom-SLUG/…` providers declared with `prompt_cache = "breakpoints"` (`--custom-provider SLUG:anthropic+breakpoints:URL`) | at most four `cache_control` breakpoints: the system prompt, the end of the reusable context, the conversation tail |
| `openai` | `openai/…` on OpenAI's own API (not an `OPENAI_BASE_URL`) | a `prompt_cache_key` scoped to the tenant, the review and the conversation |
| `openrouter` | `openrouter/anthropic/…`, `openrouter/google/gemini…` | content-part `cache_control` |

Every other route receives exactly the body it received before. Every class
and every layout feature is off by default; each becomes a default only after
its gate in `docs/evaluation/prompt-caching.md` has passed.

Every request also carries a tenant partition element before the first
repository-derived content, so tenants of one deployment never share a cached
private prefix. Its value is derived per provider from a random per-tenant
secret in the D1 table `prompt_partitions`, created at the tenant's first review.
The secret is never sent, logged or reported, and there is nothing to rotate:
deleting a tenant's row gives it a new pseudonym from its next review, without
affecting its agent result cache.

### Usage, cache tokens and cost sources

Every model call records its total input (cache reads and writes included),
cache-read and cache-write tokens, output, cost and where the cost came from, in
the `usage` rows of `GET /v1/reviews/{id}/audit` and per phase in the report's
`agent_audit.prompt_cache`:

| `cost_source` | Meaning |
| --- | --- |
| `provider` | the provider reported the charge (OpenRouter `usage.cost`) |
| `estimate` | computed from `model_prices`: uncached input × `input`, cache reads × `cache_read`, cache writes × `cache_write`, output × `output` |
| `self-hosted` | a self-hosted council member; cost 0 |
| `unknown` | no price names the model, or the call used the cache and the price has no rate for it; the cost is `null` |

Cache reads are never priced at the plain input rate. A `null` cache count means
the provider reported no usable value. `usage_convention` says whether a call's
cache counts are trusted: `verified` on the Anthropic Messages protocol and on
OpenAI's own API; `unverified` on every other route (OpenRouter, `compat/`,
`dynamic/`, custom providers, an `OPENAI_BASE_URL`, self-hosted endpoints), where
Rio charges the reported prompt tokens exactly as before and leaves the call out
of cache ratios; `invalid` when such a route reported a malformed cache count,
which is then recorded as `null`. A malformed cache count on a verified route
fails the call without a retry, because the reply was billed; the call keeps its
whole reservation. Token budgets always charge total input plus output, so
caching lowers cost and latency, never what a review may spend.

## Council vendors

The `rio/council` step (enabled in `rio/security` and `rio/critical`) sends one evidence pack per councilled finding to every member's vendor. It runs only with vendors you allow. After the primary provider, a first `rio init` asks whether to add a council (default no). Non-interactively, pass one `--council-vendor VENDOR:FAMILY:ROUTE` per vendor, or `--no-council` to skip the step and clear a saved allowlist:

```sh
ANTHROPIC_API_KEY=... rio init \
  --council-vendor anthropic:claude:anthropic/claude-sonnet-5.5 \
  --council-vendor openai:gpt:openai/gpt-6.1 \
  --council-vendor google:gemini:compat/google-ai-studio/gemini-3-pro
```

`ROUTE` is a model route as in profiles: `openai/`, `anthropic/` and `openrouter/` routes need that provider's key (environment or `--secrets-file`; stored as Worker secrets), `custom-SLUG/` routes need the custom provider, and `compat/` and `dynamic/` routes go through AI Gateway. The allowlist is saved as `[[deployment.council_vendors]]` in `config.toml` (no keys), replayed by `rio init --from config.toml`, and written to the Worker as `COUNCIL_VENDORS`. Placeholder council members are filled from it in turn across families; `rio profile show rio/security` lists members still unconfigured. A member runs only when its vendor is in both the profile's `council.vendors_allowed` and this allowlist. Every transfer is listed by hash and size in `GET /v1/reviews/:id/audit` (`council`) and in `reviews/<id>/council/audit.json`; packs and assessments follow the evidence retention, the audit rows stay.

## Self-hosted runner

```sh
docker build -f worker/Dockerfile -t rio-runner:0.3.0 .
# RIO_RUNNER_SECRET is the endpoint's RUNNER_SECRET, supplied via secret environment.
RIO_ENDPOINT_URL=https://rio.YOUR-SUBDOMAIN.workers.dev \
  cargo run --locked -p rio-runner -- serve --image rio-runner:0.3.0
```

The host only polls jobs, downloads job archives, starts Docker and signs
completions. Source and commands are streamed over stdin (see the snapshot
protocol below), never interpolated into shell code. Each job uses
a fresh non-root container, no network, a read-only root, a private bounded tmpfs,
all capabilities dropped, no privilege escalation, two CPUs, 2 GiB of memory and
128 PIDs. Wall and output limits kill process groups; the host removes the whole
container after completion or timeout. Do not mount the Docker socket, credentials
or host workspace into the execution container. The Docker daemon itself is part
of the trusted runner host. Use a dedicated machine/account for untrusted code.

Cloudflare Sandbox uses the native Container API with network disabled, a fresh
container per job, CPU/memory limits, a non-root executor, a bounded output stream
and container destruction in `finally`. The default Sandbox application uses four
vCPUs and 12 GiB (`standard-4`, at most ten at once) to meet Cloudflare's
instance-size constraints; Sandbox job records declare that ceiling. The Docker
backend uses two CPUs and 2 GiB. Analysis jobs (checks, graph) get up to eight
minutes of command wall, capped at 40% of the review's remaining time, plus a
transfer allowance for their archive (a minute plus 4 MiB/s, at most four
minutes); run commands keep two minutes. A deadline is a timed-out result, never
redelivered, and a missing analysis leaves the review incomplete rather than
failing it. Its immutable materializer rejects path
escapes and does not follow symlinks. Tool run permission defaults to true for
correctness/verifier and false for other general agents. Profile agent declarations
can override `run`; fork review restrictions take final precedence.

The runner image includes Rust, Python and Node. Project dependencies must be
available in a deliberately provisioned runner image to execute their checks
without network. Missing or mismatched dependencies produce incomplete check
outcomes; Rio does not silently install packages or call an incomplete run clean.

## Snapshot protocol

A hosted review uploads both complete trees, because remote checks build the
repository. Each distinct file content is stored once per tenant, so base and head
share their unchanged files and a later review of the same repository uploads only
new contents. No endpoint component holds a whole tree in memory: steps and tools
read files on demand, and runners receive a streamed archive.

Limits, checked by the CLI before uploading anything and enforced by the endpoint:
300,000 paths per tree, 64 MiB per file, 1 GiB of distinct content across both
trees, and 8 MiB per request body. The CLI error names the exceeded limit, the
measured value and, for the file limit, the path.

A content is identified by the lowercase hex BLAKE3 hash of its bytes (a symbolic
link's content is its target). All routes need `reviews:write`.

1. `POST /v1/contents/missing` with `{"hashes": [...]}` (1 to 10,000 distinct hashes)
   returns `{"missing": [...]}`, the hashes the tenant has not stored, in request
   order. Another tenant's identical content is reported missing.
2. `PUT /v1/packs` (`application/octet-stream`, at most 8 MiB) uploads several
   contents. The body is a 4-byte big-endian length `N`, then `N` bytes of index JSON
   `[{"hash": h, "size": n}, ...]` (1 to 2,000 distinct entries), then the contents
   concatenated in index order. Every hash and size is verified before anything is
   stored; a mismatch rejects the whole pack. Returns `201 {"pack": id, "contents": k}`.
   Re-uploading stored contents is harmless.
3. A content over 7 MiB is uploaded in 8 MiB parts:
   `POST /v1/contents/<hash>/uploads` with `{"size": n}` returns `{"upload": u}`
   (or `{"present": true}` when already stored);
   `PUT /v1/contents/<hash>/uploads/<part>?upload=<u>` sends part 1, 2, … (every part
   but the last exactly 8 MiB) and returns `{"part": p, "etag": e}`;
   `POST /v1/contents/<hash>/uploads/complete?upload=<u>` with
   `{"size": n, "parts": [{"part": p, "etag": e}, ...]}` assembles the content,
   verifies its hash and size, and returns `201 {"hash": h, "size": n}`.
4. The manifest lists every path of both trees, one canonical JSON line each:
   `{"version":"base","path":"src/a.rs","hash":"…","mode":33188,"size":120}` followed
   by `\n`, with exactly these keys in this order and standard JSON string escaping.
   Lines are sorted by version (`base` before `head`), then by path compared as UTF-8
   bytes, with no duplicates. Modes are `33188` (0100644), `33261` (0100755) and
   `40960` (0120000, symbolic link). The snapshot id is the BLAKE3 hash of the whole
   manifest. It is uploaded in chunks of whole lines, each at most 8 MiB, with
   `PUT /v1/manifests/<id>/chunks/<n>` (`n` from 0), then sealed with
   `POST /v1/manifests/<id>/seal` and `{"chunks": count}`. Sealing recomputes the id,
   checks the canonical form, paths, modes, limits and that every content is stored
   for the tenant, and returns `201 {"id": id}` (`200` when already sealed).

`POST /v1/reviews` references the sealed snapshot id as `snapshot_id`.

Runner jobs reference the snapshot (`snapshot_id`, `needs`: the versions the job
reads) instead of embedding files. The executor's standard input is one JSON header
line, the job plus `links` (`{"base": {path: base64 target}, "head": {…}}` for the
needed versions), followed by a POSIX tar archive of the needed trees: regular files
only, named `base/<path>` or `head/<path>`, with mode 0644 or 0755 and PAX headers
for long or non-ASCII names. Symbolic links are never materialized. The Cloudflare
Sandbox streams this input into the container. When a job needs both trees, the
Sandbox sends head whole and of base only the files that differ; files equal in
path, content and mode are listed in `same/base` members (a JSON array of paths
each) and the executor copies them from the head tree. A result carries the
phase a deadline ended (`transfer` or `command`) and the time each phase took. A self-hosted runner downloads the
same bytes from `GET /v1/runner/:review/:job/:attempt/archive` with its job
capability as the bearer token and pipes them into Docker.

## API, evidence and acceptance

Every API request uses `Authorization: Bearer ...` and `rio-protocol: 1`. The
bootstrap API secret owns the `owner` tenant. Additional tokens are stored hashed
in D1 `api_tokens`, scoped to a tenant and `reviews:read`/`reviews:write` or `*`,
with an expiry in Unix milliseconds. Never share the runner secret with clients.

- The content and manifest endpoints below register a snapshot; `POST /v1/reviews`
  then submits a versioned review referencing its id.
- `GET /v1/reviews/:id` returns state; `/report` returns the report when available.
- `/events` returns replayable SSE records. Reconnect with `Last-Event-ID`.
- `/audit` returns hypotheses, blind answers, voter outcomes, artifact references
  and separate generation/verification usage. All routes enforce tenant ownership.
- `POST /v1/reviews/:id/cancel` prevents further budget reservations and execution:
  it stops the review's running Sandbox jobs, withdraws its idle ones and ends
  the workflow's waits. The review then becomes `partial` with the findings made
  so far; a workflow that has not ended it within three minutes is terminated and
  the endpoint writes the partial report. Nothing that completes later changes it.
- Runner claims receive a short-lived, review/job/attempt-bound capability.
  Completions require HMAC-SHA256 over the exact request body bytes, keyed by that capability.
  Old attempts, expired capabilities and cross-review use are rejected.

Snapshots and guidance remain immutable private source artifacts. Persisted model,
vote, execution and report output is redacted using the deterministic secrets
catalog. R2 publication is atomic; D1 pointers are written only after object PUT.
The local cache stores the downloaded vote audit under `verification/audit.json`,
with the existing private/atomic run-cache rules. Risk tier is advisory and creates
no approval or successful PR check. No publisher ships here; `GET /v1/reviews/:id/report?format=sarif`
returns the report as SARIF 2.1.0 (see [finding history, proposals, SARIF and the agent cache](finding-history.md)).

For live acceptance, deploy to a test account, run a review with both supported
runner backends, interrupt/reconnect, inspect the vote audit and cost ledger, then
run the pinned verifier evaluation in `eval/verifier.py`. A recorded provider test
proves orchestration only; the PRD's 80% precision gate requires independently
adjudicated real model outputs. Do not mark that gate passed from synthetic tests.
The security step ships disabled in `rio/base`. Enabling it (or selecting the
`rio/security` profile) runs the independent security agent with the OWASP Top
10:2025 or ASVS 5.0 catalog through the shared verifier; the report lists the
catalog items it assessed and the ones it could not assess, with reasons, rather
than claiming a clean security review.

To repeat the local runner protocol and container-isolation checks:

```sh
cargo build --locked -p rio-runner
docker build -f worker/Dockerfile -t rio-runner:0.3.0 .
RIO_TEST_DOCKER=1 python3 -m unittest discover -s worker/runner/tests -v
```

These tests exercise authenticated claims, signed completions, cleanup, denied
network/secret access, resource limits and the trusted graph/fork-static engine.

## Browser QA on the Docker runner

QA uses a separate paired image and a three-container pod. Provision the runner
host with Docker, Python 3, OpenSSL and host `iptables` control, then build and
check the image from this source checkout:

```sh
cargo build --locked -p rio-runner -p rio-cli
docker build -f worker/Dockerfile.qa -t rio-qa:0.1.0 .
target/debug/rio-runner qa --self-test
target/debug/rio-runner qa --pod-self-test
```

Start the self-hosted runner using the command above, with `RIO_QA_IMAGE` selecting
the QA image (default `rio-qa:0.1.0`). Supply `RIO_QA_CREDENTIALS_FILE`, if needed,
as a private host JSON file containing only named synthetic persona credentials.
The runner forwards only names declared by the environment contract; provider
keys and the runner registration secret do not enter the application container.

The app receives an immutable snapshot, datastore processes and service doubles.
The browser receives Chromium and named fixture uploads. The controller receives
the harness, restricted MCP tools, journeys, scoped owner guidance and run-scoped
model/evidence/seed capabilities. It has no source checkout. Host firewall rules
block app/browser internet access and restrict controller egress to the endpoint
and approved upload hosts. Each run creates its own network and removes all pod
resources after completion, timeout or interruption. The report records the
actual isolation and egress policy.

QA jobs renew their leases every 60 seconds and use the configured QA wall
allocation rather than the ordinary two-minute tool timeout. Model requests are
charged to both the cell allowance and the shared review ledger. Cancellation
revokes model/storage access while allowing the runner to retain partial results
for audit. Evidence and seed uploads are scoped to the run, with independent
quotas and content hashes.

Hosted evidence is private. Reports use expiring signed URLs for individual
objects. `rio init` and `rio deploy` register the scheduled handler that deletes
artifacts at each run's configured `evidence.retention_days` expiry. This uses
Worker-bound storage permissions; it does not require bucket-management
credentials. `rio qa evidence prune --review REVIEW_ID` requests early removal
and revokes download links. Seed snapshots have their own leased pruning protocol.

A Sandbox-only deployment defers QA as `no_runtime` unless the step explicitly
sets `sandbox: allow`. With opt-in, the configured deployment image can run
static files or vendored Node/Python apps whose dependencies and required tools
are already supplied in the image or snapshot. Rio installs nothing during QA.
Repository Dockerfiles (`packaging: image`) return `no_runtime` with an
`unsupported_packaging` explanation; use the Docker runner for those apps.

Sandbox uses gateway authentication through a run-scoped Worker interceptor,
with general internet access disabled. App, browser and controller share one
container, so the report states `app_isolation: none`,
`egress: provider_pinned (sandbox)` and remains partial for isolation. Durable
Object alarms renew the run lease every 60 seconds, retain the final checkpoint
on cancellation, revoke capabilities and destroy the container. Subscription
reuse is available only for local Codex runs on Docker.

The deployment image includes Chromium and the QA harnesses. Provision any
additional app dependencies when building that image. Supply synthetic persona
credentials through the Worker's `QA_PERSONA_CREDENTIALS` secret, a JSON object
mapping the environment variable names in `.rio/qa.yaml` to their test values.
The local image integration test uses an isolated HTTP storage double; Worker
tests cover the interceptor's authorization and lease behavior:

```sh
docker build -f worker/Dockerfile -t rio-runner:qa-sandbox .
RIO_TEST_QA_DOCKER=1 python3 -m unittest worker/qa/test_sandbox.py -v
```

The [QA guide](qa.md) covers application packaging, seed/fixture definitions,
local model authentication, owner-guided UX recommendations and evidence replay.
To exercise synthetic app startup, service doubles and seed commands without
model spend:

```sh
docker build -f tests/fixtures/qa-sample/Dockerfile.qa -t rio-qa-sample tests/fixtures/qa-sample
RIO_TEST_QA_DOCKER=1 RIO_QA_SAMPLE_IMAGE=rio-qa-sample python3 worker/qa/test_app_runtime.py -v
RIO_TEST_QA_DOCKER=1 python3 worker/qa/test_seed_cli.py -v
RIO_TEST_QA_DOCKER=1 python3 worker/qa/test_author.py -v
```

The authoring test uses a scripted harness and real screenshots. It establishes
orchestration and evidence delivery; live model quality remains a separate
[evaluation](../eval/qa/README.md).

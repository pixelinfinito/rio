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
a 16 KiB excerpt of each graph in their prompt and query the rest through
`graph_query`. Submodule entries are omitted from snapshots; the diff lists them as
`submodule_not_reviewed`. `--offline`, or no endpoint, retains the local deterministic review.
`--fork` forces a static-only review; model execution is denied after manifest
overrides. PR fetching, publication and convergence flags (`--pr`, `--publish`,
`--since-last`) are outside the implemented transport and return an explicit error.

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

Optional Worker variables: `OPENAI_BASE_URL` for an OpenAI-compatible HTTPS API;
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

## Self-hosted runner

```sh
docker build -f worker/Dockerfile -t rio-runner:0.2.0 .
# RIO_RUNNER_SECRET is the endpoint's RUNNER_SECRET, supplied via secret environment.
RIO_ENDPOINT_URL=https://rio.YOUR-SUBDOMAIN.workers.dev \
  cargo run --locked -p rio-runner -- serve --image rio-runner:0.2.0
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
and container destruction in `finally`. The default Sandbox application uses two
vCPUs and 8 GiB (`standard-3`) to meet Cloudflare's instance-size constraints;
Sandbox job records declare that ceiling. The Docker backend uses two CPUs and
2 GiB. Its immutable materializer rejects path
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
Sandbox streams this input into the container. A self-hosted runner downloads the
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
- `POST /v1/reviews/:id/cancel` prevents further budget reservations and execution.
- Runner claims receive a short-lived, review/job/attempt-bound capability.
  Completions require HMAC-SHA256 over the exact request body bytes, keyed by that capability.
  Old attempts, expired capabilities and cross-review use are rejected.

Snapshots and guidance remain immutable private source artifacts. Persisted model,
vote, execution and report output is redacted using the deterministic secrets
catalog. R2 publication is atomic; D1 pointers are written only after object PUT.
The local cache stores the downloaded vote audit under `verification/audit.json`,
with the existing private/atomic run-cache rules. Risk tier is advisory and creates
no approval or successful PR check. No publisher or SARIF output ships here.

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
docker build -f worker/Dockerfile -t rio-runner:0.2.0 .
RIO_TEST_DOCKER=1 python3 -m unittest discover -s worker/runner/tests -v
```

These tests exercise authenticated claims, signed completions, cleanup, denied
network/secret access, resource limits and the trusted graph/fork-static engine.

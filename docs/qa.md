# Browser QA

With a configured `.rio/qa.yaml` and committed journeys, run `rio qa` for changed
coverage, `rio qa --full` for all journeys, or `rio qa --journey checkout` for an
explicit journey and its prerequisites. `--baseline` compares base and head;
`--harness codex|pi` selects the driver, and `--format terminal|md|json` selects
output. `--staged` and `--base REF` use the same snapshot selection as review.
The standalone command uses `rio/qa` by default, or an enabled QA profile selected
with `--profile`. It records other pipeline steps as `skipped: standalone` while
preserving verification and spending limits. Locally, a missing endpoint leaves
judged observations and recommendations unverified.

QA contracts live in `.rio/qa.yaml`, with journeys under `.rio/qa/journeys/`.
Run these commands from a Git repository containing those files:

```sh
rio qa validate
rio qa list
rio qa show checkout
rio qa show
rio qa fixtures status
rio qa rules
rio qa sync --check
```

These commands inspect an immutable snapshot of the working tree without
starting the app. Validation exits with code 2 for invalid contracts. Sync check
exits with code 1 when covered source or applicable `REVIEW.md` guidance changed
without an update to the journey. `--staged` and `--base REF` select the comparison
for sync check. Proposed journey files are validated and listed separately.

Run `rio qa sync` to re-walk stale journeys in the Docker pod and write validated
`<name>.proposed.yaml` files. It uses the configured harness, local subscription
or host keychain relay, and QA wall and token limits. The seed is ready before
exploration starts. The author receives scoped `REVIEW.md` requirements for each
visited route, including recovery expectations that the current app may violate.
Committed journeys stay unchanged. Existing proposals and files edited during
the run are protected; incomplete authoring writes no journey proposals.

For container HTTP applications, use `http://app.test:PORT` or a loopback URL in
the contract. Rio maps `app.test` to the app container. Avoid the bare hostname
`app`: Chromium's HSTS policy can upgrade it to HTTPS even when the app serves
HTTP. Service doubles use `app.test` for their internal URLs as well.

When `.rio/qa.yaml` is absent, init proposes defaults from `Dockerfile.qa` or
`Dockerfile` exposed ports, Node framework scripts with a lockfile and captured
`node_modules`, or a recognized Python entry point. It prints and writes the
validated contract before model access. A Compose-only project receives
`Dockerfile.qa.proposed` and an `unsupported_topology` error. Existing contracts
and symlinked paths are preserved. For unknown app conventions, the harness stages
`.rio/qa.proposed.yaml` without starting the application. Review it, then run
`rio qa init --accept-contract` to create the contract and continue. `--force`
does not accept a launch contract or replace existing setup definitions.

When seed or fixture manifests are missing, init first gives a restricted setup
harness bounded schema/model declarations and SDK, environment-variable-name and
host metadata. It stages synthetic seed definitions and service recordings; the
host validates paths, references, persona accounts and recordings before writing
new files. Existing definitions and concurrent edits are preserved. Setup has no
browser, shell, checkout or filesystem tools. All setup, discovery and browser
authoring phases share one wall, token and evidence allowance; a restart does not
refill it. Generated seed commands run only inside the app container, before
browser journey generation.

Before the first journey-authoring turn, init combines SDK/host metadata with
blocked-host diagnostics from application startup, including a failed startup.
It can append service doubles and their recordings while preserving existing
services, uploads, capture settings and defaults. Host validation checks every
claimed host and protects concurrent edits. It restarts the seeded app once with
the additions before generating journeys. Any remaining blocked hosts, pinned
TLS clients or unresolved SDK/URL-variable hints appear under
`undoubled_dependencies`; init does not enter an unbounded retry loop.

For a repository with a reviewed environment contract and seed/fixture definitions,
`rio qa init` installs the versioned authoring skill and explores the seeded app to
generate at least one smoke journey. Existing journeys receive `.proposed.yaml`
candidates. `rio qa init --force` permits replacement of committed journeys after
full validation; it still refuses concurrent edits. Initial generation receives
route-scoped owner guidance even when no journey coverage exists yet.

During execution, `read_dependencies` exposes recorded blocked hosts and TLS
rejections. The harness can mark a step skipped with the recorded host and an
explanation of why it is required. Rio retains the browser/network evidence and
marks the journey and its dependents `precondition_failed`; unrelated journeys
continue. A fabricated host cannot establish a dependency failure.

Build and inspect seeds independently of model access:

```sh
rio qa seed build
rio qa seed build --force
rio qa seed export /path/to/new-inspection-directory
```

Build restores a matching snapshot or runs the seed steps and captures a new one.
`--force` rebuilds without changing the fingerprint or deleting a snapshot leased
by another run. Both paths use the isolated app pod and require app readiness;
they make no model calls. Export resolves the current provisioned image and
fingerprint, verifies every part and archive hash under the cache lock, and writes
opaque archives plus `manifest.json` to a new directory. It does not unpack them.
The destination's parent must exist; existing destinations and symlinks are refused.

## Shared state and viewport overrides

Set `resets: true` on a chain head that creates or deletes records. A dependent
journey uses `after` and retains its predecessors' state, including a cart needed
by checkout. Combining `after` and `resets: true` is invalid.

Each dependent's resolved viewport set must be a subset of every prerequisite's
set. Mobile-only add-to-cart followed by desktop checkout fails validation.
Add-to-cart in mobile and desktop followed by mobile-only checkout is valid.
Each chain starts from a restored seed and fresh browser context in every cell.
All members must resolve to the same `context.time` after applying fixture
defaults, or all must use live time. Equivalent timezone offsets are accepted.
An omitted value inherits fixture defaults, not its predecessor’s override.
Validation rejects incompatible committed journeys and proposed replacements
before startup; dependents never restart the app to change its clock.

Seed fingerprints include the manifest, seed files, matched migrations,
fixture definitions, recordings and committed uploads, datastore kinds, `seed.cache_version` and the resolved app image digest. Command
seed steps conservatively include the captured source tree because shell commands
can load dependencies indirectly. File-only seeds do not invalidate on unrelated
source edits. Runtime persona credentials are excluded from the fingerprint and
are applied after restoration. Change `seed.cache_version` when other runtime
inputs alter the intended seed. The controller records the fingerprint and
build or restore duration. `rio qa seed status --image APP_IMAGE` inspects the
provisioned image and reports the current fingerprint, cached size and age, and
whether the next run would build or restore. Without an available image digest,
it reports that prerequisite instead of inventing a cache key. Local and hosted
seed stores, run-scoped storage authorization and the app/controller transfer
protocol are implemented. `rio qa seed prune --keep 3` keeps the newest three
local snapshots plus snapshots leased by active jobs. Imports, publication and
pruning share an OS lock; manifests are published only after complete transfers.
Host leases renew every minute and expire after three minutes without renewal.
Build and export command authoring is still being connected.

The app exposes a passive seed transfer endpoint on its controller-only port.
The controller pulls archives before persona credential application, or pushes
verified cache archives before startup continues. Only the controller handles
storage capabilities. A lease protects the snapshot for the run, including the
time between transfers. Quotas apply even without persistent storage; an
oversized seed fails with `seed_too_large` and names its largest archive. The
explicit `seed.fallback_rebuild` option rebuilds from private pristine archives
at chain boundaries, with the fallback recorded in seed events.

Hosted storage uses the authenticated `/v1/qa/seeds` routes. D1 tracks leases,
snapshot heads and immutable object versions in the tenant's private R2 `seeds/`
namespace. Parts are at most 8 MiB and verified with BLAKE3; publication verifies
each archive before committing its head. Uploads interrupted before that commit
are unavailable to readers. Leases renew every 60 seconds and protect both
running snapshots and parts retained by pending uploads. Pruning keeps the
newest requested snapshots, retains leased data and retries failed object
deletions. A concurrent upload uses a new physical object key, so deleting a
previous version cannot remove its bytes. Lowering one run's size cap does not
invalidate a larger snapshot still valid for other runs.

Hosted QA jobs have separate controller and runner capabilities, issued at claim
time and rotated when a runner is replaced. The runner renews its lease every
60 seconds and registers an immutable cell matrix and seed fingerprints. The
controller capability grants only the configured run's model and seed access;
it cannot prune the tenant's seed cache. Cancellation revokes controller access
while allowing the runner to submit its partial result for audit.

The hosted model endpoint reserves tokens in D1 before contacting the pinned
provider. Concurrent requests share the cell's allowance, and usage survives a
runner restart. Missing usage or interrupted requests consume the reservation;
provider credentials remain in the Worker. Head and baseline jobs share the QA
wall deadline. The Docker runner accepts QA claims, prepares the immutable app
image, configures the cell matrix, and runs the controller with heartbeat renewal.
The hosted workflow dispatches head runs and retains their outcomes, assessment
coverage and recommendation candidates. With `baseline: true`, a second pod runs
the same selected journeys against base within the shared deadline. Completed probe assessments or independent judged verification can establish new
or fixed occurrences; missing baseline evidence
stays unclassified. Hosted QA runs independent browser-evidence verification and a
separate recommendation grounding quorum. Sandbox execution and fresh-pod replay
dispatch remain in progress; candidates lacking verification evidence are labeled
explicitly. Unverified defect observations make hosted reports partial; recommendations alone do not change the run outcome.

Set `RIO_QA_IMAGE` on the runner to the provisioned QA image (default
`rio-qa:0.1.0`). Hosted persona credentials come from the operator's
`RIO_QA_CREDENTIALS_FILE`, a private JSON object mapping declared environment
names to synthetic test values. Only persona names declared in the immutable
contract are delivered to the app and controller; the runner's provider and
service credentials are never copied from its environment.

The host driver retains the last controller checkpoint before removing the pod.
Local evidence and seed objects are copied to the selected cache with regular-file
and size checks, and evidence links are rewritten to their retained paths. On
interruption the controller has a bounded grace period to finish traces; an
independent recovery process confirms container, network and firewall removal.
The driver also stops the pod if its supervising runner process disappears.

## Hosted evidence

The controller uploads sanitized evidence through a capability scoped to its run.
Uploads use bounded multipart buffers, verify each artifact's size and BLAKE3
hash, and publish it only while the job is still active. A reclaimed runner keeps
completed evidence and releases abandoned upload reservations. Required step
artifacts remain available when the evidence budget is reached; later traces
and video are omitted with a quota note.

Hosted manifests retain completed artifacts after interruption. Download links
are signed for one object and expire after seven days or the artifact's retention
period, whichever comes first. Reading a manifest with endpoint authentication
refreshes links that are still within retention; expired artifacts are labeled
with their expiry date. Each run fixes its expiry at creation plus the configured
`evidence.retention_days` (default 30). `rio init` and `rio deploy` install a
minute schedule that removes expired objects in bounded batches. Reads stop at
expiry even if deletion is delayed by a backlog or transient storage failure.
Failed deletions are retried; the Worker uses its existing R2 data binding and
needs no bucket-management credentials.
JSON reports map artifact ids to display links in `qa.evidence.artifacts`, using
epoch milliseconds for artifact and link expiry. Authenticated report downloads
refresh signed links from stored evidence. Terminal and Markdown show local paths
or clickable hosted links; cached output labels expired evidence and asks for a
refresh when only the download link has expired.

To delete all hosted evidence for one review and revoke its links:

```sh
rio qa evidence prune --review REVIEW_ID
```

This command uses the configured endpoint and owner token. It does not require
QA contracts in the current directory. Pruning also prevents active jobs from
publishing more evidence into that review. Failed object deletions remain in a
retry ledger; rerunning the command resumes cleanup.

## Owner guidance and UX

Applicable immutable `REVIEW.md` requirements steer goals, expectations and UX
assessment. Scope follows covered source and mapped routes, including unchanged
files. Root guidance is the fallback for unknown route scope. Guidance-only edits
and deletions can make a journey stale.

Conflicting requirements are recorded as unresolved expectations, with the
committed journey step, immutable guidance citations, observed behavior and
artifact references. They appear in the report audit and retained outcome record
for reconciliation through `rio qa sync`. A conflict alone creates neither a
defect nor a recommendation and cannot grant tools or change spending or policy.

The shipped rubric includes versioned usability criteria as well as UI probes.
Passing a functional journey does not establish that its experience is easy to
use. Improvement recommendations require observed friction and artifacts;
proposed benefits remain untested until separately evaluated. Recommendations
and defect findings have separate contracts and limits.

The controller measures all 18 built-in DOM probes. It records step-scoped
measurements with screenshot and DOM references, and finalizes style probes once
across the run's visited pages and cells. Repeated visits do not inflate the
eligible population. Style findings remain informational unless adopted through
`rules.adopt`; `rules.disable` excludes configured rules and
`rules.ignore_console` uses regular expressions.

Focus and hover probes use Chromium's pseudo-class inspection without firing
application focus handlers. Uncertain cases, such as contrast over a gradient or
a hover menu with a delegated touch handler, retain assessment gaps rather than
asserting a violation. Touch size and input font measurements establish their
stated heuristics; they do not establish WCAG failure or reproduced Safari zoom.

`mobile/offscreen-content` checks whether text or controls are unreachable through
normal document or nested scrolling, or clipped by a non-scrollable ancestor.
Content below the fold is allowed. An offscreen skip link is excluded only after
its focus styling is confirmed to reveal it without clipping; a link that remains
hidden is reported. These checks preserve the page's scroll and focus state.

## Evidence capture

The controller captures screenshots, DOM and accessibility snapshots, console and
network logs, and captured messages at each step. Artifact manifests record BLAKE3
hashes, sizes, journey, step and matrix cell. Local artifacts stay under the
ignored review cache; hosted sinks upload each sanitized artifact before its
manifest so completed evidence survives interruption.

Text redaction uses the shared secrets catalog plus runtime credential values.
Network bodies are sanitized before truncation to 16 KiB. Trace response bodies
are removed, every retained member is checked, and an unknown or unreadable
member drops the trace with `evidence_unsanitized`. Password controls and
`data-rio-mask` elements are masked at capture time, including shadow roots.
Optional traces and video stop at the evidence quota; required step artifacts
remain available and the manifest reports actual usage.

The controller browser acceptance suite requires `ffmpeg` and `tesseract-ocr`.
It checks seeded secrets across a complete bundle, including OCR of screenshots,
trace images and video frames sampled every second. CI provisions these tools.
Run `python3 scripts/generate-qa-assets.py --check` to check that the controller's
redaction catalog matches the report catalog.

## Runtime diagnostics

The QA image and Linux Docker pod can be tested independently of model access:

```sh
docker build -f worker/Dockerfile.qa -t rio-qa:0.1.0 .
cargo build -p rio-runner --locked
target/debug/rio-runner qa --self-test
sudo modprobe br_netfilter
target/debug/rio-runner qa --pod-self-test
```

The image test runs a bundled mobile browser interaction without network access.
The pod test creates three containers, streams a synthetic repository snapshot
into the app, connects Chromium over CDP, tests denied connections and a pinned
HTTPS destination, then removes containers, networks, the snapshot volume and
firewall rules. The test destination is `1.1.1.1:443`.

The sample application also exercises the startup coordinator and SQLite seed
restoration inside the pod:

```sh
docker build -f tests/fixtures/qa-sample/Dockerfile.qa -t rio-qa-sample:local tests/fixtures/qa-sample
RIO_TEST_QA_DOCKER=1 python3 worker/qa/test_app_runtime.py -v
```

This check builds the seed before applying synthetic persona credentials, starts
the payment/mail doubles, probes the app, runs its post-readiness hook and
completes checkout. It then resets the chain and completes checkout again from
the same initial database state. Startup failures identify their stage and keep
bounded, sanitized process output.

The seed transfer test uses fresh pods with a persistent cache, rotates the
persona password, checks that seed steps do not run on a cache hit, and inspects
the cached database to confirm that the applied password is absent:

```sh
RIO_TEST_QA_DOCKER=1 RIO_QA_IMAGE=rio-qa:0.1.0 python3 worker/qa/test_seed_transfer.py -v
```

The host must use Docker's iptables forwarding backend with
`net.bridge.bridge-nf-call-iptables=1`. The runner checks these prerequisites
before creating a pod. Rootful Docker uses host iptables; rootless Docker uses
the detached namespace identified by `dockerd-rootless/child_pid`. Existing
noninteractive sudo access is required when the runner cannot administer that
namespace directly. A runner administrator can set `RIO_QA_FIREWALL_PREFIX` to a
JSON argument array for a different trusted namespace-access command. Repository
configuration cannot set this prefix.

`rio review --profile rio/qa` now launches local Docker QA when no endpoint is
configured. It retains evidence, seed cache, plan, outcomes, assessment and raw
recommendations, and renders unverified UX advice separately from probe findings.
A missing Docker daemon defers QA as `no_runtime`; offline mode defers model work.
The standalone `rio qa` run form, authoring and fresh-pod verifier replay are still under
implementation in `rio-v0-3-qa`. The diagnostics do not establish end-to-end readiness.

Changed-mode runs reserve a bounded `exploratory` pass after committed chains for
routes derived from changed files. Each viewport/scheme cell skips routes the
earlier journeys actually visited. Exploration receives the nearest journey's
persona or an anonymous session, and only the immutable guidance for the remaining
routes. Its outcomes record visited routes and assessment coverage. Full and explicit
selections do not add this pass. An empty selection with no changed routes starts
neither an application nor a model. Plans retain selection reasons, whole-chain
held-back counts, cell counts and estimated wall time.

## Journey assessment and finding construction

The controller's journey coordinator connects `step_done` to independent capture
and probing. It enforces ordered, unique boundaries, retains the first failing
step, and captures an active step when execution ends. `observe` accepts only
retained artifacts from that journey and cell. Agent observations remain
hypotheses; deterministic probes carry their measured evidence.

`assess` records UX coverage and `recommend` records a separate improvement
candidate, for passing and failing journeys alike. Recommendations require
artifact references for every cited step and a valid citation into immutable
scoped guidance or the exact versioned criterion. The controller assigns their
identity and unverified status. Neither tool can alter a journey outcome or
verification policy. Missing assessments explicitly name the reason, including
budget exhaustion. The harness prompt receives the captured owner requirements,
journey goal and UX criteria together.

Browser actions and Rio tools produce closed `qa-replay-v1` events. Snapshot
references are resolved to selectors before actions change the page. The replay
driver uses the restricted tool set without a harness, stops at the requested
step and retains replay evidence. Failed prerequisites, redacted inputs and
budget exhaustion remain inconclusive. Runner CLI replay and full run dispatch
are still being connected.

Finding construction runs on the trusted host. It resolves development
annotations, then error stacks, then unique text or class matches in changed
files against the immutable snapshot, falling back to the journey step. QA IDs
exclude viewport, measured values and presentation text. Cell occurrences merge
without losing their evidence; new, pre-existing, fixed and worsened states are
classified only against completed baseline assessments. An incomplete baseline
cell remains unclassified.

The Codex and pi drivers use isolated per-run configuration, the authenticated
controller-loopback MCP endpoint, non-interactive execution and a bounded
process group. Their JSONL transcript envelope is sanitized before retention.
Provider and persona environment variables are not inherited by harnesses; model
requests use a local proxy capability. Pi disables built-in tools and extension,
skill and repository-context discovery. Codex disables command execution,
patching, local image reads, web search, apps, agents and other active integrations.
Its built-in MCP resource discovery remains present, but the QA server exposes no
resources; even a `file:` resource request is rejected. QA tool approval applies
only to the explicitly listed tools on that server.

The configuration follows the [official Codex configuration reference](https://developers.openai.com/codex/config-reference/)
and is checked against the pinned CLI. CI runs both real CLIs against a local
scripted Responses endpoint with external networking disabled; separate tests
exercise browser steps and compare their evidence. These protocol tests do not
replace the pending model-driven end-to-end evaluation.

Authentication and model budgets are enforced separately from journey prompts.
`harness.auth: auto` selects an available Codex subscription for local Docker;
otherwise it selects the gateway. Explicit `subscription` is rejected for pi,
hosted runs and Sandbox. `rio doctor` reports the resolved authentication path,
Docker and image availability, and whether tokens are metered. Subscription
runs have a wall budget and report `tokens: unmetered`.

The runner mounts only the host's Codex `auth.json`, read-only into the controller.
A trusted bootstrap copies its subscription fields to private tmpfs and drops
all privileges before starting the controller. The harness uses a clean temporary
home; user configuration, extensions and repository source are not mounted. API-key
login files are excluded from subscription reuse. The original auth file is never
modified, and credentials never enter the run cache.

For local provider-key authentication, `rio-qa` resolves the operator's keychain
entry on the host and launches a bounded model relay. The controller receives a
run capability and a single Unix socket mount; neither app nor browser receives
that mount. Provider keys cross only the host relay's private input pipe, never a
container environment or a configuration file. The local host needs Node.js for
this relay. Hosted controllers instead use the Worker-issued run capability.

Set `RIO_QA_MODEL_ROUTE` to a host-owned JSON file containing route metadata, for
example:

```json
{
  "url": "https://api.openai.com/v1/chat/completions",
  "protocol": "openai",
  "model": "qa-model",
  "provider_model": "gpt-5.4",
  "keychain_service": "rio-qa",
  "keychain_account": "openai"
}
```

Store the provider credential in that operating-system keychain entry. An optional
`keychain_field` selects a string from an existing JSON credential entry. An optional
`prompt_cache` list (`anthropic`, `openai`, `openrouter`; empty by default) enables
prompt-cache hints for this route: cache breakpoints on Anthropic, a per-run
`prompt_cache_key` on OpenAI's API, and content-part breakpoints for Anthropic and
Gemini models on OpenRouter. Other endpoints get no hints. Route
metadata is read from the host, never from the repository. For an AI Gateway custom endpoint, set `authentication: "ai_gateway"`, point `url` at its compatible chat-completions endpoint, and store the gateway token in the named keychain entry. Rio sends it as `cf-aig-authorization`, disables gateway caching and prompt logging, and does not send it as a provider API key. Local persona credentials
come from the environment variables named by the captured contract. Baseline runs
retain their own manifest and use the same journey definitions and viewport matrix
as head; application and seed inputs come from their respective snapshots.

The controller proxy reserves input and output allowance before each request,
rotates capabilities between cells, and keeps usage records without prompt or
credential values. Concurrent requests share the cell allowance. A request that
was forwarded but lost its final usage consumes its entire reservation. Token
exhaustion cancels the rest of the cell with reason `budget` and preserves evidence.
The provider adapter translates Responses tool calls into Chat Completions or
Anthropic Messages, preserving namespaces, screenshots and terminal usage. It
rejects provider-side tools, remote input references and redirects.


Datastore servers and clients must be installed in the application image. Rio
starts them on container loopback before loading seed definitions. PostgreSQL
uses an isolated cluster, MySQL/MariaDB an isolated data directory, and Redis an
isolated RDB configuration. SQLite uses its backup API. Every restore replaces
the captured database state, including removing tables or keys created by the
previous chain. File snapshots retain regular files and empty directories and
reject links, traversal, duplicate members and excessive expansion before
replacing a directory. Custom capture and restore commands exchange one archive
on stdout/stdin inside the app container.

For example, a PostgreSQL seed manifest can contain:

```yaml
version: 1
datastores:
  - name: shop
    kind: postgres
    connection_env: DATABASE_URL
steps:
  - file: schema.sql
    applies_to: [shop]
users: []
paths: [uploads]
```

Use `DATABASE_URL=postgres://127.0.0.1:5432/shop` in the application's synthetic
test environment. For SQLite, change the kind to `sqlite` and set the connection
variable to `data/shop.sqlite`. Put `schema.sql` beside the seed manifest; it must
create synthetic data only. Declare each persona's credential application under
`users` so it runs after capture and after every restore.

The fixture image provisions SQLite, PostgreSQL, MariaDB and Redis for the
adapter acceptance tests. Missing server/client binaries fail with `missing_tool`
and record the binary and app image. The QA base image itself deliberately has
client tools only; each application image owns its server provisioning.

## Service and file fixtures

Declare service doubles and upload files in `.rio/qa/fixtures/fixtures.yaml`:

```yaml
version: 1
files:
  - name: contacts
    generate: { kind: csv, rows: 200000 }
services:
  - name: payments
    kind: http-mock
    env: { PAYMENTS_API_BASE: '{{url}}' }
    claims: [payments.example.test]
    recordings: recordings/payments
    behaviors: [approve, decline]
    default_behavior: approve
  - name: mail
    kind: smtp-capture
    env: { SMTP_HOST: '127.0.0.1', SMTP_PORT: '{{port}}' }
capture: { mail: true }
defaults: { timezone: UTC, locale: en-US, network: online }
```

Each JSON file in the recordings directory contains one recording or an array.
For example, `recordings/payments/approve.json` can contain:

```json
{"behavior":"approve","request":{"method":"POST","path":"/v1/charges"},"response":{"status":200,"headers":{"content-type":"application/json"},"body":{"id":"charge_synthetic","status":"succeeded"}}}
```

Add a `decline` recording for the same method and path with status `402` and a
synthetic error body. Methods and paths match exactly; optional request `headers`,
`query`, and object `body` fields match declared subsets. Unmatched requests return
`501`, making incomplete doubles visible. `set_service_behavior` accepts only
declared behavior names. Behaviors and captures reset at chain heads.

The app receives service URLs through `{{url}}`, `{{host}}`, and `{{port}}`.
OAuth fixtures also expose `{{issuer}}`, `{{client_id}}`, and `{{client_secret}}`;
S3 fixtures expose `{{access_key}}`, `{{secret_key}}`, `{{region}}`, and `{{bucket}}`.
These credentials are synthetic and scoped to the disposable fixture runtime.

Claimed hosts resolve to the app's fixture listeners on ports 80 and 443. The
runner generates a temporary CA and installs its public certificate before
dropping to the app user. Provision `python3`, `openssl`, `update-ca-certificates`
and `runuser` in the app image. The CA signing key stays on the runner host and
is deleted after certificate creation. Chromium trusts only the run's fixture
certificate through its public-key pin. Unknown app DNS destinations fail closed
and appear as `blocked_egress` events with the requested hostname.

Mail capture supports SMTP and decodes multipart text/HTML, base64 and
quoted-printable messages. Persona readers use the declared username credential
to select their messages. The harness receives usable verification links only
for allowed application origins; declared credentials and other message content
remain sanitized. Stored capture evidence and navigation transcripts redact
verification tokens. SMS and webhook capture use HTTP POST endpoints.

Generated file kinds are `image` (PNG), `pdf`, `csv`, `json`, `text`, and `binary`.
Use `width`/`height` for images, `rows` for CSV/JSON, and `size` for a minimum byte
size. Generation is streamed and bounded by the seed quota. Generated files are
captured in a `files` archive and restored on later chains and runs. Committed
files must be under `.rio/qa/fixtures/files/` and at most 1 MiB; named file access
rejects traversal and links outside the application tree.


## Hosted QA verification

Voters independently inspect the captured screenshots, DOM, console/network excerpts,
journey, immutable scoped owner guidance and criterion definitions before seeing the
candidate. The disclosed turn adds structured expected/observed behavior, attributed
base/head source and recorded tool calls. Harness narrative is excluded. Screenshot
content is sent through the configured model provider's image interface, with the
same shared review ledger and per-voter allowance as verification text.
The built-in `rio/qa` profile allows 500,000 review tokens and 60,000 tokens per
verifier voter in fast mode, or 1,000,000 and 120,000 in deep mode. A voter's blind
and disclosed turns share that allowance. These are spending ceilings; all calls
still reserve from the shared review ledger, and profile overrides remain available.

A reproduced finding needs matching original trace, step screenshot and DOM evidence.
Static proof requires a valid head graph citation or a trusted matching probe result.
Original same-trigger evidence can refute an observation. Missing, expired or
cross-run artifacts cannot establish proof. The report keeps unresolved observations
separate and labels incomplete verification; valid QA findings retain their own cap
and failure policy. Informational findings remain suppressible and cannot fail the
review, even through an explicit rule match.

Recommendations use their own support/reject/inconclusive quorum. Support establishes
observed friction and proposal relevance; the expected benefit remains untested.
Recommendation votes and decisions are retained in `qa/recommendations.json` and
`qa/recommendation-votes/`. Finding votes and decisions are in `qa/votes/` and
`qa/verification.json`. These records are independent of presentation caps.

Recommendation continuity is retained in `qa/recommendation-history.json`, including
the complete pool before presentation caps and prior recommendations that were not
assessed this round. Non-observation never implies improvement. A support quorum can
link advice to a verified finding about the same friction; linked advice remains in
the audit and is excluded from recommendation counts.

Owners can dismiss advice with `POST /v1/qa/recommendations/{id}/feedback`, using the
configured endpoint token and a JSON body containing `repository`, `reason`
(`wrong`, `intentional`, `irrelevant` or `style`), and an optional `note`.
Dismissals are scoped to the tenant and repository, survive wording and viewport
changes, and exclude the advice from later reports while retaining the observation
and owner response in the run record. They do not suppress related defect findings.

Fresh-pod replay restores the retained seed and replays recorded actions without a
model. Non-recurrence and failed prerequisites are inconclusive, never refutation;
see [deterministic replay](#deterministic-replay) for the runtime and evidence contract.

QA reports retain the selection reasons, rule overrides, discarded observation counts, isolation and egress policy, seed fingerprint and duration, evidence quota, and sanitization omissions. The footer shows wall time, measured tokens, and model cost when pricing is available. Subscription tokens are labeled unmetered; missing pricing is labeled unknown.

Local evidence lives within the run cache at `<cache>/<review>/runs/<run>/qa/`, with baseline artifacts under `qa/baseline/`, so normal run pruning removes the evidence too. Hosted review downloads retain the QA plan, outcomes, evidence manifest, recommendation decisions, and criterion assessment in the same run record. Hosted manifests contain object keys and expiry; downloading the audit does not download screenshot or trace bodies.

Judged observations are verified separately against head and base evidence when a baseline is requested. Voters use each snapshot's scoped guidance and graph. New or fixed classifications require a quorum establishing the opposite behavior in the other snapshot; a passing journey, missing evidence, unfinished cell, or split baseline vote cannot establish absence. Both snapshots' verifier turns count against the shared review budget.

For GitHub App reviews, QA uses the existing publication policy and transport. Source-attributed findings appear at the attributed diff line, or the first diff hunk in that file; unchanged-file and journey-attributed findings stay in the summary. The summary includes each journey's cell outcomes, reached step, expiring evidence links, supported UX recommendations, assessment coverage, held-back counts, and stale-journey notes. Later rounds edit the same summary. Screenshots are masked before upload; GitHub's image proxy may retain a copy after the origin expires.

The separate `rio/qa` check is neutral unless the QA fail policy matched a finding. A failed journey or recommendation alone does not change that conclusion. Recommendations have no inline annotations; the general `rio/review` check remains neutral.

`rio qa --publish` retains the report and returns a transport error directing the
user to `rio review --pr URL` with a QA-enabled base profile. Publication uses the
existing GitHub App transport and profile policy; standalone QA has no separate
publisher or token.

A prior QA finding resolves automatically only after a complete later review reaches its step in every affected viewport and color scheme, does not reproduce its identity, and changes the attributed code. For journey attribution, a change to the journey file or covered source can satisfy the code-change condition. Rio compares against the prior observation's snapshot, so an unchanged line left in the accumulated PR diff does not count as a new fix. Cancelled cells, missing steps, held-back findings, and unrelated static checks cannot establish resolution. Owner dismissals and the original posting identity survive later rounds.

## Deterministic replay

The verifier may request one replay per hypothesis, shared across voters, cells
and baseline/head verification. Rio starts a fresh pod, restores the seed,
replays prerequisite journeys, and stops at the cited step. No harness or model
runs inside this replay. It uses `qa.replay_wall` (five minutes in fast mode,
ten minutes in deep mode) and the remaining review deadline. A failed attempt
also consumes the hypothesis's replay allowance.

For a retained local run, the runner exposes the same path:

```sh
rio-runner qa replay \
  --archive /path/to/immutable-snapshot.tar \
  --events /path/to/retained/cell-replay-HASH.jsonl \
  --manifest /path/to/retained/manifest.json \
  --until checkout:4 \
  --cache-dir /path/to/original/private/qa-cache
```

The archive uses `head/` and/or `base/` paths, like runner snapshot archives;
select a base snapshot with `--version base`. Use the original snapshot and
manifest, with the replay log for the original cell. `--wall-seconds` defaults
to 300. `RIO_QA_CREDENTIALS_FILE`, when needed, names the host-owned JSON map of
persona credentials. It is never a model credential file.

Use the original cache containing the retained seed snapshot. Replay refuses to
build or replace a missing seed. Missing, corrupt or changed seed identities
produce an inconclusive prerequisite failure; they cannot establish recurrence.

Replay compares the fresh sanitized DOM, accessibility snapshot and screenshot
against each original boundary. An exact target match yields `recurred`;
a changed target yields `not_recurred`. Missing or changed prerequisites yield
`prerequisites_failed`. Dynamic UI content can prevent an exact match, so both
non-recurring outcomes remain inconclusive. A voter must still assess whether
the recorded behavior demonstrates the hypothesis. Replay cannot refute the
original evidence, and its result cannot establish recurrence in a different
snapshot or cell.

Verification links obtained through `read_mail` or `read_sms` are recorded as
capture references. Replay resolves each reference against its fresh capture,
without persisting or reusing the original token. If the capture is unavailable,
the prerequisite fails. Original and replay evidence retain the same masking,
sanitization, quotas and expiry rules. Hosted replay records are stored with the
hypothesis and included in its verification audit.

Observation identities bind the rule, journey, step and route to the recorded step
requirement and browser-derived target. Different model wording or equivalent CSS
selectors do not split the same issue across viewports; different controls remain
separate. Expected/observed descriptions are retained for verification. Valid
before/after evidence may include the preceding step, but current-step evidence is
required. Invalid candidates are counted in the audit.

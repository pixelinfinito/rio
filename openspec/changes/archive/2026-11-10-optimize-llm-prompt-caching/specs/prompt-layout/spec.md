# Spec Delta

## Purpose

Defines how Rio assembles the model requests it builds (Worker generation, verification, QA verification and council calls, the runner's council model jobs, and the prompt text Rio supplies to QA harnesses) from ordered, deterministic layers, so reusable content forms a stable prefix that providers can cache, without weakening blindness, independence, tenant separation or the separation of repository data from instructions.

## ADDED Requirements

### Requirement: Deterministic request content
For identical inputs (tenant, review prompt configuration, snapshot, graphs, checks, intent, guidance, profile, model, phase and history), every model request Rio builds SHALL have byte-identical content, message order and request fields, also across Workflow replays. Serialization SHALL NOT depend on wall-clock time, random values, non-insertion-ordered map iteration or provider response timing.

#### Scenario: Same review inputs twice
- **WHEN** the agents step builds the generation request for agent `correctness` twice from identical review inputs
- **THEN** the two request bodies sent to the gateway are byte-identical

#### Scenario: Voters of one hypothesis
- **WHEN** three voters start verifying the same hypothesis
- **THEN** their first requests have byte-identical system and message content, and no voter index, actor id or review id appears in that content

#### Scenario: Replayed Workflow step
- **WHEN** a Workflow instance replays after a restart and rebuilds a request whose model step had not completed
- **THEN** the rebuilt request is byte-identical to the one built before the restart

### Requirement: Per-review prompt configuration
At the start of each review Rio SHALL fix the review's prompt configuration in a memoized Workflow step: the normalized `PROMPT_CACHE` and `PROMPT_LAYOUT` settings, after ensuring the tenant's partition secret exists. Every request of the review SHALL be built from that configuration. A review started before this step existed SHALL run it on its next replay; its completed model calls stay as they were.

#### Scenario: Replay after a switch change
- **WHEN** `PROMPT_CACHE` changes while a review is running and the review's Workflow then replays
- **THEN** its rebuilt requests are byte-identical to those built before the change, and the next review uses the new value

#### Scenario: Switch changed mid-review
- **WHEN** `PROMPT_LAYOUT` changes while a review is running
- **THEN** the running review keeps the layout it started with

### Requirement: Ordered prompt layers
With its layout feature enabled (`agent-order` for generation, `verifier-system` for verifiers, `council-order` for council), a request SHALL order content as: system prompt with protocol and result schema; stable instructions; tenant partition; shared review context; assignment; append-only conversation. With the feature off, its requests SHALL keep their pre-change order and system prompt plus the partition.

#### Scenario: Layer order of a generation request
- **WHEN** a generation request is built for any agent with `agent-order` enabled
- **THEN** the system prompt holds only the protocol and the hypothesis item schema, the first user message holds the shared instructions, then the tenant partition, then the review context, then the agent's assignment, and tool exchanges follow as later messages

#### Scenario: Assignment change affects only the suffix
- **WHEN** two generation requests in one review differ only in the agent (same model, same scope) and `agent-order` is enabled
- **THEN** their system text and message text are identical up to the start of the assignment layer and differ only from there on

#### Scenario: Feature off keeps the old order
- **WHEN** a generation request is built with `PROMPT_LAYOUT` empty
- **THEN** its text equals the pre-change text for the same inputs except for the inserted tenant partition line

#### Scenario: Council and verifier with features off
- **WHEN** `PROMPT_LAYOUT` is empty
- **THEN** council content starts with the partition followed by the pre-change round header and rendering, and the blind and disclosed verifier turns keep their different pre-change system prompts

#### Scenario: Specialist material is not merged
- **WHEN** the security agent's request is built
- **THEN** it contains the security catalog and taint map in its assignment layer, and no other agent's request contains them

### Requirement: Tenant partition before private content
Every request SHALL carry a tenant partition element after the shared layers and before repository-derived content. Its value SHALL be an HMAC of the provider identity keyed by a random per-tenant secret stored in D1, created once at the tenant's first review and never updated: stable per tenant and provider, distinct otherwise, with no readable identifier or instruction. The secret SHALL NOT be sent, logged, reported or kept in step state. Earlier layers SHALL stay identical across tenants.

#### Scenario: Two tenants review identical content
- **WHEN** two tenants of one deployment review byte-identical changes with the same profile and model
- **THEN** their requests are identical through the stable instructions and differ from the tenant partition on

#### Scenario: One tenant, many calls
- **WHEN** one tenant's review runs generation, blind verification and council calls on one provider, and a council member on another
- **THEN** the calls on the first provider carry the same partition value, the other provider's call carries a different one, and neither contains the tenant id

#### Scenario: Concurrent first reviews
- **WHEN** two reviews of a tenant without a partition secret start at the same time
- **THEN** one secret is created and both reviews' requests to one provider carry the same partition value

#### Scenario: Secret stays inside Rio
- **WHEN** a review's requests, model-call records, usage rows, report, logs and Workflow step outputs are inspected
- **THEN** none contains the tenant's partition secret

#### Scenario: Result cache independent of the partition
- **WHEN** a tenant's partition secret is deleted and its next review runs with an unchanged layout
- **THEN** its requests carry new partition values, and its agent result-cache entries are still replayed

### Requirement: Partition value kept out of persisted output
Before model reply text is persisted as a hypothesis, vote rationale, council assessment, report or check-run text, every occurrence of the review's partition values SHALL be replaced with `[partition]`. The value SHALL be treated as a per-provider pseudonym: it SHALL NOT be logged with the tenant id.

#### Scenario: Model echoes the partition
- **WHEN** a generation reply's hypothesis rationale contains the request's partition value
- **THEN** the stored hypothesis and the report show `[partition]` in its place

### Requirement: Shared review context across agents
Generation requests of one review SHALL render the review context identically for every agent whose scope is the same. Review context means the lineage round context, intent, graph excerpt, deterministic checks, changed-code excerpts and owner guidance scoped to that scope. An agent whose scope was narrowed by result-cache hits SHALL render its own narrowed review context. This requirement is about the request text; whether a provider reuses the shared context depends on the route's capability.

#### Scenario: Two agents on the same model
- **WHEN** `correctness` and `tests` run in one review with the same model, no result-cache hits and `agent-order` enabled
- **THEN** both first requests share the system prompt, the shared instructions, the tenant partition and the whole review context as a common text prefix

#### Scenario: Narrowed scope
- **WHEN** `correctness` has result-cache hits for two of five hunks and `tests` has none
- **THEN** `correctness`'s review context covers only the files of its missed hunks, and the prefixes diverge from the first differing review-context block

### Requirement: Untrusted data placement is unchanged
Repository-derived content SHALL stay in user messages and SHALL NOT be placed in the system prompt or in instruction layers, whatever the layer order. Code, intent, owner guidance, checks, graph data and lineage findings SHALL remain inside `repository_data` blocks. Tool results SHALL remain scrubbed `{"tool_results": …}` JSON user messages as today, the envelope that elision relies on. Owner guidance SHALL keep its scoping to the reviewed paths and its injection-line filtering.

#### Scenario: Guidance in the review context
- **WHEN** a repository has `AGENTS.md` guidance applicable to the changed paths
- **THEN** the guidance appears only inside a `repository_data` block labelled as data, never in the system prompt, and injection-pattern lines are removed as before

#### Scenario: Tool results keep their envelope
- **WHEN** a model turn's tool calls return file contents
- **THEN** the next request appends one user message whose text is the scrubbed `{"tool_results": …}` JSON, exactly as before this change

### Requirement: Append-only conversations
Each follow-up request in a conversation (tool results, repairs, and with `verifier-system` the disclosed turn) SHALL begin with the previous request's logical content: system text and the ordered role and text of messages, excluding cache markers, part splitting and `max_tokens`. Without `verifier-system` the disclosed turn SHALL keep every message and may change only the system text. A retry SHALL resend the identical body. Only elision MAY rewrite earlier messages.

#### Scenario: Tool follow-up
- **WHEN** a model turn requests `read_file` and the host appends the accepted reply and the tool results
- **THEN** the next request's logical content begins with exactly the previous request's logical content, even though its tail cache marker and `max_tokens` may differ

#### Scenario: Repair follow-up
- **WHEN** a reply is malformed and the host appends the discarded reply excerpt and the repair instruction
- **THEN** the next request extends the previous one's logical content without changing any earlier message text

#### Scenario: Disclosed turn without verifier-system
- **WHEN** `verifier-system` is off and a voter's disclosed request is built
- **THEN** its messages begin with every blind message unchanged, and only its system text differs from the blind requests

#### Scenario: Transient retry
- **WHEN** the provider answers 429 and the gateway retries once
- **THEN** the retried request body is byte-identical to the first attempt

### Requirement: Compaction checkpoint
With `compaction` enabled, elision SHALL run only above 160 KB, then elide the oldest tool results down to 96 KB or until only the two most recent remain. The first message and the model's replies SHALL never change. Each checkpoint SHALL be recorded in the call audit with its turn and elided count. With the feature off, elision SHALL behave as before this change.

#### Scenario: Below the high-water mark
- **WHEN** a conversation is at 150 KB after a tool turn
- **THEN** no message is rewritten and the next request extends the previous one

#### Scenario: Crossing the high-water mark
- **WHEN** a tool turn brings a conversation with five 40 KB tool results to 205 KB
- **THEN** the three oldest results are replaced by the elision note (bringing it under 96 KB), the two most recent stay whole, the next request's logical content is identical to the previous one up to the first elided message, and the audit records one checkpoint with three elisions

#### Scenario: No churn after a checkpoint
- **WHEN** the turn after a checkpoint adds a 20 KB tool result and the conversation stays under 160 KB
- **THEN** no earlier message is rewritten on that turn

#### Scenario: Feature off
- **WHEN** `compaction` is not enabled and a conversation passes 160 KB
- **THEN** elision removes just enough of the oldest results to get back under 160 KB, as before this change

### Requirement: Council request layout
While the `council-order` layout feature is enabled, a council member's request SHALL contain its system prompt (council protocol and role prompt), then the tenant partition, then the member's rendering of the evidence pack, then the round-specific content: the round header and, in round 2, the member's own round-1 assessment, the other assessments and the experiment results.

#### Scenario: Round 2 extends round 1's prefix
- **WHEN** the skeptic member is asked for round 2 of a finding with `council-order` enabled
- **THEN** its round-2 request text is identical to its round-1 request text up to the end of the rendering

#### Scenario: Audit hash follows the sent content
- **WHEN** a council call is recorded
- **THEN** its `rendering_hash` and `rendering_bytes` are computed over exactly the system and content that were sent, in whichever order the switch selected

### Requirement: Layout switches
The `PROMPT_LAYOUT` Worker variable SHALL list the enabled layout features from `agent-order`, `verifier-system`, `compaction`, `council-order` and `qa-order`. Unset or empty SHALL mean none. An unknown value SHALL be rejected naming it by `rio deploy` before any account access, at review submission, and by the configuration step before any reservation. The enabled feature set SHALL be part of the agent result cache's prompt hash and the report's audit.

#### Scenario: Default layout
- **WHEN** `PROMPT_LAYOUT` is unset
- **THEN** no layout feature is enabled and the request text differs from the pre-change text only by the tenant partition

#### Scenario: One feature enabled
- **WHEN** `PROMPT_LAYOUT` is `verifier-system`
- **THEN** verifier requests use the single system prompt, and generation, compaction and council requests are as with an empty value

#### Scenario: Unknown feature at submission
- **WHEN** the Worker's `PROMPT_LAYOUT` is `agent-order,fast` and a review is submitted
- **THEN** the submission is rejected with a configuration error naming `fast`, and no review starts

#### Scenario: Unknown feature at deploy
- **WHEN** `config.toml` sets the layout to `agent-order,fast` and `rio deploy` runs
- **THEN** the command fails naming `fast` and makes no Cloudflare request

#### Scenario: Variable changed after submission
- **WHEN** `PROMPT_LAYOUT` becomes `fast` after a review was accepted and before its configuration step runs
- **THEN** the review fails in that step with a configuration error, and no reservation or provider request is made

#### Scenario: Result cache follows the layout
- **WHEN** a review runs with `agent-order` after reviews ran without it
- **THEN** result-cache entries recorded without it are not replayed

### Requirement: QA harness prompt layout
With `qa-order` enabled, the prompt Rio supplies to a QA journey harness SHALL be: fixed instructions; the tenant partition on hosted runs; data identical for every journey of the run; the line `Journey task (changes per journey):`; then the journey, its cell and any journey-scoped data. Data that differs between journeys SHALL NOT appear before that line. With `qa-order` off, the prompt SHALL keep its pre-change text plus the partition on hosted runs.

#### Scenario: Journeys of one run share the stable part
- **WHEN** two journeys of one hosted run are executed in the same cell with `qa-order` enabled
- **THEN** their prompts are identical through the boundary line and differ only after it

#### Scenario: One journey in two cells
- **WHEN** the same journey runs in a desktop light cell and a mobile dark cell
- **THEN** the two prompts differ only after the boundary line

#### Scenario: Local run
- **WHEN** a QA run uses the developer's own provider key
- **THEN** the prompt carries no partition element

### Requirement: QA verification prompt layout
QA hypothesis and recommendation voters SHALL keep one system prompt for both turns and their pre-change message order. The blind message SHALL carry the tenant partition after its instructions and before its first data block, followed by the screenshots. The disclosed turn SHALL be appended after the voter's blind conversation without altering it. No layout feature changes QA voter requests.

#### Scenario: Partition before pack data
- **WHEN** a QA voter's blind message is built with any `PROMPT_LAYOUT` value
- **THEN** its text is the pre-change text with the partition element inserted immediately before the first data block

#### Scenario: Screenshots inside the reused prefix
- **WHEN** a QA voter's second request is sent on an Anthropic route with hints enabled
- **THEN** the blind message's screenshots precede the blind-context cache marker, and the request's logical content begins with the first request's

### Requirement: Independent generations despite shared prefixes
Each verifier voter and council member SHALL obtain its answer from its own provider generation, even when its request is byte-identical to another's. Rio SHALL NOT reuse, deduplicate or replay one call's response for another call. Voters and members SHALL keep separate conversations and SHALL NOT be serialized, delayed or pre-warmed to obtain cache hits.

#### Scenario: Identical first requests
- **WHEN** three voters send byte-identical first requests at the same time
- **THEN** the gateway sends three provider requests, each with the response-cache bypass, and each voter's conversation continues only from its own reply

#### Scenario: Default fan-out timing
- **WHEN** a hypothesis is verified with default settings
- **THEN** all voters of the first batch start without waiting for another voter's response

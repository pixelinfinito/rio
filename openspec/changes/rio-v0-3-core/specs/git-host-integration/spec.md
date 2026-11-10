# Spec Delta

## Purpose

Connect a Rio endpoint to a git host so pull requests are reviewed without a developer running a command: app registration with minimal permissions, verified webhooks, short-lived access tokens, and hosted preparation of the pull request's code into the submission the endpoint already accepts.

## ADDED Requirements

### Requirement: GitHub App registration with minimal permissions
`rio init` SHALL offer an optional step that registers a GitHub App from a manifest declaring only `contents: write`, `pull_requests: write`, `checks: write`, `metadata: read`, `members: read` and `issues: read` (GitHub requires the last for `issue_comment`), with the endpoint's webhook URL. The step SHALL store the app id, private key and webhook secret as endpoint secrets and SHALL NOT write them to disk unencrypted. Declining the step SHALL leave the endpoint fully usable from the CLI.

#### Scenario: App registered
- **WHEN** the user accepts the GitHub App step during `rio init`
- **THEN** a GitHub App exists with exactly the five declared permissions, the endpoint holds the app id, private key and webhook secret, and the local configuration records only the app id and installation hints

#### Scenario: Step declined
- **WHEN** the user declines the GitHub App step
- **THEN** `rio init` completes, `rio review` works against the endpoint, and the webhook route reports that no app is configured

#### Scenario: Secrets never on disk
- **WHEN** registration completes
- **THEN** no file under the user's home or the repository contains the private key or webhook secret

### Requirement: Installation registry
The endpoint SHALL record each installation of the app with its account and the repositories it covers, updating the record on `installation` and `installation_repositories` events, and SHALL treat a repository as connected only while an installation covers it. Removing the installation SHALL stop reviews and publication for its repositories.

#### Scenario: Repository added to installation
- **WHEN** an `installation_repositories` event adds `acme/api` to an existing installation
- **THEN** a later pull request event for `acme/api` is accepted and reviewed

#### Scenario: Installation deleted
- **WHEN** an `installation` event with action `deleted` arrives for an installation
- **THEN** its repositories are no longer connected, later pull request events for them are ignored, and no publication is attempted

### Requirement: Installation tokens per job
Every call to the git host and every hosted preparation SHALL use an installation token minted for that job, scoped to one repository and to the permissions that job needs (`contents: read` for preparation; `pull_requests: write` and `checks: write` for publication; `contents: write` only to resolve a thread), valid for at most ten minutes. Tokens SHALL be passed only inside the job payload and SHALL NOT be persisted, logged or included in reports.

#### Scenario: Preparation token scope
- **WHEN** a prepare job is created for a pull request in `acme/api`
- **THEN** its token grants read access to `acme/api` contents only, cannot post comments, and expires within ten minutes

#### Scenario: Token absent from storage
- **WHEN** a review completes
- **THEN** no stored artifact, log line or report field contains the installation token

### Requirement: Webhook verification
`POST /v1/hooks/github` SHALL accept a delivery only when its signature over the raw body verifies against the webhook secret, its delivery id has not been seen in the previous 24 hours, and its installation is registered. A failing signature or an unknown installation SHALL be rejected with an error status; a repeated delivery id SHALL be acknowledged without any effect. When no app secrets are configured the route SHALL return 404.

#### Scenario: Forged signature
- **WHEN** a request arrives with a body whose signature does not match the webhook secret
- **THEN** the endpoint rejects it with 401 and performs no work

#### Scenario: Replayed delivery
- **WHEN** a valid delivery is sent a second time with the same delivery id within 24 hours
- **THEN** the endpoint responds 202 and creates no second review

#### Scenario: Unknown installation
- **WHEN** a correctly signed delivery names an installation the endpoint has not recorded
- **THEN** the endpoint rejects it with 403

### Requirement: Accepted and ignored events
The endpoint SHALL act on `pull_request` events with actions `opened`, `synchronize`, `reopened` and `ready_for_review` on non-draft pull requests, on `issue_comment` `created` events whose body starts with `/rio` on a pull request, and on installation events. Every other event or action SHALL be acknowledged with 204 and produce no review, comment or job.

#### Scenario: Draft pull request opened
- **WHEN** a `pull_request` event with action `opened` arrives for a draft pull request
- **THEN** the endpoint returns 204 and no review is created until a `ready_for_review` event arrives

#### Scenario: Unrelated event
- **WHEN** a `push` event or a `pull_request` event with action `labeled` arrives
- **THEN** the endpoint returns 204 and nothing is scheduled

#### Scenario: Plain comment
- **WHEN** an `issue_comment` event arrives whose body does not start with `/rio`
- **THEN** the endpoint returns 204 and no command is executed

### Requirement: Asynchronous handling
The webhook handler SHALL only verify, record and enqueue the event; it SHALL NOT call the git host, the model gateway or a runner before responding. Review creation, preparation and command execution SHALL happen from the queue, and a failure there SHALL NOT cause the delivery to be retried by the host.

#### Scenario: Slow downstream
- **WHEN** a pull request event arrives while the model gateway is unreachable
- **THEN** the webhook responds within the host's delivery timeout and the queued review later records the gateway failure

### Requirement: Fork detection
A pull request whose head repository differs from the base repository SHALL be submitted with `fork: true`, so the existing fork restrictions apply (static-only agents and voters, no publication until a maintainer escalates). The fork flag SHALL be derived from the host's pull request metadata, never from the payload's free text.

#### Scenario: Fork pull request
- **WHEN** a pull request from `contributor/api` targets `acme/api`
- **THEN** the review is submitted with `fork: true` and the report states that the review is static-only

#### Scenario: Same-repository branch
- **WHEN** a pull request's head and base live in `acme/api`
- **THEN** the review is submitted with `fork: false`

### Requirement: Pull request metadata
Each pull request review SHALL record the pull request number, base and head commit SHAs, the author login and whether the author is a user or a bot, the fork flag, and any agent attribution the host exposes (bot author or recognized agent trailer) for use by later steps. Metadata SHALL be stored with the review and shown in the report header.

#### Scenario: Bot author recorded
- **WHEN** a pull request authored by a bot account is reviewed
- **THEN** the review records the author as a bot with its login, and the report header shows the pull request number and head SHA

### Requirement: Hosted preparation job
A pull request review SHALL be prepared by a `prepare` runner job that clones base and head with the job's installation token, then builds the snapshot, deterministic results, graphs, owner guidance and intent input with the same paired `rio` binary the CLI uses, uploads the snapshot through the existing content-addressed protocol and submits the review with the job's capability token. The clone SHALL be the only phase with network access.

#### Scenario: Preparation without network after clone
- **WHEN** a prepare job has finished cloning
- **THEN** deterministic checks and the graph run with no network route, and an attempt to reach the network from a project tool fails

#### Scenario: Same submission shape
- **WHEN** the same commit is prepared by a hosted job and by the CLI
- **THEN** both submissions contain the same changed files, snapshot id and graph node set

### Requirement: Hosted check availability
Deterministic checks in a hosted preparation SHALL follow the skip rules of local reviews. A check whose project dependencies are not installed in the prepared clone, or cannot be verified against its lockfile, SHALL end `skipped` with reason `dependency_mismatch` and a hint naming the cause; a check whose tool is not available SHALL end `skipped` with reason `tool_missing` and a hint. Secrets and the graph SHALL still run, and the footer SHALL report every skipped check.

#### Scenario: Dependencies not vendored
- **WHEN** a TypeScript pull request's `node_modules` are not present in the prepared clone
- **THEN** `typecheck` and `lint` are `skipped` with reason `dependency_mismatch` and a hint naming the missing installation metadata, `coverage` is `skipped` with reason `tool_missing` because the project's test runner is not installed, and secrets and the graph still complete

### Requirement: Hosted dependency audit
The dependency audit needs its advisory service, which the network-less analysis of a hosted preparation cannot reach. It SHALL end `skipped` with reason `offline` and a hint naming the service, and the footer SHALL report it.

#### Scenario: Audit without network
- **WHEN** a pull request that changes a lockfile is prepared on a runner
- **THEN** the dependency audit is `skipped` with reason `offline` and the review still completes

### Requirement: Preparation backend eligibility
The self-hosted runner SHALL prepare any pull request. The Cloudflare Sandbox backend SHALL prepare non-fork pull requests only; a fork pull request on an endpoint with only the Sandbox backend SHALL be recorded as not prepared with reason `fork_requires_self_hosted_runner` and SHALL post nothing.

#### Scenario: Fork on Sandbox-only endpoint
- **WHEN** a fork pull request event arrives and the endpoint has no self-hosted runner
- **THEN** no review runs and the review record states `fork_requires_self_hosted_runner`

#### Scenario: Non-fork on Sandbox
- **WHEN** a same-repository pull request event arrives on a Sandbox-only endpoint
- **THEN** the Sandbox backend prepares and the review proceeds

### Requirement: Pull request lineage attachment
Every pull request review SHALL be attached to the lineage of kind `pr` whose reference is the pull request number, so the review-convergence capability's rounds, hold-back and reset rules apply. A `synchronize` event SHALL produce the next review in the same lineage.

#### Scenario: New commits pushed
- **WHEN** a pull request already reviewed once receives a `synchronize` event
- **THEN** the new review belongs to the same `pr` lineage and its round is computed from the earlier review

### Requirement: GitLab route reserved
`POST /v1/hooks/gitlab` SHALL exist and SHALL respond 501 with a message stating that GitLab integration is not available in this version. No GitLab event SHALL create a review.

#### Scenario: GitLab webhook
- **WHEN** any request reaches `/v1/hooks/gitlab`
- **THEN** the response is 501 with the unavailable message and nothing is scheduled

### Requirement: Payload text cannot change policy
Pull request titles, descriptions, commit messages and comment bodies SHALL be treated as data. They SHALL NOT change posture, budgets, rules, suppressions, publish policy or tool permissions; only the resolved profile sets policy, and only the recognized `/rio` commands have effects.

#### Scenario: Instruction in a PR description
- **WHEN** a pull request description contains text asking Rio to disable the verifier or publish all findings
- **THEN** the review runs with the resolved profile unchanged and the text has no effect

# Spec Delta

## Purpose

Deliver a review to the pull request it concerns: inline comments where the host can anchor them, one summary per lineage, a neutral check run, and `/rio` commands, all idempotent so repeated rounds edit rather than duplicate.

## ADDED Requirements

### Requirement: Publish policy
The resolved profile's `publish` key SHALL govern publication: `never` SHALL post nothing, not even a check run; `auto` SHALL publish every webhook-triggered and CLI review; `ask` SHALL publish a CLI review only with the user's confirmation or `--publish`, and SHALL post only the check run for a webhook-triggered review, whose summary states that comments require `publish: auto` or `rio review --pr <n> --publish`.

#### Scenario: Never
- **WHEN** a pull request is reviewed under `publish: never`
- **THEN** no comment, review thread or check run is created

#### Scenario: Webhook under ask
- **WHEN** a webhook-triggered review completes under `publish: ask`
- **THEN** a `rio/review` check run is created, no comment is posted, and the check summary names `publish: auto` and `rio review --pr <n> --publish` as the ways to publish

#### Scenario: Auto
- **WHEN** a webhook-triggered review completes under `publish: auto`
- **THEN** inline comments, the summary comment and the check run are posted without any user action

### Requirement: Inline comments anchored to the diff
Each publishable finding whose primary location is on a line present in the pull request diff SHALL be posted as a review comment on that line of the head commit, with the finding's message, trigger, evidence level and suggested fix, ending with a hidden marker carrying the finding identity. Findings whose primary location is not in the diff SHALL NOT be posted inline and SHALL appear in the summary instead. Findings held back by the review-convergence capability SHALL NOT be posted.

#### Scenario: Anchorable finding
- **WHEN** a new finding's primary location is a line added by the pull request
- **THEN** a review comment appears on that line of the head commit and its body ends with the hidden identity marker

#### Scenario: Pre-existing line
- **WHEN** a finding's primary location is a line the pull request did not touch
- **THEN** no inline comment is created and the finding is listed in the summary comment

### Requirement: One summary comment per lineage
Each pull request lineage SHALL have exactly one summary comment, identified by a hidden lineage marker, carrying the review status, risk tier with reasons, counts of findings and risks, unanchored findings, held-back and remembered counts, the reconsider message when the review-convergence capability requires it, and a link to the full report. Later rounds SHALL edit this comment in place.

#### Scenario: Second round edits the summary
- **WHEN** a lineage's second review completes
- **THEN** the pull request still has one Rio summary comment and its body reflects the second review

#### Scenario: Summary contents
- **WHEN** a review with risk tier `high`, two findings and one risk completes with one finding unanchorable
- **THEN** the summary shows the tier and its reasons, the counts, the unanchored finding with its location, and the report link

### Requirement: Edit, never duplicate
Before posting, the publisher SHALL reconcile its record of posted comments against the pull request by searching for its hidden markers, and SHALL edit an existing comment whose marker matches instead of posting a new one. A lost publication record SHALL NOT cause a duplicate.

#### Scenario: Record lost
- **WHEN** the publisher's stored comment ids for a lineage are missing but the comments exist on the pull request
- **THEN** the next round edits those comments and posts no duplicate

#### Scenario: State change edits the comment
- **WHEN** a posted finding becomes `dismissed: intentional`
- **THEN** its inline comment is edited to show that state and no new comment is posted

### Requirement: Neutral check run
Publication SHALL create or update a check run named `rio/review` on the head commit with conclusion `neutral`, a title giving the status and risk tier, and a summary of counts with the report link. The check run SHALL NOT use `success` or `failure`, SHALL NOT request changes or approve, and SHALL be updated rather than recreated for the same head.

#### Scenario: Findings present
- **WHEN** a review with failing-policy findings completes under `publish: auto`
- **THEN** the check run's conclusion is `neutral` and its title states the review failed its policy with the counts

#### Scenario: Clean review
- **WHEN** a review with no findings completes
- **THEN** the check run's conclusion is `neutral` and its title states no findings were produced

### Requirement: Thread resolution
When a posted finding's lifecycle status becomes `fixed` or `dismissed` per the finding-feedback capability, the publisher SHALL edit its comment with the status and reason text and SHALL resolve its review thread. A finding that is reopened SHALL have its thread unresolved.

#### Scenario: Auto-resolved finding
- **WHEN** a later round marks a posted finding `fixed` citing the fixing head
- **THEN** the comment shows "fixed in <sha>" and its thread is resolved

#### Scenario: Dismissed finding
- **WHEN** a collaborator dismisses a posted finding with reason `irrelevant`
- **THEN** the comment shows `dismissed: irrelevant` and its thread is resolved

### Requirement: Actor classification
The actor of a `/rio` command SHALL be classified from the host's collaborator permission API through the installation token: `admin` and `maintain` are maintainers, `write` and `triage` are collaborators, anything else is other. Classification SHALL NOT use the comment payload's author association text. Comments by the app itself or by bot accounts SHALL be ignored.

#### Scenario: Permission from the API
- **WHEN** a comment payload claims the author is an owner but the permission API returns `read`
- **THEN** the actor is classified as other

#### Scenario: Bot comment ignored
- **WHEN** a bot account comments `/rio review`
- **THEN** no command runs and no reaction is added

### Requirement: Review command
`/rio review` from a maintainer SHALL request a new review of the pull request head and apply the review-convergence capability's reset, and on a fork pull request SHALL also escalate it for publication. From a collaborator or other actor the command SHALL be acknowledged with a reaction and ignored. Results SHALL be delivered as reactions and comment edits, never as new comments.

#### Scenario: Maintainer requests review
- **WHEN** a maintainer comments `/rio review` on a capped lineage
- **THEN** the comment receives an acknowledging reaction, a new review runs, and the review-convergence capability's reset applies

#### Scenario: Non-maintainer request
- **WHEN** a contributor without write access comments `/rio review`
- **THEN** the comment receives a reaction indicating it was not applied and no review runs

### Requirement: Dismiss command
`/rio dismiss <id> <reason>` from a collaborator or maintainer SHALL write the author response through the finding-feedback capability with the actor's login. `<id>` SHALL be the full identity or a prefix of at least eight characters matching exactly one posted finding in the lineage; `<reason>` SHALL be a standardized reason. Invalid commands SHALL be acknowledged with a reaction and ignored; valid ones SHALL edit the finding's comment.

#### Scenario: Prefix dismissal
- **WHEN** a collaborator comments `/rio dismiss 8c1e2f4a style`
- **THEN** the single matching finding records `author_response.reason: style` with the commenter's login and its comment shows `dismissed: style`

#### Scenario: Ambiguous prefix
- **WHEN** `/rio dismiss 8c1e style` matches two findings or is shorter than eight characters
- **THEN** no finding changes and the comment receives a reaction indicating it was not applied

#### Scenario: Unknown reason
- **WHEN** a collaborator comments `/rio dismiss 8c1e2f4a bogus`
- **THEN** no finding changes and the comment receives a reaction indicating it was not applied

### Requirement: Fork publication
A fork pull request SHALL have nothing published until a maintainer comments `/rio review`; after escalation the profile's publish policy applies, and agents and voters SHALL still run without execution tools.

#### Scenario: Fork before escalation
- **WHEN** a fork pull request is reviewed under `publish: auto`
- **THEN** no comment or check run is posted and the review record states that a maintainer `/rio review` is required

#### Scenario: Fork after escalation
- **WHEN** a maintainer comments `/rio review` on a fork pull request under `publish: auto`
- **THEN** the new review is published, and the report states execution tools stayed disabled

### Requirement: Partial failure recording
Each attempted comment, edit, resolution and check run SHALL be recorded per finding as `posted`, `edited`, `resolved` or `failed` with the host's error. A failure on one finding SHALL NOT abort publication of the others, and failed items SHALL be retried on the next round of the lineage.

#### Scenario: Anchor rejected
- **WHEN** the host rejects one inline comment's anchor while others succeed
- **THEN** that finding is recorded `failed` with the error, is listed in the summary, the other comments are posted, and the next round retries it

### Requirement: Publication record in the report
A published review's report SHALL carry a `publication` object with the policy applied, counts of findings posted, edited, resolved, failed and unanchored, the summary comment URL and the check run URL. When nothing was published the object SHALL state the reason (`policy_never`, `ask_without_consent`, `fork_not_escalated`, `no_installation`).

#### Scenario: Published counts
- **WHEN** a round posts three comments, edits two and fails one
- **THEN** `publication` reports posted 3, edited 2, failed 1 and both URLs

#### Scenario: Not published
- **WHEN** a webhook review runs under `publish: never`
- **THEN** `publication.reason` is `policy_never` and every count is zero

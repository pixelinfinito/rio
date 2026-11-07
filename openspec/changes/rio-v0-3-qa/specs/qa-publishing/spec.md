# Spec Delta

## Purpose

QA publishing defines how journey outcomes and QA findings appear on a pull request through the GitHub App: where each comment anchors, how evidence is shown without exposing private artifacts, and how the convergence rules apply to findings observed in a browser.

## ADDED Requirements

### Requirement: Publishing follows the profile and the host change
QA results SHALL be published only when the profile's `publish` is `auto`, or `ask` and the user confirms, and only through the transport the GitHub App change provides. Without that transport, `rio qa --publish` SHALL return the same explicit error as `rio review --publish`. QA SHALL NOT add its own publishing path or token.

#### Scenario: No PR transport
- **WHEN** `rio qa --publish` runs before the GitHub App change is available
- **THEN** the command reports that publication is outside the implemented transport and the local report is still written

### Requirement: Inline comments anchor on attributed lines
A QA finding whose `qa.attribution` is `source` SHALL be published as an inline review comment on the attributed file and line when that line is within the PR diff, as a comment on the file's first diff hunk when the file has one, and in the summary comment when the file is not in the diff at all. A finding whose attribution is `journey` SHALL be published in the summary comment, never inline. Probe findings sharing a rule and route SHALL be one comment listing viewports.

#### Scenario: Attributed to a changed line
- **WHEN** a `ui/raw-primitive` finding is attributed to `src/components/Form.tsx:48` and that line is in the diff
- **THEN** one inline comment is posted at that line

#### Scenario: Attributed outside the diff
- **WHEN** a finding is attributed to `src/components/Card.tsx:12` and the PR changes only line 80 of that file
- **THEN** the comment is posted on the file's first changed hunk with a note naming line 12

#### Scenario: Journey-only attribution
- **WHEN** a finding is located at `.rio/qa/journeys/checkout.yaml` because attribution failed
- **THEN** it appears in the summary comment with its evidence and no inline comment is posted

### Requirement: One summary comment per review
Each published QA run SHALL post or edit one summary comment listing every selected journey with its outcome, viewports, step reached and evidence links, the journey-attributed findings, held-back and skipped journeys with reasons, and the evidence expiry. Later rounds in the same lineage SHALL edit that comment, never post a second.

#### Scenario: Second round edits the summary
- **WHEN** a new head is pushed and QA runs again on the same PR
- **THEN** the existing summary comment is edited with the new outcomes and no new summary comment appears

### Requirement: Evidence in comments
Comments SHALL embed the failing step's screenshot as an image served by a signed URL with the report's expiry, and SHALL link the trace and DOM snapshot. Comments SHALL state the expiry date. Screenshots SHALL be the redacted and masked artifacts; no transcript text SHALL be published.

#### Scenario: Screenshot embedded
- **WHEN** a failed-journey finding is published
- **THEN** the comment contains the step-4 screenshot as an image, links to the trace, and a line stating when the evidence expires

#### Scenario: Expired evidence on an old comment
- **WHEN** a reader opens the comment after the expiry
- **THEN** the origin no longer serves the image, a copy GitHub's image proxy already cached may remain visible, the expiry line explains this, and Rio does not re-sign on read

### Requirement: Check run per QA step
Publication SHALL create or update one check run named `rio/qa` with a neutral conclusion, a summary of journeys passed, failed, skipped and not run, and annotations for inline-anchored findings. A failed QA fail policy SHALL be reported as `failure` only when the profile's fail policy applies to publication; the QA risk tier SHALL never be an approval.

#### Scenario: Journeys failed, policy not matched
- **WHEN** one journey failed with an `unclassified` finding and the QA fail policy does not match
- **THEN** the check run concludes `neutral` and its summary names the failed journey

#### Scenario: Policy matched
- **WHEN** a `new` QA finding matches the QA fail policy
- **THEN** the check run concludes `failure` and the annotation names the finding

### Requirement: Convergence applies to QA findings
QA findings SHALL use the same lineage, round, never-re-post and author-response rules as other findings, keyed by the QA finding identity (journey, step, rule, route). A journey that passes on a later head SHALL auto-resolve the findings its failure produced as `fixed`. `/rio dismiss <id> <reason>` SHALL apply to QA findings with the same reason set.

#### Scenario: Journey fixed on the next round
- **WHEN** `checkout` failed at step 4 in round 1 and passes in round 2
- **THEN** the round 1 finding's comment is edited to `fixed` and nothing new is posted for it

#### Scenario: Dismissed as intentional
- **WHEN** a collaborator comments `/rio dismiss 8c1e intentional` on a `ui/gradient-background` finding
- **THEN** the finding records `author_response.reason: intentional` and later rounds do not re-post it

### Requirement: Journey drift reported on the PR
When `rio qa sync --check` finds journeys whose covered paths changed and whose file did not, publication SHALL add a `journeys possibly stale` line to the summary comment naming them, and SHALL NOT fail the check run for that reason alone.

#### Scenario: Stale journey noted
- **WHEN** a PR edits `src/pages/checkout/**` and `checkout.yaml` is unchanged
- **THEN** the summary comment lists `checkout` as possibly stale with a hint to run `rio qa sync`

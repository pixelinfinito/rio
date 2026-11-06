## MODIFIED Requirements

### Requirement: Endpoint-only flags fail explicitly
Flags that need a Rio endpoint (`--pr`, `--deep`, `--publish`, `--since-last`, `--fork`) SHALL be accepted by the parser and, when no endpoint is configured or `--offline` is set, SHALL cause the command to exit with code 2 and a message that names the flag and states that it requires a configured endpoint. The command SHALL NOT run any part of the review in that case.

#### Scenario: PR flag without endpoint
- **WHEN** `rio review --pr 123` is run
- **THEN** the command exits with code 2 and prints a message naming `--pr` and stating that an endpoint is required and not available in this version

#### Scenario: Since-last without endpoint
- **WHEN** `rio review --since-last --offline` is run
- **THEN** the command exits with code 2, names `--since-last` and runs no part of the review

## ADDED Requirements

### Requirement: Local lineage with --since-last
With a configured endpoint, `rio review --since-last` on a branch SHALL review the change as a `branch` lineage keyed by the branch name, with the endpoint as the authority for its round, previous head and posted identities. The CLI SHALL keep only a versioned local copy under the review cache, subject to the cache's normal age and size pruning; a missing copy SHALL be refetched, never treated as a reset. `--reset-lineage` SHALL request a new generation.

#### Scenario: Second local round
- **WHEN** `rio review --since-last` runs twice on a branch whose first run reported one defect that the second run reproduces
- **THEN** the second report is round 2, reviews only the diff since the first head, and counts the defect as held back instead of listing it as new

#### Scenario: Lost local copy keeps the round
- **WHEN** the local lineage copy is deleted and `rio review --since-last` runs again on the same branch
- **THEN** the endpoint's lineage state is used and the review continues at the next round

#### Scenario: Detached HEAD
- **WHEN** `rio review --since-last` runs on a detached HEAD
- **THEN** the command exits with code 2 and states that a branch is required

### Requirement: Feedback command
`rio feedback <id> --dismiss <reason> [--note TEXT]` SHALL record a response on a finding through the configured endpoint, accepting only `fixed`, `wrong`, `intentional`, `irrelevant` or `style`. It SHALL exit 0 on success, 2 for an invalid reason or missing endpoint, and 3 when the endpoint rejects or cannot find the finding.

#### Scenario: Invalid reason
- **WHEN** `rio feedback 8c1e --dismiss known` is run
- **THEN** the command exits with code 2 and lists the accepted reasons without contacting the endpoint

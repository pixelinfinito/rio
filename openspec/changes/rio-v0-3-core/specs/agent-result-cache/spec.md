# Spec Delta

## Purpose

Avoid repeating model calls for hunks that were already reviewed in an identical context, across rounds, branches and pull requests of one tenant, without ever replacing verification.

## ADDED Requirements

### Requirement: Cache key
Agent results SHALL be cached per agent and per changed hunk. A cache hit SHALL require all of the following to be equal: the hunk's repository-relative path and normalized content; the agent name and its manifest version; the hash of the agent's prompt; the resolved model identifier; the resolved agent options; the base and head content of the symbols enclosing the hunk and of their one-hop graph neighbors; and the content hashes of the owner guidance in scope of the hunk.

#### Scenario: Same hunk in a second pull request
- **WHEN** a hunk already reviewed by the correctness agent in one pull request appears unchanged, with unchanged enclosing symbols, neighbors, guidance, prompt, model and options, in another pull request of the same tenant
- **THEN** the lookup for that agent and hunk is a hit

#### Scenario: Neighbor changed
- **WHEN** a hunk is unchanged but a function it calls changed between the two reviews
- **THEN** the lookup is a miss and the agent reviews the hunk again

### Requirement: Hit behavior
On a hit the agents step SHALL replay the stored hypotheses for that hunk with `source.cached: true` and SHALL make no model call for that agent and hunk. Replayed hypotheses SHALL go through verification, the category and evidence floors, posture and presentation caps exactly as fresh hypotheses would, and verification SHALL always run fresh.

#### Scenario: Cached hypothesis still verified
- **WHEN** a cached hypothesis is replayed into a review
- **THEN** the verifier runs its voters on it against this review's head, and the hypothesis becomes a finding only under the same rules as a fresh hypothesis

#### Scenario: No model call on a hit
- **WHEN** every hunk assigned to an agent is a hit
- **THEN** the agent makes no model call and the usage ledger records no tokens for it in that review

### Requirement: Population after a successful run
On a miss the agent runs normally, and its hypotheses SHALL be stored per hunk, sliced by hypothesis location, only when the agent's run completed within budget. A run that failed, timed out, or was cut by the token budget SHALL NOT populate the cache for any of its hunks.

#### Scenario: Budget-cut run does not populate
- **WHEN** an agent's run is stopped by its token budget after reviewing two of five hunks
- **THEN** no cache entry is written for any of the five hunks

#### Scenario: Completed run populates per hunk
- **WHEN** an agent completes and produced hypotheses located in two of three hunks
- **THEN** three entries are written, one per hunk, with the third holding an empty hypothesis list

### Requirement: Invalidation by key inputs
Any change to a key input SHALL produce a miss. Stored entries SHALL NOT be reused after the agent's prompt, manifest version, model identifier or resolved options differ from those recorded.

#### Scenario: Prompt edit
- **WHEN** an agent's prompt file is edited and its manifest version bumped, and a previously cached hunk is reviewed again
- **THEN** the lookup is a miss

#### Scenario: Model change
- **WHEN** the profile switches the agent's model alias to a different model identifier
- **THEN** every lookup for that agent is a miss until entries exist for the new model

### Requirement: Tenant isolation
Cache entries SHALL be scoped to the tenant that produced them and SHALL NOT be readable or writable by another tenant.

#### Scenario: Other tenant's identical hunk
- **WHEN** two tenants review byte-identical hunks in identical contexts
- **THEN** the second tenant's lookup is a miss and its agent runs

### Requirement: Fork exclusion
Reviews of fork pull requests SHALL neither look up nor populate the cache.

#### Scenario: Fork review
- **WHEN** a fork pull request is reviewed
- **THEN** no cache lookup is made, no entry is written, and the report records zero lookups

### Requirement: Step option
The `rio/agents` step option `cache` (default `true`) SHALL disable both lookup and population when `false`.

#### Scenario: Cache disabled
- **WHEN** the resolved profile sets `rio/agents` with `cache: false`
- **THEN** every agent runs without lookup, no entries are written, and the report records zero lookups

### Requirement: Retention
Cache entries SHALL expire with the repository's evidence retention and SHALL be removed when expired.

#### Scenario: Expired entry
- **WHEN** an entry is older than the repository's evidence retention
- **THEN** a lookup that would otherwise match it is a miss and the entry is removed

### Requirement: Cache metrics
The report SHALL carry a `cache` object with `lookups`, `hits`, `hit_rate` and `tokens_saved_estimate`, and the footer SHALL state the hit rate when at least one lookup was made.

#### Scenario: Partial hits
- **WHEN** a review made eight lookups and four were hits
- **THEN** the report's `cache` object records eight lookups, four hits and a hit rate of 0.5, and the footer states that half the agent lookups were served from cache

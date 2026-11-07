# runner-results Specification

## Purpose

Bound what a runner job returns to the endpoint: untrusted command output stays small, while the analysis produced by Rio's own runner can describe a large repository.

## Requirements

### Requirement: Separate limits for command output and analysis artifacts
A runner job SHALL return command output (stdout and stderr) bounded at 1 MiB in total. An analysis job (`checks`, `graph` or `static`) SHALL return the analysis artifact produced by Rio's trusted runner separately from command output, bounded at 12 MiB of JSON and not repeated in stdout. Both bounds SHALL apply to the Cloudflare Container and the self-hosted runner.

#### Scenario: Large repository graph
- **WHEN** a `graph` job for a repository with 2,000 nodes per version produces a 4 MiB graph artifact
- **THEN** the job completes with the artifact, its stdout carries no copy of it, and the review uses the graph

#### Scenario: Untrusted command output unchanged
- **WHEN** a `run` job prints 2 MiB
- **THEN** its output is cut at 1 MiB and marked truncated, as before

### Requirement: Results over their bounds
A job whose output or artifact exceeds its bound SHALL be marked truncated and SHALL NOT supply an artifact. The endpoint SHALL reject a result whose output or artifact exceeds the job's declared bounds.

#### Scenario: Oversized artifact
- **WHEN** an analysis job's artifact would exceed 12 MiB
- **THEN** the job is marked truncated without an artifact, and the review reports the analysis step as failed

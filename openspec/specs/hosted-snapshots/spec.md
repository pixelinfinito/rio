# hosted-snapshots Specification

## Purpose

Carry a hosted review's base and head trees from the CLI to the endpoint and its runners at repository scale, storing each content once and never requiring any component with bounded memory to hold a whole tree.

## Requirements

### Requirement: Content-addressed upload
For an endpoint review the CLI SHALL identify every file content in both trees by its BLAKE3 hash, ask the endpoint which contents it lacks for the tenant, upload only those contents in packs of at most 8 MiB per request, and then register a manifest mapping every path in both trees to its content hash and mode. Each distinct content SHALL be uploaded at most once per tenant.

#### Scenario: Unchanged files are sent once
- **WHEN** a review's base and head trees share 4,000 identical files and differ in 3
- **THEN** the shared contents are uploaded once, not twice, and the manifest still lists every path in both trees

#### Scenario: Second review of the same repository
- **WHEN** a second review of the same repository follows a first one that uploaded every content
- **THEN** only contents new since the first review are uploaded

### Requirement: Upload integrity
The endpoint SHALL verify that every uploaded content matches its declared hash and size and SHALL reject a manifest that references a content the tenant has not uploaded. A tenant SHALL NOT be able to reference or read another tenant's contents, even when hashes are equal.

#### Scenario: Tampered pack
- **WHEN** a pack declares a hash for bytes that hash differently
- **THEN** the upload is rejected and no content from that pack becomes available

#### Scenario: Cross-tenant hash
- **WHEN** tenant B registers a manifest referencing a hash that only tenant A has uploaded
- **THEN** registration is rejected as referencing missing content

### Requirement: Snapshot limits
A snapshot SHALL be accepted with up to 300,000 paths per tree, up to 64 MiB per file and up to 1 GiB of distinct content across both trees. The CLI SHALL check these limits before uploading anything and SHALL name the exceeded limit and the measured value; the endpoint SHALL enforce the same limits.

#### Scenario: Large repository accepted
- **WHEN** a review's base and head trees total 145 MiB of content across 20,000 paths
- **THEN** the snapshot is accepted and the review runs

#### Scenario: Oversized file
- **WHEN** a tree contains a 70 MiB file
- **THEN** the CLI exits before uploading, naming the file size limit and the file's path

### Requirement: On-demand reads
Endpoint steps, agent and verifier tools, triage, evidence checks, guidance validation and graph validation SHALL read file contents on demand from the stored snapshot, and literal search SHALL stream through stored contents. No endpoint component SHALL need to hold a complete tree in memory, and tool results SHALL remain bounded by the existing output limits.

#### Scenario: Tools on a large snapshot
- **WHEN** an agent reads a file and searches a literal pattern in a 145 MiB snapshot
- **THEN** both tools return the same results they would on a small snapshot, within the output limit, without the step exceeding its memory limit

### Requirement: Runner archives
Runner jobs SHALL reference the snapshot instead of embedding it. The Cloudflare Container SHALL receive the trees a job needs as an archive streamed without buffering a whole tree in the Worker or Durable Object. The archive SHALL reproduce each regular file's content and mode exactly; symbolic links stay recorded in the manifest and are never materialized, as before.

#### Scenario: Container job on a large repository
- **WHEN** a checks job runs for a 145 MiB snapshot in the Cloudflare Container
- **THEN** the container's files match the snapshot byte for byte and mode for mode, and the job completes

### Requirement: Self-hosted archive access
The self-hosted runner SHALL download the same job archive from the endpoint using its job capability. The archive SHALL be readable only with a valid capability for that job.

#### Scenario: Archive without capability
- **WHEN** a request for a job archive carries no valid job capability, or a capability for another job
- **THEN** it is rejected and no content is returned

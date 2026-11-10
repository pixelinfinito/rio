# qa-seed-data Specification

## Purpose

Seed data gives the application under test the databases, users, files and records a journey needs; it is defined once in the repository, materialized once per fingerprint, and restored from a cache before every chain instead of being rebuilt.

## Requirements

### Requirement: Seed definitions live in the repository
Seed definitions SHALL live in `.rio/qa/seed/` with a `seed.yaml` manifest declaring `version: 1`, `datastores[]`, `steps[]` (ordered commands or files, each with `applies_to`), `users[]` (persona to seeded account, with an `apply` command that sets the credential from the persona's environment variables) and `paths[]` (application data directories). Only definitions SHALL be committed; materialized state SHALL never be.

#### Scenario: Manifest validates
- **WHEN** `seed.yaml` declares a `postgres` datastore, two SQL files and a loader script as steps, two users with `apply` commands and an `uploads/` path
- **THEN** `rio qa validate` accepts it and `rio qa seed status` lists the datastore, steps, users and paths

#### Scenario: Materialized data in the repository is rejected
- **WHEN** `.rio/qa/seed/` contains a file larger than 5 MiB that no step references, or a file under `.rio/qa/seed/.cache/`
- **THEN** validation fails stating that materialized seed state belongs in the cache, not the repository

### Requirement: Datastore declarations
Each datastore SHALL declare `name`, `kind` (`sqlite`, `postgres`, `mysql`, `redis`, `files`, `custom`), connection by environment variable name, `start` and `ready` (built-in defaults for the supported kinds when the server binary exists in the app image), and for `custom` the `capture` and `restore` commands producing or consuming one archive on stdout or stdin. Client tools and servers SHALL come from the app image; a missing one SHALL fail with `missing_tool`.

#### Scenario: Custom datastore
- **WHEN** a datastore declares `kind: custom`, `capture: "./scripts/qa-dump.sh"` and `restore: "./scripts/qa-load.sh"`
- **THEN** the build runs the capture command and later runs feed the archive to the restore command

#### Scenario: Missing server binary
- **WHEN** a `postgres` datastore is declared and the app image lacks `postgres` or `pg_dump`
- **THEN** the step ends `failed` with reason `missing_tool` naming the binary and the image

### Requirement: Fingerprint and reuse
A seed snapshot SHALL be keyed by a fingerprint of the manifest, every referenced seed file, the migration files matched by `seed.migrations`, the datastore kinds, `seed.cache_version` and the app image digest. Before each chain Rio SHALL restore the matching snapshot when one exists, and SHALL build and capture it at run start otherwise. The plan SHALL record `seed: restored` or `seed: built` with the fingerprint and durations.

#### Scenario: Second run restores
- **WHEN** a run follows another with the same fingerprint
- **THEN** no seed step executes, each chain starts from the restored snapshot, and the footer shows `seed: restored` with the restore time

#### Scenario: Migration change rebuilds
- **WHEN** a change adds a migration file
- **THEN** the fingerprint differs, the seed is rebuilt and captured, and the footer shows `seed: built` with the reason `migrations changed`

### Requirement: Credentials applied after restore
Persona credentials SHALL NOT be stored in the snapshot. After every restore, each `users[].apply` command SHALL run inside the app container with the persona's environment variables, so a changed password takes effect on a cache hit. Credential values SHALL NOT be part of the fingerprint.

#### Scenario: Password rotated
- **WHEN** `QA_SHOPPER_PASSWORD` changes between runs with the same fingerprint
- **THEN** the snapshot is restored, the apply command sets the new password, and the shopper login succeeds

### Requirement: Snapshot storage protocol
Snapshots SHALL be stored as one archive per datastore and path, locally under `<cache>/qa-seeds/<fingerprint>/` and hosted under a tenant-scoped `seeds/` namespace uploaded from the controller container in 8 MiB parts with a hash per part. The snapshot manifest SHALL be published only after every part is verified, so a reader never sees a partial snapshot. Total size SHALL be capped by `seed.max_size` (default 2 GiB), independent of review snapshot quotas.

#### Scenario: One datastore changes
- **WHEN** only the `files` path content changes between fingerprints
- **THEN** only the files archive is uploaded and the database archives are reused by content hash

#### Scenario: Size cap
- **WHEN** a captured snapshot exceeds `seed.max_size`
- **THEN** the build ends `failed` with reason `seed_too_large` naming the largest archive, and the run rebuilds per chain only when `seed.fallback_rebuild` is true

#### Scenario: Interrupted upload
- **WHEN** the controller is interrupted after uploading two of three archives
- **THEN** no snapshot manifest exists for the fingerprint and the next run rebuilds

### Requirement: Safe extraction and pruning
Restore SHALL extract only regular files, reject symlinks and path escapes, and stop with `seed_corrupt` when an archive's expanded size exceeds eight times its compressed size or any part hash mismatches. `rio qa seed prune` SHALL keep the newest N snapshots (default 3) and SHALL never delete a snapshot leased by a running job.

#### Scenario: Hash mismatch
- **WHEN** a downloaded part's hash does not match the manifest
- **THEN** restore stops with `seed_corrupt`, the snapshot is marked invalid, and the run rebuilds

### Requirement: Seed generation on init
`rio qa init` SHALL have the harness author the seed definitions from the application's schema, migrations and models, including one account per persona with an `apply` command, then build and capture the first snapshot, and only then generate journeys against the seeded app. Seed data SHALL be synthetic; the skill SHALL instruct the agent never to copy production data or real personal information.

#### Scenario: Init builds the seed first
- **WHEN** `rio qa init` runs in a repository with Prisma migrations and two personas
- **THEN** `.rio/qa/seed/seed.yaml` and SQL or loader files exist, each persona has a seeded account with an apply command, a snapshot exists in the cache, and journeys were generated against the seeded app

#### Scenario: Realistic data stays synthetic
- **WHEN** the agent proposes seed rows
- **THEN** names, emails and addresses are generated values and `rio qa validate` warns when a seed file matches the secrets catalog or common personal-data patterns

### Requirement: Seed commands
`rio qa seed build [--force]`, `rio qa seed status`, `rio qa seed prune [--keep N]` and `rio qa seed export <dir>` SHALL build or rebuild the snapshot, show fingerprint, size, age and storage, delete old snapshots, and export the archives for inspection. `rio qa seed status` SHALL say whether the next run would restore or build and why.

#### Scenario: Status after a schema change
- **WHEN** a migration was added since the last build and `rio qa seed status` runs
- **THEN** it reports the stored fingerprint, the new fingerprint, and that the next run will build with reason `migrations changed`

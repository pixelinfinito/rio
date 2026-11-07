# Spec Delta

## Purpose

Seed data gives the application under test the databases, users, files and records a journey needs; it is defined once in the repository, materialized once per fingerprint, and restored from a cache on every later run instead of being rebuilt.

## ADDED Requirements

### Requirement: Seed definitions live in the repository
Seed definitions SHALL live in `.rio/qa/seed/` with a `seed.yaml` manifest declaring `version: 1`, `datastores[]` (`name`, `kind`, connection by environment variable name, and `capture` and `restore` overrides for custom kinds), `steps[]` (ordered shell commands or files to apply, each with `applies_to` a datastore or `app`), `users[]` (persona name to seeded account) and `paths[]` (application data directories to include). Only definitions SHALL be committed; materialized state SHALL never be.

#### Scenario: Manifest validates
- **WHEN** `seed.yaml` declares a `postgres` datastore with `url_env: QA_DATABASE_URL`, two SQL files and a loader script as steps, two users mapped to personas and an `uploads/` path
- **THEN** `rio qa validate` accepts it and `rio qa seed status` lists the datastore, steps, users and paths

#### Scenario: Materialized data in the repository is rejected
- **WHEN** `.rio/qa/seed/` contains a file larger than 5 MiB that no step references, or a file under `.rio/qa/seed/.cache/`
- **THEN** validation fails stating that materialized seed state belongs in the cache, not the repository

### Requirement: Supported datastore kinds
Built-in kinds SHALL be `sqlite` (file copy), `postgres` (dump and restore), `mysql` (dump and restore), `redis` (RDB file), `files` (tar of declared paths) and `custom` (`capture` and `restore` commands declared in the manifest, each producing or consuming one archive on stdout or stdin). The container SHALL provide the client tools for the built-in kinds.

#### Scenario: Custom datastore
- **WHEN** a datastore declares `kind: custom`, `capture: "./scripts/qa-dump.sh"` and `restore: "./scripts/qa-load.sh"`
- **THEN** the build runs the capture command and later runs restore the archive through the restore command

#### Scenario: Missing client tool
- **WHEN** a `postgres` datastore is declared and the runner image lacks `pg_dump`
- **THEN** the seed build ends `failed` with reason `missing_tool` naming the tool and the image version

### Requirement: Fingerprint and reuse
A seed snapshot SHALL be keyed by a fingerprint of the manifest, every referenced seed file, the application's migration files declared or detected in the contract, the datastore kinds and the QA image version. At run start Rio SHALL restore the snapshot matching the fingerprint when one exists, and SHALL build and capture it otherwise. The plan SHALL record `seed: restored` or `seed: built` with the fingerprint and duration.

#### Scenario: Second run restores
- **WHEN** a run follows another with the same fingerprint
- **THEN** no seed step executes, the datastores are restored from the snapshot, and the footer shows `seed: restored` with the restore time

#### Scenario: Migration change rebuilds
- **WHEN** a change adds a migration file
- **THEN** the fingerprint differs, the seed is rebuilt and captured, and the footer shows `seed: built` with the reason `migrations changed`

### Requirement: Snapshot storage
Seed snapshots SHALL be stored content-addressed by fingerprint: locally under `<cache>/qa-seeds/<fingerprint>/`, hosted in the same tenant-scoped store as review snapshots, so unchanged archives are not re-uploaded. A snapshot SHALL be split into one archive per datastore and path so a change to one datastore uploads only that archive. Snapshot size SHALL be capped by `qa.seed_max_size` (default 2 GiB) and the footer SHALL show the size.

#### Scenario: One datastore changes
- **WHEN** only the `files` path content changes between fingerprints
- **THEN** only the files archive is uploaded and the database archives are reused by content hash

#### Scenario: Size cap
- **WHEN** a captured snapshot exceeds `qa.seed_max_size`
- **THEN** the build ends `failed` with reason `seed_too_large`, names the largest archive, and the run continues without seed by rebuilding each time only if `seed.fallback_rebuild` is true

### Requirement: Isolation between journeys
Each run SHALL start from a freshly restored snapshot. A journey that mutates data MAY declare `resets: true` to have the snapshot restored before it starts; journeys without it share the run's state in plan order. `rio qa init` SHALL set `resets: true` on journeys it generates that create or delete records.

#### Scenario: Registration journey resets
- **WHEN** `account-registration` declares `resets: true` and runs after `login`
- **THEN** the datastores are restored before it so the registered email does not already exist

#### Scenario: Shared state in order
- **WHEN** `add-to-cart` and `checkout` do not declare `resets` and run in that order
- **THEN** `checkout` sees the cart from the previous journey

### Requirement: Seed generation on init
`rio qa init` SHALL have the harness author the seed definitions from the application's schema, migrations and models, including one account per persona with credentials read from the persona's environment variables at build time, then build and capture the first snapshot, and only then generate journeys against the seeded app. Seed data SHALL be synthetic; the skill SHALL instruct the agent never to copy production data or real personal information.

#### Scenario: Init builds the seed first
- **WHEN** `rio qa init` runs in a repository with Prisma migrations and two personas
- **THEN** `.rio/qa/seed/seed.yaml` and SQL or loader files exist, each persona has a seeded account, a snapshot exists in the cache, and journeys were generated against the seeded app

#### Scenario: Realistic data stays synthetic
- **WHEN** the agent proposes seed rows
- **THEN** names, emails and addresses are generated values and `rio qa validate` warns when a seed file matches the secrets catalog or common personal-data patterns

### Requirement: Seed commands
`rio qa seed build [--force]`, `rio qa seed status`, `rio qa seed prune [--keep N]` and `rio qa seed export <dir>` SHALL build or rebuild the snapshot, show fingerprint, size, age and storage, delete old snapshots keeping the newest N (default 3), and export the archives for inspection. `rio qa seed status` SHALL say whether the next run would restore or build.

#### Scenario: Status after a schema change
- **WHEN** a migration was added since the last build and `rio qa seed status` runs
- **THEN** it reports the stored fingerprint, the new fingerprint, and that the next run will build with reason `migrations changed`

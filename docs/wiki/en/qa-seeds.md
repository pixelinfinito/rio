# Prepare synthetic data and service fixtures

## Outcome

Start each browser chain from repeatable data, simulate external services, and inspect reusable seed snapshots.

## Prerequisites

Reviewed `.rio/qa.yaml`, seed/fixture definitions, Docker app image and readiness. Use synthetic persona accounts. Credentials are supplied at runtime, not committed into seed archives. Seed build/export makes no model calls.

## Steps

Use the complete sample's `.rio/qa/seed/seed.yaml`, SQL migrations and `.rio/qa/fixtures/fixtures.yaml` as a working reference. Define datastore snapshots, seed commands/files, named uploads, service doubles and captured-message assertions for your application. `rio qa init` can propose missing definitions, which are validated before writing.

```sh
rio qa fixtures status
rio qa seed status
rio qa seed build
rio qa seed export ./new-seed-inspection
```

Build restores a matching snapshot or runs seed commands inside the isolated app container and captures a new one. `--force` rebuilds without changing the fingerprint or deleting active leased snapshots. Export verifies hashes and writes opaque archives plus `manifest.json`; it does not unpack. Its parent must exist, destination must be new, and symlinks are refused.

## Expected results

The seed fingerprint includes manifests, migration matches, fixture definitions/recordings/uploads, datastore kinds, `seed.cache_version` and image digest. Shell-based seeds conservatively include captured source. Runtime persona credentials are excluded and applied after restoration. Change cache_version when other runtime inputs change intended seed contents.

`rio qa seed status --image APP_IMAGE` inspects a provisioned image; unavailable digest is reported as a missing prerequisite. `rio qa seed prune --keep 3` deletes eligible old snapshots while retaining the newest and active leases. Imports/publication/pruning share locks.

## Troubleshooting

Use `app.test` for app/service-double HTTP URLs. Blocked hosts, TLS pinning and unresolved SDK/URL variables appear in diagnostics. Genuine dependency failures produce `precondition_failed` for affected/dependent journeys; unrelated journeys continue. Fix doubles or contract intentionally rather than allowing arbitrary network. `seed_too_large` names oversized data: reduce synthetic fixtures or deliberately adjust quotas.

## Next steps

[Run QA](qa.md), [maintain chains](qa-journeys.md), and [inspect retained evidence](qa-evidence.md).

<!-- commands:start -->

<details>
<summary>All command options</summary>

## Command reference

### `rio qa fixtures`

| Argument | Meaning | Default / choices |
| --- | --- | --- |
| `--help` | Show command syntax and supported options. | `—` |
### `rio qa fixtures status`

| Argument | Meaning | Default / choices |
| --- | --- | --- |
| `--help` | Show command syntax and supported options. | `—` |
### `rio qa seed`

| Argument | Meaning | Default / choices |
| --- | --- | --- |
| `--help` | Show command syntax and supported options. | `—` |
### `rio qa seed build`

| Argument | Meaning | Default / choices |
| --- | --- | --- |
| `--force` | Rebuild and validate seed snapshots even when a matching cached seed exists. | `false` |
| `--help` | Show command syntax and supported options. | `—` |
### `rio qa seed export`

| Argument | Meaning | Default / choices |
| --- | --- | --- |
| `<directory>` | New directory receiving verified opaque seed archives. | `—` |
| `--help` | Show command syntax and supported options. | `—` |
### `rio qa seed prune`

| Argument | Meaning | Default / choices |
| --- | --- | --- |
| `--keep` | Retain this many newest seed snapshots plus active leases. | `3` |
| `--help` | Show command syntax and supported options. | `—` |
### `rio qa seed status`

| Argument | Meaning | Default / choices |
| --- | --- | --- |
| `--image` | Inspect this provisioned app image for seed status. | `—` |
| `--help` | Show command syntax and supported options. | `—` |

</details>

<!-- commands:end -->

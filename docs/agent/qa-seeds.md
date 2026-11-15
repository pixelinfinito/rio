# Seeds and fixtures

Requires the isolated Docker app pod, reviewed QA/seed/fixture definitions and app readiness. Seed commands execute only in the app container. Use synthetic accounts/data; credentials come from runtime auth, not committed archives. Build/export do not invoke models.

## commands
`rio qa seed build` restores a matching snapshot or executes seed steps and captures one. --force rebuilds without changing the fingerprint or deleting leased snapshots. `rio qa seed status [--image APP_IMAGE]` reports fingerprint/cache/rebuild reason; missing image digest is a prerequisite error, never an invented key.
`rio qa seed export NEW_DIRECTORY` verifies archive/part hashes and writes opaque archives plus manifest.json. Parent must exist; destination must be new and not a symlink. It does not unpack archives. `rio qa seed prune --keep 3` retains newest snapshots and active leases; pruning deletes eligible cache data.

## fixtures
`rio qa fixtures status` inspects named uploads, service doubles and captured-message fixtures. Define external service recordings, upload files and capture assertions in the QA fixture contract. app.test maps to the app container. Unmocked hosts/TLS rejection diagnostics explain precondition_failed journeys; fabricated host claims cannot establish dependency failure. Model setup can propose doubles, but unresolved pinned TLS/SDK dependencies require owner action.

## cache
Fingerprint includes manifests, migrations, fixture recordings/uploads, datastore kinds, seed.cache_version and resolved image digest. Shell seed commands conservatively include captured source. Persona credentials are excluded and applied after restore. Change seed.cache_version for external inputs that alter seed semantics. Chains restore seed for isolation. Oversized archives fail with seed_too_large; inspect largest archive instead of leaking production data into fixtures.

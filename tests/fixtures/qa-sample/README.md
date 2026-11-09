# QA sample

A synthetic Vite shop with a Node SQLite API. It provides guest checkout, saved
addresses, SMTP account verification, a payments double, and admin CSV import.
`REVIEW.md` supplies the product expectations used by QA.

Build and exercise the clean application (Node 22.13 or newer):

```sh
npm ci
npx playwright install chromium
npm test
```

The test launcher creates an isolated SQLite database, applies synthetic shopper
and admin credentials, starts loopback payments/SMTP doubles and removes the data
on exit. All five flows run on phones and desktop in light and dark mode.

Build the packaged application:

```sh
docker build -f Dockerfile.qa -t rio-qa-sample .
```

The production entrypoint expects Rio to restore/build the seed, apply persona
credentials, and start the manifest's doubles first. For an isolated smoke test
with the bundled test services:

```sh
docker run --rm --network none rio-qa-sample node scripts/test-server.mjs
```

The image exposes its provisioned dependencies at `/node_modules`, allowing the
materialized snapshot under `/work/repo` to resolve them. The QA start command
builds that snapshot's frontend before starting its API; it installs no packages.

`defects.json` defaults every defect to false. Enable a set through `QA_DEFECTS`
(comma separated) or edit the JSON before building. The toggles cover functional
failures, mobile interaction and visual probes, as well as successful-but-cumbersome
flows: `duplicate-address`, `ambiguous-next`, `lost-input`, `missing-cancel`, and
`keyboard-barrier`. `intentional-brand` is a clean control explicitly permitted by
owner guidance. No real personal data, provider credentials or payment calls are
required. Test infrastructure endpoints are separate from the application.

The add-to-cart journey restores at the chain head. Checkout declares
`after: [add-to-cart]` and keeps the cart; registration and recovery begin fresh
chains. Credentials are applied after seed restore and are absent from the seed
SQL and committed journey files.

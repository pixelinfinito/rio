# SARIF mapping

Rio renders a review as a [SARIF 2.1.0](https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html) log so that code-scanning services and editors show the same findings, with the same identities, as the terminal. Two renderers implement this document: `rio-core` for `rio review --format sarif`, and the Worker for `GET /v1/reviews/{id}/report?format=sarif`. Both are tested against the fixtures in [`tests/fixtures/sarif/`](../tests/fixtures/sarif/) (`crates/rio-core/tests/sarif.rs` and `worker/tests/sarif.test.ts`): for the same report and renderer inputs each reproduces `expected.sarif`, so their outputs are byte-identical after canonical key ordering. The Rust test also validates every rendered log against the official OASIS SARIF 2.1.0 schema, vendored in [`tests/fixtures/sarif-schema/`](../tests/fixtures/sarif-schema/). A change to this mapping changes both renderers and the fixtures together. The capability is specified in `openspec/changes/rio-v0-3-core/specs/sarif-output/spec.md` and decision D9 of that change's design.

## Inputs

A SARIF document is a function of:

- the report-v1 document (`report.json` in each fixture);
- the renderer inputs (`render.json` in each fixture): `start_time_utc` and `end_time_utc` of the review (the CLI's run, or the endpoint review's creation and report times), and `exit_code`, which only the CLI knows and the endpoint passes as `null`;
- `include_pre_existing`, false unless the CLI was given `--show-pre-existing`; the endpoint always uses false.

Nothing else (clock, host, paths on disk) may influence the output.

## Document

| SARIF property | Location | Value |
| --- | --- | --- |
| `$schema` | log | `https://json.schemastore.org/sarif-2.1.0.json` |
| `version` | log | `2.1.0` |
| `runs` | log | exactly one run per review |
| `tool` | run | `{ "driver": … }` |
| `driver` | `tool` | the renderer |
| `name` | `driver` | `rio` |
| `version` | `driver` | `review.rio_version` from the report |
| `informationUri` | `driver` | `https://github.com/pixelinfinito/rio` |
| `rules` | `driver` | one entry per distinct `rule_id`, in order of first appearance among the results |
| `id` | rule | the `rule_id` |
| `shortDescription` | rule | `{ "text": <message of the first result with this rule> }` |
| `properties` | rule | `{ "category": <category of that first result> }` |
| `category` | rule `properties`, result `properties` | `defect`, `risk` or `security`; entries from the report's `risks` list are `risk` |
| `originalUriBaseIds` | run | `{ "SRCROOT": { "description": { "text": "Repository root" } } }` |
| `SRCROOT` | `originalUriBaseIds`, `artifactLocation.uriBaseId` | the repository root; locations are relative to it |
| `description` | `SRCROOT` | `{ "text": "Repository root" }` |
| `results` | run | see [Results](#results) |
| `properties` | run | `rio.status`, `rio.risk_tier`, `rio.review_id` and, for lineage reviews, `rio.lineage` |
| `rio.status` | run `properties` | report `status` |
| `rio.risk_tier` | run `properties` | report `risk_tier` object, or `null` |
| `rio.review_id` | run `properties` | `review.id`, or `null` |
| `rio.lineage` | run `properties` | report `lineage` object; omitted outside lineages |
| `invocations` | run | exactly one invocation, see [Invocation](#invocation) |

## Results

One result per finding entry, in this order: `findings`, then `risks`, then `security`, each in report order. Tool findings nested under `checks[].findings` are not read; they are already in `findings`.

| SARIF property | Location | Value |
| --- | --- | --- |
| `ruleId` | result | `rule_id` |
| `ruleIndex` | result | index of the rule in `driver.rules` |
| `level` | result | `error` for severity `error`, `warning` for `warning`, `note` for `info`; always `note` for an entry of the `risks` list and for an entry at evidence level `plausible` |
| `message` | result | `{ "text": … }` |
| `text` | `message`, `shortDescription`, `description` | for results: `message`, then a newline and `Trigger: <trigger>` when the trigger is not empty; risk and plausible entries are prefixed with `Risk for human judgment: ` |
| `locations` | result | one entry per element of the finding's `locations` (the primary `location` when `locations` is empty), in order |
| `physicalLocation` | location | `{ "artifactLocation": …, "region": … }` |
| `artifactLocation` | `physicalLocation` | `{ "uri": <path>, "uriBaseId": "SRCROOT" }` |
| `uri` | `artifactLocation` | the repository-relative `path`, unchanged |
| `uriBaseId` | `artifactLocation` | `SRCROOT` |
| `region` | `physicalLocation` | `startLine`, `endLine` and, when the location has a column, `startColumn` |
| `startLine` | `region` | `line_start` |
| `endLine` | `region` | `line_end` |
| `startColumn` | `region` | `column`; omitted when absent |
| `partialFingerprints` | result | `{ "rioFindingId/v1": <id> }` |
| `rioFindingId/v1` | `partialFingerprints` | the finding identity |
| `baselineState` | result | `new` for state `new` or `worsened`; `unchanged` for `pre-existing`; `absent` for `fixed`; omitted for `unclassified` |
| `properties` | result | the keys below that are present on the finding, under the same names |
| `evidence_level` | result `properties` | `evidence_level` |
| `state` | result `properties` | regression `state` |
| `severity` | result `properties` | `severity` (kept because `level` folds risks into `note`) |
| `status` | result `properties` | lifecycle `status`; omitted when absent |
| `verification` | result `properties` | the `verification` object; omitted when absent |
| `round` | result `properties` | `round`; omitted when absent |
| `author_response` | result `properties` | the `author_response` object; omitted when absent |
| `history` | result `properties` | the `history` object; omitted when absent |

## Invocation

| SARIF property | Location | Value |
| --- | --- | --- |
| `executionSuccessful` | invocation | `false` when the report `status` is `error`, otherwise `true` |
| `exitCode` | invocation | the CLI's exit code; omitted when the renderer input is `null` |
| `startTimeUtc` | invocation | `start_time_utc` |
| `endTimeUtc` | invocation | `end_time_utc` |
| `toolExecutionNotifications` | invocation | one notification per entry of the report's `incomplete` list; omitted when empty |
| `level` | notification | `warning` |
| `descriptor` | notification | `{ "id": <check kind> }` |
| `id` | `descriptor` | the check kind (`typecheck`, `lint`, `secrets`, `coverage`, `dependencies`) |
| `message` | notification | `{ "text": "<kind> <root> <version>: <outcome> (<reason>)" }`, followed by ` — <hint>` when the check has a non-empty hint |
| `properties` | invocation | `{ "error": { "code", "message" } }` when the report `status` is `error`; omitted otherwise |
| `error` | invocation `properties` | the report's `error.code` and `error.message` |
| `code` | `error` | `error.code` |

## Exclusions

These never become results:

- refuted hypotheses, suppressed findings, remembered findings and category-floor drops (none of them are in the report's lists);
- entries with state `pre-existing`, unless `include_pre_existing` is true, in which case they appear with `baselineState` `unchanged`.

Entries with state `fixed` appear with `baselineState` `absent`, so code-scanning services close their alerts.

## Error status

When the report `status` is `error`, the log still has one run. The run has `"results": []`, an empty `rules` list, `executionSuccessful` `false`, the CLI exit code when known, and the error in the invocation's `properties.error`. The `error-status` fixture shows the CLI case outside a git repository (exit code 3).

## Fixtures

| Case | Shows |
| --- | --- |
| `complete-review` | tool and agent defects, a class finding with several locations, a verified finding, a `fixed` entry (`absent`) and an omitted `pre-existing` entry |
| `risks-and-plausible` | `risks` entries and plausible security entries as `note`, a static-proven security entry as `error`, an `unclassified` entry without `baselineState`, skipped checks as warning notifications (one with an empty hint, which adds no ` — `) |
| `lineage-history` | a round 2 lineage review: lifecycle status, author response, history, `round` on results and `rio.lineage` and the risk tier on the run |
| `error-status` | a review that could not start: no results, `executionSuccessful` false, exit code 3 and the error in the invocation properties |

A documentation test (`crates/rio-core/tests/documentation.rs`) checks that every property named in the first column of the tables above appears as a key in at least one fixture's `expected.sarif`, and that every fixture report validates against report-v1.

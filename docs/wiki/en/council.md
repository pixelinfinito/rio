# Use the independent council

## Outcome

Request independent assessments for findings that remain uncertain after verification, while preserving evidence standards.

## Prerequisites

Hosted endpoint, explicit vendor opt-in, configured routes/keys and budget. Council sends evidence to every allowed participating vendor. The implementation is present, but its final/live A/B acceptance tasks are still pending; do not infer a demonstrated quality improvement.

## Steps

Inspect `rio profile show rio/security` or `rio profile show rio/critical`. Council is enabled there and disabled in `rio/base`. Setup offers vendor selection; `--no-council` skips it. A noninteractive entry uses `--council-vendor VENDOR:FAMILY:ROUTE`, repeated for selected members. For example, a configured compatible route can use `google:gemini:compat/google-ai-studio/MODEL` with an actual model name.

Both the profile's `council.vendors_allowed` and the deployment's `COUNCIL_VENDORS` must allow a vendor before its evidence pack is built/sent. Members still marked placeholder are reported as unconfigured, not silently used. Self-hosted members require a runner advertising model capability.

## Expected results

Default triggers include plausible high-severity findings, verifier disagreement, high risk, deep and nightly runs. Five roles assess identical evidence independently, with up to two rounds and two experiments; default minimum is three members. Base-pass/head-fail experimental evidence can reproduce a finding; a demonstrated protection can refute it; unresolved cases stay plausible.

Agreement counts and learned weights do not promote evidence. Reports show decision/tier, member roles, experiments, note, partial/excluded states and cost. Audit records identify vendors/model routes and pack hashes without logging pack content. Other profile controls include max_findings, timeout and member overrides; see the generated schema reference.

## Troubleshooting

Unconfigured/excluded/timed-out members must remain visible. A partial council is not a unanimous decision. Verify both allowlists and model-family diversity; check remaining budget. Missing runner model capability prevents self-hosted participation. Consult the recorded A/B gate before making quality claims.

## Next steps

[Set resource limits](budgets.md) and [interpret evidence](results.md).

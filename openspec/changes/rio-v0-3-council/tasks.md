# Tasks

## 0. Contracts and schemas

- [x] 0.1 Add `schemas/council-assessment-v1.json` (member role, round, `real`, `introduced_by_change`, `impact`, `basis`, non-empty `evidence_refs`, optional `experiment_request`, round-2 `changed_from`, `changed_to`, `cites` with `reason_code` enum) and regenerate the Worker validators. Verify schema tests accept the round-1 and round-2 examples from the council-members spec and reject empty `evidence_refs`, a round above 2 and an unknown `reason_code`
- [x] 0.2 Extend `schemas/profile-v1.json` and `rio-profile` with the optional `council` block and its defaults (5 members, `max_findings` 5, `max_experiments` 2, `max_rounds` 2, `min_members` 3, `timeout` 90 s, `vendors_allowed` `[]`), rejecting `max_rounds` above 2 and `min_members` above the member count. Verify resolution tests for a legacy profile without `council`, each rejection and the defaults
- [x] 0.3 Extend the rule language in `rio-profile` with `evidence == <level>`, `severity >= <level>` (finding scale `info` < `warning` < `error`), `verify.split`, `risk_tier == <tier>`, `mode == fast|deep` and `nightly`, with finding-level predicates valid only in the council step's `rules`. Verify tests that a council rule using `verify.split` validates and `evidence == plausible` in a triage rule is rejected at its location
- [x] 0.4 Add module-v1 kind `member` (`provider`, `model`, `prompt`, `context_pack`, `role`, `weight`, `vendor`, `family`, `self_hosted`) and `modules/steps/council/module.yaml` (`rio/council@0.1.0`, `needs: [verify]`, option schema). Verify a manifest test for each field's validation and that a council step whose `needs` omit `verify` is rejected
- [x] 0.5 Extend `schemas/finding-v1.json` and `rio-core::Finding` with the optional `council` block (`decision`, `tier`, `members`, `experiments`, `note`, `partial`) and `schemas/report-v1.json` with the optional `council` metrics object. Verify `crates/rio-core/tests/contracts.rs` and the generated validators accept findings with and without the block and reject a numeric confidence field
- [x] 0.6 Add Worker migration `0007_council.sql` (0005 and 0006 are taken by `rio-v0-3-core`) (`council_assessments`: review, finding, member, round, assessment key, abstained, vendor, model, pack hashes, byte sizes, timestamp). Verify the migration tests on a fresh and an upgraded database
- [x] 0.7 Compose the `Rule expressions` and `Section order` deltas with `rio-v0-3-core` (which modifies `Built-in step options`, `Footer content` and `JSON renderer`): whichever change archives last carries every addition. Verify a documentation test diffs both deltas against the main spec and fails if an addition is lost

## 1. Members

- [x] 1.1 Add the five built-in member manifests and prompts under `modules/members/` (`skeptic` diff-only, `exploit-author` execution, `code-owner` graph-heavy, `maintainer` graph-heavy, `tester` execution) with placeholder providers and initial weights. Verify a loader test that every manifest validates, roles are unique and each prompt receives the pack only in delimited data blocks
- [x] 1.2 Implement family-diversity validation (at least three families) and the "unconfigured" report for placeholder providers in `rio profile validate` and `rio profile show`. Verify CLI tests for a two-family council (rejected), placeholders (unconfigured, exit 0) and a configured council
- [x] 1.3 Implement the author-family rule from PR metadata (agent attribution when present): at most one member of the author's family, substitution from the allowlist, otherwise partial; "not applicable" when metadata is missing. Verify Worker tests for substitution, partial and not-applicable

## 2. Council step

- [x] 2.1 Implement trigger evaluation after `rio/verify` (any matching rule selects; `max_findings` by impact × evidence; footer count of findings not councilled) and the default trigger rules in the `security` and `critical` profiles. Verify workflow tests for each of the five triggers, the cap and a review with no match making no council call
- [x] 2.2 Build the identical content-addressed evidence pack per finding (hypothesis without agent reasoning, graph slice at `hops`, base and head of affected files, verifier artifacts with blind-match summary without voter identities, intent, owner guidance in scope) and the three context-pack renderings over it. Verify tests that every member receives the same pack hash and that the renderings differ only by the specified additions
- [x] 2.3 Fan out round 1 through the model gateway with per-vendor adapters, no tools, `timeout`, abstention on validation failure, empty `evidence_refs` or timeout, and `min_members` degradation (`partial (n/5)`, `skipped (n/5)`); vendor errors are logged per member and never fail the review. Verify tests with a recorded gateway for a full round, two timeouts, three vendor failures (skipped) and the finding keeping its verifier result
- [x] 2.4 Implement experiments: one request per member, dedup by normalized command and version, selection of at most `max_experiments` by weight, execution as runner jobs under verifier isolation with no network, results attached to the round-2 pack, none on fork PRs. Verify tests for dedup, selection order, the fork case and an experiment artifact reference in the pack
- [x] 2.5 Implement round 2 (anonymized letters, experiment results, position change only with a valid citation, invalid citations ignored, `max_rounds` hard maximum 2) and store every assessment and the audit rows. Verify tests for a valid change, an invalid citation keeping the round-1 position, and a partial council skipping round 2 below `min_members`

## 3. Deterministic aggregator

- [x] 3.1 Implement the aggregator in the Worker with no model call: experiment failing on head and passing on base → `reproduced` (tier `experiment`); `protection_found` with a graph-confirmed path from trigger to location → `refuted` (tier `protection`); otherwise `plausible` with a council note in words (tier `judgment`); agreement count never promotes; the decision never upgrades the verifier's category. Verify unit tests for each rule, five `real: yes` with `basis: none` staying `plausible`, a risk staying a risk, and a refuted council decision closing the finding
- [x] 3.2 Load learned weights per member and category from the eval set with sample sizes, falling back to the manifest weight under 30 cases; weights order experiments and the note only. Verify tests that changing weights never changes a decision tier

## 4. Governance

- [x] 4.1 Implement the double allowlist (profile `vendors_allowed` and the repository's council vendors in `COUNCIL_VENDORS`) with pre-pack exclusion and the reported exclusion. Verify Worker tests for a vendor missing from either list
- [x] 4.2 Write the audit record `reviews/<id>/council/audit.json` and the `council_assessments` rows (vendor, model, pack hashes, byte sizes, timestamp), logging by hash never by content, and apply evidence retention to packs while keeping audit rows. Verify tests that the audit lists every pack sent and that no repository content appears in logs
- [x] 4.3 Add the opt-in council step to `rio init` after the primary provider (choose vendors with their family and model route, store keys as Worker secrets, write the allowlist to `config.toml` and `COUNCIL_VENDORS`; skippable; replayable from `config.toml`), and fill placeholder members from `config.toml` when the CLI resolves a profile. Verify deployment mock tests for the chosen, skipped and replayed paths
- [x] 4.4 Let the self-hosted runner advertise an OpenAI-compatible model endpoint in its capabilities and route `self_hosted: true` members through it. Verify runner protocol tests that a self-hosted member's pack never leaves the account's gateway path and that a runner without the capability excludes those members with a report line

## 5. Report and CLI

- [x] 5.1 Render the council section (decision, tier, members by role, experiments run, note, partial marker) after the security section and the footer lines (councilled count, not-councilled count, partial or skipped markers, cost per finding) in terminal, Markdown and JSON. Verify `crates/rio-core/tests/render.rs` snapshots for reproduced-by-experiment, refuted-by-protection, plausible-with-note and partial councils
- [x] 5.2 Add `modules/profiles/critical.yaml` and enable the council step with the five default triggers in it and in `modules/profiles/security.yaml`; keep it present and disabled in `rio/base` (council-governance: "present and disabled"); regenerate `docs/profiles.md`. Verify `rio profile show rio/security` and `rio/critical` show the step with placeholder providers reported unconfigured, and `rio/base` shows it disabled

## 6. Evaluation

- [x] 6.1 Add `eval/council.py`: disagreement rate (basis versus wording), promotion and refutation accuracy on the `plausible` bucket versus verifier-only on the same cases and day, cost per councilled finding, and `eval/schema/council-summary-v1.json`. Verify harness tests with recorded fixtures for each metric and a mismatched case set being rejected
- [x] 6.2 Add offline weight estimation per member and category from eval outcomes and monthly from author responses, writing `modules/members/weights.json` with sample sizes. Verify tests for the 30-case floor and that estimation is deterministic on the same inputs
- [x] 6.3 Add the keep-or-remove rule to `eval/gate.py` and `docs/release-checklist.md` (disagreement below 5 % over a cycle, or accuracy not above baseline → remove the step from the `security` and `critical` profiles). Verify gate tests for both removal conditions and a keep

## 7. Integration

- [x] 7.1 Run a recorded end-to-end review through the deployed-equivalent Worker with the `security` profile: one finding reproduced by an experiment, one refuted by a protection, one plausible with a note, one partial council and one vendor excluded by the allowlist. Verify the report, the audit record, the assessment rows and the footer cost
- [ ] 7.2 Run `cargo fmt --all --check`, `cargo clippy --workspace --all-targets --locked`, `cargo test --workspace --locked --no-fail-fast`, the Worker checks and tests, `python3 -m unittest discover -s eval/tests -v`, `openspec validate --specs` and `openspec validate rio-v0-3-council --strict`. Verify the hosted Linux/macOS/Windows CI matrix passes on the pushed branch
- [ ] 7.3 Run the council A/B on the reference set's `plausible` bucket with real vendors on a test account and record the result under `docs/evaluation/v0.3-council.md`. Verify the record states disagreement rate, accuracy versus verifier-only, cost per finding and the keep-or-remove verdict

## Workflow follow-up

- Depends on `rio-v0-2-review-convergence` (reasons feed weights) and on `rio-v0-3-core` for the `security` community profile, PR metadata (author-family rule) and the nightly job (`nightly` trigger); the step runs without those with the documented degradations.
- Archive this change only after the A/B record says keep; a remove verdict archives it with the step disabled in the built-in profiles.

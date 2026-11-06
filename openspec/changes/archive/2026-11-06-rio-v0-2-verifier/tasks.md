# Tasks

The owner confirmed the three planning decisions recorded in `design.md`: a one-fifth per-voter budget with an override, no evidence downgrade for blind misses, and independent security review. On 2026-11-06 the owner authorized implementing the missing v0.2 runtime, endpoint, gateway and runners within this change. Security execution and its enabled community profile remain conditional on the v0.3 agent/catalog release.

## 0. Cloudflare core (expanded scope)

- [x] 0.1 Implement the Worker API with scoped bearer authentication, validation, version negotiation, snapshot/review submission, status/report/events and signed runner completion; verify local API integration tests and unauthorized/cross-review rejection.
- [x] 0.2 Add D1 migrations, R2 storage and the durable profile DAG Workflow with bounded fan-out, retries and attempt-safe runner events; verify workflow/storage tests, typechecking and Wrangler dry-run bundling.
- [x] 0.3 Implement provider adapters and the budget/usage ledger, repository-wide immutable tools and agent execution; verify recorded-provider tests, tool isolation and budget exhaustion.
- [x] 0.4 Implement Cloudflare Sandbox dispatch and the authenticated self-hosted Docker runner with limits, scoped artifact upload and signed completions; verify shared protocol and denied-execution tests.
- [x] 0.5 Connect the Rust HTTP client and CLI endpoint configuration/submission/setup/deploy path, including native account-local `rio init`, `init --from` and repeatable `rio deploy` with the paired embedded Worker, resource reuse, migration Workflow, AI Gateway authentication and private credentials; verify account-isolation, fresh/repeated deployment, offline dry-run, client/CLI and local-only regression tests.
- [x] 0.6 Document portable Cloudflare setup, cf authentication, credentials, release runner images, deployment, runner isolation and live acceptance commands; verify configuration generation and deployment without requiring a source checkout or Node build toolchain. Record live evidence separately from empirical model precision.

## 1. Confirm predecessor and runtime integration contracts

- [x] 1.1 Confirm the v0.1 `review-profiles`, `findings` and `review-report` main specs exist at their established capability paths and that every MODIFIED requirement and preserved scenario in this change matches that predecessor; verify `openspec validate rio-v0-2-verifier --strict` reports no missing-target or dropped-scenario issues. Publishing the predecessor is a separate authorized workflow, not permission to rewrite its implementation.
- [x] 1.2 Confirm the v0.2 core runtime supplies the endpoint model-step executor, structured hypothesis schema, model gateway, immutable base/head reads, graph access, runner jobs, per-agent token budgets, risk-policy conventions and audit persistence; verify its integration tests and record the concrete integration entry points in the design. Implement any missing integration entry points under the expanded scope, with API/protocol and local integration tests.

## 2. Extend profile resolution and module configuration

- [x] 2.1 Extend `schemas/profile-v1.json` and `crates/rio-profile/src/loader.rs` with optional verify settings and fast/deep `verify_tokens`; implement defaults, count constraints, model-alias precedence, positive budgets and resolved-profile hashing. Verify schema/resolution tests cover omitted settings, the one-voter quorum shorthand, inheritance, overrides, invalid counts and unknown aliases.
- [x] 2.2 Relax the verifier-model rule only for multiple voters; compare resolved model values for one voter, including explicit verify aliases. Verify the existing semantic fixture is updated to specify one voter, identical-model quorum profiles pass, and an alternative alias pointing to the default model cannot bypass single-voter independence.
- [x] 2.3 Extend built-in module option validation for security enablement, independent posture/caps/fail policy/catalog and explicit triage risk thresholds; retain verifier dependency guardrails for all enabled hypothesis producers, including security. Verify positive and negative module-schema tests and DAG tests reject an enabled security or agents step without a dependent verifier.
- [x] 2.4 Connect Quick, Standard and Deep selection to the resolved posture/budget using the prerequisite CLI/runtime interface while preserving explicit overrides and local endpoint requirements. Verify CLI/profile tests exercise all three presets and unchanged deterministic behavior.
- [x] 2.5 Update `docs/profiles.md` through `scripts/generate-profile-reference.py`, document model fallback, budget derivation, presets and the security release boundary, and refresh resolved-profile snapshots. Verify the generated reference is reproducible and the documented examples validate.

## 3. Extend finding and report contracts

- [x] 3.1 Extend `schemas/finding-v1.json` and `crates/rio-core/src/model.rs` with optional verification metadata and published category security; keep style/diagnostic as hypothesis/audit classifications. Verify round-trip and invalid-value tests for voter counts, agreeing counts, per-voter blind matches and split, and acceptance of all existing deterministic fixtures without verification metadata.
- [x] 3.2 Extend `schemas/report-v1.json` and `crates/rio-core/src/report.rs` with optional security results and verification audit/cost and held-back/category-drop summaries. Reuse the existing triage risk-source contract. Verify historical report fixtures still validate, new reports round-trip, and empty security data does not force new fields into historical or deterministic-only output.
- [x] 3.3 Update the prerequisite runtime's hypothesis/vote schemas and persistence for categories, blind answers, voter identity/status, evidence references and downward reclassification reasons without discarding the hypotheses audit table. Verify recorded fixtures preserve failed versus completed votes, retain existing stable identities and expose no numeric confidence field.
- [x] 3.4 Document the optional contract extensions and audit artifact format alongside the existing profile/finding/report documentation; verify examples validate against the corresponding schemas and preserved convergence keys remain accepted.

## 4. Apply tool boundaries and owner guidance

- [x] 4.1 Change the prerequisite runtime's read/search dispatch to use either complete selected repository snapshot with suggested_focus as a hint; retain graph hops/node limits and output/token limits. Verify tests read a callee outside focus in both versions and reject traversal, external absolute paths and escaping symlinks.
- [x] 4.2 Set correctness and verifier run defaults to enabled and other agent defaults to disabled, allow manifest overrides, and force every fork PR execution tool off after overrides. Verify permission-matrix tests and runner-dispatch tests prove fork commands are never submitted and allowed commands retain isolation/no-network settings.
- [x] 4.3 Make board reads/writes no-ops without shared-agent coordination, retaining separate hypothesis/vote audit persistence. Verify agent and voter independence tests and the deferred-board footer note.
- [x] 4.4 Consume the existing immutable `owner_guidance.json` producer from `crates/rio-engine/src/guidance.rs`; scope prompt data by focus ancestry and preserve hashes and original line coordinates. Verify root/nested/unrelated guidance fixtures and a working-tree mutation after capture.
- [x] 4.5 Inject guidance into generator and verifier prompts in escaped delimited data blocks and reuse the gateway's PR-description injection-pattern filter without changing tool permissions, budgets, suppressions or publishing. Verify malicious guidance and delimiter fixtures cannot alter capabilities and stripped lines do not shift subsequent citations.
- [x] 4.6 Add correctness prompt checks for `guidance/contradiction` and `guidance/stale` risk hypotheses and verifier checks for existing guidance lines and actual code behavior. Verify a contradiction, a stale command and an invalid citation flow through normal verification; document the two rule ids and guidance-as-data behavior in the runtime documentation.

## 5. Implement blind voter orchestration and quorum

- [x] 5.1 Replace the prerequisite single-verifier step with independent per-hypothesis voter fan-out using the resolved model; create isolated conversations without the generator's reasoning or other votes. Verify a fake gateway sees the configured number of voters and no cross-voter state.
- [x] 5.2 Implement the blind first turn from location, base/head symbol and direct callers, intent and scoped guidance, persist its answer, then disclose the hypothesis in turn two. Verify captured prompt tests show the hypothesis and its trigger/impact are absent until turn two and an empty blind answer is valid.
- [x] 5.3 Compute same/related/none from the existing normalized rule/trigger identity and symbol matching, persist the per-voter comparison, and preserve evidence when all blind matches are none. Verify fixtures for exact, same-symbol, unrelated and empty answers, including a reproduced result missed by every blind pass.
- [x] 5.4 Validate evidence references against actual runner jobs, selected versions and head graph paths; require artifact-backed protection or passing reproduction for refutation and assess regression/reachability/protections/contracts. Verify nonexistent executions, wrong-snapshot paths, missing guidance lines and unsupported consensus cannot establish proof, while legitimate base/head reproduction artifacts can.
- [x] 5.5 Implement highest-supported-level quorum with separate artifact-backed refutation support and split flags. Verify table-driven tests cover mixed positive levels, refutation majority, neither quorum, both quorums, disagreement across the refuted boundary, one voter and incomplete votes without reducing the configured quorum.
- [x] 5.6 Enforce the resolved per-voter, per-hypothesis allowance across both turns, derive one fifth when absent, and account for total review limits, cancellation, malformed output and exhausted votes. Verify fake-gateway budget tests and separate usage/cost ledger records; document the derivation, overrides and failure audit semantics.

## 6. Consume posture and presentation caps

- [x] 6.1 Add agent-only consolidation in `rio-core`/the runtime report assembly: verify first, apply category floor, then defect evidence/severity floors and the separate posture risk policy. Verify style and diagnostic audit drops, refuted omission, every posture row, balanced plausible risks despite a static-proven defect floor, and deterministic lint/type/coverage findings bypassing agent filters.
- [x] 6.2 Rank eligible agent findings by impact and evidence with documented stable tie-breaking, apply general defect and posture risk limits separately from the security pool, and apply suppressions without consuming presentation slots. Verify cap-boundary and ordering fixtures, independent security caps, uncapped thorough general risks, deterministic bypass and suppression-versus-held-back counts.
- [x] 6.3 Retain titles/counts of eligible held-back findings by pool, categories of dropped hypotheses, and verification limitations for reporting; evaluate security fail-policy matches independently of presentation caps. Verify held-back security cannot hide a policy failure and counts do not double-count suppressions or category drops; document the presentation/policy distinction.

## 7. Register the staged security step

- [x] 7.1 Add `modules/steps/security/module.yaml` as a non-local step with intent/checks/graph/owner_guidance inputs and hypotheses output, its validated options and a disabled base-profile entry. Verify registry/module-schema tests and base resolution snapshots, including explicit reporting when security is enabled before its agent/catalog are available.
- [x] 7.2 Wire independent security hypotheses into the same verifier and separate policy/presentation pool, without passing correctness hypotheses to security. Verify recorded security hypotheses use the shared quorum and that default thorough/plausible security policy remains effective under critical-only general posture.
- [x] 7.3 Evaluate enabled security fail_on in addition to profile fail_on for security findings, preserve general deterministic failure behavior and fork static-only restrictions, and connect step-specific triage using the prerequisite runtime scheduling interface. Verify either-policy failure, cap-hidden matches, sensitive-path scheduling and fork execution denial.
- [x] 7.4 Document v0.2 module/policy availability and the v0.3 agent/catalog gate, including supported catalog names and the future thorough security community profile. Verify the v0.2 base makes no security model calls and no unavailable capability is reported as a successful security review.

## 8. Produce triage risk and render report evidence

- [x] 8.1 Extend endpoint triage to derive tier/reasons from configured sensitive paths, public contracts, dependency changes, uncovered changed logic and fan-out using the prerequisite runtime's risk policy; reuse the existing Rust/JSON risk contract. Verify configured-threshold fixtures for all signals, stable results from identical inputs, and risk-driven agent/budget selection.
- [x] 8.2 Preserve `always_human` matching on old and new changed paths as a final high-risk override with source/reasons and require_human(). Verify low-risk triage cannot weaken the override and local no-endpoint behavior remains unchanged.
- [x] 8.3 Update terminal, Markdown and JSON rendering in `crates/rio-core/src/render.rs` and endpoint report assembly for separate security entries, quorum/blind/split summaries, held-back titles/counts, category-floor drops, fork limitations and verifier cost. Verify renderer fixtures, escaping/redaction, uncertain security labeling, no-confidence wording and unchanged deterministic output when no new data exists.
- [x] 8.4 Persist blind answers, individual votes and evidence references in the existing review audit storage with its redaction/access/atomic-write rules, and expose neutral risk status through the existing publisher if available. Verify replay/serialization and publication-adapter tests show no risk tier creates an approval or success conclusion; document evidence inspection, the cap recovery guidance and that SARIF output remains outside this change.

## 9. Integration and measured acceptance

- [x] 9.1 Run a recorded-gateway end-to-end review joining generators, independent security fixtures, blind voters, runner evidence, quorum, posture, risk rules and all report formats. Verify expected findings/policy outcomes and unchanged local deterministic review without an endpoint, including malformed votes, a cancellation and a fork PR.
- [ ] 9.2 Extend the existing `eval/` harness with a pinned verifier-versus-single-verifier comparison on the same reference cases, including known high-severity issues and clean controls, artifact-backed verdicts, blind-match buckets, verification tokens/cost and precision by evidence level. Verify harness tests pass, high-severity recall does not fall against the baseline, and the measured v0.2 precision meets the PRD's 80% gate; retain failures as evidence instead of claiming acceptance.
- [ ] 9.3 Run `cargo fmt --all --check`, `cargo clippy --workspace --all-targets --locked`, `cargo test --workspace --locked --no-fail-fast`, the prerequisite worker/runtime package's checks, `python3 -m unittest discover -s eval/tests -v`, generated-profile-reference verification and `openspec validate rio-v0-2-verifier --strict`. Verify the required CI matrix and integrated contract tests pass before marking implementation complete.

## Validation record (2026-11-06)

Implementation tasks 0.1–9.1 are complete (41/43 tasks). The full local Rust workspace run passed 275 tests across 47 suites with no failures or ignored tests. After the final remote-vote exit-policy and endpoint credential-isolation fixes, the five core policy tests and all 32 CLI/deployment/fixture tests passed again. Formatting and Clippy passed. All 74 Worker tests, six actual Docker runner/executor tests and 34 evaluation harness tests passed; generated contracts/profile reference, strict OpenSpec validation and deployment checks passed.

Native `rio deploy` created and reused account-local Cloudflare resources, upgraded the embedded Worker, ran forward migrations and registered the pinned runner image. A live OpenRouter review completed all three independent blind/disclosed votes with two artifact-backed static proofs; the unsupported third citation supplied no proof. Both Cloudflare Container graph/checks jobs succeeded. Missing Python tools and offline dependency checks remained explicitly incomplete. The smoke and provider-reported usage/cost are recorded separately from empirical acceptance in `docs/evaluation/v0.2-hosted-smoke.json`; see `docs/evaluation/v0.2-verifier-local.md` for commands, validation sequence and limitations.

The requested modern defaults are Sonnet 5.5 for generation and GPT-6.1 Sol for verification through OpenRouter/AI Gateway, also pinned in the deployed user's profile. All 15 affected profile tests and six deployment tests passed. The final hosted smoke completed all three voters with artifact-backed reproduced evidence: each recorded a passing base and failing head execution, and the CLI returned exit 1. Its report and usage are pinned in `docs/evaluation/v0.2-hosted-modern-smoke.json`; the preceding bounded-budget failure is retained separately.

Task 9.2 remains open for pinned live-model comparisons and independent adjudication. Task 9.3 remains open for the hosted macOS/Windows/Linux CI matrix: its local checks passed, but no branch was pushed and hosted checks were not run in this workspace. This change is not ready for archival or empirical release acceptance.

## Workflow follow-up

- Archive this change only after its implementation, integration checks and measured acceptance are complete; do not synchronize its proposed runtime behavior into main specs during this planning workflow.
- With the v0.3 security agent and catalog change, activate security execution and its thorough community profile against the already-tested verifier/policy interfaces; retain the disabled v0.2 default until then.

## Archive note (2026-11-06)

Archived at the owner's request with tasks 9.2 and 9.3 still open. Both moved to `rio-v0-2-review-convergence`, which now owns the measured precision/recall acceptance and the hosted CI matrix for v0.2. Delta specs were synced into the main specs at archive time.

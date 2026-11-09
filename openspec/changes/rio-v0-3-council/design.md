## Context

With the verifier quorum in place, the remaining uncertainty is concentrated in a small set of findings: `plausible` and severe, split verdicts, high-risk changes. These are also the findings where a wrong call costs the most in either direction. A second opinion from the same model family is correlated with the first; the council buys decorrelation by drawing members from different families and vendors, isolates them from each other during assessment, and keeps the final decision in deterministic code that only counts evidence. The design is deliberately expensive per finding and deliberately rare.

Constraints:

- Every v1 contract is extended, never changed: profile-v1 `council`, module-v1 `member`, finding-v1 `council`, report-v1 metrics, plus a new assessment schema.
- Evidence rules from v0.1 hold: no numeric confidence anywhere; agreement is not evidence; `plausible` renders as a risk, not a defect.
- Repository content is data. Member prompts receive the evidence pack in delimited blocks; a member cannot call tools.
- Data leaves the account only to configured providers (TRD security model), so vendors must be explicitly allowlisted per repository.

## Goals / Non-Goals

**Goals:**

- On the `plausible` bucket of the reference set, the council promotes or refutes more findings correctly than the verifier alone, at a known cost per finding.
- No vendor outage, rate limit or slow member can block or fail a review.
- A repository owner can see exactly which content was sent to which vendor, and can run the council entirely on self-hosted members.

**Non-Goals:**

- Replacing the verifier; the council only runs on what the verifier leaves unsettled.
- Letting members talk freely; round 2 is structured by design.
- Learning weights online during a review; weights come from the eval set and are re-estimated offline.

## Decisions

### D1. Trigger evaluation and sampling

`rio/council` is a step with `needs: [verify]` and `rules`. The rule language gains predicates `evidence == <level>`, `severity >= <level>` (on the finding severity scale `info` < `warning` < `error`; Rio findings have no `high` severity), `verify.split`, `risk_tier == <tier>`, `mode == fast|deep`, `nightly` (true when the review was started by the nightly eval job). Council rules carry only `when` (they select, they do not act). A finding is selected when any rule matches; the default rule set in the `security` and `critical` profiles is the five triggers from the proposal. A per-review cap `council.max_findings` (default 5) selects by impact × evidence when more match, and the footer says how many were not councilled. Rationale: the step must stay rare; the cap bounds cost even on a bad day.

### D2. Member modules

Kind `member` in module-v1: `provider`, `model`, `prompt` (path), `context_pack`, `role`, `weight` (initial, overwritten by learned weights when present), `vendor` (derived from `provider` for the allowlist and audit), `family` (model family for the author rule), `self_hosted: bool`. Five built-in members ship under `modules/members/`: `skeptic` (`diff-only`, argues the finding is wrong), `exploit-author` (`execution`, tries to write the failing input), `code-owner` (`graph-heavy`, asks what the surrounding code assumes), `maintainer` (`graph-heavy`, asks whether the change introduced it), `tester` (`execution`, asks what test would prove it). Providers and models are placeholders in `rio/base` and filled by `rio init` from the allowlist; validation rejects a council whose members span fewer than three families.

The allowlist is a list of entries `{ vendor, family, model }`, where `model` is the gateway route (`provider/model`, as in `models`). `rio init` writes it to `config.toml` (`[[deployment.council_vendors]]`) and to the endpoint as the Worker variable `COUNCIL_VENDORS` (a JSON list for every repository, or an object keyed by repository with `"*"` as the fallback). When the CLI resolves a profile, placeholder members are filled from the entries in `config.toml`, assigning entries in turn so that the members spread across families; a member whose profile sets `provider`, `model` and `family` keeps them, and its route is `provider/model`. The resolved member carries its `route` for the gateway. When PR metadata identifies the author as an agent of family F, at most one member of family F participates; the others are substituted from the allowlist or the council runs partial. A substitute keeps the replaced member's role, prompt and context pack and is served by an allowlist entry of another family, preferring a family not yet in the council. The author's family is read from the PR's agent attribution (`claude` for Claude; `gpt` for Codex, OpenAI and ChatGPT agents; `gemini` for Gemini and Jules); any other attribution, or none, makes the rule not applicable.

### D3. Evidence pack and context packs

The pack is built once per finding and content-addressed: hypothesis (without the generating agent's reasoning), graph slice (base, head, delta restricted to `hops`), base and head of each affected file, the verifier's artifacts (reproductions, test output, blind-match summary without voter identities), intent artifact, owner guidance in scope. `context_pack` selects the rendering: `diff-only` gives the hunks and the affected symbols; `graph-heavy` adds callers and callees to `hops`; `execution` adds the verifier's runnable artifacts and the project's test command. Every member receives the same underlying pack, so a disagreement is about judgment, not about information. Execution output (verifier runs and council experiments) is shared as the command, its exit outcome and a job reference, never as text: a command can print files the pack otherwise leaves out, so output stays in storage under the evidence retention. Members have no tools; the pack is all they get.

### D4. Experiments

A member may include one `experiment_request: { command, version: base | head | both, expect: fails | passes | output_contains }` in its round-1 assessment. Rio deduplicates requests by normalized command and version, selects up to `council.max_experiments` (default 2) by member weight, runs them as runner jobs under the same isolation as verifier reproductions, and attaches `{ request, exit_code, output_ref, version }` to the pack for round 2. An experiment is evidence only through the aggregator's tier rule (D7); members cannot claim its result without the artifact reference.

### D5. Assessment schema

`schemas/council-assessment-v1.json`: `member` (role, not identity), `round`, `real: yes | no | unknown`, `introduced_by_change: yes | no | unknown`, `impact: string`, `basis: reproduction | static_path | protection_found | contract | none`, `evidence_refs: [artifact id]` (non-empty required), `experiment_request` (round 1, optional), and for round 2: `changed_from`, `changed_to`, `cites: { kind: artifact | assessment, ref, reason_code: new_artifact | missing_protection | wrong_path | wrong_version | contract_misread }`. The Worker validates every assessment; a failure, an empty `evidence_refs`, or a timeout is an abstention recorded as such. Free prose is limited to `impact`, which is shown to humans and never parsed.

### D6. Round 2

Members receive the other round-1 assessments with roles replaced by letters and the experiment results. A member may keep its position (no fields) or change it, in which case `cites` is required and must reference an existing artifact id or assessment letter; a change without a valid citation is ignored and the round-1 position stands. `max_rounds: 2` is a hard maximum in the schema. Rationale: one structured exchange captures the "I missed this guard" corrections that matter; more rounds converge to the loudest member.

### D7. Deterministic aggregator

Code in `worker/`, no model call. Inputs: validated assessments with member weights, experiment results, verifier artifacts. Rules, in order:

1. An experiment with `version: both` that fails on head and passes on base, or an `expect: fails` experiment on head that failed and the same command passing on base → decision `reproduced`, artifact attached.
2. Assessments with `basis: protection_found` and `real: no` from members holding at least half of the answering weight, one of whose `evidence_refs` points at head code that the graph confirms is on the path from the hypothesis's trigger to its location → decision `refuted`, citing the protection. The weight floor exists because the path check cannot show that the cited code stops the defect (the location's own symbol is always on the path), so a single member cannot close a finding. "On the path" means every call path into every site of the finding (each occurrence of a class finding) in the head graph slice passes through it: the location's own symbol, or a caller such that no entry of the slice (a function or recursive cycle that nothing else in the slice calls, judged with the guard included) reaches a site without passing it. Only call edges count. A guard on one of several callers, a slice missing a site, or (for a caller guard) a slice that dropped nodes never refutes. A councilled finding that presentation floors or caps keep out of the findings lists is listed in the report's `council.held` with its council result, so the council never changes `fail_on` except through evidence.
3. Otherwise the decision is `plausible` with a council note. A `plausible` decision leaves the verifier's evidence level unchanged: a finding the verifier proved statically and that a non-evidence trigger (`risk_tier`, `mode`, `nightly`) selected stays `static_proven`, because the council never lowers evidence it did not refute. The note gives weighted shares of `real` and `introduced_by_change` by basis, the dissenting bases, and experiments run. The note is for human judgment and uses words, never percentages.

Weights are per member and category, estimated offline from the eval set as the member's precision and recall on councilled cases with known outcomes, and re-estimated from feedback (`author_response`) monthly; they order experiment selection and the note's presentation, and they never promote a finding by themselves. Agreement count is never evidence: five members saying `real: yes` with `basis: none` leaves the decision `plausible`.

### D8. Degradation and timeouts

The step's wall budget is `council.timeout` (default 90 s) per councilled finding, shared by its two rounds (round 2 gets what round 1 left; experiment run time is bounded by the runner's own limits and not counted) and never past the review's wall budget less a 60-second reserve for the steps after the council (report, registry, publication), which also bounds experiment waits. Members answering after the timeout are abstentions. If fewer than `min_members` (default 3) answered round 1, the step records `council: partial (n/5)` and skips round 2 unless at least `min_members` remain; if fewer than `min_members` answered at all, the step records `council: skipped (n/5)` and the finding keeps its verifier result. The review never fails or waits on a vendor; vendor errors are logged per member with the provider's error class.

### D9. Governance and audit

`council.vendors_allowed` (profile, default `[]`) and the repository's council allowlist (`COUNCIL_VENDORS` on the endpoint, set by `rio init`) must both permit a member's vendor; otherwise the member is excluded before the pack is built. The Worker does not trust the submitted labels: a member's vendor is the provider its call goes to, and its route (`provider/model`, or the allowlist entry that filled it) must be exactly an allowlist entry of that vendor. Council roles are distinct. Retention covers the council's runner jobs (experiments and self-hosted calls) as well as its packs, assessments and recorded responses. The built-in `security` and `critical` profiles allow the vendors Rio knows (`anthropic`, `openai`, `google`, `mistral`, `xai`, `deepseek`, and `openrouter`, which forwards a pack to the vendor serving each model), so the repository allowlist, empty by default, is the opt-in; a custom profile keeps the empty default until its author lists vendors. `self_hosted: true` members run through the self-hosted runner's model endpoint (an OpenAI-compatible server the runner advertises in its capabilities), so a repository can run the whole council in its own account. The audit record `reviews/<id>/council/audit.json` lists, per finding and member, the vendor, the model, the pack content hashes and byte sizes, and the timestamp; the D1 table `council_assessments` holds the same per row for queries. `rio init` adds an opt-in step after the primary provider: choose vendors, store keys as Worker secrets, and write the allowlist.

### D10. Evaluation and the keep-or-remove rule

`eval/` adds: disagreement rate (share of councilled cases where members differ on `real` or `introduced_by_change` after round 1), promotion and refutation accuracy on the `plausible` bucket (council decision versus known outcome) compared with the verifier-only decision on the same cases (A/B, same cases, same day), cost per councilled finding, and the learned weights with sample sizes. The rule is written into the release checklist: if disagreement is below 5 % over a release cycle, or accuracy does not exceed the verifier-only baseline, the step is removed from the default `security` and `critical` profiles.

## Risks / Trade-offs

- [Evidence packs reach several external vendors] → per-repo allowlist checked twice, audit record per pack, self-hosted members, opt-in at `rio init`, and the step is off in `rio/base`.
- [Members from different vendors receive different tokenizations of the same pack and disagree for trivial reasons] → identical pack bytes, roles not identities in round 2, structured fields; the disagreement metric distinguishes basis disagreement from wording.
- [Learned weights overfit a small eval set] → weights only order experiments and the note; sample sizes are shown; a weight with fewer than 30 cases falls back to the manifest's initial weight.
- [An agent author's model family dominates the council] → the author-family rule limits it to one member; when PR metadata is missing the rule cannot apply and the report says so.
- [Experiments execute member-proposed commands] → same runner isolation as verifier reproductions, no network, bounded by `max_experiments`, requests deduplicated and selected by weight, output is evidence only through D7.
- [Cost surprises] → trigger cap per review, `max_experiments`, `max_rounds: 2`, cost per finding in the footer and in `eval/`.
- [The council becomes a rubber stamp and nobody notices] → the disagreement metric and the A/B rule remove it; this is a release-checklist item, not a judgment call.

## Migration Plan

Additive. profile-v1 `council`, module-v1 `member`, finding-v1 `council` and report-v1 metrics are optional; `rio/base` does not enable the step. D1 migration adds `council_assessments`. The `security` and `critical` profiles are updated to include the step with the five built-in members and placeholder providers, which `rio profile validate` reports as unconfigured until `rio init` fills the allowlist.

## Open Questions

- Whether `reproduced` from a council experiment should be marked distinctly from `reproduced` by the verifier in the report (same evidence level, different source), for calibration tracking.
- How to detect the PR author's model family when PR metadata carries no agent attribution (commit trailers, bot accounts, or not at all).
- Whether the `exploit-author` role should be excluded on fork PRs, where the evidence pack must not include runnable artifacts.

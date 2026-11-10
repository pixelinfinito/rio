# Spec Delta

## Purpose

Settle the findings the verifier leaves unsettled by asking several independent members from different model families to assess the same evidence, run a bounded number of experiments, and decide deterministically from evidence tiers rather than agreement.

## ADDED Requirements

### Requirement: Step placement and trigger selection
`rio/council` SHALL be a non-local step that runs after `rio/verify` and before `rio/report`, and SHALL select a verified finding when any of the step's trigger rules matches it. The `security` and `critical` built-in profiles SHALL carry the default triggers `evidence == plausible and severity >= error`, `verify.split`, `risk_tier == high`, `mode == deep` and `nightly`. `rio/base` SHALL NOT enable the step.

#### Scenario: Plausible error-severity finding is selected
- **WHEN** a review under the `security` profile verifies a hypothesis at `plausible` with severity `error` and no other trigger applies
- **THEN** the finding is councilled and the plan records the matching rule

#### Scenario: Base profile never councils
- **WHEN** a review under `rio/base` produces a `verify.split` finding
- **THEN** no council step runs and the report carries no council section

### Requirement: Per-review cap
The step SHALL council at most `max_findings` (default 5) findings per review, chosen by impact and evidence strength with stable ordering among equals, and the footer SHALL state how many selected findings were not councilled because of the cap.

#### Scenario: More matches than the cap
- **WHEN** seven findings match the triggers and `max_findings` is 5
- **THEN** the five highest-ranked findings are councilled and the footer states that two selected findings were not councilled

### Requirement: Identical content-addressed evidence pack
For each councilled finding the step SHALL build one evidence pack, addressed by its content hash, containing the hypothesis without the generating agent's reasoning, the graph slice of base, head and delta within `hops`, the base and head text of every affected file, the verifier's artifacts with a blind-match summary that omits voter identities, the intent artifact and the owner guidance in scope. Every member SHALL receive the same pack bytes.

#### Scenario: Members receive the same pack
- **WHEN** five members assess one finding
- **THEN** the audit records the same pack content hash for every member and no member receives the generating agent's reasoning

### Requirement: Members have no tools
A member SHALL receive only its rendering of the evidence pack and SHALL have no tool calls available; any tool call or request for additional content in a member's output SHALL be ignored and recorded.

#### Scenario: Member asks to read a file
- **WHEN** a member's output requests the content of a file outside the pack
- **THEN** the request is not served, the assessment is evaluated as returned, and the audit notes the ignored request

### Requirement: Context pack renderings
A member's `context_pack` SHALL select the rendering of the shared pack: `diff-only` gives the hunks and the affected symbols; `graph-heavy` adds callers and callees within `hops`; `execution` adds the verifier's runnable artifacts and the project's test command. Renderings SHALL add nothing absent from the pack.

#### Scenario: Diff-only member sees no callers
- **WHEN** a `diff-only` member and a `graph-heavy` member assess the same finding
- **THEN** the `graph-heavy` rendering lists the callers from the pack's graph slice and the `diff-only` rendering does not, while both reference the same pack hash

### Requirement: Experiment requests
A member MAY include one structured experiment request (`command`, `version` of `base`, `head` or `both`, and an expectation) in its round-1 assessment. The step SHALL deduplicate requests by normalized command and version, run at most `max_experiments` (default 2) selected by member weight, execute them under the verifier's runner isolation with no network, and share each result (request, exit code, output reference, version) with every member in round 2.

#### Scenario: Duplicate requests run once
- **WHEN** three members request the same test command on `both` versions and `max_experiments` is 2
- **THEN** that experiment runs once, one further distinct request may run, and round 2 shows the results to all members

#### Scenario: Fork review runs no experiments
- **WHEN** a councilled finding belongs to a fork pull request
- **THEN** no experiment runs, every request is recorded as not run with reason fork, and the council proceeds without experiment evidence

### Requirement: Structured second round
With `max_rounds` 2, round 2 SHALL show each member the other round-1 assessments with roles replaced by letters plus the experiment results. A member SHALL change position only by citing an existing artifact id or assessment letter with a reason code; a change without a valid citation SHALL be ignored and the round-1 position SHALL stand. `max_rounds` SHALL NOT exceed 2.

#### Scenario: Change with a valid citation
- **WHEN** a member changes `real` from yes to no citing an experiment artifact that passed on head
- **THEN** the round-2 position is recorded with the citation

#### Scenario: Change without citation is ignored
- **WHEN** a member changes position in round 2 with no citation
- **THEN** the aggregator uses the member's round-1 position and the audit notes the ignored change

#### Scenario: Third round rejected
- **WHEN** a profile sets `council.max_rounds: 3`
- **THEN** validation rejects the value at its location

### Requirement: Deterministic aggregation by evidence tier
The decision SHALL be computed without a model call, applying these rules in order: an experiment failing on head and passing on base decides `reproduced` with the artifact attached; assessments with basis `protection_found` and `real: no`, held by members with at least half of the answering weight, citing head code that the graph places on the trigger-to-location path decide `refuted` citing the protection; otherwise the decision is `plausible` with a council note.

#### Scenario: Experiment reproduces the defect
- **WHEN** an experiment on `both` versions fails on head and passes on base
- **THEN** the finding's evidence level becomes `reproduced` with the experiment artifact referenced

#### Scenario: Protection found on the path
- **WHEN** members holding at least half of the answering weight answer `real: no` with basis `protection_found` and one of them cites a guard in head that the graph places between the trigger and the location
- **THEN** the finding is `refuted` citing that guard

#### Scenario: A lone protection claim does not refute
- **WHEN** one member of five with equal weights cites the finding's own symbol as `protection_found`
- **THEN** the decision is `plausible`, because the path check cannot show that the cited code stops the defect

### Requirement: Agreement is never evidence
Agreement SHALL NOT decide a council decision by itself: no number of agreeing members reproduces a finding or raises its evidence level, and a refutation additionally needs an on-path protection citation. Assessments with basis `none` SHALL NOT raise the evidence level. The council note SHALL describe weighted positions by basis and dissent in words and SHALL NOT contain percentages or confidence scores.

#### Scenario: Unanimous without basis stays plausible
- **WHEN** five members answer `real: yes` with basis `none`
- **THEN** the decision is `plausible` and the note reports that no member cited evidence

### Requirement: Decision stays within the verifier's category
A council decision SHALL change only the finding's evidence level and the `council` block. It SHALL NOT upgrade the category (a risk remains a risk), and SHALL affect `fail_on` evaluation only through the evidence level it sets.

#### Scenario: Reproduced risk stays a risk
- **WHEN** a hypothesis the verifier classified as `risk` is councilled and an experiment reproduces it
- **THEN** the entry is rendered in the risks section with evidence `reproduced` and is not promoted to a defect

### Requirement: Degradation and timeouts
The step SHALL wait at most `timeout` (default 90 s) within the review budget; members answering later, failing validation or returning an assessment without evidence references SHALL count as abstentions. With fewer than `min_members` (default 3) round-1 answers the step SHALL record `council: skipped (n/5)` and keep the verifier result; with at least `min_members` but fewer than all it SHALL record `council: partial (n/5)`. The review SHALL never fail or block on a member or vendor.

#### Scenario: Two vendors time out
- **WHEN** three of five members answer round 1 within the timeout
- **THEN** the council proceeds as `partial (3/5)` and the review completes

#### Scenario: Only one member answers
- **WHEN** one member answers and four abstain
- **THEN** the step records `skipped (1/5)`, the finding keeps its verifier evidence level, and the review status is unaffected

### Requirement: Council section and cost
Every format SHALL present, for each councilled finding, the decision, the evidence tier, the participating members by role, the experiments run with their outcomes, the council note and the partial or skipped marker. The footer SHALL show council cost per finding as members × rounds × experiments together with tokens and runner seconds, and the total council cost for the review.

#### Scenario: Councilled finding in the report
- **WHEN** a finding is councilled as `partial (4/5)` with one experiment
- **THEN** the report shows its decision, tier, four roles, the experiment outcome, the note and the partial marker, and the footer shows its cost

#### Scenario: JSON carries the council block
- **WHEN** the report is rendered as JSON
- **THEN** each councilled finding carries a `council` object with decision, tier, members, experiments and note, and absent findings carry none

# Spec Delta

## Purpose

Measure whether the council adds information over the verifier alone, learn member weights from known outcomes, and remove the step when the measurements say it adds nothing.

## ADDED Requirements

### Requirement: Disagreement rate
Evaluation SHALL compute the council disagreement rate as the share of councilled cases in which members differ on `real` or `introduced_by_change` after round 1, and SHALL report separately the share whose members differ in `basis`, so that disagreement in judgment is distinguishable from disagreement in wording.

#### Scenario: Members agree on wording but not basis
- **WHEN** five members answer `real: yes` with bases `reproduction`, `static_path` and `none`
- **THEN** the case counts as agreement on `real` and as a basis disagreement

#### Scenario: Split on real
- **WHEN** three members answer `real: yes` and two answer `real: no` after round 1
- **THEN** the case counts toward the disagreement rate

### Requirement: Accuracy on the plausible bucket
Evaluation SHALL compute promotion and refutation accuracy on `plausible` findings with known outcomes: the share of council decisions (`reproduced`, `refuted`, `plausible`) that match the outcome, compared with the verifier-only decision on the same cases from the same day. Both arms SHALL be reported with their case counts.

#### Scenario: A/B on the same cases
- **WHEN** forty plausible cases with known outcomes are run through both arms on one day
- **THEN** the summary reports council and verifier-only accuracy on those forty cases and their difference

#### Scenario: Different case sets rejected
- **WHEN** the two arms were run on different case sets
- **THEN** the harness refuses to compute the comparison and names the mismatch

### Requirement: Cost per councilled finding
Evaluation SHALL report cost per councilled finding as members × rounds × experiments, model tokens per vendor and runner seconds, with the per-review total, so cost is comparable across releases.

#### Scenario: Cost summary
- **WHEN** a review councils two findings with five members, two rounds and one experiment each
- **THEN** the summary records 5 × 2 × 1 per finding, the tokens per vendor and the runner seconds

### Requirement: Offline weight estimation
Member weights SHALL be estimated offline per member and category from precision and recall on councilled cases with known outcomes and re-estimated monthly from author responses; each weight SHALL carry its sample size. A weight with fewer than 30 cases SHALL fall back to the manifest's initial weight. Weights SHALL order experiment selection and the council note only and SHALL never promote or refute a finding.

#### Scenario: Small sample uses manifest weight
- **WHEN** a member has 12 councilled security cases with known outcomes
- **THEN** its security weight is the manifest's initial weight and the summary shows the sample size 12

#### Scenario: Weights cannot promote
- **WHEN** the highest-weighted member answers `real: yes` with basis `none` and no experiment reproduces the finding
- **THEN** the decision stays `plausible`

### Requirement: Keep-or-remove rule
The release checklist SHALL require that over the release cycle the council disagreement rate is at least 5 % and the council's accuracy on the `plausible` bucket exceeds the verifier-only baseline; when either condition fails, the step SHALL be removed from the default `security` and `critical` profiles in that release.

#### Scenario: Council agrees too often
- **WHEN** the release cycle's disagreement rate is 3 %
- **THEN** the checklist item fails and names the removal of the step from both profiles

#### Scenario: Council beats the baseline
- **WHEN** disagreement is 11 % and council accuracy exceeds verifier-only accuracy on the same cases
- **THEN** the checklist item passes and the step stays enabled

### Requirement: Summary document
Council evaluation SHALL write one summary document per run containing the case set identifier, run date, disagreement rate with its basis split, both arms' accuracy with case counts, cost per finding and totals, and the weights with sample sizes, validated against a published schema; an invalid or incomplete summary SHALL fail the run.

#### Scenario: Missing arm fails validation
- **WHEN** a summary omits the verifier-only accuracy
- **THEN** schema validation fails and the run is reported as failed

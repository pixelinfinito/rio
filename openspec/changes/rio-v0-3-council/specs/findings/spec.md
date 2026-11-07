# Spec Delta

## ADDED Requirements

### Requirement: Council block
A finding reviewed by the council SHALL carry an optional `council` object with `decision` (`reproduced`, `refuted` or `plausible`), `tier` (`experiment`, `protection` or `judgment`), `members` (roles with an `abstained` flag each), `experiments` (request, version, exit outcome and artifact reference), `note`, and `partial` with answered and total counts. Findings the council did not review SHALL omit the block. The block SHALL never carry a numeric confidence.

#### Scenario: Existing finding without council stays valid
- **WHEN** a deterministic or v0.2 finding omits `council`
- **THEN** it remains valid against finding-v1 and no council fields are synthesized

#### Scenario: Experiment decision is distinguishable
- **WHEN** the council promotes a finding because an experiment failed on head and passed on base
- **THEN** the finding's `council.decision` is `reproduced`, `council.tier` is `experiment`, and the experiment's artifact reference is listed under `council.experiments`

#### Scenario: Partial council recorded
- **WHEN** only three of five members answered within the timeout
- **THEN** `council.partial` is true with answered three and total five, and the two silent members are listed with `abstained: true`

#### Scenario: Numeric confidence rejected
- **WHEN** a council block contains a `confidence` number
- **THEN** contract validation rejects the finding

### Requirement: Council refutation closes the finding
A `council.decision` of `refuted` SHALL remove the finding from open findings in the same way as a verifier refutation, citing the protection found. A `plausible` decision SHALL leave the finding a risk with the council note for human judgment.

#### Scenario: Protection found
- **WHEN** the council decides `refuted` with `tier: protection`
- **THEN** the finding is not an open finding and the report records the cited protection

#### Scenario: Judgment stays a risk
- **WHEN** the council decides `plausible` with `tier: judgment`
- **THEN** the finding remains rendered as a risk and its `council.note` is shown

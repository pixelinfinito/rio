# Spec Delta

## MODIFIED Requirements

### Requirement: Security triage and execution
The security step SHALL support its own triage rules and use its own resolved policy when scheduled. Its execution tools SHALL use the existing isolated runner and SHALL remain disabled on fork PRs. Triage SHALL NOT bypass verification and SHALL NOT enable a catalog the profile does not resolve.

#### Scenario: Sensitive-path scheduling
- **WHEN** a sensitive-path triage rule enables an available security step
- **THEN** the plan records that rule and the step runs with its security policy before verification

#### Scenario: Fork security review
- **WHEN** security review is enabled for a fork PR
- **THEN** it can perform static inspection but cannot execute commands

#### Scenario: Triage cannot pick an unknown catalog
- **WHEN** a triage rule's action names a catalog that is not `owasp-top10-2025` or `asvs-5.0`
- **THEN** profile validation rejects the rule and the step keeps the profile's resolved catalog

### Requirement: Staged security availability
In v0.3, the security agent and the `owasp-top10-2025` and `asvs-5.0` catalogs SHALL be available. `rio/base` SHALL still carry the step disabled. An enabled step SHALL run the security agent with the resolved catalog through the shared verifier and SHALL NOT produce an unavailability note. The `rio/security` community profile SHALL enable it with `posture: thorough`. A run that could not assess every applicable catalog item SHALL report those items rather than claim a clean security review.

#### Scenario: v0.2 base profile
- **WHEN** the base profile is resolved or reviewed
- **THEN** its security step is disabled and produces no security model calls

#### Scenario: Security implementation unavailable
- **WHEN** a profile enables security with the default catalog on a v0.3 endpoint
- **THEN** the security agent runs with `owasp-top10-2025`, its hypotheses go through the verifier, and the report contains no note that security was unavailable

#### Scenario: v0.3 community profile
- **WHEN** the `rio/security` community profile is selected
- **THEN** security runs with thorough posture, the `asvs-5.0` catalog and the shared verifier

#### Scenario: Unassessed items reported
- **WHEN** the agent's budget ends before every applicable catalog item was assessed
- **THEN** the security section lists the unassessed items with reason `budget` and the review is not labeled a passed security review

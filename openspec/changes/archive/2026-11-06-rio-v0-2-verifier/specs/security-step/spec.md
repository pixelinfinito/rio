## Purpose

Give security review its own configurable step and policy while using the shared evidence verifier and keeping its findings distinct from general correctness review.

## ADDED Requirements

### Requirement: Separate security step
`rio/security` SHALL be a non-local step consuming intent, checks, graph and owner guidance and producing security hypotheses. It SHALL be configured separately from the agents step. Its hypotheses SHALL use category `security` and pass through the same verifier quorum before reporting.

#### Scenario: Security hypothesis verified
- **WHEN** an enabled security step identifies a possible injection path
- **THEN** it emits a `security` hypothesis for the shared verifier rather than publishing a finding directly

### Requirement: Independent security posture
The step SHALL accept `posture`, `fail_on`, `max_defects` and `catalog` options. Posture SHALL default to `thorough` and the fail policy's evidence threshold to `plausible`. Catalog SHALL accept only `owasp-top10-2025` or `asvs-5.0`. Security posture and caps SHALL apply only to the security pool, independently of the general posture and cap.

#### Scenario: Strict general review retains plausible security risks
- **WHEN** general posture is `critical-only` and security posture is `thorough`
- **THEN** a verified plausible security risk remains eligible for the security section and is not filtered by the general evidence floor

#### Scenario: Independent caps
- **WHEN** the general cap is three and the security cap is five
- **THEN** retaining five eligible security findings does not consume the three general defect slots

#### Scenario: Unknown catalog rejected
- **WHEN** a security step sets `catalog: custom`
- **THEN** profile validation rejects the value at the security option's location

### Requirement: Additional security fail policy
The review SHALL fail when either the profile-level fail policy or the enabled security step's fail policy matches an eligible verified finding. The security policy SHALL match only security findings and SHALL NOT be weakened by the general posture. Presentation caps SHALL NOT conceal a security policy match.

#### Scenario: Security failure without general failure
- **WHEN** a new plausible security finding matches the security fail policy but the profile policy requires a static-proven defect
- **THEN** the review fails and identifies the security policy match

#### Scenario: General failure without security failure
- **WHEN** a deterministic defect matches the profile policy and no security finding matches the security policy
- **THEN** the review still fails under the profile policy

### Requirement: Security triage and execution
The security step SHALL support its own triage rules and use its own resolved policy when scheduled. Its execution tools SHALL use the existing isolated runner and SHALL remain disabled on fork PRs. Triage SHALL NOT bypass verification or enable unavailable security agents or catalogs.

#### Scenario: Sensitive-path scheduling
- **WHEN** a sensitive-path triage rule enables an available security step
- **THEN** the plan records that rule and the step runs with its security policy before verification

#### Scenario: Fork security review
- **WHEN** security review is enabled for a fork PR
- **THEN** it can perform static inspection but cannot execute commands

### Requirement: Staged security availability
In v0.2, the security module and its options SHALL resolve and validate, and `rio/base` SHALL carry it disabled. Execution SHALL become available only with the v0.3 security agent and catalog. The security community profile SHALL enable it with `posture: thorough` when those prerequisites are available. Unavailable execution SHALL be reported explicitly rather than represented as a clean security review.

#### Scenario: v0.2 base profile
- **WHEN** the v0.2 base profile is resolved or reviewed
- **THEN** its security step is disabled and produces no security model calls

#### Scenario: Security implementation unavailable
- **WHEN** a profile explicitly enables security before the required agent and catalog are available
- **THEN** the run reports the unavailable capability and does not claim security review passed

#### Scenario: v0.3 community profile
- **WHEN** the security agent and catalog are available and the security community profile is selected
- **THEN** security runs with thorough posture and the shared verifier

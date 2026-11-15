# Steps, rules and adapters

Profile steps form a validated dependency graph. Third-party module loading is not supported. Use the installed built-ins and validate before running project tools or hosted models.

## pipeline
prepare selects/snapshots/excludes files; checks runs deterministic tools; graph builds bounded impact; triage routes risk; agents propose hypotheses; security applies catalogs; qa exercises browser journeys; verify independently tests hypotheses; council adds opt-in independent evidence assessment; report applies policy and renders. Each step has id, uses, needs, optional parallel/with/rules/agents according to its schema. Lists replace inherited lists.
Default graph bounds: hops 2, max_nodes 2000. rio/checks options include typecheck, lint, secrets, coverage, dependencies, baseline and trust_installed_dependencies. Enable/disable under that step's with; preserve prepare/report and valid dependencies. rio/agents cache:false disables hypothesis reuse; parts (1-8) reviews a change longer than one prompt in that many uncached parts. An agent declaration takes model: ALIAS or models: [up to four aliases]; it reviews under each, combines results before verification, and skips undefined aliases. rio/prepare omit removes paths from the snapshot; exclude only keeps them out of the reviewed change.

## tools
TypeScript: tsc, ESLint, Vitest/Jest. Python: Pyright/mypy, Ruff, pytest/coverage.py. Rust: cargo check, configured Clippy/rustfmt, optional cargo llvm-cov. Project-local executables precede PATH. Install project dependencies first. Workspaces schedule affected roots/dependents; checks compare head/base where compatible. Known lockfile/install mismatch cannot be overridden by trust_installed_dependencies.

## rules
Rules and module manifests constrain allowed predicates, effects and options. Use built-in profile examples and the generated Wiki module/schema reference for long inventories; validate every edit with rio profile validate. Typical triggers route high-risk paths, evidence/severity, verifier split, deep/nightly modes; do not assume arbitrary expressions are supported. General fail_on and security policy determine gating, not raw count of agent opinions. For exact installed options, inspect rio profile show and module reference topics.

<!-- schema-options:start -->
## option-fields
rio/agents@0.1.0:
cache: boolean; default=true
parts: integer; default=1; minimum=1; maximum=8

rio/checks@0.1.0:
typecheck: boolean; default=true
lint: boolean; default=true
secrets: boolean; default=true
coverage: boolean; default=true
dependencies: boolean; default=true
baseline: boolean; default=true
trust_installed_dependencies: boolean; default=false

rio/graph@0.1.0:
hops: integer; default=2; minimum=0
max_nodes: integer; default=2000; minimum=1

rio/prepare@0.1.0:
exclude: array; default=[]
exclude[]: string
omit: array; default=[]
omit[]: string

rio/report@0.1.0:
class_threshold: integer; default=3; minimum=1
proposal_threshold: integer; default=3; minimum=1

rio/triage@0.1.0:
sensitive_paths: array; default=[]
sensitive_paths[]: string
public_contracts: boolean; default=true
dependency_changes: boolean; default=true
missing_coverage: boolean; default=true
fan_out_high: integer; default=20; minimum=1

## schema-topics
Read one exact schema topic: profile-fields-1, profile-fields-2, qa-config-fields-1, qa-journey-fields-1, qa-seed-fields-1, qa-fixtures-fields-1, qa-config-fields-2.

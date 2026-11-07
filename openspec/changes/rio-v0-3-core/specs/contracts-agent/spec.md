# Spec Delta

## Purpose

Find changes that break the consumers of a public contract: exported signatures, routes, schemas, migrations, serialized formats, command-line flags, environment variables and configuration keys.

## ADDED Requirements

### Requirement: Contract inventory
Before the contracts agent runs, the review SHALL compute a deterministic inventory of contracts changed between base and head: graph nodes of kind endpoint, table, event and config, and exported symbols under adapter-defined visibility (TypeScript `export`; Python names without a leading underscore at module scope or in `__all__`; Rust `pub` items reachable from the crate root). Each entry SHALL list its consumers within `hops` in both versions.

#### Scenario: Removed export with consumers
- **WHEN** head removes an exported TypeScript function that two files import in base
- **THEN** the inventory lists the function as removed with both consumers at their base locations

#### Scenario: Private helper is not a contract
- **WHEN** a change renames a Python function whose name starts with an underscore and that is not in `__all__`
- **THEN** the inventory does not list it

### Requirement: Selection
The contracts agent SHALL run when triage's `public_contracts` signal fires for the change or when the profile's agents step selects it explicitly. It SHALL NOT run when the inventory is empty and the profile did not select it explicitly.

#### Scenario: Triage selection
- **WHEN** a change modifies a route handler's signature and `public_contracts` is enabled in triage
- **THEN** the plan records the contracts agent with the public-contract rule as its reason

#### Scenario: Empty inventory
- **WHEN** a change touches only function bodies with no exported symbol, route, table, event or config change, and the profile does not name the contracts agent
- **THEN** the contracts agent does not run and the plan says why

### Requirement: Hypothesis rules
Contract hypotheses SHALL use rule ids `contracts/<kind>/<break>` where `<kind>` is one of `signature`, `route`, `schema`, `migration`, `format`, `cli`, `env`, `config` and `<break>` is one of `removed`, `changed`, `added_required`, `semantics`. Other rule ids from this agent SHALL be rejected by validation.

#### Scenario: New required field
- **WHEN** head adds a required property to a request schema that an existing client constructs without it
- **THEN** the hypothesis carries rule id `contracts/schema/added_required`

#### Scenario: Unknown rule id rejected
- **WHEN** the agent returns a hypothesis with rule id `contracts/api/broken`
- **THEN** the hypothesis fails validation and is discarded with an audit entry

### Requirement: Producer and consumer locations
A contract hypothesis SHALL cite at least two locations: the producer (the changed contract) and one consumer that depends on the broken assumption. A hypothesis with a producer and no repository consumer SHALL have category `risk`, never `defect`, and SHALL state that no consumer was found in the repository.

#### Scenario: Consumer cited
- **WHEN** a changed function signature has a caller that still passes the old arguments
- **THEN** the hypothesis lists the function definition and the caller as locations

#### Scenario: External consumers only
- **WHEN** a public route is removed and no code in the repository calls it
- **THEN** the hypothesis is a `risk` stating that only consumers outside the repository could be affected

### Requirement: Agent restrictions
The contracts agent SHALL NOT execute commands unless its manifest or profile enables `run`, SHALL NOT emit `style` hypotheses, and SHALL NOT restate deterministic check output. Its budget share SHALL be computed like every other agent's.

#### Scenario: Default tools
- **WHEN** the contracts agent runs on a non-fork review with no `run` override
- **THEN** it has read, search and graph tools and no execution tool

#### Scenario: Restated diagnostic dropped
- **WHEN** the agent reports a type error that the typecheck already reported at the same location
- **THEN** the hypothesis is categorized `diagnostic` and confined to the category-floor footer

### Requirement: Static verification
Contract hypotheses SHALL be settled by the verifier through graph paths in both versions: a `static_proven` level requires a cited head graph path from the consumer to the changed contract; refutation requires a cited consumer update or a protection on that path.

#### Scenario: Consumer updated in head
- **WHEN** the agent claims a caller is broken but head also updated that caller
- **THEN** the verifier cites the updated caller and the hypothesis is refuted

### Requirement: Fork reviews
On fork pull requests the contracts agent SHALL run with static tools only, like every agent.

#### Scenario: Fork contracts review
- **WHEN** a fork pull request changes an exported signature
- **THEN** the contracts agent runs without execution tools and its findings are reported with the static-only note

### Requirement: Unresolved consumers
When an inventory entry has consumer edges with `unresolved` confidence, the agent's hypotheses on that entry SHALL list the unresolved consumers as limitations, and the report footer SHALL count contracts whose consumers could not be resolved.

#### Scenario: Dynamic import
- **WHEN** a changed export is referenced only through a dynamic import the graph could not resolve
- **THEN** the hypothesis names the unresolved reference as a limitation and the footer counts one contract with unresolved consumers

# Spec Delta

## MODIFIED Requirements

### Requirement: Finding model
A finding SHALL have: `id` (stable identity), `rule_id`, `category` (`defect`, `risk`, `security` or `ux`), `evidence_level`, `severity` (`error`, `warning`, `info`), `state` (`new`, `worsened`, `pre-existing`, `fixed`, `unclassified`), `location` (repository-relative path, line range, optional column, enclosing symbol path), `message`, `trigger` (the condition under which the problem manifests), optional `impact`, optional `suggested_fix`, `evidence` (references to artifacts in the review cache or the hosted evidence store), `source` (tool and version, or agent name), `locations` for every occurrence merged by root cause, each with its own line range and `occurrence_state` (`new`, `pre-existing`, `fixed` or `unclassified`), optional `cell` (`viewport`, `color_scheme`) and optional `evidence[]`, and, for `dependency/*` findings, an `advisory` block (`id`, `aliases`, `severity` from `critical`, `high`, `moderate`, `low`, `unknown`, `fixed_version` or `unknown`, `url`). The schema SHALL also define the optional keys `round` (positive integer: the review round within a head lineage that produced the finding), `first_posted_in` (the head SHA or snapshot key of the round in which the finding was first posted) and `author_response` (`{ reason: fixed | wrong | intentional | irrelevant | style, actor, at, note }`); lineage reviews SHALL emit `round` on every finding, `first_posted_in` once the finding has been posted and `author_response` once it has been answered, and their absence SHALL remain valid outside lineages. An optional lifecycle `status` (`open`, `fixed` or `dismissed`) SHALL be emitted for posted lineage findings; it is independent of `state`, which keeps its regression meaning. An optional `verification` block SHALL record `voters`, `agreeing`, per-voter `blind_match` and `split` for verified agent findings; its absence SHALL remain valid for deterministic and historical findings. A `qa` block (`journey`, `step`, `kind` from `functional`, `ux`, `style`, `accessibility`, `route`, `element_paths[]`, `attribution` from `source` or `journey`, `measurements`) SHALL be present if and only if `category` is `ux`. The JSON form SHALL validate against `schemas/finding-v1.json`.

#### Scenario: JSON validates against the schema
- **WHEN** a review is rendered as JSON
- **THEN** every finding in the document validates against `schemas/finding-v1.json`

#### Scenario: Reserved keys validate
- **WHEN** a hand-written finding document carries `round: 2`, `first_posted_in: "3f2a…"` and `author_response: { reason: intentional, actor: "octocat", at: "2026-11-05T10:00:00Z" }`
- **THEN** it validates against `schemas/finding-v1.json`, and a document with `author_response.reason: known` is rejected

#### Scenario: Lineage review emits round
- **WHEN** a finding is produced by the second round of a lineage and was first posted in round 1
- **THEN** its JSON carries `round: 2`, `first_posted_in` set to the round 1 head and `status: open`, and validates against `schemas/finding-v1.json`

#### Scenario: Lifecycle status does not replace regression state
- **WHEN** a `new` finding is dismissed with reason `wrong`
- **THEN** its JSON carries `state: new` and `status: dismissed`, and a document with `state: dismissed` is rejected

#### Scenario: QA block bound to the ux category
- **WHEN** a finding carries `category: ux` and `qa: { journey: checkout, step: 4, kind: functional, route: "/checkout/confirm", element_paths: ["main > form > button"], attribution: source }` with two `locations` each carrying a `cell`
- **THEN** it validates; a `ux` finding without `qa`, or a `defect` finding with `qa`, is rejected

### Requirement: Stable identity
The id SHALL be `blake3(rule_id | normalized_location | trigger_hash)` where `normalized_location` is the repository-relative path plus the enclosing symbol path with line numbers removed, and `trigger_hash` is the hash of the message with only known volatile fragments normalized: line and column references, absolute path prefixes and the repository root, and tool-generated identifiers. Semantic content of the message, including numeric literals, type names and casing, SHALL be preserved. The id SHALL be stable when code moves within a file and when unrelated lines are inserted above it, and SHALL differ for findings whose messages differ in semantic content. A class-level finding, as defined by the review-convergence capability, SHALL instead have id `blake3(rule_id | "class" | trigger_hash)`, and its instances SHALL keep their own ids in `locations`. A QA finding SHALL instead have id `blake3(rule_id | "qa" | journey | step | route_pattern | trigger_hash)`, where `trigger_hash` for a probe is the predicate id plus the element role signature (tag, role, accessible name) and never a measured value, and for an observation is the hash of the host-loaded committed step requirement (`do` and `expect`) plus the browser-derived target signatures. For host-authored exploration, the exact planned step supplies the requirement. Observation target signatures SHALL contain the resolved element tag, role, name, element key, disambiguating ordinal and shadow-host scope when applicable; selector spelling, measurements, cell and model-written `expected`/`observed` descriptions SHALL NOT enter identity. Distinct resolved controls SHALL remain distinct. For action-feedback rules (`ui/no-feedback`, `ux/system-feedback`), the target SHALL be the last successful targeted interaction before that step boundary, captured before the control can detach; explicit affected elements are the fallback when no such action was recorded. The descriptions SHALL remain in the verification evidence pack.

#### Scenario: Line shift keeps the id
- **WHEN** ten lines are inserted above a function that has a type error, and the review is run again
- **THEN** the finding keeps the same id

#### Scenario: Different rule gives a different id
- **WHEN** two different lint rules fire on the same line
- **THEN** they produce two findings with different ids

#### Scenario: Class finding identity ignores locations
- **WHEN** a class-level finding gains a sixth instance in a new file on the next round
- **THEN** its id is unchanged and the new instance appears in `locations`

#### Scenario: QA identity ignores measurements and cells
- **WHEN** a tap-target probe fires on the same button at 28 px in one run and 30 px in the next, in a different set of viewports
- **THEN** the finding keeps the same id and its `locations` reflect the cells of each run

#### Scenario: Observation wording differs across cells
- **WHEN** two cells report the same rule at the same committed step and route for the same browser-derived target using different expected/observed wording or equivalent selectors
- **THEN** they share an identity and retain their separate evidence and descriptions for verification

#### Scenario: Distinct observation targets or requirements
- **WHEN** the affected browser control or the committed step requirement changes
- **THEN** the observation identity differs even if the model reuses its description

### Requirement: Category separates defects from risks
`category` SHALL be `defect` for type errors, lint errors, secrets and vulnerable dependencies, `risk` for untested changes, and `ux` for every finding produced by the QA step, whether functional, visual or accessibility. Agent hypotheses SHALL additionally distinguish `security`, `style` and `diagnostic`. Verified security findings SHALL retain category `security`; `style` and `diagnostic` SHALL be confined to the category-floor audit footer, except that QA style findings carry category `ux` with `qa.kind: style` and are rendered in the QA section. Renderers SHALL present risks in a section separate from defects and SHALL NOT call a risk a bug. Plausible agent hypotheses SHALL never be presented as proven defects, including in the security and QA sections.

#### Scenario: Risk section
- **WHEN** a review has one type error and two untested changes
- **THEN** the report lists one defect under findings and two entries under risks

#### Scenario: Plausible security remains uncertain
- **WHEN** a security hypothesis is verified only at plausible
- **THEN** it retains its security classification and is labeled as a risk for human judgment

#### Scenario: QA style finding is not dropped by the category floor
- **WHEN** a `ui/accent-border-card` probe finding is produced
- **THEN** it has category `ux`, `qa.kind: style`, is rendered in the QA section and is not counted as a category-floor drop

## ADDED Requirements

### Requirement: QA occurrences are matrix cells
A QA finding's `locations[]` SHALL hold one occurrence per cell (viewport and color scheme) in which it was observed, each with its `cell`, its own `evidence[]` and its `occurrence_state`. The finding's `state` SHALL derive from its occurrences by the existing regression rules, including `worsened`. Presentation grouping across journeys SHALL NOT change identity or occurrences.

#### Scenario: Two cells, one finding
- **WHEN** the same probe fires on the same route and step in `mobile` and `desktop`
- **THEN** one finding is produced with two occurrences, each carrying its cell and evidence

### Requirement: Location of findings observed in a browser
A QA finding's `location` SHALL be the attributed source file and line when attribution succeeds, otherwise the journey file and the line of the failing step. The attribution method SHALL be recorded in `qa.attribution` and the element paths in `qa.element_paths`.

#### Scenario: Attributed to a component
- **WHEN** a probe fires on an element whose development annotation names `src/components/Card.tsx:12`
- **THEN** the finding's location is that file and line with `qa.attribution: source`

#### Scenario: No attribution
- **WHEN** the element has no annotation, no console error and its text appears in no changed file
- **THEN** the finding's location is `.rio/qa/journeys/checkout.yaml` at the failing step with `qa.attribution: journey`

### Requirement: Attribution order
Attribution SHALL try, in order: framework development annotations on the element (React, Vue, Svelte and Vite inspector source attributes present in development builds), the stack trace of a console error raised at the step, and a unique match of the element's text or class names in the changed files. The first method that yields exactly one file SHALL win; an ambiguous match SHALL count as no attribution.

#### Scenario: Ambiguous text match
- **WHEN** the element's text `Save` appears in three changed files and no annotation or stack trace exists
- **THEN** attribution fails and the finding is located at the journey file

#### Scenario: Stack trace wins over text
- **WHEN** the element has no annotation and a console error at the step points to `src/pages/Billing.tsx:40`
- **THEN** the finding is located at that file and line with `qa.attribution: source`

### Requirement: Recommendations are distinct from defect findings
UX recommendations SHALL use the separate QA recommendation record rather than `finding-v1` defect semantics. A requirement violation SHALL remain eligible for a verified QA finding. A related recommendation SHALL link to its finding and SHALL NOT duplicate the same issue in counts. Recommendation priority SHALL express user impact and SHALL NOT be treated as defect severity or regression state.

#### Scenario: Recommendation does not change a pass
- **WHEN** a successful flow has a supported task-efficiency recommendation
- **THEN** the journey remains passed, the defect count is unchanged and the recommendation appears with its own priority and confidence
